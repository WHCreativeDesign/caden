import os
from dotenv import load_dotenv

load_dotenv()

def _split(env_var: str) -> list[str]:
    return [k.strip() for k in os.getenv(env_var, "").split(",") if k.strip()]

# ── Key pools ──────────────────────────────────────────────────────────────────
# Add as many keys as you want, comma-separated in .env
GROQ_KEYS   = _split("GROQ_API_KEYS")
GEMINI_KEYS = _split("GEMINI_API_KEYS")

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

# ── Server ─────────────────────────────────────────────────────────────────────
HOST         = os.getenv("HOST", "0.0.0.0")
PORT         = int(os.getenv("PORT", 8000))
CORS_ORIGINS = _split("CORS_ORIGINS") or ["*"]

# Max rounds of tool calls per request before giving up
MAX_TOOL_ROUNDS = int(os.getenv("MAX_TOOL_ROUNDS", 10))
