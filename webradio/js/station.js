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
import { PROGRAMS, STATION_EPOCH, DAY_MS } from './config.js';

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

/** Build one UTC day of programming. Deterministic for a given day. */
export function buildReel(dayStartMs) {
  const dayKey = new Date(dayStartMs).toISOString().slice(0, 10);
  const entries = [];
  let seq = 0;

  for (const block of PROGRAMS) {
    const rng = mulberry32(hashString(`${dayKey}|${block.id}|${STATION_EPOCH}`));
    let pool = TRACKS.filter((t) => t.genres.some((g) => block.genres.includes(g)));
    if (pool.length < 6) pool = TRACKS.slice();

    let bag = shuffled(pool, rng);
    let bagIndex = 0;
    const start = block.start * BLOCK_MS;
    const end = block.end * BLOCK_MS;

    let cursor = start;
    let guard = 0;
    while (end - cursor > 20000 && guard++ < 600) {
      if (bagIndex >= bag.length) {
        bag = shuffled(pool, rng);
        bagIndex = 0;
      }
      let track = bag[bagIndex++];
      const prev = entries[entries.length - 1];
      if (prev && prev.track.id === track.id && bag.length > 1) {
        track = bag[bagIndex++ % bag.length];
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
