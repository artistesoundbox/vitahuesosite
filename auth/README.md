# Sign in with Google — Auth.js in a Worker

The site is static HTML on GitHub Pages, so there is nowhere for `next-auth`
to run. This directory is the Auth.js half that can run off the Pages host:
`@auth/core` mounted by hand in a Cloudflare Worker, with the Google
provider and JWT sessions. Accounts and profiles live in D1; the session
itself is still a JWT in the player's own cookie.

| | |
| --- | --- |
| deployed (preview) | `https://site-9066bb3e67224190b78bd63d0ca6bb1e.freebuff.page` |
| callback URL | `https://site-9066bb3e67224190b78bd63d0ca6bb1e.freebuff.page/api/auth/callback/google` |
| site-side helper | [`../signin.js`](../signin.js) |
| page | `https://artistesoundbox.github.io/vitahuesosite/auth/signin.html` |
| portal | `https://artistesoundbox.github.io/vitahuesosite/auth/portal.html` |

## What is in here

| file | what it is |
| --- | --- |
| `src/worker.src.js` | the Worker. Edit this. |
| `worker.js` | the deployed artifact — `src/worker.src.js` with `@auth/core` inlined. Committed, because Sites uploads a prebuilt module and the site has no build step of its own. |
| `build.mjs` | `node build.mjs` — bundles the source into `worker.js`, refuses to emit a module with a `node:` import or no fetch handler, and stamps the source's digest into the banner. |
| `src/profiles.js` | accounts and profiles: the schema, the validation, and the `/api/profile*` routes. The pattern the next modules follow. |
| `portal.html` / `portal.css` / `portal.js` | the portal page — profile view, editor, drag-and-drop section order. Hand-written CSS, vanilla JS, no build step, no framework. |
| `local-google.mjs` | the D1 shim and the fake Google, shared by the suite and the bridge so the two cannot drift. |
| `dev-bridge.mjs` | the built Worker on `127.0.0.1` with a real SQLite database and the fake Google, so the pages can be driven in a browser. |
| `test.mjs` | 215 checks. Runs the real bundle's fetch handler end to end against a locally faked Google: URL-encoded PKCE exchange, RS256 id_token verified against a published JWKS, sessions, profile CRUD, refusals. No network. |
| `sites.manifest.json` | what `sites_deploy` uploads: `worker.js` as `index.js`, nothing else. |

## Routes

| route | what it does |
| --- | --- |
| `GET /api/auth/providers` | what can be signed in with, plus the callback URL Google must know |
| `GET /api/auth/csrf` | the token the sign-in POST needs |
| `POST /api/auth/signin/google` | starts the Google flow — `{csrfToken, callbackUrl}` |
| `GET /api/auth/callback/google` | where Google returns |
| `GET /api/auth/session` | who is signed in, or `null` |
| `POST /api/auth/signout` | ends the session — `{csrfToken}` |
| `GET /api/me` | `{signedIn, user}` shaped for the site |
| `GET /api/identity` | `{token, name, picture}` — a short-lived signed name for the leaderboard |
| `GET /api/health` | which of the secrets are set (never their values), and whether a database is bound |
| `GET /api/profiles` | recently updated public profiles, `?limit=` (max 50) |
| `GET /api/profile` | my profile — created on first look, `{me: true}` |
| `PUT /api/profile` | validated update: `displayName`, `handle`, `bio`, `avatar`, `banner`, `links`, `sections`, `visibility` |
| `GET /api/profile/<handle>` | that profile's public face — 403 when it is private and it is not yours |
| `GET /api/admin/accounts` | every account, handles and roles only — admin only, 403 for a member, 401 signed out |

## Who is an admin

Whoever's Google email is on **`ADMIN_EMAILS`**, and nothing else. The list is
the authority and the `users.role` column only caches it: every look at a
profile reconciles the two in the direction the list says, so granting is
setting a value, revoking is deleting one, and no row can promote itself. A
request cannot ask for the role — a body containing `"role":"admin"` is
ignored, and the test suite pins that.

The email comes from the session, which was minted from a verified Google
`id_token`; `email_verified: false` is refused, because an account Google will
not vouch for must not be able to name itself on the list. `role` is on your own
copy of a profile (`GET /api/profile`, `/api/me`-style responses) and never on
somebody else's public one.

**The leaderboard's half of this.** It verifies `/api/identity` tokens with
`IDENTITY_SECRET`, so both Workers need the *same* value: the preview pair has
it, and a run driven from the page through a real signed-in session lands on the
board carrying the Google name and picture. Pairing a new deployment is still a
step, and it is not a copy: a secret cannot be read back — not through the API,
not through the Sites dashboard — so a pair is made by setting the same value in
both places, and an already-paired pair is re-paired by rotating both together.
A mismatch is not silent: the board answers 401 and the page re-sends the run
under the name the token carried, so the run is not lost, but its picture is, and
the name is unverified.

## Setting it up

