const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { AntigravityCLI } = require('../src/providers/antigravity.cjs');
const { MuseCLI } = require('../src/providers/muse.cjs');
const { CursorCLI, parseAbout } = require('../src/providers/cursor.cjs');
const { ProviderLimits } = require('../src/providers/limits.cjs');
const { registerRunnerCommands } = require('../src/runner-commands.cjs');
const { REMOTE_METHODS } = require('../src/remote.cjs');
const {
  readProviderUsage,
  formatPlanName,
  windowDurationLabel,
  normalizeCodexUsage,
  normalizeClaudeUsage,
  normalizeAntigravityUsage,
  normalizeMuseUsage,
} = require('../src/provider-usage.cjs');

function mockChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killedCount = 0;
  child.kill = () => {
    child.killedCount++;
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.stdin.end();
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0);
    child.emit('close', 0);
  };
  return child;
}

test('AntigravityCLI.readUsage parses groups/buckets, isolates usageHosts from hosts, strips ELECTRON_RUN_AS_NODE, and rejects invalid output', async () => {
  const savedElectron = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const launches = [];
    let holdClose = null;
    const payload = {
      status: 'SUCCESS',
      command: {
        name: '/usage',
        data: {
          groups: [
            {
              name: 'Gemini Pro',
              buckets: [
                { window: '5h', remaining_fraction: 0.75, reset_time: '2026-11-23T06:00:00Z' },
                { window: 'weekly', remaining_fraction: 0.4, reset_time: '2026-11-30T00:00:00Z' },
              ],
            },
          ],
        },
      },
    };
    const cli = new AntigravityCLI((cmd, args, options) => {
      const child = mockChild();
      launches.push({ cmd, args, options, child });
      holdClose = () => {
        child.stdout.write(JSON.stringify(payload) + '\n');
        child.exitCode = 0;
        child.emit('close', 0);
      };
      return child;
    }, () => ({ command: 'agy-bin', args: ['--flag'] }));

    const pending = cli.readUsage();
    assert.equal(cli.hosts.size, 0, 'readUsage must not touch this.hosts');
    assert.equal(cli.usageHosts.size, 1, 'readUsage tracks in-flight child in usageHosts');
    assert.deepEqual(launches[0].args, ['--flag', '-p', '/usage', '--output-format', 'json']);
    assert.equal(launches[0].options.cwd, os.tmpdir());
    assert.equal(launches[0].options.windowsHide, true);
    assert.equal(launches[0].options.env.NO_BROWSER, 'true');
    assert.equal(Object.hasOwn(launches[0].options.env, 'ELECTRON_RUN_AS_NODE'), false);

    holdClose();
    const result = await pending;
    assert.deepEqual(result, payload);
    assert.equal(cli.hosts.size, 0);
    assert.equal(cli.usageHosts.size, 0);
    assert.equal(launches[0].child.exitCode, 0);

    // readCredits() runs /credits --output-format json isolated from hosts
    const creditsPayload = { status: 'SUCCESS', command: { name: 'credits', data: { remaining_credits: 250 } } };
    const creditsCli = new AntigravityCLI((cmd, args) => {
      launches.push({ cmd, args });
      const child = mockChild();
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify(creditsPayload) + '\n');
        child.exitCode = 0;
        child.emit('close', 0);
      });
      return child;
    }, () => ({ command: 'agy-bin', args: [] }));
    assert.deepEqual(await creditsCli.readCredits(), creditsPayload);
    assert.deepEqual(launches.at(-1).args, ['-p', '/credits', '--output-format', 'json']);
    assert.equal(creditsCli.hosts.size, 0);
    assert.equal(creditsCli.usageHosts.size, 0);

    // close() cleans up in-flight usageHosts too
    const stuckCli = new AntigravityCLI(() => mockChild(), () => ({ command: 'agy-bin', args: [] }));
    const stuckPromise = stuckCli.readUsage();
    assert.equal(stuckCli.usageHosts.size, 1);
    assert.equal(stuckCli.hosts.size, 0);
    await stuckCli.close();
    assert.equal(stuckCli.usageHosts.size, 0);
    await assert.rejects(stuckPromise);

    // Rejects bad status, non-zero exit, invalid JSON
    const failCase = (stdout, code = 0, stderr = '') => new AntigravityCLI(() => {
      const child = mockChild();
      queueMicrotask(() => {
        if (stderr) child.stderr.write(stderr);
        if (stdout) child.stdout.write(stdout);
        child.exitCode = code;
        child.emit('close', code);
      });
      return child;
    }, () => ({ command: 'agy-bin', args: [] }));

    await assert.rejects(failCase(JSON.stringify({ status: 'ERROR', error: 'Not signed in' })).readUsage(), /Not signed in/);
    await assert.rejects(failCase('not-json').readUsage(), /invalid usage JSON/i);
    await assert.rejects(failCase('', 1, 'auth failed').readUsage(), /exit 1.*auth failed/i);
  } finally {
    if (savedElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = savedElectron;
  }
});

