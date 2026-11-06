function confirmations(window) {
  const pending = new Map();
  let sequence = 0;
  const cancel = () => { for (const resolve of pending.values()) resolve(false); pending.clear(); };
  window.on('closed', cancel);
  window.webContents.on('render-process-gone', cancel);
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel(); });
  return {
    // signal: the asker stopped waiting (it expired, or the work was stopped). The question is withdrawn and its dialog
    // closes, so a late click never looks accepted (2026-11-06: an expired prompt stayed open and Allow did nothing).
    ask(options, signal = null) {
      if (window.isDestroyed() || window.webContents.isLoadingMainFrame() || signal?.aborted) return Promise.resolve(false);
      return new Promise(resolve => {
        const id = ++sequence;
        pending.set(id, resolve);
        signal?.addEventListener('abort', () => {
          if (!pending.delete(id)) return;
          resolve(false);
          if (!window.isDestroyed()) window.webContents.send('confirmationClosed', id);
        }, { once: true });
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
