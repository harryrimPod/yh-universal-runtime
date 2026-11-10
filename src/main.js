import * as THREE from 'three';
import './style.css';
import { YHEventClient } from './event-client.mjs';
import { resolveBridgeUrl } from './bridge-url.mjs';
import { YHMicrophone } from './microphone.mjs';
import { SoundCueDetector, cueAddress, isExplicitAddress, resolveCueName } from './sound-cue.mjs';
import { CUE_STORAGE_KEY, commitChange, loadSettings } from './cue-settings.mjs';
import { releaseOnPageHide } from './page-lifecycle.mjs';
import { SoundModeController } from './sound-mode.mjs';
import { YHThreeAdapter } from './adapters/three.js';

const $ = selector => document.querySelector(selector);
const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const client = new YHEventClient({
  url: resolveBridgeUrl(window.location),
  token: new URLSearchParams(window.location.search).get('token') || '',
  sourceId: 'yh-web'
});
const eventRows = [];
let totalEvents = 0;
let connected = false;

function setConnection(isConnected, detail = '') {
  connected = isConnected;
  $('#connectionPill').className = `connection-pill ${isConnected ? 'connected' : 'error'}`;
  $('#connectionText').textContent = isConnected ? '本地链路已连接' : (detail || '本地桥接离线');
  $('#sceneStatus').textContent = isConnected ? '链路就绪 · 等待 YH 事件' : '请启动本地开发服务';
}

const sceneWrap = $('#sceneWrap');
const canvas = $('#sceneCanvas');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
camera.position.set(0, 0.16, 5.15);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
scene.add(new THREE.AmbientLight(0x98a3ff, 1.25));
const keyLight = new THREE.PointLight(0xc0ff79, 35, 11, 2); keyLight.position.set(-2.1, 2.1, 3.4); scene.add(keyLight);
const rimLight = new THREE.PointLight(0x6b63ff, 42, 10, 2); rimLight.position.set(2.2, -0.5, -2.2); scene.add(rimLight);
scene.add(new THREE.PointLight(0x75d9ff, 18, 8, 2));
const orbMaterial = new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setHSL(0.28, 0.72, 0.57), roughness: 0.2, metalness: 0.16, clearcoat: 1, clearcoatRoughness: 0.12, emissive: 0x18340b, emissiveIntensity: 0.55 });
const orb = new THREE.Mesh(new THREE.SphereGeometry(0.78, 96, 72), orbMaterial); orb.position.y = 0.02; scene.add(orb);
const wire = new THREE.Mesh(new THREE.SphereGeometry(0.795, 42, 30), new THREE.MeshBasicMaterial({ color: 0xc4ff8b, wireframe: true, transparent: true, opacity: 0.075 })); orb.add(wire);
const ring = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.008, 8, 160), new THREE.MeshBasicMaterial({ color: 0x8391c8, transparent: true, opacity: 0.33 })); ring.rotation.x = Math.PI * 0.31; ring.rotation.y = -0.16; scene.add(ring);
const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.43, 0.004, 6, 160), new THREE.MeshBasicMaterial({ color: 0x8b78df, transparent: true, opacity: 0.17 })); ring2.rotation.x = Math.PI * 0.47; ring2.rotation.y = 0.22; scene.add(ring2);
const ground = new THREE.GridHelper(8, 32, 0x414b70, 0x232a43); ground.position.y = -1.19; ground.material.transparent = true; ground.material.opacity = 0.24; scene.add(ground);
const points = new Float32Array(140 * 3);
for (let i = 0; i < 140; i++) { const radius = 1.75 + Math.random() * 2.1; const angle = Math.random() * Math.PI * 2; points[i * 3] = Math.cos(angle) * radius; points[i * 3 + 1] = (Math.random() - 0.5) * 4.6; points[i * 3 + 2] = -0.6 - Math.random() * 2.6; }
const particleGeometry = new THREE.BufferGeometry(); particleGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
scene.add(new THREE.Points(particleGeometry, new THREE.PointsMaterial({ color: 0x99a6db, size: 0.018, transparent: true, opacity: 0.65, sizeAttenuation: true })));
function resizeScene() { const width = Math.max(1, sceneWrap.clientWidth); const height = Math.max(1, sceneWrap.clientHeight); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); }
new ResizeObserver(resizeScene).observe(sceneWrap); resizeScene();
const visualAdapter = new YHThreeAdapter(client, orb);

