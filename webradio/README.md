# Vita Hueso Radio — a 24/7 radio station in a folder

A complete, self-hosted online radio station built with plain HTML, CSS and
JavaScript. Most of the day is a **live world feed** — a station in another city
every ten minutes — and once an hour the signal comes home to the artist's own
catalogue. There is no radio host, no paid API and no build step: the station
runs on a clock, a catalogue, an open directory of public streams and a browser.

- **Live now:** https://artistesoundbox.github.io/vitahuesosite/webradio/
- **Widget demo:** https://artistesoundbox.github.io/vitahuesosite/webradio/widget-demo.html

---

## Quick start

```bash
node tools/serve.mjs          # → http://localhost:4180
```

`tools/serve.mjs` is a tiny static server with HTTP byte-range support (needed
for seeking into the live timeline). Any host that serves static files and
supports range requests works — GitHub Pages does.

Rebuild the catalogue after changing music or metadata:

```bash
node tools/build-catalog.mjs           # reuse existing artwork
node tools/build-catalog.mjs --force   # re-extract every cover
```

Requires Node 18+ and `ffmpeg`/`ffprobe` on PATH (only for the build step, never
in the browser).

---

## How the "live" part works

The station's backbone is the **world feed** (next section); the rules below
describe the local catalogue that fills the home segments and the all-local
fallback. There is no streaming server, so "live" is a deterministic timeline:

1. `data/library.json` defines the catalogue; `tools/build-catalog.mjs` writes
   exact track durations into `js/catalog.js`.
2. `js/config.js` defines the seven daily programmes (UTC hours) and their genres.
   **`La Hora Caliente` (17:00–18:00 UTC, 1pm in San Juan) is the appointment
   hour:** its `focus: true` flag makes that block draw guests *only* from the
   salsa/timba/dembow/reggaetón shelf, so it is a real show rather than a
   slightly weighted slice of the day. Every hour has to be covered exactly
   once — contiguous, no gaps, no overlaps.
3. `js/station.js` builds one day's reel: for each programme, the guest library
   is seeded-shuffled and **one of the artist's own songs is dropped in after
   every `ROTATION.originalEvery` guests** (default **8** = about 10%
   originals), and the sequence is laid end to end, cut cleanly at the
   programme boundary. The seed is `UTC date + programme + station epoch`, so
   **every visitor computes the same reel** — including the same guest rotation.

   Both bags reshuffle when exhausted, and **no track can return until
   `noRepeatWindow` other songs have played** (default **12**, carried across
   programme boundaries). That is what stops a song coming back a couple of
   places after itself. Change `originalEvery` in `js/config.js` to taste
   (higher = your own songs rarer; `12` is the ceiling).

   **Fun first:** `funGenres` (`Reggaeton`, `Dembow`, `Latin`, `Dancehall`,
   `Moombahton`, `Urbano`, `Salsa`, `Timba`, `Hip-Hop`, `Disco`, `R&B`, `Funk`)
   carry `funShare` (default **0.85**) of the guest picks — non-fun candidates
   get skipped while a fun track is still available — so the station stays
   danceable without duplicating songs (duplicates are what made repeats feel
   too close). Raise `funWeight` only when the guest shelf grows. **Station ID:**
   `audio/id/radiobreak.mp3` is inserted after every `identEvery` songs
   (default **5**), so the station announces itself regularly. All knobs live in
   `ROTATION` in `js/config.js`; `0` disables the ID.
4. The player looks at `Date.now()`, finds the track that should be playing at
   that second, seeks into it, and keeps a loose sync (re-seek only if drift
   exceeds 12 seconds).

Consequences, stated plainly:

- Two listeners who press play at the same moment hear the same second.
- A listener who pauses and returns later lands where the station is *now*.
- **Skip** steps off the timeline into **Personal** mode. The player then
  behaves like a normal library player (seek, skip, pick anything) and shows a
  **Rejoin live** button.
- Seek synchronisation depends on the visitor's clock and the host supporting
  `Range` requests.

The AutoDJ queue, the "Up next" list and the programme cards all derive from the
same reel, so they always agree with what is playing.

---

## The world feed (the station's main source)

The radio page is driven by live stations around the world; the artist's own
catalogue cuts in once an hour.

- **Slot grid.** The UTC day is cut into ten-minute slots (`WORLD.slotMinutes`).
  Slot boundaries are absolute, so every listener is in the same slot at the
  same second — and because the streams themselves are live, nobody is ahead of
  anybody inside a slot either.
