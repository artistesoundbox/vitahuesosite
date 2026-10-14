/* ============================================================
   Local end-to-end test for the Google sign-in Worker.
   node test.mjs          (builds first: node build.mjs && node test.mjs)

   WHAT IT ACTUALLY EXERCISES
   The real artifact — worker.js, the bundle that gets deployed — driven
   through the only interface a Worker has: its fetch handler. No part of
   Auth.js is stubbed, mocked or bypassed: the same @auth/core code that
   runs on the edge runs here, parses the cookies, checks the CSRF token,
   does the PKCE exchange and encrypts the session.

   Google is the one thing that is faked, because it cannot be scripted and
   must not be called from a test. A local server answers the same
   discovery document, authorization, token, userinfo and JWKS endpoints;
   outbound fetches to the real Google hosts are redirected to it. The
   id_token it returns is a genuine RS256 JWT signed with a locally
   generated key whose JWKS it publishes, so Auth.js verifies a real
   signature and a real nonce rather than being handed a pre-baked profile.
   The discovery document keeps advertising Google's own URLs, so the
   library's https enforcement is still in play.

   WHAT IT DOES NOT COVER
   Anything specific to workerd: cold starts, isolate reuse, the real
   Cloudflare cookie handling (the SameSite=None attributes are asserted
   from the response headers, but no browser's third-party-cookie policy
   is consulted here), and Google's own consent screen. Those only a
   deployment and a browser can.

   ONE EXPECTED SOUND
   `[auth][error] ...` lines on stderr are Auth.js reporting the very
   refusals this suite asks for — a tampered session cookie, a callback
   with no flow cookie, a wrong CSRF token, an unknown route. They are the
   library working, not the test failing; the exit code is the verdict.
   ============================================================ */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* The D1 shim and the fake Google. Shared with dev-bridge.mjs, so the thing a
   browser is driven against and the thing this suite asserts are the same. */
import { d1Adapter, createFakeGoogle } from "./local-google.mjs";

/* ---- the three origins this deployment lives between ---- */
const WORKER_ORIGIN = "https://auth.test";                       // the deployed Worker
const SITE_ORIGIN = "https://artistesoundbox.github.io";         // GitHub Pages
const SITE_PAGE = SITE_ORIGIN + "/vitahuesosite/auth/signin.html";
const LOCAL_SITE = "http://127.0.0.1:8177";                     // brokenboot/serve.mjs
const EVIL_ORIGIN = "https://evil.example";

const AUTH_SECRET = "local-test-auth-secret-not-a-real-one";
const IDENTITY_SECRET = "local-test-identity-secret";
const GOOGLE_ID = "1234567890-local.apps.googleusercontent.com";
const GOOGLE_SECRET = "local-test-google-client-secret";

const env = {
  AUTH_SECRET: AUTH_SECRET,
  AUTH_GOOGLE_ID: GOOGLE_ID,
  AUTH_GOOGLE_SECRET: GOOGLE_SECRET,
  IDENTITY_SECRET: IDENTITY_SECRET,
  SITE_ORIGINS: SITE_ORIGIN + "," + LOCAL_SITE
};
/* Bound after the literal so a deployment missing it can be tested by handing
   the worker a different env object — which is exactly what the last section
   of this suite does. */
env.DB = d1Adapter();

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; failures.push(name + (detail ? "  → " + detail : "")); console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " want " + JSON.stringify(want));
}
function section(title) { console.log("\n[" + title + "]"); }

/* ============================================================
   the fake Google
   ============================================================ */
/* The fake Google. `PROFILE` is the module's account object rather than a
   copy, so the assertions below read the account that was actually signed in
   with. */
const google = createFakeGoogle({ clientId: GOOGLE_ID, clientSecret: GOOGLE_SECRET });
const PROFILE = google.profile;
await google.start();
google.install();

/* Imported AFTER the patch, so nothing that captured a fetch at import
   time can slip past it. */
const worker = (await import("./worker.js?t=" + Date.now())).default;

/* Is the committed bundle the bundle of the source next to it? It has to
   be asked before anything else means much: every check below would pass
   just as happily against an old build, and an old build is what gets
   deployed if somebody edits the source and forgets `node build.mjs`. */
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceBytes = fs.readFileSync(path.join(here, "src", "worker.src.js"));
const bundleText = fs.readFileSync(path.join(here, "worker.js"), "utf8");
const recorded = /source-sha256:\s*([0-9a-f]{64})/.exec(bundleText);
const actual = crypto.createHash("sha256").update(sourceBytes).digest("hex");
section("the committed bundle is the bundle of the source beside it");
check("worker.js records the digest of its source", !!recorded, String(recorded && recorded[1]));
check("and it is the digest of the source as it stands now (run `node build.mjs` after editing src/)",
  !!recorded && recorded[1] === actual,
  recorded ? "bundle " + recorded[1].slice(0, 12) + " vs source " + actual.slice(0, 12) : "no digest in the bundle");

