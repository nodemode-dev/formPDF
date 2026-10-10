@echo off
setlocal
cd /d "%~dp0"
if not exist venv\Scripts\activate.bat ( echo [formpdf] backend venv missing, run formpdf.bat install & exit /b 1 )
call venv\Scripts\activate.bat
if not defined FORMPDF_HOST set "FORMPDF_HOST=127.0.0.1"
if not defined FORMPDF_PORT set "FORMPDF_PORT=8198"
uvicorn app.main:app --reload --host %FORMPDF_HOST% --port %FORMPDF_PORT%
