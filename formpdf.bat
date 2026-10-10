@echo off
setlocal
set "FORMPDF_CALLER_DIR=%cd%"
cd /d "%~dp0"
set "CMD=%~1"
set "ARG=%~2"
set "REST="
set "REST2="
set "SEEN=0"
:collect
shift
if "%~1"=="" goto :dispatch
set REST=%REST% %1
if "%SEEN%"=="1" set REST2=%REST2% %1
set "SEEN=1"
goto :collect
:dispatch
if "%CMD%"=="" set "CMD=boot"
if /i "%CMD%"=="boot" ( call setup\boot_all.bat %REST% & goto :eof )
if /i "%CMD%"=="dev" ( call setup\boot_all.bat %REST% & goto :eof )
if /i "%CMD%"=="install" ( call setup\install_all.bat %REST% & goto :eof )
if /i "%CMD%"=="install-desktop" ( call setup\install_desktop.bat %REST% & goto :eof )
if /i "%CMD%"=="backend" ( call setup\boot_backend.bat %REST% & goto :eof )
if /i "%CMD%"=="frontend" ( call setup\boot_frontend.bat %REST% & goto :eof )
if /i "%CMD%"=="build" ( call setup\build_frontend.bat %REST% & goto :eof )
if /i "%CMD%"=="serve" ( call setup\serve.bat %REST% & goto :eof )
if /i "%CMD%"=="freeze" ( call setup\freeze_backend.bat %REST% & goto :eof )
if /i "%CMD%"=="desktop" (
  if "%ARG%"=="" ( call setup\desktop_dev.bat & goto :eof )
  if /i "%ARG%"=="dev" ( call setup\desktop_dev.bat %REST2% & goto :eof )
  if /i "%ARG%"=="build" ( call setup\desktop_build.bat %REST2% & goto :eof )
  call :usage
  exit /b 2
)
if /i "%CMD%"=="doctor" ( call setup\doctor.bat %REST% & goto :eof )
if /i "%CMD%"=="mcp" ( python setup\mcp_stdio.py %REST% & goto :eof )
if /i "%CMD%"=="agents" ( python setup\agents.py %REST% & goto :eof )
if /i "%CMD%"=="run" ( call setup\run.bat %REST% & goto :eof )
if /i "%CMD%"=="clean" ( call setup\clean.bat %REST% & goto :eof )
if /i "%CMD%"=="help" ( call :usage & exit /b 0 )
if /i "%CMD%"=="-h" ( call :usage & exit /b 0 )
if /i "%CMD%"=="--help" ( call :usage & exit /b 0 )
echo [formpdf] unknown command: %CMD%
echo.
call :usage
exit /b 2
:usage
set "VER="
for /f "tokens=2 delims='" %%v in ('findstr /b /c:"export const VERSION" frontend\src\version.ts 2^>nul') do set "VER=%%v"
echo formpdf %VER%, PDF editor
echo.
echo usage: formpdf.bat [command] [options]
echo.
echo   (none) ^| boot       boot backend (8198) and frontend (5198) together
echo   install             install backend and frontend
echo   install-desktop     install PyInstaller and check the Rust and Tauri toolchain
echo   backend             boot the backend only
echo   frontend            boot the frontend only
echo   build               production build of the frontend into frontend\dist
echo   serve               serve the built frontend from the backend on 127.0.0.1:8198
echo   freeze              freeze the backend into the Tauri sidecar binary
echo   desktop dev^|build   run or bundle the desktop app
echo   doctor              check the toolchain, installs and ports
echo   mcp                 formpdf over MCP's stdio transport, for Claude Desktop and other MCP clients
echo   agents install^|sync set up Claude Code, Codex and Cursor (install), or refresh the skills (sync)
echo   run ^<action^> [args] a PDF job headlessly, without the window (formpdf.bat run actions lists them)
echo   clean [--all]       remove build output (--all also venv and node_modules)
echo   help                this text
exit /b 0
