import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NullEngine, Scene, TransformNode, Animation, AnimationGroup } from '@babylonjs/core';
import { YHAnimationRouter } from '../src/adapters/animation-router.js';
import { YHThreeAdapter } from '../src/adapters/three.js';
import { createBabylonAnimationDriver, createCallbackDriver, createThreeAnimationDriver } from '../src/adapters/animation-drivers.js';

class FakeClient {
  handlers = new Map();
  on(address, handler) { const list = this.handlers.get(address) || new Set(); list.add(handler); this.handlers.set(address, list); return () => list.delete(handler); }
  emit(address, value, sourceId = null) { for (const handler of [...(this.handlers.get(address) || [])]) handler({ address, value, sourceId }); }
  emitStatus(status) { for (const handler of [...(this.handlers.get('status') || [])]) handler(status); }
}

function threeRig() {
  const object = new THREE.Object3D();
  const clip = new THREE.AnimationClip('Jump', 1, [new THREE.NumberKeyframeTrack('.position[y]', [0, 0.5, 1], [0, 2, 0])]);
  const mixer = new THREE.AnimationMixer(object);
  return { object, clip, mixer, driver: createThreeAnimationDriver({ mixer, clips: [clip] }) };
}

test('onset trigger plays a real Three.js AnimationClip once, scaled by intensity, honouring minValue and cooldown', () => {
  const { object, mixer, driver } = threeRig();
  const client = new FakeClient();
  let clock = 0;
  const router = new YHAnimationRouter(client, driver, [{ type: 'trigger', address: '/yh/onset', clip: 'Jump', cooldownMs: 100, minValue: 0.5 }], { now: () => clock });
  client.emit('/yh/onset', 0.2);
  assert.equal(driver.actions.size, 0, 'below minValue must not touch the mixer');
  client.emit('/yh/onset', 1);
  const action = driver.actions.get('Jump');
  assert.ok(action.isRunning());
  router.update(0.5);
  assert.ok(Math.abs(object.position.y - 2) < 1e-6, `y=${object.position.y}`);
  clock = 50;
  client.emit('/yh/onset', 1);
  assert.equal(router.stats.suppressed, 2);
  clock = 200;
  client.emit('/yh/onset', 0.5);
  assert.ok(Math.abs(action.getEffectiveWeight() - 0.5) < 1e-9, 'intensity maps to weight');
  assert.equal(router.stats.triggered, 2);
  router.update(0.1);
  assert.ok(mixer.time > 0);
});

test('rules ignore events whose value is not a finite number instead of firing or zeroing', () => {
  const calls = []; const params = [];
  const driver = createCallbackDriver({ trigger: name => { calls.push(name); return true; }, setParam: (name, value) => params.push([name, value]) });
  const client = new FakeClient();
  const router = new YHAnimationRouter(client, driver, [
    { type: 'trigger', address: '/yh/onset', clip: 'Jump', minValue: 0 },
    { type: 'param', address: '/yh/level', param: 'Jump:weight', smoothing: 0 },
    { type: 'gate', address: '/yh/band/low', threshold: 0.5, releaseThreshold: 0.3, attackMs: 0, releaseMs: 0, onEnter: 'Wave', onExit: 'Idle' }
  ]);
  for (const bad of [null, NaN, Infinity]) {
    client.emit('/yh/onset', bad);
    client.emit('/yh/level', bad);
    client.emit('/yh/band/low', bad);
  }
  router.update(0.016);
  assert.deepEqual(calls, []);
  assert.equal(router.stats.triggered, 0);
  assert.equal(router.stats.suppressed, 3);
  client.emit('/yh/onset', undefined);
  assert.deepEqual(calls, ['Jump'], 'a bare onset still triggers');
});

