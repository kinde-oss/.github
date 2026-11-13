#!/usr/bin/env node
// Collects the facts an AI reviewer needs to judge the risk of a Renovate PR.
// Reads only git history and public registry/GitHub metadata. It never installs
// or executes the incoming packages (new packages' tarballs are read, not unpacked).
//
// Usage: node collect-context.mjs <baseSha> <headSha> <outDir>
// Env:   GITHUB_TOKEN (optional, for GitHub Action compare diffs), PR_BODY_FILE (optional)
// Writes <outDir>/context.md (for the model) and <outDir>/facts.json (deterministic flags).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [baseSha, headSha, outDir = '.'] = process.argv.slice(2);

const LIMITS = {
  totalChars: 180_000,       // overall context budget
  perPackageDiff: 12_000,    // npm diff per package
  perActionDiff: 8_000,      // GitHub compare diff per action
  perNewPackage: 8_000,      // file list + package.json + entry file per new package
  prBody: 20_000,
  maxPackagesDiffed: 40,
  maxNewPackagesInspected: 20,
};
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const gitShow = (sha, path) => { try { return git('show', `${sha}:${path}`); } catch { return ''; } };
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [truncated ${s.length - n} chars]` : s);

// ---------- pnpm lockfile parsing (v6–v9) ----------
// Collect name -> Set(version) from the top-level `packages:` section.
export function parsePnpmLock(text) {
  const out = new Map();
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inPackages = line.startsWith('packages:'); continue; }
    if (!inPackages) continue;
    const m = line.match(/^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^@\s'"(]+)@([^\s'"():]+)(?:\(.*\))?['"]?:\s*$/);
    if (!m) continue;
    const [, name, version] = m;
    if (version.startsWith('link:') || version.startsWith('file:')) continue;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(version);
  }
  return out;
}

// Collect "name@version(peers)" -> resolution (tarball/integrity) from the `packages:` section,
// so a changed resolution for an unchanged version is caught.
export function pnpmResolutions(text) {
  const out = new Map();
  let inPackages = false, key = null, cont = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inPackages = line.startsWith('packages:'); key = null; cont = false; continue; }
    if (!inPackages) continue;
    const k = line.match(/^ {2}(\S.*?):\s*$/);
    if (k) { key = k[1].replace(/^['"]|['"]$/g, ''); cont = false; continue; }
    const r = line.match(/^ {4}resolution:\s*(.*)$/);
    if (key && r) { out.set(key, r[1].trim()); cont = !r[1].trim(); continue; }
    if (cont && key && /^ {6}\S/.test(line)) { out.set(key, out.get(key) + line.trim() + ';'); continue; }
    cont = false;
  }
  return out;
}

// Semver precedence: numeric core first, a release sorts above its prereleases, numeric
// prerelease identifiers sort below alphanumeric ones, build metadata is ignored.
const cmpIds = (x, y) => {
  const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
  if (nx && ny) return Math.sign(Number(x) - Number(y));
  if (nx !== ny) return nx ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
};
export function cmpSemver(a, b) {
  const split = v => { const [core, ...pre] = v.split('+')[0].split('-'); return [core.split('.'), pre.join('-')]; };
  const [ca, pa] = split(a), [cb, pb] = split(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const c = cmpIds(ca[i] ?? '0', cb[i] ?? '0');
    if (c) return c;
  }
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  const xa = pa.split('.'), xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const c = cmpIds(xa[i], xb[i]);
    if (c) return c;
  }
  return 0;
}

export function diffLocks(oldMap, newMap) {
  const updated = [], added = [], removed = [];
  const names = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const name of names) {
    const o = oldMap.get(name) ?? new Set();
    const n = newMap.get(name) ?? new Set();
    const gone = [...o].filter(v => !n.has(v)).sort(cmpSemver);
    const fresh = [...n].filter(v => !o.has(v)).sort(cmpSemver);
    if (!fresh.length && !gone.length) continue;
    if (!o.size) { fresh.forEach(v => added.push({ name, version: v })); continue; }
    if (!n.size) { gone.forEach(v => removed.push({ name, version: v })); continue; }
    // Pair each new version with the highest previous version below it (or the highest old one).
    for (const v of fresh) {
      const prev = [...o].filter(x => cmpSemver(x, v) < 0).sort(cmpSemver).pop() ?? [...o].sort(cmpSemver).pop();
      updated.push({ name, from: prev, to: v });
    }
  }
  return { updated, added, removed };
}

// ---------- npm registry ----------
async function manifest(name, version) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const installScripts = m => Object.fromEntries(INSTALL_SCRIPTS.filter(k => m?.scripts?.[k]).map(k => [k, m.scripts[k]]));
const hasProvenance = m => Boolean(m?.dist?.attestations?.provenance || m?.dist?.attestations?.url);
const publisher = m => m?._npmUser?.name ?? null;
const depNames = m => Object.keys({ ...(m?.dependencies ?? {}), ...(m?.optionalDependencies ?? {}) });

function npmDiff(name, from, to) {
  try {
    return execFileSync('npm', ['diff', `--diff=${name}@${from}`, `--diff=${name}@${to}`, '--diff-unified=2', '--diff-name-only=false'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return e.stdout ? String(e.stdout) : `(npm diff failed: ${e.message.split('\n')[0]})`;
  }
}
const diffFailed = d => d.startsWith('(npm diff failed');

// Published code of a newly added package: file list, package.json and its entry file.
// Downloads the tarball with scripts disabled and reads members with `tar -O`, so nothing
// is unpacked to disk and symlinks inside the package are never followed.
// Returns null when the code could not be read.
export function newPackageSource(name, version) {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-risk-'));
  try {
    execFileSync('npm', ['pack', `${name}@${version}`, '--ignore-scripts', '--pack-destination', dir],
      { timeout: 60_000, stdio: ['ignore', 'ignore', 'ignore'] });
    const tgz = readdirSync(dir).find(f => f.endsWith('.tgz'));
    if (!tgz) return null;
    const tarball = join(dir, tgz);
    const tar = (...args) => execFileSync('tar', ['-xzOf', tarball, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const listing = execFileSync('tar', ['-tzvf', tarball], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
    const root = files[0]?.split('/')[0];
    if (!root) return null;
    const pkgText = files.includes(`${root}/package.json`) ? tar(`${root}/package.json`) : '';
    let pkg = {};
    try { pkg = JSON.parse(pkgText); } catch { /* shown raw below */ }
    const pick = e => typeof e === 'string' ? e
      : Array.isArray(e) ? pick(e[0])
      : e && typeof e === 'object' ? pick(e['.'] ?? e.node ?? e.require ?? e.import ?? e.default) : null;
    const entry = [pick(pkg.exports), pkg.main, pkg.module, 'index.js']
      .filter(p => typeof p === 'string')
      .map(p => p.replace(/^\.?\//, ''))
      .flatMap(p => [p, `${p}.js`, `${p}/index.js`])
      .map(p => `${root}/${p}`)
      .find(p => files.includes(p));
    return `files:\n${truncate(listing, 2_000)}\npackage.json:\n${truncate(pkgText, 2_000)}\n` +
      (entry ? `${entry.slice(root.length + 1)}:\n${tar(entry)}` : '(no entry file found)');
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- GitHub Actions ----------
const USES_RE = /^([+-])\s*-?\s*uses:\s*['"]?([^@\s'"]+)@([^\s'"#]+)['"]?\s*(?:#\s*(\S+))?/;
const reviewableUse = m => m && !m[2].startsWith('./') && !m[2].startsWith('docker://');

// Pairs each added `uses:` with the next removed one for the same action in the same file,
// so different sites updating the same action each get their own comparison.
export function parseActionChanges(patch) {
  const changes = [], seen = new Set();
  let pending = new Map(); // action -> removed refs not yet paired, within the current file
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) { pending = new Map(); continue; }
    const m = line.match(USES_RE);
    if (!reviewableUse(m)) continue;
    const [, sign, action, ref, comment] = m;
    const use = { ref, tag: comment ?? null };
    if (sign === '-') {
      if (!pending.has(action)) pending.set(action, []);
      pending.get(action).push(use);
      continue;
    }
    const from = pending.get(action)?.shift() ?? null;
    const key = `${action}|${from?.ref ?? ''}|${ref}`;
    if ((from && from.ref === ref) || seen.has(key)) continue;
    seen.add(key);
    changes.push({ action, from, to: use });
  }
  return changes;
}

// Changed workflow lines that aren't a reviewable `uses: owner/repo@ref` (docker:// images,
// local actions, run steps, permissions, ...). Blank and comment-only lines are ignored.
export function unreviewedWorkflowLines(patch) {
  return patch.split('\n')
    .filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    .filter(l => {
      const body = l.slice(1).trim();
      if (!body || body.startsWith('#')) return false;
      return !reviewableUse(l.match(USES_RE));
    });
}

async function actionCompare(action, from, to) {
  const [owner, repo] = action.split('/');
  if (!owner || !repo || !from) return null;
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/compare/${from.ref}...${to.ref}`, { headers });
    if (!r.ok) return `(compare unavailable: HTTP ${r.status})`;
    const j = await r.json();
    const files = (j.files ?? []).map(f => `### ${f.filename} (+${f.additions}/-${f.deletions})\n${f.patch ?? '(binary or too large)'}`).join('\n');
    return `commits: ${j.total_commits}, files changed: ${(j.files ?? []).length}\n${files}`;
  } catch (e) { return `(compare failed: ${e.message})`; }
}

