'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationMarkdown } = require('../src/conversation-export.cjs');

test('Markdown export preserves messages and plans without private or internal content', () => {
  const markdown = conversationMarkdown({ title: 'Example\nchat', routes: [{ wikiMaintenanceTaskId: 'wiki', messageId: 'wiki-prompt', turnId: 'wiki-turn' }], items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'Keep **Markdown** and Ω.' }, { type: 'image', url: 'PRIVATE_IMAGE' }] },
    { type: 'agentMessage', phase: 'commentary', text: 'Working.' },
    { type: 'plan', text: '1. Inspect\n2. Fix' },
    { type: 'agentMessage', text: '```js\nconst answer = 42;\n```\n\n[task: done]' },
    { type: 'reasoning', text: 'PRIVATE_REASONING' },
    { type: 'agentMessage', internal: true, text: 'PRIVATE_INTERNAL' },
    { type: 'userMessage', pending: true, content: [{ type: 'text', text: 'UNSENT' }] },
    { type: 'userMessage', id: 'wiki-prompt', content: [{ type: 'text', text: 'PRIVATE_WIKI_PROMPT' }] },
    { type: 'agentMessage', turnId: 'wiki-turn', text: 'PRIVATE_WIKI_REPLY' },
    { type: 'mcpToolCall', arguments: { secret: 'PRIVATE_TOOL_ARGUMENTS' } },
  ] });
  assert.match(markdown, /^# Example chat\n/);
  assert.match(markdown, /## You\n\nKeep \*\*Markdown\*\* and Ω\.\n\[Attachment omitted\]/);
  assert.match(markdown, /## Assistant · progress\n\nWorking\./);
  assert.match(markdown, /## Plan\n\n1\. Inspect\n2\. Fix/);
  assert.match(markdown, /```js\nconst answer = 42;\n```/);
  assert.doesNotMatch(markdown, /PRIVATE_|UNSENT|\[task:/);
});

test('an empty conversation still exports a readable Markdown document', () => {
  assert.equal(conversationMarkdown({ items: [] }), '# Conversation\n\n\n');
});
