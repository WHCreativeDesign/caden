// Quick diagnostic endpoint: how many Groq/Gemini keys are active and how many
// are currently available (not rate-limited) in the caden_api_keys table.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const { data, error } = await db
    .from("caden_api_keys")
    .select("provider, active, rate_limited_until");

  if (error) return json({ status: "error", error: error.message }, 500);

  const now = Date.now();
  const summarize = (provider: string) => {
    const rows = (data ?? []).filter((r) => r.provider === provider && r.active);
    return {
      total_keys: rows.length,
      available: rows.filter(
        (r) => !r.rate_limited_until || new Date(r.rate_limited_until).getTime() <= now,
      ).length,
    };
  };

  return json({
    status: "ok",
    providers: { groq: summarize("groq"), gemini: summarize("gemini") },
  });
});