/* ============================================================
   driving the Worker the way a browser would
   ============================================================ */
class Jar {
  constructor() { this.cookies = new Map(); }
  absorb(res) {
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(";")[0];
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      /* clearing a cookie is Max-Age=0 with an empty value */
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() { return [...this.cookies].map(([k, v]) => k + "=" + v).join("; "); }
  get(name) { return this.cookies.get(name) || null; }
}
const jar = new Jar();

function rawSetCookies(res) { return res.headers.getSetCookie(); }
function cookieNamed(res, name) {
  return rawSetCookies(res).find((c) => c.split("=")[0] === name) || "";
}

async function call(target, opts) {
  const o = opts || {};
  if (typeof target !== "string") {
    throw new Error("call() needs a URL — the step before it produced " + JSON.stringify(target));
  }
  const url = target.startsWith("http") ? target : WORKER_ORIGIN + target;
  const headers = new Headers(o.headers || {});
  if (o.origin !== null) headers.set("origin", o.origin || SITE_ORIGIN);
  if (o.noCookies !== true && jar.header()) headers.set("cookie", jar.header());
  const res = await worker.fetch(new Request(url, {
    method: o.method || "GET",
    headers: headers,
    body: o.body,
    redirect: "manual"
  }), env);
  if (o.absorb !== false) jar.absorb(res);
  return res;
}

async function jsonOf(res) { try { return await res.json(); } catch (e) { return null; } }

/* ============================================================
   the flow
   ============================================================ */
section("configuration");
{
  const res = await call("/api/health");
  const body = await jsonOf(res);
  check("health answers 200", res.status === 200, "status " + res.status);
  check("health reports the Google provider", body && body.provider === "google", JSON.stringify(body));
  check("health sees AUTH_SECRET", body && body.hasAuthSecret === true, JSON.stringify(body));
  check("health sees the Google credentials", body && body.hasGoogleCredentials === true, JSON.stringify(body));
  check("health sees the identity secret", body && body.hasIdentitySecret === true, JSON.stringify(body));
  check("health does not leak a secret value", !JSON.stringify(body).includes(AUTH_SECRET), JSON.stringify(body));
  eq("health counts the allowed site origins", body && body.siteOrigins, 2);

  const root = await call("/", { origin: null });
  check("the route list is served at /", root.status === 200 && (await root.text()).includes("/api/auth/callback/google"));
}

section("CORS — exactly one origin, and only the allowed one");
{
  const allowed = await call("/api/health", { origin: SITE_ORIGIN });
  eq("allowed origin is echoed back", allowed.headers.get("access-control-allow-origin"), SITE_ORIGIN);
  eq("credentials are allowed", allowed.headers.get("access-control-allow-credentials"), "true");
  eq("the response varies on origin", allowed.headers.get("vary"), "origin");
  check("never a wildcard", allowed.headers.get("access-control-allow-origin") !== "*");

  const foreign = await call("/api/health", { origin: EVIL_ORIGIN });
  eq("a foreign origin gets no allow-origin", foreign.headers.get("access-control-allow-origin"), null);

  const preflight = await call("/api/auth/signin/google", { method: "OPTIONS", origin: SITE_ORIGIN, noCookies: true });
  check("preflight answers 204", preflight.status === 204, "status " + preflight.status);
  check("preflight allows the return-redirect header",
    String(preflight.headers.get("access-control-allow-headers") || "").toLowerCase().includes("x-auth-return-redirect"));

  /* The profile save is a PUT with a JSON body, so the browser preflights it
     and will not send it unless PUT is on this list. A direct caller never
     preflights, so this is the one CORS fact the suite cannot learn by making
     the request — it has to be asserted from the header. */
  const save = await call("/api/profile", {
    method: "OPTIONS",
    origin: SITE_ORIGIN,
    noCookies: true,
    headers: { "access-control-request-method": "PUT", "access-control-request-headers": "content-type" }
  });
  const methods = String(save.headers.get("access-control-allow-methods") || "").toUpperCase();
  check("a preflight for the profile save answers 204", save.status === 204, "status " + save.status);
  check("and allows PUT, or the browser never sends the save",
    /(^|[,\s])PUT([,\s]|$)/.test(methods), methods);
  check("it allows every method the profile routes answer",
    ["GET", "POST", "PUT", "PATCH"].every((m) => methods.indexOf(m) !== -1), methods);
}

section("a POST from an origin that is not allowed is refused");
{
  const res = await call("/api/auth/signin/google", {
    method: "POST", origin: EVIL_ORIGIN, body: "csrfToken=whatever", absorb: false
  });
  check("foreign-origin POST is 403", res.status === 403, "status " + res.status);
  const body = await jsonOf(res);
  eq("and says why", body && body.error, "origin not allowed");
}

section("providers — the callback URL Google has to know");
{
  const res = await call("/api/auth/providers");
  const body = await jsonOf(res);
  check("google is offered", !!(body && body.google), JSON.stringify(body));
  eq("the sign-in route", body && body.google && body.google.signinUrl, WORKER_ORIGIN + "/api/auth/signin/google");
  eq("the redirect URI to register in Google Cloud",
    body && body.google && body.google.callbackUrl, WORKER_ORIGIN + "/api/auth/callback/google");
  eq("and is readable from the site", res.headers.get("access-control-allow-origin"), SITE_ORIGIN);
}

section("sign-in: CSRF token, then the redirect to Google");
let signInUrl = null;
{
  const csrfRes = await call("/api/auth/csrf");
  const csrfBody = await jsonOf(csrfRes);
  check("csrf answers a token", typeof (csrfBody && csrfBody.csrfToken) === "string" && csrfBody.csrfToken.length > 10,
    JSON.stringify(csrfBody));

  const cookie = cookieNamed(csrfRes, "__Host-authjs.csrf-token");
  check("the csrf cookie is set", !!cookie, rawSetCookies(csrfRes).join(" | "));
  check("the csrf cookie is cross-site usable", /samesite=none/i.test(cookie), cookie);
  check("the csrf cookie is Secure", /;\s*secure/i.test(cookie), cookie);
  check("the csrf cookie is HttpOnly", /httponly/i.test(cookie), cookie);

  const res = await call("/api/auth/signin/google", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1"
    },
    body: new URLSearchParams({ csrfToken: csrfBody.csrfToken, callbackUrl: SITE_PAGE }).toString()
  });
  const body = await jsonOf(res);
  check("sign-in answers a redirect target as JSON", res.status === 200 && !!(body && body.url),
    "status " + res.status + " " + JSON.stringify(body));
  signInUrl = body && body.url;

  const cookies = rawSetCookies(res);
  check("the flow sets state, verifier and callback-url cookies", cookies.length >= 3,
    cookies.join(" | "));
  check("no two cookies were folded into one header", new Set(cookies.map((c) => c.split("=")[0])).size === cookies.length,
    cookies.join(" | "));
  check("every flow cookie is SameSite=None",
    cookies.every((c) => /samesite=none/i.test(c)) && cookies.length > 0, cookies.join(" | "));
  check("every flow cookie is Secure",
    cookies.every((c) => /;\s*secure/i.test(c)) && cookies.length > 0, cookies.join(" | "));
  check("the state cookie is HttpOnly", /httponly/i.test(cookieNamed(res, "__Secure-authjs.state")),
    cookieNamed(res, "__Secure-authjs.state"));

  const target = new URL(String(signInUrl));
  eq("the sign-in goes to Google", target.host, "accounts.google.com");
  eq("with our client id", target.searchParams.get("client_id"), GOOGLE_ID);
  eq("asking for the openid scopes",
    (target.searchParams.get("scope") || "").split(" ").sort().join(" "), "email openid profile");
  eq("using PKCE", target.searchParams.get("code_challenge_method"), "S256");
  check("with a challenge", (target.searchParams.get("code_challenge") || "").length > 20);
  check("with a state", (target.searchParams.get("state") || "").length > 10);
  check("with a nonce", (target.searchParams.get("nonce") || "").length > 10);
}