### 1. Google Cloud Console — the OAuth client

1. <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → OAuth consent screen**: External; app name and support
   email; scopes `email`, `profile`, `openid`. While it is in **Testing**, only
   accounts listed under **Test users** can sign in — add your own, and publish
   the app when you want anyone to be able to.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Web application**.
4. **Authorized JavaScript origins** — the site, no path:
   - `https://artistesoundbox.github.io`
   - `http://127.0.0.1:8177` (local, from `brokenboot/serve.mjs`)
5. **Authorized redirect URIs** — these end in `/api/auth/callback/google` and
   must match what `GET /api/auth/providers` reports:
   - `https://site-9066bb3e67224190b78bd63d0ca6bb1e.freebuff.page/api/auth/callback/google`
   - `http://127.0.0.1:8178/api/auth/callback/google` (local bridge)
6. Copy the **Client ID** and **Client secret**.

### 2. Worker secrets

| name | what it is |
| --- | --- |
| `AUTH_GOOGLE_ID` | the OAuth client id from step 1 |
| `AUTH_GOOGLE_SECRET` | the client secret from step 1 |
| `AUTH_SECRET` | signs and encrypts sessions. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` — 32 bytes or more, and **changing it signs everybody out** |
| `IDENTITY_SECRET` | signs the short-lived name and picture the leaderboard verifies (`/api/identity`). Deliberately not `AUTH_SECRET`: the leaderboard only needs this one — and it needs the *same value* to check what this Worker signed |
| `ADMIN_EMAILS` | comma-separated Google emails that are admins. Empty (or unset) means nobody is one, which is the safe default |
| `SITE_ORIGINS` | comma-separated origins allowed to call this Worker **with credentials** and to be the target of the post-sign-in redirect, e.g. `https://artistesoundbox.github.io,http://127.0.0.1:8177` |

Set them in **Sites → Secrets** (values never go through a chat or a commit),
then redeploy so the bindings attach — a secret set after a deploy is not in the
running Worker until the next one.

The profile module also needs storage:
`sites_add_storage(siteId, environment, requestId, kind='d1', name='DB')` binds a
D1 database as `DB`, and **a deploy after that attaches it**. There is no
migration step — the schema creates itself on the first profile request — and a
deployment with no binding answers the profile routes with 503 and says which
variable is missing rather than pretending to have saved.

Missing secrets fail loudly, and each one fails only what needs it. Without
`AUTH_SECRET` every `/api/auth/*` route answers 503 and names the variable;
without `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` the sign-in, callback and
provider routes answer 503 naming those, while `/api/auth/csrf`, `/api/me` and
`/api/auth/session` keep working — so the page can say what is missing instead
of just failing to start a sign-in. Without `IDENTITY_SECRET`, `/api/identity`
answers 503 and the rest is unaffected. A half-configured deployment that
*looks* signed-in is worse than one that says it is not ready.

An origin missing from `SITE_ORIGINS` is not a cosmetic difference: the browser
will refuse the responses, and the sign-in will look broken with nothing in the
Worker's log.

### 3. Deploying

```bash
node auth/build.mjs            # only after editing src/worker.src.js
# then, with the Sites tools:
#   sites_deploy(siteId, environment, requestId, manifestPath='auth/sites.manifest.json')
```

Preview and production are separate environments of the same site; production
has to be deployed deliberately, and its `SITE_ORIGINS` / secrets set
separately. The deploy uploads `worker.js` only. If the Sites tools in your
workspace cannot see `auth/` (they only accept files inside the thread's
workspace), see the staging note further down — it is two `cp` commands.

## Using it on a page

```html
<script src="/vitahuesosite/signin.js"></script>
<div data-vh-auth></div>
```

`signin.js` fills that element with a Google button, or with the player's
avatar, name and a sign-out button once they are signed in. It also exposes
`VH_AUTH.signIn()`, `VH_AUTH.whoAmI()`, `VH_AUTH.identity()` and
`VH_AUTH.signOut()`. Every call sends `credentials: "include"` — without it the
cross-site cookie is not sent and everything reads as "signed out".

## Why the cookies are not the defaults

The site is on `artistesoundbox.github.io`; the Worker is on a
`*.freebuff.page` host. Different *sites*, not merely different origins, so
every cookie in the flow is a third-party cookie, and Auth.js's default
`SameSite=Lax` means the browser simply does not send it on the site's fetch.
`src/worker.src.js` therefore redefines each cookie with `SameSite=None;
Secure`. That is a deliberate departure from the library's defaults and the
one thing to check first if sign-in ever "works" but leaves the page signed
out.

