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

    // Worker jobs (worker-job.ps1): ending one stops every process its worker started.
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [StructLayout(LayoutKind.Sequential)]
    public struct Accounting
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
        out Accounting information, uint size, IntPtr returnLength);

    // Restart Manager: the processes holding a file open, with their start times. A Claude background task's processes
    // all hold its output file, also those whose parent exited.
    [StructLayout(LayoutKind.Sequential)]
    public struct UniqueProcess
    {
        public uint ProcessId;
        public uint StartTimeLow;
        public uint StartTimeHigh;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessInfo
    {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmStartSession(out uint session, int flags, System.Text.StringBuilder key);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    public static extern int RmRegisterResources(uint session, uint files, string[] names, uint applications,
        IntPtr processes, uint services, string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] list, ref uint reasons);

    [DllImport("rstrtmgr.dll")]
    public static extern int RmEndSession(uint session);
}
