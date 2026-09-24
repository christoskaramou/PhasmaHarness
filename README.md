# Phasma Harness

Desktop client (Windows and Linux) for local coding agents. One chat can use Codex, Claude Code and Cursor CLI, each on its own account; any one is enough. Smart routing can pick a model, or you can choose one.

## Requirements

- Windows x64, or Linux x64/arm64 via `npm ci && npm start` (the `.cmd`/`.vbs` launchers are Windows-only)
- Node.js 22 or newer and Git
- At least one provider: Codex CLI (ChatGPT or API providers), Claude Code, or Cursor CLI

No provider is required up front. Settings → Providers shows an **Install** button next to any provider that is not detected; it confirms, runs the vendor's official installer (npm for Codex 0.156.1, pinned as `CODEX_VERSION` in `src/providers/install.cjs`, claude.ai/install for Claude, cursor.com/install for Cursor), then re-detects it. Sign in with the plug button afterwards. Configured task checks run in the Codex sandbox when Codex is connected; otherwise they run as local processes after an approval prompt that says so (Full access skips the prompt), with the same timeout, Stop and crash-recovery handling on Windows and Linux. The execution block is saved before a local check starts. When the check exits, everything it started is stopped and verified gone (Linux: an inherited `PHASMA_HARNESS_CHECK` environment tag; Windows: the process tree recorded while it runs, plus `ParentProcessId` links); a detached leftover is reported on the result, and an unverifiable one keeps the block. Descendants that clear their environment (Linux) or whose short-lived parent exited unseen (Windows) are not tracked. The context meter and manual compaction work for Codex and Claude sessions; Cursor reports no usage and has no compact command. OpenAI-compatible API providers, the connected-MCP gateway and ChatGPT models still need Codex, which is their runtime. Jev is optional and uses a key you save in Settings.

### Access by provider

The access setting applies to every provider; Codex enforces it with its OS sandbox, Claude and Cursor with Harness approval prompts.

| | Codex | Claude Code | Cursor |
|---|---|---|---|
| Ask | read-only sandbox, no network; more asks | reads inside the workspace and read-only commands run; outside reads, other commands, edits and web ask. Small tool set, no subagents | permission requests ask |
| Workspace access | workspace-write sandbox, no network; more asks | reads, edits and filesystem commands inside the workspace run; other commands, outside edits and web ask | permission requests ask |
| Full access | no sandbox, no prompts | `bypassPermissions` | auto-approved |

Routing classifiers get no tools on any provider. An approval still open when a turn ends, is stopped, or is withdrawn by the CLI is declined. Claude's own `~/.claude` allow and deny rules still apply. Like Codex, each Claude model is offered at every effort it supports (`claude-cli:<model>:<effort>`), enabled per model in Settings → Providers, and the router picks the effort per task; a model without effort levels uses the CLI default. Cursor models get the same treatment from the reasoning levels (`thought_level`) Cursor lists in `cursor/list_available_models`; the chosen level is set with `session/set_config_option` (parameterized model picker), and Cursor saves the last model and level as its own default, as it already did for the model.

### Approvals, usage limits and diagnostics

- **Allow for this session.** An approval prompt can be answered once or for the rest of the session. Codex remembers it itself for that conversation (`acceptForSession`, or session scope for permission requests); Harness does not reset what Codex remembers when the access setting changes. For Claude and Cursor, Harness remembers the tool together with its exact target, never the tool as a whole: Claude's Bash, file, search and web tools by their command, file, pattern or URL, and any other tool (MCP tools, Task, …) only when its whole input repeats exactly; Cursor by the command, file or URL its request names, and MCP calls with their arguments. Requests without a specific target, plans and questions are never remembered, and changing the session's access setting or deleting the session forgets these answers.
- **Usage-limit failover.** When a provider reports that its plan limit is reached (Codex `usageLimitExceeded`/`rateLimitExceeded`, Claude's rate-limit result, Cursor's "Upgrade your plan"/"Add a payment method" reply), Harness marks that provider limited until its reported reset time (15 minutes when the provider gives none). Claude's weekly Opus or Sonnet window limits only that model family, and a rejected Claude window that paid extra usage still covers is not a limit. On Auto the same message is sent once more through another provider (or, for a model-family limit, another model of the same provider) that has an available model, with a notice in the chat; a manually chosen model only reports the limit, and so does a stopped turn or a paused queue. The refused attempt runs no task checks. While a provider is limited, Auto routing leaves out its models, and a limited routing model is replaced by another enabled one. A later successful turn with a model the limit covers clears the mark.
- **Usage in Settings → Providers.** Each signed-in provider row shows what its CLI reports: Codex's plan windows (for example "Used: 42% of 5h", with the reset time), Claude's current utilization, and "Usage limit reached · resets …" (or "Opus usage limit reached …") while limited. A full Codex window marks the limit ahead of time only without credits, since credits let usage continue. Cursor reports no usage.
- **API providers.** Settings → Providers → API providers adds an OpenAI-compatible endpoint (name, base URL, optional key). Keys are stored encrypted with the OS key store and are never shown again; each provider can be enabled, have its key replaced or cleared, or be removed. Their models appear in the Models list and run through Codex.
- **Logs and diagnostics.** The app writes `logs/harness.log` in its data folder (rotated at 1 MB, two older files kept), with failed actions, provider disconnects, usage limits and crashes; keys and tokens are redacted. Settings → General → **Copy diagnostics** copies versions, provider states (no account emails), settings that affect routing, usage limits and the recent log, for bug reports. **Open logs folder** opens the folder. Prompts and replies are not logged.

