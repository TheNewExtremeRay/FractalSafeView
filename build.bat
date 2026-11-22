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

echo.
echo Building (Squirrel installer)...
call npm run dist
if errorlevel 1 (
  echo.
  echo BUILD FAILED.
  exit /b 1
)

echo.
echo BUILD COMPLETE. Output is in the "dist" folder.
endlocal