/* ============================================================
   profiles.js — accounts and profiles, on D1.

   The Worker signs people in with Google and, until now, stored nothing: the
   session was a cookie and there was no user table at all. A profile is the
   first thing here that has to outlive a cookie, so this is where the
   database starts, and it is written to be the pattern the next thing
   follows (the vault, shorts, chat) rather than a one-off.

   THE KEY IS GOOGLE'S ACCOUNT ID
   `sub` — the id_token's subject — is the primary key, not the email. An
   email can be changed on the Google account, and a verified email can be
   reassigned by an organisation; the `sub` is the stable one, and it is
   already what the sign-in flow puts on the session (see the jwt callback in
   worker.src.js, where Auth.js's own per-session UUID is deliberately not
   used). Nothing is looked up by anything a browser sends.

   WHAT THE CLIENT MAY NOT DECIDE
   Every field is bound, because this is the first write path in this Worker
   and profile text is echoed back to other people's browsers:

     - names and bios are length-capped and stripped of control characters
       (the *escaping* happens where they are rendered, in profile.js — the
       API stores text, it does not pretend to be a sanitiser for HTML);
     - avatar and banner must be https, may not carry credentials in the URL,
       and have no other scheme allowed at all;
     - social links must name one of a fixed set of labels, so a profile
       cannot become a link farm with arbitrary anchor text;
     - sections must be a list drawn from a fixed set of ids, so the profile
       page cannot be told to render something that is not a section. The
       list is what the profile *shows*, in order: what is absent is hidden,
       which is the only way an editor's Hide can mean anything.

   WHO IS AN ADMIN
   There is one, and it is whoever's Google email is on the ADMIN_EMAILS
   list — a server variable, not a row. The column caches that answer and the
   list is the authority: every look at a profile reconciles the two in the
   direction the list says, so granting is setting a value and revoking is
   deleting one, and no row in the table can promote itself. Nothing here
   trusts the caller for it: the email comes from the session, which was
   minted from a verified Google id_token.

   HANDLES
   Public and unique, because they are the URL. Derived from the Google name
   on first sign-in and renamed deliberately afterwards; the uniqueness is a
   UNIQUE index, not a hope, and a clash is a 409 rather than a silent
   overwrite of somebody else's profile.
   ============================================================ */

/* The sections a profile can show, and the only ids its order may contain.
   Kept here because the API validates them and the page renders them. */
export const SECTIONS = ["about", "links", "showcase", "shorts", "vault", "images", "music"];
export const DEFAULT_SECTIONS = ["about", "links", "showcase", "shorts"];

/* Labels a link may be filed under — the anchor text is ours, never the
   caller's, so a profile cannot present a link as something it is not. */
export const LINK_LABELS = ["website", "x", "instagram", "github", "youtube", "twitch", "tiktok", "discord", "spotify", "bandcamp", "patreon", "email"];

/* Handles that would collide with a route or read as somebody official. */
export const RESERVED_HANDLES = ["me", "api", "admin", "administrator", "root", "new", "edit", "settings", "signin", "signout", "signup", "login", "profiles", "search", "help", "support", "null", "undefined"];

export const LIMITS = {
  handle: 24,
  displayName: 48,
  bio: 600,
  url: 500,
  links: 8
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (" +
  " sub TEXT PRIMARY KEY," +
  " email TEXT NOT NULL DEFAULT ''," +
  " handle TEXT NOT NULL," +
  " handle_lower TEXT NOT NULL," +
  " display_name TEXT NOT NULL," +
  " bio TEXT NOT NULL DEFAULT ''," +
  " avatar_url TEXT NOT NULL DEFAULT ''," +
  " banner_url TEXT NOT NULL DEFAULT ''," +
  " links TEXT NOT NULL DEFAULT '[]'," +
  " sections TEXT NOT NULL DEFAULT '[]'," +
  " visibility TEXT NOT NULL DEFAULT 'public'," +
  " role TEXT NOT NULL DEFAULT 'member'," +
  " google_name TEXT NOT NULL DEFAULT ''," +
  " google_picture TEXT NOT NULL DEFAULT ''," +
  " created INTEGER NOT NULL," +
  " updated INTEGER NOT NULL)",
  /* Uniqueness is the index's job. handle_lower is what it is unique on, so
     "Ada" and "ada" cannot both exist — two profiles whose URLs differ only in
     case would be one profile to everyone reading them. */
  "CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower ON users(handle_lower)",
  "CREATE INDEX IF NOT EXISTS users_updated ON users(updated DESC)",
  "CREATE INDEX IF NOT EXISTS users_visibility ON users(visibility, updated DESC)"
];

/* Columns added after a table already existed. SQLite has no `ADD COLUMN IF
   NOT EXISTS`, so each is attempted and the one error it can raise on a table
   that already has it — "duplicate column name" — is the success case. Any
   other error is real and propagates. This is the whole migration story here:
   D1 is reached through this Worker and nothing else, so the Worker is the
   only thing that has to agree with the schema. */
const MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'"
];

