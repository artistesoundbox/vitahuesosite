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
 * Drop a clip's baked root translation.
 *
 * Mixamo bakes the rig's own travel into the root bone, and the clip files here
 * are not all authored in the same units as the mesh that wears them: the
 * officer's embedded idle clip moves the hips by centimetres' worth of numbers
 * while the walk, aim, crouch, jump and kick files move them by roughly a
 * hundred times that. Played on a rig that has already been scaled to metres,
 * the larger values throw the whole body out of the world — metres underground
 * while walking, metres into the air while aiming — which reads as a character
 * who floats and then vanishes off screen.
 *
 * The game drives every character's position itself, from its own velocity and
 * gravity, so the root's translation is not wanted from any clip: only the
 * rotations that pose the body are kept. Translation tracks on the other bones
 * are bind offsets rather than motion and are left alone.
 */
function stripRootMotion(clip, rootBoneName, modelNodeNames) {
  if (!clip || !clip.tracks) return clip;
  clip.tracks = clip.tracks.filter((track) => {
    if (!track.name.endsWith('.position')) return true;
    const node = track.name.slice(0, -'.position'.length);
    // The skeleton's own root bone, and the top-level object it hangs off (the
    // armature), are the two nodes that carry a clip's travel.
    if (node === rootBoneName) return false;
    return !modelNodeNames.has(node);
  });
  return clip;
}

/**
 * Stand every clip on the rig's own rest pose.
 *
 * With the root's travel gone a clip poses the body from the rig's rest
 * position, but the clip files were not written for this skeleton: the walk,
 * crouch, kick and jump files are crouched firing poses authored for a rig of
 * slightly different proportions, so on this officer their leg angles leave his
 * feet most of a metre off the ground. Each clip is therefore measured against
 * the mesh's own rest pose — how far its lowest foot bone sits from where this
 * rig's foot rests — and the root bone is pinned to a constant that closes that
 * gap. The officer is then standing where the game says he is in every state,
 * whatever the clip was drawn for.
 */
