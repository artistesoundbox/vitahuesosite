/* Lightweight procedural visualizer.
 *
 * Deliberately NOT routed through Web Audio: rerouting the <audio> element
 * through an AudioContext can pause background playback on mobile. Instead the
 * bars are shaped by the track, the station clock and the transport state —
 * cheap, smooth, and safe for lock-screen audio.
 */
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function createVisualizer(canvas, getState, options = {}) {
  if (!canvas) return { start() {}, stop() {} };
  const ctx = canvas.getContext('2d');
  if (!ctx) return { start() {}, stop() {} };

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let visible = true;
  let seed = Math.random();
  let lastTrack = '';
  let width = 0;
  let height = 0;
  let dpr = 1;

  const bars = options.bars || 56;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(time) {
    const state = getState() || {};
    const track = state.track;
    if (track && track.id !== lastTrack) {
      lastTrack = track.id;
      seed = seedFrom(track.id + track.title);
    }

    ctx.clearRect(0, 0, width, height);
    if (!width || !height) return;

    const t = time / 1000;
    const active = state.playing;
    const energy = active ? 1 : 0.32;
    const gap = 2;
    const barWidth = Math.max(1, width / bars - gap);

    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, 'rgba(56, 182, 255, 0.10)');
    gradient.addColorStop(0.55, 'rgba(56, 182, 255, 0.55)');
    gradient.addColorStop(1, 'rgba(158, 244, 255, 0.95)');
    ctx.fillStyle = gradient;
    ctx.shadowColor = 'rgba(56, 182, 255, 0.55)';
    ctx.shadowBlur = active ? 12 : 0;

    for (let i = 0; i < bars; i++) {
      const norm = i / bars;
      const wave =
        Math.sin(t * 1.7 + i * 0.42 + seed * 9) * 0.32 +
        Math.sin(t * 0.7 - i * 0.19 + seed * 4) * 0.26 +
        Math.cos(t * 2.6 + i * 0.11) * 0.16;
      const envelope = 0.35 + 0.65 * Math.abs(Math.sin(norm * Math.PI + t * 0.15));
      const level = Math.max(0.05, (0.5 + wave) * envelope * energy);
      const h = Math.max(2, level * height * (0.85 + seed * 0.3));
      const x = i * (barWidth + gap);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, height - h, barWidth, h, 2);
      else ctx.rect(x, height - h, barWidth, h);
      ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(158, 244, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();
  }

  function loop(time) {
    if (visible && !document.hidden) draw(time);
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (reduced.matches) {
      resize();
      draw(0);
      return;
    }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(raf);
  }

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(canvas);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
    }, { threshold: 0.05 }).observe(canvas);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resize();
  });

  resize();
  start();

  return { start, stop, resize };
}
