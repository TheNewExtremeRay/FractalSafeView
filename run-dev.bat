@echo off
setlocal
cd /d "%~dp0"
set FRACTAL_ALLOW_DEV=1
call "%~dp0run.bat" %*