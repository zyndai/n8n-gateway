#!/usr/bin/env bash
# Runs ON THE SERVER (invoked by the GitHub Actions deploy workflow, or by hand).
# Pulls the given ref, builds the images, runs migrations, then replaces the gateway container.
# Layout: /opt/zynd-n8n-gateway/{src (git checkout), .env}
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/zynd-n8n-gateway}"
REF="${1:-origin/main}"
NAME=zynd-n8n-gateway
HOST_PORT="${HOST_PORT:-8090}"

cd "$APP_DIR/src"
git fetch --quiet origin
git reset --hard "$REF"
SHA=$(git rev-parse --short HEAD)
echo "==> deploying $SHA"

docker build --target migrate -t "$NAME-migrate:$SHA" .
docker build --target gateway -t "$NAME:$SHA" .

echo "==> migrating"
docker run --rm --env-file "$APP_DIR/.env" "$NAME-migrate:$SHA"

echo "==> restarting gateway"
PREV=$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --env-file "$APP_DIR/.env" -e PORT=8080 \
  -p "127.0.0.1:$HOST_PORT:8080" --memory 384m \
  "$NAME:$SHA" >/dev/null

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
