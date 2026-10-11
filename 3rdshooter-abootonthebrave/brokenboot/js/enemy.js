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
    this.preferredRange = this.aggressive ? 2.2 : 9 + Math.random() * 5;

    this.dead = false;
    this.deathTimer = 0;
    this.removeMe = false;
    // Attackers are never shot dead: gunfire only wounds them. Only the boot
    // takes one out of the fight, and it does so by routing them.
    this.wounded = false;
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
   * Gunfire wounds but can never finish an attacker off. Health floors out, and
   * a badly hurt attacker slows down and shoots less accurately.
   */
  takeDamage(amount) {
    if (this.dead || this.routed) return;
    this.health = Math.max(SETTINGS.bulletMinHealth, this.health - amount);
    if (this.health <= this.maxHealth * 0.65) this.wounded = true;
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

    const toPlayer = this._toPlayer.subVectors(player.position, this.object.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    const dir = dist > 1e-4 ? toPlayer.clone().divideScalar(dist) : new THREE.Vector3(0, 0, 1);

    const move = this._move.set(0, 0, 0);
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
    const gait = SETTINGS.enemyWalkSpeed * (this.wounded ? 0.72 : 1);
    this.object.position.addScaledVector(move, gait * dt);
    this.object.position.x += this.knock.x * dt;
    this.object.position.z += this.knock.z * dt;
    this.knock.multiplyScalar(Math.max(0, 1 - 3.2 * dt));
    this.world.resolveCircle(this.object.position, 0.5);

    this.yaw = dampAngle(this.yaw, Math.atan2(dir.x, dir.z), 7, dt);
    this.object.rotation.y = this.yaw;

    this.fireTimer -= dt;
    if (this.fireTimer <= 0 && dist < SETTINGS.enemyMaxRange) {
      const from = this.headPosition;
      const to = player.headPosition;
      if (this.world.hasLineOfSight(from, to)) {
        this.fireTimer = (this.fireInterval * (this.wounded ? 1.55 : 1)) + Math.random() * 0.8;
        onFire(this, dist, this.wounded);
      } else {
        this.fireTimer = 0.35;
      }
    }

    if (this.anim.has('walk') && this.moving) {
      this.anim.play('walk', { timeScale: dist > SETTINGS.enemyEngageRange ? 1.0 : 0.72 });
    } else if (this.anim.has('aim')) {
      this.anim.play('aim');
    } else {
      this.anim.play('idle');
    }
    this.anim.update(dt);
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
    this.spawnInterval = 0.75;
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

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      enemy.update(dt, { ...ctx, enemies: this.enemies });
      if (enemy.removeMe) {
        this.scene.remove(enemy.object);
        enemy.anim.mixer.stopAllAction();
        this.enemies.splice(i, 1);
      }
    }
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
  }
}
