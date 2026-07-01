"""Management API for the Supabase-backed key pools.

Lets you add/list/toggle the unlimited Groq (chat) and Gemini (voice) free-tier
keys without touching the database directly. All routes are no-ops-with-a-clear-
error when Supabase isn't configured.
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import config
from providers import key_store

logger = logging.getLogger("caden.keys")
router = APIRouter(prefix="/keys", tags=["keys"])


class AddKeyRequest(BaseModel):
    provider: str          # "groq" or "gemini"
    api_key: str
    label: str | None = None


class ToggleKeyRequest(BaseModel):
    provider: str
    api_key: str
    active: bool


@router.get("")
async def list_keys(provider: str | None = None):
    """List stored keys (secrets masked)."""
    return {
        "supabase_enabled": config.supabase_enabled(),
        "keys": await key_store.list_keys(provider),
    }


@router.post("")
async def add_key(req: AddKeyRequest):
    """Add a key to the pool. Takes effect on the next refresh (or call /keys/reload)."""
    try:
        row = await key_store.add_key(req.provider, req.api_key, req.label)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _reload()
    if isinstance(row, dict):
        row["api_key"] = key_store._mask(row.get("api_key", req.api_key))
    return {"added": True, "key": row}


@router.patch("")
async def toggle_key(req: ToggleKeyRequest):
    """Enable or disable a key."""
    try:
        affected = await key_store.set_active(req.provider, req.api_key, req.active)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _reload()
    return {"updated": affected, "active": req.active}


@router.post("/reload")
async def reload_keys():
    """Force an immediate re-sync of both key pools from Supabase."""
    counts = await _reload()
    return {"reloaded": True, **counts}


async def _reload() -> dict:
    # Imported lazily to avoid a circular import at module load time.
    from keys_sync import refresh_pools
    return await refresh_pools()
