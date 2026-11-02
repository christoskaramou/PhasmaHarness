// Auto's model swap question through the real renderer/preload/IPC/runner/controller path: an Auto bot on a weak model
// gets a hard task, the card shows its three answers, and clicking Create a new bot hands the task to a new bot on
// the suggested model, whose result comes back to the bot's chat. Only provider I/O and the router's picks are simulated.
module.exports = async function modelSwapUiCheck(window, root, ipcMain) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs'), path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { randomUUID } = require('node:crypto');
  const { Controller } = require('../src/controller.cjs');
  const { Agents } = require('../src/agents.cjs');
  const { registerRunnerCommands } = require('../src/runner-commands.cjs');
  const directory = path.join(root, 'swap-roundtrip'); fs.mkdirSync(directory);
  const until = async (check, label) => {
    const end = Date.now() + 5000;
    while (!await check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(await check(), label);
  };
  // Two measured models: weak (score 50, cheap) and strong (score 100).
  const preset = (model, effort) => ({ id: `codex:${model}:${effort}`, provider: 'codex', model, effort, label: `${model} · ${effort}`,
    worker: true, enabled: true, images: true, rank: 1, benchmarks: [{ source: 'aa-index', version: '4', harness: 'aa', score: model === 'weak' ? 50 : 100, costUsd: model === 'weak' ? 0.1 : 3 }] });
  const catalog = ['weak', 'strong'].flatMap(model => ['low', 'medium', 'high'].map(effort => preset(model, effort)));
  const picks = [];
  const pick = (id, difficulty) => ({ ...catalog.find(p => p.id === id), source: 'model', reason: 'Router fixture.', router: { evidence: { changedFiles: 0 } },
    assessment: { difficulty, taskKind: difficulty === 'high' ? 'audit' : 'lookup', workspaceRelevant: false, needsChecks: false, risk: 'low', uncertainty: 'low' } });
  const factory = (file, cwd, options) => {
    const client = new EventEmitter(); client.close = () => {}; client.calls = [];
    client.respond = () => {};
    client.call = async (method, params) => {
      client.calls.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || randomUUID() } };
      if (method === 'turn/start') return { turn: { id: randomUUID() } };
      if (method === 'thread/items/list') return { data: [] };
      return {};
    };
    const worker = new Controller(file, cwd, client, { cancel() {}, close() {}, async choose() { return picks.shift(); },
      complete() { throw new Error('Unexpected model call'); } }, options);
    worker.initialize = async () => {
      worker.connection = 'ready'; worker.account = { type: 'chatgpt', plan: 'pro' };
      worker.models = catalog.map(p => ({ model: p.model, supportedReasoningEfforts: [{ reasoningEffort: p.effort }] }));
    };
    worker.catalog = () => catalog;
    worker.available = () => true;
    worker.effectiveRouter = () => ({ id: 'router', provider: 'codex', model: 'router', effort: 'low' });
    return worker;
  };
  const turns = controller => controller.client.calls.filter(call => call.method === 'turn/start');
  const finish = (controller, text) => {
    const session = controller.session(controller.busy);
    controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: session.turnId,
      item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text } } });
    controller.notification({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: session.turnId, status: 'completed' } } });
  };

  const hub = factory(path.join(directory, 'sessions.json'), directory);
  Object.assign(hub.data.settings, { mode: 'codex:weak:low', access: 'read-only', chatScan: false, routing: 'smart' });
  await hub.initialize();
  const agents = new Agents(hub, async () => {}, factory);
  try {
    agents.conversation(hub, true, directory, 'read-only');
    const profile = await agents.saveAgent({ name: 'CardTest', instructions: 'Review code.', workspace: directory, access: 'read-only', mode: 'auto' });
    const bot = agents.controller(profile.id);
    await bot.initialize();
    agents.conversation(bot, true, directory, 'read-only'); // a new bot's chat, which selecting it opens
    const handlers = new Map();
    registerRunnerCommands((name, handler) => handlers.set(name, handler), { runner: { controller: hub, agents, updater: { state: {} } }, normalizeImage: async value => value });
    // The smoke test's own answerModelSwap stub goes: this one is the real runner command.
    for (const name of ['bootstrap', 'load', 'send', 'stop', 'answerModelSwap']) {
      ipcMain.removeHandler(name); ipcMain.handle(name, async (_event, ...args) => {
        const result = await handlers.get(name)(...args);
        return result?.sessions && result?.settings ? agents.snapshot() : result;
      });
    }
    agents.on('state', state => window.webContents.send('state', state));
    const js = code => window.webContents.executeJavaScript(code);
    await js(`applyState(${JSON.stringify(agents.snapshot())}); selectAgent(${JSON.stringify(profile.id)}).then(() => true)`);
    const send = async text => {
      const composer = await js(`document.querySelector('#prompt').value=${JSON.stringify(text)};
        document.querySelector('#prompt').dispatchEvent(new Event('input', {bubbles:true}));
        ({ disabled: document.querySelector('#send').disabled, mode: currentMode(), selectedAgent })`);
      assert.deepEqual([composer.disabled, composer.mode, composer.selectedAgent], [false, 'auto', profile.id], JSON.stringify(composer));
      await js('document.querySelector("#send").click(); true');
    };

    // The first task runs on the router's pick, the weak model, with no question.
    picks.push(pick('codex:weak:medium', 'medium'));
    await send('List the function names exported by src/routing/model-swap.cjs.');
    await until(() => turns(bot).length === 1 && bot.busy, 'the first task starts on the weak model').catch(async error => {
      const chat = agents.conversation(bot);
      console.error('First task:', JSON.stringify({ busy: bot.busy, status: chat?.status, error: chat?.error, pending: chat?.pendingMessage?.error, picks: picks.length,
        calls: bot.client.calls.map(call => call.method), executions: [...agents.executions.keys()], renderer: await js('({ selectedId, selectedAgent, error: state.error, toast: document.querySelector("#toast")?.textContent })') }));
      throw error;
    });
    assert.equal(turns(bot)[0].params.model, 'weak');
    finish(bot, 'evaluateSwap, evaluateReach.');
    await until(() => !bot.busy, 'the first task finishes');

    // A hard task: the card shows the three answers and what each does, and nothing starts meanwhile.
    picks.push(pick('codex:strong:high', 'high'));
    await send('Audit delegate() in src/agents.cjs for permission leaks.');
    await until(() => js('!!document.querySelector("#messages .model-swap")'), 'the swap question reaches the renderer');
    assert.deepEqual(await js(`[...document.querySelectorAll('#messages .model-swap button')].map(button => button.textContent)`),
      ['Create a new bot', 'Swap here', 'Keep current']);
    const options = await js(`[...document.querySelectorAll('#messages .model-swap li')].map(item => item.textContent)`);
    assert.match(options[0], /^Create a new bot: a new bot runs this task on strong · high\. This bot keeps weak · high and its whole conversation/);
    assert.match(options[1], /^Swap here: this bot switches to strong · high for this task and the next ones\. It keeps this conversation but loses the prompt cache/);
    assert.match(options[2], /^Keep current: this task runs on weak · high\./);
    assert.equal(turns(bot).length, 1, 'nothing starts while the question is open');

    // Clicking Create a new bot goes renderer → preload → IPC → runner → controller.
    await js(`document.querySelector('#messages .model-swap button').click(); true`);
    await until(() => agents.primary.data.agents.some(agent => agent.name === 'CardTest helper'), 'Create a new bot makes a bot');
    const helper = agents.primary.data.agents.find(agent => agent.name === 'CardTest helper');
    assert.deepEqual([helper.createdBy, helper.mode, helper.instructions], ['main', 'codex:strong:high', 'Review code.']);
    assert.equal(agents.isSubBot(helper), false, 'the new bot is top-level, not a sub-bot');
    await until(() => js('document.querySelector("#messages").textContent.includes("Sent this task to the new bot CardTest helper, which runs strong · high.")'),
      'the bot\'s chat says where the task went');
    await until(() => js(`[...document.querySelectorAll('#messages .routing-status')].some(line => line.textContent.startsWith('Model swap: kept weak · high; new bot CardTest helper runs strong · high') && line.textContent.endsWith('you chose Create a new bot'))`),
      'the decision shows in the chat');
    assert.equal(await js('!!document.querySelector("#messages .model-swap")'), false, 'the card is gone');
    assert.equal(turns(bot).length, 1, 'the bot itself sent nothing');
    const sub = agents.executions.get(helper.id) || agents.execution(helper.id);
    await until(() => turns(sub).length === 1 && sub.busy, 'the new bot starts the task');
    assert.equal(turns(sub)[0].params.model, 'strong');
    assert.match(turns(sub)[0].params.input[0].text, /Audit delegate\(\) in src\/agents\.cjs for permission leaks\./);

    // The new bot's result comes back to the bot's chat, which continues with it on its own model, without asking.
    picks.push(pick('codex:weak:medium', 'medium'));
    finish(sub, 'Audit done: no permission leaks found in delegate().');
    await until(() => turns(bot).length === 2 && bot.busy, 'the result comes back to the bot');
    assert.equal(turns(bot)[1].params.model, 'weak');
    assert.match(turns(bot)[1].params.input[0].text, /Result from agent "CardTest helper"[\s\S]*Audit done: no permission leaks found in delegate\(\)\./);
    finish(bot, 'The helper found no permission leaks.');
    await until(() => js('document.querySelector("#messages").textContent.includes("The helper found no permission leaks.")'), 'the bot\'s reply reaches the renderer');
    console.log('Model swap card → Create a new bot through the real renderer, preload, IPC and runner, with the result back in the bot\'s chat, passed');
  } finally {
    await agents.shutdown({ stopMs: 1000 });
  }
};
