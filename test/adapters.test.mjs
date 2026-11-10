import test from 'node:test';
import assert from 'node:assert/strict';
import { YHThreeAdapter } from '../src/adapters/three.js';
import { YHVerge3DAdapter } from '../src/adapters/verge3d.js';
import { YHBabylonAdapter } from '../src/adapters/babylonjs.js';

class FakeClient {
  handlers = new Map();
  on(address, handler) { const list = this.handlers.get(address) || new Set(); list.add(handler); this.handlers.set(address, list); return () => list.delete(handler); }
  emit(address, value) { for (const handler of this.handlers.get(address) || []) handler({ address, value }); }
  emitStatus(status) { for (const handler of this.handlers.get('status') || []) handler(status); }
}
const fakeScale = (x = 1, y = x, z = x) => ({ x, y, z, setScalar(value) { this.x = value; this.y = value; this.z = value; }, set(nx, ny, nz) { this.x = nx; this.y = ny; this.z = nz; } });

// Absolute scale of the legacy driver at the default rest level; relative mode divides by it.
const REST_ABSOLUTE = 0.68 + 0.42 * (1.75 - 0.68);
const factor = absolute => absolute / REST_ABSOLUTE;

for (const [name, Adapter, makeTarget, vectorOf] of [
  ['Three.js', YHThreeAdapter, scale => ({ scale: fakeScale(...scale) }), target => target.scale],
  ['Verge3D', YHVerge3DAdapter, scale => ({ scale: fakeScale(...scale) }), target => target.scale],
  ['Babylon.js', YHBabylonAdapter, scale => ({ scaling: fakeScale(...scale) }), target => target.scaling]
]) {
  test(`${name} adapter ignores ordinary low-level fluctuations without altering the level stream`, () => {
    const client = new FakeClient();
    const target = makeTarget([1]);
    const adapter = new Adapter(client, target);
    const vector = vectorOf(target);
    for (const value of [0.03, 0.09, 0.06, 0.14, 0.08, 0.11, 0.05, 0.15, 0.07]) {
      client.emit('/yh/level', value);
      adapter.update(0.025);
    }
    assert.equal(adapter.level, 0.07);
    assert.ok(Math.abs(vector.x - 1) < 1e-12);
    assert.ok(Math.abs(vector.y - 1) < 1e-12);
    assert.ok(Math.abs(vector.z - 1) < 1e-12);
    adapter.dispose();
  });

  test(`${name} adapter accepts a higher noise-calibrated scene threshold`, () => {
    const client = new FakeClient();
    const target = makeTarget([1]);
    const adapter = new Adapter(client, target, { levelAttackMs: 0 });
    const vector = vectorOf(target);
    assert.equal(adapter.setLevelThreshold(0.36), 0.36);
    client.emit('/yh/level', 0.3);
    adapter.update(0.5);
    assert.equal(adapter.level, 0.3);
    assert.ok(Math.abs(vector.x - 1) < 1e-12);
    client.emit('/yh/level', 0.8);
    adapter.update(0.5);
    assert.ok(vector.x > 1 + 0.4 / REST_ABSOLUTE);
    adapter.dispose();
  });

  test(`${name} adapter smoothly responds to louder level and keeps onset pulse independent`, () => {
    const client = new FakeClient();
    const target = makeTarget([1]);
    const adapter = new Adapter(client, target, { levelAttackMs: 0 });
    const vector = vectorOf(target);
    client.emit('/yh/level', 0.8);
    adapter.update(0.025);
    assert.ok(vector.x > 1 && vector.x < factor(1.75));
    adapter.update(1);
    const louderScale = vector.x;
    assert.ok(louderScale > 1 + 0.4 / REST_ABSOLUTE);

    client.emit('/yh/level', 0.1);
    client.emit('/yh/onset', 1);
    assert.ok(vector.x > louderScale + 0.59 / REST_ABSOLUTE);
    adapter.update(0.2);
    assert.ok(vector.x > 1 && vector.x < louderScale + 0.6 / REST_ABSOLUTE);
    adapter.update(2);
    assert.ok(Math.abs(vector.x - 1) < 1e-9);
    adapter.dispose();
  });

  test(`${name} adapter keeps an imported object's size and non-uniform proportions, and restores them on dispose`, () => {
    const client = new FakeClient();
    const target = makeTarget([2, 0.5, 1]);
    const adapter = new Adapter(client, target, { levelAttackMs: 0 });
    const vector = vectorOf(target);
    assert.deepEqual([vector.x, vector.y, vector.z], [2, 0.5, 1]);
    client.emit('/yh/level', 0.9);
    adapter.update(1);
    assert.ok(vector.x > 2);
    assert.ok(Math.abs(vector.x / vector.y - 4) < 1e-9);
    assert.ok(Math.abs(vector.x / vector.z - 2) < 1e-9);
    adapter.dispose();
    assert.deepEqual([vector.x, vector.y, vector.z], [2, 0.5, 1]);
  });

  test(`${name} adapter stops driving the object after dispose even if the frame loop keeps calling update`, () => {
    const client = new FakeClient();
    const target = makeTarget([1.5]);
    const adapter = new Adapter(client, target, { levelAttackMs: 0 });
    const vector = vectorOf(target);
    adapter.dispose();
    vector.set(3, 3, 3);
    client.emit('/yh/onset', 1);
    adapter.update(0.1);
    assert.equal(vector.x, 3);
  });

  test(`${name} adapter ignores events whose value is not a finite number, but still treats a bare onset as full strength`, () => {
    const client = new FakeClient();
    const target = makeTarget([1]);
    const adapter = new Adapter(client, target, { levelAttackMs: 0 });
    const vector = vectorOf(target);
    const rest = vector.x;
    for (const bad of [null, NaN, Infinity, -Infinity, 'abc']) {
      client.emit('/yh/onset', bad);
      client.emit('/yh/level', bad);
      adapter.update(0.025);
      assert.equal(adapter.pulse, 0, `onset ${String(bad)} must not pulse`);
      assert.equal(adapter.level, 0.42, `level ${String(bad)} must not move the level`);
      assert.equal(vector.x, rest);
    }
    client.emit('/yh/onset', undefined);
    assert.equal(adapter.pulse, 1, 'an onset sent without a value is a plain trigger');
    adapter.dispose();
  });

  test(`${name} adapter keeps the legacy absolute mode when requested`, () => {
    const client = new FakeClient();
    const target = makeTarget([2, 0.5, 1]);
    const adapter = new Adapter(client, target, { scaleMode: 'absolute' });
    const vector = vectorOf(target);
    assert.ok(Math.abs(vector.x - REST_ABSOLUTE) < 1e-12);
    assert.ok(Math.abs(vector.y - REST_ABSOLUTE) < 1e-12);
    adapter.dispose();
  });

  test(`${name} adapter eases back to rest when the client reports a lost connection, and responds again after`, () => {
    const client = new FakeClient();
    const target = makeTarget([2, 1, 1]);
    const adapter = new Adapter(client, target, { levelAttackMs: 0 });
    const vector = vectorOf(target);
    client.emit('/yh/level', 1);
    adapter.update(2);
    assert.ok(vector.x > 3, `loud level should enlarge the object, x=${vector.x}`);
    client.emitStatus({ status: 'disconnected', code: 1006 });
    adapter.update(2);
    assert.ok(Math.abs(vector.x - 2) < 1e-6 && Math.abs(vector.y - 1) < 1e-6, `x=${vector.x} y=${vector.y}`);
    client.emit('/yh/level', 1);
    adapter.update(2);
    assert.ok(vector.x > 3, 'a reconnected stream drives the object again');
    adapter.dispose();
  });

  test(`${name} adapter releases when /yh/level goes silent for levelStaleMs, and holds when levelStaleMs is 0`, () => {
    let clock = 0;
    const make = options => {
      const client = new FakeClient();
      const target = makeTarget([1]);
      const adapter = new Adapter(client, target, { levelAttackMs: 0, now: () => clock, ...options });
      return { client, adapter, vector: vectorOf(target) };
    };
    const stale = make({ levelStaleMs: 500 });
    const held = make({});
    for (const rig of [stale, held]) { rig.client.emit('/yh/level', 1); rig.adapter.update(2); }
    assert.ok(stale.vector.x > 1.3 && held.vector.x > 1.3);
    clock = 400;
    stale.adapter.update(2);
    assert.ok(stale.vector.x > 1.3, 'not stale yet');
    clock = 700;
    stale.adapter.update(2); held.adapter.update(2);
    assert.ok(Math.abs(stale.vector.x - 1) < 1e-6, `stale x=${stale.vector.x}`);
    assert.ok(held.vector.x > 1.3, 'levelStaleMs 0 keeps the last level');
    stale.adapter.dispose(); held.adapter.dispose();
  });

  test(`${name} adapter adopts a scale written by another system as the new rest pose and does not clobber it on dispose`, () => {
    const client = new FakeClient();
    const target = makeTarget([2, 1, 1]);
    const adapter = new Adapter(client, target);
    const vector = vectorOf(target);
    vector.set(4, 2, 2);
    adapter.update(0.016);
    assert.ok(Math.abs(vector.x - 4) < 1e-9 && Math.abs(vector.y - 2) < 1e-9, `x=${vector.x} y=${vector.y}`);
    adapter.update(0.016);
    assert.ok(Math.abs(vector.x - 4) < 1e-9, 'the adopted pose is stable across frames');
    vector.set(6, 3, 3);
    adapter.dispose();
    assert.deepEqual([vector.x, vector.y, vector.z], [6, 3, 3]);
  });

  test(`${name} adapter can opt out of following external scale writes`, () => {
    const client = new FakeClient();
    const target = makeTarget([2, 1, 1]);
    const adapter = new Adapter(client, target, { followExternalScale: false });
    const vector = vectorOf(target);
    vector.set(4, 2, 2);
    adapter.update(0.016);
    assert.ok(Math.abs(vector.x - 2) < 1e-9, `x=${vector.x}`);
    adapter.dispose();
  });

  test(`${name} adapter rejects scale ranges that would divide by zero or produce NaN`, () => {
    for (const options of [{ minScale: 0, maxScale: 0 }, { minScale: NaN }, { maxScale: Infinity }, { minScale: 2, maxScale: 1 }, { minScale: -1, maxScale: 0 }]) {
      const target = makeTarget([1]);
      assert.throws(() => new Adapter(new FakeClient(), target, options), RangeError, JSON.stringify(options));
      const vector = vectorOf(target);
      assert.deepEqual([vector.x, vector.y, vector.z], [1, 1, 1], 'a rejected construction must not touch the object');
    }
  });
}
