/* Station rules: the programme clock and small shared constants.
 * Edit this file to change the 24/7 schedule. Hours are UTC, 0–24. */
export const PROGRAMS = [
  {
    id: 'midnight',
    start: 0,
    end: 6,
    name: 'Midnight Drift',
    tagline: 'Slow frequencies for the small hours.',
    genres: ['Meditative', 'Ambient', 'Lo-Fi', 'Jazz', 'Blues']
  },
  {
    id: 'firstlight',
    start: 6,
    end: 10,
    name: 'First Light',
    tagline: 'Soft songs to open the day with.',
    genres: ['Ambient', 'Piano', 'Soul', 'Folk', 'Country']
  },
  {
    id: 'deepfocus',
    start: 10,
    end: 14,
    name: 'Deep Focus',
    tagline: 'Textures and instrumentals for the long middle.',
    genres: ['Lo-Fi', 'Ambient', 'Cinematic', 'Electronic']
  },
  {
    id: 'afterglow',
    start: 14,
    end: 18,
    name: 'Afterglow',
    tagline: 'Warm soul, Spanish verses, and a little daylight left.',
    genres: ['Soul', 'Latin', 'Piano', 'Funk', 'Reggae', 'Pop']
  },
  {
    id: 'nightfrequency',
    start: 18,
    end: 22,
    name: 'Night Frequency',
    tagline: 'Cinematic edges and neon-lit motion.',
    genres: ['Cinematic', 'Electronic', 'Soul', 'Hip-Hop', 'Rock']
  },
  {
    id: 'stillwaters',
    start: 22,
    end: 24,
    name: 'Still Waters',
    tagline: 'Winding down, lights low, nothing to prove.',
    genres: ['Ambient', 'Meditative', 'Piano', 'Jazz', 'Folk']
  }
];

/* Broadcast identity — the live reel is deterministic, so everyone who tunes
 * in at the same moment hears the same second of the same song. */
export const STATION_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
export const DAY_MS = 86400000;

/* Rotation rule for the live reel.
 *
 * The guest library is the backbone: it plays in a shuffled cycle, and one of
 * your own songs is dropped in after every `originalEvery` guest tracks.
 * `8` = about 11% originals (rare, a treat rather than a habit). Lower it for
 * more of your music (`4` = 20%, `2` = 33%); raise it to make them rarer still.
 *
 * `noRepeatWindow` stops any track from coming back within that many picks
 * where the pool allows it (the free library is small, so its own cycle is the
 * hard limit). */
export const ROTATION = {
  originalEvery: 8,
  noRepeatWindow: 10,

  /* Station ID every N songs (0 = never). The ID is the short "you're listening
     to Vita Hueso Radio" clip in audio/id/. */
  identEvery: 5,

  /* Fun first: Latin urban, dembow, reggaeton and friends come up `funWeight`
     times as often as the rest of the guest shelf, so the station leans
     danceable without losing the quieter corners. */
  funGenres: ['Reggaeton', 'Dembow', 'Latin', 'Dancehall', 'Moombahton', 'Urbano'],
  funWeight: 6
};

export const SLEEP_CHOICES = [15, 30, 45, 60, 90, 120];

/* Community layer.
 *
 * 'auto' uses a free public ntfy.sh topic so listeners on different devices
 * can chat and be counted. Set mode to 'local' to keep every message on the
 * visitor's own device (tabs still talk to each other). Changing `topic`
 * makes a fresh, unlisted room. See README for the privacy note. */
export const COMMUNITY = {
  mode: 'auto',
  relayBase: 'https://ntfy.sh',
  topic: 'vh-radio-7d2c91a4',
  maxLength: 280,
  presenceTtlMs: 75000
};
