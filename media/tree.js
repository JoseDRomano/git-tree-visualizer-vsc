// @ts-check
/*
 * Branch tree view, drawn as a small living graph. The production branch is the trunk running down
 * the middle (its tip at the top, its first commit at the bottom); every other branch leaves it, or
 * the branch it grew from, and ends in a node colored by branch with its name beside it. Hovering a node shows
 * its latest commit and how it compares with every other branch. Nodes can be dragged (their
 * neighbors follow a little) and spring back to their place when let go.
 */
(function () {
  const TIP_R = 6;           // branch node radius
  const HEAD_R = 7.5;        // the checked-out branch
  const CROWN_R = 8;         // the trunk's tip
  const EV_R = 3.5;          // marked commits on the trunk
  const ROW = 28;            // vertical room per branch node
  const ROW_GAP = 6;
  const RISE = 26;           // minimum climb from a fork point to its node
  const MAX_EXTRA_RISE = 60; // how much higher than ideal a node may sit when space allows
  const LABEL_MAX = 180;     // matches .tlabel max-width
  const TRUNK_TOP = 44;
  const SPRING = 0.035;      // pull toward home, per 60 Hz frame
  const DAMP = 0.75;         // velocity kept, per 60 Hz frame: close to critical, so nodes glide in without wobbling
  const GROW = 0.06;         // same for the scale a new node grows in with
  const GROW_DAMP = 0.62;
  const FOLLOW = 0.42;       // share of a drag passed on to neighbors, per hop
  const CMP_ROWS = 6;        // branches listed in the hover comparison
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** @typedef {{x:number,y:number}} Pt */
  function bez(/** @type {Pt[]} */ P, /** @type {number} */ t) {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return { x: a * P[0].x + b * P[1].x + c * P[2].x + d * P[3].x, y: a * P[0].y + b * P[1].y + c * P[2].y + d * P[3].y };
  }
  const f1 = (/** @type {number} */ v) => v.toFixed(1);
  const pathOf = (/** @type {Pt[]} */ P) =>
    `M${f1(P[0].x)} ${f1(P[0].y)}C${f1(P[1].x)} ${f1(P[1].y)} ${f1(P[2].x)} ${f1(P[2].y)} ${f1(P[3].x)} ${f1(P[3].y)}`;
  /** Smooth curve through every point (Catmull-Rom, as cubic Béziers). */
  function spline(/** @type {Pt[]} */ p) {
    if (p.length < 2) return '';
    let d = `M${f1(p[0].x)} ${f1(p[0].y)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], e = p[i + 2] || c;
      d += `C${f1(b.x + (c.x - a.x) / 6)} ${f1(b.y + (c.y - a.y) / 6)} ${f1(c.x - (e.x - b.x) / 6)} ${f1(c.y - (e.y - b.y) / 6)} ${f1(c.x)} ${f1(c.y)}`;
    }
    return d;
  }
  const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ---------- state shared across renders ----------

  /** Position, velocity and scale of every node, by key (branch name or commit hash), so a refresh animates. */
  let sims = new Map();
  /** @type {any} */ let scene = null;
  /** @type {any} */ let drag = null;
  /** @type {any} */ let pan = null;
  let raf = 0;
  let lastT = 0;
  let suppressClick = false;
  /** @type {HTMLElement | null} */ let wired = null;
  /** @type {HTMLElement | null} */ let wiredScroller = null;

  const tip = document.createElement('div');
  tip.className = 'gt-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  /** @type {any} */ let tipNode = null;

  /**
   * @param {HTMLElement} host
   * @param {any} tree
   * @param {any} ctx  { snapshot, color, esc, icon, relTime, width, scroller, getZoom, isBusy }
   */
  function render(host, tree, ctx) {
    hideTip();
    drag = pan = null;
    wire(host, ctx.scroller);
    if (!tree || !tree.limbs.length) {
      scene = null;
      host.style.width = host.style.height = '';
      host.innerHTML = '<div class="message">No branches to show yet.</div>';
      return null;
    }
    const { esc, icon, color, snapshot } = ctx;
    const limbs = tree.limbs;
    const kids = limbs.map(() => /** @type {any[]} */ ([]));
    for (const l of limbs) if (l.parent >= 0) kids[l.parent].push(l);
    const depthOf = (/** @type {any} */ l) => { let d = 0; while (l.parent > 0) { d++; l = limbs[l.parent]; } return d; };
    const maxDepth = Math.max(0, ...limbs.slice(1).map(depthOf));
    const nameOf = (/** @type {any} */ l) => limbName(tree, l);
    const labelW = (/** @type {any} */ l) =>
      Math.min(LABEL_MAX, 14 + 6.8 * nameOf(l).length + (l.isHead ? 40 : 0) + (l.names.length > 1 ? 24 : 0));
    const maxLabel = Math.max(60, ...limbs.slice(1).map(labelW));

    // ---------- horizontal metrics ----------
    // Wide views get a centered tree with branches on both sides; narrow ones (the sidebar) one
    // column: trunk on the left, every node to its right.
    let compact = true, width = 0, cx = 0, off = 0, indent = 0;
    {
      const pad = 24, step = 44;
      const spread = maxDepth * step + TIP_R + 10 + maxLabel;
      const o = Math.round(Math.max(60, Math.min(200, ctx.width / 2 - spread - pad)));
      const need = 2 * (o + spread + pad);
      if (ctx.width >= 460 && need <= ctx.width + 2) {
        compact = false;
        width = Math.max(ctx.width, need);
        cx = Math.round(width / 2);
        off = o;
        indent = step;
      }
    }
    if (compact) {
      cx = 28;
      off = 34;
      indent = 18;
      const need = cx + off + maxDepth * indent + TIP_R + 10 + maxLabel + 16;
      width = Math.max(need, Math.min(ctx.width, 360));
    }

    // ---------- vertical layout: walk the trunk events from the tip down ----------
    /** @type {Record<string, number>} */
    const cursor = { L: TRUNK_TOP + 16, R: TRUNK_TOP + 16 };
    /** @type {any[]} */
    const place = [];
    const evY = new Map([[0, TRUNK_TOP]]);
    let lastY = TRUNK_TOP, lastIdx = 0, flip = 0;

    // Sub-branches stack above the branch they grew from; the one forking nearest the trunk goes highest.
    const stack = (/** @type {any} */ l, /** @type {number} */ depth, /** @type {any[]} */ out) => {
      for (const k of [...kids[l.id]].sort((a, b) => b.forkIdx - a.forkIdx)) stack(k, depth + 1, out);
      out.push({ l, depth });
      return out;
    };
    const topKids = [...kids[0]].sort((a, b) => a.forkIdx - b.forkIdx || b.time - a.time);
    /** Places the branches leaving the trunk at `idx` beside it; returns how low that trunk point must sit. */
    const placeGroups = (/** @type {number} */ idx, /** @type {number} */ y) => {
      for (const g of topKids.filter(l => l.forkIdx === idx)) {
        const st = stack(g, 0, []);
        const side = compact ? 'R' : cursor.L < cursor.R ? 'L' : cursor.R < cursor.L ? 'R' : (flip++ % 2 ? 'L' : 'R');
        const total = st.length * (ROW + ROW_GAP);
        const lastCenter = total - ROW_GAP - ROW / 2; // top of the stack → center of its bottom node
        const top = Math.max(cursor[side], y - RISE - lastCenter - MAX_EXTRA_RISE);
        st.forEach((s, k) => place.push({ ...s, side, y: top + k * (ROW + ROW_GAP) + ROW / 2 }));
        y = Math.max(y, top + lastCenter + RISE);
        cursor[side] = top + total;
      }
      return y;
    };
    placeGroups(0, TRUNK_TOP); // branches ahead of the trunk's tip hang just below it
    for (const ev of tree.events) {
      if (ev.idx === 0) continue;
      const y = placeGroups(ev.idx, lastY + 24 + Math.min(34, Math.log2(1 + ev.idx - lastIdx) * 7));
      evY.set(ev.idx, y);
      lastY = y;
      lastIdx = ev.idx;
    }
    for (const p of place) p.x = cx + (p.side === 'L' ? -1 : 1) * (off + p.depth * indent);
    const height = Math.max(lastY, ...place.map(p => p.y)) + 48;

    // ---------- nodes ----------
    /** @type {any[]} */
    const nodes = [];
    const mk = (/** @type {any} */ n) => { n.ox = n.oy = 0; n.adj = []; nodes.push(n); return n; };
    const link = (/** @type {any} */ a, /** @type {any} */ b) => { a.adj.push(b); b.adj.push(a); };
    const keyOf = (/** @type {any} */ l) => `L:${l.names[0] || l.tip}`;

    const crown = mk({ key: keyOf(limbs[0]), kind: 'limb', l: limbs[0], hx: cx, hy: TRUNK_TOP, r: CROWN_R, side: 'R', amp: 0.6 });
    const byEv = new Map([[0, crown]]);
    const trunk = [crown];
    const lastEv = tree.events[tree.events.length - 1];
    for (const ev of tree.events) {
      if (ev.idx === 0) continue;
      const root = ev === lastEv;
      const n = mk({ key: `E:${ev.hash}`, kind: 'ev', ev, root, hx: cx, hy: evY.get(ev.idx), r: root ? 4.5 : ev.merge ? 4 : EV_R, amp: 0.8 });
      n.prev = trunk[trunk.length - 1];
      link(n.prev, n);
      trunk.push(n);
      byEv.set(ev.idx, n);
    }
    const byLimb = new Map([[0, crown]]);
    const limbNodes = [...place].sort((a, b) => a.depth - b.depth).map(p => {
      const n = mk({ key: keyOf(p.l), kind: 'limb', l: p.l, hx: p.x, hy: p.y, r: p.l.isHead ? HEAD_R : TIP_R, side: p.side, amp: 1.6 });
      byLimb.set(p.l.id, n);
      return n;
    });
    for (const n of limbNodes) {
      n.from = n.l.parent === 0 ? byEv.get(n.l.forkIdx) ?? crown : byLimb.get(n.l.parent);
      link(n, n.from);
      if (n.l.mergedAt !== undefined && byEv.has(n.l.mergedAt)) n.mergeNode = byEv.get(n.l.mergedAt);
    }

    /** Line geometry for the given node positions: one curve per branch, from its fork point to its node. */
    const edges = (/** @type {(n:any) => Pt} */ pos) => {
      const curves = new Map();
      for (const n of limbNodes) {
        const l = n.l;
        let S;
        if (l.parent === 0) S = pos(n.from);
        else {
          const A = Math.max(1, limbs[l.parent].ahead);
          // Forking at the parent's tip (often the same commit): grow straight out of its node.
          S = bez(curves.get(l.parent), l.forkIdx === 0 ? 1 : Math.max(0.2, Math.min(0.85, 1 - (l.forkIdx + 0.5) / A)));
        }
        const E = pos(n);
        const p = { x: E.x, y: E.y };
        const dx = p.x - S.x, dy = p.y - S.y;
        curves.set(l.id, [S, { x: S.x + dx * 0.12, y: S.y + dy * 0.8 }, { x: p.x - dx * 0.5, y: p.y }, p]);
      }
      return curves;
    };
    const home = edges(n => ({ x: n.hx, y: n.hy }));
    for (const n of limbNodes) n.lastS = home.get(n.l.id)[0];

    // ---------- markup ----------
    const trunkC = color(0);
    let grafts = '', lines = '', forks = '';
    for (const n of limbNodes) {
      const l = n.l, c = color(l.id);
      if (n.mergeNode) {
        grafts += `<path class="graft" data-limb="${l.id}" style="--c:${c}"><title>${esc(nameOf(l))} was merged into ${esc(tree.trunkName)}</title></path>`;
      }
      lines += `<path class="line${l.forkKnown ? '' : ' unknown'}" data-limb="${l.id}" style="--c:${c}"/>`;
      if (l.parent > 0 && l.forkIdx > 0) forks += `<circle class="fork" r="2.6" data-limb="${l.id}" style="--c:${color(l.parent)}"/>`;
    }
    const nodeHtml = (/** @type {any} */ n, /** @type {number} */ i) => {
      if (n.kind === 'ev') {
        const ev = n.ev;
        const cls = `tev${ev.merge ? ' merge' : ''}${n.root ? ' root' : ''}`;
        const ring = ev.worktrees.length ? wtRing(ev.worktrees) : '';
        const tags = !compact && ev.tags.length ? `<div class="tev-label">${icon.tag}${esc(ev.tags.join(', '))}</div>` : '';
        return `<div class="tn" data-n="${i}" style="--r:${n.r}px;--c:${trunkC}"><div class="${cls}" data-ev="${ev.idx}" aria-label="Commit ${esc(ev.short)}">${ring}</div>${tags}</div>`;
      }
      const l = n.l;
      const cls = `tnode kind-${l.kind}${l.isHead ? ' head' : ''}${l.mergedAt !== undefined ? ' merged' : ''}${n === crown ? ' crown' : ''}`;
      const more = l.names.length > 1 ? `<span class="tl-more">+${l.names.length - 1}</span>` : '';
      const head = l.isHead ? '<span class="tl-head">HEAD</span>' : '';
      return `<div class="tn" data-n="${i}" style="--r:${n.r}px;--c:${color(l.id)}">` +
        `<div class="${cls}" data-limb="${l.id}" tabindex="0" role="button" aria-label="${esc(nameOf(l))}">${l.worktrees.length ? wtRing(l.worktrees) : ''}</div>` +
        `<div class="tlabel side-${n.side}" data-limb="${l.id}">${head}<span class="tl-name">${esc(nameOf(l))}</span>${more}${n === crown ? '<span class="tl-prod">production</span>' : ''}</div></div>`;
    };
    const wtRing = (/** @type {number[]} */ wis) => {
      const wts = wis.map(wi => snapshot.worktrees[wi]);
      return `<span class="wt-ring${wts.some(w => w.dirty) ? ' dirty' : ''}${wts.some(w => w.isCurrent) ? ' current' : ''}"></span>`;
    };

    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    host.innerHTML = `
      <svg class="tree-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <g class="grafts">${grafts}</g>
        <path class="trunk" style="--c:${trunkC}"/>
        <g class="lines">${lines}</g>
        <g class="forks">${forks}</g>
      </svg>
      <div class="tree-nodes">${nodes.map(nodeHtml).join('')}</div>`;

    const svg = /** @type {SVGElement} */ (host.querySelector('.tree-svg'));
    for (const el of host.querySelectorAll('.tn')) nodes[Number(/** @type {HTMLElement} */ (el).dataset.n)].el = el;
    for (const n of limbNodes) {
      const sel = `[data-limb="${n.l.id}"]`;
      n.lineEl = svg.querySelector(`.line${sel}`);
      n.forkEl = svg.querySelector(`.fork${sel}`);
      n.graftEl = svg.querySelector(`.graft${sel}`);
    }

    // ---------- simulation: keep what moved before, grow new nodes out of what they hang from ----------
    const first = sims.size === 0;
    const calm = reduced.matches;
    const next = new Map();
    [...nodes].sort((a, b) => a.hy - b.hy).forEach((n, rank) => {
      let s = sims.get(n.key);
      if (!s) {
        s = { x: n.hx, y: n.hy, vx: 0, vy: 0, s: 0, vs: 0, born: false, delay: first ? Math.min(70, rank * 2) : 4, phase: Math.random() * 6.283 };
      }
      if (calm) Object.assign(s, { x: n.hx, y: n.hy, vx: 0, vy: 0, s: 1, vs: 0, born: true, delay: 0 });
      next.set(n.key, s);
      n.sim = s;
    });
    sims = next;

    scene = { host, svg, tree, ctx, nodes, trunk, limbNodes, edges, trunkEl: svg.querySelector('.trunk') };
    cancelAnimationFrame(raf);
    raf = 0;
    lastT = 0;
    frame(performance.now());

    // ---------- geometry for overlays (merge preview), at home positions ----------
    /** @type {Map<number, {x:number,y:number,w:number,h:number}>} */
    const rects = new Map();
    for (const n of [crown, ...limbNodes]) rects.set(n.l.id, { x: n.hx - n.r - 3, y: n.hy - n.r - 3, w: 2 * n.r + 6, h: 2 * n.r + 6 });
    /** @type {Map<string, Pt>} */
    const points = new Map();
    points.set(tree.events[0].hash, { x: cx, y: TRUNK_TOP });
    for (const n of trunk) if (n.kind === 'ev') points.set(n.ev.hash, { x: n.hx, y: n.hy });
    for (const n of limbNodes) if (n.l.forkHash && !points.has(n.l.forkHash)) points.set(n.l.forkHash, home.get(n.l.id)[0]);
    for (const n of limbNodes) if (!points.has(n.l.tip)) points.set(n.l.tip, { x: n.hx, y: n.hy });
    return { cx, width, height, rects, points, compact };
  }

  // ---------- animation ----------

  function frame(/** @type {number} */ t) {
    raf = 0;
    const sc = scene;
    if (!sc) return;
    const calm = reduced.matches;
    // Steps are tuned for 60 Hz; scale them by the real frame time so 120 Hz screens move at the same pace.
    const k = lastT ? Math.min(2, (t - lastT) / (1000 / 60)) : 1;
    lastT = t;
    const damp = DAMP ** k, growDamp = GROW_DAMP ** k;
    let moving = false;
    for (const n of sc.nodes) {
      const s = n.sim;
      if (!s.born) {
        // Waiting to appear: sit where it will grow from.
        const src = n.kind === 'ev' ? n.prev.sim : n.kind === 'limb' && n.lastS ? n.lastS : { x: n.hx, y: n.hy };
        s.x = src.x;
        s.y = src.y;
        if ((s.delay -= k) > 0) {
          n.el.style.transform = `translate(${f1(s.x)}px,${f1(s.y)}px) scale(0)`;
          n.el.style.opacity = '0';
          moving = true;
          continue;
        }
        s.born = true;
      }
      if (drag?.active && drag.node === n) {
        s.vx = drag.px - s.x;
        s.vy = drag.py - s.y;
        s.x = drag.px;
        s.y = drag.py;
      } else {
        let tx = n.hx + n.ox, ty = n.hy + n.oy;
        if (calm) {
          s.x = tx;
          s.y = ty;
          s.vx = s.vy = 0;
        } else {
          tx += Math.cos(t * 0.0006 + s.phase) * n.amp;
          ty += Math.sin(t * 0.0008 + s.phase * 1.7) * n.amp;
          s.vx = (s.vx + (tx - s.x) * SPRING * k) * damp;
          s.vy = (s.vy + (ty - s.y) * SPRING * k) * damp;
          s.x += s.vx * k;
          s.y += s.vy * k;
        }
      }
      if (calm) s.s = 1;
      else {
        s.vs = (s.vs + (1 - s.s) * GROW * k) * growDamp;
        s.s = Math.min(1, s.s + s.vs * k);
      }
      if (Math.abs(s.vx) + Math.abs(s.vy) + Math.abs(s.vs) > 0.02) moving = true;
      n.el.style.transform = `translate(${s.x.toFixed(2)}px,${s.y.toFixed(2)}px) scale(${s.s.toFixed(3)})`;
      // New nodes fade in as they grow; the opacity is dropped once they're whole.
      if (s.s < 0.999) n.el.style.opacity = Math.min(1, s.s * 1.4).toFixed(3);
      else if (n.el.style.opacity) n.el.style.opacity = '';
    }
    drawEdges(sc);
    // Without reduced motion the tree keeps breathing; with it, frames only run while something moves.
    if (!calm || moving || drag) raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (!raf && scene) {
      lastT = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function drawEdges(/** @type {any} */ sc) {
    const pos = (/** @type {any} */ n) => n.sim;
    sc.trunkEl.setAttribute('d', spline(sc.trunk.map(pos)));
    const curves = sc.edges(pos);
    for (const n of sc.limbNodes) {
      const P = curves.get(n.l.id);
      n.lastS = P[0];
      n.lineEl.setAttribute('d', pathOf(P));
      if (n.forkEl) {
        n.forkEl.setAttribute('cx', f1(P[0].x));
        n.forkEl.setAttribute('cy', f1(P[0].y));
      }
      if (n.graftEl) {
        const E = P[3], M = n.mergeNode.sim, sgn = n.side === 'L' ? -1 : 1;
        n.graftEl.setAttribute('d', `M${f1(E.x)} ${f1(E.y)}C${f1(E.x + (M.x - E.x) * 0.55)} ${f1(E.y)} ${f1(M.x + sgn * 36)} ${f1(M.y)} ${f1(M.x)} ${f1(M.y)}`);
      }
    }
  }

  // ---------- interaction: drag nodes, pan the background, hover for details ----------

  /** Nodes that follow a drag, with how much of it they take: neighbors on the tree, fading per hop. */
  function influence(/** @type {any} */ start) {
    const out = new Map([[start, 1]]);
    let ring = [start];
    for (let hop = 1; hop <= 3 && ring.length; hop++) {
      const nextRing = [];
      for (const n of ring) {
        for (const m of n.adj) {
          if (out.has(m)) continue;
          out.set(m, FOLLOW ** hop);
          nextRing.push(m);
        }
      }
      ring = nextRing;
    }
    out.delete(start);
    return out;
  }

  function wire(/** @type {HTMLElement} */ host, /** @type {HTMLElement | undefined} */ scroller) {
    if (wired === host) return;
    wired = host;
    wiredScroller = scroller ?? null;
    // Drags start on the scroller, so they also work on the pan margins around the tree; node
    // hover stays on the host.
    if (scroller) {
      scroller.addEventListener('pointerdown', onDown);
      scroller.addEventListener('pointermove', onMove);
      scroller.addEventListener('pointerup', onUp);
      scroller.addEventListener('pointercancel', onUp);
      // A drag or a pan ends with a click on whatever is under the pointer; it shouldn't select it.
      scroller.addEventListener('click', e => {
        if (!suppressClick) return;
        suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      }, true);
    }
    host.addEventListener('pointerover', onOver);
    host.addEventListener('pointerout', onOut);
    host.addEventListener('contextmenu', hideTip);
    host.addEventListener('focusin', e => {
      const el = /** @type {HTMLElement} */ (e.target);
      const w = el.closest?.('.tn');
      if (!w || !scene || !el.matches(':focus-visible')) return;
      const r = el.getBoundingClientRect();
      showTip(scene.nodes[Number(/** @type {HTMLElement} */ (w).dataset.n)], r.right, r.top);
    });
    host.addEventListener('focusout', hideTip);
    document.addEventListener('scroll', hideTip, true);
    reduced.addEventListener?.('change', kick);
  }

  function onDown(/** @type {PointerEvent} */ e) {
    suppressClick = false;
    hideTip();
    if (e.button !== 0 || !scene) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const w = /** @type {HTMLElement | null} */ (target.closest('.tn'));
    if (w) {
      if (scene.ctx.isBusy?.()) return;
      const n = scene.nodes[Number(w.dataset.n)];
      drag = { node: n, id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: n.sim.x, y0: n.sim.y, px: n.sim.x, py: n.sim.y, active: false };
    } else if (scene.ctx.canPan?.() && scene.ctx.scroller &&
        !target.closest('.merge-ghost') && !target.closest('.merge-banner')) {
      const sc = scene.ctx.scroller;
      pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, l: sc.scrollLeft, t: sc.scrollTop, active: false };
    }
  }

  /** Keep receiving moves outside the host; the pointer may already be gone, which is fine. */
  function capture(/** @type {number} */ id) {
    try { wiredScroller?.setPointerCapture(id); } catch { /* not an active pointer */ }
  }

  function onMove(/** @type {PointerEvent} */ e) {
    if (drag && e.pointerId === drag.id && scene) {
      const z = scene.ctx.getZoom?.() || 1;
      const dx = (e.clientX - drag.sx) / z, dy = (e.clientY - drag.sy) / z;
      if (!drag.active) {
        if (Math.hypot(dx, dy) < 3) return;
        drag.active = true;
        drag.weights = influence(drag.node);
        capture(e.pointerId);
        wired?.classList.add('dragging');
        hideTip();
      }
      drag.px = drag.x0 + dx;
      drag.py = drag.y0 + dy;
      const ox = drag.px - drag.node.hx, oy = drag.py - drag.node.hy;
      for (const [n, k] of drag.weights) {
        n.ox = ox * k;
        n.oy = oy * k;
      }
      kick();
      return;
    }
    if (pan && e.pointerId === pan.id && scene) {
      const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
      if (!pan.active) {
        if (Math.hypot(dx, dy) < 4) return;
        pan.active = true;
        capture(e.pointerId);
        wired?.classList.add('panning');
      }
      scene.ctx.scroller.scrollLeft = pan.l - dx;
      scene.ctx.scroller.scrollTop = pan.t - dy;
      return;
    }
    if (tipNode) placeTip(e.clientX, e.clientY);
  }

  function onUp(/** @type {PointerEvent} */ e) {
    if (drag && e.pointerId === drag.id) {
      if (drag.active) {
        suppressClick = true;
        for (const [n] of drag.weights) n.ox = n.oy = 0;
        wired?.classList.remove('dragging');
      }
      drag = null;
      kick();
    }
    if (pan && e.pointerId === pan.id) {
      if (pan.active) {
        suppressClick = true;
        wired?.classList.remove('panning');
      }
      pan = null;
    }
  }

  function onOver(/** @type {PointerEvent} */ e) {
    if (!scene || drag?.active || pan?.active || scene.ctx.isBusy?.()) return;
    const w = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.tn'));
    if (w) showTip(scene.nodes[Number(w.dataset.n)], e.clientX, e.clientY);
  }

  function onOut(/** @type {PointerEvent} */ e) {
    const w = /** @type {HTMLElement} */ (e.target).closest('.tn');
    const to = /** @type {any} */ (e.relatedTarget);
    if (w && !(to instanceof Element && to.closest('.tn') === w)) hideTip();
  }

  // ---------- hover card ----------

  function showTip(/** @type {any} */ n, /** @type {number} */ x, /** @type {number} */ y) {
    if (tipNode === n || !scene) return;
    tipNode = n;
    tip.innerHTML = n.kind === 'ev' ? eventTip(n.ev) : limbTip(n.l);
    tip.style.setProperty('--c', scene.ctx.color(n.kind === 'ev' ? 0 : n.l.id));
    placeTip(x, y);
    tip.classList.add('show');
  }

  function hideTip() {
    tipNode = null;
    tip.classList.remove('show');
  }

  function placeTip(/** @type {number} */ x, /** @type {number} */ y) {
    const w = tip.offsetWidth, h = tip.offsetHeight, m = 8;
    let left = x + 18, top = y + 14;
    if (left + w > window.innerWidth - m) left = x - 18 - w;
    if (left < m) {
      // No room beside the pointer (the sidebar): center the card below it, or above if that fits better.
      left = Math.min(Math.max(m, x - w / 2), window.innerWidth - m - w);
      top = y + 22 + h > window.innerHeight - m && y - 22 - h >= m ? y - 22 - h : y + 22;
    }
    if (top + h > window.innerHeight - m) top = window.innerHeight - m - h;
    tip.style.left = `${Math.max(m, left)}px`;
    tip.style.top = `${Math.max(m, top)}px`;
  }

  function limbName(/** @type {any} */ tree, /** @type {any} */ l) {
    return l.names[0] || (l.id === 0 ? tree.trunkName : l.kind === 'detached' ? 'detached HEAD' : l.short);
  }

  /** Limbs from `l` down to the trunk, each with the point on it where the previous one left (0 = its tip). */
  function pathDown(/** @type {any[]} */ limbs, /** @type {any} */ l) {
    const out = [{ id: l.id, entry: 0 }];
    for (let c = l; c.parent >= 0; c = limbs[c.parent]) out.push({ id: c.parent, entry: c.forkIdx });
    return out;
  }

  /**
   * Commits on `a` that `b` lacks (ahead) and the reverse (behind), counted along first-parent
   * lines through the tree. null when a fork point is older than the loaded history.
   */
  function relate(/** @type {any[]} */ limbs, /** @type {any} */ a, /** @type {any} */ b) {
    if ((b.id === 0 && a.mergedAt !== undefined) || (a.id === 0 && b.mergedAt !== undefined)) return { merged: true };
    const pa = pathDown(limbs, a), pb = pathDown(limbs, b);
    const inB = new Map(pb.map((p, k) => [p.id, k]));
    const i = pa.findIndex(p => inB.has(p.id));
    if (i < 0) return null;
    const j = /** @type {number} */ (inB.get(pa[i].id));
    const known = (/** @type {any[]} */ p, /** @type {number} */ k) => p.slice(0, k).every(x => limbs[x.id].forkKnown);
    if (!known(pa, i) || !known(pb, j)) return null;
    const dist = (/** @type {any[]} */ p, /** @type {number} */ k) => p.slice(0, k).reduce((s, x) => s + limbs[x.id].ahead - x.entry, 0);
    const ea = pa[i].entry, eb = pb[j].entry;
    return { ahead: dist(pa, i) + Math.max(0, eb - ea), behind: dist(pb, j) + Math.max(0, ea - eb) };
  }

  const kv = (/** @type {string} */ k, /** @type {string} */ v) => `<div class="tt-kv"><span>${k}</span><span>${v}</span></div>`;
  const ab = (/** @type {number} */ a, /** @type {number} */ b) => `<b>${a}</b> ahead · <b>${b}</b> behind`;

  function limbTip(/** @type {any} */ l) {
    const { tree, ctx } = scene;
    const { esc, relTime, color, snapshot } = ctx;
    const limbs = tree.limbs;
    const name = (/** @type {any} */ x) => limbName(tree, x);
    const chips = [
      l.isHead && 'HEAD', l.id === 0 && 'production', l.kind === 'remote' && 'remote', l.kind === 'detached' && 'detached',
      l.mergedAt !== undefined && 'merged',
    ].filter(Boolean);

    const rows = [];
    if (l.id === 0) rows.push(kv('Production', `${plural(tree.trunkLength, 'commit')} on its first-parent line`));
    else if (l.forkKnown) rows.push(kv(`vs ${esc(name(limbs[l.parent]))}`, l.ahead || l.behind ? ab(l.ahead, l.behind) : 'same commit'));
    else rows.push(kv('Forked', 'before the loaded history'));
    if (l.upstream) {
      const u = l.upstream;
      rows.push(kv('Upstream', `${esc(u.name)} · ${u.gone ? 'gone' : u.ahead || u.behind ? `↑${u.ahead} ↓${u.behind}` : 'in sync'}`));
    } else {
      rows.push(kv('Upstream', l.kind === 'remote' ? 'remote only' : l.kind === 'detached' ? 'none, detached' : 'local only'));
    }
    for (const wi of l.worktrees) {
      const w = snapshot.worktrees[wi];
      rows.push(kv('Worktree', `${esc(w.name)} · ${w.prunable ? 'missing' : w.dirty ? plural(w.dirty, 'change') : 'clean'}${w.isCurrent ? ' · this window' : ''}`));
    }

    // Every other branch, closest first, with diverging bars: behind to the left, ahead to the right.
    const others = limbs.filter((/** @type {any} */ o) => o.id !== l.id).map((/** @type {any} */ o) => ({ o, c: relate(limbs, l, o) }));
    const dist = (/** @type {any} */ c) => (!c ? Infinity : c.merged ? -1 : c.ahead + c.behind);
    others.sort((a, b) => dist(a.c) - dist(b.c));
    const shown = others.slice(0, CMP_ROWS);
    const max = Math.max(1, ...shown.map(r => (r.c && !r.c.merged ? Math.max(r.c.ahead, r.c.behind) : 0)));
    const bar = (/** @type {number} */ v) => `${v ? Math.max(6, Math.round(Math.sqrt(v / max) * 100)) : 0}%`;
    const cmp = shown.map(({ o, c }) => {
      const label = `<span class="tt-cmp-name"><i class="tt-dot" style="background:${color(o.id)}"></i><span>${esc(name(o))}</span></span>`;
      const na = !c ? 'fork not loaded' : c.merged ? 'merged' : !c.ahead && !c.behind ? 'same commit' : '';
      if (na) return `<div class="tt-cmp-row">${label}<span class="tt-cmp-na">${na}</span></div>`;
      return `<div class="tt-cmp-row">${label}<span class="tt-bar behind"><b style="width:${bar(c.behind)}"></b></span>` +
        `<span class="tt-bar ahead"><b style="width:${bar(c.ahead)}"></b></span><span class="tt-num">↑${c.ahead} ↓${c.behind}</span></div>`;
    }).join('');
    const compare = others.length
      ? `<div class="tt-sec"><span>Compared with ${others.length === 1 ? 'the other branch' : `${others.length} other branches`}</span><span class="tt-legend">↓ behind · ahead ↑</span></div>` +
        `<div class="tt-cmp">${cmp}</div>` +
        `<div class="tt-foot">${others.length > CMP_ROWS ? `${others.length - CMP_ROWS} more · ` : ''}counted along first-parent lines</div>`
      : '';

    return `<div class="tt-head"><i class="tt-dot big"></i><span class="tt-title">${esc(name(l))}</span>${chips.map(c => `<span class="tt-chip">${c}</span>`).join('')}</div>` +
      (l.names.length > 1 ? `<div class="tt-also">also ${esc(l.names.slice(1).join(', '))}</div>` : '') +
      `<div class="tt-commit"><span class="mono">${esc(l.short)}</span> ${esc(l.subject)}</div>` +
      `<div class="tt-meta">${esc(l.author)} · ${relTime(l.time)}</div>` +
      `<div class="tt-rows">${rows.join('')}</div>${compare}`;
  }

  function eventTip(/** @type {any} */ ev) {
    const { tree, ctx } = scene;
    const { esc, relTime, snapshot } = ctx;
    const limbs = tree.limbs;
    const names = (/** @type {any[]} */ ls) => ls.map(l => esc(limbName(tree, l))).join(', ');
    const forks = limbs.filter((/** @type {any} */ l) => l.id > 0 && l.parent === 0 && l.forkIdx === ev.idx);
    const merged = limbs.filter((/** @type {any} */ l) => l.mergedAt === ev.idx);
    const isLast = ev === tree.events[tree.events.length - 1];
    const chips = [ev.merge && 'merge', isLast && (ev.root ? 'first commit' : 'older history not loaded')].filter(Boolean);
    const rows = [kv('On', `${esc(tree.trunkName)}~${ev.idx} · ${plural(ev.idx, 'commit')} below the tip`)];
    if (ev.tags.length) rows.push(kv('Tags', esc(ev.tags.join(', '))));
    if (forks.length) rows.push(kv('Branches', `${names(forks)} leave${forks.length === 1 ? 's' : ''} here`));
    if (merged.length) rows.push(kv('Merged', names(merged)));
    for (const wi of ev.worktrees) {
      const w = snapshot.worktrees[wi];
      rows.push(kv('Worktree', `${esc(w.name)} · ${w.dirty ? plural(w.dirty, 'change') : 'clean'}${w.isCurrent ? ' · this window' : ''}`));
    }
    return `<div class="tt-head"><i class="tt-dot big"></i><span class="tt-title mono">${esc(ev.short)}</span>${chips.map(c => `<span class="tt-chip">${c}</span>`).join('')}</div>` +
      `<div class="tt-commit">${esc(ev.subject)}</div>` +
      `<div class="tt-meta">${esc(ev.author)} · ${relTime(ev.time)}</div>` +
      `<div class="tt-rows">${rows.join('')}</div>`;
  }

  // @ts-ignore
  window.GitTreeView = { render };
})();
