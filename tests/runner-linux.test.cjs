const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');

function fixture() {
  const scope = '/private/harness', unit = 'phasma-harness-' + createHash('sha256').update(scope).digest('hex') + '.service';
  const group = '/user.slice/user-1000.slice/user@1000.service/app.slice/' + unit;
  const state = { process: { pid: 1234, env: { INVOCATION_ID: 'a'.repeat(32) } }, unified: true, group, scope, calls: [],
    members: ['1234'], statistics: 'nr_descendants 0\nnr_dying_descendants 0\n',
    values: { Id: unit, MainPID: '1234', InvocationID: 'a'.repeat(32), ControlGroup: group, ActiveState: 'active',
      KillMode: 'control-group', SendSIGKILL: 'yes', TimeoutStopUSec: '20s', ExitType: 'main',
      NoNewPrivileges: 'yes', ProtectControlGroups: 'yes', Delegate: 'no' } };
  const run = () => {};
  run[promisify.custom] = async (command, args, options) => {
    state.calls.push({ command, args, options });
    if (state.error) throw state.error;
    return { stdout: Object.entries(state.values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n' };
  };
  const code = fs.readFileSync(path.join(__dirname, '../src/runner-linux.cjs'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(code, { module, process: state.process, require: name => {
    if (name === 'node:child_process') return { execFile: run };
    if (name === 'node:fs') return { realpathSync: () => state.scope, existsSync: () => state.unified,
      readFileSync: filename => filename.endsWith('/cgroup.procs') ? state.members.join('\n')
        : filename.endsWith('/cgroup.stat') ? state.statistics : '0::' + state.group + '\n' };
    return require(name);
  } });
  return { state, ...module.exports };
}

test('Linux recovery requires the actual scoped service, main process and bounded cgroup cleanup policy', async () => {
  const { state, containLinux, serviceUnit } = fixture();
  const result = await containLinux(state.scope);
  assert.equal(result.supported, true);
  assert.equal(result.recoverySafe, true);
  assert.equal(result.serviceUnit, serviceUnit(state.scope));
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].command, '/usr/bin/systemctl');
  assert.deepEqual(Array.from(state.calls[0].args).slice(0, 3), ['--user', 'show', result.serviceUnit]);
  assert.equal(state.calls[0].options.timeout, 5000);
  assert.ok(state.calls[0].options.maxBuffer <= 16384);
});

test('ordinary Linux desktops and unrelated services do not claim safe crash recovery', async () => {
  for (const change of [state => { delete state.process.env.INVOCATION_ID; }, state => { state.unified = false; },
    state => { state.group = '/init.scope'; }]) {
    const { state, containLinux } = fixture(); change(state);
    assert.equal((await containLinux(state.scope)).supported, false);
    assert.equal(state.calls.length, 0);
  }
});

test('forged invocation metadata, unsafe cleanup and unavailable service inspection fail before workers start', async () => {
  const unsafe = { Id: 'another.service', MainPID: '4321', InvocationID: 'b'.repeat(32), ControlGroup: '/another',
    ActiveState: 'inactive', KillMode: 'process', SendSIGKILL: 'no', TimeoutStopUSec: 'infinity', ExitType: 'cgroup',
    NoNewPrivileges: 'no', ProtectControlGroups: 'no', Delegate: 'yes' };
  for (const [key, value] of Object.entries(unsafe)) {
    const { state, containLinux } = fixture(); state.values[key] = value;
    await assert.rejects(containLinux(state.scope), /must own this process and enforce cgroup cleanup/, key);
  }
  const { state, containLinux } = fixture(); state.error = new Error('systemctl unavailable');
  await assert.rejects(containLinux(state.scope), /could not verify its systemd service/);
});

test('a replacement refuses actual leftover processes or nested cgroups even when service policy looks safe', async () => {
  for (const change of [state => { state.members.push('4321'); }, state => { state.members = []; },
    state => { state.statistics = 'nr_descendants 1\nnr_dying_descendants 0\n'; },
    state => { state.statistics = 'nr_descendants 0\nnr_dying_descendants 1\n'; }]) {
    const { state, containLinux } = fixture(); change(state);
    await assert.rejects(containLinux(state.scope), /Previous service processes or child cgroups remain/);
  }
});
