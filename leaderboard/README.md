# City Grand Prix — daily leaderboard

A tiny Cloudflare Worker + D1 API that lets the same daily seed be compared between
players. The game is a static page on GitHub Pages, so this is the only part of the
feature that has a server side; the game keeps its own local board and works
completely without this (`racegame.html`, `BOARD_API = ''`).

## Deployed

| environment | URL |
| --- | --- |
| preview | `https://site-5c345ac2201048e49773f3a2db67be22.freebuff.page` |

The game's `BOARD_API` constant in `racegame.html` points at that preview URL. The
preview board holds test rows, not a mock: day 20736 (2026-10-10) carries the
`verify-live` and `pilot` rows, day 20740 (2026-10-14) carries one signed-in run under a
Google name with its picture, and **day 21000** (2027-07-01) carries the trace work — a
shaped submission and one genuinely driven, signed-in run. That day is used for exactly
this: it is far enough out that a test row sits on a board nobody plays. The board is
keyed by day, so test rows only ever show on the day they were written.

### Paired with the sign-in Worker

`IDENTITY_SECRET` is set on the preview environment, with the same value on the
sign-in Worker (site `7b3f1c2e-…`), which is what makes a signed-in run keep its Google
name and picture here. The value is write-only — it cannot be read back through the API
or the dashboard — so pairing is done by setting the same value in both places, and a
pair that has drifted is re-paired by rotating both together. Nothing else is needed:
the secret is not a D1 binding, so the platform reported no deployment required for it,
and a mismatch is loud (401, then the run is re-sent under the typed name).

## API

| route | what it does |
| --- | --- |
| `GET /api/board?day=<n>&limit=<1..25>&handle=<name>` | the day's top runs, the total, and your standing |
| `POST /api/runs` | `{day, seed, car, mod, par, time, best, pos, of, handle, laps, trace, identity}` → `{ok, rank, total, top, you}` |
| `GET /api/health?day=<n>` | the day's rules as the server derives them, plus the plausibility bounds |
| `GET /` | the route list, as text |

All responses carry `access-control-allow-origin: *` and `cache-control: no-store`.

## What the server checks, and why

A scoreboard with no accounts cannot tell a good lap from a `localStorage.setItem`. What
it *can* do is refuse the cheap lies:

