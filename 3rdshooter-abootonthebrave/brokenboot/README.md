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

- **Gunfire wounds first.** An attacker's health floors out at `bulletMinHealth`
  (6); no single burst drops them, and wounded attackers slow down and shoot less
  accurately.
- **Keep firing and they eventually bleed out.** Once an attacker is driven to
  the floor it starts a bleed-out timer (`bleedoutTime`, 15 s). Every extra hit
  takes `bleedoutHitPush` (0.8 s) off it, so putting one down with the rifle takes
  roughly a full magazine of tracking fire — and even then they stay on their feet
  for a couple of seconds. It is the slow, expensive way, and it kills them for
  good, so a patient player can win a war of attrition.
- **The boot is the fast way, and the way that earns boots.** A kick sends them
  screaming into the trees on contact. They run and despawn, and it counts as an
  elimination. One kick instead of twenty-odd rounds.
- **Tier credit is weighted accordingly.** A boot rout pays **1.0**; a gunfire
  downing pays `bulletKillWeight` (**0.25**). `player.tierCredit` — not the
  elimination count — is what unlocks tiers, so the boot is what actually levels
  the boots.
- **Boot tiers decide how much of a crowd breaks.** Tier 0–1 routes the single
  closest attacker, then 2, 3 and 4 at higher tiers, so upgrades translate
  directly into crowd control. Attackers in the arc beyond that limit take the
  boot's full `meleeDamage` (55 → 220 by tier), which floors them and leaves them
  bleeding out or ready to be routed by the next kick.
- **Hiding is temporary.** Attackers hold cover only while the player is making
  progress. If nothing is eliminated for `flushAfter` (6 s) the whole line breaks
  cover and charges at once — and the last `flushLastStandCount` (3) attackers of
  a wave never hide again. Any elimination buys them a fresh window of hiding.
  This is what stops a wave ending in a slow walk around the forest rounding up
  stragglers, which was the single biggest drag on the pace.
- **They keep coming.** Routed attackers being gone for good is fine because the
  next wave spawns more — the forest never runs out of brave soldiers.

Tiers unlock on tier credit: Standard → Reinforced → Silver → Gold → Spiked Gold →
Tactical Doom → Legendary Broken → Mythical Diamond, each raising melee damage,
knockback, the number routed per kick and movement speed. Reaching a tier lazily
loads its model and sockets it onto the officer's **right foot** bone.

Thresholds are set against the whole campaign, which totals 117 attackers, so a
single run is worth at most 117 credit. A good run reaches **Legendary Broken
Boot** (102) near the end; **Mythical Diamond** (116) needs a near-perfect,
boot-only clear. Measured in a full simulated clear: Reinforced 49 s, Silver
132 s, Gold 190 s, Spiked Gold 261 s, Tactical Doom 323 s, Legendary 385 s.

Each boot model carries its own fit in `BOOT_SOCKETS` — `size` for the model's
longest axis and `lift` to raise it until the sole rests on the ground. The
socket helper centres a model on the foot bone, so a lift is always needed; the
broken boot is deliberately the big one (0.38 against 0.34–0.36 for the rest).

## What else is implemented

- **Over-the-shoulder camera** that fires along the reticle axis, with cover-aware
  pull-in, recoil that recenters, and screen shake.
- **Attackers fight from cover, one at a time.** They spawn 32–48 m out and bound
  forward cover to cover — a spot on the far side of a tree, the car or a crate
  that breaks line of sight — crouching there behind the `crouch` clip. Exactly
  **one** attacker holds the assault token at any moment: it presses in, holds a
  firing line and shoots properly, while everyone else stays down and only snaps
  off a hurried close-range shot if the player walks right up to them. When the
  holder is routed, downed or its turn runs out it falls back and another steps
  out after `assaultGap`, preferring someone other than the last holder so the
  crowd takes turns.
- **Cover is fixed, not a chase.** Once the player is inside `coverPreferredRange`
  an attacker stops looking for new positions and holds where it is, so it can be
  closed down and kicked rather than leading the player around the forest.
- **Cover breaking is announced once per wave** (`THEY'RE MOVING`, or `LAST
  STAND` when it is the tail of a wave) so the HUD does not chatter every time
  they charge again.
- **Waves.** Ten waves sized `round(4 + wave * 1.4)` and capped at 18, staggered
  spawns, a cap of 9 alive at once, elite variants from wave 5, and an
  intermission with a tagline between waves. Measured clear times in a full
  simulated run: 21 s for wave 1 rising to ~50 s for the late waves, about seven
  minutes for the whole campaign.
- **Forest.** Instanced pines, a clearing, crates, barriers, rocks and parked cars
  used as cover — all with real collision.
- **A scanned environment.** `landscape_forest__mountains.glb` is a closed,
  canopy-textured photogrammetry dome. Standing inside it looks like a cave, so it
  is rendered once into a cubemap and used as the sky, then covered overhead by a
  gradient sky cap. Only its terrain band stays visible on the horizon.
- **Dynamic music.** The two supplied tracks are crossfaded as beds: one for the
  lulls, one for when there are attackers alive.
- **Loot.** Roughly a third of eliminations drop ammo, a fifth drop a field
  dressing, and an elimination while low on rounds always drops ammo so the
  player can never hard-stall. Drops drift toward the player from within 6 m so a
  dressing earned in a firefight is not lost in the grass.
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
- Boot fits in `BOOT_SOCKETS` are hand-tuned for this rig's `mixamorigRightFoot`
  bone; a different skeleton would need new `size`/`lift` values.
- The bleed-out floor means a patient player can clear a wave from cover without
  ever closing to melee. It is slow and ammo-hungry by design, but it is a
  legitimate strat.
- Wave composition is flat: no scripted set-pieces or boss encounters yet.
