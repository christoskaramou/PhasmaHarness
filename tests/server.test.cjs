const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { options, startServer } = require('../src/server.cjs');
const { renderService, quote } = require('../tools/linux-service.cjs');
const { RemoteSettings } = require('../src/remote-settings.cjs');
const vm = require('node:vm');
const { promisify } = require('node:util');

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-server-options-')));
  t.after(() => {
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('harness-server-options-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('server options use explicit overrides without replacing saved access settings on restart', t => {
  const data = fixture(t), saved = new RemoteSettings(data);
  saved.save({ port: 9898, origin: 'https://runner.example', sessions: [] });
  assert.deepEqual(options(['--data', data]), { data, link: false });
  assert.equal(new RemoteSettings(data).value.port, 9898);
  assert.deepEqual(options(['--data', data, '--port', '8789', '--connection-link']), { data, port: 8789, link: true });
  for (const args of [['--data', 'relative'], ['--data', data, '--port', '0'], ['--data', data, '--port', '2.5'],
    ['--data', data, '--origin', 'http://public.example'], ['--data', data, '--data', data], ['--unknown'], ['--port']])
    assert.throws(() => options(args));
});

test('generated service uses the verified cgroup policy and quotes literal paths without a shell or secret link', t => {
  const data = fixture(t), saved = new RemoteSettings(data);
  saved.save({ port: 9898, origin: 'https://runner.example' });
  const body = renderService({ data, node: '/node path/$literal%/node', root: '/project path/$literal%/root' });
  for (const line of ['Type=exec', 'ExitType=main', 'KillMode=control-group', 'TimeoutStopSec=20s', 'SendSIGKILL=yes',
    'NoNewPrivileges=yes', 'ProtectControlGroups=yes', 'Delegate=no', 'Restart=on-failure', 'UMask=0077']) assert.ok(body.includes(line));
  assert.match(body, /ExecStart=:"\/node path\/\$literal%%\/node"/);
  assert.match(body, /"--port" "9898"/);
  assert.match(body, /"--origin" "https:\/\/runner.example"/);
  assert.ok(!body.includes('--connection-link'));
  assert.ok(!body.includes('/bin/sh'));
  assert.equal(quote('a"b\\c%$'), '"a\\"b\\\\c%%$"');
  assert.throws(() => quote('/path\nExecStart=other'));
});

test('unmanaged or non-Linux server startup cannot begin provider execution', async t => {
  const data = fixture(t);
  await assert.rejects(startServer({ data }), process.platform === 'linux' && process.getuid() !== 0 ? /managed systemd service/ : /regular Linux user/);
  assert.equal(fs.existsSync(path.join(data, 'sessions.json')), false);
  assert.equal(fs.existsSync(path.join(data, 'credentials.phasma-remote')), false);
});

test('service setup refuses a running owner and cannot claim boot persistence when lingering is denied', async t => {
  const directory = fixture(t), data = path.join(directory, 'data'); fs.mkdirSync(data);
  const calls = [], messages = [];
  let active = true, denied = false, foreign = false;
  const execute = () => {};
  execute[promisify.custom] = async (command, args) => {
    calls.push({ command, args: Array.from(args) });
    if (command.endsWith('/systemctl') && args.includes('show')) return { stdout: active ? 'active\n' : 'inactive\n' };
    if (command.endsWith('/loginctl') && denied) throw new Error('Policy denied lingering.');
    return { stdout: '' };
  };
  const source = fs.readFileSync(path.join(__dirname, '../tools/linux-service.cjs'), 'utf8'), module = { exports: {} };
  const environment = { platform: 'linux', getuid: () => 1000, execPath: process.execPath, versions: { node: '24.11.1' },
    env: { XDG_CONFIG_HOME: path.join(directory, 'config') } };
  vm.runInNewContext(source, { module, __dirname: path.resolve(__dirname, '../tools'), process: environment,
    console: { log: value => messages.push(value) }, require: name => {
      if (name === 'node:child_process') return { execFile: execute };
      if (name === 'node:fs') return { ...fs, lstatSync: (filename, settings) => foreign && filename.endsWith('.service')
        ? { isFile: () => true, isSymbolicLink: () => true, uid: 1000, nlink: 1 } : fs.lstatSync(filename, settings) };
      if (name === '../src/server.cjs') return { options, privateData: value => value };
      return require(name);
    } });
  await assert.rejects(module.exports.install(['--data', data]), /Stop .* before reinstalling/);
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(environment.env.XDG_CONFIG_HOME), false);
  active = false; foreign = true; calls.length = 0;
  await assert.rejects(module.exports.install(['--data', data]), /unrecognized service file/);
  assert.ok(!calls.some(call => call.command.endsWith('/loginctl')));
  foreign = false; denied = true; calls.length = 0;
  await assert.rejects(module.exports.install(['--data', data]), /needs user lingering/);
  assert.ok(calls.some(call => call.command.endsWith('/loginctl') && call.args.includes('1000')));
  assert.ok(!calls.some(call => call.args.includes('enable') || call.args.includes('restart')));
  assert.equal(messages.length, 0);
  assert.ok(!fs.readdirSync(data).some(name => name.startsWith('service-check-')));
});

test('a taken port fails startup before the runner pumps any queued job', async t => {
  const data = fixture(t), calls = [];
  const runner = { agents: {}, documents: {}, containment: {}, updater: { on() {} },
    async initialize() { calls.push('initialize'); }, async shutdown() { calls.push('shutdown'); } };
  runner.agents.on = () => {};
  const stubs = {
    './runner.cjs': { createRunner: async () => runner },
    './runner-commands.cjs': { registerRunnerCommands() {}, assertRunnerOpen() {} },
    './remote.cjs': { RemoteRunner: class { async listen() { calls.push('listen'); throw new Error('EADDRINUSE'); } async close() {} } },
    './remote-settings.cjs': { RemoteSettings: class { constructor() { this.value = {}; } validate(value) { return value; } key() { return 'k'; } } },
    './log.cjs': { Log: class {} },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/server.cjs'), 'utf8'), {
    module, __dirname: path.resolve(__dirname, '../src'), console,
    process: { platform: 'linux', getuid: () => 1000 },
    require: name => stubs[name] || (name === 'node:fs' ? { ...fs, lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o700 }), mkdirSync() {}, realpathSync: value => value } : require(name)),
  });
  await assert.rejects(module.exports.startServer({ data, port: 1 }), /EADDRINUSE/);
  assert.deepEqual(calls, ['listen', 'shutdown']);
});