1. **The day's rules are derived on the server**, from the day number, with the same
   hash the game uses. A run whose `par`, `car`, `mod` or `seed` disagrees with that
   derivation is a `409` — so nobody can claim a par they did not drive. (This is also a
   live cross-check: the page and the Worker derive today's rules independently.)
2. **A run has to be possible.** Three laps of a 1,794-unit circuit at 60 u/s cannot be
   done in under 76.3 s, the best lap must be one of the laps, and the laps must add up to
   the total (`422` otherwise).
3. **A per-IP-per-day cap** of 60 submissions (`429`). The IP is salted with the day and
   truncated to 16 hex characters before storage, so the table holds no address.
4. **Re-submitting the same run within a minute is deduped** and returns the original
   standing — the client retries failed sends, and a retry must not double-count.
5. **A signed-in run keeps the name the sign-in Worker vouched for.** With an
   `identity` token — `vhi1.<payload>.<HMAC-SHA256>`, verified against
   `IDENTITY_SECRET` — the `handle` field in the body is ignored and the row is filed
   under the token's name, with its `picture`. A token this Worker cannot verify is a
   `401` and the run is untouched, so the page can re-send it under the typed name. No
   token at all is still accepted, exactly as before: typing a name is not an error.

   The payload is short-lived (the sign-in Worker mints it with an `exp`), the secret is
   not `AUTH_SECRET` — this Worker never gets the key that mints sessions — and the
   picture is accepted only as an http**s** URL with no credentials in it, because it
   ends up in an `<img>` on somebody else's screen. Without the secret set, every
   token-bearing run is a 401 naming the missing variable rather than a silent
   downgrade to the typed name.

6. **A run has to arrive with its shape, not just its total** (`TRACE_FROM_DAY`, below).
   The page samples where it had covered at every 50-unit mark of every lap, in
   centiseconds, and posts that with the lap times:

   ```json
   "laps": [36.71, 35.45, 35.43],
   "trace": { "step": 50, "len": 1794.2, "laps": [[9, 18, …], [9, 18, …], [9, 18, …]] }
   ```

   The Worker derives the race back out of the trajectory and makes it agree with the
   numbers filed in the same request: one array per lap, each exactly as long as this
   circuit allows at the declared step (35 at 50 units); every sample after the one before
   it, so a bucket with no duration — an infinite speed — dies on the next rule; no bucket
   faster than the hull can go (60 u/s top speed × 1.22 boost, checked against 150); a
   declared circuit length within three units of the game's own 1794.2; the part of the lap
   after the last sample, at the pace of the last sample, landing on the lap time filed for
   that lap; and the laps adding up to the total.

   This is what a total on its own could never do. The board used to take a believable
   number from anyone who could type it; now that number has to come with a trajectory
   that stays inside the physics and agrees with itself. It is a cost, not a proof: a
   trajectory can be shaped to fit, and a patient liar with the game's constants can shape
   one. What it does remove is the one-line forgery.

   The rows keep a digest of the trajectory (not the samples: a row is a score, not a
   telemetry archive), so two rows that arrived with the same shape are visible as such,
   and every row reports `traced`.

### Rolling the trace out

The page has to ship before the board insists, or the day it starts insisting is the day
every honest run is refused. So the requirement is dated: **`TRACE_FROM_DAY = 20741`**
(2026-10-15). A run for an earlier day that arrives without a trace is filed *untraced*
rather than refused, which is what let the deployed board change over while people were
playing day 20740. A run that arrives *with* a bad trace is refused whatever day it names.

What it still cannot do: tell a good liar from a good lap — server-side replay of the
inputs would be the thing that settles it, and that is a much bigger feature than this
one. Worth knowing before anyone tries the obvious next idea: **the page's geometry
fingerprint is not checkable here.** It hashes the built circuit — `trackLen` from
`THREE.CatmullRomCurve3`, every tower after the headroom clamp, the features and pickups
after the road tests — so verifying it server-side means porting three.js's curve maths and
the road pipeline into the Worker, where one float diverging from the browser would reject
honest runs. And it would prove little: `/api/health` serves the day's seed, and the
generator ships in the page, so the fingerprint of any day can be computed by anyone who
cares to.

## Schema

Created lazily on first request (`CREATE TABLE IF NOT EXISTS`), so a fresh D1 needs no
migration step:

```sql
scores(id, day, seed, handle, car, mod, par, time, best, pos, of_count, stars, picture, trace, ip, created)
index scores_day_time(day, time)
index scores_day_ip(day, ip, created)
```

`stars` is recomputed from the server's own par — a client's claim is ignored. `trace`
holds that digest, empty for a row filed before the trace existed or for a day under the
cutoff.

`picture` was added after the table was already live: SQLite has no
`ADD COLUMN IF NOT EXISTS`, so `ensureSchema` attempts the `ALTER TABLE` and treats the
one predictable "duplicate column" error as the success case. A row written before that
migration reads back with an empty picture, which is what the panel expects.

## Tests

```bash
node leaderboard/test.mjs                                    # 126 checks, real SQLite via node:sqlite
node leaderboard/verify-live.mjs <worker-url> [day] [--write] # 18 checks, 26 with --write (28 on a trace-required day)
```

`test.mjs` runs the real handler against `node:sqlite` through a D1-shaped shim, so the
SQL, the routing, the CORS headers and every boundary are exercised without deploying.
`verify-live.mjs` is read-only by default; `--write` posts one plausible run and reads it
back, which is the only way to prove the D1 write path and the schema bootstrap on the
edge.

Both stop at the same places: neither covers Workers-specific plumbing (cold starts,
isolate reuse, the edge cache) beyond what the deployment itself exercises.

## Deploying

The Worker is a single dependency-free ES module, so there is nothing to build:

```bash
# from the workspace root, with the Sites tools:
#   sites_deploy(siteId, environment, requestId, manifestPath='leaderboard/sites.manifest.json')
# D1 is bound as DB by sites_add_storage(siteId, environment, requestId, kind='d1', name='DB')
```

`manifest.json` uploads `worker.js` as `index.js` and nothing else — there are no static
assets, so omitting `assetsDirectory` leaves any that exist alone.

Publishing production is a separate, deliberate step (`sites_deploy` with
`environment: 'production'`, and `sites_add_storage` for that environment first): the
preview and production databases are isolated, so production starts empty.