function formatNumber(value, digits = 3) { const number = Number(value); if (!Number.isFinite(number)) return String(value); return Number.isInteger(number) ? String(number) : number.toFixed(digits).replace(/0+$/, '').replace(/\.$/, ''); }
function typeLabel(tags = '') { return [...tags].map(tag => ({ f: 'F32', i: 'I32', d: 'F64', s: 'STR', T: 'BOOL', F: 'BOOL', N: 'NULL', b: 'BLOB', h: 'I64' }[tag] || tag.toUpperCase())).join(' · ') || '—'; }
function renderRows() {
  const filter = $('#eventFilter').value.trim().toLowerCase();
  const visible = eventRows.filter(row => row.address.toLowerCase().includes(filter));
  const list = $('#eventList'); list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    const glyph = document.createElement('span'); glyph.textContent = '⌁';
    const title = document.createElement('b'); title.textContent = filter ? '没有匹配事件' : '等待事件';
    const note = document.createElement('small'); note.textContent = filter ? '调整地址筛选' : '开启麦克风，或发送一个合成事件';
    empty.append(glyph, title, note); list.append(empty); return;
  }
  for (const item of visible) {
    const row = document.createElement('div'); row.className = 'event-row';
    for (const [name, value] of [['event-time', item.time], ['event-address', item.address], ['event-type', item.type], ['event-value', item.value], ['event-source', item.source]]) { const cell = document.createElement('span'); cell.className = name; cell.textContent = value; row.append(cell); }
    list.append(row);
  }
}
function handleEvent(event) {
  if (event.address === '/yh/level') {
    const level = clamp01(event.value);
    $('#sceneLevel').textContent = level.toFixed(2);
    $('#levelStreamValue').textContent = level.toFixed(3);
    $('#levelStreamValue').classList.add('active');
    return;
  }
  if (event.address?.startsWith('/yh/band/')) return;
  totalEvents++;
  $('#eventCount').textContent = String(totalEvents).padStart(2, '0');
  $('#monitorCount').textContent = String(totalEvents);
  if (event.address === '/yh/onset') $('#sceneStatus').textContent = 'YH EVENT · /yh/onset';
  const source = event.source?.address ? 'OSC / UDP' : 'LOCAL CONTROL';
  eventRows.unshift({ time: new Date().toLocaleTimeString('en-GB', { hour12: false }), address: event.address || '(unknown)', type: typeLabel(event.typeTags), value: (event.args || []).map(value => typeof value === 'number' ? formatNumber(value) : String(value)).join(', '), source });
  if (eventRows.length > 60) eventRows.length = 60;
  renderRows();
}
client.on('*', handleEvent);
client.on('status', status => {
  if (status.status === 'connected') { setConnection(true); if (status.udpPort) $('#udpPort').textContent = String(status.udpPort); $('#wsEndpoint').textContent = client.url; }
  else if (status.status === 'disconnected' || status.status === 'error' || status.status === 'control-error') setConnection(false, status.message || '连接中断');
});
client.connect().catch(error => { setConnection(false, '桥接离线'); console.warn(error.message); });

