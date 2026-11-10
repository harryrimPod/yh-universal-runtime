import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundCueDetector, isSoundCue, cueAddress, cueSlug, resolveCueName, MIN_TAKES, MAX_TAKES } from '../src/sound-cue.mjs';
import { OnsetGate } from '../src/audio-gate.mjs';
import * as audio from '../test-support/synth-audio.mjs';

const sampleRate = 48000;
const bins = 512;
const spectrumAt = hz => {
  const spectrum = new Float32Array(bins).fill(-100);
  if (hz) spectrum[Math.round(hz * bins * 2 / sampleRate)] = -20;
  return spectrum;
};
const low = spectrumAt(470);
const high = spectrumAt(2100);
const quiet = spectrumAt(0);
const sample = (detector, spectrum, rms, time, calibrating = false) =>
  detector.sample(spectrum, sampleRate, { rms, effectiveThreshold: 0.01, calibrating }, time);

// Frames fed straight to the detector. `notes` is a list of spectra, one per 25 ms frame.
function hear(detector, notes, start, rms = 0.1) {
  const results = [];
  notes.forEach((spectrum, i) => results.push(sample(detector, spectrum, rms, start + i * 25)));
  for (let i = 0; i < 8; i++) results.push(sample(detector, quiet, 0, start + (notes.length + i) * 25));
  return results.filter(result => result !== undefined);
}
const twoNotes = (first, second, length = 4) => [...Array(length).fill(first), ...Array(length).fill(second)];

/** Enrolls by feeding `takes` repetitions of `notes`; returns every result and the stream time reached. */
function enrollHand(detector, notes, { name = 'a', label, takes = MIN_TAKES, start = 0, gap = 1000 } = {}) {
  detector.record(start, { name, label, takes });
  const results = [];
  let time = start + 500;
  results.push(sample(detector, quiet, 0, time));
  for (let take = 0; take < takes; take++) {
    time += 500;
    results.push(...hear(detector, Array.isArray(notes[0]) ? notes[take] : notes, time));
    time += (Array.isArray(notes[0]) ? notes[take] : notes).length * 25 + 8 * 25;
    for (let i = 0; i < gap / 25; i++, time += 25) results.push(sample(detector, quiet, 0, time));
  }
  return { results: results.filter(result => result !== undefined), time };
}

test('enrollment takes several repetitions, then the cue matches and survives serialization', () => {
  const detector = new SoundCueDetector();
  assert.equal(detector.hasCues, false);
  const { results, time } = enrollHand(detector, twoNotes(low, high));
  assert.deepEqual(results, ['listening', 'take', 'listening', 'take', 'listening', 'recorded']);
  assert.deepEqual(detector.cues.map(cue => cue.name), ['a']);
  assert.equal(detector.lastEnrollment.takes, 3);
  assert.equal(detector.recordUntil, null, 'enrollment is over');

  const restored = new SoundCueDetector(JSON.parse(JSON.stringify(detector.cues)));
  assert.equal(restored.hasCues, true);
  assert.deepEqual(hear(restored, twoNotes(low, high), time + 1000, 0.05), ['matched']);
  assert.equal(restored.lastMatch.name, 'a');
  assert.ok(restored.lastMatch.ratio < 0.1);
  assert.deepEqual(hear(restored, twoNotes(high, low), time + 3000), ['unmatched']);
  assert.equal(restored.lastComparison.reason, 'spectrum');
  assert.deepEqual(hear(restored, twoNotes(low, low), time + 4000), ['unmatched']);
  assert.deepEqual(hear(restored, twoNotes(low, high), time + 6000, 0.05), ['matched']);
  assert.deepEqual(hear(restored, twoNotes(low, high), time + 6325, 0.05), [], 'cooldown suppresses a duplicate');
});

test('the learned tolerance is capped even when the user varies a lot', () => {
  const detector = new SoundCueDetector();
  const lengths = [4, 6, 10];
  detector.record(0, { name: 'a', takes: 3 });
  let time = 500;
  sample(detector, quiet, 0, time);
  const results = [];
  for (const length of lengths) {
    time += 500;
    results.push(...hear(detector, twoNotes(low, high, length), time));
    time += (length * 2 + 8) * 25 + 1000;
  }
  assert.deepEqual(results, ['take', 'listening', 'take', 'listening', 'recorded']);
  const { spread, threshold } = detector.lastEnrollment;
  assert.ok(spread * 2 + 0.03 > 0.25, `the uncapped tolerance would exceed the cap (spread ${spread})`);
  assert.equal(threshold, 0.25);
});

