const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skills = require('../src/skill-packages.cjs');
const { readSkill, workerInstructions, skillDir } = require('../src/worker-instructions.cjs');
const { skillHashes } = require('../src/setup-fingerprint.cjs');
const comparisons = require('../src/comparisons.cjs');
const controller = require('../src/controller/comparison.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-skill-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'AppData', 'workspace', 'skills'), candidate = path.join(root, 'candidate');
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), '# New workflow\nRun {{SKILL_DIR}}/helper.cjs.');
  fs.writeFileSync(path.join(candidate, 'helper.cjs'), 'process.stdout.write("new helper");');
  fs.writeFileSync(path.join(candidate, 'asset.bin'), Buffer.from([0, 255, 17]));
  const current = skills.directories(null), runs = [{ index: 1, variant: false }, { index: 2, variant: true }];
  const prepare = () => skills.prepare(store, 'workflow', candidate, skills.directories(store), runs);
  return { root, store, candidate, current, runs, prepare };
}

test('complete skill packages are frozen per run, adopted per workspace, reloaded and undone', t => {
  const { root, store, candidate, current, prepare } = fixture(t);
  const before = skillHashes(current), skill = prepare();
  assert.deepEqual(skill.runs[0].hashes, before);
  assert.equal(skill.runs[1].hashes.workflow, skill.afterHash);
  assert.notEqual(skill.beforeHash, skill.afterHash);
  assert.notEqual(skill.runs[0].dirs.ponytail, skill.runs[1].dirs.ponytail);
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), 'Changed after dispatch');
  assert.match(readSkill('workflow', skill.runs[1].dirs), /New workflow/);
  assert.ok(workerInstructions(skill.runs[1].dirs).includes(skill.runs[1].dirs.workflow.replace(/\\/g, '/')));
  const adopted = skills.adopt(skill), active = skills.directories(store);
  assert.match(readSkill('workflow', active), /New workflow/);
  assert.deepEqual(fs.readFileSync(path.join(active.workflow, 'asset.bin')), Buffer.from([0, 255, 17]));
  assert.equal(require('node:child_process').execFileSync(process.execPath, [path.join(active.workflow, 'helper.cjs')], { encoding: 'utf8' }), 'new helper');
  // A fresh resolver reads the on-disk pointer. Another workspace still uses the bundled defaults.
  assert.deepEqual(skills.directories(store), active);
  assert.deepEqual(skillHashes(skills.directories(path.join(root, 'other'))), before);
  skills.undo(adopted);
  assert.deepEqual(skillHashes(skills.directories(store)), before);
  assert.equal(skills.directories(store).workflow, skillDir('workflow'), 'Undo removes the override and follows future bundled releases');
  assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'active.json'), 'utf8')).workflow, undefined);
  assert.ok(!fs.existsSync(path.join(skills.directories(store).workflow, 'helper.cjs')), 'Undo also removes candidate-only scripts');
  assert.deepEqual(skillHashes(current), before, 'bundled files were not changed');
});

test('skill adoption and Undo refuse intervening edits and changed snapshots', t => {
  const { store, prepare } = fixture(t);
  const skill = prepare(), changed = path.join(store, 'revisions', skill.changed, 'SKILL.md');
  const body = fs.readFileSync(changed);
  fs.writeFileSync(changed, 'Tampered snapshot');
  assert.throws(() => skills.adopt(skill), /snapshot changed/);
  fs.writeFileSync(changed, body);
  const adopted = skills.adopt(skill);
  assert.throws(() => skills.adopt(skill), /active skill changed/);
  fs.writeFileSync(path.join(skills.directories(store).workflow, 'helper.cjs'), 'User edit');
  assert.throws(() => skills.undo(adopted), /not overwritten/);
  assert.equal(fs.readFileSync(path.join(skills.directories(store).workflow, 'helper.cjs'), 'utf8'), 'User edit');
});

test('skill packages reject malformed entries, oversized input, redirected directories and manifests', t => {
  const { root, candidate, store, current, runs } = fixture(t);
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), Buffer.from([255]));
  assert.throws(() => skills.packageFiles(candidate), /UTF-8/);
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), 'x'.repeat(65537));
  assert.throws(() => skills.packageFiles(candidate), /64 KiB/);
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), 'Fine');
  const linked = path.join(candidate, 'linked');
  fs.symlinkSync(path.join(root, 'AppData'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => skills.packageFiles(candidate), /links/);
  fs.unlinkSync(linked);
  assert.throws(() => skills.prepare(store, '../escape', candidate, current, runs), /existing Harness skill/);
  skills.directories(store);
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'active.json'), '{"workflow":"../../escape"}');
  assert.throws(() => skills.directories(store, { strict: true }), /manifest/);
  const notices = [];
  assert.deepEqual(skills.directories(store, { onWarning: text => notices.push(text) }), current);
  assert.match(notices[0], /Using bundled skills/);
});

test('chained skill Undo restores revision identity, then removes the bundled override', t => {
  const { store, candidate, prepare } = fixture(t);
  const first = skills.adopt(prepare());
  fs.appendFileSync(path.join(candidate, 'SKILL.md'), '\nSecond change.');
  const secondPackage = prepare(), second = skills.adopt(secondPackage);
  assert.equal(second.previous, first.revision);
  assert.equal(secondPackage.original, first.revision, 'the prior revision is reused, not copied');
  skills.undo(second);
  assert.equal(path.basename(skills.directories(store).workflow), first.revision);
  skills.undo(first);
  assert.equal(skills.directories(store).workflow, skillDir('workflow'));
});

