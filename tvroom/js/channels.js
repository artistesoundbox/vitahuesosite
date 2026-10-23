/**
 * The channel catalogue.
 *
 * The playlist is iptv-org's public index — one M3U with every channel it
 * knows about (11k entries, ~2.5 MB). We parse it in the browser, keep the
 * fields the UI needs and work out which streams a browser can actually
 * open: a plain-HTTP stream is blocked on an HTTPS page, and a DASH manifest
 * or a raw transport stream needs VLC. Those stay in the list, flagged, so
 * they can be handed to VLC instead of silently disappearing.
 */

export const PLAYLIST_URL = 'https://iptv-org.github.io/iptv/index.m3u';

const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const BROWSER_CANNOT_PLAY = new Set(['mpd', 'ts', 'flv', 'ogg', 'ogv', 'php', 'htm', 'html']);

function extensionOf(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const m = /\.([a-z0-9]{1,5})$/.exec(path);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function regionName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * Turn M3U text into channel records.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parsePlaylist(text) {
  const channels = [];
  let meta = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      const head = comma === -1 ? line : line.slice(0, comma);
      const attrs = {};
      for (const m of head.matchAll(ATTR_RE)) attrs[m[1].toLowerCase()] = m[2];
      meta = {
        attrs,
        fullName: comma === -1 ? '' : line.slice(comma + 1).trim(),
        userAgent: attrs['http-user-agent'] || '',
      };
      continue;
    }

    if (line.startsWith('#EXTVLCOPT')) {
      const m = /http-user-agent=(.*)$/i.exec(line);
      if (m && meta) meta.userAgent = m[1].trim();
      continue;
    }

    if (line.startsWith('#')) continue;
    if (!meta) continue;

    const url = line;
    const tvgId = meta.attrs['tvg-id'] || '';
    const rawGroup = (meta.attrs['group-title'] || '').split(';')[0].trim();
    const quality = (/(\d{3,4})p/i.exec(meta.fullName) || [])[1] || '';
    const name = meta.fullName.replace(/\s*\(\d{3,4}p\)\s*$/i, '').trim() || url;
    const countryMatch = /\.([a-z]{2})(?:@|$)/i.exec(tvgId);
    const country = countryMatch ? countryMatch[1].toUpperCase() : '';
    const ext = extensionOf(url);
    const secure = /^https:\/\//i.test(url);

    channels.push({
      index: channels.length,
      name,
      fullName: meta.fullName || name,
      group: rawGroup && rawGroup.toLowerCase() !== 'undefined' ? rawGroup : 'Other',
      country,
      countryName: country ? regionName(country) : '',
      quality,
      logo: meta.attrs['tvg-logo'] || '',
      tvgId,
      url,
      ext,
      userAgent: meta.userAgent,
      // What the browser can attempt. Plain HTTP is mixed content on this
      // HTTPS site, and DASH/TS/FLV need a real player.
      playable: secure && !BROWSER_CANNOT_PLAY.has(ext),
    });

    meta = null;
  }

  return channels;
}

/**
 * A small memory of streams that failed here.
 *
 * Liveness cannot be known ahead of time — a feed that is dead in one country
 * plays fine in another, and CORS differs per host — so the room learns: a
 * channel that fails in this browser is remembered, hidden from the list by
 * default and skipped when zapping. "Reset" in the list footer forgets them.
 */
export class ChannelHealth {
  constructor(key = 'vh-tvroom-dead-v1', limit = 400) {
    this.key = key;
    this.limit = limit;
    this.entries = new Map();
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const [url, when] of parsed) this.entries.set(url, when);
        }
      }
    } catch {
      /* storage can be unavailable in private modes */
    }
  }

  isDead(url) {
    return this.entries.has(url);
  }

  get size() {
    return this.entries.size;
  }

  markDead(url) {
    if (!url) return false;
    const existed = this.entries.has(url);
    this.entries.delete(url);
    this.entries.set(url, Date.now());
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this._save();
    return !existed;
  }

  clear() {
    this.entries.clear();
    this._save();
  }

  _save() {
    try {
      localStorage.setItem(this.key, JSON.stringify([...this.entries.entries()]));
    } catch {
      /* quota or private mode: the list simply will not persist */
    }
  }
}

function fold(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export class Catalog {
  constructor(channels) {
    this.channels = channels;
    this.byUrl = new Map();
    const groups = new Map();
    const countries = new Map();

    for (const ch of channels) {
      if (!this.byUrl.has(ch.url)) this.byUrl.set(ch.url, ch);
      groups.set(ch.group, (groups.get(ch.group) || 0) + 1);
      if (ch.country) countries.set(ch.country, (countries.get(ch.country) || 0) + 1);
      ch.search = fold(`${ch.name} ${ch.group} ${ch.countryName} ${ch.country}`);
    }

    this.groups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    this.countries = [...countries.entries()].sort((a, b) => {
      const an = regionName(a[0]);
      const bn = regionName(b[0]);
      return an.localeCompare(bn);
    });
    this.playableCount = channels.filter((c) => c.playable).length;
  }

  /**
   * @returns {Array<object>} channels matching every active filter
   * @param {{query?:string, group?:string, country?:string, playableOnly?:boolean, hideDead?:boolean, isDead?:(url:string)=>boolean}} options
   */
  filter({ query = '', group = '', country = '', playableOnly = false, hideDead = false, isDead } = {}) {
    const needle = fold(query.trim());
    const checkDead = hideDead && typeof isDead === 'function' ? isDead : null;
    return this.channels.filter((ch) => {
      if (playableOnly && !ch.playable) return false;
      if (group && ch.group !== group) return false;
      if (country && ch.country !== country) return false;
      if (checkDead && checkDead(ch.url)) return false;
      if (needle && !ch.search.includes(needle)) return false;
      return true;
    });
  }

  find(url) {
    return this.byUrl.get(url) || null;
  }

  random(list) {
    if (!list || !list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  }
}

/**
 * Fetch and parse the playlist, reporting download progress.
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<Catalog>}
 */
export async function loadCatalog(onProgress) {
  const res = await fetch(PLAYLIST_URL, { cache: 'default' });
  if (!res.ok) throw new Error(`Playlist request failed (${res.status})`);

  let text;
  const total = Number(res.headers.get('content-length') || 0);
  if (res.body && total && onProgress) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(Math.min(1, received / total));
    }
    text = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const merged = new Uint8Array(acc.length + chunk.length);
        merged.set(acc, 0);
        merged.set(chunk, acc.length);
        return merged;
      }, new Uint8Array(0))
    );
  } else {
    text = await res.text();
  }

  if (!text.includes('#EXTINF')) throw new Error('Playlist came back empty');
  const channels = parsePlaylist(text);
  if (!channels.length) throw new Error('No channels in the playlist');
  return new Catalog(channels);
}
