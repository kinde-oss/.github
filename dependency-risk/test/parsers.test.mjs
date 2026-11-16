// Unit tests for the collector's parsers. No network or git needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePnpmLock, pnpmResolutions, pnpmImporters, lockfileVersion, nonRegistryEntries,
  resolutionIndex, registryMismatch, cmpSemver, diffLocks, parseActionChanges, unreviewedWorkflowLines,
} from '../collect-context.mjs';
import { lockV9 } from './helpers.mjs';

const LODASH_21 = 'sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==';
const LODASH_20 = 'sha512-PlhdFcillOINfeV7Ni6oF1TAEayyZBoZ8bcshTHqOYJYlrqzRK5hagpagky5o4HfCzzd1TRkXPMFq6cKk9rGmA==';

const V6 = `lockfileVersion: '6.0'

dependencies:
  lodash:
    specifier: ^4.17.20
    version: 4.17.20

packages:

  /lodash@4.17.20:
    resolution: {integrity: ${LODASH_20}}
    dev: false

  /@babel/core@7.24.0(supports-color@8.1.1):
    resolution:
      integrity: sha512-core
    dev: true
`;

const V9 = lockV9(
  { '.': { lodash: ['^4.17.21', '4.17.21'] }, 'apps/web': { '@scope/ui': ['^2.0.0', '2.1.0(react@18.2.0)'] } },
  { 'lodash@4.17.21': `{integrity: ${LODASH_21}}`, "'@scope/ui@2.1.0'": '{integrity: sha512-ui}' },
);

test('parsePnpmLock reads v6 and v9 package keys, including scoped and peer-suffixed ones', () => {
  assert.deepEqual([...parsePnpmLock(V6)].map(([n, v]) => [n, [...v]]), [['lodash', ['4.17.20']], ['@babel/core', ['7.24.0']]]);
  assert.deepEqual([...parsePnpmLock(V9)].map(([n, v]) => [n, [...v]]), [['lodash', ['4.17.21']], ['@scope/ui', ['2.1.0']]]);
});

test('pnpmResolutions reads inline and multi-line resolutions', () => {
  const res = pnpmResolutions(V6);
  assert.equal(res.get('/lodash@4.17.20'), `{integrity: ${LODASH_20}}`);
  assert.equal(res.get('/@babel/core@7.24.0(supports-color@8.1.1)'), 'integrity: sha512-core;');
});

test('pnpmImporters reads v9 workspaces and v6 single-project lockfiles', () => {
  assert.deepEqual([...pnpmImporters(V9)].map(([k, m]) => [k, [...m]]), [['.', [['lodash', '4.17.21']]], ['apps/web', [['@scope/ui', '2.1.0(react@18.2.0)']]]]);
  assert.deepEqual([...pnpmImporters(V6)].map(([k, m]) => [k, [...m]]), [['.', [['lodash', '4.17.20']]]]);
});

test('lockfileVersion reads the major version, and v5 is recognisably unsupported', () => {
  assert.equal(lockfileVersion(V6), '6');
  assert.equal(lockfileVersion(V9), '9');
  assert.equal(lockfileVersion('lockfileVersion: 5.4\n'), '5');
  assert.equal(lockfileVersion('nothing here'), null);
  // The v5 key format isn't readable, which is why an unsupported version must be flagged.
  assert.equal(parsePnpmLock('lockfileVersion: 5.4\npackages:\n\n  /left-pad/1.3.0:\n    resolution: {integrity: x}\n').size, 0);
});

test('nonRegistryEntries catches URL, git and tarball entries but not plain registry ones', () => {
  const oldRes = pnpmResolutions(V9);
  const newRes = pnpmResolutions(V9 + [
    '', 'packages:', '',
  ].join('\n'));
  assert.deepEqual(nonRegistryEntries(oldRes, newRes), []);
  const added = pnpmResolutions(`lockfileVersion: '9.0'

packages:

  lodash@4.17.21:
    resolution: {integrity: ${LODASH_21}}

  helper@https://evil.example/helper-1.0.0.tgz:
    resolution: {tarball: https://evil.example/helper-1.0.0.tgz}

  swapped@3.0.0:
    resolution: {integrity: sha512-x, tarball: https://evil.example/swapped.tgz}

  gitdep@git+https://github.com/x/y.git#abc:
    resolution: {commit: abc, repo: https://github.com/x/y.git, type: git}

  fine@1.0.0:
    resolution: {integrity: sha512-fine}
`);
  assert.deepEqual(nonRegistryEntries(oldRes, added).sort(), ['gitdep@git+https://github.com/x/y.git#abc', 'helper@https://evil.example/helper-1.0.0.tgz', 'swapped@3.0.0']);
  // URL keys are invisible to the version parser, which is why they need their own check.
  assert.deepEqual([...parsePnpmLock('packages:\n\n  helper@https://evil.example/h.tgz:\n    resolution: {tarball: x}\n').keys()], []);
});

