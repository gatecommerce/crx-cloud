# CRX Cloud - Start PROD environment
# Frontend: http://localhost:3000
# Backend:  http://localhost:8080

Write-Host "=== CRX Cloud PROD ===" -ForegroundColor Green
Write-Host "Starting production environment..." -ForegroundColor Yellow

$env:APP_ENV = "prod"

docker compose -f docker-compose.prod.yml up --build -d

Write-Host ""
Write-Host "CRX Cloud PROD running:" -ForegroundColor Green
Write-Host "  Panel:   http://localhost:3000" -ForegroundColor White
Write-Host "  API:     http://localhost:8080" -ForegroundColor White
Write-Host "  API Doc: http://localhost:8080/docs" -ForegroundColor White
Write-Host ""
Write-Host "Logs: docker compose -f docker-compose.prod.yml logs -f" -ForegroundColor Gray
