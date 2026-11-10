const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Picks the bridge WebSocket URL for the dashboard.
 * - Served over https (a hosted page): the same origin's /ws, which a reverse proxy forwards to the bridge,
 *   because a secure page may not open a plain ws:// connection to a remote host.
 * - Served over http (local dev): the bridge port on the page's own host.
 * - `?bridge=` may point a hosted page at a bridge on the visitor's own machine, or at the page's own host.
 *   Any other host is ignored so a crafted link cannot redirect the microphone-derived events elsewhere.
 */
export function resolveBridgeUrl(location) {
  const hostname = location.hostname || '127.0.0.1';
  const override = new URLSearchParams(location.search || '').get('bridge');
  if (override) {
    try {
      const url = new URL(override);
      const host = url.hostname.toLowerCase();
      const sameHost = host === hostname.toLowerCase();
      if ((url.protocol === 'ws:' || url.protocol === 'wss:') && (LOOPBACK_HOSTS.has(host) || sameHost) && !url.username && !url.password) {
        url.search = '';
        url.hash = '';
        return url.href;
      }
    } catch { /* fall through to the default */ }
  }
  if (location.protocol === 'https:') return `wss://${location.host}/ws`;
  return `ws://${hostname}:8765/ws`;
}
