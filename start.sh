#!/bin/bash
echo ""
echo "============================================"
echo "   FileVault - Secure File Server"
echo "============================================"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js not found. Install it from https://nodejs.org"
  exit 1
fi

# Install deps if missing
if [ ! -d "node_modules" ]; then
  echo "[*] Installing dependencies..."
  npm install || { echo "[ERROR] npm install failed."; exit 1; }
  echo "[*] Done."
fi

echo "[*] Starting FileVault on http://localhost:3000"
echo "[*] Default: admin / admin123"
echo "[*] Press Ctrl+C to stop."
echo ""

node server.js
