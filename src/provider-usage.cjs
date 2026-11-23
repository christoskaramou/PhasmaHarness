'use strict';

const CLAUDE_STANDARD_WINDOWS = Object.freeze([
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
  ['seven_day_oauth_apps', 'CLI/SDK weekly'],
  ['seven_day_opus', 'Opus weekly'],
  ['seven_day_sonnet', 'Sonnet weekly'],
]);

function formatPlanName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(word => {
      const lower = word.toLowerCase();
      if (lower === 'chatgpt') return 'ChatGPT';
      if (lower === 'api') return 'API';
      if (lower === 'ai') return 'AI';
      if (/[a-z]/.test(word) && /[A-Z]/.test(word)) return word;
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function windowDurationLabel(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return 'Window';
  if (mins === 300) return '5-hour';
  if (mins === 1440) return 'Daily';
  if (mins === 10080) return 'Weekly';
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${Math.round(mins)}-min`;
}

function parseIsoMs(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function errorMessage(error) {
  const text = String(error?.message || error || 'Usage lookup failed.').trim();
  return text ? text.slice(0, 400) : 'Usage lookup failed.';
}

function makeWindow(label, usedPercent, resetsAt) {
  return {
    label,
    usedPercent,
    remainingPercent: Math.max(0, Math.round(100 - usedPercent)),
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

function normalizeCodexUsage(input) {
  const main = input?.rateLimits && typeof input.rateLimits === 'object'
    ? input.rateLimits
    : (input && typeof input === 'object' ? input : null);
  const byId = input?.rateLimitsByLimitId && typeof input.rateLimitsByLimitId === 'object'
    ? input.rateLimitsByLimitId
    : null;

  const windows = [];
  const addBucketWindows = (bucket, prefix = null) => {
    if (!bucket || typeof bucket !== 'object') return;
    for (const [key, fallback] of [['primary', 'Primary'], ['secondary', 'Secondary']]) {
      const w = bucket[key];
      if (!w || typeof w !== 'object' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0) continue;
      const base = Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0
        ? windowDurationLabel(w.windowDurationMins)
        : fallback;
      const label = prefix ? `${prefix} · ${base}` : base;
      const resetsAt = Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : null;
      windows.push(makeWindow(label, w.usedPercent, resetsAt));
    }
  };

  addBucketWindows(main);

  if (byId) {
    const primaryLimitId = main?.limitId || (windows.length ? 'codex' : null);
    const seen = new Set(primaryLimitId ? [primaryLimitId] : []);
    for (const [key, bucket] of Object.entries(byId)) {
      if (!bucket || typeof bucket !== 'object') continue;
      const bucketId = bucket.limitId || key;
      if (seen.has(key) || seen.has(bucketId)) continue;
      seen.add(key);
      seen.add(bucketId);
      const prefix = bucket.limitName || bucket.limitId || key;
      addBucketWindows(bucket, prefix);
    }
  }

  const extra = [];
  const credits = main?.credits;
  if (credits?.unlimited) {
    extra.push('Unlimited credits');
  } else if (credits?.hasCredits) {
    const hasBalance = credits.balance !== undefined && credits.balance !== null && String(credits.balance).trim() !== '';
    extra.push(hasBalance ? `Credits balance: ${credits.balance}` : 'Credits available');
  }

  return {
    plan: formatPlanName(main?.planType),
    windows,
    extra,
  };
}

function normalizeClaudeUsage(report) {
  const plan = formatPlanName(report?.subscription_type);
  if (!report || typeof report !== 'object' || report.rate_limits_available !== true || !report.rate_limits || typeof report.rate_limits !== 'object') {
    return { available: false, plan, windows: [], extra: [] };
  }

  const limits = report.rate_limits;
  const scopedSharesByName = new Map();
  const weeklyShares = [];
  if (Array.isArray(limits.weekly_scoped_shares) && Array.isArray(limits.limits)) {
    for (const share of limits.weekly_scoped_shares.slice(0, 100)) {
      if (!share || !Number.isInteger(share.limit_index) || share.limit_index < 0 || share.limit_index >= limits.limits.length) continue;
      const entry = limits.limits[share.limit_index];
      const rawName = entry?.scope?.model?.display_name || entry?.scope?.surface?.display_name;
      if (typeof rawName !== 'string' || !rawName.trim()) continue;
      const label = rawName.trim().slice(0, 100);
      const usedPercentOfWeekly = Number.isFinite(share.used_percent_of_weekly) && share.used_percent_of_weekly >= 0
        ? share.used_percent_of_weekly : null;
      const allowancePercentOfWeekly = Number.isFinite(share.allowance_percent_of_weekly) && share.allowance_percent_of_weekly > 0
        ? share.allowance_percent_of_weekly : null;
      if (usedPercentOfWeekly === null && allowancePercentOfWeekly === null) continue;
      const info = {
        label,
        ...(usedPercentOfWeekly !== null ? { usedPercentOfWeekly } : {}),
        ...(allowancePercentOfWeekly !== null ? { allowancePercentOfWeekly } : {}),
      };
      weeklyShares.push(info);
      scopedSharesByName.set(label.toLowerCase(), info);
    }
  }

  const windows = [];
  for (const [key, label] of CLAUDE_STANDARD_WINDOWS) {
    const w = limits[key];
    if (!w || typeof w !== 'object' || !Number.isFinite(w.utilization) || w.utilization < 0) continue;
    const win = makeWindow(label, w.utilization, parseIsoMs(w.resets_at));
    if (key === 'seven_day' && weeklyShares.length) win.shares = weeklyShares;
    windows.push(win);
  }

  const seenScoped = new Set();
  const addScopedWindow = (rawName, utilization, resetsAt) => {
    if (typeof rawName !== 'string' || !rawName.trim()) return;
    if (!Number.isFinite(utilization) || utilization < 0) return;
    const name = rawName.trim().slice(0, 100);
    const key = name.toLowerCase();
    if (seenScoped.has(key)) return;
    seenScoped.add(key);
    const win = makeWindow(`${name} weekly`, utilization, parseIsoMs(resetsAt));
    const share = scopedSharesByName.get(key);
    if (share) {
      if (share.usedPercentOfWeekly !== undefined) win.usedPercentOfWeekly = share.usedPercentOfWeekly;
      if (share.allowancePercentOfWeekly !== undefined) win.allowancePercentOfWeekly = share.allowancePercentOfWeekly;
    }
    windows.push(win);
  };

  if (Array.isArray(limits.model_scoped)) {
    for (const w of limits.model_scoped.slice(0, 100)) {
      addScopedWindow(w?.display_name, w?.utilization, w?.resets_at);
    }
  }
  if (Array.isArray(limits.limits)) {
    for (const entry of limits.limits.slice(0, 100)) {
      if (entry?.kind !== 'weekly_scoped') continue;
      addScopedWindow(entry?.scope?.model?.display_name || entry?.scope?.surface?.display_name, entry?.percent, entry?.resets_at);
    }
  }

  const extra = [];
  const extraUsage = limits.extra_usage;
  if (extraUsage?.is_enabled === true) {
    const parts = ['Extra usage enabled'];
    if (Number.isFinite(extraUsage.utilization) && extraUsage.utilization >= 0) {
      parts.push(`${Math.round(extraUsage.utilization)}% used`);
    }
    if (Number.isFinite(extraUsage.used_credits) && extraUsage.used_credits >= 0) {
      const decimals = Number.isInteger(extraUsage.decimal_places) && extraUsage.decimal_places >= 0 && extraUsage.decimal_places <= 6
        ? extraUsage.decimal_places : 2;
      const scale = 10 ** decimals;
      const currency = typeof extraUsage.currency === 'string' && extraUsage.currency.trim()
        ? extraUsage.currency.trim().toUpperCase() : 'USD';
      const fmt = minor => {
        const amount = (minor / scale).toFixed(decimals);
        return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
      };
      if (Number.isFinite(extraUsage.monthly_limit) && extraUsage.monthly_limit > 0) {
        parts.push(`${fmt(extraUsage.used_credits)} / ${fmt(extraUsage.monthly_limit)}`);
      } else {
        parts.push(`${fmt(extraUsage.used_credits)} spent`);
      }
    }
    extra.push(parts.join(' · '));
  }

  return { available: true, plan, windows, extra };
}

const antigravityWindowRank = bucket => {
  const w = typeof bucket?.window === 'string' ? bucket.window.trim().toLowerCase() : '';
  return w === '5h' ? 0 : w === 'weekly' ? 2 : 1;
};

function normalizeAntigravityUsage(report, creditsReport = null) {
  const data = report?.command?.data;
  const groups = data?.groups;
  const windows = [];
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const groupName = typeof group.name === 'string' && group.name.trim() ? group.name.trim() : '';
      const rawBuckets = Array.isArray(group.buckets)
        ? group.buckets
        : Array.isArray(group.windows)
          ? group.windows
          : typeof group.remaining_fraction === 'number'
            ? [group]
            : [];
      const buckets = [...rawBuckets].sort((a, b) => antigravityWindowRank(a) - antigravityWindowRank(b));
      for (const bucket of buckets) {
        if (!bucket || typeof bucket !== 'object') continue;
        const remaining = bucket.remaining_fraction;
        if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
        const remainingPercent = Math.round(remaining * 100);
        const usedPercent = Math.max(0, Math.min(100, Math.round((1 - remaining) * 100)));
        const rawWindow = typeof bucket.window === 'string' ? bucket.window.trim() : '';
        const rawName = typeof bucket.name === 'string' ? bucket.name.trim() : '';
        const windowName = rawWindow === '5h' ? '5-hour' : rawWindow === 'weekly' ? 'Weekly' : (rawName || rawWindow || 'Window');
        const label = groupName ? `${groupName} · ${windowName}` : windowName;
        windows.push({
          label,
          usedPercent,
          remainingPercent,
          resetsAt: parseIsoMs(bucket.reset_time),
        });
      }
    }
  }
  const plan = formatPlanName(data?.tier_display_name || data?.plan_name || data?.plan || data?.tier || creditsReport?.command?.data?.plan_name || creditsReport?.command?.data?.tier);
  const extra = [];
  const credits = creditsReport?.command?.data?.remaining_credits ?? data?.remaining_credits;
  if (Number.isFinite(credits) && credits >= 0) {
    extra.push(`G1 credits: ${credits.toLocaleString('en-US')}`);
  }
  const note = windows.length || extra.length
    ? null
    : (typeof report?.response === 'string' && report.response.trim()) || 'Antigravity did not return usage windows.';
  return { plan, windows, extra, note };
}

function parseMuseResetMs(window) {
  if (!window || typeof window !== 'object') return null;
  const ms = window.resetsAtMs ?? window.resets_at_ms;
  if (Number.isFinite(ms) && ms > 0) return ms;
  return parseIsoMs(window.resetsAt ?? window.resets_at);
}

function normalizeMuseUsage(report) {
  const allowance = report?.allowance && typeof report.allowance === 'object' ? report.allowance : null;
  const plan = formatPlanName(allowance?.tier);
  const rawObserved = allowance ? (allowance.asOfMs ?? allowance.observedAtMs ?? allowance.observed_at_ms) : null;
  const observedAt = Number.isFinite(rawObserved) && rawObserved > 0 ? rawObserved : parseIsoMs(rawObserved);

  const windows = [];
  if (allowance) {
    const addMuseWindow = (w, fallback) => {
      if (!w || typeof w !== 'object') return;
      const used = w.usedPercent ?? w.used_percent;
      if (!Number.isFinite(used) || used < 0) return;
      const mins = w.windowDurationMins ?? w.window_duration_mins;
      const label = Number.isFinite(mins) && mins > 0 ? windowDurationLabel(mins) : fallback;
      windows.push(makeWindow(label, used, parseMuseResetMs(w)));
    };
    addMuseWindow(allowance.window, 'Window');
    addMuseWindow(allowance.weekly, 'Weekly');
  }

  if (allowance && windows.length) {
    return { available: true, plan, observedAt, windows, note: null };
  }

  const hint = typeof report?.hint === 'string' && report.hint.trim() ? report.hint.trim() : null;
  const reason = typeof report?.reason === 'string' && report.reason.trim() ? report.reason.trim() : null;
  const MUSE_REASON_NOTES = {
    no_allowance: 'Muse reported no subscription allowance for this account (this plan has no metered allowance window).',
    server_sent_no_usage: 'Muse returned no usage data yet for this subscription (often appears after the first turn in a new window).',
    api_key: 'Muse is authenticated with an API key, which has no subscription allowance.',
  };
  const note = hint || (reason && Object.hasOwn(MUSE_REASON_NOTES, reason)
    ? MUSE_REASON_NOTES[reason]
    : reason
      ? `Muse reported no allowance (${reason}).`
      : 'Muse reported no subscription allowance.');
  return { available: false, plan, observedAt, windows: [], note };
}

function providerEntry(base, fields = {}) {
  return {
    id: base.id,
    label: base.label,
    connected: base.connected,
    status: fields.status || 'unavailable',
    plan: fields.plan ?? null,
    account: fields.account ?? null,
    windows: fields.windows || [],
    extra: fields.extra || [],
    limits: fields.limits || [],
    note: fields.note ?? null,
    error: fields.error ?? null,
    cached: !!fields.cached,
    observedAt: Number.isFinite(fields.observedAt) && fields.observedAt > 0 ? fields.observedAt : null,
  };
}

function limitsFor(activeLimits, providerId) {
  const result = [];
  const prefix = providerId + ':';
  for (const [key, entry] of Object.entries(activeLimits)) {
    if ((key !== providerId && !key.startsWith(prefix)) || !entry || typeof entry !== 'object') continue;
    result.push({
      family: entry.family || null,
      reason: entry.reason,
      until: entry.until,
      known: !!entry.known,
    });
  }
  return result;
}

function matchesFilter(provider, needle) {
  const terms = [provider.id, provider.label, ...(provider.aliases || [])];
  return terms.some(term => typeof term === 'string' && term.toLowerCase().includes(needle));
}

async function queryCodex(primary, base) {
  const account = primary.account?.email || null;
  const accountType = primary.account?.type || null;
  const fallbackPlan = formatPlanName(primary.account?.plan);
  if (accountType !== 'chatgpt') {
    return providerEntry(base, {
      status: 'unavailable',
      plan: fallbackPlan,
      account,
      note: 'Plan usage windows are only reported for ChatGPT sign-in.',
    });
  }
  if (!primary.codex?.connected || typeof primary.client?.call !== 'function') {
    const cached = primary.limits?.usage?.codex;
    if (cached) {
      const norm = normalizeCodexUsage(cached);
      if (norm.windows.length || norm.extra.length) {
        return providerEntry(base, {
          status: 'ok',
          plan: norm.plan || fallbackPlan,
          account,
          windows: norm.windows,
          extra: norm.extra,
          cached: true,
          observedAt: cached.at ?? null,
        });
      }
    }
    return providerEntry(base, {
      status: 'unavailable',
      plan: fallbackPlan,
      account,
      note: 'Codex CLI is not currently connected.',
    });
  }
  try {
    const result = await primary.client.call('account/rateLimits/read', { excludeResetCreditDetails: true }, 10000);
    if ((primary.account?.type || null) !== accountType || (primary.account?.email || null) !== account) {
      return providerEntry(base, {
        status: 'error',
        plan: formatPlanName(primary.account?.plan),
        account: primary.account?.email || null,
        error: 'ChatGPT account changed during usage lookup. Refresh to retry.',
      });
    }
    if (result?.rateLimits) {
      primary.codexUsage?.(result.rateLimits);
      primary.changed?.();
    }
    const norm = normalizeCodexUsage(result);
    if (!norm.windows.length && !norm.extra.length) {
      return providerEntry(base, {
        status: 'unavailable',
        plan: norm.plan || fallbackPlan,
        account,
        note: 'Codex did not return usage windows.',
      });
    }
    return providerEntry(base, {
      status: 'ok',
      plan: norm.plan || fallbackPlan,
      account,
      windows: norm.windows,
      extra: norm.extra,
    });
  } catch (error) {
    const message = errorMessage(error);
    const cached = primary.limits?.usage?.codex;
    if (cached && (primary.account?.type || null) === accountType && (primary.account?.email || null) === account) {
      const norm = normalizeCodexUsage(cached);
      if (norm.windows.length || norm.extra.length) {
        return providerEntry(base, {
          status: 'ok',
          plan: norm.plan || fallbackPlan,
          account,
          windows: norm.windows,
          extra: norm.extra,
          cached: true,
          observedAt: cached.at ?? null,
          error: message,
        });
      }
    }
    return providerEntry(base, {
      status: 'error',
      plan: fallbackPlan,
      account,
      error: message,
    });
  }
}

async function queryClaude(primary, base) {
  const status = primary.claude?.status || {};
  const fallbackPlan = formatPlanName(status.subscriptionType);
  const account = status.email || status.authMethod || null;
  const accountKey = primary.claude?.accountKey?.() || null;
  try {
    const report = await primary.claude.readUsage();
    const currentKey = primary.claude?.accountKey?.() || null;
    if (accountKey !== currentKey) {
      const nextStatus = primary.claude?.status || {};
      return providerEntry(base, {
        status: 'error',
        plan: formatPlanName(nextStatus.subscriptionType),
        account: nextStatus.email || nextStatus.authMethod || null,
        error: 'Claude account changed during usage lookup. Refresh to retry.',
      });
    }
    if (report) {
      primary.limits?.setUsage('claude-cli', report, accountKey);
      primary.changed?.();
    }
    const norm = normalizeClaudeUsage(report);
    const plan = norm.plan || fallbackPlan;
    if (report?.rate_limits_available === false || !norm.available || (!norm.windows.length && !norm.extra.length)) {
      return providerEntry(base, {
        status: 'unavailable',
        plan,
        account,
        note: 'Plan usage windows are not available for this Claude account.',
      });
    }
    return providerEntry(base, {
      status: 'ok',
      plan,
      account,
      windows: norm.windows,
      extra: norm.extra,
    });
  } catch (error) {
    const message = errorMessage(error);
    const currentKey = primary.claude?.accountKey?.() || null;
    const cached = primary.limits?.usage?.['claude-cli'];
    const cachedEntries = accountKey && currentKey === accountKey && cached?.available && cached.windows && typeof cached.windows === 'object'
      ? Object.values(cached.windows).filter(w => w && w.account === accountKey)
      : [];
    if (cachedEntries.length) {
      const windows = cachedEntries
        .filter(w => w && Number.isFinite(w.usedPercent) && w.usedPercent >= 0)
        .map(w => makeWindow(w.label || 'Window', w.usedPercent, w.resetsAt));
      if (windows.length) {
        return providerEntry(base, {
          status: 'ok',
          plan: fallbackPlan,
          account,
          windows,
          cached: true,
          observedAt: cached.at ?? null,
          error: message,
        });
      }
    }
    return providerEntry(base, {
      status: 'error',
      plan: fallbackPlan,
      account,
      error: message,
    });
  }
}

async function queryCursor(primary, base) {
  let about = null;
  let lookupError = null;
  try { about = await primary.cursor?.readUsage?.(); }
  catch (error) { lookupError = errorMessage(error); }
  const status = primary.cursor?.status || {};
  return providerEntry(base, {
    status: lookupError ? 'error' : 'unavailable',
    plan: about?.tier || null,
    account: about?.email || status.email || status.identity || null,
    note: 'Cursor CLI only shows plan usage in its interactive terminal (/usage) or at cursor.com/dashboard?tab=usage; it has no non-interactive CLI or ACP usage API.',
    error: lookupError,
  });
}

async function queryAntigravity(antigravity, base) {
  const account = antigravity?.status?.account || null;
  try {
    const [usageResult, creditsResult] = await Promise.allSettled([
      antigravity.readUsage(),
      typeof antigravity.readCredits === 'function' ? antigravity.readCredits() : Promise.resolve(null),
    ]);
    if (usageResult.status === 'rejected') throw usageResult.reason;
    const creditsReport = creditsResult.status === 'fulfilled' ? creditsResult.value : null;
    const norm = normalizeAntigravityUsage(usageResult.value, creditsReport);
    if (!norm.windows.length && !norm.extra.length) {
      return providerEntry(base, {
        status: 'unavailable',
        plan: norm.plan,
        account,
        note: norm.note,
      });
    }
    return providerEntry(base, {
      status: 'ok',
      plan: norm.plan,
      account,
      windows: norm.windows,
      extra: norm.extra,
    });
  } catch (error) {
    return providerEntry(base, {
      status: 'error',
      account,
      error: errorMessage(error),
    });
  }
}

async function queryMuse(muse, base) {
  const account = muse?.status?.account || null;
  try {
    const report = await muse.readUsage();
    const norm = normalizeMuseUsage(report);
    if (!norm.available || !norm.windows.length) {
      return providerEntry(base, {
        status: 'unavailable',
        plan: norm.plan,
        account,
        observedAt: norm.observedAt,
        note: norm.note,
      });
    }
    return providerEntry(base, {
      status: 'ok',
      plan: norm.plan,
      account,
      windows: norm.windows,
      observedAt: norm.observedAt,
    });
  } catch (error) {
    return providerEntry(base, {
      status: 'error',
      account,
      error: errorMessage(error),
    });
  }
}

async function queryApiProvider(primary, p, base) {
  const configured = !!primary.providers?.configured?.(p.id);
  const account = configured ? 'API key saved' : 'No API key';
  let parsedUrl = null;
  try { if (typeof p.baseUrl === 'string' && p.baseUrl) parsedUrl = new URL(p.baseUrl); } catch {}
  const host = parsedUrl?.hostname?.toLowerCase() || '';
  const fetcher = primary.providers?.fetch;
  const headers = typeof primary.providers?.headers === 'function' ? () => primary.providers.headers(p.id) : null;

  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
    if (!configured || typeof fetcher !== 'function' || !headers) {
      return providerEntry(base, { status: 'unavailable', account, note: 'Save an OpenRouter API key to check key usage.' });
    }
    try {
      const endpoint = `${p.baseUrl.replace(/\/$/, '')}/key`;
      const response = await fetcher(endpoint, { headers: headers(), redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`OpenRouter usage lookup failed (HTTP ${response.status}).`);
      const body = await response.json();
      const data = body?.data;
      if (!data || typeof data !== 'object') throw new Error('OpenRouter returned an unexpected usage payload.');
      const windows = [], extra = [];
      if (Number.isFinite(data.limit) && data.limit > 0 && Number.isFinite(data.usage) && data.usage >= 0) {
        const pct = Math.max(0, (data.usage / data.limit) * 100);
        const label = typeof data.limit_reset === 'string' && data.limit_reset.trim()
          ? `Key limit (${data.limit_reset.trim()})` : 'Key limit';
        windows.push(makeWindow(label, pct, null));
        const rem = Number.isFinite(data.limit_remaining) ? ` · $${data.limit_remaining.toFixed(4)} remaining` : '';
        extra.push(`Key spend: $${data.usage.toFixed(4)} / $${data.limit.toFixed(2)}${rem}`);
      } else if (Number.isFinite(data.usage) && data.usage >= 0) {
        const parts = [`Key spend: $${data.usage.toFixed(4)}`];
        if (Number.isFinite(data.usage_daily)) parts.push(`daily $${data.usage_daily.toFixed(4)}`);
        if (Number.isFinite(data.usage_monthly)) parts.push(`monthly $${data.usage_monthly.toFixed(4)}`);
        extra.push(parts.join(' · '));
      }
      if (!windows.length && !extra.length) {
        return providerEntry(base, { status: 'unavailable', account: data.label || account, plan: data.is_free_tier ? 'Free' : null, note: 'OpenRouter did not return usage metrics for this key.' });
      }
      return providerEntry(base, { status: 'ok', account: data.label || account, plan: data.is_free_tier ? 'Free' : null, windows, extra });
    } catch (error) {
      return providerEntry(base, { status: 'error', account, error: errorMessage(error) });
    }
  }

  if (host === 'api.deepseek.com') {
    if (!configured || typeof fetcher !== 'function' || !headers) {
      return providerEntry(base, { status: 'unavailable', account, note: 'Save a DeepSeek API key to check account balance.' });
    }
    try {
      const endpoint = `${parsedUrl.origin}/user/balance`;
      const response = await fetcher(endpoint, { headers: headers(), redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`DeepSeek balance lookup failed (HTTP ${response.status}).`);
      const body = await response.json();
      const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
      const extra = infos
        .filter(info => info && typeof info.total_balance === 'string' && info.total_balance.trim())
        .map(info => `Balance: ${info.total_balance.trim()}${info.currency ? ' ' + String(info.currency).trim() : ''}`);
      const note = body?.is_available === false ? 'DeepSeek API balance is unavailable for requests.' : null;
      if (!extra.length && !note) {
        return providerEntry(base, { status: 'unavailable', account, note: 'DeepSeek did not return balance details.' });
      }
      return providerEntry(base, { status: 'ok', account, extra, note });
    } catch (error) {
      return providerEntry(base, { status: 'error', account, error: errorMessage(error) });
    }
  }

  return providerEntry(base, {
    status: 'unavailable',
    account,
    note: 'OpenAI-compatible API providers do not report account quota here.',
  });
}

async function readProviderUsage(runner, { filter = '' } = {}) {
  if (filter !== undefined && filter !== null && typeof filter !== 'string') {
    throw new Error('Usage filter must be a provider name.');
  }
  const trimmedFilter = typeof filter === 'string' ? filter.trim() : '';
  if (trimmedFilter.length > 120) {
    throw new Error('Usage filter is too long.');
  }

  const primary = runner?.controller;
  if (!primary) throw new Error('Runner controller is unavailable.');
  const settings = primary.data?.settings || {};
  const nativeCLIs = primary.nativeCLIs instanceof Map ? primary.nativeCLIs : new Map();
  const antigravity = nativeCLIs.get('native:antigravity');
  const muse = nativeCLIs.get('native:muse');
  const deepseek = nativeCLIs.get('native:deepseek');

  const catalog = [
    {
      id: 'codex',
      label: 'Codex CLI / ChatGPT',
      aliases: ['codex', 'chatgpt', 'openai'],
      connected: !!primary.account,
      query: base => queryCodex(primary, base),
    },
    {
      id: 'claude-cli',
      label: 'Claude CLI',
      aliases: ['claude', 'claude-cli', 'anthropic'],
      connected: !!settings.claudeEnabled && !!primary.claude?.status?.loggedIn,
      query: base => queryClaude(primary, base),
    },
    {
      id: 'cursor-cli',
      label: 'Cursor CLI',
      aliases: ['cursor', 'cursor-cli'],
      connected: settings.cursorEnabled !== false && !!primary.cursor?.status?.loggedIn,
      query: base => queryCursor(primary, base),
    },
    {
      id: 'native:antigravity',
      label: 'Antigravity CLI',
      aliases: ['antigravity', 'agy', 'gemini', 'native:antigravity'],
      connected: !!settings.antigravityEnabled && !!antigravity?.status?.loggedIn,
      query: base => queryAntigravity(antigravity, base),
    },
    {
      id: 'native:muse',
      label: 'Muse Code CLI',
      aliases: ['muse', 'meta', 'native:muse'],
      connected: !!settings.museEnabled && !!muse?.status?.loggedIn,
      query: base => queryMuse(muse, base),
    },
    {
      id: 'native:deepseek',
      label: 'DeepSeek Harness CLI',
      aliases: ['deepseek', 'dsh', 'native:deepseek'],
      connected: !!settings.deepseekEnabled && !!deepseek?.status?.loggedIn,
      query: async base => providerEntry(base, {
        status: 'unavailable',
        account: deepseek?.status?.account || 'API key',
        note: 'DeepSeek Harness CLI does not expose account balance over CLI or ACP. Check it in DeepSeek Harness web UI (dsh --profile web), or add DeepSeek as an API provider in Settings → Providers.',
      }),
    },
  ];

  for (const p of settings.providers || []) {
    if (!p || typeof p.id !== 'string' || !p.id) continue;
    catalog.push({
      id: p.id,
      label: p.name || p.id,
      aliases: [p.id, p.name].filter(Boolean),
      connected: p.enabled !== false,
      query: base => queryApiProvider(primary, p, base),
    });
  }

  const needle = trimmedFilter.toLowerCase();
  const selected = needle
    ? catalog.filter(provider => matchesFilter(provider, needle))
    : catalog.filter(provider => provider.connected);

  if (!selected.length) {
    return { checkedAt: Date.now(), filter: trimmedFilter || null, providers: [] };
  }

  const queried = await Promise.all(selected.map(provider => {
    const base = { id: provider.id, label: provider.label, connected: provider.connected };
    if (!provider.connected) {
      return providerEntry(base, {
        status: 'disconnected',
        note: 'Not connected. Connect it in Settings → Providers.',
      });
    }
    return provider.query(base);
  }));

  const activeLimits = primary.limits?.active?.() || {};
  const providers = queried.map(entry => ({
    ...entry,
    limits: limitsFor(activeLimits, entry.id),
  }));

  return {
    checkedAt: Date.now(),
    filter: trimmedFilter || null,
    providers,
  };
}

module.exports = {
  readProviderUsage,
  formatPlanName,
  windowDurationLabel,
  normalizeCodexUsage,
  normalizeClaudeUsage,
  normalizeAntigravityUsage,
  normalizeMuseUsage,
};