const legacyCueStorageKey = 'yh.sound-cue.v1';
const savedCue = loadSettings(localStorage);
let hasLegacySample = false;
try { hasLegacySample = Boolean(localStorage.getItem(legacyCueStorageKey)); } catch {}
// The re-record notice stays until the user changes the target sounds themselves; saving only the
// strictness or mode must not count.
let legacyAcknowledged = savedCue.legacyAck;
let legacyCue = hasLegacySample && !legacyAcknowledged;
const cueDetector = new SoundCueDetector(savedCue.cues, savedCue.retired);
const modeController = new SoundModeController(cueDetector, savedCue.mode);
const soundMode = $('#soundMode');
const recordCue = $('#recordCue');
const clearCue = $('#clearCue');
const cueStatus = $('#cueStatus');
const cueNameInput = $('#cueName');
const cueTakes = $('#cueTakes');
const cueStrictness = $('#cueStrictness');
const cueList = $('#cueList');
let cueCalibrating = true;
soundMode.value = modeController.mode;
if (savedCue.strictness !== null) cueStrictness.value = String(savedCue.strictness);
cueDetector.strictness = Number(cueStrictness.value);

const thresholdSlider = $('#thresholdSlider');
function showThreshold(threshold) {
  thresholdSlider.value = String(threshold);
  const value = Number(thresholdSlider.value);
  microphone.setThreshold(value);
  $('#thresholdValue').textContent = value.toFixed(3);
  const thresholdPercent = ((value - 0.001) / (0.05 - 0.001)) * 100;
  thresholdSlider.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${thresholdPercent}%, #34394c ${thresholdPercent}%, #34394c 100%)`;
  $('#thresholdMarker').style.left = `${Math.min(100, value / 0.08 * 100)}%`;
}

// Settings are shared by every console page of this browser profile, so each user action is applied to
// what is stored right now instead of writing this page's copy back over another page's changes.
// After a failed write this page holds changes storage never saw, so it stays the base until a write succeeds.
// Another page's changes are not merged in meanwhile: adopting them would overwrite what is only on this page.
let storageFailed = false;
// The mode as last seen in storage. It is the shared saved mode, not this page's live mode, so a write that
// follows a failure does not turn another page's saved choice into whatever this page happens to be showing.
let sharedMode = savedCue.mode;
function commitCueSettings(change) {
  const pageCopy = { cues: cueDetector.cues, retired: cueDetector.retired, mode: sharedMode, strictness: cueDetector.strictness, threshold: Number(thresholdSlider.value), legacyAck: legacyAcknowledged };
  const { settings, appliedName, saved } = commitChange(localStorage, change, pageCopy, { preferFallback: storageFailed });
  storageFailed = !saved;
  sharedMode = settings.mode;
  adoptCueSettings(settings);
  return appliedName;
}

// Takes over what another page (or this page's own commit) left in storage. The mode stays this page's choice,
// except that cue mode cannot outlive its last target sound.
function adoptCueSettings(settings) {
  cueDetector.cues = settings.cues;
  cueDetector.retired = settings.retired;
  if (settings.strictness !== null) { cueStrictness.value = String(settings.strictness); cueDetector.strictness = settings.strictness; }
  if (settings.threshold !== null) showThreshold(settings.threshold);
  if (settings.legacyAck) acknowledgeLegacy();
  if (!cueDetector.hasCues && !modeController.enrolling && modeController.mode === 'cue') {
    modeController.select('level');
    applySoundMode(false);
  } else if (modeController.enrolling) renderCueList();
  else renderCueStatus();
}

window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || (event.key !== null && event.key !== CUE_STORAGE_KEY)) return;
  if (storageFailed) return;
  const settings = loadSettings(localStorage);
  sharedMode = settings.mode;
  adoptCueSettings(settings);
});

function acknowledgeLegacy() {
  legacyAcknowledged = true;
  legacyCue = false;
}

function renderCueList() {
  cueList.replaceChildren(...cueDetector.cues.map(cue => {
    const row = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = cue.label ?? cue.name;
    const detail = document.createElement('small');
    detail.textContent = `${cueAddress(cue.name)} · ${cue.examples.length} 次录入 · 容差 ${cue.threshold.toFixed(3)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除目标声 ${cue.label ?? cue.name}`);
    remove.addEventListener('click', () => {
      modeController.removeCue(cue.name);
      applySoundMode(true, { removeCue: cue.name });
    });
    row.append(name, detail, remove);
    return row;
  }));
}

