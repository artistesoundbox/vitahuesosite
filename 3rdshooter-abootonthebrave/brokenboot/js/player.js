import * as THREE from 'three';
import { SETTINGS, BOOT_TIERS, BOOT_SOCKETS, ASSET_BASE, WEAPON } from './config.js';
import { AnimController, findBone, attachToBone, gltfLoader } from './assets.js';
import { dampAngle, clamp } from './mathx.js';

const MODEL_YAW_OFFSET = 0; // Mixamo characters face +Z, matching atan2(x, z).

export class Player {
  constructor(template) {
    this.object = new THREE.Group();
    this.model = template.instantiate();
    this.object.add(this.model);
    this.anim = new AnimController(this.model, template.clips);

    this.velocity = new THREE.Vector3();
    this.velocityY = 0;
    this.grounded = true;
    this.health = SETTINGS.maxHealth;
    this.maxHealth = SETTINGS.maxHealth;
    this.ammo = SETTINGS.magSize;
    this.reserve = SETTINGS.reserveStart;
    this.reloading = 0;
    this.fireTimer = 0;
    this.kickCooldown = 0;
    this.bootIndex = 0;
    this.kills = 0;
    this.meleeKills = 0;
    // Boot-tier progress. A boot rout pays a full point, a bullet downing a
    // fraction, so the boot is what actually levels the boots.
    this.tierCredit = 0;
    this.yaw = 0;
    this.time = 0;
    this.lastShotAt = -99;
    this.moving = false;
    this.sprinting = false;
    this.alive = true;
    this.pendingKick = null;
    this.onKickHit = null;
    this.onReload = null;
    this.onTierChange = null;
    this.bootModel = null;
    this.loadedBootModel = null;
    this._desired = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  get position() { return this.object.position; }
  get boot() { return BOOT_TIERS[this.bootIndex]; }
  get speedMultiplier() { return 1 + this.boot.speedBonus; }
  get headPosition() {
    // Allocate: callers offset the result, so a shared temp would be unsafe.
    return new THREE.Vector3(this.object.position.x, this.object.position.y + 1.5, this.object.position.z);
  }

  update(dt, { input, world, cameraYaw }) {
    this.time += dt;
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.kickCooldown = Math.max(0, this.kickCooldown - dt);

    if (this.pendingKick) {
      this.pendingKick.t -= dt;
      if (this.pendingKick.t <= 0) {
        this.pendingKick = null;
        if (this.onKickHit) this.onKickHit();
      }
    }

    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const need = SETTINGS.magSize - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.reloading = 0;
      }
    }

    const forward = new THREE.Vector3(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const wish = new THREE.Vector3();
    wish.addScaledVector(forward, input.forward);
    wish.addScaledVector(right, input.strafe);
    this.moving = wish.lengthSq() > 0.004;
    if (this.moving) wish.normalize();
    this.sprinting = this.moving && input.sprint && !this.pendingKick;

    let speed = this.moving ? (this.sprinting ? SETTINGS.sprintSpeed : SETTINGS.walkSpeed) : 0;
    speed *= this.speedMultiplier;

    const desired = this._desired.copy(wish).multiplyScalar(speed);
    const dv = desired.sub(this.velocity);
    const maxStep = SETTINGS.accel * dt;
    if (dv.length() > maxStep) dv.setLength(maxStep);
    this.velocity.add(dv);
    if (!this.moving) {
      this.velocity.multiplyScalar(Math.max(0, 1 - SETTINGS.friction * dt));
    }

    this.object.position.x += this.velocity.x * dt;
    this.object.position.z += this.velocity.z * dt;
    const limit = SETTINGS.worldSize / 2 - 3;
    this.object.position.x = clamp(this.object.position.x, -limit, limit);
    this.object.position.z = clamp(this.object.position.z, -limit, limit);
    world.resolveCircle(this.object.position, 0.55);

    // Vertical motion. The ground plane sits at y = 0.
    this.velocityY += SETTINGS.gravity * dt;
    this.object.position.y += this.velocityY * dt;
    if (this.object.position.y <= 0) {
      this.object.position.y = 0;
      if (this.velocityY < 0) this.velocityY = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontal > 0.4) {
      this.yaw = dampAngle(this.yaw, Math.atan2(this.velocity.x, this.velocity.z), 12, dt);
    } else {
      this.yaw = dampAngle(this.yaw, cameraYaw, 9, dt);
    }
    this.object.rotation.y = this.yaw + MODEL_YAW_OFFSET;

    const sinceShot = this.time - this.lastShotAt;
    if (!this.anim.busy) {
      if (!this.grounded && this.anim.has('jump')) {
        this.anim.play('jump', { timeScale: 1 });
      } else if (this.moving) {
        this.anim.play('walk', { timeScale: this.sprinting ? 1.45 : 1.0 });
      } else if (this.reloading > 0 || sinceShot < 4) {
        this.anim.play('aim');
      } else {
        this.anim.play('idle');
      }
    }
    this.anim.update(dt);
  }

