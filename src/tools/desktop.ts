// Whole-screen (not just browser-page) screenshots. This is what lets Caden
// actually answer "what's on my screen" — browser_screenshot only ever shows
// the page inside its own Playwright tab, which is useless for questions
// about the desktop, other windows, or anything outside the browser.
//
// Caden runs as a systemd service, which does NOT inherit DISPLAY /
// WAYLAND_DISPLAY from an interactive session — not a local desktop login,
// and not a remote one via something like Raspberry Pi Connect — even while
// one is actively running. So checking process.env and giving up if it's
// empty is wrong: there's often a real, usable session, systemd just doesn't
// hand you its address. Instead this tries the env vars if set, then the
// near-universal defaults for a Pi's first desktop session (:0 / wayland-0),
// against both an X11 tool (scrot/import) and a Wayland one (grim), and only
// gives up once everything's been tried.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, ToolDef } from "../types.js";

const execFileAsync = promisify(execFile);

function displayCandidates(): Array<Record<string, string>> {
  const candidates: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  const add = (env: Record<string, string>) => {
    const key = JSON.stringify(env);
    if (!seen.has(key)) { seen.add(key); candidates.push(env); }
  };
  if (process.env.WAYLAND_DISPLAY) add({ WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY });
  if (process.env.DISPLAY) add({ DISPLAY: process.env.DISPLAY });
  add({ WAYLAND_DISPLAY: "wayland-0" });
  add({ DISPLAY: ":0" });
  return candidates;
}

function captureAttempts(out: string, quality: number, envOverride: Record<string, string>) {
  const attempts: Array<{ cmd: string; args: string[] }> = [];
  if (envOverride.WAYLAND_DISPLAY) {
    attempts.push({ cmd: "grim", args: ["-t", "jpeg", "-q", String(quality), out] });
  }
  if (envOverride.DISPLAY) {
    attempts.push({ cmd: "scrot", args: ["-o", "-q", String(quality), out] });
    attempts.push({ cmd: "import", args: ["-window", "root", "-quality", String(quality), out] });
  }
  return attempts;
}

export async function screenshotDesktop(opts: { quality?: number } = {}): Promise<{ image_base64: string; mime: string }> {
  const quality = Math.max(1, Math.min(100, opts.quality ?? 80));
  const dir = await mkdtemp(join(tmpdir(), "caden-shot-"));
  const out = join(dir, "shot.jpg");
  let lastErr: unknown;
  try {
    for (const envOverride of displayCandidates()) {
      for (const { cmd, args } of captureAttempts(out, quality, envOverride)) {
        try {
          await execFileAsync(cmd, args, { timeout: 8000, env: { ...process.env, ...envOverride } });
          const buf = await readFile(out);
          return { image_base64: buf.toString("base64"), mime: "image/jpeg" };
        } catch (err) {
          lastErr = err;
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  throw new Error(
    "Could not capture the desktop — tried grim (Wayland) and scrot/import (X11) against every " +
    "reachable session, none worked. If you're on a remote session (e.g. Raspberry Pi Connect), " +
    "make sure it's actually active and that grim or scrot is installed. " +
    `Last error: ${String((lastErr as Error)?.message ?? lastErr)}`,
  );
}

export const desktopTools: ToolDef[] = [
  {
    schema: schema(
      "screenshot_desktop",
      "Take a screenshot of the ENTIRE desktop this Pi is running — every window, not just the browser tab — whether that session is local or a remote one (e.g. Raspberry Pi Connect). Use this whenever asked what's on screen, what's currently open, or to visually check the state of the machine.",
      {},
    ),
    handler: async () => screenshotDesktop(),
  },
];
