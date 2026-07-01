import asyncio
import logging
import tools  # registers all @tool decorators

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config
import keys_sync
from routers.chat import router as chat_router
from routers.keys import router as keys_router
import providers.groq_client as groq_provider
import providers.gemini_client as gemini_provider

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger("caden")

app = FastAPI(
    title="Caden API",
    description="Local AI gateway — Groq + Gemini with key cycling and tool use.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat_router)
app.include_router(keys_router)


@app.on_event("startup")
async def _load_keys():
    """Pull the Groq/Gemini key pools from Supabase, then keep them refreshed."""
    try:
        await keys_sync.refresh_pools()
    except Exception as e:
        logger.warning("Initial key sync failed, using env keys only: %s", e)
    asyncio.create_task(keys_sync.start_refresh_loop())


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "key_source": "supabase+env" if config.supabase_enabled() else "env",
        "providers": {
            "groq":   groq_provider._cycler.status(),
            "gemini": gemini_provider._cycler.status(),
        },
    }


@app.get("/tools")
async def list_tools():
    from tools.registry import all_tools
    return {"tools": all_tools()}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
    )
