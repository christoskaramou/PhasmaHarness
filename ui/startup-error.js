confirmAction({ title: 'Harness could not start', message: new URLSearchParams(location.search).get('message') || 'An unexpected startup error occurred.',
  note: 'Close Harness and try opening it again.', confirmLabel: 'Close Harness', cancelLabel: null }).then(() => window.close());
