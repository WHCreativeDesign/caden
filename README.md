# Caden

A personal agent daemon that lives on a Raspberry Pi: real shell access, a
browser it drives itself, live web search, and a retro-futuristic
industrial-terminal local web UI to talk to it and watch what it's doing.

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
- **Terminal UI** — `caden-chat` (`src/cli.ts`), a colored terminal chat
  client for a running Caden, matching the same amber palette. Talks to
  the same `/api/chat` the web UI uses.

## Installing on a Pi

One line, from a fresh Raspberry Pi OS install:

```
curl -fsSL https://raw.githubusercontent.com/WHCreativeDesign/caden/main/scripts/bootstrap.sh | bash
```

That clones the repo to `~/caden`, installs Node.js if it's missing,
installs dependencies and Playwright's Chromium, prompts you for your
`GROQ_API_KEYS` / `GEMINI_API_KEYS` right there in the terminal, builds, and
installs + starts the systemd service — one pass, styled to match the app.
Re-running it later updates in place and keeps any keys you've already
entered.

Already have the repo cloned? Just run `./scripts/install.sh` from its root
— that's the same installer `bootstrap.sh` hands off to.

Caden then runs on boot automatically, restarts itself when it pulls new
commits from the tracked branch (`UPDATE_BRANCH` in `.env`, default `main`;
no Pi reboot needed), and serves its UI on the LAN. Chat from a browser at
`http://<pi-ip>:7777`, or from the terminal with `caden-chat`.

Design and governance notes live in [CLAUDE.md](CLAUDE.md). Legacy
design-system files (`tokens/`, `components/`, `guidelines/`) predate the
current app and are kept as reference only.
