@echo off
setlocal
cd /d "%~dp0.."
if not defined FORMPDF_PORT set "FORMPDF_PORT=8198"
start "formpdf backend" cmd /k "cd /d %cd%\backend && boot_backend.bat"
start "formpdf frontend" cmd /k "cd /d %cd%\frontend && boot_frontend.bat"
echo [formpdf] frontend http://localhost:5198 and backend http://127.0.0.1:%FORMPDF_PORT%
