/* ============================================================
   Sign in with Google — Auth.js in a Cloudflare Worker.

   THIS IS THE SOURCE. The file that gets deployed is worker.js,
   the single-file bundle `node build.mjs` produces from this one,
   because the site is served by GitHub Pages and a Worker cannot
   pull @auth/core from a package registry — the dependency has to
   be inlined. Edit this, run the build, deploy worker.js.

   WHY THIS WORKER EXISTS, AND WHY IT IS NOT "NEXTAUTH"
   The site is static HTML on GitHub Pages: there is no Next.js app
   and there cannot be a server there, so `next-auth` in its usual
   shape has nowhere to run. Auth.js does ship the half of itself
   that matters — @auth/core — built on plain Request/Response, and
   a Worker handler is exactly that shape. So this is Auth.js, with
   the Google provider, mounted by hand:

     Auth(request, config) -> Response            (@auth/core)

   with /api/auth/* passed straight through to it. Sessions are
   JWTs encrypted with AUTH_SECRET, so there is no user table and
   no database adapter: this deployment holds no account rows at
   all, only a signed cookie on the player's own device.

   THE COOKIES ARE THE INTERESTING PART
   The site is served from artistesoundbox.github.io and this Worker
   answers from a *.freebuff.page host. Those are different *sites*,
   not merely different origins, so every cookie in the flow is a
   third-party cookie. Auth.js defaults to SameSite=Lax, and a Lax
   cookie is simply not sent on the site's cross-site fetch — the
   sign-in would redirect to Google, come back, and land on a page
   with no session, which reads as "login is broken" with nothing
   in any log to say why. So each cookie is redefined here with
   SameSite=None (and Secure, without which None is not allowed at
   all). That is why `cookies` below exists instead of the defaults.

   The names are written out rather than derived because @auth/core
   does not export the map it builds them in — only `@auth/core`,
   `/providers/*`, `/adapters`, `/errors` and `/jwt` are published
   subpaths. They mirror lib/utils/cookie.js exactly, including the
   __Secure- / __Host- prefixes that go with Secure cookies, so a
   session minted here is the same cookie Auth.js documents.

   WHAT A CALLER NEEDS TO KNOW
   Everything is cross-origin, so responses carry exactly one
   allowed Origin (never `*`, which browsers reject alongside
   credentials) plus Allow-Credentials, and the fetch calls from the
   page must pass `credentials: "include"`. Anything not on
   SITE_ORIGINS gets no CORS headers at all; it can still read the
   Worker's own GET / page, and nothing else.

   The post-sign-in redirect is checked against that same list. An
   unchecked `callbackUrl` is an open redirect — a link to a page
   that sends you to Google, then drops you on somebody else's site
   with a fresh session cookie — so unknown targets fall back to the
   Worker's own base URL instead of being honoured.
   ============================================================ */

import { Auth } from "@auth/core";
import Google from "@auth/core/providers/google";

const BASE_PATH = "/api/auth";

/* Auth.js refuses to encrypt a session without a secret, and a
   silently-missing secret is worse than a loud failure: sessions
   would fail to verify on the NEXT request too, so a player would
   sign in successfully and be signed out on the page after. Fail
   the request instead. 32 bytes is what Auth.js wants; the check
   here is length in characters, which is close enough to catch the
   real mistake (a placeholder, or the wrong variable). */
const MIN_SECRET = 32;

/* ============================================================
   configuration
   ============================================================ */

/* SITE_ORIGINS: comma-separated origins allowed to call this Worker
   with credentials and to be the target of a post-sign-in redirect.
   Not a wildcard, ever: with credentials the browser ignores `*`. */
function siteOrigins(env) {
  return String((env && env.SITE_ORIGINS) || "")
    .split(",")
    .map(function (s) { return s.trim().replace(/\/+$/, ""); })
    .filter(Boolean);
}

function corsFor(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;                                  // same-origin or non-browser
  if (siteOrigins(env).indexOf(origin.replace(/\/+$/, "")) === -1) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-auth-return-redirect",
    "access-control-max-age": "86400",
    "vary": "origin"
  };
}

/* Rebuild the response rather than mutate it: a Response's header
   guard forbids touching Set-Cookie, and the sign-in flow sets three
   of them. The pairs are appended one at a time so no two cookies are
   ever folded into one comma-joined header. */
function withCors(res, cors) {
  if (!cors) return res;
  const headers = new Headers();
  for (const pair of res.headers) headers.append(pair[0], pair[1]);
  for (const key of Object.keys(cors)) headers.set(key, cors[key]);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: headers
  });
}

function json(body, status, cors, extra) {
  const headers = Object.assign({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }, extra || {}, cors || {});
  return new Response(JSON.stringify(body), { status: status || 200, headers: headers });
}

