import { melSpectrum, buildExample, isExample, dtw, FRAME_MS } from './sound-features.mjs';

const QUIET_MS = 100;
const MAX_CUE_MS = 1250;
const RECORD_LEAD_IN_MS = 450;
const TAKE_PAUSE_MS = 600;
const RECORD_TIMEOUT_MS = 7000;
const COOLDOWN_MS = 500;
export const MIN_TAKES = 3;
export const MAX_TAKES = 5;
// A percussive cue (a clap) decays smoothly, so how long it stays above a fixed floor depends on how loud it was.
// Segment ends and the fingerprint therefore use a level relative to the segment's own peak.
const TAIL_RATIO = 0.1;
// Cues shorter than this count as equally short: at a 25 ms frame rate one frame more or less is not a different cue.
const MIN_COMPARED_MS = 120;
// A bump this close to the effective threshold, but not over it, is reported as "heard, below the threshold".
const NEAR_THRESHOLD_RATIO = 0.7;
const FAINT_RATIO = 0.3;
const FAINT_RISE = 2.5;
const FAINT_HISTORY = 6;
const CALM_AFTER_LONG_MS = 2000;

// Distance added per unit of |ln(length ratio)|: DTW forgives timing, but a sound twice as long is a different sound.
const DURATION_WEIGHT = 0.25;
// The acceptance threshold is learned from how much the user's own takes differ from each other.
const SPREAD_FACTOR = 2;
const THRESHOLD_MARGIN = 0.03;
const MIN_THRESHOLD = 0.06;
const MAX_THRESHOLD = 0.25;
// Takes that differ more than this are not repetitions of one sound.
const MAX_SPREAD = 0.15;
const MAX_REACH = 0.3;
const NAME_PATTERN = /^[a-z0-9_-]{1,24}$/;
const MAX_LABEL = 40;
const MAX_RETIRED = 200;

/** `/yh/cue/<name>`: the address a recognised cue is sent on. */
export const cueAddress = name => `/yh/cue/${name}`;

/** A bridge-safe cue name from free text, unique among `taken`. */
export function cueSlug(raw, taken = []) {
  const base = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'cue';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

/** True when the typed text is itself a usable address (`door`), i.e. the user chose it rather than the tool. */
export const isExplicitAddress = typed => {
  const text = String(typed ?? '').trim();
  return text !== '' && cueSlug(text) === text.toLowerCase();
};

/**
 * Decides which cue a typed name means. Typing the name or label of an existing cue replaces it;
 * any other text gets its own address (a Chinese label like 拍手 cannot be an address, so it becomes
 * `cue`, `cue-2`, ... and is kept as the label), so two different names never overwrite each other.
 */
export function resolveCueName(typed, cues = [], retired = []) {
  const text = String(typed ?? '').trim();
  const existing = text && cues.find(cue => cue.name === text.toLowerCase() || cue.label === text);
  if (existing) return { name: existing.name, label: existing.label ?? null, replaces: existing.name };
  const current = cues.map(cue => cue.name);
  // Typing an address outright (`door`) is a deliberate choice and may reuse a deleted one; an address
  // the tool assigns itself (`cue`, `cue-2`, ...) never recycles one that a scene may still listen on.
  const explicit = isExplicitAddress(text);
  const name = cueSlug(text || 'cue', explicit ? current : [...current, ...retired]);
  return { name, label: text && text !== name ? text.slice(0, MAX_LABEL) : null, replaces: null };
}

function pairDistance(first, second) {
  const ratio = Math.max(first.duration, MIN_COMPARED_MS) / Math.max(second.duration, MIN_COMPARED_MS);
  const path = dtw(first, second);
  const duration = DURATION_WEIGHT * Math.abs(Math.log(ratio));
  return { distance: path.distance + duration, shape: path.shape, level: path.level, duration };
}

function nearest(example, examples, skip = -1) {
  let best = null;
  examples.forEach((other, index) => {
    if (index === skip) return;
    const candidate = pairDistance(example, other);
    if (!best || candidate.distance < best.distance) best = candidate;
  });
  return best;
}

/**
 * `spread`: how far each take is from its closest other take, the largest of these; it sets the tolerance.
 * `reach`: the largest distance between any two takes. Closest-take distances alone let two clusters
 * (A, A, B, B) pass as one sound, so the takes must also all lie within one neighbourhood.
 */
function spreadOf(examples) {
  let spread = 0;
  let reach = 0;
  examples.forEach((example, index) => {
    let closest = Infinity;
    examples.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      const { distance } = pairDistance(example, other);
      closest = Math.min(closest, distance);
      reach = Math.max(reach, distance);
    });
    spread = Math.max(spread, closest);
  });
  return { spread, reach };
}

