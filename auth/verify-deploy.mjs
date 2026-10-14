/* ============================================================
   verify-deploy.mjs — is the DEPLOYED sign-in Worker actually usable?
   node auth/verify-deploy.mjs <worker-url> [--origin=<site-origin>]

   WHY THIS EXISTS
   Uploading the bundle and configuring the deployment are two different
   facts, and only the second one decides whether anybody can sign in. The
   Sites tools report the upload; nothing reports the configuration, so the
   first sign of trouble was a player clicking "Sign in with Google" and
   getting "AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are not both set" — after the
   deploy had already been called done. This is the missing step. It asks the
   deployment what it is configured with and refuses to pass until every
   REQUIRED variable is bound, naming the ones that are not.

   WHY IT ASKS THE DEPLOYMENT AND NOT THE DASHBOARD
   The secret values are never readable back, and a staged file is not the
   deployment. The running Worker is the only thing that knows both what it
   was given and what it does with it, so the verdict comes from its own
   answers. `hasGoogleCredentials: true` in /api/health and a sign-in route
   that starts are the same fact stated twice, and both are asserted: a health
   flag that has drifted from the route it describes is worse than no flag.

   IT CARRIES THE CSRF COOKIE, LIKE A BROWSER
   This is the difference between a smoke test and the thing a player does.
   Auth.js will not start a sign-in on a token alone: the token in the body
   has to match the one in the `authjs.csrf-token` cookie from the same
   response. `fetch` has no cookie jar, so the first version of this script
   was answered `?error=MissingCSRF` by a perfectly healthy deployment — the
   check would have failed deployments that work. The cookie is carried from
   the `/api/auth/csrf` response into the sign-in POST by hand, which is also
   the only reason this can run without a browser.

   READ-ONLY, AND NO GOOGLE ACCOUNT
   It starts the sign-in flow and reads the URL the Worker hands back without
   following it, so no consent screen is involved and no session is created
   (the flow cookies are dropped, not reused). Nothing is written: the
   profile routes are not touched.

   WHAT IS REQUIRED, AND WHAT BREAKS WITHOUT IT
     AUTH_SECRET          every /api/auth/* route is 503: nobody can sign in,
                          and a session could not be encrypted or verified
     AUTH_GOOGLE_ID       the signin, callback and providers routes are 503 —
     AUTH_GOOGLE_SECRET   both or neither, the Worker refuses either way
     IDENTITY_SECRET      /api/identity is 503, so the leaderboard cannot take
                          the player's name and falls back to a typed handle:
                          sign-in still works and the point of it does not
     DB (a D1 binding)    the profile routes are 503: no handle, no page
     SITE_ORIGINS         not a 503 at all. The Worker answers and the BROWSER
                          refuses the response, so it looks broken with
                          nothing in any log — which is why it is checked by
                          echoing an origin back rather than by a count

   NOT required: ADMIN_EMAILS. Empty means nobody is an admin, which is the
   documented safe default, so its absence is not a failure here.

   NOT COVERED: whether Google Cloud has this callback URL registered (it is
   printed so the two can be compared by eye), whether a real Google account
   can complete the consent screen, and whether the site's own page shipped
   with a matching signin.js. Those need a browser and an account.

   AGAINST THE LOCAL BRIDGE: expect one deliberate difference. dev-bridge.mjs
   rewrites the authorize URL to its own fake Google, so the Google-host check
   passes with a note instead of failing. Everything else is the same check.

   exit 0 = ready · 1 = not ready, each missing variable named · 2 = usage,
   or the Worker could not be reached (which says nothing about its config)
   ============================================================ */

const base = (process.argv[2] || '').replace(/\/+$/, '');

/* The site whose pages call this Worker. It is an origin, not a URL: the
   Worker matches it exactly, trailing slash aside. The default is the site
   this Worker was built for, and --origin exists so a second deployment (a
   preview, a fork) can be checked against the origin that will really be
   calling it. */
const argFor = (name) => {
  const equals = process.argv.find((a) => a.startsWith(name + "="));
  if (equals) return equals.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};
const siteOrigin = (argFor("--origin") || "https://artistesoundbox.github.io").replace(/\/+$/, "");

const usage = !base || base.startsWith("--");
if (usage) {
  console.log("usage: node auth/verify-deploy.mjs <worker-url> [--origin=https://artistesoundbox.github.io]");
  process.exitCode = 2;
}

/* The required set, as data, so the failure summary and the checks cannot
   drift apart: one place says which variable, and what it costs. */
