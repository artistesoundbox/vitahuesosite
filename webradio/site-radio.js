/* Vita Hueso Radio — site-wide dock.
 *
 * Add to any page (path adjusted for depth):
 *   <script type="module" src="webradio/site-radio.js"></script>
 *
 * The button/label is opt-in: a page shows an "Enable radio" button with
 * id="vh-enable-radio". Once enabled, a compact dock appears on every page
 * that includes this script and rejoins the live broadcast automatically.
 *
 * Why the dock re-joins instead of literally continuing: browsers tear down
 * the document (and its audio) on every normal page navigation. This dock
 * therefore restores playback at the station's current position on each page,
 * so you stay on the live timeline with only a short hand-off gap. On browsers
 * that block autoplay after navigation, the dock appears paused and resumes on
 * the first tap.
 *
 * It also silences the portal's welcome track (portal-music.js) when enabled,
 * and hides that page's speaker toggle while the station is on.
 */
import { radio } from './js/player.js';

const STATION_BASE = new URL('./', import.meta.url).href;
radio.setBase(STATION_BASE);

const KEY_ON = 'vh.site.radio';
const KEY_INTENT = 'vh.site.radio.intent';

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5.5v13L16 12z" fill="currentColor"/><path d="M17 5h2v14h-2z" fill="currentColor"/></svg>',
  volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M15 9a4 4 0 010 6M17.5 6.5a8 8 0 010 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3l4-3.5v12l-4-3.5H4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M15.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>'
};

const read = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key, value) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* ignore */ }
};

const isOn = () => read(KEY_ON) === '1';
const hasIntent = () => read(KEY_INTENT) !== '0';

let dock = null;
let els = null;
let toggleButton = null;

/* ------------------------------------------------------------------ styles */

