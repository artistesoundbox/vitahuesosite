/*
 * Vitamina Hueso @ Manteca Studios — Spotify side panel.
 *
 * Self-contained widget: injects its own DOM + styles, no dependencies.
 * Mounted on game.html and inside the game page (post-export patch).
 *
 * MODES
 *   1. Embed mode (default, zero setup): paste a Spotify link into the
 *      panel's playlist field and it plays through the official Spotify
 *      embed player. Free accounts: previews. Premium: full tracks.
 *   2. Premium Connect (set SP_CONFIG.clientId): PKCE login, Web Playback
 *      SDK device in this tab — play/pause/skip against the user's own
 *      Spotify account. Redirect finisher: auth/spotify-callback.html.
 *
 * The panel never steals keyboard focus from the game (controls blur
 * themselves after click), and remembers the last playlist in
 * localStorage under 'vh_spotify_uri'.
 */

const SP_CONFIG = {
  clientId: '', // developer.spotify.com app Client ID (enables Premium Connect)
  redirectUri: null, // default: <site>/auth/spotify-callback.html
  playerName: 'Over The Ice', // how this tab shows up in Spotify's device list
  scopes: [
    'streaming', 'user-read-email', 'user-read-private',
    'user-read-playback-state', 'user-modify-playback-state',
  ],
};

let _spToken = null; // { access_token, expires_at }
let _pkce = null;    // { verifier, challenge } while a login is in flight

/* ---------- PKCE helpers ---------- */
function _b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function _sha256(s) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}
function _redirect() {
  return SP_CONFIG.redirectUri || new URL('auth/spotify-callback.html', window.location.href).href;
}

/** Called from auth/spotify-callback.html after Spotify redirects back. */
async function finishSpotifyLogin() {
  const q = new URLSearchParams(window.location.search);
  const code = q.get('code');
  const verifier = sessionStorage.getItem('sp_verifier');
  sessionStorage.removeItem('sp_verifier');
  if (!code || !verifier || !SP_CONFIG.clientId) { window.location.href = '../game.html'; return; }
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code,
    redirect_uri: _redirect(), client_id: SP_CONFIG.clientId, code_verifier: verifier,
  });
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', body });
  if (!r.ok) { console.warn('spotify token failed', r.status); window.location.href = '../game.html'; return; }
  const tok = await r.json();
  _spToken = { access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000, refresh_token: tok.refresh_token || null };
  sessionStorage.setItem('sp_token', JSON.stringify(_spToken));
  window.location.href = '../game.html?sp=connected';
}

/* ---------- Premium Connect ---------- */
async function spotifyLogin() {
  if (!SP_CONFIG.clientId) return;
  const verifier = _b64url(crypto.getRandomValues(new Uint8Array(48)));
  _pkce = { verifier, challenge: _b64url(new Uint8Array(await _sha256(verifier))) };
  sessionStorage.setItem('sp_verifier', verifier);
  const params = new URLSearchParams({
    response_type: 'code', client_id: SP_CONFIG.clientId,
    scope: SP_CONFIG.scopes.join(' '), redirect_uri: _redirect(),
    code_challenge_method: 'S256', code_challenge: _pkce.challenge,
  });
  window.location.href = 'https://accounts.spotify.com/authorize?' + params;
}

function spToken() {
  if (_spToken && _spToken.expires_at > Date.now()) return _spToken.access_token;
  const raw = sessionStorage.getItem('sp_token');
  if (raw) _spToken = JSON.parse(raw);
  if (!_spToken || _spToken.expires_at <= Date.now()) return null;
  return _spToken.access_token;
}

/** Like spToken() but refreshes an expired token first (async network callers). */
async function _freshToken() {
  return spToken() || (await _refreshToken());
}

/** Exchange the refresh token for a new access token (keeps long sessions alive). */
async function _refreshToken() {
  if (!_spToken || !_spToken.refresh_token || !SP_CONFIG.clientId) return null;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: _spToken.refresh_token, client_id: SP_CONFIG.clientId,
    });
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', body });
    if (!r.ok) return null;
    const tok = await r.json();
    _spToken = {
      access_token: tok.access_token,
      expires_at: Date.now() + tok.expires_in * 1000,
      refresh_token: tok.refresh_token || _spToken.refresh_token, // Spotify may rotate it
    };
    sessionStorage.setItem('sp_token', JSON.stringify(_spToken));
    return _spToken.access_token;
  } catch (e) {
    return null;
  }
}

