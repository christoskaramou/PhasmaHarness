#!/usr/bin/env bash
# Phasma Harness source installer for Linux, the counterpart of "Install Phasma Harness.cmd" (src/install.ps1).
#   ./install-linux.sh               the desktop app: dependencies, bundled tools, Electron, a menu entry and a
#                                    phasma-harness command, then it starts
#   ./install-linux.sh --headless    the runner as a systemd user service, no display (docs/wiki/hosting.md); --origin,
#                                    --port and --data go to tools/linux-service.cjs
#   ./install-linux.sh --check-only  checks the app files and exits
# A missing or too old Node.js is installed for this user only, into installers/node (the nodejs.org build, checked
# against its SHA-256 list). Only a missing Git and Electron's sandbox helper on distros that block user namespaces
# (Ubuntu 24.04 and later) need sudo.
set -euo pipefail

folder="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node_dir="$folder/installers/node"

fail() {
  echo "Setup failed: $*" >&2
  exit 1
}

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

mode=desktop
service_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --headless) mode=headless ;;
    --check-only) mode=check ;;
    --origin|--port|--data)
      [ $# -ge 2 ] || fail "$1 needs a value."
      service_args+=("$1" "$2")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "Unknown option $1 (see --help)." ;;
  esac
  shift
done

[ "$mode" = headless ] || [ ${#service_args[@]} -eq 0 ] || fail "--origin, --port and --data are for --headless."

for file in package.json package-lock.json src/main.cjs src/server.cjs tools/fetch.cjs tools/manifest.json \
  tools/linux-service.cjs benchmarks/snapshot.json skills/large-responses/scripts/output.cjs ui/icon-512.png; do
  [ -e "$folder/$file" ] || fail "Missing $file. Use a complete checkout or the whole source archive, then run this inside it."
done
if [ "$mode" = check ]; then
  echo 'PASS: installer payload and required app files.'
  exit 0
fi

[ "$(uname -s)" = Linux ] || fail "This installer is for Linux. On Windows, run \"Install Phasma Harness.cmd\"."
[ "$(id -u)" -ne 0 ] || fail "Run this as your regular user, not root."
command -v git >/dev/null || fail "Git is missing. Install it (Debian/Ubuntu: sudo apt install git), then run this again."

# Node.js: desktop needs 22.13 or newer (README), the headless runner 24 or newer (tools/linux-service.cjs).
if [ "$mode" = headless ]; then
  need_major=24
  need_minor=0
else
  need_major=22
  need_minor=13
fi
[ -x "$node_dir/bin/node" ] && export PATH="$node_dir/bin:$PATH"

node_ok() {
  command -v node >/dev/null && command -v npm >/dev/null &&
    node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > $need_major || (a === $need_major && b >= $need_minor) ? 0 : 1)"
}

install_node() {
  local arch
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "No Node.js build for $(uname -m). Install Node.js $need_major yourself, then run this again." ;;
  esac
  for tool in curl tar xz sha256sum; do
    command -v "$tool" >/dev/null || fail "$tool is needed to download Node.js. Install it or Node.js $need_major, then run this again."
  done

  local base="https://nodejs.org/dist/latest-v$need_major.x" file
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  echo "Installing Node.js $need_major for this user into $node_dir..."
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt" || fail "Could not reach nodejs.org."
  file="$(grep -o "node-v[0-9.]*-linux-$arch\.tar\.xz" "$work/SHASUMS256.txt" | head -n 1)"
  [ -n "$file" ] || fail "nodejs.org lists no Linux $arch build of Node.js $need_major."
  curl -fsSL "$base/$file" -o "$work/$file" || fail "The Node.js download failed."
  (cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || fail "The Node.js download failed its SHA-256 check."

  rm -rf "$node_dir"
  mkdir -p "$node_dir"
  tar -xJf "$work/$file" -C "$node_dir" --strip-components=1
  export PATH="$node_dir/bin:$PATH"
  node_ok || fail "Node.js was installed but does not run. Check $node_dir."
}

node_ok || install_node
cd "$folder"
export npm_config_cache="$folder/installers/npm-cache"
export ELECTRON_CACHE="$folder/installers/electron-cache"
providers='Codex, Claude, Cursor, DeepSeek, Muse or Antigravity, or add an API provider (OpenRouter, LM Studio or any OpenAI-compatible endpoint); any one of these is enough. Jev is optional: its key adds Jev routing and Jev image assist.'
# Image attachments and Jev image assist decode and resize images with this native library.
check_images() {
  node -e "require('@napi-rs/canvas').createCanvas(2, 2).encodeSync('png')" >/dev/null 2>&1 ||
    fail "The image library (@napi-rs/canvas) did not load, so image attachments would fail. Check the npm output above, then rerun."
}

if [ "$mode" = headless ]; then
  echo 'Installing locked app dependencies and bundled tools (RTK, ripgrep)...'
  npm ci --omit=dev --no-audit --no-fund || fail "App dependency or bundled tool installation failed. Check the output above."
  check_images
  echo 'Installing the runner service...'
  node tools/linux-service.cjs "${service_args[@]}" || fail "The service setup stopped. Check the message above."
  echo "From Settings > Providers (CLIs on this machine), install and sign in to $providers"
  exit 0
fi

# Replacing node_modules under a running window breaks it, so a running copy of this folder is closed first: the same
# --quit-for-install handoff as Windows (src/install-preflight.ps1), which lets the runner end its workers, then SIGTERM
# and SIGKILL only if it outlasts the wait. Stopped: this user's processes whose executable is in this folder's Electron,
# and the workers they started (each carries PHASMA_HARNESS_OWNER=<run>/<n>, src/process-tree.cjs), even once detached.
# This setup, its parent shells and its own children are never stopped, even when it runs inside a Harness terminal.
electron="$folder/node_modules/electron/dist/electron"
electron_dist="$(readlink -f "$folder/node_modules/electron/dist" 2>/dev/null || true)"
user_data="${XDG_CONFIG_HOME:-$HOME/.config}/Phasma Harness"
runs=' '
ppid_of() {
  local stat
  { read -r stat < "/proc/$1/stat"; } 2>/dev/null || return 0
  stat="${stat##*) }"
  stat="${stat#* }"
  echo "${stat%% *}"
}
spared=" $$ "
p="$PPID"
while [ "${p:-0}" -gt 1 ]; do
  spared+="$p "
  p="$(ppid_of "$p")"
done
# Prints the pids from stdin that still run and are not this setup, a parent of it, or one of its children.
not_setup() {
  local pid p _
  while read -r pid; do
    case "$spared" in *" $pid "*) continue ;; esac
    [ -e "/proc/$pid" ] || continue
    p="$pid"
    for _ in 1 2 3 4 5 6 7 8; do
      p="$(ppid_of "$p")"
      [ -n "$p" ] && [ "$p" -gt 1 ] || break
      [ "$p" = "$$" ] && continue 2
    done
    echo "$pid"
  done
}
electron_pids() {
  [ -n "$electron_dist" ] || return 0
  find /proc/[0-9]*/exe -maxdepth 0 -lname "$electron_dist/*" 2>/dev/null | cut -d/ -f3 | not_setup
}
# Remembers the run id of every worker started by this folder's Electron, so its workers stay found after the app ends.
refresh_runs() {
  local apps file pid run
  apps=" $(electron_pids | tr '\n' ' ') "
  [ "$apps" != '  ' ] || return 0
  for file in $(grep -laF 'PHASMA_HARNESS_OWNER=' /proc/[0-9]*/environ 2>/dev/null); do
    pid="${file#/proc/}"
    pid="${pid%/environ}"
    case "$apps" in *" $(ppid_of "$pid") "*) ;; *) continue ;; esac
    run="$(tr '\0' '\n' < "$file" 2>/dev/null | sed -n 's|^PHASMA_HARNESS_OWNER=\([^/]*\)/.*|\1|p')"
    case "$runs" in *" $run "*) ;; *) [ -z "$run" ] || runs+="$run " ;; esac
  done
}
harness_pids() {
  local run
  {
    electron_pids
    for run in $runs; do
      grep -laF "PHASMA_HARNESS_OWNER=$run/" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3 | not_setup
    done
  } | sort -un
}
# Processes with files open in the app's data folder (the old app's profile, caches and logs).
data_holders() {
  local data
  data="$(readlink -f "$user_data" 2>/dev/null)" && [ -d "$data" ] || return 0
  find /proc/[0-9]*/fd -mindepth 1 -maxdepth 1 -lname "$data/*" 2>/dev/null | cut -d/ -f3 | sort -un | not_setup
}
wait_closed() { # $1 seconds
  local end=$((SECONDS + $1))
  while refresh_runs; [ -n "$(harness_pids)$(data_holders)" ]; do
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 0.5
  done
}
refresh_runs
if [ -n "$(harness_pids)" ]; then
  echo 'Stopping Phasma Harness and its workers...'
  timeout 30 env -u ELECTRON_RUN_AS_NODE "$electron" "$folder" --quit-for-install >/dev/null 2>&1 || true
  if ! wait_closed 45; then
    if [ -n "$(harness_pids)" ]; then
      echo 'Phasma Harness did not quit within 45 seconds; ending its processes.'
      # shellcheck disable=SC2046 # one argument per process id
      kill -TERM $(harness_pids) 2>/dev/null || true
      wait_closed 10 || {
        # shellcheck disable=SC2046
        kill -KILL $(harness_pids) 2>/dev/null || true
        wait_closed 5
      } || true
    fi
    [ -z "$(harness_pids)" ] || fail "Phasma Harness processes $(harness_pids | tr '\n' ' ')did not end. Quit it (tray icon, Quit runner), then run this again. No dependencies were changed."
    [ -z "$(data_holders)" ] || fail "Processes $(data_holders | tr '\n' ' ')still have files open in $user_data. Close them, then run this again. No dependencies were changed."
  fi
