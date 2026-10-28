@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\install.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" echo Installation did not complete. See the error above.
pause
exit /b %result%
