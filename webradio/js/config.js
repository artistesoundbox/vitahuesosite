/* Station rules: the programme clock and small shared constants.
 * Edit this file to change the 24/7 schedule. Hours are UTC, 0–24 and every
 * hour must be covered exactly once (contiguous, no gaps, no overlaps).
 *
 * `focus: true` makes a show play ONLY the guests that match its genres — that
 * is what turns an hour into appointment listening instead of a slightly
 * weighted slice of the same day. */
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
    genres: ['Ambient', 'Piano', 'Soul', 'Jazz']
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
    end: 17,
    name: 'Afterglow',
    tagline: 'Salsa, dembow and Spanish verses while there is still daylight.',
    genres: ['Latin', 'Salsa', 'Reggaeton', 'Dembow', 'Dancehall', 'Hip-Hop', 'Funk', 'Soul', 'Pop']
  },
  {
    /* 17:00 UTC = 1pm in San Juan: the lunchtime salsa hour, every day. */
    id: 'lahora',
    start: 17,
    end: 18,
    name: 'La Hora Caliente',
    tagline: 'One hour of salsa, timba, dembow y reggaetón — every single day.',
    genres: ['Salsa', 'Timba', 'Dembow', 'Reggaeton', 'Latin', 'Dancehall', 'Moombahton'],
    focus: true
  },
  {
    id: 'nightfrequency',
    start: 18,
    end: 22,
    name: 'Night Frequency',
    tagline: 'Reggaeton, timba and neon-lit motion until lights out.',
    genres: ['Reggaeton', 'Dembow', 'Dancehall', 'Moombahton', 'Timba', 'Hip-Hop', 'Latin', 'Disco', 'Electronic']
  },
  {
    id: 'stillwaters',
    start: 22,
    end: 24,
    name: 'Still Waters',
    tagline: 'Winding down, lights low, nothing to prove.',
    genres: ['Ambient', 'Meditative', 'Piano', 'Jazz', 'Blues']
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
  /* A track cannot come back until this many other songs have played. */
  noRepeatWindow: 12,

  /* Station ID every N songs (0 = never). The ID is the short "you're listening
     to Vita Hueso Radio" clip in audio/id/. */
  identEvery: 5,

  /* Fun first: the guest shelf is mostly Latin urban, salsa, dembow, the
     afro/dance side of the Open Shelf (afrobeat, amapiano, afro house, tropical
     house) plus English hip-hop / funk / disco, and `funGenres` marks what
     counts as fun. `funWeight` repeats them in the draw bag — kept at 1 so
     songs stay far apart; raise it only if you add more tracks (duplicates are
     what makes a track come back too soon). */
  funGenres: ['Reggaeton', 'Dembow', 'Latin', 'Dancehall', 'Moombahton', 'Urbano',
    'Salsa', 'Timba', 'Hip-Hop', 'Disco', 'R&B', 'Funk',
    'Afrobeat', 'Afro House', 'Amapiano', 'Tropical House'],
  funWeight: 1,

  /* Share of the guest picks that should be fun genres. A non-fun candidate is
     skipped this often while an out-of-cooldown fun track is still available,
     so the station leans danceable WITHOUT duplicating songs (duplicates are
     what makes tracks come back too soon). */
  funShare: 0.85
};

export const SLEEP_CHOICES = [15, 30, 45, 60, 90, 120];

/* Listener count.
 *
 * 'auto' uses a free public ntfy.sh topic so devices can count each other.
 * Set mode to 'local' to count only this device. Changing `topic` makes a
 * fresh, unlisted channel.
 *
 * The heartbeat is deliberately slow. ntfy's free tier allows roughly 250
 * messages per visitor per day, so a one-a-minute ping (1,440 by midnight) is
 * what exhausted the quota and froze the count. Ten minutes keeps a listener
 * at 144/day, and the TTL keeps a number on screen between pings. That makes
 * the count accurate to about ten minutes — for second-level accuracy the
 * station needs a presence service instead (see README). */
export const COMMUNITY = {
  mode: 'auto',
  relayBase: 'https://ntfy.sh',
  topic: 'vh-radio-7d2c91a4',
  presenceEveryMs: 600000,
  presenceTtlMs: 1800000
};
