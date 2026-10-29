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

if [ "$mode" = headless ]; then
  echo 'Installing locked app dependencies and bundled tools (RTK, ripgrep)...'
  npm ci --omit=dev --no-audit --no-fund || fail "App dependency or bundled tool installation failed. Check the output above."
  echo 'Installing the runner service...'
  node tools/linux-service.cjs "${service_args[@]}" || fail "The service setup stopped. Check the message above."
  echo 'Install and sign in to the provider CLIs you want (Codex, Claude Code, Cursor) on this machine; any one is enough.'
  exit 0
fi

# Replacing node_modules under a running window breaks it, so a running copy of this folder is closed first.
if pgrep -f -- "$folder/node_modules/electron/dist/electron" >/dev/null; then
  fail "Phasma Harness is running from this folder. Quit it (tray icon, Quit runner), then run this again."
fi

echo 'Installing locked app dependencies...'
# Electron is a dev dependency; its download runs explicitly below instead of through npm lifecycle scripts.
npm ci --include=dev --ignore-scripts --no-audit --no-fund || fail "App dependency installation failed."
echo 'Installing bundled tools (RTK, ripgrep)...'
node tools/fetch.cjs || fail "Bundled tool download or SHA256 check failed. Check the error above, then rerun."
node skills/large-responses/scripts/output.cjs read package.json --count 1 >/dev/null || fail "Bundled large-response helper failed its smoke check."
echo 'Installing Electron runtime...'
node node_modules/electron/install.js || fail "Electron runtime download failed. Check the error above (network or proxy), then rerun."
electron="$folder/node_modules/electron/dist/electron"
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
echo 'Install and sign in to Codex, Claude or Cursor from Settings > Providers; any one is enough. Keep this app folder in place.'
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  nohup "$launcher" >/dev/null 2>&1 &
fi
