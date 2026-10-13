// A Broken Boot On The Brave — configuration and tunables.
// Original assets live in the repository root, one level above the game page.
export const ASSET_BASE = '../';

export const SETTINGS = {
  playerHeight: 1.8,
  enemyHeight: 1.86,

  // Locomotion
  walkSpeed: 4.6,
  sprintSpeed: 7.8,
  aimSpeed: 2.4,
  accel: 42,
  friction: 14,

  // Jumping
  gravity: -20,
  jumpSpeed: 6.3,

  // Combat
  maxHealth: 100,
  magSize: 30,
  reserveStart: 150,
  reloadTime: 1.7,
  fireInterval: 0.105,
  // Gunfire wounds attackers. Enough sustained fire will eventually bring one
  // down, but it is deliberately slow work: hits floor the health and then feed
  // a bleed-out timer. The boot is instant, so it stays the tool of choice and
  // is what earns the boot tiers.
  bulletDamage: 24,
  bulletMinHealth: 6,
  // Seconds an attacker survives bleeding at the floor before collapsing.
  bleedoutTime: 15,
  // Each extra hit while they are bleeding takes this many seconds off.
  bleedoutHitPush: 0.8,
  // Elites are tougher and take proportionally longer to bleed out.
  bleedoutEliteScale: 1.6,
  // A bullet downing only credits this fraction of a boot rout toward tiers.
  bulletKillWeight: 0.25,

  // The boot tiers that ship their own recorded takes, by `socket` slug. A listed
  // tier plays `<socket>-bsh.mp3` and `<socket>-bootpower.mp3` from the asset folder
  // instead of the shared pair, through its own voice (BOOT_VOICES) like any other.
  // Empty is the honest state: nothing is fetched speculatively, because a missing
  // file is a console error for a player and a failing request in the harness, so a
  // new pair of recordings is added here on the day it is made. Every tier still
  // sounds like itself without this — see BOOT_VOICES.
  bootRecordedTiers: [],

  // A round through the head that finishes an attacker is a fatality: the body comes
  // off its feet and goes where the shot sent it, instead of folding up where it
  // stood. It is a finishing move, not a faster kill — the elimination, the credit
  // and the loot are exactly what any other downing pays — so the boot stays the way
  // to the next tier. The throw is worked out from the shot itself rather than from
  // dice, because a campaign that draws different numbers from an explosion that
  // happens after the fight is over is no longer the same campaign. The numbers are
  // set so the body plainly leaves the ground: at `fatalityLift` it peaks about half
  // a metre up and hangs for four tenths of a second, which puts the landing most of
  // three metres downrange, and `fatalitySpin` turns it most of the way over.
  fatalityThrow: 6.4,       // m/s the body leaves at
  fatalityLift: 4.2,        // m/s of it upward
  fatalitySpin: 6.0,        // rad/s it tumbles at
  fatalitySkid: 3.4,        // how fast the skid after it lands dies away
  fatalityShake: 0.75,
  // The flight is played back in slow motion, because a throw that takes four
  // tenths of a second at full speed is a flicker: at `fatalitySlowScale` the world
  // creeps for `fatalitySlowmo` real seconds and eases back up to full speed by the
  // end of it, so the body is in the air long enough to be watched. Real time, not
  // world time — the window is what the eye gets, and it is spent whichever way the
  // world is running.
  fatalitySlowmo: 0.55,
  fatalitySlowScale: 0.28,
  // Where the body comes down, and how long the mark it leaves lasts. The stain is
  // stretched along the direction it was thrown, and drawn from the shot rather
  // than from dice, for the same reason the throw is.
  fatalityDecalLife: 16,    // seconds before the last of it fades
  fatalityDecalRadius: 0.62,// metres across, before the stretch
  headshotMultiplier: 2.2,
  bulletRange: 140,
  spread: 0.012,
  recoil: 0.9,

  // Boot. Reach, arc and cooldown come from the kick being thrown (see KICKS);
  // damage and knockback come from the equipped tier in BOOT_TIERS so upgrades
  // are felt whatever kick it is.
  kickRange: 3.6,
  kickArc: Math.PI * 0.6,
  kickCooldown: 0.8,

  // Scenery. Crates, barriers, rocks and the cars are simple bodies: an impulse
  // sends them off, drag and a bounce settle them, and they sleep once they are
  // slow enough that re-fitting their collision box every frame is a waste. A
  // prop has to still be travelling at propHitSpeed to put an attacker down.
  propDrag: 0.55,
  propSpinDrag: 1.2,
  propRestitution: 0.24,
  propSleepSpeed: 0.4,
  propHitSpeed: 4.5,
  propHitDamage: 38,
  propHitKnockback: 16,

  // What the boot feels like when it connects. Every figure below scales off one
  // mass: an attacker body counts as `bodyMass`, a kicked crate, barrel, sandbag
  // wall, rock or tank as its own mass (1, 1.2, 1.5, 2.6, 4), and the heaviest
  // thing the boot met decides. So a crate barely rattles the frame, a rock is a
  // shove and a tank is a wall. A kick into empty air meets no mass at all and gets
  // none of it, which is what makes a connect read as a connect.
  bodyMass: 2.0,
  // How far above his own feet the boot reaches. Every ground fight is on one level,
  // so this is about the war above it: a marksman holding a cap is out of the boot's
  // reach from underneath, and climbing his rock is what gets the boot to him.
  bootReachUp: 0.6,
  kickShakePerMass: 0.45,       // camera rattle per unit of mass
  kickShakeMax: 2.0,
  kickWhiffShake: 0.3,          // the swing alone, when it meets nothing
  chargedShake: 1.4,            // a charged kick floors it whatever it met
  kickbackPerMass: 0.16,        // metres the eye is shoved back along the aim
  kickbackMax: 0.9,
  kickbackDamp: 7.5,            // per second: a snap, not a drift
  kickRollPerMass: 1.6,         // degrees of frame roll, away from the impact
  kickRollMax: 8,
  kickRollDamp: 8,
  kickStopPerMass: 0.03,        // seconds the world hitch-slides for
  kickStopMax: 0.14,
  kickStopScale: 0.12,          // world time runs at this fraction during one
  kickFlashMass: 3,             // the mass that fills the screen-edge flash: a rock is
                                // under it, so only the tank fills the frame
  propHitShakePerMass: 0.16,    // a tank rolling through a line, per unit mass
  shakeMax: 2.4,

  // Boot charge. Routs and charge crates fill it; a full meter turns the next
  // kick into a charged one that sends the whole arc running at once.
  chargeMax: 100,
  chargePerRout: 9,
  chargePerGunfireDown: 3,
  chargePickup: 40,
  chargedExtraRouts: 4,
  chargedKnockbackScale: 1.6,

  // Crouch. Steadies the rifle and shrinks the target, at the cost of speed.
  crouchSpeedScale: 0.55,
  crouchSpreadScale: 0.45,
  crouchHitScale: 0.72,
  crouchCamDrop: 0.45,

  // Target lock (left trigger / right mouse / Q): tunes the aim onto the
  // attacker closest to the crosshair and steadies the shot while held.
  lockAngle: 0.22,
  lockRate: 7,
  lockSpreadScale: 0.45,
  lockMaxRange: 70,
  lockGrace: 0.35,

  // Timed powerups.
  rapidFireScale: 0.55,
  rapidDuration: 12,
  armorDuration: 12,
  speedDuration: 12,
  armorDamageScale: 0.55,
  speedPowerupBonus: 0.25,

  // Elimination drop table. Ammo comes first so a dry player can never stall.
  dropAmmo: 0.26,
  dropHealth: 0.16,
  dropReload: 0.1,
  dropCharge: 0.14,
  dropRapid: 0.08,
  dropArmor: 0.08,
  dropAmmoIfDry: 45,
  dropHealthAmount: 30,
  dropReloadReserve: 30,
  dropChargeAmount: 40,

  // Enemy
  enemyHealth: 100,
  enemyWalkSpeed: 3.4,
  enemyEngageRange: 17,
  enemyMaxRange: 46,
  enemyFireBase: 1.35,
  enemyDamage: 9,

  // Attackers fight from cover: they crouch behind trees, the tanks and the
  // crates and bound forward cover to cover, so the fight opens out instead of
  // turning into a close-range brawl. How many press the attack at once, how
  // long they hold cover and how hard they come on all scale with the wave —
  // see RAMP and waveRamp() below.
  coverSearchRadius: 20,
  coverHoldMin: 4.5,
  coverHoldMax: 9,
  // While hiding they only snap off a shot if the player gets this close.
  coverFireRange: 8,
  // The breather before the first attacker steps out of cover.
  firstAssaultDelay: 2.5,

  // Hiding only works while the fight is moving. If nothing is eliminated the
  // line breaks cover and charges; an elimination buys them a fresh window of
  // hiding. On top of that, the last `flushLastStandCount` attackers of a wave
  // never hide again. Without this a wave ends in a slow walk around the forest
  // rounding up stragglers, which was the biggest drag on the pace.
  flushLastStandCount: 3,

  // A routed attacker runs for the trees and is gone for good.
  routedSpeed: 6.4,
  routedDuration: 5.5,

  // Camera
  camDistance: 4.8,
  camHeight: 1.5,
  camShoulder: 0.62,
  camPitchMin: -0.75,
  camPitchMax: 0.35,
  mouseSensitivity: 0.0021,

  // World
  worldSize: 118,
  clearingRadius: 19,
  treeCount: 165,
  // The forest is built from this seed — the trees, the cover and the cars all
  // come out of one stream — so this is the layout every run has always played,
  // and `?worldSeed=N` builds another one from it.
  worldSeed: 1337,

  // Spawn ring for attackers, measured from the player. They open the fight
  // from a distance and walk in from cover.
  spawnMinRadius: 26,
  spawnMaxRadius: 38,

  maxAliveEnemies: 9,
  totalWaves: 10,
};

