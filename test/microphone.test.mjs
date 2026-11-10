import test from 'node:test';
import assert from 'node:assert/strict';
import { YHMicrophone } from '../src/microphone.mjs';
import { bandLevels } from '../src/audio-bands.mjs';
import { YHLevelSource } from '../src/sources/level-source.mjs';

function makeTrack() {
  const endedListeners = [];
  return {
    stopped: false,
    readyState: 'live',
    stop() { this.stopped = true; this.readyState = 'ended'; },
    addEventListener(type, listener) { if (type === 'ended') endedListeners.push(listener); },
    // What the browser does when the device is unplugged or the share is stopped.
    end() { this.readyState = 'ended'; endedListeners.forEach(listener => listener()); }
  };
}
function makeStream(withAudio = true) {
  const audio = withAudio ? [makeTrack()] : [];
  const video = [makeTrack()];
  return {
    audio, video,
    getTracks: () => [...audio, ...video],
    getAudioTracks: () => audio,
    getVideoTracks: () => video,
    removeTrack(track) { const index = video.indexOf(track); if (index >= 0) video.splice(index, 1); }
  };
}

function makeEnvironment() {
  const env = { contexts: [], analysers: [], streams: [], pending: [], intervals: [], statuses: [], resumeResolvers: [], deferResume: false, nextTrackState: null };
  env.AudioContextImpl = class {
    constructor() {
      this.state = 'running'; this.sampleRate = 48000; this.closed = false;
      env.contexts.push(this);
    }
    resume() {
      if (!env.deferResume) return Promise.resolve();
      return new Promise(resolve => env.resumeResolvers.push(resolve));
    }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      const analyser = {
        fftSize: 0, frequencyBinCount: 512,
        getFloatTimeDomainData(samples) { samples.fill(0.05); },
        getByteFrequencyData(bytes) { bytes.fill(128); },
        getFloatFrequencyData(values) { values.fill(-60); }
      };
      env.analysers.push(analyser);
      return analyser;
    }
    close() { this.state = 'closed'; this.closed = true; return Promise.resolve(); }
  };
  // Each getUserMedia call returns a promise the test resolves or rejects by hand.
  env.mediaDevices = {
    getUserMedia(constraints) {
      env.lastConstraints = constraints;
      return new Promise((resolve, reject) => env.pending.push({ resolve: () => {
        const stream = makeStream();
        if (env.nextTrackState) for (const track of stream.audio) track.readyState = env.nextTrackState;
        env.streams.push(stream);
        resolve(stream);
      }, reject }));
    },
    getDisplayMedia(constraints) {
      env.lastDisplayConstraints = constraints;
      const stream = makeStream(env.displayHasAudio !== false);
      env.streams.push(stream);
      return Promise.resolve(stream);
    }
  };
  env.options = {
    mediaDevices: env.mediaDevices,
    AudioContextImpl: env.AudioContextImpl,
    setIntervalImpl: fn => { env.intervals.push(fn); return env.intervals.length; },
    clearIntervalImpl: id => { env.intervals[id - 1] = null; },
    now: () => 0,
    onStatus: status => env.statuses.push(status.state)
  };
  return env;
}

test('stop() during a pending permission request cancels the start: no capture, no timer, tracks released', async () => {
  const env = makeEnvironment();
  const mic = new YHMicrophone(env.options);
  const pending = mic.start();
  mic.stop();
  env.pending[0].resolve();
  await pending;
  assert.equal(mic.running, false);
  assert.equal(mic.starting, false);
  assert.equal(env.intervals.length, 0, 'no sampling timer may start');
  assert.ok(env.streams[0].audio[0].stopped, 'the late stream must be released');
  assert.equal(env.contexts.length, 0);
  assert.deepEqual(env.statuses, ['requesting', 'off']);
});

test('the analysis window is longer than the 25 ms poll interval, so a short clap cannot fall between two reads', async () => {
  const env = makeEnvironment();
  const mic = new YHMicrophone(env.options);
  const started = mic.start();
  env.pending[0].resolve();
  await started;
  const windowMs = env.analysers[0].fftSize / env.contexts[0].sampleRate * 1000;
  assert.ok(windowMs > 25, `window ${windowMs.toFixed(1)} ms must exceed the 25 ms poll interval`);
  mic.stop();
});

