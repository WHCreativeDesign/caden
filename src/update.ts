// Self-update: poll for new commits on the tracked branch, pull, rebuild,
// then exit cleanly — systemd's Restart=always relaunches the freshly built
// app. This restarts the Caden *process*, never the Pi itself.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isBusy } from "./activity.js";

const run = promisify(execFile);

// A chat turn (web UI or Telegram) can legitimately run for up to a few
// minutes now (the retry loop in agent.ts). Restarting the instant a build
// finishes used to just call process.exit(0) with zero regard for that —
// hard-killing any in-flight request's connection, which surfaces to the
// person as a raw "Failed to fetch" with no explanation. Wait for things to
// go idle first, capped so self-update can't be blocked forever by
// back-to-back requests on hardware that's otherwise busy nonstop.
const RESTART_WAIT_CAP_MS = 4 * 60_000;

const BRANCH = process.env.UPDATE_BRANCH || "main";
const REPO_DIR = process.cwd();

let intervalMs = clampInterval(Number(process.env.UPDATE_INTERVAL_MS) || 3 * 60_000);
let timer: NodeJS.Timeout | null = null;
let checking = false;
let lastChecked: string | null = null;
let currentSha = "unknown";

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return 3 * 60_000;
  return Math.max(15_000, Math.min(60 * 60_000, Math.round(ms)));
}

export function updateStatus() {
  return { branch: BRANCH, sha: currentSha, last_checked: lastChecked, interval_ms: intervalMs };
}

// Settable from the Options panel — takes effect on the next tick rather
// than requiring a restart, same self-rescheduling-timer trick used for the
// browser stream interval.
export function setUpdateInterval(ms: number): number {
  intervalMs = clampInterval(ms);
  if (timer) { clearInterval(timer); timer = setInterval(checkOnce, intervalMs); }
  return intervalMs;
}

async function readSha(): Promise<string> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_DIR });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function checkOnce(): Promise<void> {
  if (checking) return;
  checking = true;
  lastChecked = new Date().toISOString();
  try {
    await run("git", ["fetch", "origin", BRANCH], { cwd: REPO_DIR, timeout: 30_000 });
    const { stdout: local } = await run("git", ["rev-parse", "HEAD"], { cwd: REPO_DIR });
    const { stdout: remote } = await run("git", ["rev-parse", `origin/${BRANCH}`], { cwd: REPO_DIR });
    if (local.trim() === remote.trim()) return;

    console.log(`[update] new commits on ${BRANCH}, pulling…`);
    await run("git", ["pull", "--ff-only", "origin", BRANCH], { cwd: REPO_DIR, timeout: 30_000 });
    console.log("[update] installing + building…");
    await run("npm", ["ci"], { cwd: REPO_DIR, timeout: 5 * 60_000 });
    await run("npm", ["run", "build"], { cwd: REPO_DIR, timeout: 5 * 60_000 });
    console.log("[update] build complete");
    if (isBusy()) {
      console.log("[update] a chat turn is in flight — waiting for it before restarting");
      const waitStart = Date.now();
      while (isBusy() && Date.now() - waitStart < RESTART_WAIT_CAP_MS) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (isBusy()) console.warn("[update] still busy after the wait cap — restarting anyway");
    }
    console.log("[update] exiting for systemd to relaunch");
    process.exit(0);
  } catch (err) {
    console.error("[update] check failed:", (err as Error).message ?? err);
  } finally {
    checking = false;
  }
}

// The Options panel's "Check Now" button — forces an immediate check
// instead of waiting for the next tick. Shares checkOnce with the poll loop
// (guarded by `checking`) so a manual click can't race a scheduled one.
export async function checkNow(): Promise<ReturnType<typeof updateStatus>> {
  await checkOnce();
  return updateStatus();
}

export async function startUpdateWatcher() {
  currentSha = await readSha();
  timer = setInterval(checkOnce, intervalMs);
}
