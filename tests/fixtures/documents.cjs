const zlib = require('node:zlib');
const { zipSync, strToU8 } = require('fflate');
function pdf(text = 'Build three small games.') {
  const stream = `BT /F1 12 Tf 50 700 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.7\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(output));
}
// A 3 KB PDF whose page content expands through two Flate filters to `size` bytes of zeros.
async function memoryBombPdf(size = 1024 ** 3) {
  const deflate = zlib.createDeflate({ level: 9 }), parts = [], zero = Buffer.alloc(1 << 24);
  deflate.on('data', part => parts.push(part));
  const ended = new Promise(resolve => deflate.once('end', resolve));
  for (let left = size; left > 0; left -= zero.length) {
    if (!deflate.write(zero)) await new Promise(resolve => deflate.once('drain', resolve));
  }
  deflate.end();
  await ended;
  const stream = zlib.deflateSync(Buffer.concat(parts), { level: 9 });
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${stream.length} /Filter [/FlateDecode /FlateDecode] >>\nstream\n${stream.toString('latin1')}\nendstream`];
  let output = '%PDF-1.7\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(output, 'latin1'));
}
const documentXml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Καλημέρα &amp; hello</w:t></w:r></w:p><w:p><w:r><w:t>Build three small games.</w:t></w:r></w:p></w:body></w:document>';
function docx(xml = documentXml, extra = {}) {
  return zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml), ...extra });
}
module.exports = { pdf, docx, documentXml, memoryBombPdf };
