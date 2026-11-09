@echo off
rem Update code and route data, rebuild, and restart the server (scripts\update.ps1).
rem Double-click to run. Administrator rights are not needed.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1"
echo.
pause
