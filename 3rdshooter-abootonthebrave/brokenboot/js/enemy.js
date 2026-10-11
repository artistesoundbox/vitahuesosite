import * as THREE from 'three';
import { SETTINGS } from './config.js';
import { AnimController } from './assets.js';
import { dampAngle } from './mathx.js';

let nextId = 1;

export class Enemy {
  constructor(template, spawn, world, options = {}) {
    this.id = nextId++;
    this.object = new THREE.Group();
    this.model = template.instantiate();
    this.object.add(this.model);
    this.anim = new AnimController(this.model, template.clips);
    this.world = world;

    this.object.position.copy(spawn);
    this.elite = Boolean(options.elite);
    this.maxHealth = SETTINGS.enemyHealth * (this.elite ? 1.85 : 1);
    this.health = this.maxHealth;
    this.fireInterval = SETTINGS.enemyFireBase * (this.elite ? 0.62 : 1);
    if (this.elite) this.object.scale.setScalar(1.08);

    // Most attackers hold a firing line; a third press in close. The aggressive
    // ones give the boot something to do and stop an ammo-dry player stalling out.
    this.aggressive = Math.random() < 0.38;
    this.preferredRange = this.aggressive ? 3.4 : 9 + Math.random() * 5;
    // Cover work: where this attacker is heading to hide, and when to re-pick.
    this.coverPoint = null;
    this.coverTimer = 0;

    this.dead = false;
    this.deathTimer = 0;
    this.removeMe = false;
    // Gunfire only ever wounds to start with. Attacker health floors out at
    // `bulletMinHealth`; the boot sends them running outright, and it is the
    // boot that earns tiers. Keep shooting a floored attacker and the bleed-out
    // timer kills them slowly.
    this.wounded = false;
    this.bleeding = false;
    this.bleedTimer = 0;
    this.routed = false;
    this.routedTimer = 0;
    this.fireTimer = 0.7 + Math.random() * 1.4;
    this.strafeTimer = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.knock = new THREE.Vector3();
    this.yaw = 0;
    this.moving = false;
    this.droppedLoot = false;

    this._toPlayer = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._sep = new THREE.Vector3();
  }

  get position() { return this.object.position; }
  get headPosition() {
    return new THREE.Vector3(this.object.position.x, this.object.position.y + 1.55, this.object.position.z);
  }

  /**
   * Gunfire wounds, and the wound can finish them — but slowly. Health floors
   * at `bulletMinHealth` and extra hits then feed a bleed-out timer instead of
   * killing outright, so a bullet downing always takes sustained fire. The boot
   * remains the fast, one-hit way out.
   * Returns true when this hit is the one that puts them down.
   */
  takeDamage(amount) {
    if (this.dead || this.routed) return false;
    this.health = Math.max(SETTINGS.bulletMinHealth, this.health - amount);
    if (this.health <= this.maxHealth * 0.65) this.wounded = true;
    if (this.health <= SETTINGS.bulletMinHealth) {
      if (!this.bleeding) {
        this.bleeding = true;
        this.bleedTimer = SETTINGS.bleedoutTime * (this.elite ? SETTINGS.bleedoutEliteScale : 1);
      } else {
        this.bleedTimer -= SETTINGS.bleedoutHitPush;
      }
      if (this.bleedTimer <= 0) return this.down();
    }
    return false;
  }

  /** Bullets finally take them down: a slow collapse, not a booting. */
  down() {
    if (this.dead) return false;
    this.dead = true;
    this.deathTimer = 0;
    this.bleeding = false;
    return true;
  }

  /** The boot: send them screaming into the trees. This is the only removal. */
  rout(direction, force) {
    if (this.dead || this.routed) return false;
    this.routed = true;
    this.routedTimer = 0;
    this.knock.addScaledVector(direction, force);
    return true;
  }

