@echo off
setlocal
set "ROUTER_INSTALLER_PATH=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:ROUTER_INSTALLER_PATH); & ([scriptblock]::Create($s.Substring($s.LastIndexOf('# POWERSHELL START'))))"
set "result=%errorlevel%"
if not "%result%"=="0" echo Installation did not complete. See the error above.
pause
exit /b %result%
# POWERSHELL START
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
try {
    $folder = Split-Path -LiteralPath $env:ROUTER_INSTALLER_PATH
    foreach ($file in @('package.json', 'package-lock.json', 'main.cjs', 'benchmarks.cjs', 'benchmarks\snapshot.json', 'benchmarks\sources.json', 'benchmarks\REFRESH.md', 'Launch Phasma Harness.vbs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $folder $file))) {
            throw "Missing $file. Extract the entire app ZIP first, then run this installer inside that folder."
        }
    }
    if ($CheckOnly) { Write-Host 'PASS: installer payload and required app files.'; return }
    Set-Location -LiteralPath $folder
    function Refresh-Path {
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
    }
    function Ensure-Program($command, $package) {
        if (Get-Command $command -ErrorAction SilentlyContinue) { return }
        if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
            throw 'Install Microsoft App Installer (winget) from Microsoft Store, then run this script again.'
        }
        Write-Host "Installing $package..."
        & winget.exe install --id $package --exact --source winget --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw "Installation of $package failed (exit $LASTEXITCODE)." }
        Refresh-Path
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$package installed but is not on PATH. Open the installer again after signing out and back in." }
    }
    Ensure-Program node.exe OpenJS.NodeJS.LTS
    Ensure-Program git.exe Git.Git
    $claudeNative = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (-not (Test-Path -LiteralPath $claudeNative) -and -not (Get-Command claude.exe -ErrorAction SilentlyContinue)) {
        Ensure-Program claude.exe Anthropic.ClaudeCode
    }
    Write-Host 'Claude Code available. Sign in with your own account in app Settings.'
    $cursorLauncher = Join-Path $env:LOCALAPPDATA 'cursor-agent\cursor-agent.ps1'
    if (-not (Test-Path -LiteralPath $cursorLauncher)) {
        Write-Host 'Installing official Cursor CLI...'
        & ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://cursor.com/install?win32=true')))
        if (-not (Test-Path -LiteralPath $cursorLauncher)) { throw 'Cursor CLI installation did not complete. Check the installer output and retry.' }
        Refresh-Path
    }
    Write-Host 'Cursor CLI available. Sign in with your own Cursor account in app Settings.'
    Write-Host 'Bundled helper MCP (project_context / tool helpers) is local to the app: Claude workers get it automatically; Cursor ACP helper MCP remains unsupported until Cursor connects session MCP; Codex/Responses use app-server dynamic tools. No separate MCP service setup.'
    & node.exe -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Updating Node.js to the current LTS...'
        & winget.exe install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw 'Node.js update failed. Check the installer output above.' }
        Refresh-Path
        & node.exe -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"
        if ($LASTEXITCODE -ne 0) { throw 'An older Node.js still takes priority on PATH. Restart Windows and run this installer again.' }
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm is missing. Repair the Node.js installation, then rerun this installer.' }
    # Minimum tested app-server version; preserve newer installations.
    $minimumCodexVersion = [version]'0.153.4'
    function Get-RouterCodexVersion {
        $reported = & node.exe -e "const {spawnSync}=require('node:child_process');try{const c=require('./codex.cjs').findCodex();const r=spawnSync(c.command,[...c.args,'--version'],{encoding:'utf8',windowsHide:true});if(r.status!==0)process.exit(1);process.stdout.write(r.stdout)}catch{process.exit(1)}"
        if ($LASTEXITCODE -ne 0) { return $null }
        if (($reported -join ' ') -match '^codex-cli\s+(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?\s*$') { return [version]$Matches[1] }
        return $null
    }
    $installedCodexVersion = Get-RouterCodexVersion
    if ($null -eq $installedCodexVersion -or $installedCodexVersion -lt $minimumCodexVersion) {
        Write-Host 'Installing tested Codex CLI 0.153.4...'
        & npm.cmd install --global '@openai/codex@0.153.4'
        if ($LASTEXITCODE -ne 0) { throw 'Codex CLI installation failed.' }
        Refresh-Path
        $prefix = (& npm.cmd prefix --global | Select-Object -Last 1)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the npm global installation.' }
        $env:Path = "$prefix;$env:Path"
        $installedCodexVersion = Get-RouterCodexVersion
        if ($null -eq $installedCodexVersion -or $installedCodexVersion -lt $minimumCodexVersion) {
            throw "Codex CLI $minimumCodexVersion or newer is required. The app still resolves an older or unreadable installation; check npm and PATH."
        }
    }
    Write-Host "Using Codex CLI $installedCodexVersion (minimum $minimumCodexVersion)."
    Write-Host 'Installing locked app dependencies...'
    # Electron is a dev dependency; include it even with NODE_ENV=production.
    # Run its downloader explicitly instead of relying on npm lifecycle policy.
    & npm.cmd ci --include=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'App dependency installation failed.' }
    Write-Host 'Installing Electron runtime...'
    $electronInstaller = Join-Path $folder 'node_modules\electron\install.js'
    if (-not (Test-Path -LiteralPath $electronInstaller)) { throw 'Electron package is missing after npm ci. Check npm output above.' }
    & node.exe $electronInstaller
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime download failed. Check the download error above (network, proxy or antivirus), then rerun.' }
    $electron = Join-Path $folder 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electron)) { throw 'Electron was not downloaded. Check npm/network settings and rerun.' }
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
        & node.exe -e "const {spawnSync}=require('node:child_process');const c=require('./codex.cjs').findCodex();const run=args=>spawnSync(c.command,[...c.args,...args],{stdio:'inherit',windowsHide:true});if(run(['login','status']).status!==0)console.log('Connect ChatGPT or add an API provider in app Settings.')"
        if ($LASTEXITCODE -ne 0) { throw 'Sign-in was not completed. Run this installer again to finish.' }
        & $electron -e "const {CodexClient}=require('./codex.cjs'); const c=new CodexClient(process.cwd()); (async()=>{try{await c.start();await c.call('model/list');console.log('Codex app-server connection OK.')}finally{c.close(true)}})().catch(e=>{console.error(e.message);process.exitCode=1})"
        if ($LASTEXITCODE -ne 0) { throw 'Codex app-server compatibility check failed. Check the installed Codex CLI before launching.' }
    } finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    $shell = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcut = $shell.CreateShortcut((Join-Path $desktop 'Phasma Harness.lnk'))
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $folder 'Launch Phasma Harness.vbs') + '"'
    $shortcut.WorkingDirectory = $folder
    $shortcut.IconLocation = "$electron,0"
    $shortcut.Save()
    Write-Host 'Setup complete. Jev is optional; add your own key in Settings to enable it. Keep this app folder in place.'
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $folder 'Launch Phasma Harness.vbs') + '"') -WindowStyle Hidden
} catch {
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
