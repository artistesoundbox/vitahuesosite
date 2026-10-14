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
        circuit at 60 u/s cannot be done in under 76 seconds, the best
        lap must be one of the laps, and the laps must add up to the
        total;
     3. a run must arrive with its SHAPE, not just its total. The page
        samples where it crossed every 50 units of every lap, and those
        samples are checked here: forward, no bucket faster than the
        hull can go, and consistent with the lap times and the total
        that came with them. A total is still forgeable — a patient liar
        can shape one like a race — but it cannot be picked out of the
        air any more;
     4. a per-IP-per-day cap on submissions (the IP is salted with the
        day and hashed, so the stored value is not a tracker).

   What it still cannot do: tell a good liar from a good lap. The trace
   raises the cost of the lie (it has to be a trajectory that stays
   inside the physics) without removing it. Server-side replay of the
   inputs is the thing that would actually settle it. Note also that the
   geometry fingerprint the page can produce is NOT checkable here
   without porting three.js's curve maths, and the seed it is derived
   from is served by /api/health anyway — so it would cost a great deal
   and prove very little.
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

/* the trace */
/* Required from this day on, so the page can ship first: a run for an earlier
   day is filed untraced rather than refused, which is what stops a rollout
   from eating the runs of everyone who happens to be playing at that moment. */
const TRACE_FROM_DAY = 20741;       // 2026-10-15
const TRACE_MIN_STEP = 10, TRACE_MAX_STEP = 200;
/* The hull tops out at MAX_SPEED (60) times BOOST_TOP (1.22). A bucket that
   outruns this by a wide margin is not a fast lap, it is a teleport. */
const MAX_BUCKET_SPEED = 150;
/* How far the declared circuit length may sit from the one the game builds */
const TRACE_LEN_SLACK = 3;

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

/* ============================================================
   the signed-in player
   ============================================================ */

