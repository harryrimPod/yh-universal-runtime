// Features and alignment for target-sound matching. Everything here is loudness-independent: a frame is
// described by the shape of its mel spectrum and by its level relative to the sound's own peak.
export const MEL_BANDS = 32;
const MIN_HZ = 80;
const MAX_HZ = 10000;
const SHAPE_RANGE_DB = 45;
const LEVEL_RANGE_DB = 30;
const QUANT = 100;
export const FRAME_MS = 25;

// Weight of the level difference against the spectral-shape difference in a frame distance.
const LEVEL_WEIGHT = 0.25;
// Half-width of the DTW band as a share of the longer sound: how far in time frames may be matched.
const BAND_SHARE = 0.3;
const BAND_MIN_FRAMES = 2;
// A short sound may leave out its first or last frame. An impulse near the edge of the analysis window is weighted
// down by the window, so that frame's spectrum is mostly background and says little about the sound.
const SKIP_COST = 0.2;

const mel = hz => 2595 * Math.log10(1 + hz / 700);
const unmel = value => 700 * (10 ** (value / 2595) - 1);

let filterCache = null;
function filters(binCount, sampleRate) {
  if (filterCache?.binCount === binCount && filterCache.sampleRate === sampleRate) return filterCache.bands;
  const binHz = sampleRate / (2 * binCount);
  const top = Math.min(MAX_HZ, sampleRate / 2 - binHz);
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) => unmel(mel(MIN_HZ) + (mel(top) - mel(MIN_HZ)) * i / (MEL_BANDS + 1)));
  const bands = [];
  for (let band = 0; band < MEL_BANDS; band++) {
    const [low, center, high] = [edges[band], edges[band + 1], edges[band + 2]];
    const bins = [];
    for (let bin = Math.max(1, Math.ceil(low / binHz)); bin * binHz < high && bin < binCount; bin++) {
      const f = bin * binHz;
      bins.push([bin, f < center ? (f - low) / (center - low) : (high - f) / (high - center)]);
    }
    bands.push({ bins: bins.filter(([, weight]) => weight > 0), center: center / binHz });
  }
  filterCache = { binCount, sampleRate, bands };
  return bands;
}

/** Log-mel spectrum in dB from an analyser's dB spectrum, or null for a silent frame. */
export function melSpectrum(spectrum, sampleRate) {
  const bands = filters(spectrum.length, sampleRate);
  const out = new Float64Array(MEL_BANDS);
  let loudest = -Infinity;
  for (let band = 0; band < MEL_BANDS; band++) {
    const { bins, center } = bands[band];
    let db;
    if (bins.length) {
      let power = 0;
      let weights = 0;
      for (const [bin, weight] of bins) { power += weight * 10 ** (spectrum[bin] / 10); weights += weight; }
      db = power > 0 ? 10 * Math.log10(power / weights) : -Infinity;
    } else {
      const lower = Math.floor(center);
      const share = center - lower;
      db = spectrum[lower] * (1 - share) + (spectrum[lower + 1] ?? spectrum[lower]) * share;
    }
    out[band] = db;
    if (db > loudest) loudest = db;
  }
  return Number.isFinite(loudest) ? out : null;
}

/** Unit-length spectral shape of one frame: bands within 45 dB of the frame's loudest, as amplitudes. */
export function frameShape(melDb) {
  const loudest = Math.max(...melDb);
  const weights = Array.from(melDb, db => db >= loudest - SHAPE_RANGE_DB ? 10 ** ((db - loudest) / 20) : 0);
  const norm = Math.sqrt(weights.reduce((sum, weight) => sum + weight * weight, 0));
  return weights.map(weight => weight / norm);
}

/**
 * Turns a captured segment into a stored example. Quantized to integers on purpose: what is compared
 * at match time is exactly what is saved and restored.
 */
export function buildExample(frames) {
  const peak = Math.max(...frames.map(frame => frame.rms));
  const shapes = [];
  const levels = [];
  for (const frame of frames) {
    shapes.push(frameShape(frame.mel).map(value => Math.round(value * QUANT)));
    levels.push(Math.round(QUANT * Math.max(0, 1 + 20 * Math.log10(Math.max(frame.rms, 1e-9) / peak) / LEVEL_RANGE_DB)));
  }
  return { duration: frames.at(-1).time - frames[0].time + FRAME_MS, levels, shapes };
}

