@echo off
setlocal enableextensions
title Seed Code Mail - Build Local Agent

REM Builds a standalone Windows agent with PyInstaller, so the person sending
REM campaigns does not need Python installed at all.
REM
REM   build-agent.bat        -> SeedMailAgent\SeedMailAgent.exe
REM
REM Then start-agent.bat picks the packaged build up automatically.
REM
REM This is optional: `python worker/main.py` (or start-agent.bat with Python
REM installed) runs the identical agent. The reasons to package it are a machine
REM with no Python, or a distribution where a single folder is easier to hand
REM over than a source checkout.
REM
REM Reproducibility notes, because they matter when a build fails:
REM   * PyInstaller is version-agnostic but the *hidden imports* are not: FastAPI,
REM     uvicorn, pydantic, dotenv and httpx all load parts of themselves lazily,
REM     which static analysis cannot see. --collect-all is used for each, which
REM     is the documented remedy.
REM   * `worker` and `services` are imported through a `sys.path` insertion at
REM     runtime (see worker/main.py), which PyInstaller cannot follow. They are
REM     passed explicitly with --hidden-import.
REM   * --onedir, not --onefile: a single-file build unpacks to a temporary
REM     directory on every start, which is slow for a long-running agent and can
REM     trip antivirus heuristics. The onedir output is a folder to copy.

cd /d "%~dp0"

echo ============================================================
echo         BUILD THE STANDALONE LOCAL AGENT
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found on your PATH. Install Python 3.12+
    echo         from https://www.python.org/downloads/ and tick
    echo         "Add python.exe to PATH".
    pause
    exit /b 1
)

echo [1/3] Checking PyInstaller...
python -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
    echo       PyInstaller is not installed.
    set "INSTALL="
    set /p "INSTALL=Install it now with 'python -m pip install pyinstaller'? [y/N] "
    if /i not "%INSTALL%"=="y" (
        echo       Cancelled.
        pause
        exit /b 1
    )
    python -m pip install pyinstaller
    if errorlevel 1 (
        echo [ERROR] Could not install PyInstaller.
        pause
        exit /b 1
    )
)
echo       OK

echo [2/3] Installing runtime dependencies...
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Dependency install failed.
    pause
    exit /b 1
)

echo [3/3] Building SeedMailAgent.exe (this takes a minute)...
REM --distpath . puts the result at .\SeedMailAgent\, which start-agent.bat
REM already looks for. The work and spec paths are kept out of the repository
REM root so a build leaves only the one folder behind. (`dist/` belongs to the
REM Vite web build and is deliberately not reused here.)
python -m PyInstaller ^
  --noconfirm --clean --onedir ^
  --name SeedMailAgent ^
  --distpath . ^
  --workpath build\agent ^
  --specpath build\agent ^
  --paths "." ^
  --hidden-import worker ^
  --hidden-import worker.main ^
  --hidden-import worker.queue_worker ^
  --hidden-import worker.sender ^
  --hidden-import worker.campaign_queue ^
  --hidden-import worker.supabase_client ^
  --hidden-import worker.settings_overrides ^
  --hidden-import worker.auth ^
  --hidden-import worker.security ^
  --hidden-import worker.config ^
  --hidden-import services ^
  --collect-all fastapi ^
  --collect-all starlette ^
  --collect-all uvicorn ^
  --collect-all pydantic ^
  --collect-all dotenv ^
  --collect-all httpx ^
  --collect-all anyio ^
  --collect-all ssl ^
  worker\main.py

if errorlevel 1 (
    echo.
    echo [ERROR] The build failed. Read the PyInstaller output above.
    echo         A common cause is a missing --collect-all for a package whose
    echo         import is deferred; add it and run this script again.
    pause
    exit /b 1
)

echo.
echo Done. The standalone agent is at:
echo     %CD%\SeedMailAgent\SeedMailAgent.exe
echo.
echo Copy that whole SeedMailAgent folder to the machine that will send
echo campaigns, then run SeedMailAgent.exe there (or start-agent.bat, which
echo prefers it automatically).
echo.
pause
endlocal