test('MuseCLI.readUsage runs usage --json, handles allowance and no_allowance, isolates usageChildren, and rejects errors', async () => {
  const launches = [];
  let release = null;
  const allowancePayload = {
    allowance: {
      tier: 'pro',
      observedAtMs: 1700000000000,
      window: { usedPercent: 35, windowDurationMins: 300, resetsAtMs: 1700018000000 },
      weekly: { usedPercent: 12, resetsAtMs: 1700600000000 },
    },
  };
  const cli = new MuseCLI((cmd, args, options) => {
    const child = mockChild();
    launches.push({ cmd, args, options, child });
    release = () => {
      child.stdout.write(JSON.stringify(allowancePayload));
      child.exitCode = 0;
      child.emit('close', 0);
    };
    return child;
  }, () => ({ command: 'muse-bin', args: ['--profile', 'test'] }));

  const pending = cli.readUsage();
  assert.equal(cli.hosts.size, 0, 'readUsage must not touch this.hosts');
  assert.equal(cli.usageChildren.size, 1);
  assert.deepEqual(launches[0].args, ['--profile', 'test', 'usage', '--json']);
  assert.equal(launches[0].options.cwd, os.tmpdir());
  assert.equal(launches[0].options.windowsHide, true);
  assert.deepEqual(launches[0].options.stdio, ['ignore', 'pipe', 'pipe']);

  release();
  assert.deepEqual(await pending, allowancePayload);
  assert.equal(cli.usageChildren.size, 0);

  // no_allowance payload succeeds cleanly
  const noAllowance = { allowance: null, reason: 'no_allowance' };
  const cliNone = new MuseCLI(() => {
    const child = mockChild();
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify(noAllowance));
      child.exitCode = 0;
      child.emit('close', 0);
    });
    return child;
  }, () => ({ command: 'muse-bin', args: [] }));
  assert.deepEqual(await cliNone.readUsage(), noAllowance);

  // close() terminates in-flight usageChildren
  const hanging = new MuseCLI(() => mockChild(), () => ({ command: 'muse-bin', args: [] }));
  const hangingRead = hanging.readUsage();
  assert.equal(hanging.usageChildren.size, 1);
  await hanging.close();
  assert.equal(hanging.usageChildren.size, 0);
  await assert.rejects(hangingRead);

  // Rejects non-zero exit, invalid JSON, and oversized > 1 MB
  const failCase = (stdout, code = 0, stderr = '') => new MuseCLI(() => {
    const child = mockChild();
    queueMicrotask(() => {
      if (stderr) child.stderr.write(stderr);
      if (stdout) child.stdout.write(stdout);
      child.exitCode = code;
      child.emit('close', code);
    });
    return child;
  }, () => ({ command: 'muse-bin', args: [] }));

  await assert.rejects(failCase('', 2, 'bad auth').readUsage(), /exit 2.*bad auth/i);
  await assert.rejects(failCase('{bad').readUsage(), /invalid usage JSON/i);
  await assert.rejects(failCase('x'.repeat(1024 * 1024 + 10)).readUsage(), /too large/i);
});

test('CursorCLI.parseAbout and readUsage parse ANSI-styled about output', async () => {
  const sample = [
    '\x1b[1mCursor Agent CLI\x1b[0m',
    '  \x1b[36mCLI Version\x1b[0m         2026.11.10-abcdef',
    '  \x1b[36mUser Email\x1b[0m          dev@example.com',
    '  \x1b[36mSubscription Tier\x1b[0m   Premium',
  ].join('\n');
  assert.deepEqual(parseAbout(sample), {
    tier: 'Premium',
    email: 'dev@example.com',
    version: '2026.11.10-abcdef',
  });
  assert.deepEqual(parseAbout('Subscription Tier: Pro Plus\n'), {
    tier: 'Pro Plus',
    email: null,
    version: null,
  });
  assert.deepEqual(parseAbout(''), { tier: null, email: null, version: null });

  const calls = [];
  const cli = new CursorCLI((args) => {
    calls.push(args);
    const child = mockChild();
    queueMicrotask(() => {
      child.stdout.write(sample);
      child.exitCode = 0;
      child.emit('close', 0);
    });
    return child;
  });
  assert.deepEqual(await cli.readUsage(), {
    tier: 'Premium',
    email: 'dev@example.com',
    version: '2026.11.10-abcdef',
  });
  assert.deepEqual(calls, [['about']]);
});