test('skill reads create no storage and damaged stores fall back without changing user files', t => {
  const { store, prepare, current } = fixture(t);
  assert.deepEqual(skills.directories(store), current);
  assert.equal(fs.existsSync(store), false);
  const adopted = skills.adopt(prepare());
  const original = fs.readFileSync(path.join(store, 'active.json'), 'utf8');
  fs.renameSync(path.join(store, 'revisions', adopted.revision), path.join(store, 'removed-by-user'));
  const notices = [];
  assert.equal(skills.directories(store, { onWarning: text => notices.push(text) }).workflow, skillDir('workflow'));
  assert.match(notices[0], /Using bundled workflow/);
  assert.equal(fs.readFileSync(path.join(store, 'active.json'), 'utf8'), original);
  fs.writeFileSync(path.join(store, 'active.json'), '{broken');
  assert.deepEqual(skills.directories(store, { onWarning: text => notices.push(text) }), current);
  assert.match(notices[1], /Using bundled skills/);
  assert.equal(fs.readFileSync(path.join(store, 'active.json'), 'utf8'), '{broken');
});

test('metadata descriptions control both normal and comparison indexes; unused metadata does not start a comparison', t => {
  const { store, candidate, current, prepare } = fixture(t);
  const original = readSkill('workflow', current);
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), '---\ndescription: >-\n  Use when repairing\n  a missing export.\n---\n' + original);
  for (const file of ['helper.cjs', 'asset.bin']) fs.unlinkSync(path.join(candidate, file));
  const skill = prepare();
  assert.match(workerInstructions(skill.runs[1].dirs), /workflow: Use when repairing a missing export\./);
  assert.doesNotMatch(workerInstructions(skill.runs[0].dirs), /Use when repairing/);
  const adopted = skills.adopt(skill);
  assert.match(workerInstructions(skills.directories(store)), /workflow: Use when repairing a missing export\./);
  assert.equal(adopted.skill, 'workflow');
  // Editing only the package name leaves the visible description and body unchanged.
  const currentText = readSkill('workflow', skills.directories(store));
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), currentText.replace('---\n', '---\nname: another-name\n'));
  const count = fs.readdirSync(path.join(store, 'revisions')).length;
  assert.throws(prepare, /unchanged/);
  assert.equal(fs.readdirSync(path.join(store, 'revisions')).length, count);
});

test('unchanged or failed skill preparations leave no revision packages', t => {
  const { store, candidate, prepare } = fixture(t);
  for (const file of ['helper.cjs', 'asset.bin']) fs.unlinkSync(path.join(candidate, file));
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), readSkill('workflow'));
  assert.throws(prepare, /unchanged/);
  assert.equal(fs.existsSync(store), false);
  fs.appendFileSync(path.join(candidate, 'SKILL.md'), '\nChanged.');
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (String(file).startsWith(store) && String(file).endsWith('SKILL.md')) throw new Error('Injected disk failure');
    return write(file, ...args);
  };
  try { assert.throws(prepare, /Injected disk failure/); }
  finally { fs.writeFileSync = write; }
  assert.deepEqual(fs.readdirSync(path.join(store, 'revisions')), []);
  const skill = prepare(), rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('Injected manifest failure'); };
  try { assert.throws(() => skills.adopt(skill), /Injected manifest failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readdirSync(store).some(file => file.endsWith('.tmp')), false);
  assert.equal(skills.directories(store).workflow, skillDir('workflow'));
});

test('skill description parsing handles UTF-8 BOM, CRLF and quoted text without silently accepting broken quotes', () => {
  const { skillContent } = require('../src/worker-instructions.cjs');
  assert.deepEqual(skillContent('\uFEFF---\r\ndescription: "Use for export fixes."\r\n---\r\nBody'), { description: 'Use for export fixes.', body: 'Body' });
  assert.throws(() => skillContent("---\ndescription: 'broken\n---\nBody"), /valid quoted text/);
});

test('skill cleanup bounds retained history and preserves active and in-flight snapshots', t => {
  const { store, candidate, prepare } = fixture(t);
  const history = []; let first;
  for (let i = 0; i < 54; i++) {
    fs.writeFileSync(path.join(candidate, 'SKILL.md'), 'Version ' + i);
    const skill = skills.prepare(store, 'workflow', candidate, skills.directories(store), []), adopted = skills.adopt(skill);
    first ||= adopted.revision;
    history.unshift({ adopted });
    history.length = Math.min(history.length, comparisons.MAX_RECORDS);
    skills.prune(store, history);
  }
  assert.equal(fs.existsSync(path.join(store, 'revisions', first)), false);
  assert.ok(fs.readdirSync(path.join(store, 'revisions')).filter(id => /^[0-9a-f-]{36}$/.test(id)).length <= comparisons.MAX_RECORDS + 1);
  fs.appendFileSync(path.join(candidate, 'SKILL.md'), '\nIn flight.');
  const pending = prepare();
  skills.prune(store, history, [{ skill: pending }]);
  assert.ok(fs.existsSync(pending.runs[0].dirs.workflow));
  skills.prune(store, history);
  assert.ok(!fs.existsSync(pending.runs[0].dirs.workflow));
  assert.ok(!fs.existsSync(path.join(store, 'revisions', pending.changed)));
  skills.undo(history[0].adopted);
  skills.undo(history[1].adopted);
});