- **City pick.** A slot's station comes from `js/world-stations.js`, chosen by a
  seeded hash of the UTC date + slot number. The same station and the same
  country never repeat back to back. Same list + same clock = same city on
  every device.
- **Home segments.** One slot per hour (`WORLD.homeEveryHour`) is the studio
  catalogue instead: it opens with the station ID, then plays your own songs
  (85% of the picks, `WORLD.homeShare`) with the occasional CC guest. With
  ten-minute slots that is about **16% of the day** — the world leads, your
  music is the visiting hour.
- **IDs.** Every home segment opens with `audio/id/radiobreak.mp3`; one world
  slot every `WORLD.identEveryHours` hours (default **2**, twelve a day) opens
  with it too, for 36 IDs across the day.
- **When a stream dies.** Routine on an open directory. The player remembers
  stations that did not answer, skips to the next scheduled segment, and falls
  back to the next home segment if the next cities are dead too. A 12-second
  watchdog catches a stream that hangs without ever erroring.
- **Picking a place.** The card carries a search box and two dropdowns —
  **State / region** (grouped by country, built from the directory's `state`
  field) and **Town / station** (the stations in that region). Choosing a town
  tunes it. Every country group starts with an **All of …** row, because
  several broadcasters report the country itself as their region and would
  otherwise sit in a one-item bucket while the rest of the country hides in
  the row above. Long directory labels are shown by common name (United
  States, United Kingdom, South Korea, Russia, Netherlands, Philippines,
  Dominican Republic, Venezuela). The open directory publishes a region for
  every station and street coordinates for only some, so the second list is
  the station itself rather than an invented town name.
- **Search.** The box above the picker narrows the country/region list as you
  type: country, state and station names all match, so "walm" finds the New
  York row that holds WALM HD and "united" leaves the United States and the
  United Kingdom. Typing never changes what is playing — the clock keeps
  playing until a region or town is chosen — and the selection stays put while
  a query is open.
- **Leaning.** The **Lean the feed here** switch under the picker biases the
  clock toward that region — or the whole country, when an **All of …** row is
  selected — instead of only hand-tuning one station:
  `WORLD.leanShare` (default **0.6**) of the world slots are drawn from the
  chosen region and the rest still travel. The slot grid is untouched, so a
  leaning listener crosses cities on the same :00/:10 boundaries as everyone
  else. Two slots in the same station are merged into one entry, so a region
  with a single station stays tuned rather than reconnecting every ten minutes.
  The preference is per device (`localStorage`, key `vh.world.lean`); clearing
  the switch puts the shared feed straight back.
- **Studio feed.** The **World feed / The studio** switch at the top of the card
  swaps programming without leaving the page: the world clock, or the
  all-original catalogue reel end to end. The station clock keeps running
  underneath, so switching back lands on whatever city is on the air now, and
  the choice is remembered per device (`vh.live.source`).
- **Near me.** The locator button asks the browser for a position and tunes the
  closest station in the list (great-circle distance over station coordinates,
  falling back to country centres), then marks you in amber on the globe.
- **Off the clock.** Next, "Spin the dial", and clicking any city in the queue
  hand-tune a station without leaving the feed; **Rejoin live** puts you back on
  the shared clock. A hand-tuned stream shows the slot length when it came from
  the schedule, and `LIVE` when it has no end. A hand-tuned station plays over
  whichever feed is selected, and rejoining returns to that feed.

