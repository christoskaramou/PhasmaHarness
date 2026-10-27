// Opt-in account-backed test: node tests/group-chat-live.cjs --run [--round-only] [codex|cursor-cli ...]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { WikiStore } = require('../src/workspace/wiki-store.cjs');
const { registerRunnerCommands } = require('../src/runner-commands.cjs');

async function main() {
  assert.equal(process.argv[2], '--run', 'This test uses real provider accounts. Opt in with --run.');
  const roundOnly = process.argv.includes('--round-only');
  const providers = process.argv.slice(3).filter(arg => arg !== '--round-only');
  if (!providers.length) providers.push('codex');
  assert.ok(providers.every(id => ['codex', 'cursor-cli'].includes(id)), 'Choose codex or cursor-cli.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-group-live-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const rule = randomUUID();
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), `# Test project\n\nFor verification questions, the project rule code is ${rule}.\n`);
  const wikiStore = new WikiStore(path.join(root, 'AppData', 'Wikis'));
  const report = { root, results: [], log: [] };
  const log = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (message, data) => report.log.push({ level, message, data })]));
  const hub = new Controller(path.join(root, 'sessions.json'), workspace, undefined, undefined, { wikiStore });
  Object.assign(hub.data.settings, { mode: 'terra-light', access: 'read-only', chatScan: false, jevEnabled: false, jevCompare: false, toolSelection: 'off' });
  hub.log = log;
  let agents, timer;
  try {
    await hub.initialize();
    if (providers.includes('cursor-cli') && hub.cursor.status.loggedIn) {
      await hub.discoverCursor();
      const model = hub.cursor.models.find(item => item.id === 'composer-2.5') || hub.cursor.models.find(item => item.id !== 'default');
      if (model) hub.data.settings.providerModels = [{ id: 'cursor-cli:' + model.id, provider: 'cursor-cli', model: model.id, label: model.label,
        worker: true, enabled: true, rank: 1, parameterized: model.parameterized }];
    }
    agents = new Agents(hub, async worker => { worker.log = log; });
    hub.smartRouter.complete = async () => { throw new Error('Unexpected Main Bot inference during a direct group reply.'); };
    const commands = new Map();
    registerRunnerCommands((name, handler) => commands.set(name, handler), { runner: { controller: hub, agents, wikiStore, updater: { state: {} } }, normalizeImage: async value => value });
    const mainChat = agents.conversation(hub, true, workspace, 'read-only');
    const privateCode = randomUUID();
    mainChat.items.push({ id: randomUUID(), type:'userMessage', content:[{ type:'text', text:'Private Main code: ' + privateCode }] });
    const bots = [];
    for (const provider of providers) {
      const choices = hub.catalog().filter(choice => choice.provider === provider && hub.available(choice));
      const choice = choices.find(item => item.id === 'terra-light') || choices.find(item => /terra/.test(item.model) && item.effort === 'low') || choices[0];
      assert.ok(choice, `No connected model for ${provider}`);
      const bot = await agents.saveAgent({ name: provider === 'codex' ? 'Code bot' : 'Cursor bot', instructions: 'Answer the group verification question. Do not call tools, delegate, or edit files.',
        workspace, access: 'read-only', mode: choice.id });
      bots.push({ ...bot, choice });
    }
    const idle = await agents.saveAgent({ name: 'Idle bot', instructions: 'Wait until addressed.', workspace, access: 'read-only', mode: bots[0].choice.id });
    const group = await commands.get('saveGroup')({ name: 'Live verification', members: [...bots.map(bot => bot.id), idle.id] });
    assert.equal(agents.executions.size, 0);
    // A second turn checks that an existing native thread receives newly added group context.
    for (const bot of roundOnly ? [] : [...bots, ...bots]) {
      const code = randomUUID();
      group.items.push({ id: randomUUID(), type:'userMessage', content:[{ type:'text', text:'The current shared group code is ' + code }] });
      hub.save();
      const started = Date.now(), before = group.items.length;
      timer = setTimeout(() => commands.get('stop')(group.id).catch(error => log.error('Live test stop failed', { error: error.message })), 120000);
      console.log('START', bot.choice.provider, bot.choice.model);
      await commands.get('send')({ id: group.id, text:`@${bot.name} Return only JSON with group (current shared group code), and rule (project rule code). Use the provided context, with no tools or file changes.` });
      const run = agents.groupRuns.get(group.id);
      assert.ok(run);
      await run.operation;
      clearTimeout(timer);
      const reply = group.items.slice(before).filter(item => item.type === 'agentMessage' && item.phase !== 'commentary').map(item => item.text).join('\n');
      assert.equal(group.status, 'completed', group.error);
      assert.ok(reply.includes(code) && reply.includes(rule), 'Worker did not receive the current shared context and project entry.');
      assert.ok(!reply.includes(privateCode), 'Private Main context leaked.');
      assert.equal(agents.pendingJobs().length, 0);
      assert.equal(group.items.some(item => item.type === 'agentResult'), false);
      assert.equal(agents.executions.has(idle.id), false);
      assert.equal(hub.busy, null);
      report.results.push({ provider: bot.choice.provider, model: bot.choice.model, elapsedMs: Date.now() - started, reply, status:'passed' });
      console.log('PASS', bot.choice.provider, Date.now() - started, 'ms');
    }
    // Who replies: an unmentioned message goes to every ticked bot in order, and the second answers from the first's reply.
    if (bots.length > 1) {
      await commands.get('saveGroup')({ id: group.id, name: group.title, members: group.group.members, replyOrder: bots.map(bot => bot.id) });
      const code = randomUUID(), started = Date.now(), before = group.items.length;
      timer = setTimeout(() => commands.get('stop')(group.id).catch(error => log.error('Live test stop failed', { error: error.message })), 240000);
      console.log('START round', bots.map(bot => `${bot.name} (${bot.choice.provider} ${bot.choice.model})`).join(' -> '));
      await commands.get('send')({ id: group.id, text: `Who replies check ${code}. Return only JSON with bot (your name), round ("${code}"), ` +
        'word (one English word you choose), and previous_word (the word chosen by the bot that replied just before you in this round, or null if you reply first). ' +
        'Use the provided context, with no tools or file changes. There is nothing to debate: say you are done once you have replied.' });
      const run = agents.groupRuns.get(group.id);
      assert.ok(run, 'An unmentioned message did not start a Who replies round.');
      await run.operation;
      clearTimeout(timer);
      assert.equal(group.status, 'completed', group.error);
      const added = group.items.slice(before).filter(item => item.type === 'agentMessage' && item.phase !== 'commentary' && item.groupSpeaker);
      assert.deepEqual([...new Set(added.map(item => item.groupSpeaker.id))], bots.map(bot => bot.id), 'Bots did not reply once each, in order.');
      // Each bot's first-round reply; the discussion may run further rounds before everyone agrees.
      const replies = bots.map(bot => added.find(item => item.groupSpeaker.id === bot.id)?.text || '');
      assert.ok(group.items.some(item => item.groupDiscussion), 'The discussion did not end with a conclusion notice.');
      const answers = replies.map(text => JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || 'null'));
      assert.ok(answers.every(answer => answer?.round === code), 'A bot did not receive the round message.');
      assert.equal(answers[0].previous_word, null, 'The first bot invented an earlier reply.');
      for (let index = 1; index < answers.length; index++) {
        assert.equal(String(answers[index].previous_word).toLowerCase(), String(answers[index - 1].word).toLowerCase(), `${bots[index].name} did not see the reply before it.`);
      }
      assert.equal(agents.pendingJobs().length, 0);
      assert.equal(agents.executions.has(idle.id), false, 'An unticked member replied.');
      assert.equal(hub.busy, null);
      report.results.push({ round: true, elapsedMs: Date.now() - started, status: 'passed',
        replies: bots.map((bot, index) => ({ bot: bot.name, provider: bot.choice.provider, model: bot.choice.model, reply: replies[index] })) });
      for (const [index, bot] of bots.entries()) console.log(`REPLY ${index + 1} ${bot.name}: ${replies[index]}`);
      console.log('PASS round', Date.now() - started, 'ms');
    }
    const snapshot = commands.get('bootstrap')();
    assert.equal(snapshot.agentStates.main.sessions.find(chat => chat.id === group.id).items.filter(item => item.groupSpeaker).length >= report.results.length, true);
  } catch (error) { report.error = error.message; process.exitCode = 1; console.error(error.message); }
  finally {
    clearTimeout(timer);
    report.cleanup = agents ? await agents.shutdown({ stopMs: 10000 }) : await hub.shutdown();
    const file = path.resolve('.scratch/group-chat-live-report.json');
    fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log('REPORT', file);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
