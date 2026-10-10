/* ============================================================
   City Grand Prix — daily leaderboard API
   Cloudflare Worker + D1, no dependencies, no build step.

   The game is a static page, so everything a player can see is on
   their machine — including the score they would like you to believe.
   A scoreboard with no server cannot tell a good lap from a
   `localStorage.setItem`, so this Worker holds the scores and does the
   only checks a stateless game can support:

     1. the day's rules are derived HERE, from the day number, with the
        same hash the game uses. The client's par / car / mod / seed are
        cross-checked against our own derivation, so a run cannot claim
        a par it did not drive;
     2. a run must be physically possible: three laps of a 1,794-unit
        circuit at 60 u/s cannot be done in under 76 seconds, and the
        best lap cannot beat the whole race;
     3. a per-IP-per-day cap on submissions (the IP is salted with the
        day and hashed, so the stored value is not a tracker).

   What it still cannot do: tell a plausible lie from a real lap. A
   hand-written POST with a believable time is accepted, exactly as any
   arcade high-score table accepts a good liar. Rate limits and
   plausibility bounds raise the cost; they do not remove it.
   ============================================================ */

const RACER_NAMES = ['VX-1', 'VX-2', 'FALCON', 'MIRAGE', 'NEEDLE'];
const MODS = ['standard', 'slick', 'clean'];
const RACE_LAPS = 3;
const FIELD_SIZE = 5;

/* the circuit, as the game builds it (tools/… and racegame.html agree on these) */
const TRACK_LEN = 1794.2;
const MAX_SPEED = 60;
/* three perfect laps at top speed, minus 15% for the fact that no lap is perfect */
const MIN_TOTAL = Math.round(RACE_LAPS * (TRACK_LEN / MAX_SPEED) * 0.85 * 10) / 10;   // 76.3
const MIN_LAP = 22;                 // no real lap beats this
const MAX_TOTAL = 3600;             // an hour is not a lap time, it is a typo
const MAX_BODY = 2048;
const MAX_PER_DAY = 60;             // submissions from one IP for one day
const DAY_WINDOW_MS = 86400000;

/* ============================================================
   the day's rules — must match racegame.html exactly
   ============================================================ */
function hash32(x) {
  x = Math.imul((x | 0) ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
function dateOfDay(n) {
  const t = new Date(n * 86400000);
  const mo = String(t.getUTCMonth() + 1), d = String(t.getUTCDate());
  return t.getUTCFullYear() + '-' + (mo.length < 2 ? '0' + mo : mo) + '-' + (d.length < 2 ? '0' + d : d);
}
function dayConfig(day) {
  const seed = hash32(0x9e3779b9 ^ Math.imul(day, 0x85ebca6b));
  return {
    day: day,
    date: dateOfDay(day),
    seed: seed,
    car: RACER_NAMES[seed % RACER_NAMES.length],
    par: 100 + ((seed >>> 5) % 17),
    mod: MODS[(seed >>> 13) % MODS.length],
    laps: RACE_LAPS,
    field: FIELD_SIZE
  };
}
function starsFor(time, par) {
  if (!time || time <= 0 || !par) return 0;
  if (time <= par) return 3;
  if (time <= par * 1.06) return 2;
  if (time <= par * 1.15) return 1;
  return 0;
}

/* ============================================================
   plumbing
   ============================================================ */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
};
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }, CORS)
  });
}
function cleanHandle(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[^\w .\-]/g, '')          // no markup, no control characters, no emoji storms
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  return s || 'pilot';
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : NaN; }
function intish(v) { const n = num(v); return Number.isInteger(n) ? n : NaN; }
/* day 0 (1970-01-01) is a legal day, so a *missing* day must not quietly mean it */
function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return NaN;
  return intish(Number(raw));
}

/* the IP is never stored: it is salted with the day and truncated, which is
   enough to count submissions from one place without keeping a tracker */
