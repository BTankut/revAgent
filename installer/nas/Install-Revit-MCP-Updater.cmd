@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "TARGET=%SCRIPT_DIR%Install-revAgent-Updater.cmd"

if not exist "%TARGET%" (
    echo ERROR: revAgent updater setup script was not found.
    echo Expected path: %TARGET%
    echo.
    pause
    exit /b 1
)

call "%TARGET%" %*
exit /b %ERRORLEVEL%
