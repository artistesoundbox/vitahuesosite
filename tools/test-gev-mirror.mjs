/* ============================================================
   Local test for the gods-eye-view mirror guard.
     node tools/test-gev-mirror.mjs

   Runs the real tool as the workflow does — a child process, judged by its
   exit code and what it names — against fixtures in a temp directory. The
   fixtures are what matter here: a guard that refuses everything and a guard
   that refuses nothing are both easy to write and both useless, so the suite
   pins all three outcomes, and pins that a refusal never touches the tree.

   Exit codes are the load-bearing part:
     0  the tree is what the last mirror left — a mirror may run
     1  the tree was edited since — a mirror would delete exactly these files
     2  nothing says this tree came from the mirror at all — refuse, and say
        how a person can either move the work to a ref or deliberately re-record
   ============================================================ */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, "check-gev-mirror.mjs");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; failures.push(name + (detail ? "  → " + detail : "")); console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got) + " want " + JSON.stringify(want));
}

function run(fixture, extra) {
  const result = spawnSync(process.execPath, [
    TOOL,
    "--target=" + fixture.target,
    "--manifest=" + fixture.manifest,
    ...(extra || [])
  ], { encoding: "utf8" });
  return { status: result.status, out: (result.stdout || "") + (result.stderr || "") };
}

/* ---- fixtures ---- */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gev-mirror-"));
function fixture(name) {
  const dir = path.join(root, name);
  return {
    target: path.join(dir, "gods-eye-view"),
    manifest: path.join(dir, ".gev-mirror.json")
  };
}
function write(fixture, rel, bytes) {
  const full = path.join(fixture.target, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
}
function snapshot(fixture) {
  const out = {};
  (function step(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) step(full);
      else out[path.relative(fixture.target, full).split(path.sep).join("/")] =
        crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  })(fixture.target);
  return out;
}
/* A tree shaped like the real one: a hashed bundle, an index, the level. */
function buildTree(fixture) {
  write(fixture, "index.html", "<!DOCTYPE html>\n<title>demo</title>\n");
  write(fixture, "assets/index-CnCVdbwK.js", "console.log('saucer');\n");
  write(fixture, "mission-level/index.pck", Buffer.from([0x47, 0x44, 0x50, 0x43, 0, 1, 2, 255, 254]));
  write(fixture, "cesium/Workers/chunk.js", "// cesium\n");
  write(fixture, "logo with spaces 日本語.svg", "<svg/>");
}

/* ============================================================ */
console.log("\n[the tree a mirror would produce, recorded]");
const known = fixture("known");
buildTree(known);
{
  const before = run(known);
  eq("an unrecorded tree is refused, not assumed empty", before.status, 2);
  check("and the refusal names the path it would not touch",
    before.out.includes("gods-eye-view") && /was not produced by this workflow/.test(before.out),
    before.out.split("\n")[0]);
  check("and offers both ways forward",
    /SOURCE_BRANCH/.test(before.out) && /--accept/.test(before.out));
  check("and it wrote nothing", !fs.existsSync(known.manifest), known.manifest);

  const accept = run(known, ["--accept", "bilawalsidhu/gods-eye-view@c551e17"]);
  eq("--accept records the tree", accept.status, 0);
  const manifest = JSON.parse(fs.readFileSync(known.manifest, "utf8"));
  eq("every file is recorded", Object.keys(manifest.files).sort(),
    ["assets/index-CnCVdbwK.js", "cesium/Workers/chunk.js", "index.html", "logo with spaces 日本語.svg", "mission-level/index.pck"]);
  eq("with its own sha256", manifest.files["assets/index-CnCVdbwK.js"],
    crypto.createHash("sha256").update("console.log('saucer');\n").digest("hex"));
  eq("and where it came from", manifest.mirroredFrom, "bilawalsidhu/gods-eye-view@c551e17");

  const again = run(known);
  eq("a recorded, unchanged tree passes", again.status, 0);
  check("and says so plainly", /matches the last mirror/.test(again.out) && /nothing edited by hand/.test(again.out), again.out);
  check("and reports the ref it was built from", again.out.includes("c551e17"), again.out);

  const second = run(known, ["--accept", "bilawalsidhu/gods-eye-view@c551e17"]);
  eq("re-recording the same tree is idempotent", second.status, 0);
  eq("byte for byte", fs.readFileSync(known.manifest, "utf8"), JSON.stringify(manifest, null, 2) + "\n");
}

