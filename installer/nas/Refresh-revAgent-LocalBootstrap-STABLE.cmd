@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "SCRIPT=%~dp0Refresh-revAgent-LocalBootstrap-STABLE.ps1"

if not exist "%SCRIPT%" (
  echo revAgent bootstrap refresh script was not found:
  echo %SCRIPT%
  pause
  exit /b 1
)

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
if errorlevel 1 (
  echo.
  echo revAgent bootstrap install/refresh did not complete.
  pause
  exit /b 1
)

exit /b 0
