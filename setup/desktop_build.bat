@echo off
setlocal
cd /d "%~dp0.."
call setup\build_frontend.bat || exit /b 1
call setup\freeze_backend.bat || exit /b 1
if not exist src-tauri\icons\icon.ico call frontend\node_modules\.bin\tauri.cmd icon assets\formpdf_icon.png
call frontend\node_modules\.bin\tauri.cmd build %* || exit /b 1
echo [formpdf] bundles are in src-tauri\target\release\bundle
