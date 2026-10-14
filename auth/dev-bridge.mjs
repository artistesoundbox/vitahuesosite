/* ============================================================
   dev-bridge.mjs — the deployed Worker, on 127.0.0.1, with a
   real database and a Google that does not exist.

     node auth/dev-bridge.mjs [port]        # default 8178
     node brokenboot/serve.mjs              # the site, on 8177 (other shell)
     → http://127.0.0.1:8177/auth/portal.html?api=http://127.0.0.1:8178

   WHY THIS EXISTS
   The profile module is stored in D1 and reached only through the Worker, so
   "does the editor actually save" is a question no amount of reading can
   answer: it needs a browser, a session and a database. This gives all three
   locally. It is also the only place a session can be minted without a real
   Google account — `Google` here is local-google.mjs, the same fake the test
   suite uses, so it signs a genuine RS256 id_token that @auth/core verifies
   through the JWKS it publishes. Nothing in the Worker is stubbed.

   WHAT IT IS NOT
   Not a deployment, and not workerd: the SQLite is node:sqlite behind a
   D1-shaped surface and the host is a plain http server. It cannot tell you
   anything about edge cold starts, real D1 limits or Cloudflare's cookie
   handling. The deployed Worker stays the authority; this is where the pages
   get driven.

   SWITCHING ACCOUNTS
   `GET /__dev/act-as?sub=...&name=...&email=...&picture=...` changes who the
   next sign-in is (handled here, never by the Worker). Sign out and sign in
   again as the new account. Two accounts are how the per-user isolation gets
   checked: one account must not be able to see the other's rows.
   ============================================================ */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { d1Adapter, createFakeGoogle } from "./local-google.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8178);
const host = "127.0.0.1";
const dbFile = process.env.AUTH_DEV_DB || path.join(here, ".local-auth.sqlite");
const reset = process.argv.indexOf("--reset") !== -1;

const GOOGLE_ID = "local-dev.apps.googleusercontent.com";
const GOOGLE_SECRET = "local-dev-google-client-secret";
/* Fixed, so a restart does not sign you out. A deployment generates a real
   one; this value is deliberately recognizable as not one. */
const AUTH_SECRET = "local-dev-auth-secret-not-a-real-one-0123456789";

if (reset && fs.existsSync(dbFile)) fs.rmSync(dbFile);

const google = createFakeGoogle({ clientId: GOOGLE_ID, clientSecret: GOOGLE_SECRET });
await google.start();
/* Before the bundle is imported: nothing that captured a fetch at import time
   can then slip past the redirect. */
google.install();

const env = {
  AUTH_SECRET: AUTH_SECRET,
  AUTH_GOOGLE_ID: GOOGLE_ID,
  AUTH_GOOGLE_SECRET: GOOGLE_SECRET,
  IDENTITY_SECRET: process.env.IDENTITY_SECRET || "local-dev-identity-secret",
  /* Which fake account is the admin, so the admin paths can be exercised
     locally at all: `ADMIN_EMAILS=user-ev-2@example.com node dev-bridge.mjs`
     makes whoever /__dev/act-as gave sub dev-2 the admin. */
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || "",
  SITE_ORIGINS: process.env.SITE_ORIGINS || "http://127.0.0.1:8177,http://localhost:8177",
  DB: d1Adapter({ file: dbFile })
};

const worker = (await import("./worker.js")).default;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/* Who the next sign-in will be. A route here rather than in the Worker: it is
   a property of the fake, and the deployed Worker must not have it. */
function actAs(url) {
  const patch = {};
  for (const key of ["sub", "name", "email", "picture", "given_name", "family_name"]) {
    const value = url.searchParams.get(key);
    if (value) patch[key] = value;
  }
  if (patch.sub && !patch.email) patch.email = "user-" + patch.sub.slice(-4) + "@example.com";
  if (!patch.picture) patch.picture = "https://example.com/avatar-" + (patch.sub || "x").slice(-4) + ".png";
  if (!patch.name) patch.name = "Player " + String(patch.sub || "").slice(-4);
  if (!patch.given_name) patch.given_name = String(patch.name).split(" ")[0];
  google.actAs(patch);
  return google.profile;
}

/* The sign-in POST answers `{ url: "https://accounts.google.com/authorize…" }`
   and the *browser* is sent there. Patching globalThis.fetch cannot reach a
   browser navigation, so the one URL the page is told to visit is rewritten
   to the local fake instead. Only that JSON field is touched: every other
   Google call in the flow is a server-side fetch, and those are already
   redirected by google.install(). */
async function rewriteGoogleLinks(response, buffer) {
  const type = response.headers.get("content-type") || "";
  if (type.indexOf("application/json") === -1 || !buffer.length) return buffer;
  let body;
  try {
    body = JSON.parse(buffer.toString("utf8"));
  } catch (err) {
    return buffer;
  }
  if (!body || typeof body.url !== "string") return buffer;
  let target;
  try {
    target = new URL(body.url);
  } catch (err) {
    return buffer;
  }
  if (target.host !== "accounts.google.com") return buffer;
  const rewritten = google.base + target.pathname + target.search;
  console.log("  (dev) authorize → " + rewritten.slice(0, 96) + "…");
  return Buffer.from(JSON.stringify(Object.assign({}, body, { url: rewritten })));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + host + ":" + port);
  try {
    /* The dev routes answer the site's own origin so a page (or the console on
       one) can switch accounts without a round trip through a navigation. */
    const devHeaders = { "content-type": "application/json", "access-control-allow-origin": "*" };
    if (url.pathname === "/__dev/act-as") {
      const now = actAs(url);
      res.writeHead(200, devHeaders);
      res.end(JSON.stringify({ ok: true, next: now }, null, 2));
      return;
    }
    if (url.pathname === "/__dev/who") {
      res.writeHead(200, devHeaders);
      res.end(JSON.stringify({ ok: true, next: google.profile }, null, 2));
      return;
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const request = new Request("http://" + host + ":" + port + req.url, {
      method: req.method,
      headers: req.headers,
      body: body,
      redirect: "manual"
    });
    const response = await worker.fetch(request, env);
    /* set-cookie as an array: Node writes an array as one header per value,
       where a single folded string would merge cookies browsers then refuse. */
    const headers = {};
    for (const [k, v] of response.headers) {
      if (k.toLowerCase() !== "set-cookie") headers[k] = v;
    }
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (cookies.length) headers["set-cookie"] = cookies;
    const buffer = await rewriteGoogleLinks(response, Buffer.from(await response.arrayBuffer()));
    res.writeHead(response.status, headers);
    res.end(buffer);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("dev bridge error: " + String((err && err.message) || err));
  }
});

server.listen(port, host, () => {
  console.log("auth dev bridge:    http://" + host + ":" + port);
  console.log("  Worker:           the built bundle (worker.js), real @auth/core, real SQL");
  console.log("  database:         " + dbFile + (reset ? "  (reset)" : ""));
  console.log("  Google:           faked locally, signs real RS256 id_tokens");
  console.log("  callback URL:     http://" + host + ":" + port + "/api/auth/callback/google");
  console.log("  SITE_ORIGINS:     " + env.SITE_ORIGINS);
  console.log("  ADMIN_EMAILS:     " + (env.ADMIN_EMAILS || "(nobody is an admin)"));
  console.log("  sign in as:       http://" + host + ":" + port + "/__dev/act-as?sub=dev-1&name=Ada%20Lovelace");
  console.log("  not a deployment: node:sqlite and a plain http server, not workerd");
});