/* The local bridge reaches the Worker over plain http, where SameSite=None
   is not a legal cookie: Chrome drops the whole Set-Cookie without telling
   the server, and the next POST fails as MissingCSRF with no indication of
   which cookie went. Nothing about the deployed (https) flow changes; this
   pins the http one so the bridge cannot quietly stop being usable. */
section("the local bridge: plain http cookies stayed legal");
{
  const res = await call("http://127.0.0.1:8178/api/auth/csrf", { absorb: false });
  const cookies = rawSetCookies(res);
  check("an http request is answered", res.status === 200, "status " + res.status);
  check("it sets a csrf cookie", cookies.length > 0, cookies.join(" | "));
  check("with no sameSite=none, which http may not carry",
    cookies.every((c) => !/samesite=none/i.test(c)), cookies.join(" | "));
  check("but sameSite=lax", cookies.every((c) => /samesite=lax/i.test(c)), cookies.join(" | "));
  check("and no __Secure-/__Host- prefix, as Auth.js requires over http",
    !!cookieNamed(res, "authjs.csrf-token"), cookies.join(" | "));
}

section("Google's side of the flow (the faked consent screen)");
{
  /* globalThis.fetch, not realFetch: the patched one is what redirects
     Google's hostnames at the local server. */
  const res = await globalThis.fetch(signInUrl, { redirect: "manual" });
  check("the authorize endpoint answers a redirect", res.status === 302 || res.status === 303,
    "status " + res.status);
  const location = res.headers.get("location");
  check("returning to this Worker's callback", !!location && location.startsWith(WORKER_ORIGIN + "/api/auth/callback/google"),
    String(location));
  eq("the redirect_uri is the exact registered value",
    google.authorizeSeen && google.authorizeSeen.redirect_uri, WORKER_ORIGIN + "/api/auth/callback/google");

  const callbackRes = await call(location);
  check("the callback completes the sign-in", [302, 303, 307].includes(callbackRes.status), "status " + callbackRes.status);
  eq("and returns the player to the page they came from", callbackRes.headers.get("location"), SITE_PAGE);

  const sessionCookie = cookieNamed(callbackRes, "__Secure-authjs.session-token");
  check("a session cookie is issued", !!sessionCookie, rawSetCookies(callbackRes).join(" | "));
  check("the session cookie is cross-site usable", /samesite=none/i.test(sessionCookie), sessionCookie);
  check("the session cookie is Secure", /;\s*secure/i.test(sessionCookie), sessionCookie);
  check("the session cookie is HttpOnly", /httponly/i.test(sessionCookie), sessionCookie);
  check("the session cookie holds no readable profile",
    !/test player|player@example\.com/i.test(sessionCookie), sessionCookie);
  const spent = ["__Secure-authjs.state", "__Secure-authjs.pkce.code_verifier", "__Secure-authjs.nonce"];
  check("the one-shot checks are consumed, not left lying around",
    spent.every((n) => /max-age=0/i.test(cookieNamed(callbackRes, n))),
    rawSetCookies(callbackRes).map((c) => c.split(";")[0] + "…").join(" | "));
}

