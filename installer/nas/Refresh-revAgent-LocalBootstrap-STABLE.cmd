@echo off
setlocal

set "POWERSHELL=%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe"
set "SCRIPT=%~dp0Refresh-revAgent-LocalBootstrap-STABLE.ps1"
set "COMMON_APP_DATA="
set "REVAGENT_LANGUAGE_MODE="
for /f "usebackq tokens=1,* delims==" %%P in (`^""%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "$mode=$ExecutionContext.SessionState.LanguageMode; if($mode -ne 'FullLanguage'){ 'REVAGENT_LANGUAGE_MODE=' + $mode } else { 'REVAGENT_COMMON_APP_DATA=' + [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData) }"^"`) do (
  if /i "%%P"=="REVAGENT_LANGUAGE_MODE" set "REVAGENT_LANGUAGE_MODE=%%Q"
  if /i "%%P"=="REVAGENT_COMMON_APP_DATA" set "COMMON_APP_DATA=%%Q"
)
if defined REVAGENT_LANGUAGE_MODE (
  echo revAgent updater cannot run: PowerShell is in %REVAGENT_LANGUAGE_MODE% mode.
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

if not exist "%SCRIPT%" (
  echo revAgent bootstrap refresh script was not found:
  echo %SCRIPT%
  pause
  exit /b 1
)

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "REFRESH_EXIT=%ERRORLEVEL%"
if "%REFRESH_EXIT%"=="0" goto verify_bootstrap
goto refresh_failed

:refresh_failed
echo.
if "%REFRESH_EXIT%"=="80" goto refresh_coordinator_running
if "%REFRESH_EXIT%"=="81" goto refresh_coordinator_timeout
if "%REFRESH_EXIT%"=="84" goto refresh_signing_trust_unavailable
echo revAgent bootstrap install/refresh did not complete.
goto refresh_failure_exit

:refresh_coordinator_running
echo A revAgent bootstrap trust broker request is already running. Wait for it to finish, then run this updater again.
goto refresh_failure_exit

:refresh_coordinator_timeout
echo The revAgent bootstrap trust broker is still running. Wait for it to finish, then run this updater again.
goto refresh_failure_exit

:refresh_signing_trust_unavailable
echo SECURITY STOP: the IT-prestaged revAgent machine trust core is missing or unhealthy.
echo Ask the DPE revAgent administrator to run the revAgent IT prestage kit on this machine, then run this updater again.
goto refresh_failure_exit

:refresh_failure_exit
pause
exit /b %REFRESH_EXIT%

:verify_bootstrap
if not exist "%BOOTSTRAP%" (
  echo.
  echo revAgent bootstrap refresh returned without creating the protected local bootstrap:
  echo %BOOTSTRAP%
  echo If an administrator approval or bootstrap coordinator window is still open, finish it and run this command again.
  pause
  exit /b 1
)

exit /b 0
