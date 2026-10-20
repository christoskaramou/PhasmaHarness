const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const { DocumentReader, MAX_SOURCE } = require('../src/documents.cjs');
const { pdf, docx, documentXml, memoryBombPdf } = require('./fixtures/documents.cjs');
const files = require('../ui/attachments.js');

test('PDF and DOCX read in a separate process and retain complete text or bounded XML without persisting originals', async t => {
  const reader = new DocumentReader(); t.after(() => reader.close());
  const result = await reader.read({ name: 'brief.pdf', bytes: pdf() });
  assert.deepEqual(result, { format: 'pdf', text: 'Build three small games.' });
  assert.equal(reader.busy, false);
  const word = await reader.read({ name: 'brief.docx', bytes: docx() });
  assert.equal(word.format, 'docx');
  assert.equal(word.parts[0].xml, documentXml);
  assert.equal(reader.busy, false);
  const attachment = { name: 'brief.pdf', text: result.text, format: result.format };
  const saved = files.prepare('Review it.', [attachment]);
  assert.deepEqual(files.unpack(saved.text, saved.fileMessage).files, [attachment]);
});

test('document inputs reject oversize sources, wrong types, corrupt archives, expanded zip bombs and empty PDFs', async t => {
  const reader = new DocumentReader(); t.after(() => reader.close());
  for (const value of [{ name: '../brief.pdf', bytes: pdf() }, { name: 'brief.pdf', bytes: new Uint8Array(MAX_SOURCE + 1) },
    { name: 'brief.pdf', bytes: strToU8('not a PDF') }, { name: 'brief.docx', bytes: pdf() }]) {
    await assert.rejects(reader.read(value));
    assert.equal(reader.busy, false);
  }
  await assert.rejects(reader.read({ name: 'brief.pdf', bytes: pdf('') }), /no extractable text/);
  const protectedPdf = Buffer.from(fs.readFileSync(path.join(__dirname, 'fixtures/protected-pdf.base64'), 'ascii'), 'base64');
  await assert.rejects(reader.read({ name: 'locked.pdf', bytes: protectedPdf }), /Password-protected/);
  await assert.rejects(reader.read({ name: 'brief.docx', bytes: strToU8('PK\x03\x04not-a-zip') }));
  await assert.rejects(reader.read({ name: 'brief.docx', bytes: docx('x'.repeat(2 * 1024 * 1024 + 1)) }), /too large/);
  const forged = Buffer.from(docx('x'.repeat(2 * 1024 * 1024 + 1)));
  for (let index = 0; index < forged.length - 30; index++) {
    if (forged.readUInt32LE(index) === 0x04034b50) forged.writeUInt32LE(0, index + 22);
    if (forged.readUInt32LE(index) === 0x02014b50) forged.writeUInt32LE(0, index + 24);
  }
  await assert.rejects(reader.read({ name: 'forged.docx', bytes: forged }));
  assert.equal(reader.busy, false);
  const missing = zipSync({ 'word/elsewhere.xml': strToU8(documentXml) });
  await assert.rejects(reader.read({ name: 'brief.docx', bytes: missing }), /does not contain/);
  assert.throws(() => files.validate([{ name: 'brief.pdf', text: 'x', format: 'docx' }]));
  assert.throws(() => files.validate([{ name: 1, text: 'x', format: 'pdf' }]));
});

test('a result larger than the IPC pipe buffer reaches the parent before the worker disconnects', async t => {
  // Disconnecting right after send cancelled the pending write: a 2 MiB DOCX part failed 20 of 20 reads on 2026-10-19.
  const reader = new DocumentReader(); t.after(() => reader.close());
  const xml = '<w:document>' + 'x'.repeat(2 * 1024 * 1024 - 25) + '</w:document>';
  const result = await reader.read({ name: 'large.docx', bytes: docx(xml) });
  assert.equal(result.parts[0].xml, xml);
});

