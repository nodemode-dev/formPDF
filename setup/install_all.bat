@echo off
setlocal
cd /d "%~dp0.."
echo [formpdf] installing backend
pushd backend
call oc_install.bat %* || ( popd & exit /b 1 )
popd
echo [formpdf] installing frontend
pushd frontend
call oc_install.bat %* || ( popd & exit /b 1 )
popd
echo [formpdf] done. Boot with formpdf.bat