function b64urlBytes(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  try {
    const raw = atob(s + pad);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

/* The auth Worker mints "vhi1.<base64url payload>.<base64url HMAC-SHA256>" with
   IDENTITY_SECRET, and this is the other half of it: same secret, same message,
   an HMAC check. That is why a run can carry a name this board believes without
   this Worker holding a session, an account or a user table of its own — and why
   the name is taken from the token rather than from the request body.

   A token that does not verify is not the same as no token. The run is refused
   with 401 so the page can drop the session and send it again as a typed name;
   ignoring a forged token would make a refusal indistinguishable from never
   having signed in, which is how a silent security hole looks. */
async function verifyIdentity(env, token) {
  if (!env.IDENTITY_SECRET) return { error: 'no identity secret configured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'vhi1' || !parts[1] || !parts[2]) {
    return { error: 'malformed identity token' };
  }
  const signature = b64urlBytes(parts[2]);
  if (!signature) return { error: 'malformed identity token' };
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.IDENTITY_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const good = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(parts[1]));
  if (!good) return { error: 'identity token rejected' };
  let payload = null;
  try {
    const bytes = b64urlBytes(parts[1]);
    payload = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  } catch (e) {
    return { error: 'malformed identity token' };
  }
  const now = Math.floor(Date.now() / 1000);
  /* a minute of slack for a clock that is a little behind this one */
  if (!(payload && payload.exp > now - 60)) return { error: 'identity token expired' };
  return { name: payload.name, sub: payload.sub, picture: payload.picture };
}

/* ============================================================
   the trace — the shape of a run

   The page samples the distance it had covered at every 50-unit mark of every
   lap, in centiseconds. Those samples are the only part of a submission that
   constrains the run's own arithmetic: a total is a number, and a plausible
   number is what a leaderboard with no accounts has always had to accept.

   So the checks here derive the race back out of the trajectory and make it
   agree with the numbers filed in the same request:

     - exactly one array per lap, each one exactly as long as this circuit
       allows at the declared step;
     - every sample after the one before it (a bucket with no duration is an
       infinite speed, and the speed check below is where that dies);
     - no bucket faster than the hull can go;
     - the length declared is this circuit's, within a metre of slack;
     - the part of the lap after the last sample, at the pace of the last
       sample, lands on the lap time filed for that lap;
     - the laps add up to the total, and the best lap is one of them.

   What this cannot do is make a lie impossible: a trajectory can be shaped to
   fit. It does mean the lie is a trajectory rather than a number.
   ============================================================ */
function checkTrace(cfg, body, time, best) {
  const trace = body.trace;
  if (!trace || typeof trace !== 'object') return 'a run needs its trace: {step, len, laps}';
  const step = intish(trace.step);
  const len = num(trace.len);
  if (!(step >= TRACE_MIN_STEP && step <= TRACE_MAX_STEP)) {
    return 'bad trace step (10..200)';
  }
  if (!isFinite(len) || Math.abs(len - TRACK_LEN) > TRACE_LEN_SLACK) {
    return 'the trace is not this circuit\'s length';
  }
  const laps = body.laps;
  if (!Array.isArray(laps) || laps.length !== cfg.laps) {
    return 'laps must carry one time per lap (expected ' + cfg.laps + ')';
  }
  const lapTimes = [];
  for (let i = 0; i < laps.length; i++) {
    const t = num(laps[i]);
    if (!isFinite(t) || t < MIN_LAP || t > MAX_TOTAL) return 'implausible lap time';
    lapTimes.push(t);
  }
  /* the numbers have to agree with each other before they agree with anything */
  const sum = lapTimes.reduce(function (a, b) { return a + b; }, 0);
  /* the laps are rounded to a hundredth each and the total to a hundredth, so
     an honest run's sum sits within a frame or two of the tenth of a second —
     not half a second, which would let a mismatched total through */
  if (Math.abs(sum - time) > Math.max(0.2, time * 0.002)) {
    return 'the laps do not add up to the total';
  }
  if (Math.abs(Math.min.apply(null, lapTimes) - best) > Math.max(0.06, best * 0.01)) {
    return 'the best lap is not one of the laps';
  }
  const perLap = Math.floor(len / step);
  if (!Array.isArray(trace.laps) || trace.laps.length !== cfg.laps) {
    return 'the trace needs one array per lap';
  }
  for (let i = 0; i < trace.laps.length; i++) {
    const ts = trace.laps[i];
    if (!Array.isArray(ts) || ts.length !== perLap) {
      return 'lap ' + (i + 1) + ' is not ' + perLap + ' samples';
    }
    let prev = 0;
    for (let j = 0; j < ts.length; j++) {
      const cs = ts[j];
      if (!isFinite(cs) || cs <= prev) return 'the trace does not move forward (lap ' + (i + 1) + ')';
      const speed = step / ((cs - prev) / 100);
      if (speed > MAX_BUCKET_SPEED) return 'faster than the hull goes (lap ' + (i + 1) + ')';
      prev = cs;
    }
    /* the tail: the last, partial bucket, at the pace of the bucket before it */
    const vLast = step / ((ts[ts.length - 1] - ts[ts.length - 2]) / 100);
    const derived = (prev + ((len - perLap * step) / vLast) * 100) / 100;
    if (Math.abs(derived - lapTimes[i]) > Math.max(1.0, lapTimes[i] * 0.04)) {
      return 'lap ' + (i + 1) + ' does not match its trace';
    }
  }
  return null;
}

/* The trace itself is not stored — a row is a score, not a telemetry archive —
   but its digest is, so two rows that came with the same trajectory are
   visible as such. Same FNV-ish shape the page's own fingerprint uses. */
function traceDigest(trace) {
  const s = trace.step + 'x' + trace.laps.map(function (ts) { return ts.join(','); }).join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return trace.step + 'x' + (h >>> 0).toString(16);
}

/* https only, no credentials — the same rule profile avatars use, because this
   URL ends up in an <img> on somebody else's screen. */
function cleanPicture(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 500) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    return u.toString();
  } catch (e) {
    return '';
  }
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
      ' picture TEXT NOT NULL DEFAULT \'\',' +
      ' trace TEXT NOT NULL DEFAULT \'\',' +
      ' ip TEXT NOT NULL,' +
      ' created INTEGER NOT NULL)'
    ).run().then(function () {
      return env.DB.prepare('CREATE INDEX IF NOT EXISTS scores_day_time ON scores(day, time)').run();
    }).then(function () {
      return env.DB.prepare('CREATE INDEX IF NOT EXISTS scores_day_ip ON scores(day, ip, created)').run();
    }).then(function () {
      /* Columns added after the table was already live in front of players.
         SQLite has no ADD COLUMN IF NOT EXISTS, so each attempt is made and its
         one predictable error — the column already being there — is the
         success case. Anything else is real.

         The whole attempt is wrapped, not just the `.run()`: a D1-style
         prepare() can throw before there is a promise to attach a catch to,
         and a rejection handler that never sees the error is a 500 with the
         real cause buried in it. */
      const added = [
        "ALTER TABLE scores ADD COLUMN picture TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE scores ADD COLUMN trace TEXT NOT NULL DEFAULT ''"
      ];
      return (async function () {
        for (let i = 0; i < added.length; i++) {
          try {
            await env.DB.prepare(added[i]).run();
          } catch (err) {
            if (!/duplicate column/i.test(String(err && err.message || err))) throw err;
          }
        }
      })();
    }).catch(function (err) {
      schemaReady = null;               // let the next request try again
      throw err;
    });
  }
  return schemaReady;
}

