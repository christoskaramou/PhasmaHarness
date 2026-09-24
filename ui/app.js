'use strict';
const $ = selector => document.querySelector(selector);
// Backend capabilities come from the main process; unknown or missing providers run through Codex.
const CODEX_CAPS = { cli: false, steer: true, compact: true, usage: true };
function providerCaps(provider) {
  const all = state?.providerCapabilities || {};
  return (Object.hasOwn(all, provider) && all[provider]) || all.codex || CODEX_CAPS;
}
const api = window.router;
function chatgptDetail(account) {
  if (!account || account.type !== 'chatgpt') return null;
  const plan = (account.plan || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  if (plan && account.email) return `${plan} as ${account.email}`;
  if (account.email) return account.email;
  return plan || 'connected';
}

function claudeDetail(account) {
  const plan = (account?.subscriptionType || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return plan && account?.email ? `${plan} as ${account.email}` : account?.email || plan || account?.authMethod || 'connected';
}

// In use by the Harness: signed in to the CLI and not disconnected here. Disconnecting never signs the CLI out.
const claudeInUse = () => !!state?.claude?.loggedIn && state.claude.enabled !== false;
const cursorInUse = () => !!state?.cursor?.loggedIn && state.cursor.enabled !== false;
const KEPT_SIGNED_IN = 'disconnected';

function connectedProviders() {
  if (!state) return [];
  const rows = [];
  if (state.account) rows.push('ChatGPT');
  if (claudeInUse()) rows.push('Claude');
  if (cursorInUse()) rows.push('Cursor');
  return rows;
}
marked.use({ extensions: [{
  name: 'equation', level: 'inline',
  start: src => src.search(/\\\[|\\\(|\$\$/),
  tokenizer(src) {
    const match = /^(?:\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$)/.exec(src);
    if (match) return { type: 'equation', raw: match[0], text: match[1] ?? match[2] ?? match[3], display: match[2] === undefined };
  },
  renderer: token => `<span data-equation="${encodeURIComponent(token.text)}" data-display="${token.display}"></span>`,
}] });
let state = null;
let selectedId = null;
let sentHistory = null;
let sentHistoryIndex = -1;
let shownRequest = null;
let routeVersion = 0;
let toastTimer;
let noticeTimer;
let bannerShown = { text: '', at: 0 };
const drafts = new Map();
const imageDrafts = new Map();
let readingImages = false;
function attachedImages() { return imageDrafts.get(selectedId || 'new') || []; }
function renderImages() {
  const tray = $('#image-previews');
  tray.replaceChildren();
  attachedImages().forEach((url, i) => {
    const card = element('div', 'image-preview');
    const image = element('img'); image.src = url; image.alt = `Attached image ${i + 1}`;
    const remove = element('button', 'image-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove attached image ${i + 1}`);
    remove.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1l8 8M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    remove.onclick = () => { imageDrafts.set(selectedId || 'new', attachedImages().filter((_, n) => n !== i)); renderImages(); updatePreview(); };
    card.append(image, remove); tray.append(card);
  });
}
$('#prompt').addEventListener('paste', async event => {
  const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile());
  if (!files.length) return;
  event.preventDefault();
  if (readingImages || submitting) return;
  const key = selectedId || 'new';
  readingImages = true; updatePreview();
  try {
    if (files.some(file => !file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) || files.reduce((n, file) => n + file.size, 0) > 8 * 1024 * 1024) throw new Error('Paste PNG, JPEG or WebP images under 8 MB total.');
    const urls = await Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read pasted image.')); reader.readAsDataURL(file);
    })));
    const next = [...(imageDrafts.get(key) || []), ...urls];
    if (next.length > 4 || next.reduce((n, url) => n + url.length, 0) > 12 * 1024 * 1024) throw new Error('Attach up to four images under 8 MB total.');
    imageDrafts.set(key, next);
  } catch (error) { notify(error); }
  finally { readingImages = false; renderImages(); updatePreview(); }
});
const messageNodes = new Map();
let renderedSession = null;
let submitting = false;
let draftAccess = null;
let changingPermissions = false;
let testingJev = false;
let deletingSession = false;
let contextResult = null;
let searchingContext = false;
let contextSessionId = null;
let contextVersion = 0;

function notify(error) {
  $('#toast').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
  $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 9000);
}

