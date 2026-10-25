// Real renderer/preload/IPC/runner/controller path; only provider I/O is simulated.
module.exports = async function groupChatUiCheck(window, root, ipcMain) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs'), path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { randomUUID } = require('node:crypto');
  const { Controller } = require('../src/controller.cjs');
  const { Agents } = require('../src/agents.cjs');
  const { registerRunnerCommands } = require('../src/runner-commands.cjs');
  const directory = path.join(root, 'group-roundtrip'); fs.mkdirSync(directory);
  let coordinatorCalls = 0;
  const until = async (check, label) => {
    const end = Date.now() + 5000;
    while (!await check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(await check(), label);
  };
  const factory = (file, cwd, options) => {
    const client = new EventEmitter(); client.close = () => {};
    client.calls = []; client.answers = [];
    const worker = new Controller(file, cwd, client, { cancel() {}, close() {}, complete() { coordinatorCalls++; throw new Error('Unexpected Hub review'); } }, options);
    worker.initialize = async () => {
      worker.connection = 'ready'; worker.account = { type:'chatgpt', plan:'pro' };
      worker.models = [{ model:'gpt-5.6-terra', supportedReasoningEfforts:[{reasoningEffort:'low'}] }];
    };
    client.respond = (id, result) => client.answers.push({ id, result });
    client.call = async (method, params) => {
      client.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: randomUUID() } };
      if (method === 'turn/start') return { turn: { id: randomUUID() } };
      if (method === 'thread/items/list') return { data:[] };
      if (method === 'turn/interrupt') worker.notification({ method:'turn/completed', params:{ threadId:params.threadId, turn:{ id:params.turnId, status:'interrupted' } } });
      return {};
    };
    return worker;
  };
  const hub = factory(path.join(directory, 'sessions.json'), directory);
  const mode = 'codex:gpt-5.6-terra:low';
  Object.assign(hub.data.settings, { mode, access:'read-only', chatScan:false });
  await hub.initialize();
  const agents = new Agents(hub, async () => {}, factory);
  try {
    agents.conversation(hub, true, directory, 'read-only');
    const bot = await agents.saveAgent({ name:'Reply bot', instructions:'Reply to the group.', workspace:directory, access:'read-only', mode });
    const group = agents.saveGroup({ name:'Group round trip', members:[bot.id] });
    group.items.push({ id:randomUUID(), type:'userMessage', content:[{type:'text', text:'UI_SHARED_CONTEXT'}] });
    const handlers = new Map();
    registerRunnerCommands((name, handler) => handlers.set(name, handler), { runner:{ controller:hub, agents, updater:{state:{}} }, normalizeImage:async value => value });
    for (const name of ['bootstrap', 'load', 'send', 'stop', 'answer', 'replySuggestion']) {
      ipcMain.removeHandler(name); ipcMain.handle(name, async (_event, ...args) => {
        const result = await handlers.get(name)(...args);
        // The desktop command adapter returns fleet state for controller snapshots.
        return result?.sessions && result?.settings ? agents.snapshot() : result;
      });
    }
    agents.on('state', state => window.webContents.send('state', state));
    const js = code => window.webContents.executeJavaScript(code);
    await js(`applyState(${JSON.stringify(agents.snapshot())}); selectAgent('main', ${JSON.stringify(group.id)})`);
    const send = async text => {
      const composer = await js(`document.querySelector('#prompt').value=${JSON.stringify(text)};
        document.querySelector('#prompt').dispatchEvent(new Event('input', {bubbles:true}));
        ({disabled:document.querySelector('#send').disabled, selectedId, selectedAgent, mode:currentMode(),
          connection:state.connection, readOnly:readOnlyNote(), submitting, readingImages, changingPermissions})`);
      assert.equal(composer.disabled, false, JSON.stringify(composer));
      assert.equal(composer.mode, mode, 'the fixture selects a current model ID');
      await js('document.querySelector("#send").click(); true');
    };
    await send('@Reply bot Explain the shared context.');
    await until(() => agents.executions.get(bot.id)?.activeTurns.size, 'renderer submission starts the addressed worker').catch(async error => {
      console.error('Group submission:', JSON.stringify({ status:group.status, error:group.error, turn:group.groupTurn,
        renderer:await js('({selectedId, selectedAgent, prompt:document.querySelector("#prompt").value, error:state.error, notice:document.querySelector("#toast").textContent})') }));
      throw error;
    });
    const worker = agents.execution(bot.id), work = worker.session(worker.busy);
    group.routes.push(hub.resolveWorker(mode)); // A preceding Main turn must not restart inference after the member replies.
    assert.doesNotMatch(worker.client.calls.find(call => call.method === 'thread/start').params.developerInstructions, /UI_SHARED_CONTEXT/);
    assert.match(worker.client.calls.find(call => call.method === 'turn/start').params.input[0].text, /UI_SHARED_CONTEXT/);
    assert.doesNotMatch(worker.client.calls.find(call => call.method === 'turn/start').params.input[0].text, /Reply here as yourself|Do not delegate merely/);
    worker.client.emit('request', { id:'group-ui-question', method:'item/tool/requestUserInput', params:{ threadId:work.threadId, turnId:work.turnId,
      questions:[{ id:'scope', question:'Which scope?', options:[] }] } });
    await until(() => js('document.querySelector("#request-dialog").open'), 'worker question reaches the renderer');
    await js(`document.querySelector('#request-content input').value='Current group';
      [...document.querySelectorAll('#request-content button')].find(button=>button.textContent==='Send answers').click(); true`);
    await until(() => worker.client.answers.length, 'renderer answer reaches the same native worker');
    assert.deepEqual(worker.client.answers[0], { id:'group-ui-question', result:{answers:{scope:{answers:['Current group']}}} });
    worker.notification({ method:'item/completed', params:{ threadId:work.threadId, turnId:work.turnId,
      item:{ id:randomUUID(), type:'agentMessage', phase:'final_answer', text:'The group context arrived through the real runner.' } } });
    await until(() => js('document.querySelector("#messages").textContent.includes("The group context arrived through the real runner.")'), 'native reply streams back to the renderer');
    assert.equal(worker.busy, work.id);
    worker.notification({ method:'turn/completed', params:{threadId:work.threadId, turn:{id:work.turnId, status:'completed'}} });
    await until(() => !agents.groupRuns.size, 'group reply finishes');
    assert.equal(group.items.some(item => item.type === 'agentResult'), false);
    assert.equal(await handlers.get('replySuggestion')(group.id), null);
    await send('@Reply bot Start a second reply.');
    await until(() => worker.activeTurns.size, 'the second reply starts');
    await until(() => js('!document.querySelector("#stop").hidden'), 'Stop is visible');
    await js('document.querySelector("#stop").click(); true');
    await until(() => !agents.groupRuns.size, 'renderer Stop reaches the running worker');
    assert.equal(group.status, 'interrupted');
    assert.equal(worker.client.calls.filter(call => call.method === 'turn/interrupt').length, 1);
    assert.equal(coordinatorCalls, 0, 'direct replies never call Main for review or suggestions');
    console.log('Group renderer → preload → IPC → runner → worker round trip, scoped question and Stop passed');
  } finally {
    await agents.shutdown({ stopMs:1000 });
  }
};
