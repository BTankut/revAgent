@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "LEGACY=%SCRIPT_DIR%Install-Revit-MCP-Updater.cmd"

if not exist "%LEGACY%" (
    echo ERROR: revAgent updater setup script was not found.
    echo Expected path: %LEGACY%
    echo.
    pause
    exit /b 1
)

call "%LEGACY%" %*
exit /b %ERRORLEVEL%
