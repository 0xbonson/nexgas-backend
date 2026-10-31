#!/usr/bin/env bash
# ==============================================================================
# NEX-GAS — MacBook Hosted Backend + Cloudflare Tunnel Start Script
# ==============================================================================
set -e

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BACKEND_DIR"

echo "=================================================="
echo "  NEX-GAS — Starting Backend + Cloudflare Tunnel"
echo "=================================================="

# 1. Check if port 5001 is in use
if lsof -i :5001 >/dev/null 2>&1; then
  echo "[INFO] Port 5001 is already in use by an active backend."
else
  echo "[1/2] Starting NEX-GAS Backend (Turso Cloud)..."
  PORT=5001 node dist/index.js > logs/backend.log 2>&1 &
  BACKEND_PID=$!
  echo $BACKEND_PID > /tmp/nexgas_backend.pid
  echo "Backend started with PID $BACKEND_PID (logs: logs/backend.log)"
  sleep 2
fi

# 2. Check health
echo "Verifying local backend health..."
curl -s http://localhost:5001/health || {
  echo "[ERROR] Backend failed to start. Check logs/backend.log"
  exit 1
}
echo ""

# 3. Start Cloudflare Tunnel
echo "[2/2] Starting Cloudflare Tunnel (HTTPS & WSS forwarding)..."
cloudflared tunnel --no-prechecks --protocol http2 --url http://localhost:5001