test('formatPlanName and windowDurationLabel format standard and custom values', () => {
  assert.equal(formatPlanName('plus'), 'Plus');
  assert.equal(formatPlanName('pro'), 'Pro');
  assert.equal(formatPlanName('max_20x'), 'Max 20x');
  assert.equal(formatPlanName('chatgpt_plus'), 'ChatGPT Plus');
  assert.equal(formatPlanName(''), null);
  assert.equal(formatPlanName(null), null);

  assert.equal(windowDurationLabel(300), '5-hour');
  assert.equal(windowDurationLabel(1440), 'Daily');
  assert.equal(windowDurationLabel(10080), 'Weekly');
  assert.equal(windowDurationLabel(120), '2-hour');
  assert.equal(windowDurationLabel(45), '45-min');
  assert.equal(windowDurationLabel(0), 'Window');
});

test('normalizers handle Codex, Claude, Antigravity, and Muse payloads accurately', () => {
  // Codex with primary/secondary, credits, and extra buckets
  const codex = normalizeCodexUsage({
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1700000000 },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1700500000 },
      credits: { hasCredits: true, unlimited: false, balance: '$12.50' },
    },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1700000000 } },
      spark: { limitId: 'spark', limitName: 'Codex Spark', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1700002000 } },
    },
  });
  assert.equal(codex.plan, 'Pro');
  assert.deepEqual(codex.windows, [
    { label: '5-hour', usedPercent: 25, remainingPercent: 75, resetsAt: 1700000000000 },
    { label: 'Weekly', usedPercent: 10, remainingPercent: 90, resetsAt: 1700500000000 },
    { label: 'Codex Spark · 5-hour', usedPercent: 40, remainingPercent: 60, resetsAt: 1700002000000 },
  ]);
  assert.deepEqual(codex.extra, ['Credits balance: $12.50']);

  assert.deepEqual(normalizeCodexUsage({ credits: { unlimited: true } }).extra, ['Unlimited credits']);
  assert.deepEqual(normalizeCodexUsage({ credits: { hasCredits: true } }).extra, ['Credits available']);

  // Claude with standard windows, model_scoped, and extra_usage
  const claude = normalizeClaudeUsage({
    rate_limits_available: true,
    subscription_type: 'max',
    rate_limits: {
      five_hour: { utilization: 20, resets_at: '2026-11-23T05:00:00Z' },
      seven_day: { utilization: 45, resets_at: '2026-11-29T00:00:00Z' },
      seven_day_oauth_apps: { utilization: 5, resets_at: null },
      seven_day_opus: { utilization: 70, resets_at: '2026-11-29T00:00:00Z' },
      seven_day_sonnet: { utilization: 15, resets_at: '2026-11-29T00:00:00Z' },
      model_scoped: [
        { display_name: 'Fable', utilization: 95, resets_at: '2026-11-29T00:00:00Z' },
        { display_name: '   ', utilization: 10 },
      ],
      extra_usage: { is_enabled: true, utilization: 12, used_credits: 550, monthly_limit: 5000 },
    },
  });
  assert.equal(claude.available, true);
  assert.equal(claude.plan, 'Max');
  assert.deepEqual(claude.windows.map(w => [w.label, w.usedPercent, w.remainingPercent]), [
    ['5-hour', 20, 80],
    ['Weekly', 45, 55],
    ['CLI/SDK weekly', 5, 95],
    ['Opus weekly', 70, 30],
    ['Sonnet weekly', 15, 85],
    ['Fable weekly', 95, 5],
  ]);
  assert.equal(claude.windows[0].resetsAt, Date.parse('2026-11-23T05:00:00Z'));
  assert.equal(claude.windows[2].resetsAt, null);
  assert.match(claude.extra[0], /Extra usage enabled.*12% used.*\$5\.50 \/ \$50\.00/);
  const claudeEur = normalizeClaudeUsage({
    rate_limits_available: true,
    rate_limits: { extra_usage: { is_enabled: true, used_credits: 1250, currency: 'EUR', decimal_places: 2 } },
  });
  assert.match(claudeEur.extra[0], /12\.50 EUR spent/);

  // Antigravity
  const agy = normalizeAntigravityUsage({
    status: 'SUCCESS',
    command: {
      data: {
        groups: [
          {
            name: 'Gemini',
            buckets: [
              { window: '5h', remaining_fraction: 0.82, reset_time: '2026-11-23T06:00:00Z' },
              { window: 'weekly', remaining_fraction: 0.25, reset_time: '2026-11-30T00:00:00Z' },
            ],
          },
        ],
      },
    },
  });
  assert.deepEqual(agy.windows, [
    { label: 'Gemini · 5-hour', usedPercent: 18, remainingPercent: 82, resetsAt: Date.parse('2026-11-23T06:00:00Z') },
    { label: 'Gemini · Weekly', usedPercent: 75, remainingPercent: 25, resetsAt: Date.parse('2026-11-30T00:00:00Z') },
  ]);
  assert.deepEqual(agy.extra, []);
  const agyWithCredits = normalizeAntigravityUsage(
    { status: 'SUCCESS', command: { data: { plan_name: 'google_ai_pro', groups: [{ name: 'Gemini', buckets: [{ window: '5h', remaining_fraction: 0.9 }] }] } } },
    { status: 'SUCCESS', command: { data: { remaining_credits: 1250 } } },
  );
  assert.equal(agyWithCredits.plan, 'Google AI Pro');
  assert.deepEqual(agyWithCredits.extra, ['G1 credits: 1,250']);
  assert.deepEqual(
    normalizeAntigravityUsage({ status: 'SUCCESS', command: { data: { groups: [] } } }, { status: 'SUCCESS', command: { data: { remaining_credits: 0 } } }).extra,
    ['G1 credits: 0'],
  );
  assert.equal(normalizeAntigravityUsage({ status: 'SUCCESS', response: 'Quota ready' }).note, 'Quota ready');

  // Muse (snake_case & no_allowance)
  const museSnake = normalizeMuseUsage({
    allowance: {
      tier: 'pro_plus',
      observed_at_ms: 1700000123000,
      window: { used_percent: 42, window_duration_mins: 300, resets_at: '2026-11-23T06:00:00Z' },
      weekly: { used_percent: 18, resets_at_ms: 1700600000000 },
    },
  });
  assert.equal(museSnake.available, true);
  assert.equal(museSnake.plan, 'Pro Plus');
  assert.equal(museSnake.observedAt, 1700000123000);
  assert.deepEqual(museSnake.windows, [
    { label: '5-hour', usedPercent: 42, remainingPercent: 58, resetsAt: Date.parse('2026-11-23T06:00:00Z') },
    { label: 'Weekly', usedPercent: 18, remainingPercent: 82, resetsAt: 1700600000000 },
  ]);
  const museAsOf = normalizeMuseUsage({
    schemaVersion: 1,
    allowance: { tier: 'pro', asOfMs: 1700000999000, source: 'mint', window: { usedPercent: 12, resetsAtMs: 1700018000000 } },
  });
  assert.equal(museAsOf.observedAt, 1700000999000);
  const museEmpty = normalizeMuseUsage({ allowance: null, reason: 'no_allowance' });
  assert.equal(museEmpty.available, false);
  assert.match(museEmpty.note, /no subscription allowance.*no metered allowance/i);
  assert.match(normalizeMuseUsage({ allowance: null, reason: 'server_sent_no_usage' }).note, /first turn in a new window/i);
  assert.match(normalizeMuseUsage({ allowance: null, reason: 'api_key' }).note, /API key.*no subscription allowance/i);
});

