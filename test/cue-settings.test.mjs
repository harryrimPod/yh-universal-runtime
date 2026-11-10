import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundCueDetector } from '../src/sound-cue.mjs';
import { CUE_STORAGE_KEY, applyChange, commitChange, loadSettings, normalizeSettings } from '../src/cue-settings.mjs';
import { releaseOnPageHide } from '../src/page-lifecycle.mjs';

const sampleRate = 48000;
const bins = 512;
const tone = hz => { const s = new Float32Array(bins).fill(-100); s[Math.round(hz * bins * 2 / sampleRate)] = -20; return s; };
const feed = (detector, spectrum, rms, time) => detector.sample(spectrum, sampleRate, { rms, effectiveThreshold: 0.01, calibrating: false }, time);

function makeCue(name, hz = 2100, label) {
  const detector = new SoundCueDetector();
  detector.record(0, { name, label, takes: 3 });
  let time = 500;
  feed(detector, tone(0), 0, time);
  for (let take = 0; take < 3; take++) {
    time += 600;
    for (let i = 0; i < 20; i++, time += 25) feed(detector, tone(hz), 0.1, time);
    for (let i = 0; i < 40; i++, time += 25) feed(detector, tone(0), 0, time);
  }
  assert.equal(detector.cues.length, 1);
  return detector.cues[0];
}

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), data };
};
const stored = storage => JSON.parse(storage.getItem(CUE_STORAGE_KEY));

test('a page that missed a deletion cannot bring the deleted sound back by changing something else', () => {
  const clap = makeCue('clap', 2100, '拍手');
  const snap = makeCue('snap', 900, '响指');
  const storage = memoryStorage();
  commitChange(storage, { upsertCue: clap, replaces: null });
  commitChange(storage, { upsertCue: snap, replaces: null });
  // Page A deletes clap. Page B still lists it in memory and only changes the strictness.
  commitChange(storage, { removeCue: 'clap' });
  const { settings } = commitChange(storage, { strictness: 0.75 });
  assert.deepEqual(stored(storage).cues.map(cue => cue.name), ['snap']);
  assert.deepEqual(settings.cues.map(cue => cue.name), ['snap'], 'the page adopts what is stored');
  assert.deepEqual(stored(storage).retired, ['clap']);
  assert.equal(stored(storage).strictness, 0.75);
});

test('a sound recorded on one page survives another page deleting a different one', () => {
  const storage = memoryStorage();
  commitChange(storage, { upsertCue: makeCue('clap'), replaces: null });
  commitChange(storage, { upsertCue: makeCue('door', 900), replaces: null });
  commitChange(storage, { removeCue: 'clap' });
  assert.deepEqual(stored(storage).cues.map(cue => cue.name), ['door']);
  commitChange(storage, { upsertCue: makeCue('desk', 1500), replaces: null });
  commitChange(storage, { threshold: 0.004 });
  assert.deepEqual(stored(storage).cues.map(cue => cue.name), ['door', 'desk']);
});

test('two pages handing out the same new address do not overwrite each other, but a deliberate replacement does', () => {
  const storage = memoryStorage();
  commitChange(storage, { upsertCue: makeCue('cue', 2100, '拍手'), replaces: null });
  const second = commitChange(storage, { upsertCue: makeCue('cue', 900, '响指'), replaces: null });
  assert.equal(second.appliedName, 'cue-2');
  assert.deepEqual(stored(storage).cues.map(cue => `${cue.name}:${cue.label}`), ['cue:拍手', 'cue-2:响指']);
  const third = commitChange(storage, { upsertCue: makeCue('cue', 1500, '拍手'), replaces: 'cue' });
  assert.equal(third.appliedName, 'cue');
  assert.equal(stored(storage).cues.length, 2);
  assert.equal(stored(storage).cues.find(cue => cue.name === 'cue').label, '拍手');
});

test('the RMS minimum threshold is stored and restored, and unusable values are ignored', () => {
  const storage = memoryStorage();
  assert.equal(loadSettings(storage).threshold, null, 'nothing stored yet: the slider keeps its default');
  commitChange(storage, { threshold: 0.004 });
  assert.equal(loadSettings(storage).threshold, 0.004);
  for (const bad of [0, 0.5, NaN, Infinity, '0.01', null, undefined]) {
    commitChange(storage, { threshold: bad });
    assert.equal(loadSettings(storage).threshold, 0.004, `rejected ${String(bad)}`);
  }
  assert.equal(normalizeSettings({ threshold: 9 }).threshold, null);
  assert.equal(normalizeSettings({ threshold: 0.0123456 }).threshold, 0.012);
});

test('saving only the strictness or threshold does not acknowledge the old-format notice; editing sounds does', () => {
  const storage = memoryStorage();
  commitChange(storage, { strictness: 1.4 });
  commitChange(storage, { threshold: 0.02 });
  assert.equal(stored(storage).legacyAck, false);
  commitChange(storage, { upsertCue: makeCue('clap'), replaces: null });
  assert.equal(stored(storage).legacyAck, true);
  assert.equal(normalizeSettings({ cues: [makeCue('old')] }).legacyAck, true, 'settings from before the flag existed that hold cues');
});

test('cue mode never outlives the last sound, and clearing retires every address', () => {
  const storage = memoryStorage();
  commitChange(storage, { upsertCue: makeCue('clap'), replaces: null });
  commitChange(storage, { mode: 'cue' });
  assert.equal(stored(storage).mode, 'cue');
  const cleared = commitChange(storage, { clearCues: true });
  assert.equal(cleared.settings.mode, 'level');
  assert.deepEqual(stored(storage).cues, []);
  assert.deepEqual(stored(storage).retired, ['clap']);
  assert.equal(applyChange(null, { mode: 'cue' }).settings.mode, 'level');
});

