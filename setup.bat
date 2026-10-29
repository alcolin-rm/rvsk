@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   VK - Soulseek Downloader - Setup
echo ============================================
echo.

REM ── Check Python ──
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python is not installed or not on PATH.
    echo.
    echo Download from: https://www.python.org/downloads/
    echo During install, check "Add Python to PATH".
    echo.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo [OK] Python %PYVER% detected.
echo.

REM ── Download sockseek.exe from GitHub ──
if not exist "%~dp0sockseek.exe" (
    echo [1/4] Downloading sockseek.exe from GitHub...
    echo.

    REM Query GitHub API for the latest release and find the Windows x64 asset.
    for /f "usebackq tokens=*" %%u in (`curl -s https://api.github.com/repos/fiso64/sockseek/releases/latest ^| findstr "browser_download_url" ^| findstr "win-x64"`) do (
        set "ASSET_URL=%%u"
    )

    if not defined ASSET_URL (
        echo [ERROR] Could not find a Windows x64 release of sockseek.
        echo        Check https://github.com/fiso64/sockseek/releases
        echo.
        pause
        exit /b 1
    )

    REM Extract just the URL from the JSON line ("browser_download_url": "https://...")
    set "ASSET_URL=!ASSET_URL:*browser_download_url": "=!"
    set "ASSET_URL=!ASSET_URL:"=!"
    set "ASSET_URL=!ASSET_URL:,=!"

    echo    URL: !ASSET_URL!
    curl -L -o "%~dp0sockseek.zip" "!ASSET_URL!"

    if errorlevel 1 (
        echo [ERROR] Download failed.
        pause
        exit /b 1
    )

    echo.
    echo    Extracting...
    powershell -Command "Expand-Archive -LiteralPath '%~dp0sockseek.zip' -DestinationPath '%~dp0sockseek_tmp' -Force"

    if errorlevel 1 (
        echo [ERROR] Extraction failed.
        pause
        exit /b 1
    )

    REM The zip contains a subfolder like sockseek-3.0.5-win-x64/. Move the exe up.
    for /r "%~dp0sockseek_tmp" %%f in (sockseek.exe) do (
        move /Y "%%f" "%~dp0sockseek.exe" >nul
    )

    REM Clean up
    rmdir /S /Q "%~dp0sockseek_tmp"
    del /Q "%~dp0sockseek.zip"

    if not exist "%~dp0sockseek.exe" (
        echo [ERROR] sockseek.exe not found after extraction.
        pause
        exit /b 1
    )
    echo [OK] sockseek.exe downloaded and extracted.
) else (
    echo [1/4] sockseek.exe already present.
)
echo.

REM ── Create virtual environment ──
if not exist "%~dp0.venv" (
    echo [2/4] Creating virtual environment...
    python -m venv "%~dp0.venv"
    if errorlevel 1 (
        echo [ERROR] Failed to create venv.
        pause
        exit /b 1
    )
) else (
    echo [2/4] Virtual environment already exists.
)
echo.

call "%~dp0.venv\Scripts\activate.bat"

REM ── Install requirements ──
echo [3/4] Installing dependencies...
python -m pip install --upgrade pip >nul
pip install -r "%~dp0requirements.txt"
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)
echo.

REM ── Create folders ──
echo [4/4] Creating folders...
if not exist "%~dp0downloads" mkdir "%~dp0downloads"
if not exist "%~dp0logs" mkdir "%~dp0logs"
if not exist "%~dp0sldl_input" mkdir "%~dp0sldl_input"
if not exist "%~dp0static" mkdir "%~dp0static"
echo.

echo ============================================
echo   Setup complete!
echo ============================================
echo.
echo To start the app, run: run.bat
echo Then open: http://127.0.0.1:8000
echo.

pause