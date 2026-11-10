import { YHLevelResponse, eventStrength } from './level-response.js';

/**
 * Engine-neutral uniform-scale responder shared by the Three.js, Babylon.js and
 * Verge3D adapters. `vector` only needs numeric x/y/z and set(x, y, z).
 *
 * scaleMode 'relative' (default): the object's scale at construction is the rest
 * pose. Each axis is multiplied by a factor that equals 1 at restLevel, so
 * imported models keep their size and any non-uniform proportions.
 * scaleMode 'absolute': legacy behaviour, every axis is set to the same value.
 *
 * Other writers: in 'relative' mode, if the vector no longer equals what this adapter
 * last wrote (an AnimationMixer, a script, the editor), the new value becomes the rest
 * pose and the response is multiplied on top of it (`followExternalScale`, default on).
 * An animation that rewrites scale every frame must run before update().
 *
 * Losing the event stream: on disconnect/error/stale status from the client the level
 * response drops back to rest (`releaseOnDisconnect`, default on). `levelStaleMs` > 0
 * additionally releases when no /yh/level arrives for that long (default 0 = hold).
 */
export class YHScaleAdapter {
  constructor(client, vector, {
    minScale = 0.68,
    maxScale = 1.75,
    onsetBoost = 0.6,
    decayRate = 3.2,
    levelThreshold = 0.18,
    levelReleaseThreshold = 0.12,
    levelAttackMs = 120,
    levelReleaseMs = 180,
    levelSmoothing = 8,
    restLevel = 0.42,
    scaleMode = 'relative',
    restoreOnDispose = true,
    followExternalScale = true,
    releaseOnDisconnect = true,
    levelStaleMs = 0,
    now = () => performance.now()
  } = {}) {
    if (scaleMode !== 'relative' && scaleMode !== 'absolute') throw new TypeError('scaleMode must be "relative" or "absolute"');
    if (!Number.isFinite(minScale) || !Number.isFinite(maxScale) || maxScale < minScale) {
      throw new RangeError('minScale and maxScale must be finite numbers with minScale <= maxScale');
    }
    this.vector = vector;
    this.followExternalScale = followExternalScale;
    this.levelStaleMs = Number.isFinite(levelStaleMs) ? Math.max(0, levelStaleMs) : 0;
    this.now = now;
    this.lastLevelAt = null;
    this.staleReleased = false;
    this.lastWritten = null;
    this.minScale = minScale;
    this.maxScale = maxScale;
    this.onsetBoost = onsetBoost;
    this.decayRate = decayRate;
    this.scaleMode = scaleMode;
    this.restoreOnDispose = restoreOnDispose;
    this.original = { x: vector.x, y: vector.y, z: vector.z };
    this.level = restLevel;
    this.pulse = 0;
    this.disposed = false;
    this.levelResponse = new YHLevelResponse({
      threshold: levelThreshold,
      releaseThreshold: levelReleaseThreshold,
      attackMs: levelAttackMs,
      releaseMs: levelReleaseMs,
      smoothing: levelSmoothing,
      restLevel,
    });
    this.restScale = minScale + this.levelResponse.value * (maxScale - minScale);
    if (scaleMode === 'relative' && !(this.restScale > 0)) {
      throw new RangeError('relative scaleMode needs a positive rest scale (check minScale, maxScale and restLevel)');
    }
    this.baseScale = this.restScale;
    this.offLevel = client.on('/yh/level', event => {
      const level = eventStrength(event, 0);
      if (this.disposed || level === null) return;
      this.level = level;
      this.lastLevelAt = this.now();
      this.staleReleased = false;
      this.levelResponse.set(this.level);
    });
    this.offStatus = releaseOnDisconnect
      ? client.on('status', status => {
        if (!this.disposed && (status?.status === 'disconnected' || status?.status === 'error' || status?.status === 'stale')) this.release();
      })
      : null;
    this.offOnset = client.on('/yh/onset', event => {
      const strength = eventStrength(event);
      if (this.disposed || strength === null) return;
      this.pulse = Math.max(this.pulse, strength);
      this.#apply();
    });
    this.#apply();
  }

  update(deltaSeconds) {
    if (this.disposed) return;
    const delta = Math.max(0, Number(deltaSeconds) || 0);
    if (this.levelStaleMs > 0 && this.lastLevelAt !== null && !this.staleReleased && this.now() - this.lastLevelAt > this.levelStaleMs) {
      this.staleReleased = true;
      this.release();
    }
    this.baseScale = this.minScale + this.levelResponse.update(delta) * (this.maxScale - this.minScale);
    this.pulse *= Math.exp(-this.decayRate * delta);
    if (this.pulse < 0.002) this.pulse = 0;
    this.#apply();
  }

  setLevelThreshold(value) { return this.levelResponse.setThreshold(value); }

  /** Eases the level response back to rest, e.g. when the event stream is lost. */
  release() {
    this.levelResponse.reset();
    this.level = this.levelResponse.restLevel;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.offLevel?.();
    this.offOnset?.();
    this.offStatus?.();
    if (!this.restoreOnDispose) return;
    if (this.#modifiedExternally()) return;
    this.vector.set(this.original.x, this.original.y, this.original.z);
  }

  #modifiedExternally() {
    if (this.scaleMode !== 'relative' || !this.followExternalScale || !this.lastWritten) return false;
    const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
    const { x, y, z } = this.vector;
    return !(close(x, this.lastWritten.x) && close(y, this.lastWritten.y) && close(z, this.lastWritten.z));
  }

  #apply() {
    const scale = this.baseScale + this.onsetBoost * this.pulse;
    if (this.scaleMode === 'absolute') { this.vector.set(scale, scale, scale); return; }
    if (this.#modifiedExternally()) this.original = { x: this.vector.x, y: this.vector.y, z: this.vector.z };
    const factor = scale / this.restScale;
    if (!Number.isFinite(factor)) return;
    this.vector.set(this.original.x * factor, this.original.y * factor, this.original.z * factor);
    this.lastWritten = { x: this.vector.x, y: this.vector.y, z: this.vector.z };
  }
}
