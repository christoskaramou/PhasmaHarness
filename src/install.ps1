# Phasma Harness source installer, run by "Install Phasma Harness.cmd" with powershell.exe -File.
# It lives in its own file because antivirus heuristics treat a .cmd that reads its own text and runs it as a
# PowerShell script as a dropper: Bitdefender blocked that launcher as CMD:Heur.BZC.Boxter on 2026-10-28.
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
try {
    $folder = Split-Path -LiteralPath $PSScriptRoot
    foreach ($file in @('package.json', 'package-lock.json', 'src\main.cjs', 'src\install-preflight.ps1', 'src\worker-instructions.cjs', 'src\workspace\project-instructions.cjs', 'skills\workflow\SKILL.md', 'skills\caveman\SKILL.md', 'skills\ponytail\SKILL.md', 'skills\i-have-adhd\SKILL.md', 'skills\large-responses\SKILL.md', 'skills\large-responses\scripts\output.cjs', 'skills\rtk\SKILL.md', 'tools\fetch.cjs', 'tools\manifest.json', 'src\routing\benchmarks.cjs', 'benchmarks\snapshot.json', 'benchmarks\sources.json', 'benchmarks\REFRESH.md', 'Launch Phasma Harness.vbs')) {
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
    . (Join-Path $folder 'src\install-preflight.ps1')
    Wait-HarnessClosed $folder
    Write-Host 'Installing locked app dependencies...'
    # Electron is a dev dependency; include it even with NODE_ENV=production.
    # Run its downloader explicitly instead of relying on npm lifecycle policy.
    & npm.cmd ci --include=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'App dependency installation failed.' }
    # Image attachments and Jev image assist decode and resize images with this native library.
    & node.exe -e "require('@napi-rs/canvas').createCanvas(2, 2).encodeSync('png')" *> $null
    if ($LASTEXITCODE -ne 0) { throw 'The image library (@napi-rs/canvas) did not load, so image attachments would fail. Check the npm output above, then rerun.' }
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
    # A Desktop shortcut and a Start menu entry (this user's Programs folder), both starting the app the same way.
    foreach ($place in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
        $shortcut = $shell.CreateShortcut((Join-Path $place 'Phasma Harness.lnk'))
        $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $shortcut.Arguments = '"' + (Join-Path $folder 'Launch Phasma Harness.vbs') + '"'
        $shortcut.WorkingDirectory = $folder
        $shortcut.IconLocation = (Join-Path $folder 'ui\icon.ico') + ',0'
        $shortcut.Save()
    }
    Write-Host 'Harness tools (project context, bots, connectors, images, settings) come from a local MCP server the app starts itself: Codex, Claude, Cursor and the native CLIs connect to it, and API models get the same tools inside Harness. Nothing to set up.'
    Write-Host 'Setup complete. From Settings > Providers, install and sign in to Codex, Claude, Cursor or DeepSeek, or add an API provider (OpenRouter, LM Studio or any OpenAI-compatible endpoint); any one of these is enough. Muse and Antigravity work as bots but cannot run the Hub on their own. Jev is optional: its key adds Jev routing and Jev image assist. The app is in your Start menu and on your Desktop; keep this app folder in place.'
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $folder 'Launch Phasma Harness.vbs') + '"') -WindowStyle Hidden
} catch {
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
