const DEFAULT_URL = 'ws://127.0.0.1:8765/ws';
const ADDRESS_PATTERN = /^\/[A-Za-z0-9_./-]{1,120}$/;

/**
 * Engine-neutral YH event client.
 * Incoming bridge frames use {kind:'osc', address, args, typeTags, seq, tMs, sourceId}.
 * Subscribe with an address, '*' or 'status'; call sendControl to emit.
 *
 * By default the client reconnects with exponential backoff and treats a bridge that
 * has been silent for `staleMs` (the bridge sends heartbeats) as disconnected.
 * sendControl returns false whenever the frame was not handed to an open socket.
 */
export class YHEventClient {
  constructor({
    url = DEFAULT_URL,
    WebSocketImpl = globalThis.WebSocket,
    token = '',
    sourceId = '',
    autoReconnect = true,
    reconnectMinMs = 250,
    reconnectMaxMs = 5000,
    staleMs = 8000,
    connectTimeoutMs = 8000
  } = {}) {
    if (!WebSocketImpl) throw new Error('WebSocket is not available in this runtime');
    if (sourceId && !/^[A-Za-z0-9_.-]{1,32}$/.test(sourceId)) throw new TypeError('sourceId must match [A-Za-z0-9_.-]{1,32}');
    this.url = url;
    this.token = token;
    this.sourceId = sourceId;
    this.WebSocketImpl = WebSocketImpl;
    this.autoReconnect = autoReconnect;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.staleMs = staleMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this.handlers = new Map();
    this.statusHandlers = new Set();
    this.stats = { sent: 0, notSent: 0, reconnects: 0 };
    this.connectPromise = null;
    this.closedByUser = false;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.attempt = 0;
    this.lastFrameAt = 0;
  }

  get connected() { return this.socket?.readyState === this.WebSocketImpl.OPEN; }

  connect() {
    this.closedByUser = false;
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.#open().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  #target() {
    if (!this.token) return this.url;
    const separator = this.url.includes('?') ? '&' : '?';
    return `${this.url}${separator}token=${encodeURIComponent(this.token)}`;
  }

  #open() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.#target());
      this.socket = socket;
      let settled = false;
      const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
      const timer = setTimeout(() => {
        if (!settled) { settle(reject, new Error('YH WebSocket connection timed out')); try { socket.close(); } catch {} }
      }, this.connectTimeoutMs);
      socket.addEventListener('open', () => {
        this.attempt = 0;
        this.lastFrameAt = Date.now();
        this.#startWatchdog(socket);
        settle(resolve);
        this.#status({ status: 'connected', url: this.url });
      }, { once: true });
      socket.addEventListener('error', () => {
        this.#status({ status: 'error', url: this.url });
        settle(reject, new Error('YH WebSocket connection failed'));
      });
      socket.addEventListener('close', event => {
        settle(reject, new Error('YH WebSocket closed before it opened'));
        if (this.socket !== socket) return;
        this.#stopWatchdog();
        this.#status({ status: 'disconnected', code: event.code });
        this.#scheduleReconnect();
      });
      socket.addEventListener('message', event => { this.lastFrameAt = Date.now(); this.#receive(event.data); });
    });
  }

  #scheduleReconnect() {
    if (!this.autoReconnect || this.closedByUser || this.reconnectTimer) return;
    const delayMs = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.attempt);
    this.attempt += 1;
    this.#status({ status: 'reconnecting', attempt: this.attempt, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.stats.reconnects += 1;
      this.connect().catch(() => {});
    }, delayMs);
  }

  #startWatchdog(socket) {
    this.#stopWatchdog();
    if (!(this.staleMs > 0)) return;
    this.watchdog = setInterval(() => {
      if (this.socket !== socket || Date.now() - this.lastFrameAt <= this.staleMs) return;
      this.#stopWatchdog();
      this.socket = null;
      try { socket.close(); } catch {}
      this.#status({ status: 'stale', staleMs: this.staleMs });
      this.#status({ status: 'disconnected', code: 4000 });
      this.#scheduleReconnect();
    }, Math.max(50, this.staleMs / 4));
  }

  #stopWatchdog() { clearInterval(this.watchdog); this.watchdog = null; }

  on(addressOrStatus, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    if (addressOrStatus === 'status') {
      this.statusHandlers.add(handler);
      return () => this.statusHandlers.delete(handler);
    }
    if (!this.handlers.has(addressOrStatus)) this.handlers.set(addressOrStatus, new Set());
    const set = this.handlers.get(addressOrStatus);
    set.add(handler);
    return () => { set.delete(handler); if (!set.size) this.handlers.delete(addressOrStatus); };
  }

  sendControl(address, value) {
    if (!ADDRESS_PATTERN.test(address) || address.includes('..')) throw new TypeError('Invalid OSC address');
    if (!Number.isFinite(Number(value))) throw new TypeError('YH event value must be finite');
    if (!this.connected) { this.stats.notSent += 1; return false; }
    const frame = { kind: 'control', address, value: Number(value) };
    if (this.sourceId) frame.source = this.sourceId;
    this.socket.send(JSON.stringify(frame));
    this.stats.sent += 1;
    return true;
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#stopWatchdog();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < this.WebSocketImpl.CLOSING) socket.close(1000, 'YH client closed');
    this.handlers.clear();
    this.statusHandlers.clear();
  }

  #receive(raw) {
    let frame;
    try { frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (frame.kind === 'status') { this.#status(frame); return; }
    if (frame.kind !== 'osc' && frame.kind !== 'event') return;
    const event = {
      kind: 'event',
      address: frame.address,
      args: Array.isArray(frame.args) ? frame.args : [frame.value],
      value: Array.isArray(frame.args) ? frame.args[0] : frame.value,
      typeTags: frame.typeTags || '',
      seq: Number.isFinite(frame.seq) ? frame.seq : null,
      timeMs: Number.isFinite(frame.tMs) ? frame.tMs : null,
      sourceId: typeof frame.sourceId === 'string' ? frame.sourceId : null,
      source: frame.source || null,
      raw: frame
    };
    for (const handler of this.handlers.get('*') || []) handler(event);
    for (const handler of this.handlers.get(event.address) || []) handler(event);
    for (const handler of this.handlers.get('osc') || []) handler(event);
  }

  #status(status) { for (const handler of this.statusHandlers) handler(status); }
}

export function createYHClient(options) { return new YHEventClient(options); }
