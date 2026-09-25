// One model per task. Workers end each final reply with a status line (see worker-instructions.cjs) that the Harness reads and hides:
// [task: done], [task: pending] or [task: needs-input]. The router sees the current task (its first request,
// the worker running it and that status) with every prompt and says whether the prompt continues it; a
// continued task keeps its worker, so the conversation cache and the model's working context survive.
const STATUSES = ['done', 'pending', 'needs-input'];
// The status line, also when a model formats it (**bold**, `code`, _italic_, a quote or list item) or puts a short line after it.
const LINE = /^[\s>*_`+-]*\[task:[ \t]*(done|pending|needs-input)[ \t]*\][\s*_`.]*$/i;
const FENCE = /^\s*(```|~~~)\s*\w*\s*$/;

function readTaskStatus(text) {
  const value = String(text ?? '');
  const lines = value.trimEnd().split('\n');
  // Look at the last three non-empty lines only, so a status quoted earlier in a reply is left alone.
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 3; i--) {
    if (!lines[i].trim()) continue;
    seen++;
    const match = LINE.exec(lines[i]);
    if (!match) continue;
    // A code fence that holds only the status line goes with it.
    let from = i, to = i;
    const before = lines.slice(0, i).findLastIndex(line => line.trim());
    const after = lines.findIndex((line, k) => k > i && line.trim());
    if (before >= 0 && after > i && FENCE.test(lines[before]) && FENCE.test(lines[after])) { from = before; to = after; }
    const rest = [...lines.slice(0, from), ...lines.slice(to + 1)];
    // Do not leave a double blank line where the status line was.
    if (from > 0 && from < rest.length && !rest[from - 1].trim() && !rest[from].trim()) rest.splice(from, 1);
    return { status: match[1].toLowerCase(), text: rest.join('\n').trimEnd() };
  }
  return { status: null, text: value };
}
const stripTaskStatus = text => readTaskStatus(text).text;

module.exports = { STATUSES, readTaskStatus, stripTaskStatus };