function current() { return state?.sessions.find(s => s.id === selectedId); }
function basename(value) { return value?.split(/[\\/]/).filter(Boolean).at(-1) || 'Choose a folder'; }
function routerName(value, effort) {
  if (value?.startsWith('jev-')) return `Jev ${value.slice(4)}`;
  if (!value) return 'Router';
  const name = ({ 'gpt-6-astra': 'Astra', 'gpt-5.6-luna': 'Luna', 'gpt-5.6-sol': 'Sol', 'gpt-5.6-terra': 'Terra' })[value] || value;
  return name + (effort ? ` ${effort}` : '');
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyState(next) { state = next; render(); }
let browserWorkspace = '', browserSession = null, browserMode = 'list', browserFile = null, browserVersion = 0;
let browserPreviewVersion = 0;
let probedWorkspace = '';
function probeWorkspace() {
  const root = current()?.workspace || state.settings.workspace;
  if (root === probedWorkspace) return;
  probedWorkspace = root;
  $('#browse-changes').disabled = true;
  if ($('#browser-dialog').open) $('#browser-dialog').close();
  api.browseWorkspace(selectedId, 'changes').then(result => {
    if (probedWorkspace === root) {
      $('#browse-changes').disabled = !result.available;
      $('#browse-changes').title = result.available ? 'View Git changes' : 'Git unavailable or workspace is not a Git repository';
    }
  }).catch(() => {});
}
async function showWorkspace(mode) {
  browserSession = selectedId;
  browserWorkspace = current()?.workspace || state.settings.workspace;
  browserMode = mode;
  $('#browser-view').value = localStorage.getItem('browserView') === 'files' ? 'files' : 'tree';
  $('#browser-heading').textContent = mode === 'session' ? 'Session changes' : mode === 'changes' ? 'Git changes' : 'Workspace files';
  $('#browser-root').textContent = browserWorkspace;
  if (!$('#browser-dialog').open) $('#browser-dialog').showModal();
  await refreshBrowser();
}
async function previewWorkspace(entry, version) {
  const ticket = ++browserPreviewVersion;
  browserFile = null; $('#browser-attach').disabled = true;
  $('#browser-preview').textContent = 'Loading…';
  $('#browser-diff-meta').hidden = true;
  try {
    const result = browserMode === 'session' ? { path: entry.path, text: entry.diff || 'No recorded diff available for this file.' } : await api.browseWorkspace(browserSession, browserMode === 'changes' ? 'diff' : 'read', entry.path, entry.kind);
    if (version !== browserVersion || ticket !== browserPreviewVersion) return;
    $('#browser-status').textContent = result.path + (result.note ? ` · ${result.note}` : '');
    const preview = $('#browser-preview'); preview.replaceChildren();
    if ((browserMode === 'changes' && entry.kind !== 'untracked') || browserMode === 'session') {
      const metadata = []; let inHunk = false;
      const lines = result.text.split('\n');
      for (const line of lines.slice(0, 4000)) {
        if (line.startsWith('diff --git ')) inHunk = false;
        if (line.startsWith('@@')) inHunk = true;
        if (!inHunk && /^(diff --git |index |--- |\+\+\+ )/.test(line)) { metadata.push(line); continue; }
        const kind = line.startsWith('@@') ? 'diff-hunk' : inHunk && line.startsWith('+') ? 'diff-add' : inHunk && line.startsWith('-') ? 'diff-remove' : 'diff-context';
        preview.append(element('span', `diff-line ${kind}`, line + '\n'));
      }
      if (lines.length > 4000) preview.append(element('span', 'diff-line', '[First 4,000 diff lines shown]\n'));
      $('#browser-diff-meta').hidden = !metadata.length;
      $('#browser-diff-meta').open = false;
      $('#browser-diff-meta pre').textContent = metadata.join('\n');
    } else preview.textContent = result.text;
    if (result.truncated) preview.append(document.createTextNode('\n[Preview truncated]'));
    browserFile = result.absolutePath;
    $('#browser-attach').disabled = !browserFile || entry.status === 'D';
  } catch (error) { if (version === browserVersion && ticket === browserPreviewVersion) $('#browser-preview').textContent = error.message; }
}
async function fillBrowser(parent, relative, version) {
  const result = await api.browseWorkspace(browserSession, 'list', relative);
  if (version !== browserVersion) return;
  for (const entry of result.entries) {
    if (entry.directory) {
      const folder = element('details'), title = element('summary', '', entry.name + '/'), children = element('div', 'browser-children');
      folder.append(title, children); parent.append(folder);
      let loaded = false;
      folder.ontoggle = async () => {
        if (!folder.open || loaded) return;
        loaded = true; children.textContent = 'Loading…';
        try { children.replaceChildren(); await fillBrowser(children, entry.path, version); }
        catch (error) { children.textContent = error.message; loaded = false; }
      };
    } else {
      const button = element('button', 'browser-file', entry.name); button.type = 'button';
      button.onclick = () => previewWorkspace(entry, browserVersion);
      parent.append(button);
    }
  }
  if (!result.entries.length) parent.append(element('p', 'muted', 'Empty folder.'));
  if (result.truncated) parent.append(element('p', 'muted', 'First 1,000 entries shown.'));
}
function renderChangeTree(parent, entries, depth = 0) {
  const folders = new Map(), files = [];
  for (const entry of entries) {
    const parts = entry.path.split('/');
    if ($('#browser-view').value === 'files' || parts.length === depth + 1) files.push(entry);
    else {
      if (!folders.has(parts[depth])) folders.set(parts[depth], []);
      folders.get(parts[depth]).push(entry);
    }
  }
  for (const [name, children] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
    const folder = element('details'), title = element('summary', '', `${name}/ (${children.length})`);
    const list = element('div', 'browser-children');
    folder.open = true; folder.append(title, list); parent.append(folder);
    renderChangeTree(list, children, depth + 1);
  }
  for (const entry of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const button = element('button', 'browser-file', `${entry.status || ''}  ${$('#browser-view').value === 'files' ? entry.path : entry.path.split('/').at(-1)}`);
    button.type = 'button'; button.title = entry.path;
    button.onclick = () => previewWorkspace(entry, browserVersion);
    parent.append(button);
  }
}
async function refreshBrowser() {
  const version = ++browserVersion;
  browserFile = null; $('#browser-attach').disabled = true;
  $('#browser-list').replaceChildren(); $('#browser-preview').textContent = '';
  $('#browser-diff-meta').hidden = true;
  $('#browser-status').textContent = 'Loading…';
  try {
    if (browserMode === 'list' && $('#browser-view').value === 'files') {
      const result = await api.browseWorkspace(browserSession, 'files');
      if (version !== browserVersion) return;
      renderChangeTree($('#browser-list'), result.entries);
      $('#browser-status').textContent = result.truncated ? 'Partial file list: limited to 1,000 files and 200 folders. Use Tree to browse further.' : `${result.entries.length} files. Select a file to preview it.`;
    } else if (browserMode === 'list') await fillBrowser($('#browser-list'), '', version);
    else if (browserMode === 'session') {
      const session = state.sessions.find(s => s.id === browserSession);
      const files = new Map();
      for (const item of session?.items || []) {
        if (item.type !== 'fileChange' || item.status !== 'completed') continue;
        for (const change of item.changes || []) {
          const path = change.path.replace(/\\/g, '/');
          const entry = files.get(path) || { path, status: '', diff: '' };
          if (change.diff) entry.diff += (entry.diff ? '\n' : '') + change.diff;
          files.set(path, entry);
        }
      }
      renderChangeTree($('#browser-list'), [...files.values()]);
      $('#browser-status').textContent = files.size ? `${files.size} files · Recorded edits in session order, not a net Git diff. Shell or external edits may not be recorded.` : 'No completed file edits recorded for this session.';
    } else {
      const result = await api.browseWorkspace(browserSession, 'changes');
      if (version !== browserVersion) return;
      for (const kind of ['staged', 'unstaged', 'untracked']) {
        const entries = result.entries.filter(e => e.kind === kind);
        if (!entries.length) continue;
        $('#browser-list').append(element('h3', '', `${kind} (${entries.length})`));
        renderChangeTree($('#browser-list'), entries);
      }
      $('#browser-status').textContent = !result.available ? 'Git is unavailable or this is not a Git repository.' : !result.entries.length ? 'Working tree clean.' : result.truncated ? 'First 1,000 changes shown.' : 'Select a change to view its diff.';
    }
    if (browserMode === 'list' && $('#browser-view').value === 'tree' && version === browserVersion) $('#browser-status').textContent = 'Expand folders on demand. Select a file to preview it.';
  } catch (error) { if (version === browserVersion) $('#browser-status').textContent = error.message; }
}
$('#browse-session').onclick = () => showWorkspace('session');
$('#browse-files').onclick = () => showWorkspace('list');
$('#browse-changes').onclick = () => showWorkspace('changes');
$('#browser-refresh').onclick = refreshBrowser;
$('#browser-view').onchange = () => { localStorage.setItem('browserView', $('#browser-view').value); refreshBrowser(); };
$('#browser-maximize').onclick = () => {
  const expanded = $('#browser-dialog').classList.toggle('browser-expanded');
  $('#browser-maximize').title = expanded ? 'Restore panel size' : 'Expand panel';
  $('#browser-maximize').setAttribute('aria-label', $('#browser-maximize').title);
};
$('#browser-dialog').addEventListener('close', () => { ++browserVersion; });
$('#browser-attach').onclick = () => {
  if (!browserFile || browserSession !== selectedId) return;
  $('#prompt').value += `${$('#prompt').value ? '\n\n' : ''}File: ${JSON.stringify(browserFile)}`;
  $('#prompt').dispatchEvent(new Event('input', { bubbles: true }));
  $('#browser-dialog').close(); $('#prompt').focus();
};
function render() {
  if (!state) return;
  probeWorkspace();
  document.documentElement.style.setProperty('--font-scale', (state.settings.fontScale || 100) / 100);
  $('#benchmark-summary').textContent = state.benchmarks ? `${state.benchmarks.records} benchmark records · ${state.benchmarks.matched}/${state.benchmarks.workers} models matched` : 'Routing benchmarks';
  const session = current();
  const ready = state.connection === 'ready';
  const providers = connectedProviders();
  const connecting = state.connection === 'connecting';
  $('#connection-dot').className = `dot ${providers.length || ready ? 'ready' : ''}`;
  $('#connection-label').textContent = connecting && !providers.length
    ? 'Connecting…'
    : `Connected Providers: ${providers.length}`;
  $('#workspace-name').textContent = basename(state.settings.workspace);
  $('#workspace').title = state.settings.workspace;
  $('#session-title').textContent = session?.title || 'New session';
  $('#session-path').textContent = session?.workspace || state.settings.workspace;
  const compactable = session?.activeProvider === 'claude-cli' ? !!session.claudeSessionId : session?.activeProvider !== 'cursor-cli' && !!session?.threadId;
  $('#context-meter').disabled = !compactable || !ready || !session?.items.some(item => item.type === 'userMessage') || !!state.busy || submitting;
  $('#context-search').disabled = !!state.busy || !state.contextRoot;
  const permission = state.accessModes.find(mode => mode.id === (session?.access || draftAccess || state.settings.access));
  for (const select of [$('#permissions'), $('#settings-access')]) {
    if (!select.options.length) for (const mode of state.accessModes) select.add(new Option(mode.label, mode.id));
  }
  $('#permissions').value = permission.id;
  $('#permissions').title = permission.description;
  $('#permissions').disabled = changingPermissions || submitting || !!(session && state.busy === session.id);
  $('#permissions').classList.toggle('full-access', permission.id === 'danger-full-access');
  $('#permissions-detail').textContent = permission.description;
  $('#browse-session').disabled = !selectedId;
  $('#quick-routing').value = state.settings.routing;
  $('#quick-routing').disabled = !!state.planRouting;
  $('#quick-routing').title = state.planRouting ? state.planRouting.reason : state.jev.configured ? 'Choose Smart or Jev routing' : 'Choose routing. Add a Jev key in Settings to enable Jev.';
  $('#quick-routing option[value="jev"]').disabled = !state.jev.configured;
  $('#jev-status').textContent = state.jev.configured ? 'Key saved' : 'No key saved';
  $('#settings-routing').onchange();
  $('#jev-test').disabled = !state.jev.configured || !!state.busy || testingJev;
  $('#jev-remove').disabled = !state.jev.configured || !!state.busy || testingJev;
  $('#jev-save').disabled = !!state.busy || testingJev;
  clearTimeout(noticeTimer);
  const sticky = state.error || (state.busy && state.busy !== selectedId ? 'Another session is working. You can browse here while it finishes.' : '');
  const noticeExpiresAt = session?.noticeExpiresAt ?? (session?.notice?.startsWith('Context compacted.') ? 0 : Infinity);
  let flash = session?.error || (Date.now() < noticeExpiresAt ? session?.notice : '') || '';
  if (sticky || !flash) bannerShown = { text: '', at: 0 };
  else {
    const key = `${session?.id || ''}:${flash}`;
    if (bannerShown.text !== key) bannerShown = { text: key, at: Date.now() };
    const left = 5000 - (Date.now() - bannerShown.at);
    if (left <= 0) flash = '';
    else noticeTimer = setTimeout(render, left);
  }
  $('#banner').textContent = sticky || flash;
  $('#banner').hidden = !$('#banner').textContent;
  const preset = $('#preset');
  const availablePresets = state.presets.filter(p => p.available);
  if ([...preset.options].slice(1).map(o => o.value).join('|') !== availablePresets.map(p => p.id).join('|')) {
    preset.replaceChildren(new Option('Auto · choose for me', 'auto'));
    for (const p of availablePresets) { const option = new Option(p.label, p.id); preset.add(option); }
  }
  for (const option of [...preset.options].slice(1)) {
    option.textContent = availablePresets.find(p => p.id === option.value).label;
  }
  preset.value = availablePresets.some(p => p.id === state.settings.mode) ? state.settings.mode : 'auto';
  const query = $('#search').value.toLowerCase();
  const sessions = state.sessions.filter(s => !s.archived && (s.title + s.workspace).toLowerCase().includes(query));
  $('#session-count').textContent = sessions.length;
  const fragment = document.createDocumentFragment();
  for (const s of sessions) {
    const button = element('button', `session-button${s.id === selectedId ? ' active' : ''}`);
    button.dataset.sessionId = s.id;
    button.append(element('strong', '', s.title));
    button.append(element('small', '', `${s.status === 'running' ? '● Working' : basename(s.workspace)} · ${new Date(s.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`));
    button.addEventListener('click', () => selectSession(s.id));
    const row = element('div', 'session-row');
    const actions = element('div', 'session-actions');
    const rename = element('button', '', '✎');
    rename.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/></svg>';
    rename.type = 'button'; rename.title = 'Rename session'; rename.setAttribute('aria-label', `Rename ${s.title}`);
    rename.onclick = () => { $('#rename-dialog').dataset.sessionId = s.id; $('#rename-input').value = s.title; $('#rename-dialog').showModal(); $('#rename-input').select(); };
    const remove = element('button', 'session-delete', '×');
    remove.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    remove.type = 'button'; remove.title = 'Delete session'; remove.setAttribute('aria-label', `Delete ${s.title}`);
    if (s.id === selectedId) remove.id = 'delete-session';
    remove.disabled = submitting || deletingSession || state.busy === s.id || s.status === 'running';
    remove.onclick = () => { $('#delete-dialog').dataset.sessionId = s.id; $('#delete-title').textContent = s.title; $('#delete-dialog').showModal(); };
    actions.append(rename, remove); row.append(button, actions); fragment.append(row);
  }
  if (!sessions.length) fragment.append(element('div', 'empty-sessions', 'Your sessions will appear here. Start with a question below.'));
  $('#sessions').replaceChildren(fragment);
  $('#welcome').hidden = !!session?.items.length || !!session?.pendingMessage;
  renderSendButton();
  $('#message-queue').replaceChildren();
  for (const message of session?.queue || []) {
    const row = element('div', 'queued-message');
    const text = element('span', '', `${message.error ? 'Paused' : 'Queued'}: ${message.text}${message.images.length ? ` (${message.images.length} images)` : ''}`);
    text.title = message.error || message.text;
    row.append(text);
    for (const [action, label] of [[state.busy ? 'steer' : 'send', state.busy ? '↵ Steer' : 'Send now'], ['edit', '✎'], ['remove', '×']]) {
      const button = element('button', 'compact-action', label);
      button.type = 'button';
      button.classList.add(`queue-${action}`);
      if (action === 'steer') button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 5v7a3 3 0 0 1-3 3H5m4-4-4 4 4 4"/></svg><span>Steer</span>';
      if (action === 'edit') button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/></svg>';
      if (action === 'remove') button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
      button.setAttribute('aria-label', action === 'remove' ? 'Remove queued message' : action === 'edit' ? 'Edit queued message' : label);
      button.disabled = (action === 'steer' && !providerCaps(session.activeProvider).steer) || !!session.queueSending || (action !== 'remove' && (message.uncertain || (action !== 'edit' && (!ready || (state.busy && (state.busy !== selectedId || !session.turnId || session.compacting))))));
      button.title = action === 'edit' ? 'Move back to the composer to edit and resend' : button.getAttribute('aria-label');
      button.onclick = async () => {
        try {
          if (action === 'edit' && ($('#prompt').value.trim() || attachedImages().length || readingImages || submitting)) throw new Error('Send or clear your current draft before editing a queued message.');
          const edited = await api.queuedMessage(session.id, message.id, action);
          if (action === 'edit') {
            drafts.set(session.id, edited.text); imageDrafts.set(session.id, edited.images);
            if (selectedId === session.id) {
              $('#prompt').value = edited.text; $('#preset').value = edited.mode;
              renderImages(); updatePreview(); $('#prompt').focus();
            }
          }
        } catch (error) { notify(error); }
      };
      row.append(button);
    }
    $('#message-queue').append(row);
  }
  $('#send').disabled = !ready || changingPermissions || submitting || readingImages || (!$('#prompt').value.trim() && !attachedImages().length);
  renderImages();
  $('#working').hidden = !state.busy || state.busy !== selectedId || !!session?.pendingMessage;
  const turnError = state.busy === selectedId ? '' : session?.error || '';
  $('#turn-error').textContent = turnError ? `${session.status === 'interrupted' ? 'Stopped' : 'Turn failed'}: ${turnError}` : '';
  $('#turn-error').hidden = !turnError;
  renderModelFetching();
  $('#working-text').textContent = session?.compacting ? 'Compacting conversation context…' : state.routing === selectedId && state.routing
    ? `Choosing a model with ${routerName(state.routerModel)}…` : `${session?.routes.at(-1)?.label || 'Codex'} is working…`;
  const usage = session?.usage;
  const total = usage?.total;
  const contextWindow = usage?.modelContextWindow;
  const contextTokens = usage?.last?.totalTokens ?? (Number.isFinite(usage?.last?.inputTokens) && Number.isFinite(usage?.last?.outputTokens) ? usage.last.inputTokens + usage.last.outputTokens : null);
  const contextKnown = providerCaps(session?.activeProvider).usage && Number.isFinite(contextTokens) && contextTokens >= 0 && Number.isFinite(contextWindow) && contextWindow > 0;
  const contextPercent = contextKnown ? Math.min(100, Math.max(0, contextTokens / contextWindow * 100)) : 0;
  const contextLabel = contextKnown ? `${Math.round(contextPercent)}% context used (estimate from the latest provider report: ${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens)` : 'Context usage unavailable until the provider reports the context size and token usage.';
  $('#context-meter').style.setProperty('--context-used', `${contextPercent}%`);
  $('#context-meter').classList.toggle('unknown', !contextKnown);
  $('#context-meter').setAttribute('aria-label', `${contextLabel}. Compact context`);
  $('#context-meter-tip').textContent = !providerCaps(session?.activeProvider).usage ? 'Cursor manages context automatically and reports no token usage.' : contextLabel + (session?.compacting ? '\nCompacting context…' : '\nClick to compact context.');
  const compact = n => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const hasBreakdown = Number.isFinite(total?.inputTokens) && Number.isFinite(total?.cachedInputTokens) && Number.isFinite(total?.outputTokens);
  const providerHover = providerConnectionSummary();
  $('#usage').textContent = !providerCaps(session?.activeProvider).usage ? 'Usage tracked by Cursor' : hasBreakdown
    ? `${compact(total.inputTokens)} input · ${total.inputTokens ? Math.round(total.cachedInputTokens / total.inputTokens * 100) : 0}% cached · ${compact(total.outputTokens)} output`
    : total?.totalTokens !== undefined ? `${compact(total.totalTokens)} reported tokens` : 'Connected';
  $('#usage').title = providerHover + (hasBreakdown
    ? `\n\nSession totals: ${total.inputTokens.toLocaleString()} input (${total.cachedInputTokens.toLocaleString()} cached, ${Math.max(0, total.inputTokens - total.cachedInputTokens).toLocaleString()} uncached), ${total.outputTokens.toLocaleString()} output. Reasoning is included in output. Latest request input: ${usage.last?.inputTokens?.toLocaleString() ?? 'unknown'}. These are token counts, not dollars or allowance usage.`
    : '\n\nHover lists providers. Token totals appear after the provider reports usage.');
  renderMessages(session);
  renderRequest();
}

function providerConnectionSummary() {
  if (!state) return '';
  const lines = [
    `ChatGPT · ${state.account ? 'connected' : state.codex?.installed === false ? 'Codex CLI not installed' : 'not connected'}${state.account?.email ? ' · ' + state.account.email : ''}`,
    `Claude · ${claudeInUse() ? claudeDetail(state.claude) : state.claude?.loggedIn ? KEPT_SIGNED_IN : state.claude?.installed === false ? 'not installed' : 'not connected'}`,
    `Cursor · ${cursorInUse() ? (state.cursor.email || state.cursor.identity || 'connected') : state.cursor?.loggedIn ? KEPT_SIGNED_IN : state.cursor?.installed === false ? 'not installed' : 'not connected'}`,
  ];
  return lines.join('\n');
}

function renderMessages(session) {
  const container = $('#conversation');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  if (renderedSession !== selectedId) { $('#messages').replaceChildren(); messageNodes.clear(); renderedSession = selectedId; }
  const ids = new Set();
  const maintenance = (session?.routes || []).filter(route => route.wikiMaintenanceTaskId);
  for (const item of [...(session?.items || []), ...(session?.pendingMessage ? [session.pendingMessage] : [])]) {
    if (item.internal || maintenance.some(route => route.messageId === (item.clientId || item.id) || (route.turnId && route.turnId === item.turnId))) continue;
    ids.add(item.id);
    let entry = messageNodes.get(item.id);
    const selected = item.type === 'userMessage' ? session.routes.find(r => r.messageId === (item.clientId || item.id)) : null;
    const signature = JSON.stringify([item, selected]);
    if (entry?.signature === signature) continue;
    if (!entry) {
      const node = document.createElement('div');
      entry = { node }; messageNodes.set(item.id, entry); $('#messages').append(node);
    }
    entry.signature = signature;
    const node = entry.node;
    if (item.type === 'userMessage' || item.type === 'agentMessage' || item.type === 'plan') {
      const user = item.type === 'userMessage';
      node.className = `message ${user ? 'user' : item.phase === 'commentary' ? 'commentary' : 'assistant'}`;
      const label = element('div', 'message-label', user ? 'You' : item.type === 'plan' ? 'Plan' : 'Codex');
      const routeLabel = selected?.label || item.routeLabel;
      if (routeLabel && !user) label.append(element('span', 'model-label', routeLabel));
      const body = element('div', 'message-body');
      const text = user ? item.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : item.text || '';
      const actions = element('div', 'message-actions');
      const timestamp = item.createdAt || selected?.at;
      if (timestamp) {
        const time = element('time', '', new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        time.dateTime = new Date(timestamp).toISOString(); time.title = new Date(timestamp).toLocaleString();
        actions.append(time);
      }
      if (text) {
        const copy = element('button', 'message-copy');
        const icon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="12" height="12" rx="3"/><path d="M9 8V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2"/></svg>';
        copy.innerHTML = icon;
        copy.type = 'button'; copy.title = 'Copy message text'; copy.setAttribute('aria-label', user ? 'Copy sent message' : 'Copy reply');
        copy.onclick = async () => {
          try { await api.copyText(text); copy.textContent = '✓'; copy.title = 'Copied'; setTimeout(() => { copy.innerHTML = icon; copy.title = 'Copy message text'; }, 1500); }
          catch (error) { notify(error); }
        };
        actions.append(copy);
      }
      body.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true }), {
        FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'button', 'video', 'audio', 'svg', 'math'],
        FORBID_ATTR: ['style'],
      });
      for (const equation of body.querySelectorAll('[data-equation]')) {
        try { katex.render(decodeURIComponent(equation.dataset.equation), equation, { displayMode: equation.dataset.display === 'true', throwOnError: false, trust: false, maxExpand: 100, maxSize: 20 }); }
        catch { equation.textContent = 'Equation could not be displayed.'; }
      }
      if (user) {
        const bubble = element('div', 'message-bubble');
        bubble.append(body);
        node.replaceChildren(label, bubble, actions);
      } else node.replaceChildren(label, body, actions);
      if (user) for (const part of item.content) {
        if (part.type === 'image' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(part.url || '')) {
          const image = element('img', 'message-image'); image.src = part.url; image.alt = 'Attached image'; body.append(image);
        }
      }
      entry.routeNode?.remove(); entry.routeNode = null;
      if (item.pending || selected) {
        const row = element('div', 'routing-row');
        entry.routeNode = row; node.after(row);
        if (item.pending) row.append(element('p', 'routing-status', item.error ? `Not sent: ${item.error}` : state.planRouting ? state.planRouting.reason : `Choosing a model with ${routerName(state.routerModel)}…`));
        else if (selected.source === 'manual') row.append(element('p', 'muted', `Model: ${selected.label} · manual selection`));
      }
      if (selected && selected.source !== 'manual') {
        const details = element('details', 'activity');
        const meter = selected.router;
        const cost = meter ? ` · ${meter.skipped ? 'local preflight · no model call' : routerName(meter.model, meter.effort)} · ${(meter.durationMs / 1000).toFixed(1)}s${meter.usage ? ` · ${meter.usage.totalTokens.toLocaleString()} router tokens` : ''}` : ' · no model call';
        const chooser = selected.source === 'jev' ? routerName(meter?.model)
          : selected.source === 'model' ? routerName(meter?.model, meter?.effort)
          : selected.source === 'fallback' ? 'Fallback routing'
          : 'Local routing';
        details.append(element('summary', '', selected.directAnswer ? `${chooser} answered directly` : `${chooser} selected ${selected.label}`), element('p', '', `${selected.directAnswer ? 'Jev selected itself using available context; no worker call. Confidence is uncalibrated.' : selected.reason}${cost}`));
        if (meter?.provider === 'typesafe' && meter.estimatedCostUsd !== undefined) {
          details.append(element('p', '', `TypeSafe estimate: $${meter.estimatedCostUsd.toFixed(6)} · ${meter.usage.inputTokens.toLocaleString()} input tokens`));
          details.append(element('p', '', `Jev distribution confidence: ${(meter.confidence * 100).toFixed(0)}%. This is not a measured probability of choosing the right worker.`));
        }
        if (selected.assessment) details.append(element('p', '', `Task: ${selected.assessment.taskKind}${typeof selected.assessment.needsChecks === 'boolean' ? ' · Checks: ' + (selected.assessment.needsChecks ? 'run if configured' : 'not needed') : ''} · Risk: ${selected.assessment.risk} · Uncertainty: ${selected.assessment.uncertainty}`));
        if (meter?.evidence) {
          details.append(element('p', '', `Workspace: ${meter.evidence.changedFiles} changed files; ${meter.evidence.sampledFiles.length} sampled. ${meter.evidence.coverage} evidence.`));
          details.append(element('p', '', [...meter.evidence.signals, ...meter.evidence.limitations].join(' · ')));
        }
        entry.routeNode.append(details);
      }
    } else {
      const opened = node.querySelector('details')?.open || false;
      const details = element('details', 'activity'); details.open = opened;
      let title = item.type, detail = '';
      if (item.type === 'commandExecution') { title = `${item.status === 'inProgress' ? 'Running' : item.exitCode ? 'Failed' : 'Ran'} · ${item.command}`; detail = item.aggregatedOutput || 'Waiting for output…'; }
      if (item.type === 'fileChange') { title = `${item.status === 'inProgress' ? 'Editing' : 'Changed'} ${item.changes.length} file${item.changes.length === 1 ? '' : 's'}`; detail = item.changes.map(c => c.path + '\n' + (c.diff || '')).join('\n\n'); }
      if (item.type === 'mcpToolCall') { title = `${item.server} · ${item.tool} · ${item.status}`; detail = JSON.stringify(item.error || item.result || item.arguments, null, 2); }
      if (item.type === 'dynamicToolCall') { title = `${item.tool} · ${item.status}`; detail = JSON.stringify(item.contentItems || item.arguments, null, 2); }
      if (item.type === 'webSearch') { title = `Web search · ${item.query || item.action?.query || ''}`; detail = JSON.stringify(item.action || {}, null, 2); }
      if (item.type === 'contextCompaction') title = 'Conversation context compacted';
      details.append(element('summary', '', title), element('pre', '', detail)); node.replaceChildren(details);
    }
  }
  for (const [id, entry] of messageNodes) if (!ids.has(id)) { entry.node.remove(); entry.routeNode?.remove(); messageNodes.delete(id); }
  if (atBottom) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

