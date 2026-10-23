import { setWorldLean, buildReel } from '../js/station.js';
import { WORLD_STATIONS } from '../js/world.js';
import { DAY_MS } from '../js/config.js';

const key = 'BG|Sofia City';
const pool = WORLD_STATIONS.filter((s) => `${s.countrycode}|${s.place}` === key).map((s) => s.id);
setWorldLean(key);

let slots = 0;
let hits = 0;
let home = 0;
const perDay = [];
for (let d = 0; d < 20; d++) {
  const day = Date.UTC(2026, 0, 1) + d * DAY_MS;
  const reel = buildReel(day);
  let s = 0;
  let h = 0;
  for (const e of reel.entries) {
    if (e.kind === 'home') h++;
    if (e.kind !== 'world') continue;
    s++;
    if (pool.includes(e.track.station.id)) hits++;
  }
  slots += s;
  home += h;
  perDay.push(((hits) => hits)(s ? 0 : 0));
  console.log(new Date(day).toISOString().slice(0, 10), 'world entries', s, 'home entries', h);
}
console.log('pool', pool, 'world entries', slots, 'in region', hits, 'share', ((hits / slots) * 100).toFixed(1) + '%');
console.log('home entries total', home);