  canFire() {
    return this.alive && this.reloading <= 0 && this.fireTimer <= 0 && this.ammo > 0;
  }

  fire() {
    if (!this.canFire()) return false;
    this.ammo -= 1;
    this.fireTimer = SETTINGS.fireInterval;
    this.lastShotAt = this.time;
    if (this.ammo <= 0 && this.reserve > 0) this.beginReload();
    return true;
  }

  beginReload() {
    if (this.reloading > 0 || this.ammo >= SETTINGS.magSize || this.reserve <= 0) return false;
    this.reloading = SETTINGS.reloadTime;
    if (this.onReload) this.onReload();
    return true;
  }

  canMelee() {
    return this.alive && this.kickCooldown <= 0 && !this.pendingKick && !this.anim.busy;
  }

  jump() {
    if (!this.alive || !this.grounded || this.anim.busy) return false;
    this.velocityY = SETTINGS.jumpSpeed;
    this.grounded = false;
    return true;
  }

  melee() {
    if (!this.canMelee()) return false;
    const key = this.anim.has('kickHigh') && this.bootIndex >= 2
      ? (this.bootIndex >= 5 ? 'stomp' : 'kickHigh')
      : 'kick';
    const use = this.anim.has(key) ? key : 'kick';
    if (!this.anim.has(use)) return false;
    this.kickCooldown = SETTINGS.kickCooldown;
    this.pendingKick = { t: 0.34 };
    this.anim.once(use, { timeScale: 1.2 }, () => { /* locomotion resumes next frame */ });
    return true;
  }

  takeDamage(amount) {
    if (!this.alive) return false;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      return true;
    }
    return false;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  addAmmo(amount) {
    this.reserve += amount;
  }

  registerKill(melee = false, weight = 1) {
    this.kills += 1;
    if (melee) this.meleeKills += 1;
    this.tierCredit += weight;
    return this.refreshBootTier();
  }

  refreshBootTier() {
    let next = 0;
    for (let i = 0; i < BOOT_TIERS.length; i++) {
      if (this.tierCredit >= BOOT_TIERS[i].kills) next = i;
    }
    if (next !== this.bootIndex) {
      this.bootIndex = next;
      if (this.onTierChange) this.onTierChange(this.boot);
      this.equipBootModel();
      return true;
    }
    return false;
  }

  /** Lazily load and socket the boot model for the current tier. */
  async equipBootModel() {
    const tier = this.boot;
    if (!tier.model) return;
    if (this.loadedBootModel === tier.model) return;
    this.loadedBootModel = tier.model;
    try {
      const gltf = await gltfLoader.loadAsync(`${ASSET_BASE}${tier.model}`);
      if (this.loadedBootModel !== tier.model) return; // a newer tier won the race
      const bone = findBone(this.model, ['RightToe_End', 'RightToeBase', 'RightFoot']);
      if (!bone) { console.warn('[player] no right-foot bone for boot socket'); return; }
      if (this.bootModel && this.bootModel.parent) this.bootModel.parent.remove(this.bootModel);
      const boot = gltf.scene;
      const socket = BOOT_SOCKETS[tier.socket] || BOOT_SOCKETS.default;
      attachToBone(
        bone,
        boot,
        socket.size,
        new THREE.Vector3(0, socket.lift, 0.03),
        new THREE.Euler(-Math.PI / 2, 0, 0),
      );
      this.bootModel = boot;
    } catch (err) {
      console.warn('[player] boot model failed to load', err);
    }
  }

  /** Attach the rifle to the right hand, normalised to a plausible length. */
  async equipWeapon() {
    try {
      const gltf = await gltfLoader.loadAsync(`${ASSET_BASE}${WEAPON.model}`);
      const bone = findBone(this.model, ['RightHand', 'RightHandIndex1']);
      if (!bone) { console.warn('[player] no right-hand bone for weapon socket'); return; }
      attachToBone(bone, gltf.scene, 0.95, new THREE.Vector3());
      this.weaponModel = gltf.scene;
    } catch (err) {
      console.warn('[player] weapon failed to load', err);
    }
  }
}
