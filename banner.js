/*
 * Site banner — anthonitus.png at the top of every content page.
 * Included by game.html, movies.html and hemisync.html; the portal
 * (index.html) embeds its own in-column banner, and the splash page /
 * fullscreen game intentionally stay banner-free.
 *
 * Injects a centered banner as the first element of <body>. It is
 * position:relative + z-indexed so it paints above fixed cover/shade
 * layers (game.html) without being fixed itself — pages scroll normally.
 *
 * It also puts the sign-in chip under that banner, so every page that
 * includes this file shows who is signed in without each page having to
 * carry the markup. signin.js does the work — this only gives it a slot to
 * fill, which is why the chip says nothing at all when nobody is signed in
 * (a "Sign in with Google" button on a content page is an invitation where
 * the page wanted a name).
 */
(function () {
  'use strict';

  /* The helper's own classes, in one place, because these pages otherwise
     have no styles for them and a bare <button> would arrive looking like a
     form control from 1998. */
  function injectStyles() {
    if (document.getElementById('vh-auth-style')) return;
    var style = document.createElement('style');
    style.id = 'vh-auth-style';
    style.textContent =
      '.vh-auth{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:9px;' +
      'min-height:30px;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.08em;}' +
      '.vh-auth img{width:26px;height:26px;border-radius:50%;display:block;}' +
      '.vh-auth span{font-weight:600;color:#cfe4ff;}' +
      '.vh-auth button{font:inherit;letter-spacing:.08em;cursor:pointer;padding:5px 11px;' +
      'border-radius:8px;border:1px solid rgba(207,228,255,.3);background:transparent;color:#cfe4ff;}' +
      '.vh-auth button:hover{border-color:#7cc4ff;color:#7cc4ff;}' +
      '.vh-auth button:disabled{opacity:.6;cursor:progress;}' +
      '.vh-auth .vh-auth-google{background:#1a73e8;border-color:#1a73e8;color:#fff;font-weight:600;}' +
      '.vh-auth .vh-auth-google:hover{color:#fff;filter:brightness(1.08);}' +
      '.vh-auth[data-error]::after{content:attr(data-error);flex:1 0 100%;margin-top:6px;' +
      'color:#ffb4b4;font-size:12px;}';
    document.head.appendChild(style);
  }

  /* The slot. signin.js is included before this file, so VH_AUTH exists by the
     time this runs — but a page that forgot the include should lose the chip,
     not its banner. */
  function mountAuth() {
    if (document.getElementById('vh-site-auth')) return;
    injectStyles();
    var row = document.createElement('div');
    row.id = 'vh-site-auth';
    /* click-through like the banner: a full-width strip near the top would
       otherwise swallow clicks aimed at links sitting under it (game.html's
       Back/Home are exactly there). Only the chip itself takes the pointer. */
    row.style.cssText =
      'text-align:center;padding:10px 10px 0;position:relative;z-index:20;pointer-events:none;';
    var slot = document.createElement('div');
    slot.setAttribute('data-vh-auth', '');
    slot.style.pointerEvents = 'auto';
    row.appendChild(slot);

    var banner = document.getElementById('vh-site-banner');
    if (banner && banner.parentNode === document.body) {
      document.body.insertBefore(row, banner.nextSibling);
    } else {
      document.body.insertBefore(row, document.body.firstChild);
    }

    /* Filling it is signin.js's job — mount() is the same call a page makes by
       hand, passed a root so it stays in this element. The two ways this can
       already be done are skipped rather than repeated: signin.js's own mount
       runs at DOMContentLoaded (and leaves "…" the moment it starts), and
       this may run before signin.js was even parsed. Mounting twice would
       draw the chip twice. */
    var fill = function () {
      if (!window.VH_AUTH) return;
      if (slot.childElementCount || slot.textContent) return;
      window.VH_AUTH.mount(slot);
    };
    fill();
    window.addEventListener('load', fill);
  }

  function mount() {
    if (!document.getElementById('vh-site-banner')) {
      var wrap = document.createElement('div');
      wrap.id = 'vh-site-banner';
      // wrapper is click-THROUGH: its full-width box used to swallow clicks on
      // game.html's Back/Home links that sit under it. Only the image itself
      // catches the pointer.
      wrap.style.cssText =
        'text-align:center;padding:14px 10px 0;line-height:0;' +
        'position:relative;z-index:20;pointer-events:none;';
      var img = document.createElement('img');
      img.src = 'anthonitus.png';
      img.alt = 'Anthonitus';
      img.style.cssText =
        'display:inline-block;width:min(360px,70vw);height:auto;' +
        'filter:drop-shadow(0 0 18px rgba(80,150,255,0.35));' +
        'pointer-events:none;';
      wrap.appendChild(img);
      document.body.insertBefore(wrap, document.body.firstChild);
    }
    mountAuth();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
