import { YHEventClient } from '../../src/event-client.mjs';
import { YHVerge3DAdapter } from '../../src/adapters/verge3d.js';
import { releaseOnPageHide } from '../../src/page-lifecycle.mjs';
import '../demo.css';

const $ = selector => document.querySelector(selector);
const engineUrl = '/vendor/verge3d/v3d.js';
const sceneUrl = '/examples/verge3d/scene.gltf';
const setStatus = (message, connected = false) => { $('#status').textContent = message; $('#dot').classList.toggle('on', connected); };
function loadLocalEngine() {
  return new Promise((resolve, reject) => {
    if (globalThis.v3d?.App) return resolve();
    const script = document.createElement('script');
    script.src = engineUrl;
    script.onload = () => globalThis.v3d?.App ? resolve() : reject(new Error('本机脚本未导出 v3d.App'));
    script.onerror = () => reject(new Error(`缺少本机 Verge3D runtime：请复制到 ${engineUrl}`));
    document.head.append(script);
  });
}

async function boot() {
  await loadLocalEngine();
  const app = new v3d.App('v3d-container');
  await new Promise((resolve, reject) => {
    app.loadScene(sceneUrl, resolve);
    app.addEventListener?.('error', event => reject(new Error(event.message || 'Verge3D 场景加载失败')));
  });
  app.enableControls();
  app.run();
  const target = app.scene.getObjectByName('YH_Target');
  if (!target) throw new Error('场景缺少 YH_Target 节点');
  const yh = new YHEventClient({ url: 'ws://127.0.0.1:8765/ws' });
  const adapter = new YHVerge3DAdapter(yh, target);
  let lastFrame = performance.now();
  app.renderCallbacks.push(() => {
    const now = performance.now();
    adapter.update(Math.min(0.05, (now - lastFrame) / 1000));
    lastFrame = now;
  });
  yh.on('/yh/level', event => $('#level').textContent = Number(event.value).toFixed(2));
  yh.on('status', state => setStatus(state.status === 'connected' ? '本机桥接已连接' : state.status, state.status === 'connected'));
  await yh.connect();
  $('#sendLevel').addEventListener('click', () => yh.sendControl('/yh/level', Number($('#levelInput').value)));
  $('#sendOnset').addEventListener('click', () => yh.sendControl('/yh/onset', 1));
  releaseOnPageHide(() => { adapter.dispose(); yh.close(); app.dispose?.(); });
  document.documentElement.dataset.sampleReady = 'verge3d';
}

boot().catch(error => { setStatus(error.message); $('#status').classList.add('error'); console.error(error); });
