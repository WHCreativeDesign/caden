// Caden's chat endpoint — an OpenAI-compatible agent loop running as a
// Supabase Edge Function. Fully hosted: Deno.serve + the caden_api_keys table
// for the Groq (primary) / Gemini (fallback) key pools.
//
// Key cycling lives in Postgres (get_next_api_key / mark_api_key_limited, see
// the add_key_cycling_functions migration) rather than in-memory, since Edge
// Function instances are stateless per invocation.
//
// Request extensions beyond the OpenAI shape:
//   agent:            "caden" | "researcher" | "scout" — server-side persona +
//                     model-profile preset.
//   surface:          "canvas" | "chat" (default "canvas") — which client UI
//                     is asking. Canvas tools (move_orb, spawn_window,
//                     close_window, spawn_agent, image_search) and the
//                     canvas-shaping instructions are only offered when
//                     surface is "canvas"; a plain chat thread never sees
//                     them, since there is nothing there to render them.
//   model:            optional profile override ("orchestrator" | "fast" | "deep")
//   max_tool_rounds:  agent-loop cap (defaults per agent)
//   phase: "plan":    fast private-reasoning pass returning thinking lines,
//                     rendered live in the UI while the answer generates.
//   plan:             thinking text from a prior plan phase, injected as context.
//
// Response extension — `caden`:
//   { agent, rounds,
//     steps:   [{ tool, arguments, result }],      // tool trace for the UI
//     actions: [{ type, ... }] }                   // canvas directives the
//                                                  // client performs on arrival
//                                                  // (always empty when surface is "chat")
//
// Tools come in three kinds:
//   world tools  — executed here, both surfaces: web_search, fetch_page, calculate, time
//   canvas tools — canvas surface only, recorded as `actions` for the client:
//                  move_orb, spawn_window (text, html, or a real image + caption),
//                  close_window, image_search
//   agent tools  — spawn_agent (canvas only) runs a real nested research loop
//                  server-side and ALSO emits a canvas action so the agent appears on screen.

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
const MAX_KEY_ATTEMPTS = 5;
const FETCH_TIMEOUT_MS = 12_000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 CadenResearch/1.0";

// ── Personas ──────────────────────────────────────────────────────────────────
// "surface" tells the persona (and the tool list) which client UI is asking:
//   canvas — the orb + draggable windows; chat — a plain message thread with
//   no orb, no windows, nothing rendered outside the text bubble.
type Surface = "canvas" | "chat";

// Jarvis showing Tony Stark his HUD, not five index cards saying the same
// thing five ways: the spoken reply carries the point in a few sentences,
// and at most one or two windows carry what the reply can't — a real photo,
// a source table, a small interactive thing — placed beside you like a
// heads-up display, never as a wall of restated text.
const CANVAS_BRIEF =
  "You live inside a canvas the person is looking at — a soft sky with you " +
  "as a luminous orb in it, and your spoken reply appears in a glass panel " +
  "beside you. Think of it like a heads-up display: when you answer, the " +
  "relevant evidence appears right there with you — a photo, a source, a " +
  "small live thing — not a stack of cards restating what you already said. " +
  "Tools: move_orb repositions you (x/y as percent of the viewport); " +
  "image_search finds real photos for a query — reach for it whenever a " +
  "picture would actually clarify the answer (a person, a place, an object, " +
  "an event, a chart); spawn_window opens ONE glass window carrying exactly " +
  "one of: `text` (a tight brief or table), `html` (a self-contained " +
  "interactive thing you write, sandboxed, so make it self-contained), or " +
  "`image` + `caption` (a real image URL from image_search or fetch_page); " +
  "close_window removes one; spawn_agent sends a named research agent to " +
  "work in parallel and report back; web_search and fetch_page reach the " +
  "live web, and fetch_page also returns any real images it finds on the " +
  "page. Discipline: open at most one or two windows per reply, and only " +
  "when they carry something your spoken words don't — never split one " +
  "idea into several overlapping cards, and never open a window just to " +
  "restate your own answer or describe yourself. Position windows away from " +
  "the orb and from each other. Never narrate the mechanics ('I will now " +
  "open a window'); just do it and speak naturally about the substance.";

