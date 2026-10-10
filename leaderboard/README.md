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
preview board currently holds a handful of rows written by `verify-live.mjs` (handles
`verify-live` and `pilot`) — they are real rows in the preview database, not a mock.

## API

| route | what it does |
| --- | --- |
| `GET /api/board?day=<n>&limit=<1..25>&handle=<name>` | the day's top runs, the total, and your standing |
| `POST /api/runs` | `{day, seed, car, mod, par, time, best, pos, of, handle}` → `{ok, rank, total, top, you}` |
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
   done in under 76.3 s, and the best lap cannot beat the whole race (`422` otherwise).
3. **A per-IP-per-day cap** of 60 submissions (`429`). The IP is salted with the day and
   truncated to 16 hex characters before storage, so the table holds no address.
4. **Re-submitting the same run within a minute is deduped** and returns the original
   standing — the client retries failed sends, and a retry must not double-count.

What it still cannot do: tell a plausible lie from a real lap. A hand-written POST with a
believable time is accepted, exactly as any arcade table accepts a good liar. These checks
raise the cost; they do not remove it. Accounts or server-side replay would be the next
step, and both are bigger than this feature.

## Schema

Created lazily on first request (`CREATE TABLE IF NOT EXISTS`), so a fresh D1 needs no
migration step:

```sql
scores(id, day, seed, handle, car, mod, par, time, best, pos, of_count, stars, ip, created)
index scores_day_time(day, time)
index scores_day_ip(day, ip, created)
```

`stars` is recomputed from the server's own par — a client's claim is ignored.

## Tests

```bash
node leaderboard/test.mjs                                    # 84 checks, real SQLite via node:sqlite
node leaderboard/verify-live.mjs <worker-url> [day] [--write] # 26 checks against a deployment
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
