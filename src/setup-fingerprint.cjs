'use strict';
// Setup fingerprint: what shaped a worker run, as readable parts plus a short hash over them. No model calls and no
// provider processes (versions are the ones Harness already knows). Bump VERSION when the parts change meaning, so old
// and new hashes are never compared as if they measured the same thing.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SKILLS, skillDir } = require('./worker-instructions.cjs');

const VERSION = 1;
const HARNESS = require('../package.json').version;
const digest = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

// Canonical JSON: sorted keys, so the same setup always produces the same hash.
function canonical(value) {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

const textHash = text => (typeof text === 'string' && text ? { hash: digest(text), chars: text.length } : null);

// Skill files are hashed by content, cached by size and modification time so a turn does not re-read them.
const cache = new Map();
function fileHash(file) {
  const stat = fs.statSync(file);
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key)
    return hit.hash;

  const hash = digest(fs.readFileSync(file));
  cache.set(file, { key, hash });
  return hash;
}

// Every file of a skill folder (SKILL.md and its scripts), by relative path and content.
function folderHash(root) {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory())
        walk(file);
      else
        files.push(file);
    }
  };
  try {
    walk(root);
    return digest(files.sort().map(file => `${path.relative(root, file)}:${fileHash(file)}`).join('\n'));
  } catch {
    return null;
  }
}

const skillHashes = () => Object.fromEntries(DEFAULT_SKILLS.map(name => [name, folderHash(skillDir(name))]));

// Checks decide a task's verdict. Paths inside the workspace are written relative to it, so batch copies match.
function checksHash(checks, workspace) {
  if (!checks?.length)
    return null;

  const local = part => (workspace ? part.split(workspace).join('<workspace>') : part);
  return digest(canonical(checks.map(check => ({ kind: check.kind || 'test', timeoutMs: check.timeoutMs, argv: check.argv.map(local) }))));
}

function setupFingerprint(parts) {
  const setup = { v: VERSION, harness: HARNESS, ...parts };
  return { hash: digest(canonical(setup)), ...setup };
}

module.exports = { setupFingerprint, textHash, skillHashes, folderHash, checksHash, canonical };
