#!/usr/bin/env bash
# Caden installer — installs Node if needed, dependencies, Playwright's
# Chromium, prompts for API keys, builds, and installs+starts the systemd
# service. Safe to re-run: it'll pick up from wherever it left off and keep
# any keys you've already entered.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_USER="$(whoami)"
cd "$REPO_DIR"

# ── Palette — matches public/index.html's synthwave theme ──────────────────
C_CYAN=$'\033[96m'
C_MAGENTA=$'\033[95m'
C_VIOLET=$'\033[35m'
C_DIM=$'\033[2m'
C_BOLD=$'\033[1m'
C_GREEN=$'\033[92m'
C_RED=$'\033[91m'
C_RESET=$'\033[0m'

banner() {
  echo ""
  printf "  %s%sC A D E N%s  %s— setup%s\n" "$C_BOLD" "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf "  %s%s%s\n" "$C_DIM" "$REPO_DIR" "$C_RESET"
  echo ""
}

say() { printf "  %s%s%s\n" "$C_VIOLET" "$1" "$C_RESET"; }
note() { printf "  %s%s%s\n" "$C_DIM" "$1" "$C_RESET"; }
fail() { printf "  %sx %s%s\n" "$C_RED" "$1" "$C_RESET"; exit 1; }

# Runs a command in the background with a spinner; on failure, dumps its
# captured output and exits. On success, prints a checkmark.
run_step() {
  local label="$1"; shift
  local logfile; logfile="$(mktemp)"
  ("$@" >"$logfile" 2>&1) &
  local pid=$!
  local spin='|/-\'
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$(( (i + 1) % ${#spin} ))
    printf "\r  %s%s%s %s" "$C_CYAN" "${spin:$i:1}" "$C_RESET" "$label"
    sleep 0.08
  done
  if wait "$pid"; then
    printf "\r  %sOK%s %s%s\n" "$C_GREEN" "$C_RESET" "$label" "                    "
    rm -f "$logfile"
  else
    printf "\r  %sx%s %s%s\n" "$C_RED" "$C_RESET" "$label" "                    "
    echo ""
    note "-- output --"
    cat "$logfile"
    rm -f "$logfile"
    exit 1
  fi
}

banner

# ── Sudo up front ────────────────────────────────────────────────────────
# Several steps below (Node install, Playwright's system deps, the systemd
# unit) need root. Cache credentials once, now, while we still have your
# attention, instead of surprising you mid-spinner later.
if [ "$(id -u)" -ne 0 ]; then
  say "A few steps need sudo (Node install, Playwright system deps, systemd)."
  sudo -v
  ( while true; do sudo -n true; sleep 60; kill -0 "$$" 2>/dev/null || exit; done ) &
  SUDO_KEEPALIVE_PID=$!
  trap '[ -n "${SUDO_KEEPALIVE_PID:-}" ] && kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true' EXIT
  SUDO="sudo"
else
  SUDO=""
fi

# ── Node.js ──────────────────────────────────────────────────────────────
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  run_step "Installing Node.js 20.x" bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | ${SUDO} -E bash - && ${SUDO} apt-get install -y nodejs"
else
  printf "  %sOK%s Node.js %s already present\n" "$C_GREEN" "$C_RESET" "$(node --version)"
fi

# ── App dependencies ─────────────────────────────────────────────────────
run_step "Installing dependencies" npm ci
run_step "Installing Playwright's Chromium (+ system deps)" bash -c "npx playwright install --with-deps chromium"
run_step "Building" npm run build

# ── API keys — interactive, over /dev/tty so this works via curl | bash ──
echo ""
say "API keys"
note "At least one Groq key gets you started; Gemini is only the fallback."

INTERACTIVE=0
if [ -r /dev/tty ]; then INTERACTIVE=1; fi

existing_groq="" existing_gemini=""
if [ -f .env ]; then
  existing_groq="$(grep -m1 '^GROQ_API_KEYS=' .env 2>/dev/null | cut -d= -f2- || true)"
  existing_gemini="$(grep -m1 '^GEMINI_API_KEYS=' .env 2>/dev/null | cut -d= -f2- || true)"
fi

groq_keys="$existing_groq"
gemini_keys="$existing_gemini"

if [ "$INTERACTIVE" -eq 1 ]; then
  suffix=""
  [ -n "$existing_groq" ] && suffix=" ${C_DIM}(Enter to keep current)${C_RESET}"
  printf "\n  %sGROQ_API_KEYS%s%s\n" "$C_MAGENTA" "$C_RESET" "$suffix"
  note "comma-separated, e.g. gsk_abc...,gsk_def..."
  printf "  %s>%s " "$C_CYAN" "$C_RESET"
  input=""
  { read -r input < /dev/tty; } 2>/dev/null || true
  [ -n "$input" ] && groq_keys="$input"

  suffix=""
  [ -n "$existing_gemini" ] && suffix=" ${C_DIM}(Enter to keep current)${C_RESET}"
  printf "\n  %sGEMINI_API_KEYS%s%s %s(optional — Enter to skip)%s\n" "$C_MAGENTA" "$C_RESET" "$suffix" "$C_DIM" "$C_RESET"
  note "comma-separated, e.g. AIzaSy...,AIzaSy..."
  printf "  %s>%s " "$C_CYAN" "$C_RESET"
  input=""
  { read -r input < /dev/tty; } 2>/dev/null || true
  [ -n "$input" ] && gemini_keys="$input"
else
  note "No interactive terminal detected — skipping key prompts."
  note "Add GROQ_API_KEYS / GEMINI_API_KEYS to .env yourself before starting the service."
fi

# Rebuild .env from .env.example, replacing the key lines with what we
# collected — avoids sed-escaping headaches with arbitrary key contents.
if [ ! -f .env ]; then cp .env.example .env; fi
grep -v '^GROQ_API_KEYS=\|^GEMINI_API_KEYS=' .env.example > .env.new 2>/dev/null || true
{
  cat .env.new
  echo "GROQ_API_KEYS=${groq_keys}"
  echo "GEMINI_API_KEYS=${gemini_keys}"
} > .env
rm -f .env.new
printf "  %sOK%s .env written\n" "$C_GREEN" "$C_RESET"

# ── systemd ──────────────────────────────────────────────────────────────
echo ""
say "Installing systemd service"
SERVICE_TMP="$(mktemp)"
sed \
  -e "s#WorkingDirectory=.*#WorkingDirectory=${REPO_DIR}#" \
  -e "s#EnvironmentFile=.*#EnvironmentFile=${REPO_DIR}/.env#" \
  -e "s#User=.*#User=${CURRENT_USER}#" \
  systemd/caden.service > "$SERVICE_TMP"
${SUDO} mv "$SERVICE_TMP" /etc/systemd/system/caden.service
${SUDO} systemctl daemon-reload
${SUDO} systemctl enable caden.service >/dev/null 2>&1
printf "  %sOK%s service installed and enabled\n" "$C_GREEN" "$C_RESET"

# `caden-chat` from anywhere on the Pi
${SUDO} ln -sf "${REPO_DIR}/bin/caden-chat" /usr/local/bin/caden-chat 2>/dev/null || true

# ── Start ────────────────────────────────────────────────────────────────
if [ -z "$groq_keys" ]; then
  echo ""
  note "No Groq key set yet — starting anyway, but chat won't work until .env has one."
  note "Edit .env, then: sudo systemctl restart caden"
fi

${SUDO} systemctl restart caden.service
sleep 1.5
PORT_VAL="$(grep -m1 '^PORT=' .env 2>/dev/null | cut -d= -f2- || true)"
PORT_VAL="${PORT_VAL:-7777}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo ""
if ${SUDO} systemctl is-active --quiet caden.service; then
  printf "  %s%s* CADEN IS ONLINE%s\n" "$C_BOLD" "$C_GREEN" "$C_RESET"
  printf "  %sweb ui%s   http://%s:%s\n" "$C_DIM" "$C_RESET" "${IP:-<pi-ip>}" "$PORT_VAL"
  printf "  %sterminal%s caden-chat  %s(or: npm run chat)%s\n" "$C_DIM" "$C_RESET" "$C_DIM" "$C_RESET"
  printf "  %slogs%s     journalctl -u caden -f\n" "$C_DIM" "$C_RESET"
else
  printf "  %sx service did not start%s — check: journalctl -u caden -e\n" "$C_RED" "$C_RESET"
  exit 1
fi
echo ""
