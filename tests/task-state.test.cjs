const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readTaskStatus, stripTaskStatus } = require('../src/routing/task-state.cjs');

test('the worker\'s last-line task status is read and removed; anything else is left alone', () => {
  assert.deepEqual(readTaskStatus('Fixed the flicker.\n\n[task: done]'), { status: 'done', text: 'Fixed the flicker.' });
  assert.deepEqual(readTaskStatus('Which cascade?\n[Task: Needs-Input]  \n'), { status: 'needs-input', text: 'Which cascade?' });
  assert.deepEqual(readTaskStatus('[task: pending]'), { status: 'pending', text: '' });
  assert.deepEqual(readTaskStatus('Use [task: done] at the end.'), { status: null, text: 'Use [task: done] at the end.' }, 'only a line of its own at the end counts');
  assert.deepEqual(readTaskStatus('Done.\n[task: finished]'), { status: null, text: 'Done.\n[task: finished]' });
  // Formatted by the model, fenced, or followed by a short closing line.
  assert.deepEqual(readTaskStatus('Fixed.\n\n**[task: done]**'), { status: 'done', text: 'Fixed.' });
  assert.deepEqual(readTaskStatus('Fixed.\n`[task: pending]`'), { status: 'pending', text: 'Fixed.' });
  assert.deepEqual(readTaskStatus('Here:\n```js\ncode\n```\n\n```\n[task: done]\n```'), { status: 'done', text: 'Here:\n```js\ncode\n```' });
  assert.deepEqual(readTaskStatus('```js\ncode\n```\n[task: done]'), { status: 'done', text: '```js\ncode\n```' }, 'a real code block stays');
  assert.deepEqual(readTaskStatus('Fixed.\n[task: needs-input]\nLet me know.'), { status: 'needs-input', text: 'Fixed.\nLet me know.' });
  assert.equal(readTaskStatus('a\n[task: done]\nb\nc\nd').status, null, 'only the last three lines count');
  assert.deepEqual(readTaskStatus('Code:\n```\n```\n[task: done]'), { status: 'done', text: 'Code:\n```\n```' }, 'an empty code block before the line stays');
  assert.deepEqual(readTaskStatus('Fixed.\n- [task: done]'), { status: 'done', text: 'Fixed.' }, 'a list item');
  assert.deepEqual(readTaskStatus('Fixed.\n\n[task: pending]\n\nMore soon.'), { status: 'pending', text: 'Fixed.\n\nMore soon.' }, 'no double blank line left behind');
  assert.equal(stripTaskStatus(undefined), '');
  assert.equal(stripTaskStatus('ok\n[task: done]'), 'ok');
});