fi

echo 'Installing locked app dependencies...'
# Electron is a dev dependency; its download runs explicitly below instead of through npm lifecycle scripts.
npm ci --include=dev --ignore-scripts --no-audit --no-fund || fail "App dependency installation failed."
check_images
echo 'Installing bundled tools (RTK, ripgrep)...'
node tools/fetch.cjs || fail "Bundled tool download or SHA256 check failed. Check the error above, then rerun."
node skills/large-responses/scripts/output.cjs read package.json --count 1 >/dev/null || fail "Bundled large-response helper failed its smoke check."
echo 'Installing Electron runtime...'
node node_modules/electron/install.js || fail "Electron runtime download failed. Check the error above (network or proxy), then rerun."
[ -x "$electron" ] || fail "Electron was not downloaded. Check npm and network settings, then rerun."

# Electron's sandbox needs user namespaces; where the distro blocks them, its setuid helper does the job, as Electron's
# own .deb packages set it up.
sandbox="$folder/node_modules/electron/dist/chrome-sandbox"
if ! unshare --user --map-root-user true 2>/dev/null && [ ! -u "$sandbox" ]; then
  echo "This system blocks user namespaces, so Electron's sandbox helper needs root ownership (sudo asks for your password)."
  sudo chown root:root "$sandbox" && sudo chmod 4755 "$sandbox" ||
    fail "Could not set up Electron's sandbox helper. Run: sudo chown root:root '$sandbox' && sudo chmod 4755 '$sandbox'"
