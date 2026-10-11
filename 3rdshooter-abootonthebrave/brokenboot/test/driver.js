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
  const { SETTINGS, KICKS } = await import('./js/config.js');
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

  // ------------------------------------------------------------------ run
  const startButton = document.getElementById('start-button');
  if (startButton) startButton.click();
  if (G.state !== 'playing') G.start();
  if (G.state !== 'playing') return { fatal: `game did not start (state ${G.state})` };
  if (opts.checkLock || opts.checkKick || opts.checkDry) {
    if (opts.checkLock) report.lockCheck = probeLockRetarget();
    if (opts.checkKick) report.kickCheck = probeKicks();
    // Last, because unlike the others it plays a real wave and moves the officer.
    if (opts.checkDry) report.dryCheck = probeDryWave();
    const pass = (!report.lockCheck || report.lockCheck.pass)
      && (!report.kickCheck || report.kickCheck.pass)
      && (!report.dryCheck || report.dryCheck.pass);
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
