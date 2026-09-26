---
name: test-pool
description: After finishing a fix or a task that changed code in a repository, add a small regression test for the problem you solved to the project's test pool (.testpool/catalog.json), so Jev can rerun it automatically after later replies. Also use when asked to add, list, check or run pooled tests, or when a "Test pool:" failure report arrives.
---

# Test pool

Each repository keeps a pool of regression tests in `.testpool/catalog.json`. After every agent reply a Stop hook runs the pool runner. It:

1. Finds the files changed since the last check.
2. Keeps the tests whose `paths` match those files.
3. Asks Jev, a cheap classifier, which of them the changes could affect. It gives Jev each test's `covers`, `origin` and run history.
4. Runs the chosen tests.
5. Sends any failures back to you as a `Test pool:` report.

The runner has no memory of its own. The pool only knows what you write into the catalog, so your job is to grow it: one small test for each problem solved.

Runner: `node "{{SKILL_DIR}}/scripts/testpool.cjs" <command>`, run from inside the repository.

## When to add a test

Add one after a completed fix, or after a completed task that changed behavior. It doesn't need to be a whole task: one fixed bug is enough.

Don't add one when:

- The change is docs, comments, formatting or renaming only.
- The work is exploratory, or the user said no tests.
- An existing pool test already covers the case. Extend that test instead of duplicating it.

If the repository has no pool, create one with `init`. Skip this for vendored or third-party code, and when the user doesn't want a pool there.

## How

1. **Write the smallest deterministic check** that fails without your fix and passes with it:
   - Prefer the project's own test framework or an existing validation script, with arguments that target the case.
   - Otherwise put a script in `.testpool/tests/`.
   - Exit codes: 0 means pass, non-zero means fail, and 77 means skipped because a precondition is missing (for example an editor already owns a port, or the build output is absent). Print a one-line reason before a failure or a skip.
   - Assert on the exact symptom you fixed, for example "rigs == alive creeps on every status line", not "the app did not crash".
2. **Keep it safe to run unattended:**
   - Never kill or modify programs the user has open.
   - Restore every file the test edits.
   - Use temporary directories.
   - Bound every wait.
3. **Prove it:**
   - Run it with your fix: it must pass.
   - Where feasible, also show it fails without the fix, for example by stashing or reverting the fix line temporarily. Then restore the fix.
4. **Register it** in `.testpool/catalog.json` (format below), then run `validate` and `run <id>`.
5. **Say so in your reply**, for example: "Added pool test `ath-native-match`."

## Catalog format

```json
{
  "version": 1,
  "settings": { "budgetSec": 900, "jev": "auto", "maxBlocks": 2 },
  "setups": {
    "engine-build": { "command": "cmake --build build --config Release", "commandWindows": ".testpool\\tests\\build.cmd", "timeoutSec": 1800 }
  },
  "tests": [
    {
      "id": "creep-rigs-removed",
      "name": "Dead creep models are removed",
      "covers": "Native AthMatch deletes a creep's model once combat drops the creep; checks rigs == alive in the match log.",
      "paths": ["Native/Scripts/**", "Phasma/Runtime/Code/Script/**"],
      "command": "python3 .testpool/tests/ath_native_match.py",
      "commandWindows": "py -3 .testpool\\tests\\ath_native_match.py",
      "cost": "expensive",
      "timeoutSec": 240,
      "needs": ["engine-build"],
      "requires": ["build/Release/PhasmaPlayer.exe"],
      "origin": { "problem": "Dead creeps stayed on screen in the C++ match", "fix": "AthMatch deletes rigs missing from the live list", "date": "2026-09-25" }
    }
  ]
}
```

| Field | What to put there |
|---|---|
| `id` | Lowercase kebab-case, unique. |
| `covers` | The behavior the test protects, in plain words. Jev decides from this text, so name the subsystem and the symptom. |
| `paths` | Globs relative to the repository root, for the code whose changes could break this behavior. This means the code under test, not only the test file. `**` crosses folders; `*` does not. An empty list lets Jev judge every change, which costs a question per reply, so use it rarely. |
| `command` | A shell command run from `cwd` (default: repository root). `commandWindows` overrides it on Windows. |
| Placeholders | `${root}`, `${home}` and `${env:NAME}` work in `command`, `cwd`, `requires` and `env`. |
| `cost` | `cheap` is under 10 s. `medium` is under 2 min. `expensive` is longer, or launches apps or the GPU. Expensive tests run only when Jev sees a plausible link. |
| `needs` | Setup ids, such as a build, that run once per check before the tests that need them. A failed setup is reported as the failure. |
| `requires` | Paths that must exist. If one is missing, the test is skipped rather than failed. |
| `always` | `true` runs the test after every change. Use it only for cheap sanity checks. |
| `enabled` | `false` parks a test. |
| `origin` | The problem you solved, the fix, the date, and optionally the commit. |

The test environment has these variables:

- `TESTPOOL_ROOT`
- `TESTPOOL_RUN_DIR` (a scratch and log folder)
- `TESTPOOL_CHANGED_FILE` (the changed paths, one per line)
- `TESTPOOL_TEST_ID`

## Commands

| Command | Purpose |
|---|---|
| `init` | Create `.testpool/catalog.json` and `.testpool/.gitignore` (which ignores `runs/`). |
| `validate` / `list` | Check the catalog / show the tests. |
| `run <id>...` | Run the named tests and their setups now. |
| `check --dry-run` | Show what the next check would run and why (includes Jev's answers when a key is set). |
| `check [--since <ref>] [--all] [--no-jev]` | Pick and run tests now. |
| `baseline` | Mark the current changes as checked without running anything. |

Results are written to `.testpool/runs/`: `last.json`, `history.jsonl`, and one log per test.

## When a `Test pool:` failure report arrives

- **Your change caused it:** fix the code and finish your reply. The hook reruns the failing test.
- **It is unrelated or pre-existing:** say that plainly in your reply. Don't change the code under test to hide it.
- **Never** weaken, disable or delete a failing test to make it pass. If the test itself is wrong, fix the test and explain why.
- Automatic retries stop after `maxBlocks` for the same failures. Report what is still failing.

## Setup (once per machine)

- `node "{{SKILL_DIR}}/scripts/install.cjs"` installs this skill for Claude Code (`~/.claude/skills`), Codex and Cursor (`~/.agents/skills`). It also adds the Stop hook to:
  - `~/.claude/settings.json`
  - `~/.codex/hooks.json`
  - `~/.cursor/hooks.json`
- The hook does nothing in repositories without `.testpool/catalog.json`.
- Jev needs `JEV_API_KEY`, or `JEV_API_KEY_FILE` naming a file that holds the key. Without it, only path-matched cheap and medium tests run; expensive ones are listed as suggestions.