section("who is signed in");
{
  const res = await call("/api/auth/session");
  const body = await jsonOf(res);
  check("the session has a user", !!(body && body.user), JSON.stringify(body));
  eq("with the Google id", body && body.user && body.user.id, PROFILE.sub);
  eq("with the Google name", body && body.user && body.user.name, PROFILE.name);
  eq("with the Google picture", body && body.user && body.user.picture, PROFILE.picture);
  check("personalized responses are not cacheable",
    /no-store/i.test(String(res.headers.get("cache-control"))), String(res.headers.get("cache-control")));

  const me = await call("/api/me");
  const meBody = await jsonOf(me);
  eq("GET /api/me reports signed in", meBody && meBody.signedIn, true);
  eq("GET /api/me returns the name", meBody && meBody.user && meBody.user.name, PROFILE.name);
}

section("a name the leaderboard can verify");
{
  const res = await call("/api/identity");
  const body = await jsonOf(res);
  check("identity answers a token", typeof (body && body.token) === "string", JSON.stringify(body));
  const parts = String(body && body.token).split(".");
  eq("the token is a three-part signed compact", parts.length, 3);

  /* Verified the way the leaderboard will: the same HMAC over the same
     bytes. If this holds, a Worker holding only IDENTITY_SECRET can accept
     the name and nothing else about the session can be forged from it. */
  const expected = crypto.createHmac("sha256", IDENTITY_SECRET).update(parts[1]).digest("base64url");
  check("the signature verifies with the shared secret only", parts[2] === expected);

  const wrong = crypto.createHmac("sha256", "some-other-secret").update(parts[1]).digest("base64url");
  check("a different secret does not verify", parts[2] !== wrong);

  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  eq("the payload carries the Google id", payload.sub, PROFILE.sub);
  eq("the payload carries the display name", payload.name, PROFILE.name);
  eq("the payload carries the avatar", payload.picture, PROFILE.picture);
  check("the token expires", payload.exp > payload.iat, JSON.stringify(payload));
  eq("and expires within minutes", payload.exp - payload.iat, 600);
  check("the payload carries no session material",
    !/AUTH_SECRET|session/i.test(Buffer.from(parts[1], "base64url").toString("utf8")));
}

