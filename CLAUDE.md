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

Canvas mode is cut for now — a deliberate scope narrowing to focus on the
chat experience, a good transparent single conversational surface, before
it comes back, if it does. Voice (Gemini TTS reading replies aloud) came
back — see "Voice (Gemini text-to-speech)" below.

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
  server.ts                  — Express + ws: /api/chat, /api/status, /ws/log, /ws/sfx
  activity.ts                 — tracks in-flight chat turns so self-update waits for idle before restarting
  logbus.ts                    — forwards all console output into the System Log panel + buffers it since boot
  update.ts                   — self-update watcher (git fetch/pull → rebuild → exit; systemd relaunches)
  sfx.ts                        — status SFX: broadcasts + local aplay/paplay playback, synced with the browser
  telegram.ts                   — Telegram bot channel: text + voice notes, reuses the same agent loop
  tools/
    web.ts                      — web_search, fetch_page, calculate, get_current_time
    shell.ts                     — run_shell + the audit log + the hardcoded deny list
    browser.ts                    — Playwright wrapper, local-display / streamed modes
    desktop.ts                     — screenshot_desktop: whole-screen capture (local or remote session)
    agentDispatch.ts               — dispatch_agent, a bounded parallel research sub-agent
    memory.ts                       — remember tool + ~/.caden/memory.json (cross-session memory)
    system.ts                        — system_status: CPU temp, memory, disk, load, uptime
    weather.ts                        — get_weather: live conditions via wttr.in, no API key
    reminders.ts                       — set_reminder/list_reminders/cancel_reminder + the due-check watcher
