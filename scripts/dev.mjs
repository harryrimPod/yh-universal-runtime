import { createServer } from 'vite';
import { startBridge } from '../src/server.mjs';

const bridge = await startBridge();
const host = process.env.VITE_HOST || '127.0.0.1';
const port = Number(process.env.VITE_PORT || 5173);
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { host, port, strictPort: true, allowedHosts: ['localhost', '127.0.0.1'] },
  appType: 'spa'
});
await vite.listen();
console.log(`[web] http://${host}:${port}`);

let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await Promise.allSettled([vite.close(), bridge.close()]);
  process.exit(0);
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