/**
 * Per-wave escalation. Every figure is a `start` (wave 1) to `end` (final wave)
 * pair, mixed by how far through the ten waves the player is, so the opening
 * waves are slow cover firefights and the late waves press hard and barely
 * hide at all. `secondAssaultWave` is the wave where a second attacker starts
 * pressing at the same time as the first.
 */
export const RAMP = {
  flushAfterStart: 12,
  flushAfterEnd: 3.5,
  assaultDurationMinStart: 4,
  assaultDurationMinEnd: 7,
  assaultDurationMaxStart: 6,
  assaultDurationMaxEnd: 11,
  assaultGapStart: 3.4,
  assaultGapEnd: 0.7,
  secondAssaultWave: 6,
  spawnIntervalStart: 1.7,
  spawnIntervalEnd: 0.75,
  speedStart: 0.92,
  speedEnd: 1.12,
  coverRangeStart: 14,
  coverRangeEnd: 10.5,
  coverMinStart: 9,
  coverMinEnd: 7,
  intermissionStart: 6.5,
  intermissionEnd: 4,
};

/**
 * The escalation figures for a given wave. Pure arithmetic so the curve can be
 * checked directly rather than inferred from a play session.
 */
export function waveRamp(waveNumber) {
  const span = Math.max(1, SETTINGS.totalWaves - 1);
  const t = Math.min(1, Math.max(0, (waveNumber - 1) / span));
  const mix = (a, b) => a + (b - a) * t;
  return {
    progress: t,
    flushAfter: mix(RAMP.flushAfterStart, RAMP.flushAfterEnd),
    assaultDurationMin: mix(RAMP.assaultDurationMinStart, RAMP.assaultDurationMinEnd),
    assaultDurationMax: mix(RAMP.assaultDurationMaxStart, RAMP.assaultDurationMaxEnd),
    assaultGap: mix(RAMP.assaultGapStart, RAMP.assaultGapEnd),
    assaultSlots: waveNumber >= RAMP.secondAssaultWave ? 2 : 1,
    spawnInterval: mix(RAMP.spawnIntervalStart, RAMP.spawnIntervalEnd),
    speedScale: mix(RAMP.speedStart, RAMP.speedEnd),
    coverPreferredRange: mix(RAMP.coverRangeStart, RAMP.coverRangeEnd),
    coverMinRange: mix(RAMP.coverMinStart, RAMP.coverMinEnd),
    intermission: mix(RAMP.intermissionStart, RAMP.intermissionEnd),
  };
}

