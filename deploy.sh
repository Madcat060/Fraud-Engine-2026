#!/usr/bin/env bash
# One-shot deploy on the VM: pull the latest published image and (re)start.
# Usage: ./deploy.sh
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env found — creating one from .env.dist. Edit it to set real credentials."
  cp .env.dist .env
fi

echo "==> Pulling latest images..."
docker compose -f "$COMPOSE_FILE" pull

echo "==> Starting services..."
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Done. Fraud UI: http://localhost:5001  |  Reports API: http://localhost:5000"
docker compose -f "$COMPOSE_FILE" ps
