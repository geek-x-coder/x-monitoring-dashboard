@echo off
REM ============================================================
REM  IIS 단일 사이트 배포 스크립트
REM  - Frontend 빌드 (IIS 모드, .env.iis 적용)
REM  - web.config을 빌드 출력 폴더에 복사
REM ============================================================

echo [1/2] Frontend 빌드 중 (IIS 모드)...
cd x-monitoring-fe
call npm run build:iis
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Frontend 빌드 실패
    exit /b 1
)
cd ..

echo [2/2] web.config 복사 중...
copy /Y web.config x-monitoring-fe\dist\web.config
if %ERRORLEVEL% neq 0 (
    echo [ERROR] web.config 복사 실패
    exit /b 1
)

echo.
echo ============================================================
echo  배포 폴더: %CD%\x-monitoring-fe\dist
echo.
echo  IIS 설정 방법:
echo    1. IIS Manager에서 사이트 추가
echo    2. 물리 경로: %CD%\x-monitoring-fe\dist
echo    3. 원하는 포트로 바인딩 (예: 80, 8080)
echo    4. Flask 백엔드 별도 실행: python x-monitoring-be\x_monitoring_be.py
echo ============================================================
