param([ValidateRange(67108864, 4294967296)][uint64]$LimitBytes)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# .NET calls only: a cmdlet such as Add-Type makes Windows PowerShell index every installed module first, which took
# 23-28 s per start on GitHub's windows-2022 runners without their prebuilt index (PSModuleAnalysisCachePath), 0.2 s this way.
[void][Reflection.Assembly]::LoadFrom([IO.Path]::Combine($PSScriptRoot, '..', 'tools', 'bin', 'document-job.dll'))

# One private job caps each document worker's committed memory, which includes pdf.js and canvas
# buffers outside the V8 heap. Closing this helper's handle kills any worker still inside.
$job = [DocumentJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new() }
$limits = [DocumentJob+ExtendedLimits]::new()
$basicLimits = [DocumentJob+BasicLimits]::new()
$basicLimits.LimitFlags = 0x2100 # JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
$limits.BasicLimitInformation = $basicLimits
$limits.ProcessMemoryLimit = [UIntPtr]::new($LimitBytes)
if (-not [DocumentJob]::SetInformationJobObject($job, 9, [ref]$limits, [Runtime.InteropServices.Marshal]::SizeOf($limits))) {
    throw [ComponentModel.Win32Exception]::new()
}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line -notmatch '^[1-9][0-9]{0,9}$') { exit 1 }
    # PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION
    $process = [DocumentJob]::OpenProcess(0x1101, $false, [uint32]$line)
    $inJob = $false
    if ($process -ne [IntPtr]::Zero) {
        if ([DocumentJob]::AssignProcessToJobObject($job, $process)) { [void][DocumentJob]::IsProcessInJob($process, $job, [ref]$inJob) }
        [void][DocumentJob]::CloseHandle($process)
    }
    [Console]::Out.WriteLine($(if ($inJob) { "limited:$line" } else { "failed:$line" }))
    [Console]::Out.Flush()
}
