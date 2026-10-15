/* ============================================================
   signin.js — "Sign in with Google" for the static pages.

   The site is static; the sign-in itself happens in a Worker (see auth/).
   This file is the only thing a page needs, and it is the whole of the
   client side:

     <script src="/vitahuesosite/signin.js"></script>
     <div data-vh-auth></div>          <!-- the control fills itself in -->

   or call it directly:

     VH_AUTH.signIn()      → goes to Google and comes back to this page
     VH_AUTH.whoAmI()      → { signedIn, user: { id, name, picture } }
     VH_AUTH.identity()    → a short-lived signed name for the leaderboard
     VH_AUTH.signOut()

   WHY `credentials: "include"` IS ON EVERY CALL
   The session is a cookie on the Worker's origin, and this page is on a
   different site, so without it the browser sends nothing and every call
   would report "signed out" while the cookie sat there perfectly valid.
   It is also why the Worker answers with one exact Origin instead of `*`,
   and why the cookie is SameSite=None: all three are the same fact.

   WHY THE REDIRECT IS SET BY HAND
   The sign-in POST is answered with JSON — `{ url }` — because the fetch
   sends `x-auth-return-redirect`; the browser is then sent to Google with
   a plain `location.href`. Letting fetch follow the redirect instead would
   turn the trip to Google into a CORS request, which Google does not
   answer, so nothing would happen and the console would blame CORS.

   IT IS SWITCHED OFF SITE-WIDE RIGHT NOW — see SIGNIN_UI below. The API
   still answers; nobody is offered the button.
   ============================================================ */
