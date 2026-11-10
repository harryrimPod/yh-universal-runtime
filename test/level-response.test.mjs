import test from 'node:test';
import assert from 'node:assert/strict';
import { YHLevelResponse } from '../src/adapters/level-response.js';

test('ordinary low-level fluctuations leave the scene at its steady rest level', () => {
  const response = new YHLevelResponse();
  const roomNoise = [0.03, 0.09, 0.06, 0.14, 0.08, 0.11, 0.05, 0.15, 0.07];
  roomNoise.forEach((level, index) => {
    response.set(level, index * 25);
    response.update(0.025);
  });
  assert.equal(response.active, false);
  assert.equal(response.target, 0.42);
  assert.equal(response.value, 0.42);
});

test('the scene threshold can rise with a measured noise floor without altering continuous level data', () => {
  const response = new YHLevelResponse({ attackMs: 0 });
  response.set(0.8, 0);
  assert.ok(response.target > response.restLevel);
  response.setThreshold(0.36);
  assert.equal(response.threshold, 0.36);
  assert.equal(response.releaseThreshold, 0.24);
  response.set(0.3, 10);
  assert.equal(response.target, response.restLevel);
  response.set(0.8, 20);
  assert.ok(response.target > response.restLevel);
});

test('brief level excursions do not open the gate, but sustained louder level does', () => {
  const response = new YHLevelResponse({ attackMs: 120 });
  response.set(0.5, 0);
  response.set(0.1, 50);
  response.set(0.5, 75);
  response.set(0.5, 194);
  assert.equal(response.active, false);
  response.set(0.5, 195);
  assert.equal(response.active, true);
  assert.ok(response.target > response.restLevel);
});

test('hysteresis prevents chatter and requires a sustained quiet period to close', () => {
  const response = new YHLevelResponse({ attackMs: 0, releaseMs: 180 });
  response.set(0.8, 0);
  assert.equal(response.active, true);
  response.set(0.1, 10);
  response.set(0.13, 100);
  response.set(0.1, 150);
  assert.equal(response.active, true);
  response.set(0.1, 330);
  assert.equal(response.active, false);
  assert.equal(response.target, response.restLevel);
});

test('scene response is smoothed and reaches a meaningful louder target', () => {
  const response = new YHLevelResponse({ attackMs: 0 });
  response.set(0.8, 0);
  const first = response.update(0.025);
  assert.ok(first > response.restLevel && first < response.target);
  response.update(2);
  assert.ok(Math.abs(response.value - response.target) < 1e-4);
});
