'use strict';
const path = require('node:path');
const MAX_TEXT = 64 * 1024, MAX_XML = 2 * 1024 * 1024;

async function pdfText(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const resources = path.dirname(require.resolve('pdfjs-dist/package.json')).replace(/\\/g, '/') + '/';
  const task = getDocument({ data: bytes, isEvalSupported: false, useWorkerFetch: false, useWasm: false,
    disableFontFace: true, stopAtErrors: true, verbosity: 0,
    cMapUrl: resources + 'cmaps/', standardFontDataUrl: resources + 'standard_fonts/' });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 200) throw new Error('Attach a PDF with at most 200 pages.');
    const parts = [];
    let length = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const stream = page.streamTextContent(), reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const text = item.str + (item.hasEOL ? '\n' : ' ');
            length += Buffer.byteLength(text);
            if (length > MAX_TEXT) throw new Error('Extracted document text must be under 64 KB total.');
            parts.push(text);
          }
        }
      } finally { await reader.cancel().catch(() => {}); page.cleanup(); }
      parts.push('\n'); length++;
    }
    const text = parts.join('').trim();
    if (!text) throw new Error('This PDF has no extractable text. Attach page images instead.');
    return { format: 'pdf', text };
  } finally { await task.destroy(); }
}

function docxParts(bytes) {
  const { Unzip, UnzipInflate } = require('fflate');
  const parts = [], names = new Set();
  let expanded = 0, entries = 0;
  const unzip = new Unzip(file => {
    if (++entries > 2000) throw new Error('This DOCX has too many archive entries.');
    if (!/^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(file.name)) return;
    if (names.has(file.name)) throw new Error('The DOCX contains duplicate document parts.');
    if (names.size >= 32 || file.originalSize > MAX_XML) throw new Error('The DOCX document structure is too large.');
    names.add(file.name);
    const chunks = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      expanded += chunk.length;
      if (expanded > MAX_XML) { file.terminate(); throw new Error('The DOCX document structure is too large.'); }
      chunks.push(Buffer.from(chunk));
      if (final) parts.push({ name: file.name, xml: new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Bound each inflate step even when an archive lies about its expanded size.
  for (let offset = 0; offset < bytes.length; offset += 4096) unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
  if (!parts.some(part => part.name === 'word/document.xml')) throw new Error('The DOCX does not contain a readable document.');
  parts.sort((a, b) => (a.name === 'word/document.xml' ? -1 : b.name === 'word/document.xml' ? 1 : a.name.localeCompare(b.name)));
  return { format: 'docx', parts };
}

process.once('message', async data => {
  try {
    const result = data.format === 'image' ? await require('./image-input.cjs').normalizeImage(data.bytes, data.mime)
      : data.format === 'pdf' ? await pdfText(data.bytes) : docxParts(data.bytes);
    // Disconnect only after the write completes: disconnecting at once cancels a result larger than the pipe buffer.
    process.send(result, () => process.disconnect());
  }
  catch (error) {
    const message = error.name === 'PasswordException' ? 'Password-protected PDFs are not supported. Attach an unlocked copy.'
      : error instanceof RangeError && /allocation failed/i.test(error.message) ? 'The file needs more memory than Harness allows; try a smaller file.' : error.message;
    process.send({ error: String(message).slice(0, 1000) }, () => process.disconnect());
  }
});