test('Three.js clips start at the end in reverse and repeat in the selected direction', () => {
  const root = new THREE.Object3D();
  const clip = new THREE.AnimationClip('Slide', 1, [new THREE.NumberKeyframeTrack('.position[x]', [0, 1], [0, 4])]);
  const mixer = new THREE.AnimationMixer(root);
  const driver = createThreeAnimationDriver({ mixer, clips: [clip] });
  driver.trigger('Slide', { reverse: true });
  driver.update(0.25);
  assert.equal(root.position.x, 3);
  driver.update(1);
  assert.equal(root.position.x, 0);
  assert.equal(driver.actions.get('Slide').isRunning(), false);

  driver.trigger('Slide', { loop: 'repeat', reverse: true });
  driver.update(1.25);
  assert.equal(root.position.x, 3);
  assert.equal(driver.actions.get('Slide').isRunning(), true);
  driver.trigger('Slide', { reverse: false });
  driver.update(0.25);
  assert.equal(root.position.x, 1);
});

test('param rule drives clip weight and timeScale from continuous levels without touching the stream', () => {
  const { driver } = threeRig();
  const client = new FakeClient();
  const router = new YHAnimationRouter(client, driver, [
    { type: 'param', address: '/yh/level', param: 'Jump:weight', smoothing: 0 },
    { type: 'param', address: '/yh/band/low', param: 'Jump:timeScale', min: 0.5, max: 2, smoothing: 0 }
  ]);
  client.emit('/yh/level', 0.6);
  client.emit('/yh/band/low', 1);
  router.update(0.016);
  const action = driver.actions.get('Jump');
  assert.ok(action.isRunning());
  assert.ok(Math.abs(action.getEffectiveWeight() - 0.6) < 1e-9);
  assert.ok(Math.abs(action.getEffectiveTimeScale() - 2) < 1e-9);
});

test('gate rule fires enter and exit clips on sustained loud/quiet levels, and sourceId filtering isolates a source', () => {
  const calls = [];
  const driver = createCallbackDriver({ trigger: (name) => { calls.push(name); return true; }, setParam: () => {} });
  const client = new FakeClient();
  const router = new YHAnimationRouter(client, driver, [
    { type: 'gate', address: '/yh/level', threshold: 0.5, releaseThreshold: 0.3, attackMs: 0, releaseMs: 0, onEnter: 'Wave', onExit: 'Idle', sourceId: 'cables' }
  ], { now: () => 0 });
  client.emit('/yh/level', 0.9, 'mic');
  assert.deepEqual(calls, []);
  assert.equal(router.stats.ignoredSource, 1);
  client.emit('/yh/level', 0.9, 'cables');
  client.emit('/yh/level', 0.95, 'cables');
  client.emit('/yh/level', 0.1, 'cables');
  assert.deepEqual(calls, ['Wave', 'Idle']);
  router.dispose();
  client.emit('/yh/level', 0.9, 'cables');
  assert.deepEqual(calls, ['Wave', 'Idle']);
});

test('a lost connection exits an active gate once and eases param rules back to min; a reconnect works again', () => {
  const calls = [];
  const params = [];
  const driver = createCallbackDriver({ trigger: name => { calls.push(name); return true; }, setParam: (name, value) => params.push([name, value]) });
  const client = new FakeClient();
  const router = new YHAnimationRouter(client, driver, [
    { type: 'gate', address: '/yh/level', threshold: 0.5, releaseThreshold: 0.3, attackMs: 0, releaseMs: 0, onEnter: 'Wave', onExit: 'Idle' },
    { type: 'param', address: '/yh/level', param: 'Walk:weight', smoothing: 0 }
  ], { now: () => 0 });
  client.emit('/yh/level', 0.9);
  client.emit('/yh/level', 0.9);
  router.update(0.016);
  assert.deepEqual(calls, ['Wave']);
  assert.equal(params.at(-1)[1], 0.9);
  client.emitStatus({ status: 'disconnected', code: 1006 });
  client.emitStatus({ status: 'reconnecting', attempt: 1 });
  assert.deepEqual(calls, ['Wave', 'Idle'], 'gate exits exactly once');
  router.update(0.016);
  assert.equal(params.at(-1)[1], 0, 'param rule returns to its min');
  client.emit('/yh/level', 0.9);
  client.emit('/yh/level', 0.9);
  router.update(0.016);
  assert.deepEqual(calls, ['Wave', 'Idle', 'Wave']);
  assert.equal(params.at(-1)[1], 0.9);
});