function injectStyles() {
  if (document.getElementById('vhr-styles')) return;
  const style = document.createElement('style');
  style.id = 'vhr-styles';
  style.textContent = `
    html.vhr-on #vh-portal-music-toggle { display: none !important; }

    #vhr-dock {
      position: fixed; left: 16px; bottom: 16px; z-index: 9998;
      display: none;
      grid-template-columns: 46px minmax(0, 1fr) auto;
      align-items: center; gap: 10px;
      width: min(400px, calc(100vw - 32px));
      padding: 9px 8px 10px 9px;
      border-radius: 14px;
      border: 1px solid rgba(110, 185, 255, 0.4);
      background: linear-gradient(150deg, rgba(90, 160, 255, 0.09), transparent 55%), rgba(6, 12, 22, 0.94);
      box-shadow: 0 16px 38px rgba(0, 0, 0, 0.55), 0 0 28px rgba(56, 182, 255, 0.12);
      backdrop-filter: blur(16px) saturate(140%);
      -webkit-backdrop-filter: blur(16px) saturate(140%);
      color: #eaf2ff;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      box-sizing: border-box;
      overflow: hidden;
    }
    #vhr-dock.is-on { display: grid; }

    #vhr-dock .vhr-art {
      position: relative; display: block; width: 46px; height: 46px;
      border-radius: 9px; overflow: hidden; background: #050a13;
      border: 1px solid rgba(120, 190, 255, 0.28);
      text-decoration: none;
    }
    #vhr-dock .vhr-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
    #vhr-dock .vhr-art::after {
      content: ""; position: absolute; inset: 0; border-radius: 8px;
      box-shadow: inset 0 0 14px rgba(56, 182, 255, 0.18);
      pointer-events: none;
    }

    #vhr-dock .vhr-meta { min-width: 0; }
    #vhr-dock .vhr-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
    #vhr-dock .vhr-badge {
      flex: none; font-size: 8px; font-weight: 700; letter-spacing: 0.14em;
      padding: 2px 6px; border-radius: 4px;
      color: #6ee7ff; border: 1px solid rgba(56, 182, 255, 0.4);
      background: rgba(56, 182, 255, 0.1);
    }
    #vhr-dock .vhr-badge.is-personal {
      color: #c9bcff; border-color: rgba(124, 92, 255, 0.45);
      background: rgba(124, 92, 255, 0.12);
    }
    #vhr-dock .vhr-title {
      font-size: 12px; font-weight: 600; color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #vhr-dock .vhr-sub {
      margin-top: 2px; font-size: 10.5px; color: #8fa5c2;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #vhr-dock .vhr-rejoin {
      flex: none; border: 1px solid rgba(124, 92, 255, 0.45); border-radius: 999px;
      background: rgba(124, 92, 255, 0.14); color: #d6ccff;
      font: 600 8.5px/1 "Segoe UI", system-ui, sans-serif; letter-spacing: 0.08em;
      padding: 3px 7px; cursor: pointer;
    }
    #vhr-dock .vhr-rejoin:hover { background: rgba(124, 92, 255, 0.28); color: #fff; }
    #vhr-dock .vhr-rejoin[hidden] { display: none; }

    #vhr-dock .vhr-controls { display: flex; align-items: center; gap: 1px; }
    #vhr-dock .vhr-btn {
      display: grid; place-items: center; width: 30px; height: 30px;
      padding: 0; border: 0; border-radius: 50%; background: transparent;
      color: #c7d7ea; cursor: pointer; transition: background 0.16s ease, color 0.16s ease;
    }
    #vhr-dock .vhr-btn:hover { background: rgba(120, 180, 255, 0.14); color: #fff; }
    #vhr-dock .vhr-btn svg { width: 16px; height: 16px; }
    #vhr-dock .vhr-btn:focus-visible { outline: 2px solid #6ee7ff; outline-offset: 1px; }
    #vhr-dock .vhr-play {
      width: 34px; height: 34px; color: #021019;
      background: linear-gradient(140deg, #d7f6ff, #6ee7ff 42%, #38b6ff 78%);
      box-shadow: 0 4px 14px rgba(56, 182, 255, 0.42);
    }
    #vhr-dock .vhr-play:hover { background: linear-gradient(140deg, #fff, #a5edff 42%, #38b6ff 78%); color: #021019; }
    #vhr-dock .vhr-play svg { width: 17px; height: 17px; }
    #vhr-dock.is-blocked .vhr-play { animation: vhr-nudge 1.6s ease-in-out infinite; }
    @keyframes vhr-nudge {
      0%, 100% { box-shadow: 0 4px 14px rgba(56, 182, 255, 0.42); }
      50% { box-shadow: 0 0 0 5px rgba(56, 182, 255, 0.16), 0 4px 18px rgba(56, 182, 255, 0.6); }
    }

    #vhr-dock .vhr-progress {
      position: absolute; left: 9px; right: 9px; bottom: 4px; height: 2px;
      border-radius: 99px; background: rgba(120, 180, 255, 0.12); overflow: hidden;
    }
    #vhr-dock .vhr-progress span {
      display: block; height: 100%; width: 0;
      background: linear-gradient(90deg, #38b6ff, #6ee7ff);
      transition: width 0.4s linear;
    }

    #vh-enable-radio {
      pointer-events: auto;
      display: flex; align-items: center; justify-content: center; gap: 9px;
      width: max-content; margin: 0 auto 14px;
      padding: 10px 18px;
      border-radius: 999px;
      border: 1px solid rgba(90, 180, 255, 0.55);
      background: rgba(5, 12, 24, 0.85);
      color: #dff3ff;
      font-family: "Courier New", Courier, monospace;
      font-size: 12px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
      cursor: pointer;
      backdrop-filter: blur(10px);
      box-shadow: 0 0 22px rgba(50, 160, 255, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.07);
      transition: box-shadow 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
    }
    #vh-enable-radio:hover {
      border-color: rgba(140, 220, 255, 0.9);
      box-shadow: 0 0 28px rgba(80, 190, 255, 0.42);
      transform: translateY(-1px);
    }
    #vh-enable-radio .vhr-btn-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #6ee7ff; box-shadow: 0 0 10px #38b6ff;
    }
    #vh-enable-radio.is-on { border-color: rgba(110, 231, 255, 0.8); }
    #vh-enable-radio.is-on .vhr-btn-dot {
      background: #ff4d7d; box-shadow: 0 0 10px #ff4d7d;
      animation: vhr-pulse 1.8s ease-in-out infinite;
    }
    @keyframes vhr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* The PWA install chip (install.js) is fixed to the same bottom-left
       corner as the dock, so it used to sit on top of the player. Lift it
       clear of the dock while the radio is on — the inline style in
       install.js is why this rule needs !important. */
    html.vhr-on #vh-install-chip {
      bottom: calc(16px + var(--vhr-dock-h, 76px) + 10px) !important;
    }

    /* A scrolling portal page keeps its last card clear of the dock too. */
    html.vhr-on #landing-page {
      padding-bottom: calc(24px + var(--vhr-dock-h, 70px) + 20px);
    }

    @media (max-width: 520px) {
      #vhr-dock {
        left: 10px; right: 10px; bottom: 10px;
        width: auto; grid-template-columns: 42px minmax(0, 1fr) auto;
        padding: 8px 7px 10px 8px; gap: 8px;
      }
      #vhr-dock .vhr-art { width: 42px; height: 42px; }
      #vhr-dock .vhr-btn[data-compact-hide] { display: none; }
      #vhr-dock .vhr-title { font-size: 11.5px; }
      #vh-enable-radio { font-size: 11px; padding: 9px 14px; }
    }

    @media (prefers-reduced-motion: reduce) {
      #vhr-dock .vhr-play, #vh-enable-radio .vhr-btn-dot { animation: none !important; }
    }
  `;
  document.head.appendChild(style);
}