let schemaReady = null;
export function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const statement of SCHEMA) await env.DB.prepare(statement).run();
      for (const statement of MIGRATIONS) {
        try {
          await env.DB.prepare(statement).run();
        } catch (err) {
          if (!/duplicate column/i.test(String((err && err.message) || err))) throw err;
        }
      }
      return true;
    })().catch((err) => {
      schemaReady = null;                 /* let the next request try again */
      throw err;
    });
  }
  return schemaReady;
}

/* ============================================================
   admins
   ============================================================ */

/* Comma-separated Google emails, read from a server variable. Empty means
   nobody is an admin, which is the state a deployment is in until the owner
   sets it — the safe default. */
export function adminEmails(env) {
  return String((env && env.ADMIN_EMAILS) || "")
    .split(",")
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}

function isAdmin(env, sessionUser) {
  const email = String((sessionUser && sessionUser.email) || "").trim().toLowerCase();
  if (!email) return false;
  /* Google's own `email_verified`, carried out of the id_token. A provider
     that omits the claim is not treated as a refusal — otherwise the owner's
     access would hinge on a field nobody promises — but a claim that says
     *unverified* is refused, because an account Google will not vouch for
     must not be able to name itself on this list. */
  if (sessionUser && sessionUser.emailVerified === false) return false;
  return adminEmails(env).indexOf(email) !== -1;
}

/* Reconcile the row with the list, writing only when they disagree — so a
   revoked admin is demoted on their own next request and no read costs a
   write in the ordinary case. */
async function syncRole(env, row, sessionUser) {
  const want = isAdmin(env, sessionUser) ? "admin" : "member";
  if ((row.role || "member") === want) return row;
  await env.DB.prepare("UPDATE users SET role = ? WHERE sub = ?").bind(want, row.sub).run();
  return Object.assign({}, row, { role: want });
}

/* ============================================================
   text
   ============================================================ */

/* Control characters out, whitespace collapsed, length capped. Newlines are
   kept for the bio (a bio that cannot have paragraphs is a bio nobody
   writes) and removed everywhere else. */
function cleanText(raw, max, allowNewlines) {
  let s = String(raw == null ? "" : raw);
  s = allowNewlines
    ? s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    : s.replace(/[\u0000-\u001F\u007F]/g, " ");
  s = allowNewlines
    ? s.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n")
    : s.replace(/\s+/g, " ");
  s = s.trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

function cleanHandle(raw) {
  return String(raw == null ? "" : raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, LIMITS.handle);
}

/* A handle nobody has: the derived one, else the same with a short random
   tail. The caller still has to survive the unique index; this only makes a
   collision unlikely enough that a first sign-in is not a coin toss. */
function derivedHandle(name) {
  const base = cleanHandle(name).slice(0, 20) || "player";
  return base.length >= 3 ? base : (base + "-player").slice(0, LIMITS.handle);
}

/* ============================================================
   urls
   ============================================================ */

/* https only, no credentials, no fragment games. Deliberately not a
   "is this a nice URL" check — it is an allowlist of one scheme, which is the
   only way to be sure a stored URL cannot become javascript: or data: later. */
function cleanUrl(raw, field, errors) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  if (s.length > LIMITS.url) {
    errors.push({ field: field, error: "longer than " + LIMITS.url + " characters" });
    return "";
  }
  let parsed;
  try {
    parsed = new URL(s);
  } catch (err) {
    errors.push({ field: field, error: "not a URL" });
    return "";
  }
  if (parsed.protocol !== "https:") {
    errors.push({ field: field, error: "only https:// links are accepted" });
    return "";
  }
  if (parsed.username || parsed.password) {
    errors.push({ field: field, error: "credentials are not allowed in a URL" });
    return "";
  }
  return parsed.toString();
}

