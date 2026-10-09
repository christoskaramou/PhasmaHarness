'use strict';
const { stripTaskStatus } = require('./routing/task-state.cjs');
const fs = require('node:fs/promises');

function conversationMarkdown(session) {
  const maintenance = (session.routes || []).filter(route => route.wikiMaintenanceTaskId);
  const messages = (session.items || []).flatMap(item => {
    if (item.internal || item.pending || maintenance.some(route => route.messageId === (item.clientId || item.id) || (route.turnId && route.turnId === item.turnId))) return [];
    let title, text;
    if (item.type === 'userMessage') {
      title = 'You';
      text = (item.content || []).map(part => part.type === 'text' ? part.text : '[Attachment omitted]').join('\n');
    } else if (item.type === 'agentMessage' || item.type === 'plan') {
      title = item.type === 'plan' ? 'Plan' : item.phase === 'commentary' ? 'Assistant · progress' : 'Assistant';
      text = stripTaskStatus(item.text || '');
    } else return [];
    return text ? [`## ${title}\n\n${text}`] : [];
  });
  const title = String(session.title || 'Conversation').replace(/[\r\n]+/g, ' ');
  return `# ${title}\n\n${messages.join('\n\n---\n\n')}\n`;
}

async function exportConversation(window, session) {
  const markdown = conversationMarkdown(session);
  const selection = await require('electron').dialog.showSaveDialog(window, {
    title: 'Export conversation', defaultPath: 'conversation.md', filters: [{ name: 'Markdown', extensions: ['md'] }],
    properties: ['showOverwriteConfirmation'],
  });
  if (selection.canceled || !selection.filePath) return null;
  await fs.writeFile(selection.filePath, markdown, 'utf8');
  return selection.filePath;
}

module.exports = { conversationMarkdown, exportConversation };
