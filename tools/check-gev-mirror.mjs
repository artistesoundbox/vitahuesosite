/* ============================================================
   check-gev-mirror.mjs — did this workflow produce the demo that is there now?

     node tools/check-gev-mirror.mjs                  # verify (the guard)
     node tools/check-gev-mirror.mjs --accept [<sha>] # record this tree as the mirror's own

   WHY THIS EXISTS
   The sync mirrors `dist/` into gods-eye-view/ with `rsync --archive --delete`,
   which is a replace, not a merge: whatever is in the demo path and not in the
   build is deleted. That is right for build output and wrong for a demo that was
   put there by hand — and the live one was. It was built in a source checkout
   and copied over on 2026-10-08, because the work it is made of (the flying
   saucer sandbox, the Grand Central start view, the Godot level) is on no remote
   the workflow can build. A ref carrying a level but not that work would pass
   the workflow's existing guard and replace the demo with one that has the level
   and none of it.

   WHAT IT ASKS
   One question, answerable without knowing what any build contains: does the
   tree in gods-eye-view/ still match the state the last mirror left it in? The
   answer is a manifest — a path and a sha256 for every file — written by the
   mirror itself, outside the mirrored directory so `--delete` cannot remove it.
   If every file matches, a mirror is safe and runs. If anything was added,
   edited or removed since, the mirror is not safe: somebody put something there,
   and the tool names every file that is not what the mirror left.

   No manifest at all is its own answer, and the loud one. It means this path has
   never been produced by the mirror — which is the truth today — so the guard
   exits 2 and refuses, rather than treating an unknown tree as an empty one and
   deleting it. `--accept` is how a person says "this tree is the one to publish,
   treat it as the mirror's own from here": it is the deliberate act, and the
   only way past the guard.

   WHAT IT DOES NOT DO
   It does not fetch, build, or look at the incoming build: content that a hand
   build and a mirror build happen to share is indistinguishable, and pretending
   otherwise would be worse than saying so. It also does not write to the target
   directory — `--accept` writes the manifest and nothing else.
   ============================================================ */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/* Defaults are the site's own layout. Both are overridable so the suite can run
   the tool against a fixture without a repository. */
function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const TARGET = path.resolve(argValue("target", path.join(repoRoot, "gods-eye-view")));
const MANIFEST = path.resolve(argValue("manifest", path.join(repoRoot, ".gev-mirror.json")));
const accepting = process.argv.includes("--accept");
const acceptSha = (() => {
  const hit = process.argv.indexOf("--accept");
  if (hit === -1) return null;
  const next = process.argv[hit + 1];
  return next && !next.startsWith("--") ? next : null;
})();

/* Every file, relative, forward-slashed, so a manifest made on Windows and read
   on Linux (which is how this is used) describes the same paths. */
function walk(root) {
  const out = [];
  (function step(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) step(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  })(root);
  return out.sort();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function treeOf(root) {
  const files = {};
  for (const rel of walk(root)) files[rel] = sha256(path.join(root, rel));
  return files;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch (err) {
    return null;
  }
}

function writeManifest(files, sourceSha) {
  const sorted = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  const body = {
    note: "Written by tools/check-gev-mirror.mjs --accept. A path and sha256 for every file the mirror last published into gods-eye-view/. Do not edit by hand: the mirror refuses to run when the tree does not match this.",
    mirroredFrom: acceptSha || (readManifest() || {}).mirroredFrom || null,
    files: sorted
  };
  if (sourceSha) body.mirroredFrom = sourceSha;
  fs.writeFileSync(MANIFEST, JSON.stringify(body, null, 2) + "\n");
  return body;
}

if (!fs.existsSync(TARGET)) {
  console.error("no demo path to check: " + TARGET);
  process.exit(2);
}

const actual = treeOf(TARGET);

if (accepting) {
  const body = writeManifest(actual, acceptSha);
  console.log("recorded " + Object.keys(body.files).length + " files as the mirror's own in " + path.relative(repoRoot, MANIFEST));
  if (body.mirroredFrom) console.log("  built from: " + body.mirroredFrom);
  console.log("  a mirror may now run; any change to the demo path after this stops it again");
  /* Said every time, because it is the one thing --accept does not do. It
     records a tree; it does not save one, and the next mirror will replace
     this tree with the build of the ref. Recording the demo is only safe when
     that ref already builds the demo. */
  console.log("");
  console.log("  NOT a rescue: this records the tree, it does not put the work anywhere.");
  console.log("  The next mirror will still replace every recorded file with the ref's build.");
  console.log("  Re-record only when that ref already builds what you want published.");
  process.exit(0);
}

const manifest = readManifest();
if (!manifest || !manifest.files || typeof manifest.files !== "object") {
  console.error("REFUSING: " + path.relative(repoRoot, TARGET) + " was not produced by this workflow.");
  console.error("");
  console.error("  There is no " + path.relative(repoRoot, MANIFEST) + ", or it is unreadable, so nothing");
  console.error("  here says this path is build output. The live demo was published by hand (a build");
  console.error("  of a source checkout copied over this path), and mirroring a build over it would");
  console.error("  delete whatever that build does not contain — the flying saucer and the level included.");
  console.error("");
  console.error("  Two ways forward, both deliberate:");
  console.error("    1. get the demo's work onto a ref this workflow can build, point SOURCE_BRANCH at");
  console.error("       it, and re-run. The mirror then publishes that ref's build.");
  console.error("    2. if this path is what should be published, re-record it:");
  console.error("       node tools/check-gev-mirror.mjs --accept <source-sha>");
  process.exit(2);
}

const added = Object.keys(actual).filter((f) => !(f in manifest.files));
const changed = Object.keys(actual).filter((f) => f in manifest.files && actual[f] !== manifest.files[f]);
const missing = Object.keys(manifest.files).filter((f) => !(f in actual));

if (added.length || changed.length || missing.length) {
  console.error("REFUSING: " + path.relative(repoRoot, TARGET) + " is not the tree the last mirror left.");
  if (changed.length) {
    console.error("");
    console.error("  edited since (" + changed.length + "):");
    for (const f of changed.slice(0, 20)) console.error("    " + f);
    if (changed.length > 20) console.error("    … and " + (changed.length - 20) + " more");
  }
  if (added.length) {
    console.error("");
    console.error("  added since (" + added.length + "):");
    for (const f of added.slice(0, 20)) console.error("    " + f);
    if (added.length > 20) console.error("    … and " + (added.length - 20) + " more");
  }
  if (missing.length) {
    console.error("");
    console.error("  missing since (" + missing.length + "):");
    for (const f of missing.slice(0, 20)) console.error("    " + f);
    if (missing.length > 20) console.error("    … and " + (missing.length - 20) + " more");
  }
  console.error("");
  console.error("  A mirror over this would delete or replace exactly those files. Move the work to a");
  console.error("  ref the workflow can build, or, if this tree is what should be published, record it");
  console.error("  as the new baseline:");
  console.error("    node tools/check-gev-mirror.mjs --accept <source-sha>");
  process.exit(1);
}

console.log("the demo path matches the last mirror: " + Object.keys(actual).length + " files, nothing edited by hand");
if (manifest.mirroredFrom) console.log("  built from: " + manifest.mirroredFrom);
process.exit(0);
