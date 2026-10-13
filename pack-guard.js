/*
 * pack-guard.js — the one place that decides whether bytes are a pack at all.
 *
 * Both pack workers load this with a relative importScripts, so it resolves to
 * this file from either scope:
 *
 *   seblerskers/site-sw.js   importScripts("../pack-guard.js");
 *   game/sw-pack.js          importScripts("../pack-guard.js");
 *
 * WHY A STUB IS NOT OBVIOUS
 * A host built without `lfs: true` answers a large asset's URL with the 134-byte
 * Git LFS pointer the commit stores, and that is an ordinary response: HTTP 200,
 * a plausible content type, a body that reads like a file. Nothing between a CDN
 * and the engine — not a size probe, not a content-length header, not the
 * browser — can tell it from a pack until Godot has parsed it and died. The same
 * is true of an error page from an edge that has lost the object. The game/ pack
 * worker had to rename its cache once to shed pointer-poisoned entries, which is
 * what a stub that got cached looks like from the player's side: the file that
 * will not load, on every visit, with nothing saying why.
 *
 * WHY IT IS A FILE OF ITS OWN
 * This check used to sit in both workers, copied. A check whose entire job is to
 * be the last thing before the engine is not a place for two copies to drift, so
 * it lives here and the workers load it. If this file cannot be fetched, or does
 * not define the guard, the worker throws while installing and the browser keeps
 * the worker it already had — a worker running WITHOUT this guard is worse than a
 * worker that does not run, because a pack with no guard fails on a plain-looking
 * 200 that nothing anywhere reports.
 *
 * WHAT IT DOES
 * The opening bytes are read once — one chunk deep, never the whole pack — before
 * a response is handed to the engine or written to the cache, and a stub is
 * answered with a 502 that names what came back instead. A worker sets
 * `self.PACK_GUARD_LABEL` before importing this file so the refusal says which
 * one refused.
 */
const POINTER_PREFIX = "version https://git-lfs.github.com/spec/";
const PACK_MAGIC = "GDPC";
/* A chunk is 8 MB and a whole pack is hundreds of MB; a pointer is 134 bytes.
   Body this small is a stub by inspection, where reading one to be certain would
   cost a whole chunk. */
const STUB_CEILING = 512;

function stubResponse(reason) {
  const label = (typeof self !== "undefined" && self.PACK_GUARD_LABEL) ||
    "pack guard";
  return new Response(label + ": " + reason, {
    status: 502,
    statusText: "Bad Gateway",
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/* What came back, described — or null when it looks like pack bytes. */
function stubReason(head) {
  const text = new TextDecoder().decode(head.slice(0, 64));
  if (text.indexOf(POINTER_PREFIX) === 0) {
    return "the host is serving the Git LFS pointer for the pack, not the pack";
  }
  if (text.charAt(0) === "<" || text.charAt(0) === "{") {
    return "the pack URL returned a page, not a pack (" +
      text.slice(0, 24).replace(/[\r\n\t]+/g, " ") + ")";
  }
  return null;
}

/* The cheap check, for a response already in the cache: no chunk-sized read. */
function stubByLength(resp) {
  const len = Number((resp && resp.headers.get("content-length")) || 0);
  if (len > 0 && len <= STUB_CEILING) {
    return stubResponse("a cached part is " + len +
      " bytes, too small to be pack data");
  }
  return null;
}

/* Pass pack bytes through untouched, but only once the opening bytes are clear.
   `needMagic` is for the whole pack, whose first four bytes are always GDPC; a
   chunk further in carries no magic of its own and is checked for being a stub
   instead. One chunk is read and handed on exactly as it arrived. */
async function guardPack(resp, needMagic) {
  if (!resp.ok || !resp.body) return resp;  // HTTP failures are the caller's business
  const reader = resp.body.getReader();
  const first = await reader.read();
  const head = first.value || new Uint8Array(0);
  const text = new TextDecoder().decode(head.slice(0, 64));
  let reason = stubReason(head);
  if (!reason && needMagic && text.slice(0, 4) !== PACK_MAGIC) {
    reason = "the pack URL is not a Godot pack (it starts with \"" +
      text.slice(0, 16).replace(/[\r\n\t]+/g, " ") + "\")";
  }
  if (reason) {
    try { await reader.cancel(); } catch (e) { /* already gone */ }
    return stubResponse(reason);
  }
  const headers = new Headers();
  ["content-type", "content-length", "content-range", "accept-ranges"]
    .forEach(function (h) {
      const v = resp.headers.get(h);
      if (v) headers.set(h, v);
    });
  const stream = new ReadableStream({
    start(controller) { if (head.length) controller.enqueue(head); },
    pull(controller) {
      return reader.read().then(function (r) {
        if (r.done) controller.close(); else controller.enqueue(r.value);
      });
    },
    cancel(why) { return reader.cancel(why); },
  });
  return new Response(stream, {
    status: resp.status,
    statusText: resp.statusText,
    headers: headers,
  });
}

/* Fail closed. A worker that imported this file and then found no guard would run
   without one, which is the exact thing this file exists to prevent — so this
   turns that into an install failure the browser reports. */
if (typeof guardPack !== "function" || typeof stubReason !== "function" ||
    typeof stubByLength !== "function") {
  throw new Error("pack-guard.js did not define the pack guard");
}
