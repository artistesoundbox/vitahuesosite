import * as THREE from 'three';
import {
  SETTINGS, PLAYER_SOURCE, ENEMY_SOURCE, ASSET_BASE, ACHIEVEMENTS, BOOT_TIERS, waveRamp,
} from './config.js';
import { buildCharacter } from './assets.js';
import { createWorld } from './world.js';
import { Player } from './player.js';
import { EnemyManager } from './enemy.js';
import { Effects } from './effects.js';
import { Hud } from './hud.js';
import { GameAudio } from './audio.js';
import { InputManager } from './input.js';
import { clamp, damp } from './mathx.js';

// Approximate download weight (MB) of each asset group, for an honest loading bar.
const LOAD_WEIGHTS = {
  playerMesh: 115.5,
  playerClips: 2.7,
  enemyMesh: 11.9,
  enemyClips: 1.2,
  world: 7.1,
  weapon: 5.9,
};
const LOAD_TOTAL = Object.values(LOAD_WEIGHTS).reduce((a, b) => a + b, 0);

const MUSIC = ['A Broken Boot On The Brave1.mp3', 'A Broken Boot On The Brave 2.mp3'];
const TAGLINES = [
  'One Man. One Forest. One Broken Boot.',
  "I'm Not Trapped Here With You. You're Trapped Here With Me.",
  "The Boot Didn't Break Itself.",
  'Some Soldiers Are Brave. Others Are About To Learn Why.',
];

function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  return t >= 0 ? t : null;
}

export class Game {
  constructor() {
    this.hud = new Hud();
    this.audio = new GameAudio();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 420);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById('canvas-wrap').appendChild(this.renderer.domElement);

    this.timer = new THREE.Timer();
    this.input = { forward: 0, strafe: 0, sprint: false, firing: false };
    this.inputManager = new InputManager({
      canvas: this.renderer.domElement,
      isLocked: () => document.pointerLockElement !== null,
    });
    this.cameraYaw = 0;
    this.cameraPitch = -0.16;
    this.recoilPitch = 0;
    this.shake = 0;

    this.state = 'loading'; // loading | ready | playing | over
    this.wave = 0;
    this.intermission = 0;
    this.achievements = new Set();

    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();

