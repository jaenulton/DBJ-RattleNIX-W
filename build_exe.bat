@echo off
title Building DBJ RattleNIX Windows Executable
echo ===================================================
echo     DBJ RattleNIX - Windows Standalone Packager
echo ===================================================
echo.

REM 1. Ensure Python dependencies are installed
echo [*] Checking and installing Python dependencies...
python -m pip install --upgrade pip
python -m pip install numpy sounddevice aiohttp pyinstaller
if %errorlevel% neq 0 (
    echo [!] Failed to install Python dependencies. Please check Python installation.
    pause
    exit /b %errorlevel%
)

REM 2. Compile native C++ modem binaries with MinGW or MSVC if needed
if not exist "bin\encode.exe" (
    echo [*] Checking for C++ compiler...
    where g++ >nul 2>nul
    if %errorlevel% equ 0 (
        echo [*] Compiling C++ COFDM modem binaries with g++...
        g++ -O3 -std=c++17 src\encode.cpp -o bin\encode.exe
        g++ -O3 -std=c++17 src\decode_stream.cpp -o bin\decode_stream.exe
    ) else (
        where cl >nul 2>nul
        if %errorlevel% equ 0 (
            echo [*] Compiling with MSVC cl.exe...
            cl /O2 /std:c++17 src\encode.cpp /Fe:bin\encode.exe
            cl /O2 /std:c++17 src\decode_stream.cpp /Fe:bin\decode_stream.exe
        )
    )
)

REM 3. Package complete standalone .EXE via PyInstaller
echo.
echo [*] Bundling DBJ RattleNIX into a single self-contained executable...
python -m PyInstaller ^
    --name="DBJ_RattleNIX" ^
    --onefile ^
    --windowed ^
    --icon="web\static\icon.svg" ^
    --add-data "web\static;web\static" ^
    --add-data "bin;bin" ^
    --add-data "morse_decoder.py;." ^
    rattlegram_win.py

if %errorlevel% equ 0 (
    echo.
    echo ===================================================
    echo [SUCCESS] Standalone EXE created in: dist\DBJ_RattleNIX.exe
    echo ===================================================
) else (
    echo.
    echo [!] PyInstaller packaging encountered an error.
)

pause
