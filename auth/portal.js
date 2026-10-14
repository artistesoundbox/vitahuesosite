/* ============================================================
   portal.js — the portal's client side. Vanilla, no build step,
   because the whole site is static files on GitHub Pages.

   WHAT IT TALKS TO
   The sign-in Worker (see signin.js for the API base and the
   `credentials: "include"` that makes the cross-site session
   cookie travel), and through it the profile API:

     GET   /api/me                  who is signed in
     GET   /api/profile             my profile, created on first sight
     PUT   /api/profile             validated update
     GET   /api/profile/<handle>    anybody's public profile

   WHAT IT WILL NOT DO
   Put anything a person typed into HTML. Every value that came
   from a row is written with textContent, and every link is
   checked against an https/mailto allowlist before it becomes an
   href — the API already refuses anything else, and this is the
   second lock on the same door rather than trust in the first.

   The other three modules (vault, shorts, community) are not
   built. Their tabs say so instead of showing invented data.
   ============================================================ */
(function () {
  "use strict";

  /* Must match SECTIONS in src/profiles.js: the API refuses an order that
     names anything else, so a typo here is a 422 rather than a missing
     block on the page. */
  var SECTIONS = [
    { id: "about", title: "About", blurb: "your bio" },
    { id: "links", title: "Links", blurb: "your social links" },
    { id: "showcase", title: "Showcase", blurb: "hand-picked items" },
    { id: "shorts", title: "Shorts", blurb: "your vertical clips" },
    { id: "vault", title: "Vault", blurb: "saved things you share" },
    { id: "images", title: "Images", blurb: "a picture grid" },
    { id: "music", title: "Music", blurb: "tracks you made or like" }
  ];
  var SECTION_IDS = SECTIONS.map(function (s) { return s.id; });
  var DEFAULT_SECTION_IDS = ["about", "links", "showcase", "shorts"];
  var LINK_LABELS = ["website", "x", "instagram", "github", "youtube", "twitch", "tiktok", "discord", "spotify", "bandcamp", "patreon", "email"];
  var LIMITS = { handle: 24, displayName: 48, bio: 600, links: 8 };

  var state = {
    session: null,
    mine: null,
    order: [],
    hidden: [],
    links: [],
    loading: false
  };

  function byId(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  var toastTimer = null;
  function toast(message) {
    var box = byId("toast");
    box.textContent = message;
    box.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove("show"); }, 3200);
  }

  /* ============================================================
     talking to the Worker
     ============================================================ */

  function base() {
    return (window.VH_AUTH && window.VH_AUTH.api) ? window.VH_AUTH.api() : null;
  }

  function api(path, options) {
    var root = base();
    if (!root) {
      return Promise.resolve({ status: 0, ok: false, body: { error: "signin.js did not load, so the API base is unknown" } });
    }
    var opts = options || {};
    /* Without this the session cookie is not sent and everything reads as
       signed out while the cookie sits there perfectly valid. */
    opts.credentials = "include";
    opts.mode = "cors";
    if (opts.body) {
      opts.headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
    }
    return fetch(root + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body || {} };
      });
    }).catch(function (err) {
      return { status: 0, ok: false, body: { error: "could not reach the profile service (" + (err && err.message || err) + ")" } };
    });
  }

  /* ============================================================
     rendering a profile — one renderer, used by the page, the
     editor's live preview and (later) by anything else that has
     to show a profile, so a visitor cannot see something the
     preview never showed.
     ============================================================ */

  /* Only https and mailto become an href. A row written before this rule
     existed, or by something other than this API, still cannot produce a
     javascript: link here. */
  function safeHref(url) {
    var s = String(url || "").trim();
    if (/^https:\/\/[^\s]/i.test(s)) return s;
    if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(s)) return s;
    return null;
  }

  function linkText(url) {
    var s = String(url || "");
    if (/^mailto:/i.test(s)) return s.slice(7);
    return s.replace(/^https:\/\//i, "").replace(/\/$/, "");
  }

  function avatarNode(url, className) {
    var img = el("img", className);
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    var href = safeHref(url);
    if (!href) { img.hidden = true; return img; }
    /* A dead link is a removed image, not a broken one. */
    img.addEventListener("error", function () { img.hidden = true; });
    img.src = href;
    return img;
  }

  /* The body of one section. `draft` is what the editor currently has, which
     is why this takes a profile and not a row. */
  function sectionBody(id, profile) {
    if (id === "about") {
      if (!profile.bio) return el("p", "empty", "No bio yet.");
      return el("p", "bio", profile.bio);
    }
    if (id === "links") {
      var links = (profile.links || []).filter(function (l) { return safeHref(l && l.url); });
      if (!links.length) return el("p", "empty", "No links yet.");
      var list = el("ul", "links");
      links.forEach(function (link) {
        var item = el("li");
        var anchor = el("a");
        anchor.href = safeHref(link.url);
        anchor.rel = "me noopener noreferrer";
        anchor.target = "_blank";
        anchor.appendChild(el("span", "label", link.label));
        anchor.appendChild(el("span", "url", linkText(link.url)));
        item.appendChild(anchor);
        list.appendChild(item);
      });
      return list;
    }
    /* Sections the other modules fill. Said plainly rather than dressed up:
       an empty block that claims to be a gallery is worse than one that says
       what it is waiting for. */
    var waiting = {
      showcase: "Nothing showcased yet — this fills from the vault and media modules.",
      shorts: "No shorts yet. Video uploads arrive with the media module.",
      vault: "Nothing shared from the vault yet.",
      images: "No images yet.",
      music: "No tracks yet."
    };
    return el("p", "empty", waiting[id] || "Nothing here yet.");
  }

  function sectionBlock(id, profile) {
    var meta = SECTIONS.filter(function (s) { return s.id === id; })[0] || { id: id, title: id };
    var block = el("section", "section-block");
    block.setAttribute("data-section", id);
    block.appendChild(el("h3", null, meta.title));
    block.appendChild(sectionBody(id, profile));
    return block;
  }

  /* Which sections a profile shows, and in what order. The stored list is the
     whole answer: a section that is not in it is hidden, not missing, and
     putting the defaults back here would undo the hiding the owner asked for
     — which is exactly what it did until a browser was pointed at it. The one
     fallback is a row with no list at all, which shows the defaults rather
     than nothing. */
  function visibleOrder(profile) {
    var given = (profile && Array.isArray(profile.sections) ? profile.sections : []).filter(function (id) {
      return SECTION_IDS.indexOf(id) !== -1;
    });
    return given.length ? given : DEFAULT_SECTION_IDS.slice();
  }

  function renderProfile(container, profile, options) {
    var opts = options || {};
    container.textContent = "";

    var card = el("div", "card profile-card");
    card.setAttribute("data-profile", profile.handle || "");

    var banner = el("div", "banner");
    if (safeHref(profile.banner)) banner.appendChild(avatarNode(profile.banner, "banner-img"));
    card.appendChild(banner);

    var ident = el("div", "ident");
    ident.appendChild(avatarNode(profile.avatar, "avatar"));
    var who = el("div", "who");
    who.appendChild(el("h1", null, profile.displayName || "Unnamed"));
    who.appendChild(el("div", "handle", "@" + (profile.handle || "?")));
    ident.appendChild(who);

    if (opts.mine || profile.visibility) {
      var pill = el("span", "pill " + (profile.visibility === "private" ? "private" : "public"),
        profile.visibility === "private" ? "Private" : "Public");
      ident.appendChild(pill);
    }
    card.appendChild(ident);

    visibleOrder(profile).forEach(function (id) { card.appendChild(sectionBlock(id, profile)); });
    container.appendChild(card);

    if (opts.note) container.appendChild(el("p", "muted", opts.note));
    return card;
  }

  /* ============================================================
     the profile tab
     ============================================================ */

  function statusCard(show, title, text, actions) {
    byId("profile-status").hidden = !show;
    if (!show) return;
    byId("profile-status-text").textContent = text;
    if (title) byId("profile-status").querySelector("h2").textContent = title;
    var box = byId("profile-status-actions");
    box.textContent = "";
    (actions || []).forEach(function (action) {
      var button = el("button", action.className || "primary", action.label);
      button.type = "button";
      button.addEventListener("click", action.run);
      box.appendChild(button);
    });
  }

  function signInButton(label) {
    return {
      label: label || "Sign in with Google",
      className: "vh-auth-google",
      run: function () {
        if (!window.VH_AUTH) return toast("The sign-in script did not load.");
        window.VH_AUTH.signIn().catch(function (err) {
          toast(String(err && err.message || err));
        });
      }
    };
  }

  function showMyProfile() {
    var handle = state.mine && state.mine.handle;
    var url = window.location.pathname + (handle ? "?u=" + encodeURIComponent(handle) : "");
    return { label: "See it as a visitor", className: "ghost", run: function () { window.location.href = url; } };
  }

  function loadProfileTab() {
    var requested = new URLSearchParams(window.location.search).get("u");
    var out = byId("profile-out");

    if (requested) {
      statusCard(true, "Profile", "Loading @" + requested + "…", []);
      api("/api/profile/" + encodeURIComponent(requested)).then(function (r) {
        if (r.status === 200 && r.body.ok) {
          var profile = r.body.profile;
          statusCard(false);
          out.hidden = false;
          renderProfile(out, profile, {
            mine: r.body.me,
            note: r.body.me ? "This is your profile as a visitor sees it." : "Viewing @" + profile.handle
          });
          return;
        }
        var why = r.body.error || ("status " + r.status);
        statusCard(true, "Profile", "Could not load @" + requested + " — " + why + ".", [
          { label: "Back to your profile", className: "ghost", run: function () { window.location.href = window.location.pathname; } }
        ]);
      });
      return;
    }

    if (!state.session || !state.session.signedIn) {
      out.hidden = true;
      statusCard(true, "Your profile",
        "Sign in with Google to claim a handle, a bio, links and a page of your own. Nothing is written until you sign in, and nothing is shown to anyone else until you say so.",
        [signInButton()]);
      return;
    }

    statusCard(true, "Your profile", "Loading your profile…", []);
    api("/api/profile").then(function (r) {
      if (r.status === 200 && r.body.ok) {
        state.mine = r.body.profile;
        fillEditor(state.mine);
        statusCard(true, "Your profile",
          "Signed in as " + (state.session.user && state.session.user.name || "you") + ". Your page is " +
          (state.mine.visibility === "private" ? "private — only you can open it." : "public — anyone with @" + state.mine.handle + " can open it."),
          [showMyProfile(), { label: "Edit profile", className: "primary", run: function () { selectTab("editor"); } }]);
        out.hidden = false;
        renderProfile(out, state.mine, { mine: true });
        return;
      }
      statusCard(true, "Your profile", "Could not load your profile — " + (r.body.error || ("status " + r.status)) + ".", [
        signInButton("Sign in again"),
        { label: "Try again", className: "ghost", run: loadProfileTab }
      ]);
    });
  }

  /* ============================================================
     the editor: fields
     ============================================================ */

  function fieldBox(name) {
    return document.querySelector('[data-field="' + name + '"]');
  }

  function setFieldErrors(errors) {
    clearFieldErrors();
    var unmatched = [];
    (errors || []).forEach(function (entry) {
      /* "links[0].url" belongs to the links block; the caller cannot act on
         the index, and an error nobody can see is an error nobody fixes. */
      var name = String(entry.field || "").split("[")[0];
      var box = fieldBox(name);
      if (!box) { unmatched.push(entry); return; }
      box.setAttribute("data-bad", "1");
      var why = box.querySelector(".why");
      if (why) {
        why.hidden = false;
        why.textContent = why.textContent ? why.textContent + "; " + entry.error : entry.error;
      }
    });
    return unmatched;
  }

  function clearFieldErrors() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-field]"), function (box) {
      box.removeAttribute("data-bad");
      var why = box.querySelector(".why");
      if (why) { why.hidden = true; why.textContent = ""; }
    });
  }

  /* ---- social links ---- */

  function renderLinks() {
    var list = byId("links-list");
    list.textContent = "";
    if (!state.links.length) {
      var empty = el("li", "section-item is-hidden");
      empty.appendChild(el("span", "name", "No links yet."));
      list.appendChild(empty);
    }
    state.links.forEach(function (link, index) {
      var item = el("li", "section-item");
      item.setAttribute("data-link", String(index));
      var name = el("span", "name");
      name.appendChild(document.createTextNode(link.label));
      name.appendChild(el("small", null, linkText(link.url)));
      item.appendChild(name);
      var remove = el("button", "ghost icon", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove the " + link.label + " link");
      remove.addEventListener("click", function () {
        state.links.splice(index, 1);
        renderLinks();
        afterEdit();
      });
      item.appendChild(remove);
      list.appendChild(item);
    });
    byId("link-add").disabled = state.links.length >= LIMITS.links;
    byId("link-url").disabled = state.links.length >= LIMITS.links;
    byId("link-label").disabled = state.links.length >= LIMITS.links;
  }

  function addLink() {
    var label = byId("link-label").value;
    var raw = byId("link-url").value.trim();
    if (state.links.length >= LIMITS.links) return toast("At most " + LIMITS.links + " links.");
    if (!raw) return toast("Paste a link (or an email address for the email label) first.");
    if (label === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return toast("That does not look like an email address.");
      state.links.push({ label: label, url: "mailto:" + raw });
    } else {
      if (!/^https:\/\//i.test(raw)) return toast("Links have to start with https://");
      state.links.push({ label: label, url: raw });
    }
    byId("link-url").value = "";
    renderLinks();
    afterEdit();
  }

  function fillLinkLabels() {
    var select = byId("link-label");
    select.textContent = "";
    LINK_LABELS.forEach(function (label) {
      var option = el("option", null, label);
      option.value = label;
      select.appendChild(option);
    });
    select.value = "website";
  }

  /* ---- sections: order and visibility ---- */

  function ordered() {
    return state.order.filter(function (id) { return state.hidden.indexOf(id) === -1; });
  }

  function hiddenOrdered() {
    return state.order.filter(function (id) { return state.hidden.indexOf(id) !== -1; });
  }

  function meta(id) {
    return SECTIONS.filter(function (s) { return s.id === id; })[0] || { id: id, title: id, blurb: "" };
  }

  /* Hidden sections are kept, in their order, after the visible ones: hiding
     something is not the same as deleting it, and showing it again puts it
     back where you had it. The API stores the visible ones only, so what
     other people see is exactly this list minus the hidden block. */
  function normalizeOrder(order, hidden) {
    var seen = [];
    (order || []).filter(function (id) { return SECTION_IDS.indexOf(id) !== -1 && seen.indexOf(id) === -1; })
      .forEach(function (id) { seen.push(id); });
    SECTION_IDS.forEach(function (id) { if (seen.indexOf(id) === -1) seen.push(id); });
    var visible = seen.filter(function (id) { return (hidden || []).indexOf(id) === -1; });
    var away = seen.filter(function (id) { return (hidden || []).indexOf(id) !== -1; });
    return visible.concat(away);
  }

  function renderSections() {
    var list = byId("sections-list");
    list.textContent = "";
    var visible = ordered();
    var away = hiddenOrdered();

    visible.forEach(function (id, index) {
      list.appendChild(sectionItem(id, { index: index, count: visible.length, hidden: false }));
    });
    away.forEach(function (id) {
      list.appendChild(sectionItem(id, { index: -1, count: visible.length, hidden: true }));
    });
  }

  function sectionItem(id, info) {
    var def = meta(id);
    var item = el("li", "section-item" + (info.hidden ? " is-hidden" : ""));
    item.setAttribute("data-section-id", id);
    if (!info.hidden) {
      item.draggable = true;
      item.setAttribute("data-index", String(info.index));
    }

    if (!info.hidden) {
      var grip = el("span", "grip", "⠿");
      grip.setAttribute("aria-hidden", "true");
      item.appendChild(grip);
    }

    var name = el("span", "name");
    name.appendChild(document.createTextNode(def.title));
    name.appendChild(el("small", null, info.hidden ? def.blurb + " — hidden" : def.blurb));
    item.appendChild(name);

    if (!info.hidden) {
      item.appendChild(el("span", "n", String(info.index + 1)));

      /* The keyboard path. Drag and drop is the fast way and this is the
         accessible one; both call the same move(). */
      var moves = el("div", "moves");
      var up = el("button", "ghost", "↑");
      up.type = "button";
      up.disabled = info.index === 0;
      up.setAttribute("aria-label", "Move " + def.title + " earlier");
      up.addEventListener("click", function () { move(id, -1); });
      var down = el("button", "ghost", "↓");
      down.type = "button";
      down.disabled = info.index === info.count - 1;
      down.setAttribute("aria-label", "Move " + def.title + " later");
      down.addEventListener("click", function () { move(id, 1); });
      moves.appendChild(up);
      moves.appendChild(down);
      item.appendChild(moves);
    }

    var toggle = el("button", "ghost icon", info.hidden ? "Show" : "Hide");
    toggle.type = "button";
    toggle.setAttribute("aria-label", (info.hidden ? "Show " : "Hide ") + def.title + " on your profile");
    toggle.addEventListener("click", function () { toggleSection(id); });
    item.appendChild(toggle);

    if (!info.hidden) {
      /* ---- drag, within the visible block only ---- */
      item.addEventListener("dragstart", function (event) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", function () {
        item.classList.remove("dragging");
        Array.prototype.forEach.call(list_dropMarks(), function (n) {
          n.classList.remove("drop-before", "drop-after");
        });
      });
      item.addEventListener("dragover", function (event) {
        event.preventDefault();
        var box = item.getBoundingClientRect();
        var after = (event.clientY - box.top) > box.height / 2;
        item.classList.toggle("drop-after", after);
        item.classList.toggle("drop-before", !after);
      });
      item.addEventListener("dragleave", function () {
        item.classList.remove("drop-before", "drop-after");
      });
      item.addEventListener("drop", function (event) {
        event.preventDefault();
        var after = item.classList.contains("drop-after");
        item.classList.remove("drop-before", "drop-after");
        dropSection(event.dataTransfer.getData("text/plain"), id, after);
      });
    }
    return item;
  }

  function list_dropMarks() {
    return byId("sections-list").children;
  }

  function move(id, delta) {
    var visible = ordered();
    var from = visible.indexOf(id);
    var to = from + delta;
    if (from === -1 || to < 0 || to >= visible.length) return;
    visible.splice(to, 0, visible.splice(from, 1)[0]);
    state.order = normalizeOrder(visible.concat(hiddenOrdered()), state.hidden);
    renderSections();
    afterEdit();
  }

  function dropSection(draggedId, targetId, after) {
    if (!draggedId || draggedId === targetId || state.hidden.indexOf(draggedId) !== -1) return;
    var visible = ordered();
    var from = visible.indexOf(draggedId);
    if (from === -1) return;
    visible.splice(from, 1);
    var at = visible.indexOf(targetId);
    if (at === -1) return;
    visible.splice(after ? at + 1 : at, 0, draggedId);
    state.order = normalizeOrder(visible.concat(hiddenOrdered()), state.hidden);
    renderSections();
    afterEdit();
  }

  function toggleSection(id) {
    var hidden = state.hidden.indexOf(id);
    if (hidden === -1) {
      if (ordered().length <= 1) return toast("A profile needs at least one section.");
      state.hidden.push(id);
    } else {
      state.hidden.splice(hidden, 1);
    }
    state.order = normalizeOrder(state.order, state.hidden);
    renderSections();
    afterEdit();
  }

  /* ============================================================
     the editor: load, dirty state, save
     ============================================================ */

  function fillEditor(profile) {
    byId("f-displayName").value = profile.displayName || "";
    byId("f-handle").value = profile.handle || "";
    byId("f-bio").value = profile.bio || "";
    byId("f-avatar").value = profile.avatar || "";
    byId("f-banner").value = profile.banner || "";
    byId("f-visibility").value = profile.visibility === "private" ? "private" : "public";
    byId("bio-count").textContent = String((profile.bio || "").length);

    state.links = (profile.links || []).map(function (l) { return { label: l.label, url: l.url }; });
    var shown = visibleOrder(profile);
    state.hidden = SECTION_IDS.filter(function (id) { return shown.indexOf(id) === -1; });
    state.order = normalizeOrder(shown, state.hidden);

    renderLinks();
    renderSections();
    clearFieldErrors();
    state.snapshot = JSON.stringify(draftPayload());
    markDirty();
    renderPreview();
  }

  function draftPayload() {
    return {
      displayName: byId("f-displayName").value.trim(),
      handle: byId("f-handle").value.trim().toLowerCase(),
      bio: byId("f-bio").value,
      avatar: byId("f-avatar").value.trim(),
      banner: byId("f-banner").value.trim(),
      visibility: byId("f-visibility").value,
      links: state.links,
      sections: ordered()
    };
  }

  /* What the preview shows: the draft, shaped like a profile row so the same
     renderer can draw it. */
  function draftProfile() {
    var payload = draftPayload();
    return {
      handle: payload.handle,
      displayName: payload.displayName,
      bio: payload.bio,
      avatar: payload.avatar,
      banner: payload.banner,
      links: payload.links,
      sections: payload.sections,
      visibility: payload.visibility
    };
  }

  function renderPreview() {
    renderProfile(byId("preview-out"), draftProfile(), { mine: true });
  }

  function markDirty() {
    var dirty = JSON.stringify(draftPayload()) !== state.snapshot;
    byId("save").disabled = state.loading || !dirty;
    byId("revert").disabled = !dirty;
    var label = byId("save-state");
    if (!dirty) {
      label.textContent = "Saved. Nothing changed since.";
      label.setAttribute("data-kind", "ok");
    } else {
      label.textContent = "Unsaved changes.";
      label.setAttribute("data-kind", "bad");
    }
  }

  function afterEdit() {
    markDirty();
    renderPreview();
  }

  function setSaveState(text, kind) {
    var label = byId("save-state");
    label.textContent = text;
    if (kind) label.setAttribute("data-kind", kind);
    else label.removeAttribute("data-kind");
  }

  function save(event) {
    if (event) event.preventDefault();
    if (state.loading) return;
    var payload = draftPayload();
    if (!payload.displayName) {
      setFieldErrors([{ field: "displayName", error: "cannot be empty" }]);
      return toast("A display name is required.");
    }
    state.loading = true;
    byId("save").disabled = true;
    setSaveState("Saving…");
    /* Every failure path has to leave the form usable: the save button is
       disabled while the request is in flight, and a refusal that did not
       re-enable it would be a form nobody can retry. The order matters —
       markDirty() writes the button's state and its own sentence, so the
       message for the refusal comes after it. */
    function failed(message) {
      markDirty();
      setSaveState(message, "bad");
    }
    api("/api/profile", { method: "PUT", body: JSON.stringify(payload) }).then(function (r) {
      state.loading = false;
      if (r.status === 200 && r.body.ok) {
        state.mine = r.body.profile;
        fillEditor(state.mine);
        loadProfileTab();
        setSaveState("Saved.", "ok");
        toast("Profile saved.");
        return;
      }
      if (r.status === 409) {
        setFieldErrors(r.body.fields || [{ field: "handle", error: "that handle is taken" }]);
        failed("That handle is taken — pick another one.");
        return;
      }
      if (r.status === 422) {
        var extra = setFieldErrors(r.body.fields);
        failed("The service refused some of it — see the fields above.");
        if (extra && extra.length) toast("Refused: " + extra.map(function (e) { return e.field + " " + e.error; }).join(", "));
        return;
      }
      if (r.status === 401) {
        state.session = null;
        failed("Your session has expired — sign in again.");
        loadProfileTab();
        return;
      }
      failed("Could not save — " + (r.body.error || ("status " + r.status)) + ".");
    });
  }

  /* ============================================================
     tabs
     ============================================================ */

  var VIEWS = ["profile", "editor", "vault", "shorts", "community"];

  function selectTab(name) {
    if (VIEWS.indexOf(name) === -1) name = "profile";
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      tab.setAttribute("aria-selected", tab.getAttribute("data-view") === name ? "true" : "false");
    });
    VIEWS.forEach(function (view) {
      byId("view-" + view).hidden = view !== name;
    });
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", "#" + name);
    }
    if (name === "editor") loadEditor();
  }

  function loadEditor() {
    var out = byId("editor-out");
    var status = byId("editor-status");
    if (!state.session || !state.session.signedIn) {
      out.hidden = true;
      status.hidden = false;
      byId("editor-status-text").textContent = "Sign in with Google to edit a profile. Your first sign-in creates one, with your Google name and picture already in it.";
      var actions = status.querySelector(".row");
      if (!actions) {
        actions = el("div", "row");
        actions.style.marginTop = "16px";
        status.appendChild(actions);
      }
      actions.textContent = "";
      var button = el("button", "vh-auth-google", "Sign in with Google");
      button.type = "button";
      button.addEventListener("click", function () {
        window.VH_AUTH.signIn().catch(function (err) { toast(String(err && err.message || err)); });
      });
      actions.appendChild(button);
      return;
    }
    if (!state.mine) {
      out.hidden = true;
      status.hidden = false;
      byId("editor-status-text").textContent = "Loading your profile…";
      api("/api/profile").then(function (r) {
        if (r.status === 200 && r.body.ok) {
          state.mine = r.body.profile;
          fillEditor(state.mine);
          showEditor();
        } else {
          byId("editor-status-text").textContent = "Could not load your profile — " + (r.body.error || ("status " + r.status)) + ".";
        }
      });
      return;
    }
    showEditor();
  }

  function showEditor() {
    byId("editor-status").hidden = true;
    byId("editor-out").hidden = false;
  }

  /* ============================================================
     boot
     ============================================================ */

  function boot() {
    fillLinkLabels();
    byId("link-add").addEventListener("click", addLink);
    byId("link-url").addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); addLink(); }
    });
    byId("editor").addEventListener("submit", save);
    byId("revert").addEventListener("click", function () {
      if (state.mine) { fillEditor(state.mine); setSaveState("Reverted to what is saved."); }
    });
    byId("f-bio").addEventListener("input", function () {
      byId("bio-count").textContent = String(byId("f-bio").value.length);
      afterEdit();
    });
    ["f-displayName", "f-handle", "f-avatar", "f-banner"].forEach(function (id) {
      byId(id).addEventListener("input", afterEdit);
    });
    byId("f-visibility").addEventListener("change", afterEdit);

    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      tab.addEventListener("click", function () { selectTab(tab.getAttribute("data-view")); });
    });

    api("/api/me").then(function (r) {
      state.session = r.body && r.body.ok ? r.body : { signedIn: false };
      loadProfileTab();
      var hash = (window.location.hash || "").replace(/^#/, "");
      if (VIEWS.indexOf(hash) !== -1) selectTab(hash);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
