@echo off
:: CRX Cloud - Deploy PROD su Hetzner
:: Apre una finestra separata, usa Git Bash (non WSL), pause alla fine.

if "%~1"=="--exec" goto :exec

:: Lancia se stesso in una NUOVA finestra
start "CRX Cloud Deploy PROD" "%~f0" --exec
goto :eof

:exec
cd /d "%~dp0"
echo.
echo ========================================
echo   CRX Cloud - Deploy PROD su Hetzner
echo ========================================
echo.
"C:\Program Files\Git\bin\bash.exe" scripts/deploy_prod.sh
echo.
echo ========================================
echo   Exit code: %ERRORLEVEL%
echo ========================================
echo.
pause
