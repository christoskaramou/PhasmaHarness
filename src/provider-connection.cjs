const { NATIVE_CLI_INFO } = require('./providers/native-cli.cjs');

async function syncProviders(agents) {
  try { await agents.refresh(); }
  catch (error) {
    agents.providerSyncError = 'Provider settings could not synchronize. Restart Harness before continuing.';
    throw new Error(agents.providerSyncError, { cause: error });
  }
}

async function withProviderChange({ controller, agents }, change) {
  if (agents.closing) throw new Error('The runner is stopping.');
  if (agents.busy || agents.providerChanging || agents.allControllers().some(worker => worker.loading.size || worker.stopping.size ||
      worker.connectingProviders.size || worker.chatgptLoginPending || worker.blockedReason()))
    throw new Error('Wait for current work and provider connections to finish before changing providers.');
  agents.providerChanging = true;
  try { await change(); }
  finally {
    agents.providerChanging = false;
    controller.changed(); agents.pump();
  }
  return agents.snapshot();
}

async function providerConnection(runner, id, action) {
  const { controller, agents } = runner;
  const legacy = { codex: ['Codex CLI', 'chatgptEnabled'], 'claude-cli': ['Claude Code', 'claudeEnabled'], 'cursor-cli': ['Cursor', 'cursorEnabled'] };
  const native = controller.nativeCLIs.get(id), info = NATIVE_CLI_INFO[id];
  const [label, key] = Object.hasOwn(legacy, id) ? legacy[id] : native && info ? [info.label, info.setting] : [];
  if (!key || !['connect', 'refresh', 'disconnect'].includes(action)) throw new Error('Choose a native provider connection action.');
  const present = Object.hasOwn(controller.data.settings, key), prior = controller.data.settings[key];
  let saved = false;
  return withProviderChange(runner, () => controller.withProviderConnection(id, async () => {
    try {
      let problem;
      if (action === 'disconnect') controller.setProviderEnabled(id, false);
      else {
        let status;
        if (id === 'codex') {
          if (controller.codex.connected) await controller.refreshAccount();
          else await controller.connectCodex();
          status = { installed: controller.codex.installed, loggedIn: controller.codex.signedIn, error: controller.codex.error };
        } else status = await (native || (id === 'claude-cli' ? controller.claude : controller.cursor)).refresh();
        if (agents.closing) throw new Error('The runner is stopping.');
        if (id === 'cursor-cli' && status.loggedIn) await controller.discoverCursor();
        if (action === 'connect') {
          if (status.loggedIn) controller.setProviderEnabled(id, true);
          else problem = new Error(status.installed === false ? `${label} is not installed on the runner host. Install it there, then connect again.`
            : status.error ? `${label} is not ready: ${status.error} Check its native setup on the runner host.`
              : `${label} is not ready. Complete its native sign-in on the runner host, then connect again.`);
        }
        if (id === 'claude-cli' && status.loggedIn) {
          await agents.refreshClaudeQuota(true);
          controller.migrateLegacyRouter(); controller.claudeRouterFallback();
        }
      }
      if (agents.closing) throw new Error('The runner is stopping.');
      await controller.refreshAccount();
      controller.adoptRouter(); controller.save(); saved = true;
      await syncProviders(agents);
      if (problem) throw problem;
    } catch (error) {
      if (!saved) {
        if (present) controller.data.settings[key] = prior;
        else delete controller.data.settings[key];
        if (!agents.closing) await controller.refreshAccount().catch(() => {});
      }
      throw error;
    }
  }));
}

async function renewModels(runner) {
  const { controller, agents } = runner, notes = [];
  const snapshot = await withProviderChange(runner, async () => {
    const refresh = async work => {
      if (agents.closing) throw new Error('The runner is stopping.');
      try { await work(); } catch (error) { notes.push(error.message); }
    };
    await refresh(() => controller.refreshAccount());
    if (controller.claude.status.loggedIn) await refresh(() => controller.claude.discover());
    if (controller.cursor.status.loggedIn) await refresh(async () => {
      controller.cursor.models = []; await controller.discoverCursor();
    });
    for (const backend of controller.nativeCLIs.values()) if (backend.status.loggedIn) await refresh(() => backend.refresh());
    await refresh(() => controller.refreshCliUpdates());
    if (agents.closing) throw new Error('The runner is stopping.');
    await controller.refreshAccount();
    await syncProviders(agents);
  });
  if (notes.length) snapshot.modelRefreshNote = notes.join(' ');
  return snapshot;
}

module.exports = { providerConnection, renewModels };
