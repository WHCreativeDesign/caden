// Telegram remote-access channel — text and voice notes so Caden is
// reachable from outside the house, reusing the exact same agent loop as
// the web UI. Deliberately NOT real "calls": the Telegram Bot API has no
// access to live voice/video calls at all — those are end-to-end encrypted
// client-to-client and never exposed to bots. The feasible equivalent is
// voice NOTES — a recorded message in, transcribed and answered with both
// a text reply and a synthesized voice note back.
//
// Talks to the Bot API directly over plain fetch, no SDK — it's a small,
// well-documented REST API (same "a few fetch calls beat an extra
// dependency" instinct as web_search's DDG-scrape and get_weather's
// wttr.in call). Long-polls getUpdates rather than needing a public
// webhook/HTTPS endpoint, since a home Pi behind NAT has neither.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compactHistoryIfNeeded, runAgentTurnRetrying } from "./agent.js";
import { transcribeAudio } from "./providers.js";
import { synthesizeSpeech } from "./piper.js";
import { triggerSfx } from "./sfx.js";
import { markBusy, markIdle } from "./activity.js";
import { auditEvents } from "./tools/shell.js";

const CONFIG_DIR = join(homedir(), ".caden");
const CONFIG_FILE = join(CONFIG_DIR, "telegram.json");

interface TelegramConfig { token: string; allowedChatIds: string[] }

