# Vita Hueso Radio — a 24/7 radio station in a folder

A complete, self-hosted online radio station built with plain HTML, CSS and
JavaScript. Every track streams from this folder. There is no radio host, no
paid API and no build step — the station runs on a clock, a catalogue and a
browser.

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

There is no streaming server, so "live" is a deterministic timeline:

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

## Features → where they live

| Feature | Implementation |
| --- | --- |
| Large player, play/pause/skip/volume/mute | `index.html` `#np`, `js/player.js`, `js/ui.js` |
| Continuous playback across sections | Single-page hash router; one persistent `<audio>` element |
| AutoDJ 24/7 shuffle | `js/station.js` deterministic reel |
| Now playing + art + duration | Embedded ID3 cover extracted by the build |
| Queue / recently played | `state.queue`, `vh.history` in localStorage |
| Listener counter | Presence envelopes over the community relay |
| Favorites, search, genre filters | `js/ui.js`, `vh.favorites` in localStorage |
| Sleep timer | `radio.setSleep(minutes)` |
| Live mic mode | Local monitor + recorded "mic take" (`radio.toggleMic`) |
| Scheduled playlists | `PROGRAMS` in `js/config.js` |
| Chat + emoji | `js/community.js`, `js/ui.js` (`CHAT_EMOJI`) |
| Embeddable widget | `embed.html`, `widget.js`, `widget-demo.html` |
| SEO | Meta/OG/Twitter tags, JSON-LD `RadioStation`, `sitemap.xml`, `robots.txt` |
| Fast repeat loads | `sw.js` caches the shell (never the MP3s) |

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

`audio/free/` holds the guest catalogue: **36 songs from independent artists on
ccMixter**, built for a danceable shelf — reggaeton, dembow, salsa, timba,
dancehall, moombahton and Latin pop next to English hip-hop, funk, disco, R&B,
soul and pop. Every track carries its own licence: **CC BY 3.0** (one at 2.5),
except the single **CC BY-NC 3.0** timba cut, which is fine while the station
stays non-commercial. They are hosted
here, not hotlinked. Every entry carries its own `artist`, `license`,
`licenseUrl`, `source` and `credit`, and those are surfaced in `CREDITS.md`, on
the About page, and under the player. CC BY requires that attribution stays
visible — keep the credits if you keep the tracks.

To add more, drop the MP3 into `audio/free/` and append an entry to
`"freeTracks"` in `data/library.json` (an `artist` field is required). Then run
`node tools/build-catalog.mjs`. Delete the folder and the `"freeTracks"` block
to run a 100% original station.

The catalogue builder rewrites `CREDITS.md` on every run, so edit attribution in
`data/library.json`, not in the generated file.

---

## The listener room (chat, emoji, presence)

`js/community.js` uses a **free public ntfy.sh topic** (`vh-radio-7d2c91a4` by
default) as a relay. It needs no account, key or server. Messages are:

- public to anyone who knows or guesses the topic;
- rate-limited by ntfy's free tier;
- retained briefly, not archived.

If the relay is unreachable, the UI switches to **Local only**: messages still
work between tabs on the same device and persist locally, and the badge says so
instead of pretending. Counts come from presence pings, so "listening now" means
"radios open in the last 75 seconds", not verified listeners.

Ways to change it:

- **New room:** edit `COMMUNITY.topic` in `js/config.js`.
- **Device-only:** set `COMMUNITY.mode = 'local'`.
- **Own relay:** point `COMMUNITY.relayBase` at your own ntfy instance, or
  replace `publish()` / `openRelay()` with your backend. Only those two
  functions touch the network.

**Emoji:** the smiley button next to the message box opens a picker (`CHAT_EMOJI`
in `js/ui.js`) that drops an emoji in at the caret. A message made only of emoji
renders large, as the room's sticker — no image assets, nothing to moderate.
There are **no song requests**: the room is chat plus presence, and the station
picks its own music.

### Microphone

`Mic` opens the microphone, ducks the music to 25%, monitors your voice locally
and records a take you can download (`Save mic take` appears under the player).
It does **not** broadcast to other listeners — that requires an audio server,
which this static setup deliberately avoids. Recording and monitoring are real;
remote broadcast is the one feature that cannot exist without a backend.

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
are large — the station adds roughly 320 MB to the repository (47 originals,
14 guest tracks, artwork). If that becomes a problem, move `anthonitus_songs/`
to a release asset or an object store and update the `src` values in the
catalogue.

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
  links into the full station (customizer, listener room, chat). It is
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
- `js/config.js` → programme names, hours (UTC), genres, and the community topic.
- `index.html` → About copy, canonical URL, JSON-LD.
- `data/library.json` → genres were assigned from titles, not by listening.
  Adjust them to match how the records actually feel.

---

## Verification performed

- Catalogue build: 83 tracks (47 original + 36 guest), 272 minutes, 23 genre
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
- Guest audio: downloaded ccMixter MP3s play from `audio/free/` (206 range
  responses), with the correct writer, licence and source in the player credit,
  the About page and `CREDITS.md`.
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
- Chat: message sent and received through the relay from a second client;
  presence count updated; local fallback path present.
- Widget/embed: inline player and floating launcher both play the live feed.
- Layout checked at 1440×900, 1200×900 and 390×844.

Not verified in this environment: real iOS/Android lock-screen behaviour,
Safari autoplay edge cases, and ntfy under heavy chat traffic. See the notes in
the verification list above.
