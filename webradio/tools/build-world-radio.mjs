#!/usr/bin/env node
/* Build the world-feed station list.
 *
 *   node tools/build-world-radio.mjs
 *
 * Source: Radio Browser (https://www.radio-browser.info) — a free, open,
 * community-maintained directory of public internet radio streams. No key, no
 * account. Radio Garden publishes no API or embed of its own, so the same
 * content is assembled here from the open directory instead of from them.
 *
 * The output is a plain ES module, `js/world-stations.js`, because the station
 * clock is synchronous: importing the list means the whole day's schedule is
 * known before the first byte of audio loads, and every listener gets the same
 * station in the same slot.
 *
 * Rules kept by this script:
 *   • HTTPS only — the site is served over HTTPS and a plain-HTTP stream is
 *     blocked as mixed content.
 *   • MP3 or AAC only — universal in browsers; no Ogg (Safari), no HLS.
 *   • `lastcheckok` from the directory, then every URL is probed here; a
 *     station that does not answer with audio is dropped.
 *   • At most `PER_COUNTRY` stations per country, so the feed reads as a world
 *     tour rather than a list of German webcasters.
 */
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://de1.api.radio-browser.info/json/stations/search';
const UA = 'VitaHuesoRadio/1.0 (+https://artistesoundbox.github.io/vitahuesosite/webradio/)';
const PER_COUNTRY = 3;

/* A spread of the world, weighted by where independent radio actually lives
   in the directory. Order matters only for tie-breaking. */
const COUNTRIES = [
  'AR', 'AU', 'AT', 'BE', 'BO', 'BR', 'BG', 'CA', 'CL', 'CO', 'CR', 'CU', 'CZ',
  'DK', 'DO', 'EC', 'EE', 'EG', 'FI', 'FR', 'DE', 'GH', 'GR', 'GT', 'HU', 'IN',
  'ID', 'IE', 'IL', 'IT', 'JM', 'JP', 'KE', 'KR', 'LT', 'LV', 'MA', 'MX', 'NL',
  'NZ', 'NG', 'NO', 'PE', 'PH', 'PL', 'PT', 'PR', 'RO', 'RS', 'RU', 'SN', 'SK',
  'SI', 'ZA', 'ES', 'SE', 'CH', 'TR', 'UA', 'GB', 'US', 'UY', 'VE', 'VN'
];

const REGION_NAMES = {
  'US-CA': 'California', 'US-NY': 'New York', 'US-TX': 'Texas', 'US-FL': 'Florida',
  'US-IL': 'Illinois', 'US-WA': 'Washington', 'US-MA': 'Massachusetts',
  'DE-RP': 'Rheinland-Pfalz', 'DE-BY': 'Bavaria', 'DE-BE': 'Berlin',
  'DE-NW': 'North Rhine-Westphalia', 'DE-BW': 'Baden-Württemberg', 'DE-HE': 'Hesse',
  'GB-ENG': 'England', 'GB-SCT': 'Scotland', 'GB-WLS': 'Wales', 'GB-NIR': 'Northern Ireland',
  'ES-MD': 'Madrid', 'ES-CT': 'Catalonia', 'ES-AN': 'Andalusia', 'ES-VC': 'Valencia',
  'FR-IDF': 'Île-de-France', 'FR-ARA': 'Auvergne-Rhône-Alpes', 'IT-LAZ': 'Lazio',
  'IT-LOM': 'Lombardy', 'IT-SIC': 'Sicily', 'BR-SP': 'São Paulo', 'BR-RJ': 'Rio de Janeiro',
  'AR-C': 'Buenos Aires', 'MX-CMX': 'Mexico City', 'MX-JAL': 'Jalisco',
  'CO-DC': 'Bogotá', 'CO-ANT': 'Antioquia', 'PR': 'Puerto Rico',
  'DO-01': 'Santo Domingo', 'CU-01': 'Havana', 'VE-A': 'Caracas',
  'AU-NSW': 'New South Wales', 'AU-VIC': 'Victoria', 'CA-ON': 'Ontario',
  'CA-QC': 'Quebec', 'CA-BC': 'British Columbia', 'NL-NH': 'North Holland',
  'BE-VLG': 'Flanders', 'CH-ZH': 'Zürich', 'AT-W': 'Vienna', 'PL-MZ': 'Masovia',
  'PT-LIS': 'Lisbon', 'GR-A': 'Attica', 'TR-34': 'Istanbul', 'JP-13': 'Tokyo',
  'JP-27': 'Osaka', 'KR-11': 'Seoul', 'CN-SH': 'Shanghai', 'IN-MH': 'Maharashtra',
  'ID-JK': 'Jakarta', 'PH-00': 'Metro Manila', 'ZA-GT': 'Gauteng',
  'NG-LA': 'Lagos', 'KE-30': 'Nairobi', 'EG-C': 'Cairo', 'MA-CAS': 'Casablanca',
  'SN-DK': 'Dakar', 'GH-AA': 'Accra', 'IL-TA': 'Tel Aviv', 'AE-DU': 'Dubai',
  'RU-MOW': 'Moscow', 'UA-30': 'Kyiv', 'CZ-PR': 'Prague', 'HU-BU': 'Budapest',
  'RO-B': 'Bucharest', 'SE-AB': 'Stockholm', 'NO-03': 'Oslo', 'DK-84': 'Copenhagen',
  'FI-18': 'Helsinki', 'IE-D': 'Dublin', 'NZ-AUK': 'Auckland', 'CL-RM': 'Santiago',
  'PE-LIM': 'Lima', 'UY-MO': 'Montevideo'
};

