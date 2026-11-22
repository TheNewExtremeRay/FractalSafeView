@echo off
setlocal
cd /d "%~dp0"

echo === Fractal SafeView build ===
echo Working dir: %CD%

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    exit /b 1
  )
)

rem Make NSIS (makensis) available if installed in the default location.
if exist "C:\Program Files (x86)\NSIS\makensis.exe" set "PATH=C:\Program Files (x86)\NSIS;%PATH%"
if exist "C:\Program Files\NSIS\makensis.exe" set "PATH=C:\Program Files\NSIS;%PATH%"

rem Verify makensis is reachable (non-fatal; installer compile is skipped if missing).
where makensis >nul 2>nul
if errorlevel 1 (
  echo WARNING: makensis not found. Only an unpacked build will be produced.
  echo Install NSIS and ensure it is on PATH to get an installer.
)

echo.
echo Building unpacked app...
call npm run dist
if errorlevel 1 (
  echo.
  echo BUILD FAILED.
  exit /b 1
)

rem Compile the custom NSIS installer.
where makensis >nul 2>nul
if errorlevel 1 (
  echo.
  echo WARNING: makensis not found; skipping installer compile.
  echo Install NSIS and re-run to produce the installer.
  goto :done
)

echo.
echo Compiling NSIS installer...
call makensis nsis\installer.nsi
if errorlevel 1 (
  echo.
  echo INSTALLER COMPILE FAILED.
  exit /b 1
)

echo.
echo BUILD COMPLETE. Output:
echo   Unpacked app: dist\win-unpacked\SafeView.exe
echo   Installer:     nsis\SafeView-1.0.0-Setup.exe

:done
endlocal