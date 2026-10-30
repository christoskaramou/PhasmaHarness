const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { JevClient } = require('../src/providers/jev.cjs');
const { imageNotes, imageNumbers, imageTool } = require('../src/tools/image-tools.cjs');
const { TOOLS: AGENT_TOOLS } = require('../src/tools/agent-tools.cjs');
const { MCP_TOOLS } = require('../src/tools/router-bridge.cjs');

// The real bridge and MCP child, as Claude, Codex, Cursor and the native CLIs start them.
test('image_read reaches CLI workers over the phasma_harness MCP as image content, not JSON text', async t => {
  const { spawn } = require('node:child_process');
  const { createInterface } = require('node:readline');
  const { RouterBridge } = require('../src/tools/router-bridge.cjs');
  const shown = { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: 'Image 1' }] };
  const bridge = new RouterBridge(async (_session, tool) => tool === 'image_read' ? shown : { other: true });
  await bridge.start();
  t.after(() => bridge.close());
  const config = bridge.childConfig('chat');
  const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  const replies = new Map();
  createInterface({ input: child.stdout }).on('line', line => { const reply = JSON.parse(line); replies.set(reply.id, reply.result); });
  child.stdin.write([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'image_read', arguments: { image: 1 } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'image_list', arguments: {} } }].map(message => JSON.stringify(message) + '\n').join(''));
  for (let i = 0; i < 250 && replies.size < 3; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(replies.get(2), shown);
  assert.deepEqual(replies.get(3), { content: [{ type: 'text', text: '{"other":true}' }], isError: false }, 'other tools stay JSON text');
});

const png = (width, height) => 'data:image/png;base64,' + createCanvas(width, height).encodeSync('png').toString('base64');

// 2026-10-30: the user asked that agents ask Jev yes/no questions about chat images, and read the image only when Jev is unsure.
test('image_ask sends a chat image by its number to Jev, fitted once, as yes, no or unsure; image_read shows it only to a model that can see', async () => {
  const requests = [];
  const jev = new JevClient({ configured: true, read: () => 'key' }, async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push({ headers: request.headers, body });
    const yes = [0.97, 0.04, 0.5];
    return { ok: true, text: async () => JSON.stringify({ model: 'jev-1.14.0', usage: { input_tokens: 9, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(body.questions).map((id, index) => [id, { type: 'noul', noul: yes[index] }])) }) };
  });
  const wide = png(2000, 1000), small = png(400, 300);
  const session = { items: [
    { id: 'first', type: 'userMessage', createdAt: 1, content: [{ type: 'text', text: 'Two screenshots' }, { type: 'image', url: wide }, { type: 'image', url: null }] },
    { id: 'reply', type: 'agentMessage', text: 'Looking.' },
    { id: 'second', type: 'userMessage', createdAt: 2, content: [{ type: 'text', text: 'And this one' }, { type: 'image', url: small }] }] };
  assert.deepEqual((await imageTool(jev, session, 'image_list', {})).map(entry => [entry.image, entry.message]),
    [[1, 'Two screenshots'], [2, 'Two screenshots'], [3, 'And this one']], 'an unavailable image keeps its number');

  const asked = await imageTool(jev, session, 'image_ask', { image: 1, questions: ['Is an error shown?', 'Is it blue?', 'Is it late?'] });
  assert.deepEqual(asked.answers.map(entry => entry.answer), ['yes', 'no', 'unsure']);
  assert.match(asked.note, /unsure/);
  const [sent] = requests;
  assert.equal(sent.headers['TypeSafe-Danger-Zone-Images'], 'true');
  const [ref] = Object.keys(sent.body.assets);
  assert.equal(sent.body.state.image, ref);
  assert.deepEqual(Object.values(sent.body.questions).map(question => question.type), ['noul', 'noul', 'noul'], 'one request for every question');
  const fitted = await loadImage(Buffer.from(sent.body.assets[ref].data_base64, 'base64'));
  assert.deepEqual([fitted.width, fitted.height], [1568, 784]);

  const latest = await imageTool(jev, session, 'image_ask', { questions: ['Is it a chart?'] });
  assert.equal(latest.image, 3, 'the latest image by default');
  assert.equal((await imageTool(jev, session, 'image_read', { image: null })).content[1].text, 'Image 3', 'null, as strict schemas send it, means the latest');
  assert.equal(latest.note, undefined);
  assert.equal(Object.values(requests[1].body.assets)[0].data_base64, small.split(',')[1]);

  await assert.rejects(imageTool(jev, session, 'image_ask', { image: 2, questions: ['Is it red?'] }), /no longer available/);
  await assert.rejects(imageTool(jev, session, 'image_ask', { image: 4, questions: ['Is it red?'] }), /from 1 to 3/);
  await assert.rejects(imageTool(jev, session, 'image_ask', { questions: [] }), /1 to 8/);
  await assert.rejects(imageTool({ configured: false }, session, 'image_ask', { questions: ['Is it red?'] }), /not set up/);
  await assert.rejects(imageTool(jev, { items: [] }, 'image_ask', { questions: ['Is it red?'] }), /No image/);
  assert.equal(requests.length, 2, 'rejected calls never reach Jev');

  // image_read shows the original image, never to a model that cannot see images, and never asks Jev.
  assert.deepEqual(await imageTool(jev, session, 'image_read', { image: 3 }),
    { content: [{ type: 'image', data: small.split(',')[1], mimeType: 'image/png' }, { type: 'text', text: 'Image 3' }] });
  assert.equal((await imageTool({ configured: false }, session, 'image_read', {})).content[0].data, small.split(',')[1], 'the latest image, with or without Jev');
  await assert.rejects(imageTool(jev, { ...session, routes: [{ images: false }] }, 'image_read', { image: 1 }), /cannot see images/);
  await assert.rejects(imageTool(jev, session, 'image_read', { image: 1, questions: ['Is it red?'] }), /only an image number/);
  assert.equal(requests.length, 2);

  // History a model reads names each earlier image by its number, so it can ask about it later.
  const { handoff } = require('../src/providers/claude.cjs');
  assert.match(handoff(session.items, undefined, imageNumbers(session)), /Two screenshots\\n\[Image 1 attached\]\\n\[Image 2 attached\]".*And this one\\n\[Image 3 attached\]/);
  assert.match(handoff(session.items), /Two screenshots\\n\[Earlier image attachment\]/, 'unchanged without Jev image assist');

  assert.equal(imageNotes(3, 1, false).trim(), '[Image 3 is attached, but you cannot see images. Ask Jev yes/no questions about it with the image_ask tool (image: 3).]');
  assert.equal(imageNotes(1, 2, true).trim(), '[Images 1 to 2 are attached but not shown, to save tokens. Ask Jev yes/no questions about them with image_ask (image: 1 to 2); read one with image_read only when Jev is unsure or you need more than a yes/no answer.]');
  for (const name of ['image_list', 'image_ask', 'image_read']) {
    assert.ok(AGENT_TOOLS.some(tool => tool.name === name), `${name} reaches Hub, Codex and API workers`);
    assert.ok(MCP_TOOLS.some(tool => tool.name === name), `${name} reaches CLI workers over MCP`);
  }
});