section("the identity is the player's own, and it does not change");
{
  const again = await jsonOf(await call("/api/auth/session"));
  eq("a second request is still signed in", again && again.user && again.user.id, PROFILE.sub);

  /* The same person signing in again must be the same identity. Auth.js's
     own id is a fresh UUID per sign-in, which is exactly what a
     scoreboard cannot use — hence Google's account id instead, asserted
     here by signing in a second time from a clean jar. */
  const secondJar = new Jar();
  const savedJar = jar.cookies;
  jar.cookies = secondJar.cookies;
  const csrf2 = await jsonOf(await call("/api/auth/csrf"));
  const start2 = await jsonOf(await call("/api/auth/signin/google", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken: csrf2.csrfToken, callbackUrl: SITE_PAGE }).toString()
  }));
  const authorize2 = await globalThis.fetch(start2.url, { redirect: "manual" });
  await call(authorize2.headers.get("location"));
  const secondSession = await jsonOf(await call("/api/auth/session"));
  eq("signing in again is the same player, not a new one",
    secondSession && secondSession.user && secondSession.user.id, PROFILE.sub);
  const secondIdentity = await jsonOf(await call("/api/identity"));
  check("and no Auth.js-generated id leaks into the token",
    !!secondIdentity && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(String(secondIdentity.token)),
    String(secondIdentity && secondIdentity.token).slice(0, 40));
  jar.cookies = savedJar;

  const jarBefore = new Map(jar.cookies);
  jar.cookies.set("__Secure-authjs.session-token", "tampered.value.here");
  const tampered = await jsonOf(await call("/api/auth/session"));
  check("a tampered session cookie is not a session", !tampered || !tampered.user, JSON.stringify(tampered));
  const identity = await call("/api/identity", { absorb: false });
  eq("and gets no identity token", identity.status, 401);
  jar.cookies = jarBefore;

  check("the restored session still works", !!jar.get("__Secure-authjs.session-token"), jar.header().slice(0, 40));
}

section("redirects cannot be aimed at somebody else");
{
  const csrf = await jsonOf(await call("/api/auth/csrf"));
  const res = await call("/api/auth/signin/google", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: EVIL_ORIGIN + "/steal" }).toString()
  });
  const body = await jsonOf(res);
  check("an off-list callbackUrl is not honoured", !!body && body.url && !body.url.includes("evil.example"),
    String(body && body.url));
  check("the sign-in still goes to Google", !!body && body.url && body.url.includes("accounts.google.com"));

  const authorize = await globalThis.fetch(body.url, { redirect: "manual" });
  const callbackRes = await call(authorize.headers.get("location"));
  check("and the player is not dropped on the foreign site",
    !String(callbackRes.headers.get("location")).includes("evil.example"),
    String(callbackRes.headers.get("location")));
  check("the fallback is this Worker's own origin",
    String(callbackRes.headers.get("location")).startsWith(WORKER_ORIGIN),
    String(callbackRes.headers.get("location")));
  check("the sign-in itself still succeeded", !!cookieNamed(callbackRes, "__Secure-authjs.session-token"));
}

section("refusals");
{
  /* Auth.js refuses this by redirecting to its own error page rather than
     answering a 4xx, so the refusal is asserted where it actually shows:
     an error in the redirect, and no session issued. */
  const noState = await call(WORKER_ORIGIN + "/api/auth/callback/google?code=code-nothing&state=state-nothing", {
    noCookies: true, absorb: false
  });
  const noStateWhere = String(noState.headers.get("location"));
  check("a callback with no flow cookie is refused, not honoured",
    noState.status === 302 && /error/i.test(noStateWhere) && !!noStateWhere,
    "status " + noState.status + " -> " + noStateWhere);
  check("and no session is issued for it",
    !cookieNamed(noState, "__Secure-authjs.session-token"), rawSetCookies(noState).join(" | "));

  const badCsrf = await call("/api/auth/signin/google", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken: "not-the-token", callbackUrl: SITE_PAGE }).toString(),
    absorb: false
  });
  const badBody = await jsonOf(badCsrf);
  check("a wrong CSRF token does not start a sign-in",
    !(badBody && badBody.url && badBody.url.includes("accounts.google.com")),
    "status " + badCsrf.status + " " + JSON.stringify(badBody));

  const unknown = await call("/api/auth/nope", { absorb: false });
  check("an unknown auth route is not a 200", unknown.status >= 400, "status " + unknown.status);
  const notFound = await call("/api/nope", { absorb: false });
  eq("an unknown API route is 404", notFound.status, 404);

  const unsignedOut = await call("/api/identity", { noCookies: true, absorb: false });
  eq("no cookie, no identity", unsignedOut.status, 401);
  const unsignedMe = await jsonOf(await call("/api/me", { noCookies: true, absorb: false }));
  eq("no cookie, not signed in", unsignedMe && unsignedMe.signedIn, false);
}

section("the built-in sign-in page renders (preact inside the bundle)");
{
  const res = await call("/api/auth/signin", { noCookies: true, absorb: false });
  const html = await res.text();
  check("the sign-in page is HTML", res.status === 200 && /<html/i.test(html), "status " + res.status);
  check("and offers Google", /google/i.test(html), html.slice(0, 120));
}

/* ============================================================
   profiles — the first thing here that has to outlive a cookie
   ============================================================ */

function putProfile(body, opts) {
  return call("/api/profile", Object.assign({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }, opts || {}));
}

/* Another account, written straight into the shim: these are the people this
   profile is looked at by, and going through Google twice to make them would
   test the sign-in flow rather than the thing under test. */