test('registryMismatch accepts the registry artifact and rejects anything else', () => {
  const m = { dist: { integrity: LODASH_21, shasum: '679591c564c3bffaae8454cf0b3df370c3d6911c' } };
  const idx = resolutionIndex(pnpmResolutions(V9));
  assert.equal(registryMismatch(idx.get('lodash@4.17.21'), m), null);
  assert.match(registryMismatch(`{integrity: ${LODASH_20}}`, m), /does not match/);
  assert.match(registryMismatch(`{integrity: ${LODASH_21}, tarball: https://evil.example/l.tgz}`, m), /installs from https:\/\/evil\.example/);
  assert.equal(registryMismatch(`{integrity: ${LODASH_21}, tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz}`, m), null);
  assert.match(registryMismatch('{tarball: https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz}', m), /no integrity/);
  assert.match(registryMismatch(undefined, m), /no lockfile entry/);
  assert.equal(registryMismatch(`{integrity: ${LODASH_21}}`, null), null, 'a missing registry record is flagged elsewhere');
  const sha1 = `sha1-${Buffer.from(m.dist.shasum, 'hex').toString('base64')}`;
  assert.equal(registryMismatch(`{integrity: ${sha1}}`, { dist: { shasum: m.dist.shasum } }), null, 'old packages pinned by sha1');
  // v6 keys carry a leading slash and peer suffixes; the index strips both.
  assert.equal(resolutionIndex(pnpmResolutions(V6)).get('@babel/core@7.24.0'), 'integrity: sha512-core;');
});

test('cmpSemver follows semver precedence', () => {
  const order = ['1.2.2', '1.2.3-alpha.1', '1.2.3-alpha.2', '1.2.3-alpha.10', '1.2.3-beta', '1.2.3', '1.2.4', '1.10.0', '2.0.0+build.5'];
  assert.deepEqual([...order].reverse().sort(cmpSemver), order);
});

test('diffLocks pairs each new version with the closest older one', () => {
  const d = diffLocks(new Map([['p', new Set(['1.2.2', '1.2.3-alpha.1'])], ['gone', new Set(['1.0.0'])]]),
    new Map([['p', new Set(['1.2.2', '1.2.3'])], ['new', new Set(['0.1.0'])]]));
  assert.deepEqual(d.updated, [{ name: 'p', from: '1.2.3-alpha.1', to: '1.2.3' }]);
  assert.deepEqual(d.added, [{ name: 'new', version: '0.1.0' }]);
  assert.deepEqual(d.removed, [{ name: 'gone', version: '1.0.0' }]);
});

test('parseActionChanges pairs refs per site and flags what it cannot pair', () => {
  const p = (...l) => parseActionChanges(l.join('\n'));
  const summary = r => ({ changes: r.changes.map(c => `${c.from?.ref ?? 'new'}→${c.to.ref}`), unpaired: r.unpaired.map(u => u.ref), ambiguous: r.ambiguous.map(u => u.ref) });
  assert.deepEqual(summary(p('@@', '-  - uses: a/b@x # v1', '+  - uses: a/b@y # v2')), { changes: ['x→y'], unpaired: [], ambiguous: [] });
  assert.deepEqual(summary(p('@@', '-  - uses: a/b@x', '-  - uses: a/b@x', '+  - uses: a/b@y', '+  - uses: a/b@y')), { changes: ['x→y'], unpaired: [], ambiguous: [] }, 'same bump at two sites');
  assert.deepEqual(summary(p('@@', '-  - uses: a/b@v1', ' ', '-  - uses: a/b@v2', '+  - uses: a/b@v1')), { changes: ['v2→v1'], unpaired: ['v1'], ambiguous: [] }, 'deleted step');
  const amb = summary(p('@@', '-  - uses: a/b@v1', '-  - uses: a/b@v2', '+  - uses: a/b@v1', '+  - uses: a/b@v3'));
  assert.deepEqual(amb.ambiguous.sort(), ['v1', 'v1', 'v2', 'v3']);
  assert.ok(amb.changes.includes('v2→v1') && amb.changes.includes('v2→v3'), 'every combination is sent to the model');
  assert.deepEqual(summary(p('diff --git a/x b/x', '-  - uses: a/b@x', '+  - uses: a/b@y', 'diff --git a/z b/z', '-  - uses: a/b@w', '+  - uses: a/b@y')), { changes: ['x→y', 'w→y'], unpaired: [], ambiguous: [] }, 'one comparison per file');
  assert.deepEqual(summary(p('@@', '+  - uses: new/action@v1')), { changes: ['new→v1'], unpaired: [], ambiguous: [] });
});

test('unreviewedWorkflowLines returns everything but reviewable uses: lines', () => {
  const lines = unreviewedWorkflowLines(['--- a/w.yml', '+++ b/w.yml', '-  - uses: a/b@x', '+  - uses: a/b@y', '+  - uses: docker://alpine:3.20', '+  - run: curl x | sh', '+  # a comment', '+', '+  - uses: ./local'].join('\n'));
  assert.deepEqual(lines, ['+  - uses: docker://alpine:3.20', '+  - run: curl x | sh', '+  - uses: ./local']);
});