test('a faint lead-in before the real onset is not part of the recorded sound', () => {
  const detector = new SoundCueDetector();
  detector.record(0, { name: 'a', takes: 3 });
  let time = 500;
  const at = (spectrum, rms) => { const outcome = detector.sample(spectrum, sampleRate, { rms, effectiveThreshold: 0.002, calibrating: false }, time); time += 25; return outcome; };
  at(quiet, 0);
  for (let take = 0; take < 3; take++) {
    time += 500;
    at(low, 0.003);
    for (let i = 0; i < 8; i++) at(high, 0.1);
    for (let i = 0; i < 40; i++) at(quiet, 0);
  }
  assert.deepEqual(detector.cues[0].examples.map(example => example.duration), [200, 200, 200]);
});

test('a take count outside 3 to 5 is clamped', () => {
  const detector = new SoundCueDetector();
  detector.record(0, { name: 'a', takes: 1 });
  assert.equal(detector.enrollment.total, MIN_TAKES);
  detector.record(0, { name: 'a', takes: 99 });
  assert.equal(detector.enrollment.total, MAX_TAKES);
});

test('a cue with the right spectrum but a clearly different length does not match', () => {
  const detector = new SoundCueDetector();
  enrollHand(detector, Array(20).fill(high));
  assert.deepEqual(hear(detector, Array(8).fill(high), 40000), ['unmatched'], 'far too short');
  assert.equal(detector.lastComparison.reason, 'duration');
  assert.deepEqual(hear(detector, Array(40).fill(high), 45000), ['unmatched'], 'far too long');
  assert.deepEqual(hear(detector, Array(23).fill(high), 50000), ['matched'], 'a modest timing difference is tolerated');
});

test('sound sustained past the maximum cue length never matches, even if it starts like the cue', () => {
  const detector = new SoundCueDetector();
  enrollHand(detector, Array(20).fill(high));
  assert.deepEqual(hear(detector, Array(80).fill(high), 40000), ['toolong'], 'reported so the page can say why nothing fired');
  assert.ok(detector.lastTooLong.duration > 1250);
  const bump = (start) => [0.008, 0.008, 0.002, 0.001].map((rms, i) => sample(detector, quiet, rms, start + i * 25)).filter(Boolean);
  assert.deepEqual(bump(42400), [], 'the tail of the long sound is not reported as a near miss');
  assert.deepEqual(bump(46000), ['below'], 'afterwards near misses are reported again');
  assert.deepEqual(hear(detector, Array(20).fill(high), 50000), ['matched'], 'the detector recovers afterwards');
});

test('a segment that began before the noise floor rose ends by the current threshold, so the next cue still matches', () => {
  const detector = new SoundCueDetector();
  enrollHand(detector, Array(20).fill(high));
  const at = (spectrum, rms, time, effectiveThreshold) => detector.sample(spectrum, sampleRate, { rms, effectiveThreshold, calibrating: false }, time);
  at(high, 0.012, 40000, 0.01);
  let time = 40025;
  for (; time < 42500; time += 25) at(quiet, 0.02, time, 0.05);
  assert.equal(at(quiet, 0.02, time, 0.05), undefined, 'steady background below the raised threshold must not keep the segment open');
  const start = time + 500;
  for (let i = 0; i < 20; i++) at(high, 0.1, start + i * 25, 0.05);
  assert.equal(at(quiet, 0.02, start + 20 * 25 + 150, 0.05), 'matched');
});

test('nothing matches while the noise floor is still being calibrated', () => {
  const detector = new SoundCueDetector();
  enrollHand(detector, Array(20).fill(high));
  for (let i = 0; i < 20; i++) sample(detector, high, 0.1, 40000 + i * 25, true);
  assert.equal(sample(detector, quiet, 0, 40800, true), undefined);
  assert.equal(sample(detector, quiet, 0, 40900), undefined);
});

