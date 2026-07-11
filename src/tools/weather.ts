// Weather — classic Jarvis smalltalk, and useful on its own. wttr.in's
// j1 JSON endpoint needs no API key, matching how web.ts's DDG scrape and
// this app's other tools avoid key-gated dependencies where possible.
import { schema, ToolDef } from "../types.js";

async function getWeather(location: string) {
  const loc = location.trim();
  if (!loc) throw new Error("location is required");
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
