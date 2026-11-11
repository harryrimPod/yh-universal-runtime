import { DEFAULT_RMS_THRESHOLD } from '../../src/audio-gate.mjs';
import { loadSettings, normalizeSettings } from '../../src/cue-settings.mjs';
import { YHMicrophone } from '../../src/microphone.mjs';
import { SoundCueDetector, cueAddress } from '../../src/sound-cue.mjs';

const CAR_SETTINGS_KEY = 'yh.car.sound-cue.v1';
export const CAR_CUES = {
  snap: { label: '响指', address: cueAddress('snap'), buttonId: 'recordSnap' },
  clap: { label: '拍手', address: cueAddress('clap'), buttonId: 'recordClap' }
};

function readSettings() {
  try {
    const stored = localStorage.getItem(CAR_SETTINGS_KEY);
    if (stored !== null) return normalizeSettings(JSON.parse(stored));
  } catch {
    // Reuse the dashboard's matching cues if this demo has no readable saved settings.
  }
  return loadSettings(localStorage);
}

export function setupSoundControls(client) {
  const byId = id => document.getElementById(id);
  const micToggle = byId('micToggle');
  const micStatus = byId('micStatus');
  const devices = byId('deviceSelect');
  const thresholdSlider = byId('thresholdSlider');
  const strictness = byId('cueStrictness');
  const takes = byId('cueTakes');
  const cueStatus = byId('cueStatus');
  const rmsMeter = byId('rmsMeter');
  const rmsReadout = byId('rmsReadout');
  const noiseGateStatus = byId('noiseGateStatus');
  const saved = readSettings();
  const detector = new SoundCueDetector(saved.cues.filter(cue => Object.hasOwn(CAR_CUES, cue.name)));
  detector.strictness = saved.strictness ?? 1;
  strictness.value = String(detector.strictness);
  let calibrating = true;
  let saveFailed = false;

  function showCueStatus(message) {
    cueStatus.textContent = saveFailed ? `${message} 浏览器无法保存，刷新后会丢失本次修改。` : message;
  }

  function saveSettings() {
    try {
      localStorage.setItem(CAR_SETTINGS_KEY, JSON.stringify({
        cues: detector.cues,
        threshold: Number(thresholdSlider.value),
        strictness: detector.strictness
      }));
      saveFailed = false;
    } catch {
      saveFailed = true;
    }
  }

  function readyMessage() {
    if (detector.cues.length === 2) return '已就绪。打响指开门并闪灯，拍手关门。';
    const next = Object.keys(CAR_CUES).find(name => !detector.cues.some(cue => cue.name === name));
    return `点击「录入${CAR_CUES[next].label}」，按提示重复同一个短声。`;
  }

  function updateRecordingButtons() {
    const current = detector.enrollment?.name;
    takes.disabled = Boolean(current);
    for (const [name, { label, buttonId }] of Object.entries(CAR_CUES)) {
      const button = byId(buttonId);
      const recorded = detector.cues.some(cue => cue.name === name);
      button.disabled = !microphone.running || calibrating || Boolean(current && current !== name);
      button.textContent = current === name ? '取消录入' : `${recorded ? '重录' : '录入'}${label}`;
    }
  }

  function detectCue(spectrum, sampleRate, meter, now) {
    const outcome = detector.sample(spectrum, sampleRate, meter, now);
    const { enrollment } = detector;
    switch (outcome) {
      case 'listening':
        showCueStatus(`请发出第 ${enrollment.examples.length + 1}/${enrollment.total} 次${enrollment.label}。`);
        break;
      case 'take':
        showCueStatus(`已收到第 ${enrollment.examples.length}/${enrollment.total} 次${enrollment.label}。等下一条提示再继续。`);
        break;
      case 'recorded': {
        const { label, similarTo } = detector.lastEnrollment;
        saveSettings();
        updateRecordingButtons();
        const warning = similarTo ? ` 与「${CAR_CUES[similarTo].label}」相似，可能互相误触发。` : '';
        showCueStatus(`已录入${label}。${readyMessage()}${warning}`);
        break;
      }
      case 'inconsistent':
      case 'timeout':
      case 'invalid': {
        const feedback = {
          inconsistent: '几次声音差别太大，请重新录入同一个短声。',
          timeout: '录入超时，请重试或调低 RMS 最低门限。',
          invalid: '声音过长或不清晰，请录入短声。'
        };
        updateRecordingButtons();
        showCueStatus(feedback[outcome]);
        break;
      }
      case 'matched': {
        const { name, similarity } = detector.lastMatch;
        const { label, address } = CAR_CUES[name];
        const sent = client.sendControl(address, 1);
        if (sent) client.sendControl('/yh/onset', 1);
        showCueStatus(sent ? `识别到${label} · 匹配度 ${Math.round(similarity * 100)}%` : `识别到${label}，但本机桥接未连接。`);
        break;
      }
      case 'unmatched':
        showCueStatus(`检测到声音，最接近「${CAR_CUES[detector.lastComparison.name].label}」，但没有通过匹配。`);
        break;
      case 'below':
        showCueStatus('听到声音但未达门限。可调低 RMS 最低门限或靠近麦克风。');
        break;
      case 'toolong':
        showCueStatus('声音超过 1.25 秒，请发出短促的响指或拍手。');
        break;
    }
  }

  const microphone = new YHMicrophone({
    threshold: saved.threshold ?? DEFAULT_RMS_THRESHOLD,
    onSpectrum: detectCue,
    onMeter: ({ rms, effectiveThreshold, calibrating: measuringNoise }) => {
      rmsMeter.value = rms;
      rmsReadout.textContent = rms.toFixed(4);
      noiseGateStatus.textContent = measuringNoise ? '校准底噪中…' : `有效门限 ${effectiveThreshold.toFixed(3)}`;
      if (calibrating !== measuringNoise) {
        calibrating = measuringNoise;
        updateRecordingButtons();
        if (!calibrating) showCueStatus(readyMessage());
      }
    },
    onStatus: ({ state, message }) => {
      const requesting = state === 'requesting';
      const running = state === 'on';
      micToggle.textContent = running ? '关闭麦克风' : requesting ? '等待权限…' : '开启麦克风';
      micToggle.setAttribute('aria-pressed', String(running));
      micToggle.disabled = devices.disabled = requesting;
      micStatus.textContent = message;
      if (!running) {
        const interrupted = Boolean(detector.enrollment);
        detector.reset();
        calibrating = true;
        rmsMeter.value = 0;
        rmsReadout.textContent = '0.0000';
        noiseGateStatus.textContent = '等待校准';
        showCueStatus(interrupted ? '录入已中断，之前保存的声音仍可用。' : '开启麦克风，等底噪校准完成后录入目标声。');
      }
      updateRecordingButtons();
    }
  });

  async function refreshDevices() {
    const available = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
    const inputs = available.filter(device => device.kind === 'audioinput' && device.deviceId && !['default', 'communications'].includes(device.deviceId));
    const selected = devices.value;
    devices.replaceChildren(new Option('系统默认设备', ''));
    for (const [index, device] of inputs.entries()) {
      devices.append(new Option(device.label || `音频输入 ${index + 1}`, device.deviceId));
    }
    devices.value = inputs.some(device => device.deviceId === selected) ? selected : '';
  }

  async function startMicrophone() {
    microphone.setInput({ deviceId: devices.value || null });
    try {
      await microphone.start();
    } catch (error) {
      if (micStatus.textContent === '麦克风已关闭') micStatus.textContent = error.message;
    }
    await refreshDevices();
  }

  micToggle.addEventListener('click', () => {
    if (microphone.running) microphone.stop();
    else startMicrophone();
  });
  devices.addEventListener('change', () => {
    if (!microphone.running) return;
    microphone.stop();
    startMicrophone();
  });
  refreshDevices();

  function showThreshold() {
    const value = Number(thresholdSlider.value);
    microphone.setThreshold(value);
    byId('thresholdValue').textContent = value.toFixed(3);
  }
  thresholdSlider.value = String(saved.threshold ?? DEFAULT_RMS_THRESHOLD);
  showThreshold();
  thresholdSlider.addEventListener('input', showThreshold);
  thresholdSlider.addEventListener('change', () => {
    saveSettings();
    showCueStatus(`RMS 最低门限已设为 ${Number(thresholdSlider.value).toFixed(3)}。`);
  });
  strictness.addEventListener('change', () => {
    detector.strictness = Number(strictness.value);
    saveSettings();
    showCueStatus(`识别严格度已设为「${strictness.selectedOptions[0].textContent}」。`);
  });

  for (const [name, { label, buttonId }] of Object.entries(CAR_CUES)) {
    byId(buttonId).addEventListener('click', () => {
      if (detector.enrollment) {
        detector.reset();
        showCueStatus('已取消录入。');
      } else {
        detector.record(performance.now(), { name, label, takes: Number(takes.value) });
        showCueStatus(`准备录入${label}，请等提示后发出声音。`);
      }
      updateRecordingButtons();
    });
  }
  updateRecordingButtons();

  client.on('status', status => {
    if (status.status === 'source-rejected' && Object.values(CAR_CUES).some(cue => cue.address === status.address)) {
      showCueStatus('识别到目标声，但事件被桥接的独占策略丢弃。');
    }
  });
  return () => microphone.stop();
}
