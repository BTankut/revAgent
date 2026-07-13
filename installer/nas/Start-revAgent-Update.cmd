@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"

if not exist "%BOOTSTRAP%" (
  echo SECURITY STOP: protected local revAgent bootstrap is not installed.
  exit /b 1
)

start "revAgent" "%POWERSHELL%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BOOTSTRAP%"
exit /b 0
