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
 * A page can load this file too, with a script tag, to reach the refusal kinds
 * and the words for them — the shells do exactly that.
 */
const POINTER_PREFIX = "version https://git-lfs.github.com/spec/";
const PACK_MAGIC = "GDPC";
/* A chunk is 8 MB and a whole pack is hundreds of MB; a pointer is 134 bytes.
   Body this small is a stub by inspection, where reading one to be certain would
   cost a whole chunk. */
const STUB_CEILING = 512;

/*
 * REFUSALS, AND WHAT A PLAYER IS TOLD
 * A refused pack used to reach the player as whatever the engine says about a
 * file it cannot parse — no use to anyone, and useless to the person deciding
 * whether to retry or give up. So every refusal carries a KIND: a header on the
 * response for anything that fetched it directly, and a message to every open
 * page for the engine's own fetch, which the shell that started the engine has
 * no other way to observe. `explainPackFailure` turns a kind into the three
 * lines a page puts on screen, and it lives here so both games describe the same
 * failure the same way.
 */
const REFUSALS = {
  "lfs-pointer": {
    headline: "The game download is a placeholder, not the game.",
    detail: "The host served the 134-byte stand-in that gets published when a " +
      "large file was left out of the site build. Nothing this device does can " +
      "turn it into the game, and retrying here will not change it.",
    advice: "It clears when the site is redeployed — try again in a few minutes."
  },
  "not-the-game": {
    headline: "The host answered the game URL with a page, not the game.",
    detail: "That normally means the file is missing on the host, or a build is " +
      "part-way through publishing and an edge is answering with its own page.",
    advice: "Wait a minute and try again — a reload can clear a half-published build."
  },
  truncated: {
    headline: "The game download came back cut short.",
    detail: "Part of a file arrived where the game should be, which is the shape " +
      "of a stub rather than a real download.",
    advice: "Press the button again — the half-finished attempt is discarded, not kept."
  },
  missing: {
    headline: "The game file is not on the host (404).",
    detail: "The URL the page asks for does not exist on the server answering it.",
    advice: "A deployment may be in progress; try again in a minute."
  },
  quota: {
    headline: "The game file could not be downloaded: the host is out of allowance.",
    detail: "This pack comes from a free tier with a monthly download quota, and " +
      "that quota is used up — the host answers with an error instead of the file.",
    advice: "It comes back when the quota resets, or when the site is redeployed."
  },
  "host-error": {
    headline: "The host refused to send the game file.",
    detail: "It answered with an error rather than the file itself.",
    advice: "Try again in a minute."
  },
  unreachable: {
    headline: "The game file could not be reached.",
    detail: "The request never completed — usually a dropped connection, or a " +
      "device that is offline.",
    advice: "Check the connection and press the button again."
  }
};

/* Which refusal a response is — or null when it is nothing to do with one. These
   end up in front of a player, so the kinds are words rather than status codes. */
function refusalKindFor(status, headText) {
  if (status === 403 || status === 429) return "quota";
  if (status === 404) return "missing";
  if (status >= 400) return "host-error";
  const text = String(headText || "");
  if (text.indexOf(POINTER_PREFIX) === 0) return "lfs-pointer";
  if (text.charAt(0) === "<" || text.charAt(0) === "{") return "not-the-game";
  return null;
}

/* The three lines a page shows. An unrecognized kind still says something true. */
function explainPackFailure(kind) {
  return REFUSALS[kind] || {
    headline: "The game could not be loaded.",
    detail: "",
    advice: "Try again in a minute."
  };
}

/* Tell every open page. The engine's own fetch is invisible to the shell that
   started it, so this is the only way the page learns why it died. A page
   listening for {type: "pack-refused"} puts explainPackFailure(kind) on screen. */
function announceRefusal(kind, reason) {
  const clients = (typeof self !== "undefined" && self.clients) || null;
  if (!clients || typeof clients.matchAll !== "function") return;  // a page, not a worker
  Promise.resolve().then(function () {
    return clients.matchAll({ includeUncontrolled: true });
  }).then(function (list) {
    list.forEach(function (client) {
      try {
        client.postMessage({ type: "pack-refused", kind: kind, reason: reason });
      } catch (e) { /* a page that has already gone away */ }
    });
  }).catch(function () { /* nothing listening is not a failure */ });
}

function stubResponse(reason, kind) {
  const label = (typeof self !== "undefined" && self.PACK_GUARD_LABEL) ||
    "pack guard";
  const key = kind || "not-the-game";
  announceRefusal(key, reason);
  return new Response(label + ": " + reason, {
    status: 502,
    statusText: "Bad Gateway",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      /* Readable by anything that fetched this directly: a shell's own chunk
         request gets the kind without parsing prose. */
      "X-Pack-Refusal": key,
    },
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
      " bytes, too small to be pack data", "truncated");
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
    return stubResponse(reason, refusalKindFor(resp.status, text) || "not-the-game");
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
    typeof stubByLength !== "function" || typeof refusalKindFor !== "function" ||
    typeof explainPackFailure !== "function") {
  throw new Error("pack-guard.js did not define the pack guard");
}