test('a dead-silent spectrum or a quiet signal never starts or records a cue', () => {
  const detector = new SoundCueDetector();
  detector.record(0);
  sample(detector, quiet, 0, 500);
  const dead = new Float32Array(bins).fill(-Infinity);
  for (let i = 0; i < 10; i++) sample(detector, dead, 0.1, 1000 + i * 25);
  assert.equal(sample(detector, quiet, 0, 1400), 'invalid');
  assert.equal(detector.hasCues, false);
  assert.equal(enrollHand(new SoundCueDetector(), Array(10).fill(high), { takes: 3 }).results.includes('take'), true);
  const quietOne = new SoundCueDetector();
  quietOne.record(0);
  sample(quietOne, quiet, 0, 500);
  hear(quietOne, Array(10).fill(high), 1000, 0.005);
  assert.equal(quietOne.hasCues, false, 'below the effective threshold');
  assert.equal(quietOne.enrollment.examples.length, 0);
});

test('enrollment skips the click, waits for calibration and never saves sustained noise', () => {
  const detector = new SoundCueDetector();
  detector.record(0);
  assert.equal(sample(detector, high, 0.12, 25), undefined);
  assert.equal(sample(detector, high, 0.12, 450, true), undefined);
  assert.equal(sample(detector, quiet, 0, 500), 'listening');
  assert.equal(sample(detector, quiet, 0, 625), undefined);
  for (let time = 650; time <= 2150; time += 25) sample(detector, high, 0.12, time);
  assert.equal(sample(detector, quiet, 0, 2250), 'invalid');
  assert.equal(detector.hasCues, false);
  assert.equal(detector.recordUntil, null);
  detector.record(2500);
  assert.equal(sample(detector, quiet, 0, 10000), 'timeout');
});

test('takes that are not repetitions of one sound are refused, and a failed re-record keeps the old cue', () => {
  const detector = new SoundCueDetector();
  const different = new SoundCueDetector();
  different.record(0, { name: 'mixed', takes: 3 });
  const results = [sample(different, quiet, 0, 500)];
  let time = 1000;
  for (const notes of [twoNotes(low, high), twoNotes(high, low), Array(30).fill(spectrumAt(5000))]) {
    results.push(...hear(different, notes, time));
    time += 2500;
    for (let i = 0; i < 40; i++, time += 25) results.push(sample(different, quiet, 0, time));
  }
  assert.equal(results.filter(Boolean).at(-1), 'inconsistent');
  assert.equal(different.hasCues, false);
  assert.ok(different.lastEnrollment.spread > 0.15);
  assert.equal(different.recordUntil, null);

  enrollHand(detector, twoNotes(low, high), { name: 'keep' });
  const before = JSON.stringify(detector.cues);
  detector.record(40000, { name: 'keep' });
  detector.reset();
  assert.equal(JSON.stringify(detector.cues), before, 'abandoning a re-record leaves the saved cue untouched');
});

test('two pairs of similar takes (A, A, B, B) are not accepted as one sound', () => {
  const a = twoNotes(low, low);
  const b = twoNotes(high, high);
  for (const order of [[a, a, b, b], [a, b, a, b]]) {
    const detector = new SoundCueDetector();
    const { results } = enrollHand(detector, order, { takes: 4 });
    assert.equal(results.at(-1), 'inconsistent');
    assert.equal(detector.hasCues, false, 'nothing is saved');
    assert.ok(detector.lastEnrollment.spread < 0.15, 'each take has a close neighbour, so the nearest-take test alone would pass');
    assert.ok(detector.lastEnrollment.reach > 0.3);
  }
  const same = new SoundCueDetector();
  assert.equal(enrollHand(same, [a, a, a, a], { takes: 4 }).results.at(-1), 'recorded');
});

