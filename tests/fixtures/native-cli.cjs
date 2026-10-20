const { EventEmitter } = require('node:events');
const { PassThrough, Readable, Writable } = require('node:stream');
const fs = require('node:fs');
const { DeepSeekCLI } = require('../../src/providers/deepseek.cjs');
const { MuseCLI } = require('../../src/providers/muse.cjs');
const { AntigravityCLI } = require('../../src/providers/antigravity.cjs');
const path = require('node:path');

const deepseekConfig = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'model-a',
  options: [{ value: 'model-a', name: 'Model A' }] }];

async function deepseekFixture(t, options = {}) {
  const { AgentSideConnection, ndJsonStream } = await import('@agentclientprotocol/sdk');
  const calls = [], children = [];
  const launch = (_command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0; child.stdin.end(); child.stdout.end(); child.stderr.end();
      child.emit('exit', 0); child.emit('close', 0);
    };
    children.push({ child, args, options: spawnOptions });
    if (options.spawnError) throw options.spawnError;
    const stream = ndJsonStream(Writable.toWeb(child.stdout), Readable.toWeb(child.stdin));
    let helpers;
    const rpc = new AgentSideConnection(connection => ({
      async initialize(params) {
        calls.push(['initialize', params]);
        return { protocolVersion: options.protocol || 1, agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
          agentCapabilities: { sessionCapabilities: { close: {}, list: {}, ...(options.resume === false ? {} : { resume: {} }) },
            promptCapabilities: { image: options.images !== false } }, authMethods: [] };
      },
      async newSession(params) {
        calls.push(['newSession', params]);
        helpers = params.mcpServers?.find(server => server.name === 'phasma_harness');
        return { sessionId: '00000000-0000-4000-8000-000000000001', configOptions: deepseekConfig };
      },
      async resumeSession(params) {
        calls.push(['resumeSession', params]);
        helpers = params.mcpServers?.find(server => server.name === 'phasma_harness');
        return { configOptions: deepseekConfig };
      },
      async setSessionConfigOption(params) { calls.push(['config', params]); return { configOptions: deepseekConfig }; },
      async prompt(params) {
        calls.push(['prompt', params]);
        if (options.permission) {
          await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1',
            title: 'bash', kind: 'other', status: 'in_progress', ...(options.noRawInput ? {} : { rawInput: { command: 'build' } }) } });
          const permission = await connection.requestPermission({ sessionId: params.sessionId, toolCall: { toolCallId: 'tool-1' },
            options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }] });
          calls.push(['permission', permission]);
        }
        if (options.wait) return new Promise(() => {});
        const answer = await options.onPrompt?.({ params, helpers });
        await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_REASONING' } } });
        for (const text of answer === undefined ? options.text || ['Hello ', 'world'] : [answer]) await connection.sessionUpdate({ sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
        return { stopReason: options.stopReason || 'end_turn' };
      },
      async cancel(params) { calls.push(['cancel', params]); },
    }), stream);
    rpc.closed.catch(() => {});
    return child;
  };
  const backend = new DeepSeekCLI(launch, () => ({ command: 'dsh-fixture', args: [] }));
  t.after(() => backend.close());
  return { backend, calls, children };
}

