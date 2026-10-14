/* ============================================================
   Local test for the leaderboard Worker.
   node leaderboard/test.mjs

   Runs the real Worker handler against a real SQLite engine
   (node:sqlite, in-memory) behind a small D1-shaped shim, so the SQL,
   the routing, the CORS headers and the validation are all exercised
   without deploying anything. The real D1 is SQLite, so this is the
   same dialect — what it does not cover is Workers-specific plumbing
   (bindings, cold starts, the edge cache), which only `wrangler dev`
   or a deployment can.
   ============================================================ */
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';

/* ---- a D1-shaped shim over node:sqlite ---- */
function d1Adapter() {
  const db = new DatabaseSync(':memory:');
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      /* D1's three methods are async, so this shim is async too — a worker
         written against a synchronous shim would not be the worker that ships */
      const make = (params) => ({
        bind: (...args) => make(args),
        all: () => Promise.resolve({ results: stmt.all(...params), success: true, meta: {} }),
        first: () => Promise.resolve(stmt.get(...params) === undefined ? null : stmt.get(...params)),
        run: () => {
          const r = stmt.run(...params);
          return Promise.resolve({ success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } });
        }
      });
      return make([]);
    }
  };
}

const env = { DB: d1Adapter() };
const BASE = 'https://board.test';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function get(path, headers) {
  return worker.fetch(new Request(BASE + path, { headers: headers || {} }), env);
}
function send(path, method, body, headers) {
  return worker.fetch(new Request(BASE + path, {
    method: method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  }), env);
}
function post(body, headers) { return send('/api/runs', 'POST', body, headers); }
const DAY = 20736;                       // today in the game's calendar (2026-10-10)
const CFG = { seed: 1105266865, car: 'VX-1', mod: 'slick', par: 109 };
function run(over) {
  return Object.assign({
    day: DAY, seed: CFG.seed, car: CFG.car, mod: CFG.mod, par: CFG.par,
    time: 105.4, best: 34.1, pos: 2, of: 5, handle: 'testpilot'
  }, over || {});
}
const IP = { 'cf-connecting-ip': '203.0.113.7' };

/* ============================================================ */
console.log('\n[1] the day\'s rules are derived server-side');
{
  const r = await get('/api/health?day=' + DAY);
  const h = await r.json();
  check('health 200', r.status === 200, 'status ' + r.status);
  eq('day 20736 → seed', h.config.seed, CFG.seed);
  eq('day 20736 → car', h.config.car, CFG.car);
  eq('day 20736 → par', h.config.par, CFG.par);
  eq('day 20736 → mod', h.config.mod, CFG.mod);
  eq('day 20736 → date', h.config.date, '2026-10-10');
  eq('minimum plausible total', h.minTotal, 76.3);
  const other = await (await get('/api/health?day=20741')).json();
  eq('day 20741 → clean mod', other.config.mod, 'clean');
  eq('day 20741 → FALCON', other.config.car, 'FALCON');
}

console.log('\n[2] an empty day reads as empty, not as an error');
{
  const r = await get('/api/board?day=' + DAY);
  const b = await r.json();
  check('board 200', r.status === 200);
  eq('total 0', b.total, 0);
  eq('top empty', b.top, []);
  eq('you null', b.you, null);
  eq('config echoed', [b.config.car, b.config.par, b.config.mod], ['VX-1', 109, 'slick']);
}

console.log('\n[3] a valid run is recorded and ranked');
{
  const r = await post(run(), IP);
  const b = await r.json();
  check('201 created', r.status === 201, 'status ' + r.status + ' ' + JSON.stringify(b));
  eq('ok', b.ok, true);
  eq('server recomputed stars from its own par', b.stars, 3);
  eq('total 1', b.total, 1);
  eq('you rank 1', b.you.rank, 1);
  eq('you time', b.you.time, 105.4);
  eq('handle stored', b.you.handle, 'testpilot');
  eq('top[0] fields', [b.top[0].rank, b.top[0].handle, b.top[0].car, b.top[0].stars], [1, 'testpilot', 'VX-1', 3]);
}

console.log('\n[4] a retried submission does not land twice');
{
  const r = await post(run(), IP);
  const b = await r.json();
  eq('marked duplicate', b.duplicate, true);
  eq('total still 1', b.total, 1);
}

