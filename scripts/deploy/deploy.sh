#!/usr/bin/env bash
# Runs ON THE SERVER (invoked by the GitHub Actions deploy workflow, or by hand).
# Pulls the given ref, builds the images, runs migrations, then replaces the gateway container.
# Layout: /opt/zynd-n8n-gateway/{src (git checkout), .env}
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/zynd-n8n-gateway}"
REF="${1:-origin/main}"
NAME=zynd-n8n-gateway
HOST_PORT="${HOST_PORT:-8090}"
N8N_PORT="${N8N_PORT:-5678}"
NET=zynd-n8n-net

cd "$APP_DIR/src"
git fetch --quiet origin
git reset --hard "$REF"
SHA=$(git rev-parse --short HEAD)
echo "==> deploying $SHA"

docker build --target migrate -t "$NAME-migrate:$SHA" .
docker build --target gateway -t "$NAME:$SHA" .
docker build --target n8n -t "zynd-n8n:$SHA" .

echo "==> migrating"
docker run --rm --env-file "$APP_DIR/.env" "$NAME-migrate:$SHA"

echo "==> restarting gateway"
PREV=$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --env-file "$APP_DIR/.env" -e PORT=8080 \
  -p "127.0.0.1:$HOST_PORT:8080" --memory 384m \
  "$NAME:$SHA" >/dev/null

# ---- n8n (own Postgres container; secrets in $APP_DIR/n8n.env) ----
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
set -a; . "$APP_DIR/n8n.env"; set +a
if ! docker ps -a --format '{{.Names}}' | grep -qx zynd-n8n-postgres; then
  docker run -d --name zynd-n8n-postgres --restart unless-stopped --network "$NET" \
    -e POSTGRES_USER=n8n -e POSTGRES_PASSWORD="$N8N_PG_PASSWORD" -e POSTGRES_DB=n8n \
    -v zynd-n8n-pgdata:/var/lib/postgresql/data --memory 512m postgres:16-alpine >/dev/null
fi
docker start zynd-n8n-postgres >/dev/null 2>&1 || true
for i in $(seq 1 30); do docker exec zynd-n8n-postgres pg_isready -U n8n >/dev/null 2>&1 && break; sleep 1; done
docker rm -f zynd-n8n >/dev/null 2>&1 || true
docker run -d --name zynd-n8n --restart unless-stopped --network "$NET" \
  -p "127.0.0.1:$N8N_PORT:5678" --memory 1g -v zynd-n8n-data:/home/node/.n8n \
  -e DB_TYPE=postgresdb -e DB_POSTGRESDB_HOST=zynd-n8n-postgres -e DB_POSTGRESDB_PORT=5432 \
  -e DB_POSTGRESDB_DATABASE=n8n -e DB_POSTGRESDB_USER=n8n -e DB_POSTGRESDB_PASSWORD="$N8N_PG_PASSWORD" \
  -e N8N_HOST="$N8N_HOST" -e N8N_PORT=5678 -e N8N_PROTOCOL="$N8N_PROTOCOL" -e WEBHOOK_URL="$N8N_WEBHOOK_URL" \
  -e N8N_PROXY_HOPS=1 -e N8N_SECURE_COOKIE=true -e GENERIC_TIMEZONE=UTC -e N8N_ENCRYPTION_KEY="$N8N_ENCRYPTION_KEY" \
  "zynd-n8n:$SHA" >/dev/null
for i in $(seq 1 45); do
  curl -fsS "http://127.0.0.1:$N8N_PORT/healthz" >/dev/null 2>&1 && { echo "==> n8n healthy"; break; }
  sleep 2
done
curl -fsS "http://127.0.0.1:$N8N_PORT/healthz" >/dev/null || { echo "!! n8n unhealthy" >&2; docker logs --tail 40 zynd-n8n >&2; exit 1; }

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$HOST_PORT/health" >/dev/null 2>&1; then
    echo "==> healthy ($SHA)"
    docker image prune -f --filter "until=72h" >/dev/null || true
    exit 0
  fi
  sleep 2
done

echo "!! health check failed; logs:" >&2
docker logs --tail 50 "$NAME" >&2 || true
if [ -n "$PREV" ]; then
  echo "!! rolling back to $PREV" >&2
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped --env-file "$APP_DIR/.env" -e PORT=8080 \
    -p "127.0.0.1:$HOST_PORT:8080" --memory 384m "$PREV" >/dev/null
fi
exit 1
