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

test('saved worker reports export with their owner and actual outcome', () => {
  const markdown = conversationMarkdown({ items: [{ type: 'agentResult', agentName: 'Builder', ownerName: 'Hub',
    status: 'failed', error: 'Build failed', text: 'Files remain available.' }] });
  assert.match(markdown, /Result from Builder · failed/);
  assert.match(markdown, /Owner: Hub/);
  assert.match(markdown, /Build failed\n\nFiles remain available/);
});

test('mailbox questions export with their sender and correlation ID', () => {
  const markdown = conversationMarkdown({ items: [{ id: 'mail-1', type: 'agentMail', kind: 'question', fromName: 'Builder',
    replyTo: null, text: 'Which format?' }] });
  assert.match(markdown, /question from Builder/);
  assert.match(markdown, /Message: mail-1/);
  assert.match(markdown, /Which format/);
});

test('assignment change receipts and earlier-revision results retain truthful status in exports', () => {
  const markdown = conversationMarkdown({ items: [
    { id: 'update-2', type: 'agentMail', kind: 'note', fromName: 'You', text: 'Use blue.', amendment: { revision: 2, state: 'received' } },
    { type: 'agentResult', agentName: 'Builder', ownerName: 'Hub', status: 'completed', superseded: true, text: 'Earlier evidence.',
      amendments: [{ revision: 2, state: 'applied', text: 'Use blue.', images: ['private-image-data'] }] },
  ] });
  assert.match(markdown, /Change received · revision 2/);
  assert.match(markdown, /Change applied · revision 2: Use blue/);
  assert.match(markdown, /Earlier assignment revision. Do not restart it/);
  assert.match(markdown, /\[Attachment omitted\]/);
  assert.doesNotMatch(markdown, /private-image-data/);
});

test('a Harness notice exports as its own section', () => {
  const markdown = conversationMarkdown({ items: [{ type: 'notice', localOnly: true, text: 'Kept the rule "Export greet." in PhasmaHarness.md.', ruleNotice: { kind: 'kept' } }] });
  assert.match(markdown, /## Harness\n\nKept the rule "Export greet\." in PhasmaHarness\.md\./);
});
