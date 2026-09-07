/*
 * PWA install chip.
 *
 * Installing anthonitus.com as an app is Chrome's official unlock for
 * first-entry audio autoplay ("added the site to their home screen on
 * mobile or installed the PWA on desktop"). Once installed, the portal
 * music starts on entry — PC and Android — with zero clicks.
 *
 * Shows a small "Install app" pill when the browser fires
 * beforeinstallprompt; tapping it opens the native install dialog.
 * On iOS (no install prompt) the chip stays hidden — visitors use
 * Share → "Add to Home Screen" instead.
 */
(function () {
  'use strict';

  var deferred = null;
  var KEY = 'vhInstallDismissed';

  function chip() {
    if (document.getElementById('vh-install-chip')) return;
    var b = document.createElement('button');
    b.id = 'vh-install-chip';
    b.textContent = '⤓ Install app';
    b.title = 'Install as an app — unlocks instant music on entry';
    b.style.cssText = [
      'position:fixed', 'left:18px', 'bottom:18px', 'z-index:9999',
      'padding:9px 16px', 'border-radius:999px', 'font-size:12px',
      'letter-spacing:0.14em', 'text-transform:uppercase',
      'color:#dce8ff', 'background:rgba(8,14,26,0.55)',
      'border:1px solid rgba(140,180,255,0.35)', 'cursor:pointer',
      'backdrop-filter:blur(4px)', 'font-family:inherit',
      'transition:box-shadow .2s, opacity .2s'
    ].join(';');
    b.addEventListener('mouseenter', function () { b.style.boxShadow = '0 0 14px rgba(90,150,255,0.45)'; });
    b.addEventListener('mouseleave', function () { b.style.boxShadow = 'none'; });
    b.addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; b.remove(); });
    });
    document.body.appendChild(b);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (localStorage.getItem(KEY) !== '1') chip();
  });

  window.addEventListener('appinstalled', function () {
    localStorage.setItem(KEY, '1');
    var b = document.getElementById('vh-install-chip');
    if (b) b.remove();
  });

  // dismissed? stop nagging for 30 days
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('vh-install-chip');
    if (!b) return;
    b.addEventListener('contextmenu', function () {
      localStorage.setItem(KEY, String(Date.now()));
    });
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* harmless */ });
    });
  }
})();
