import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export function createCar() {
  const car = new THREE.Group();
  const material = (color, options = {}) => new THREE.MeshStandardMaterial({ color, ...options });
  const paint = material(0xd13b29, { metalness: 0.27, roughness: 0.29 });
  const trim = material(0x191b21, { roughness: 0.48 });
  const interior = material(0x454956, { roughness: 0.86 });
  const tire = material(0x121318, { roughness: 0.95 });
  const alloy = material(0x9ea8b8, { metalness: 0.45, roughness: 0.27 });
  const glass = material(0x7694ab, { roughness: 0.18, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
  const headlights = material(0xcde8ff, { emissive: 0xb6ddff, emissiveIntensity: 0.12, roughness: 0.25 });
  const tailLights = material(0x980e0f, { emissive: 0xd72322, emissiveIntensity: 0.25 });

  function add(parent, geometry, surface, x, y, z) {
    const mesh = new THREE.Mesh(geometry, surface);
    mesh.position.set(x, y, z);
    mesh.castShadow = !surface.transparent;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function box(parent, surface, size, position, radius = 0.04) {
    return add(parent, new RoundedBoxGeometry(...size, 2, radius), surface, ...position);
  }

  function pillar(x, bottom, top) {
    const start = new THREE.Vector3(x, ...bottom);
    const end = new THREE.Vector3(x, ...top);
    const middle = start.clone().lerp(end, 0.5);
    const beam = box(car, trim, [0.075, start.distanceTo(end), 0.075], middle.toArray(), 0.02);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
  }

  function pane(parent, points) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    return add(parent, geometry, glass, 0, 0, 0);
  }

  // Side profile in the (length, height) plane. The arches leave the tires visible.
  const profile = new THREE.Shape();
  profile.moveTo(-1.86, 0.34);
  for (const axle of [-1.22, 1.22]) {
    profile.lineTo(axle - 0.43, 0.34);
    profile.bezierCurveTo(axle - 0.43, 0.91, axle + 0.43, 0.91, axle + 0.43, 0.34);
  }
  profile.lineTo(1.92, 0.34);
  profile.quadraticCurveTo(2, 0.62, 1.87, 0.82);
  profile.lineTo(-1.78, 0.82);
  profile.quadraticCurveTo(-1.95, 0.64, -1.86, 0.34);
  const shell = add(car, new THREE.ExtrudeGeometry(profile, {
    depth: 1.7, bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 2, steps: 1
  }), paint, 0.85, 0, 0);
  shell.rotation.y = -Math.PI / 2;

  box(car, trim, [1.46, 0.16, 1.56], [0, 0.56, 0]);
  box(car, paint, [1.72, 0.19, 1.13], [0, 0.82, 1.25], 0.09);
  box(car, paint, [1.72, 0.23, 0.95], [0, 0.85, -1.31], 0.09);
  box(car, paint, [1.43, 0.12, 1.32], [0, 1.51, -0.23], 0.06);
  box(car, trim, [1.76, 0.14, 0.13], [0, 0.43, 1.91]);
  box(car, trim, [1.74, 0.14, 0.13], [0, 0.43, -1.84]);
  box(car, trim, [0.68, 0.11, 0.08], [0, 0.64, 1.95]);
  box(car, alloy, [0.48, 0.015, 0.025], [0, 0.64, 1.999], 0.006);

  pane(car, [[-0.78, 0.92, 0.88], [0.78, 0.92, 0.88], [0.67, 1.47, 0.40], [-0.67, 1.47, 0.40]]);
  pane(car, [[0.67, 1.47, -0.86], [-0.67, 1.47, -0.86], [-0.78, 0.95, -1.53], [0.78, 0.95, -1.53]]);

  for (const side of [-1, 1]) {
    const x = side * 0.75;
    pillar(x, [0.91, 0.87], [1.48, 0.4]);
    pillar(x, [0.91, -1.55], [1.48, -0.86]);
    pillar(x, [0.92, -0.56], [1.47, -0.51]);
    box(car, interior, [0.46, 0.14, 0.55], [side * 0.41, 0.73, -0.12], 0.06);
    const seat = box(car, interior, [0.46, 0.44, 0.15], [side * 0.41, 0.97, -0.36], 0.07);
    seat.rotation.x = 0.14;
    box(car, interior, [0.24, 0.15, 0.13], [side * 0.41, 1.22, -0.39], 0.06);

    for (const z of [-1.22, 1.22]) {
      const wheel = new THREE.Group();
      wheel.position.set(side * 0.88, 0.37, z);
      wheel.rotation.z = Math.PI / 2;
      car.add(wheel);
      add(wheel, new THREE.CylinderGeometry(0.37, 0.37, 0.23, 40), tire, 0, 0, 0);
      add(wheel, new THREE.CylinderGeometry(0.245, 0.245, 0.025, 32), trim, 0, -side * 0.115, 0);
      const rim = add(wheel, new THREE.TorusGeometry(0.222, 0.023, 10, 32), alloy, 0, -side * 0.132, 0);
      rim.rotation.x = Math.PI / 2;
      for (let spoke = 0; spoke < 5; spoke++) {
        const angle = spoke * 2 * Math.PI / 5;
        const bar = box(wheel, alloy, [0.05, 0.024, 0.20], [0.107 * Math.sin(angle), -side * 0.135, 0.107 * Math.cos(angle)], 0.01);
        bar.rotation.y = angle;
      }
      add(wheel, new THREE.CylinderGeometry(0.062, 0.062, 0.03, 20), alloy, 0, -side * 0.145, 0);
    }

    box(car, headlights, [0.38, 0.13, 0.10], [side * 0.62, 0.76, 1.92], 0.045);
    box(car, tailLights, [0.31, 0.11, 0.08], [side * 0.64, 0.78, -1.82], 0.035);
  }

  box(car, trim, [1.42, 0.14, 0.24], [0, 0.93, 0.69]);
  const steering = add(car, new THREE.TorusGeometry(0.13, 0.024, 10, 24), trim, -0.42, 0.99, 0.42);
  steering.rotation.x = -0.32;

  function makeDoor(side) {
    const door = new THREE.Group();
    door.position.set(side * 0.87, 0.65, 0.70);
    car.add(door);
    box(door, paint, [0.09, 0.35, 1.22], [0, 0.11, -0.62], 0.04);
    box(door, interior, [0.035, 0.28, 1.12], [-side * 0.05, 0.11, -0.62]);
    box(door, trim, [0.10, 0.045, 1.18], [0, 0.28, -0.62], 0.017);
    box(door, alloy, [0.03, 0.035, 0.16], [side * 0.048, 0.22, -0.97], 0.01);
    pane(door, [[0, 0.29, -0.03], [0, 0.29, -1.21], [-side * 0.11, 0.80, -1.19], [-side * 0.11, 0.80, -0.35]]);
    box(door, trim, [0.15, 0.09, 0.18], [side * 0.12, 0.31, -0.18]);
    return door;
  }

  const driverDoor = makeDoor(-1);
  const passengerDoor = makeDoor(1);

  // Additive halos stay legible even when a camera view doesn't show the ground directly ahead.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, '#fff');
  gradient.addColorStop(0.26, '#fff9');
  gradient.addColorStop(1, '#fff0');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const glow = new THREE.CanvasTexture(canvas);
  const haloMaterial = new THREE.SpriteMaterial({ map: glow, color: 0xbcdfff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const poolMaterial = new THREE.MeshBasicMaterial({ map: glow, color: 0x8dbfff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  for (const x of [-0.62, 0.62]) {
    const halo = new THREE.Sprite(haloMaterial);
    halo.position.set(x, 0.76, 2.02);
    halo.scale.set(1.6, 1.6, 1);
    car.add(halo);
    const pool = add(car, new THREE.PlaneGeometry(1.75, 2.4), poolMaterial, x * 1.15, 0.016, 2.89);
    pool.rotation.x = -Math.PI / 2;
  }

  function setLights(strength) {
    headlights.emissiveIntensity = 0.12 + strength * 5;
    haloMaterial.opacity = strength;
    poolMaterial.opacity = strength * 0.65;
  }

  const openAngle = THREE.MathUtils.degToRad(67);
  const doorTimes = Array.from({ length: 9 }, (_, index) => 0.67 * index / 8);
  const doorTrack = new THREE.NumberKeyframeTrack('.doorProgress', doorTimes,
    doorTimes.map(time => THREE.MathUtils.smoothstep(time, 0, 0.67)));
  const flashTrack = new THREE.NumberKeyframeTrack('.lightStrength',
    [0, 0.07, 0.14, 0.21, 0.28, 0.43, 0.50, 0.57, 0.64, 0.71],
    [0, 0.71, 1, 0.71, 0, 0, 0.71, 1, 0.71, 0]);
  car.animations = [
    new THREE.AnimationClip('开门并闪灯', 0.71, [doorTrack.clone(), flashTrack.clone()]),
    new THREE.AnimationClip('双门开合', 0.67, [doorTrack]),
    new THREE.AnimationClip('前照灯双闪', 0.71, [flashTrack])
  ];
  car.doorProgress = 0;
  car.lightStrength = 0;
  let doorMotion = null;
  setLights(0);

  return {
    root: car,
    clips: car.animations,
    resetPose() {
      doorMotion = null;
      driverDoor.rotation.y = passengerDoor.rotation.y = 0;
      car.doorProgress = car.lightStrength = 0;
    },
    prepare(clip, { loop, reverse }) {
      const opening = !reverse;
      car.doorProgress = opening ? 0 : 1;
      car.lightStrength = 0;
      doorMotion = clip.tracks.some(track => track.name === '.doorProgress') ? {
        from: loop === 'repeat' ? (opening ? 0 : openAngle) : driverDoor.rotation.y,
        to: opening ? openAngle : 0,
        reverse
      } : null;
    },
    applyPose() {
      setLights(car.lightStrength);
      if (doorMotion) {
        const progress = doorMotion.reverse ? 1 - car.doorProgress : car.doorProgress;
        const angle = THREE.MathUtils.lerp(doorMotion.from, doorMotion.to, progress);
        driverDoor.rotation.y = angle;
        passengerDoor.rotation.y = -angle;
      }
      if (driverDoor.rotation.y < 0.001) return '已关闭';
      if (driverDoor.rotation.y > openAngle - 0.001) return '已打开';
      return '开合中';
    }
  };
}
