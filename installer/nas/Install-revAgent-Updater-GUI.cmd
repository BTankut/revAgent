@echo off
setlocal

set "BOOTSTRAP=%ProgramData%\DPE\revAgent\bootstrap\Start-revAgent-Update.ps1"
set "STABLE=%~dp0revAgent Updater STABLE.cmd"
if not exist "%STABLE%" set "STABLE=%~dp0tools\revAgent Updater STABLE.cmd"
if not exist "%STABLE%" if defined RELEASE_ROOT set "STABLE=%RELEASE_ROOT%\tools\revAgent Updater STABLE.cmd"

if not exist "%BOOTSTRAP%" echo This launcher is deprecated; opening revAgent Updater STABLE...

if not exist "%STABLE%" (
  echo ERROR: revAgent Updater STABLE was not found.
  echo Expected beside this launcher or under the release root tools directory.
  echo.
  pause
  exit /b 1
)

call "%STABLE%" %*
exit /b %ERRORLEVEL%
