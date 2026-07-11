// Status SFX — the Pi's own speaker and whatever browser is watching play
// the same sound at the same moment, not just "as soon as each one hears
// about it." Network delivery to a browser is never zero-latency, so instead
// of playing on receipt, every trigger computes a near-future timestamp and
// broadcasts THAT — the Pi schedules its local aplay/paplay call for exactly
// that instant, and the browser schedules Web Audio playback for the same
// instant using sample-accurate AudioContext scheduling (see public/index.html).
// Both sides target the same wall-clock moment instead of racing a message
// across the network, which is what actually gets them close together.
//
// This can't be physically perfect — it's bounded by clock skew between the
// Pi and whatever device the browser is on, typically low milliseconds on
// devices with NTP sync — but it's the right architecture for "as close as
// physically achievable," not "whichever gets the message first."
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SFX_DIR = join(__dirname, "..", "public", "sfx");

export type SfxEvent = "sent" | "success" | "error";

const SFX_FILES: Record<SfxEvent, string> = {
  sent: join(SFX_DIR, "sent.wav"),
  success: join(SFX_DIR, "success.wav"),
  error: join(SFX_DIR, "error.wav"),
};

// How far ahead of "now" a scheduled play-time is set. Needs to comfortably
// cover: the WS hop to the browser, and the browser's own scheduling call —
// too short and slower clients miss the window and just play late; too long
// and it starts feeling laggy. 150ms is a reasonable middle ground on a LAN.
const LOOKAHEAD_MS = 150;

export const sfxEvents = new EventEmitter();

function playLocal(file: string) {
  if (!existsSync(file)) return;
  // aplay (ALSA) is the near-universal default on Raspberry Pi OS; paplay
  // (PulseAudio) as a fallback for setups running a sound server instead.
  execFile("aplay", ["-q", file], (err) => {
    if (err) execFile("paplay", [file], () => { /* no audio output reachable, skip */ });
  });
}

// Triggers a status sound: schedules the Pi's own local playback for
// (now + LOOKAHEAD_MS) and, at the same instant this function is called,
// broadcasts that same target timestamp for any listening browser to
// schedule itself against. See /ws/sfx in server.ts for the broadcast side.
export function triggerSfx(event: SfxEvent) {
  const playAt = Date.now() + LOOKAHEAD_MS;
  sfxEvents.emit("play", { event, play_at: playAt });
  const delay = playAt - Date.now();
  setTimeout(() => playLocal(SFX_FILES[event]), Math.max(0, delay));
}
