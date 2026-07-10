// Entrypoint. In production (systemd), env vars come from
// systemd/caden.service's EnvironmentFile= directive. This loader is a dev
// convenience only — it never overrides a variable that's already set.
import { readFileSync, existsSync } from "node:fs";
import { startServer } from "./server.js";
import { startUpdateWatcher } from "./update.js";

function loadDotEnvIfPresent() {
  if (!existsSync(".env")) return;
  const lines = readFileSync(".env", "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnvIfPresent();
startServer();
startUpdateWatcher().catch((err) => console.error("[update] watcher failed to start:", err));
