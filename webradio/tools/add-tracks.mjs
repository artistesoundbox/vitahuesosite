/**
 * One-off: prune the guest shelf and add the new CC BY Latin / funk / hip-hop
 * batch. Run from webradio/:  node tools/add-tracks.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../data/library.json', import.meta.url);
const data = JSON.parse(readFileSync(FILE, 'utf8'));

const DROP = new Set([
  'LA TRIPLETA.mp3',
  'Lamadio Tiado (Hot Cha Cha Mix).mp3',
  'Chill Wave.mp3',
  'Water Lily.mp3'
]);

const BY = (id) => `http://creativecommons.org/licenses/by/${id}/`;
const page = (user, id) => `https://ccmixter.org/files/${user}/${id}`;

const ADD = [
  {
    file: 'Andres Franco - Ahi Vienen.mp3', title: 'Ahi Vienen', artist: 'Andres Franco',
    genres: ['Moombahton', 'Latin'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('andrewfranco', 45003)
  },
  {
    file: 'Andres Franco - Jhonblack Wayo Wayo.mp3', title: 'Jhonblack Wayo Wayo', artist: 'Andres Franco',
    genres: ['Dembow', 'Latin'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('andrewfranco', 21090)
  },
  {
    file: 'Andres Franco - Brake Dance.mp3', title: 'Brake Dance', artist: 'Andres Franco',
    genres: ['Dancehall', 'Latin'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('andrewfranco', 33929)
  },
  {
    file: 'Anth Crunk - Put U Hands Up.mp3', title: 'Put U Hands Up', artist: 'Anth Crunk',
    genres: ['Reggaeton', 'Hip-Hop'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('Crunkster', 38231)
  },
  {
    file: 'hidalgoantonio - Bailemos Together.mp3', title: 'Bailemos Together', artist: 'hidalgoantonio',
    genres: ['Latin', 'Pop'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('hidalgoantonio', 43714)
  },
  {
    file: 'BOCrew - Beckfords and the Bocrew.mp3', title: 'Beckfords and the Bocrew', artist: 'Bocrew',
    genres: ['Dancehall', 'Hip-Hop'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('BOCrew', 22904)
  },
  {
    file: 'dotjot - Leaving Babylon (Catch the Train Mix).mp3', title: 'Leaving Babylon (Catch the Train Mix)', artist: 'dotjot',
    genres: ['Reggaeton', 'Dancehall'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('dotjot', 61742)
  },
  {
    file: "DanScrew - Don't Worry.mp3", title: "Don't Worry", artist: 'DanScrew',
    genres: ['Dancehall', 'Pop'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('DanScrew', 40426)
  },
  {
    file: 'BOCrew - Come.mp3', title: 'Come', artist: 'Bocrew',
    genres: ['Disco', 'Dancehall'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('BOCrew', 66165)
  },
  {
    file: 'ScOmBer - Dirtbag (Club Mix).mp3', title: 'Dirtbag (Club Mix)', artist: 'ScOmBer',
    genres: ['Disco', 'Electronic'], license: 'CC BY 2.5', licenseUrl: BY('2.5'),
    source: page('scomber', 17734)
  },
  {
    file: 'Donnie Ozone - Like a Rapper.mp3', title: 'Like a Rapper', artist: 'Donnie Ozone',
    genres: ['Hip-Hop'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('donnieozone', 36041)
  },
  {
    file: 'reiswerk - Bounce.mp3', title: 'Bounce', artist: 'reiswerk',
    genres: ['Hip-Hop'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('Reiswerk', 53117)
  },
  {
    file: 'Zep Hurme - Tell Somebody.mp3', title: 'Tell Somebody', artist: 'Zep Hurme',
    genres: ['Soul', 'Pop'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('zep_hurme', 39918)
  },
  {
    file: 'Stefan Kartenberg - Too Late.mp3', title: 'Too Late', artist: 'Stefan Kartenberg',
    genres: ['R&B', 'Soul'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('JeffSpeed68', 51988)
  },
  {
    file: 'Whitewolf - Toronto Is My Beat.mp3', title: 'Toronto Is My Beat', artist: 'Whitewolf',
    genres: ['Electronic', 'Hip-Hop'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('Whitewolf225', 60181)
  },
  {
    file: 'Robbero - Soul Sister.mp3', title: 'Soul Sister', artist: 'Robbero',
    genres: ['Disco', 'Funk'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('Robbero', 41686)
  },
  {
    file: 'SackJo22 - Slippin and Slidin.mp3', title: "Slippin' & Slidin'", artist: 'SackJo22',
    genres: ['R&B', 'Blues'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('SackJo22', 30330)
  },
  {
    file: 'Gshepherd - Salsa.mp3', title: 'Salsa', artist: 'Gshepherd',
    genres: ['Salsa', 'Latin'], license: 'CC BY 3.0', licenseUrl: BY('3.0'),
    source: page('Gshepherd', 49375)
  }
];

const kept = data.freeTracks.filter((t) => !DROP.has(t.file));
const dropped = data.freeTracks.length - kept.length;
data.freeTracks = kept.concat(ADD.map((t) => ({ ...t, album: 'cc-sessions' })));

writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);
console.log(`dropped ${dropped}, kept ${kept.length}, added ${ADD.length}, total ${data.freeTracks.length}`);
