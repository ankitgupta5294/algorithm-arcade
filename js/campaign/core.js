/* Puzzle worlds: seeded generators, custom views and shared drawing helpers. The Problem Set (js/problems) exposes them as problems. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;
  const C = (D.campaign = { worlds: [] });
  const LEVELS = (C.LEVELS = 40);

  C.CATS = [
    { id: "arrays", name: "Sorting & arrays" },
    { id: "search", name: "Searching & scanning" },
    { id: "recursion", name: "Recursion & backtracking" },
    { id: "graphs", name: "Graphs" },
    { id: "greedy", name: "Greedy & dynamic programming" },
    { id: "state", name: "Games & state spaces" },
  ];
  C.TIERS = ["Easy", "Medium", "Hard", "Expert"];
  C.tierOf = (L) => Math.floor((L - 1) / 10);

  /* ---------- seeded randomness: the same level is always the same puzzle ---------- */
  function hashStr(s) {
    let h = 1779033703 ^ s.length;
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }
  C.rng = function (seed) {
    let a = hashStr(String(seed));
    const next = () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const R = {
      next,
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      chance: (p) => next() < p,
      shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
      sample: (arr, k) => R.shuffle(arr.slice()).slice(0, k),
      perm: (n) => R.shuffle(U.range(n).map((i) => i + 1)),
      distinct(n, lo, hi) { const s = new Set(); while (s.size < n) s.add(R.int(lo, hi)); return [...s]; },
      arr: (n, lo, hi) => U.range(n).map(() => R.int(lo, hi)),
      str: (n, alpha) => U.range(n).map(() => alpha[Math.floor(next() * alpha.length)]).join(""),
      sorted: (n, lo, hi, distinct) => (distinct ? R.distinct(n, lo, hi) : R.arr(n, lo, hi)).sort((x, y) => x - y),
    };
    return R;
  };

  C.register = (w) => C.worlds.push(w);
  C.world = (id) => C.worlds.find((w) => w.id === id);

  /* Generate level L of a world. Retries with fresh seeds if a generator rejects a candidate. */
  const cache = new Map();
  const sig = (P) => JSON.stringify(P, (k, v) => (k === "goal" || k === "solution" || k === "L" ? undefined : v));
  C.level = function (w, L) {
    const key = w.id + ":" + L;
    if (cache.has(key)) return cache.get(key);
    // Levels are generated in order so that no level repeats an earlier one in the same world.
    const earlier = new Set();
    for (let k = 1; k < L; k++) earlier.add(sig(C.level(w, k)));
    let P = null;
    for (let attempt = 0; attempt < 80 && !P; attempt++) {
      const cand = w.gen(L, C.rng(`${w.id}/${L}/${attempt}`), C.tierOf(L));
      if (cand && !earlier.has(sig(cand))) P = cand;
    }
    if (!P) throw new Error("Could not generate " + key);
    P.L = L;
    cache.set(key, P);
    return P;
  };

  C.stars = (used, par, slack) => (used <= par ? 3 : used <= par + slack ? 2 : 1);

  /* ---------- progress ---------- */
  const store = D.store;
  C.prog = store.get("camp", {});
  C.save = () => store.set("camp", C.prog);
  C.starsFor = (wid, L) => ((C.prog[wid] || [])[L - 1] || 0);
  C.solvedIn = (wid) => (C.prog[wid] || []).filter((s) => s > 0).length;
  C.starsIn = (wid) => (C.prog[wid] || []).reduce((a, b) => a + (b || 0), 0);
  C.totalSolved = () => C.worlds.reduce((s, w) => s + C.solvedIn(w.id), 0);
  C.totalStars = () => C.worlds.reduce((s, w) => s + C.starsIn(w.id), 0);
  C.highest = (wid) => { const a = C.prog[wid] || []; let h = 0; a.forEach((s, i) => s > 0 && (h = i + 1)); return h; };
  C.unlocked = (wid, L) => L <= C.highest(wid) + 3;
  C.record = function (wid, L, stars) {
    const a = (C.prog[wid] = C.prog[wid] || []);
    const before = a[L - 1] || 0;
    if (stars > before) {
      a[L - 1] = stars;
      const xp = (stars - before) * 5 * (C.tierOf(L) + 1);
      D.progress.data.xp += xp;
      D.progress.save();
      C.save();
      return { improved: true, xp, before };
    }
    return { improved: false, xp: 0, before };
  };

  /* ---------- shared drawing: planar-ish road maps on a jittered grid ---------- */
  C.mapGraph = function (R, n, { extra = 0.35, diag = 0.5, wmin = 1, wmax = 9, W = 420, H = 300 } = {}) {
    const cols = Math.ceil(Math.sqrt(n * 1.4)), rows = Math.ceil(n / cols) + (n > 6 ? 1 : 0);
    let cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
    // drop random cells but keep the occupied grid connected through horizontal/vertical neighbours
    const connected = (cs) => {
      const seen = new Set([0]), st = [0];
      while (st.length) { const k = st.pop(); cs.forEach((c, j) => { if (!seen.has(j) && Math.abs(c[0] - cs[k][0]) + Math.abs(c[1] - cs[k][1]) === 1) { seen.add(j); st.push(j); } }); }
      return seen.size === cs.length;
    };
    for (let tries = 0; tries < 400 && cells.length > n; tries++) {
      const i = Math.floor(R.next() * cells.length);
      const rest = cells.filter((_, k) => k !== i);
      if (connected(rest)) cells = rest;
    }
    if (cells.length > n) return null;
    const padX = 34, padY = 30, sx = (W - 2 * padX) / Math.max(1, cols - 1), sy = (H - 2 * padY) / Math.max(1, rows - 1);
    const nodes = cells.map(([r, c]) => ({ r, c, x: padX + c * sx + (R.next() - 0.5) * sx * 0.35, y: padY + r * sy + (R.next() - 0.5) * sy * 0.35 }));
    const at = new Map(nodes.map((p, i) => [p.r + "," + p.c, i]));
    const cand = [];
    nodes.forEach((p, i) => {
      [[0, 1], [1, 0]].forEach(([dr, dc]) => { const j = at.get(p.r + dr + "," + (p.c + dc)); if (j != null) cand.push([i, j]); });
      // at most one diagonal per grid square keeps the drawing planar
      if (R.chance(diag)) {
        const useMain = R.chance(0.5);
        const a = useMain ? i : at.get(p.r + "," + (p.c + 1)), b = useMain ? at.get(p.r + 1 + "," + (p.c + 1)) : at.get(p.r + 1 + "," + p.c);
        if (a != null && b != null) cand.push([a, b]);
      }
    });
    const parent = U.range(n), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const edges = [];
    R.shuffle(cand.slice()).forEach(([a, b]) => { const ra = find(a), rb = find(b); if (ra !== rb) { parent[ra] = rb; edges.push({ u: a, v: b }); } });
    cand.forEach(([a, b]) => { if (!edges.some((e) => (e.u === a && e.v === b) || (e.u === b && e.v === a)) && R.chance(extra)) edges.push({ u: a, v: b }); });
    edges.forEach((e) => (e.w = R.int(wmin, wmax)));
    return { n, nodes, edges, W, H };
  };

  C.adj = function (G, directed) {
    const a = U.range(G.n).map(() => []);
    G.edges.forEach((e, k) => { a[e.u].push({ v: e.v, w: e.w, k }); if (!directed) a[e.v].push({ v: e.u, w: e.w, k }); });
    return a;
  };

  /* SVG for a map graph. Nodes carry data-node, edges data-edge (with a wide invisible hit line). */
  C.svgGraph = function (G, o = {}) {
    const r = o.r || 17, id = "a" + Math.random().toString(36).slice(2, 8);
    let edges = "", labels = "", nodes = "";
    G.edges.forEach((e, k) => {
      const a = G.nodes[e.u], b = G.nodes[e.v];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
      const back = o.directed ? r + 5 : r;
      const x1 = a.x + ux * r, y1 = a.y + uy * r, x2 = b.x - ux * back, y2 = b.y - uy * back;
      const cls = o.edgeClass ? o.edgeClass(e, k) : "";
      edges += `<g class="edge-g ${cls}"${o.pickEdges ? ` data-edge="${k}" tabindex="0" role="button" aria-label="Edge ${o.label ? o.label(e.u) : e.u} to ${o.label ? o.label(e.v) : e.v}${o.weights ? ", weight " + e.w : ""}"` : ""}>` +
        (o.pickEdges ? `<line class="hit" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>` : "") +
        `<line class="edge" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"${o.directed ? ` marker-end="url(#${id})"` : ""}/></g>`;
      if (o.weights) {
        const t = o.directed ? 0.45 : 0.5, mx = a.x + dx * t, my = a.y + dy * t;
        labels += `<g class="wlabel ${cls}"><rect x="${(mx - 11).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="22" height="18" rx="4"/><text x="${mx.toFixed(1)}" y="${my.toFixed(1)}">${e.w}</text></g>`;
      }
    });
    G.nodes.forEach((p, i) => {
      const cls = o.nodeClass ? o.nodeClass(i) : "";
      const lab = o.label ? o.label(i) : U.letters[i];
      nodes += `<g class="node ${cls}"${o.pickNodes ? ` data-node="${i}" tabindex="0" role="button" aria-label="Node ${lab}"` : ""}><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}"/><text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}">${lab}</text>${o.badge && o.badge(i) != null ? `<text class="ord" x="${(p.x + r - 2).toFixed(1)}" y="${(p.y - r + 1).toFixed(1)}">${o.badge(i)}</text>` : ""}</g>`;
    });
    const defs = o.directed ? `<defs><marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path class="arrowhead" d="M0,0 L10,5 L0,10 z"/></marker></defs>` : "";
    const pad = r + 4, xs = G.nodes.map((p) => p.x), ys = G.nodes.map((p) => p.y);
    const x0 = Math.min(0, Math.min(...xs) - pad), y0 = Math.min(0, Math.min(...ys) - pad);
    const vw = Math.max(G.W, Math.max(...xs) + pad) - x0, vh = Math.max(G.H, Math.max(...ys) + pad) - y0;
    return `<svg class="diagram graph camp-graph" viewBox="${x0} ${y0} ${vw} ${vh}" width="${vw}" role="img" aria-label="${o.aria || "Graph"}">${defs}${o.under || ""}${edges}${labels}${nodes}</svg>`;
  };

  /* Click + keyboard delegation for [data-*] targets inside an element. */
  C.onPick = function (el, attr, fn) {
    el.addEventListener("click", (e) => { const t = e.target.closest(`[${attr}]`); if (t && el.contains(t)) fn(t.getAttribute(attr), t); });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target.closest(`[${attr}]`);
      if (t && el.contains(t) && t.tagName !== "BUTTON") { e.preventDefault(); fn(t.getAttribute(attr), t); }
    });
  };

  const starStr = (n) => "★".repeat(n) + "☆".repeat(3 - n);
  C.starStr = starStr;

})();
