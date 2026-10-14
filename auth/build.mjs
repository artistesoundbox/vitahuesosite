/* Bundles src/worker.src.js into worker.js — the single ES module that is
   actually deployed.

   WHY A BUILD STEP AT ALL
   Every other server-side file in this repo is dependency-free on purpose
   (leaderboard/worker.js says so in its own header). This one cannot be:
   Auth.js is not a file you can copy, and a Worker cannot resolve
   "node_modules" at runtime — whatever it imports has to be inside the
   module Sites uploads. So the dependency is inlined here, once, and the
   deployed artifact is a plain module with no imports.

   WHAT THIS REFUSES TO EMIT
   The bundle is checked before it is written into the tree: no `node:`
   imports, no require(), and a default export carrying a fetch handler.
   All three are the difference between a Worker that installs and one
   that fails on the first request — or worse, on the one request a day
   that actually signs somebody in. A bundle that fails this check is not
   written at all, so a broken build cannot quietly ship over a good one.
*/
import { build } from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, "worker.js");
const sourceFile = path.join(here, "src", "worker.src.js");

/* The source's digest travels inside the bundle so test.mjs can tell a
   bundle built from this source from one built from an older version of
   it — without esbuild, which CI does not install. A committed build
   artifact that nobody can check is a file that drifts. */
const sourceSha = crypto.createHash("sha256").update(fs.readFileSync(sourceFile)).digest("hex");

const banner = [
  "/* ============================================================",
  "   GENERATED FILE — do not edit. Built from src/worker.src.js by",
  "   `node build.mjs`, which inlines @auth/core so the Worker needs no",
  "   registry at runtime. Edit the source, rebuild, redeploy worker.js.",
  "  ",
  "   source-sha256: " + sourceSha,
  "   ============================================================ */"
].join("\n");

await build({
  entryPoints: [sourceFile],
  outfile: outfile,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  charset: "utf8",
  legalComments: "inline",
  /* Which build of each dependency gets inlined. @panva/hkdf (pulled in by
     Auth.js to stretch AUTH_SECRET into a key) publishes a `workerd` build
     that uses WebCrypto and a node build that imports `crypto` — without
     these conditions esbuild picks the node one and the bundle does not
     load in a Worker at all. workerd/worker are the honest conditions;
     browser is there because the rest of the tree (jose, oauth4webapi,
     preact) only distinguishes browser from node. */
  conditions: ["workerd", "worker", "browser", "import", "default"],
  banner: { js: banner },
  logLevel: "warning"
});

const code = fs.readFileSync(outfile, "utf8");
const problems = [];
for (const match of code.matchAll(/\bfrom\s*["'](node:[^"']+)["']/g)) {
  problems.push("node built-in import: " + match[1]);
}
if (/\brequire\s*\(/.test(code)) problems.push("a require() call survived bundling");
/* The handler itself is checked by loading the module and looking at it,
   not by pattern-matching the text: a regex cannot tell a real handler from
   the word `fetch` inside a comment, and this is the one property the
   Worker runtime will refuse to start without. */
let mod = null;
if (!problems.length) {
  try {
    mod = await import("file://" + outfile.split(path.sep).join("/") + "?b=" + Date.now());
  } catch (err) {
    problems.push("the bundle does not load: " + String((err && err.message) || err));
  }
}
if (mod && !(mod.default && typeof mod.default.fetch === "function")) {
  problems.push("no default export with a fetch handler — the Worker has no entry point");
}

if (problems.length) {
  fs.rmSync(outfile, { force: true });
  console.error("build refused to emit worker.js:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

const kb = (fs.statSync(outfile).size / 1024).toFixed(1);
console.log("worker.js written: " + kb + " KB, no imports, fetch handler present, source " + sourceSha.slice(0, 12));
