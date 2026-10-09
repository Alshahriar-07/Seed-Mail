@echo off
setlocal enableextensions
title Seed Code Mail

REM Always work from the folder this script lives in.
cd /d "%~dp0"

set "APP_PORT=%APP_PORT%"
if "%APP_PORT%"=="" set "APP_PORT=8000"
set "APP_URL=http://127.0.0.1:%APP_PORT%"

echo ============================================================
echo                    SEED CODE MAIL
echo ============================================================
echo.

REM 1. Check that Python is available.
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found on your PATH.
    echo         Install Python 3.12+ from https://www.python.org/downloads/
    echo         and tick "Add python.exe to PATH" during installation.
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('python --version 2^>^&1') do set "PYVER=%%v"
echo [1/3] Using %PYVER%

REM 2. Check that dependencies are installed (does NOT install automatically).
python -c "import fastapi, uvicorn, dotenv, pydantic" >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Required packages are missing.
    echo         Install them by running:
    echo.
    echo             python -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)
echo [2/3] Dependencies OK

REM 3. Start the server and open the browser once it is ready.
echo [3/3] Starting server at %APP_URL%
echo.
echo     Press Ctrl+C in this window to stop the application.
echo.

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" "%APP_URL%""

python app.py

echo.
echo Seed Code Mail has stopped.
pause
endlocal
