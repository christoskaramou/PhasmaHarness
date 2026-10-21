'use strict';
const { stripTaskStatus } = require('./routing/task-state.cjs');
const fs = require('node:fs/promises');
const { summary: artifactSummary } = require('./artifacts.cjs');
const { usageText } = require('./job-budgets.cjs');
const { summary: workspaceSummary } = require('./workspace/job-workspaces.cjs');
const { verificationText, batchText } = require('./job-reports.cjs');

function conversationMarkdown(session, batchReports = {}) {
  const maintenance = (session.routes || []).filter(route => route.wikiMaintenanceTaskId);
  const messages = (session.items || []).flatMap(item => {
    if (item.internal || item.pending || maintenance.some(route => route.messageId === (item.clientId || item.id) || (route.turnId && route.turnId === item.turnId))) return [];
    let title, text;
    if (item.type === 'userMessage') {
      title = item.routineRun ? 'Routine · ' + item.routineRun.name : 'You';
      text = (item.content || []).map(part => part.type === 'text' ? part.text : '[Attachment omitted]').join('\n');
      if (item.hubBatch) text += batchText(batchReports[item.hubBatch.id]);
    } else if (item.type === 'agentMail') {
      title = `${item.kind} from ${item.fromName}`;
      text = `Message: ${item.id}${item.replyTo ? '\nReply to: ' + item.replyTo : ''}\n\n${item.text || ''}`;
      if (item.amendment) text = `Change ${item.amendment.state} · revision ${item.amendment.revision}\n\n${text}`;
    } else if (item.type === 'agentResult') {
      title = `Result from ${item.agentName} · ${item.status}`;
      text = `Owner: ${item.ownerName}\n\n${item.error ? item.error + '\n\n' : ''}${item.text || ''}`;
      if (item.superseded) text = 'Earlier assignment revision. Do not restart it.\n\n' + text;
      for (const change of item.amendments || []) text += `\n\nChange ${change.state} · revision ${change.revision}: ${change.text}${change.images?.length ? '\n[Attachment omitted]' : ''}`;
      text += artifactSummary(item.artifacts);
      text += usageText(item.budgetSummary);
      text += workspaceSummary(item.workspaceCopy);
      text += verificationText(item.verification, true);
    } else if (item.type === 'agentArtifact' && item.localOnly) {
      title = 'Artifact available';
      text = artifactSummary([item.artifact]);
    } else if (item.type === 'notice') {
      title = 'Harness';
      text = item.text || '';
    } else if (item.type === 'agentMessage' || item.type === 'plan') {
      title = item.type === 'plan' ? 'Plan' : item.phase === 'commentary' ? 'Assistant · progress' : 'Assistant';
      text = stripTaskStatus(item.text || '');
    } else return [];
    return text ? [`## ${title}\n\n${text}`] : [];
  });
  const title = String(session.title || 'Conversation').replace(/[\r\n]+/g, ' ');
  return `# ${title}\n\n${session.group ? 'Group chat · coordinated by Hub\n\n' : ''}${messages.join('\n\n---\n\n')}\n`;
}

async function exportConversation(window, session, batchReports) {
  const markdown = conversationMarkdown(session, batchReports);
  const selection = await require('electron').dialog.showSaveDialog(window, {
    title: 'Export conversation', defaultPath: 'conversation.md', filters: [{ name: 'Markdown', extensions: ['md'] }],
    properties: ['showOverwriteConfirmation'],
  });
  if (selection.canceled || !selection.filePath) return null;
  await fs.writeFile(selection.filePath, markdown, 'utf8');
  return selection.filePath;
}

module.exports = { conversationMarkdown, exportConversation };
