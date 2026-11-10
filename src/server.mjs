import dgram from 'node:dgram';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { realpathSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { decodeOSCPacket, encodeOSCMessage } from './osc-codec.mjs';

export const PROTOCOL_VERSION = 1;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_TRACKED_SOURCES = 256;
const REJECT_NOTICE_INTERVAL_MS = 500;

const DEFAULTS = {
  wsHost: process.env.WS_HOST || '127.0.0.1',
  wsPort: Number(process.env.WS_PORT || 8765),
  oscHost: process.env.OSC_HOST || '127.0.0.1',
  oscPort: Number(process.env.OSC_PORT || 9000),
  oscTargetHost: process.env.OSC_TARGET_HOST || '127.0.0.1',
  allowedOrigins: (process.env.ALLOWED_WS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  token: process.env.YH_TOKEN || '',
  allowRemoteOsc: process.env.YH_ALLOW_REMOTE_OSC === '1',
  sourcePolicy: process.env.YH_SOURCE_POLICY || 'merge',
  sourceTimeoutMs: Number(process.env.YH_SOURCE_TIMEOUT_MS || 1500),
  heartbeatMs: Number(process.env.YH_HEARTBEAT_MS || 2000),
  maxBufferedBytes: MAX_BUFFERED_BYTES,
  maxTrackedSources: MAX_TRACKED_SOURCES
};

export function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]') return true;
  // A DNS name beginning with "127." is not necessarily a loopback address.
  return isIP(value) === 4 && value.startsWith('127.');
}

function validOrigin(origin, allowedOrigins, userAgent = '') {
  if (!origin) return true; // native OSC tools / Godot clients may omit Origin
  if (origin === 'file://') return allowedOrigins.includes('file://') && /Electron\//i.test(userAgent);
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
    return allowedOrigins.includes(url.origin);
  } catch { return false; }
}

