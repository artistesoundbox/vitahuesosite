/*
 * VitaminaHueso — Spotify side panel.
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
  _spToken = { access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000 };
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
  if (_spToken) return _spToken.access_token;
  const raw = sessionStorage.getItem('sp_token');
  if (raw) { _spToken = JSON.parse(raw); if (_spToken.expires_at > Date.now()) return _spToken.access_token; }
  return null;
}

function spCommand(cmd, body) {
  const tok = spToken();
  if (!tok) return Promise.resolve(false);
  return fetch('https://api.spotify.com/v1/me/player/' + cmd, {
    method: body ? 'PUT' : 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.ok).catch(() => false);
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
    #sp-tab{position:absolute;left:-34px;top:46px;width:34px;height:120px;cursor:pointer;
      writing-mode:vertical-rl;background:rgba(10,14,20,.92);
      border:1px solid rgba(120,180,255,.35);border-right:none;border-radius:8px 0 0 8px;
      color:#1db954;letter-spacing:.3em;font-size:12px;display:flex;align-items:center;justify-content:center}
    #sp-head{padding:12px 14px 8px;font-size:13px;letter-spacing:.25em;color:#1db954;
      border-bottom:1px solid rgba(120,180,255,.2)}
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
    <div id="sp-head">YOUR MUSIC</div>
    <div id="sp-body">
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
    </div>`;
  document.body.appendChild(panel);

  const $ = (id) => document.getElementById(id);

  /* open/close */
  let open = false;
  $('sp-tab').addEventListener('click', () => {
    open = !open;
    panel.classList.toggle('open', open);
    if (open && opts.onOpen) opts.onOpen();
  });

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
  $('sp-load').addEventListener('click', () => loadEmbed(_uriFromLink($('sp-link').value) || null));
  $('sp-link').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadEmbed(_uriFromLink($('sp-link').value) || null);
  });
  if (saved) { $('sp-link').value = saved; loadEmbed(saved); }

  /* game controls: pause/resume + game-track mute via the Godot bridge.
     The bridge registers LATE (after the ~310 MB pack loads), so poll for
     it instead of checking once at mount. */
  $('sp-game-row').style.display = 'none';
  const bridgeTimer = setInterval(() => {
    if (!window.vhGamePause) return;
    clearInterval(bridgeTimer);
    $('sp-game-row').style.display = 'flex';
    $('sp-pause').addEventListener('click', (e) => {
      window.vhGamePause(); // no args = toggle
      e.target.blur();
    });
    $('sp-gamemusic').addEventListener('click', (e) => {
      if (window.vhGameMusic) window.vhGameMusic();
      // widget owns this label (Godot only pushes pause state)
      e.target.textContent = e.target.textContent.indexOf('MUTE') !== -1
        ? 'GAME TRACK: OFF' : 'MUTE GAME TRACK';
      e.target.blur();
    });
    // Godot pushes pause state on every change (Esc pauses too) — label stays in sync
    window.vhGamePausedState = function (paused) {
      $('sp-pause').innerHTML = paused ? '&#9654; RESUME GAME' : '&#10074;&#10074; PAUSE GAME';
    };
    if (window.vhGamePauseQuery) window.vhGamePauseQuery(); // fetch current state
  }, 1000);

  /* premium transport */
  if (premium) {
    $('sp-connect').addEventListener('click', () => { if (!spToken()) spotifyLogin(); });
    $('sp-prev').addEventListener('click', (e) => { spCommand('previous'); e.target.blur(); });
    $('sp-next').addEventListener('click', (e) => { spCommand('next'); e.target.blur(); });
    $('sp-playpause').addEventListener('click', (e) => { spCommand('play'); e.target.blur(); });
    if (new URLSearchParams(window.location.search).get('sp') === 'connected') {
      $('sp-connect').textContent = 'SPOTIFY CONNECTED';
      $('sp-transport').style.display = 'flex';
    }
  }
}

window.VH_SPOTIFY = { initSpotifyPanel, finishSpotifyLogin, spotifyLogin, spToken, spCommand };
