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
Write-Host 'PASS: installer syntax and five dependency-install scenarios (no system changes).'
