import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { YHEventClient } from '../src/event-client.mjs';
import { isLoopbackHost, startBridge } from '../src/server.mjs';

const serverEntry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const local = { wsHost: '127.0.0.1', wsPort: 0, oscHost: '127.0.0.1', oscPort: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000, message = 'condition') {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${message}`);
    await sleep(10);
  }
}

function connectClient(bridge, options = {}) {
  return new YHEventClient({ url: `ws://127.0.0.1:${bridge.address.wsPort}/ws`, WebSocketImpl: WebSocket, ...options });
}

test('running src/server.mjs directly starts the bridge (npm run bridge entry point)', async () => {
  const child = spawn(process.execPath, [serverEntry], { env: { ...process.env, WS_PORT: '0', OSC_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitFor(() => /WebSocket listening/.test(output) || child.exitCode !== null, 5000, 'bridge banner');
    assert.equal(child.exitCode, null, `bridge exited early: ${output}`);
    assert.match(output, /OSC\/UDP listening at 127\.0\.0\.1:\d+/);
    const port = /ws:\/\/127\.0\.0\.1:(\d+)\/ws/.exec(output)?.[1];
    assert.ok(port, `could not read the WebSocket port from: ${output}`);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.protocol, 1);
    assert.equal(health.authRequired, false);
  } finally {
    child.kill();
  }
});

test('bridge refuses to expose the WebSocket or OSC beyond loopback without explicit opt-in', async () => {
  await assert.rejects(() => startBridge({ ...local, wsHost: '0.0.0.0' }), /YH_TOKEN/);
  await assert.rejects(() => startBridge({ ...local, oscHost: '0.0.0.0' }), /YH_ALLOW_REMOTE_OSC/);
  await assert.rejects(() => startBridge({ ...local, sourcePolicy: 'bogus' }), /sourcePolicy/);
});

test('loopback protection accepts only localhost or literal loopback IPs, not 127-prefixed hostnames', async () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.255.255.254', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['127.stage.example', '127.0.0.1.example', '127', 'localhost.example', '0.0.0.0', '192.168.1.2']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
  await assert.rejects(() => startBridge({ ...local, wsHost: '127.stage.example' }), /YH_TOKEN/);
  await assert.rejects(() => startBridge({ ...local, oscHost: '127.stage.example' }), /YH_ALLOW_REMOTE_OSC/);
});

test('maxTrackedSources must be a positive integer', async () => {
  for (const value of [NaN, Infinity, -1, 0, 1.5, '8']) {
    await assert.rejects(async () => {
      const bridge = await startBridge({ ...local, maxTrackedSources: value });
      await bridge.close();
    }, RangeError, `maxTrackedSources=${value}`);
  }
});

test('token option rejects missing or wrong tokens and accepts the right one', async () => {
  const bridge = await startBridge({ ...local, token: 'secret-token' });
  try {
    const denied = connectClient(bridge, { autoReconnect: false, connectTimeoutMs: 1500 });
    await assert.rejects(() => denied.connect());
    denied.close();
    const wrong = connectClient(bridge, { token: 'nope', autoReconnect: false, connectTimeoutMs: 1500 });
    await assert.rejects(() => wrong.connect());
    wrong.close();
    const good = connectClient(bridge, { token: 'secret-token', autoReconnect: false });
    await good.connect();
    assert.equal(good.connected, true);
    good.close();
    const health = await (await fetch(`http://127.0.0.1:${bridge.address.wsPort}/health`)).json();
    assert.equal(health.authRequired, true);
    assert.equal(health.protocol, 1);
  } finally {
    await bridge.close();
  }
});

test('events carry the sender sourceId through the OSC loopback, and every sender gets one', async () => {
  const bridge = await startBridge(local);
  const sender = connectClient(bridge, { sourceId: 'cables', autoReconnect: false });
  const anonymous = connectClient(bridge, { autoReconnect: false });
  const received = [];
  anonymous.on('/yh/level', event => received.push(event));
  try {
    await Promise.all([sender.connect(), anonymous.connect()]);
    sender.sendControl('/yh/level', 0.5);
    anonymous.sendControl('/yh/level', 0.25);
    await waitFor(() => received.length >= 2, 3000, 'two level events');
    const bySource = Object.fromEntries(received.map(event => [event.sourceId, event.value]));
    assert.equal(bySource.cables, 0.5);
    const anonymousId = Object.keys(bySource).find(id => id !== 'cables');
    assert.match(anonymousId, /^ws-\d+$/);
    assert.equal(bySource[anonymousId], 0.25);
    assert.equal(received[0].value, received[0].args[0]);
  } finally {
    sender.close(); anonymous.close();
    await bridge.close();
  }
});

