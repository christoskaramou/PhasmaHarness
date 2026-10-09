'use strict';
let confirmationQueue = Promise.resolve();
function confirmAction(options) {
  const result = confirmationQueue.then(() => new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirmation-dialog';
    dialog.setAttribute('aria-labelledby', 'confirmation-heading');
    dialog.setAttribute('aria-describedby', 'confirmation-description');
    dialog.innerHTML = `<form method="dialog">
      <div class="dialog-heading"><span class="confirmation-symbol" aria-hidden="true">↗</span><button type="button" class="icon-button confirmation-close" aria-label="Cancel">×</button></div>
      <h2 id="confirmation-heading"></h2><p id="confirmation-description" class="muted"></p>
      <div class="confirmation-details"></div><p class="confirmation-note"></p>
      <div class="dialog-footer"><button type="button" class="confirmation-cancel"></button><button type="submit" value="confirm" class="confirmation-accept"></button></div>
    </form>`;
    dialog.querySelector('h2').textContent = options.title;
    dialog.querySelector('.muted').textContent = options.message || '';
    const details = dialog.querySelector('.confirmation-details');
    for (const detail of options.details || []) {
      const row = document.createElement('div'), label = document.createElement('strong'), text = document.createElement('p');
      label.textContent = detail.label; text.textContent = detail.text;
      row.append(label, text); details.append(row);
    }
    details.hidden = !details.childElementCount;
    const note = dialog.querySelector('.confirmation-note');
    note.textContent = options.note || ''; note.hidden = !options.note;
    const cancel = dialog.querySelector('.confirmation-cancel'), accept = dialog.querySelector('.confirmation-accept');
    cancel.textContent = options.cancelLabel || 'Cancel'; cancel.hidden = options.cancelLabel === null;
    accept.textContent = options.confirmLabel || 'Continue'; accept.classList.add(options.danger ? 'danger' : 'primary');
    cancel.onclick = () => dialog.close();
    dialog.querySelector('.confirmation-close').onclick = () => dialog.close();
    (cancel.hidden ? accept : cancel).autofocus = true;
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm';
      window.getSelection()?.removeAllRanges(); dialog.remove(); resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }));
  confirmationQueue = result.catch(() => false);
  return result;
}
window.router?.onConfirmation(options => {
  confirmAction(options).then(accepted => window.router.answerConfirmation(options.id, accepted)).catch(console.error);
});