async function seedUser(sub, handle, visibility) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (sub, email, handle, handle_lower, display_name, bio, avatar_url, banner_url," +
    " links, sections, visibility, google_name, google_picture, created, updated)" +
    " VALUES (?, '', ?, ?, ?, '', '', '', '[]', '[]', ?, '', '', ?, ?)"
  ).bind(sub, handle, handle.toLowerCase(), handle, visibility, now, now).run();
}

section("[accounts: the row appears the first time somebody looks]");
let myHandle = null;
{
  const res = await call("/api/profile");
  const body = await jsonOf(res);
  eq("a signed-in look answers 200", res.status, 200);
  check("and says it is yours", body && body.me === true, JSON.stringify(body && body.error));
  const profile = body && body.profile;
  check("with a profile in it", !!profile, JSON.stringify(body));
  eq("the handle is derived from the Google name", profile && profile.handle, "test-player");
  eq("the display name starts as the Google name", profile && profile.displayName, PROFILE.name);
  eq("the avatar starts as the Google picture", profile && profile.avatar, PROFILE.picture);
  eq("with the default section order", profile && profile.sections, ["about", "links", "showcase", "shorts"]);
  eq("public until told otherwise", profile && profile.visibility, "public");
  eq("an empty bio", profile && profile.bio, "");
  eq("and no links", profile && profile.links, []);
  check("the email is on your own copy of it", profile && profile.email === PROFILE.email, JSON.stringify(profile && profile.email));
  check("with timestamps", profile && profile.joined > 0 && profile.updated >= profile.joined);
  myHandle = profile && profile.handle;

  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const indexes = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'users_handle_lower'").all();
  eq("the table was created on the way", (tables.results || []).map((r) => r.name).filter((n) => n === "users"), ["users"]);
  eq("with the unique handle index", (indexes.results || []).length, 1);

  const again = await jsonOf(await call("/api/profile"));
  eq("a second look does not make a second row", again && again.profile && again.profile.handle, myHandle);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  eq("one row", count.n, 1);
}

section("[editing it]");
{
  const res = await putProfile({
    displayName: "  Ada   Lovelace  ",
    bio: "First line.\r\n\r\nSecond paragraph, after a blank line.  ",
    handle: "TP-Profile",
    links: [
      { label: "website", url: "https://example.com/ada?ref=1#top" },
      { label: "x", url: "https://x.com/ada" },
      { label: "email", url: "ada@example.com" }
    ],
    sections: ["shorts", "about"]
  });
  const body = await jsonOf(res);
  eq("an edit answers 200", res.status, 200);
  const profile = body && body.profile;
  eq("runs of spaces collapse", profile && profile.displayName, "Ada Lovelace");
  eq("the bio keeps its paragraphs", profile && profile.bio, "First line.\n\nSecond paragraph, after a blank line.");
  check("a handle is stored lowercased, because the URL is its identity", profile && profile.handle === "tp-profile", String(profile && profile.handle));
  myHandle = profile.handle;
  eq("links keep their labels and only https", profile && profile.links.map((l) => l.label), ["website", "x", "email"]);
  check("a normalized https url", profile && profile.links[0].url === "https://example.com/ada?ref=1#top", String(profile && profile.links[0].url));
  eq("an email link becomes a mailto", profile && profile.links[2].url, "mailto:ada@example.com");
  /* The list is what the profile shows: nothing is appended, which is what
     makes hiding a section expressible at all. */
  eq("the sections are exactly the ones the caller listed, in order", profile && profile.sections, ["shorts", "about"]);
  const reread = await jsonOf(await call("/api/profile"));
  eq("and a hidden section stays hidden when read back", reread.profile.sections, ["shorts", "about"]);

  const notMine = await jsonOf(await putProfile({ sub: "somebody-else", email: "attacker@example.com" }));
  eq("unknown fields are ignored, not applied", notMine && notMine.profile && notMine.profile.handle, "tp-profile");
  const row = await env.DB.prepare("SELECT sub, email FROM users").first();
  eq("and the account is still the one Google gave", row.sub, PROFILE.sub);
  eq("with the email Google gave, not the one sent", row.email, PROFILE.email);

  const long = await jsonOf(await putProfile({ bio: "x".repeat(900) }));
  eq("a long bio is capped, not refused", long.profile.bio.length, 600);
  const eight = [];
  for (let i = 0; i < 8; i++) eight.push({ label: "website", url: "https://example.com/" + i });
  eq("eight links are fine", (await jsonOf(await putProfile({ links: eight }))).profile.links.length, 8);
  eq("nine are not", (await putProfile({ links: eight.concat([{ label: "website", url: "https://example.com/8" }]) })).status, 422);
}

