import { SoundCueDetector, cueSlug } from './sound-cue.mjs';

export const CUE_STORAGE_KEY = 'yh.sound-cue.v2';
export const STRICTNESS_VALUES = [0.75, 1, 1.4];
export const MIN_RMS_THRESHOLD = 0.001;
export const MAX_RMS_THRESHOLD = 0.05;

const validThreshold = value => Number.isFinite(value) && value >= MIN_RMS_THRESHOLD && value <= MAX_RMS_THRESHOLD ? Math.round(value * 1000) / 1000 : null;

/** Reads whatever is stored and returns only values the page can use; anything else is dropped. */
export function normalizeSettings(raw) {
  const stored = raw && typeof raw === 'object' ? raw : {};
  const detector = new SoundCueDetector(stored.cues, stored.retired);
  return {
    mode: stored.mode === 'cue' && detector.hasCues ? 'cue' : 'level',
    cues: detector.cues,
    retired: detector.retired,
    strictness: STRICTNESS_VALUES.includes(stored.strictness) ? stored.strictness : null,
    threshold: validThreshold(stored.threshold),
    // Settings saved before this flag existed count as acknowledged once they hold cues.
    legacyAck: typeof stored.legacyAck === 'boolean' ? stored.legacyAck : detector.hasCues
  };
}

/**
 * Applies one user action to the settings as they are stored right now. Pages never write their own
 * in-memory copy back: a page that missed another page's change would otherwise bring a deleted
 * sound back or drop a newly recorded one.
 *   { strictness } { threshold } { mode } { upsertCue, replaces, explicit } { removeCue } { clearCues }
 * Only `mode` in the change writes the mode: it is the page's own choice, so removing a sound from one page
 * must not switch another page's saved mode. A mode of cue without any sound is still turned back to level.
 */
export function applyChange(latest, change) {
  const settings = normalizeSettings(latest);
  const detector = new SoundCueDetector(settings.cues, settings.retired);
  let { mode, strictness, threshold, legacyAck } = settings;
  let appliedName = null;
  if ('strictness' in change && STRICTNESS_VALUES.includes(change.strictness)) strictness = change.strictness;
  if ('threshold' in change) threshold = validThreshold(change.threshold) ?? threshold;
  if (change.upsertCue) {
    const wanted = change.upsertCue.name;
    const taken = [...detector.cues.map(cue => cue.name), ...detector.retired];
    // The address was picked when the recording started. Another page may have used it since, or deleted a
    // sound that had it. Only a deliberate replacement of a live sound may reuse a live address, and only
    // an address the user typed themselves may reuse a deleted one.
    const inUse = detector.cues.some(cue => cue.name === wanted) && change.replaces !== wanted;
    const deleted = detector.retired.includes(wanted) && !change.explicit;
    const name = inUse || deleted ? cueSlug(wanted.replace(/-\d+$/, ''), taken) : wanted;
    appliedName = name;
    detector.cues = [...detector.cues.filter(cue => cue.name !== name), { ...change.upsertCue, name }];
    legacyAck = true;
  }
  if (change.removeCue) { detector.removeCue(change.removeCue); legacyAck = true; }
  if (change.clearCues) { detector.clearCues(); legacyAck = true; }
  if ('mode' in change) mode = change.mode === 'cue' ? 'cue' : 'level';
  if (mode === 'cue' && !detector.hasCues) mode = 'level';
  return { appliedName, settings: { mode, cues: detector.cues, retired: detector.retired, strictness, threshold, legacyAck } };
}

export function loadSettings(storage) {
  try { return normalizeSettings(JSON.parse(storage.getItem(CUE_STORAGE_KEY))); } catch { return normalizeSettings(null); }
}

/**
 * Read-modify-write against the latest stored settings. Returns the resulting settings and whether
 * they were actually written (`saved`).
 * `fallback` (the page's own settings) is the base instead of storage when storage cannot be read, and
 * when `preferFallback` is set: after a failed write the page's copy holds changes that storage never
 * saw, and re-reading the stale stored value would silently drop them.
 */
export function commitChange(storage, change, fallback = null, { preferFallback = false } = {}) {
  let latest;
  try { latest = preferFallback ? fallback : JSON.parse(storage.getItem(CUE_STORAGE_KEY)); } catch { latest = fallback; }
  const { settings, appliedName } = applyChange(latest, change);
  let saved = true;
  try { storage.setItem(CUE_STORAGE_KEY, JSON.stringify(settings)); } catch { saved = false; }
  return { settings: normalizeSettings(settings), appliedName, saved };
}
