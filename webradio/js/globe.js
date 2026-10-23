/* The little globe in the tuner card.
 *
 * A dotted sphere drawn on a 2D canvas: no WebGL, no library, no map image.
 * Every station in the world list is a dot on it, and the globe turns so the
 * city currently on air sits at the centre.
 *
 * It is decoration with a job — the tuner says "Bavaria", the globe says
 * "Bavaria is *there*" — so it pauses when the tab is hidden or the card is
 * scrolled out of view, and draws a single still frame for anyone who asked
 * their system to reduce motion.
 */
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function createGlobe(canvas) {
  const noop = { setPoints() {}, setFocus() {}, setYou() {}, resize() {}, ensureSize() {}, destroy() {} };
  if (!canvas || !canvas.getContext) return noop;
  const ctx = canvas.getContext('2d');
  if (!ctx) return noop;

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

  let points = [];
  let active = null;
  /* The listener's own position, once the browser has granted it. */
  let you = null;

  let width = 0;
  let height = 0;
  let radius = 0;
  let rotation = 0;
  let target = 0;
  let raf = 0;
  let lastFrame = 0;
  let inView = true;
  const stats = { frames: 0, paints: 0 };

  /* The grid is the same every frame, so it is projected from precomputed unit
     vectors rather than recomputed from trigonometry. */
  const grid = [];
  for (let lat = -75; lat <= 75; lat += 7.5) {
    const phi = (90 - lat) * DEG;
    for (let lon = -180; lon < 180; lon += 7.5) {
      const theta = lon * DEG;
      grid.push({
        x: Math.sin(phi) * Math.cos(theta),
        y: Math.cos(phi),
        z: Math.sin(phi) * Math.sin(theta)
      });
    }
  }

  function angleTo(targetLon) {
    const desired = 90 - targetLon;
    let delta = (desired - rotation) % 360;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return rotation + delta;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    width = rect.width;
    height = rect.height;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    radius = Math.max(10, Math.min(width, height) * 0.46);
    draw(performance.now(), true);
    return true;
  }

  /* The card lives in a view that starts hidden, so the first measurement can
     be 0×0. Any update that arrives later re-measures before painting. */
  function ensureSize() {
    if (!width || !height) return resize();
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (Math.round(rect.width * dpr) !== canvas.width || Math.round(rect.height * dpr) !== canvas.height) {
      return resize();
    }
    return true;
  }

  function draw(now, still = false) {
    if (!width || !height) return;
    const cx = width / 2;
    const cy = height / 2;
    /* A slow breathing turn keeps the globe alive without ever carrying the
       city on air off the front of the sphere. */
    const drift = still || reduceMotion ? 0 : Math.sin(now / 9000) * 3.5;
    const rot = (rotation + drift) * DEG;

    ctx.clearRect(0, 0, width, height);

    /* Sphere body: a soft top-lit blue, darker at the rim. */
    const body = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.15, cx, cy, radius);
    body.addColorStop(0, 'rgba(28, 62, 104, 0.9)');
    body.addColorStop(0.7, 'rgba(10, 26, 46, 0.92)');
    body.addColorStop(1, 'rgba(4, 10, 20, 0.96)');
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();

    /* Graticule dots. */
    for (const dot of grid) {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      /* Rotating around the vertical axis: (x,z) → (x·cos + z·sin, -x·sin + z·cos) */
      const x = dot.x * cos + dot.z * sin;
      const z = -dot.x * sin + dot.z * cos;
      if (z <= 0) continue;
      const sx = cx + x * radius;
      const sy = cy - dot.y * radius;
      const alpha = 0.05 + z * 0.16;
      ctx.beginPath();
      ctx.arc(sx, sy, 0.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(140, 195, 255, ${alpha.toFixed(3)})`;
      ctx.fill();
    }

    /* Stations. Back-of-globe markers still show faintly, so the map reads as
       a whole world rather than a half-empty disc. */
    const pulse = still ? 0.5 : (Math.sin(now / 620) + 1) / 2;
    for (const point of points) {
      const phi = (90 - point.lat) * DEG;
      const theta = (point.lon * DEG) + rot;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      const sx = cx + x * radius;
      const sy = cy - y * radius;
      if (z <= 0) {
        ctx.beginPath();
        ctx.arc(sx, sy, 1, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120, 180, 255, 0.09)';
        ctx.fill();
        continue;
      }
      const isActive = active && point.id === active.id;
      ctx.beginPath();
      ctx.arc(sx, sy, isActive ? 2.6 : 1.3, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#a8f0ff' : 'rgba(120, 190, 255, 0.55)';
      ctx.fill();

      if (isActive) {
        ctx.beginPath();
        ctx.arc(sx, sy, 5 + pulse * 5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(130, 226, 255, ${0.55 - pulse * 0.35})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx, sy, 11 + pulse * 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(130, 226, 255, 0.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    /* The listener: a warm dot with a dark rim, clearly not a station. */
    if (you) {
      const phi = (90 - you.lat) * DEG;
      const theta = you.lon * DEG + rot;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      if (z > 0) {
        const sx = cx + x * radius;
        const sy = cy - y * radius;
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 212, 121, 0.16)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sy, 2.8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd479';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sy, 2.8, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(4, 8, 16, 0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    /* Rim light last, so it sits above the dots. */
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(96, 160, 230, 0.38)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    stats.frames += 1;
    if (!inView || document.hidden) return;
    if (now - lastFrame < 33) return;   // ~30 fps is plenty for this
    lastFrame = now;
    rotation += (target - rotation) * 0.08;
    stats.paints += 1;
    draw(now, false);
  }

  function setPoints(list) {
    ensureSize();
    points = (Array.isArray(list) ? list : [])
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({ id: p.id, lat: p.lat, lon: p.lon }));
    draw(performance.now(), true);
  }

  /** Mark the listener's position; `null` clears it. */
  function setYou(lat, lon) {
    you = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    ensureSize();
    draw(performance.now(), true);
  }

  function setFocus(station) {
    ensureSize();
    active = station && Number.isFinite(station.lat) && Number.isFinite(station.lon)
      ? { id: station.id, lat: station.lat, lon: station.lon }
      : null;
    if (active) {
      target = angleTo(active.lon);
      if (reduceMotion) {
        rotation = target;
        draw(performance.now(), true);
      }
    }
  }

  const observer = 'ResizeObserver' in window
    ? new ResizeObserver(() => resize())
    : null;
  observer?.observe(canvas);

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      const entry = entries[0];
      inView = !!entry?.isIntersecting;
      if (inView) draw(performance.now(), true);
    }, { threshold: 0.05 })
    : null;
  io?.observe(canvas);

  const onVisibility = () => { if (!document.hidden) draw(performance.now(), true); };
  document.addEventListener('visibilitychange', onVisibility);

  resize();
  if (reduceMotion) {
    draw(performance.now(), true);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return {
    setPoints,
    setFocus,
    setYou,
    resize,
    ensureSize,
    stats,
    destroy() {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}
