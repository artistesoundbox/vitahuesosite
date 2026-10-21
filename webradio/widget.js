/* Vita Hues Radio — floating widget.
 *
 * Drop this on any page:
 *   <script src="https://artistesoundbox.github.io/vitahuesosite/webradio/widget.js" defer></script>
 *
 * It adds a neon "ON AIR" launcher in the corner. Clicking it opens the live
 * player in a small iframe; the iframe follows the same station timeline as the
 * main site. No dependencies, no build step.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var base = script ? new URL('.', script.src).href : './';

  function boot() {
    if (document.querySelector('.vhw-launcher')) return;

    var style = document.createElement('style');
    style.textContent = [
      '.vhw-launcher{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:9px;',
      'padding:11px 16px 11px 13px;border-radius:999px;border:1px solid rgba(120,190,255,.45);',
      'background:rgba(5,11,21,.92);color:#eaf2ff;font:600 12px/1 "Segoe UI",system-ui,sans-serif;',
      'letter-spacing:.12em;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 26px rgba(56,182,255,.22);',
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transition:transform .18s ease,box-shadow .22s ease}',
      '.vhw-launcher:hover{transform:translateY(-2px);box-shadow:0 14px 38px rgba(0,0,0,.5),0 0 34px rgba(56,182,255,.4)}',
      '.vhw-launcher svg{width:16px;height:16px;fill:none;stroke:#6ee7ff;stroke-width:1.7}',
      '.vhw-dot{width:6px;height:6px;border-radius:50%;background:#ff4d7d;box-shadow:0 0 8px #ff4d7d;animation:vhw-pulse 1.8s ease-in-out infinite}',
      '@keyframes vhw-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '.vhw-panel{position:fixed;right:18px;bottom:74px;z-index:2147483000;width:min(360px,calc(100vw - 28px));',
      'border-radius:18px;overflow:hidden;border:1px solid rgba(120,190,255,.35);background:#04060d;',
      'box-shadow:0 24px 70px rgba(0,0,0,.7);opacity:0;transform:translateY(10px);pointer-events:none;transition:opacity .22s ease,transform .22s ease}',
      '.vhw-panel.is-open{opacity:1;transform:none;pointer-events:auto}',
      '.vhw-panel iframe{display:block;width:100%;height:104px;border:0;background:#04060d}',
      '.vhw-close{position:absolute;top:6px;right:6px;width:24px;height:24px;border-radius:50%;border:0;',
      'background:rgba(4,10,20,.7);color:#9fb6d4;font:14px/1 system-ui;cursor:pointer}',
      '.vhw-close:hover{color:#fff;background:rgba(56,182,255,.25)}'
    ].join('');
    document.head.appendChild(style);

    var panel = document.createElement('div');
    panel.className = 'vhw-panel';
    panel.innerHTML =
      '<iframe title="Vita Hues Radio" src="' + base + 'embed.html" loading="lazy" allow="autoplay"></iframe>' +
      '<button class="vhw-close" type="button" aria-label="Close radio player">×</button>';

    var launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'vhw-launcher';
    launcher.setAttribute('aria-label', 'Open Vita Hues Radio');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.innerHTML =
      '<span class="vhw-dot" aria-hidden="true"></span>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.2" fill="#6ee7ff" stroke="none"/>' +
      '<path d="M7.5 7.5a6.4 6.4 0 000 9M16.5 7.5a6.4 6.4 0 010 9M4.5 4.5a10.6 10.6 0 000 15M19.5 4.5a10.6 10.6 0 010 15"/></svg>' +
      'ON AIR';

    function setOpen(open) {
      panel.classList.toggle('is-open', open);
      launcher.setAttribute('aria-expanded', String(open));
      if (open) panel.querySelector('iframe').src = base + 'embed.html';
    }

    launcher.addEventListener('click', function () {
      setOpen(!panel.classList.contains('is-open'));
    });
    panel.querySelector('.vhw-close').addEventListener('click', function () {
      setOpen(false);
      launcher.focus();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && panel.classList.contains('is-open')) setOpen(false);
    });

    document.body.append(panel, launcher);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
