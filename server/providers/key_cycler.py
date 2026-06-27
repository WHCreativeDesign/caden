import time
import threading


class KeyCycler:
    """
    Round-robin key pool with automatic rate-limit backoff.
    Thread-safe — safe to call from concurrent async workers.
    """

    def __init__(self, keys: list[str], provider: str):
        if not keys:
            raise ValueError(
                f"No API keys configured for {provider}. "
                f"Add them to .env as {provider.upper()}_API_KEYS=key1,key2,..."
            )
        self.provider = provider
        self._keys = list(keys)
        self._lock = threading.Lock()
        self._index = 0
        # key → timestamp when it becomes available again
        self._rate_limited: dict[str, float] = {}

    def get(self) -> str:
        with self._lock:
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
