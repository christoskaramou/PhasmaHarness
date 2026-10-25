var HarnessConnectors = (() => {
  const api = window.router, $ = selector => document.querySelector(selector);
  let records = [], editing = null, busy = false, timer, refreshError, renderKey;
  const states = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected', disabled: 'Disabled', 'needs-sign-in': 'Authorization required', error: 'Could not connect' };
  function message(value) { $('#connector-status').textContent = value || ''; }
  function button(label, action) { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.disabled = busy; node.onclick = action; return node; }
  function render() {
    const key = JSON.stringify([records, busy]);
    if (key === renderKey) return;
    renderKey = key;
    const list = $('#connector-list'); list.replaceChildren();
    if (!records.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Add an MCP server to share its tools with your bots.'; list.append(empty); }
    for (const record of records) {
      const card = document.createElement('section'); card.className = 'connector-card';
      const heading = document.createElement('div'); heading.className = 'connector-heading';
      const name = document.createElement('strong'); name.textContent = record.name;
      const status = document.createElement('span'); status.className = 'connector-state'; status.dataset.state = record.state; status.textContent = states[record.state] || record.state;
      heading.append(HarnessMosaic.icon(record.id), name, status); card.append(heading);
      const detail = document.createElement('p'); detail.className = 'hint';
      detail.textContent = record.error || `${record.transport === 'http' ? 'Remote MCP' : 'Local MCP'}${record.toolCount !== undefined ? ` · ${record.toolCount} ${record.toolCount === 1 ? 'tool' : 'tools'}` : ''} · ${record.confirmCalls ? 'Confirm each call' : 'Allowed for Full access'}`;
      card.append(detail);
      const actions = document.createElement('details'); actions.className = 'connector-actions';
      const toggle = document.createElement('summary'); toggle.textContent = '⋯'; toggle.setAttribute('aria-label', `Actions for ${record.name}`); actions.append(toggle);
      actions.append(button('Edit', () => edit(record)), button(record.state === 'connected' || record.state === 'connecting' ? 'Disconnect' : 'Connect', () => act(record, record.state === 'connected' || record.state === 'connecting' ? 'disconnect' : 'connect')));
      if (record.auth === 'oauth' && record.enabled) actions.append(button(record.signingIn ? 'Cancel sign-in' : 'Sign in', () => act(record, record.signingIn ? 'cancel-sign-in' : 'sign-in')));
      if (record.credentialsSaved) actions.append(button('Forget credentials', () => act(record, 'forget-auth')));
      actions.append(button('Remove', () => act(record, 'remove'))); card.append(actions); list.append(card);
      actions.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); actions.open = false; toggle.focus(); } });
    }
    $('#connector-add').disabled = busy; $('#connector-save').disabled = busy;
  }
  function fields() {
    const local = $('#connector-transport').value === 'stdio', auth = $('#connector-auth').value;
    $('#connector-local').hidden = !local; $('#connector-http').hidden = local;
    $('#connector-token-row').hidden = auth !== 'bearer'; $('#connector-client-row').hidden = auth !== 'oauth';
  }
  function clearSecrets() { $('#connector-token').value = ''; $('#connector-env').value = ''; }
  function edit(record = null) {
    editing = record?.id || null; clearSecrets(); message('');
    $('#connector-editor').hidden = false; $('#connector-editor-heading').textContent = record ? 'Edit MCP connector' : 'Add MCP connector';
    for (const [field, value] of Object.entries({ name: record?.name || '', transport: record?.transport || 'http', url: record?.url || '', command: record?.command || '', args: (record?.args || []).join('\n'), cwd: record?.cwd || '', auth: record?.auth || 'none', client: record?.clientId || '', confirm: record?.confirmCalls === false ? 'full' : 'ask' })) $('#connector-' + field).value = value;
    $('#connector-token').placeholder = record?.credentialsSaved ? 'Saved — leave blank to keep' : 'Token';
    $('#connector-env').placeholder = record?.credentialsSaved ? 'Saved — leave blank to keep; enter {} to clear' : 'API_KEY=…';
    fields(); $('#connector-name').focus();
  }
  async function refresh() { records = await api.connectorList(); render(); }
  async function act(record, action) {
    busy = true; message(''); render();
    try {
      const result = await api.connectorAction(record.id, action); records = result.connectors; render();
      if (result.url) { await api.openLink(result.url); message('Finish sign-in in your browser on the computer running Harness.'); }
      if (action === 'remove' && editing === record.id) { editing = null; $('#connector-editor').hidden = true; clearSecrets(); }
    } catch (error) { message(error.message); }
    finally { busy = false; render(); }
  }
  $('#connector-add').onclick = () => edit();
  $('#connector-cancel').onclick = () => { editing = null; $('#connector-editor').hidden = true; clearSecrets(); };
  $('#connector-transport').onchange = fields; $('#connector-auth').onchange = fields;
  $('#connector-save').onclick = async () => {
    busy = true; message(''); render();
    try {
      const input = { ...(editing ? { id: editing } : {}), name: $('#connector-name').value, transport: $('#connector-transport').value, confirmCalls: $('#connector-confirm').value === 'ask' };
      if (input.transport === 'http') {
        Object.assign(input, { url: $('#connector-url').value.trim(), auth: $('#connector-auth').value, clientId: $('#connector-client').value.trim() });
        if ($('#connector-token').value) input.token = $('#connector-token').value;
      } else {
        Object.assign(input, { command: $('#connector-command').value, args: $('#connector-args').value.split(/\r?\n/).filter(line => line !== ''), cwd: $('#connector-cwd').value.trim() });
        const text = $('#connector-env').value.trim();
        if (text === '{}') input.env = {};
        else if (text) input.env = Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map(line => {
          const equal = line.indexOf('='); if (equal < 1) throw new Error('Use KEY=value for each environment variable.');
          return [line.slice(0, equal).trim(), line.slice(equal + 1)];
        }));
      }
      records = await api.connectorSave(input); clearSecrets(); editing = null; $('#connector-editor').hidden = true; render();
    } catch (error) { message(error.message); }
    finally { busy = false; render(); }
  };
  $('#settings-dialog').addEventListener('close', () => { clearTimeout(timer); clearSecrets(); });
  async function show() {
    clearTimeout(timer);
    try {
      if (!busy) {
        await refresh();
        if (refreshError && $('#connector-status').textContent === refreshError) message('');
        refreshError = null;
      }
    } catch (error) { refreshError = error.message; message(refreshError); }
    if ($('#settings-dialog').open && !$('#panel-connectors').hidden) timer = setTimeout(show, 2000);
  }
  return { show };
})();
