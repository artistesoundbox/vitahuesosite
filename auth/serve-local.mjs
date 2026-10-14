/* ============================================================
   Run the built Worker on 127.0.0.1, so the sign-in page can be used
   against it in a browser.

     node auth/serve-local.mjs [port]        # default 8178

   A Worker cannot be started with `node worker.js` — its handler expects a
   Request and returns a Response, and nothing here listens. This is the
   smallest thing that turns the bundle into that: a local server that hands
   each request to `worker.fetch` exactly as the edge would, with the same
   env. It is the same artifact that gets deployed, not a stand-in, which is
   the point: the cookie attributes, the CORS headers and the callback URL
   are the ones production will use.

   TWO THINGS ARE DIFFERENT LOCALLY, ON PURPOSE
   The origin is http, so Auth.js drops the __Secure- / __Host- prefixes and
   the callback URL is http://127.0.0.1:8178/api/auth/callback/google — that
   is the value to register in Google Cloud for local work (Google accepts
   http for a loopback redirect). And with no AUTH_SECRET in the environment
   one is generated for the session, which signs everybody out on restart;
   the deployment refuses to run without a real one, so that convenience
   exists only here, and is announced.

   For the whole flow you also need the site itself: `node brokenboot/serve.mjs`
   serves the checkout at http://127.0.0.1:8177, and the sign-in page reaches
   this bridge with ?api=http://127.0.0.1:8178 (the override in signin.js only
   accepts loopback addresses).
   ============================================================ */
import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.argv[2] || 8178);
const host = "127.0.0.1";

let AUTH_SECRET = process.env.AUTH_SECRET;
let generated = false;
if (!AUTH_SECRET) {
  AUTH_SECRET = crypto.randomBytes(32).toString("base64url");
  generated = true;
}

const env = {
  AUTH_SECRET: AUTH_SECRET,
  AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
  AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
  IDENTITY_SECRET: process.env.IDENTITY_SECRET,
  /* The local site by default; add the Pages origin when testing a preview. */
  SITE_ORIGINS: process.env.SITE_ORIGINS || "http://127.0.0.1:8177,http://localhost:8177"
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
    /* Headers are copied one at a time, and set-cookie as an array: Node
       writes an array as one header per value, where a single folded string
       would merge cookies browsers then refuse. */
    const headers = {};
    for (const [k, v] of response.headers) {
      if (k.toLowerCase() !== "set-cookie") headers[k] = v;
    }
    const cookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
    if (cookies.length) headers["set-cookie"] = cookies;
    const buffer = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, headers);
    res.end(buffer);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("local bridge error: " + String((err && err.message) || err));
  }
});

server.listen(port, host, () => {
  console.log("auth Worker (local bridge): http://" + host + ":" + port);
  console.log("  callback URL for Google Cloud: http://" + host + ":" + port + "/api/auth/callback/google");
  console.log("  AUTH_GOOGLE_ID:     " + (env.AUTH_GOOGLE_ID ? "set" : "MISSING — sign-in will answer 503"));
  console.log("  AUTH_GOOGLE_SECRET: " + (env.AUTH_GOOGLE_SECRET ? "set" : "MISSING — sign-in will answer 503"));
  console.log("  IDENTITY_SECRET:    " + (env.IDENTITY_SECRET ? "set" : "MISSING — /api/identity will answer 503"));
  console.log("  AUTH_SECRET:        " + (generated ? "generated for this run (restart = signed out)" : "from the environment"));
  console.log("  SITE_ORIGINS:       " + env.SITE_ORIGINS);
});
