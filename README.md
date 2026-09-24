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

Routing classifiers get no tools on any provider. An approval still open when a turn ends, is stopped, or is withdrawn by the CLI is declined. Claude's own `~/.claude` allow and deny rules still apply. Claude effort is set per model in Settings → Providers (default: the CLI's own setting).

## Run

```
npm ci
npm start
```

`Launch Phasma Harness.vbs` opens the app without a command window after dependencies are installed.

`Install Phasma Harness.cmd` installs missing Node.js LTS and Git through winget, runs `npm ci`, fetches the bundled tools, and creates a desktop shortcut. Providers are installed from the app. Keep the folder where the shortcut points.

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

Settings → Wiki shows the active workspace's wiki. All projects default to the app folder, including projects with a repository wiki. This installation explicitly preserves PE's repository wiki through a saved override. Change folder selects a different wiki; Reset to default (after a confirmation) points it back to the app folder; Show in folder opens it. These changes apply immediately per workspace and never copy, move or delete existing pages. Overrides live in workspace-data/locations.json. Default workspaces get `workspace-data/<name>-<path-hash>/wiki/index.md` beside the app, plus `workspace.json` recording the associated workspace. Create focused Markdown topic pages and link them from the index. Opening the Wiki tab or requesting a proposal initializes this local store without replacing existing pages.

`project_context` searches the active local wiki alongside source, with at most 200 local wiki Markdown files and existing excerpt/size limits. Symlinked wiki pages are excluded. Other workspaces' stores are excluded from source scans. Files stay local with no automatic publishing or synchronization; context excerpts still go to the chosen model/ranker as part of normal requests. `workspace-data/` is Git-ignored and must be preserved when replacing the app folder; do not include it when sharing the app. The portable app folder must be writable. Moving a project to a different absolute path gives it a new identity; automatic migration is not implemented.

If a check's process cannot be confirmed stopped, every session refuses new work until that process identity is gone. Acknowledging the task does not lift that block. Restarting the app does not rerun an unfinished task.

Recovery requires confirmed process-tree termination or the measured parent-exit cleanup contract (Codex CLI 0.153.4 on Windows with full access). An unknown lookup or an unmeasured runtime does not establish that descendants stopped. The install pin is now 0.156.1, which has not been measured, so on it recovery relies on confirmed process-tree termination until `MEASURED_REAP` in `src/tasks.cjs` is updated from a new measurement.

### Validation

Run `node --test tests/tasks.test.cjs tests/core.test.cjs` for the task and controller regressions, and `node --test tests/bundled-tools.test.cjs` for the tool manifest and large-response helper.
Run `node tests/task-checks-live.cjs <workspace>` for an opt-in completion-gate smoke with a real Codex connection, temporary app state, and a read-only Git command. It makes no model calls and prints the retained evidence directory.
Append `workspace-write` to test Workspace access. The smoke approves only its fixed Git check; normal app checks still use the session's approval rules.

Measured 2026-09-23 in PhasmaEngine with Codex `0.155.0-alpha.16`, Windows, full access: three no-check gate runs took 349/480/401 ms; three Git-check gate runs took 1353/1071/1041 ms, including command times of 84/37/33 ms. Median gate times were 401 ms and 1071 ms. This is a small transport/persistence smoke, not an engine build, live worker, cancellation, or UI test.

Workspace-access follow-up on the same date/runtime: all three runs passed, at 2066/1979/2049 ms (median 2049 ms). Windows sandbox rejects a custom `outputBytesCap`, so checks use the server's default limit and still cap stored output locally. The latest task result appears below the conversation messages.

## Layout

- `src/providers` — Codex, Claude, Cursor, and Jev
- `src/routing` — model choice and benchmark evidence
- `src/workspace` — project search
- `src/tools` — helper tools shared with those CLIs
- `ui` — the window
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
