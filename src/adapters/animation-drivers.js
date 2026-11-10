import { clamp01 } from './level-response.js';

// Same numeric values as THREE.LoopOnce / THREE.LoopRepeat (Verge3D shares them),
// so no engine import is needed here.
const LOOP_ONCE = 2200;
const LOOP_REPEAT = 2201;

function splitParam(name, fallbackProperty) {
  const index = name.lastIndexOf(':');
  return index < 0 ? [name, fallbackProperty] : [name.slice(0, index), name.slice(index + 1)];
}

/** Driver from plain callbacks, for any engine or custom behaviour. */
export function createCallbackDriver({ trigger = () => false, setParam = () => {}, update } = {}) {
  return { trigger, setParam, update };
}

/**
 * Three.js (and Verge3D, whose AnimationMixer API matches) driver.
 * `clips` is an array of AnimationClip or a { name: clip } map.
 * Param names: "Clip:weight" (default) or "Clip:timeScale".
 */
export function createThreeAnimationDriver({ mixer, clips, ownsMixer = true } = {}) {
  if (!mixer?.clipAction) throw new TypeError('createThreeAnimationDriver needs an AnimationMixer');
  const byName = new Map(Array.isArray(clips) ? clips.map(clip => [clip.name, clip]) : Object.entries(clips || {}));
  const actions = new Map();
  const action = name => {
    if (!actions.has(name)) {
      const clip = byName.get(name);
      if (!clip) return null;
      actions.set(name, mixer.clipAction(clip));
    }
    return actions.get(name);
  };
  return {
    trigger(name, { intensity = 1, loop = 'once' } = {}) {
      const target = action(name);
      if (!target) return false;
      target.reset();
      target.setLoop(loop === 'repeat' ? LOOP_REPEAT : LOOP_ONCE, loop === 'repeat' ? Infinity : 1);
      target.clampWhenFinished = loop !== 'repeat';
      target.setEffectiveWeight(clamp01(intensity));
      target.play();
      return true;
    },
    setParam(name, value) {
      const [clipName, property] = splitParam(name, 'weight');
      const target = action(clipName);
      if (!target) return;
      if (property === 'timeScale') { target.setEffectiveTimeScale(value); return; }
      if (property !== 'weight') return;
      target.enabled = true;
      if (!target.isRunning()) target.play();
      target.setEffectiveWeight(clamp01(value));
    },
    update(delta) { if (ownsMixer) mixer.update(delta); },
    actions
  };
}

export const createVerge3DAnimationDriver = createThreeAnimationDriver;

/**
 * Babylon.js driver over AnimationGroups. `groups` is an array, a { name: group } map,
 * or omitted when `scene` is given (scene.animationGroups is used).
 * Param names: "Group:weight" (default) or "Group:speed".
 */
export function createBabylonAnimationDriver({ scene, groups } = {}) {
  const list = () => Array.isArray(groups) ? groups : groups ? Object.values(groups) : (scene?.animationGroups || []);
  const find = name => (groups && !Array.isArray(groups) && groups[name]) || list().find(group => group.name === name) || null;
  return {
    trigger(name, { intensity = 1, loop = 'once' } = {}) {
      const group = find(name);
      if (!group) return false;
      group.stop();
      group.start(loop === 'repeat', 1);
      group.setWeightForAllAnimatables(clamp01(intensity));
      return true;
    },
    setParam(name, value) {
      const [groupName, property] = splitParam(name, 'weight');
      const group = find(groupName);
      if (!group) return;
      if (property === 'speed') { group.speedRatio = value; return; }
      if (property !== 'weight') return;
      if (!group.isPlaying) group.start(true, group.speedRatio || 1);
      group.setWeightForAllAnimatables(clamp01(value));
    }
  };
}
