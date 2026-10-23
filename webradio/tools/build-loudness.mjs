#!/usr/bin/env node
/* Loudness levelling.
 *
 *   node tools/build-loudness.mjs               # measure what is missing
 *   node tools/build-loudness.mjs --force       # re-measure everything
 *   node tools/build-loudness.mjs --stations    # world stations only
 *   node tools/build-loudness.mjs --tracks      # local catalogue only
 *
 * Streams and masters are mastered to different loudness. The world feed is
 * mostly brickwalled pop radio; the studio songs breathe. Switching between
 * them at the top of an hour therefore jumps in volume. This tool measures both
 * with ffmpeg's EBU R128 scanner (the same measure radio and streaming use) and
 * writes a static gain per track / per station into `js/loudness.js`.
 *
 * The player applies the gain to `audio.volume` — not a compressor and not a
 * Web Audio graph, so background playback, lock-screen controls and the native
 * media pipeline keep working.
 *
 * Measurements are cached in `data/loudness.json`:
 *   • a local track is re-measured when the file's mtime changes,
 *   • a station is re-measured when its stream URL changes.
 *
 * Requires ffmpeg on PATH (the catalogue build already needs it).
 */
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKS, STATION_ID } from '../js/catalog.js';
import { WORLD_FEED } from '../js/world-stations.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data/loudness.json');
const MODULE = resolve(ROOT, 'js/loudness.js');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const SAMPLE_SECONDS = Number(process.env.LOUDNESS_SAMPLE_SECONDS) || 12;
const CONCURRENCY = Number(process.env.LOUDNESS_CONCURRENCY) || 6;
const TRACK_LIMIT_SECONDS = 150;   // enough to be representative, fast enough to batch

/* Gain limits. Attenuation is cheap; boosting is limited because it eats the
   headroom between the listener's volume and clipping. */
const TRACK_GAIN = { min: -12, max: 4 };
const STATION_GAIN = { min: -18, max: 6 };
/* A measurement outside this band is not a measurement (silence, a test tone,
   an inaudible stream) — leave that item alone. */
const SENSIBLE = { min: -45, max: -3 };

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const onlyStations = args.has('--stations') || args.has('--stations-only');
const onlyTracks = args.has('--tracks') || args.has('--tracks-only');

const stations = Array.isArray(WORLD_FEED?.stations) ? WORLD_FEED.stations : [];
const tracks = [STATION_ID, ...TRACKS].filter(Boolean);

const log = (...parts) => console.log(...parts);

function measure(input, { seconds, timeoutMs }) {
  const command = [
    '-nostdin',
    ...(seconds ? ['-t', String(seconds)] : []),
    '-i', input,
    '-vn',
    '-af', 'ebur128',
    '-f', 'null',
    '-'
  ];
  return new Promise((resolvePromise) => {
    execFile(FFMPEG, command, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
      if (error && !stderr) return resolvePromise(null);
      const match = /Integrated loudness:[\s\S]*?I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(String(stderr || ''));
      if (!match) return resolvePromise(null);
      const lufs = Number(match[1]);
      resolvePromise(Number.isFinite(lufs) ? Math.round(lufs * 10) / 10 : null);
    });
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
      done += 1;
      if (done % 10 === 0 || done === items.length) log(`  … ${done}/${items.length}`);
    }
  }));
  return results;
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const clampGain = (gain, limits) => Math.round(Math.min(limits.max, Math.max(limits.min, gain)) * 10) / 10;

/* A run takes minutes; checkpoint after every measurement so an interrupted run
   keeps what it already learned. Writes are serialised through one promise. */
let saveChain = Promise.resolve();
function checkpoint(cache) {
  const snapshot = JSON.stringify(cache, null, 2) + '\n';
  saveChain = saveChain
    .then(() => mkdir(dirname(DATA), { recursive: true }))
    .then(() => writeFile(DATA, snapshot))
    .catch(() => { /* keep measuring even if a checkpoint fails */ });
  return saveChain;
}

