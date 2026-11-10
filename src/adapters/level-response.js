export const DEFAULT_LEVEL_THRESHOLD = 0.18;
export const DEFAULT_LEVEL_RELEASE_THRESHOLD = 0.12;
export const DEFAULT_LEVEL_ATTACK_MS = 120;
export const DEFAULT_LEVEL_RELEASE_MS = 180;
export const DEFAULT_LEVEL_SMOOTHING = 8;
export const DEFAULT_REST_LEVEL = 0.42;

export const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

/**
 * The 0..1 strength an event carries, or null when it carries something that is not a finite number
 * (JSON turns an OSC NaN or Infinity into null, which must not read as "no value, so full strength").
 * `absent` is used when the sender gave no value at all, e.g. a bare /yh/onset.
 */
export function eventStrength(event, absent = 1) {
  const raw = event?.value === undefined ? absent : event.value;
  if (raw === null) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? clamp01(number) : null;
}

/**
 * Converts the continuous /yh/level stream into a stable scene-response value.
 * The incoming stream is never altered; this gate only affects the scene target.
 */
export class YHLevelResponse {
  constructor({
    threshold = DEFAULT_LEVEL_THRESHOLD,
    releaseThreshold = DEFAULT_LEVEL_RELEASE_THRESHOLD,
    attackMs = DEFAULT_LEVEL_ATTACK_MS,
    releaseMs = DEFAULT_LEVEL_RELEASE_MS,
    smoothing = DEFAULT_LEVEL_SMOOTHING,
    restLevel = DEFAULT_REST_LEVEL,
  } = {}) {
    this.threshold = Math.min(0.999999, clamp01(threshold));
    this.releaseThreshold = Math.min(this.threshold, clamp01(releaseThreshold));
    this.releaseRatio = this.threshold > 0 ? this.releaseThreshold / this.threshold : 0;
    this.attackMs = this.#nonNegative(attackMs, DEFAULT_LEVEL_ATTACK_MS);
    this.releaseMs = this.#nonNegative(releaseMs, DEFAULT_LEVEL_RELEASE_MS);
    this.smoothing = this.#nonNegative(smoothing, DEFAULT_LEVEL_SMOOTHING);
    this.restLevel = clamp01(restLevel);
    this.value = this.restLevel;
    this.target = this.restLevel;
    this.latestLevel = this.restLevel;
    this.active = false;
    this.aboveSince = null;
    this.belowSince = null;
  }

  set(value, nowMs = performance.now()) {
    const level = clamp01(value);
    this.latestLevel = level;
    return this.#evaluate(level, this.#time(nowMs));
  }

  /**
   * Re-evaluates the attack/release timers against the latest level without a new event.
   * Needed because a stream can end on a single value (e.g. the final zero when capture stops):
   * without it the release delay would only be checked by an event that never arrives.
   */
  tick(nowMs = performance.now()) {
    return this.#evaluate(this.latestLevel, this.#time(nowMs));
  }

  #time(nowMs) {
    const suppliedTime = Number(nowMs);
    return Number.isFinite(suppliedTime) ? suppliedTime : performance.now();
  }

  #evaluate(level, now) {
    if (!this.active) {
      this.belowSince = null;
      if (level >= this.threshold) {
        if (this.aboveSince === null) this.aboveSince = now;
        if (now - this.aboveSince >= this.attackMs) {
          this.active = true;
          this.aboveSince = null;
        }
      } else {
        this.aboveSince = null;
      }
    } else {
      this.aboveSince = null;
      if (level <= this.releaseThreshold) {
        if (this.belowSince === null) this.belowSince = now;
        if (now - this.belowSince >= this.releaseMs) {
          this.active = false;
          this.belowSince = null;
        }
      } else {
        this.belowSince = null;
      }
    }

    return this.#updateTarget(level);
  }

  /** Drops back to the rest pose as if no level had been seen; `value` then eases to rest via update(). */
  reset() {
    this.active = false;
    this.aboveSince = null;
    this.belowSince = null;
    this.latestLevel = this.restLevel;
    this.target = this.restLevel;
  }

  setThreshold(value) {
    const threshold = Number(value);
    if (!Number.isFinite(threshold)) return this.threshold;
    this.threshold = Math.max(0, Math.min(0.999999, threshold));
    this.releaseThreshold = this.threshold * this.releaseRatio;
    this.#updateTarget(this.latestLevel);
    return this.threshold;
  }

  update(deltaSeconds) {
    const delta = Math.max(0, Number(deltaSeconds) || 0);
    if (delta === 0) return this.value;
    const alpha = this.smoothing > 0 ? 1 - Math.exp(-this.smoothing * delta) : 1;
    this.value += (this.target - this.value) * alpha;
    if (Math.abs(this.target - this.value) < 1e-6) this.value = this.target;
    return this.value;
  }

  #nonNegative(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : fallback;
  }

  #updateTarget(level) {
    if (this.active) {
      const amount = clamp01((level - this.threshold) / (1 - this.threshold));
      this.target = this.restLevel + amount * (1 - this.restLevel);
    } else {
      this.target = this.restLevel;
    }
    return this.target;
  }
}
