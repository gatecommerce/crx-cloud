<# :
@echo off
copy /y "%~f0" "%TEMP%\%~n0.ps1" >nul
powershell -ExecutionPolicy Bypass -NoProfile -File "%TEMP%\%~n0.ps1" %*
del "%TEMP%\%~n0.ps1" >nul 2>&1
pause
goto :eof
#>

# ============================================================
# CRX Cloud - Avvia ambiente DEV (sviluppo)
# ============================================================
# Frontend: 3001 | Backend API: 8080 | DB: 5433
# Docker Compose con hot-reload
# ============================================================

$projectDir = "c:\Users\Ciruz\Desktop\azure\crx-cloud-dev"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CRX Cloud - Ambiente DEV" -ForegroundColor Cyan
Write-Host "  Frontend:  http://localhost:3001" -ForegroundColor DarkCyan
Write-Host "  Backend:   http://localhost:8080" -ForegroundColor DarkCyan
Write-Host "  Database:  localhost:5433" -ForegroundColor DarkCyan
Write-Host "  Branch:    dev" -ForegroundColor DarkCyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ==============================================================
#  FASE 1: CLEANUP
# ==============================================================
Write-Host "[CLEANUP] Stopping existing containers..." -ForegroundColor Yellow

Set-Location $projectDir
docker compose down --remove-orphans 2>$null

# Kill processi orfani sulle porte DEV
foreach ($port in @(3001, 8080, 5433)) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        Write-Host "  Kill PID $($conn.OwningProcess) (port $port)" -ForegroundColor Yellow
        taskkill /T /F /PID $conn.OwningProcess 2>$null | Out-Null
    }
}

Start-Sleep -Seconds 1
Write-Host "[CLEANUP] Done." -ForegroundColor Green
Write-Host ""

# ==============================================================
#  FASE 2: AVVIO DOCKER COMPOSE
# ==============================================================
Write-Host "[START] Docker Compose (build + up)..." -ForegroundColor Green
Write-Host ""

Set-Location $projectDir
docker compose up --build
