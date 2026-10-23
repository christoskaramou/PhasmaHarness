'use strict';
// Workspace overrides and comparison snapshots live beside the AppData wiki, never in the installation.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DEFAULT_SKILLS, skillDir, skillContent, skillDescription } = require('./worker-instructions.cjs');
const { folderHash, skillHashes } = require('./setup-fingerprint.cjs');

function directory(root) {
  let ancestor = path.resolve(root);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) throw new Error('Skill storage must not follow links.');
  fs.mkdirSync(root, { recursive: true });
  if (fs.realpathSync(root) !== path.resolve(root)) throw new Error('Skill storage must not follow links.');
  return root;
}

function manifest(root) {
  if (!fs.existsSync(root)) return {};
  if (fs.realpathSync(root) !== path.resolve(root)) throw new Error('Skill storage must not follow links.');
  const file = path.join(root, 'active.json');
  if (!fs.existsSync(file)) return {};
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid skill manifest.');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!saved || Array.isArray(saved) || typeof saved !== 'object' || Object.entries(saved).some(([name, id]) =>
    !DEFAULT_SKILLS.includes(name) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new Error('Invalid skill manifest.');
  return saved;
}

function revision(root, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid skill revision.');
  const folder = path.join(root, 'revisions', id);
  if (fs.realpathSync(folder) !== path.resolve(folder)) throw new Error('Skill revisions must not follow links.');
  return folder;
}

function directories(root, { strict = false, onWarning = () => {} } = {}) {
  const defaults = Object.fromEntries(DEFAULT_SKILLS.map(name => [name, skillDir(name)]));
  const failed = (name, error) => {
    if (strict) throw error;
    onWarning(`Using bundled ${name} because its saved skill override is unavailable (${error.message}). Override files in ${root} were left untouched.`);
  };
  let saved;
  try { saved = root ? manifest(root) : {}; }
  catch (error) { failed('skills', error); return defaults; }
  for (const [name, id] of Object.entries(saved)) {
    try {
      const folder = revision(root, id);
      packageFiles(folder);
      defaults[name] = folder;
    } catch (error) { failed(name, error); }
  }
  return defaults;
}

// Copy the whole package, including binary resources, but never follow links or special files.
function packageFiles(root) {
  if (fs.realpathSync(root) !== path.resolve(root)) throw new Error('Skill packages must not follow links.');
  const files = []; let bytes = 0;
  const walk = (folder, depth = 0) => {
    if (depth > 16) throw new Error('Skill package is too deeply nested.');
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Skill packages cannot contain links or special files.');
      if (stat.isDirectory()) { walk(file, depth + 1); continue; }
      bytes += stat.size;
      if (files.length >= 256 || bytes > 8 * 1024 * 1024) throw new Error('Skill package exceeds 256 files or 8 MiB.');
      files.push({ relative: path.relative(root, file), data: fs.readFileSync(file), mode: stat.mode });
    }
  };
  walk(root);
  const entry = files.find(file => file.relative === 'SKILL.md');
  if (!entry || !entry.data.length || entry.data.length > 64 * 1024 || entry.data.includes(0) ||
      !Buffer.from(entry.data.toString('utf8')).equals(entry.data)) throw new Error('Skill package needs a nonempty UTF-8 SKILL.md under 64 KiB.');
  skillContent(entry.data.toString('utf8'));
  return files;
}

function snapshot(root, files, created) {
  const id = randomUUID(), folder = path.join(directory(path.join(directory(root), 'revisions')), id);
  fs.mkdirSync(folder);
  created.push(id);
  for (const file of files) {
    const output = path.join(folder, file.relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, file.data, { flag: 'wx', mode: file.mode });
  }
  return { id, folder };
}

