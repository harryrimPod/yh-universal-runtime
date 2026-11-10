import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBridgeUrl } from '../src/bridge-url.mjs';

const at = (url) => { const { protocol, hostname, host, search } = new URL(url); return resolveBridgeUrl({ protocol, hostname, host, search }); };

test('a page served over http keeps using the bridge port on its own host', () => {
  assert.equal(at('http://127.0.0.1:5173/'), 'ws://127.0.0.1:8765/ws');
  assert.equal(at('http://stage-pc.local:5173/?token=a'), 'ws://stage-pc.local:8765/ws');
  assert.equal(resolveBridgeUrl({ protocol: 'file:', hostname: '', host: '', search: '' }), 'ws://127.0.0.1:8765/ws');
});

test('a hosted https page uses its own origin /ws, since a secure page cannot open ws:// to a remote host', () => {
  assert.equal(at('https://yh.example.com/'), 'wss://yh.example.com/ws');
  assert.equal(at('https://yh.example.com:8443/show/?token=a'), 'wss://yh.example.com:8443/ws');
});

test('?bridge= can point a hosted page at a local bridge or its own host, and nothing else', () => {
  assert.equal(at('https://yh.example.com/?bridge=ws://127.0.0.1:8765/ws'), 'ws://127.0.0.1:8765/ws');
  assert.equal(at('https://yh.example.com/?bridge=ws://localhost:9000/ws'), 'ws://localhost:9000/ws');
  assert.equal(at('https://yh.example.com/?bridge=wss://yh.example.com/relay'), 'wss://yh.example.com/relay');
  assert.equal(at('https://yh.example.com/?bridge=wss://evil.example.net/ws'), 'wss://yh.example.com/ws');
  assert.equal(at('https://yh.example.com/?bridge=ws://127.0.0.1.evil.net/ws'), 'wss://yh.example.com/ws');
  assert.equal(at('https://yh.example.com/?bridge=http://127.0.0.1:8765/ws'), 'wss://yh.example.com/ws');
  assert.equal(at('https://yh.example.com/?bridge=ws://user:pw@127.0.0.1:8765/ws'), 'wss://yh.example.com/ws');
  assert.equal(at('https://yh.example.com/?bridge=not-a-url'), 'wss://yh.example.com/ws');
});
