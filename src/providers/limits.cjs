// Provider usage limits, from what each CLI reports:
// - Codex app-server: turn.error.codexErrorInfo ("usageLimitExceeded" | "rateLimitExceeded") and
//   account/rateLimits (primary/secondary windows: usedPercent, windowDurationMins, resetsAt in seconds).
// - Claude Code stream-json: rate_limit_event.rate_limit_info (status allowed | allowed_warning | rejected,
//   resetsAt in seconds, rateLimitType, utilization) and assistant.error === "rate_limit".
// - Cursor ACP: a limit ends the reply with the CLI's action text for its usage/rate-limit errors
//   ("Upgrade your plan to continue", or "Add a payment method to continue" for usage pricing).
const CODEX_LIMIT_CODES = new Set(['usageLimitExceeded', 'rateLimitExceeded']);
const CURSOR_LIMIT_TEXTS = ['\n\nUpgrade your plan to continue', '\n\nAdd a payment method to continue'];
const UNKNOWN_RESET_MS = 15 * 60 * 1000; // no reset time reported: try the provider again after this
// Claude's weekly per-model windows limit only that model family, not the whole provider.
const CLAUDE_MODEL_WINDOWS = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };

function codexTurnLimited(error) {
  const info = error?.codexErrorInfo;
  return typeof info === 'string' && CODEX_LIMIT_CODES.has(info);
}

function cursorLimitText(output) {
  const text = String(output || '');
  return CURSOR_LIMIT_TEXTS.find(suffix => text.endsWith(suffix))?.trim() || null;
}

const seconds = value => Number.isFinite(value) && value > 0 ? value * 1000 : null;

// A Codex window at 100% is a known limit until its reset. A window whose reset has passed is stale and ignored.
function codexWindowReset(snapshot, now = Date.now()) {
  const full = [snapshot?.primary, snapshot?.secondary].filter(w => w && Number.isFinite(w.usedPercent) && w.usedPercent >= 100 &&
    !(seconds(w.resetsAt) && seconds(w.resetsAt) <= now));
  const resets = full.map(w => seconds(w.resetsAt)).filter(Boolean);
  return full.length ? (resets.length ? Math.max(...resets) : null) : undefined;
}

const covers = (entry, model) => !entry.family || String(model || '').toLowerCase().includes(entry.family);

class ProviderLimits {
  constructor(store = {}, now = () => Date.now()) { this.store = store; this.now = now; this.usage = {}; }
  // The store holds one entry per provider for the whole provider (key "<provider>") and one per model family
  // (key "<provider>:<family>"), each with its own reset, so limits on different windows never replace each other.
  // until: epoch ms, or null when the provider did not say. family: only models whose id contains it are limited.
  mark(provider, { until = null, reason = 'Usage limit reached.', family = null } = {}) {
    if (!provider) return null;
    const at = this.now();
    const scoped = typeof family === 'string' && family ? family.toLowerCase() : null;
    const entry = { at, until: Number.isFinite(until) && until > at ? until : at + UNKNOWN_RESET_MS, reason: String(reason).slice(0, 240), known: Number.isFinite(until),
      ...(scoped ? { family: scoped } : {}) };
    this.store[scoped ? `${provider}:${scoped}` : provider] = entry;
    return entry;
  }
  // Lifts what a successful turn with this model shows is over: the provider-wide limit and its model's family limits.
  clear(provider, model = null) {
    delete this.store[provider];
    for (const key of this.keys(provider)) if (model && covers(this.store[key], model)) delete this.store[key];
  }
  keys(provider) { return Object.keys(this.store).filter(key => key.startsWith(provider + ':')); }
  entry(key) {
    const entry = this.store[key];
    if (!entry) return null;
    if (!(entry.until > this.now())) { delete this.store[key]; return null; }
    return entry;
  }
  // The provider-wide limit, if any.
  current(provider) { return this.entry(provider); }
  // Whether this model (or, without a model, the whole provider) is limited.
  limited(provider, model = null) {
    const wide = this.entry(provider);
    if (wide && (!wide.family || covers(wide, model))) return wide;
    if (!model) return null;
    for (const key of this.keys(provider)) {
      const entry = this.entry(key);
      if (entry && covers(entry, model)) return entry;
    }
    return null;
  }
  // Latest reported usage for the settings panel (not persisted).
  setUsage(provider, value) { if (provider && value) this.usage[provider] = { ...value, at: this.now() }; }
  active() {
    for (const key of Object.keys(this.store)) this.entry(key);
    return { ...this.store };
  }
}

module.exports = { ProviderLimits, codexTurnLimited, cursorLimitText, codexWindowReset, CODEX_LIMIT_CODES, CURSOR_LIMIT_TEXTS, CLAUDE_MODEL_WINDOWS, UNKNOWN_RESET_MS };
