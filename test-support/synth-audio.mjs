// Synthetic audio for the sound-cue tests. Signals are rendered to samples, then analysed the way the
// browser's AnalyserNode feeds the page (2048-sample window every 25 ms, Hann window, 0.5 smoothing,
// dB magnitude), so the detector is exercised on real FFT frames and not on hand-built spectra.
// Kept outside test/ because `node --test` would execute every file under it.
import fs from 'node:fs';

export const RATE = 48000;
const WINDOW = 2048;
const HOP = RATE * 0.025;
const SMOOTHING = 0.5;

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function maxAbs(samples) {
  let max = 0;
  for (const value of samples) max = Math.max(max, Math.abs(value));
  return max;
}

const normalized = (samples, peak) => {
  const scale = peak / (maxAbs(samples) || 1);
  return samples.map(value => value * scale);
};

/** A hand clap: high-passed noise with a fast decay, an optional flam and a short room tail. */
export function clap(seed, peak = 0.5) {
  const rand = rng(seed);
  const tau = 0.004 + rand() * 0.008;
  const tail = 0.03 + rand() * 0.05;
  const flamAt = rand() < 0.5 ? 0.006 + rand() * 0.012 : null;
  const out = new Float32Array(Math.floor(RATE * 0.22));
  const cutoff = 0.02 + rand() * 0.05;
  let low = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const noise = rand() * 2 - 1;
    low += (noise - low) * cutoff;
    let envelope = t < 0.0005 ? t / 0.0005 : Math.exp(-(t - 0.0005) / tau);
    if (flamAt !== null && t > flamAt) envelope += 0.6 * Math.exp(-(t - flamAt) / tau);
    envelope += 0.12 * Math.exp(-t / tail);
    out[i] = (noise - low) * envelope;
  }
  return normalized(out, peak);
}

export function tone(hz, seconds, peak = 0.4) {
  const length = Math.floor(RATE * seconds);
  return Float32Array.from({ length }, (_, i) => peak * Math.sin(2 * Math.PI * hz * i / RATE) * Math.min(1, i / 480, (length - i) / 480));
}

/** Two notes in a row; the order is part of the sound. */
export function twoNotes(first, second, noteSeconds = 0.14, peak = 0.4) {
  const a = tone(first, noteSeconds, peak);
  const b = tone(second, noteSeconds, peak);
  return Float32Array.from([...a, ...b]);
}

export function sweep(fromHz, toHz, seconds = 0.2, peak = 0.4) {
  const length = Math.floor(RATE * seconds);
  let phase = 0;
  return Float32Array.from({ length }, (_, i) => {
    phase += 2 * Math.PI * (fromHz + (toHz - fromHz) * i / length) / RATE;
    return peak * Math.sin(phase) * Math.min(1, i / 480, (length - i) / 480);
  });
}

/** Voiced syllables: glottal harmonics under moving formants, about 1.2 seconds. Not real speech. */
export function speech(seed, peak = 0.25, syllables = [0.18, 0.2, 0.25, 0.15, 0.22, 0.2]) {
  const rand = rng(seed);
  const f0 = 110 + rand() * 80;
  const total = syllables.reduce((sum, length) => sum + length, 0);
  const out = new Float32Array(Math.floor(RATE * total));
  let start = 0;
  for (const length of syllables) {
    const f1 = 400 + rand() * 500;
    const f2 = 1200 + rand() * 1200;
    const from = Math.floor(start * RATE);
    const to = Math.min(out.length, Math.floor((start + length * 0.8) * RATE));
    for (let i = from; i < to; i++) {
      const envelope = Math.sin(Math.PI * (i - from) / (to - from)) ** 1.5;
      let value = 0;
      for (let h = 1; h * f0 < 4000; h++) {
        const f = h * f0;
        value += Math.sin(2 * Math.PI * f * i / RATE) * (Math.exp(-(((f - f1) / 250) ** 2)) + 0.6 * Math.exp(-(((f - f2) / 400) ** 2)) + 0.05);
      }
      out[i] = value * envelope;
    }
    start += length;
  }
  return normalized(out, peak);
}

