// `pagehide` also fires when the browser parks the page in the back/forward cache. The released page
// comes back from there with its old DOM and no connection, so a "connected" label would outlive a
// dead WebSocket. Releasing is irreversible (microphone stopped, renderer disposed), so the restored
// page is reloaded instead of being rebuilt piece by piece.
export function releaseOnPageHide(release, { target = globalThis, reload = () => target.location.reload() } = {}) {
  let released = false;
  target.addEventListener('pagehide', () => {
    if (released) return;
    released = true;
    release();
  });
  target.addEventListener('pageshow', event => {
    if (event.persisted && released) reload();
  });
}