async function main() {
  let cache = { tracks: {}, stations: {} };
  try {
    cache = { ...cache, ...JSON.parse(await readFile(DATA, 'utf8')) };
  } catch { /* first run */ }

  /* ------------------------------------------------------------ local songs */
  if (!onlyStations) {
    log(`Local catalogue: ${tracks.length} files (up to ${TRACK_LIMIT_SECONDS}s each)`);
    const targets = [];
    for (const track of tracks) {
      /* Catalogue paths are URL-encoded so they work as <audio> sources;
         decode them for the filesystem. */
      let abs;
      try {
        abs = resolve(ROOT, decodeURIComponent(track.src));
      } catch {
        abs = resolve(ROOT, track.src);
      }
      let info;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      const cached = cache.tracks[track.id];
      if (!force && cached && cached.at >= Math.floor(info.mtimeMs)) {
        targets.push({ track, lufs: cached.lufs, cached: true });
        continue;
      }
      targets.push({ track, abs });
    }

    const fresh = targets.filter((t) => !t.cached);
    if (fresh.length) {
      const measured = await mapLimit(fresh, CONCURRENCY, async (item) => {
        const lufs = await measure(item.abs, { seconds: TRACK_LIMIT_SECONDS, timeoutMs: 180000 });
        const ok = lufs != null && lufs >= SENSIBLE.min && lufs <= SENSIBLE.max;
        cache.tracks[item.track.id] = ok
          ? { lufs, at: Math.floor((await stat(item.abs)).mtimeMs) }
          : { lufs: null, at: Math.floor(Date.now()) };
        item.lufs = ok ? lufs : null;
        checkpoint(cache);
        return item;
      });
      measured.forEach((item) => { item.lufs = cache.tracks[item.track.id]?.lufs ?? null; });
    }
    targets.forEach((item) => { item.lufs = cache.tracks[item.track.id]?.lufs ?? item.lufs ?? null; });

    const all = targets.map((t) => t.lufs);
    cache.localLufs = all;
    const localMedian = median(all);
    log(`  measured ${all.filter(Number.isFinite).length}/${tracks.length} · median ${localMedian == null ? 'n/a' : localMedian + ' LUFS'}`);
  }

  /* ---------------------------------------------------------- world stations */
  if (!onlyTracks) {
    log(`World stations: ${stations.length} streams (${SAMPLE_SECONDS}s each)`);
    const todo = [];
    for (const station of stations) {
      const cached = cache.stations[station.id];
      if (!force && cached && cached.url === station.url) continue;
      todo.push(station);
    }
    log(`  ${todo.length} to measure (${stations.length - todo.length} cached)`);
    await mapLimit(todo, CONCURRENCY, async (station) => {
      const lufs = await measure(station.url, { seconds: SAMPLE_SECONDS, timeoutMs: 35000 });
      const ok = lufs != null && lufs >= SENSIBLE.min && lufs <= SENSIBLE.max;
      cache.stations[station.id] = { lufs: ok ? lufs : null, url: station.url, at: Math.floor(Date.now() / 1000) };
      checkpoint(cache);
      return station;
    });

    /* Stations that dropped out of the list can go. */
    const keep = new Set(stations.map((s) => s.id));
    for (const id of Object.keys(cache.stations)) if (!keep.has(id)) delete cache.stations[id];

    const values = stations.map((s) => cache.stations[s.id]?.lufs).filter(Number.isFinite);
    const stationMedian = median(values);
    log(`  measured ${values.length}/${stations.length} · median ${stationMedian == null ? 'n/a' : stationMedian + ' LUFS'}`);
  }

  /* ------------------------------------------------------------------ output */
  const localValues = (cache.localLufs || []).filter(Number.isFinite);
  const cachedTarget = Number(cache.target);
  /* `--stations` alone reuses the stored target, otherwise its gains would all
     shift the moment the local median is unavailable. */
  const target = localValues.length
    ? Math.min(-12, Math.max(-20, Math.round(median(localValues) * 10) / 10))
    : (Number.isFinite(cachedTarget) ? cachedTarget : -16);

  const trackGains = {};
  for (const track of tracks) {
    const lufs = cache.tracks[track.id]?.lufs;
    if (!Number.isFinite(lufs)) continue;
    const gain = clampGain(target - lufs, TRACK_GAIN);
    if (Math.abs(gain) >= 0.1) trackGains[track.id] = gain;
  }

  const stationGains = {};
  for (const station of stations) {
    const lufs = cache.stations[station.id]?.lufs;
    if (!Number.isFinite(lufs)) continue;
    const gain = clampGain(target - lufs, STATION_GAIN);
    if (Math.abs(gain) >= 0.1) stationGains[station.id] = gain;
  }

  cache.target = target;
  cache.generated = new Date().toISOString().slice(0, 10);
  await checkpoint(cache);

  const module = `/* AUTO-GENERATED by tools/build-loudness.mjs — do not hand-edit.
 *
 * EBU R128 trims against the local catalogue's median loudness
 * (${target} LUFS). Applied to <audio>.volume, never through Web Audio, so
 * lock-screen playback keeps working. Rebuild after adding music or refreshing
 * the world station list:  node tools/build-loudness.mjs
 *
 * ${Object.keys(trackGains).length} tracks · ${Object.keys(stationGains).length} stations trimmed.
 */
export const LOUDNESS = ${JSON.stringify({ target, tracks: trackGains, stations: stationGains }, null, 2)};
`;
  await writeFile(MODULE, module);

  log(`\nTarget ${target} LUFS · ${Object.keys(trackGains).length} tracks trimmed · ${Object.keys(stationGains).length} stations trimmed`);
  if (Object.keys(stationGains).length) {
    const sample = Object.entries(stationGains).slice(0, 5).map(([id, db]) => {
      const station = stations.find((s) => s.id === id);
      return `${station ? station.name : id} ${db > 0 ? '+' : ''}${db} dB`;
    });
    log(`e.g. ${sample.join(' · ')}`);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