async function ipTag(req, day) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const data = new TextEncoder().encode(ip + '|' + day + '|vh-gp');
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).slice(0, 8)
    .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS scores (' +
      ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      ' day INTEGER NOT NULL,' +
      ' seed INTEGER NOT NULL,' +
      ' handle TEXT NOT NULL,' +
      ' car TEXT NOT NULL,' +
      ' mod TEXT NOT NULL,' +
      ' par INTEGER NOT NULL,' +
      ' time REAL NOT NULL,' +
      ' best REAL NOT NULL,' +
      ' pos INTEGER NOT NULL,' +
      ' of_count INTEGER NOT NULL,' +
      ' stars INTEGER NOT NULL,' +
      ' ip TEXT NOT NULL,' +
      ' created INTEGER NOT NULL)'
    ).run().then(function () {
      return env.DB.prepare('CREATE INDEX IF NOT EXISTS scores_day_time ON scores(day, time)').run();
    }).then(function () {
      return env.DB.prepare('CREATE INDEX IF NOT EXISTS scores_day_ip ON scores(day, ip, created)').run();
    }).catch(function (err) {
      schemaReady = null;               // let the next request try again
      throw err;
    });
  }
  return schemaReady;
}

function rowOut(r, rank) {
  return {
    rank: rank, handle: r.handle, car: r.car, mod: r.mod,
    time: r.time, best: r.best, pos: r.pos, of: r.of_count,
    stars: r.stars, at: r.created
  };
}
async function boardFor(env, day, limit) {
  const top = await env.DB.prepare(
    'SELECT handle, car, mod, time, best, pos, of_count, stars, created FROM scores' +
    ' WHERE day = ? ORDER BY time ASC, created ASC LIMIT ?'
  ).bind(day, limit).all();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE day = ?').bind(day).first();
  return {
    top: (top.results || []).map(function (r, i) { return rowOut(r, i + 1); }),
    total: count && typeof count.n === 'number' ? count.n : 0
  };
}
async function standingFor(env, day, handle) {
  if (!handle) return null;
  const mine = await env.DB.prepare(
    'SELECT handle, car, mod, time, best, pos, of_count, stars, created FROM scores' +
    ' WHERE day = ? AND handle = ? ORDER BY time ASC LIMIT 1'
  ).bind(day, handle).first();
  if (!mine) return null;
  const ahead = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM scores WHERE day = ? AND time < ?'
  ).bind(day, mine.time).first();
  return rowOut(mine, (ahead && ahead.n ? ahead.n : 0) + 1);
}

/* ============================================================
   routes
   ============================================================ */
async function handleBoard(req, env, url) {
  const day = intParam(url, 'day');
  if (!(day >= 0 && day <= 999999999)) return json({ ok: false, error: 'bad day' }, 400);
  const limit = Math.min(Math.max(intish(Number(url.searchParams.get('limit'))) || 10, 1), 25);
  const handle = url.searchParams.get('handle') ? cleanHandle(url.searchParams.get('handle')) : '';
  const cfg = dayConfig(day);
  const board = await boardFor(env, day, limit);
  return json({
    ok: true,
    day: day,
    config: { date: cfg.date, car: cfg.car, par: cfg.par, mod: cfg.mod, laps: cfg.laps, field: cfg.field },
    total: board.total,
    top: board.top,
    you: await standingFor(env, day, handle)
  });
}

