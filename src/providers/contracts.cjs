/** @type {Record<string, {args:string[], tokens:string[]}>} */
const CONTRACTS = {
  codex: { args: ['app-server', '--help'], tokens: ['--stdio', '--config'] },
  claude: { args: ['--help'], tokens: ['--input-format', '--output-format', '--permission-mode', '--setting-sources', '--settings', '--resume', '--model', '--mcp-config', '--json-schema'] },
  cursor: { args: ['acp', '--help'], tokens: ['ACP', 'server'] },
  muse: { args: ['serve', '--help'], tokens: ['--disable-request-user-input'] },
  antigravity: { args: ['--help'], tokens: ['--input-format', '--output-format', '--agent', '--conversation', '--dangerously-skip-permissions'] },
  deepseek: { args: ['--help'], tokens: ['--profile'] },
};

/** @param {string} provider @param {string} output */
function verifyHelp(provider, output) {
  const contract = CONTRACTS[provider];
  if (!contract) throw new Error(`Unknown provider: ${provider}`);
  const words = new Set(output.replace(/\x1b\[[0-9;]*m/g, '').split(/[\s,=<>\[\]()]+/));
  const missing = contract.tokens.filter(token => !words.has(token));
  if (missing.length) throw new Error(`CLI interface changed; missing ${missing.join(', ')}`);
}

module.exports = { CONTRACTS, verifyHelp };
