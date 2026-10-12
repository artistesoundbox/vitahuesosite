import * as THREE from 'three';

const TRACER_LIFE = 0.09;
const FLASH_LIFE = 0.06;

// The swish: the arc a thrown boot cuts, as one strip that follows the foot and
// fades behind it. A point is only accepted once the foot has travelled
// `SWISH_STEP`, so a slow kick does not spend its whole ribbon standing still,
// and the buffer is fixed — a kick reuses it rather than allocating.
const SWISH_SAMPLES = 14;
const SWISH_LIFE = 0.22;
const SWISH_STEP = 0.06;
const SWISH_WIDTH = 0.15;
// Per-kick shape: how fat the stroke is drawn, and how far above the foot it
// rides, so a sweep along the grass does not sink its edge into the ground.
const SWISH_SHAPES = {
  kick:  { width: 1.0, lift: 0.04 },
  sweep: { width: 1.3, lift: 0.12 },
  high:  { width: 0.7, lift: 0.04 },
  stomp: { width: 1.4, lift: 0.14 },
};

// Pickup palette: body colour, emissive glow and halo, per loot type.
const PICKUP_LOOK = {
  ammo:   { body: 0x2f4f3a, glow: 0x1b3a26, halo: 0x8ef0b0 },
  health: { body: 0x7a2b2b, glow: 0x4a1414, halo: 0xff8a7a },
  reload: { body: 0x3c4a6b, glow: 0x1e2b4a, halo: 0x8fb6ff },
  charge: { body: 0x6b5417, glow: 0x4a3a0c, halo: 0xffd24a },
  rapid:  { body: 0x5a3a6b, glow: 0x341b4a, halo: 0xd99bff },
  armor:  { body: 0x2f5a6b, glow: 0x14363a, halo: 0x8fe6ef },
};
const PARTICLE_LIFE = 0.5;
const MAX_TRACERS = 24;
const MAX_PARTICLES = 90;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.tracers = [];
    this.particles = [];
    this.pickups = [];
    this.waves = [];
    this.time = 0;
    this._pull = new THREE.Vector3();

    const tracerGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 5, 1, true);
    tracerGeo.translate(0, 0.5, 0);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffe6a8, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat.clone());
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    const particleGeo = new THREE.SphereGeometry(0.05, 4, 4);
    const particleMat = new THREE.MeshBasicMaterial({ color: 0xffca7a, transparent: true, depthWrite: false });
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const mesh = new THREE.Mesh(particleGeo, particleMat.clone());
      mesh.visible = false;
      scene.add(mesh);
      this.particles.push({ mesh, life: 0, vel: new THREE.Vector3() });
    }

    this.flash = new THREE.PointLight(0xffd08a, 0, 9, 2);
    this.flash.visible = false;
    scene.add(this.flash);
    this.flashLife = 0;

    this.muzzleGeo = new THREE.SphereGeometry(0.13, 6, 6);
    this.muzzleMat = new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    this.muzzleMesh = new THREE.Mesh(this.muzzleGeo, this.muzzleMat);
    this.muzzleMesh.visible = false;
    scene.add(this.muzzleMesh);

    // One ribbon, reused by every kick: `SWISH_SAMPLES` points, each with a left
    // and right edge, drawn as a strip that grows with the swing.
    this.swishGeo = new THREE.BufferGeometry();
    this.swishGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SWISH_SAMPLES * 2 * 3), 3));
    const swishIndex = [];
    for (let i = 0; i < SWISH_SAMPLES - 1; i++) {
      const a = i * 2;
      swishIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.swishGeo.setIndex(swishIndex);
    this.swishGeo.setDrawRange(0, 0);
    this.swishMat = new THREE.MeshBasicMaterial({
      color: 0xffe6a8, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.swishMesh = new THREE.Mesh(this.swishGeo, this.swishMat);
    this.swishMesh.visible = false;
    this.swishMesh.frustumCulled = false;
    scene.add(this.swishMesh);
    this.stroke = {
      ring: Array.from({ length: SWISH_SAMPLES }, () => new THREE.Vector3()),
      head: 0, count: 0, life: 0, width: SWISH_WIDTH, lift: 0,
      _side: new THREE.Vector3(), _a: new THREE.Vector3(), _b: new THREE.Vector3(),
      _target: new THREE.Vector3(), _step: new THREE.Vector3(),
    };
  }

  /**
   * Start a kick's arc: tinted with the tier that threw it, widened by the tier
   * so a Diamond boot leaves a fatter stroke than a Standard one, and shaped by
   * the kick being thrown.
   */
  swish(color = 0xffe6a8, tierIndex = 0, type = 'kick') {
    const shape = SWISH_SHAPES[type] || SWISH_SHAPES.kick;
    const s = this.stroke;
    s.head = 0;
    s.count = 0;
    s.life = SWISH_LIFE;
    s.lift = shape.lift;
    s.width = SWISH_WIDTH * shape.width * (1 + tierIndex * 0.06);
    this.swishMat.color.set(color);
    this.swishMat.opacity = 0;
    this.swishMesh.visible = false;
    this.swishGeo.setDrawRange(0, 0);
  }

  /** Put one point on the end of the arc, dropping the old head when full. */
  pushSwishPoint(point) {
    const s = this.stroke;
    s.ring[(s.head + s.count) % SWISH_SAMPLES].copy(point);
    if (s.count < SWISH_SAMPLES) s.count += 1;
    else s.head = (s.head + 1) % SWISH_SAMPLES;
  }

  /**
   * Walk the arc out to the foot, and hand the ribbon's edges to the eye.
   *
   * The foot is stepped to in `SWISH_STEP` increments rather than one point per
   * frame: a kick moves its foot 0.14 m between frames at its fastest, so a point
   * per frame would leave the end of the stroke behind the boot and draw the rest
   * of it visibly faceted on a slower machine. Returns whether the foot moved
   * enough to add anything.
   */
  swishSample(point, viewDir) {
    const s = this.stroke;
    if (s.life <= 0) return false;
    const target = s._target.copy(point);
    target.y += s.lift;
    let last = s.count ? s.ring[(s.head + s.count - 1) % SWISH_SAMPLES] : null;
    let added = false;
    let guard = 0;
    while ((!last || last.distanceTo(target) >= SWISH_STEP) && guard++ < SWISH_SAMPLES) {
      if (last) s._step.copy(target).sub(last).setLength(SWISH_STEP).add(last);
      this.pushSwishPoint(last ? s._step : target);
      last = s.ring[(s.head + s.count - 1) % SWISH_SAMPLES];
      added = true;
    }
    if (!added) return false;

    this.openSwish(s.ring, s.count, viewDir);
    s.life = SWISH_LIFE;
    this.swishMesh.visible = s.count >= 2;
    return true;
  }

  /** Lay the ribbon's two edges along the path and set what to draw of it. */
  openSwish(ring, count, viewDir) {
    const s = this.stroke;
    const pos = this.swishGeo.getAttribute('position');
    const view = viewDir || s._b.set(0, 0, 1);
    for (let i = 0; i < count; i++) {
      const p = ring[(s.head + i) % SWISH_SAMPLES];
      const before = ring[(s.head + Math.max(0, i - 1)) % SWISH_SAMPLES];
      const after = ring[(s.head + Math.min(count - 1, i + 1)) % SWISH_SAMPLES];
      s._a.subVectors(after, before);
      if (s._a.lengthSq() < 1e-8) s._a.set(0, 1, 0);
      s._a.normalize();
      // Width across the path and the eye, so the stroke is seen as a stroke
      // rather than as a plank turned edge-on to the camera.
      s._side.crossVectors(s._a, view);
      if (s._side.lengthSq() < 1e-6) s._side.set(1, 0, 0);
      s._side.normalize();
      // Fat at the foot, thinning back along where it has been.
      const t = count > 1 ? i / (count - 1) : 1;
      const half = s.width * (0.2 + 0.8 * t);
      pos.setXYZ(i * 2, p.x + s._side.x * half, p.y + s._side.y * half, p.z + s._side.z * half);
      pos.setXYZ(i * 2 + 1, p.x - s._side.x * half, p.y - s._side.y * half, p.z - s._side.z * half);
    }
    pos.needsUpdate = true;
    this.swishGeo.setDrawRange(0, Math.max(0, (count - 1) * 6));
  }

  /**
   * Keep the current arc armed while its kick is still swinging.
   *
   * A stroke that only lived between its own points would die in the pause
   * before a slow kick's strike — the flying high kick stands on its wind-up for
   * half a second with the leg barely moving, and the arc it is supposed to draw
   * happens after that. The fade is measured from the end of the swing instead.
   */
  holdSwish() {
    if (this.stroke.count || this.stroke.life > 0) this.stroke.life = SWISH_LIFE;
  }

  /** Stop the current arc, leaving the buffer for the next kick to reuse. */
  clearSwish() {
    this.stroke.count = 0;
    this.stroke.life = 0;
    this.swishMesh.visible = false;
    this.swishGeo.setDrawRange(0, 0);
  }

  tracer(from, to, color = 0xffe6a8) {
    const slot = this.tracers.find((t) => t.life <= 0) || this.tracers[0];
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    if (len < 0.001) return;
    slot.mesh.position.copy(from);
    slot.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    slot.mesh.scale.set(1, len, 1);
    slot.mesh.material.color.setHex(color);
    slot.mesh.material.opacity = 0.9;
    slot.mesh.visible = true;
    slot.life = TRACER_LIFE;
  }

  muzzle(position) {
    this.flash.position.copy(position);
    this.flash.intensity = 26;
    this.flash.visible = true;
    this.flashLife = FLASH_LIFE;
    this.muzzleMesh.position.copy(position);
    this.muzzleMesh.visible = true;
    this.muzzleMesh.scale.setScalar(0.8 + Math.random() * 0.6);
  }

  burst(point, count = 7, color = 0xffca7a) {
    let spawned = 0;
    for (const p of this.particles) {
      if (p.life > 0) continue;
      p.mesh.position.copy(point);
      p.mesh.material.color.setHex(color);
      p.mesh.material.opacity = 1;
      p.mesh.visible = true;
      p.vel.set(
        (Math.random() - 0.5) * 5,
        Math.random() * 3.4 + 0.6,
        (Math.random() - 0.5) * 5,
      );
      p.life = PARTICLE_LIFE * (0.6 + Math.random() * 0.7);
      if (++spawned >= count) break;
    }
  }

  spawnPickup(position, type) {
    // Each pickup type reads at a glance: body colour, and a glowing halo that
    // makes it findable in the grass.
    const look = PICKUP_LOOK[type] || PICKUP_LOOK.ammo;
    const geo = new THREE.BoxGeometry(0.5, 0.34, 0.34);
    const mat = new THREE.MeshStandardMaterial({
      color: look.body,
      emissive: look.glow,
      emissiveIntensity: 0.85,
      roughness: 0.6,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    mesh.position.y = 0.4;
    mesh.castShadow = true;
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.36, 0.03, 6, 16),
      new THREE.MeshBasicMaterial({ color: look.halo, transparent: true, opacity: 0.85 }),
    );
    halo.rotation.x = Math.PI / 2;
    halo.position.y = 0.02;
    mesh.add(halo);
    this.scene.add(mesh);
    this.pickups.push({ mesh, type, life: 26 });
  }

  /**
   * Expanding ground ring for a charged kick. It grows and brightens with the
   * boot tier, so a Diamond kick is visibly not a Standard one.
   */
  shockwave(position, tierIndex = 0, color = 0xffd08a) {
    const tint = new THREE.Color(color).getHex();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.07, 6, 40),
      new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.9 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(position.x, 0.12, position.z);
    ring.scale.setScalar(0.4);
    this.scene.add(ring);
    this.waves.push({ mesh: ring, life: 0, max: 0.55 + tierIndex * 0.06, reach: 2.6 + tierIndex * 0.75 });
  }

  update(dt, player, onPickup) {
    this.time += dt;

    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.life += dt;
      const t = w.life / w.max;
      if (t >= 1) {
        this.scene.remove(w.mesh);
        w.mesh.geometry.dispose();
        w.mesh.material.dispose();
        this.waves.splice(i, 1);
        continue;
      }
      w.mesh.scale.setScalar(0.4 + t * w.reach);
      w.mesh.material.opacity = 0.9 * (1 - t);
    }

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, (t.life / TRACER_LIFE) * 0.9);
      if (t.life <= 0) t.mesh.visible = false;
    }

    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vel.y -= 12 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.material.opacity = Math.max(0, p.life / PARTICLE_LIFE);
      if (p.life <= 0) p.mesh.visible = false;
    }

    // The swish is only ever alive during a kick and a fifth of a second after
    // it, so this is one opacity write on the frames a kick is being thrown.
    if (this.stroke.life > 0) {
      this.stroke.life -= dt;
      this.swishMat.opacity = Math.max(0, (this.stroke.life / SWISH_LIFE) * 0.75);
      if (this.stroke.life <= 0) this.clearSwish();
    }

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.intensity = Math.max(0, this.flash.intensity * 0.6);
      this.muzzleMesh.material.opacity = Math.max(0, this.flashLife / FLASH_LIFE);
      if (this.flashLife <= 0) {
        this.flash.visible = false;
        this.muzzleMesh.visible = false;
      }
    }

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.life -= dt;
      p.mesh.rotation.y += dt * 1.6;
      p.mesh.position.y = 0.4 + Math.sin(this.time * 2.4 + i) * 0.08;
      const dist = p.mesh.position.distanceTo(player.position);
      if (dist < 1.4 && player.alive) {
        if (onPickup) onPickup(p.type);
        this.scene.remove(p.mesh);
        this.pickups.splice(i, 1);
        continue;
      }
      // Loot drifts to the player from close by, so a dressing earned in a
      // firefight is not lost in the grass while they fight the next attacker.
      if (dist < 6 && player.alive) {
        const pull = (1 - dist / 6) * 3.4 * dt;
        this._pull.set(player.position.x, 0.4, player.position.z);
        p.mesh.position.lerp(this._pull, Math.min(1, pull));
      }
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }

  reset() {
    this.clearSwish();
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
    for (const p of this.particles) { p.life = 0; p.mesh.visible = false; }
    for (const p of this.pickups) this.scene.remove(p.mesh);
    this.pickups.length = 0;
    this.flash.visible = false;
    this.muzzleMesh.visible = false;
  }
}