const REQUIRED = [
  { flag: "hasAuthSecret", vars: "AUTH_SECRET",
    breaks: "every /api/auth/* route answers 503 — nobody can sign in or stay signed in" },
  { flag: "hasGoogleCredentials", vars: "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET",
    breaks: "the sign-in, callback and provider routes answer 503 — the Google button cannot start" },
  { flag: "hasIdentitySecret", vars: "IDENTITY_SECRET",
    breaks: "/api/identity answers 503 — the leaderboard cannot take the Google name and falls back to a typed handle" },
  { flag: "hasDatabase", vars: "DB (a D1 binding)",
    breaks: "the profile routes answer 503 — no handle and no profile page" }
];

let pass = 0, fail = 0;
const unbound = [];                 // the REQUIRED rows that came back unbound
const problems = [];                // human sentences for failures that are not a variable

function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    "got " + JSON.stringify(got) + " want " + JSON.stringify(want));
}
async function call(path, opts) {
  const options = Object.assign({ headers: { connection: "close" } }, opts || {});
  const res = await fetch(base + path, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* not json: the body is the detail */ }
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return { status: res.status, body: body, headers: res.headers, cookies: cookies };
}
/* Just the name=value pairs: attributes (Path, HttpOnly, SameSite…) belong to
   the browser's jar, not to the next request. */
const cookieHeader = (cookies) => cookies.map((c) => String(c).split(";")[0]).join("; ");
const short = (v, n) => JSON.stringify(v).slice(0, n || 160);