function makeRunnerFixture(overrides = {}) {
  const limits = new ProviderLimits({}, () => 1700000000000);
  const events = { changed: 0, codexUsage: [] };
  const primary = {
    account: { type: 'chatgpt', plan: 'plus', email: 'user@chatgpt.example' },
    codex: { connected: true },
    client: {
      call: async (method, params) => {
        assert.equal(method, 'account/rateLimits/read');
        assert.deepEqual(params, { excludeResetCreditDetails: true });
        return {
          rateLimits: {
            limitId: 'codex',
            planType: 'plus',
            primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1700010000 },
            secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1700500000 },
            credits: { hasCredits: true, balance: '4.25' },
          },
          rateLimitsByLimitId: {
            codex: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1700010000 } },
            o3: { limitId: 'o3', limitName: 'o3', primary: { usedPercent: 80, windowDurationMins: 1440, resetsAt: 1700080000 } },
          },
        };
      },
    },
    codexUsage(snapshot) {
      events.codexUsage.push(snapshot);
      limits.setUsage('codex', snapshot);
    },
    changed() { events.changed++; },
    claude: {
      status: { loggedIn: true, email: 'user@claude.example', subscriptionType: 'max', authMethod: 'claude.ai' },
      accountKey: () => 'claude-acct-hash',
      readUsage: async () => ({
        rate_limits_available: true,
        subscription_type: 'max',
        rate_limits: {
          five_hour: { utilization: 10, resets_at: '2026-11-23T05:00:00Z' },
          seven_day: { utilization: 65, resets_at: '2026-11-29T00:00:00Z' },
        },
      }),
    },
    cursor: {
      status: { loggedIn: true, email: 'user@cursor.example', identity: 'user@cursor.example' },
      readUsage: async () => ({ tier: 'Pro', email: 'user@cursor.example', version: '2026.11.10' }),
    },
    nativeCLIs: new Map([
      ['native:antigravity', {
        status: { installed: true, loggedIn: true, account: 'user@gmail.com' },
        readUsage: async () => ({
          status: 'SUCCESS',
          command: {
            data: {
              groups: [{ name: 'Gemini', buckets: [{ window: '5h', remaining_fraction: 0.6, reset_time: '2026-11-23T06:00:00Z' }] }],
            },
          },
        }),
        readCredits: async () => ({
          status: 'SUCCESS',
          command: { name: 'credits', data: { remaining_credits: 420 } },
        }),
      }],
      ['native:muse', {
        status: { installed: true, loggedIn: true, account: 'user@meta.example' },
        readUsage: async () => ({
          allowance: {
            tier: 'standard',
            observedAtMs: 1700000000500,
            window: { usedPercent: 22, windowDurationMins: 300, resetsAtMs: 1700018000000 },
          },
        }),
      }],
      ['native:deepseek', {
        status: { installed: true, loggedIn: true, account: null },
      }],
    ]),
    providers: {
      configured: id => id === 'openrouter',
    },
    limits,
    data: {
      settings: {
        claudeEnabled: true,
        cursorEnabled: true,
        antigravityEnabled: true,
        museEnabled: true,
        deepseekEnabled: true,
        providers: [
          { id: 'openrouter', name: 'OpenRouter', enabled: true },
          { id: 'disabled-api', name: 'Disabled API', enabled: false },
        ],
      },
    },
    ...overrides,
  };
  return { runner: { controller: primary }, primary, limits, events };
}

