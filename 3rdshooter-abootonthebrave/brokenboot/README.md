# A Broken Boot On The Brave — playable build

A third-person action shooter set in a dense forest. One SWAT officer, waves of
attackers, parked vehicles for cover, and a combat boot that gets more broken —
and more feared — the longer the fight goes on.

This folder is the game. The art it loads lives one level up, alongside it.

## Running it

```bash
cd brokenboot
node serve.mjs          # http://127.0.0.1:8177/brokenboot/index.html
```

`serve.mjs` serves the **repository root** (not just this folder) so the page can
load the models with `../`. It sets the correct MIME types for `.fbx`, `.glb`,
`.mp3` and the rest, and sends `Content-Length` so the loading bar is honest.

Opening `index.html` straight from disk will not work: browsers block ES modules
and asset fetches over `file://`.

## Controls

**Keyboard and mouse**

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint |
| `Space` | Jump |
| Mouse | Aim (click once to capture the pointer) |
| Left mouse (hold) | Fire |
| `R` | Reload |
| `F` | Boot kick |
| `M` | Mute |
| `Esc` | Release the cursor (pauses) |

**Xbox-style controller** (detected automatically — no pointer capture needed)

| Input | Action |
| --- | --- |
| Left stick | Move (push to the edge to sprint) |
| Right stick | Aim |
| `RT` | Fire |
| `LT` / `L3` | Sprint |
| `A` | Boot kick |
| `B` | Reload |
| `Y` | Jump |
| `X` | Mute |
| `Menu` | Release the cursor |

**Touch / phone**

Left thumb pad moves, dragging anywhere on the right half aims, and the round
buttons fire, kick, jump and reload. Sprint is automatic when the stick is pushed
past ~85%. The compact HUD and the on-screen pad appear automatically on coarse
pointers, and the layout adapts to portrait and short-landscape phones.

## The combat model

This is the heart of the design, and it is deliberately unusual:

- **Gunfire only wounds.** Bullets can never finish an attacker off — health
  floors out at `bulletMinHealth` (6). Wounded attackers slow down and shoot less
  accurately. You can hold a whole wave at bay with the rifle, but you will never
  clear it.
- **The boot is the only way to remove an attacker.** A kick sends them screaming
  into the trees; they run and despawn, and they count as an elimination. The kick
  still applies knockback and a strike effect to everyone else caught in the arc.
- **Boot tiers decide how much of a crowd breaks.** Tier 0–1 routes the single
  closest attacker, then 2, 3 and 4 at higher tiers, so upgrades translate
  directly into crowd control.
- **They keep coming.** Routed attackers being gone for good is fine because the
  next wave spawns more — the forest never runs out of brave soldiers.

Tiers unlock on total eliminations: Standard → Reinforced → Silver → Gold →
Spiked Gold → Tactical Doom → Legendary Broken, each raising melee knockback,
the number routed per kick and movement speed. Reaching a tier lazily loads its
model and sockets it onto the officer's right foot bone.

## What else is implemented

- **Over-the-shoulder camera** that fires along the reticle axis, with cover-aware
  pull-in, recoil that recenters, and screen shake.
- **Attackers** cloned from one skinned template: separation, obstacle avoidance,
  line-of-sight checks before firing, strafing at range, and a share that charge in.
- **Waves.** Ten waves, staggered spawns, a cap on how many are alive at once,
  elite variants from wave 5, and an intermission with a tagline between waves.
- **Forest.** Instanced pines, a clearing, crates, barriers, rocks and parked cars
  used as cover — all with real collision.
- **A scanned environment.** `landscape_forest__mountains.glb` is a closed,
  canopy-textured photogrammetry dome. Standing inside it looks like a cave, so it
  is rendered once into a cubemap and used as the sky, then covered overhead by a
  gradient sky cap. Only its terrain band stays visible on the horizon.
- **Dynamic music.** The two supplied tracks are crossfaded as beds: one for the
  lulls, one for when there are attackers alive.
- **Loot.** Ammo and field-dressing drops; an elimination while low on rounds
  always drops ammo so the player can never hard-stall.
- **HUD.** Health, ammo, wave, hostiles, eliminations, boot kills, tier progress,
  damage vignette, hit markers, banners, achievement toasts and an end screen.

## How it fits together

```
brokenboot/
├── index.html          Markup, import map and all HUD/overlay/touch DOM
├── css/
│   ├── style.css       HUD and screens
│   └── touch.css       Touch pad and the compact phone HUD
├── js/
│   ├── main.js         Boots the game, drives loading progress, start button
│   ├── config.js       All tunables, asset paths, boot tiers, achievements
│   ├── game.js         Renderer, loop, camera rig, combat resolution, waves
│   ├── input.js        Keyboard/mouse + gamepad + touch, unified
│   ├── assets.js       FBX/GLTF loading, rig normalisation, anim state machine, bone sockets
│   ├── world.js        Forest, cover, collision, raycasting, scanned skybox
│   ├── player.js       Movement, jump, animation states, weapons, boot tiers
│   ├── enemy.js        Attackers, wounding/routing, wave and spawn manager
│   ├── effects.js      Pooled tracers, muzzle flash, sparks, loot pickups
│   ├── hud.js          DOM HUD and overlays
│   ├── audio.js        Synthesised SFX and the two-track music director
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
| `3rdpersonjump.fbx` | Jump clip. |
| `3rdpersonkick / kickhigh / stomp.fbx` | Boot attack clips. |
| `attackerIdle.fbx` | **Attacker.** Skinned body + idle clip. |
| `attackershootwalking/standing/crouch.fbx` | Attacker clips. |
| `ak-47.glb` | Rifle, socketed to the right hand bone. |
| `silverboot / goldboot / brokenboot / diamondboot.glb` | Boot tier models. |
| `suggan_53_...glb` | Car, reused as cover. |
| `landscape_forest__mountains.glb` | Scanned environment, used as the sky cubemap. |
| `abrokenbootonthebraveposter.jpg` | Start screen art. |
| `A Broken Boot On The Brave*.mp3` | Music beds. |

Every rig in the set uses the `mixamorig:` bone namespace, which is why clips can
be freely cross-applied between the player and the attackers.

## Asset size and hosting

`3rdpersonidle.fbx` is ~115 MB, which is over GitHub's 100 MB file limit. It is
therefore tracked with **Git LFS**:

```
3rdshooter-abootonthebrave/3rdpersonidle.fbx filter=lfs diff=lfs merge=lfs -text
```

The commit stores a 134-byte pointer, and the real payload lives in LFS storage.
Two consequences worth knowing:

- Anyone cloning needs `git lfs install` once, or the model arrives as a pointer.
- **GitHub Pages does not serve LFS content.** On the published site that path
  returns the pointer text, so the player model would fail to load.

The fix for the live site is to convert the character (and the 12 MB attacker) to
optimised GLB with downscaled textures and commit those normally — a few MB each,
well inside the limit and perfectly servable. That also removes the long first
download, which is the single biggest remaining improvement.

`tactical_transport_truck_baked_pbr.glb` (~56 MB) is deliberately unused.

## Known limitations / next steps

- No crouch, no aim-down-sights, and weapon pickups are limited to the AK.
- Achievements are a subset of the design document.
- Boot placement on the foot bone is tuned by eye; a different rig may need new
  offset/rotation values in `player.js`.
- Wave composition is flat: no scripted set-pieces or boss encounters yet.
