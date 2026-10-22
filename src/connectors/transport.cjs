const spawn = require('cross-spawn');
const { JSONRPCMessageSchema } = require('@modelcontextprotocol/core');
const { getDefaultEnvironment } = require('@modelcontextprotocol/client/stdio');
const { spawnOwned, stopTree } = require('../process-tree.cjs');

// The SDK owns the protocol; Harness owns local process trees, including detached children.
class ConnectorStdio {
  constructor(command, args, cwd, env) { Object.assign(this, { command, args, cwd, env }); this.closed = false; }
  async start() {
    if (this.child) throw new Error('Connector transport already started.');
    const env = { ...getDefaultEnvironment(), ...this.env };
    if (this.command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
    const child = this.child = spawnOwned(spawn, this.command, this.args, { cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', error => this.onerror?.(error));
    child.stderr.on('data', () => {}); // Server diagnostics can contain credentials; never copy them into chat or logs.
    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', text => {
      buffer += text;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { this.onerror?.(new Error('Connector response exceeds 8 MB.')); this.close().catch(() => {}); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line))); }
        catch { this.onerror?.(new Error('Connector returned an invalid protocol message.')); this.close().catch(() => {}); break; }
      }
    });
    child.once('exit', () => { if (!this.closed) { this.closed = true; this.onclose?.(); } this.close().catch(error => this.onerror?.(error)); });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  send(message) {
    if (this.closed || !this.child) return Promise.reject(new Error('Connector is disconnected.'));
    return new Promise((resolve, reject) => this.child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve()));
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const remaining = await stopTree(this.child);
      if (!this.closed) { this.closed = true; this.onclose?.(); }
      if (remaining.length) throw new Error('Connector process cleanup is not confirmed.');
    })();
    return this.closing;
  }
}
module.exports = { ConnectorStdio };
