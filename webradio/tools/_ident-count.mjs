import { buildReel } from '../js/station.js';
import { DAY_MS, WORLD } from '../js/config.js';

const day = Date.UTC(2026, 9, 23);
const reel = buildReel(day);
const kinds = { world: 0, home: 0, ident: 0 };
const ms = { world: 0, home: 0, ident: 0 };
for (const e of reel.entries) {
  kinds[e.kind]++;
  ms[e.kind] += e.endMs - e.startMs;
}
const total = DAY_MS;
const pct = (v) => ((v / total) * 100).toFixed(1);
const cities = new Set(reel.entries.filter((e) => e.kind === 'world').map((e) => e.track.station.id));
const homeIdents = reel.entries.filter((e, i) => e.kind === 'ident'
  && reel.entries[i + 1] && reel.entries[i + 1].kind === 'home').length;
console.log('identEveryHours:', WORLD.identEveryHours);
console.log('entries:', reel.entries.length, kinds);
console.log('airtime %:', { world: pct(ms.world), home: pct(ms.home), ident: pct(ms.ident) });
console.log('home-opening idents:', homeIdents, '| city count:', cities.size);
console.log('tiles:', reel.entries[0].startMs === day
  && reel.entries.at(-1).endMs === day + total
  && reel.entries.every((e, i) => i === 0 || e.startMs === reel.entries[i - 1].endMs));
