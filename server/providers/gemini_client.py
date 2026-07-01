import asyncio
from openai import AsyncOpenAI, RateLimitError

import config
from providers.key_cycler import KeyCycler

_cycler = KeyCycler(config.GEMINI_KEYS, "gemini")


def _client(key: str) -> AsyncOpenAI:
    # Gemini exposes an OpenAI-compatible endpoint — same SDK, different base URL
    return AsyncOpenAI(api_key=key, base_url=config.GEMINI_BASE_URL)


async def chat(
    messages: list[dict],
    profile: str = config.DEFAULT_PROFILE,
    tools: list[dict] | None = None,
    stream: bool = False,
    retries: int = 3,
):
    model = config.MODELS[profile]["gemini"]

    attempts = retries * max(_cycler.count(), 1)
    for attempt in range(attempts):
        key = _cycler.get()
        client = _client(key)
        try:
            kwargs: dict = dict(model=model, messages=messages, stream=stream)
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"
            return await client.chat.completions.create(**kwargs)

        except RateLimitError as e:
            retry_after = float(
                getattr(e, "response", None) and
                e.response.headers.get("retry-after", 60) or 60
            )
            _cycler.mark_limited(key, retry_after)
            if attempt == attempts - 1:
                raise
            await asyncio.sleep(0.1)

        except Exception:
            raise
