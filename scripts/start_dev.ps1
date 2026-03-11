# CRX Cloud - Start DEV environment
# Frontend: http://localhost:3001
# Backend:  http://localhost:8080
# DB:       localhost:5433

Write-Host "=== CRX Cloud DEV ===" -ForegroundColor Cyan
Write-Host "Starting dev environment..." -ForegroundColor Yellow

$env:APP_ENV = "dev"

docker compose -f docker-compose.yml up --build -d

Write-Host ""
Write-Host "CRX Cloud DEV running:" -ForegroundColor Green
Write-Host "  Panel:   http://localhost:3001" -ForegroundColor White
Write-Host "  API:     http://localhost:8080" -ForegroundColor White
Write-Host "  API Doc: http://localhost:8080/docs" -ForegroundColor White
Write-Host "  DB:      localhost:5433" -ForegroundColor White
Write-Host ""
Write-Host "Logs: docker compose logs -f" -ForegroundColor Gray
