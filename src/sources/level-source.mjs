import { LEVEL_FULL_SCALE_RMS, OnsetGate } from '../audio-gate.mjs';

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

/**
 * Feeds an external audio processor (for example a Cables patch) into YH.
 * The processor supplies an already-normalised 0-1 level; when it cannot detect
 * onsets itself, `detectOnsets` reuses the same noise-floor gate as the microphone.
 * Give the client a `sourceId` (e.g. 'cables') so the bridge can tell sources apart.
 * Only one stage should own onset detection: set `detectOnsets: false` when the
 * upstream already emits final onsets and forward them with pushOnset().
 */
export class YHLevelSource {
  constructor(client, { detectOnsets = true, threshold, fullScaleRms = LEVEL_FULL_SCALE_RMS, now = () => performance.now() } = {}) {
    if (!client?.sendControl) throw new TypeError('YHLevelSource needs a YHEventClient');
    this.client = client;
    this.fullScaleRms = fullScaleRms;
    this.now = now;
    this.gate = detectOnsets ? new OnsetGate(threshold === undefined ? {} : { threshold }) : null;
  }

  pushLevel(level, timeMs = this.now()) {
    const value = clamp01(level);
    const sent = this.client.sendControl('/yh/level', value);
    if (this.gate && this.gate.processRms(value * this.fullScaleRms, timeMs).onset) this.pushOnset(1);
    return sent;
  }

  pushOnset(value = 1) { return this.client.sendControl('/yh/onset', clamp01(value)); }

  reset() { this.gate?.reset(); }
}
