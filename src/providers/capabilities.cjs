// What each backend supports, so callers check a capability instead of a provider name.
// A missing provider means Codex. API providers (ids without ':') run in Harness's own agent loop
// (src/providers/api-agent.cjs) on the CLI turn path, never through Codex.
const API = Object.freeze({ cli: true, api: true, steer: false, compact: false, usage: true });
const CAPABILITIES = Object.freeze({
  codex: Object.freeze({ cli: false, steer: true, compact: true, usage: true }),
  'claude-cli': Object.freeze({ cli: true, steer: false, compact: true, usage: true }),
  'cursor-cli': Object.freeze({ cli: true, steer: false, compact: false, usage: false }),
  'native:deepseek': Object.freeze({ cli: true, steer: false, compact: false, usage: false }),
  // structured: false = refuses schema replies (worker-only), so it cannot run the Hub or routing.
  'native:muse': Object.freeze({ cli: true, steer: false, compact: false, usage: true, structured: false }),
  'native:antigravity': Object.freeze({ cli: true, steer: false, compact: false, usage: true, structured: false }),
});

// A native CLI Harness no longer ships (a stale saved selection) stays on the CLI path, where it is refused as unavailable.
const REMOVED_NATIVE = Object.freeze({ cli: true, steer: false, compact: false, usage: false });

function capabilities(provider) {
  if (Object.hasOwn(CAPABILITIES, provider)) return CAPABILITIES[provider];
  if (typeof provider === 'string' && provider.startsWith('native:'))
    return REMOVED_NATIVE;
  return typeof provider === 'string' && provider && !provider.includes(':') ? API : CAPABILITIES.codex;
}
// Local CLI backends (Claude Code, Cursor) run one process per turn, outside the Codex connection.
function isCLI(provider) { return capabilities(provider).cli; }

module.exports = { CAPABILITIES, capabilities, isCLI };