test('readProviderUsage queries all connected providers in parallel and surfaces active limits', async () => {
  const { runner, primary, limits, events } = makeRunnerFixture();
  // Verify parallel dispatch: codex & claude both start before either resolves
  const started = [];
  let releaseCodex, releaseClaude;
  const origCodex = primary.client.call;
  const origClaude = primary.claude.readUsage;
  primary.client.call = (...args) => {
    started.push('codex');
    return new Promise(resolve => { releaseCodex = () => resolve(origCodex(...args)); });
  };
  primary.claude.readUsage = () => {
    started.push('claude');
    return new Promise(resolve => { releaseClaude = () => resolve(origClaude()); });
  };

  // Mark active provider-wide and model-scoped limits
  limits.mark('claude-cli', { until: 1700050000000, reason: 'Claude Opus weekly full.', family: 'opus' });
  limits.mark('cursor-cli', { until: null, reason: 'Cursor: Upgrade your plan to continue.' });

  const pending = readProviderUsage(runner);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.sort(), ['claude', 'codex'], 'providers are queried in parallel');
  releaseCodex();
  releaseClaude();

  const report = await pending;
  assert.equal(report.filter, null);
  assert.equal(typeof report.checkedAt, 'number');
  assert.deepEqual(report.providers.map(p => p.id), [
    'codex', 'claude-cli', 'cursor-cli', 'native:antigravity', 'native:muse', 'native:deepseek', 'openrouter',
  ]);

  const byId = Object.fromEntries(report.providers.map(p => [p.id, p]));
  assert.equal(byId.codex.status, 'ok');
  assert.equal(byId.codex.plan, 'Plus');
  assert.equal(byId.codex.account, 'user@chatgpt.example');
  assert.equal(byId.codex.windows.length, 3);
  assert.equal(byId.codex.windows[2].label, 'o3 · Daily');
  assert.deepEqual(byId.codex.extra, ['Credits balance: 4.25']);
  assert.equal(events.codexUsage.length, 1);

  assert.equal(byId['claude-cli'].status, 'ok');
  assert.equal(byId['claude-cli'].plan, 'Max');
  assert.equal(byId['claude-cli'].windows.length, 2);
  assert.deepEqual(byId['claude-cli'].limits, [
    { family: 'opus', reason: 'Claude Opus weekly full.', until: 1700050000000, known: true },
  ]);
  assert.ok(events.changed >= 2);

  assert.equal(byId['cursor-cli'].status, 'unavailable');
  assert.equal(byId['cursor-cli'].plan, 'Pro');
  assert.equal(byId['cursor-cli'].account, 'user@cursor.example');
  assert.equal(byId['cursor-cli'].limits.length, 1);
  assert.equal(byId['cursor-cli'].limits[0].known, false);

  assert.equal(byId['native:antigravity'].status, 'ok');
  assert.equal(byId['native:antigravity'].account, 'user@gmail.com');
  assert.deepEqual(byId['native:antigravity'].windows[0], {
    label: 'Gemini · 5-hour',
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: Date.parse('2026-11-23T06:00:00Z'),
  });
  assert.deepEqual(byId['native:antigravity'].extra, ['G1 credits: 420']);

  // A failing /credits lookup must not break Antigravity's /usage windows
  primary.nativeCLIs.get('native:antigravity').readCredits = async () => { throw new Error('credits offline'); };
  const agyOnly = await readProviderUsage(runner, { filter: 'antigravity' });
  assert.equal(agyOnly.providers[0].status, 'ok');
  assert.equal(agyOnly.providers[0].windows.length, 1);
  assert.deepEqual(agyOnly.providers[0].extra, []);

  assert.equal(byId['native:muse'].status, 'ok');
  assert.equal(byId['native:muse'].plan, 'Standard');
  assert.equal(byId['native:muse'].observedAt, 1700000000500);

  assert.equal(byId['native:deepseek'].status, 'unavailable');
  assert.equal(byId['native:deepseek'].account, 'API key');

  assert.equal(byId.openrouter.status, 'unavailable');
  assert.equal(byId.openrouter.account, 'API key saved');
});

