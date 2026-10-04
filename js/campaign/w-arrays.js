/* Campaign worlds: Sorting & arrays. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign;
  const inversions = (a) => { let c = 0; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i] > a[j]) c++; return c; };
  const isSorted = (a) => a.every((x, i) => i === 0 || a[i - 1] <= x);

  /* ===================== Swap Sort ===================== */
  C.register({
    id: "swapsort", cat: "arrays", name: "Swap Sort", concept: "Inversions",
    blurb: "Sort with neighbour swaps only. Par is the inversion count.",
    tiers: ["4–6 bars, no limit", "6–9 bars, no limit", "9–12 bars, at most par + 2", "12 bars, exactly par"],
    lesson: `<p>An <b>inversion</b> is a pair of positions i &lt; j with a[i] &gt; a[j]. Swapping two <i>neighbours</i> changes the order of just that one pair, so a swap removes at most one inversion.</p>
      <p>The minimum number of swaps is therefore exactly the inversion count. Bubble sort and insertion sort achieve it, which is why they are O(n²): an array can have n(n−1)/2 inversions.</p>`,
    hint: "Only swap neighbours that are out of order. Every such swap removes exactly one inversion, so you can never go over par.",
    gen(L, R, t) {
      const n = Math.min(12, 4 + Math.floor((L - 1) / 3.6));
      const max = (n * (n - 1)) / 2;
      const lo = [0.3, 0.4, 0.45, 0.5][t], hi = [0.6, 0.7, 0.75, 0.8][t];
      let a;
      do a = R.perm(n); while (inversions(a) < max * lo || inversions(a) > max * hi);
      const sol = [], b = a.slice();
      for (let i = 0; i < n; i++) for (let j = 0; j < n - 1 - i; j++) if (b[j] > b[j + 1]) { [b[j], b[j + 1]] = [b[j + 1], b[j]]; sol.push(j); }
      const slack = t < 2 ? Infinity : t === 2 ? 2 : 0;
      return {
        arr: a, par: sol.length, slack, solution: sol,
        goal: `Sort the bars from shortest to tallest. You may only swap <b>neighbours</b>: tap a bar, then the bar beside it.` +
          (slack === Infinity ? "" : slack ? ` You may use at most <b>${sol.length + slack}</b> swaps.` : ` You have exactly <b>${sol.length}</b> swaps, so every one must count.`),
      };
    },
    view(el, P, api) {
      const a = P.arr.slice(), n = a.length;
      let swaps = 0, sel = null;
      el.innerHTML = `<div class="bars camp-bars"></div><p class="hintline">Inversions left is the number of out-of-order pairs. A useful swap removes exactly one.</p>`;
      const box = el.querySelector(".bars");
      function render(focus) {
        box.innerHTML = a.map((v, i) => `<button type="button" class="bar${sel === i ? " sel" : ""}${sel != null && Math.abs(sel - i) === 1 ? " nbr" : ""}${api.over ? " ok" : ""}" data-i="${i}" style="--h:${14 + (v / n) * 86}%" aria-label="Bar ${v}, position ${i + 1}"><span class="fill"></span><span class="lbl">${v}</span></button>`).join("");
        api.stats([["Swaps", swaps + (P.slack === Infinity ? "" : "/" + (P.par + P.slack))], ["Par", P.par], ["Inversions", inversions(a)]]);
        if (focus != null) box.children[focus].focus({ preventScroll: true });
      }
      function move(i) {
        if (api.over) return;
        const helpful = a[i] > a[i + 1];
        [a[i], a[i + 1]] = [a[i + 1], a[i]];
        swaps++;
        const inv = inversions(a);
        if (inv === 0) {
          render();
          return api.win({ stars: C.stars(swaps, P.par, 2), text: `You used <b>${swaps}</b> swaps and the array had <b>${P.par}</b> inversions. ${swaps === P.par ? "Every swap fixed exactly one out-of-order pair, which is the best possible." : "Each swap of an already-ordered pair created an inversion you later had to undo."}` });
        }
        if (swaps + inv > P.par + P.slack) { render(); return api.lose(`${inv} inversions remain but you have only ${Math.max(0, P.par + P.slack - swaps)} swaps left. A swap of neighbours that are already in order adds an inversion.`); }
        api.say(helpful ? "" : "That pair was already in order, so the swap added an inversion.", helpful ? "" : "lose");
      }
      C.onPick(box, "data-i", (v) => {
        const i = +v;
        if (sel === null || sel === i || Math.abs(sel - i) !== 1) { sel = sel === i ? null : i; render(i); return; }
        const lo = Math.min(sel, i);
        sel = null;
        move(lo);
        render(api.over ? null : i);
      });
      render();
      return { move: (i) => { move(i); render(); } };
    },
  });

  /* ===================== Cycle Swap ===================== */
  function cycles(a) {
    const seen = new Array(a.length).fill(false); let c = 0;
    for (let i = 0; i < a.length; i++) if (!seen[i]) { c++; for (let j = i; !seen[j]; j = a[j] - 1) seen[j] = true; }
    return c;
  }
  function flagPlan(a) {
    // optimal swaps for a 3-valued array: fix mutual pairs first, then break 3-cycles (2 swaps each)
    const b = a.slice(), t = a.slice().sort((x, y) => x - y), sol = [];
    for (;;) {
      const bad = b.map((v, i) => i).filter((i) => b[i] !== t[i]);
      if (!bad.length) break;
      let done = false;
      for (const p of bad) { const q = bad.find((q) => b[q] === t[p] && t[q] === b[p]); if (q != null) { sol.push([p, q]); [b[p], b[q]] = [b[q], b[p]]; done = true; break; } }
      if (done) continue;
      const p = bad[0], q = bad.find((q) => t[q] === b[p]);
      sol.push([p, q]); [b[p], b[q]] = [b[q], b[p]];
    }
    return sol;
  }
  const FLAG = ["R", "W", "B"];
  C.register({
    id: "cycleswap", cat: "arrays", name: "Cycle Swap", concept: "Permutation cycles",
    blurb: "Swap any two cards. The fewest swaps hide in the cycles of the permutation.",
    tiers: ["5–6 cards", "7–9 cards", "Dutch national flag", "10–14 cards, exactly par"],
    lesson: `<p>Draw an arrow from each position to where its card belongs. The arrows form <b>cycles</b>. A cycle of length k needs exactly k − 1 swaps, so the minimum is <b>n − (number of cycles)</b>.</p>
      <p>A swap inside one cycle splits it in two (good). A swap across two cycles merges them (wasted). The cheapest move is always to put one card straight into its home.</p>
      <p>The <b>Dutch national flag</b> levels have only three values. Fix pairs that are in each other's place first (one swap fixes two cards). What remains comes in 3-cycles that cost two swaps each.</p>`,
    hint: "Swap a card directly into its correct position. That always splits a cycle. Turn on “Show cycles” to see them.",
    gen(L, R, t) {
      if (t === 2) {
        const n = 8 + Math.floor((L - 21) / 3);
        let a;
        do a = U.range(n).map(() => R.int(0, 2)); while (flagPlan(a).length < Math.floor(n * 0.45) || new Set(a).size < 3);
        const sol = flagPlan(a);
        return { flag: true, arr: a, par: sol.length, solution: sol, slack: Infinity, goal: `Sort the tiles into <b>red, then white, then blue</b> by swapping any two tiles. Par is <b>${sol.length}</b>.` };
      }
      const n = t === 0 ? 5 + (L > 5 ? 1 : 0) : t === 1 ? 7 + Math.floor((L - 11) / 4) : 10 + Math.floor((L - 31) / 2.5);
      let a;
      do a = R.perm(n); while (cycles(a) > Math.max(2, Math.floor(n / 3)) || a.some((v, i) => v === i + 1 && R.chance(0.6)));
      const b = a.slice(), sol = [];
      for (let i = 0; i < n; i++) while (b[i] !== i + 1) { const j = b[i] - 1; sol.push([i, j]); [b[i], b[j]] = [b[j], b[i]]; }
      return { arr: a, par: sol.length, solution: sol, slack: t === 3 ? 0 : Infinity, goal: `Put the cards in order 1, 2, 3, … by swapping <b>any two</b> cards: tap one, then another.${t === 3 ? ` You have exactly <b>${sol.length}</b> swaps.` : ""}` };
    },
    view(el, P, api) {
      const a = P.arr.slice(), n = a.length, target = a.slice().sort((x, y) => x - y);
      let swaps = 0, sel = null, show = false;
      el.innerHTML = `<div class="cardrow"></div>${P.flag ? "" : `<label class="toggle"><input type="checkbox" class="cyc"> Show cycles</label>`}`;
      const row = el.querySelector(".cardrow");
      const cycOf = () => { const id = new Array(n).fill(-1); let c = 0; for (let i = 0; i < n; i++) if (id[i] < 0 && a[i] !== i + 1) { for (let j = i; id[j] < 0; j = a[j] - 1) id[j] = c; c++; } return id; };
      function render() {
        const id = show && !P.flag ? cycOf() : null;
        row.innerHTML = a.map((v, i) => P.flag
          ? `<button type="button" class="pcard flag f${v}${sel === i ? " sel" : ""}${v === target[i] ? " home" : ""}" data-i="${i}" aria-label="${["Red", "White", "Blue"][v]} tile at ${i + 1}">${FLAG[v]}</button>`
          : `<button type="button" class="pcard${sel === i ? " sel" : ""}${v === i + 1 ? " home" : ""}${id && id[i] >= 0 ? " cyc c" + (id[i] % 6) : ""}" data-i="${i}" aria-label="Card ${v} at position ${i + 1}"><b>${v}</b><small>${i + 1}</small></button>`).join("");
        const left = P.flag ? null : n - cycles(a);
        api.stats([["Swaps", swaps + (P.slack === 0 ? "/" + P.par : "")], ["Par", P.par], ...(P.flag ? [] : [["Cycles", cycles(a) - a.filter((v, i) => v === i + 1).length]])]);
        return left;
      }
      function move([i, j]) {
        if (api.over || i === j) return;
        const before = P.flag ? 0 : cycles(a);
        [a[i], a[j]] = [a[j], a[i]];
        swaps++;
        render();
        if (a.every((v, k) => v === target[k])) {
          return api.win({ stars: C.stars(swaps, P.par, 2), text: P.flag
            ? `Sorted in ${swaps} swaps (par ${P.par}). Pairs that sit in each other's place cost one swap for two tiles. Three-way rotations cost two swaps for three tiles.`
            : `Sorted in ${swaps} swaps. The permutation had ${n} cards in ${n - P.par} cycles, so the minimum was ${n} − ${n - P.par} = ${P.par}.` });
        }
        if (!P.flag && cycles(a) < before) api.say("That swap merged two cycles, so it costs an extra swap later.", "lose");
        else api.say("");
        if (P.slack === 0 && swaps + (n - cycles(a)) > P.par) api.lose("That swap merged two cycles, so par is now out of reach. Always swap a card straight into its home.");
      }
      C.onPick(row, "data-i", (v) => {
        const i = +v;
        if (sel === null) { sel = i; render(); row.children[i].focus({ preventScroll: true }); return; }
        if (sel === i) { sel = null; render(); return; }
        const s = sel; sel = null; move([s, i]);
      });
      const cb = el.querySelector(".cyc");
      if (cb) cb.addEventListener("change", () => { show = cb.checked; render(); });
      render();
      return { move };
    },
  });

  /* ===================== Pancake Flip ===================== */
  const pancakeTables = new Map();
  // BFS from the sorted stack. Flips are self-inverse, so distance to goal = distance from goal.
  function pancakeTable(n, burnt) {
    const key = n + (burnt ? "b" : "");
    if (pancakeTables.has(key)) return pancakeTables.get(key);
    const enc = (s) => s.map((x) => (x > 0 ? String.fromCharCode(96 + x) : String.fromCharCode(64 - x))).join("");
    const dec = (k) => [...k].map((ch) => (ch >= "a" ? ch.charCodeAt(0) - 96 : -(ch.charCodeAt(0) - 64)));
    const flip = (s, k) => { const r = s.slice(0, k + 1).reverse(); return (burnt ? r.map((x) => -x) : r).concat(s.slice(k + 1)); };
    const goal = U.range(n).map((i) => i + 1);
    const dist = new Map([[enc(goal), 0]]), layers = [[enc(goal)]];
    let frontier = [goal];
    while (frontier.length) {
      const nxt = [];
      for (const s of frontier) for (let k = burnt ? 0 : 1; k < n; k++) { const t = flip(s, k), e = enc(t); if (!dist.has(e)) { dist.set(e, layers.length); nxt.push(t); } }
      if (nxt.length) layers.push(nxt.map(enc));
      frontier = nxt;
    }
    const T = { dist, layers, enc, dec, flip, burnt, n };
    pancakeTables.set(key, T);
    return T;
  }
  C.pancakeTable = pancakeTable;

  C.register({
    id: "pancake", cat: "arrays", name: "Pancake Flip", concept: "Prefix reversal · BFS",
    blurb: "A spatula flips the top of the stack. Sort it in the fewest flips.",
    tiers: ["3–5 pancakes", "6 pancakes", "7–8 pancakes", "4–6 burnt pancakes"],
    lesson: `<p>The only move is a <b>prefix reversal</b>: slide the spatula under a pancake and flip everything above it. A simple strategy flips the largest unsorted pancake to the top, then flips it down into place. That uses at most 2n − 3 flips but is rarely optimal.</p>
      <p>Par here is the true optimum, found by <b>breadth-first search</b> over every arrangement (n! of them). Finding the fewest flips in general is NP-hard. Bill Gates co-authored a 1979 paper on exactly this problem.</p>
      <p><b>Burnt pancakes</b> have a dark side that must face down, and every flip turns pancakes over, so a single pancake can be worth flipping on its own.</p>`,
    hint: "Look for a flip that makes two neighbouring sizes touch (like 3 next to 4). Joining adjacent sizes is how optimal solutions make progress.",
    gen(L, R, t) {
      const burnt = t === 3;
      const n = burnt ? [4, 4, 5, 5, 5, 5, 6, 6, 6, 6][L - 31] : t === 0 ? [3, 3, 4, 4, 4, 4, 5, 5, 5, 5][L - 1] : t === 1 ? 6 : [7, 7, 7, 7, 7, 8, 8, 8, 8, 8][L - 21];
      const T = pancakeTable(n, burnt);
      const maxD = T.layers.length - 1, i = (L - 1) % 10;
      let d = Math.max(2, maxD - (i < 3 ? 2 : i < 7 ? 1 : 0) - (t === 0 && i < 2 ? 1 : 0));
      if (T.layers[d].length < 6 || R.chance(0.15)) d = Math.max(2, d - 1);   // the outermost layers hold only a handful of stacks
      const key = R.pick(T.layers[d]);
      const s = T.dec(key), sol = [];
      let cur = s;
      while (T.dist.get(T.enc(cur)) > 0) {
        for (let k = burnt ? 0 : 1; k < n; k++) { const nx = T.flip(cur, k); if (T.dist.get(T.enc(nx)) === T.dist.get(T.enc(cur)) - 1) { sol.push(k); cur = nx; break; } }
      }
      return { stack: s, n, burnt, par: d, solution: sol, goal: `Tap a pancake to flip it and everything above it. Get the stack in order, smallest on top${burnt ? ", with every <b>burnt side facing down</b>" : ""}. Par is <b>${d}</b> flips.` };
    },
    view(el, P, api) {
      const T = pancakeTable(P.n, P.burnt);
      let s = P.stack.slice(), flips = 0;
      el.innerHTML = `<div class="pancakes"></div><div class="plate"></div>`;
      const box = el.querySelector(".pancakes");
      function render() {
        box.innerHTML = s.map((v, k) => {
          const size = Math.abs(v), up = v < 0;
          return `<button type="button" class="pancake${up ? " up" : ""}${P.burnt ? " burnt" : ""}" data-k="${k}" style="--w:${30 + (size / P.n) * 70}%" aria-label="Pancake ${size}${P.burnt ? (up ? ", burnt side up" : ", burnt side down") : ""}. Flip top ${k + 1}"><span>${size}</span></button>`;
        }).join("");
        api.stats([["Flips", flips], ["Par", P.par]]);
      }
      function move(k) {
        if (api.over) return;
        if (!P.burnt && k === 0) { api.say("Flipping just the top pancake changes nothing here."); return; }
        s = T.flip(s, k);
        flips++;
        render();
        if (T.dist.get(T.enc(s)) === 0) {
          api.win({ stars: C.stars(flips, P.par, 2), text: `${flips} flips against an optimum of ${P.par}, found by breadth-first search over all ${P.burnt ? "2ⁿ · n!" : "n!"} = ${T.dist.size.toLocaleString()} stacks. The largest-to-the-top strategy guarantees at most ${P.burnt ? 3 * P.n - 2 : 2 * P.n - 3} flips.` });
        } else api.say(`This stack is ${T.dist.get(T.enc(s))} flip${T.dist.get(T.enc(s)) === 1 ? "" : "s"} from sorted at best.`);
      }
      C.onPick(box, "data-k", (v) => move(+v));
      render();
      return { move };
    },
  });

  /* ===================== Train Yard ===================== */
  // State: input index, sidings (stacks), next car expected at output.
  function yardSolve(order, sidings) {
    const n = order.length;
    const key = (st) => st.i + "|" + st.s.map((x) => x.join(",")).join("/") + "|" + st.next;
    const start = { i: 0, s: U.range(sidings).map(() => []), next: 1 };
    const moves = (st) => {
      const out = [];
      if (st.i < n && order[st.i] === st.next) out.push(["io", { i: st.i + 1, s: st.s, next: st.next + 1 }]);
      st.s.forEach((stk, k) => { if (stk.length && stk[stk.length - 1] === st.next) { const s2 = st.s.map((x) => x.slice()); s2[k].pop(); out.push([k + "o", { i: st.i, s: s2, next: st.next + 1 }]); } });
      if (st.i < n) st.s.forEach((_, k) => { const s2 = st.s.map((x) => x.slice()); s2[k].push(order[st.i]); out.push(["i" + k, { i: st.i + 1, s: s2, next: st.next }]); });
      return out;
    };
    const prev = new Map([[key(start), null]]);
    let q = [start];
    while (q.length) {
      const nq = [];
      for (const st of q) {
        if (st.next > n) {
          const path = []; let k = key(st);
          while (prev.get(k)) { const [pk, m] = prev.get(k); path.unshift(m); k = pk; }
          return path;
        }
        for (const [m, ns] of moves(st)) { const k = key(ns); if (!prev.has(k)) { prev.set(k, [key(st), m]); nq.push(ns); } }
      }
      q = nq;
    }
    return null;
  }
  C.yardSolve = yardSolve;

  C.register({
    id: "trainyard", cat: "arrays", name: "Train Yard", concept: "Stacks",
    blurb: "Shunt cars through dead-end sidings so they leave in order 1, 2, 3, …",
    tiers: ["One siding, 4–6 cars", "One siding, 6–9 cars", "Two sidings, 6–8 cars", "Two sidings, 8–10 cars"],
    lesson: `<p>A dead-end siding is a <b>stack</b>: the last car in is the first car out. Cars leave in order 1, 2, 3, … and may go straight through when they're next.</p>
      <p>One stack can sort an arrival order exactly when it contains no <b>2-3-1 pattern</b> (Knuth, 1968). If a big car parks on top of a smaller one you still need, you're stuck.</p>
      <p>With two sidings the question becomes graph colouring. Two cars that can't share a siding get an edge, and the order is sortable when that conflict graph is <b>bipartite</b>.</p>`,
    hint: "Send a car out the moment it's next. Before parking a car, check it isn't bigger than one it would sit on top of that must leave first.",
    gen(L, R, t) {
      const sidings = t >= 2 ? 2 : 1;
      const n = t === 0 ? 4 + Math.floor((L - 1) / 4) : t === 1 ? 6 + Math.floor((L - 11) / 3.4) : t === 2 ? 6 + Math.floor((L - 21) / 4) : 8 + Math.floor((L - 31) / 4);
      for (let tries = 0; tries < 400; tries++) {
        const order = R.perm(n);
        if (order[0] === 1) continue;
        const sol = yardSolve(order, sidings);
        if (!sol) continue;
        if (sidings === 2 && yardSolve(order, 1)) continue;          // must genuinely need the second siding
        if (sol.length < n + Math.ceil(n * (t === 0 ? 0.3 : 0.5))) continue; // enough shunting to be interesting
        return { order, sidings, n, par: sol.length, solution: sol, goal: `Cars arrive from the left. Send them out the right in order <b>1, 2, 3, …</b>. ${sidings === 2 ? "There are <b>two</b> dead-end sidings." : "The dead-end siding works like a stack."} Par is <b>${sol.length}</b> moves.` };
      }
      return null;
    },
    view(el, P, api) {
      let i = 0, next = 1, moves = 0;
      const s = U.range(P.sidings).map(() => []), out = [];
      el.innerHTML = `<div class="yard"></div><div class="actions yard-btns"></div>`;
      const yard = el.querySelector(".yard"), btns = el.querySelector(".yard-btns");
      const car = (v, extra = "") => `<span class="car${v === next ? " nextcar" : ""} ${extra}">${v}</span>`;
      const legal = () => {
        const L = [];
        if (i < P.n && P.order[i] === next) L.push(["io", `Car ${P.order[i]} → Out`]);
        s.forEach((stk, k) => { if (stk.length && stk[stk.length - 1] === next) L.push([k + "o", `Siding ${"AB"[k]} → Out`]); });
        if (i < P.n) s.forEach((_, k) => L.push(["i" + k, `Car ${P.order[i]} → Siding ${"AB"[k]}`]));
        return L;
      };
      function render() {
        yard.innerHTML = `
          <div class="track"><span class="tlabel">Arriving</span><span class="cars in">${P.order.slice(i).map((v) => car(v)).reverse().join("")}</span><span class="arrowto">→</span></div>
          ${s.map((stk, k) => `<div class="track siding"><span class="tlabel">Siding ${"AB"[k]}</span><span class="cars">${stk.map((v, j) => car(v, j === stk.length - 1 ? "top" : "")).join("")}<span class="buffer">▕</span></span></div>`).join("")}
          <div class="track"><span class="tlabel">Departed</span><span class="cars">${out.map((v) => `<span class="car done">${v}</span>`).join("")}</span></div>`;
        btns.innerHTML = legal().map(([m, label]) => `<button type="button" class="btn${m.endsWith("o") ? " primary" : ""}" data-m="${m}">${label}</button>`).join("");
        api.stats([["Moves", moves], ["Par", P.par], ["Next out", next <= P.n ? next : "–"]]);
      }
      function move(m) {
        if (api.over || !legal().some(([x]) => x === m)) return;
        if (m === "io") { out.push(P.order[i++]); next++; }
        else if (m[1] === "o") { out.push(s[+m[0]].pop()); next++; }
        else s[+m[1]].push(P.order[i++]);
        moves++;
        render();
        if (next > P.n) return api.win({ stars: C.stars(moves, P.par, 2), text: `${moves} moves (par ${P.par}). Every car must leave once, and each one that parks costs one extra move. The best plan parks only the cars that must wait.` });
        const k = s.findIndex((stk) => stk.some((v, j) => j > 0 && stk[j - 1] < v));
        if (k >= 0) {
          const stk = s[k], j = stk.findIndex((v, j2) => j2 > 0 && stk[j2 - 1] < v);
          return api.lose(`Car ${stk[j]} is parked on top of car ${stk[j - 1]} in siding ${"AB"[k]}, but ${stk[j - 1]} has to leave first. A stack can never fix that: it's the 2-3-1 pattern. Cars in a siding must get smaller towards the open end.`);
        }
        if (!legal().length) api.lose(`Deadlock: car ${next} can't reach the exit.`);
      }
      C.onPick(btns, "data-m", move);
      render();
      return { move };
    },
  });
})();
