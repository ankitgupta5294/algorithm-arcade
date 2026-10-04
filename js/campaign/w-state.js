/* Campaign worlds: Games & state spaces. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign;

  /* ===================== Nim Duel ===================== */
  const grundy = (h, k) => (k ? h % (k + 1) : h);
  const nimSum = (hs, k) => hs.reduce((x, h) => x ^ grundy(h, k), 0);
  function computerMove(hs, k) {
    // winning move if one exists, otherwise stall by taking one stone from the biggest heap
    const x = nimSum(hs, k);
    if (x) for (let i = 0; i < hs.length; i++) for (let take = 1; take <= (k || hs[i]) && take <= hs[i]; take++) {
      const t = hs.slice(); t[i] -= take; if (nimSum(t, k) === 0) return [i, t[i]];
    }
    const i = hs.indexOf(Math.max(...hs));
    return [i, hs[i] - 1];
  }
  function playerPlan(hs, k) {
    const sol = []; let h = hs.slice();
    while (h.some((x) => x > 0)) {
      const m = computerMove(h, k); sol.push(m); h[m[0]] = m[1];
      if (!h.some((x) => x > 0)) break;
      const c = computerMove(h, k); h[c[0]] = c[1];
    }
    return sol;
  }
  C.nim = { nimSum, computerMove };
  C.register({
    id: "nim", cat: "state", name: "Nim Duel", concept: "Game theory · XOR",
    blurb: "Take stones in turn. Whoever takes the last stone wins. The computer never blunders.",
    tiers: ["Two heaps", "Three heaps", "Four heaps", "Take at most 3"],
    lesson: `<p>A position is <b>losing</b> for the player to move if every move leads to a winning position for the opponent. Nim has an astonishing shortcut (Bouton, 1901): write the heap sizes in binary and XOR them. The player to move loses exactly when the XOR is <b>0</b>.</p>
      <p>So always move to make the XOR zero. Find a heap h with h XOR total &lt; h and reduce it to h XOR total. With two heaps that just means equalising them and then mirroring.</p>
      <p>When a move may take <b>at most k</b> stones, a heap of h acts like a Nim heap of h mod (k+1), its <b>Grundy number</b>. The Sprague–Grundy theorem extends this idea to every such impartial game.</p>`,
    hint: "Make the XOR of all heap sizes zero after your move (with a take limit, use each size mod 4). Then whatever the computer does, you can restore it.",
    gen(L, R, t) {
      const heaps = t === 0 ? 2 : t === 1 ? 3 : t === 2 ? 4 : 3;
      const k = t === 3 ? 3 : 0;
      const max = t === 0 ? 4 + Math.floor((L - 1) / 2) : t === 1 ? 7 : t === 2 ? 9 : 12;
      const hs = U.range(heaps).map(() => R.int(1, max));
      if (nimSum(hs, k) === 0) return null;
      if (t === 0 && hs[0] === hs[1]) return null;
      const sol = playerPlan(hs, k);
      if (sol.length < 2) return null;
      return { hs, k, par: 1, solution: sol, goal: `Tap a stone to take it and every stone to its right in that heap${k ? ` (at most <b>${k}</b> at once)` : ""}. You move first. Whoever takes the <b>last stone wins</b>.` };
    },
    view(el, P, api) {
      const h = P.hs.slice();
      el.innerHTML = `<div class="nim"></div><div class="ptr-readout"></div>`;
      const box = el.querySelector(".nim"), out = el.querySelector(".ptr-readout");
      const bin = (x) => x.toString(2).padStart(4, "0");
      function render(showXor) {
        box.innerHTML = h.map((n, i) => `<div class="heap"><span class="hl">${"ABCD"[i]}</span><span class="stones">${U.range(n).map((j) => `<button type="button" class="stone" data-ij="${i},${j}" aria-label="Heap ${"ABCD"[i]}: take ${n - j}" ${P.k && n - j > P.k ? "disabled" : ""}></button>`).join("")}</span><span class="hn mono">${n}${showXor ? ` <small>${bin(P.k ? n % (P.k + 1) : n)}</small>` : ""}</span></div>`).join("");
        api.stats([["Stones", h.reduce((a, b) => a + b, 0)], ["XOR", api.over || api.tier === 0 ? nimSum(h, P.k) : "?"]]);
      }
      function move([i, left]) {
        if (api.over || left >= h[i] || left < 0 || (P.k && h[i] - left > P.k)) return;
        const took = h[i] - left;
        h[i] = left;
        if (!h.some((x) => x)) { render(true); return api.win({ stars: 3, text: `You took the last stone. Each of your moves left a position whose ${P.k ? "Grundy " : ""}XOR was 0, and from there every computer move handed a winning position back to you.` }); }
        const [ci, cl] = computerMove(h, P.k);
        const ctook = h[ci] - cl;
        h[ci] = cl;
        render(api.tier === 0);
        out.innerHTML = `You took ${took} from ${"ABCD"[i]}. The computer took ${ctook} from ${"ABCD"[ci]}.`;
        if (!h.some((x) => x)) return api.lose(`The computer took the last stone. After your move the ${P.k ? "Grundy values' " : ""}XOR wasn't 0, which gave the computer a winning reply. Make the XOR zero with every move.`);
      }
      C.onPick(box, "data-ij", (v) => { const [i, j] = v.split(",").map(Number); move([i, j]); });
      render(api.tier === 0);
      out.innerHTML = api.tier === 0 ? "Heap sizes are shown in binary. Aim for an XOR of 0 after each move." : "";
      return { move };
    },
  });

  /* ===================== Sliding Tiles ===================== */
  const tileTables = new Map();
  function tileTable(rows, cols) {
    const key = rows + "x" + cols;
    if (tileTables.has(key)) return tileTables.get(key);
    const N = rows * cols, goal = U.range(N).map((i) => (i + 1) % N).join(",");
    const dist = new Map([[goal, 0]]), layers = [[goal]];
    let frontier = [goal];
    while (frontier.length) {
      const nxt = [];
      for (const s of frontier) {
        const a = s.split(",").map(Number), z = a.indexOf(0), r = Math.floor(z / cols), c = z % cols;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const y = r + dr, x = c + dc; if (y < 0 || y >= rows || x < 0 || x >= cols) continue;
          const b = a.slice(); b[z] = b[y * cols + x]; b[y * cols + x] = 0;
          const k = b.join(","); if (!dist.has(k)) { dist.set(k, layers.length); nxt.push(k); }
        }
      }
      if (nxt.length) layers.push(nxt);
      frontier = nxt;
    }
    const T = { dist, layers, rows, cols };
    tileTables.set(key, T);
    return T;
  }
  C.register({
    id: "tiles", cat: "state", name: "Sliding Tiles", concept: "BFS · A*",
    blurb: "Slide tiles into order. Par is the true optimum from a breadth-first search.",
    tiers: ["2×3 board", "3×3, short", "3×3, medium", "3×3, up to the hardest"],
    lesson: `<p>Every arrangement is a vertex and every slide is an edge. <b>Breadth-first search</b> from the solved board labels every state with its exact distance: 9!/2 = 181,440 states for the 8-puzzle, the hardest needing <b>31</b> moves.</p>
      <p>Only half of all arrangements can be reached. Each slide preserves a <b>parity</b> (the number of inversions plus the blank's row), so swapping two tiles by hand creates an unsolvable puzzle.</p>
      <p>For bigger boards (the 15-puzzle has 10¹³ states), <b>A*</b> with the Manhattan-distance heuristic searches toward the goal instead of in every direction.</p>`,
    hint: "Solve the top row first, then the left column, and finish the last 2×2 by cycling. Optimal solutions often break that pattern, so look for shortcuts.",
    gen(L, R, t) {
      const [rows, cols] = t === 0 ? [2, 3] : [3, 3];
      const T = tileTable(rows, cols);
      const i = (L - 1) % 10;
      const d = t === 0 ? 5 + Math.floor(i * 1.3) : t === 1 ? 8 + Math.floor(i * 0.7) : t === 2 ? 15 + Math.floor(i * 0.8) : 22 + i;
      const layer = T.layers[Math.min(d, T.layers.length - 1)];
      const s = R.pick(layer), sol = [];
      let cur = s.split(",").map(Number);
      while (T.dist.get(cur.join(",")) > 0) {
        const z = cur.indexOf(0), r = Math.floor(z / cols), c = z % cols, dd = T.dist.get(cur.join(","));
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const y = r + dr, x = c + dc; if (y < 0 || y >= rows || x < 0 || x >= cols) continue;
          const b = cur.slice(); b[z] = b[y * cols + x]; b[y * cols + x] = 0;
          if (T.dist.get(b.join(",")) === dd - 1) { sol.push(y * cols + x); cur = b; break; }
        }
      }
      return { rows, cols, board: s.split(",").map(Number), par: sol.length, solution: sol, goal: `Tap a tile next to the gap to slide it. Put the tiles in order 1, 2, 3, … with the gap last. Par is <b>${sol.length}</b> moves.` };
    },
    view(el, P, api) {
      const a = P.board.slice(), cols = P.cols;
      let moves = 0;
      el.innerHTML = `<div class="tiles" style="--c:${cols}"></div>`;
      const box = el.querySelector(".tiles");
      function render() {
        box.innerHTML = a.map((v, i) => (v ? `<button type="button" class="tile${v === i + 1 ? " home" : ""}" data-p="${i}" aria-label="Tile ${v}">${v}</button>` : `<span class="tile gap"></span>`)).join("");
        api.stats([["Moves", moves], ["Par", P.par]]);
      }
      function move(p) {
        if (api.over) return;
        const z = a.indexOf(0);
        if (Math.abs(Math.floor(z / cols) - Math.floor(p / cols)) + Math.abs((z % cols) - (p % cols)) !== 1) return;
        a[z] = a[p]; a[p] = 0; moves++;
        render();
        if (a.every((v, i) => v === (i + 1) % a.length)) api.win({ stars: C.stars(moves, P.par, 4), text: `${moves} moves; the shortest solution is ${P.par}. Par came from a breadth-first search over all ${tileTable(P.rows, P.cols).dist.size.toLocaleString()} reachable boards.` });
      }
      C.onPick(box, "data-p", (v) => move(+v));
      render();
      return { move };
    },
  });

  /* ===================== Water Jugs ===================== */
  function jugsBFS(caps, start, target, canFill) {
    const key = (s) => s.join(",");
    const prev = new Map([[key(start), null]]);
    let q = [start];
    while (q.length) {
      const nq = [];
      for (const s of q) {
        if (s.includes(target)) { const path = []; for (let k = key(s); prev.get(k); k = prev.get(k)[0]) path.unshift(prev.get(k)[1]); return path; }
        const next = [];
        caps.forEach((cap, i) => {
          if (canFill && s[i] < cap) { const t = s.slice(); t[i] = cap; next.push(["f" + i, t]); }
          if (canFill && s[i] > 0) { const t = s.slice(); t[i] = 0; next.push(["e" + i, t]); }
          caps.forEach((cap2, j) => { if (i !== j && s[i] > 0 && s[j] < cap2) { const t = s.slice(), m = Math.min(s[i], cap2 - s[j]); t[i] -= m; t[j] += m; next.push([`p${i}${j}`, t]); } });
        });
        for (const [m, t] of next) { const k = key(t); if (!prev.has(k)) { prev.set(k, [key(s), m]); nq.push(t); } }
      }
      q = nq;
    }
    return null;
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  C.register({
    id: "jugs", cat: "state", name: "Water Jugs", concept: "State-space BFS · gcd",
    blurb: "Measure an exact amount using only unmarked jugs.",
    tiers: ["Two small jugs", "Two bigger jugs", "Three jugs, no tap", "Three jugs with a tap"],
    lesson: `<p>A state is the amount in each jug. Moves are fill, empty and pour (until the source is empty or the destination is full). <b>Breadth-first search</b> over these states finds the shortest sequence, and that's how par is computed.</p>
      <p>With two jugs of sizes a and b, you can measure exactly the multiples of <b>gcd(a, b)</b> up to max(a, b), a consequence of Bézout's identity. A 4-litre target from 6 and 9 is impossible because gcd = 3.</p>
      <p>Without a tap the total amount of water never changes, which makes the state graph much smaller and the puzzle much trickier.</p>`,
    hint: "Pouring back and forth between two jugs steps through amounts that differ by the smaller size, modulo the larger one.",
    gen(L, R, t) {
      const canFill = t !== 2;
      let caps, start;
      if (t <= 1) { const lo = t === 0 ? 2 : 4, hi = t === 0 ? 9 : 17; const a = R.int(lo, hi), b = R.int(lo, hi); if (a === b || gcd(a, b) !== 1) return null; caps = [a, b].sort((x, y) => x - y); start = [0, 0]; }
      else if (t === 2) { const big = R.int(8, 16); const a = R.int(3, big - 3), b = big - a + R.int(-2, 0); if (b <= 1 || a === b || b >= big) return null; caps = [big, Math.max(a, b), Math.min(a, b)]; start = [big, 0, 0]; }
      else { caps = U.range(3).map(() => R.int(3, 14)).sort((x, y) => y - x); if (new Set(caps).size < 3) return null; start = [0, 0, 0]; }
      const targets = U.range(Math.max(...caps)).map((x) => x + 1).filter((x) => !caps.includes(x) && !start.includes(x));
      const scored = targets.map((x) => ({ x, sol: jugsBFS(caps, start, x, canFill) })).filter((o) => o.sol);
      if (!scored.length) return null;
      scored.sort((a, b) => b.sol.length - a.sol.length);
      const want = [4, 6, 7, 8][t];
      const pickFrom = scored.filter((o) => o.sol.length >= want);
      if (!pickFrom.length) return null;
      const o = R.pick(pickFrom.slice(0, 3));
      return { caps, start, target: o.x, canFill, par: o.sol.length, solution: o.sol,
        goal: `Get exactly <span class="target-inline">${o.x} L</span> in any jug. ${canFill ? "You can fill a jug from the tap, empty it, or pour one jug into another." : `No tap: the ${start[0]} L of water you start with is all there is. Pour between jugs.`} Pouring stops when the source is empty or the destination is full. Par is <b>${o.sol.length}</b> moves.` };
    },
    view(el, P, api) {
      const s = P.start.slice(); let moves = 0, src = null;
      const maxCap = Math.max(...P.caps);
      el.innerHTML = `<div class="jugs"></div><div class="ptr-readout"></div>`;
      const box = el.querySelector(".jugs"), out = el.querySelector(".ptr-readout");
      function render() {
        box.innerHTML = P.caps.map((cap, i) => `<div class="jugwrap">
          <button type="button" class="jug${src === i ? " src" : ""}${s[i] === P.target ? " hit" : ""}" data-pour="${i}" style="height:${70 + Math.round((cap / maxCap) * 150)}px" aria-label="Jug ${i + 1}: ${s[i]} of ${cap} litres"><span class="water" style="height:${(s[i] / cap) * 100}%"></span><span class="jl">${s[i]}/${cap}</span></button>
          ${P.canFill ? `<div class="jugbtns"><button type="button" class="btn ghost small" data-m="f${i}">Fill</button><button type="button" class="btn ghost small" data-m="e${i}">Empty</button></div>` : ""}</div>`).join("");
        out.innerHTML = src != null ? `Pour jug ${src + 1} into… tap another jug.` : "Tap a jug, then another, to pour.";
        api.stats([["Moves", moves], ["Par", P.par]]);
      }
      function move(m) {
        if (api.over) return;
        const i = +m[1];
        if (m[0] === "f") { if (!P.canFill || s[i] === P.caps[i]) return; s[i] = P.caps[i]; }
        else if (m[0] === "e") { if (!P.canFill || !s[i]) return; s[i] = 0; }
        else { const j = +m[2]; const amt = Math.min(s[i], P.caps[j] - s[j]); if (!amt) { api.say("Nothing to pour."); src = null; render(); return; } s[i] -= amt; s[j] += amt; }
        moves++; src = null; api.say("");
        render();
        if (s.includes(P.target)) api.win({ stars: C.stars(moves, P.par, 2), text: `${P.target} L in ${moves} moves (shortest: ${P.par}). Breadth-first search over (${P.caps.map((c) => "0…" + c).join(", ")}) states found that optimum.${P.caps.length === 2 ? ` Any target that's a multiple of gcd(${P.caps.join(", ")}) = ${gcd(P.caps[0], P.caps[1])} is reachable.` : ""}` });
      }
      box.addEventListener("click", (e) => {
        const b = e.target.closest("[data-m]");
        if (b) return move(b.dataset.m);
        const j = e.target.closest("[data-pour]");
        if (!j) return;
        const k = +j.dataset.pour;
        if (src == null) { if (s[k] > 0) { src = k; render(); } else api.say("That jug is empty."); return; }
        if (src === k) { src = null; render(); return; }
        move(`p${src}${k}`);
      });
      render();
      return { move };
    },
  });

  /* ===================== Heap Surgeon ===================== */
  const isHeap = (a, max) => a.every((v, i) => i === 0 || (max ? a[(i - 1) >> 1] >= v : a[(i - 1) >> 1] <= v));
  function heapSvg(a, opts = {}) {
    const n = a.length, depth = Math.floor(Math.log2(n)) + 1, W = Math.max(300, 2 ** (depth - 1) * 46), H = depth * 62 + 10;
    const pos = (i) => { const d = Math.floor(Math.log2(i + 1)), k = i + 1 - 2 ** d; return { x: (W / 2 ** d) * (k + 0.5), y: 28 + d * 62 }; };
    let s = "";
    for (let i = 1; i < n; i++) { const p = pos(i), q = pos((i - 1) >> 1); const bad = opts.max ? a[(i - 1) >> 1] < a[i] : a[(i - 1) >> 1] > a[i]; s += `<line class="edge${bad ? " bad" : ""}" x1="${q.x}" y1="${q.y}" x2="${p.x}" y2="${p.y}"/>`; }
    for (let i = 0; i < n; i++) { const p = pos(i); s += `<g class="node${opts.hl === i ? " head" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="Index ${i}, value ${a[i]}"><circle cx="${p.x}" cy="${p.y}" r="18"/><text x="${p.x}" y="${p.y}">${a[i]}</text><text class="ord" x="${p.x + 17}" y="${p.y - 17}">${i}</text></g>`; }
    return `<svg class="diagram heapsvg" viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Heap">${s}</svg>`;
  }
  C.register({
    id: "heap", cat: "state", name: "Heap Surgeon", concept: "Binary heaps",
    blurb: "Restore the heap property by swapping nodes with their parents.",
    tiers: ["Insert: sift up", "Extract-min: sift down", "Heapify a min-heap", "Heapify a max-heap"],
    lesson: `<p>In a min-heap every parent is ≤ its children, and it's stored in an array with children of i at 2i+1 and 2i+2. Red edges show where that rule is broken.</p>
      <p><b>Insert:</b> append at the end and swap upward while smaller than the parent, O(log n). <b>Extract-min:</b> move the last leaf to the root and swap it down with its <i>smaller</i> child, since swapping with the larger child would break the rule again.</p>
      <p><b>Heapify:</b> sift down every internal node from the last parent back to the root. Most nodes are near the bottom and travel only a little, so the total is O(n), not O(n log n).</p>`,
    hint: "Tap a node to swap it with its parent. For sifting down, tap the smaller child (larger, for a max-heap).",
    gen(L, R, t) {
      const max = t === 3;
      if (t <= 1) {
        const n = 6 + Math.floor(((L - 1) % 10) / 2) + (t === 1 ? 2 : 0);
        const vals = R.distinct(n + 1, 1, 60);
        const h = []; vals.slice(0, n).forEach((v) => { h.push(v); let i = h.length - 1; while (i && h[(i - 1) >> 1] > h[i]) { [h[i], h[(i - 1) >> 1]] = [h[(i - 1) >> 1], h[i]]; i = (i - 1) >> 1; } });
        let a, note, sol = [];
        if (t === 0) {
          a = [...h, vals[n]];
          let i = a.length - 1; const b = a.slice();
          while (i && b[(i - 1) >> 1] > b[i]) { sol.push(i); [b[i], b[(i - 1) >> 1]] = [b[(i - 1) >> 1], b[i]]; i = (i - 1) >> 1; }
          note = `<b>${vals[n]}</b> was just appended at index ${a.length - 1}.`;
        } else {
          const min = h[0]; a = h.slice(); a[0] = a.pop();
          const b = a.slice(); let i = 0;
          for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < b.length && b[l] < b[m]) m = l; if (r < b.length && b[r] < b[m]) m = r; if (m === i) break; sol.push(m); [b[i], b[m]] = [b[m], b[i]]; i = m; }
          note = `Extract-min removed <b>${min}</b> and moved the last leaf <b>${a[0]}</b> to the root.`;
        }
        if (sol.length < (t === 0 ? 1 : 2)) return null;
        return { a, max: false, par: sol.length, solution: sol, goal: `${note} Tap a node to swap it with its parent until this is a valid <b>min-heap</b> again. Par is <b>${sol.length}</b> swap${sol.length === 1 ? "" : "s"}.` };
      }
      const n = t === 2 ? 7 + Math.floor((L - 21) / 3) : 10 + Math.floor((L - 31) / 2);
      const a = R.distinct(n, 1, 70);
      const b = a.slice(), sol = [];
      const better = (x, y) => (max ? x > y : x < y);
      for (let s = (n >> 1) - 1; s >= 0; s--) { let i = s; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < n && better(b[l], b[m])) m = l; if (r < n && better(b[r], b[m])) m = r; if (m === i) break; sol.push(m); [b[i], b[m]] = [b[m], b[i]]; i = m; } }
      if (sol.length < 3) return null;
      return { a, max, par: sol.length, solution: sol, goal: `Turn this array into a valid <b>${max ? "max" : "min"}-heap</b>: every parent ${max ? "≥" : "≤"} its children. Tap a node to swap it with its parent. Bottom-up heapify needs <b>${sol.length}</b> swaps.` };
    },
    view(el, P, api) {
      const a = P.a.slice(); let swaps = 0, last = null;
      el.innerHTML = `<div class="figure camp-fig"></div><div class="arr mono"></div>`;
      const fig = el.querySelector(".figure"), arr = el.querySelector(".arr");
      function render() {
        fig.innerHTML = heapSvg(a, { max: P.max, hl: last });
        arr.innerHTML = "Array: [" + a.map((v, i) => (i === last ? `<b>${v}</b>` : v)).join(", ") + "]";
        const bad = a.filter((v, i) => i && (P.max ? a[(i - 1) >> 1] < v : a[(i - 1) >> 1] > v)).length;
        api.stats([["Swaps", swaps], ["Par", P.par], ["Broken edges", bad]]);
      }
      function move(i) {
        if (api.over || i <= 0 || i >= a.length) return;
        const p = (i - 1) >> 1;
        [a[i], a[p]] = [a[p], a[i]]; swaps++; last = p;
        render();
        if (isHeap(a, P.max)) api.win({ stars: C.stars(swaps, P.par, 2), text: `Valid ${P.max ? "max" : "min"}-heap after ${swaps} swaps (par ${P.par}). ${api.tier <= 1 ? "Each sift moves along a single root-to-leaf path, so it's O(log n)." : "Bottom-up heapify does O(n) total work, because half the nodes are leaves that never move."}` });
      }
      C.onPick(fig, "data-i", (v) => move(+v));
      render();
      return { move };
    },
  });
})();
