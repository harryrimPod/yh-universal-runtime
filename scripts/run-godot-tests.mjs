// 一键 Godot 无头测试:启动桥接 → 依次跑 tests/*.tscn → 关闭桥接。
// 用法: node scripts/run-godot-tests.mjs   (Godot 路径取自 GODOT_BIN 环境变量,或在 PATH / 常见位置查找)
// 文件名刻意不叫 test-*.mjs:node --test 会按该模式自动收集并执行它。
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.join(root, 'examples', 'godot');
const scenes = ['res://tests/test_runner.tscn', 'res://tests/test_binder.tscn', 'res://tests/test_resilience.tscn'];
const WS_PORT = 8765; // 测试脚本里写死了 ws://127.0.0.1:8765/ws
const OSC_PORT = 9000;

function findGodot() {
  if (process.env.GODOT_BIN) return process.env.GODOT_BIN;
  const candidates = ['godot4', 'godot', 'Godot_v4.6.2-stable_win64_console.exe'];
  for (const name of candidates) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (probe.status === 0) return probe.stdout.split(/\r?\n/)[0].trim();
  }
  return null;
}

function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${WS_PORT}/health`);
      if (response.ok) return;
    } catch { /* 桥接尚未就绪 */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('桥接未在时限内就绪');
}

function runScene(godot, scene) {
  return new Promise(resolve => {
    const child = spawn(godot, ['--headless', '--path', projectDir, scene], { stdio: 'inherit' });
    const timer = setTimeout(() => { console.error(`[run-godot-tests] ${scene} 超时,终止`); child.kill(); }, 60000);
    child.on('exit', code => { clearTimeout(timer); resolve(code ?? 1); });
    child.on('error', error => { clearTimeout(timer); console.error(error.message); resolve(1); });
  });
}

const godot = findGodot();
if (!godot) {
  console.error('[run-godot-tests] 找不到 Godot。请设置 GODOT_BIN 指向 Godot 4.x 控制台可执行文件。');
  process.exit(2);
}
if (!(await portFree(WS_PORT)) || !(await portFree(OSC_PORT))) {
  console.error(`[run-godot-tests] 端口 ${WS_PORT}/${OSC_PORT} 已被占用,请先停止 dev/bridge 再运行。`);
  process.exit(2);
}

const bridge = spawn(process.execPath, [path.join(root, 'src', 'server.mjs')], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, WS_PORT: String(WS_PORT), OSC_PORT: String(OSC_PORT), YH_TOKEN: '' }
});

let failed = 0;
try {
  await waitForHealth();
  console.log(`[run-godot-tests] Godot: ${godot}`);
  for (const scene of scenes) {
    const code = await runScene(godot, scene);
    console.log(`[run-godot-tests] ${scene} → ${code === 0 ? 'PASS' : `FAIL (exit ${code})`}`);
    if (code !== 0) failed += 1;
  }
} catch (error) {
  console.error(`[run-godot-tests] ${error.message}`);
  failed += 1;
} finally {
  bridge.kill();
}
process.exit(failed === 0 ? 0 : 1);
