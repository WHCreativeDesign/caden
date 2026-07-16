// Browser control. One long-lived Chromium instance the daemon owns.
//
// Mode selection (BROWSER_MODE env — "auto" | "local" | "stream"):
//   local  — headed Chromium on the Pi's attached display (DISPLAY must be
//            set, e.g. a desktop session on Raspberry Pi OS with Desktop).
//   stream — headless Chromium (no X server / display needed at all —
//            Playwright's headless mode doesn't require Xvfb).
//   auto   — local if process.env.DISPLAY is set, stream otherwise.
//
// There used to be a live-view "Browser" tab in the web UI streaming
// periodic desktop screenshots over /ws/browser — cut, along with all of
// its streaming machinery here (addStreamViewer/startStreaming/the
// browserEvents frame/status emitter). browser_screenshot still exists as
// an on-demand agent tool if a specific look at the page is ever needed;
// this was a background live-preview feed, a different thing.
import { chromium, Browser, Page } from "playwright";
import { schema, ToolDef } from "../types.js";

type Mode = "local" | "stream";

let browser: Browser | null = null;
let page: Page | null = null;
let mode: Mode | null = null;
// Debug override for BROWSER_MODE, settable at runtime from the Options
// panel — takes effect on the next launch, so paired with closeBrowser() to
// force that immediately rather than waiting for whatever tool call happens
// to open a fresh page next.
let modeOverride: Mode | null = null;

export function setModeOverride(value: string | null) {
  modeOverride = value === "local" || value === "stream" ? value : null;
  return modeOverride ?? "auto";
}
export function getModeOverride(): string {
  return modeOverride ?? "auto";
}

function resolveMode(): Mode {
  if (modeOverride) return modeOverride;
  const configured = (process.env.BROWSER_MODE || "auto").toLowerCase();
  if (configured === "local" || configured === "stream") return configured;
  return process.env.DISPLAY ? "local" : "stream";
}

async function ensureBrowser(): Promise<Page> {
  if (page) return page;
  mode = resolveMode();
  browser = await chromium.launch({ headless: mode === "stream" });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  return page;
}

export function browserStatus() {
  return { mode, mode_override: modeOverride ?? "auto", open: !!page };
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

// Exported standalone (not just the browser_close tool handler) so the
// Options panel's "Restart Browser" control can force a fresh launch —
// mode changes only take effect on the next chromium.launch() call, and a
// debug control that says "restart" should mean it right away, not "next
// time some tool call happens to open a page."
export async function closeBrowser() {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  page = null; browser = null; mode = null;
  return { ok: true };
}

export const browserTools: ToolDef[] = [
  {
    schema: schema("browser_open", "Open a URL in the browser you control. Launches the browser on first use (local display or headless, depending on configuration). Use browser_screenshot to see what the page looks like.", {
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
    handler: async () => closeBrowser(),
  },
];
