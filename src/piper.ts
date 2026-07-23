// Local, offline text-to-speech via Piper (https://github.com/OHF-Voice/piper1-gpl)
// — a fast neural TTS engine that runs entirely on this Pi: no cloud call, no
// API key, no per-request network round trip, and no CDN dependency in the
// frontend. This replaces two prior attempts in order: Gemini's Interactions
// API (a hosted call, and a key-gated one — see git history for the request-
// shape breakage that cost real debugging time once already), then Puter.js
// (dropped because puter.ai.txt2speech() only runs inside a browser page —
// it authenticates its own anonymous session client-side and has no stable
// server API, so Telegram's voice replies, which are server-side only,
// couldn't use it at all). Piper unifies both channels behind one local
// engine again, the same way it was before Gemini.
//
// A single long-lived `python3 -m piper.http_server` process is kept
// resident for the life of the daemon — same reasoning as browser.ts's one
// long-lived Chromium instance: the Python interpreter + onnxruntime import
// + model load cost real, noticeable time on a Pi 4B, so that cost is paid
// once here rather than on every single reply. install.sh installs the
// `piper-tts[http]` package and downloads DEFAULT_VOICE into
// ~/.caden/piper-voices ahead of time; this module only starts the server
// and talks to it over loopback HTTP — it never touches the network beyond
// 127.0.0.1.
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";

const HOST = "127.0.0.1";
const PORT = 5051;
const DATA_DIR = path.join(os.homedir(), ".caden", "piper-voices");
// install.sh creates a dedicated venv for Piper (Raspberry Pi OS Bookworm's
// system Python refuses a plain pip install per PEP 668) — this is that
// venv's interpreter, not whatever "python3" happens to resolve to on PATH,
// so this doesn't depend on the piper-tts package being importable from
// wherever the daemon's shell environment happens to point.
const PYTHON_BIN = path.join(os.homedir(), ".caden", "piper-venv", "bin", "python3");

// en_US-ryan-medium: a deep, clear, well-regarded Piper voice — deliberately
// not one of the ubiquitous Google/AWS assistant voices. "medium" quality is
// the speed/quality balance point that still runs comfortably on a Pi 4B;
// the "high" tier models are several times larger and can take multiple
// seconds per reply on this hardware, which defeats the point. Override via
// PIPER_VOICE (must already be downloaded into DATA_DIR — this module
// doesn't fetch voices on the fly).
const DEFAULT_VOICE = "en_US-ryan-medium";

// Pushed down from Piper's natural defaults (~0.667 noise_scale, ~0.8
// noise_w_scale, 1.0 length_scale) for a flatter, steadier read — this is
// what actually produces "monotone, soft-spoken, clear" rather than Piper's
// normal expressive delivery. length_scale >1 slows the pace slightly for
// the "soft-spoken" half of that; noise_scale/noise_w_scale near 0 flatten
// pitch and phoneme-duration variance for "monotone".
const DEFAULT_LENGTH_SCALE = 1.15;
const DEFAULT_NOISE_SCALE = 0.3;
const DEFAULT_NOISE_W_SCALE = 0.3;

// Read lazily (not as module-level constants) — env.ts's loadDotEnvIfNeeded()
// runs after this module is first imported (index.ts imports server.ts,
// which imports this, before it calls loadDotEnvIfPresent()), so a
// top-level `process.env.PIPER_VOICE` read here would always see the
// pre-.env value in dev. Reading inside functions, at call time, is the same
// pattern the old Gemini-backed synthesizeSpeech used for GEMINI_TTS_VOICE.
function getVoice(): string {
  return process.env.PIPER_VOICE || DEFAULT_VOICE;
}
function getSynthesisParams() {
  return {
    length_scale: Number(process.env.PIPER_LENGTH_SCALE) || DEFAULT_LENGTH_SCALE,
    noise_scale: process.env.PIPER_NOISE_SCALE !== undefined ? Number(process.env.PIPER_NOISE_SCALE) : DEFAULT_NOISE_SCALE,
    noise_w_scale: process.env.PIPER_NOISE_W_SCALE !== undefined ? Number(process.env.PIPER_NOISE_W_SCALE) : DEFAULT_NOISE_W_SCALE,
  };
}

