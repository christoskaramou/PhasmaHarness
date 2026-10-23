// Compile during dependency setup, source startup or packaging, never inside a document read.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function buildDocumentJob() {
  if (process.platform !== 'win32') return;
  const source = path.join(__dirname, '../src/document-job.cs'), output = path.join(__dirname, 'bin/document-job.dll');
  const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (fs.existsSync(output) && fs.existsSync(output + '.source') && fs.readFileSync(output + '.source', 'utf8') === hash) return;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const temporary = output + '.tmp.dll';
  try {
    execFileSync(compiler, ['/nologo', '/target:library', '/optimize+', '/out:' + temporary, source], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
    fs.renameSync(temporary, output);
    fs.writeFileSync(output + '.source', hash);
  } catch (error) {
    throw new Error('Document memory limiter build failed: ' + (error.stdout?.toString().trim() || error.message));
  } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { buildDocumentJob };
if (require.main === module) buildDocumentJob();