function rowOut(r, rank) {
  return {
    rank: rank, handle: r.handle, picture: r.picture || '', car: r.car, mod: r.mod,
    time: r.time, best: r.best, pos: r.pos, of: r.of_count,
    stars: r.stars,
    /* whether this run came with a trajectory: a row from before the trace
       existed, or from a day filed under the old rules, has none */
    traced: !!r.trace,
    at: r.created
  };
}
async function boardFor(env, day, limit) {
  const top = await env.DB.prepare(
    'SELECT handle, picture, car, mod, time, best, pos, of_count, stars, trace, created FROM scores' +
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
    'SELECT handle, picture, car, mod, time, best, pos, of_count, stars, trace, created FROM scores' +
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

  /* The shape of the run, checked before anything expensive. From TRACE_FROM_DAY
     a run without one is not filed at all; an earlier day is filed untraced
     instead, so the page can be deployed before the board insists. */
  if (body.trace !== undefined || day >= TRACE_FROM_DAY) {
    const bad = checkTrace(cfg, body, time, best);
    if (bad) return json({ ok: false, error: bad }, 422);
  }
  const traceTag = body.trace && typeof body.trace === 'object' ? traceDigest(body.trace) : '';

  /* A run may carry the signed-in player's identity. Verified, it decides the
     name and the picture; the typed handle cannot override it, because that is
     the whole difference between a name somebody typed and a name Google
     vouched for. */
  let handle = cleanHandle(body.handle);
  let picture = '';
  if (body.identity) {
    const who = await verifyIdentity(env, body.identity);
    if (who.error) return json({ ok: false, error: who.error }, 401);
    handle = cleanHandle(who.name);
    picture = cleanPicture(who.picture);
  }
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
      'INSERT INTO scores (day, seed, handle, picture, car, mod, par, time, best, pos, of_count, stars, trace, ip, created)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(day, cfg.seed, handle, picture, cfg.car, cfg.mod, cfg.par,
      Math.round(time * 100) / 100, Math.round(best * 100) / 100,
      pos, of, stars, traceTag, ip, now).run();
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
          'POST /api/runs  {day,seed,car,mod,par,time,best,pos,of,handle,laps,trace,identity?}\n' +
          '  laps: [seconds per lap] and trace: {step,len,laps:[[centiseconds…]]}\n' +
          '  — the shape of the run, required from day ' + TRACE_FROM_DAY + '\n' +
          '  identity: the signed-in player\'s token from the auth Worker; when it\n' +
          '  verifies, its name and picture are used and `handle` is ignored\n' +
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
