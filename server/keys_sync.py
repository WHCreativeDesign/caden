"""
Keeps the in-memory Groq/Gemini key cyclers in sync with Supabase.

The live pool for each provider is the union of:
  1. any seed keys in .env (GROQ_API_KEYS / GEMINI_API_KEYS), and
  2. all active keys in the Supabase `caden_api_keys` table.

`refresh_pools()` re-reads Supabase and pushes the merged pools into the cyclers.
`start_refresh_loop()` schedules that on an interval so keys added at runtime get
picked up without a restart.
"""
import asyncio
import logging

import config
from providers import key_store
import providers.groq_client as groq
import providers.gemini_client as gemini

logger = logging.getLogger("caden.keys")


async def refresh_pools() -> dict:
    """Fetch keys from Supabase, merge with env seeds, sync into the cyclers."""
    supa_groq, supa_gemini = await asyncio.gather(
        key_store.fetch_active("groq"),
        key_store.fetch_active("gemini"),
    )

    groq_pool = _merge(config.GROQ_KEYS, supa_groq)
    gemini_pool = _merge(config.GEMINI_KEYS, supa_gemini)

    groq._cycler.sync(groq_pool)
    gemini._cycler.sync(gemini_pool)

    counts = {
        "groq": groq._cycler.count(),
        "gemini": gemini._cycler.count(),
        "source": "supabase+env" if config.supabase_enabled() else "env",
    }
    logger.info(
        "Key pools synced — groq=%d (supabase %d), gemini=%d (supabase %d)",
        counts["groq"], len(supa_groq), counts["gemini"], len(supa_gemini),
    )
    return counts


def _merge(env_keys: list[str], supa_keys: list[str]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for k in [*env_keys, *supa_keys]:
        if k and k not in seen:
            seen.add(k)
            merged.append(k)
    return merged


async def start_refresh_loop():
    """Background task: periodically re-sync from Supabase."""
    interval = config.KEY_REFRESH_INTERVAL
    if interval <= 0 or not config.supabase_enabled():
        return
    while True:
        await asyncio.sleep(interval)
        try:
            await refresh_pools()
        except Exception as e:
            logger.warning("Periodic key refresh failed: %s", e)
