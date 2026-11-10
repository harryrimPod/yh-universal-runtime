import { YHLevelResponse, eventStrength } from './level-response.js';

const nowMs = () => performance.now();

/**
 * Routes YH events to engine animations or arbitrary callbacks through a driver:
 *   driver.trigger(name, { intensity, loop }) -> boolean
 *   driver.setParam(name, value)
 *   driver.update?(deltaSeconds)
 *
 * Rule shapes (all accept optional `sourceId` to listen to one source only):
 *   { type: 'trigger', address: '/yh/onset', clip: 'Jump', minValue: 0.5, cooldownMs: 250, loop: 'once' }
 *   { type: 'param',   address: '/yh/level', param: 'Walk:weight', min: 0, max: 1,
 *                      threshold: 0, attackMs: 0, releaseMs: 0, smoothing: 10 }
 *        or { ..., apply: value => material.emissiveIntensity = value } instead of `param`
 *   { type: 'gate',    address: '/yh/level', threshold: 0.4, releaseThreshold: 0.3,
 *                      attackMs: 120, releaseMs: 180, onEnter: 'Wave', onExit: 'Idle' }
 * Level-like values are used as-is (0-1); the router never alters the event stream.
 *
 * Losing the stream: on a disconnect/error/stale status from the client (`releaseOnDisconnect`,
 * default on) param rules ease back to their `min` and gate rules that are active fire `onExit`.
 * `staleMs` > 0 does the same per rule when that rule's address has been silent for that long
 * (default 0 = hold the last value). Trigger rules are one-shot and have nothing to release.
 */
export class YHAnimationRouter {
  constructor(client, driver, rules = [], { now = nowMs, releaseOnDisconnect = true, staleMs = 0 } = {}) {
    if (!client?.on) throw new TypeError('YHAnimationRouter needs a YHEventClient');
    if (!driver || typeof driver.trigger !== 'function' || typeof driver.setParam !== 'function') {
      throw new TypeError('YHAnimationRouter needs a driver with trigger() and setParam()');
    }
    this.driver = driver;
    this.now = now;
    this.disposed = false;
    this.unsubscribers = [];
    this.params = [];
    this.gates = [];
    this.staleMs = Number.isFinite(staleMs) ? Math.max(0, staleMs) : 0;
    this.stats = { triggered: 0, suppressed: 0, ignoredSource: 0 };
    for (const rule of rules) this.#install(client, rule);
    if (releaseOnDisconnect) {
      this.unsubscribers.push(client.on('status', status => {
        if (status?.status === 'disconnected' || status?.status === 'error' || status?.status === 'stale') this.release();
      }));
    }
  }

  /** Returns continuous rules to rest and exits active gates, e.g. when the event stream is lost. */
  release() {
    if (this.disposed) return;
    for (const entry of this.params) this.#releaseParam(entry);
    for (const gate of this.gates) this.#releaseGate(gate);
  }

