/*
 * Portal ambience — lovingmyobstacles.mp3.
 *
 * Speed strategy (why this loads fast now):
 *   1. fetch() the ENTIRE track into memory as a blob the moment the page
 *      opens — one shot, no media-element range-request dithering, so it
 *      finishes long before the visitor's first click in most cases.
 *   2. Try autoplay as soon as the blob is ready: browsers with a history
 *      of playing media on this site (Chrome's engagement index) allow it —
 *      returning visitors get instant music with zero clicks.
 *   3. If autoplay is blocked (first visit), the very first click/tap/key
 *      starts playback instantly from the in-memory blob — no buffering.
 *
 * A corner speaker toggle mutes/unmutes; the choice is remembered
 * (localStorage 'vhPortalMuted'). Volume 60% = ambience, not a jukebox.
 */
(function () {
  'use strict';

  var SRC = 'lovingmyobstacles.mp3';
  var KEY = 'vhPortalMuted';
  var BASE_VOL = 0.6;

  var audio = null;
  var blobUrl = null;
  var fetchStarted = false;
  var pendingStart = false;   // user interacted before the blob landed
  var muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) { /* private mode */ }

  var btn = null;
  var fadeTimer = null;

  // expose a peek handle for diagnostics/testing
  window.__portalMusic = { get ready() { return blobUrl !== null; } };

  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.loop = true;
    audio.volume = 0;
    audio.preload = 'auto';
    return audio;
  }

  /* ---------- fetch the whole track up front ---------- */

  function prefetch() {
    if (fetchStarted) return;
    fetchStarted = true;
    fetch(SRC)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (b) {
        blobUrl = URL.createObjectURL(b);
        // Returning-visitor fast path: try autoplay right away. If the
        // browser allows it, music starts with zero interaction.
        if (!muted) tryStart(true);
        updateBtn();
      })
      .catch(function () { /* network hiccup: first click retries via start() */ });
  }

  /* ---------- playback ---------- */

  function fadeTo(target, ms) {
    if (!audio) return;
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    var from = audio.volume;
    var t0 = Date.now();
    fadeTimer = setInterval(function () {
      var k = Math.min(1, (Date.now() - t0) / ms);
      audio.volume = from + (target - from) * k;
      if (k >= 1) { clearInterval(fadeTimer); fadeTimer = null; }
    }, 50);
  }

  function playFromBlob() {
    var a = ensureAudio();
    if (!blobUrl) {          // blob not landed yet: start the moment it does
      pendingStart = true;
      return false;
    }
    if (a.src !== blobUrl) a.src = blobUrl;
    a.play().then(function () {
      if (!muted) fadeTo(BASE_VOL, 1800);
      updateBtn();
    }).catch(function () {
      // Gesture needed after all: retry on next interaction.
      pendingStart = true;
    });
    return true;
  }

  function tryStart(fromAutoplay) {
    if (muted) return;
    if (!fromAutoplay) pendingStart = false;
    playFromBlob();
  }

  function start() { tryStart(false); }

  // blob landed but a click already happened (or autoplay just got allowed)
  function flushPending() {
    if (pendingStart && !muted) {
      pendingStart = false;
      playFromBlob();
    }
  }

  /* ---------- toggle UI ---------- */

  function updateBtn() {
    if (!btn) return;
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = muted ? 'Play portal music' : 'Mute portal music';
    btn.style.opacity = muted ? '0.45' : '0.85';
  }

  function makeToggle() {
    btn = document.createElement('button');
    btn.id = 'vh-portal-music-toggle';
    btn.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:9999',
      'width:44px', 'height:44px', 'border-radius:50%',
      'background:rgba(8,14,26,0.55)', 'color:#dce8ff',
      'border:1px solid rgba(140,180,255,0.35)', 'font-size:18px',
      'cursor:pointer', 'backdrop-filter:blur(4px)',
      'transition:opacity .2s, box-shadow .2s'
    ].join(';');
    btn.addEventListener('mouseenter', function () { btn.style.boxShadow = '0 0 14px rgba(90,150,255,0.45)'; });
    btn.addEventListener('mouseleave', function () { btn.style.boxShadow = 'none'; });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      muted = !muted;
      try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (err) { /* ignore */ }
      if (muted) {
        if (audio && !audio.paused) fadeTo(0, 500);
        setTimeout(function () { if (muted && audio) audio.pause(); }, 550);
      } else {
        start();
      }
      updateBtn();
    });
    document.body.appendChild(btn);
    updateBtn();
  }

  /* ---------- wiring ---------- */

  prefetch();   // download starts immediately, in parallel with the 3D city

  // First interaction anywhere: instant play from memory (or queue if the
  // blob is still landing — flushPending starts it the moment it arrives).
  var OPTS = { once: false, capture: true };
  function onFirst() {
    start();
    flushPending();
    window.removeEventListener('pointerdown', onFirst, OPTS);
    window.removeEventListener('keydown', onFirst, OPTS);
    window.removeEventListener('touchstart', onFirst, OPTS);
  }
  window.addEventListener('pointerdown', onFirst, OPTS);
  window.addEventListener('keydown', onFirst, OPTS);
  window.addEventListener('touchstart', onFirst, OPTS);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', makeToggle);
  } else {
    makeToggle();
  }
})();
