import * as THREE from 'three';
import { SETTINGS, VEHICLE, LANDSCAPE, SKY, ASSET_BASE } from './config.js';
import { gltfLoader } from './assets.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function groundTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3f5230';
  ctx.fillRect(0, 0, size, size);
  const rand = makeRandom(99);
  for (let i = 0; i < 5200; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const shade = 34 + Math.floor(rand() * 42);
    const g = 60 + Math.floor(rand() * 46);
    ctx.fillStyle = `rgba(${shade},${g},${28 + Math.floor(rand() * 26)},0.5)`;
    const r = 1 + rand() * 3;
    ctx.fillRect(x, y, r, r);
  }
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${90 + Math.floor(rand() * 40)},${110 + Math.floor(rand() * 40)},${50},0.25)`;
    ctx.fillRect(rand() * size, rand() * size, 1, 2 + rand() * 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(48, 48);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class World {
  /**
   * `seed` fixes the forest. The trees, the cover and the cars all come out of
   * one stream, so the same seed always builds the same layout and a different
   * one builds a different one — which is what lets the harness fuzz the terrain
   * as well as the fight, and what `layoutHash` is the fingerprint of.
   */
  constructor(scene, seed = SETTINGS.worldSeed) {
    this.scene = scene;
    this.cylinders = []; // { x, z, r, top }
    this.boxes = [];     // THREE.Box3
    // Scenery that can be kicked about. Each prop keeps the very Box3 that
    // already blocks bullets, sight lines and movement, and that box is moved
    // with the mesh — so a car shoved out of the way opens the firing line it
    // was blocking, for the player and the attackers alike.
    this.props = [];
    this.seed = seed >>> 0;
    this.rand = makeRandom(this.seed);
    // Folded from every tree, crate and car as it is placed: two seeds that built
    // different forests cannot share it, and a report can say which forest it got
    // without dumping 165 positions.
    this.layoutHash = 0;
    this._ray = new THREE.Ray();
    this._tmp = new THREE.Vector3();
    // Separate scratch vector: hasLineOfSight() rewrites _tmp, so a probe point
    // must never share it or the sight test silently compares a point to itself.
    this._probe = new THREE.Vector3();
    // raycast() writes its box hit into _tmp, so the sight test must aim along
    // its own vector or the tree pass would read a hit point as a direction.
    this._sightDir = new THREE.Vector3();
  }

  /** Fold one placed thing into the layout fingerprint. */
  mixLayout(x, z) {
    const ix = Math.round(x * 100) | 0;
    const iz = Math.round(z * 100) | 0;
    this.layoutHash = (Math.imul(this.layoutHash, 31) + ix + Math.imul(iz, 7919)) | 0;
    return this.layoutHash;
  }

  /** Nearest blocker along a ray, or null. Used for bullets and line of sight. */
  raycast(origin, direction, maxDistance = 200) {
    const ray = this._ray.set(origin, direction);
    let best = null;

    for (const box of this.boxes) {
      const hit = ray.intersectBox(box, this._tmp);
      if (hit) {
        const t = hit.distanceTo(origin);
        if (t <= maxDistance && (!best || t < best.t)) best = { t, point: hit.clone(), kind: 'box' };
      }
    }

    // Ray/cylinder: solve in the XZ plane, then validate against height.
    const ox = origin.x, oz = origin.z;
    const dx = direction.x, dz = direction.z;
    const a = dx * dx + dz * dz;
    if (a > 1e-6) {
      for (const c of this.cylinders) {
        const fx = ox - c.x, fz = oz - c.z;
        const b = 2 * (fx * dx + fz * dz);
        const cc = fx * fx + fz * fz - c.r * c.r;
        const disc = b * b - 4 * a * cc;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        let t = (-b - sq) / (2 * a);
        if (t < 0) t = (-b + sq) / (2 * a);
        if (t < 0 || t > maxDistance) continue;
        const y = origin.y + direction.y * t;
        if (y < -1 || y > c.top) continue;
        if (!best || t < best.t) {
          best = { t, point: new THREE.Vector3(ox + dx * t, y, oz + dz * t), kind: 'tree' };
        }
      }
    }
    return best;
  }

  hasLineOfSight(from, to) {
    const dir = this._sightDir.copy(to).sub(from);
    const dist = dir.length();
    if (dist < 1e-3) return true;
    dir.divideScalar(dist);
    const hit = this.raycast(from, dir, dist - 0.6);
    return !hit;
  }

  /** Push an actor out of any static obstacle it overlaps. */
  resolveCircle(position, radius) {
    for (const c of this.cylinders) {
      const dx = position.x - c.x;
      const dz = position.z - c.z;
      const min = c.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (min - d) / d;
        position.x += dx * push;
        position.z += dz * push;
      }
    }
    for (const box of this.boxes) {
      const cx = THREE.MathUtils.clamp(position.x, box.min.x, box.max.x);
      const cz = THREE.MathUtils.clamp(position.z, box.min.z, box.max.z);
      const dx = position.x - cx;
      const dz = position.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < radius * radius) {
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (radius - d) / d;
          position.x += dx * push;
          position.z += dz * push;
        } else {
          // Centre is inside the box: eject along the shallowest axis.
          const left = Math.abs(position.x - box.min.x);
          const right = Math.abs(box.max.x - position.x);
          const back = Math.abs(position.z - box.min.z);
          const front = Math.abs(box.max.z - position.z);
          const m = Math.min(left, right, back, front);
          if (m === left) position.x = box.min.x - radius;
          else if (m === right) position.x = box.max.x + radius;
          else if (m === back) position.z = box.min.z - radius;
          else position.z = box.max.z + radius;
        }
      }
    }
  }

  /**
   * A spot near `from` that breaks line of sight to `threat`, so attackers can
   * bound from cover to cover instead of walking in the open. Candidates are the
   * static obstacles (trees, the car, the crates); each is scored toward
   * `preferred` metres from the threat and then by how close it is to `from`.
   * Returns null when nothing within `maxDistance` blocks the sight line.
   */
  findCover(from, threat, { maxDistance = 18, preferred = 15, minRange = 10 } = {}) {
    const candidates = [];
    const consider = (cx, cz, r) => {
      const dx = cx - threat.x;
      const dz = cz - threat.z;
      const d = Math.hypot(dx, dz) || 1;
      // Stand on the far side of the obstacle, out of the threat's sight line.
      const px = cx + (dx / d) * (r + 1.2);
      const pz = cz + (dz / d) * (r + 1.2);
      if (Math.hypot(px - from.x, pz - from.z) > maxDistance) return;
      // Never bundle up in the player's lap: cover only counts at a distance.
      const toThreat = Math.hypot(px - threat.x, pz - threat.z);
      if (toThreat < minRange) return;
      candidates.push([px, pz]);
    };
    for (const c of this.cylinders) consider(c.x, c.z, c.r);
    for (const box of this.boxes) {
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const r = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
      consider(cx, cz, r);
    }

    let best = null;
    let bestScore = Infinity;
    for (const [px, pz] of candidates) {
      // Probe at chest height so a crate counts as cover, not just a tree.
      this._probe.set(px, 1.25, pz);
      if (this.hasLineOfSight(this._probe, threat)) continue;
      const toThreat = Math.hypot(px - threat.x, pz - threat.z);
      const tramp = Math.hypot(px - from.x, pz - from.z);
      const score = Math.abs(toThreat - preferred) + tramp * 0.4;
      if (score < bestScore) {
        bestScore = score;
        best = new THREE.Vector3(px, 0, pz);
      }
    }
    return best;
  }

  /** A spawn point on open ground at a given radius band from a centre. */
  findSpawn(center, minRadius, maxRadius) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const angle = this.rand() * Math.PI * 2;
      const radius = minRadius + this.rand() * (maxRadius - minRadius);
      const x = center.x + Math.cos(angle) * radius;
      const z = center.z + Math.sin(angle) * radius;
      const limit = SETTINGS.worldSize / 2 - 6;
      if (Math.abs(x) > limit || Math.abs(z) > limit) continue;
      const p = new THREE.Vector3(x, 0, z);
      let blocked = false;
      for (const c of this.cylinders) {
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < c.r + 1.2) { blocked = true; break; }
      }
      if (!blocked) return p;
    }
    return new THREE.Vector3(center.x + minRadius, 0, center.z);
  }

  addCylinder(x, z, r, top) {
    this.cylinders.push({ x, z, r, top });
  }

  addBox(box) {
    this.boxes.push(box);
  }

  /**
   * Register a piece of scenery as something the boot can move. `mass` decides
   * how much of a kick it takes: a crate flies, a car shoves. `kind` is only for
   * reporting.
   */
  addProp(mesh, box, { mass = 1, radius = 1, kind = 'scenery' } = {}) {
    const prop = {
      mesh, box, mass, radius, kind,
      baseY: mesh.position.y,          // the height it sits at on the ground
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      hitTimer: 0,
      rest: true,
    };
    this.props.push(prop);
    return prop;
  }

  /**
   * Everything with a mass inside the kick's reach and arc takes an impulse: the
   * along-kick part is `propPower / mass` and the upward part `propLift / mass`,
   * so the same stomp skitters crates and only shifts a car. Returns what moved,
   * for the banner and the achievements.
   */
  kickProps(origin, forward, kick, powerScale = 1) {
    const hit = [];
    for (const p of this.props) {
      const to = this._tmp.set(
        p.mesh.position.x - origin.x, 0, p.mesh.position.z - origin.z,
      );
      const dist = to.length();
      if (dist > kick.range + p.radius) continue;
      if (dist > 1e-3) to.divideScalar(dist);
      if (Math.acos(Math.max(-1, Math.min(1, to.dot(forward)))) > kick.arc) continue;

      const power = (kick.propPower * powerScale) / p.mass;
      p.vel.x += forward.x * power;
      p.vel.z += forward.z * power;
      p.vel.y += (kick.propLift * powerScale) / p.mass;
      // Tumble about the axis across the kick, plus a bit of roll either way.
      p.spin.x += -forward.z * power * 0.35;
      p.spin.z += forward.x * power * 0.35;
      p.spin.y += (this.rand() - 0.5) * power * 0.3;
      p.rest = false;
      hit.push(p);
    }
    return hit;
  }

  /**
   * Integrate the scenery. Only the movers are simulated, and each settles where
   * it comes to rest rather than snapping back, so a kicked car stays where it
   * ended up and keeps working as cover there.
   *
   * `bodies` are the things a fast-moving prop can knock down (the attackers),
   * and `onHit(prop, body, speed)` reports a real impact.
   */
  updateProps(dt, { bodies = [], onHit = null } = {}) {
    const sleep = SETTINGS.propSleepSpeed;

    for (const p of this.props) {
      if (p.rest) continue;
      if (p.hitTimer > 0) p.hitTimer -= dt;

      p.vel.y += SETTINGS.gravity * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - SETTINGS.propDrag * dt));

      const pos = p.mesh.position;
      pos.addScaledVector(p.vel, dt);

      // Ground: the prop comes back to the height it started at, which is where
      // the ground is — the whole clearing is flat.
      if (pos.y < p.baseY) {
        pos.y = p.baseY;
        if (p.vel.y < 0) {
          p.vel.y = -p.vel.y * SETTINGS.propRestitution;
          if (p.vel.y < 0.6) p.vel.y = 0;
        }
        // Friction on the ground, and the tumble slows with it.
        p.vel.x *= Math.max(0, 1 - 2.6 * dt);
        p.vel.z *= Math.max(0, 1 - 2.6 * dt);
      }

      this._bounceProp(p);

      p.spin.multiplyScalar(Math.max(0, 1 - SETTINGS.propSpinDrag * dt));
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;

      // Update the box that blocks bullets, sight lines and movement in place,
      // so every system that already consults it follows the prop.
      p.box.setFromObject(p.mesh).expandByScalar(-0.05);

      const speed = p.vel.length();
      if (speed > SETTINGS.propHitSpeed && p.hitTimer <= 0) {
        for (const body of bodies) {
          if (!body || body.dead || body.routed) continue;
          const dx = body.position.x - pos.x;
          const dz = body.position.z - pos.z;
          const reach = p.radius + 0.8;
          if (dx * dx + dz * dz > reach * reach) continue;
          p.hitTimer = 0.3;
          if (onHit) onHit(p, body, speed);
          break;
        }
      }

      if (speed < sleep && p.vel.y === 0 && pos.y <= p.baseY + 1e-3) {
        p.vel.set(0, 0, 0);
        p.spin.set(0, 0, 0);
        pos.y = p.baseY;
        p.box.setFromObject(p.mesh).expandByScalar(-0.05);
        p.rest = true;
      }
    }

    this._propsAgainstEachOther(dt);
  }

  /** Push a prop out of the static world it has run into, and bounce it back. */
  _bounceProp(p) {
    const pos = p.mesh.position;
    const r = p.radius;

    const bounce = (nx, nz, push) => {
      pos.x += nx * push;
      pos.z += nz * push;
      const along = p.vel.x * nx + p.vel.z * nz;
      if (along < 0) {
        p.vel.x -= (1 + SETTINGS.propRestitution) * along * nx;
        p.vel.z -= (1 + SETTINGS.propRestitution) * along * nz;
      }
    };

    for (const c of this.cylinders) {
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const min = c.r + r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      bounce(dx / d, dz / d, min - d);
    }

    for (const box of this.boxes) {
      if (box === p.box) continue;
      const cx = THREE.MathUtils.clamp(pos.x, box.min.x, box.max.x);
      const cz = THREE.MathUtils.clamp(pos.z, box.min.z, box.max.z);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      // Only the props that overlap vertically shove each other about.
      if (p.baseY > box.max.y + r || p.baseY + r * 2 < box.min.y) continue;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        bounce(dx / d, dz / d, r - d);
      } else {
        bounce(1, 0, r);
      }
    }
  }

  /**
   * Prop against prop: a crate hurled into a car should shove the car. Only the
   * movers are tested, so a settled clearing costs nothing, and the impulse is
   * split by mass so the heavy end wins.
   */
  _propsAgainstEachOther(dt) {
    const props = this.props;
    for (let i = 0; i < props.length; i++) {
      const a = props[i];
      if (a.rest) continue;
      for (let j = 0; j < props.length; j++) {
        if (i === j) continue;
        const b = props[j];
        if (Math.abs(a.baseY - b.baseY) > a.radius + b.radius) continue;
        const dx = a.mesh.position.x - b.mesh.position.x;
        const dz = a.mesh.position.z - b.mesh.position.z;
        const min = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-6) continue;

        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const overlap = min - d;
        const total = a.mass + b.mass;
        // Separate them, then trade the closing speed along the normal.
        a.mesh.position.x += nx * overlap * (b.mass / total);
        a.mesh.position.z += nz * overlap * (b.mass / total);
        b.mesh.position.x -= nx * overlap * (a.mass / total);
        b.mesh.position.z -= nz * overlap * (a.mass / total);

        const closing = (a.vel.x - b.vel.x) * nx + (a.vel.z - b.vel.z) * nz;
        if (closing < 0) {
          const push = -closing * (1 + SETTINGS.propRestitution * 0.6);
          a.vel.x += nx * push * (b.mass / total);
          a.vel.z += nz * push * (b.mass / total);
          b.vel.x -= nx * push * (a.mass / total);
          b.vel.z -= nz * push * (a.mass / total);
        }
        if (b.rest) {
          b.rest = false;
          b.box.setFromObject(b.mesh).expandByScalar(-0.05);
        }
      }
    }
  }
}

function buildTrees(world, scene) {
  const rand = world.rand;
  const count = SETTINGS.treeCount;
  const limit = SETTINGS.worldSize / 2;

  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.5, 5.6, 6);
  trunkGeo.translate(0, 2.8, 0);
  const coneGeo = new THREE.ConeGeometry(2.5, 5.4, 7);
  coneGeo.translate(0, 5.4, 0);
  const topGeo = new THREE.ConeGeometry(1.7, 3.8, 7);
  topGeo.translate(0, 8.4, 0);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3628, roughness: 1 });
  const coneMat = new THREE.MeshStandardMaterial({ color: 0x2f4a2a, roughness: 1 });
  const topMat = new THREE.MeshStandardMaterial({ color: 0x3a5c33, roughness: 1 });

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const cones = new THREE.InstancedMesh(coneGeo, coneMat, count);
  const tops = new THREE.InstancedMesh(topGeo, topMat, count);
  trunks.receiveShadow = true;
  cones.receiveShadow = true;
  tops.receiveShadow = true;

  const dummy = new THREE.Object3D();
  let placed = 0;
  let guard = 0;
  while (placed < count && guard++ < count * 12) {
    const x = (rand() * 2 - 1) * limit;
    const z = (rand() * 2 - 1) * limit;
    const distFromCentre = Math.hypot(x, z);
    // Keep a playable clearing but let a few trees intrude at the edges.
    if (distFromCentre < SETTINGS.clearingRadius) continue;
    let clash = false;
    for (let i = 0; i < placed; i++) {
      const m = trunks.instanceMatrix.array;
      const px = m[i * 16 + 12];
      const pz = m[i * 16 + 14];
      if (Math.hypot(px - x, pz - z) < 3.4) { clash = true; break; }
    }
    if (clash) continue;

    const scale = 0.75 + rand() * 0.85;
    dummy.position.set(x, 0, z);
    dummy.rotation.y = rand() * Math.PI;
    dummy.scale.set(scale, scale * (0.85 + rand() * 0.4), scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(placed, dummy.matrix);
    cones.setMatrixAt(placed, dummy.matrix);
    tops.setMatrixAt(placed, dummy.matrix);

    world.addCylinder(x, z, 0.42 * scale, 9 * scale);
    world.mixLayout(x, z);
    placed++;
  }
  trunks.count = cones.count = tops.count = placed;
  trunks.instanceMatrix.needsUpdate = true;
  cones.instanceMatrix.needsUpdate = true;
  tops.instanceMatrix.needsUpdate = true;
  scene.add(trunks, cones, tops);
}

function buildCover(world, scene) {
  const rand = world.rand;
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x5c5344, roughness: 0.95 });
  const barrierMat = new THREE.MeshStandardMaterial({ color: 0x7d7f76, roughness: 0.95 });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b6b66, roughness: 1, flatShading: true });

  const crateGeo = new THREE.BoxGeometry(1.5, 1.2, 1.5);
  const barrierGeo = new THREE.BoxGeometry(2.6, 1.1, 0.6);
  const rockGeo = new THREE.DodecahedronGeometry(1.1, 0);

  const spawnRing = (minR, maxR) => {
    const angle = rand() * Math.PI * 2;
    const r = minR + rand() * (maxR - minR);
    return new THREE.Vector3(Math.cos(angle) * r, 0, Math.sin(angle) * r);
  };

  // Crates, barriers and rocks are light enough for the boot: their mass is what
  // a kick is divided by, so a crate flies and a rock barely hops.
  const place = (geo, mat, y, prop) => {
    const p = spawnRing(6, SETTINGS.clearingRadius + 10);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.x, y, p.z);
    mesh.rotation.y = rand() * Math.PI;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh).expandByScalar(-0.05);
    world.addBox(box);
    world.addProp(mesh, box, prop);
    world.mixLayout(p.x, p.z);
    return mesh;
  };

  for (let i = 0; i < 10; i++) place(crateGeo, crateMat, 0.6, { mass: 1, radius: 1.05, kind: 'crate' });
  for (let i = 0; i < 8; i++) place(barrierGeo, barrierMat, 0.55, { mass: 1.5, radius: 1.4, kind: 'barrier' });
  for (let i = 0; i < 7; i++) place(rockGeo, rockMat, 0.55, { mass: 2.6, radius: 1.1, kind: 'rock' });
}

async function buildVehicles(world, scene) {
  try {
    const gltf = await gltfLoader.loadAsync(`${ASSET_BASE}${VEHICLE.model}`);
    const proto = gltf.scene;
    proto.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(proto);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;
    const factor = VEHICLE.length / longest;
    proto.scale.setScalar(factor);
    proto.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(proto);
    proto.position.y -= box.min.y;

    const rand = world.rand;
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + rand() * 0.6;
      const radius = 11 + rand() * 9;
      const car = proto.clone(true);
      car.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      car.rotation.y = rand() * Math.PI * 2;
      car.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      scene.add(car);
      car.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(car);
      world.addBox(box);
      // The heaviest thing on the field, and the best thing to kick: it shifts
      // and tumbles rather than flying, taking whatever it was covering with it.
      world.addProp(car, box, { mass: 4.5, radius: 2.3, kind: 'car' });
      world.mixLayout(car.position.x, car.position.z);
    }
    return true;
  } catch (err) {
    console.warn('[world] vehicle cover unavailable, using crates only', err);
    return false;
  }
}

/**
 * The supplied forest/mountain scene is a domed photogrammetry backdrop: 3687
 * tiny meshes but only ~19k triangles and 10 materials. Merging by material
 * collapses it to a handful of draw calls, then it is scaled and dropped in as
 * the environment the officer stands inside. It carries no collision, so the
 * procedural layer still owns cover and movement limits.
 */
async function buildLandscape(scene, renderer) {
  if (!LANDSCAPE.enabled) return false;
  try {
    const gltf = await gltfLoader.loadAsync(`${ASSET_BASE}${LANDSCAPE.model}`);
    const source = gltf.scene;
    source.updateMatrixWorld(true);

    const byMaterial = new Map();
    source.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const material = Array.isArray(o.material) ? o.material[0] : o.material;
      const key = material ? material.uuid : 'none';
      if (!byMaterial.has(key)) byMaterial.set(key, { material, geometries: [] });

      const baked = o.geometry.clone();
      baked.applyMatrix4(o.matrixWorld);
      const flat = baked.index ? baked.toNonIndexed() : baked;
      // Normalise the attribute set so the merge cannot fail on odd meshes.
      const clean = new THREE.BufferGeometry();
      const position = flat.attributes.position;
      clean.setAttribute('position', position);
      clean.setAttribute('normal', flat.attributes.normal
        || new THREE.BufferAttribute(new Float32Array(position.count * 3), 3));
      clean.setAttribute('uv', flat.attributes.uv
        || new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
      byMaterial.get(key).geometries.push(clean);
      if (flat !== baked) baked.dispose();
    });

    const group = new THREE.Group();
    for (const { material, geometries } of byMaterial.values()) {
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
      if (!merged) { geometries.forEach((g) => g.dispose()); continue; }
      merged.computeBoundingSphere();
      // Photogrammetry textures are already lit, and the dome's interior ceiling
      // faces away from every light in the scene. Unlit fixes the black ceiling
      // and is cheaper; fog still blends it into the distance.
      const backdrop = new THREE.MeshBasicMaterial({
        map: material && material.map ? material.map : null,
        color: material && material.map ? 0xffffff : (material && material.color ? material.color.getHex() : 0x8a9a8a),
        side: THREE.DoubleSide,
        fog: true,
      });
      const mesh = new THREE.Mesh(merged, backdrop);
      // Backdrop only: it never casts or receives shadow, and never moves.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      group.add(mesh);
      if (geometries.length > 1) geometries.forEach((g) => g.dispose());
    }
    if (!group.children.length) return false;

    group.updateMatrixWorld(true);
    const initial = new THREE.Box3().setFromObject(group);
    const size = initial.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) || 1;
    group.scale.setScalar(LANDSCAPE.span / span);
    group.updateMatrixWorld(true);

    const scaled = new THREE.Box3().setFromObject(group);
    group.position.x -= (scaled.min.x + scaled.max.x) / 2;
    group.position.z -= (scaled.min.z + scaled.max.z) / 2;
    group.position.y += LANDSCAPE.floorY - scaled.min.y;
    group.updateMatrixWorld(true);

    // The asset is a closed, canopy-textured dome: standing inside it looks like
    // a cave. Its real value is as a scanned panorama, so it is rendered once
    // into a cubemap and used as the sky rather than kept as scenery.
    if (!renderer) return false;
    const probeScene = new THREE.Scene();
    probeScene.add(group);

    const target = new THREE.WebGLCubeRenderTarget(LANDSCAPE.skyboxSize, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    const cubeCamera = new THREE.CubeCamera(0.5, 4000, target);
    cubeCamera.position.set(0, LANDSCAPE.probeHeight, 0);
    cubeCamera.update(renderer, probeScene);

    target.texture.colorSpace = THREE.SRGBColorSpace;
    scene.background = target.texture;
    scene.backgroundIntensity = LANDSCAPE.skyboxIntensity;
    return true;
  } catch (err) {
    console.warn('[world] landscape environment unavailable', err);
    return false;
  }
}

/**
 * A gradient cap sitting over the scanned horizon.
 *
 * The cubemap's upper hemisphere is baked tree canopy, which reads as a low
 * ceiling. This opaque cap covers the zenith and fades to the horizon colour, so
 * only the scanned terrain band stays visible.
 */
function buildSky(scene) {
  const { radius, capAngle, horizon, zenith } = SKY;
  const phiLength = Math.PI * capAngle;
  const geometry = new THREE.SphereGeometry(radius, 32, 12, 0, Math.PI * 2, 0, phiLength);

  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const base = new THREE.Color(horizon);
  const top = new THREE.Color(zenith);
  const mixed = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const t = Math.min(1, Math.max(0, position.getY(i) / radius));
    mixed.copy(base).lerp(top, Math.pow(t, 0.75));
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  }));
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = true;
  scene.add(mesh);
  return mesh;
}

export async function createWorld(scene, renderer, { seed = SETTINGS.worldSeed } = {}) {
  scene.background = new THREE.Color(0x9db4c4);
  // Fog blends the edge of the walkable ground into the scanned horizon.
  scene.fog = new THREE.Fog(0x9db4c4, LANDSCAPE.enabled ? 45 : 40, LANDSCAPE.enabled ? 230 : 180);

  const hemi = new THREE.HemisphereLight(0xb9d3e8, 0x2e3a24, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1d4, 2.1);
  sun.position.set(40, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  const shadowSpan = 45;
  sun.shadow.camera.left = -shadowSpan;
  sun.shadow.camera.right = shadowSpan;
  sun.shadow.camera.top = shadowSpan;
  sun.shadow.camera.bottom = -shadowSpan;
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  scene.add(sun.target);

  const groundGeo = new THREE.PlaneGeometry(SETTINGS.worldSize, SETTINGS.worldSize);
  const groundMat = new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const world = new World(scene, seed);
  const hasLandscape = await buildLandscape(scene, renderer);
  const sky = hasLandscape ? buildSky(scene) : null;
  buildTrees(world, scene);
  buildCover(world, scene);
  await buildVehicles(world, scene);

  return { world, sun, ground, sky, hasLandscape };
}
