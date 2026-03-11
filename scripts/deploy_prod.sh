#!/bin/bash
# CRX Cloud - Deploy PROD su Hetzner (eseguire dal PC locale)
# Usage: bash scripts/deploy_prod.sh
#
# Safe deploy: build PRIMA di down, health retry, auto-recovery.
set -euo pipefail
trap 'echo ""; echo "=== ERRORE: deploy fallito alla riga $LINENO (exit code $?) ==="' ERR

# --- Config ---
SERVER="crx-prod"
COMPOSE_FILE="docker-compose.prod.yml"
DEPLOY_DIR="/opt/crx-cloud"
REPO_URL="https://github.com/gatecommerce/crx-cloud.git"

echo "=== Deploy CRX Cloud PROD su Hetzner ==="
echo ""

# --- Step 1: Pulizia Docker pre-deploy ---
echo "[1/6] Pulizia Docker (immagini dangling)..."
ssh "$SERVER" "docker image prune -f 2>/dev/null || true" | tail -1

# --- Step 2-6: Deploy remoto ---
echo "[2/6] Git pull on server..."
ssh "$SERVER" "bash -s" << REMOTE
set -e
COMPOSE_FILE="$COMPOSE_FILE"

# Clone se primo deploy
if [ ! -d $DEPLOY_DIR ]; then
  echo "  First deploy: cloning repo..."
  cd /opt
  git clone $REPO_URL
fi

cd $DEPLOY_DIR

echo "  git pull..."
git pull origin main

# Crea .env se non esiste
if [ ! -f .env ]; then
  echo "  Creating .env with secure defaults..."
  DB_PASS=\$(openssl rand -hex 16)
  SECRET=\$(openssl rand -hex 32)
  cat > .env << 'ENVEOF'
APP_ENV=prod
DATABASE_URL=postgresql+asyncpg://crxcloud:\${DB_PASSWORD}@db:5432/crxcloud
NEXT_PUBLIC_API_URL=https://cloud.crx.team
CRX_TEAM_API_URL=http://crx-api:8000
CRX_TEAM_API_KEY=
ENVEOF
  # Inietta password generate (non possono stare nel heredoc quoted)
  sed -i "s/\\\\\${DB_PASSWORD}/\$DB_PASS/" .env
  echo "DB_PASSWORD=\$DB_PASS" >> .env
  echo "SECRET_KEY=\$SECRET" >> .env
  echo "  .env created (DB_PASSWORD auto-generated)"
fi

# --- Build PRIMA di fermare i servizi (zero-downtime) ---
echo "[3/6] Building Docker images (servizi ancora attivi)..."
docker compose -f \$COMPOSE_FILE build

# --- Cleanup container orfani ---
echo "[4/6] Cleanup + restart..."
docker compose -f \$COMPOSE_FILE down --remove-orphans 2>/dev/null || true
docker compose -f \$COMPOSE_FILE up -d

# --- Attesa avvio ---
echo "[5/6] Attesa avvio servizi..."
MAX_WAIT=60
WAITED=0
while [ \$WAITED -lt \$MAX_WAIT ]; do
  sleep 5
  WAITED=\$((WAITED + 5))

  NOT_READY=0
  for CN in crx-cloud-frontend-1 crx-cloud-backend-1 crx-cloud-db-1; do
    STATE=\$(docker inspect \$CN --format '{{.State.Status}}' 2>/dev/null || echo "missing")
    if [ "\$STATE" != "running" ]; then
      NOT_READY=\$((NOT_READY + 1))
    fi
  done

  if [ \$NOT_READY -eq 0 ]; then
    echo "  Tutti i servizi pronti dopo \${WAITED}s"
    break
  fi
  echo "  \${WAITED}s... \${NOT_READY} servizi ancora in avvio"
done

echo ""
docker compose -f \$COMPOSE_FILE ps --format "table {{.Name}}\t{{.Status}}"

# --- Health checks ---
echo ""
echo "[6/6] Health checks..."
FAIL=0

# Frontend (Next.js)
if curl -sf --max-time 10 http://127.0.0.1:3000/ > /dev/null 2>&1; then
  echo "  Frontend (3000)  OK"
else
  echo "  Frontend (3000)  FAIL"
  docker compose -f \$COMPOSE_FILE logs frontend --tail 10 2>&1 | head -5
  FAIL=\$((FAIL + 1))
fi

# Backend API (FastAPI)
API_RESP=\$(curl -sf --max-time 10 http://127.0.0.1:8080/health 2>/dev/null || echo "")
if echo "\$API_RESP" | grep -q '"status"'; then
  echo "  Backend  (8080)  OK"
else
  echo "  Backend  (8080)  FAIL"
  echo "  Response: \$API_RESP"
  docker compose -f \$COMPOSE_FILE logs backend --tail 15 2>&1 | head -10
  FAIL=\$((FAIL + 1))
fi

# Database (PostgreSQL)
if docker compose -f \$COMPOSE_FILE exec -T db pg_isready -U crxcloud > /dev/null 2>&1; then
  echo "  Database (5432)  OK"
else
  echo "  Database (5432)  FAIL"
  FAIL=\$((FAIL + 1))
fi

echo ""
if [ \$FAIL -eq 0 ]; then
  echo "=== Deploy complete -- all 3 services healthy ==="
elif [ \$FAIL -le 1 ]; then
  echo "=== Deploy complete -- \$FAIL service(s) degraded ==="
  echo "  Hint: docker compose -f \$COMPOSE_FILE logs <service> --tail 50"
else
  echo "=== DEPLOY WARNING -- \$FAIL service(s) FAILED ==="
  echo "  Auto-recovery: riavvio container falliti..."
  docker compose -f \$COMPOSE_FILE restart 2>/dev/null || true
  sleep 10
  echo ""
  echo "  Stato dopo recovery:"
  docker compose -f \$COMPOSE_FILE ps --format "table {{.Name}}\t{{.Status}}"
fi
REMOTE

echo ""
echo "Done! Verifica su https://cloud.crx.team"
