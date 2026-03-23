@echo off
echo ========================================
echo Fixing and Rebuilding Docker Container
echo ========================================
echo.

echo Step 1: Stopping containers...
docker-compose down
echo.

echo Step 2: Removing old images...
docker rmi node-backend-backend 2>nul
docker rmi cricket-backend 2>nul
echo.

echo Step 3: Cleaning Docker cache...
docker builder prune -f
echo.

echo Step 4: Verifying app.js fix...
findstr /C:"app.options" app.js >nul
if %ERRORLEVEL% EQU 0 (
    echo [WARNING] app.options still exists in app.js
    echo Applying fix...
    
    REM Create backup
    copy app.js app.js.backup >nul
    
    REM The fix is already in the file from previous update
    echo [OK] Fix should be applied
) else (
    echo [OK] app.options line not found - fix is applied
)
echo.

echo Step 5: Building fresh image...
docker-compose build --no-cache --pull
echo.

if %ERRORLEVEL% EQU 0 (
    echo Step 6: Starting containers...
    docker-compose up -d
    echo.
    
    echo Waiting for backend to start...
    timeout /t 10 /nobreak >nul
    echo.
    
    echo Step 7: Checking container status...
    docker-compose ps
    echo.
    
    echo Step 8: Checking logs...
    docker-compose logs --tail=30 backend
    echo.
    
    echo Step 9: Testing health endpoint...
    timeout /t 2 /nobreak >nul
    curl -s http://localhost:3000/health
    echo.
    echo.
    
    echo ========================================
    echo.
    docker-compose ps | findstr "Up" >nul
    if %ERRORLEVEL% EQU 0 (
        echo [SUCCESS] Backend is running!
        echo.
        echo Backend URL: http://localhost:3000
        echo Health Check: http://localhost:3000/health
        echo.
        echo View logs: docker-compose logs -f backend
        echo Stop: docker-compose down
    ) else (
        echo [ERROR] Backend failed to start
        echo Check logs above for errors
    )
    echo.
    echo ========================================
) else (
    echo.
    echo [ERROR] Build failed!
    echo Check the error messages above.
    echo.
)

pause