/* Approximate country centres, for the globe in the tuner card. The directory
   only occasionally carries station coordinates, so the country centroid is the
   honest fallback — the pin says "a station in this country", not "this street". */
const COUNTRY_GEO = {
  AE: [23.4, 53.8], AL: [41.2, 20.2], AM: [40.1, 45.0], AO: [-11.2, 17.9],
  AR: [-38.4, -63.6], AT: [47.5, 14.6], AU: [-25.3, 133.8], AZ: [40.1, 47.6],
  BA: [43.9, 17.7], BD: [23.7, 90.4], BE: [50.5, 4.5], BG: [42.7, 25.5],
  BH: [26.1, 50.6], BO: [-16.3, -63.6], BR: [-14.2, -51.9], BY: [53.7, 27.9],
  CA: [56.1, -106.3], CH: [46.8, 8.2], CL: [-35.7, -71.5], CM: [7.4, 12.4],
  CN: [35.9, 104.2], CO: [4.6, -74.3], CR: [9.7, -83.8], CU: [21.5, -77.8],
  CW: [12.2, -69.0], CY: [35.1, 33.4], CZ: [49.8, 15.5], DE: [51.2, 10.4],
  DK: [56.3, 9.5], DO: [18.7, -70.2], DZ: [28.0, 1.7], EC: [-1.8, -78.2],
  EE: [58.6, 25.0], EG: [26.8, 30.8], ES: [40.5, -3.7], ET: [9.1, 40.5],
  FI: [61.9, 25.7], FJ: [-17.7, 178.1], FR: [46.2, 2.2], GB: [55.4, -3.4],
  GE: [42.3, 43.4], GH: [7.9, -1.0], GR: [39.1, 21.8], GT: [15.8, -90.2],
  HK: [22.3, 114.2], HN: [15.2, -86.2], HR: [45.1, 15.2], HT: [18.9, -72.3],
  HU: [47.2, 19.5], ID: [-0.8, 113.9], IE: [53.4, -8.2], IL: [31.0, 34.9],
  IN: [20.6, 79.0], IQ: [33.2, 43.7], IR: [32.4, 53.7], IS: [64.9, -19.0],
  IT: [41.9, 12.6], JM: [18.1, -77.3], JO: [31.3, 36.4], JP: [36.2, 138.3],
  KE: [-0.0, 37.9], KH: [12.6, 104.9], KR: [35.9, 127.8], KW: [29.3, 47.5],
  KZ: [48.0, 66.9], LB: [33.9, 35.9], LK: [7.9, 80.8], LT: [55.2, 23.9],
  LU: [49.8, 6.1], LV: [56.9, 24.6], LY: [26.3, 17.2], MA: [31.8, -7.1],
  MD: [47.4, 28.4], ME: [42.7, 19.4], MK: [41.6, 21.7], MM: [21.9, 96.0],
  MN: [46.9, 103.8], MT: [35.9, 14.4], MU: [-20.3, 57.6], MX: [23.6, -102.6],
  MY: [4.2, 101.9], MZ: [-18.7, 35.5], NA: [-22.9, 18.5], NG: [9.1, 8.7],
  NI: [12.9, -85.2], NL: [52.1, 5.3], NO: [60.5, 8.5], NP: [28.4, 84.1],
  NZ: [-40.9, 174.9], OM: [21.0, 57.0], PA: [8.5, -80.8], PE: [-9.2, -75.0],
  PH: [12.9, 121.8], PK: [30.4, 69.3], PL: [51.9, 19.1], PR: [18.2, -66.6],
  PS: [31.9, 35.2], PT: [39.4, -8.2], PY: [-23.4, -58.4], QA: [25.3, 51.2],
  RO: [45.9, 24.9], RS: [44.0, 21.0], RU: [61.5, 105.3], RW: [-2.0, 29.9],
  SA: [23.9, 45.1], SD: [12.9, 30.2], SE: [60.1, 18.6], SG: [1.35, 103.8],
  SI: [46.2, 15.0], SK: [48.7, 19.7], SN: [14.5, -14.5], SO: [5.2, 46.2],
  SR: [3.9, -56.0], SV: [13.8, -88.9], SY: [34.8, 38.9], TH: [15.9, 101.0],
  TN: [33.9, 9.5], TR: [38.9, 35.2], TT: [10.7, -61.2], TW: [23.7, 121.0],
  TZ: [-6.4, 34.9], UA: [48.4, 31.2], UG: [1.4, 32.3], US: [39.5, -98.4],
  UY: [-32.5, -55.8], UZ: [41.4, 64.6], VE: [6.4, -66.6], VN: [14.1, 108.3],
  YE: [15.6, 48.5], ZA: [-30.6, 22.9], ZM: [-13.1, 27.8], ZW: [-19.0, 29.2]
};

