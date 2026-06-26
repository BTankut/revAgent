@echo off
setlocal

set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "GUI=\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-Revit-MCP-Updater-GUI.ps1"
set "CHANNEL=\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\channels\stable.json"

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
