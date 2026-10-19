param(
    [uint32]$RunnerPid,
    [ValidatePattern('^phasma-harness-runner-[a-f0-9-]{36}$')][string]$PipeName,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$JobName
)

$ErrorActionPreference = 'Stop'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $PSHOME 'powershell.exe'
$start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    (Join-Path $PSScriptRoot 'runner-job.ps1') + '" -RunnerPid ' + $RunnerPid + ' -PipeName ' + $PipeName + ' -JobName ' + $JobName
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$monitor = [Diagnostics.Process]::Start($start)
[Console]::WriteLine('started:' + $monitor.Id)
