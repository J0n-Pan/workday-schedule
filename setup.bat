@echo off
rem Workday one-click setup: prepare the Node runtime, start the server, open the browser.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 pause
