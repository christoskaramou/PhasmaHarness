// Tips: the same tip shows on the new-chat screen (#welcome) and in a popup from the bulb next to Settings (hover shows
// it, a click keeps it open). Arrows move between tips, "I got it" retires one for this viewer, and each new chat moves
// on; the ones that fit this setup (the chat checker is off, the project has no checks) come first. Settings → General →
// Show tips turns both off.
(() => {
  const card = element('div', 'tips');
  card.id = 'tips';
  card.hidden = true;
  card.setAttribute('role', 'note');
  $('#welcome').append(card);

  const button = $('#tips-button');
  const popup = element('div', 'tips tips-popup');
  popup.id = 'tips-popup';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Tips');
  document.body.append(popup);

  const projectChecks = () => state.settings.checks?.[current()?.workspace || state.settings.workspace] || [];
  // The browser view (phone or another computer) has no microphone and is already the remote way in.
  const desktop = () => !window.router?.remote;

  // The main chat's own name (it can be renamed).
  const hub = () => state.agents?.find(agent => agent.id === 'main')?.name || 'Hub';

  // `fits`: shown first while true; `when`: shown at all only while true; `text` may depend on the setup. Every tip was
  // checked against the code (2026-10-21); keep them true when the feature they name changes.
  const checkerOff = () => !state.settings.chatScanModel || state.settings.chatScanModel === 'off';
  const TIPS = [
    // What fits this setup.
    { id: 'checker', fits: checkerOff,
      text: 'Turn on the chat checker so Harness learns from your corrections: when you write "no, I meant…", it saves a rule or note for next time. Settings → General → Chat checker model.' },
    { id: 'checks', fits: () => !projectChecks().length,
      text: 'Add a check, a command that says whether the work is good, such as a build or the tests. Harness then verifies each task and learns which model fits each kind of work. Settings → Checks.' },

    // Getting started.
    { id: 'hub', text: () => `${hub()} is your main chat: ask it anything. It answers itself or hands the work to a bot, and tells you when the bot is done.` },
    { id: 'bots', text: () => `Add bots with the + next to PhasmaHarness, or Ctrl+N. ${hub()} can hand them work, and they run at the same time.` },
    { id: 'bot-roles', text: () => `Give each bot a role under "Role & instructions" (open it from Overview, then Edit). ${hub()} then knows what to hand it.` },
    { id: 'groups', text: () => `Overview → New group puts several bots in one chat. Start a message with @Name to talk to one member; anything else goes to ${hub()}.` },
    { id: 'enter', text: 'Enter sends; Shift+Enter starts a new line. In an empty message box, ↑ and ↓ bring back what you sent before.' },
    { id: 'queue', text: 'While a chat is working, Send becomes "Queue message": line up to 10 messages. "Send now" on a queued one delivers it straight away.' },
    { id: 'stop', text: 'Press Escape, or type /stop, to stop the running turn in the chat you are looking at.' },
    { id: 'access', text: 'The shield in the message box sets what a bot may do: Ask (read only), Workspace access, or Full access (red). New bots start on Ask.' },
    { id: 'commands', text: 'Type / in the message box for commands: /context shows how full the model\'s memory is, /compact frees it, /export saves the chat as Markdown.' },
    { id: 'context-ring', text: 'The small ring next to the microphone shows how full the model\'s memory is. Hover for the numbers; click it to compact.' },
    { id: 'clear', text: 'Type /clear to start fresh; the old chat is archived on this computer. Use /export first if you want a copy of it.' },
    { id: 'header', text: 'The three icons at the top right of a chat show the files it changed, let you browse the project, and show its Git changes.' },
    { id: 'attach', text: 'Paste images or files into the message box, or use +, to attach PDFs, Word files, code or images (up to four per message).' },
    { id: 'dictation', when: desktop,
      text: 'Press the microphone to dictate in English or Greek. Start talking when it says "Listening…"; your words appear after you stop.' },
    { id: 'suggestions', when: () => state.settings.replySuggestions !== false,
      text: 'When grey text appears after an answer, press → to take it as your next message.' },
    { id: 'routines', text: 'Ask a bot to do something on a schedule, for example "every weekday at 8:00, summarise new commits". It runs in that chat as a routine; it can also run once, or after each new commit.' },
    { id: 'copies', text: () => `Ask ${hub()} for several workers on one task and each works in its own copy of the project. In the job's details, "Apply changes to my project…" keeps the one you want.` },
    { id: 'budgets', text: 'Task bots have no default time, attempt or token limits. Provider usage limits can still pause their work.' },

    // What Auto does.
    { id: 'auto', text: 'Auto picks a model for every message to a bot: an economical one for simple asks, the strongest for hard ones, and the same one while you continue a task.' },
    { id: 'routing-model', text: 'Auto\'s choice is made by the routing model, Settings → General → Routing model (Auto). A fast, cheap model there keeps routing quick.' },
    { id: 'jev-router', when: () => !!state.jev?.configured,
      text: 'With your Jev key you can pick Jev as the routing model. If a Jev call fails, Harness routes that message with the normal router instead.' },
    { id: 'effort', text: 'Settings → General → Effort cap for Auto limits how hard Auto lets models think; a lower cap saves usage. Models you pick by hand are not capped.' },
    { id: 'auto-models', text: 'Auto only picks from the models ticked in Settings → Providers. Untick the ones you do not want it to use.' },
    { id: 'usage-limit', text: 'When a provider hits its usage limit, Harness pauses that task for you to review, and new Auto messages use another provider until the limit resets.' },
    { id: 'hub-model', text: () => `${hub()} itself runs on the one model set in its Edit dialog; picking per message is for bots.` },
    { id: 'benchmarks', text: 'Settings → Benchmarks shows the measurements Auto uses to rank models. "Prepare refresh" sets up a bot to research newer numbers for you to review.' },

    // Settings worth knowing.
    { id: 'tray', when: desktop,
      text: 'Settings → General → On Exit → Stay on Tray keeps bots and routines running after you close the window. Quit runner in the tray menu stops them.' },
    { id: 'sign-in', when: () => desktop() && !/Linux/i.test(navigator.userAgent),
      text: 'Settings → General → Start at sign-in starts Harness when you log in, so routines run on time.' },
    { id: 'appearance', text: 'Settings → General → Appearance switches between System, Dark and Light.' },
    { id: 'suggestions-cost', when: () => state.settings.replySuggestions !== false,
      text: 'Each grey reply suggestion costs one model call. Settings → General → Reply suggestions turns them off.' },
    { id: 'providers', text: 'Settings → Providers connects ChatGPT (Codex), Claude, Cursor and more. "Add provider" connects an API service or a local server such as LM Studio.' },
    { id: 'renew', text: 'Settings → Providers → Renew refreshes the model lists, for example after a provider releases a new model.' },
    { id: 'zoom', when: desktop, text: 'Ctrl + and Ctrl − zoom the whole window.' },
    { id: 'phone', when: desktop,
      text: 'Settings → General → Browser access opens Harness in a browser. For your phone or another computer it needs an HTTPS address through your own proxy, and the link is the key, so keep it private.' },

    // Getting better results.
    { id: 'instructions', text: 'Put your project\'s rules in PhasmaHarness.md at the project root: every model reads it before each turn.' },
    { id: 'rules', text: 'Rules Harness learns go into your project\'s PhasmaHarness.md under "Rules Harness learned", and each one\'s line in the chat has an Undo.' },
    { id: 'learned', text: 'To see what Harness has learned, open the project\'s wiki folder (Settings → Wiki → Show in folder): lessons.md, rules.md, notes.md and setups.md.' },
    { id: 'wiki', text: 'Each project has a wiki that Harness keeps up to date after tasks whose checks pass. Settings → Wiki shows where it is, and Show in folder opens it.' },
    { id: 'correction', when: () => projectChecks().length > 0,
      text: 'When a check fails, Harness asks the bot for one fix by itself before the task comes back to you.' },
    { id: 'read-only-checks', when: () => projectChecks().length > 0,
      text: 'Tick Read-only on checks that change nothing, so they also run when a bot has Ask access.' },
    { id: 'proven', when: () => projectChecks().length > 0 || !checkerOff(),
      text: 'Auto learns which model gets each kind of work right first time, by your checks or, without them, by how the chat checker reads your replies, and prefers it. A line in the chat tells you, with an Undo.' },
    { id: 'compare', when: () => projectChecks().length > 0,
      text: () => `Not sure a rule helps? Ask ${hub()} to compare: it runs the task twice, with and without the rule, and keeps the better result.` },

    // Staying up to date.
    { id: 'update-bar', when: () => update?.installable === true,
      text: 'When a new version is out, a bar offers "Update and restart" and "What\'s new". If you hide it, the blue download icon in the sidebar brings it back.' },
    { id: 'update-check', text: 'Settings → About → Check for updates looks for a new version straight away.' },
    { id: 'update-source', when: () => update?.installable === false,
      text: 'Running Harness from its source folder? It does not update itself: update the folder, then run Install Phasma Harness.cmd again.' },

    // When something goes wrong.
    { id: 'diagnostics', text: 'Something not right? Settings → About → Copy diagnostics copies a report without your prompts or keys, and Open logs folder shows the logs.' },
  ];

  // Retired tips are a per-viewer convenience: kept in this window's storage, all tips again when it is cleared.
  const STORE = 'harness.tips.gotIt';
  let gotIt = new Set();
  try {
    gotIt = new Set(JSON.parse(localStorage.getItem(STORE) || '[]'));
  } catch { /* storage unavailable: every tip shows */ }

  let turn = 0;
  let welcomeShown = false;
  let pinned = false;
  let hoverTimer = null;

  // The tips still to show, the fitting ones first.
  function remaining() {
    const shown = TIPS.filter(entry => (!entry.when || entry.when()) && !gotIt.has(entry.id));
    return [...shown.filter(entry => entry.fits?.()), ...shown.filter(entry => !entry.fits?.())];
  }

  function currentTip() {
    const list = remaining();
    if (!list.length)
      return { list, entry: null, index: 0 };

    const index = ((turn % list.length) + list.length) % list.length;
    return { list, entry: list[index], index };
  }

  function control(label, caption, run) {
    const action = element('button', 'compact-action', caption);
    action.type = 'button';
    action.setAttribute('aria-label', label);
    action.onclick = run;
    return action;
  }

  function move(step) {
    turn += step;
    renderTips(true);
  }

  function retire(id) {
    gotIt.add(id);
    try {
      localStorage.setItem(STORE, JSON.stringify([...gotIt]));
    } catch { /* kept for this session only */ }
    renderTips(true);
  }

  // The same view in the card and the popup; rebuilt only when what it shows changed, so live updates never reset a
  // button under the pointer.
  function view(container, force) {
    const { list, entry, index } = currentTip();
    const text = entry && (typeof entry.text === 'function' ? entry.text() : entry.text);
    const key = entry ? `${entry.id}|${index}|${list.length}|${text}` : 'done';
    if (!force && container.dataset.key === key)
      return;

    container.dataset.key = key;
    if (!entry) {
      container.replaceChildren(element('span', 'tips-text', 'That was every tip. They come back if this window\'s storage is cleared.'));
      return;
    }

    const controls = element('div', 'tips-controls');
    controls.append(control('Previous tip', '‹', () => move(-1)), control('Next tip', '›', () => move(1)), control('I got it, do not show this tip again', 'I got it', () => retire(entry.id)));
    controls.lastChild.classList.add('tips-got-it');
    container.replaceChildren(element('span', 'tips-label', 'Tip'), element('span', 'tips-text', text), controls);
  }

  function place() {
    const anchor = button.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.bottom = `${innerHeight - anchor.top + 8}px`;
  }

  function open() {
    clearTimeout(hoverTimer);
    if (state?.settings?.showTips === false)
      return;

    popup.hidden = false;
    view(popup, true);
    place();
    button.setAttribute('aria-expanded', 'true');
  }

  function close() {
    clearTimeout(hoverTimer);
    pinned = false;
    popup.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  // A new chat moves on to the next tip; while the screen stays, the tip stays unless it stopped applying.
  function renderTips(force = false) {
    const visible = !$('#welcome').hidden;
    if (visible && !welcomeShown && card.dataset.key)
      turn++;
    welcomeShown = visible;
    const on = state?.settings?.showTips !== false;
    button.hidden = !on;
    card.hidden = !on || !currentTip().entry;
    if (!on) {
      close();
      return;
    }

    view(card, force);
    if (!popup.hidden)
      view(popup, force);
  }

  // Hover shows the popup and leaving hides it; a click keeps it open until a second click, a click outside or Escape.
  const leave = () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!pinned)
        close();
    }, 250);
  };
  button.addEventListener('mouseenter', open);
  button.addEventListener('mouseleave', leave);
  popup.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  popup.addEventListener('mouseleave', leave);
  button.addEventListener('click', () => {
    if (pinned) {
      close();
      return;
    }

    open();
    pinned = true;
  });
  document.addEventListener('pointerdown', event => {
    if (pinned && !popup.contains(event.target) && !button.contains(event.target))
      close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popup.hidden)
      close();
  });
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'tips-popup');

  window.HarnessTips = { render: () => renderTips() };
})();
