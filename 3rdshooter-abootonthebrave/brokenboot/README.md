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

## Testing it

`npm test` plays the whole campaign in a real headless Chrome and reports what
happened — wave by wave, then the boot tiers and the escalations that were meant
to happen:

```bash
npm test                # full campaign, officer kept on their feet for pacing
npm run test:honest     # same, but the officer can die, and the report says where
npm run test:aim        # assert the aim-trigger rule (press retargets, hold keeps)
npm run test:kick       # assert the three kicks, the scenery and the impact feel
npm run test:dry        # play a whole wave with no ammunition left, booting only
npm run test:fuzz       # ten campaigns, one per seed and one forest each: name
                        # any seed that cannot finish a wave
npm run test:forest     # fifteen forests, audited without playing: could a wave
                        # be fought in each one? Reports what has moved since the
                        # recorded spread of the same metrics
npm run test:forest-record  # the same sweep, recorded as the spread later sweeps
                            # are compared against for having got tighter
npm run test:character  # audit the officer: weighted, anchored, rifle in hand, and
                        # drawn standing on the ground in every state he can be
                        # posed in, still carrying a boot a tier can replace
npm run test:fatality   # shoot an attacker down through the head and then through
                        # the chest: only the head throws the body, and both pay the
                        # same tier credit
npm run test:platforms  # climb the floating islands: every rung jumped and none
                        # walked up, the war blind to them, their crates out of reach
                        # from the ground, and the marksman on the low cap — seen from
                        # the clearing, unkillable by gunfire, booted off only from up
                        # there, and paying for it with his kit
npm run test:probes     # those mechanic checks and both audits, one page load
```

