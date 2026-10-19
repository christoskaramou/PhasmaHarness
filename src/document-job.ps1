param([ValidateRange(67108864, 4294967296)][uint64]$LimitBytes)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DocumentJob
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

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

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
