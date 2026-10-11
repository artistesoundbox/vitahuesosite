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
  headshotMultiplier: 2.2,
  bulletRange: 140,
  spread: 0.012,
  recoil: 0.9,

  // Boot. Reach and cooldown are global; damage and knockback come from the
  // equipped tier in BOOT_TIERS so upgrades are felt directly.
  kickRange: 3.6,
  kickArc: Math.PI * 0.6,
  kickCooldown: 0.8,

  // Enemy
  enemyHealth: 100,
  enemyWalkSpeed: 3.4,
  enemyEngageRange: 17,
  enemyMaxRange: 46,
  enemyFireBase: 1.35,
  enemyDamage: 9,

  // Attackers fight from cover: they crouch behind trees, the car and the
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

// Third-person body for the SWAT officer. 3rdpersonidle.fbx carries the mesh.
export const PLAYER_SOURCE = {
  mesh: '3rdpersonidle.fbx',
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

// Attackers. attackerIdle.fbx carries the mesh (this is the "light brown" soldier).
export const ENEMY_SOURCE = {
  mesh: 'attackerIdle.fbx',
  clips: {
    walk: 'attackershootwalking.fbx',
    aim: 'attackershootstanding.fbx',
    crouch: 'attackershootcrouch.fbx',
  },
};

export const WEAPON = { model: 'ak-47.glb' };

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
export const VEHICLE = { model: 'suggan_53_modified_-_low_poly_model.glb', length: 4.6 };

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
export const BOOT_TIERS = [
  { name: 'Standard Boot',     kills: 0,   meleeDamage: 55,  knockback: 13,  speedBonus: 0,    model: null,                color: '#c8b18d', socket: 'default' },
  { name: 'Reinforced Boot',   kills: 10,  meleeDamage: 66,  knockback: 14,  speedBonus: 0,    model: null,                color: '#9fd08a', socket: 'default' },
  { name: 'Silver Boot',       kills: 24,  meleeDamage: 82,  knockback: 16,  speedBonus: 0.05, model: 'silverboot.glb',    color: '#cfd6de', socket: 'silver' },
  { name: 'Gold Boot',         kills: 42,  meleeDamage: 105, knockback: 19,  speedBonus: 0.1,  model: 'goldboot.glb',      color: '#f2c94c', socket: 'gold' },
  { name: 'Spiked Gold Boot',  kills: 62,  meleeDamage: 128, knockback: 26,  speedBonus: 0.1,  model: 'goldboot.glb',      color: '#e0912f', socket: 'gold' },
  { name: 'Tactical Doom Boot',kills: 82,  meleeDamage: 150, knockback: 30,  speedBonus: 0.12, model: 'brokenboot.glb',    color: '#c0642b', socket: 'broken' },
  { name: 'Legendary Broken Boot', kills: 102, meleeDamage: 190, knockback: 38, speedBonus: 0.16, model: 'brokenboot.glb', color: '#a33b6b', socket: 'broken' },
  { name: 'Mythical Diamond Boot', kills: 116, meleeDamage: 220, knockback: 44, speedBonus: 0.18, model: 'diamondboot.glb', color: '#7fe6e0', socket: 'broken' },
];

// The socket helper centres a boot model on the right-foot bone, so each model
// needs its own fit. `size` is its longest axis in world units; `lift` raises it
// (also world units) until the sole sits on the ground under a standing foot.
// The broken boot is deliberately the big, heavy one.
export const BOOT_SOCKETS = {
  default: { size: 0.36, lift: 0.05 },
  silver:  { size: 0.34, lift: 0.05 },
  gold:    { size: 0.35, lift: 0.05 },
  broken:  { size: 0.38, lift: 0.065 },
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
];
