/* Graph Lab: random graphs drawn as SVG; traverse, sort, find shortest paths and spanning trees. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;
  const L = U.letters;

  /* ---------- generation ---------- */
  // Nodes sit on a circle; edges prefer near neighbours on the circle so the picture stays readable.
  function makeGraph(n, { extra = 2, directed = false, weighted = false, connected = true, dag = false, components = 1 } = {}) {
    const slot = U.shuffle(U.range(n));                 // node i drawn at circle position slot[i]
    const circ = (u, v) => { const d = Math.abs(slot[u] - slot[v]); return Math.min(d, n - d); };
    const order = U.shuffle(U.range(n));                // used for DAG direction and tree building
    const rank = []; order.forEach((v, i) => (rank[v] = i));
    const edges = [], has = new Set();
    const key = (u, v) => (directed ? `${u}>${v}` : `${Math.min(u, v)}-${Math.max(u, v)}`);
    const add = (u, v) => {
      if (u === v || has.has(key(u, v)) || (directed && has.has(key(v, u)))) return false;
      if (dag && rank[u] > rank[v]) [u, v] = [v, u];
      has.add(key(u, v));
      edges.push({ u, v, w: 0 });
      return true;
    };
    const weightedPick = (cands, from) => {
      const ws = cands.map((c) => 1 / Math.pow(circ(from, c), 2));
      let r = Math.random() * ws.reduce((a, b) => a + b, 0);
      for (let i = 0; i < cands.length; i++) { r -= ws[i]; if (r <= 0) return cands[i]; }
      return cands[cands.length - 1];
    };
    // Split into groups for multi-component graphs (contiguous arcs of the circle).
    const groups = [];
    if (components > 1) {
      const byPos = U.range(n).sort((a, b) => slot[a] - slot[b]);
      const cuts = U.sample(U.range(n - 1).map((i) => i + 1).filter((c) => c >= 2 && n - c >= 1), components - 1).sort((a, b) => a - b);
      let prev = 0;
      [...cuts, n].forEach((c) => { groups.push(byPos.slice(prev, c)); prev = c; });
    } else groups.push(U.range(n));
    if (connected || components > 1) {
      groups.forEach((g) => {
        const gOrder = U.shuffle(g.slice());
        for (let i = 1; i < gOrder.length; i++) add(gOrder[i], weightedPick(gOrder.slice(0, i), gOrder[i]));
      });
    }
    let guard = 0;
    while (extra > 0 && guard++ < 200) {
      const g = U.pick(groups.filter((x) => x.length >= 3).length ? groups.filter((x) => x.length >= 3) : groups);
      if (g.length < 2) continue;
      const u = U.pick(g), v = weightedPick(g.filter((x) => x !== u), u);
      if (add(u, v)) extra--;
    }
    return { n, edges, directed, weighted, slot };
  }

  function assignWeights(G, distinct) {
    const pool = distinct ? U.shuffle(U.range(Math.max(12, G.edges.length + 3)).map((x) => x + 1)) : null;
    G.edges.forEach((e, i) => (e.w = distinct ? pool[i] : U.randInt(1, 9)));
    G.weighted = true;
    return G;
  }

  const adj = (G) => {
    const a = U.range(G.n).map(() => []);
    G.edges.forEach((e) => { a[e.u].push({ v: e.v, w: e.w }); if (!G.directed) a[e.v].push({ v: e.u, w: e.w }); });
    a.forEach((l) => l.sort((x, y) => x.v - y.v));
    return a;
  };

  /* ---------- drawing ---------- */
  function svg(G, { pickable = false, highlight = [] } = {}) {
    const W = 360, H = 300, cx = W / 2, cy = H / 2, R = G.n <= 5 ? 105 : 120, r = 18;
    const P = U.range(G.n).map((i) => { const ang = -Math.PI / 2 + (2 * Math.PI * G.slot[i]) / G.n; return { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) }; });
    const id = "m" + Math.random().toString(36).slice(2, 8);
    const hl = new Set(highlight.map((e) => `${Math.min(e[0], e[1])}-${Math.max(e[0], e[1])}`));
    let edges = "", labels = "";
    G.edges.forEach((e) => {
      const a = P[e.u], b = P[e.v];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;
      const x1 = a.x + ux * r, y1 = a.y + uy * r, x2 = b.x - ux * (r + (G.directed ? 4 : 0)), y2 = b.y - uy * (r + (G.directed ? 4 : 0));
      const isHl = hl.has(`${Math.min(e.u, e.v)}-${Math.max(e.u, e.v)}`);
      edges += `<line class="edge${isHl ? " hl" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"${G.directed ? ` marker-end="url(#${id})"` : ""}/>`;
      if (G.weighted) {
        const t = G.directed ? 0.42 : 0.5;
        const mx = a.x + dx * t, my = a.y + dy * t;
        labels += `<g class="wlabel"><rect x="${(mx - 10).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="20" height="18" rx="4"/><text x="${mx.toFixed(1)}" y="${my.toFixed(1)}">${e.w}</text></g>`;
      }
    });
    const nodes = U.range(G.n).map((i) => `<g class="node"${pickable ? ` data-pick="${L[i]}"` : ""}><circle cx="${P[i].x.toFixed(1)}" cy="${P[i].y.toFixed(1)}" r="${r}"/><text x="${P[i].x.toFixed(1)}" y="${P[i].y.toFixed(1)}">${L[i]}</text>${pickable ? `<text class="ord" x="${(P[i].x + 16).toFixed(1)}" y="${(P[i].y - 16).toFixed(1)}"></text>` : ""}</g>`).join("");
    const defs = G.directed ? `<defs><marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0,0 L10,5 L0,10 z"/></marker></defs>` : "";
    return `<svg class="diagram graph" viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="${G.directed ? "Directed" : "Undirected"} graph with ${G.n} vertices">${defs}${edges}${labels}${nodes}</svg>`;
  }

  /* ---------- algorithms ---------- */
  function bfs(G, s) {
    const A = adj(G), dist = Array(G.n).fill(-1), order = [], par = Array(G.n).fill(-1);
    dist[s] = 0; const q = [s];
    while (q.length) { const u = q.shift(); order.push(u); A[u].forEach(({ v }) => { if (dist[v] < 0) { dist[v] = dist[u] + 1; par[v] = u; q.push(v); } }); }
    return { order, dist, par };
  }
  function dfs(G, s) {
    const A = adj(G), seen = new Set(), order = [];
    (function go(u) { seen.add(u); order.push(u); A[u].forEach(({ v }) => !seen.has(v) && go(v)); })(s);
    return order;
  }
  function dijkstra(G, s) {
    const A = adj(G), dist = Array(G.n).fill(Infinity), done = Array(G.n).fill(false), par = Array(G.n).fill(-1), order = [];
    dist[s] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < G.n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u] || (dist[i] === dist[u] && i < u))) u = i;
      if (u < 0) break;
      done[u] = true; order.push(u);
      A[u].forEach(({ v, w }) => { if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; par[v] = u; } });
    }
    return { dist, par, order };
  }
  function kruskal(G) {
    const parent = U.range(G.n), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const chosen = [], rejected = [];
    G.edges.slice().sort((a, b) => a.w - b.w).forEach((e) => { const a = find(e.u), b = find(e.v); if (a !== b) { parent[a] = b; chosen.push(e); } else rejected.push(e); });
    return { chosen, rejected, total: chosen.reduce((s, e) => s + e.w, 0) };
  }
  const pathTo = (par, t) => { const p = []; for (let v = t; v >= 0; v = par[v]) p.unshift(v); return p; };
  const names = (arr) => arr.map((i) => L[i]);
  const edgeName = (e) => `${L[Math.min(e.u, e.v)]}–${L[Math.max(e.u, e.v)]} (${e.w})`;

  /* ---------- questions ---------- */
  const choice = (o) => ({ kind: "choice", tag: "Graphs", ...o });

  function bfsQ(n) {
    const G = makeGraph(n, { extra: U.randInt(1, 3) });
    const s = U.rand(n), { order } = bfs(G, s);
    return {
      kind: "order", tag: "BFS", figure: svg(G, { pickable: true }),
      prompt: `Run <b>breadth-first search</b> from <b>${L[s]}</b>, visiting neighbours in alphabetical order. Click the vertices in the order they are visited.`,
      items: names(U.range(n)), answer: names(order),
      explain: "BFS uses a queue: dequeue a vertex, then enqueue its unvisited neighbours A→Z. Vertices come out in rings of increasing distance from the start.",
      review: `BFS from ${L[s]}`,
    };
  }
  function dfsQ(n) {
    const G = makeGraph(n, { extra: U.randInt(1, 3) });
    const s = U.rand(n), order = dfs(G, s);
    return {
      kind: "order", tag: "DFS", figure: svg(G, { pickable: true }),
      prompt: `Run recursive <b>depth-first search</b> from <b>${L[s]}</b>, exploring neighbours in alphabetical order. Click the vertices in the order they are first visited.`,
      items: names(U.range(n)), answer: names(order),
      explain: "DFS dives into the first unvisited neighbour and only backtracks when a vertex has none left.",
      review: `DFS from ${L[s]}`,
    };
  }
  function topoQ(n) {
    const G = makeGraph(n, { extra: U.randInt(2, 4), directed: true, dag: true });
    const indeg = Array(n).fill(0); G.edges.forEach((e) => indeg[e.v]++);
    const A = adj(G), deg = indeg.slice(), out = [];
    let avail = U.range(n).filter((i) => deg[i] === 0);
    while (avail.length) { avail.sort((a, b) => a - b); const u = avail.shift(); out.push(u); A[u].forEach(({ v }) => { if (--deg[v] === 0) avail.push(v); }); }
    const check = (seq) => {
      if (seq.length !== n || new Set(seq).size !== n) return false;
      const pos = {}; seq.forEach((x, i) => (pos[x] = i));
      return G.edges.every((e) => pos[L[e.u]] < pos[L[e.v]]);
    };
    return {
      kind: "order", tag: "Topological sort", figure: svg(G, { pickable: true }),
      prompt: "Click the vertices in a valid <b>topological order</b>: every arrow must point from an earlier vertex to a later one. Any valid order counts.",
      items: names(U.range(n)), answer: names(out), check,
      explain: "Kahn's algorithm repeatedly takes a vertex with no remaining incoming edges. When several are available, any of them works.",
      review: "Topological order of a DAG",
    };
  }
  function hopsQ(n) {
    const G = makeGraph(n, { extra: U.randInt(1, 3) });
    let s, t, d;
    for (let k = 0; k < 50; k++) { s = U.rand(n); t = U.rand(n); d = bfs(G, s).dist; if (d[t] >= 2) break; }
    const dfsLen = (() => { const o = dfs(G, s); const A = adj(G); const par = {}; const seen = new Set([s]); (function go(u) { A[u].forEach(({ v }) => { if (!seen.has(v)) { seen.add(v); par[v] = u; go(v); } }); })(s); let c = 0; for (let v = t; v !== s && v != null; v = par[v]) c++; return c; })();
    const { par } = bfs(G, s);
    return choice({
      tag: "BFS", figure: svg(G),
      prompt: `What is the fewest number of edges on a path from <b>${L[s]}</b> to <b>${L[t]}</b>?`,
      options: U.numOptions(d[t], [dfsLen, d[t] + 1]), answer: String(d[t]),
      explain: `A shortest path is ${names(pathTo(par, t)).join(" → ")}. BFS finds fewest-edge paths in unweighted graphs.`,
    });
  }
  function componentsQ(n) {
    const c = U.randInt(2, 3);
    const G = makeGraph(n, { components: c, extra: U.randInt(0, 2) });
    const parent = U.range(n), find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    G.edges.forEach((e) => (parent[find(e.u)] = find(e.v)));
    const k = U.uniq(U.range(n).map(find)).length;
    return choice({
      tag: "Connectivity", figure: svg(G),
      prompt: "How many <b>connected components</b> does this graph have?",
      options: U.numOptions(k, [n - G.edges.length, 1]), answer: String(k),
      explain: "Start a BFS or DFS from every vertex not yet reached and count how many searches you start. Isolated vertices count as components too.",
    });
  }
  function dijkstraQ(n) {
    for (let t = 0; t < 200; t++) {
      const G = assignWeights(makeGraph(n, { extra: U.randInt(2, 4) }), false);
      const s = U.rand(n);
      const { dist, par } = dijkstra(G, s);
      const hop = bfs(G, s);
      const cands = U.range(n).filter((v) => hop.dist[v] >= 2);
      if (!cands.length) continue;
      const tt = U.pick(cands);
      // weight along the BFS (fewest-edge) path, a classic trap
      const hp = pathTo(hop.par, tt); let hopW = 0;
      for (let i = 1; i < hp.length; i++) hopW += G.edges.find((e) => (e.u === hp[i - 1] && e.v === hp[i]) || (e.v === hp[i - 1] && e.u === hp[i])).w;
      if (hopW === dist[tt] && t < 150) continue;
      return choice({
        tag: "Dijkstra", figure: svg(G),
        prompt: `Edge labels are distances. What is the length of the shortest path from <b>${L[s]}</b> to <b>${L[tt]}</b>?`,
        options: U.numOptions(dist[tt], [hopW, dist[tt] + 2]), answer: String(dist[tt]),
        explain: `Shortest path: ${names(pathTo(par, tt)).join(" → ")} = ${dist[tt]}.` + (hopW !== dist[tt] ? ` The path with the fewest edges, ${names(hp).join(" → ")}, costs ${hopW}.` : "") + ` All distances from ${L[s]}: ${U.range(n).map((v) => `${L[v]}=${dist[v]}`).join(", ")}.`,
      });
    }
    return hopsQ(n);
  }
  function dijkstraOrderQ(n) {
    for (let t = 0; t < 300; t++) {
      const G = assignWeights(makeGraph(n, { extra: U.randInt(2, 3) }), false);
      const s = U.rand(n);
      const { dist, order } = dijkstra(G, s);
      if (new Set(dist).size !== n) continue;            // distinct distances make the order unique
      return {
        kind: "order", tag: "Dijkstra", figure: svg(G, { pickable: true }),
        prompt: `Run <b>Dijkstra's algorithm</b> from <b>${L[s]}</b>. Click the vertices in the order they are finalised (popped from the priority queue).`,
        items: names(U.range(n)), answer: names(order),
        explain: `Vertices are finalised in increasing distance: ${order.map((v) => `${L[v]} (${dist[v]})`).join(", ")}.`,
        review: `Dijkstra order from ${L[s]}`,
      };
    }
    return dijkstraQ(n);
  }
  function mstQ(n) {
    const G = assignWeights(makeGraph(n, { extra: U.randInt(2, 4) }), true);
    const { chosen, total } = kruskal(G);
    const naive = G.edges.map((e) => e.w).sort((a, b) => a - b).slice(0, n - 1).reduce((a, b) => a + b, 0);
    const spt = (() => { const { par } = dijkstra(G, 0); let s = 0; for (let v = 1; v < n; v++) s += G.edges.find((e) => (e.u === v && e.v === par[v]) || (e.v === v && e.u === par[v])).w; return s; })();
    return choice({
      tag: "MST", figure: svg(G),
      prompt: "What is the total weight of a <b>minimum spanning tree</b> of this graph?",
      options: U.numOptions(total, [naive, spt, total + 1]), answer: String(total),
      explain: `Kruskal takes edges from lightest to heaviest and skips any that would close a cycle: ${chosen.map(edgeName).join(", ")}. Total ${total}.` + (naive !== total ? ` Just summing the ${n - 1} lightest edges gives ${naive}, but some of those form a cycle.` : ""),
    });
  }
  function kruskalRejectQ(n) {
    for (let t = 0; t < 100; t++) {
      const G = assignWeights(makeGraph(n, { extra: U.randInt(2, 4) }), true);
      const { rejected, chosen } = kruskal(G);
      if (!rejected.length) continue;
      const first = rejected.slice().sort((a, b) => a.w - b.w)[0];
      const wrong = U.sample(chosen, 3).map(edgeName);
      return choice({
        tag: "MST", figure: svg(G), mono: false,
        prompt: "Kruskal's algorithm considers edges from lightest to heaviest. Which edge is the <b>first one it skips</b> because it would create a cycle?",
        options: U.shuffle([edgeName(first), ...wrong]), answer: edgeName(first),
        explain: `By the time ${edgeName(first)} comes up, its endpoints are already connected through lighter edges. Edges kept: ${chosen.map(edgeName).join(", ")}.`,
      });
    }
    return mstQ(n);
  }
  function bipartiteQ(n) {
    const G = makeGraph(n, { extra: U.randInt(1, 3) });
    const color = Array(n).fill(-1); let ok = true, conflict = null;
    const A = adj(G);
    for (let s = 0; s < n && ok; s++) {
      if (color[s] >= 0) continue;
      color[s] = 0; const q = [s];
      while (q.length && ok) { const u = q.shift(); for (const { v } of A[u]) { if (color[v] < 0) { color[v] = 1 - color[u]; q.push(v); } else if (color[v] === color[u]) { ok = false; conflict = [u, v]; break; } } }
    }
    return choice({
      tag: "Bipartite", figure: svg(G), mono: false,
      prompt: "Can the vertices be coloured with two colours so that every edge joins different colours? In other words, is the graph <b>bipartite</b>?",
      options: ["Yes", "No"], answer: ok ? "Yes" : "No",
      explain: ok
        ? `Yes. One side is {${names(U.range(n).filter((i) => color[i] === 0)).join(", ")}} and the other is {${names(U.range(n).filter((i) => color[i] === 1)).join(", ")}}.`
        : `No. BFS colouring finds ${L[conflict[0]]} and ${L[conflict[1]]} adjacent with the same colour, which means there is an odd-length cycle.`,
    });
  }
  function cycleQ(n) {
    const wantCycle = Math.random() < 0.5;
    const G = makeGraph(n, { extra: U.randInt(2, 3), directed: true, dag: true });
    if (wantCycle) { const e = U.pick(G.edges); G.edges = G.edges.filter((x) => x !== e); G.edges.push({ u: e.v, v: e.u, w: 0 }); }
    const A = adj(G), state = Array(n).fill(0); let cyc = false;
    const go = (u) => { state[u] = 1; for (const { v } of A[u]) { if (state[v] === 1) cyc = true; else if (!state[v]) go(v); } state[u] = 2; };
    U.range(n).forEach((u) => !state[u] && go(u));
    return choice({
      tag: "Cycle detection", figure: svg(G), mono: false,
      prompt: "Does this <b>directed</b> graph contain a cycle?",
      options: ["Yes", "No"], answer: cyc ? "Yes" : "No",
      explain: cyc ? "Yes. Following the arrows you can return to where you started. DFS spots it as an edge to a vertex still on the recursion stack." : "No. It is a DAG, so a topological order exists.",
    });
  }
  function sccQ(n) {
    const G = makeGraph(n, { extra: U.randInt(3, 5), directed: true });
    const A = adj(G);
    // Tarjan
    let idx = 0; const ix = Array(n).fill(-1), low = Array(n).fill(0), on = Array(n).fill(false), st = [], comps = [];
    const sc = (u) => { ix[u] = low[u] = idx++; st.push(u); on[u] = true; for (const { v } of A[u]) { if (ix[v] < 0) { sc(v); low[u] = Math.min(low[u], low[v]); } else if (on[v]) low[u] = Math.min(low[u], ix[v]); } if (low[u] === ix[u]) { const c = []; let w; do { w = st.pop(); on[w] = false; c.push(w); } while (w !== u); comps.push(c); } };
    U.range(n).forEach((u) => ix[u] < 0 && sc(u));
    const k = comps.length;
    return choice({
      tag: "SCC", figure: svg(G),
      prompt: "How many <b>strongly connected components</b> does this directed graph have? (Within one, every vertex can reach every other.)",
      options: U.numOptions(k, [1, n]), answer: String(k),
      explain: `Components: ${comps.map((c) => "{" + names(c.sort((a, b) => a - b)).join(", ") + "}").join(", ")}. Found with Tarjan's or Kosaraju's algorithm in O(V + E).`,
    });
  }

  const TYPES = {
    1: [() => bfsQ(5), () => hopsQ(6), () => componentsQ(6), () => dfsQ(5), () => bfsQ(5)],
    2: [() => bfsQ(U.randInt(6, 7)), () => dfsQ(U.randInt(6, 7)), () => topoQ(U.randInt(5, 6)), () => componentsQ(7), () => hopsQ(7)],
    3: [() => dijkstraQ(6), () => topoQ(7), () => mstQ(6), () => bipartiteQ(U.randInt(6, 7)), () => cycleQ(6), () => dfsQ(7), () => dijkstraQ(7)],
    4: [() => dijkstraOrderQ(U.randInt(6, 7)), () => mstQ(7), () => kruskalRejectQ(U.randInt(6, 7)), () => sccQ(7), () => topoQ(8), () => dijkstraQ(7)],
  };

  D.registerMode({
    id: "graph",
    name: "Graph Lab",
    group: "Simulators",
    topic: "Graphs",
    blurb: "BFS, DFS, topological sort, Dijkstra, MSTs and SCCs on freshly drawn graphs.",
    generated: true,
    count: 8,
    make: (lvl, count) => D.mixFrom(TYPES[lvl], count),
  });
})();
