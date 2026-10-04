/* Trees: binary trees, BSTs, heaps, tries, segment / Fenwick trees and general (rooted or free) trees. */
(function () {
  "use strict";
  const D = window.DSA, PB = D.pb, H = PB.h, U = D.util, C = D.campaign;
  const L3 = (lv, a, b, c) => [a, b, c][lv - 1];
  const LT = U.letters;
  const sum = (x) => x.reduce((s, v) => s + v, 0);
  const num = (o) => ({ w: "num", ...o });
  const yn = (o) => ({ w: "choice", ui: () => ({ opts: ["Yes", "No"] }), ...o });

  /* ---------- building trees ---------- */
  // A tree is { n, root, ch[v] (ordered children), par[v], dep[v], bfs, val? } plus L/R for binary trees (-1 = none).
  function finish(T) {
    T.par = Array(T.n).fill(-1); T.dep = Array(T.n).fill(0);
    const order = [T.root];
    for (let h = 0; h < order.length; h++) { const u = order[h]; for (const v of T.ch[u]) { T.par[v] = u; T.dep[v] = T.dep[u] + 1; order.push(v); } }
    T.bfs = order;
    return T;
  }
  const bin = (L, Rr, root = 0) => finish({ n: L.length, L, R: Rr, root, ch: L.map((l, i) => [l, Rr[i]].filter((x) => x >= 0)) });
  function randBin(R, n, maxD) {
    const L = [-1], Rr = [-1], dep = [0];
    for (let i = 1; i < n; i++) {
      const free = [];
      for (let j = 0; j < i; j++) if (dep[j] < maxD) { if (L[j] < 0) free.push([j, 0]); if (Rr[j] < 0) free.push([j, 1]); }
      if (!free.length) return null;
      const [p, s] = R.pick(free);
      (s ? Rr : L)[p] = i; L.push(-1); Rr.push(-1); dep.push(dep[p] + 1);
    }
    return bin(L, Rr);
  }
  function bst(keys) {
    const L = [], Rr = [], val = [];
    keys.forEach((k, i) => {
      val.push(k); L.push(-1); Rr.push(-1);
      if (i === 0) return;
      let u = 0;
      for (;;) { if (k < val[u]) { if (L[u] < 0) { L[u] = i; break; } u = L[u]; } else { if (Rr[u] < 0) { Rr[u] = i; break; } u = Rr[u]; } }
    });
    const T = bin(L, Rr); T.val = val; return T;
  }
  const height = (T) => Math.max(...T.dep);
  function randBST(R, n, lo, hi, maxD) { for (let t = 0; t < 300; t++) { const T = bst(R.distinct(n, lo, hi)); if (height(T) <= maxD) return T; } return null; }
  function randTree(R, n, maxD = 3, maxCh = 3) {
    const dep = [0], ch = [[]];
    for (let i = 1; i < n; i++) { const c = U.range(i).filter((j) => dep[j] < maxD && ch[j].length < maxCh); if (!c.length) return null; const p = R.pick(c); ch[p].push(i); ch.push([]); dep.push(dep[p] + 1); }
    return finish({ n, ch, root: 0 });
  }
  // Heap-position builder: positions are 1-based heap indices (children 2p, 2p + 1).
  function fromPos(pos) {
    const id = new Map(pos.map((p, i) => [p, i]));
    return bin(pos.map((p) => (id.has(2 * p) ? id.get(2 * p) : -1)), pos.map((p) => (id.has(2 * p + 1) ? id.get(2 * p + 1) : -1)), id.get(1));
  }
  // Nested { v, l, r } objects, handy for mirrored / flipped trees.
  function fromNested(o) {
    const L = [], Rr = [], val = [];
    const go = (x) => { if (!x) return -1; const i = val.length; val.push(x.v); L.push(-1); Rr.push(-1); L[i] = go(x.l); Rr[i] = go(x.r); return i; };
    go(o);
    const T = bin(L, Rr); T.val = val; return T;
  }
  function randNest(R, n, maxD, vals) {
    const T = randBin(R, n, maxD); if (!T) return null;
    const go = (v) => (v < 0 ? null : { v: vals(R), l: go(T.L[v]), r: go(T.R[v]) });
    return go(0);
  }
  const mirror = (o) => (o ? { v: o.v, l: mirror(o.r), r: mirror(o.l) } : null);
  const nsize = (o) => (o ? 1 + nsize(o.l) + nsize(o.r) : 0);

  function layout(T, o = {}) {
    const dx = o.dx || 42, dy = o.dy || 58, x = Array(T.n);
    let slot = 0;
    if (T.L) { const go = (v) => { if (v < 0) return; go(T.L[v]); x[v] = slot++; go(T.R[v]); }; go(T.root); }
    else { const go = (v) => { if (!T.ch[v].length) { x[v] = slot++; return; } T.ch[v].forEach(go); x[v] = (x[T.ch[v][0]] + x[T.ch[v][T.ch[v].length - 1]]) / 2; }; go(T.root); }
    const span = Math.max(...x), md = height(T);
    return {
      n: T.n, W: 60 + span * dx, H: 60 + md * dy,
      nodes: U.range(T.n).map((v) => ({ x: 30 + x[v] * dx, y: 30 + T.dep[v] * dy })),
      edges: U.range(T.n).filter((v) => T.par[v] >= 0).map((v) => ({ u: T.par[v], v, w: o.w ? o.w[v] : 1 })),
    };
  }

  /* ---------- tree algorithms ---------- */
  const isLeaf = (T, v) => !T.ch[v].length;
  const leaves = (T) => T.bfs.filter((v) => isLeaf(T, v));
  const preO = (T, r = T.root) => { const o = []; const go = (v) => { o.push(v); T.ch[v].forEach(go); }; go(r); return o; };
  const postO = (T) => { const o = []; const go = (v) => { T.ch[v].forEach(go); o.push(v); }; go(T.root); return o; };
  const inO = (T) => { const o = []; const go = (v) => { if (v < 0) return; go(T.L[v]); o.push(v); go(T.R[v]); }; go(T.root); return o; };
  const levels = (T) => { const out = []; T.bfs.forEach((v) => (out[T.dep[v]] = out[T.dep[v]] || []).push(v)); return out; };
  const hN = (T, v) => (v < 0 ? 0 : 1 + Math.max(0, ...T.ch[v].map((c) => hN(T, c)))); // height in nodes
  const sub = (T, v) => preO(T, v);
  const subSum = (T, v) => sum(sub(T, v).map((u) => T.val[u]));
  const nb = (T, v) => [...T.ch[v], T.par[v]].filter((x) => x >= 0);
  function distFrom(T, s) { const d = Array(T.n).fill(-1); d[s] = 0; const q = [s]; for (let h = 0; h < q.length; h++) for (const v of nb(T, q[h])) if (d[v] < 0) { d[v] = d[q[h]] + 1; q.push(v); } return d; }
  const anc = (T, v) => { const o = []; for (let u = v; u >= 0; u = T.par[u]) o.push(u); return o; };
  const lca = (T, a, b) => { const A = new Set(anc(T, a)); for (let u = b; u >= 0; u = T.par[u]) if (A.has(u)) return u; return T.root; };
  const isAnc = (T, a, v) => anc(T, v).includes(a);
  const pathVals = (T, p) => p.map((v) => T.val[v]);
  const adjacent = (T, a, b) => T.par[a] === b || T.par[b] === a;
  const isBSTsub = (T, v, lo = -Infinity, hi = Infinity) => v < 0 || (T.val[v] > lo && T.val[v] < hi && isBSTsub(T, T.L[v], lo, T.val[v]) && isBSTsub(T, T.R[v], T.val[v], hi));
  const catalan = (n) => { const c = [1]; for (let i = 1; i <= n; i++) { c[i] = 0; for (let j = 0; j < i; j++) c[i] += c[j] * c[i - 1 - j]; } return c[n]; };
  const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); };

  /* ---------- presentation ---------- */
  const lab = (T) => (T.val ? (i) => T.val[i] : undefined);
  const svgT = (I, o = {}) => C.svgGraph(o.G || I.G, { label: o.label || lab(o.T || I.T), weights: !!(o.weighted ?? I.weighted), r: o.r || I.r, nodeClass: o.cls });
  const figT = (I, o) => `<div class="figure camp-fig">${svgT(I, o)}</div>`;
  const markCls = (I) => (v) => ((I.mark || []).includes(v) ? "dst" : "");
  const tUI = (extra) => (I) => ({ G: I.G, labels: I.T.val ? I.T.val.map(String) : undefined, weights: !!I.weighted, r: I.r, nodeClass: I.mark ? markCls(I) : undefined, ...(extra ? extra(I) : {}) });
  const chipOrder = (T) => U.range(T.n).sort((a, b) => (T.val[a] < T.val[b] ? -1 : T.val[a] > T.val[b] ? 1 : a - b));
  const ordUI = (I) => ({ items: chipOrder(I.T).map((v) => I.T.val[v]) });
  const toChips = (T, seq) => { const c = chipOrder(T); return seq.map((v) => c.indexOf(v)); };
  const fromChips = (T, a) => { const c = chipOrder(T); return a.map((k) => c[k]); };
  const vlist = (xs) => xs.map((x) => H.tt(String(x))).join(" ");

  const defD = (n) => (n <= 6 ? 3 : 4);
  function gBin(R, n, o = {}) {
    const T = randBin(R, n, o.maxD || defD(n)); if (!T) return null;
    T.val = o.vals ? U.range(n).map(() => o.vals(R)) : R.distinct(n, o.lo || 1, o.hi || 99);
    return { T, G: layout(T) };
  }
  function gBST(R, n, o = {}) { const T = randBST(R, n, o.lo || 1, o.hi || 99, o.maxD || defD(n)); return T ? { T, G: layout(T) } : null; }
  function gTree(R, n, o = {}) {
    const T = randTree(R, n, o.maxD || 3, o.maxCh || 3); if (!T) return null;
    if (o.vals) T.val = U.range(n).map(() => o.vals(R));
    let w;
    if (o.weighted) w = U.range(n).map(() => R.int(1, 9));
    return { T, G: layout(T, { w }), weighted: !!o.weighted, w };
  }
  const ew = (I, a, b) => (I.T.par[b] === a ? I.w[b] : I.w[a]);
  const smallV = (lo, hi) => (R) => R.int(lo, hi);

  function heapPush(h, x) { h.push(x); let i = h.length - 1, sw = 0; while (i > 0 && h[(i - 1) >> 1] > h[i]) { [h[i], h[(i - 1) >> 1]] = [h[(i - 1) >> 1], h[i]]; i = (i - 1) >> 1; sw++; } return sw; }
  function siftDown(h, i) { let sw = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l] < h[m]) m = l; if (r < h.length && h[r] < h[m]) m = r; if (m === i) return sw; [h[i], h[m]] = [h[m], h[i]]; i = m; sw++; } }
  const heapTree = (h) => { const T = fromPos(h.map((_, i) => i + 1)); T.val = h.slice(); return T; };

  function boundary(T) {
    const r = T.root, leaf = (v) => isLeaf(T, v), out = [r];
    if (leaf(r)) return out;
    let v = T.L[r];
    while (v >= 0 && !leaf(v)) { out.push(v); v = T.L[v] >= 0 ? T.L[v] : T.R[v]; }
    const go = (u) => { if (leaf(u)) { if (u !== r) out.push(u); return; } T.ch[u].forEach(go); };
    go(r);
    const right = [];
    v = T.R[r];
    while (v >= 0 && !leaf(v)) { right.push(v); v = T.R[v] >= 0 ? T.R[v] : T.L[v]; }
    return out.concat(right.reverse());
  }
  const bal = (T, v) => hN(T, T.L[v]) - hN(T, T.R[v]);
  const avlOK = (T) => U.range(T.n).every((v) => Math.abs(bal(T, v)) <= 1);
  function avlCase(keys, x) {
    const T = bst([...keys, x]), xi = keys.length;
    let v = T.par[xi];
    while (v >= 0 && Math.abs(bal(T, v)) <= 1) v = T.par[v];
    if (v < 0) return null;
    const s1 = x < T.val[v] ? "L" : "R", c = s1 === "L" ? T.L[v] : T.R[v], s2 = x < T.val[c] ? "L" : "R";
    return { node: v, kind: s1 + s2 };
  }
  const AVL_OPTS = { LL: "Left-Left: single right rotation", RR: "Right-Right: single left rotation", LR: "Left-Right: rotate left, then right", RL: "Right-Left: rotate right, then left" };
  function segTree(n) {
    const L = [], Rr = [], rng = [];
    const build = (l, r) => { const i = L.length; L.push(-1); Rr.push(-1); rng.push([l, r]); if (l < r) { const m = (l + r) >> 1; L[i] = build(l, m); Rr[i] = build(m + 1, r); } return i; };
    build(0, n - 1);
    const T = bin(L, Rr); T.rng = rng; T.val = rng.map(([l, r]) => (l === r ? String(l) : `${l}–${r}`)); return T;
  }
  function segCover(T, ql, qr) { const out = []; const go = (v) => { const [l, r] = T.rng[v]; if (r < ql || l > qr) return; if (ql <= l && r <= qr) { out.push(v); return; } T.ch[v].forEach(go); }; go(T.root); return out; }
  const prefixes = (words) => { const s = new Set(); words.forEach((w) => { for (let i = 1; i <= w.length; i++) s.add(w.slice(0, i)); }); return s; };
  function randExpr(R, leaves, maxD) {
    for (let t = 0; t < 100; t++) {
      const L = [-1], Rr = [-1], dep = [0];
      let lv = [0];
      while (lv.length < leaves) {
        const c = lv.filter((v) => dep[v] < maxD); if (!c.length) break;
        const v = R.pick(c), a = L.length, b = a + 1;
        L.push(-1, -1); Rr.push(-1, -1); dep.push(dep[v] + 1, dep[v] + 1); L[v] = a; Rr[v] = b;
        lv = lv.filter((x) => x !== v).concat([a, b]);
      }
      if (lv.length < leaves) continue;
      const T = bin(L, Rr);
      T.val = U.range(T.n).map((v) => (isLeaf(T, v) ? String(R.int(1, 9)) : R.pick(["+", "−", "×"])));
      return T;
    }
    return null;
  }
  const evalE = (T, v = T.root) => { if (isLeaf(T, v)) return +T.val[v]; const a = evalE(T, T.L[v]), b = evalE(T, T.R[v]); return T.val[v] === "+" ? a + b : T.val[v] === "−" ? a - b : a * b; };
  const serial = (o) => (o ? `${o.v},${serial(o.l)},${serial(o.r)}` : "#");
  const canon = (o) => (o ? `(${o.v} ${[canon(o.l), canon(o.r)].sort().join(" ")})` : "#");
  const symm = (a, b) => (!a && !b) || (!!a && !!b && a.v === b.v && symm(a.l, b.r) && symm(a.r, b.l));
  const minSwaps = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), seen = Array(a.length).fill(false); let sw = 0; for (let i = 0; i < a.length; i++) { if (seen[i]) continue; let j = i, len = 0; while (!seen[j]) { seen[j] = true; j = s[j][1]; len++; } sw += len - 1; } return sw; };

  PB.addAll("trees", [
    /* ----- traversals ----- */
    { id: "preorder", name: "Preorder Traversal", tags: "DFS: node, left, right", w: "order",
      gen: (lv, R) => gBin(R, L3(lv, 5, 8, 11)), ui: ordUI,
      text: (I) => `Click the values in <b>preorder</b>: a node, then its left subtree, then its right subtree.${figT(I)}`,
      ans: (I) => toChips(I.T, preO(I.T)),
      why: () => `Preorder with a stack: pop a node, output it, push its right child and then its left child. Serialising or copying a tree uses preorder because every parent comes before its children.` },
    { id: "inorder", name: "Inorder Traversal", tags: "DFS: left, node, right", w: "order",
      gen: (lv, R) => gBin(R, L3(lv, 5, 8, 11)), ui: ordUI,
      text: (I) => `Click the values in <b>inorder</b>: left subtree, then the node, then the right subtree.${figT(I)}`,
      ans: (I) => toChips(I.T, inO(I.T)),
      why: () => `Iterative inorder: go left as far as possible pushing nodes, pop one, output it, then move to its right child. In a drawing like this, inorder is simply left-to-right order of the nodes.` },
    { id: "postorder", name: "Postorder Traversal", tags: "DFS: left, right, node", w: "order",
      gen: (lv, R) => gBin(R, L3(lv, 5, 8, 11)), ui: ordUI,
      text: (I) => `Click the values in <b>postorder</b>: left subtree, right subtree, then the node.${figT(I)}`,
      ans: (I) => toChips(I.T, postO(I.T)),
      why: () => `Postorder finishes children before parents, which is what you need to compute sizes, heights or to free memory. Trick: reversed (node, right, left) preorder is postorder.` },
    { id: "level-order", name: "Level-Order Traversal", tags: "BFS", w: "order",
      gen: (lv, R) => gBin(R, L3(lv, 5, 8, 11)), ui: ordUI,
      text: (I) => `Click the values in <b>level order</b>: top to bottom, left to right within each level.${figT(I)}`,
      ans: (I) => toChips(I.T, I.T.bfs),
      why: () => `BFS with a queue. To know where a level ends, record the queue length at the start of each level and pop exactly that many.` },
    { id: "zigzag-level-order", name: "Zigzag Level Order", tags: "BFS + alternating direction", w: "order",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12)), ui: ordUI,
      text: (I) => `Click the values level by level, but alternate direction: the root level left→right, the next right→left, and so on.${figT(I)}`,
      ans: (I) => toChips(I.T, levels(I.T).flatMap((l, i) => (i % 2 ? l.slice().reverse() : l))),
      why: () => `Normal BFS, then reverse every second level (or fill it from the back of a deque). The traversal order itself never changes.` },
    { id: "boundary-traversal", name: "Boundary of a Binary Tree", tags: "Three DFS passes", w: "order",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13)); return I && I.T.L[0] >= 0 && I.T.R[0] >= 0 ? I : null; },
      ui: (I) => ({ ...ordUI(I), len: boundary(I.T).length }),
      text: (I) => `Walk the boundary anticlockwise: the root, the left edge (top-down, leaves excluded), every leaf left to right, then the right edge bottom-up (leaves excluded). Click the ${boundary(I.T).length} boundary values in that order.${figT(I)}`,
      ans: (I) => toChips(I.T, boundary(I.T)),
      why: () => `Three separate passes avoid double counting: follow left children (or right when there is no left) for the left edge, a DFS for leaves, and the mirror walk for the right edge, reversed.` },
    { id: "invert-preorder", name: "Invert a Binary Tree", tags: "Mirror recursion", w: "order",
      gen: (lv, R) => gBin(R, L3(lv, 5, 8, 11)), ui: ordUI,
      text: (I) => `Mirror this tree (swap the left and right child of every node). Then click the <b>preorder</b> of the mirrored tree.${figT(I)}`,
      ans: (I) => toChips(I.T, postO(I.T).reverse()),
      why: () => `Inverting is one line of recursion: swap the children, recurse into both. Neat fact: the preorder of the mirror is exactly the reverse of the original's postorder.` },
    { id: "right-side-view", name: "Right Side View", tags: "BFS, last per level", w: "nodes",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12)), ui: tUI(),
      text: "Standing to the right of the tree, which nodes can you see? Select them.",
      ans: (I) => levels(I.T).map((l) => l[l.length - 1]),
      why: () => `Exactly one node per level is visible: the last one BFS meets on that level. A DFS visiting right before left that records the first node at each new depth also works.` },
    { id: "bottom-left-value", name: "Bottom-Left Value", tags: "BFS", w: "nodes",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12)), ui: tUI(() => ({ k: 1 })),
      text: "Select the leftmost node on the deepest level.",
      ans: (I) => { const l = levels(I.T); return [l[l.length - 1][0]]; },
      why: () => `BFS right-to-left: the very last node dequeued is the answer, with no level bookkeeping at all.` },

    /* ----- shape and paths ----- */
    num({ id: "tree-height", name: "Maximum Depth", tags: "Recursion",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 13)),
      text: (I) => `How many nodes are on the longest root-to-leaf path?${figT(I)}`, ans: (I) => height(I.T) + 1,
      why: () => `depth(node) = 1 + max(depth(left), depth(right)), with depth(empty) = 0.` }),
    num({ id: "min-depth", name: "Minimum Depth", tags: "BFS to first leaf",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 13)),
      text: (I) => `How many nodes are on the <b>shortest</b> path from the root to a <b>leaf</b>?${figT(I)}`, ans: (I) => Math.min(...leaves(I.T).map((v) => I.T.dep[v])) + 1,
      reject: (I, s) => s === 1 || s === height(I.T) + 1,
      why: () => `BFS stops at the first leaf. With recursion, careful: a node with one child is not a leaf, so min(left, right) over an empty side would be wrong.` }),
    { id: "diameter", name: "Diameter of a Binary Tree", tags: "Height recursion", w: "npath", vname: "a length of",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13)), ui: tUI(),
      text: "Trace the longest path (in edges) between any two nodes.",
      val: (I, p) => p.length - 1,
      why: () => `For each node, the longest path bending there is height(left) + height(right). Compute heights bottom-up and keep the best sum: one O(n) pass.` },
    { id: "max-path-sum", name: "Binary Tree Maximum Path Sum", tags: "Tree DP", w: "npath", vname: "a sum of",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12), { vals: smallV(-9, 9) }), ui: tUI(),
      text: "Trace a path (at least two nodes, never visiting a node twice) with the largest possible sum of values.",
      val: (I, p) => sum(pathVals(I.T, p)),
      why: () => `gain(v) = val(v) + max(0, gain(left), gain(right)) is the best downward path from v. The best path bending at v is val + max(0, gain(L)) + max(0, gain(R)).` },
    { id: "path-sum", name: "Path Sum", tags: "DFS with running total", w: "npath",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 6, 9, 12), { vals: smallV(1, 9) }); if (!I) return null; const lf = R.pick(leaves(I.T)); return { ...I, leaf: lf, target: sum(pathVals(I.T, anc(I.T, lf))) }; },
      ui: tUI(() => ({ start: 0 })),
      text: (I) => `Trace a path from the root down to a <b>leaf</b> whose values add up to <b>${I.target}</b>.`,
      accept: (I, p) => (!isLeaf(I.T, p[p.length - 1]) ? "the path must end at a leaf" : sum(pathVals(I.T, p)) !== I.target ? `that sums to ${sum(pathVals(I.T, p))}` : true),
      ans: (I) => anc(I.T, I.leaf).reverse(),
      why: () => `DFS carrying the remaining target; at a leaf, check whether it reached exactly zero.` },
    { id: "max-root-leaf", name: "Best Root-to-Leaf Path", tags: "DFS", w: "npath", vname: "a sum of",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12), { vals: smallV(-9, 9) }), ui: tUI(() => ({ start: 0 })),
      text: "Trace a root-to-leaf path with the largest sum of values.",
      valid: (I, p) => isLeaf(I.T, p[p.length - 1]) || "end at a leaf", val: (I, p) => sum(pathVals(I.T, p)),
      why: () => `best(v) = val(v) + max over children of best(child). Watch out: you must end at a leaf, so a negative child sum cannot simply be dropped.` },
    num({ id: "sum-root-leaf-numbers", name: "Sum Root-to-Leaf Numbers", tags: "DFS carrying a number",
      gen: (lv, R) => gBin(R, L3(lv, 4, 6, 8), { vals: smallV(1, 9), maxD: 3 }),
      text: (I) => `Each root-to-leaf path spells a number (root digit first). What is the sum of all those numbers?${figT(I)}`,
      ans: (I) => sum(leaves(I.T).map((l) => +pathVals(I.T, anc(I.T, l).reverse()).join(""))),
      why: () => `Pass cur = cur × 10 + digit down the recursion and add cur at each leaf.` }),
    { id: "longest-univalue-path", name: "Longest Univalue Path", tags: "Tree DP", w: "npath", vname: "a length of",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13), { vals: smallV(1, L3(lv, 2, 2, 3)) }), ui: tUI(),
      text: "Trace the longest path (in edges) on which every node has the <b>same</b> value.",
      valid: (I, p) => p.every((v) => I.T.val[v] === I.T.val[p[0]]) || "all values on the path must be equal", val: (I, p) => p.length - 1,
      reject: (I, s) => s.length < 3,
      why: () => `For each node, arm(v) = 1 + arm(child) for children with the same value. A path bends at one node: combine its left and right arms.` },
    { id: "longest-consecutive-path", name: "Longest Consecutive Path (downward)", tags: "DFS with run length", w: "npath", vname: "a length of",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13), { vals: smallV(1, 9) }); if (!I) return null; I.T.bfs.forEach((v) => { if (v !== I.T.root && R.chance(0.5)) I.T.val[v] = I.T.val[I.T.par[v]] + 1; }); return I; },
      ui: tUI(),
      text: "Trace the longest path going <b>down</b> the tree where each value is exactly one more than its parent's.",
      valid: (I, p) => p.slice(1).every((v, i) => I.T.par[v] === p[i] && I.T.val[v] === I.T.val[p[i]] + 1) || "each step must go down to a child with value + 1", val: (I, p) => p.length,
      reject: (I, s) => s.length < 3,
      why: () => `DFS passing the current run length: if child = parent + 1 extend it, otherwise restart at 1.` },
    { id: "smallest-from-leaf", name: "Smallest String Starting From Leaf", tags: "DFS + string comparison", w: "npath",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 6, 9, 12), { vals: (R2) => R2.pick("abcd".slice(0, L3(lv, 3, 3, 4)).split("")) }); if (!I) return null; const ss = leaves(I.T).map((l) => pathVals(I.T, anc(I.T, l)).join("")).sort(); return ss[0] === ss[1] ? null : I; },
      ui: tUI((I) => ({ end: I.T.root })),
      text: "Every leaf-to-root path spells a word (leaf letter first). Trace the path from a leaf up to the root that spells the alphabetically smallest word.",
      ans: (I) => { let best = null, bp = null; leaves(I.T).forEach((l) => { const p = anc(I.T, l), s = pathVals(I.T, p).join(""); if (best == null || s < best) { best = s; bp = p; } }); return bp; },
      why: () => `Build each word at the leaf and compare. Greedy "smallest child first" fails because a shorter word ("ab") beats a longer one starting the same way ("abz…").` },

    /* ----- ancestors ----- */
    { id: "lowest-common-ancestor", name: "Lowest Common Ancestor", tags: "Recursion", w: "nodes",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13)); if (!I) return null; return { ...I, mark: R.sample(U.range(I.T.n), 2).sort((a, b) => a - b) }; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `Select the lowest common ancestor of <b>${I.T.val[I.mark[0]]}</b> and <b>${I.T.val[I.mark[1]]}</b> (outlined). A node counts as its own ancestor.`,
      ans: (I) => [lca(I.T, ...I.mark)], reject: (I, s) => s[0] === I.T.root && I.T.n > 7,
      why: () => `Recurse: if the node is one of the targets, return it; otherwise ask both subtrees. If both return something, this node is the LCA; else pass up whichever side found something.` },
    { id: "lca-of-three", name: "LCA of Several Nodes", tags: "Recursion", w: "nodes",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 8, 11, 14)); if (!I) return null; return { ...I, mark: R.sample(U.range(I.T.n), 3).sort((a, b) => a - b) }; },
      ui: tUI(() => ({ k: 1 })),
      text: "Select the deepest node that is an ancestor of all three outlined nodes (a node counts as its own ancestor).",
      ans: (I) => [I.mark.reduce((a, b) => lca(I.T, a, b))], reject: (I, s) => s[0] === I.T.root,
      why: () => `The same recursion works for any set: a node is the answer when targets are found in two or more of (itself, left, right). Or fold pairwise: LCA(a, b, c) = LCA(LCA(a, b), c).` },
    { id: "lca-deepest-leaves", name: "LCA of Deepest Leaves", tags: "Height recursion", w: "nodes",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13)), ui: tUI(() => ({ k: 1 })),
      text: "Select the lowest node whose subtree contains <b>all</b> of the deepest nodes.",
      ans: (I) => { const md = height(I.T); return [I.T.bfs.filter((v) => I.T.dep[v] === md).reduce((a, b) => lca(I.T, a, b))]; },
      why: () => `Return (height, answer) from each subtree: if both heights are equal this node is the answer; otherwise pass up the deeper side's answer.` },
    { id: "kth-ancestor", name: "k-th Ancestor", tags: "Binary lifting", w: "nodes",
      gen: (lv, R) => { const I = gTree(R, L3(lv, 8, 12, 15), { maxD: L3(lv, 3, 4, 5), maxCh: 2 }); if (!I) return null; const k = L3(lv, 2, 3, 3); const c = U.range(I.T.n).filter((v) => I.T.dep[v] >= k); return c.length ? { ...I, mark: [R.pick(c)], k } : null; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `Select the ancestor exactly <b>${I.k}</b> levels above node <b>${LT[I.mark[0]]}</b> (outlined).`,
      ans: (I) => [anc(I.T, I.mark[0])[I.k]],
      why: () => `For many queries, binary lifting stores up[j][v] = the 2^j-th ancestor. Any k is a sum of powers of two, so a query takes O(log n) jumps.` },
    { id: "cousins", name: "Cousins in a Binary Tree", tags: "BFS with parents", w: "nodes",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 8, 11, 14)); if (!I) return null; return { ...I, mark: [R.pick(U.range(I.T.n).filter((v) => I.T.dep[v] >= 2))] }; },
      ui: tUI(),
      text: (I) => `Select every <b>cousin</b> of ${I.T.val[I.mark[0]]}: nodes at the same depth with a different parent.`,
      ans: (I) => { const x = I.mark[0]; return U.range(I.T.n).filter((v) => I.T.dep[v] === I.T.dep[x] && I.T.par[v] !== I.T.par[x]); },
      reject: (I, s) => !s.length,
      why: () => `BFS records depth and parent; cousins share the depth but not the parent (siblings are not cousins).` },
    { id: "distance-k", name: "All Nodes Distance k", tags: "Tree as a graph + BFS", w: "nodes",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 8, 11, 14)); if (!I) return null; return { ...I, mark: [R.int(0, I.T.n - 1)], k: L3(lv, 2, 2, 3) }; },
      ui: tUI(),
      text: (I) => `Select every node exactly <b>${I.k}</b> edges away from ${I.T.val[I.mark[0]]} (outlined). Paths may go up through parents.`,
      ans: (I) => { const d = distFrom(I.T, I.mark[0]); return U.range(I.T.n).filter((v) => d[v] === I.k); }, reject: (I, s) => s.length < 2,
      why: () => `Add parent pointers so the tree becomes an undirected graph, then BFS ${"k"} layers out from the target.` },
    num({ id: "burn-tree", name: "Time to Burn a Tree", tags: "BFS from the start node",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13)); if (!I) return null; return { ...I, mark: [R.int(1, I.T.n - 1)] }; },
      text: (I) => `A fire starts at ${I.T.val[I.mark[0]]} (outlined) and each minute spreads to neighbouring nodes (parent and children). How many minutes until the whole tree burns?${figT(I, { cls: markCls(I) })}`,
      ans: (I) => Math.max(...distFrom(I.T, I.mark[0])),
      why: () => `The answer is the eccentricity of the start: the largest BFS distance from it once parent edges are treated as undirected.` }),
    num({ id: "max-ancestor-diff", name: "Max Difference Between Node and Ancestor", tags: "DFS carrying min and max",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12)),
      text: (I) => `What is the largest |a − b| where a is an ancestor of b?${figT(I)}`,
      ans: (I) => Math.max(...U.range(I.T.n).flatMap((v) => anc(I.T, v).map((a) => Math.abs(I.T.val[a] - I.T.val[v])))),
      why: () => `Pass the min and max seen on the path from the root; at every node, the best difference ending there is max − min of that path.` }),
    { id: "good-nodes", name: "Count Good Nodes", tags: "DFS carrying the path max", w: "nodes",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12), { vals: smallV(1, 9) }), ui: tUI(),
      text: "A node is <b>good</b> if no node on the path from the root to it has a larger value. Select all good nodes.",
      ans: (I) => U.range(I.T.n).filter((v) => anc(I.T, v).every((a) => I.T.val[a] <= I.T.val[v])),
      why: () => `DFS carrying the maximum so far on the root path; a node is good when its value ≥ that maximum.` },

    /* ----- subtree computations ----- */
    { id: "unbalanced-nodes", name: "Where Is It Unbalanced?", tags: "Height recursion", w: "nodes",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13), { maxD: L3(lv, 4, 5, 5) }), ui: tUI(),
      text: "A node is <b>unbalanced</b> when the heights of its left and right subtrees differ by more than 1. Select every unbalanced node.",
      ans: (I) => U.range(I.T.n).filter((v) => Math.abs(bal(I.T, v)) > 1), reject: (I, s) => !s.length,
      why: () => `One post-order pass returns each subtree's height and checks |h(L) − h(R)| ≤ 1. Calling height() separately at every node would be O(n²).` },
    { id: "max-subtree-sum", name: "Maximum Subtree Sum", tags: "Post-order", w: "nodes", vname: "a sum of",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13), { vals: smallV(-9, 9) }), ui: tUI(() => ({ k: 1 })),
      text: "A subtree is a node plus all its descendants. Select the node whose subtree has the largest sum.",
      val: (I, [v]) => subSum(I.T, v),
      why: () => `sum(v) = val + sum(left) + sum(right): every subtree sum in one post-order pass.` },
    { id: "subtree-average", name: "Nodes Equal to Subtree Average", tags: "Post-order (sum, count)", w: "nodes",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13), { vals: smallV(0, 9) }), ui: tUI(),
      text: "Select every node whose value equals the average of its subtree, rounded down (a node's subtree includes itself).",
      ans: (I) => U.range(I.T.n).filter((v) => I.T.val[v] === Math.floor(subSum(I.T, v) / sub(I.T, v).length)),
      reject: (I, s) => s.every((v) => isLeaf(I.T, v)),
      why: () => `Return (sum, count) from each subtree in post-order; leaves always qualify.` },
    num({ id: "tree-tilt", name: "Binary Tree Tilt", tags: "Post-order sums",
      gen: (lv, R) => gBin(R, L3(lv, 5, 8, 11), { vals: smallV(1, 9) }),
      text: (I) => `A node's tilt is |sum of its left subtree − sum of its right subtree| (an empty subtree sums to 0). What is the total tilt of all nodes?${figT(I)}`,
      ans: (I) => sum(U.range(I.T.n).map((v) => Math.abs((I.T.L[v] >= 0 ? subSum(I.T, I.T.L[v]) : 0) - (I.T.R[v] >= 0 ? subSum(I.T, I.T.R[v]) : 0)))),
      why: () => `The same post-order that returns subtree sums can add |left − right| to a global total.` }),
    num({ id: "most-frequent-subtree-sum", name: "Most Frequent Subtree Sum", tags: "Post-order + hash map",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 6, 9, 12), { vals: smallV(-3, 5) }); if (!I) return null; const m = H.cnt(U.range(I.T.n).map((v) => subSum(I.T, v))); const top = Math.max(...m.values()); return [...m.values()].filter((c) => c === top).length === 1 && top > 1 ? I : null; },
      text: (I) => `Compute the sum of every subtree. Which sum occurs most often?${figT(I)}`,
      ans: (I) => { const m = H.cnt(U.range(I.T.n).map((v) => subSum(I.T, v))); return [...m].sort((a, b) => b[1] - a[1])[0][0]; },
      why: () => `Post-order sums fed into a frequency map; one pass.` }),
    num({ id: "deepest-leaves-sum", name: "Deepest Leaves Sum", tags: "BFS",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12), { vals: smallV(1, 20) }),
      text: (I) => `What is the sum of the values on the deepest level?${figT(I)}`,
      ans: (I) => { const l = levels(I.T); return sum(l[l.length - 1].map((v) => I.T.val[v])); },
      why: () => `BFS level by level; the last level's sum is the answer.` }),
    num({ id: "max-level-sum", name: "Level With Maximum Sum", tags: "BFS",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13), { vals: smallV(-9, 9) }); if (!I) return null; const s = levels(I.T).map((l) => sum(l.map((v) => I.T.val[v]))); return s.filter((x) => x === Math.max(...s)).length === 1 ? I : null; },
      text: (I) => `The root is on level 1. Which level has the largest sum of values?${figT(I)}`,
      ans: (I) => { const s = levels(I.T).map((l) => sum(l.map((v) => I.T.val[v]))); return s.indexOf(Math.max(...s)) + 1; },
      why: () => `BFS, summing each level; deeper levels are not automatically larger once values can be negative.` }),
    num({ id: "max-width", name: "Maximum Width of a Binary Tree", tags: "BFS with heap indices",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12)),
      text: (I) => `The width of a level is the distance between its leftmost and rightmost nodes, counting the gaps where missing nodes would be in a complete tree. What is the maximum width?${figT(I)}`,
      ans: (I) => { const pos = []; pos[I.T.root] = 0; I.T.bfs.forEach((v) => { if (I.T.L[v] >= 0) pos[I.T.L[v]] = 2 * pos[v]; if (I.T.R[v] >= 0) pos[I.T.R[v]] = 2 * pos[v] + 1; }); return Math.max(...levels(I.T).map((l) => pos[l[l.length - 1]] - pos[l[0]] + 1)); },
      reject: (I, s) => s === Math.max(...levels(I.T).map((l) => l.length)),
      why: () => `Number nodes like a heap: children of i are 2i and 2i + 1. Width = last index − first index + 1 per level (re-base indices each level to avoid overflow).` }),
    num({ id: "sum-left-leaves", name: "Sum of Left Leaves", tags: "DFS",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12), { vals: smallV(1, 20) }),
      text: (I) => `What is the sum of all leaves that are the <b>left</b> child of their parent?${figT(I)}`,
      ans: (I) => sum(U.range(I.T.n).filter((v) => isLeaf(I.T, v) && I.T.par[v] >= 0 && I.T.L[I.T.par[v]] === v).map((v) => I.T.val[v])),
      why: () => `Check from the parent: if left child exists and has no children, add it.` }),
    num({ id: "univalue-subtrees", name: "Count Univalue Subtrees", tags: "Post-order",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12), { vals: smallV(1, L3(lv, 2, 2, 3)) }),
      text: (I) => `How many subtrees (a node with all its descendants) have every value equal?${figT(I)}`,
      ans: (I) => U.range(I.T.n).filter((v) => sub(I.T, v).every((u) => I.T.val[u] === I.T.val[v])).length,
      why: () => `Post-order returns "is my subtree univalue?"; a node qualifies when both children do and match its value. Leaves always count.` }),
    num({ id: "pseudo-palindromic-paths", name: "Pseudo-Palindromic Paths", tags: "DFS + parity bitmask",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13), { vals: smallV(1, 3) }),
      text: (I) => `How many root-to-leaf paths have values that could be rearranged into a palindrome?${figT(I)}`,
      ans: (I) => leaves(I.T).filter((l) => [...H.cnt(pathVals(I.T, anc(I.T, l))).values()].filter((c) => c % 2).length <= 1).length,
      why: () => `Keep a bitmask of digit parities along the path (XOR on the way down). At a leaf, a palindrome is possible iff mask has at most one bit: mask & (mask − 1) === 0.` }),
    num({ id: "path-sum-iii", name: "Path Sum III", tags: "Prefix sums on a tree",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13), { vals: smallV(-3, 6) }); if (!I) return null; const v = R.int(0, I.T.n - 1), a = anc(I.T, v), k = R.int(1, Math.min(3, a.length)); return { ...I, target: sum(a.slice(0, k).map((u) => I.T.val[u])) }; },
      text: (I) => `How many paths that only go <b>downward</b> (they may start and end anywhere) have values summing to <b>${I.target}</b>?${figT(I)}`,
      ans: (I) => { let c = 0; U.range(I.T.n).forEach((v) => { let s = 0; for (const a of anc(I.T, v)) { s += I.T.val[a]; if (s === I.target) c++; } }); return c; },
      why: () => `DFS with a map of prefix sums on the current root path: at each node add count[prefix − target], then recurse, then undo. O(n) instead of O(n²).` }),
    num({ id: "good-leaf-pairs", name: "Number of Good Leaf Pairs", tags: "Post-order distance counts",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13)); if (!I) return null; return { ...I, d: L3(lv, 3, 3, 4) }; },
      text: (I) => `How many pairs of leaves are at most <b>${I.d}</b> edges apart?${figT(I)}`,
      ans: (I) => { const ls = leaves(I.T); let c = 0; ls.forEach((a, i) => { const d = distFrom(I.T, a); ls.slice(i + 1).forEach((b) => { if (d[b] <= I.d) c++; }); }); return c; },
      why: () => `Each node returns how many leaves are at each distance below it; pairs meeting at that node combine left and right counts with total ≤ d.` }),
    num({ id: "min-swaps-levels", name: "Minimum Swaps to Sort Each Level", tags: "BFS + cycle decomposition",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 14)),
      text: (I) => `On each level you may swap values of any two nodes. What is the fewest swaps to make every level strictly increasing left to right?${figT(I)}`,
      ans: (I) => sum(levels(I.T).map((l) => minSwaps(l.map((v) => I.T.val[v])))),
      reject: (I, s) => s < 2,
      why: () => `For one array, sort it and look at where each element must go: that permutation splits into cycles, and a cycle of length c needs c − 1 swaps.` }),
    { id: "find-leaves", name: "Find Leaves of a Binary Tree", tags: "Height from the bottom", w: "groups",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12)),
      ui: (I) => ({ ...ordUI(I), k: height(I.T) + 1, names: U.range(height(I.T) + 1).map((k) => "Round " + (k + 1)), style: "tiles" }),
      text: (I) => `Repeatedly remove all current leaves. Assign each value to the round in which it is removed.${figT(I)}`,
      ans: (I) => chipOrder(I.T).map((v) => hN(I.T, v) - 1),
      why: () => `A node disappears in round = its height measured from the bottom (leaf = 1). One post-order pass computes it, no simulation needed.` },

    /* ----- tree DP ----- */
    { id: "house-robber-iii", name: "House Robber III", tags: "Tree DP (take / skip)", w: "nodes", vname: "a haul of",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13), { vals: smallV(1, 20) }), ui: tUI(),
      text: "Houses form a tree. Rob a set of houses with no two directly connected (parent and child), maximising the total.",
      valid: (I, s) => !s.some((a) => s.some((b) => adjacent(I.T, a, b))) || "two connected houses are both robbed", val: (I, s) => sum(s.map((v) => I.T.val[v])),
      why: () => `Each node returns (best if robbed, best if not). robbed = val + notL + notR; not = max(L) + max(R).` },
    { id: "tree-cameras", name: "Binary Tree Cameras", tags: "Greedy from the leaves", w: "nodes", sense: "min", vname: "cameras:",
      gen: (lv, R) => gBin(R, L3(lv, 7, 10, 13)), ui: tUI(),
      text: "A camera watches its node, its parent and its children. Place the fewest cameras so every node is watched.",
      valid: (I, s) => U.range(I.T.n).every((v) => s.includes(v) || nb(I.T, v).some((u) => s.includes(u))) || "some node is not watched", val: (I, s) => s.length,
      why: () => `Greedy bottom-up: never put a camera on a leaf; put one on the parent of any unwatched leaf. States per node: needs cover / has camera / covered.` },
    { id: "vertex-cover-tree", name: "Minimum Vertex Cover of a Tree", tags: "Tree DP", w: "nodes", sense: "min", vname: "a cover of",
      gen: (lv, R) => gTree(R, L3(lv, 7, 10, 13)), ui: tUI(),
      text: "Select the fewest nodes so that every edge has at least one selected endpoint.",
      valid: (I, s) => U.range(I.T.n).every((v) => I.T.par[v] < 0 || s.includes(v) || s.includes(I.T.par[v])) || "an edge is uncovered", val: (I, s) => s.length,
      why: () => `NP-hard in general graphs, easy on trees: in(v) = 1 + Σ min(in, out)(child), out(v) = Σ in(child). Or greedily take the parent of every uncovered leaf edge.` },
    { id: "distribute-coins", name: "Distribute Coins in a Binary Tree", tags: "Post-order excess", w: "num",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 5, 7, 10)); if (!I) return null; const n = I.T.n, c = Array(n).fill(0); for (let i = 0; i < n; i++) c[R.int(0, n - 1)]++; I.T.val = c; return I; },
      text: (I) => `The labels are coins (there are as many coins as nodes). A move passes one coin between neighbours. What is the fewest moves to give every node exactly one coin?${figT(I)}`,
      ans: (I) => sum(U.range(I.T.n).filter((v) => v !== I.T.root).map((v) => Math.abs(subSum(I.T, v) - sub(I.T, v).length))),
      why: () => `Every edge must carry |coins − nodes| of the subtree below it, no more and no less. Sum that excess over all edges in one post-order pass.` },
    { id: "max-product-split", name: "Maximum Product of Split Tree", tags: "Subtree sums", w: "edges", vname: "a product of",
      gen: (lv, R) => gBin(R, L3(lv, 6, 9, 12), { vals: smallV(1, 9) }), ui: tUI(() => ({ k: 1 })),
      text: "Cut one edge to split the tree in two. Maximise the product of the two parts' sums.",
      val: (I, [k]) => { const s = subSum(I.T, I.G.edges[k].v), t = subSum(I.T, I.T.root); return s * (t - s); },
      why: () => `Cutting above v gives parts sum(v) and total − sum(v). Compute all subtree sums once, then pick the one closest to total / 2.` },
    num({ id: "collect-apples", name: "Minimum Time to Collect All Apples", tags: "Subtree contains an apple",
      gen: (lv, R) => { const I = gTree(R, L3(lv, 7, 10, 13)); if (!I) return null; return { ...I, mark: R.sample(U.range(I.T.n - 1).map((x) => x + 1), L3(lv, 2, 3, 4)).sort((a, b) => a - b) }; },
      text: (I) => `Start at <b>A</b>, collect the apples on the outlined nodes, and return to A. Each edge takes 1 second. What is the minimum time?${figT(I, { cls: markCls(I) })}`,
      ans: (I) => 2 * U.range(I.T.n).filter((v) => v !== I.T.root && sub(I.T, v).some((u) => I.mark.includes(u))).length,
      why: () => `An edge must be walked (twice: down and back) exactly when the subtree below it contains an apple.` }),
    { id: "coloring-game", name: "Binary Tree Colouring Game", tags: "Component sizes", w: "nodes", vname: "nodes won:",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13)); if (!I) return null; return { ...I, mark: [R.int(0, I.T.n - 1)] }; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `Your opponent coloured ${I.T.val[I.mark[0]]} (outlined). You pick a <b>neighbour</b> of it; then you take turns colouring uncoloured neighbours of your own colour. Which neighbour wins you the most nodes?`,
      valid: (I, [y]) => adjacent(I.T, y, I.mark[0]) || "pick a neighbour of the opponent's node",
      val: (I, [y]) => { const x = I.mark[0]; return y === I.T.par[x] ? I.T.n - sub(I.T, x).length : sub(I.T, y).length; },
      why: () => `Removing x splits the tree into at most three regions: left subtree, right subtree, and everything above. Taking the neighbour into the biggest region seals all of it for you.` },
    { id: "best-meeting-node", name: "Best Meeting Point on a Tree", tags: "Weighted median / rerooting", w: "nodes", sense: "min", vname: "a total distance of",
      gen: (lv, R) => gTree(R, L3(lv, 7, 10, 13), { vals: smallV(0, 5) }), ui: tUI(() => ({ k: 1 })),
      text: "Labels show how many people live at each node. Pick the meeting node that minimises the total walking distance (edges) of everyone.",
      val: (I, [v]) => { const d = distFrom(I.T, v); return sum(U.range(I.T.n).map((u) => d[u] * I.T.val[u])); },
      why: () => `Rerooting: moving the meeting point across an edge changes the total by (people behind) − (people ahead). The optimum is a weighted median: no side holds more than half the people.` },
    { id: "tree-center", name: "Minimum Height Trees", tags: "Peel leaves layer by layer", w: "nodes",
      gen: (lv, R) => gTree(R, L3(lv, 7, 10, 14)), ui: tUI(),
      text: "Treat the edges as undirected. Select every node that, chosen as the root, gives the smallest possible height.",
      ans: (I) => { const e = U.range(I.T.n).map((v) => Math.max(...distFrom(I.T, v))), m = Math.min(...e); return U.range(I.T.n).filter((v) => e[v] === m); },
      reject: (I, s) => s.includes(I.T.root),
      why: () => `Repeatedly strip all current leaves (like topological sort). The last one or two nodes are the centres, the midpoint(s) of a diameter.` },
    { id: "tree-centroid", name: "Centroid of a Tree", tags: "Subtree sizes", w: "nodes",
      gen: (lv, R) => gTree(R, L3(lv, 7, 10, 14)), ui: tUI(),
      text: "A centroid is a node whose removal leaves pieces of at most n / 2 nodes each. Select every centroid.",
      ans: (I) => U.range(I.T.n).filter((v) => Math.max(I.T.n - sub(I.T, v).length, ...I.T.ch[v].map((c) => sub(I.T, c).length)) <= I.T.n / 2),
      reject: (I, s) => s.includes(I.T.root),
      why: () => `Compute subtree sizes; from the root, keep stepping into a child with size > n / 2. Centroid decomposition recurses on the pieces, giving depth O(log n).` },
    { id: "weighted-diameter", name: "Weighted Diameter", tags: "Two DFS passes", w: "npath", vname: "a length of",
      gen: (lv, R) => gTree(R, L3(lv, 6, 9, 12), { weighted: true }), ui: tUI(),
      text: "Edge labels are lengths. Trace the longest path between any two nodes.",
      val: (I, p) => sum(p.slice(1).map((v, i) => ew(I, p[i], v))),
      why: () => `With non-negative weights: DFS from anywhere to the farthest node u, then DFS from u; the farthest from u is the other end of a diameter.` },

    /* ----- binary search trees ----- */
    { id: "bst-kth-smallest", name: "k-th Smallest in a BST", tags: "Inorder", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 6, 9, 12)); if (!I) return null; return { ...I, k: R.int(2, I.T.n - 1) }; }, ui: tUI(() => ({ k: 1 })),
      text: (I) => `This is a binary search tree. Select the <b>${U.ordinal(I.k)}</b> smallest value.`,
      ans: (I) => [inO(I.T)[I.k - 1]],
      why: () => `Inorder of a BST is sorted; stop after k nodes. Storing subtree sizes lets you answer in O(height).` },
    { id: "bst-lca", name: "LCA in a BST", tags: "Split point", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; return { ...I, mark: R.sample(U.range(I.T.n), 2).sort((a, b) => a - b) }; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `In this BST, select the lowest common ancestor of <b>${I.T.val[I.mark[0]]}</b> and <b>${I.T.val[I.mark[1]]}</b>.`,
      ans: (I) => [lca(I.T, ...I.mark)], reject: (I, s) => s[0] === I.T.root && I.T.n > 7,
      why: () => `Walk down from the root: if both values are smaller go left, both larger go right; otherwise you've reached the split point, the LCA. O(height), no recursion over both sides.` },
    { id: "bst-insert-parent", name: "Insert Into a BST", tags: "Walk down", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; let x; do x = R.int(1, 99); while (I.T.val.includes(x)); return { ...I, x }; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `Insert <b>${I.x}</b> into this BST. Select the node that becomes its parent.`,
      ans: (I) => { const T = bst([...I.T.val, I.x]); return [T.par[T.n - 1]]; },
      why: () => `Compare and step left or right until the needed child slot is empty. New keys always become leaves.` },
    { id: "bst-delete", name: "Delete From a BST", tags: "In-order successor", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; const c = U.range(I.T.n).filter((v) => I.T.L[v] >= 0 && I.T.R[v] >= 0); return c.length ? { ...I, mark: [R.pick(c)] } : null; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `Delete <b>${I.T.val[I.mark[0]]}</b> (outlined, it has two children) using the in-order <b>successor</b>. Which node's value moves into its place?`,
      ans: (I) => { let v = I.T.R[I.mark[0]]; while (I.T.L[v] >= 0) v = I.T.L[v]; return [v]; },
      why: () => `The successor is the leftmost node of the right subtree. It has no left child, so removing it from its old spot is easy.` },
    { id: "bst-successor", name: "In-order Successor in a BST", tags: "Right subtree or ancestor", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; const io = inO(I.T); const c = io.slice(0, -1).filter((v) => lv === 1 || I.T.R[v] < 0); return c.length ? { ...I, mark: [R.pick(c)] } : null; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `Select the node holding the next larger value after <b>${I.T.val[I.mark[0]]}</b>.`,
      ans: (I) => { const io = inO(I.T); return [io[io.indexOf(I.mark[0]) + 1]]; },
      why: () => `If the node has a right child: leftmost node of that subtree. Otherwise: the lowest ancestor whose left subtree contains the node (walk from the root, remembering the last time you went left).` },
    { id: "bst-floor", name: "Floor in a BST", tags: "Walk down, remember candidate", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; let x; do x = R.int(Math.min(...I.T.val) + 1, 99); while (I.T.val.includes(x)); return { ...I, x }; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `Select the largest value that is ≤ <b>${I.x}</b>.`,
      ans: (I) => { const c = U.range(I.T.n).filter((v) => I.T.val[v] <= I.x); return [c.reduce((a, b) => (I.T.val[a] > I.T.val[b] ? a : b))]; },
      why: () => `Walk from the root: if node ≤ x it's a candidate, go right for a bigger one; otherwise go left. O(height).` },
    { id: "bst-closest", name: "Closest Value in a BST", tags: "Walk down", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; for (let t = 0; t < 30; t++) { const x = R.int(1, 99); if (I.T.val.includes(x)) continue; const d = I.T.val.map((v) => Math.abs(v - x)), m = Math.min(...d); if (d.filter((y) => y === m).length === 1) return { ...I, x }; } return null; },
      ui: tUI(() => ({ k: 1 })),
      text: (I) => `Select the value closest to <b>${I.x}</b>.`,
      ans: (I) => { const d = I.T.val.map((v) => Math.abs(v - I.x)); return [d.indexOf(Math.min(...d))]; },
      why: () => `Only nodes on the search path for x can be closest. Walk down once tracking the best.` },
    { id: "two-sum-bst", name: "Two Sum in a BST", tags: "Inorder + two pointers", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; const [a, b] = R.sample(U.range(I.T.n), 2); return { ...I, target: I.T.val[a] + I.T.val[b], pair: [a, b].sort((x, y) => x - y) }; },
      ui: tUI(() => ({ k: 2 })),
      text: (I) => `Select two nodes whose values add up to <b>${I.target}</b>.`,
      accept: (I, s) => I.T.val[s[0]] + I.T.val[s[1]] === I.target || `those add to ${I.T.val[s[0]] + I.T.val[s[1]]}`,
      ans: (I) => I.pair,
      why: () => `Inorder gives a sorted list, then two pointers from both ends. Two BST iterators (one forward, one reverse) do it in O(height) extra space.` },
    num({ id: "bst-range-sum", name: "Range Sum of a BST", tags: "Pruned DFS",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; const s = I.T.val.slice().sort((a, b) => a - b); const i = R.int(1, s.length - 3), j = R.int(i + 1, s.length - 2); return { ...I, lo: s[i] - R.int(0, 2), hi: s[j] + R.int(0, 2) }; },
      text: (I) => `What is the sum of all values between <b>${I.lo}</b> and <b>${I.hi}</b> inclusive?${figT(I)}`,
      ans: (I) => sum(I.T.val.filter((v) => v >= I.lo && v <= I.hi)),
      why: () => `DFS but skip a left subtree when node < lo, and a right subtree when node > hi: whole branches are pruned.` }),
    { id: "recover-bst", name: "Recover a Binary Search Tree", tags: "Inorder inversions", w: "nodes",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 6, 9, 12)); if (!I) return null; const [a, b] = R.sample(U.range(I.T.n), 2); [I.T.val[a], I.T.val[b]] = [I.T.val[b], I.T.val[a]]; return { ...I, sw: [a, b].sort((x, y) => x - y) }; },
      ui: tUI(() => ({ k: 2 })),
      text: "Two values in this BST were swapped by mistake. Select the two nodes to swap back.",
      ans: (I) => I.sw,
      why: () => `Inorder should be increasing. Find the descents: the first node of the first descent and the second node of the last descent are the swapped pair. Morris traversal does it in O(1) space.` },
    { id: "largest-bst-subtree", name: "Largest BST Subtree", tags: "Post-order (min, max, size)", w: "nodes", vname: "a size of",
      gen: (lv, R) => { const I = gBST(R, L3(lv, 7, 10, 13)); if (!I) return null; for (let k = 0; k < L3(lv, 1, 2, 2); k++) I.T.val[R.int(0, I.T.n - 1)] = R.int(1, 99); return isBSTsub(I.T, I.T.root) || H.distinct(I.T.val) < I.T.n ? null : I; },
      ui: tUI(() => ({ k: 1 })),
      text: "Select the root of the largest subtree (a node and all its descendants) that is a valid BST.",
      valid: (I, [v]) => isBSTsub(I.T, v) || "that subtree is not a BST", val: (I, [v]) => sub(I.T, v).length,
      why: () => `Post-order returns (isBST, min, max, size). A node is a BST root when both children are and left.max < val < right.min.` },
    { id: "avl-rotation", name: "Which AVL Rotation?", tags: "AVL trees", w: "choice",
      gen: (lv, R) => { const n = L3(lv, 4, 6, 9); for (let t = 0; t < 3000; t++) { const keys = R.distinct(n, 1, 60), T = bst(keys); if (!avlOK(T)) continue; const x = R.int(1, 60); if (keys.includes(x)) continue; const c = avlCase(keys, x); if (c) return { T, G: layout(T), x }; } return null; },
      ui: () => ({ opts: Object.values(AVL_OPTS) }),
      text: (I) => `This AVL tree is balanced. Insert <b>${I.x}</b>. Which rotation fixes the lowest node that becomes unbalanced?${figT(I)}`,
      ans: (I) => AVL_OPTS[avlCase(I.T.val, I.x).kind],
      why: (I) => { const c = avlCase(I.T.val, I.x); return `The lowest unbalanced node is ${I.T.val[c.node]}. Look at the first two steps from it toward the new key: ${c.kind[0] === "L" ? "left" : "right"}, then ${c.kind[1] === "L" ? "left" : "right"}. Same direction twice needs one rotation; a zig-zag needs two.`; } },
    num({ id: "unique-bsts", name: "Unique Binary Search Trees", tags: "Catalan numbers",
      gen: (lv) => ({ n: L3(lv, 3, 5, 7) }),
      text: (I) => `How many structurally different BSTs store the keys 1 … ${I.n}?`, ans: (I) => catalan(I.n),
      why: () => `Choose the root i: left uses i − 1 keys, right uses n − i. G(n) = Σ G(i − 1)·G(n − i), the Catalan numbers 1, 1, 2, 5, 14, 42, 132, 429…` }),
    num({ id: "bst-orderings", name: "Ways to Build the Same BST", tags: "Interleavings (binomials)",
      gen: (lv, R) => gBST(R, L3(lv, 4, 6, 7)),
      text: (I) => `In how many different insertion orders of these values do you get exactly this BST?${figT(I)}`,
      ans: (I) => { const T = I.T, w = (v) => (v < 0 ? 1 : binom(sub(T, v).length - 1, T.L[v] < 0 ? 0 : sub(T, T.L[v]).length) * w(T.L[v]) * w(T.R[v])); return w(T.root); },
      reject: (I, s) => s < 3,
      why: () => `The root must come first. The left and right sequences are independent and can be interleaved in C(size − 1, left size) ways, recursively.` }),
    { id: "balanced-insertion-order", name: "Insert for a Balanced BST", tags: "Recursive median", w: "order",
      gen: (lv, R) => ({ a: R.sorted(L3(lv, 7, 10, 15), 1, 99, true) }),
      text: (I) => `Click the keys in an insertion order that gives a BST of the smallest possible height (${Math.floor(Math.log2(I.a.length))} edges).`,
      accept: (I, o) => { const h = height(bst(o.map((i) => I.a[i]))); return h <= Math.floor(Math.log2(I.a.length)) || `that tree has height ${h}`; },
      ans: (I) => { const out = [], q = [[0, I.a.length - 1]]; for (let k = 0; k < q.length; k++) { const [l, r] = q[k]; if (l > r) continue; const m = (l + r) >> 1; out.push(m); q.push([l, m - 1], [m + 1, r]); } return out; },
      why: () => `Insert the median first, then (level by level) the medians of each half. Same idea as building a balanced BST from a sorted array.` },
    { id: "insertion-order-for-shape", name: "Rebuild This BST", tags: "Parents before children", w: "order",
      gen: (lv, R) => gBST(R, L3(lv, 6, 9, 12)), ui: ordUI,
      text: (I) => `Click the values in an insertion order that produces exactly this BST.${figT(I)}`,
      accept: (I, o) => { const T = bst(fromChips(I.T, o).map((v) => I.T.val[v])); const par = (Tt, x) => { const i = Tt.val.indexOf(x); return Tt.par[i] < 0 ? null : Tt.val[Tt.par[i]]; }; return I.T.val.every((x) => par(T, x) === par(I.T, x)) || "that builds a different tree"; },
      ans: (I) => toChips(I.T, I.T.bfs),
      why: () => `Any order that inserts each node after its parent works (BFS or preorder are two examples). Values in different subtrees never affect each other.` },
    { id: "build-pre-in", name: "Tree From Preorder and Inorder", tags: "Divide and conquer", w: "order",
      gen: (lv, R) => gBin(R, L3(lv, 5, 7, 9)), ui: ordUI,
      text: (I) => `A binary tree has preorder ${vlist(pathVals(I.T, preO(I.T)))} and inorder ${vlist(pathVals(I.T, inO(I.T)))}. Click its <b>postorder</b>.`,
      ans: (I) => toChips(I.T, postO(I.T)),
      why: () => `The first preorder value is the root; its position in the inorder splits left and right subtrees, then recurse. A hash map of inorder positions makes it O(n).` },
    { id: "build-post-in", name: "Tree From Postorder and Inorder", tags: "Divide and conquer", w: "order",
      gen: (lv, R) => gBin(R, L3(lv, 5, 7, 9)), ui: ordUI,
      text: (I) => `A binary tree has postorder ${vlist(pathVals(I.T, postO(I.T)))} and inorder ${vlist(pathVals(I.T, inO(I.T)))}. Click its <b>preorder</b>.`,
      ans: (I) => toChips(I.T, preO(I.T)),
      why: () => `The last postorder value is the root. Split the inorder around it and recurse (build the right subtree first when consuming postorder from the back).` },
    { id: "bst-from-preorder", name: "BST From Preorder", tags: "Bounds recursion / monotonic stack", w: "order",
      gen: (lv, R) => gBST(R, L3(lv, 6, 8, 10)), ui: ordUI,
      text: (I) => `A BST has preorder ${vlist(pathVals(I.T, preO(I.T)))}. Click its <b>postorder</b>.`,
      ans: (I) => toChips(I.T, postO(I.T)),
      why: () => `A BST's inorder is just the sorted keys, so preorder alone determines it. Recursing with (low, high) bounds builds it in O(n).` },
    { id: "serialize-tree", name: "Serialise a Binary Tree", tags: "Preorder with null markers", w: "choice",
      gen: (lv, R) => { const o = randNest(R, L3(lv, 4, 5, 7), 3, smallV(1, 9)); if (!o) return null; const s = serial(o); const cand = new Set([serial(mirror(o))]); const tweak = (x, f) => (x ? f(x) : x); cand.add(serial({ ...o, l: o.r, r: o.l })); cand.add(serial(tweak(o, (x) => ({ ...x, l: x.l ? { ...x.l, l: x.l.r, r: x.l.l } : x.l })))); cand.add(serial({ ...o, v: (o.v % 9) + 1 })); cand.add(serial({ v: o.v, l: o.l, r: null })); cand.delete(s); const opts = R.shuffle([s, ...R.shuffle([...cand]).slice(0, 3)]); if (opts.length < 4) return null; const T = fromNested(o); return { T, G: layout(T), opts, s }; },
      ui: (I) => ({ opts: I.opts }),
      text: (I) => `Which string is this tree's preorder serialisation (with # for an empty child)?${figT(I)}`,
      ans: (I) => I.s,
      why: () => `Preorder plus explicit null markers is enough to rebuild the tree uniquely: read a value, then recursively read its left and right subtrees.` },
    num({ id: "deserialize-height", name: "Deserialise a Binary Tree", tags: "Recursive parsing",
      gen: (lv, R) => { const o = randNest(R, L3(lv, 5, 7, 9), 4, smallV(1, 9)); return o ? { o, s: serial(o) } : null; },
      text: (I) => `This is a preorder serialisation with # for empty children: ${H.tt(I.s)}. How many nodes are on the longest root-to-leaf path?`,
      ans: (I) => height(fromNested(I.o)) + 1,
      why: () => `Read tokens recursively: a value creates a node and recurses twice; # returns null. Track the depth as you go.` }),

    /* ----- yes / no shape checks ----- */
    yn({ id: "is-complete", name: "Is the Tree Complete?", tags: "BFS: no node after a gap",
      gen: (lv, R) => { const n = L3(lv, 5, 8, 11); let pos = U.range(n).map((i) => i + 1); if (R.chance(0.55)) { const p = R.pick(U.range(n - 1).map((k) => n + 1 + k).filter((q) => pos.includes(q >> 1) && q >> 1 !== n)); pos = pos.slice(0, -1).concat(p || n); } const T = fromPos(pos); T.val = R.distinct(n, 1, 99); return { T, G: layout(T), pos }; },
      text: (I) => `Is this binary tree <b>complete</b> (every level full except possibly the last, which is filled from the left)?${figT(I)}`,
      ans: (I) => (Math.max(...I.pos) === I.pos.length ? "Yes" : "No"),
      why: () => `BFS including null children: once you meet a null, every later entry must also be null.` }),
    yn({ id: "is-symmetric", name: "Symmetric Tree", tags: "Mirror recursion",
      gen: (lv, R) => { const half = randNest(R, L3(lv, 2, 3, 4), 3, smallV(1, 4)); if (!half) return null; let o = { v: R.int(1, 9), l: half, r: mirror(half) }; if (R.chance(0.5)) { const r = JSON.parse(JSON.stringify(o.r)); let x = r; while (x.l || x.r) x = x.l && R.chance(0.5) ? x.l : x.r || x.l; if (R.chance(0.5)) x.v = (x.v % 4) + 1; else x[R.chance(0.5) ? "l" : "r"] = { v: x.v, l: null, r: null }; o = { ...o, r }; } const T = fromNested(o); return { o, T, G: layout(T) }; },
      text: (I) => `Is this tree a mirror image of itself around its centre?${figT(I)}`,
      ans: (I) => (symm(I.o.l, I.o.r) ? "Yes" : "No"),
      why: () => `mirror(a, b): both empty, or equal values and mirror(a.left, b.right) and mirror(a.right, b.left).` }),
    yn({ id: "flip-equivalent", name: "Flip Equivalent Trees", tags: "Canonical form",
      gen: (lv, R) => { const o = randNest(R, L3(lv, 5, 7, 9), 3, smallV(1, 9)); if (!o) return null; const flip = (x) => (x ? (R.chance(0.5) ? { v: x.v, l: flip(x.r), r: flip(x.l) } : { v: x.v, l: flip(x.l), r: flip(x.r) }) : null); let b = flip(o); if (R.chance(0.5)) { b = JSON.parse(JSON.stringify(b)); let x = b; while (x.l || x.r) x = x.l && R.chance(0.5) ? x.l : x.r || x.l; x.v = (x.v % 9) + 1; } return { a: o, b }; },
      text: (I) => { const A = fromNested(I.a), B = fromNested(I.b); return `A flip swaps the two children of a node. Can the left tree be turned into the right one by flips?<div class="figure camp-fig" style="display:flex;gap:16px;flex-wrap:wrap;justify-content:center">${C.svgGraph(layout(A), { label: lab(A) })}${C.svgGraph(layout(B), { label: lab(B) })}</div>`; },
      ans: (I) => (canon(I.a) === canon(I.b) ? "Yes" : "No"),
      why: () => `Compare recursively allowing either pairing of children, or compute a canonical form that sorts each node's two child encodings.` }),

    /* ----- heaps ----- */
    { id: "heap-k-smallest", name: "k Smallest From a Heap", tags: "Best-first frontier", w: "nodes",
      gen: (lv, R) => { const h = []; R.distinct(L3(lv, 7, 10, 13), 1, 99).forEach((x) => heapPush(h, x)); const T = heapTree(h); return { h, T, G: layout(T), k: L3(lv, 3, 4, 5) }; },
      ui: tUI((I) => ({ k: I.k })),
      text: (I) => `This is a min-heap. Without sorting everything, select the <b>${I.k}</b> smallest values.`,
      ans: (I) => I.h.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]).slice(0, I.k).map((x) => x[1]),
      why: () => `The k smallest always form a connected group containing the root. Pop from a small auxiliary heap seeded with the root and push each popped node's children: O(k log k), independent of the heap's size.` },
    num({ id: "dary-heap-parent", name: "Index Arithmetic in a d-ary Heap", tags: "Implicit trees",
      gen: (lv, R) => ({ d: L3(lv, 3, 4, 5), i: R.int(L3(lv, 10, 20, 40), L3(lv, 30, 60, 120)) }),
      text: (I) => `A ${I.d}-ary heap is stored in an array starting at index 0 (the children of i are ${I.d}i + 1 … ${I.d}i + ${I.d}). What is the index of the <b>grandparent</b> of index ${I.i}?`,
      ans: (I) => Math.floor((Math.floor((I.i - 1) / I.d) - 1) / I.d),
      why: () => `parent(i) = ⌊(i − 1) / d⌋. Wider heaps are shallower (faster decrease-key / sift-up) but sift-down compares d children per level.` }),
    { id: "cartesian-parent", name: "Cartesian Tree Parent", tags: "Monotonic stack", w: "pick",
      gen: (lv, R) => { const a = R.distinct(L3(lv, 6, 9, 12), 1, 50), mi = a.indexOf(Math.min(...a)); let i; do i = R.int(0, a.length - 1); while (i === mi); return { a, i }; },
      ui: (I) => ({ k: 1, hl: [I.i] }),
      text: (I) => `Build the Cartesian tree of this array (root = the minimum, left/right subtrees built from the parts to its left/right). Select the parent of <b>${I.a[I.i]}</b> (highlighted).`,
      ans: (I) => { const a = I.a, i = I.i; let l = i - 1; while (l >= 0 && a[l] > a[i]) l--; let r = i + 1; while (r < a.length && a[r] > a[i]) r++; const c = [l, r].filter((x) => x >= 0 && x < a.length); return [c.reduce((x, y) => (a[x] > a[y] ? x : y))]; },
      why: () => `The parent is the larger of the nearest smaller element on the left and on the right. A monotonic stack builds the whole tree in O(n); it's also how treaps and RMQ-to-LCA reductions work.` },

    /* ----- tries, segment trees, Fenwick trees ----- */
    num({ id: "trie-nodes", name: "Size of a Trie", tags: "Shared prefixes",
      gen: (lv, R) => { const base = U.range(L3(lv, 2, 3, 3)).map(() => R.str(R.int(2, 3), "abc")); const words = [...new Set(U.range(L3(lv, 4, 6, 8)).map(() => R.pick(base) + R.str(R.int(0, 2), "abc")))]; return words.length >= 3 ? { words } : null; },
      text: (I) => `Insert ${vlist(I.words)} into a trie. How many nodes does it have, not counting the root?`, ans: (I) => prefixes(I.words).size,
      why: () => `Each node is one distinct prefix. Shared prefixes are stored once, which is why tries make prefix queries cheap.` }),
    num({ id: "radix-tree-nodes", name: "Compressed Trie (Radix Tree)", tags: "Path compression",
      gen: (lv, R) => { const base = U.range(L3(lv, 2, 3, 3)).map(() => R.str(R.int(2, 4), "abc")); const words = [...new Set(U.range(L3(lv, 3, 5, 7)).map(() => R.pick(base) + R.str(R.int(0, 3), "abc")))]; return words.length >= 3 ? { words } : null; },
      text: (I) => `Build a radix tree (a trie where chains of single-child nodes merge into one edge) for ${vlist(I.words)}. How many nodes does it have, not counting the root?`,
      ans: (I) => { const P = prefixes(I.words), ends = new Set(I.words); return [...P].filter((p) => ends.has(p) || [...P].filter((q) => q.length === p.length + 1 && q.startsWith(p)).length !== 1).length; },
      reject: (I, s) => s === prefixes(I.words).size,
      why: () => `A trie node survives compression only if a word ends there or it branches (≠ 1 child). Everything else is a single-child link that merges into an edge label.` }),
    { id: "segment-tree-cover", name: "Segment Tree Range Query", tags: "Canonical decomposition", w: "nodes",
      gen: (lv, R) => { const n = L3(lv, 6, 8, 12), T = segTree(n); const l = R.int(0, n - 3), r = R.int(l + 2, n - 1); const c = segCover(T, l, r); return c.length >= L3(lv, 2, 3, 3) ? { T, G: layout(T, { dx: 38 }), l, r, r0: 21 } : null; },
      ui: (I) => ({ G: I.G, labels: I.T.val, r: 21 }),
      text: (I) => `Each node stores the sum of the index range shown. Select the nodes a query for the sum of indices <b>${I.l}…${I.r}</b> combines (the fewest whole nodes that exactly cover the range).`,
      ans: (I) => segCover(I.T, I.l, I.r),
      why: () => `Recurse: a node fully inside the range is used whole; a node outside is ignored; otherwise split. At most two nodes per level are used, so a query is O(log n).` },
    { id: "fenwick-query", name: "Fenwick Tree Prefix Query", tags: "Strip the lowest set bit", w: "pick",
      gen: (lv, R) => { const n = L3(lv, 8, 12, 16); return { n, i: R.int(Math.floor(n / 2), n) }; },
      ui: (I) => ({ items: U.range(I.n).map((k) => k + 1), style: "tiles", sub: U.range(I.n).map((k) => (k + 1).toString(2)) }),
      text: (I) => `A Fenwick (binary indexed) tree is stored in cells 1…${I.n} (binary shown below). Select every cell read when computing the prefix sum up to <b>${I.i}</b>.`,
      ans: (I) => { const o = []; for (let j = I.i; j > 0; j -= j & -j) o.push(j - 1); return o.sort((a, b) => a - b); },
      reject: (I, s) => s.length < 2,
      why: () => `Cell j covers (j − lowbit(j), j]. Reading j then j − lowbit(j) strips one set bit each step, so a query touches at most log n cells.` },
    { id: "fenwick-update", name: "Fenwick Tree Point Update", tags: "Add the lowest set bit", w: "pick",
      gen: (lv, R) => { const n = L3(lv, 8, 12, 16); return { n, i: R.int(1, Math.floor(n / 2)) }; },
      ui: (I) => ({ items: U.range(I.n).map((k) => k + 1), style: "tiles", sub: U.range(I.n).map((k) => (k + 1).toString(2)) }),
      text: (I) => `In a Fenwick tree with cells 1…${I.n}, select every cell that changes when you add to position <b>${I.i}</b>.`,
      ans: (I) => { const o = []; for (let j = I.i; j <= I.n; j += j & -j) o.push(j - 1); return o; },
      reject: (I, s) => s.length < 2,
      why: () => `Every cell whose range contains i must change. Adding lowbit(j) jumps to the next such cell; again at most log n steps.` },

    /* ----- general trees ----- */
    { id: "prufer-code", name: "Prüfer Code", tags: "Smallest leaf first", w: "order",
      gen: (lv, R) => gTree(R, L3(lv, 5, 7, 9)),
      ui: (I) => ({ items: LT.slice(0, I.T.n), len: I.T.n - 2, repeat: true }),
      text: (I) => `Encode this tree (edges undirected) as a Prüfer sequence: ${I.T.n - 2} times, remove the alphabetically smallest leaf and write down its neighbour.${figT(I)}`,
      ans: (I) => { const n = I.T.n, deg = U.range(n).map((v) => nb(I.T, v).length), gone = Array(n).fill(false), out = []; for (let k = 0; k < n - 2; k++) { const l = U.range(n).find((v) => !gone[v] && deg[v] === 1); const p = nb(I.T, l).find((u) => !gone[u]); out.push(p); gone[l] = true; deg[l]--; deg[p]--; } return out; },
      why: () => `Each vertex appears (degree − 1) times. The bijection between labelled trees and sequences of length n − 2 proves Cayley's formula: nⁿ⁻² labelled trees.` },
    num({ id: "delete-nodes-forest", name: "Delete Nodes and Return Forest", tags: "DFS with parent-deleted flag",
      gen: (lv, R) => { const I = gBin(R, L3(lv, 7, 10, 13)); if (!I) return null; return { ...I, mark: R.sample(U.range(I.T.n), L3(lv, 2, 3, 4)).sort((a, b) => a - b) }; },
      text: (I) => `Delete the outlined nodes (their children stay). How many separate trees remain?${figT(I, { cls: markCls(I) })}`,
      ans: (I) => U.range(I.T.n).filter((v) => !I.mark.includes(v) && (I.T.par[v] < 0 || I.mark.includes(I.T.par[v]))).length,
      why: () => `A surviving node is a new root exactly when its parent was deleted (or it was the root). One DFS passing "is my parent deleted?" collects them.` }),
    num({ id: "expression-tree", name: "Evaluate an Expression Tree", tags: "Post-order evaluation",
      gen: (lv, R) => { const T = randExpr(R, L3(lv, 3, 4, 6), L3(lv, 2, 3, 3)); return T ? { T, G: layout(T) } : null; },
      text: (I) => `What does this expression tree evaluate to?${figT(I)}`, ans: (I) => evalE(I.T),
      why: () => `Post-order: evaluate both children, then apply the operator. This is exactly how a compiler evaluates an AST.` }),
    { id: "expression-postfix", name: "Expression Tree to Postfix", tags: "Post-order = RPN", w: "order",
      gen: (lv, R) => { const T = randExpr(R, L3(lv, 3, 4, 5), 3); return T ? { T, G: layout(T) } : null; },
      ui: ordUI,
      text: (I) => `Click the tokens of this expression in <b>postfix</b> (Reverse Polish) order.${figT(I)}`,
      accept: (I, o) => { const it = ordUI(I).items; return o.map((k) => it[k]).join(" ") === pathVals(I.T, postO(I.T)).join(" ") || "not the postfix order"; },
      ans: (I) => toChips(I.T, postO(I.T)),
      why: () => `Postfix is the post-order of the expression tree. It needs no parentheses: a stack evaluates it left to right.` },
  ]);
})();
