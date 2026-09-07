/*
 * Portal ambience — lovingmyobstacles.mp3.
 *
 * Instant-start strategy:
 *   1. The <audio> element is created and pointed at the track THE MOMENT
 *      the page opens — the download starts immediately, in parallel with
 *      the 3D city, and playback begins as soon as the browser has
 *      buffered the first moments of audio (no waiting for the full file).
 *   2. Autoplay is attempted right away: browsers that have seen media
 *      played on this site before (Chrome engagement) allow it — returning
 *      visitors get music with zero clicks.
 *   3. If autoplay is blocked, the very first click/tap/key starts playback
 *      instantly from the already-buffering stream, and a small "TAP FOR
 *      MUSIC" pill (top-right) makes that obvious while blocked.
 *
 * Music only plays while the portal is actually on screen: leaving the
 * page pauses it (navigation destroys the page on desktop; mobile
 * back-forward-cache restores get an instant resume via pageshow).
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
  var pendingStart = false;   // autoplay blocked — waiting for a gesture
  var muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) { /* private mode */ }

  var btn = null;
  var pill = null;
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
    pendingStart = false;
    if (!muted) fadeTo(BASE_VOL, 1600);
    updateBtn();
    syncPill();
  }

  function tryStart() {
    if (muted) { syncPill(); return; }
    ensureAudio();
    var p = audio.play();
    if (p && p.then) {
      p.then(onLive).catch(function () {
        // gesture required — the stream keeps buffering; surface the pill
        pendingStart = true;
        syncPill();
      });
    }
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
    if (!muted) {
      pendingStart = false;
      tryStart();                              // instant from buffered stream
    }
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
      syncPill();
    }
  });

  /* ---------- toggle UI ---------- */

  function updateBtn() {
    if (!btn) return;
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = muted ? 'Play portal music' : 'Mute portal music';
    btn.style.opacity = muted ? '0.45' : '0.85';
  }

  /* Visible rescue pill (top-right): whenever music is NOT playing but the
     visitor clearly wants it (muted in a past visit, or autoplay blocked),
     a big obvious "TAP FOR MUSIC" appears. Hidden the moment audio lives. */
  function syncPill() {
    if (!pill) return;
    var show = !isLive() && (muted || pendingStart);
    pill.style.display = show ? 'flex' : 'none';
  }

  function makePill() {
    pill = document.createElement('button');
    pill.id = 'vh-portal-music-pill';
    pill.textContent = '🔊 TAP FOR MUSIC';
    pill.style.cssText = [
      'position:fixed', 'top:18px', 'right:18px',
      'z-index:9999', 'display:none', 'align-items:center',
      'padding:10px 20px', 'border-radius:999px', 'cursor:pointer',
      'background:rgba(8,14,26,0.72)', 'color:#dce8ff',
      'border:1px solid rgba(140,180,255,0.45)', 'font-size:13px',
      'letter-spacing:0.12em', 'font-family:inherit', 'backdrop-filter:blur(6px)'
    ].join(';');
    var st = document.createElement('style');
    st.textContent = '@keyframes vhMusicPulse{0%,100%{box-shadow:0 0 10px rgba(90,150,255,0.15)}50%{box-shadow:0 0 24px rgba(90,150,255,0.5)}}';
    document.head.appendChild(st);
    pill.style.animation = 'vhMusicPulse 2.4s ease-in-out infinite';
    pill.addEventListener('click', function (e) {
      e.stopPropagation();
      if (muted) {
        muted = false;
        try { localStorage.setItem(KEY, '0'); } catch (err) { /* private mode */ }
      }
      pendingStart = false;
      tryStart();
    });
    document.body.appendChild(pill);
    syncPill();
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
        pendingStart = false;
        tryStart();
      }
      updateBtn();
      syncPill();
    });
    document.body.appendChild(btn);
    updateBtn();
  }

  /* ---------- boot ---------- */

  ensureAudio();            // streaming download starts at page open
  if (!muted) tryStart();   // autoplay attempt right away (returning visitors)

  function mountAll() {
    makeToggle();
    makePill();
    syncPill();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll);
  } else {
    mountAll();
  }
})();