function profileLinks(raw, errors) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ field: "links", error: "must be a list" });
    return [];
  }
  if (raw.length > LIMITS.links) {
    errors.push({ field: "links", error: "at most " + LIMITS.links + " links" });
    return [];
  }
  const out = [];
  raw.forEach((entry, index) => {
    const label = String((entry && entry.label) || "").trim().toLowerCase();
    if (LINK_LABELS.indexOf(label) === -1) {
      errors.push({ field: "links[" + index + "].label", error: "unknown label" });
      return;
    }
    const value = String((entry && entry.url) || "").trim();
    if (label === "email") {
      const address = value.replace(/^mailto:/i, "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
        errors.push({ field: "links[" + index + "].url", error: "not an email address" });
        return;
      }
      out.push({ label: label, url: "mailto:" + address });
      return;
    }
    const url = cleanUrl(value, "links[" + index + "].url", errors);
    if (url) out.push({ label: label, url: url });
  });
  return out;
}

/* The sections this profile shows, in the order it shows them.

   A list, and only a list: nothing is appended. Leaving a section out hides
   it, which is what an editor's Hide control has to mean — a rule that put
   the omitted ones back would make hiding impossible to express and would
   quietly disagree with the page that asked for it. What is absent is hidden,
   and the page asks for it again by sending it again.

   Deduped, because the same section twice is one section. Unknown ids and an
   empty list are refused rather than repaired: both mean the caller and this
   module disagree about what a profile is, and inventing an answer would
   hide that. */
function profileSections(raw, errors) {
  if (raw == null) return DEFAULT_SECTIONS.slice();
  if (!Array.isArray(raw)) {
    errors.push({ field: "sections", error: "must be a list" });
    return DEFAULT_SECTIONS.slice();
  }
  if (raw.length > SECTIONS.length) {
    errors.push({ field: "sections", error: "at most " + SECTIONS.length + " sections" });
    return DEFAULT_SECTIONS.slice();
  }
  const seen = [];
  for (const entry of raw) {
    const id = String(entry == null ? "" : entry).trim().toLowerCase();
    if (SECTIONS.indexOf(id) === -1) {
      errors.push({ field: "sections", error: "unknown section " + JSON.stringify(id) });
      return DEFAULT_SECTIONS.slice();
    }
    if (seen.indexOf(id) === -1) seen.push(id);
  }
  if (!seen.length) {
    errors.push({ field: "sections", error: "at least one section" });
    return DEFAULT_SECTIONS.slice();
  }
  return seen;
}

/* ============================================================
   rows
   ============================================================ */

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value == null ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

/* What anybody may see. No email, no sub, no google_* — those are the
   account, not the profile. */
export function publicProfile(row) {
  if (!row) return null;
  return {
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatar: row.avatar_url,
    banner: row.banner_url,
    links: parseJson(row.links, []),
    sections: parseJson(row.sections, []),
    visibility: row.visibility,
    joined: row.created,
    updated: row.updated
  };
}

/* Your own copy. Never anybody else's: the public shape above deliberately has
   no `role`, so an admin badge is not something a visitor can read off the
   directory, and nothing about the account leaks from a public read. */
function mineProfile(row) {
  return Object.assign(publicProfile(row), {
    email: row.email,
    role: row.role === "admin" ? "admin" : "member",
    googleName: row.google_name,
    googlePicture: row.google_picture
  });
}

/* The admin's view of the accounts. Handles and roles, deliberately without
   the emails: a moderation list does not need them, and the fewer places an
   address is copied to, the fewer can leak it. */
function accountRow(row, meSub) {
  return {
    handle: row.handle,
    displayName: row.display_name,
    role: row.role === "admin" ? "admin" : "member",
    visibility: row.visibility,
    joined: row.created,
    updated: row.updated,
    me: row.sub === meSub
  };
}

/* ============================================================
   reads and writes
   ============================================================ */

export async function byHandle(env, handle) {
  const lower = cleanHandle(handle);
  if (!lower) return null;
  return await env.DB.prepare("SELECT * FROM users WHERE handle_lower = ?").bind(lower).first();
}

/* The row for a signed-in person, created on first sight. Signed in is not
   the same as having a profile: the session is a cookie, this is a row, and
   this is where the row appears. */
