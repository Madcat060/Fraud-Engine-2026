@echo off
setlocal EnableExtensions
REM Modes:
REM   default              -> bootstrap new machine and launch app services
REM   INSTALL_ONLY=1       -> bootstrap only, do not launch
REM   BUILD_EXE=1          -> build dist\ReportManager.exe (legacy behavior)
REM Optional:
REM   SKIP_PIP=1 SKIP_NPM=1 SKIP_SEED=1 SKIP_FRONTEND_BUILD=1 CLEAN=1

cd /d "%~dp0"

echo ============================================
echo   Fraud Engine 2026 - Windows Bootstrap
echo ============================================
echo.

set "PYTHON_CMD="
set "PIP_PYTHON="

REM Prefer Python launcher
py --version >nul 2>&1
if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
    set "PIP_PYTHON=py -3"
    goto :python_ready
)

REM Fallback to python in PATH (prefer base interpreter, skip .venv and WindowsApps shim)
for /f "delims=" %%I in ('where python 2^>nul') do (
    echo %%~fI | findstr /i /c:"\.venv\Scripts\python.exe" >nul
    if errorlevel 1 (
        echo %%~fI | findstr /i /c:"\WindowsApps\python.exe" >nul
        if errorlevel 1 (
            set "PYTHON_CMD=%%~fI"
            set "PIP_PYTHON=%%~fI"
            goto :python_ready
        )
    )
)

REM Fallback to common install locations
for %%P in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python39\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python38\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
    "C:\Python310\python.exe"
    "C:\Python39\python.exe"
    "C:\Python38\python.exe"
) do (
    if exist %%P (
        set "PYTHON_CMD=%%~fP"
        set "PIP_PYTHON=%%~fP"
        goto :python_ready
    )
)

echo Could not find a suitable Python automatically.
echo NOTE: Microsoft Store shim paths like WindowsApps\python.exe are not supported.
set /p PIP_PYTHON="Paste full path to python.exe (Python.org install): "
if not exist "%PIP_PYTHON%" (
    echo ERROR: That python path does not exist.
    pause
    exit /b 1
)
echo %PIP_PYTHON% | findstr /i /c:"\WindowsApps\python.exe" >nul
if not errorlevel 1 (
    echo ERROR: WindowsApps python shim detected. Please use a real python.exe path (e.g. LocalAppData\Programs\Python\Python312\python.exe).
    pause
    exit /b 1
)
set "PYTHON_CMD=%PIP_PYTHON%"

:python_ready
echo Using Python: %PIP_PYTHON%
%PIP_PYTHON% --version
echo.

if "%BUILD_EXE%"=="1" goto :build_exe_mode

REM ---------- Bootstrap mode ----------
if not exist ".venv\Scripts\python.exe" (
    echo Step 1/6: Creating virtual environment...
    %PIP_PYTHON% -m venv .venv
    if errorlevel 1 (
        echo ERROR: Failed to create .venv
        pause
        exit /b 1
    )
) else (
    echo Step 1/6: Virtual environment already exists.
    REM If this folder was copied from another PC, the venv launcher can point to a dead Python path.
    ".venv\Scripts\python.exe" --version >nul 2>&1
    if errorlevel 1 (
        echo Existing .venv is invalid on this machine. Recreating .venv...
        rmdir /s /q ".venv"
        %PIP_PYTHON% -m venv .venv
        if errorlevel 1 (
            echo ERROR: Failed to recreate .venv
            pause
            exit /b 1
        )
    )
)
echo.

set "VENV_PY=.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo ERROR: Missing venv python at %VENV_PY%
    pause
    exit /b 1
)

if "%SKIP_PIP%"=="1" (
    echo Step 2/6: Skipping Python dependency install ^(SKIP_PIP=1^).
) else (
    echo Step 2/6: Installing Python dependencies...
    "%VENV_PY%" -m pip install --upgrade pip
    if errorlevel 1 (
        echo Pip upgrade failed in existing venv. Recreating .venv and retrying once...
        rmdir /s /q ".venv"
        %PIP_PYTHON% -m venv .venv
        if errorlevel 1 (
            echo ERROR: Failed to recreate .venv
            pause
            exit /b 1
        )
        "%VENV_PY%" -m pip install --upgrade pip
        if errorlevel 1 (
            echo ERROR: pip upgrade failed after venv recreation.
            pause
            exit /b 1
        )
    )
    "%VENV_PY%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo ERROR: Failed to install Python dependencies.
        pause
        exit /b 1
    )
)
echo.

where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm was not found. Install Node.js LTS, then run build.bat again.
    pause
    exit /b 1
)

if "%SKIP_NPM%"=="1" (
    echo Step 3/6: Skipping npm install ^(SKIP_NPM=1^).
) else (
    echo Step 3/6: Installing frontend dependencies...
    call npm install
    if errorlevel 1 (
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
)
echo.

if "%SKIP_FRONTEND_BUILD%"=="1" (
    echo Step 4/6: Skipping frontend build ^(SKIP_FRONTEND_BUILD=1^).
) else (
    echo Step 4/6: Building frontend assets...
    call npm run build
    if errorlevel 1 (
        echo ERROR: Frontend build failed.
        pause
        exit /b 1
    )
)
echo.

if "%SKIP_SEED%"=="1" (
    echo Step 5/6: Skipping fraud rule seed ^(SKIP_SEED=1^).
) else (
    echo Step 5/6: Seeding fraud rules...
    "%VENV_PY%" -m backend_v2.scripts.seed_fraud_rules
    if errorlevel 1 (
        echo WARNING: Rule seed failed. Continuing...
    )
)
echo.

if "%INSTALL_ONLY%"=="1" (
    echo Step 6/6: Install complete ^(INSTALL_ONLY=1, no launch^).
    echo.
    echo Start services later with:
    echo   .venv\Scripts\python -m backend_v2.service_fraud
    echo   .venv\Scripts\python -m backend_v2.service_reports
    pause
    exit /b 0
)

echo Step 6/6: Launching services in new windows...
start "Fraud Engine (5001)" cmd /k "cd /d \"%~dp0\" && .venv\Scripts\python -m backend_v2.service_fraud"
start "Reports API (5000)" cmd /k "cd /d \"%~dp0\" && .venv\Scripts\python -m backend_v2.service_reports"
echo.
echo Bootstrap complete.
echo Open: http://localhost:5001
pause
exit /b 0

:build_exe_mode
echo BUILD_EXE=1 detected - running executable build flow...
echo.

if "%SKIP_PIP%"=="1" (
    echo Skipping pip install ^(SKIP_PIP=1^).
) else (
    echo Installing Python packages for EXE build...
    %PIP_PYTHON% -m pip install --upgrade pip
    %PIP_PYTHON% -m pip install -r requirements.txt
    if errorlevel 1 (
        echo ERROR: Failed to install packages.
        pause
        exit /b 1
    )
)

if "%CLEAN%"=="1" (
    echo Cleaning old build artifacts...
    if exist "dist" rmdir /s /q "dist"
    if exist "build" rmdir /s /q "build"
    if exist "ReportManager.spec" del "ReportManager.spec"
)

echo Building executable...
%PYTHON_CMD% build_exe.py
if errorlevel 1 (
    echo ERROR: EXE build failed.
    pause
    exit /b 1
)

echo ============================================
echo   BUILD COMPLETE
echo ============================================
echo Output: dist\ReportManager.exe
pause