test('exclusive source policy keeps one owner and hands over after the owner goes quiet', async () => {
  const bridge = await startBridge({ ...local, sourcePolicy: 'exclusive', sourceTimeoutMs: 200 });
  const first = connectClient(bridge, { sourceId: 'mic', autoReconnect: false });
  const second = connectClient(bridge, { sourceId: 'cables', autoReconnect: false });
  const listener = connectClient(bridge, { autoReconnect: false });
  const received = [];
  listener.on('/yh/level', event => received.push(event.sourceId));
  try {
    await Promise.all([first.connect(), second.connect(), listener.connect()]);
    first.sendControl('/yh/level', 0.1);
    await waitFor(() => received.length === 1, 3000, 'first owner event');
    second.sendControl('/yh/level', 0.9);
    await sleep(80);
    assert.deepEqual(received, ['mic']);
    assert.equal(bridge.stats().droppedBySource, 1);
    await sleep(250);
    second.sendControl('/yh/level', 0.9);
    await waitFor(() => received.length === 2, 3000, 'handover');
    assert.deepEqual(received, ['mic', 'cables']);
    assert.equal(bridge.stats().owner, 'cables');
  } finally {
    first.close(); second.close(); listener.close();
    await bridge.close();
  }
});

test('exclusive policy tells the sender when its event was dropped, and only that sender', async () => {
  const bridge = await startBridge({ ...local, sourcePolicy: 'exclusive', sourceTimeoutMs: 5000 });
  const owner = connectClient(bridge, { sourceId: 'cables', autoReconnect: false });
  const page = connectClient(bridge, { sourceId: 'yh-web', autoReconnect: false });
  const bystander = connectClient(bridge, { sourceId: 'other', autoReconnect: false });
  const listener = connectClient(bridge, { autoReconnect: false });
  const onsets = [];
  const rejected = [];
  const bystanderRejected = [];
  listener.on('/yh/onset', event => onsets.push(event.sourceId));
  page.on('status', status => { if (status.status === 'source-rejected') rejected.push(status); });
  bystander.on('status', status => { if (status.status === 'source-rejected') bystanderRejected.push(status); });
  try {
    await Promise.all([owner.connect(), page.connect(), bystander.connect(), listener.connect()]);
    owner.sendControl('/yh/level', 0.2);
    await waitFor(() => bridge.stats().owner === 'cables', 3000, 'owner');
    assert.equal(page.sendControl('/yh/onset', 1), true, 'the client cannot know about the drop from the return value');
    await waitFor(() => rejected.length === 1, 3000, 'rejection notice');
    assert.equal(rejected[0].address, '/yh/onset');
    assert.equal(rejected[0].sourceId, 'yh-web');
    assert.equal(rejected[0].owner, 'cables');
    assert.deepEqual(onsets, [], 'no listener receives the dropped onset');
    assert.deepEqual(bystanderRejected, []);
    assert.equal(bridge.stats().droppedBySource, 1);
    for (let i = 0; i < 50; i++) page.sendControl('/yh/level', 0.5);
    await sleep(150);
    assert.ok(rejected.length < 10, `notices are throttled per socket (${rejected.length})`);
  } finally {
    owner.close(); page.close(); bystander.close(); listener.close();
    await bridge.close();
  }
});