// A pending flash revert must not overwrite a newer message (e.g. an enrollment prompt).
let cueFlashTimer = 0;
// The existing cue the current enrollment deliberately replaces, if any.
let enrollmentReplaces = null;
// Whether the user typed the address themselves (`door`), which may reuse a deleted one.
let enrollmentExplicit = false;

function renderCueStatus(message) {
  clearTimeout(cueFlashTimer);
  const recording = modeController.enrolling;
  const count = cueDetector.cues.length;
  recordCue.disabled = !microphone.running || cueCalibrating;
  recordCue.textContent = recording ? '取消录入' : '录入目标声';
  cueNameInput.disabled = cueTakes.disabled = recording;
  clearCue.hidden = !cueDetector.hasCues || recording;
  renderCueList();
  const text = message || (cueDetector.hasCues
    ? modeController.mode === 'cue' ? `已录入 ${count} 个目标声 · 仅匹配目标声时触发` : `已录入 ${count} 个目标声 · 可切换到仅目标声`
    : legacyCue ? '旧版保存的单样本格式已不再兼容，请重新录入目标声。'
    : !microphone.running ? '开启音频后可录入目标声。' : cueCalibrating ? '等待底噪校准完成。' : '点击录入后，按提示把同一个短声发出几次。');
  cueStatus.textContent = storageFailed ? `${text} · 注意：浏览器存储写入失败，设置只在本页有效，刷新后会丢失。` : text;
}

function finishEnrollment(outcome, reason) {
  const mode = modeController.endEnrollment(outcome);
  applySoundMode();
  renderCueStatus(`${reason}${mode === 'cue' ? '原有目标声保持不变。' : '已回到电平与起音。'}`);
}

const percent = value => `${Math.round(value * 100)}%`;
const shown = name => { const cue = cueDetector.cues.find(item => item.name === name); return cue?.label ?? name; };

function detectCue(spectrum, sampleRate, meter, time) {
  const outcome = cueDetector.sample(spectrum, sampleRate, meter, time);
  const { enrollment } = cueDetector;
  switch (outcome) {
    case 'listening':
      renderCueStatus(`正在录入「${enrollment.label ?? enrollment.name}」· 第 ${enrollment.examples.length + 1}/${enrollment.total} 次 · 发出声音，随后停顿。`);
      break;
    case 'take':
      renderCueStatus(`「${enrollment.label ?? enrollment.name}」第 ${enrollment.examples.length}/${enrollment.total} 次已录入 · 稍候，再发出一次同样的声音。`);
      break;
    case 'recorded': {
      const { name, label, takes, threshold, similarTo } = cueDetector.lastEnrollment;
      const recorded = cueDetector.cues.find(cue => cue.name === name);
      modeController.endEnrollment('recorded');
      // Another page may have taken this address while we were recording; the stored name is the final one.
      const address = applySoundMode(true, { upsertCue: recorded, replaces: enrollmentReplaces, explicit: enrollmentExplicit, mode: 'cue' }) ?? name;
      renderCueStatus(`已录入「${label ?? name}」（${takes} 次，容差 ${threshold.toFixed(3)}）· 再发出该声音即发送 ${cueAddress(address)}。${address !== name ? '（地址与另一个页面刚录入的目标声冲突，已改用新地址。）' : ''}${similarTo ? `注意：它和「${shown(similarTo)}」很像，可能互相误识别。` : ''}`);
      break;
    }
    case 'inconsistent':
      finishEnrollment('inconsistent', `这几次录入差别太大（最大差异 ${cueDetector.lastEnrollment.reach.toFixed(2)}），不像同一个声音，可能混进了不同的声音。请重试，每次发出同样的声音。`);
      break;
    case 'timeout':
      finishEnrollment('timeout', '未检测到完整的声音。请重试，或调低 RMS 最低门限。');
      break;
    case 'invalid':
      finishEnrollment('invalid', '声音过长或不清晰。请重试一次短声。');
      break;
    case 'matched': {
      const { name, label, similarity } = cueDetector.lastMatch;
      const shownName = label ?? name;
      // The named event identifies the sound; /yh/onset stays so existing adapters react to any target sound.
      const delivered = client.sendControl(cueAddress(name), 1) && client.sendControl('/yh/onset', 1);
      renderCueStatus(delivered ? `识别到「${shownName}」· 匹配度 ${percent(similarity)} · 已发送 ${cueAddress(name)}` : `识别到「${shownName}」· 桥接未连接`);
      break;
    }
    case 'unmatched':
      flashCueStatus(unmatchedMessage(cueDetector.lastComparison));
      break;
    case 'toolong':
      flashCueStatus(`检测到声音，但持续了约 ${(cueDetector.lastTooLong.duration / 1000).toFixed(1)} 秒，超过目标声的 1.25 秒上限，没有参与识别。目标声只识别短声。`);
      break;
    case 'below': {
      const { peak, threshold } = cueDetector.lastNearMiss;
      flashCueStatus(`听到声音但未达门限（峰值 ${peak.toFixed(4)}，有效门限 ${threshold.toFixed(4)}）。可调低 RMS 最低门限或靠近麦克风。`);
      break;
    }
  }
}

