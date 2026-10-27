'use strict';
document.addEventListener('beforetoggle', event => {
  const dialog = event.target;
  if (!(dialog instanceof HTMLDialogElement) || event.newState !== 'open') return;
  dialog.tabIndex = -1;
  dialog.autofocus = true;
}, true);
document.addEventListener('toggle', event => {
  const dialog = event.target;
  if (dialog instanceof HTMLDialogElement && dialog.open && document.activeElement?.matches('button, input[type="submit"], input[type="button"], input[type="reset"], [role="button"]'))
    dialog.focus({ preventScroll: true });
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  const target = event.target;
  const button = target.closest?.('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]');
  const implicitSubmit = target instanceof HTMLInputElement && target.form;
  if (!button && !implicitSubmit) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

let confirmationQueue = Promise.resolve();
function confirmAction(options) {
  const result = confirmationQueue.then(() => new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirmation-dialog';
    dialog.setAttribute('aria-labelledby', 'confirmation-heading');
    dialog.setAttribute('aria-describedby', 'confirmation-description');
    dialog.innerHTML = `<form method="dialog">
      <div class="dialog-heading"><h2 id="confirmation-heading"></h2><button type="button" class="icon-button confirmation-close" aria-label="Cancel"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
      <p id="confirmation-description" class="muted"></p>
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
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm';
      window.getSelection()?.removeAllRanges(); dialog.remove(); resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    dialog.focus({ preventScroll: true });
  }));
  confirmationQueue = result.catch(() => false);
  return result;
}
document.addEventListener('keydown', event => {
  if (!event.altKey || event.ctrlKey || event.metaKey) return;
  const direction = { ArrowLeft: ['width', -20], ArrowRight: ['width', 20], ArrowUp: ['height', -20], ArrowDown: ['height', 20] }[event.key];
  const dialog = event.target.closest?.('dialog[open]');
  if (!direction || !dialog) return;
  const style = getComputedStyle(dialog);
  if (style.resize !== 'both') return;
  event.preventDefault();
  const [axis, delta] = direction, name = axis === 'width' ? 'Width' : 'Height';
  const minimum = parseFloat(style[`min${name}`]) || 0;
  const maximum = Math.min(parseFloat(style[`max${name}`]) || Infinity, (axis === 'width' ? innerWidth : innerHeight) - 48);
  dialog.style[axis] = `${Math.min(maximum, Math.max(minimum, dialog.getBoundingClientRect()[axis] + delta))}px`;
});
document.addEventListener('focusin', event => {
  event.target.closest?.('dialog')?.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown');
});

window.router?.onConfirmation(options => {
  confirmAction(options).then(accepted => window.router.answerConfirmation(options.id, accepted)).catch(console.error);
});
