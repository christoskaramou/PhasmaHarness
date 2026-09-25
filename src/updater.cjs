// Automatic updates for the installed Windows app. main.cjs checks in the background at start and twice a day; when a
// newer release exists the window offers "Update and restart", which downloads the release installer, verifies it
// (src/updates.cjs), runs it silently and quits; the installer then starts the new version. Nothing installs on its
// own, nothing starts while a turn or its checks are running, and a source-folder run only reports and links.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { checkForUpdate, downloadInstaller, startInstaller, compareVersions } = require('./updates.cjs');

class Updater extends EventEmitter {
  constructor({ current, fetch, directory, installable, busy = () => false, quit = () => {}, spawn } = {}) {
    super();
    Object.assign(this, { current, fetch, directory, installable: !!installable, busy, quit, spawn });
    this.release = null; this.installing = null;
    this.state = { status: 'idle', current, installable: false };
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state); }

  async check() {
    if (this.installing) return this.result;
    const result = await checkForUpdate({ current: this.current, fetch: this.fetch });
    const installable = this.installable && result.newer && !!result.asset;
    this.result = { ...result, installable };
    this.release = installable ? result : null;
    this.set({ status: result.newer ? 'available' : 'current', latest: result.latest, url: result.url, installable, progress: null, error: null });
    return this.result;
  }

  install() {
    if (!this.installable) return Promise.reject(new Error('Automatic updates work in the installed app. Update the source folder with git instead.'));
    if (this.installing) return this.installing;
    if (!this.release) return Promise.reject(new Error('No update is ready. Check for updates first.'));
    if (this.busy()) return Promise.reject(new Error('Finish or stop the current turn first; updating restarts the app.'));
    const release = this.release;
    this.installing = (async () => {
      try {
        let shown = -1;
        this.set({ status: 'downloading', progress: 0, error: null });
        const file = await downloadInstaller({ asset: release.asset, directory: this.directory, fetch: this.fetch, onProgress: fraction => {
          const percent = Math.floor(fraction * 100);
          if (percent !== shown) { shown = percent; this.set({ progress: percent }); }
        } });
        // A turn that started during the download keeps running; the verified installer is reused next time.
        if (this.busy()) throw new Error('A turn started during the download. Choose Update and restart again when it finishes.');
        this.set({ status: 'installing', progress: 100 });
        await startInstaller(file, this.spawn);
        this.quit();
      } catch (error) {
        this.set({ status: 'error', error: error.message });
        throw error;
      } finally { this.installing = null; }
    })();
    return this.installing;
  }

  // Deletes unfinished downloads and installers that are not newer than this version (earlier updates).
  cleanup() {
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