/* -------------------------------------------------------------------- dock */

function buildDock() {
  dock = document.createElement('div');
  dock.id = 'vhr-dock';
  dock.setAttribute('role', 'region');
  dock.setAttribute('aria-label', 'Vita Hueso Radio');
  dock.innerHTML = `
    <a class="vhr-art" id="vhr-open" href="${STATION_BASE}#radio" data-radio-open aria-label="Open the full radio station">
      <img id="vhr-art" alt="" width="46" height="46" />
    </a>
    <div class="vhr-meta">
      <div class="vhr-line">
        <span class="vhr-badge" id="vhr-badge">LIVE</span>
        <span class="vhr-title" id="vhr-title">Vita Hueso Radio</span>
        <button class="vhr-rejoin" id="vhr-rejoin" type="button" hidden>Rejoin</button>
      </div>
      <div class="vhr-sub" id="vhr-sub">Tuning the station…</div>
    </div>
    <div class="vhr-controls">
      <button class="vhr-btn vhr-play" id="vhr-play" type="button" aria-label="Play">${ICON.play}</button>
      <button class="vhr-btn" id="vhr-next" type="button" aria-label="Skip" data-compact-hide>${ICON.next}</button>
      <button class="vhr-btn" id="vhr-mute" type="button" aria-label="Mute">${ICON.volume}</button>
      <button class="vhr-btn" id="vhr-close" type="button" aria-label="Turn off the radio">${ICON.close}</button>
    </div>
    <span class="vhr-progress" aria-hidden="true"><span id="vhr-bar"></span></span>`;

  document.body.appendChild(dock);

  els = {
    art: document.getElementById('vhr-art'),
    title: document.getElementById('vhr-title'),
    sub: document.getElementById('vhr-sub'),
    badge: document.getElementById('vhr-badge'),
    rejoin: document.getElementById('vhr-rejoin'),
    play: document.getElementById('vhr-play'),
    next: document.getElementById('vhr-next'),
    mute: document.getElementById('vhr-mute'),
    close: document.getElementById('vhr-close'),
    bar: document.getElementById('vhr-bar')
  };

  els.play.addEventListener('click', () => {
    if (radio.playing) {
      write(KEY_INTENT, '0');
      radio.pause();
    } else {
      write(KEY_INTENT, '1');
      radio.start();
    }
  });

  els.next.addEventListener('click', () => {
    write(KEY_INTENT, '1');
    radio.next();
  });

  els.mute.addEventListener('click', () => radio.toggleMute());
  els.rejoin.addEventListener('click', () => {
    write(KEY_INTENT, '1');
    radio.rejoinLive();
  });
  els.close.addEventListener('click', () => disable());
}

/* ------------------------------------------------------------------- paint */

function paint(state) {
  if (!els || !state || !state.track) return;
  const track = state.track;
  const art = radio.artFor(track);

  if (els.art.getAttribute('src') !== art) els.art.src = art;
  if (els.title.textContent !== track.title) els.title.textContent = track.title;
  const sub = `${track.artist} · ${track.album}`;
  if (els.sub.textContent !== sub) els.sub.textContent = sub;

  /* A hand-tuned station (the home frequency included) is still live radio;
     only the catalogue is "personal". */
  const live = state.mode === 'live';
  const personal = state.mode === 'personal';
  els.badge.textContent = personal ? 'PERSONAL' : 'LIVE';
  els.badge.classList.toggle('is-personal', personal);
  els.rejoin.hidden = live;

  els.play.innerHTML = state.playing ? ICON.pause : ICON.play;
  els.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  els.mute.innerHTML = state.muted ? ICON.mute : ICON.volume;
  els.mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');

  dock.dataset.playing = state.playing ? '1' : '0';
  dock.classList.toggle('is-blocked', hasIntent() && !state.playing && !state.loading);

  const pct = state.duration ? Math.min(100, (Math.max(0, state.position) / state.duration) * 100) : 0;
  els.bar.style.width = `${pct}%`;
}

/* ----------------------------------------------------------------- toggle */

function silencePortal() {
  try { window.__portalMusic?.silence?.(); } catch { /* not on this page */ }
}

/* Publish the dock's real height so the install chip (and the portal's tail
   padding) can clear it. Measured synchronously: reading offsetHeight forces
   layout, and unlike rAF / ResizeObserver it still works while the tab is in
   the background — where those callbacks are simply paused. */
function measureDockHeight() {
  if (!dock) return;
  document.documentElement.style.setProperty('--vhr-dock-h', `${dock.offsetHeight}px`);
}

