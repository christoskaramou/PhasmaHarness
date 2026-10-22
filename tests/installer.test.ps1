$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\Install Phasma Harness.cmd'))
$source = $source.Substring($source.LastIndexOf('# POWERSHELL START'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ensure-Program' }, $true)
. ([scriptblock]::Create($definition.Extent.Text))

# Exercise the real install decision with fake commands; no machine changes.
function Test-Program($command, $probe) { $script:probes++; return $script:working -or ($script:installed -and $script:worksAfter) }
function Get-Command { [CmdletBinding()]param($Name) if ($script:wingetAvailable) { return 'fake-winget' } }
function Refresh-Path { $script:refreshed = $true }
function winget.exe {
    $script:installArgs = $args
    $script:installed = $true
    $global:LASTEXITCODE = $script:installExit
}
function Reset-Case {
    $script:working = $false; $script:installed = $false; $script:worksAfter = $true
    $script:wingetAvailable = $true; $script:installExit = 0; $script:probes = 0
    $script:refreshed = $false; $script:installArgs = @()
}
function Expect-Failure($pattern) {
    try { Ensure-Program git.exe Git.Git @('--version') }
    catch { if ($_.Exception.Message -match $pattern) { return }; throw }
    throw 'Expected installer failure.'
}
Reset-Case
$script:working = $true
Ensure-Program git.exe Git.Git
if ($script:installed) { throw 'Working installations must be preserved.' }
Reset-Case
Ensure-Program git.exe Git.Git @('--version')
if (-not $script:installed -or -not $script:refreshed -or $script:probes -ne 2) { throw 'Missing tool was not installed and rechecked.' }
if (($script:installArgs -join ' ') -notmatch '--id Git.Git --exact --source winget') { throw 'Wrong package/source.' }
Reset-Case; $script:installExit = 1; Expect-Failure 'Installation .* failed'
Reset-Case; $script:worksAfter = $false; Expect-Failure 'missing, shadowed, or not working'
Reset-Case; $script:wingetAvailable = $false; Expect-Failure 'App Installer'

Remove-Item function:Get-Command
. (Join-Path $PSScriptRoot '..\src\install-preflight.ps1')
$harnessFolder = 'C:\App with spaces'
$harness = Join-Path $harnessFolder 'node_modules\electron\dist\electron.exe'
# Verify the real launch arguments and inherited Node mode, without launching the user's app.
$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
    if ($FilePath -ne $harness -or $WorkingDirectory -ne $harnessFolder -or $WindowStyle -ne 'Hidden' -or -not $PassThru) { throw 'Wrong shutdown process.' }
    if ($ArgumentList -ne ('"' + $harnessFolder + '" --quit-for-install') -or $env:ELECTRON_RUN_AS_NODE) { throw 'Shutdown must run Electron, with a quoted app path.' }
    if ($script:launchFailure) { throw 'fixture launch failure' }
}
try {
    Request-HarnessQuit $harnessFolder $harness
    if ($env:ELECTRON_RUN_AS_NODE -ne '1') { throw 'Node mode was not restored.' }
    $script:launchFailure = $true
    try { Request-HarnessQuit $harnessFolder $harness; throw 'Expected launch failure.' }
    catch { if ($_.Exception.Message -ne 'fixture launch failure') { throw } }
    if ($env:ELECTRON_RUN_AS_NODE -ne '1') { throw 'Failed launch did not restore Node mode.' }
} finally { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode; Remove-Item function:Start-Process }

function Get-CimInstance {
    [CmdletBinding()]param($ClassName, $Filter)
    if ($script:scanFailure) { throw 'fixture scan failure' }
    $script:scans++
    if ($script:running -gt 0) { [pscustomobject]@{ ExecutablePath = $harness.ToUpper(); ProcessId = 123 } }
    [pscustomobject]@{ ExecutablePath = 'C:\Other\electron.exe'; ProcessId = 999 }
}
function Request-HarnessQuit {
    $script:requests++
    $request = [pscustomobject]@{ HasExited = $true }
    $request | Add-Member ScriptMethod Dispose { $script:disposed = $true }
    return $request
}
function Start-Sleep {
    param($Milliseconds)
    $script:running--
    if ($script:releaseOnWait) { $script:held.Dispose(); $script:releaseOnWait = $false }
}
function Expect-PreflightFailure($folder, $pattern) {
    try { Wait-HarnessClosed $folder 0 }
    catch { if ($_.Exception.Message -match $pattern) { return }; throw }
    throw 'A blocked preflight must fail before dependency installation.'
}
$script:scans = 0; $script:requests = 0; $script:running = 0
Wait-HarnessClosed $harnessFolder
if ($script:requests -ne 0) { throw 'Closed Harness or another Electron app must not be sent a shutdown request.' }
$script:running = 3
Wait-HarnessClosed $harnessFolder
if ($script:requests -ne 1 -or -not $script:disposed -or $script:running -ne 0) { throw 'Request shutdown once, then wait until every matching process exits.' }
$script:running = 1
Expect-PreflightFailure $harnessFolder 'did not finish shutting down.*123.*Older running versions'
$script:scanFailure = $true
Expect-PreflightFailure $harnessFolder 'fixture scan failure'
$script:scanFailure = $false; $script:running = 0

# Real Windows locks: a failure must leave all dependency contents untouched; delayed release proceeds.
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('harness-install-test-' + [guid]::NewGuid())
$dependencies = Join-Path $fixture 'node_modules'
New-Item -ItemType Directory -Path $dependencies | Out-Null
$file = Join-Path $dependencies 'held.txt'
[IO.File]::WriteAllText($file, 'preserved dependency')
try {
    $script:held = [IO.File]::Open($file, 'Open', 'ReadWrite', 'None')
    Expect-PreflightFailure $fixture 'Dependencies are still in use.*held.txt.*No dependencies were changed'
    $script:releaseOnWait = $true
    Wait-HarnessClosed $fixture
    if ([IO.File]::ReadAllText($file) -ne 'preserved dependency') { throw 'Preflight modified a dependency.' }
    $watcher = New-Object IO.FileSystemWatcher $dependencies
    $reader = [IO.File]::Open($file, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $watcher.EnableRaisingEvents = $true
        if ([PhasmaInstallFiles]::Blocker($dependencies)) { throw 'Delete-compatible editor watchers and readers must not block installation.' }
    } finally { $watcher.Dispose(); $reader.Dispose() }
    # Mapped binaries need a write probe: an ordinary read handle does not detect this lock.
    $binary = Join-Path $dependencies 'mapped.exe'
    Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\where.exe') -Destination $binary
    $mapping = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($binary, [IO.FileMode]::Open, ('harness-install-' + [guid]::NewGuid()), 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
    try {
        if (-not [PhasmaInstallFiles]::Blocker($binary)) { throw 'Mapped binary was not detected.' }
    } finally { $mapping.Dispose() }
    Wait-HarnessClosed $fixture
    $previousDirectory = [Environment]::CurrentDirectory
    try {
        [Environment]::CurrentDirectory = $dependencies
        Expect-PreflightFailure $fixture 'Dependencies are still in use.*node_modules'
    } finally { [Environment]::CurrentDirectory = $previousDirectory }
    # Junctions are removed as links by npm; do not inspect or disturb their external targets.
    $target = Join-Path $fixture 'external'
    New-Item -ItemType Directory -Path $target | Out-Null
    $externalFile = Join-Path $target 'external.txt'
    [IO.File]::WriteAllText($externalFile, 'external data')
    $link = Join-Path $dependencies 'linked-package'
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    $externalHandle = [IO.File]::Open($externalFile, 'Open', 'ReadWrite', 'None')
    try { Wait-HarnessClosed $fixture }
    finally { $externalHandle.Dispose(); [IO.Directory]::Delete($link) }
    if ([IO.File]::ReadAllText($externalFile) -ne 'external data') { throw 'External link target was modified.' }
} finally {
    if ($script:held) { $script:held.Dispose() }
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'harness-install-test-*') { throw 'Unsafe fixture cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
if ($source.IndexOf('Wait-HarnessClosed $folder') -gt $source.IndexOf('& npm.cmd ci') -or $source.IndexOf('Wait-HarnessClosed $folder') -lt 0) { throw 'Preflight must precede destructive npm ci.' }
Write-Host 'PASS: installer syntax, dependencies, automatic shutdown, timeout, unrelated apps, inherited Node mode and real file-lock release.'
