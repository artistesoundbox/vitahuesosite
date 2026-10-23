/* The on-air clock.
 *
 * Every listener derives the same broadcast from the same inputs: the clock,
 * the programme blocks in config.js, a fixed epoch and UTC time.
 *
 * The day is a grid of fixed slots. Most slots are a live station somewhere in
 * the world (see js/world.js); a seeded number of slots each hour come home to
 * the studio catalogue — your own songs, with the occasional CC guest — and a
 * short station ID sits at the top of those segments. Slot boundaries and the
 * station pick are both deterministic, so a laptop and a phone hear the same
 * city at the same second.
 *
 * Nothing here touches the network; MP3 seeking and stream playback are the
 * browser's job.
 */
import { TRACKS } from './catalog.js';
import * as catalog from './catalog.js';

/* Namespace lookup, not a named import: a visitor whose browser still holds an
   older cached catalog.js would otherwise fail the whole module (and with it
   the site radio) because STATION_ID did not exist yet. */
const STATION_ID = catalog.STATION_ID || null;
import { PROGRAMS, WORLD, STATION_EPOCH, DAY_MS, ROTATION } from './config.js';
import { isBlocked, onBlockChange } from './blocklist.js';
import { WORLD_STATIONS, worldTrack } from './world.js';

const reels = new Map();
/* Which programming the clock is running. `world` is the station as designed;
   `studio` is the same clock running the artist's own catalogue end to end. */
let liveSource = 'world';
/* A day is a whole number of slots; if the config does not divide evenly the
   last slot is shortened rather than spilling into tomorrow. */
const BLOCK_MS = 3600000;

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Pools are rebuilt whenever the device's blocklist changes: a disliked song
   leaves the reel entirely, so it cannot come back later in the day either. */
let GUESTS = [];
let ORIGINALS = [];

function refreshPools() {
  GUESTS = TRACKS.filter((t) => t.guest && !isBlocked(t.id));
  ORIGINALS = TRACKS.filter((t) => !t.guest && !isBlocked(t.id));
  /* Nothing is allowed to empty a pool — a reel needs both sides to exist. */
  if (!GUESTS.length) GUESTS = TRACKS.filter((t) => t.guest);
  if (!ORIGINALS.length) ORIGINALS = TRACKS.filter((t) => !t.guest);
}
refreshPools();
onBlockChange(() => {
  refreshPools();
  reels.clear();
  tails.clear();
});

const FUN = new Set(ROTATION.funGenres || []);
const FUN_WEIGHT = Math.max(1, Math.round(Number(ROTATION.funWeight) || 1));
const FUN_SHARE = Math.min(0.95, Math.max(0, Number(ROTATION.funShare) || 0));
const isFun = (track) => track.genres.some((g) => FUN.has(g));
const IDENT_EVERY = Math.max(0, Number(ROTATION.identEvery) || 0);

/** A bag that repeats the fun genres, so Latin urban / dembow come up more. */
function guestBagFor(guests, rng) {
  const bag = [];
  for (const track of guests) {
    const fun = track.genres.some((g) => FUN.has(g));
    const copies = fun ? FUN_WEIGHT : 1;
    for (let i = 0; i < copies; i++) bag.push(track);
  }
  return shuffled(bag, rng);
}

/**
 * One long pass of the local rotation: cycle the free library in shuffled order
 * and drop one of the artist's own songs in after every `originalEvery` guest
 * tracks. Used by the all-local fallback and by the home segments, where the
 * mix is inverted (mostly originals).
 */
