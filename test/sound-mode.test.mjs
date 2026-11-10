import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundCueDetector } from '../src/sound-cue.mjs';
import { SoundModeController } from '../src/sound-mode.mjs';

const sampleRate = 48000;
const bins = 512;
const tone = hz => { const s = new Float32Array(bins).fill(-100); s[Math.round(hz * bins * 2 / sampleRate)] = -20; return s; };
const high = tone(2100);
const quiet = tone(0);
const feed = (detector, spectrum, rms, time) => detector.sample(spectrum, sampleRate, { rms, effectiveThreshold: 0.01, calibrating: false }, time);

/** Drives an enrollment that is already armed through all of its takes; returns the last result. */
function finishTakes(detector, start = 500, takes = 3) {
  let time = start;
  let last = feed(detector, quiet, 0, time);
  for (let take = 0; take < takes; take++) {
    time += 600;
    for (let i = 0; i < 20; i++, time += 25) feed(detector, high, 0.1, time);
    for (let i = 0; i < 40; i++, time += 25) last = feed(detector, quiet, 0, time) ?? last;
  }
  return last;
}

function enrolledDetector() {
  const detector = new SoundCueDetector();
  detector.record(0);
  assert.equal(finishTakes(detector), 'recorded');
  return detector;
}

test('choosing cue mode without a target sound is refused instead of leaving the page silent', () => {
  const mode = new SoundModeController(new SoundCueDetector());
  assert.equal(mode.select('cue'), false);
  assert.equal(mode.mode, 'level');
  assert.equal(mode.select('level'), true);
});

test('choosing cue mode with a target sound works, and a saved cue mode without a usable one starts as level', () => {
  const detector = enrolledDetector();
  const mode = new SoundModeController(detector);
  assert.equal(mode.select('cue'), true);
  assert.equal(mode.mode, 'cue');
  assert.equal(new SoundModeController(detector, 'cue').mode, 'cue');
  assert.equal(new SoundModeController(new SoundCueDetector(), 'cue').mode, 'level');
  assert.equal(new SoundModeController(new SoundCueDetector([{ name: 'broken', threshold: 1, examples: [] }]), 'cue').mode, 'level');
});

test('a first enrollment that is interrupted by stopping the microphone does not strand cue mode', () => {
  const detector = new SoundCueDetector();
  const mode = new SoundModeController(detector);
  mode.beginEnrollment(0);
  assert.equal(mode.mode, 'cue');
  assert.equal(mode.enrolling, true);
  assert.equal(mode.endEnrollment('interrupted'), 'level');
  assert.equal(mode.enrolling, false);
  assert.equal(detector.hasCues, false);
});

test('first enrollment: timeout, invalid, inconsistent and cancel all return to level mode; success keeps cue mode', () => {
  for (const outcome of ['timeout', 'invalid', 'inconsistent', 'cancelled']) {
    const mode = new SoundModeController(new SoundCueDetector());
    mode.beginEnrollment(0);
    assert.equal(mode.endEnrollment(outcome), 'level', outcome);
  }
  const detector = new SoundCueDetector();
  const mode = new SoundModeController(detector);
  mode.beginEnrollment(0, { name: 'a', takes: 3 });
  assert.equal(finishTakes(detector), 'recorded');
  assert.equal(mode.endEnrollment('recorded'), 'cue');
});

test('abandoning a multi-take enrollment halfway leaves no cue and no half-armed detector', () => {
  const detector = new SoundCueDetector();
  const mode = new SoundModeController(detector);
  mode.beginEnrollment(0, { name: 'a', takes: 3 });
  feed(detector, quiet, 0, 500);
  for (let i = 0; i < 20; i++) feed(detector, high, 0.1, 1000 + i * 25);
  assert.equal(feed(detector, quiet, 0, 1650), 'take');
  assert.equal(mode.enrolling, true, 'still collecting takes');
  assert.equal(mode.endEnrollment('cancelled'), 'level');
  assert.equal(mode.enrolling, false);
  assert.equal(detector.hasCues, false);
  assert.equal(feed(detector, high, 0.1, 5000), undefined);
});

test('a failed re-enrollment restores the mode the user had and keeps the old cue', () => {
  const detector = enrolledDetector();
  const fromLevel = new SoundModeController(detector, 'level');
  fromLevel.beginEnrollment(200000);
  assert.equal(fromLevel.mode, 'cue');
  assert.equal(fromLevel.endEnrollment('timeout'), 'level');
  assert.ok(detector.hasCues, 'the old cue survives');

  const fromCue = new SoundModeController(detector, 'cue');
  fromCue.beginEnrollment(200000);
  assert.equal(fromCue.endEnrollment('invalid'), 'cue');
  assert.ok(detector.hasCues);
  assert.equal(fromCue.enrolling, false);
});

test('removing the last cue, or clearing all of them, always leaves level mode', () => {
  const detector = enrolledDetector();
  const mode = new SoundModeController(detector, 'cue');
  mode.removeCue('nobody');
  assert.equal(mode.mode, 'cue');
  mode.removeCue('cue');
  assert.equal(mode.mode, 'level');
  assert.equal(detector.hasCues, false);

  const again = enrolledDetector();
  const clearing = new SoundModeController(again, 'cue');
  clearing.clearCues();
  assert.equal(clearing.mode, 'level');
  assert.equal(again.hasCues, false);
});