test('skill cleanup preserves unsaved cards and busy snapshots, defers corrupt history, and expires old Undo cards', t => {
  const { root, store, candidate, prepare } = fixture(t);
  const first = skills.adopt(prepare());
  skills.undo(first);
  fs.appendFileSync(path.join(candidate, 'SKILL.md'), '\nSecond version.');
  const skill = prepare(), second = skills.adopt(skill);
  const wiki = path.join(store, '..', 'wiki');
  fs.mkdirSync(wiki);
  const saved = { id: 'second', number: 2, skill, adopted: second };
  const file = path.join(wiki, comparisons.RECORDS);
  fs.writeFileSync(file, JSON.stringify([saved]));
  const items = [{ hubComparison: { id: 'first', number: 1, adopted: first } },
    { hubComparison: { id: 'second', number: 2, skill: 'workflow', adopted: second } }];
  const warnings = []; let busy = true;
  const host = { data: { sessions: [{ items }], comparisons: {} },
    lessonWorkspace: value => value, wikiStore: { location: () => ({ root: wiki }) },
    log: { warn: (message, data) => warnings.push({ message, ...data }) }, save: () => {} };
  host.agents = { allControllers: () => [host], primary: host,
    pendingJobs: () => busy ? [{ session: { workspace: root } }] : [], workspaces: { record: () => ({ comparisonId: 'second' }) } };
  controller.pruneSkillStore.call(host, root);
  assert.ok(fs.existsSync(path.join(store, 'revisions', first.revision)), 'a card whose wiki write failed retains Undo');
  assert.ok(fs.existsSync(skill.runs[0].dirs.workflow), 'public cards do not replace the complete busy run record');
  busy = false;
  controller.pruneSkillStore.call(host, root);
  assert.ok(!fs.existsSync(skill.runs[0].dirs.workflow));
  fs.appendFileSync(path.join(candidate, 'SKILL.md'), '\nUnreferenced candidate.');
  const orphan = prepare();
  fs.writeFileSync(file, '{broken');
  controller.pruneSkillStore.call(host, root);
  assert.ok(fs.existsSync(orphan.runs[0].dirs.workflow), 'corrupt history cannot authorize deletion');
  assert.equal(warnings.length, 1);
  comparisons.saveComparison(wiki, { at: Date.now(), task: 'Recover', pairVerdicts: [], runs: [], change: 'Recover', ...saved });
  const backup = fs.readdirSync(wiki).find(name => name.startsWith(comparisons.RECORDS + '.corrupt-'));
  assert.equal(fs.readFileSync(path.join(wiki, backup), 'utf8'), '{broken', 'recovery preserves unreadable retention evidence');
  skills.prune(store, comparisons.readComparisons(wiki));
  assert.ok(fs.existsSync(orphan.runs[0].dirs.workflow), 'recovery retains potentially referenced packages for the history window');
  fs.writeFileSync(file, JSON.stringify(Array.from({ length: comparisons.MAX_RECORDS }, (_, i) => ({ id: 'new-' + i, number: i + 3 }))));
  controller.pruneSkillStore.call(host, root);
  assert.ok(!fs.existsSync(path.join(store, 'revisions', first.revision)));
  assert.ok(items[0].hubComparison.adopted.expiredAt);
  assert.equal(skills.directories(store).workflow, path.join(store, 'revisions', second.revision));
});

test('skill source round trips placeholders and helper changes target the new package', t => {
  const { store, candidate, current } = fixture(t);
  fs.cpSync(skillDir('large-responses'), candidate, { recursive: true });
  const { ToolHelpers } = require('../src/tools/tool-helpers.cjs');
  const helper = new ToolHelpers(path.join(candidate, 'unused'), null, null);
  helper.skillDirectories = () => current;
  const loaded = helper.read({}, { skill: 'large-responses' });
  assert.match(loaded.text, /^---/);
  assert.ok(loaded.text.includes('{{SKILL_DIR}}/scripts/output.cjs'));
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), loaded.text);
  fs.writeFileSync(path.join(candidate, 'scripts', 'output.cjs'), 'process.stdout.write("candidate helper");');
  const skill = skills.prepare(store, 'large-responses', candidate, current, [{ index: 1, variant: true }]);
  const directory = skill.runs[0].dirs['large-responses'];
  assert.equal(require('node:child_process').execFileSync(process.execPath, [path.join(directory, 'scripts/output.cjs')], { encoding: 'utf8' }), 'candidate helper');
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), loaded.text.replaceAll('{{SKILL_DIR}}', loaded.directory.replace(/\\/g, '/')));
  assert.throws(() => skills.prepare(store, 'large-responses', candidate, current, []), /old package path/);
});