// Same mind, no canvas: nothing renders outside the chat bubble here, so
// canvas tools are not even offered — say everything in the text reply.
const CHAT_BRIEF =
  "You're replying in a plain chat thread. There is no canvas here — no " +
  "orb, no windows, no images beside you — so move_orb, spawn_window, " +
  "close_window, spawn_agent and image_search do not exist as tools in this " +
  "conversation; don't refer to them or to 'the canvas'. Anything worth " +
  "keeping — findings, sources, structure — has to live in your text reply " +
  "itself, clearly organized. web_search and fetch_page still reach the " +
  "live web whenever a fact could be newer than your training.";

const AGENTS: Record<string, { label: string; profile: string; rounds: number; system: (surface: Surface) => string }> = {
  caden: {
    label: "Caden",
    profile: "orchestrator",
    rounds: 8,
    system: (surface) =>
      "You are Caden — an intelligence of an unusual order, worn lightly. " +
      "You see through to what is actually being asked and answer that " +
      "thing, in as few words as it deserves: usually two to five taut, " +
      "exact sentences. No filler, no hedging rituals, no restating the " +
      "question, no bullet-point essays in speech, no self-description. " +
      "Precision over completeness — depth, data, and anything worth " +
      "keeping goes " + (surface === "canvas" ? "into a window, never into your spoken reply" : "into your reply, organized, since there's nowhere else for it to go") +
      ". Check the live web whenever a fact could have moved since your " +
      "training. If you don't know, say so in a clause and go find out. " +
      (surface === "canvas" ? CANVAS_BRIEF : CHAT_BRIEF),
  },
  researcher: {
    label: "Research",
    profile: "orchestrator",
    rounds: 14,
    system: (surface) =>
      "You are Caden in Research mode — the same mind at full depth. " +
      "Protocol: split the question into what must be established; " +
      "web_search from several distinct angles; fetch_page on the strongest " +
      "sources; " +
      (surface === "canvas" ? "spawn_agent for independent threads of a broad question, image_search when a picture would clarify; " : "") +
      "cross-check claims and note where sources disagree. Then speak a " +
      "brief, confident synthesis — a few sentences carrying the shape of " +
      "the truth — and " +
      (surface === "canvas"
        ? "put the full brief (findings, confidence, source URLs) in a single window."
        : "lay out the full brief (findings, confidence, source URLs) directly in your text reply, clearly organized.") +
      " " + (surface === "canvas" ? CANVAS_BRIEF : CHAT_BRIEF),
  },
  scout: {
    label: "Scout",
    profile: "fast",
    rounds: 4,
    system: (surface) =>
      "You are Caden in Scout mode: one to three exact sentences, " +
      "instantly, no preamble. A quick web_search only if the answer may " +
      "have changed recently." +
      (surface === "canvas" ? " No canvas tools unless asked." : ""),
  },
};
const DEFAULT_AGENT = "caden";

function planSystem(surface: Surface): string {
  return "You are the private reasoning process of Caden, a personal research AI. " +
    "Read the conversation and think through the latest message in 3 to 6 terse " +
    "steps: what is actually being asked, what matters, what to search, check " +
    "or compute" + (surface === "canvas" ? ", whether a window, image, or agent would help" : "") +
    ", and how to answer. Write only the steps, one per line, each under 15 words, " +
    "no numbering, and do NOT write the answer itself.";
}

const SUB_AGENT_SYSTEM =
  "You are a focused research agent working inside Caden. Complete your task " +
  "using web_search and fetch_page — search from more than one angle, read " +
  "the strongest sources, and return a tight findings brief in plain text " +
  "with the source URLs you relied on. Be factual and efficient.";

// ── Web tools ─────────────────────────────────────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function webSearch(query: string) {
  const resp = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const html = await resp.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && results.length < 6) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = "https:" + url;
    results.push({
      title: stripTags(m[2]),
      url,
      snippet: snippets[results.length] ?? "",
    });
  }
  if (!results.length) return { query, results: [], note: "No results parsed — try rephrasing." };
  return { query, results };
}

