const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const method of ['benchmarkData', 'benchmarkRefresh', 'benchmarkImport', 'benchmarkApply', 'benchmarkReset']) {
  api[method] = (...args) => ipcRenderer.invoke(method, ...args);
}
api.copyText = text => ipcRenderer.invoke('copyText', text);
api.nativeProviderAction = (id, action) => ipcRenderer.invoke('nativeProviderAction', id, action);
api.runnerOnExit = value => ipcRenderer.invoke('runnerOnExit', value);
api.runnerInfo = () => ipcRenderer.invoke('runnerInfo');
api.runnerAutostart = enabled => ipcRenderer.invoke('runnerAutostart', enabled);
api.quitRunner = () => ipcRenderer.invoke('quitRunner');
api.setAppearance = mode => ipcRenderer.invoke('setAppearance', mode);
api.onAppearance = callback => {
  const listener = (_event, mode) => callback(mode);
  ipcRenderer.on('appearance', listener);
  return () => ipcRenderer.removeListener('appearance', listener);
};
for (const method of ['remoteInfo', 'remoteStart', 'remoteStop', 'remoteDisconnectAll', 'remoteResetLink'])
  api[method] = (...args) => ipcRenderer.invoke(method, ...args);
api.exportConversation = id => ipcRenderer.invoke('exportConversation', id);
api.saveAgent = value => ipcRenderer.invoke('saveAgent', value);
api.renameHub = name => ipcRenderer.invoke('renameHub', name);
api.saveGroup = value => ipcRenderer.invoke('saveGroup', value);
api.voiceInfo = () => ipcRenderer.invoke('voiceInfo');
api.readDocument = value => ipcRenderer.invoke('readDocument', value);
api.voiceStart = value => ipcRenderer.invoke('voiceStart', value);
api.voiceStop = id => ipcRenderer.invoke('voiceStop', id);
api.onVoice = callback => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on('voice', listener);
  return () => ipcRenderer.removeListener('voice', listener);
};
api.deleteAgent = id => ipcRenderer.invoke('deleteAgent', id);
api.clearConversation = (agentId, groupId) => ipcRenderer.invoke('clearConversation', agentId, groupId);
api.answerConfirmation = (id, accepted) => ipcRenderer.invoke('answerConfirmation', id, accepted);
api.onConfirmation = callback => {
  const listener = (_event, options) => callback(options);
  ipcRenderer.on('confirmation', listener);
  return () => ipcRenderer.removeListener('confirmation', listener);
};
api.queuedMessage = (...args) => ipcRenderer.invoke('queuedMessage', ...args);
api.replySuggestion = id => ipcRenderer.invoke('replySuggestion', id);
api.phasmaGameChecks = workspace => ipcRenderer.invoke('phasmaGameChecks', workspace);
api.reviseJob = args => ipcRenderer.invoke('reviseJob', args);
api.reconcileJob = args => ipcRenderer.invoke('reconcileJob', args);
api.artifactAction = args => ipcRenderer.invoke('artifactAction', args);
api.jobBudget = args => ipcRenderer.invoke('jobBudget', args);
api.stopArtifactRun = id => ipcRenderer.invoke('stopArtifactRun', id);
api.stopDownloads = () => ipcRenderer.invoke('stopDownloads');
api.browseWorkspace = (...args) => ipcRenderer.invoke('browseWorkspace', ...args);
for (const method of ['cursorLogin', 'cursorRefresh', 'cursorLogout', 'claudeLogin', 'claudeRefresh', 'claudeLogout', 'connectChatGPT', 'logoutChatGPT', 'installProvider', 'providerSettings', 'providerKey', 'providerModels', 'localModel', 'renewModels', 'bootstrap', 'settings', 'jevSaveKey', 'jevRemoveKey', 'jevTest', 'create', 'permissions', 'load', 'image', 'rename', 'archive', 'deleteSession', 'findContext', 'cancelContext', 'preview', 'send', 'compact', 'stop', 'answer', 'checks', 'acknowledgeTask', 'applyCopy', 'undoComparison', 'undoRule', 'proposeWiki', 'workspaceWiki', 'chooseWorkspaceWiki', 'openWorkspaceWiki', 'chooseWorkspace', 'openLink', 'diagnostics', 'openLogs', 'appInfo', 'checkUpdates']) {
  api[method] = (...args) => ipcRenderer.invoke(method, ...args);
}
api.updateStatus = () => ipcRenderer.invoke('updateStatus');
api.installUpdate = () => ipcRenderer.invoke('installUpdate');
api.onUpdate = callback => {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('update', listener);
  return () => ipcRenderer.removeListener('update', listener);
};
api.onState = callback => {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('state', listener);
  return () => ipcRenderer.removeListener('state', listener);
};
contextBridge.exposeInMainWorld('router', api);
