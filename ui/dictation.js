(() => {
  const button = element('button', 'icon-button dictation-button');
  button.id = 'dictate'; button.type = 'button';
  button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
  const status = element('span', 'dictation-status');
  status.id = 'dictation-status'; status.setAttribute('role', 'status');
  $('#send').before(button);
  $('#composer').append(status);
  const MAX_MS = 5 * 60000;
  let info, record = null, capture = null;

  function renderDictation() {
    if (record && record.state === 'listening' && record.sessionId !== selectedId) stopForNavigation();
    const busy = record && record.state !== 'idle';
    button.disabled = submitting || readingImages || changingPermissions || !info?.supported || record?.state === 'transcribing';
    button.setAttribute('aria-pressed', String(!!busy));
    const firstUse = info?.firstUse ? ` · first use downloads a ${info.download} speech model` : '';
    button.title = busy ? 'Stop dictation' : info?.supported ? `Dictate locally with Whisper · ${info.language}${firstUse}`
      : info?.reason || 'Checking local dictation…';
    button.setAttribute('aria-label', button.title);
    const progress = record?.progress ? `Downloading the speech model… ${record.progress.percent}%` : '';
    // "Listening…" only once the microphone is really recording, so the first words are not lost.
    const listening = capture ? 'Listening…' : 'Starting…';
    status.hidden = !busy;
    status.textContent = busy ? progress || ({ listening, stopping: 'Finishing…', transcribing: 'Writing it down…' }[record.state] || '') : '';
  }

  // The microphone at its own rate, turned into 16 kHz mono by the PCM worklet; blocks collect until Stop.
  async function startCapture() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try {
      const context = new AudioContext();
      await context.audioWorklet.addModule('pcm-capture.js');
      const node = new AudioWorkletNode(context, 'pcm-capture');
      const blocks = [];
      node.port.onmessage = event => blocks.push(event.data);
      context.createMediaStreamSource(stream).connect(node);
      node.connect(context.destination);
      await context.resume();
      return { stream, context, blocks, limit: setTimeout(stopForNavigation, MAX_MS) };
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      throw error;
    }
  }

  function closeCapture(current) {
    clearTimeout(current.limit);
    current.stream.getTracks().forEach(track => track.stop());
    current.context.close().catch(() => {});
  }

  // Ends the recording and returns its samples as one 16-bit PCM buffer, cut to five minutes so blocks still arriving
  // at the limit never push it past what main accepts.
  function endCapture() {
    const current = capture;
    capture = null;
    if (!current) return new ArrayBuffer(0);
    closeCapture(current);
    const total = current.blocks.reduce((sum, block) => sum + block.length, 0);
    const pcm = new Int16Array(Math.min(total, 16000 * MAX_MS / 1000));
    let offset = 0;
    for (const block of current.blocks) {
      if (offset >= pcm.length) break;
      pcm.set(block.subarray(0, pcm.length - offset), offset);
      offset += block.length;
    }
    return pcm.buffer;
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
      if (after.length > $('#prompt').maxLength)
        notify(new Error('Your dictation reached the message limit. All words are kept in its draft; shorten it before sending.'));
    } else if (event.type === 'state') {
      record.progress = event.progress || null;
      // Main asks for the audio when the window is hidden or loses focus.
      if (event.state === 'stopping' && record.state === 'listening') stopForNavigation();
      else if (!(record.finishing && event.state === 'idle')) record.state = event.state;
      if (event.error && event.error !== record.error) { record.error = event.error; notify(new Error(event.error)); }
    }
    renderDictation();
  }

  // Stop: the recorded audio goes to the engine, and its words reach the original chat's draft before this resolves.
  async function finish() {
    const current = record;
    if (!current || current.state === 'idle') return;
    if (!current.finishing) {
      current.state = 'transcribing'; renderDictation();
      const audio = endCapture();
      // Idle even when the call fails, so the mic button never stays disabled.
      current.finishing = api.voiceTranscribe(current.id, audio)
        .finally(() => { current.state = 'idle'; current.finishing = null; renderDictation(); });
    }
    await current.finishing;
  }

  function stopForNavigation() { finish().catch(notify); }

  // Recording could not start: the open dictation ends without words.
  async function cancel(current, error) {
    endCapture();
    current.state = 'idle';
    await api.voiceStop(current.id).catch(() => {});
    notify(error);
  }

  // The microphone opens once the recording has; if Stop or a chat switch came first, it closes again at once.
  async function listen(current) {
    try {
      const opened = await startCapture();
      if (record === current && current.state === 'listening' && !capture) capture = opened;
      else closeCapture(opened);
      renderDictation();
    } catch (error) {
      if (current.state === 'listening') await cancel(current, new Error(`The microphone could not start: ${error.message}`));
    }
  }

  button.onclick = async () => {
    if (record && record.state !== 'idle') { await finish().catch(notify); return; }
    if (!info?.supported || submitting || readingImages || changingPermissions) return;
    submitting = true; renderSendButton();
    let current = null;
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
      current = record = { id: crypto.randomUUID(), sessionId: selectedId, state: 'listening', sequence: 0 };
      await api.voiceStart({ id: current.id, sessionId: current.sessionId });
    } catch (error) {
      if (record) record.state = 'idle';
      current = null;
      notify(error);
    } finally {
      submitting = false; render();
      api.voiceInfo().then(value => { info = value; renderDictation(); }).catch(() => {});
    }
    if (current) await listen(current);
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
