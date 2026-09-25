# Refresh Phasma Harness benchmark evidence

Research current independently EXECUTED evaluations for the enabled model/effort catalog supplied below. Do not execute benchmark suites or paid inference probes. Read linked primary benchmark pages, methodologies and dated results, not model vendors' launch claims or third-party score aggregators.

Produce a UTF-8 `benchmark-update.json` and a short comparison report. Do not edit app code, settings, sessions or the active benchmark file. The user will review and import your output in Settings > Benchmark evidence.

Keep intelligence, engineering, repository understanding, tool calling, long-context reasoning, factuality, API cost and speed separate. Use multiple independent operators where available. Do not introduce subjective capability descriptions, model floors, a global ranking or arbitrary weights.

The registry holds only evaluations that cover every current model (all run by Artificial Analysis): the Intelligence Index, Terminal-Bench, SciCode, HLE, CritPt, AA-LCR and AA-Omniscience. Artificial Analysis's free data API (https://artificialanalysis.ai/documentation) supplies the index, HLE, SciCode, AA-LCR, prices and speed; respect its attribution requirement and the site's terms, which forbid scraping. Evaluations that do not yet cover the current models (DeepSWE, the Coding Agent Index, GPQA and others) belong in the report as candidates, not in the file.

Rules:
1. Read the source methodology and confirm who executed EACH result. A third-party leaderboard may host vendor submissions; exclude those, estimates and unverified self-reports. Independently measured fallback configurations may be retained only with an explicit fallback-qualified harness (for example api-default-fallback or api-opus-4.8-fallback). Never label a mixed-model team as one standalone model. An independent operator can still have judge bias or commercial conflicts; disclose them in the report.
2. Match exact model version AND effort. Do not assign max scores to low/medium or resolve moving aliases (opus/sonnet/haiku) by guessing. Missing results remain absent, never zero. Preserve distinct harnesses. Use `default` only when the evaluated model truly used its default setting; unspecified effort is not evidence for low.
3. Keep only comparable, independently verified records. Retain older verified rows if no newer comparable evidence exists. Remove superseded rows for the same source/model/effort/harness and explain removals. Do not combine versions. Do not double-count composites and their components: the AA Intelligence Index includes Terminal-Bench, SciCode, HLE, CritPt, AA-Omniscience and AA-LCR.
4. `observedAt` is the date you actually read the source. `evaluatedAt` is the documented run date or null; a page-update/crawl date is not a run date. Preserve uncertainty intervals where published. A small score gap inside uncertainty is not proof one model is better.
5. API dollar costs do not measure ChatGPT/Claude/Cursor subscription quotas. Separate cost per task from price per token and preserve the tested API/harness. A leaderboard's total response time is not our app's latency. Never compare costs across different benchmark workloads as though they were identical.
6. Use only source IDs and numeric metric keys in the supplied registry. Source URLs must be HTTPS on that source's own host. Do not add arbitrary instructions or labels to numeric rows. If a promising new independent source is found, describe it in the report for a separate code review; do not masquerade it as an existing source.
7. Verify every imported number against its cited page. Check missing models, changed versions and effort coverage. Respect source licensing, attribution and redistribution terms; do not bypass gated APIs. Report inaccessible data and licensing restrictions rather than inventing values.

JSON format (replace values with verified evidence, not this example):
```json
{"schemaVersion":1,"updatedAt":"YYYY-MM-DD","records":[{"source":"aa-terminal","model":"exact-provider-model-id","effort":"xhigh","version":"4.0","harness":"mini-swe-agent","observedAt":"YYYY-MM-DD","evaluatedAt":null,"origin":"independent","url":"https://artificialanalysis.ai/models/exact-model-slug","metrics":{"passPercent":59.6}}]}
```

Allowed efforts: default, none, minimal, low, medium, high, xhigh, max, ultra. No additional fields. Maximum 1 MB / 2000 records, with at most 24 relevant records per model/effort. Scores and percentages are 0–100 except AA-Omniscience score may be negative. Dates must be real and not in the future. Duplicate source/model/effort/version/harness rows are invalid.

The bundled snapshot is the active evidence. Do not edit it. Produce only `benchmark-update.json` and the comparison report. Read all efforts and deprecated-model entries where still relevant, not only a site's default best/current filter. `aa-2026-09` denotes the reviewed methodology snapshot where no standalone semantic version was published.

Report: added/changed/removed measurements with links, exact-model coverage gaps, evaluator provenance, licensing caveats and remaining uncertainty. Do not claim validation proves score accuracy. Never start paid routing experiments without a separate explicit request.