export async function ensureProfile(env, sessionUser, nowMs) {
  const sub = String(sessionUser && sessionUser.id || "");
  if (!sub) return null;
  const existing = await env.DB.prepare("SELECT * FROM users WHERE sub = ?").bind(sub).first();
  if (existing) return await syncRole(env, existing, sessionUser);

  const googleName = cleanText(sessionUser.name, LIMITS.displayName, false) || "Player";
  const picture = cleanUrl(sessionUser.picture, "google_picture", []);
  let handle = derivedHandle(googleName);
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 ? handle : (derivedHandle(googleName).slice(0, 18) + "-" + randomSuffix());
    if (RESERVED_HANDLES.indexOf(candidate) !== -1) continue;
    const clash = await env.DB.prepare("SELECT sub FROM users WHERE handle_lower = ?").bind(candidate).first();
    if (!clash) {
      handle = candidate;
      break;
    }
    if (attempt === 5) handle = candidate;
  }
  try {
    /* The avatar starts as the Google picture: a profile with a face on it
       from the first look is worth more than an empty circle waiting for
       somebody to go and find a file. It is a copy, not a link — changing it
       later changes only this row. */
    await env.DB.prepare(
      "INSERT INTO users (sub, email, handle, handle_lower, display_name, bio, avatar_url, banner_url," +
      " links, sections, visibility, role, google_name, google_picture, created, updated)" +
      " VALUES (?, ?, ?, ?, ?, '', ?, '', '[]', ?, 'public', ?, ?, ?, ?, ?)"
    ).bind(
      sub, cleanText(sessionUser.email, 254, false), handle, handle.toLowerCase(), googleName,
      picture, JSON.stringify(DEFAULT_SECTIONS), isAdmin(env, sessionUser) ? "admin" : "member",
      googleName, picture, nowMs, nowMs
    ).run();
  } catch (err) {
    /* Two first requests at once: whoever lost the race reads the winner's
       row rather than failing. */
    const raced = await env.DB.prepare("SELECT * FROM users WHERE sub = ?").bind(sub).first();
    if (raced) return raced;
    throw err;
  }
  return await env.DB.prepare("SELECT * FROM users WHERE sub = ?").bind(sub).first();
}

function randomSuffix() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 4);
}

/* Validated update. Returns { errors } or { row }. */
export async function applyUpdate(env, sub, body, nowMs) {
  const errors = [];
  const source = body && typeof body === "object" ? body : {};

  const displayName = cleanText(source.displayName, LIMITS.displayName, false);
  if (source.displayName !== undefined && !displayName) {
    errors.push({ field: "displayName", error: "cannot be empty" });
  }

  let handle = null;
  if (source.handle !== undefined) {
    handle = cleanHandle(source.handle);
    if (handle.length < 3) {
      errors.push({ field: "handle", error: "needs at least 3 letters, digits, - or _" });
    } else if (RESERVED_HANDLES.indexOf(handle) !== -1) {
      errors.push({ field: "handle", error: "that handle is reserved" });
    }
  }

  const visibility = source.visibility === undefined ? null : String(source.visibility);
  if (visibility !== null && ["public", "private"].indexOf(visibility) === -1) {
    errors.push({ field: "visibility", error: "must be public or private" });
  }

  const bio = source.bio === undefined ? null : cleanText(source.bio, LIMITS.bio, true);
  const avatar = source.avatar === undefined ? null : cleanUrl(source.avatar, "avatar", errors);
  const banner = source.banner === undefined ? null : cleanUrl(source.banner, "banner", errors);
  const links = source.links === undefined ? null : profileLinks(source.links, errors);
  const sections = source.sections === undefined ? null : profileSections(source.sections, errors);

  if (errors.length) return { errors: errors };

  const row = await env.DB.prepare("SELECT * FROM users WHERE sub = ?").bind(sub).first();
  if (!row) return { errors: [{ field: "profile", error: "no profile for this account" }], missing: true };

  try {
    await env.DB.prepare(
      "UPDATE users SET handle = ?, handle_lower = ?, display_name = ?, bio = ?, avatar_url = ?," +
      " banner_url = ?, links = ?, sections = ?, visibility = ?, updated = ? WHERE sub = ?"
    ).bind(
      handle === null ? row.handle : handle,
      handle === null ? row.handle_lower : handle.toLowerCase(),
      source.displayName === undefined ? row.display_name : displayName,
      bio === null ? row.bio : bio,
      avatar === null ? row.avatar_url : avatar,
      banner === null ? row.banner_url : banner,
      links === null ? row.links : JSON.stringify(links),
      sections === null ? row.sections : JSON.stringify(sections),
      visibility === null ? row.visibility : visibility,
      nowMs, sub
    ).run();
  } catch (err) {
    /* The unique index is the authority on handles; a race lands here. */
    if (/UNIQUE|constraint/i.test(String((err && err.message) || err))) {
      return { errors: [{ field: "handle", error: "that handle is taken" }], taken: true };
    }
    throw err;
  }
  return { row: await env.DB.prepare("SELECT * FROM users WHERE sub = ?").bind(sub).first() };
}

