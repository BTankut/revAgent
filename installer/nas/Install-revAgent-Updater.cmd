@echo off
setlocal

set "TARGET=%~dp0Install-revAgent-Updater-GUI.cmd"

if not exist "%TARGET%" (
  echo ERROR: revAgent legacy updater compatibility launcher was not found.
  echo Expected path: %TARGET%
  echo.
  pause
  exit /b 1
)

call "%TARGET%" %*
exit /b %ERRORLEVEL%