/* Auth.js builds the session cookie name from the request protocol:
   HTTPS gets the __Secure- prefix, http://localhost does not. Deriving
   the same way here keeps local development working and production
   prefixed, instead of hard-coding one of the two. */
function cookiesFor(secure) {
  const prefix = secure ? "__Secure-" : "";
  const shared = { httpOnly: true, sameSite: "none", path: "/", secure: secure };
  return {
    sessionToken: { name: prefix + "authjs.session-token", options: shared },
    callbackUrl: { name: prefix + "authjs.callback-url", options: shared },
    /* __Host- (rather than __Secure-) is Auth.js's own choice for this one:
       it binds the cookie to this exact host and forbids a Domain, which is
       what you want for the token that authorises a POST. */
    csrfToken: { name: (secure ? "__Host-" : "") + "authjs.csrf-token", options: shared },
    pkceCodeVerifier: { name: prefix + "authjs.pkce.code_verifier", options: shared },
    state: { name: prefix + "authjs.state", options: shared },
    nonce: { name: prefix + "authjs.nonce", options: shared }
  };
}

/* SameSite=None means the session cookie rides along on a POST from
   anywhere, so the Origin allowlist has to be enforced here too rather
   than assumed. Auth.js's own CSRF token still guards these endpoints —
   this is the second lock, not the only one — and a request with no
   Origin at all (curl, a health probe) is left to it. */
function mutationAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const own = new URL(request.url).origin;
  const cleaned = origin.replace(/\/+$/, "");
  return cleaned === own || siteOrigins(env).indexOf(cleaned) !== -1;
}

function configFor(request, env) {
  const secure = new URL(request.url).protocol === "https:";
  const origins = siteOrigins(env);
  return {
    basePath: BASE_PATH,
    secret: env.AUTH_SECRET,
    /* Cloudflare sets Host itself, so the header can be trusted; Auth.js
       needs this to be explicit outside its own framework integrations. */
    trustHost: true,
    providers: [
      Google({
        clientId: env.AUTH_GOOGLE_ID,
        clientSecret: env.AUTH_GOOGLE_SECRET,
        /* Auth.js does PKCE on its own and nothing else: `state` is only
           added when a redirect proxy is configured, and a `nonce` is only
           created when the provider asks for one (see checks.js — both
           return early otherwise). PKCE binds the authorization code to
           this client, but it does not bind the *callback* to the browser
           that started the sign-in, and it does not tie the returned
           id_token to this particular sign-in. State does the first and
           nonce does the second, so both are asked for here rather than
           left at the library's default. */
        checks: ["pkce", "state", "nonce"]
      })
    ],
    session: { strategy: "jwt" },
    cookies: cookiesFor(secure),
    callbacks: {
      /* Kept minimal on purpose: this deployment stores nothing, so the
         token only has to carry who is signed in.

         `token.googleId` earns its place here. With no adapter Auth.js
         mints its own user id — a fresh random UUID per sign-in, which
         lands in `token.sub` — so `sub` identifies this *session*, not
         this person: the same player signing in tomorrow gets a new one.
         Google's own account id is the stable thing, and it arrives on the
         account as `providerAccountId` (the id_token's `sub`), so it is
         carried separately and used wherever a durable identity matters —
         the leaderboard above all, where a changing id would let one
         player's runs scatter across accounts, or let two players collide. */
      async jwt({ token, account, profile }) {
        if (account && account.providerAccountId) token.googleId = account.providerAccountId;
        if (profile) {
          token.name = profile.name;
          token.picture = profile.picture;
          token.email = profile.email;
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user) {
          session.user.id = token.googleId || token.sub;
          session.user.name = token.name;
          session.user.picture = token.picture;
        }
        return session;
      },
      /* The one place an open redirect could be introduced. Only this
         Worker's own origin and SITE_ORIGINS are honoured; everything
         else (including anything a caller invents) falls back home. */
      async redirect({ url, baseUrl }) {
        if (url.startsWith("/")) return baseUrl + url;
        let target;
        try {
          target = new URL(url);
        } catch (e) {
          return baseUrl;
        }
        const base = new URL(baseUrl).origin;
        if (target.origin === base) return url;
        if (origins.indexOf(target.origin) !== -1) return url;
        return baseUrl;
      }
    }
  };
}

/* ============================================================
   who is signed in
   ============================================================ */

/* Asking Auth.js for the session is the same as the site asking
   /api/auth/session — this rewrites the request onto that path so the
   cookie parsing, decryption and expiry check all stay in one place
   instead of being reimplemented here. */
