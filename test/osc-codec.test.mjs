import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOSCPacket, encodeOSCMessage } from '../src/osc-codec.mjs';

function makeBundle(...packets) {
  const header = Buffer.alloc(16); Buffer.from('#bundle\0').copy(header); header.writeBigUInt64BE(1n, 8);
  const elements = packets.flatMap(packet => { const size = Buffer.alloc(4); size.writeInt32BE(packet.length); return [size, packet]; });
  return Buffer.concat([header, ...elements]);
}

test('OSC float message round-trips with padded address and type tags', () => {
  const packet = encodeOSCMessage('/yh/level', [0.625]);
  const [decoded] = decodeOSCPacket(packet);
  assert.equal(decoded.address, '/yh/level');
  assert.equal(decoded.typeTags, 'f');
  assert.equal(decoded.args[0], 0.625);
});

test('OSC supports int, float64, string, boolean and null arguments', () => {
  const strings = value => {
    const body = Buffer.from(`${value}\0`), out = Buffer.alloc((body.length + 3) & ~3); body.copy(out); return out;
  };
  const address = strings('/test/types');
  const tags = strings(',ifdsTFN');
  const number = Buffer.alloc(4); number.writeInt32BE(7);
  const float = Buffer.alloc(4); float.writeFloatBE(0.5);
  const dbl = Buffer.alloc(8); dbl.writeDoubleBE(3.25);
  const str = strings('hello');
  const packet = Buffer.concat([address, tags, number, float, dbl, str]);
  const [decoded] = decodeOSCPacket(packet);
  assert.equal(decoded.typeTags, 'ifdsTFN');
  assert.deepEqual(decoded.args, [7, 0.5, 3.25, 'hello', true, false, null]);
});

test('OSC bundle recursively decodes messages in order', () => {
  const bundle = makeBundle(encodeOSCMessage('/a', [0.1]), makeBundle(encodeOSCMessage('/b', [2])));
  const decoded = decodeOSCPacket(bundle);
  assert.deepEqual(decoded.map(item => item.address), ['/a', '/b']);
  assert.ok(Math.abs(decoded[0].args[0] - 0.1) < 1e-6);
  assert.equal(decoded[1].args[0], 2);
});

test('invalid OSC packets are rejected clearly', () => {
  assert.throws(() => decodeOSCPacket(Buffer.from('oops')), /too short|Invalid OSC address|string missing/);
  assert.throws(() => encodeOSCMessage('no-slash', [1]), /address must start/);
  assert.throws(() => decodeOSCPacket(Buffer.from('/x\0\0,z\0\0')), /Unsupported OSC type/);
});
