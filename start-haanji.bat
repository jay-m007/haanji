@echo off
rem Starts the speech service and Haanji in two windows (Windows).
cd /d "%~dp0"
start "Haanji speech" cmd /k "speech\.venv\Scripts\python.exe speech\server.py"
timeout /t 3 >nul
start "Haanji" cmd /k "node src\server.ts"