## Run

```
npm ci
npm start
```

`Launch Phasma Harness.vbs` opens the app without a command window after dependencies are installed.

`Install Phasma Harness.cmd` installs missing Node.js LTS and Git through winget, runs `npm ci`, fetches the bundled tools, and creates a desktop shortcut. Providers are installed from the app. Keep the folder where the shortcut points.

### Installer build and updates

`npm run dist` builds a Windows installer (`dist/Phasma-Harness-Setup-<version>.exe`) with electron-builder, pinned in the script and fetched by `npx`, so it is not a dependency of the source install. Build it on Windows after `npm ci`, because the bundled rg/rtk come from `tools/bin` for the build machine. The installer asks whether to install for you only (the default, no administrator rights) or for everyone on the computer, lets you choose the folder, and ships the app unpacked (no asar) because the provider CLIs run bundled files such as the helper MCP script, skills and `tools/bin` by path. It has no custom icon yet and is not code-signed, so SmartScreen may warn on first run.

An installed app keeps everything in `%APPDATA%\Phasma Harness`, including the workspace wikis (`workspace-data`), so installing a newer version over it keeps settings, sessions and wikis. A source folder keeps `workspace-data` beside the app as before.

Settings → General shows the version and has **Check for updates**, which asks GitHub for the latest release of this repository and, when a newer one exists, offers to open its page. Nothing is downloaded or installed automatically. A private repository, or one with no releases, answers as "no published release"; there is no background check.

To release: bump `version` in `package.json`, commit, and push a tag `v<version>`. CI then runs the tests, builds the installer and publishes it as a GitHub release (the tag must match the version).

### Bundled tools

RTK and ripgrep live in `tools/bin/` (Git-ignored). `npm ci` runs `tools/fetch.cjs`, which downloads the builds pinned in `tools/manifest.json` for Windows x64, Linux x64 or Linux arm64, verifies their SHA256, and skips tools already installed at the pinned hash. The app puts `tools/bin` first on `PATH` at startup, so every worker and helper uses these copies rather than system installs. To upgrade, change the version, URLs and hashes in the manifest and rerun `node tools/fetch.cjs`. Node, Git and the provider CLIs stay global: they are shared with the rest of the system and the CLIs hold your logins.

Sessions and settings are stored in `%APPDATA%\Phasma Harness`. The app uses your existing Codex, Claude, and Cursor logins. It does not copy those credentials.

## Tasks and checks

Worker messages are tracked automatically in the background. Direct Jev answers and wiki proposals remain untracked. Checks only run when configured; passing them does not establish complete task correctness. There are no task cards, acknowledgment buttons or per-message check controls.

Jev and Smart routing decide whether the configured workspace checks are useful for the current request, using their names and commands in the existing classification call. No extra model call is added. Relevant executable verification runs; unrelated checks can be skipped, with the decision retained in the internal task record. Manually selected models, which bypass routing, keep configured checks enabled . After a tracked turn, the app runs any retained checks configured under Settings → Checks. The task keeps the checks and access it started with. One failed run gets a single correction on the same model. A blocked or unknown check stops that correction. Stop during checks cancels the task.

Workers give normal replies without a mandatory completion checklist. Check results and task evidence remain saved internally.

The card also checks up to 20 explicit `file:line` or `file:start-end` citations from the latest final reply against current workspace files, reading at most 64 KiB per file. Paths outside the workspace (including symlink escapes), private paths, binary files, and files over the limit are not assessed. Resolved references only establish that the path and line range exist, not that the claim is correct. These signals never change check outcomes or trigger corrections. Other citation formats and historical file versions are not assessed.

### Wiki follow-up