async function selectSession(id) {
  sentHistory = null; sentHistoryIndex = -1;
  drafts.set(selectedId || 'new', $('#prompt').value);
  selectedId = id; $('#prompt').value = drafts.get(id || 'new') || '';
  render(); updatePreview();
  requestAnimationFrame(() => { $('#conversation').scrollTop = $('#conversation').scrollHeight; });
  if (id) try { applyState(await api.load(id)); } catch (error) { notify(error); }
}

function renderSendButton() {
  const hasDraft = !!$('#prompt').value.trim() || attachedImages().length > 0;
  $('#send').hidden = !!state?.busy && !hasDraft;
  $('#send').innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
  $('#send').title = state?.busy ? 'Queue message' : 'Send message';
  $('#send').setAttribute('aria-label', $('#send').title);
  const checking = (current()?.tasks || []).some(task => task.state === 'checking' || task.state === 'correcting');
  $('#stop').hidden = checking ? false : !state?.busy || hasDraft;
}

async function updatePreview() {
  renderSendButton();
  const version = ++routeVersion;
  const prompt = $('#prompt').value;
  $('#send').disabled = state?.connection !== 'ready' || changingPermissions || submitting || readingImages || (!prompt.trim() && !attachedImages().length);
  if (!prompt.trim()) {
    const selected = state?.presets.find(p => p.id === $('#preset').value);
    $('#route-preview').replaceChildren(element('span', 'route-dot'), element('strong', '', selected?.label || 'Auto'), element('span', '', selected ? 'Your manual selection.' : 'Task context is checked when you send.'));
    return;
  }
  try {
    const selected = await api.preview(selectedId, prompt, $('#preset').value);
    if (version !== routeVersion) return;
    $('#route-preview').replaceChildren(element('span', 'route-dot'), element('strong', '', selected.provisional ? 'Smart Auto' : selected.label), element('span', '', selected.reason));
  } catch (error) { notify(error); }
}

