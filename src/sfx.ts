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
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { auditEvents } from "./tools/shell.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SFX_DIR = join(__dirname, "..", "public", "sfx");

export type SfxEvent = "sent" | "success" | "error" | "thinking" | "reminder" | "startup";

const SFX_FILES: Record<SfxEvent, string> = {
  sent: join(SFX_DIR, "sent.wav"),
  success: join(SFX_DIR, "success.wav"),
  error: join(SFX_DIR, "error.wav"),
  thinking: join(SFX_DIR, "thinking.wav"),
  reminder: join(SFX_DIR, "reminder.wav"),
  startup: join(SFX_DIR, "startup.wav"),
};

// How far ahead of "now" a scheduled play-time is set. Needs to comfortably
// cover: the WS hop to the browser, the browser's own scheduling call, AND
// (below) enough headroom to compensate for the Pi's local playback
// overhead — too short and slower clients/compensation miss the window and
// just play late; too long and it starts feeling laggy.
const LOOKAHEAD_MS = 220;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Read each clip's real duration from its own WAV header rather than
// hardcoding it, so this stays correct if gen-sfx.mjs is ever changed to
// produce different-length sounds.
function wavDurationMs(filePath: string): number {
  try {
    const buf = readFileSync(filePath);
    const sampleRate = buf.readUInt32LE(24);
    const channels = buf.readUInt16LE(22);
    const bitsPerSample = buf.readUInt16LE(34);
    const dataSize = buf.readUInt32LE(40);
    const bytesPerFrame = channels * (bitsPerSample / 8);
    return (dataSize / bytesPerFrame / sampleRate) * 1000;
  } catch {
    return 300; // safe fallback guess if the file is missing/unreadable
  }
}
const SFX_DURATIONS_MS: Record<SfxEvent, number> = {
  sent: wavDurationMs(SFX_FILES.sent),
  success: wavDurationMs(SFX_FILES.success),
  error: wavDurationMs(SFX_FILES.error),
  thinking: wavDurationMs(SFX_FILES.thinking),
  reminder: wavDurationMs(SFX_FILES.reminder),
  startup: wavDurationMs(SFX_FILES.startup),
};

// The gap the user actually noticed: playAt is exact, but spawning `aplay`
// (fork+exec, dynamic-linking libasound, negotiating and opening the ALSA
// device) takes real, non-zero time — so audible sound lands measurably
// *after* the scheduled instant even though the timer fired right on time.
// The browser's Web Audio path doesn't have this problem (the AudioContext
// is already open, start(when) is sample-accurate), so left uncompensated
// the Pi visibly trails the browser.
//
// Fix: fire the local exec call *earlier* than playAt by however long that
// overhead actually is, so the ALSA device finishes opening and starts
// producing sound right as playAt arrives — same idea as a stage performer
// counting themselves in early to land on the beat. Since that overhead is
// hardware/load-dependent and can't be known in advance, it's measured live
// (wall-clock time of each real aplay call, minus that clip's own known
// duration = pure startup overhead) and smoothed with an EMA, so it adapts
// to this specific Pi rather than a guessed constant. SFX_LOCAL_LATENCY_MS
// overrides this with a fixed value if auto-calibration isn't trusted.
const explicitLatencyEnv = process.env.SFX_LOCAL_LATENCY_MS;
const hasExplicitLatency = explicitLatencyEnv !== undefined && explicitLatencyEnv !== "" && Number.isFinite(Number(explicitLatencyEnv));
const MAX_COMPENSATION_MS = LOOKAHEAD_MS - 40; // always leave real scheduling margin
let calibratedLatencyMs = 60; // reasonable starting guess until real samples refine it

function currentLocalLatencyMs(): number {
  if (hasExplicitLatency) return clamp(Number(explicitLatencyEnv), 0, MAX_COMPENSATION_MS);
  return clamp(calibratedLatencyMs, 0, MAX_COMPENSATION_MS);
}

export function sfxStatus() {
  return {
    lookahead_ms: LOOKAHEAD_MS,
    local_latency_ms: Math.round(currentLocalLatencyMs()),
    local_latency_source: hasExplicitLatency ? "env override" : "auto-calibrated",
  };
}

export const sfxEvents = new EventEmitter();

