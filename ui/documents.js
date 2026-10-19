'use strict';
const HarnessDocuments = (() => {
  const MAX_SOURCE = 10 * 1024 * 1024;
  const namespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main']);

  function wordText(parts) {
    if (!Array.isArray(parts) || parts.length > 32) throw new Error('The DOCX document structure is invalid.');
    const result = [];
    let length = 0;
    function append(text) {
      length += new TextEncoder().encode(text).length;
      if (length > HarnessFiles.MAX_BYTES) throw new Error('Extracted document text must be under 64 KB total.');
      result.push(text);
    }
    for (const part of parts) {
      if (typeof part.xml !== 'string' || part.xml.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(part.xml))
        throw new Error('The DOCX document structure is invalid.');
      let nodes = 0;
      for (const _ of part.xml.matchAll(/<(?![!?/])/g)) {
        if (++nodes > 20000) throw new Error('The DOCX has too much formatting to read safely.');
      }
      const xml = new DOMParser().parseFromString(part.xml, 'application/xml');
      if (xml.querySelector('parsererror') || !namespaces.has(xml.documentElement.namespaceURI))
        throw new Error('The DOCX contains unreadable document XML.');
      const walker = xml.createTreeWalker(xml.documentElement, NodeFilter.SHOW_ELEMENT, {
        acceptNode: node => namespaces.has(node.namespaceURI) && node.localName === 'del' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!namespaces.has(node.namespaceURI)) continue;
        if (node.localName === 't') append(node.textContent);
        else if (['p', 'br', 'cr', 'tr'].includes(node.localName)) append('\n');
        else if (['tab', 'tc'].includes(node.localName)) append('\t');
      }
      append('\n');
    }
    const text = result.join('').trim();
    if (!text) throw new Error('This DOCX has no extractable text.');
    return text;
  }

  async function read(name, buffer) {
    if (buffer.byteLength > MAX_SOURCE) throw new Error('Use a PDF or DOCX document under 10 MB.');
    const result = await window.router.readDocument({ name, bytes: new Uint8Array(buffer) });
    const text = result.format === 'docx' ? wordText(result.parts) : result.text;
    return HarnessFiles.validate([{ name, text, format: result.format }])[0];
  }
  return { MAX_SOURCE, read, wordText };
})();
