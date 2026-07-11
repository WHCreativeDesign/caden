// Durable memory across conversations — this is what makes Caden actually
// know whether it's met you before, and remember your name once you've
// given it. Stored as a small JSON file next to the audit log; loaded into
// the system prompt each turn, and written to via the `remember` tool.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { schema, ToolDef } from "../types.js";

const MEM_DIR = join(homedir(), ".caden");
const MEM_FILE = join(MEM_DIR, "memory.json");

export interface Memory {
  user_name?: string;
  first_seen?: string;
  notes: string[];
}

export function loadMemory(): Memory {
  try {
    const m = JSON.parse(readFileSync(MEM_FILE, "utf8"));
    return {
      user_name: typeof m.user_name === "string" ? m.user_name : undefined,
      first_seen: typeof m.first_seen === "string" ? m.first_seen : undefined,
      notes: Array.isArray(m.notes) ? m.notes.filter((n: unknown) => typeof n === "string") : [],
    };
  } catch {
    return { notes: [] };
  }
}

function saveMemory(m: Memory) {
  mkdirSync(MEM_DIR, { recursive: true });
  writeFileSync(MEM_FILE, JSON.stringify(m, null, 2));
}

// The Options panel's "Forget Me" control — a full reset back to first
// contact, for testing the greeting flow or actually asking Caden to forget.
export function forgetMemory(): Memory {
  const empty: Memory = { notes: [] };
  saveMemory(empty);
  return empty;
}

// First contact = we don't yet know their name and have no notes, regardless
// of whether first_seen has been stamped. Keeps the "have we met?" question
// honest even if a session was abandoned before a name was given.
export function memoryContext(m: Memory): string {
  const known = !!m.user_name || m.notes.length > 0;
  if (!known) {
    return "MEMORY: You have not met this person before — this is first contact. You do not know their name.";
  }
  const parts: string[] = [];
  if (m.user_name) parts.push(`Their name is ${m.user_name}.`);
  if (m.notes.length) parts.push("You also remember: " + m.notes.slice(-24).join("; ") + ".");
  return "MEMORY (what you already know about this person, from past conversations — do not reintroduce yourself):\n" + parts.join(" ");
}

export const memoryTools: ToolDef[] = [
  {
    schema: schema(
      "remember",
      "Save something durable about the person you're talking to, so you still know it in future conversations. Call it the instant you learn their name, and for lasting preferences or facts worth keeping — not for transient, in-the-moment details.",
      {
        user_name: { type: "string", description: "the person's name, if you just learned it" },
        note: { type: "string", description: "a durable fact or preference worth remembering long-term" },
      },
    ),
    handler: async (args) => {
      const m = loadMemory();
      let changed = false;
      if (typeof args.user_name === "string" && args.user_name.trim()) {
        m.user_name = args.user_name.trim().slice(0, 80);
        changed = true;
      }
      if (typeof args.note === "string" && args.note.trim()) {
        m.notes.push(args.note.trim().slice(0, 400));
        if (m.notes.length > 100) m.notes = m.notes.slice(-100);
        changed = true;
      }
      if (changed && !m.first_seen) m.first_seen = new Date().toISOString();
      if (changed) saveMemory(m);
      return { ok: changed, remembered: { user_name: m.user_name ?? null, notes_count: m.notes.length } };
    },
  },
];
