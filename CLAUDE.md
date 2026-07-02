# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Caden is a personal research companion — a chatbot with a body and a room. It lives as a luminous orb in a grainy sky, thinks out loud, reads the live web, and shapes its own canvas: it moves itself, opens glass windows, writes interactive elements, and dispatches research agents that appear on screen. Frontend is a static page on GitHub Pages; backend runs entirely on Supabase (Edge Functions + Postgres). No local hardware anywhere.

**Live site:** `https://whcreativedesign.github.io/caden/`
**Repo:** `WHCreativeDesign/caden`
**Supabase project:** `lrjiopczasvcrhglweth` (`https://lrjiopczasvcrhglweth.supabase.co`)

Caden is a chatbot and research tool — **no home-automation integration**; don't add smart-home tooling unless explicitly asked.

---

## Frontend (`index.html`)

No build step. The entire app is `index.html` at the root — fully self-contained. `styles.css`/`tokens/` belong to a long-retired design system under `guidelines/`/`components/` and are reference only.

**Design language — a grainy sky, real glass, editorial type.** Human and warm without earthy tones:

- The backdrop is a photographic-feeling sky: layered gradient (palette picked from the real local hour — dawn/day/dusk/night), slow blurred clouds, a sun bloom, and a strong film-grain overlay (`mix-blend-mode: overlay`). The grain is what keeps it from reading as CSS.
- Glass is physical, not "AI glass": white-gradient fill + `backdrop-filter: blur(26px) saturate(1.5)`, bright 1px top edge, darker bottom edge, soft deep drop shadow, inner top highlight. No rainbow gradients, no glow borders.
- Type: **Newsreader** (serif — wordmark in italic, Caden's answers, thinking lines, window titles) + **Inter** (UI) + IBM Plex Mono only for the tiny telemetry line. Ink `#232838`, accent periwinkle `#5B67D8` used sparingly, warm `#C97B4A` only for errors. No emoji.
- **Sound:** Web Audio–synthesized glassy chimes (send / arrive / window / agent / error — quiet sine partials through a lowpass) plus a barely-audible ambient bed. Armed on first user gesture; toggle in the top bar, persisted. No audio assets.
- The orb is pearlescent (white → pale blue → periwinkle), liquid morph, soft halo; thinking dissolves it into a gooey metaball cluster (SVG goo + glow, SMIL rotation). No rings, no sci-fi.

**The living canvas.** The backend returns `caden.actions`, which the client performs with staggered timing:
- `move_orb` — the orb glides to x/y (viewport %; 1.5s ease).
- `spawn_window` — a draggable glass window appears at x/y: plain text (linkified) or **model-written HTML rendered in a sandboxed iframe** (`sandbox="allow-scripts"`, srcdoc, no same-origin — interactive elements Caden codes itself).
- `close_window`, and `spawn_agent` — an agent chip window with a pulsing dot, italic task line, and findings that type in.
Windows are draggable (title bar), z-ordered on click, and persisted. `caden.session.v3` in localStorage holds mode, agent, history, chat log, windows, and orb position; "New" clears it all.

**Visible thinking** is unchanged in spirit: plan phase streams real reasoning lines into a live capsule (chat) and a serif-italic ticker under the orb (canvas); tool executions append; the capsule collapses to `thought for N.Ns · N steps`. Never fabricate thinking client-side.

**Two views:** Canvas (the orb + windows + right-hand glass answer panel, serif body) and Chat (glass cards). Voice via Web Speech API.

**Deployment:** push to `main` → `.github/workflows/deploy.yml` → GitHub Pages.

---

## Backend (`supabase/functions/`)

Deno/TypeScript Edge Functions on project `lrjiopczasvcrhglweth`. Both `verify_jwt: true`; the frontend uses the public anon key. Never ship the service-role key client-side.

- `POST /functions/v1/chat` — the agent loop (`chat/index.ts`)
- `GET /functions/v1/health` — per-provider key counts

**Request extensions:** `agent` (`caden` | `researcher` | `scout`), `model` (profile override), `phase:"plan"`, `plan`, `max_tool_rounds` (defaults per agent: 8 / 14 / 4).

**Response extension:** `caden: { agent, rounds, steps, actions }` — `steps` is the tool trace; `actions` are canvas directives.

**Three kinds of tools** (all in `chat/index.ts`):
- **World tools**, executed server-side: `web_search` (DuckDuckGo HTML scrape → title/url/snippet), `fetch_page` (fetch + tag-strip → ~6k chars readable text), `calculate`, `get_current_time`.
- **Canvas tools**, recorded as `actions` for the client: `move_orb`, `spawn_window` (text or self-contained HTML), `close_window`.
- **`spawn_agent`** — runs a real nested agent loop server-side (world tools, ≤5 rounds) and returns findings to the parent model *and* emits a `spawn_agent` action so it appears on the canvas.

**Personas** (`AGENTS` map): `caden` (warm, plainspoken, quietly brilliant — depth goes in windows), `researcher` (deep research protocol: multi-angle search, fetch strongest sources, parallel agents, brief-in-a-window with source URLs), `scout` (1–3 sentences). All share `CANVAS_BRIEF`, which teaches the model its canvas abilities — keep it in sync when adding tools.

**Providers/keys:** Groq primary (`llama-3.3-70b-versatile` — fast tool-capable model; `fast` = 8b-instant for the plan pass), Gemini fallback. Unlimited keys in the RLS-locked `caden_api_keys` table, cycled atomically in Postgres (`get_next_api_key` / `mark_api_key_limited`).

**Deploying changes:** edit `supabase/functions/<name>/index.ts`, redeploy via the Supabase MCP `deploy_edge_function` tool (or CLI). Keep repo and deployed copies identical.

---

## What's not wired up yet

- No streaming; the plan phase + staggered actions provide the progressive feel.
- No dedicated voice pipeline (browser speech-to-text only).
- No rate-limiting on the public function — anyone with the site can burn the free-tier keys.
- Sub-agents run sequentially inside the request (Edge Function wall-clock is the constraint on very deep research).
- No memory beyond localStorage.
