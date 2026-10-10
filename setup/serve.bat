@echo off
setlocal
cd /d "%~dp0.."
if not exist frontend\dist\index.html ( call setup\build_frontend.bat || exit /b 1 )
set "FORMPDF_DIST=%cd%\frontend\dist"
cd backend
if not exist venv\Scripts\activate.bat ( echo [formpdf] backend venv missing, run formpdf.bat install & exit /b 1 )
call venv\Scripts\activate.bat
if not defined FORMPDF_HOST set "FORMPDF_HOST=127.0.0.1"
if not defined FORMPDF_PORT set "FORMPDF_PORT=8198"
echo [formpdf] serving http://%FORMPDF_HOST%:%FORMPDF_PORT%
uvicorn app.main:app --host %FORMPDF_HOST% --port %FORMPDF_PORT%
