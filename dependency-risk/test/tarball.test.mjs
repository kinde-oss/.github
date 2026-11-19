// Tests for the in-memory tarball reader and what it shows the model for a new package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readTarball, inspectPackageFiles } from '../collect-context.mjs';
import { tarEntry, paxEntry, tgz } from './helpers.mjs';

const inspect = (...entries) => {
  const { files, unsupported } = readTarball(tgz(...entries));
  return inspectPackageFiles(files, { unsupported });
};
const pkg = json => tarEntry({ name: 'package/package.json', body: JSON.stringify(json) });

test('readTarball handles ustar prefixes, pax paths and directories', () => {
  const long = `package/${'d'.repeat(90)}/${'e'.repeat(60)}.js`;
  const { files, unsupported } = readTarball(tgz(
    tarEntry({ name: 'package/', type: '5' }),
    tarEntry({ name: long.slice(long.lastIndexOf('/') + 1), prefix: long.slice(0, long.lastIndexOf('/')), body: 'A' }),
    paxEntry({ path: `package/${'p'.repeat(150)}.js` }),
    tarEntry({ name: 'ignored-by-pax', body: 'B' }),
  ));
  assert.deepEqual(unsupported, []);
  assert.deepEqual(files.map(f => [f.name, f.body.toString()]), [[long, 'A'], [`package/${'p'.repeat(150)}.js`, 'B']]);
});

test('readTarball reports entries npm would read differently', () => {
  const { files, unsupported } = readTarball(tgz(
    tarEntry({ name: '././@LongLink', body: 'package/index.js\0', type: 'L' }),
    tarEntry({ name: 'package/README.md', body: 'EVIL()' }),
    tarEntry({ name: 'package/link.js', type: '2' }),
    tarEntry({ name: 'package/hard.js', type: '1' }),
  ));
  assert.equal(unsupported.length, 3);
  assert.match(unsupported.join(), /type L/);
  assert.match(unsupported.join(), /type 2/);
  assert.match(unsupported.join(), /type 1/);
  assert.deepEqual(files.map(f => f.name), ['package/README.md']);
});

test('a GNU long-name entry makes the package not inspected (the payload would install as index.js)', () => {
  const r = inspect(
    tarEntry({ name: '././@LongLink', body: 'package/index.js\0', type: 'L' }),
    tarEntry({ name: 'package/README.md', body: 'EVIL()' }),
    pkg({}),
  );
  assert.equal(r.inspected, false);
});

test('a header with a bad checksum stops the reader instead of being read differently from npm', () => {
  const bad = tarEntry({ name: 'package/decoy.txt', body: 'x'.repeat(600) });
  bad[0] ^= 0x01; // corrupt the name so the stored checksum no longer matches
  const { files, unsupported } = readTarball(tgz(pkg({}), bad, tarEntry({ name: 'package/index.js', body: 'HIDDEN()' })));
  assert.match(unsupported.join(), /bad checksum/);
  assert.deepEqual(files.map(f => f.name), ['package/package.json']);
  const r = inspect(pkg({}), bad);
  assert.equal(r.inspected, false);
});

test('an entry after a single zero block is reported; two zero blocks end the archive', () => {
  const zero = Buffer.alloc(512);
  let r = readTarball(tgz(pkg({}), zero, tarEntry({ name: 'package/index.js', body: 'HIDDEN()' })));
  assert.match(r.unsupported.join(), /single end-of-archive block/);
  r = readTarball(gzipSync(Buffer.concat([pkg({}), zero, zero, Buffer.from('trailing junk after the end')])));
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.files.map(f => f.name), ['package/package.json']);
});

test('a nested package.json makes its targets entry points, whatever their extension', () => {
  let r = inspect(pkg({ main: 'index.js' }), tarEntry({ name: 'package/index.js', body: "require('./lib')" }),
    tarEntry({ name: 'package/lib/package.json', body: '{"main": "loader.txt"}' }),
    tarEntry({ name: 'package/lib/loader.txt', body: 'EVIL_TXT()' }));
  assert.ok(r.text.includes('EVIL_TXT()'), 'the .txt file Node would run is shown');
  assert.ok(r.text.includes('--- lib/package.json ---'), 'the nested manifest is shown');
  assert.equal(r.inspected, true);

  r = inspect(pkg({}), tarEntry({ name: 'package/lib/package.json', body: '{"main": "gone.js"}' }));
  assert.equal(r.inspected, false, 'a nested main that does not exist means not inspected');
  assert.match(r.text, /declared entry points not found in the tarball: lib\/gone\.js/);

  r = inspect(pkg({}), tarEntry({ name: 'package/lib/package.json', body: '{"main": "../../outside.js"}' }));
  assert.equal(r.inspected, true, 'targets outside the package are ignored');
});

