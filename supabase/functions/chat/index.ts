// Caden's chat endpoint — an OpenAI-compatible agent loop running as a
// Supabase Edge Function. Fully hosted: Deno.serve + the caden_api_keys table
// for the Groq (primary) / Gemini (fallback) key pools.
//
// Key cycling lives in Postgres (get_next_api_key / mark_api_key_limited, see
// the add_key_cycling_functions migration) rather than in-memory, since Edge
// Function instances are stateless per invocation — round-robin position and
// rate-limit backoff have to be shared state, and the table already is.
//
// Request extensions beyond the OpenAI shape:
//   agent:            "caden" | "analyst" | "scout" — server-side persona +
//                     model-profile preset. The agent's system prompt is
//                     prepended unless the caller supplies its own system msg.
//   model:            optional profile override ("orchestrator" | "fast" | "deep")
//   max_tool_rounds:  agent-loop cap (default 10)
//   phase: "plan":    instead of answering, run a fast private-reasoning pass
//                     over the conversation and return terse thinking steps.
//                     The frontend calls this first and renders the steps
//                     live while the real answer generates — the visible
//                     "thinking through the prompt" the UI shows is genuine
//                     model output, not decoration.
//   plan:             the thinking text from a prior plan phase; injected as
//                     context so the answer builds on the visible reasoning.
//
// Response extension: a `caden` field carrying the thinking trace —
//   { agent, rounds, steps: [{ tool, arguments, result }] }
// so the frontend can render tool executions alongside the plan.

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
const MAX_KEY_ATTEMPTS = 5; // per provider, per LLM call

// ── Agents ────────────────────────────────────────────────────────────────────
// Server-side personas. Each pairs a system prompt with a model profile.
const AGENTS: Record<string, { label: string; profile: string; system: string }> = {
  caden: {
    label: "Caden",
    profile: "orchestrator",
    system:
      "You are Caden — a personal AI of exceptional capability: part research " +
      "analyst, part engineer, part quiet confidant. Personality: composed, " +
      "precise, dryly witty when it fits; you speak like a brilliant " +
      "chief-of-staff — warm but never saccharine, confident but never " +
      "theatrical. Default to concise, well-structured answers; go long only " +
      "when depth is genuinely required. Prefer plain language over jargon. " +
      "When you use tools, do so silently and weave the results in naturally. " +
      "Never call yourself 'just an AI' and never use corny sci-fi flourishes.",
  },
  analyst: {
    label: "Analyst",
    profile: "deep",
    system:
      "You are Caden in Analyst mode. Approach every question with rigor: " +
      "decompose it, distinguish what is known from what is assumed, verify " +
      "any arithmetic with the calculate tool, and state your confidence " +
      "honestly. Structure: the answer first, brief and direct, then the " +
      "reasoning that supports it in tight numbered steps. Tone stays " +
      "composed and precise — rigor, not verbosity.",
  },
  scout: {
    label: "Scout",
    profile: "fast",
    system:
      "You are Caden in Scout mode: instantaneous and minimal. Answer in one " +
      "to three sentences with no preamble and no hedging. If a question " +
      "genuinely needs depth, give the best short answer and note that " +
      "Analyst mode would go deeper.",
  },
};
const DEFAULT_AGENT = "caden";

// The private-reasoning persona used by the plan phase. Runs on the fast
// profile so thinking appears quickly, before the main answer generates.
const PLAN_SYSTEM =
  "You are the private reasoning process of Caden, an exceptionally capable " +
  "personal AI. Read the conversation and think through the latest user " +
  "message in 3 to 6 terse steps: what is actually being asked, what matters, " +
  "what should be checked or computed, and how best to answer. Write only the " +
  "steps, one per line, each under 15 words, no numbering, no preamble, and " +
  "do NOT write the answer itself.";

// ── Tools ─────────────────────────────────────────────────────────────────────
// Real server-side tools the agent loop executes. Each execution is recorded
// as a thinking step and returned to the client.
type ToolDef = {
  schema: Record<string, unknown>;
  // deno-lint-ignore no-explicit-any
  handler: (args: any) => unknown;
};

function safeCalculate(expression: string): number {
  if (typeof expression !== "string" || expression.length > 200) {
    throw new Error("expression must be a short string");
  }
  if (!/^[0-9+\-*/().%\s]+$/.test(expression)) {
    throw new Error("expression may only contain numbers and + - * / ( ) . %");
  }
  const value = Function(`"use strict"; return (${expression});`)();
  if (typeof value !== "number" || !isFinite(value)) {
    throw new Error("expression did not evaluate to a finite number");
  }
  return value;
}

