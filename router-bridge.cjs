const http = require('node:http');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { TOOL: CONTEXT_TOOL } = require('./context-search.cjs');
const { TOOLS: HELPER_TOOLS, INSTRUCTIONS: HELPER_INSTRUCTIONS } = require('./tool-helpers.cjs');

const SERVER_NAME = 'phasma_harness';
const MCP_TOOLS = [CONTEXT_TOOL, ...HELPER_TOOLS].map(({ type, ...tool }) => tool);
const CLI_HELPER_INSTRUCTIONS =
  ' For project investigation, use project_context from the bundled phasma_harness MCP server when useful. It is a partial search: read project instructions normally, verify important claims in live source, and search further for missing or conflicting evidence. Do not repeat identical searches unless files or the question changed.' +
  HELPER_INSTRUCTIONS +
  ' These helpers are provided by the local phasma_harness MCP server bundled with this app. They do not replace Claude Code or Cursor native tools. router_find_tools and router_call_tool target Codex-connected MCP servers when this chat has a Codex thread; otherwise they return a clear unsupported note. Large-output capture applies to helper/gateway responses from this server, not to native CLI tools. This app does not rewrite project MCP configs or silently elevate MCP approvals.';

function mcpConfig(command, args, env) {
  return { mcpServers: { [SERVER_NAME]: { command, args, env } } };
}

function cursorMcpServers(command, args, env) {
  return [{
    type: 'stdio',
    name: SERVER_NAME,
    command,
    args,
    env: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })),
  }];
}

function claudeAllowedHelpers(access) {
  const read = [
    `mcp__${SERVER_NAME}__project_context`,
    `mcp__${SERVER_NAME}__router_find_tools`,
    `mcp__${SERVER_NAME}__router_read_output`,
  ];
  return access === 'read-only' ? read : [...read, `mcp__${SERVER_NAME}__router_call_tool`];
}

class RouterBridge {
  constructor(execute) {
    this.execute = execute;
    this.token = randomBytes(32).toString('hex');
    this.server = null;
    this.base = null;
  }

  async start() {
    if (this.server) return this.base;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    return this.base;
  }

  close() {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
    this.base = null;
  }

  envFor(sessionId) {
    if (!this.base) throw new Error('Helper bridge is not running.');
    return {
      PHASMA_BRIDGE_URL: this.base,
      PHASMA_BRIDGE_TOKEN: this.token,
      PHASMA_SESSION_ID: sessionId,
    };
  }

  childConfig(sessionId) {
    const script = path.join(__dirname, 'router-mcp.cjs');
    // Claude/Cursor spawn this with the host's process.execPath. Inside the
    // packaged app that is Electron; without ELECTRON_RUN_AS_NODE the child
    // boots as an Electron window instead of running the MCP script.
    const env = { ...this.envFor(sessionId), ELECTRON_RUN_AS_NODE: '1' };
    return {
      command: process.execPath,
      args: [script],
      env,
      claudeConfig: mcpConfig(process.execPath, [script], env),
      cursorServers: cursorMcpServers(process.execPath, [script], env),
      allowedTools: access => claudeAllowedHelpers(access),
      serverName: SERVER_NAME,
      instructions: CLI_HELPER_INSTRUCTIONS,
    };
  }

  async handle(req, res) {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      if (req.headers.origin || req.method !== 'POST' || req.url !== '/v1/call') {
        res.writeHead(403).end();
        return;
      }
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${this.token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized helper bridge call.' }));
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Helper request too large.');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body.tool !== 'string' || typeof body.sessionId !== 'string' ||
          (body.arguments !== undefined && (typeof body.arguments !== 'object' || Array.isArray(body.arguments)))) {
        throw new Error('Invalid helper request.');
      }
      const result = await this.execute(body.sessionId, body.tool, body.arguments || {}, abort.signal);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result }));
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: error.message || 'Helper call failed.' }));
      } else res.destroy();
    }
  }
}

module.exports = {
  RouterBridge,
  SERVER_NAME,
  MCP_TOOLS,
  CLI_HELPER_INSTRUCTIONS,
  mcpConfig,
  cursorMcpServers,
  claudeAllowedHelpers,
};
