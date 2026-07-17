@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"
set "BOOTSTRAP_STATE=%ProgramData%\DPE\revAgent\bootstrap\bootstrap-state.json"
set "STABLE_REFRESH=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy\tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd"

if not exist "%BOOTSTRAP%" (
  echo SECURITY STOP: protected local revAgent bootstrap is not installed.
  exit /b 1
)

if not exist "%BOOTSTRAP_STATE%" (
  echo SECURITY STOP: protected local revAgent bootstrap state is not installed.
  pause
  exit /b 1
)

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -VerificationOnly >nul 2>nul
if errorlevel 1 (
  echo.
  echo revAgent local updater bootstrap must be refreshed before this release can run.
  call :RefreshStableIfBound
  if errorlevel 1 exit /b 1
  exit /b 0
)

start "revAgent" "%POWERSHELL%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BOOTSTRAP%"
exit /b 0

:RefreshStableIfBound
set "BOOTSTRAP_CHANNEL="
for /f "usebackq delims=" %%C in (`"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path $env:ProgramData 'DPE\revAgent\bootstrap\bootstrap-state.json'; if(Test-Path -LiteralPath $p){ (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json).release.channel }"`) do set "BOOTSTRAP_CHANNEL=%%C"
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
if errorlevel 1 (
  echo.
  echo revAgent stable bootstrap refresh did not complete.
  pause
  exit /b 1
)
exit /b 0
