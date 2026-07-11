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
  server.ts                  — Express + ws: /api/chat, /api/status, /ws/log, /ws/browser, /ws/sfx
  update.ts                   — self-update watcher (git fetch/pull → rebuild → exit; systemd relaunches)
  sfx.ts                        — status SFX: broadcasts + local aplay/paplay playback, synced with the browser
  tools/
    web.ts                      — web_search, fetch_page, calculate, get_current_time
    shell.ts                     — run_shell + the audit log + the hardcoded deny list
    browser.ts                    — Playwright wrapper, local-display / streamed modes
    desktop.ts                     — screenshot_desktop: whole-screen capture (local or remote session)
    agentDispatch.ts               — dispatch_agent, a bounded parallel research sub-agent
    memory.ts                       — remember tool + ~/.caden/memory.json (cross-session memory)
public/
  index.html               — the whole web frontend: one self-contained file, no build step, no CDN deps
                              (amber industrial-terminal look — "Domestic Agent System")
  sfx/*.wav                — synthesized status sounds (sent/success/error), served statically and
                              also played locally on the Pi by src/sfx.ts
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

## Options / debug panel

The web UI's fourth tab (`viewOptions` in `public/index.html`) is the single
home for runtime-adjustable settings and debug controls — things you'd
otherwise need to SSH in and either edit `.env` + restart, or poke at with
`curl`, for. Every control there is backed by a real endpoint, not a fake
toggle:

- **Audio** — the SFX On/Off toggle (moved here from the Session panel) and
  three "test sound" buttons that hit `POST /api/sfx/test {event}` to fire a
  sound immediately, without needing a real chat turn to happen to try one.
- **Browser** — a mode override (`POST /api/browser/mode`) that beats
  `BROWSER_MODE` from `.env` at runtime (`setModeOverride` in
  `tools/browser.ts`), plus a Restart button (`POST /api/browser/restart` →
  `closeBrowser()`) so the override actually takes effect immediately rather
  than waiting for whatever tool call next happens to relaunch the browser.
- **Self-Update** — poll interval, adjustable the same way the browser
  stream interval is (`setUpdateInterval` in `update.ts`, clears and
  re-arms the timer rather than needing a restart), and a Check Now button
  (`POST /api/update/check-now` → `checkNow()`, sharing `checkOnce()` with
  the scheduled poll via a `checking` guard so the two can't race).
- **Memory** — a live summary of what Caden currently remembers
  (`GET /api/memory`) and a Forget Me button (`POST /api/memory/forget` →
  `forgetMemory()` in `tools/memory.ts`) that resets it to first-contact —
  useful both for actually asking to be forgotten and for testing the
  greeting flow without editing `~/.caden/memory.json` by hand.
- **Raw Status** — a collapsible `<pre>` of the live `/api/status` payload,
  for whenever the summarized panels aren't enough.

If you add another runtime-adjustable setting anywhere in the app, this is
where it belongs — don't invent a second settings surface.

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

## This Pi is Caden's own machine

`OWN_MACHINE_BRIEF` in `agent.ts` states plainly, in the `caden`/`researcher`
system prompts, that the Pi is Caden's own personal computer, not a device
it's a guest on — so it should never hedge, ask permission, or claim it
"can't tell" what's on screen. This exists because it did exactly that for
real: asked what was on screen, it tried a few window-management CLI tools
that weren't installed (`wmctrl`, `xdotool`), got empty/failed output from
each, and gave up rather than reaching for `screenshot_desktop` or just
installing what it needed. Keep this framing in sync with the governance
model above if you touch either — "full access, audited" is meant to make
Caden confident about acting on its own hardware, not just permissive on
paper.

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
- **`screenshot_desktop`** (`tools/desktop.ts`) — captures the ENTIRE
  desktop, every window, not just whatever's inside the browser's own tab.
  Shells out to `grim` (Wayland) or `scrot`/`import` (X11), whichever
  actually works. Deliberately does **not** gate on `process.env.DISPLAY`/
  `WAYLAND_DISPLAY` being set and bail out if empty — Caden runs as a
  systemd service, which does not inherit those vars from an interactive
  session (local login, or a remote one like Raspberry Pi Connect) even
  while one is actively running. Instead it tries the env vars if present,
  then falls back to the near-universal defaults for a Pi's first desktop
  session (`:0` / `wayland-0`), across both tool families, and only errors
  once everything's been tried. The Browser tab's live stream
  (`browser.ts`'s `startStreaming`) calls this on every tick *first*,
  falling back to a plain Playwright page screenshot only if it fails
  outright — so the live view shows the real desktop whenever one is
  reachable, not just the inside of the browser tab.
- **`remember`** — persists the user's name and durable facts across
  conversations. See Memory above.

## Vision (image input)

Caden can see images two ways: the person attaching one in the web UI (the
chat input's Attach button, or pasting an image from the clipboard — both go
through client-side downscaling to ~1400px/JPEG-80% before ever hitting the
network), and its own screenshots (`screenshot_desktop` / `browser_screenshot`)
being shown back to it. Both funnel through the same mechanism: a message
with multimodal `content` — a `{type:"text"}` part plus one or more
`{type:"image_url", image_url:{url:"data:..."}}` parts, the standard
OpenAI-style shape.

For tool-returned screenshots specifically: `runAgentTurn` in `agent.ts`
never leaves the raw base64 sitting in the tool-call result — a giant base64
string is both wasteful context and useless to a text-only model, which
can't "see" it there anyway. Instead the tool result gets replaced with a
small stub (`{ok: true, note: "..."}`) and the actual image is pushed as a
follow-up `user` message with an `image_url` part, so the model genuinely
sees it on its next turn. `IMAGE_RESULT_TOOLS` in `agent.ts` is the set of
tool names this applies to (`screenshot_desktop`, `browser_screenshot`).

Groq's everyday tool-calling models (`llama-3.3-70b-versatile` etc.) don't
take image input at all, but Groq also hosts natively multimodal models that
still support tool calling — so vision isn't Gemini-only. `providers.ts`'s
`MODELS` map has a separate `groqVision` id per profile
(`qwen/qwen3.6-27b`, currently the only vision+tool-calling model Groq
serves — a preview model, not GA); `llm()` detects an `image_url` content
part and swaps to that model id, but the provider order is unchanged — Groq
first, Gemini as fallback if Groq fails, exactly like plain text. The prior
pick (`meta-llama/llama-4-scout-17b-16e-instruct`) was deprecated by Groq
mid-2026, which silently broke image recognition (the model kept responding,
just without seeing the image) rather than erroring loudly — Groq rotates
its vision lineup often enough that this is worth a second look via
https://console.groq.com/docs/vision if attached images stop being "seen"
again.

## Version ("mainframe version")

`src/version.ts` reads `MAINFRAME_VERSION` straight from `package.json`'s
`version` field — one source of truth, always accurate for whatever build is
actually running since self-update rebuilds and restarts the process (fresh
module load = fresh read). It's injected into `OWN_MACHINE_BRIEF` in
`agent.ts` so Caden can just state its own version if asked, rather than
guessing or trying to shell out to check — which is exactly what it did
before this existed (tried a hallucinated `mainframe -v` command). Also
surfaced in `/api/status` as `mainframe_version` and shown in the web UI's
TELEMETRY panel as `MAINFRAME`. Bump `package.json`'s version to update it.

## Status SFX (Pi ↔ browser synced sound)

`src/sfx.ts` + `/ws/sfx` in `server.ts` give Caden three status sounds —
`sent` (message received by the server), `success` (reply completed),
`error` (the turn failed) — synthesized (not downloaded) into
`public/sfx/*.wav` (see the generator script used to build them, since
there's no license/CDN dependency this way). The goal: the Pi's own speaker
and whatever browser is watching play the *same* sound at the *same*
instant, not just "whenever each one hears about it."

The trick is that `triggerSfx()` never plays immediately — it computes
`playAt = now + LOOKAHEAD_MS` (150ms), broadcasts that timestamp over
`/ws/sfx`, and schedules its own local `aplay`/`paplay` call for that exact
future instant via `setTimeout`. The browser does the mirror image: it
preloads all three sounds as decoded `AudioBuffer`s up front, and on
receiving `{event, play_at}` computes `delay = play_at - Date.now()` and
calls Web Audio's `AudioBufferSourceNode.start(audioCtx.currentTime + delay)`
— sample-accurate once invoked, unlike a bare `setTimeout` + `play()`. Both
sides are targeting the same wall-clock moment instead of racing a message
across the network, which is what actually keeps them close — this was
verified live (headless Playwright + a local server, no real audio hardware
in this sandbox to hear it, but confirmed the browser schedules
`start(when)` at the correct future offset and the server broadcasts/plays
locally at the matching timestamp). It isn't physically perfect — bounded by
clock skew between the Pi and whatever device the browser's on, and the one
WS hop needed to learn the target time — but this is the right architecture
for "as close as achievable," not "first one to hear about it wins."

Requires `aplay` (alsa-utils) or `paplay` (pulseaudio-utils) on the Pi —
`install.sh` installs both. The web UI has an SFX On/Off toggle
(`localStorage`-persisted) in the SESSION panel; audio only starts once
unlocked by a genuine user gesture (the Send button / Enter key), per
browser autoplay policy.

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
