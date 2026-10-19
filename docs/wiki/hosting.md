# Linux runner hosting

Verified 2026-10-19 against Node 24.11.1 and Ubuntu 24.04/systemd 255 in WSL. The headless engine, authenticated HTTP frontend, real image/PDF parsing, saved conversations, scoped Stop, ZIP downloads and forced restart passed with fake native inference. A public VPS, real phone/network, native sign-ins and game execution have not been accepted yet.

## Setup

Use a regular Linux account with Node.js 24 or newer and a running systemd user manager. Install the desired provider CLIs and complete their native sign-in on that host. Keep the host's own native credentials; do not copy desktop OAuth tokens or encrypted API/Jev key files. The headless runtime does not provide a plaintext replacement for unavailable OS key protection.

From a Linux checkout:

```sh
npm ci --omit=dev
node tools/linux-service.cjs --origin https://runner.example.com
```

The default private data directory is `~/.local/share/phasma-harness`; `--data /absolute/private/directory` selects another directory. New installations start with its `projects` folder as the workspace. Existing settings and conversations retain their saved workspace. The service name hashes the canonical data directory, so replacing its runner uses the same lifetime boundary.

Setup validates the unit before installing it, refuses an active runner, and atomically replaces only a recognized generated service file. Stop a running service before maintenance; setup does not interrupt accepted work for you. It enables user lingering without an interactive privilege prompt, then enables and starts the service. If policy denies lingering, the command stops with instructions for an authorized terminal. Lingering keeps the user manager available after logout and starts it at boot. [systemd login manager](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)

The installer prints an appropriately quoted command for retrieving the connection link. For the default data directory, the equivalent command is:

```sh
node src/server.cjs --connection-link
```

This command prints the private connection link and starts no provider process. Normal service output logs the origin, never the shared connection key. Existing saved port/origin settings are retained unless explicitly overridden. Use the unit name printed by setup with `systemctl --user status`, `stop` or `restart`; inspect its logs with `journalctl --user -u <unit>`.

## Network and credentials

The listener binds only to `127.0.0.1`, normally port 8788. Without `--origin`, its connection link is local to that machine. For phone/remote access, route a private HTTPS origin to that listener and configure the same origin with `--origin`. Preserve Host and Authorization headers, disable response buffering for the event stream, and preserve download response headers. Do not expose the loopback HTTP listener as an unauthenticated public port.

The existing browser pairing, revocable persisted sessions, explicit bearer headers, scoped confirmations and one-use artifact downloads are reused. Provider installation/sign-in and host-specific setup remain host actions. The service runs no Electron process and needs no display for chat, orchestration or file processing. Games still require their own supported build/runtime environment; headless chat is not evidence of GPU/display availability.

Browser provider plugs now use the shared noninteractive connection path (verified 2026-10-19). Connect checks the host-native account before enabling it; Refresh and Renew preserve its saved plug setting. Disconnect disables Harness use without signing out the CLI. Missing, signed-out or incompatible accounts explain which setup must be completed on the host; browser requests never start native login or import credentials. Provider changes hold execution admission until shared settings synchronize, preserving queued assignments. A failed synchronization blocks execution until restart rather than using stale account settings. The actual phone-sized browser and private headless-service fixtures verify Muse enablement, model renewal, disconnect and signed-out Gemini feedback with fake provider metadata; real account acceptance remains open. Sources: `src/provider-connection.cjs`, `src/runner-commands.cjs`, `src/controller.cjs`, `src/agents.cjs`, `ui/remote-api.js`; tests `tests/provider-connection.test.cjs`, `tests/agents.test.cjs`, `tests/remote-live.cjs`, `tests/server-live.cjs`.

## Runtime and verification

`src/server.cjs` reuses `createRunner`, `registerRunnerCommands`, `RemoteRunner` and `RemoteSettings`. Native desktop IPC keeps its sender checks. Before creating controllers, the Node entry verifies service identity/policy and checks that its cgroup contains only the current main process, with no live or dying child cgroups. Leftover workers therefore block admission even if cleanup settings look correct. The generated unit uses the verified 20-second cleanup policy, starts without a shell and disables environment substitution in command arguments; literal spaces, dollar signs and percent signs are exercised in the live fixture. [systemd command execution](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

Image validation uses the existing owned document worker and the already-installed canvas library. Both desktop and server check PNG, JPEG frame and WebP VP8/VP8L/VP8X header dimensions before loading the native decoder, reject mismatched signatures and images over 25 megapixels, repaint to PNG to remove source metadata, and bound normalized image URLs to 12 MiB total per message. Dimensions are checked again after decoding. This prevents large compressed rasters from allocating their full bitmap before the limit is applied (verified 2026-10-19). Header layout references: [libjpeg SOF parser](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/src/jdmarker.c), [WebP container](https://developers.google.com/speed/webp/docs/riff_container). Oversize output rejects with an instruction to use smaller images; it is never silently truncated. The file worker runs through `/usr/bin/prlimit --data` (util-linux) with a 768 MiB cap; without prlimit, documents and images are refused (see the R5 note in [local agents](local-agents.md)). Stop cancels matching preparation, and Quit waits for the file worker to close. The existing document timeout and update guard include image processing.

`tests/server.test.cjs` checks flags, saved settings, literal unit arguments, unmanaged-start refusal, active-runner refusal and denied lingering. `tests/documents.test.cjs` checks raster formats, pixels, metadata removal, malformed input, pixel bounds and cancellation. `tests/server-live.cjs` installs production dependencies and the pinned Linux tools into a private Linux copy, runs document/attachment checks with that copy's native dependencies, loads the generated service through a temporary runtime link, runs the real Node entry with fake native inference, and removes the service afterward. It verifies authentication, real file parsing, asynchronous submission/Stop, artifacts, preserved session authentication/conversation and forced restart. It changes no persistent service or lingering settings on the test account. `tests/runner-linux-live.cjs` separately exercises detached SIGTERM-resistant descendants and restart fencing.

Sources: `src/server.cjs`, `src/runner.cjs`, `src/runner-commands.cjs`, `src/runner-linux.cjs`, `src/documents.cjs`, `src/image-input.cjs`, `tools/linux-service.cjs`; pools `headless-server`, `background-runner`, `documents`, `remote-access` and `linux-service`.
