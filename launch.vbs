Option Explicit
' Workday launcher: start the local server (if not already running) and open the browser.
' Node lookup order: <project>\runtime\node.exe (self-contained) -> node on PATH.
Dim sh, fso, node, project, cmd, url, i, up
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

project = fso.GetParentFolderName(WScript.ScriptFullName)
node = project & "\runtime\node.exe"
If Not fso.FileExists(node) Then node = "node"

url = "http://127.0.0.1:5173/"
up = False

If Not IsUp(url) Then
  cmd = """" & node & """ """ & project & "\server\index.js"""
  sh.CurrentDirectory = project
  On Error Resume Next
  sh.Run cmd, 0, False
  If Err.Number <> 0 Then
    MsgBox "无法启动服务进程，请检查 runtime\node.exe 是否存在。" & vbCrLf & cmd, 16, "工作日程"
    WScript.Quit 1
  End If
  On Error GoTo 0
  For i = 1 To 40
    WScript.Sleep 500
    If IsUp(url) Then
      up = True
      Exit For
    End If
  Next
Else
  up = True
End If

If Not up Then
  MsgBox "服务启动超时（约 20 秒），请检查 5173 端口是否被占用。" & vbCrLf & _
         "也可在项目目录执行：启动服务.bat", 16, "工作日程"
  WScript.Quit 1
End If

sh.Run url, 1, False

Function IsUp(u)
  On Error Resume Next
  Dim h
  IsUp = False
  Set h = CreateObject("WinHttp.WinHttpRequest.5.1")
  If h Is Nothing Then Exit Function
  h.SetTimeouts 1000, 1000, 1000, 1000
  h.Open "GET", u & "api/health", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then IsUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function
