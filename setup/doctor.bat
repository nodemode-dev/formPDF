@echo off
setlocal
cd /d "%~dp0.."
set "FAIL=0"
echo [formpdf] doctor, windows
where node >nul 2>nul && ( echo   ok     node ) || ( echo   FAIL   node, Node 20.19+ or 22.12+ is required & set "FAIL=1" )
where npm >nul 2>nul && ( echo   ok     npm ) || ( echo   FAIL   npm, install npm & set "FAIL=1" )
where py >nul 2>nul && ( echo   ok     python launcher ) || ( where python >nul 2>nul && ( echo   ok     python ) || ( echo   FAIL   python, Python 3.12+ is required & set "FAIL=1" ) )
set "VPY=backend\venv\Scripts\python.exe"
if exist "%VPY%" ( echo   ok     backend venv ) else ( echo   warn   backend venv, run formpdf.bat install )
if exist frontend\node_modules ( echo   ok     frontend node_modules ) else ( echo   warn   frontend deps, run formpdf.bat install )
if exist "%VPY%" for %%m in (pptx:python-pptx pypdf:pypdf pypdfium2:pypdfium2 pdfplumber:pdfplumber docx:python-docx openpyxl:openpyxl PIL:Pillow reportlab:reportlab) do call :module %%m
where cargo >nul 2>nul && ( echo   ok     rust for desktop builds ) || ( echo   warn   rust, desktop builds need https://rustup.rs )
if not defined FORMPDF_PORT set "FORMPDF_PORT=8198"
for %%p in (5198 %FORMPDF_PORT%) do call :port %%p
if "%FAIL%"=="0" ( echo [formpdf] ready ) else ( echo [formpdf] fix the FAIL lines above )
exit /b %FAIL%
:module
for /f "tokens=1,2 delims=:" %%a in ("%~1") do (
  "%VPY%" -c "import %%a" >nul 2>nul && ( echo   ok     %%b ) || ( echo   warn   %%b, missing from the venv, rerun formpdf.bat install )
)
exit /b 0
:port
netstat -an | findstr /r /c:":%~1 .*LISTENING" >nul && ( echo   warn   port %~1, already in use ) || ( echo   ok     port %~1 free )
exit /b 0