test('two pages sharing one sourceId: only the connection that sent the dropped event is told', async () => {
  const bridge = await startBridge({ ...local, sourcePolicy: 'exclusive', sourceTimeoutMs: 5000 });
  const owner = connectClient(bridge, { sourceId: 'cables', autoReconnect: false });
  const pageA = connectClient(bridge, { sourceId: 'yh-web', autoReconnect: false });
  const pageB = connectClient(bridge, { sourceId: 'yh-web', autoReconnect: false });
  const noticesA = [];
  const noticesB = [];
  pageA.on('status', status => { if (status.status === 'source-rejected') noticesA.push(status); });
  pageB.on('status', status => { if (status.status === 'source-rejected') noticesB.push(status); });
  try {
    await Promise.all([owner.connect(), pageA.connect(), pageB.connect()]);
    owner.sendControl('/yh/level', 0.2);
    await waitFor(() => bridge.stats().owner === 'cables', 3000, 'owner');
    pageB.sendControl('/probe', 1);
    pageA.sendControl('/yh/onset', 1);
    await waitFor(() => noticesA.length === 1, 3000, 'notice for the sending page');
    await sleep(150);
    assert.deepEqual(noticesB, [], 'the page that only sent an allowed probe is not told about the other page');
    pageB.sendControl('/yh/onset', 1);
    await waitFor(() => noticesB.length === 1, 3000, 'notice for the second page once it is dropped itself');
    assert.equal(noticesA.length, 1);
  } finally {
    owner.close(); pageA.close(); pageB.close();
    await bridge.close();
  }
});

test('rotating addresses or reusing the first one cannot lift the per-connection notice limit', async () => {
  const bridge = await startBridge({ ...local, sourcePolicy: 'exclusive', sourceTimeoutMs: 5000 });
  const owner = connectClient(bridge, { sourceId: 'cables', autoReconnect: false });
  const page = connectClient(bridge, { sourceId: 'yh-web', autoReconnect: false });
  const notices = [];
  page.on('status', status => { if (status.status === 'source-rejected') notices.push(status); });
  try {
    await Promise.all([owner.connect(), page.connect()]);
    owner.sendControl('/yh/level', 0.2);
    await waitFor(() => bridge.stats().owner === 'cables', 3000, 'owner');
    for (let i = 0; i < 17; i++) page.sendControl(`/yh/rotate${i}`, 1);
    page.sendControl('/yh/rotate0', 1);
    await waitFor(() => bridge.stats().droppedBySource === 18, 3000, 'all drops counted');
    await sleep(100);
    assert.equal(notices.length, 1, `18 drops inside one interval produce one notice (${notices.length})`);
  } finally {
    owner.close(); page.close();
    await bridge.close();
  }
});

test('a drop notice is not queued for a connection whose send buffer is already over the limit', async () => {
  const bridge = await startBridge({ ...local, sourcePolicy: 'exclusive', sourceTimeoutMs: 60000, maxBufferedBytes: 4096 });
  const open = ws => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const stalled = new WebSocket(`ws://127.0.0.1:${bridge.address.wsPort}/ws`);
  const owner = new WebSocket(`ws://127.0.0.1:${bridge.address.wsPort}/ws`);
  const notices = [];
  stalled.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.status === 'source-rejected') notices.push(frame); });
  try {
    await Promise.all([open(stalled), open(owner)]);
    const dropped = JSON.stringify({ kind: 'control', address: '/yh/onset', value: 1, source: 'yh-web' });
    const flood = JSON.stringify({ kind: 'control', address: `/yh/level/${'x'.repeat(100)}`, value: 0.5, source: 'cables' });
    owner.send(flood);
    await waitFor(() => bridge.stats().owner === 'cables', 3000, 'owner');
    stalled.send(dropped);
    await waitFor(() => notices.length === 1, 3000, 'first notice while the buffer is empty');
    stalled.pause();
    const deadline = Date.now() + 15000;
    while (bridge.stats().droppedBackpressure === 0 && Date.now() < deadline) {
      for (let i = 0; i < 500; i += 1) owner.send(flood);
      await sleep(20);
    }
    assert.ok(bridge.stats().droppedBackpressure > 0, 'the stalled client never hit the backpressure limit');
    await sleep(700);
    const before = bridge.stats();
    stalled.send(dropped);
    await waitFor(() => bridge.stats().droppedBySource > before.droppedBySource, 3000, 'second drop');
    await sleep(100);
    assert.equal(bridge.stats().droppedBackpressure, before.droppedBackpressure + 1, 'the notice was skipped and counted as a backpressure drop');
  } finally {
    stalled.terminate(); owner.close();
    await bridge.close();
  }
});