After a worker completes and configured checks pass, Harness runs one internal wiki-maintenance turn on the same available model. It first assesses every original requirement and accepted amendment against current source and check evidence. Incomplete or ambiguous evidence means no edit. Only durable new knowledge belongs in the active wiki, with source references and verification dates; project instructions and source code are not changed. This is a model assessment, not a correctness guarantee. Failed, blocked, cancelled, unchecked and read-only tasks do not trigger maintenance. Existing access permissions and project validation rules still apply, including approval for an external wiki folder. Maintenance is hidden from chat, recorded on the task, and never replayed after interruption. It adds one worker turn per eligible task; no recursive tracking or automatic entry-file rewrites.

### Local wiki storage

Settings → Wiki shows the active workspace's wiki. All projects default to the app folder (the data folder, `%APPDATA%\Phasma Harness`, for an installed app), including projects with a repository wiki. This installation explicitly preserves PE's repository wiki through a saved override. Change folder selects a different wiki; Reset to default (after a confirmation) points it back to the app folder; Show in folder opens it. These changes apply immediately per workspace and never copy, move or delete existing pages. Overrides live in workspace-data/locations.json. Default workspaces get `workspace-data/<name>-<path-hash>/wiki/index.md` beside the app, plus `workspace.json` recording the associated workspace. Create focused Markdown topic pages and link them from the index. Opening the Wiki tab or requesting a proposal initializes this local store without replacing existing pages.

`project_context` searches the active local wiki alongside source, with at most 200 local wiki Markdown files and existing excerpt/size limits. Symlinked wiki pages are excluded. Other workspaces' stores are excluded from source scans. Files stay local with no automatic publishing or synchronization; context excerpts still go to the chosen model/ranker as part of normal requests. `workspace-data/` is Git-ignored and must be preserved when replacing the app folder; do not include it when sharing the app. The portable app folder must be writable. Moving a project to a different absolute path gives it a new identity; automatic migration is not implemented.

If a check's process cannot be confirmed stopped, every session refuses new work until that process identity is gone. Acknowledging the task does not lift that block. Restarting the app does not rerun an unfinished task.

Recovery requires confirmed process-tree termination or the measured parent-exit cleanup contract (Codex CLI 0.153.4 on Windows with full access). An unknown lookup or an unmeasured runtime does not establish that descendants stopped. The install pin is now 0.156.1, which has not been measured, so on it recovery relies on confirmed process-tree termination until `MEASURED_REAP` in `src/tasks.cjs` is updated from a new measurement. `node tests/codex-reap-live.cjs [workspace]` measures it on Windows: it runs a check that starts a foreground and a detached process through Codex with full access, then ends Codex twice (closing its input, as the app does, and terminating it, as a crash does) and reports whether every check process stopped. It prints the exact `MEASURED_REAP` line to use only when both cases leave nothing running; it needs the Codex CLI but no login and makes no model calls.

### Validation

`npm test` runs every unit test (`tests/*.test.cjs`); `node --test tests/tasks.test.cjs tests/core.test.cjs` runs just the task and controller regressions, and `node --test tests/bundled-tools.test.cjs` the tool manifest and large-response helper. `npm run smoke` opens the real window with a test controller (no logins or model calls) and exercises Settings and the chat UI; on Linux without a display use `xvfb-run -a npx electron --no-sandbox tests/ui-startup-smoke.cjs`. `tests/installer.test.ps1` checks the installer script on Windows without changing the machine.

CI (`.github/workflows/ci.yml`) runs the unit tests and the UI smoke on Windows and Linux for pushes to master and pull requests, plus the installer script test on Windows. The installer is built only for version tags or a manual run, to keep Actions minutes low.
Run `node tests/task-checks-live.cjs <workspace>` for an opt-in completion-gate smoke with a real Codex connection, temporary app state, and a read-only Git command. It makes no model calls and prints the retained evidence directory.
Append `workspace-write` to test Workspace access. The smoke approves only its fixed Git check; normal app checks still use the session's approval rules.

Measured 2026-09-23 in PhasmaEngine with Codex `0.155.0-alpha.16`, Windows, full access: three no-check gate runs took 349/480/401 ms; three Git-check gate runs took 1353/1071/1041 ms, including command times of 84/37/33 ms. Median gate times were 401 ms and 1071 ms. This is a small transport/persistence smoke, not an engine build, live worker, cancellation, or UI test.

Workspace-access follow-up on the same date/runtime: all three runs passed, at 2066/1979/2049 ms (median 2049 ms). Windows sandbox rejects a custom `outputBytesCap`, so checks use the server's default limit and still cap stored output locally. The latest task result appears below the conversation messages.

