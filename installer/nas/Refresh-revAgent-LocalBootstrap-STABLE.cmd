@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "SCRIPT=%~dp0Refresh-revAgent-LocalBootstrap-STABLE.ps1"
set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"

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

if not exist "%BOOTSTRAP%" (
  echo.
  echo revAgent bootstrap refresh returned without creating the protected local bootstrap:
  echo %BOOTSTRAP%
  echo If an administrator approval or bootstrap coordinator window is still open, finish it and run this command again.
  pause
  exit /b 1
)

exit /b 0
