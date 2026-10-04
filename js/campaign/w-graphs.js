/* Campaign worlds: Graphs. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign;
  const L_ = U.letters;

  /* ===================== Maze Runner ===================== */
  function makeMaze(R, rows, cols, braid) {
    // right[r][c]: wall between (r,c) and (r,c+1); down[r][c]: wall between (r,c) and (r+1,c)
    const right = U.range(rows).map(() => Array(cols).fill(true)), down = U.range(rows).map(() => Array(cols).fill(true));
    const seen = U.range(rows).map(() => Array(cols).fill(false));
    const st = [[0, 0]]; seen[0][0] = true;
    while (st.length) {
      const [r, c] = st[st.length - 1];
      const nb = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].filter(([y, x]) => y >= 0 && y < rows && x >= 0 && x < cols && !seen[y][x]);
      if (!nb.length) { st.pop(); continue; }
      const [y, x] = R.pick(nb);
      if (y === r) right[r][Math.min(c, x)] = false; else down[Math.min(r, y)][c] = false;
      seen[y][x] = true; st.push([y, x]);
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (c < cols - 1 && right[r][c] && R.chance(braid)) right[r][c] = false;
      if (r < rows - 1 && down[r][c] && R.chance(braid)) down[r][c] = false;
    }
    return { rows, cols, right, down };
  }
  const open = (M, [r, c], [y, x]) => {
    if (y < 0 || y >= M.rows || x < 0 || x >= M.cols || Math.abs(r - y) + Math.abs(c - x) !== 1) return false;
    return y === r ? !M.right[r][Math.min(c, x)] : !M.down[Math.min(r, y)][c];
  };
  function mazeBFS(M, S, E, key, door) {
    const k = (p, h) => p[0] + "," + p[1] + "," + h;
    const prev = new Map([[k(S, 0), null]]);
    let q = [[S, 0]];
    while (q.length) {
      const nq = [];
      for (const [p, h] of q) {
        if (p[0] === E[0] && p[1] === E[1]) {
          const path = []; let cur = k(p, h);
          while (prev.get(cur)) { const [pk, cell] = prev.get(cur); path.unshift(cell); cur = pk; }
          return path;
        }
        for (const nb of [[p[0] - 1, p[1]], [p[0] + 1, p[1]], [p[0], p[1] - 1], [p[0], p[1] + 1]]) {
          if (!open(M, p, nb)) continue;
          if (door && nb[0] === door[0] && nb[1] === door[1] && !h) continue;
          const nh = h || (key && nb[0] === key[0] && nb[1] === key[1]) ? 1 : 0;
          const kk = k(nb, nh);
          if (!prev.has(kk)) { prev.set(kk, [k(p, h), nb]); nq.push([nb, nh]); }
        }
      }
      q = nq;
    }
    return null;
  }
  C.register({
    id: "maze", cat: "graphs", name: "Maze Runner", concept: "BFS",
    blurb: "Trace the shortest route through a maze with loops. Later mazes add a key and a locked door.",
    tiers: ["5–7 grids", "8–10 grids", "11–13 grids, more loops", "Key and door"],
    lesson: `<p>A maze is a graph: cells are vertices and open passages are edges. <b>Breadth-first search</b> explores in rings of distance 1, 2, 3, … from the start, so the first time it reaches the exit it has found a shortest route.</p>
      <p>Depth-first wandering (or the right-hand rule) also finds <i>an</i> exit, but in a maze with loops it can be much longer than necessary.</p>
      <p><b>Keys and doors</b> change what a "position" is. The state becomes (cell, have key?), which doubles the graph, and BFS on that bigger graph still finds the true shortest walk, detour and all.</p>`,
    hint: "Work backwards from the exit too: dead ends never belong on a shortest path. Where routes split, count the steps on each side.",
    gen(L, R, t) {
      const size = t === 0 ? 5 + Math.floor((L - 1) / 4) : t === 1 ? 8 + Math.floor((L - 11) / 4) : t === 2 ? 11 + Math.floor((L - 21) / 4) : 9 + Math.floor((L - 31) / 3);
      const braid = [0.08, 0.1, 0.12, 0.1][t];
      const M = makeMaze(R, size, size, braid);
      const S = [0, 0], E = [size - 1, size - 1];
      const base = mazeBFS(M, S, E);
      if (t < 3) {
        // there should be a tempting alternative: some other route that is longer
        return { M, S, E, par: base.length, solution: base, goal: `Draw a path from <b>S</b> to <b>E</b> by tapping neighbouring cells. Tap a cell already on your path to back up to it. Reach the exit in the fewest steps (par <b>${base.length}</b>).` };
      }
      const door = base[Math.floor(base.length * R.int(40, 60) / 100)];
      if (!door) return null;
      const cells = []; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) cells.push([r, c]);
      const key = R.pick(cells.filter(([r, c]) => !(r === 0 && c === 0) && !(r === E[0] && c === E[1]) && !(r === door[0] && c === door[1]) && !base.some(([y, x]) => y === r && x === c)));
      const sol = mazeBFS(M, S, E, key, door);
      if (!sol || sol.length < base.length + 4) return null;
      return { M, S, E, key, door, par: sol.length, solution: sol, goal: `Reach <b>E</b> in the fewest steps. The locked door <b>▦</b> opens only once your path has picked up the key <b>⚿</b>. Par is <b>${sol.length}</b>.` };
    },
    view(el, P, api) {
      const M = P.M, path = [P.S.slice()];
      let misses = 0;
      const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
      const idx = (p) => { for (let i = path.length - 1; i >= 0; i--) if (same(path[i], p)) return i; return -1; };
      el.innerHTML = `<div class="maze" style="--cols:${M.cols}"></div><div class="actions"><button type="button" class="btn ghost undo">Undo step</button></div>`;
      const box = el.querySelector(".maze");
      el.querySelector(".undo").addEventListener("click", () => { if (path.length > 1 && !api.over) { path.pop(); api.say(""); render(); } });
      function render() {
        const head = path[path.length - 1];
        let s = "";
        for (let r = 0; r < M.rows; r++) for (let c = 0; c < M.cols; c++) {
          const w = [r === 0 || M.down[r - 1][c], c === M.cols - 1 || M.right[r][c], r === M.rows - 1 || M.down[r][c], c === 0 || M.right[r][c - 1]];
          const on = idx([r, c]) >= 0, isHead = same(head, [r, c]);
          const lab = same([r, c], P.S) ? "S" : same([r, c], P.E) ? "E" : same([r, c], P.key) ? "⚿" : same([r, c], P.door) ? "▦" : "";
          s += `<button type="button" class="mcell${w[0] ? " wt" : ""}${w[1] ? " wr" : ""}${w[2] ? " wb" : ""}${w[3] ? " wl" : ""}${on ? " on" : ""}${isHead ? " head" : ""}${same([r, c], P.door) ? " door" : ""}" data-rc="${r},${c}" aria-label="Row ${r + 1}, column ${c + 1}${lab ? ", " + lab : ""}">${lab}</button>`;
        }
        box.innerHTML = s;
        api.stats([["Steps", path.length - 1], ["Par", P.par]]);
      }
      // Without a key, revisiting a cell never helps, so stepping back onto your path backs up to it.
      // With a key, the path is a walk: you may need to retrace a corridor after collecting the key.
      function move(p) {
        if (api.over) return;
        const head = path[path.length - 1];
        const adjacent = open(M, head, p);
        if (!adjacent || (!P.key && idx(p) >= 0)) {
          const i = idx(p);
          if (i >= 0) { path.length = i + 1; api.say(""); render(); return; }
          api.say("You can only step to a neighbouring cell with no wall in between.");
          return;
        }
        if (P.door && same(p, P.door) && idx(P.key) < 0) { api.say("The door is locked. Your path needs to pass the key first.", "lose"); return; }
        path.push(p.slice());
        api.say("");
        render();
        if (same(p, P.E)) {
          const steps = path.length - 1;
          if (steps === P.par || misses >= 2) return api.win({ stars: steps === P.par ? 3 - Math.min(misses, 1) : 1, text: `Your route took ${steps} steps; the shortest is ${P.par}. BFS finds it by expanding every cell at distance d before any at distance d + 1.${P.key ? " With the key, BFS runs on (cell, has-key) pairs, so walking back along a corridor is allowed when it pays off." : ""}` });
          misses++;
          api.say(`You reached the exit in ${steps} steps, but ${P.par} is possible. Back up and look for a shortcut.`, "lose");
        }
      }
      C.onPick(box, "data-rc", (v) => move(v.split(",").map(Number)));
      render();
      return { move };
    },
  });

  /* ===================== Road Trip (Dijkstra) ===================== */
  function dijkstra(G, s, directed) {
    const A = C.adj(G, directed), dist = Array(G.n).fill(Infinity), par = Array(G.n).fill(-1), done = Array(G.n).fill(false);
    dist[s] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < G.n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) break;
      done[u] = true;
      for (const { v, w } of A[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; par[v] = u; }
    }
    return { dist, par };
  }
  function hops(G, s, directed) {
    const A = C.adj(G, directed), d = Array(G.n).fill(-1), par = Array(G.n).fill(-1); d[s] = 0; const q = [s];
    while (q.length) { const u = q.shift(); for (const { v } of A[u]) if (d[v] < 0) { d[v] = d[u] + 1; par[v] = u; q.push(v); } }
    return { d, par };
  }
  const pathOf = (par, t) => { const p = []; for (let v = t; v >= 0; v = par[v]) p.unshift(v); return p; };
  const edgeW = (G, a, b, directed) => { const e = G.edges.find((e) => (e.u === a && e.v === b) || (!directed && e.u === b && e.v === a)); return e ? e.w : null; };
  C.register({
    id: "roadtrip", cat: "graphs", name: "Road Trip", concept: "Dijkstra",
    blurb: "Drive from S to T on the cheapest roads. The fewest roads is rarely the cheapest.",
    tiers: ["6–8 towns", "9–11 towns", "12–15 towns", "One-way streets"],
    lesson: `<p><b>Dijkstra's algorithm</b> settles towns in order of their true distance from the start. Repeatedly take the unsettled town with the smallest tentative distance, then relax its roads: if going through it is cheaper, update the neighbour.</p>
      <p>It works because weights are non-negative. Once the closest unsettled town is picked, no detour through farther towns can make it cheaper. With a binary heap it runs in O((V + E) log V).</p>
      <p>The trap is counting roads instead of adding up costs. Breadth-first search finds the fewest roads, not the lowest cost.</p>`,
    hint: "Work outward from S like Dijkstra: write the cheapest known cost next to each town, always extending from the cheapest unsettled one.",
    gen(L, R, t) {
      const directed = t === 3;
      const n = t === 0 ? 6 + Math.floor((L - 1) / 4) : t === 1 ? 9 + Math.floor((L - 11) / 4) : t === 2 ? 12 + Math.floor((L - 21) / 3) : 9 + Math.floor((L - 31) / 3);
      const G = C.mapGraph(R, n, { extra: 0.45, diag: 0.5, wmin: 1, wmax: 9 });
      if (!G) return null;
      if (directed) {
        const two = [];
        G.edges.forEach((e) => { if (R.chance(0.35)) two.push({ u: e.v, v: e.u, w: e.w }); else if (R.chance(0.5)) [e.u, e.v] = [e.v, e.u]; });
        G.edges.push(...two);
      }
      const s = 0;
      const { dist, par } = dijkstra(G, s, directed);
      const h = hops(G, s, directed);
      const cands = U.range(n).filter((v) => dist[v] < Infinity && h.d[v] >= Math.max(2, Math.floor(Math.sqrt(n))));
      if (!cands.length) return null;
      const hopCostTo = (v) => { const hp = pathOf(h.par, v); let c = 0; for (let i = 1; i < hp.length; i++) c += edgeW(G, hp[i - 1], hp[i], directed); return c; };
      // the fewest-roads route must be a trap: prefer the most distant town where it costs more
      const T = cands.sort((a, b) => h.d[b] - h.d[a] || dist[b] - dist[a]).find((v) => hopCostTo(v) > dist[v]);
      if (T == null) return null;
      const sol = pathOf(par, T).slice(1);
      return { G, s, T, directed, best: dist[T], par: dist[T], solution: sol,
        goal: `Build a route from <b>${L_[s]}</b> to <b>${L_[T]}</b> by tapping neighbouring towns${directed ? " (roads are one-way)" : ""}. Tap a town on your route to back up. Numbers are road costs: reach ${L_[T]} with the <b>lowest total</b>.` };
    },
    view(el, P, api) {
      const G = P.G, path = [P.s];
      let misses = 0;
      el.innerHTML = `<div class="figure camp-fig"></div><div class="ptr-readout"></div>`;
      const fig = el.querySelector(".figure"), out = el.querySelector(".ptr-readout");
      const cost = () => { let c = 0; for (let i = 1; i < path.length; i++) c += edgeW(G, path[i - 1], path[i], P.directed); return c; };
      function render() {
        const onPath = new Set(path.map((v, i) => (i ? `${path[i - 1]}>${v}` : "")));
        fig.innerHTML = C.svgGraph(G, {
          weights: true, directed: P.directed, pickNodes: true,
          nodeClass: (i) => (i === path[path.length - 1] ? "head" : path.includes(i) ? "on" : "") + (i === P.s ? " src" : i === P.T ? " dst" : ""),
          edgeClass: (e) => (onPath.has(`${e.u}>${e.v}`) || (!P.directed && onPath.has(`${e.v}>${e.u}`)) ? "on" : ""),
          aria: "Road map",
        });
        out.innerHTML = `Route: <b>${path.map((v) => L_[v]).join(" → ")}</b> · cost <b>${cost()}</b>`;
        api.stats([["Cost", cost()], ["Roads", path.length - 1]]);
      }
      function move(v) {
        if (api.over) return;
        const i = path.indexOf(v);
        if (i >= 0) { path.length = i + 1; api.say(""); render(); return; }
        const head = path[path.length - 1];
        if (edgeW(G, head, v, P.directed) == null) { api.say(`No ${P.directed ? "one-way " : ""}road from ${L_[head]} to ${L_[v]}.`); return; }
        path.push(v);
        api.say("");
        render();
        if (v === P.T) {
          const c = cost();
          if (c === P.best) return api.win({ stars: 3 - Math.min(misses, 2), text: `Cost ${c} is the cheapest possible. Dijkstra would settle the towns in order of distance from ${L_[P.s]}, and ${L_[P.T]} is settled at exactly ${c}.` });
          misses++;
          api.say(`That route costs ${c}, but a cheaper one exists. Back up and compare.`, "lose");
        }
      }
      C.onPick(fig, "data-node", (v) => move(+v));
      render();
      return { move };
    },
  });

  /* ===================== Cable Network (MST) ===================== */
  function kruskal(G) {
    const parent = U.range(G.n), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const chosen = [];
    G.edges.map((e, k) => ({ ...e, k })).sort((a, b) => a.w - b.w).forEach((e) => { const a = find(e.u), b = find(e.v); if (a !== b) { parent[a] = b; chosen.push(e.k); } });
    return chosen;
  }
  C.register({
    id: "cables", cat: "graphs", name: "Cable Network", concept: "Minimum spanning tree",
    blurb: "Connect every building with the least cable. Any cycle is wasted cable.",
    tiers: ["5–7 buildings", "8–10 buildings", "11–14 buildings", "Ties and dense maps"],
    lesson: `<p>A <b>spanning tree</b> connects all n vertices with exactly n − 1 edges and no cycles. The cheapest one is the minimum spanning tree.</p>
      <p><b>Kruskal:</b> sort the edges by weight and take each one unless it would close a cycle (Union-Find answers that in near O(1)). <b>Prim:</b> grow one tree, always adding the cheapest edge leaving it.</p>
      <p>Both rely on the <b>cut property</b>: for any split of the vertices into two groups, the cheapest edge crossing the split belongs to some MST.</p>`,
    hint: "Add cables from cheapest to most expensive, skipping any cable whose two ends are already connected.",
    gen(L, R, t) {
      const n = t === 0 ? 5 + Math.floor((L - 1) / 4) : t === 1 ? 8 + Math.floor((L - 11) / 4) : t === 2 ? 11 + Math.floor((L - 21) / 3) : 12 + Math.floor((L - 31) / 2.5);
      const G = C.mapGraph(R, n, { extra: t === 3 ? 0.7 : 0.5, diag: 0.6, wmin: 1, wmax: t === 3 ? 6 : 15 });
      if (!G || G.edges.length < n + (n <= 7 ? 1 : 2)) return null;
      const sol = kruskal(G);
      const total = sol.reduce((s, k) => s + G.edges[k].w, 0);
      return { G, total, par: total, solution: sol, goal: `Tap cables to lay them. Connect <b>every building</b> using exactly ${n - 1} cables with the <b>lowest total length</b>. Tap a cable again to remove it.` };
    },
    view(el, P, api) {
      const G = P.G, sel = new Set();
      let misses = 0;
      el.innerHTML = `<div class="figure camp-fig"></div><div class="ptr-readout"></div>`;
      const fig = el.querySelector(".figure"), out = el.querySelector(".ptr-readout");
      const analyse = () => {
        const parent = U.range(G.n), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
        let cycle = false;
        sel.forEach((k) => { const e = G.edges[k], a = find(e.u), b = find(e.v); if (a === b) cycle = true; else parent[a] = b; });
        const comps = new Set(U.range(G.n).map(find)).size;
        const w = [...sel].reduce((s, k) => s + G.edges[k].w, 0);
        return { cycle, comps, w };
      };
      function render() {
        const { cycle, comps, w } = analyse();
        fig.innerHTML = C.svgGraph(G, { weights: true, pickEdges: true, edgeClass: (e, k) => (sel.has(k) ? "on" : ""), aria: "Buildings and possible cables" });
        out.innerHTML = `${sel.size} cables · length <b>${w}</b> · ${comps === 1 ? "everything connected" : `${comps} separate groups`}${cycle ? ' · <span class="lose">contains a cycle</span>' : ""}`;
        api.stats([["Length", w], ["Cables", `${sel.size}/${G.n - 1}`]]);
        return { cycle, comps, w };
      }
      function move(k) {
        if (api.over) return;
        if (sel.has(k)) sel.delete(k); else sel.add(k);
        const { cycle, comps, w } = render();
        api.say(cycle ? "Those cables form a cycle. One of them is redundant." : "");
        if (!cycle && comps === 1) {
          if (w === P.total) return api.win({ stars: 3 - Math.min(misses, 2), text: `Minimum total ${w}. Kruskal adds cables in increasing length and skips any whose ends are already linked. Swapping any of your cables for an unused one could only cost more.` });
          misses++;
          api.say(`Everything is connected for ${w}, but ${P.total} is possible. Look for an unused cable that is cheaper than the most expensive cable on the cycle it would create.`, "lose");
        }
      }
      C.onPick(fig, "data-edge", (v) => move(+v));
      render();
      return { move };
    },
  });

  /* ===================== Course Planner ===================== */
  const COURSES = ["Arrays", "Lists", "Stacks", "Queues", "Trees", "Heaps", "Hashing", "Graphs", "Sorting", "Recursion", "DP", "Greedy", "Tries", "Bits", "Strings", "Math", "Proofs", "Search"];
  function minSemesters(n, pre, K) {
    const full = (1 << n) - 1, need = U.range(n).map((i) => pre[i].reduce((m, j) => m | (1 << j), 0));
    const dist = new Map([[0, 0]]), prev = new Map();
    let q = [0];
    while (q.length) {
      const nq = [];
      for (const m of q) {
        if (m === full) {
          const plan = []; for (let x = m; x; x = prev.get(x)[0]) plan.unshift(prev.get(x)[1]);
          return plan;
        }
        const avail = U.range(n).filter((i) => !(m >> i & 1) && (need[i] & m) === need[i]);
        const take = Math.min(K, avail.length);
        const combos = [];
        const pick = (start, cur) => { if (cur.length === take) { combos.push(cur.slice()); return; } for (let i = start; i < avail.length; i++) { cur.push(avail[i]); pick(i + 1, cur); cur.pop(); } };
        pick(0, []);
        for (const cmb of combos) { const nm = cmb.reduce((x, i) => x | (1 << i), m); if (!dist.has(nm)) { dist.set(nm, dist.get(m) + 1); prev.set(nm, [m, cmb]); nq.push(nm); } }
      }
      q = nq;
    }
    return null;
  }
  C.register({
    id: "courses", cat: "graphs", name: "Course Planner", concept: "Topological order",
    blurb: "Schedule courses by semester. Prerequisites first, and finish as early as possible.",
    tiers: ["Any number per semester", "Bigger catalogues", "At most 2 per semester", "At most 3 per semester"],
    lesson: `<p>Prerequisites form a <b>directed acyclic graph</b>. A valid plan is a <b>topological order</b>: every arrow points from an earlier semester to a later one.</p>
      <p>With no limit per semester, the minimum number of semesters equals the longest chain of prerequisites, the <b>critical path</b>. Take every course the moment it becomes available (Kahn's algorithm, one layer at a time).</p>
      <p>With a cap of k per semester it gets genuinely hard (NP-hard in general). Prefer courses that unlock long chains. Par here comes from a breadth-first search over every set of completed courses.</p>`,
    hint: "Each semester, take available courses that sit at the start of the longest remaining chains first.",
    gen(L, R, t) {
      const n = t === 0 ? 5 + Math.floor((L - 1) / 3) : t === 1 ? 8 + Math.floor((L - 11) / 4) : t === 2 ? 7 + Math.floor((L - 21) / 3) : 9 + Math.floor((L - 31) / 3);
      const K = t <= 1 ? Infinity : t === 2 ? 2 : 3;
      const names = R.sample(COURSES, n);
      const pre = U.range(n).map(() => []);
      for (let i = 1; i < n; i++) {
        const k = R.chance(0.25) ? 0 : R.chance(0.65) ? 1 : 2;
        R.sample(U.range(i), Math.min(k, i)).forEach((j) => pre[i].push(j));
      }
      // shuffle labels so index order doesn't give the answer away
      const perm = R.shuffle(U.range(n)), inv = []; perm.forEach((p, i) => (inv[p] = i));
      const pre2 = U.range(n).map((i) => pre[perm[i]].map((j) => inv[j]));
      const plan = minSemesters(n, pre2, K === Infinity ? n : K);
      if (!plan) return null;
      const depthMin = t <= 1 ? 3 : 3;
      if (plan.length < depthMin) return null;
      if (K !== Infinity) { const greedyish = minSemesters(n, pre2, n); if (greedyish && greedyish.length === plan.length && R.chance(0.6)) return null; }
      const solution = [];
      plan.forEach((sem) => { sem.forEach((c) => solution.push(c)); solution.push("end"); });
      return { n, names, pre: pre2, K, par: plan.length, solution,
        goal: `Tap available courses to take them this semester${K !== Infinity ? ` (at most <b>${K}</b>)` : ""}, then press <b>Finish semester</b>. A course needs every course pointing into it done in an earlier semester. Finish everything in <b>${plan.length}</b> semesters.` };
    },
    view(el, P, api) {
      const n = P.n, done = new Set(), cur = new Set(), sems = [];
      el.innerHTML = `<div class="figure camp-fig"></div><ol class="sems"></ol><div class="actions"><button type="button" class="btn primary endsem">Finish semester</button></div>`;
      const fig = el.querySelector(".figure"), list = el.querySelector(".sems"), endBtn = el.querySelector(".endsem");
      // layered layout by longest path depth
      const depth = U.range(n).map(() => 0);
      for (let pass = 0; pass < n; pass++) U.range(n).forEach((i) => P.pre[i].forEach((j) => (depth[i] = Math.max(depth[i], depth[j] + 1))));
      const maxD = Math.max(...depth), byD = U.range(maxD + 1).map((d) => U.range(n).filter((i) => depth[i] === d));
      const W = Math.max(360, (maxD + 1) * 96), H = Math.max(220, Math.max(...byD.map((x) => x.length)) * 56 + 20);
      const nodes = []; byD.forEach((col, d) => col.forEach((i, k) => (nodes[i] = { x: 52 + d * ((W - 104) / Math.max(1, maxD)), y: (H / (col.length + 1)) * (k + 1) })));
      const G = { n, nodes, edges: [], W, H };
      P.pre.forEach((ps, i) => ps.forEach((j) => G.edges.push({ u: j, v: i, w: 0 })));
      const avail = (i) => !done.has(i) && !cur.has(i) && P.pre[i].every((j) => done.has(j));
      function render() {
        fig.innerHTML = C.svgGraph(G, { directed: true, pickNodes: true, r: 24, label: (i) => P.names[i].slice(0, 5), nodeClass: (i) => (done.has(i) ? "done" : cur.has(i) ? "head" : avail(i) ? "avail" : "locked"), aria: "Course prerequisites" });
        list.innerHTML = sems.map((s, k) => `<li><b>Semester ${k + 1}:</b> ${s.map((i) => P.names[i]).join(", ")}</li>`).join("") + `<li class="cur"><b>Semester ${sems.length + 1}:</b> ${[...cur].map((i) => P.names[i]).join(", ") || '<span class="muted">tap courses</span>'}</li>`;
        endBtn.disabled = !cur.size || api.over;
        api.stats([["Semester", sems.length + 1], ["Par", P.par], ["Done", `${done.size}/${n}`]]);
      }
      function move(m) {
        if (api.over) return;
        if (m === "end") {
          if (!cur.size) return;
          sems.push([...cur]); cur.forEach((i) => done.add(i)); cur.clear();
          if (done.size === n) { render(); return api.win({ stars: C.stars(sems.length, P.par, 1), text: `Finished in ${sems.length} semesters (optimum ${P.par}). ${P.K === Infinity ? "Without a cap, the answer is the length of the longest prerequisite chain, the critical path." : `With at most ${P.K} per semester, the courses that unlock long chains had to go first.`}` }); }
          render();
          return;
        }
        const i = +m;
        if (cur.has(i)) { cur.delete(i); render(); return; }
        if (done.has(i)) return;
        if (!avail(i)) { api.say(`${P.names[i]} needs ${P.pre[i].filter((j) => !done.has(j)).map((j) => P.names[j]).join(", ")} first, in an earlier semester.`); return; }
        if (cur.size >= P.K) { api.say(`At most ${P.K} courses per semester.`); return; }
        cur.add(i); api.say(""); render();
      }
      C.onPick(fig, "data-node", (v) => move(v));
      endBtn.addEventListener("click", () => move("end"));
      render();
      return { move: (m) => move(typeof m === "number" ? String(m) : m) };
    },
  });

  /* ===================== Matchmaker ===================== */
  function maxMatching(m, adj) {
    const matchR = Array(m).fill(-1);
    const tryL = (u, seen) => { for (const v of adj[u]) { if (seen[v]) continue; seen[v] = true; if (matchR[v] < 0 || tryL(matchR[v], seen)) { matchR[v] = u; return true; } } return false; };
    let size = 0; for (let u = 0; u < m; u++) if (tryL(u, Array(m).fill(false))) size++;
    return { size, pairs: matchR.map((u, v) => [u, v]).filter(([u]) => u >= 0) };
  }
  function bestAssignment(cost) {
    const m = cost.length; let best = Infinity, bestP = null;
    const perm = U.range(m);
    const go = (k, used, sum, cur) => {
      if (sum >= best) return;
      if (k === m) { best = sum; bestP = cur.slice(); return; }
      for (let j = 0; j < m; j++) if (!used[j]) { used[j] = true; cur.push(j); go(k + 1, used, sum + cost[k][j], cur); cur.pop(); used[j] = false; }
    };
    go(0, Array(m).fill(false), 0, []);
    return { best, perm: bestP || perm };
  }
  const PEOPLE = ["Ada", "Ben", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal"], JOBS = ["Web", "Data", "Ops", "QA", "ML", "UI", "API", "DB"];
  C.register({
    id: "match", cat: "graphs", name: "Matchmaker", concept: "Bipartite matching",
    blurb: "Pair people with jobs they can do. Greedy pairing gets stuck; augmenting paths don't.",
    tiers: ["4–5 pairs", "6–7 pairs", "8 pairs, tangled", "Cheapest assignment"],
    lesson: `<p>A <b>matching</b> pairs each person with at most one job they're qualified for. Greedy pairing often gets stuck with someone left over even though a full matching exists.</p>
      <p>The fix is an <b>augmenting path</b>: start at an unmatched person, follow an unused edge to a job, the matched edge back to that job's person, an unused edge again, and so on until you reach a free job. Flipping every edge along it grows the matching by one. When no augmenting path exists, the matching is maximum (Berge's theorem).</p>
      <p>The <b>assignment problem</b> adds costs: find the perfect matching with the smallest total. The Hungarian algorithm solves it in O(n³).</p>`,
    hint: "Stuck with someone unmatched? Re-assign the person holding their job to another job they can do. That's an augmenting path.",
    gen(L, R, t) {
      if (t === 3) {
        const m = L <= 35 ? 4 : 5;
        const cost = U.range(m).map(() => U.range(m).map(() => R.int(1, 9)));
        const { best, perm } = bestAssignment(cost);
        // greedy row-by-row cheapest should fail
        const used = new Set(); let g = 0; cost.forEach((row) => { let b = -1; row.forEach((c, j) => { if (!used.has(j) && (b < 0 || c < row[b])) b = j; }); used.add(b); g += row[b]; });
        if (g === best) return null;
        return { mode: "cost", m, cost, best, par: best, solution: perm.map((j, i) => [i, j]), goal: `Every person gets exactly one job. The grid shows what each pairing costs. Find the assignment with the <b>lowest total cost</b>. Tap a cell to assign that pair.` };
      }
      const m = t === 0 ? (L <= 5 ? 4 : 5) : t === 1 ? (L <= 15 ? 6 : 7) : 8;
      const adj = U.range(m).map(() => R.sample(U.range(m), R.int(1, t === 0 ? 2 : 3)).sort((a, b) => a - b));
      const { size, pairs } = maxMatching(m, adj);
      // greedy in reading order must fall short, so the puzzle needs an augmenting path
      const taken = new Set(); let g = 0; adj.forEach((js) => { const j = js.find((x) => !taken.has(x)); if (j != null) { taken.add(j); g++; } });
      if (g === size || size < m - 2) return null;
      return { mode: "match", m, adj, best: size, par: size, solution: pairs, goal: `Tap a person, then a job they're linked to, to pair them. Pair up <b>as many people as possible</b>: the best possible is <b>${size}</b> of ${m}. Re-pairing someone frees their old job.` };
    },
    view(el, P, api) {
      const m = P.m, toJob = Array(m).fill(-1);
      let sel = null, actions = 0;
      el.innerHTML = `<div class="figure camp-fig"></div><div class="ptr-readout"></div>`;
      const fig = el.querySelector(".figure"), out = el.querySelector(".ptr-readout");
      const total = () => toJob.reduce((s, j, i) => s + (j >= 0 ? (P.mode === "cost" ? P.cost[i][j] : 1) : 0), 0);
      function render() {
        if (P.mode === "cost") {
          fig.innerHTML = `<table class="assign"><thead><tr><th></th>${U.range(m).map((j) => `<th>${JOBS[j]}</th>`).join("")}</tr></thead><tbody>${U.range(m).map((i) => `<tr><th>${PEOPLE[i]}</th>${U.range(m).map((j) => `<td><button type="button" class="acell${toJob[i] === j ? " on" : ""}${toJob.indexOf(j) >= 0 && toJob[i] !== j ? " taken" : ""}" data-ij="${i},${j}">${P.cost[i][j]}</button></td>`).join("")}</tr>`).join("")}</tbody></table>`;
          out.innerHTML = `Assigned ${toJob.filter((j) => j >= 0).length}/${m} · total cost <b>${total()}</b>`;
          api.stats([["Cost", total()], ["Assigned", `${toJob.filter((j) => j >= 0).length}/${m}`]]);
          return;
        }
        const H = Math.max(220, m * 44 + 20), W = 360, y = (k) => 26 + k * ((H - 52) / Math.max(1, m - 1));
        let s = "";
        P.adj.forEach((js, i) => js.forEach((j) => { s += `<line class="edge${toJob[i] === j ? " match" : ""}" x1="90" y1="${y(i)}" x2="270" y2="${y(j)}"/>`; }));
        U.range(m).forEach((i) => { s += `<g class="node${sel === i ? " head" : ""}${toJob[i] >= 0 ? " on" : ""}" data-pick="L${i}" tabindex="0" role="button"><rect x="20" y="${y(i) - 15}" width="70" height="30" rx="6"/><text x="55" y="${y(i)}">${PEOPLE[i]}</text></g>`; });
        U.range(m).forEach((j) => { s += `<g class="node${toJob.includes(j) ? " on" : ""}" data-pick="R${j}" tabindex="0" role="button"><rect x="270" y="${y(j) - 15}" width="70" height="30" rx="6"/><text x="305" y="${y(j)}">${JOBS[j]}</text></g>`; });
        fig.innerHTML = `<svg class="diagram bip" viewBox="0 0 ${W} ${H}" width="${W}">${s}</svg>`;
        out.innerHTML = `Pairs: <b>${total()}</b> of best ${P.best}${sel != null ? ` · choose a job for <b>${PEOPLE[sel]}</b>` : ""}`;
        api.stats([["Pairs", `${total()}/${P.best}`], ["Actions", actions]]);
      }
      function move([i, j]) {
        if (api.over) return;
        if (P.mode === "match" && !P.adj[i].includes(j)) { api.say(`${PEOPLE[i]} can't do ${JOBS[j]}.`); return; }
        if (toJob[i] === j) toJob[i] = -1;
        else { const k = toJob.indexOf(j); if (k >= 0) toJob[k] = -1; toJob[i] = j; }
        actions++; sel = null; api.say("");
        render();
        if (P.mode === "match" && total() === P.best) return api.win({ stars: C.stars(actions, P.best, 3), text: `${P.best} pairs is the maximum. Pairing greedily in order gets stuck. Each re-pairing you did was an augmenting path flipping matched and unmatched edges.` });
        if (P.mode === "cost" && toJob.every((j) => j >= 0)) {
          if (total() === P.best) return api.win({ stars: C.stars(actions, m, 3), text: `Total ${P.best} is the cheapest assignment. Taking each person's cheapest free job in turn costs more, because an early cheap pick can force someone else into an expensive one.` });
          api.say(`Everyone is assigned for ${total()}, but ${P.best} is possible. Try swapping two people's jobs.`, "lose");
        }
      }
      if (P.mode === "cost") C.onPick(fig, "data-ij", (v) => move(v.split(",").map(Number)));
      else C.onPick(fig, "data-pick", (v) => {
        const k = +v.slice(1);
        if (v[0] === "L") { sel = sel === k ? null : k; render(); return; }
        if (sel == null) { const owner = toJob.indexOf(k); if (owner >= 0) { sel = owner; render(); } else api.say("Tap a person first."); return; }
        move([sel, k]);
      });
      render();
      return { move };
    },
  });

  /* ===================== Map Coloring ===================== */
  function colorWith(G, k) {
    const A = C.adj(G), col = Array(G.n).fill(-1);
    const order = U.range(G.n).sort((a, b) => A[b].length - A[a].length);
    const go = (i) => {
      if (i === G.n) return true;
      const v = order[i];
      for (let c = 0; c < k; c++) { if (A[v].some(({ v: w }) => col[w] === c)) continue; col[v] = c; if (go(i + 1)) return true; }
      col[v] = -1; return false;
    };
    return go(0) ? col : null;
  }
  const PALETTE = ["#e8590c", "#2f9e44", "#1c7ed6", "#ae3ec9"];
  C.register({
    id: "coloring", cat: "graphs", name: "Map Coloring", concept: "Graph colouring",
    blurb: "Colour the regions so neighbours always differ, using the fewest colours possible.",
    tiers: ["Two colours (bipartite)", "Three colours", "Bigger three-colour maps", "Four colours"],
    lesson: `<p>Neighbouring vertices must get different colours. The fewest colours needed is the <b>chromatic number</b>.</p>
      <p><b>Two colours</b> work exactly when the graph has no odd cycle (it's bipartite). Colour one vertex, give its neighbours the other colour, and BFS outward. A clash means an odd cycle.</p>
      <p><b>Three or more</b> is NP-hard in general. Backtracking with "most constrained first" works well on small graphs. Any map drawn on a plane needs at most four colours (the four colour theorem, 1976, one of the first proofs done by computer).</p>`,
    hint: "Start where the most neighbours meet. A triangle forces three colours, and a fully linked group of four forces four.",
    gen(L, R, t) {
      const n = t === 0 ? 6 + Math.floor((L - 1) / 2) : t === 1 ? 7 + Math.floor((L - 11) / 3) : t === 2 ? 11 + Math.floor((L - 21) / 3) : 9 + Math.floor((L - 31) / 3);
      const k = t === 0 ? 2 : t === 3 ? 4 : 3;
      const G = C.mapGraph(R, n, { extra: t === 0 ? 0.3 : 0.6, diag: t === 0 ? 0 : t === 3 ? 0.9 : 0.6, wmin: 0, wmax: 0 });
      if (!G) return null;
      if (t === 3) {
        // add a few crossing diagonals to create K4s
        const at = new Map(G.nodes.map((p, i) => [p.r + "," + p.c, i]));
        G.nodes.forEach((p, i) => { const a = at.get(p.r + "," + (p.c + 1)), b = at.get(p.r + 1 + "," + p.c), d = at.get(p.r + 1 + "," + (p.c + 1)); if (a != null && b != null && d != null && R.chance(0.35)) { [[i, d], [a, b]].forEach(([x, y]) => { if (!G.edges.some((e) => (e.u === x && e.v === y) || (e.u === y && e.v === x))) G.edges.push({ u: x, v: y, w: 0 }); }); } });
      }
      if (colorWith(G, k - 1)) return null;          // must really need k colours
      const col = colorWith(G, k);
      if (!col) return null;
      return { G, k, par: n, solution: col.map((c, v) => [v, c]), goal: `Pick a colour, then tap vertices to paint them. Neighbours must differ. You have exactly <b>${k}</b> colours, and this graph needs all of them.` };
    },
    view(el, P, api) {
      const G = P.G, col = Array(G.n).fill(-1), A = C.adj(G);
      let pen = 0, paints = 0;
      el.innerHTML = `<div class="palette">${U.range(P.k).map((c) => `<button type="button" class="swatch" data-c="${c}" style="--sw:${PALETTE[c]}" aria-label="Colour ${c + 1}"></button>`).join("")}</div><div class="figure camp-fig"></div>`;
      const fig = el.querySelector(".figure"), pal = el.querySelector(".palette");
      function render() {
        pal.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("on", +b.dataset.c === pen));
        const clash = (v) => col[v] >= 0 && A[v].some(({ v: w }) => col[w] === col[v]);
        fig.innerHTML = C.svgGraph(G, { pickNodes: true, nodeClass: (v) => (col[v] >= 0 ? `paint p${col[v]}` : "") + (clash(v) ? " clash" : ""), label: (v) => L_[v], aria: "Map graph" });
        fig.querySelectorAll(".node.paint").forEach((g) => { const v = +g.dataset.node; g.querySelector("circle").style.fill = PALETTE[col[v]]; });
        const bad = G.edges.filter((e) => col[e.u] >= 0 && col[e.u] === col[e.v]).length;
        api.stats([["Painted", `${col.filter((c) => c >= 0).length}/${G.n}`], ["Clashes", bad], ["Paints", paints]]);
        return bad;
      }
      function move([v, c]) {
        if (api.over) return;
        col[v] = c; paints++;
        const bad = render();
        if (!bad && col.every((x) => x >= 0)) api.win({ stars: C.stars(paints, P.par, Math.ceil(G.n / 3)), text: P.k === 2 ? "Two colours worked because every cycle in this graph has even length. Breadth-first colouring proves it in O(V + E)." : `${P.k} colours, and ${P.k - 1} would not have been enough (a backtracking search checked). ${P.k === 4 ? "Four vertices all linked to each other force four colours." : "Any triangle forces three colours."}` });
      }
      pal.addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (b) { pen = +b.dataset.c; render(); } });
      C.onPick(fig, "data-node", (v) => move([+v, pen]));
      render();
      return { move };
    },
  });
})();
