// Central log bus: makes the System Log panel show *everything* the daemon
// does, not just shell commands. Two jobs:
//
//   1. Forward every console.log/info/warn/error/debug call onto the same
//      `auditEvents` channel that `/ws/log` already streams to the web UI —
//      so all the [server]/[update]/[sfx]/[telegram]/[weather] logging that
//      used to only reach the journal now shows up live in the panel too.
//   2. Keep a ring buffer of every entry since this process booted (shell
//      activity AND the forwarded console output), so a browser that opens
//      the panel later still gets the full backlog, not just what happens
//      after it connects. The daemon self-updates by restarting, so
//      "since boot" is the practical scope of "everything".
//
// Only the daemon installs this (see index.ts). The caden-chat CLI, a
// separate process, must keep its normal console output — it never imports
// this module.
import { auditEvents, AuditEntry } from "./tools/shell.js";

// Bounded so a long-running daemon can't grow this without limit. Shell
// entries can carry up to ~8KB of output each, so 1000 keeps the worst case
// to a handful of MB on the Pi while still being a deep backlog in practice.
const MAX_LOG_HISTORY = 1000;
const history: AuditEntry[] = [];

// Registered at module load — before installConsoleCapture() patches console
// and before the server starts emitting — so the buffer captures every entry
// from the first one. Both shell audit entries (emitted by shell.ts) and the
// console output forwarded below flow through this same channel.
auditEvents.on("entry", (entry: AuditEntry) => {
  history.push(entry);
  if (history.length > MAX_LOG_HISTORY) history.splice(0, history.length - MAX_LOG_HISTORY);
});

// A snapshot of everything logged since boot, for replaying to a browser the
// moment it connects to /ws/log (see server.ts).
export function logHistory(): AuditEntry[] {
  return history.slice();
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

let installed = false;

// Wrap the console methods so each call still prints to the journal via the
// original method AND is emitted as a log entry. `inEmit` guards against the
// (currently non-existent, but cheap to rule out) case of a listener logging
// while handling an entry, which would otherwise recurse.
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  const levels: Array<{ method: "log" | "info" | "debug" | "warn" | "error"; status: AuditEntry["status"] }> = [
    { method: "log", status: "log" },
    { method: "info", status: "log" },
    { method: "debug", status: "log" },
    { method: "warn", status: "warn" },
    { method: "error", status: "error" },
  ];

  let inEmit = false;
  for (const { method, status } of levels) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      if (inEmit) return;
      inEmit = true;
      try {
        auditEvents.emit("entry", {
          ts: new Date().toISOString(),
          command: args.map(formatArg).join(" "),
          cwd: "console",
          status,
        });
      } catch {
        // Never let logging itself take the process down.
      } finally {
        inEmit = false;
      }
    };
  }
}
