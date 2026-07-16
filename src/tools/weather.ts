// Weather — classic Jarvis smalltalk, and useful on its own. Defaults to
// wttr.in's j1 JSON endpoint (no API key, matching how web.ts's DDG scrape
// and this app's other tools avoid key-gated dependencies where possible);
// if an OpenWeatherMap key is configured (Options tab, or OPENWEATHER_API_KEY
// in .env as the first-boot default — same pattern as telegram.ts's config),
// that's tried first for more authoritative data, falling back to wttr.in if
// it ever fails rather than losing weather entirely over one bad/rate-limited
// key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { schema, ToolDef } from "../types.js";

const CONFIG_DIR = join(homedir(), ".caden");
const CONFIG_FILE = join(CONFIG_DIR, "weather.json");

interface WeatherConfig { openWeatherApiKey: string }

function loadConfig(): WeatherConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
      return { openWeatherApiKey: typeof raw.openWeatherApiKey === "string" ? raw.openWeatherApiKey : "" };
    }
  } catch {
    // corrupt/unreadable config file — fall through to the .env default
  }
  return { openWeatherApiKey: process.env.OPENWEATHER_API_KEY || "" };
}

function persistConfig(cfg: WeatherConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// Backs the Options tab's Weather section (GET/POST /api/weather/config in
// server.ts) — same masked-preview-only convention as telegram.ts's token
// handling, since this is also a secret that shouldn't round-trip back to
// the browser once saved.
export function setOpenWeatherApiKey(key: string): void {
  config = { openWeatherApiKey: key.trim() };
  persistConfig(config);
}

export function weatherConfigStatus() {
  return {
    has_key: !!config.openWeatherApiKey,
    key_preview: config.openWeatherApiKey ? `••••${config.openWeatherApiKey.slice(-4)}` : null,
    active_source: config.openWeatherApiKey ? "openweathermap" : "wttr.in",
  };
}

function parseLatLon(loc: string): { lat: number; lon: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(loc);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}

async function getWeatherFromOpenWeather(loc: string, apiKey: string) {
  const coords = parseLatLon(loc);
  const params = new URLSearchParams({ appid: apiKey, units: "metric" });
  if (coords) { params.set("lat", String(coords.lat)); params.set("lon", String(coords.lon)); }
  else params.set("q", loc);
  const resp = await fetch(`https://api.openweathermap.org/data/2.5/weather?${params.toString()}`);
  if (!resp.ok) throw new Error(`OpenWeatherMap lookup failed: HTTP ${resp.status}`);
  const data: any = await resp.json();
  const main = data.main ?? {};
  return {
    location: [data.name, data.sys?.country].filter(Boolean).join(", ") || loc,
    condition: data.weather?.[0]?.description ?? null,
    temp_c: typeof main.temp === "number" ? main.temp : null,
    feels_like_c: typeof main.feels_like === "number" ? main.feels_like : null,
    humidity_pct: typeof main.humidity === "number" ? main.humidity : null,
    wind_kmph: typeof data.wind?.speed === "number" ? Math.round(data.wind.speed * 3.6 * 10) / 10 : null,
    today_max_c: typeof main.temp_max === "number" ? main.temp_max : null,
    today_min_c: typeof main.temp_min === "number" ? main.temp_min : null,
    // Deliberately just the plain site, never the actual request URL — that
    // URL carries the API key in its query string, and this "source" field
    // gets surfaced straight back through the model's reply (ACCURACY_BRIEF
    // has it cite sources as plain text), so leaking it there would leak
    // the key into chat history/logs.
    source: "https://openweathermap.org",
  };
}

async function getWeatherFromWttr(loc: string) {
  const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1`;
  // wttr.in gates its terminal-friendly output behind a browser-like UA on
  // some paths; a plain curl-style UA reliably gets the JSON form.
  const resp = await fetch(url, { headers: { "User-Agent": "curl/8.0" } });
  if (!resp.ok) throw new Error(`weather lookup failed: HTTP ${resp.status}`);
  const data: any = await resp.json();
  const cur = data.current_condition?.[0];
  if (!cur) throw new Error("weather service returned no current conditions");
  const area = data.nearest_area?.[0];
  const areaName = area?.areaName?.[0]?.value;
  const region = area?.region?.[0]?.value || area?.country?.[0]?.value;
  const today = data.weather?.[0];
  return {
    location: [areaName, region].filter(Boolean).join(", ") || loc,
    condition: cur.weatherDesc?.[0]?.value ?? null,
    temp_c: Number(cur.temp_C),
    feels_like_c: Number(cur.FeelsLikeC),
    humidity_pct: Number(cur.humidity),
    wind_kmph: Number(cur.windspeedKmph),
    today_max_c: today ? Number(today.maxtempC) : null,
    today_min_c: today ? Number(today.mintempC) : null,
    source: `https://wttr.in/${encodeURIComponent(loc)}`,
  };
}

async function getWeather(location: string) {
  const loc = location.trim();
  if (!loc) throw new Error("location is required");
  if (config.openWeatherApiKey) {
    try {
      return await getWeatherFromOpenWeather(loc, config.openWeatherApiKey);
    } catch (err) {
      console.error("[weather] OpenWeatherMap lookup failed, falling back to wttr.in:", err);
    }
  }
  return getWeatherFromWttr(loc);
}

export const weatherTools: ToolDef[] = [
  {
    schema: schema(
      "get_weather",
      "Get current weather conditions and today's forecast range for a location (city name, postcode, or 'lat,lon'). This is itself a live data source — no need to double-check it against a web search.",
      { location: { type: "string", description: "city, place name, postcode, or 'lat,lon'" } },
      ["location"],
    ),
    handler: async (args) => getWeather(String(args.location ?? "")),
  },
];
