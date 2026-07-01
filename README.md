# Caden

A personal AI, one page deep.

Caden is a chatbot with a presence: a luminous liquid orb that listens, visibly
thinks — real reasoning steps, streamed to the surface while the answer forms —
and responds. Composed, precise, quietly capable. Jarvis energy, no costume.

**Live:** https://whcreativedesign.github.io/caden/

## How it's built

- **Frontend** — a single self-contained `index.html`. No framework, no build
  step. Two views: *Canvas* (the orb) and *Chat* (the conversation), three
  agents (Caden / Analyst / Scout), visible thinking, tool-call traces, voice
  input, local session memory.
- **Backend** — Supabase Edge Functions (`supabase/functions/`). An
  OpenAI-compatible agent loop over Groq (primary) and Gemini (fallback),
  drawing from an unlimited pool of free-tier API keys stored in Postgres and
  cycled atomically. No servers to run.

Design and architecture notes live in [CLAUDE.md](CLAUDE.md). Legacy
design-system files (`tokens/`, `components/`, `guidelines/`) predate the
current dark design and are kept as reference only.
