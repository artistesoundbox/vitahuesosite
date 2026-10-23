/* The world feed: live radio stations, and the art that stands in for them.
 *
 * The station list itself is generated (js/world-stations.js) from the open
 * Radio Browser directory; this module only turns a station record into the
 * shape the rest of the site already understands — a "track" with a title, an
 * artist line, artwork and a source.
 *
 * Nothing here touches the network. Streams are opened by player.js only when a
 * slot actually starts, so importing this file costs one JSON-shaped read.
 */
import { WORLD_FEED } from './world-stations.js';

export const WORLD_STATIONS = Array.isArray(WORLD_FEED?.stations) ? WORLD_FEED.stations : [];
export const WORLD_SOURCE = WORLD_FEED?.source || 'Radio Browser';
export const WORLD_COUNTRIES = new Set(WORLD_STATIONS.map((s) => s.countrycode)).size;

/* Country colours. Two stops per country group, seeded by the country code so
   the same city always has the same tile. */
const PALETTE = [
  ['#1b2a4a', '#3d6cb9'],
  ['#2a1b3d', '#8b5cf6'],
  ['#0f2f2b', '#2bb673'],
  ['#3b1b22', '#e0577a'],
  ['#3a2a12', '#e8a33d'],
  ['#12283b', '#38b6ff'],
  ['#2b1b3a', '#c0569a'],
  ['#1a2b1f', '#7bc96f'],
  ['#2d1a12', '#e07a4f'],
  ['#0f2436', '#59d0c8']
];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A square tile for a station: its country code, a soft ring, and one of ten
 * two-tone gradients. Drawn as an inline SVG so there is no image request and
 * nothing to cache — the same trick the guest shelf uses for its cover.
 */
export function stationArt(station) {
  const cc = String(station?.countrycode || '').toUpperCase() || '··';
  const [from, to] = PALETTE[hash(cc) % PALETTE.length];
  const label = escSvg(cc);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-opacity=".16">
    <circle cx="100" cy="100" r="74"/><circle cx="100" cy="100" r="56"/>
    <circle cx="100" cy="100" r="38"/>
  </g>
  <text x="100" y="106" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="58" font-weight="700" letter-spacing="2" fill="#ffffff" fill-opacity=".94">${label}</text>
  <text x="100" y="136" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="10.5" letter-spacing="4" fill="#ffffff" fill-opacity=".55">WORLD FEED</text>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escSvg(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * A live station in the same shape as a catalogue track. `seconds` is how long
 * the slot lasts when the station is on the clock; pass 0 for a hand-tuned
 * stream, which has no end.
 */
export function worldTrack(station, seconds = 0) {
  const place = station.place && station.place !== station.country
    ? `${station.place}, ${station.country}`
    : station.country;
  return {
    id: `world:${station.id}`,
    title: station.name,
    artist: `Live from ${place}`,
    album: station.country,
    year: null,
    genres: (station.tags || []).slice(0, 3),
    duration: Math.round(seconds) || 0,
    src: station.url,
    art: stationArt(station),
    license: '',
    licenseUrl: '',
    credit: `Live stream · ${place}`,
    source: station.homepage || '',
    downloadable: false,
    featured: false,
    guest: false,
    ident: false,
    world: true,
    station
  };
}

/** A station that is not in `exclude` — used by the tuner's dial. */
export function randomStation(exclude = []) {
  if (!WORLD_STATIONS.length) return null;
  const skip = new Set(exclude);
  const pool = WORLD_STATIONS.filter((s) => !skip.has(s.id));
  const list = pool.length ? pool : WORLD_STATIONS;
  return list[Math.floor(Math.random() * list.length)];
}

export function stationById(id) {
  return WORLD_STATIONS.find((s) => s.id === id) || null;
}
