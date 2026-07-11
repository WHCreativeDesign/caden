// Generator for Caden's status SFX (sent/success/error) — synthesized, not
// downloaded, so there's no license/CDN dependency. Re-run after editing to
// regenerate public/sfx/*.wav: node scripts/gen-sfx.mjs public/sfx
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE_RATE = 44100;

function tone({ freq, ms, type = "sine", gain = 0.5, fadeMs = 8 }) {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const fadeN = Math.min(Math.round((fadeMs / 1000) * SAMPLE_RATE), Math.floor(n / 2));
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let v;
    if (type === "square") {
      v = Math.sign(Math.sin(2 * Math.PI * freq * t));
    } else {
      v = Math.sin(2 * Math.PI * freq * t);
    }
    // envelope: linear fade in/out to avoid clicks
    let env = 1;
    if (i < fadeN) env = i / fadeN;
    else if (i > n - fadeN) env = (n - i) / fadeN;
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
function loopableTone({ ms, carrierFreq, modFreq, gainBase, gainDepth }) {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const carrier = Math.sin(2 * Math.PI * carrierFreq * t);
    const env = gainBase + gainDepth * (0.5 + 0.5 * Math.sin(2 * Math.PI * modFreq * t));
    samples[i] = carrier * env;
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

// "sent" — a quick soft double-blip acknowledging input left the building.
const sent = concat(
  tone({ freq: 660, ms: 55, gain: 0.35 }),
  silence(18),
  tone({ freq: 880, ms: 65, gain: 0.4 }),
);

// "success" — a small resolving three-note arpeggio (C5-E5-G5).
const success = concat(
  tone({ freq: 523.25, ms: 85, gain: 0.35 }),
  silence(12),
  tone({ freq: 659.25, ms: 85, gain: 0.4 }),
  silence(12),
  tone({ freq: 783.99, ms: 140, gain: 0.42 }),
);

// "error" — two low descending square-wave tones, harsher, alert-like.
const error = concat(
  tone({ freq: 220.0, ms: 130, type: "square", gain: 0.22, fadeMs: 6 }),
  silence(16),
  tone({ freq: 146.83, ms: 200, type: "square", gain: 0.24, fadeMs: 6 }),
);

// "thinking" — a soft, slowly-breathing hum, looped for as long as a turn
// is actually doing tool work (see startThinkingLoop in sfx.ts / loop=true
// in index.html) rather than a single blip — 330Hz carrier with a gentle
// 3Hz pulse, both an exact whole number of cycles over 1 second so the loop
// point is inaudible.
const thinking = loopableTone({ ms: 1000, carrierFreq: 330, modFreq: 3, gainBase: 0.09, gainDepth: 0.05 });

// "reminder" — a warm two-tone doorbell-style chime (perfect fourth up),
// deliberately the most attention-getting sound since it fires unprompted.
const reminder = concat(
  tone({ freq: 587.33, ms: 160, gain: 0.4 }),
  silence(30),
  tone({ freq: 440.0, ms: 220, gain: 0.42 }),
);

// "startup" — a brighter four-note ascending sweep ("systems online"),
// longer and more ceremonial since it plays once per boot, not per turn.
const startup = concat(
  tone({ freq: 392.0, ms: 90, gain: 0.32 }),
  silence(10),
  tone({ freq: 523.25, ms: 90, gain: 0.34 }),
  silence(10),
  tone({ freq: 659.25, ms: 90, gain: 0.36 }),
  silence(10),
  tone({ freq: 880.0, ms: 160, gain: 0.4 }),
);

writeFileSync(join(OUT_DIR, "sent.wav"), toWav(sent));
writeFileSync(join(OUT_DIR, "success.wav"), toWav(success));
writeFileSync(join(OUT_DIR, "error.wav"), toWav(error));
writeFileSync(join(OUT_DIR, "thinking.wav"), toWav(thinking));
writeFileSync(join(OUT_DIR, "reminder.wav"), toWav(reminder));
writeFileSync(join(OUT_DIR, "startup.wav"), toWav(startup));
console.log("wrote sent/success/error/thinking/reminder/startup.wav to", OUT_DIR);