// Third-person body for the SWAT officer. The GLB carries the mesh and the idle
// clip; tools/convert-glb.mjs builds it from the 115 MB FBX master, which stays in
// the repository as the source but is no longer downloaded — see "Asset size and
// hosting" in the README.
export const PLAYER_SOURCE = {
  mesh: '3rdpersonidle.glb',
  clips: {
    walk: '3rdpersonshootwalking.fbx',
    aim: '3rdpersonshootstanding.fbx',
    crouch: '3rdpersonshootcrouch.fbx',
    jump: '3rdpersonjump.fbx',
    kick: '3rdpersonkick.fbx',
    kickHigh: '3rdpersonkickhigh.fbx',
    stomp: '3rdpersonstomp.fbx',
  },
};

// Attackers. The GLB carries the mesh (this is the "light brown" soldier).
export const ENEMY_SOURCE = {
  mesh: 'attackerIdle.glb',
  clips: {
    walk: 'attackershootwalking.fbx',
    aim: 'attackershootstanding.fbx',
    crouch: 'attackershootcrouch.fbx',
  },
};

// The officer's rifle, welded into his right hand, so the whole fit is listed
// here and applied once (see socketRifle).
//
// `size` is its longest axis in world units. `muzzle` and `magazine` are
// directions in the model's own frame, measured off its geometry: the barrel is
// the model's X with the muzzle at -X (the thin end — the stock is the thick
// one), and the magazine hangs towards -Y, which is told from the sight rail by
// measuring against the bore line rather than the model's own box: the muzzle is
// a thin tube centred 0.53 up the box, the middle of the rifle reaches 1.25 below
// that line and only 0.20 above it, and the magazine is the long side. `grip` is
// how far up the rifle the hand takes it, measured from the stock end: a third of
// the way up puts the pistol grip in his fist with the muzzle clear of his own
// body, as it sits on a real AK.
//
// The hand's own frame is what the rifle is bolted to, and it is not the world's:
// in every pose the officer holds the rifle in — aim, walk, crouch — the hand bone
// points its own +Y forward and its -X up, while down a plain idle that same +Y
// hangs at his side. So the mount maps muzzle onto the hand's +Y and magazine onto
// its -X: the barrel follows wherever the hand points it, the magazine stays
// underneath, and the idle hangs the rifle muzzle-down. Left unrotated the rifle
// lies along the hand's X instead, which stands it upright through his fist.
export const WEAPON = {
  model: 'ak-47.glb',
  size: 0.95,
  grip: 1 / 3,
  muzzle: [-1, 0, 0],
  magazine: [0, -1, 0],
};

