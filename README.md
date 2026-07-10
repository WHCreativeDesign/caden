# Caden

A personal agent daemon that lives on a Raspberry Pi: real shell access, a
browser it drives itself, live web search, and a retro-futuristic local web
UI to talk to it and watch what it's doing.

## How it's built

- **Daemon** — Node.js + TypeScript (`src/`). An OpenAI-compatible tool-calling
  agent loop over Groq (primary) and Gemini (fallback), with `run_shell`
  (full, audited shell access), `browser_*` (Playwright, headed on an
  attached display or streamed to the web UI), `web_search`/`fetch_page`,
  `dispatch_agent` (parallel research), and `calculate`/`get_current_time`.
  Self-updates from git without rebooting the Pi (`src/update.ts`), runs as a
  systemd service (`systemd/caden.service`).
- **Web UI** — `public/index.html`, a single self-contained page (no build
  step): chat, a live "System Log" of every shell command run, and a live
  browser view when the browser is running in streamed mode. Served locally
  from the Pi at `http://<pi-ip>:7777`.

## Running it on a Pi

```
git clone <this repo> caden && cd caden
./scripts/install.sh      # installs deps, Playwright's Chromium, the systemd service
$EDITOR .env               # add GROQ_API_KEYS / GEMINI_API_KEYS
sudo systemctl start caden
```

Caden then runs on boot automatically, restarts itself when it pulls new
commits from `main` (no Pi reboot needed), and serves its UI on the LAN.

Design and governance notes live in [CLAUDE.md](CLAUDE.md). Legacy
design-system files (`tokens/`, `components/`, `guidelines/`) predate the
current app and are kept as reference only.
