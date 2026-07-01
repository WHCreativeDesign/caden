// Caden's core chat endpoint — an OpenAI-compatible /v1/chat/completions
// Supabase Edge Function. Runs entirely on Supabase's infrastructure (no Pi,
// no separately-hosted server): Deno.serve + the caden_api_keys table for the
// Groq (primary) / Gemini (fallback) key pools.
//
// Key cycling lives in Postgres (get_next_api_key / mark_api_key_limited, see
// the add_key_cycling_functions migration) rather than in-memory, since Edge
// Function instances are stateless per invocation — the round-robin position
// and rate-limit backoff have to be shared state, and the table already is.
//
// Tool-calling framework is wired up (the agent loop below will execute any
// tool calls the model makes), but no tools are registered yet — Caden's home
// control / communication tools are still stubs and haven't been ported here.
// Callers can pass their own `tools` array in the request if they want the
// model to see tool definitions; unregistered tool calls just get a polite
// "not implemented" result back so the agent loop can continue.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const MODELS: Record<string, { groq: string; gemini: string }> = {
  orchestrator: { groq: "llama-3.3-70b-versatile", gemini: "gemini-2.0-flash" },
  fast: { groq: "llama-3.1-8b-instant", gemini: "gemini-2.0-flash" },
  deep: { groq: "llama-3.3-70b-versatile", gemini: "gemini-1.5-pro" },
};
const DEFAULT_PROFILE = "orchestrator";
const MAX_TOOL_ROUNDS = 10;
const MAX_KEY_ATTEMPTS = 5; // per provider, per LLM call — caps retries if keys keep failing

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type ApiKeyRow = { id: string; api_key: string };

async function getNextKey(provider: "groq" | "gemini"): Promise<ApiKeyRow | null> {
  const { data, error } = await db.rpc("get_next_api_key", { p_provider: provider });
  if (error) throw new Error(`key lookup failed for ${provider}: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}

async function markLimited(provider: string, apiKey: string, retryAfterSeconds: number) {
  await db.rpc("mark_api_key_limited", {
    p_provider: provider,
    p_api_key: apiKey,
    p_retry_after_seconds: retryAfterSeconds,
  });
}

async function callProvider(
  provider: "groq" | "gemini",
  model: string,
  messages: unknown[],
  tools?: unknown[],
) {
  const url = provider === "groq" ? GROQ_CHAT_URL : GEMINI_CHAT_URL;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const key = await getNextKey(provider);
    if (!key) throw new Error(`no available ${provider} keys`);

    const body: Record<string, unknown> = { model, messages };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key.api_key}`,
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("retry-after")) || 60;
      await markLimited(provider, key.api_key, retryAfter);
      lastErr = new Error(`${provider} rate-limited`);
      continue;
    }
    if (!resp.ok) {
      throw new Error(`${provider} error ${resp.status}: ${await resp.text()}`);
    }
    return await resp.json();
  }
  throw lastErr ?? new Error(`${provider} exhausted key retries`);
}

async function llm(messages: unknown[], profile: string, tools?: unknown[]) {
  const models = MODELS[profile] ?? MODELS[DEFAULT_PROFILE];
  try {
    return await callProvider("groq", models.groq, messages, tools);
  } catch (groqErr) {
    try {
      return await callProvider("gemini", models.gemini, messages, tools);
    } catch (geminiErr) {
      throw new Error(
        JSON.stringify({
          error: "All LLM providers failed.",
          groq: String(groqErr),
          gemini: String(geminiErr),
        }),
      );
    }
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  let payload: {
    messages?: unknown[];
    model?: string;
    tools?: unknown[];
    max_tool_rounds?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return json({ error: "`messages` must be an array." }, 400);
  }

  const profile = payload.model ?? DEFAULT_PROFILE;
  const maxRounds = payload.max_tool_rounds ?? MAX_TOOL_ROUNDS;
  const tools = payload.tools ?? [];
  const workingMessages = [...messages];

  try {
    for (let round = 0; round < maxRounds; round++) {
      // deno-lint-ignore no-explicit-any
      const response: any = await llm(workingMessages, profile, tools.length ? tools : undefined);
      const choice = response.choices[0];
      const msg = choice.message;

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return json({
          id: response.id,
          object: "chat.completion",
          model: response.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: msg.content },
              finish_reason: choice.finish_reason,
            },
          ],
          usage: response.usage ?? null,
        });
      }

      workingMessages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
      // deno-lint-ignore no-explicit-any
      for (const tc of msg.tool_calls as any[]) {
        // No tools are registered yet — home/communication tools are still
        // Python-side stubs and haven't been ported. Return a graceful
        // "not implemented" result so the agent loop can still finish.
        const result = { error: `Tool '${tc.function.name}' is not implemented yet.` };
        workingMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    }
    return json({ error: `Agent exceeded max_tool_rounds (${maxRounds}).` }, 500);
  } catch (e) {
    let detail: unknown;
    try {
      detail = JSON.parse((e as Error).message);
    } catch {
      detail = String((e as Error).message ?? e);
    }
    return json({ error: detail }, 502);
  }
});
