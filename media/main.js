// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const TreeView = window.GitTreeView;

  const ROW_H = 28;
  // Lane / branch colours. The dark set is tuned for dark backgrounds, the light set for white:
  // the same hue, dark enough to read as a 2px line or a 5px dot on white and to stay legible
  // as the 12px hash in the details panel.
  const LANE_DARK = ['#4c9aff', '#f5a623', '#3ecf8e', '#e5534b', '#b37feb', '#2ec4d6', '#ff7eb6', '#a3b23a', '#ff8c42', '#7a8cff'];
  const LANE_LIGHT = ['#2563eb', '#b45309', '#059669', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];
  /** Node border colours in the tree view; mid-tone so they read on both light and dark themes. */
  const NODE_DARK = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1'];
  const isLightTheme = () =>
    document.body.classList.contains('vscode-light') ||
    document.body.classList.contains('vscode-high-contrast-light');
  const color = (/** @type {number} */ i) => { const p = isLightTheme() ? LANE_LIGHT : LANE_DARK; return p[i % p.length]; };
  const treeColor = (/** @type {number} */ i) => { const p = isLightTheme() ? LANE_LIGHT : NODE_DARK; return p[i % p.length]; };

  const svgIcon = (/** @type {string} */ body) =>
    `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICON = {
    branch: svgIcon('<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 6.6c0 3.2-7 2-7 4.3"/>'),
    remote: svgIcon('<path d="M4.6 12.5h6.8a2.9 2.9 0 0 0 .3-5.8 3.9 3.9 0 0 0-7.5 1A2.4 2.4 0 0 0 4.6 12.5z"/>'),
    tag: svgIcon('<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>'),
    folder: svgIcon('<path d="M1.8 3.5h4.3l1.5 1.6h6.6v7.4H1.8z"/>'),
    commit: svgIcon('<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>'),
    repo: svgIcon('<path d="M3.5 2.5h9v9h-9a1.5 1.5 0 0 0 0 3h9M3.5 2.5v10.5"/>'),
    refresh: svgIcon('<path d="M13 8a5 5 0 1 1-1.6-3.7M13.2 2.2v2.9h-2.9"/>'),
    open: svgIcon('<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4"/>'),
    copy: svgIcon('<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5v-3h-8v8h3"/>'),
    close: svgIcon('<path d="M4 4l8 8M12 4l-8 8"/>'),
    up: svgIcon('<path d="M8 13V3M4 7l4-4 4 4"/>'),
    down: svgIcon('<path d="M8 3v10M4 9l4 4 4-4"/>'),
    zoomIn: svgIcon('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3M5 7h4M7 5v4"/>'),
    zoomOut: svgIcon('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3M5 7h4"/>'),
    move: svgIcon('<path d="M8 2v12M2 8h12"/><path d="m8 2-2.2 2.2M8 2l2.2 2.2M8 14l-2.2-2.2M8 14l2.2-2.2M2 8l2.2-2.2M2 8l2.2 2.2M14 8l-2.2-2.2M14 8l-2.2 2.2"/>'),
    check: svgIcon('<path d="M3.5 8.5l3 3 6-7"/>'),
    warn: svgIcon('<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3.2M8 11.7v.1"/>'),
    swap: svgIcon('<path d="M5 2.5v11M2.5 5L5 2.5 7.5 5M11 13.5v-11M8.5 11l2.5 2.5 2.5-2.5"/>'),
    merge: svgIcon('<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8M4.5 5.5c0 4 7 2.5 7 5.4"/>'),
  };

  /** @type {any} */
  let data = null;
  /** Current selection: { kind: 'row', i } | { kind: 'limb', id } | { kind: 'ev', idx } | null */
  /** @type {any} */
  let sel = null;
  /** Hash whose details are being shown (to match async responses). */
  let detailsHash = '';
  let query = '';
  /** @type {any[]} */
  let matches = [];
  let matchIdx = -1;
  /** @type {Map<string, number>} */
  let rowIndex = new Map();
  /** @type {number[][]} */
  let children = [];
  /** @type {any} */
  let loadingTimer;
  /** Layout of the last tree render, or null when nothing is drawn. */
  /** @type {any} */
  let geometry = null;

  const saved = vscode.getState() || {};
  query = saved.query || '';
  let zoom = saved.zoom || 1; // target; the view eases toward it
  let shownZoom = zoom;
  /** Pan with the mouse: dragging the background moves the view, inside margins that keep the tree on screen. */
  let pan = saved.pan !== false;

  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  app.innerHTML = `
    <header class="toolbar">
      <div class="repo">${ICON.repo}<select id="repoSelect" title="Repository"></select><span id="repoName"></span></div>
      <div class="seg" id="viewSeg">
        <button data-view="tree" title="Every branch, growing from the production branch">Tree</button>
        <button data-view="graph" title="Every commit, in lanes">Graph</button>
      </div>
      <div class="seg" id="modeSeg">
        <button data-mode="full" title="Every commit">History</button>
        <button data-mode="topology" title="Only branch tips, worktree heads, forks and merges">Topology</button>
      </div>
      <label class="chk"><input type="checkbox" id="optRemotes"> Remotes</label>
      <label class="chk"><input type="checkbox" id="optTags"> Tags</label>
      <div class="search">
        <input id="search" type="text" placeholder="Search branch, hash, message…" spellcheck="false">
        <span id="searchCount"></span>
        <button class="icon-btn" id="searchPrev" title="Previous match (Shift+Enter)">${ICON.up}</button>
        <button class="icon-btn" id="searchNext" title="Next match (Enter)">${ICON.down}</button>
      </div>
      <div class="spacer"></div>
      <button id="panBtn" class="icon-btn" aria-pressed="true" title="Move the view by dragging the background · click to turn off">${ICON.move}</button>
      <div class="zoom" id="zoomCtl">
        <button class="icon-btn" id="zoomOut" title="Zoom out (Ctrl/Cmd + wheel)">${ICON.zoomOut}</button>
        <button class="zoom-val" id="zoomVal" title="Reset zoom">100%</button>
        <button class="icon-btn" id="zoomIn" title="Zoom in (Ctrl/Cmd + wheel)">${ICON.zoomIn}</button>
      </div>
      <span id="stats" class="stats"></span>
      <button id="refreshBtn" class="icon-btn" title="Refresh">${ICON.refresh}</button>
    </header>
    <section id="worktrees" class="worktrees"></section>
    <div class="body">
      <canvas id="particles" class="particles" aria-hidden="true"></canvas>
      <div id="treeScroller" class="scroller tree-scroller" tabindex="0">
        <div id="mergeBanner" class="merge-banner" hidden></div>
        <div id="panWrap" class="pan-wrap"><div id="treeHost" class="tree-host"></div></div>
      </div>
      <div id="scroller" class="scroller" tabindex="0">
        <div id="colhead" class="row colhead"><span>Hash</span><span>Description</span><span>Author</span><span>Date</span></div>
        <div id="canvas" class="canvas">
          <div id="rows"></div>
          <svg id="graph" class="graph"></svg>
        </div>
        <div id="more" class="more" hidden><button id="moreBtn" class="btn">Load more commits</button></div>
      </div>
      <aside id="details" class="details" hidden></aside>
    </div>
    <div id="overlay" class="overlay" hidden><div class="spinner"></div></div>
    <div id="message" class="message" hidden></div>`;

  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const scroller = $('scroller');
  const treeScroller = $('treeScroller');
  const panWrap = $('panWrap');
  const treeHost = $('treeHost');
  const rowsEl = $('rows');
  const svg = $('graph');
  const detailsEl = $('details');
  const searchEl = $('search');
  searchEl.value = query;
  // @ts-ignore
  window.GitTreeParticles?.start($('particles'), () => (isLightTheme() ? LANE_LIGHT : NODE_DARK));

  const esc = (/** @type {any} */ s) =>
    String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

  function relTime(/** @type {number} */ t) {
    const s = Date.now() / 1000 - t;
    if (s < 60) return 'just now';
    const units = /** @type {[number, string][]} */ ([[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']]);
    for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
    return '';
  }
  const absTime = (/** @type {number} */ t) => new Date(t * 1000).toLocaleString();
  const isTree = () => data?.options.view === 'tree';
  const saveState = (/** @type {any} */ patch) => vscode.setState({ ...vscode.getState(), ...patch });

  // ---------- messages ----------

  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'loading':
        clearTimeout(loadingTimer);
        loadingTimer = setTimeout(() => ($('overlay').hidden = false), 250);
        break;
      case 'unchanged':
        stopLoading();
        break;
      case 'data':
        stopLoading();
        $('message').hidden = true;
        onData(m);
        break;
      case 'empty':
      case 'error':
        stopLoading();
        showMessage(m.type === 'error' ? `Git error: ${m.message}` : m.message);
        break;
      case 'commitDetails':
        if (m.hash === detailsHash) renderCommitExtra(m);
        break;
      case 'mergePreview':
        mergeCache.set(m.key, m.error ? { error: m.error } : m.preview);
        if (merge) drawMergePreview();
        break;
      case 'mergeDone':
        mergeBusy = false;
        if (m.ok) endMerge();
        else if (merge) drawMergePreview();
        break;
      case 'wipDetails':
        if (m.hash === detailsHash) renderWipExtra(m);
        break;
    }
  });

  function stopLoading() {
    clearTimeout(loadingTimer);
    $('overlay').hidden = true;
  }

  function showMessage(/** @type {string} */ text) {
    const el = $('message');
    el.textContent = text;
    el.hidden = false;
  }

  /** Stable key for the current selection, so it survives refreshes. */
  function selectionKey() {
    if (!sel || !data) return saved.selected;
    if (sel.kind === 'row') return `row:${data.graph?.rows[sel.i]?.hash}`;
    if (sel.kind === 'limb') return `limb:${data.tree?.limbs[sel.id]?.names[0] ?? data.tree?.limbs[sel.id]?.tip}`;
    if (sel.kind === 'ev') return `ev:${data.tree?.events.find((/** @type {any} */ e) => e.idx === sel.idx)?.hash}`;
  }

  function restoreSelection(/** @type {string | undefined} */ key) {
    if (!key) return clearSelection();
    const [kind, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (isTree() && data.tree) {
      if (kind === 'limb') {
        const l = data.tree.limbs.find((/** @type {any} */ l) => l.names[0] === value || l.tip === value);
        if (l) return selectLimb(l.id, false);
      }
      if (kind === 'ev') {
        const ev = data.tree.events.find((/** @type {any} */ e) => e.hash === value);
        if (ev) return selectEvent(ev.idx, false);
      }
    } else if (!isTree() && data.graph && kind === 'row') {
      const i = rowIndex.get(value);
      if (i !== undefined) return selectRow(i, false);
    }
    clearSelection();
  }

  function onData(/** @type {any} */ m) {
    mergeCache.clear();
    const prevKey = selectionKey();
    const prevView = data?.options.view;
    data = m;
    rowIndex = new Map();
    children = [];
    if (data.graph) {
      rowIndex = new Map(data.graph.rows.map((/** @type {any} */ r, /** @type {number} */ i) => [r.hash, i]));
      children = data.graph.rows.map(() => []);
      data.graph.rows.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
        for (const p of r.parents) {
          const pi = rowIndex.get(p);
          if (pi !== undefined) children[pi].push(i);
        }
      });
    }
    treeScroller.hidden = !isTree();
    scroller.hidden = isTree();
    renderToolbar();
    renderWorktrees();
    if (isTree()) renderTree();
    else if (data.graph) renderGraph();
    if (prevView && prevView !== data.options.view) clearSelection();
    else restoreSelection(prevKey);
    applySearch(false);
  }

  // ---------- toolbar ----------

  function renderToolbar() {
    const { repos, activeRoot, options, snapshot, tree } = data;
    const sel = $('repoSelect');
    sel.hidden = repos.length < 2;
    $('repoName').hidden = repos.length >= 2;
    $('repoName').textContent = snapshot.name;
    sel.innerHTML = repos.map((/** @type {any} */ r) =>
      `<option value="${esc(r.root)}" ${r.root === activeRoot ? 'selected' : ''} title="${esc(r.root)}">${esc(r.name)}</option>`).join('');
    for (const b of $('viewSeg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.view === options.view);
    for (const b of $('modeSeg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === options.mode);
    $('modeSeg').hidden = isTree();
    $('zoomCtl').hidden = !isTree();
    $('panBtn').hidden = !isTree();
    document.body.classList.toggle('tree-view', isTree());
    $('optRemotes').checked = options.remotes;
    $('optTags').checked = options.tags;
    const wts = snapshot.worktrees.filter((/** @type {any} */ w) => !w.bare).length;
    const branches = tree ? tree.limbs.length : snapshot.branchCount;
    $('stats').textContent = isTree()
      ? `${branches} branch${branches === 1 ? '' : 'es'} · ${wts} worktree${wts === 1 ? '' : 's'}`
      : `${snapshot.commitCount}${snapshot.truncated ? '+' : ''} commits · ${snapshot.branchCount} branches · ${wts} worktree${wts === 1 ? '' : 's'}`;
    $('more').hidden = !snapshot.truncated;
  }

  $('repoSelect').addEventListener('change', (/** @type {any} */ e) => vscode.postMessage({ type: 'selectRepo', root: e.target.value }));
  $('viewSeg').addEventListener('click', (/** @type {any} */ e) => {
    const view = e.target.closest('button')?.dataset.view;
    if (view && data && view !== data.options.view) vscode.postMessage({ type: 'setOptions', options: { view } });
  });
  $('modeSeg').addEventListener('click', (/** @type {any} */ e) => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (mode && data && mode !== data.options.mode) vscode.postMessage({ type: 'setOptions', options: { mode } });
  });
  $('optRemotes').addEventListener('change', (/** @type {any} */ e) => vscode.postMessage({ type: 'setOptions', options: { remotes: e.target.checked } }));
  $('optTags').addEventListener('change', (/** @type {any} */ e) => vscode.postMessage({ type: 'setOptions', options: { tags: e.target.checked } }));
  $('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('moreBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'setOptions', options: { maxCommits: data.options.maxCommits + 1000 } }));

  // ---------- zoom (tree view) ----------

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let zoomRaf = 0;
  /** Point in the scroller (client px from its corner) that stays still while the zoom changes. */
  let zoomAnchor = { x: 0, y: 0 };
  /**
   * Content-space position of the tree's top-left as it is actually rendered — pan margins,
   * centering and the zoom shift included. Measured, not computed: CSS zoom renders the tree
   * where the layout around it says, but reports a different box position.
   */
  function treeOffset() {
    const s = treeScroller.getBoundingClientRect();
    const t = treeHost.getBoundingClientRect();
    return { x: t.left - s.left + treeScroller.scrollLeft, y: t.top - s.top + treeScroller.scrollTop };
  }

  /** Applies a zoom level, scrolling so the content under the anchor doesn't move. */
  function applyZoom(/** @type {number} */ z) {
    const from = treeOffset();
    const ux = (treeScroller.scrollLeft + zoomAnchor.x - from.x) / shownZoom;
    const uy = (treeScroller.scrollTop + zoomAnchor.y - from.y) / shownZoom;
    shownZoom = z;
    treeHost.style.zoom = String(z);
    applyPanMargins(); // the tree's rendered size changed: re-fit the padding around it
    const to = treeOffset(); // re-measured: zooming and padding both move where the tree sits
    treeScroller.scrollLeft = to.x + ux * z - zoomAnchor.x;
    treeScroller.scrollTop = to.y + uy * z - zoomAnchor.y;
  }

  function zoomFrame() {
    zoomRaf = 0;
    const d = zoom - shownZoom;
    if (Math.abs(d) < 0.001) { applyZoom(zoom); return; }
    applyZoom(shownZoom + d * 0.2);
    zoomRaf = requestAnimationFrame(zoomFrame);
  }

  function setZoom(/** @type {number} */ z, /** @type {{x:number,y:number} | undefined} */ anchor) {
    zoom = Math.max(0.4, Math.min(2, z));
    zoomAnchor = anchor || { x: treeScroller.clientWidth / 2, y: treeScroller.clientHeight / 2 };
    $('zoomVal').textContent = `${Math.round(zoom * 100)}%`;
    saveState({ zoom: Math.round(zoom * 100) / 100 });
    if (reducedMotion.matches || treeScroller.hidden) applyZoom(zoom);
    else if (!zoomRaf) zoomRaf = requestAnimationFrame(zoomFrame);
  }
  const stepZoom = (/** @type {number} */ dir) => setZoom(Math.round((zoom + dir * 0.1) * 10) / 10);
  $('zoomIn').addEventListener('click', () => stepZoom(1));
  $('zoomOut').addEventListener('click', () => stepZoom(-1));
  $('zoomVal').addEventListener('click', () => setZoom(1));
  treeScroller.addEventListener('wheel', (/** @type {WheelEvent} */ e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Proportional to the wheel delta, so trackpad pinches zoom smoothly and mouse wheels in even steps.
    const r = treeScroller.getBoundingClientRect();
    const dy = Math.max(-60, Math.min(60, e.deltaY));
    setZoom(zoom * Math.exp(-dy * 0.002), { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });
  treeHost.style.zoom = String(zoom);
  $('zoomVal').textContent = `${Math.round(zoom * 100)}%`;

  // ---------- pan (tree view): move the view with the mouse ----------

  /** Room the tree always keeps from the view's edges, whichever way it is dragged. */
  const PAN_MARGIN = 32;
  /** Pan padding around the tree, per axis: how much comes before it and after it. */
  /** @type {number[]} */
  let padX = [0, 0];
  /** @type {number[]} */
  let padY = [0, 0];

  /**
   * Padding one axis needs for a tree spanning `size` px inside a `view` px view. A tree that
   * fits exactly snug fills the view; one with room to spare keeps PAN_MARGIN free on both
   * sides and can be slid between them; one that doesn't fit pans from margin to margin — the
   * tree never crosses an edge on either side, so dragging it away always leaves room to drag
   * it back.
   */
  function axisPads(/** @type {number} */ size, /** @type {number} */ view) {
    const slack = view - size;
    if (slack < 0) return [PAN_MARGIN, PAN_MARGIN];
    const m = Math.round(Math.min(PAN_MARGIN, slack / 2));
    return [Math.round(slack - m), Math.round(slack - m)];
  }

  /**
   * Sizes the pan padding around the tree for the current view. The padding is what plain
   * scrolling clamps to, so the tree can be dragged freely but never across its margins. The
   * scroll is moved along with the padding, so resizing it doesn't jump the view.
   */
  function applyPanMargins() {
    const on = !!(pan && isTree() && geometry);
    let pad = '0px';
    if (on) {
      const r = treeHost.getBoundingClientRect();
      padX = axisPads(r.width, treeScroller.clientWidth);
      padY = axisPads(r.height, treeScroller.clientHeight);
      pad = `${padY[0]}px ${padX[0]}px ${padY[1]}px ${padX[1]}px`;
    } else {
      padX = padY = [0, 0];
    }
    if (panWrap.style.padding === pad) return;
    const before = treeOffset();
    panWrap.style.padding = pad;
    const after = treeOffset();
    treeScroller.scrollLeft += after.x - before.x;
    treeScroller.scrollTop += after.y - before.y;
  }

  function setPan(/** @type {boolean} */ on) {
    pan = on;
    saveState({ pan: on });
    const btn = $('panBtn');
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on
      ? 'Move the view by dragging the background · click to turn off'
      : 'Turn on moving the view by dragging the background';
    treeScroller.classList.toggle('pan-on', on);
    applyPanMargins();
  }
  $('panBtn').addEventListener('click', () => setPan(!pan));
  setPan(pan);

  // ---------- worktrees ----------

  function renderWorktrees() {
    const { snapshot } = data;
    const el = $('worktrees');
    const wts = snapshot.worktrees.map((/** @type {any} */ w, /** @type {number} */ i) => ({ w, i })).filter((/** @type {any} */ x) => !x.w.bare);
    // In the tree view worktrees are drawn in the tree itself; the strip only carries the legend.
    el.classList.toggle('legend-only', isTree());
    if (isTree()) {
      el.hidden = false;
      el.innerHTML = treeLegend();
      return;
    }
    if (!wts.length) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const cards = wts.map((/** @type {any} */ { w, i }) => {
      const limb = data.tree?.limbs.find((/** @type {any} */ l) => l.worktrees.includes(i));
      const ri = w.head ? rowIndex.get(w.head) : undefined;
      const row = ri !== undefined ? data.graph.rows[ri] : null;
      const c = isTree() ? (limb ? treeColor(limb.id) : 'var(--muted)') : row ? color(row.color) : 'var(--muted)';
      const short = limb?.short || row?.short || (w.head ? w.head.slice(0, 7) : '—');
      const state = w.prunable
        ? '<span class="wt-state warn">missing</span>'
        : w.dirty
          ? `<span class="wt-state dirty"><i class="dot-mark"></i>${w.dirty} changed</span>`
          : '<span class="wt-state clean">clean</span>';
      return `<div class="wt-card ${w.isCurrent ? 'current' : ''}" data-w="${i}" style="--c:${c}" title="${esc(w.path)}">
        <div class="wt-top"><i class="wt-swatch"></i>${ICON.folder}<span class="wt-name">${esc(w.name)}</span>
          ${w.isCurrent ? '<span class="pill">this window</span>' : ''}
          ${w.isMain ? '<span class="pill subtle">main</span>' : ''}
          ${w.locked ? '<span class="pill subtle">locked</span>' : ''}
          ${w.isCurrent ? '' : `<button class="icon-btn wt-open" data-open="${i}" title="Open worktree in new window">${ICON.open}</button>`}
        </div>
        <div class="wt-sub">
          <span class="wt-branch">${w.branch ? ICON.branch + esc(w.branch) : '<em>detached</em>'}</span>
          <span class="mono">${esc(short)}</span>
          ${state}
        </div>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="wt-title">Worktrees</div><div class="wt-cards">${cards}</div>${isTree() ? treeLegend() : graphLegend()}`;
  }

  function graphLegend() {
    const g = (/** @type {string} */ s) => `<svg width="20" height="20" viewBox="0 0 20 20">${s}</svg>`;
    const c = 'var(--fg)';
    return `<div class="legend">
      <span>${g(`<circle cx="10" cy="10" r="4" fill="${c}"/>`)}commit</span>
      <span>${g(`<circle cx="10" cy="10" r="4" class="bg-fill" stroke="${c}" stroke-width="2"/>`)}merge</span>
      <span>${g(`<circle cx="10" cy="10" r="8" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="10" cy="10" r="4.5" fill="${c}"/>`)}worktree HEAD</span>
      <span>${g(`<circle cx="10" cy="10" r="4.5" class="bg-fill" stroke="${c}" stroke-width="1.5" stroke-dasharray="2 2"/>`)}uncommitted</span>
    </div>`;
  }

  function treeLegend() {
    // A configured production branch that no longer exists falls back to detection; say so.
    const missing = data.production && data.tree && data.tree.trunkName !== data.production
      ? `<span class="warn">Production branch ${esc(data.production)} not found · showing ${esc(data.tree.trunkName)}</span>` : '';
    return `<div class="legend">${missing}
      <span>Hover a node for details · drag a node to move it${pan ? ' · drag the background to move the view' : ''} · right-click for actions</span>
      <span><svg width="26" height="12"><path d="M1 6H25" stroke="var(--fg)" stroke-dasharray="3 3" stroke-width="1.2"/></svg>merged into production</span>
      <span><svg width="16" height="16"><circle cx="8" cy="8" r="3.5" fill="var(--fg)"/><circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--fg)" stroke-width="1.2"/></svg>worktree checked out</span>
    </div>`;
  }

  $('worktrees').addEventListener('click', (/** @type {any} */ e) => {
    const open = e.target.closest('[data-open]');
    if (open) {
      vscode.postMessage({ type: 'openWorktree', path: data.snapshot.worktrees[Number(open.dataset.open)].path });
      return;
    }
    const card = e.target.closest('.wt-card');
    if (!card) return;
    const wi = Number(card.dataset.w);
    if (isTree()) {
      const limb = data.tree?.limbs.find((/** @type {any} */ l) => l.worktrees.includes(wi));
      if (limb) return selectLimb(limb.id, true);
      const ev = data.tree?.events.find((/** @type {any} */ e) => e.worktrees.includes(wi));
      if (ev) return selectEvent(ev.idx, true);
      return;
    }
    const wipRow = data.graph.rows.findIndex((/** @type {any} */ r) => r.wip && r.wip.worktree === wi);
    const headRow = rowIndex.get(data.snapshot.worktrees[wi].head);
    const target = wipRow >= 0 ? wipRow : headRow;
    if (target !== undefined) selectRow(target, true);
  });

  // ---------- tree view ----------

  function renderTree() {
    lastTreeWidth = treeScroller.clientWidth;
    geometry = TreeView.render(treeHost, data.tree, {
      snapshot: data.snapshot,
      color: treeColor,
      esc, relTime,
      icon: ICON,
      width: treeScroller.clientWidth / zoom,
      scroller: treeScroller,
      getZoom: () => shownZoom,
      canPan: () => pan,
      isBusy: () => !!merge,
    });
    applyPanMargins();
    if (!treeScroller.dataset.centered && geometry && treeScroller.clientWidth > 0) {
      // First render: start with the tree centered in the view — whole, when it fits; on the
      // trunk, when it is wider than the view; with the crown just inside the top edge, when it
      // is taller. The compact (sidebar) layout stays anchored at its top-left corner, where its
      // trunk is drawn. Out-of-range values are clamped by the scroller itself. A view that
      // isn't laid out yet (a hidden tab) waits for its first real size instead.
      treeScroller.dataset.centered = '1';
      const r = treeHost.getBoundingClientRect();
      const slackX = treeScroller.clientWidth - r.width;
      const slackY = treeScroller.clientHeight - r.height;
      treeScroller.scrollLeft = geometry.compact ? 0 : padX[0] - slackX / 2;
      treeScroller.scrollTop = padY[0] - (slackY > 0 ? slackY / 2 : PAN_MARGIN);
    }
    if (merge) renderMergeState();
  }

  treeHost.addEventListener('click', (/** @type {any} */ e) => {
    const openWt = e.target.closest('[data-open-wt]');
    if (openWt) {
      vscode.postMessage({ type: 'openWorktree', path: data.snapshot.worktrees[Number(openWt.dataset.openWt)].path });
      return;
    }
    if (merge) return onMergeClick(e);
    // A branch's name selects it just like its node.
    const card = e.target.closest('.tnode, .tlabel');
    if (card) {
      const id = Number(card.dataset.limb);
      if (sel?.kind === 'limb' && sel.id === id) clearSelection();
      else selectLimb(id, false);
      return;
    }
    const label = e.target.closest('[data-ev]');
    if (label) {
      selectEvent(Number(label.dataset.ev), false);
      return;
    }
    clearSelection();
  });
  treeHost.addEventListener('mouseover', (/** @type {any} */ e) => {
    const card = e.target.closest('.tnode, .tlabel');
    if (merge) {
      if (merge.lockedRef || mergeBusy) return;
      const ref = card && isMergeCandidate(Number(card.dataset.limb)) ? refOf(data.tree.limbs[Number(card.dataset.limb)]) : null;
      if (ref !== merge.hoverRef) {
        merge.hoverRef = ref;
        drawMergePreview();
      }
      return;
    }
    for (const el of treeHost.querySelectorAll('.hot')) el.classList.remove('hot');
    if (card) for (const el of treeHost.querySelectorAll(`[data-limb="${card.dataset.limb}"]`)) el.classList.add('hot');
  });
  // Nodes are small, so their actions live in a context menu.
  treeHost.addEventListener('contextmenu', (/** @type {any} */ e) => {
    const node = e.target.closest('.tnode, .tlabel');
    if (!node || merge) return;
    e.preventDefault();
    openMenu(Number(node.dataset.limb), node, { x: e.clientX, y: e.clientY });
  });
  // Nodes are focusable: Enter/Space acts like a click, the context-menu key opens their actions.
  treeHost.addEventListener('keydown', (/** @type {any} */ e) => {
    const node = e.target.classList?.contains('tnode') ? e.target : null;
    if (!node) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      node.click();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      if (!merge) openMenu(Number(node.dataset.limb), node);
    }
  });
  treeHost.addEventListener('mouseleave', () => {
    if (merge && !merge.lockedRef && merge.hoverRef) {
      merge.hoverRef = null;
      drawMergePreview();
    }
  });

  // ---------- node actions menu ----------

  const menuEl = document.createElement('div');
  menuEl.className = 'menu';
  menuEl.hidden = true;
  document.body.appendChild(menuEl);
  let menuLimb = -1;

  /** Ref used to talk to git about a limb: its branch name, or the commit for a detached HEAD. */
  const refOf = (/** @type {any} */ l) => (l.kind === 'detached' || !l.names.length ? l.tip : l.names[0]);
  const nameOfLimb = (/** @type {any} */ l) => l.names[0] || (l.kind === 'detached' ? 'detached HEAD' : l.short);

  function openMenu(/** @type {number} */ id, /** @type {HTMLElement} */ anchor, /** @type {{x:number,y:number}=} */ at) {
    const l = data.tree.limbs[id];
    const name = esc(nameOfLimb(l));
    const others = data.tree.limbs.filter((/** @type {any} */ o) => o.id !== id);
    const items = [
      { action: 'merge-into', label: `Merge <b>${name}</b> into…`, disabled: !others.some((/** @type {any} */ o) => o.local) },
      { action: 'merge-from', label: `Merge a branch into <b>${name}</b>…`, disabled: !l.local || !others.length,
        hint: l.local ? '' : 'Only local branches can receive a merge' },
      null,
      l.id === 0
        ? { action: 'auto-production', label: 'Detect production branch automatically', disabled: !data.production }
        : { action: 'set-production', label: `Set <b>${name}</b> as production branch`, disabled: l.kind === 'detached' || !l.names.length },
      null,
      { action: 'copy-name', label: 'Copy branch name', disabled: !l.names.length },
      { action: 'copy-hash', label: 'Copy commit hash' },
      ...l.worktrees
        .filter((/** @type {number} */ wi) => !data.snapshot.worktrees[wi].isCurrent)
        .map((/** @type {number} */ wi) => ({ action: `open-wt:${wi}`, label: `Open worktree ${esc(data.snapshot.worktrees[wi].name)}` })),
    ];
    menuEl.innerHTML = items.map(it => it
      ? `<button class="menu-item" data-action="${it.action}" ${it.disabled ? 'disabled' : ''} title="${esc(it.hint || '')}">${it.action.startsWith('merge') ? ICON.merge : ''}<span>${it.label}</span></button>`
      : '<div class="menu-sep"></div>').join('');
    menuLimb = id;
    menuEl.hidden = false;
    const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
    let left = at ? at.x : r.right - menuEl.offsetWidth;
    if (left + menuEl.offsetWidth > window.innerWidth - 8) left = r.right - menuEl.offsetWidth;
    if (left < 8) left = r.left;
    let top = r.bottom + 4;
    if (top + menuEl.offsetHeight > window.innerHeight - 8) top = r.top - menuEl.offsetHeight - 4;
    menuEl.style.left = `${Math.max(8, left)}px`;
    menuEl.style.top = `${Math.max(8, top)}px`;
    menuEl.querySelector('.menu-item:not([disabled])')?.focus();
  }

  function closeMenu() {
    menuEl.hidden = true;
    menuLimb = -1;
  }

  menuEl.addEventListener('click', (/** @type {any} */ e) => {
    const item = e.target.closest('.menu-item');
    if (!item || item.disabled) return;
    const l = data.tree.limbs[menuLimb];
    const action = item.dataset.action;
    closeMenu();
    if (action === 'merge-into') startMerge(l, 'into');
    else if (action === 'merge-from') startMerge(l, 'from');
    else if (action === 'set-production') vscode.postMessage({ type: 'setProduction', name: l.names[0] });
    else if (action === 'auto-production') vscode.postMessage({ type: 'setProduction', name: null });
    else if (action === 'copy-name') vscode.postMessage({ type: 'copy', text: l.names[0] });
    else if (action === 'copy-hash') vscode.postMessage({ type: 'copy', text: l.tip });
    else if (action.startsWith('open-wt:')) {
      vscode.postMessage({ type: 'openWorktree', path: data.snapshot.worktrees[Number(action.slice(8))].path });
    }
  });
  document.addEventListener('mousedown', (/** @type {any} */ e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
  });
  treeScroller.addEventListener('scroll', () => closeMenu());
  window.addEventListener('blur', () => closeMenu());

  // ---------- merge mode: hover a node to preview merging two branches ----------

  /** @type {null | { anchorRef: string, dir: 'into' | 'from', hoverRef: string | null, lockedRef: string | null }} */
  let merge = null;
  let mergeBusy = false;
  /** Merge previews by "source\0target". */
  const mergeCache = new Map();

  const limbByRef = (/** @type {string | null} */ ref) => (ref ? data.tree.limbs.find((/** @type {any} */ l) => refOf(l) === ref) : undefined);

  /** Source and target of the merge between the anchor and another limb. */
  function mergePair(/** @type {any} */ other) {
    const anchor = limbByRef(merge.anchorRef);
    return merge.dir === 'into' ? { src: anchor, tgt: other } : { src: other, tgt: anchor };
  }

  function isMergeCandidate(/** @type {number} */ id) {
    if (!merge) return false;
    const other = data.tree.limbs[id];
    if (!other || refOf(other) === merge.anchorRef) return false;
    return mergePair(other).tgt.local;
  }

  function startMerge(/** @type {any} */ l, /** @type {'into' | 'from'} */ dir) {
    clearSelection();
    merge = { anchorRef: refOf(l), dir, hoverRef: null, lockedRef: null };
    renderMergeState();
  }

  function endMerge() {
    merge = null;
    mergeBusy = false;
    renderMergeState();
  }

  function renderMergeState() {
    const anchor = merge && limbByRef(merge.anchorRef);
    if (merge && !anchor) merge = null; // the branch disappeared after a refresh
    document.body.classList.toggle('merge-mode', !!merge);
    const banner = $('mergeBanner');
    banner.hidden = !merge;
    if (merge) {
      const a = `<b>${esc(nameOfLimb(anchor))}</b>`;
      const text = merge.dir === 'into' ? `Merge ${a} into <span class="mb-slot">…</span>` : `Merge <span class="mb-slot">…</span> into ${a}`;
      banner.innerHTML = `${ICON.merge}<span>${text}</span><span class="muted">Hover a branch to preview, click to choose · Esc to cancel</span>
        <span class="spacer"></span>
        <button class="btn-plain" id="mergeSwap" ${anchor.local || merge.dir === 'from' ? '' : 'disabled'} title="Swap direction">${ICON.swap}Swap</button>
        <button class="btn-plain" id="mergeCancel">Cancel</button>`;
    }
    for (const el of treeHost.querySelectorAll('.tnode')) {
      const id = Number(el.dataset.limb);
      const isAnchor = !!merge && refOf(data.tree.limbs[id]) === merge.anchorRef;
      el.classList.toggle('merge-anchor', isAnchor);
      el.classList.toggle('merge-candidate', !!merge && isMergeCandidate(id));
      el.classList.toggle('merge-invalid', !!merge && !isAnchor && !isMergeCandidate(id));
    }
    drawMergePreview();
  }

  $('mergeBanner').addEventListener('click', (/** @type {any} */ e) => {
    if (e.target.closest('#mergeCancel')) endMerge();
    else if (e.target.closest('#mergeSwap') && merge) {
      merge.dir = merge.dir === 'into' ? 'from' : 'into';
      merge.hoverRef = merge.lockedRef = null;
      renderMergeState();
    }
  });

  function onMergeClick(/** @type {any} */ e) {
    if (!merge || mergeBusy) return;
    if (e.target.closest('.mg-cancel')) { merge.lockedRef = null; drawMergePreview(); return; }
    const go = e.target.closest('.mg-merge');
    if (go) {
      const { src, tgt } = mergePair(limbByRef(merge.lockedRef));
      mergeBusy = true;
      drawMergePreview();
      vscode.postMessage({ type: 'merge', key: pairKey(src, tgt), source: refOf(src), target: refOf(tgt) });
      return;
    }
    if (e.target.closest('.merge-ghost')) return;
    const card = e.target.closest('.tnode');
    const id = card ? Number(card.dataset.limb) : -1;
    merge.lockedRef = id >= 0 && isMergeCandidate(id) ? refOf(data.tree.limbs[id]) : null;
    merge.hoverRef = merge.lockedRef;
    drawMergePreview();
  }

  const pairKey = (/** @type {any} */ src, /** @type {any} */ tgt) => `${refOf(src)}\u0000${refOf(tgt)}`;
  const ancestorsOf = (/** @type {any} */ l) => {
    const out = [];
    for (let cur = l; cur; cur = cur.parent >= 0 ? data.tree.limbs[cur.parent] : null) out.push(cur.id);
    return out;
  };

  /** Limbs to keep lit while previewing: both branches and everything they grew from. */
  function mergeLineage() {
    const other = merge && limbByRef(merge.lockedRef ?? merge.hoverRef);
    if (!other) return null;
    const { src, tgt } = mergePair(other);
    return new Set([...ancestorsOf(src), ...ancestorsOf(tgt)]);
  }

  function drawMergePreview() {
    treeHost.querySelector('.merge-overlay')?.remove();
    treeHost.querySelector('.merge-ghost')?.remove();
    applyDim();
    const otherRef = merge && (merge.lockedRef ?? merge.hoverRef);
    const slot = $('mergeBanner').querySelector('.mb-slot');
    const other = limbByRef(otherRef);
    if (slot) slot.innerHTML = other ? `<b>${esc(nameOfLimb(other))}</b>` : '…';
    for (const el of treeHost.querySelectorAll('.tnode.merge-other')) el.classList.remove('merge-other');
    if (!merge || !other || !geometry) return;
    treeHost.querySelector(`.tnode[data-limb="${other.id}"]`)?.classList.add('merge-other');

    const { src, tgt } = mergePair(other);
    const key = pairKey(src, tgt);
    let pv = mergeCache.get(key);
    if (!pv) {
      pv = { pending: true };
      mergeCache.set(key, pv);
      vscode.postMessage({ type: 'mergePreview', key, source: refOf(src), target: refOf(tgt) });
    }

    // Arrow from the source node to the target node, bowing toward the trunk.
    const a = geometry.rects.get(src.id), b = geometry.rects.get(tgt.id);
    const center = (/** @type {any} */ r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const ca = center(a), cb = center(b);
    const ctrl = { x: ((ca.x + cb.x) / 2) * 0.35 + geometry.cx * 0.65, y: (ca.y + cb.y) / 2 };
    const exit = (/** @type {any} */ r, /** @type {any} */ c, /** @type {any} */ toward) => {
      const dx = toward.x - c.x, dy = toward.y - c.y;
      const s = Math.min(dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity);
      return { x: c.x + dx * s, y: c.y + dy * s };
    };
    const p0 = exit(a, ca, ctrl), p1 = exit(b, cb, ctrl);
    const basePt = pv.base ? geometry.points.get(pv.base) : null;
    const overlay = `<svg class="merge-overlay" width="${geometry.width}" height="${geometry.height}">
      <defs><marker id="mgArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10z" class="mg-arrowhead"/></marker></defs>
      <path class="mg-arc" d="M${p0.x} ${p0.y}Q${ctrl.x} ${ctrl.y} ${p1.x} ${p1.y}" marker-end="url(#mgArrow)"/>
      ${basePt ? `<circle class="mg-base" cx="${basePt.x}" cy="${basePt.y}" r="8"/>
        <text class="mg-base-label" x="${basePt.x - 14}" y="${basePt.y + 4}">merge base</text>` : ''}
    </svg>`;
    treeHost.querySelector('.tree-nodes')?.insertAdjacentHTML('beforebegin', overlay);

    // Ghost of the result next to the target node, in the first spot that keeps both branches visible.
    const w = Math.min(Math.max(b.w, 300), geometry.width - 16);
    treeHost.insertAdjacentHTML('beforeend',
      `<div class="merge-ghost" style="width:${w}px;visibility:hidden;--c:${treeColor(tgt.id)}">
        ${ghostHtml(src, tgt, pv, !!merge.lockedRef)}
      </div>`);
    const ghost = /** @type {HTMLElement} */ (treeHost.querySelector('.merge-ghost'));
    const h = ghost.offsetHeight;
    const clampX = (/** @type {number} */ x) => Math.min(Math.max(8, x), geometry.width - w - 8);
    const outward = b.x + b.w / 2 < geometry.cx ? b.x - w - 16 : b.x + b.w + 16;
    const spots = [
      { left: clampX(b.x + b.w / 2 - w / 2), top: b.y - 12 - h },
      { left: clampX(b.x + b.w / 2 - w / 2), top: b.y + b.h + 12 },
      ...(geometry.compact ? [] : [{ left: clampX(outward), top: b.y }, { left: clampX(ca.x > geometry.cx ? b.x - w - 16 : b.x + b.w + 16), top: b.y }]),
    ];
    const pad = 8;
    const hits = (/** @type {any} */ r, /** @type {any} */ s2) =>
      s2.left < r.x + r.w + pad && s2.left + w > r.x - pad && s2.top < r.y + r.h + pad && s2.top + h > r.y - pad;
    const spot = spots.find(s2 => s2.top >= 4 && !hits(a, s2) && !hits(b, s2)) ?? spots.find(s2 => !hits(a, s2)) ?? spots[0];
    ghost.style.left = `${spot.left}px`;
    ghost.style.top = `${Math.max(4, spot.top)}px`;
    ghost.style.visibility = '';
  }

  function ghostHtml(/** @type {any} */ src, /** @type {any} */ tgt, /** @type {any} */ pv, /** @type {boolean} */ locked) {
    const s = `<b>${esc(nameOfLimb(src))}</b>`, t = `<b>${esc(nameOfLimb(tgt))}</b>`;
    const head = `<div class="mg-title">${ICON.merge}<span>Merge ${s} into ${t}</span></div>`;
    if (pv.pending) return `${head}<div class="mg-row muted">Working out the merge…</div>`;
    if (pv.error) return `${head}<div class="mg-row mg-icon-row">${ICON.warn}<span>${esc(pv.error)}</span></div>`;

    const n = (/** @type {number} */ k, /** @type {string} */ word) => `<b>${k}</b> ${word}${k === 1 ? '' : 's'}`;
    const rows = [];
    if (pv.upToDate) {
      rows.push(`${t} already contains every commit of ${s}. Nothing to merge.`);
    } else {
      rows.push(pv.fastForward
        ? `Fast-forward: ${t} moves up to <span class="mono">${esc(pv.sourceHash.slice(0, 7))}</span>, no merge commit`
        : `New merge commit on ${t} joining ${n(pv.incoming, 'commit')} from ${s}`);
      rows.push(`${n(pv.incoming, 'commit')} in · ${n(pv.files, 'file')} <span class="mono">+${pv.added} −${pv.deleted}</span>`);
      if (!pv.fastForward) {
        rows.push(pv.conflicts === null ? `<span class="mg-icon-row">${ICON.warn}<span>Conflicts could not be checked (needs git 2.38+)</span></span>`
          : pv.conflicts.length
            ? `<span class="mg-icon-row">${ICON.warn}<span>${n(pv.conflicts.length, 'conflicting file')}: <span class="mono">${pv.conflicts.slice(0, 3).map(esc).join(', ')}${pv.conflicts.length > 3 ? '…' : ''}</span></span></span>`
            : `<span class="mg-icon-row">${ICON.check}<span>No conflicts</span></span>`);
      }
    }
    const commits = pv.commits.length && !pv.upToDate
      ? `<ul class="mg-commits">${pv.commits.slice(0, 4).map((/** @type {any} */ c) => `<li><span class="mono">${esc(c.short)}</span> ${esc(c.subject)}</li>`).join('')}` +
        `${pv.incoming > 4 ? `<li class="muted">and ${pv.incoming - 4} more</li>` : ''}</ul>`
      : '';
    const base = pv.base ? `merge base <span class="mono">${esc(pv.base.slice(0, 7))}</span>` : 'no common history';
    const where = pv.worktree ? `runs in worktree ${esc(pv.worktree.name)}` : `${esc(nameOfLimb(tgt))} isn't checked out; updated directly`;

    let blocked = '';
    if (pv.upToDate) blocked = 'Already up to date';
    else if (pv.worktree?.dirty) blocked = `${esc(pv.worktree.name)} has uncommitted changes`;
    else if (!pv.worktree && !pv.fastForward && (pv.conflicts === null || pv.conflicts.length)) blocked = `Check ${esc(nameOfLimb(tgt))} out in a worktree to resolve conflicts`;

    const actions = !locked
      ? `<div class="mg-hint">Click to choose ${t}</div>`
      : mergeBusy
        ? '<div class="mg-hint">Waiting for confirmation…</div>'
        : `<div class="mg-actions"><button class="btn mg-merge" ${blocked ? 'disabled' : ''}>Merge</button><button class="btn-plain mg-cancel">Back</button>` +
          `${blocked ? `<span class="muted">${blocked}</span>` : ''}</div>`;
    return `${head}${rows.map(r => `<div class="mg-row">${r}</div>`).join('')}${commits}<div class="mg-row muted">${base} · ${where}</div>${actions}`;
  }

  // Re-layout when the tree's area changes (window resize, details pane opening/closing).
  let resizeTimer = /** @type {any} */ (0);
  let lastTreeWidth = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!data || !isTree() || treeScroller.clientWidth === lastTreeWidth) {
        applyPanMargins(); // margins follow the view's size even when the tree doesn't re-layout
        return;
      }
      renderTree();
      applySearch(false);
    }, 80);
  }).observe(treeScroller);

  /** A limb plus everything it grew from and everything growing from it. */
  function limbLineage(/** @type {number} */ id) {
    const limbs = data.tree.limbs;
    const set = new Set([id]);
    for (let l = limbs[id]; l.parent >= 0; l = limbs[l.parent]) set.add(l.parent);
    const down = [id];
    while (down.length) {
      const cur = down.pop();
      for (const l of limbs) if (l.parent === cur && !set.has(l.id)) { set.add(l.id); down.push(l.id); }
    }
    return set;
  }

  function scrollIntoViewCentered(/** @type {Element | null} */ el) {
    el?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }

  function selectLimb(/** @type {number} */ id, /** @type {boolean} */ scroll) {
    sel = { kind: 'limb', id };
    applyDim();
    const card = treeHost.querySelector(`.tnode[data-limb="${id}"]`);
    if (scroll) scrollIntoViewCentered(card);
    renderLimbDetails(data.tree.limbs[id]);
    saveState({ selected: selectionKey() });
  }

  function selectEvent(/** @type {number} */ idx, /** @type {boolean} */ scroll) {
    sel = { kind: 'ev', idx };
    applyDim();
    if (scroll) scrollIntoViewCentered(treeHost.querySelector(`.tev[data-ev="${idx}"]`));
    const ev = data.tree.events.find((/** @type {any} */ e) => e.idx === idx);
    renderEventDetails(ev);
    saveState({ selected: selectionKey() });
  }

  // ---------- graph view ----------

  /** Layout metrics for the current render. */
  let LW = 16;
  const gx = (/** @type {number} */ lane) => 14 + lane * LW;
  const gy = (/** @type {number} */ row) => row * ROW_H + ROW_H / 2;

  function edgePath(/** @type {any} */ e) {
    const x1 = gx(e.fromLane), y1 = gy(e.from);
    if (e.to < 0) return `M${x1} ${y1}L${x1} ${y1 + ROW_H * 0.7}`;
    const xv = gx(e.viaLane), x2 = gx(e.toLane), y2 = gy(e.to);
    const k = ROW_H * 0.55;
    if (e.to - e.from === 1) {
      return x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`;
    }
    const yb = gy(e.from + 1), yc = gy(e.to - 1);
    let d = `M${x1} ${y1}`;
    d += x1 !== xv ? `C${x1} ${y1 + k} ${xv} ${yb - k} ${xv} ${yb}` : `L${xv} ${yb}`;
    d += `L${xv} ${yc}`;
    d += xv !== x2 ? `C${xv} ${yc + k} ${x2} ${y2 - k} ${x2} ${y2}` : `L${x2} ${y2}`;
    return d;
  }

  function skipLabel(/** @type {any} */ e) {
    if (!e.hidden || e.to < 0) return '';
    let x, y;
    if (e.to - e.from === 1) {
      x = (gx(e.fromLane) + gx(e.toLane)) / 2;
      y = (gy(e.from) + gy(e.to)) / 2;
    } else {
      x = gx(e.viaLane);
      y = (gy(e.from + 1) + gy(e.to - 1)) / 2;
    }
    const text = e.hidden > 999 ? '999+' : String(e.hidden);
    const w = 8 + text.length * 6;
    return `<g class="skip" data-f="${e.from}" data-t="${e.to}"><title>${e.hidden} commit${e.hidden === 1 ? '' : 's'} collapsed</title>
      <rect x="${x - w / 2}" y="${y - 7}" width="${w}" height="14" rx="7" stroke="${color(e.color)}"/>
      <text x="${x}" y="${y + 3.5}">${text}</text></g>`;
  }

  function nodeSvg(/** @type {any} */ r, /** @type {number} */ i) {
    const x = gx(r.lane), y = gy(i), c = color(r.color);
    let s = '';
    if (r.wip) {
      s = `<circle cx="${x}" cy="${y}" r="5" class="bg-fill" stroke="${c}" stroke-width="1.6" stroke-dasharray="2.2 1.8"/>`;
    } else {
      const wts = r.worktrees.map((/** @type {number} */ wi) => data.snapshot.worktrees[wi]);
      if (wts.length) {
        const cur = wts.some((/** @type {any} */ w) => w.isCurrent);
        s += `<circle cx="${x}" cy="${y}" r="${cur ? 9 : 8.5}" fill="none" stroke="${c}" stroke-width="${cur ? 2.2 : 1.5}" ${cur ? '' : 'stroke-opacity=".75"'}/>`;
      }
      const big = r.refs.length || wts.length;
      s += r.parents.length > 1
        ? `<circle cx="${x}" cy="${y}" r="${big ? 5 : 4.2}" class="bg-fill" stroke="${c}" stroke-width="2.2"/>`
        : `<circle cx="${x}" cy="${y}" r="${big ? 5.2 : 4.2}" fill="${c}" class="bg-stroke" stroke-width="1.5"/>`;
    }
    return `<g class="n" data-i="${i}">${s}</g>`;
  }

  function badges(/** @type {any} */ r) {
    const { snapshot } = data;
    let html = '';
    const c = color(r.color);

    if (r.wip) {
      const w = snapshot.worktrees[r.wip.worktree];
      return `<span class="badge wt" title="${esc(w.path)}">${ICON.folder}${esc(w.name)}</span>`;
    }

    for (const wi of r.worktrees) {
      const w = snapshot.worktrees[wi];
      html += `<span class="badge wt ${w.isCurrent ? 'current' : ''}" style="--c:${c}" title="Worktree: ${esc(w.path)}">${ICON.folder}${esc(w.name)}</span>`;
    }
    if (r.isHead && !snapshot.headBranch) html += `<span class="badge head" style="--c:${c}">HEAD</span>`;

    const remotes = r.refs.filter((/** @type {any} */ x) => x.kind === 'remote');
    const usedRemotes = new Set();
    for (const b of r.refs.filter((/** @type {any} */ x) => x.kind === 'branch')) {
      // Fold "origin/main" into the "main" badge when both point at the same commit.
      const synced = remotes.filter((/** @type {any} */ x) => x.name === b.upstream || x.name.endsWith('/' + b.name) && !b.upstream);
      synced.forEach((/** @type {any} */ x) => usedRemotes.add(x.name));
      const isCur = r.isHead && snapshot.headBranch === b.name;
      let track = '';
      if (b.gone) track = '<span class="track warn" title="Upstream is gone">gone</span>';
      else if (b.ahead || b.behind) {
        track = `<span class="track" title="${b.ahead} ahead, ${b.behind} behind ${esc(b.upstream)}">` +
          (b.ahead ? `↑${b.ahead}` : '') + (b.behind ? `↓${b.behind}` : '') + '</span>';
      }
      const remoteLabel = synced.length
        ? `<span class="remote-part" title="${esc(synced.map((/** @type {any} */ x) => x.name).join(', '))}">${ICON.remote}${esc(synced.map((/** @type {any} */ x) => x.name.split('/')[0]).join(','))}</span>`
        : '';
      html += `<span class="badge branch ${isCur ? 'current' : ''}" style="--c:${c}" title="${isCur ? 'HEAD → ' : ''}${esc(b.name)}">` +
        `${isCur ? '<span class="head-mark">HEAD</span>' : ''}${ICON.branch}${esc(b.name)}${track}${remoteLabel}</span>`;
    }
    for (const x of remotes) {
      if (usedRemotes.has(x.name)) continue;
      html += `<span class="badge remote" style="--c:${c}" title="${esc(x.name)}">${ICON.remote}${esc(x.name)}</span>`;
    }
    for (const t of r.refs.filter((/** @type {any} */ x) => x.kind === 'tag')) {
      html += `<span class="badge tag" title="Tag ${esc(t.name)}">${ICON.tag}${esc(t.name)}</span>`;
    }
    return html;
  }

  function renderGraph() {
    const { rows, edges, laneCount } = data.graph;
    LW = data.options.mode === 'topology' ? 20 : 16;
    const gw = Math.max(56, 28 + Math.max(0, laneCount - 1) * LW + 6);
    const h = rows.length * ROW_H;
    document.documentElement.style.setProperty('--gw', `${gw}px`);

    let paths = '';
    let labels = '';
    for (const e of edges) {
      paths += `<path d="${edgePath(e)}" stroke="${color(e.color)}" class="edge${e.dashed ? ' dashed' : ''}${e.to < 0 ? ' stub' : ''}" data-f="${e.from}" data-t="${e.to}"/>`;
      labels += skipLabel(e);
    }
    const nodes = rows.map(nodeSvg).join('');
    svg.setAttribute('width', String(gw));
    svg.setAttribute('height', String(h));
    svg.innerHTML = `<g class="edges">${paths}</g><g class="labels">${labels}</g><g class="nodes">${nodes}</g>`;

    rowsEl.innerHTML = rows.map((/** @type {any} */ r, /** @type {number} */ i) => {
      const c = color(r.color);
      // The lane's colour marks the row; the text itself stays in the theme's foreground so it
      // reads on light and dark themes alike.
      const lane = `<i class="lane-dot" style="background:${c}"></i>`;
      if (r.wip) {
        return `<div class="row wip" data-i="${i}">
          <span class="hash">${lane}WIP</span>
          <span class="msg">${badges(r)}<span class="subject">Uncommitted changes <span class="muted">(${r.wip.changes} file${r.wip.changes === 1 ? '' : 's'})</span></span></span>
          <span class="author"></span><span class="date"></span></div>`;
      }
      return `<div class="row" data-i="${i}">
        <span class="hash">${lane}${esc(r.short)}</span>
        <span class="msg">${badges(r)}<span class="subject">${esc(r.subject)}</span></span>
        <span class="author" title="${esc(r.email)}">${esc(r.author)}</span>
        <span class="date" title="${esc(absTime(r.time))}">${relTime(r.time)}</span></div>`;
    }).join('');
    $('canvas').style.height = `${h}px`;
    if (!rows.length) showMessage('This repository has no commits yet.');
  }

  rowsEl.addEventListener('click', (/** @type {any} */ e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (sel?.kind === 'row' && sel.i === i) clearSelection();
    else selectRow(i, false);
  });

  function rowLineage(/** @type {number} */ i) {
    const set = new Set([i]);
    const up = [i];
    while (up.length) {
      const r = data.graph.rows[/** @type {number} */ (up.pop())];
      for (const p of r.parents) {
        const pi = rowIndex.get(p);
        if (pi !== undefined && !set.has(pi)) { set.add(pi); up.push(pi); }
      }
    }
    const down = [i];
    const seenDown = new Set([i]);
    while (down.length) {
      for (const ci of children[/** @type {number} */ (down.pop())]) {
        if (!seenDown.has(ci)) { seenDown.add(ci); set.add(ci); down.push(ci); }
      }
    }
    return set;
  }

  function selectRow(/** @type {number} */ i, /** @type {boolean} */ scroll) {
    sel = { kind: 'row', i, related: rowLineage(i) };
    applyDim();
    for (const el of rowsEl.querySelectorAll('.row.selected')) el.classList.remove('selected');
    rowsEl.children[i]?.classList.add('selected');
    if (scroll) scrollToRow(i);
    renderRowDetails(data.graph.rows[i]);
    saveState({ selected: selectionKey() });
  }

  function scrollToRow(/** @type {number} */ i) {
    const top = i * ROW_H;
    const view = scroller.clientHeight - ROW_H; // minus sticky header
    if (top < scroller.scrollTop || top > scroller.scrollTop + view - ROW_H) {
      scroller.scrollTop = Math.max(0, top - view / 2);
    }
  }

  // ---------- selection, dimming ----------

  function clearSelection() {
    sel = null;
    detailsHash = '';
    applyDim();
    for (const el of document.querySelectorAll('.row.selected, .tnode.selected, .tev.selected')) el.classList.remove('selected');
    detailsEl.hidden = true;
    saveState({ selected: undefined });
  }

  function applyDim() {
    if (!data) return;
    if (isTree()) {
      const lineage = merge ? mergeLineage() : sel?.kind === 'limb' ? limbLineage(sel.id) : null;
      const qset = query.trim() ? new Set(matches.filter(m => m.kind === 'limb').map(m => m.id)) : null;
      const on = (/** @type {number} */ id) => (!lineage || lineage.has(id)) && (!qset || qset.has(id));
      for (const el of treeHost.querySelectorAll('[data-limb]')) {
        el.classList.toggle('dim', !on(Number(el.dataset.limb)));
      }
      for (const el of treeHost.querySelectorAll('.tnode')) {
        el.classList.toggle('selected', sel?.kind === 'limb' && sel.id === Number(el.dataset.limb));
      }
      for (const el of treeHost.querySelectorAll('.tev')) {
        el.classList.toggle('selected', sel?.kind === 'ev' && sel.idx === Number(el.dataset.ev));
      }
      return;
    }
    const rel = sel?.kind === 'row' ? sel.related : null;
    const qset = query.trim() ? new Set(matches) : null;
    const on = (/** @type {number} */ i) => (!rel || rel.has(i)) && (!qset || qset.has(i));
    for (const el of rowsEl.children) el.classList.toggle('dim', !on(Number(el.dataset.i)));
    for (const el of svg.querySelectorAll('.n')) el.classList.toggle('dim', !on(Number(el.dataset.i)));
    for (const el of svg.querySelectorAll('.edge, .skip')) {
      const f = Number(el.dataset.f), t = Number(el.dataset.t);
      const lit = rel ? rel.has(f) && (t < 0 || rel.has(t)) : !qset;
      el.classList.toggle('dim', !lit);
    }
  }

  // ---------- details pane ----------

  const closeBtn = () => `<button class="icon-btn close" data-close title="Close (Esc)">${ICON.close}</button>`;
  const kv = (/** @type {string} */ k, /** @type {string} */ v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  const hashLine = (/** @type {string} */ hash, /** @type {string} */ c) =>
    `<div class="kv"><span>Commit</span><span class="hashline"><span class="mono" style="color:${c}">${esc(hash)}</span>
      <button class="icon-btn" data-copy="${esc(hash)}" title="Copy hash">${ICON.copy}</button></span></div>`;

  function openDetails(/** @type {string} */ html, /** @type {string} */ hash) {
    detailsHash = hash;
    detailsEl.hidden = false;
    detailsEl.innerHTML = `${closeBtn()}${html}<div id="extra" class="extra muted">Loading…</div>`;
  }

  function worktreeRows(/** @type {number[]} */ wis) {
    return wis.map(wi => {
      const w = data.snapshot.worktrees[wi];
      return kv('Worktree', `${ICON.folder} ${esc(w.name)} ${w.dirty ? `<span class="warn"><i class="dot-mark"></i>${w.dirty} uncommitted</span>` : '<span class="ok-text">clean</span>'}
        ${w.isCurrent ? '<span class="muted">(this window)</span>' : `<button class="icon-btn" data-open-wt="${wi}" title="Open in new window">${ICON.open}</button>`}`);
    }).join('');
  }

  function renderLimbDetails(/** @type {any} */ l) {
    const tree = data.tree;
    const c = treeColor(l.id);
    const base = l.parent >= 0 ? (tree.limbs[l.parent].names[0] || tree.trunkName) : '';
    let state = '';
    if (l.kind === 'trunk') {
      state = kv('Production', `${data.production ? 'set in settings' : 'detected'} · ${tree.trunkLength} commits on its first-parent line`);
    } else if (l.forkKnown) {
      state = kv('Forked', `from <b>${esc(base)}</b> at <a href="#" class="jump-ev mono" data-hash="${esc(l.forkHash)}">${esc(l.forkShort)}</a>`) +
        kv('State', `<span class="ahead-text">${l.ahead} ahead</span> · <span class="behind-text">${l.behind} behind</span> ${esc(base)}`);
    } else {
      state = kv('Forked', '<span class="muted">before the loaded history</span>');
    }
    if (l.mergedAt !== undefined) {
      const ev = tree.events.find((/** @type {any} */ e) => e.idx === l.mergedAt);
      state += kv('Merged', `into ${esc(tree.trunkName)} at <a href="#" class="jump-ev mono" data-hash="${esc(ev?.hash)}">${esc(ev?.short)}</a>`);
    }
    if (l.upstream) {
      const u = l.upstream;
      state += kv('Upstream', `${ICON.remote} ${esc(u.name)} ${u.gone ? '<span class="warn">gone</span>'
        : u.ahead || u.behind ? `<span class="mono">↑${u.ahead} ↓${u.behind}</span>` : '<span class="ok-text">in sync</span>'}`);
    }
    const names = l.names.length > 1 ? kv('Also', l.names.slice(1).map((/** @type {string} */ n) => esc(n)).join(', ')) : '';
    openDetails(`
      <h3>${l.kind === 'remote' ? ICON.remote : ICON.branch} ${esc(l.names[0] || 'HEAD')} ${l.isHead ? '<span class="head-chip">HEAD</span>' : ''}</h3>
      ${names}${state}${worktreeRows(l.worktrees)}
      <div class="section-title">Latest commit</div>
      <div class="commit-subject">${esc(l.subject)}</div>
      ${hashLine(l.tip, c)}
      ${kv('Author', `${esc(l.author)} <span class="muted">· ${relTime(l.time)}</span>`)}`, l.tip);
    vscode.postMessage({ type: 'commitDetails', hash: l.tip });
  }

  function renderEventDetails(/** @type {any} */ ev) {
    openDetails(`
      <h3>${esc(ev.subject)}</h3>
      ${kv('On', `${esc(data.tree.trunkName)}${ev.idx ? `~${ev.idx}` : ''}`)}
      ${hashLine(ev.hash, 'var(--fg)')}
      ${kv('Author', `${esc(ev.author)} <span class="muted">· ${esc(absTime(ev.time))}</span>`)}
      ${ev.tags.length ? kv('Tags', ev.tags.map((/** @type {string} */ t) => esc(t)).join(', ')) : ''}
      ${worktreeRows(ev.worktrees)}`, ev.hash);
    vscode.postMessage({ type: 'commitDetails', hash: ev.hash });
  }

  function renderRowDetails(/** @type {any} */ r) {
    const c = color(r.color);
    if (r.wip) {
      const w = data.snapshot.worktrees[r.wip.worktree];
      openDetails(`<h3>Uncommitted changes</h3>
        ${kv('Worktree', `${ICON.folder} ${esc(w.name)}`)}
        ${kv('Path', `<span class="mono wrap">${esc(w.path)}</span>`)}
        ${kv('Branch', esc(w.branch || 'detached'))}`, r.hash);
      vscode.postMessage({ type: 'wipDetails', hash: r.hash, path: w.path });
      return;
    }
    const parents = r.parents.map((/** @type {string} */ p) => {
      const pi = rowIndex.get(p);
      const label = pi !== undefined ? data.graph.rows[pi].short : p.slice(0, 7);
      return `<a href="#" class="jump mono" data-hash="${esc(p)}">${esc(label)}</a>`;
    }).join(' ');
    openDetails(`
      <h3>${esc(r.subject)}</h3>
      <div class="badges">${badges(r)}</div>
      ${hashLine(r.hash, c)}
      ${kv('Parents', parents || '<em>root commit</em>')}
      ${kv('Author', `${esc(r.author)} <span class="muted">&lt;${esc(r.email)}&gt;</span>`)}
      ${kv('Date', `${esc(absTime(r.time))} <span class="muted">(${relTime(r.time)})</span>`)}`, r.hash);
    vscode.postMessage({ type: 'commitDetails', hash: r.hash });
  }

  function fileList(/** @type {any[]} */ files) {
    if (!files.length) return '<div class="muted">No file changes.</div>';
    return `<div class="files-title">${files.length} file${files.length === 1 ? '' : 's'} changed</div><ul class="files">` +
      files.map(f => {
        const stat = f.added !== undefined || f.deleted !== undefined
          ? `<span class="add">+${f.added ?? 0}</span><span class="del">−${f.deleted ?? 0}</span>`
          : `<span class="st">${esc(f.status)}</span>`;
        return `<li title="${esc(f.path)}"><span class="path">${esc(f.path)}</span>${stat}</li>`;
      }).join('') + '</ul>';
  }

  function renderCommitExtra(/** @type {any} */ m) {
    const el = $('extra');
    if (!el) return;
    el.classList.remove('muted');
    if (m.error) { el.innerHTML = `<div class="warn">${esc(m.error)}</div>`; return; }
    const body = m.details.body.split('\n').slice(1).join('\n').trim();
    el.innerHTML = (body ? `<pre class="msg-body">${esc(body)}</pre>` : '') + fileList(m.details.files);
  }

  function renderWipExtra(/** @type {any} */ m) {
    const el = $('extra');
    if (!el) return;
    el.classList.remove('muted');
    el.innerHTML = m.error ? `<div class="warn">${esc(m.error)}</div>` : fileList(m.files);
  }

  detailsEl.addEventListener('click', (/** @type {any} */ e) => {
    if (e.target.closest('[data-close]')) { clearSelection(); return; }
    const copy = e.target.closest('[data-copy]');
    if (copy) { vscode.postMessage({ type: 'copy', text: copy.dataset.copy }); return; }
    const openWt = e.target.closest('[data-open-wt]');
    if (openWt) { vscode.postMessage({ type: 'openWorktree', path: data.snapshot.worktrees[Number(openWt.dataset.openWt)].path }); return; }
    const jump = e.target.closest('.jump');
    if (jump) {
      e.preventDefault();
      const i = rowIndex.get(jump.dataset.hash);
      if (i !== undefined) selectRow(i, true);
      return;
    }
    const jumpEv = e.target.closest('.jump-ev');
    if (jumpEv) {
      e.preventDefault();
      const ev = data.tree.events.find((/** @type {any} */ x) => x.hash === jumpEv.dataset.hash);
      if (ev) selectEvent(ev.idx, true);
      else {
        const limb = data.tree.limbs.find((/** @type {any} */ l) => l.tip === jumpEv.dataset.hash);
        if (limb) selectLimb(limb.id, true);
      }
    }
  });

  // ---------- search ----------

  function limbMatches(/** @type {any} */ l, /** @type {string} */ q) {
    return l.names.some((/** @type {string} */ n) => n.toLowerCase().includes(q)) ||
      l.tip.startsWith(q) ||
      l.subject.toLowerCase().includes(q) ||
      l.author.toLowerCase().includes(q) ||
      l.worktrees.some((/** @type {number} */ wi) => data.snapshot.worktrees[wi].name.toLowerCase().includes(q));
  }

  function rowMatches(/** @type {any} */ r, /** @type {string} */ q) {
    if (r.wip) return 'uncommitted changes wip'.includes(q) || data.snapshot.worktrees[r.wip.worktree].name.toLowerCase().includes(q);
    return r.hash.startsWith(q) ||
      r.subject.toLowerCase().includes(q) ||
      r.author.toLowerCase().includes(q) ||
      r.refs.some((/** @type {any} */ x) => x.name.toLowerCase().includes(q)) ||
      r.worktrees.some((/** @type {number} */ wi) => data.snapshot.worktrees[wi].name.toLowerCase().includes(q));
  }

  function applySearch(/** @type {boolean} */ jump) {
    if (!data) return;
    const q = query.trim().toLowerCase();
    if (isTree()) {
      matches = q && data.tree
        ? data.tree.limbs.filter((/** @type {any} */ l) => limbMatches(l, q)).map((/** @type {any} */ l) => ({ kind: 'limb', id: l.id }))
        : [];
    } else {
      matches = q ? data.graph.rows.map((/** @type {any} */ r, /** @type {number} */ i) => rowMatches(r, q) ? i : -1).filter((/** @type {number} */ i) => i >= 0) : [];
      for (const el of rowsEl.querySelectorAll('.row.match')) el.classList.remove('match');
      for (const i of matches) rowsEl.children[i]?.classList.add('match');
    }
    $('searchCount').textContent = q ? `${matches.length ? Math.max(0, matchIdx) + 1 : 0}/${matches.length}` : '';
    if (jump) { matchIdx = -1; nextMatch(1); }
    applyDim();
  }

  function nextMatch(/** @type {number} */ dir) {
    if (!matches.length) { $('searchCount').textContent = query.trim() ? '0/0' : ''; return; }
    matchIdx = (matchIdx + dir + matches.length) % matches.length;
    $('searchCount').textContent = `${matchIdx + 1}/${matches.length}`;
    const m = matches[matchIdx];
    if (isTree()) {
      scrollIntoViewCentered(treeHost.querySelector(`.tnode[data-limb="${m.id}"]`));
      for (const el of treeHost.querySelectorAll('.current-match')) el.classList.remove('current-match');
      treeHost.querySelector(`.tnode[data-limb="${m.id}"]`)?.classList.add('current-match');
      return;
    }
    scrollToRow(m);
    for (const el of rowsEl.querySelectorAll('.row.current-match')) el.classList.remove('current-match');
    rowsEl.children[m]?.classList.add('current-match');
  }

  let searchTimer = /** @type {any} */ (0);
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchEl.value;
      saveState({ query });
      applySearch(true);
    }, 120);
  });
  searchEl.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Enter') { e.preventDefault(); nextMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') {
      searchEl.value = '';
      query = '';
      saveState({ query });
      applySearch(false);
      (isTree() ? treeScroller : scroller).focus();
    }
  });
  $('searchPrev').addEventListener('click', () => nextMatch(-1));
  $('searchNext').addEventListener('click', () => nextMatch(1));

  // ---------- keyboard ----------

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (document.activeElement === searchEl || !data) return;
    if (e.key === 'Escape') {
      if (!menuEl.hidden) closeMenu();
      else if (merge?.lockedRef && !mergeBusy) { merge.lockedRef = null; drawMergePreview(); }
      else if (merge) endMerge();
      else clearSelection();
      return;
    }
    if (isTree()) {
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); stepZoom(1); }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); stepZoom(-1); }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(1); }
      return;
    }
    const n = data.graph.rows.length;
    const cur = sel?.kind === 'row' ? sel.i : -1;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); if (n) selectRow(Math.min(n - 1, cur + 1), true); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); if (n) selectRow(Math.max(0, cur < 0 ? 0 : cur - 1), true); }
  });

  vscode.postMessage({ type: 'ready' });
})();
