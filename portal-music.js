/*
 * Portal ambience — lovingmyobstacles.mp3.
 *
 * Browsers block sound until the visitor interacts, so the track starts on
 * the first click / tap / key press anywhere, with a soft fade-in, and
 * loops forever. A corner speaker toggle mutes/unmutes; the choice is
 * remembered (localStorage 'vhPortalMuted'). Volume sits at 60% so it
 * reads as ambience, not a jukebox.
 */
(function () {
  'use strict';

  var SRC = 'lovingmyobstacles.mp3';
  var KEY = 'vhPortalMuted';
  var BASE_VOL = 0.6;

  var audio = null;
  var started = false;
  var muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) { /* private mode */ }

  var btn = null;
  var fadeTimer = null;

  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio(SRC);
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

  function start() {
    if (started) return;
    started = true;
    var a = ensureAudio();
    a.play().then(function () {
      if (!muted) fadeTo(BASE_VOL, 1800);
      updateBtn();
    }).catch(function () {
      // Some browsers need the interaction that spawned this to settle;
      // retry on the very next interaction.
      started = false;
      a.volume = 0;
    });
  }

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
      ensureAudio();
      if (muted) {
        fadeTo(0, 500);
        setTimeout(function () { if (muted && audio) audio.pause(); }, 550);
      } else {
        if (started) { audio.play().catch(function () {}); fadeTo(BASE_VOL, 800); }
        else start();
      }
      updateBtn();
    });
    document.body.appendChild(btn);
    updateBtn();
  }

  // First interaction anywhere starts the music (browser autoplay policy).
  var OPTS = { once: true, capture: true };
  function arm() {
    window.addEventListener('pointerdown', onFirst, OPTS);
    window.addEventListener('keydown', onFirst, OPTS);
    window.addEventListener('touchstart', onFirst, OPTS);
  }
  function onFirst() {
    window.removeEventListener('pointerdown', onFirst, OPTS);
    window.removeEventListener('keydown', onFirst, OPTS);
    window.removeEventListener('touchstart', onFirst, OPTS);
    start();
  }
  arm();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', makeToggle);
  } else {
    makeToggle();
  }
})();