function buildSequence(pool, guests, rng, length = 96, seedRecent = []) {
  const sequence = [];
  const guestBank = { bag: guestBagFor(guests, rng), cursor: 0 };
  const originalBank = { bag: shuffled(pool, rng), cursor: 0 };
  let sinceOriginal = 0;
  let sinceIdent = 0;
  const every = Math.min(12, Math.max(1, Number(ROTATION.originalEvery) || 4));

  /* Cooldown: a track cannot come back until `noRepeatWindow` other songs have
     played. The weighted guest bag holds several copies of each fun track, so
     without this a song could reappear a couple of places after itself. */
  const cooldown = Math.max(0, Number(ROTATION.noRepeatWindow) || 0);
  const recent = seedRecent.slice(-Math.max(0, cooldown));
  const tooSoon = (track) => cooldown > 0 && recent.includes(track.id);
  const remember = (track) => {
    recent.push(track.id);
    while (recent.length > cooldown) recent.shift();
  };

  const refillGuests = () => { guestBank.bag = guestBagFor(guests, rng); guestBank.cursor = 0; };
  const refillOriginals = () => { originalBank.bag = shuffled(pool, rng); originalBank.cursor = 0; };

  /* Take the next bag entry that is out of cooldown; if the whole bag is
     cooling, take the next entry anyway rather than stalling the programme. */
  const draw = (bank, refill, preferFun = false) => {
    for (let i = 0; i < bank.bag.length; i++) {
      if (bank.cursor >= bank.bag.length) refill();
      const candidate = bank.bag[bank.cursor++];
      if (tooSoon(candidate)) continue;
      /* Lean fun: usually skip a non-fun guest while the bag still has a fun
         track to offer. Deterministic, because rng is seeded per programme. */
      if (preferFun && FUN_SHARE > 0 && !isFun(candidate) && rng() > 1 - FUN_SHARE) continue;
      return candidate;
    }
    if (bank.cursor >= bank.bag.length) refill();
    return bank.bag[bank.cursor++];
  };

  /* The station ID drops in after every `identEvery` songs. */
  const maybeIdent = () => {
    if (!IDENT_EVERY || !STATION_ID) return;
    if (++sinceIdent < IDENT_EVERY) return;
    sequence.push(STATION_ID);
    sinceIdent = 0;
  };

  while (sequence.length < length) {
    const guest = draw(guestBank, refillGuests, true);
    sequence.push(guest);
    remember(guest);
    sinceOriginal += 1;
    maybeIdent();

    if (sinceOriginal < every) continue;
    const original = draw(originalBank, refillOriginals);
    sequence.push(original);
    remember(original);
    sinceOriginal = 0;
    maybeIdent();
  }

  return sequence;
}

/* -------------------------------------------------------------- home slots */

/**
 * The repertoire for a home segment: mostly the artist's own recordings, with
 * a guest every few songs. Shares the day's cooldown list with the rest of the
 * reel, so a song that just played in the last home segment does not return.
 */
function homeSequence(program, rng, recent, maxMs) {
  /* The programme's genres are weighted, not enforced: a home segment is only
     two or three songs long, so restricting it to five matching tracks would
     repeat them every hour. Matching tracks simply appear twice in the pool. */
  const own = ORIGINALS.filter((t) => t.genres.some((g) => program.genres.includes(g)));
  const ownPool = own.length ? [...ORIGINALS, ...own] : ORIGINALS;
  const guestPool = GUESTS.length ? GUESTS : ownPool;
  if (!ownPool.length) return [];

  const share = Math.min(1, Math.max(0, Number(WORLD.homeShare) || 0.85));
  const cooldown = Math.max(0, Number(ROTATION.noRepeatWindow) || 0);
  const out = [];

  const pick = (pool) => {
    /* Six tries for something out of cooldown; then take what the draw gives,
       because an empty segment is worse than a repeat. */
    for (let i = 0; i < 6; i++) {
      const candidate = pool[Math.floor(rng() * pool.length)];
      if (!recent.includes(candidate.id)) return candidate;
    }
    return pool[Math.floor(rng() * pool.length)];
  };

  /* Only fill the segment, not a fixed count: tracks generated past the end of
     the slot would sit in the cooldown list without ever being heard, evicting
     songs that *did* play and letting them come back an hour later. */
  let guard = 0;
  let totalMs = 0;
  while (totalMs < maxMs && guard++ < 40) {
    const pool = rng() < share ? ownPool : guestPool;
    const track = pick(pool);
    if (!track) break;
    out.push(track);
    recent.push(track.id);
    while (recent.length > cooldown) recent.shift();
    totalMs += track.duration * 1000;
  }
  return out;
}

/** Positions inside the hour that come home to the studio, seeded per hour. */
function homeSlotsFor(dayKey, hour, slotsPerHour) {
  const count = Math.min(slotsPerHour, Math.max(0, Math.round(Number(WORLD.homeEveryHour) || 0)));
  const set = new Set();
  let guard = 0;
  while (set.size < count && guard++ < 40) {
    const rng = mulberry32(hashString(`${dayKey}|home-slot|${hour}|${set.size}|${STATION_EPOCH}`));
    set.add(Math.floor(rng() * slotsPerHour));
  }
  return set;
}

/* ------------------------------------------------------------ regional lean */

/* A listener can lean the feed toward the region they pick in the tuner. The
   preference lives on the device (ui.js persists it); it only changes *which*
   station fills a slot — the slot grid stays on the shared UTC clock, so a
   leaning listener still crosses a city boundary at :00, :10, :20, :30. */
