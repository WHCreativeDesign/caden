// Generator for Caden's status SFX — synthesized, not downloaded, so there's
// no license/CDN dependency. Re-run after editing to regenerate
// public/sfx/*.wav: node scripts/gen-sfx.mjs public/sfx
//
// Sound language: soft filtered sine glides and layered shimmer tones —
// the modern-AI-assistant register (think Siri/Meta AI's product chimes:
// smooth pitch sweeps, glassy overtones, exponential envelopes) rather than
// the earlier chiptune-style discrete square-wave notes. No hard edges
// anywhere: every tone is built from phase-accumulated sine glides (so
// pitch actually curves smoothly instead of jump-cutting between fixed
// notes) and passed through a one-pole lowpass at the end to round off any
// residual digital harshness.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE_RATE = 44100;

// A single continuous tone whose pitch glides from freqFrom to freqTo (both
// equal for a flat tone) using phase accumulation — integrating
// instantaneous frequency into phase sample-by-sample, not just plugging a
// time-varying frequency into sin(2*pi*f*t), which would distort the sweep.
// This is what actually makes a glide sound smooth and "filtered" rather
// than like a series of tiny pitch jumps. envelope is "exp" (soft, rounded
// attack/release — the modern-assistant character) or "linear".
function glideTone({ freqFrom, freqTo, ms, gain = 0.4, envelope = "exp", shimmer = 0 }) {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const samples = new Float64Array(n);
  let phase = 0;
  let shimmerPhase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n; // 0..1 through this tone
    const freq = freqFrom + (freqTo - freqFrom) * t;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    shimmerPhase += (2 * Math.PI * freq * 2) / SAMPLE_RATE; // a quiet octave-up layer for glassy warmth
    const v = Math.sin(phase) + shimmer * Math.sin(shimmerPhase);
    // Exponential-ish envelope (soft attack, gentle rounded release) reads
    // as "filtered/premium" — a plain linear ramp is what made the old
    // square-wave tones feel blippy/retro.
    let env;
    if (envelope === "exp") {
      const attack = Math.min(1, t / 0.12);
      const release = Math.min(1, (1 - t) / 0.35);
      env = Math.pow(attack, 1.5) * Math.pow(release, 0.8);
    } else {
      const fadeT = 0.08;
      env = Math.min(1, t / fadeT, (1 - t) / fadeT);
    }
    samples[i] = v * gain * env;
  }
  return samples;
}

function silence(ms) {
  return new Float64Array(Math.round((ms / 1000) * SAMPLE_RATE));
}

// A soft, light plucked/bell note — quick attack, exponential decay, a
// quiet octave-up shimmer for a touch of bell-like ring. Unlike glideTone
// (built for one continuous sweep), this is for short discrete notes in a
// rhythmic sequence — the "hold music" register (see `thinking` below)
// rather than one smooth whoosh. A hard linear release is layered on top
// of the exponential decay for the note's last releaseMs regardless of how
// far the exponential itself has decayed by then — this guarantees the
// note reaches exact silence at its own end, which matters here because
// notes are concatenated with real silence() between them: without the
// forced release, an exponential tail still audible at cutoff would click.
function pluckTone({ freq, ms, gain = 0.3, shimmer = 0.15, attackMs = 10, decayRate = 9, releaseMs = 14 }) {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const attackN = Math.max(1, Math.round((attackMs / 1000) * SAMPLE_RATE));
  const releaseN = Math.min(Math.round((releaseMs / 1000) * SAMPLE_RATE), n - attackN);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const v = Math.sin(2 * Math.PI * freq * t) + shimmer * Math.sin(2 * Math.PI * freq * 2 * t);
    let env = i < attackN ? i / attackN : Math.exp(-decayRate * ((i - attackN) / SAMPLE_RATE));
    if (releaseN > 0 && i > n - releaseN) env *= Math.max(0, (n - i) / releaseN);
    samples[i] = v * gain * env;
  }
  return samples;
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float64Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// One-pole lowpass, applied last — softens any remaining stair-stepped
// digital edge into the smooth, slightly "muffled-premium" character
// modern assistant chimes have, instead of a fully bright/raw synth tone.
function lowpass(samples, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SAMPLE_RATE;
  const alpha = dt / (rc + dt);
  const out = new Float64Array(samples.length);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    prev = prev + alpha * (samples[i] - prev);
    out[i] = prev;
  }
  return out;
}

