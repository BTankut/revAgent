@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"
set "CHANNEL=%~dp0..\channels\stable.json"

if not exist "%BOOTSTRAP%" (
    echo SECURITY STOP: clean install requires an independently authenticated local bootstrap.
    echo An administrator/coordinator must prestage and protect:
    echo %BOOTSTRAP%
    echo Refusing to execute installer code directly from NAS.
    pause
    exit /b 1
)

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%"
exit /b %ERRORLEVEL%
