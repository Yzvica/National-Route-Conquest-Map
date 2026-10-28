@echo off
rem Update code and route data, rebuild, and restart the server (scripts\update.ps1).
rem Double-click to run. Asks for administrator rights to restart the KokudoMap task.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath \"%~f0\" -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1"
echo.
pause
