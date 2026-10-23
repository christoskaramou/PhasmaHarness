const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const comparisons = require('../src/comparisons.cjs');
const { STARTER } = require('../src/workspace/project-instructions.cjs');

const setup = (bot, extra = {}) => ({ hash: `h-${bot}-${JSON.stringify(extra)}`, v: 1, provider: 'codex', model: 'gpt-5.6-terra', effort: 'low',
  access: 'workspace-write', instructions: { harness: { hash: 'w' }, project: { hash: 'p' }, bot: { hash: bot } }, lessons: { hash: 'L' },
  skills: { a: 's' }, tools: { helpers: true }, checks: 'c', ...extra });
const run = (label, variant, result = {}) => ({ label, variant, pair: 1, result: { status: 'completed', checks: { Check: 'passed' }, corrections: 0,
  setups: [setup(variant ? 'changed' : 'base')], restored: [], tokens: 1000, activeMs: 60000, ...result } });
const verdict = (base, change) => comparisons.pairVerdict(base, change, 'bot');

test('checks decide a pair first, then corrections, then tokens (time only without them) beyond the 20% threshold', () => {
  assert.equal(verdict(run('A', false, { checks: { Check: 'failed' } }), run('B', true)).verdict, 'helped');
  assert.equal(verdict(run('A', false), run('B', true, { checks: { Check: 'failed' } })).verdict, 'hurt');
  assert.equal(verdict(run('A', false, { checks: { One: 'passed', Two: 'failed' } }), run('B', true, { checks: { One: 'failed', Two: 'passed' } })).verdict,
    'no observed effect');
  assert.match(verdict(run('A', false, { checks: { Check: 'failed' } }), run('B', true, { checks: { Check: 'failed' } })).reason, /both runs failed/);
  assert.equal(verdict(run('A', false, { corrections: 1 }), run('B', true)).verdict, 'helped');
  assert.match(verdict(run('A', false), run('B', true, { corrections: 1 })).reason, /more corrections/);
  // A cost-only win is "cheaper", not "helped"; tokens decide it and time is ignored while both runs report tokens.
  assert.deepEqual(verdict(run('A', false), run('B', true, { tokens: 700, activeMs: 80000 })),
    { verdict: 'cheaper', reason: 'same checks and corrections; 30% fewer tokens' });
  assert.match(verdict(run('A', false), run('B', true, { tokens: 850, activeMs: 10000 })).reason, /tokens within 20%/);
  assert.match(verdict(run('A', false), run('B', true, { tokens: 1300 })).reason, /30% more tokens/);
  // Time decides only when either run did not report its tokens completely.
  assert.deepEqual(verdict(run('A', false, { tokens: null }), run('B', true, { tokens: 10, activeMs: 30000 })),
    { verdict: 'cheaper', reason: 'same checks and corrections; 50% less active time' });
  assert.match(verdict(run('A', false, { tokens: null, activeMs: null }), run('B', true)).reason, /neither tokens nor time/);
});