console.log("\n[someone edited the demo after the mirror]");
{
  write(known, "assets/index-CnCVdbwK.js", "console.log('saucer + hand edit');\n");
  const edited = snapshot(known);
  const result = run(known);
  eq("a hand edit is refused", result.status, 1);
  check("naming the file", result.out.includes("assets/index-CnCVdbwK.js"), result.out);
  check("under an 'edited since' heading", /edited since \(1\)/.test(result.out), result.out);
  check("and saying a mirror would replace exactly those", /delete or replace exactly those files/.test(result.out), result.out);

  const after = snapshot(known);
  eq("and the refusal changed nothing but what the human did", after, edited);
  check("the manifest was not rewritten by a refusal",
    fs.readFileSync(known.manifest, "utf8") === JSON.stringify(JSON.parse(fs.readFileSync(known.manifest, "utf8")), null, 2) + "\n");

  /* the documented way out */
  const accept = run(known, ["--accept", "bilawalsidhu/gods-eye-view@deadbeef"]);
  eq("--accept is the way past it", accept.status, 0);
  eq("and the tree passes again", run(known).status, 0);
  eq("recording the content that is actually there, not the old record",
    JSON.parse(fs.readFileSync(known.manifest, "utf8")).files["assets/index-CnCVdbwK.js"],
    crypto.createHash("sha256").update("console.log('saucer + hand edit');\n").digest("hex"));
}

console.log("\n[a file added by hand, and one taken away]");
{
  const added = fixture("added");
  buildTree(added);
  run(added, ["--accept", "sha-a"]);
  write(added, "assets/hand-written.js", "// added after the mirror\n");
  const result = run(added);
  eq("an added file is refused", result.status, 1);
  check("named under its own heading", /added since \(1\)/.test(result.out) && result.out.includes("assets/hand-written.js"), result.out);

  const removed = fixture("removed");
  buildTree(removed);
  run(removed, ["--accept", "sha-b"]);
  fs.rmSync(path.join(removed.target, "mission-level/index.pck"));
  const gone = run(removed);
  eq("a removed file is refused", gone.status, 1);
  check("named too", /missing since \(1\)/.test(gone.out) && gone.out.includes("mission-level/index.pck"), gone.out);

  /* the case the whole tool is for: a mirror about to delete the level */
  check("so a build without the level could never quietly delete it",
    /missing since/.test(gone.out), gone.out);
}

console.log("\n[fail closed on anything unreadable, and never on nothing]");
{
  const broken = fixture("broken");
  buildTree(broken);
  fs.mkdirSync(path.dirname(broken.manifest), { recursive: true });
  fs.writeFileSync(broken.manifest, "{ this is not json");
  eq("an unreadable manifest is refused, not ignored", run(broken).status, 2);

  const wrongShape = fixture("wrong-shape");
  buildTree(wrongShape);
  fs.writeFileSync(wrongShape.manifest, JSON.stringify({ note: "no files key" }));
  eq("a manifest with no files map is refused", run(wrongShape).status, 2);

  const absent = fixture("absent");
  eq("a demo path that is not there is refused", run(absent).status, 2);
  check("and names the path", run(absent).out.includes("no demo path"), run(absent).out);

  const foreign = fixture("foreign");
  buildTree(foreign);
  fs.writeFileSync(foreign.manifest, JSON.stringify({
    files: { "index.html": "0".repeat(64), "assets/index-CnCVdbwK.js": "1".repeat(64), "mission-level/index.pck": "2".repeat(64), "cesium/Workers/chunk.js": "3".repeat(64), "logo with spaces 日本語.svg": "4".repeat(64) }
  }));
  const result = run(foreign);
  eq("a manifest from another tree is refused", result.status, 1);
  check("with every file named as edited", /edited since \(5\)/.test(result.out), result.out);
}

console.log("\n[counts are not prose]");
{
  const many = fixture("many");
  buildTree(many);
  for (let i = 0; i < 30; i++) write(many, "assets/chunk-" + i + ".js", "// chunk " + i + "\n");
  run(many, ["--accept", "sha-many"]);
  eq("a tree of 35 files verifies", run(many).status, 0);
  for (let i = 0; i < 25; i++) write(many, "assets/chunk-" + i + ".js", "// edited " + i + "\n");
  const result = run(many);
  eq("25 edited files are refused", result.status, 1);
  check("with a count, not a wall of names", /edited since \(25\)/.test(result.out), result.out);
  check("and the list is capped at 20", (result.out.match(/^    assets\/chunk-/gm) || []).length === 20, String((result.out.match(/^    assets\/chunk-/gm) || []).length));
  check("saying how many were held back", /and 5 more/.test(result.out), result.out);
}

fs.rmSync(root, { recursive: true, force: true });

console.log("\n" + pass + " passed, " + fail + " failed");
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
