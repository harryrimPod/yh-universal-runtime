import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { YHEventClient } from '../src/event-client.mjs';
import { correctedRms, DEFAULT_NOISE_CALIBRATION_MS, OnsetGate } from '../src/audio-gate.mjs';
import { startBridge } from '../src/server.mjs';

function sineBurst(amplitude, length = 1024, frequency = 440, sampleRate = 48000) {
  return Float32Array.from({ length }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate));
}

function ambientNoiseFrame(amplitude, seed) {
  let state = seed >>> 0 || 1;
  return Float32Array.from({ length: 1024 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 0x100000000 * 2 - 1) * amplitude;
  });
}

function clickTransient(amplitude = 0.9) {
  return Float32Array.from({ length: 1024 }, (_, index) => index < 120
    ? amplitude * Math.exp(-index / 24) * Math.sin(2 * Math.PI * 6000 * index / 48000)
    : 0);
}

function mixFrames(left, right) {
  return Float32Array.from(left, (value, index) => value + right[index]);
}

function ambientAt(time) {
  const wobble = 1 + 0.2 * Math.sin(time * 0.018) + 0.1 * Math.sin(time * 0.047);
  return ambientNoiseFrame(0.02 * wobble, time + 73);
}

function testGateWithAmbientNoise() {
  const gate = new OnsetGate({ threshold: 0.01, refractoryMs: 180, calibrationMs: 200 });
  for (let time = 0; time <= 1600; time += 25) {
    const result = gate.process(ambientAt(time), time);
    assert.equal(result.onset, false, `background noise unexpectedly triggered at ${time} ms`);
  }
  return gate;
}

test('synthetic zero-centred waveform RMS is correct and quiet input remains below the gate', () => {
  const rms = correctedRms(sineBurst(0.005, 2048));
  assert.ok(Math.abs(rms - 0.005 / Math.sqrt(2)) < 1e-5);
  const quiet = sineBurst(0.005);
  const quietRms = correctedRms(quiet);
  const gate = new OnsetGate({ threshold: 0.01, calibrationMs: 100 });
  assert.equal(gate.process(quiet, 0).onset, false);
  assert.equal(gate.process(quiet, 50).onset, false);
  const calibrated = gate.process(quiet, 100);
  assert.equal(calibrated.calibrating, false);
  assert.ok(Math.abs(calibrated.noiseFloor - quietRms) < 1e-5);
  assert.equal(gate.process(quiet, 125).onset, false);
});

test('steady and gently fluctuating ambient noise is suppressed after startup calibration', () => {
  const gate = testGateWithAmbientNoise();
  assert.ok(gate.noiseFloor > 0.01);
  assert.ok(gate.noiseFloor < gate.threshold * 3);
  assert.ok(gate.noiseFloor * 2.5 > gate.threshold);
});

test('startup calibration estimates ordinary fluctuating room noise without requiring silence', () => {
  const gate = new OnsetGate({ threshold: 0.01 });
  for (let time = 0; time < DEFAULT_NOISE_CALIBRATION_MS; time += 25) {
    const result = gate.process(ambientAt(time), time);
    assert.equal(result.calibrating, true);
    assert.equal(result.onset, false);
  }
  const result = gate.process(ambientAt(DEFAULT_NOISE_CALIBRATION_MS), DEFAULT_NOISE_CALIBRATION_MS);
  assert.equal(result.calibrating, false);
  assert.equal(result.onset, false);
  assert.ok(result.noiseFloor > 0.01 && result.noiseFloor < 0.02);
  assert.ok(result.effectiveThreshold > result.noiseFloor);
});

test('obvious tap-like transients trigger once, rearm after background, and can trigger again', () => {
  const gate = testGateWithAmbientNoise();
  const click = clickTransient();
  assert.equal(gate.process(mixFrames(ambientAt(1625), click), 1625).onset, true);
  assert.equal(gate.process(mixFrames(ambientAt(1650), click), 1650).onset, false);
  assert.equal(gate.process(ambientAt(1675), 1675).onset, false);
  const quiet = new Float32Array(1024);
  assert.equal(gate.process(quiet, 1700).onset, false);
  for (const time of [1725, 1750, 1775, 1800]) assert.equal(gate.process(quiet, time).onset, false);
  assert.equal(gate.process(mixFrames(ambientAt(1825), click), 1825).onset, true);
});

test('brief ambient dips do not rearm the gate, while a later clear transient still triggers', () => {
  const gate = new OnsetGate({ threshold: 0.01, calibrationMs: 100, rearmQuietMs: 100 });
  for (const time of [0, 50, 100]) gate.process(sineBurst(0.002), time);
  assert.equal(gate.process(sineBurst(0.02), 125).onset, true);

  for (let time = 150; time <= 1500; time += 25) {
    const frame = Math.floor((time - 150) / 25) % 2 === 0
      ? sineBurst(0.004 * Math.SQRT2)
      : sineBurst(0.0135 * Math.SQRT2);
    assert.equal(gate.process(frame, time).onset, false, `ambient fluctuation retriggered at ${time} ms`);
  }

  for (let time = 1525; time <= 1625; time += 25) gate.process(sineBurst(0.004 * Math.SQRT2), time);
  assert.equal(gate.process(sineBurst(0.06), 1650).onset, true);
});

test('microphone restart can reset the noise calibration without losing the threshold', () => {
  const gate = new OnsetGate({ threshold: 0.018, calibrationMs: 50 });
  gate.process(sineBurst(0.01), 0);
  gate.process(sineBurst(0.01), 50);
  assert.equal(gate.noiseFloor, gate.process(sineBurst(0.01), 75).noiseFloor);
  gate.setThreshold(0.02);
  gate.reset();
  assert.equal(gate.threshold, 0.02);
  assert.equal(gate.noiseFloor, null);
  assert.equal(gate.process(sineBurst(0.03), 100).calibrating, true);
});

test('YHEventClient receives synthetic level and onset through the local OSC loopback bridge', async () => {
  const bridge = await startBridge({ wsHost: '127.0.0.1', wsPort: 0, oscHost: '127.0.0.1', oscPort: 0 });
  const client = new YHEventClient({ url: `ws://127.0.0.1:${bridge.address.wsPort}/ws`, WebSocketImpl: WebSocket });
  const received = [];
  client.on('*', event => received.push(event));
  try {
    await client.connect();
    assert.equal(client.sendControl('/yh/level', 0.625), true);
    assert.equal(client.sendControl('/yh/onset', 1), true);
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        if (received.some(event => event.address === '/yh/level') && received.some(event => event.address === '/yh/onset')) return resolve();
        if (Date.now() - start > 1500) return reject(new Error('Timed out waiting for synthetic YH events'));
        setTimeout(poll, 10);
      };
      poll();
    });
    const level = received.find(event => event.address === '/yh/level');
    const onset = received.find(event => event.address === '/yh/onset');
    assert.equal(level.value, 0.625);
    assert.equal(onset.value, 1);
    assert.equal(level.kind, 'event');
    assert.equal(onset.kind, 'event');
  } finally {
    client.close();
    await bridge.close();
  }
});
