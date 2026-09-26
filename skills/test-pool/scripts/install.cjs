#!/usr/bin/env node
'use strict';
// Installs the test-pool skill for Claude Code (~/.claude/skills) and for Codex and Cursor (~/.agents/skills), and
// registers the pool runner as a Stop hook in ~/.claude/settings.json, ~/.codex/hooks.json and ~/.cursor/hooks.json.
// Idempotent: re-run after updating the skill. Existing settings are kept; each file is backed up once before the
// first change. Options: --uninstall, --no-hooks, --claude-async (run Claude's hook in the background and wake Claude
// only on failure), --dry-run, --home <dir>.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME = 'test-pool';
const SOURCE = path.resolve(__dirname, '..');
const MARK = /testpool\.cjs"? hook\b/; // identifies hook entries written by this installer
const TIMEOUT_SEC = 1800;

const fwd = p => p.replace(/\\/g, '/');

function isOurSkill(dir) {
  try { return /^name:\s*test-pool\s*$/m.test(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')) && fs.existsSync(path.join(dir, 'scripts', 'testpool.cjs')); }
  catch { return false; }
}

function copySkill(target, log, dry) {
  const same = path.resolve(target) === SOURCE;
  if (same) return log(`skill: ${target} is the source itself; left as is`);
  if (fs.existsSync(target) && !isOurSkill(target)) throw new Error(`${target} exists and is not the test-pool skill; not overwriting it`);
  if (dry) return log(`skill: would install ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(SOURCE, target, { recursive: true });
  const md = path.join(target, 'SKILL.md');
  fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replaceAll('{{SKILL_DIR}}', fwd(target)).replaceAll(fwd(SOURCE), fwd(target)));
  log(`skill: installed ${target}`);
}

function removeSkill(target, log, dry) {
  if (path.resolve(target) === SOURCE || !fs.existsSync(target)) return;
  if (!isOurSkill(target)) return log(`skill: ${target} is not the test-pool skill; left as is`);
  if (!dry) fs.rmSync(target, { recursive: true, force: true });
  log(`skill: ${dry ? 'would remove' : 'removed'} ${target}`);
}

function readObject(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`${file} is not valid JSON (${error.message}); fix it or add the hook by hand`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} does not hold a JSON object`);
  return value;
}

function writeObject(file, value, log, dry, what) {
  if (dry) return log(`hook: would update ${file} (${what})`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.testpool-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  log(`hook: updated ${file} (${what})`);
}

// Claude Code and Codex share the { hooks: { Stop: [ { hooks: [ handler ] } ] } } layout.
function mergeGrouped(config, event, handler) {
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const groups = (Array.isArray(hooks[event]) ? hooks[event] : [])
    .map(g => ({ ...g, hooks: (Array.isArray(g?.hooks) ? g.hooks : []).filter(h => !MARK.test(String(h?.command || ''))) }))
    .filter(g => g.hooks.length);
  if (handler) groups.push({ hooks: [handler] });
  const next = { ...config, hooks: { ...hooks } };
  if (groups.length) next.hooks[event] = groups; else delete next.hooks[event];
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

function mergeCursor(config, handler) {
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const stop = (Array.isArray(hooks.stop) ? hooks.stop : []).filter(h => !MARK.test(String(h?.command || '')));
  if (handler) stop.push(handler);
  const next = { version: 1, ...config, hooks: { ...hooks } };
  if (stop.length) next.hooks.stop = stop; else delete next.hooks.stop;
  return next;
}

function install(options = {}) {
  const home = options.home || os.homedir();
  const log = options.log || (m => process.stdout.write(`${m}\n`));
  const dry = !!options.dryRun, remove = !!options.uninstall;
  const claudeSkill = path.join(home, '.claude', 'skills', NAME);
  const agentsSkill = path.join(home, '.agents', 'skills', NAME);
  for (const target of [claudeSkill, agentsSkill]) (remove ? removeSkill : copySkill)(target, log, dry);
  if (options.hooks === false && !remove) return { home };
  // The hooks call the ~/.agents copy (or the source when installing onto itself); plain "node" works in cmd, PowerShell and bash.
  const runner = fwd(path.join(path.resolve(agentsSkill) === SOURCE ? SOURCE : agentsSkill, 'scripts', 'testpool.cjs'));
  const command = agent => `node "${runner}" hook --agent ${agent}`;
  const claudeFile = path.join(home, '.claude', 'settings.json');
  writeObject(claudeFile, mergeGrouped(readObject(claudeFile), 'Stop', remove ? null : {
    type: 'command', command: command('claude'), timeout: TIMEOUT_SEC, statusMessage: 'Test pool',
    ...(options.claudeAsync ? { asyncRewake: true } : {}),
  }), log, dry, remove ? 'Stop hook removed' : `Stop hook${options.claudeAsync ? ', background' : ''}`);
  const codexFile = path.join(home, '.codex', 'hooks.json');
  writeObject(codexFile, mergeGrouped(readObject(codexFile), 'Stop', remove ? null : { type: 'command', command: command('codex'), timeout: TIMEOUT_SEC }),
    log, dry, remove ? 'Stop hook removed' : 'Stop hook');
  const cursorFile = path.join(home, '.cursor', 'hooks.json');
  writeObject(cursorFile, mergeCursor(readObject(cursorFile), remove ? null : { command: command('cursor'), timeout: TIMEOUT_SEC }),
    log, dry, remove ? 'stop hook removed' : 'stop hook');
  return { home, runner };
}

module.exports = { install, mergeGrouped, mergeCursor, MARK };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--home');
  try {
    const r = install({ home: at >= 0 ? argv[at + 1] : undefined, uninstall: argv.includes('--uninstall'), hooks: !argv.includes('--no-hooks'),
      claudeAsync: argv.includes('--claude-async'), dryRun: argv.includes('--dry-run') });
    if (!argv.includes('--uninstall')) {
      process.stdout.write(`\nDone. Restart open Claude Code, Codex and Cursor sessions to load the hook.\n`);
      if (!process.env.JEV_API_KEY && !process.env.JEV_API_KEY_FILE)
        process.stdout.write('JEV_API_KEY is not set: without it the pool runs only path-matched cheap and medium tests.\n');
      if (r.runner) process.stdout.write(`Runner: ${r.runner}\n`);
    }
  } catch (error) {
    process.stderr.write(`install failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
