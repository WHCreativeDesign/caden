// Live-web tools — search, fetch, calculate, time. Logic ported as-is from
// the retired Supabase chat function; the DuckDuckGo-scrape approach and
// page-text extraction already worked, no reason to rewrite it.
import { schema, ToolDef } from "../types.js";

const FETCH_TIMEOUT_MS = 12_000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 CadenPi/1.0";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function resolveUrl(maybe: string, base: string): string {
  try { return new URL(maybe, base).href; } catch { return maybe; }
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
    results.push({ title: stripTags(m[2]), url, snippet: snippets[results.length] ?? "" });
  }
  if (!results.length) return { query, results: [], note: "No results parsed — try rephrasing." };
  return { query, results };
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
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const ctype = resp.headers.get("content-type") ?? "";
  const raw = await resp.text();
  if (!ctype.includes("html")) return { url, content_type: ctype, text: raw.slice(0, 6000) };
  const title = stripTags(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const images = extractImages(raw, url);
  const body = raw
    .replace(/<(script|style|noscript|svg|iframe|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = stripTags(body).slice(0, 6000);
  return { url, title, text, images };
}

function safeCalculate(expression: string): number {
  if (typeof expression !== "string" || expression.length > 200) throw new Error("expression must be a short string");
  if (!/^[0-9+\-*/().%\s]+$/.test(expression)) throw new Error("only numbers and + - * / ( ) . % allowed");
  const value = Function(`"use strict"; return (${expression});`)();
  if (typeof value !== "number" || !isFinite(value)) throw new Error("not a finite number");
  return value;
}

export const webTools: ToolDef[] = [
  {
    schema: schema("web_search", "Search the live web. Returns titles, URLs and snippets. Use whenever facts may be newer than your training, or to find sources.", {
      query: { type: "string", description: "search query" },
    }, ["query"]),
    handler: async (args) => webSearch(String(args.query ?? "")),
  },
  {
    schema: schema("fetch_page", "Fetch a web page and return its readable text (up to ~6000 chars) plus any real images found on the page (og:image and inline <img> tags).", {
      url: { type: "string", description: "full http(s) URL" },
    }, ["url"]),
    handler: async (args) => fetchPage(String(args.url ?? "")),
  },
  {
    schema: schema("calculate", "Evaluate an arithmetic expression exactly (+ - * / ( ) . %). Use for any non-trivial arithmetic.", {
      expression: { type: "string" },
    }, ["expression"]),
    handler: async (args) => ({ expression: args.expression, value: safeCalculate(String(args.expression)) }),
  },
  {
    schema: schema("get_current_time", "Current date and time. Optional IANA timezone, defaults to UTC.", {
      timezone: { type: "string" },
    }),
    handler: async (args) => {
      const tz = args?.timezone || "UTC";
      const now = new Date();
      return { iso: now.toISOString(), local: now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }), timezone: tz };
    },
  },
];
