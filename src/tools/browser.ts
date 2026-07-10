// Browser control. One long-lived Chromium instance the daemon owns.
//
// Mode selection (BROWSER_MODE env — "auto" | "local" | "stream"):
//   local  — headed Chromium on the Pi's attached display (DISPLAY must be
//            set, e.g. a desktop session on Raspberry Pi OS with Desktop).
//            You watch it directly on a monitor plugged into the Pi.
//   stream — headless Chromium (no X server / display needed at all —
//            Playwright's headless mode doesn't require Xvfb), with
//            periodic screenshots pushed to the web UI over WebSocket so
//            it's watchable from any device on the LAN.
//   auto   — local if process.env.DISPLAY is set, stream otherwise.
import { chromium, Browser, Page } from "playwright";
import { EventEmitter } from "node:events";
import { schema, ToolDef } from "../types.js";

export const browserEvents = new EventEmitter();

type Mode = "local" | "stream";

let browser: Browser | null = null;
let page: Page | null = null;
let mode: Mode | null = null;
let streamTimer: NodeJS.Timeout | null = null;
let streamViewers = 0;

function resolveMode(): Mode {
  const configured = (process.env.BROWSER_MODE || "auto").toLowerCase();
  if (configured === "local" || configured === "stream") return configured;
  return process.env.DISPLAY ? "local" : "stream";
}

async function ensureBrowser(): Promise<Page> {
  if (page) return page;
  mode = resolveMode();
  browser = await chromium.launch({ headless: mode === "stream" });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  browserEvents.emit("status", { mode, open: true });
  return page;
}

export function browserStatus() {
  return { mode, open: !!page, streaming: streamViewers > 0 };
}

// server.ts calls these as WS clients connect/disconnect from /ws/browser,
// so frames are only captured (and the CPU spent) while someone's watching.
export function addStreamViewer() {
  streamViewers++;
  if (streamViewers === 1 && mode === "stream") startStreaming();
}
export function removeStreamViewer() {
  streamViewers = Math.max(0, streamViewers - 1);
  if (streamViewers === 0) stopStreaming();
}

function startStreaming() {
  if (streamTimer) return;
  streamTimer = setInterval(async () => {
    if (!page || streamViewers === 0) return;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 55 });
      browserEvents.emit("frame", buf);
    } catch { /* page mid-navigation, skip this tick */ }
  }, 700);
}
function stopStreaming() {
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
}

async function browserOpen(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http(s)://");
  const p = await ensureBrowser();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  return { url: p.url(), title: await p.title() };
}

async function browserClick(selector: string) {
  if (!page) throw new Error("no page open — call browser_open first");
  await page.click(selector, { timeout: 8000 });
  return { ok: true };
}

async function browserType(selector: string, text: string) {
  if (!page) throw new Error("no page open — call browser_open first");
  await page.fill(selector, text, { timeout: 8000 });
  return { ok: true };
}

async function browserRead() {
  if (!page) throw new Error("no page open — call browser_open first");
  const title = await page.title();
  const url = page.url();
  const text = await page.evaluate(() => document.body?.innerText ?? "");
  return { url, title, text: text.slice(0, 6000) };
}

async function browserScreenshot() {
  if (!page) throw new Error("no page open — call browser_open first");
  const buf = await page.screenshot({ type: "jpeg", quality: 70 });
  return { image_base64: buf.toString("base64"), mime: "image/jpeg" };
}

async function browserClose() {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  page = null; browser = null; mode = null;
  stopStreaming();
  browserEvents.emit("status", { mode: null, open: false });
  return { ok: true };
}

export const browserTools: ToolDef[] = [
  {
    schema: schema("browser_open", "Open a URL in the browser you control. Launches the browser on first use (local display or streamed to the web UI, depending on configuration).", {
      url: { type: "string", description: "full http(s) URL to navigate to" },
    }, ["url"]),
    handler: async (args) => browserOpen(String(args.url ?? "")),
  },
  {
    schema: schema("browser_click", "Click an element on the current page by CSS selector.", {
      selector: { type: "string" },
    }, ["selector"]),
    handler: async (args) => browserClick(String(args.selector ?? "")),
  },
  {
    schema: schema("browser_type", "Type text into an input/textarea on the current page by CSS selector.", {
      selector: { type: "string" }, text: { type: "string" },
    }, ["selector", "text"]),
    handler: async (args) => browserType(String(args.selector ?? ""), String(args.text ?? "")),
  },
  {
    schema: schema("browser_read", "Read the current page's visible text (up to ~6000 chars), title, and URL.", {}),
    handler: async () => browserRead(),
  },
  {
    schema: schema("browser_screenshot", "Take a screenshot of the current page and see it directly.", {}),
    handler: async () => browserScreenshot(),
  },
  {
    schema: schema("browser_close", "Close the browser.", {}),
    handler: async () => browserClose(),
  },
];
