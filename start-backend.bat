@echo off
echo ========================================
echo Cricket Ultimate Manager - Backend
echo ========================================
echo.

REM Check if Redis is running
echo Checking Redis connection...
redis-cli ping >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Redis is not running!
    echo Please start Redis first:
    echo   - redis-server
    echo   - OR docker run -d -p 6379:6379 redis:latest
    echo.
    pause
    exit /b 1
)
echo [OK] Redis is running
echo.

REM Check if .env exists
if not exist .env (
    echo [WARNING] .env file not found!
    echo Copying from .env.example...
    copy .env.example .env
    echo.
    echo Please update .env with your Supabase credentials
    pause
)

REM Check if node_modules exists
if not exist node_modules (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting backend server...
echo.
echo Backend will run on: http://localhost:3000
echo Health check: http://localhost:3000/health
echo.
echo Press Ctrl+C to stop the server
echo.

npm start
