@echo off
setlocal enableextensions enabledelayedexpansion
title Seed Code Mail - Local Agent

REM Always work from the folder this script lives in.
cd /d "%~dp0"

REM The agent listens on this port. It is a loopback port: only this computer can
REM reach it, and the agent itself refuses requests from any other website origin.
if "%WORKER_PORT%"=="" set "WORKER_PORT=8765"
set "AGENT_URL=http://127.0.0.1:%WORKER_PORT%"

echo ============================================================
echo            SEED CODE MAIL - LOCAL AGENT
echo ============================================================
echo.
echo   This window IS the agent. Keep it open while you send a
echo   campaign; close it (or press Ctrl+C) to stop the agent.
echo.
echo   What it does:
echo     * sends campaigns you queued on the website, over Gmail SMTP
echo     * listens on %AGENT_URL% - this computer only
echo.
echo   What still works WITHOUT it (no agent needed):
echo     * Inbox, Sent, reading and searching your Gmail
echo     * Compose and sending ordinary email
echo     * Recipients, templates, campaigns and history
echo.
echo   Nothing on the website can start this program for you. You
echo   run this file; the website only detects that it is running.
echo.

REM ----------------------------------------------------------------
REM 0. Use a portable build when one is present.
REM
REM    A packaged agent (SeedMailAgent\SeedMailAgent.exe) needs no
REM    Python at all, which is the friendliest option. Build it once
REM    with build-agent.bat, or download one if a release provides it.
REM ----------------------------------------------------------------
if exist "SeedMailAgent\SeedMailAgent.exe" (
    echo [1/3] Using the packaged agent ^(no Python needed^).
    goto :run_agent
)

REM ----------------------------------------------------------------
REM 1. Python
REM ----------------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found on your PATH.
    echo.
    echo         Install Python 3.12 or newer from
    echo             https://www.python.org/downloads/
    echo         and tick "Add python.exe to PATH" during installation,
    echo         then run this file again.
    echo.
    echo         Alternatively, build the standalone agent once with
    echo         build-agent.bat and this file will use it instead.
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('python --version 2^>^&1') do set "PYVER=%%v"
echo [1/3] Using !PYVER!

REM ----------------------------------------------------------------
REM 2. Dependencies -- offered, never installed silently.
REM ----------------------------------------------------------------
python -c "import fastapi, uvicorn, dotenv, pydantic, httpx" >nul 2>nul
if errorlevel 1 (
    echo.
    echo [2/3] The required Python packages are not installed yet.
    echo       They are the packages listed in requirements.txt.
    echo.
    set "INSTALL="
    set /p "INSTALL=Install them now with 'python -m pip install -r requirements.txt'? [y/N] "
    if /i not "!INSTALL!"=="y" (
        echo.
        echo       Cancelled. To install them yourself, run:
        echo           python -m pip install -r requirements.txt
        echo.
        pause
        exit /b 1
    )
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo [ERROR] The install did not finish. Fix the message above and try again.
        pause
        exit /b 1
    )
) else (
    echo [2/3] Dependencies OK
)

REM ----------------------------------------------------------------
REM 3. Optional pairing
REM
REM    With a pairing token set, only a browser that has been given
REM    the token may drive this agent - a second lock on top of the
REM    signed-in account check. Off unless you ask for it.
REM ----------------------------------------------------------------
if "%WORKER_AGENT_TOKEN%"=="" (
    echo.
    set "PAIR="
    set /p "PAIR=Require a pairing token? (recommended if you share this PC) [y/N] "
    if /i "!PAIR!"=="y" (
        for /f "delims=" %%t in ('python -c "import secrets;print(secrets.token_urlsafe(24))"') do set "WORKER_AGENT_TOKEN=%%t"
        echo.
        echo   Pairing token generated. Copy it into the website's
        echo   Local Agent panel (Settings) to pair this browser:
        echo.
        echo       !WORKER_AGENT_TOKEN!
        echo.
    )
)

:run_agent
echo [3/3] Starting the agent on %AGENT_URL%
echo.
echo   Leave this window open. The website reports the agent
echo   automatically - open Settings and choose "Check for local agent".
echo.
echo   Press Ctrl+C to stop.
echo ============================================================
echo.

if exist "SeedMailAgent\SeedMailAgent.exe" (
    "SeedMailAgent\SeedMailAgent.exe"
) else (
    python worker\main.py
)

echo.
echo The local agent has stopped. Campaigns stay queued and will be
echo delivered the next time it runs.
pause
endlocal