test('skill candidates must be ignored and untracked before project snapshots are allowed', t => {
  const { root, candidate } = fixture(t);
  const git = (...args) => require('node:child_process').execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  assert.throws(() => skills.requireIgnoredCandidate(root, candidate), /ignored, untracked/);
  fs.writeFileSync(path.join(root, '.gitignore'), '/candidate/\n');
  skills.requireIgnoredCandidate(root, candidate);
  git('add', '-f', 'candidate/SKILL.md');
  assert.throws(() => skills.requireIgnoredCandidate(root, candidate), /ignored, untracked/);
  git('-c', 'user.name=Harness fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Candidate fixture');
  git('rm', '--cached', 'candidate/SKILL.md');
  assert.throws(() => skills.requireIgnoredCandidate(root, candidate), /ignored, untracked/, 'a staged deletion still exposes the candidate through copied Git history');
});

test('only the selected skill may differ; other skills, providers, edits between turns or missing setups confound', () => {
  const setup = (workflow, other = 'same') => ({ instructions: { harness: 'same', bot: 'same' }, skills: { workflow, other }, provider: 'codex' });
  const run = (variant, extra = {}) => ({ label: variant ? 'B' : 'A', result: { status: 'completed', checks: { test: 'passed' }, corrections: variant ? 0 : 1,
    setups: [setup(variant ? 'new' : 'old')], skillReads: ['workflow'], ...extra } });
  const verdict = (a, b) => comparisons.pairVerdict(a, b, { skill: 'workflow' });
  assert.equal(verdict(run(false), run(true)).verdict, 'helped');
  assert.equal(verdict(run(false), run(true, { setups: [setup('old')] })).verdict, 'confounded');
  assert.equal(verdict(run(false), run(true, { setups: [setup('new', 'different')] })).verdict, 'confounded');
  assert.equal(verdict(run(false), run(true, { setups: [setup('new'), setup('edited')] })).verdict, 'confounded');
  assert.equal(verdict(run(false), run(true, { setups: [] })).verdict, 'confounded');
  assert.equal(verdict(run(false), run(true, { skillError: 'snapshot edited' })).reason, 'snapshot edited');
});

test('skill comparisons enforce write access and workspace candidate scope before dispatch', async t => {
  const { root, candidate } = fixture(t);
  const host = { workspace: value => value, wikiStore: {}, agents: { workspaces: { same: (a, b) => a === b } } };
  const session = { workspace: root, access: 'read-only' };
  const args = { task: 'Check', change: 'Try skill', target: 'skill', skill: 'workflow', candidatePath: candidate };
  await assert.rejects(controller.planComparison.call(host, session, args), /requires Workspace or Full/);
  session.access = 'workspace-write';
  await assert.rejects(controller.planComparison.call(host, session, { ...args, candidatePath: '../outside' }), /inside the workspace/);
  await assert.rejects(controller.planComparison.call(host, session, { ...args, skill: 'unknown' }), /existing Harness skill/);
});

test('failed skill dispatch stops partial workers before pruning and retains their snapshots if stopping fails', async t => {
  for (const failStop of [false, true]) await t.test(`stop fails: ${failStop}`, async t => {
    const { root, store, candidate } = fixture(t), wiki = path.join(store, '..', 'wiki');
    fs.mkdirSync(wiki, { recursive: true });
    const message = { id: 'request' }, session = { id: 'owner', workspace: root, items: [message] }, stops = [];
    const host = { data: { sessions: [session], settings: {} }, save: () => {}, log: { warn: () => {} },
      resolveWorker: () => ({ label: 'Test' }), lessonsFor: () => '', lessonWorkspace: value => value,
      wikiStore: { ensure: () => ({ root: wiki }), location: () => ({ root: wiki }) },
      skillDirectories: () => skills.directories(store), pruneSkillStore: controller.pruneSkillStore,
      coordinatorTool: async () => { throw new Error('Injected dispatch failure'); } };
    host.agents = { allControllers: () => [host], primary: host,
      pendingJobs: () => [{ job: { id: 'partial-worker' }, session: { workspace: root } }],
      workspaces: { record: () => ({ comparisonId: Object.keys(host.data.comparisons || {})[0] }) },
      stopDurably: async id => { stops.push(id); if (failStop) throw new Error('Injected cleanup failure'); } };
    await assert.rejects(controller.startComparison.call(host, session,
      { target: 'skill', skill: 'workflow', candidatePath: candidate, workspace: root, pairs: 1, mode: 'test', task: 'Test', change: 'Try' },
      [], null, { id: 'request' }), failStop ? /cleanup is pending/ : /Injected dispatch failure/);
    assert.deepEqual(stops, ['partial-worker']);
    assert.equal(Object.keys(host.data.comparisons).length, failStop ? 1 : 0);
    assert.equal(!!message.comparisonId, failStop);
    assert.equal(fs.readdirSync(path.join(store, 'revisions')).length > 0, failStop);
  });
});

test('skill settlement and Undo preserve the current workspace permission ceiling', async () => {
  const view = { id: 'comparison', project: 'original', adopted: { skill: 'workflow' } };
  const owner = { workspace: 'different', access: 'workspace-write', items: [{ hubComparison: view }] };
  const host = { session: () => owner, agents: { workspaces: { same: (a, b) => a === b } } };
  const record = { target: 'skill', project: 'original', sessionId: 'owner', verdict: 'helped', runs: [] };
  for (const access of ['workspace-write', 'read-only']) {
    owner.access = access;
    assert.match((await controller.applyBestRun.call(host, record)).error, /write access/);
    assert.match(controller.adoptRule.call(host, record).error, /write access/);
    await assert.rejects(controller.undoComparison.call(host, 'owner', 'comparison', 'skill'), /write access/);
  }
});

