@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "BOOTSTRAP=%~dp0Start-revAgent-Update.ps1"
set "BOOTSTRAP_STATE=%~dp0bootstrap-state.json"
set "REVAGENT_BOOTSTRAP_STATE=%BOOTSTRAP_STATE%"
set "STABLE_REFRESH=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd"
set "POST_REFRESH_LAUNCH=0"
if /i "%~1"=="--post-refresh" set "POST_REFRESH_LAUNCH=1"

if not exist "%BOOTSTRAP%" (
  echo.
  echo SECURITY STOP: protected local revAgent bootstrap is not installed.
  echo Contact the DPE revAgent administrator to complete the supervised manual bootstrap prestage, then run this updater again.
  pause
  exit /b 84
)

if not exist "%BOOTSTRAP_STATE%" (
  echo.
  echo SECURITY STOP: protected local revAgent bootstrap state is not installed.
  echo Contact the DPE revAgent administrator to complete the supervised manual bootstrap prestage, then run this updater again.
  pause
  exit /b 84
)

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -VerificationOnly >nul 2>nul
if errorlevel 1 (
  if "%POST_REFRESH_LAUNCH%"=="1" (
    echo.
    echo revAgent bootstrap verification still fails after a fresh refresh.
    echo Verification details:
    "%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -VerificationOnly
    echo.
    echo This machine needs manual diagnosis; another automatic refresh was not started.
    pause
    exit /b 83
  )
  echo.
  echo revAgent local updater bootstrap must be refreshed before this release can run.
  call :RefreshStableIfBound
  set "REFRESH_EXIT=!ERRORLEVEL!"
  exit /b !REFRESH_EXIT!
)

"%POWERSHELL%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BOOTSTRAP%"
set "BOOTSTRAP_EXIT=!ERRORLEVEL!"
exit /b !BOOTSTRAP_EXIT!

:RefreshStableIfBound
set "BOOTSTRAP_CHANNEL="
for /f "usebackq delims=" %%C in (`^""%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:REVAGENT_BOOTSTRAP_STATE; if(Test-Path -LiteralPath $p){ (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json).release.channel }"^"`) do set "BOOTSTRAP_CHANNEL=%%C"
if /i not "%BOOTSTRAP_CHANNEL%"=="stable" (
  echo This local bootstrap is bound to channel '%BOOTSTRAP_CHANNEL%'. Use the matching NAS updater for that channel.
  pause
  exit /b 1
)
if not exist "%STABLE_REFRESH%" (
  echo revAgent stable bootstrap refresh tool was not found:
  echo %STABLE_REFRESH%
  pause
  exit /b 1
)
echo Starting revAgent stable bootstrap refresh...
call "%STABLE_REFRESH%"
set "REFRESH_EXIT=!ERRORLEVEL!"
if "!REFRESH_EXIT!"=="84" (
  echo.
  echo SECURITY STOP: independent Windows signing trust anchor is unavailable.
  echo Contact the DPE revAgent administrator to complete the supervised manual bootstrap prestage, then run this updater again.
  pause
  exit /b 84
)
if not "!REFRESH_EXIT!"=="0" (
  echo.
  echo revAgent stable bootstrap refresh did not complete.
  pause
  exit /b !REFRESH_EXIT!
)
exit /b 0
