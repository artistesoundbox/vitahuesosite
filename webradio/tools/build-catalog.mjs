#!/usr/bin/env node
/**
 * Catalog builder — reads data/library.json plus the MP3 files on disk and
 * writes js/catalog.js (the only file the browser reads).
 *
 *   node tools/build-catalog.mjs            # build, reuse existing artwork
 *   node tools/build-catalog.mjs --force    # re-extract all artwork
 *
 * Durations come from ffprobe, so the on-air timeline is exact. Album art is
 * pulled from each MP3's embedded cover and resized to 512px. Nothing here
 * runs in the browser and nothing is fetched from a third party at runtime.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');
const SONG_DIR = join(ROOT, 'anthonitus_songs');
const FREE_DIR = join(ROOT, 'audio', 'free');
const ART_DIR = join(ROOT, 'assets', 'art');
const DATA = JSON.parse(readFileSync(join(ROOT, 'data', 'library.json'), 'utf8'));

mkdirSync(ART_DIR, { recursive: true });

function probe(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'format=duration:stream=codec_name',
    '-of', 'json', file
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe failed for ${file}: ${r.stderr}`);
  const data = JSON.parse(r.stdout);
  return {
    duration: Math.round(parseFloat(data.format.duration)),
    codec: data.streams?.[0]?.codec_name || 'mp3'
  };
}

function hasCover(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function extractArt(file, out) {
  if (!FORCE && existsSync(out) && statSync(out).size > 2000) return true;
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-an', '-vframes', '1',
    '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512',
    '-q:v', '5', out], { encoding: 'utf8' });
  return r.status === 0 && existsSync(out);
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

const albums = DATA.albums.map((a) => ({ ...a, cover: enc(a.cover) }));
const albumById = new Map(albums.map((a) => [a.id, a]));
const genres = new Set();

/* ---------------- the artist's own library ---------------- */
const files = readdirSync(SONG_DIR).filter((f) => /\.mp3$/i.test(f));
const tracks = [];

for (const file of files) {
  const m = file.match(/^0*(\d+)\s*[-–.]\s*(.+?)\.mp3$/i);
  if (!m) { console.warn(`  ! skipped (no track number): ${file}`); continue; }
  const num = parseInt(m[1], 10);
  const meta = DATA.tracks[String(num)];
  if (!meta) { console.warn(`  ! no metadata for track ${num} (${file})`); continue; }

  const full = join(SONG_DIR, file);
  const id = `t${String(num).padStart(2, '0')}`;
  const { duration } = probe(full);
  const artFile = join(ART_DIR, `${id}.jpg`);
  const album = albumById.get(meta.album);
  if (!album) throw new Error(`unknown album "${meta.album}" for track ${num}`);

  let art = enc(`assets/art/${id}.jpg`);
  if (hasCover(full) && extractArt(full, artFile)) {
    // embedded artwork extracted
  } else {
    art = album.cover; // fall back to the album cover
  }

  const genresList = meta.genres || ['Ambient'];
  genresList.forEach((g) => genres.add(g));

  tracks.push({
    id,
    trackNo: num,
    title: meta.title,
    artist: DATA.station.artist,
    albumId: album.id,
    album: album.title,
    year: album.year,
    genres: genresList,
    duration,
    src: enc(`anthonitus_songs/${file}`),
    art,
    license: 'All rights reserved',
    licenseUrl: '',
    credit: `${meta.title} — written & performed by ${DATA.station.artist}` +
      (DATA.station.aka ? ` (${DATA.station.aka})` : ''),
    source: '',
    downloadable: meta.downloadable !== false,
    featured: !!meta.featured,
    guest: false
  });
}

