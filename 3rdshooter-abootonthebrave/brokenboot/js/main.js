import { Game } from './game.js';

const game = new Game();
game.hud.setLoading(0, 'Loading 0%');

async function boot() {
  try {
    await game.load((pct) => {
      game.hud.setLoading(pct, `Loading ${pct.toFixed(0)}%`);
    });
    game.hud.hideLoading();
    game.hud.showStart();

    const coarsePointer = window.matchMedia
      && window.matchMedia('(pointer: coarse)').matches;

    const button = document.getElementById('start-button');
    button.addEventListener('click', () => {
      game.start();
      // Phones and tablets drive the game from the touch pad instead.
      if (!coarsePointer) {
        const lock = game.renderer.domElement.requestPointerLock();
        if (lock && typeof lock.catch === 'function') lock.catch(() => {});
      } else {
        game.inputManager.enableTouch();
      }
    });

    game.run();
    // Exposed for debugging from the browser console.
    window.__brokenBoot = game;
  } catch (err) {
    console.error('[brokenboot] boot failed', err);
    const text = document.getElementById('load-text');
    if (text) {
      text.textContent = `Failed to load: ${err && err.message ? err.message : err}`;
      text.style.color = '#ff8a7a';
    }
  }
}

boot();
