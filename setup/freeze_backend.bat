@echo off
setlocal
cd /d "%~dp0.."
set "ROOT=%cd%"
if not exist backend\venv\Scripts\activate.bat ( echo [formpdf] backend venv missing, run formpdf.bat install & exit /b 1 )
call backend\venv\Scripts\activate.bat
python -c "import PyInstaller" >nul 2>nul || ( echo [formpdf] PyInstaller missing, run formpdf.bat install-desktop & exit /b 1 )
set "TRIPLE="
if defined FORMPDF_TARGET ( set "TRIPLE=%FORMPDF_TARGET%" ) else ( for /f "tokens=2" %%t in ('rustc -vV 2^>nul ^| findstr /b "host:"') do set "TRIPLE=%%t" )
if not defined TRIPLE ( echo [formpdf] rustc not found, install Rust or set FORMPDF_TARGET & exit /b 1 )
if not exist frontend\dist\index.html ( call setup\build_frontend.bat || exit /b 1 )
set "FONTS="
if exist "%ROOT%\backend\app\fonts" set FONTS=--add-data "%ROOT%\backend\app\fonts;fonts"
cd backend
if exist build\pyinstaller rmdir /s /q build\pyinstaller
if exist dist-engine rmdir /s /q dist-engine
pyinstaller --noconfirm --clean --onefile --name formpdf-engine --distpath dist-engine --workpath build\pyinstaller --specpath build\pyinstaller --add-data "%ROOT%\frontend\dist;frontend_dist" --collect-submodules app --collect-submodules uvicorn --collect-all pptx --collect-all pdfplumber --hidden-import pypdfium2 %FONTS% "%ROOT%\backend\formpdf_engine.py" || exit /b 1
if not exist "%ROOT%\src-tauri\binaries" mkdir "%ROOT%\src-tauri\binaries"
copy /y dist-engine\formpdf-engine.exe "%ROOT%\src-tauri\binaries\formpdf-engine-%TRIPLE%.exe" >nul || exit /b 1
"%ROOT%\src-tauri\binaries\formpdf-engine-%TRIPLE%.exe" --selfcheck || exit /b 1
echo [formpdf] sidecar ready: %ROOT%\src-tauri\binaries\formpdf-engine-%TRIPLE%.exe
