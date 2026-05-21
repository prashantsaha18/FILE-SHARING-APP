@echo off
title FileVault - File Server
color 0B
echo.
echo ============================================
echo   FileVault - Secure File Server
echo ============================================
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo Please download it from: https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if node_modules doesn't exist
if not exist "node_modules\" (
    echo [*] Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo [*] Dependencies installed!
    echo.
)

echo [*] Starting FileVault server...
echo [*] Open your browser at: http://localhost:3000
echo [*] Default login: admin / admin123
echo.
echo Press Ctrl+C to stop the server.
echo.

node server.js
pause