export function isExample(example, maxDuration) {
  if (!Number.isFinite(example?.duration) || example.duration < FRAME_MS || example.duration > maxDuration) return false;
  const { levels, shapes } = example;
  if (!Array.isArray(levels) || !Array.isArray(shapes) || !levels.length || levels.length !== shapes.length || levels.length > maxDuration / FRAME_MS + 2) return false;
  if (!levels.every(level => Number.isInteger(level) && level >= 0 && level <= QUANT)) return false;
  return shapes.every(shape => Array.isArray(shape) && shape.length === MEL_BANDS &&
    shape.every(value => Number.isInteger(value) && value >= 0 && value <= QUANT) &&
    Math.abs(shape.reduce((sum, value) => sum + value * value, 0) / (QUANT * QUANT) - 1) < 0.05);
}

const prepared = new WeakMap();
function prepare(example) {
  let entry = prepared.get(example);
  if (!entry) {
    const unit = example.shapes.map(shape => {
      const norm = Math.sqrt(shape.reduce((sum, value) => sum + value * value, 0));
      return Float64Array.from(shape, value => value / norm);
    });
    entry = { unit, level: Float64Array.from(example.levels, level => level / QUANT) };
    prepared.set(example, entry);
  }
  return entry;
}

/**
 * Dynamic-time-warping distance between two examples, averaged over the warping path.
 * Returns the total plus how much of it came from spectral shape and from level.
 */
export function dtw(first, second) {
  const a = prepare(first);
  const b = prepare(second);
  const n = a.level.length;
  const m = b.level.length;
  // Never narrower than the length difference, or the far corner of the grid cannot be reached.
  const band = Math.max(BAND_MIN_FRAMES, Math.ceil(BAND_SHARE * Math.max(n, m)), Math.abs(n - m));
  // One or two frames carry little level information: where the 25 ms samples land on the peak decides it.
  const levelWeight = LEVEL_WEIGHT * Math.min(1, Math.min(n, m) / 8);
  const total = Array.from({ length: n }, () => new Float64Array(m).fill(Infinity));
  const shapePart = Array.from({ length: n }, () => new Float64Array(m));
  const levelPart = Array.from({ length: n }, () => new Float64Array(m));
  const position = (index, count) => count > 1 ? index / (count - 1) : 0;
  // Where the path may begin: the first frame of both, or one sound's first frame skipped (at a cost).
  const startPenalty = (i, j) => i === 0 && j === 0 ? 0 : i === 1 && j === 0 && n >= 3 ? SKIP_COST : i === 0 && j === 1 && m >= 3 ? SKIP_COST : null;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (n > 1 && m > 1 && Math.abs(position(i, n) - position(j, m)) * Math.max(n, m) > band) continue;
      let dot = 0;
      for (let k = 0; k < MEL_BANDS; k++) dot += a.unit[i][k] * b.unit[j][k];
      const shape = Math.max(0, 1 - dot);
      const level = levelWeight * Math.abs(a.level[i] - b.level[j]);
      let best = null;
      let weight = 1;
      const start = startPenalty(i, j);
      if (start !== null) best = { cost: start + 2 * (shape + level), start };
      for (const [pi, pj, w] of [[i - 1, j - 1, 2], [i - 1, j, 1], [i, j - 1, 1]]) {
        if (pi < 0 || pj < 0 || !Number.isFinite(total[pi][pj])) continue;
        const candidate = total[pi][pj] + w * (shape + level);
        if (best === null || candidate < best.cost) { best = { cost: candidate, pi, pj }; weight = w; }
      }
      if (best === null) continue;
      total[i][j] = best.cost;
      if (best.start !== undefined) {
        shapePart[i][j] = best.start + 2 * shape;
        levelPart[i][j] = 2 * level;
      } else {
        shapePart[i][j] = shapePart[best.pi][best.pj] + weight * shape;
        levelPart[i][j] = levelPart[best.pi][best.pj] + weight * level;
      }
    }
  }
  let end = null;
  for (const [i, j, penalty] of [[n - 1, m - 1, 0], [n - 2, m - 1, SKIP_COST], [n - 1, m - 2, SKIP_COST]]) {
    if (i < 0 || j < 0 || (penalty && ((i < n - 1 && n < 3) || (j < m - 1 && m < 3))) || !Number.isFinite(total[i][j])) continue;
    if (end === null || total[i][j] + penalty < end.cost) end = { i, j, penalty, cost: total[i][j] + penalty };
  }
  const norm = n + m;
  return { distance: end.cost / norm, shape: (shapePart[end.i][end.j] + end.penalty) / norm, level: levelPart[end.i][end.j] / norm };
}