// Diagnostic messages fall back to the steady status so they never linger as if they were current.
function flashCueStatus(message) {
  renderCueStatus(message);
  cueFlashTimer = setTimeout(() => renderCueStatus(), 4000);
}

function unmatchedMessage({ name, label, reason, similarity }) {
  const detail = {
    duration: '时长差异过大',
    spectrum: '频谱不相似',
    envelope: '音量变化不相似'
  }[reason] ?? '特征不匹配';
  return `检测到声音但不是目标声：最接近「${label ?? name}」（匹配度 ${percent(similarity)}，${detail}）。`;
}

// The bridge cannot be asked for an acknowledgement, but it does report when it drops our event.
client.on('status', status => {
  if (status?.status !== 'source-rejected' || modeController.mode !== 'cue') return;
  if (status.address !== '/yh/onset' && !status.address?.startsWith('/yh/cue/')) return;
  renderCueStatus(`识别到目标声，但桥接正被其他来源（${status.owner ?? '未知'}）独占，触发已被丢弃。`);
});

const microphone = new YHMicrophone({
  onLevel: level => { if (modeController.mode === 'level') client.sendControl('/yh/level', level); },
  onOnset: () => { if (modeController.mode === 'level') client.sendControl('/yh/onset', 1); },
  onMeter: ({ rms, noiseFloor, effectiveThreshold, calibrating }) => {
    if (cueCalibrating !== calibrating) {
      cueCalibrating = calibrating;
      renderCueStatus();
    }
    $('#rmsReadout').textContent = rms.toFixed(4);
    $('#meterFill').style.width = `${Math.min(100, rms / 0.08 * 100)}%`;
    $('#noiseFloorReadout').textContent = calibrating ? '校准中' : noiseFloor.toFixed(4);
    $('#noiseGateStatus').textContent = calibrating ? '采样约 1.2 秒' : `有效门限 ${effectiveThreshold.toFixed(3)}`;
    const sourceLabel = $('#inputKind').value === 'display' ? '标签页/系统音频已开启' : '麦克风已开启';
    $('#micStatus').textContent = calibrating ? `${sourceLabel} · 正在估算环境底噪` : `${sourceLabel} · 自适应底噪抑制中`;
    if (!calibrating && Number.isFinite(noiseFloor) && noiseFloor > 0) {
      const normalizedNoiseFloor = clamp01(noiseFloor / 0.25);
      visualAdapter.setLevelThreshold(Math.min(0.75, Math.max(0.18, normalizedNoiseFloor * 1.8)));
    }
  },
  onStatus: status => {
    const isOn = status.state === 'on';
    const isRequesting = status.state === 'requesting';
    $('#micToggle').classList.toggle('active', isOn);
    $('#micToggle').disabled = isRequesting;
    $('#micToggle').setAttribute('aria-pressed', String(isOn));
    $('#micButtonText').textContent = isOn ? '关闭麦克风' : isRequesting ? '等待权限…' : '开启麦克风';
    $('#micStatus').textContent = status.message;
    $('#micBadge').textContent = isOn ? 'ON' : isRequesting ? '…' : status.state === 'error' ? 'ERROR' : 'OFF';
    $('#micBadge').className = `badge ${isOn ? 'badge-on' : status.state === 'error' ? 'badge-error' : ''}`;
    if (!isOn) {
      if (!isRequesting) visualAdapter.release();
      cueCalibrating = true;
      if (modeController.enrolling) {
        const mode = modeController.endEnrollment('interrupted');
        applySoundMode();
        renderCueStatus(`录入因音频输入停止而中断。${mode === 'cue' ? '仍使用原目标声样本。' : '已回到电平与起音。'}`);
      } else {
        cueDetector.reset();
        renderCueStatus();
      }
      $('#rmsReadout').textContent = '0.0000';
      $('#meterFill').style.width = '0%';
      $('#noiseFloorReadout').textContent = '—';
      $('#noiseGateStatus').textContent = status.state === 'requesting' ? '等待麦克风权限' : '等待麦克风';
    }
  }
});

