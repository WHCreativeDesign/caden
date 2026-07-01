import time
import threading


class KeyCycler:
    """
    Round-robin key pool with automatic rate-limit backoff.
    Thread-safe — safe to call from concurrent async workers.

    The pool can start empty and be filled/refreshed at runtime via `sync()`,
    which is how keys loaded from Supabase get merged in without a restart.
    """

    def __init__(self, keys: list[str], provider: str):
        self.provider = provider
        self._lock = threading.Lock()
        self._keys: list[str] = []
        self._index = 0
        # key → timestamp when it becomes available again
        self._rate_limited: dict[str, float] = {}
        self.sync(keys or [])

    def sync(self, keys: list[str]):
        """Replace the pool with `keys`, preserving rate-limit state for survivors."""
        with self._lock:
            deduped: list[str] = []
            seen: set[str] = set()
            for k in keys:
                k = k.strip()
                if k and k not in seen:
                    seen.add(k)
                    deduped.append(k)
            self._keys = deduped
            # Drop backoff timers for keys no longer in the pool.
            self._rate_limited = {
                k: t for k, t in self._rate_limited.items() if k in seen
            }
            if self._keys:
                self._index %= len(self._keys)

    def count(self) -> int:
        with self._lock:
            return len(self._keys)

    def get(self) -> str:
        with self._lock:
            if not self._keys:
                raise RuntimeError(
                    f"No API keys available for {self.provider}. "
                    f"Add them to the Supabase '{self.provider}' pool or to "
                    f"{self.provider.upper()}_API_KEYS in .env."
                )
            now = time.time()
            for _ in range(len(self._keys)):
                key = self._keys[self._index % len(self._keys)]
                self._index += 1
                if self._rate_limited.get(key, 0) <= now:
                    return key
            # All keys currently rate-limited; return whichever recovers soonest
            return min(self._keys, key=lambda k: self._rate_limited.get(k, 0))

    def mark_limited(self, key: str, retry_after: float = 60.0):
        with self._lock:
            self._rate_limited[key] = time.time() + retry_after

    def status(self) -> dict:
        now = time.time()
        with self._lock:
            return {
                "provider": self.provider,
                "total_keys": len(self._keys),
                "available": sum(
                    1 for k in self._keys if self._rate_limited.get(k, 0) <= now
                ),
            }