export async function listPublic(env, limit) {
  const capped = Math.min(Math.max(Number(limit) || 12, 1), 50);
  const rows = await env.DB.prepare(
    "SELECT * FROM users WHERE visibility = 'public' ORDER BY updated DESC LIMIT ?"
  ).bind(capped).all();
  return (rows.results || []).map(publicProfile);
}

/* ============================================================
   routes
   ============================================================ */

/* Returns a Response for a profile route, or null when the path is not one —
   the caller (the Worker) owns the answer for everything else. `ctx` carries
   the shared helpers so this module does not re-implement the Worker's CORS
   or its JSON shape. */
export async function handleProfiles(ctx) {
  const { request, env, path, sessionUser, json, cors } = ctx;
  const needsDb = path === "/api/profile" || path.indexOf("/api/profile/") === 0 ||
    path === "/api/profiles" || path === "/api/admin/accounts";
  if (!needsDb) return null;
  if (!env.DB) {
    return json({ ok: false, error: "no database bound" }, 503, cors);
  }
  await ensureSchema(env);

  const signedIn = !!(sessionUser && sessionUser.id);

  /* The admin's list of accounts. The one route here that is not about
     somebody's own profile, so it is the one that has to be guarded on the
     server rather than by the page not drawing a button: 401 for nobody,
     403 for a member, and the answer is the same for both only in that
     neither gets the list. */
  if (path === "/api/admin/accounts") {
    if (!signedIn) return json({ ok: false, error: "not signed in" }, 401, cors);
    const mine = await ensureProfile(env, sessionUser, Date.now());
    if ((mine.role || "member") !== "admin") {
      return json({ ok: false, error: "not an admin" }, 403, cors);
    }
    if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405, cors);
    const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 50, 1), 200);
    const rows = await env.DB.prepare(
      "SELECT sub, handle, display_name, role, visibility, created, updated FROM users ORDER BY created DESC LIMIT ?"
    ).bind(limit).all();
    return json({ ok: true, accounts: (rows.results || []).map(function (r) { return accountRow(r, mine.sub); }) }, 200, cors);
  }

  if (path === "/api/profiles") {
    if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405, cors);
    return json({ ok: true, profiles: await listPublic(env, new URL(request.url).searchParams.get("limit")) }, 200, cors);
  }

  if (path === "/api/profile") {
    if (!signedIn) return json({ ok: false, error: "not signed in" }, 401, cors);
    if (request.method === "GET") {
      const row = await ensureProfile(env, sessionUser, Date.now());
      return json({ ok: true, me: true, profile: mineProfile(row) }, 200, cors);
    }
    if (request.method === "PUT" || request.method === "PATCH") {
      await ensureProfile(env, sessionUser, Date.now());
      let body;
      try {
        const text = await request.text();
        if (text.length > 20000) return json({ ok: false, error: "body too large" }, 413, cors);
        body = text ? JSON.parse(text) : {};
      } catch (err) {
        return json({ ok: false, error: "bad json" }, 400, cors);
      }
      const result = await applyUpdate(env, sessionUser.id, body, Date.now());
      if (result.errors) {
        const status = result.taken ? 409 : 422;
        return json({ ok: false, error: result.taken ? "handle taken" : "invalid profile", fields: result.errors }, status, cors);
      }
      return json({ ok: true, me: true, profile: mineProfile(result.row) }, 200, cors);
    }
    return json({ ok: false, error: "method not allowed" }, 405, cors);
  }

  /* /api/profile/<handle> */
  const handle = decodeURIComponent(path.slice("/api/profile/".length));
  if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405, cors);
  const row = await byHandle(env, handle);
  if (!row) return json({ ok: false, error: "no such profile" }, 404, cors);
  if (row.visibility === "private" && !(signedIn && sessionUser.id === row.sub)) {
    return json({ ok: false, error: "this profile is private" }, 403, cors);
  }
  const me = signedIn && sessionUser.id === row.sub;
  return json({ ok: true, me: me, profile: me ? mineProfile(row) : publicProfile(row) }, 200, cors);
}
