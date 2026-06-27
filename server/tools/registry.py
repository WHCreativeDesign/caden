"""
Tool registry — use the @tool decorator to register any callable as a
Caden tool. The model receives all registered tools automatically.

Example:
    @tool(
        name="get_weather",
        description="Get current weather for a location.",
        parameters={
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City name"},
            },
            "required": ["location"],
        },
    )
    async def get_weather(location: str) -> dict:
        ...
"""

import asyncio
import inspect
from typing import Any, Callable

_tools: dict[str, dict] = {}       # name → OpenAI tool schema
_handlers: dict[str, Callable] = {} # name → callable


def tool(name: str, description: str, parameters: dict):
    def decorator(fn: Callable):
        _tools[name] = {
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": parameters,
            },
        }
        _handlers[name] = fn
        return fn
    return decorator


def all_tools() -> list[dict]:
    """Return all registered tools in OpenAI schema format."""
    return list(_tools.values())


async def call(name: str, arguments: dict) -> Any:
    """Execute a tool by name and return its result."""
    handler = _handlers.get(name)
    if handler is None:
        return {"error": f"No tool named '{name}' is registered."}
    try:
        if inspect.iscoroutinefunction(handler):
            return await handler(**arguments)
        return await asyncio.to_thread(handler, **arguments)
    except TypeError as e:
        return {"error": f"Tool '{name}' called with wrong arguments: {e}"}
    except Exception as e:
        return {"error": f"Tool '{name}' raised an exception: {e}"}