// The forest/mountain photogrammetry scene used as the surrounding environment.
// `span` is the world-space width it is scaled to, `floorY` where its lowest
// point ends up (just under the walkable ground plane).
export const LANDSCAPE = {
  model: 'landscape_forest__mountains.glb',
  enabled: true,
  // The valley is ~107 units across as authored, so the world is sized to sit
  // inside it at close to 1:1. Upscaling it made the walls loom and ruined the
  // baked tree scale.
  span: 130,
  floorY: -2.5,
  // Rendered once into a cubemap and used as the sky.
  skyboxSize: 1024,
  probeHeight: 1.7,
  skyboxIntensity: 1,
};
// The vehicle cover: a CC0 modular tank — hull and turret, two files from the same
// pack — in place of the low-poly car. The pair is scaled as one assembly off the
// models' own bounding boxes, because every pack in the set is in its own units
// (centimetres, metres, Blender units) and none of that is worth trusting twice.
// The turret is turned to lie along the hull: the pack models it across, which only
// shows up once it is on.
// `length` is what the tank is fitted by, not its height: in the pack's own units the
// hull is all but square (0.406 × 0.159 × 0.373, so 5.9 m across if it were scaled to
// stand 2.3 m tall), and five of those on the field are not cover, they are a wall —
// the forest audit caught exactly that. Fitted to the car's own 4.6 m of length it
// measures 4.60 × 1.80 × 4.23 m and reaches 2.39 m to the top of the turret: a
// low-slung tank, and a piece of cover the fight can still use.
export const VEHICLE = {
  model: 'tank_hull.dae',
  turret: 'tank_turret.dae',
  length: 4.6,
  count: 3,
  turretTurn: -Math.PI / 2,
  turretShare: 0.55,  // the turret's length as a fraction of the hull's own
  mass: 4,          // the heaviest thing the boot can meet, heavier than the rocks
  radius: 2.6,      // how close an attacker has to be to be under its cover
};

