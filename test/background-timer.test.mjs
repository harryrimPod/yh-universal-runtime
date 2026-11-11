import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundTimer } from '../src/background-timer.mjs';

function makeEnv({ workerThrows = false, noWorker = false } = {}) {
  const env = {
    workers: [], blobs: [], revoked: [], intervals: new Map(), cleared: [], nextId: 1,
    WorkerImpl: noWorker ? undefined : class {
      constructor(url) {
        if (workerThrows) throw new Error('blocked');
        this.url = url;
        this.terminated = false;
        env.workers.push(this);
      }
      terminate() { this.terminated = true; }
    },
    BlobImpl: class { constructor(parts, options) { env.blobs.push({ parts, options }); } },
    URLImpl: { createObjectURL: () => 'blob:fake', revokeObjectURL: url => env.revoked.push(url) },
    setIntervalImpl: (fn, ms) => { const id = env.nextId++; env.intervals.set(id, { fn, ms }); return id; },
    clearIntervalImpl: id => { env.cleared.push(id); env.intervals.delete(id); }
  };
  return env;
}

test('the tick comes from a worker timer and stop() releases the worker and its URL', () => {
  const env = makeEnv();
  const timer = createBackgroundTimer(env);
  let calls = 0;
  const handle = timer.start(() => calls++, 25);

  assert.equal(env.intervals.size, 0, 'no page timer is created while the worker runs');
  assert.match(env.blobs[0].parts[0], /setInterval\(.*25\)/);
  env.workers[0].onmessage();
  env.workers[0].onmessage();
  assert.equal(calls, 2);

  timer.stop(handle);
  assert.equal(env.workers[0].terminated, true);
  assert.deepEqual(env.revoked, ['blob:fake']);
  env.workers[0].onmessage();
  assert.equal(calls, 2, 'a message that arrives after stop() is ignored');
});

test('without Worker support the page timer is used and cleared', () => {
  const env = makeEnv({ noWorker: true });
  const timer = createBackgroundTimer(env);
  let calls = 0;
  const handle = timer.start(() => calls++, 25);

  assert.equal(env.intervals.size, 1);
  env.intervals.get(1).fn();
  assert.equal(calls, 1);
  timer.stop(handle);
  assert.deepEqual(env.cleared, [1]);
});

test('a worker that cannot be constructed falls back to the page timer', () => {
  const env = makeEnv({ workerThrows: true });
  const timer = createBackgroundTimer(env);
  let calls = 0;
  const handle = timer.start(() => calls++, 25);

  assert.equal(env.intervals.size, 1);
  assert.deepEqual(env.revoked, ['blob:fake'], 'the blob URL made before the failure is revoked');
  env.intervals.get(1).fn();
  assert.equal(calls, 1);
  timer.stop(handle);
  assert.deepEqual(env.cleared, [1]);
});

test('a worker that fails after starting is replaced by the page timer once', () => {
  const env = makeEnv();
  const timer = createBackgroundTimer(env);
  let calls = 0;
  const handle = timer.start(() => calls++, 25);
  const worker = env.workers[0];

  worker.onerror();
  worker.onerror();
  assert.equal(worker.terminated, true);
  assert.equal(env.intervals.size, 1, 'a second error does not start a second timer');
  env.intervals.get(1).fn();
  assert.equal(calls, 1);

  timer.stop(handle);
  assert.deepEqual(env.cleared, [1]);
});

test('stop() is safe to call twice and with nothing', () => {
  const env = makeEnv();
  const timer = createBackgroundTimer(env);
  const handle = timer.start(() => {}, 25);
  timer.stop(handle);
  timer.stop(handle);
  timer.stop(null);
  assert.equal(env.revoked.length, 1);
});
