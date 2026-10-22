const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');


// Every wiki lives in this one folder, one subfolder per workspace, and cannot be moved (the user's choice, 2026-10-22).
// Project copies keep their copied wiki; old custom folders are imported without overwriting either location.
class WikiStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.settingsFile = path.join(this.directory, 'locations.json');
    const saved = fs.existsSync(this.settingsFile) ? JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) : {};
    this.locations = saved;
  }

  identity(workspace) {
    const root = fs.realpathSync(workspace);
    return process.platform === 'win32' ? root.toLowerCase() : root;
  }

  // A project copy's own wiki, copied in with it.
  setLocation(workspace, folder) {
    const key = this.identity(workspace);
    const locations = { ...this.locations };
    if (typeof folder !== 'string' || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory())
      throw new Error('Choose an existing absolute wiki folder.');
    locations[key] = { root: fs.realpathSync(folder), copy: true };
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.settingsFile + '.tmp', JSON.stringify(locations, null, 2));
    fs.renameSync(this.settingsFile + '.tmp', this.settingsFile);
    this.locations = locations;
    return this.ensure(workspace);
  }

  location(workspace) {
    const root = fs.realpathSync(workspace);
    const copy = this.locations[this.identity(root)];
    if (copy?.copy === true && typeof copy.root === 'string') return { workspace: root, root: copy.root, managed: false };
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
      const key = this.identity(workspace), legacy = this.locations[key];
      const from = typeof legacy === 'string' ? legacy : !legacy?.copy && !legacy?.migratedFrom ? legacy?.root : null;
      if (info.managed && from) {
        const source = fs.realpathSync(from), target = fs.realpathSync(info.root);
        const relative = path.relative(source, target);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('The old wiki contains the new wiki folder. Move it outside the old folder before importing.');
        if (relative) {
          const folder = 'imported-' + createHash('sha256').update(source).digest('hex').slice(0, 12);
          const destination = path.join(target, folder);
          // A failed copy can be retried; identical existing files are left intact, conflicts remain visible.
          fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true, filter: (file, output) => {
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('The old wiki contains a link or special file: ' + file);
            if (fs.existsSync(output)) {
              if (fs.lstatSync(output).isSymbolicLink()) throw new Error('Wiki import must not overwrite a link: ' + output);
              if (stat.isFile() && fs.statSync(output).isFile() && fs.readFileSync(file).equals(fs.readFileSync(output))) return false;
            }
            return true;
          } });
          const link = `[Imported wiki](${folder}/index.md)`;
          if (!fs.readFileSync(index, 'utf8').includes(link)) fs.appendFileSync(index, `\n- ${link}\n`);
        }
        const locations = { ...this.locations, [key]: { migratedFrom: source } };
        fs.writeFileSync(this.settingsFile + '.tmp', JSON.stringify(locations, null, 2));
        fs.renameSync(this.settingsFile + '.tmp', this.settingsFile);
        this.locations = locations;
      }
    }
    return { ...info, index: path.join(info.root, 'index.md') };
  }
}
module.exports = { WikiStore };