// The CC0 prop pack dressing the field: a plank crate and a barrel from the
// crate-and-barrel pack, and a wall of sandbags where the concrete barrier used to
// be. `by`/`size` is the target the model is scaled to, measured from its own
// bounding box, and `mass` is what a kick is divided by — a crate flies, a barrel
// rolls, a wall of sandbags shifts.
export const PROPS = {
  crate:   { model: 'crate_mesh.obj',  by: 'height', size: 1.05, mass: 1,   radius: 1.05, count: 10, colour: 0x5c5344 },
  barrel:  { model: 'barrel_mesh.obj', by: 'height', size: 0.95, mass: 1.2, radius: 0.75, count: 5,  colour: 0x47503c },
  // The sandbag model is a long low wall (6.1 m of it at 0.95 m high once scaled), so
  // it is scaled by height and only three are laid: it is cover first, and a wall the
  // length of a bus makes cover the fight can use without sealing the clearing.
  barrier: { model: 'sandbags.dae',    by: 'height', size: 1.05, mass: 1.5, radius: 1.4,  count: 3,  colour: 0x7d7a66 },
  // The cabin: one, on the ground the attackers walk in over, between the clearing's
  // edge and the spawn ring — far enough out to be the landmark the fight happens in
  // front of rather than an obstacle inside it, and close enough to be read from the
  // clearing. Its own export is a shed (1.61 × 1.99 × 0.85 m), so it is fitted by height
  // to cabin size, and its own texture is kept: everything else out here is block-coloured
  // off-scene dressing, and this is the one building.
  cabin:   { model: 'cabin.glb',       by: 'height', size: 2.8,  mass: 6,   radius: 3.2,  count: 1,  colour: null },
};

// Gradient sky cap drawn over the scanned horizon.
// `capAngle` is the fraction of the sphere covered from the zenith downwards.
export const SKY = {
  radius: 320,
  capAngle: 0.46,
  horizon: 0xb3cbdd,
  zenith: 0x5480bd,
};

// Boot progression. `kills` is boot-progress credit: a boot rout is worth one
// point, a bullet downing a quarter, so shooting levels the boots far slower.
// `model` is lazily loaded the first time a tier is reached, and `socket` names
// the fit used to strap it onto the right foot (see BOOT_SOCKETS).
// Thresholds are set against the whole ten-wave campaign, which totals 117
// attackers. A single run is worth at most 117 credit (every elimination by
// boot), so the top tier has to sit just under that or it could never be seen.
// As it stands a good run reaches Legendary Broken Boot near the end, and
// Mythical Diamond needs a near-perfect boot-only clear.
// Every tier wears a boot, including the two he starts in: it is one of the four
// models that ship, at the size its tier asks for, and the joke and the reward are
// the same thing — the boot he ends up in is twice the one he started with. A tier
// with no model is a boot *not* worn, which is what the first two used to be, so a
// run that never reached Silver was a run with no boot in it at all.
export const BOOT_TIERS = [
  { name: 'Standard Boot',     kills: 0,   meleeDamage: 55,  knockback: 13,  speedBonus: 0,    model: 'brokenboot.glb',  color: '#c8b18d', socket: 'standard' },
  { name: 'Reinforced Boot',   kills: 10,  meleeDamage: 66,  knockback: 14,  speedBonus: 0,    model: 'brokenboot.glb',  color: '#9fd08a', socket: 'reinforced' },
  { name: 'Silver Boot',       kills: 24,  meleeDamage: 82,  knockback: 16,  speedBonus: 0.05, model: 'silverboot.glb',  color: '#cfd6de', socket: 'silver' },
  { name: 'Gold Boot',         kills: 42,  meleeDamage: 105, knockback: 19,  speedBonus: 0.1,  model: 'goldboot.glb',    color: '#f2c94c', socket: 'gold' },
  { name: 'Spiked Gold Boot',  kills: 62,  meleeDamage: 128, knockback: 26,  speedBonus: 0.1,  model: 'goldboot.glb',    color: '#e0912f', socket: 'goldSpiked' },
  { name: 'Tactical Doom Boot',kills: 82,  meleeDamage: 150, knockback: 30,  speedBonus: 0.12, model: 'brokenboot.glb',  color: '#c0642b', socket: 'doom' },
  { name: 'Legendary Broken Boot', kills: 102, meleeDamage: 190, knockback: 38, speedBonus: 0.16, model: 'brokenboot.glb', color: '#a33b6b', socket: 'legendary' },
  { name: 'Mythical Diamond Boot', kills: 116, meleeDamage: 220, knockback: 44, speedBonus: 0.18, model: 'diamondboot.glb', color: '#7fe6e0', socket: 'diamond' },
];