test('different typed names never share an address, retyping a name replaces that cue', () => {
  const none = resolveCueName('拍手', []);
  assert.deepEqual(none, { name: 'cue', label: '拍手', replaces: null });
  const detector = new SoundCueDetector();
  let { time } = enrollHand(detector, twoNotes(low, high), { name: none.name, label: none.label });
  const second = resolveCueName('响指', detector.cues);
  assert.deepEqual(second, { name: 'cue-2', label: '响指', replaces: null });
  ({ time } = enrollHand(detector, twoNotes(high, low), { name: second.name, label: second.label, start: time + 1000 }));
  assert.deepEqual(detector.cues.map(cue => [cue.name, cue.label]), [['cue', '拍手'], ['cue-2', '响指']]);
  assert.deepEqual(hear(detector, twoNotes(low, high), time + 2000, 0.05), ['matched']);
  assert.equal(detector.lastMatch.label, '拍手');
  assert.deepEqual(hear(detector, twoNotes(high, low), time + 4000, 0.05), ['matched']);
  assert.equal(detector.lastMatch.name, 'cue-2');

  assert.deepEqual(resolveCueName('拍手', detector.cues), { name: 'cue', label: '拍手', replaces: 'cue' });
  assert.deepEqual(resolveCueName(' CUE-2 ', detector.cues), { name: 'cue-2', label: '响指', replaces: 'cue-2' });
  assert.deepEqual(resolveCueName('', detector.cues), { name: 'cue-3', label: null, replaces: null });
  assert.deepEqual(resolveCueName('Door', detector.cues), { name: 'door', label: 'Door', replaces: null });
  assert.deepEqual(resolveCueName('door', []), { name: 'door', label: null, replaces: null });
  assert.equal(resolveCueName('长'.repeat(80), []).label.length, 40);

  const copy = () => JSON.parse(JSON.stringify(detector.cues[0]));
  assert.equal(isSoundCue(copy()), true);
  for (const label of ['', 5, 'x'.repeat(41)]) assert.equal(isSoundCue({ ...copy(), label }), false);
});

test('a near miss reports the threshold that was in force at its peak frame', () => {
  const detector = enrolledFromHand();
  const results = [];
  const at = (rms, effectiveThreshold, time) => results.push(detector.sample(quiet, sampleRate, { rms, effectiveThreshold, calibrating: false }, time));
  at(0.009, 0.010, 40000);
  at(0.004, 0.005, 40025);
  at(0.0005, 0.005, 40050);
  assert.deepEqual(results.filter(Boolean), ['below']);
  assert.deepEqual(detector.lastNearMiss, { peak: 0.009, threshold: 0.010 });
});

test('a sound that stands out from the quiet but stays well under the threshold is reported as below', () => {
  const detector = enrolledFromHand();
  const results = [];
  const at = (rms, time) => detector.sample(quiet, sampleRate, { rms, effectiveThreshold: 0.01, calibrating: false }, time);
  let time = 40000;
  for (let i = 0; i < 20; i++, time += 25) results.push(at(0.0005, time));
  for (const rms of [0.0035, 0.004, 0.0032]) results.push(at(rms, time += 25));
  for (let i = 0; i < 10; i++, time += 25) results.push(at(0.0005, time));
  assert.deepEqual(results.filter(Boolean), ['below'], 'a 40% bump after silence');
  assert.equal(detector.lastNearMiss.peak, 0.004);

  const steady = new SoundCueDetector(JSON.parse(JSON.stringify(detector.cues)));
  const noisy = [];
  time = 40000;
  for (let i = 0; i < 60; i++, time += 25) noisy.push(steady.sample(quiet, sampleRate, { rms: 0.0035 + (i % 3) * 0.0003, effectiveThreshold: 0.01, calibrating: false }, time));
  for (let i = 0; i < 20; i++, time += 25) noisy.push(steady.sample(quiet, sampleRate, { rms: 0.0005, effectiveThreshold: 0.01, calibrating: false }, time));
  assert.deepEqual(noisy.filter(Boolean), [], 'steady background at the same level says nothing, even when it later stops');
});

