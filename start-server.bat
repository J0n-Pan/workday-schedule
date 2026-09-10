@echo off
rem Fallback launcher: starts the server in a visible console and opens the browser.
cd /d "%~dp0"
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
start "" http://127.0.0.1:5173/
"%NODE_EXE%" server\index.js
pause
