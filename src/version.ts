// Caden's own build/version identifier — "MAINFRAME" in the retro-console
// branding. Read straight from package.json so there's exactly one place to
// bump it, and it's always accurate for whatever build is actually running
// (self-update rebuilds + restarts the process, so this is recomputed fresh
// on every restart rather than going stale).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

export const MAINFRAME_VERSION: string = pkg.version ?? "0.0.0";