function anchorClipsToGround(root, clips, rootBoneName) {
  let rootBone = null;
  const skinned = [];
  root.traverse((o) => {
    if (!rootBone && o.isBone && o.name === rootBoneName) rootBone = o;
    if (o.isSkinnedMesh) skinned.push(o);
  });
  if (!rootBone || !skinned.length) return;

  const at = new THREE.Vector3();
  // The lowest point of the body as it is actually drawn, which is what a player
  // reads as standing on the ground or not. Bones alone would be fooled by a
  // clip whose ankle sits high while the boot it carries does not.
  const lowestPoint = () => {
    root.updateMatrixWorld(true);
    let low = Infinity;
    for (const mesh of skinned) {
      const pos = mesh.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 400));
      for (let v = 0; v < pos.count; v += step) {
        mesh.getVertexPosition(v, at);
        at.applyMatrix4(mesh.matrixWorld);
        if (at.y < low) low = at.y;
      }
    }
    return low;
  };

  const mixer = new THREE.AnimationMixer(root);
  /**
   * The lowest the body ever gets across a whole clip. A clip's authored first
   * frame is often a pose outside its cycle — the walk file opens with a stride
   * that stands most of a metre above every other frame of it — so anchoring on
   * one frame would judge the clip by its exception.
   */
  const clipFloor = (clip) => {
    if (!clip || !clip.tracks) return Infinity;
    const action = mixer.clipAction(clip);
    action.play();
    let low = Infinity;
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      mixer.setTime((clip.duration * i) / steps);
      const y = lowestPoint();
      if (y < low) low = y;
    }
    action.stop();
    return low;
  };

  const rest = rootBone.position.clone();
  // The idle clip is the pose the character is meant to stand in, so its floor
  // is the height every other clip is measured against.
  const reference = clips.idle || Object.values(clips)[0];
  const standing = clipFloor(reference);
  if (!Number.isFinite(standing)) {
    rootBone.position.copy(rest);
    lowestPoint();
    return;
  }

  // A height in the world has to be carried into the root bone's own axes: this
  // rig does not put the world's up on the bone's Y, so a correction written on
  // the wrong axis slides the officer sideways instead of setting him down.
  const toLocal = new THREE.Matrix3();
  if (rootBone.parent) {
    rootBone.parent.updateWorldMatrix(true, false);
    toLocal.setFromMatrix4(rootBone.parent.matrixWorld).invert();
  } else {
    toLocal.identity();
  }

  for (const clip of Object.values(clips)) {
    if (!clip || !clip.tracks) continue;
    // Positive means the clip sinks below the standing pose, which is the clip's
    // own business; only a clip left standing in the air is corrected.
    const lift = standing - clipFloor(clip);
    rootBone.position.copy(rest);
    lowestPoint();
    if (!Number.isFinite(lift) || lift > -0.01) continue;
    const pinned = rest.clone().add(new THREE.Vector3(0, lift, 0).applyMatrix3(toLocal));
    clip.tracks = clip.tracks.filter((t) => t.name !== `${rootBoneName}.position`);
    clip.tracks.push(new THREE.VectorKeyframeTrack(
      `${rootBoneName}.position`,
      [0, clip.duration],
      [pinned.x, pinned.y, pinned.z, pinned.x, pinned.y, pinned.z],
    ));
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  rootBone.position.copy(rest);
  lowestPoint();
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

  // The root bone and the top-level objects of this file name the nodes that
  // carry a clip's travel; every clip is measured against them before it is
  // handed on.
  let rootBoneName = null;
  root.traverse((o) => {
    if (!rootBoneName && o.isBone && !(o.parent && o.parent.isBone)) rootBoneName = o.name;
  });
  const modelNodeNames = new Set(root.children.map((c) => c.name));
  for (const clip of Object.values(clips)) stripRootMotion(clip, rootBoneName, modelNodeNames);

  normalizeCharacter(root, targetHeight);
  anchorClipsToGround(root, clips, rootBoneName);

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
 * The rotation that lays one frame onto another, built from two measured directions
 * in each rather than from three guessed angles.
 *
 * `from` is the model's own frame (its sole, its toe), `to` the frame it has to sit
 * in (the bone's). The second direction is squared up against the first so a
 * slightly slanted reading gives a rotation rather than a shear, and the third axis
 * is the cross product, so the result is always a proper rotation. This is the same
 * construction the rifle's mount is built from, and it is why neither fit has a
 * magic Euler in it: a boot or a rifle that arrives tilted or backwards is a
 * measurement that moved, and measuring again is the fix.
 */
export function mountRotation(from, to) {
  const a = new THREE.Vector3().fromArray(from.sole).normalize();
  const b = new THREE.Vector3().fromArray(from.toe).normalize();
  b.sub(a.clone().multiplyScalar(b.dot(a))).normalize();
  const c = new THREE.Vector3().fromArray(to.sole).normalize();
  const d = new THREE.Vector3().fromArray(to.toe).normalize();
  d.sub(c.clone().multiplyScalar(d.dot(c))).normalize();
  const basis = (x, y) => new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y));
  return new THREE.Quaternion()
    .setFromRotationMatrix(basis(c, d).multiply(basis(a, b).transpose()));
}

/**
 * Socket a standalone prop model onto a bone.
 *
 * `worldSize` is metres in the world he is drawn in, and it comes out exact: the
 * prop is measured with the bone's own transform taken out of the calculation, so
 * what it is sized and placed against is the model itself rather than the frame it
 * happened to be attached in. Measuring in world axes instead made both the size and
 * the fit depend on the pose — a boot socketed at one frame of a clip came out a
 * different size from the same boot socketed at another, and the sole landed
 * anywhere from on the grass to his ankle.
 *
 * Two details do the work. The box is read from the vertices (`precise`) rather than
 * from each mesh's own box: the union of transformed boxes overstates a rotated
 * model, which is how a boot asked for at 0.52 m measured 0.41 m. And the measurement
 * runs with `bone.matrixWorld` held at identity, because bone axes are not metres —
 * this rig's are centimetres — so the fit is converted through the bone's own world
 * scale, the same way the rifle's slide along its barrel is.
 */