function renderRequest() {
  const request = state.requests[0];
  const dialog = $('#request-dialog');
  if (!request) { if (dialog.open) dialog.close(); shownRequest = null; return; }
  if (shownRequest === request.id) return;
  shownRequest = request.id;
  const content = $('#request-content'); content.replaceChildren();
  const session = state.sessions.find(s => s.threadId === request.params.threadId);
  content.append(element('div', 'request-context', session?.title || 'Current task'));
  const finish = async answer => { try { await api.answer(request.id, answer); } catch (error) { notify(error); } };
  if (/requestUserInput/.test(request.method)) {
    content.append(element('h2', '', 'Codex has a question'));
    const fields = [];
    for (const question of request.params.questions) {
      const label = element('label', '', question.question);
      const input = document.createElement('input'); input.type = question.isSecret ? 'password' : 'text';
      label.append(input); fields.push({ id: question.id, input });
      const options = element('div', 'answer-options');
      for (const option of question.options || []) {
        const button = element('button', '', option.label); button.title = option.description;
        button.onclick = () => { input.value = option.label; }; options.append(button);
      }
      label.append(options); content.append(label);
    }
    const button = element('button', 'primary', 'Send answers');
    button.onclick = () => finish({ answers: Object.fromEntries(fields.map(f => [f.id, f.input.value])) }); content.append(button);
  } else {
    const mcp = request.method === 'mcpServer/elicitation/request';
    const unsupported = mcp && !request.canAccept;
    content.append(element('h2', '', unsupported ? 'A connected tool needs input' : 'Permission requested'));
    if (mcp) {
      content.append(element('p', 'muted', `Connected tool: ${request.params.serverName}`));
      content.append(element('p', '', request.params.message));
      if (unsupported) content.append(element('p', 'muted', 'This request needs a form or URL flow that this client cannot display yet. Decline to let Codex continue another way.'));
      const details = element('details', 'activity');
      details.append(element('summary', '', 'Request details'), element('pre', '', JSON.stringify(request.params, null, 2)));
      content.append(details);
    } else {
      content.append(element('p', 'muted', request.params.reason || 'Review this action before allowing it.'));
      content.append(element('pre', '', request.params.command || JSON.stringify(request.params.permissions || request.params, null, 2)));
    }
    const actions = element('div', 'dialog-footer');
    const decline = element('button', '', 'Decline'); decline.onclick = () => finish({ decision: 'decline' }); actions.append(decline);
    if (!unsupported) { const allow = element('button', 'primary', 'Allow once'); allow.onclick = () => finish({ decision: 'accept' }); actions.append(allow); }
    content.append(actions);
  }
  const stop = element('button', 'icon-button', 'Stop task'); stop.onclick = () => api.stop().catch(notify); content.append(stop);
  if (!dialog.open) dialog.showModal();
}