let leanKey = null;
let leanPool = [];

export function setWorldLean(key) {
  const next = key ? String(key) : null;
  if (next === leanKey) return leanPool;
  leanKey = next;
  leanPool = next
    ? WORLD_STATIONS.filter((s) => `${s.countrycode}|${s.place}` === next)
    : [];
  reels.clear();
  tails.clear();
  return leanPool;
}

export function getWorldLean() {
  return leanKey ? { key: leanKey, stations: leanPool.slice() } : null;
}

/**
 * Switch the live clock between the world feed and the studio programme.
 * The slot grid itself is unchanged, so coming back lands on the city that is
 * on the air right now, not where you left it.
 */
export function setLiveSource(source) {
  const next = source === 'studio' ? 'studio' : 'world';
  if (next === liveSource) return liveSource;
  liveSource = next;
  reels.clear();
  tails.clear();
  return liveSource;
}

export function getLiveSource() {
  return liveSource;
}

const leanShare = () => Math.min(1, Math.max(0, Number(WORLD.leanShare) || 0));

/** A leaning slot, or null when this slot should travel the world as usual. */
function leanedStation(dayKey, slot, previous) {
  if (!leanPool.length || leanPool.length >= WORLD_STATIONS.length) return null;
  const share = leanShare();
  if (share <= 0) return null;
  const roll = hashString(`${dayKey}|lean|${slot}|${STATION_EPOCH}`) % 10000;
  if (roll >= share * 10000) return null;
  const count = leanPool.length;
  const start = hashString(`${dayKey}|lean-city|${slot}|${STATION_EPOCH}`) % count;
  for (let step = 0; step < count; step++) {
    const candidate = leanPool[(start + step) % count];
    if (previous && candidate.id === previous.id) continue;
    return candidate;
  }
  /* A region with a single station: stay tuned. The reel merges the two slots
     into one entry, so the stream is never restarted. */
  return leanPool[start];
}

/** Deterministic city for a slot, never the same station or country twice in a row. */
function worldStationFor(dayKey, slot, previous) {
  if (!WORLD_STATIONS.length) return null;
  const local = leanedStation(dayKey, slot, previous);
  if (local) return local;
  const count = WORLD_STATIONS.length;
  const start = hashString(`${dayKey}|city|${slot}|${STATION_EPOCH}`) % count;
  for (let step = 0; step < count; step++) {
    const candidate = WORLD_STATIONS[(start + step) % count];
    if (previous && candidate.id === previous.id) continue;
    if (WORLD.avoidSameCountry && previous && candidate.countrycode === previous.countrycode) continue;
    return candidate;
  }
  return WORLD_STATIONS[start];
}

/* ---------------------------------------------------------------- day reels */

function buildLocalReel(dayStartMs, carry = []) {
  const dayKey = new Date(dayStartMs).toISOString().slice(0, 10);
  const entries = [];
  let seq = 0;

  for (const block of PROGRAMS) {
    const rng = mulberry32(hashString(`${dayKey}|${block.id}|${STATION_EPOCH}`));
    let pool = ORIGINALS.filter((t) => t.genres.some((g) => block.genres.includes(g)));
    if (pool.length < 6) pool = ORIGINALS.slice();
    if (!pool.length) pool = TRACKS.filter((t) => !t.guest);

    const matching = GUESTS.filter((t) => t.genres.some((g) => block.genres.includes(g)));
    const rest = GUESTS.filter((t) => !matching.includes(t));
    const guests = block.focus && matching.length >= 12
      ? shuffled(matching, rng)
      : [...shuffled(matching, rng), ...shuffled(rest, rng)];

    const recentSongs = () => {
      const tail = entries.filter((e) => !e.track.ident)
        .slice(-(Number(ROTATION.noRepeatWindow) || 0)).map((e) => e.track.id);
      return tail.length ? tail : carry;
    };

    let sequence = buildSequence(pool, guests, rng, 96, recentSongs());
    let cursorIndex = 0;
    const start = block.start * BLOCK_MS;
    const end = block.end * BLOCK_MS;

    let cursor = start;
    let guard = 0;
    while (end - cursor > 20000 && guard++ < 600) {
      if (cursorIndex >= sequence.length) {
        sequence = buildSequence(pool, guests, rng, 96, recentSongs());
        cursorIndex = 0;
      }
      let track = sequence[cursorIndex++];
      const prev = entries[entries.length - 1];
      if (prev && prev.track.id === track.id && sequence.length > 1) {
        track = sequence[cursorIndex++ % sequence.length];
      }

      const fullMs = track.duration * 1000;
      const playMs = Math.min(fullMs, end - cursor);
      entries.push({
        key: `${dayKey}#${seq++}`,
        kind: track.ident ? 'ident' : 'home',
        track,
        startMs: dayStartMs + cursor,
        endMs: dayStartMs + cursor + playMs,
        cut: playMs < fullMs - 750,
        program: block
      });
      cursor += playMs;
    }
  }

  return { dayKey, dayStartMs, entries };
}