async function main() {
  console.log("\n[" + base + "]");
  console.log("site origin: " + siteOrigin);

  /* -------------------------------------------------------------- health */
  console.log("\n-- what the deployment says it was given");

  let health;
  try {
    health = await call("/api/health");
  } catch (err) {
    console.log("  ..   could not reach the Worker: " + String((err && err.message) || err));
    console.log("\nUNREACHABLE — that says nothing about its configuration, only that there is");
    console.log("nothing to check at this URL. The deploy may not have landed yet.");
    return 2;
  }

  eq("health 200", health.status, 200);
  check("health says ok", !!(health.body && health.body.ok), short(health.body));
  check("it is the Google sign-in Worker", !!(health.body && health.body.provider === "google"),
    short(health.body));
  eq("auth routes are mounted where the site calls them", health.body && health.body.basePath, "/api/auth");
  for (const row of REQUIRED) {
    const bound = !!(health.body && health.body[row.flag]);
    check(row.flag + "  [" + row.vars + "]", bound, bound ? undefined : row.breaks);
    if (!bound) unbound.push(row);
  }

  /* ---------------------------------------------------------------- cors */
  console.log("\n-- the site origin is allowed to call it with credentials");
  const originCount = health.body && health.body.siteOrigins;
  const anyOrigin = typeof originCount === "number" && originCount >= 1;
  check("SITE_ORIGINS is not empty", anyOrigin,
    "SITE_ORIGINS is empty — every browser response would be refused");
  if (!anyOrigin) {
    problems.push("SITE_ORIGINS is empty: the Worker answers, the browser refuses, nothing logs");
  }
  const pre = await call("/api/auth/csrf", { method: "OPTIONS", headers: { origin: siteOrigin, connection: "close" } });
  eq("preflight answers 204", pre.status, 204);
  const echoed = pre.headers.get("access-control-allow-origin");
  check("and echoes " + siteOrigin, echoed === siteOrigin,
    echoed === null
      ? siteOrigin + " is not in SITE_ORIGINS — the browser would refuse every response"
      : "got " + echoed);
  if (echoed !== siteOrigin) {
    problems.push("SITE_ORIGINS does not contain " + siteOrigin +
      ": the browser refuses the Worker's responses and nothing appears in the Worker's log");
  }
  eq("with credentials allowed", pre.headers.get("access-control-allow-credentials"), "true");

  /* ----------------------------------------------------------- providers */
  console.log("\n-- the routes a player actually uses");
  const providers = await call("/api/auth/providers", { headers: { origin: siteOrigin, connection: "close" } });
  eq("providers 200", providers.status, 200);
  /* Auth.js answers with a map keyed by provider id, and an error object when
     the credentials are missing — not the array its name suggests. Both
     shapes are read here so the check reports the truth either way. */
  const listed = providers.body;
  const google = Array.isArray(listed)
    ? (listed.filter((p) => p.id === "google")[0] || null)
    : ((listed && listed.google) || null);
  check("google is offered", !!google, short(providers.body));
  const callbackUrl = (google && google.callbackUrl) || null;
  check("its callback URL points at this deployment",
    !!callbackUrl && callbackUrl.indexOf("/api/auth/callback/google") !== -1, String(callbackUrl));

  /* --------------------------------------------------- the flow can start */
  console.log("\n-- the sign-in flow starts (the check that replaces finding out as a 503)");
  const csrf = await call("/api/auth/csrf", { headers: { origin: siteOrigin, connection: "close" } });
  eq("csrf 200", csrf.status, 200);
  const token = csrf.body && csrf.body.csrfToken;
  check("it handed out a CSRF token", !!token, short(csrf.body));

  if (!token) {
    console.log("  ..   not attempting the flow start: no CSRF token to send");
  } else {
    const start = await call("/api/auth/signin/google", {
      method: "POST",
      headers: {
        origin: siteOrigin,
        connection: "close",
        "content-type": "application/x-www-form-urlencoded",
        "x-auth-return-redirect": "1",
        /* The half of the CSRF check a browser supplies for free. */
        cookie: cookieHeader(csrf.cookies)
      },
      body: new URLSearchParams({ csrfToken: token, callbackUrl: siteOrigin }).toString()
    });
    eq("POST /api/auth/signin/google answers 200", start.status, 200);
    if (start.status !== 200) {
      /* The Worker's own sentence is the whole point of this script: it names
         the variable, so print it rather than a paraphrase. */
      console.log("       the Worker said: " + short(start.body, 200));
    }
    let authorize = null;
    try { authorize = new URL((start.body && start.body.url) || ""); } catch (e) { /* not a URL */ }
    /* One documented exception: the local dev bridge rewrites this URL to its
       own fake Google so a browser can be driven offline (dev-bridge.mjs). A
       loopback target can only be that, and failing a healthy harness is the
       same mistake as the CSRF cookie — so it passes, and says why. Anything
       that is neither Google nor loopback is still a failure. */
    if (!!authorize && authorize.host === "accounts.google.com") {
      check("it answers with a URL on accounts.google.com", true);
    } else if (!!authorize && ["127.0.0.1", "localhost", "::1", "[::1]"].indexOf(authorize.hostname) !== -1) {
      check("it answers with a URL on accounts.google.com", true);
      console.log("       (rewritten to " + authorize.origin + " — the local dev bridge, by design)");
    } else {
      check("it answers with a URL on accounts.google.com", false, short(start.body));
    }
    if (authorize) {
      check("carrying the client id", !!authorize.searchParams.get("client_id"), "no client_id in the URL");
      const redirect = authorize.searchParams.get("redirect_uri");
      /* Truthiness first: two missing values must not compare equal, which is
         how this passed once while nothing was configured. */
      check("redirecting back to this deployment's callback",
        !!redirect && redirect.indexOf("/api/auth/callback/google") !== -1 &&
        (!callbackUrl || redirect === callbackUrl),
        "redirect_uri " + redirect);
      check("with PKCE (the Worker adds it, Auth.js does not)",
        !!authorize.searchParams.get("code_challenge"), "no code_challenge in the URL");
    }
  }

  /* ------------------------------------------------------------- verdict */
  console.log("\n" + "=".repeat(58));
  console.log(pass + " passed, " + fail + " failed");

  if (fail) {
    console.log("\nNOT READY — do not call this deploy done.");
    if (unbound.length) {
      console.log("\nunbound, and what each one costs:");
      for (const row of unbound) console.log("  " + row.vars + "\n      " + row.breaks);
    }
    for (const sentence of problems) console.log("  " + sentence);
    console.log("\nSet them in Sites → Secrets for THIS environment, then run this again.");
    console.log("If the running Worker does not pick the change up, deploy once more — the");
    console.log("same script tells you either way, which is why it exists.");
    return 1;
  }

  console.log("\nREADY — " + pass + " checks passed, and the sign-in flow starts.");
  if (callbackUrl) {
    console.log("\nGoogle Cloud → Credentials → this OAuth client must have this exact");
    console.log("authorized redirect URI:");
    console.log("  " + callbackUrl);
    console.log("\nand this authorized JavaScript origin:");
    console.log("  " + siteOrigin);
  }
  return 0;
}

/* Set, never exit(): process.exit() while undici still holds a socket trips a
   libuv assertion on Windows — the guard would be caught exiting 0xC0000409
   instead of 1, and its own suite found exactly that. `connection: close` on
   every request is what lets the loop drain rather than wait out a pool.

   Called here, at the end, and not above: main() reads REQUIRED and the
   counters, and a top-level await before their `const` declarations is a
   temporal dead zone, not a subtle ordering preference. */
if (!usage) process.exitCode = await main();