function prepare(root, name, candidate, current, runs) {
  if (!DEFAULT_SKILLS.includes(name)) throw new Error('Choose an existing Harness skill.');
  const saved = manifest(root), original = saved[name] || null;
  const active = directories(root, { strict: true });
  if (folderHash(active[name]) !== folderHash(current[name])) throw new Error('The active skill changed before the comparison.');
  const baseline = Object.fromEntries(Object.entries(current).map(([key, folder]) => [key, packageFiles(folder)]));
  const proposed = packageFiles(candidate);
  const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
  const hash = (files, effective = false) => digest([...files].sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0).map(file => {
    let data = file.data;
    if (effective && file.relative === 'SKILL.md') {
      const text = data.toString('utf8');
      data = skillDescription(name, text) + '\n' + skillContent(text).body;
    }
    return `${file.relative}:${digest(data)}`;
  }).join('\n'));
  if (hash(baseline[name], true) === hash(proposed, true)) throw new Error('The candidate skill is unchanged.');
  const text = proposed.find(file => file.relative === 'SKILL.md').data.toString('utf8').replace(/\\/g, '/');
  if ([root, skillDir(name), current[name]].some(folder => text.includes(path.resolve(folder).replace(/\\/g, '/'))))
    throw new Error('Candidate skill embeds an old package path. Copy the editable source and preserve {{SKILL_DIR}}.');
  const created = [];
  try {
    const changed = snapshot(root, proposed, created);
    const frozen = runs.map(run => {
      const dirs = Object.fromEntries(Object.entries(baseline).map(([key, files]) =>
        [key, snapshot(root, run.variant && key === name ? proposed : files, created).folder]));
      return { index: run.index, dirs, hashes: skillHashes(dirs) };
    });
    return { name, root, original, changed: changed.id, beforeHash: hash(baseline[name]), afterHash: hash(proposed), runs: frozen };
  } catch (error) {
    for (const id of created) removeRevision(root, id);
    throw error;
  }
}

function publish(root, name, id) {
  if (id) revision(root, id);
  const saved = { ...manifest(root), [name]: id }, file = path.join(root, 'active.json');
  if (!id) delete saved[name];
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(saved, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function adopt(skill) {
  const { root, name } = skill;
  if ((manifest(root)[name] || null) !== skill.original || folderHash(directories(root, { strict: true })[name]) !== skill.beforeHash)
    throw new Error('The active skill changed during the comparison.');
  for (const [id, hash] of [[skill.original, skill.beforeHash], [skill.changed, skill.afterHash]].filter(([id]) => id)) {
    const folder = revision(root, id);
    packageFiles(folder);
    if (folderHash(folder) !== hash) throw new Error('A saved skill snapshot changed during the comparison.');
  }
  publish(root, name, skill.changed);
  return { skill: name, root, revision: skill.changed, previous: skill.original, hash: skill.afterHash, previousHash: skill.beforeHash };
}

function undo(adopted) {
  const { root, skill: name } = adopted;
  if (manifest(root)[name] !== adopted.revision || folderHash(directories(root, { strict: true })[name]) !== adopted.hash)
    throw new Error('The active skill changed since adoption; it was not overwritten.');
  if (adopted.previous) {
    const previous = revision(root, adopted.previous);
    packageFiles(previous);
    if (folderHash(previous) !== adopted.previousHash) throw new Error('The saved previous skill changed; it was not restored.');
  }
  publish(root, name, adopted.previous);
}

function removeRevision(root, id) {
  const folder = revision(root, id), parent = path.resolve(root, 'revisions');
  if (path.dirname(folder) !== parent || fs.realpathSync(parent) !== parent) throw new Error('Invalid skill cleanup path.');
  fs.rmSync(folder, { recursive: true });
}

// Use the existing 50-comparison history for Undo retention, plus active and in-flight packages.
function prune(root, records, pending = []) {
  const keep = new Set(Object.values(manifest(root)));
  for (const record of records) {
    if (record.adopted?.root === root && !record.adopted.undoneAt) {
      keep.add(record.adopted.revision);
      keep.add(record.adopted.previous);
    }
  }
  for (const record of pending.filter(record => record.skill?.root === root)) {
    keep.add(record.skill.original); keep.add(record.skill.changed);
    for (const run of record.skill.runs) for (const folder of Object.values(run.dirs)) keep.add(path.basename(folder));
  }
  const parent = path.join(root, 'revisions'), removed = [];
  if (!fs.existsSync(parent)) return removed;
  if (fs.realpathSync(parent) !== path.resolve(parent)) throw new Error('Skill storage must not follow links.');
  for (const id of fs.readdirSync(parent)) if (/^[0-9a-f-]{36}$/.test(id) && !keep.has(id)) {
    removeRevision(root, id); removed.push(id);
  }
  return removed;
}

function requireIgnoredCandidate(workspace, candidate) {
  const relative = path.relative(workspace, candidate).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('The candidate must be inside the workspace.');
  const git = args => spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const ignored = git(['check-ignore', '--quiet', '--', relative + '/']);
  const tracked = git(['ls-files', '--', relative + '/']);
  const committed = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', relative + '/']);
  if (ignored.status !== 0 || tracked.status !== 0 || tracked.stdout.trim() || committed.stdout?.trim() ||
      (committed.status !== 0 && git(['rev-parse', '--verify', 'HEAD']).status === 0))
    throw new Error('Put the candidate skill in an ignored, untracked folder (add it to .gitignore) so it cannot reach the baseline run.');
}

module.exports = { directories, packageFiles, prepare, adopt, undo, prune, requireIgnoredCandidate };
