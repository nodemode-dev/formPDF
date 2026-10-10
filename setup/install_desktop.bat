@echo off
setlocal
cd /d "%~dp0..\backend"
if not exist venv\Scripts\activate.bat ( echo [formpdf] backend venv missing, run formpdf.bat install & exit /b 1 )
call venv\Scripts\activate.bat
pip install -r requirements_desktop.txt || exit /b 1
where cargo >nul 2>nul || ( echo [formpdf] Rust is not installed, get it from https://rustup.rs then rerun formpdf.bat install-desktop & exit /b 1 )
if not exist ..\frontend\node_modules\.bin\tauri.cmd ( pushd ..\frontend & call npm install & popd )
echo [formpdf] desktop toolchain ready