test('several cues live side by side: each is found by name, a repeated name replaces, removal works', () => {
  const detector = new SoundCueDetector();
  let { time } = enrollHand(detector, twoNotes(low, high), { name: 'up' });
  ({ time } = enrollHand(detector, twoNotes(high, low), { name: 'down', start: time + 1000 }));
  assert.deepEqual(detector.cues.map(cue => cue.name), ['up', 'down']);
  time += 2000;
  assert.deepEqual(hear(detector, twoNotes(low, high), time, 0.05), ['matched']);
  assert.equal(detector.lastMatch.name, 'up');
  time += 2000;
  assert.deepEqual(hear(detector, twoNotes(high, low), time, 0.05), ['matched']);
  assert.equal(detector.lastMatch.name, 'down');
  time += 2000;
  assert.deepEqual(hear(detector, twoNotes(low, low), time), ['unmatched']);
  assert.ok(['up', 'down'].includes(detector.lastComparison.name), 'the closest cue is reported');

  ({ time } = enrollHand(detector, twoNotes(low, low), { name: 'up', start: time + 1000 }));
  assert.deepEqual(detector.cues.map(cue => cue.name).sort(), ['down', 'up']);
  time += 2000;
  assert.deepEqual(hear(detector, twoNotes(low, low), time), ['matched']);
  assert.equal(detector.lastMatch.name, 'up');
  detector.removeCue('up');
  assert.deepEqual(detector.cues.map(cue => cue.name), ['down']);
  detector.clearCues();
  assert.equal(detector.hasCues, false);
});

test('a new cue that sits inside an existing one is reported as similar', () => {
  const detector = new SoundCueDetector();
  let { time } = enrollHand(detector, twoNotes(low, high), { name: 'first' });
  assert.equal(detector.lastEnrollment.similarTo, null);
  enrollHand(detector, twoNotes(low, high), { name: 'second', start: time + 1000 });
  assert.equal(detector.lastEnrollment.similarTo, 'first');
});

test('the similarity warning checks every take of the new cue, because recognition does', () => {
  const detector = new SoundCueDetector();
  const { time } = enrollHand(detector, twoNotes(low, high, 4), { name: 'b' });
  // The first take is far from b, the other two sit close to it: only a later take is inside b's reach.
  enrollHand(detector, [twoNotes(low, high, 12), twoNotes(low, high, 7), twoNotes(low, high, 7)], { name: 'c', start: time + 1000 });
  assert.equal(detector.lastEnrollment.similarTo, 'b');
});

test('addresses of deleted cues are never handed to a different sound, unless the user types that address', () => {
  const detector = new SoundCueDetector();
  let { time } = enrollHand(detector, twoNotes(low, high), { name: 'cue', label: '拍手' });
  ({ time } = enrollHand(detector, twoNotes(high, low), { name: 'cue-2', label: '响指', start: time + 1000 }));
  detector.removeCue('cue');
  assert.deepEqual(detector.retired, ['cue']);
  const next = resolveCueName('敲桌子', detector.cues, detector.retired);
  assert.deepEqual(next, { name: 'cue-3', label: '敲桌子', replaces: null });
  assert.equal(resolveCueName('', detector.cues, detector.retired).name, 'cue-3', 'an empty name is assigned the same way');
  assert.equal(resolveCueName('cue', detector.cues, detector.retired).name, 'cue', 'typing the address itself is a deliberate reuse');

  detector.clearCues();
  assert.deepEqual(detector.retired, ['cue', 'cue-2']);
  assert.equal(resolveCueName('拍手', [], detector.retired).name, 'cue-3');
  detector.removeCue('never-existed');
  assert.deepEqual(detector.retired, ['cue', 'cue-2'], 'removing something that is not there retires nothing');

  const restored = new SoundCueDetector([], JSON.parse(JSON.stringify(detector.retired)).concat(['Bad Name', 5, null]));
  assert.deepEqual(restored.retired, ['cue', 'cue-2'], 'persisted addresses survive a reload, junk is dropped');
  assert.deepEqual(new SoundCueDetector([], ['cue', 'cue', 'cue-2']).retired, ['cue', 'cue-2'], 'duplicates collapse');
  const live = new SoundCueDetector(JSON.parse(JSON.stringify([...enrolledFromHand().cues])), ['a', 'old']);
  assert.deepEqual(live.retired, ['old'], 'an address in use is not also retired');
});