## Layout

- `src/controller.cjs` — sessions, sending and the worker turn; the rest of the Controller is split by area in `src/controller/` (`providers` catalog, routing models and usage limits; `turns` Codex turn events; `helpers` worker helper tools; `task-gate` tasks, checks and recovery; `shared` constants)
- `src/providers` — Codex, Claude, Cursor, and Jev
- `src/routing` — model choice and benchmark evidence
- `src/workspace` — project search
- `src/tools` — helper tools shared with those CLIs
- `ui` — the window
- `src/log.cjs`, `src/diagnostics.cjs`, `src/updates.cjs` — log file, diagnostics text, update check
- `benchmarks` — bundled measurements

### Bundled default skills

Full SKILL.md files ship in skills/: caveman, ponytail, i-have-adhd, large-responses, workflow and rtk. The large-response Node helper and Ponytail license are included. No user-global skill directory is needed. Workers get a short defaults block (action-first replies, Ponytail full, workflow, output budget, bundled rtk/rg, wiki) plus an index of the skills with their paths, about 750 tokens instead of the ~5,750 the full bodies cost. A worker reads a full skill only when its topic applies, through `router_read_output` with `{"skill": "<name>"}` (works in every access mode and provider) or the file. Caveman is opt-in: listed, never active by default. Restart after editing skills. The installer checks these payload files.

### Routing cost

On Auto, every message is routed from the full catalog, so a session that starts with a simple question can still move to a stronger model for review or debugging. Task tracking is enabled independently unless skipped for that message. The router is told which worker already holds the conversation (`currentWorker`) and keeps it when adequate, because switching makes the next worker re-read the conversation without the prompt cache once; it switches for a different capability need or a clearly cheaper adequate choice, not back and forth. The router sees a compact catalog: one flat row per worker with only routing-relevant numbers (general index, repository engineering, coding agent, terminal, tool use, algorithmic, long context, instruction following, API price, speed), each from one comparable benchmark version and harness, with assisted fallback runs excluded. Its fixed prompt is about 750 tokens instead of about 3,100. Jev ranking keeps the full benchmark view.

Smart first classifies the request without scanning the workspace. Only when that decision needs workspace evidence does it scan and make a second call. Successful two-call routes sum both usages; general requests have no discarded background classifier. This saves calls on general requests, but makes workspace-dependent routing sequential and potentially slower. See [measured routing results](benchmarks/results/routing-demand.md).

Codex receives developer instructions; Claude an appended system prompt; Cursor a prompt prefix. Classifiers and Jev yes/no shortcuts stay unchanged. User style overrides remain supported through conversation instructions. These instructions are not enforced guarantees.

The installer provisions Node and Git when absent or unusable, and fetches RTK and ripgrep into `tools/bin`. Provider CLIs are installed on demand from Settings → Providers. Python is not required. Working installations are preserved. Bundled skill files are checked before installation. Downloads for Cursor, npm and Electron are kept in installers/; WinGet manages other package downloads. WinGet must already be available. This is not a complete offline installer. See skills/README.md.

### Shared project entry and memory

Every worker receives the current <workspace>/INSTRUCTIONS.md through the same provider adapter as the bundled skills. Existing content is never replaced. The first writable worker turn creates a short starter if missing; read-only sessions report the missing entry without creating it. Browsing a session does not create files. Symlinked/non-file entries and entries above 64 KiB produce explicit errors. Keep detailed knowledge in the wiki.

Content is reread before worker turns. Codex/API threads resume with updated developer instructions when entry content or the selected wiki path changes; unchanged threads do not need extra resumes. Claude/Cursor receive current contents with each worker request. Provider-native instruction files remain untouched; workers are instructed to surface conflicts. This is model guidance, not an automatic conflict validator.

The entry points to the active wiki supplied by Harness rather than embedding a machine-specific path that becomes stale when the wiki moves. PE keeps its existing root entry. The wiki proposal backend can also propose a focused entry-file improvement based on verified workflow changes or recurring corrections, with evidence and a verification date. Apply only after user authorization. No automatic rewrites or separate memory database.

Memory consists of persistent per-workspace wiki pages, retrieved on demand via project_context, plus saved session history. Workers see the entry and wiki location, not the full wiki on every turn. Persistence does not guarantee the model retrieved every relevant fact; there is no automatic learning from every conversation.

Claude model discovery uses the signed-in CLI initialization response, without an inference request. Providers and routing use its versioned model IDs, deduplicating aliases while retaining context variants. Renew refreshes this list; discovery errors never fall back to hard-coded Haiku/Sonnet/Opus presets.
