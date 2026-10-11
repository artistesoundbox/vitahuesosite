# A Broken Boot On The Brave — playable build

A third-person action shooter set in a dense forest. One SWAT officer, waves of
attackers, parked vehicles for cover, and a combat boot that gets more broken —
and more dangerous — the longer the fight goes on.

This folder is the game. The art it loads lives one level up, alongside it.

## Running it

```bash
cd brokenboot
node serve.mjs          # http://127.0.0.1:8177/brokenboot/index.html
```

`serve.mjs` serves the **repository root** (not just this folder) so the page can
load the models with `../`. It sets the correct MIME types for `.fbx`, `.glb`,
`.mp3` and the rest, and sends `Content-Length` so the loading bar is honest.

Opening `index.html` directly from disk will not work: browsers block ES modules
and asset fetches over `file://`.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint |
| Mouse | Aim (click to capture the pointer) |
| Left mouse (hold) | Fire |
| `R` | Reload |
| `F` | Boot kick |
| `M` | Mute |
| `Esc` | Release the cursor (pauses) |

## What is implemented

- **Third-person combat.** Over-the-shoulder camera, hitscan rifle with headshot
  multiplier, spread, reloading, recoil that recenters, and a magazine/reserve split.
- **The boot.** `F` launches a kick that damages and knocks attackers back. Boot
  tiers unlock on total eliminations (Standard → Reinforced → Silver → Gold →
  Spiked Gold → Tactical Doom → Legendary Broken) and each raises melee damage,
  knockback and movement speed. Reaching a tier lazily loads its model and sockets
  it onto the officer's right foot bone.
- **Attackers.** Cloned from a single skinned template, with separation, obstacle
  avoidance, line-of-sight checks before firing, strafing at range and a share of
  them charging in close.
- **Waves.** Ten waves, staggered spawns, a capped number alive at once, elite
  variants from wave 5, and an intermission with a tagline between waves.
- **Forest.** Procedural instanced pines, a clearing, crates, barriers, rocks and
  parked cars used as cover with real collision.
- **Loot.** Ammo and field-dressing drops; a kill while low on rounds always drops ammo.
- **HUD.** Health, ammo, wave, hostiles, kills, boot kills, boot tier progress,
  damage vignette, hit markers, banners, achievement toasts and an end screen.
- **Audio.** Synthesised gunfire, impacts, kicks and stings, plus one of the two
  supplied music tracks on loop.

## How it fits together

```
brokenboot/
├── index.html          Markup, import map and all HUD/overlay DOM
├── css/style.css
├── js/
│   ├── main.js         Boots the game, drives loading progress, start button
│   ├── config.js       All tunables, asset paths, boot tiers, achievements
│   ├── game.js         Renderer, loop, camera rig, combat resolution, waves
│   ├── assets.js       FBX/GLTF loading, rig normalisation, anim state machine, bone sockets
│   ├── world.js        Forest, cover, collision and raycasting
│   ├── player.js       Movement, animation states, weapons, boot tiers
│   ├── enemy.js        Enemy actor and the wave/spawn manager
│   ├── effects.js      Pooled tracers, muzzle flash, sparks, loot pickups
│   ├── hud.js          DOM HUD and overlays
│   ├── audio.js        Synthesised SFX and music
│   └── mathx.js        Damping helpers
├── serve.mjs           Local static server
└── vendor/             Three.js r186 (module + the loaders it needs)
```

Three.js is vendored rather than pulled from a CDN so the page works offline and
on static hosting with no build step. `vendor/three/three.core.js` must stay next
to `three.module.js`; `vendor/addons/` keeps the relative layout the addons expect.

## Models used

| Asset | Role |
| --- | --- |
| `3rdpersonidle.fbx` | **Player.** The only skinned SWAT body; carries the idle clip. |
| `3rdpersonshootwalking/standing/crouch.fbx` | Player locomotion and aim clips. |
| `3rdpersonkick / kickhigh / stomp.fbx` | Boot attack clips. |
| `attackerIdle.fbx` | **Attacker.** Skinned body + idle clip. |
| `attackershootwalking/standing/crouch.fbx` | Attacker clips. |
| `ak-47.glb` | Rifle, socketed to the right hand bone. |
| `silverboot / goldboot / brokenboot / diamondboot.glb` | Boot tier models. |
| `suggan_53_...glb` | Car, reused as cover. |
| `abrokenbootonthebraveposter.jpg` | Start screen art. |
| `A Broken Boot On The Brave*.mp3` | Music. |

Every rig in the set uses the `mixamorig:` bone namespace, which is why clips can
be freely cross-applied between the player and the attackers.

## Known limitations / next steps

- **Load weight.** `3rdpersonidle.fbx` is ~115 MB and the attacker ~12 MB, so the
  first visit is a long download. Converting both to optimised GLB with downscaled
  textures would cut this by roughly an order of magnitude and is the single
  biggest win available. Note this asset is tracked with Git LFS, and GitHub Pages
  serves LFS *pointers* rather than file contents — so an optimised, normally
  committed GLB is the right thing to ship to the live site.
- `landscape_forest__mountains.glb` (15 MB, 7380 nodes) is not loaded yet. It is a
  photogrammetry scene with no collision data, so it needs a separate simplified
  collision layer before it can replace the procedural forest.
- The 56 MB `tactical_transport_truck_baked_pbr.glb` is deliberately unused.
- Boot placement on the foot bone is tuned by eye; a different rig may need new
  offset/rotation values in `player.js`.
- No crouch, no jump, no weapon pickups beyond the AK, and achievements are a
  subset of the design document.
