@echo off
rem Opens the PugPort desktop app from source. Run Setup-Windows.ps1 once first.
rem Other launchers (web-only backend, Pi CLI, experimental macOS) live in launchers\.
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
set "PATH=%~dp0.runtime;%PATH%"
if /i "%~1"=="--quiet" goto quiet
call :launch
set "PUGPORT_START_EXIT=%errorlevel%"
if not "%PUGPORT_START_EXIT%"=="0" pause
exit /b %PUGPORT_START_EXIT%

:quiet
if not exist ".data\launchers" mkdir ".data\launchers"
if not exist ".data\launchers" exit /b 1
call :launch > ".data\launchers\last-start.log" 2>&1
exit /b %errorlevel%

:launch
if not exist ".runtime\node.exe" (
  echo PugPort cannot start: .runtime\node.exe is missing. Run Setup-Windows.ps1 first.
  exit /b 1
)
if not exist "node_modules\electron\cli.js" (
  echo PugPort cannot start: Electron is missing. Run Setup-Windows.ps1 first.
  exit /b 1
)
if not exist "dist\electron\main.cjs" (
  ".runtime\node.exe" "scripts\build.mjs"
  if errorlevel 1 exit /b 1
)
".runtime\node.exe" "node_modules\electron\cli.js" .
exit /b %errorlevel%
