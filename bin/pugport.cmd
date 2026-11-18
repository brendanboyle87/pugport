@echo off
rem pugport, the PugPort terminal command. Works from the source checkout (bin\) and inside the app (dist\bin\).
rem Single-line ifs only, no labels: this file may be checked out with LF line endings.
setlocal
set "PUGPORT_ROOT=%~dp0.."
if exist "%~dp0..\cli\pugport.js" set "PUGPORT_ROOT=%~dp0..\.."
set "PUGPORT_SCRIPT=%PUGPORT_ROOT%\dist\cli\pugport.js"
if not exist "%PUGPORT_SCRIPT%" echo pugport is not built yet: run "node scripts\build.mjs" in the PugPort folder. 1>&2
if not exist "%PUGPORT_SCRIPT%" exit /b 1
set "PUGPORT_RUNTIME="
rem Installed app: PugPort.exe runs the command itself, acting as Node.
if exist "%PUGPORT_ROOT%\..\..\PugPort.exe" set "PUGPORT_RUNTIME=%PUGPORT_ROOT%\..\..\PugPort.exe"
if defined PUGPORT_RUNTIME set "ELECTRON_RUN_AS_NODE=1"
if not defined PUGPORT_RUNTIME if exist "%PUGPORT_ROOT%\.runtime\node.exe" set "PUGPORT_RUNTIME=%PUGPORT_ROOT%\.runtime\node.exe"
if not defined PUGPORT_RUNTIME set "PUGPORT_RUNTIME=node"
"%PUGPORT_RUNTIME%" "%PUGPORT_SCRIPT%" %*
exit /b %errorlevel%
