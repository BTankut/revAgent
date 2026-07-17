@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"

set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"
set "CHANNEL=%RELEASE_ROOT%\channels\stable.json"
set "REFRESH=%RELEASE_ROOT%\tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd"

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

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%" -VerificationOnly >nul 2>nul
if errorlevel 1 (
  echo.
  echo revAgent stable updater needs to refresh the protected local bootstrap for this release.
  if not exist "%REFRESH%" (
    echo revAgent stable bootstrap refresh tool was not found:
    echo %REFRESH%
    pause
    exit /b 1
  )
  call "%REFRESH%"
  if errorlevel 1 (
    echo.
    echo revAgent stable bootstrap refresh did not complete.
    pause
    exit /b 1
  )
  echo.
  echo revAgent stable bootstrap refresh completed. The updater should open now.
  exit /b 0
)

start "revAgent" "%POWERSHELL%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%"
exit /b 0
