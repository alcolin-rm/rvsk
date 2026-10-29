@echo off
setlocal

if not exist "%~dp0.venv\Scripts\activate.bat" (
    echo [ERROR] Virtual environment not found.
    echo Run setup.bat first.
    pause
    exit /b 1
)

call "%~dp0.venv\Scripts\activate.bat"
cd /d "%~dp0"
python main.py
pause