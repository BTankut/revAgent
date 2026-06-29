@echo off
setlocal

set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "PRIMARY_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"
set "LEGACY_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
set "RELEASE_ROOT=%PRIMARY_ROOT%"

if not exist "%RELEASE_ROOT%\tools\Install-revAgent-Updater-GUI.ps1" set "RELEASE_ROOT=%LEGACY_ROOT%"

set "GUI=%RELEASE_ROOT%\tools\Install-revAgent-Updater-GUI.ps1"
set "CHANNEL=%RELEASE_ROOT%\channels\stable.json"

if not exist "%GUI%" (
  echo revAgent GUI script was not found:
  echo %GUI%
  pause
  exit /b 1
)

if not exist "%CHANNEL%" (
  echo revAgent release manifest was not found:
  echo %CHANNEL%
  pause
  exit /b 1
)

start "revAgent" "%POWERSHELL%" -STA -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%GUI%" -ChannelManifestPath "%CHANNEL%"
exit /b 0
