/**
 * Which trigger the page sends: 'level' (continuous level + RMS onsets) or 'cue' (one event per
 * recognised target sound). Cue mode sends nothing else, so it must never be active without a
 * target sound or an enrollment in progress; every transition below enforces that.
 */
export class SoundModeController {
  constructor(detector, requestedMode = 'level') {
    this.detector = detector;
    this.mode = requestedMode === 'cue' && detector.hasCues ? 'cue' : 'level';
    this.previousMode = null;
  }

  get enrolling() { return this.detector.recordUntil !== null; }

  /** Dropdown choice. Returns false when cue mode was refused because nothing has been recorded yet. */
  select(requested) {
    if (requested === 'cue' && !this.detector.hasCues && !this.enrolling) {
      this.mode = 'level';
      return false;
    }
    this.mode = requested === 'cue' ? 'cue' : 'level';
    this.detector.reset();
    return true;
  }

  beginEnrollment(now, options) {
    if (this.enrolling) return;
    this.previousMode = this.mode;
    this.mode = 'cue';
    this.detector.record(now, options);
  }

  /**
   * Ends an enrollment: 'recorded' keeps cue mode; 'timeout', 'invalid', 'inconsistent', 'cancelled' and
   * 'interrupted' (capture stopped) go back to the mode the user had, or to level mode if that
   * would leave cue mode without a target sound. Returns the resulting mode.
   */
  endEnrollment(outcome) {
    const previous = this.previousMode;
    this.previousMode = null;
    if (outcome === 'recorded') {
      this.mode = 'cue';
      return this.mode;
    }
    this.detector.reset();
    this.mode = previous === 'cue' && this.detector.hasCues ? 'cue' : 'level';
    return this.mode;
  }

  removeCue(name) {
    this.detector.removeCue(name);
    if (!this.detector.hasCues && !this.enrolling) this.mode = 'level';
  }

  clearCues() {
    this.detector.clearCues();
    this.previousMode = null;
    this.mode = 'level';
  }
}
