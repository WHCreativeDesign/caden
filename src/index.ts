// Entrypoint. In production (systemd), env vars come from
// systemd/caden.service's EnvironmentFile= directive; loadDotEnvIfPresent
// is a dev convenience that never overrides an already-set variable.
import { loadDotEnvIfPresent } from "./env.js";
import { startServer } from "./server.js";
import { startUpdateWatcher } from "./update.js";

loadDotEnvIfPresent();
startServer();
startUpdateWatcher().catch((err) => console.error("[update] watcher failed to start:", err));