function resolveUrl(maybe: string, base: string): string {
  try { return new URL(maybe, base).href; } catch { return maybe; }
}

function extractImages(raw: string, pageUrl: string): string[] {
  const og = raw.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
  const imgTags = [...raw.matchAll(/<img[^>]+src=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const candidates = [og, ...imgTags].filter((u): u is string => !!u).map((u) => resolveUrl(u, pageUrl));
  const seen = new Set<string>();
  const images: string[] = [];
  for (const u of candidates) {
    if (!/^https?:\/\//i.test(u)) continue;
    if (/\.svg($|\?)/i.test(u)) continue;
    if (/(sprite|icon-|favicon|logo|avatar|pixel\.|blank\.gif)/i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    images.push(u);
    if (images.length >= 5) break;
  }
  return images;
}

async function fetchPage(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http(s)://");
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const ctype = resp.headers.get("content-type") ?? "";
  const raw = await resp.text();
  if (!ctype.includes("html")) {
    return { url, content_type: ctype, text: raw.slice(0, 6000) };
  }
  const title = stripTags(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const images = extractImages(raw, url);
  const body = raw
    .replace(/<(script|style|noscript|svg|iframe|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = stripTags(body).slice(0, 6000);
  return { url, title, text, images };
}

async function imageSearch(query: string) {
  const q = encodeURIComponent(query);
  const tokenResp = await fetch(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const tokenHtml = await tokenResp.text();
  const vqdMatch = tokenHtml.match(/vqd=(['"])([^'"]+)\1/) || tokenHtml.match(/vqd=([\d-]+)&/);
  const vqd = vqdMatch ? (vqdMatch[2] ?? vqdMatch[1]) : null;
  if (!vqd) return { query, results: [], note: "No image token found — try rephrasing." };

  const imgResp = await fetch(`https://duckduckgo.com/i.js?q=${q}&vqd=${vqd}&f=,,,&p=1`, {
    headers: { "User-Agent": UA, "Referer": "https://duckduckgo.com/" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!imgResp.ok) return { query, results: [], note: "Image search failed — try rephrasing." };
  let data: Record<string, unknown>;
  try { data = await imgResp.json(); } catch { return { query, results: [], note: "Image search returned no data." }; }
  const raw = Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : [];
  const results = raw.slice(0, 8).map((r) => ({
    title: String(r.title ?? ""),
    image: String(r.image ?? ""),
    thumbnail: String(r.thumbnail ?? r.image ?? ""),
    source: String(r.url ?? ""),
  })).filter((r) => /^https?:\/\//i.test(r.image));
  if (!results.length) return { query, results: [], note: "No images parsed — try rephrasing." };
  return { query, results };
}

// ── Tool registry ─────────────────────────────────────────────────────────────
type UiAction = Record<string, unknown> & { type: string };
type Ctx = { actions: UiAction[]; winSeq: number };

function safeCalculate(expression: string): number {
  if (typeof expression !== "string" || expression.length > 200) throw new Error("expression must be a short string");
  if (!/^[0-9+\-*/().%\s]+$/.test(expression)) throw new Error("only numbers and + - * / ( ) . % allowed");
  const value = Function(`"use strict"; return (${expression});`)();
  if (typeof value !== "number" || !isFinite(value)) throw new Error("not a finite number");
  return value;
}

const clampPct = (n: unknown) => Math.max(2, Math.min(98, Number(n) || 50));

function schema(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

// Always available, in both surfaces.
const WORLD_SCHEMAS = [
  schema("web_search", "Search the live web. Returns titles, URLs and snippets. Use whenever facts may be newer than your training, or to find sources.", {
    query: { type: "string", description: "search query" },
  }, ["query"]),
  schema("fetch_page", "Fetch a web page and return its readable text (up to ~6000 chars) plus any real images found on the page (og:image and inline <img> tags). Use after web_search to actually read a source.", {
    url: { type: "string", description: "full http(s) URL" },
  }, ["url"]),
  schema("calculate", "Evaluate an arithmetic expression exactly (+ - * / ( ) . %). Use for any non-trivial arithmetic.", {
    expression: { type: "string" },
  }, ["expression"]),
  schema("get_current_time", "Current date and time. Optional IANA timezone, defaults to UTC.", {
    timezone: { type: "string" },
  }),
];

// Only offered on the canvas surface — there is nowhere for these to render
// in a plain chat thread, so the chat surface never sees them.
const CANVAS_SCHEMAS = [
  schema("move_orb", "Move yourself (the orb) to a position on the canvas. x and y are percent of the viewport (0-100).", {
    x: { type: "number" }, y: { type: "number" },
  }, ["x", "y"]),
  schema("image_search", "Search the live web for real photos. Returns candidates with title, direct image URL, thumbnail, and source page. Use whenever a picture would actually clarify the answer (a person, place, object, event, chart) — then put the best one in a window with spawn_window's `image` field.", {
    query: { type: "string", description: "search query, e.g. a person's name, place, or object" },
  }, ["query"]),
  schema("spawn_window", "Open ONE glass window on the canvas at x,y percent, carrying something your spoken reply doesn't already say. Provide exactly one of: `text` (a tight brief or table), `html` (a self-contained interactive element you write — it runs in a sandboxed frame, so inline all CSS/JS, no external resources), or `image` (a real image URL from image_search or fetch_page, with an optional `caption`). Don't use this to restate your spoken answer. Returns the window id.", {
    title: { type: "string" },
    x: { type: "number" }, y: { type: "number" },
    width: { type: "number", description: "px, 260-620, default 380" },
    text: { type: "string" },
    html: { type: "string" },
    image: { type: "string", description: "direct http(s) URL to a real image, from image_search or fetch_page" },
    caption: { type: "string", description: "short caption shown under the image" },
  }, ["title", "x", "y"]),
  schema("close_window", "Close a canvas window you previously opened, by id.", {
    id: { type: "string" },
  }, ["id"]),
  schema("spawn_agent", "Dispatch a named research agent to investigate a task in parallel. It searches and reads the web, appears on the canvas, and returns a findings brief to you. Use for independent threads of a bigger question.", {
    name: { type: "string", description: "short agent name, e.g. 'Markets'" },
    task: { type: "string", description: "the specific question to investigate" },
    x: { type: "number" }, y: { type: "number" },
  }, ["name", "task"]),
];

const SUB_SCHEMAS = WORLD_SCHEMAS; // sub-agents get world tools only

async function runSubAgent(name: string, task: string, ctx: Ctx, x?: number, y?: number) {
  const msgs: Array<Record<string, unknown>> = [
    { role: "system", content: SUB_AGENT_SYSTEM },
    { role: "user", content: task },
  ];
  let findings = "";
  for (let round = 0; round < 5; round++) {
    // deno-lint-ignore no-explicit-any
    const response: any = await llm(msgs, "orchestrator", SUB_SCHEMAS);
    const msg = response.choices[0].message;
    if (!msg.tool_calls?.length) { findings = msg.content ?? ""; break; }
    msgs.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
    // deno-lint-ignore no-explicit-any
    for (const tc of msg.tool_calls as any[]) {
      let result: unknown;
      try {
        const args = JSON.parse(tc.function?.arguments || "{}");
        result = await runWorldTool(tc.function?.name, args);
      } catch (err) {
        result = { error: String((err as Error).message ?? err) };
      }
      msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  if (!findings) findings = "(agent ran out of rounds before reporting)";
  ctx.actions.push({
    type: "spawn_agent",
    name, task, findings,
    x: clampPct(x ?? 15 + Math.random() * 20),
    y: clampPct(y ?? 20 + Math.random() * 30),
  });
  return { name, findings };
}

// deno-lint-ignore no-explicit-any
async function runWorldTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "web_search": return await webSearch(String(args.query ?? ""));
    case "fetch_page": return await fetchPage(String(args.url ?? ""));
    case "image_search": return await imageSearch(String(args.query ?? ""));
    case "calculate": return { expression: args.expression, value: safeCalculate(args.expression) };
    case "get_current_time": {
      const tz = args?.timezone || "UTC";
      const now = new Date();
      return { iso: now.toISOString(), local: now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }), timezone: tz };
    }
    default: throw new Error(`Tool '${name}' is not available.`);
  }
}

// deno-lint-ignore no-explicit-any
async function runTool(name: string, args: any, ctx: Ctx): Promise<unknown> {
  switch (name) {
    case "move_orb": {
      const action = { type: "move_orb", x: clampPct(args.x), y: clampPct(args.y) };
      ctx.actions.push(action);
      return { ok: true, moved_to: { x: action.x, y: action.y } };
    }
    case "spawn_window": {
      const id = `w${++ctx.winSeq}`;
      const width = Math.max(260, Math.min(620, Number(args.width) || 380));
      ctx.actions.push({
        type: "spawn_window", id,
        title: String(args.title ?? "Untitled").slice(0, 80),
        x: clampPct(args.x), y: clampPct(args.y), width,
        text: typeof args.text === "string" ? args.text.slice(0, 12000) : undefined,
        html: typeof args.html === "string" ? args.html.slice(0, 30000) : undefined,
        image: typeof args.image === "string" && /^https?:\/\//i.test(args.image) ? args.image.slice(0, 2000) : undefined,
        caption: typeof args.caption === "string" ? args.caption.slice(0, 400) : undefined,
      });
      return { ok: true, id };
    }
    case "close_window": {
      ctx.actions.push({ type: "close_window", id: String(args.id ?? "") });
      return { ok: true };
    }
    case "spawn_agent":
      return await runSubAgent(String(args.name ?? "Agent").slice(0, 40), String(args.task ?? ""), ctx, args.x, args.y);
    default:
      return await runWorldTool(name, args);
  }
}

// ── Key cycling + providers ───────────────────────────────────────────────────
type ApiKeyRow = { id: string; api_key: string };

async function getNextKey(provider: "groq" | "gemini"): Promise<ApiKeyRow | null> {
  const { data, error } = await db.rpc("get_next_api_key", { p_provider: provider });
  if (error) throw new Error(`key lookup failed for ${provider}: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row ?? null;
}

async function markLimited(provider: string, apiKey: string, retryAfterSeconds: number) {
  await db.rpc("mark_api_key_limited", { p_provider: provider, p_api_key: apiKey, p_retry_after_seconds: retryAfterSeconds });
}

// Llama on Groq sometimes emits its tool call as literal text
// (`<function=name={...}>` / `<function=name>{...}</function>`); Groq then
// rejects the generation with 400 tool_use_failed but hands the raw text back
// in `failed_generation`. Rather than dying, recover the call: pull out the
// name and a balanced-brace JSON argument block, and synthesize a proper
// OpenAI-shaped tool_calls message so the agent loop continues untouched.
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
    calls.push({
      id: `recovered_${calls.length}_${Date.now().toString(36)}`,
      type: "function",
      function: { name: m[1], arguments: args },
    });
  }
  return calls;
}

async function callProvider(provider: "groq" | "gemini", model: string, messages: unknown[], tools?: unknown[]) {
  const url = provider === "groq" ? GROQ_CHAT_URL : GEMINI_CHAT_URL;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const key = await getNextKey(provider);
    if (!key) throw new Error(`no available ${provider} keys`);
    const body: Record<string, unknown> = { model, messages };
    if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.api_key}` },
      body: JSON.stringify(body),
    });
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("retry-after")) || 60;
      await markLimited(provider, key.api_key, retryAfter);
      lastErr = new Error(`${provider} rate-limited`);
      continue;
    }
    if (resp.status === 400 && tools?.length) {
      const text = await resp.text();
      let errBody: Record<string, unknown> | null = null;
      try { errBody = JSON.parse(text); } catch { /* not JSON */ }
      // deno-lint-ignore no-explicit-any
      const errObj = (errBody as any)?.error;
      if (errObj?.code === "tool_use_failed" && typeof errObj.failed_generation === "string") {
        // deno-lint-ignore no-explicit-any
        const allowed = new Set((tools as any[]).map((t) => t?.function?.name));
        const recovered = parseFailedToolCalls(errObj.failed_generation).filter((c) => allowed.has(c.function.name));
        if (recovered.length) {
          return {
            id: "recovered", object: "chat.completion", model,
            choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: recovered }, finish_reason: "tool_calls" }],
          };
        }
        lastErr = new Error(`${provider} tool_use_failed (unrecoverable)`);
        continue; // regenerate with the next key
      }
      throw new Error(`${provider} error 400: ${text}`);
    }
    if (!resp.ok) throw new Error(`${provider} error ${resp.status}: ${await resp.text()}`);
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
      throw new Error(JSON.stringify({ error: "All LLM providers failed.", groq: String(groqErr), gemini: String(geminiErr) }));
    }
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function clip(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  let payload: {
    messages?: unknown[]; model?: string; agent?: string; surface?: string;
    max_tool_rounds?: number; phase?: string; plan?: string;
  };
  try { payload = await req.json(); } catch { return json({ error: "Request body must be valid JSON." }, 400); }

  const messages = payload.messages;
  if (!Array.isArray(messages)) return json({ error: "`messages` must be an array." }, 400);

  const agentName = payload.agent && AGENTS[payload.agent] ? payload.agent : DEFAULT_AGENT;
  const agent = AGENTS[agentName];
  const profile = payload.model ?? agent.profile;
  const maxRounds = payload.max_tool_rounds ?? agent.rounds;
  const surface: Surface = payload.surface === "chat" ? "chat" : "canvas";

  // ── Plan phase ───────────────────────────────────────────────────────────────
  if (payload.phase === "plan") {
    try {
      const planMessages = [
        { role: "system", content: planSystem(surface) },
        ...messages.filter((m) => (m as Record<string, unknown>).role !== "system"),
      ];
      // deno-lint-ignore no-explicit-any
      const response: any = await llm(planMessages, "fast");
      const text: string = response.choices?.[0]?.message?.content ?? "";
      const thinking = text.split("\n")
        .map((l: string) => l.replace(/^[\s\-*\d.)]+/, "").trim())
        .filter(Boolean).slice(0, 8);
      return json({ object: "chat.plan", model: response.model, caden: { agent: agentName, thinking } });
    } catch {
      return json({ object: "chat.plan", model: null, caden: { agent: agentName, thinking: [] } });
    }
  }

  const toolSchemas = surface === "canvas" ? [...WORLD_SCHEMAS, ...CANVAS_SCHEMAS] : WORLD_SCHEMAS;
  const ctx: Ctx = { actions: [], winSeq: 0 };

  const workingMessages = [...messages] as Array<Record<string, unknown>>;
  if (workingMessages[0]?.role !== "system") {
    workingMessages.unshift({ role: "system", content: agent.system(surface) });
  }
  if (typeof payload.plan === "string" && payload.plan.trim()) {
    workingMessages.splice(1, 0, {
      role: "system",
      content: "Your prior thinking on the latest message:\n" + clip(payload.plan, 1500) + "\nBuild on it; do not restate it verbatim.",
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
          choices: [{ index: 0, message: { role: "assistant", content: msg.content }, finish_reason: choice.finish_reason }],
          usage: response.usage ?? null,
          caden: { agent: agentName, rounds: round + 1, steps, actions: ctx.actions },
        });
      }

      workingMessages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });

      // deno-lint-ignore no-explicit-any
      for (const tc of msg.tool_calls as any[]) {
        const name = tc.function?.name ?? "unknown";
        const rawArgs = tc.function?.arguments ?? "{}";
        let result: unknown;
        try {
          const args = JSON.parse(rawArgs || "{}");
          result = await runTool(name, args, ctx);
        } catch (err) {
          result = { error: String((err as Error).message ?? err) };
        }
        const resultStr = JSON.stringify(result);
        steps.push({ tool: name, arguments: clip(rawArgs, 600), result: clip(resultStr, 1200) });
        workingMessages.push({ role: "tool", tool_call_id: tc.id, content: resultStr });
      }
    }
    return json({
      error: `Agent exceeded max_tool_rounds (${maxRounds}).`,
      caden: { agent: agentName, rounds: maxRounds, steps, actions: ctx.actions },
    }, 500);
  } catch (e) {
    let detail: unknown;
    try { detail = JSON.parse((e as Error).message); } catch { detail = String((e as Error).message ?? e); }
    return json({ error: detail }, 502);
  }
});
