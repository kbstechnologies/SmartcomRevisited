@echo off
REM Double-click wrapper for import-putty-sessions.ps1.
REM
REM PowerShell refuses to run unsigned .ps1 files by default, so the policy is
REM relaxed for this one process only — nothing about the machine is changed.

setlocal
set "SCRIPT=%~dp0import-putty-sessions.ps1"

if not exist "%SCRIPT%" (
  echo Could not find import-putty-sessions.ps1 next to this file.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo The import did not finish. The message above says why.
)

echo Press any key to close.
pause >nul
exit /b %CODE%
