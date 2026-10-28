// What each backend supports, so callers check a capability instead of a provider name.
// A missing provider means Codex. API providers (ids without ':') run in Harness's own agent loop
// (src/providers/api-agent.cjs) on the CLI turn path, never through Codex.
// steer: Codex's native turn/steer. liveQueue: the running turn accepts follow-ups into the provider's own queue
// (answered after the current step). liveSteer: the running turn applies a Send now message within that turn.
// tasks: the provider reports the turn's running tasks, so Harness lists them and stops each one (Controller.backgroundTask).
const API = Object.freeze({ cli: true, api: true, steer: false, compact: false, usage: true, liveQueue: true, liveSteer: true });
const CAPABILITIES = Object.freeze({
  codex: Object.freeze({ cli: false, steer: true, compact: true, usage: true, tasks: true }),
  'claude-cli': Object.freeze({ cli: true, steer: false, compact: true, usage: true, liveQueue: true, tasks: true }),
  'cursor-cli': Object.freeze({ cli: true, steer: false, compact: false, usage: false, liveSteer: true }),
  'native:deepseek': Object.freeze({ cli: true, steer: false, compact: false, usage: false, liveSteer: true }),
  // structured: false = refuses schema replies (worker-only), so it cannot run the Hub or routing.
  'native:muse': Object.freeze({ cli: true, steer: false, compact: false, usage: true, structured: false, liveQueue: true, liveSteer: true }),
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

module.exports = { CAPABILITIES, API, capabilities, isCLI };
