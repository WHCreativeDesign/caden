# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Caden is a personal AI chatbot — composed, precise, quietly capable. One page, one presence. It has two parts: a static frontend deployed to GitHub Pages, and a backend that runs entirely on Supabase (Edge Functions + Postgres). No local hardware anywhere in the stack.

**Live site:** `https://whcreativedesign.github.io/caden/`
**Repo:** `WHCreativeDesign/caden`
**Supabase project:** `lrjiopczasvcrhglweth` (`https://lrjiopczasvcrhglweth.supabase.co`)

There is deliberately **no home-automation integration**. Caden is a chatbot, not a home assistant; don't add smart-home tooling unless explicitly asked.

---

## Frontend (`index.html`)

No build step. The entire app is `index.html` at the root — fully self-contained (its own `<style>` and `<script>`, Google Fonts via `<link>`). It does **not** use `styles.css`/`tokens/` — those belong to the legacy design-system pages under `guidelines/` and `components/` and are kept only as reference.

**Design language — dark, cinematic, instrument-grade.** Jarvis-adjacent without the kitsch:

- Near-black blue-tinted field (`#060A0F`) with a faint radial center glow and a barely-there dot lattice masked toward the edges.
- One luminous liquid orb is the presence: radial cyan-white core, slow `caden-morph` border-radius cycle, soft halo, two thin counter-rotating conic arcs. No lens flares, no HUD clutter, no fake radar.
- Hairline borders (`rgba(148,178,210,0.13)`), glass panels (`backdrop-filter: blur`), radius scale 8/10/13/14px.
- Type: Archivo for body/UI, IBM Plex Mono for microtype (eyebrows, meta, telemetry). Uppercase mono labels with wide tracking. Tabular numerals for timestamps.
- Single accent `#62D9E8` used sparingly; warm `#E8B872` only for error states. **No emoji anywhere. No gradients on buttons. No corny sci-fi copy.**
- Real data only in decorative details: the bottom-left telemetry line shows the actual session id, agent, and last round-trip latency.

**Orb state machine:** `idle` (18s morph) → `listening` (9s morph + 7 waveform bars) → `thinking` (core dissolves into a gooey metaball cluster that orbits apart and liquifies back together — SVG goo filter + glow pass, SMIL rotation) → `speaking` (orb drifts left, glass answer panel slides in). Arc rings accelerate while thinking.

**Two view modes** (segmented control in the top bar, persisted):
- **Canvas** — the orb experience; answers appear in the right-hand glass panel; while thinking, a live one-line thought ticker cycles under the orb.
- **Chat** — scrolling conversation: user bubbles right (cyan-tinted), assistant cards left with agent eyebrow + meta line.

**Visible thinking (two-phase):** on send, the frontend first POSTs `{phase:'plan'}` — a fast model pass that returns genuine reasoning steps, rendered live line-by-line in a "thinking" capsule (chat) and the ticker (canvas) — then POSTs the real request with the plan attached. When the answer lands, tool executions are appended and the capsule collapses to `thought for N.Ns · N steps` (Claude/Gemini-style). Thinking shown in the UI is always real model output — never fabricate it.

**Session:** `localStorage` (`caden.session.v2`) persists mode, agent, message history, and the render log. "New" clears it. Voice input uses the Web Speech API where available.

`ui_kits/canvas/index.html` is a meta-redirect to `/caden/` — don't put content there.

**Deployment:** every push to `main` triggers `.github/workflows/deploy.yml` → GitHub Pages (source must be set to GitHub Actions).

---

## Backend (`supabase/functions/`)

Deno/TypeScript Supabase Edge Functions — the only backend. Deployed on project `lrjiopczasvcrhglweth`.

**Endpoints** (both `verify_jwt: true`; the frontend authenticates with the public anon key — never ship the service-role key client-side):
- `POST /functions/v1/chat` — OpenAI-compatible agent loop (`supabase/functions/chat/index.ts`)
- `GET /functions/v1/health` — per-provider key availability (`supabase/functions/health/index.ts`)

**Request extensions:** `agent` (`caden` | `analyst` | `scout` — server-side persona + model profile), `model` (profile override), `phase: "plan"` (fast private-reasoning pass returning thinking lines), `plan` (thinking text injected as context for the answer), `max_tool_rounds`.

**Response extension:** `caden: { agent, rounds, steps: [{tool, arguments, result}] }` — plus `caden.thinking` on plan responses.

**Agents** are defined in the `AGENTS` map in `chat/index.ts` — a system prompt + profile per persona. Caden's voice: composed chief-of-staff, dry wit, no theatrics, never "just an AI". Keep new personas consistent with that register.

**Tools** live in the `TOOLS` registry in `chat/index.ts` (`get_current_time`, `calculate` so far). Each entry is `{schema, handler}`; executions are recorded as steps and returned to the client. Add a tool = add one registry entry.

**Key store:** the `caden_api_keys` table (`provider` = `groq` | `gemini`, `api_key`, `active`, usage/rate-limit bookkeeping). RLS enabled with **no public policy** — only the service-role key (function secret) reaches it. Unlimited keys per provider; add via SQL/table editor.

**Key cycling** is in Postgres because Edge Function instances are stateless: `get_next_api_key(provider)` (atomic least-recently-used pick via `FOR UPDATE SKIP LOCKED`) and `mark_api_key_limited(...)` after a 429. Both `SECURITY DEFINER`, granted to `service_role` only (migration `add_key_cycling_functions`).

**Provider routing:** Groq primary (`llama-3.3-70b-versatile`), per-key cycling up to `MAX_KEY_ATTEMPTS`, then Gemini fallback (`gemini-2.0-flash`). Plain `fetch` against both OpenAI-compatible endpoints. Model profiles: `orchestrator`, `fast`, `deep`.

**Deploying changes:** edit `supabase/functions/<name>/index.ts`, then redeploy via the Supabase MCP `deploy_edge_function` tool (or `supabase functions deploy` with the CLI). Keep the repo copy and the deployed copy identical.

---

## What's not wired up yet

- No streaming (`stream: true`) — the plan phase provides progressive feedback, but token streaming would be better still.
- No dedicated voice pipeline — the mic uses browser speech-to-text; a Gemini-based voice path is a candidate (the Gemini key pool is already provisioned).
- No rate-limiting on the public function — anyone with the site can invoke it and consume free-tier keys.
- No web-search or memory tools yet — the `TOOLS` registry is where they'd go.
