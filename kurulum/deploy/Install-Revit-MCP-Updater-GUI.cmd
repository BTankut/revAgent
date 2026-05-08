@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "GUI=%SCRIPT_DIR%Install-Revit-MCP-Updater-GUI.ps1"

if not exist "%GUI%" (
    echo HATA: GUI script bulunamadi.
    echo Beklenen yer: %GUI%
    echo.
    pause
    exit /b 1
)

"%POWERSHELL%" -STA -NoProfile -ExecutionPolicy Bypass -File "%GUI%"
exit /b %ERRORLEVEL%
