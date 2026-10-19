# PhasmaHarness design

Draft design · 18 October 2026

PhasmaHarness should feel like messaging a capable teammate: describe an outcome, keep talking while work happens, and receive something you can use. Grok Bot is the experience reference. Responsiveness, asynchronous coordination, and simple defaults are requirements for the first release.

The user sees chats, bots, and results. Harness manages execution, handoffs, workspaces, verification, and limits. Hub is the default conversation; specialists remain directly reachable. Provider settings stay available in Settings.

## The experience

1. Open Harness and start talking. Reuse connected providers; one working provider is enough. If none is ready, offer one setup action and return to the conversation afterward.
2. Ask for work: “Make three small Phasma games overnight.” Hub confirms the accepted work and returns control immediately after durable submission. It chooses workers without requiring model, computer, or workflow configuration.
3. Keep talking: “Make the second game cooperative.” Hub accepts the change while workers continue. The conversation distinguishes received, queued, and applied instructions.
4. Inspect progress only when useful. A compact activity card shows who owns the result, what is happening, and anything that needs attention. Detailed handoffs and logs expand on demand.
5. Open the result in chat. Each game has a preview, its actual build and test status, and Open or Play when available. “Do this every Friday” creates a visible routine from the successful workflow.

Closing the window leaves work running. Explicitly quitting the runner stops work safely. The local PC must remain awake; remote execution later removes that dependency.

## Asynchronous coordination

**Sending work never means waiting for its completion.** A bot submits a message or assignment, receives an acknowledgment, and can continue other work or end its turn. The recipient wakes when eligible. Progress, questions, and results return later to the originating conversation without the user copying messages or polling.

Each requested outcome has one result owner. Helpers can own child assignments; they do not silently become owners of the whole request. The owner collects evidence and delivers the final result. Ownership changes are explicit, recorded, and acknowledged before taking effect.

| Interaction | Required behavior |
| --- | --- |
| Assign work | Persist the assignment before acknowledging it. Return its identity and queued/running status without waiting for a model to finish. |
| Recipient is busy | Queue the assignment without overwriting active work. Show capacity problems rather than silently dropping it. |
| Ask another bot a question | Send a separate correlated message. The answer must be deliverable without waiting behind the assignment that depends on it. |
| Report progress or finish | Deliver an event to the owner and original conversation. Completion remains visible even if the owner is busy or offline. |
| Redirect active work | Prioritize the user's instruction. Use supported live steering; otherwise interrupt safely, wait for cleanup, and continue from preserved context. Show when the change actually takes effect. |
| Stop | Accept cancellation through a local control, without a model decision. Stop the selected job and its descendants; keep unrelated work running. Show Stopping until cleanup is confirmed. |

Message IDs, job IDs, and parent relationships survive restart. Durable delivery may be retried; receivers deduplicate by message ID. This is not a promise that arbitrary shell commands execute exactly once. An uncertain command or external action is reconciled before replay.

Direct user messages and cancellation take priority over bot chatter. Background results still accumulate durably and are surfaced without flooding the transcript. Preserve order within a conversation and reject stale instructions/results against a newer job revision. A late result after cancellation is retained as evidence, not permission to resume work.

Each bot keeps one visible chat. Its delegated assignments use a separate saved execution context with the same role and an explicit permission ceiling. Asking the bot a question does not queue behind its assignment or change that assignment. Updates to work travel through the owning chat or the selected job's update action. Background contexts appear through compact activity and result details, rather than becoming more bots in the sidebar. Their reports still return to the original result owner.

Dependency cycles are rejected. A bot waiting for a helper releases its execution slot and can still receive questions or user instructions. Queue size, running-job capacity, and delegation depth are separate bounded controls. A ten-job batch need not launch ten workers simultaneously.

## Group chats

Create a group from the bot overview, give it a name and choose existing bots. Hub stays in its separate pinned area; groups have a short list beneath it. The group header identifies Hub as coordinator and offers a member picker. Start a message with `@Name` to address one member; the picker inserts that prefix. Unmentioned messages go to Hub. There is no automatic broadcast to all members and no extra Hub routing call for a direct mention.

A mentioned bot receives an ordinary asynchronous assignment. Its result returns to the group with one recorded owner; the user can keep talking in that group, Hub or another chat. Groups retain separate histories, drafts and queues. Context reads from an assigned bot resolve to its originating group. Job activity and owner links point to that group. Membership changes no workspace or permission ceiling. Removing a member with outstanding group work requires finishing or stopping that work first. Stop affects that group and its descendants. Archive retains history and refuses outstanding work; Clear retains membership and archives the old conversation.