const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 300;

let serverProcess: ChildProcess | null = null;
let readyPromise: Promise<void> | null = null;

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYTHON_BIN,
      ["-m", "piper.http_server", "-m", getVoice(), "--data-dir", DATA_DIR, "--host", HOST, "--port", String(PORT)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    serverProcess = proc;
    let settled = false;

    // Piper logs its own startup/readiness lines to stderr; forwarding them
    // means a real failure (missing model, port in use) shows up in the
    // System Log immediately rather than only surfacing as a opaque timeout.
    proc.stderr?.on("data", (chunk) => console.error(`[piper] ${String(chunk).trim()}`));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === "ENOENT") {
        reject(new Error(`piper venv not found at ${PYTHON_BIN} — run scripts/install.sh to set up local TTS`));
      } else {
        reject(err);
      }
    });
    proc.on("exit", (code) => {
      serverProcess = null;
      readyPromise = null; // let the next synthesizeSpeech() call respawn it
      if (!settled) { settled = true; reject(new Error(`piper server exited (code ${code}) before becoming ready`)); }
      else if (code !== 0) console.error(`[piper] server exited unexpectedly (code ${code})`);
    });

    // Poll /info rather than trusting a fixed delay — cold-start time varies
    // with whatever else the Pi is doing (a browser tool call, self-update
    // rebuild) at the same moment.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const poll = async () => {
      if (settled) return;
      try {
        const resp = await fetch(`http://${HOST}:${PORT}/info`);
        if (resp.ok) { settled = true; resolve(); return; }
      } catch { /* not up yet */ }
      if (Date.now() > deadline) { settled = true; reject(new Error("piper server did not become ready in time")); return; }
      setTimeout(poll, READY_POLL_MS);
    };
    setTimeout(poll, READY_POLL_MS);
  });
}

function ensureServer(): Promise<void> {
  if (!readyPromise) readyPromise = startServer();
  return readyPromise;
}

// Kill the resident server on the way out so self-update's process.exit(0)
// (update.ts) doesn't leave an orphaned Python process behind on every
// restart — self-update happens often enough that this would otherwise
// accumulate real memory pressure on a 4GB Pi over time.
function killPiperServer() {
  if (serverProcess) { try { serverProcess.kill(); } catch { /* already gone */ } }
}
// "exit" alone covers self-update's process.exit(0) path, but nothing else
// in this codebase listens for SIGTERM/SIGINT — registering a bare listener
// for those would silently replace Node's default "terminate immediately"
// behavior with "do nothing," leaving systemctl stop/restart hanging until
// SIGKILL. Explicitly exiting after cleanup keeps that default behavior
// intact instead of just adding a side effect to it.
process.on("exit", killPiperServer);
process.on("SIGTERM", () => { killPiperServer(); process.exit(0); });
process.on("SIGINT", () => { killPiperServer(); process.exit(0); });

// Drop-in replacement for the old Gemini-backed synthesizeSpeech: same
// signature, same WAV-bytes return, used identically by /api/tts
// (server.ts) and Telegram's sendVoiceReply (telegram.ts). No fallback
// provider on failure — this is the only TTS path now, so a failure just
// surfaces as "couldn't speak that" to whoever's waiting on it, same as
// before.
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  await ensureServer();
  // Same mispronunciation fix carried by every prior TTS path ("Caden" read
  // as "CAD-en" by cruder engines) — cheap insurance, and Piper's phonemizer
  // is no exception to needing it.
  const spoken = text.replace(/\bcaden\b/gi, "Kayden");
  const resp = await fetch(`http://${HOST}:${PORT}/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: spoken, voice: getVoice(), ...getSynthesisParams() }),
  });
  if (!resp.ok) throw new Error(`piper tts error ${resp.status}: ${await resp.text()}`);
  // Piper's HTTP API already returns a proper WAV file (unlike Gemini's
  // headerless PCM), so no pcmToWav-style wrapping is needed here.
  return Buffer.from(await resp.arrayBuffer());
}