// Which way a boot's own axes point, measured off the four models that ship: the
// author made them all the same way, so this is a property of the boots and not of
// a tier — the sole faces +Y and the toe runs along +Z. Each model's own sole is
// 1.9° off flat, which is the model's own tilt rather than a socket's.
export const BOOT_MODEL_AXES = { sole: [0.009, 0.999, -0.032], toe: [0, 0, 1] };

// The right-foot bone is a different frame, and not a rotated copy of the model's:
// its toe runs along +Y (the rig's own toe bones put it there), and its sole, taken
// from the vertices that touch the ground, faces mostly +Z. The socket maps one
// pair onto the other, so a boot arrives level and pointing where the foot points.
// A guessed Euler — -90° about x — did neither: it stood the boot on its toe with
// the sole facing backwards, which is the lopsided boot this replaced.
export const BOOT_BONE_AXES = { sole: [0.046, -0.592, 0.804], toe: [0.006, 0.976, 0.218] };

// `lift` is metres along the boot's own sole direction and `forward` metres along
// the foot's; both start from the bone the boot is socketed onto, which is the ankle
// joint and sits near the back of a foot. Centring a boot on the bone alone hangs it
// off the heel, so every tier carries a forward offset as well as a lift.
//
// The floating islands: flat slabs of rock hanging in the air over the fight, stepped
// so they can be climbed by jumping and far enough apart to be a route rather than a
// staircase. Each one is a disc of turf on a rim of bare rock, `depth` thick, with the
// face he lands on at exactly `top`. Three numbers decide whether they are a climb or
// a ramp:
//
//   `rise`          0.70 m against a jump apex of `jumpSpeed² / (2 · |gravity|)` ≈ 0.99 m,
//                   so every step is clear of him by a third of a metre
//   `stepTolerance` how far *below* a cap his feet may be and still be caught by it.
//                   It has to be narrower than `rise`, or walking into the overlap between
//                   two caps lifts him a step for free — the harness measures that it
//                   does not. It also has to swallow a frame of falling onto a cap from
//                   above: 0.15 m is 9 m/s, and a fall off an island arrives slower.
//   `firstRise`     0.95 m, the first step sized to the same climb: his feet have to
//                   reach `firstRise - stepTolerance` = 0.80 m of the 0.99 m apex.
//
// The jump that reaches each of those is checked by the harness rather than assumed.
// Some islands carry a supply crate — a small military asset on the open lid, which is
// the reward for the climb and therefore out of reach from the ground (see
// `Effects.update`: loot is collected at its own level or above, never from below).
export const PLATFORMS = {
  count: 10,        // islands in the climb
  firstRise: 0.95,  // m the first one floats above the ground
  rise: 0.70,       // m each step up
  stepTolerance: 0.15, // m below a cap that still counts as being caught by it
  gapMin: 2.05,     // m between the centres of neighbours
  gapMax: 2.55,
  wander: 1.15,     // rad the climb is allowed to curve by, per step
  radius: 1.55,     // m of top the officer can stand on
  depth: 0.8,       // m of slab below the top face: the rock the cap is cut out of
  spread: 9,        // m the first island is laid out from the clearing centre
  crates: ['ammo', 'health', 'charge', 'rapid', 'armor'],
  firstCrate: 2,    // the island the first crate sits on, and every other one after
};

