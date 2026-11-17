#!/usr/bin/env node
// Collects the facts an AI reviewer needs to judge the risk of a Renovate PR.
// Reads only git history and public registry/GitHub metadata. It never installs
// or executes the incoming packages (new packages' tarballs are read, not unpacked).
//
// Usage: node collect-context.mjs <baseSha> <headSha> <outDir>
// Env:   GITHUB_TOKEN (optional, for GitHub Action compare diffs), PR_BODY_FILE (optional)
// Writes <outDir>/units.json (what the model reviews: a shared preamble plus one unit per
// updated package, new package or action) and <outDir>/facts.json (deterministic flags).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const [baseSha, headSha, outDir = '.'] = process.argv.slice(2);

// Budgets apply to code that runs; docs, tests, data and assets are listed instead of shown.
// Code that runs but doesn't fit means "not reviewed", so the PR comes back medium.
const LIMITS = {
  // Each package or action is one review unit, sent whole to one model call (small units share a call).
  maxUnitChars: 120_000,     // a unit longer than this is cut and the run can't be low (shouldn't happen)
  totalChars: 2_000_000,     // across all calls (about 500k tokens); later units are flagged, not sent
  perPackageCode: 100_000,   // changed code that runs, per updated npm package
  perActionCode: 100_000,    // changed code that runs, per GitHub Action (action.yml + runtime bundle)
  workflowLines: 8_000,      // workflow lines outside uses: refs, shown for context
  perNewPackage: 20_000,     // code shown per new package (plus its file list and package.json)
  prBody: 20_000,
  maxPackagesDiffed: 40,
  maxNewPackagesInspected: 20,
};
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
// Missing paths are expected (e.g. probing for a package's lockfile), so stderr is dropped.
const gitShow = (sha, path) => {
  try { return execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
};
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

// Collect importer path -> Map(dependency name -> resolved version) from `importers:` (workspaces,
// v6–v9) or, for a single-project v6 lockfile, the top-level dependency sections (importer ".").
export function pnpmImporters(text) {
  const out = new Map();
  const unquote = s => s.replace(/^['"]|['"]$/g, '');
  const deps = imp => { if (!out.has(imp)) out.set(imp, new Map()); return out.get(imp); };
  let mode = null, importer = null, dep = null;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      mode = line.startsWith('importers:') ? 'importers'
        : /^(dependencies|devDependencies|optionalDependencies):/.test(line) ? 'top' : null;
      importer = mode === 'top' ? '.' : null;
      dep = null;
      continue;
    }
    if (mode === 'importers') {
      let m = line.match(/^ {2}(\S.*?):\s*$/);
      if (m) { importer = unquote(m[1]); deps(importer); dep = null; continue; }
      m = line.match(/^ {6}(\S.*?):\s*$/);
      if (m) { dep = unquote(m[1]); continue; }
      m = line.match(/^ {8}version:\s*(.+)$/);
      if (m && importer && dep) deps(importer).set(dep, m[1].trim());
    } else if (mode === 'top') {
      let m = line.match(/^ {2}(\S.*?):\s*$/);
      if (m) { dep = unquote(m[1]); continue; }
      m = line.match(/^ {4}version:\s*(.+)$/);
      if (m && dep) deps('.').set(dep, m[1].trim());
    }
  }
  return out;
}

// The parsers above understand pnpm lockfile formats 6.x (pnpm 8) and 9.x (pnpm 9 and later).
export const SUPPORTED_LOCKFILE_VERSIONS = ['6', '9'];
export const lockfileVersion = text => text.match(/^lockfileVersion:\s*['"]?(\d+)/m)?.[1] ?? null;

// New lockfile entries the registry-based review can't cover: a key that isn't name@semver
// (a URL, git or file key, which parsePnpmLock skips) or a resolution that points somewhere
// other than the npm registry (tarball URL, git repo, local directory).
const REGISTRY_KEY = /^\/?(?:@[^/@\s]+\/)?[^@/\s]+@\d+\.\d+\.\d+(?:[-+][^\s()]*)?(?:\(.*\))?$/;
const NON_REGISTRY_RESOLUTION = /\b(tarball|repo|commit|directory|path|type):/;
export function nonRegistryEntries(oldRes, newRes) {
  return [...newRes]
    .filter(([key, res]) => !oldRes.has(key) && (!REGISTRY_KEY.test(key) || NON_REGISTRY_RESOLUTION.test(res)))
    .map(([key]) => key);
}

// name@version -> resolution, ignoring v6's leading "/" and peer suffixes.
export function resolutionIndex(res) {
  const out = new Map();
  for (const [key, r] of res) out.set(key.replace(/^\//, '').replace(/\(.*$/, ''), r);
  return out;
}

// Is what the lockfile installs for name@version the artifact the npm registry serves, which is
// the one this check reviews? Returns a reason when it isn't, null when it matches or when the
// registry has no record (that is flagged separately).
export function registryMismatch(resolution, m) {
  if (resolution === undefined) return 'no lockfile entry for this version';
  const tarball = resolution.match(/tarball:\s*([^,}\s;]+)/)?.[1];
  if (tarball && !tarball.startsWith('https://registry.npmjs.org/')) return `installs from ${tarball}, not the npm registry`;
  if (!m) return null;
  const lock = resolution.match(/integrity:\s*([^,}\s;]+)/)?.[1];
  if (!lock) return 'lockfile has no integrity hash';
  const sha1 = m.dist?.shasum ? `sha1-${Buffer.from(m.dist.shasum, 'hex').toString('base64')}` : null;
  if (lock === m.dist?.integrity || (lock.startsWith('sha1-') && lock === sha1)) return null;
  return 'lockfile integrity does not match the npm registry artifact';
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

export function npmDiff(name, from, to) {
  try {
    return execFileSync('npm', ['diff', `--diff=${name}@${from}`, `--diff=${name}@${to}`, '--diff-unified=2', '--diff-name-only=false'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // A failed run can still leave partial output; keep it for the model but mark the failure.
    return `(npm diff failed: ${e.message.split('\n')[0]})` + (e.stdout ? `\n${e.stdout}` : '');
  }
}
const diffFailed = d => d.startsWith('(npm diff failed');

// Minimal in-memory reader for a gzipped tar. Nothing is written to disk. Returns regular files
// as { name, body } plus `unsupported`: every entry it can't interpret the way npm's extractor
// would (GNU long names, links, devices, global headers, base-256 sizes, a truncated archive).
// Real npm tarballs only contain regular files and directories, so any unsupported entry means
// the caller must treat the package as not inspected.
export function readTarball(gz) {
  const data = gunzipSync(gz);
  const files = [], unsupported = [];
  let off = 0, pax = {}, zeroBlock = false;
  while (off + 512 <= data.length) {
    const h = data.subarray(off, off + 512);
    // The archive ends at two zero blocks in a row. npm's extractor keeps reading after a
    // single one, so an entry hidden behind it would be installed; treat that as unreadable.
    if (h.every(b => b === 0)) {
      if (zeroBlock) break;
      zeroBlock = true;
      off += 512;
      continue;
    }
    if (zeroBlock) { unsupported.push(`entry after a single end-of-archive block at byte ${off}`); break; }
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = field(345, 500);
    const name = pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    // npm skips a header whose checksum doesn't match and reads the next block as a header,
    // which this reader can't follow; stop and report it rather than read it differently.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== parseInt(field(148, 156).trim() || 'NaN', 8)) { unsupported.push(`${name || `header at byte ${off}`} (bad checksum)`); break; }
    if (h[124] & 0x80) { unsupported.push(`${name} (base-256 size)`); break; }
    const size = pax.size !== undefined ? Number(pax.size) : parseInt(field(124, 136).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || off + 512 + size > data.length) { unsupported.push(`${name} (bad or truncated size)`); break; }
    const body = data.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = {};
      for (const m of body.toString('utf8').matchAll(/\d+ ([^=\n]+)=([^\n]*)\n/g)) pax[m[1]] = m[2];
      continue;
    }
    pax = {};
    if (type === '0' || type === '7') files.push({ name, body });
    else if (type !== '5') unsupported.push(`${name} (type ${type})`);
  }
  return { files, unsupported };
}

// Files that can't run on their own: docs, licences, type declarations, source maps, data,
// styles, images. A doc-style name with a code extension (README.js) is still code.
const NON_CODE = /(^|\/)(readme|licen[cs]e|copying|changelog|history|authors|contributors|notice)([.-][^/]*)?$|\.(md|markdown|txt|d\.[cm]?ts|map|json|css|scss|less|html?|png|jpe?g|gif|svg|ico|webp|avif|bmp|ttf|otf|woff2?|eot|mp3|mp4|wav|webm|ya?ml)$/i;
const CODE_EXT = /\.([cm]?[jt]sx?|node|wasm|sh)$/i;
const isNonCode = f => NON_CODE.test(f) && !(CODE_EXT.test(f) && !/\.d\.[cm]?ts$/i.test(f));
// Tests don't run when a package is used. Like docs, they only count as code when code refers to them.
const TEST_PATH = /(^|\/)(__tests?__|__mocks__|tests?|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const isOptional = f => isNonCode(f) || TEST_PATH.test(f);
// Never runnable: images, fonts, media.
const INERT_ASSET = /\.(png|jpe?g|gif|ico|webp|avif|bmp|ttf|otf|woff2?|eot|mp3|mp4|wav|webm)$/i;
// Compiled or archived files a text diff can't show.
const BINARY_EXT = /\.(node|wasm|exe|dll|so|dylib|bin|o|a|lib|jar|class|pyc|zip|gz|tgz|tar|7z)$/i;
// The only changed files an npm diff review may skip unless code refers to them: docs (by
// extension, or a doc name with no extension or a doc one), type declarations, source maps,
// styles, markup and binary assets. Everything else counts, whatever folder it's in, because
// unchanged code can load any file by a name built at runtime (test/build.dat, data/x.json, ...).
const DIFF_SKIPPABLE = /(^|\/)(readme|licen[cs]e|copying|changelog|history|authors|contributors|notice)(\.(md|markdown|rst|adoc|txt))?$|\.(md|markdown|rst|adoc|d\.[cm]?ts|map|css|scss|less|html?|svg)$/i;
const skippableInDiff = p => DIFF_SKIPPABLE.test(p) || INERT_ASSET.test(p);

// Every name-like token in some code, so "does the code mention notes.md" is a set lookup.
// Also the last segment of every path-like string, because Node resolves require('../lib/payload')
// to payload.js, payload.json or payload.node, and require('./lib') to lib/index.js.
export function codeRefs(text = '') {
  const refs = { tokens: new Set(), tails: new Set() };
  addRefs(refs, text);
  return refs;
}
function addRefs(refs, text) {
  // A "//# sourceMappingURL=index.js.map" comment points tools at a source map; it doesn't load
  // it, and counting it would pull every bundle's (huge) map diff into the required code.
  text = text.replace(/^[ \t]*\/\/[#@][ \t]*sourceMappingURL=.*$/gm, '');
  for (const t of text.match(/[\w.@$-]+/g) ?? []) refs.tokens.add(t);
  for (const m of text.matchAll(/[\w.@$-]*\/([\w.@$-]+)/g)) refs.tails.add(m[1]);
}
const NODE_RESOLVED = /\.(js|json|node)$/i;
// Does code with these refs name file p, with or without the extension Node would add?
export function refersTo(refs, p) {
  const parts = p.split('/');
  const base = parts.at(-1);
  if (refs.tokens.has(base)) return true;
  if (!NODE_RESOLVED.test(base)) return false;
  const stem = base.replace(NODE_RESOLVED, '');
  return refs.tails.has(stem) || (stem === 'index' && parts.length > 1 && refs.tails.has(parts.at(-2)));
}

// Which files of a package can run. Paths follow npm's extraction: the first path component of
// each entry is stripped (so mixed root folders land in one tree), leading slashes are dropped,
// entries at the top level or that climb out with ".." are skipped, and a later entry for the
// same path wins. Code is: entry points declared by package.json or any nested package.json
// (main, module, browser, every exports target, bin), nested manifests themselves, every file
// that isn't docs, data, assets or tests, and any of those the code mentions by name
// (e.g. require('./README.md'), which Node would run as JavaScript).
export function classifyPackageFiles(files) {
  const byName = new Map();
  for (const f of files) {
    const name = f.name.replace(/^\/+/, '');
    const slash = name.indexOf('/');
    if (slash < 0) continue;
    const rel = posix.normalize(name.slice(slash + 1));
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) continue;
    byName.delete(rel); // keep insertion order matching the last write
    byName.set(rel, f.body);
  }
  const pkgText = byName.get('package.json')?.toString('utf8') ?? '';
  let pkg = {};
  try { pkg = JSON.parse(pkgText); } catch { /* shown raw below */ }
  // Every runtime target in exports/bin; "types"/"typings" conditions never run, so skip them.
  const leaves = e => typeof e === 'string' ? [e]
    : Array.isArray(e) ? e.flatMap(leaves)
    : e && typeof e === 'object' ? Object.entries(e).filter(([k]) => k !== 'types' && k !== 'typings').flatMap(([, v]) => leaves(v)) : [];
  const resolve = p => [p, `${p}.js`, `${p}.json`, `${p}.node`, `${p}/index.js`, `${p}/index.json`].find(c => byName.has(c));
  // A nested package.json makes its folder requirable: require('./lib') loads lib/package.json's
  // main, whatever its extension (Node runs unknown extensions as JavaScript). So every manifest's
  // targets are entry points, resolved from that manifest's folder.
  const nested = [...byName.keys()].filter(f => f.endsWith('/package.json'));
  const manifests = [['.', pkg], ...nested.map(f => {
    let json = {};
    try { json = JSON.parse(byName.get(f).toString('utf8')); } catch { /* shown raw as code */ }
    return [posix.dirname(f), json];
  })];
  const targets = ([dir, p]) => [...leaves(p?.exports), p?.main, p?.module, typeof p?.browser === 'string' ? p.browser : null, ...leaves(p?.bin)]
    .filter(t => typeof t === 'string' && t.trim() !== '') // an empty main means a types-only package
    .map(t => ({ dir, t }));
  const allTargets = manifests.flatMap(targets);
  const pattern = ({ t }) => t.includes('*') || t.endsWith('/');
  const declared = allTargets.filter(x => !pattern(x))
    .map(({ dir, t }) => posix.normalize(posix.join(dir, t.replace(/^\.?\//, '') || '.')))
    .map(t => (t === '.' ? 'index' : t))
    .filter(t => t !== '..' && !t.startsWith('../'));
  const missing = [...new Set(declared.filter(p => !resolve(p)))];
  const names = [...byName.keys()].filter(f => f !== 'package.json');
  // Subpath patterns ("./*": "./tests/*.js") and folder mappings ("./lib/": "./lib/") make every
  // file they match importable, so each match is an entry point. A pattern that matches nothing
  // isn't an error: it just exposes no files.
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = allTargets.filter(pattern).map(({ dir, t }) => {
    const p = posix.join(dir, t.replace(/^\.?\//, ''));
    return new RegExp(`^${p.split('*').map(escapeRe).join('.+')}${p.endsWith('/') ? '.+' : ''}$`);
  });
  const patterned = names.filter(f => !INERT_ASSET.test(f) && patterns.some(re => re.test(f)));
  const entries = new Set([...[...declared, 'index.js'].map(resolve).filter(Boolean), ...patterned]);
  const nestedSet = new Set(nested);
  const direct = new Set(names.filter(f => entries.has(f) || nestedSet.has(f) || !isOptional(f)));
  // Follow references until nothing new is added: a test helper that index.js loads can load
  // another file in turn, and each one it reaches runs too.
  const refs = codeRefs([...direct].map(f => byName.get(f).toString('utf8')).join('\n'));
  const reached = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const f of names) {
      if (direct.has(f) || reached.has(f) || INERT_ASSET.test(f) || !refersTo(refs, f)) continue;
      reached.add(f);
      addRefs(refs, byName.get(f).toString('utf8'));
      grew = true;
    }
  }
  // Entry points first, then the rest of the code, then optional files the code refers to.
  const code = [...new Set([...entries, ...direct, ...reached])];
  return { byName, pkgText, entries, missing, code, codeSet: new Set(code) };
}

// Decides what the model sees from a new package: the file list, package.json, then every file
// that could contain code (see classifyPackageFiles). `inspected` is false when any code file
// is binary, the code doesn't fit the budget, a declared entry point doesn't exist as read, or
// the tarball had entries the reader doesn't support.
export function inspectPackageFiles(files, { budget = LIMITS.perNewPackage, unsupported = [] } = {}) {
  const { byName, pkgText, missing, code } = classifyPackageFiles(files);
  let text = `files:\n${truncate([...byName].map(([f, b]) => `${f} (${b.length} bytes)`).join('\n'), 2_000)}\n` +
    `package.json:\n${truncate(pkgText, 2_000)}\n`;
  let inspected = true;
  if (unsupported.length) { inspected = false; text += `\n(tarball entries this check can't read: ${unsupported.slice(0, 10).join(', ')})\n`; }
  if (missing.length) { inspected = false; text += `\n(declared entry points not found in the tarball: ${missing.slice(0, 10).join(', ')})\n`; }
  for (const f of code) {
    const body = byName.get(f);
    if (/\.(node|wasm)$/i.test(f) || body.includes(0)) { inspected = false; text += `\n--- ${f} (binary, not shown) ---\n`; continue; }
    const chunk = `\n--- ${f} ---\n${body.toString('utf8')}`;
    if (chunk.length > budget) { inspected = false; text += `\n--- ${f} and later files: not shown, code budget reached ---\n`; break; }
    text += chunk;
    budget -= chunk.length;
  }
  return { text, inspected };
}

// ---------- diff budgeting ----------
// Split a git-style diff (npm diff and git diff both produce one) into one chunk per file.
export function splitGitDiff(text) {
  const chunks = [];
  for (const part of text.split(/^(?=diff --git )/m)) {
    const m = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!m) continue;
    chunks.push({
      path: m[2],
      text: part.replace(/\n$/, ''),
      deleted: /^(deleted file mode|\+\+\+ \/dev\/null)/m.test(part),
      // npm diff prints only the header for files it considers binary (.node, .wasm, ...), with
      // no marker, so any content change without a hunk can't be reviewed either.
      binary: /^(Binary files .* differ|GIT binary patch)$/m.test(part) || BINARY_EXT.test(m[2])
        || (!/^@@ /m.test(part) && !/^(deleted file mode|\+\+\+ \/dev\/null)/m.test(part) && !/^(old|new) mode /m.test(part)),
    });
  }
  return chunks;
}

// Fits per-file diff chunks into `budget` characters. Every `required` chunk (code that runs)
// must be shown in full, or the review is incomplete; a required chunk that is binary or has no
// text (its diff couldn't be produced) is incomplete too. `context` chunks are shown only while
// there is room. Deleted files can't run, so they and everything else are listed by name.
export function fitDiff(chunks, { required, context = () => false, budget }) {
  let text = '', complete = true;
  const live = chunks.filter(c => !c.deleted);
  const req = live.filter(c => required(c.path));
  const ctx = live.filter(c => !required(c.path) && context(c.path));
  const listed = [...chunks.filter(c => c.deleted).map(c => `${c.path} (deleted)`), ...live.filter(c => !required(c.path) && !context(c.path)).map(c => c.path)];
  for (const [i, c] of req.entries()) {
    if (c.binary) { complete = false; text += `(${c.path}: binary change, not shown)\n`; continue; }
    if (c.text == null) { complete = false; text += `(${c.path}: diff not available)\n`; continue; }
    if (c.text.length + 1 > budget) {
      complete = false;
      text += `(code that runs, not shown because it is over the review budget: ${truncate(req.slice(i).map(x => x.path).join(', '), 1_000)})\n`;
      budget = 0;
      break;
    }
    text += c.text + '\n';
    budget -= c.text.length + 1;
  }
  const noRoom = [];
  for (const c of ctx) {
    if (!c.binary && c.text != null && c.text.length + 1 <= budget) { text += c.text + '\n'; budget -= c.text.length + 1; }
    else noRoom.push(c.path);
  }
  if (noRoom.length) text += `(changed source or context not shown, no room: ${truncate(noRoom.join(', '), 1_000)})\n`;
  if (listed.length) text += `(changed but not run when the package is used: ${truncate(listed.join(', '), 1_000)})\n`;
  return { text, complete };
}

// A published package's files. Downloads the tarball with scripts disabled and reads it in
// memory, so nothing is unpacked or run. Returns null when it could not be read.
export function packageFiles(name, version) {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-risk-'));
  try {
    execFileSync('npm', ['pack', `${name}@${version}`, '--ignore-scripts', '--pack-destination', dir],
      { timeout: 60_000, stdio: ['ignore', 'ignore', 'ignore'] });
    const tgz = readdirSync(dir).find(f => f.endsWith('.tgz'));
    return tgz ? readTarball(readFileSync(join(dir, tgz))) : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Published code of a newly added package, or null when it could not be read.
export function newPackageSource(name, version) {
  const pf = packageFiles(name, version);
  return pf ? inspectPackageFiles(pf.files, { unsupported: pf.unsupported }) : null;
}

// The npm diff of an updated package, fitted so every changed file that runs is shown in full.
// Which files run comes from the new version's own tarball; if that can't be read cleanly,
// every changed file except images, fonts and media counts. Changed data files always count:
// unchanged code can load them by a name built at runtime, which no reference check can see.
export function reviewNpmDiff(diff, newFiles, budget = LIMITS.perPackageCode) {
  const cls = newFiles && !newFiles.unsupported.length ? classifyPackageFiles(newFiles.files) : null;
  const required = cls
    ? p => cls.codeSet.has(p) || p === 'package.json' || p.endsWith('/package.json') || !skippableInDiff(p)
    : p => !INERT_ASSET.test(p);
  return { ...fitDiff(splitGitDiff(diff), { required, budget }), classified: Boolean(cls) };
}

// ---------- GitHub Actions ----------
const USES_RE = /^([+-])\s*-?\s*uses:\s*['"]?([^@\s'"]+)@([^\s'"#]+)['"]?\s*(?:#\s*(\S+))?/;
const reviewableUse = m => m && !m[2].startsWith('./') && !m[2].startsWith('docker://');

// Pairs each added `uses:` with the next removed one for the same action in the same file,
// so different sites updating the same action each get their own comparison.
// Pairing happens within one change block (a run of -/+ lines between context lines), so a
// removed ref is only ever paired with an added ref at the same site. Removed refs left over
// at the end of a block (a deleted step, or an ambiguous pairing) are returned as `unpaired`
// so the caller can flag them instead of silently dropping a comparison.
// A block with several refs for the same action can't be paired reliably, unless it's the same
// bump at several sites (every old ref equal, every new ref equal); those refs are returned as
// `ambiguous`, and every old→new combination goes to the model.
export function parseActionChanges(patch) {
  const changes = [], unpaired = [], ambiguous = [], seen = new Set();
  const record = (action, from, to) => {
    const key = `${action}|${from?.ref ?? ''}|${to.ref}`;
    if ((from && from.ref === to.ref) || seen.has(key)) return;
    seen.add(key);
    changes.push({ action, from, to });
  };
  let block = new Map(); // action -> { rem: [], add: [] } for the current block
  const flush = () => {
    for (const [action, { rem, add }] of block) {
      const same = list => list.every(u => u.ref === list[0].ref);
      if (rem.length <= 1 && add.length <= 1) {
        if (add.length) record(action, rem[0] ?? null, add[0]);
        else unpaired.push(...rem.map(r => ({ action, ...r })));
      } else if (rem.length === add.length && same(rem) && same(add)) {
        record(action, rem[0], add[0]);
      } else {
        ambiguous.push(...rem.map(r => ({ action, ...r })), ...add.map(a => ({ action, ...a })));
        for (const a of add) {
          if (!rem.length) record(action, null, a);
          for (const r of rem) record(action, r, a);
        }
      }
    }
    block = new Map();
  };
  for (const line of patch.split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---) /.test(line)) { flush(); continue; }
    const m = line.match(USES_RE);
    if (!reviewableUse(m)) continue;
    const [, sign, action, ref, comment] = m;
    if (!block.has(action)) block.set(action, { rem: [], add: [] });
    block.get(action)[sign === '-' ? 'rem' : 'add'].push({ ref, tag: comment ?? null });
  }
  flush();
  return { changes, unpaired, ambiguous };
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

// ---------- GitHub API ----------
const ghHeaders = accept => ({ accept, ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) });
async function ghJson(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders('application/vnd.github+json') });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// A file's raw bytes at a ref, or null if it doesn't exist there.
async function ghFile(owner, repo, path, ref) {
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
    { headers: ghHeaders('application/vnd.github.raw') });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} reading ${path}`);
  return Buffer.from(await r.arrayBuffer());
}

// The `runs:` block of an action.yml: using, main, pre, post, image.
export function parseActionRuns(text) {
  const out = {};
  let inRuns = false, indent = null;
  for (const line of text.split('\n')) {
    if (/^runs:\s*(#.*)?$/.test(line)) { inRuns = true; continue; }
    if (!inRuns || /^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const lead = line.match(/^\s+/)[0].length;
    indent ??= lead;
    if (lead !== indent) continue;
    const m = line.match(/^\s+(using|main|pre|post|image):\s*['"]?([^'"#\s]+)['"]?/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// A unified diff of two versions of a file, made with git so it's exact whatever the size.
function diffBuffers(oldBuf, newBuf, path) {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-risk-diff-'));
  try {
    writeFileSync(join(dir, 'a'), oldBuf ?? '');
    writeFileSync(join(dir, 'b'), newBuf ?? '');
    let out;
    try {
      out = execFileSync('git', ['diff', '--no-index', '--no-color', '-U2', 'a', 'b'], { cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      if (e.status !== 1 || e.stdout == null) throw e; // 1 just means the files differ
      out = String(e.stdout);
    }
    return out.replace(/^diff --git a\/a b\/b$/m, `diff --git a/${path} b/${path}`)
      .replace(/^--- a\/a$/m, `--- a/${path}`).replace(/^\+\+\+ b\/b$/m, `+++ b/${path}`).replace(/\n$/, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Reviews one action ref change. What runs must be shown in full:
// - node actions: action.yml plus the folder the runtime entry files live in (usually dist/).
//   GitHub's compare omits the patch for big bundles, so those files are diffed here from both
//   refs. Source, tests and the action repo's own workflows don't run and are context only.
// - composite actions: action.yml and every file that isn't docs or data (run: steps can run tests).
// Files the runtime code names, with or without the extension Node adds, are required too, and
// a change to what action.yml runs (entry file or action type) is never complete.
// - docker and anything else: the image can't be reviewed, so it's never complete.
// Returns { text, complete }, or null for a newly introduced action (flagged separately).
export async function reviewAction(c, budget = LIMITS.perActionCode) {
  const [owner, repo, ...sub] = c.action.split('/');
  if (!owner || !repo || !c.from) return null;
  const at = p => posix.normalize(sub.length ? `${sub.join('/')}/${p}` : p);
  const notes = [];
  let complete = true;
  let j;
  try {
    j = await ghJson(`/repos/${owner}/${repo}/compare/${encodeURIComponent(c.from.ref)}...${encodeURIComponent(c.to.ref)}`);
  } catch (e) {
    return { text: `(compare unavailable: ${e.message})`, complete: false };
  }
  const files = j.files ?? [];
  if (files.length >= 300) { complete = false; notes.push('the compare returned 300 files, the API maximum, so changes may be missing'); }

  const ymls = [at('action.yml'), at('action.yaml')];
  let yml = null, runs = {};
  try { yml = (await ghFile(owner, repo, ymls[0], c.to.ref)) ?? (await ghFile(owner, repo, ymls[1], c.to.ref)); } catch { /* handled below */ }
  if (yml) runs = parseActionRuns(yml.toString('utf8'));
  else { complete = false; notes.push('could not read action.yml at the new ref'); }
  const using = (runs.using ?? '').toLowerCase();
  const node = /^node\d*$/.test(using);
  const entries = node ? [...new Set(['main', 'pre', 'post'].map(k => runs[k]).filter(Boolean).map(p => at(p.replace(/^\.?\//, ''))))] : [];
  const entryDirs = [...new Set(entries.map(e => posix.dirname(e)))];
  if (yml && !node && using !== 'composite') { complete = false; notes.push(`"${runs.using ?? 'unknown'}" action${runs.image ? ` (image ${runs.image})` : ''}: what runs can't be reviewed`); }

  // If action.yml now runs something else (another entry file, or a different kind of action),
  // the newly selected code may be unchanged and so absent from the compare: never reviewed.
  if (yml) {
    let oldRuns = null;
    try {
      const old = (await ghFile(owner, repo, ymls[0], c.from.ref)) ?? (await ghFile(owner, repo, ymls[1], c.from.ref));
      if (old) oldRuns = parseActionRuns(old.toString('utf8'));
    } catch { /* treated as changed below */ }
    const what = r => JSON.stringify([(r?.using ?? '').toLowerCase(), r?.main ?? null, r?.pre ?? null, r?.post ?? null, r?.image ?? null]);
    if (what(oldRuns) !== what(runs)) {
      complete = false;
      notes.push(`what the action runs changed (${oldRuns ? `${oldRuns.using ?? '?'} ${oldRuns.main ?? oldRuns.image ?? ''}`.trim() : 'old action.yml unreadable'} → ${`${runs.using ?? '?'} ${runs.main ?? runs.image ?? ''}`.trim()}), so the newly selected code was not reviewed`);
    }
  }

  // Names the runtime code refers to, so docs or data it loads count as code.
  let refText = yml?.toString('utf8') ?? '';
  for (const e of entries) {
    try {
      const body = await ghFile(owner, repo, e, c.to.ref);
      if (body) refText += '\n' + body.toString('utf8');
      else { complete = false; notes.push(`entry file ${e} not found at the new ref`); }
    } catch (err) { complete = false; notes.push(`could not read ${e}: ${err.message}`); }
  }
  const refs = codeRefs(refText);
  const referenced = p => !INERT_ASSET.test(p) && refersTo(refs, p);
  // The action repo's own CI never runs for users; a composite action's run: steps can still
  // execute scripts kept under .github/, so for those only .github/workflows/ is excluded.
  const repoMeta = p => !ymls.includes(p) && (node ? p.startsWith('.github/') : p.startsWith('.github/workflows/'));
  // A composite action's run: steps can execute anything in the repo, tests included, so only
  // docs and data are optional there; for node actions tests never run unless referenced.
  const optional = p => (node ? isOptional(p) : isNonCode(p)) || repoMeta(p);
  const runsFrom = p => entryDirs.some(d => (d === '.' && !sub.length) || p === d || p.startsWith(`${d}/`));
  // Node can load any JavaScript-family file the runtime code reaches, including through unchanged
  // files this review never reads, so every changed one counts, wherever it is (test folders and
  // .github/ included), for node and composite actions alike.
  // Known limit: an action's data files (JSON, YAML, ...) count only when the runtime code names
  // them or they sit in the bundle folder. Requiring them all would put package-lock.json and the
  // repo's workflow YAML into nearly every action update.
  const runnableJs = p => /\.([cm]?js|node|wasm)$/i.test(p) && !isNonCode(p);
  const required = p => ymls.includes(p) || entries.includes(p) || referenced(p) || runnableJs(p)
    || (node ? runsFrom(p) && !optional(p) : !optional(p));
  const context = p => !optional(p);

  // Build chunks; files that run but have no patch are diffed here, until the budget is spent.
  let spent = 0;
  const chunks = [];
  for (const f of files) {
    const path = f.filename;
    const chunk = { path, deleted: f.status === 'removed', binary: false, text: null };
    if (f.patch !== undefined) chunk.text = `diff --git a/${f.previous_filename ?? path} b/${path}\n${f.patch}`;
    else if (!chunk.deleted && required(path) && spent <= budget) {
      try {
        const [before, after] = await Promise.all([
          f.status === 'added' ? Buffer.alloc(0) : ghFile(owner, repo, f.previous_filename ?? path, c.from.ref),
          ghFile(owner, repo, path, c.to.ref),
        ]);
        if (before === null || after === null) notes.push(`could not fetch both versions of ${path}`);
        else if (before.includes(0) || after.includes(0)) chunk.binary = true;
        else chunk.text = diffBuffers(before, after, path);
      } catch (err) { notes.push(`could not fetch ${path}: ${err.message}`); }
    }
    if (chunk.text) spent += chunk.text.length;
    chunks.push(chunk);
  }
  const fitted = fitDiff(chunks, { required, context, budget });
  const head = `using: ${runs.using ?? '?'}${entries.length ? `, runs ${entries.join(', ')}` : ''}; commits: ${j.total_commits}, files changed: ${files.length}\n`;
  return {
    text: head + (notes.length ? `(${notes.join('; ')})\n` : '') + fitted.text,
    complete: complete && fitted.complete,
  };
}

// ---------- main ----------
async function main() {
  if (!baseSha || !headSha) {
    console.error('usage: collect-context.mjs <baseSha> <headSha> <outDir>');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const changed = git('diff', '--name-only', `${baseSha}...${headSha}`).split('\n').filter(Boolean);
  const facts = { packages: [], newPackages: [], actions: [], flags: [], changedFiles: changed };
  const shared = []; // goes to every review call: release notes, lockfile summaries
  const units = []; // one per updated package, new package or action, each reviewed whole
  const notReviewed = []; // updates whose published code never reached the model

  // Set by the workflow: commits on the PR not authored by the bot (or, if required, not
  // verified). The job only checks who opened the PR; anyone with push access can add commits.
  const foreign = (process.env.FOREIGN_COMMITS ?? '').trim();
  if (foreign) facts.flags.push({ severity: 'medium', package: 'PR commits', reason: `commits not authored by the bot or not verified: ${foreign.split(/\s+/).slice(0, 10).join(', ')}` });

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
  const specChanges = []; // { file, name } for every dependency whose spec changed
  for (const f of changed.filter(f => f.endsWith('package.json'))) {
    const o = JSON.parse(gitShow(baseSha, f) || '{}');
    const n = JSON.parse(gitShow(headSha, f) || '{}');
    for (const key of DEP_KEYS) {
      for (const [name, spec] of Object.entries(n[key] ?? {})) {
        if (o[key]?.[name] !== spec) { direct.add(name); specChanges.push({ file: f, name }); }
      }
    }
    if (withoutDeps(o) !== withoutDeps(n)) facts.flags.push({ severity: 'medium', package: f, reason: 'package.json changed outside dependency fields (e.g. packageManager, engines, overrides, scripts)' });
  }

  // Lockfile changes
  for (const f of changed.filter(f => f.endsWith('pnpm-lock.yaml'))) {
    const oldText = gitShow(baseSha, f), newText = gitShow(headSha, f);
    // Without a lockfile, installs resolve whatever versions are current: nothing reviewed.
    if (oldText && !newText) facts.flags.push({ severity: 'medium', package: f, reason: 'lockfile deleted, so installs are no longer pinned to reviewed versions' });
    const unsupported =[...new Set([newText, oldText].filter(Boolean).map(t => lockfileVersion(t)))]
      .filter(v => !SUPPORTED_LOCKFILE_VERSIONS.includes(v));
    if (unsupported.length) facts.flags.push({ severity: 'medium', package: f, reason: `unsupported pnpm lockfile version ${unsupported.join(', ')} (only ${SUPPORTED_LOCKFILE_VERSIONS.map(v => `${v}.x`).join(' and ')} can be read)` });
    const oldRes = pnpmResolutions(oldText), newRes = pnpmResolutions(newText);
    const newResByVersion = resolutionIndex(newRes);
    const reResolved = [...newRes].filter(([k, v]) => oldRes.has(k) && oldRes.get(k) !== v).map(([k]) => k);
    if (reResolved.length) facts.flags.push({ severity: 'medium', package: reResolved.slice(0, 10).join(', '), reason: 'lockfile resolution or integrity changed without a version change' });
    for (const key of reResolved) {
      const offRegistry = registryMismatch(newRes.get(key), null); // without a manifest, only a non-registry tarball is reported
      if (offRegistry) facts.flags.push({ severity: 'high', package: key, reason: `what the lockfile installs is not what was reviewed: ${offRegistry}` });
    }
    const exotic = nonRegistryEntries(oldRes, newRes);
    if (exotic.length) facts.flags.push({ severity: 'medium', package: exotic.slice(0, 10).join(', '), reason: 'new lockfile entry that is not a plain npm registry package (URL, git, file or tarball source), which is not reviewed' });
    const { updated, added, removed } = diffLocks(parsePnpmLock(oldText), parsePnpmLock(newText));

    // A package (importer) can move between versions that are both in the lockfile before and
    // after, because another package still uses the old one or already used the new one, or
    // the old one simply drops out. diffLocks can't see that, so every importer transition it
    // missed is reviewed as its own update (or as a new package, for a newly added dependency).
    const strip = v => v?.replace(/\(.*$/, '');
    const plain = v => /^\d+\.\d+\.\d+(?:[-+][^\s()]*)?$/.test(v);
    const oldImp = pnpmImporters(oldText), newImp = pnpmImporters(newText);
    const have = new Set([...updated.map(u => `${u.name}|${u.from}|${u.to}`), ...added.map(a => `${a.name}||${a.version}`)]);
    const odd = [];
    for (const [imp, deps] of newImp) {
      for (const [name, ver] of deps) {
        const from = strip(oldImp.get(imp)?.get(name)), to = strip(ver);
        if (from === to) continue;
        if (!plain(to) || (from !== undefined && !plain(from))) { odd.push(`${name} (${imp})`); continue; }
        const key = from === undefined ? `${name}||${to}` : `${name}|${from}|${to}`;
        if (have.has(key)) continue;
        have.add(key);
        if (from === undefined) added.push({ name, version: to });
        else updated.push({ name, from, to });
      }
    }
    if (odd.length) facts.flags.push({ severity: 'medium', package: odd.slice(0, 10).join(', '), reason: 'resolved to a non-registry or aliased version (link:, file:, git, npm: alias), which is not reviewed' });

    // The lockfile changed but none of the checks above recognised what changed, so nothing
    // about it was reviewed.
    if (oldText !== newText && !updated.length && !added.length && !removed.length && !reResolved.length && !exotic.length && !odd.length && !unsupported.length) {
      facts.flags.push({ severity: 'medium', package: f, reason: 'lockfile changed but no package change was recognised' });
    }

    updated.sort((a, b) => Number(direct.has(b.name)) - Number(direct.has(a.name)));
    shared.push(`## Lockfile ${f}\n- updated: ${updated.length}\n- newly added packages: ${added.length}\n- removed: ${removed.length}`);

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
      const mismatch = registryMismatch(newResByVersion.get(`${u.name}@${u.to}`), mn);
      if (mismatch) facts.flags.push({ severity: 'high', package: `${u.name}@${u.to}`, reason: `what the lockfile installs is not what was reviewed: ${mismatch}` });
      facts.packages.push(entry);

      let body = `### ${u.name} ${u.from} → ${u.to}${entry.direct ? ' (direct)' : ' (transitive)'}\n` +
        `- publisher: ${entry.publisherFrom} → ${entry.publisherTo}\n- provenance: ${entry.provenanceFrom} → ${entry.provenanceTo}\n` +
        `- install scripts: ${JSON.stringify(entry.installScriptsFrom)} → ${JSON.stringify(entry.installScriptsTo)}\n` +
        `- new dependencies: ${entry.newDeps.join(', ') || 'none'}\n`;
      if (i < LIMITS.maxPackagesDiffed) {
        const d = npmDiff(u.name, u.from, u.to);
        if (diffFailed(d)) {
          notReviewed.push(`${u.name}@${u.to} (npm diff failed)`);
          body += '```diff\n' + truncate(d, 4_000) + '\n```\n';
        } else {
          const r = reviewNpmDiff(d, packageFiles(u.name, u.to));
          if (!r.complete) notReviewed.push(`${u.name}@${u.to} (${r.classified ? 'changed code over the review budget or binary' : 'files could not be classified'})`);
          body += '```diff\n' + r.text + '```\n';
        }
      } else {
        notReviewed.push(`${u.name}@${u.to} (past the ${LIMITS.maxPackagesDiffed}-package diff limit)`);
        body += '(diff skipped: package limit reached)\n';
      }
      units.push({ title: `${u.name} ${u.from} → ${u.to}`, text: body });
    }

    for (const [i, a] of added.entries()) {
      const m = await manifest(a.name, a.version);
      const entry = { ...a, publisher: publisher(m), provenance: hasProvenance(m), installScripts: installScripts(m), description: m?.description ?? null };
      if (Object.keys(entry.installScripts).length) facts.flags.push({ severity: 'high', package: a.name, reason: `newly added package has install scripts: ${Object.keys(entry.installScripts).join(', ')}` });
      if (!m) facts.flags.push({ severity: 'medium', package: a.name, reason: 'new package version not found on the npm registry' });
      const mismatch = registryMismatch(newResByVersion.get(`${a.name}@${a.version}`), m);
      if (mismatch) facts.flags.push({ severity: 'high', package: `${a.name}@${a.version}`, reason: `what the lockfile installs is not what was reviewed: ${mismatch}` });
      facts.newPackages.push(entry);
      const src = i < LIMITS.maxNewPackagesInspected ? newPackageSource(a.name, a.version) : null;
      if (!src?.inspected) notReviewed.push(`${a.name}@${a.version}`);
      units.push({ title: `new package ${a.name}@${a.version}`, text: `### NEW package ${a.name}@${a.version}\n- publisher: ${entry.publisher}\n- provenance: ${entry.provenance}\n- install scripts: ${JSON.stringify(entry.installScripts)}\n- description: ${entry.description}\n` +
        (src === null ? '(published code not inspected)\n' : '```\n' + src.text + '\n```\n') });
    }
  }

  // Each dependency spec change must move the resolved version of that dependency in that
  // package's own lockfile importer to a version it still resolves. If it doesn't (only the
  // specifier moved, the entry disappeared, an alias, a peer
  // dependency, a spec the lockfile doesn't reflect), the change is flagged. Matching per
  // importer stops an update elsewhere in the repo from masking it.
  const owningLock = f => {
    for (let d = posix.dirname(f); ; d = posix.dirname(d)) {
      const lock = d === '.' ? 'pnpm-lock.yaml' : `${d}/pnpm-lock.yaml`;
      if (gitShow(headSha, lock) || gitShow(baseSha, lock)) return { lock, importer: posix.relative(d === '.' ? '' : d, posix.dirname(f)) || '.' };
      if (d === '.' || d === '/') return null;
    }
  };
  const importerCache = new Map();
  const importers = (sha, lock) => {
    const key = `${sha}:${lock}`;
    if (!importerCache.has(key)) importerCache.set(key, pnpmImporters(gitShow(sha, lock)));
    return importerCache.get(key);
  };
  const unmatched = specChanges.filter(({ file, name }) => {
    const own = owningLock(file);
    if (!own) return true;
    const before = importers(baseSha, own.lock).get(own.importer)?.get(name);
    const after = importers(headSha, own.lock).get(own.importer)?.get(name);
    // No resolution after the change (e.g. moved to peerDependencies with auto-install-peers
    // off) means there is no reviewed version for the new spec either.
    return after === undefined || before === after;
  }).map(({ file, name }) => `${name} (${file})`);
  if (unmatched.length) facts.flags.push({ severity: 'medium', package: unmatched.slice(0, 10).join(', ') + (unmatched.length > 10 ? ` (+${unmatched.length - 10} more)` : ''), reason: 'dependency spec changed in package.json without its resolved version changing in that package\'s lockfile importer' });

  // GitHub Actions changes
  if (wf.length) {
    const patch = git('diff', `${baseSha}...${headSha}`, '--', ...wf);
    const other = unreviewedWorkflowLines(patch);
    if (other.length) {
      facts.flags.push({ severity: 'medium', package: 'workflow files', reason: `${other.length} changed workflow line(s) other than action uses: refs (e.g. docker:// images, run steps)` });
      units.push({ title: 'workflow lines outside action refs', text: '### Workflow lines outside action refs (not reviewed)\n```diff\n' + truncate(other.join("\n"), LIMITS.workflowLines) + '\n```' });
    }
    const { changes, unpaired, ambiguous } = parseActionChanges(patch);
    if (ambiguous.length) facts.flags.push({ severity: 'medium', package: [...new Set(ambiguous.map(u => u.action))].slice(0, 10).join(', '), reason: 'several refs for the same action changed in one block, so old and new refs could not be paired reliably' });
    if (unpaired.length) facts.flags.push({ severity: 'medium', package: [...new Set(unpaired.map(u => `${u.action}@${u.tag ?? u.ref}`))].slice(0, 10).join(', '), reason: 'action ref removed without a matching replacement at the same site (deleted step or ambiguous pairing)' });
    for (const c of changes) {
      facts.actions.push(c);
      if (!c.from) facts.flags.push({ severity: 'medium', package: c.action, reason: 'new GitHub Action introduced' });
      const r = await reviewAction(c);
      if (r && !r.complete) notReviewed.push(`${c.action}@${c.to.tag ?? c.to.ref} (code that runs not fully reviewed)`);
      const title = `action ${c.action} ${c.from?.tag ?? c.from?.ref ?? '(new)'} → ${c.to.tag ?? c.to.ref}`;
      units.push({ title, text: `### Action ${c.action} ${c.from?.tag ?? c.from?.ref ?? '(new)'} → ${c.to.tag ?? c.to.ref}\n` + '```diff\n' + (r?.text ?? '(no compare: new action)') + '\n```' });
    }
  }

  // Release notes from the Renovate PR body go to every review call, with the lockfile summaries.
  if (process.env.PR_BODY_FILE && existsSync(process.env.PR_BODY_FILE)) {
    shared.unshift('## Renovate PR description (release notes)\n' + truncate(readFileSync(process.env.PR_BODY_FILE, 'utf8'), LIMITS.prBody));
  }

  // Each unit is reviewed whole, in one call. Units past the overall budget aren't sent at all.
  const { units: sent, overflow, truncated } = capUnits(units, LIMITS);
  facts.truncated = truncated;
  notReviewed.push(...overflow.map(u => `${u.title} (past the overall review budget)`));

  // A skipped or failed diff means the model never saw that code, so it can't be judged low.
  if (notReviewed.length) {
    const list = notReviewed.slice(0, 10).join(', ') + (notReviewed.length > 10 ? ` (+${notReviewed.length - 10} more)` : '');
    facts.flags.push({ severity: 'medium', package: list, reason: `published code that runs was not fully reviewed for ${notReviewed.length} update(s)` });
  }

  const review = { shared: shared.join('\n\n'), units: sent };
  writeFileSync(`${outDir}/units.json`, JSON.stringify(review, null, 2));
  writeFileSync(`${outDir}/facts.json`, JSON.stringify(facts, null, 2));
  const chars = review.shared.length + sent.reduce((n, u) => n + u.text.length, 0);
  console.log(`packages updated: ${facts.packages.length}, new: ${facts.newPackages.length}, actions: ${facts.actions.length}, flags: ${facts.flags.length}, review units: ${sent.length}, chars: ${chars}`);
}

// Applies the review budgets to the units: a unit longer than maxUnitChars is cut (and the run
// marked truncated, so it can't be low), and once totalChars is spent the remaining units are
// returned as overflow, to be flagged instead of sent.
export function capUnits(units, { maxUnitChars, totalChars }) {
  let spent = 0, truncated = false;
  const kept = [], overflow = [];
  for (const u of units) {
    let text = u.text;
    if (text.length > maxUnitChars) { text = truncate(text, maxUnitChars); truncated = true; }
    if (spent + text.length > totalChars) { overflow.push(u); continue; }
    spent += text.length;
    kept.push({ ...u, text });
  }
  return { units: kept, overflow, truncated };
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  main().catch(e => { console.error(e); process.exit(1); });
}
