import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const devEntry = fileURLToPath(new URL('./dev.mjs', import.meta.url));
const webUrl = 'http://127.0.0.1:5173/';
const bridgeHealthUrl = 'http://127.0.0.1:8765/health';
const startupTimeoutMs = 90_000;

const dev = spawn(process.execPath, [devEntry], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env
});

let exitInfo = null;
let stopRequested = false;
const exited = new Promise(resolve => {
  dev.once('exit', (code, signal) => {
    exitInfo = { code, signal };
    resolve(exitInfo);
  });
});

dev.once('error', error => {
  console.error(`无法启动本机服务：${error.message}`);
});

function forwardStop(signal) {
  if (stopRequested) return;
  stopRequested = true;
  console.log('\n正在关闭 YH 本机服务…');
  if (dev.exitCode === null && dev.signalCode === null) {
    try {
      dev.kill(signal);
    } catch (error) {
      console.error(`发送停止信号失败：${error.message}`);
    }
  }
}

process.once('SIGINT', () => forwardStop('SIGINT'));
process.once('SIGTERM', () => forwardStop('SIGTERM'));

async function isReady(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function openWindowsBrowser() {
  const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', webUrl], {
    stdio: 'ignore',
    windowsHide: true
  });
  opener.once('error', error => {
    console.warn(`未能自动打开浏览器（${error.message}）；请在浏览器打开 ${webUrl}`);
  });
  opener.once('exit', code => {
    if (code && code !== 0) console.warn(`浏览器启动器退出代码 ${code}；请在浏览器打开 ${webUrl}`);
  });
  opener.unref();
}

async function waitUntilReady() {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline && !stopRequested) {
    if (exitInfo) {
      const detail = exitInfo.signal ? `信号 ${exitInfo.signal}` : `退出代码 ${exitInfo.code}`;
      throw new Error(`YH 服务在就绪前停止（${detail}）。请查看上方日志。`);
    }
    const [webReady, bridgeReady] = await Promise.all([
      isReady(webUrl),
      isReady(bridgeHealthUrl)
    ]);
    if (webReady && bridgeReady) return;
    await sleep(300);
  }
  if (!stopRequested) {
    throw new Error(`等待本机页面或桥接服务超时。确认端口 5173、8765 未被其他程序占用后重试。`);
  }
}

try {
  await waitUntilReady();
  if (stopRequested) {
    await exited;
    process.exitCode = 0;
  } else {
    console.log(`[ready] YH 页面与本机桥接已就绪：${webUrl}`);
    if (process.platform === 'win32' && process.env.YH_NO_BROWSER !== '1') {
      openWindowsBrowser();
      console.log('[browser] 已请求 Windows 打开默认浏览器。');
    } else {
      console.log(`[browser] 请打开 ${webUrl}`);
    }
    console.log('[stop] 保持此窗口打开；按 Ctrl+C 停止 YH。');
    const result = await exited;
    process.exitCode = stopRequested ? 0 : (result.code ?? 1);
  }
} catch (error) {
  console.error(`[启动失败] ${error.message}`);
  if (dev.exitCode === null && dev.signalCode === null) {
    try { dev.kill('SIGTERM'); } catch {}
    await Promise.race([exited, sleep(3000)]);
  }
  process.exitCode = 1;
}
