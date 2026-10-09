// Electron + installed Codex, with a local Responses server; no login or model inference.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { CodexClient } = require('../src/providers/codex.cjs');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agent-tools-'));
process.env.CODEX_HOME = path.join(root, 'codex');
fs.mkdirSync(process.env.CODEX_HOME);
app.setPath('userData', path.join(root, 'electron'));
const client = new CodexClient(root);
const router = () => ({ cancel() {}, close() {} });
const primary = new Controller(path.join(root, 'sessions.json'), root, client, router());
const agents = new Agents(primary, async () => {}, (file, cwd, options) => {
  const workerClient = new EventEmitter(); workerClient.close = () => {};
  const worker = new Controller(file, cwd, workerClient, router(), options);
  worker.initialize = async () => { worker.connection = 'ready'; };
  return worker;
});
let received, finish, requests = 0;
const responseReceived = new Promise(resolve => { finish = resolve; });
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  received = JSON.parse(Buffer.concat(chunks).toString());
  requests++;
  const item = requests === 1
    ? { type: 'custom_tool_call', id: 'ctc_create', call_id: 'call_create', name: 'exec', namespace: 'functions', input: 'text(await tools.mcp__phasma_harness__agent_models({})); text(await tools.mcp__phasma_harness__agent_create({name:"Test211",instructions:"Wait for a task."}));' }
    : { type: 'message', id: 'msg_done', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Tool completed.', annotations: [] }] };
  const response = { id: `resp_${requests}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'gpt-6.1-sol', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end(); if (requests > 1) finish();
});
const deadline = setTimeout(() => { client.close(true); console.error('Agent tool smoke timed out'); app.exit(1); }, 40000);
app.whenReady().then(async () => {
  let window;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await primary.bridge.start(); await client.start();
    const config = { model_provider: 'smoke', 'model_providers.smoke': { name: 'Local smoke', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', requires_openai_auth: false } };
    primary.providers = { config: () => ({ modelProvider: 'smoke', config }) };
    primary.connection = 'ready';
    const old = await client.call('thread/start', { cwd: root, model: 'gpt-6.1-sol', modelProvider: 'smoke', config, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Old conversation instructions.' }, 15000);
    await client.call('thread/inject_items', { threadId: old.thread.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier conversation.' }] }] }, 15000);
    const session = agents.conversation(primary, true, root, 'read-only');
    session.threadId = old.thread.id;
    await primary.loadThread(session, { model: 'gpt-6.1-sol', effort: 'low' });
    ipcMain.handle('bootstrap', () => agents.snapshot());
    ipcMain.handle('preview', () => ({ label: 'Auto', reason: 'Local smoke' }));
    ipcMain.handle('appInfo', () => ({ version: '0.1.0', packaged: false }));
    ipcMain.handle('updateStatus', () => ({ status: 'idle' }));
    ipcMain.handle('load', () => session);
    ipcMain.handle('browseWorkspace', () => ({ available: false, entries: [] }));
    window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true } });
    agents.on('state', state => { if (!window.isDestroyed()) window.webContents.send('state', state); });
    await window.loadFile(path.resolve(__dirname, '../ui/index.html'));
    primary.busy = session.id; primary.activeTurns.set(session.id, 'smoke');
    const toolCalls = [], callTool = agents.tool.bind(agents);
    agents.tool = (...args) => { toolCalls.push(args[2]); return callTool(...args); };
    await client.call('turn/start', { threadId: session.threadId, input: [{ type: 'text', text: 'Create an agent named Test211.', text_elements: [] }], approvalPolicy: 'never' }, 15000);
    await responseReceived;
    const instructions = received.input.filter(item => item.role === 'developer').map(item => JSON.stringify(item.content)).join('\n');
    assert.match(instructions, /MUST call agent_create/);
    assert.match(instructions, /mcp__phasma_harness__agent_create/);
    assert.deepEqual(toolCalls, ['agent_models', 'agent_create']);
    assert.equal(primary.data.agents.length, 1, 'the real MCP call must persist a Harness agent');
    const profile = primary.data.agents[0];
    assert.equal(profile.name, 'Test211');
    assert.equal(profile.access, 'read-only');
    assert.equal(profile.mode, 'auto');
    assert.equal(profile.workspace, root);
    assert.equal(agents.controller(profile.id).busy, null);
    assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents[0].id, profile.id);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        const entry = [...document.querySelectorAll('#agent-list button[data-agent]')].find(button => button.dataset.agent === ${JSON.stringify(profile.id)});
        if (entry?.textContent.includes('Test211')) return resolve(true);
        if (++attempts > 100) return reject(new Error('Created agent did not reach the sidebar'));
        setTimeout(check, 20);
      }; check();
    })`);
    assert.equal(primary.requests.size, 0, 'local agent metadata tools must not require another approval');
    console.log('PASS: resumed Codex chat -> real MCP -> persisted Test211 -> sidebar; permissions inherited; local model mock only.');
  } finally {
    clearTimeout(deadline); agents.closing = true;
    await Promise.all(agents.initializing.values());
    for (const controller of agents.controllers.values()) controller.close();
    client.close(true); server.closeAllConnections(); server.close();
    window?.destroy();
  }
}).then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
