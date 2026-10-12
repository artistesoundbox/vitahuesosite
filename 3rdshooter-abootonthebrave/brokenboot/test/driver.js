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
    // 'alive' keeps the officer on their feet so a mediocre scripted pilot can
    // still measure every wave's pacing; 'none' plays it straight and reports
    // where the run ended instead.
    instrument: 'alive',
    // Assert the aim-trigger rule instead of playing the campaign.
    checkLock: false,
    // Assert the three kicks and the scenery they move instead.
    checkKick: false,
    // Play a whole wave with the officer's ammunition taken away.
    checkDry: false,
    // Audit the officer's own mesh file: weighted, anchored, and still carrying a
    // boot the tier system can replace.
    checkCharacter: false,
    // Audit these forest seeds instead of playing the campaign (the forest the
    // page is already playing is always audited too).
    forestSeeds: null,
  }, options || {});
  const instrumented = opts.instrument === 'alive';
  // The ceiling has to move with the pool: a field dressing heals via
  // `min(maxHealth, health + amount)`, which would otherwise clamp an
  // instrumented officer straight back down to 100 and report the drop as
  // damage taken.
  const INSTRUMENT_MAX_HEALTH = 1000000;

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
  const { SETTINGS, KICKS, BOOT_TIERS } = await import('./js/config.js');
  const SENS = SETTINGS.mouseSensitivity;
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

  // Movement has to go through the pad sticks. Once a pad is connected the
  // InputManager stops applying the keyboard, so setting key state here would
  // silently do nothing — which is exactly how the harness first "found" a wave
  // that would not end, with a perfectly reachable attacker 27 m away.
  const clamp1 = (v) => Math.max(-1, Math.min(1, v));
  const pastDeadzone = (v) => (Math.abs(v) < 0.18 ? 0 : Math.sign(v) * (0.18 + Math.abs(v) * 0.82));
  const setMove = (forward, strafe, sprint) => {
    pad.axes[0] = pastDeadzone(clamp1(strafe));
    pad.axes[1] = -pastDeadzone(clamp1(forward));
    pad.buttons[10] = { pressed: Boolean(sprint), value: sprint ? 1 : 0 };
  };
  const stopMoving = () => setMove(0, 0, false);

  const FRAME = 1 / 60;                  // the step the harness drives
  let lastX = 0, lastZ = 0;              // for the wedge watchdog
  let wedgeSeconds = 0, pivotSeconds = 0, pivotSign = 1;

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
      IM.look.dx += -(err / SENS) * 0.9;
      // Pitch matters as much as yaw: the reticle cone is tight, so a camera
      // left looking at old ground is enough to stop the shot and the aim tune
      // both, and then nothing ever corrects it.
      const flat = Math.hypot(goal.x - cam.x, goal.z - cam.z);
      const wantedPitch = Math.atan2((goal.y + 1.05) - cam.y, Math.max(0.001, flat));
      IM.look.dy += -((wantedPitch - G.cameraPitch) / SENS) * 0.9;
    } else if (G.effects.pickups.length) {
      const p = G.effects.pickups[0].mesh.position;
      const pd = Math.hypot(p.x - G.player.position.x, p.z - G.player.position.z);
      if (pd > 1.2) {
        IM.look.dx += -(wrapAngle(Math.atan2(p.x - cam.x, p.z - cam.z) - yaw) / SENS) * 0.5;
      }
    }

    // Fight at range and only close to boot. Attackers hold firing lines, so
    // walking into them is what gets a player killed; the boot is for the
    // openings, and for the attackers the rifle has already floored.
    // Under instrumentation health is topped up every frame, so there is never
    // a reason to retreat and the pacing stays comparable between runs.
    // Retreating is for breaking contact, not for running away from someone who
    // has none to break: a hurt officer keeps backing off while an attacker is on
    // it, but an officer backing away from a target eighty metres off with no line
    // of sight to anyone just walks the map and never ends the wave.
    const hurt = !instrumented && G.player.health < 40 && nearestDist < 20;
    // An officer with no rounds anywhere has no rifle left, and the boot is the
    // only weapon that does not need ammunition. So a dry pilot closes instead of
    // holding a firing line it cannot shoot from — without this it stands at
    // range with the trigger down and the wave can never end, which is a
    // limitation of the pilot, not of the fight.
    const dry = G.player.ammo <= 0 && G.player.reserve <= 0;
    const holdRange = hurt ? 15 : 9;
    let forward = 0, strafe = 0, sprint = false;
    if (goal) {
      const d = G.player.position.distanceTo(goal);
      if (dry) forward = 1;
      else if (d > holdRange + 2) forward = d > 20 ? 1 : 0.7;
      if (!dry && (d < holdRange - 3.5 || hurt)) forward = -1;
      strafe = Math.floor(frame / 70) % 2 === 0 ? 0.55 : -0.55;   // keep orbiting
      sprint = d > 18 || hurt;
    } else if (G.effects.pickups.length) {
      const p = G.effects.pickups[0].mesh.position;
      if (Math.hypot(p.x - G.player.position.x, p.z - G.player.position.z) > 1.2) forward = 0.8;
    }

    // Wedge recovery. The world honestly blocks movement, so a pilot that keeps
    // steering into a crate pocket or the car parks there for the rest of the
    // wave with no line to anyone — which reads as a wave that will not end. A
    // player backs out and goes round, so the pilot does too: no displacement
    // while commanding movement means it is wedged.
    const moved = Math.hypot(G.player.position.x - lastX, G.player.position.z - lastZ);
    lastX = G.player.position.x;
    lastZ = G.player.position.z;
    if (pivotSeconds > 0) {
      pivotSeconds -= FRAME;
      forward = -0.9;                 // back out of the pocket first
      strafe = pivotSign;
      sprint = false;
    } else if ((forward !== 0 || strafe !== 0) && moved < 0.012) {
      wedgeSeconds += FRAME;
      if (wedgeSeconds > 1.2) {
        pivotSeconds = 1.8;
        pivotSign = -(pivotSign || 1);   // the next wedge tries the other way round
        wedgeSeconds = 0;
      }
    } else {
      wedgeSeconds = 0;
    }

    const firing = Boolean(G.lock) || G.isAttackerUnderReticle();
    pad.buttons[7] = { pressed: firing, value: firing ? 1 : 0 };

    const closest = visible || nearest;
    if (closest) {
      const cd = G.player.position.distanceTo(closest.position);
      const worthBooting = dry || G.player.bootChargeReady || closest.bleeding || closest.wounded;
      // Kick from the reach of the kick that is actually available, not the old
      // global figure — a stomp is shorter than a high kick.
      const kickReach = (KICKS[G.player.kickType()] || KICKS.kick).range;
      if (cd <= kickReach && G.player.canMelee()) G.player.melee();
      // A dry officer closes whatever its health is doing: backing off to heal
      // is not on the table when the boot is the only thing that can hurt them.
      if (worthBooting && (dry || !hurt) && pivotSeconds <= 0) forward = 1;
    }
    setMove(forward, strafe, sprint);
    if (G.player.ammo <= 0 && G.player.reloading <= 0) G.player.beginReload();
  }

  // ------------------------------------------------------- aim trigger probe
  /**
   * The rule the aim trigger is supposed to follow: every fresh press acquires
   * the attacker closest to the crosshair, while a trigger held down keeps the
   * one it already caught instead of flicking between two of them.
   *
   * Asserted against the real InputManager (via the stub pad's left trigger) and
   * the real lock code, with two attackers placed at known angles inside the
   * lock cone. Calling the pieces of the frame directly rather than stepping the
   * whole match keeps the geometry still — the point is which attacker is picked,
   * not how the camera drifts while it happens.
   */
  function probeLockRetarget() {
    const cone = SETTINGS.lockAngle;
    const savedRate = SETTINGS.lockRate;
    const savedEnemies = G.enemyManager.enemies;
    const lt = pad.buttons[6];
    // Far enough out that swinging the view moves the aim far more than it
    // slides the over-the-shoulder camera: at 6 m the parallax from the eye
    // moving sideways was the same size as the swing being tested.
    const out = { cone: +cone.toFixed(3), distance: 26, pass: false };

    // One of the frame's real stages, in the order update() runs them.
    const frame = () => {
      G.inputManager.update(FRAME);
      G.applyInput(FRAME);
      G.updateTargetLock(FRAME);
      G.updateCamera(FRAME);
      // The renderer is what normally refreshes this, and the aim code reads the
      // camera through getWorldDirection(), so without it the probe would be
      // aiming the view while every angle it measures stayed at the old heading.
      G.camera.updateMatrixWorld(true);
    };
    const names = () => (G.lock ? G.lock.enemy.label : null);
    // The trigger is read as an analog axis as well as a button, so both have to
    // move: clearing only `pressed` left value at 1 and the InputManager never
    // saw the trigger come up, so no press edge could ever follow it.
    const setLt = (on) => { lt.pressed = on; lt.value = on ? 1 : 0; };
    // The camera eases toward where it wants to be, so angles read while it is
    // still travelling are a moving target. Half a second is plenty for it to
    // arrive (and it cannot move on its own: the lock's turn rate is zeroed).
    const settle = () => { for (let s = 0; s < 40; s++) frame(); };

    try {
      SETTINGS.lockRate = 0;          // hold the view still, so the angles are ours
      setMove(0, 0, false);
      G.inputManager.gamepadActive = true;
      G.enemyManager.enemies = [];
      G.lock = null;
      G.targetingHeld = false;
      setLt(false);
      frame();                        // settle: no trigger, no lock

      const V = (x, y, z) => new THREE.Vector3(x, y, z);
      const spots = [0.25, -0.6];     // yaw offsets, in units of the lock cone

      // Look for a heading with both spots in the clear. The forest is scanned
      // geometry, so assuming one would make the probe stumble over a trunk
      // instead of testing the rule.
      let base = null;
      for (let i = 0; i < 48 && base === null; i++) {
        G.cameraYaw = -(i * Math.PI) / 24;   // 7.5° steps, a fresh heading each time
        settle();
        const eye = G.camera.getWorldPosition(V(0, 0, 0));
        const look = G.camera.getWorldDirection(V(0, 0, 0));
        const heading = Math.atan2(look.x, look.z);
        const at = (off) => V(
          eye.x + Math.sin(heading + off * cone) * out.distance,
          eye.y - 1.05,
          eye.z + Math.cos(heading + off * cone) * out.distance,
        );
        const near = at(spots[0]);
        const far = at(spots[1]);
        const chest = (p) => V(p.x, p.y + 1.05, p.z);
        if (!G.world.hasLineOfSight(eye, chest(near))) continue;
        if (!G.world.hasLineOfSight(eye, chest(far))) continue;
        base = { near, far, heading };
        out.baseHeadingRadians = +heading.toFixed(3);
      }
      if (base === null) { out.detail = 'no clear heading for the probe'; return out; }

      // 'near' sits a quarter of the cone off the crosshair, 'far' most of the
      // way to its edge: both are lockable, one is plainly closer to the aim.
      settle();                       // the placement is measured, so it has to be still

      const A = { label: 'near', dead: false, routed: false, position: base.near };
      const B = { label: 'far', dead: false, routed: false, position: base.far };
      G.enemyManager.enemies = [A, B];

      // The rule is "nearest the crosshair, that is actually in view", so the
      // probe has to know which of the two is visible, not just which is closer:
      // findLockTarget() skips an attacker with a trunk in the way, and the trick
      // of ending with the far one nearer the aim would otherwise be defeated by
      // a tree that happens to slide in front of it as the view turns.
      const visible = (e) => G.world.hasLineOfSight(
        G.camera.getWorldPosition(V(0, 0, 0)),
        V(e.position.x, e.position.y + 1.05, e.position.z),
      );
      out.anglesRadians = {
        near: +(0.25 * cone).toFixed(3), far: +(0.6 * cone).toFixed(3),
      };

      // 1. A fresh press: the attacker nearest the crosshair.
      setLt(true);
      frame(); frame();
      out.firstPress = names();

      out.anglesAtPress = { near: +G.lockAngleTo(A).toFixed(3), far: +G.lockAngleTo(B).toFixed(3) };

      // 2. Still held, swing the view until the other attacker is the one nearest
      //    the crosshair. How far that takes is measured rather than assumed: the
      //    eye slides sideways as the view turns, so the same swing moves the aim
      //    by a different amount depending on what the camera is pulled against.
      //    A held trigger must keep the attacker it caught through all of it.
      let swing = 0;
      const step = 0.25 * cone;
      const margin = 0.03;            // a clear win, not a coin flip between two near-equal angles
      const swungOnto = () => visible(B) && G.lockAngleTo(B) < G.lockAngleTo(A) - margin;
      for (let i = 0; i < 12 && !swungOnto(); i++) {
        swing += step;
        G.cameraYaw = base.heading - swing;
        settle();
      }
      out.swingRadians = +swing.toFixed(3);
      out.heldDuringSwing = names();
      out.anglesAfterSwing = { near: +G.lockAngleTo(A).toFixed(3), far: +G.lockAngleTo(B).toFixed(3) };
      out.farVisible = visible(B);
      out.swungOnTarget = swungOnto();
      if (!out.swungOnTarget) out.detail = 'never got the other attacker nearest the crosshair and in view';

      // 3. Release and press again: the reticle now sits on the other attacker,
      //    so the new press re-acquires them.
      setLt(false);
      frame();
      out.afterRelease = names();
      setLt(true);
      frame(); frame();
      out.freshPress = names();

      // The first press must take whoever the crosshair is on, and the fresh
      // press must take whoever it is on by then — which the swing has made the
      // other one, so passing means the press really did re-acquire.
      out.pass = out.firstPress === 'near'
        && out.heldDuringSwing === 'near'
        && out.swungOnTarget
        && out.freshPress === 'far';
      return out;
    } finally {
      SETTINGS.lockRate = savedRate;
      G.enemyManager.enemies = savedEnemies;
      setLt(true);                 // aim-tune held for the rest of the match
      G.input.targeting = false;
      G.lock = null;
      G.targetingHeld = false;
      setMove(0, 0, false);
    }
  }

  // --------------------------------------------------------- kicks and scenery
  /**
   * The other half of the boot: three kicks that are genuinely different — a
   * sweep that stays low and wide, a high kick that reaches furthest, a stomp
   * that lands on everything around — and scenery that goes flying when it is
   * kicked, then tumbles and settles somewhere new (still blocking bullets and
   * sight lines from where it ends up).
   */
  function probeKicks() {
    const out = { selection: {}, profiles: {}, scenery: {} };
    const savedStep = G.step;
    const savedEnemies = G.enemyManager.enemies;
    const p = G.player;
    const before = {
      crouching: p.crouching, grounded: p.grounded, bootIndex: p.bootIndex,
      cooldown: p.kickCooldown, pendingKick: p.pendingKick, charge: p.charge,
      position: p.object.position.clone(), yaw: p.yaw,
      cameraYaw: G.cameraYaw,
      shake: G.shake, kickback: G.kickback, kickRoll: G.kickRoll, hitStop: G.hitStop,
      cameraPitch: G.cameraPitch,
    };

    try {
      p.kickCooldown = 0;
      p.pendingKick = null;

      // 1. All three kicks are reachable: crouch for the sweep, be off the
      //    ground for the high kick, and the boot tier decides the standing one.
      p.grounded = true; p.crouching = true;
      out.selection.crouched = p.kickType();
      p.crouching = false; p.grounded = false;
      out.selection.airborne = p.kickType();
      p.grounded = true; p.bootIndex = 0;
      out.selection.standingStandardBoot = p.kickType();
      p.bootIndex = 2;
      out.selection.standingSilverBoot = p.kickType();
      p.bootIndex = 5;
      out.selection.standingTopBoot = p.kickType();

      // 2. And they really are different boots, not the same one relabelled.
      for (const [key, k] of Object.entries(KICKS)) {
        out.profiles[key] = {
          name: k.name,
          range: k.range,
          arcDegrees: Math.round((k.arc * 180) / Math.PI),
          damageScale: k.damageScale,
          propPower: k.propPower,
        };
      }
      out.profilesDiffer = KICKS.high.range > KICKS.kick.range
        && KICKS.kick.range > KICKS.sweep.range
        && KICKS.sweep.arc > KICKS.kick.arc
        && KICKS.kick.arc > KICKS.high.arc
        && KICKS.stomp.arc >= Math.PI - 1e-9
        && KICKS.high.damageScale > KICKS.kick.damageScale
        && KICKS.sweep.damageScale < KICKS.kick.damageScale;

      // 3. Kick the scenery. The heaviest prop goes first — if a car moves, a
      //    crate certainly does.
      G.enemyManager.enemies = [];
      G.step = originalStep;              // frames without the pilot, so nothing else kicks
      const prop = G.world.props.find((q) => q.kind === 'car') || G.world.props[0];
      out.scenery.kind = prop.kind;
      out.scenery.mass = prop.mass;
      const from = prop.mesh.position.clone();
      const startSpin = prop.mesh.rotation.clone();
      const boxFrom = prop.box.getCenter(new THREE.Vector3());

      p.object.position.set(from.x - 2.2, 0, from.z - 2.2);
      p.yaw = Math.atan2(from.x - p.object.position.x, from.z - p.object.position.z);
      G.cameraYaw = p.yaw;
      p.kickCooldown = 0;
      p.pendingKick = null;
      G.resolveMelee('stomp');
      out.scenery.speedAfterKick = +prop.vel.length().toFixed(2);

      let peak = 0;
      let frames = 0;
      while (frames < 900 && !prop.rest) {
        G.step(1 / 60);
        peak = Math.max(peak, prop.vel.length());
        frames += 1;
      }
      out.scenery.peakSpeed = +peak.toFixed(2);
      out.scenery.movedMeters = +prop.mesh.position.distanceTo(from).toFixed(2);
      out.scenery.tumbled =
        Math.abs(prop.mesh.rotation.x - startSpin.x) + Math.abs(prop.mesh.rotation.z - startSpin.z) > 0.2;
      out.scenery.settleSeconds = +(frames / 60).toFixed(1);
      out.scenery.settled = prop.rest;
      out.scenery.boxFollowed = +prop.box.getCenter(new THREE.Vector3()).distanceTo(boxFrom).toFixed(2);

      // 4. And what all of it feels like. One mass figure drives the shake, the
      //    camera kickback, the frame roll, the hit-stop and the screen-edge
      //    flash, so this reads back what the rig actually uses: a body is light,
      //    a car is not, and a swing through empty air gets none of it.
      const car = prop;
      out.feel = {};
      const clearFeel = () => {
        G.shake = 0; G.kickback = 0; G.kickRoll = 0; G.hitStop = 0; p.charge = 0;
      };
      const readFeel = () => ({
        shake: +G.shake.toFixed(3),
        kickback: +G.kickback.toFixed(3),
        roll: +G.kickRoll.toFixed(2),
        hitStop: +G.hitStop.toFixed(3),
      });
      // A stand-in body for the body cases: it has to report `rout`/`takeDamage`
      // false, because measuring the feel must not quietly eliminate somebody
      // before the match starts.
      const standIn = (x, z) => ({
        dead: false,
        routed: false,
        position: new THREE.Vector3(x, 0, z),
        knock: new THREE.Vector3(),
        rout: () => false,
        takeDamage: () => false,
      });
      const bootAt = (yaw, x = 0, z = 0) => {
        p.crouching = false;
        p.grounded = true;
        p.object.position.set(x, 0, z);
        p.yaw = yaw;
        G.cameraYaw = yaw;
        p.kickCooldown = 0;
        p.pendingKick = null;
        G.resolveMelee('kick');
      };
      const parkCar = (x, z) => {
        car.rest = true;
        car.vel.set(0, 0, 0);
        car.spin.set(0, 0, 0);
        car.mesh.position.set(x, car.baseY, z);
        // Keep the collision box with it: a parked car whose box is still at the
        // old pitch would block bullets and sight lines from thin air.
        car.box.setFromObject(car.mesh).expandByScalar(-0.05);
      };

      // A swing through empty air, in a corner of the map with nothing in reach.
      G.enemyManager.enemies = [];
      clearFeel();
      bootAt(0, 30, 30);
      out.feel.whiff = readFeel();

      // The boot into a body, 1.2 m dead ahead.
      clearFeel();
      G.enemyManager.enemies = [standIn(30, 31.2)];
      bootAt(0, 30, 30);
      out.feel.body = readFeel();

      // The boot into a car, which is the heaviest thing on the field.
      clearFeel();
      G.enemyManager.enemies = [];
      parkCar(30, 32.2);
      bootAt(0, 30, 30);
      out.feel.car = readFeel();
      out.feel.carRoll = +G.kickRoll.toFixed(2);

      // The camera really answers to it: the eye is shoved back along the aim and
      // the frame rolls. An open sightline is found first, because a shove that
      // would put the eye inside a tree is absorbed by the tree instead — so the
      // measurement has to be made where the boot can actually push.
      const upAt = () => new THREE.Vector3(0, 1, 0).applyQuaternion(G.camera.quaternion);
      let yaw = null;
      for (let i = 0; i < 8 && yaw === null; i++) {
        const candidate = (i * Math.PI) / 4;
        const right = new THREE.Vector3(Math.cos(candidate), 0, -Math.sin(candidate));
        const anchor = new THREE.Vector3(0, SETTINGS.camHeight, 0)
          .addScaledVector(right, SETTINGS.camShoulder);
        const back = new THREE.Vector3(-Math.sin(candidate), 0, -Math.cos(candidate));
        if (!G.world.raycast(anchor, back, 6)) yaw = candidate;
      }
      out.feel.openSightline = yaw !== null;
      if (yaw === null) yaw = 0;
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

      clearFeel();
      bootAt(yaw);
      for (let i = 0; i < 45; i++) G.updateCamera(1 / 60);   // let the rig settle
      const restDistance = G.camera.getWorldPosition(new THREE.Vector3())
        .distanceTo(p.object.position);
      const restUp = upAt();

      // A car lands dead ahead: the eye is shoved back and the frame rolls away.
      clearFeel();
      parkCar(fwd.x * 2.2, fwd.z * 2.2);
      bootAt(yaw);
      G.shake = 0;                    // the rattle is random; measure the shove
      G.updateCamera(1 / 60);
      const pushed = G.camera.getWorldPosition(new THREE.Vector3())
        .distanceTo(p.object.position);
      out.feel.cameraPushBack = +(pushed - restDistance).toFixed(3);
      out.feel.frameRollDegrees = +((restUp.angleTo(upAt()) * 180) / Math.PI).toFixed(2);

      // The roll leans away from the impact, so a car off to the left must not
      // tilt the frame the same way as one dead ahead.
      clearFeel();
      const off = fwd.clone().multiplyScalar(2).addScaledVector(right, -0.9);
      parkCar(off.x, off.z);
      bootAt(yaw);
      out.feel.carLeftRoll = +G.kickRoll.toFixed(2);
      out.feel.rollFollowsSide = out.feel.carLeftRoll < 0 && out.feel.carRoll > 0;

      // The hit-stop is paid back by the frame clock, and it dilates the world
      // without touching `step` — which is what keeps this harness's own timings
      // honest, since the campaign drives step() directly and never sees a freeze.
      clearFeel();
      G.kickImpact(SETTINGS.bodyMass, 1);
      out.feel.hitStopFromBody = +G.hitStop.toFixed(3);
      const frame = 1 / 60;
      const frozen = G.frameTime(frame);
      out.feel.worldTimeDuringStop = +frozen.toFixed(5);
      out.feel.stopScale = +(frozen / frame).toFixed(3);
      let stopFrames = 0;
      while (G.hitStop > 0 && stopFrames < 120) { G.frameTime(frame); stopFrames += 1; }
      out.feel.stopFrames = stopFrames;
      out.feel.worldTimeAfterStop = +G.frameTime(frame).toFixed(5);

      // And the screen edges light up with it — the HUD's own frame, read back off
      // the DOM rather than off the timer behind it.
      clearFeel();
      G.kickImpact(SETTINGS.kickFlashMass, 1);
      G.hud.update(G.hudState(), frame);
      const edge = document.getElementById('impact-edge');
      out.feel.edgeFlashOpacity = +((edge && parseFloat(edge.style.opacity)) || 0).toFixed(3);
      if (edge) { G.hud.flashImpact(0); G.hud.update(G.hudState(), 1); }

      const f = out.feel;
      f.bodyMass = SETTINGS.bodyMass;
      f.whiffShake = SETTINGS.kickWhiffShake;
      f.feelScaledByMass = f.car.shake > f.body.shake
        && f.car.kickback > f.body.kickback
        && f.car.hitStop > f.body.hitStop
        && Math.abs(f.car.roll) > Math.abs(f.body.roll);

      out.pass = out.selection.crouched === 'sweep'
        && out.selection.airborne === 'high'
        && out.selection.standingStandardBoot === 'kick'
        && out.selection.standingTopBoot === 'stomp'
        && out.profilesDiffer
        && out.scenery.speedAfterKick > 1
        && out.scenery.movedMeters > 1
        && out.scenery.tumbled
        && out.scenery.settled
        && out.scenery.settleSeconds < 12
        && out.scenery.boxFollowed > 0.5
        && f.whiff.shake > 0
        && f.whiff.kickback === 0 && f.whiff.roll === 0 && f.whiff.hitStop === 0
        && f.body.shake > 0 && f.body.kickback > 0 && f.body.hitStop > 0 && f.body.roll !== 0
        && f.feelScaledByMass
        && f.carRoll > 0 && f.rollFollowsSide
        && f.openSightline
        && f.cameraPushBack > 0.02
        && f.frameRollDegrees > 1
        && f.hitStopFromBody > 0
        && f.stopScale === SETTINGS.kickStopScale
        && f.stopFrames >= 2 && f.stopFrames <= 12
        && Math.abs(f.worldTimeAfterStop - frame) < 1e-5
        && f.edgeFlashOpacity > 0.5;
      return out;
    } finally {
      G.step = savedStep;
      G.enemyManager.enemies = savedEnemies;
      p.crouching = before.crouching;
      p.grounded = before.grounded;
      p.bootIndex = before.bootIndex;
      p.kickCooldown = before.cooldown;
      p.pendingKick = before.pendingKick;
      p.charge = before.charge;
      p.object.position.copy(before.position);
      p.yaw = before.yaw;
      G.cameraYaw = before.cameraYaw;
      G.cameraPitch = before.cameraPitch;
      G.shake = before.shake;
      G.kickback = before.kickback;
      G.kickRoll = before.kickRoll;
      G.hitStop = before.hitStop;
    }
  }

  // ---------------------------------------------------- the dry officer's wave
  /**
   * A dry officer must still be able to finish a wave. With no ammunition
   * anywhere the rifle is decoration and the boot is the whole arsenal, so the
   * pilot has to close and use it. The failure this guards is the one the pilot
   * produced itself: holding a firing line at an unwounded attacker, at range,
   * with nothing to fire, until the stall watchdog gave up and the wave could not
   * end at all. The report said so at the time — `playerAmmo: [0, 0]` beside an
   * attacker at full health, distance not closing.
   *
   * Played for real: the same patched step, the same pilot and the same wave one
   * that `npm test` plays, with the officer's rounds taken away every single
   * frame so nothing it kills can resupply it and the whole wave has to be won
   * with the boot. The officer is kept on their feet, as the campaign does for
   * pacing, because the claim being checked is that the wave can end — not that a
   * dry officer survives being shot at while it happens.
   */
  function probeDryWave() {
    const p = G.player;
    const out = { limitSeconds: 60, pass: false };
    const startKills = p.kills;
    const startBoots = p.meleeKills;
    const saved = {
      maxHealth: p.maxHealth, health: p.health, ammo: p.ammo, reserve: p.reserve,
    };
    const limitFrames = Math.round(out.limitSeconds / FRAME);
    let frames = 0;
    let closedIn = null;

    try {
      p.maxHealth = INSTRUMENT_MAX_HEALTH;
      p.health = INSTRUMENT_MAX_HEALTH;
      p.alive = true;

      while (G.state === 'playing' && frames < limitFrames) {
        // Nothing to shoot with and nothing to pick up: this wave is the boot's.
        p.ammo = 0;
        p.reserve = 0;
        G.step(FRAME);
        frames += 1;
        const live = G.enemyManager.enemies.find((e) => e && !e.dead && !e.routed);
        // Closing to boot range is the move that never happened while the
        // deadlock was in: the old pilot held a firing line at nine metres and
        // waited there for ammunition that was never coming.
        if (live && closedIn === null && p.position.distanceTo(live.position) <= 8) {
          closedIn = +(frames * FRAME).toFixed(1);
        }
        if (G.enemyManager.aliveCount === 0 && G.enemyManager.pendingCount === 0) break;
      }
    } finally {
      for (const key of Object.keys(saved)) p[key] = saved[key];
    }

    out.seconds = +(frames * FRAME).toFixed(1);
    out.cleared = G.enemyManager.aliveCount === 0 && G.enemyManager.pendingCount === 0;
    out.eliminations = p.kills - startKills;
    out.bootEliminations = p.meleeKills - startBoots;
    out.closedToBootRangeSeconds = closedIn;
    out.leftover = G.enemyManager.enemies
      .filter((e) => e && !e.dead && !e.routed)
      .map((e) => ({
        distance: +p.position.distanceTo(e.position).toFixed(1),
        health: +e.health.toFixed(0),
        inAssault: G.enemyManager.assaults.includes(e),
      }));
    // Every attacker the officer removed, it removed with the boot: with no
    // rounds in the magazine and none in the reserve there was nothing else.
    out.pass = out.cleared
      && out.eliminations > 0
      && out.bootEliminations === out.eliminations
      && closedIn !== null;
    return out;
  }

  // ------------------------------------------------------------- forest fairness
  // What a forest has to have before a wave can be fought in it. These are round
  // numbers with room under every layout the generator actually produces (the
  // measured spread is in test/campaign-forest.json): they are here to catch a
  // forest that is *broken*, not to grade one that is merely tight.
  const FOREST_LIMITS = {
    bandReachMin: 0.9,        // of the open ground in the 26-38 m attacker spawn ring
    clearingOpenMin: 0.6,     // of the clearing, standable and connected
    reachableAreaMin: 6000,   // m² of ground the officer and attackers can both reach
    // The fighting ground is the ring from the edge of the clearing out to the far
    // side of the spawn ring, and this is the mean clear space a point out there
    // has, in metres. Under it, attackers — who only ever steer straight at the
    // officer and slide along what they hit — spend the wave wedged against trunks
    // instead of closing. The widest circle anywhere is no use for this: the
    // clearing is empty by construction, so it always holds one.
    fieldRoomMin: 1.5,
    // Ground the size of a hiding place that is walled off is ground an attacker
    // can be spawned into and never walk out of, so nothing this big may be cut
    // off at all. (The forests the generator actually makes have none.)
    pocketArea: 9,            // m²
  };

  /**
   * Whether a wave can be fought at all in this forest.
   *
   * The fuzz can name the seed when a wave stalls, but a stall has two possible
   * authors: the pilot ran out of ideas, or the terrain never allowed the fight in
   * the first place. This measures the terrain half, on the collision geometry the
   * game itself moves and shoots against — the trunks in `world.cylinders` and the
   * crates, barriers, rocks and cars in `world.boxes` — with no randomness of its
   * own, so one forest always gets one answer.
   *
   * The question is whether the ground an officer and an attacker could both stand
   * on is *connected*. Attackers appear in a ring 26-38 m out and from then on only
   * steer at the officer, sliding along whatever they bump into (see
   * Enemy.update), so a spawn point walled off by trunks and crates is an attacker
   * that can never arrive — a wave that cannot end however well it is played. That
   * is the hostile seed, and it is exactly what a stall report cannot tell apart
   * from a slow pilot.
   *
   * Everything is sampled on a grid of `cell` metres. A cell counts as standable
   * only if a body of `body` radius fits clear of every blocker, using the radii
   * actors are really pushed out with (the officer is 0.55, attackers 0.5; the
   * officer's is used, since the officer has to close for the boot either way).
   */
  function auditForest(world, { cell = 0.25, body = 0.55 } = {}) {
    const half = SETTINGS.worldSize / 2 - 6;   // the band findSpawn() will place anyone in
    const n = Math.ceil((half * 2) / cell);
    const at = (i) => -half + (i + 0.5) * cell;
    const firstCell = (v) => Math.ceil((v + half) / cell - 0.5);
    const lastCell = (v) => Math.floor((v + half) / cell - 0.5);
    const clampCell = (i) => Math.min(n - 1, Math.max(0, i));
    const DIAG = cell * Math.SQRT2;

    /**
     * The cells a standing body cannot occupy. `props: false` leaves the crates,
     * barriers, rocks and cars out, so a pocket can be blamed on the right thing:
     * trunks are permanent, props at least move when they are kicked.
     */
    const rasterise = ({ props = true } = {}) => {
      const blocked = new Uint8Array(n * n);
      for (const c of world.cylinders) {
        const pad = c.r + body;
        const i0 = Math.max(0, Math.floor((c.x - pad + half) / cell));
        const i1 = Math.min(n - 1, Math.ceil((c.x + pad + half) / cell));
        const j0 = Math.max(0, Math.floor((c.z - pad + half) / cell));
        const j1 = Math.min(n - 1, Math.ceil((c.z + pad + half) / cell));
        for (let j = j0; j <= j1; j++) {
          const dz = at(j) - c.z;
          for (let i = i0; i <= i1; i++) {
            const dx = at(i) - c.x;
            if (dx * dx + dz * dz < pad * pad) blocked[j * n + i] = 1;
          }
        }
      }
      if (props) {
        // Movement is stopped by every box whatever its height —
        // World.resolveCircle() never looks at one — so a rock is as impassable
        // as a car here, and the box is the thing to map.
        for (const box of world.boxes) {
          const i0 = Math.max(0, firstCell(box.min.x - body));
          const i1 = Math.min(n - 1, lastCell(box.max.x + body));
          const j0 = Math.max(0, firstCell(box.min.z - body));
          const j1 = Math.min(n - 1, lastCell(box.max.z + body));
          if (i0 > i1 || j0 > j1) continue;
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * n + i] = 1;
        }
      }
      // The edge of the mapped band counts as wall, so clearance is finite
      // everywhere and a forest is never called open just because the grid stops.
      for (let i = 0; i < n; i++) {
        blocked[i] = 1; blocked[(n - 1) * n + i] = 1;
        blocked[i * n] = 1; blocked[i * n + n - 1] = 1;
      }
      return blocked;
    };

    /** Everything one set of blockers can be asked about. */
    const measure = (blocked) => {
      // Clearance: the distance to the nearest blocker, for every cell, by the
      // usual two-pass 3×3 chamfer. Its maximum over reachable ground is the
      // radius of the widest circle a firefight could happen in.
      const dist = new Float32Array(n * n);
      for (let b = 0; b < blocked.length; b++) dist[b] = blocked[b] ? 0 : Infinity;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const b = j * n + i;
          if (dist[b] === 0) continue;
          let d = dist[b];
          if (i > 0) d = Math.min(d, dist[b - 1] + cell);
          if (j > 0) d = Math.min(d, dist[b - n] + cell);
          if (i > 0 && j > 0) d = Math.min(d, dist[b - n - 1] + DIAG);
          if (i < n - 1 && j > 0) d = Math.min(d, dist[b - n + 1] + DIAG);
          dist[b] = d;
        }
      }
      for (let j = n - 1; j >= 0; j--) {
        for (let i = n - 1; i >= 0; i--) {
          const b = j * n + i;
          if (dist[b] === 0) continue;
          let d = dist[b];
          if (i < n - 1) d = Math.min(d, dist[b + 1] + cell);
          if (j < n - 1) d = Math.min(d, dist[b + n] + cell);
          if (i < n - 1 && j < n - 1) d = Math.min(d, dist[b + n + 1] + DIAG);
          if (i > 0 && j < n - 1) d = Math.min(d, dist[b + n - 1] + DIAG);
          dist[b] = d;
        }
      }

      // Connectivity: what the officer's own spawn point can walk to.
      const reach = new Uint8Array(n * n);
      const queue = new Int32Array(n * n);
      const mid = clampCell(Math.floor(half / cell));     // the cell holding (0, 0)
      const origin = mid * n + mid;
      let head = 0, tail = 0, reachableCells = 0;
      if (!blocked[origin]) {
        reach[origin] = 1; queue[tail++] = origin; reachableCells = 1;
        while (head < tail) {
          const cur = queue[head++];
          const j = (cur / n) | 0;
          const i = cur - j * n;
          const jEnd = Math.min(n - 1, j + 1);
          const iEnd = Math.min(n - 1, i + 1);
          for (let jj = Math.max(0, j - 1); jj <= jEnd; jj++) {
            for (let ii = Math.max(0, i - 1); ii <= iEnd; ii++) {
              const nb = jj * n + ii;
              if (blocked[nb] || reach[nb]) continue;
              reach[nb] = 1; queue[tail++] = nb; reachableCells++;
            }
          }
        }
      }

      let clearingCells = 0, clearingReach = 0;
      let bandCells = 0, bandReach = 0, bandPockets = 0;
      let fieldCells = 0, fieldReach = 0, fieldSum = 0, openRadius = 0;
      const clearingRadius = SETTINGS.clearingRadius;
      const fieldOuter = SETTINGS.spawnMaxRadius;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const b = j * n + i;
          const r = Math.hypot(at(i), at(j));
          if (r <= clearingRadius) {
            clearingCells++;
            if (reach[b]) clearingReach++;
          }
          if (r >= SETTINGS.spawnMinRadius && r <= fieldOuter) {
            if (blocked[b]) continue;
            bandCells++;
            if (reach[b]) bandReach++; else bandPockets++;
          }
          if (r > clearingRadius && r <= fieldOuter) {
            fieldCells++;
            if (reach[b]) {
              fieldReach++;
              fieldSum += dist[b];
              if (dist[b] > openRadius) openRadius = dist[b];
            }
          }
        }
      }

      // Pockets: standable ground sealed off from the officer. Small ones are
      // crannies behind a single crate; anything the size of a firefight is a
      // place an attacker can be spawned and never leave.
      const seen = new Uint8Array(n * n);
      const pockets = { count: 0, largestArea: 0, nearest: null, sealedArea: 0 };
      for (let start = 0; start < blocked.length; start++) {
        if (blocked[start] || reach[start] || seen[start]) continue;
        head = 0; tail = 0;
        queue[tail++] = start; seen[start] = 1;
        let size = 0, nearest = Infinity;
        while (head < tail) {
          const cur = queue[head++];
          const j = (cur / n) | 0;
          const i = cur - j * n;
          size++;
          const d = Math.hypot(at(i), at(j));
          if (d < nearest) nearest = d;
          const jEnd = Math.min(n - 1, j + 1);
          const iEnd = Math.min(n - 1, i + 1);
          for (let jj = Math.max(0, j - 1); jj <= jEnd; jj++) {
            for (let ii = Math.max(0, i - 1); ii <= iEnd; ii++) {
              const nb = jj * n + ii;
              if (blocked[nb] || reach[nb] || seen[nb]) continue;
              seen[nb] = 1; queue[tail++] = nb;
            }
          }
        }
        const area = size * cell * cell;
        pockets.sealedArea += area;
        if (area < FOREST_LIMITS.pocketArea) continue;
        pockets.count++;
        if (area > pockets.largestArea) { pockets.largestArea = area; pockets.nearest = nearest; }
      }

      return {
        originBlocked: Boolean(blocked[origin]),
        reachableArea: +(reachableCells * cell * cell).toFixed(1),
        openRadius: +openRadius.toFixed(2),
        fieldRoom: fieldReach ? +(fieldSum / fieldReach).toFixed(2) : 0,
        fieldReachFraction: fieldCells ? +(fieldReach / fieldCells).toFixed(3) : 0,
        clearingArea: +(clearingCells * cell * cell).toFixed(1),
        clearingOpenFraction: clearingCells ? +(clearingReach / clearingCells).toFixed(3) : 0,
        bandCells,
        bandReachFraction: bandCells ? +(bandReach / bandCells).toFixed(3) : 0,
        bandPocketFraction: bandCells ? +(bandPockets / bandCells).toFixed(3) : 0,
        pockets,
      };
    };

    const all = measure(rasterise({ props: true }));
    const trunks = measure(rasterise({ props: false }));
    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    const reasons = [];

    if (all.originBlocked) reasons.push("the officer's own spawn point is inside a blocker");
    if (all.bandCells === 0) {
      reasons.push('there is no open ground at all in the attacker spawn ring');
    } else if (all.bandReachFraction < FOREST_LIMITS.bandReachMin) {
      reasons.push(`${pct(1 - all.bandReachFraction)} of the open attacker spawn ring cannot reach the clearing`);
    }
    if (all.pockets.count > 0) {
      const treesOnly = trunks.pockets.count > 0;
      reasons.push(`${all.pockets.count} pocket(s) of open ground are sealed off from the officer, `
        + `the largest ${Math.round(all.pockets.largestArea)} m², nearest ${all.pockets.nearest.toFixed(0)} m out`
        + (treesOnly
          ? ' — trunks alone seal it, so no kick can open the way in'
          : ' (crates, barriers and cars, which at least move when they are kicked)'));
    }
    if (all.clearingOpenFraction < FOREST_LIMITS.clearingOpenMin) {
      reasons.push(`only ${pct(all.clearingOpenFraction)} of the clearing is standable and connected`);
    }
    if (all.fieldRoom < FOREST_LIMITS.fieldRoomMin) {
      reasons.push(`the fighting ground is cramped: a point between the clearing and the spawn ring has only ${all.fieldRoom} m of clear space around it on average, so attackers get wedged instead of closing`);
    }
    if (all.reachableArea < FOREST_LIMITS.reachableAreaMin) {
      reasons.push(`only ${Math.round(all.reachableArea)} m² of connected ground to fight over`);
    }

    return {
      pass: reasons.length === 0,
      reasons,
      ...all,
      trees: world.cylinders.length,
      props: world.props.length,
      // How big the worst pocket is if props are ignored: a pocket that survives
      // without the crates is the one no amount of kicking can open.
      trunksOnly: { pockets: trunks.pockets, reachableArea: trunks.reachableArea, bandReachFraction: trunks.bandReachFraction },
    };
  }

  /**
   * What the audit can be falsified with: two forests the answer is known for.
   * A ring of trunks that seals the clearing must be called unfair, and an empty
   * field must be called fair — otherwise a forest audit that always passes is
   * just a number that looks like a check.
   */
  function forestAuditControl() {
    const field = new (G.world.constructor)(new THREE.Scene(), 1);
    const open = auditForest(field);
    // A wall of trunks at 20 m, well outside the clearing the generator keeps and
    // far enough inside the spawn ring that nothing can walk past it.
    for (let a = 0; a < 360; a += 6) {
      const rad = (a * Math.PI) / 180;
      field.addCylinder(Math.cos(rad) * 20, Math.sin(rad) * 20, 3, 9);
    }
    const sealed = auditForest(field);
    return {
      openFair: open.pass,
      sealedUnfair: !sealed.pass,
      sealedReasons: sealed.reasons,
      pass: open.pass && !sealed.pass,
    };
  }

  /**
   * Rebuild forests from a list of seeds and audit each one. This runs the same
   * generation code the page runs at load, in the same order, so the trees,
   * crates and cars come out of the same stream and are the real thing — but the
   * scanned landscape, the sky and the cubemap are left out (they contribute no
   * collision), which is what makes a dozen forests affordable in one page. The
   * seed the page is already playing is always audited first, and the layout it
   * rebuilds to must hash to the layout the page is playing: otherwise the sweep
   * is auditing forests nobody fights in, and everything below it is worthless.
   */
  async function probeForestSweep(seeds) {
    const { createWorld } = await import('./js/world.js');
    const { LANDSCAPE } = await import('./js/config.js');
    const live = { seed: G.world.seed, layoutHash: G.world.layoutHash };
    const list = [live.seed, ...seeds.filter((s) => s !== live.seed)];
    const savedLandscape = LANDSCAPE.enabled;
    const out = {
      cell: 0.25,
      // The floors that were in force, so a recorded baseline can say whether the
      // yardstick itself moved as well as the forests it was pointed at.
      limits: { ...FOREST_LIMITS },
      playedSeed: live.seed,
      playedLayoutHash: live.layoutHash,
      matchesPlayed: false,
      control: forestAuditControl(),
      seeds: [],
    };

    LANDSCAPE.enabled = false;      // layout only: no scanned dome, no cubemap
    try {
      for (const seed of list) {
        const scene = new THREE.Scene();
        const built = await createWorld(scene, null, { seed });
        out.seeds.push(Object.assign({ seed, layoutHash: built.world.layoutHash }, auditForest(built.world)));
        scene.clear();
      }
    } finally {
      LANDSCAPE.enabled = savedLandscape;
    }

    const played = out.seeds.find((s) => s.seed === live.seed);
    out.matchesPlayed = Boolean(played && played.layoutHash === live.layoutHash);
    out.pass = out.matchesPlayed && out.control.pass && out.seeds.every((s) => s.pass);
    return out;
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
    // Which forest this run was played in, so a fuzz seed can be replayed: the
    // world seed rebuilds the layout, the hash says it is the one that failed.
    worldSeed: G.world ? G.world.seed : null,
    layoutHash: G.world ? G.world.layoutHash : null,
    // Whether this forest can be fought in at all, measured before a shot is
    // fired: the props are still where the generator put them and nothing the
    // pilot does can change the answer.
    forest: G.world ? auditForest(G.world) : null,
    healthAtEnd: null,
    damageTaken: 0,
    instrumented,
    outcome: null,
    errors,
  };

  let wave = { n: null, startS: 0, hostiles: 0, kills: 0, damage: 0 };
  let lastTier = null;
  let lastBanner = null;
  let stallSeconds = 0;
  let lastKillCount = 0;
  let stalledWave = null;
  const stallSamples = [];
  let triggerFrames = 0;
  let lastTriggerSample = 0;

  const beginWave = (n, atS) => {
    wave = {
      n,
      startS: +atS.toFixed(2),
      hostiles: G.enemyManager.aliveCount + G.enemyManager.queue.length,
      kills: 0,
      damage: 0,
      longestGap: 0,
    };
  };

  const originalStep = G.step.bind(G);
  G.step = function harnessStep(dt) {
    pilot();
    const beforeKills = G.player.kills;
    const beforeLoot = G.effects.pickups.length;
    const beforeHealth = G.player.health;

    originalStep(dt);

    // Incoming damage is the honest measure of how hard a wave presses, even
    // when the officer is being kept on their feet.
    const lost = Math.max(0, beforeHealth - G.player.health);
    if (lost > 0) { report.damageTaken += lost; wave.damage += lost; }
    // A health pool far above any single hit, rather than a top-up after the
    // fact: one killing blow would otherwise end the run before the harness
    // could heal it, and the last waves are exactly what needs measuring.
    if (instrumented) G.player.health = G.player.maxHealth;

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
    report.healthAtEnd = instrumented ? null : +G.player.health.toFixed(0);

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
          damageTaken: +wave.damage.toFixed(1),
          damagePerSecond: +(wave.damage / Math.max(0.001, t - wave.startS)).toFixed(2),
          longestGapSeconds: +Math.max(wave.longestGap, stallSeconds).toFixed(1),
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
    if (G.player.kills !== lastKillCount) {
      lastKillCount = G.player.kills;
      // A wave can also drag without ever tripping the stall timer, by killing
      // one attacker every couple of minutes; the longest quiet stretch is the
      // number that says whether a wave actually sagged.
      if (stallSeconds > wave.longestGap) wave.longestGap = stallSeconds;
      stallSeconds = 0;
      stallSamples.length = 0;
    } else {
      stallSeconds += dt;
    }

    // While nothing is dying, sample whether the pilot is actually engaging:
    // "the last attacker will not die" needs to say whether shots are being
    // taken and whether the aim is on them, not just where everyone is standing.
    if (stallSeconds > 4 && frame % 90 === 0 && stallSamples.length < 8) {
      const only = G.enemyManager.enemies.find((e) => e && !e.dead && !e.routed);
      stallSamples.push({
        atSeconds: +t.toFixed(1),
        distance: only ? +G.player.position.distanceTo(only.position).toFixed(1) : null,
        enemyHealth: only ? +only.health.toFixed(0) : null,
        lockEngaged: Boolean(G.lock),
        reticleOnAttacker: G.isAttackerUnderReticle(),
        aimErrorRadians: only ? +(G.lockAngleTo(only) ?? -1).toFixed(3) : null,
        cameraYaw: +G.cameraYaw.toFixed(3),
        bearingToAttacker: only ? +Math.atan2(only.position.x - G.camera.position.x, only.position.z - G.camera.position.z).toFixed(3) : null,
        targetingHeld: G.inputManager.targeting,
        triggerHeld: pad.buttons[7].pressed,
        // A pilot with the trigger down on a live target and no ammunition is
        // the one way this can be silent: say so in the sample rather than
        // leaving "the last attacker will not die" open to interpretation.
        ammo: G.player.ammo,
        reserve: G.player.reserve,
        reloading: G.player.reloading > 0,
        triggerFramesSinceLastSample: triggerFrames - lastTriggerSample,
        playerHealth: +G.player.health.toFixed(0),
        playerPosition: [+G.player.position.x.toFixed(1), +G.player.position.z.toFixed(1)],
        enemyPosition: only ? [+only.position.x.toFixed(1), +only.position.z.toFixed(1)] : null,
        enemyMoving: only ? Boolean(only.moving) : null,
        enemyStuckSeconds: only ? +only.stuckTime.toFixed(1) : null,
        enemyDetourSeconds: only ? +only.detourTimer.toFixed(1) : null,
        enemyInAssault: only ? G.enemyManager.assaults.includes(only) : null,
      });
      lastTriggerSample = triggerFrames;
    }
    if (pad.buttons[7].pressed) triggerFrames += 1;
    if (stallSeconds > opts.waveLimitSeconds && stalledWave === null) {
      // Snapshot whoever is left, so the report says why the wave cannot end
      // rather than only that it did not.
      const leftovers = G.enemyManager.enemies
        .filter((e) => e && !e.dead && !e.routed)
        .map((e) => ({
          distance: +G.player.position.distanceTo(e.position).toFixed(1),
          position: [+e.position.x.toFixed(1), +e.position.z.toFixed(1)],
          health: +e.health.toFixed(0),
          bleeding: Boolean(e.bleeding),
          inCover: Boolean(e.coverPoint),
          detouring: e.detourTimer > 0,
          inAssault: G.enemyManager.assaults.includes(e),
          lineOfSightToPlayer: G.world.hasLineOfSight(e.headPosition, G.player.headPosition),
        }));
      stalledWave = {
        wave: G.wave,
        stalledFor: +stallSeconds.toFixed(1),
        hostiles: G.enemyManager.aliveCount + G.enemyManager.queue.length,
        flushing: G.enemyManager.flushing,
        playerAmmo: [G.player.ammo, G.player.reserve],
        playerPosition: [+G.player.position.x.toFixed(1), +G.player.position.z.toFixed(1)],
        leftovers,
        samples: stallSamples,
      };
    }
  };

  // ------------------------------------------------------ the character asset
  /**
   * The officer's mesh file, audited for the three things one bad re-export of
   * him breaks at once: vertices the skin never weights, geometry welded to a
   * bone it does not sit on, and an own boot the tier system can no longer
   * replace.
   *
   * Joining the big boot into the body mesh does all three. The exporter ships
   * the boot's 50-odd thousand vertices unweighted; three.js rescues an
   * unweighted vertex by binding it to bone 0, which here is `mixamorigHips`, so
   * the whole boot rides his pelvis; and because the boot is no longer a separate
   * part, `bindRigidParts()` finds nothing to register as `ownBoots`, so a tier's
   * boot is worn on top of it rather than replacing it. None of that shows in the
   * campaign's own numbers — it plays fine and simply looks wrong — so the asset
   * gets its own probe.
   */
  async function probeCharacter() {
    const p = G.player;
    const out = { meshes: [], ownBoots: [], pass: false };
    // How far a vertex may sit from the only bone that moves it. The officer's own
    // boot rides ~0.4 m off the ankle bone and his head gear sits on his skull; a
    // boot welded to the hips lands 0.6-1.0 m away, which is the failure named here.
    const WRONG_BONE_DISTANCE = 0.6;
    // The share of a mesh allowed to sit that far off. Blended vertices follow
    // several bones and are exempt by construction, so this only ever counts
    // rigidly-bound geometry — and a joined boot is two thirds of the mesh.
    const WELD_SHARE_LIMIT = 0.02;
    const SAMPLES = 4000;

    /** Weight, influences and the distance to the one bone that moves a vertex. */
    const auditMesh = (mesh) => {
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const sw = geo.attributes.skinWeight;
      const si = geo.attributes.skinIndex;
      if (!sw || !si) return null;
      mesh.skeleton.update();
      const bm = mesh.bindMatrix.elements;
      const bmi = mesh.bindMatrixInverse.elements;
      const bjs = mesh.skeleton.boneMatrices;
      const mw = mesh.matrixWorld.elements;
      const mul = (e, v) => [
        e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12] * v[3],
        e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13] * v[3],
        e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14] * v[3],
        e[3] * v[0] + e[7] * v[1] + e[11] * v[2] + e[15] * v[3],
      ];
      const at = new THREE.Vector3();
      const stride = Math.max(1, Math.floor(pos.count / SAMPLES));
      let unweighted = 0;
      let single = 0;
      let far = 0;
      let worst = 0;
      let worstBone = null;

      for (let v = 0; v < pos.count; v += stride) {
        const w = [sw.getX(v), sw.getY(v), sw.getZ(v), sw.getW(v)];
        if (w[0] + w[1] + w[2] + w[3] <= 1e-6) { unweighted += 1; continue; }
        // The slot a weight sits in is not the bone it names: skinIndex holds the
        // bone, and only that indexes the skeleton and its matrices.
        const slot = w.findIndex((x) => x > 1e-4);
        if (w[slot] < 0.999) continue;           // a blended vertex follows several bones
        if (w.filter((x) => x > 1e-4).length !== 1) continue;
        const boneIndex = si.getComponent(v, slot);
        const bone = mesh.skeleton.bones[boneIndex];
        if (!bone) continue;
        single += 1;
        // With one influence at full weight the vertex moves exactly with that
        // bone, so the distance between them is the same in every pose and no
        // bind pose has to be reconstructed to measure it.
        const bind = mul(bm, [pos.getX(v), pos.getY(v), pos.getZ(v), 1]);
        const e = bjs.subarray(boneIndex * 16, boneIndex * 16 + 16);
        const world = mul(mw, mul(bmi, mul(e, bind)));
        bone.getWorldPosition(at);
        const d = Math.hypot(world[0] - at.x, world[1] - at.y, world[2] - at.z);
        if (d > WRONG_BONE_DISTANCE) far += 1;
        if (d > worst) { worst = d; worstBone = bone.name; }
      }
      return {
        sampled: Math.ceil(pos.count / stride),
        unweighted,
        single,
        far,
        farShare: +(far / Math.max(1, single)).toFixed(4),
        worst: +worst.toFixed(3),
        worstBone,
      };
    };

    p.model.updateMatrixWorld(true);
    p.model.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const seen = auditMesh(o);
      if (!seen) return;
      out.meshes.push({
        name: o.name,
        verts: o.geometry.attributes.position.count,
        ...seen,
      });
    });
    out.unweightedTotal = out.meshes.reduce((n, m) => n + m.unweighted, 0);
    // The mesh that is worst welded is the one to name, and it is named by its
    // bone as well as its share, so a report says what is riding what.
    const worstMesh = out.meshes.reduce(
      (best, m) => (best === null || m.farShare > best.farShare ? m : best),
      null,
    );
    out.weldMesh = worstMesh ? worstMesh.name : null;
    out.weldShare = worstMesh ? worstMesh.farShare : 0;
    out.weldBone = worstMesh ? worstMesh.worstBone : null;
    out.weldDistance = worstMesh ? worstMesh.worst : 0;

    const ownMeshes = p.ownBoots || [];
    out.ownBoots = ownMeshes.map((m) => {
      const b = new THREE.Box3().setFromObject(m);
      const part = (p.rigidParts || []).find((r) => r.mesh === m);
      return {
        mesh: m.name,
        bone: part ? part.bone : null,
        bottom: +b.min.y.toFixed(3),
        size: [(b.max.x - b.min.x), (b.max.y - b.min.y), (b.max.z - b.min.z)]
          .map((n) => +n.toFixed(3)),
      };
    });
    out.ownBootCount = out.ownBoots.length;
    out.ownBootsOnTheGround = out.ownBootCount > 0
      && out.ownBoots.every((b) => b.bottom < 0.25);

    // Every loose part the game bound to the rig, and where each one ended up. The
    // game binds a part to whichever bone is nearest, so a part that sits on the
    // ground is a boot and a boot on anything but a foot is a boot no tier will
    // replace — the second way a re-export breaks him, and the one the own-boot
    // clauses above cannot see on their own.
    out.parts = (p.rigidParts || []).map((part) => {
      const b = new THREE.Box3().setFromObject(part.mesh);
      return {
        mesh: part.mesh.name,
        bone: part.bone,
        metres: +part.metres.toFixed(3),
        bottom: +b.min.y.toFixed(3),
        onFoot: /toe|foot|ankle/i.test(part.bone || ''),
        atTheGround: b.min.y < 0.25,
      };
    });
    out.misboundParts = out.parts.filter((part) => part.atTheGround && !part.onFoot);
    out.noMisboundParts = out.misboundParts.length === 0;

    // The tier's own boot has to be able to take the officer's place: it is
    // socketed onto the right-foot bone and the officer's boot goes away. A boot
    // that was joined into the body is not registered, so nothing hides and the
    // two are worn at once.
    const saved = {
      credit: p.tierCredit,
      index: p.bootIndex,
      bootModel: p.bootModel,
      loaded: p.loadedBootModel,
      visible: ownMeshes.map((m) => m.visible),
    };
    const tierIndex = BOOT_TIERS.findIndex((t) => t.model);
    out.tier = tierIndex >= 0 ? BOOT_TIERS[tierIndex].name : null;
    try {
      if (tierIndex >= 0) {
        p.tierCredit = Math.max(p.tierCredit, BOOT_TIERS[tierIndex].kills);
        p.bootIndex = -1;                       // force the tier to move
        p.refreshBootTier();
        for (let i = 0; i < 60 && !p.bootModel; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        out.tierBootSocketed = Boolean(p.bootModel);
        out.ownBootsHidden = ownMeshes.every((m) => !m.visible);
      }
    } finally {
      if (p.bootModel && p.bootModel.parent) p.bootModel.parent.remove(p.bootModel);
      p.tierCredit = saved.credit;
      p.bootIndex = saved.index;
      p.bootModel = saved.bootModel;
      p.loadedBootModel = saved.loaded;
      ownMeshes.forEach((m, i) => { m.visible = saved.visible[i]; });
    }

    // The control, and it is the same measurement the audit itself makes: an
    // unweighted vertex is bound to bone 0, and bone 0 of this rig is the hips, so
    // a joined boot ends up sitting exactly where its own vertices measure against
    // the hips. Take the officer's real boot, ask that question of its real
    // vertices, and the share that would land beyond the distance limit has to
    // beat the weld budget — otherwise the audit is too loose to name the defect
    // it exists for and a pass would be worth nothing.
    let hips = null;
    p.model.traverse((o) => { if (!hips && o.isBone && /hips/i.test(o.name)) hips = o; });
    if (hips && ownMeshes.length) {
      const boot = ownMeshes[0];
      boot.updateMatrixWorld(true);
      const pos = boot.geometry.attributes.position;
      const at = hips.getWorldPosition(new THREE.Vector3());
      const v = new THREE.Vector3();
      const step = Math.max(1, Math.floor(pos.count / 2000));
      let beyond = 0;
      let count = 0;
      for (let i = 0; i < pos.count; i += step) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(boot.matrixWorld);
        if (v.distanceTo(at) > WRONG_BONE_DISTANCE) beyond += 1;
        count += 1;
      }
      const share = beyond / Math.max(1, count);
      out.control = {
        measured: true,
        boneZero: hips.name,
        bootSampled: count,
        beyondLimit: beyond,
        beyondLimitShare: +share.toFixed(4),
        distanceLimit: WRONG_BONE_DISTANCE,
        weldShareBudget: WELD_SHARE_LIMIT,
        wouldNameIt: share > WELD_SHARE_LIMIT,
      };
    } else {
      out.control = {
        // No own boot to ask the question of, which is already a failure of its
        // own: the control simply has nothing to measure, and says so.
        measured: false,
        boneZero: hips ? hips.name : null,
        bootSampled: 0,
        beyondLimit: 0,
        beyondLimitShare: 0,
        distanceLimit: WRONG_BONE_DISTANCE,
        weldShareBudget: WELD_SHARE_LIMIT,
        wouldNameIt: false,
      };
    }

    // ------------------------------------------------- the officer's footing
    // A clip can weight every vertex perfectly, sit on the right bone and still
    // put the officer somewhere he is not: the clip files bake the rig's own
    // travel, and they are not all authored in the units — or for the skeleton —
    // that this mesh wears. A walk file written for a rig a hundred times taller
    // throws the whole body metres into the air the moment he moves, and a kick
    // file written for a crouched rig leaves his feet hanging. None of it shows in
    // the campaign's own numbers: the fight plays on, the officer's recorded
    // position never moves, and the only symptom is that the player cannot see
    // him. So every state he can be drawn in gets measured against the ground.
    //
    // The lowest drawn vertex is what is measured, not a bone: a boot's underside
    // is what a player reads as standing, and it can sit a long way from the ankle
    // bone carrying it. Each state is sampled right across its cycle, because a
    // clip's authored first frame is often a pose outside that cycle.
    const GROUND_SINK = -0.15;   // how far below the ground a state may reach
    const GROUND_FLOAT = 0.35;   // and how far above it
    const STATE_SAMPLES = 12;
    const drawn = [];
    p.model.traverse((o) => { if (o.isSkinnedMesh) drawn.push(o); });
    const at = new THREE.Vector3();
    const lowestDrawn = () => {
      p.model.updateMatrixWorld(true);
      let low = Infinity;
      for (const mesh of drawn) {
        const pos = mesh.geometry.attributes.position;
        const step = Math.max(1, Math.floor(pos.count / 400));
        for (let v = 0; v < pos.count; v += step) {
          mesh.getVertexPosition(v, at);
          at.applyMatrix4(mesh.matrixWorld);
          if (at.y < low) low = at.y;
        }
      }
      return low;
    };

    // Each state is posed alone. A crossfade blends two clips into a body neither
    // one draws, and an action left at zero weight writes nothing at all, so the
    // rig would be measured in the pose the last state happened to leave it in —
    // both of which report a height no clip is responsible for.
    const holdOne = (key) => {
      for (const [other, action] of Object.entries(p.anim.actions)) {
        action.stopFading();
        action.enabled = other === key;
        action.setEffectiveWeight(other === key ? 1 : 0);
      }
      const held = p.anim.actions[key];
      held.reset();
      held.setEffectiveWeight(1);
      held.play();
      p.anim.name = key;
      return held.getClip();
    };

    out.states = {};
    for (const key of Object.keys(p.anim.actions)) {
      const clip = holdOne(key);
      let low = Infinity;
      for (let i = 0; i < STATE_SAMPLES; i++) {
        p.anim.mixer.setTime((clip.duration * i) / STATE_SAMPLES);
        const y = lowestDrawn();
        if (y < low) low = y;
      }
      out.states[key] = +low.toFixed(3);
    }
    const floors = Object.values(out.states);
    out.statesMeasured = floors.length;
    out.worstSink = floors.length ? +Math.min(...floors).toFixed(3) : 0;
    out.worstFloat = floors.length ? +Math.max(...floors).toFixed(3) : 0;
    out.stateLimits = { sink: GROUND_SINK, float: GROUND_FLOAT };
    out.statesOnTheGround = floors.length > 0
      && floors.every((y) => y >= GROUND_SINK && y <= GROUND_FLOAT);

    // The control: the measurement has to follow the rig it is looking at. Lifting
    // the officer a metre must raise the floor by a metre. A measurement taken
    // against a pose that is never re-skinned — the trap this clause was written
    // after — returns the same height whatever the body does, and a pass from it
    // would say nothing at all.
    holdOne('idle');
    p.anim.mixer.setTime(0);
    const beforeLift = lowestDrawn();
    const restingY = p.model.position.y;
    p.model.position.y = restingY + 1;
    const liftedBy = lowestDrawn() - beforeLift;
    p.model.position.y = restingY;
    lowestDrawn();
    out.footingControl = {
      liftedBy: +liftedBy.toFixed(3),
      pass: Math.abs(liftedBy - 1) < 0.05,
    };
    // Left as he was found: every action usable again, and the officer standing
    // in his idle, so later probes move him themselves rather than inheriting
    // whichever clip this clause happened to stop on.
    for (const action of Object.values(p.anim.actions)) {
      action.stopFading();
      action.enabled = true;
      action.setEffectiveWeight(0);
    }
    if (p.anim.actions.idle) {
      holdOne('idle');
      for (let i = 0; i < 4; i++) p.anim.mixer.update(1 / 60);
    }
    lowestDrawn();

    // ------------------------------------------------------ the rifle in his hands
    /**
     * Whether the officer is holding his rifle or wearing it.
     *
     * The rifle is welded into his right hand, so the whole fit is one constant
     * rotation in the hand's own frame — and that frame is not the world's: in every
     * clip he holds the weapon in, the hand's own +Y points forward and its -X up. A
     * model left unrotated lies along the hand's X instead, which stands the rifle
     * upright through his fist and aims it at the sky. Nothing else in the campaign
     * can see that: he still fires, still hits, still kills, and the only symptom is
     * a soldier sighting down a rifle that is not in his hands.
     *
     * The barrel is measured, not assumed. The two ends of the rifle are compared by
     * cross-section and the thinner one is taken as the muzzle, because a rifle
     * mounted backwards would otherwise sail through every clause here; the magazine
     * is found as the long side of the geometry measured against the bore line at
     * that muzzle, which is what separates a rifle held the right way up from one
     * held upside down.
     */
    // A hand carrying a rifle swings it well off the aim line while crouching and
    // walking, so the cone is wide on purpose: what it has to separate is a rifle
    // aimed along his facing (7-13 degrees in the clips he shoots from) from the one
    // standing upright through his fist, which is 95 degrees off it.
    const RIFLE_AIM_CONE = 60;    // degrees the barrel may sit off the officer's facing
    const RIFLE_IN_FRONT = 0.3;   // metres the muzzle must stand ahead of his hand
    const RIFLE_MAG_DOWN = -0.5;  // how far down the magazine must hang, of unit length
    const FLASH_TO_BARREL = 0.15; // metres the flash may sit from the barrel's own tip
    const FLASH_OFF_BARREL = 0.25; // ...and how far the stand-in it replaced sat from it
    const HOLDING = ['walk', 'aim', 'crouch'];
    const RIFLE_PHASES = [0.15, 0.5, 0.85];

    out.rifle = { hand: null, loaded: Boolean(p.weaponModel), held: {} };
    let hand = null;
    p.model.traverse((o) => { if (!hand && o.isBone && /^mixamorigRightHand$/i.test(o.name)) hand = o; });
    const rifle = p.weaponModel;
    if (hand && rifle) {
      out.rifle.hand = hand.name;
      // The rifle's own shape, in the frame it is welded to. Read as a function
      // because the control re-reads it: a rifle left unrotated is a *different*
      // shape in the hand's frame, and measuring the mounted one's axes against an
      // unrotated mount would only report the mount back to itself.
      const readRifle = () => {
        p.model.updateMatrixWorld(true);
        const toHand = new THREE.Matrix4().copy(hand.matrixWorld).invert();
        const pts = [];
        const sample = new THREE.Vector3();
        rifle.traverse((o) => {
          if (!o.isMesh) return;
          const pos = o.geometry.attributes.position;
          const step = Math.max(1, Math.floor(pos.count / 400));
          for (let i = 0; i < pos.count; i += step) {
            sample.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(toHand);
            pts.push(sample.clone());
          }
        });
        const bounds = [0, 1, 2].map((i) => {
          const values = pts.map((q) => q.getComponent(i));
          return { lo: Math.min(...values), hi: Math.max(...values) };
        });
        const barrel = bounds.reduce((best, b) => (b.hi - b.lo > best.hi - best.lo ? b : best), bounds[0]);
        const barrelAxis = bounds.indexOf(barrel);
        const across = [0, 1, 2].filter((i) => i !== barrelAxis);
        const span = barrel.hi - barrel.lo;

        // A slice of each end, to tell the barrel from the stock.
        const slab = (from, to) => {
          const got = pts.filter((q) => q.getComponent(barrelAxis) >= from && q.getComponent(barrelAxis) <= to);
          const centre = across.map((i) => {
            const values = got.map((q) => q.getComponent(i));
            return (Math.max(...values) + Math.min(...values)) / 2;
          });
          const thickness = across.reduce((sum, i) => {
            const values = got.map((q) => q.getComponent(i));
            return sum + (Math.max(...values) - Math.min(...values));
          }, 0);
          return { thickness, centre };
        };
        const low = slab(barrel.lo, barrel.lo + span * 0.12);
        const high = slab(barrel.hi - span * 0.12, barrel.hi);
        const muzzleAtLow = low.thickness <= high.thickness;
        const bore = muzzleAtLow ? low.centre : high.centre;

        // The muzzle's direction, the point it reaches to, and the magazine: the side
        // the geometry reaches furthest from the bore line, measured across the
        // receiver where a magazine actually hangs.
        const muzzle = new THREE.Vector3().setComponent(barrelAxis, muzzleAtLow ? -1 : 1);
        const muzzleAt = pts.reduce((best, q) => {
          const d = (muzzleAtLow ? -1 : 1) * q.getComponent(barrelAxis);
          return d > best.d ? { d, q } : best;
        }, { d: -Infinity, q: pts[0] }).q;
        const magazine = pts.reduce((best, q) => {
          const at = q.getComponent(barrelAxis);
          if (at < barrel.lo + span * 0.3 || at > barrel.lo + span * 0.7) return best;
          const off = across.map((i) => q.getComponent(i) - bore[across.indexOf(i)]);
          const reach = Math.hypot(off[0], off[1]);
          return reach > best.reach ? { reach, off } : best;
        }, { reach: -1, off: [1, 0] });
        const magazineDirection = new THREE.Vector3();
        across.forEach((i, k) => magazineDirection.setComponent(i, magazine.off[k]));
        magazineDirection.normalize();

        return { span, muzzle, muzzleAt, magazineDirection, muzzleEnd: muzzleAtLow ? 'the low end' : 'the high end' };
      };

      const shape = readRifle();
      out.rifle.length = +(shape.span / 100).toFixed(2);
      out.rifle.muzzleEnd = shape.muzzleEnd;
      out.rifle.magazine = shape.magazineDirection.toArray().map((n) => +n.toFixed(2));

      const facing = new THREE.Vector3();
      const handAt = new THREE.Vector3();
      const muzzleWorld = new THREE.Vector3();
      const measure = (key, seen = shape) => {
        const clip = holdOne(key);
        let degOff = 0;
        let inFront = Infinity;
        let magazineY = -Infinity;
        for (const phase of RIFLE_PHASES) {
          p.anim.mixer.setTime(clip.duration * phase);
          p.model.updateMatrixWorld(true);
          const q = hand.getWorldQuaternion(new THREE.Quaternion());
          facing.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
          const barrelWorld = seen.muzzle.clone().applyQuaternion(q).normalize();
          hand.getWorldPosition(handAt);
          muzzleWorld.copy(seen.muzzleAt).applyMatrix4(hand.matrixWorld);
          degOff = Math.max(degOff, Math.acos(Math.max(-1, Math.min(1, barrelWorld.dot(facing)))) * 180 / Math.PI);
          inFront = Math.min(inFront, muzzleWorld.clone().sub(handAt).dot(facing));
          magazineY = Math.max(magazineY, seen.magazineDirection.clone().applyQuaternion(q).y);
        }
        return {
          degOff: +degOff.toFixed(0),
          inFront: +inFront.toFixed(2),
          magazineY: +magazineY.toFixed(2),
          pass: degOff <= RIFLE_AIM_CONE && inFront >= RIFLE_IN_FRONT && magazineY <= RIFLE_MAG_DOWN,
        };
      };

      holdOne('idle');
      p.anim.mixer.setTime(0);
      for (const key of HOLDING) out.rifle.held[key] = measure(key);

      // Where the round leaves him. The flash and the tracer's first frame used to
      // be pinned to a point in front of his chest on the camera's yaw — a place no
      // rifle is ever at, and a good half metre from the barrel while he aims. They
      // now hang off the tip the rifle measured for its own model, so the shot is
      // measured against that barrel: fire one and see where the flash lands. The
      // shot goes into the sky, so nothing in the world can be hit by it, and the
      // ammunition, the timers, the recoil and the camera all go back afterwards.
      const keptCamera = G.camera.quaternion.clone();
      const keptPlayer = {
        ammo: p.ammo, reserve: p.reserve, fireTimer: p.fireTimer,
        reloading: p.reloading, lastShotAt: p.lastShotAt,
      };
      const keptGame = { recoilPitch: G.recoilPitch, shake: G.shake };
      try {
        const clip = holdOne('aim');
        p.anim.mixer.setTime(clip.duration * 0.5);
        p.model.updateMatrixWorld(true);
        // Cleared so the probe fires whatever the page was left doing.
        p.fireTimer = 0;
        p.reloading = 0;
        p.ammo = Math.max(p.ammo, 1);
        G.camera.lookAt(G.camera.position.x, G.camera.position.y + 10, G.camera.position.z);
        G.camera.updateMatrixWorld(true);
        G.tryShoot();
        const flashAt = G.effects.muzzleMesh.position.clone();
        const barrelAt = shape.muzzleAt.clone().applyMatrix4(hand.matrixWorld);
        const standIn = p.position.clone().add(new THREE.Vector3(0, 1.35, 0))
          .add(new THREE.Vector3(Math.sin(G.cameraYaw), 0, Math.cos(G.cameraYaw)).multiplyScalar(0.65));
        out.rifle.flash = {
          shown: G.effects.muzzleMesh.visible,
          toBarrel: +flashAt.distanceTo(barrelAt).toFixed(3),
          standInOffBarrel: +standIn.distanceTo(barrelAt).toFixed(3),
        };
      } finally {
        G.camera.quaternion.copy(keptCamera);
        G.camera.updateMatrixWorld(true);
        Object.assign(p, keptPlayer);
        Object.assign(G, keptGame);
      }
      out.rifle.flashOk = out.rifle.flash.shown && out.rifle.flash.toBarrel <= FLASH_TO_BARREL;
      // The control: the stand-in this replaced has to be named by the same
      // measurement, or the clause would pass on the thing it was written against.
      out.rifle.flashControlNamesIt = out.rifle.flash.standInOffBarrel > FLASH_OFF_BARREL;

      // The control: the mount this clause exists for is no rotation at all, and the
      // measurement has to name that rather than wave it through. Left as authored,
      // the rifle lies along the hand's X — the axis he aims at the sky.
      const authored = rifle.quaternion.clone();
      rifle.quaternion.identity();
      const unrotated = measure('aim', readRifle());
      out.rifle.control = Object.assign({}, unrotated, { namesIt: !unrotated.pass });
      rifle.quaternion.copy(authored);
      readRifle();

      out.rifle.limits = {
        coneDegrees: RIFLE_AIM_CONE, inFront: RIFLE_IN_FRONT, magazineY: RIFLE_MAG_DOWN,
        flashToBarrel: FLASH_TO_BARREL, flashOffBarrel: FLASH_OFF_BARREL,
      };
      out.rifleOk = Object.values(out.rifle.held).every((h) => h.pass)
        && out.rifle.control.namesIt
        && out.rifle.flashOk
        && out.rifle.flashControlNamesIt;

      // Left holding his rifle as a standing officer, the way the footing clause left
      // him, so later probes move him rather than inherit a kick's last frame.
      holdOne('idle');
      for (let i = 0; i < 4; i++) p.anim.mixer.update(1 / 60);
      p.model.updateMatrixWorld(true);
    } else {
      out.rifleOk = false;
    }

    out.limits = {
      wrongBoneDistance: WRONG_BONE_DISTANCE,
      weldShare: WELD_SHARE_LIMIT,
      samples: SAMPLES,
      groundSink: GROUND_SINK,
      groundFloat: GROUND_FLOAT,
    };
    out.pass = out.unweightedTotal === 0
      && out.weldShare <= WELD_SHARE_LIMIT
      && out.ownBootCount >= 1
      && out.noMisboundParts
      && out.ownBootsOnTheGround
      && out.ownBootsHidden
      && out.tierBootSocketed
      && (!out.control.measured || out.control.wouldNameIt)
      && out.statesOnTheGround
      && out.footingControl.pass
      && out.rifleOk;
    return out;
  }

  // ------------------------------------------------------------------ run
  const startButton = document.getElementById('start-button');
  if (startButton) startButton.click();
  if (G.state !== 'playing') G.start();
  if (G.state !== 'playing') return { fatal: `game did not start (state ${G.state})` };
  if (opts.checkLock || opts.checkKick || opts.checkDry || opts.checkCharacter || opts.forestSeeds) {
    // First, on the officer exactly as he loads. The other probes leave him in a
    // stretched pose — a kick clip scale-tracks the legs — and geometry bound to a
    // bone is only a fixed distance from it in the pose it was authored in, so the
    // audit is only comparable when nothing has moved him yet.
    if (opts.checkCharacter) report.characterCheck = await probeCharacter();
    if (opts.checkLock) report.lockCheck = probeLockRetarget();
    if (opts.checkKick) report.kickCheck = probeKicks();
    // Last, because unlike the others it plays a real wave and moves the officer.
    if (opts.checkDry) report.dryCheck = probeDryWave();
    // The sweep rebuilds its own forests rather than playing one, so it goes
    // after everything that touches this page's world.
    if (opts.forestSeeds) report.forestSweep = await probeForestSweep(opts.forestSeeds);
    const pass = (!report.lockCheck || report.lockCheck.pass)
      && (!report.kickCheck || report.kickCheck.pass)
      && (!report.characterCheck || report.characterCheck.pass)
      && (!report.dryCheck || report.dryCheck.pass)
      && (!report.forestSweep || report.forestSweep.pass);
    report.gameSeconds = +report.gameSeconds.toFixed(2);
    report.wavesReached = G.wave;
    report.outcome = pass ? 'probes-passed' : 'probe-failed';
    return report;
  }

  if (instrumented) {
    G.player.maxHealth = INSTRUMENT_MAX_HEALTH;
    G.player.health = INSTRUMENT_MAX_HEALTH;
    G.player.alive = true;
  }
  beginWave(G.wave, 0);

  // Drive frames one at a time through the patched step, which is where the
  // pilot, the bookkeeping and the stall watchdog live.
  while (report.steps < opts.maxSteps) {
    if (G.state !== 'playing') break;
    if (G.wave > opts.waves) break;
    if (stalledWave) break;          // a wave that cannot finish is the failure to catch
    G.step(1 / 60);
  }

  // Victory and death share one terminal state, so the end screen is the only
  // place that says which happened. Read it before closing the last wave row,
  // which a victory legitimately ends without a handover.
  const endTitle = document.getElementById('over-title')?.textContent?.trim() || '';
  report.endTitle = endTitle;
  report.outcome = G.state === 'playing'
    ? (G.wave > opts.waves ? 'reached-wave-cap' : 'step-cap')
    : (/ONE-MAN ARMY|ARMY/i.test(endTitle) ? 'victory' : (/DOWN/i.test(endTitle) ? 'death' : G.state));
  const endedWell = report.outcome === 'victory';

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
      damageTaken: +wave.damage.toFixed(1),
      damagePerSecond: +(wave.damage / Math.max(0.001, report.gameSeconds - wave.startS)).toFixed(2),
      longestGapSeconds: +Math.max(wave.longestGap, stallSeconds).toFixed(1),
      closedByHarness: !endedWell,
      endedByVictory: endedWell,
    });
  }

  stopMoving();
  pad.buttons[7] = { pressed: false, value: 0 };
  G.step = originalStep;
  G.inputManager.gamepadActive = false;
  G.inputManager._padUsed = false;

  report.gameSeconds = +report.gameSeconds.toFixed(2);
  report.wavesReached = G.wave;
  report.stalledWave = stalledWave;
  return report;
}
