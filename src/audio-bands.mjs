export const DEFAULT_BANDS = Object.freeze({
  low: [20, 250],
  mid: [250, 2000],
  high: [2000, 12000]
});

/**
 * Mean AnalyserNode byte-spectrum magnitude per band, scaled to 0-1.
 * The analyser's dB window (minDecibels/maxDecibels) sets the scale; values are
 * relative, not calibrated to dBFS or dB SPL.
 */
export function bandLevels(byteSpectrum, sampleRate, bands = DEFAULT_BANDS) {
  const result = {};
  const binCount = byteSpectrum?.length || 0;
  const nyquist = Number(sampleRate) / 2;
  for (const [name, [low, high]] of Object.entries(bands)) {
    if (!binCount || !Number.isFinite(nyquist) || nyquist <= 0) { result[name] = 0; continue; }
    const first = Math.max(0, Math.floor(low / nyquist * binCount));
    const last = Math.min(binCount - 1, Math.max(first, Math.ceil(high / nyquist * binCount) - 1));
    let sum = 0;
    for (let index = first; index <= last; index++) sum += byteSpectrum[index];
    result[name] = Math.max(0, Math.min(1, sum / (last - first + 1) / 255));
  }
  return result;
}
