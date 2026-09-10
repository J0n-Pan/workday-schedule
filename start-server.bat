@echo off
rem Fallback launcher: starts the server in a visible console and opens the browser.
cd /d "%~dp0"
set "NODE_HOME=C:\Users\admin\.workbuddy\binaries\node\versions\22.22.2-2"
if exist "%NODE_HOME%\node.exe" set "PATH=%NODE_HOME%;%PATH%"
start "" http://127.0.0.1:5173/
node server\index.js
pause
