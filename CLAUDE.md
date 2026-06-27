# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Caden is a personal home AI — a 24/7 Jarvis-like presence running on a Raspberry Pi. It has two parts: a static frontend deployed to GitHub Pages, and a local Python API server that runs on the Pi.

**Live site:** `https://whcreativedesign.github.io/caden/`
**Repo:** `WHCreativeDesign/caden`

---

## Frontend

No build step. The entire site is `index.html` at the root — a single full-screen canvas UI. There is no landing page or navigation. Open the file directly in a browser to develop.

`styles.css` is the single CSS entry point; it imports everything from `tokens/` in order. Never add rules to `styles.css` itself.

**Token files (load order matters):**
- `tokens/fonts.css` — Google Fonts imports
- `tokens/colors.css` — full color ramp + semantic aliases + presence gradient
- `tokens/typography.css` — type scale, font families, weights
- `tokens/spacing.css` — 4px base scale (`--s-1` through `--s-10`), layout constraints
- `tokens/radius-shadow.css` — blob radii (`--blob-1` through `--blob-4`) used by the orb, shadow tokens, glow tokens
- `tokens/motion.css` — named keyframes (`caden-morph`, `caden-rise`) and duration variables
- `tokens/base.css` — reset, base element styles, `.eyebrow`, `.container`, `.dot` utilities

**Design constraints — do not violate:**
- The orb (`#C46A4B` terracotta, `4px solid #000` border) must have no gradient, no glow, no box-shadow, no sheen/highlight layer, no ripple rings. Its only animation is `caden-morph` (blob shape shift) via `--blob-1..4` border-radius presets.
- Listening state is communicated exclusively through 7 slow waveform bars below the orb (`bar-a/b/c` keyframes, 2.4–3.8s cycles, staggered). No orb scale pulsing.
- The UI is **neobrutalist**: `3px solid #000` borders, `5–6px` hard offset box-shadows (`X Y 0 #000`), no blur/backdrop-filter, no pill shapes on interactive elements.
- No status indicator dots anywhere in the UI.

**Orb state machine (JS in `index.html`):**
- `idle` → morph 18s
- `listening` → morph 9s + waveform bars visible
- `thinking` → morph 4s
- `speaking` → morph 18s + orb drifts left, answer panel slides in from right

`ui_kits/canvas/index.html` is a meta-redirect to `/caden/` — don't put content there.

**Deployment:** Every push to `main` triggers `.github/workflows/deploy.yml` which deploys the repo root to GitHub Pages. GitHub Pages must be configured to use **GitHub Actions** as the source (Settings → Pages → Source).

---

## Backend (`server/`)

Python + FastAPI. Runs on a Raspberry Pi, serves an **OpenAI-compatible `/v1/chat/completions` endpoint** so the frontend can call it directly.

**Run locally:**
```bash
cd server
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in API keys
python main.py
```

**Endpoints:**
- `POST /v1/chat/completions` — main chat endpoint with agent loop
- `GET /health` — shows per-provider key availability counts
- `GET /tools` — lists all registered tools in OpenAI schema format

**Key cycling:** `KeyCycler` (`providers/key_cycler.py`) round-robins through all keys in the pool. On a 429, the offending key is marked unavailable for 60s and the next key is tried. Add keys by appending to `GROQ_API_KEYS` or `GEMINI_API_KEYS` in `.env` (comma-separated).

**Provider routing:** Groq (`llama-3.3-70b-versatile`) is primary. If all Groq keys are rate-limited or any exception is raised, the same request is retried on Gemini (`gemini-2.0-flash` via its OpenAI-compatible endpoint). Both use the `openai` SDK with different `base_url` values — no separate SDK needed for Gemini.

**Model profiles** (`config.py`): `orchestrator` (default), `fast`, `deep`. Pass as the `model` field in requests — it's a profile name, not a raw model ID.

**Agent loop** (`routers/chat.py`): Runs up to `MAX_TOOL_ROUNDS` iterations. Each round: call LLM → if tool calls present, execute all of them locally → append results to messages → repeat. Returns when the model produces a response with no tool calls.

**Adding a tool:**
1. Create or open a file in `server/tools/`
2. Decorate the function with `@tool(name, description, parameters)` from `tools.registry`
3. Import the module in `server/tools/__init__.py`

The model receives all registered tools automatically on every request. Tool handlers can be sync or async — the registry handles both.

**Home tools** (`tools/home.py`): `control_light`, `set_thermostat`, `lock_door`, `get_home_status` — all stubs awaiting real Home Assistant / python-kasa integration.

**Communication tools** (`tools/communication.py`): `send_text`, `make_call`, `get_contacts` — stubs wired for Twilio (env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`).

**Pi deployment:**
```bash
sudo cp server/caden-api.service /etc/systemd/system/
sudo systemctl enable --now caden-api
```
The service file assumes the repo is at `/home/pi/caden` and the venv at `/home/pi/caden/server/venv`.

---

## What's not wired up yet

- The frontend makes no real API calls — it's a static demo with a JS state machine. The next step is pointing the canvas input bar at `http://<pi-ip>:8000/v1/chat/completions`.
- No system prompt defining Caden's personality is set.
- Home and communication tools are stubs.
- No streaming (`stream: true`) support in the chat router.