async function museFixture(t, options = {}) {
  const { EXPECTED_SCHEMA_FINGERPRINT } = await import('@muse-code/sdk');
  const calls = [], children = [];
  const launch = (_command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.stdin.end(); child.stdout.end(); child.stderr.end();
      child.emit('exit', 0); child.emit('close', 0);
    };
    children.push({ child, args, options: spawnOptions });
    const send = message => child.stdout.write(JSON.stringify(message) + '\n');
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params: { sessionId: 'session-1', viewCursor: 'cursor', ...params } });
    let helpers, activeTurn = null;
    const acks = new Map();
    const finishTurn = (turnId, text = 'Hello world') => {
      if (child.exitCode !== null) return;
      const itemId = options.onPrompt || options.live ? `answer-${turnId}` : 'answer';
      notify('item/completed', { item: { itemId: 'private', turnId, kind: 'reasoning', revision: 1, status: 'completed', text: 'PRIVATE_REASONING' } });
      notify('item/started', { item: { itemId, turnId, kind: 'agentMessage', revision: 1, status: 'inProgress', text: text.slice(0, 5) } });
      notify('item/delta', { itemId, field: 'text', delta: text.slice(5) });
      notify('item/completed', { item: { itemId, turnId, kind: 'agentMessage', revision: 2, status: 'completed', text } });
      for (const usage of options.tokenEvents || []) notify('session/tokenUsage', { turnId, ...usage });
      notify('turn/completed', { turnId, terminal: options.terminal || 'completed', ...(options.usage ? { usage: options.usage } : {}),
        ...(options.turnError ? { reason: options.turnError, error: { kind: 'modelError', message: options.turnError, retryable: false } } : {}) });
    };
    let pending = '';
    child.stdin.on('data', data => {
      pending += data;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const request = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        calls.push([request.method, request.params]);
        if (request.id === undefined) continue;
        const p = request.params;
        let result = {};
        if (request.method === 'initialize') result = { schema: { version: 1, fingerprint: options.fingerprint || EXPECTED_SCHEMA_FINGERPRINT },
          serverInfo: { name: 'muse', version: '1.4.10' }, experimentalApi: true, grantedCapabilities: ['sessionMcp'],
          sessionDurability: 'durable', sandboxAvailability: options.sandbox || 'available' };
        if (request.method === 'model/list') result = { profileId: options.catalogProfile || null, models: options.authError ? [] : [{ modelId: 'model-a', providerId: 'meta', profileId: options.catalogProfile || null,
          displayLabel: 'Muse A', reasoningEffortVariants: [{ tier: 'high', label: 'High' }] }] };
        if (request.method === 'account/read') result = options.account || { state: 'loggedOut', credentialRequired: true };
        if (request.method === 'permissionProfile/list') result = { profiles: [':read-only', ':ask-me', ':unrestricted'].map(profileId => ({ profileId, available: true })) };
        if (request.method === 'session/start' || request.method === 'session/resume') {
          helpers = p.config?.mcpServers?.phasma_harness;
          result = { session: {
            sessionId: 'session-1', activeTurnId: null, permissionState: { profileId: options.profile || p.permissionProfile, reviewerAuthority: 'human' } },
            viewCursor: 'cursor' };
        }
        // Like Muse, a turn/start re-sent under its original commandId gets the original answer and starts nothing.
        if (request.method === 'turn/start' && acks.has(p.commandId)) {
          send({ jsonrpc: '2.0', id: request.id, result: acks.get(p.commandId) });
          continue;
        }
        // live: the first turn stays open; a steer lands in it (same turnId), a queued message runs as a second turn after it.
        if (request.method === 'turn/start' && options.live && activeTurn) {
          const current = activeTurn;
          activeTurn = null;
          if (p.ifBusy === 'steer') {
            acks.set(p.commandId, { commandId: p.commandId, disposition: 'steered', startedNewTurn: false, status: 'accepted', turnId: current });
            send({ jsonrpc: '2.0', id: request.id, result: acks.get(p.commandId) });
            setImmediate(() => finishTurn(current, 'Steered answer'));
          } else {
            acks.set(p.commandId, { commandId: p.commandId, disposition: 'queued', startedNewTurn: false, status: 'accepted', turnId: p.commandId });
            send({ jsonrpc: '2.0', id: request.id, result: acks.get(p.commandId) });
            setImmediate(() => {
              // liveFailFirst: the running turn fails after the queued message was acknowledged; the queued turn never runs.
              if (options.liveFailFirst) {
                notify('turn/completed', { turnId: current, terminal: 'failed', reason: 'Model unavailable', error: { kind: 'modelError', message: 'Model unavailable', retryable: false } });
                return;
              }
              finishTurn(current, 'First answer');
              notify('turn/started', { turnId: p.commandId, commandId: p.commandId });
              finishTurn(p.commandId, 'Queued answer');
            });
          }
          continue;
        }
        if (request.method === 'turn/start') {
          const turnId = p.commandId;
          result = { commandId: p.commandId, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId };
          acks.set(p.commandId, result);
          notify('turn/started', { turnId });
          if (options.live) {
            activeTurn = turnId;
            send({ jsonrpc: '2.0', id: request.id, result });
            continue;
          }
          if (options.onPrompt) {
            send({ jsonrpc: '2.0', id: request.id, result });
            Promise.resolve().then(() => options.onPrompt({ params: p, helpers }))
              .then(text => finishTurn(turnId, text)).catch(error => child.emit('error', error));
            continue;
          }
          if (!options.wait) {
            finishTurn(turnId);
          }
        }
        send({ jsonrpc: '2.0', id: request.id, result });
      }
    });
    return child;
  };
  const backend = new MuseCLI(launch, () => ({ command: 'muse-fixture', args: [] }));
  t.after(() => backend.close());
  return { backend, calls, children };
}

