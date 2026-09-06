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
 *        https://artistesoundbox.github.io/vitahuesosite/auth/callback.html
 *   4. In "Allowed Web Origins" add:
 *        http://127.0.0.1:8936
 *        https://artistesoundbox.github.io
 *   5. In "Allowed Logout URLs" — must match the returnTo EXACTLY
 *      (path included, both trailing-slash variants):
 *        https://artistesoundbox.github.io/vitahuesosite/
 *        https://artistesoundbox.github.io/vitahuesosite/index.html
 *        https://artistesoundbox.github.io/vitahuesosite/game.html
 *      Without these, logout lands on Auth0's generic "logged out" page.
 *      '/game.html' is what enables returning there after logout.
 *   6. anthonitus.com hookup — add ALL of these in the Auth0 dashboard
 *      (Applications → the SPA app → Settings), keeping the existing
 *      github.io entries in place:
 *        Allowed Callback URLs:  https://anthonitus.com/auth/callback.html
 *                                https://www.anthonitus.com/auth/callback.html
 *        Allowed Web Origins:    https://anthonitus.com
 *                                https://www.anthonitus.com
 *        Allowed Logout URLs:    https://anthonitus.com/
 *                                https://anthonitus.com/index.html
 *                                https://anthonitus.com/game.html
 *                                https://www.anthonitus.com/
 *                                https://www.anthonitus.com/index.html
 *                                https://www.anthonitus.com/game.html
 *      The code needs NO changes — every URL it builds is relative and
 *      follows whichever origin serves the page.
 */

const VH_CONFIG = {
  domain: 'dev-um47bcoddy6kauvl.us.auth0.com',
  clientId: 'aDiPGXEuqimOCyv5Keaq0oiTWcCQlCp9',
};

// Pages logout may return the player to. MUST mirror the dashboard's
// "Allowed Logout URLs" (Auth0 matches exactly — path included). Logout
// checks this list: current page if allowed, else the site root, so a
// missing dashboard entry can never strand players on Auth0's generic
// "logged out" page. Add '/game.html' to the dashboard to enable
// returning there after logout.
const VH_LOGOUT_RETURNS = [
  '/',           // site root — whitelisted (verified: Auth0 302s back)
  '/game.html',  // game description page — enable via Allowed Logout URLs
];

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
    useRefreshTokens: true, // rotating refresh tokens: sessions survive tab reloads/crashes
  });
  return _client;
}

/** True when the visitor has a valid session (checks token silently). */
async function isLoggedIn() {
  if (!_configured()) return false;
  try {
    const c = await _auth();
    if (await c.isAuthenticated()) return true;
    // Silent recovery after a tab crash/reload: the refresh token (or Auth0's
    // SSO cookie) can restore the session WITHOUT showing the login page.
    // Fails quietly when a real login is required (interaction_required).
    try {
      await c.getTokenSilently({ timeoutInSeconds: 10 });
      return await c.isAuthenticated();
    } catch (_e) {
      return false;
    }
  } catch (e) {
    console.warn('auth check failed:', e);
    return false;
  }
}

/** The logged-in user's profile (null when logged out). */
async function getUser() {
  if (!_configured()) return null;
  try {
    const c = await _auth();
    return await c.getUser();
  } catch (e) {
    return null;
  }
}

/**
 * False only when the logged-in account is an email+password signup whose
 * address Auth0 has not verified yet. Social/passwordless logins (and users
 * without an email) are considered verified — the provider already proved
 * ownership of that identity.
 */
async function isEmailVerified() {
  if (!_configured()) return true; // dev mode: gate is transparent
  const u = await getUser();
  return !u || u.email_verified !== false;
}

/**
 * Pull a fresh token from Auth0 so profile claims (like email_verified)
 * reflect what the user has done OUTSIDE this tab — e.g. clicking the
 * verification link in their inbox. The SDK caches claims from login time.
 */
async function refreshSession() {
  if (!_configured()) return false;
  try {
    const c = await _auth();
    await c.getTokenSilently({ ignoreCache: true });
    return true;
  } catch (e) {
    console.warn('session refresh:', e);
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

/**
 * Pick the logout return URL: the page the player is on when it's
 * whitelisted with Auth0, else the site root (always allowed).
 */
function _logoutReturnTo() {
  const siteRoot = new URL('.', window.location.href).href;   // absolute site root
  const here = window.location.href.split(/[?#]/)[0];         // current page, absolute
  const hereDir = new URL('.', here).href;                    // its directory form
  const allowed = VH_LOGOUT_RETURNS.map(function (p) { return new URL(p, siteRoot).href; });
  if (allowed.indexOf(here) !== -1) return here;
  if (allowed.indexOf(hereDir) !== -1) return hereDir;
  return siteRoot;
}

/** Log out and land back where the player came from (or the portal). */
async function logout() {
  if (!_configured()) return;
  const c = await _auth();
  await c.logout({ logoutParams: { returnTo: _logoutReturnTo() } });
}

/**
 * Wire a page's login gate.
 *   gateId   — id of the button that starts login
 *   readyId  — id of the button/element revealed after login (e.g. LAUNCH)
 *   noteId   — optional element shown when Auth0 is not configured yet
 */
async function wireGate(gateId, readyId, noteId, welcomeId, verifyId) {
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
    const u = await getUser();

    // Verified-email gate: hold LAUNCH until Auth0 says the address is real.
    const verify = document.getElementById(verifyId || '');
    if (u && u.email_verified === false && verify) {
      const em = verify.querySelector('.vh-verify-email');
      if (em) em.textContent = u.email || 'your inbox';
      verify.style.display = 'block';
    } else {
      ready.style.display = 'inline-block';
    }

    if (welcomeId && u) {
      const w = document.getElementById(welcomeId);
      if (w) {
        const el = w.querySelector('.vh-email') || w.querySelector('b') || w.querySelector('span');
        if (el) el.textContent = u.email || u.name || 'player';
        w.style.display = 'flex';
      }
    }
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

window.VH_AUTH = { isLoggedIn, login, logout, getUser, isEmailVerified, refreshSession, wireGate, finishLogin, _configured };
