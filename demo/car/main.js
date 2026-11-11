import * as THREE from 'three';
import { YHEventClient } from '../../src/event-client.mjs';
import { resolveBridgeUrl } from '../../src/bridge-url.mjs';
import { releaseOnPageHide } from '../../src/page-lifecycle.mjs';
import { createCar } from './car.js';
import { setupAnimationControls } from './animation-controls.js';
import { setupSoundControls } from './sound-controls.js';
import '../../examples/demo.css';
import './style.css';

const $ = selector => document.querySelector(selector);
const stage = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas: $('#canvas'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11151e);
scene.fog = new THREE.FogExp2(0x11151e, 0.085);
const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 60);
const lookAt = new THREE.Vector3(-0.12, 0.69, 0.22);
const cameraOffset = new THREE.Vector3(-3.7, 3.05, 7.35);

scene.add(new THREE.HemisphereLight(0xdbeaff, 0x6d4451, 2.0));
const key = new THREE.DirectionalLight(0xffebd9, 3.0);
key.position.set(-3.4, 6.6, 4);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5 });
key.shadow.normalBias = 0.025;
scene.add(key);
const rim = new THREE.DirectionalLight(0x9abdff, 2.6);
rim.position.set(3.4, 2.4, -4.2);
scene.add(rim);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), new THREE.MeshStandardMaterial({ color: 0x222734, roughness: 0.84 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.081;
floor.receiveShadow = true;
scene.add(floor);
const platform = new THREE.Mesh(new THREE.CylinderGeometry(3.55, 3.63, 0.08, 80), new THREE.MeshStandardMaterial({ color: 0x323b4d, roughness: 0.85 }));
platform.position.y = -0.04;
platform.receiveShadow = true;
scene.add(platform);
const rimLine = new THREE.Mesh(new THREE.RingGeometry(3.38, 3.405, 80), new THREE.MeshBasicMaterial({ color: 0x64738f }));
rimLine.rotation.x = -Math.PI / 2;
rimLine.position.y = 0.002;
scene.add(rimLine);

function resize() {
  const width = Math.max(stage.clientWidth, 1);
  const height = Math.max(stage.clientHeight, 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.position.copy(cameraOffset).multiplyScalar(Math.max(1, 1.15 / camera.aspect)).add(lookAt);
  camera.lookAt(lookAt);
  camera.updateProjectionMatrix();
}
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(stage);
resize();

const client = new YHEventClient({ url: resolveBridgeUrl(window.location), sourceId: 'yh-car' });
const stopSoundControls = setupSoundControls(client);
const animations = setupAnimationControls(scene, createCar(), client);

function setConnection(connected) {
  $('#dot').classList.toggle('on', connected);
  $('#status').textContent = connected ? '本机桥接已连接' : '未连接本机桥接 · 正在重试';
}
client.on('status', state => {
  if (state.status === 'connected') setConnection(true);
  if (['error', 'stale', 'disconnected'].includes(state.status)) setConnection(false);
});
client.connect().catch(() => setConnection(false));

let lastFrame = performance.now();
renderer.setAnimationLoop(now => {
  const delta = Math.max(0, Math.min((now - lastFrame) / 1000, 0.05));
  lastFrame = now;
  animations.update(delta);
  renderer.render(scene, camera);
});

releaseOnPageHide(() => {
  stopSoundControls();
  client.close();
  resizeObserver.disconnect();
  renderer.setAnimationLoop(null);
  animations.dispose();
  renderer.dispose();
});