const BAD_URL = /\.(m3u8|m3u|pls|xspf)(\?|$)/i;
const GOOD_CODEC = /^(mp3|aac|aac\+|mpeg)$/i;
/* Names and tags that read as a directory entry, a talk station, or a test
   stream — none of them belong in a music rotation. */
const BAD_NAME = /\b(test|offline|backup|copy of|news|noticias|talk|podcast|sport|deportes|sermon|quran|coran)\b/i;
const HARD_BAD_TAG = /^(news|noticias|talk|speech|sport|deportes|politics|religion|religious|islam|quran|podcast|audiobook)$/i;

const clean = (value, max = 120) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

/* Directory names carry marketing tails: "— Online — www.x.com", "| ORF |
   Vienna", "MP3 128 kbps". Keep the station, drop the listing. */
function stationName(raw) {
  return clean(String(raw || '')
    .split('|')[0]
    .replace(/\s*[-–—]\s*online\b.*$/i, '')
    .replace(/\s*[-–—]\s*www\..*$/i, '')
    .replace(/\s*\([^)]*(www\.|online|stream)[^)]*\)/gi, '')
    .replace(/\s*\b\d{2,3}\s*kbps\b/gi, '')
    .replace(/\s*\b(mp3|aac\+?)\b\s*\d*$/i, '')
    .replace(/[_\s]{2,}/g, ' ')
    .replace(/^[\-–—_\s]+|[\-–—_\s]+$/g, ''), 70);
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor++;
      try { out[index] = await fn(list[index], index); } catch { out[index] = null; }
    }
  }));
  return out;
}

async function searchCountry(cc) {
  const params = new URLSearchParams({
    countrycode: cc,
    limit: '24',
    order: 'votes',
    reverse: 'true',
    hidebroken: 'true',
    bitrate_min: '96'
  });
  const res = await fetch(`${API}?${params}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${cc}`);
  const list = await res.json();
  return list.filter(usable).slice(0, PER_COUNTRY * 3);
}

function usable(s) {
  const url = String(s.url_resolved || '');
  if (!url.startsWith('https://')) return false;
  if (BAD_URL.test(url)) return false;
  if (!s.lastcheckok || Number(s.ssl_error) === 1) return false;
  if (!GOOD_CODEC.test(String(s.codec || '').trim())) return false;
  if (Number(s.hls) === 1) return false;
  if (Number(s.bitrate) && Number(s.bitrate) < 96) return false;
  if (!String(s.countrycode || '').match(/^[A-Z]{2}$/i)) return false;
  const name = stationName(s.name);
  if (!name || BAD_NAME.test(name)) return false;
  const tags = String(s.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.some((t) => HARD_BAD_TAG.test(t))) return false;
  return true;
}

/* A stream is usable if it answers quickly with audio. Only the first chunk is
   read, then the socket is cancelled — a live stream never ends on its own. */
