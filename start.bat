@echo off
setlocal enableextensions
title Seed Code Mail

REM Always work from the folder this script lives in.
cd /d "%~dp0"

set "APP_PORT=%APP_PORT%"
if "%APP_PORT%"=="" set "APP_PORT=8000"
set "APP_URL=http://127.0.0.1:%APP_PORT%"
set "WORKER_PORT=%WORKER_PORT%"
if "%WORKER_PORT%"=="" set "WORKER_PORT=8765"

echo ============================================================
echo                    SEED CODE MAIL
echo ============================================================
echo.
echo   The hosted website (https://mrseedmail.vercel.app/) talks to Supabase.
echo   Emails are sent by the SEND WORKER, which must run on the machine
echo   that owns the Gmail account. This launcher starts:
echo.
echo     1. the send worker         -^> http://127.0.0.1:%WORKER_PORT%
echo     2. a local copy of the app -^> %APP_URL%
echo.
echo   You can use the hosted site instead of (2); the worker is the part
echo   that has to be running locally to send mail.
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
echo [1/4] Using %PYVER%

REM 2. Check that dependencies are installed (does NOT install automatically).
python -c "import fastapi, uvicorn, dotenv, pydantic, httpx" >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Required packages are missing.
    echo         Install them by running:
    echo.
    echo             python -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)
echo [2/4] Dependencies OK

REM 3. Build the web app once, if the bundle is missing.
if not exist "dist\index.html" (
    where npm >nul 2>nul
    if errorlevel 1 (
        echo [3/4] [WARN] No frontend build found and npm is unavailable.
        echo            Open https://mrseedmail.vercel.app/ in your browser instead,
        echo            or install Node.js and run:  npm install ^&^& npm run build
    ) else (
        echo [3/4] Building the web app for the first time ^(one-off^)...
        if not exist "node_modules" call npm install
        call npm run build
    )
) else (
    echo [3/4] Frontend build found
)

REM 4. Start the send worker in its own window, then serve the app locally.
echo [4/4] Starting the send worker and the local web server...
echo.
echo     Close the "Seed Code Mail worker" window to stop sending.
echo     Press Ctrl+C in THIS window to stop the local web server.
echo.

start "Seed Code Mail worker" cmd /k python worker\main.py
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" "%APP_URL%""

python app.py

echo.
echo Seed Code Mail has stopped.
pause
endlocal
