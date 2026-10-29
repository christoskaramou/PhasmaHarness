$ErrorActionPreference = 'Stop'

# .NET calls only, no cmdlets: a cmdlet makes Windows PowerShell index every installed module first (see document-job.ps1).
[void][Reflection.Assembly]::LoadFrom([IO.Path]::Combine($PSScriptRoot, '..', 'tools', 'bin', 'document-job.dll'))

# One job per worker process the app starts (process-tree.cjs, spawnOwned). Everything the worker starts joins its job,
# also processes whose parent exited, so ending the job stops all of them. No limits and no kill-on-close: a worker that
# ends normally keeps what it left running, as before; only Stop and Quit end a job.
$jobs = @{}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line -match '^add ([0-9a-f-]{36}/[0-9]+) ([1-9][0-9]{0,9})$') {
        $key = $Matches[1]
        $processId = [uint32]$Matches[2]
        # Jobs with no process left are closed first, so handles do not pile up over a long app run.
        foreach ($old in @($jobs.Keys)) {
            $info = [DocumentJob+Accounting]::new()
            $read = [DocumentJob]::QueryInformationJobObject($jobs[$old], 1, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info), [IntPtr]::Zero)
            if ($read -and $info.ActiveProcesses -eq 0) {
                [void][DocumentJob]::CloseHandle($jobs[$old])
                $jobs.Remove($old)
            }
        }

        $job = [DocumentJob]::CreateJobObject([IntPtr]::Zero, $null)
        # PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION
        $process = [DocumentJob]::OpenProcess(0x1101, $false, $processId)
        $added = $false
        if ($job -ne [IntPtr]::Zero -and $process -ne [IntPtr]::Zero) { $added = [DocumentJob]::AssignProcessToJobObject($job, $process) }
        if ($process -ne [IntPtr]::Zero) { [void][DocumentJob]::CloseHandle($process) }
        if ($added) { $jobs[$key] = $job } elseif ($job -ne [IntPtr]::Zero) { [void][DocumentJob]::CloseHandle($job) }
        [Console]::Out.WriteLine($(if ($added) { "added:$key" } else { "failed:$key" }))
    }
    elseif ($line -match '^stop ([0-9a-f-]{36}/[0-9]+)$') {
        $key = $Matches[1]
        $stopped = $jobs.ContainsKey($key) -and [DocumentJob]::TerminateJobObject($jobs[$key], 1)
        [Console]::Out.WriteLine($(if ($stopped) { "stopped:$key" } else { "none:$key" }))
    }
    elseif ($line -match '^holders ([A-Za-z]:\\[^\r\n]+\.output)$') {
        # Every process holding the file open, as pid@start (FILETIME), comma-separated; "holders:" alone for none.
        $session = [uint32]0
        $found = @()
        if ([DocumentJob]::RmStartSession([ref]$session, 0, [Text.StringBuilder]::new(64)) -eq 0) {
            if ([DocumentJob]::RmRegisterResources($session, 1, [string[]]@($Matches[1]), 0, [IntPtr]::Zero, 0, $null) -eq 0) {
                $needed = [uint32]0
                $count = [uint32]256
                $reasons = [uint32]0
                $list = [DocumentJob+ProcessInfo[]]::new(256)
                if ([DocumentJob]::RmGetList($session, [ref]$needed, [ref]$count, $list, [ref]$reasons) -eq 0) {
                    for ($i = 0; $i -lt $count; $i++) {
                        $p = $list[$i].Process
                        $found += '{0}@{1}' -f $p.ProcessId, (([uint64]$p.StartTimeHigh -shl 32) -bor $p.StartTimeLow)
                    }
                }
            }
            [void][DocumentJob]::RmEndSession($session)
        }
        [Console]::Out.WriteLine('holders:' + ($found -join ','))
    }
    elseif ($line -eq 'stopall') {
        foreach ($job in $jobs.Values) { [void][DocumentJob]::TerminateJobObject($job, 1) }
        [Console]::Out.WriteLine('stopped:all')
    }
    else { exit 1 }
    [Console]::Out.Flush()
}