/**
 * Build one UTC day of the world feed.
 *
 * Every slot is either a live station or a home segment; the two tile the day
 * exactly, so `getLiveState` never has to guess where the clock is.
 */
function buildWorldReel(dayStartMs, carry = []) {
  const dayKey = new Date(dayStartMs).toISOString().slice(0, 10);
  const slotMinutes = Math.min(30, Math.max(4, Number(WORLD.slotMinutes) || 10));
  const slotMs = slotMinutes * 60000;
  const slotsPerHour = Math.max(1, Math.round(BLOCK_MS / slotMs));
  const slots = Math.ceil(DAY_MS / slotMs);
  const identHours = Math.max(1, Math.round(Number(WORLD.identEveryHours) || 3));

  const entries = [];
  const recent = carry.slice();
  let seq = 0;
  let previousStation = null;
  const homeCache = new Map();

  for (let slot = 0; slot < slots; slot++) {
    const slotIndex = slot * slotMs;
    const startMs = dayStartMs + slotIndex;
    const endMs = Math.min(dayStartMs + DAY_MS, startMs + slotMs);
    if (endMs - startMs < 20000) continue;

    const hour = Math.floor(slotIndex / BLOCK_MS);
    const inHour = slot % slotsPerHour;
    const program = PROGRAMS.find((p) => hour >= p.start && hour < p.end) || PROGRAMS[0];

    if (!homeCache.has(hour)) homeCache.set(hour, homeSlotsFor(dayKey, hour, slotsPerHour));
    const isHome = homeCache.get(hour).has(inHour);

    let cursor = startMs;
    let guard = 0;

    if (isHome) {
      /* The cut from a foreign city back to the studio is the station's most
         recognisable moment, so it always opens with the ID. */
      if (STATION_ID && endMs - cursor > STATION_ID.duration * 1000 + 12000) {
        entries.push({
          key: `${dayKey}#${seq++}`,
          kind: 'ident',
          track: STATION_ID,
          startMs: cursor,
          endMs: cursor + STATION_ID.duration * 1000,
          cut: false,
          program
        });
        cursor += STATION_ID.duration * 1000;
      }

      const rng = mulberry32(hashString(`${dayKey}|home-set|${hour}|${inHour}|${STATION_EPOCH}`));
      const sequence = homeSequence(program, rng, recent, endMs - cursor);
      let i = 0;
      while (endMs - cursor > 12000 && guard++ < 60 && i < sequence.length) {
        const track = sequence[i++];
        const fullMs = track.duration * 1000;
        const playMs = Math.min(fullMs, endMs - cursor);
        if (playMs < 8000) break;
        entries.push({
          key: `${dayKey}#${seq++}`,
          kind: 'home',
          track,
          startMs: cursor,
          endMs: cursor + playMs,
          cut: playMs < fullMs - 750,
          program
        });
        cursor += playMs;
      }

      /* Ran out of repertoire before the slot did: hold the last song to the
         boundary rather than leaving a hole in the timeline. */
      if (cursor < endMs && entries.length) {
        const last = entries[entries.length - 1];
        last.endMs = endMs;
        last.cut = true;
        cursor = endMs;
      }
      continue;
    }

    /* One branded break into the world feed every few hours; home slots are
       already identified, so no double jingles. */
    if (STATION_ID && inHour === 0 && hour % identHours === 0 && endMs - cursor > 90000) {
      entries.push({
        key: `${dayKey}#${seq++}`,
        kind: 'ident',
        track: STATION_ID,
        startMs: cursor,
        endMs: cursor + STATION_ID.duration * 1000,
        cut: false,
        program
      });
      cursor += STATION_ID.duration * 1000;
    }

    if (endMs - cursor < 30000) continue;
    const station = worldStationFor(dayKey, slot, previousStation);
    if (!station) continue;
    previousStation = station;

    /* The same station two slots running (a one-station region leaning, or a
       plain repeat) is one continuous listen, not two reconnects. */
    const last = entries[entries.length - 1];
    if (last && last.kind === 'world' && last.track.station?.id === station.id && last.endMs === cursor) {
      last.endMs = endMs;
      last.track = worldTrack(station, (endMs - last.startMs) / 1000);
      continue;
    }

    entries.push({
      key: `${dayKey}#${seq++}`,
      kind: 'world',
      track: worldTrack(station, (endMs - cursor) / 1000),
      startMs: cursor,
      endMs,
      cut: false,
      program
    });
  }

  return { dayKey, dayStartMs, entries };
}