/* ---------- Web Playback SDK (plays IN this tab — the game keeps running) ----------
   Spotify's SDK script is loaded lazily once the user connects. The player
   registers as a Spotify Connect device named SP_CONFIG.playerName, so the
   transport buttons control music playing right here in the browser while
   the saucer stays airborne. Loading does not touch the game canvas. */
let _spDeviceId = null;

function _loadPlaybackSdk() {
  if (window.Spotify) return Promise.resolve();
  window.onSpotifyWebPlaybackSDKReady = () => {};
  return new Promise((res) => {
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onload = res;
    document.head.appendChild(s);
  });
}

async function ensurePlayer() {
  if (_spDeviceId || !(await _freshToken())) return;
  await _loadPlaybackSdk();
  const player = new window.Spotify.Player({
    name: SP_CONFIG.playerName,
    getOAuthToken: (cb) => {
      const t = spToken();
      if (t) cb(t);
      else _refreshToken().then((n) => { if (n) cb(n); });
    },
    volume: 0.7,
  });
  player.addListener('ready', ({ device_id }) => { _spDeviceId = device_id; });
  player.addListener('initialization_error', (e) => console.warn('sp init:', e.message));
  player.addListener('authentication_error', (e) => console.warn('sp auth:', e.message));
  await player.connect();
  // small wait so the device id lands before the first command
  for (let i = 0; i < 20 && !_spDeviceId; i++) await new Promise((r) => setTimeout(r, 250));
}

async function spCommand(cmd, body) {
  const tok = await _freshToken();
  if (!tok) return false;
  if (cmd === 'play' || cmd === 'pause') await ensurePlayer();
  // Fresh in-tab device has nothing queued: default to the playlist the user
  // already loaded in the widget (localStorage), if any.
  if (cmd === 'play' && !body) {
    const savedUri = localStorage.getItem('vh_spotify_uri');
    if (savedUri) body = { context_uri: savedUri };
  }
  const url = 'https://api.spotify.com/v1/me/player/' + cmd +
    ((cmd === 'play' || cmd === 'pause') && _spDeviceId ? '?device_id=' + _spDeviceId : '');
  return fetch(url, {
    method: body ? 'PUT' : cmd === 'play' || cmd === 'pause' ? 'PUT' : 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.ok).catch(() => false);
}

async function isPlaying() {
  const tok = await _freshToken();
  if (!tok) return false;
  try {
    const r = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: 'Bearer ' + tok },
    });
    if (r.status === 204) return false; // nothing active
    const s = await r.json();
    return !!(s && s.is_playing);
  } catch (e) { return false; }
}

/** Sync the transport's play/pause label with the real playback state. */
async function refreshPlaybackState() {
  const btn = document.getElementById('sp-playpause');
  if (!btn) return;
  const playing = await isPlaying();
  btn.innerHTML = playing
    ? '&#10074;&#10074;'   // playing → show pause glyph
    : '&#9654;';           // paused → show play glyph
}

/* ---------- Panel widget ---------- */
function _uriFromLink(v) {
  v = v.trim();
  let m = v.match(/spotify\.com\/(playlist|album|track|episode|show|artist)\/([A-Za-z0-9]+)/);
  if (m) return 'spotify:' + m[1] + ':' + m[2];
  return /^spotify:[a-z]+:[A-Za-z0-9]+$/.test(v) ? v : null;
}

function _heightFor(uri) {
  if (uri.startsWith('spotify:track:') || uri.startsWith('spotify:episode:')) return 152;
  return 380;
}