## Voice and files

PDF and DOCX attachments provide extracted text as untrusted reference data. Extraction runs away from the chat thread, accepts files up to 10 MB and retains the existing four-item and 64 KB text limits. Reject oversized, protected, empty or unreadable documents explicitly; never silently truncate. Label extracted text so the user knows layouts, images and annotations are not included. Keep original documents on the user's computer without giving workers a new filesystem permission.

Voice input uses an available local recognizer and shows its language. The microphone starts only from the visible desktop view. Recognized words enter the originating draft; Send waits for the final words and remains a separate user action. Navigation, dialogs, hiding the view and Quit stop dictation. Late words stay with their original chat. Harness does not save microphone audio or send it to a transcription API. Missing local speech support is shown explicitly rather than changing to a paid service. Common document inputs remain untrusted reference data and must not grant broader filesystem access.

## Responsiveness

Keep the composer, navigation, Stop, and result viewing usable during builds, provider startup, and worker output. User-facing chat must not wait behind a long-running execution job. Reuse the existing Hub coordinator and keep expensive work in worker sessions; a directly messaged specialist uses the same separation for lengthy execution.

Do not route routine UI actions through a model. Reuse the selected chat model and established provider connections. Avoid a fresh routing or discovery call for every simple message. Reserve execution capacity for foreground interaction and apply backpressure to output streams so background work cannot flood the UI.

Initial acceptance targets on the reference PC, with two fake long-running workers:

- Input, navigation, and Stop show local feedback within 100 ms at p95.
- A submitted message receives a persisted receipt within 250 ms at p95, excluding provider response time.
- Durable job changes appear in an attached UI within 500 ms at p95.
- Real-model time to first visible response is measured separately. It must not include waiting for a background job to finish.

These are proposed targets, not measured performance claims. A receipt is not a claim that the model has read or applied an instruction.

## Minimal chat UI and appearance

Open [the UI preview](ui-templates.html). Use one minimal Grok Bot-inspired layout: a quiet bot sidebar, a large conversation, and a composer that stays available. Remove the preview's large heading, top tabs, colored avatars, boxed activity dashboard, and decorative chrome. Keep generous whitespace, neutral surfaces, simple typography, and restrained borders.

| Appearance | Behavior | Default |
| --- | --- | --- |
| Dark | Neutral dark surfaces and light text. | Optional. |
| Light | Neutral light surfaces and dark text. | Optional. |
| System | Follow the operating system's light or dark appearance, including changes while Harness is open. | Initial default. |

Hub has its own pinned area at the top of the sidebar: a larger neutral icon, its name, and “Your main chat.” Whitespace and a quiet divider separate it from Other bots. Hub keeps this position when a specialist is selected; selection styling alone must not provide the separation. Other bots use compact rows with a short latest-message preview and a restrained activity indicator. Put search and new-chat controls in a small toolbar and Settings at the bottom. This borrows the reference's hierarchy without copying its branding.

The chat ends at the composer: no permanent permission explanation, keyboard hints, token counters, or extra footer buttons. Clear, Commands, usage, context and advanced model settings are available through Options; connection progress appears in the header only when needed. The placeholder simply names the bot.

The header identifies the current bot without model controls. Show background work as a compact status row with expandable handoffs; show a usable result inline when it is ready. Keep the selected conversation and result owner clear and Stop reachable from the activity row. Files and images attach through the composer. Text/code attachments are bounded UTF-8 snapshots, shown as removable filename chips; sending quotes their contents as untrusted reference data without granting access to the original path. Sent files stay collapsed but inspectable, and their complete contents survive queues, history and export. Reject unsupported binary/document formats clearly. Advanced provider settings and raw logs are secondary. On narrow screens, collapse the sidebar while retaining a distinct Hub shortcut above specialist shortcuts; chat remains primary. Preserve keyboard navigation, readable contrast, focus states, and reduced-motion preferences in both palettes.

Choose Dark, Light, or System in Settings → Appearance and remember that exact preference across launches. System resolves through the OS preference rather than saving whichever palette happened to be active. Switching applies immediately without changing conversations, interrupting work, reconnecting providers, or calling a model. Use shared CSS color tokens, with one layout and component implementation. No custom named color themes are needed.

The preview contains illustrative content. Settings → Appearance switches Dark, Light, and System; there are no top theme tabs. Appearance selection and disclosure controls work; task actions are explicitly marked as previews. They do not run agents or games.

