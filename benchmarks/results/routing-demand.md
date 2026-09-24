# Conditional workspace classification: live measurement

Measured with the configured Smart classifier `gpt-5.6-terra`, low effort, using the installed Codex app-server. Both versions used the same current classifier prompts and enabled Codex worker catalog. The baseline used the saved pre-change scheduling implementation. No worker executed either task.

| Request | Before calls | After calls | Before total tokens | After total tokens | Before routing ms | After routing ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Hello! | 2 | 1 | 14,278 | 4,816 | 4,515 | 5,517 |
| Translate "good morning" into Greek. | 2 | 1 | 14,293 | 4,828 | 4,674 | 4,423 |
| Total | 4 | 2 | 28,571 | 9,644 | — | — |

**18,927 fewer reported provider tokens (66.2%)**, including input and output. The old evidence prompts included workspace context, so removing them saves more than half the tokens. Baseline totals include the discarded calls that the old UI failed to count.

One sample per request/version; order alternated. App-server startup was warmed without inference. Provider caches were uncontrolled: raw cached-token counts are in [routing-demand.json](routing-demand.json). These are token counts, not measured dollar or subscription-quota savings. Latency did not consistently improve. Workspace-dependent routing still takes two calls and can be slower because they are now sequential; that latency was not measured live here.

The JSON records timestamps, source hashes, every completed classifier's usage, selected workers, and the router's reported usage.

## Repeat a comparison

Before changing scheduling, save `src/routing/smart-router.cjs` outside the repository. After the change run:

```text
node tests/routing-cost-live.cjs <saved-before-smart-router.cjs> <results.json>
```

This deliberately makes paid calls for two fixed general requests. It requires the app's configured Codex Smart classifier and enabled Codex workers. It uses temporary isolated classifier threads, never modifies sessions, and does not execute workers. The source snapshot must remain compatible with the current classifier API.

Offline regression checks:

```text
node --test tests/routing-calls.test.cjs
node --test tests/*.test.cjs
```

Validated: one call and no workspace scan for general messages; two ordered calls with both usages counted for workspace requests; cancellation during scanning prevents the second call. Full Windows suite: 74 passed.