function toWav(samples) {
  const n = samples.length;
  const dataSize = n * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    let v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const OUT_DIR = process.argv[2] || ".";

// "sent" — a quick soft upward whoosh-blip (one continuous glide, not two
// discrete notes) — a message leaving, in one breath.
const sent = lowpass(
  glideTone({ freqFrom: 520, freqTo: 920, ms: 130, gain: 0.34, shimmer: 0.12 }),
  6000,
);

// "success" — a smooth rising glide with a touch of glassy shimmer,
// replacing the old three-note chiptune arpeggio with one continuous
// affirming sweep — the modern-assistant "mm, done" register.
const success = lowpass(
  concat(
    glideTone({ freqFrom: 523.25, freqTo: 659.25, ms: 150, gain: 0.32, shimmer: 0.15 }),
    silence(8),
    glideTone({ freqFrom: 659.25, freqTo: 987.77, ms: 190, gain: 0.36, shimmer: 0.18 }),
  ),
  7200,
);

// "error" — a soft, low downward glide — still clearly "something's off"
// via the falling pitch and a mild shimmer-beat dissonance, but filtered
// and rounded rather than the harsh square-wave alarm this replaced.
const error = lowpass(
  concat(
    glideTone({ freqFrom: 330, freqTo: 233, ms: 170, gain: 0.3, shimmer: 0.22 }),
    silence(14),
    glideTone({ freqFrom: 220, freqTo: 155, ms: 230, gain: 0.32, shimmer: 0.22 }),
  ),
  3200,
);

// "thinking" — soft call-hold-style loading music, looped for as long as a
// turn is actually doing tool work (see startThinkingLoop in sfx.ts /
// loop=true in index.html): three soft repeated notes then a quick
// two-note "flourish that resolves" — bum, bum, bum, ba-dum — the register
// of a phone system's hold/transfer jingle, light and unobtrusive rather
// than a continuous ambient hum (the previous design). Seamlessness here
// comes from silence, not exact waveform periodicity: every pluckTone()
// note has a forced release to true zero at its own end (see pluckTone),
// and the loop closes with ~450ms of real silence before it repeats — as
// long as both the tail and the next attack start from actual 0, the wrap
// is inaudible regardless of what's musically happening in between, which
// is what makes a discrete rhythmic phrase loop cleanly (a continuous hum
// needs the whole-cycle-count trick instead; a plucked phrase with real
// rests between notes doesn't). This is also why, unlike the previous
// design, this one CAN safely go through lowpass() like the other five:
// the cold-start transient that made filtering unsafe for a continuous
// loop is inaudible here because the signal itself is already at/near
// silence at both the start and end of the buffer, so the filter's state
// has fully settled to ~0 by the time the tail silence ends.
const thinking = lowpass(
  concat(
    pluckTone({ freq: 220.0, ms: 140, gain: 0.16, shimmer: 0.16 }), // bum
    silence(100),
    pluckTone({ freq: 220.0, ms: 140, gain: 0.16, shimmer: 0.16 }), // bum
    silence(100),
    pluckTone({ freq: 220.0, ms: 140, gain: 0.16, shimmer: 0.16 }), // bum
    silence(80),
    pluckTone({ freq: 277.18, ms: 90, gain: 0.14, shimmer: 0.18, decayRate: 14 }), // ba
    silence(15),
    pluckTone({ freq: 220.0, ms: 240, gain: 0.18, shimmer: 0.16 }), // dum (settles)
    silence(455), // rest before the phrase repeats
  ),
  4500,
);

// "reminder" — a warm two-tone glide (perfect fourth up), deliberately the
// most attention-getting sound since it fires unprompted — kept brighter
// and less filtered than the others so it still cuts through.
const reminder = lowpass(
  concat(
    glideTone({ freqFrom: 587.33, freqTo: 587.33, ms: 170, gain: 0.38, shimmer: 0.2 }),
    silence(26),
    glideTone({ freqFrom: 440, freqTo: 440, ms: 240, gain: 0.4, shimmer: 0.2 }),
  ),
  8000,
);

// "startup" — one continuous rising swell ("systems coming online") instead
// of four discrete chiptune notes — longer and more ceremonial since it
// plays once per boot, not per turn, with shimmer building through the
// sweep for a sense of things "waking up".
const startup = lowpass(
  concat(
    glideTone({ freqFrom: 261.63, freqTo: 392.0, ms: 140, gain: 0.28, shimmer: 0.1 }),
    glideTone({ freqFrom: 392.0, freqTo: 587.33, ms: 140, gain: 0.32, shimmer: 0.16 }),
    glideTone({ freqFrom: 587.33, freqTo: 987.77, ms: 220, gain: 0.38, shimmer: 0.24 }),
  ),
  7500,
);

writeFileSync(join(OUT_DIR, "sent.wav"), toWav(sent));
writeFileSync(join(OUT_DIR, "success.wav"), toWav(success));
writeFileSync(join(OUT_DIR, "error.wav"), toWav(error));
writeFileSync(join(OUT_DIR, "thinking.wav"), toWav(thinking));
writeFileSync(join(OUT_DIR, "reminder.wav"), toWav(reminder));
writeFileSync(join(OUT_DIR, "startup.wav"), toWav(startup));
console.log("wrote sent/success/error/thinking/reminder/startup.wav to", OUT_DIR);
