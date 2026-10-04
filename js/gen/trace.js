/* Structure Tracer: procedurally generated traces of stacks, queues, heaps, trees, hashing, union-find and bit tricks. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;
  const fmt = U.fmt, esc = U.esc;

  /* ---------- simulators ---------- */
  function randomOps(n, pushBias = 0.6) {
    const vals = U.distinctInts(n, 1, 60);
    for (let tries = 0; tries < 50; tries++) {
      const ops = [];
      let size = 0, vi = 0, pops = 0;
      for (let k = 0; k < n; k++) {
        if (size === 0 || Math.random() < pushBias) {
          ops.push({ op: "push", v: vals[vi++] });
          size++;
        } else {
          ops.push({ op: "pop" });
          size--;
          pops++;
        }
      }
      if (pops >= 2 && size >= 2) return ops;
    }
    return [{ op: "push", v: vals[0] }, { op: "push", v: vals[1] }, { op: "push", v: vals[2] }, { op: "pop" }, { op: "push", v: vals[3] }, { op: "pop" }, { op: "push", v: vals[4] }];
  }
  const runStack = (ops) => { const s = [], out = []; ops.forEach((o) => (o.op === "push" ? s.push(o.v) : out.push(s.pop()))); return { final: s, out }; };
  const runQueue = (ops) => { const q = [], out = []; ops.forEach((o) => (o.op === "push" ? q.push(o.v) : out.push(q.shift()))); return { final: q, out }; };

  // Binary min-heap identical to Python's heapq for distinct values.
  const H = {
    push(h, x) { h.push(x); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[i] < h[p]) { [h[i], h[p]] = [h[p], h[i]]; i = p; } else break; } },
    down(h, i, cmp = (a, b) => a < b) {
      const n = h.length;
      for (;;) {
        let s = i; const l = 2 * i + 1, r = l + 1;
        if (l < n && cmp(h[l], h[s])) s = l;
        if (r < n && cmp(h[r], h[s])) s = r;
        if (s === i) return;
        [h[i], h[s]] = [h[s], h[i]]; i = s;
      }
    },
    pop(h) { const last = h.pop(); if (!h.length) return last; const top = h[0]; h[0] = last; H.down(h, 0); return top; },
    heapify(a, cmp) { for (let i = (a.length >> 1) - 1; i >= 0; i--) H.down(a, i, cmp); return a; },
    pushMax(h, x) { h.push(x); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[i] > h[p]) { [h[i], h[p]] = [h[p], h[i]]; i = p; } else break; } },
  };

  /* ---------- trees ---------- */
  function bstInsert(root, k) {
    if (!root) return { key: k, left: null, right: null };
    if (k < root.key) root.left = bstInsert(root.left, k);
    else root.right = bstInsert(root.right, k);
    return root;
  }
  const height = (n) => (n ? 1 + Math.max(height(n.left), height(n.right)) : 0);
  const pre = (n, o = []) => (n && (o.push(n.key), pre(n.left, o), pre(n.right, o)), o);
  const post = (n, o = []) => (n && (post(n.left, o), post(n.right, o), o.push(n.key)), o);
  const ino = (n, o = []) => (n && (ino(n.left, o), o.push(n.key), ino(n.right, o)), o);
  function level(root) { const o = [], q = root ? [root] : []; while (q.length) { const n = q.shift(); o.push(n.key); n.left && q.push(n.left); n.right && q.push(n.right); } return o; }
  function parentOf(root, k) { let p = null, n = root; while (n && n.key !== k) { p = n; n = k < n.key ? n.left : n.right; } return p ? p.key : null; }

  // AVL
  const ah = (n) => (n ? n.h : 0);
  const upd = (n) => ((n.h = 1 + Math.max(ah(n.left), ah(n.right))), n);
  function rotR(y) { const x = y.left; y.left = x.right; x.right = y; upd(y); return upd(x); }
  function rotL(x) { const y = x.right; x.right = y.left; y.left = x; upd(x); return upd(y); }
  function avlInsert(n, k) {
    if (!n) return { key: k, left: null, right: null, h: 1 };
    if (k < n.key) n.left = avlInsert(n.left, k); else n.right = avlInsert(n.right, k);
    upd(n);
    const bal = ah(n.left) - ah(n.right);
    if (bal > 1 && k < n.left.key) return rotR(n);
    if (bal < -1 && k > n.right.key) return rotL(n);
    if (bal > 1 && k > n.left.key) { n.left = rotL(n.left); return rotR(n); }
    if (bal < -1 && k < n.right.key) { n.right = rotR(n.right); return rotL(n); }
    return n;
  }

  D.treeSvg = function (root, opts = {}) {
    const items = [];
    let idx = 0, maxD = 0;
    (function walk(n, d) { if (!n) return; walk(n.left, d + 1); items.push({ n, d, i: idx++ }); maxD = Math.max(maxD, d); walk(n.right, d + 1); })(root, 0);
    const gapX = 40, gapY = 58, W = Math.max(200, idx * gapX + 20), Hh = (maxD + 1) * gapY + 14;
    const pos = new Map(items.map((it) => [it.n, { x: 10 + it.i * gapX + gapX / 2, y: 26 + it.d * gapY }]));
    let edges = "", nodes = "";
    items.forEach(({ n }) => {
      const p = pos.get(n);
      [n.left, n.right].forEach((c) => { if (c) { const q = pos.get(c); edges += `<line class="edge" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`; } });
      const pick = opts.pickable ? ` data-pick="${n.key}"` : "";
      nodes += `<g class="node"${pick}><circle cx="${p.x}" cy="${p.y}" r="17"/><text x="${p.x}" y="${p.y}">${n.key}</text>${opts.pickable ? `<text class="ord" x="${p.x + 15}" y="${p.y - 15}"></text>` : ""}</g>`;
    });
    return `<svg class="diagram" viewBox="0 0 ${W} ${Hh}" width="${W}" role="img" aria-label="Binary tree">${edges}${nodes}</svg>`;
  };

  function balancedishKeys(n) {
    for (let t = 0; t < 200; t++) {
      const keys = U.distinctInts(n, 5, 95);
      let root = null;
      keys.forEach((k) => (root = bstInsert(root, k)));
      const h = height(root);
      if (h <= Math.ceil(Math.log2(n + 1)) + 1 && h >= 3) return { keys, root };
    }
    const keys = U.distinctInts(n, 5, 95);
    let root = null;
    keys.forEach((k) => (root = bstInsert(root, k)));
    return { keys, root };
  }

  /* ---------- question builders ---------- */
  const choice = (o) => ({ kind: "choice", ...o });

  function stackQ(lvl, kindName = "stack") {
    const n = [6, 8, 11, 13][lvl - 1];
    const ops = randomOps(n);
    const isStack = kindName === "stack";
    const mine = isStack ? runStack(ops) : runQueue(ops);
    const other = isStack ? runQueue(ops) : runStack(ops);
    const askPrinted = Math.random() < 0.5;
    const lines = isStack ? ["s = []"] : ["from collections import deque", "q = deque()"];
    ops.forEach((o) => {
      if (o.op === "push") lines.push(isStack ? `s.append(${o.v})` : `q.append(${o.v})`);
      else lines.push(isStack ? (askPrinted ? "print(s.pop())" : "s.pop()") : askPrinted ? "print(q.popleft())" : "q.popleft()");
    });
    if (!askPrinted) lines.push(isStack ? "print(s)" : "print(list(q))");
    const ans = askPrinted ? mine.out : mine.final;
    const trap = askPrinted ? other.out : other.final;
    return choice({
      tag: isStack ? "Stack" : "Queue",
      prompt: askPrinted ? `Trace the ${isStack ? "stack" : "queue"}. Which values are printed, in order?` : `Trace the ${isStack ? "stack" : "queue"}. What is printed at the end?`,
      code: lines.join("\n"),
      options: U.listOptions(ans, [trap, ans.slice().reverse()]),
      answer: fmt(ans),
      explain: isStack
        ? `A stack is last-in, first-out: pop() removes the most recent push. Stack at the end (bottom → top): ${fmt(mine.final)}.`
        : `A queue is first-in, first-out: popleft() removes the oldest item. Queue at the end (front → back): ${fmt(mine.final)}.`,
    });
  }

  function dequeQ(lvl) {
    const n = lvl >= 4 ? 12 : 9;
    const vals = U.distinctInts(n, 1, 60);
    const lines = ["from collections import deque", "d = deque()"];
    const d = [], naive = [];
    let vi = 0;
    for (let k = 0; k < n; k++) {
      const r = Math.random();
      if (d.length < 2 || r < 0.55) {
        const v = vals[vi++];
        if (Math.random() < 0.5) { lines.push(`d.append(${v})`); d.push(v); naive.push(v); }
        else { lines.push(`d.appendleft(${v})`); d.unshift(v); naive.push(v); }
      } else if (r < 0.78) { lines.push("d.pop()"); d.pop(); naive.pop(); }
      else { lines.push("d.popleft()"); d.shift(); naive.shift(); }
    }
    lines.push("print(list(d))");
    return choice({
      tag: "Deque",
      prompt: "Trace the double-ended queue. What is printed?",
      code: lines.join("\n"),
      options: U.listOptions(d, [naive, d.slice().reverse()]),
      answer: fmt(d),
      explain: "append/pop work on the right end and appendleft/popleft on the left. Each is O(1).",
    });
  }

  function linkedQ(lvl) {
    let list = U.distinctInts(3, 1, 20);
    const lines = [`lst = LinkedList(${fmt(list)})`];
    const used = new Set(list);
    const fresh = () => { let v; do v = U.randInt(1, 30); while (used.has(v)); used.add(v); return v; };
    const nOps = lvl === 1 ? 3 : 5;
    let prev = list.slice();
    const opsNames = lvl === 1 ? ["front", "back", "remove"] : ["front", "back", "remove", "reverse", "after"];
    let lastNames = [];
    for (let k = 0; k < nOps; k++) {
      let op = U.pick(opsNames);
      if (op === "remove" && list.length < 3) op = "back";
      if (op === "reverse" && lastNames.includes("reverse")) op = "front";
      lastNames.push(op);
      prev = list.slice();
      if (op === "front") { const v = fresh(); list.unshift(v); lines.push(`lst.push_front(${v})`); }
      if (op === "back") { const v = fresh(); list.push(v); lines.push(`lst.push_back(${v})`); }
      if (op === "remove") { const v = U.pick(list); list = list.filter((x) => x !== v); lines.push(`lst.remove(${v})`); }
      if (op === "reverse") { list.reverse(); lines.push("lst.reverse()"); }
      if (op === "after") { const a = U.pick(list), v = fresh(); list.splice(list.indexOf(a) + 1, 0, v); lines.push(`lst.insert_after(${a}, ${v})`); }
    }
    lines.push("print(lst)        # head → tail");
    return choice({
      tag: "Linked list",
      prompt: "Apply each operation to the linked list. What is printed?",
      code: lines.join("\n"),
      options: U.listOptions(list, [prev, list.slice().reverse()]),
      answer: fmt(list),
      explain: "push_front links a new head, push_back appends after the tail, remove unlinks the first matching node and reverse flips every next pointer.",
    });
  }

  function heapPopsQ(lvl) {
    const vals = U.distinctInts(lvl === 1 ? 6 : 8, 1, 60);
    const h = [], out = [], lines = ["import heapq", "h = []"];
    const stackish = [], queueish = [];
    if (lvl === 1) {
      vals.forEach((v) => { H.push(h, v); lines.push(`heapq.heappush(h, ${v})`); stackish.push(v); queueish.push(v); });
      for (let k = 0; k < 3; k++) { out.push(H.pop(h)); lines.push("print(heapq.heappop(h))"); }
      const desc = vals.slice().sort((a, b) => b - a).slice(0, 3);
      return choice({
        tag: "Heap", prompt: "Python's heapq is a min-heap. Which values are printed, in order?", code: lines.join("\n"),
        options: U.listOptions(out, [desc, vals.slice(0, 3), vals.slice(-3).reverse()]), answer: fmt(out),
        explain: "heappop always removes the smallest remaining value, so the three pops print the three smallest in ascending order.",
      });
    }
    let vi = 0;
    const sOut = [], qOut = [];
    while (vi < vals.length) {
      const burst = U.randInt(1, 3);
      for (let k = 0; k < burst && vi < vals.length; k++) { const v = vals[vi++]; H.push(h, v); stackish.push(v); queueish.push(v); lines.push(`heapq.heappush(h, ${v})`); }
      if (h.length && Math.random() < 0.7) { out.push(H.pop(h)); sOut.push(stackish.pop()); qOut.push(queueish.shift()); lines.push("print(heapq.heappop(h))"); }
    }
    while (out.length < 3 && h.length) { out.push(H.pop(h)); sOut.push(stackish.pop()); qOut.push(queueish.shift()); lines.push("print(heapq.heappop(h))"); }
    return choice({
      tag: "Heap", prompt: "Pushes and pops are interleaved on a min-heap. Which values are printed, in order?", code: lines.join("\n"),
      options: U.listOptions(out, [sOut, qOut, out.slice().sort((a, b) => a - b)]), answer: fmt(out),
      explain: "Each heappop returns the smallest value currently in the heap. Values pushed later can come out first if they are smaller.",
    });
  }

  function heapLayoutQ(lvl) {
    const vals = U.distinctInts(lvl >= 4 ? 8 : 7, 1, 60);
    if (lvl >= 4 && Math.random() < 0.6) {
      const floyd = H.heapify(vals.slice());
      const oneByOne = []; vals.forEach((v) => H.push(oneByOne, v));
      const maxH = H.heapify(vals.slice(), (a, b) => a > b);
      return choice({
        tag: "Heap", prompt: "What does the list look like after heapify?",
        code: `import heapq\na = ${fmt(vals)}\nheapq.heapify(a)\nprint(a)`,
        options: U.listOptions(floyd, [oneByOne, vals.slice().sort((a, b) => a - b), maxH]), answer: fmt(floyd),
        explain: `heapify sifts down every internal node, from index ${(vals.length >> 1) - 1} back to 0 (Floyd's O(n) method). That can differ from pushing the items one at a time, which gives ${fmt(oneByOne)}.`,
      });
    }
    const h = []; vals.forEach((v) => H.push(h, v));
    const maxH = []; vals.forEach((v) => H.pushMax(maxH, v));
    return choice({
      tag: "Heap", prompt: "A heap is stored as a list (children of i at 2i+1 and 2i+2). What is printed?",
      code: `import heapq\nh = []\nfor x in ${fmt(vals)}:\n    heapq.heappush(h, x)\nprint(h)`,
      options: U.listOptions(h, [vals.slice().sort((a, b) => a - b), maxH, vals]), answer: fmt(h),
      explain: "Each push appends at the end and swaps with its parent while it is smaller. The list is a valid heap but generally not sorted.",
    });
  }

  function bstQ(lvl) {
    const n = [6, 7, 8, 9][lvl - 1];
    const { keys, root } = balancedishKeys(n);
    const code = `t = BST()\nfor k in ${fmt(keys)}:\n    t.insert(k)`;
    if (lvl === 1) {
      if (Math.random() < 0.5) {
        const nonRoot = keys.slice(1);
        const k = U.pick(nonRoot.slice(Math.floor(nonRoot.length / 2)));
        const par = parentOf(root, k);
        const traps = [keys[keys.indexOf(k) - 1], keys[0]];
        return choice({
          tag: "BST", prompt: `Insert the keys in order into an empty binary search tree. What is the parent of <b>${k}</b>?`, code,
          options: U.options(par, traps, () => U.pick(keys.filter((x) => x !== k))), answer: String(par),
          explain: `Inserting walks down from the root: left if smaller, right if larger. ${k} ends up as a child of ${par}.` + `<div class="figure">${D.treeSvg(root)}</div>`,
        });
      }
      const h = height(root) - 1;
      return choice({
        tag: "BST", prompt: "Insert the keys in order into an empty binary search tree. What is its height, counted in edges from the root to the deepest leaf?", code,
        options: U.numOptions(h, [h + 1, Math.ceil(Math.log2(n + 1)) - 1]), answer: String(h),
        explain: `The deepest path has ${h} edges.<div class="figure">${D.treeSvg(root)}</div>`,
      });
    }
    const kinds = lvl === 2 ? ["preorder", "postorder"] : ["preorder", "postorder", "level order"];
    const k = U.pick(kinds);
    const seq = k === "preorder" ? pre(root) : k === "postorder" ? post(root) : level(root);
    const showFig = lvl === 2;
    const rule = { preorder: "node, then left subtree, then right subtree", postorder: "left subtree, then right subtree, then node", "level order": "top to bottom, left to right within each level" }[k];
    return {
      kind: "order", tag: "BST",
      prompt: showFig ? `Click the nodes in <b>${k}</b> (${rule}).` : `Insert the keys into an empty BST, then click them in <b>${k}</b> (${rule}).`,
      code: showFig ? null : code,
      figure: showFig ? D.treeSvg(root, { pickable: true }) : null,
      items: keys.slice().sort((a, b) => a - b).map(String),
      answer: seq.map(String),
      explain: `${k[0].toUpperCase() + k.slice(1)} visits ${rule}. In-order would simply be sorted: ${fmt(ino(root))}.` + (showFig ? "" : `<div class="figure">${D.treeSvg(root)}</div>`),
      review: `BST ${k} for keys ${fmt(keys)}`,
    };
  }

  function avlQ() {
    const n = U.randInt(6, 8);
    let keys, root, plain;
    for (let t = 0; t < 100; t++) {
      keys = U.distinctInts(n, 5, 95);
      if (Math.random() < 0.5) keys.sort((a, b) => a - b).splice(U.randInt(1, 3), 0, ...keys.splice(-1)); // nearly sorted: forces rotations
      root = null; plain = null;
      keys.forEach((k) => { root = avlInsert(root, k); plain = bstInsert(plain, k); });
      if (root.key !== plain.key) break;
    }
    const code = `t = AVLTree()\nfor k in ${fmt(keys)}:\n    t.insert(k)`;
    if (Math.random() < 0.5) {
      const sorted = keys.slice().sort((a, b) => a - b);
      return choice({
        tag: "AVL tree", prompt: "Insert the keys into an empty AVL tree, rebalancing after every insert. Which key is the root at the end?", code,
        options: U.options(root.key, [keys[0], sorted[Math.floor(n / 2)], keys[n - 1]], () => U.pick(keys)), answer: String(root.key),
        explain: `Rotations keep every node's subtree heights within 1 of each other. A plain BST would have ${keys[0]} as root.<div class="figure">${D.treeSvg(root)}</div>`,
      });
    }
    return {
      kind: "order", tag: "AVL tree",
      prompt: "Insert the keys into an empty AVL tree, then click the keys in <b>preorder</b> (node, left, right).", code,
      items: keys.slice().sort((a, b) => a - b).map(String), answer: pre(root).map(String),
      explain: `Final AVL tree:<div class="figure">${D.treeSvg(root)}</div>`,
      review: `AVL preorder for keys ${fmt(keys)}`,
    };
  }

  function hashQ(lvl) {
    const m = lvl === 2 ? 7 : 11;
    const quad = lvl >= 4;
    for (let t = 0; t < 200; t++) {
      const n = lvl === 2 ? 5 : quad ? 5 : 7;
      const keys = U.distinctInts(n, 10, 99);
      const table = Array(m).fill(null), log = [];
      let ok = true, probesTotal = 0;
      const where = {};
      for (const k of keys) {
        const h = k % m;
        let i = 0, slot = h;
        const tried = [];
        while (table[slot] !== null) {
          tried.push(slot);
          i++;
          if (i > m) { ok = false; break; }
          slot = quad ? (h + i * i) % m : (h + i) % m;
        }
        if (!ok) break;
        table[slot] = k; where[k] = { slot, home: h, tried };
        probesTotal += i;
        log.push(`${k} mod ${m} = ${h}` + (tried.length ? ` → ${tried.join(", ")} taken → slot ${slot}` : ` → slot ${slot}`));
      }
      if (!ok) continue;
      const collided = keys.filter((k) => where[k].tried.length >= (lvl >= 3 ? 2 : 1));
      if (!collided.length) continue;
      const k = collided[collided.length - 1];
      const w = where[k];
      const linearSlot = (() => { let s = w.home; const tb = Array(m).fill(null); for (const kk of keys) { let x = kk % m; while (tb[x] !== null) x = (x + 1) % m; tb[x] = kk; if (kk === k) s = x; } return s; })();
      return choice({
        tag: "Hashing",
        prompt: `Insert the keys into a table of size ${m} with h(k) = k mod ${m} and <b>${quad ? "quadratic probing: try h, h+1, h+4, h+9, …" : "linear probing: try h, h+1, h+2, …"}</b> (wrapping around). Which slot does <b>${k}</b> end up in?`,
        code: `keys = ${fmt(keys)}`,
        options: U.options(w.slot, [w.home, quad ? linearSlot : (w.slot + 1) % m, (w.home + 1) % m], () => U.rand(m)),
        answer: String(w.slot),
        explain: `<span class="mono">${log.map(esc).join("<br>")}</span>`,
      });
    }
    return stackQ(lvl);
  }

  function unionFindQ(lvl) {
    const n = 8;
    const parent = U.range(n);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const k = lvl >= 4 ? 7 : 5;
    const lines = ["uf = UnionFind(8)      # elements 0..7"];
    let redundant = 0;
    for (let i = 0; i < k; i++) {
      const a = U.rand(n);
      let b = U.rand(n);
      while (b === a) b = U.rand(n);
      lines.push(`uf.union(${a}, ${b})`);
      const ra = find(a), rb = find(b);
      if (ra === rb) redundant++;
      else parent[ra] = rb;
    }
    const sets = U.uniq(U.range(n).map(find)).length;
    if (lvl >= 4 && Math.random() < 0.5) {
      const x = U.rand(n);
      const members = U.range(n).filter((y) => find(y) === find(x));
      const trapA = U.uniq([x, ...lines.slice(1).map((l) => l.match(/\d+/g).map(Number)).filter((p) => p.includes(x)).flat()]).sort((a, b) => a - b);
      return choice({
        tag: "Union-Find", prompt: `After these unions, which elements are in the same set as <b>${x}</b> (including ${x})?`, code: lines.join("\n"),
        options: U.listOptions(members, [trapA, U.range(n)]), answer: fmt(members),
        explain: "Union merges whole sets, so connectivity is transitive: anything joined to anything in x's set is in x's set.",
      });
    }
    return choice({
      tag: "Union-Find", prompt: "After these unions, how many disjoint sets are there?", code: lines.join("\n"),
      options: U.numOptions(sets, [n - k, sets + redundant]), answer: String(sets),
      explain: `Start with 8 singleton sets. Each union of two different sets removes one. ${redundant ? `${redundant} of the unions joined elements that were already connected, so they changed nothing.` : "Every union here joined two different sets."}`,
    });
  }

  function nextGreaterQ() {
    const a = U.distinctInts(U.randInt(6, 7), 1, 30);
    const ng = a.map((x, i) => { for (let j = i + 1; j < a.length; j++) if (a[j] > x) return a[j]; return -1; });
    const ns = a.map((x, i) => { for (let j = i + 1; j < a.length; j++) if (a[j] < x) return a[j]; return -1; });
    const maxRight = a.map((x, i) => { const r = a.slice(i + 1).filter((y) => y > x); return r.length ? Math.max(...r) : -1; });
    const pg = a.map((x, i) => { for (let j = i - 1; j >= 0; j--) if (a[j] > x) return a[j]; return -1; });
    return choice({
      tag: "Monotonic stack", prompt: "For each element, find the <b>next greater element</b> to its right (or -1 if there is none).",
      code: `a = ${fmt(a)}`,
      options: U.listOptions(ng, [maxRight, ns, pg]), answer: fmt(ng),
      explain: "Scan left to right, keeping a stack of indices still waiting for a larger value. Each new value pops and resolves every smaller one. O(n) total.",
    });
  }

  function windowMaxQ(lvl) {
    const len = lvl >= 4 ? 9 : 7, k = lvl >= 4 ? U.pick([3, 4]) : 3;
    const a = U.range(len).map(() => U.randInt(-5, 20));
    const maxes = [], mins = [], firsts = [];
    for (let i = 0; i + k <= len; i++) { const w = a.slice(i, i + k); maxes.push(Math.max(...w)); mins.push(Math.min(...w)); firsts.push(w[0]); }
    return choice({
      tag: "Monotonic deque", prompt: `Slide a window of size <b>${k}</b> across the array. What is the maximum of each window?`,
      code: `a = ${fmt(a)}\nk = ${k}`,
      options: U.listOptions(maxes, [mins, firsts]), answer: fmt(maxes),
      explain: `There are n − k + 1 = ${len - k + 1} windows. A deque of indices with decreasing values gives every window's max in O(n).`,
    });
  }

  function bitsQ(lvl) {
    const x = U.randInt(lvl === 1 ? 3 : 5, lvl >= 3 ? 63 : 31);
    const y = U.randInt(3, 31);
    const b = (v, w = 6) => (v >>> 0).toString(2).padStart(w, "0");
    const pc = (v) => b(v).split("").filter((c) => c === "1").length;
    const X = `<span class="mono">${b(x)}</span>`, Y = `<span class="mono">${b(y)}</span>`;
    // [expression, value, uses y, note]
    const bank = {
      1: [[`${x} << 1`, x << 1, 0, "Shifting left by 1 doubles the number."], [`${x} >> 1`, x >> 1, 0, "Shifting right by 1 halves it, rounding down."], [`${x} & 1`, x & 1, 0, "x & 1 is 1 for odd numbers and 0 for even ones."], [`bin(${x}).count("1")`, pc(x), 0, "This counts the 1 bits (the popcount)."]],
      2: [[`${x} & ${y}`, x & y, 1, "AND keeps the bits set in both."], [`${x} | ${y}`, x | y, 1, "OR keeps the bits set in either."], [`${x} ^ ${y}`, x ^ y, 1, "XOR keeps the bits set in exactly one."], [`${x} << 2`, x << 2, 0, "Shifting left by 2 multiplies by 4."]],
      3: [[`${x} & (${x} - 1)`, x & (x - 1), 0, "x & (x−1) clears the lowest set bit."], [`${x} & -${x}`, x & -x, 0, "x & −x isolates the lowest set bit."], [`(${x} >> 2) & 1`, (x >> 2) & 1, 0, "This reads bit 2, counting from 0 at the right."], [`bin(${x}).count("1")`, pc(x), 0, "This counts the 1 bits (the popcount)."], [`${x} ^ ${y} ^ ${x}`, y, 1, "XOR is its own inverse: x ^ y ^ x = y."]],
      4: [[`${x} ^ (${x} >> 1)`, x ^ (x >> 1), 0, "x ^ (x >> 1) is the Gray code of x."], [`${x} | (${x} + 1)`, x | (x + 1), 0, "x | (x+1) sets the lowest 0 bit."], [`${x} & ~${y} & 63`, x & ~y & 63, 1, "x & ~y clears the bits of x that are set in y."], [`(${x} ^ ${y}).bit_count()`, pc(x ^ y), 1, "The popcount of x ^ y is the Hamming distance between x and y."], [`${x} & -${x}`, x & -x, 0, "x & −x isolates the lowest set bit."]],
    }[lvl];
    const [expr, val, usesY, note] = U.pick(bank);
    const traps = bank.map((e) => e[1]).filter((v) => v !== val);
    return choice({
      tag: "Bits", prompt: "What does this Python expression evaluate to?",
      code: expr,
      options: U.numOptions(val, traps), answer: String(val),
      explain: `${x} = ${X}${usesY ? `, ${y} = ${Y}` : ""}. The result is <span class="mono">${b(val)}</span> = ${val}. ${note}`,
    });
  }

  const TYPES = {
    1: [() => stackQ(1, "stack"), () => stackQ(1, "queue"), () => linkedQ(1), () => heapPopsQ(1), () => bitsQ(1), () => bstQ(1)],
    2: [() => stackQ(2, "stack"), () => stackQ(2, "queue"), () => linkedQ(2), () => heapPopsQ(2), () => bstQ(2), () => hashQ(2), () => bitsQ(2), () => bstQ(1)],
    3: [() => dequeQ(3), () => heapLayoutQ(3), () => bstQ(3), () => hashQ(3), () => unionFindQ(3), () => nextGreaterQ(), () => windowMaxQ(3), () => bitsQ(3), () => stackQ(3, U.pick(["stack", "queue"]))],
    4: [() => heapLayoutQ(4), () => avlQ(), () => avlQ(), () => hashQ(4), () => unionFindQ(4), () => windowMaxQ(4), () => bitsQ(4), () => dequeQ(4), () => bstQ(4), () => heapPopsQ(3)],
  };

  D.registerMode({
    id: "trace",
    name: "Structure Tracer",
    group: "Simulators",
    topic: "Data structures",
    blurb: "Run stacks, queues, heaps, BSTs, AVL trees, hash tables and Union-Find in your head.",
    generated: true,
    count: 10,
    make: (lvl, count) => D.mixFrom(TYPES[lvl], count),
  });
})();
