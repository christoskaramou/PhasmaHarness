param([uint32]$RunnerPid, [string]$PipeName, [ValidatePattern('^[a-f0-9]{64}$')][string]$JobName)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HarnessJob
{
    [StructLayout(LayoutKind.Sequential)]
    public struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ExtendedLimits
    {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Accounting
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodUserTime;
        public long ThisPeriodKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        ref ExtendedLimits information, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
        out Accounting information, uint size, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

$job = [IntPtr]::Zero
$runnerHandle = [IntPtr]::Zero
$installer = $null
$control = $null
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ($true) {
        $job = [HarnessJob]::CreateJobObject([IntPtr]::Zero, ('Global\PhasmaHarness-' + $JobName))
        if ($job -eq [IntPtr]::Zero) { throw 'Could not open the runner lifetime job.' }
        $previous = [HarnessJob+Accounting]::new()
        if (-not [HarnessJob]::QueryInformationJobObject($job, 1, [ref]$previous,
                [Runtime.InteropServices.Marshal]::SizeOf($previous), [IntPtr]::Zero)) {
            throw 'Could not verify the previous runner job.'
        }
        if ($previous.ActiveProcesses -eq 0) { break }
        # Do not keep the old job alive while its monitor closes its last handle.
        [void][HarnessJob]::CloseHandle($job)
        $job = [IntPtr]::Zero
        if ([DateTime]::UtcNow -ge $deadline) { throw 'The previous runner has not finished cleanup. No work was started.' }
        Start-Sleep -Milliseconds 50
    }
    $limits = [HarnessJob+ExtendedLimits]::new()
    $basicLimits = [HarnessJob+BasicLimits]::new()
    $basicLimits.LimitFlags = 0x2000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    $limits.BasicLimitInformation = $basicLimits
    $size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
    if (-not [HarnessJob]::SetInformationJobObject($job, 9, [ref]$limits, $size)) {
        throw [ComponentModel.Win32Exception]::new()
    }
    $runnerHandle = [HarnessJob]::OpenProcess(0x100101, $false, $RunnerPid)
    if ($runnerHandle -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new() }

    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = [IO.Pipes.PipeSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($user)
    $security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($user, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    $control = [IO.Pipes.NamedPipeServerStream]::new($PipeName, [IO.Pipes.PipeDirection]::InOut, 1,
        [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $security)
    $connection = $control.BeginWaitForConnection($null, $null)
    if (-not $connection.AsyncWaitHandle.WaitOne(10000)) { throw 'Runner pipe connection timed out.' }
    $control.EndWaitForConnection($connection)
    $clientPid = [uint32]0
    if (-not [HarnessJob]::GetNamedPipeClientProcessId($control.SafePipeHandle.DangerousGetHandle(), [ref]$clientPid) -or $clientPid -ne $RunnerPid) {
        throw 'The private pipe client is not the runner.'
    }
    $encoding = [Text.UTF8Encoding]::new($false)
    $reader = [IO.StreamReader]::new($control, $encoding, $false, 4096, $true)
    $writer = [IO.StreamWriter]::new($control, $encoding, 4096, $true)
    $writer.AutoFlush = $true

    # Open the process handle first; only its live parent can acknowledge this private pipe.
    $challenge = [Guid]::NewGuid().ToString('N')
    $writer.WriteLine("challenge:$challenge")
    if ($reader.ReadLine() -cne "ack:$challenge") { throw 'Runner handshake was not acknowledged.' }
    if (-not [HarnessJob]::AssignProcessToJobObject($job, $runnerHandle)) {
        throw [ComponentModel.Win32Exception]::new()
    }
    $monitorInJob = $false
    if (-not [HarnessJob]::IsProcessInJob([IntPtr](-1), $job, [ref]$monitorInJob) -or $monitorInJob) {
        throw 'The lifetime monitor must remain outside the runner job.'
    }
    $writer.WriteLine('ready')
    while ($true) {
        try { $command = $reader.ReadLine() } catch { break }
        if ($null -eq $command) { break }
        try {
            $request = $command | ConvertFrom-Json
            if ($request.type -cne 'installer' -or $request.file -isnot [string] -or
                $request.args -isnot [array] -or $request.args.Count -ne 3 -or
                -not [IO.Path]::IsPathRooted($request.file) -or
                [IO.Path]::GetFileName($request.file) -notmatch '^Phasma-Harness-Setup-.+\.exe$' -or
                -not [IO.File]::Exists($request.file) -or
                ($request.args -join ' ') -cne '--updated /S --force-run') {
                throw 'Invalid installer handoff.'
            }
            $installer = $request
            try { $writer.WriteLine('installer-accepted') } catch { }
            break
        } catch {
            $message = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
            try { $writer.WriteLine("installer-error:$message") } catch { break }
        }
    }
    # Losing the control lease must not leave a detached background service running indefinitely.
    $wait = [HarnessJob]::WaitForSingleObject($runnerHandle, 5000)
    if ($wait -eq 258) {
        if (-not [HarnessJob]::TerminateProcess($runnerHandle, 0)) { throw [ComponentModel.Win32Exception]::new() }
        $wait = [HarnessJob]::WaitForSingleObject($runnerHandle, 5000)
    }
    if ($wait -ne 0) {
        throw 'Runner process wait failed.'
    }
    if ($null -ne $installer) {
        if (-not [HarnessJob]::TerminateJobObject($job, 1)) { throw [ComponentModel.Win32Exception]::new() }
        $accounting = [HarnessJob+Accounting]::new()
        $accountingSize = [Runtime.InteropServices.Marshal]::SizeOf($accounting)
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            if (-not [HarnessJob]::QueryInformationJobObject($job, 1, [ref]$accounting, $accountingSize, [IntPtr]::Zero)) {
                throw [ComponentModel.Win32Exception]::new()
            }
            if ($accounting.ActiveProcesses -eq 0) { break }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Runner child cleanup was not confirmed; update was not launched.' }
            Start-Sleep -Milliseconds 50
        } while ($true)
    }
} catch {
    if ($null -ne $installer) { [IO.File]::WriteAllText($installer.file + '.launch-error.txt', $_.Exception.Message) }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($runnerHandle -ne [IntPtr]::Zero) { [HarnessJob]::CloseHandle($runnerHandle) | Out-Null }
    if ($job -ne [IntPtr]::Zero) { [HarnessJob]::CloseHandle($job) | Out-Null }
    if ($null -ne $control) { $control.Dispose() }
}

# The verified update starts outside the old job, after its runner and child trees are gone.
if ($null -ne $installer) {
    try {
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $installer.file
        $start.Arguments = $installer.args -join ' '
        $start.WorkingDirectory = [IO.Path]::GetDirectoryName($installer.file)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        [Diagnostics.Process]::Start($start) | Out-Null
    } catch {
        [IO.File]::WriteAllText($installer.file + '.launch-error.txt', $_.Exception.Message)
        exit 1
    }
}
