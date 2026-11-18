@echo off
rem Starts only the local backend (no desktop window); open http://127.0.0.1:4317 afterwards.
setlocal
cd /d "%~dp0.."
set "PATH=%CD%\.runtime;%PATH%"
".runtime\node.exe" "dist\server\main.js"