function setEnabledUI(active) {
  document.documentElement.classList.toggle('vhr-on', active);
  if (dock) {
    dock.classList.toggle('is-on', active);
    measureDockHeight();
  }
  if (toggleButton) {
    toggleButton.classList.toggle('is-on', active);
    toggleButton.setAttribute('aria-pressed', String(active));
    const label = toggleButton.querySelector('.vhr-btn-label');
    if (label) label.textContent = active ? 'Radio on air' : 'Enable radio';
    toggleButton.title = active ? 'Turn the radio off' : 'Enable the 24/7 radio';
  }
}

/**
 * A normal page navigation always tears the <audio> element down with the
 * document, so the station cannot literally keep singing across it. This
 * note is the next best thing: the station page reads it on load and rejoins
 * the SAME live position straight away, so the broadcast picks up where the
 * previous page left it instead of waiting for another tap.
 */
const KEY_HANDOFF = 'vh.radio.handoff';

function writeHandoff() {
  const note = JSON.stringify({
    playing: radio.playing || hasIntent(),
    at: Date.now(),
    // what was actually coming out of the speakers, so the station can
    // continue it instead of snapping back to the live clock
    trackId: radio.track?.id || '',
    mode: radio.mode,
    offset: Math.round(radio.audio.currentTime || 0)
  });
  /* localStorage, not sessionStorage: sessionStorage is per-tab, so the note
     vanished whenever the station opened in a NEW tab (ctrl/cmd-click, middle
     click, "open in new tab") and the station fell back to the live clock —
     the song appeared to change for no reason. The reader deletes it and
     ignores anything older than two minutes. */
  try { localStorage.setItem(KEY_HANDOFF, note); } catch { /* private mode */ }
  try { sessionStorage.setItem(KEY_HANDOFF, note); } catch { /* private mode */ }
}

function enable() {
  write(KEY_ON, '1');
  write(KEY_INTENT, '1');
  writeHandoff();
  silencePortal();
  setEnabledUI(true);
  paint(radio.snapshot());
  radio.start();
  armResume();
}

function disable() {
  write(KEY_ON, null);
  write(KEY_INTENT, '0');
  radio.pause();
  setEnabledUI(false);
  try { window.__portalMusic?.showToggle?.(); } catch { /* ignore */ }
}

/** After navigation, one tap anywhere is enough to resume if autoplay was blocked. */
function armResume() {
  if (!isOn()) return;
  window.addEventListener('pointerdown', () => {
    // `yielded` = the station is already playing in another tab; that tab keeps
    // the floor until this one is asked to play explicitly.
    if (isOn() && hasIntent() && !radio.playing && !radio.yielded) radio.start();
  }, { capture: true, once: true });
}

function toggle() {
  if (isOn()) disable();
  else enable();
}

/* -------------------------------------------------------------------- boot */

function init() {
  injectStyles();
  buildDock();

  /* The dock opens on the station's home frequency (Quebradillas) until the
     listener asks for the shared clock. */
  radio.primeHome();

  toggleButton = document.getElementById('vh-enable-radio');
  if (toggleButton) {
    toggleButton.addEventListener('click', toggle);
  }

  /* Doors into the station (the portal footer card is one). Opening the
     station turns the site radio on first, so it is already live when the
     visitor comes back to the rest of the site — no re-tuning needed. The
     navigation itself is never blocked. */
  document.querySelectorAll('[data-radio-open]').forEach((link) => {
    link.addEventListener('click', () => {
      if (!isOn()) enable();
      else if (hasIntent() && !radio.playing) radio.start();
      writeHandoff();
    });
  });

  radio.addEventListener('state', (event) => {
    paint(event.detail);
    if (event.detail.playing) write(KEY_INTENT, '1');
  });
  radio.addEventListener('time', (event) => {
    const duration = event.detail.duration || radio.track?.duration || 0;
    if (!duration) return;
    const pct = Math.min(100, (Math.max(0, event.detail.position) / duration) * 100);
    els.bar.style.width = `${pct}%`;
  });
  radio.addEventListener('trackchange', () => paint(radio.snapshot()));

  /* Keep --vhr-dock-h honest when the dock's own content reflows (a long
     track title wrapping to two lines moves the install chip with it). */
  measureDockHeight();
  if ('ResizeObserver' in window) new ResizeObserver(measureDockHeight).observe(dock);

  if (isOn()) {
    silencePortal();
    setEnabledUI(true);
    paint(radio.snapshot());
    if (hasIntent()) {
      radio.start();
      armResume();
      setTimeout(() => {
        if (isOn() && hasIntent() && !radio.playing) dock.classList.add('is-blocked');
      }, 1600);
    }
  } else {
    setEnabledUI(false);
    paint(radio.snapshot());
  }

  window.addEventListener('pageshow', (event) => {
    if (!isOn()) return;
    if (event.persisted && hasIntent() && !radio.playing && !radio.yielded) radio.start();
  });

  // expose a tiny API for the page (and for debugging)
  window.VHSiteRadio = { enable, disable, toggle, isOn };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