/* ---------------- guest songs & instrumentals (CC BY) ---------------- */
const freeTracks = [];
let fIndex = 0;
for (const f of DATA.freeTracks) {
  const full = join(FREE_DIR, f.file);
  if (!existsSync(full)) { console.warn(`  ! missing free track: ${f.file}`); continue; }
  fIndex += 1;
  const id = `f${String(fIndex).padStart(2, '0')}`;
  const { duration } = probe(full);
  const album = albumById.get(f.album);
  (f.genres || ['Ambient']).forEach((g) => genres.add(g));
  freeTracks.push({
    id,
    trackNo: 100 + fIndex,
    title: f.title,
    artist: f.artist || 'Various artists',
    albumId: album.id,
    album: album.title,
    year: album.year,
    genres: f.genres || ['Ambient'],
    duration,
    src: enc(`audio/free/${f.file}`),
    art: album.cover,
    license: f.license,
    licenseUrl: f.licenseUrl,
    credit: f.credit,
    source: f.source,
    downloadable: true,
    featured: false,
    guest: true
  });
}

// Track numbers, not filenames: "010-…" must sit after "02-…".
tracks.sort((a, b) => a.trackNo - b.trackNo);

const all = [...tracks, ...freeTracks];
if (!all.length) throw new Error('No tracks found — check anthonitus_songs/');

const genreOrder = ['Soul', 'Rock', 'Pop', 'Funk', 'Hip-Hop', 'Jazz', 'Latin', 'Country', 'Reggae',
  'Folk', 'Blues', 'Electronic', 'Ambient', 'Piano', 'Cinematic', 'Lo-Fi', 'Meditative'];
const genreList = genreOrder.filter((g) => genres.has(g))
  .concat([...genres].filter((g) => !genreOrder.includes(g)));

const stats = {
  tracks: all.length,
  originals: tracks.length,
  guest: freeTracks.length,
  genres: genreList,
  totalSeconds: all.reduce((n, t) => n + t.duration, 0),
  albums: albums.length
};

/* ---------------- write the browser catalog ---------------- */
const out = `/* AUTO-GENERATED by tools/build-catalog.mjs — do not hand-edit.
 * Track metadata lives in data/library.json; audio in anthonitus_songs/ and audio/free/.
 * Rebuild with:  node tools/build-catalog.mjs
 */
export const STATION = ${JSON.stringify(DATA.station, null, 2)};

export const ALBUMS = ${JSON.stringify(albums, null, 2)};

export const GENRES = ${JSON.stringify(genreList)};

export const STATS = ${JSON.stringify(stats, null, 2)};

export const TRACKS = ${JSON.stringify(all, null, 2)};
`;

writeFileSync(join(ROOT, 'js', 'catalog.js'), out);

/* ---------------- free-license credits file ---------------- */
const credits = [
  '# Music credits & licenses',
  '',
  '## Original music',
  '',
  `All tracks by ${DATA.station.artist}` +
    (DATA.station.aka ? ` (${DATA.station.aka})` : '') +
    `, a.k.a. ${DATA.station.alias}, are © ${new Date().getFullYear()} ${DATA.station.artist}.` +
    ' All rights reserved.',
  '',
  '## Guest songs & instrumentals',
  '',
  'The following tracks by independent artists are hosted on this site under',
  'Creative Commons Attribution licences (CC BY). Each entry credits its author and',
  'links back to the original upload; the licence permits commercial and',
  'non-commercial reuse with attribution.',
  'They appear in the live rotation and in the library alongside the original catalogue.',
  '',
  ...freeTracks.map((t) => `- **${t.title}** — ${t.artist}. ${t.license}. ${t.credit.replace(/"/g, '"')}\n  ${t.licenseUrl} · ${t.source}`),
  ''
].join('\n');
writeFileSync(join(ROOT, 'CREDITS.md'), credits);

console.log(`✓ ${all.length} tracks (${tracks.length} originals + ${freeTracks.length} guest)`);
console.log(`✓ ${Math.round(stats.totalSeconds / 60)} minutes of music · genres: ${genreList.join(', ')}`);
console.log(`✓ wrote js/catalog.js and CREDITS.md`);