section("[refusals answer with the field that was wrong]");
{
  const cases = [
    [{ displayName: "   " }, "displayName", "cannot be empty"],
    [{ displayName: "x".repeat(80) }, null, null],
    [{ handle: "ab" }, "handle", null],
    [{ handle: "admin" }, "handle", "that handle is reserved"],
    [{ visibility: "secret" }, "visibility", null],
    [{ links: "not a list" }, "links", null],
    [{ links: [{ label: "evil", url: "https://example.com" }] }, "links[0].label", null],
    [{ links: [{ label: "website", url: "http://example.com" }] }, "links[0].url", "only https:// links are accepted"],
    [{ links: [{ label: "website", url: "javascript:alert(1)" }] }, "links[0].url", "only https:// links are accepted"],
    [{ links: [{ label: "website", url: "data:text/html,<script>" }] }, "links[0].url", "only https:// links are accepted"],
    [{ links: [{ label: "website", url: "https://user:pass@example.com" }] }, "links[0].url", "credentials are not allowed in a URL"],
    [{ links: [{ label: "website", url: "not a url" }] }, "links[0].url", "not a URL"],
    [{ links: [{ label: "email", url: "not-an-address" }] }, "links[0].url", "not an email address"],
    [{ avatar: "data:text/html,<script>" }, "avatar", null],
    [{ banner: "http://example.com/b.png" }, "banner", null],
    [{ sections: ["about", "evil"] }, "sections", null],
    [{ sections: "about" }, "sections", null],
    [{ sections: [] }, "sections", "at least one section"],
    [{ sections: ["about", "about", "about", "about", "about", "about", "about", "about"] }, "sections", "at most 7 sections"]
  ];
  for (const [body, field, maybeMessage] of cases) {
    const res = await putProfile(body);
    const payload = await jsonOf(res);
    const named = payload && payload.fields && payload.fields.map((f) => f.field);
    if (field === null) {
      /* a long display name is capped rather than refused */
      eq("a 80-character display name is capped, not refused", res.status, 200);
      eq("and stored at the limit", payload.profile.displayName.length, 48);
      continue;
    }
    eq(JSON.stringify(body) + " → 422", res.status, 422);
    check("  naming " + field, !!named && named.indexOf(field) !== -1, JSON.stringify(payload));
    if (maybeMessage) check("  saying why", JSON.stringify(payload).indexOf(maybeMessage) !== -1, JSON.stringify(payload));
  }
  const row = await env.DB.prepare("SELECT display_name, handle, visibility FROM users").first();
  eq("and none of the refusals changed the row", row.handle, "tp-profile");
  /* The only write in the table above that was accepted was the 80-character
     name, capped from the left: everything the refusals wanted to change is
     still what the last good edit left. */
  eq("nor its display name", row.display_name, "x".repeat(48));
  eq("nor its visibility", row.visibility, "public");
}

section("[handles are unique, case aside; profiles have a public face]");
{
  await seedUser("other-1", "ada", "public");
  await seedUser("other-2", "quiet-one", "private");

  const taken = await putProfile({ handle: "ADA" });
  eq("a handle somebody else has is refused", taken.status, 409);
  eq("and says which", (await taken.clone().json()).fields[0].error, "that handle is taken");

  const mine = await jsonOf(await call("/api/profile/ada"));
  eq("another account's public profile is readable", mine.ok, true);
  eq("by handle", mine.profile.handle, "ada");
  const keys = Object.keys(mine.profile);
  check("and carries no account data", keys.indexOf("email") === -1 && keys.indexOf("sub") === -1 &&
    keys.indexOf("googlePicture") === -1 && keys.indexOf("googleName") === -1, keys.join(","));
  /* The owner's own view of a private profile is the next section's business —
     this one is signed in as the wrong person to see quiet-one at all. */
  eq("a private profile is refused to everybody else",
    (await call("/api/profile/quiet-one", { noCookies: true, absorb: false })).status, 403);
  eq("a handle that does not exist is a 404", (await call("/api/profile/nobody-here", { absorb: false })).status, 404);

  const list = await jsonOf(await call("/api/profiles"));
  const handles = (list.profiles || []).map((p) => p.handle);
  check("the directory lists public profiles", handles.indexOf("ada") !== -1, JSON.stringify(handles));
  check("and not private ones", handles.indexOf("quiet-one") === -1, JSON.stringify(handles));
  eq("and not more than asked for", (await jsonOf(await call("/api/profiles?limit=1"))).profiles.length, 1);

  await putProfile({ visibility: "private" });
  eq("going private hides you from the directory",
    (await jsonOf(await call("/api/profiles"))).profiles.map((p) => p.handle).indexOf("tp-profile"), -1);
  eq("and from strangers", (await call("/api/profile/tp-profile", { noCookies: true, absorb: false })).status, 403);
  eq("while you still see yourself", (await jsonOf(await call("/api/profile/tp-profile"))).me, true);
  await putProfile({ visibility: "public" });
  eq("and public again is readable by anyone", (await call("/api/profile/tp-profile", { noCookies: true, absorb: false })).status, 200);
}