public/
  index.html               — the whole web frontend: one self-contained file, no build step, no CDN deps
                              (amber industrial-terminal look — "Domestic Agent System")
  sfx/*.wav                — synthesized status sounds (sent/success/error/thinking/reminder/startup),
                              served statically and also played locally on the Pi by src/sfx.ts
bin/caden-chat             — thin wrapper exec'ing dist/cli.js; install.sh symlinks it to /usr/local/bin
systemd/caden.service      — the service unit (Restart=always, WantedBy=multi-user.target)
scripts/
  bootstrap.sh              — the single curl-pipeable installer: clones/updates the repo, then hands
                               off to install.sh (its own `read` prompts go via /dev/tty since the
                               curl|bash pipe consumes stdin — see install.sh's key-entry section)
  install.sh                 — the real installer: Node.js if missing, deps, Playwright, interactive
                                key entry, build, systemd install + start. Safe to re-run.
.github/workflows/pages.yml — republishes public/ to GitHub Pages on push (see "GitHub Pages mirror" below)
```

## Agent loop

Same shape it's always had: OpenAI-style `tools` + `tool_choice: auto`,
looped until the model stops calling tools or hits `AGENTS[name].rounds`.
Three personas in `agent.ts` — `caden` (a warm, economical personal
assistant: a sentence or two, no over-explaining, no reciting its own
features), `researcher` (deep multi-angle research, full findings laid out
in the reply since there's no canvas to put them in), `scout` (1–3
sentences, fast model, rarely touches tools). There used to be a separate
"plan" pass (`planThinking`) that ran a cheap model first just to produce a
few private reasoning lines for the UI's TRACE capsule — cut, because it
doubled the LLM requests every single chat turn made (one on the fast
model, one on the real one) for a single-user Pi with a small, easily
exhausted key pool. The TRACE capsule still shows the real tool-call steps
when a turn actually uses tools; it's just empty for a plain reply now
instead of narrating a rehearsal of it.

**Retrying through provider outages.** `runAgentTurnRetrying` (`agent.ts`)
doesn't fail the moment `runAgentTurn` throws — it only throws when *every*
key across *both* Groq and Gemini is exhausted or erroring (see `llm()` in
`providers.ts`), which is exactly the transient state a small key pool hits
under load, not a real bug. So it retries silently with backoff
(`RETRY_BASE_MS` 2s, doubling up to `RETRY_MAX_MS` 15s) for up to
`RETRY_BUDGET_MS` (3 minutes) before actually giving up — the person just
sees "working" the whole time, not a string of errors. A non-provider
failure (the agent looping past its round cap) is a real limit, not a blip,
so it's surfaced immediately instead of retried. It takes an `isCancelled()`
callback so both callers can hook up their own cancel signal: `server.ts`'s
`POST /api/chat` watches `req`'s own `close` event — the web UI's Cancel
button (next to Send, appears once a request is in flight) aborts its
`fetch` via an `AbortController`, which closes the connection and stops the
loop on its next check rather than burning through the rest of its budget
pointlessly. `telegram.ts` (below) uses the same helper with no cancel
signal — there's no "abort" gesture over Telegram, a reply either arrives
or the budget runs out.

**Context compaction.** A long conversation resends its entire history
every single turn — with no ceiling, that's both more tokens per request
(eating into Groq's per-minute token budget on top of its per-minute
request budget, part of what was exhausting the key pool) and, eventually,
a prompt too large to be useful. `compactHistoryIfNeeded` (`agent.ts`) runs
once per turn before the real call: once the non-system portion of history
crosses a rough size threshold (`SUMMARY_TRIGGER_CHARS`, ~12,000 chars), it
folds everything except the last `SUMMARY_KEEP_RECENT` (8) messages into
one compact system message via a single cheap-model call, and returns the
shrunken history to the caller. If it *was* already compacted once before
(tagged by a fixed `SUMMARY_MARKER` prefix), that prior summary is folded
into the new summarization pass too, rather than silently dropped — each
compaction is cumulative, not a one-shot loss of everything before the
first one. `server.ts` sends the compacted `history` back to the web UI in
the chat response whenever it fired, and the frontend replaces what it's
storing (and will resend) with it — the summarization cost is paid once,
not repeated on every subsequent turn. If the summarization call itself
fails (no providers available), it falls back to the uncompacted history
rather than losing the turn over it.

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
Each turn, `runAgentTurn` injects a `memoryContext`
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

- **Audio** — the SFX On/Off toggle (moved here from the Session panel), a
  separate Voice (Gemini TTS) On/Off toggle, six "test sound" buttons that
  hit `POST /api/sfx/test {event}` to fire any of the six status sounds
  immediately without needing a real chat turn, and a live readout of the
  current lookahead/compensation values (see Status SFX below).
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
- **Reminders** — a read-only list of pending reminders (`GET /api/reminders`);
  see Reminders below for how they're set (conversationally) and fire.
- **Telegram** — see the Telegram section below; the bot token and allowed
  chat ids can be set, viewed (masked), and cleared here.
- **Weather** — the OpenWeatherMap API key can be set/cleared here (`GET`/
  `POST /api/weather/config`); status shows which source `get_weather` is
  actually using right now (`openweathermap` vs the no-key `wttr.in`
  default).
- **Raw Status** — a collapsible `<pre>` of the live `/api/status` payload,
  for whenever the summarized panels aren't enough.

If you add another runtime-adjustable setting anywhere in the app, this is
where it belongs — don't invent a second settings surface.

## System Log panel (all activity, not just shell)

The web UI's second tab is a live view of the whole daemon's activity, fed
by `/ws/log` (`server.ts`) off the `auditEvents` channel. It started as
just the shell audit trail (`run_shell` logs every command there before it
runs — see Governance), and a few other things already emitted onto the
same channel directly (`sfx.ts` playback failures, `telegram.ts`
unauthorized-message notices). `src/logbus.ts` widened it to *everything*:

- **Console capture.** `installConsoleCapture()` (called first thing in
  `index.ts`, before anything logs) wraps `console.log/info/debug/warn/error`
  so each call still prints to the journal via the original method *and* is
  emitted as a log entry (`status` `log`/`warn`/`error`). So all the
  `[server]`/`[update]`/`[sfx]`/`[telegram]`/`[weather]` logging that used to
  only reach `journalctl -u caden` now also streams into the panel live. A
  re-entrancy guard (`inEmit`) rules out a listener that logs while handling
  an entry recursing forever. Only the daemon installs this — the
  `caden-chat` CLI is a separate process and never imports `logbus.ts`, so
  its normal terminal output is untouched.
- **Backlog since boot.** `logbus.ts` keeps a bounded ring buffer
  (`MAX_LOG_HISTORY`, 1000 entries) of every entry, so a browser that opens
  the panel *after* things have happened still gets the full picture, not
  just what happens after it connects. `/ws/log`'s connection handler
  replays `logHistory()` before attaching the live listener (no `await`
  between the snapshot and the attach, so single-threaded JS can't drop or
  duplicate an entry in the gap). The daemon self-updates by restarting, so
  "since boot" is the practical scope of "everything"; the frontend clears
  its view on each `ws.onopen` so a reconnect's fresh replay doesn't stack
  on the previous connection's copy.
- **Copy button.** The panel header has a Copy button that writes the full,
  *untruncated* log to the clipboard. The frontend keeps a parallel
  `logEntries` array of complete entry text (the on-screen lines truncate
  long shell output for readability; the copy doesn't). Clipboard access
  falls back to a hidden-textarea + `execCommand('copy')` because the Pi's
  UI is usually served over plain http on the LAN, where
  `navigator.clipboard` is unavailable (it needs a secure context).

If you add a new background/proactive behavior, it doesn't need special
wiring to show up here — just `console.log`/`console.error` normally and
`logbus.ts` forwards it. Reserve a *direct* `auditEvents.emit` for entries
that want the richer shape (a distinct `command`/`cwd`/`output`, e.g. shell
commands) rather than a flat message line.

**The chat/agent path logs its whole lifecycle** so a turn is actually
visible here, not silent. Forwarding console output only helps if the code
*emits* any — and originally the request path didn't, so sending a message
left the panel showing nothing but the two boot lines. Now each stage logs:
`server.ts`'s `/api/chat` logs receipt and the reply-sent summary (rounds +
tool-call count, and whether history was compacted) or a failure;
`agent.ts`'s `runAgentTurn` logs the turn's opening user text, each round's
tool calls, every `[tool]` call with its clipped args and result (warn if
the result carried an `error`), the final `[agent] reply`, and the
round-cap case; `providers.ts`'s `llm()` logs which `[llm]` provider/model
answered, a Groq→Gemini fallback, per-key 429 backoffs, and the
all-providers-failed case; `/api/tts` logs synthesis; and a due
`[reminder]` logs when it fires. Keep new work on this path logging in the
same shape — a bare `[stage] what happened` line — so the panel stays a
real-time trace of a turn rather than going quiet mid-request.

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

## Anti-hallucination discipline (claiming an action without doing it)

This bit Caden for real: asked to create a Gmail account, it described
having done so — without ever calling `browser_open` or any other tool.
`ANTI_HALLUCINATION_BRIEF` (`agent.ts`, carried by every persona) is direct
about this: never say an action in the world happened — an account
created, a message sent, a form submitted — unless the tool that does it
was actually called *and* the result was actually seen confirming it (a
tool result, or `browser_read`/`browser_screenshot` showing the outcome).
Multi-step tasks like account creation take many small tool calls across
many rounds — this is also why `caden`'s round cap was raised (10 → 14):
narrating the steps as already done is not a substitute for making the
calls. If something real blocks progress (a CAPTCHA, a phone-verification
wall, a missing selector), the instruction is to say exactly what happened
and where it got stuck — a believable-sounding success that didn't happen
is worse than admitting the task isn't finished. Keep this in sync with
`ACCURACY_BRIEF` above if you touch the personas — the two are companion
disciplines (don't trust what you didn't verify / don't claim what you
didn't do).

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
  `DISPLAY` is set. There used to be a live-view "Browser" tab in the web UI
  streaming periodic screenshots over `/ws/browser` — cut; `browser_screenshot`
  still exists as an on-demand tool for a specific look at the page, a
  different thing from a background live-preview feed. `browser_scroll`'s
  up/down directions move the mouse into the viewport before calling
  `page.mouse.wheel()` — without that, wheel events land at the default
  (0,0) mouse position and silently do nothing; this was caught by an
  actual live Playwright test, not assumed.
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
  once everything's been tried. Used directly by the `screenshot_desktop`
  tool; the web UI no longer has a live-view feed to also feed it into
  (see the browser tools entry above).
- **`remember`** — persists the user's name and durable facts across
  conversations. See Memory above.
- **`system_status`** (`tools/system.ts`) — real vitals about the machine
  Caden lives on: CPU temperature (`/sys/class/thermal/thermal_zone0/temp`,
  falling back to `vcgencmd measure_temp`), memory/disk usage, load average,
  system uptime. Built as a dedicated structured tool rather than left to
  `run_shell` — parsing `vcgencmd`/`df` output correctly through a
  text-only tool call is exactly the kind of thing a model otherwise gets
  subtly wrong. Answers "how are you doing" / "are you overheating" for
  real instead of a guess.
- **`get_weather`** (`tools/weather.ts`) — defaults to wttr.in's `j1` JSON
  endpoint, no API key needed (same "avoid key-gated dependencies where
  possible" instinct as the DDG-scrape `web_search`). If an OpenWeatherMap
  key is configured (Options tab's Weather section, or `OPENWEATHER_API_KEY`
  in `.env` as the first-boot default — same pattern as Telegram's config),
  that's tried first for more authoritative data and falls back to wttr.in
  if it ever fails, rather than losing weather entirely over one bad or
  rate-limited key. `location` accepts a city/place name or `lat,lon` — the
  latter routes to OpenWeatherMap's `lat`/`lon` params instead of `q`. The
  returned `source` field is always a plain site URL, never the actual
  request URL — that one carries the API key in its query string, and
  `source` gets surfaced straight back through the model's reply
  (`ACCURACY_BRIEF` has it cite sources as plain text), so leaking the real
  URL there would leak the key into chat history. This is itself a live
  source, so the persona treats it as authoritative rather than something
  `ACCURACY_BRIEF` demands double-checking via `browser_open`.
- **`set_reminder` / `list_reminders` / `cancel_reminder`** (`tools/reminders.ts`)
  — the one genuinely *proactive* thing in this app: Caden can surface
  something later without being asked again, even in a future conversation.
  See "Reminders" below.

## Reminders (proactive, not just reactive)

Persisted to `~/.caden/reminders.json` (same pattern as `memory.ts`).
`startReminderWatcher()` (called once from `index.ts`) checks on a 15s
interval rather than one `setTimeout` per reminder — simpler, and it
survives process restarts (self-update, crash) without needing to
reschedule anything on boot.

A reminder coming due does three things at once, all from the same check in
`checkDue()`:
1. Emits `reminderEvents` `"due"`, which `server.ts` relays over
   `/ws/reminders` for a live toast in the web UI (`showToast()` in
   `index.html`) — visible even if no chat is happening.
2. Calls `triggerSfx("reminder")` — the same synced-playback mechanism as
   every other status sound (see Status SFX below), so it's audible on the
   Pi's own speaker too, not just wherever a browser tab happens to be open.
3. Marks itself `fired` (but not yet `acknowledged`) so the *next* real chat
   turn folds it into context regardless of whether the toast/sound were
   seen or heard — `reminderContext()` in `agent.ts` checks
   `pendingNotifications()` right where `memoryContext` is injected, tells
   the model to mention it naturally, then calls `acknowledgeReminders()` so
   it isn't repeated on every subsequent turn forever.

`GET /api/reminders` (pending only) backs a small read-only list in the
Options tab — creating/cancelling reminders is conversational
("remind me to..."), not a form, since that's the natural way to use this.

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

**Versioning policy: bump on every fix, not just features.** Any commit
that fixes a bug bumps `package.json`'s version (minor, e.g. 1.1.0 →
1.2.0) as part of that same commit — this is what makes `MAINFRAME` in the
TELEMETRY panel a meaningful "what's actually running on the Pi right
now" signal after a self-update pulls it in, rather than a number that
only moves for new features. Don't batch several fixes under one bump;
each fix commit gets its own.

## Status SFX (Pi ↔ browser synced sound)

`src/sfx.ts` + `/ws/sfx` in `server.ts` give Caden six status sounds,
synthesized (not downloaded) into `public/sfx/*.wav` via
`scripts/gen-sfx.mjs` (see that script's comments, since there's no
license/CDN dependency this way):
- `sent` — the server received a message.
- `thinking` — the one looping sound: starts the moment a turn begins
  actually using tools (not on every reply), and keeps softly looping until
  the turn resolves — an audible "still on it" for turns that take several
  rounds of browsing/research, rather than a single blip followed by silence.
  See "Looping SFX" below for how the loop itself works.
- `success` — the reply completed.
- `error` — the turn failed.
- `reminder` — a reminder came due (see Reminders above) — deliberately the
  most attention-getting of the six, since it's the only one that fires
  unprompted.
- `startup` — Caden came online (`index.ts`, once per boot — including
  self-update relaunches, a reasonable "back online" moment too).

The goal: the Pi's own speaker and whatever browser is watching play the
*same* sound at the *same* instant, not just "whenever each one hears about
it."

The trick is that `triggerSfx()` never plays immediately — it computes
`playAt = now + LOOKAHEAD_MS` (220ms), broadcasts that timestamp over
`/ws/sfx`, and schedules its own local `aplay`/`paplay` call via
`setTimeout`. The browser does the mirror image: it preloads all six
sounds as decoded `AudioBuffer`s up front, and on receiving
`{event, play_at}` computes `delay = play_at - Date.now()` and calls Web
Audio's `AudioBufferSourceNode.start(audioCtx.currentTime + delay)` —
sample-accurate once invoked, unlike a bare `setTimeout` + `play()`.

**The Pi's local playback is compensated, not just scheduled for `playAt`.**
The browser's path has no startup cost once the AudioContext exists, but
spawning `aplay` does — fork+exec, dynamic-linking `libasound`, and
negotiating/opening the ALSA device all take real, non-trivial time, so a
naive "exec at playAt" leaves the Pi's audible sound trailing visibly behind
the browser's (this was the actual bug reported after SFX first started
working — sound was audible but late). The fix: schedule the local exec for
`playAt - <measured overhead>`, so that overhead is *consumed before* the
target instant instead of *added after* it — like a performer counting
themselves in early to land exactly on the beat. The overhead itself is
measured live rather than guessed: each real `aplay` call's wall-clock time
minus that clip's own known duration (read from its WAV header via
`wavDurationMs()`) is pure startup overhead, smoothed with an EMA
(`calibratedLatencyMs = calibratedLatencyMs*0.6 + overhead*0.4`) so it
adapts to this specific Pi's actual hardware/load rather than a fixed
constant. `SFX_AUDIO_DEVICE`'s `aplay` call also gets `--buffer-time
80000 --period-time 20000` to trim ALSA's own default buffering latency
(conservative enough not to risk underruns on a loaded Pi). `SFX_LOCAL_LATENCY_MS`
overrides the calibration with a fixed value if it ever seems wrong;
`GET /api/status`'s `sfx` field (also shown in the Options tab's raw status)
reports the current lookahead, compensation value, and whether it's
auto-calibrated or overridden.

None of this is physically perfect — it's bounded by clock skew between the
Pi and whatever device the browser's on, the one WS hop needed to learn the
target time, and how well the live-measured overhead tracks reality — but
this is the right architecture for "as close as achievable," not "first one
to hear about it wins." Verified live in this sandbox (no real audio
hardware to hear it) that the broadcast lead time and WAV-header duration
parsing are both correct; the actual startup-overhead measurement can only
be validated on the real Pi where `aplay` exists.

**Looping SFX (`thinking`).** `thinking.wav` isn't a blip — it's a 1-second
seamless loop unit (`loopableTone()` in `gen-sfx.mjs`): a soft carrier tone
with a gentle amplitude pulse, both constrained to complete a *whole number*
of cycles within the buffer (330 and 3 respectively), so `sample[0]` picks
up exactly where the end of the buffer left off — verified directly against
the generated WAV (the sample-to-sample delta across the wrap point matches
the delta just inside the loop exactly). No fade envelope either, since a
fade-to-silence would itself create an audible dip every repetition.

The browser just sets `AudioBufferSourceNode.loop = true` — Web Audio
replays a looping buffer back-to-back with no gap by construction. The Pi
has no equivalent native flag it can rely on portably, so `sfx.ts`'s
`startThinkingLoop()` does it manually: play the loop unit, and the instant
that single `aplay` call's callback fires, immediately play it again,
chaining for as long as `thinkingActive` stays true. A few tens of
milliseconds of process-spawn gap between repetitions is inaudible for a
soft ambient texture like this (it would matter for a tight music loop, not
here). If playback ever actually fails, the chain stops itself rather than
retrying forever and spamming the log.

Both sides stop on the *next* non-`thinking` event (`triggerSfx()` calls
`stopThinkingLoop()` first thing whenever `event !== "thinking"`; the
browser's `playSfxAt()` does the mirror-image `stopThinkingSource()`) —
naturally, since a turn only ever transitions from `thinking` to `success`
or `error`. This handoff doesn't need lookahead precision; the *new*
sound's `playAt` is what's actually synced, the loop just needs to get out
of the way. The Options tab's "Thinking" test button auto-stops itself
after 8s (`POST /api/sfx/test`) so a manual test never loops on the
speaker forever if nothing else happens to stop it.

Verified live (fake `aplay` stub in this sandbox, since there's no real
audio hardware here): the respawn chain kept calling `aplay` continuously
while active, and calling `triggerSfx("success")` stopped it immediately
with zero further calls — and in a real headless browser, the
`AudioBufferSourceNode` was confirmed to start with `loop=true` and receive
an explicit `.stop()` call the instant a `success` event arrived.

## Voice (Gemini text-to-speech)

Caden's replies are read aloud via Gemini's TTS — `synthesizeSpeech` in
`providers.ts` calls the Interactions API
(`POST https://generativelanguage.googleapis.com/v1beta/interactions`,
model `gemini-3.1-flash-tts-preview`, `x-goog-api-key` header) with
`response_modalities: ["audio"]` and `speech_config: { voice }`, reusing
the exact same `GEMINI_API_KEYS` pool as chat rather than a separate
key/service. The response is raw headerless PCM (`audio/l16; rate=24000;
channels=1` — no WAV container), so `synthesizeSpeech` wraps it in a real
WAV header (`pcmToWav`) before handing it back, so every consumer can treat
it as an ordinary playable file. Voice defaults to `Charon`, overridable
with `GEMINI_TTS_VOICE` in `.env` (other options: Puck, Kore, Fenrir, Orus,
Iapetus — this hasn't been judged against a real ear in this sandbox, so
treat the default as a starting pick, not a final one).

This replaced an earlier local engine (SAM, a vanilla-JS port of the 1982
C64 TTS chip) after deciding a cloud neural voice was worth the tradeoff of
a per-reply network call — SAM's `sam-js` dependency, `scripts/vendor-sam.sh`,
and `public/vendor/samjs.min.js` were removed entirely rather than left
around unused once both call sites (web UI, Telegram) moved to Gemini.

**Web UI:** `POST /api/tts { text }` (`server.ts`) calls `synthesizeSpeech`
and returns the WAV bytes directly as the response body
(`Content-Type: audio/wav`) rather than base64-in-JSON — `speakCaden()` in
`index.html` `fetch()`es it, `audioCtx.decodeAudioData()`s the response,
and plays it through the same `AudioContext` the status-SFX system already
unlocks on the first Send click (`ensureAudioCtx`). Synthesis + decode is
async, so a fast follow-up message (or muting TTS mid-flight) could
otherwise race and overlap two replies — each `speakCaden()` call is
tagged with an incrementing `speechRequestId` and a stale response is
dropped rather than played. TTS has its own On/Off toggle in the Options
tab (`localStorage`-persisted, independent of the status SFX toggle) —
turning it off calls `stopSpeech()`, which stops whatever's currently
playing via the `AudioBufferSourceNode`'s own `.stop()`.

**Telegram:** `sendVoiceReply` in `telegram.ts` calls the same
`synthesizeSpeech` directly from Node (no browser involved) and posts the
resulting WAV via `sendAudio` (see the Telegram section below).

**The "Kayden" pronunciation note.** The old SAM engine's crude reciter
rules mispronounced "Caden" as "CAD-en", so `speakCaden`/`sendVoiceReply`'s
text got a `\bcaden\b` → `Kayden` respelling before reaching the TTS
engine. That respelling now happens once, inside `synthesizeSpeech` itself
(so both callers get it for free) — kept as cheap, harmless insurance for
Gemini's voice too, since "Kayden" is itself a common name said the same
way ("KAY-den"), not because Gemini is known to have the same bug SAM did.
If it turns out Gemini already says "Caden" correctly on its own, this can
be dropped; nothing currently confirms it needs to be.

**Troubleshooting no sound from the Pi's speaker/headphone jack.**
`playLocal()` in `sfx.ts` used to swallow every failure silently — total
diagnostic dead end. It now logs the real `aplay`/`paplay` stderr to both
the journal (`journalctl -u caden -f`) and the live SYSTEM LOG panel
(reusing `run_shell`'s `auditEvents` channel), so a failure is visible
immediately from the Options tab's "test sound" buttons. `install.sh` now
also handles the common root causes directly instead of just documenting
them, in order:
1. **Wrong output routed** — Raspberry Pi OS commonly defaults audio to
   HDMI even with headphones in the 3.5mm jack. `install.sh` forces analog
   output via `raspi-config nonint do_audio 1` (falling back to
   `amixer cset numid=3 1` if `raspi-config` isn't present) — non-fatal on
   hardware without that control (USB audio, HATs).
2. **Muted or zero volume** — `install.sh` runs
   `amixer sset <ctl> unmute 100%` across the usual control names (Master,
   PCM, Speaker, Headphone), since the name varies by card and a mismatch
   shouldn't fail the install.
3. **User not in the `audio` group** — `aplay`/`paplay` need `/dev/snd/*`
   access; `install.sh` checks for and adds this, but existing installs
   need a fresh login (or systemd restart) to pick it up.
4. **paplay's `XDG_RUNTIME_DIR` is unset** — a systemd service isn't part of
   a graphical login session, so PulseAudio's user socket path isn't handed
   to it for free. `playLocal()` best-guesses `/run/user/<uid>` for the
   paplay fallback specifically for this reason; if that guess is wrong for
   your setup, set `XDG_RUNTIME_DIR` in the systemd unit's `Environment=`.

If none of that fixes it (or the hardware just isn't the onboard
bcm2835 output), `install.sh` prints `aplay -l`'s card/device list at the
end of setup — feed the right one into `SFX_AUDIO_DEVICE=plughw:<card>,<device>`
in `.env`.

## Telegram (remote access from outside the house)

`src/telegram.ts` is a second channel into the exact same agent loop as the
web UI — so Caden is reachable when you're not on the LAN. Dormant unless a
bot token is configured (see key management below); when it is,
`startTelegramBot()` long-polls the Bot API's `getUpdates` rather than
needing a public HTTPS webhook, since a home Pi behind NAT has neither.

**This is not real phone/video calling, and can't be** — the Telegram Bot
API has no access to Telegram's actual VOIP calls at all; those are
end-to-end encrypted client-to-client and never exposed to bots, by
Telegram's own design, not a limitation of this implementation. The
feasible (and implemented) equivalent is **voice notes**: send Caden a
voice message, it transcribes it (Groq Whisper — `transcribeAudio` in
`providers.ts`, reusing the exact same Groq key pool as chat rather than a
separate service/key) and replies with both a text message and a
synthesized voice note (`synthesizeSpeech` in `providers.ts` — the same
Gemini TTS the web UI uses, called directly from Node, no browser
involved) sent via `sendAudio` rather than the stricter `sendVoice`, which
requires actual OGG/Opus and would need an ffmpeg re-encode the plain WAV
`synthesizeSpeech` returns doesn't need otherwise.

**Access control is deny-by-default, deliberately.** This bot has the same
full, unrestricted shell/browser access as the web UI — an unauthenticated
Telegram bot would hand a stranger who finds its `@username` a shell on
your Pi. Only chat IDs in the allowlist are answered at all; anyone else's
message is logged to the audit log (reusing `auditEvents`, the same SYSTEM
LOG channel `run_shell` uses) and silently ignored, not replied to with an
error that would confirm the bot is even listening. There is no
auto-adopt-first-sender fallback — an unset allowlist means the bot
answers no one, on purpose.

**Key management (Options tab).** `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_ALLOWED_CHAT_IDS` in `.env` are only the first-boot default —
`GET`/`POST /api/telegram/config` (`server.ts`) back a Telegram section in
the Options tab that lets the token and allowlist be set, viewed, and
changed from the website itself, no SSH/`.env`-editing/restart needed.
`setTelegramConfig` (`telegram.ts`) persists to `~/.caden/telegram.json`
(same pattern as `memory.ts`/`reminders.ts`) and applies immediately: it
stops whatever's currently polling and restarts with the new config. A
changed token means a different bot's update stream, so its `pollOffset`
means nothing and gets reset; a changed allowlist alone doesn't need that.
`GET` never returns the raw token, only a masked preview
(`token_preview: "••••<last 4 chars>"`) — the Options tab's own token
input is `type="password"` and is cleared immediately after a successful
save rather than ever redisplaying what was typed.

Stopping and immediately restarting polling on a reconfigure has a real
race to avoid: the *old* loop's in-flight `getUpdates` call (up to its 30s
long-poll timeout) is still pending when this happens, and a plain boolean
flag flipped false-then-true-again would let it revive itself the moment
that call resolves and it rechecks the flag — two loops now racing on the
same `pollOffset`. `telegram.ts` uses a `generation` counter instead: each
loop iteration is bound to the generation it started with, so
`stopTelegramBot()`/`startTelegramBot()` incrementing it makes any older
loop's check fail for good, however long its last in-flight call takes to
return, rather than a boolean that can flip back true underneath it.

Each chat ID gets its own in-memory conversation history (`sessions` map in
`telegram.ts`), separate from the web UI's — it resets on restart, an
acceptable trade for single-user hardware that already restarts
periodically for self-update. It goes through the same
`compactHistoryIfNeeded` / `runAgentTurnRetrying` helpers `server.ts` uses
(see Agent loop above), so long Telegram conversations get the same
context compaction and provider-outage retry behavior as the web UI, not a
separate reimplementation of either. Always answers as the `caden` persona
— no mode switching over Telegram (not asked for; keep it simple until it
is).

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

**Waiting for in-flight requests before restarting.** A chat turn can
legitimately run for minutes now (`runAgentTurnRetrying`'s retry budget in
`agent.ts`) — restarting the instant a build finished used to call
`process.exit(0)` with zero regard for that, hard-killing any in-flight
`/api/chat` (or Telegram) request's connection out from under it. The
browser surfaces that as a bare `TypeError: Failed to fetch`, with no
indication anything was actually wrong server-side (this hit for real: SFX
key pools showed everything healthy, yet chat failed instantly, because
the failure was a restart racing the request, not a provider problem).
`src/activity.ts` is a tiny shared counter (`markBusy`/`markIdle`/`isBusy`)
that both `server.ts`'s `/api/chat` handler and `telegram.ts`'s message
handler increment/decrement around the agent-turn call; `checkOnce()` in
`update.ts` checks `isBusy()` after a successful build and waits (polling
every second, capped at `RESTART_WAIT_CAP_MS`, 4 minutes — a bit longer
than the chat retry budget) before exiting, rather than restarting straight
through an active request.

**This coverage had a gap: `/api/tts` wasn't tracked.** `speakCaden()` in
the web UI fires `POST /api/tts` *after* `/api/chat` has already returned
— by the time speech synthesis is in flight, the `/api/chat` handler has
already called `markIdle()`. Since only `/api/chat` and Telegram's message
handler touched `markBusy`/`markIdle`, `isBusy()` had no idea a synthesis
request was still running, so a self-update landing in that window would
restart immediately: killing the in-flight `/api/tts` connection, and
worse, leaving the server briefly and genuinely down while systemd
relaunches it — during which the person's *next* chat message (sent
moments after the reply they just heard) would get exactly the same bare
`Failed to fetch`, with a freshly-reset uptime making it look like nothing
was ever wrong. `/api/tts` now calls `markBusy`/`markIdle` too (`server.ts`),
so self-update's "wait for idle" check actually accounts for speech
synthesis, not just the chat turn that triggered it. (Telegram's
`sendVoiceReply` never had this gap — it's already awaited inside the same
`markBusy`/`markIdle` window as the chat turn, in `telegram.ts`.)

**The `markBusy` guard can't cover the restart *downtime* itself — the web
UI rides it out instead.** `markBusy`/`isBusy` only defers the restart
until in-flight requests finish; it does nothing for the ~1-2s gap where
the old process has exited and systemd hasn't finished relaunching yet. A
chat request that lands in that gap — sent during the relaunch, or arriving
microseconds after the watcher's single point-in-time `isBusy()` check — has
its connection dropped, which `fetch()` surfaces as a bare `TypeError:
Failed to fetch`. This is not hypothetical: it's what "CADEN // OFFLINE —
Failed to fetch" with a near-zero `UPTIME` in the TELEMETRY panel actually
was — a chat message racing a self-update restart (frequently the very
deploy that shipped the previous fix, since every push triggers a restart
within one poll interval). Since some downtime is inherent to an
exit-and-relaunch update model, the fix is client-side resilience rather
than trying to make the restart gap zero: `fetchChatWithReconnect` in
`public/index.html` catches a network-level failure (a `fetch()` rejection,
as opposed to an HTTP error response, which renders normally, or a user
cancel via the same `AbortController`), then polls `/api/status` until the
relaunched server answers and re-sends the same turn — up to a
`RECONNECT_BUDGET_MS` (90s) budget. The status line shows `RECONNECTING //
SERVER RESTARTING` meanwhile (a `reconnecting` flag the per-second status
timer honors so it doesn't clobber it back to `WORKING`), so a self-update
restart becomes an invisible ~2s blip instead of a dead-end error. This is
the client-side mirror of `runAgentTurnRetrying`'s "ride out a transient
outage rather than fail the person's message" stance (`agent.ts`). Note the
dropped attempt never returned a reply, so re-sending it is the natural
recovery, not a double-submit of a completed action. If a chat failure ever
does *not* correlate with a restart (`UPTIME` is not near-zero and no deploy
just happened), suspect a different cause — e.g. the agent opening a browser
under memory pressure on the 4GB Pi — and check `journalctl -u caden` for an
OOM-kill or crash rather than assuming this path.

## Deploying changes

There's no separate "deploy" step to a hosted platform anymore — pushing to
the tracked branch (`main` by default) is the deploy: the Pi picks it up via
the self-update watcher within one polling interval. For local iteration,
`npm run dev` (`tsc --watch`) + `npm start` against a `.env` with your own
keys works the same as production.

## GitHub Pages mirror (static file only — not a second backend)

`.github/workflows/pages.yml` republishes `public/` verbatim to GitHub
Pages on every push to `main` that touches it, using GitHub's own official
Pages actions (`configure-pages`/`upload-pages-artifact`/`deploy-pages` —
no third-party Action). This exists purely so the exact same `index.html`
is reachable at a stable GitHub Pages URL, always byte-identical to what
the Pi serves, without hand-copying anything — it does **not** stand up a
second Caden backend. The Pages copy is 100% static; every `/api/...` and
`/ws/...` call in it is meaningless without a real Caden process to answer.

**Making the Pages copy actually functional** is what the Options tab's
Remote Access section (and the `<base id="apiBase">` tag in `<head>`) is
for: saving a "Caden server address" there sets `<base href>` to that
origin, and every relative `/api/...`/`/ws/...` reference in the page
(they all start with `/`) resolves against it instead of the page's own
origin — `wsUrl()` in `index.html` derives `ws(s)://` from `document.baseURI`
for the same reason. Left blank (the default), nothing changes — this only
matters once the Pi is actually reachable from wherever the page is loaded.

**That reachability is the real decision, and it's a significant one.**
This app has zero authentication (see "What's not wired up yet" below) and
`run_shell` gives whoever can reach it full shell access to the Pi. Raw
port-forwarding exposes that, unauthenticated, to the entire public
internet — trivially discoverable by internet-wide scanners, not just
"security through obscurity of the port number." Don't wire up port
forwarding for this without either (a) adding real authentication in front
of the API first, or (b) using a private-network approach instead (a
WireGuard/Tailscale-style VPN, or a tunnel like Cloudflare Tunnel) that
reaches the Pi without exposing any port to the public internet at all.
This is worth treating as a deliberate, explicit decision, not a quick
"let me know if I need to port forward" afterthought.

## What's not wired up yet

- Auth on the local web UI (LAN-only, single user, no login). This matters
  more than it sounds: `run_shell` gives whoever loads this page full,
  unrestricted shell access to the Pi. It's a fine tradeoff on a LAN only
  the household can reach; it stops being fine the moment this UI is made
  reachable from the public internet (a port-forward, a tunnel, anything
  that isn't LAN-only) without adding real auth first.
- Canvas mode — deliberately cut this pass. Voice came back (Gemini TTS).
- The old stub-only home-automation/Twilio tool ideas from an even earlier
  prototype were never resurrected and aren't planned.
