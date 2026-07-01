# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Caden is a personal home AI — a 24/7 Jarvis-like presence. It has two parts: a static frontend deployed to GitHub Pages, and a backend that runs entirely on Supabase (Edge Functions + Postgres) — no local hardware, no Pi, no separately-hosted server required.

**Live site:** `https://whcreativedesign.github.io/caden/`
**Repo:** `WHCreativeDesign/caden`
**Supabase project:** `lrjiopczasvcrhglweth` (`https://lrjiopczasvcrhglweth.supabase.co`)

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

## Backend (`supabase/functions/` — current, hosted-only path)

Deno/TypeScript Supabase Edge Functions. No local hardware in the loop: the functions, the key pools, and the Postgres key-cycling logic all live inside the Supabase project.

**Endpoints:**
- `POST /functions/v1/chat` — OpenAI-compatible chat-completions agent loop (`supabase/functions/chat/index.ts`)
- `GET /functions/v1/health` — per-provider key availability counts (`supabase/functions/health/index.ts`)

Both require a Supabase JWT on the `Authorization` header (`verify_jwt: true`, the default) — the frontend should send the project's **anon/publishable key**, never the service-role key.

**Key store:** `caden_api_keys` table (`provider` = `groq` | `gemini`, `api_key`, `active`, plus `last_used_at` / `rate_limited_until` / `request_count`). RLS is enabled with **no public policy** — only the service-role key (used internally by the Edge Functions, set as the `SUPABASE_SERVICE_ROLE_KEY` function secret) can read or write it. Add/remove keys via the Supabase SQL editor, table editor, or PostgREST — there is an unlimited number of keys per provider.

**Key cycling:** lives in Postgres, not in-memory, because Edge Function instances are stateless per invocation. Two `SECURITY DEFINER` RPCs (migration `add_key_cycling_functions`, granted to `service_role` only) do the work atomically:
- `get_next_api_key(provider)` — `UPDATE ... FOR UPDATE SKIP LOCKED` picks the least-recently-used available key and marks it used, race-safe across concurrent invocations.
- `mark_api_key_limited(provider, api_key, retry_after_seconds)` — sets `rate_limited_until` after a 429.

**Provider routing:** Groq (`llama-3.3-70b-versatile`) is primary; on a 429 the function cycles to the next Groq key (up to `MAX_KEY_ATTEMPTS`), and on any other failure or full Groq exhaustion it falls back to Gemini (`gemini-2.0-flash`). Both are called via plain `fetch` against their OpenAI-compatible endpoints — no SDK needed.

**Model profiles** (inline `MODELS` map in `chat/index.ts`): `orchestrator` (default), `fast`, `deep`. Pass as the `model` field in requests — it's a profile name, not a raw model ID.

**Agent loop:** runs up to `max_tool_rounds` (default 10) iterations. Each round: call the LLM → if tool calls are present, resolve them → append results → repeat. No tools are registered server-side yet (see below), so any tool call the model makes gets a graceful `"not implemented"` result — this keeps the loop functional as tools get added later.

**Deploying changes:** edit the function source under `supabase/functions/<name>/index.ts`, then redeploy via the Supabase MCP `deploy_edge_function` tool (or `supabase functions deploy <name>` with the CLI) — there's no separate build step.

---

## Backend (`server/` — optional, self-hosted alternative)

A Python + FastAPI implementation of the same chat-completions API exists in `server/` for anyone who later wants to self-host on a Raspberry Pi or other always-on hardware instead of relying on Supabase Edge Functions. **It is not currently deployed anywhere.** It has its own key-pool logic (`providers/key_cycler.py`, optionally synced from the same `caden_api_keys` table via `keys_sync.py`), its own tool registry (`tools/home.py`, `tools/communication.py` — still stubs), and a systemd unit (`server/caden-api.service`) for running on a Pi. See the code and its docstrings if reviving this path; the Edge Functions above are the source of truth for current behavior.

---

## What's not wired up yet

- The frontend makes no real API calls — it's a static demo with a JS state machine. The next step is pointing the canvas input bar at `https://lrjiopczasvcrhglweth.supabase.co/functions/v1/chat`, sending the anon key as the bearer token.
- No system prompt defining Caden's personality is set.
- Home and communication tools aren't ported to the Edge Function yet — the agent loop supports tool calls, but no tools are registered.
- No streaming (`stream: true`) support in the chat function.
- No real Gemini-based voice pipeline yet — the Gemini key pool is provisioned but only used for text chat fallback so far.
