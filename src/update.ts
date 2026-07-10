// Self-update: poll for new commits on the tracked branch, pull, rebuild,
// then exit cleanly — systemd's Restart=always relaunches the freshly built
// app. This restarts the Caden *process*, never the Pi itself.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const BRANCH = process.env.UPDATE_BRANCH || "main";
const INTERVAL_MS = Number(process.env.UPDATE_INTERVAL_MS) || 3 * 60_000;
const REPO_DIR = process.cwd();

let lastChecked: string | null = null;
let currentSha = "unknown";

export function updateStatus() {
  return { branch: BRANCH, sha: currentSha, last_checked: lastChecked, interval_ms: INTERVAL_MS };
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
    console.log("[update] build complete — exiting for systemd to relaunch");
    process.exit(0);
  } catch (err) {
    console.error("[update] check failed:", (err as Error).message ?? err);
  }
}

export async function startUpdateWatcher() {
  currentSha = await readSha();
  setInterval(checkOnce, INTERVAL_MS);
}
