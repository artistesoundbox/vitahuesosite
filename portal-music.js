/*
 * Portal ambience — lovingmyobstacles.mp3.
 *
 * Auto-start strategy:
 *   1. The <audio> element is created and pointed at the track THE MOMENT
 *      the page opens — the download starts immediately, in parallel with
 *      the 3D city, and playback begins as soon as the browser has
 *      buffered the first moments of audio (no waiting for the full file).
 *   2. Autoplay is attempted right away and again on every interaction:
 *      browsers that have seen media played on this site before (Chrome
 *      engagement) allow it — returning visitors get music with zero
 *      clicks. First-time visitors get it on their first tap/key anywhere.
 *   3. No nag UI: if a browser blocks autoplay, the fallback is silent —
 *      the page simply waits for the first interaction and starts.
 *
 * Music only plays while the portal is actually on screen: leaving the
 * page pauses it (navigation destroys the page on desktop; mobile
 * back-forward-cache restores get an instant resume via pageshow).
 *
 * A corner speaker toggle mutes/unmutes for the CURRENT visit only —
 * every fresh page load tries music again (no remembered-mute trap
 * leaving a browser silent forever). Volume 60% = ambience.
 */
(function () {
  'use strict';

  var SRC = 'lovingmyobstacles.mp3';
  var BASE_VOL = 0.6;

  var audio = null;
  var muted = false;

  var btn = null;
  var fadeTimer = null;

  // diagnostics handle
  window.__portalMusic = {
    get ready() { return !!audio && audio.readyState >= 2; },
    get playing() { return isLive(); },
  };

  function isLive() {
    return !!(audio && !audio.paused && !audio.ended && audio.currentTime > 0);
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio(SRC);   // streaming: the download starts right now
    audio.loop = true;
    audio.volume = 0;
    audio.preload = 'auto';
    return audio;
  }

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

  function onLive() {
    if (!muted) fadeTo(BASE_VOL, 1600);
    updateBtn();
  }

  function tryStart() {
    if (muted) return;
    ensureAudio();
    var p = audio.play();
    if (p && p.then) p.then(onLive).catch(function () { /* blocked: silent */ });
  }

  /* ---------- interaction retries (until audio is genuinely live) ---------- */

  var OPTS = { capture: true };
  function detachFirst() {
    window.removeEventListener('pointerdown', onFirst, OPTS);
    window.removeEventListener('keydown', onFirst, OPTS);
    window.removeEventListener('touchstart', onFirst, OPTS);
  }
  function onFirst() {
    if (isLive()) { detachFirst(); return; }   // autoplay already won
    if (!muted) tryStart();                    // instant from buffered stream
  }
  window.addEventListener('pointerdown', onFirst, OPTS);
  window.addEventListener('keydown', onFirst, OPTS);
  window.addEventListener('touchstart', onFirst, OPTS);

  /* ---------- leaving and coming back ----------
     Desktop navigation away destroys the page — audio dies naturally.
     Mobile browsers often keep the page in the back-forward cache, so:
     pagehide pauses the track; pageshow (restored) resumes it instantly. */
  window.addEventListener('pagehide', function () {
    if (audio && !audio.paused) { try { audio.pause(); } catch (e) { /* ignore */ } }
  });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) {   // restored from back-forward cache
      if (!muted) tryStart();
    }
  });

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
      if (muted) {
        if (audio && !audio.paused) fadeTo(0, 500);
        setTimeout(function () { if (muted && audio) audio.pause(); }, 550);
      } else {
        tryStart();
      }
      updateBtn();
    });
    document.body.appendChild(btn);
    updateBtn();
  }

  /* ---------- boot ---------- */

  ensureAudio();            // streaming download starts at page open
  if (!muted) tryStart();   // autoplay attempt right away (returning visitors)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', makeToggle);
  } else {
    makeToggle();
  }
})();