// The marksman on the islands. One cap of the climb — the lowest one that can see the
// clearing — is posted with a shooter who holds it: he does not walk, he does not take
// cover, and while he is up there gunfire only ever wounds him. That last rule is the
// whole point of him: the rifle floors him and stops, so the boot is the only thing
// that takes him off the rock, and the climb is what gets the boot to him (he stands
// above `SETTINGS.bootReachUp`).
//
// He is posted rather than walked there: the perch is a cap, and nothing in the fight
// can hand him one, so `world.marksmanPerch()` picks it and `EnemyManager.queueWave`
// puts him on it before the walking line steps off.
//
// And the climb pays, so that going up after him is something the officer wants rather
// than only something the wave demands: a marksman put off his rock leaves his kit
// behind on the cap — a guaranteed pickup, where an ordinary elimination can roll
// nothing at all — and the first one over the edge is the `off_the_rock` achievement.
export const MARKSMAN = {
  firstWave: 2,       // waves before this are the walking line alone
  maxTop: 1.65,       // m: a LOW cap — the first rung (0.95) or one step above it
  sightSamples: 9,    // points of the clearing he is asked to see
  sightNeeded: 3,     // of those, how many a perch has to see before it is worth posting
  sightRadius: 0.62,  // fraction of the clearing radius the samples sit at
  sightHeight: 1.2,   // m: the chest height of whoever he is shooting at down there
  fireInterval: 2.9,  // s between shots — slow, and unbroken by cover the way the line's is
  damageScale: 1.8,   // multiplies `SETTINGS.enemyDamage`
  hitBonus: 0.18,     // added to the hit chance, so range costs him far less than it costs them
  maxRange: 60,       // m he will shoot to
  kitDrop: true,      // the boot off his rock leaves a pickup on the cap, never a miss
};

// How a sound behaves in space: how fast it falls away, how dull it gets, and how
// hard a side is a side. A firefight is meant to be readable with the screen out of
// frame — an attacker firing from the trees on the left is heard on the left, and
// further off than one standing in your face — so these are the numbers that tuning
// that means. They apply to what somebody else makes: the officer's own rifle, boot
// and pickups happen at the ear and are never placed.
export const AUDIO_SPACE = {
  refDistance: 7,     // m at which a sound plays at the gain it was given
  rolloff: 1.15,      // how fast it falls away past that (inverse distance, 1 = real)
  minGain: 0.05,      // m the floor: nothing goes silent out there, it goes faint
  brightHz: 12000,    // the low-pass cutoff at arm's length, effectively open
  dullestHz: 600,     // the cutoff it has been filtered down to at `dullestAt`
  dullestAt: 60,      // m over which the air takes the top off a sound
};

// How each tier sounds. A heavier boot lands lower and louder, so upgrading changes
// the boot's voice as well as its numbers — which is what a tier without its own
// recording gets, and the voice a tier with one is played through on top of its own
// file. See SETTINGS.bootRecordedTiers for the tiers that ship one.
//
// `rate` is playback speed (pitch and length together, as a tape would do it) and
// `gain` is multiplied by the effects volume, so the eight tiers are eight distinct
// sounds from one pair of recordings. Keyed by `socket`, so the file names and the
// voices cannot drift apart.
export const BOOT_VOICES = {
  standard:   { rate: 1.00, gain: 0.70 },
  reinforced: { rate: 0.97, gain: 0.75 },
  silver:     { rate: 0.94, gain: 0.79 },
  gold:       { rate: 0.90, gain: 0.83 },
  goldSpiked: { rate: 0.86, gain: 0.87 },
  doom:       { rate: 0.81, gain: 0.92 },
  legendary:  { rate: 0.76, gain: 0.96 },
  diamond:    { rate: 0.70, gain: 1.00 },
};