test('a pair is confounded unless the two setups differ only in the change and every run finished cleanly', () => {
  const confounded = (base, change) => verdict(base, change);
  assert.match(confounded(run('A', false, { status: 'cancelled' }), run('B', true)).reason, /run A was cancelled/);
  assert.match(confounded(run('A', false), run('B', true, { setups: [setup('changed', { model: 'gpt-5.6-sol' })] })).reason, /more than the change/);
  assert.match(confounded(run('A', false), run('B', true, { setups: [setup('base')] })).reason, /did not reach/);
  assert.match(confounded(run('A', false, { setups: [setup('base'), setup('base', { provider: 'claude-cli' })] }), run('B', true)).reason,
    /run A's setup changed between attempts/);
  assert.match(confounded(run('A', false, { checks: { Check: 'not-verified' } }), run('B', true)).reason, /did not run cleanly/);
  assert.match(confounded(run('A', false, { setups: [null] }), run('B', true)).reason, /no recorded task setup/);
  // A correction runs without the lesson block, which alone is not a setup change.
  const corrected = run('A', false, { corrections: 1, setups: [setup('base'), setup('base', { lessons: null })] });
  assert.equal(confounded(corrected, run('B', true)).verdict, 'helped');
  // A project-instructions change is judged on its own part of the fingerprint.
  const projectRun = (label, variant) => run(label, variant, { setups: [setup('bot', { instructions: { harness: { hash: 'w' }, bot: { hash: 'bot' },
    project: { hash: variant ? 'p2' : 'p' } } })] });
  assert.equal(comparisons.pairVerdict(projectRun('A', false), projectRun('B', true), 'project').verdict, 'no observed effect');
  assert.match(comparisons.pairVerdict(projectRun('A', false), projectRun('B', true), 'bot').reason, /more than the change/);
});

test('a strict majority of comparable pairs decides, and only agreeing repeats raise confidence', () => {
  const pairs = (...verdicts) => verdicts.map((value, index) => ({ pair: index + 1, verdict: value }));
  assert.deepEqual(comparisons.overallVerdict(pairs('helped')), { verdict: 'helped', confidence: 'low' });
  assert.deepEqual(comparisons.overallVerdict(pairs('helped', 'helped')), { verdict: 'helped', confidence: 'medium' });
  assert.deepEqual(comparisons.overallVerdict(pairs('hurt', 'hurt', 'hurt')), { verdict: 'hurt', confidence: 'high' });
  assert.deepEqual(comparisons.overallVerdict(pairs('helped', 'no observed effect')), { verdict: 'no observed effect', confidence: 'low' });
  assert.deepEqual(comparisons.overallVerdict(pairs('helped', 'helped', 'confounded')), { verdict: 'helped', confidence: 'low' });
  assert.deepEqual(comparisons.overallVerdict(pairs('confounded')), { verdict: 'confounded', confidence: 'low' });
  const planned = comparisons.planRuns(3);
  assert.deepEqual(planned.map(entry => `${entry.pair}${entry.label}`), ['1A', '1B', '2A', '2B', '3A', '3B']);
  for (let pair = 1; pair <= 3; pair++)
    assert.equal(planned.filter(entry => entry.pair === pair && entry.variant).length, 1);
});

test('check files named by the check commands are restored from the snapshot before the checks run', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-compare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'), workspace = path.join(root, '1');
  for (const directory of [input, workspace])
    fs.mkdirSync(path.join(directory, 'tests'), { recursive: true });
  for (const directory of [input, workspace]) {
    fs.writeFileSync(path.join(directory, 'check.cjs'), 'process.exit(1);');
    fs.writeFileSync(path.join(directory, 'tests', 'data.json'), '{}');
  }
  const checks = [{ name: 'Check', argv: [process.execPath, path.join(workspace, 'check.cjs'), '--strict', 'tests/data.json'], cwd: workspace }];
  assert.deepEqual(comparisons.restoreCheckFiles(checks, workspace, input), []);
  fs.writeFileSync(path.join(workspace, 'check.cjs'), 'process.exit(0);');
  fs.rmSync(path.join(workspace, 'tests', 'data.json'));
  assert.deepEqual(comparisons.restoreCheckFiles(checks, workspace, input).sort(), ['check.cjs', 'tests/data.json']);
  assert.equal(fs.readFileSync(path.join(workspace, 'check.cjs'), 'utf8'), 'process.exit(1);');
  assert.deepEqual(comparisons.protectedFiles(checks, workspace).sort(), ['check.cjs', 'tests/data.json']);
});

