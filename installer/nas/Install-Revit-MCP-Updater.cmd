@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "INSTALLER=%SCRIPT_DIR%install-updater-task.ps1"
set "CHANNEL=%SCRIPT_DIR%..\channels\stable.json"

if not defined REVIT_MCP_INSTALL_ROOT set "REVIT_MCP_INSTALL_ROOT=%ProgramData%\DPE\RevitMCP"
if not defined REVIT_MCP_WORK_ROOT set "REVIT_MCP_WORK_ROOT=%REVIT_MCP_INSTALL_ROOT%\updater"
if not defined REVIT_MCP_PACKAGE_TARGET set "REVIT_MCP_PACKAGE_TARGET=%REVIT_MCP_INSTALL_ROOT%\package"
if not defined REVIT_MCP_SERVER_TARGET set "REVIT_MCP_SERVER_TARGET=%REVIT_MCP_INSTALL_ROOT%\runtime"

set "EXTRA_ARGS="
if defined REVIT_MCP_NO_SCHEDULED_TASK set "EXTRA_ARGS=%EXTRA_ARGS% -NoScheduledTask"
if defined REVIT_MCP_SKIP_NPM set "EXTRA_ARGS=%EXTRA_ARGS% -SkipNpmInstall"
if defined REVIT_MCP_SKIP_CODEX set "EXTRA_ARGS=%EXTRA_ARGS% -SkipCodexMcpRegistration"
if defined REVIT_MCP_SKIP_CODEX_USER set "EXTRA_ARGS=%EXTRA_ARGS% -SkipCodexUserIntegration"

echo revAgent updater setup is starting.
echo Channel: stable
echo Managed package path: %REVIT_MCP_INSTALL_ROOT%
echo Log folder: %REVIT_MCP_WORK_ROOT%\logs
echo.

if not exist "%INSTALLER%" (
    echo ERROR: install-updater-task.ps1 was not found.
    echo Expected path: %INSTALLER%
    echo.
    pause
    exit /b 1
)

if not exist "%CHANNEL%" (
    echo ERROR: stable channel manifest was not found.
    echo Expected path: %CHANNEL%
    echo.
    pause
    exit /b 1
)

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%" -ChannelManifestPath "%CHANNEL%" -InstallRoot "%REVIT_MCP_INSTALL_ROOT%" -WorkRoot "%REVIT_MCP_WORK_ROOT%" -PackageTarget "%REVIT_MCP_PACKAGE_TARGET%" -ServerTarget "%REVIT_MCP_SERVER_TARGET%" -RunNow %EXTRA_ARGS%
set "RESULT=%ERRORLEVEL%"

echo.
if "%RESULT%"=="0" (
    echo Operation completed.
    echo If Revit is open, the update may have been deferred.
    echo Report: %REVIT_MCP_WORK_ROOT%\last-update-report.json
    echo Log folder: %REVIT_MCP_WORK_ROOT%\logs
) else (
    echo Operation failed. Code: %RESULT%
    echo Log folder: %REVIT_MCP_WORK_ROOT%\logs
)
echo.
pause
exit /b %RESULT%
