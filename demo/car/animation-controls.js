import { AnimationMixer, Box3, Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createThreeAnimationDriver } from '../../src/adapters/animation-drivers.js';
import { CAR_CUES } from './sound-controls.js';

function fitModel(root) {
  const bounds = new Box3().setFromObject(root);
  const size = bounds.getSize(new Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(extent) || extent <= 0) throw new Error('模型没有可显示的几何体。');
  const center = bounds.getCenter(new Vector3());
  const scale = 3.35 / extent;
  const display = new Group();
  display.scale.setScalar(scale);
  display.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  display.add(root);
  root.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = node.receiveShadow = true;
  });
  return display;
}

function disposeImported(root) {
  const materials = new Set();
  const geometries = new Set();
  const textures = new Set();
  root.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.material) for (const material of [].concat(node.material)) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
}

export function setupAnimationControls(scene, builtin, client) {
  const byId = id => document.getElementById(id);
  const modelFile = byId('modelFile');
  const resetModel = byId('resetModel');
  const modelStatus = byId('modelStatus');
  const doorReadout = byId('doorReadout');
  const doorState = byId('doorState');
  const lastAction = byId('lastAction');
  const bindings = Object.entries(CAR_CUES).map(([name, cue]) => ({
    ...cue,
    clip: byId(`${name}Clip`),
    loop: byId(`${name}Loop`),
    reverse: byId(`${name}Reverse`)
  }));
  let model;
  let mixer;
  let driver;
  let clips;
  let disposed = false;

  function removeModel() {
    if (!model) return;
    mixer.stopAllAction();
    mixer.uncacheRoot(model.root);
    scene.remove(model.display ?? model.root);
    if (model !== builtin) disposeImported(model.root);
  }

  function setModel(next, name) {
    removeModel();
    model = next;
    clips = model.clips.filter(clip => clip.tracks.length && clip.duration > 0);
    model.resetPose?.();
    mixer = new AnimationMixer(model.root);
    // Use the clip index to distinguish unnamed or duplicate clip names from the asset.
    driver = createThreeAnimationDriver({ mixer, clips: Object.fromEntries(clips.map((clip, index) => [index, clip])) });
    scene.add(model.display ?? model.root);
    doorReadout.hidden = model !== builtin;
    resetModel.hidden = model === builtin;
    lastAction.textContent = clips.length ? '等待目标声' : '模型没有可播放的动画';
    modelStatus.textContent = `${name} · ${clips.length} 段动画`;

    const names = new Map();
    for (const clip of clips) names.set(clip.name, (names.get(clip.name) ?? 0) + 1);
    const labels = clips.map((clip, index) => {
      if (!clip.name) return `动画 ${index + 1}`;
      return names.get(clip.name) > 1 ? `${clip.name}（${index + 1}）` : clip.name;
    });
    for (const [index, binding] of bindings.entries()) {
      binding.clip.replaceChildren(new Option('请选择动画', ''), ...labels.map((label, clipIndex) => new Option(label, String(clipIndex))));
      binding.clip.value = model === builtin ? String(index) : '';
      binding.loop.value = 'once';
      binding.reverse.checked = model === builtin && index === 1;
      binding.clip.disabled = binding.loop.disabled = binding.reverse.disabled = clips.length === 0;
    }
  }

  for (const binding of bindings) {
    client.on(binding.address, event => {
      if (!Number.isFinite(event.value) || event.value < 0.5) return;
      if (binding.clip.value === '') {
        lastAction.textContent = `${binding.label} · 请先选择动画`;
        return;
      }
      const options = { loop: binding.loop.value, reverse: binding.reverse.checked };
      const clip = clips[Number(binding.clip.value)];
      mixer.stopAllAction();
      model.prepare?.(clip, options);
      driver.trigger(binding.clip.value, options);
      lastAction.textContent = `${binding.label} · ${binding.clip.selectedOptions[0].textContent}`;
    });
  }

  modelFile.addEventListener('change', async () => {
    const [file] = modelFile.files;
    if (!file) return;
    modelFile.disabled = resetModel.disabled = true;
    const previousStatus = modelStatus.textContent;
    modelStatus.textContent = '正在读取 GLB…';
    let root;
    try {
      const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '');
      root = gltf.scene;
      if (disposed) return;
      const display = fitModel(root);
      setModel({ root, display, clips: gltf.animations }, file.name);
      root = null;
    } catch (error) {
      modelStatus.textContent = `载入失败，当前仍显示 ${previousStatus}。${error.message}`;
    } finally {
      if (root) disposeImported(root);
      modelFile.value = '';
      modelFile.disabled = resetModel.disabled = false;
    }
  });
  resetModel.addEventListener('click', () => setModel(builtin, '内置汽车'));
  setModel(builtin, '内置汽车');

  return {
    update(delta) {
      driver.update(delta);
      const pose = model.applyPose?.();
      if (pose && doorState.textContent !== pose) doorState.textContent = pose;
    },
    dispose() {
      disposed = true;
      removeModel();
    }
  };
}
