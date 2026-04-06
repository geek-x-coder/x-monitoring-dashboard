@echo off
setlocal

cd /d "%~dp0"

echo ============================================================
echo   x-monitoring-be  Build Script
echo ============================================================
echo.

echo [1/5] Installing Python dependencies...
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: pip install failed.
    exit /b 1
)

echo.
echo [2/5] Building x-monitoring-be (onedir) with PyInstaller...
pyinstaller --noconfirm --clean x_monitoring_be.spec
if errorlevel 1 (
    echo ERROR: PyInstaller build failed.
    exit /b 1
)

echo.
echo [3/5] Flattening dist output to dist\...
:: PyInstaller onedir creates dist\x-monitoring-be\ — move contents up to dist\ directly
if exist "dist\x-monitoring-be" (
    xcopy /E /I /Y "dist\x-monitoring-be\*" "dist\"
    rmdir /S /Q "dist\x-monitoring-be"
)

echo.
echo [4/5] Copying editable runtime files to dist\...

:: config.json — operators can change DB connections, API endpoints, auth, etc.
copy /Y "config.json" "dist\config.json"

:: sql\ — SQL query files that can be edited without rebuilding
if exist "dist\sql" rmdir /S /Q "dist\sql"
xcopy /E /I /Q "sql" "dist\sql"

:: drivers\ — JDBC driver JARs (add/remove jars without rebuilding)
if exist "dist\drivers" rmdir /S /Q "dist\drivers"
xcopy /E /I /Q "drivers" "dist\drivers"

:: .env.example — environment variable reference
if exist ".env.example" copy /Y ".env.example" "dist\.env.example"

echo.
echo [5/5] Creating logs directory...
if not exist "dist\logs" mkdir "dist\logs"

echo.
echo ============================================================
echo   Build complete!
echo ============================================================
echo.
echo   Output folder : dist\
echo.
echo   x-monitoring-be.exe    - executable
echo   _internal\             - Python runtime (do not edit)
echo   config.json            - server / DB / API configuration
echo   sql\                   - SQL query files
echo   drivers\               - JDBC driver JARs
echo   logs\                  - log output directory
echo   .env.example           - environment variable reference
echo.
echo   Run:  dist\x-monitoring-be.exe
echo   Test: python exe_api_smoke_test.py
echo.
endlocal
