/* Station rules: the programme clock and small shared constants.
 * Edit this file to change the 24/7 schedule. Hours are UTC, 0–24. */
export const PROGRAMS = [
  {
    id: 'midnight',
    start: 0,
    end: 6,
    name: 'Midnight Drift',
    tagline: 'Slow frequencies for the small hours.',
    genres: ['Meditative', 'Ambient', 'Lo-Fi']
  },
  {
    id: 'firstlight',
    start: 6,
    end: 10,
    name: 'First Light',
    tagline: 'Soft songs to open the day with.',
    genres: ['Ambient', 'Piano', 'Soul']
  },
  {
    id: 'deepfocus',
    start: 10,
    end: 14,
    name: 'Deep Focus',
    tagline: 'Textures and instrumentals for the long middle.',
    genres: ['Lo-Fi', 'Ambient', 'Cinematic']
  },
  {
    id: 'afterglow',
    start: 14,
    end: 18,
    name: 'Afterglow',
    tagline: 'Warm soul, Spanish verses, and a little daylight left.',
    genres: ['Soul', 'Latin', 'Piano']
  },
  {
    id: 'nightfrequency',
    start: 18,
    end: 22,
    name: 'Night Frequency',
    tagline: 'Cinematic edges and neon-lit motion.',
    genres: ['Cinematic', 'Electronic', 'Soul']
  },
  {
    id: 'stillwaters',
    start: 22,
    end: 24,
    name: 'Still Waters',
    tagline: 'Winding down, lights low, nothing to prove.',
    genres: ['Ambient', 'Meditative', 'Piano']
  }
];

/* Broadcast identity — the live reel is deterministic, so everyone who tunes
 * in at the same moment hears the same second of the same song. */
export const STATION_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
export const DAY_MS = 86400000;

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
