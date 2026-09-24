// What each backend supports, so callers check a capability instead of a provider name.
// API providers (and a missing provider) run through the Codex app-server and share its capabilities.
const CAPABILITIES = Object.freeze({
  codex: Object.freeze({ cli: false, steer: true, compact: true, usage: true }),
  'claude-cli': Object.freeze({ cli: true, steer: false, compact: true, usage: true }),
  'cursor-cli': Object.freeze({ cli: true, steer: false, compact: false, usage: false }),
});

function capabilities(provider) { return Object.hasOwn(CAPABILITIES, provider) ? CAPABILITIES[provider] : CAPABILITIES.codex; }
// Local CLI backends (Claude Code, Cursor) run one process per turn, outside the Codex connection.
function isCLI(provider) { return capabilities(provider).cli; }

module.exports = { CAPABILITIES, capabilities, isCLI };
