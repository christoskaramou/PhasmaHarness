var HarnessReports = (() => {
/** @param {{finalReport?:boolean, text?:string}} item */
function reportAnswer(item) {
  if (item.finalReport) return item.text || '';
  // Old receipts joined turns; quoted examples and fenced code are not turn boundaries.
  const lines = (item.text || '').split('\n');
  let fence = null, boundary = -1, ending = -1;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && !lines[i].trim().slice(marker.length).trim()) fence = null;
      continue;
    }
    const status = !fence && /^ {0,3}\[task:\s*(done|pending|needs-input)\s*\]\s*$/i.exec(lines[i]);
    if (status) {
      ending = i;
      if (status[1].toLowerCase() !== 'done') boundary = i;
    }
  }
  const start = lines.slice(boundary + 1).some(line => line.trim()) ? boundary + 1 : 0;
  const answer = lines.slice(start);
  if (ending >= start && lines.slice(ending + 1).filter(line => line.trim()).length < 3) answer.splice(ending - start, 1);
  return answer.join('\n').trimEnd();
}

return { reportAnswer };
})();
if (typeof module !== 'undefined') module.exports = HarnessReports;