  update(dt, ctx) {
    const { player, enemies, onFire } = ctx;

    if (this.dead) {
      this.deathTimer += dt;
      const tip = Math.min(Math.PI / 2, this.deathTimer * 3.6);
      this.model.rotation.x = -tip;
      if (this.deathTimer > 2.2) {
        this.object.position.y -= dt * 1.4;
      }
      if (this.deathTimer > 3.8) this.removeMe = true;
      this.anim.update(dt);
      return;
    }

    // Routed attackers run for the trees and leave the fight entirely.
    if (this.routed) {
      this.routedTimer += dt;
      const away = this._toPlayer.subVectors(this.object.position, player.position);
      away.y = 0;
      const distance = away.length() || 1e-3;
      away.divideScalar(distance);
      this.object.position.addScaledVector(away, SETTINGS.routedSpeed * dt);
      this.object.position.x += this.knock.x * dt;
      this.object.position.z += this.knock.z * dt;
      this.knock.multiplyScalar(Math.max(0, 1 - 3.2 * dt));
      this.world.resolveCircle(this.object.position, 0.5);
      this.yaw = dampAngle(this.yaw, Math.atan2(away.x, away.z), 9, dt);
      this.object.rotation.y = this.yaw;
      if (this.anim.has('walk')) this.anim.play('walk', { timeScale: 1.6 });
      this.anim.update(dt);
      if (this.routedTimer > SETTINGS.routedDuration || distance > 78) this.removeMe = true;
      return;
    }

    // Bleeding out is slow: it ticks down on its own and finishes them long
    // after the shooting stops, so gunfire grinds attackers down rather than
    // dropping them on the spot.
    if (this.bleeding) {
      this.bleedTimer -= dt;
      if (this.bleedTimer <= 0 && this.down()) {
        if (ctx.onDown) ctx.onDown(this);
        return;
      }
    }

    const toPlayer = this._toPlayer.subVectors(player.position, this.object.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    const dir = dist > 1e-4 ? toPlayer.clone().divideScalar(dist) : new THREE.Vector3(0, 0, 1);

    const move = this._move.set(0, 0, 0);
    const assaulting = ctx.assault === this;
    let crouch = false;
    let gaitScale = 1;
    let mayFire = false;

    if (assaulting) {
      // This attacker's turn: press in and hold a firing line.
      this.coverPoint = null;
      this.coverTimer = 0;
      mayFire = true;
      if (dist > SETTINGS.enemyEngageRange) {
        move.copy(dir);
        this.moving = true;
      } else {
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeDir *= -1;
          this.strafeTimer = 1.4 + Math.random() * 2.2;
        }
        const closing = dist - this.preferredRange;
        if (closing > 1.2) move.addScaledVector(dir, 1);
        else if (closing < -1.2) move.addScaledVector(dir, -1);
        this._side.set(dir.z, 0, -dir.x).multiplyScalar(this.strafeDir * 0.85);
        move.add(this._side);
        this.moving = true;
      }
    } else {
      // Everyone else fights from cover, crouched and hard to hit.
      const hold = this.updateCover(dt, ctx, { dist, dir, move });
      crouch = hold.crouch;
      gaitScale = hold.gaitScale;
      mayFire = hold.mayFire;
    }

    for (const other of enemies) {
      if (other === this || other.dead) continue;
      const dx = this.object.position.x - other.object.position.x;
      const dz = this.object.position.z - other.object.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 4 && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        this._sep.set(dx / d, 0, dz / d).multiplyScalar((2 - d) * 0.9);
        move.add(this._sep);
      }
    }

    if (move.lengthSq() > 1e-6) move.normalize();
    const gait = SETTINGS.enemyWalkSpeed * gaitScale * (this.wounded ? 0.72 : 1);
    this.object.position.addScaledVector(move, gait * dt);
    this.object.position.x += this.knock.x * dt;
    this.object.position.z += this.knock.z * dt;
    this.knock.multiplyScalar(Math.max(0, 1 - 3.2 * dt));
    this.world.resolveCircle(this.object.position, 0.5);

    this.yaw = dampAngle(this.yaw, Math.atan2(dir.x, dir.z), 7, dt);
    this.object.rotation.y = this.yaw;