test('readProviderUsage handles error fallbacks, unavailable accounts, and provider errors', async () => {
  const { runner, primary, limits } = makeRunnerFixture();

  // Seed cache for codex and claude-cli, then make live reads fail
  limits.setUsage('codex', {
    limitId: 'codex',
    planType: 'pro',
    primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1700010000 },
  });
  limits.setUsage('claude-cli', {
    rate_limits_available: true,
    rate_limits: { seven_day: { utilization: 80, resets_at: '2026-11-29T00:00:00Z' } },
  }, 'claude-acct-hash');

  primary.client.call = async () => { throw new Error('RPC offline'); };
  primary.claude.readUsage = async () => { throw new Error('Claude timeout'); };
  primary.cursor.readUsage = async () => { throw new Error('about failed'); };
  primary.nativeCLIs.get('native:antigravity').readUsage = async () => { throw new Error('agy broken'); };
  primary.nativeCLIs.get('native:muse').readUsage = async () => ({ allowance: null, reason: 'no_allowance' });

  const report = await readProviderUsage(runner);
  const byId = Object.fromEntries(report.providers.map(p => [p.id, p]));

  assert.equal(byId.codex.status, 'ok');
  assert.equal(byId.codex.cached, true);
  assert.equal(byId.codex.observedAt, 1700000000000);
  assert.equal(byId.codex.error, 'RPC offline');
  assert.equal(byId.codex.windows[0].usedPercent, 55);

  assert.equal(byId['claude-cli'].status, 'ok');
  assert.equal(byId['claude-cli'].cached, true);
  assert.equal(byId['claude-cli'].observedAt, 1700000000000);
  assert.equal(byId['claude-cli'].error, 'Claude timeout');
  assert.equal(byId['claude-cli'].windows[0].usedPercent, 80);

  assert.equal(byId['cursor-cli'].status, 'error');
  assert.equal(byId['cursor-cli'].error, 'about failed');
  assert.equal(byId['cursor-cli'].plan, null);
  assert.equal(byId['cursor-cli'].account, 'user@cursor.example');
  assert.match(byId['cursor-cli'].note, /interactive terminal \(\/usage\).*cursor\.com\/dashboard\?tab=usage/i);

  assert.equal(byId['native:antigravity'].status, 'error');
  assert.equal(byId['native:antigravity'].error, 'agy broken');

  assert.equal(byId['native:muse'].status, 'unavailable');
  assert.match(byId['native:muse'].note, /no subscription allowance/i);
  assert.match(byId['native:deepseek'].note, /dsh --profile web.*Settings → Providers/i);

  // Without cached data, errors report status: 'error'; non-ChatGPT Codex and Claude unavailable report status: 'unavailable'
  const fresh = makeRunnerFixture();
  fresh.primary.account = { type: 'apiKey', email: null };
  fresh.primary.claude.readUsage = async () => ({ rate_limits_available: false, subscription_type: 'free', rate_limits: null });
  const r2 = await readProviderUsage(fresh.runner, { filter: 'codex' });
  assert.equal(r2.providers[0].status, 'unavailable');
  assert.match(r2.providers[0].note, /ChatGPT sign-in/);
  const r3 = await readProviderUsage(fresh.runner, { filter: 'claude' });
  assert.equal(r3.providers[0].status, 'unavailable');
  assert.match(r3.providers[0].note, /not available for this Claude account/);

  // Claude error without cache -> status: 'error'
  fresh.primary.claude.readUsage = async () => { throw new Error('hard failure'); };
  const r4 = await readProviderUsage(fresh.runner, { filter: 'claude' });
  assert.equal(r4.providers[0].status, 'error');
  assert.equal(r4.providers[0].error, 'hard failure');
});