test('skill body comparisons require observed use, including native CLI reads; descriptions alone do not', t => {
  const { store, candidate, prepare, current } = fixture(t), skill = prepare();
  assert.equal(skill.requiresRead, true);
  assert.equal(skill.descriptionChanged, false);
  const run = (variant, skillReads = []) => ({ variant, label: variant ? 'B' : 'A', result: { status: 'completed', checks: { test: 'passed' },
    corrections: variant ? 0 : 1, setups: [{ provider: 'codex', skills: { workflow: variant ? 'new' : 'old' } }], skillReads } });
  assert.equal(comparisons.pairVerdict(run(false), run(true), { skill: 'workflow' }).verdict, 'confounded');
  assert.equal(comparisons.pairVerdict(run(false), run(true, ['workflow']), { skill: 'workflow' }).verdict, 'confounded');
  assert.equal(comparisons.pairVerdict(run(false, ['workflow']), run(true, ['workflow']), { skill: 'workflow' }).verdict, 'helped');
  assert.equal(comparisons.pairVerdict(run(false), run(true, ['workflow']), { skill: 'workflow', descriptionChanged: true }).verdict, 'helped');
  assert.equal(comparisons.pairVerdict(run(false), run(true), { skill: 'workflow', requiresRead: false }).verdict, 'helped');
  const adoptionHost = { session: () => ({ access: 'danger-full-access' }) };
  assert.match(controller.adoptRule.call(adoptionHost, { target: 'skill', verdict: 'helped', skill, runs: [run(false), run(true)] }).error, /not observed being read/);
  assert.match(controller.adoptRule.call(adoptionHost, { target: 'skill', verdict: 'helped', skill, runs: [run(false), run(true, ['workflow'])] }).error, /not observed being read/);
  const host = { comparisonOf: () => ({ record: { target: 'skill', skill } }), skillDirectories: () => skill.runs[1].dirs };
  const entry = path.join(skill.runs[1].dirs.workflow, 'SKILL.md'), body = fs.readFileSync(entry, 'utf8');
  for (const item of [
    { type: 'commandExecution', command: `cat "${entry}"`, exitCode: 0, aggregatedOutput: body },
    { type: 'mcpToolCall', arguments: { file_path: entry }, result: body.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n') },
    { type: 'mcpToolCall', arguments: { file_path: entry }, result: [{ type: 'content', content: { type: 'text', text: body } }] },
    { type: 'mcpToolCall', arguments: { file_path: path.dirname(entry).replace(/\\/g, '/') + '/./SKILL.md' }, result: { content: [{ type: 'text', text: body }] } },
    { type: 'commandExecution', command: `sed -n '1,2p' "${entry}"`, exitCode: 0, aggregatedOutput: body },
    { type: 'commandExecution', command: `rg . SKILL.md`, arguments: { cmd: 'rg . SKILL.md', workdir: path.dirname(entry) }, exitCode: 0, aggregatedOutput: body },
  ]) {
    const session = { items: [{ ...item, turnId: 'turn', status: 'completed' }] };
    assert.deepEqual(controller.comparisonSkillReads.call(host, session, { turnId: 'turn' }), ['workflow']);
    session.items[0].status = 'failed';
    assert.deepEqual(controller.comparisonSkillReads.call(host, session, { turnId: 'turn' }), []);
    session.items[0].status = 'completed';
    assert.deepEqual(controller.comparisonSkillReads.call(host, session, { turnId: 'another-turn' }), []);
    session.items[0].aggregatedOutput = 'only a partial read';
    assert.deepEqual(controller.comparisonSkillReads.call(host, session, { turnId: 'turn' }), []);
    session.items[0].aggregatedOutput = '# New workflow';
    assert.deepEqual(controller.comparisonSkillReads.call(host, session, { turnId: 'turn' }), []);
    session.items[0].aggregatedOutput = body;
    session.items[0].exitCode = 1;
    assert.deepEqual(controller.comparisonSkillReads.call(host, session, { turnId: 'turn' }), []);
  }
  assert.deepEqual(controller.comparisonSkillReads.call(host, { items: [] }, { skillReads: ['workflow'] }), ['workflow']);
  assert.deepEqual(comparisons.runResult({ attempts: [{ skillReads: ['workflow'] }] }).skillReads, ['workflow']);
  const { skillContent } = require('../src/worker-instructions.cjs');
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), '---\ndescription: A different trigger.\n---\n' + skillContent(readSkill('workflow', current)).body);
  for (const file of ['helper.cjs', 'asset.bin']) fs.unlinkSync(path.join(candidate, file));
  const descriptionOnly = prepare();
  assert.equal(descriptionOnly.requiresRead, false);
  assert.equal(descriptionOnly.descriptionChanged, true);
  fs.writeFileSync(path.join(candidate, 'helper.cjs'), 'changed resource');
  assert.equal(prepare().requiresRead, true);
  assert.equal(prepare().descriptionChanged, true);
});

