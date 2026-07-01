"""
Supabase-backed key store.

Reads (and optionally manages) the unlimited pool of free-tier API keys Caden
cycles through. The `caden_api_keys` table is locked down with RLS and no public
policies, so we talk to it with the service-role key, which bypasses RLS.

    provider='groq'   → chat / LLM keys
    provider='gemini' → voice keys

If Supabase isn't configured (no URL / service-role key), every function degrades
gracefully so the server still runs on .env keys alone.
"""
import logging

import httpx

import config

logger = logging.getLogger("caden.keys")

_TIMEOUT = httpx.Timeout(10.0)


def _rest_url() -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{config.SUPABASE_KEYS_TABLE}"


def _headers(extra: dict | None = None) -> dict:
    h = {
        "apikey": config.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


async def fetch_active(provider: str) -> list[str]:
    """Return all active api_key strings for a provider. Empty list on any failure."""
    if not config.supabase_enabled():
        return []
    params = {
        "select": "api_key",
        "provider": f"eq.{provider}",
        "active": "is.true",
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(_rest_url(), headers=_headers(), params=params)
            resp.raise_for_status()
            return [row["api_key"] for row in resp.json() if row.get("api_key")]
    except Exception as e:
        logger.warning("Supabase key fetch failed for %s: %s", provider, e)
        return []


async def add_key(provider: str, api_key: str, label: str | None = None) -> dict:
    """Insert (or reactivate) a key. Returns the stored row."""
    if not config.supabase_enabled():
        raise RuntimeError("Supabase is not configured (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).")
    if provider not in ("groq", "gemini"):
        raise ValueError("provider must be 'groq' or 'gemini'")
    payload = {"provider": provider, "api_key": api_key, "label": label, "active": True}
    # Upsert on the (provider, api_key) unique constraint so re-adding is idempotent.
    headers = _headers({
        "Prefer": "resolution=merge-duplicates,return=representation",
    })
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(
            _rest_url(),
            headers=headers,
            params={"on_conflict": "provider,api_key"},
            json=payload,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else payload


async def set_active(provider: str, api_key: str, active: bool) -> int:
    """Enable/disable a key. Returns number of rows affected."""
    if not config.supabase_enabled():
        raise RuntimeError("Supabase is not configured.")
    headers = _headers({"Prefer": "return=representation"})
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.patch(
            _rest_url(),
            headers=headers,
            params={"provider": f"eq.{provider}", "api_key": f"eq.{api_key}"},
            json={"active": active},
        )
        resp.raise_for_status()
        return len(resp.json())


async def list_keys(provider: str | None = None) -> list[dict]:
    """List keys with the secret masked — safe to expose over the management API."""
    if not config.supabase_enabled():
        return []
    params = {
        "select": "id,provider,api_key,label,active,last_used_at,rate_limited_until,request_count,created_at",
        "order": "provider,created_at",
    }
    if provider:
        params["provider"] = f"eq.{provider}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(_rest_url(), headers=_headers(), params=params)
            resp.raise_for_status()
            rows = resp.json()
    except Exception as e:
        logger.warning("Supabase key list failed: %s", e)
        return []
    for row in rows:
        row["api_key"] = _mask(row.get("api_key", ""))
    return rows


def _mask(key: str) -> str:
    if len(key) <= 8:
        return "••••"
    return f"{key[:4]}…{key[-4:]}"
