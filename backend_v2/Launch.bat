@echo off
COLOR 0A
echo ===================================================
echo   IGNITING V2 DEV ENVIRONMENT (LIVE RELOAD)
echo ===================================================

:: Set the project root directory (parent of backend_v2)
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"

:: 0. Seed fraud rules safely (adds missing rules, preserves saved UI settings)
echo Seeding fraud rule configs (safe preserve mode)...
python -m backend_v2.scripts.seed_fraud_rules
echo.

:: 1. Build frontend if needed, then start dev server
echo Building frontend...
if not exist "node_modules" (
    echo Installing npm dependencies...
    call npm install
)
if not exist "static\dist\assets\main.js" (
    echo Building frontend assets...
    call npm run build
)
echo Launching React Live Dev Server...
start "Frontend (Live)" cmd /k "npm run dev"

:: 2. Navigate to Fraud Engine and start Backend
echo Launching Fraud Engine V2 (Port 5001)...
start "Fraud Engine" cmd /k "title Fraud Engine && python -m backend_v2.service_fraud"

:: 3. Navigate to Fraud Engine and start Reports V2
echo Launching Reporting Service V2 (Port 5000)...
start "Reporting API" cmd /k "python -m backend_v2.service_reports"

echo.
echo All engines launched! 
echo Open your browser to http://localhost:5001
echo.
exit