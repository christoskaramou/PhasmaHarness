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
    foreach ($file in @('package.json', 'package-lock.json', 'src\main.cjs', 'src\worker-instructions.cjs', 'src\workspace\project-instructions.cjs', 'skills\workflow\SKILL.md', 'skills\caveman\SKILL.md', 'skills\ponytail\SKILL.md', 'skills\i-have-adhd\SKILL.md', 'skills\large-responses\SKILL.md', 'skills\large-responses\scripts\output.cjs', 'skills\rtk\SKILL.md', 'tools\fetch.cjs', 'tools\manifest.json', 'src\routing\benchmarks.cjs', 'benchmarks\snapshot.json', 'benchmarks\sources.json', 'benchmarks\REFRESH.md', 'Launch Phasma Harness.vbs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $folder $file))) {
            throw "Missing $file. Extract the entire app ZIP first, then run this installer inside that folder."
        }
    }
    if ($CheckOnly) { Write-Host 'PASS: installer payload and required app files.'; return }
    Set-Location -LiteralPath $folder
    $installerCache = Join-Path $folder 'installers'
    New-Item -ItemType Directory -Force -Path $installerCache | Out-Null
    $env:npm_config_cache = Join-Path $installerCache 'npm-cache'
    $env:ELECTRON_CACHE = Join-Path $installerCache 'electron-cache'
    function Refresh-Path {
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
    }
    function Test-Program($command, $probe = @('--version')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { return $false }
        try { & $command @probe *> $null; return $LASTEXITCODE -eq 0 } catch { return $false }
    }
    function Ensure-Program($command, $package, $probe = @('--version')) {
        if (Test-Program $command $probe) { return }
        if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
            throw 'Install Microsoft App Installer (winget) from Microsoft Store, then run this script again.'
        }
        Write-Host "Installing $package..."
        & winget.exe install --id $package --exact --source winget --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw "Installation of $package failed (exit $LASTEXITCODE)." }
        Refresh-Path
        if (-not (Test-Program $command $probe)) { throw "$package installed but $command is missing, shadowed, or not working. Check PATH and rerun." }
    }
    Ensure-Program node.exe OpenJS.NodeJS.LTS
    Ensure-Program git.exe Git.Git
    Write-Host 'Bundled helper MCP (project_context / tool helpers) is local to the app: Claude workers get it automatically; Cursor workers receive the same helper MCP over ACP; Codex/Responses use app-server dynamic tools. No separate MCP service setup.'
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
    Write-Host 'Installing locked app dependencies...'
    # Electron is a dev dependency; include it even with NODE_ENV=production.
    # Run its downloader explicitly instead of relying on npm lifecycle policy.
    & npm.cmd ci --include=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'App dependency installation failed.' }
    Write-Host 'Installing bundled tools (RTK, ripgrep)...'
    & node.exe (Join-Path $folder 'tools\fetch.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Bundled tool download or SHA256 check failed. Check the error above, then rerun.' }
    & node.exe (Join-Path $folder 'skills\large-responses\scripts\output.cjs') read (Join-Path $folder 'package.json') --count 1 *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Bundled large-response helper failed its smoke check.' }
    Write-Host 'Installing Electron runtime...'
    $electronInstaller = Join-Path $folder 'node_modules\electron\install.js'
    if (-not (Test-Path -LiteralPath $electronInstaller)) { throw 'Electron package is missing after npm ci. Check npm output above.' }
    & node.exe $electronInstaller
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime download failed. Check the download error above (network, proxy or antivirus), then rerun.' }
    $electron = Join-Path $folder 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electron)) { throw 'Electron was not downloaded. Check npm/network settings and rerun.' }
    $shell = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcut = $shell.CreateShortcut((Join-Path $desktop 'Phasma Harness.lnk'))
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $folder 'Launch Phasma Harness.vbs') + '"'
    $shortcut.WorkingDirectory = $folder
    $shortcut.IconLocation = "$electron,0"
    $shortcut.Save()
    Write-Host 'Setup complete. Install and sign in to Codex, Claude or Cursor from Settings > Providers; any one is enough. Jev is optional. Keep this app folder in place.'
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $folder 'Launch Phasma Harness.vbs') + '"') -WindowStyle Hidden
} catch {
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
