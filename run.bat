@echo off
setlocal
cd /d "%~dp0"

python --version >nul 2>&1
if errorlevel 1 (
    echo Python 3.10 or newer is required.
    echo Download Python from https://www.python.org/downloads/
    echo Make sure to select "Add Python to PATH" during installation.
    pause
    exit /b 1
)

set "ECHO_OPEN_BROWSER=1"
echo Starting Echo Voice Studio. Keep this window open while you use it.
python app.py

echo.
echo Echo has stopped.
pause