test('only well-formed cues are accepted, duplicates and bad names are dropped', () => {
  const detector = new SoundCueDetector();
  enrollHand(detector, twoNotes(low, high));
  const good = JSON.parse(JSON.stringify(detector.cues[0]));
  assert.ok(isSoundCue(good));
  const copy = () => JSON.parse(JSON.stringify(good));
  const broken = [
    null, {}, 'x', [],
    { ...copy(), name: '' },
    { ...copy(), name: 'Has Space' },
    { ...copy(), name: 'x'.repeat(25) },
    { ...copy(), name: '/yh/onset' },
    { ...copy(), threshold: NaN },
    { ...copy(), threshold: 0.001 },
    { ...copy(), threshold: 5 },
    { ...copy(), examples: copy().examples.slice(1) },
    { ...copy(), examples: [...copy().examples, ...copy().examples] },
    (c => { c.examples[0].levels[0] = 1.5; return c; })(copy())
  ];
  for (const [index, candidate] of broken.entries()) {
    assert.equal(isSoundCue(candidate), false, `malformed cue #${index} must be rejected`);
    assert.equal(new SoundCueDetector([candidate]).hasCues, false);
  }
  assert.equal(new SoundCueDetector([good, copy()]).cues.length, 1, 'a repeated name is dropped');
  assert.equal(new SoundCueDetector('nope').hasCues, false);
});

test('names become bridge-safe addresses and stay unique', () => {
  assert.equal(cueSlug('Door Knock!'), 'door-knock');
  assert.equal(cueSlug('   '), 'cue');
  assert.equal(cueSlug('掌声'), 'cue');
  assert.equal(cueSlug('clap', ['clap']), 'clap-2');
  assert.equal(cueSlug('clap', ['clap', 'clap-2']), 'clap-3');
  assert.equal(cueSlug('x'.repeat(60)).length, 20);
  assert.equal(cueAddress('clap'), '/yh/cue/clap');
  assert.ok(isSoundCue({ ...JSON.parse(JSON.stringify(enrolledFromHand().cues[0])), name: cueSlug('x'.repeat(60)) }));
});
function enrolledFromHand() {
  const detector = new SoundCueDetector();
  enrollHand(detector, twoNotes(low, high));
  return detector;
}

test('strictness scales the learned threshold', () => {
  const detector = enrolledFromHand();
  const near = twoNotes(low, high, 5);
  const far = twoNotes(low, high, 6);
  assert.deepEqual(hear(detector, near, 40000, 0.05), ['matched']);
  assert.deepEqual(hear(detector, far, 42000, 0.05), ['unmatched']);
  detector.strictness = 0.5;
  assert.deepEqual(hear(detector, near, 45000, 0.05), ['unmatched'], 'stricter rejects the borderline sound');
  detector.strictness = 2;
  assert.deepEqual(hear(detector, far, 48000, 0.05), ['matched'], 'looser accepts it');
  assert.deepEqual(hear(detector, twoNotes(low, low), 52000, 0.05), ['unmatched'], 'a different sound is still different');
});

test('a bump that comes close to the threshold is reported as heard-but-below, ordinary noise is not', () => {
  const detector = enrolledFromHand();
  const results = [];
  const at = (rms, time) => detector.sample(quiet, sampleRate, { rms, effectiveThreshold: 0.005, calibrating: false }, time);
  for (let i = 0; i < 20; i++) results.push(at(0.002, 40000 + i * 25));
  assert.deepEqual(results.filter(Boolean), [], 'noise at 40% of the threshold says nothing');
  for (const [i, rms] of [0.0036, 0.0042, 0.0038, 0.002, 0.001].entries()) results.push(at(rms, 41000 + i * 25));
  assert.deepEqual(results.filter(Boolean), ['below']);
  assert.deepEqual(detector.lastNearMiss, { peak: 0.0042, threshold: 0.005 });
});

