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
import { auditEvents } from "./tools/shell.js";

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

// Failures here used to be swallowed completely — which meant "no sound
// from the headphone jack" had zero diagnosability short of SSHing in and
// guessing. Now a total failure (both aplay and paplay) logs the real
// stderr to both the journal AND the live SYSTEM LOG panel (auditEvents,
// the same channel run_shell uses), so it shows up immediately from the
// Options tab's "test sound" buttons without needing a terminal.
function playLocal(file: string) {
  if (!existsSync(file)) return;
  // SFX_AUDIO_DEVICE lets you force a specific ALSA device (e.g.
  // "plughw:0,0" for the Pi's onboard analog jack) when the system default
  // routes elsewhere (HDMI is a common default even with headphones
  // plugged in) — see CLAUDE.md's SFX troubleshooting section.
  const device = process.env.SFX_AUDIO_DEVICE;
  const aplayArgs = device ? ["-q", "-D", device, file] : ["-q", file];
  execFile("aplay", aplayArgs, (aplayErr, _out, aplayStderr) => {
    if (!aplayErr) return;
    // paplay needs a reachable PulseAudio user socket — which a systemd
    // service doesn't get for free, since it isn't part of a graphical
    // login session and so has no XDG_RUNTIME_DIR set. Best-guess the
    // standard path (/run/user/<uid>) rather than letting this fallback be
    // dead on arrival for every systemd-run install.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : "") };
    execFile("paplay", [file], { env }, (paErr, _po, paStderr) => {
      if (!paErr) return;
      const detail = [String(aplayStderr || aplayErr.message || "").trim(), String(paStderr || paErr.message || "").trim()]
        .filter(Boolean).join(" | ") || "no audio output reachable";
      console.error(`[sfx] playback failed for ${file}: ${detail}`);
      auditEvents.emit("entry", {
        ts: new Date().toISOString(),
        command: `sfx: play ${file}`,
        cwd: SFX_DIR,
        status: "error",
        output: detail.slice(0, 500),
      });
    });
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