test('stop() then start() again: only the newest start captures audio', async () => {
  const env = makeEnvironment();
  const mic = new YHMicrophone(env.options);
  const first = mic.start();
  mic.stop();
  const second = mic.start();
  env.pending[0].resolve();
  await first;
  assert.equal(mic.running, false, 'stale start must not turn the microphone on');
  env.pending[1].resolve();
  await second;
  assert.equal(mic.running, true);
  assert.equal(env.contexts.length, 1);
  assert.ok(env.streams[0].audio[0].stopped);
  assert.equal(env.streams[1].audio[0].stopped, false);
  mic.stop();
  assert.ok(env.streams[1].audio[0].stopped);
  assert.equal(env.contexts[0].closed, true);
});

test('a track that ends while AudioContext.resume() is pending never enters the running state', async () => {
  const env = makeEnvironment();
  env.deferResume = true;
  const statuses = [];
  const mic = new YHMicrophone({ ...env.options, onStatus: status => statuses.push(status) });
  const started = mic.start();
  env.pending[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.contexts.length, 1);
  assert.equal(env.resumeResolvers.length, 1);
  env.streams[0].audio[0].end();
  env.resumeResolvers[0]();
  await started;
  assert.equal(mic.running, false);
  assert.equal(mic.starting, false);
  assert.equal(env.contexts[0].closed, true);
  assert.equal(env.intervals.length, 0);
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(statuses.at(-1).reason, 'track-ended');
});

test('a track already ended when getUserMedia resolves is rejected before creating an AudioContext', async () => {
  const env = makeEnvironment();
  env.nextTrackState = 'ended';
  const statuses = [];
  const mic = new YHMicrophone({ ...env.options, onStatus: status => statuses.push(status) });
  const started = mic.start();
  env.pending[0].resolve();
  await started;
  assert.equal(mic.running, false);
  assert.equal(mic.starting, false);
  assert.equal(env.contexts.length, 0);
  assert.equal(env.intervals.length, 0);
  assert.equal(statuses.at(-1).reason, 'track-ended');
});

test('an audio track that ends by itself (device unplugged) stops sampling and reports an error', async () => {
  const env = makeEnvironment();
  const statuses = [];
  const levels = [];
  const mic = new YHMicrophone({ ...env.options, onLevel: level => levels.push(level), onStatus: status => statuses.push(status) });
  const started = mic.start();
  env.pending[0].resolve();
  await started;
  assert.equal(mic.running, true);
  const timerId = env.intervals.length;
  env.streams[0].audio[0].end();
  assert.equal(mic.running, false);
  assert.equal(env.intervals[timerId - 1], null, 'sampling timer must be cleared');
  assert.equal(env.contexts[0].closed, true);
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(statuses.at(-1).reason, 'track-ended');
  assert.equal(levels.at(-1), 0, 'a final zero level releases other clients while the bridge stays healthy');
  const emitted = levels.length;
  env.streams[0].audio[0].end();
  assert.equal(levels.length, emitted, 'no level may be emitted after the track ended');
  assert.equal(statuses.filter(status => status.state === 'error').length, 1, 'repeated ended events report once');
});

test('a stale track ended event from a previous session does not stop the new session', async () => {
  const env = makeEnvironment();
  const mic = new YHMicrophone(env.options);
  const first = mic.start();
  env.pending[0].resolve();
  await first;
  const oldTrack = env.streams[0].audio[0];
  mic.stop();
  const second = mic.start();
  env.pending[1].resolve();
  await second;
  oldTrack.end();
  assert.equal(mic.running, true);
  mic.stop();
});

test('a normal start emits level, bands and stops cleanly; permission denial reports an error', async () => {
  const env = makeEnvironment();
  const levels = [];
  const bands = [];
  const mic = new YHMicrophone({ ...env.options, onLevel: level => levels.push(level), onBands: value => bands.push(value) });
  const started = mic.start();
  env.pending[0].resolve();
  await started;
  assert.equal(mic.running, true);
  assert.ok(levels.length >= 1 && Math.abs(levels[0] - 0.05 / 0.25) < 1e-6);
  assert.ok(Math.abs(bands[0].low - 128 / 255) < 1e-9);
  mic.stop();
  assert.equal(env.intervals.at(-1), null, 'timer cleared');
  assert.equal(levels.at(-1), 0, 'an explicit stop also releases remote level consumers');

  const denied = new YHMicrophone(env.options);
  const attempt = denied.start();
  env.pending[1].reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  await assert.rejects(attempt, /denied/);
  assert.equal(denied.running, false);
  assert.equal(env.statuses.at(-1), 'error');
});

