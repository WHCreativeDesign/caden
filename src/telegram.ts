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
import SamJs from "sam-js";
import { compactHistoryIfNeeded, runAgentTurnRetrying } from "./agent.js";
import { transcribeAudio } from "./providers.js";
import { triggerSfx } from "./sfx.js";
import { auditEvents } from "./tools/shell.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const FILE_API = TOKEN ? `https://api.telegram.org/file/bot${TOKEN}` : null;

// Deny-by-default: this bot has the SAME full shell/browser access as the
// web UI, so an unauthenticated Telegram bot would hand that to anyone who
// finds the bot's @username. Only chat IDs listed here are answered at all;
// everything else is logged to the audit log and silently ignored.
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

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

// Same "Caden" → "Kayden" phonetic fix as the web UI's SAM voice (see
// public/index.html's ttsText) — SAM's reciter mispronounces "Caden" as
// "CAD-en" otherwise. Small enough not to be worth sharing a module between
// a browser-inlined script and this Node file for one regex.
function ttsText(text: string): string {
  return text.replace(/\bcaden\b/gi, "Kayden");
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
// sam-js produces WAV, so this sends a regular audio attachment instead
// (sendAudio), which accepts WAV/MP3 without needing an ffmpeg re-encode.
async function sendVoiceReply(chatId: number, text: string): Promise<void> {
  try {
    const sam = new SamJs({ speed: 72, pitch: 64, mouth: 128, throat: 128 });
    const wav = sam.wav(ttsText(text));
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
      output: "chat id is not in TELEGRAM_ALLOWED_CHAT_IDS — ignored. Add it to .env to authorize this chat.",
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
  }
}

let polling = false;
let pollOffset = 0;

async function pollLoop(): Promise<void> {
  while (polling) {
    try {
      const updates = await tgCall("getUpdates", { offset: pollOffset, timeout: 30 });
      for (const u of updates) {
        pollOffset = u.update_id + 1;
        if (u.message) handleMessage(u.message).catch((err) => console.error("[telegram] handler failed:", err));
      }
    } catch (err) {
      console.error("[telegram] getUpdates failed:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function startTelegramBot(): void {
  if (!TOKEN) return; // dormant unless configured — see .env.example
  if (ALLOWED.size === 0) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN is set but TELEGRAM_ALLOWED_CHAT_IDS is empty — every message will be ignored until you set it.");
  }
  polling = true;
  pollLoop();
  console.log("[telegram] bot polling started");
}

export function stopTelegramBot(): void {
  polling = false;
}

export function telegramStatus() {
  return { enabled: !!TOKEN, allowed_chats: ALLOWED.size, active_sessions: sessions.size };
}