test('Windows limiter startup does not consume the parsing timeout', { skip: process.platform !== 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reader-startup-'));
  const workerFile = path.join(directory, 'reply.cjs');
  fs.writeFileSync(workerFile, "process.once('message', () => process.send({ text: 'ready' }));");
  const reader = new DocumentReader({ timeoutMs: 100, workerFile });
  t.after(async () => { await reader.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const limit = reader.limit.bind(reader);
  reader.limit = async entry => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await limit(entry);
  };
  assert.deepEqual(await reader.read({ name: 'brief.pdf', bytes: pdf() }), { text: 'ready' });
});

test('document timeout and Quit stop the owned parser before allowing another read', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-document-stop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workerFile = path.join(directory, 'wait.cjs');
  fs.writeFileSync(workerFile, 'setInterval(() => {}, 1000);');
  const reader = new DocumentReader({ timeoutMs: 30, workerFile });
  await assert.rejects(reader.read({ name: 'brief.pdf', bytes: pdf() }), /timed out/);
  assert.equal(reader.busy, false);
  const pending = reader.read({ name: 'brief.pdf', bytes: pdf() });
  const rejection = assert.rejects(pending, /closing/);
  await assert.rejects(reader.read({ name: 'second.pdf', bytes: pdf() }), /current document/);
  await reader.close(); await rejection;
  assert.equal(reader.busy, false);
  await assert.rejects(reader.read({ name: 'brief.pdf', bytes: pdf() }), /closed/);
});

test('a decompression-bomb PDF stops at the OS memory cap and leaves the reader usable', { skip: process.platform === 'darwin' && 'no reader memory cap on macOS' }, async t => {
  const reader = new DocumentReader({ timeoutMs: 60000 }); t.after(() => reader.close());
  const bytes = await memoryBombPdf();
  assert.ok(bytes.length < 4096, 'a 3 KB file that expands to 1 GiB');
  let started = Date.now();
  const limit = reader.limit.bind(reader);
  reader.limit = async entry => { await limit(entry); started = Date.now(); };
  // Uncapped, pdf.js committed about 2 GB here and then reported no text; the cap stops it near 768 MiB.
  await assert.rejects(reader.read({ name: 'bomb.pdf', bytes }), /more memory than Harness allows/);
  assert.ok(Date.now() - started < 30000, 'the memory cap, not the timeout, ended the read');
  assert.equal(reader.busy, false);
  assert.deepEqual(await reader.read({ name: 'brief.pdf', bytes: pdf() }), { format: 'pdf', text: 'Build three small games.' });
});

test('headless image decoding accepts supported rasters, preserves pixels and strips source metadata', async t => {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const reader = new DocumentReader(); t.after(() => reader.close());
  const canvas = createCanvas(3, 2), context = canvas.getContext('2d');
  context.fillStyle = '#d02030'; context.fillRect(0, 0, 3, 2);
  for (const [mime, format] of [['png', 'png'], ['jpeg', 'jpeg'], ['webp', 'webp']]) {
    const bytes = Buffer.concat([canvas.encodeSync(format), Buffer.from('private-photo-metadata')]);
    const url = await reader.image(`data:image/${mime};base64,` + bytes.toString('base64'));
    assert.match(url, /^data:image\/png;base64,/);
    const normalized = Buffer.from(url.split(',')[1], 'base64');
    assert.equal(normalized.includes(Buffer.from('private-photo-metadata')), false);
    const image = await loadImage(normalized);
    assert.equal(image.width, 3); assert.equal(image.height, 2);
    if (mime === 'png') {
      const result = createCanvas(3, 2), pixels = result.getContext('2d'); pixels.drawImage(image, 0, 0);
      assert.deepEqual([...pixels.getImageData(0, 0, 1, 1).data], [208, 32, 48, 255]);
    }
    assert.equal(reader.busy, false);
  }
});

test('image validation rejects disguised vectors, corrupt inputs and excessive pixels before accepting a message', async t => {
  const { createCanvas } = require('@napi-rs/canvas');
  const reader = new DocumentReader(); t.after(() => reader.close());
  await assert.rejects(reader.image('file:///private.png'), /PNG, JPEG or WebP/);
  await assert.rejects(reader.image('data:image/png;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')), /contents do not match/);
  const bytes = createCanvas(1, 1).encodeSync('png');
  await assert.rejects(reader.image('data:image/jpeg;base64,' + bytes.toString('base64')), /contents do not match/);
  const corrupt = Buffer.from(bytes); corrupt.fill(0, 33);
  await assert.rejects(reader.image('data:image/png;base64,' + corrupt.toString('base64')), /could not be decoded/);
  const huge = Buffer.from(bytes); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20);
  await assert.rejects(reader.image('data:image/png;base64,' + huge.toString('base64')), /25 megapixels/);
  assert.equal(reader.busy, false);
});