    this.fireTimer -= dt;
    if (mayFire && this.fireTimer <= 0 && dist < SETTINGS.enemyMaxRange) {
      const from = this.headPosition;
      const to = player.headPosition;
      if (this.world.hasLineOfSight(from, to)) {
        // Cover shooters fire far less often, and far less accurately.
        const slower = assaulting ? 1 : 2.6;
        this.fireTimer = (this.fireInterval * (this.wounded ? 1.55 : 1) * slower) + Math.random() * 0.8;
        onFire(this, dist, this.wounded, !assaulting);
      } else {
        this.fireTimer = 0.35;
      }
    }

    if (crouch && this.anim.has('crouch')) {
      this.anim.play('crouch');
    } else if (this.anim.has('walk') && this.moving) {
      this.anim.play('walk', { timeScale: dist > SETTINGS.enemyEngageRange ? 1.0 : 0.72 });
    } else if (this.anim.has('aim')) {
      this.anim.play('aim');
    } else {
      this.anim.play('idle');
    }
    this.anim.update(dt);
  }

  /**
   * Hold position behind cover while another attacker makes the assault. The
   * attacker bounds to a spot on the far side of a tree, the car or a crate,
   * ducks down there, and only risks a close-range shot if the player closes in.
   */
  updateCover(dt, ctx, { dist, dir, move }) {
    const { player } = ctx;
    const world = this.world;
    this.coverTimer -= dt;

    // Only look for a new spot while still working forward. Once the player is
    // inside fighting range the attacker holds where it is and cowers, so the
    // boot can actually reach it instead of chasing it from tree to tree.
    const wantsNewSpot = !this.coverPoint
      || (this.coverTimer <= 0 && dist > SETTINGS.coverPreferredRange);
    if (wantsNewSpot) {
      this.coverPoint = world.findCover(this.object.position, player.position, {
        maxDistance: SETTINGS.coverSearchRadius,
        preferred: SETTINGS.coverPreferredRange,
        minRange: SETTINGS.coverMinRange,
      });
      this.coverTimer = SETTINGS.coverHoldMin
        + Math.random() * (SETTINGS.coverHoldMax - SETTINGS.coverHoldMin);
    }
    const reach = this.coverPoint
      ? this.object.position.distanceTo(this.coverPoint)
      : Infinity;

    let crouch = true;
    let gaitScale = 0.82;
    if (this.coverPoint && reach > 1.2) {
      move.subVectors(this.coverPoint, this.object.position);
      move.y = 0;
      if (move.lengthSq() > 1e-6) move.normalize();
      this.moving = true;
      crouch = false;
    } else if (this.coverPoint) {
      // Settled behind cover: stay down and hold.
      this.moving = false;
      gaitScale = 0.5;
    } else if (dist > SETTINGS.coverPreferredRange) {
      // No cover within reach: keep coming, carefully, rather than stand about.
      move.copy(dir);
      this.moving = true;
      gaitScale = 0.6;
    } else {
      // No cover and already at fighting range: hold, down and ready.
      this.moving = false;
      gaitScale = 0.5;
    }

    const mayFire = this.coverPoint !== null
      && !this.moving
      && dist < SETTINGS.coverFireRange
      && world.hasLineOfSight(this.headPosition, player.headPosition);
    return { crouch, gaitScale, mayFire };
  }
}

export class EnemyManager {
  constructor(scene, template, world) {
    this.scene = scene;
    this.template = template;
    this.world = world;
    this.enemies = [];
    this.queue = [];
    this.spawnTimer = 0;
    this.spawnInterval = SETTINGS.spawnInterval;
    // The single attacker currently pressing the attack. Everyone else holds
    // cover, so the fight stays a series of duels instead of a scrum.
    this.assault = null;
    this.lastAssault = null;
    this.assaultTime = 0;
    this.assaultCooldown = SETTINGS.firstAssaultDelay;
  }

  /** Attackers still in the fight. Routed ones are already out of it. */
  get aliveCount() {
    let n = 0;
    for (const e of this.enemies) if (!e.dead && !e.routed) n++;
    return n;
  }

