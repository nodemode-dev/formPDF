@echo off
setlocal
cd /d "%~dp0.."
set "TRIPLE="
if defined FORMPDF_TARGET ( set "TRIPLE=%FORMPDF_TARGET%" ) else ( for /f "tokens=2" %%t in ('rustc -vV 2^>nul ^| findstr /b "host:"') do set "TRIPLE=%%t" )
if not defined TRIPLE ( echo [formpdf] rustc not found, run formpdf.bat install-desktop & exit /b 1 )
if not exist "src-tauri\binaries\formpdf-engine-%TRIPLE%.exe" ( set "FORMPDF_DEV_FREEZE=1" & call setup\freeze_backend.bat || exit /b 1 )
call frontend\node_modules\.bin\tauri.cmd dev %*
