/* ============================================================
   test-verify-deploy.mjs — does the deploy guard actually refuse?
   node auth/test-verify-deploy.mjs

   WHY THIS EXISTS
   verify-deploy.mjs is the step that decides a deploy is finished, so a
   version of it that always passes is worse than not having it: an
   unconfigured Worker would ship and the first sign of it would be a player
   clicking "Sign in with Google". A guard that cannot fail cannot guard, so
   this drives it against the real bundle — worker.js, the artifact that gets
   deployed — in a deployment state that is missing exactly one thing at a
   time, and requires the guard to exit non-zero and NAME that thing.

   HOW IT IS DRIVEN
   worker.fetch is handed a chosen env, so "a deployment with no
   IDENTITY_SECRET" is a real one and not a mock: the same code path the edge
   runs produces the same 503 the browser would see. The guard is then run as
   a child process, and its exit code and its words are the assertions —
   importing it and checking a returned object would not prove the thing that
   actually gates a deploy.

   NOT COVERED: a real Cloudflare deployment (this is a local server with the
   deployed bundle, so the bindings are an env object), and whether Google
   Cloud has the callback URL registered — the guard prints it rather than
   checking it, and only the console knows.

   exits 1 if any check fails.
   ============================================================ */
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { d1Adapter } from "./local-google.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, "verify-deploy.mjs");
const HOST = "127.0.0.1";

/* The site origin the pages will really call from, and the one the guard is
   told to expect. A loopback origin because the server under test is one. */
const SITE_ORIGIN = "http://127.0.0.1:8177";

const worker = (await import("./worker.js")).default;

/* A complete deployment: every required variable bound. Cases take from this
   rather than building one up, so "missing X" cannot accidentally mean
   "missing X and something else". */
function completeEnv() {
  return {
    AUTH_SECRET: "local-test-auth-secret-not-a-real-one",
    AUTH_GOOGLE_ID: "1234567890-local.apps.googleusercontent.com",
    AUTH_GOOGLE_SECRET: "local-test-google-client-secret",
    IDENTITY_SECRET: "local-test-identity-secret",
    SITE_ORIGINS: SITE_ORIGIN,
    DB: d1Adapter()
  };
}

/* The deployed bundle behind a plain http server, with the env it is handed —
   the same plumbing serve-local.mjs uses, so what is served is the artifact. */
function serve(env) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request("http://" + HOST + ":" + server.address().port + req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
        redirect: "manual"
      });
      const response = await worker.fetch(request, env);
      const headers = {};
      for (const [k, v] of response.headers) {
        if (k.toLowerCase() !== "set-cookie") headers[k] = v;
      }
      const cookies = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie() : [];
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("harness error: " + String((err && err.message) || err));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, HOST, () => resolve({
      server,
      url: "http://" + HOST + ":" + server.address().port
    }));
  });
}

/* Run the guard exactly as a deployer would, and keep both halves of the
   verdict: the exit code (what a pipeline reads) and the words (what a person
   reads). */
function runGuard(args) {
  const out = spawnSync(process.execPath, [GUARD].concat(args), { encoding: "utf8" });
  return { status: out.status, text: (out.stdout || "") + (out.stderr || "") };
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "\n          " + detail));
  if (!ok) failures++;
}

/* One case: serve this env, point the guard at it, assert the verdict.
   `expect` is the exit code; `names` are strings the output must contain. */
async function refusalCase(name, env, expect, names, extraArgs) {
  const { server, url } = await serve(env);
  try {
    const run = runGuard([url, "--origin=" + SITE_ORIGIN].concat(extraArgs || []));
    const named = (names || []).filter((s) => run.text.indexOf(s) === -1);
    const ok = run.status === expect && named.length === 0;
    check(name + "  (exit " + expect + ")",
      ok,
      "exit " + run.status + " (wanted " + expect + ")" +
      (named.length ? ", and it never said: " + named.join(", ") : "") +
      "\n          --- output ---\n" + run.text.split("\n").slice(-14).join("\n"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ------------------------------------------------------- the happy path */

console.log("-- a fully configured deployment is the only thing that passes");
{
  const { server, url } = await serve(completeEnv());
  try {
    const run = runGuard([url, "--origin=" + SITE_ORIGIN]);
    check("a complete deployment exits 0", run.status === 0, "exit " + run.status + "\n" + run.text);
    check("and says READY", run.text.indexOf("READY") !== -1, run.text.split("\n").slice(-12).join("\n"));
    check("and prints the callback URL Google needs",
      run.text.indexOf("/api/auth/callback/google") !== -1, run.text.split("\n").slice(-12).join("\n"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ------------------------------------------------- each required, missing */

console.log("\n-- every required variable, removed one at a time");
await (async () => {
  const cases = [
    ["no AUTH_GOOGLE_ID", "AUTH_GOOGLE_ID", ["AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET"]],
    ["no AUTH_GOOGLE_SECRET", "AUTH_GOOGLE_SECRET", ["AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET"]],
    ["no AUTH_SECRET", "AUTH_SECRET", ["AUTH_SECRET"]],
    ["no IDENTITY_SECRET", "IDENTITY_SECRET", ["IDENTITY_SECRET"]],
    ["no database binding", "DB", ["DB"]]
  ];
  for (const [name, drop, names] of cases) {
    const env = completeEnv();
    delete env[drop];
    await refusalCase(name, env, 1, names);
  }
  /* A short secret is the Worker's own rule (MIN_SECRET), and the guard has to
     inherit it rather than keep its own idea of "set". */
  const short = completeEnv();
  short.AUTH_SECRET = "a".repeat(31);
  await refusalCase("AUTH_SECRET one character too short", short, 1, ["AUTH_SECRET"]);
})();

/* ------------------------------------------------------------ the origin */

console.log("\n-- SITE_ORIGINS: the one failure the Worker cannot report as a 503");
await refusalCase("an origin that is not on the list",
  Object.assign(completeEnv(), { SITE_ORIGINS: "https://somebody-else.example" }), 1, ["SITE_ORIGINS"]);
await refusalCase("an empty origin list",
  Object.assign(completeEnv(), { SITE_ORIGINS: "" }), 1, ["SITE_ORIGINS"]);

/* --------------------------------------------------------- not a failure */

console.log("\n-- absence that is not a failure");
await refusalCase("ADMIN_EMAILS unset (nobody is an admin: the documented default)",
  completeEnv(), 0, ["READY"]);

/* -------------------------------------------------------- usage/unknown */

console.log("\n-- the exit codes that are not a verdict on the configuration");
{
  const usage = runGuard([]);
  check("no URL is usage, exit 2", usage.status === 2, "exit " + usage.status + "\n" + usage.text);
  check("and says how to run it", usage.text.indexOf("usage:") !== -1, usage.text);
}
{
  /* A port that was listening and is not any more: as close to "the deploy has
     not landed" as this can get without the network. */
  const { server, url } = await serve(completeEnv());
  await new Promise((resolve) => server.close(resolve));
  const run = runGuard([url, "--origin=" + SITE_ORIGIN]);
  check("an unreachable Worker is exit 2, not a configuration verdict",
    run.status === 2, "exit " + run.status + "\n" + run.text);
  check("and says so without blaming a variable",
    run.text.indexOf("UNREACHABLE") !== -1, run.text.split("\n").slice(-6).join("\n"));
}

console.log("\n" + "=".repeat(58));
console.log(failures ? failures + " check(s) FAILED" : "the deploy guard refuses what it must, and passes what is complete");
process.exit(failures ? 1 : 0);