export function isSoundCue(cue) {
  return NAME_PATTERN.test(cue?.name ?? '') && (cue.label === undefined || (typeof cue.label === 'string' && cue.label.length > 0 && cue.label.length <= MAX_LABEL)) && Number.isFinite(cue.threshold) && cue.threshold >= MIN_THRESHOLD && cue.threshold <= MAX_THRESHOLD &&
    Array.isArray(cue.examples) && cue.examples.length >= MIN_TAKES && cue.examples.length <= MAX_TAKES &&
    cue.examples.every(example => isExample(example, MAX_CUE_MS + FRAME_MS));
}

/** Captures, learns and recognises short target sounds. Only normalized features leave this module. */
export class SoundCueDetector {
  constructor(cues = [], retired = []) {
    const names = new Set();
    this.cues = (Array.isArray(cues) ? cues : []).filter(cue => isSoundCue(cue) && !names.has(cue.name) && names.add(cue.name));
    this.retired = [...new Set((Array.isArray(retired) ? retired : []).filter(name => typeof name === 'string' && NAME_PATTERN.test(name) && !names.has(name)))].slice(-MAX_RETIRED);
    // Scales every cue's learned threshold: below 1 is stricter, above 1 more forgiving.
    this.strictness = 1;
    this.reset();
  }

  get hasCues() { return this.cues.length > 0; }

  reset() {
    this.recordAfter = null;
    this.recordUntil = null;
    this.enrollment = null;
    this.segment = null;
    this.cooldownUntil = 0;
    this.nearMiss = null;
    this.quietRms = [];
    this.calmUntil = 0;
    this.lastNearMiss = null;
    this.lastTooLong = null;
    this.lastComparison = null;
    this.lastMatch = null;
    this.lastEnrollment = null;
  }

  // Addresses of deleted cues are remembered: handing one to a different sound would make scenes that
  // still listen on it react to the new sound as if it were the old one.
  removeCue(name) {
    if (this.cues.some(cue => cue.name === name)) this.#retire([name]);
    this.cues = this.cues.filter(cue => cue.name !== name);
  }

  clearCues() {
    this.#retire(this.cues.map(cue => cue.name));
    this.cues = [];
    this.reset();
  }

