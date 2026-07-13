@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"
set "CHANNEL=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\channels\stable.json"

if not exist "%BOOTSTRAP%" (
  echo SECURITY STOP: protected local revAgent bootstrap is not installed.
  exit /b 1
)

if not exist "%CHANNEL%" (
  echo revAgent signed stable channel was not found:
  echo %CHANNEL%
  exit /b 1
)

start "revAgent" "%POWERSHELL%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%"
exit /b 0
