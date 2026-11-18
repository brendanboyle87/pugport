@echo off
rem Opens the bundled Pi coding agent CLI directly (outside PugPort), using the project's Node runtime.
setlocal
cd /d "%~dp0.."
set "PATH=%CD%\.runtime;%PATH%"
".runtime\node.exe" "node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
