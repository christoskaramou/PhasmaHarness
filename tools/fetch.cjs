// Downloads the pinned RTK and ripgrep builds from tools/manifest.json into tools/bin, verifying SHA256.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MANIFEST = require('./manifest.json');
const BIN = path.join(__dirname, 'bin');
const STAMP = path.join(BIN, 'installed.json');
const EXE = process.platform === 'win32' ? '.exe' : '';
// System32 bsdtar extracts zip; a Git-for-Windows GNU tar earlier on PATH cannot.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function find(directory, name) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const hit = entry.isDirectory() ? find(full, name) : entry.name === name && full;
    if (hit) return hit;
  }
}

async function install(name, build, target) {
  const response = await fetch(build.url);
  if (!response.ok) throw new Error(`${name}: download failed (HTTP ${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== build.sha256) throw new Error(`${name}: SHA256 mismatch, expected ${build.sha256}, got ${actual}.`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tools-'));
  try {
    const archive = path.join(work, path.basename(new URL(build.url).pathname));
    fs.writeFileSync(archive, data);
    execFileSync(TAR, ['-xf', archive, '-C', work], { stdio: 'ignore', windowsHide: true });
    const binary = find(work, name + EXE);
    if (!binary) throw new Error(`${name}: ${name + EXE} is missing from ${build.url}.`);
    fs.copyFileSync(binary, target);
    fs.chmodSync(target, 0o755);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

async function main() {
  const platform = `${process.platform}-${process.arch}`;
  fs.mkdirSync(BIN, { recursive: true });
  let stamp = {};
  try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch {}
  for (const [name, tool] of Object.entries(MANIFEST)) {
    const build = tool.builds[platform];
    if (!build) throw new Error(`No pinned ${name} build for ${platform}. Supported: ${Object.keys(tool.builds).join(', ')}.`);
    const target = path.join(BIN, name + EXE);
    if (stamp[name] !== build.sha256 || !fs.existsSync(target)) {
      console.log(`Installing ${name} ${tool.version} for ${platform}...`);
      await install(name, build, target);
      stamp[name] = build.sha256;
      fs.writeFileSync(STAMP, JSON.stringify(stamp, null, 2));
    }
    execFileSync(target, ['--version'], { stdio: 'ignore', windowsHide: true });
  }
  console.log(`Bundled tools ready in ${BIN}`);
}

main().catch(error => { console.error(error.message); process.exit(1); });
