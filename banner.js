/*
 * Site banner — anthonitus.png at the top of every content page.
 * Included by game.html, movies.html and hemisync.html; the portal
 * (index.html) embeds its own in-column banner, and the splash page /
 * fullscreen game intentionally stay banner-free.
 *
 * Injects a centered banner as the first element of <body>. It is
 * position:relative + z-indexed so it paints above fixed cover/shade
 * layers (game.html) without being fixed itself — pages scroll normally.
 */
(function () {
  'use strict';
  function mount() {
    if (document.getElementById('vh-site-banner')) return;
    var wrap = document.createElement('div');
    wrap.id = 'vh-site-banner';
    wrap.style.cssText =
      'text-align:center;padding:14px 10px 0;line-height:0;' +
      'position:relative;z-index:20;';
    var img = document.createElement('img');
    img.src = 'anthonitus.png';
    img.alt = 'Anthonitus';
    img.style.cssText =
      'display:inline-block;width:min(360px,70vw);height:auto;' +
      'filter:drop-shadow(0 0 18px rgba(80,150,255,0.35));';
    wrap.appendChild(img);
    document.body.insertBefore(wrap, document.body.firstChild);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