test('stop and an unplugged device both zero the band outputs, not only the level', async () => {
  for (const finish of ['stop', 'ended']) {
    const env = makeEnvironment();
    const bands = [];
    const mic = new YHMicrophone({ ...env.options, onBands: value => bands.push({ ...value }) });
    const started = mic.start();
    env.pending[0].resolve();
    await started;
    assert.ok(bands.at(-1).low > 0);
    if (finish === 'stop') mic.stop(); else env.streams[0].audio[0].end();
    assert.deepEqual(bands.at(-1), { low: 0, mid: 0, high: 0 }, `${finish}: other clients must not keep the last band energy`);
    const emitted = bands.length;
    if (finish === 'stop') mic.stop();
    assert.equal(bands.length, emitted, 'a second stop without capture emits nothing');
  }
});

test('onSpectrum receives decibel data, sample rate, gate state and timestamp on every sample, and stops after stop()', async () => {
  const env = makeEnvironment();
  const calls = [];
  const mic = new YHMicrophone({ ...env.options, now: () => 1234, onSpectrum: (...args) => calls.push(args) });
  const started = mic.start();
  env.pending[0].resolve();
  await started;
  assert.equal(calls.length, 1);
  const [spectrum, sampleRate, meter, time] = calls[0];
  assert.ok(spectrum instanceof Float32Array && spectrum.length === 512 && spectrum[0] === -60);
  assert.equal(sampleRate, 48000);
  assert.ok(Number.isFinite(meter.rms) && Number.isFinite(meter.effectiveThreshold) && typeof meter.calibrating === 'boolean');
  assert.equal(time, 1234);
  mic.stop();
  assert.equal(mic.frequencyDb, null, 'the decibel buffer is released with the capture');
});

test('device selection is passed to getUserMedia and display capture drops the video track', async () => {
  const env = makeEnvironment();
  const mic = new YHMicrophone({ ...env.options, deviceId: 'abc123' });
  const started = mic.start();
  env.pending[0].resolve();
  await started;
  assert.deepEqual(env.lastConstraints.audio.deviceId, { exact: 'abc123' });
  mic.stop();

  const display = new YHMicrophone({ ...env.options, inputKind: 'display' });
  await display.start();
  assert.equal(display.running, true);
  assert.equal(env.streams.at(-1).video.length, 0);
  display.stop();

  env.displayHasAudio = false;
  const silent = new YHMicrophone({ ...env.options, inputKind: 'display' });
  await assert.rejects(silent.start(), /没有音频轨/);
  assert.equal(silent.running, false);
});

test('bandLevels maps spectrum bins to low/mid/high and stays within 0-1', () => {
  const bins = new Uint8Array(512);
  bins.fill(255, 0, 5); // bins 0-4 = 0-234 Hz at 48 kHz / 512 bins; the low band spans bins 0-5
  const bands = bandLevels(bins, 48000);
  assert.ok(Math.abs(bands.low - 5 / 6) < 1e-9);
  assert.equal(bands.mid, 0);
  assert.equal(bands.high, 0);
  assert.deepEqual(bandLevels(new Uint8Array(0), 48000), { low: 0, mid: 0, high: 0 });
});

test('YHLevelSource forwards external levels and, when asked, derives onsets with the shared gate', () => {
  const sent = [];
  const client = { sendControl: (address, value) => { sent.push([address, value]); return true; } };
  const source = new YHLevelSource(client, { threshold: 0.01, now: () => 0 });
  let time = 0;
  for (; time < 1400; time += 25) source.pushLevel(0.02, time);
  assert.equal(sent.some(([address]) => address === '/yh/onset'), false);
  source.pushLevel(0.9, time);
  assert.equal(sent.filter(([address]) => address === '/yh/onset').length, 1);
  assert.equal(sent.at(-1)[0], '/yh/onset');

  const passthrough = [];
  const plain = new YHLevelSource({ sendControl: (address, value) => { passthrough.push([address, value]); return true; } }, { detectOnsets: false });
  plain.pushLevel(1.7);
  plain.pushOnset();
  assert.deepEqual(passthrough, [['/yh/level', 1], ['/yh/onset', 1]]);
});
