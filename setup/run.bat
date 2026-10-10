@echo off
setlocal
if not defined FORMPDF_CALLER_DIR set "FORMPDF_CALLER_DIR=%cd%"
cd /d "%~dp0.."
if not exist backend\venv\Scripts\activate.bat ( echo [formpdf] backend venv missing, run formpdf.bat install & exit /b 1 )
call backend\venv\Scripts\activate.bat
python setup\cli.py %*
exit /b %ERRORLEVEL%