test('large images are downscaled to a 2048 px long edge so history replay stays small', async t => {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const canvas = createCanvas(4000, 1000), context = canvas.getContext('2d');
  for (let x = 0; x < 4000; x += 50) { context.fillStyle = `rgb(${x % 256},${(x * 7) % 256},90)`; context.fillRect(x, 0, 50, 1000); }
  const source = canvas.encodeSync('png');
  const reader = new DocumentReader(); t.after(() => reader.close());
  const url = await reader.image('data:image/png;base64,' + source.toString('base64'));
  assert.match(url, /^data:image\/png;base64,/);
  const output = await loadImage(Buffer.from(url.split(',')[1], 'base64'));
  assert.deepEqual([output.width, output.height], [2048, 512]);
  assert.ok(url.length < source.length * 1.4 / 2);
});

test('opaque photos are sent as JPEG while transparent images keep PNG', async t => {
  const { createCanvas } = require('@napi-rs/canvas');
  const { imageData } = require('../src/image-input.cjs');
  // A noisy gradient compresses like a camera photo: PNG stays large, JPEG shrinks it.
  const photo = alpha => {
    const canvas = createCanvas(600, 400), context = canvas.getContext('2d'), pixels = context.createImageData(600, 400);
    let seed = 1;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const x = (i / 4) % 600, y = Math.floor(i / 2400), noise = seed % 24;
      pixels.data.set([(x * 255 / 600 + noise) & 255, (y * 255 / 400 + noise) & 255, 128 + noise, alpha], i);
    }
    context.putImageData(pixels, 0, 0);
    return 'data:image/png;base64,' + canvas.encodeSync('png').toString('base64');
  };
  const reader = new DocumentReader(); t.after(() => reader.close());
  const opaque = photo(255), url = await reader.image(opaque);
  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.ok(url.length < opaque.length / 2);
  assert.equal(imageData(url).mime, 'image/jpeg');
  assert.match(await reader.image(photo(128)), /^data:image\/png;base64,/);
  assert.throws(() => imageData('data:image/webp;base64,AA=='), /PNG or JPEG/);
});

test('all raster headers enforce the pixel limit before loading a native decoder', async () => {
  const vm = require('node:vm'), module = { exports: {} };
  let decoders = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/image-input.cjs'), 'utf8'), {
    module, Buffer, require() { decoders++; throw new Error('The native decoder must not start.'); },
  });
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 255, 255, 255, 255, 1, 1, 17, 0, 255, 218, 0, 2]);
  const webp = type => {
    const buffer = Buffer.alloc(30); buffer.write('RIFF'); buffer.writeUInt32LE(22, 4);
    buffer.write('WEBP', 8); buffer.write(type, 12); buffer.writeUInt32LE(10, 16); return buffer;
  };
  const lossy = webp('VP8 '); lossy.set([157, 1, 42], 23); lossy.writeUInt16LE(16383, 26); lossy.writeUInt16LE(16383, 28);
  const lossless = webp('VP8L'); lossless[20] = 47; lossless.writeUInt32LE((16383 << 14) | 16383, 21);
  const extended = webp('VP8X'); extended.writeUIntLE(99999, 24, 3); extended.writeUIntLE(99999, 27, 3);
  for (const [bytes, mime] of [[jpeg, 'jpeg'], [lossy, 'webp'], [lossless, 'webp'], [extended, 'webp']])
    await assert.rejects(module.exports.normalizeImage(bytes, mime), /25 megapixels/);
  assert.equal(decoders, 0);
});

test('cancelling image validation closes its worker before another file can be admitted', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-image-stop-'));
  const workerFile = path.join(directory, 'wait.cjs'); fs.writeFileSync(workerFile, 'setInterval(() => {}, 1000);');
  const reader = new DocumentReader({ timeoutMs: 5000, workerFile });
  t.after(async () => {
    await reader.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('harness-image-stop-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const abort = new AbortController();
  const pending = reader.image('data:image/png;base64,YQ==', abort.signal);
  const rejection = assert.rejects(pending, /cancelled/);
  abort.abort(); await rejection;
  assert.equal(reader.busy, false);
});