console.log('\n[5] the board is ordered by time and respects limit');
{
  await post(run({ time: 120.2, handle: 'slower', best: 39.9 }), IP);
  await post(run({ time: 98.7, handle: 'quickest', best: 32.2 }), IP);
  const b = await (await get('/api/board?day=' + DAY)).json();
  eq('total 3', b.total, 3);
  eq('sorted by time', b.top.map(x => x.time), [98.7, 105.4, 120.2]);
  eq('ranks 1..3', b.top.map(x => x.rank), [1, 2, 3]);
  eq('stars fall off with par', b.top.map(x => x.stars), [3, 3, 1]);   // 109 par: 3 ≤109, 2 ≤115.5, 1 ≤125.4
  const one = await (await get('/api/board?day=' + DAY + '&limit=1')).json();
  eq('limit=1 → one row', one.top.length, 1);
  eq('total ignores limit', one.total, 3);
  const mine = await (await get('/api/board?day=' + DAY + '&handle=testpilot')).json();
  eq('standing by handle', mine.you.rank, 2);
  const nobody = await (await get('/api/board?day=' + DAY + '&handle=nosuchpilot')).json();
  eq('unknown handle → null', nobody.you, null);
  const otherDay = await (await get('/api/board?day=20741')).json();
  eq('a different day is a different board', otherDay.total, 0);
}

console.log('\n[6] the day\'s rules cannot be claimed by the client');
{
  const cases = [
    ['par', run({ par: 110 })],
    ['seed', run({ seed: 1234 })],
    ['car', run({ car: 'MIRAGE' })],
    ['mod', run({ mod: 'clean' })]
  ];
  for (const [field, payload] of cases) {
    const r = await post(payload, IP);
    const b = await r.json();
    eq('rewriting ' + field + ' → 409', r.status, 409);
    eq('rewriting ' + field + ' → names the field', b.fields, [field]);
  }
  const r = await post(run({ stars: 3, time: 150.5 }), IP);
  const b = await r.json();
  eq('a claimed 3-star 150.5s run', [r.status, b.stars], [201, 0]);
}

console.log('\n[7] implausible runs are refused');
{
  eq('12-second race → 422', (await post(run({ time: 12.3, best: 12.1 }), IP)).status, 422);
  eq('76.2s (under the physical floor) → 422', (await post(run({ time: 76.2 }), IP)).status, 422);
  eq('76.4s (over the floor) → 201', (await post(run({ time: 76.4, best: 25.1, handle: 'edge' }), IP)).status, 201);
  eq('a 5-second best lap → 422', (await post(run({ time: 100, best: 5 }), IP)).status, 422);
  eq('best lap longer than the race → 422', (await post(run({ time: 100, best: 120 }), IP)).status, 422);
  eq('an hour → 422', (await post(run({ time: 4000 }), IP)).status, 422);
  eq('NaN time → 422', (await post(run({ time: 'fast' }), IP)).status, 422);
  const bare = await post({ day: DAY }, IP);
  eq('a body with only a day → 409', bare.status, 409);
  eq('and it names every field it wants', (await bare.json()).fields, ['seed', 'par', 'car', 'mod']);
}

console.log('\n[8] boundaries on position');
{
  eq('pos 9 → 422', (await post(run({ pos: 9 }), IP)).status, 422);
  eq('pos 0 → 422', (await post(run({ pos: 0 }), IP)).status, 422);
  eq('pos 3 of 2 → 422', (await post(run({ pos: 3, of: 2 }), IP)).status, 422);
  eq('of 1 → 422', (await post(run({ pos: 1, of: 1 }), IP)).status, 422);
  eq('pos 5 of 5 → 201', (await post(run({ pos: 5, of: 5, time: 111.1, handle: 'last' }), IP)).status, 201);
}

console.log('\n[9] requests that are not requests');
{
  eq('bad json → 400', (await post('{not json', IP)).status, 400);
  eq('oversized body → 413', (await post('{"pad":"' + 'x'.repeat(3000) + '"}', IP)).status, 413);
  eq('bad day → 400', (await post(run({ day: -1 }), IP)).status, 400);
  eq('non-numeric day → 400', (await get('/api/board?day=abc')).status, 400);
  eq('missing day → 400', (await get('/api/board')).status, 400);
  eq('unknown path → 404', (await get('/api/nope')).status, 404);
  eq('GET /api/runs → 404', (await get('/api/runs')).status, 404);
  eq('POST /api/board → 404', (await send('/api/board', 'POST', { day: DAY }, IP)).status, 404);
  eq('DELETE /api/runs → 404', (await send('/api/runs', 'DELETE', undefined, IP)).status, 404);
  const help = await get('/');
  check('root explains the API', (await help.text()).includes('/api/board'));
}