section("[methods, origins, and a deployment with no database]");
{
  eq("POST to a profile is not a thing", (await call("/api/profile", { method: "POST", absorb: false })).status, 405);
  eq("nor DELETE", (await call("/api/profile", { method: "DELETE", absorb: false })).status, 405);
  eq("nor POST to the directory", (await call("/api/profiles", { method: "POST", absorb: false })).status, 405);
  eq("a PUT from a foreign origin is refused", (await putProfile({ bio: "x" }, { origin: EVIL_ORIGIN, absorb: false })).status, 403);
  eq("a signed-out look is 401", (await call("/api/profile", { noCookies: true, absorb: false })).status, 401);
  eq("a signed-out edit is 401", (await putProfile({ bio: "x" }, { noCookies: true, absorb: false })).status, 401);

  const noDb = Object.assign({}, env, { DB: undefined });
  const res = await worker.fetch(new Request(WORKER_ORIGIN + "/api/profile", {
    headers: { origin: SITE_ORIGIN, cookie: jar.header() }
  }), noDb);
  eq("a deployment with no database says so", res.status, 503);
  eq("and names it", (await res.json()).error, "no database bound");
  const health = await worker.fetch(new Request(WORKER_ORIGIN + "/api/health", {}), noDb);
  eq("health agrees", (await health.json()).hasDatabase, false);
  const withDb = await jsonOf(await call("/api/health"));
  eq("and reports the database when it is bound", withDb.hasDatabase, true);
}

section("sign-out");
{
  const csrf = await jsonOf(await call("/api/auth/csrf"));
  const res = await call("/api/auth/signout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-auth-return-redirect": "1" },
    body: new URLSearchParams({ csrfToken: csrf.csrfToken }).toString()
  });
  check("sign-out answers", [200, 302, 303].includes(res.status), "status " + res.status);
  const cleared = cookieNamed(res, "__Secure-authjs.session-token");
  check("the session cookie is cleared", !!cleared && /max-age=0/i.test(cleared), cleared);

  const after = await jsonOf(await call("/api/auth/session"));
  check("and the session is gone", !after || !after.user, JSON.stringify(after));
  const identity = await call("/api/identity", { absorb: false });
  eq("the identity endpoint agrees", identity.status, 401);
}

section("a deployment missing its secrets fails loudly, not silently");
{
  const bare = Object.assign({}, env, { AUTH_SECRET: undefined });
  const res = await worker.fetch(new Request(WORKER_ORIGIN + "/api/auth/session", {
    headers: { origin: SITE_ORIGIN }
  }), bare);
  eq("without AUTH_SECRET the auth routes answer 503", res.status, 503);
  const body = await res.json();
  check("and name the missing variable", /AUTH_SECRET/.test(String(body && body.error)), JSON.stringify(body));

  const short = Object.assign({}, env, { AUTH_SECRET: "too-short" });
  const shortRes = await worker.fetch(new Request(WORKER_ORIGIN + "/api/auth/session", {}), short);
  eq("a too-short secret is refused too", shortRes.status, 503);

  /* Half-configured is its own state, and the page has to be able to tell
     it apart from "signed out": the sign-in routes refuse, the routes that
     never talk to Google keep working, and nothing renders a Google button
     that cannot work. */
  const noGoogle = Object.assign({}, env, { AUTH_GOOGLE_ID: undefined });
  const signinNoGoogle = await worker.fetch(new Request(WORKER_ORIGIN + "/api/auth/signin/google", {}), noGoogle);
  eq("missing Google credentials refuse the sign-in route", signinNoGoogle.status, 503);
  const providersNoGoogle = await worker.fetch(new Request(WORKER_ORIGIN + "/api/auth/providers", {}), noGoogle);
  eq("and the provider list, rather than rendering a dead button", providersNoGoogle.status, 503);
  const csrfNoGoogle = await worker.fetch(new Request(WORKER_ORIGIN + "/api/auth/csrf", {}), noGoogle);
  const csrfNoGoogleBody = await csrfNoGoogle.json();
  check("but csrf still answers, so the page can be told what is missing",
    csrfNoGoogle.status === 200 && !!csrfNoGoogleBody.csrfToken, "status " + csrfNoGoogle.status);
  const meNoGoogle = await worker.fetch(new Request(WORKER_ORIGIN + "/api/me", {}), noGoogle);
  eq("and who-am-I still answers", meNoGoogle.status, 200);

  const noIdentity = Object.assign({}, env, { IDENTITY_SECRET: undefined });
  const identityRes = await worker.fetch(new Request(WORKER_ORIGIN + "/api/identity", {}), noIdentity);
  eq("missing identity secret is refused with 503", identityRes.status, 503);
}

google.close();

console.log("\n" + pass + " passed, " + fail + " failed");
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