$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#prompt').value.trim();
  const images = attachedImages().slice();
  if ((!text && !images.length) || readingImages || submitting || changingPermissions || state.connection !== 'ready') return;
  submitting = true;
  $('#send').disabled = true;
  $('#permissions').disabled = true;
  try {
    if (!selectedId) {
      const session = await api.create(state.settings.workspace, draftAccess || state.settings.access);
      selectedId = session.id;
      draftAccess = null;
      drafts.delete('new');
      imageDrafts.delete('new');
      if (!state.sessions.some(s => s.id === session.id)) state.sessions.unshift(session);
    }
    sentHistory = null; sentHistoryIndex = -1;
    drafts.set(selectedId, ''); $('#prompt').value = ''; updatePreview();
    imageDrafts.delete(selectedId); renderImages();
    await api.send({ id: selectedId, text, images, mode: $('#preset').value, task: 'on' });
  } catch (error) {
    if (!$('#prompt').value) { $('#prompt').value = text; drafts.set(selectedId, text); }
    if (images.length) imageDrafts.set(selectedId || 'new', images);
    updatePreview(); notify(error);
  } finally { submitting = false; render(); }
});
$('#prompt').addEventListener('input', () => { sentHistory = null; sentHistoryIndex = -1; updatePreview(); });
$('#prompt').addEventListener('keydown', event => {
  if (!event.isComposing && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
    const prompt = $('#prompt');
    if (event.key === 'ArrowUp' && !prompt.value && !attachedImages().length && !sentHistory) {
      sentHistory = (current()?.items || []).filter(i => i.type === 'userMessage' && !i.pending)
        .map(i => (i.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')).filter(Boolean).reverse();
      sentHistoryIndex = -1;
    }
    if (sentHistory?.length) {
      event.preventDefault();
      sentHistoryIndex = Math.max(-1, Math.min(sentHistory.length - 1, sentHistoryIndex + (event.key === 'ArrowUp' ? 1 : -1)));
      prompt.value = sentHistory[sentHistoryIndex] || '';
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      updatePreview();
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); }
});
$('#new-session').onclick = () => { selectSession(null); $('#prompt').focus(); };
$('#preset').onchange = async () => { try { applyState(await api.settings({ mode: $('#preset').value })); updatePreview(); } catch (error) { notify(error); } };
$('#permissions').onchange = async () => {
  const access = $('#permissions').value;
  if (!selectedId) { draftAccess = access; render(); return; }
  changingPermissions = true; render();
  try { applyState(await api.permissions(selectedId, access)); }
  catch (error) { notify(error); }
  finally { changingPermissions = false; render(); }
};
$('#stop').onclick = () => api.stop().catch(notify);
$('#search').oninput = render;
async function chooseWorkspace(settingsOnly = false) {
  try {
    const folder = await api.chooseWorkspace();
    if (!folder) return;
    if (settingsOnly) { $('#settings-workspace').value = folder; return; }
    applyState(await api.settings({ workspace: folder }));
    await selectSession(null);
  } catch (error) { notify(error); }
}
$('#workspace').onclick = () => chooseWorkspace();
$('#settings-browse').onclick = () => chooseWorkspace(true);
function renderRoutingModels(selected = $('#settings-router-preset').value || state.settings.routerPreset) {
  const select = $('#settings-router-preset');
  select.replaceChildren(...state.routerPresets.map(p => {
    const option = new Option(`${p.label} · ${p.provider}${!p.available ? ' · unavailable' : ''}`, p.id);
    option.disabled = !p.available;
    return option;
  }));
  if (!state.routerPresets.some(p => p.id === selected)) {
    const placeholder = new Option(state.routerPresets.length ? 'Choose an enabled routing model' : 'Enable a routing model in Providers', '');
    placeholder.disabled = true;
    select.prepend(placeholder);
    selected = '';
  }
  select.value = selected;
}
$('#settings').onclick = async () => {
  try { applyState(await api.bootstrap()); }
  catch (error) { notify(error); return; }
  $('#settings-workspace').value = state.settings.workspace; $('#settings-access').value = state.settings.access;
  $('#settings-access').onchange();
  $('#settings-routing').value = state.settings.routing;
  renderRoutingModels(state.settings.routerPreset);
  $('#settings-context').value = state.settings.contextRanking || 'local';
  $('#settings-tools').value = state.settings.toolSelection || 'off';
  $('#settings-output').value = state.settings.largeResponses === false ? 'off' : 'on';
  $('#settings-quick').value = state.settings.jevQuickAnswers === false ? 'off' : 'on';
  $('#settings-font').value = String(state.settings.fontScale || 100);
  $('#settings-routing').onchange();
  $('#jev-key').value = '';
  $('#jev-result').textContent = '';
  renderProviders();
  $('#settings-dialog').showModal();
};
$('#settings-access').onchange = () => {
  $('#settings-access-detail').textContent = state.accessModes.find(mode => mode.id === $('#settings-access').value).description;
};
let benchmarkCandidate = null;
function renderBenchmarkTable(data) {
  $('#benchmark-table').replaceChildren(...data.records.map(record => {
    const row = element('tr');
    row.append(element('td', '', `${record.model} · ${record.effort}`),
      element('td', '', `${record.source} ${record.version} (${record.harness})`),
      element('td', '', Object.entries(record.metrics).map(([key, value]) => `${key}: ${value}`).join(' · ')));
    return row;
  }));
}
async function showBenchmarks() {
  const { data, summary } = await api.benchmarkData();
  benchmarkCandidate = null;
  $('#benchmark-apply').disabled = true;
  $('#benchmark-status').textContent = `${summary.records} records · ${summary.matched}/${summary.workers} enabled model/effort combinations matched · checked ${summary.updatedAt}. ${summary.warning || ''}`;
  $('#benchmark-preview').textContent = JSON.stringify(data, null, 2);
  renderBenchmarkTable(data);
  $('#benchmark-sources').replaceChildren(...summary.sources.map(source => {
    const row = element('p', 'muted');
    const link = element('a', '', source.name); link.href = source.url;
    link.onclick = event => { event.preventDefault(); api.openLink(source.url).catch(notify); };
    row.append(link, document.createTextNode(` · ${source.records ? source.records + ' records' : 'refresh target; no imported results'}`));
    return row;
  }));
  const workers = state.presets.filter(p => p.available && p.enabled !== false && p.id !== 'jev');
  $('#benchmark-worker').replaceChildren(...workers.map(p => new Option(p.label, p.id)));
  const suggested = workers.find(p => p.model === 'gpt-6-astra' && p.effort === 'xhigh');
  if (suggested) $('#benchmark-worker').value = suggested.id;
  $('#benchmark-refresh').disabled = !!state.busy || !workers.length;
  $('#benchmark-reset').disabled = !!state.busy;
}
$('#benchmark-open').onclick = async () => {
  try { await showBenchmarks(); $('#benchmark-dialog').showModal(); } catch (error) { notify(error); }
};
$('#benchmark-import').onclick = async () => {
  try {
    const candidate = await api.benchmarkImport();
    if (!candidate) return;
    benchmarkCandidate = candidate;
    $('#benchmark-preview').textContent = JSON.stringify(candidate, null, 2);
    renderBenchmarkTable(candidate);
    $('#benchmark-preview').closest('details').open = true;
    $('#benchmark-status').textContent = `Candidate: ${candidate.records.length} records, checked ${candidate.updatedAt}. Replaces the active table. Review scores and source links before applying; format validation does not verify factual accuracy.`;
    $('#benchmark-apply').disabled = !!state.busy;
  } catch (error) { notify(error); }
};
$('#benchmark-apply').onclick = async () => {
  try {
    if (!benchmarkCandidate) return;
    applyState(await api.benchmarkApply(benchmarkCandidate));
    await showBenchmarks();
    $('#benchmark-status').textContent += ' Applied for the next automatic route.';
  } catch (error) { notify(error); }
};
$('#benchmark-reset').onclick = async () => {
  try { applyState(await api.benchmarkReset()); await showBenchmarks(); } catch (error) { notify(error); }
};
$('#benchmark-refresh').onclick = async () => {
  const button = $('#benchmark-refresh'); button.disabled = true;
  try {
    if (state.busy) throw new Error('Finish the current turn before preparing a benchmark refresh.');
    const mode = $('#benchmark-worker').value;
    if (!mode) throw new Error('Choose a connected refresh worker first.');
    const { prompt, workspace } = await api.benchmarkRefresh();
    const session = await api.create(workspace, 'workspace-write');
    applyState(await api.settings({ mode }));
    $('#benchmark-dialog').close(); $('#settings-dialog').close();
    await selectSession(session.id);
    drafts.set(session.id, prompt); $('#prompt').value = prompt; updatePreview(); $('#prompt').focus();
    notify('Refresh task prepared. Review the selected worker and press Send when ready.');
  } catch (error) { notify(error); }
  finally { button.disabled = !!state.busy || !$('#benchmark-worker').value; }
};
$('#settings-routing').onchange = () => {
  const provider = $('#settings-routing').value;
  $('#settings-router-preset').disabled = provider !== 'smart' || !!state.planRouting;
  $('#router-detail').textContent = state.planRouting ? state.planRouting.reason + ' This overrides the saved routing preference.' : provider === 'jev' && !state.jev.configured ? 'Save your Jev API key below to enable this routing option, then save settings.'

    : provider === 'jev' ? 'Jev picks the model and effort for each Auto prompt.'
    : 'The routing model picks the model and effort for each Auto prompt.';
};
$('#jev-save').onclick = async () => {
  const key = $('#jev-key').value; $('#jev-key').value = '';
  try { applyState(await api.jevSaveKey(key)); $('#jev-result').textContent = 'Key saved. Test the connection, then select Jev above and save settings.'; }
  catch (error) { notify(error); }
};
$('#jev-test').onclick = async () => {
  if (testingJev) return;
  testingJev = true; render(); $('#jev-result').textContent = 'Testing Jev with a small sample…';
  try {
    const result = await api.jevTest();
    $('#jev-result').textContent = `${routerName(result.model)} connected · ${(result.durationMs / 1000).toFixed(2)}s · ${result.usage.inputTokens} input tokens · estimated $${result.estimatedCostUsd.toFixed(6)}.`;
  } catch (error) { $('#jev-result').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { testingJev = false; render(); }
};
$('#jev-remove').onclick = async () => {
  try { applyState(await api.jevRemoveKey()); $('#settings-routing').value = state.settings.routing; $('#settings-context').value = state.settings.contextRanking || 'local'; $('#settings-tools').value = state.settings.toolSelection || 'off'; $('#settings-routing').onchange(); $('#jev-result').textContent = 'Saved key removed.'; }
  catch (error) { notify(error); }
};
$('#settings-form').onsubmit = async event => {
  event.preventDefault();
  try { applyState(await api.settings({ jevQuickAnswers: $('#settings-quick').value === 'on', routerPreset: $('#settings-router-preset').value || undefined, workspace: $('#settings-workspace').value, fontScale: Number($('#settings-font').value), access: $('#settings-access').value, routing: $('#settings-routing').value, contextRanking: $('#settings-context').value, toolSelection: $('#settings-tools').value, largeResponses: $('#settings-output').value === 'on' })); updatePreview(); $('#settings-dialog').close(); } catch (error) { notify(error); }
};
$('#context-meter').onclick = async () => {
  try { await api.compact(selectedId); } catch (error) { notify(error); }
};
$('#context-search').onclick = () => {
  contextVersion++;
  contextSessionId = selectedId; contextResult = null;
  $('#context-mode').value = state.settings.contextRanking || 'local';
  $('#context-results').replaceChildren(); $('#context-status').textContent = '';
  $('#context-attach').hidden = true; $('#context-dialog').showModal(); $('#context-query').focus();
};
$('#context-form').onsubmit = async event => {
  event.preventDefault();
  if (searchingContext) return;
  searchingContext = true; contextResult = null;
  const version = contextVersion;
  $('#context-run').disabled = true; $('#context-cancel').hidden = false; $('#context-attach').hidden = true;
  $('#context-results').replaceChildren(); $('#context-status').textContent = 'Searching source, wiki and memory…';
  try {
    const result = await api.findContext(contextSessionId, $('#context-query').value, $('#context-mode').value);
    if (version !== contextVersion || !$('#context-dialog').open) return;
    contextResult = result;
    $('#context-status').textContent = `${result.mode === 'jev' ? 'Jev ranking' : 'Local ranking'} · ${(result.durationMs / 1000).toFixed(1)}s · ${result.files} files · ${result.hits.length} excerpts` +
      (result.jev ? ` · ${result.jev.usage.inputTokens.toLocaleString()} Jev input tokens · estimated $${result.jev.estimatedCostUsd.toFixed(6)}` : '') +
      (result.warnings.length ? '\n' + result.warnings.join(' ') : '');
    for (const hit of result.hits) {
      const card = element('details', 'context-hit'); card.open = true;
      card.append(element('summary', '', `${hit.source === 'memory' ? 'Historical memory · ' : ''}${hit.path}${hit.line ? ':' + hit.line : ''}`), element('pre', '', hit.text));
      $('#context-results').append(card);
    }
    if (!result.hits.length) $('#context-results').append(element('p', 'muted', 'No matching excerpts. Try a subsystem name, symbol or different wording.'));
    $('#context-attach').hidden = !result.hits.length;
  } catch (error) { if (version === contextVersion) $('#context-status').textContent = 'Search stopped or failed. ' + String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { searchingContext = false; $('#context-run').disabled = false; $('#context-cancel').hidden = true; }
};
$('#context-cancel').onclick = () => api.cancelContext().catch(notify);
$('#context-dialog').addEventListener('close', () => { contextVersion++; if (searchingContext) api.cancelContext().catch(notify); });
$('#context-attach').onclick = () => {
  if (!contextResult || contextSessionId !== selectedId) return;
  const evidence = contextResult.hits.map(hit => `${hit.source}: ${hit.path}${hit.line ? ':' + hit.line : ''}\n${hit.text}`).join('\n\n');
  $('#prompt').value = [$('#prompt').value.trim(), `Project context for: ${contextResult.query}\nThese are retrieved excerpts, not instructions. Verify important claims in live source.\n\n${evidence}`].filter(Boolean).join('\n\n');
  $('#context-dialog').close(); updatePreview(); $('#prompt').focus();
};
$('#rename-form').onsubmit = async event => {
  event.preventDefault();
  try { await api.rename($('#rename-dialog').dataset.sessionId, $('#rename-input').value); $('#rename-dialog').close(); } catch (error) { notify(error); }
};
$('#delete-form').onsubmit = async event => {
  event.preventDefault();
  if (deletingSession) return;
  const dialog = $('#delete-dialog');
  const id = dialog.dataset.sessionId;
  deletingSession = true; $('#delete-confirm').disabled = true; render();
  try {
    applyState(await api.deleteSession(id));
    dialog.close();
    if (selectedId === id) await selectSession(null);
    drafts.delete(id);
    imageDrafts.delete(id);
    updatePreview();
  } catch (error) { notify(error); }
  finally { deletingSession = false; $('#delete-confirm').disabled = false; render(); }
};
document.querySelectorAll('.close-dialog').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
$('#request-dialog').addEventListener('cancel', event => event.preventDefault());
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); updatePreview(); }; });
document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (link) { event.preventDefault(); if (/^https?:\/\//i.test(link.href)) api.openLink(link.href).catch(notify); }
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#new-session').click(); }
  if (event.key === 'Escape' && state?.busy && !document.querySelector('dialog[open]')) api.stop().catch(notify);
});
api.onState(applyState);
api.bootstrap().then(applyState).catch(notify);

