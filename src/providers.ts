// Groq (primary) / Gemini (fallback) key cycling. Single-user hardware, so a
// simple in-memory round-robin with 429 backoff replaces the old Postgres
// key-cycling table — no cross-instance coordination needed anymore.
import { ToolSchema } from "./types.js";

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

// groqVision is a separate model id because Groq's everyday tool-calling
// models (llama-3.3-70b-versatile etc.) don't take image input at all — but
// Groq does host natively multimodal models that also support tool calling,
// so vision isn't Gemini-only; it's just a different model on the same
// provider, tried first same as text.
const MODELS: Record<string, { groq: string; groqVision: string; gemini: string }> = {
  orchestrator: { groq: "llama-3.3-70b-versatile", groqVision: "meta-llama/llama-4-scout-17b-16e-instruct", gemini: "gemini-2.0-flash" },
  fast: { groq: "llama-3.1-8b-instant", groqVision: "meta-llama/llama-4-scout-17b-16e-instruct", gemini: "gemini-2.0-flash" },
};
const DEFAULT_PROFILE = "orchestrator";
const MAX_KEY_ATTEMPTS = 5;

function parseKeys(envVar: string | undefined): string[] {
  return (envVar ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

class KeyCycler {
  private keys: Array<{ key: string; limitedUntil: number }>;
  private idx = 0;

  constructor(keys: string[]) {
    this.keys = keys.map((key) => ({ key, limitedUntil: 0 }));
  }

  next(): string | null {
    if (!this.keys.length) return null;
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const pos = (this.idx + i) % this.keys.length;
      if (this.keys[pos].limitedUntil <= now) {
        this.idx = (pos + 1) % this.keys.length;
        return this.keys[pos].key;
      }
    }
    return null;
  }

  markLimited(key: string, retryAfterSeconds: number) {
    const entry = this.keys.find((k) => k.key === key);
    if (entry) entry.limitedUntil = Date.now() + retryAfterSeconds * 1000;
  }

  status() {
    const now = Date.now();
    return { total: this.keys.length, available: this.keys.filter((k) => k.limitedUntil <= now).length };
  }
}

const cyclers = {
  groq: new KeyCycler(parseKeys(process.env.GROQ_API_KEYS)),
  gemini: new KeyCycler(parseKeys(process.env.GEMINI_API_KEYS)),
};

export function providerStatus() {
  return { groq: cyclers.groq.status(), gemini: cyclers.gemini.status() };
}

// Llama on Groq sometimes emits its tool call as literal text instead of a
// real tool_calls entry; Groq then rejects the generation with 400
// tool_use_failed but hands the raw text back in `failed_generation`. Rather
// than dying, recover the call: pull out the name and a balanced-brace JSON
// argument block, and synthesize a proper tool_calls message.
function parseFailedToolCalls(gen: string) {
  const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  const re = /<function=([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(gen)) !== null) {
    const start = gen.indexOf("{", m.index);
    if (start === -1) continue;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < gen.length; i++) {
      const c = gen[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = i; break; }
    }
    if (end === -1) continue;
    const args = gen.slice(start, end + 1);
    try { JSON.parse(args); } catch { continue; }
    calls.push({ id: `recovered_${calls.length}_${Date.now().toString(36)}`, type: "function", function: { name: m[1], arguments: args } });
  }
  return calls;
}

async function callProvider(provider: "groq" | "gemini", model: string, messages: unknown[], tools?: ToolSchema[]) {
  const url = provider === "groq" ? GROQ_CHAT_URL : GEMINI_CHAT_URL;
  const cycler = cyclers[provider];
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const key = cycler.next();
    if (!key) throw new Error(`no available ${provider} keys`);
    const body: Record<string, unknown> = { model, messages };
    if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("retry-after")) || 60;
      cycler.markLimited(key, retryAfter);
      lastErr = new Error(`${provider} rate-limited`);
      continue;
    }
    if (resp.status === 400 && tools?.length) {
      const text = await resp.text();
      let errBody: Record<string, unknown> | null = null;
      try { errBody = JSON.parse(text); } catch { /* not JSON */ }
      const errObj = (errBody as any)?.error;
      if (errObj?.code === "tool_use_failed" && typeof errObj.failed_generation === "string") {
        const allowed = new Set(tools.map((t) => t.function.name));
        const recovered = parseFailedToolCalls(errObj.failed_generation).filter((c) => allowed.has(c.function.name));
        if (recovered.length) {
          return {
            id: "recovered", object: "chat.completion", model,
            choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: recovered }, finish_reason: "tool_calls" }],
          };
        }
        lastErr = new Error(`${provider} tool_use_failed (unrecoverable)`);
        continue;
      }
      throw new Error(`${provider} error 400: ${text}`);
    }
    if (!resp.ok) throw new Error(`${provider} error ${resp.status}: ${await resp.text()}`);
    return await resp.json();
  }
  throw lastErr ?? new Error(`${provider} exhausted key retries`);
}

// True if any message carries a multimodal image part (an uploaded photo, or
// a screenshot forwarded by the agent loop after a screenshot_desktop /
// browser_screenshot call). This just picks which model id to call with —
// both providers are still tried, same primary/fallback order as plain text.
function hasImageContent(messages: unknown[]): boolean {
  return messages.some(
    (m: any) => Array.isArray(m?.content) && m.content.some((p: any) => p?.type === "image_url"),
  );
}

export async function llm(messages: unknown[], profile: string, tools?: ToolSchema[]) {
  const models = MODELS[profile] ?? MODELS[DEFAULT_PROFILE];
  const groqModel = hasImageContent(messages) ? models.groqVision : models.groq;
  try {
    return await callProvider("groq", groqModel, messages, tools);
  } catch (groqErr) {
    try {
      return await callProvider("gemini", models.gemini, messages, tools);
    } catch (geminiErr) {
      throw new Error(JSON.stringify({ error: "All LLM providers failed.", groq: String(groqErr), gemini: String(geminiErr) }));
    }
  }
}
