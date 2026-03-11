<# :
@echo off
copy /y "%~f0" "%TEMP%\%~n0.ps1" >nul
powershell -ExecutionPolicy Bypass -NoProfile -File "%TEMP%\%~n0.ps1" %*
del "%TEMP%\%~n0.ps1" >nul 2>&1
pause
goto :eof
#>

# ============================================================
# CRX Cloud - Avvia ambiente PROD (locale)
# ============================================================
# Frontend: 3000 | Backend API: 8080 | DB: 5432
# Docker Compose PROD (no hot-reload)
# ============================================================

$projectDir = "c:\Users\Ciruz\Desktop\azure\crx-cloud"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  CRX Cloud - Ambiente PROD" -ForegroundColor Green
Write-Host "  Frontend:  http://localhost:3000" -ForegroundColor DarkGreen
Write-Host "  Backend:   http://localhost:8080" -ForegroundColor DarkGreen
Write-Host "  Database:  localhost:5432" -ForegroundColor DarkGreen
Write-Host "  Branch:    main" -ForegroundColor DarkGreen
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# ==============================================================
#  FASE 1: CLEANUP
# ==============================================================
Write-Host "[CLEANUP] Stopping existing containers..." -ForegroundColor Yellow

Set-Location $projectDir
docker compose -f docker-compose.prod.yml down --remove-orphans 2>$null

foreach ($port in @(3000, 8080, 5432)) {
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
#  FASE 2: AVVIO DOCKER COMPOSE PROD
# ==============================================================
Write-Host "[START] Docker Compose PROD (build + up)..." -ForegroundColor Green
Write-Host ""

Set-Location $projectDir
docker compose -f docker-compose.prod.yml up --build -d

# ==============================================================
#  FASE 3: HEALTH CHECK
# ==============================================================
Write-Host ""
Write-Host "[HEALTH] Waiting for services..." -ForegroundColor Cyan
$maxWait = 60
$waited = 0
while ($waited -lt $maxWait) {
    try {
        $res = Invoke-WebRequest -Uri "http://localhost:8080/health" -TimeoutSec 3 -ErrorAction Stop
        if ($res.StatusCode -eq 200) {
            Write-Host "  Backend ready after ${waited}s" -ForegroundColor Green
            break
        }
    } catch {}
    Start-Sleep -Seconds 3
    $waited += 3
    Write-Host "  Waiting... ${waited}s" -ForegroundColor DarkCyan
}

if ($waited -ge $maxWait) {
    Write-Host "  WARNING: Backend not ready after ${maxWait}s" -ForegroundColor Red
    Write-Host "  Check: docker compose -f docker-compose.prod.yml logs backend" -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  PROD environment running!" -ForegroundColor Green
Write-Host "  docker compose -f docker-compose.prod.yml logs -f" -ForegroundColor DarkGreen
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
