# Live routing decision comparison

2026-09-24T10:23:38.476Z

Eight requests, four classifiers, 21 enabled and available workers from the actual Providers settings. GPT classifiers used low effort: GPT-6 Luna, GPT-5.6 Terra, GPT-6 Sol. Jev used 1.13.0. Direct answers were disabled so every case tests routing. No worker tasks ran, and no user sessions were changed.

| Router | First-pass usable routes | Expected kind + workspace checks | Median elapsed | Mean tokens per successful route |
|---|---:|---:|---:|---:|
| jev | 8/8 | 7/8 | 1.74 s | 22,372 |
| luna | 7/8 | 7/8 | 10.22 s | 13,025 |
| terra | 6/8 | 6/8 | 11.13 s | 11,632 |
| sol | 8/8 | 8/8 | 10.88 s | 13,402 |

## Worker selections (first pass)

| Request | Jev | Luna | Terra | Sol |
|---|---|---|---|---|
| greeting | astra · low | luna · low | luna · low | luna · low |
| translation | astra · low | luna · low | luna · low | luna · low |
| lookup | sol · medium | Rejected response | astra · low | sol · medium |
| mechanical | sol · low | luna · low | luna · medium | luna · high |
| review | astra · medium | astra · high | astra · xhigh | astra · high |
| debugging | astra · medium | astra · xhigh | Rejected response | astra · high |
| architecture | astra · medium | astra · high | Rejected response | astra · xhigh |
| followup | astra · medium | astra · high | astra · xhigh | astra · high |

## Interpretation

- Sol returned usable decisions on all eight first attempts and matched the expected task kind/workspace checks. This does not establish optimal worker selection or best overall router.
- Jev was fastest in this sample, but selected Astra low even for a greeting and translation. Its architecture answer classified the task correctly but said workspace context was unnecessary, contrary to the declared expectation for a project-specific design. That expectation is a review rubric, not an objective benchmark label.
- Luna and Terra correctly classified all their successful cases, but failed validation on one and two cases respectively. On one diagnostic retry each, Luna lookup and Terra debugging passed; Terra architecture failed again. The recorded reason was 256 characters; validation allows 240, while the Codex output schema does not enforce maxLength for reason. Do not treat all rejected responses as bad model choices: a format mismatch can reject otherwise usable decisions. The original two failures cannot be conclusively attributed to the same cause because their raw decisions were not captured.
- Lookup choices were expensive: Astra low / Sol medium on first pass; Luna chose Astra medium on retry. Mechanical edits received Luna low/medium/high or Sol low. Investigate allocation efficiency rather than judging quality solely by task-kind accuracy.
- The complex process-safety cases generally selected Astra high/xhigh on GPT classifiers, Astra medium on Jev. Whether that extra reasoning pays off requires executing and evaluating workers, which this test deliberately did not do.

## Limits and provenance

One sample per case/router, not a statistical accuracy benchmark. Classification checks use the predeclared acceptable kinds and workspace expectations stored with the cases. There is no objective best-model label. GPT classifiers ran concurrently per case, and Jev ran separately after fixing the runner profile; timing is indicative, not a controlled speed ranking. Provider caches were uncontrolled. Token counts are provider-reported and only complete for successful routes; failed attempts can consume additional unreported tokens. Different tokenizers/prices mean these counts cannot rank dollar cost. Workspace evidence was shared within each run.

The initial Jev attempts failed locally before inference because the test runner used Electron's default encryption profile. The runner now uses Harness's profile for safeStorage. Those setup errors are preserved in the original file and replaced by the successful Jev-only run for this report. No key was logged or exported.

- [Original first-pass raw results](routing-decisions.json)
- [Jev-only raw results after correcting the profile](routing-decisions-jev.json)
- [Diagnostic retries, with raw structured decisions](routing-decisions-diagnostics.json)

Repeat explicitly (makes paid classifier calls):

```text
electron tests/routing-decisions-live.cjs
electron tests/routing-decisions-live.cjs --jev-only
electron tests/routing-decisions-live.cjs --failed-only
```

On Windows use node_modules/.bin/electron.cmd with ELECTRON_RUN_AS_NODE unset. The runner reads saved provider settings/credentials, uses temporary controller state and classifier threads, and never executes the chosen workers. A new full run overwrites the raw result file; archive it first when comparing runs.
