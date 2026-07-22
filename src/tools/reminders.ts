// Reminders/timers — the one genuinely proactive thing in this app: Caden
// can surface something *without* being asked again, even in a future
// conversation, rather than only ever responding to a message. Persisted to
// ~/.caden/reminders.json (same pattern as memory.ts), checked on an
// interval by startReminderWatcher() (wired in server.ts).
//
// A due reminder does two things at once: it fires reminderEvents "due" —
// which server.ts relays over /ws/reminders for a live toast, and which
// also triggers the "reminder" status SFX (see sfx.ts) so it's audible even
// if no one's looking at the screen — and it becomes a "pending
// notification" that the next real chat turn will fold into context (see
// pendingNotifications()/acknowledgeReminders() and their use in agent.ts),
// so it still gets mentioned in conversation even if the toast was missed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { schema, ToolDef } from "../types.js";
import { triggerSfx } from "../sfx.js";

const DIR = join(homedir(), ".caden");
const FILE = join(DIR, "reminders.json");
const CHECK_INTERVAL_MS = 15_000;

export interface Reminder {
  id: string;
  message: string;
  due_at: string;
  created_at: string;
  fired: boolean;
  acknowledged: boolean;
}

export const reminderEvents = new EventEmitter();

function load(): Reminder[] {
  try {
    const list = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list: Reminder[]) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

export function listReminders(includeSettled = false): Reminder[] {
  const list = load();
  return includeSettled ? list : list.filter((r) => !r.fired);
}

// Fired-but-not-yet-mentioned-in-conversation — agent.ts injects these into
// the next turn's context, then acknowledges them so they aren't repeated
// on every subsequent turn forever.
export function pendingNotifications(): Reminder[] {
  return load().filter((r) => r.fired && !r.acknowledged);
}

export function acknowledgeReminders(ids: string[]): void {
  const list = load();
  let changed = false;
  for (const r of list) {
    if (ids.includes(r.id) && !r.acknowledged) { r.acknowledged = true; changed = true; }
  }
  if (changed) save(list);
}

function addReminder(message: string, dueAt: Date): Reminder {
  const list = load();
  const r: Reminder = {
    id: randomUUID(),
    message,
    due_at: dueAt.toISOString(),
    created_at: new Date().toISOString(),
    fired: false,
    acknowledged: false,
  };
  list.push(r);
  save(list);
  return r;
}

function cancelReminder(id: string): boolean {
  const list = load();
  const idx = list.findIndex((r) => r.id === id && !r.fired);
  if (idx === -1) return false;
  list.splice(idx, 1);
  save(list);
  return true;
}

// Checked on an interval rather than one-setTimeout-per-reminder — simpler,
// survives process restarts (self-update, crash) without needing to
// reschedule anything on boot, and 15s resolution is plenty for reminders
// pitched in minutes.
function checkDue(): void {
  const list = load();
  let changed = false;
  const now = Date.now();
  for (const r of list) {
    if (!r.fired && new Date(r.due_at).getTime() <= now) {
      r.fired = true;
      changed = true;
      console.log(`[reminder] due: ${r.message}`);
      reminderEvents.emit("due", r);
      triggerSfx("reminder");
    }
  }
  if (changed) save(list);
}

export function startReminderWatcher(): void {
  setInterval(checkDue, CHECK_INTERVAL_MS);
}

export const reminderTools: ToolDef[] = [
  {
    schema: schema(
      "set_reminder",
      "Set a reminder that surfaces later — even in a future conversation, and as a live notification if someone's watching the web UI. Give a clear message and when it's due: either minutes from now, or an exact ISO 8601 timestamp.",
      {
        message: { type: "string", description: "what to remind the person about" },
        minutes_from_now: { type: "number", description: "minutes from now this is due — use this OR due_at, not both" },
        due_at: { type: "string", description: "ISO 8601 timestamp this is due — use this OR minutes_from_now, not both" },
      },
      ["message"],
    ),
    handler: async (args) => {
      const message = String(args.message ?? "").trim();
      if (!message) throw new Error("message is required");
      let due: Date;
      if (args.due_at) due = new Date(String(args.due_at));
      else if (args.minutes_from_now != null && Number.isFinite(Number(args.minutes_from_now))) {
        due = new Date(Date.now() + Number(args.minutes_from_now) * 60_000);
      } else {
        throw new Error("give either minutes_from_now or due_at");
      }
      if (Number.isNaN(due.getTime())) throw new Error("invalid due date/time");
      return { ok: true, reminder: addReminder(message, due) };
    },
  },
  {
    schema: schema("list_reminders", "List pending (not yet due) reminders.", {}),
    handler: async () => ({ reminders: listReminders() }),
  },
  {
    schema: schema(
      "cancel_reminder",
      "Cancel a pending reminder by its id (from list_reminders or the confirmation set_reminder returned).",
      { id: { type: "string" } },
      ["id"],
    ),
    handler: async (args) => ({ ok: cancelReminder(String(args.id ?? "")) }),
  },
];