test('a sustained tone after a short enrolled cue never matches while the real OnsetGate raises its own noise floor', () => {
  const gate = new OnsetGate();
  const detector = new SoundCueDetector();
  const feed = (spectrum, rms, time) => detector.sample(spectrum, sampleRate, gate.processRms(rms, time), time);
  let time = 0;
  for (; time < 1500; time += 25) feed(quiet, 0.002, time);
  detector.record(time, { name: 'a', takes: 3 });
  const recorded = [];
  for (let take = 0; take < 3; take++) {
    for (let i = 0; i < 30; i++, time += 25) recorded.push(feed(quiet, 0.002, time));
    for (let i = 0; i < 22; i++, time += 25) recorded.push(feed(high, 0.1, time));
    for (let i = 0; i < 30; i++, time += 25) recorded.push(feed(quiet, 0.002, time));
  }
  assert.ok(recorded.includes('recorded'));
  for (let i = 0; i < 60; i++, time += 25) feed(quiet, 0.002, time);

  const results = [];
  for (let i = 0; i < 200; i++, time += 25) results.push(feed(high, 0.1, time));
  assert.ok(!results.includes('matched'), 'a tone that keeps playing is not the short cue');
  for (let i = 0; i < 60; i++, time += 25) feed(quiet, 0.002, time);
  const after = [];
  for (let i = 0; i < 22; i++, time += 25) after.push(feed(high, 0.1, time));
  for (let i = 0; i < 6; i++, time += 25) after.push(feed(quiet, 0.002, time));
  assert.ok(after.includes('matched'), 'the real cue is still recognised once the tone has stopped');
});

// ---- Real FFT frames: sounds rendered to audio and analysed like the browser's AnalyserNode. ----

const wav = audio.readWav(new URL('../public/examples/yh-target-cue.wav', import.meta.url));
const pseudo = (a, b) => audio.rng(a * 7919 + b)();

/**
 * Enrolls `name` from three takes, then plays `sounds` ([label, samples]) and returns what the detector said about each.
 * Every sound sits in its own 2.4 s slot, so a result is attributed by its time.
 */
function scenario({ cues = [], sounds, phaseMs = 0, seed = 1, meter = null, takes = null }) {
  const detector = new SoundCueDetector();
  const parts = [];
  const actions = [];
  let at = 1.5;
  for (const { name, make } of cues) {
    actions.push({ at: at - 0.6, run: (d, ms) => d.record(ms, { name, takes: 3 }) });
    for (let k = 0; k < 3; k++) { parts.push({ at: at + 0.5, samples: make(k) }); at += 2.2; }
    at += 1;
  }
  const first = at;
  for (const [, samples] of sounds) { parts.push({ at, samples }); at += 2.4; }
  const events = audio.play(detector, { total: at + 1, parts, actions, phaseMs, seed, meter });
  const outcomes = sounds.map(([label], index) => {
    const from = (first + index * 2.4) * 1000;
    const event = events.find(e => e.time >= from && e.time < from + 2400 && ['matched', 'unmatched', 'below'].includes(e.result));
    return { label, ...event };
  });
  return { detector, events, outcomes };
}

const claps = (gains, seed = 0) => gains.map((gain, i) => [`clap ${gain}`, audio.clap(seed * 100 + 40 + i, gain)]);

test('claps of very different loudness and timing match the enrolled claps, one event each', () => {
  for (let trial = 0; trial < 3; trial++) {
    const make = k => audio.clap(trial * 10 + k, 0.2 + 0.5 * pseudo(trial, k));
    const { outcomes, events } = scenario({ cues: [{ name: 'clap', make }], sounds: claps([0.15, 0.7, 0.3, 0.85, 0.2, 0.5], trial), phaseMs: trial * 9, seed: trial });
    assert.deepEqual(outcomes.map(o => o.result), Array(6).fill('matched'), `trial ${trial}: ${outcomes.map(o => `${o.label}:${o.result}`)}`);
    assert.equal(events.filter(e => e.result === 'matched').length, 6, 'exactly one event per clap');
    assert.ok(outcomes.every(o => o.match.name === 'clap'));
  }
});

test('speech, tones, sweeps and other sounds are not claps', () => {
  const make = k => audio.clap(k, 0.2 + 0.5 * pseudo(1, k));
  const sounds = [
    ['speech', audio.speech(1, 0.25)], ['speech loud', audio.speech(2, 0.6)], ['short speech', audio.speech(3, 0.3, [0.12, 0.1])],
    ['tone 520', audio.tone(520, 0.15, 0.4)], ['tone 1180 long', audio.tone(1180, 1.5, 0.3)], ['sweep', audio.sweep(300, 2800, 0.2, 0.4)],
    ['wav cue', wav], ['two notes', audio.twoNotes(470, 2100)]
  ];
  const { outcomes } = scenario({ cues: [{ name: 'clap', make }], sounds });
  for (const outcome of outcomes) assert.notEqual(outcome.result, 'matched', outcome.label);
  assert.equal(outcomes.find(o => o.label === 'tone 1180 long').result, undefined, 'a long sound is ignored outright');
  assert.ok(outcomes.filter(o => o.result === 'unmatched').every(o => o.comparison.ratio > 2), 'rejected by a wide margin, not by a hair');
});

