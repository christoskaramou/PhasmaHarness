const { Menu } = require('electron');

function configureTextContextMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    Menu.buildFromTemplate([
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.isEditable && params.editFlags.canPaste },
    ]).popup({ window, frame: params.frame });
  });
}

module.exports = { configureTextContextMenu };