test('a truncated archive is not trusted', () => {
  const whole = tarEntry({ name: 'package/index.js', body: 'x'.repeat(2000) });
  const { unsupported } = readTarball(gzipSync(whole.subarray(0, 1024)));
  assert.match(unsupported.join(), /truncated/);
});

test('paths follow npm: the first component is stripped per entry, whatever it is called', () => {
  const r = inspect(
    tarEntry({ name: 'a-much-longer-root-folder-name/notes.txt', body: 'x' }),
    tarEntry({ name: 'package/package.json', body: '{"main":"index.js"}' }),
    tarEntry({ name: 'package/index.js', body: 'EVIL()' }),
  );
  assert.ok(r.text.includes('EVIL()'), 'payload under a second root folder is shown');
  assert.equal(r.inspected, true);
  const other = inspect(tarEntry({ name: 'node/package.json', body: '{"main":"x.js"}' }), tarEntry({ name: 'node/x.js', body: 'X()' }));
  assert.ok(other.text.includes('X()') && other.inspected, 'a root other than "package" works');
});

test('top-level entries and ones that climb out with .. are skipped; a later duplicate wins', () => {
  const r = inspect(
    pkg({ main: 'index.js' }),
    tarEntry({ name: 'toplevel.js', body: 'TOP()' }),
    tarEntry({ name: 'package/../escape.js', body: 'ESCAPE()' }),
    tarEntry({ name: 'package/index.js', body: 'FIRST()' }),
    tarEntry({ name: 'package/index.js', body: 'SECOND()' }),
  );
  assert.ok(!r.text.includes('TOP()') && !r.text.includes('ESCAPE()'));
  assert.ok(r.text.includes('SECOND()') && !r.text.includes('FIRST()'));
});

test('declared entry points are always code, and a missing one means not inspected', () => {
  let r = inspect(pkg({ main: './README.js' }), tarEntry({ name: 'package/README.js', body: 'EVIL_MAIN()' }), tarEntry({ name: 'package/LICENSE', body: 'MIT' }));
  assert.ok(r.text.includes('EVIL_MAIN()') && !r.text.includes('--- LICENSE'));
  assert.equal(r.inspected, true);

  r = inspect(pkg({ main: 'lib/missing.js' }), tarEntry({ name: 'package/other.js', body: 'x' }));
  assert.equal(r.inspected, false);
  assert.match(r.text, /declared entry points not found in the tarball: lib\/missing\.js/);

  r = inspect(pkg({ type: 'module', exports: { './feature': './feature', './x': { import: './lib/x.mjs', types: './missing.d.ts' } }, bin: { t: './cli' } }),
    tarEntry({ name: 'package/feature', body: 'F()' }), tarEntry({ name: 'package/lib/x.mjs', body: 'X()' }), tarEntry({ name: 'package/cli', body: 'C()' }));
  assert.ok(['F()', 'X()', 'C()'].every(s => r.text.includes(s)), 'extensionless exports, conditions and bin are shown');
  assert.equal(r.inspected, true, 'a missing "types" target is not a runtime entry point');

  r = inspect(pkg({ main: '', exports: { './regenerator/': './regenerator/', './*': './*.js' } }), tarEntry({ name: 'package/index.d.ts', body: 'export {}' }));
  assert.equal(r.inspected, true, 'empty main, folder and wildcard exports are not required files');

  r = inspect(pkg({ main: '.' }), tarEntry({ name: 'package/index.js', body: 'DOT()' }));
  assert.ok(r.text.includes('DOT()') && r.inspected, 'main "." means index.js');
});

test('docs or data the code refers to are shown; unreferenced docs are not', () => {
  const r = inspect(pkg({}), tarEntry({ name: 'package/index.js', body: 'require("./notes.md")' }),
    tarEntry({ name: 'package/notes.md', body: 'EVIL_MD()' }), tarEntry({ name: 'package/README.md', body: 'docs' }));
  assert.ok(r.text.includes('EVIL_MD()') && !r.text.includes('--- README.md'));
});

test('binary code or code over the budget means not inspected; types-only packages are fine', () => {
  assert.equal(inspect(pkg({}), tarEntry({ name: 'package/index.js', body: 'ok' }), tarEntry({ name: 'package/addon.node', body: 'MZ\0' })).inspected, false);
  assert.equal(inspect(pkg({}), tarEntry({ name: 'package/feature', body: 'x'.repeat(30_000) })).inspected, false);
  assert.equal(inspect(pkg({}), tarEntry({ name: 'package/index.d.ts', body: 'export {}' }), tarEntry({ name: 'package/README.md', body: 'hi' }), tarEntry({ name: 'package/font.woff2', body: 'w\0f' })).inspected, true);
});
