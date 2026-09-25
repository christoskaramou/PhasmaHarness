const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { addedBlocks, addedLineIndexes, citations, readCited, gitTracked, relatedPassages, assessWikiUpdate, readWiki, LIMITS } = require('../src/workspace/wiki-assess.cjs');
const TRACKED = new Set(['src/shadows.cpp']);
const { DecisionLog } = require('../src/trace.cjs');

const workspace = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-assess-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'shadows.cpp'), Array.from({ length: 30 }, (_, i) => i === 11 ? 'constexpr float kShadowBias = 0.0025f;' : `// line ${i + 1}`).join('\n'));
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  return root;
};

test('wiki additions are grouped into paragraphs; headings and unchanged text are left out', () => {
  const before = new Map([['index.md', '# Wiki\n\n## Rendering\nShadows use cascades.\n'], ['old.md', 'gone']]);
  const after = new Map([['index.md', '# Wiki\n\n## Rendering\nShadows use cascades.\nThe bias is 0.0025 (src/shadows.cpp:12).\n\n## Audio\n\nAudio runs on its own thread.\n'], ['new.md', 'First line\nsecond line\n']]);
  const { blocks, changedFiles, removedLines } = addedBlocks(before, after);
  assert.deepEqual(blocks.map(b => [b.file, b.start, b.end, b.text]), [
    ['index.md', 5, 5, 'The bias is 0.0025 (src/shadows.cpp:12).'],
    ['index.md', 9, 9, 'Audio runs on its own thread.'],
    ['new.md', 1, 2, 'First line\nsecond line'],
  ]);
  assert.equal(changedFiles, 3, 'two changed files and one removed');
  assert.equal(removedLines, 0);
});

test('citations need a file with an extension; sources are read only inside the workspace and never from private paths', async t => {
  const root = workspace(t);
  assert.deepEqual(citations('See src/shadows.cpp:12 and `src/a.h:3-9`, at 10:30, https://x.io/a.md:4').map(c => c.ref), ['src/shadows.cpp:12', 'src/a.h:3-9']);
  const cited = readCited(root, citations('src/shadows.cpp:12')[0], TRACKED);
  assert.match(cited.text, /^10: \/\/ line 10\n11: \/\/ line 11\n12: constexpr float kShadowBias = 0\.0025f;/);
  assert.equal(cited.hash.length, 16);
  assert.equal(readCited(root, citations('src/shadows.cpp:99')[0], TRACKED).problem, 'line range not in the current file');
  assert.equal(readCited(root, citations('src/missing.cpp:1')[0], new Set(['src/missing.cpp'])).problem, 'file not found');
  assert.equal(readCited(root, { ref: '.env:1', file: '.env', start: 1, end: 1 }, new Set(['.env'])).problem, 'outside the workspace or private');
  assert.equal(readCited(root, { ref: '.npmrc:1', file: '.npmrc', start: 1, end: 1 }, new Set(['.npmrc'])).problem, 'outside the workspace or private', 'no dot-paths');
  assert.equal(readCited(root, { ref: 'deploy/prod.tfstate:1', file: 'deploy/prod.tfstate', start: 1, end: 1 }, new Set(['deploy/prod.tfstate'])).problem, 'outside the workspace or private');
  assert.equal(readCited(root, { ref: '../x.md:1', file: '../x.md', start: 1, end: 1 }, TRACKED).problem, 'outside the workspace or private');
  assert.equal(readCited(root, citations('src/shadows.cpp:12')[0], new Set()).problem, 'not a file tracked by Git', 'only files Git tracks are sent');
  // A real repository: only committed or staged files count.
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('add', 'src/shadows.cpp');
  assert.deepEqual([...await gitTracked(root)], ['src/shadows.cpp']);
  assert.equal((await gitTracked(path.join(root, 'src', 'missing'))).size, 0, 'not a repository: nothing is sent');
  // A tracked link to an untracked file is not sent either.
  fs.writeFileSync(path.join(root, 'notes.txt'), 'private notes\n');
  try { fs.symlinkSync(path.join(root, 'notes.txt'), path.join(root, 'src', 'link.txt')); } catch { return; }
  assert.equal(readCited(root, { ref: 'src/link.txt:1', file: 'src/link.txt', start: 1, end: 1 }, new Set(['src/link.txt'])).problem, 'not a file tracked by Git');
});

