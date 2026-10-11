import * as THREE from 'three';
import { SETTINGS, waveRamp } from './config.js';
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
    this._prevPos = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    // Obstacle detour state: see the stuck watchdog in update().
    this.stuckTime = 0;
    this.detourTimer = 0;
    this.detourHeading = null;
    this._seekYaw = 0;
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
    const assaulting = Boolean(ctx.assaults && ctx.assaults.includes(this));
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
    } else if (ctx.push) {
      // The line has broken cover: close the distance at a jog, still letting
      // the assault holder do the shooting.
      this.coverPoint = null;
      move.copy(dir);
      this.moving = true;
      gaitScale = 1.05;
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

    // Steering is a straight line with only a slide along whatever it bumps
    // into, so an attacker whose target sits on the far side of a crate presses
    // into the same face indefinitely and the wave can never end. Once the
    // watchdog below says it has stopped making progress, walk the heading its
    // whiskers picked instead of straight ahead.
    this._seekYaw = move.lengthSq() > 1e-6 ? Math.atan2(move.x, move.z) : Math.atan2(dir.x, dir.z);
    if (this.detourTimer > 0) {
      this.detourTimer -= dt;
      this._side.set(Math.sin(this.detourHeading), 0, Math.cos(this.detourHeading));
      move.addScaledVector(this._side, 1.7);
    }

    if (move.lengthSq() > 1e-6) move.normalize();
    // The whole line moves a little quicker as the game escalates.
    const gait = SETTINGS.enemyWalkSpeed * gaitScale * (this.wounded ? 0.72 : 1) * (ctx.speedScale || 1);
    this._prevPos.copy(this.object.position);
    this.object.position.addScaledVector(move, gait * dt);
    this.object.position.x += this.knock.x * dt;
    this.object.position.z += this.knock.z * dt;
    this.knock.multiplyScalar(Math.max(0, 1 - 3.2 * dt));
    this.world.resolveCircle(this.object.position, 0.5);

    // Progress watchdog for the detour above.
    const travelled = Math.hypot(
      this.object.position.x - this._prevPos.x,
      this.object.position.z - this._prevPos.z,
    );
    if (this.detourTimer <= 0 && move.lengthSq() > 1e-6 && travelled < gait * dt * 0.4) {
      this.stuckTime += dt;
      if (this.stuckTime > 1.2) {
        this.detourHeading = this.pickDetourHeading(this._seekYaw);
        this.detourTimer = 1.6 + Math.random() * 1.2;
        this.stuckTime = 0;
      }
    } else {
      this.stuckTime = 0;
    }

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
   * A heading to walk around whatever the seek is pressed against.
   *
   * Whiskers are cast to either side of the straight line and scored by how far
   * they run clear, so the attacker edges along the obstacle and rounds its
   * corner instead of leaning on the same face forever. The heading that was
   * already working is favoured, which stops it ping-ponging between the two
   * ends of a wide crate. Probes are cast low: movement collides in the XZ
   * plane whatever an obstacle's height, so a chest-high ray would sail over
   * the very crates that are blocking the way.
   */
  pickDetourHeading(baseYaw) {
    const origin = this.object.position;
    let best = baseYaw;
    let bestScore = -Infinity;
    for (const deg of [0, 25, -25, 50, -50, 80, -80, 110, -110, 140, -140]) {
      const yaw = baseYaw + (deg * Math.PI) / 180;
      this._probe.set(Math.sin(yaw), 0, Math.cos(yaw));
      const hit = this.world.raycast(origin, this._probe, 3.2);
      const clear = hit ? hit.t : 3.2;
      const reusesLast = this.detourHeading !== null
        && Math.cos(yaw - this.detourHeading) > 0.9 ? 1.1 : 0;
      const score = clear + reusesLast - Math.abs(deg) * 0.014;
      if (score > bestScore) {
        bestScore = score;
        best = yaw;
      }
    }
    return best;
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
    const ramp = ctx.ramp || { coverPreferredRange: SETTINGS.coverSearchRadius * 0.7, coverMinRange: 9 };
    const wantsNewSpot = !this.coverPoint
      || (this.coverTimer <= 0 && dist > ramp.coverPreferredRange);
    if (wantsNewSpot) {
      this.coverPoint = world.findCover(this.object.position, player.position, {
        maxDistance: SETTINGS.coverSearchRadius,
        preferred: ramp.coverPreferredRange,
        minRange: ramp.coverMinRange,
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
    } else if (dist > ramp.coverPreferredRange) {
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
    // Escalation for the current wave; every pacing value below reads from it.
    this.ramp = waveRamp(1);
    this.spawnInterval = this.ramp.spawnInterval;
    // The attackers currently pressing the attack (one early on, a pair later).
    // Everyone else holds cover, so the fight stays a series of duels rather
    // than a scrum.
    this.assaults = [];
    this.lastAssault = null;
    this.assaultTime = 0;
    this.assaultCooldown = SETTINGS.firstAssaultDelay;
    // Cover-breaking state: see updateFlush(). `flushTune` is a live debug
    // multiplier on the lull so the charge timing can be tuned in play.
    this.flushing = false;
    this.sinceElimination = 0;
    this.flushTune = 1;
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
    // Sized for a cover fight, where every attacker has to be closed down and
    // kicked rather than mown down from a distance.
    const count = Math.min(18, Math.round(4 + waveNumber * 1.4));
    // Escalate: later waves hide less, press longer, come on faster and send a
    // second attacker out at the same time.
    this.ramp = waveRamp(waveNumber);
    this.spawnInterval = this.ramp.spawnInterval;
    this.assaults = [];
    this.flushing = false;
    this.flushAnnounced = false;
    this.lastStandAnnounced = false;
    // A fresh wave starts with the clock at zero: they hold cover while the
    // player is making progress, then charge if the fight stalls.
    this.sinceElimination = 0;
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

    if (ctx.player) {
      this.updateAssault(dt, ctx.player);
      this.updateFlush(dt, ctx.player, ctx.onFlush);
    }

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      enemy.update(dt, {
        ...ctx,
        enemies: this.enemies,
        assaults: this.assaults,
        push: this.flushing,
        ramp: this.ramp,
        speedScale: this.ramp.speedScale,
      });
      if (enemy.removeMe) {
        this.scene.remove(enemy.object);
        enemy.anim.mixer.stopAllAction();
        this.enemies.splice(i, 1);
      }
    }
  }

  /**
   * Hand the assault to `ramp.assaultSlots` attackers at a time — one early in
   * the game, a pair from `RAMP.secondAssaultWave` on. When they are routed,
   * downed or their turn runs out they fall back to cover and the next take
   * over after a breather that shortens as the game goes on.
   */
  updateAssault(dt, player) {
    const had = this.assaults.length;
    this.assaults = this.assaults.filter((e) => !e.dead && !e.routed && !e.removeMe);
    // Losing one mid-press (usually to the boot) costs a short beat, not a full
    // turn: the pressure should not evaporate when the player lands a kick.
    if (had > 0 && this.assaults.length === 0) {
      this.assaultCooldown = this.ramp.assaultGap * 0.6;
    }

    if (this.assaults.length) {
      this.assaultTime -= dt;
      if (this.assaultTime > 0) return;
      this.lastAssault = this.assaults[this.assaults.length - 1];
      this.assaults = [];
      this.assaultCooldown = this.ramp.assaultGap;
      return;
    }

    this.assaultCooldown = Math.max(0, this.assaultCooldown - dt);
    if (this.assaultCooldown > 0) return;
    const next = this.pickAssault(player, this.ramp.assaultSlots);
    if (!next.length) return;
    this.assaults = next;
    this.assaultTime = this.ramp.assaultDurationMin
      + Math.random() * (this.ramp.assaultDurationMax - this.ramp.assaultDurationMin);
  }

  /**
   * Decide whether the hidden line should break cover. Hiding is only worth
   * anything while the fight is moving: if nothing has been eliminated for
   * `flushAfter` seconds, or only a couple of attackers are left, they all come
   * at once.
   */
  updateFlush(dt, player, onFlush) {
    this.sinceElimination += dt;
    // Count the whole wave, not just who has stepped out so far: attackers spawn
    // in on a stagger, so the first seconds of every wave look like three men
    // left and would trigger a last stand before the line has even formed.
    const remaining = this.aliveCount + this.queue.length;
    const lastStand = this.aliveCount > 0 && remaining <= SETTINGS.flushLastStandCount;
    const wasFlushing = this.flushing;
    // They hold cover while the player is making progress; the moment the fight
    // stalls they all come at once. Any kill buys a fresh window of hiding.
    this.flushing = this.aliveCount > 0
      && (lastStand || this.sinceElimination >= this.ramp.flushAfter * (this.flushTune || 1));
    if (this.flushing && !wasFlushing) {
      // Announce the first charge of a wave and the last stand, once each.
      // Repeating the banner every time they break cover again is just noise.
      const firstCharge = !this.flushAnnounced;
      const firstLastStand = lastStand && !this.lastStandAnnounced;
      if (firstCharge) this.flushAnnounced = true;
      if (firstLastStand) this.lastStandAnnounced = true;
      if (onFlush) onFlush(lastStand, firstCharge || firstLastStand);
    }
  }

  /** Called after every elimination so the attackers get a window of cover again. */
  notifyEliminated() {
    this.sinceElimination = 0;
  }

  /**
   * The closest attackers, preferring anyone other than the last one to step
   * out so the crowd takes turns instead of the same attacker monopolising the
   * fight. Returns up to `slots` of them.
   */
  pickAssault(player, slots = 1) {
    const dist = (e) => e.position.distanceTo(player.position);
    const pool = this.enemies.filter((e) => !e.dead && !e.routed && !e.removeMe && !e.bleeding);
    pool.sort((a, b) => dist(a) - dist(b));
    const chosen = pool.filter((e) => e !== this.lastAssault).slice(0, slots);
    for (const e of pool) {
      if (chosen.length >= slots) break;
      if (!chosen.includes(e)) chosen.push(e);
    }
    return chosen;
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
    this.assaults = [];
    this.lastAssault = null;
    this.assaultTime = 0;
    this.assaultCooldown = SETTINGS.firstAssaultDelay;
    this.flushing = false;
    this.sinceElimination = 0;
  }
}
