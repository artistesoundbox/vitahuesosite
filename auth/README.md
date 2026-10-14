# Sign in with Google — Auth.js in a Worker

The site is static HTML on GitHub Pages, so there is nowhere for `next-auth`
to run. This directory is the Auth.js half that can run off the Pages host:
`@auth/core` mounted by hand in a Cloudflare Worker, with the Google
provider, JWT sessions and no database.

| | |
| --- | --- |
| deployed (preview) | `https://site-9066bb3e67224190b78bd63d0ca6bb1e.freebuff.page` |
| callback URL | `https://site-9066bb3e67224190b78bd63d0ca6bb1e.freebuff.page/api/auth/callback/google` |
| site-side helper | [`../signin.js`](../signin.js) |
| page | `https://artistesoundbox.github.io/vitahuesosite/auth/signin.html` |

## What is in here

| file | what it is |
| --- | --- |
| `src/worker.src.js` | the Worker. Edit this. |
| `worker.js` | the deployed artifact — `src/worker.src.js` with `@auth/core` inlined. Committed, because Sites uploads a prebuilt module and the site has no build step of its own. |
| `build.mjs` | `node build.mjs` — bundles the source into `worker.js`, refuses to emit a module with a `node:` import or no fetch handler, and stamps the source's digest into the banner. |
| `test.mjs` | 101 checks. Runs the real bundle's fetch handler end to end against a locally faked Google: URL-encoded PKCE exchange, RS256 id_token verified against a published JWKS, sessions, refusals. No network. |
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
| `GET /api/health` | which of the secrets are set (never their values) |

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
| `IDENTITY_SECRET` | signs the short-lived name the leaderboard verifies. Deliberately not `AUTH_SECRET`: the leaderboard only needs this one |
| `SITE_ORIGINS` | comma-separated origins allowed to call this Worker **with credentials** and to be the target of the post-sign-in redirect, e.g. `https://artistesoundbox.github.io,http://127.0.0.1:8177` |

Set them in **Sites → Secrets** (values never go through a chat or a commit),
then redeploy so the bindings attach — a secret set after a deploy is not in the
running Worker until the next one.

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
- **No accounts are stored.** There is no adapter and no user table: the
  session is a JWT in the player's own cookie, so nothing here can list users
  or revoke one person's session.
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

Preview is deployed and live at the URL above. `SITE_ORIGINS`, `AUTH_SECRET` and
`IDENTITY_SECRET` are set. `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` are **not**,
so today the deployment answers `/api/me` with `{signedIn: false}`,
`/api/identity` with 401, and refuses the sign-in and provider routes with a 503
naming the missing variables — which is exactly what the sign-in page reports on
screen. Finish step 1 and step 2 above, redeploy, and it is live. Production has
not been touched.

## Tests

```bash
cd auth && npm install     # once: @auth/core, esbuild
node build.mjs             # rebuilds worker.js from src/worker.src.js
node test.mjs              # 101 checks, no network, no Google account
```

`test.mjs` also fails if `worker.js` is not the bundle of the current
`src/worker.src.js` (the source digest is stamped into the banner), so editing
the source and forgetting to rebuild is a test failure rather than a silent
regression. The suite runs with no dependencies installed — it imports the
committed bundle, which already contains `@auth/core`.
