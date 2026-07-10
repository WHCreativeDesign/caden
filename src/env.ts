// Dev convenience only — production (systemd) gets env vars from
// systemd/caden.service's EnvironmentFile= directive. Never overrides a
// variable that's already set.
import { readFileSync, existsSync } from "node:fs";

export function loadDotEnvIfPresent(path = ".env") {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
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