Over plain http — which is only ever the local bridge — `SameSite=None` is not a
legal cookie at all: Chrome drops the whole `Set-Cookie` without telling the
server, the next POST arrives without its CSRF cookie, and the flow answers
`error=MissingCSRF` with nothing anywhere pointing at a cookie. So the options
are derived from the request protocol as well: https gets `None; Secure`, http
gets `Lax` — the page and the bridge are both loopback, so they are the same
site and Lax is sent. (Found by pointing a browser at it; the suite could not
see it, because the suite's requests are https and it never preflights.)

It also means the session cookie travels on cross-site POSTs, so the Worker
enforces its own `SITE_ORIGINS` check on POSTs in addition to Auth.js's CSRF
token, and `state` and `nonce` are switched on
(`checks: ["pkce", "state", "nonce"]`) — Auth.js only does PKCE by itself.

## What this cannot do

- **iOS Safari may still not keep you signed in.** SameSite=None cookies are
  exactly the third-party cookies Safari blocks by default. Chrome and Firefox
  are fine; on iOS the sign-in can complete and the session still not persist.
  Serving this Worker on a subdomain of the site's own domain would fix it
  properly, and that needs a custom domain.
- **A session cannot be revoked, only expired.** The session is a JWT in the
  player's own cookie and no adapter is mounted, so signing one person out
  early is not possible. Accounts *are* stored — `users`, keyed by Google's
  `sub` — so deleting a profile is a row delete, but an outstanding cookie
  keeps working until it expires.
- **No admin role exists yet.** Every row is an ordinary account; `users` has
  no `role` column and nothing checks one.
- **It is not `next-auth`.** Same library, same provider, same session format —
  but it is `@auth/core` mounted by hand, so there is no `auth()` helper, no
  React session provider, and no `next-auth` middleware.

## Deploying from a workspace that does not contain `auth/`

The Sites tools only accept files inside the thread's workspace. If that
workspace is a subdirectory of the repository (it was, when this was set up),
stage the artifact next to the manifest, byte for byte:

```bash
mkdir -p <workspace>/vh-auth-deploy
cp auth/worker.js <workspace>/vh-auth-deploy/worker.js   # check with sha256sum
# copy auth/sites.manifest.json there too, then deploy that manifest
```

The manifest uploads `worker.js` only. Never put a secrets file in that
directory — secrets go through **Sites → Secrets**, not through the upload.

## State of the deployment

Preview is deployed and live at the URL above. `SITE_ORIGINS`, `AUTH_SECRET`,
`IDENTITY_SECRET` and the `DB` binding are set; `ADMIN_EMAILS` is not, so every
account is a member until it is. The leaderboard preview holds the same
`IDENTITY_SECRET`, so the two are paired: a run submitted with a token this
Worker signed is stored with the name and picture from that token.

The `role` column was added to the live database by the migration in
`ensureSchema` — `/api/profiles` answering 200 after a deploy is what proves that
ran. `AUTH_GOOGLE_ID` /
`AUTH_GOOGLE_SECRET` are **not**, so today the deployment answers `/api/me` with
`{signedIn: false}`, `/api/identity` with 401, and refuses the sign-in and
provider routes with a 503 naming the missing variables — which is exactly what
the sign-in page reports on screen. So the token *issuing* half is unproven on
the deployment until those two are set: the pairing itself was verified locally,
where a real session can be minted. Finish step 1 and step 2 above, redeploy,
and it is live: the first person to sign in gets a profile created for them,
with Google's name and picture already in it. Production has not been touched.

The profile module is verified live: `/api/profiles` answers an empty list
against the real D1 (which is what runs the schema), and an edit without a
session is 401, a foreign origin is 403, an unknown handle is 404 — all against
the deployed Worker. The end-to-end edit was verified locally, in a browser,
against the same bundle; there is no signed-in path in the deployment yet
because there are no Google credentials to sign in with.

## Tests

```bash
cd auth && npm install     # once: @auth/core, esbuild
node build.mjs             # rebuilds worker.js from src/worker.src.js
node test.mjs              # 232 checks, no network, no Google account
```

The suite cannot see everything a browser can — a CORS preflight, and whether a
cookie is legal — so the pages get driven too:

```bash
node auth/dev-bridge.mjs   # the Worker + sqlite + fake Google, on :8178
node brokenboot/serve.mjs  # the site on :8177
# http://127.0.0.1:8177/auth/portal.html?api=http://127.0.0.1:8178
# switch accounts: http://127.0.0.1:8178/__dev/act-as?sub=dev-2&name=Grace%20Hopper
```

Two bugs in this directory were found that way and by nothing else: the profile
save was blocked by the Worker's own `Access-Control-Allow-Methods` (it listed
`GET, POST, OPTIONS`, so the browser refused to send the PUT and no request ever
reached the Worker), and over http every cookie was `SameSite=None`, which is
illegal without `Secure` and silently dropped. Both are pinned by the suite now.

`test.mjs` also fails if `worker.js` is not the bundle of the current
`src/worker.src.js` (the source digest is stamped into the banner), so editing
the source and forgetting to rebuild is a test failure rather than a silent
regression. The suite runs with no dependencies installed — it imports the
committed bundle, which already contains `@auth/core`.