test('internal control frames reach listeners without the bridge-only connection id', async () => {
  const bridge = await startBridge(local);
  const sender = connectClient(bridge, { sourceId: 'mic', autoReconnect: false });
  const listener = connectClient(bridge, { autoReconnect: false });
  const received = [];
  listener.on('/yh/level', event => received.push(event));
  try {
    await Promise.all([sender.connect(), listener.connect()]);
    sender.sendControl('/yh/level', 0.5);
    await waitFor(() => received.length === 1, 3000, 'event');
    assert.deepEqual(received[0].args, [0.5, 'mic']);
    assert.equal(received[0].typeTags, 'fs');
  } finally {
    sender.close(); listener.close();
    await bridge.close();
  }
});

test('a hosted page origin is refused unless it is listed in allowedOrigins; loopback pages and Origin-less clients are always allowed', async () => {
  const attempt = async (bridge, origin) => {
    const headers = origin ? { Origin: origin } : {};
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.address.wsPort}/ws`, { headers });
    return new Promise(resolve => {
      ws.once('open', () => { ws.close(); resolve('open'); });
      ws.once('error', () => resolve('refused'));
    });
  };
  const closed = await startBridge(local);
  const listed = await startBridge({ ...local, allowedOrigins: ['https://yh.example.com'] });
  try {
    assert.equal(await attempt(closed, 'https://yh.example.com'), 'refused');
    assert.equal(await attempt(closed, 'http://localhost:5173'), 'open');
    assert.equal(await attempt(closed, null), 'open');
    assert.equal(await attempt(listed, 'https://yh.example.com'), 'open');
    assert.equal(await attempt(listed, 'https://evil.example.net'), 'refused');
    assert.equal(await attempt(listed, 'http://yh.example.com'), 'refused', 'the scheme is part of the origin');
  } finally {
    await closed.close(); await listed.close();
  }
});

test('raw OSC from an external sender is accepted, labelled by its network origin, and cannot spoof a sourceId', async () => {
  const { encodeOSCMessage } = await import('../src/osc-codec.mjs');
  const dgram = await import('node:dgram');
  const bridge = await startBridge(local);
  const listener = connectClient(bridge, { autoReconnect: false });
  const received = [];
  listener.on('/yh/level', event => received.push(event));
  const udp = dgram.createSocket('udp4');
  try {
    await listener.connect();
    udp.send(encodeOSCMessage('/yh/level', [0.5, 'mic']), bridge.address.oscPort, '127.0.0.1');
    await waitFor(() => received.length === 1, 3000, 'external OSC');
    assert.match(received[0].sourceId, /^osc-127\.0\.0\.1:\d+$/);
    assert.equal(received[0].value, 0.5);
  } finally {
    udp.close(); listener.close();
    await bridge.close();
  }
});

test('client reconnects automatically after the bridge restarts and keeps receiving events', async () => {
  let bridge = await startBridge(local);
  const port = bridge.address.wsPort;
  const client = new YHEventClient({ url: `ws://127.0.0.1:${port}/ws`, WebSocketImpl: WebSocket, reconnectMinMs: 50, reconnectMaxMs: 200 });
  const statuses = [];
  const received = [];
  client.on('status', status => statuses.push(status.status));
  client.on('/yh/level', event => received.push(event.value));
  try {
    await client.connect();
    await bridge.close();
    await waitFor(() => !client.connected, 3000, 'disconnect');
    assert.equal(client.sendControl('/yh/level', 0.3), false);
    assert.equal(client.stats.notSent, 1);
    bridge = await startBridge({ ...local, wsPort: port });
    await waitFor(() => client.connected, 5000, 'reconnect');
    assert.ok(statuses.includes('reconnecting'));
    client.sendControl('/yh/level', 0.75); // exactly representable as float32, unlike 0.7
    await waitFor(() => received.includes(0.75), 3000, 'event after reconnect');
  } finally {
    client.close();
    await bridge.close();
  }
});

test('a bridge that goes silent is detected as stale and the client reconnects', async () => {
  const bridge = await startBridge({ ...local, heartbeatMs: 0 });
  const client = connectClient(bridge, { staleMs: 300, reconnectMinMs: 50, reconnectMaxMs: 100 });
  const statuses = [];
  client.on('status', status => statuses.push(status.status));
  try {
    await client.connect();
    await waitFor(() => statuses.includes('stale'), 3000, 'stale detection');
    await waitFor(() => statuses.indexOf('reconnecting', statuses.indexOf('stale')) > 0, 5000, 'reconnect attempt after stale');
    await waitFor(() => client.stats.reconnects >= 1 && client.connected, 5000, 'new socket after stale');
  } finally {
    client.close();
    await bridge.close();
  }
});

