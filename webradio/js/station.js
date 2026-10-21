/* The on-air clock.
 *
 * Every listener derives the same broadcast from the same inputs: the track
 * catalogue, the programme blocks in config.js, a fixed epoch and UTC time.
 * Shuffle order is seeded by (UTC day + programme), so the reel is stable for
 * the whole day and identical on every device — a real station timeline,
 * served entirely from static files.
 *
 * Nothing here touches the network; MP3 seeking is handled by the browser.
 */
import { TRACKS } from './catalog.js';
import * as catalog from './catalog.js';

/* Namespace lookup, not a named import: a visitor whose browser still holds an
   older cached catalog.js would otherwise fail the whole module (and with it
   the site radio) because STATION_ID did not exist yet. */
const STATION_ID = catalog.STATION_ID || null;
import { PROGRAMS, STATION_EPOCH, DAY_MS, ROTATION } from './config.js';

const reels = new Map();

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

const BLOCK_MS = 3600000;
const GUESTS = TRACKS.filter((t) => t.guest);
const ORIGINALS = TRACKS.filter((t) => !t.guest);

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
 * One long pass of the rotation: cycle the free library in shuffled order and
 * drop one of the artist's own songs in after every `originalEvery` guest
 * tracks. Both bags reshuffle when exhausted, and immediate repeats are
 * avoided even across a reshuffle.
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

/** Build one UTC day of programming. Deterministic for a given day. */
export function buildReel(dayStartMs) {
  const dayKey = new Date(dayStartMs).toISOString().slice(0, 10);
  const entries = [];
  let seq = 0;

  for (const block of PROGRAMS) {
    const rng = mulberry32(hashString(`${dayKey}|${block.id}|${STATION_EPOCH}`));
    let pool = ORIGINALS.filter((t) => t.genres.some((g) => block.genres.includes(g)));
    if (pool.length < 6) pool = ORIGINALS.slice();

    // The free library cycles in full every hour; start each pass with the
    // tracks that fit this programme's mood, then the rest.
    const matching = GUESTS.filter((t) => t.genres.some((g) => block.genres.includes(g)));
    const rest = GUESTS.filter((t) => !matching.includes(t));
    const guests = [...shuffled(matching, rng), ...shuffled(rest, rng)];

    /* Carry the cooldown across the programme boundary, otherwise the same
       song can close one hour and open the next. */
    const recentSongs = () => entries.filter((e) => !e.track.ident)
      .slice(-(Number(ROTATION.noRepeatWindow) || 0)).map((e) => e.track.id);

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

export function getReel(now = Date.now()) {
  const dayStartMs = Math.floor(now / DAY_MS) * DAY_MS;
  let reel = reels.get(dayStartMs);
  if (!reel) {
    reel = buildReel(dayStartMs);
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
  if (offset > entry.track.duration) offset = entry.track.duration;

  return {
    reel,
    entry,
    index,
    offset,
    queue: entries.slice(index + 1, index + 1 + queueCount),
    drift: Math.max(0, now - entry.startMs)
  };
}

/** Programme airing at a given moment (UTC clock). */
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
