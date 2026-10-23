import { setWorldLean, getWorldLean, buildReel, getLiveState } from '../js/station.js';
import { WORLD_STATIONS } from '../js/world.js';
import { WORLD, DAY_MS, STATION_EPOCH } from '../js/config.js';

const shares = (reel, key) => {
  const worlds = reel.entries.filter((e) => e.kind === 'world');
  const local = worlds.filter((e) => `${e.track.station.countrycode}|${e.track.station.place}` === key);
  const at = (list) => list.reduce((ms, e) => ms + (e.endMs - e.startMs), 0);
  const total = at(worlds);
  return { worlds: worlds.length, local: local.length, pct: total ? (at(local) / total) * 100 : 0 };
};

const adjacentDupes = (reel) => reel.entries.filter((e, i) => i > 0
  && e.kind === 'world' && reel.entries[i - 1].kind === 'world'
  && e.track.station.id === reel.entries[i - 1].track.station.id).length;

const groups = new Map();
for (const s of WORLD_STATIONS) {
  const k = `${s.countrycode}|${s.place}`;
  groups.set(k, (groups.get(k) || 0) + 1);
}
const busiest = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
const single = [...groups.entries()].find(([, n]) => n === 1);
console.log('regions:', groups.size, 'busiest:', busiest, 'share target:', WORLD.leanShare);

const day = Date.UTC(2026, 5, 1);
setWorldLean(null);
const base = buildReel(day);
const baseIds = base.entries.filter((e) => e.kind === 'world').map((e) => e.track.station.id);

setWorldLean(busiest[0]);
const leaned = buildReel(day);
const again = buildReel(day);
const leanedIds = leaned.entries.filter((e) => e.kind === 'world').map((e) => e.track.station.id);
const same = leanedIds.length === again.entries.filter((e) => e.kind === 'world').length
  && leanedIds.every((id, i) => id === again.entries.filter((e) => e.kind === 'world')[i].track.station.id);
console.log('lean set to', busiest[0], '| pool', getWorldLean().stations.length);
console.log('busiest-region share of world slots:', shares(leaned, busiest[0]).pct.toFixed(1) + '%');
console.log('deterministic with lean:', same);
console.log('back-to-back same stream:', adjacentDupes(leaned));

setWorldLean(single[0]);
const thin = buildReel(day);
console.log('single-station region', single[0], 'share:', shares(thin, single[0]).pct.toFixed(1) + '%');
console.log('thin region back-to-back same stream:', adjacentDupes(thin));
const longest = thin.entries.filter((e) => e.track.station && `${e.track.station.countrycode}|${e.track.station.place}` === single[0])
  .sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs))[0];
console.log('thin region longest single listen:', ((longest.endMs - longest.startMs) / 60000).toFixed(0) + ' min');

setWorldLean(null);
const reset = buildReel(day);
const resetIds = reset.entries.filter((e) => e.kind === 'world').map((e) => e.track.station.id);
console.log('cleared lean restores shared picks:', resetIds.length === baseIds.length && resetIds.every((id, i) => id === baseIds[i]));
console.log('entries tile the day:', reset.entries[0].startMs === day
  && reset.entries.at(-1).endMs === day + DAY_MS
  && reset.entries.every((e, i) => i === 0 || e.startMs === reset.entries[i - 1].endMs));

const now = STATION_EPOCH + 5 * DAY_MS + 7 * 3600e3;
const live = getLiveState(now);
console.log('live slot:', live.entry.kind, live.entry.track.station ? live.entry.track.station.place : 'studio');