test('repeated connect() calls share one socket', async () => {
  const bridge = await startBridge(local);
  const client = connectClient(bridge, { autoReconnect: false });
  let opened = 0;
  client.on('status', status => { if (status.status === 'connected' && status.url) opened += 1; });
  try {
    const first = client.connect();
    const second = client.connect();
    assert.equal(first, second);
    await Promise.all([first, second]);
    await client.connect();
    await sleep(50);
    assert.equal(opened, 1);
    assert.equal(bridge.stats().clients, 1);
  } finally {
    client.close();
    await bridge.close();
  }
});

test('the tracked-source table stays bounded when senders keep changing sourceId or UDP port', async () => {
  const { encodeOSCMessage } = await import('../src/osc-codec.mjs');
  const dgram = await import('node:dgram');
  const bridge = await startBridge({ ...local, maxTrackedSources: 8 });
  const raw = new WebSocket(`ws://127.0.0.1:${bridge.address.wsPort}/ws`);
  const sockets = [];
  try {
    await new Promise((resolve, reject) => { raw.once('open', resolve); raw.once('error', reject); });
    for (let i = 0; i < 20; i += 1) raw.send(JSON.stringify({ kind: 'control', address: '/yh/level', value: 0.1, source: `spoof-${i}` }));
    for (let i = 0; i < 20; i += 1) {
      const udp = dgram.createSocket('udp4');
      sockets.push(udp);
      udp.send(encodeOSCMessage('/yh/level', [0.2]), bridge.address.oscPort, '127.0.0.1');
    }
    await waitFor(() => bridge.stats().seq >= 40, 5000, 'all 40 events forwarded');
    const stats = bridge.stats();
    assert.ok(Object.keys(stats.sources).length <= 8, `tracked ${Object.keys(stats.sources).length} sources`);
    assert.ok(stats.sourcesEvicted >= 32, `evicted ${stats.sourcesEvicted}`);
  } finally {
    raw.close(); sockets.forEach(udp => udp.close());
    await bridge.close();
  }
});

test('malformed or non-numeric control frames are ignored; only a real number is forwarded', async () => {
  const bridge = await startBridge(local);
  const raw = new WebSocket(`ws://127.0.0.1:${bridge.address.wsPort}/ws`);
  const listener = connectClient(bridge, { autoReconnect: false });
  const received = [];
  listener.on('*', event => received.push(event));
  try {
    await Promise.all([listener.connect(), new Promise((resolve, reject) => { raw.once('open', resolve); raw.once('error', reject); })]);
    const bad = [
      { kind: 'control', address: '/yh/level', value: null },
      { kind: 'control', address: '/yh/level', value: '' },
      { kind: 'control', address: '/yh/level', value: '0.5' },
      { kind: 'control', address: '/yh/level', value: true },
      { kind: 'control', address: '/yh/level', value: [0.5] },
      { kind: 'control', address: '/yh/level', value: {} },
      { kind: 'control', address: '/yh/level' },
      { kind: 'control', address: 'yh/level', value: 0.5 },
      { kind: 'control', address: '/yh/../level', value: 0.5 },
      { kind: 'control', address: '/yh/level\n', value: 0.5 },
      { kind: 'control', address: `/${'a'.repeat(200)}`, value: 0.5 },
      { kind: 'control', address: 42, value: 0.5 },
      { kind: 'event', address: '/yh/level', value: 0.5 }
    ];
    for (const frame of bad) raw.send(JSON.stringify(frame));
    raw.send('not json');
    raw.send(Buffer.from([1, 2, 3]));
    raw.send(JSON.stringify({ kind: 'control', address: '/yh/level', value: 0.5, source: 'bad source id!' }));
    raw.send(JSON.stringify({ kind: 'control', address: '/yh/level', value: 5e9 }));
    await waitFor(() => received.length >= 2, 3000, 'the two valid frames');
    await sleep(150);
    assert.equal(received.length, 2, `unexpected frames forwarded: ${JSON.stringify(received.map(event => [event.address, event.value]))}`);
    assert.match(received[0].sourceId, /^ws-\d+$/, 'an invalid source label falls back to the connection id');
    assert.equal(received[0].value, 0.5);
    assert.equal(received[1].value, 1e6, 'out-of-range numbers are clamped');
  } finally {
    raw.close(); listener.close();
    await bridge.close();
  }
});

