/*
 * VitaminaHueso — Auth0 login gate (SPA SDK, no build step).
 *
 * SETUP (one time, ~5 minutes):
 *   1. Create a free account at https://auth0.com and an "Application"
 *      of type "Single Page Web Application".
 *   2. In the app's Settings, copy "Domain" and "Client ID" into
 *      VH_CONFIG below.
 *   3. In "Allowed Callback URLs" add:
 *        http://127.0.0.1:8936/auth/callback.html
 *        https://artistesoundbox.github.io/auth/callback.html
 *   4. In "Allowed Web Origins" and "Allowed Logout URLs" add the same
 *      origins (without the path).
 *   5. When your custom domain is ready, add
 *        https://YOURDOMAIN/auth/callback.html
 *      to Callback URLs and the origins to Web/Logout origins.
 *      Nothing else changes.
 */

const VH_CONFIG = {
  domain: 'dev-um47bcoddy6kauvl.us.auth0.com',
  clientId: 'aDiPGXEuqimOCyv5Keaq0oiTWcCQlCp9',
};

// Auth0 SPA SDK from CDN (promise-based, token stored in memory/sessionStorage)
const VH_SDK = 'https://cdn.jsdelivr.net/npm/@auth0/auth0-spa-js@2/dist/auth0-spa-js.production.min.js';

let _client = null;

function _configured() {
  return VH_CONFIG.domain !== 'YOUR_TENANT.auth0.com' && VH_CONFIG.clientId !== 'YOUR_CLIENT_ID';
}

async function _sdk() {
  if (!window.auth0) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = VH_SDK;
      s.onload = res;
      s.onerror = () => rej(new Error('Failed to load Auth0 SDK'));
      document.head.appendChild(s);
    });
  }
  return window.auth0;
}

async function _auth() {
  if (_client) return _client;
  const auth0 = await _sdk();
  _client = await auth0.createAuth0Client({
    domain: VH_CONFIG.domain,
    clientId: VH_CONFIG.clientId,
    cacheLocation: 'localstorage', // valid values: 'memory' | 'localstorage'
    useRefreshTokens: false,
  });
  return _client;
}

/** True when the visitor has a valid session (checks token silently). */
async function isLoggedIn() {
  if (!_configured()) return false;
  try {
    const c = await _auth();
    return await c.isAuthenticated();
  } catch (e) {
    console.warn('auth check failed:', e);
    return false;
  }
}

/** Send the visitor to the Auth0 hosted login page, returning to `returnTo`. */
async function login(returnTo = 'game.html') {
  if (!_configured()) return; // dev mode: gate is transparent until configured
  const c = await _auth();
  await c.loginWithRedirect({
    authorizationParams: { redirect_uri: new URL('auth/callback.html', window.location.href).href },
    appState: { returnTo: new URL(returnTo, window.location.href).href },
  });
}

/** Log out and land back on the portal page. */
async function logout() {
  if (!_configured()) return;
  const c = await _auth();
  await c.logout({
    logoutParams: { returnTo: new URL('index.html', window.location.href).href },
  });
}

/**
 * Wire a page's login gate.
 *   gateId   — id of the button that starts login
 *   readyId  — id of the button/element revealed after login (e.g. LAUNCH)
 *   noteId   — optional element shown when Auth0 is not configured yet
 */
async function wireGate(gateId, readyId, noteId) {
  const gate = document.getElementById(gateId);
  const ready = document.getElementById(readyId);
  const note = document.getElementById(noteId || '');

  if (!_configured()) {
    // Dev mode until you fill VH_CONFIG: one click still reaches the game.
    if (note) note.style.display = 'block';
    gate.addEventListener('click', () => { window.location.href = ready.href || 'game/index.html'; });
    return;
  }

  if (await isLoggedIn()) {
    gate.style.display = 'none';
    ready.style.display = 'inline-block';
  } else {
    ready.style.display = 'none';
    gate.addEventListener('click', () => login('game.html'));
  }
}

/** Finish the login redirect (call once from auth/callback.html). */
async function finishLogin() {
  if (!_configured()) { window.location.href = 'game.html'; return; }
  try {
    const c = await _auth();
    const state = await c.handleRedirectCallback();
    const to = (state && state.appState && state.appState.returnTo) || 'game.html';
    window.location.href = to;
  } catch (e) {
    console.warn('callback:', e);
    window.location.href = 'game.html';
  }
}

window.VH_AUTH = { isLoggedIn, login, logout, wireGate, finishLogin, _configured };
