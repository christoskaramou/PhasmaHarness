const { Menu } = require('electron');

function configureTextContextMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    // An image (one opened in the viewer, a thumbnail, a reply's picture) offers Copy image.
    if (params.mediaType === 'image' && params.hasImageContents) {
      Menu.buildFromTemplate([{ label: 'Copy image', click: () => window.webContents.copyImageAt(params.x, params.y) }]).popup({ window, frame: params.frame });
      return;
    }
    if (!params.isEditable && !params.selectionText) return;
    Menu.buildFromTemplate([
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.isEditable && params.editFlags.canPaste },
    ]).popup({ window, frame: params.frame });
  });
}

module.exports = { configureTextContextMenu };
