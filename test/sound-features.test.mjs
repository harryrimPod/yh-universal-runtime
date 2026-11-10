import test from 'node:test';
import assert from 'node:assert/strict';
import { MEL_BANDS, melSpectrum, buildExample, isExample, dtw } from '../src/sound-features.mjs';

const sampleRate = 48000;
const spike = (hz, bins = 1024) => {
  const spectrum = new Float32Array(bins).fill(-100);
  if (hz) spectrum[Math.round(hz * bins * 2 / sampleRate)] = -20;
  return spectrum;
};
const frameAt = (hz, rms, time, bins) => ({ mel: melSpectrum(spike(hz, bins), sampleRate), rms, time });
const example = (hzList, rms = 0.1) => buildExample(hzList.map((hz, i) => frameAt(hz, Array.isArray(rms) ? rms[i] : rms, i * 25)));

test('the mel spectrum peaks in a band that rises with frequency, at any analyser size', () => {
  for (const bins of [512, 1024, 2048]) {
    const peaks = [200, 500, 1000, 2000, 4000, 8000].map(hz => {
      const mel = melSpectrum(spike(hz, bins), sampleRate);
      return mel.indexOf(Math.max(...mel));
    });
    assert.deepEqual(peaks, [...peaks].sort((a, b) => a - b), `bins=${bins}`);
    assert.equal(new Set(peaks).size, peaks.length, `each tone gets its own band, bins=${bins}`);
    assert.equal(melSpectrum(spike(1000, bins), sampleRate).length, MEL_BANDS);
  }
});

test('a silent spectrum has no mel shape', () => {
  assert.equal(melSpectrum(new Float32Array(1024).fill(-Infinity), sampleRate), null);
});

test('an example is independent of how loud the sound was', () => {
  const quiet = example([500, 500, 500, 500], [0.02, 0.01, 0.005, 0.0025]);
  const loud = example([500, 500, 500, 500], [0.4, 0.2, 0.1, 0.05]);
  assert.deepEqual(quiet, loud);
});

test('time warping is forgiven, a different spectrum is not, and the distance is symmetric', () => {
  const rising = example([300, 600, 1200, 2400, 4800]);
  const stretched = example([300, 300, 600, 600, 1200, 1200, 2400, 2400, 4800, 4800]);
  const backwards = example([4800, 2400, 1200, 600, 300]);
  const steady = example([1000, 1000, 1000, 1000, 1000]);
  assert.equal(dtw(rising, rising).distance, 0);
  assert.ok(dtw(rising, stretched).distance < 0.02, `stretched ${dtw(rising, stretched).distance}`);
  assert.ok(dtw(rising, backwards).distance > 0.3);
  assert.ok(dtw(rising, steady).distance > 0.2);
  assert.ok(Math.abs(dtw(rising, stretched).distance - dtw(stretched, rising).distance) < 1e-9);
});

test('level contributes, and it is reported separately from spectral shape', () => {
  const decaying = example([800, 800, 800, 800, 800, 800, 800, 800, 800, 800], [0.1, 0.07, 0.05, 0.035, 0.025, 0.018, 0.012, 0.009, 0.007, 0.006]);
  const flat = example([800, 800, 800, 800, 800, 800, 800, 800, 800, 800], 0.1);
  const result = dtw(decaying, flat);
  assert.ok(result.level > 0.005, `level ${result.level}`);
  assert.ok(result.shape < 0.02, 'identical spectra cost nothing but a possibly skipped edge frame');
  assert.ok(Math.abs(result.distance - result.shape - result.level) < 1e-12);
});

test('a faint, badly windowed edge frame does not make two takes of the same sound look different', () => {
  const clean = example([1000, 1000, 1000], [0.1, 0.08, 0.04]);
  const clipped = (() => {
    const frames = [frameAt(8000, 0.05, 0), frameAt(1000, 0.1, 25), frameAt(1000, 0.08, 50), frameAt(1000, 0.04, 75)];
    return buildExample(frames);
  })();
  const different = example([8000, 8000, 8000], [0.1, 0.08, 0.04]);
  assert.ok(dtw(clean, clipped).distance < 0.08, `${dtw(clean, clipped).distance}`);
  assert.ok(dtw(clean, different).distance > 0.4);
  assert.ok(Math.abs(dtw(clean, clipped).distance - dtw(clipped, clean).distance) < 1e-9);
});

test('one frame against many is comparable instead of unreachable', () => {
  const single = example([1000]);
  const long = example(Array(12).fill(1000));
  assert.ok(Number.isFinite(dtw(single, long).distance));
  assert.ok(Number.isFinite(dtw(long, single).distance));
});

test('only well-formed integer examples are accepted', () => {
  const good = example([500, 1000, 2000]);
  assert.ok(isExample(good, 1275));
  const copy = () => JSON.parse(JSON.stringify(good));
  const broken = [
    null, {}, 'x',
    { ...copy(), duration: 5 },
    { ...copy(), duration: 99999 },
    { ...copy(), duration: NaN },
    { ...copy(), levels: [] , shapes: [] },
    { ...copy(), levels: copy().levels.slice(1) },
    (e => { e.levels[0] = 1.5; return e; })(copy()),
    (e => { e.levels[0] = 101; return e; })(copy()),
    (e => { e.levels[0] = -1; return e; })(copy()),
    (e => { e.shapes[0][0] = NaN; return e; })(copy()),
    (e => { e.shapes[0].pop(); return e; })(copy()),
    (e => { e.shapes[1] = e.shapes[1].map(value => Math.round(value / 2)); return e; })(copy()),
    (e => { e.shapes[0][3] = 0.5; return e; })(copy())
  ];
  for (const [index, candidate] of broken.entries()) assert.equal(isExample(candidate, 1275), false, `malformed example #${index} must be rejected`);
});
