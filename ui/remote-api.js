(() => {
  if (window.router) return;
  const client = crypto.randomUUID();
  const listeners = new Map();
  let stream, connecting, ready, stopped = false, token = null;
  try { token = sessionStorage.getItem('runner-session'); } catch { /* Memory-only access still works. */ }
  const headers = () => token ? { Authorization: 'Bearer ' + token } : {};
  document.body.classList.add('remote-view');
  const notice = document.createElement('div');
  notice.className = 'remote-connection'; notice.setAttribute('role', 'status'); notice.hidden = true;
  document.body.append(notice);
  const login = document.createElement('section');
  login.className = 'remote-login'; login.hidden = true;
  login.innerHTML = '<form><h1>Connect to your runner</h1><p>Use the connection link or key from the runner’s Settings.</p>' +
    '<label>Connection key<input type="password" autocomplete="off" spellcheck="false" required aria-label="Connection key"></label>' +
    '<button class="primary" type="submit">Connect</button><p role="alert"></p></form>';
  document.body.append(login);

  const status = text => { notice.textContent = text; notice.hidden = !text; };
  async function pair(key) {
    const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'omit', redirect: 'error', body: JSON.stringify({ key }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not connect.');
    token = result.token;
    try { sessionStorage.setItem('runner-session', token); } catch { /* Keep this tab connected. */ }
  }

  function credentials() {
    login.hidden = false;
    const form = login.querySelector('form'), input = login.querySelector('input');
    const message = login.querySelector('[role=alert]'), button = login.querySelector('button');
    input.focus();
    return new Promise(resolve => {
      form.onsubmit = async event => {
        event.preventDefault(); button.disabled = true; message.textContent = '';
        try {
          await pair(input.value.trim()); input.value = ''; login.hidden = true;
          form.onsubmit = null; resolve();
        } catch (error) { message.textContent = error.message; }
        finally { button.disabled = false; }
      };
    });
  }

  let delay = 2000;
  async function events() {
    if (stopped) return;
    stream?.abort();
    const current = new AbortController(); stream = current;
    let reason = 'Disconnected.', retry = true;
    try {
      const response = await fetch('/api/events?client=' + encodeURIComponent(client), {
        headers: headers(), credentials: 'omit', redirect: 'error', signal: current.signal,
      });
      if (response.status === 401) { current.abort(); ready = connect(); return; }
      if (!response.ok) {
        reason = (await response.json().catch(() => null))?.error || 'The runner refused the connection.';
        // Only a busy or failing runner recovers by itself; other refusals need the user.
        retry = [408, 429].includes(response.status) || response.status >= 500;
        return;
      }
      status(''); delay = 2000;
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 32 * 1024 * 1024) {
          reason = 'The runner history is too large for browser access. Use the desktop to archive older conversations.';
          retry = false;
          return;
        }
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (event.startsWith(':')) continue;
          const type = /^event: (.+)$/m.exec(event)?.[1];
          const data = event.split('\n').find(line => line.startsWith('data: '))?.slice(6);
          if (!data) continue;
          const value = JSON.parse(data);
          for (const callback of listeners.get(type) || []) {
            try { callback(value); } catch (error) { console.error(error); }
          }
        }
      }
    } catch { /* Reconnect snapshots replace missing intermediate updates. */ }
    finally {
      if (!stopped && stream === current && !current.signal.aborted) {
        if (retry) {
          status(reason + ' Reconnecting…');
          setTimeout(events, delay);
          delay = Math.min(delay * 2, 60000);
        } else {
          current.abort();
          status(reason + ' Reload this page to try again.');
        }
      }
    }
  }

  function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      const fragment = new URLSearchParams(location.hash.slice(1));
      const key = fragment.get('key');
      if (key) history.replaceState(null, '', location.pathname + location.search);
      try { if (key) await pair(key); }
      catch { await credentials(); }
      // Only a rejected session asks for the key again; a network blip or restarting runner is retried.
      for (let wait = 2000; ; wait = Math.min(wait * 2, 60000)) {
        const response = await fetch('/api/status', { headers: headers(), credentials: 'omit', redirect: 'error' }).catch(() => null);
        if (response?.ok) break;
        if (response?.status === 401) {
          await credentials();
          continue;
        }
        const reason = response ? (await response.json().catch(() => null))?.error || 'The runner refused the connection.' : 'Disconnected.';
        status(reason + ' Reconnecting…');
        await new Promise(resolve => setTimeout(resolve, wait));
      }
      status('');
      events();
    })().finally(() => { connecting = null; });
    return connecting;
  }

  async function call(method, args) {
    await ready;
    let response;
    try {
      response = await fetch('/api/call', { method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ client, method, args,
          undefinedArgs: args.flatMap((value, index) => value === undefined ? [index] : []) }) });
    } catch {
      status('Disconnected. Reconnecting…');
      throw new Error('Connection interrupted. The request may have been saved; reconnect and check before sending it again.');
    }
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) { stream?.abort(); ready = connect(); }
      throw new Error(result.error || 'Runner request failed.');
    }
    return result.result;
  }

  const api = { remote: true };
  for (const method of ['bootstrap', 'saveAgent', 'renameHub', 'saveGroup', 'deleteAgent',
    'workspaceWiki', 'browseWorkspace', 'settings', 'benchmarkData', 'create', 'permissions', 'load', 'image', 'rename',
    'archive', 'deleteSession', 'preview', 'send', 'stop', 'reviseJob', 'reconcileJob', 'jobBudget',
    'stopArtifactRun', 'artifactAction', 'stopDownloads', 'appInfo', 'runnerInfo', 'updateStatus', 'queuedMessage', 'replySuggestion', 'compact',
    'clearConversation', 'acknowledgeTask', 'applyCopy', 'undoComparison', 'undoRule', 'proposeWiki', 'answer', 'answerConfirmation', 'renewModels', 'providerModels'])
    api[method] = (...args) => call(method, args);
  for (const method of ['benchmarkRefresh', 'benchmarkImport', 'benchmarkApply', 'benchmarkReset', 'nativeProviderAction',
    'runnerAutostart', 'quitRunner', 'exportConversation', 'openWorkspaceWiki', 'cursorLogin',
    'cursorRefresh', 'cursorLogout', 'claudeLogin', 'claudeRefresh', 'claudeLogout', 'connectChatGPT', 'logoutChatGPT',
    'installProvider', 'providerSettings', 'providerKey', 'localModel', 'jevSaveKey',
    'jevRemoveKey', 'jevTest', 'checks', 'phasmaGameChecks', 'diagnostics', 'openLogs', 'checkUpdates', 'installUpdate', 'chooseWorkspace',
    'remoteInfo', 'remoteStart', 'remoteStop', 'remoteDisconnectAll', 'remoteResetLink'])
    api[method] = async () => { throw new Error('Use the runner host for this action.'); };
  api.nativeProviderAction = (id, action) => call('providerConnection', [id, action]);
  for (const [prefix, id] of [['claude', 'claude-cli'], ['cursor', 'cursor-cli']]) {
    api[prefix + 'Login'] = () => call('providerConnection', [id, 'connect']);
    api[prefix + 'Refresh'] = () => call('providerConnection', [id, 'refresh']);
    api[prefix + 'Logout'] = () => call('providerConnection', [id, 'disconnect']);
  }
  api.connectChatGPT = () => call('providerConnection', ['codex', 'connect']);
  api.logoutChatGPT = () => call('providerConnection', ['codex', 'disconnect']);
  for (const [method, event] of Object.entries({ onState: 'state', onUpdate: 'update', onConfirmation: 'confirmation', onVoice: 'voice' }))
    api[method] = callback => {
      const callbacks = listeners.get(event) || new Set(); listeners.set(event, callbacks); callbacks.add(callback);
      return () => callbacks.delete(callback);
    };
  api.copyText = text => navigator.clipboard.writeText(text);
  api.artifactAction = async args => {
    if (args.action !== 'download') return call('artifactAction', [args]);
    const result = await call('artifactDownload', [args]);
    if (!/^\/api\/download\/[A-Za-z0-9_-]{43}$/.test(result.url)) throw new Error('Invalid download link.');
    const link = document.createElement('a');
    link.href = result.url; link.download = result.filename; link.rel = 'noreferrer';
    // Let the browser download instead of invoking the app's external-link handler.
    link.addEventListener('click', event => event.stopPropagation());
    document.body.append(link); link.click(); link.remove();
  };
  api.openLink = async value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web links can be opened.');
    window.open(url.href, '_blank', 'noopener,noreferrer');
  };
  api.voiceInfo = async () => ({ supported: false, reason: 'Local dictation is available in the desktop app.' });
  api.voiceStart = async () => { throw new Error('Use local dictation in the desktop app.'); };
  api.voiceStop = async () => null;
  api.disconnect = async () => {
    await ready;
    const response = await fetch('/api/logout', { method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('Could not disconnect.');
    stream?.abort(); token = null;
    try { sessionStorage.removeItem('runner-session'); } catch { /* No stored ticket. */ }
    ready = connect();
  };
  api.readDocument = async ({ name, bytes }) => {
    if (!(bytes instanceof Uint8Array) || bytes.length > 10 * 1024 * 1024) throw new Error('Use a document under 10 MB.');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return call('readDocument', [{ name, base64: btoa(binary) }]);
  };
  window.router = api;
  ready = connect();
  window.addEventListener('pagehide', () => { stopped = true; stream?.abort(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; ready = connect(); } });
})();
