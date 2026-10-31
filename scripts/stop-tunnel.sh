#!/usr/bin/env bash
# ==============================================================================
# NEX-GAS — MacBook Hosted Backend + Cloudflare Tunnel Stop Script
# ==============================================================================

echo "=================================================="
echo "  NEX-GAS — Stopping Backend & Cloudflare Tunnel"
echo "=================================================="

# 1. Stop cloudflared
if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
  echo "Stopping cloudflared tunnel..."
  pkill -f "cloudflared tunnel" || true
  echo "Cloudflare Tunnel stopped."
else
  echo "No cloudflared tunnel process found."
fi

# 2. Stop backend
if [ -f /tmp/nexgas_backend.pid ]; then
  PID=$(cat /tmp/nexgas_backend.pid)
  if ps -p "$PID" >/dev/null 2>&1; then
    echo "Stopping Backend PID $PID..."
    kill -TERM "$PID" || true
    sleep 1
  fi
  rm -f /tmp/nexgas_backend.pid
fi

# Fallback kill on port 5001 if still listening
if lsof -i :5001 >/dev/null 2>&1; then
  echo "Freeing port 5001..."
  lsof -ti :5001 | xargs kill -9 2>/dev/null || true
fi

echo "[SUCCESS] All NEX-GAS backend & tunnel services stopped cleanly."