  #retire(names) {
    this.retired = [...new Set([...this.retired, ...names])].slice(-MAX_RETIRED);
  }

  /** Starts recording `takes` repetitions of one sound under `name`; an existing cue of that name is replaced when it succeeds. */
  record(now, { name = 'cue', label = null, takes = MIN_TAKES } = {}) {
    this.reset();
    this.enrollment = { name, label: label ? String(label).slice(0, MAX_LABEL) : null, total: Math.min(MAX_TAKES, Math.max(MIN_TAKES, Math.round(takes))), examples: [] };
    this.recordAfter = now + RECORD_LEAD_IN_MS;
    this.recordUntil = this.recordAfter + RECORD_TIMEOUT_MS;
  }

  sample(spectrum, sampleRate, { rms, effectiveThreshold, calibrating }, now) {
    if (this.recordUntil !== null && now >= this.recordUntil) {
      this.reset();
      return 'timeout';
    }
    if (calibrating || now < this.cooldownUntil || (this.recordUntil === null && !this.hasCues)) return;
    if (this.recordAfter !== null) {
      if (now < this.recordAfter) return;
      this.recordAfter = null;
      return 'listening';
    }

    if (!this.segment) {
      // The rolling noise floor includes a long sound, so for a moment its tail would look like a near miss.
      if (rms < effectiveThreshold) return now < this.calmUntil ? undefined : this.#watchNearMiss(rms, effectiveThreshold);
      this.nearMiss = null;
      this.segment = { start: now, lastLoud: now, floor: effectiveThreshold * 0.6, peak: rms, frames: [], tooLong: false };
    }
    const segment = this.segment;
    segment.peak = Math.max(segment.peak, rms);
    // While the segment can still become a cue its end threshold stays where it began: the rolling
    // noise floor includes the segment's own sound, so following it would cut a sustained tone short
    // and report the head as a cue. Once the segment is too long to match, its result is discarded
    // anyway, so it may follow the live threshold and end even if the room never gets that quiet again.
    if (segment.tooLong) segment.floor = effectiveThreshold * 0.6;
    // A loud cue ends when it has decayed to a fraction of its own peak, not when the room's noise
    // bumps stop touching the start-time floor.
    if (rms >= Math.max(segment.floor, segment.peak * TAIL_RATIO)) {
      segment.lastLoud = now;
      if (now - segment.start > MAX_CUE_MS) segment.tooLong = true;
      if (!segment.tooLong) {
        const mel = melSpectrum(spectrum, sampleRate);
        if (mel) segment.frames.push({ mel, rms, time: now });
      }
      return;
    }
    if (now - segment.lastLoud < QUIET_MS) return;

    this.segment = null;
    if (segment.tooLong || !segment.frames.length) {
      if (this.recordUntil !== null) {
        this.reset();
        return 'invalid';
      }
      if (!segment.tooLong) return;
      this.lastTooLong = { duration: segment.lastLoud - segment.start };
      this.calmUntil = now + CALM_AFTER_LONG_MS;
      return 'toolong';
    }
    // Frames after the peak already passed the same relative test while the segment was open, so only the head can hold faint ones.
    const peak = Math.max(...segment.frames.map(frame => frame.rms));
    const example = buildExample(segment.frames.slice(segment.frames.findIndex(frame => frame.rms >= peak * TAIL_RATIO)));
    return this.recordUntil !== null ? this.#addTake(example, now) : this.#recognise(example, now);
  }

  #addTake(example, now) {
    const { name, label, total, examples } = this.enrollment;
    examples.push(example);
    if (examples.length < total) {
      this.recordAfter = now + TAKE_PAUSE_MS;
      this.recordUntil = this.recordAfter + RECORD_TIMEOUT_MS;
      return 'take';
    }
    const { spread, reach } = spreadOf(examples);
    this.reset();
    this.lastEnrollment = { name, label, takes: total, spread, reach };
    if (spread > MAX_SPREAD || reach > MAX_REACH) return 'inconsistent';
    const threshold = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, spread * SPREAD_FACTOR + THRESHOLD_MARGIN));
    // A new cue that sits inside an existing one would be recognised as that one.
    // Recognition compares against every stored take, so every take of the new cue is checked, not only the first.
    const clash = this.cues.filter(cue => cue.name !== name)
      .map(cue => ({ name: cue.name, threshold: cue.threshold, distance: Math.min(...examples.map(example => nearest(example, cue.examples).distance)) }))
      .find(other => other.distance < Math.max(other.threshold, threshold));
    this.cues = [...this.cues.filter(cue => cue.name !== name), { name, ...(label ? { label } : {}), threshold, examples }];
    this.lastEnrollment = { name, label, takes: total, spread, reach, threshold, similarTo: clash?.name ?? null };
    return 'recorded';
  }

  #recognise(example, now) {
    let best = null;
    for (const cue of this.cues) {
      const found = nearest(example, cue.examples);
      const limit = cue.threshold * this.strictness;
      const ratio = found.distance / limit;
      if (!best || ratio < best.ratio) best = { name: cue.name, label: cue.label ?? null, ...found, threshold: limit, ratio };
    }
    const dominant = Math.max(best.shape, best.level, best.duration);
    best.reason = best.ratio <= 1 ? null : dominant === best.duration ? 'duration' : dominant === best.level ? 'envelope' : 'spectrum';
    best.similarity = Math.max(0, Math.min(1, 1 - best.ratio / 2));
    best.matched = best.ratio <= 1;
    this.lastComparison = best;
    if (!best.matched) return 'unmatched';
    this.lastMatch = best;
    this.cooldownUntil = now + COOLDOWN_MS;
    return 'matched';
  }

  // A bump that came close to the threshold but never opened a segment: reported once it has passed,
  // so the page can say "heard something, below the threshold" instead of staying silent.
  // Close means 70% of the threshold, or, for a sound that stands out from the quiet just before it
  // (2.5x the recent median), 30%. Constant background below the threshold stays unreported.
  #watchNearMiss(rms, threshold) {
    const history = this.quietRms;
    const baseline = history.length >= FAINT_HISTORY ? [...history].sort((a, b) => a - b)[history.length >> 1] : null;
    const standsOut = baseline !== null && rms >= threshold * FAINT_RATIO && rms >= baseline * FAINT_RISE;
    if (rms >= threshold * NEAR_THRESHOLD_RATIO || standsOut) {
      // The threshold moves with the effective threshold, so keep the one that was in force at the peak frame.
      if (!this.nearMiss || rms > this.nearMiss.peak) this.nearMiss = { peak: rms, threshold };
      return;
    }
    history.push(rms);
    if (history.length > FAINT_HISTORY * 2) history.shift();
    if (!this.nearMiss) return;
    this.lastNearMiss = this.nearMiss;
    this.nearMiss = null;
    return 'below';
  }
}