## Execution and ownership

Claude Code uses the user's own native sign-in in the unmodified published client. Follow the [verified authentication and hosting conditions](wiki/local-agents.md#claude-code-authentication); keep credentials inside that client and preserve user-selected billing.

### Provider support

Keep Codex, Claude Code, and Cursor, and add Muse Code plus Google CLI support. Official naming distinguishes **Muse Code** (`muse`), **Antigravity CLI** (`agy`), and **Gemini CLI** (`gemini`). Target Antigravity for the requested Google experience and include Gemini CLI compatibility as a distinct adapter; never assume the commands, credentials, or protocols are interchangeable.

Provider choice remains in Settings or an explicit chat request. Detect an installed CLI, offer its native sign-in when needed, and show whether it is ready. Installing every provider is optional. Unsupported capabilities are shown honestly; all providers still participate in Harness's asynchronous job and message system. Antigravity initially supports text workers with Full access; it cannot present Harness approval prompts or act as the structured Hub router. Unsupported access levels fail before submission.

From a browser, Connect checks the runner host's existing native account and enables it only when ready. Refresh keeps the saved plug choice; Disconnect stops Harness from using that provider and leaves its native login intact. Native sign-in remains a host action. Shared connection changes hold execution admission while metadata and saved settings synchronize, without blocking typing or losing accepted queued work.

Harness owns cross-provider handoffs. A Muse worker can ask a Google worker for help and return to other work through the same mailbox as existing providers. Do not depend on a provider's native bot-to-bot messaging: Muse's current documentation, for example, says its session messaging is unavailable on Windows. Native subagents must remain inside the parent job's budget and cancellation boundary.

