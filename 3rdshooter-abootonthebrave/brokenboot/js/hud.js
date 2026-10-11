// HUD and overlay wiring. Pure DOM, no rendering concerns.

export class Hud {
  constructor() {
    this.health = document.getElementById('health-fill');
    this.healthText = document.getElementById('health-text');
    this.ammo = document.getElementById('ammo-text');
    this.reserve = document.getElementById('reserve-text');
    this.wave = document.getElementById('wave-text');
    this.enemies = document.getElementById('enemies-text');
    this.kills = document.getElementById('kills-text');
    this.melee = document.getElementById('melee-text');
    this.bootName = document.getElementById('boot-name');
    this.bootBar = document.getElementById('boot-bar-fill');
    this.bootProgress = document.getElementById('boot-progress');
    this.banner = document.getElementById('banner');
    this.bannerSub = document.getElementById('banner-sub');
    this.toasts = document.getElementById('toasts');
    this.crosshair = document.getElementById('crosshair');
    this.chargeBar = document.getElementById('charge-bar-fill');
    this.chargeState = document.getElementById('charge-state');
    this.chargeRow = this.chargeState ? this.chargeState.parentElement : null;
    this.powerups = document.getElementById('powerups');
    this.stance = document.getElementById('stance');
    this.lockInfo = document.getElementById('lock-info');
    this._powerupSig = '';
    this._crossSig = '';
    this.damage = document.getElementById('damage-vignette');
    this.hitmark = document.getElementById('hitmarker');
    this.start = document.getElementById('screen-start');
    this.over = document.getElementById('screen-over');
    this.overTitle = document.getElementById('over-title');
    this.overBody = document.getElementById('over-body');
    this.loading = document.getElementById('screen-loading');
    this.loadBar = document.getElementById('load-bar-fill');
    this.loadText = document.getElementById('load-text');
    this.pauseHint = document.getElementById('pause-hint');
    this._bannerTimer = 0;
    this._damageTimer = 0;
    this._hitTimer = 0;
    this._lastTitle = null;
  }

  setLoading(pct, text) {
    const clamped = Math.max(0, Math.min(100, pct));
    this.loadBar.style.width = `${clamped}%`;
    this.loadText.textContent = text || `Loading ${clamped.toFixed(0)}%`;
  }

  hideLoading() { this.loading.classList.add('hidden'); }
  showStart() { this.start.classList.remove('hidden'); }
  hideStart() { this.start.classList.add('hidden'); }

  setCrosshair(visible) { this.crosshair.style.opacity = visible ? '1' : '0'; }

  update(state, dt) {
    if (state.health !== this._lastHealth) {
      this._lastHealth = state.health;
      const pct = Math.max(0, Math.min(1, state.health / state.maxHealth));
      this.health.style.width = `${pct * 100}%`;
      this.health.style.background = pct > 0.55 ? 'linear-gradient(90deg,#3fa663,#7fd08a)'
        : pct > 0.28 ? 'linear-gradient(90deg,#c9902b,#f2c94c)'
          : 'linear-gradient(90deg,#8f2020,#e04a3a)';
      if (this.healthText) this.healthText.textContent = `${Math.max(0, Math.round(state.health))}`;
    }
    this.ammo.textContent = state.reloading ? 'RELOADING' : String(state.ammo);
    this.ammo.classList.toggle('reloading', state.reloading);
    this.reserve.textContent = String(state.reserve);
    this.wave.textContent = `${state.wave}${state.totalWaves ? ` / ${state.totalWaves}` : ''}`;
    this.enemies.textContent = String(state.enemiesAlive);
    this.kills.textContent = String(state.kills);
    this.melee.textContent = String(state.meleeKills);

    this.bootName.textContent = state.boot.name;
    this.bootName.style.color = state.boot.color;
    this.bootBar.style.width = `${Math.round(state.bootProgress * 100)}%`;
    this.bootProgress.textContent = state.nextBoot
      ? `${state.killsToNext} more for ${state.nextBoot}`
      : 'Maximum tier reached';

    // Boot charge meter, and the stance badge.
    if (this.chargeBar) {
      this.chargeBar.style.width = `${Math.round((state.charge || 0) * 100)}%`;
    }
    if (this.chargeState) {
      const ready = Boolean(state.chargeReady);
      if (this.chargeRow) this.chargeRow.classList.toggle('ready', ready);
      const text = ready ? 'ready — kick' : 'charging';
      if (this.chargeState.textContent !== text) this.chargeState.textContent = text;
    }
    if (this.stance) this.stance.classList.toggle('show', Boolean(state.crouching));

    // Timed powerups, rebuilt only when the set or the whole seconds change.
    if (this.powerups) {
      const p = state.powerups || {};
      const active = Object.keys(p).filter((k) => p[k] > 0);
      const sig = active.map((k) => `${k}${Math.ceil(p[k])}`).join(',');
      if (sig !== this._powerupSig) {
        this._powerupSig = sig;
        this.powerups.innerHTML = active
          .map((k) => `<span class="chip ${k}">${k} ${Math.ceil(p[k])}s</span>`)
          .join('');
      }
    }

    // Reticle states and the lock readout.
    const crossCls = [
      state.locked ? 'locked' : '',
      state.spread > 0.35 ? 'spread' : '',
      state.onTarget ? 'on-target' : '',
    ].filter(Boolean).join(' ');
    if (crossCls !== this._crossSig) {
      this._crossSig = crossCls;
      this.crosshair.className = `crosshair ${crossCls}`.trim();
    }
    if (this.lockInfo) {
      const show = state.locked !== null && state.locked !== undefined;
      this.lockInfo.classList.toggle('show', show);
      if (show) this.lockInfo.textContent = `locked · ${Math.round(state.locked)}m`;
    }

    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      if (this._bannerTimer <= 0) {
        this.banner.classList.remove('show');
        this.bannerSub.classList.remove('show');
      }
    }
    if (this._damageTimer > 0) {
      this._damageTimer -= dt;
      this.damage.style.opacity = String(Math.max(0, this._damageTimer * 1.6));
    }
    if (this._hitTimer > 0) {
      this._hitTimer -= dt;
      this.hitmark.style.opacity = String(Math.max(0, this._hitTimer * 4));
    }
  }

  showBanner(title, sub, seconds = 2.4) {
    this.banner.textContent = title;
    this.bannerSub.textContent = sub || '';
    this.banner.classList.add('show');
    if (sub) this.bannerSub.classList.add('show');
    this._bannerTimer = seconds;
  }

  flashDamage() { this._damageTimer = 0.65; }
  flashHit(kill = false) {
    this._hitTimer = 0.35;
    this.hitmark.style.color = kill ? '#ff4b3a' : '#ffffff';
  }

  toast(title, desc) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<div class="toast-title">🥾 ${title}</div><div class="toast-desc">${desc}</div>`;
    this.toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 500);
    }, 4200);
  }

  showGameOver(title, body) {
    this.overTitle.textContent = title;
    this.overBody.innerHTML = body;
    this.over.classList.remove('hidden');
  }

  hideGameOver() { this.over.classList.add('hidden'); }

  setPaused(paused, message = 'Click to capture the mouse') {
    this.pauseHint.textContent = paused ? message : '';
    this.pauseHint.classList.toggle('show', paused);
  }
}
