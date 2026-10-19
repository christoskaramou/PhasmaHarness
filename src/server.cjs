const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createRunner } = require('./runner.cjs');
const { registerRunnerCommands, assertRunnerOpen } = require('./runner-commands.cjs');
const { RemoteRunner } = require('./remote.cjs');
const { RemoteSettings } = require('./remote-settings.cjs');
const { Log } = require('./log.cjs');

function options(args) {
  const result = { data: path.join(os.homedir(), '.local', 'share', 'phasma-harness'), link: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('Do not repeat server options.');
    seen.add(flag);
    if (flag === '--connection-link') result.link = true;
    else if (['--data', '--port', '--origin'].includes(flag) && args[index + 1] && !args[index + 1].startsWith('--')) {
      result[flag.slice(2)] = flag === '--port' ? Number(args[++index]) : args[++index];
    } else throw new Error('Use --data <directory>, --port <port>, --origin <HTTPS origin> or --connection-link.');
  }
  if (!path.isAbsolute(result.data)) throw new Error('Use an absolute server data directory.');
  const configuration = new RemoteSettings(result.data);
  configuration.validate({ ...configuration.value, enabled: true,
    port: result.port ?? configuration.value.port, origin: result.origin ?? configuration.value.origin });
  return result;
}

function privateData(directory) {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Run the server as a regular Linux user.');
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Use an absolute server data directory.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error('The server data directory must be private, ordinary and owned by this user.');
  return fs.realpathSync(directory);
}

async function startServer({ data, port, origin }) {
  data = privateData(data);
  const configuration = new RemoteSettings(data);
  const value = configuration.validate({ ...configuration.value, enabled: true,
    port: port ?? configuration.value.port, origin: origin === undefined ? configuration.value.origin : origin });
  const log = new Log(path.join(data, 'logs'));
  const requests = new AsyncLocalStorage(), commands = new Map();
  let remote, closing;
  const runner = await createRunner({ data, log, safeStorage: { isEncryptionAvailable: () => false } });
  const close = () => {
    if (!closing) closing = (async () => {
      runner.agents.closing = true;
      try { await remote?.close(); }
      catch (error) { log.error('Browser cleanup failed', { message: error.message }); }
      finally { await runner.shutdown(); }
    })();
    return closing;
  };
  try {
    registerRunnerCommands((name, handler) => commands.set(name, handler), { runner,
      ask: request => requests.getStore()?.ask(request) || Promise.resolve(false),
      normalizeImage: (url, signal) => runner.documents.image(url, signal),
      openFolder: async () => { throw new Error('Download the artifact to open it on this device.'); },
      stopDownloads: () => remote?.stopDownloads() });
    commands.set('appInfo', () => ({ version: require('../package.json').version, packaged: false }));
    commands.set('runnerInfo', () => ({ status: 'Runner ready', autostart: { supported: false, enabled: true } }));
    remote = new RemoteRunner({ key: configuration.key(), sessions: value.sessions,
      saveSessions: sessions => configuration.save({ sessions }), snapshot: () => runner.agents.snapshot(),
      artifactDownload: (args, signal) => runner.agents.artifactDownload(args, signal),
      invoke: (name, args, ask) => requests.run({ ask }, async () => {
        assertRunnerOpen(runner.agents, name);
        const handler = commands.get(name);
        if (!handler) throw new Error('Use the runner host for this action.');
        try { return await handler(...args); }
        catch (error) { log.warn('Runner action failed', { name, message: String(error.message).slice(0, 300) }); throw error; }
      }) });
    runner.agents.on('state', state => remote.broadcast('state', state));
    runner.updater.on('state', state => remote.broadcast('update', state));
    await remote.listen(value);
    await runner.initialize();
    configuration.save({ enabled: true, port: value.port, origin: value.origin });
    log.info('Server ready', { origin: remote.origin, serviceUnit: runner.containment.serviceUnit });
    return { runner, remote, log, close };
  } catch (error) { await close(); throw error; }
}

async function main(args) {
  const settings = options(args);
  process.umask(0o077);
  process.env.PATH = path.join(__dirname, '..', 'tools', 'bin') + path.delimiter + process.env.PATH;
  require('./process-tree.cjs').cleanPowerShellModulePath();
  if (settings.link) {
    const directory = privateData(settings.data), remote = new RemoteSettings(directory);
    const origin = settings.origin || remote.value.origin || `http://127.0.0.1:${settings.port ?? remote.value.port}`;
    console.log(`${origin}/ui/index.html#key=${remote.key()}`);
    return;
  }
  const service = await startServer(settings);
  const stop = async code => {
    try { await service.close(); }
    catch (error) { service.log.error('Shutdown cleanup failed', { message: error.message }); code = 1; }
    process.exit(code);
  };
  process.once('SIGTERM', () => stop(0));
  process.once('SIGINT', () => stop(0));
  process.once('uncaughtException', error => { service.log.error('Uncaught exception', { message: error.message }); stop(1); });
  process.once('unhandledRejection', error => { service.log.error('Unhandled rejection', { message: String(error?.message || error) }); stop(1); });
  console.log('Phasma Harness server ready at ' + service.remote.origin);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { startServer, options, privateData, main };
