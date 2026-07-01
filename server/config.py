import os
from dotenv import load_dotenv

load_dotenv()

def _split(env_var: str) -> list[str]:
    return [k.strip() for k in os.getenv(env_var, "").split(",") if k.strip()]

# ── Key pools ──────────────────────────────────────────────────────────────────
# Seed keys from .env (optional). The live pool is normally sourced from Supabase
# (see below) and merged on top of these at startup, then refreshed periodically.
# Add as many keys as you want, comma-separated in .env — or, preferably, store an
# unlimited number of them in the Supabase `caden_api_keys` table.
GROQ_KEYS   = _split("GROQ_API_KEYS")
GEMINI_KEYS = _split("GEMINI_API_KEYS")

# ── Supabase key store ───────────────────────────────────────────────────────────
# Caden pulls its Groq (chat) + Gemini (voice) key pools from a Supabase table so
# you can add/remove an unlimited number of free-tier keys without redeploying.
# SUPABASE_SERVICE_ROLE_KEY is required to read the locked-down table (grab it from
# Supabase → Project Settings → API). Leave these blank to run env-keys-only.
SUPABASE_URL              = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_KEYS_TABLE       = os.getenv("SUPABASE_KEYS_TABLE", "caden_api_keys")
# How often (seconds) to re-sync the key pools from Supabase. 0 disables refresh.
KEY_REFRESH_INTERVAL      = int(os.getenv("KEY_REFRESH_INTERVAL", 300))

def supabase_enabled() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)

# ── Provider base URLs ─────────────────────────────────────────────────────────
GROQ_BASE_URL   = "https://api.groq.com/openai/v1"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

# ── Model routing ──────────────────────────────────────────────────────────────
# "orchestrator" is the default model profile — smart enough for tool use.
# Add more profiles here as needed (e.g. "fast", "vision").
MODELS: dict[str, dict[str, str]] = {
    "orchestrator": {
        "groq":   "llama-3.3-70b-versatile",   # 128k ctx, strong tool use
        "gemini": "gemini-2.0-flash",           # 1M ctx, fast, free
    },
    "fast": {
        "groq":   "llama-3.1-8b-instant",
        "gemini": "gemini-2.0-flash",
    },
    "deep": {
        "groq":   "llama-3.3-70b-versatile",
        "gemini": "gemini-1.5-pro",             # best reasoning on Gemini free
    },
}

DEFAULT_PROFILE = "orchestrator"

# ── Voice (Gemini) ───────────────────────────────────────────────────────────────
# The Gemini key pool doubles as the voice backend. This is the model the voice
# layer targets; the actual audio wiring is a separate step, but it draws from the
# same cycled Gemini keys so voice benefits from the whole free-tier pool.
GEMINI_VOICE_MODEL = os.getenv("GEMINI_VOICE_MODEL", "gemini-2.0-flash")

# ── Server ─────────────────────────────────────────────────────────────────────
HOST         = os.getenv("HOST", "0.0.0.0")
PORT         = int(os.getenv("PORT", 8000))
CORS_ORIGINS = _split("CORS_ORIGINS") or ["*"]

# Max rounds of tool calls per request before giving up
MAX_TOOL_ROUNDS = int(os.getenv("MAX_TOOL_ROUNDS", 10))
