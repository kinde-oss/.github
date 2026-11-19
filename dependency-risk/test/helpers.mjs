// Test helpers: hand-built tarballs and a throwaway git repository.
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// One tar header block. `type` is the typeflag character ('0' file, '5' dir, 'L' GNU long name, ...).
function header(name, size, type = '0', prefix = '') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix.slice(0, 155), 345);
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

// An entry: { name, body, type, prefix }. Returns header + padded body.
export function tarEntry({ name, body = '', type = '0', prefix = '' }) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([header(name, b.length, type, prefix), b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
}

// A pax extended header carrying `records` (e.g. { path: 'package/long/name.js' }).
export function paxEntry(records) {
  const body = Object.entries(records).map(([k, v]) => {
    const rec = ` ${k}=${v}\n`;
    let len = rec.length + 1;
    while (`${len}${rec}`.length !== len) len = `${len}${rec}`.length;
    return `${len}${rec}`;
  }).join('');
  return tarEntry({ name: 'PaxHeader', body, type: 'x' });
}

export const tgz = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

// A git repo in a temp dir with `files` committed as the base; returns helpers to commit more.
export function gitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-risk-test-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  run('config', 'commit.gpgsign', 'false');
  const write = fs => {
    for (const [path, content] of Object.entries(fs)) {
      const full = join(dir, path);
      if (content === null) { rmSync(full, { force: true }); continue; }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  };
  const commit = (fs, msg = 'change') => { write(fs); run('add', '-A'); run('commit', '-q', '--allow-empty', '-m', msg); return run('rev-parse', 'HEAD'); };
  const base = commit(files, 'base');
  return { dir, base, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const COLLECTOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'collect-context.mjs');

// Runs the collector between two commits; returns facts.json. Only for scenarios that need no
// network (no npm package updates or action changes).
export function collect(repo, base, head, env = {}) {
  const out = mkdtempSync(join(tmpdir(), 'dependency-risk-out-'));
  try {
    execFileSync(process.execPath, [COLLECTOR, base, head, out], {
      cwd: repo.dir, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GITHUB_TOKEN: '', PR_BODY_FILE: '', FOREIGN_COMMITS: '', ...env },
    });
    const facts = JSON.parse(readFileSync(join(out, 'facts.json'), 'utf8'));
    facts.review = JSON.parse(readFileSync(join(out, 'units.json'), 'utf8'));
    return facts;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// A pnpm v9 lockfile with one importer per entry in `importers` and the given package keys.
export function lockV9(importers, packages) {
  let s = "lockfileVersion: '9.0'\n\nimporters:\n";
  for (const [imp, deps] of Object.entries(importers)) {
    s += `\n  ${imp}:\n    dependencies:\n`;
    for (const [name, [spec, version]] of Object.entries(deps)) s += `      ${name}:\n        specifier: ${spec}\n        version: ${version}\n`;
  }
  s += '\npackages:\n';
  for (const [key, resolution] of Object.entries(packages)) s += `\n  ${key}:\n    resolution: ${resolution}\n`;
  return s + '\nsnapshots:\n';
}
