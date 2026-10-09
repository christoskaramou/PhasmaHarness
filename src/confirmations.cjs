function confirmations(window) {
  const pending = new Map();
  let sequence = 0;
  const cancel = () => { for (const resolve of pending.values()) resolve(false); pending.clear(); };
  window.on('closed', cancel);
  window.webContents.on('render-process-gone', cancel);
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel(); });
  return {
    ask(options) {
      if (window.isDestroyed() || window.webContents.isLoadingMainFrame()) return Promise.resolve(false);
      return new Promise(resolve => {
        const id = ++sequence;
        pending.set(id, resolve);
        try { window.webContents.send('confirmation', { ...options, id }); }
        catch { pending.delete(id); resolve(false); }
      });
    },
    answer(id, accepted) {
      if (!Number.isSafeInteger(id) || typeof accepted !== 'boolean') throw new Error('Invalid confirmation response.');
      const resolve = pending.get(id);
      pending.delete(id);
      resolve?.(accepted);
    },
  };
}
module.exports = { confirmations };
