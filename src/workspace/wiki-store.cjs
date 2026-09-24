const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');


class WikiStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.settingsFile = path.join(this.directory, 'locations.json');
    this.locations = fs.existsSync(this.settingsFile) ? JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) : {};
  }

  identity(workspace) {
    const root = fs.realpathSync(workspace);
    return process.platform === 'win32' ? root.toLowerCase() : root;
  }

  setLocation(workspace, folder) {
    const key = this.identity(workspace);
    const locations = { ...this.locations };
    if (folder === null) delete locations[key];
    else {
      if (typeof folder !== 'string' || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory())
        throw new Error('Choose an existing absolute wiki folder.');
      locations[key] = fs.realpathSync(folder);
    }
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.settingsFile + '.tmp', JSON.stringify(locations, null, 2));
    fs.renameSync(this.settingsFile + '.tmp', this.settingsFile);
    this.locations = locations;
    return this.ensure(workspace);
  }

  location(workspace) {
    const root = fs.realpathSync(workspace);
    const custom = this.locations[this.identity(root)];
    if (custom) return { workspace: root, root: custom, managed: false };
    const identity = process.platform === 'win32' ? root.toLowerCase() : root;
    const id = createHash('sha256').update(identity).digest('hex').slice(0, 20);
    const name = path.basename(root).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'workspace';
    return { workspace: root, root: path.join(this.directory, `${name}-${id}`, 'wiki'), managed: true };
  }

  ensure(workspace) {
    const info = this.location(workspace);
    {
      fs.mkdirSync(info.root, { recursive: true });
      // Reject redirected stores before writing any project knowledge.
      if (fs.realpathSync(info.root) !== path.resolve(info.root)) throw new Error('Wiki storage must not be redirected through a link.');
      const metadata = path.join(info.root, '..', 'workspace.json');
      if (info.managed && !fs.existsSync(metadata)) fs.writeFileSync(metadata, JSON.stringify({ workspace: info.workspace }, null, 2), { flag: 'wx' });
      const index = path.join(info.root, 'index.md');
      if (!fs.existsSync(index)) fs.writeFileSync(index, '# Workspace wiki\n\nLocal project knowledge managed by Phasma Harness.\n\nKeep focused topic pages for architecture, decisions, and troubleshooting. Link them here after approval. Record source paths and verification dates; verify claims against live source. Do not store secrets or session diaries.\n\n## Topics\n\nNo approved project notes yet.\n', { flag: 'wx' });
    }
    return { ...info, index: path.join(info.root, 'index.md') };
  }
}
module.exports = { WikiStore };