There is no test framework and no new dependency: the runner is a small CDP
client (`node:http` + Node's built-in `WebSocket`) that launches Chrome, serves
the repo, and evaluates [`test/driver.js`](test/driver.js) in the page. The driver
drives the *real* `InputManager` — a stub pad for the trigger and aim tune, the
keyboard map for movement — and then calls the game's own per-frame `step()`, so a
passing run means the game really is playable through the interfaces a player
uses. It exits non-zero and names the wave when something is wrong, and the last
report is always left in `test/campaign-report.json`.

What it treats as a failure: a wave that cannot finish (a stall watchdog on
eliminations, which snapshots whoever is left, whether they can see the player
and whether the pilot is even firing), an error or a failed request from the
page, a frame cap reached mid-campaign, pacing that has moved more than 40%
against a recorded baseline, a forest that a wave could not be fought in, and —
when one is asked for — any mechanic probe or character audit whose own assertion
does not hold. A death is a datapoint, not a failure, unless
`--require-finish` is passed — and since victory and death are the same terminal
state on screen, the end-screen title is what decides which one it was.

It also reports something a stall does not catch: the **quietest stretch** of each
wave, the longest spell with no elimination. That is what turned up a 206 s wave 9
whose neighbours all took under 45 s — a pilot parked in a blocked pocket with no
line to anyone, which made the instrument wrong rather than the game. The same
single number is what would flag a real one.

Two pilot rules came out of exactly that class of finding, and both are
corrections to the pilot rather than to the game. An officer with no rounds
anywhere has no rifle left, so a dry pilot closes and uses the boot instead of
holding a firing line it cannot shoot from — dry, at range, with the trigger
down, it could not end a wave at all, and the report said so (`playerAmmo: [0,
0]` beside a full-health attacker). And the retreat rule only applies while an
attacker is actually on it: a hurt pilot backing away from someone eighty metres
off with no line of sight to anyone just walks the map and never finishes the
wave. Neither changes the game, only the scripted player — which is the point,
since the pilot is standing in for someone who wants to win.

`npm run test:fuzz` is the check that neither of those mistakes can hide again.
The campaign is deterministic per seed, which is what makes runs comparable — and
also what lets a deadlock hide: one draw can come out clean while the next ends in
a wave that never closes. So `--fuzz[=N]` plays the campaign once per seed (the base
seed, then a spread of others), reloading the page between them, because the game
does not reset itself and a fuzz that reused one page would be measuring the
leftovers of the last. It names every seed that failed and why — the wave, how long
it hung, what the officer had left to shoot with, and whoever was still standing
with their health and whether they could see anyone. Each seed costs about twelve
seconds, which is mostly reloading a 140 MB forest.

Every fuzzed seed also gets a **forest of its own**. The layout is built from one
seed (`worldSeed`, the 165 pines, the crates, the barrels, the sandbags, the rocks
and the three tanks all come out of the same stream), and the harness passes each
seed's own value
as `?worldSeed=N`, so a fuzz run explores terrain as well as decisions — different
cover, different firing lines, different places to get wedged. The page reports the
seed it was built with and a `layoutHash` folded from every placed object, so the
report names the forest as well as the campaign, and `--world-seed=N` replays one
of them on its own. A layout hash settles *that* two fields differ, never how: every
run also reports a **dressing fingerprint**, read off the props that were actually
loaded rather than off the config — each kind, how many of it, and the model files
with the size the fit measured in their own units. Both baselines record it, which is
what lets a set of figures measured on one field be recognised in another; it is
deliberately blind to the balance figures (a crate's mass is what a kick is divided
by, so retuning it is the same field with a different fight) and to where the props
stand, which is the layout's business. The fuzz checks its own premise too: if two seeds ever built
the same layout it fails outright, because that would mean it had silently stopped
fuzzing the terrain at all.

It found the dry-officer deadlock the moment it was written: with that fix
deliberately taken back out, four of the five seeds stalled, every one of them with
the officer at `[0 in the mag, 0 reserve]` and a lone attacker at full health,
unwounded, in plain view. That is the shape of the whole point — the default seed's
campaign was the one the single-run check would have reported on.

With terrain in the mix the sags moved as well: across ten seeds and ten forests the
quietest stretch of any wave runs from 11 s to 19 s, every campaign of the ten cleared
(386.9 s to 444.2 s), and no one of them is visibly the most forgiving — same game,
same pilot, so the layout is what changed, which is the argument for fuzzing it.

The fuzz is also where the last two pilot deadlocks were found rather than guessed at.
The posts gave it a new one: an officer with no rounds anywhere walking at a marksman
he has no sight of, wedged against the same trunk inside the tree line, reversing for
1.8 s, running straight back into it, and doing that until the watchdog called the
wave stalled — on two seeds, with the marksman unharmed at full health 20-odd metres
away. The pilot learns now: a wedge at the same spot buys a longer reversal and then a
stretch of walking *round* rather than at what stopped it, which is what a player does
the second time they bounce off the same tree. Two more seeds exposed the climb itself,
where the post carried no radius and the pilot's 1.4 m fallback guess sent it at a cap
1.55 m wide; all ten seeds now finish every wave, in ten different forests.

`npm run test:forest` asks the terrain question on its own, without playing
anything. `--check-forest[=N]` rebuilds N forests (the spread of seeds a fuzz would
play, plus the one the page booted with) and asks of each: is the ground an officer
and an attacker could both stand on **connected**? Attackers appear in a ring 26-38 m
out and from then on only steer at the officer, sliding along whatever they bump
into, so a spawn ring walled off from the clearing is a wave that cannot end however
well it is played — and a stall report cannot tell that apart from a slow pilot.
The audit samples the collision geometry the game itself moves and shoots against
(`world.cylinders`, `world.boxes`) on a 25 cm grid, with a cell standable only if a
0.55 m body fits clear of every blocker, then floods outward from the officer's own
spawn point. Five things have to hold, with the whole spread of real forests well
inside each one:

| what | floor | the real forests |
| --- | --- | --- |
| ground the officer and attackers can both reach | 6,000 m² | 10,320-10,398 m² |
| clear space around a point on the fighting ground | 1.5 m | 2.7-3.3 m |
| standable share of the clearing | 60% | 75-83% |
| reachable share of the 26-38 m attacker spawn ring | 90% | 100% |
| sealed-off ground the size of a hiding place (9 m²) | none | none at all |

The fighting ground is the ring from the edge of the clearing out to the far side
of the spawn ring, and its mean clearance is the number that catches a cramped
forest. The widest clear circle is no use for that: the clearing is empty by
construction, so it always holds a large one.

Two things keep the audit from being a number that only ever agrees. Inside every
sweep it is first run on an empty field and on a clearing sealed by a wall of
trunks, and it has to call one fair and the other unfair — otherwise the report
says so and the run fails. And the sweep checks its own premise: the seed the page
is booted with is rebuilt and must hash to the layout the page is playing, or the
whole sweep is auditing forests nobody fights in.

The audit is not confined to this command: `npm test`, the fuzz and the mechanic
probes each report the forest they played, and a fuzz run grows a `terrain` column
beside every seed.

The check was falsified against the real generator, twice. Sealing the clearing
with a wall of barriers moved the spawn ring's reachable share to 0%, left an
8,789 m² pocket behind it and cut the ground to 1,196 m² — `test:forest` named both
forests and exited 1. The first attempt only put 140 barriers in the wall, at
random angles, and the audit called it fair: the gaps left were wider than a body,
and attackers really could walk in — the forest was fair, and the audit said so.
The second falsification was density rather than a wall: raising `treeCount` from
165 to 900 (676 placed before the sampler ran out of attempts) took the mean room
on the fighting ground from 3.3 m to 1.01 m, and that alone was enough to fail it.
The floors answer "could a wave be fought in this forest at all?", which leaves a
gap: a forest that stays above every one of them while getting noticeably **tighter**
is the state that precedes one falling through a floor, and its verdict is still
`fair`. So the metrics themselves are recorded. `npm run test:forest-record` (or
`--check-forest --record-forest`) writes every audited forest's numbers, the floors
in force and the control's verdict to `test/campaign-forest-baseline.json`, and from
then on every sweep prints what moved against it: per metric the spread's minimum and
mean (min / mean), and per forest every metric that moved by more than ten percent —
as `tighter` or `looser` — with the layout hash whenever the generator itself moved
and the tree and prop counts as the usual cause. Ten percent is the noise floor: the
audit is deterministic, so two sweeps of one generator agree exactly, while a change
of density moves a healthy forest by tens of percent. A baseline also serves as a
record of the floors, so a floor that moves is named as well — and as a record of the
dressing every forest in it was built with, named on both sides above the drift
table, so a spread measured on one field is never compared against another one
silently. What the recorded spread is now, after the dressing swap, the cabin and the
marksman (see the note at the end of this file): `connected ground 10209 / 10253 m²`,
`elbow room 2.60 / 2.89 m`, `clearing standable 71 / 77%`, `spawn ring reachable
100 / 100%`, `widest clear circle 16.36 / 19.36 m`, all sixteen forests `fair`, on 165
trees and 29 props. The spread before it — thirty props, layouts
`820b292e`…`1a9c3d22` — is gone rather than kept: three of its sixteen forests could
not be fought in at all, and it carried no dressing record either, which is why the
harness now reads one.

Drift is reported rather than failed. A generator change is sometimes deliberate, and
the forests may all still be fair — it is the trend that has to be visible, not the
verdict, and `--record-forest` accepts it. Falsified both ways against the real
generator. Raising `treeCount` from 165 to 240 took the mean room on the fighting
ground from 2.93 m to 2.33 m and the widest clear circle from 19.3 m to 15.8 m while
every forest stayed above every floor: the sweep passed, and reported `elbow room
2.67 / 2.93 m → 2.06 / 2.33 m, -20.3% TIGHTER` with all 16 forests named. Dropping it
to 100 reported `+30.2% looser` and nothing tighter. Both were reverted, and the
recorded baseline is the 165-tree spread.

Both sweeps keep their evidence: `test/campaign-forest.json` holds every audited
forest with its metrics, its verdict, the control's and the drift against the
baseline, `test/campaign-forest-baseline.json` is the spread those sweeps are
compared against, and `test/campaign-fuzz.json` carries each seed's `terrain` verdict
beside its campaign.

`npm run test:character` asks the one question none of the numbers above can: is
the officer's own mesh file still fit to be worn? It audits the *loaded* model, so
it sees exactly what three.js sees, and every clause names the part, the bone or the
pose it failed on. Five things have to hold:

| what | limit | the file as shipped |
| --- | --- | --- |
| skinned vertices carrying no weight at all | none | none, in 4,086 sampled |
| a mesh bound to one distant bone, weighted 1.0 | 2% of the mesh, 0.6 m off that bone | 0.0% — the body is blended across three or four bones, and the furthest a rigidly bound vertex sits from its own bone is 0.38 m |
| the officer's own boot, when his file carries one | on a foot bone, on the ground, and hidden while a tier's boot is on | not applicable: this export is his body alone, `bindRigidParts` registers no loose part at all, and the clause reports that rather than passing silently |
| every tier's boot, on the foot it is socketed onto | it must contain the whole foot, and its sole must stand on the ground | all eight tiers: 100% of his foot vertices inside, sole within 0.000–0.002 m of the grass, at the exact size asked for (0.52 → 1.00 m) |
| the boot he is wearing when the game starts | socketed at tier 0 without any tier ever moving | Standard Boot, 0.52 m, sole at 0.000 m, 100% of his foot inside |
| where he is actually drawn, in every state he can be posed in | the lowest drawn point must stay inside a −0.15…0.35 m band of the ground | all eight states stand: 0.013–0.019 m |
| the rifle in his right hand, in the poses he holds it in | barrel within 60° of his facing, muzzle at least 0.3 m ahead of his hand, magazine under it | walk 7°, aim 13°, crouch 39° off his facing; muzzle 0.53–0.61 m ahead; magazine under it in all three |

The own-boot row is deliberately conditional: the file he ships in now carries his
body alone, so there is no own boot for a tier to socket over, and the clause says
so instead of failing on a property his mesh cannot have. It becomes a real test the
moment an export carries `Object_3` again — the boot the game is named after, which
the tiers replace — and that is an asset change, not a code one.

The tier-boot clauses are what replaced it, and they are the ones that caught this
feature's real defects. Three of them, none of which the first version of the probe
could see because it forced every tier to move and only ever measured a box in world
axes:

- **He started barefoot.** Boots are loaded when the tier *moves*, and at spawn the
tier is already 0 — so tier 0 never equipped anything and the first boot a player
could see was the second tier's. The probe now measures the boot he is wearing
*before* anything is moved, and removing the spawn equip makes `test:character`
exit 1 naming exactly that.
- **The socket's size was measured in world axes.** A rotated model's box is the
union of its meshes' boxes, which overstates it: a boot asked for at 0.52 m came out
0.41 m, so the bigger tiers were not merely big, they were smaller than asked while
their sole floated up to his ankle. The helper now measures real vertices
(`precise`) in the bone's own frame, which also makes the fit a property of the
model rather than of the pose it was attached in.
- **The fit clause was reading the same inflated box.** It now asks whether the
boot contains his foot *in the foot's own frame*, where the box is the boot's real
extent — a third smaller than the world-axis box that was passing it.

The control is a boot shrunk to 55%: the same measurement leaves 0% of his foot
inside it, so a boot too small to wear would be named rather than waved through.

It audits the officer **as he loads**, before any other probe has moved him: a kick
clip scale-tracks the legs, and geometry bound to a bone is only a fixed distance
from it in the pose it was authored in, so the numbers are only comparable on the
figure nothing has posed yet.

The footing clause is the one that watches him *move*, and it exists because a rig
can be weighted flawlessly and still not be on screen. The clip files carry the
rig's own travel baked into the root bone, and they are not all authored in the
units — or for the skeleton — that this mesh wears: the officer's embedded idle
clip moves the hips in metres while the walk, aim, crouch, jump and kick files move
them in centimetres. Left on the root, the larger values throw the whole body out of
the world the moment a state other than idle comes up — a walk that plays metres
underground, an aim that floats metres overhead — and every other number here stays
healthy while it happens, because the fight goes on and the officer's recorded
position never moves. So each state is posed alone and sampled right across its
cycle, and its lowest drawn vertex is measured against the ground. A blended rig is
not measured: a crossfade draws a body neither clip poses, and an action left at
zero weight writes nothing, so the states are silenced one at a time and the one
being measured is held at full weight.

The probe carries its own control, because a threshold is only worth having if it
tells the failure from the normal case. The footing measurement has to follow the rig
it is looking at, so the officer is lifted a metre and the reading has to rise a
metre with him; a measurement taken against a pose nothing re-skins returns the same
height whatever the body does, and a pass from it would say nothing.

The same edit that breaks the mesh clauses shows the footing clause failing on its
own, when the clips are left as they are shipped:

```
FAIL
  - the officer's mesh file: walk draws him at -1.523 m; aim draws him at 3.932 m;
    crouch draws him at -2.681 m; jump draws him at -7.129 m; kick draws him at
    -0.978 m, outside the -0.15..0.35 m band a standing officer stays in
```

An officer who walks a metre and a half into the ground and aims four metres up in
the air is invisible from the camera the game gives the player, and none of the
campaign's own numbers notice.

The rifle clause watches the one part of him that is not his own mesh. The rifle is
welded into his right hand, so the whole fit is a single rotation in the hand's own
frame — and that frame is not the world's: in every clip he holds the weapon in, the
hand's own +Y points forward and its −X up, while down a plain idle that same +Y
hangs at his side. A model left unrotated lies along the hand's X instead, which
stands the rifle upright through his fist and aims it at the sky the moment he
raises it. Nothing else in the campaign can see that: he still fires, still hits,
still kills, and the only symptom is a soldier sighting down a rifle that is not in
his hands.

The barrel is measured, never assumed. The two ends of the rifle are compared by
cross-section and the thinner one is taken as the muzzle — a rifle mounted backwards
would otherwise sail through every clause here — and the magazine is found as the
side the geometry reaches furthest from the bore line at that muzzle, which is what
tells a rifle held the right way up from one held upside down. Both are read fresh
for the control, because a rifle left unrotated is a *different* shape in the hand's
frame: measuring the mounted one's axes against an unrotated mount would only report
the mount back to itself. Left as authored, the same measurement reads **89° off his
aim with the muzzle 0.24 m from his hand**, and the clause names it:

```
FAIL
  - the officer's mesh file: walk: its barrel points 87° off his facing, not at what
    he is facing and its muzzle sits 0.1 m from his hand instead of in front of it
    and its magazine is not hanging underneath; aim: its barrel points 89° off his
    facing ... crouch: its barrel points 126° off his facing ...
```

The cone is deliberately wide. A hand carrying a rifle swings it well off the aim
line while crouching, and 39° is that swing; what the clause has to separate is a
rifle held at his shoulder (7–13° in the clips he shoots from) from the one standing
upright through his fist (89°).

Holding it is not the same as firing from it, so the audit fires one round and looks
at where the flash lands. The flash and the tracer's first frame used to hang off a
point in front of his chest, on the camera's yaw — a place no rifle is ever at, and
**0.648 m from the barrel** while he aims. They now hang off the rifle's own tip,
which `socketRifle` measures the same way the size and the mount are measured: the
vertex the model reaches furthest along its own muzzle direction, so the tip of the
barrel is read off the geometry instead of offset by a number that fits one rifle.
The bullet itself is still cast from the camera, because what the crosshair covers
has to be what it hits, whatever the rifle is doing.

Both are measured, not just the flash: the tracer is a line laid from the same point,
and its own start is read back off the mesh, so a change that moved one and not the
other is still caught. The probe's shot is fired at the sky, so nothing it might have
hit is disturbed, and the ammunition, the timers, the recoil, the shake and the
camera are all put back afterwards. The measurement reads **0.005 m from the tip for
both the flash and the tracer** — on the barrel — and its control is that same
stand-in: it sits 0.649 m off the tip, so the clause would name the failure it was
written against rather than pass on it.

The probe carries a second control, because a threshold is only worth having if it
tells the failure from the normal case. An unweighted vertex is bound to bone 0, and
bone 0 of this rig is `mixamorigHips`, so the audit asks what would have become of
the boot it just measured: **64% of the officer's own boot vertices sit more than
0.6 m from the hips**, well over the 2% budget, which means a boot joined into the
body and welded there would be named rather than waved through. The control has to
say so, and a control with no own boot to measure — the joined case — reports that
instead of inventing a verdict.

That is not hypothetical. Joining the big boot into the body mesh and re-exporting
the officer is one edit that breaks all three clauses at once, and `test:character`
names each of them:

```
FAIL
  - the officer's mesh file: 71.9% of Ch15 is welded to mixamorigHips, up to
    1.046 m off that bone against a 0.6 m limit; nothing in the officer counts as
    his own boot, so a tier's boot is worn over it instead of replacing it
```

Two thirds of the mesh riding the pelvis, and no boot left that a tier can replace.
The same file reports **nothing unweighted**, which is the whole reason the weld
clause exists: an unweighted vertex does not stay unweighted — three.js rescues it
by binding it to bone 0 — so "no unweighted vertices" is not by itself evidence of a
sound rig.

`npm run test:dry` is the regression check for the first of them. It plays a
whole wave for real — same patched step, same pilot, same wave one — with the
officer's rounds taken away *every frame*, so nothing it kills can resupply it
and the entire wave has to be won with the boot. It fails if the wave never ends,
if the officer never closed to boot range, or if anything other than the boot did
the removing. Against the deadlocking pilot it reports a 60 s limit reached with
all five attackers still standing at full health; with the fix it clears the wave
in about 20 s, five eliminations, all of them booted.

`--honest` is the interesting mode for balance work, since it reports where a
scripted pilot died rather than protecting them. `--waves=N`, `--seed=N`
(default 20260411, for comparable runs measured with the fixed-timestep step),
`--wave-limit=S` and `--headed` are all worth knowing about; `--help` lists the
rest, including `--baseline` / `--record` for noticing when a tuning change moves
the pacing. A baseline records the field its times were measured on as well as the
times: the world seed, the layout hash and the dressing fingerprint. A run compared
against a baseline from another field says so — `← A DIFFERENT FIELD` in the table
and a finding under *Worth knowing* — rather than having its differences read as
pacing drift, which is the mistake a dressing swap invites. The current baseline,
re-recorded after the CC0 dressing went in: 400.82 s over the ten waves, world seed
1337, layout `5ebbc2bc`, dressing `26adf59c`.

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
| Right mouse (hold) / `Q` | Aim tune — glide the view onto the attacker nearest the reticle |
| `R` | Reload |
| `F` | Boot kick (the kick the stance gives — see below) |
| `X` | Low sweep, from anywhere |
| `C` | Crouch (toggle) |
| `M` | Mute |
| `Esc` | Release the cursor (pauses) |
| `[` / `]` | Debug: shorten / lengthen the cover-break lull (see below) |
| `\` | Debug: restore the configured lull |

**Xbox-style controller** (detected automatically — no pointer capture needed)

| Input | Action |
| --- | --- |
| Left stick | Move (push to the edge, or `L3`, to sprint) |
| Right stick | Aim |
| `RT` | Fire |
| `LT` | Aim tune — glide the view onto the attacker nearest the reticle |
| `A` | Boot kick (the kick the stance gives — see below) |
| `X` | Low sweep, from anywhere |
| `B` | Reload |
| `Y` | Jump |
| Right stick click | Crouch (toggle) |
| `View` / `Back` | Mute |
| `Menu` | Release the cursor |

**Touch / phone**

Left thumb pad moves, dragging anywhere on the right half aims, and the round
buttons fire, kick, jump, reload, crouch and hold the aim tune. Sprint is
automatic when the stick is pushed past ~85%. The compact HUD and the on-screen
pad appear automatically on coarse pointers, and the layout adapts to portrait
and short-landscape phones.

## The combat model

This is the heart of the design, and it is deliberately unusual:

- **Gunfire wounds first.** An attacker's health floors out at `bulletMinHealth`
  (6); no single burst drops them, and wounded attackers slow down and shoot less
  accurately.
- **A finishing round through the head is a fatality.** The round that actually
  finishes an attacker — the one that takes the bleed-out timer under zero — decides
  it: `head`, and the body leaves the ground. `fatalityThrow` (6.4 m/s) sends it
  where the shot was going, `fatalityLift` (4.2 m/s) puts it half a metre up for
  four tenths of a second, and `fatalitySpin` (6.0 rad/s) turns it most of the way
  over by the time it lands. It comes down two and a half metres downrange, skids
  (`fatalitySkid`), then sinks. A round through the chest — or a bleed-out that runs
  out between rounds — folds them where they stand, which is the other banner.
  The flight is played back in slow motion (`fatalitySlowmo`, 0.55 s of real time at
  `fatalitySlowScale`, 0.28, easing back to full speed), because three metres in a
  third of a second is a flicker rather than a fatality; and where the body lands it
  leaves a stain (`fatalityDecalLife`, `fatalityDecalRadius`), smeared along the way
  it was still travelling. Nothing else changes: the credit, the loot roll and the
  wave pacing are a downing's, so the boot is still the way to the next tier. The
  throw, the spray and the stain are all worked out from the shot itself (its
  direction, and which side it came from) rather than from dice, because a campaign
  that drew different numbers from something that happens after the fight is over is
  no longer the same campaign — and the particle spray is built as a fan along the
  shot (`burstAlong`) rather than off `Math.random()`, so a fatality costs the
  campaign's own generator nothing at all.
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
  progress. If nothing is eliminated for `flushAfter` — 12 s at wave 1, down to
  3.5 s at wave 10 — the whole line breaks cover and charges at once, and the last
  `flushLastStandCount` (3) attackers of a wave never hide again. Any elimination
  buys them a fresh window of hiding.
  This is what stops a wave ending in a slow walk around the forest rounding up
  stragglers, which was the single biggest drag on the pace.
- **They keep coming.** Routed attackers being gone for good is fine because the
  next wave spawns more — the forest never runs out of brave soldiers.

Tiers unlock on tier credit: Standard → Reinforced → Silver → Gold → Spiked Gold →
Tactical Doom → Legendary Broken → Mythical Diamond, each raising melee damage,
knockback, the number routed per kick and movement speed. Every tier wears a model,
loads it when the tier *moves* and sockets it onto the officer's **right foot** bone.
Tier 0 never moves — he starts in it — so its boot is loaded with his weapon during
`Game.load`, which is what puts a boot on him for his first kill instead of the first
tier-up banner.

Thresholds are set against the whole campaign, which totals 117 attackers, so a
single run is worth at most 117 credit. A good run reaches **Legendary Broken
Boot** (102) near the end; **Mythical Diamond** (116) needs a near-perfect,
boot-only clear. In a full simulated clear of the pre-ramp build the tiers arrived
at 49 s, 132 s, 190 s, 261 s, 323 s and 385 s; the ramp below brings the late
waves on faster, and the credit thresholds are unchanged.

Each tier carries its own fit in `BOOT_SOCKETS` — `size`, the model's longest axis
in metres, and `lift`, which raises it until the sole rests on the ground. The
socket helper centres a model on the foot bone, so a lift is always needed. Every
tier's boot is bigger than the plain 0.29 m foot his mesh wears, and they grow from
0.52 m to 1.00 m, so the ladder is visible on him: Standard is a boot, Diamond is
most of his shin. The lifts are measured, not guessed — `npm run test:character`
reports each sole to the millimetre, and that is where the eight values come from.

All three kick clips are right-legged, which is why the boot is socketed there:
measured through each clip, the right toe travels 1.7 m (`kick`), 2.0 m
(`kickHigh`) and 1.5 m (`stomp`) while the left foot stays planted within 0.26 m.

## The three kicks

They are not one kick with three animations. Each has its own reach, arc, damage
and power against scenery, all in `KICKS` in `config.js`:

| Kick | Thrown from | Reach | Arc | Damage | Extra routs | Prop power |
| --- | --- | --- | --- | --- | --- | --- |
| Kick | standing, boot tier 0–1 | 3.6 m | 108° | ×1.00 | — | 10 |
| Low Sweep | crouched | 2.7 m | 144° | ×0.70 | +1 | 7 |
| High Kick | in the air, or standing at tier 2–4 | 4.3 m | 76° | ×1.15 | — | 13 |
| Stomp | standing at tier 5+ | 3.3 m | all round | ×1.40 | +1 | 16 |

The arc is the half-angle either side of the kick, so the sweep covers nearly the
whole front at almost no reach and the stomp's π takes everything around the
officer on the spot. The kick is chosen by *where the officer is*: the boot's own
button (`F`, or `A` on a pad) throws the sweep crouched, the flying high kick in
the air, and the equipped tier's signature kick standing. The low sweep also has a
button of its own — `X` on the keyboard and `X` on a pad, the same letter in both
legends — because it is the one kick the stance does not reach in a single press
otherwise: it was two (crouch, then kick), which is a poor deal on a thumbstick.
Asking for a kick the stance already gives changes nothing, so a crouched officer
pressing `X` gets the sweep they were about to throw anyway. `npm run test:kick`
measures both routes through the real `InputManager` — the pad's button and the
key map — and presses the boot's own button as the control, because a clause that
only asserts a button does *something* asserts nothing. The tier's damage and knockback are still scaled
by the kick, so an upgrade is felt in every one, and it remains visible in the
animation. The HUD names whatever is available from where the officer is standing
(`kick · Low Sweep`) and shows it change as they crouch and land, and the first
time each kick is thrown it explains itself in a toast, since there is no move
list to read.

## The marksman on the rock

The islands are not only loot. From wave 2 every wave posts one attacker on the
climb: the **lowest cap that can actually see the fighting ground** (the sample
points are the clearing at chest height, and a post has to see
`MARKSMAN.sightNeeded` of them), asked through the world rather than assumed,
because a tank or a trunk between the two would make the post a man shooting at
cover. He is put there by `World.marksmanPerch()` and
`EnemyManager.queueWave`, not walked there: nothing else in the fight can hand
somebody a cap.

He is the one attacker the rifle cannot remove, and that is the whole of him:

- **Gunfire floors him and stops.** Sixty rounds through the real damage path
  leave him wounded at `bulletMinHealth` 6 — floored, not bleeding, still up there
  — with the same rounds bleeding a walking attacker out in 23 (`npm run test:platforms`
  measures both, and the walking control is what makes it a rule about the rock
  rather than about damage).
- **He is a firing line in both directions.** On the default forest his cap has a
  line to six of the nine points sampled in the clearing, and a round cast from the
  clearing finds him at chest height, so he can shoot down into the fight and be
  shot back at — he is just not removable that way.
- **The boot cannot reach him from the ground.** `bootReachUp` is 0.6 m above the
  officer's own feet, and the first rung floats `firstRise` 0.95 m. Kicked from
  underneath his cap he does not move at all; kicked from the cap itself he goes
  off it — 0.95 m down and 7.0 m out, on the ground after 0.63 s of falling rather
  than walking away at cap height. **The climb is the price of him.**
- **And the climb pays.** A marksman put off his rock leaves his kit on the cap —
  the game's own drop table, but drawn inside the table's weights instead of across
  the whole of `[0, 1)`, so it never rolls the nothing an ordinary elimination can
  roll — and the officer standing on the cap collects it through the same pickup
  handler the island crates pay out through. The first one over the edge unlocks
  `off_the_rock`.

The harness measures all four, and falsifies the last one: with `MARKSMAN.kitDrop`
turned off, the same kick — thrown with the drop roll pinned to 0.999, past the end
of the table — leaves nothing behind, and the platform probe fails by name. An
earlier version of the same run also caught the post being unreachable in a way the
probe could not: the pilot insists on standing *over* a cap before jumping, and the
post it was climbing for carried no radius, so it used a 1.4 m guess against a cap
1.55 m wide and pressed against the rim for the rest of the wave. The post carries
its cap's radius now.

## Kicking the scenery

The boot does not stop at people. Crates, barrels, sandbags, rocks and the **tanks** are
kicked with the same reach and arc as the attackers. The impulse is the kick's
`propPower`, and `propLift` upward, divided by the prop's `mass` — 1 for a crate,
1.2 a barrel, 1.5 a wall of sandbags, 2.6 a rock and **4 for a tank** — so a crate
flies and a tank rolls away instead of merely shifting. Measured through the
harness, a tank caught by a
stomp leaves the boot at 6.29 m/s and travels **6.43 m** before it settles, where the
4.5 it used to weigh managed 4.67 m. That lightening is the whole of it: 3 is still
clear of the rock's 2.6, so a tank is still the heaviest thing the boot can meet.
`propDrag`, `propSpinDrag`, `propRestitution` and ground friction settle it, and it
goes to sleep once it is slow enough that simulating it would be wasted work.

What makes it more than a particle effect is that a prop's collision box is the
very box the rest of the world already consults: it blocks bullets, line of sight
and movement. A tank booted out of the way genuinely stops being cover, and one
left lying in a new spot becomes cover there instead — for the player and the
attackers alike, because both use the same box. A prop still travelling at
`propHitSpeed` (4.5 m/s) that catches an attacker floors them, and since it was the
boot that did it, that rout still pays full boot credit toward the next tier. At the
tank's 4 the gate is inside the boot's own reach, but only just: the harness measures
a plain kick leaving the tank at 4.72 m/s, past the 4.5 the gate asks for, so a tank
booted into a knot of attackers bowls them over by itself. At the rock's 2.6 the same
kick would leave it short, and only a charged kick would carry it into anybody.
Those are the impulse figures themselves —
`propPower` and `propLift` over the mass, vertical included — and a plain kick still
cannot reach the gate at either mass (3.53 m/s now, 2.35 before).

`npm run test:kick` asserts the lot: that the three kicks differ in reach, arc and
power, that crouching and being airborne select the sweep and the high kick, that
kicked scenery really moves, tumbles, settles and drags its collision box with it,
that the swing itself is drawn from the foot it was thrown with in the tier's own
colour, and that the boot *feels* as heavy as the mass it met.

## What the boot feels like when it lands

Above everything else this needed weight, so the whole impact reads off a single
figure: the mass the boot met. An attacker body counts as `bodyMass` (2.0), a
crate as 1, a barrel 1.2, sandbags 1.5, a rock 2.6 and a tank **4**, and the heaviest thing in
the arc sets it. Measured through the harness:

| What it met | Mass | Camera shake | Eye kicked back | Frame roll | Hit-stop |
| --- | --- | --- | --- | --- | --- |
| empty air | — | 0.3 | — | — | — |
| a body | 2.0 | 0.9 | 0.32 m | 3.2° | 0.06 s |
| a tank | 4.0 | 1.8 | 0.64 m | 6.4° | 0.12 s |

- **Shake** rattles the frame, as before, but scaled: a kick that meets nothing at
  all gets only the swing (`kickWhiffShake` 0.3) and a tank is 1.8. That gap is the
  point — a connect has to feel different from a miss, or neither reads.
- **Kickback** shoves the eye back along the aim (`kickbackPerMass` 0.16 m per
  unit, capped at 0.9), decaying in about a third of a second rather than
  drifting. It rides on top of the camera's arm length and whatever is behind
  still has the last word: a kick that would push the view into a tree is absorbed
  by the tree instead of clipping through it.
- **Frame roll** leans away from the impact (`kickRollPerMass` 1.6° per unit, ±8°
  max, also capped by the wheelbase): a tank on the officer's left rolls the frame
  the other way from one dead ahead. It goes on *after* the look, so the crosshair
  stays on the view axis and the reticle still covers exactly where the rounds go.
- **Hit-stop** is the weight. Contact charges `kickStopPerMass` (0.03 s per unit,
  0.14 s max) and the frame clock pays it back at `kickStopScale` ×0.12 world time.
  It is deliberately *not* inside `step()`: the loop dilates the dt it hands to
  step, so the world creeps for a moment while `step()` stays a pure function of
  its argument and the harness's timings stay honest. The campaign drives step
  directly and never sees a freeze.
- **The screen edges** light up warm (never the red damage vignette, so a heavy
  boot does not read as taking a hit), fading from `flashImpact`, and `kickFlashMass`
  says what mass fills it — a tank is past it, a rock nearly.
- **The swing itself** is drawn, which is the one part of a kick that had no picture
  at all. A ribbon follows the right-foot bone — the foot the boot is strapped to —
  for as long as the clip it threw is running, tinted with the tier's colour and
  widened by the tier, so a Diamond boot's arc is fatter than a Standard one's. Four
  things keep it honest:
  - **The window is the clip's, not a number.** The kicks do not share a rhythm —
    the standing kick's foot is already turning while the flying high kick is still
    winding up — so a fixed window drew a stub through one and missed the other
    entirely. The high kick's clip, for instance, runs 2.5 s and its leg does not
    move until 0.6 s in.
  - **The arc stays armed for the whole swing**, not just between its own points: a
    stroke that lived only between samples died in that wind-up, and `clearSwish()`
    threw away the arc the kick was about to draw.
  - **The foot is stepped to in 6 cm increments**, not one point per frame. A kick
    moves its foot 0.14 m between frames at its fastest, so a point per frame left
    the end of the stroke behind the boot and drew the rest of it faceted on a
    slower machine; stepping means the newest point is on the boot at any frame
    rate, and the stroke spans the newest 14 steps — 0.84 m of the foot's path.
  - **The ribbon turns its edge to the eye** (width across the path *and* the view,
    so it reads as a stroke rather than as a plank seen end-on).

  It is one 14-point buffer reused by every kick: no post-processing pass, no
  per-kick allocation, one draw call for the fifth of a second the arc is on screen.
  Measured through the harness, one throw per kick the officer knows:

  | kick | arc points | arc travel | stroke | foot's own path | in |
  | --- | --- | --- | --- | --- | --- |
  | standing kick | 14 | 0.764 m | 0.150 m | 3.48 m, 0.61 m of it rise | the boot's colour |
  | crouched sweep | 14 | 0.763 m | 0.195 m | 3.52 m, 0.62 m of it rise | the boot's colour |
  | airborne high kick | 14 | 0.770 m | 0.105 m | 4.18 m, 1.20 m of it rise | the boot's colour |
  | stomp | 14 | 0.761 m | 0.273 m | 2.59 m, 0.46 m of it rise | the boot's colour |

  Every point of every arc is within **0.06 m** of the boot it was thrown with — the
  sampling step, so nothing trails further behind than the resolution it is drawn
  at — the shapes are ordered by design (the high kick narrowest, then the standing
  kick, the sweep and the stomp widest), the arcs are gone once the swing and its
  fade are over, and all four reuse the one buffer. The control is the mistake the
  clause exists for: a stroke pinned to the middle of him sits **0.876 m** off the
  boot, so the clause names that instead of waving it through.

A charged kick multiplies the whole thing by `chargedKnockbackScale` (1.6×), so a
full meter into a tank is the heaviest thing in the game: capped shake, capped
hit-stop and a full screen-edge flare, and the largest push-back the game ever asks
for — a charged kick into the tank at mass 4 reaches `kickbackMax` 0.9 m, which is
what that cap is for. A plain kick into it lands at 0.64 m, so the cap is the top of
the range rather than the middle of it, and the camera's own collision arm still has
the last word on whether it can be spent.

## Aim tune, the boot charge and the new pickups

- **Aim tune** (`LT` / right mouse / `Q` / the TARGET button). It picks the
  attacker nearest the **reticle** — by angle, not distance, and only with a
  clear sight line — then glides the view onto them and holds the lock through a
  short grace period after release. It tightens the cone of fire
  (`lockSpreadScale`, 0.45), steadies the reticle and shows a `locked · Nm`
  readout. It is deliberately a tune rather than a snap: it helps the shot you
  were already taking instead of yanking the camera onto whoever is closest.
- **Every fresh press retargets.** The lock is re-acquired from scratch on each
  *press*, not each frame it is held, so the way to switch attackers is to put
  the reticle on the next one and pull the trigger again — even if the previous
  lock is still alive in its grace period. A trigger held down keeps the attacker
  it caught rather than flicking between two of them as the view swings, and the
  `locked · Nm` readout pulses whenever a press moves the lock. Asserted by the
  harness (`npm run test:aim`).
- **Boot charge.** Routed attackers and gunfire downings feed a meter
  (`chargePerRout` 9, `chargePerGunfireDown` 3, up to `chargeMax` 100) and charge
  crates top it up. A full meter spends itself on a charged kick that takes the
  **whole arc** at once — `chargedExtraRouts` more routed, `chargedKnockbackScale`
  (1.6×) knockback scaled again by the tier, plus a shockwave, a heavier shake and
  a `BOOT CHARGED` banner. The routs it causes refill the meter by 9 each, so a
  well-placed charged kick chains straight into the next one.
- **Pickups.** An elimination rolls ammo (0.26), field dressing (0.16), fast mag
  (0.10, instant reload plus 30 reserve), boot charge (0.14), rapid fire (0.08,
  12 s at `rapidFireScale` 0.55) and plated vest (0.08, 12 s at
  `armorDamageScale` 0.55); a dry player always drops ammo. Drops drift toward the
  player from within 6 m so loot earned in a firefight is not lost in the grass.
- **Stance and jump.** `C` (or a stick click, or the CROUCH button) toggles
  crouch: it plays the `crouch` clip, moves at `crouchSpeedScale` (0.55), tightens
  the cone (`crouchSpreadScale`) and shrinks the hit profile (`crouchHitScale`).
  Jump uses the `jump` clip and clears about 0.94 m.

The cover-break lull is **tunable in play**: `[` and `]` scale it for the session
(0.2× to 3×) and `\` restores the configured curve, with a toast reporting the
resulting seconds so the charge timing can be judged against a live fight.

## Pacing: how the fight escalates

The game opens deliberately and turns relentless. Every pacing figure comes from
one pure function, `waveRamp(wave)` in `config.js`, and every system reads it — so
the curve is tunable in one place instead of being scattered across the AI:

| Wave | Breather before they break cover | Gap between attackers stepping out | Pressing at once | Walk speed |
| --- | --- | --- | --- | --- |
| 1 | 12.0 s | 3.4 s | 1 | 0.92× |
| 5 | 8.2 s | 2.2 s | 1 | 1.01× |
| 10 | 3.5 s | 0.7 s | 2 | 1.12× |

Spawns tighten too (1.7 s → 0.75 s), the assault window lengthens (4–6 s →
7–11 s), attackers hold their firing line closer in (14 m → 10.5 m) and the
intermission shortens (6.5 s → 4 s).

Measured by driving a walking player through the first 30 s of a wave, wave 10
puts **2.6× the incoming fire and 3.9× the damage** on the player of wave 1
(0.77 shots/s and 4.7 damage/s against 0.30 and 1.2 — 140 damage against 36), with
**2.4× as many attackers pressing at once** (1.60 against 0.66). The first
cover-break lands 12.0 s into wave 1 and 3.5 s into wave 10, so the late waves
start pressing sooner as well as harder.

## What else is implemented

- **Over-the-shoulder camera** that fires along the reticle axis, with cover-aware
  pull-in, recoil that recenters, and screen shake — plus the mass-scaled
  kickback, frame roll and hit-stop that make the boot land (above).
- **Attackers fight from cover, one at a time.** They spawn 26–38 m out and bound
  forward cover to cover — a spot on the far side of a tree, a tank or a crate
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
  they charge again. The last-stand test counts the **whole wave** — attackers
  who have spawned plus those still queued — because they arrive on a stagger and
  counting only the ones already on their feet made the first seconds of every
  wave read as a last stand, breaking cover before the line had even formed.
- **Attackers find their way around obstacles.** Steering is a straight line with
  only a slide along whatever it bumps into, so an attacker whose target sat on
  the far side of a crate would press into the same face indefinitely — it could
  not shoot, could not be reached, and the wave could never end. A stuck watchdog
  now notices the lack of progress and walks along the obstacle (keeping to one
  side until the line to the player opens up) instead of leaning on it.
- **Waves.** Ten waves sized `round(4 + wave * 1.4)` and capped at 18, staggered
  spawns, a cap of 9 alive at once, elite variants from wave 5, and an
  intermission with a tagline between waves. Clear times in the recorded run: 29 s
  for wave 1, then 35 s and 34 s for waves 2 and 3, and 401 s for all ten.
- **Forest.** Instanced pines, a clearing, crates, barrels, sandbag walls, rocks and parked tanks
  used as cover — all with real collision, all built from one seed (`worldSeed`).
  `?worldSeed=N` builds a different forest with the same game in it, which is how
  the harness fuzzes terrain; with no parameter it builds the one it always did.
- **Floating islands you climb for the loot.** Ten flat rock slabs hang over the
  forest on a wandering bearing (`PLATFORMS`), each cap `rise` above the last: the
  officer's jump clears `jumpSpeed² / (2 · |gravity|)` ≈ 0.99 m against a 0.70 m
  step, so every rung is cleared by jumping and by nothing else — the cap's
  tolerance (0.15 m) is deliberately narrower than a step, which is what stops the
  climb from being a ramp he can walk up. Each slab is one cylinder `depth` (0.8 m)
  thick with turf on the face he lands on and rock on the rim below it, its
  underside cut back facet by facet so no two are the same shape, and a few stones
  broken off the rim hanging under it for silhouette. Every other island carries a
  **supply crate**: block-modelled olive planks with a stencil plate and the asset
  itself on the open lid (a belt of rounds, a med kit with its cross, a radio, a
  drum magazine, a folded plate carrier), anchored on its cap and never expiring.
  Loot is collected by whoever is at its own level or above it, so a crate on a top
  cannot be vacuumed by jumping under it: the climb is what pays. The islands are
  **not** in the world's cylinders or boxes, so bullets, sight lines, attacker
  pathing and the kick's prop pass are all blind to them — the ground fight is
  exactly what it was, which is what `--check-platforms` measures, and the layout
  also keeps the climb's ground clear of trunks and props (a tank under a cap is
  still a wall to his feet, so it is laid out around).
- **A marksman posted on the low cap.** One rung of the climb — the lowest one that
  can see the fighting ground — is held by a shooter who never walks, never takes
  cover, and **cannot be shot off it**: gunfire drives him to the floor (health 6)
  and stops, he does not bleed out, and he keeps firing down into the clearing at
  `MARKSMAN.fireInterval` 2.9 s and ×1.8 damage with his own hit bonus, so range
  costs him far less than it costs a walking attacker. The boot reaches only
  `bootReachUp` 0.6 m above the officer's own feet, so he cannot be kicked from the
  ground: **the climb is the price of him**, and it pays — his kit stays on the cap
  he was put off (a guaranteed pickup, where an ordinary elimination can roll
  nothing at all) and the first one over the edge is the `off_the_rock`
  achievement. See *The marksman on the rock* below.
- **A scanned environment.** `landscape_forest__mountains.glb` is a closed,
  canopy-textured photogrammetry dome. Standing inside it looks like a cave, so it
  is rendered once into a cubemap and used as the sky, then covered overhead by a
  gradient sky cap. Only its terrain band stays visible on the horizon.
- **Dynamic music.** The two supplied tracks are crossfaded as beds: one for the
  lulls, one for when there are attackers alive.
- **The boot's own recorded takes.** Four small files beside the music supply the
  sounds the boot makes: `bsh` on every kick whether it lands or whiffs, `ouch` and
  `oua` as the two takes of whoever it lands on (picked at random, pitched a little
  off the file, so a wave of kicks is not one take on repeat), and `bootpower` for
  taking somebody off the field — sent running or beaten down. A kick that only
  connects plays no sting. They are fetched while the match plays and decoded
  through the same master gain as the synthesis, so mute and the effects volume
  apply; until they land, and if one is ever missing, the synthesised version
  stands in rather than the game going quiet. Their pitch and take variation comes
  from their own generator, never `Math.random` — a sound that draws from the
  fight's stream re-rolls the campaign behind it.
- **Every boot tier has a voice.** `BOOT_VOICES` gives each tier a playback rate and
  a gain — a heavier boot lands lower and louder, `diamond` at ×0.70 where `standard`
  is ×1.00 — so upgrading is something you can hear and not only count. A tier may
  also ship its own pair of recordings beside the shared ones (`silver-bsh.mp3`,
  `doom-bootpower.mp3`, named by the tier's `socket` slug), and a tier so listed in
  `SETTINGS.bootRecordedTiers` plays those instead. Nothing is fetched speculatively,
  so an unlisted tier goes on using the shared take in its own voice rather than 404ing
  at build-up. The sting for a kill plays the tier's voice exactly, with none of the
  swing's variation, so it lands the same every time; the swing itself varies ±8%
  around the voice so a wave of kicks is not one file on repeat. The voice is read
  off the foot he threw the kick with, because taking somebody off the field pays tier
  credit and can change the boot mid-swing.
- **Loot.** Six drop types rolled per elimination, with ammo first so a dry
  player can never hard-stall — see *Aim tune, the boot charge and the new
  pickups* above for the table.
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
│   ├── audio.js        Synthesised SFX, the boot's recorded takes and the two-track music director
│   └── mathx.js        Damping helpers
├── serve.mjs           Local static server
└── vendor/             Three.js r186 (module + the loaders it needs)
```

Three.js is vendored rather than pulled from a CDN so the page works offline and
on static hosting with no build step. `vendor/three/three.core.js` must stay next
to `three.module.js`; `vendor/addons/` keeps the relative layout the addons expect.

## Models used

Every entry carries its licence, because a pack whose terms are not recorded is a
pack the project cannot ship again. **CC0** below means Creative Commons Zero v1.0
Universal — public domain, no attribution required, though the authors are credited
anyway.

| Asset | Role | Licence and source |
| --- | --- | --- |
| `3rdpersonidle.glb` | **Player.** The only skinned SWAT body, with the idle clip; converted from the `3rdpersonidle.fbx` master by [`tools/convert-glb.mjs`](tools/convert-glb.mjs). | *not recorded in this repo* — see the gap note below |
| `3rdpersonshootwalking/standing/crouch.fbx` | Player locomotion and aim clips. | *not recorded* |
| `3rdpersonjump.fbx` | Jump clip. | *not recorded* |
| `3rdpersonkick / kickhigh / stomp.fbx` | Boot attack clips. | *not recorded* |
| `attackerIdle.glb` | **Attacker.** Skinned body + idle clip; same conversion from the `attackerIdle.fbx` master. | *not recorded* |
| `attackershootwalking/standing/crouch.fbx` | Attacker clips. | *not recorded* |
| `ak-47.glb` | Rifle, socketed to the right hand bone. | *not recorded* |
| `silverboot / goldboot / brokenboot / diamondboot.glb` | Boot tier models. | *not recorded* |
| `tank_hull.dae`, `tank_turret.dae` | **The vehicle cover**, replacing the low-poly car: a modular tank — hull and turret as separate files — fitted to 4.6 m long, three to a field. | **CC0** — pixelmannen, *Low-Poly tank assets*, [opengameart.org/content/low-poly-tank-assets](https://opengameart.org/content/low-poly-tank-assets), file `TankAndProps.zip` → `Tanks/Body.dae` + `Tanks/Gun.dae`, renamed here |
| `sandbags.dae` | The barricades: a low wall of sandbags in place of the concrete barrier, three to a field. | **CC0** — pixelmannen, same pack, `Props/sandbags.dae`, renamed here |
| `crate_mesh.obj` | **The crates** on the field and in the fight's cover. | **CC0** — mastahcez, *Crate & Barrel bundle*, [opengameart.org/content/crate-barrel-bundle](https://opengameart.org/content/crate-barrel-bundle) |
| `barrel_mesh.obj` | Drums, kicked as scenery. | **CC0** — mastahcez, same bundle |
| `suggan_53_...glb` | The low-poly car this replaced. No longer loaded. | *not recorded* |
| `landscape_forest__mountains.glb` | Scanned environment, used as the sky cubemap. | *not recorded* |
| `abrokenbootonthebraveposter.jpg` | Start screen art. | *not recorded* |
| `A Broken Boot On The Brave*.mp3` | Music beds. | *not recorded* |
| `bsh / ouch / oua / bootpower.mp3` | The boot: its swing, two takes of the yelp it draws, and the sting for taking somebody off the field. | *not recorded* |
| *(built in code)* | The floating islands and their crates: inverted cones and caps from `PLATFORMS`, and the supply crates' small military assets (ammo tin, med kit, radio, drum magazine, plate carrier) modelled as blocks in `Effects`. | this project's own |
| `<socket>-bsh / <socket>-bootpower.mp3` | Optional per-tier takes (`silver-bsh.mp3`, `doom-bootpower.mp3`); a tier without one uses the shared take in its own voice. | *not recorded* |

Every rig in the set uses the `mixamorig:` bone namespace, which is why clips can
be freely cross-applied between the player and the attackers.

**The gap worth closing.** The CC0 packs above are recorded because they were
brought in deliberately and their terms are known. The rest of the table is not:
the character, the attacker, the rifle, the boots, the scanned landscape, the poster
and the two music beds arrived without a licence record, and this repository cannot
say what their terms are. That is a real risk for a project meant to be shown, and
it is the one item on this list that a licence audit should start with.

**Where the dressing came from.** Both packs are the downloaded archives, taken in
the formats they ship: `.dae` for the tank and the sandbags, `.obj` for the crate and
the barrel. The game loads those through `ColladaLoader` and `OBJLoader` — vendored
in `vendor/addons/` beside the FBX and glTF loaders — rather than re-exporting them
through a modelling tool, so what is in the repository is what the author published.
The packs' own
textures are deliberately not used: the scenery is block-coloured, so each model is
repainted with this project's flat materials and the megabyte PNGs are left out. A
model is fitted by *measuring* it — `dressModel` in [`js/world.js`](js/world.js)
reads the bounding box, scales it to the size the game asks for, seats it on the
ground and centres its footprint on the point it is placed at — because the packs are
in centimetres, metres and Blender units between them, and none of that is worth
trusting twice. That last part is a bug the forest audit turned up: a pack's root sits
wherever the author left it, at the end of the sandbag wall's own six metres and 0.8
of the tank hull's length off its own origin, so a model seated by position alone
stands that many times its scale away from the spot the layout chose — at ×11 that was
nine metres of tank, and in three forests of sixteen it put the collision box on the
officer's own spawn point and sealed the field. The fit therefore lives in an **inner
node**: the outer frame is what the world places and rewrites, the inner one carries
the centring and the seating, and `fit.origin` keeps what each pack's root was off by,
in its own units — `0 / 1.444` for the barrel, `0.166 / 1.631` for the crate,
`-0.828 / -0.326` for the sandbags, `-0.817 / 0` for the hull. With the fix every
prop's collision box sits within a millimetre of its placement point and the tank
measures 4.60 × 2.39 × 4.23 m where the layout asks for it.

## Asset size and hosting

`3rdpersonidle.fbx` is ~115 MB, which is over GitHub's 100 MB file limit. The
master is therefore tracked with **Git LFS**:

```
3rdshooter-abootonthebrave/3rdpersonidle.fbx filter=lfs diff=lfs merge=lfs -text
```

The commit stores a 134-byte pointer and the real payload lives in LFS storage, so
a clone needs `git lfs install` once or the model arrives as a pointer. The
committed blob is 134 bytes.

That is a property of the **master** now, not of the game: the two characters ship as
GLB converted from those masters and committed as ordinary files, so a plain clone
plays the game without `git lfs install` ever having been run.

| shipped | from | size | skinned vertices | draw calls |
| --- | --- | --- | --- | --- |
| `3rdpersonidle.glb` | `3rdpersonidle.fbx`, 115.5 MB | 8.4 MB | 138,891 → 31,687 | 264 → 2 |
| `attackerIdle.glb` | `attackerIdle.fbx`, 11.9 MB | 5.4 MB | 33,558 → 7,325 (visor 570 → 109) | 2 |

The conversion runs the masters through the game's *own* three build — the same
`FBXLoader`, the same `GLTFExporter` — because this rig is load-bearing: the boot
sockets are hand-tuned against `mixamorigRightFoot`'s centimetre axes and every clip
binds to the mesh by bone name. A modelling tool's import/export would have
re-scaled the rig out of centimetres and rewritten its bones; loading and writing
back through three keeps the node names, the bind matrices, the skin weights, the
units and the embedded idle clip exactly as the game already sees them. What the
conversion does change:

- the officer's seven embedded 4096² maps become 1024² — JPEG for the colour and
  the inverted glossiness, PNG for the two normal maps — which is 5.5 of the 8.4 MB;
- the exports are **unindexed**, three vertices per triangle, so welding the
  duplicates is what puts the officer at 31,687 vertices and the attacker at 7,325;
- the officer's 264 material groups — one draw call each, and every one of them
  drawing from the same vertex buffer — collapse to one group per material.

Measured, not assumed: rendered side by side through one camera and one light rig
([`tools/compare.html`](tools/compare.html)), the two officer models differ by a mean
of **1.7/255 per channel**, with 7.6% of channels off by more than 8 and a worst
single channel of 53 — the residue of the texture downscale and the move from Phong
to PBR (glTF has no Phong, so the specular map becomes an inverted roughness map).
The rig clauses, all four kicks, the eight boot tiers and the ten-wave campaign pass
on the GLB (`npm run test:probes`, `npm test`).

**One thing the conversion exposed.** The attacker's file carries **two** 65-bone
rigs under the same bone names — one his visor is skinned to and one his body is —
and the GLB stores the visor's first, where the FBX had the body's. Clips bind to the
model by node name and the binder takes the *first* match, so the walk, aim and
crouch files were driving the visor's skeleton and leaving his body in its bind pose:
a T-pose that slid across the field. His idle clip escaped it only because glTF
animates by node index rather than by name, which is exactly why he stood correctly
and only *moved* wrong, and why no probe caught it — the probes measure where he is
and what he does, not which rig is wearing his pose.

`buildCharacter` now rebinds every clip onto the bones the body's own skeleton
wears, matched on the base name so the loader's `_1` de-collision suffix does not
matter, and reads the travelling root bone from that same rig. Measured on the walk
clip: 52 of the body's 65 bones move and none of the visor's, which is the FBX's own
behaviour. The officer has a single rig, where nothing can collide.

Confirmed on the deployed site rather than only in the harness, in a cold browser with
no cache: all four of the attacker's clips — idle, walk, aim and crouch — aim 52 nodes
each at the body's 65 bones and none at the visor's, and in the running match the body's
arm, leg and spine bones changed pose 224 times across fourteen sampled frames while
the visor's sixteen equivalent bones did not move once.

**And the pointer no longer reaches the player.** Checked against a host that answers
both LFS paths with the 134-byte pointer the commit stores, the match starts and draws
the officer: the load makes 56 requests totalling 56.6 MB and never asks for the
`.fbx` at all.

That mattered because for a while the live site answered with the pointer instead.
Measured mid-session, the same URLs returned different things minutes apart —
`3rdpersonidle.fbx` at 134 bytes and `brokenboot/.gitignore` at 404 (only the legacy
branch build does that) at one moment, and the real 115,526,016 bytes at another —
because both pipelines publish to the one host and the branch build overwrites the
artifact's payload with the pointers it stores. This game no longer depends on which
one wins.

The host has since settled on the artifact. Sampled five times over about a minute and
a half: `3rdpersonidle.fbx` answered with 115,526,016 bytes and `game/index.pck` with
327,853,876 (the real pack, not its pointer), and `brokenboot/.gitignore` with 200 —
the last being the tell, because only an artifact built from a full checkout carries
dotfiles. The Pages workflow guards that on the runner: it fails the deploy if
`game/index.pck` arrives shorter than 100 MB. It holds only while Settings → Pages →
Build and deployment → Source stays on
**GitHub Actions**; the branch build is still there to win again if that changes. The
overlap pack in `game/` is the asset that would feel it, because that 328 MB `.pck` is
LFS as well — and the same trick applies to it: put the thing the player downloads
under the 100 MB line and commit it as an ordinary file, so no host can serve a stub
for it.

`tactical_transport_truck_baked_pbr.glb` (~56 MB) is deliberately unused.

## Known limitations / next steps

- No aim-down-sights, and the weapon selection is limited to the AK.
- Achievements are a subset of the design document.
- Boot fits in `BOOT_SOCKETS` are hand-tuned for this rig's `mixamorigRightFoot`
  bone (its axes are centimetres, and its own +Y is not the sky); a different
  skeleton would need new `size`/`lift` values.
- The tier's boot is worn on the **kicking** foot only — all three kick clips are
  right-legged, and the boot is the weapon — so the other foot keeps the plain one
  his mesh carries. A second, mirrored socket on `mixamorigLeftFoot` would make the
  pair match, at the cost of covering the foot the animation uses to plant.
- `size` is the model's true longest axis; the world-axis box around the same boot
  measures about 1.3× that, because the boot is socketed at an angle. Any future
  clause about how big a boot *looks* has to say which box it means.
- The bleed-out floor means a patient player can clear a wave from cover without
  ever closing to melee. It is slow and ammo-hungry by design, but it is a
  legitimate strat.
- Wave composition is flat: no scripted set-pieces or boss encounters yet.