test('skill reads inside nested shell quotes retain evidence and the comparison verdict', t => {
  const { root } = fixture(t), folder = path.join(root, 'skill with spaces');
  fs.mkdirSync(folder);
  const entry = path.join(folder, 'SKILL.md'), body = '# Workflow\nRead the source before editing.\nRun the affected tests.\n';
  fs.writeFileSync(entry, body);
  const otherFolder = path.join(root, 'other skill with spaces');
  fs.mkdirSync(otherFolder);
  fs.writeFileSync(path.join(otherFolder, 'SKILL.md'), body);
  const output = process.platform === 'win32'
    ? require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath '${entry}'`],
      { encoding: 'utf8', timeout: 10000, windowsHide: true })
    : fs.readFileSync(entry, 'utf8');
  const host = { comparisonOf: () => ({ record: { target: 'skill', skill: { name: 'workflow' } } }), skillDirectories: () => ({ workflow: folder }) };
  const run = (variant, skillReads) => ({ variant, result: { status: 'completed', checks: { test: 'passed' }, corrections: variant ? 0 : 1,
    setups: [{ provider: 'codex', skills: { workflow: variant ? 'new' : 'old' } }], skillReads } });
  for (const command of [
    `Get-Content -LiteralPath '${entry}'`,
    `powershell.exe -NoProfile -Command "Get-Content -LiteralPath '${entry}'"`,
    `bash -lc 'cat "${entry}"'`,
  ]) for (const tool of [
    { type: 'commandExecution', command, exitCode: 0, aggregatedOutput: output },
    { type: 'dynamicToolCall', arguments: { command }, result: { content: [{ type: 'text', text: output }] } },
  ]) {
    const item = { ...tool, status: 'completed', turnId: 'turn' }, session = { workspace: root, items: [item] };
    const reads = () => controller.comparisonSkillReads.call(host, session, { turnId: 'turn' });
    assert.deepEqual(reads(), ['workflow'], command);
    assert.equal(comparisons.pairVerdict(run(false, reads()), run(true, reads()), { skill: 'workflow' }).verdict, 'helped');
    item.exitCode = 1;
    assert.deepEqual(reads(), [], 'a failed nested command still cannot supply evidence');
    item.exitCode = 0;
    item.aggregatedOutput = '# Workflow';
    assert.deepEqual(reads(), [], 'a nested path does not bypass complete-body verification');
    item.aggregatedOutput = output;
    item.command = command.replace(folder, otherFolder);
    if (item.arguments) item.arguments = { command: item.command };
    assert.deepEqual(reads(), [], 'the same body read from a different package is not evidence');
  }
});

test('skill descriptions stay short, including legacy overrides; oversized candidates create no snapshots', t => {
  const { store, candidate, prepare } = fixture(t);
  const { skillDescription } = require('../src/worker-instructions.cjs');
  const text = '---\ndescription: ' + 'x'.repeat(2000) + '\n---\nFull instructions remain here.';
  assert.ok(skillDescription('workflow', text).length <= 300);
  assert.ok(skillDescription('caveman', text).startsWith('OPT-IN'));
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), text);
  assert.throws(prepare, /300 characters/);
  assert.equal(fs.existsSync(store), false);
});

test('skill read evidence requires the whole body, possibly across successful partial reads in one turn', t => {
  const { candidate } = fixture(t);
  const lines = ['Read the relevant source before changing behavior.', 'Exercise the affected callers after the change.'];
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), '# Workflow\n' + lines.join('\n'));
  const host = { comparisonOf: () => ({ record: { target: 'skill', skill: { name: 'workflow' } } }), skillDirectories: () => ({ workflow: candidate }) };
  const read = text => ({ type: 'commandExecution', command: `rg text "${path.join(candidate, 'SKILL.md')}"`,
    turnId: 'turn', status: 'completed', exitCode: 0, aggregatedOutput: text });
  const session = { items: [read(lines[0])] }, submission = { turnId: 'turn' };
  assert.deepEqual(controller.comparisonSkillReads.call(host, session, submission), [], 'one genuine body line is insufficient');
  session.items.push({ ...read(lines[1]), turnId: 'old' });
  assert.deepEqual(controller.comparisonSkillReads.call(host, session, submission), [], 'old turns cannot fill gaps');
  session.items[1].turnId = 'turn'; session.items[1].exitCode = 1;
  assert.deepEqual(controller.comparisonSkillReads.call(host, session, submission), [], 'failed reads cannot fill gaps');
  session.items[1].exitCode = 0;
  assert.deepEqual(controller.comparisonSkillReads.call(host, session, submission), [], 'headings are part of the required body too');
  session.items.push(read('# Workflow'));
  assert.deepEqual(controller.comparisonSkillReads.call(host, session, submission), ['workflow']);
});

test('skill overrides notice bundled drift without replacing the override, including legacy metadata', t => {
  const { store, prepare } = fixture(t), adopted = skills.adopt(prepare());
  const folder = path.join(store, 'revisions', adopted.revision), notices = [];
  assert.equal(skills.directories(store, { onWarning: text => notices.push(text) }).workflow, folder);
  assert.deepEqual(notices, []);
  fs.writeFileSync(folder + '.json', JSON.stringify({ bundledHash: 'previous-release' }));
  assert.equal(skills.directories(store, { onWarning: text => notices.push(text) }).workflow, folder);
  assert.match(notices.at(-1), /bundled workflow skill changed/);
  fs.unlinkSync(folder + '.json');
  assert.equal(skills.directories(store, { onWarning: text => notices.push(text) }).workflow, folder);
  assert.match(notices.at(-1), /predates bundled-version tracking/);
});

test('skill candidate errors distinguish non-Git projects and accept local Git exclusions', t => {
  const { root, candidate } = fixture(t);
  assert.throws(() => skills.requireIgnoredCandidate(root, candidate), /require a Git workspace/);
  require('node:child_process').execFileSync('git', ['init', '-q', root]);
  assert.throws(() => skills.requireIgnoredCandidate(root, candidate), /\.git\/info\/exclude/);
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n/candidate/\n');
  skills.requireIgnoredCandidate(root, candidate);
});

test('skill pins isolate Hub workspaces and retain cross-workspace helpers until the turn ends', t => {
  const { root, candidate } = fixture(t), { Controller } = require('../src/controller.cjs');
  const wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(root, 'knowledge'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const storage = workspace => path.join(wikiStore.location(workspace).root, '..', 'skills');
  const override = skills.adopt(skills.prepare(storage(a), 'rtk', candidate, skills.directories(null), []));
  const hub = { id: 'hub', workspace: b, items: [] };
  const host = { ...controller, busy: hub.id, data: { sessions: [hub] }, wikiStore, comparisonOf: () => null,
    lessonWorkspace: value => value, save() {}, log: { warn() {} }, skillDirectories: Controller.prototype.skillDirectories };
  const dirsA = host.skillDirectories({ ...hub, workspace: a }), dirsB = host.skillDirectories(hub);
  assert.notEqual(dirsA.rtk, dirsB.rtk);
  assert.equal(dirsB.rtk, skillDir('rtk'));
  assert.equal(host.skillDirectories({ ...hub, workspace: path.join(a, '.') }), dirsA);
  if (process.platform === 'win32') assert.equal(host.skillDirectories({ ...hub, workspace: a.toUpperCase() }), dirsA);
  const snapshot = skills.prepare(storage(b), 'workflow', candidate, dirsB, [{ index: 1, variant: false }]);
  assert.equal(readSkill('rtk', snapshot.runs[0].dirs), readSkill('rtk'));
  host.comparisonOf = () => ({ record: { target: 'skill', skill: snapshot }, copy: { index: 1 } });
  assert.equal(host.skillDirectories(hub), snapshot.runs[0].dirs, 'frozen comparison paths take precedence over ordinary pins');
  host.comparisonOf = () => null;
  skills.undo(override);
  host.pruneSkillStore(a);
  assert.ok(fs.existsSync(dirsA.rtk), 'a Hub based in B retains the pinned helpers from A');
  host.busy = null; host.turnSkillDirectories.delete(hub.id);
  host.pruneSkillStore(a);
  assert.equal(fs.existsSync(dirsA.rtk), false);
});

test('skill notices persist across chats, dismissal and restart but new bundled versions notify again', t => {
  const { root, store, prepare } = fixture(t), { Controller } = require('../src/controller.cjs');
  const adopted = skills.adopt(prepare()), metadata = path.join(store, 'revisions', adopted.revision + '.json');
  fs.unlinkSync(metadata);
  const first = { id: 'one', workspace: root, items: [] }, second = { id: 'two', workspace: root, items: [] };
  const host = { data: { sessions: [first, second] }, comparisonOf: () => null, lessonWorkspace: value => value,
    wikiStore: { location: () => ({ root: path.join(store, '..', 'wiki') }) }, save() {}, changed() {}, log: { warn() {} },
    session(id) { return this.data.sessions.find(session => session.id === id); }, skillDirectories: Controller.prototype.skillDirectories };
  host.skillDirectories(first); host.skillDirectories(second);
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 0);
  Controller.prototype.dismissSkillNotice.call(host, first.id, first.items[0].id);
  host.data = JSON.parse(JSON.stringify(host.data));
  host.skillDirectories(host.session(first.id)); host.skillDirectories(host.session(second.id));
  assert.equal(host.data.sessions.flatMap(session => session.items).length, 0);
  fs.writeFileSync(metadata, JSON.stringify({ bundledHash: 'old-release' }));
  host.skillDirectories(host.session(second.id));
  assert.equal(host.session(second.id).items.length, 1);
  assert.match(host.session(second.id).items[0].text, /bundled workflow skill changed/);
});

test('workspace skill notices reach the Hub and broken-store Dismiss sticks until recovery or a different error', t => {
  const { root, store, prepare } = fixture(t), { Controller } = require('../src/controller.cjs');
  const adopted = skills.adopt(prepare());
  fs.unlinkSync(path.join(store, 'revisions', adopted.revision + '.json'));
  const hub = { id: 'hub', items: [], workspace: root }, worker = { id: 'worker', items: [], workspace: root };
  const primary = { data: { sessions: [hub] }, session: () => primary.data.sessions[0], save() {}, changed() {} };
  const host = { data: { sessions: [worker] }, agents: { primary, conversation: () => primary.session() },
    comparisonOf: () => null, lessonWorkspace: value => value, wikiStore: { location: () => ({ root: path.join(store, '..', 'wiki') }) },
    log: { warn() {} }, skillDirectories: Controller.prototype.skillDirectories };
  host.skillDirectories(worker);
  assert.equal(worker.items.length, 0);
  assert.equal(hub.items.length, 1);
  assert.match(hub.items[0].text, /predates bundled-version tracking/);
  fs.writeFileSync(path.join(store, 'active.json'), '{broken');
  host.skillDirectories(worker);
  const failure = hub.items.find(item => item.skillStoreWarning.startsWith('unavailable:'));
  assert.ok(failure);
  Controller.prototype.dismissSkillNotice.call(primary, hub.id, failure.id);
  primary.data = JSON.parse(JSON.stringify(primary.data));
  host.skillDirectories(worker);
  assert.equal(primary.session().items.length, 1, 'Dismiss survives restart while the same failure remains');
  fs.writeFileSync(path.join(store, 'active.json'), '{}');
  host.skillDirectories(worker);
  fs.writeFileSync(path.join(store, 'active.json'), '{broken');
  host.skillDirectories(worker);
  assert.equal(primary.session().items.length, 2, 'a failure after an observed recovery notifies again');
  Controller.prototype.dismissSkillNotice.call(primary, hub.id, primary.session().items[1].id);
  fs.writeFileSync(path.join(store, 'active.json'), '[]');
  host.skillDirectories(worker);
  assert.equal(primary.session().items.length, 2, 'a different failure is not suppressed');
});

test('skill Undo preserves running helpers and reports history errors without undoing its success', async t => {
  for (const brokenHistory of [false, true]) await t.test(`history write fails: ${brokenHistory}`, async t => {
    const { root, store, prepare } = fixture(t), skill = prepare(), adopted = skills.adopt(skill);
    const wiki = path.join(store, '..', 'wiki');
    const record = { id: 'saved', at: Date.now(), task: 'Use skill', change: 'New body', target: 'skill', project: root,
      pairs: 1, pairVerdicts: [], runs: [], adopted, skill };
    comparisons.saveComparison(wiki, record);
    const owner = { id: 'owner', workspace: root, access: 'workspace-write', items: [{ hubComparison: record }] };
    let saves = 0, changes = 0;
    const host = { ...controller, busy: 'owner', data: { sessions: [owner], comparisons: {} }, session: () => owner,
      wikiStore: { location: () => ({ root: wiki }), ensure: () => ({ root: wiki }) }, lessonWorkspace: value => value,
      log: { warn: () => {} }, save: () => saves++, changed: () => changes++ };
    host.agents = { primary: host, allControllers: () => [host], pendingJobs: () => [], workspaces: { same: (a, b) => a === b } };
    const save = comparisons.saveComparison;
    if (brokenHistory) comparisons.saveComparison = () => { throw new Error('Injected history write failure'); };
    try { await host.undoComparison('owner', record.id, 'skill'); } finally { comparisons.saveComparison = save; }
    assert.equal(skills.directories(store).workflow, skillDir('workflow'));
    assert.ok(record.adopted.undoneAt);
    assert.ok(saves > 0 && changes > 0);
    assert.equal(owner.items.some(item => item.type === 'notice'), brokenHistory);
    const helper = path.join(store, 'revisions', adopted.revision, 'helper.cjs');
    assert.ok(fs.existsSync(helper), 'a busy ordinary worker retains its package');
    host.busy = null; host.cleanupPending = new Set(['worker']);
    host.pruneSkillStore(root);
    assert.ok(fs.existsSync(helper), 'a stopping worker also retains its package');
    host.cleanupPending.clear();
    host.agents.allControllers = () => [host, { busy: 'elsewhere', data: { sessions: [{ id: 'elsewhere', workspace: path.join(root, 'unrelated'), items: [] }] } }];
    host.pruneSkillStore(root);
    assert.ok(!fs.existsSync(helper), 'idle cleanup eventually reclaims the undone package');
  });
});

test('skill history recovery preserves corrupt bytes, restores chat cards and allows every target to save', t => {
  const { root, store, prepare } = fixture(t), skill = prepare(), wiki = path.join(store, '..', 'wiki');
  fs.mkdirSync(wiki);
  const record = { id: 'from-chat', at: Date.now(), task: 'Task', change: 'Change', project: root, pairVerdicts: [], runs: [] };
  const session = { id: 'owner', workspace: root, items: [{ hubComparison: record }] }, warnings = [];
  const host = { ...controller, data: { sessions: [session] }, lessonWorkspace: value => value,
    wikiStore: { ensure: () => ({ root: wiki }) }, log: { warn: message => warnings.push(message) } };
  for (const target of ['bot', 'project', 'skill']) {
    fs.writeFileSync(path.join(wiki, comparisons.RECORDS), '{broken');
    assert.equal(host.saveComparisonRecord({ ...record, id: target, target }), true);
    const saved = comparisons.readComparisons(wiki);
    assert.ok(saved.some(entry => entry.id === 'from-chat'));
    const recovered = saved.find(entry => entry.id === target);
    assert.equal(fs.readFileSync(recovered.recovery.backup, 'utf8'), '{broken');
    skills.prune(store, saved);
    assert.ok(fs.existsSync(skill.runs[0].dirs.workflow));
  }
  assert.equal(warnings.length, 3);
  assert.equal(session.items.filter(item => item.type === 'notice').length, 3);
  for (let i = 0; i <= comparisons.MAX_RECORDS; i++) comparisons.saveComparison(wiki, { ...record, id: 'later-' + i, at: Date.now() + i + 1 });
  skills.prune(store, comparisons.readComparisons(wiki));
  assert.ok(!fs.existsSync(skill.runs[0].dirs.workflow), 'recovery retention expires with the normal history window');
});