// Failures here used to be swallowed completely — which meant "no sound
// from the headphone jack" had zero diagnosability short of SSHing in and
// guessing. Now a total failure (both aplay and paplay) logs the real
// stderr to both the journal AND the live SYSTEM LOG panel (auditEvents,
// the same channel run_shell uses), so it shows up immediately from the
// Options tab's "test sound" buttons without needing a terminal.
//
// onDone(err) fires once this single playthrough finishes — err is null on
// success (either aplay or paplay actually played it), or the failure
// detail if both did not. Used directly for one-shot events, and chained
// repeatedly by startThinkingLoop() below for a looping one.
function spawnPlay(event: SfxEvent, onDone: (err: string | null) => void): void {
  const file = SFX_FILES[event];
  if (!existsSync(file)) { onDone("missing file"); return; }
  // SFX_AUDIO_DEVICE lets you force a specific ALSA device (e.g.
  // "plughw:0,0" for the Pi's onboard analog jack) when the system default
  // routes elsewhere (HDMI is a common default even with headphones
  // plugged in) — see CLAUDE.md's SFX troubleshooting section.
  //
  // --buffer-time/--period-time (microseconds) trim ALSA's own default
  // buffering, which otherwise adds its own chunk of latency on top of the
  // spawn overhead above — 80ms/20ms is conservative enough not to risk
  // underruns on a loaded Pi while still being tighter than most drivers'
  // defaults.
  const device = process.env.SFX_AUDIO_DEVICE;
  const tuning = ["--buffer-time", "80000", "--period-time", "20000"];
  const aplayArgs = device ? ["-q", "-D", device, ...tuning, file] : ["-q", ...tuning, file];

  const spawnedAt = Date.now();
  execFile("aplay", aplayArgs, (aplayErr, _out, aplayStderr) => {
    if (!aplayErr) {
      if (!hasExplicitLatency) {
        const wallMs = Date.now() - spawnedAt;
        const overhead = clamp(wallMs - SFX_DURATIONS_MS[event], 0, 400);
        calibratedLatencyMs = calibratedLatencyMs * 0.6 + overhead * 0.4;
      }
      onDone(null);
      return;
    }
    // paplay needs a reachable PulseAudio user socket — which a systemd
    // service doesn't get for free, since it isn't part of a graphical
    // login session and so has no XDG_RUNTIME_DIR set. Best-guess the
    // standard path (/run/user/<uid>) rather than letting this fallback be
    // dead on arrival for every systemd-run install.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : "") };
    execFile("paplay", [file], { env }, (paErr, _po, paStderr) => {
      if (!paErr) { onDone(null); return; }
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
      onDone(detail);
    });
  });
}

// "thinking" is the one looping sound — soft ambient hum for as long as a
// turn is actually doing tool work, not a single blip, since that can go on
// for several rounds of browsing/research. Implemented as a respawn chain
// (play the loop unit, and the instant it finishes, play it again) rather
// than relying on any --loop flag aplay may or may not support — simple,
// portable, and any tiny gap between repetitions is inaudible for a soft
// ambient texture like this (unlike a tight music loop). Stops itself if
// playback ever actually fails, rather than spamming retries forever.
let thinkingActive = false;

function startThinkingLoop(): void {
  if (thinkingActive) return;
  thinkingActive = true;
  const tick = () => {
    if (!thinkingActive) return;
    spawnPlay("thinking", (err) => {
      if (err) { thinkingActive = false; return; }
      if (thinkingActive) tick();
    });
  };
  tick();
}

export function stopThinkingLoop(): void {
  thinkingActive = false;
}

// Triggers a status sound: broadcasts playAt for any listening browser to
// schedule itself against (see /ws/sfx in server.ts), and schedules the
// Pi's own local playback *compensated* for its measured startup overhead
// so the two land together instead of the Pi trailing behind. Any event
// other than "thinking" stops a currently-running thinking loop first —
// the natural end of a turn (success/error) is what should silence it, and
// that doesn't need lookahead precision the way audible sync does.
export function triggerSfx(event: SfxEvent): void {
  if (event !== "thinking") stopThinkingLoop();
  const playAt = Date.now() + LOOKAHEAD_MS;
  sfxEvents.emit("play", { event, play_at: playAt });
  const execAt = playAt - currentLocalLatencyMs();
  const delay = Math.max(0, execAt - Date.now());
  setTimeout(() => {
    if (event === "thinking") startThinkingLoop();
    else spawnPlay(event, () => {});
  }, delay);
}
