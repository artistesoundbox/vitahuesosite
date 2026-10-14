/* ============================================================
   local-google.mjs — the two local stand-ins, in one place.

   Both the test suite (test.mjs) and the local browser bridge
   (dev-bridge.mjs) need the same two things, and neither is
   allowed to drift from the other: a D1-shaped database over
   node:sqlite, and a Google that is faked at the *network*, not
   in the library.

     - `d1Adapter()` gives the Worker the async surface D1 has
       (prepare/bind/first/all/run), so every line of SQL the
       deployment runs is the SQL this runs;
     - `createFakeGoogle()` answers the discovery, authorize,
       token, userinfo and JWKS endpoints and signs a genuine
       RS256 id_token with a key whose JWKS it publishes — Auth.js
       verifies a real signature and a real nonce instead of being
       handed a pre-baked profile. The discovery document keeps
       advertising Google's own hostnames; `install()` is what
       actually delivers those requests here, so the library's
       https enforcement is still in play.

   It is faked here rather than in the library because Google
   cannot be scripted and must not be called from a test or a dev
   loop. `actAs()` changes who the next sign-in is, which is how
   the bridge signs in as two different people to check that one
   account cannot see the other's rows.
   ============================================================ */
import http from "node:http";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/* ============================================================
   D1, over node:sqlite
   ============================================================ */

/* `file` persists across restarts (the bridge wants that); without it the
   database is in memory, which is what a test wants. `first()` answers null
   and not undefined for a miss, because that is what the profile module
   reads for. */
export function d1Adapter(options) {
  const settings = options || {};
  const db = new DatabaseSync(settings.file || ":memory:");
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
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

/* ============================================================
   Google
   ============================================================ */

const GOOGLE_HOSTS = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "openidconnect.googleapis.com"
]);