async function probe(station) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(station.url_resolved, {
      method: 'GET',
      headers: { 'User-Agent': UA, Range: 'bytes=0-4095', Accept: 'audio/*,*/*' },
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!res.ok && res.status !== 206) return false;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (/text\/html|application\/json|text\/plain/.test(type)) return false;
    if (!/^(audio\/|application\/(ogg|octet-stream)|binary\/)/.test(type)) return false;

    const reader = res.body?.getReader();
    if (!reader) return false;
    const first = await Promise.race([
      reader.read(),
      new Promise((resolveRead) => setTimeout(() => resolveRead({ value: null }), 3500))
    ]);
    try { await reader.cancel(); } catch { /* already closed */ }
    if (!first?.value || first.value.byteLength < 256) return false;
    const head = new TextDecoder('latin1').decode(first.value.slice(0, 220)).trim().toLowerCase();
    if (head.startsWith('<') || head.startsWith('{')) return false;
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function placeFor(station) {
  const region = REGION_NAMES[String(station.iso_3166_2 || '').toUpperCase()]
    || clean(station.state, 60);
  return region || clean(station.country, 60);
}

function flagFor(cc) {
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

async function main() {
  console.log(`Querying ${COUNTRIES.length} countries…`);
  const batches = await mapLimit(COUNTRIES, 6, searchCountry);

  const seenUrls = new Set();
  const seenNames = new Set();
  const candidates = [];
  batches.filter(Boolean).flat().forEach((s) => {
    const url = String(s.url_resolved);
    const nameKey = `${stationName(s.name).toLowerCase()}|${s.countrycode}`;
    if (seenUrls.has(url) || seenNames.has(nameKey)) return;
    seenUrls.add(url);
    seenNames.add(nameKey);
    candidates.push(s);
  });
  console.log(`${candidates.length} candidates.`);

  console.log('Probing streams…');
  const alive = await mapLimit(candidates, 12, probe);
  const working = candidates.filter((_, i) => alive[i]);
  console.log(`${working.length} answered with audio.`);

  /* Rank per country by votes, keep the best PER_COUNTRY that answered. */
  working.sort((a, b) => Number(b.votes) - Number(a.votes));
  const perCountry = new Map();
  const chosen = [];
  for (const station of working) {
    const cc = String(station.countrycode).toUpperCase();
    const count = perCountry.get(cc) || 0;
    if (count >= PER_COUNTRY) continue;
    perCountry.set(cc, count + 1);
    chosen.push(station);
  }

  const stations = chosen
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((s, index) => {
      const cc = String(s.countrycode).toUpperCase();
      const lat = Number(s.geo_lat);
      const lon = Number(s.geo_long);
      const hasGeo = s.geo_lat != null && s.geo_long != null
        && Number.isFinite(lat) && Math.abs(lat) <= 90
        && Number.isFinite(lon) && Math.abs(lon) <= 180;
      return {
        id: `w${String(index + 1).padStart(2, '0')}`,
        name: stationName(s.name),
        country: clean(s.country, 60),
        countrycode: cc,
        flag: flagFor(cc),
        place: placeFor(s),
        tags: clean(s.tags, 90).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5),
        url: String(s.url_resolved),
        codec: String(s.codec || 'MP3').toUpperCase(),
        bitrate: Number(s.bitrate) || 0,
        homepage: /^https:\/\//.test(s.homepage || '') ? s.homepage : '',
        lat: hasGeo ? lat : (COUNTRY_GEO[cc]?.[0] ?? 0),
        lon: hasGeo ? lon : (COUNTRY_GEO[cc]?.[1] ?? 0),
        geo: hasGeo ? 'station' : 'country',
        votes: Number(s.votes) || 0
      };
    });

  const payload = {
    source: 'Radio Browser (radio-browser.info)',
    note: 'Public internet radio streams. Each station is owned by its broadcaster; the station name links back to its homepage.',
    generated: new Date().toISOString().slice(0, 10),
    count: stations.length,
    stations
  };

  await writeFile(resolve(ROOT, 'data/world-radio.json'), JSON.stringify(payload, null, 2) + '\n');
  await writeFile(resolve(ROOT, 'js/world-stations.js'), `/* AUTO-GENERATED by tools/build-world-radio.mjs — do not hand-edit.
 * Source: Radio Browser (https://www.radio-browser.info), a free open directory
 * of public internet radio streams. ${stations.length} stations from
 * ${new Set(stations.map((s) => s.countrycode)).size} countries, all checked for
 * HTTPS + audio at build time.
 *
 * Rebuild with:  node tools/build-world-radio.mjs
 * The station clock reads this synchronously, so every listener gets the same
 * city in the same slot. Keep this file in version control with the build.
 */
export const WORLD_FEED = ${JSON.stringify(payload, null, 2)};
`);

  console.log(`Wrote ${stations.length} stations · ${new Set(stations.map((s) => s.countrycode)).size} countries.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
