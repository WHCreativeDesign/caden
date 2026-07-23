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

// A perfectly seamless loop unit: no fade envelope (which would leave an
// audible dip at the wrap point), and both the carrier and its amplitude
// modulator are constrained to complete a whole number of cycles within
// `ms` — so sample[0] and the sample just past the end are bit-identical to
// where the previous repetition left off. Web Audio's loop=true just plays
// the buffer back to back, so periodicity is the only thing that matters.
function loopableTone({ ms, carrierFreq, modFreq, gainBase, gainDepth, shimmerFreq, shimmerGain = 0 }) {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const carrier = Math.sin(2 * Math.PI * carrierFreq * t);
    const shimmer = shimmerGain ? Math.sin(2 * Math.PI * shimmerFreq * t) * shimmerGain : 0;
    const env = gainBase + gainDepth * (0.5 + 0.5 * Math.sin(2 * Math.PI * modFreq * t));
    samples[i] = (carrier + shimmer) * env;
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

// "thinking" — a soft, slowly-breathing hum, looped for as long as a turn
// is actually doing tool work (see startThinkingLoop in sfx.ts / loop=true
// in index.html) rather than a single blip — 330Hz carrier with a gentle
// 3Hz pulse and a very quiet fifth-above shimmer layer for warmth, all an
// exact whole number of cycles over 1 second so the loop point is inaudible.
// Deliberately NOT passed through lowpass() like the others: a causal
// filter starts from a cold (zero) internal state, so filtering a loop unit
// directly would leave sample[0] mismatched with the (steady-state
// filtered) value at the end — reintroducing exactly the audible click at
// the wrap point this loop's whole-cycle-count math was built to avoid.
// The raw tone is already soft/pure (low gain, sine-only) and doesn't need
// it anyway.
const thinking = loopableTone({ ms: 1000, carrierFreq: 330, modFreq: 3, gainBase: 0.09, gainDepth: 0.05, shimmerFreq: 495, shimmerGain: 0.02 });

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