async function handleSubmit(req, env) {
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: 'body too large' }, 413);
    body = JSON.parse(text);
  } catch (e) {
    return json({ ok: false, error: 'bad json' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad body' }, 400);

  const day = intish(body.day);
  if (!(day >= 0 && day <= 999999999)) return json({ ok: false, error: 'bad day' }, 400);
  const cfg = dayConfig(day);

  /* the day's rules come from here, not from the client */
  const mismatch = [];
  if (intish(body.seed) !== cfg.seed) mismatch.push('seed');
  if (intish(body.par) !== cfg.par) mismatch.push('par');
  if (String(body.car || '') !== cfg.car) mismatch.push('car');
  if (String(body.mod || '') !== cfg.mod) mismatch.push('mod');
  if (mismatch.length) {
    return json({
      ok: false, error: 'day config mismatch', fields: mismatch,
      expected: { day: day, seed: cfg.seed, car: cfg.car, mod: cfg.mod, par: cfg.par }
    }, 409);
  }

  const time = num(body.time);
  const best = num(body.best);
  const pos = intish(body.pos);
  const of = intish(body.of);
  if (!isFinite(time) || time < MIN_TOTAL || time > MAX_TOTAL) {
    return json({ ok: false, error: 'implausible time', min: MIN_TOTAL, max: MAX_TOTAL }, 422);
  }
  if (!isFinite(best) || best < MIN_LAP || best > time) {
    return json({ ok: false, error: 'implausible best lap', min: MIN_LAP, max: time }, 422);
  }
  if (!(pos >= 1 && pos <= FIELD_SIZE) || !(of >= 2 && of <= 8) || pos > of) {
    return json({ ok: false, error: 'bad finishing position' }, 422);
  }

  const handle = cleanHandle(body.handle);
  const ip = await ipTag(req, day);
  const now = Date.now();

  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM scores WHERE day = ? AND ip = ? AND created > ?'
  ).bind(day, ip, now - DAY_WINDOW_MS).first();
  if (recent && recent.n >= MAX_PER_DAY) {
    return json({ ok: false, error: 'too many runs today', cap: MAX_PER_DAY }, 429);
  }

  /* a retry (the client re-sends a run it could not deliver) must not land twice */
  const dupe = await env.DB.prepare(
    'SELECT id FROM scores WHERE day = ? AND ip = ? AND time = ? AND handle = ? AND created > ?'
  ).bind(day, ip, Math.round(time * 100) / 100, handle, now - 60000).first();

  const stars = starsFor(time, cfg.par);
  if (!dupe) {
    await env.DB.prepare(
      'INSERT INTO scores (day, seed, handle, car, mod, par, time, best, pos, of_count, stars, ip, created)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(day, cfg.seed, handle, cfg.car, cfg.mod, cfg.par,
      Math.round(time * 100) / 100, Math.round(best * 100) / 100,
      pos, of, stars, ip, now).run();
  }

  const board = await boardFor(env, day, 10);
  return json({
    ok: true,
    duplicate: !!dupe,
    stars: stars,
    par: cfg.par,
    total: board.total,
    top: board.top,
    you: await standingFor(env, day, handle)
  }, dupe ? 200 : 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!env || !env.DB) {
      return json({ ok: false, error: 'no database bound' }, 503);
    }
    try {
      if (path === '/api/board' && request.method === 'GET') {
        await ensureSchema(env);
        return await handleBoard(request, env, url);
      }
      if (path === '/api/runs' && request.method === 'POST') {
        await ensureSchema(env);
        return await handleSubmit(request, env);
      }
      if (path === '/api/health' && request.method === 'GET') {
        const cfg = dayConfig(intish(Number(url.searchParams.get('day'))) || 0);
        await ensureSchema(env);
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores').first();
        return json({ ok: true, rows: n && n.n, minTotal: MIN_TOTAL, minLap: MIN_LAP, config: cfg });
      }
      if (path === '/' || path === '/api') {
        return new Response(
          'City Grand Prix daily leaderboard API\n' +
          'GET  /api/board?day=<n>&limit=<1-25>&handle=<name>\n' +
          'POST /api/runs  {day,seed,car,mod,par,time,best,pos,of,handle}\n' +
          'GET  /api/health\n', {
          headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, CORS)
        });
      }
      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: 'server error', detail: String(err && err.message || err) }, 500);
    }
  }
};