function initSpotifyPanel(opts) {
  opts = opts || {};
  if (document.getElementById('sp-panel')) return; // already mounted

  /* styles (namespaced, injected once) */
  const css = document.createElement('style');
  css.textContent = `
    #sp-panel{position:fixed;top:0;right:-332px;width:320px;height:100%;z-index:60;
      background:rgba(10,14,20,.92);border-left:1px solid rgba(120,180,255,.35);
      backdrop-filter:blur(8px);transition:right .3s ease;color:#cfe4ff;
      font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
    #sp-panel.open{right:0}
    /* 44px wide so the ~32px sliver visible when closed is an easy target */
    #sp-tab{position:absolute;left:-44px;top:46px;width:44px;height:150px;cursor:pointer;
      writing-mode:vertical-rl;background:rgba(10,14,20,.92);
      border:1px solid rgba(120,180,255,.35);border-right:none;border-radius:8px 0 0 8px;
      color:#1db954;letter-spacing:.3em;font-size:13px;display:flex;align-items:center;justify-content:center}
    #sp-head{display:flex;gap:6px;padding:10px 12px;
      border-bottom:1px solid rgba(120,180,255,.2)}
    .sp-svc-tab{flex:1;text-align:center;padding:8px 0;font-size:11px;letter-spacing:.14em;
      color:#7f9cbd;cursor:pointer;border-radius:999px;border:1px solid transparent;
      user-select:none;transition:all .2s}
    .sp-svc-tab:hover{color:#cfe4ff}
    .sp-svc-tab.sp-svc-on{color:#fff;background:rgba(20,40,70,.7);
      border-color:rgba(120,180,255,.5)}
    #am-link{background:rgba(8,14,24,.7);border:1px solid rgba(120,180,255,.4);color:#eaf4ff;
      border-radius:8px;padding:8px 10px;font-size:13px;outline:none;width:100%}
    #am-link:focus{border-color:rgba(250,150,180,.9)}
    #am-embed{border-radius:12px;overflow:hidden}
    #sp-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px;overflow:auto}
    #sp-link{background:rgba(8,14,24,.7);border:1px solid rgba(120,180,255,.4);color:#eaf4ff;
      border-radius:8px;padding:8px 10px;font-size:13px;outline:none;width:100%}
    #sp-link:focus{border-color:rgba(160,210,255,.9)}
    .sp-btn{background:rgba(20,40,70,.7);border:1px solid rgba(120,180,255,.5);color:#cfe4ff;
      border-radius:999px;padding:7px 14px;font-size:12px;letter-spacing:.12em;cursor:pointer}
    .sp-btn:hover{color:#fff;border-color:rgba(160,210,255,.9);box-shadow:0 0 14px rgba(80,150,255,.4)}
    #sp-embed{border-radius:12px;overflow:hidden}
    #sp-note{font-size:11px;color:#6f88a8;line-height:1.5}
    #sp-transport{display:none;gap:8px}
    #sp-transport .sp-btn{flex:1;text-align:center}
    #sp-game-row{display:flex;gap:8px}
    #sp-game-row .sp-btn{flex:1;text-align:center;font-size:11px;padding:6px 4px}
  `;
  document.head.appendChild(css);

  /* DOM */
  const panel = document.createElement('div');
  panel.id = 'sp-panel';
  const premium = !!SP_CONFIG.clientId;
  panel.innerHTML = `
    <div id="sp-tab">&#9835; MUSIC</div>
    <div id="sp-head">
      <span id="sp-tab-spotify" class="sp-svc-tab sp-svc-on">SPOTIFY</span>
      <span id="sp-tab-apple" class="sp-svc-tab">APPLE MUSIC</span>
    </div>
    <div id="sp-body">
      <div id="sp-view-spotify">
      <div id="sp-game-row">
        <button class="sp-btn" id="sp-pause">&#10074;&#10074; PAUSE GAME</button>
        <button class="sp-btn" id="sp-gamemusic">MUTE GAME TRACK</button>
      </div>
      <input id="sp-link" type="text" spellcheck="false"
        placeholder="Paste a Spotify link (playlist, album, track)" />
      <button class="sp-btn" id="sp-load">LOAD</button>
      <div id="sp-embed"></div>
      ${premium ? `
      <button class="sp-btn" id="sp-connect">CONNECT SPOTIFY (PREMIUM)</button>
      <div id="sp-transport">
        <button class="sp-btn" id="sp-prev">&#9198;</button>
        <button class="sp-btn" id="sp-playpause">&#9654;/&#10073;&#10073;</button>
        <button class="sp-btn" id="sp-next">&#9197;</button>
      </div>` : `
      <div id="sp-note">Paste any Spotify link to play it here. Premium users hear
      full tracks; free accounts get previews. Log in to Spotify inside the embed
      (top-right &ldquo;...&rdquo;) to use your own library.</div>`}
      </div>

      <div id="sp-view-apple" style="display:none">
        <input id="am-link" type="text" spellcheck="false"
          placeholder="Paste an Apple Music link (song, album, playlist)" />
        <button class="sp-btn" id="am-load">LOAD</button>
        <div id="am-embed"></div>
        <div id="sp-note">Plays through Apple's official web player. Free accounts
        hear previews; Apple Music subscribers hear full tracks.</div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);

  /* ---------- service tabs (Spotify / Apple Music) ---------- */
  const viewSp = $('sp-view-spotify'), viewAm = $('sp-view-apple');
  function showSvc(spotify) {
    viewSp.style.display = spotify ? 'block' : 'none';
    viewAm.style.display = spotify ? 'none' : 'block';
    $('sp-tab-spotify').classList.toggle('sp-svc-on', spotify);
    $('sp-tab-apple').classList.toggle('sp-svc-on', !spotify);
  }
  $('sp-tab-spotify').addEventListener('click', () => showSvc(true));
  $('sp-tab-apple').addEventListener('click', () => showSvc(false));

  /* ---------- Apple Music embed (official web player) ---------- */
  // music.apple.com/<cc>/<kind>/<slug>/<id>(?i=<songId>) -> embed.music.apple.com
  function _amParse(v) {
    const m = v.trim().match(
      /music\.apple\.com\/([a-z]{2})\/(album|playlist|song|music-video|station)(?:\/[^\/\s?#]+)?\/(\d+)(?:[\/?]i=(\d+))?/i);
    return m ? { cc: m[1], kind: m[2].toLowerCase(), id: m[3], i: m[4] || null } : null;
  }
  function _amFrame(url, h) {
    return '<iframe style="border:0;width:100%;height:' + h + 'px" src="' + url +
      '" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" '
      + 'sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation" '
      + 'loading="lazy"></iframe>';
  }
  function loadApple(p) {
    if (!p) { $('am-link').style.borderColor = 'rgba(255,120,120,.8)'; return; }
    $('am-link').style.borderColor = 'rgba(120,180,255,.4)';
    const url = 'https://embed.music.apple.com/' + p.cc + '/' + p.kind + '/' + p.id +
      (p.i ? ('?i=' + p.i) : '') + '&app=music';
    localStorage.setItem('vh_apple_uri', url);
    const h = (p.kind === 'song' || p.kind === 'music-video') ? 260 : 450;
    $('am-embed').innerHTML = _amFrame(url, h);
  }
  $('am-load').addEventListener('click', (e) => { loadApple(_amParse($('am-link').value)); _blurSoon(e.target); });
  $('am-link').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadApple(_amParse($('am-link').value));
  });
  const amSaved = localStorage.getItem('vh_apple_uri');
  if (amSaved) {
    const h = amSaved.indexOf('i=') !== -1 && /\/song\//.test(amSaved) ? 260
      : amSaved.indexOf('/song/') !== -1 ? 260 : 450;
    $('am-embed').innerHTML = _amFrame(amSaved, h);
  }

  /* Give the keyboard back to the game after one-shot widget actions.
     Clicking the panel steals focus from the Godot canvas, and the canvas
     only hears keys while focused — ESC/movement went dead until the
     player clicked back into the game. Mirrors hemisync.js. */
  const _backToGame = () => {
    const c = document.querySelector('canvas');
    if (c && c.focus) { try { c.focus(); } catch (e) { /* not focusable */ } }
  };
  const _blurSoon = (el) => {
    setTimeout(() => {
      if (el && el.blur) { try { el.blur(); } catch (e) { /* ignore */ } }
      _backToGame();
    }, 0);
  };

  /* open/close */
  let open = false;
  $('sp-tab').addEventListener('click', (e) => {
    open = !open;
    panel.classList.toggle('open', open);
    if (open && opts.onOpen) opts.onOpen();
    _blurSoon(e.currentTarget); // opening the panel shouldn't strand the game's keyboard
  });

  /* Any click on the panel's empty space (padding, gaps) also hands the
     keyboard back to the game — a button-less click used to leave focus
     on <body> and the paused game went deaf to ESC. Mirrors hemisync.js. */
  panel.addEventListener('click', () => _backToGame());

  /* embed loader */
  const saved = localStorage.getItem('vh_spotify_uri');
  function loadEmbed(uri) {
    if (!uri) { $('sp-link').style.borderColor = 'rgba(255,120,120,.8)'; return; }
    localStorage.setItem('vh_spotify_uri', uri);
    $('sp-link').style.borderColor = 'rgba(120,180,255,.4)';
    const html = 'https://open.spotify.com/embed/' + uri.replace('spotify:', '').replace(':', '/') +
      '?utm_source=vitaminahueso&theme=0';
    $('sp-embed').innerHTML =
      '<iframe style="border:0;width:100%;height:' + _heightFor(uri) + 'px" src="' + html +
      '" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>';
  }
  $('sp-load').addEventListener('click', (e) => { loadEmbed(_uriFromLink($('sp-link').value) || null); _blurSoon(e.target); });
  $('sp-link').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadEmbed(_uriFromLink($('sp-link').value) || null);
  });
  if (saved) { $('sp-link').value = saved; loadEmbed(saved); }

  /* game controls: pause/resume + game-track mute via the Godot bridge.
     The bridge registers LATE (after the ~310 MB pack loads), so poll for
     it instead of checking once at mount. */
  $('sp-game-row').style.display = 'none';

  /* ---------- pause safety net (moved here from the retired hemisync
     panel — this right-side widget is the only one the game mounts) ------

     1. Floating RESUME GAME button: appears bottom-center whenever the
        game reports PAUSED. Keyboard focus, device, and input quirks are
        irrelevant — the button calls the bridge directly.
     2. ESC rescue: Godot only hears keys while its canvas is focused;
        when focus lives elsewhere the game never gets ESC. This handler
        refocuses the canvas and resumes on the game's behalf. When the
        canvas IS focused it does nothing (Godot handles ESC itself —
        forwarding would double-toggle straight back to paused).
     3. Canvas-click resume: clicking the game area itself resumes a
        paused game (deliberate: widget clicks never reach the canvas). */
  const resumeFlo = document.createElement('button');
  resumeFlo.id = 'vh-resume-float';
  resumeFlo.textContent = '\u25B6 RESUME GAME';
  resumeFlo.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:9%', 'transform:translateX(-50%)',
    'z-index:9998', 'display:none', 'align-items:center',
    'padding:15px 38px', 'border-radius:999px', 'font-size:15px',
    'letter-spacing:0.22em', 'font-family:inherit',
    'color:#eaf7ff', 'background:rgba(16,34,52,0.85)',
    'border:1px solid rgba(110,220,150,0.75)', 'cursor:pointer',
    'box-shadow:0 0 26px rgba(70,196,110,0.35)', 'backdrop-filter:blur(6px)'
  ].join(';');
  resumeFlo.addEventListener('click', () => {
    try { resumeFlo.blur(); } catch (e) { /* ignore */ }
    if (typeof window.vhGamePause === 'function') window.vhGamePause(false);
  });
  document.body.appendChild(resumeFlo);
  const syncResumeFloat = () => {
    const show = (typeof window.vhGamePause === 'function') && window._vhLastPaused === true;
    resumeFlo.style.display = show ? 'flex' : 'none';
  };
  setInterval(syncResumeFloat, 500);
  syncResumeFloat();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const c = document.querySelector('canvas');
    if (c && document.activeElement === c) return;   // game is listening
    if (c && c.focus) { try { c.focus(); } catch (err) { /* ignore */ } }
    if (window._vhLastPaused === true && typeof window.vhGamePause === 'function') {
      window.vhGamePause(false);   // paused AND deaf: resume for it
    }
  }, true);   // capture: runs before the page's other key handlers

  document.addEventListener('mousedown', (e) => {
    if (window._vhLastPaused !== true) return;
    if (typeof window.vhGamePause !== 'function') return;
    // only clicks that land ON the canvas (or its container) resume —
    // panel/tab clicks pass through the target check untouched
    if (e.target === document.querySelector('canvas')) {
      window.vhGamePause(false);
    }
  }, true);
  // Pause-state sink defined at MOUNT: Godot pushes its initial state the
  // instant it registers the bridge — before the poll below can install a
  // listener — so the sink must already exist. The latest pushed value is
  // buffered and consumed at discovery; no lost updates, no console errors.
  window._vhLastPaused = null;
  window._vhLastMusic = null;
  window.vhGamePausedState = function (paused) { window._vhLastPaused = paused; };
  const musicLabel = (muted) => muted ? '&#9834; GAME TRACK: OFF' : 'MUTE GAME TRACK';
  window.vhGameMusicState = function (muted) {
    window._vhLastMusic = muted;
    const b = $('sp-gamemusic');
    if (b) b.innerHTML = musicLabel(muted);
  };
  const bridgeTimer = setInterval(() => {
    if (!window.vhGamePause) return;
    clearInterval(bridgeTimer);
    $('sp-game-row').style.display = 'flex';
    $('sp-pause').addEventListener('click', (e) => {
      // Explicit booleans only: the bridge reads a missing/undefined arg as
      // bool(false) = "resume", a silent no-op while running — so a bare
      // call made the pause button do nothing. Ask for the opposite of the
      // last known state (defaulting to pause when unknown).
      window.vhGamePause(window._vhLastPaused !== true);
      _blurSoon(e.target);
    });
    $('sp-gamemusic').addEventListener('click', (e) => {
      if (window.vhGameMusic) window.vhGameMusic();
      // optimistic label; Godot's vhGameMusicState push corrects it to truth
      const muted = window._vhLastMusic !== true;
      window._vhLastMusic = muted;
      e.target.innerHTML = musicLabel(muted);
      _blurSoon(e.target);
    });
    // Godot pushes pause state on every change (Esc pauses too) — keep the
    // buffered sink but make it live-update the label from now on.
    window.vhGamePausedState = function (paused) {
      window._vhLastPaused = paused;
      $('sp-pause').innerHTML = paused ? '&#9654; RESUME GAME' : '&#10074;&#10074; PAUSE GAME';
    };
    // consume whatever Godot pushed before we discovered the bridge, then
    // double-check with fresh queries
    if (window._vhLastPaused !== null) {
      $('sp-pause').innerHTML = window._vhLastPaused ? '&#9654; RESUME GAME' : '&#10074;&#10074; PAUSE GAME';
    }
    if (window._vhLastMusic !== null) {
      $('sp-gamemusic').innerHTML = musicLabel(window._vhLastMusic);
    }
    if (window.vhGamePauseQuery) window.vhGamePauseQuery(); // fetch current state
    if (window.vhGameMusicQuery) window.vhGameMusicQuery();
  }, 1000);

  /* premium transport */
  if (premium) {
    const revealTransport = () => {
      $('sp-connect').style.display = 'none';
      $('sp-transport').style.display = 'flex';
      refreshPlaybackState();
      ensurePlayer(); // warm up the in-tab device now, not on first tap
    };
    $('sp-connect').addEventListener('click', async () => {
      if (spToken() || (await _freshToken())) { revealTransport(); return; }
      spotifyLogin(); // redirects to Spotify; auth/spotify-callback.html finishes
    });
    $('sp-prev').addEventListener('click', (e) => { spCommand('previous'); _blurSoon(e.target); });
    $('sp-next').addEventListener('click', (e) => { spCommand('next'); _blurSoon(e.target); });
    $('sp-playpause').addEventListener('click', async (e) => {
      const playing = await isPlaying();
      await spCommand(playing ? 'pause' : 'play');
      _blurSoon(e.target);
    });
    // returning from the Spotify redirect with a fresh token?
    if (new URLSearchParams(window.location.search).get('sp') === 'connected') revealTransport();
    // or already connected in this tab (sessionStorage token)?
    else { (async () => { if (await _freshToken()) revealTransport(); })(); }
  }
}

window.VH_SPOTIFY = { initSpotifyPanel, finishSpotifyLogin, spotifyLogin, spToken, spCommand, isPlaying, refreshPlaybackState, ensurePlayer };
/* hemisync panel removed from the game page at the owner's request — the
   sanctuary page (hemisync.html) still mounts the full engine standalone. */
