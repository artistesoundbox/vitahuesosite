/* ============================================================
   leaderboard/dev-bridge.mjs — the leaderboard Worker on 127.0.0.1,
   with a real database, so a page can be driven against it.

     node leaderboard/dev-bridge.mjs [port]        # default 8179
     node auth/dev-bridge.mjs 8178                 # the sign-in Worker (other shell)
     → http://127.0.0.1:8177/racegame.html?daily=1&api=http://127.0.0.1:8178&board=http://127.0.0.1:8179

   WHY THIS EXISTS
   The board is the other end of the sign-in: a run carries a token the auth
   Worker signed, and this Worker verifies it with the shared secret before it
   will believe the name and the picture. Both halves have to run at once for
   that to be testable at all — and it is the only way to watch a real signed
   token become a row with an avatar on it, since the deployed pair needs a
   Google account and a secret nobody can read back.

   IDENTITY_SECRET defaults to the same local value auth/dev-bridge.mjs uses,
   which is the point: the two are a pair, and a mismatch is exactly what the
   401 path exists for.

   WHAT IT IS NOT
   Not a deployment and not workerd: node:sqlite behind a D1-shaped shim, a
   plain http server, and the same worker.js the site deploys. It cannot tell
   you anything about D1 limits, cold starts or Cloudflare's cache.
   ============================================================ */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* The D1 shim lives with the sign-in bridge: both are the same fake of the
   same product, and a second copy is a second thing to drift. Dev-only import
   — nothing here is ever deployed. */
import { d1Adapter } from "../auth/local-google.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8179);
const host = "127.0.0.1";
const dbFile = process.env.BOARD_DEV_DB || path.join(here, ".local-board.sqlite");
if (process.argv.indexOf("--reset") !== -1 && fs.existsSync(dbFile)) fs.rmSync(dbFile);

const env = {
  DB: d1Adapter({ file: dbFile }),
  /* The same value auth/dev-bridge.mjs runs with, unless one is given: the
     pair is the whole point. */
  IDENTITY_SECRET: process.env.IDENTITY_SECRET || "local-dev-identity-secret"
};

const worker = (await import("./worker.js")).default;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = http.createServer(async (req, res) => {
  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const request = new Request("http://" + host + ":" + port + req.url, {
      method: req.method,
      headers: req.headers,
      body: body,
      redirect: "manual"
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("board dev bridge error: " + String((err && err.message) || err));
  }
});

server.listen(port, host, () => {
  console.log("board dev bridge:  http://" + host + ":" + port);
  console.log("  Worker:          the built bundle (worker.js), same file the site deploys");
  console.log("  database:        " + dbFile);
  console.log("  IDENTITY_SECRET: " + (env.IDENTITY_SECRET === "local-dev-identity-secret"
    ? "the same local value auth/dev-bridge.mjs uses"
    : "from the environment"));
  console.log("  not a deployment: node:sqlite and a plain http server, not workerd");
});