function tokenMatches(expected, supplied) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(supplied ?? ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function startBridge(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!isLoopbackHost(cfg.wsHost) && !cfg.token) {
    throw new Error('WS_HOST is not a loopback address: set YH_TOKEN (or the token option) before exposing the WebSocket');
  }
  if (!isLoopbackHost(cfg.oscHost) && !cfg.allowRemoteOsc) {
    throw new Error('OSC_HOST is not a loopback address: set YH_ALLOW_REMOTE_OSC=1 to accept OSC/UDP from other machines');
  }
  if (cfg.sourcePolicy !== 'merge' && cfg.sourcePolicy !== 'exclusive') throw new Error('sourcePolicy must be "merge" or "exclusive"');
  if (!Number.isInteger(cfg.maxTrackedSources) || cfg.maxTrackedSources < 1) {
    throw new RangeError('maxTrackedSources must be a positive integer');
  }

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({
        ok: true, protocol: PROTOCOL_VERSION, authRequired: Boolean(cfg.token), sourcePolicy: cfg.sourcePolicy,
        udp: { host: cfg.oscHost, port: cfg.oscPort }, websocket: { host: cfg.wsHost, port: cfg.wsPort }
      }));
      return;
    }
    res.writeHead(404); res.end('Not found');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const udp = dgram.createSocket('udp4');
  const mockSender = dgram.createSocket('udp4');
  const clients = new Set();
  let seq = 0;
  let malformed = 0;
  let droppedNonFinite = 0;
  let droppedBySource = 0;
  let droppedBackpressure = 0;
  let sourcesEvicted = 0;
  let nextConnectionId = 0;
  let closed = false;
  let internalPort = null;
  let owner = null;
  let ownerLastAt = 0;
  const sourceLastSeen = new Map();
  const connections = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://bridge.local'); } catch { url = null; }
    const authorised = !cfg.token || (url && tokenMatches(cfg.token, url.searchParams.get('token')));
    if (!url || url.pathname !== '/ws' || !authorised || !validOrigin(req.headers.origin, cfg.allowedOrigins, req.headers['user-agent'] || '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const connectionId = `ws-${++nextConnectionId}`;
    clients.add(ws);
    ws.send(JSON.stringify({ kind: 'status', status: 'connected', protocol: PROTOCOL_VERSION, udpPort: cfg.oscPort, path: '/ws', origin: req.headers.origin || 'native', connectionId, sourcePolicy: cfg.sourcePolicy }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > 2048) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.kind !== 'control' || typeof msg.address !== 'string' || !/^\/[A-Za-z0-9_./-]{1,120}$/.test(msg.address)) return;
      if (msg.address.includes('..') || typeof msg.value !== 'number' || !Number.isFinite(msg.value)) return;
      const value = Math.max(-1e6, Math.min(1e6, msg.value));
      const sourceId = typeof msg.source === 'string' && SOURCE_ID_PATTERN.test(msg.source) ? msg.source : connectionId;
      let packet;
      try { packet = encodeOSCMessage(msg.address, [value, sourceId, connectionId]); } catch { return; }
      mockSender.send(packet, cfg.oscPort, cfg.oscTargetHost, err => {
        if (err && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'status', status: 'mock-error', message: err.message }));
      });
    });
    ws.on('close', () => forget(connectionId, ws));
    ws.on('error', () => forget(connectionId, ws));
    connections.set(connectionId, ws);
  });

  function forget(connectionId, ws) {
    clients.delete(ws);
    connections.delete(connectionId);
  }

  // A control frame is fire-and-forget over the loopback UDP port, so its sender cannot see an
  // exclusive-policy drop. The frame carries its connection id through that hop, which lets the
  // notice reach the one socket that sent the dropped event, even when several pages share a sourceId.
  // One notice per socket per interval, whatever the address, so rotating addresses cannot lift
  // the limit; a socket whose send buffer is already full gets nothing.
  function notifyRejected(connectionId, sourceId, address) {
    const ws = connections.get(connectionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (ws.yhLastRejectNoticeAt !== undefined && now - ws.yhLastRejectNoticeAt < REJECT_NOTICE_INTERVAL_MS) return;
    if (ws.bufferedAmount > cfg.maxBufferedBytes) { droppedBackpressure += 1; return; }
    ws.yhLastRejectNoticeAt = now;
    ws.send(JSON.stringify({ kind: 'status', status: 'source-rejected', address, sourceId, owner, policy: cfg.sourcePolicy }));
  }

  function admitSource(sourceId, address) {
    const now = performance.now();
    // Re-inserting keeps the Map ordered by recency so the oldest entries are evicted first;
    // a sender cycling through sourceIds or UDP ports cannot grow it past the cap.
    sourceLastSeen.delete(sourceId);
    sourceLastSeen.set(sourceId, now);
    while (sourceLastSeen.size > cfg.maxTrackedSources) {
      sourceLastSeen.delete(sourceLastSeen.keys().next().value);
      sourcesEvicted += 1;
    }
    if (cfg.sourcePolicy !== 'exclusive' || !address.startsWith('/yh/')) return true;
    if (owner === null || owner === sourceId || now - ownerLastAt > cfg.sourceTimeoutMs) {
      if (owner !== sourceId) {
        owner = sourceId;
        broadcast({ kind: 'status', status: 'source-owner', sourceId });
      }
      ownerLastAt = now;
      return true;
    }
    droppedBySource += 1;
    return false;
  }

  udp.on('message', (packet, rinfo) => {
    let decoded;
    try { decoded = decodeOSCPacket(packet); }
    catch (err) {
      malformed += 1;
      broadcast({ kind: 'status', status: 'malformed-osc', message: err.message, malformed });
      return;
    }
    const internal = internalPort !== null && rinfo.port === internalPort && isLoopbackHost(rinfo.address);
    for (const item of decoded) {
      // JSON has no NaN or Infinity: they would reach every listener as null, which adapters cannot tell from a real value.
      if (item.args.some(arg => typeof arg === 'number' && !Number.isFinite(arg))) {
        droppedNonFinite += 1;
        broadcast({ kind: 'status', status: 'non-finite-osc', address: item.address, droppedNonFinite });
        continue;
      }
      const declared = internal && typeof item.args[1] === 'string' && SOURCE_ID_PATTERN.test(item.args[1]) ? item.args[1] : null;
      const sourceId = declared || `osc-${rinfo.address}:${rinfo.port}`;
      // Only the bridge's own control path appends a connection id; it never reaches listeners.
      const fromConnection = declared && typeof item.args[2] === 'string' ? item.args[2] : null;
      const args = internal ? item.args.slice(0, 2) : item.args;
      const typeTags = internal ? item.typeTags.slice(0, 2) : item.typeTags;
      if (!admitSource(sourceId, item.address)) {
        if (fromConnection) notifyRejected(fromConnection, sourceId, item.address);
        continue;
      }
      broadcast({
        kind: 'osc', v: PROTOCOL_VERSION, seq: ++seq, tMs: Number(performance.now().toFixed(1)),
        address: item.address, typeTags, args, sourceId,
        source: { address: rinfo.address, port: rinfo.port }
      });
    }
  });

  function broadcast(message) {
    const text = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > cfg.maxBufferedBytes) { droppedBackpressure += 1; continue; }
      client.send(text);
    }
  }

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(cfg.wsPort, cfg.wsHost, resolve);
  });
  const actualWsPort = httpServer.address().port;
  try {
    await new Promise((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(cfg.oscPort, cfg.oscHost, resolve);
    });
    if (isLoopbackHost(cfg.oscTargetHost)) {
      await new Promise((resolve, reject) => {
        mockSender.once('error', reject);
        mockSender.bind(0, '127.0.0.1', resolve);
      });
      internalPort = mockSender.address().port;
    }
  } catch (error) {
    httpServer.close(); udp.close(); mockSender.close();
    throw error;
  }
  const actualOscPort = udp.address().port;
  // When port 0 is requested in tests, use the actual assigned port for the mock loopback.
  cfg.oscPort = actualOscPort;
  cfg.wsPort = actualWsPort;

  const heartbeat = cfg.heartbeatMs > 0
    ? setInterval(() => broadcast({ kind: 'status', status: 'heartbeat', seq, tMs: Number(performance.now().toFixed(1)) }), cfg.heartbeatMs)
    : null;
  heartbeat?.unref();

  const address = { wsHost: cfg.wsHost, wsPort: actualWsPort, oscHost: cfg.oscHost, oscPort: actualOscPort };
  console.log(`[bridge] OSC/UDP listening at ${address.oscHost}:${address.oscPort}`);
  console.log(`[bridge] WebSocket listening at ws://${address.wsHost}:${address.wsPort}/ws${cfg.token ? ' (token required)' : ''}`);

  return {
    address,
    stats: () => ({
      clients: clients.size, seq, malformed, droppedNonFinite, droppedBySource, droppedBackpressure, sourcesEvicted, owner,
      sources: Object.fromEntries(sourceLastSeen)
    }),
    close: async () => {
      if (closed) return; closed = true;
      if (heartbeat) clearInterval(heartbeat);
      for (const client of clients) client.close(1001, 'bridge shutdown');
      await new Promise(resolve => wss.close(() => resolve()));
      await new Promise(resolve => udp.close(() => resolve()));
      mockSender.close();
      await new Promise(resolve => httpServer.close(() => resolve()));
    }
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}

if (isMainModule()) {
  const bridge = await startBridge();
  const shutdown = async () => { await bridge.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