test('related passages come from the wiki as it was before the update', () => {
  const before = new Map([['rendering.md', 'Shadow bias is set in the shadow pass.\n\nThe audio mixer runs at 48 kHz.']]);
  const found = relatedPassages(before, 'The shadow bias constant lives in the shadow pass setup.');
  assert.equal(found[0].ref, 'rendering.md#1');
  assert.equal(found.length, 1);
});

test('assessment: one keyed pair of questions per addition, batched, with unassessable additions logged without a call', async t => {
  const root = workspace(t);
  const calls = [];
  const jev = { async evaluate(state, questions) {
    calls.push({ state: JSON.parse(state), questions });
    const answers = {};
    for (const key of Object.keys(questions)) answers[key] = key.endsWith('_support') ? { choice: 'supported', confidence: 0.9 } : { choice: 'addition', confidence: 0.7 };
    return { model: 'jev-1.13.0', answers, usage: { inputTokens: 500 }, durationMs: 300, estimatedCostUsd: 0.00002 };
  } };
  const before = new Map([['index.md', '# Wiki\n']]);
  const after = new Map([['index.md', ['# Wiki', '', 'Shadow bias is 0.0025 (src/shadows.cpp:12), verified 2026-09-25.', '', 'Verified 2026-09-25: the renderer is fast.', '',
    'Missing source src/nowhere.cpp:4.', '', 'x'.repeat(LIMITS.blockChars + 1) + ' src/shadows.cpp:12', ''].join('\n')]]);
  const { entries, totals } = await assessWikiUpdate({ jev, workspace: root, before, after, tracked: TRACKED });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions), ['B1_support', 'B1_novelty']);
  assert.match(calls[0].questions.B1_support.instructions, /key B1 .*verification date alone is not support/);
  assert.doesNotMatch(JSON.stringify(calls[0].questions), /shadows\.cpp|0\.0025/, 'no wiki or source text in the questions');
  assert.equal(calls[0].state.blocks.B1.sources[0].ref, 'src/shadows.cpp:12');
  assert.deepEqual(entries.map(e => e.verdict?.support || e.unassessable), ['supported', 'no file:line source cited', 'cited source not found', 'too long to judge as one addition']);
  assert.ok(!JSON.stringify(entries).includes('0.0025') && !JSON.stringify(entries).includes('renderer is fast'), 'the log keeps references and hashes, not text');
  assert.deepEqual({ ...totals, jev: { ...totals.jev } }, { changedFiles: 1, removedLines: 0, additions: 4, assessed: 1, unassessable: 3,
    jev: { calls: 1, failed: 0, inputTokens: 500, durationMs: 300, costUsd: 0.00002, model: 'jev-1.13.0' } });
  // Many additions are split across calls within the limits; a failed call leaves its additions unassessed.
  const many = new Map([['index.md', Array.from({ length: LIMITS.blocksPerCall + 2 }, (_, i) => `Fact ${i} src/shadows.cpp:12`).join('\n\n')]]);
  calls.length = 0;
  let fail = false;
  jev.evaluate = async (state, questions) => { calls.push(Object.keys(questions).length / 2); if (fail) throw new Error('Jev is rate-limited'); return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(questions).map(k => [k, { choice: k.endsWith('_support') ? 'partial' : 'covered', confidence: 0.5 }])), usage: { inputTokens: 1 }, durationMs: 1, estimatedCostUsd: 0 }; };
  assert.equal((await assessWikiUpdate({ jev, workspace: root, before, after: many, tracked: TRACKED })).totals.assessed, LIMITS.blocksPerCall + 2);
  assert.deepEqual(calls, [LIMITS.blocksPerCall, 2]);
  fail = true;
  const failed = await assessWikiUpdate({ jev, workspace: root, before, after: many, tracked: TRACKED });
  assert.equal(failed.totals.assessed, 0);
  assert.deepEqual([failed.totals.jev.calls, failed.totals.jev.failed], [2, 2], 'failed attempts are counted');
  // Failing calls still stop at the cap.
  calls.length = 0;
  const lots = new Map([['index.md', Array.from({ length: LIMITS.blocksPerCall * 8 }, (_, i) => `Fact ${i} src/shadows.cpp:12`).join('\n\n')]]);
  const capped = await assessWikiUpdate({ jev, workspace: root, before, after: lots, tracked: TRACKED });
  assert.equal(calls.length, LIMITS.callsPerUpdate);
  assert.equal(capped.totals.jev.failed, LIMITS.callsPerUpdate);
  assert.match(failed.entries[0].unassessable, /assessment failed: Jev is rate-limited/);
});

