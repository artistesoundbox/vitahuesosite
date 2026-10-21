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
2. `js/config.js` defines the six daily programmes (UTC hours) and their genres.
3. `js/station.js` builds one day's reel: for each programme, the original
   catalogue is seeded-shuffled, a guest instrumental is inserted after every
   `ROTATION.guestEvery` originals (default **5**), and the sequence is laid end
   to end, cut cleanly at the programme boundary. The seed is
   `UTC date + programme + station epoch`, so **every visitor computes the same
   reel** — including the same guest rotation.

   Guests cycle through their own shuffled bag, so a given instrumental is
   spaced out rather than repeated back to back. Change `guestEvery` in
   `js/config.js` to taste (`0` removes guests from the live reel while keeping
   them in the library).
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
| Chat + song requests | `js/community.js` |
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

`audio/free/` holds seven instrumentals by **Kevin MacLeod (incompetech.com)**,
licensed **CC BY 4.0**. They are hosted here (not hotlinked) and credited in
`CREDITS.md`, on the About page, and under the player. CC BY requires that
attribution stays visible — keep the credits if you keep the tracks. Delete the
folder and the `"freeTracks"` block to run a 100% original station.

The catalogue builder rewrites `CREDITS.md` on every run, so edit attribution in
`data/library.json`, not in the generated file.

---

## The listener room (chat, presence, requests)

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

Requests are also written to `localStorage` and listed on the Contact page.

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
are large — the station adds roughly 230 MB to the repository (47 originals +
7 guest tracks + artwork). If that becomes a problem, move `anthonitus_songs/`
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

## Configuration checklist before publishing

- `data/library.json` → `station.name`, `artist`, `tagline`, `contactEmail`,
  `siteUrl`, socials. **`contactEmail` is intentionally empty**: with no address
  set, the contact form copies the message so it can be sent via YouTube/GitHub.
  Add an address to switch it to `mailto:`.
- `js/config.js` → programme names, hours (UTC), genres, and the community topic.
- `index.html` → About copy, canonical URL, JSON-LD.
- `data/library.json` → genres were assigned from titles, not by listening.
  Adjust them to match how the records actually feel.

---

## Verification performed

- Catalogue build: 54 tracks (47 original + 7 guest), 163 minutes, 47 embedded
  covers extracted.
- Local server range request: `206 Partial Content` with correct
  `Content-Range`, so timeline seeking works.
- Playback: live start lands within ~0.4 s of the station clock; skip → Personal
  mode; rejoin live → resynced; sleep timer, favorites, history and queue
  persist.
- Library: search, genre filter, empty state, sort, favorites-only.
- Chat: message sent and received through the relay from a second client;
  presence count updated; local fallback path present.
- Widget/embed: inline player and floating launcher both play the live feed.
- Layout checked at 1440×900, 1200×900 and 390×844.

Not verified in this environment: real iOS/Android lock-screen behaviour,
Safari autoplay edge cases, and ntfy under heavy chat traffic. See the notes in
the verification list above.