Names and interfaces verified 18 October 2026 against [Muse Code](https://dev.meta.ai/docs/muse-code), [Antigravity CLI](https://antigravity.google/docs/cli/install/), [Google's migration guide](https://antigravity.google/docs/cli/gcli-migration/), and [Gemini CLI](https://geminicli.com/docs/cli/headless/). Installed-version compatibility and authentication still require implementation-time validation.

### Runner and workspaces

Use one persistent background runner per user and a desktop client that attaches to it. The runner owns jobs, provider processes, message delivery, limits, and recovery. The window displays state and submits commands. A reconnect refreshes state without duplicating workers. Start locally using the user's established toolchain and native CLI authentication.

On Linux, run the same engine without Electron or a display, under one systemd service per private data directory. The service owns its worker cgroup and kills remaining descendants before restarting. Enable automatic recovery only after checking the actual service identity and cleanup policy; an environment variable or a process being gone is insufficient evidence. Reuse the authenticated browser frontend and command validation. Native provider sign-in stays on the host, and encrypted desktop API keys are never copied or downgraded to plaintext for hosting.

Reuse named bots for stable roles. Automatically created batch workers and their helpers stay in the sidebar while they have pending work. Finished workers remain in Overview, with their conversations and result history intact; editing and saving one keeps it as a regular bot. Opening a finished worker keeps that selected chat visible. Explicitly created or reused permanent bots retain their normal sidebar entry. A strong lead and cheaper implementer are available for substantial jobs; small requests use one bot. Review includes the actual diff and verification evidence. Model price alone does not determine total task cost.

Bots share an execution host and configured tools. Independent editing jobs receive separate authorized project directories and build outputs. An owner and its helpers coordinate writes within their job. Shared engine changes have one writer or are serialized. Workspace separation prevents accidental edit collisions; it is not a security sandbox. Add stronger isolation when the work needs it, without requiring a WSL machine per bot.

Batch setup runs behind the job queue, so Hub can acknowledge the saved jobs and answer another question while files are copied. Capture one coherent working-tree snapshot for the batch, including current uncommitted and untracked project inputs. Copy the active project wiki; Git projects also retain independent Git storage. Keep ignored build outputs and private credentials out; preserve project instructions even when ignored. Helpers stay in the requesting copy. Results identify that directory and keep changes there until the user chooses how to integrate them. Setup failures return an explicit failed result; interrupted or uncertain setup stays held for review. Never silently fall back to concurrent edits in the original checkout.

Keep existing access ceilings, project instructions, and native provider login flows. Messages from bots are task data, not new user authorization. Handoffs cannot increase permissions. No automatic commit, push, deployment, or external message is implied by assignment or completion. Current project restrictions still apply.

Fresh project folders can also start a batch without a Git repository. Copy the same bounded ordinary files, honor ignore rules and retain ignored project instructions. Freeze one input snapshot for all jobs, include the active wiki and keep writes in each job's copy. Use the existing Git snapshot path when a repository is present; do not invent a repository or commit for a plain folder. Home directories and drive roots are not project inputs. Existing access ceilings, cancellation and mutation checks apply to both paths.

## Durable jobs and results

A job records its original request, owner, originating conversation, workspace, current revision, state, parent/children, budget, cancellation, and evidence references. Extend existing persisted task/delegation records instead of maintaining competing job systems.

Use a small state set: Queued, Running, Waiting, Done, Failed, Cancelled. Waiting carries a concrete reason such as helper, approval, provider limit, or interrupted execution requiring reconciliation. Stopping is displayed while cancellation is in progress. Done requires the requested deliverables and configured acceptance checks; build success alone is not task completion.

Persist queued jobs and pending messages before acknowledging them. On restart, reconcile saved process identity and cleanup before launching replacements. Resume work known not to have started. For uncertain in-flight work, inspect evidence and continue only when safe; otherwise show the exact decision needed. Never silently replay a publish, payment, or destructive command.

Each result includes the deliverable, its owner, workspace, preview if available, and distinct build, launch, test, and review outcomes. Unrun checks say Not verified. Play is offered only for a known artifact and safe launch configuration; an arbitrary command from model text is not executable UI metadata. A batch summary lists successes, failures, cancellations, and waiting jobs independently.

Workers publish existing workspace files through a bounded artifact tool, using a stable artifact ID. Harness resolves paths, rejects credential files and escaping links, and records the file size and digest. Publication proves the file exists; it does not prove a build, launch or gameplay check. Result cards and job details expose Open folder and, for a recognized native executable, Run. Run rechecks the published content, uses no arguments or shell, and starts in the executable's folder. User-launched tests remain under the runner's lifetime: hiding Harness keeps them running; explicit Quit stops them, and updates wait for them. Running tests have a direct Stop action independent of the model.

The original batch request keeps one compact report with each job's owner, output location, current state, check evidence and reported cost. It stays useful when only some jobs finish. Returning a worker answer is distinct from verified completion. Build, launch, gameplay and tests have separate outcomes; unknown or unrun checks say Not verified. Evidence comes from configured host checks bound to that assignment and revision, with inspectable command, directory, exit code and time. A later edit is not covered by an older check.

## Budgets and routines

Claude plan allowances come from the published CLI's structured usage request, with no user prompt, model request or transcript scan. Validate and retain supported windows, bind them to native auth metadata and keep Opus/Sonnet windows separate. An unmapped model window protects Claude background work conservatively and says why. Reuse recent same-account reports for at most thirty seconds; native usage events invalidate that cache. Refresh stale reports before held work starts and recheck held work at least every five minutes. These are metadata requests, not polling model calls. Unknown data stays unknown, active calls may finish, and one call can exceed the remaining allowance before its usage is reported.

Bound running jobs, retries, execution time, and model usage where reported. Pause on provider limits and present the actual reason. Never switch to paid API usage or increase a budget silently. Subscription capacity and money are separate: label estimates and unknown quota rather than promising exact remaining weekly usage.

Each new delegated job starts with a two-hour active-time allowance shared by its helpers and automatic follow-ups. Ownership transfers and requested corrections retain that allowance. Count elapsed wall time while any turn, routing decision, check or approval wait in that job tree is active; exclude idle helper waits, capacity waits and quota holds. Concurrent helpers share the same clock. Save clock transitions and use a monotonic clock while running. A restart with an open clock lease pauses the job for review and labels the elapsed estimate. Reaching the limit saves a pause before stopping affected execution; chat and unrelated jobs remain available. Job details show the used time and let the user change the total limit or explicitly resume after cleanup is confirmed. Automatic work cannot raise or reset the allowance. Reported-token and retry limits remain separate from this elapsed-time allowance.

Save each model request before submission, including worker turns, routing, summary and review requests. A job starts with at most twenty such attempts across its tree; native internal model calls remain part of their enclosing request. Retain existing bounded correction and structured-response retries. The user may set an optional reported-token limit. Stable request identities prevent duplicate cumulative reports from inflating usage, and cached input stays a subset of input. A configured token limit holds before an unmetered provider or after an attempt whose final usage is unavailable. Reaching a reported limit requests Stop; an admitted call can overshoot before reporting its usage. Changing limits or resuming preserves prior attempts and usage. Show known usage with an explicit incomplete marker, never an invented zero. Show a dollar amount only when a provider supplies a cost report, labelled as a provider estimate rather than an invoice or an extra subscription charge. Unknown costs remain unknown; do not guess prices or silently change billing routes.

Direct tracked tasks also acquire their budget before routing. Their corrections, checks and helpers share it; ordinary untracked chat remains separate. A pause saves the original request and input references before stopping the task. Explicit Resume continues it in the same bot's existing background worker, with the original workspace, permission ceiling, accepted model and frozen checks. The original chat owns the result and stays available. Use a saved resume identity so a retry or crash cannot create duplicate assignments. Preserve earlier evidence and consumed usage; never silently drop an original image or substitute an unavailable accepted model. Restarted or otherwise uncertain execution still requires review.

The first allowance guard reserves the last 10% of a reported subscription window for direct chat. Settings can change the background threshold from 1–100%. At that threshold, queued jobs and subsequent background turns wait; a running native turn may finish. Keep the last valid allowance report across restart, including its reset time. A known reset or a newer report can release a wait. Auto waits rather than switching accounts to bypass the reserve. Use ChatGPT reports and supported native Claude Code reports; other providers show quota as unknown until a supported report exists. This is a guard at submission boundaries, not a guaranteed spending cap or a prediction of how much one turn will consume.

After reliable one-time execution, “repeat this” saves the workflow and schedule in conversation, including timezone, next run, owner, and limits. Missed runs coalesce into one pending occurrence by default; the same routine does not overlap itself. User-input waits remain paused until answered. Notify on completion, meaningful failure, or required input, not on unchanged polling.

### Routine behavior

A restricted worker can fetch the full request assigned to it even when the owning chat has broader permissions. That input handoff exposes the assigned text only; it does not open the owner's conversation history or grant filesystem access.

Routines retain a specific user-message workflow and its selected worker, workspace, permission ceiling, configured checks and job limits. The chat owner receives each occurrence as an ordinary asynchronous result. Calendar schedules use an explicit timezone, local clock time and weekdays. A repeated autumn clock time runs once; a nonexistent spring clock time is skipped. Missed calendar occurrences coalesce into one catch-up run. A Git trigger watches local HEAD changes, establishes its initial baseline before acknowledgment and coalesces additional changes while its previous run is active.

The runner saves an occurrence identity and assignment identity before admission. Restart finds that saved assignment or retains an uncertain admission for review; it never guesses that a missing record means no work occurred. A routine does not overlap itself, including a pending owner review, budget pause or unanswered input. Pausing disables future occurrences while the current job keeps its existing Stop control. Future routines do not prevent updates or explicit Quit; live admission and Git reads do. The scheduler makes no model calls to check whether work is due.

## Delivery scope

On a phone or another computer, a returned artifact offers Download file or Download ZIP. Games should include their assets and libraries in a portable export. Downloads keep chat usable and have a Stop control while active. A separate Run on runner action tests a published executable on its host. The owner distinguishes a file being available from a verified build, launch or gameplay result.

The first milestone proves responsive chat and asynchronous handoffs with visible results. The next makes those jobs survive window closure and recover safely, with bounded batches and local runtime verification. Groups and conversational schedules follow on the same foundation. Voice, a hosted runner, mobile access, and stronger computer isolation extend the product after that.

Do not defer the simple UI until infrastructure is finished. Do not introduce a workflow editor, mandatory model pairing, a distributed queue service, or a separate computer for every bot in the first release.

## Acceptance scenario

“Make three games. While they run, answer a separate question, change game two, and stop game three. Close and reopen Harness. Game one returns a playable artifact and evidence; game two records the applied correction; game three stays cancelled. No messages are copied between bots, no completion is duplicated, and the owner explains every unresolved item.”

Also test a forced runner restart, a busy recipient, a full queue, an unanswered approval, exhausted provider capacity, and a child result arriving after cancellation. None may freeze chat, lose acknowledged work, or restart cancelled work.

## References

Grok behavior reviewed 18 October 2026: [messaging and asynchronous handoffs](https://docs.x.ai/grok-bot/chat-and-collaboration), [persistent bots](https://docs.x.ai/grok-bot/bots), [shared computer](https://docs.x.ai/grok-bot/computer-and-apps), [files and results](https://docs.x.ai/grok-bot/files-and-results), and [skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations). This design specifies Harness behavior; it does not assume Grok's internal implementation.

Continue with the [implementation plan](implementation-plan.md). Current implementation knowledge remains in the [project wiki](wiki/index.md).
