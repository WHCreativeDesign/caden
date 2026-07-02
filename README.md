# Caden

A personal research companion, one page deep.

Caden is a chatbot with a body and a room: a pearlescent orb in a grainy,
hour-aware sky. It thinks out loud — real reasoning, streamed to the surface —
searches and reads the live web, and shapes its own canvas: it moves itself,
opens draggable glass windows, writes interactive elements it codes on the
spot, and dispatches research agents that appear on screen while they work.

**Live:** https://whcreativedesign.github.io/caden/

## How it's built

- **Frontend** — a single self-contained `index.html`. No framework, no build
  step. Two views: *Canvas* (the orb, its windows, a serif answer panel) and
  *Chat* (glass cards). Three agents (Caden / Research / Scout), visible
  thinking, tool-call traces, model-driven canvas actions, synthesized chimes
  and ambient sound, voice input, local session memory.
- **Backend** — Supabase Edge Functions (`supabase/functions/`). An
  OpenAI-compatible agent loop over Groq (primary) and Gemini (fallback) with
  real tools: web search, page scraping, canvas control, and nested research
  agents. API keys live in an RLS-locked Postgres table and cycle atomically.
  No servers to run.

Design and architecture notes live in [CLAUDE.md](CLAUDE.md). Legacy
design-system files (`tokens/`, `components/`, `guidelines/`) predate the
current design and are kept as reference only.
