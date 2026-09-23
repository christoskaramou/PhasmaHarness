const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const method of ['benchmarkData', 'benchmarkRefresh', 'benchmarkImport', 'benchmarkApply', 'benchmarkReset']) {
  api[method] = (...args) => ipcRenderer.invoke(method, ...args);
}
api.copyText = text => ipcRenderer.invoke('copyText', text);
api.queuedMessage = (...args) => ipcRenderer.invoke('queuedMessage', ...args);
api.browseWorkspace = (...args) => ipcRenderer.invoke('browseWorkspace', ...args);
for (const method of ['cursorLogin', 'cursorRefresh', 'cursorLogout', 'claudeLogin', 'claudeRefresh', 'claudeLogout', 'connectChatGPT', 'logoutChatGPT', 'providerSettings', 'providerKey', 'providerModels', 'renewModels', 'bootstrap', 'settings', 'jevSaveKey', 'jevRemoveKey', 'jevTest', 'create', 'permissions', 'load', 'rename', 'archive', 'deleteSession', 'findContext', 'cancelContext', 'preview', 'send', 'compact', 'stop', 'answer', 'chooseWorkspace', 'openLink']) {
  api[method] = (...args) => ipcRenderer.invoke(method, ...args);
}
api.onState = callback => {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('state', listener);
  return () => ipcRenderer.removeListener('state', listener);
};
contextBridge.exposeInMainWorld('router', api);
