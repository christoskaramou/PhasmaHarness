Option Explicit
Dim shell, files, folder, executable, environment
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
executable = files.BuildPath(folder, "node_modules\electron\dist\electron.exe")
If Not files.FileExists(executable) Then
  MsgBox "Run npm install in " & folder & " first.", vbExclamation, "Phasma Harness"
  WScript.Quit 1
End If
shell.CurrentDirectory = folder
Set environment = shell.Environment("Process")
environment.Remove "ELECTRON_RUN_AS_NODE"
shell.Run Chr(34) & executable & Chr(34) & " " & Chr(34) & folder & Chr(34), 1, False
