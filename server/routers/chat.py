import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import providers.groq_client as groq
import providers.gemini_client as gemini
import config
from tools.registry import all_tools, call as call_tool

logger = logging.getLogger("caden.chat")
router = APIRouter()


class Message(BaseModel):
    role: str
    content: str | list | None = None
    tool_calls: list | None = None
    tool_call_id: str | None = None
    name: str | None = None


class ChatRequest(BaseModel):
    messages: list[Message]
    model: str = config.DEFAULT_PROFILE   # profile name, not raw model id
    stream: bool = False
    tools: list | None = None             # override tool list (None = use all)
    max_tool_rounds: int = config.MAX_TOOL_ROUNDS


async def _llm(messages, profile, tools, stream=False):
    """Try Groq first; fall back to Gemini on any failure."""
    try:
        return await groq.chat(messages, profile, tools, stream)
    except Exception as groq_err:
        logger.warning("Groq failed (%s), trying Gemini…", groq_err)
        try:
            return await gemini.chat(messages, profile, tools, stream)
        except Exception as gemini_err:
            raise HTTPException(
                status_code=502,
                detail={
                    "error": "All LLM providers failed.",
                    "groq": str(groq_err),
                    "gemini": str(gemini_err),
                },
            )


@router.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest):
    messages = [m.model_dump(exclude_none=True) for m in req.messages]
    tools = req.tools if req.tools is not None else all_tools()

    # ── Agent loop ─────────────────────────────────────────────────────────────
    for round_num in range(req.max_tool_rounds):
        response = await _llm(messages, req.model, tools or None)
        choice = response.choices[0]
        msg = choice.message

        # No tool calls → final answer
        if not msg.tool_calls:
            return {
                "id": response.id,
                "object": "chat.completion",
                "model": response.model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": msg.content,
                        },
                        "finish_reason": choice.finish_reason,
                    }
                ],
                "usage": getattr(response, "usage", None) and vars(response.usage),
            }

        # ── Execute all tool calls in this round ───────────────────────────────
        tool_call_dicts = []
        for tc in msg.tool_calls:
            tool_call_dicts.append({
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            })

        messages.append({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": tool_call_dicts,
        })

        for tc in msg.tool_calls:
            try:
                args = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                args = {}

            logger.info("Tool call: %s(%s)", tc.function.name, args)
            result = await call_tool(tc.function.name, args)
            logger.info("Tool result: %s", result)

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result),
            })

    raise HTTPException(
        status_code=500,
        detail=f"Agent exceeded max_tool_rounds ({req.max_tool_rounds}).",
    )