// Same pattern as tools/memory.ts and tools/reminders.ts: a small JSON file
// under ~/.caden. .env values are the fallback/first-boot default so an
// existing .env-based setup keeps working untouched; once the Options tab
// saves a config here, this file wins from then on — it's the whole point
// of a "manage from the website" page instead of editing .env + restarting.
function loadConfig(): TelegramConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
      return {
        token: typeof raw.token === "string" ? raw.token : "",
        allowedChatIds: Array.isArray(raw.allowedChatIds) ? raw.allowedChatIds.map(String) : [],
      };
    }
  } catch {
    // corrupt/unreadable config file — fall through to .env defaults below
  }
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function persistConfig(cfg: TelegramConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
// API/FILE_API/ALLOWED are derived from `config` and recomputed by
// applyConfig() — read at call time by the functions below, not captured,
// so a live config change takes effect on the very next request rather
// than needing a process restart.
let API: string | null = null;
let FILE_API: string | null = null;
let ALLOWED = new Set<string>();

function applyConfig(): void {
  API = config.token ? `https://api.telegram.org/bot${config.token}` : null;
  FILE_API = config.token ? `https://api.telegram.org/file/bot${config.token}` : null;
  ALLOWED = new Set(config.allowedChatIds);
}
applyConfig();

// Per-chat conversation history, in-memory only (mirrors the web UI's
// per-browser localStorage history, just server-side) — resets on restart,
// which is an acceptable trade for single-user hardware that already
// restarts periodically for self-update.
const sessions = new Map<number, Array<Record<string, unknown>>>();
function sessionFor(chatId: number): Array<Record<string, unknown>> {
  let s = sessions.get(chatId);
  if (!s) { s = []; sessions.set(chatId, s); }
  return s;
}

async function tgCall(method: string, body?: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40_000),
  });
  const data: any = await resp.json();
  if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || resp.status}`);
  return data.result;
}

async function sendText(chatId: number, text: string): Promise<void> {
  // Telegram caps a single message at 4096 chars — chunk a long reply
  // rather than truncating or erroring on it.
  const body = text || "(no reply)";
  for (let i = 0; i < body.length; i += 4000) {
    await tgCall("sendMessage", { chat_id: chatId, text: body.slice(i, i + 4000) });
  }
}

// sendVoice (the round "voice message" bubble) requires actual OGG/Opus —
// synthesizeSpeech returns WAV, so this sends a regular audio attachment
// instead (sendAudio), which accepts WAV without needing an ffmpeg re-encode.
async function sendVoiceReply(chatId: number, text: string): Promise<void> {
  try {
    const wav = await synthesizeSpeech(text);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("audio", new Blob([wav as unknown as BlobPart], { type: "audio/wav" }), "caden.wav");
    const resp = await fetch(`${API}/sendAudio`, { method: "POST", body: form, signal: AbortSignal.timeout(40_000) });
    const data: any = await resp.json();
    if (!data.ok) throw new Error(data.description || "sendAudio failed");
  } catch (err) {
    // A missing voice reply shouldn't take down the text reply that already
    // went out — log it and move on.
    console.error("[telegram] voice reply failed:", err);
  }
}

async function downloadVoiceNote(fileId: string): Promise<Buffer> {
  const file = await tgCall("getFile", { file_id: fileId });
  const resp = await fetch(`${FILE_API}/${file.file_path}`, { signal: AbortSignal.timeout(40_000) });
  return Buffer.from(await resp.arrayBuffer());
}

async function handleMessage(msg: any): Promise<void> {
  const chatId: number | undefined = msg.chat?.id;
  if (chatId == null) return;

  if (!ALLOWED.has(String(chatId))) {
    auditEvents.emit("entry", {
      ts: new Date().toISOString(),
      command: `telegram: message from unauthorized chat ${chatId}`,
      cwd: "telegram",
      status: "error",
      output: "chat id is not authorized — ignored. Add it in the Options tab (or TELEGRAM_ALLOWED_CHAT_IDS in .env).",
    });
    return;
  }

  const history = sessionFor(chatId);
  let userText: string;
  let isVoice = false;

  if (msg.voice) {
    isVoice = true;
    try {
      const buf = await downloadVoiceNote(msg.voice.file_id);
      userText = (await transcribeAudio(buf, "voice.ogg")).trim();
      if (!userText) { await sendText(chatId, "(didn't catch anything in that voice note)"); return; }
    } catch (err) {
      await sendText(chatId, "Couldn't transcribe that voice note: " + String((err as Error).message ?? err));
      return;
    }
  } else if (typeof msg.text === "string" && msg.text.trim()) {
    userText = msg.text.trim();
  } else {
    return; // photos/stickers/etc. — text and voice only for now
  }

  history.push({ role: "user", content: userText });
  triggerSfx("sent");
  // Same reason as server.ts's /api/chat: a turn can run for minutes now,
  // and update.ts's self-update watcher checks this before restarting so a
  // coincidental restart doesn't kill a reply mid-flight (see activity.ts).
  markBusy();
  try {
    const { history: nextHistory, compacted } = await compactHistoryIfNeeded(history);
    if (compacted) { history.length = 0; history.push(...nextHistory); }
    const result = await runAgentTurnRetrying(history, "caden");
    history.push({ role: "assistant", content: result.reply });
    triggerSfx("success");
    await sendText(chatId, (isVoice ? `Heard: "${userText}"\n\n` : "") + result.reply);
    await sendVoiceReply(chatId, result.reply);
  } catch (err) {
    triggerSfx("error");
    await sendText(chatId, "Something went wrong: " + String((err as Error).message ?? err));
  } finally {
    markIdle();
  }
}

// `generation` (not just a boolean) is what actually makes stop-then-start
// safe: a reconfigure calls stopTelegramBot() immediately followed by
// startTelegramBot(), but the OLD loop's in-flight getUpdates call (up to
// its 30s long-poll timeout) is still pending when that happens. A plain
// boolean flipped false-then-true-again would let that stale loop revive
// itself the moment its pending call resolves and it rechecks the flag —
// two loops now racing on `pollOffset`. Binding each loop to the
// generation it was started with means the old one's check fails for good
// once a newer generation exists, however long its last call takes to
// return.
let generation = 0;
let pollOffset = 0;

async function pollLoop(myGeneration: number): Promise<void> {
  while (generation === myGeneration) {
    try {
      const updates = await tgCall("getUpdates", { offset: pollOffset, timeout: 30 });
      for (const u of updates) {
        if (generation !== myGeneration) break; // superseded mid-batch — stop touching shared state
        pollOffset = u.update_id + 1;
        if (u.message) handleMessage(u.message).catch((err) => console.error("[telegram] handler failed:", err));
      }
    } catch (err) {
      if (generation !== myGeneration) break;
      console.error("[telegram] getUpdates failed:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function startTelegramBot(): void {
  if (!config.token) return; // dormant until configured
  if (ALLOWED.size === 0) {
    console.warn("[telegram] a bot token is set but no allowed chat ids are configured — every message will be ignored until you add one (Options tab, or TELEGRAM_ALLOWED_CHAT_IDS in .env).");
  }
  generation++;
  pollLoop(generation);
  console.log("[telegram] bot polling started");
}

export function stopTelegramBot(): void {
  generation++; // invalidates any loop still in flight, even if it's mid-await
}

// Backs the Options tab's Telegram section — POST /api/telegram/config in
// server.ts. Persists to ~/.caden/telegram.json and takes effect
// immediately: stop whatever's currently polling (old token, if any) and
// restart with the new one, no process restart needed. A changed token
// means a different bot's update stream, so its offset means nothing —
// reset it; a changed allowlist alone doesn't need that.
export function setTelegramConfig(update: { token?: string; allowedChatIds?: string[] }): void {
  const tokenChanged = update.token !== undefined && update.token.trim() !== config.token;
  if (update.token !== undefined) config.token = update.token.trim();
  if (update.allowedChatIds !== undefined) config.allowedChatIds = update.allowedChatIds.map((s) => s.trim()).filter(Boolean);
  persistConfig(config);
  applyConfig();
  stopTelegramBot();
  if (tokenChanged) pollOffset = 0;
  startTelegramBot();
}

// Deliberately never exposes the raw token — only a masked preview, so a
// GET here (or the Options tab's raw-status pre block) can't leak it.
export function telegramStatus() {
  return {
    enabled: !!config.token,
    token_preview: config.token ? `••••${config.token.slice(-4)}` : null,
    allowed_chat_ids: config.allowedChatIds,
    active_sessions: sessions.size,
  };
}
