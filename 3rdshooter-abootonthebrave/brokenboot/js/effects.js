import * as THREE from 'three';

const TRACER_LIFE = 0.09;
const FLASH_LIFE = 0.06;

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
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
    for (const p of this.particles) { p.life = 0; p.mesh.visible = false; }
    for (const p of this.pickups) this.scene.remove(p.mesh);
    this.pickups.length = 0;
    this.flash.visible = false;
    this.muzzleMesh.visible = false;
  }
}