test('one final zero level exits an active gate with the default timers, with no further events and the bridge still online', () => {
  const calls = [];
  const driver = createCallbackDriver({ trigger: name => { calls.push(name); return true; }, setParam() {} });
  const client = new FakeClient();
  let clock = 0;
  const router = new YHAnimationRouter(client, driver, [
    { type: 'gate', address: '/yh/level', threshold: 0.5, onEnter: 'Wave', onExit: 'Idle' }
  ], { now: () => clock });
  for (clock = 0; clock <= 300; clock += 25) { client.emit('/yh/level', 0.9); router.update(0.025); }
  assert.deepEqual(calls, ['Wave']);
  client.emit('/yh/level', 0);
  const zeroAt = clock;
  clock = zeroAt + 100; router.update(0.1);
  assert.deepEqual(calls, ['Wave'], 'the 180 ms release delay has not elapsed yet');
  clock = zeroAt + 800; router.update(0.7);
  assert.deepEqual(calls, ['Wave', 'Idle']);
  clock += 800; router.update(0.8);
  assert.deepEqual(calls, ['Wave', 'Idle'], 'exits exactly once');
});

test('a level held above the threshold still enters the gate after the attack delay without a second event', () => {
  const calls = [];
  const driver = createCallbackDriver({ trigger: name => { calls.push(name); return true; }, setParam() {} });
  const client = new FakeClient();
  let clock = 0;
  const router = new YHAnimationRouter(client, driver, [
    { type: 'gate', address: '/yh/level', threshold: 0.5, onEnter: 'Wave', onExit: 'Idle' }
  ], { now: () => clock });
  client.emit('/yh/level', 0.9);
  clock = 60; router.update(0.06);
  assert.deepEqual(calls, []);
  clock = 200; router.update(0.14);
  assert.deepEqual(calls, ['Wave']);
});

test('staleMs releases a rule whose address went silent, but only when configured', () => {
  const run = options => {
    const calls = [];
    const params = [];
    const driver = createCallbackDriver({ trigger: name => { calls.push(name); return true; }, setParam: (name, value) => params.push(value) });
    const client = new FakeClient();
    let clock = 0;
    const router = new YHAnimationRouter(client, driver, [
      { type: 'gate', address: '/yh/level', threshold: 0.5, attackMs: 0, releaseMs: 0, onEnter: 'Wave', onExit: 'Idle' },
      { type: 'param', address: '/yh/level', param: 'Walk:weight', smoothing: 0 }
    ], { now: () => clock, ...options });
    client.emit('/yh/level', 0.9); client.emit('/yh/level', 0.9);
    router.update(0.016);
    clock = 1000;
    router.update(0.016);
    return { calls, last: params.at(-1) };
  };
  assert.deepEqual(run({ staleMs: 500 }), { calls: ['Wave', 'Idle'], last: 0 });
  assert.deepEqual(run({}), { calls: ['Wave'], last: 0.9 });
});

test('a zero-threshold gate stays released after a disconnect or a stale timeout until a new event arrives', () => {
  for (const mode of ['disconnect', 'stale']) {
    const calls = [];
    const driver = createCallbackDriver({ trigger: name => { calls.push(name); return true; }, setParam() {} });
    const client = new FakeClient();
    let clock = 0;
    const router = new YHAnimationRouter(client, driver, [
      { type: 'gate', address: '/yh/level', threshold: 0, releaseThreshold: 0, attackMs: 0, releaseMs: 0, onEnter: 'Wave', onExit: 'Idle' }
    ], { now: () => clock, staleMs: mode === 'stale' ? 500 : 0 });
    client.emit('/yh/level', 0.6);
    router.update(0.016);
    assert.deepEqual(calls, ['Wave'], mode);
    if (mode === 'disconnect') client.emitStatus({ status: 'disconnected', code: 1006 });
    else clock = 1000;
    for (let i = 0; i < 20; i++) { clock += 50; router.update(0.05); }
    assert.deepEqual(calls, ['Wave', 'Idle'], `${mode}: one exit, then nothing until the stream returns`);
    client.emit('/yh/level', 0.6);
    router.update(0.016);
    assert.deepEqual(calls, ['Wave', 'Idle', 'Wave'], `${mode}: a new event re-enters`);
  }
});