// The socket helper centres a boot model on the right-foot bone, so each size
// needs its own fit. `size` is the model's longest axis in world units — the boot
// he starts in is 0.52 m and the Diamond is 1.00 m, both bigger than the 0.385 ×
// 0.491 × 0.517 m boot his own mesh used to carry, so every tier swallows the foot
// rather than perching on it. `lift` raises the model (also world units) until its
// sole sits on the ground under a standing foot; these are measured, not guessed
// (see `npm run test:character`, which reports the sole and the coverage).
export const BOOT_SOCKETS = {
  standard:   { size: 0.52, lift: 0.023, forward: 0.057 },
  reinforced: { size: 0.56, lift: 0.035, forward: 0.057 },
  silver:     { size: 0.60, lift: 0.047, forward: 0.057 },
  gold:       { size: 0.66, lift: 0.066, forward: 0.057 },
  goldSpiked: { size: 0.72, lift: 0.084, forward: 0.057 },
  doom:       { size: 0.80, lift: 0.108, forward: 0.057 },
  legendary:  { size: 0.90, lift: 0.139, forward: 0.057 },
  diamond:    { size: 1.00, lift: 0.170, forward: 0.057 },
};
// The kicks the officer knows, and how a kick is chosen:
//
//   standing  the equipped boot's signature — a kick, a high kick once the boot
//             reaches Silver, a stomp from Spiked Gold up
//   crouched  a low sweep: almost no reach, but it covers the whole front and
//             takes the legs out from under a line
//   airborne  a flying high kick: furthest reach, hardest landing, and the one
//             that sends cars and crates furthest
//
// So all three are always available — crouch for the sweep, jump and kick from
// the air for the high kick — and upgrading the boot changes the standing one.
// `damageScale` and `knockbackScale` apply to the equipped tier's figures, so a
// better boot is felt in every kick. `propPower` and `propLift` are the impulse
// put into scenery, divided by the prop's mass: a crate flies, a tank shifts.
export const KICKS = {
  kick: {
    name: 'Kick', clip: 'kick',
    range: 3.6, arc: Math.PI * 0.6,
    damageScale: 1, knockbackScale: 1, routeBonus: 0,
    propPower: 10, propLift: 3.5,
    cooldownScale: 1,
  },
  sweep: {
    name: 'Low Sweep', clip: 'kick',
    range: 2.7, arc: Math.PI * 0.8,
    damageScale: 0.7, knockbackScale: 0.7, routeBonus: 1,
    propPower: 7, propLift: 1.2,          // skitters crates along the ground
    cooldownScale: 0.75,
  },
  high: {
    name: 'High Kick', clip: 'kickHigh',
    range: 4.3, arc: Math.PI * 0.42,      // a spear, not a net
    damageScale: 1.15, knockbackScale: 1.3, routeBonus: 0,
    propPower: 13, propLift: 8,
    cooldownScale: 1.05,
  },
  stomp: {
    name: 'Stomp', clip: 'stomp',
    range: 3.3, arc: Math.PI,             // all round, on the spot
    damageScale: 1.4, knockbackScale: 1.1, routeBonus: 1,
    propPower: 16, propLift: 10,
    cooldownScale: 1.3,
  },
};

export const ACHIEVEMENTS = [
  { id: 'first_blood',  label: 'Boot Camp Graduate',        desc: 'Get your first elimination.' },
  { id: 'melee_25',     label: 'The Boot Strikes Back',     desc: 'Defeat 25 enemies with the boot.' },
  { id: 'wave_5',       label: 'Forest Custodian',          desc: 'Clear five waves in the forest.' },
  { id: 'kills_100',    label: 'The Broken Boot',           desc: 'Defeat 100 enemies.' },
  { id: 'silver',       label: 'Silver Sole',               desc: 'Unlock the Silver Boot.' },
  { id: 'gold',         label: 'Gold Standard',             desc: 'Unlock the Gold Boot.' },
  { id: 'legendary',    label: 'The Legend Of The Boot',    desc: 'Unlock the Legendary Broken Boot.' },
  { id: 'surrounded',   label: 'Surrounded',                desc: 'Become surrounded by six or more attackers.' },
  { id: 'one_man_army', label: 'One-Man Army',              desc: 'Complete every wave.' },
  { id: 'tank_kicker',  label: 'Boot Versus Armour',        desc: 'Kick a tank off its mark.' },
  { id: 'off_the_rock', label: 'Off The Rock',              desc: 'Climb the islands and boot a marksman off his cap.' },
];
