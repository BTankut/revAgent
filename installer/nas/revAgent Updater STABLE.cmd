@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "RELEASE_ROOT=\\dpe-nas\Dpe-Ortak\Baris Tankut\revAgent-deploy"

set "COMMON_APP_DATA="
set "REVAGENT_LANGUAGE_MODE="
for /f "usebackq tokens=1,* delims==" %%P in (`^""%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "$mode=$ExecutionContext.SessionState.LanguageMode; if($mode -ne 'FullLanguage'){ 'REVAGENT_LANGUAGE_MODE=' + $mode } else { 'REVAGENT_COMMON_APP_DATA=' + [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData) }"^"`) do (
  if /i "%%P"=="REVAGENT_LANGUAGE_MODE" set "REVAGENT_LANGUAGE_MODE=%%Q"
  if /i "%%P"=="REVAGENT_COMMON_APP_DATA" set "COMMON_APP_DATA=%%Q"
)
if defined REVAGENT_LANGUAGE_MODE (
  echo revAgent updater cannot run: PowerShell is in !REVAGENT_LANGUAGE_MODE! mode.
  echo This is typically caused by Smart App Control or a WDAC/AppLocker policy on this machine.
  echo Ask IT to exempt/sign the revAgent deployment scripts or disable Smart App Control, then retry.
  pause
  exit /b 78
)
if not defined COMMON_APP_DATA (
  echo SECURITY STOP: Windows CommonApplicationData could not be resolved for the protected revAgent bootstrap.
  pause
  exit /b 1
)

set "BOOTSTRAP=%COMMON_APP_DATA%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"
set "CHANNEL=%RELEASE_ROOT%\channels\stable.json"
set "REFRESH=%RELEASE_ROOT%\tools\Refresh-revAgent-LocalBootstrap-STABLE.cmd"

if not exist "%CHANNEL%" (
  echo revAgent release manifest was not found:
  echo %CHANNEL%
  pause
  exit /b 1
)

if not exist "%BOOTSTRAP%" (
  echo revAgent stable updater needs to install the protected local bootstrap first.
  if not exist "%REFRESH%" (
    echo revAgent stable bootstrap install tool was not found:
    echo %REFRESH%
    pause
    exit /b 1
  )
  call "%REFRESH%"
  set "REFRESH_EXIT=!ERRORLEVEL!"
  if not "!REFRESH_EXIT!"=="0" (
    call :report_refresh_failure "!REFRESH_EXIT!" "install"
    pause
    exit /b !REFRESH_EXIT!
  )
  if not exist "%BOOTSTRAP%" (
    echo.
    echo revAgent stable bootstrap install returned without creating the protected local bootstrap:
    echo %BOOTSTRAP%
    echo If an administrator approval or bootstrap coordinator window is still open, finish it and run this updater again.
    pause
    exit /b 1
  )
  echo.
  echo revAgent stable bootstrap install completed. The updater should open now.
  exit /b 0
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
  set "REFRESH_EXIT=!ERRORLEVEL!"
  if not "!REFRESH_EXIT!"=="0" (
    call :report_refresh_failure "!REFRESH_EXIT!" "refresh"
    pause
    exit /b !REFRESH_EXIT!
  )
  if not exist "%BOOTSTRAP%" (
    echo.
    echo revAgent stable bootstrap refresh returned without creating the protected local bootstrap:
    echo %BOOTSTRAP%
    echo If an administrator approval or bootstrap coordinator window is still open, finish it and run this updater again.
    pause
    exit /b 1
  )
  echo.
  echo revAgent stable bootstrap refresh completed. The updater should open now.
  exit /b 0
)

"%POWERSHELL%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%BOOTSTRAP%" -ChannelManifestPath "%CHANNEL%"
set "BOOTSTRAP_EXIT=!ERRORLEVEL!"
exit /b !BOOTSTRAP_EXIT!

:report_refresh_failure
set "REVAGENT_FAILURE_CODE=%~1"
set "REVAGENT_FAILURE_ACTION=%~2"
echo.
if "%REVAGENT_FAILURE_CODE%"=="79" goto stable_uac_declined
if "%REVAGENT_FAILURE_CODE%"=="80" goto stable_coordinator_running
if "%REVAGENT_FAILURE_CODE%"=="81" goto stable_coordinator_timeout
if "%REVAGENT_FAILURE_CODE%"=="82" goto stable_uac_disabled
if "%REVAGENT_FAILURE_CODE%"=="84" goto stable_signing_trust_unavailable
echo revAgent stable bootstrap %REVAGENT_FAILURE_ACTION% did not complete.
exit /b 0

:stable_uac_declined
echo Administrator approval was declined. Run this updater again when an administrator is available.
exit /b 0

:stable_coordinator_running
echo A revAgent bootstrap coordinator is already running. Finish the coordinator/UAC window, then run this updater again.
exit /b 0

:stable_coordinator_timeout
echo The revAgent bootstrap coordinator is still running. Finish the coordinator/UAC window, then run this updater again.
exit /b 0

:stable_uac_disabled
echo This machine has UAC disabled or Windows could not provide the standard (non-elevated) user context required by the revAgent first install. Re-enable UAC, then run this updater again, or contact the DPE revAgent administrator for supervised manual bootstrap prestage.
exit /b 0

:stable_signing_trust_unavailable
echo SECURITY STOP: independent Windows signing trust anchor is unavailable.
echo Contact the DPE revAgent administrator to complete the supervised manual bootstrap prestage, then run this updater again.
exit /b 0