test('OSC messages carrying NaN or Infinity are dropped and counted instead of reaching listeners as null', async () => {
  const { encodeOSCMessage } = await import('../src/osc-codec.mjs');
  const dgram = await import('node:dgram');
  const bridge = await startBridge(local);
  const listener = connectClient(bridge, { autoReconnect: false });
  const received = [];
  const statuses = [];
  listener.on('*', event => received.push(event));
  listener.on('status', status => { if (status.status === 'non-finite-osc') statuses.push(status); });
  const udp = dgram.createSocket('udp4');
  const send = packet => new Promise(resolve => udp.send(packet, bridge.address.oscPort, '127.0.0.1', resolve));
  // The encoder refuses NaN, so build the packets by hand: 'f' is float32 (what most OSC tools send), 'd' float64.
  const packet = (address, args) => {
    const pad = text => { const bytes = Buffer.from(`${text}\0`); return Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]); };
    const bodies = args.map(([tag, value]) => { const body = Buffer.alloc(tag === 'f' ? 4 : 8); if (tag === 'f') body.writeFloatBE(value); else body.writeDoubleBE(value); return body; });
    return Buffer.concat([pad(address), pad(`,${args.map(([tag]) => tag).join('')}`), ...bodies]);
  };
  try {
    await listener.connect();
    for (const value of [NaN, Infinity, -Infinity]) {
      await send(packet('/yh/onset', [['f', value]]));
      await send(packet('/yh/level', [['d', value]]));
      await send(packet('/yh/level', [['d', 0.5], ['f', value]]));
    }
    await send(encodeOSCMessage('/yh/level', [0.25]));
    await send(packet('/yh/onset', [['f', 0.75]]));
    await waitFor(() => received.length >= 2 && statuses.length >= 9, 3000, 'valid events and drop notices');
    await sleep(100);
    assert.deepEqual(received.map(event => [event.address, Number(event.value.toFixed(2))]), [['/yh/level', 0.25], ['/yh/onset', 0.75]]);
    assert.equal(bridge.stats().droppedNonFinite, 9);
    assert.equal(statuses.at(-1).address, '/yh/level');
    assert.equal(bridge.stats().malformed, 0);
  } finally {
    udp.close(); listener.close();
    await bridge.close();
  }
});

test('a client that stops reading is dropped from the broadcast (counted) without starving healthy clients', async () => {
  const bridge = await startBridge({ ...local, maxBufferedBytes: 4096 });
  const stalled = new WebSocket(`ws://127.0.0.1:${bridge.address.wsPort}/ws`);
  const healthy = connectClient(bridge, { autoReconnect: false });
  const sender = new WebSocket(`ws://127.0.0.1:${bridge.address.wsPort}/ws`);
  let healthyCount = 0;
  healthy.on('/yh/level', () => { healthyCount += 1; });
  try {
    await Promise.all([healthy.connect(), ...[stalled, sender].map(ws => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }))]);
    stalled.pause();
    const frame = JSON.stringify({ kind: 'control', address: `/yh/level/${'x'.repeat(100)}`, value: 0.5 });
    const levelFrame = JSON.stringify({ kind: 'control', address: '/yh/level', value: 0.5 });
    const deadline = Date.now() + 15000;
    let sentLevels = 0;
    while (bridge.stats().droppedBackpressure === 0 && Date.now() < deadline) {
      for (let i = 0; i < 500; i += 1) sender.send(frame);
      sender.send(levelFrame); sentLevels += 1;
      await sleep(20);
    }
    const stats = bridge.stats();
    assert.ok(stats.droppedBackpressure > 0, 'the stalled client never hit the backpressure limit');
    const before = healthyCount;
    sender.send(levelFrame);
    await waitFor(() => healthyCount > before, 3000, 'healthy client still receives events');
    assert.ok(healthyCount >= 1);
  } finally {
    stalled.terminate(); sender.close(); healthy.close();
    await bridge.close();
  }
});