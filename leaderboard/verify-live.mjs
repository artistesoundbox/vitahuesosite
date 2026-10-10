/* ============================================================
   Check a DEPLOYED leaderboard, over HTTP, from the outside.
   node leaderboard/verify-live.mjs https://<worker-url> [day] [--write]

   Default is read-only plus the two rejection paths (both of which are
   refused before they touch the table). --write also posts one plausible run
   and reads the board back, which is the only way to prove the D1 write path
   and the schema bootstrap work on the real edge.
   ============================================================ */
const base = (process.argv[2] || '').replace(/\/+$/, '');
const day = Number(process.argv[3] || 20736);
const write = process.argv.includes('--write');
if (!base) { console.log('usage: node leaderboard/verify-live.mjs <worker-url> [day] [--write]'); process.exit(2); }

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
async function call(path, opts) {
  const res = await fetch(base + path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { status: res.status, body: body, headers: res.headers };
}
async function post(payload) {
  return call('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

/* the day's rules as the deployed server derives them */
const health = await call('/api/health?day=' + day);
console.log('\n[' + base + ']  day ' + day);
check('health 200', health.status === 200, 'status ' + health.status);
const cfg = health.body && health.body.config;
check('server derived a day config', !!cfg, JSON.stringify(health.body).slice(0, 120));
if (cfg) {
  eq('date', cfg.date, new Date(day * 86400000).toISOString().slice(0, 10));
  check('par in the 1:40–1:56 band', cfg.par >= 100 && cfg.par <= 116, 'par ' + cfg.par);
  check('one of the three modifiers', ['standard', 'slick', 'clean'].indexOf(cfg.mod) >= 0, cfg.mod);
  check('a hull from the field', cfg.car && cfg.car.length > 0, cfg.car);
}
const minTotal = health.body && health.body.minTotal;

const empty = await call('/api/board?day=' + day + '&limit=5');
console.log('\n-- board read (CORS + JSON + limit)');
eq('board 200', empty.status, 200);
eq('allow-origin', empty.headers.get('access-control-allow-origin'), '*');
eq('no-store', empty.headers.get('cache-control'), 'no-store');
check('limit honoured', !empty.body.top || empty.body.top.length <= 5);
check('sorted ascending when populated',
  !empty.body.top || empty.body.top.every((r, i, a) => i === 0 || a[i - 1].time <= r.time));
eq('unknown day reads empty', (await call('/api/board?day=999999')).body.total, 0);

console.log('\n-- refusals (nothing reaches the table)');
const spoof = await post(Object.assign({ day: day, handle: 'verify' }, cfg ? { car: cfg.car, mod: cfg.mod, par: cfg.par + 1, seed: 1 } : {}));
eq('a rewritten par → 409', spoof.status, 409);
/* a valid config with an impossible time: the refusal has to be about the
   time, so everything else in the payload is correct */
const cheat = await post({ day: day, seed: cfg ? cfg.seed : 0, car: cfg && cfg.car, mod: cfg && cfg.mod, par: cfg && cfg.par,
  time: 12.5, best: 4, pos: 1, of: 5, handle: 'verify' });
eq('a 12-second race → 422', cheat.status, 422);
eq('bad json → 400', (await call('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'nope' })).status, 400);
eq('missing day → 400', (await call('/api/board')).status, 400);

console.log('\n-- preflight');
const pre = await fetch(base + '/api/runs', { method: 'OPTIONS' });
eq('OPTIONS 204', pre.status, 204);
eq('allow-methods', pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');

if (!write) {
  console.log('\n(read-only run: pass --write to post one run and read the board back)');
} else if (cfg) {
  console.log('\n-- write path (one plausible run)');
  const before = (await call('/api/board?day=' + day)).body.total;
  /* a time no earlier invocation used, or the server's (correct) dedupe would
     swallow it and "the total grew" would be testing the wrong thing */
  const t = Math.round((cfg.par + 6.5 + Math.random() * 12) * 100) / 100;
  const run = { day: day, seed: health.body.config.seed, car: cfg.car, mod: cfg.mod, par: cfg.par,
    time: t, best: Math.round((t / 3) * 100) / 100, pos: 2, of: 5, handle: 'verify-live' };
  const posted = await post(run);
  check('201 created (first time) or 200 (retry)', posted.status === 201 || posted.status === 200, 'status ' + posted.status + ' ' + JSON.stringify(posted.body).slice(0, 160));
  eq('server recomputed stars, not the client', posted.body.stars, run.time <= cfg.par ? 3 : (run.time <= cfg.par * 1.06 ? 2 : 1));
  check('total grew by one', posted.body.total === before + 1, before + ' → ' + posted.body.total);
  check('rank is a number', typeof posted.body.you.rank === 'number', JSON.stringify(posted.body.you));
  const again = await post(run);
  eq('the same run twice is deduped', again.body.total, posted.body.total);
  const board = (await call('/api/board?day=' + day + '&handle=verify-live')).body;
  check('the run is on the board', board.top.some(r => r.handle === 'verify-live'), JSON.stringify(board.top));
  check('and the standing finds it', !!board.you, JSON.stringify(board.you));
  check('the minimum plausible total is enforced', minTotal > 60 && minTotal < 90, 'minTotal ' + minTotal);
}

console.log('\n' + '='.repeat(58));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
