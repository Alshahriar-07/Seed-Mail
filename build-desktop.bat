@echo off
setlocal enableextensions
title Seed Code Mail - Build Windows Desktop App
cd /d "%~dp0"

REM Produces the two Windows x64 artifacts:
REM   desktop\release\Seed-Code-Mail-win64.exe     (portable, no install)
REM   desktop\release\Seed-Code-Mail-Setup.exe     (NSIS installer)
REM
REM The desktop application is a hardened shell around the DEPLOYED website
REM (https://mrseedmail.vercel.app). It does not bundle a frontend copy: the
REM window loads the production site, so the desktop UI is always the deployed
REM one and can never drift from it. It does bundle the campaign SMTP worker.
REM
REM It builds, in order:
REM   1. the public desktop config   -> desktop\generated\public-config.json
REM      (the public Supabase URL + publishable key the worker needs)
REM   2. the bundled SMTP worker     -> build\worker-dist\SeedMailWorker\  (PyInstaller)
REM   3. the Electron application    -> desktop\release\     (electron-builder)
REM
REM Requirements on THIS build machine only (the end user needs neither):
REM   Node.js 20+, Python 3.12+, and internet access for npm + electron-builder.
REM No secret is needed to build: no service-role key, no Google client secret and
REM no Gmail App Password is ever compiled into the application or the installer.

echo ============================================================
echo        SEED CODE MAIL - WINDOWS DESKTOP BUILD
echo ============================================================
echo.

where node >nul 2>nul || (echo [ERROR] Node.js not found on PATH.& pause & exit /b 1)
where python >nul 2>nul || (echo [ERROR] Python not found on PATH.& pause & exit /b 1)

echo [1/4] Generating the public desktop configuration...
pushd desktop
call npm install || (echo [ERROR] desktop npm install failed.& popd & pause & exit /b 1)
call npm run public-config || (echo [ERROR] public-config failed.& popd & pause & exit /b 1)

echo [2/4] Freezing the bundled SMTP worker (PyInstaller)...
call npm run build:worker || (echo [ERROR] worker build failed.& popd & pause & exit /b 1)

echo [3/4] Packaging the Electron application...
call npx electron-builder --win --x64 || (echo [ERROR] electron-builder failed.& popd & pause & exit /b 1)
popd

echo [4/4] Done.
echo.
echo   Portable : %CD%\desktop\release\Seed-Code-Mail-win64.exe
echo   Installer: %CD%\desktop\release\Seed-Code-Mail-Setup.exe
echo.
pause
endlocal