    this.bindEvents();
  }

  // ---------------------------------------------------------------- loading

  async load(onProgress) {
    let done = 0;
    const report = (key, loaded, total, index, steps) => {
      const weight = key in LOAD_WEIGHTS ? LOAD_WEIGHTS[key] : 0;
      let frac;
      if (steps) frac = index / steps;
      else frac = total ? Math.min(1, loaded / total) : 1;
      const pct = ((done + frac * weight) / LOAD_TOTAL) * 100;
      onProgress(Math.min(100, pct));
    };
    const finish = (key) => { done += key in LOAD_WEIGHTS ? LOAD_WEIGHTS[key] : 0; };

    this.playerTemplate = await buildCharacter({
      meshUrl: `${ASSET_BASE}${PLAYER_SOURCE.mesh}`,
      clipUrls: Object.fromEntries(Object.entries(PLAYER_SOURCE.clips).map(([k, v]) => [k, `${ASSET_BASE}${v}`])),
      targetHeight: SETTINGS.playerHeight,
      onProgress: (loaded, total) => report('playerMesh', loaded, total),
      onStep: (key, index, steps) => report('playerClips', 0, 1, index, steps),
    });
    finish('playerMesh');
    finish('playerClips');

    this.enemyTemplate = await buildCharacter({
      meshUrl: `${ASSET_BASE}${ENEMY_SOURCE.mesh}`,
      clipUrls: Object.fromEntries(Object.entries(ENEMY_SOURCE.clips).map(([k, v]) => [k, `${ASSET_BASE}${v}`])),
      targetHeight: SETTINGS.enemyHeight,
      onProgress: (loaded, total) => report('enemyMesh', loaded, total),
      onStep: (key, index, steps) => report('enemyClips', 0, 1, index, steps),
    });
    finish('enemyMesh');
    finish('enemyClips');

    const built = await createWorld(this.scene, this.renderer);
    this.world = built.world;
    this.sun = built.sun;
    finish('world');

    this.player = new Player(this.playerTemplate);
    this.scene.add(this.player.object);
    this.player.onKickHit = () => this.resolveMelee();
    this.player.onReload = () => this.audio.reload();
    this.player.onTierChange = (boot) => this.onTierUp(boot);

    this.enemyManager = new EnemyManager(this.scene, this.enemyTemplate, this.world);
    this.effects = new Effects(this.scene);

    await this.player.equipWeapon();
    finish('weapon');
    onProgress(100);

    this.state = 'ready';
  }

  // ------------------------------------------------------------- lifecycle

  start() {
    this.audio.resume();
    this.hud.hideStart();
    this.hud.setCrosshair(true);
    this.hud.hideGameOver();
    this.state = 'playing';
    this.timer.update();
    this.timer.getDelta(); // discard the loading-time delta
    this.audio.playMusic(MUSIC.map((track) => `${ASSET_BASE}${track}`));
    this.startWave(1);
  }

  get paused() { return this.state === 'playing' && document.pointerLockElement === null; }

  bindEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // All movement, aiming, firing and actions live in InputManager. This only
    // handles grabbing the mouse pointer, which is a browser permission rather
    // than an input mapping.
    this.renderer.domElement.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (
        this.state === 'playing'
        && document.pointerLockElement === null
        && !this.inputManager.pointerFree
      ) {
        const request = this.renderer.domElement.requestPointerLock();
        if (request && typeof request.catch === 'function') request.catch(() => {});
      }
    });
    this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === null) this.inputManager.releaseFiring();
    });
  }

  /** True when the world should advance this frame. */
  canSimulate() {
    if (this.state !== 'playing') return false;
    // A controller or the touch pad removes the need to capture the mouse.
    if (this.inputManager.pointerFree) return true;
    return document.pointerLockElement !== null;
  }

  /** Fold this frame's input into aim, movement and queued actions. */
  applyInput(dt) {
    const manager = this.inputManager;
    manager.update(dt);

    const look = manager.consumeLook();
    if (look.dx || look.dy) {
      this.cameraYaw -= look.dx * SETTINGS.mouseSensitivity;
      this.cameraPitch = clamp(
        this.cameraPitch - look.dy * SETTINGS.mouseSensitivity,
        SETTINGS.camPitchMin,
        SETTINGS.camPitchMax,
      );
    }

    this.input.forward = manager.move.forward;
    this.input.strafe = manager.move.strafe;
    this.input.sprint = manager.move.sprint;
    this.input.firing = manager.firing;

    for (const action of manager.takeActions()) {
      if (action === 'kick') this.player.melee();
      else if (action === 'jump') this.player.jump();
      else if (action === 'reload') this.player.beginReload();
      else if (action === 'mute') this.toggleMute();
      else if (action === 'pause' && document.pointerLockElement) document.exitPointerLock();
    }
  }

  toggleMute() {
    this.audio.setMuted(!this.audio.muted);
    this.hud.toast('Audio', this.audio.muted ? 'Muted' : 'Unmuted');
  }

  // ----------------------------------------------------------------- waves

  startWave(number) {
    this.wave = number;
    this.enemyManager.queueWave(number, this.player.position);
    const tagline = TAGLINES[(number - 1) % TAGLINES.length];
    this.hud.showBanner(`WAVE ${number}`, tagline, 3);
    this.audio.waveStart();
  }

  updateWaves(dt) {
    if (this.state !== 'playing') return;
    const alive = this.enemyManager.aliveCount;
    const pending = this.enemyManager.pendingCount;
    if (alive === 0 && pending === 0) {
      if (this.intermission <= 0) {
        const next = this.wave + 1;
        if (next > SETTINGS.totalWaves) { this.victory(); return; }
        // The breather between waves shortens as the game escalates.
        this.intermission = waveRamp(next).intermission;
        this.hud.showBanner('WAVE CLEARED', `Wave ${next} incoming — ${TAGLINES[next % TAGLINES.length]}`, 3.4);
      } else {
        this.intermission -= dt;
        if (this.intermission <= 0) {
          this.intermission = 0;
          this.startWave(this.wave + 1);
        }
      }
    }
  }

  // --------------------------------------------------------------- combat

  castBullet(origin, direction, maxDistance) {
    const worldHit = this.world.raycast(origin, direction, maxDistance);
    const worldT = worldHit ? worldHit.t : maxDistance;
    let best = null;
    for (const enemy of this.enemyManager.enemies) {
      if (enemy.dead || enemy.routed) continue;
      const head = enemy.headPosition;
      const chest = this._tmpB.set(enemy.position.x, enemy.position.y + 1.05, enemy.position.z);
      const tHead = raySphere(origin, direction, head, 0.26);
      const tBody = raySphere(origin, direction, chest, 0.45);
      if (tHead !== null && tHead < worldT && (!best || tHead < best.t)) {
        best = { t: tHead, enemy, multiplier: SETTINGS.headshotMultiplier, part: 'head' };
      }
      if (tBody !== null && tBody < worldT && (!best || tBody < best.t)) {
        best = { t: tBody, enemy, multiplier: 1, part: 'body' };
      }
    }
    if (best) return { ...best, point: origin.clone().addScaledVector(direction, best.t) };
    if (worldHit) return { t: worldHit.t, point: worldHit.point, kind: worldHit.kind };
    return null;
  }

  tryShoot() {
    if (!this.player.canFire()) {
      if (this.player.ammo === 0 && this.player.reloading <= 0) this.player.beginReload();
      return;
    }
    if (!this.player.fire()) return;

    this.audio.shoot();
    const origin = this.camera.getWorldPosition(this._tmpA).clone();
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    direction.x += (Math.random() - 0.5) * SETTINGS.spread;
    direction.y += (Math.random() - 0.5) * SETTINGS.spread;
    direction.z += (Math.random() - 0.5) * SETTINGS.spread;
    direction.normalize();

    const forward = new THREE.Vector3(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw));
    const muzzle = this.player.position.clone().add(new THREE.Vector3(0, 1.35, 0)).addScaledVector(forward, 0.65);
    this.effects.muzzle(muzzle);

    const hit = this.castBullet(origin, direction, SETTINGS.bulletRange);
    const end = hit ? hit.point : origin.clone().addScaledVector(direction, SETTINGS.bulletRange);
    this.effects.tracer(muzzle, end, 0xffe6a8);

    if (hit && hit.enemy) {
      this.damageEnemy(hit.enemy, SETTINGS.bulletDamage * hit.multiplier, hit.part);
    } else if (hit) {
      this.effects.burst(hit.point, 5, 0xd8cfa8);
      this.audio.impact();
    }

    this.recoilPitch += SETTINGS.recoil * 0.02;
    this.shake = Math.max(this.shake, 0.3);
  }

  /**
   * Gunfire wounds, and sustained fire slowly bleeds an attacker down. It is
   * far slower than the boot and only credits a fraction of a tier point.
   */
  damageEnemy(enemy, amount, part) {
    const wasWounded = enemy.wounded;
    const wasBleeding = enemy.bleeding;
    const downed = enemy.takeDamage(amount);
    this.effects.burst(enemy.headPosition, part === 'head' ? 9 : 5, 0xc2402c);
    this.hud.flashHit(false);
    if (!wasWounded && enemy.wounded) this.audio.wounded();
    if (!wasBleeding && enemy.bleeding) this.hud.toast('WOUNDED', 'Bleeding out — the boot is quicker');
    if (downed) this.onEnemyDown(enemy);
  }

  /**
   * A bullet downing. It counts as an elimination but is never the fast option:
   * the boot routs on contact and pays a full tier point, this pays a quarter.
   */
  onEnemyDown(enemy) {
    this.audio.downed();
    this.effects.burst(enemy.position.clone().setY(0.9), 6, 0xc2402c);
    this.enemiesKilledTotal += 1;
    this.enemyManager.notifyEliminated();
    this.player.registerKill(false, SETTINGS.bulletKillWeight);
    if (Math.random() < 0.2) this.effects.spawnPickup(enemy.position.clone().setY(0.4), 'ammo');
    this.hud.showBanner('BLEEDING OUT', 'GUNFIRE ELIMINATION', 0.9);
    this.checkAchievements();
  }

  /** Send an attacker running, count it, and leave loot behind. */
  routEnemy(enemy, direction, force) {
    if (!enemy.rout(direction, force)) return false;
    this.audio.scream();
    // An elimination buys the rest of the line another window in cover.
    this.enemyManager.notifyEliminated();
    // registerKill raises the boot tier, which fires onTierChange -> onTierUp.
    this.player.registerKill(true);
    // Roughly a third of eliminations drop ammo and a fifth drop a dressing.
    // Healing has to keep up with a wave's incoming fire, or the run ends in
    // wave three no matter how well it is played.
    const dry = this.player.ammo === 0 && this.player.reserve < 30;
    const roll = Math.random();
    if (dry || roll < 0.32) this.effects.spawnPickup(enemy.position.clone().setY(0.4), 'ammo');
    else if (roll < 0.52) this.effects.spawnPickup(enemy.position.clone().setY(0.4), 'health');
    this.checkAchievements();
    return true;
  }

  resolveMelee() {
    const boot = this.player.boot;
    const origin = this.player.position;
    const forward = new THREE.Vector3(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw));

    const inArc = [];
    for (const enemy of this.enemyManager.enemies) {
      if (enemy.dead || enemy.routed) continue;
      const to = new THREE.Vector3(enemy.position.x - origin.x, 0, enemy.position.z - origin.z);
      const dist = to.length();
      if (dist > SETTINGS.kickRange + 0.7) continue;
      if (dist > 1e-3) to.divideScalar(dist);
      if (Math.acos(clamp(to.dot(forward), -1, 1)) > SETTINGS.kickArc) continue;
      inArc.push({ enemy, dist });
    }
    inArc.sort((a, b) => a.dist - b.dist);

    // Better boots send more of the crowd running; the rest just get shoved.
    const routeLimit = 1 + Math.floor(this.player.bootIndex / 2);
    let routed = 0;
    for (let i = 0; i < inArc.length; i++) {
      const { enemy } = inArc[i];
      enemy.knock.addScaledVector(forward, boot.knockback);
      this.effects.burst(enemy.position.clone().setY(0.95), 8, 0xffd08a);
      if (i < routeLimit && this.routEnemy(enemy, forward, boot.knockback)) {
        routed += 1;
        continue;
      }
      // The boot only sends a limited number running; the rest take the hit.
      // Better boots hurt far harder, so a wounded attacker left standing is
      // usually finished by the next kick.
      if (enemy.takeDamage(boot.meleeDamage)) this.onEnemyDown(enemy);
    }

    this.audio.kick();
    this.shake = Math.max(this.shake, routed > 0 ? 0.9 : 0.3);
    if (routed > 0) {
      this.hud.showBanner(
        'THE BOOT',
        routed > 1 ? `${routed} ATTACKERS SENT RUNNING` : 'SENT RUNNING',
        1.2,
      );
    } else if (inArc.length > 0) {
      this.hud.showBanner('THE BOOT', 'JUST A SHOVE', 0.8);
    }
    this.checkAchievements();
  }

  /**
   * The hidden line has broken cover and is closing in: either the fight had
   * gone quiet for too long, or this is the last of the wave.
   */
  onFlush(lastStand, announce = true) {
    this.audio.flush();
    if (!announce) return;
    this.hud.showBanner(
      lastStand ? 'LAST STAND' : 'THEY\u2019RE MOVING',
      lastStand ? 'THE LAST OF THEM ARE COMING' : 'NO MORE HIDING',
      1.8,
    );
  }

  enemyFire(enemy, dist, wounded = false, suppressed = false) {
    const from = enemy.headPosition;
    // A shooter leaning out of cover is rushed and far less accurate.
    const base = (wounded ? 0.4 : 0.6) - (suppressed ? 0.2 : 0);
    const hitChance = clamp(base - dist * 0.011, 0.04, 0.5);
    const hit = Math.random() < hitChance;
    const target = this.player.headPosition.clone();
    if (!hit) {
      target.x += (Math.random() - 0.5) * 2.6;
      target.y += (Math.random() - 0.5) * 1.5;
      target.z += (Math.random() - 0.5) * 2.6;
    }
    this.audio.enemyShoot();
    this.effects.tracer(from, target, 0xffb37a);
    if (hit) {
      const died = this.player.takeDamage(SETTINGS.enemyDamage * (enemy.elite ? 1.5 : 1));
      this.hud.flashDamage();
      this.shake = Math.max(this.shake, 0.5);
      if (died) this.gameOver();
    }
  }

  onPickup(type) {
    if (type === 'ammo') {
      this.player.addAmmo(45);
      this.hud.toast('Ammo Crate', '+45 reserve rounds');
    } else {
      this.player.heal(30);
      this.hud.toast('Field Dressing', '+30 health');
    }
    this.audio.pickup();
  }

  onTierUp(boot) {
    this.audio.tierUp();
    this.hud.showBanner('BOOT UPGRADED', boot.name, 3.2);
    this.checkAchievements();
  }

  // ---------------------------------------------------------- progression

  checkAchievements() {
    if (!this.player) return;
    const unlock = (id) => {
      if (this.achievements.has(id)) return;
      const found = ACHIEVEMENTS.find((a) => a.id === id);
      if (!found) return;
      this.achievements.add(id);
      this.hud.toast(found.label, found.desc);
    };
    if (this.player.kills >= 1) unlock('first_blood');
    if (this.player.meleeKills >= 25) unlock('melee_25');
    if (this.wave >= 5) unlock('wave_5');
    if (this.player.kills >= 100) unlock('kills_100');
    if (this.player.bootIndex >= 2) unlock('silver');
    if (this.player.bootIndex >= 3) unlock('gold');
    if (this.player.bootIndex >= 6) unlock('legendary');
    if (this.enemyManager && this.enemyManager.aliveCount >= 6) unlock('surrounded');
  }

  gameOver() {
    if (this.state === 'over') return;
    this.state = 'over';
    if (document.pointerLockElement) document.exitPointerLock();
    this.audio.stopMusic();
    this.audio.gameOver();
    this.hud.setCrosshair(false);
    this.hud.showGameOver('YOU ARE DOWN', `
      <p>The forest keeps its ground… for now.</p>
      <div class="stats">
        <span>Wave reached</span><b>${this.wave}</b>
        <span>Eliminations</span><b>${this.player.kills}</b>
        <span>Boot eliminations</span><b>${this.player.meleeKills}</b>
        <span>Boot tier</span><b>${this.player.boot.name}</b>
      </div>
      <p class="hint">Click anywhere to redeploy</p>`);
    this.hud.over.onclick = () => window.location.reload();
  }

  victory() {
    if (this.state === 'over') return;
    this.state = 'over';
    if (document.pointerLockElement) document.exitPointerLock();
    this.audio.stopMusic();
    this.audio.victory();
    this.checkAchievements();
    this.hud.setCrosshair(false);
    this.hud.showGameOver('ONE-MAN ARMY', `
      <p>Every attacker that entered the forest has learned the lesson.</p>
      <div class="stats">
        <span>Waves cleared</span><b>${Math.min(this.wave, SETTINGS.totalWaves)}</b>
        <span>Eliminations</span><b>${this.player.kills}</b>
        <span>Boot eliminations</span><b>${this.player.meleeKills}</b>
        <span>Boot tier</span><b>${this.player.boot.name}</b>
      </div>
      <p class="hint">Click anywhere to play again</p>`);
    this.hud.over.onclick = () => window.location.reload();
  }

  // ------------------------------------------------------------------ loop

  /**
   * Over-the-shoulder rig. The camera is oriented along (yaw, pitch) rather than
   * looking at the player, so the aim direction is exactly the crosshair axis and
   * the ray fired from the camera passes through whatever is under the reticle.
   */
  updateCamera(dt) {
    // Recoil is a transient kick layered on top of the player's aim, not a
    // permanent change to it — otherwise sustained fire walks the reticle away.
    this.recoilPitch = damp(this.recoilPitch, 0, 11, dt);

    const yaw = this.cameraYaw;
    const pitch = clamp(
      this.cameraPitch + this.recoilPitch,
      SETTINGS.camPitchMin,
      SETTINGS.camPitchMax,
    );
    const cp = Math.cos(pitch);
    const direction = new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    const anchor = new THREE.Vector3(
      this.player.position.x,
      this.player.position.y + SETTINGS.camHeight,
      this.player.position.z,
    ).addScaledVector(right, SETTINGS.camShoulder);

    const back = direction.clone().negate();
    const hit = this.world.raycast(anchor, back, SETTINGS.camDistance);
    const distance = hit ? Math.max(1.2, hit.t - 0.45) : SETTINGS.camDistance;

    const desired = anchor.clone().addScaledVector(back, distance);
    desired.y = Math.max(0.8, desired.y);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.4);
      desired.x += (Math.random() - 0.5) * this.shake * 0.35;
      desired.y += (Math.random() - 0.5) * this.shake * 0.35;
    }
    this.camera.position.lerp(desired, 1 - Math.exp(-16 * dt));
    this.camera.lookAt(
      this.camera.position.x + direction.x,
      this.camera.position.y + direction.y,
      this.camera.position.z + direction.z,
    );
  }

  step(dt) {
    this.applyInput(dt);
    this.player.update(dt, { input: this.input, world: this.world, cameraYaw: this.cameraYaw });
    this.enemyManager.update(dt, {
      player: this.player,
      onFire: (enemy, dist, wounded, suppressed) => this.enemyFire(enemy, dist, wounded, suppressed),
      onDown: (enemy) => this.onEnemyDown(enemy),
      onFlush: (lastStand, announce) => this.onFlush(lastStand, announce),
    });
    this.effects.update(dt, this.player, (type) => this.onPickup(type));

    // Camera first so shots use this frame's aim rather than last frame's.
    this.updateCamera(dt);
    if (this.input.firing) this.tryShoot();

    // Music reacts to whether there is anyone left to fight.
    const inContact = this.enemyManager.aliveCount > 0 || this.enemyManager.pendingCount > 0;
    this.audio.setMusicMode(inContact ? 'combat' : 'calm');
    this.audio.updateMusic(dt);

    this.updateWaves(dt);

    if (this.sun) {
      this.sun.position.set(this.player.position.x + 40, 62, this.player.position.z + 26);
      this.sun.target.position.copy(this.player.position);
      this.sun.target.updateMatrixWorld();
    }

    this.hud.update({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      ammo: this.player.ammo,
      reserve: this.player.reserve,
      reloading: this.player.reloading > 0,
      wave: this.wave,
      totalWaves: SETTINGS.totalWaves,
      enemiesAlive: this.enemyManager.aliveCount + this.enemyManager.pendingCount,
      kills: this.player.kills,
      meleeKills: this.player.meleeKills,
      boot: this.player.boot,
      bootProgress: this.bootProgress(),
      killsToNext: this.killsToNext(),
      nextBoot: this.nextBootName(),
    }, dt);
    this.checkAchievements();
  }

  /** Progress toward the next boot tier, as a 0..1 fraction (1 when maxed). */
  bootProgress() {
    const next = BOOT_TIERS[this.player.bootIndex + 1];
    if (!next) return 1;
    const from = this.player.boot.kills;
    const span = next.kills - from;
    if (span <= 0) return 1;
    return clamp((this.player.tierCredit - from) / span, 0, 1);
  }

  killsToNext() {
    const next = BOOT_TIERS[this.player.bootIndex + 1];
    if (!next) return 0;
    return Math.ceil(Math.max(0, next.kills - this.player.tierCredit));
  }

  nextBootName() {
    const next = BOOT_TIERS[this.player.bootIndex + 1];
    return next ? next.name : null;
  }

  run() {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.timer.update();
      const dt = Math.min(0.05, this.timer.getDelta());

      if (this.state === 'playing') {
        if (this.canSimulate()) {
          this.step(dt);
          this.hud.setPaused(false);
        } else {
          // Still poll input so a controller or the touch pad can take over.
          this.inputManager.update(dt);
          this.inputManager.consumeLook();
          this.inputManager.takeActions();
          this.hud.update(this.hudState(), dt);
          this.hud.setPaused(true, this.inputManager.touchMode
            ? 'Use the on-screen controls to begin'
            : 'Click to capture the mouse');
        }
      } else if (this.state === 'over') {
        this.hud.update(this.hudState(), dt);
      }

      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  /** HUD values for a frame where the world is not simulating (paused). */
  hudState() {
    return {
      health: this.player?.health ?? 0,
      maxHealth: SETTINGS.maxHealth,
      ammo: this.player?.ammo ?? 0,
      reserve: this.player?.reserve ?? 0,
      reloading: this.player ? this.player.reloading > 0 : false,
      wave: this.wave,
      totalWaves: SETTINGS.totalWaves,
      enemiesAlive: this.enemyManager
        ? this.enemyManager.aliveCount + this.enemyManager.pendingCount
        : 0,
      kills: this.player?.kills ?? 0,
      meleeKills: this.player?.meleeKills ?? 0,
      boot: this.player?.boot ?? { name: 'Standard Boot', color: '#c8b18d' },
      bootProgress: this.player ? this.bootProgress() : 0,
      killsToNext: this.player ? this.killsToNext() : 0,
      nextBoot: this.player ? (this.nextBootName() || '') : '',
    };
  }
}
