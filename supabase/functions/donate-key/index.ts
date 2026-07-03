// Lets anyone with a spare Groq API key add it to the shared pool the chat
// function cycles through (see caden_api_keys / add_key_cycling_functions).
// The key is verified against Groq's own API before it's stored, so a typo
// or dead key never lands silently in the pool.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const FETCH_TIMEOUT_MS = 10_000;

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

async function verifyGroqKey(apiKey: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const resp = await fetch(GROQ_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 401 || resp.status === 403) return { ok: false, reason: "Groq rejected that key — check it's copied correctly." };
    return { ok: false, reason: `Groq couldn't verify the key right now (${resp.status}) — try again shortly.` };
  } catch {
    return { ok: false, reason: "Couldn't reach Groq to verify the key — try again shortly." };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);

  let payload: { api_key?: string };
  try { payload = await req.json(); } catch { return json({ ok: false, error: "Request body must be valid JSON." }, 400); }

  const apiKey = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
  if (!apiKey) return json({ ok: false, error: "Paste a Groq API key first." }, 400);
  if (apiKey.length < 20 || apiKey.length > 200 || /\s/.test(apiKey)) {
    return json({ ok: false, error: "That doesn't look like a valid API key." }, 400);
  }

  const { data: existing, error: lookupError } = await db
    .from("caden_api_keys")
    .select("id")
    .eq("provider", "groq")
    .eq("api_key", apiKey)
    .limit(1);
  if (lookupError) return json({ ok: false, error: "Couldn't check the key pool — try again shortly." }, 500);
  if (existing && existing.length) {
    return json({ ok: true, duplicate: true, message: "Already in the pool — thank you, though!" });
  }

  const verified = await verifyGroqKey(apiKey);
  if (!verified.ok) return json({ ok: false, error: verified.reason }, 422);

  const { error: insertError } = await db
    .from("caden_api_keys")
    .insert({ provider: "groq", api_key: apiKey, label: "donated", active: true });
  if (insertError) return json({ ok: false, error: "Verified, but couldn't save it — try again shortly." }, 500);

  return json({ ok: true, message: "Added to the pool — thank you!" });
});