test('a project-instructions comparison gives every copy the same base and only the changed run the change', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-compare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  fs.mkdirSync(input);
  const copies = [1, 2].map(index => ({ index, workspace: path.join(root, String(index)) }));
  copies.forEach(copy => fs.mkdirSync(copy.workspace));
  const record = { target: 'project', change: 'Always handle empty names.', runs: [{ index: 1, variant: false }, { index: 2, variant: true }] };
  const read = copy => fs.readFileSync(path.join(copy.workspace, 'PhasmaHarness.md'), 'utf8');
  for (const copy of copies)
    comparisons.prepareCopy(record, copy, input);
  assert.equal(read(copies[0]), STARTER);
  assert.equal(read(copies[1]), `${STARTER.trimEnd()}\n\nAlways handle empty names.\n`);
  fs.writeFileSync(path.join(input, 'AGENTS.md'), 'Keep legacy source rules.');
  comparisons.prepareCopy(record, copies[0], input);
  assert.match(read(copies[0]), /Keep legacy source rules/);
  fs.writeFileSync(path.join(input, 'PhasmaHarness.md'), '# Rules\n');
  comparisons.prepareCopy(record, copies[1], input);
  comparisons.prepareCopy(record, copies[1], input);
  assert.equal(read(copies[1]), '# Rules\n\nAlways handle empty names.\n', 'running it again writes the same file');
  fs.writeFileSync(path.join(input, 'PhasmaHarness.md'), 'x'.repeat(65530));
  assert.throws(() => comparisons.prepareCopy(record, copies[1], input), /exceed 64 KiB/);
  assert.equal(read(copies[1]), '# Rules\n\nAlways handle empty names.\n', 'oversized variants preserve the existing copy');
  fs.rmSync(path.join(copies[0].workspace, 'PhasmaHarness.md'));
  comparisons.prepareCopy({ ...record, target: 'bot' }, copies[0], input);
  assert.equal(fs.existsSync(path.join(copies[0].workspace, 'PhasmaHarness.md')), false);
});

test('a finished comparison shows its verdict at once, picks the run to apply, and the wiki keeps the records and a page', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-compare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = [run('A', true), run('B', false, { corrections: 1 })].map((entry, index) => ({ ...entry, index: index + 1, name: `Compare ${index + 1}` }));
  const record = { id: 'c1', at: Date.parse('2026-10-20T10:00:00Z'), state: 'running', project: root, task: 'Fix greet.js', change: 'Handle empty names.',
    target: 'bot', pairs: 1, model: 'Terra light', threshold: comparisons.THRESHOLD, lessonBlock: 'secret lessons', runs };
  assert.equal(JSON.stringify(comparisons.publicView(record)).includes('"changed"'), false, 'which run has the change shows only when finished');
  comparisons.finish(record);
  assert.equal(record.verdict, 'helped');
  const view = comparisons.publicView(record);
  assert.equal(view.revealed, true, 'nothing waits on a pick');
  assert.deepEqual(view.runs.map(entry => entry.changed), [true, false]);
  assert.equal(comparisons.bestRun(record).label, 'A', 'every check passed with fewer corrections');

  record.applied = { label: 'A', files: ['greet.js'] };
  comparisons.saveComparison(root, record);
  const saved = comparisons.readComparisons(root);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].lessonBlock, undefined);
  const page = fs.readFileSync(path.join(root, comparisons.PAGE), 'utf8');
  assert.match(page, /Verdict: helped, low confidence\. Applied run A's changes to the project: greet\.js\./);
  assert.match(page, /Pair 1: helped; the change needed fewer corrections \(0 instead of 1\)\.\n {2}- Run A \(with the change\)/);

  // The run that lands: every check passed, then fewer corrections, then fewer tokens; a tie goes to the current setup.
  const tie = { runs: [run('A', true), run('B', false)] };
  assert.equal(comparisons.bestRun(tie).label, 'B');
  tie.runs[0].result.tokens = 900;
  assert.equal(comparisons.bestRun(tie).label, 'A');
  tie.runs.forEach(entry => { entry.result.checks = { Check: 'failed' }; });
  assert.equal(comparisons.bestRun(tie), null, 'nothing lands when no run passed every check');
});