function sendBands(bands) {
  for (const [name, value] of Object.entries(bands)) client.sendControl(`/yh/band/${name}`, value);
}

// Pushes modeController.mode into the dropdown and the microphone callbacks.
// Only user actions write to storage: loading the page must not touch the old v1 sample or turn the
// "please re-record" notice into an empty v2 entry. The v1 key is never deleted, so an older build still finds it.
// `change` is what to store with this update: `mode` only when the user chose it (dropdown, finishing a
// recording), plus any target-sound edit (upsertCue/removeCue/clearCues). Other updates, such as deleting a
// sound or cancelling a recording, store nothing about the mode: it belongs to this page, and another page's
// saved choice must not be rewritten by them. Returns the address the stored cue ended up with, if one was added.
function applySoundMode(persist = true, change = {}) {
  const cueMode = modeController.mode === 'cue';
  soundMode.value = modeController.mode;
  if (cueMode && microphone.onBands && microphone.running) {
    client.sendControl('/yh/level', 0);
    sendBands({ low: 0, mid: 0, high: 0 });
    visualAdapter.release();
  }
  microphone.onBands = cueMode ? null : sendBands;
  microphone.onSpectrum = cueMode ? detectCue : null;
  renderCueStatus();
  return persist && Object.keys(change).length ? commitCueSettings(change) : null;
}

applySoundMode(false);
soundMode.addEventListener('change', () => {
  const accepted = modeController.select(soundMode.value);
  applySoundMode(true, { mode: modeController.mode });
  if (!accepted) renderCueStatus('还没有目标声样本，请先点击“录入目标声”。');
});
recordCue.addEventListener('click', () => {
  if (modeController.enrolling) {
    finishEnrollment('cancelled', '已取消录入。');
    return;
  }
  // Typing an existing name or label replaces that target sound; anything else gets its own address.
  const typedName = cueNameInput.value;
  const { name, label, replaces } = resolveCueName(typedName, cueDetector.cues, cueDetector.retired);
  cueNameInput.value = label ?? name;
  enrollmentReplaces = replaces;
  enrollmentExplicit = isExplicitAddress(typedName);
  modeController.beginEnrollment(performance.now(), { name, label, takes: Number(cueTakes.value) });
  applySoundMode();
  renderCueStatus(`准备录入「${label ?? name}」（${cueAddress(name)}）${replaces ? '，成功后将替换同名目标声' : ''}…`);
});
clearCue.addEventListener('click', () => {
  modeController.clearCues();
  applySoundMode(true, { clearCues: true });
});
cueStrictness.addEventListener('change', () => {
  cueDetector.strictness = Number(cueStrictness.value);
  commitCueSettings({ strictness: cueDetector.strictness });
});