test('the comparison ignores line endings, is bounded per page and per update', async t => {
  const root = workspace(t);
  assert.deepEqual(addedLineIndexes('a\r\nb\r\n', 'a\nb\nc\n').added, [2], 'CRLF rewritten as LF is not new text');
  const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n');
  const rewritten = Array.from({ length: 1500 }, (_, i) => `other ${i}`).join('\n');
  assert.equal(addedLineIndexes(big, rewritten), null, 'a page changed beyond the cell limit is not diffed');
  const blocks = addedBlocks(new Map([['p.md', big]]), new Map([['p.md', rewritten]]));
  assert.equal(blocks.blocks[0].tooLarge, true);
  const { entries } = await assessWikiUpdate({ jev: { evaluate: async () => assert.fail('no call') }, workspace: root, before: new Map([['p.md', big]]), after: new Map([['p.md', rewritten]]), tracked: TRACKED });
  assert.deepEqual(entries, [{ file: 'p.md', unassessable: 'page changed too much to compare' }]);
  // At most LIMITS.callsPerUpdate calls; the rest are logged as not assessed.
  let calls = 0;
  const jev = { async evaluate(state, questions) { calls++; return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(questions).map(k => [k, { choice: k.endsWith('_support') ? 'supported' : 'addition', confidence: 1 }])), usage: { inputTokens: 1 }, durationMs: 1, estimatedCostUsd: 0 }; } };
  const count = LIMITS.blocksPerCall * (LIMITS.callsPerUpdate + 1);
  const many = new Map([['index.md', Array.from({ length: count }, (_, i) => `Fact ${i} src/shadows.cpp:12`).join('\n\n')]]);
  const result = await assessWikiUpdate({ jev, workspace: root, before: new Map(), after: many, tracked: TRACKED });
  assert.equal(calls, LIMITS.callsPerUpdate);
  assert.equal(result.totals.assessed, LIMITS.blocksPerCall * LIMITS.callsPerUpdate);
  assert.equal(result.entries.at(-1).unassessable, 'not assessed: update limit reached');
});

test('preparation is bounded too: additions beyond what the calls can carry are not read or searched', async t => {
  const root = workspace(t);
  let lookups = 0;
  const tracked = new Set(['src/shadows.cpp']);
  const has = tracked.has.bind(tracked);
  tracked.has = key => { lookups++; return has(key); };
  const jev = { async evaluate(state, questions) { return { model: 'jev', answers: Object.fromEntries(Object.keys(questions).map(k => [k, { choice: k.endsWith('_support') ? 'supported' : 'addition', confidence: 1 }])), usage: { inputTokens: 1 }, durationMs: 1, estimatedCostUsd: 0 }; } };
  const count = 200, prepared = LIMITS.callsPerUpdate * LIMITS.blocksPerCall;
  const after = new Map([['index.md', Array.from({ length: count }, (_, i) => `Fact ${i} src/shadows.cpp:12`).join('\n\n')]]);
  const { entries, totals } = await assessWikiUpdate({ jev, workspace: root, before: new Map([['old.md', 'Shadow facts.']]), after, tracked });
  assert.equal(totals.assessed, prepared);
  assert.ok(lookups <= prepared * 2, `${lookups} source lookups for ${prepared} prepared additions`);
  assert.deepEqual(entries.at(-1), { file: 'index.md', lines: `${count * 2 - 1}-${count * 2 - 1}`, chars: entries.at(-1).chars, hash: entries.at(-1).hash, unassessable: 'not assessed: update limit reached' });
});

test('the decision log is bounded, local and summarises wiki verdicts', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'decisions.jsonl');
  const log = new DecisionLog(file);
  log.record({ event: 'turn', route: { model: 'm' } });
  log.record({ event: 'wiki-assessment', verdict: { support: 'supported', novelty: 'addition' } });
  log.record({ event: 'wiki-assessment', unassessable: 'no file:line source cited' });
  log.record({ event: 'wiki-update', jev: { calls: 1, costUsd: 0.0001 } });
  const expected = { turns: 1, wiki: { additions: 2, assessed: 1, unassessable: 1, support: { supported: 1 }, novelty: { addition: 1 }, jevCalls: 1, jevCostUsd: 0.0001 } };
  assert.deepEqual(log.summary(), expected);
  assert.deepEqual(new DecisionLog(file).summary(), expected, 'reloaded from disk');
  assert.ok(fs.readFileSync(file, 'utf8').split('\n')[0].startsWith('{"at":'));
  assert.equal(readWiki(path.join(directory, 'missing')).size, 0);
});