(function () {
  "use strict";

  /* --------------------------------------------------------------- switch
     Google sign-in is off on the site for now: `false` here means no page
     draws the button, and none draws the chip that replaces it once
     somebody is signed in. It also means no /api/me round trip, which is
     the point — a visible button would send people to a Worker whose
     Google credentials are not configured yet, and they would land on its
     503 instead of on a game.

     Nothing else is deleted. The API below is untouched, so the Grand Prix
     board's identity() and the portal's signIn() keep working, and the
     server half (auth/) does not know this switch exists.

     Back on is `true`. Two pages will still need their slot returned, because
     the slot is markup and was deleted with the button:
       · banner.js  — the chip row it used to inject under the site banner
       · index.html — <div id="site-signin" data-vh-auth></div>, plus the
                      #site-signin rules in its stylesheet
     Any other page that wants the button back only has to carry
     <div data-vh-auth></div> again, which is how it was documented. */
  var SIGNIN_UI = false;

  /* The deployed Worker. Edit here if it is ever redeployed elsewhere. */
  var DEFAULT_API = "https://site-9066bb3e67224190b78bd63d0ca6bb1e.freebuff.page";

  function api() {
    if (window.VH_AUTH_API) return String(window.VH_AUTH_API).replace(/\/+$/, "");
    /* A local override, for working on the page without the deployed
       Worker: ?api=http://127.0.0.1:8178 — accepted only on loopback, so
       a link cannot point somebody else's page at another server. */
    try {
      var want = new URLSearchParams(window.location.search).get("api");
      var host = window.location.hostname;
      var local = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
      if (want && local && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(want)) {
        return want.replace(/\/+$/, "");
      }
    } catch (e) { /* no URLSearchParams: fall through to the deployed Worker */ }
    return DEFAULT_API;
  }

  function call(path, options) {
    var opts = options || {};
    opts.credentials = "include";
    opts.mode = "cors";
    if (opts.headers) opts.headers = Object.assign({}, opts.headers);
    return fetch(api() + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body };
      });
    });
  }

  /* Auth.js only accepts a sign-in POST that carries its CSRF token, so the
     token is fetched first and sent in the body. Cheap, and the alternative
     (skipping it) is a request the Worker refuses.

     The Worker's own words are carried out of here rather than invented
     ones: its 503 says which variable is missing, and that is the sentence
     somebody needs when a sign-in button does nothing. A generic "could not
     start sign-in" would hide it. */
  function csrf() {
    return call("/api/auth/csrf").then(function (r) {
      var token = r.body && r.body.csrfToken;
      if (token) return token;
      var why = (r.body && (r.body.error || r.body.detail)) || ("status " + r.status);
      throw new Error("the sign-in service refused to start: " + why);
    });
  }

  function form(fields) {
    return Object.keys(fields).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]);
    }).join("&");
  }

  var VH_AUTH = {
    api: api,

    whoAmI: function () {
      return call("/api/me").then(function (r) {
        return r.body && r.body.ok ? r.body : { ok: false, signedIn: false, user: null, status: r.status };
      });
    },

    /* Straight to Google. The page that calls this is where Google is told
       to bring the player back to, and the Worker only honours that if the
       page is on the site origin — an off-list target lands on the Worker
       instead of on somebody else's site with a fresh session. */
    signIn: function (returnTo) {
      var back = returnTo || window.location.href.split("#")[0];
      return csrf().then(function (token) {
        return call("/api/auth/signin/google", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-auth-return-redirect": "1"
          },
          body: form({ csrfToken: token, callbackUrl: back })
        });
      }).then(function (r) {
        var url = r.body && r.body.url;
        if (!url) {
          throw new Error((r.body && (r.body.error || r.body.detail)) || "could not start sign-in (status " + r.status + ")");
        }
        window.location.href = url;
      });
    },

    signOut: function (returnTo) {
      var back = returnTo || window.location.href.split("#")[0];
      return csrf().then(function (token) {
        return call("/api/auth/signout", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-auth-return-redirect": "1"
          },
          body: form({ csrfToken: token, callbackUrl: back })
        });
      }).then(function (r) {
        var url = r.body && r.body.url;
        window.location.href = url || back;
      });
    },

    /* Verified by the leaderboard with the shared identity secret. Short
       lived on purpose: it is a name, not a key. */
    identity: function () {
      return call("/api/identity").then(function (r) {
        return r.body && r.body.ok ? r.body : null;
      });
    },

    /* Renders into every [data-vh-auth] on the page. Given a root, it renders
       into that element when the element *is* a slot, and into the slots
       inside it otherwise — a caller passing the slot it just created is the
       obvious way to use this, and querySelectorAll on the element alone
       would find nothing and leave an empty box behind. */
    mount: function (root) {
      /* Off means off — see SIGNIN_UI at the top. Every slot is left exactly
         as the page wrote it (empty), and nobody is asked who they are, so
         a page with a slot costs no request and shows no error. */
      if (!SIGNIN_UI) return;
      var scope = root || document;
      var nodes = Array.prototype.slice.call(scope.querySelectorAll("[data-vh-auth]"));
      if (scope !== document && scope.hasAttribute && scope.hasAttribute("data-vh-auth") &&
          nodes.indexOf(scope) === -1) {
        nodes.unshift(scope);
      }
      nodes.forEach(function (el) {
        el.classList.add("vh-auth");
        el.textContent = "…";
        VH_AUTH.whoAmI().then(function (me) {
          el.textContent = "";
          if (me.signedIn && me.user) {
            if (me.user.picture) {
              var img = document.createElement("img");
              img.src = me.user.picture;
              img.alt = "";
              img.referrerPolicy = "no-referrer";
              el.appendChild(img);
            }
            var name = document.createElement("span");
            name.textContent = me.user.name || "signed in";
            el.appendChild(name);
            var out = document.createElement("button");
            out.type = "button";
            out.textContent = "Sign out";
            out.addEventListener("click", function () { VH_AUTH.signOut(); });
            el.appendChild(out);
            return;
          }
          var button = document.createElement("button");
          button.type = "button";
          button.className = "vh-auth-google";
          button.textContent = "Sign in with Google";
          button.addEventListener("click", function () {
            button.disabled = true;
            VH_AUTH.signIn().catch(function (err) {
              button.disabled = false;
              el.setAttribute("data-error", String(err && err.message || err));
            });
          });
          el.appendChild(button);
        });
      });
    }
  };

  window.VH_AUTH = VH_AUTH;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { VH_AUTH.mount(); });
  } else {
    VH_AUTH.mount();
  }
})();
