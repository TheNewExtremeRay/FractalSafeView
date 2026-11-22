@echo off
setlocal
cd /d "%~dp0"

REM Always run from source so the latest code is used.
if exist "%~dp0node_modules\.bin\electron.cmd" (
  "%~dp0node_modules\.bin\electron.cmd" "%~dp0." %*
  goto :eof
)

echo Electron not found. Run "npm install" first.
pause