# Probe without deleting anything: npm ci must not partially remove a locked dependency tree.
if (-not ('PhasmaInstallFiles' -as [type])) {
    Add-Type @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PhasmaInstallFiles {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    public static string Blocker(string path) {
        try {
            var attributes = File.GetAttributes(path);
            bool directory = (attributes & FileAttributes.Directory) != 0;
            bool link = (attributes & FileAttributes.ReparsePoint) != 0;
            // DELETE probes directories/links; write access also detects mapped executables and DLLs.
            // Existing readers/watchers may stay open if they allow both replacement and deletion.
            using (var handle = CreateFile(path, directory || link ? 0x10000u : 0x40010000u, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                if (handle.IsInvalid) return path + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message;
            }
            if (directory && !link) foreach (var child in Directory.EnumerateFileSystemEntries(path)) {
                var blocked = Blocker(child);
                if (blocked != null) return blocked;
            }
            return null;
        } catch (Exception error) { return path + ": " + error.Message; }
    }
}
'@
}

function Get-HarnessProcesses($electron) {
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction Stop |
        Where-Object { $_.ExecutablePath -ieq $electron }
}

function Request-HarnessQuit($folder, $electron) {
    $runAsNode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = $null
        Start-Process -FilePath $electron -ArgumentList ('"' + $folder + '" --quit-for-install') -WorkingDirectory $folder -WindowStyle Hidden -PassThru
    } finally { $env:ELECTRON_RUN_AS_NODE = $runAsNode }
}

function Wait-HarnessClosed($folder, [int]$timeoutSeconds = 45) {
    $folder = [IO.Path]::GetFullPath($folder)
    $electron = Join-Path $folder 'node_modules\electron\dist\electron.exe'
    $dependencies = Join-Path $folder 'node_modules'
    $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
    $request = $null
    try {
        if (Get-HarnessProcesses $electron) {
            Write-Host 'Stopping Phasma Harness and its workers...'
            $request = Request-HarnessQuit $folder $electron
        }
        while ($true) {
            $running = @(Get-HarnessProcesses $electron)
            $blocked = $null
            if (-not $running.Count -and (Test-Path -LiteralPath $dependencies)) {
                $blocked = [PhasmaInstallFiles]::Blocker($dependencies)
            }
            if (-not $running.Count -and -not $blocked -and (-not $request -or $request.HasExited)) { return }
            if ([DateTime]::UtcNow -ge $deadline) {
                if ($blocked) { throw "Dependencies are still in use or inaccessible: $blocked. Close the app using this file and retry. No dependencies were changed." }
                throw "Harness did not finish shutting down (processes: $($running.ProcessId -join ', ')). Quit runner from its tray icon and retry. Older running versions need this once. No dependencies were changed."
            }
            Start-Sleep -Milliseconds 300
        }
    } finally { if ($request) { $request.Dispose() } }
}
