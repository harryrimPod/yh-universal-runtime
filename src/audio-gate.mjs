export const DEFAULT_RMS_THRESHOLD = 0.01;
export const RMS_REARM_RATIO = 0.65;
export const ONSET_REFRACTORY_MS = 180;
export const ONSET_REARM_QUIET_MS = 100;
export const DEFAULT_NOISE_CALIBRATION_MS = 1200;
export const NOISE_FLOOR_WINDOW_MS = 1200;
export const NOISE_TRIGGER_MULTIPLIER = 2.5;
export const NOISE_REARM_MULTIPLIER = 1.2;
export const LEVEL_FULL_SCALE_RMS = 0.25;

export function correctedRms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = Number(samples[index]);
    if (Number.isFinite(value)) sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function normalizeRms(rms, fullScaleRms = LEVEL_FULL_SCALE_RMS) {
  const value = Number(rms);
  const fullScale = Number(fullScaleRms);
  if (!Number.isFinite(value) || !Number.isFinite(fullScale) || fullScale <= 0) return 0;
  return Math.max(0, Math.min(1, value / fullScale));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class OnsetGate {
  constructor({
    threshold = DEFAULT_RMS_THRESHOLD,
    rearmRatio = RMS_REARM_RATIO,
    refractoryMs = ONSET_REFRACTORY_MS,
    rearmQuietMs = ONSET_REARM_QUIET_MS,
    calibrationMs = DEFAULT_NOISE_CALIBRATION_MS,
    noiseWindowMs = NOISE_FLOOR_WINDOW_MS,
    noiseMultiplier = NOISE_TRIGGER_MULTIPLIER,
    noiseRearmMultiplier = NOISE_REARM_MULTIPLIER,
  } = {}) {
    this.threshold = DEFAULT_RMS_THRESHOLD;
    this.setThreshold(threshold);
    this.rearmRatio = rearmRatio;
    this.refractoryMs = refractoryMs;
    this.rearmQuietMs = Math.max(0, Number(rearmQuietMs) || 0);
    this.calibrationMs = Math.max(0, Number(calibrationMs) || 0);
    this.noiseWindowMs = Math.max(1, Number(noiseWindowMs) || NOISE_FLOOR_WINDOW_MS);
    this.noiseMultiplier = Math.max(1, Number(noiseMultiplier) || NOISE_TRIGGER_MULTIPLIER);
    this.noiseRearmMultiplier = Math.max(1, Number(noiseRearmMultiplier) || NOISE_REARM_MULTIPLIER);
    this.reset();
  }

  reset() {
    this.armed = true;
    this.lastOnsetAt = -Infinity;
    this.quietSinceAt = null;
    this.calibrationStartedAt = null;
    this.calibrationSamples = [];
    this.noiseHistory = [];
    this.noiseFloor = null;
  }

  setThreshold(value) {
    const threshold = Number(value);
    if (!Number.isFinite(threshold)) return;
    this.threshold = Math.max(0.001, Math.min(0.05, threshold));
  }

  process(samples, nowMs = performance.now()) {
    return this.processRms(correctedRms(samples), nowMs);
  }

  /** Same state machine for sources that already deliver an RMS-like amplitude. */
  processRms(rmsValue, nowMs = performance.now()) {
    const rms = Number.isFinite(Number(rmsValue)) ? Math.max(0, Number(rmsValue)) : 0;
    const time = Number.isFinite(Number(nowMs)) ? Number(nowMs) : performance.now();
    this.noiseHistory.push({ time, rms });
    const historyStart = time - this.noiseWindowMs;
    while (this.noiseHistory.length && this.noiseHistory[0].time < historyStart) this.noiseHistory.shift();

    if (this.noiseFloor === null) {
      if (this.calibrationStartedAt === null) this.calibrationStartedAt = time;
      this.calibrationSamples.push(rms);
      if (time - this.calibrationStartedAt < this.calibrationMs) {
        return { rms, level: normalizeRms(rms), onset: false, noiseFloor: 0, effectiveThreshold: this.threshold, calibrating: true };
      }
      this.noiseFloor = median(this.calibrationSamples);
      this.calibrationSamples = [];
      const effectiveThreshold = this.#effectiveThreshold();
      return { rms, level: normalizeRms(rms), onset: false, noiseFloor: this.noiseFloor, effectiveThreshold, calibrating: false };
    }

    this.noiseFloor = median(this.noiseHistory.map(sample => sample.rms));
    const effectiveThreshold = this.#effectiveThreshold();
    const rearmThreshold = Math.min(
      effectiveThreshold * 0.9,
      Math.max(this.threshold * this.rearmRatio, this.noiseFloor * this.noiseRearmMultiplier),
    );
    let onset = false;

    if (!this.armed) {
      if (rms <= rearmThreshold) {
        if (this.quietSinceAt === null) this.quietSinceAt = time;
        if (time - this.quietSinceAt >= this.rearmQuietMs) {
          this.armed = true;
          this.quietSinceAt = null;
        }
      } else {
        this.quietSinceAt = null;
      }
    }
    if (this.armed && rms >= effectiveThreshold && time - this.lastOnsetAt >= this.refractoryMs) {
      onset = true;
      this.armed = false;
      this.lastOnsetAt = time;
      this.quietSinceAt = null;
    }

    return { rms, level: normalizeRms(rms), onset, noiseFloor: this.noiseFloor, effectiveThreshold, calibrating: false };
  }

  #effectiveThreshold() {
    return Math.max(this.threshold, this.noiseFloor * this.noiseMultiplier, this.noiseFloor + this.threshold);
  }
}
