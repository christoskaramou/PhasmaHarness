const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function serviceUnit(scope) {
  return 'phasma-harness-' + createHash('sha256').update(fs.realpathSync(scope)).digest('hex') + '.service';
}

async function containLinux(scope) {
  if (!scope || !/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID || '') ||
      !fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) return { supported: false };
  const group = /^0::([^\n]+)$/m.exec(fs.readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
  const unit = serviceUnit(scope);
  if (!group || path.posix.basename(group) !== unit) return { supported: false };
  const properties = ['Id', 'MainPID', 'InvocationID', 'ControlGroup', 'ActiveState', 'KillMode',
    'SendSIGKILL', 'TimeoutStopUSec', 'ExitType', 'NoNewPrivileges', 'ProtectControlGroups', 'Delegate'];
  let values;
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/systemctl', ['--user', 'show', unit,
      '--property=' + properties.join(',')], { timeout: 5000, maxBuffer: 16384, encoding: 'utf8', windowsHide: true });
    values = Object.fromEntries(stdout.trim().split('\n').map(line => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1)];
    }));
  } catch { throw new Error('The runner could not verify its systemd service. No workers were started.'); }
  if (values.Id !== unit || values.MainPID !== String(process.pid) || values.InvocationID !== process.env.INVOCATION_ID ||
      values.ControlGroup !== group || !['active', 'activating'].includes(values.ActiveState) ||
      values.KillMode !== 'control-group' || values.SendSIGKILL !== 'yes' || values.ExitType !== 'main' ||
      values.TimeoutStopUSec !== '20s' ||
      values.NoNewPrivileges !== 'yes' || values.ProtectControlGroups !== 'yes' || values.Delegate !== 'no')
    throw new Error('The runner service must own this process and enforce cgroup cleanup before restart.');
  const directory = path.posix.join('/sys/fs/cgroup', group);
  const members = fs.readFileSync(path.posix.join(directory, 'cgroup.procs'), 'utf8').trim().split(/\s+/);
  const statistics = fs.readFileSync(path.posix.join(directory, 'cgroup.stat'), 'utf8');
  if (members.length !== 1 || members[0] !== String(process.pid) ||
      !/^nr_descendants 0$/m.test(statistics) || !/^nr_dying_descendants 0$/m.test(statistics))
    throw new Error('Previous service processes or child cgroups remain. No workers were started.');
  return { supported: true, recoverySafe: true, serviceUnit: unit };
}

module.exports = { containLinux, serviceUnit };
