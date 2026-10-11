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
  kickRange: 3.3,
  kickArc: Math.PI * 0.6,
  kickCooldown: 0.9,

  // Enemy
  enemyHealth: 100,
  enemyWalkSpeed: 3.1,
  enemyEngageRange: 17,
  enemyMaxRange: 46,
  enemyFireBase: 1.35,
  enemyDamage: 9,

  // Attackers fight from cover. Only one presses the attack at a time; the rest
  // crouch behind trees, the car and the crates, bounding forward cover to
  // cover, so the fight opens out instead of turning into a close-range brawl.
  coverSearchRadius: 20,
  coverPreferredRange: 15,
  // Cover is only cover at a distance; they never crowd into the player's lap.
  coverMinRange: 11,
  coverHoldMin: 4.5,
  coverHoldMax: 9,
  // While hiding they only snap off a shot if the player gets this close.
  coverFireRange: 8,
  // How long one attacker keeps coming before it falls back and another takes over.
  assaultDurationMin: 6,
  assaultDurationMax: 11,
  assaultGap: 2.4,
  firstAssaultDelay: 3.5,

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
  spawnMinRadius: 32,
  spawnMaxRadius: 48,

  maxAliveEnemies: 8,
  spawnInterval: 1.4,
  waveIntermission: 7,
  totalWaves: 10,
};

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
export const BOOT_TIERS = [
  { name: 'Standard Boot',     kills: 0,   meleeDamage: 55,  knockback: 13,  speedBonus: 0,    model: null,                color: '#c8b18d', socket: 'default' },
  { name: 'Reinforced Boot',   kills: 12,  meleeDamage: 66,  knockback: 14,  speedBonus: 0,    model: null,                color: '#9fd08a', socket: 'default' },
  { name: 'Silver Boot',       kills: 30,  meleeDamage: 82,  knockback: 16,  speedBonus: 0.05, model: 'silverboot.glb',    color: '#cfd6de', socket: 'silver' },
  { name: 'Gold Boot',         kills: 60,  meleeDamage: 105, knockback: 19,  speedBonus: 0.1,  model: 'goldboot.glb',      color: '#f2c94c', socket: 'gold' },
  { name: 'Spiked Gold Boot',  kills: 100, meleeDamage: 128, knockback: 26,  speedBonus: 0.1,  model: 'goldboot.glb',      color: '#e0912f', socket: 'gold' },
  { name: 'Tactical Doom Boot',kills: 150, meleeDamage: 150, knockback: 30,  speedBonus: 0.12, model: 'brokenboot.glb',    color: '#c0642b', socket: 'broken' },
  { name: 'Legendary Broken Boot', kills: 220, meleeDamage: 190, knockback: 38, speedBonus: 0.16, model: 'brokenboot.glb', color: '#a33b6b', socket: 'broken' },
  { name: 'Mythical Diamond Boot', kills: 300, meleeDamage: 220, knockback: 44, speedBonus: 0.18, model: 'diamondboot.glb', color: '#7fe6e0', socket: 'broken' },
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