console.log('\n[10] CORS is answered, including preflight');
{
  const pre = await worker.fetch(new Request(BASE + '/api/runs', { method: 'OPTIONS' }), env);
  eq('preflight 204', pre.status, 204);
  eq('allow-origin', pre.headers.get('access-control-allow-origin'), '*');
  eq('allow-methods', pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  eq('allow-headers', pre.headers.get('access-control-allow-headers'), 'content-type');
  const b = await get('/api/board?day=' + DAY);
  eq('GET carries allow-origin', b.headers.get('access-control-allow-origin'), '*');
  eq('GET is not cacheable', b.headers.get('cache-control'), 'no-store');
  const p = await post(run({ time: 106.6, handle: 'cors' }), IP);
  eq('POST carries allow-origin', p.headers.get('access-control-allow-origin'), '*');
}

console.log('\n[11] handles are cleaned, and a run survives a hostile one');
{
  const r = await post(run({ handle: '<img src=x onerror=alert(1)>', time: 107.7 }), IP);
  const b = await r.json();
  const h = b.you.handle;
  check('no markup survives', !/[<>"'&]/.test(h), 'stored ' + JSON.stringify(h));
  check('length capped at 14', h.length <= 14, 'length ' + h.length);
  const r2 = await post(run({ handle: '', time: 108.8 }), IP);
  eq('an empty handle becomes pilot', (await r2.json()).you.handle, 'pilot');
  const r3 = await post(run({ handle: 'a'.repeat(40), time: 109.9 }), IP);
  eq('a 40-char handle is capped', (await r3.json()).you.handle.length, 14);
}

console.log('\n[12] the submission cap holds');
{
  const spam = { 'cf-connecting-ip': '198.51.100.9' };
  let last = null;
  for (let i = 0; i < 61; i++) {
    last = await post(run({ time: 130 + i * 0.7, handle: 'spam' + i }), spam);
  }
  const b = await last.json();
  eq('the 61st run of the day → 429', last.status, 429);
  eq('and says why', b.error, 'too many runs today');
  const ok = await post(run({ time: 131.1, handle: 'other' }), IP);
  eq('a different IP is unaffected', ok.status, 201);
}

console.log('\n[13] no database bound is reported, not crashed');
{
  const bare = await worker.fetch(new Request(BASE + '/api/board?day=' + DAY), {});
  eq('503 without a binding', bare.status, 503);
}

console.log('\n[14] stored IPs are salted per day and not reversible-looking');
{
  const cols = (await env.DB.prepare('SELECT DISTINCT ip FROM scores').all()).results.map(r => r.ip);
  check('every stored ip is a 16-hex tag', cols.every(x => /^[0-9a-f]{16}$/.test(x)), JSON.stringify(cols.slice(0, 4)));
  check('the raw address never reaches the table', cols.every(x => x.indexOf('203.0.113') === -1 && x !== 'unknown'));
  const same = await post(run({ time: 112.2, handle: 'again' }), IP);
  check('the same visitor is still accepted', same.status === 201, 'status ' + same.status);
}

console.log('\n[15] a signed-in player: the token decides the name, and carries the picture');
{
  /* The same construction the auth Worker mints with: "vhi1.<base64url
     payload>.<base64url HMAC-SHA256>", signed over the base64url body with
     IDENTITY_SECRET. There is no second implementation to drift from — the
     verifier here is the leaderboard's half of that scheme, and this is the
     only way to test it without a real Google account. */
  const SECRET = 'local-test-identity-secret';
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const mint = (payload, secret) => {
    const body = b64url(JSON.stringify(Object.assign({ iat: now, exp: now + 300 }, payload)));
    const sig = b64url(crypto.createHmac('sha256', secret || SECRET).update(body).digest());
    return 'vhi1.' + body + '.' + sig;
  };
  const PICTURE = 'https://lh3.googleusercontent.com/a/ada=s96-c';
  const token = mint({ sub: '110000000000000000001', name: 'Ada Lovelace', picture: PICTURE });

  env.IDENTITY_SECRET = SECRET;
  const signed = await post(run({ time: 113.3, handle: 'ignored-typed-name', identity: token }), IP);
  const body = await signed.json();
  eq('a verified run is accepted', signed.status, 201);
  eq('and is filed under the name from the token', body.you.handle, 'Ada Lovelace');
  eq('not the handle that came with the request', body.you.handle === 'ignored-typed-name', false);
  eq('and the picture comes with it', body.you.picture, PICTURE);

  const board = await (await get('/api/board?day=' + DAY + '&limit=25')).json();
  const mine = board.top.filter((r) => r.handle === 'Ada Lovelace')[0];
  check('the row is on the board with its picture', !!mine && mine.picture === PICTURE, JSON.stringify(mine));
  check('every row has a picture field, empty when nobody signed in',
    board.top.every((r) => typeof r.picture === 'string'), JSON.stringify(board.top.map((r) => typeof r.picture)));

  /* a name Google gave can be longer than a typed one; both ends cap it the same */
  const long = await post(run({ time: 114.4, identity: mint({ name: 'Bartholomew Featherstonehaugh III', picture: PICTURE }) }), IP);
  eq('a long verified name is capped like a typed one', (await long.json()).you.handle.length, 14);

  /* things that must not become a name on the board */
  const forged = token.slice(0, -4) + 'AAAA';
  eq('a forged signature → 401', (await post(run({ time: 115.5, identity: forged }), IP)).status, 401);
  eq('and says so', (await (await post(run({ time: 115.5, identity: forged }), IP)).json()).error, 'identity token rejected');
  eq('a token signed with another secret → 401',
    (await post(run({ time: 116.6, identity: mint({ name: 'Mallory' }, 'not-the-secret') }), IP)).status, 401);
  eq('an expired token → 401',
    (await post(run({ time: 117.7, identity: mint({ name: 'Ada', exp: now - 3600 }) }), IP)).status, 401);
  eq('a mangled token → 401', (await post(run({ time: 118.8, identity: 'vhi1.zzzz' }), IP)).status, 401);
  eq('a re-signed payload with the name swapped is still forged',
    (await post(run({ time: 119.9, identity: 'vhi1.' + b64url(JSON.stringify({ sub: 'x', name: 'Mallory', exp: now + 300 })) + '.' + token.split('.')[2] }), IP)).status, 401);
  const after = await (await get('/api/board?day=' + DAY + '&limit=25')).json();
  check('none of the refusals reached the board',
    after.top.every((r) => r.handle !== 'Mallory'), JSON.stringify(after.top.map((r) => r.handle)));

  /* A picture is a URL that ends up in an <img> on somebody else's screen.
     Separate names, because `you` is the player's *best* run and reusing one
     name would read the row above rather than the one just sent. */
  const badUrl = await post(run({ time: 120.1, identity: mint({ name: 'Pic Http', picture: 'http://insecure.example/a.png' }) }), IP);
  eq('an http picture is dropped, not stored', (await badUrl.json()).you.picture, '');
  const creds = await post(run({ time: 121.2, identity: mint({ name: 'Pic Creds', picture: 'https://user:pass@example.com/a.png' }) }), IP);
  eq('credentials in a picture URL are dropped too', (await creds.json()).you.picture, '');
  const noPic = await post(run({ time: 121.7, identity: mint({ name: 'Pic None', picture: 'not a url at all' }) }), IP);
  eq('and something that is not a URL is dropped', (await noPic.json()).you.picture, '');

  /* a deployment that cannot check tokens must not believe one */
  const noSecret = Object.assign({}, env, { IDENTITY_SECRET: undefined });
  const unverifiable = await worker.fetch(new Request(BASE + '/api/runs', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, IP),
    body: JSON.stringify(run({ time: 122.3, identity: token }))
  }), noSecret);
  eq('no identity secret → 401, not a trusted name', unverifiable.status, 401);
  eq('and it names the missing variable', (await unverifiable.json()).error, 'no identity secret configured');

  const typed = await post(run({ time: 123.4, handle: 'typed-fine' }), IP);
  eq('a run with no token at all is unchanged', typed.status, 201);
  eq('and keeps its typed handle', (await typed.json()).you.handle, 'typed-fine');
}

console.log('\n[15] a run has to arrive with its shape, not just its total');
{
  /* The first day the trace is required. Its rules come off the API, the way a
     player's page gets them, rather than from anything hard-coded here. */
  const D2 = 20741;
  const cfg2 = (await (await get('/api/health?day=' + D2)).json()).config;
  const IP2 = { 'cf-connecting-ip': '198.51.100.31' };
  const LAP = 40.8, TOTAL = 122.4;                 // three equal laps, best = min = one lap
  function body2(over) {
    return Object.assign({
      day: D2, seed: cfg2.seed, car: cfg2.car, mod: cfg2.mod, par: cfg2.par,
      time: TOTAL, best: LAP, pos: 2, of: 5, handle: 'traced'
    }, over || {});
  }
  /* An honest trace: even pace. n+1 equal pieces means the sample at each
     boundary and the tail after the last one together are the lap. */
  const STEP = 50, LEN = 1794.2, N = Math.floor(LEN / STEP);
  function traceFor(laps, over) {
    return Object.assign({
      step: STEP, len: LEN,
      laps: laps.map(function (lap) {
        const ts = [];
        for (let i = 1; i <= N; i++) ts.push(Math.round(lap * (i / (N + 1)) * 100));
        return ts;
      })
    }, over || {});
  }
  const honest = body2({ laps: [LAP, LAP, LAP], trace: traceFor([LAP, LAP, LAP]) });

  const bare = await post(body2({}), IP2);
  eq('a run with no trace is refused on that day', bare.status, 422);
  check('and the refusal says what is missing', /trace/.test((await bare.json()).error));

  const ok = await post(honest, IP2);
  const okBody = await ok.json();
  eq('an honest trace is accepted', ok.status, 201);
  eq('and the row is marked as traced', okBody.you.traced, true);

  const tag = (await env.DB.prepare('SELECT trace FROM scores WHERE day = ? AND handle = ?')
    .bind(D2, 'traced').first()).trace;
  check('the stored tag is a step and a digest', /^50x[0-9a-f]{8}$/.test(tag), JSON.stringify(tag));

  const again = await post(honest, { 'cf-connecting-ip': '198.51.100.32' });
  const tag2 = (await env.DB.prepare('SELECT trace FROM scores WHERE day = ? AND ip != ?')
    .bind(D2, (await env.DB.prepare('SELECT ip FROM scores WHERE day = ? LIMIT 1').bind(D2).first()).ip)
    .first()).trace;
  eq('the same trajectory twice is the same tag', tag2, tag);
  check('and it was stored, not refused', again.status === 201, 'status ' + again.status);

  const teleport = body2({ laps: [LAP, LAP, LAP], trace: (function () {
    const t = traceFor([LAP, LAP, LAP]);
    t.laps[1][10] = t.laps[1][9] + 1;              // one bucket at 5000 u/s
    return t;
  })() });
  const t1 = await post(teleport, IP2);
  eq('a bucket faster than the hull is refused', t1.status, 422);
  check('and says so', /faster than the hull/.test((await t1.json()).error));

  const backwards = body2({ laps: [LAP, LAP, LAP], trace: (function () {
    const t = traceFor([LAP, LAP, LAP]);
    t.laps[0][5] = t.laps[0][4];                   // a bucket with no duration
    return t;
  })() });
  eq('a trace that does not move forward is refused', (await post(backwards, IP2)).status, 422);

  const short = body2({ laps: [LAP, LAP, LAP], trace: (function () {
    const t = traceFor([LAP, LAP, LAP]);
    t.laps[2].pop();                               // one sample short
    return t;
  })() });
  const s1 = await post(short, IP2);
  eq('a trace of the wrong length is refused', s1.status, 422);
  check('and names the count', /is not 35 samples/.test((await s1.json()).error));

  const elsewhere = body2({ laps: [LAP, LAP, LAP], trace: traceFor([LAP, LAP, LAP], { len: 2200 }) });
  eq('a trace for another circuit is refused', (await post(elsewhere, IP2)).status, 422);

  const badSum = body2({ time: TOTAL, best: LAP, laps: [41, 41, 41], trace: traceFor([41, 41, 41]) });
  const b1 = await post(badSum, IP2);
  eq('laps that do not add up to the total are refused', b1.status, 422);
  check('and says so', /do not add up/.test((await b1.json()).error));

  const badBest = body2({ laps: [30, 45.5, 46.9], best: 45.5, time: 122.4,
    trace: traceFor([30, 45.5, 46.9]) });
  const b2 = await post(badBest, IP2);
  eq('a best lap that is not one of the laps is refused', b2.status, 422);
  check('and says so', /not one of the laps/.test((await b2.json()).error));

  const noLaps = body2({ trace: traceFor([LAP, LAP, LAP]) });
  eq('a trace without its lap times is refused', (await post(noLaps, IP2)).status, 422);

  /* the day before the cutoff: a page that has not been redeployed yet still
     gets its runs filed, and they are visible as untraced */
  const legacy = await post(run({ handle: 'untraced-legacy', time: 109.3 }), IP2);
  eq('an earlier day may still arrive without a trace', legacy.status, 201);
  eq('and is filed untraced', (await legacy.json()).you.traced, false);

  const legacyBad = await post(run({ day: DAY, seed: CFG.seed, car: CFG.car, mod: CFG.mod,
    par: CFG.par, time: 109.3, best: 34.1, handle: 'bad-trace-on-old-day',
    laps: [36.4, 36.4, 36.5], trace: (function () {
      const t = traceFor([36.4, 36.4, 36.5]);
      t.laps[0][3] = t.laps[0][2] + 1;
      return t;
    })() }), IP2);
  eq('a bad trace is refused even on the old day', legacyBad.status, 422);
}

console.log('\n' + '='.repeat(58));
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
