import * as THREE from 'three';
import { SETTINGS, BOOT_TIERS, BOOT_SOCKETS, ASSET_BASE, WEAPON, KICKS } from './config.js';
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
    this.crouching = false;
    // Boot charge: filled by routs and charge pickups. A full meter turns the
    // next kick into a charged one that sends the whole arc running.
    this.charge = 0;
    // Timed powerups, in seconds remaining.
    this.powerups = { rapid: 0, armor: 0, speed: 0 };
    this.pendingKick = null;
    // The kick that is being thrown, carried to the frame it connects on.
    this.lastKick = 'kick';
    this.onKickHit = null;
    this.onKickStart = null;
    this.onReload = null;
    this.onTierChange = null;
    this.bootModel = null;
    this.loadedBootModel = null;
    this._desired = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  get position() { return this.object.position; }
  get boot() { return BOOT_TIERS[this.bootIndex]; }
  get bootChargeReady() { return this.charge >= SETTINGS.chargeMax; }
  get speedMultiplier() {
    const powerup = this.powerups.speed > 0 ? SETTINGS.speedPowerupBonus : 0;
    const crouch = this.crouching ? SETTINGS.crouchSpeedScale : 1;
    return (1 + this.boot.speedBonus + powerup) * crouch;
  }
  get spreadMultiplier() {
    // Crouching steadies the rifle; so does a tuned target lock.
    return (this.crouching ? SETTINGS.crouchSpreadScale : 1);
  }
  get headPosition() {
    // Allocate: callers offset the result, so a shared temp would be unsafe.
    return new THREE.Vector3(this.object.position.x, this.object.position.y + 1.5, this.object.position.z);
  }

  update(dt, { input, world, cameraYaw }) {
    this.time += dt;
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    for (const key of Object.keys(this.powerups)) {
      if (this.powerups[key] > 0) this.powerups[key] = Math.max(0, this.powerups[key] - dt);
    }

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
    // Camera right is cross(forward, up). With the camera looking along +Z this
    // is (-forward.z, 0, forward.x); the opposite sign made every input source
    // strafe the wrong way.
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
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
      } else if (this.crouching && this.anim.has('crouch')) {
        this.anim.play('crouch', { timeScale: this.moving ? 1.15 : 1 });
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
    this.fireTimer = SETTINGS.fireInterval * (this.powerups.rapid > 0 ? SETTINGS.rapidFireScale : 1);
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
    this.crouching = false;
    this.velocityY = SETTINGS.jumpSpeed;
    this.grounded = false;
    return true;
  }

  /** Crouch is a toggle: easier on a controller thumb and on a phone. */
  toggleCrouch() {
    if (!this.alive) return false;
    this.crouching = !this.crouching;
    if (this.crouching) this.sprinting = false;
    return this.crouching;
  }

  addCharge(amount) {
    if (this.bootChargeReady) return false;
    this.charge = Math.min(SETTINGS.chargeMax, this.charge + amount);
    return this.bootChargeReady;
  }

  consumeCharge() {
    this.charge = 0;
  }

  grantPowerup(type, seconds) {
    if (!(type in this.powerups)) return;
    // Stacking refreshes rather than adding indefinitely.
    this.powerups[type] = Math.max(this.powerups[type], 0) + seconds;
  }

  /**
   * Which kick is available from where the officer is, right now. Standing gives
   * the equipped boot's signature kick, crouching gives the low sweep and being
   * off the ground gives the flying high kick, so all three are always reachable
   * and the boot tier decides which one the standing kick becomes.
   */
  kickType() {
    if (this.crouching) return 'sweep';
    if (!this.grounded) return 'high';
    if (this.bootIndex >= 5) return 'stomp';
    return this.bootIndex >= 2 ? 'high' : 'kick';
  }

  melee() {
    if (!this.canMelee()) return false;
    const type = this.kickType();
    const kick = KICKS[type] || KICKS.kick;
    // A clip the rig does not carry falls back to the plain kick rather than
    // costing the player their attack.
    const clip = this.anim.has(kick.clip) ? kick.clip : 'kick';
    if (!this.anim.has(clip)) return false;
    this.lastKick = type;
    this.kickCooldown = SETTINGS.kickCooldown * kick.cooldownScale;
    this.pendingKick = { t: 0.34, type };
    if (this.onKickStart) this.onKickStart(type);
    this.anim.once(clip, { timeScale: 1.2 }, () => { /* locomotion resumes next frame */ });
    return true;
  }

  takeDamage(amount) {
    if (!this.alive) return false;
    this.health -= amount * (this.powerups.armor > 0 ? SETTINGS.armorDamageScale : 1);
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

  /** Reload crate: a full magazine now, plus a little reserve. */
  instantReload(extraReserve = 0) {
    this.reloading = 0;
    this.ammo = SETTINGS.magSize;
    this.reserve += extraReserve;
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
