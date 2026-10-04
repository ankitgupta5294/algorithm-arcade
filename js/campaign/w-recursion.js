/* Campaign worlds: Recursion & backtracking. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign;

  /* ===================== Tower of Hanoi ===================== */
  // State: string of peg indices for disks 1..n (disk 1 is the smallest). BFS gives exact optima for 3 or 4 pegs.
  function hanoiBFS(start, target, pegs) {
    const n = start.length;
    const goal = String(target).repeat(n);
    const prev = new Map([[start, null]]);
    let q = [start];
    while (q.length && !prev.has(goal)) {
      const nq = [];
      for (const s of q) {
        const top = U.range(pegs).map(() => Infinity);
        for (let d = n; d >= 1; d--) top[+s[d - 1]] = d;
        for (let a = 0; a < pegs; a++) {
          if (top[a] === Infinity) continue;
          for (let b = 0; b < pegs; b++) {
            if (a === b || top[b] < top[a]) continue;
            const t = s.slice(0, top[a] - 1) + b + s.slice(top[a]);
            if (!prev.has(t)) { prev.set(t, [s, [a, b]]); nq.push(t); }
          }
        }
      }
      q = nq;
    }
    const path = [];
    for (let k = goal; prev.get(k); k = prev.get(k)[0]) path.unshift(prev.get(k)[1]);
    return path;
  }
  C.register({
    id: "hanoi", cat: "recursion", name: "Tower of Hanoi", concept: "Recursion",
    blurb: "Move the tower one disk at a time, never a big disk on a small one.",
    tiers: ["2–4 disks", "4–5 disks, scrambled starts", "5–6 disks, scrambled starts", "Four pegs"],
    lesson: `<p>To move a tower of n disks, first move the top n − 1 out of the way, then move the biggest disk, then move the n − 1 back on top. That gives T(n) = 2·T(n−1) + 1 = <b>2ⁿ − 1</b> moves, and no shorter solution exists.</p>
      <p><b>Scrambled starts.</b> Look at the biggest disk. If it's already on the target peg, ignore it and solve the rest. If not, stack everything smaller on the third peg, move it across, then rebuild on top. The same recursion works for any starting position.</p>
      <p><b>Four pegs.</b> The spare peg changes everything: 7 disks take 25 moves instead of 127. The Frame–Stewart strategy splits the tower in two parts, and par here comes from breadth-first search over every position.</p>`,
    hint: "Find the biggest disk that isn't on the target peg yet. Everything smaller has to get out of its way, onto the one peg it isn't using.",
    gen(L, R, t) {
      const pegs = t === 3 ? 4 : 3;
      const n = t === 0 ? [2, 2, 3, 3, 3, 3, 4, 4, 4, 4][L - 1] : t === 1 ? (L <= 15 ? 4 : 5) : t === 2 ? (L <= 25 ? 5 : 6) : [4, 4, 5, 5, 5, 6, 6, 6, 7, 7][L - 31];
      const target = R.int(1, pegs - 1);
      let start;
      const standard = (t === 0 && L <= 4) || (t === 3 && R.chance(0.5));
      if (standard) start = "0".repeat(n);
      else start = U.range(n).map(() => R.int(0, pegs - 1)).join("");
      if (start === String(target).repeat(n)) return null;
      const sol = hanoiBFS(start, target, pegs);
      const lo = t === 0 ? (L <= 4 ? 2 : L <= 6 ? 5 : 9) : { 1: 9, 2: 18, 3: 8 }[t];
      if (sol.length < Math.min(lo, 2 ** n - 1)) return null;
      return { n, pegs, start, target, par: sol.length, solution: sol,
        goal: `Move every disk onto peg <b>${"ABCD"[target]}</b>. Move one disk at a time and never put a bigger disk on a smaller one. Tap a peg to lift its top disk, then tap where it goes. Par is <b>${sol.length}</b>.` };
    },
    view(el, P, api) {
      const pos = [...P.start].map(Number);
      let held = null, moves = 0;
      el.innerHTML = `<div class="hanoi" style="--pegs:${P.pegs}"></div>`;
      const box = el.querySelector(".hanoi");
      const tops = () => { const top = U.range(P.pegs).map(() => Infinity); for (let d = P.n; d >= 1; d--) top[pos[d - 1]] = d; return top; };
      function render() {
        box.innerHTML = U.range(P.pegs).map((p) => {
          const disks = U.range(P.n).map((i) => P.n - i).filter((d) => pos[d - 1] === p);
          return `<button type="button" class="peg${held === p ? " held" : ""}${p === P.target ? " target" : ""}" data-p="${p}" aria-label="Peg ${"ABCD"[p]}, ${disks.length} disks">
            <span class="pole"></span>${disks.map((d) => `<span class="disk d${d % 7}" style="--w:${28 + (d / P.n) * 68}%">${d}</span>`).join("")}<span class="peglabel">${"ABCD"[p]}</span></button>`;
        }).join("");
        api.stats([["Moves", moves], ["Par", P.par]]);
      }
      function move([a, b]) {
        if (api.over) return;
        const top = tops();
        if (top[a] === Infinity) return;
        if (top[b] < top[a]) { api.say(`Disk ${top[a]} can't go on top of the smaller disk ${top[b]}.`, "lose"); return; }
        pos[top[a] - 1] = b;
        moves++; held = null;
        api.say("");
        render();
        if (pos.every((p) => p === P.target)) api.win({ stars: C.stars(moves, P.par, Math.ceil(P.par * 0.25)), text: `${moves} moves, optimum ${P.par}.` + (P.pegs === 3 && P.start === "0".repeat(P.n) ? ` That's 2^${P.n} − 1, from T(n) = 2T(n−1) + 1.` : P.pegs === 4 ? ` With three pegs a full tower of ${P.n} would need ${2 ** P.n - 1}. The fourth peg lets you park a whole sub-tower.` : " Solving from the biggest misplaced disk downwards is what makes the recursion optimal.") });
      }
      C.onPick(box, "data-p", (v) => {
        const p = +v;
        if (held === null) { if (tops()[p] !== Infinity) { held = p; render(); box.children[p].focus({ preventScroll: true }); } return; }
        if (held === p) { held = null; render(); return; }
        move([held, p]);
      });
      render();
      return { move };
    },
  });

  /* ===================== N-Queens ===================== */
  function queensSolution(N, R) {
    const cols = [], used = new Set(), d1 = new Set(), d2 = new Set();
    const order = U.range(N);
    const go = (r) => {
      if (r === N) return true;
      for (const c of R.shuffle(order.slice())) {
        if (used.has(c) || d1.has(r - c) || d2.has(r + c)) continue;
        used.add(c); d1.add(r - c); d2.add(r + c); cols[r] = c;
        if (go(r + 1)) return true;
        used.delete(c); d1.delete(r - c); d2.delete(r + c);
      }
      return false;
    };
    go(0);
    return cols.slice();
  }
  function countCompletions(N, fixed, cap = 50) {
    let count = 0;
    const fr = new Map(fixed.map(([r, c]) => [r, c]));
    const used = new Set(), d1 = new Set(), d2 = new Set();
    const go = (r) => {
      if (count >= cap) return;
      if (r === N) { count++; return; }
      const cs = fr.has(r) ? [fr.get(r)] : U.range(N);
      for (const c of cs) {
        if (used.has(c) || d1.has(r - c) || d2.has(r + c)) continue;
        used.add(c); d1.add(r - c); d2.add(r + c);
        go(r + 1);
        used.delete(c); d1.delete(r - c); d2.delete(r + c);
      }
    };
    go(0);
    return count;
  }
  C.register({
    id: "queens", cat: "recursion", name: "N-Queens", concept: "Backtracking",
    blurb: "Place N queens so that none attacks another. Some are already on the board.",
    tiers: ["4–6 board", "6–7 board", "8×8 board", "9–10 board"],
    lesson: `<p>Each row, column and diagonal can hold at most one queen. <b>Backtracking</b> places one queen per row, skips squares already under attack, and when a row has no safe square left it undoes the previous choice and tries the next one.</p>
      <p>Pruning is what makes this fast: tracking used columns and both diagonals (r − c and r + c) gives O(1) safety checks. The 8×8 board has 92 solutions among 4.4 billion ways to place 8 queens.</p>
      <p>Fixed queens shrink the search. Start with the row that has the fewest safe squares. That "most constrained first" ordering is a key trick in constraint solvers.</p>`,
    hint: "Fill the row with the fewest safe squares first. If a row has none, remove your most recent queen and try its next safe square.",
    gen(L, R, t) {
      const N = t === 0 ? [4, 4, 5, 5, 5, 6, 6, 6, 6, 6][L - 1] : t === 1 ? (L <= 14 ? 6 : 7) : t === 2 ? 8 : L <= 35 ? 9 : 10;
      const k = t === 0 ? 1 : t === 1 ? (L % 2 ? 1 : 2) : t === 2 ? 2 : 3;
      const sol = queensSolution(N, R);
      const rows = R.sample(U.range(N), k);
      const fixed = rows.map((r) => [r, sol[r]]).sort((a, b) => a[0] - b[0]);
      const completions = countCompletions(N, fixed, 40);
      if (t >= 2 && completions > 12) return null;            // harder levels: fewer ways to finish
      const moves = U.range(N).filter((r) => !rows.includes(r)).map((r) => [r, sol[r]]);
      return { N, fixed, par: moves.length, solution: moves, completions,
        goal: `Place <b>${N}</b> queens on the ${N}×${N} board so that no two share a row, column or diagonal. Locked queens can't move. Tap a square to place or remove a queen.` };
    },
    view(el, P, api) {
      const N = P.N, q = new Map(P.fixed.map(([r, c]) => [r + "," + c, true]));
      const fixed = new Set(P.fixed.map(([r, c]) => r + "," + c));
      let actions = 0, showAtk = api.tier <= 1;
      el.innerHTML = `<div class="qboard" style="--n:${N}"></div><label class="toggle"><input type="checkbox" class="atk" ${showAtk ? "checked" : ""}> Shade attacked squares</label>`;
      const board = el.querySelector(".qboard");
      const queens = () => [...q.keys()].map((k) => k.split(",").map(Number));
      const attacks = (r, c, [qr, qc]) => (qr === r || qc === c || qr - qc === r - c || qr + qc === r + c);
      function render() {
        const Q = queens();
        let cells = "";
        for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
          const has = q.has(r + "," + c);
          const clash = has && Q.some(([qr, qc]) => !(qr === r && qc === c) && attacks(r, c, [qr, qc]));
          const atk = !has && showAtk && Q.some((x) => attacks(r, c, x));
          cells += `<button type="button" class="qsq${(r + c) % 2 ? " dark" : ""}${atk ? " atk" : ""}${has ? " has" : ""}${clash ? " clash" : ""}${fixed.has(r + "," + c) ? " fixed" : ""}" data-rc="${r},${c}" aria-label="Row ${r + 1}, column ${c + 1}${has ? ", queen" : ""}">${has ? "♛" : ""}</button>`;
        }
        board.innerHTML = cells;
        const conflicts = Q.filter(([r, c]) => Q.some(([qr, qc]) => !(qr === r && qc === c) && attacks(r, c, [qr, qc]))).length;
        api.stats([["Queens", `${Q.length}/${N}`], ["Clashing", conflicts], ["Actions", actions]]);
        return { Q, conflicts };
      }
      function move([r, c]) {
        if (api.over) return;
        const k = r + "," + c;
        if (fixed.has(k)) { api.say("That queen is locked in place."); return; }
        if (q.has(k)) q.delete(k); else q.set(k, true);
        actions++;
        const { Q, conflicts } = render();
        api.say("");
        if (Q.length === N && conflicts === 0) api.win({ stars: C.stars(actions, P.par, 4), text: `Solved with ${actions} placements and removals (the minimum is ${P.par}). ${P.completions === 1 ? "With those locked queens this was the <b>only</b> solution." : `With those locked queens there were ${P.completions >= 40 ? "40+" : P.completions} solutions.`} Every removal you made was a backtrack.` });
      }
      C.onPick(board, "data-rc", (v) => move(v.split(",").map(Number)));
      el.querySelector(".atk").addEventListener("change", (e) => { showAtk = e.target.checked; render(); });
      render();
      return { move };
    },
  });

  /* ===================== Lights Out ===================== */
  function press(g, r, c, R_, C_) {
    for (const [dr, dc] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const y = r + dr, x = c + dc; if (y >= 0 && y < R_ && x >= 0 && x < C_) g[y][x] ^= 1; }
  }
  // Every solution is fixed by its first-row presses; chase the lights down and keep the cheapest that clears the last row.
  function lightsSolve(g0) {
    const R_ = g0.length, C_ = g0[0].length;
    let best = null;
    for (let mask = 0; mask < 1 << C_; mask++) {
      const g = g0.map((row) => row.slice()), presses = [];
      for (let c = 0; c < C_; c++) if (mask >> c & 1) { press(g, 0, c, R_, C_); presses.push([0, c]); }
      for (let r = 1; r < R_; r++) for (let c = 0; c < C_; c++) if (g[r - 1][c]) { press(g, r, c, R_, C_); presses.push([r, c]); }
      if (g[R_ - 1].every((x) => !x) && (!best || presses.length < best.length)) best = presses;
    }
    return best;
  }
  C.lightsSolve = lightsSolve;
  C.register({
    id: "lights", cat: "recursion", name: "Lights Out", concept: "XOR · light chasing",
    blurb: "Each press toggles a light and its neighbours. Switch them all off.",
    tiers: ["3×3", "4×4", "5×5", "6×6 and 7×7"],
    lesson: `<p>Pressing a cell toggles it and its four neighbours. Two facts make this solvable. The <b>order of presses doesn't matter</b>, and pressing a cell twice cancels out (toggling is XOR). So a solution is just a <i>set</i> of cells.</p>
      <p><b>Light chasing.</b> Once the first row's presses are chosen, everything else is forced: press under every light still on in the row above, row by row. Trying all 2ᶜ first rows finds every solution, and that's how par is computed.</p>
      <p>This is solving a system of linear equations over GF(2). Some grids, like 4×4 and 5×5, have presses that cancel out entirely, which is why several different solutions can exist.</p>`,
    hint: "Light chasing: work top to bottom, pressing the cell directly below every lit light. If lights remain in the last row, adjust the first row's presses and chase again.",
    gen(L, R, t) {
      const [r, c] = t === 0 ? [3, 3] : t === 1 ? [4, L <= 15 ? 4 : 5] : t === 2 ? [5, 5] : L <= 35 ? [6, 6] : [7, 7];
      const k = t === 0 ? 2 + Math.floor((L - 1) / 4) : t === 1 ? R.int(4, 6) : t === 2 ? R.int(6, 9) : R.int(9, 13);
      const g = U.range(r).map(() => Array(c).fill(0));
      R.sample(U.range(r * c), k).forEach((x) => press(g, Math.floor(x / c), x % c, r, c));
      if (g.flat().every((x) => !x)) return null;
      const sol = lightsSolve(g);
      if (!sol || sol.length < Math.max(2, k - 2)) return null;
      return { r, c, grid: g, par: sol.length, solution: sol, goal: `Switch every light off. Pressing a square toggles it and the squares above, below, left and right. Par is <b>${sol.length}</b> presses.` };
    },
    view(el, P, api) {
      const g = P.grid.map((row) => row.slice());
      let presses = 0;
      el.innerHTML = `<div class="lights" style="--c:${P.c}"></div>`;
      const box = el.querySelector(".lights");
      function render() {
        let s = "";
        for (let r = 0; r < P.r; r++) for (let c = 0; c < P.c; c++) s += `<button type="button" class="light${g[r][c] ? " on" : ""}" data-rc="${r},${c}" aria-label="Row ${r + 1}, column ${c + 1}, ${g[r][c] ? "on" : "off"}"></button>`;
        box.innerHTML = s;
        api.stats([["Presses", presses], ["Par", P.par], ["Lit", g.flat().filter(Boolean).length]]);
      }
      function move([r, c]) {
        if (api.over) return;
        press(g, r, c, P.r, P.c);
        presses++;
        render();
        box.querySelector(`[data-rc="${r},${c}"]`).focus({ preventScroll: true });
        if (g.flat().every((x) => !x)) api.win({ stars: C.stars(presses, P.par, 2), text: `All dark in ${presses} presses (optimum ${P.par}). Since presses commute and pressing twice cancels, the best solution never presses any square twice. Par came from trying all ${2 ** P.c} first-row patterns and chasing the lights down.` });
      }
      C.onPick(box, "data-rc", (v) => move(v.split(",").map(Number)));
      render();
      return { move };
    },
  });
})();