test('a model with its own scale track keeps its animation when YH scales an outer Group (real AnimationMixer)', () => {
  const model = new THREE.Object3D();
  model.scale.set(1, 2, 3);
  const audioRoot = new THREE.Group();
  audioRoot.add(model);
  const clip = new THREE.AnimationClip('Grow', 1, [new THREE.VectorKeyframeTrack('.scale', [0, 1], [3, 6, 9, 3, 6, 9])]);
  const mixer = new THREE.AnimationMixer(model);
  const client = new FakeClient();
  const adapter = new YHThreeAdapter(client, audioRoot, { levelAttackMs: 0 });
  const step = delta => { mixer.update(delta); adapter.update(delta); };

  client.emit('/yh/level', 0.8);
  step(1);
  step(3);
  const audio = audioRoot.scale.x;
  assert.ok(audio > 1.3, `audio enlarged the group (${audio})`);

  const action = mixer.clipAction(clip);
  action.setEffectiveWeight(0.5).play();
  step(0.1);
  for (const [axis, expected] of [['x', 2], ['y', 4], ['z', 6]]) {
    assert.ok(Math.abs(model.scale[axis] - expected) < 1e-9, `model ${axis}=${model.scale[axis]}, the animation alone blends to ${expected}`);
  }
  assert.ok(Math.abs(audioRoot.scale.x - audio) < 1e-6, 'the animation does not leak into the audio scale');

  action.stop();
  step(0.1);
  assert.deepEqual([model.scale.x, model.scale.y, model.scale.z], [1, 2, 3], 'a stopped animation returns the model to its own rest scale, not the audio-scaled one');

  adapter.dispose();
  assert.deepEqual([audioRoot.scale.x, audioRoot.scale.y, audioRoot.scale.z], [1, 1, 1]);
  assert.deepEqual([model.scale.x, model.scale.y, model.scale.z], [1, 2, 3]);
});

test('param rule can write to any property through apply(), e.g. a material parameter', () => {
  const material = { emissiveIntensity: 0 };
  const client = new FakeClient();
  const router = new YHAnimationRouter(client, createCallbackDriver(), [
    { type: 'param', address: '/yh/band/high', apply: value => { material.emissiveIntensity = value; }, min: 0, max: 3, smoothing: 0 }
  ]);
  client.emit('/yh/band/high', 0.5);
  router.update(0.016);
  assert.ok(Math.abs(material.emissiveIntensity - 1.5) < 1e-9);
});

test('router rejects malformed rules and drivers instead of silently doing nothing', () => {
  const client = new FakeClient();
  assert.throws(() => new YHAnimationRouter(client, {}, []), /driver/);
  assert.throws(() => new YHAnimationRouter(client, createCallbackDriver(), [{ type: 'nope', address: '/yh/level' }]), /Unknown rule type/);
  assert.throws(() => new YHAnimationRouter(client, createCallbackDriver(), [{ type: 'trigger', address: '/yh/onset' }]), /clip or run/);
});

test('unknown clip names are reported by trigger() returning false', () => {
  const { driver } = threeRig();
  assert.equal(driver.trigger('Missing'), false);
});

test('Babylon.js AnimationGroup driver plays, weights and speeds real groups on a NullEngine scene', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const node = new TransformNode('target', scene);
  const animation = new Animation('rise', 'position.y', 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
  animation.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 2 }]);
  const group = new AnimationGroup('Rise', scene);
  group.addTargetedAnimation(animation, node);
  const driver = createBabylonAnimationDriver({ scene });
  try {
    assert.equal(driver.trigger('Missing'), false);
    assert.equal(driver.trigger('Rise', { intensity: 0.5 }), true);
    assert.equal(group.isPlaying, true);
    assert.ok(Math.abs(group.animatables[0].weight - 0.5) < 1e-9);
    driver.setParam('Rise:speed', 2);
    assert.equal(group.speedRatio, 2);
    driver.setParam('Rise:weight', 0.25);
    assert.ok(Math.abs(group.animatables[0].weight - 0.25) < 1e-9);
  } finally {
    group.dispose();
    scene.dispose();
    engine.dispose();
  }
});
