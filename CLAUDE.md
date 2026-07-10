# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Caden is a personal agent that lives on a Raspberry Pi 4B (4GB) as a
persistent daemon — a local, self-updating "OpenClaw, but Caden": real shell
access to the machine it runs on, a real browser it drives itself, live web
search, and a retro-futuristic local web UI for chatting with it and watching
what it's doing in real time.

There is no cloud backend and no static hosted frontend anymore — that
architecture (Supabase Edge Functions + GitHub Pages) was retired. Everything
lives in this repo and runs on the Pi itself.

Canvas mode and voice mode are cut for now. This is a deliberate scope
narrowing to focus on the chat experience — a good, transparent, single
conversational surface — before any of that comes back, if it does.

---

## Governance model — read this before touching `src/tools/shell.ts`

Caden has **full, unrestricted shell access** as whatever user runs the
`caden` systemd service. There is no command allowlist and no
approval-gating step. The safety net is the **audit log**
(`~/.caden/audit.log`, tailed live into the web UI's System Log panel) —
every command is logged *before* it runs, so even a crash mid-command leaves
a record.

The one deliberate exception is a small, fixed deny-pattern list in
`src/tools/shell.ts` (`CATASTROPHIC_PATTERNS`) that refuses a handful of
literally irreversible self-destructive commands — disk-format (`mkfs`),
writing raw bytes over a block device (`dd ... of=/dev/sd*` etc.), and
root-wipe (`rm -rf /`). This exists purely so a hallucinated command can't
brick the device Caden runs on and take itself down with it. It is
intentionally narrow — do not grow it into a broader allowlist or
approval-gate; that was explicitly considered and rejected in favor of "full
access, audited."

---

## Repo layout

```
src/
  index.ts             — daemon entrypoint: loads .env (dev only), starts the server + update watcher
  cli.ts                — caden-chat: a terminal chat client for a running Caden (talks to /api/chat)
  env.ts                 — shared .env loader used by both index.ts and cli.ts
  agent.ts                — the tool-calling agent loop, personas (caden/researcher/scout)
  providers.ts              — Groq/Gemini key cycling (in-memory, single-user — no DB)
  server.ts                  — Express + ws: /api/chat, /api/status, /ws/log, /ws/browser
  update.ts                   — self-update watcher (git fetch/pull → rebuild → exit; systemd relaunches)
  tools/
    web.ts                      — web_search, fetch_page, calculate, get_current_time
    shell.ts                     — run_shell + the audit log + the hardcoded deny list
    browser.ts                    — Playwright wrapper, local-display / streamed modes
    agentDispatch.ts               — dispatch_agent, a bounded parallel research sub-agent
    memory.ts                       — remember tool + ~/.caden/memory.json (cross-session memory)
public/
  index.html               — the whole web frontend: one self-contained file, no build step, no CDN deps
                              (amber industrial-terminal look — "Domestic Agent System")
bin/caden-chat             — thin wrapper exec'ing dist/cli.js; install.sh symlinks it to /usr/local/bin
systemd/caden.service      — the service unit (Restart=always, WantedBy=multi-user.target)
scripts/
  bootstrap.sh              — the single curl-pipeable installer: clones/updates the repo, then hands
                               off to install.sh (its own `read` prompts go via /dev/tty since the
                               curl|bash pipe consumes stdin — see install.sh's key-entry section)
  install.sh                 — the real installer: Node.js if missing, deps, Playwright, interactive
                                key entry, build, systemd install + start. Safe to re-run.
```

## Agent loop

Same shape it's always had: OpenAI-style `tools` + `tool_choice: auto`,
looped until the model stops calling tools or hits `AGENTS[name].rounds`.
Three personas in `agent.ts` — `caden` (a warm, economical personal
assistant: a sentence or two, no over-explaining, no reciting its own
features), `researcher` (deep multi-angle research, full findings laid out
in the reply since there's no canvas to put them in), `scout` (1–3
sentences, fast model, rarely touches tools). A lightweight "plan" pass
(`planThinking`) runs a cheap model first to produce a few private reasoning
lines, shown live in the UI's TRACE capsule before the real answer streams
in.

**Tone & relationship.** The `caden` persona is deliberately relational, not
a research terminal: on first contact (see Memory below) it gives a short
greeting, notices it hasn't met you, and asks your name before anything
else; once you give it, it saves it and greets you by it from then on. The
guiding rule is brevity and warmth — say the thing that matters and stop. If
you're editing the persona, keep it short and resist the urge to make it
list capabilities.

## Memory

`src/tools/memory.ts` persists what Caden knows about you across
conversations in `~/.caden/memory.json` (`{ user_name, first_seen, notes }`).
Each turn, `runAgentTurn` (and the plan pass) injects a `memoryContext`
system message right after the persona: either "first contact, you don't
know their name" or "their name is X; you also remember …". The `remember`
tool writes to it — Caden calls it the moment it learns your name and for
durable facts/preferences. "First contact" is defined by having no name and
no notes yet, so the greeting stays honest even if a session is abandoned
before a name is given. This is what makes the relational tone above
actually true rather than faked per-session.

## Accuracy discipline

A `web_search` snippet is a lead, not a fact — this bit Caden for real once:
a "latest Meta glasses" question got answered straight from a stale search
snippet and missed newer models a human would've found by actually opening
the product page. Every persona's prompt now carries `ACCURACY_BRIEF`
(`agent.ts`): for anything time-sensitive or specific (current products,
prices, availability, "latest"/"newest" anything), open the strongest 1–2
sources with `fetch_page` or `browser_open` and read what they actually say
before asserting it, prefer primary sources over aggregator blogs, say so if
sources disagree, and always cite the URL(s) actually read as plain text in
the reply — the frontend auto-linkifies any `http(s)://` URL in a message
body, so a cited source becomes a clickable link for free. `dispatch_agent`
(below) exists specifically to do this verification legwork with its own
browser when a question needs real digging. Keep this discipline in sync
across `caden`/`researcher`/`scout` if you touch the personas — it's the
main defense against confidently-wrong answers, not a one-off patch.

## Tools

- **`web_search` / `fetch_page` / `calculate` / `get_current_time`** —
  ported near-verbatim from the retired Supabase function; the
  DuckDuckGo-scrape approach and page-text extraction already worked.
- **`run_shell`** — full shell access, audited. See Governance above.
- **`browser_open` / `browser_click` / `browser_type` / `browser_scroll` /
  `browser_drag` / `browser_read` / `browser_screenshot` / `browser_close`**
  — one long-lived Playwright Chromium instance. `BROWSER_MODE` env (`auto`
  | `local` | `stream`): `local` launches headed on the Pi's attached
  display (needs `DISPLAY` set, i.e. a desktop session); `stream` launches
  true headless (no X server needed at all); `auto` picks based on whether
  `DISPLAY` is set. **Live view streams to the web UI's Browser tab
  regardless of mode** — a headed page screenshots just as well as a
  headless one, so what the browser is doing is watchable in real time
  whether or not there's a monitor on the Pi. The screenshot interval
  defaults to `BROWSER_STREAM_INTERVAL_MS` (700ms) and is live-adjustable
  via `POST /api/browser/interval` (the Browser tab's dropdown does this) —
  `startStreaming` in `browser.ts` uses a self-rescheduling `setTimeout`
  rather than `setInterval` specifically so a live interval change takes
  effect on the next tick, not just after a restart. Frames only get
  captured while someone's actually watching (`addStreamViewer`/
  `removeStreamViewer`, wired to `/ws/browser` connect/disconnect).
  `browser_scroll`'s up/down directions move the mouse into the viewport
  before calling `page.mouse.wheel()` — without that, wheel events land at
  the default (0,0) mouse position and silently do nothing; this was caught
  by an actual live Playwright test, not assumed.
- **`dispatch_agent`** — a bounded (8-round) sub-agent with the full web
  *and* browser toolset, so it can verify a claim on the actual page rather
  than trusting a search snippet. Returns findings as text for the parent to
  fold into its reply — no canvas to render it in anymore. Shares the same
  single global browser instance as the parent agent (intentional — this is
  a 4GB Pi, running multiple Chromium instances isn't something to build
  toward); in practice this is safe because tool calls execute sequentially,
  never concurrently, within a turn.
- **`remember`** — persists the user's name and durable facts across
  conversations. See Memory above.

## Key management

No more Postgres/RLS key-cycling table — this is single-user hardware now,
so `providers.ts` just round-robins comma-separated key lists from
`GROQ_API_KEYS` / `GEMINI_API_KEYS` in `.env`, with in-memory 429 backoff.

## Self-update

`update.ts` polls `git fetch origin <UPDATE_BRANCH>` on an interval
(`UPDATE_INTERVAL_MS`, default 3 min). On new commits: `git pull --ff-only`,
`npm ci && npm run build`, then `process.exit(0)` — the systemd unit's
`Restart=always` relaunches the freshly built app immediately. This restarts
the **Caden process**, never the Pi. No extra privilege is needed beyond
what the service already has.

## Deploying changes

There's no separate "deploy" step to a hosted platform anymore — pushing to
the tracked branch (`main` by default) is the deploy: the Pi picks it up via
the self-update watcher within one polling interval. For local iteration,
`npm run dev` (`tsc --watch`) + `npm start` against a `.env` with your own
keys works the same as production.

## What's not wired up yet

- Auth on the local web UI (LAN-only, single user, no login).
- Canvas mode and voice mode — deliberately cut this pass.
- The old stub-only home-automation/Twilio tool ideas from an even earlier
  prototype were never resurrected and aren't planned.
