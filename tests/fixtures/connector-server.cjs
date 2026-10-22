const http = require('node:http');
const { createHash } = require('node:crypto');
const tools = [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { text: { type: 'string' }, delay: { type: 'integer', minimum: 0 } }, required: ['text'], additionalProperties: false } }];
async function rpc(message, state) {
  if (message.id === undefined) return null;
  let result;
  if (message.method === 'initialize') {
    state.initializations = (state.initializations || 0) + 1;
    if (state.delayInitialize) await new Promise(resolve => { const timer = setTimeout(resolve, state.delayInitialize); timer.unref(); });
    result = { protocolVersion: message.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } };
  }
  else if (message.method === 'tools/list') result = { tools };
  else if (message.method === 'tools/call') {
    state.calls.push(message.params); const args = message.params.arguments;
    if (args.delay) await new Promise(resolve => { const timer = setTimeout(resolve, args.delay); timer.unref(); });
    result = { content: [{ type: 'text', text: JSON.stringify({ text: args.text, cwd: process.cwd(), pid: process.pid, secret: process.env.CONNECTOR_FIXTURE_SECRET || null, inherited: process.env.PHASMA_TEST_PRIVATE || null }) }] };
  } else result = {};
  return { jsonrpc: '2.0', id: message.id, result };
}
async function serve({ bearer, oauth = false } = {}) {
  const state = { calls: [], tokens: 0, registrations: 0, codes: new Map() };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, state.url); let body = ''; for await (const chunk of req) body += chunk;
      const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      if (oauth) {
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: state.url + '/mcp', authorization_servers: [state.url] });
        if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return json(200, { issuer: state.url, authorization_endpoint: state.url + '/authorize', token_endpoint: state.url + '/token', registration_endpoint: state.url + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
        if (url.pathname === '/register') { state.registrations++; return json(201, { ...JSON.parse(body), client_id: 'fixture-client' }); }
        if (url.pathname === '/authorize') {
          const code = 'code-' + state.codes.size; state.codes.set(code, Object.fromEntries(url.searchParams));
          const redirect = new URL(url.searchParams.get('redirect_uri')); redirect.searchParams.set('code', code); redirect.searchParams.set('state', url.searchParams.get('state'));
          res.writeHead(302, { location: redirect.href }).end(); return;
        }
        if (url.pathname === '/token') {
          const args = new URLSearchParams(body);
          if (args.get('grant_type') === 'authorization_code') {
            const code = state.codes.get(args.get('code'));
            if (!code || createHash('sha256').update(args.get('code_verifier') || '').digest('base64url') !== code.code_challenge || args.get('redirect_uri') !== code.redirect_uri) return json(400, { error: 'invalid_grant' });
          }
          state.tokens++; return json(200, { access_token: 'fixture-access-' + state.tokens, token_type: 'Bearer', refresh_token: 'fixture-refresh', expires_in: 3600 });
        }
      }
      if (url.pathname !== '/mcp') return json(404, {});
      const expected = oauth ? 'fixture-access-' + state.tokens : bearer;
      if ((oauth || bearer) && (!expected || req.headers.authorization !== 'Bearer ' + expected || (oauth && !state.tokens))) {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${state.url}/.well-known/oauth-protected-resource"` }).end(); return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const result = await rpc(JSON.parse(body), state);
      if (result) json(200, result); else res.writeHead(202).end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); state.url = `http://127.0.0.1:${server.address().port}`;
  return { ...state, state, url: state.url + '/mcp', close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
if (require.main === module) {
  const state = { calls: [] };
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => { rpc(JSON.parse(line), state).then(result => { if (result) process.stdout.write(JSON.stringify(result) + '\n'); }); });
} else module.exports = { serve };
