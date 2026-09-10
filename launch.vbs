Option Explicit
' Workday launcher: make sure a Node runtime exists, start the server, open the browser.
' Node lookup order: <project>\runtime\node.exe -> node on PATH (major >= 22).
Dim sh, fso, node, project, cmd, url, i, up
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

project = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:5173/"

node = FindNode()
If node = "" Then
  MsgBox "未找到可用的 Node 运行时（需要 Node >= 22.5）。" & vbCrLf & vbCrLf & _
         "请先双击运行 setup.bat 自动准备运行时，" & vbCrLf & _
         "或到 https://nodejs.org 安装后重试。", 16, "工作日程"
  WScript.Quit 1
End If

up = False
If Not IsUp() Then
  cmd = """" & node & """ """ & project & "\server\index.js"""
  sh.CurrentDirectory = project
  On Error Resume Next
  sh.Run cmd, 0, False
  If Err.Number <> 0 Then
    MsgBox "无法启动服务进程。" & vbCrLf & "命令：" & cmd, 16, "工作日程"
    WScript.Quit 1
  End If
  On Error GoTo 0
  For i = 1 To 120
    WScript.Sleep 150
    If IsUp() Then
      up = True
      Exit For
    End If
  Next
Else
  up = True
End If

If Not up Then
  MsgBox "服务启动超时（约 18 秒）。" & vbCrLf & _
         "请检查 5173 端口是否被占用，" & vbCrLf & _
         "或在项目目录运行 start-server.bat 查看详细日志。", 16, "工作日程"
  WScript.Quit 1
End If

sh.Run url, 1, False

Function FindNode()
  Dim p, tmp, out
  FindNode = ""
  p = project & "\runtime\node.exe"
  If fso.FileExists(p) Then
    FindNode = p
    Exit Function
  End If
  On Error Resume Next
  tmp = fso.GetSpecialFolder(2) & "\workday_node_probe.txt"
  sh.Run "%ComSpec% /c node -v > """ & tmp & """ 2>&1", 0, True
  If fso.FileExists(tmp) Then
    out = LCase(Trim(fso.OpenTextFile(tmp).ReadAll))
    fso.DeleteFile tmp, True
  End If
  Err.Clear
  On Error GoTo 0
  If MajorOk(out) Then FindNode = "node"
End Function

Function MajorOk(v)
  Dim re, m
  MajorOk = False
  If Left(v, 1) <> "v" Then Exit Function
  Set re = CreateObject("VBScript.RegExp")
  re.Pattern = "^v(\d+)"
  Set m = re.Execute(v)
  If m.Count = 0 Then Exit Function
  If CInt(m(0).SubMatches(0)) >= 22 Then MajorOk = True
End Function

Function IsUp()
  On Error Resume Next
  Dim h
  IsUp = False
  Set h = CreateObject("WinHttp.WinHttpRequest.5.1")
  If h Is Nothing Then Exit Function
  h.SetProxy 1, ""
  h.SetTimeouts 800, 800, 800, 800
  h.Open "GET", url & "api/health", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then IsUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function