  // A released rule has no live stream. Clearing lastAt stops the per-frame tick, which would
  // otherwise re-evaluate the reset level and, with a zero threshold, enter and exit forever.
  #releaseParam(entry) {
    entry.response.reset();
    entry.lastAt = null;
  }

  #releaseGate(gate) {
    gate.lastAt = null;
    gate.response.reset();
    if (!gate.active) return;
    gate.active = false;
    if (gate.rule.onExit) { this.stats.triggered += 1; this.driver.trigger(gate.rule.onExit, { intensity: 1, loop: gate.rule.loop || 'once' }); }
  }

  #syncGate(gate) {
    if (gate.response.active === gate.active) return;
    gate.active = gate.response.active;
    const clip = gate.active ? gate.rule.onEnter : gate.rule.onExit;
    if (clip) { this.stats.triggered += 1; this.driver.trigger(clip, { intensity: 1, loop: gate.rule.loop || 'once' }); }
  }

  #install(client, rule) {
    if (!rule || typeof rule.address !== 'string') throw new TypeError('Each rule needs an address');
    const accepts = event => {
      if (rule.sourceId && event.sourceId !== rule.sourceId) { this.stats.ignoredSource += 1; return false; }
      return !this.disposed;
    };
    if (rule.type === 'trigger') {
      if (typeof rule.clip !== 'string' && typeof rule.run !== 'function') throw new TypeError('trigger rules need clip or run');
      const minValue = rule.minValue ?? 0.5;
      const cooldownMs = rule.cooldownMs ?? 0;
      let lastAt = -Infinity;
      this.unsubscribers.push(client.on(rule.address, event => {
        if (!accepts(event)) return;
        const value = eventStrength(event);
        if (value === null) { this.stats.suppressed += 1; return; }
        const time = this.now();
        if (value < minValue || time - lastAt < cooldownMs) { this.stats.suppressed += 1; return; }
        lastAt = time;
        this.stats.triggered += 1;
        if (rule.run) rule.run(value, event);
        else this.driver.trigger(rule.clip, { intensity: rule.intensity ?? value, loop: rule.loop || 'once' });
      }));
    } else if (rule.type === 'param') {
      if (typeof rule.param !== 'string' && typeof rule.apply !== 'function') throw new TypeError('param rules need param or apply');
      const response = new YHLevelResponse({
        threshold: rule.threshold ?? 0,
        releaseThreshold: rule.releaseThreshold ?? rule.threshold ?? 0,
        attackMs: rule.attackMs ?? 0,
        releaseMs: rule.releaseMs ?? 0,
        smoothing: rule.smoothing ?? 10,
        restLevel: 0
      });
      const entry = { rule, response, min: rule.min ?? 0, max: rule.max ?? 1, last: null, lastAt: null };
      this.params.push(entry);
      this.unsubscribers.push(client.on(rule.address, event => {
        if (!accepts(event)) return;
        const level = eventStrength(event, 0);
        if (level === null) return;
        entry.lastAt = this.now();
        response.set(level, entry.lastAt);
      }));
    } else if (rule.type === 'gate') {
      const response = new YHLevelResponse({
        threshold: rule.threshold ?? 0.4,
        releaseThreshold: rule.releaseThreshold ?? (rule.threshold ?? 0.4) * 0.7,
        attackMs: rule.attackMs ?? 120,
        releaseMs: rule.releaseMs ?? 180,
        restLevel: 0
      });
      const gate = { rule, response, active: false, lastAt: null };
      this.gates.push(gate);
      this.unsubscribers.push(client.on(rule.address, event => {
        if (!accepts(event)) return;
        const level = eventStrength(event, 0);
        if (level === null) return;
        gate.lastAt = this.now();
        response.set(level, gate.lastAt);
        this.#syncGate(gate);
      }));
    } else {
      throw new TypeError(`Unknown rule type: ${rule.type}`);
    }
  }

  update(deltaSeconds) {
    if (this.disposed) return;
    const delta = Math.max(0, Number(deltaSeconds) || 0);
    if (this.staleMs > 0) {
      const time = this.now();
      const isStale = item => item.lastAt !== null && time - item.lastAt > this.staleMs;
      for (const entry of this.params) if (isStale(entry)) this.#releaseParam(entry);
      for (const gate of this.gates) if (isStale(gate)) this.#releaseGate(gate);
    }
    const time = this.now();
    for (const gate of this.gates) {
      if (gate.lastAt === null) continue;
      gate.response.tick(time);
      this.#syncGate(gate);
    }
    for (const entry of this.params) {
      if (entry.lastAt !== null) entry.response.tick(time);
      const value = entry.min + entry.response.update(delta) * (entry.max - entry.min);
      if (entry.last !== null && Math.abs(value - entry.last) < 1e-4) continue;
      entry.last = value;
      if (entry.rule.apply) entry.rule.apply(value);
      else this.driver.setParam(entry.rule.param, value);
    }
    this.driver.update?.(delta);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.params = [];
    this.gates = [];
  }
}
