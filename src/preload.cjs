const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const method of ['benchmarkData', 'benchmarkRefresh', 'benchmarkImport', 'benchmarkApply', 'benchmarkReset']) {
  api[method] = (...args) => ipcRenderer.invoke(method, ...args);
}
api.copyText = text => ipcRenderer.invoke('copyText', text);
api.exportConversation = id => ipcRenderer.invoke('exportConversation', id);
api.saveAgent = value => ipcRenderer.invoke('saveAgent', value);
api.deleteAgent = id => ipcRenderer.invoke('deleteAgent', id);
api.clearConversation = agentId => ipcRenderer.invoke('clearConversation', agentId);
api.answerConfirmation = (id, accepted) => ipcRenderer.invoke('answerConfirmation', id, accepted);
api.onConfirmation = callback => {
  const listener = (_event, options) => callback(options);
  ipcRenderer.on('confirmation', listener);
  return () => ipcRenderer.removeListener('confirmation', listener);
};
api.queuedMessage = (...args) => ipcRenderer.invoke('queuedMessage', ...args);
api.browseWorkspace = (...args) => ipcRenderer.invoke('browseWorkspace', ...args);
for (const method of ['cursorLogin', 'cursorRefresh', 'cursorLogout', 'claudeLogin', 'claudeRefresh', 'claudeLogout', 'connectChatGPT', 'logoutChatGPT', 'installProvider', 'providerSettings', 'providerKey', 'providerModels', 'renewModels', 'bootstrap', 'settings', 'jevSaveKey', 'jevRemoveKey', 'jevTest', 'create', 'permissions', 'load', 'rename', 'archive', 'deleteSession', 'findContext', 'cancelContext', 'preview', 'send', 'compact', 'stop', 'answer', 'checks', 'acknowledgeTask', 'proposeWiki', 'workspaceWiki', 'chooseWorkspaceWiki', 'openWorkspaceWiki', 'chooseWorkspace', 'openLink', 'diagnostics', 'openLogs', 'appInfo', 'checkUpdates']) {
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