fi

launcher="$HOME/.local/bin/phasma-harness"
mkdir -p "$(dirname "$launcher")" "$HOME/.local/share/applications"
{
  echo '#!/usr/bin/env bash'
  # A Node.js installed here stays first on PATH, so Settings > Providers can install CLIs with its npm.
  [ -x "$node_dir/bin/node" ] && printf 'export PATH=%q:"$PATH"\n' "$node_dir/bin"
  printf 'exec %q %q "$@"\n' "$electron" "$folder"
} > "$launcher"
chmod 755 "$launcher"
cat > "$HOME/.local/share/applications/phasma-harness.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Phasma Harness
Comment=Local desktop client for coding agents
Exec="$launcher"
Icon=$folder/ui/icon-512.png
Terminal=false
Categories=Development;
EOF

echo "Setup complete. Start it from your app menu or with: $launcher"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add $HOME/.local/bin to PATH to start it as phasma-harness." ;;
esac
echo 'Harness tools (project context, bots, connectors, images, settings) come from a local MCP server the app starts itself: Codex, Claude, Cursor and the native CLIs connect to it, and API models get the same tools inside Harness. Nothing to set up.'
echo "From Settings > Providers, install and sign in to $providers Keep this app folder in place."
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  nohup "$launcher" >/dev/null 2>&1 &
fi