test('readProviderUsage isolates Claude account switches and cache fallback by account key', async () => {
  const { runner, primary, limits } = makeRunnerFixture();
  // Seed cache for old account A
  limits.setUsage('claude-cli', {
    rate_limits_available: true,
    rate_limits: { seven_day: { utilization: 91, resets_at: '2026-11-29T00:00:00Z' } },
  }, 'acct-old');

  // Switch active account to B before lookup; timeout must NOT show account A's 91%
  primary.claude.accountKey = () => 'acct-new';
  primary.claude.status = { loggedIn: true, email: 'new@claude.example', subscriptionType: 'max' };
  primary.claude.readUsage = async () => { throw new Error('timeout'); };
  const afterSwitchFail = await readProviderUsage(runner, { filter: 'claude' });
  assert.equal(afterSwitchFail.providers[0].status, 'error');
  assert.equal(afterSwitchFail.providers[0].cached, false);
  assert.deepEqual(afterSwitchFail.providers[0].windows, []);
  assert.equal(afterSwitchFail.providers[0].account, 'new@claude.example');

  // Account changes mid-lookup: result must be discarded and not saved under the new account
  let currentKey = 'acct-A';
  primary.claude.accountKey = () => currentKey;
  primary.claude.status = { loggedIn: true, email: 'a@claude.example', subscriptionType: 'max' };
  primary.claude.readUsage = async () => {
    currentKey = 'acct-B';
    primary.claude.status = { loggedIn: true, email: 'b@claude.example', subscriptionType: 'pro' };
    return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 99, resets_at: '2026-11-23T06:00:00Z' } } };
  };
  const midSwitch = await readProviderUsage(runner, { filter: 'claude' });
  assert.equal(midSwitch.providers[0].status, 'error');
  assert.match(midSwitch.providers[0].error, /account changed/i);
  assert.deepEqual(midSwitch.providers[0].windows, []);
  assert.equal(limits.quotas['claude-cli']?.five_hour, undefined, 'stale report must not be saved under the new account');
});