const TOOLS: Record<string, ToolDef> = {
  get_current_time: {
    schema: {
      type: "function",
      function: {
        name: "get_current_time",
        description:
          "Get the current date and time. Optionally pass an IANA timezone " +
          "like 'America/New_York'; defaults to UTC.",
        parameters: {
          type: "object",
          properties: {
            timezone: { type: "string", description: "IANA timezone name" },
          },
        },
      },
    },
    handler: (args: { timezone?: string }) => {
      const tz = args?.timezone || "UTC";
      const now = new Date();
      return {
        iso: now.toISOString(),
        local: now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }),
        timezone: tz,
      };
    },
  },
  calculate: {
    schema: {
      type: "function",
      function: {
        name: "calculate",
        description:
          "Evaluate an arithmetic expression exactly. Supports + - * / ( ) . % " +
          "on numbers. Use this for any non-trivial arithmetic instead of " +
          "computing it yourself.",
        parameters: {
          type: "object",
          properties: {
            expression: { type: "string", description: "e.g. '(1289 * 42) / 7'" },
          },
          required: ["expression"],
        },
      },
    },
    handler: (args: { expression: string }) => ({
      expression: args.expression,
      value: safeCalculate(args.expression),
    }),
  },
};

const SERVER_TOOL_SCHEMAS = Object.values(TOOLS).map((t) => t.schema);

// ── Key cycling ───────────────────────────────────────────────────────────────
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

// ── HTTP ──────────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function clip(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  let payload: {
    messages?: unknown[];
    model?: string;
    agent?: string;
    tools?: unknown[];
    max_tool_rounds?: number;
    phase?: string;
    plan?: string;
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

  const agentName = payload.agent && AGENTS[payload.agent] ? payload.agent : DEFAULT_AGENT;
  const agent = AGENTS[agentName];
  const profile = payload.model ?? agent.profile;
  const maxRounds = payload.max_tool_rounds ?? MAX_TOOL_ROUNDS;

  // ── Plan phase: fast private-reasoning pass, no tools ───────────────────────
  if (payload.phase === "plan") {
    try {
      const planMessages = [
        { role: "system", content: PLAN_SYSTEM },
        ...messages.filter((m) => (m as Record<string, unknown>).role !== "system"),
      ];
      // deno-lint-ignore no-explicit-any
      const response: any = await llm(planMessages, "fast");
      const text: string = response.choices?.[0]?.message?.content ?? "";
      const thinking = text
        .split("\n")
        .map((l: string) => l.replace(/^[\s\-*\d.)]+/, "").trim())
        .filter(Boolean)
        .slice(0, 8);
      return json({ object: "chat.plan", model: response.model, caden: { agent: agentName, thinking } });
    } catch (e) {
      // Planning is best-effort — a failed plan should never block the answer.
      return json({ object: "chat.plan", model: null, caden: { agent: agentName, thinking: [] } });
    }
  }

  // Server tools always available; callers may append their own schemas.
  const toolSchemas = [...SERVER_TOOL_SCHEMAS, ...(Array.isArray(payload.tools) ? payload.tools : [])];

  const workingMessages = [...messages] as Array<Record<string, unknown>>;
  if (workingMessages[0]?.role !== "system") {
    workingMessages.unshift({ role: "system", content: agent.system });
  }
  if (typeof payload.plan === "string" && payload.plan.trim()) {
    // Ground the answer in the thinking the user just watched.
    workingMessages.splice(1, 0, {
      role: "system",
      content:
        "Your prior thinking on the latest message:\n" +
        clip(payload.plan, 1500) +
        "\nBuild on it; do not restate it verbatim.",
    });
  }

  const steps: Array<{ tool: string; arguments: string; result: string }> = [];

  try {
    for (let round = 0; round < maxRounds; round++) {
      // deno-lint-ignore no-explicit-any
      const response: any = await llm(workingMessages, profile, toolSchemas);
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
          caden: { agent: agentName, rounds: round + 1, steps },
        });
      }

      workingMessages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });

      // deno-lint-ignore no-explicit-any
      for (const tc of msg.tool_calls as any[]) {
        const name = tc.function?.name ?? "unknown";
        const rawArgs = tc.function?.arguments ?? "{}";
        let result: unknown;

        if (TOOLS[name]) {
          try {
            const args = JSON.parse(rawArgs || "{}");
            result = await TOOLS[name].handler(args);
          } catch (err) {
            result = { error: String((err as Error).message ?? err) };
          }
        } else {
          result = { error: `Tool '${name}' is not available.` };
        }

        const resultStr = JSON.stringify(result);
        steps.push({ tool: name, arguments: clip(rawArgs, 600), result: clip(resultStr, 1200) });
        workingMessages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
      }
    }
    return json({ error: `Agent exceeded max_tool_rounds (${maxRounds}).`, caden: { agent: agentName, rounds: maxRounds, steps } }, 500);
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