async function antigravityFixture(t, options = {}) {
  const calls = [], children = [];
  const launch = (_command, args, spawnOptions) => {
    if (options.spawnError) throw options.spawnError;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    const send = value => child.stdout.write(JSON.stringify(value) + '\n');
    child.kill = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0; child.stdin.end(); child.stdout.end(); child.stderr.end();
      child.emit('exit', 0); child.emit('close', 0);
    };
    const record = { child, args, options: spawnOptions };
    children.push(record);
    if (!args.includes('--agent')) {
      queueMicrotask(() => {
        if (args[0] === 'models') child.stdout.write(options.models || 'gemini-fixture-high\tFixture model\n');
        else child.stdout.write(JSON.stringify({ status: options.authError ? 'ERROR' : 'SUCCESS', command: '/usage' }) + '\n');
        child.kill();
      });
      return child;
    }
    const name = args[args.indexOf('--agent') + 1];
    record.file = path.join(spawnOptions.cwd, '.agents', 'agents', name + '.md');
    record.definition = fs.readFileSync(record.file, 'utf8');
    record.config = Object.fromEntries(record.definition.split('\n').slice(1, -3).filter(line => line && line !== '---')
      .map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon), JSON.parse(line.slice(colon + 1))]; }));
    record.sessionId = options.foreignResume ? 'unrelated' : args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'agy-fixture-session';
    const step = value => send({ event: 'step_update', step_update: { conversation_id: record.sessionId, ...value } });
    let buffer = '';
    child.stdin.on('data', text => {
      buffer += text;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        calls.push(request);
        if (options.wait) continue;
        Promise.resolve().then(async () => {
          const config = record.config.mcpServers[0];
          const helpers = config && { ...config, env: { ...spawnOptions.env, ...config.env } };
          const answer = await options.onPrompt?.({ helpers, request, record, step });
          if (options.exitEarly) return child.kill();
          if (options.raw) return child.stdout.write(options.raw);
          step({ step_index: 1, state: 'DONE', step_type: 'private_reasoning', text_delta: 'PRIVATE_REASONING' });
          step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello ' });
          step({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'world' });
          step({ step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool',
            tool_info: { parameters: { name: 'agents_list' }, output: 'helper receipt' } });
          send({ event: 'result', result: { conversation_id: options.foreignResult ? 'unrelated' : record.sessionId,
            status: options.resultStatus || 'SUCCESS', error: options.resultError,
            response: answer === undefined ? 'Hello world' : answer, num_turns: args.includes('--conversation') ? 2 : 1,
            usage: options.usage || { input_tokens: 10, output_tokens: 3, thinking_tokens: 2, cache_read_tokens: 5 } } });
          if (options.afterResult) child.stdout.write(options.afterResult);
        }).catch(error => { child.emit('error', error); child.kill(); });
      }
    });
    queueMicrotask(() => send({ event: 'init', conversation_id: record.sessionId,
      init: { agent: options.wrongAgent ? 'unrelated' : name, permission_mode: options.permissionMode || 'always-proceed' } }));
    return child;
  };
  const backend = new AntigravityCLI(launch, () => ({ command: 'agy-fixture', args: [] }));
  t.after(() => backend.close());
  return { backend, calls, children };
}

module.exports = { deepseekFixture, museFixture, antigravityFixture };
