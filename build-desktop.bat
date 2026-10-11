@echo off
setlocal enableextensions
title Seed Code Mail - Build Windows Desktop App
cd /d "%~dp0"

REM Produces the two Windows x64 artifacts:
REM   desktop\release\Seed-Code-Mail-win64.exe     (portable, no install)
REM   desktop\release\Seed-Code-Mail-Setup.exe     (NSIS installer)
REM
REM It builds, in order:
REM   1. the web frontend            -> dist\                (the UI the desktop shows)
REM   2. the public desktop config   -> desktop\generated\public-config.json
REM   3. the bundled SMTP worker     -> build\worker-dist\SeedMailWorker\  (PyInstaller)
REM   4. the Electron application    -> desktop\release\     (electron-builder)
REM
REM Requirements on THIS build machine only (the end user needs neither):
REM   Node.js 20+, Python 3.12+, and internet access for npm + electron-builder.
REM The service-role key is NOT needed to build: it is entered by the user at
REM first run and stored encrypted on their machine.

echo ============================================================
echo        SEED CODE MAIL - WINDOWS DESKTOP BUILD
echo ============================================================
echo.

where node >nul 2>nul || (echo [ERROR] Node.js not found on PATH.& pause & exit /b 1)
where python >nul 2>nul || (echo [ERROR] Python not found on PATH.& pause & exit /b 1)

echo [1/5] Building the web frontend (vite build)...
call npm install || (echo [ERROR] npm install failed.& pause & exit /b 1)
call npm run build || (echo [ERROR] vite build failed.& pause & exit /b 1)

echo [2/5] Generating the public desktop configuration...
pushd desktop
call npm install || (echo [ERROR] desktop npm install failed.& popd & pause & exit /b 1)
call npm run public-config || (echo [ERROR] public-config failed.& popd & pause & exit /b 1)

echo [3/5] Freezing the bundled SMTP worker (PyInstaller)...
call npm run build:worker || (echo [ERROR] worker build failed.& popd & pause & exit /b 1)

echo [4/5] Packaging the Electron application...
call npx electron-builder --win --x64 || (echo [ERROR] electron-builder failed.& popd & pause & exit /b 1)
popd

echo [5/5] Done.
echo.
echo   Portable : %CD%\desktop\release\Seed-Code-Mail-win64.exe
echo   Installer: %CD%\desktop\release\Seed-Code-Mail-Setup.exe
echo.
pause
endlocal