test('the shipped target sound is recognised at any playback level, other sounds are not', () => {
  const make = k => audio.scaled(wav, 0.3 + 0.5 * pseudo(2, k));
  const sounds = [
    ['wav quiet', audio.scaled(wav, 0.25)], ['wav loud', audio.scaled(wav, 1)], ['wav mid', audio.scaled(wav, 0.5)],
    ['clap', audio.clap(5, 0.6)], ['speech', audio.speech(1, 0.3)], ['tone 520', audio.tone(520, 0.28, 0.4)],
    ['tone 1180 short', audio.tone(1180, 0.15, 0.4)], ['tone 1250', audio.tone(1250, 0.28, 0.4)], ['tone 1180 long', audio.tone(1180, 1.7, 0.3)], ['wav again', audio.scaled(wav, 0.7)]
  ];
  const { outcomes } = scenario({ cues: [{ name: 'target', make }], sounds, phaseMs: 11 });
  const matched = outcomes.filter(o => o.result === 'matched').map(o => o.label);
  assert.deepEqual(matched, ['wav quiet', 'wav loud', 'wav mid', 'wav again']);
});

test('the order of two notes is part of the sound', () => {
  const make = () => audio.twoNotes(470, 2100);
  const sounds = [['same', audio.twoNotes(470, 2100)], ['reversed', audio.twoNotes(2100, 470)], ['low twice', audio.twoNotes(470, 470)], ['high twice', audio.twoNotes(2100, 2100)], ['one note', audio.tone(470, 0.28)]];
  const { outcomes } = scenario({ cues: [{ name: 'notes', make }], sounds });
  assert.deepEqual(outcomes.map(o => o.result), ['matched', 'unmatched', 'unmatched', 'unmatched', 'unmatched']);
});

test('a clap cue and a sound cue are told apart in one detector', () => {
  const cues = [{ name: 'clap', make: k => audio.clap(k, 0.2 + 0.5 * pseudo(3, k)) }, { name: 'chime', make: k => audio.scaled(wav, 0.3 + 0.5 * pseudo(4, k)) }];
  const sounds = [['clap', audio.clap(60, 0.4)], ['chime', audio.scaled(wav, 0.6)], ['clap 2', audio.clap(61, 0.7)], ['speech', audio.speech(4, 0.3)], ['chime 2', audio.scaled(wav, 0.3)]];
  const { outcomes } = scenario({ cues, sounds });
  assert.deepEqual(outcomes.map(o => o.result === 'matched' ? o.match.name : o.result), ['clap', 'chime', 'clap', 'unmatched', 'chime']);
});

test('the learned tolerance follows how much the user varies', () => {
  const steady = scenario({ cues: [{ name: 'chime', make: k => audio.scaled(wav, 0.3 + 0.2 * k) }], sounds: [] });
  const varied = scenario({ cues: [{ name: 'clap', make: k => audio.clap(k, 0.2 + 0.5 * pseudo(5, k)) }], sounds: [] });
  const [steadyCue] = steady.detector.cues;
  const [variedCue] = varied.detector.cues;
  assert.ok(steadyCue && variedCue);
  assert.ok(steadyCue.threshold < variedCue.threshold, `identical takes ${steadyCue.threshold} should be stricter than clap takes ${variedCue.threshold}`);
  assert.ok(steady.detector.lastEnrollment.spread < varied.detector.lastEnrollment.spread);
});

test('claps of different loudness are recognised through the real OnsetGate and noise floor', () => {
  const gate = new OnsetGate({ threshold: 0.004 });
  const meter = (rms, time) => gate.processRms(rms, time);
  const make = k => audio.clap(k, 0.2 + 0.5 * pseudo(6, k));
  const { outcomes } = scenario({ cues: [{ name: 'clap', make }], sounds: claps([0.2, 0.7, 0.35, 0.5], 9), meter, phaseMs: 5 });
  assert.deepEqual(outcomes.map(o => o.result), Array(4).fill('matched'));
});
