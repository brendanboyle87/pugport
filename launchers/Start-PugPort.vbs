Option Explicit
' This template is also copied to .data\launchers; locate the checkout beside the script.
Dim shell, files, folder, parent, root, entry, command, result, detail, logPath, startedAt
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
root = ""
Do
  entry = files.BuildPath(folder, "Start-PugPort.cmd")
  If files.FileExists(entry) Then
    root = folder
    Exit Do
  End If
  parent = files.GetParentFolderName(folder)
  If parent = "" Or parent = folder Then Exit Do
  folder = parent
Loop
If root = "" Then Fail "Start-PugPort.cmd was not found beside this launcher. Keep the launcher inside the PugPort checkout."

shell.CurrentDirectory = root
logPath = files.BuildPath(root, ".data\launchers\last-start.log")
command = Chr(34) & shell.ExpandEnvironmentStrings("%ComSpec%") & Chr(34) & " /d /s /c " & Chr(34) & Chr(34) & entry & Chr(34) & " --quiet" & Chr(34)
On Error Resume Next
startedAt = Now
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  detail = Err.Description
  On Error GoTo 0
  Fail "The PugPort launcher could not run: " & detail & vbCrLf & vbCrLf & "Open Start-PugPort.cmd directly to inspect the error."
End If
On Error GoTo 0
If result = 1 And DateDiff("s", startedAt, Now) >= 60 Then WScript.Quit 0
If result <> 0 Then Fail "PugPort exited with code " & result & "." & vbCrLf & vbCrLf & "Startup details: " & logPath & vbCrLf & "Open Start-PugPort.cmd directly to inspect the error."
WScript.Quit 0

Sub Fail(message)
  If LCase(files.GetFileName(WScript.FullName)) = "cscript.exe" Then
    WScript.Echo message
  Else
    MsgBox message, vbOKOnly + vbCritical, "PugPort could not start"
  End If
  WScript.Quit 1
End Sub