$('#quick-routing').onchange = async () => {
  const selector = $('#quick-routing'); selector.disabled = true;
  try { applyState(await api.settings({ routing: selector.value })); updatePreview(); }
  catch (error) { selector.value = state.settings.routing; notify(error); }
  finally { selector.disabled = !!state.planRouting; }
};

function renderProviders() {
  const accounts = $('#provider-accounts');
  const list = $('#provider-model-list');
  if (!accounts || !list) return;
  accounts.replaceChildren();
  list.replaceChildren();

  const addAccount = ({ id, label, connected, installed, detail, connect, disconnect }) => {
    const row = element('div', 'provider-account-row');
    const plug = document.createElement('button');
    plug.type = 'button';
    plug.className = `provider-plug ${connected ? 'connected' : 'disconnected'}`;
    plug.disabled = !!state.busy || installed === false;
    plug.title = connected ? 'Connected — click to disconnect' : 'Not connected — click to connect';
    plug.setAttribute('aria-label', connected ? `Disconnect ${label}` : `Connect ${label}`);
    plug.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/></svg>';
    plug.onclick = async () => {
      $('#provider-status').textContent = connected ? `Disconnecting ${label}…` : `Connecting ${label}…`;
      try {
        if (connected) applyState(await disconnect());
        else {
          const result = await connect();
          if (result && result !== state) applyState(result);
        }
        $('#provider-status').textContent = '';
        renderProviders();
        if (!connected) loadDiscoveredModels(id).catch(() => {});
      } catch (e) { $('#provider-status').textContent = e.message; }
    };
    const text = element('div', 'provider-account-text');
    text.append(element('strong', '', label), document.createTextNode(detail ? ` · ${detail}` : ''));
    row.append(plug, text);
    if (installed === false) {
      const install = element('button', 'provider-install', 'Install');
      install.type = 'button';
      install.disabled = !!state.busy;
      install.onclick = async () => {
        install.disabled = true;
        $('#provider-status').textContent = `Installing ${label}…`;
        try {
          applyState(await api.installProvider(id));
          $('#provider-status').textContent = '';
          renderProviders();
        } catch (e) { $('#provider-status').textContent = e.message; install.disabled = false; }
      };
      row.append(install);
    }
    accounts.append(row);
  };

  addAccount({
    id: 'codex',
    label: 'ChatGPT',
    connected: !!state.account,
    installed: state.codex?.installed,
    detail: state.account ? (chatgptDetail(state.account) || 'connected')
      : state.codex?.installed === false ? 'Codex CLI not installed' : state.codex?.installed && !state.codex.connected ? 'Codex not running · restart the app'
        : state.codex?.signedIn ? KEPT_SIGNED_IN : 'not connected',
    connect: async () => {
      const result = await api.connectChatGPT();
      if (!result?.started) return result; // The existing Codex login was reused.
      $('#provider-status').textContent = 'Complete sign-in in your browser.'; return state;
    },
    disconnect: () => api.logoutChatGPT(),
  });
  addAccount({
    id: 'claude-cli',
    label: 'Claude',
    connected: claudeInUse(),
    installed: state.claude?.installed,
    detail: claudeInUse() ? claudeDetail(state.claude) : state.claude?.loggedIn ? KEPT_SIGNED_IN : (state.claude?.installed === false ? 'not installed' : 'not connected'),
    connect: () => api.claudeLogin(),
    disconnect: () => api.claudeLogout(),
  });
  addAccount({
    id: 'cursor-cli',
    label: 'Cursor',
    connected: cursorInUse(),
    installed: state.cursor?.installed,
    detail: cursorInUse()
      ? (state.cursor.email || state.cursor.identity || 'CLI connected')
      : state.cursor?.loggedIn ? KEPT_SIGNED_IN : (state.cursor?.installed === false ? 'not installed' : 'not connected'),
    connect: () => api.cursorLogin(),
    disconnect: () => api.cursorLogout(),
  });

  const catalog = state.providerCatalog || [];
  const groups = [
    { id: 'codex', title: 'Codex / ChatGPT', models: catalog.filter(m => !m.provider || m.provider === 'codex'), gated: !state.account },
    { id: 'claude-cli', title: 'Claude', models: catalog.filter(m => m.provider === 'claude-cli'), gated: !claudeInUse() },
    { id: 'cursor-cli', title: 'Cursor', models: catalog.filter(m => m.provider === 'cursor-cli'), gated: !cursorInUse(), discover: true },
  ];

  for (const group of groups) {
    list.append(element('h4', 'provider-model-group', group.title));
    if (group.gated) {
      list.append(element('p', 'muted', 'Connect this provider to enable its models.'));
      continue;
    }
    if (group.id === 'claude-cli' && !group.models.length) {
      list.append(element('p', 'muted', state.claude?.modelsError || 'No Claude models returned. Click Renew to retry.'));
    }
    if (group.discover) {
      const discovered = discoveredModels.get(group.id) || [];
      const enabledByModel = new Map(group.models.map(m => [m.model, m]));
      const ids = new Set([...discovered.map(d => d.id), ...enabledByModel.keys()]);
      if (!ids.size) {
        list.append(element('p', 'muted', discoveredModels.has(group.id) ? 'No models returned.' : 'Fetching Cursor models…'));
        if (!discoveredModels.has(group.id)) loadDiscoveredModels(group.id).then(() => renderProviders()).catch(e => { $('#provider-status').textContent = e.message; });
      }
      for (const modelId of [...ids].sort()) {
        const existing = enabledByModel.get(modelId);
        const labelText = discovered.find(d => d.id === modelId)?.label || existing?.label || modelId;
        appendModelToggle(list, {
          checked: !!(existing && existing.enabled !== false),
          label: `${labelText} · ${group.title}`,
          onChange: async checked => {
            if (existing) applyState(await api.providerSettings({ action: 'toggle', id: existing.id, enabled: checked }));
            else if (checked) applyState(await api.providerSettings({ action: 'enableDiscovered', provider: group.id, model: modelId, label: labelText }));
            else return;
            renderProviders();
          },
        });
      }
      continue;
    }
    if (group.id === 'codex') {
      const byModel = new Map();
      for (const entry of group.models) {
        const row = byModel.get(entry.model) || { model: entry.model, enabled: entry.enabled !== false, efforts: [] };
        if (entry.effort && !row.efforts.includes(entry.effort)) row.efforts.push(entry.effort);
        row.enabled = entry.enabled !== false;
        byModel.set(entry.model, row);
      }
      for (const row of byModel.values()) {
        const efforts = row.efforts.length ? row.efforts.join('/') : 'default';
        appendModelToggle(list, {
          checked: row.enabled,
          label: `${row.model} · ${efforts}`,
          onChange: async checked => {
            applyState(await api.providerSettings({ action: 'toggleCodexModel', model: row.model, enabled: checked }));
            renderProviders();
          },
        });
      }
      continue;
    }
    for (const model of group.models) {
      const efforts = group.id === 'claude-cli' && Array.isArray(model.efforts) ? model.efforts : [];
      appendModelToggle(list, {
        checked: model.enabled !== false,
        label: `${efforts.length ? model.model : model.label} · ${group.title}`,
        onChange: async checked => {
          applyState(await api.providerSettings({ action: 'toggle', id: model.id, enabled: checked }));
          renderProviders();
        },
        extra: efforts.length ? effortSelect(model, efforts) : null,
      });
    }
  }

  renderRoutingModels();
}

