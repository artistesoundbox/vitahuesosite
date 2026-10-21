#!/usr/bin/env node
/**
 * Rotation check — walks the real live reel for a few days and reports how far
 * apart songs repeat and how much of it is the fun shelf. Run after changing
 * the catalogue or ROTATION:  node tools/check-rotation.mjs [days]
 */
import { getReel } from '../js/station.js';
import { ROTATION, DAY_MS } from '../js/config.js';

const days = Number(process.argv[2]) || 3;
const start = Date.UTC(2026, 0, 1);

const songs = [];
for (let d = 0; d < days; d++) {
  /* getReel is the path the browser takes, so midnight carry-over is
     exercised here rather than simulated. */
  for (const entry of getReel(start + d * DAY_MS + 12 * 3600 * 1000).entries) {
    if (entry.track.ident) continue;
    songs.push(entry.track);
  }
}

const lastSeen = new Map();
let shortest = Infinity;
let fun = 0;
let guests = 0;
const perTrack = new Map();

songs.forEach((t, i) => {
  const prev = lastSeen.get(t.id);
  if (prev != null) shortest = Math.min(shortest, i - prev);
  lastSeen.set(t.id, i);
  perTrack.set(t.id, (perTrack.get(t.id) || 0) + 1);
  if (t.guest) {
    guests += 1;
    if ((t.genres || []).some((g) => ROTATION.funGenres.includes(g))) fun += 1;
  }
});

const total = songs.length;
const guestShare = ((guests / total) * 100).toFixed(0);
const funShare = guests ? ((fun / guests) * 100).toFixed(0) : '0';
const gaps = [...lastSeen.keys()].length;

console.log(`${total} songs over ${days} days · ${new Set(songs.map((s) => s.id)).size} unique`);
console.log(`guest share ${guestShare}% · fun share of guest picks ${funShare}% (target ${(ROTATION.funShare * 100).toFixed(0)}%)`);
console.log(`shortest gap between plays of the same song: ${shortest === Infinity ? 'n/a' : shortest} songs`);
console.log(`tracks that played: ${gaps}`);
const worst = [...perTrack.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log('most played:', worst.map(([id, n]) => `${id}×${n}`).join(', '));
const named = [...perTrack.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([id, n]) => {
    const t = songs.find((s) => s.id === id);
    return `${t ? `${t.artist} — ${t.title}` : id} ×${n}`;
  });
console.log('top:', named.join(' | '));