test('unreadable or unwritable storage falls back to the page copy instead of dropping its sounds', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const fallback = { cues: [makeCue('clap')], retired: [], mode: 'cue', strictness: 1, threshold: 0.01, legacyAck: true };
  const { settings } = commitChange(broken, { strictness: 0.75 }, fallback);
  assert.deepEqual(settings.cues.map(cue => cue.name), ['clap']);
  assert.equal(settings.mode, 'cue');
  assert.equal(settings.strictness, 0.75);
  const corrupt = memoryStorage({ [CUE_STORAGE_KEY]: '{not json' });
  assert.deepEqual(commitChange(corrupt, { threshold: 0.02 }, fallback).settings.cues.map(cue => cue.name), ['clap']);
  assert.equal(loadSettings(memoryStorage({ [CUE_STORAGE_KEY]: '{not json' })).cues.length, 0);
  assert.equal(loadSettings(corrupt).cues.length, 1, 'the unreadable entry is replaced by the page copy');
});

test('deleting a sound from one page does not rewrite the saved mode that another page chose', () => {
  const storage = memoryStorage();
  commitChange(storage, { upsertCue: makeCue('clap'), replaces: null });
  commitChange(storage, { upsertCue: makeCue('snap', 900), replaces: null });
  commitChange(storage, { mode: 'cue' });
  // The other page is in level mode and only deletes snap; it sends no mode.
  commitChange(storage, { removeCue: 'snap' });
  assert.equal(stored(storage).mode, 'cue', 'clap is still there, so the saved mode stays cue');
  commitChange(storage, { strictness: 1.4 });
  commitChange(storage, { threshold: 0.02 });
  assert.equal(stored(storage).mode, 'cue');
  commitChange(storage, { removeCue: 'clap' });
  assert.equal(stored(storage).mode, 'level', 'no sound left, so cue mode cannot stay');
  commitChange(storage, { mode: 'level' });
  commitChange(storage, { upsertCue: makeCue('desk', 1500), replaces: null });
  assert.equal(stored(storage).mode, 'level', 'recording from a page that did not ask for cue mode keeps the saved mode');
});

test('an address chosen before another page deleted a sound with it is not handed back, unless the user typed it', () => {
  const storage = memoryStorage();
  commitChange(storage, { upsertCue: makeCue('cue', 2100, '拍手'), replaces: null });
  commitChange(storage, { removeCue: 'cue' });
  assert.deepEqual(stored(storage).retired, ['cue']);
  // This page started recording while `cue` was still live, so it was assigned that address.
  const auto = commitChange(storage, { upsertCue: makeCue('cue', 900, '响指'), replaces: null, explicit: false });
  assert.equal(auto.appliedName, 'cue-2');
  const stale = commitChange(storage, { upsertCue: makeCue('cue', 1500, '拍手'), replaces: 'cue', explicit: false });
  assert.notEqual(stale.appliedName, 'cue', 'replacing a sound that has since been deleted does not revive its address');
  const typed = commitChange(storage, { upsertCue: makeCue('cue', 1200, 'cue'), replaces: null, explicit: true });
  assert.equal(typed.appliedName, 'cue', 'typing the address is a deliberate reuse');
});

test('a failed write is reported, and the page copy stays the base so the next change does not drop the new sound', () => {
  const data = new Map();
  let failWrites = true;
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { if (failWrites) throw new Error('quota'); data.set(key, value); } };
  const first = commitChange(storage, { upsertCue: makeCue('clap'), replaces: null, mode: 'cue' });
  assert.equal(first.saved, false);
  assert.deepEqual(first.settings.cues.map(cue => cue.name), ['clap']);
  const pageCopy = { ...first.settings };
  const forgotten = commitChange(storage, { strictness: 0.75 }, pageCopy);
  assert.deepEqual(forgotten.settings.cues, [], 'reading the stale storage loses the sound (what the page must not do)');
  const kept = commitChange(storage, { strictness: 0.75 }, pageCopy, { preferFallback: true });
  assert.deepEqual(kept.settings.cues.map(cue => cue.name), ['clap']);
  assert.equal(kept.saved, false);
  failWrites = false;
  const recovered = commitChange(storage, { threshold: 0.01 }, kept.settings, { preferFallback: true });
  assert.equal(recovered.saved, true);
  assert.deepEqual(stored(storage).cues.map(cue => cue.name), ['clap'], 'once writes work again the page copy is what gets saved');
});

function fakeWindow() {
  const listeners = {};
  return { listeners, addEventListener: (type, handler) => (listeners[type] ??= []).push(handler), fire: (type, event = {}) => (listeners[type] ?? []).forEach(handler => handler(event)) };
}

test('a page restored from the back/forward cache is reloaded; a normal navigation is not affected', () => {
  const target = fakeWindow();
  let released = 0; let reloads = 0;
  releaseOnPageHide(() => { released++; }, { target, reload: () => { reloads++; } });
  target.fire('pageshow', { persisted: true });
  assert.equal(reloads, 0, 'a page that was never hidden has nothing to rebuild');
  target.fire('pagehide', { persisted: true });
  target.fire('pagehide', { persisted: true });
  assert.equal(released, 1, 'release runs once');
  target.fire('pageshow', { persisted: false });
  assert.equal(reloads, 0);
  target.fire('pageshow', { persisted: true });
  assert.equal(reloads, 1);
});