async function startMicrophone() {
  try { await microphone.start(); } catch (error) { console.warn(error?.message || error); }
  await refreshDevices();
}
async function refreshDevices() {
  const select = $('#deviceSelect');
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  const inputs = devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');
  const previous = select.value;
  select.replaceChildren(new Option('系统默认设备', ''));
  inputs.forEach((device, index) => select.append(new Option(device.label || `音频输入 ${index + 1}`, device.deviceId)));
  select.value = inputs.some(device => device.deviceId === previous) ? previous : '';
}
function applyInputSelection() {
  const inputKind = $('#inputKind').value;
  $('#deviceRow').hidden = inputKind !== 'microphone';
  microphone.setInput({ inputKind, deviceId: inputKind === 'microphone' ? ($('#deviceSelect').value || null) : null });
}
async function changeInput() {
  const wasRunning = microphone.running || microphone.starting;
  if (wasRunning) microphone.stop();
  applyInputSelection();
  if (wasRunning) await startMicrophone();
}
$('#inputKind').addEventListener('change', changeInput);
$('#deviceSelect').addEventListener('change', changeInput);
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
if (!navigator.mediaDevices?.getDisplayMedia) $('#inputKind option[value="display"]').disabled = true;
refreshDevices();
$('#micToggle').addEventListener('click', async () => {
  if (microphone.running) { microphone.stop(); return; }
  applyInputSelection();
  await startMicrophone();
});
thresholdSlider.addEventListener('input', () => showThreshold(thresholdSlider.value));
// Stored when the drag ends, so other pages are not flooded with storage events while it moves.
thresholdSlider.addEventListener('change', () => commitCueSettings({ threshold: Number(thresholdSlider.value) }));
if (savedCue.threshold !== null) showThreshold(savedCue.threshold);
function setLevelSlider(value) {
  const normalized = clamp01(value);
  const slider = $('#levelSlider');
  slider.value = String(normalized);
  slider.style.setProperty('--level-progress', `${normalized * 100}%`);
  $('#levelValue').textContent = normalized.toFixed(2);
  return normalized;
}
setLevelSlider($('#levelSlider').value);
$('#levelSlider').addEventListener('input', event => {
  const value = setLevelSlider(event.target.value);
  client.sendControl('/yh/level', value);
});
$('#pulseButton').addEventListener('click', () => client.sendControl('/yh/onset', 1));
$('#eventFilter').addEventListener('input', renderRows);
$('#clearEvents').addEventListener('click', () => { eventRows.length = 0; totalEvents = 0; $('#eventCount').textContent = '00'; $('#monitorCount').textContent = '0'; renderRows(); });
$('#resetScene').addEventListener('click', () => { const value = setLevelSlider(0.42); client.sendControl('/yh/level', value); orb.rotation.set(0, 0, 0); ring.rotation.x = Math.PI * 0.31; ring.rotation.y = -0.16; });

let lastTime = performance.now(); let fpsStart = lastTime; let frames = 0;
renderer.setAnimationLoop(now => {
  const delta = Math.min(0.05, Math.max(0, (now - lastTime) / 1000)); lastTime = now; frames++;
  if (now - fpsStart >= 1000) { $('#fpsValue').textContent = String(Math.round(frames * 1000 / (now - fpsStart))); fpsStart = now; frames = 0; }
  orb.rotation.y += delta * 0.17; wire.rotation.y -= delta * 0.06; ring.rotation.z += delta * 0.045; ring2.rotation.z -= delta * 0.025;
  visualAdapter.update(delta);
  keyLight.intensity = 35 + visualAdapter.pulse * 18;
  orbMaterial.emissiveIntensity = 0.55 + visualAdapter.pulse * 1.5;
  renderer.render(scene, camera);
});

releaseOnPageHide(() => { microphone.stop(); visualAdapter.dispose(); client.close(); renderer.setAnimationLoop(null); renderer.dispose(); });