**Where the stations come from.** [Radio Browser](https://www.radio-browser.info),
a free and open directory of public internet radio streams. No key, no account,
no server. Radio Garden publishes no API or embed of its own — its site talks to
undocumented internal endpoints — so the same content is assembled here from the
open directory instead of borrowed from them. Every stream is the broadcaster's
own, played directly by the browser: nothing is recorded, relayed or
re-encoded. Each station's name links back to its own website.

Rebuild the list (this also re-probes every stream and rewrites the module):

```bash
node tools/build-world-radio.mjs
```

The builder keeps only stations that are HTTPS, MP3 or AAC (no HLS, no Ogg),
not tagged as news/talk/sport/religious, at most three per country, and it
probes every URL for real audio bytes before writing `js/world-stations.js`.
Set `WORLD.enabled = false` in `js/config.js` to go back to the all-local reel;
`ROTATION` then applies to the whole day again.

---

## Loudness levelling

The world feed and the studio catalogue are mastered differently, so the
handoff at the top of an hour used to jump. `js/loudness.js` carries one static
gain per track and per station, measured with ffmpeg's EBU R128 scanner against
the local catalogue's **median integrated loudness** (currently −13.2 LUFS).

```bash
node tools/build-loudness.mjs              # measure what is missing
node tools/build-loudness.mjs --force      # re-measure everything
node tools/build-loudness.mjs --stations   # world stations only
```

- Local songs are measured over up to 150 s each; streams get a 12 s sample.
  Measurements are cached in `data/loudness.json` by file mtime and by stream
  URL, so a rerun only touches new music and new stations.
- Gains are clamped (tracks −12…+4 dB, stations −18…+6 dB) and anything outside
  −45…−3 LUFS is treated as an unreadable sample and left alone.
- The player applies the gain to `<audio>.volume` at the single `applyVolume()`
  point. No Web Audio graph is involved, so lock-screen and background playback
  keep working. The volume slider always shows the listener's level, not the
  trim.
- **iOS Safari ignores programmatic `audio.volume`.** On an iPhone the trims do
  nothing; the streams and songs play at their own levels. Desktop and Android
  Chrome/Firefox are where levelling actually applies.

## Features → where they live

| Feature | Implementation |
| --- | --- |
| Large player, play/pause/skip/volume/mute | `index.html` `#np`, `js/player.js`, `js/ui.js` |
| Continuous playback across sections | Single-page hash router; one persistent `<audio>` element |
| World feed: slots, city pick, home segments | `js/station.js`, `js/world.js`, `js/world-stations.js` |
| Station list builder + stream probe | `tools/build-world-radio.mjs` |
| Tuner card, next cities, spin the dial | `js/ui.js`, `index.html` |
| Little live globe | `js/globe.js` (canvas, no assets) |
| Now playing + art + duration | Embedded ID3 cover extracted by the build |
| Queue / recently played | `state.queue`, `vh.history` in localStorage |
| Listener counter | `js/community.js` (Supabase Realtime presence) |
| Favorites, search, genre filters | `js/ui.js`, `vh.favorites` in localStorage |
| "Never play this again" (per device) | `js/blocklist.js`, `vh.blocked` in localStorage |
| Sleep timer | `radio.setSleep(minutes)` |
| Live mic mode | Local monitor + recorded "mic take" (`radio.toggleMic`) |
| Scheduled playlists | `PROGRAMS` in `js/config.js` |
| Embeddable widget | `embed.html`, `widget.js`, `widget-demo.html` |
| SEO | Meta/OG/Twitter tags, JSON-LD `RadioStation`, `sitemap.xml`, `robots.txt` |
| Fast repeat loads | `sw.js` caches the shell (never the MP3s or the streams) |

---

## Adding music

1. Drop files into `anthonitus_songs/` named `NN-Track Title.mp3` (for example
   `48-New Song.mp3`). The leading number is used for ordering.
2. Add an entry under `"tracks"` in `data/library.json`:

   ```json
   "48": { "title": "New Song", "album": "vol5", "genres": ["Ambient", "Soul"] }
   ```

3. Run `node tools/build-catalog.mjs`.

The build reads the real duration and the embedded cover art (if the MP3 has
one), so the timeline and the queue stay accurate. Genres are only used for
programming, filtering and artwork grouping — edit them freely.

To add a record, add an object to `"albums"` with a `cover` path.

### Guest / Creative Commons tracks

`audio/free/` holds the guest catalogue: **48 songs**, all held to CC BY or
CC BY-SA (never NC or ND), built for a danceable shelf — reggaeton, dembow,
salsa, timba, dancehall and moombahton next to English hip-hop, funk, disco, R&B,
soul and pop.

Two shelves sit in there:

- **Signal Sessions (CC)** — 35 tracks from [ccMixter](https://ccmixter.org)
  (33 × CC BY 3.0, one CC BY 2.5, one CC BY-NC 3.0 that is fine while the
  station stays non-commercial).
- **Open Shelf** — 13 tracks from the [Free Music Archive](https://freemusicarchive.org):
  Juanitos, 1000 Handz, Alex Morgan, Ketsa, John Bartmann and Jean Toba, under
  CC BY 4.0 / CC BY-SA 4.0 / CC BY-SA 2.0 — afrobeat, amapiano, afro house,
tropical, boogie and latin. All instrumental-led, so nothing explicit slips in.

Why these and not a streaming service: **Jango, AccuRadio and TuneIn licence
listening, not re-broadcasting** — their terms forbid copying or relaying their
audio, so they can never feed this reel (TuneIn stays usable only as its own
embedded player for other stations). **Pixabay** forbids distributing content
"on a standalone basis", which is exactly what a music-only station does, and
**Uppbeat** excludes radio from its standard licences and sells broadcast
separately. CC BY material from ccMixter / FMA / Jamendo is the route that
actually permits a 24/7 self-hosted stream, provided the credit stays visible.

They are hosted here, not hotlinked. Every entry carries its own `artist`,
`license`, `licenseUrl`, `source` and `credit`, and those are surfaced in
`CREDITS.md`, on the About page, and under the player. CC BY requires that
attribution stays visible — keep the credits if you keep the tracks.

To add more, drop the MP3 into `audio/free/` and append an entry to
`"freeTracks"` in `data/library.json` (an `artist` field is required). Then run
`node tools/build-catalog.mjs`. Delete the folder and the `"freeTracks"` block
to run a 100% original station.

The catalogue builder rewrites `CREDITS.md` on every run, so edit attribution in
`data/library.json`, not in the generated file.

---

## The listener count

The station has **no chat**: there is nothing to moderate, nothing to store, and
no conversation waiting for you when you come back. All that is left is a count
of how many devices are on the broadcast — in the header chip, on the radio page,
and in the side card.

`js/community.js` uses **Supabase Realtime presence**: each open page joins one
public presence channel under a random per-browser id in `localStorage`, and
Supabase reports who is present and when they leave — including a tab closed
without warning — so the number moves within seconds. Several tabs of the same
browser share one id and count once; a different phone counts separately. No
tables, SQL or policies are involved: presence is a realtime channel, not data.

Setup (once):

1. Create a free project at [supabase.com](https://supabase.com).
2. **Project Settings → API**: copy the **Project URL** and the
   **publishable / anon key**.
3. Paste them into `COMMUNITY.realtime` in `js/config.js` (they are safe in the
   page source: the anon key can only join this channel).

Until those two values are filled in, the station shows **1** — you, alone —
rather than a number it cannot back up. If the SDK cannot load (offline, blocked
CDN), it also falls back to 1.

The SDK is imported from jsDelivr at runtime (`js/community.js`), so there is
still no build step and no `node_modules`. Free Supabase projects pause after a
week with no traffic; if the count ever sticks at 1 with visitors around, check
the project is awake in the dashboard.

### Microphone

`Mic` opens the microphone, ducks the music to 25%, monitors your voice locally
and records a take you can download (`Save mic take` appears under the player).
It does **not** broadcast to other listeners — that requires an audio server,
which this static setup deliberately avoids. Recording and monitoring are real;
remote broadcast is the one feature that cannot exist without a backend.

---

## Disliking a song (the admin's pruning ledger)

The thumbs-down in the player — and on every library card — hides that track **on
this device only**. The station rebuilds today's reel without it, so it vanishes
from the live clock and from personal queues immediately, and the choice survives
reloads (`vh.blocked` in localStorage, handled by `js/blocklist.js`).

Library cards for hidden tracks stay visible, dimmed with a **Hidden** chip, and
the same button puts them back (`Back in rotation`). Nothing is deleted, nothing
is sent anywhere, and other listeners are unaffected: the broadcast is a shared
timeline, so one listener's taste must not rewrite what everyone hears.

That is deliberate — the list is the auditioning ledger. Listen through the
shelf, hide the duds, then prune them for real by deleting the file from
`audio/free/` and its entry from `data/library.json`, and rebuild.

---

## Deploying to GitHub Pages

The folder lives inside the `vitahuesosite` repository, so it publishes at
`/vitahuesosite/webradio/` automatically once committed and pushed:

```bash
git add webradio
git commit -m "Add Vita Hueso Radio station"
git push
```

No workflow file is needed; GitHub Pages serves static files as-is. The MP3s
are large — the station adds roughly 470 MB to the repository (177 MB of
originals, 286 MB of guest audio, artwork). The Open Shelf MP3s arrive at
320 kbps, so 13 tracks cost 71 MB; re-encoding them to 192 kbps would recover
about 45 MB without a noticeable loss on phone speakers. If the size becomes a
problem, move `anthonitus_songs/` or `audio/free/` to a release asset or an
object store and update the `src` values in the catalogue.

---

## Embedding

**Recommendation: use the iframe.** It is the safest option — the player runs in
its own document, its CSS cannot leak into the host page, its scripts cannot
touch the host DOM, and you can add a `sandbox` attribute. The floating
`widget.js` is convenient for pages you control, but it injects a style tag and
DOM nodes into the host page, so it is the more invasive of the two.

Inline player (follows the same broadcast):

```html
<iframe src="https://artistesoundbox.github.io/vitahuesosite/webradio/embed.html"
        title="Vita Hueso Radio" width="100%" height="104"
        frameborder="0" allow="autoplay" loading="lazy"></iframe>
```

Floating launcher:

```html
<script src="https://artistesoundbox.github.io/vitahuesosite/webradio/widget.js" defer></script>
```

For a stricter embed, add `sandbox="allow-scripts allow-same-origin allow-popups"`
to the iframe. Both instances broadcast a "playing" signal so two players in one
browser never echo each other.

---

## The radio across the main site

`webradio/site-radio.js` is the one-file hook that carries the station into the
rest of `vitahuesosite`:

```html
<script type="module" src="webradio/site-radio.js"></script>
```

- The portal's top **Enable radio** pill (id `vh-enable-radio`) turns the station
  on: it silences the portal's welcome loop, remembers the choice in
  `localStorage`, and opens the compact **dock** at the bottom-left with
  play/pause, skip, mute, a live/personal badge and a progress bar.
- The **radio icon card at the bottom of the portal** (`vitahuesoradioicon.png`)
  links into the full station (player, library, listener count). It is
  marked `data-radio-open`, so opening it also switches the radio on.
- A page navigation always destroys the `<audio>` element, so the dock leaves a
  hand-off note in `sessionStorage` with the **track id, playback mode and
  position**. The station page continues exactly that song where it was — a live
  listener rejoins the same live entry, a listener who had skipped stays on the
  skipped track, and even a page holding a stale cached catalogue continues what
  was audible instead of switching to a different "now". Arriving never changes
  the song under the visitor. If the browser still blocks sound on the new
  document, a **Tap to keep the radio going** pill appears — one tap, no hunting
  for the play button.
- Any element marked `data-radio-open` gets that behaviour, so other pages can
  add their own door into the station.
- The PWA install chip (`install.js`) shares the bottom-left corner with the
  dock, so `site-radio.js` measures the dock and lifts the chip clear of it.

---

## Configuration checklist before publishing

- `data/library.json` → `station.name`, `artist`, `tagline`, `contactEmail`,
  `siteUrl`, socials. `contactEmail` is the studio inbox every contact form goes
  to. **The address is never printed on the page:** it lives in `library.json`
  and is only written into the `mailto:`/Gmail links at submit time, so the
  visible copy says "send it straight from Gmail" instead of naming the inbox.
  Clearing `contactEmail` falls back to copying the message for YouTube/GitHub.
- `js/config.js` → programme names, hours (UTC), genres; `WORLD` (slot length,
  home slots per hour, own-song share, ID cadence); and the Supabase presence
  values in `COMMUNITY`.
- `js/world-stations.js` → generated. Rebuild with
  `node tools/build-world-radio.mjs` rather than editing by hand.
- `js/loudness.js` → generated. Rebuild with `node tools/build-loudness.mjs`
  after adding music or refreshing the station list.
- `index.html` → About copy, canonical URL, JSON-LD.
- `data/library.json` → genres were assigned from titles, not by listening.
  Adjust them to match how the records actually feel.

---

## Verification performed

- Catalogue build: 95 tracks (47 original + 48 guest), 306 minutes, 27 genre
  chips, embedded covers extracted.
- Local server range request: `206 Partial Content` with correct
  `Content-Range`, so timeline seeking works.
- Playback: live start lands within ~0.4 s of the station clock; continuous
  playback confirmed across Home → Library → Radio; skip → Personal mode;
  rejoin live → resynced; sleep timer, favorites, history and queue persist.
- Rotation: the live reel drops one original in after every eight guest tracks,
  and the queue tags guest entries with `CC`. `node tools/check-rotation.mjs 3`
  walks three real days: shortest gap between two plays of the same song is 13
  songs, with no cooldown violations across programme or midnight boundaries.
- Guest audio: ccMixter and Free Music Archive MP3s play from `audio/free/`
  (206 range responses), with the correct writer, licence and source in the
  player credit, the About page and `CREDITS.md`. Every Open Shelf track was
  licence-checked on its own FMA page before download (BY or BY-SA only).
- Site radio: the portal pill opens the dock; the bottom icon card enables the
  radio and opens `#radio`; the station page rejoined the same track and live
  position after the jump; the blocked-autoplay prompt appears when the browser
  refuses sound; the install chip sits above the dock instead of on top of it.
- Mix: over a 80-entry window the reel ran 48 Latin/dembow/reggaeton/dancehall
  tracks, 12 other guests, 7 originals and 13 station IDs — i.e. the fun genres
  dominate, the artist's songs stay rare, and the ID lands every five songs.
- Station ID: playing at its scheduled slot loads `audio/id/radiobreak.mp3`,
  plays the full 6 s, and the queue tags it `Station ID · ID`.
- No-repeat rule: over 240 upcoming slots the shortest gap between two plays of
  the same song was 14 slots, with 71% of the songs in the fun genres, 10%
  originals and 38 station IDs (one every five songs).
- Station header: the Anthonitus banner loads from `../anthonitus.png` above the
  station header and links back to `../index.html`; the same goes for the
  `Back to site` pill that sits beside the on-air chip.
- Contact form: clipboard path works, with a visible selectable fallback when a
  browser refuses clipboard access.
- Library: search, genre filter, empty state, sort, favorites-only.
- Listener count: `js/community.js` joins one Supabase presence channel under a
  random per-browser id; with no keys configured the page shows 1 rather than
  inventing a number. A genuine two-device count still needs a Supabase project
  (the config values were never supplied).
- World feed timeline: one seeded UTC day is 246 entries — 120 live-station
  slots, 90 home songs and 36 station IDs, tiling the 24 hours with **zero gaps
  and zero overlaps**; 83.3% world airtime, 16.5% home, 87 different cities in
  the day.
- World streams: the built list is 169 stations in 61 countries, every one probed
  for audio at build time (HTTPS, MP3/AAC, no HLS/Ogg, no talk/news tags); a
  browser played a real station to `readyState 3` with `currentTime` advancing.
- Dead station: tuning to an unreachable stream failed over to the scheduled
  broadcast within a few seconds, logged the station as dead, and returned to
  `mode: live` at the correct slot offset.
- Handoff: forcing a segment end moved the player from the live stream to the
  next home song (`readyState 4`, local MP3, slot timer), and `Rejoin live` put
  it back on the world feed at the right offset. Skip → next city → pause →
  resume → rejoin all behaved.
- Globe: canvas is 231×132 CSS / 231×132 backing pixels, all painted pixels
  inside the 61 px sphere radius, no paint outside the rim; the listener dot
  paints on the front face and is hidden on the back.
- Loudness: 96/96 local files and 160/169 stations measured; target −13.2 LUFS
  (catalogue median). A station measured 7.9 dB hotter than the target played at
  `audio.volume` 0.322 with the slider at 0.8, and a studio song at 0.908 — the
  trim follows the track. The 9 unreadable samples play untrimmed.
- Tuner picker: 61 country groups and 166 rows (105 regions + an **All of …**
  row per country); the United States group lists all three of its stations, and
  changing the region or town tunes the first station in it. The selection
  stays where it was chosen while the clock moves inside that scope, and the
  search box filters to country, state and station names ("united" → US + UK,
  "walm" → New York); a query never changes playback.
- Country lean: selecting **All of United States** with the lean on gave a
  3-station pool, a 50% share of one day's world slots, and all three of its
  stations appearing in the reel.
- Near me: with a mocked San Juan position the locator tuned the San Juan
  station (1 km), synced both dropdowns to Puerto Rico → San Juan PR, and marked
  the listener in amber on the globe.
- Leaning: with `WORLD.leanShare = 0.6`, a 20-day build put 61.4% of world slots
  in the chosen region (baseline 1/169 for a single station); the same lean
  built twice produced identical cities, clearing it restored the shared picks
  exactly, and adjacent slots in one station were merged instead of restarting
  the stream.
- Studio feed: switching while a station played moved to a local MP3
  (`readyState 4`, offset 147.9 s into the live local reel, loudness trim
  applied); switching back resumed a real world stream at the correct slot
  offset with its own trim. The choice survives a reload.
- Widget/embed: inline player and floating launcher both play the live feed and
  show the world station's title, place and slot timer.
- Layout checked at 390×844 and 320×720 with the tuner card and globe: no
  horizontal overflow, no element crossing the viewport edge.

Not verified in this environment: real iOS/Android lock-screen behaviour, Safari
  autoplay edge cases, and the globe's animation loop (this headless browser
  never fires `requestAnimationFrame`; the static frame it paints was verified
  by pixel inspection). See the notes in the verification list above.