/** Slowly swelling low-passed noise, a stand-in for a room or a crowd. */
export function noise(seconds, rms, seed = 7, swell = 0) {
  const rand = rng(seed);
  const length = Math.floor(RATE * seconds);
  const out = new Float32Array(length);
  let low = 0;
  for (let i = 0; i < length; i++) {
    low += ((rand() * 2 - 1) - low) * 0.05;
    out[i] = low;
  }
  let power = 0;
  for (const value of out) power += value * value;
  const gain = rms / Math.sqrt(power / length);
  return out.map((value, i) => value * gain * (1 + swell * Math.sin(2 * Math.PI * 3.1 * i / RATE)));
}

export function scaled(samples, gain) {
  return samples.map(value => value * gain);
}

/** Reads a 16-bit mono PCM WAV and resamples it to RATE. */
export function readWav(file) {
  const bytes = fs.readFileSync(file);
  const sourceRate = bytes.readUInt32LE(24);
  const count = (bytes.length - 44) / 2;
  const source = Float32Array.from({ length: count }, (_, i) => bytes.readInt16LE(44 + i * 2) / 32768);
  const length = Math.floor(count * RATE / sourceRate);
  return Float32Array.from({ length }, (_, i) => {
    const position = i * sourceRate / RATE;
    const index = Math.floor(position);
    return source[index] + ((source[index + 1] ?? source[index]) - source[index]) * (position - index);
  });
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

const hann = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WINDOW));

/** The frames the page would see: one every 25 ms (give or take `jitterMs`, as a busy timer does), starting `phaseMs` into the stream. */
export function* analyse(signal, phaseMs = 0, jitterMs = 0, seed = 1) {
  const random = rng(seed);
  const smoothed = new Float64Array(WINDOW / 2);
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  for (let end = WINDOW + Math.floor(phaseMs * RATE / 1000); end <= signal.length; end += Math.round(HOP + (random() * 2 - 1) * jitterMs * RATE / 1000)) {
    let power = 0;
    for (let i = 0; i < WINDOW; i++) {
      const value = signal[end - WINDOW + i];
      power += value * value;
      re[i] = value * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    const spectrum = new Float32Array(WINDOW / 2);
    for (let bin = 0; bin < WINDOW / 2; bin++) {
      smoothed[bin] = SMOOTHING * smoothed[bin] + (1 - SMOOTHING) * Math.hypot(re[bin], im[bin]) / WINDOW;
      spectrum[bin] = 20 * Math.log10(Math.max(smoothed[bin], 1e-10));
    }
    yield { time: Math.round(end / RATE * 1000), rms: Math.sqrt(power / WINDOW), spectrum };
  }
}

/**
 * Plays a scenario through a detector. parts: [{ at (s), samples }], actions: [{ at (s), run(detector, ms) }].
 * `meter(rms, ms)` may replace the fixed-threshold meter, for example with a real OnsetGate.
 * Returns every detector result that is not undefined, with the stream time it arrived at.
 */
export function play(detector, { total, parts = [], actions = [], noiseRms = 0.002, effectiveThreshold = 0.005, phaseMs = 0, jitterMs = 0, seed = 7, meter = null }) {
  const mix = noise(total, noiseRms, seed);
  for (const { at, samples } of parts) {
    const start = Math.floor(at * RATE);
    for (let i = 0; i < samples.length && start + i < mix.length; i++) mix[start + i] += samples[i];
  }
  const pending = [...actions].sort((a, b) => a.at - b.at);
  const results = [];
  for (const frame of analyse(mix, phaseMs, jitterMs, seed)) {
    while (pending.length && pending[0].at * 1000 <= frame.time) pending.shift().run(detector, frame.time);
    const result = detector.sample(frame.spectrum, RATE, meter ? meter(frame.rms, frame.time) : { rms: frame.rms, effectiveThreshold, calibrating: false }, frame.time);
    if (result !== undefined) {
      const { lastComparison, lastMatch, lastEnrollment, lastNearMiss } = detector;
      results.push({ time: frame.time, result, comparison: lastComparison, match: lastMatch, enrollment: lastEnrollment, nearMiss: lastNearMiss });
    }
  }
  return results;
}