  /** Attackers currently running for the trees. */
  get routedCount() {
    let n = 0;
    for (const e of this.enemies) if (e.routed) n++;
    return n;
  }

  get pendingCount() { return this.queue.length; }

  /** Queue a wave. Enemies trickle in so the fight stays readable. */
  queueWave(waveNumber, center) {
    const count = Math.min(26, 4 + waveNumber * 2);
    const elites = waveNumber >= 5 ? Math.floor(waveNumber / 4) : 0;
    for (let i = 0; i < count; i++) {
      const elite = i < elites;
      this.queue.push({
        spawn: this.world.findSpawn(center, SETTINGS.spawnMinRadius, SETTINGS.spawnMaxRadius),
        elite,
      });
    }
  }

  update(dt, ctx) {
    if (this.queue.length) {
      this.spawnTimer -= dt;
      const cap = this.queue.some((q) => q.elite) ? SETTINGS.maxAliveEnemies : SETTINGS.maxAliveEnemies;
      if (this.spawnTimer <= 0 && this.aliveCount < cap) {
        const next = this.queue.shift();
        this.spawnTimer = this.spawnInterval;
        const enemy = new Enemy(this.template, next.spawn, this.world, { elite: next.elite });
        this.scene.add(enemy.object);
        this.enemies.push(enemy);
        if (ctx.onSpawn) ctx.onSpawn(enemy);
      }
    }

    if (ctx.player) this.updateAssault(dt, ctx.player);

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      enemy.update(dt, { ...ctx, enemies: this.enemies, assault: this.assault });
      if (enemy.removeMe) {
        this.scene.remove(enemy.object);
        enemy.anim.mixer.stopAllAction();
        this.enemies.splice(i, 1);
      }
    }
  }

  /**
   * Hand the assault to one attacker at a time. When that attacker is routed,
   * downed or its turn simply runs out, it falls back to cover and the next one
   * steps out after a short breather.
   */
  updateAssault(dt, player) {
    const holder = this.assault;
    if (holder) {
      const gone = holder.dead || holder.routed || holder.removeMe;
      if (gone) {
        this.assault = null;
        this.assaultCooldown = SETTINGS.assaultGap;
      } else {
        this.assaultTime -= dt;
        if (this.assaultTime > 0) return;
        this.assault = null;
        this.assaultCooldown = SETTINGS.assaultGap;
      }
    }

    this.assaultCooldown = Math.max(0, this.assaultCooldown - dt);
    if (this.assaultCooldown > 0) return;
    const next = this.pickAssault(player);
    if (!next) return;
    this.assault = next;
    this.lastAssault = next;
    this.assaultTime = SETTINGS.assaultDurationMin
      + Math.random() * (SETTINGS.assaultDurationMax - SETTINGS.assaultDurationMin);
  }

  /**
   * The closest fit attacker, preferring anyone other than the last one to step
   * out so the crowd takes turns instead of one attacker monopolising the fight.
   */
  pickAssault(player) {
    let best = null;
    let bestD = Infinity;
    let alt = null;
    let altD = Infinity;
    for (const e of this.enemies) {
      if (e.dead || e.routed || e.removeMe || e.bleeding) continue;
      const d = e.position.distanceTo(player.position);
      if (d < bestD) { bestD = d; best = e; }
      if (e !== this.lastAssault && d < altD) { altD = d; alt = e; }
    }
    return alt || best;
  }

  /** Nearest living enemy to a point, used for melee and effects. */
  nearest(point, maxDistance = Infinity) {
    let best = null;
    let bestD = maxDistance;
    for (const e of this.enemies) {
      if (e.dead || e.routed) continue;
      const d = e.position.distanceTo(point);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  clear() {
    for (const e of this.enemies) {
      this.scene.remove(e.object);
      e.anim.mixer.stopAllAction();
    }
    this.enemies.length = 0;
    this.queue.length = 0;
    this.assault = null;
    this.lastAssault = null;
    this.assaultTime = 0;
    this.assaultCooldown = SETTINGS.firstAssaultDelay;
  }
}