async function sessionFor(request, env) {
  const url = new URL(request.url);
  url.pathname = BASE_PATH + "/session";
  url.search = "";
  const res = await Auth(new Request(url.toString(), {
    method: "GET",
    headers: request.headers
  }), configFor(request, env));
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* Ten minutes: long enough to finish a race and post the result, short
   enough that a token lifted out of a browser is not a lasting key. */
const IDENTITY_TTL = 600;

const textEncoder = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* A name the scoreboard can trust, without sharing the session cookie.
   IDENTITY_SECRET is deliberately not AUTH_SECRET: the leaderboard
   only ever needs to verify *this* token, so it is handed the narrow
   secret and never the one that mints sessions. */
async function identityToken(env, sessionUser, nowMs) {
  const payload = {
    sub: sessionUser.id,
    name: sessionUser.name,
    picture: sessionUser.picture,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + IDENTITY_TTL
  };
  const body = b64url(textEncoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", textEncoder.encode(env.IDENTITY_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(body));
  return "vhi1." + body + "." + b64url(new Uint8Array(sig));
}

/* ============================================================
   routes
   ============================================================ */
const ROUTES = [
  "Sign in with Google — Auth.js (@auth/core) in a Worker",
  "",
  "GET  /api/auth/providers            what can be signed in with",
  "GET  /api/auth/csrf                 the token a sign-in POST needs",
  "POST /api/auth/signin/google        start the Google flow  {csrfToken, callbackUrl}",
  "GET  /api/auth/callback/google      Google returns here",
  "GET  /api/auth/session              who is signed in, or null",
  "POST /api/auth/signout              end the session        {csrfToken}",
  "GET  /api/me                        the signed-in user, shaped for the site",
  "GET  /api/identity                  a short-lived signed name for the leaderboard",
  "GET  /api/health                    what this deployment is configured with",
  ""
].join("\n");

async function handleMe(request, env, cors) {
  const session = await sessionFor(request, env);
  const user = session && session.user;
  return json({
    ok: true,
    signedIn: !!(user && user.id),
    user: user ? { id: user.id, name: user.name, picture: user.picture } : null
  }, 200, cors);
}

async function handleIdentity(request, env, cors) {
  if (!env.IDENTITY_SECRET) {
    return json({ ok: false, error: "no identity secret configured" }, 503, cors);
  }
  const session = await sessionFor(request, env);
  const user = session && session.user;
  if (!user || !user.id) {
    return json({ ok: false, error: "not signed in" }, 401, cors);
  }
  return json({
    ok: true,
    token: await identityToken(env, user, Date.now()),
    name: user.name,
    picture: user.picture,
    expiresIn: IDENTITY_TTL
  }, 200, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const cors = corsFor(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors || { "vary": "origin" } });
    }
    if (request.method === "POST" && !mutationAllowed(request, env)) {
      return json({ ok: false, error: "origin not allowed" }, 403, cors);
    }

    try {
      if (path === BASE_PATH || path.indexOf(BASE_PATH + "/") === 0) {
        if (!env.AUTH_SECRET || String(env.AUTH_SECRET).length < MIN_SECRET) {
          return json({
            ok: false,
            error: "AUTH_SECRET is missing or shorter than " + MIN_SECRET + " characters"
          }, 503, cors);
        }
        /* The Google credentials are only required by the routes that talk
           to Google. CSRF and session do not, and refusing them too would
           hide the real fault behind a generic "cannot start sign-in" — the
           failure has to name the variable that is missing, in the one
           deployment state where somebody is actually looking for it. */
        if (/\/(signin|callback|providers)/.test(path) &&
            (!env.AUTH_GOOGLE_ID || !env.AUTH_GOOGLE_SECRET)) {
          return json({
            ok: false,
            error: "AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are not both set"
          }, 503, cors);
        }
        const res = await Auth(request, configFor(request, env));
        return withCors(res, cors);
      }

      if (path === "/api/me" && request.method === "GET") {
        if (!env.AUTH_SECRET) return json({ ok: false, error: "not configured" }, 503, cors);
        return await handleMe(request, env, cors);
      }
      if (path === "/api/identity" && request.method === "GET") {
        if (!env.AUTH_SECRET) return json({ ok: false, error: "not configured" }, 503, cors);
        return await handleIdentity(request, env, cors);
      }
      if (path === "/api/health" && request.method === "GET") {
        return json({
          ok: true,
          provider: "google",
          basePath: BASE_PATH,
          hasAuthSecret: !!env.AUTH_SECRET && String(env.AUTH_SECRET).length >= MIN_SECRET,
          hasGoogleCredentials: !!env.AUTH_GOOGLE_ID && !!env.AUTH_GOOGLE_SECRET,
          hasIdentitySecret: !!env.IDENTITY_SECRET,
          siteOrigins: siteOrigins(env).length
        }, 200, cors);
      }
      if (path === "/" || path === "/api") {
        return new Response(ROUTES, {
          headers: Object.assign({ "content-type": "text/plain; charset=utf-8" }, cors || {})
        });
      }
      return json({ ok: false, error: "not found" }, 404, cors);
    } catch (err) {
      return json({
        ok: false,
        error: "server error",
        detail: String((err && err.message) || err)
      }, 500, cors);
    }
  }
};
