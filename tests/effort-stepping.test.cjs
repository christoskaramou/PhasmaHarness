const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { autoEffortMode, parseAutoEffort, effortVariants, hasSeparateEffort } = require('../ui/agent-state.js');
const { withinCap, capCatalog, sameModel, hubEffortAllowed } = require('../src/routing/effort-cap.cjs');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const roles = require('../src/agent-roles.cjs');
const { SettingsTools } = require('../src/settings-tools.cjs');

const entry = (provider, model, effort = null) => ({
  id: effort ? `${provider}:${model}:${effort}` : `${provider}:${model}`,
  provider,
  model,
  effort,
  label: effort ? `${model} · ${effort}` : model,
  worker: true,
  router: true,
  enabled: true,
  rank: 35,
});

const CODEX_MODELS = [
  {
    model: 'gpt-6-sol',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' },
    ],
  },
];

const ANTIGRAVITY_MODELS = [
  { id: 'native:antigravity:gemini-4-neon-low', model: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)', provider: 'native:antigravity', rank: 35, worker: true, router: true, efforts: [], effort: null, images: false },
  { id: 'native:antigravity:gemini-4-neon-medium', model: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)', provider: 'native:antigravity', rank: 35, worker: true, router: true, efforts: [], effort: null, images: false },
  { id: 'native:antigravity:gemini-4-neon-high', model: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', provider: 'native:antigravity', rank: 35, worker: true, router: true, efforts: [], effort: null, images: false },
  { id: 'native:antigravity:gemini-4-neon-xhigh', model: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (xHigh)', provider: 'native:antigravity', rank: 35, worker: true, router: true, efforts: [], effort: null, images: false },
  { id: 'native:antigravity:gpt-oss-120b-medium', model: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', provider: 'native:antigravity', rank: 35, worker: true, router: true, efforts: [], effort: null, images: false },
  { id: 'native:antigravity:gemini-pro-orchestrator-neon', model: 'gemini-pro-orchestrator-neon', label: 'Gemini Pro Orchestrator', provider: 'native:antigravity', rank: 35, worker: true, router: true, efforts: [], effort: null, images: false },
];

const DEEPSEEK_MODELS = [
  { id: 'native:deepseek:deepseek-chat', model: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'native:deepseek', rank: 35, worker: true, router: true, efforts: [], effort: null, images: false },
];

class FakeCodex extends EventEmitter {
  async start() {}
  async call(method) {
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro', email: 'dev@example.com' } };
    if (method === 'model/list') return { data: CODEX_MODELS };
    return {};
  }
  close() {}
}

async function setupEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-effort-stepping-'));
  const workspace = path.join(dir, 'project');
  fs.mkdirSync(workspace);
  const attachProviders = c => {
    const agy = c.nativeCLIs.get('native:antigravity');
    agy.status = { installed: true, loggedIn: true, account: 'dev@example.com' };
    agy.models = ANTIGRAVITY_MODELS.map(m => ({ ...m }));
    agy.refresh = async () => agy.status;
    agy.inspect = () => agy.status;

    const dsh = c.nativeCLIs.get('native:deepseek');
    dsh.status = { installed: true, loggedIn: true };
    dsh.models = DEEPSEEK_MODELS.map(m => ({ ...m }));
    dsh.refresh = async () => dsh.status;
    dsh.inspect = () => dsh.status;

    c.claude.refresh = async () => c.claude.status;
    c.cursor.refresh = async () => c.cursor.status;
  };
  const factory = (file, cwd, options) => {
    const c = new Controller(file, cwd, new FakeCodex(), {
      cancel() {},
      close() {},
      async choose() { throw new Error('Unexpected routing'); },
      async complete() { return { decision: {} }; },
    }, options);
    c.isCoordinator = () => false;
    attachProviders(c);
    return c;
  };
  const primary = factory(path.join(dir, 'sessions.json'), workspace);
  await primary.initialize();
  primary.data.settings.chatgptEnabled = true;
  primary.data.settings.disabledCodexModels = [];
  primary.data.settings.antigravityEnabled = true;
  primary.data.settings.deepseekEnabled = true;
  primary.data.settings.effortCap = 'high';
  primary.data.settings.mode = 'codex:gpt-6-sol:high';
  primary.data.settings.secondaryModel = 'off';
  const agents = new Agents(primary, async () => {}, factory);
  t.after(async () => {
    agents.closing = true;
    clearTimeout(agents.quotaTimer);
    await Promise.all(agents.initializing.values());
    await agents.downloads.close();
    for (const c of agents.allControllers()) c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { primary, agents, workspace };
}

test('agent-state effortVariants and hasSeparateEffort require explicit separate effort levels', () => {
  const list = [
    entry('codex', 'gpt-6-sol', 'high'),
    entry('codex', 'gpt-6-sol', 'low'),
    entry('codex', 'gpt-6-sol', 'xhigh'),
    entry('codex', 'gpt-6-sol', 'medium'),
    entry('native:antigravity', 'gemini-4-neon-low'),
    entry('native:antigravity', 'gemini-4-neon-medium'),
    entry('native:antigravity', 'gemini-4-neon-high'),
    entry('native:antigravity', 'gemini-4-neon-xhigh'),
    entry('native:antigravity', 'gpt-oss-120b-medium'),
    entry('native:antigravity', 'gemini-pro-orchestrator-neon'),
    entry('native:deepseek', 'deepseek-chat'),
  ];

  assert.deepEqual(
    effortVariants(list, 'codex:gpt-6-sol:medium').map(p => p.effort),
    ['low', 'medium', 'high', 'xhigh'],
  );
  assert.deepEqual(
    effortVariants(list, 'autoeffort:codex:gpt-6-sol').map(p => p.effort),
    ['low', 'medium', 'high', 'xhigh'],
  );
  assert.equal(hasSeparateEffort(list, 'codex:gpt-6-sol:high'), true);
  assert.equal(hasSeparateEffort(list, 'autoeffort:codex:gpt-6-sol'), true);

  // Separate catalog models with effort words in their names have NO separate effort levels
  for (const id of [
    'native:antigravity:gemini-4-neon-high',
    'native:antigravity:gpt-oss-120b-medium',
    'native:antigravity:gemini-pro-orchestrator-neon',
    'native:deepseek:deepseek-chat',
  ]) {
    assert.deepEqual(effortVariants(list, id), [], `${id}: effortVariants must be empty`);
    assert.equal(hasSeparateEffort(list, id), false, `${id}: hasSeparateEffort must be false`);
  }

  // Startup/offline/absent catalog entries default to true
  assert.equal(hasSeparateEffort([], 'native:antigravity:gemini-4-neon-high'), true);
  assert.equal(hasSeparateEffort(list, 'auto'), true);
  assert.equal(hasSeparateEffort(list, null), true);
  assert.equal(hasSeparateEffort(list, 'unknown:model:id'), true);
});

test('effort-cap applies strictly to explicit effort levels and preserves no-effort models', () => {
  const list = [
    entry('codex', 'gpt-6-sol', 'low'),
    entry('codex', 'gpt-6-sol', 'medium'),
    entry('codex', 'gpt-6-sol', 'high'),
    entry('codex', 'gpt-6-sol', 'xhigh'),
    entry('native:antigravity', 'gemini-4-neon-high'),
    entry('native:antigravity', 'gemini-4-neon-xhigh'),
    entry('native:antigravity', 'gpt-oss-120b-medium'),
    entry('native:deepseek', 'deepseek-chat'),
  ];

  assert.equal(withinCap(list[3], 'high'), false);
  assert.equal(withinCap(list[2], 'high'), true);
  assert.equal(withinCap(list[4], 'low'), true);
  assert.equal(withinCap(list[5], 'low'), true);
  assert.equal(withinCap(list[6], 'low'), true);

  const cappedHigh = capCatalog(list, 'high');
  assert.deepEqual(cappedHigh.map(p => p.id), [
    'codex:gpt-6-sol:low',
    'codex:gpt-6-sol:medium',
    'codex:gpt-6-sol:high',
    'native:antigravity:gemini-4-neon-high',
    'native:antigravity:gemini-4-neon-xhigh',
    'native:antigravity:gpt-oss-120b-medium',
    'native:deepseek:deepseek-chat',
  ]);

  assert.equal(sameModel(list[3], cappedHigh).id, 'codex:gpt-6-sol:high');
  assert.equal(hubEffortAllowed(list[0]), true);
  assert.equal(hubEffortAllowed(list[1]), true);
  assert.equal(hubEffortAllowed(list[2]), false);
  assert.equal(hubEffortAllowed(list[3]), false);
  assert.equal(hubEffortAllowed(list[4]), true);
});

test('Controller effort stepping, Auto Advisor, and Auto Workers work for separate-effort models', async t => {
  const { agents, workspace } = await setupEnv(t);
  const botProfile = await agents.saveAgent({
    name: 'CodexLead',
    instructions: 'Lead work.',
    workspace,
    access: 'danger-full-access',
    mode: 'codex:gpt-6-sol:high',
    advisorModel: 'chat',
    workerModel: 'chat',
    effortCap: 'max',
  });
  const bot = agents.controller(botProfile.id);
  await agents.initializeController(bot);
  const session = agents.conversation(bot, true);

  assert.equal(bot.canStepEffort(), true);
  const highRoute = bot.resolveWorker('codex:gpt-6-sol:high');
  const medRoute = bot.resolveWorker('codex:gpt-6-sol:medium');

  // Under effortCap = 'max'
  assert.equal(bot.stepEffort(highRoute, 1).id, 'codex:gpt-6-sol:xhigh');
  assert.equal(bot.stepEffort(highRoute, -1).id, 'codex:gpt-6-sol:medium');
  assert.equal(bot.stepEffort(highRoute, -2).id, 'codex:gpt-6-sol:low');
  assert.equal(bot.stepEffort(highRoute, Infinity).id, 'codex:gpt-6-sol:xhigh');
  assert.equal(bot.stepEffort(highRoute, -Infinity).id, 'codex:gpt-6-sol:low');
  assert.equal(bot.stepEffort(highRoute, 0).id, 'codex:gpt-6-sol:high');
  assert.equal(bot.higherEffort(medRoute).id, 'codex:gpt-6-sol:xhigh');

  // Under effortCap = 'high': stepping up from high clamps to high
  bot.data.settings.effortCap = 'high';
  assert.equal(bot.stepEffort(highRoute, 1).id, 'codex:gpt-6-sol:high');
  assert.equal(bot.higherEffort(medRoute).id, 'codex:gpt-6-sol:high');
  assert.equal(bot.higherEffort(highRoute), null);

  // Auto Advisor ('chat' -> One higher) picks xhigh under cap 'max'
  bot.data.settings.effortCap = 'max';
  const advisorCalls = [];
  bot.smartRouter.complete = async (_req, choice) => {
    advisorCalls.push(choice.id);
    return { decision: { advice: '1. Check tests.' } };
  };
  await bot.adviseChat(session.id, 'What next?');
  assert.equal(advisorCalls.at(-1), 'codex:gpt-6-sol:xhigh');

  // Auto Workers ('chat' -> One lower) picks medium from high
  assert.equal(roles.workerMode(agents, bot, session, { createdBy: botProfile.id }), 'codex:gpt-6-sol:medium');
  assert.match(roles.roleInstructions(agents, bot, botProfile), /Worker sub-bots are on/);
  assert.match(roles.supervisorTurnNote(agents, bot), /Workers are on/);
});

test('models without separate effort levels disable Auto Advisor/Workers while keeping explicit picks working', async t => {
  const { primary, agents, workspace } = await setupEnv(t);

  for (const mode of [
    'native:antigravity:gemini-4-neon-high',
    'native:antigravity:gpt-oss-120b-medium',
    'native:antigravity:gemini-pro-orchestrator-neon',
    'native:deepseek:deepseek-chat',
  ]) {
    const profile = await agents.saveAgent({
      name: `Bot-${mode.split(':').at(-1)}`,
      instructions: 'Work.',
      workspace,
      access: 'danger-full-access',
      mode,
      advisorModel: 'chat',
      workerModel: 'chat',
    });
    // saveAgent clears own Auto advisor/workers to 'off' on a no-effort model
    assert.equal(profile.advisorModel, 'off', `${mode}: saveAgent must clear own Auto advisorModel`);
    assert.equal(profile.workerModel, 'off', `${mode}: saveAgent must clear own Auto workerModel`);

    const bot = agents.controller(profile.id);
    await agents.initializeController(bot);
    // Simulate stale Auto values directly on settings to verify runtime guards too
    bot.data.settings.advisorModel = 'chat';
    bot.data.settings.workerModel = 'chat';
    const session = agents.conversation(bot, true);
    const route = bot.resolveWorker(mode);

    assert.equal(bot.canStepEffort(), false, `${mode}: canStepEffort must be false`);
    assert.equal(bot.stepEffort(route, 1), null, `${mode}: stepEffort(+1) must be null`);
    assert.equal(bot.stepEffort(route, -1), null, `${mode}: stepEffort(-1) must be null`);
    assert.equal(bot.higherEffort(route), null, `${mode}: higherEffort must be null`);
    assert.equal(bot.effortVariant('high', mode, session), null, `${mode}: effortVariant must be null`);
    assert.equal(bot.hasAdvisor(), false, `${mode}: hasAdvisor must be false for Auto`);
    assert.equal(bot.snapshot().settings.advisorModel, 'off', `${mode}: snapshot reports effective advisorModel off`);
    assert.equal(bot.snapshot().settings.workerModel, 'off', `${mode}: snapshot reports effective workerModel off`);

    // Auto Advisor refuses instead of falling back to the bot's own model
    let advisorCalled = false;
    bot.smartRouter.complete = async () => { advisorCalled = true; return { decision: { advice: 'nope' } }; };
    await assert.rejects(
      bot.adviseChat(session.id, 'Help?'),
      /no separate effort levels for Auto Advisor/i,
      `${mode}: Auto Advisor must refuse`,
    );
    assert.equal(advisorCalled, false);

    // Auto Workers returns null and is treated as off in instructions, turn note, and agent_create
    assert.equal(roles.workerMode(agents, bot, session, { createdBy: profile.id }), null);
    const instr = roles.roleInstructions(agents, bot, profile);
    assert.doesNotMatch(instr, /Worker sub-bots are on/);
    assert.doesNotMatch(instr, /Use ask_advisor/);
    assert.equal(roles.supervisorTurnNote(agents, bot), '');

    const created = await agents.tool(bot, session, 'agent_create', { name: `Helper-${mode.split(':').at(-1)}`, instructions: 'Help.' });
    assert.equal(created.role, undefined, `${mode}: agent_create must not create a worker sub-bot when Auto Workers is unsupported`);

    // write_settings rejects Auto advisorModel/workerModel on a no-effort bot
    const settingsTools = new SettingsTools({ agents, controller: primary, wikiStore: null });
    settingsTools.host = { ask: async () => true };
    await assert.rejects(
      settingsTools.write(bot, { name: 'advisorModel', value: 'chat', agentId: profile.id }),
      /no separate effort levels for Auto Advisor/,
    );
    await assert.rejects(
      settingsTools.write(bot, { name: 'workerModel', value: 'chat', agentId: profile.id }),
      /no separate effort levels for Auto Workers/,
    );

    // Explicit advisorModel and workerModel STILL work on a no-effort model
    await agents.saveAgent({
      ...agents.profile(profile.id),
      advisorModel: 'native:antigravity:gemini-4-neon-xhigh',
      workerModel: 'native:antigravity:gemini-4-neon-medium',
    });
    assert.equal(bot.hasAdvisor(), true, `${mode}: explicit advisorModel must work`);
    const explicitAdvisorCalls = [];
    bot.smartRouter.complete = async (_req, choice) => {
      explicitAdvisorCalls.push(choice.id);
      return { decision: { advice: '1. Explicit advice.' } };
    };
    const res = await bot.adviseChat(session.id, 'Explicit advisor?');
    assert.equal(res.advice, '1. Explicit advice.');
    assert.equal(explicitAdvisorCalls.at(-1), 'native:antigravity:gemini-4-neon-xhigh');
    assert.equal(roles.workerMode(agents, bot, session, { createdBy: profile.id }), 'native:antigravity:gemini-4-neon-medium');
    assert.match(roles.roleInstructions(agents, bot, agents.profile(profile.id)), /Worker sub-bots are on[\s\S]*Use ask_advisor/);
    assert.match(roles.supervisorTurnNote(agents, bot), /Workers are on[\s\S]*Use ask_advisor/);
  }
});

test('inheritance resolves Auto Advisor/Workers to off across no-effort ancestors and re-syncs on model switch', async t => {
  const { primary, agents, workspace } = await setupEnv(t);

  // 1. Hub (separate effort, Auto Advisor & Workers) -> Child (no-effort, Inherit) => 'off'
  primary.data.settings.mode = 'codex:gpt-6-sol:high';
  primary.data.settings.advisorModel = 'chat';
  primary.data.settings.workerModel = 'chat';
  const noEffortChildProfile = await agents.saveAgent({
    name: 'NoEffortChild',
    instructions: 'Work.',
    workspace,
    access: 'danger-full-access',
    mode: 'native:antigravity:gemini-4-neon-high',
  });
  const noEffortChild = agents.controller(noEffortChildProfile.id);
  await agents.initializeController(noEffortChild);
  const childSession = agents.conversation(noEffortChild, true);
  assert.equal(agents.botSetting(noEffortChildProfile.id, 'advisorModel'), 'off');
  assert.equal(agents.botSetting(noEffortChildProfile.id, 'workerModel'), 'off');
  assert.equal(noEffortChild.data.settings.advisorModel, 'off');
  assert.equal(noEffortChild.data.settings.workerModel, 'off');
  assert.equal(noEffortChild.hasAdvisor(), false);
  assert.equal(roles.workerMode(agents, noEffortChild, childSession, { createdBy: noEffortChildProfile.id }), null);

  // 3. 3-level chain: Hub (separate effort, Auto) -> Mid (no-effort, Inherit) -> Grandchild (separate effort, Inherit) => 'off'
  const grandchildProfile = await agents.saveAgent({
    name: 'GrandchildCodex',
    instructions: 'Work.',
    createdBy: noEffortChildProfile.id,
    workspace,
    access: 'danger-full-access',
    mode: 'codex:gpt-6-sol:high',
  });
  const grandchild = agents.controller(grandchildProfile.id);
  await agents.initializeController(grandchild);
  assert.equal(agents.botSetting(grandchildProfile.id, 'advisorModel'), 'off');
  assert.equal(agents.botSetting(grandchildProfile.id, 'workerModel'), 'off');
  assert.equal(grandchild.data.settings.advisorModel, 'off');
  assert.equal(grandchild.data.settings.workerModel, 'off');

  // 2. Hub (no-effort, default/stale Auto) -> snapshot reports 'off' and separate-effort Child (Inherit) => 'off'
  primary.data.settings.mode = 'native:antigravity:gemini-4-neon-high';
  delete primary.data.settings.advisorModel; // unset default 'chat'
  primary.data.settings.workerModel = 'chat'; // stale Auto
  assert.equal(primary.snapshot().settings.advisorModel, 'off');
  assert.equal(primary.snapshot().settings.workerModel, 'off');

  const codexChildProfile = await agents.saveAgent({
    name: 'CodexChild',
    instructions: 'Work.',
    workspace,
    access: 'danger-full-access',
    mode: 'codex:gpt-6-sol:high',
  });
  const codexChild = agents.controller(codexChildProfile.id);
  await agents.initializeController(codexChild);
  assert.equal(agents.botSetting(codexChildProfile.id, 'advisorModel'), 'off');
  assert.equal(agents.botSetting(codexChildProfile.id, 'workerModel'), 'off');
  assert.equal(codexChild.data.settings.advisorModel, 'off');
  assert.equal(codexChild.data.settings.workerModel, 'off');

  // 4. Hub (no-effort, explicit Advisor & Workers model) -> Child (no-effort, Inherit) inherits explicit model cleanly
  primary.data.settings.advisorModel = 'native:antigravity:gemini-4-neon-xhigh';
  primary.data.settings.workerModel = 'native:antigravity:gemini-4-neon-medium';
  agents.sync(noEffortChild);
  assert.equal(agents.botSetting(noEffortChildProfile.id, 'advisorModel'), 'native:antigravity:gemini-4-neon-xhigh');
  assert.equal(agents.botSetting(noEffortChildProfile.id, 'workerModel'), 'native:antigravity:gemini-4-neon-medium');
  assert.equal(noEffortChild.data.settings.advisorModel, 'native:antigravity:gemini-4-neon-xhigh');
  assert.equal(noEffortChild.data.settings.workerModel, 'native:antigravity:gemini-4-neon-medium');
  assert.equal(noEffortChild.hasAdvisor(), true);

  // 5. Hub (no-effort) -> Child (separate effort, own advisorModel: 'chat') works
  primary.data.settings.advisorModel = 'off';
  primary.data.settings.workerModel = 'off';
  const ownAutoChildProfile = await agents.saveAgent({
    name: 'OwnAutoCodex',
    instructions: 'Work.',
    workspace,
    access: 'danger-full-access',
    mode: 'codex:gpt-6-sol:high',
    advisorModel: 'chat',
  });
  const ownAutoChild = agents.controller(ownAutoChildProfile.id);
  await agents.initializeController(ownAutoChild);
  assert.equal(agents.botSetting(ownAutoChildProfile.id, 'advisorModel'), 'chat');
  assert.equal(ownAutoChild.data.settings.advisorModel, 'chat');
  assert.equal(ownAutoChild.hasAdvisor(), true);

  // 6. renameHub switching Hub from gpt-6-sol (Auto Advisor) to gemini-4-neon-high clears Hub's Auto to 'off'
  //    AND immediately re-syncs an inheriting separate-effort child to 'off'
  primary.data.settings.mode = 'codex:gpt-6-sol:high';
  primary.data.settings.advisorModel = 'chat';
  primary.data.settings.workerModel = 'chat';
  agents.sync(codexChild);
  assert.equal(codexChild.data.settings.advisorModel, 'chat');
  assert.equal(codexChild.data.settings.workerModel, 'chat');

  agents.renameHub({ name: 'RenamedHub', mode: 'native:antigravity:gemini-4-neon-high' });
  assert.equal(primary.data.settings.advisorModel, 'off');
  assert.equal(primary.data.settings.workerModel, 'off');
  assert.equal(codexChild.data.settings.advisorModel, 'off');
  assert.equal(codexChild.data.settings.workerModel, 'off');

  // 7. saveAgent switching a bot from gpt-6-sol (Auto Advisor/Workers) to gemini-4-neon-high
  //    clears its Auto to 'off' AND re-syncs its inheriting child to 'off'
  const parentProfile = await agents.saveAgent({
    name: 'SwitchParent',
    instructions: 'Parent.',
    workspace,
    access: 'danger-full-access',
    mode: 'codex:gpt-6-sol:high',
    advisorModel: 'chat',
    workerModel: 'chat',
  });
  const parent = agents.controller(parentProfile.id);
  await agents.initializeController(parent);
  const subChildProfile = await agents.saveAgent({
    name: 'SwitchSubChild',
    instructions: 'Child.',
    createdBy: parentProfile.id,
    workspace,
    access: 'danger-full-access',
    mode: 'codex:gpt-6-sol:high',
  });
  const subChild = agents.controller(subChildProfile.id);
  await agents.initializeController(subChild);
  assert.equal(subChild.data.settings.advisorModel, 'chat');
  assert.equal(subChild.data.settings.workerModel, 'chat');

  const updatedParent = await agents.saveAgent({
    ...agents.profile(parentProfile.id),
    mode: 'native:antigravity:gemini-4-neon-high',
  });
  assert.equal(updatedParent.advisorModel, 'off');
  assert.equal(updatedParent.workerModel, 'off');
  assert.equal(parent.data.settings.advisorModel, 'off');
  assert.equal(parent.data.settings.workerModel, 'off');
  assert.equal(subChild.data.settings.advisorModel, 'off');
  assert.equal(subChild.data.settings.workerModel, 'off');

  // 8. Temporary provider disconnect must NOT wipe saved Auto on a separate-effort model when editing unrelated fields
  const offlineCodex = await agents.saveAgent({
    name: 'OfflineCodex',
    instructions: 'Work.',
    workspace,
    access: 'danger-full-access',
    mode: 'codex:gpt-6-sol:high',
    advisorModel: 'chat',
    workerModel: 'chat',
  });
  const prevAccount = primary.account;
  primary.account = null; // Codex offline while Antigravity remains online
  assert.equal(primary.canStepEffort('codex:gpt-6-sol:high'), true, 'catalogued separate efforts survive temporary provider disconnect');
  const renamedOffline = await agents.saveAgent({ ...agents.profile(offlineCodex.id), name: 'OfflineCodexRenamed' });
  primary.account = prevAccount;
  assert.equal(renamedOffline.advisorModel, 'chat');
  assert.equal(renamedOffline.workerModel, 'chat');

  // 9. Undiscovered Cursor model treats effort support as unknown (preserving saved Auto on rename),
  //    then reflects discovered capabilities once cursor.models arrives
  primary.data.settings.cursorEnabled = true;
  primary.data.settings.providerModels = [
    ...(primary.data.settings.providerModels || []),
    { id: 'cursor-cli:grok-4.7:default', provider: 'cursor-cli', model: 'grok-4.7', label: 'Grok 4.7', rank: 20, worker: true, router: true, enabled: true },
  ];
  primary.cursor.models = []; // discovery has not loaded yet
  assert.equal(primary.canStepEffort('autoeffort:cursor-cli:grok-4.7'), true, 'undiscovered Cursor model keeps Auto');
  assert.equal(hasSeparateEffort(primary.catalog(), 'autoeffort:cursor-cli:grok-4.7'), true);
  const cursorBot = await agents.saveAgent({
    name: 'CursorPreDiscover',
    instructions: 'Work.',
    workspace,
    access: 'danger-full-access',
    mode: 'autoeffort:cursor-cli:grok-4.7',
    advisorModel: 'chat',
    workerModel: 'chat',
  });
  const cursorRenamed = await agents.saveAgent({ ...agents.profile(cursorBot.id), name: 'CursorPreDiscoverRenamed' });
  assert.equal(cursorRenamed.advisorModel, 'chat', 'renaming before Cursor discovery must not wipe Auto Advisor');
  assert.equal(cursorRenamed.workerModel, 'chat', 'renaming before Cursor discovery must not wipe Auto Workers');
  // Once discovery loads with no efforts, canStepEffort becomes false
  primary.cursor.models = [{ id: 'grok-4.7', parameterized: true, parameters: {} }];
  assert.equal(primary.canStepEffort('autoeffort:cursor-cli:grok-4.7'), false);
  // Single explicit effort matched by saved baseId or alias: backend and UI helper MUST agree (both false)
  primary.cursor.models = [{ id: 'grok-4.7', parameterized: true, parameters: {}, efforts: ['high'], effortOption: 'reasoning_effort' }];
  assert.equal(primary.canStepEffort('cursor-cli:grok-4.7:default'), false);
  assert.equal(hasSeparateEffort(primary.catalog(), 'cursor-cli:grok-4.7:default'), false, 'UI hasSeparateEffort resolves saved baseId like canStepEffort');
  // Before discovery, Auto Advisor reports temporary loading instead of claiming no separate effort levels
  primary.cursor.models = [];
  const cursorBotCtrl = agents.controller(cursorBot.id);
  await agents.initializeController(cursorBotCtrl);
  cursorBotCtrl.cursor.models = [];
  cursorBotCtrl.data.settings.providerModels = primary.data.settings.providerModels;
  const cursorSession = agents.conversation(cursorBotCtrl, true);
  await assert.rejects(
    cursorBotCtrl.adviseChat(cursorSession.id, 'Advice while discovering?'),
    /Still loading this model’s effort levels/,
    'Auto Advisor distinguishes undiscovered Cursor models from models with no separate efforts',
  );
  // Once discovery loads with >= 2 efforts, canStepEffort and hasSeparateEffort are both true (including via baseId)
  primary.cursor.models = [{ id: 'grok-4.7', parameterized: true, parameters: {}, efforts: ['low', 'high'], effortOption: 'reasoning_effort' }];
  assert.equal(primary.canStepEffort('autoeffort:cursor-cli:grok-4.7'), true);
  assert.equal(hasSeparateEffort(primary.catalog(), 'cursor-cli:grok-4.7:default'), true);

  // 10. Multi-effort model with only 1 usable/available effort still clamps stepEffort to that sole usable level
  const singleUsable = await agents.saveAgent({
    name: 'SingleUsableEffort',
    instructions: 'Work.',
    workspace,
    access: 'danger-full-access',
    mode: 'codex:gpt-6-sol:low',
    advisorModel: 'chat',
    workerModel: 'chat',
  });
  const singleBot = agents.controller(singleUsable.id);
  await agents.initializeController(singleBot);
  const origAvailable = singleBot.available.bind(singleBot);
  singleBot.available = p => p.model === 'gpt-6-sol' ? p.effort === 'low' : origAvailable(p);
  const lowRoute = singleBot.resolveWorker('codex:gpt-6-sol:low');
  assert.equal(singleBot.canStepEffort(), true);
  assert.equal(singleBot.stepEffort(lowRoute, -1)?.id, 'codex:gpt-6-sol:low', 'clamps Auto Workers to sole usable effort instead of null');
  assert.equal(singleBot.stepEffort(lowRoute, 1)?.id, 'codex:gpt-6-sol:low', 'clamps Auto Advisor to sole usable effort instead of null');
});

test('autoEffortMode and parseAutoEffort round-trip native providers', () => {
  assert.deepEqual(parseAutoEffort(autoEffortMode('native:antigravity', 'gemini-4-neon')), { provider: 'native:antigravity', model: 'gemini-4-neon' });
  assert.deepEqual(parseAutoEffort(autoEffortMode('native:muse', 'muse-1')), { provider: 'native:muse', model: 'muse-1' });
  assert.deepEqual(parseAutoEffort(autoEffortMode('openrouter', 'openai/gpt-4:free')), { provider: 'openrouter', model: 'openai/gpt-4:free' });
  assert.deepEqual(parseAutoEffort(autoEffortMode('codex', 'gpt-6-sol')), { provider: 'codex', model: 'gpt-6-sol' });
  assert.equal(parseAutoEffort('autoeffort:native:antigravity'), null);
  assert.equal(parseAutoEffort('autoeffort:native:antigravity:'), null);
});
