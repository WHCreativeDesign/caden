// Browser control. One long-lived Chromium instance the daemon owns.
//
// Mode selection (BROWSER_MODE env — "auto" | "local" | "stream"):
//   local  — headed Chromium on the Pi's attached display (DISPLAY must be
//            set, e.g. a desktop session on Raspberry Pi OS with Desktop).
//   stream — headless Chromium (no X server / display needed at all —
//            Playwright's headless mode doesn't require Xvfb).
//   auto   — local if process.env.DISPLAY is set, stream otherwise.
//
// Live view: regardless of mode, whenever a page is open and someone's
// watching the web UI's Browser tab, periodic screenshots stream over
// /ws/browser — this is what makes the research agent's browsing (search
// results, the pages it opens to verify a claim, clicks, scrolls) watchable
// in real time, not just something that happens on an attached monitor you
// may not be standing in front of. The interval is live-adjustable via
// setStreamInterval (wired to POST /api/browser/interval).
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
let streamIntervalMs = clampInterval(Number(process.env.BROWSER_STREAM_INTERVAL_MS) || 700);

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return 700;
  return Math.max(200, Math.min(10_000, Math.round(ms)));
}

export function setStreamInterval(ms: number): number {
  streamIntervalMs = clampInterval(ms);
  return streamIntervalMs;
}
export function getStreamInterval(): number {
  return streamIntervalMs;
}

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
  return { mode, open: !!page, streaming: streamViewers > 0, stream_interval_ms: streamIntervalMs };
}

// server.ts calls these as WS clients connect/disconnect from /ws/browser,
// so frames are only captured (and the CPU spent) while someone's watching.
// Streaming runs regardless of local/headless mode — a headed page can be
// screenshotted just as well as a headless one.
export function addStreamViewer() {
  streamViewers++;
  if (streamViewers === 1) startStreaming();
}
export function removeStreamViewer() {
  streamViewers = Math.max(0, streamViewers - 1);
  if (streamViewers === 0) stopStreaming();
}

// A self-rescheduling timeout (not setInterval) so a live interval change
// takes effect on the very next tick instead of only after restarting.
function startStreaming() {
  if (streamTimer) return;
  const tick = async () => {
    if (streamViewers === 0) { streamTimer = null; return; }
    if (page) {
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 55 });
        browserEvents.emit("frame", buf);
      } catch { /* page mid-navigation, skip this tick */ }
    }
    streamTimer = setTimeout(tick, streamIntervalMs);
  };
  streamTimer = setTimeout(tick, streamIntervalMs);
}
function stopStreaming() {
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
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

async function browserScroll(direction: string, amount?: number) {
  if (!page) throw new Error("no page open — call browser_open first");
  const px = Math.max(50, Math.min(20_000, Number(amount) || 800));
  const dir = String(direction || "down").toLowerCase();
  if (dir === "top") await page.evaluate(() => window.scrollTo({ top: 0 }));
  else if (dir === "bottom") await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
  else {
    // mouse.wheel() dispatches at the current mouse position, which
    // defaults to (0,0) on a fresh page — outside the viewport's hit-test
    // area, so the event never scrolls anything. Move into the viewport
    // first so the wheel event actually lands on the page.
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, dir === "up" ? -px : px);
  }
  return { ok: true, scrolled: dir === "top" || dir === "bottom" ? dir : `${dir} ${px}px` };
}

async function browserDrag(fromSelector: string, toSelector: string) {
  if (!page) throw new Error("no page open — call browser_open first");
  await page.dragAndDrop(fromSelector, toSelector, { timeout: 8000 });
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
    schema: schema("browser_open", "Open a URL in the browser you control. Launches the browser on first use (local display or streamed to the web UI, depending on configuration). The live view streams to the web UI's Browser tab regardless of mode, so this is watchable in real time.", {
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
    schema: schema("browser_scroll", "Scroll the current page — use to reveal content below the fold before reading or screenshotting it.", {
      direction: { type: "string", description: "'up', 'down', 'top', or 'bottom'" },
      amount: { type: "number", description: "pixels, for up/down only (default 800)" },
    }, ["direction"]),
    handler: async (args) => browserScroll(String(args.direction ?? "down"), args.amount),
  },
  {
    schema: schema("browser_drag", "Drag an element from one place to another on the current page — e.g. reordering a list or dragging into a drop zone. Both are CSS selectors.", {
      from_selector: { type: "string" }, to_selector: { type: "string" },
    }, ["from_selector", "to_selector"]),
    handler: async (args) => browserDrag(String(args.from_selector ?? ""), String(args.to_selector ?? "")),
  },
  {
    schema: schema("browser_read", "Read the current page's visible text (up to ~6000 chars), title, and URL — use this to actually verify what a page says rather than trusting a search snippet.", {}),
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
