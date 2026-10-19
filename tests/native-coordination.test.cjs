const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { deepseekFixture, museFixture, antigravityFixture } = require('./fixtures/native-cli.cjs');

class NoCodex extends EventEmitter {
  async start() { throw Object.assign(new Error('Codex is not installed.'), { code: 'ENOENT' }); }
  async call() { throw new Error('This round trip must stay on its native providers.'); }
  close() {}
}

function helper(helpers, name, args) {
  assert.ok(helpers, 'the native protocol must carry its own MCP configuration');
  const env = Array.isArray(helpers.env)
    ? Object.fromEntries(helpers.env.map(entry => [entry.name, entry.value])) : helpers.env;
  const child = spawn(helpers.command, helpers.args, {
    env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    let answer, failure;
    const timer = setTimeout(() => { failure = new Error('Fixture MCP call timed out.'); child.kill(); }, 5000);
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const response = JSON.parse(line);
        if (response.id !== 2) return;
        if (response.error || response.result?.isError) throw new Error(response.error?.message || response.result.content[0].text);
        answer = JSON.parse(response.result.content[0].text);
      } catch (error) { failure = error; }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code || answer === undefined) reject(failure || new Error(`Fixture MCP exited without a receipt (${code}).`));
      else resolve(answer);
    });
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'native-fixture', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    ].map(message => JSON.stringify(message) + '\n').join(''));
  });
}

async function until(check) {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(check(), 'native coordination did not settle');
}

for (const [workerId, workerFixture] of [['native:muse', museFixture], ['native:antigravity', antigravityFixture]]) {
  test(`DeepSeek Harness and ${workerId} coordinate through protocol fixtures and real MCP mailboxes without Codex or copied messages`, { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-coordination-'));
    let agents, primary, owner, accepted, question, builder, workerMode, ownerTurns = 0, workerTurns = 0;
    let answered;
    const answerSaved = new Promise(resolve => { answered = resolve; });
    const pool = [];
    for (let index = 0; index < 3; index++) {
      const deepseek = await deepseekFixture(t, { onPrompt: async ({ helpers, params }) => {
        assert.equal(index, 0, 'only the visible owner uses DeepSeek Harness in this scenario');
        ownerTurns++;
        if (ownerTurns === 1) {
          assert.match(JSON.stringify(params), /ATTACHMENT_EVIDENCE/);
          builder = await helper(helpers, 'agent_create', { name: 'Builder', instructions: 'Build one JSON artifact.', mode: workerMode });
          accepted = await helper(helpers, 'agent_delegate', { agentId: builder.id, task: 'Build one JSON artifact. Ask the owner which format to use.' });
          const foreign = { ...helpers, env: helpers.env.map(entry => entry.name === 'PHASMA_SESSION_ID'
            ? { ...entry, value: accepted.sessionId } : entry) };
          await assert.rejects(helper(foreign, 'agents_list', {}), /session|conversation/i);
          return 'The builder has the assignment.';
        }
        if (ownerTurns === 2) {
          await until(() => !!question);
          const receipt = await helper(helpers, 'agent_message', {
            agentId: builder.id, messageId: 'format-answer', kind: 'answer', replyTo: question.messageId, text: 'Use JSON.',
          });
          assert.equal(receipt.status, 'received');
          answered();
          return 'The builder has the format answer.';
        }
        assert.equal(ownerTurns, 3);
        assert.ok(owner.items.some(item => item.type === 'agentResult' && item.deliveryId === accepted.jobId));
        return 'The requested JSON artifact is ready.';
      } });
      const worker = await workerFixture(t, { onPrompt: async ({ helpers }) => {
        assert.equal(index, 2, 'delegated work uses the separate execution controller');
        workerTurns++;
        if (workerTurns === 1) {
          const context = await helper(helpers, 'agent_read_context', { agentId: 'main', query: 'ATTACHMENT_EVIDENCE' });
          assert.match(JSON.stringify(context), /ATTACHMENT_EVIDENCE/);
          question = await helper(helpers, 'agent_message', { agentId: 'main', messageId: 'format-question', kind: 'question', text: 'Which format?' });
          const retry = await helper(helpers, 'agent_message', { agentId: 'main', messageId: 'format-question', kind: 'question', text: 'Which format?' });
          assert.equal(retry.duplicate, true);
          await answerSaved;
          return 'The format is acknowledged.\n[task: pending]';
        }
        assert.equal(workerTurns, 2);
        return 'Built the requested JSON artifact.\n[task: done]';
      } });
      pool.push({ deepseek, worker });
    }
    const create = (file, cwd, options) => {
      const fixtures = pool.shift();
      assert.ok(fixtures, 'unexpected extra controller');
      const controller = new Controller(file, cwd, new NoCodex(), {
        cancel() {}, close() {}, async choose() { throw new Error('No routing inference is expected.'); },
      }, { ...options, nativeCLIs: new Map([['native:deepseek', fixtures.deepseek.backend], [workerId, fixtures.worker.backend]]) });
      controller.isCoordinator = () => false;
      controller.claude.refresh = async () => ({ installed: false, loggedIn: false });
      controller.cursor.refresh = async () => ({ installed: false, loggedIn: false });
      return controller;
    };
    primary = create(path.join(root, 'sessions.json'), root);
    primary.data.settings.deepseekEnabled = true;
    primary.data.settings.museEnabled = true;
    primary.data.settings.antigravityEnabled = true;
    agents = new Agents(primary, async () => {}, create);
    t.after(async () => {
      agents.closing = true;
      clearTimeout(agents.quotaTimer);
      for (const controller of agents.allControllers()) controller.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await primary.initialize();
    primary.data.settings.mode = primary.catalog().find(model => model.provider === 'native:deepseek' && model.worker).id;
    workerMode = primary.catalog().find(model => model.provider === workerId && model.worker).id;
    owner = primary.create(root, workerId === 'native:antigravity' ? 'danger-full-access' : 'workspace-write');
    await primary.send({ id: owner.id, text: 'Have a builder make one JSON artifact.',
      files: [{ name: 'request.md', text: 'ATTACHMENT_EVIDENCE: preserve this request.' }], mode: primary.data.settings.mode, task: 'off' });
    await until(() => ownerTurns === 3 && !primary.busy && !agents.pendingJobs().length && agents.backgroundSlots.size === 0);
    const execution = agents.owner(accepted.sessionId), work = execution.session(accepted.sessionId);
    assert.equal(workerTurns, 2);
    assert.equal(work.delegation.owner, owner.id);
    assert.equal(work.access, owner.access);
    assert.equal(work.delegation.delivered, true);
    assert.equal(owner.items.filter(item => item.type === 'agentResult' && item.deliveryId === accepted.jobId).length, 1);
    assert.equal(owner.items.filter(item => item.type === 'agentMail' && item.kind === 'question').length, 1);
    assert.ok(work.items.some(item => item.type === 'agentMail' && item.kind === 'answer' && item.replyTo === question.messageId));
    assert.equal(agents.controller(builder.id).busy, null);
    assert.equal(agents.backgroundSlots.size, 0);
    assert.doesNotMatch(JSON.stringify([owner.items, work.items]), /PRIVATE_REASONING|PHASMA_BRIDGE_TOKEN/);
  });
}
