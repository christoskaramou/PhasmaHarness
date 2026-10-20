// Automatic updates for the installed Windows app. main.cjs checks in the background at start and twice a day; when a
// newer release exists the window offers "Update and restart", which downloads the release installer, verifies it
// (src/updates.cjs), runs it silently and quits; the installer then starts the new version. Nothing installs on its
// own, nothing starts while a turn or its checks are running, and a source-folder run only reports and links.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { checkForUpdate, downloadInstaller, startInstaller, compareVersions } = require('./updates.cjs');

class Updater extends EventEmitter {
  constructor({ current, fetch, directory, installable, busy = () => false, pause = () => () => {}, quit = () => {}, spawn, launch } = {}) {
    super();
    Object.assign(this, { current, fetch, directory, installable: !!installable, busy, pause, quit, spawn, launch });
    this.release = null; this.installing = null;
    this.state = { status: 'idle', current, installable: false };
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state); }

  async check() {
    if (this.installing) return this.result;
    const result = await checkForUpdate({ current: this.current, fetch: this.fetch });
    // An install that started while this check was fetching owns the banner and the release it downloads.
    if (this.installing) return this.result;
    const installable = this.installable && result.newer && !!result.asset;
    this.result = { ...result, installable };
    this.release = installable ? result : null;
    // An agent's request to confirm was for the version it saw; a different release starts without one.
    const request = this.state.confirmationRequest && result.latest !== this.state.latest ? { confirmationRequest: 0 } : {};
    this.set({ status: result.newer ? 'available' : 'current', latest: result.latest, url: result.url, installable, progress: null, error: null, ...request });
    return this.result;
  }

  async checkFromAgent() {
    const result = await this.check();
    const confirmationRequired = result.installable && !this.installing;
    if (confirmationRequired) this.set({ confirmationRequest: (this.state.confirmationRequest || 0) + 1 });
    return { current: this.current, latest: result.latest, newer: result.newer, url: result.url,
      confirmationRequired, message: this.installing ? 'An update is already in progress.'
        : confirmationRequired ? 'Ask the user to confirm downloading and installing with the Download and install button in the desktop update banner. Finish this reply first; the button works once active work has finished. This check did not download an installer.'
        : result.newer ? 'A newer release is available. Automatic installation is unavailable in this run; use the official release link to update manually.'
        : 'Phasma Harness is up to date.' };
  }

  install() {
    if (!this.installable) return Promise.reject(new Error('Automatic updates work in the installed app. Update the source folder with git instead.'));
    if (this.installing) return this.installing;
    if (!this.release) return Promise.reject(new Error('No update is ready. Check for updates first.'));
    const blocked = this.busy();
    if (blocked) return Promise.reject(new Error(typeof blocked === 'string' ? blocked : 'Finish or stop the current turn first; updating restarts the app.'));
    const release = this.release;
    this.installing = (async () => {
      let resume, launched = false;
      try {
        let shown = -1;
        this.set({ status: 'downloading', progress: 0, error: null });
        const file = await downloadInstaller({ asset: release.asset, directory: this.directory, fetch: this.fetch, onProgress: fraction => {
          const percent = Math.floor(fraction * 100);
          if (percent !== shown) { shown = percent; this.set({ progress: percent }); }
        } });
        // A turn that started during the download keeps running; the verified installer is reused next time.
        const blocked = this.busy();
        if (blocked) throw new Error(typeof blocked === 'string' ? blocked : 'A turn started during the download. Choose Update and restart again when it finishes.');
        resume = this.pause();
        this.set({ status: 'installing', progress: 100 });
        if (this.launch) await this.launch(file);
        else await startInstaller(file, this.spawn);
        launched = true;
        this.quit();
      } catch (error) {
        if (!launched && !error.launchUncertain) resume?.();
        this.set({ status: 'error', error: error.message });
        throw error;
      } finally { this.installing = null; }
    })();
    return this.installing;
  }

  // Deletes unfinished downloads and installers that are not newer than this version (earlier updates). Never while an
  // update is downloading: its unfinished file is the one being written.
  cleanup() {
    if (this.installing) return;
    let names = [];
    try { names = fs.readdirSync(this.directory); } catch { return; }
    for (const name of names) {
      const version = /^Phasma-Harness-Setup-(.+)\.exe$/.exec(name)?.[1];
      let old = name.endsWith('.partial');
      if (version) try { old = compareVersions(version, this.current) <= 0; } catch { old = true; }
      if (old) try { fs.rmSync(path.join(this.directory, name), { force: true }); } catch { /* in use; next start */ }
    }
  }
}

module.exports = { Updater };