const discoveredModels = new Map();
const modelFetches = new Map();
let renewingModels = false;
function renderModelFetching() {
  const fetching = renewingModels || modelFetches.size > 0;
  $('#models-loading').hidden = !fetching;
  $('#provider-model-list').setAttribute('aria-busy', String(fetching));
  $('#renew-models').disabled = fetching || !!state?.busy;
}
function loadDiscoveredModels(providerId) {
  if (modelFetches.has(providerId)) return modelFetches.get(providerId);
  const pending = Promise.resolve().then(() => api.providerModels(providerId)).then(models => {
    discoveredModels.set(providerId, models.map(m => typeof m === 'string' ? { id: m, label: m } : m));
    return discoveredModels.get(providerId);
  }).finally(() => { modelFetches.delete(providerId); renderModelFetching(); });
  modelFetches.set(providerId, pending);
  renderModelFetching();
  return pending;
}

$('#renew-models').onclick = async () => {
  if (renewingModels || modelFetches.size) return;
  renewingModels = true;
  renderModelFetching();
  $('#provider-status').textContent = 'Refreshing models…';
  try {
    discoveredModels.delete('cursor-cli');
    const next = await api.renewModels();
    applyState(next);
    if (cursorInUse()) await loadDiscoveredModels('cursor-cli');
    renderProviders();
    $('#provider-status').textContent = next.modelRefreshNote || 'Models refreshed.';
  } catch (e) {
    $('#provider-status').textContent = e.message;
  } finally {
    renewingModels = false;
    renderModelFetching();
  }
};

