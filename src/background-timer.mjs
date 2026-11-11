// Chrome slows main-thread timers in a hidden tab to about one call per second, which makes a 25 ms
// audio poll miss a clap or finger snap entirely while the console sits behind the page being shown.
// A dedicated worker's timer is not slowed that way; its ticks reach the page as ordinary messages.
// Without Worker support, or if the worker cannot start, this falls back to the plain page timer.
export function createBackgroundTimer({
  WorkerImpl = globalThis.Worker,
  BlobImpl = globalThis.Blob,
  URLImpl = globalThis.URL,
  setIntervalImpl = globalThis.setInterval?.bind(globalThis),
  clearIntervalImpl = globalThis.clearInterval?.bind(globalThis)
} = {}) {
  const releaseWorker = handle => {
    handle.worker?.terminate();
    if (handle.url) URLImpl.revokeObjectURL?.(handle.url);
    handle.worker = null;
    handle.url = null;
  };

  function start(callback, ms) {
    const handle = { worker: null, url: null, id: null, stopped: false };
    const fallBack = () => {
      releaseWorker(handle);
      if (!handle.stopped && handle.id === null) handle.id = setIntervalImpl(callback, ms);
    };
    if (!WorkerImpl || !BlobImpl || !URLImpl?.createObjectURL) {
      fallBack();
      return handle;
    }
    try {
      const period = Math.max(1, Math.trunc(Number(ms)) || 1);
      handle.url = URLImpl.createObjectURL(new BlobImpl([`setInterval(() => postMessage(0), ${period});`], { type: 'text/javascript' }));
      handle.worker = new WorkerImpl(handle.url);
      handle.worker.onmessage = () => { if (!handle.stopped) callback(); };
      handle.worker.onerror = fallBack;
    } catch {
      fallBack();
    }
    return handle;
  }

  function stop(handle) {
    if (!handle) return;
    handle.stopped = true;
    releaseWorker(handle);
    if (handle.id !== null) clearIntervalImpl(handle.id);
    handle.id = null;
  }

  return { start, stop };
}

const shared = createBackgroundTimer();
export const setBackgroundInterval = (callback, ms) => shared.start(callback, ms);
export const clearBackgroundInterval = handle => shared.stop(handle);
