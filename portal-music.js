/*
 * Portal ambience — lovingmyobstacles.mp3.
 *
 * Auto-start strategy (works with, not against, browser autoplay rules):
 *   1. The <audio> element is created THE MOMENT the page opens — the
 *      download starts immediately, in parallel with the 3D city.
 *   2. Unmuted autoplay is attempted right away: browsers that have seen
 *      the visitor interact with this domain before (returning visitors,
 *      back-navigation) allow it — music with zero clicks.
 *   3. If the browser blocks audible autoplay (first-ever visit rules),
 *      the track keeps playing MUTED — Chrome always allows muted
 *      playback — so it is fully buffered and rolling. The FIRST tap or
 *      key anywhere unmutes it: instant sound, zero buffering wait.
 *   4. No nag UI. The fallback is silence-then-instant, not a button.
 *
 * Music only plays while the portal is actually on screen: leaving the
 * page pauses it (navigation destroys the page on desktop; mobile
 * back-forward-cache restores get an instant resume via pageshow).
 *
 * The corner speaker toggle mutes/unmutes for the CURRENT visit only —
 * every fresh page load tries music again. Volume 60% = ambience.
 */
(function () {
  'use strict';

  var SRC = 'lovingmyobstacles.mp3';
  var BASE_VOL = 0.6;

  var audio = null;
  var userMuted = false;   // the speaker toggle (current visit only)

  var btn = null;
  var fadeTimer = null;

  // diagnostics handle
  window.__portalMusic = {
    get ready() { return !!audio && audio.readyState >= 2; },
    get playing() { return isLive(); },
    get silentStart() { return !!(audio && audio.muted); }, // parked muted, waiting for a gesture
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
    if (!userMuted) fadeTo(BASE_VOL, 1600);
    updateBtn();
  }

  /* Park the stream playing-but-silent (muted autoplay is always allowed).
     A gesture later unmutes it into instant sound. */
  function startMuted() {
    ensureAudio();
    if (audio.muted) return;
    audio.muted = true;
    var p = audio.play();
    if (p && p.then) p.catch(function () { /* even muted blocked: just wait */ });
  }

  function audibleFromMuted() {
    if (!audio) return;
    audio.muted = false;
    fadeTo(BASE_VOL, 1200);
    updateBtn();
  }

  function tryStart() {
    if (userMuted) return;
    ensureAudio();
    var p = audio.play();
    if (p && p.then) {
      p.then(onLive).catch(function () { startMuted(); });
    } else {
      onLive(); // legacy browsers: assume it plays
    }
  }

  /* ---------- gestures: until the track is genuinely audible ---------- */

  var OPTS = { capture: true };
  function detachFirst() {
    window.removeEventListener('pointerdown', onFirst, OPTS);
    window.removeEventListener('keydown', onFirst, OPTS);
    window.removeEventListener('touchstart', onFirst, OPTS);
  }
  function onFirst() {
    if (userMuted) { if (isLive()) detachFirst(); return; }
    if (isLive() && !audio.muted) { detachFirst(); return; }  // autoplay already won
    if (isLive() && audio.muted) { audibleFromMuted(); detachFirst(); return; }
    tryStart();   // this gesture makes audible playback legal
    detachFirst();
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
      if (!userMuted) tryStart();
    }
  });

  /* ---------- toggle UI ---------- */

  function updateBtn() {
    if (!btn) return;
    btn.textContent = userMuted ? '🔇' : '🔊';
    btn.title = userMuted ? 'Play portal music' : 'Mute portal music';
    btn.style.opacity = userMuted ? '0.45' : '0.85';
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
      // silent-start state: the toggle acts as the "make it audible" click
      if (!userMuted && audio && audio.muted && isLive()) { audibleFromMuted(); return; }
      userMuted = !userMuted;
      if (userMuted) {
        if (audio && !audio.paused) fadeTo(0, 500);
        setTimeout(function () { if (userMuted && audio) audio.pause(); }, 550);
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
  tryStart();               // audible attempt now; muted parking on refusal

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', makeToggle);
  } else {
    makeToggle();
  }
})();