test('readProviderUsage queries documented OpenRouter and DeepSeek API endpoints when configured', async () => {
  const { runner, primary } = makeRunnerFixture();
  const requests = [];
  primary.data.settings.providers = [
    { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true },
    { id: 'deepseek-api', name: 'DeepSeek API', baseUrl: 'https://api.deepseek.com/v1', enabled: true },
    { id: 'local-llm', name: 'Local LLM', baseUrl: 'http://localhost:1234/v1', enabled: true },
  ];
  primary.providers = {
    configured: id => ['openrouter', 'deepseek-api'].includes(id),
    headers: id => ({ Authorization: `Bearer key-${id}` }),
    fetch: async (url, opts) => {
      requests.push({ url, auth: opts.headers.Authorization });
      if (url === 'https://openrouter.ai/api/v1/key') {
        return new Response(JSON.stringify({
          data: { label: 'sk-or-prod', usage: 2.5, limit: 10, limit_remaining: 7.5, limit_reset: 'monthly', is_free_tier: false },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://api.deepseek.com/user/balance') {
        return new Response(JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '14.25' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    },
  };

  const orRes = await readProviderUsage(runner, { filter: 'openrouter' });
  assert.equal(orRes.providers[0].status, 'ok');
  assert.equal(orRes.providers[0].account, 'sk-or-prod');
  assert.deepEqual(orRes.providers[0].windows, [{ label: 'Key limit (monthly)', usedPercent: 25, remainingPercent: 75, resetsAt: null }]);
  assert.match(orRes.providers[0].extra[0], /\$2\.5000 \/ \$10\.00.*\$7\.5000 remaining/);

  const dsRes = await readProviderUsage(runner, { filter: 'DeepSeek API' });
  assert.equal(dsRes.providers[0].status, 'ok');
  assert.deepEqual(dsRes.providers[0].extra, ['Balance: 14.25 USD']);

  const localRes = await readProviderUsage(runner, { filter: 'local-llm' });
  assert.equal(localRes.providers[0].status, 'unavailable');
  assert.match(localRes.providers[0].note, /OpenAI-compatible API providers do not report account quota/);
  assert.equal(requests.length, 2);

  // HTTP error on OpenRouter reports status: 'error'
  primary.providers.fetch = async () => new Response('unauthorized', { status: 401 });
  const errRes = await readProviderUsage(runner, { filter: 'openrouter' });
  assert.equal(errRes.providers[0].status, 'error');
  assert.match(errRes.providers[0].error, /HTTP 401/);
});

test('readProviderUsage filter matches connected, disconnected, unknown, and validates bad filters', async () => {
  const { runner, primary } = makeRunnerFixture();
  primary.data.settings.museEnabled = false;

  const connectedMatch = await readProviderUsage(runner, { filter: '  AGY ' });
  assert.equal(connectedMatch.filter, 'AGY');
  assert.deepEqual(connectedMatch.providers.map(p => [p.id, p.status]), [['native:antigravity', 'ok']]);

  const disconnectedMatch = await readProviderUsage(runner, { filter: 'muse' });
  assert.equal(disconnectedMatch.providers.length, 1);
  assert.equal(disconnectedMatch.providers[0].id, 'native:muse');
  assert.equal(disconnectedMatch.providers[0].connected, false);
  assert.equal(disconnectedMatch.providers[0].status, 'disconnected');
  assert.match(disconnectedMatch.providers[0].note, /Not connected/);

  const disabledApi = await readProviderUsage(runner, { filter: 'Disabled API' });
  assert.equal(disabledApi.providers.length, 1);
  assert.equal(disabledApi.providers[0].status, 'disconnected');

  const unknown = await readProviderUsage(runner, { filter: 'nonexistent-provider' });
  assert.equal(unknown.filter, 'nonexistent-provider');
  assert.deepEqual(unknown.providers, []);

  await assert.rejects(readProviderUsage(runner, { filter: 42 }), /must be a provider name/);
  await assert.rejects(readProviderUsage(runner, { filter: 'a'.repeat(121) }), /too long/);
});

test('providerUsage is registered in runner-commands, allowed on sub-bots, and wired in preload/remote', async () => {
  const { runner } = makeRunnerFixture();
  const commands = new Map();
  const agents = {
    closing: false,
    owner: () => ({ agentId: 'sub' }),
    profile: () => ({ id: 'sub', createdBy: 'lead' }),
    isSubBot: profile => profile?.createdBy === 'lead',
  };
  registerRunnerCommands((name, handler) => commands.set(name, handler), {
    runner: { ...runner, agents, updater: { state: { status: 'idle' } } },
  });

  assert.equal(commands.has('providerUsage'), true);
  assert.equal(REMOTE_METHODS.has('providerUsage'), true);

  // Works even when invoked without filter (and is not blocked by sub-bot chatMutations)
  const result = await commands.get('providerUsage')('chatgpt');
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].id, 'codex');

  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.cjs'), 'utf8');
  const remoteApi = fs.readFileSync(path.join(__dirname, '..', 'ui', 'remote-api.js'), 'utf8');
  assert.match(preload, /'providerUsage'/);
  assert.match(remoteApi, /'providerUsage'/);
});
