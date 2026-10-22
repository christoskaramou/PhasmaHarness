function assertRunnerOpen(agents, name) {
  if (agents.closing && !['bootstrap', 'runnerInfo', 'stop', 'voiceStop', 'stopArtifactRun', 'stopDownloads', 'diagnostics', 'updateStatus'].includes(name))
    throw new Error('The runner is stopping or updating. Reopen Harness when it finishes.');
}

// You watch a sub-bot's chat; its work comes from the bot that made it.
const WATCH_ONLY = 'This bot works for the bot that made it; only that bot gives it work.';

function registerRunnerCommands(handle, { runner, ask, normalizeImage, openFolder, stopDownloads }) {
  const { controller, agents, wikiStore, documents, updater } = runner;
  const register = handle;
  const chatMutations = new Set(['create', 'permissions', 'rename', 'archive', 'deleteSession', 'queuedMessage', 'compact', 'clearConversation']);
  handle = (name, handler) => register(name, (...args) => {
    if (chatMutations.has(name)) {
      const agentId = name === 'create' ? args[2] : name === 'clearConversation' ? args[0]
        : agents.owner(args[0]).agentId;
      if (agents.isSubBot(agents.profile(agentId))) throw new Error(WATCH_ONLY);
    }
    return handler(...args);
  });
  const preparing = new Set();
  handle('bootstrap', () => agents.snapshot());
  handle('providerConnection', (id, action) => require('./provider-connection.cjs').providerConnection(runner, id, action));
  handle('renewModels', () => require('./provider-connection.cjs').renewModels(runner));
  handle('providerModels', async id => {
    if (controller.nativeCLIs.has(id)) {
      const backend = controller.nativeCLIs.get(id);
      if (!backend.models.length) await backend.refresh();
      return backend.models.map(model => ({ id: model.model, label: model.label }));
    }
    if (id === 'cursor-cli') {
      if (!controller.cursor.models.length) await controller.discoverCursor();
      return controller.cursor.models.map(model => ({ id: model.id, label: model.label || model.id }));
    }
    if (id === 'codex') return controller.models.map(model => ({ id: model.model, label: model.model }));
    if (typeof id !== 'string' || !(controller.data.settings.providers || []).some(provider => provider.id === id))
      throw new Error('Unknown provider.');
    return (await controller.providers.models(id)).map(model => ({ id: model, label: model }));
  });
  handle('artifactAction', args => agents.artifactAction(args, openFolder));
  handle('stopDownloads', async () => {
    try { await stopDownloads(); }
    finally { await agents.downloads.cancel(); }
  });
  handle('jobBudget', args => agents.budgets.update(args));
  handle('stopArtifactRun', id => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Choose a running artifact.');
    return agents.artifactRuns.stop(id);
  });
  handle('saveAgent', value => agents.saveAgent(value));
  handle('renameHub', name => agents.renameHub(name));
  handle('saveGroup', value => agents.saveGroup(value));
  handle('readDocument', value => documents.read(value));
  handle('deleteAgent', id => agents.deleteAgent(id));
  handle('workspaceWiki', (id, agentId) => wikiStore.ensure(id ? agents.owner(id).session(id).workspace : agents.controller(agentId).data.settings.workspace));
  handle('browseWorkspace', (id, action, relative, kind, agentId) => require('./workspace/workspace-browser.cjs').browse(
    id ? agents.owner(id).session(id).workspace : agents.controller(agentId).data.settings.workspace, action, relative, kind));
  handle('settings', (values, agentId) => { const snapshot = agents.settings(values, agentId); controller.warmRouter(); return snapshot; });
  handle('benchmarkData', () => {
    const workers = controller.catalog().filter(p => p.worker && p.enabled && controller.available(p));
    return { data: controller.smartRouter.benchmarks.data, summary: controller.smartRouter.benchmarks.summary(workers) };
  });
  handle('create', (workspace, access, agentId) => {
    return agents.conversation(agents.controller(agentId), true, workspace, access);
  });
  handle('permissions', (id, access) => {
    return agents.owner(id).permissions(id, access);
  });
  handle('load', id => agents.owner(id).load(id));
  handle('image', (id, itemId, index) => {
    if (typeof id !== 'string' || !id) throw new Error('Invalid image request.');
    return agents.owner(id).image(id, itemId, index);
  });
  handle('rename', (id, title) => agents.owner(id).rename(id, title));
  handle('archive', id => agents.owner(id).archive(id));
  handle('deleteSession', id => agents.owner(id).deleteSession(id));
  handle('preview', (id, text, mode, agentId) => (id ? agents.owner(id) : agents.controller(agentId)).preview(id, text, mode));
  handle('send', async message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Choose a conversation and message.');
    if (message.fileMessage !== undefined) throw new Error('Attachment display metadata is created by Harness.');
    const images = message.images || [];
    if (!Array.isArray(images) || images.length > 4 || images.some(url => typeof url !== 'string') ||
        images.reduce((n, url) => n + url.length, 0) > 12 * 1024 * 1024) throw new Error('Attach up to four images, under 8 MB total.');
    const worker = agents.owner(message.id); agents.sync(worker);
    if (agents.isSubBot(agents.profile(worker.agentId))) throw new Error(WATCH_ONLY);
    const request = { id: message.id, abort: new AbortController() };
    preparing.add(request);
    try {
      const normalized = [];
      let normalizedSize = 0;
      for (const url of images) {
        if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) throw new Error('Use PNG, JPEG or WebP images.');
        const output = await normalizeImage(url, request.abort.signal);
        normalizedSize += output.length;
        if (normalizedSize > 12 * 1024 * 1024) throw new Error('The decoded images are too large. Attach smaller images.');
        normalized.push(output);
        if (request.abort.signal.aborted) throw new Error('Message cancelled before submission.');
      }
      assertRunnerOpen(agents, 'send');
      if (agents.owner(message.id) !== worker) throw new Error('This chat changed before submission. Open it again.');
      // A routine marker comes only from the scheduler, never from the UI.
      return worker.send({ ...message, images: normalized, routineRun: null });
    } finally { preparing.delete(request); }
  });
  handle('stop', id => {
    for (const request of preparing) if (!id || request.id === id) request.abort.abort();
    return agents.stop(id);
  });
  handle('reviseJob', args => agents.reviseUserJob(args));
  handle('reconcileJob', args => agents.reconcileJob(args));
  handle('updateStatus', () => updater.state);
  handle('queuedMessage', (id, messageId, action) => {
    return agents.owner(id).queuedMessage(id, messageId, action);
  });
  handle('compact', id => agents.owner(id).compact(id));
  handle('replySuggestion', id => agents.owner(id).replySuggestion(id));
  handle('clearConversation', async (agentId, groupId) => {
    const session = await agents.clearConversation(agentId, name => ask({
      title: 'Start a fresh conversation?', message: `Clear the current context for ${name} and start with a blank chat.`,
      details: [{ label: 'Fresh context', text: 'The current conversation, draft and attachments leave the chat.' },
        { label: 'Same agent', text: 'Role, workspace and access stay the same.' }],
      note: 'Your previous conversation is archived on this computer.', confirmLabel: 'Clear conversation', cancelLabel: 'Keep conversation', danger: true,
    }), groupId);
    return { cleared: !!session, sessionId: session?.id, state: agents.snapshot() };
  });
  handle('acknowledgeTask', (id, taskId) => agents.owner(id).acknowledgeTask(id, taskId));
  handle('undoComparison', (id, comparisonId, part) => agents.owner(id).undoComparison(id, comparisonId, part));
  handle('undoRule', (id, noticeId) => agents.owner(id).undoRule(id, noticeId));
  // Brings a project copy's own changes into the project it came from, after the user reviews the file list.
  handle('applyCopy', async workspace => {
    const preview = await agents.workspaces.changes(workspace);
    const list = files => files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
    if (preview.conflicts.length)
      throw new Error(`You changed ${list(preview.conflicts)} in ${preview.source} since this copy was made. Nothing was applied.`);
    if (!preview.changes.length)
      return { source: preview.source, applied: [], message: 'Nothing to apply: this copy has no changes your project lacks.' };

    const count = preview.changes.length, labels = { added: 'Add', modified: 'Change', deleted: 'Delete' };
    const details = preview.changes.slice(0, 30).map(change => ({ label: labels[change.kind], text: change.path }));
    if (count > 30)
      details.push({ label: 'More', text: `and ${count - 30} more files` });
    const accepted = await ask({ title: `Apply ${count} file${count === 1 ? '' : 's'} to your project?`,
      message: `From ${preview.workspace} into ${preview.source}.`, details,
      note: 'Written as uncommitted changes; nothing is staged or committed. Only files you have not changed since the copy was made. ' +
        `Ignored files, such as build outputs, are not applied. Previous versions stay in the batch snapshot at ${preview.snapshot}.`,
      confirmLabel: 'Apply changes', cancelLabel: 'Cancel' });
    if (!accepted)
      return { source: preview.source, applied: [], cancelled: true };

    return agents.workspaces.apply(workspace, preview);
  });
  handle('proposeWiki', (id, taskId) => agents.owner(id).proposeWiki(id, taskId));
  handle('answer', (id, answer, agentId, contextId) => {
    const target = contextId ? agents.owner(contextId) : agents.controller(agentId);
    if (target.agentId !== (agentId || 'main')) throw new Error('This request belongs to another bot.');
    return target.answer(id, answer);
  });
}

module.exports = { registerRunnerCommands, assertRunnerOpen };
