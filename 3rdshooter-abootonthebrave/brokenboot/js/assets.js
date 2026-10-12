import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

export const fbxLoader = new FBXLoader();
export const gltfLoader = new GLTFLoader();

export function loadFBX(url, onProgress) {
  return new Promise((resolve, reject) => {
    fbxLoader.load(url, resolve, onProgress, reject);
  });
}

/**
 * The bounds of the character itself.
 *
 * A mesh file can model more than the body: a boot, a holster or a weapon placed
 * alongside it. Those props are not part of the figure, and one that reaches above
 * the head or below the feet would otherwise decide the scale — the officer would
 * be sized to whatever reaches furthest. So the body is what is measured, and the
 * everything-included box is only the fallback for a file with nothing skinned.
 */
function characterBox(root) {
  const box = new THREE.Box3();
  let skinned = 0;
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    skinned++;
    box.expandByObject(o);
  });
  if (skinned) return box;
  return box.setFromObject(root);
}

/** Mixamo exports are in centimetres and are not authored at metre scale. */
export function normalizeCharacter(root, targetHeight) {
  root.updateMatrixWorld(true);
  const box = characterBox(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetHeight / (size.y || 1);
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);
  const box2 = characterBox(root);
  root.position.y -= box2.min.y;
  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      // Skinned bounds are unreliable once bones move; keep them drawn.
      o.frustumCulled = false;
    }
  });
  return scale;
}

function takeClip(root) {
  const list = root.animations || [];
  if (!list.length) return null;
  return list[0];
}

/**
 * Load a character mesh together with its named animation clips.
 * Clips are keyed by the state name used by the animation controller,
 * because Mixamo bakes every clip with the same internal name.
 */
export async function buildCharacter({ meshUrl, clipUrls = {}, targetHeight, onProgress, onStep }) {
  const root = await loadFBX(meshUrl, onProgress);
  const clips = {};
  const embedded = takeClip(root);
  if (embedded) clips.idle = embedded;

  const keys = Object.keys(clipUrls);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (onStep) onStep(key, i, keys.length);
    try {
      const source = await loadFBX(clipUrls[key]);
      const clip = takeClip(source);
      if (clip) clips[key] = clip;
    } catch (err) {
      console.warn(`[assets] clip "${key}" failed to load (${clipUrls[key]})`, err);
    }
  }

  normalizeCharacter(root, targetHeight);

  return {
    root,
    clips,
    instantiate() {
      return skeletonClone(root);
    },
  };
}

/** Crossfading state machine over a named clip set. */
export class AnimController {
  constructor(root, clips) {
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = {};
    for (const [key, clip] of Object.entries(clips || {})) {
      const action = this.mixer.clipAction(clip);
      this.actions[key] = action;
    }
    this.name = null;
    this.oneShot = null;
    this.onFinish = null;
    this.mixer.addEventListener('finished', (e) => {
      if (this.oneShot && e.action === this.oneShot) {
        const cb = this.onFinish;
        this.oneShot = null;
        this.onFinish = null;
        if (cb) cb();
      }
    });
  }

  has(key) { return Boolean(this.actions[key]); }
  get busy() { return Boolean(this.oneShot); }

  play(key, { fade = 0.22, timeScale = 1 } = {}) {
    const action = this.actions[key];
    if (!action) return;
    if (this.name === key) { action.setEffectiveTimeScale(timeScale); return; }
    if (this.oneShot) return;
    const prev = this.name ? this.actions[this.name] : null;
    if (prev) prev.fadeOut(fade);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.setEffectiveTimeScale(timeScale);
    action.setEffectiveWeight(1);
    action.fadeIn(fade).play();
    this.name = key;
  }

  /** Play a clip exactly once, then hand control back to the caller. */
  once(key, { fade = 0.1, timeScale = 1 } = {}, onFinish) {
    const action = this.actions[key];
    if (!action) { if (onFinish) onFinish(); return; }
    for (const [name, other] of Object.entries(this.actions)) {
      if (name !== key) other.fadeOut(0.12);
    }
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(timeScale);
    action.setEffectiveWeight(1);
    action.fadeIn(fade).play();
    this.oneShot = action;
    this.onFinish = onFinish || null;
    this.name = key;
    return action;
  }

  update(dt) { this.mixer.update(dt); }
}

/** Find a bone whose name matches any of the supplied patterns. */
export function findBone(root, patterns) {
  let found = null;
  root.traverse((o) => {
    if (found || !o.isBone) return;
    for (const p of patterns) {
      if (new RegExp(p, 'i').test(o.name)) { found = o; return; }
    }
  });
  return found;
}

/**
 * Socket a standalone prop model onto a bone.
 *
 * Everything is measured in world space (where the rig may be scaled to metres)
 * and the resulting correction is converted back through the bone's inverse world
 * matrix, so the prop ends up centred on the bone at the requested world size
 * regardless of the rig's own units.
 */
export function attachToBone(bone, model, worldSize, offset = new THREE.Vector3(), rotation = null) {
  bone.add(model);
  model.position.set(0, 0, 0);
  model.quaternion.identity();
  if (rotation) model.quaternion.setFromEuler(rotation);
  model.scale.setScalar(1);
  bone.updateWorldMatrix(true, true);

  // Scale so the prop's longest axis measures `worldSize` in world units.
  let box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  model.scale.setScalar(worldSize / longest);
  bone.updateWorldMatrix(true, true);

  // Shift the prop so its centre sits on the bone's origin.
  box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const boneWorld = new THREE.Vector3();
  bone.getWorldPosition(boneWorld);
  const deltaWorld = boneWorld.clone().sub(center).add(offset);

  const inverse = new THREE.Matrix4().copy(bone.matrixWorld).invert();
  const deltaLocal = boneWorld.clone().add(deltaWorld).applyMatrix4(inverse);
  model.position.add(deltaLocal);

  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  bone.updateWorldMatrix(true, true);
  return model;
}
