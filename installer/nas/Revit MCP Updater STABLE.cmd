@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"

set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"
set "CHANNEL=%RELEASE_ROOT%\channels\stable.json"

if not exist "%BOOTSTRAP%" (
  echo SECURITY STOP: protected local revAgent bootstrap is not installed.
  echo An administrator/coordinator must prestage an independently authenticated bootstrap at:
  echo %BOOTSTRAP%
  echo NAS scripts cannot bootstrap their own trust.
  pause
  exit /b 1
)

if not exist "%CHANNEL%" (
  echo revAgent release manifest was not found:
  echo %CHANNEL%
  pause
  exit /b 1
)

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%" -VerificationOnly >nul
if errorlevel 1 (
  echo.
  echo revAgent stable updater could not verify the protected local bootstrap.
  echo If this workstation was prestaged for pilot or an older release, run the administrator bootstrap prestage for stable first.
  pause
  exit /b 1
)

start "revAgent" "%POWERSHELL%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%"
exit /b 0