// ---------- main ----------
async function main() {
  if (!baseSha || !headSha) {
    console.error('usage: collect-context.mjs <baseSha> <headSha> <outDir>');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const changed = git('diff', '--name-only', `${baseSha}...${headSha}`).split('\n').filter(Boolean);
  const facts = { packages: [], newPackages: [], actions: [], flags: [], changedFiles: changed, diffsTruncated: 0 };
  const sections = [];
  const notReviewed = []; // updates whose published code never reached the model

  // Anything this collector can't analyse must not pass as "low" just because nothing was found.
  // Understood: pnpm lockfiles, package.json next to a lockfile change, and workflow/action files
  // (whose non-`uses:` lines are flagged separately below).
  const wf = changed.filter(f => /^\.github\/(workflows\/.*\.ya?ml|actions\/.*action\.ya?ml)$/.test(f) || /(^|\/)action\.ya?ml$/.test(f));
  const lockChanged = changed.some(f => f.endsWith('pnpm-lock.yaml'));
  const unknown = changed.filter(f => !(f.endsWith('pnpm-lock.yaml') || (lockChanged && f.endsWith('package.json')) || wf.includes(f)));
  if (unknown.length) {
    const list = unknown.slice(0, 10).join(', ') + (unknown.length > 10 ? ` (+${unknown.length - 10} more)` : '');
    facts.flags.push({ severity: 'medium', package: list, reason: 'changed files this check cannot analyse (only pnpm lockfiles, package.json and workflow uses: refs are reviewed)' });
  }

  // Direct dependency changes from package.json files
  const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const withoutDeps = p => JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => !DEP_KEYS.includes(k))));
  const direct = new Set();
  for (const f of changed.filter(f => f.endsWith('package.json'))) {
    const o = JSON.parse(gitShow(baseSha, f) || '{}');
    const n = JSON.parse(gitShow(headSha, f) || '{}');
    for (const key of DEP_KEYS) {
      for (const [name, spec] of Object.entries(n[key] ?? {})) if (o[key]?.[name] !== spec) direct.add(name);
    }
    if (withoutDeps(o) !== withoutDeps(n)) facts.flags.push({ severity: 'medium', package: f, reason: 'package.json changed outside dependency fields (e.g. packageManager, engines, overrides, scripts)' });
  }

  // Lockfile changes
  for (const f of changed.filter(f => f.endsWith('pnpm-lock.yaml'))) {
    const oldText = gitShow(baseSha, f), newText = gitShow(headSha, f);
    const oldRes = pnpmResolutions(oldText), newRes = pnpmResolutions(newText);
    const reResolved = [...newRes].filter(([k, v]) => oldRes.has(k) && oldRes.get(k) !== v).map(([k]) => k);
    if (reResolved.length) facts.flags.push({ severity: 'medium', package: reResolved.slice(0, 10).join(', '), reason: 'lockfile resolution or integrity changed without a version change' });
    const { updated, added, removed } = diffLocks(parsePnpmLock(oldText), parsePnpmLock(newText));
    updated.sort((a, b) => Number(direct.has(b.name)) - Number(direct.has(a.name)));
    sections.push(`## Lockfile ${f}\n- updated: ${updated.length}\n- newly added packages: ${added.length}\n- removed: ${removed.length}`);

    for (const [i, u] of updated.entries()) {
      const [mo, mn] = await Promise.all([manifest(u.name, u.from), manifest(u.name, u.to)]);
      const entry = {
        ...u, direct: direct.has(u.name),
        publisherFrom: publisher(mo), publisherTo: publisher(mn),
        provenanceFrom: hasProvenance(mo), provenanceTo: hasProvenance(mn),
        installScriptsFrom: installScripts(mo), installScriptsTo: installScripts(mn),
        newDeps: depNames(mn).filter(d => !depNames(mo).includes(d)),
        deprecated: mn?.deprecated ?? null,
        registryMissing: !mn,
      };
      const newScripts = Object.keys(entry.installScriptsTo).filter(k => entry.installScriptsFrom[k] !== entry.installScriptsTo[k]);
      if (newScripts.length) facts.flags.push({ severity: 'high', package: u.name, reason: `install script added or changed: ${newScripts.join(', ')}` });
      if (entry.provenanceFrom && !entry.provenanceTo) facts.flags.push({ severity: 'high', package: u.name, reason: 'previous version had npm provenance, new version does not' });
      if (entry.publisherFrom && entry.publisherTo && entry.publisherFrom !== entry.publisherTo) facts.flags.push({ severity: 'medium', package: u.name, reason: `publisher changed ${entry.publisherFrom} -> ${entry.publisherTo}` });
      if (entry.registryMissing) facts.flags.push({ severity: 'medium', package: u.name, reason: 'new version not found on the npm registry' });
      facts.packages.push(entry);

      let body = `### ${u.name} ${u.from} → ${u.to}${entry.direct ? ' (direct)' : ' (transitive)'}\n` +
        `- publisher: ${entry.publisherFrom} → ${entry.publisherTo}\n- provenance: ${entry.provenanceFrom} → ${entry.provenanceTo}\n` +
        `- install scripts: ${JSON.stringify(entry.installScriptsFrom)} → ${JSON.stringify(entry.installScriptsTo)}\n` +
        `- new dependencies: ${entry.newDeps.join(', ') || 'none'}\n`;
      if (i < LIMITS.maxPackagesDiffed) {
        const d = npmDiff(u.name, u.from, u.to);
        if (diffFailed(d)) notReviewed.push(`${u.name}@${u.to}`);
        else if (d.length > LIMITS.perPackageDiff) facts.diffsTruncated++;
        body += '```diff\n' + truncate(d, LIMITS.perPackageDiff) + '\n```\n';
      } else {
        notReviewed.push(`${u.name}@${u.to}`);
        body += '(diff skipped: package limit reached)\n';
      }
      sections.push(body);
    }

    for (const [i, a] of added.entries()) {
      const m = await manifest(a.name, a.version);
      const entry = { ...a, publisher: publisher(m), provenance: hasProvenance(m), installScripts: installScripts(m), description: m?.description ?? null };
      if (Object.keys(entry.installScripts).length) facts.flags.push({ severity: 'high', package: a.name, reason: `newly added package has install scripts: ${Object.keys(entry.installScripts).join(', ')}` });
      facts.newPackages.push(entry);
      const src = i < LIMITS.maxNewPackagesInspected ? newPackageSource(a.name, a.version) : null;
      if (src === null) notReviewed.push(`${a.name}@${a.version}`);
      else if (src.length > LIMITS.perNewPackage) facts.diffsTruncated++;
      sections.push(`### NEW package ${a.name}@${a.version}\n- publisher: ${entry.publisher}\n- provenance: ${entry.provenance}\n- install scripts: ${JSON.stringify(entry.installScripts)}\n- description: ${entry.description}\n` +
        (src === null ? '(published code not inspected)\n' : '```\n' + truncate(src, LIMITS.perNewPackage) + '\n```\n'));
    }
  }

  // GitHub Actions changes
  if (wf.length) {
    const patch = git('diff', `${baseSha}...${headSha}`, '--', ...wf);
    const other = unreviewedWorkflowLines(patch);
    if (other.length) {
      facts.flags.push({ severity: 'medium', package: 'workflow files', reason: `${other.length} changed workflow line(s) other than action uses: refs (e.g. docker:// images, run steps)` });
      sections.push('### Workflow lines outside action refs (not reviewed)\n```diff\n' + truncate(other.join('\n'), LIMITS.perActionDiff) + '\n```');
    }
    const changes = parseActionChanges(patch);
    for (const c of changes) {
      facts.actions.push(c);
      if (!c.from) facts.flags.push({ severity: 'medium', package: c.action, reason: 'new GitHub Action introduced' });
      const cmp = await actionCompare(c.action, c.from, c.to);
      if (cmp?.startsWith('(compare')) notReviewed.push(`${c.action}@${c.to.tag ?? c.to.ref}`);
      else if (cmp && cmp.length > LIMITS.perActionDiff) facts.diffsTruncated++;
      sections.push(`### Action ${c.action} ${c.from?.tag ?? c.from?.ref ?? '(new)'} → ${c.to.tag ?? c.to.ref}\n` + '```diff\n' + truncate(cmp ?? '(no compare)', LIMITS.perActionDiff) + '\n```');
    }
  }

  // A skipped or failed diff means the model never saw that code, so it can't be judged low.
  // (A diff cut at its per-item limit still reaches the model, which is told to weigh that.)
  if (notReviewed.length) {
    const list = notReviewed.slice(0, 10).join(', ') + (notReviewed.length > 10 ? ` (+${notReviewed.length - 10} more)` : '');
    facts.flags.push({ severity: 'medium', package: list, reason: `published code not reviewed for ${notReviewed.length} update(s): diff skipped at the size limit or could not be fetched` });
  }

  // Release notes from the Renovate PR body
  if (process.env.PR_BODY_FILE && existsSync(process.env.PR_BODY_FILE)) {
    sections.unshift('## Renovate PR description (release notes)\n' + truncate(readFileSync(process.env.PR_BODY_FILE, 'utf8'), LIMITS.prBody));
  }

  let context = sections.join('\n\n');
  facts.truncated = context.length > LIMITS.totalChars;
  context = truncate(context, LIMITS.totalChars);
  writeFileSync(`${outDir}/context.md`, context);
  writeFileSync(`${outDir}/facts.json`, JSON.stringify(facts, null, 2));
  console.log(`packages updated: ${facts.packages.length}, new: ${facts.newPackages.length}, actions: ${facts.actions.length}, flags: ${facts.flags.length}, context chars: ${context.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
