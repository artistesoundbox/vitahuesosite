// Page-side campaign driver for test/campaign.mjs.
//
// This file is read as text by the Node harness and evaluated inside the game
// page. It plays the match itself — every frame it drives the real InputManager
// (a stub gamepad for the trigger/aim tune, the keyboard map for movement) and
// then calls the game's own per-frame step, which is the same function the
// requestAnimationFrame loop calls. Nothing here reaches past the interfaces a
// player uses, so a passing run means the game really is playable that way.

/* eslint-env browser */

async function runCampaign(options) {
  const opts = Object.assign({
    waves: 10,
    waveLimitSeconds: 150,
    maxSteps: 60000,
    seed: 0,
  }, options || {});

  const G = window.__brokenBoot;
  if (!G || !G.player || !G.enemyManager) return { fatal: 'game object missing' };

  // ---------------------------------------------------------------- seeded RNG
  // A deterministic campaign makes the report comparable between runs, which is
  // the whole point of checking pacing automatically.
  if (opts.seed) {
    let s = opts.seed >>> 0;
    Math.random = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const THREE = await import('three');
  const errors = [];
  window.addEventListener('error', (e) => errors.push(`window.onerror: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`unhandledrejection: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

  // ------------------------------------------------------------------ controls
  // LT (aim tune) and RT (fire) come from a stub pad so the real gamepad path is
  // exercised; movement and the action keys go through the keyboard map.
  const pad = {
    connected: true,
    id: 'harness pad',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  navigator.getGamepads = () => [pad];
  pad.buttons[6] = { pressed: true, value: 1 };     // aim tune held for the match
  G.inputManager.gamepadActive = true;
  G.inputManager._padUsed = true;                   // no pointer capture needed

  const IM = G.inputManager;
  const keys = IM.keys;
  const release = () => {
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft']) keys[k] = false;
  };

  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const eye = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const chest = new THREE.Vector3();

  let frame = 0;

  /** One frame of "player": aim at what is visible, close in, fire, boot, loot. */
  function pilot() {
    const cam = G.camera.getWorldPosition(eye);
    const dir = G.camera.getWorldDirection(fwd);
    const yaw = Math.atan2(dir.x, dir.z);

    let visible = null, visibleDist = Infinity;
    let nearest = null, nearestDist = Infinity;
    for (const e of G.enemyManager.enemies) {
      if (!e || e.dead || e.routed) continue;
      const d = G.player.position.distanceTo(e.position);
      if (d < nearestDist) { nearestDist = d; nearest = e; }
      chest.set(e.position.x, e.position.y + 1.05, e.position.z);
      if (d < visibleDist && G.world.hasLineOfSight(cam, chest)) { visibleDist = d; visible = e; }
    }

    // Someone in cover is still worth walking towards, the same as a player
    // heading for where they last saw a body.
    const goal = visible ? visible.position : (nearest ? nearest.position : null);
    if (goal) {
      const err = wrapAngle(Math.atan2(goal.x - cam.x, goal.z - cam.z) - yaw);
      IM.look.dx += -(err / 0.0022) * 0.9;
    } else if (G.effects.pickups.length) {
      const p = G.effects.pickups[0].mesh.position;
      const pd = Math.hypot(p.x - G.player.position.x, p.z - G.player.position.z);
      if (pd > 1.2) {
        IM.look.dx += -(wrapAngle(Math.atan2(p.x - cam.x, p.z - cam.z) - yaw) / 0.0022) * 0.5;
      }
    }

    release();
    if (goal) {
      const d = G.player.position.distanceTo(goal);
      if (d > 2.6) keys['KeyW'] = true;
      keys[Math.floor(frame / 90) % 2 === 0 ? 'KeyD' : 'KeyA'] = true;
      keys['ShiftLeft'] = d > 14;
    } else if (G.effects.pickups.length) {
      const p = G.effects.pickups[0].mesh.position;
      if (Math.hypot(p.x - G.player.position.x, p.z - G.player.position.z) > 1.2) keys['KeyW'] = true;
    }

    const firing = Boolean(G.lock) || G.isAttackerUnderReticle();
    pad.buttons[7] = { pressed: firing, value: firing ? 1 : 0 };

    if (visible && visibleDist <= 3.3 && G.player.canMelee()) G.player.melee();
    if (G.player.ammo <= 0 && G.player.reloading <= 0) G.player.beginReload();
  }

  // ------------------------------------------------------------------ bookkeeping
  const report = {
    seed: opts.seed,
    startedAt: new Date().toISOString(),
    gameSeconds: 0,
    steps: 0,
    waves: [],
    tiers: [],
    banners: [],
    eliminations: 0,
    bootEliminations: 0,
    lootCollected: 0,
    healthAtEnd: null,
    outcome: null,
    errors,
  };

  let wave = { n: null, startS: 0, hostiles: 0, kills: 0 };
  let lastTier = null;
  let lastBanner = null;
  let stallSeconds = 0;
  let lastKillCount = 0;
  let stalledWave = null;

  const beginWave = (n, atS) => {
    wave = { n, startS: +atS.toFixed(2), hostiles: G.enemyManager.aliveCount + G.enemyManager.queue.length, kills: 0 };
  };

  const originalStep = G.step.bind(G);
  G.step = function harnessStep(dt) {
    pilot();
    const beforeKills = G.player.kills;
    const beforeLoot = G.effects.pickups.length;

    originalStep(dt);

    report.steps += 1;
    report.gameSeconds += dt;
    frame += 1;
    const t = report.gameSeconds;

    if (G.player.kills > beforeKills) {
      report.eliminations += G.player.kills - beforeKills;
      wave.kills += G.player.kills - beforeKills;
    }
    if (G.effects.pickups.length < beforeLoot) report.lootCollected += beforeLoot - G.effects.pickups.length;
    report.bootEliminations = G.player.meleeKills;
    report.healthAtEnd = G.player.health;

    // Wave handover: close the previous wave's row and open the next.
    if (G.wave !== wave.n) {
      if (wave.n !== null) {
        report.waves.push({
          wave: wave.n,
          startSeconds: wave.startS,
          clearSeconds: +t.toFixed(2),
          durationSeconds: +(t - wave.startS).toFixed(2),
          hostilesAtStart: wave.hostiles,
          eliminations: wave.kills,
        });
      }
      beginWave(G.wave, t);
    }

    // Boot tier unlocks, with the time they arrived.
    if (G.player.boot.name !== lastTier) {
      lastTier = G.player.boot.name;
      report.tiers.push({ tier: lastTier, atSeconds: +t.toFixed(2), credit: +G.player.tierCredit.toFixed(2) });
    }

    // The player-visible banner feed, for reading the pace back afterwards.
    const bannerEl = document.getElementById('banner');
    if (bannerEl && bannerEl.classList.contains('show') && bannerEl.textContent !== lastBanner) {
      lastBanner = bannerEl.textContent;
      report.banners.push({ text: lastBanner, atSeconds: +t.toFixed(2) });
    }

    // Stall watchdog: the failure this harness exists to catch is a wave that
    // cannot finish, not a wave that is merely slow.
    if (G.player.kills !== lastKillCount) { lastKillCount = G.player.kills; stallSeconds = 0; }
    else stallSeconds += dt;
    if (stallSeconds > opts.waveLimitSeconds && stalledWave === null) {
      stalledWave = { wave: G.wave, stalledFor: +stallSeconds.toFixed(1), hostiles: G.enemyManager.aliveCount + G.enemyManager.queue.length };
    }
  };

  // ------------------------------------------------------------------ run
  const startButton = document.getElementById('start-button');
  if (startButton) startButton.click();
  if (G.state !== 'playing') G.start();
  if (G.state !== 'playing') return { fatal: `game did not start (state ${G.state})` };
  beginWave(G.wave, 0);

  // Drive frames one at a time through the patched step, which is where the
  // pilot, the bookkeeping and the stall watchdog live.
  while (report.steps < opts.maxSteps) {
    if (G.state !== 'playing') break;
    if (G.wave > opts.waves) break;
    if (stalledWave) break;          // a wave that cannot finish is the failure to catch
    G.step(1 / 60);
  }

  // Close the final wave row, unless the run ended by handing over to a wave the
  // harness was not asked to play.
  if (wave.n !== null && G.wave <= opts.waves) {
    report.waves.push({
      wave: wave.n,
      startSeconds: wave.startS,
      clearSeconds: +report.gameSeconds.toFixed(2),
      durationSeconds: +(report.gameSeconds - wave.startS).toFixed(2),
      hostilesAtStart: wave.hostiles,
      eliminations: wave.kills,
      closedByHarness: true,
    });
  }

  release();
  pad.buttons[7] = { pressed: false, value: 0 };
  G.step = originalStep;
  G.inputManager.gamepadActive = false;
  G.inputManager._padUsed = false;

  report.outcome = G.state === 'playing' ? (G.wave > opts.waves ? 'reached-wave-cap' : 'step-cap') : G.state;
  report.gameSeconds = +report.gameSeconds.toFixed(2);
  report.wavesReached = G.wave;
  report.stalledWave = stalledWave;
  return report;
}
