#!/usr/bin/env bash
# One-command setup for the Raspberry Pi. Run this from the repo root, as
# the user Caden should run as (not root — the service runs unprivileged
# and gets its "full Pi control" through shell access as that user).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_USER="$(whoami)"
cd "$REPO_DIR"

echo "==> Caden install — repo at $REPO_DIR, running as $CURRENT_USER"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 20+ first, e.g.:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $NODE_MAJOR found, but Caden needs Node 20+. Please upgrade."
  exit 1
fi

echo "==> Installing dependencies"
npm ci

echo "==> Installing Playwright's Chromium (+ system deps — may prompt for sudo)"
npx playwright install --with-deps chromium

echo "==> Building"
npm run build

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from .env.example — add your GROQ_API_KEYS / GEMINI_API_KEYS before starting the service."
fi

echo "==> Installing systemd service"
SERVICE_FILE="/tmp/caden.service.$$"
sed \
  -e "s#WorkingDirectory=.*#WorkingDirectory=${REPO_DIR}#" \
  -e "s#EnvironmentFile=.*#EnvironmentFile=${REPO_DIR}/.env#" \
  -e "s#User=.*#User=${CURRENT_USER}#" \
  systemd/caden.service > "$SERVICE_FILE"
sudo mv "$SERVICE_FILE" /etc/systemd/system/caden.service
sudo systemctl daemon-reload
sudo systemctl enable caden.service

echo
echo "==> Done. Fill in .env with your API keys, then:"
echo "      sudo systemctl start caden"
echo "    Caden will then run on boot automatically and self-update from '${UPDATE_BRANCH:-main}'."
echo "    Web UI: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-7777}"