// Claude reasoning effort per model; "CLI default" leaves Claude Code's own setting in charge.
function effortSelect(model, efforts) {
  const select = document.createElement('select');
  select.className = 'provider-model-effort';
  select.title = 'Reasoning effort';
  select.setAttribute('aria-label', `${model.model} reasoning effort`);
  for (const value of ['', ...efforts]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = value || 'CLI default';
    select.append(option);
  }
  select.value = model.effort || '';
  select.disabled = !!state.busy;
  select.onchange = async () => {
    try { applyState(await api.providerSettings({ action: 'claudeEffort', model: model.model, effort: select.value || null })); renderProviders(); }
    catch (e) { select.value = model.effort || ''; notify(e); }
  };
  return select;
}

function appendModelToggle(parent, { checked, label, onChange, extra = null }) {
  const row = element('label', 'provider-model-row');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = !!state.busy;
  input.onchange = async () => {
    try { await onChange(input.checked); }
    catch (e) { input.checked = !input.checked; notify(e); }
  };
  row.append(input, document.createTextNode(label));
  if (extra) row.append(extra);
  parent.append(row);
}

document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.onclick = () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.settings-tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#panel-general').hidden = name !== 'general';
    $('#panel-providers').hidden = name !== 'providers';
    $('#panel-checks').hidden = name !== 'checks';
    $('#panel-wiki').hidden = name !== 'wiki';
    if (name === 'wiki') {
      $('#wiki-kind').textContent = '';
      $('#wiki-location').textContent = 'Loading…';
      api.workspaceWiki(selectedId).then(showWiki).catch(error => { $('#wiki-location').textContent = error.message; });
    }
    if (name === 'checks') renderChecks();
    if (name === 'providers') {
      renderProviders();
      if (cursorInUse()) loadDiscoveredModels('cursor-cli').then(() => renderProviders()).catch(e => { $('#provider-status').textContent = e.message; });
    }
  };
});

function showWiki(wiki) {
  $('#wiki-kind').textContent = wiki.managed ? '· Default' : '· Custom';
  $('#wiki-location').textContent = wiki.root;
}
$('#wiki-open').onclick = () => api.openWorkspaceWiki(selectedId).catch(notify);
for (const [button, reset] of [['#wiki-choose', false], ['#wiki-reset', true]]) {
  $(button).onclick = async () => {
    try { showWiki(await api.chooseWorkspaceWiki(selectedId, reset)); } catch (error) { notify(error); }
  };
}

function splitCommand(text) {
  const args = [];
  for (const match of String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}

function checkRow(check = {}) {
  const row = document.createElement('div');
  row.className = 'check-row';
  const name = document.createElement('input');
  name.className = 'check-name';
  name.placeholder = 'Name';
  name.value = check.name || '';
  name.maxLength = 80;
  const command = document.createElement('input');
  command.className = 'check-command';
  command.placeholder = 'Command';
  command.value = (check.argv || []).map(part => /\s/.test(part) ? `"${part}"` : part).join(' ');
  const timeout = document.createElement('input');
  timeout.className = 'check-timeout';
  timeout.type = 'number';
  timeout.min = '1';
  timeout.max = '1800';
  timeout.value = String(Math.round((check.timeoutMs || 120000) / 1000));
  timeout.setAttribute('aria-label', 'Timeout seconds');
  const readOnly = document.createElement('label');
  const box = document.createElement('input');
  box.className = 'check-readonly';
  box.type = 'checkbox';
  box.checked = check.readOnlySafe === true;
  readOnly.append(box, document.createTextNode(' Read-only'));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.onclick = () => row.remove();
  const field = (text, input, className) => {
    const label = document.createElement('label');
    label.className = className;
    label.append(document.createTextNode(text), input);
    return label;
  };
  readOnly.className = 'check-readonly-label';
  row.append(field('Name', name, 'check-name-field'), field('Command', command, 'check-command-field'),
    field('Timeout (s)', timeout, 'check-timeout-field'), readOnly, remove);
  return row;
}

function renderChecks() {
  const workspace = current()?.workspace || state.settings.workspace;
  const checks = state.settings.checks?.[workspace] || [];
  const list = $('#checks-list');
  list.replaceChildren(...checks.map(checkRow));
  $('#checks-workspace').textContent = workspace || 'No workspace selected';
  $('#checks-status').textContent = '';
}

$('#checks-add').onclick = () => { $('#checks-list').append(checkRow()); };
$('#checks-save').onclick = async () => {
  const workspace = current()?.workspace || state.settings.workspace;
  const list = [...$('#checks-list').children].map(row => ({
    name: row.querySelector('.check-name').value.trim(),
    argv: splitCommand(row.querySelector('.check-command').value),
    cwd: workspace,
    timeoutMs: Number(row.querySelector('.check-timeout').value) * 1000,
    readOnlySafe: row.querySelector('.check-readonly').checked,
  }));
  try {
    await api.checks(workspace, list);
    $('#checks-status').textContent = 'Checks saved.';
  } catch (error) { notify(error); }
};
