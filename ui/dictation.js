(() => {
  const button = element('button', 'icon-button dictation-button');
  button.id = 'dictate'; button.type = 'button';
  button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
  const status = element('span', 'dictation-status');
  status.id = 'dictation-status'; status.setAttribute('role', 'status');
  $('#send').before(button);
  $('#composer').append(status);
  let info, record = null;

  function renderDictation() {
    if (record && record.state !== 'idle' && record.state !== 'stopping' && record.state !== 'cleanup-blocked' &&
        record.sessionId !== selectedId) stopForNavigation();
    const busy = record && record.state !== 'idle';
    button.disabled = submitting || readingImages || changingPermissions || !info?.supported;
    button.setAttribute('aria-pressed', String(!!busy));
    button.title = busy ? 'Stop dictation' : info?.supported
      ? `Dictate locally · ${info.languages[0].name}` : info?.reason || 'Checking local dictation…';
    button.setAttribute('aria-label', button.title);
    status.hidden = !busy;
    status.textContent = busy ? ({ starting: 'Starting…', listening: 'Listening…', stopping: 'Finishing…',
      'cleanup-blocked': 'Retry Stop' }[record.state] || '') : '';
  }

  function receive(event) {
    if (!record || event.id !== record.id) return;
    if (event.sessionId !== record.sessionId) return;
    if (event.type === 'text') {
      if (!Number.isInteger(event.sequence) || event.sequence <= record.sequence || typeof event.text !== 'string') return;
      record.sequence = event.sequence;
      const here = draftKey() === event.sessionId;
      const before = here ? $('#prompt').value : drafts.get(event.sessionId) || '';
      const after = before + (before && !/\s$/.test(before) ? ' ' : '') + event.text;
      drafts.set(event.sessionId, after);
      if (here) { $('#prompt').value = after; updatePreview(); }
      if (after.length > $('#prompt').maxLength) {
        notify(new Error('Your dictation reached the message limit. All words are kept in its draft; shorten it before sending.'));
        stopForNavigation();
      }
    } else if (event.type === 'state') {
      record.state = event.state;
      if (event.error && event.error !== record.error) { record.error = event.error; notify(new Error(event.error)); }
    }
    renderDictation();
  }

  async function finish() {
    const current = record;
    if (!current || current.state === 'idle') return;
    if (!current.finishing) {
      current.state = 'stopping'; renderDictation();
      current.finishing = api.voiceStop(current.id).then(result => {
        if (result.state !== 'idle') throw new Error('Dictation is still stopping. Retry Stop before sending.');
        current.state = 'idle';
      }).finally(() => { current.finishing = null; renderDictation(); });
    }
    await current.finishing;
  }

  function stopForNavigation() { finish().catch(notify); }

  button.onclick = async () => {
    if (record && record.state !== 'idle') { await finish().catch(notify); return; }
    if (!info?.supported || submitting || readingImages || changingPermissions) return;
    submitting = true; renderSendButton();
    try {
      if (!selectedId) {
        const oldKey = draftKey();
        const session = await api.create(state.settings.workspace, draftAccess || state.settings.access);
        if (!selectedId) {
          drafts.set(session.id, $('#prompt').value);
          if (imageDrafts.has(oldKey)) imageDrafts.set(session.id, imageDrafts.get(oldKey));
          if (fileDrafts.has(oldKey)) fileDrafts.set(session.id, fileDrafts.get(oldKey));
          drafts.delete(oldKey); imageDrafts.delete(oldKey); fileDrafts.delete(oldKey);
          selectedId = session.id; draftAccess = null;
          if (!state.sessions.some(saved => saved.id === session.id)) state.sessions.unshift(session);
        }
      }
      record = { id: crypto.randomUUID(), sessionId: selectedId, state: 'starting', sequence: 0 };
      const result = await api.voiceStart({ id: record.id, sessionId: record.sessionId });
      if (record.state === 'starting') record.state = result.state;
    } catch (error) {
      if (record) record.state = 'idle';
      notify(error);
    } finally { submitting = false; render(); }
  };

  document.addEventListener('focusin', event => {
    if (event.target.closest('dialog')) stopForNavigation();
  });
  window.HarnessDictation = { render: renderDictation, finish, stopForNavigation, active: () => !!record && record.state !== 'idle' };
  api.onVoice(receive);
  api.voiceInfo().then(value => { info = value; renderDictation(); }).catch(error => {
    info = { supported: false, reason: error.message }; renderDictation();
  });
  renderDictation();
})();