function formToObject(raw) {
  const out = {};
  for (const pair of String(raw || "").split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
  }
  return out;
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function createFakeGoogle(options) {
  const settings = options || {};
  const clientId = settings.clientId;
  const clientSecret = settings.clientSecret;
  const keyId = settings.keyId || "local-test-key-1";
  const issuer = "https://accounts.google.com";

  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });

  const codes = new Map();          // authorization code -> what it was issued against
  const accessTokens = new Set();
  /* The account the next sign-in will be. Mutated in place by actAs(), so a
     caller that captured the object before switching still sees the current
     values — a test asserting `PROFILE.sub` after signing in twice must not
     be reading a stale copy. */
  const profile = Object.assign({
    sub: "110000000000000000001",
    email: "player@example.com",
    email_verified: true,
    name: "Test Player",
    given_name: "Test",
    family_name: "Player",
    picture: "https://example.com/avatar.png",
    locale: "en"
  }, settings.profile || {});

  let authorizeSeen = null;
  let base = null;

  function idToken(nonce, nowSec) {
    const header = b64urlJson({ alg: "RS256", typ: "JWT", kid: keyId });
    const payload = b64urlJson(Object.assign({}, profile, {
      iss: issuer,
      aud: clientId,
      azp: clientId,
      iat: nowSec,
      exp: nowSec + 3600,
      nonce: nonce
    }));
    const signed = header + "." + payload;
    const sig = crypto.sign("sha256", Buffer.from(signed), privateKey).toString("base64url");
    return signed + "." + sig;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, headers, body) => {
      res.writeHead(status, Object.assign({ "content-type": "application/json" }, headers || {}));
      res.end(body === undefined ? "" : body);
    };

    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {}, JSON.stringify({
        issuer: issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        userinfo_endpoint: issuer + "/userinfo",
        jwks_uri: issuer + "/jwks",
        scopes_supported: ["openid", "email", "profile"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]
      }));
    }

    if (url.pathname === "/jwks") {
      return send(200, {}, JSON.stringify({
        keys: [{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid: keyId }]
      }));
    }

    if (url.pathname === "/authorize") {
      authorizeSeen = Object.fromEntries(url.searchParams.entries());
      if (authorizeSeen.client_id !== clientId) return send(400, {}, JSON.stringify({ error: "invalid_client" }));
      if (authorizeSeen.code_challenge_method !== "S256" || !authorizeSeen.code_challenge) {
        return send(400, {}, JSON.stringify({ error: "invalid_request", detail: "PKCE required" }));
      }
      const code = "code-" + crypto.randomBytes(6).toString("hex");
      codes.set(code, {
        challenge: authorizeSeen.code_challenge,
        redirect_uri: authorizeSeen.redirect_uri,
        nonce: authorizeSeen.nonce,
        client_id: authorizeSeen.client_id
      });
      const target = new URL(authorizeSeen.redirect_uri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", authorizeSeen.state || "");
      return send(302, { location: target.toString() }, "");
    }

    if (url.pathname === "/token") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const form = formToObject(body);
        let gotId = form.client_id;
        let gotSecret = form.client_secret;
        const basic = req.headers.authorization || "";
        if (basic.toLowerCase().startsWith("basic ")) {
          const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
          const i = decoded.indexOf(":");
          gotId = decodeURIComponent(decoded.slice(0, i));
          gotSecret = decodeURIComponent(decoded.slice(i + 1));
        }
        if (gotId !== clientId || gotSecret !== clientSecret) {
          return send(401, {}, JSON.stringify({ error: "invalid_client" }));
        }
        const record = codes.get(form.code);
        if (!record) return send(400, {}, JSON.stringify({ error: "invalid_grant" }));
        if (form.redirect_uri !== record.redirect_uri) {
          return send(400, {}, JSON.stringify({ error: "invalid_grant", detail: "redirect_uri mismatch" }));
        }
        const derived = crypto.createHash("sha256").update(String(form.code_verifier || "")).digest("base64url");
        if (derived !== record.challenge) {
          return send(400, {}, JSON.stringify({ error: "invalid_grant", detail: "code_verifier" }));
        }
        codes.delete(form.code);                       // single use, as Google does
        const token = "at-" + crypto.randomBytes(8).toString("hex");
        accessTokens.add(token);
        const now = Math.floor(Date.now() / 1000);
        return send(200, {}, JSON.stringify({
          access_token: token,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
          id_token: idToken(record.nonce, now)
        }));
      });
      return;
    }

    if (url.pathname === "/userinfo") {
      const bearer = (req.headers.authorization || "").replace(/^Bearer /i, "");
      if (!accessTokens.has(bearer)) return send(401, {}, JSON.stringify({ error: "invalid_token" }));
      return send(200, {}, JSON.stringify(profile));
    }

    return send(404, {}, JSON.stringify({ error: "not_found", path: url.pathname }));
  });

  return {
    profile: profile,
    /* Who the next sign-in is. Keeps the object identity, so callers holding
       a reference see the change rather than a stale account. */
    actAs: function (patch) {
      Object.assign(profile, patch || {});
      return profile;
    },
    get authorizeSeen() { return authorizeSeen; },
    get accessTokens() { return accessTokens; },
    get base() { return base; },
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = "http://127.0.0.1:" + server.address().port;
      return base;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    /* Outbound calls to any Google host land on this server instead, with the
       method, headers, body and redirect mode carried across — the token
       exchange is a POST with a body, and losing it here would make a test
       pass on a flow that cannot work. */
    install() {
      if (!base) throw new Error("install() after start() — the server has no address yet");
      const realFetch = globalThis.fetch;
      globalThis.fetch = function (input, init) {
        const raw = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
        const parsed = new URL(raw);
        if (!GOOGLE_HOSTS.has(parsed.host)) return realFetch(input, init);
        const rewritten = base + parsed.pathname + parsed.search;
        if (typeof input === "string" || input instanceof URL) return realFetch(rewritten, init);
        return realFetch(new Request(rewritten, input));
      };
      return function uninstall() { globalThis.fetch = realFetch; };
    }
  };
}
