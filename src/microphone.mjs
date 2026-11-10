import { DEFAULT_RMS_THRESHOLD, OnsetGate } from './audio-gate.mjs';
import { DEFAULT_BANDS, bandLevels } from './audio-bands.mjs';

const SAMPLE_INTERVAL_MS = 25;
const AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function stopTracks(stream) {
  if (stream) for (const track of stream.getTracks()) track.stop();
}

/**
 * Browser audio input analysed locally. `inputKind` is 'microphone' (optionally pinned
 * to `deviceId`) or 'display' (tab/system audio via getDisplayMedia). PCM never leaves
 * this class; callers only receive normalised numbers.
 */
export class YHMicrophone {
  constructor({
    onLevel = () => {}, onOnset = () => {}, onMeter = () => {}, onBands = null, onSpectrum = null, onStatus = () => {},
    threshold = DEFAULT_RMS_THRESHOLD,
    inputKind = 'microphone',
    deviceId = null,
    mediaDevices = globalThis.navigator?.mediaDevices,
    AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
    setIntervalImpl = globalThis.setInterval?.bind(globalThis),
    clearIntervalImpl = globalThis.clearInterval?.bind(globalThis),
    now = () => performance.now()
  } = {}) {
    this.onLevel = onLevel;
    this.onOnset = onOnset;
    this.onMeter = onMeter;
    this.onBands = onBands;
    this.onSpectrum = onSpectrum;
    this.onStatus = onStatus;
    this.inputKind = inputKind;
    this.deviceId = deviceId;
    this.mediaDevices = mediaDevices;
    this.AudioContextImpl = AudioContextImpl;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.now = now;
    this.gate = new OnsetGate({ threshold });
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.samples = null;
    this.spectrum = null;
    this.frequencyDb = null;
    this.timer = null;
    this.running = false;
    this.starting = false;
    this.generation = 0;
  }

  setThreshold(value) { this.gate.setThreshold(value); }

  setInput({ inputKind = this.inputKind, deviceId = this.deviceId } = {}) {
    this.inputKind = inputKind;
    this.deviceId = deviceId;
  }

  async #acquireStream() {
    if (this.inputKind === 'display') {
      if (!this.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持捕获标签页/系统音频');
      const stream = await this.mediaDevices.getDisplayMedia({ audio: AUDIO_CONSTRAINTS, video: true });
      for (const track of stream.getVideoTracks()) { track.stop(); stream.removeTrack(track); }
      if (!stream.getAudioTracks().length) { stopTracks(stream); throw new Error('所选来源没有音频轨'); }
      return stream;
    }
    const audio = this.deviceId ? { ...AUDIO_CONSTRAINTS, deviceId: { exact: this.deviceId } } : AUDIO_CONSTRAINTS;
    return this.mediaDevices.getUserMedia({ audio, video: false });
  }

  async start() {
    if (this.running || this.starting) return;
    const canCapture = this.inputKind === 'display' ? this.mediaDevices?.getDisplayMedia : this.mediaDevices?.getUserMedia;
    if (!canCapture || !this.AudioContextImpl) throw new Error('当前浏览器不支持 Web Audio 音频输入');
    const generation = ++this.generation;
    this.starting = true;
    this.gate.reset();
    this.onStatus({ state: 'requesting', message: '等待音频输入权限…' });
    let stream = null;
    let context = null;
    let streamEnded = false;
    const isCurrent = () => generation === this.generation;
    const discard = () => {
      stopTracks(stream);
      if (context && context.state !== 'closed') context.close().catch(() => {});
    };
    const onTrackEnded = () => {
      streamEnded = true;
      if (isCurrent() && this.running) this.#trackEnded(generation);
    };
    const hasEndedTrack = () => streamEnded || stream.getAudioTracks().some(track => track.readyState === 'ended');
    const abortEndedStart = () => {
      discard();
      if (isCurrent()) this.onStatus({ state: 'error', reason: 'track-ended', message: '音频输入已中断（设备被拔出或共享已停止）' });
    };
    try {
      stream = await this.#acquireStream();
      if (!isCurrent()) { discard(); return; }
      // Listen before the next await: a device can disappear while AudioContext.resume() is pending.
      for (const track of stream.getAudioTracks()) track.addEventListener?.('ended', onTrackEnded);
      if (hasEndedTrack()) { abortEndedStart(); return; }
      context = new this.AudioContextImpl();
      await context.resume();
      if (!isCurrent()) { discard(); return; }
      if (hasEndedTrack()) { abortEndedStart(); return; }
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      // The window must be longer than the 25 ms poll interval (1024 samples is ~21 ms at 48 kHz), or a
      // clap that lands between two windows is seen at a fraction of its level, or not at all.
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      this.stream = stream;
      this.audioContext = context;
      this.analyser = analyser;
      this.samples = new Float32Array(analyser.fftSize);
      this.spectrum = new Uint8Array(analyser.frequencyBinCount);
      this.running = true;
      this.onStatus({ state: 'on', message: this.inputKind === 'display' ? '标签页/系统音频已开启 · 本地分析中' : '麦克风已开启 · 本地分析中' });
      this.timer = this.setIntervalImpl(() => this.#sample(), SAMPLE_INTERVAL_MS);
      this.#sample();
    } catch (error) {
      discard();
      if (!isCurrent()) return;
      this.#release();
      this.onStatus({ state: 'error', message: error?.name === 'NotAllowedError' ? '音频输入权限被拒绝' : `无法开启音频输入：${error?.message || error}` });
      throw error;
    } finally {
      if (isCurrent()) this.starting = false;
    }
  }

  #sample() {
    if (!this.running || !this.analyser || !this.samples) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    const time = this.now();
    const result = this.gate.process(this.samples, time);
    this.onMeter(result);
    this.onLevel(result.level, result.rms);
    if (result.onset) this.onOnset(1, result.rms);
    if (this.onBands && this.analyser.getByteFrequencyData) {
      this.analyser.getByteFrequencyData(this.spectrum);
      this.onBands(bandLevels(this.spectrum, this.audioContext.sampleRate));
    }
    if (this.onSpectrum) {
      this.frequencyDb ??= new Float32Array(this.analyser.frequencyBinCount);
      this.analyser.getFloatFrequencyData(this.frequencyDb);
      this.onSpectrum(this.frequencyDb, this.audioContext.sampleRate, result, time);
    }
  }

  #trackEnded(generation) {
    if (generation !== this.generation || !this.running) return;
    this.generation++;
    this.#release();
    this.#emitRest();
    this.onStatus({ state: 'error', reason: 'track-ended', message: '音频输入已中断（设备被拔出或共享已停止）' });
  }

  // Final zeros release remote adapters even when the bridge itself remains healthy.
  #emitRest() {
    this.onLevel(0, 0);
    this.onBands?.(Object.fromEntries(Object.keys(DEFAULT_BANDS).map(name => [name, 0])));
  }

  #release() {
    this.running = false;
    if (this.timer !== null) this.clearIntervalImpl(this.timer);
    this.timer = null;
    stopTracks(this.stream);
    this.stream = null;
    const context = this.audioContext;
    this.audioContext = null;
    this.analyser = null;
    this.samples = null;
    this.spectrum = null;
    this.frequencyDb = null;
    if (context && context.state !== 'closed') context.close().catch(() => {});
  }

  stop() {
    const hadCapture = this.running || this.stream !== null;
    this.generation++;
    this.starting = false;
    this.#release();
    if (hadCapture) this.#emitRest();
    this.onStatus({ state: 'off', message: '音频输入已关闭' });
  }
}
