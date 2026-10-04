/* Backtracking and state-space search: placements on boards, constraint puzzles, counting by search, and move puzzles solved by BFS. */
(function () {
  "use strict";
  const D = window.DSA, PB = D.pb, H = PB.h, U = D.util, C = D.campaign;
  const L3 = (lv, a, b, c) => [a, b, c][lv - 1];
  const LT = U.letters;
  const sum = (x) => x.reduce((s, v) => s + v, 0);
  const num = (o) => ({ w: "num", ...o });
  const yn = (o) => ({ w: "choice", ui: () => ({ opts: ["Yes", "No"] }), ...o });
  const tt = (x) => H.tt(String(x));
  const list = (a) => tt(`[${a.join(", ")}]`);
  const key = (r, c) => r * 100 + c;
  const ops = (o) => PB.opsProblem(o);

  /* ---------- boards ---------- */
  const board = (R, r, c, holes) => { const g = U.range(r).map(() => Array(c).fill("")); let k = 0; for (let t = 0; t < 100 && k < holes; t++) { const y = R.int(0, r - 1), x = R.int(0, c - 1); if (g[y][x] === "") { g[y][x] = "#"; k++; } } return g; };
  const open = (g) => H.cells(g.length, g[0].length).filter(([r, c]) => g[r][c] !== "#");
  const isHole = (g) => (r, c) => g[r][c] === "#";
  // Max placement where pieces only interact within two rows (kings, knights): DP over the last two row masks.
  function rowDP(g, clash) {
    const Rn = g.length, Cn = g[0].length, masks = U.range(1 << Cn).filter((m) => U.range(Cn).every((c) => !((m >> c) & 1) || g[0] && true));
    const rowOK = (r, m) => U.range(Cn).every((c) => !((m >> c) & 1) || g[r][c] !== "#") && U.range(Cn).every((a) => U.range(Cn).every((b) => a >= b || !((m >> a) & 1) || !((m >> b) & 1) || !clash(0, a, 0, b)));
    const pairOK = (m1, m2, dr) => U.range(Cn).every((a) => !((m1 >> a) & 1) || U.range(Cn).every((b) => !((m2 >> b) & 1) || !clash(0, a, dr, b)));
    const memo = new Map();
    const go = (r, p1, p2) => {
      if (r === Rn) return [0, []];
      const k = `${r},${p1},${p2}`;
      if (memo.has(k)) return memo.get(k);
      let best = [-1, []];
      for (const m of masks) {
        if (!rowOK(r, m) || !pairOK(p1, m, 1) || !pairOK(p2, m, 2)) continue;
        const [v, rest] = go(r + 1, m, p1);
        const tot = v + U.range(Cn).filter((c) => (m >> c) & 1).length;
        if (tot > best[0]) best = [tot, [m, ...rest]];
      }
      memo.set(k, best);
      return best;
    };
    const [, ms] = go(0, 0, 0);
    const out = [];
    ms.forEach((m, r) => U.range(Cn).forEach((c) => { if ((m >> c) & 1) out.push([r, c]); }));
    return out;
  }
  const kingClash = (r1, c1, r2, c2) => Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2)) <= 1;
  const knightClash = (r1, c1, r2, c2) => { const a = Math.abs(r1 - r2), b = Math.abs(c1 - c2); return (a === 1 && b === 2) || (a === 2 && b === 1); };
  // Max bipartite matching (Kuhn) returning matched edge ids.
  function matching(nL, adjL) {
    const mR = new Map(), mL = Array(nL).fill(null);
    const tryK = (u, seen) => { for (const [v, id] of adjL[u]) { if (seen.has(v)) continue; seen.add(v); if (!mR.has(v) || tryK(mR.get(v)[0], seen)) { mR.set(v, [u, id]); mL[u] = id; return true; } } return false; };
    for (let u = 0; u < nL; u++) tryK(u, new Set());
    return [...mR.values()].map((x) => x[1]);
  }
  // Segments along a direction, broken by holes: returns segment id per open cell.
  function segs(g, dr, dc) {
    const id = new Map(); let n = 0;
    for (const [r, c] of open(g)) { const pr = r - dr, pc = c - dc; if (pr >= 0 && pc >= 0 && pc < g[0].length && g[pr][pc] !== "#") id.set(key(r, c), id.get(key(pr, pc))); else id.set(key(r, c), n++); }
    return [id, n];
  }
  function lineAttack(g, cells, dirs) {
    const S = new Set(cells.map(([r, c]) => key(r, c)));
    for (const [r, c] of cells) for (const [dr, dc] of dirs) { let y = r + dr, x = c + dc; while (y >= 0 && x >= 0 && y < g.length && x < g[0].length && g[y][x] !== "#") { if (S.has(key(y, x))) return true; y += dr; x += dc; } }
    return false;
  }
  const ROOK = [[0, 1], [1, 0], [0, -1], [-1, 0]], BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]], QUEEN = [...ROOK, ...BISHOP];
  const placeWithSegs = (g, d1, d2) => { const [a] = segs(g, ...d1), [b, nb] = segs(g, ...d2); void nb; const cells = open(g), adj = []; cells.forEach(([r, c], i) => { const u = a.get(key(r, c)); (adj[u] = adj[u] || []).push([b.get(key(r, c)), i]); }); for (let i = 0; i < adj.length; i++) adj[i] = adj[i] || []; return matching(adj.length, adj).map((i) => cells[i]); };
  const gridUI = (extra) => (I) => ({ grid: I.g.map((row) => row.map((v) => (v === "#" ? "" : v))), blocked: isHole(I.g), ...(extra ? extra(I) : {}) });

  function nQueens(n, fixed = []) {
    const out = [], cols = Array(n).fill(-1);
    fixed.forEach(([r, c]) => (cols[r] = c));
    const ok = (r, c) => U.range(n).every((y) => y === r || cols[y] < 0 || (cols[y] !== c && Math.abs(cols[y] - c) !== Math.abs(y - r)));
    const go = (r) => { if (out.length > 1) return; if (r === n) { out.push(cols.slice()); return; } if (fixed.some((f) => f[0] === r)) { if (ok(r, cols[r])) go(r + 1); return; } for (let c = 0; c < n; c++) if (ok(r, c)) { cols[r] = c; go(r + 1); cols[r] = -1; } };
    go(0);
    return out;
  }
  const countQueens = (n) => { let cnt = 0; const cols = new Set(), d1 = new Set(), d2 = new Set(); const go = (r) => { if (r === n) { cnt++; return; } for (let c = 0; c < n; c++) { if (cols.has(c) || d1.has(r + c) || d2.has(r - c)) continue; cols.add(c); d1.add(r + c); d2.add(r - c); go(r + 1); cols.delete(c); d1.delete(r + c); d2.delete(r - c); } }; go(0); return cnt; };

  function mineNums(R, Cn, mines) { const M = new Set(mines.map(([r, c]) => key(r, c))); return U.range(R).map((r) => U.range(Cn).map((c) => (M.has(key(r, c)) ? -1 : H.count(PB.MOVES["8"], ([dr, dc]) => M.has(key(r + dr, c + dc)))))); }
  function nonoClues(line) { const out = []; let k = 0; line.forEach((x) => { if (x) k++; else if (k) { out.push(k); k = 0; } }); if (k) out.push(k); return out.length ? out : [0]; }
  function nonoCount(rows, cols, Cn, limit = 2) {
    const pats = (clue) => U.range(1 << Cn).map((m) => U.range(Cn).map((c) => (m >> c) & 1)).filter((l) => nonoClues(l).join() === clue.join());
    const P = rows.map(pats), grid = [], sols = [];
    const colOK = (full) => cols.every((cl, c) => { const col = grid.map((r) => r[c]); if (full) return nonoClues(col).join() === cl.join(); const runs = nonoClues(col); return sum(runs) <= sum(cl); });
    const go = (r) => { if (sols.length >= limit) return; if (r === rows.length) { if (colOK(true)) sols.push(grid.map((x) => x.slice())); return; } for (const p of P[r]) { grid.push(p); if (colOK(false)) go(r + 1); grid.pop(); } };
    go(0);
    return sols;
  }
  function tilings(g) {
    const Rn = g.length, Cn = g[0].length, used = g.map((r) => r.map((v) => v === "#"));
    const go = () => { let p = -1; for (let i = 0; i < Rn * Cn && p < 0; i++) if (!used[Math.floor(i / Cn)][i % Cn]) p = i; if (p < 0) return 1; const r = Math.floor(p / Cn), c = p % Cn; let t = 0; used[r][c] = true; if (c + 1 < Cn && !used[r][c + 1]) { used[r][c + 1] = true; t += go(); used[r][c + 1] = false; } if (r + 1 < Rn && !used[r + 1][c]) { used[r + 1][c] = true; t += go(); used[r + 1][c] = false; } used[r][c] = false; return t; };
    return go();
  }
  // Exact arithmetic search for Countdown / 24.
  function reach(nums, target, useAll) {
    const go = (a) => {
      if (!useAll && a.some((x) => Math.abs(x - target) < 1e-9)) return true;
      if (a.length === 1) return Math.abs(a[0] - target) < 1e-9;
      for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length; j++) {
        if (i === j) continue;
        const rest = a.filter((_, k) => k !== i && k !== j), x = a[i], y = a[j];
        const cand = [x + y, x - y, x * y]; if (Math.abs(y) > 1e-9) cand.push(x / y);
        for (const v of cand) if (go([...rest, v])) return true;
      }
      return false;
    };
    return go(nums);
  }
  function circ(n, edges) { const W = 300, Hh = 240; return { n, edges, W, H: Hh, nodes: U.range(n).map((i) => ({ x: W / 2 + 110 * Math.cos(-Math.PI / 2 + (2 * Math.PI * i) / n), y: Hh / 2 + 95 * Math.sin(-Math.PI / 2 + (2 * Math.PI * i) / n) })) }; }
  const figG = (G, o = {}) => `<div class="figure camp-fig">${C.svgGraph(G, o)}</div>`;
  const NAMES = "Ava Ben Cal Dee Eli Fay Gus".split(" ");

  PB.addAll("backtrack", [
    /* ----- placing pieces ----- */
    { id: "max-kings", name: "Most Non-Attacking Kings", tags: "Row-profile DP", w: "gpick", vname: "kings:",
      gen: (lv, R) => ({ g: board(R, L3(lv, 3, 4, 5), L3(lv, 4, 5, 5), L3(lv, 1, 2, 3)) }),
      ui: gridUI(),
      text: "Place as many kings as possible on the open squares so that no two attack each other (kings attack all 8 neighbours).",
      valid: (I, s) => !s.some((a, i) => s.some((b, j) => i < j && kingClash(...a, ...b))) || "two kings attack each other", val: (I, s) => s.length,
      solve: (I) => rowDP(I.g, kingClash),
      why: () => `Kings only interact with adjacent rows, so DP over rows with the previous row's bitmask as state. (Ignoring holes, ⌈r/2⌉·⌈c/2⌉ is optimal.)` },
    { id: "max-knights", name: "Most Non-Attacking Knights", tags: "Row-profile DP / bipartite", w: "gpick", vname: "knights:",
      gen: (lv, R) => ({ g: board(R, L3(lv, 3, 4, 4), L3(lv, 3, 4, 5), L3(lv, 1, 2, 3)) }),
      ui: gridUI(),
      text: "Place as many knights as possible on the open squares so that no two attack each other.",
      valid: (I, s) => !s.some((a, i) => s.some((b, j) => i < j && knightClash(...a, ...b))) || "two knights attack each other", val: (I, s) => s.length,
      solve: (I) => rowDP(I.g, knightClash),
      why: () => `A knight always jumps to the opposite colour, so the attack graph is bipartite: max independent set = cells − max matching (König). Here, DP over two previous rows also works.` },
    { id: "max-rooks-walls", name: "Rooks Behind Walls", tags: "Bipartite matching of row/column segments", w: "gpick", vname: "rooks:",
      gen: (lv, R) => ({ g: board(R, L3(lv, 4, 5, 6), L3(lv, 4, 5, 6), L3(lv, 3, 5, 7)) }),
      ui: gridUI(),
      text: "Dark squares are walls that block attacks. Place as many rooks as possible on open squares with no two attacking each other.",
      valid: (I, s) => !lineAttack(I.g, s, ROOK) || "two rooks see each other", val: (I, s) => s.length,
      solve: (I) => placeWithSegs(I.g, [0, 1], [1, 0]),
      why: () => `Every open cell lies on one horizontal segment and one vertical segment. A rook uses up both, so the answer is a maximum matching between row segments and column segments.` },
    { id: "max-bishops-walls", name: "Bishops Behind Walls", tags: "Matching on diagonal segments", w: "gpick", vname: "bishops:",
      gen: (lv, R) => ({ g: board(R, L3(lv, 4, 5, 5), L3(lv, 4, 5, 6), L3(lv, 2, 3, 4)) }),
      ui: gridUI(),
      text: "Walls (dark) block attacks. Place as many bishops as possible on open squares with no two attacking each other.",
      valid: (I, s) => !lineAttack(I.g, s, BISHOP) || "two bishops see each other", val: (I, s) => s.length,
      solve: (I) => placeWithSegs(I.g, [1, 1], [1, -1]),
      why: () => `Same trick as rooks with the two diagonal directions: each cell is one ↘ segment and one ↙ segment, and bishops form a matching.` },
    { id: "queen-domination", name: "Queen Domination", tags: "Search by increasing k", w: "gpick", sense: "min", vname: "queens:",
      gen: (lv) => ({ g: board({ int: () => 0 }, L3(lv, 4, 5, 6), L3(lv, 4, 5, 6), 0) }),
      ui: gridUI(),
      text: "Place as few queens as possible so that every square is occupied or attacked.",
      valid: (I, s) => { const n = I.g.length, m = I.g[0].length; return H.cells(n, m).every(([r, c]) => s.some(([y, x]) => y === r || x === c || Math.abs(y - r) === Math.abs(x - c))) || "some square is safe"; },
      val: (I, s) => s.length,
      solve: (I) => { const cells = H.cells(I.g.length, I.g[0].length); for (let k = 1; k <= 4; k++) for (const comb of PB.gen.combos(cells.length, k)) { const s = comb.map((i) => cells[i]); if (cells.every(([r, c]) => s.some(([y, x]) => y === r || x === c || Math.abs(y - r) === Math.abs(x - c)))) return s; } return null; },
      why: () => `Try k = 1, 2, … and backtrack over placements, pruning when the remaining queens can't cover the remaining rows. 5×5 and 6×6 boards need 3 queens; 8×8 needs 5.` },
    { id: "complete-queens", name: "Complete the n Queens", tags: "Backtracking with fixed rows", w: "gpick",
      gen: (lv, R) => { const n = L3(lv, 5, 6, 8); for (let t = 0; t < 40; t++) { const all = []; const cols = Array(n).fill(-1); const go = (r) => { if (all.length > 20) return; if (r === n) { all.push(cols.slice()); return; } for (const c of R.shuffle(U.range(n))) { if (U.range(r).every((y) => cols[y] !== c && Math.abs(cols[y] - c) !== r - y)) { cols[r] = c; go(r + 1); } } }; go(0); const sol = R.pick(all); const fixed = R.sample(U.range(n), L3(lv, 2, 2, 3)).map((r) => [r, sol[r]]); const s = nQueens(n, fixed); if (s.length === 1) return { n, fixed, sol: s[0] }; } return null; },
      ui: (I) => ({ grid: U.range(I.n).map((r) => U.range(I.n).map((c) => (I.fixed.some((f) => f[0] === r && f[1] === c) ? "♛" : ""))), cls: (r, c) => (I.fixed.some((f) => f[0] === r && f[1] === c) ? "mark" : "") }),
      text: (I) => `${I.fixed.length} queens are already placed (♛). Select squares for the other ${I.n - I.fixed.length} so that no two of the ${I.n} queens attack each other.`,
      accept: (I, s) => { const all = [...I.fixed, ...s.filter(([r, c]) => !I.fixed.some((f) => f[0] === r && f[1] === c))]; if (all.length !== I.n) return `you need ${I.n} queens in total`; return all.every((a, i) => all.every((b, j) => i >= j || (a[0] !== b[0] && a[1] !== b[1] && Math.abs(a[0] - b[0]) !== Math.abs(a[1] - b[1])))) || "two queens attack each other"; },
      ans: (I) => U.range(I.n).filter((r) => !I.fixed.some((f) => f[0] === r)).map((r) => [r, I.sol[r]]),
      why: () => `Place row by row, keeping sets of used columns and both diagonals (r + c and r − c); skip the fixed rows. Each conflict check is O(1).` },
    num({ id: "n-queens-count", name: "Count n-Queens Solutions", tags: "Backtracking with bitmasks",
      gen: (lv) => ({ n: L3(lv, 5, 6, 8) }),
      text: (I) => `In how many ways can ${I.n} non-attacking queens be placed on an ${I.n} × ${I.n} board?`,
      ans: (I) => countQueens(I.n),
      why: () => `Row by row with bitmasks for columns and diagonals: available = ~(cols | d1 | d2); take the lowest bit each time. 4 → 2, 5 → 10, 6 → 4, 8 → 92.` }),
    num({ id: "rook-permanent", name: "Rooks on a Board With Forbidden Squares", tags: "Permanent by backtracking",
      gen: (lv, R) => { const n = L3(lv, 3, 4, 5); return { n, g: board(R, n, n, L3(lv, 2, 4, 6)) }; },
      text: (I) => `In how many ways can ${I.n} non-attacking rooks be placed on this ${I.n} × ${I.n} board, avoiding the dark squares?<div class="mono strong">${I.g.map((r) => r.map((v) => (v === "#" ? "■" : "·")).join(" ")).join("<br>")}</div>`,
      ans: (I) => { const n = I.n, used = Array(n).fill(false); const go = (r) => { if (r === n) return 1; let t = 0; for (let c = 0; c < n; c++) if (!used[c] && I.g[r][c] !== "#") { used[c] = true; t += go(r + 1); used[c] = false; } return t; }; return go(0); },
      reject: (I, s) => s === 0,
      why: () => `One rook per row, each in a distinct allowed column: that's the permanent of the 0/1 matrix. Backtracking (or Ryser's inclusion–exclusion formula) counts it.` }),
    num({ id: "domino-tilings-holes", name: "Domino Tilings With Holes", tags: "Fill the first empty cell",
      gen: (lv, R) => { const g = board(R, L3(lv, 3, 4, 4), L3(lv, 4, 4, 6), L3(lv, 2, 2, 4)); return open(g).length % 2 ? null : { g }; },
      text: (I) => `In how many ways can the open squares be tiled with 1 × 2 dominoes?<div class="mono strong">${I.g.map((r) => r.map((v) => (v === "#" ? "■" : "·")).join(" ")).join("<br>")}</div>`,
      ans: (I) => tilings(I.g),
      reject: (I, s) => s < 2,
      why: () => `Always cover the first empty cell (row-major): it must be the left/top end of a domino, so there are only two choices. Broken-profile DP makes it fast for wide boards.` }),
    { id: "minesweeper", name: "Minesweeper Deduction", tags: "Constraint satisfaction", w: "gpick",
      gen: (lv, R) => { const r = L3(lv, 4, 5, 5), c = L3(lv, 4, 5, 6), k = L3(lv, 3, 4, 6); const cells = H.cells(r, c), mines = R.sample(cells, k), M = new Set(mines.map(([y, x]) => key(y, x))), nums = mineNums(r, c, mines); const safe = R.shuffle(cells.filter(([y, x]) => !M.has(key(y, x)))); const shown = new Set(); const unique = (sh) => { const hidden = cells.filter(([a, b]) => !sh.has(key(a, b))); if (hidden.length > 16) return false; let cnt = 0; for (const comb of PB.gen.combos(hidden.length, k)) { const S = new Set(comb.map((i) => key(...hidden[i]))); if ([...sh].every((kk) => { const yy = Math.floor(kk / 100), xx = kk % 100; return H.count(PB.MOVES["8"], ([dr, dc]) => S.has(key(yy + dr, xx + dc))) === nums[yy][xx]; })) { if (++cnt > 1) return false; } } return cnt === 1; }; for (const [y, x] of safe) { shown.add(key(y, x)); const hidden = cells.filter(([a, b]) => !shown.has(key(a, b))); if (hidden.length > 14) continue; let count = 0; for (const comb of PB.gen.combos(hidden.length, k)) { const S = new Set(comb.map((i) => key(...hidden[i]))); if ([...shown].every((kk) => { const yy = Math.floor(kk / 100), xx = kk % 100; return H.count(PB.MOVES["8"], ([dr, dc]) => S.has(key(yy + dr, xx + dc))) === nums[yy][xx]; })) { count++; if (count > 1) break; } } if (count === 1) { for (const kk of R.shuffle([...shown])) { shown.delete(kk); if (!unique(shown)) shown.add(kk); } return { r, c, k, mines: mines.map((m) => m.slice()).sort((a, b) => a[0] - b[0] || a[1] - b[1]), shown: [...shown].sort((a, b) => a - b), nums }; } } return null; },
      ui: (I) => ({ grid: U.range(I.r).map((y) => U.range(I.c).map((x) => (I.shown.includes(key(y, x)) ? String(I.nums[y][x]) : ""))), cls: (y, x) => (I.shown.includes(key(y, x)) ? "rev" : "") }),
      text: (I) => `There are exactly <b>${I.k}</b> mines. Numbered squares are safe and show how many of their 8 neighbours are mines. Select every mine.`,
      ans: (I) => I.mines,
      why: () => `Each number is a constraint on its hidden neighbours. Backtracking over hidden squares (pruning when a constraint can no longer be met) finds the only consistent layout; real solvers first apply simple deductions.` },
    { id: "nonogram", name: "Nonogram", tags: "Line patterns + column pruning", w: "gpick",
      gen: (lv, R) => { const n = L3(lv, 4, 5, 6); for (let t = 0; t < 60; t++) { const g = U.range(n).map(() => U.range(n).map(() => (R.chance(0.58) ? 1 : 0))); const rows = g.map(nonoClues), cols = U.range(n).map((c) => nonoClues(g.map((r) => r[c]))); if (nonoCount(rows, cols, n).length === 1) return { n, g, rows, cols }; } return null; },
      ui: (I) => ({ grid: [["", ...I.cols.map((c) => c.join("·"))], ...I.rows.map((r) => [r.join("·"), ...Array(I.n).fill("")])], blocked: (r, c) => r === 0 || c === 0, cls: (r, c) => (r === 0 || c === 0 ? "clue" : "") }),
      text: "Fill squares so that each row and column has runs of filled squares with exactly the lengths shown (in order).",
      ans: (I) => { const out = []; I.g.forEach((row, r) => row.forEach((v, c) => { if (v) out.push([r + 1, c + 1]); })); return out; },
      why: () => `Enumerate the patterns that fit each row's clue, place rows one by one, and prune as soon as some column already has more filled squares than its clue allows.` },

    /* ----- splitting into groups ----- */
    { id: "partition-k-equal", name: "Partition Into k Equal-Sum Subsets", tags: "Backtracking by bucket", w: "groups",
      gen: (lv, R) => { const k = L3(lv, 2, 3, 3), target = R.int(L3(lv, 8, 10, 14), L3(lv, 14, 18, 22)); const a = [], g = []; for (let b = 0; b < k; b++) { let left = target; const parts = []; while (left > 0) { const x = Math.min(left, R.int(1, Math.max(2, Math.floor(target / 2)))); parts.push(x); left -= x; } if (parts.length < 2) return null; parts.forEach((x) => { a.push(x); g.push(b); }); } const ord = R.shuffle(U.range(a.length)); return a.length <= 10 ? { a: ord.map((i) => a[i]), g0: ord.map((i) => g[i]), k } : null; },
      ui: (I) => ({ k: I.k, names: U.range(I.k).map((b) => "Set " + (b + 1)), sumLabel: (xs) => "Σ" + sum(xs) }),
      text: (I) => `Split the numbers into ${I.k} groups with equal sums.`,
      accept: (I, g) => { const s = U.range(I.k).map((b) => sum(I.a.filter((_, i) => g[i] === b))); return s.every((x) => x === s[0]) || `the sums are ${s.join(", ")}`; },
      ans: (I) => I.g0,
      why: () => `Each group must sum to total / k. Place numbers largest first into buckets, skipping a bucket if an identical bucket already failed. Heavy pruning makes it fast.` },
    { id: "tug-of-war", name: "Tug of War", tags: "Equal-size halves, closest sums", w: "groups", sense: "min", vname: "a difference of",
      gen: (lv, R) => ({ a: R.arr(L3(lv, 6, 8, 10), 1, 30) }),
      ui: () => ({ k: 2, names: ["Team 1", "Team 2"], sumLabel: (xs) => `${xs.length} people, Σ${sum(xs)}` }),
      text: "Split the people into two teams of equal size so the total strengths are as close as possible.",
      valid: (I, g) => H.count(g, (x) => x === 0) === I.a.length / 2 || "teams must have equal size",
      val: (I, g) => Math.abs(sum(I.a.filter((_, i) => g[i] === 0)) - sum(I.a.filter((_, i) => g[i] === 1))),
      why: () => `Backtrack choosing n/2 people for team 1 (C(n, n/2) options), or meet in the middle: split into halves and match subset sums by size.` },
    { id: "seat-enemies", name: "Separate the Rivals", tags: "Graph colouring with capacities", w: "groups",
      gen: (lv, R) => { const n = L3(lv, 5, 6, 7), k = L3(lv, 2, 3, 3), cap = Math.ceil(n / k); const g0 = R.shuffle(U.range(n).map((i) => i % k)); const pairs = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (g0[a] !== g0[b] && R.chance(0.45)) pairs.push([a, b]); return pairs.length >= n - 1 ? { n, k, cap, pairs, g0 } : null; },
      ui: (I) => ({ items: NAMES.slice(0, I.n), k: I.k, names: U.range(I.k).map((b) => "Room " + (b + 1)) }),
      text: (I) => `Put everyone into ${I.k} rooms of at most ${I.cap} people so that no two rivals share a room. Rivals: ${I.pairs.map(([a, b]) => tt(`${NAMES[a]}–${NAMES[b]}`)).join(" ")}.`,
      accept: (I, g) => { if (U.range(I.k).some((b) => H.count(g, (x) => x === b) > I.cap)) return "a room is over capacity"; const bad = I.pairs.find(([a, b]) => g[a] === g[b]); return !bad || `${NAMES[bad[0]]} and ${NAMES[bad[1]]} share a room`; },
      ans: (I) => I.g0,
      why: () => `Assign people one at a time to a room with space and no rival in it; backtrack on dead ends. Choosing the most constrained person first prunes enormously.` },
    { id: "exam-timetabling", name: "Exam Timetabling", tags: "Chromatic number by search", w: "groups", sense: "min", vname: "slots:",
      gen: (lv, R) => { const n = L3(lv, 5, 6, 7), names = "Alg Bio Chem DB Econ Fr Geo".split(" ").slice(0, n), edges = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (R.chance(0.45)) edges.push([a, b]); return { n, names, edges }; },
      ui: (I) => ({ items: I.names, k: 4, names: ["Mon", "Tue", "Wed", "Thu"] }),
      text: (I) => `Exams sharing a student can't be on the same day. Clashes: ${I.edges.map(([a, b]) => tt(`${I.names[a]}–${I.names[b]}`)).join(" ")}. Schedule every exam using as few different days as possible.`,
      valid: (I, g) => { const bad = I.edges.find(([a, b]) => g[a] === g[b]); return !bad || `${I.names[bad[0]]} and ${I.names[bad[1]]} clash`; },
      val: (I, g) => new Set(g).size,
      why: () => `This is graph colouring: try k = 1, 2, 3, … colours and backtrack, colouring the vertex with the most coloured neighbours first (DSATUR).` },

    /* ----- choosing subsets ----- */
    { id: "max-unique-concat", name: "Longest Concatenation With Unique Letters", tags: "Bitmask backtracking", w: "pick", vname: "a length of",
      gen: (lv, R) => ({ a: U.range(L3(lv, 5, 7, 9)).map(() => R.str(R.int(1, 4), "abcdefghij")) }),
      ui: () => ({ style: "tiles", wrapRow: true }),
      text: "Select strings whose concatenation has no repeated letter, making it as long as possible.",
      valid: (I, s) => { const t = s.map((i) => I.a[i]).join(""); return new Set(t).size === t.length || "a letter repeats"; },
      val: (I, s) => sum(s.map((i) => I.a[i].length)),
      why: () => `Represent each usable string as a 26-bit mask; backtrack keeping the union mask and skip strings that overlap it (or that repeat letters themselves).` },
    { id: "max-score-words", name: "Maximum Score Words From Letters", tags: "Subset search with letter counts", w: "pick", vname: "a score of",
      gen: (lv, R) => { const words = U.range(L3(lv, 4, 5, 6)).map(() => R.str(R.int(2, 4), "abcde")); return { words, letters: R.str(L3(lv, 6, 8, 10), "abcde").split("").sort().join(""), sc: { a: 1, b: 3, c: 3, d: 2, e: 1 } }; },
      ui: (I) => ({ items: I.words, style: "tiles", wrapRow: true }),
      text: (I) => `Letters available: ${tt(I.letters)} (each usable once). Scores: a=1 b=3 c=3 d=2 e=1. Select words to spell with the highest total score.`,
      valid: (I, s) => { const need = H.cnt(s.map((i) => I.words[i]).join("")), have = H.cnt(I.letters); return [...need].every(([c, k]) => (have.get(c) || 0) >= k) || "not enough letters"; },
      val: (I, s) => sum([...s.map((i) => I.words[i]).join("")].map((c) => I.sc[c])),
      reject: (I, s) => s.length < 1,
      why: () => `With few words, try every subset (2ⁿ) and check letter counts; backtracking prunes as soon as some letter runs out.` },
    { id: "knights-and-knaves", name: "Knights and Knaves", tags: "Try every truth assignment", w: "pick",
      gen: (lv, R) => { const n = L3(lv, 3, 4, 5); for (let t = 0; t < 100; t++) { const truth = U.range(n).map(() => R.chance(0.5)); const st = U.range(n).map((i) => { const kind = R.int(0, 2), j = R.pick(U.range(n).filter((x) => x !== i)), k = R.pick(U.range(n).filter((x) => x !== i && x !== j)); return kind === 0 ? { t: "is", j, v: R.chance(0.5) } : kind === 1 ? { t: "same", j, k } : { t: "count", v: R.int(0, n) }; }); const holds = (T, i) => { const s = st[i]; return s.t === "is" ? T[s.j] === s.v : s.t === "same" ? T[s.j] === T[s.k] : H.count(T, Boolean) === s.v; }; const sols = []; for (let m = 0; m < 1 << n; m++) { const T = U.range(n).map((i) => !!((m >> i) & 1)); if (U.range(n).every((i) => holds(T, i) === T[i])) sols.push(m); } if (sols.length === 1) return { n, st, m: sols[0] }; } return null; },
      ui: (I) => ({ items: NAMES.slice(0, I.n), style: "tiles" }),
      text: (I) => `Knights always tell the truth; knaves always lie. ${I.st.map((s, i) => `<b>${NAMES[i]}</b>: "${s.t === "is" ? `${NAMES[s.j]} is a ${s.v ? "knight" : "knave"}.` : s.t === "same" ? `${NAMES[s.j]} and ${NAMES[s.k]} are the same kind.` : `Exactly ${s.v} of us ${s.v === 1 ? "is a knight" : "are knights"}.`}"`).join(" ")} Select all the knights.`,
      ans: (I) => U.range(I.n).filter((i) => (I.m >> i) & 1),
      why: () => `Each person's statement must be true exactly when they are a knight. With n people try all 2ⁿ assignments (or backtrack, checking statements as soon as their subjects are fixed).` },

    /* ----- ordering puzzles ----- */
    { id: "seating-puzzle", name: "Round-Table Seating", tags: "Permutation search with constraints", w: "order",
      gen: (lv, R) => { const n = L3(lv, 4, 5, 6); for (let t = 0; t < 60; t++) { const seat = [0, ...R.shuffle(U.range(n - 1).map((i) => i + 1))]; const pos = []; seat.forEach((p, i) => (pos[p] = i)); const adj = (a, b) => { const d = Math.abs(pos[a] - pos[b]); return d === 1 || d === n - 1; }; const cons = []; for (let k = 0; k < 2 * n; k++) { const a = R.int(0, n - 1); let b; do b = R.int(0, n - 1); while (b === a); const yes = adj(a, b); if (yes || R.chance(0.6)) cons.push([a, b, yes]); } const ok = (arr) => { const p = []; arr.forEach((x, i) => (p[x] = i)); return cons.every(([a, b, y]) => { const d = Math.abs(p[a] - p[b]); return (d === 1 || d === n - 1) === y; }); }; let cnt = 0; for (const perm of PB.gen.perms(n - 1)) { if (ok([0, ...perm.map((x) => x + 1)])) cnt++; if (cnt > 2) break; } if (cnt === 2) return { n, cons: [...new Map(cons.map((c) => [c.slice(0, 2).sort().join(), c])).values()], seat }; } return null; },
      ui: (I) => ({ items: NAMES.slice(0, I.n) }),
      text: (I) => `${I.n} friends sit around a round table. Clues: ${I.cons.map(([a, b, y]) => `${NAMES[a]} ${y ? "sits next to" : "does not sit next to"} ${NAMES[b]}`).join("; ")}. Click the names clockwise starting with ${NAMES[0]}.`,
      accept: (I, o) => { if (o[0] !== 0) return `start with ${NAMES[0]}`; const p = []; o.forEach((x, i) => (p[x] = i)); const bad = I.cons.find(([a, b, y]) => { const d = Math.abs(p[a] - p[b]); return (d === 1 || d === I.n - 1) !== y; }); return !bad || `${NAMES[bad[0]]} ${bad[2] ? "must" : "must not"} sit next to ${NAMES[bad[1]]}`; },
      ans: (I) => I.seat,
      why: () => `Fix one person's seat to remove rotations, then fill seats one at a time, checking each clue as soon as both people are seated. (The mirror image also works, since the clues are symmetric.)` },
    { id: "race-ranking", name: "Who Finished Where?", tags: "Constraint search over permutations", w: "order",
      gen: (lv, R) => { const n = L3(lv, 4, 5, 6); for (let t = 0; t < 80; t++) { const rank = R.shuffle(U.range(n)); const pos = []; rank.forEach((p, i) => (pos[p] = i)); const cons = []; for (let k = 0; k < n + 2; k++) { const a = R.int(0, n - 1); let b; do b = R.int(0, n - 1); while (b === a); const kind = R.int(0, 2); if (kind === 0) cons.push(["before", a, b, pos[a] < pos[b]]); else if (kind === 1) cons.push(["adjacent", a, b, Math.abs(pos[a] - pos[b]) === 1]); else cons.push(["place", a, pos[a] === 0 ? "first" : pos[a] === n - 1 ? "last" : "middle"]); } const ok = (o) => { const p = []; o.forEach((x, i) => (p[x] = i)); return cons.every((c) => (c[0] === "before" ? (p[c[1]] < p[c[2]]) === c[3] : c[0] === "adjacent" ? (Math.abs(p[c[1]] - p[c[2]]) === 1) === c[3] : (p[c[1]] === 0 ? "first" : p[c[1]] === n - 1 ? "last" : "middle") === c[2])); }; let cnt = 0; for (const perm of PB.gen.perms(n)) { if (ok(perm)) cnt++; if (cnt > 1) break; } if (cnt === 1) return { n, cons, rank }; } return null; },
      ui: (I) => ({ items: NAMES.slice(0, I.n) }),
      text: (I) => `Clues about a race: ${I.cons.map((c) => (c[0] === "before" ? `${NAMES[c[1]]} finished ${c[3] ? "ahead of" : "behind"} ${NAMES[c[2]]}` : c[0] === "adjacent" ? `${NAMES[c[1]]} and ${NAMES[c[2]]} finished ${c[3] ? "next to each other" : "not next to each other"}` : c[2] === "middle" ? `${NAMES[c[1]]} was neither first nor last` : `${NAMES[c[1]]} was ${c[2]}`)).join("; ")}. Click the runners from first to last.`,
      ans: (I) => I.rank,
      why: () => `Generate finishing orders position by position and reject a partial order as soon as a clue whose people are both placed is violated.` },

    /* ----- counting by search ----- */
    num({ id: "combination-sum-ii", name: "Combination Sum II (count)", tags: "Skip duplicates at each depth",
      gen: (lv, R) => ({ a: R.arr(L3(lv, 5, 7, 9), 1, 8).sort((x, y) => x - y), t: L3(lv, 8, 10, 12) }),
      text: (I) => `Using each element of ${list(I.a)} at most once, how many different combinations (as multisets) sum to ${I.t}?`,
      ans: (I) => { let c = 0; const go = (i, s) => { if (s === I.t) { c++; return; } for (let j = i; j < I.a.length; j++) { if (j > i && I.a[j] === I.a[j - 1]) continue; if (s + I.a[j] > I.t) break; go(j + 1, s + I.a[j]); } }; go(0, 0); return c; },
      reject: (I, s) => s < 2,
      why: () => `Sort, then at each recursion depth skip an element equal to the one just tried: that's what makes equal multisets appear once.` }),
    num({ id: "combination-sum-iii", name: "Combination Sum III", tags: "Choose k distinct digits",
      gen: (lv, R) => { const k = L3(lv, 2, 3, 4); return { k, n: R.int(k + 3, 9 * k - 8) }; },
      text: (I) => `How many sets of ${I.k} distinct digits from 1–9 add up to ${I.n}?`,
      ans: (I) => H.count([...PB.gen.combos(9, I.k)], (c) => sum(c) + I.k === I.n),
      reject: (I, s) => s === 0,
      why: () => `Backtrack over increasing digits, stopping when the sum exceeds n or too few digits remain.` }),
    num({ id: "subsets-with-dup", name: "Distinct Subsets With Duplicates", tags: "Π (count + 1)",
      gen: (lv, R) => ({ a: R.arr(L3(lv, 4, 6, 8), 1, L3(lv, 3, 4, 4)) }),
      text: (I) => `How many distinct sub-multisets (including the empty one) does ${list(I.a)} have?`,
      ans: (I) => [...H.cnt(I.a).values()].reduce((p, c) => p * (c + 1), 1),
      why: () => `For each distinct value, choose how many copies (0…count). Backtracking that skips equal siblings enumerates exactly these.` }),
    num({ id: "unique-permutations", name: "Distinct Permutations", tags: "Multinomial",
      gen: (lv, R) => ({ s: R.str(L3(lv, 4, 6, 8), "aabbc") }),
      text: (I) => `How many distinct arrangements of the letters ${tt(I.s)} are there?`,
      ans: (I) => { const f = (n) => (n <= 1 ? 1 : n * f(n - 1)); return f(I.s.length) / [...H.cnt(I.s).values()].reduce((p, c) => p * f(c), 1); },
      why: () => `n! / Π cᵢ! (divide out swaps of equal letters). Generating them, sort and skip a letter equal to the previous unused one.` }),
    num({ id: "letter-tiles", name: "Letter Tile Possibilities", tags: "Backtracking over counts",
      gen: (lv, R) => ({ s: R.str(L3(lv, 3, 4, 6), "AAB" + (lv === 3 ? "C" : "")) }),
      text: (I) => `You have tiles ${tt(I.s)}. How many different non-empty sequences can you form using some of them?`,
      ans: (I) => { const c = [...H.cnt(I.s).values()]; const go = () => { let t = 0; c.forEach((k, i) => { if (!k) return; c[i]--; t += 1 + go(); c[i]++; }); return t; }; return go(); },
      why: () => `DFS over letter counts: at each step pick any letter with copies left, count the new sequence, recurse, restore.` }),
    num({ id: "beautiful-arrangement", name: "Beautiful Arrangements", tags: "Backtracking by position",
      gen: (lv) => ({ n: L3(lv, 4, 6, 8) }),
      text: (I) => `How many permutations p of 1…${I.n} have, at every position i (1-based), p[i] divisible by i or i divisible by p[i]?`,
      ans: (I) => { const used = Array(I.n + 1).fill(false); const go = (i) => { if (i > I.n) return 1; let t = 0; for (let v = 1; v <= I.n; v++) if (!used[v] && (v % i === 0 || i % v === 0)) { used[v] = true; t += go(i + 1); used[v] = false; } return t; }; return go(1); },
      why: () => `Fill positions from the back (large positions have few valid values) and prune immediately; bitmask DP also works.` }),
    num({ id: "factor-combinations", name: "Factor Combinations", tags: "Non-decreasing factors",
      gen: (lv, R) => ({ n: R.pick(L3(lv, [12, 16, 18, 20], [24, 30, 32, 36], [48, 60, 64, 72, 96])) }),
      text: (I) => `In how many ways can ${I.n} be written as a product of integers ≥ 2 (at least two factors, order doesn't matter)?`,
      ans: (I) => { const go = (n, lo) => { let t = 0; for (let f = lo; f * f <= n; f++) if (n % f === 0) t += 1 + go(n / f, f); return t; }; return go(I.n, 2); },
      why: () => `Generate factors in non-decreasing order: pick f ≥ previous with f² ≤ remaining, count "f × rest", and recurse on the rest.` }),
    num({ id: "restore-ip", name: "Restore IP Addresses", tags: "Four parts, each 0–255",
      gen: (lv, R) => { const parts = U.range(4).map(() => R.int(0, L3(lv, 9, 99, 255))); return { s: parts.join("") }; },
      text: (I) => `How many valid IPv4 addresses can be formed by inserting three dots into ${tt(I.s)}? (Each part 0–255, no leading zeros.)`,
      ans: (I) => { let c = 0; const go = (i, k) => { if (k === 4) { if (i === I.s.length) c++; return; } for (let l = 1; l <= 3 && i + l <= I.s.length; l++) { const p = I.s.slice(i, i + l); if ((p.length > 1 && p[0] === "0") || +p > 255) continue; go(i + l, k + 1); } }; go(0, 0); return c; },
      why: () => `Only 3 choices of length per part and 4 parts: backtrack with the validity checks.` }),
    num({ id: "expression-operators", name: "Expression Add Operators", tags: "Track the last product term",
      gen: (lv, R) => ({ s: R.str(L3(lv, 4, 5, 6), "123456789"), t: R.int(L3(lv, 5, 10, 20), L3(lv, 30, 60, 100)) }),
      text: (I) => `Insert +, − or × (or nothing, joining digits; no number may have a leading zero) between the digits of ${tt(I.s)}. How many expressions evaluate to ${I.t}?`,
      ans: (I) => { let c = 0; const go = (i, val, last) => { if (i === I.s.length) { if (val === I.t) c++; return; } for (let j = i + 1; j <= I.s.length; j++) { const p = I.s.slice(i, j); if (p.length > 1 && p[0] === "0") break; const x = +p; if (i === 0) go(j, x, x); else { go(j, val + x, x); go(j, val - x, -x); go(j, val - last + last * x, last * x); } } }; go(0, 0, 0); return c; },
      reject: (I, s) => s === 0,
      why: () => `Carry the value so far and the last term: multiplication must undo the last term and add last × x, respecting precedence without parsing.` }),
    yn({ id: "additive-number", name: "Additive Number", tags: "Try the first two numbers",
      gen: (lv, R) => { let a = R.int(1, L3(lv, 9, 20, 99)), b = R.int(1, L3(lv, 9, 20, 99)); let s = `${a}${b}`; for (let k = 0; k < L3(lv, 2, 3, 3); k++) { [a, b] = [b, a + b]; s += b; } if (R.chance(0.45)) { const i = R.int(1, s.length - 1); s = s.slice(0, i) + ((+s[i] + 1) % 10) + s.slice(i + 1); } return { s }; },
      text: (I) => `Can ${tt(I.s)} be split into at least three numbers (no leading zeros) where each is the sum of the previous two?`,
      ans: (I) => { const s = I.s, n = s.length; for (let i = 1; i < n; i++) for (let j = i + 1; j < n; j++) { const A = s.slice(0, i), B = s.slice(i, j); if ((A.length > 1 && A[0] === "0") || (B.length > 1 && B[0] === "0")) continue; let a = +A, b = +B, k = j, ok = true; while (k < n) { const c = String(a + b); if (!s.startsWith(c, k)) { ok = false; break; } k += c.length; [a, b] = [b, a + b]; } if (ok && k === n) return "Yes"; } return "No"; },
      why: () => `The first two numbers determine everything; try every split for them and verify the rest greedily.` }),
    yn({ id: "split-descending", name: "Split Into Descending Consecutive Values", tags: "Try the first piece",
      gen: (lv, R) => { let x = R.int(L3(lv, 3, 10, 50), L3(lv, 9, 99, 999)); let s = ""; for (let k = 0; k < L3(lv, 3, 3, 4) && x >= 0; k++) s += x--; if (R.chance(0.45)) { const i = R.int(1, s.length - 1); s = s.slice(0, i) + ((+s[i] + 1) % 10) + s.slice(i + 1); } return { s }; },
      text: (I) => `Can ${tt(I.s)} be split into two or more numbers where each is exactly one less than the previous?`,
      ans: (I) => { const s = I.s; for (let i = 1; i < s.length; i++) { let x = +s.slice(0, i), k = i, ok = true; while (k < s.length) { let found = false; for (let j = k + 1; j <= s.length; j++) if (+s.slice(k, j) === x - 1) { x--; k = j; found = true; break; } if (!found) { ok = false; break; } } if (ok) return "Yes"; } return "No"; },
      why: () => `Choose the first number, then the rest is forced (leading zeros allowed, so "050" is 50). Backtrack over the first piece's length.` }),
    yn({ id: "countdown", name: "Countdown Numbers", tags: "Search over pairs of numbers",
      gen: (lv, R) => ({ a: [...R.arr(L3(lv, 3, 4, 5), 1, 10), ...(lv === 3 ? [R.pick([25, 50, 75])] : [])], t: R.int(L3(lv, 20, 50, 100), L3(lv, 60, 150, 500)) }),
      text: (I) => `Using some of ${list(I.a)} (each at most once) with +, −, × and ÷ (any brackets, fractions allowed in between), can you make exactly ${I.t}?`,
      ans: (I) => (reach(I.a, I.t, false) ? "Yes" : "No"),
      why: () => `Repeatedly pick two numbers, replace them by their sum, difference, product or quotient, and recurse. Memoising on the sorted multiset of numbers prunes repeats.` }),
    yn({ id: "game-24", name: "The 24 Game", tags: "Combine two at a time",
      gen: (lv, R) => ({ a: R.arr(4, 1, L3(lv, 6, 9, 13)) }),
      text: (I) => `Using all four numbers ${list(I.a)} exactly once with +, −, × and ÷ (brackets allowed, fractions allowed in between), can you make 24?`,
      ans: (I) => (reach(I.a, 24, true) ? "Yes" : "No"),
      why: () => `Pick any ordered pair, combine with each operator, recurse on three numbers, then two. At most 4·3·6 · 3·2·6 · 2·6 cases; use exact fractions or a small epsilon.` }),
    num({ id: "sudoku-4x4-count", name: "Count 4 × 4 Sudoku Completions", tags: "Constraint backtracking",
      gen: (lv, R) => { const base = [[1, 2, 3, 4], [3, 4, 1, 2], [2, 1, 4, 3], [4, 3, 2, 1]]; const p = R.shuffle([1, 2, 3, 4]); const g = base.map((r) => r.map((v) => p[v - 1])); const keep = L3(lv, 8, 6, 5); const cells = R.sample(H.cells(4, 4), keep); return { g: U.range(4).map((r) => U.range(4).map((c) => (cells.some(([y, x]) => y === r && x === c) ? g[r][c] : 0))) }; },
      text: (I) => `Each row, column and 2 × 2 box must contain 1–4 once. How many ways can this grid be completed?<div class="mono strong">${I.g.map((r) => r.map((v) => v || "·").join(" ")).join("<br>")}</div>`,
      ans: (I) => { const g = I.g.map((r) => r.slice()); const ok = (r, c, v) => U.range(4).every((k) => g[r][k] !== v && g[k][c] !== v) && [0, 1].every((dy) => [0, 1].every((dx) => g[r - (r % 2) + dy][c - (c % 2) + dx] !== v)); const go = (p) => { if (p === 16) return 1; const r = p >> 2, c = p & 3; if (g[r][c]) return go(p + 1); let t = 0; for (let v = 1; v <= 4; v++) if (ok(r, c, v)) { g[r][c] = v; t += go(p + 1); g[r][c] = 0; } return t; }; return go(0); },
      why: () => `Fill empty cells in order, trying only digits not already in the row, column or box. Counting solutions (instead of stopping at the first) checks whether a puzzle is well-posed.` }),
    num({ id: "self-avoiding-walks", name: "Self-Avoiding Walks", tags: "DFS with a visited set",
      gen: (lv) => ({ n: L3(lv, 3, 5, 7) }),
      text: (I) => `On an infinite grid, how many walks of ${I.n} steps (up/down/left/right) start at the origin and never revisit a point?`,
      ans: (I) => { const seen = new Set(["0,0"]); const go = (x, y, k) => { if (!k) return 1; let t = 0; for (const [dx, dy] of PB.MOVES["4"]) { const q = `${x + dx},${y + dy}`; if (seen.has(q)) continue; seen.add(q); t += go(x + dx, y + dy, k - 1); seen.delete(q); } return t; }; return go(0, 0, I.n); },
      why: () => `There's no known formula: the counts (4, 12, 36, 100, 284, 780, 2172, …) grow like μⁿ with μ ≈ 2.638, and are computed by exactly this kind of backtracking.` }),
    num({ id: "chromatic-count", name: "Count Proper Colourings", tags: "Backtracking / deletion–contraction",
      gen: (lv, R) => { const n = L3(lv, 4, 5, 6), edges = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (R.chance(0.5)) edges.push({ u: a, v: b, w: 1 }); return edges.length >= n - 1 ? { G: circ(n, edges), k: L3(lv, 3, 3, 4) } : null; },
      text: (I) => `In how many ways can the vertices be coloured with ${I.k} colours so that every edge joins different colours?${figG(I.G)}`,
      ans: (I) => { const col = Array(I.G.n).fill(-1), A = C.adj(I.G); const go = (v) => { if (v === I.G.n) return 1; let t = 0; for (let c = 0; c < I.k; c++) if (A[v].every(({ v: u }) => col[u] !== c)) { col[v] = c; t += go(v + 1); col[v] = -1; } return t; }; return go(0); },
      reject: (I, s) => s === 0,
      why: () => `Colour vertices in order, trying each colour not used by an already-coloured neighbour. The count as a function of k is the chromatic polynomial.` }),
    num({ id: "topo-order-count", name: "Count Topological Orders", tags: "Backtracking over in-degree-zero vertices",
      gen: (lv, R) => { const n = L3(lv, 4, 5, 6), edges = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (R.chance(0.4)) edges.push({ u: a, v: b, w: 1 }); return edges.length >= 2 ? { G: circ(n, edges) } : null; },
      text: (I) => `How many orderings of the vertices respect every arrow (tail before head)?${figG(I.G, { directed: true })}`,
      ans: (I) => { const n = I.G.n, indeg = Array(n).fill(0), used = Array(n).fill(false); I.G.edges.forEach((e) => indeg[e.v]++); const go = (k) => { if (k === n) return 1; let t = 0; for (let v = 0; v < n; v++) if (!used[v] && !indeg[v]) { used[v] = true; I.G.edges.forEach((e) => e.u === v && indeg[e.v]--); t += go(k + 1); I.G.edges.forEach((e) => e.u === v && indeg[e.v]++); used[v] = false; } return t; }; return go(0); },
      reject: (I, s) => s < 2,
      why: () => `At each step any vertex with in-degree 0 may come next. Backtrack (or DP over subsets: ways[mask] = Σ ways[mask − v] for v whose predecessors are all in mask).` }),
    num({ id: "shopping-offers", name: "Shopping Offers", tags: "DFS over needs with memo",
      gen: (lv, R) => { const k = L3(lv, 2, 2, 3); return { price: R.arr(k, 2, 6), offers: U.range(L3(lv, 2, 3, 3)).map(() => [...R.arr(k, 0, 2), 0]).map((o) => { o[k] = Math.max(1, sum(o.slice(0, k).map((q, i) => q * 4)) - R.int(1, 4)); return o; }).filter((o) => sum(o.slice(0, k)) > 1), need: R.arr(k, 1, 3) }; },
      text: (I) => `Item prices: ${list(I.price)}. Bundles (quantities…, price): ${I.offers.map((o) => tt(`(${o.join(", ")})`)).join(" ")}. You need exactly ${list(I.need)}. Minimum cost (bundles can be reused; no extra items)?`,
      ans: (I) => { const k = I.price.length, memo = new Map(); const go = (need) => { const key2 = need.join(); if (memo.has(key2)) return memo.get(key2); let best = sum(need.map((q, i) => q * I.price[i])); for (const o of I.offers) { const rest = need.map((q, i) => q - o[i]); if (rest.every((q) => q >= 0)) best = Math.min(best, o[k] + go(rest)); } memo.set(key2, best); return best; }; return go(I.need); },
      why: () => `State = remaining needs. Either buy everything at list price, or apply a bundle that doesn't overshoot and recurse; memoise on the needs vector.` }),
    num({ id: "stickers-to-spell", name: "Stickers to Spell a Word", tags: "BFS / DP over remaining letters",
      gen: (lv, R) => { const st = U.range(L3(lv, 2, 3, 3)).map(() => R.str(R.int(3, 4), "abcde")); const target = R.str(L3(lv, 4, 5, 6), [...new Set(st.join(""))].join("")); return { st, target }; },
      text: (I) => `Stickers ${I.st.map(tt).join(" ")} can be bought in any quantity, cut into letters and rearranged. Fewest stickers to spell ${tt(I.target)}?`,
      ans: (I) => { const memo = new Map(); const go = (t) => { if (!t) return 0; if (memo.has(t)) return memo.get(t); let best = Infinity; for (const s of I.st) { if (!s.includes(t[0])) continue; const c = H.cnt(s); let r = ""; for (const ch of t) { if (c.get(ch)) c.set(ch, c.get(ch) - 1); else r += ch; } best = Math.min(best, 1 + go(r)); } memo.set(t, best); return best; }; return go([...I.target].sort().join("")); },
      why: () => `Keep the remaining letters sorted as the state. Only try stickers containing the first remaining letter (some sticker must cover it), which prunes a lot.` }),
    num({ id: "missionaries", name: "Missionaries and Cannibals", tags: "BFS over (left counts, boat side)",
      gen: (lv) => ({ m: L3(lv, 3, 4, 5), b: L3(lv, 2, 3, 3) }),
      text: (I) => `${I.m} missionaries and ${I.m} cannibals must cross a river with a boat holding 1–${I.b} people. Cannibals may never outnumber missionaries on either bank (or in the boat) when missionaries are present. Fewest crossings?`,
      ans: (I) => { const ok = (m, c) => m === 0 || m >= c; const start = [I.m, I.m, 0]; return PB.bfsMoves(start, ([m, c, s]) => { const out = []; for (let dm = 0; dm <= I.b; dm++) for (let dc = 0; dc + dm <= I.b; dc++) { if (dm + dc === 0 || !ok(dm, dc)) continue; const sg = s ? 1 : -1, nm = m + sg * dm, nc = c + sg * dc; if (nm < 0 || nc < 0 || nm > I.m || nc > I.m) continue; if (!ok(nm, nc) || !ok(I.m - nm, I.m - nc)) continue; out.push([[dm, dc], [nm, nc, 1 - s]]); } return out; }, ([m, c]) => m === 0 && c === 0).length; },
      why: () => `The state is (missionaries on the left, cannibals on the left, boat side). BFS over these few states finds the shortest sequence of crossings.` }),
    num({ id: "bridge-and-torch", name: "Bridge and Torch", tags: "Dijkstra over subsets",
      gen: (lv, R) => ({ t: R.distinct(L3(lv, 4, 5, 6), 1, 15).sort((a, b) => a - b) }),
      text: (I) => `People with crossing times ${list(I.t)} must cross a bridge at night. At most two cross at once, at the slower one's pace, and someone must carry the single torch back each time. Minimum total time?`,
      ans: (I) => { let a = I.t.slice(), tot = 0; while (a.length > 3) { tot += Math.min(a[0] + 2 * a[1] + a[a.length - 1], 2 * a[0] + a[a.length - 2] + a[a.length - 1]); a = a.slice(0, -2); } return tot + (a.length === 3 ? a[0] + a[1] + a[2] : a.length === 2 ? a[1] : a[0]); },
      why: () => `Search over (who is across, torch side) with Dijkstra, or use the known greedy: move the two slowest each round, either both escorted by the fastest or via the two fastest shuttling.` }),

    /* ----- move puzzles (BFS par) ----- */
    ops({ id: "flip-three-coins", name: "Flip Three Coins", tags: "BFS / greedy left to right",
      gen: (lv, R) => { const a = R.arr(L3(lv, 6, 8, 10), 0, 1).map((x) => (x ? "H" : "T")); return a.every((x) => x === "H") ? null : { a }; },
      spec: (I) => ({ start: I.a, arity: 1, style: "tiles", apply: (s, [i]) => (i + 2 >= s.length ? null : s.map((x, k) => (k >= i && k <= i + 2 ? (x === "H" ? "T" : "H") : x))), moves: (s) => U.range(s.length - 2).map((i) => [i]), done: (s) => s.every((x) => x === "H"), illegal: "Tap the first of three coins." }),
      text: "Tap a coin to flip it and the next two. Make every coin heads in as few moves as possible.",
      solve: (I) => { const s = I.a.slice(), out = []; for (let i = 0; i + 2 < s.length; i++) if (s[i] === "T") { out.push([i]); for (let k = i; k <= i + 2; k++) s[k] = s[k] === "H" ? "T" : "H"; } return s.every((x) => x === "H") ? out : null; },
      why: () => `The leftmost tails coin can only be fixed by flipping at its own position, so greedy left to right is forced and optimal. (If the last two end as tails, it's impossible.)` }),
    ops({ id: "lights-out-line", name: "Lights Out on a Line", tags: "First move decides the rest",
      gen: (lv, R) => { const a = R.arr(L3(lv, 5, 7, 9), 0, 1).map((x) => (x ? "●" : "○")); return a.every((x) => x === "○") ? null : { a }; },
      spec: (I) => ({ start: I.a, arity: 1, style: "tiles", apply: (s, [i]) => s.map((x, k) => (Math.abs(k - i) <= 1 ? (x === "●" ? "○" : "●") : x)), moves: (s) => U.range(s.length).map((i) => [i]), done: (s) => s.every((x) => x === "○") }),
      text: "Tapping a light toggles it and its neighbours. Turn every light off (○) in as few taps as possible.",
      why: () => `Whether you press the first light decides everything: after that, light i − 1 can only be fixed by pressing i. Try both choices and keep the shorter.` }),
    ops({ id: "toggle-suffix", name: "Bulb Switcher: Toggle a Suffix", tags: "Count changes",
      gen: (lv, R) => ({ a: R.arr(L3(lv, 5, 8, 11), 0, 1).map(String) }),
      spec: (I) => ({ start: I.a.map(() => "0"), arity: 1, style: "tiles", apply: (s, [i]) => s.map((x, k) => (k >= i ? (x === "0" ? "1" : "0") : x)), moves: (s) => U.range(s.length).map((i) => [i]), done: (s) => s.join("") === I.a.join("") }),
      text: (I) => `All bulbs start off. Tapping bulb i toggles it and every bulb to its right. Reach the pattern ${tt(I.a.join(""))} in as few taps as possible.`,
      solve: (I) => { const out = []; let cur = "0"; I.a.forEach((x, i) => { if (x !== cur) { out.push([i]); cur = x; } }); return out; },
      reject: (I, s) => s.length < 2,
      why: () => `Scan left to right: each time the target bit differs from the current state of the suffix you must tap there. The answer is the number of changes (counting a leading 1).` }),
    ops({ id: "rotate-window-sort", name: "Sort by Rotating Windows", tags: "BFS over permutations",
      gen: (lv, R) => { const a = R.perm(L3(lv, 4, 5, 6)); return a.every((x, i) => i === 0 || a[i - 1] < x) ? null : { a, k: 3 }; },
      spec: (I) => ({ start: I.a, arity: 1, apply: (s, [i]) => (i + I.k > s.length ? null : [...s.slice(0, i), ...s.slice(i + 1, i + I.k), s[i], ...s.slice(i + I.k)]), moves: (s) => U.range(s.length - I.k + 1).map((i) => [i]), done: (s) => s.every((x, i) => i === 0 || s[i - 1] < x), illegal: "Tap the first element of a full window." }),
      text: (I) => `Tapping position i rotates the window of ${I.k} elements starting there one step left (its first element moves to the window's end). Sort the array in as few moves as possible.`,
      why: () => `A 3-rotation is an even permutation, so half of all arrangements are unreachable (the generator only gives solvable ones). BFS over permutations finds the shortest sequence.` }),
    ops({ id: "star-transpositions", name: "Sort by Swapping With the First", tags: "Cycle structure",
      gen: (lv, R) => { const a = R.perm(L3(lv, 4, 6, 7)); return a.every((x, i) => i === 0 || a[i - 1] < x) ? null : { a }; },
      spec: (I) => ({ start: I.a, arity: 1, apply: (s, [i]) => (i === 0 ? null : s.map((x, k) => (k === 0 ? s[i] : k === i ? s[0] : x))), moves: (s) => U.range(s.length - 1).map((i) => [i + 1]), done: (s) => s.every((x, i) => i === 0 || s[i - 1] < x), illegal: "You can only swap with the first position." }),
      text: "Tap a position to swap its value with the first position's. Sort the array in as few swaps as possible.",
      solve: (I) => { const s = I.a.slice(), n = s.length, out = []; const sw = (i) => { [s[0], s[i]] = [s[i], s[0]]; out.push([i]); }; for (let guard = 0; guard < 100; guard++) { if (s[0] !== 1) sw(s[0] - 1); else { const j = s.findIndex((x, i) => x !== i + 1); if (j < 0) break; sw(j); } } void n; return out; },
      why: () => `Look at the cycles of the permutation. A cycle through position 0 of length L costs L − 1 swaps; every other non-trivial cycle costs L + 1 (enter it, then leave).` }),
    ops({ id: "frog-leap", name: "Frogs and Toads", tags: "BFS (the answer is n² + 2n)",
      gen: (lv) => ({ n: L3(lv, 1, 2, 3) }),
      spec: (I) => ({ start: [...Array(I.n).fill("▶"), "·", ...Array(I.n).fill("◀")], arity: 1, style: "tiles", apply: (s, [i]) => { const e = s.indexOf("·"); if (s[i] === "▶" && (e === i + 1 || (e === i + 2 && s[i + 1] !== "·"))) return s.map((x, k) => (k === i ? "·" : k === e ? "▶" : x)); if (s[i] === "◀" && (e === i - 1 || (e === i - 2 && s[i - 1] !== "·"))) return s.map((x, k) => (k === i ? "·" : k === e ? "◀" : x)); return null; }, moves: (s) => U.range(s.length).map((i) => [i]), done: (s) => s.join("") === [...Array(I.n).fill("◀"), "·", ...Array(I.n).fill("▶")].join(""), illegal: "Frogs only move forward: slide into the gap or jump over one frog into it." }),
      text: "▶ frogs move right and ◀ frogs move left, either sliding into the empty pad or jumping over one frog into it. Swap the two groups in as few moves as possible.",
      why: () => `BFS finds n² + 2n moves (n² jumps, 2n slides). Never let two frogs facing the same way get stuck behind each other in front of the gap.` }),
    ops({ id: "peg-solitaire-line", name: "Peg Solitaire on a Line", tags: "BFS / DFS over bitmasks",
      gen: (lv, R) => { const n = L3(lv, 6, 7, 9); for (let t = 0; t < 60; t++) { const a = R.arr(n, 0, 1).map((x) => (x ? "●" : "○")); if (H.count(a, (x) => x === "●") < 3) continue; const done = (s) => H.count(s, (x) => x === "●") === 1; const next = (s) => { const out = []; for (let i = 0; i < n; i++) for (const d of [-2, 2]) { const j = i + d, m = i + d / 2; if (j < 0 || j >= n || s[i] !== "●" || s[m] !== "●" || s[j] !== "○") continue; out.push([[i, j], s.map((x, k) => (k === i || k === m ? "○" : k === j ? "●" : x))]); } return out; }; if (PB.bfsMoves(a, next, done)) return { a }; } return null; },
      spec: (I) => ({ start: I.a, arity: 2, style: "tiles", apply: (s, [i, j]) => { const m = (i + j) / 2; if (Math.abs(i - j) !== 2 || s[i] !== "●" || s[m] !== "●" || s[j] !== "○") return null; return s.map((x, k) => (k === i || k === m ? "○" : k === j ? "●" : x)); }, moves: (s) => U.range(s.length).flatMap((i) => [[i, i - 2], [i, i + 2]]).filter(([, j]) => j >= 0 && j < s.length), done: (s) => H.count(s, (x) => x === "●") === 1, tapNote: () => "tap the empty hole two places away", illegal: "Jump a peg over a neighbouring peg into an empty hole." }),
      text: "Tap a peg, then the empty hole two places away: it jumps over the peg between, which is removed. Finish with a single peg.",
      why: () => `Every jump removes exactly one peg, so any solution has the same length; the search is about avoiding dead ends. DFS with memoisation of dead states solves it.` }),
  ]);
})();
