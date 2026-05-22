@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "GUI=%SCRIPT_DIR%Install-Revit-MCP-Updater-GUI.ps1"

if not exist "%GUI%" (
    echo ERROR: GUI script was not found.
    echo Expected path: %GUI%
    echo.
    pause
    exit /b 1
)

start "revAgent" "%POWERSHELL%" -STA -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%GUI%"
exit /b 0
