const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const EXCLUDED = /(^|\/)(\.git|node_modules|third_party|vendor|dist|artifacts|build[^/]*|\.scratch)(\/|$)/i;
const PRIVATE = /(^|\/)(\.env(?:\..*)?|auth\.json|credentials[^/]*|secrets?[^/]*|id_rsa|id_ed25519)(\/|$)|\.(pem|key|pfx|p12)$/i;
const TEXT = /\.(c|cc|cpp|cxx|h|hpp|hxx|rs|cs|java|kt|swift|go|py|js|jsx|ts|tsx|mjs|cjs|lua|glsl|hlsl|vert|frag|wgsl|sql|sh|ps1|cmake|json|toml|yaml|yml|md|rst|txt|html|css)$/i;
const NATIVE = /\.(c|cc|cpp|cxx|h|hpp|hxx|rs)$/i;
const DOC = /\.(md|rst|txt)$/i;

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function signalsFor(filename, text) {
  const signals = [];
  if (NATIVE.test(filename)) signals.push('native-code');
  if (/\b(std::(?:atomic|mutex|thread|jthread)|lock_guard|unique_lock|pthread_\w+|memory_order_\w+|Interlocked\w*|Semaphore\w*|lock\s*\()/i.test(text) || /(?:^|\/)(?:thread|scheduler|concurrency|jobs?)[^/]*\./i.test(filename)) signals.push('concurrency');
  if (/\b(delete|free|malloc|realloc|unsafe|unique_ptr|shared_ptr|weak_ptr|DestroyBuffer|DestroyImage|vkFreeMemory|Release)\b/.test(text) || /(?:allocat|memory|lifetime|ownership)/i.test(filename)) signals.push('memory-lifetime');
  if (/\b(vk[A-Z]\w*|Vk[A-Z]\w*|ID3D12\w*|D3D12_\w*|PipelineBarrier|CommandQueue|Fence)\b/.test(text) || /(?:vulkan|dx12|d3d12|\/rhi\/)/i.test(filename)) signals.push('gpu-backend');
  if (/(?:auth|crypt|security|permission)/i.test(filename) || /\b(authoriz\w*|authenticat\w*|password|encrypt|decrypt)\b/i.test(text)) signals.push('security');
  if (/\b(DROP\s+TABLE|DELETE\s+FROM|BEGIN\s+TRANSACTION|fs\.rm|Remove-Item)\b/i.test(text) || /(?:migrat|database|persist|storage)/i.test(filename)) signals.push('data-integrity');
  return signals;
}

async function collectWorkspace(workspace, request, signal) {
  const result = { available: false, nativeProject: false, changedFiles: [], files: [], signals: [], coverage: 'unavailable', limitations: [] };
  if (!workspace) { result.limitations.push('No workspace supplied.'); return result; }
  const root = await fs.realpath(workspace).catch(() => null);
  if (!root) { result.limitations.push('Workspace cannot be read.'); return result; }
  const entries = await fs.readdir(root).catch(() => []);
  result.nativeProject = entries.some(name => /^(CMakeLists\.txt|Cargo\.toml)$|\.(sln|vcxproj)$/i.test(name));
  result.projectMarkers = entries.filter(name => /^(CMakeLists\.txt|Cargo\.toml|package\.json|pyproject\.toml|go\.mod)$|\.(sln|vcxproj)$/i.test(name)).slice(0, 12);
  const git = async args => {
    try {
      const { stdout } = await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
        cwd: root, windowsHide: true, encoding: 'utf8', timeout: 4000, maxBuffer: 512 * 1024, signal,
      });
      return stdout;
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('Routing stopped.'), { name: 'AbortError' });
      throw error;
    }
  };
  let gitRoot, status = '';
  try {
    gitRoot = (await git(['rev-parse', '--show-toplevel'])).trim();
    status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
    result.available = true;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    result.limitations.push('Git change inventory unavailable.');
  }
  const candidates = new Map();
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    const code = record.slice(0, 2), relative = record.slice(3);
    const filename = path.resolve(gitRoot, relative);
    if (/[RC]/.test(code)) i++; // Porcelain -z includes the original rename/copy path next.
    if (!inside(root, filename)) continue;
    const name = path.relative(root, filename).replace(/\\/g, '/');
    if (EXCLUDED.test(name) || PRIVATE.test(name)) { result.omittedFiles = (result.omittedFiles || 0) + 1; continue; }
    result.changedFiles.push({ path: name, status: code });
    if (TEXT.test(name)) candidates.set(name, { path: name, filename, status: code, explicit: false });
    else result.omittedFiles = (result.omittedFiles || 0) + 1;
  }
  // Only named, workspace-contained files are read in a clean tree. Never follow references outside it.
  const mentions = request.match(/(?:[A-Za-z]:[\\/])?[\w.@-]+(?:[\\/][\w.@-]+)*\.(?:cpp|cc|c|h|hpp|rs|cs|go|py|js|jsx|ts|tsx|lua|sql|md|json|toml|yaml|yml|html|css)\b/gi) || [];
  for (const mention of mentions.slice(0, 8)) {
    const filename = path.resolve(root, mention);
    if (!inside(root, filename)) continue;
    const name = path.relative(root, filename).replace(/\\/g, '/');
    if (EXCLUDED.test(name) || PRIVATE.test(name)) continue;
    candidates.set(name, { ...candidates.get(name), path: name, filename, explicit: true });
  }
  const names = [...candidates.keys()];
  result.nativeProject ||= names.some(name => NATIVE.test(name));
  const signals = new Set(names.flatMap(name => signalsFor(name, '')));
  const selected = [...candidates.values()].sort((a, b) => Number(b.explicit) - Number(a.explicit) || signalsFor(b.path, '').length - signalsFor(a.path, '').length).slice(0, 8);
  if (candidates.size > selected.length) result.limitations.push(`Only ${selected.length} of ${candidates.size} text files sampled.`);
  for (const file of selected) {
    signal?.throwIfAborted();
    try {
      let text = '', truncated = false;
      if (file.status && file.status !== '??') {
        // Disable repository-controlled external diff/textconv programs; cover staged AND unstaged changes.
        for (const cached of [true, false]) {
          const patch = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', ...(cached ? ['--cached'] : []), '--', file.path]);
          text += (cached ? 'STAGED\n' : 'UNSTAGED\n') + patch;
        }
      }
      if (!file.status || file.status === '??' || file.explicit) {
        const actual = await fs.realpath(file.filename);
        if (!inside(root, actual)) throw new Error('File points outside workspace.');
        const actualName = path.relative(root, actual).replace(/\\/g, '/');
        if (EXCLUDED.test(actualName) || PRIVATE.test(actualName)) throw new Error('File points to an excluded path.');
        const handle = await fs.open(actual, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('Not a regular file.');
          const buffer = Buffer.alloc(5000);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (buffer.subarray(0, bytesRead).includes(0)) throw new Error('Binary file.');
          text += '\nFILE\n' + buffer.subarray(0, bytesRead).toString('utf8');
          truncated = stat.size > bytesRead;
        } finally { await handle.close(); }
      }
      signalsFor(file.path, text).forEach(s => signals.add(s));
      const changes = text.split('\n').filter(line => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
      const commentsOnly = !!file.status && file.status !== '??' && !file.explicit && changes.length > 0 && changes.every(line => /^[-+]\s*(\/\/.*)?$/.test(line));
      truncated ||= text.length > 2400;
      result.files.push({ path: file.path, status: file.status || 'named', commentsOnly, truncated, text: text.slice(0, 2400) });
      if (truncated) result.limitations.push(`Excerpt truncated: ${file.path}`);
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('Routing stopped.'), { name: 'AbortError' });
      result.limitations.push(`Could not inspect ${file.path}.`);
    }
  }
  result.signals = [...signals];
  result.changedFileCount = result.changedFiles.length;
  result.changedFiles = result.changedFiles.slice(0, 60);
  if (result.changedFileCount > 60) result.limitations.push('Change list truncated to 60 paths.');
  result.mechanicalDiff = !result.omittedFiles && result.files.length > 0 && candidates.size === result.files.length && result.files.every(f => (DOC.test(f.path) && !/CMakeLists\.txt$/i.test(f.path)) || f.commentsOnly);
  if (result.omittedFiles) result.limitations.push(`${result.omittedFiles} private, generated, vendor or non-text paths omitted.`);
  if (!result.files.length) result.limitations.push('No source excerpts available; scope must be inferred conservatively.');
  result.coverage = result.available && result.limitations.length === 0 ? 'bounded' : result.files.length ? 'partial' : 'unavailable';
  return result;
}

module.exports = { collectWorkspace, signalsFor };
