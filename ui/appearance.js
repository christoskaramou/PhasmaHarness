'use strict';

(() => {
  const root = document.documentElement;
  const modes = ['system', 'dark', 'light'];
  let appearance = 'system';

  try {
    const saved = localStorage.getItem('appearance');
    if (modes.includes(saved)) {
      appearance = saved;
    }
  } catch { /* Appearance remains usable when local storage is unavailable. */ }

  root.dataset.appearance = appearance;
  // The desktop window paints its launch background from this before the page loads; browser views have no window to tell.
  const share = mode => globalThis.router?.setAppearance?.(mode)?.catch(() => {});

  document.addEventListener('DOMContentLoaded', () => {
    const control = document.querySelector('#settings-appearance');
    control.value = appearance;
    share(appearance);
    control.addEventListener('change', () => {
      if (!modes.includes(control.value)) {
        control.value = root.dataset.appearance;
        return;
      }

      root.dataset.appearance = control.value;
      share(control.value);

      try {
        localStorage.setItem('appearance', control.value);
      } catch { /* Keep the current appearance even if it cannot be saved. */ }
    });
  });
})();
