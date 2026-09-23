#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { MCP_TOOLS, SERVER_NAME } = require('./router-bridge.cjs');

async function callBridge(tool, args) {
  const url = process.env.PHASMA_BRIDGE_URL;
  const token = process.env.PHASMA_BRIDGE_TOKEN;
  const sessionId = process.env.PHASMA_SESSION_ID;
  if (!url || !token || !sessionId) throw new Error('Helper MCP is missing bridge configuration.');
  const response = await fetch(`${url}/v1/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, tool, arguments: args || {} }),
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Helper bridge HTTP ${response.status}`);
  return body.result;
}

function toolResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], isError };
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message) {
  if (message.id === undefined) return;
  try {
    if (message.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        },
      });
      return;
    }
    if (message.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: message.id, result: { tools: MCP_TOOLS } });
      return;
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (!MCP_TOOLS.some(tool => tool.name === name)) throw new Error(`Unknown helper tool: ${name}`);
      const result = await callBridge(name, args);
      write({ jsonrpc: '2.0', id: message.id, result: toolResult(result, result?.isError === true) });
      return;
    }
    if (message.method === 'ping') {
      write({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  } catch (error) {
    write({ jsonrpc: '2.0', id: message.id, result: toolResult(error.message || 'Helper MCP call failed.', true) });
  }
}

function start() {
  createInterface({ input: process.stdin }).on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try { message = JSON.parse(trimmed); }
    catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (message.method === 'notifications/initialized' || message.method === 'initialized') return;
    handle(message);
  });
}

if (require.main === module) start();

module.exports = { start, callBridge, MCP_TOOLS, SERVER_NAME };
