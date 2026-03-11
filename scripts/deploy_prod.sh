#!/bin/bash
# CRX Cloud - Deploy PROD su Hetzner
# Usage: bash scripts/deploy_prod.sh
set -euo pipefail
trap 'echo ""; echo "=== ERRORE: deploy fallito alla riga $LINENO (exit code $?) ==="' ERR

SERVER="crx-prod"
COMPOSE_FILE="docker-compose.prod.yml"

echo "=== Deploy CRX Cloud PROD su Hetzner ==="
echo ""

# --- Deploy remoto ---
echo "[1/4] Git pull & build on server..."
ssh "$SERVER" "bash -s" << 'REMOTE'
set -e

# Crea directory se non esiste
if [ ! -d /opt/crx-cloud ]; then
  echo "  First deploy: cloning repo..."
  cd /opt
  git clone https://github.com/gatecommerce/crx-cloud.git
fi

cd /opt/crx-cloud
COMPOSE_FILE="docker-compose.prod.yml"

echo "  git pull..."
git pull origin main

# Crea .env se non esiste
if [ ! -f .env ]; then
  echo "  Creating .env with secure defaults..."
  DB_PASS=$(openssl rand -hex 16)
  SECRET=$(openssl rand -hex 32)
  cat > .env << ENVEOF
APP_ENV=prod
DB_PASSWORD=$DB_PASS
SECRET_KEY=$SECRET
CRX_TEAM_API_URL=http://crx-api:8000
NEXT_PUBLIC_API_URL=https://cloud.crx.team
ENVEOF
  echo "  .env created (DB_PASSWORD auto-generated)"
fi

echo "[2/4] Building Docker images..."
docker compose -f $COMPOSE_FILE build

echo "[3/4] Starting services..."
docker compose -f $COMPOSE_FILE down --remove-orphans 2>/dev/null || true
docker compose -f $COMPOSE_FILE up -d

echo "[4/4] Health checks..."
sleep 10

FAIL=0

# Frontend
if curl -sf --max-time 10 http://127.0.0.1:3000/ > /dev/null 2>&1; then
  echo "  Frontend (3000)  OK"
else
  echo "  Frontend (3000)  FAIL"
  docker compose -f $COMPOSE_FILE logs frontend --tail 10 2>&1 | head -5
  FAIL=$((FAIL + 1))
fi

# Backend API
API_RESP=$(curl -sf --max-time 10 http://127.0.0.1:8080/health 2>/dev/null || echo "")
if echo "$API_RESP" | grep -q '"status"'; then
  echo "  Backend  (8080)  OK"
else
  echo "  Backend  (8080)  FAIL"
  echo "  Response: $API_RESP"
  docker compose -f $COMPOSE_FILE logs backend --tail 10 2>&1 | head -5
  FAIL=$((FAIL + 1))
fi

# Database
if docker compose -f $COMPOSE_FILE exec -T db pg_isready -U crxcloud > /dev/null 2>&1; then
  echo "  Database (5432)  OK"
else
  echo "  Database (5432)  FAIL"
  FAIL=$((FAIL + 1))
fi

echo ""
docker compose -f $COMPOSE_FILE ps --format "table {{.Name}}\t{{.Status}}"

echo ""
if [ $FAIL -eq 0 ]; then
  echo "=== Deploy complete -- all services healthy ==="
else
  echo "=== DEPLOY WARNING -- $FAIL service(s) FAILED ==="
fi
REMOTE

echo ""
echo "Done! Verifica su https://cloud.crx.team"