/**
 * Build one UTC day of programming. Deterministic for a given day.
 *
 * `carry` is the tail of the previous day's songs, so the no-repeat window also
 * holds across midnight — otherwise a song could close the night and open the
 * new day three slots later.
 */
export function buildReel(dayStartMs, carry = []) {
  if (liveSource === 'studio') return buildLocalReel(dayStartMs, carry);
  if (!WORLD.enabled || !WORLD_STATIONS.length) return buildLocalReel(dayStartMs, carry);
  return buildWorldReel(dayStartMs, carry);
}

const tails = new Map();

function previousTail(dayStartMs) {
  const cached = tails.get(dayStartMs);
  if (cached) return cached;
  const window = Number(ROTATION.noRepeatWindow) || 0;
  const before = buildReel(dayStartMs - DAY_MS);
  const tail = before.entries
    .filter((e) => !e.track.ident && !e.track.world)
    .slice(-window)
    .map((e) => e.track.id);
  tails.set(dayStartMs, tail);
  if (tails.size > 4) tails.delete(tails.keys().next().value);
  return tail;
}

export function getReel(now = Date.now()) {
  const dayStartMs = Math.floor(now / DAY_MS) * DAY_MS;
  let reel = reels.get(dayStartMs);
  if (!reel) {
    reel = buildReel(dayStartMs, previousTail(dayStartMs));
    reels.set(dayStartMs, reel);
    for (const key of reels.keys()) {
      if (key !== dayStartMs) reels.delete(key);
    }
  }
  return reel;
}

/**
 * Where the station is right now.
 * @returns {{reel:object, entry:object, index:number, offset:number, queue:object[], drift:number}}
 */
export function getLiveState(now = Date.now(), queueCount = 5) {
  const reel = getReel(now);
  const entries = reel.entries;
  let index = -1;

  for (let i = 0; i < entries.length; i++) {
    if (now < entries[i].endMs) { index = i; break; }
  }
  if (index === -1) index = entries.length - 1;
  if (index < 0) return null;

  let entry = entries[index];
  let offset = Math.max(0, (now - entry.startMs) / 1000);
  if (!entry.track.world && offset > entry.track.duration) offset = entry.track.duration;

  return {
    reel,
    entry,
    index,
    offset,
    queue: entries.slice(index + 1, index + 1 + queueCount),
    drift: Math.max(0, now - entry.startMs)
  };
}

/** The stations coming up after `count` upcoming entries, deduplicated by id. */
export function upcomingCities(count = 3, now = Date.now()) {
  const state = getLiveState(now, Math.max(count * 3, 8));
  if (!state) return [];
  const out = [];
  const seen = new Set(state.entry.track.world ? [state.entry.track.station.id] : []);
  for (const entry of state.queue) {
    if (!entry.track.world) continue;
    const id = entry.track.station.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ station: entry.track.station, startMs: entry.startMs });
    if (out.length >= count) break;
  }
  return out;
}

/* Programme airing at a given moment (UTC clock). */
export function programAt(now = Date.now()) {
  const hour = new Date(now).getUTCHours();
  return PROGRAMS.find((p) => hour >= p.start && hour < p.end) || PROGRAMS[0];
}

/** Milliseconds until the next programme begins. */
export function msUntilNextProgram(now = Date.now()) {
  const d = new Date(now);
  const msIntoDay = ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000;
  const next = PROGRAMS
    .map((p) => p.start * BLOCK_MS)
    .filter((ms) => ms > msIntoDay)
    .sort((a, b) => a - b)[0];
  return (next === undefined ? DAY_MS : next) - msIntoDay;
}

/** "18:00" in the listener's own timezone for a UTC hour. */
export function localHourLabel(utcHour) {
  const d = new Date();
  d.setUTCHours(utcHour % 24, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDuration(seconds) {
  const mins = Math.round((Number(seconds) || 0) / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} hr ${mins % 60} min`;
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}
