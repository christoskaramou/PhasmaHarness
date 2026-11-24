'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { generatedImageUrl, withoutImages } = require('../src/image-input.cjs');
const { Controller } = require('../src/controller.cjs');
const { describe } = require('../src/activity-log.cjs');
const { conversationMarkdown } = require('../src/conversation-export.cjs');

// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
// Minimal valid JPEG/WebP/GIF headers
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]).toString('base64');
const WEBP_B64 = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 \x00\x00\x00\x00', 'binary').toString('base64');
const GIF_B64 = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary').toString('base64');

class FakeCodex extends EventEmitter {
  constructor() { super(); this.seq = 0; }
  async start() {}
  async call(method, params) {
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return {
      data: [{ model: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }],
    };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || 'thread-img' } };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: `turn-${++this.seq}` } };
    return {};
  }
  respond() {}
  rejectRequest() {}
  close() {}
}

test('generatedImageUrl validates PNG, JPEG, WebP, GIF and data URLs, and rejects non-image strings', () => {
  assert.equal(generatedImageUrl(PNG_B64), `data:image/png;base64,${PNG_B64}`);
  assert.equal(generatedImageUrl(JPEG_B64), `data:image/jpeg;base64,${JPEG_B64}`);
  assert.equal(generatedImageUrl(WEBP_B64), `data:image/webp;base64,${WEBP_B64}`);
  assert.equal(generatedImageUrl(GIF_B64), `data:image/gif;base64,${GIF_B64}`);
  assert.equal(generatedImageUrl(`data:IMAGE/PNG;base64,${PNG_B64}\n`), `data:image/png;base64,${PNG_B64}`);
  assert.equal(generatedImageUrl(''), null);
  assert.equal(generatedImageUrl(Buffer.from('not an image payload at all').toString('base64')), null);
  assert.equal(generatedImageUrl('data:text/html;base64,PHNjcmlwdD4='), null);
});

test('withoutImages strips non-empty imageGeneration.result while keeping empty in-progress result', () => {
  const done = { id: 'ig-1', type: 'imageGeneration', status: 'completed', result: PNG_B64, revisedPrompt: 'Labrador' };
  const stripped = withoutImages(done);
  assert.equal(stripped.result, null);
  assert.equal(stripped.revisedPrompt, 'Labrador');
  assert.equal(done.result, PNG_B64);

  const running = { id: 'ig-2', type: 'imageGeneration', status: 'in_progress', result: '' };
  assert.equal(withoutImages(running), running);
});

test('Codex imageGeneration items stream through Controller, strip base64 in snapshots, and serve via Controller.image', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-imggen-'));
  const workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fake = new FakeCodex();
  const smartRouter = { calls: [], cancel() {}, close() {}, jev: null, async choose() { throw new Error('unexpected route'); } };
  const controller = new Controller(path.join(dir, 'state.json'), workspace, fake, smartRouter);
  controller.claude.refresh = async () => controller.claude.status;
  controller.cursor.refresh = async () => controller.cursor.status;
  controller.readMessage = () => Promise.resolve(null);
  t.after(() => controller.close());
  await controller.initialize();

  const session = controller.create();
  await controller.send({ id: session.id, text: 'draw a labrador', mode: 'codex:gpt-5.6-sol:low' });

  // 1. item/started (in_progress)
  fake.emit('notification', {
    method: 'item/started',
    params: {
      threadId: session.threadId,
      turnId: 'turn-1',
      item: { id: 'ig-1', type: 'imageGeneration', status: 'in_progress', revisedPrompt: null, failure: null, generationId: null, result: '' },
    },
  });
  let snapItem = controller.snapshot().sessions.find(s => s.id === session.id).items.find(i => i.id === 'ig-1');
  assert.ok(snapItem, 'imageGeneration item is visible');
  assert.equal(snapItem.status, 'in_progress');
  assert.equal(snapItem.hasImage, false);
  assert.throws(() => controller.image(session.id, 'ig-1', 0), /no longer available/);

  // 2. item/completed (completed with raw base64 PNG + savedPath)
  fake.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: session.threadId,
      turnId: 'turn-1',
      item: {
        id: 'ig-1',
        type: 'imageGeneration',
        status: 'completed',
        revisedPrompt: 'A smiling golden Labrador Retriever outdoors',
        savedPath: path.join(workspace, 'labrador.png'),
        failure: null,
        generationId: 'gen-123',
        result: PNG_B64,
      },
    },
  });
  snapItem = controller.snapshot().sessions.find(s => s.id === session.id).items.find(i => i.id === 'ig-1');
  assert.equal(snapItem.status, 'completed');
  assert.equal(snapItem.result, null, 'base64 result is stripped from snapshots');
  assert.equal(snapItem.hasImage, true, 'snapshot indicates image is fetchable');
  assert.equal(snapItem.revisedPrompt, 'A smiling golden Labrador Retriever outdoors');
  assert.equal(snapItem.savedPath, path.join(workspace, 'labrador.png'));
  assert.equal(controller.image(session.id, 'ig-1', 0), `data:image/png;base64,${PNG_B64}`);

  // 3. item/completed (failed with usageLimitExceeded)
  fake.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: session.threadId,
      turnId: 'turn-1',
      item: {
        id: 'ig-2',
        type: 'imageGeneration',
        status: 'failed',
        revisedPrompt: null,
        failure: { type: 'usageLimitExceeded', limitId: 'image_gen', resetsAt: 1795450000 },
        generationId: null,
        result: '',
      },
    },
  });
  const failedItem = controller.snapshot().sessions.find(s => s.id === session.id).items.find(i => i.id === 'ig-2');
  assert.equal(failedItem.hasImage, false);
  assert.equal(failedItem.failure.type, 'usageLimitExceeded');

  // 4. Activity log and Markdown export omit raw base64
  const stored = session.items.find(i => i.id === 'ig-1');
  const [kind, text] = describe(stored, 'Hub');
  assert.equal(kind, 'Image generation [completed]');
  assert.match(text, /smiling golden Labrador/);
  assert.doesNotMatch(text, /iVBORw0KGgo/);

  const md = conversationMarkdown(session);
  assert.match(md, /## Generated image/);
  assert.match(md, /smiling golden Labrador/);
  assert.match(md, /Image generation limit reached/);
  assert.doesNotMatch(md, /iVBORw0KGgo/);
});
