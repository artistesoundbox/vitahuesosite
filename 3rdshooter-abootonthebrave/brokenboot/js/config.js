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

  // Combat
  maxHealth: 100,
  magSize: 30,
  reserveStart: 150,
  reloadTime: 1.7,
  fireInterval: 0.105,
  // Gunfire wounds attackers but never finishes them; the boot does that.
  bulletDamage: 24,
  bulletMinHealth: 6,
  headshotMultiplier: 2.2,
  bulletRange: 140,
  spread: 0.012,
  recoil: 0.9,

  // Boot
  kickRange: 3.3,
  kickArc: Math.PI * 0.6,
  kickDamage: 55,
  kickKnockback: 13,
  kickCooldown: 0.9,

  // Enemy
  enemyHealth: 100,
  enemyWalkSpeed: 3.1,
  enemyEngageRange: 17,
  enemyMaxRange: 46,
  enemyFireBase: 1.35,
  enemyDamage: 9,

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

  // Spawn ring for attackers, measured from the player.
  spawnMinRadius: 24,
  spawnMaxRadius: 46,

  maxAliveEnemies: 12,
  totalWaves: 10,
};

// Third-person body for the SWAT officer. 3rdpersonidle.fbx carries the mesh.
export const PLAYER_SOURCE = {
  mesh: '3rdpersonidle.fbx',
  clips: {
    walk: '3rdpersonshootwalking.fbx',
    aim: '3rdpersonshootstanding.fbx',
    crouch: '3rdpersonshootcrouch.fbx',
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

// Boot progression. `model` is lazily loaded the first time a tier is reached.
export const BOOT_TIERS = [
  { name: 'Standard Boot',     kills: 0,   meleeDamage: 55,  knockback: 13,  speedBonus: 0,    model: null,                color: '#c8b18d' },
  { name: 'Reinforced Boot',   kills: 12,  meleeDamage: 66,  knockback: 14,  speedBonus: 0,    model: null,                color: '#9fd08a' },
  { name: 'Silver Boot',       kills: 30,  meleeDamage: 82,  knockback: 16,  speedBonus: 0.05, model: 'silverboot.glb',    color: '#cfd6de' },
  { name: 'Gold Boot',         kills: 60,  meleeDamage: 105, knockback: 19,  speedBonus: 0.1,  model: 'goldboot.glb',      color: '#f2c94c' },
  { name: 'Spiked Gold Boot',  kills: 100, meleeDamage: 128, knockback: 26,  speedBonus: 0.1,  model: 'goldboot.glb',      color: '#e0912f' },
  { name: 'Tactical Doom Boot',kills: 150, meleeDamage: 150, knockback: 30,  speedBonus: 0.12, model: 'brokenboot.glb',    color: '#c0642b' },
  { name: 'Legendary Broken Boot', kills: 220, meleeDamage: 190, knockback: 38, speedBonus: 0.16, model: 'brokenboot.glb', color: '#a33b6b' },
];

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
