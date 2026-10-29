// @ts-check
/*
 * Ambient background: small particles drifting behind the views, faintly linked when close and
 * nudged aside by the pointer. Drawn in the theme's foreground, a few tinted with branch colors.
 */
(function () {
  const LINK = 95;          // particles closer than this are joined by a faint line
  const PUSH = 110;         // pointer influence radius
  const MAX_SPEED = 0.7;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => string[]} palette  branch colors, for the occasional tinted particle
   */
  function start(canvas, palette) {
    const g = canvas.getContext('2d');
    if (!g) return;
    let w = 0, h = 0, raf = 0;
    let fg = '204,204,204';
    /** @type {{x:number,y:number,vx:number,vy:number,r:number,a:number,ph:number,tint:number}[]} */
    let parts = [];
    const mouse = { x: -1e4, y: -1e4 };

    const readColor = () => {
      const m = getComputedStyle(document.body).color.match(/[\d.]+/g);
      if (m) fg = m.slice(0, 3).join(',');
    };
    const make = () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
      r: 0.6 + Math.random() * 1.4, a: 0.15 + Math.random() * 0.35, ph: Math.random() * 6.283,
      tint: Math.random() < 0.18 ? Math.floor(Math.random() * 10) : -1,
    });

    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g?.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(130, Math.round((w * h) / 10000));
      for (const p of parts) { p.x = Math.min(p.x, w); p.y = Math.min(p.y, h); }
      while (parts.length < n) parts.push(make());
      parts.length = n;
      if (reduced.matches) draw(0);
      else kick();
    }

    function step() {
      for (const p of parts) {
        const dx = p.x - mouse.x, dy = p.y - mouse.y, d = Math.hypot(dx, dy);
        if (d < PUSH && d > 0.1) {
          const f = (1 - d / PUSH) * 0.06;
          p.vx += (dx / d) * f;
          p.vy += (dy / d) * f;
        }
        p.vx = (p.vx + (Math.random() - 0.5) * 0.01) * 0.995;
        p.vy = (p.vy + (Math.random() - 0.5) * 0.01) * 0.995;
        const s = Math.hypot(p.vx, p.vy);
        if (s > MAX_SPEED) { p.vx *= MAX_SPEED / s; p.vy *= MAX_SPEED / s; }
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -4) p.x = w + 4; else if (p.x > w + 4) p.x = -4;
        if (p.y < -4) p.y = h + 4; else if (p.y > h + 4) p.y = -4;
      }
    }

    function draw(/** @type {number} */ t) {
      if (!g) return;
      g.clearRect(0, 0, w, h);
      g.lineWidth = 0.6;
      g.strokeStyle = `rgb(${fg})`;
      for (let i = 0; i < parts.length; i++) {
        const a = parts[i];
        for (let j = i + 1; j < parts.length; j++) {
          const b = parts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          if (dx > LINK || dx < -LINK || dy > LINK || dy < -LINK) continue;
          const d = Math.hypot(dx, dy);
          if (d >= LINK) continue;
          g.globalAlpha = (1 - d / LINK) * 0.11;
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
        }
      }
      const colors = palette();
      for (const p of parts) {
        g.globalAlpha = p.a * (0.7 + 0.3 * Math.sin(t * 0.0012 + p.ph));
        g.fillStyle = p.tint >= 0 && colors.length ? colors[p.tint % colors.length] : `rgb(${fg})`;
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, 6.283);
        g.fill();
      }
      g.globalAlpha = 1;
    }

    function frame(/** @type {number} */ t) {
      raf = 0;
      if (reduced.matches) { draw(0); return; }
      step();
      draw(t);
      raf = requestAnimationFrame(frame);
    }
    function kick() {
      if (!raf) raf = requestAnimationFrame(frame);
    }

    window.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    }, { passive: true });
    document.addEventListener('pointerleave', () => { mouse.x = mouse.y = -1e4; });
    // VS Code swaps the body's theme classes when the color theme changes.
    new MutationObserver(() => { readColor(); if (reduced.matches) draw(0); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    new ResizeObserver(resize).observe(canvas);
    reduced.addEventListener?.('change', () => (reduced.matches ? draw(0) : kick()));
    readColor();
    resize();
  }

  // @ts-ignore
  window.GitTreeParticles = { start };
})();
