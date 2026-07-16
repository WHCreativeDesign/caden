// Entrypoint. In production (systemd), env vars come from
// systemd/caden.service's EnvironmentFile= directive; loadDotEnvIfPresent
// is a dev convenience that never overrides an already-set variable.
import { loadDotEnvIfPresent } from "./env.js";
import { startServer } from "./server.js";
import { startUpdateWatcher } from "./update.js";
import { startReminderWatcher } from "./tools/reminders.js";
import { startTelegramBot } from "./telegram.js";
import { triggerSfx } from "./sfx.js";

loadDotEnvIfPresent();
startServer();
startUpdateWatcher().catch((err) => console.error("[update] watcher failed to start:", err));
startReminderWatcher();
startTelegramBot(); // no-op unless TELEGRAM_BOT_TOKEN is set — see .env.example
// "Systems online" — plays once per boot (including self-update relaunches,
// which is a reasonable "back online" moment too, not just first install).
triggerSfx("startup");