export function attachToBone(bone, model, worldSize, offset = new THREE.Vector3(), rotation = null) {
  bone.add(model);
  model.position.set(0, 0, 0);
  model.quaternion.identity();
  // A plain Euler cannot express every fit — an axis and a half-turn is a hard
  // rotation to write as three angles — so the caller may hand over either.
  if (rotation) {
    if (rotation.isQuaternion) model.quaternion.copy(rotation);
    else model.quaternion.setFromEuler(rotation);
  }
  model.scale.setScalar(1);
  bone.updateWorldMatrix(true, true);

  const boneWorld = new THREE.Matrix4().copy(bone.matrixWorld);
  const boneScale = new THREE.Vector3().setFromMatrixScale(boneWorld);
  // The rig is scaled uniformly to his height; the largest axis is the honest one if
  // a rig ever is not.
  const unit = Math.max(Math.abs(boneScale.x), Math.abs(boneScale.y), Math.abs(boneScale.z)) || 1;

  // Everything below is measured in the bone's own frame, with the bone's transform
  // held out of it, so the result is a property of the model and not of the pose the
  // rig happened to be in when the prop arrived.
  bone.matrixWorld.identity();
  model.updateMatrixWorld(true);

  // Scale so the prop's longest axis measures `worldSize` in world units.
  let box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  model.scale.setScalar(worldSize / (longest * unit));
  model.updateMatrixWorld(true);

  // Shift the prop so its centre sits on the bone's origin, pushed by `offset`, which
  // is in the bone's own frame and in world metres. It is deliberately not a world
  // direction swung into the bone: an offset baked against the pose the rig happened
  // to be in means the same boot sits differently when it is equipped at spawn than
  // when it is equipped mid-kick, which is four centimetres of sole on this rig.
  box = new THREE.Box3().setFromObject(model, true);
  const center = box.getCenter(new THREE.Vector3());
  model.position.add(offset.clone().divideScalar(unit).sub(center));
  model.updateMatrixWorld(true);

  bone.matrixWorld.copy(boneWorld);
  model.updateMatrixWorld(true);
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return model;
}

/**
 * The officer's hand, measured rather than guessed, in the frame the rifle is
 * bolted to.
 *
 * Every clip he holds the weapon in — aim, walk, crouch — points the hand bone's
 * own +Y forward and its own -X up; the plain idle hangs that same +Y at his side.
 * Both are properties of the rig and of Mixamo's rifle clips, not of the rifle, so
 * they live here rather than in the weapon's fit.
 */
const HAND_FORWARD = [0, 1, 0];
const HAND_DOWN = [-1, 0, 0];

/**
 * Mount the rifle in a hand, gripped and pointing where the hand points.
 *
 * The whole fit is one constant rotation, because the rifle is welded to the hand
 * bone: whatever the clip does to the hand, the rifle goes with it. That rotation
 * maps a direction in the model's own frame onto a direction in the hand's frame,
 * and it is built from the four measured directions in WEAPON rather than written
 * out as angles: the muzzle onto the hand's forward axis, the magazine onto its
 * down axis. Laid along the hand's X instead — which is what an unrotated model
 * gets — the rifle stands upright through the officer's fist and points at the sky
 * the moment he aims, which no angle of clip can fix.
 *
 * The hand then has to take the rifle by the grip instead of through its middle:
 * `attachToBone` centres the prop on the bone, so the rifle is slid its own length
 * along its barrel until the share of it in `grip` sits behind the hand. Bone axes
 * are not metres — this rig's are centimetres — so the slide is converted through
 * the bone's own world scale, the same way the size is.
 */
export function socketRifle(bone, model, { size, grip, muzzle, magazine }) {
  // The barrel onto the hand's forward axis, the magazine onto its down axis — the
  // same two-direction mount a boot gets, measured on the model rather than written
  // as angles.
  const rotation = mountRotation(
    { sole: magazine, toe: muzzle },
    { sole: HAND_DOWN, toe: HAND_FORWARD },
  );
  const along = new THREE.Vector3().fromArray(muzzle).normalize();

  const rifle = attachToBone(bone, model, size, new THREE.Vector3(), rotation);
  const boneScale = new THREE.Vector3().setFromMatrixScale(bone.matrixWorld).y || 1;
  rifle.position.y += (size * (0.5 - grip)) / boneScale;

  // The point a round leaves from: the vertex the rifle reaches furthest along its
  // own muzzle direction — the tip of the barrel, measured off the model rather
  // than placed by hand, so a different rifle only has to be measured again. The
  // game hangs the muzzle flash and the tracer's first frame on it.
  const tip = new THREE.Object3D();
  tip.name = 'muzzle';
  tip.position.copy(tipAlong(rifle, along));
  rifle.add(tip);
  return { rifle, muzzle: tip };
}

/**
 * The point of a model that reaches furthest along one of its own directions.
 *
 * Anything with a barrel has its own shape to say where that barrel ends, so the
 * tip is read off the geometry instead of being offset by a number that only fits
 * the model it was tuned on.
 */
function tipAlong(model, direction) {
  model.updateWorldMatrix(true, true);
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const at = new THREE.Vector3();
  const furthest = new THREE.Vector3();
  let best = -Infinity;
  model.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 600));
    for (let i = 0; i < pos.count; i += step) {
      at.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(toModel);
      const reach = at.dot(direction);
      if (reach > best) { best = reach; furthest.copy(at); }
    }
  });
  return furthest;
}
