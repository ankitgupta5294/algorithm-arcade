/* Campaign worlds: Greedy & dynamic programming. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign;

  /* ===================== Huffman Forge ===================== */
  function huffman(ws, arity) {
    const items = ws.map((w, i) => ({ w, id: i }));
    let next = ws.length, cost = 0;
    const merges = [];
    while (items.length > 1) {
      items.sort((a, b) => a.w - b.w || a.id - b.id);
      const take = items.splice(0, arity);
      const w = take.reduce((s, x) => s + x.w, 0);
      cost += w;
      merges.push(take.map((x) => x.id));
      items.push({ w, id: next++ });
    }
    return { cost, merges };
  }
  C.register({
    id: "huffman", cat: "greedy", name: "Huffman Forge", concept: "Greedy · Huffman codes",
    blurb: "Merge symbols into a code tree. Frequent letters should end up with short codes.",
    tiers: ["4–5 symbols", "6–8 symbols", "9–12 symbols", "Three-way merges"],
    lesson: `<p>A prefix code gives each symbol a bit string, and its cost is Σ frequency × code length. Building the code tree by merging nodes, each merge adds the merged weight to the total (every symbol below it gets one bit longer).</p>
      <p><b>Huffman's greedy rule:</b> always merge the two <i>lightest</i> nodes. The two rarest symbols can be deepest siblings in some optimal tree, and merging them leaves a smaller instance of the same problem.</p>
      <p><b>Three-way trees</b> merge three at a time. The count only works out when (n − 1) is divisible by 2, so zero-weight dummy symbols pad the bottom level. That's why some ∅ nodes appear.</p>`,
    hint: "Always merge the lightest nodes in the pool, even ones you just created.",
    gen(L, R, t) {
      const arity = t === 3 ? 3 : 2;
      const n = t === 0 ? 4 + (L > 5 ? 1 : 0) : t === 1 ? 6 + Math.floor((L - 11) / 4) : t === 2 ? 9 + Math.floor((L - 21) / 3) : 5 + Math.floor((L - 31) / 2.5);
      const ws = U.range(n).map(() => R.int(1, t === 0 ? 12 : 30));
      const syms = U.letters.slice(0, n);
      if (arity === 3) while ((ws.length - 1) % 2) { ws.push(0); syms.push("∅"); }
      const { cost, merges } = huffman(ws, arity);
      // a natural wrong strategy (merge in alphabetical order) should be worse
      let naive = 0; { let acc = ws[0]; for (let i = 1; i < ws.length; i++) { acc += ws[i]; naive += acc; } }
      if (naive === cost) return null;
      return { ws, syms, arity, par: cost, solution: merges, goal: `Tap ${arity === 3 ? "three" : "two"} nodes to merge them. Each merge costs the sum of their weights. Keep merging until one tree remains, for the <b>lowest total cost</b> (par <b>${cost}</b>).` };
    },
    view(el, P, api) {
      const pool = P.ws.map((w, i) => ({ id: i, w, kids: null, sym: P.syms[i] }));
      const all = new Map(pool.map((x) => [x.id, x]));
      let next = P.ws.length, cost = 0, sel = [];
      el.innerHTML = `<div class="hpool"></div><div class="ptr-readout"></div>`;
      const box = el.querySelector(".hpool"), out = el.querySelector(".ptr-readout");
      const leaves = (x) => (x.kids ? x.kids.flatMap((k) => leaves(all.get(k))).join("") : x.sym);
      function render() {
        box.innerHTML = pool.slice().sort((a, b) => a.w - b.w).map((x) => `<button type="button" class="hnode${sel.includes(x.id) ? " sel" : ""}${x.kids ? " merged" : ""}" data-id="${x.id}"><b>${x.w}</b><small>${U.esc(leaves(x))}</small></button>`).join("");
        out.innerHTML = `Total cost so far: <b>${cost}</b>` + (sel.length ? ` · selected ${sel.map((id) => all.get(id).w).join(" + ")}` : "");
        api.stats([["Cost", cost], ["Par", P.par], ["Nodes", pool.length]]);
      }
      function codes(x, pre, outArr) { if (!x.kids) { if (x.sym !== "∅") outArr.push([x.sym, x.w, pre || "0"]); return; } x.kids.forEach((k, i) => codes(all.get(k), pre + i, outArr)); }
      function move(ids) {
        if (api.over) return;
        const items = ids.map((id) => pool.find((x) => x.id === id));
        if (items.some((x) => !x)) return;
        const w = items.reduce((s, x) => s + x.w, 0);
        items.forEach((x) => pool.splice(pool.indexOf(x), 1));
        const node = { id: next++, w, kids: ids.slice(), sym: "" };
        pool.push(node); all.set(node.id, node);
        cost += w; sel = [];
        render();
        if (pool.length === 1) {
          const tbl = []; codes(pool[0], "", tbl);
          const table = `<table class="codes"><tr><th>Symbol</th><th>Freq</th><th>Code</th></tr>${tbl.sort((a, b) => a[2].length - b[2].length).map(([s, f, c]) => `<tr><td>${s}</td><td>${f}</td><td class="mono">${c}</td></tr>`).join("")}</table>`;
          if (cost === P.par) api.win({ stars: 3, text: `Total cost ${cost}, which is optimal. Frequent symbols got short codes:${table}` });
          else api.lose(`Total cost ${cost}, but ${P.par} was possible. Merging anything other than the lightest ${P.arity === 3 ? "three" : "two"} nodes pushes heavy symbols deeper, and each extra level costs their full weight again.${table}`);
        }
      }
      C.onPick(box, "data-id", (v) => {
        const id = +v;
        if (sel.includes(id)) sel = sel.filter((x) => x !== id); else sel.push(id);
        if (sel.length === P.arity) move(sel.slice()); else render();
      });
      render();
      return { move };
    },
  });

  /* ===================== Knapsack Packer ===================== */
  const ITEMS = ["Laptop", "Camera", "Tent", "Stove", "Rope", "Book", "Drone", "Guitar", "Lamp", "Kettle", "Boots", "Radio", "Map", "Torch", "Hammock", "Skillet"];
  C.register({
    id: "knapsack", cat: "greedy", name: "Knapsack Packer", concept: "0/1 knapsack DP",
    blurb: "Pack the most valuable load that fits. Best value-per-kilo is a trap.",
    tiers: ["4–5 items", "6–7 items", "8–10 items", "Weight and volume limits"],
    lesson: `<p>In the <b>0/1 knapsack</b> each item is taken whole or not at all. Greedy by value-per-weight is optimal only when items can be cut into fractions. Here it can leave a gap that a different combination would have filled better.</p>
      <p><b>DP:</b> best[i][c] = max(best[i−1][c], value_i + best[i−1][c − weight_i]): either skip item i, or take it and solve the rest with less capacity. That's O(n · capacity), pseudo-polynomial.</p>
      <p>With <b>two limits</b> (weight and volume) the table gets a second capacity dimension. The idea doesn't change, but the table grows fast.</p>`,
    hint: "Fill the bag with combinations, not just the best ratio. Check whether swapping one item for two smaller ones uses the leftover capacity better.",
    gen(L, R, t) {
      const n = t === 0 ? 4 + (L > 5 ? 1 : 0) : t === 1 ? 6 + (L > 15 ? 1 : 0) : t === 2 ? 8 + Math.floor((L - 21) / 4) : 6 + Math.floor((L - 31) / 4);
      const two = t === 3;
      const items = U.range(n).map(() => ({ w: R.int(1, 9), v: R.int(2, 20), vol: two ? R.int(1, 9) : 0 }));
      const sumW = items.reduce((s, x) => s + x.w, 0), sumV = items.reduce((s, x) => s + x.vol, 0);
      const cap = Math.max(4, Math.round(sumW * R.int(35, 55) / 100)), vcap = two ? Math.max(4, Math.round(sumV * R.int(40, 60) / 100)) : Infinity;
      let best = -1, bestSet = null, count = 0;
      for (let m = 0; m < 1 << n; m++) {
        let w = 0, v = 0, vol = 0;
        for (let i = 0; i < n; i++) if (m >> i & 1) { w += items[i].w; v += items[i].v; vol += items[i].vol; }
        if (w <= cap && vol <= vcap) { if (v > best) { best = v; bestSet = m; count = 1; } else if (v === best) count++; }
      }
      // greedy by ratio must fall short
      let gw = 0, gv = 0, gvol = 0;
      items.map((x, i) => ({ ...x, i })).sort((a, b) => b.v / (b.w + b.vol) - a.v / (a.w + a.vol)).forEach((x) => { if (gw + x.w <= cap && gvol + x.vol <= vcap) { gw += x.w; gv += x.v; gvol += x.vol; } });
      if (gv === best || count > 2) return null;
      const sol = U.range(n).filter((i) => bestSet >> i & 1);
      return { items, names: R.sample(ITEMS, n), cap, vcap, two, best, greedy: gv, par: best, solution: [...sol, "pack"],
        goal: `Tap items to put them in the bag. Stay within <b>${cap} kg</b>${two ? ` and <b>${vcap} L</b>` : ""} and get the <b>highest total value</b>, then press Pack. Three tries.` };
    },
    view(el, P, api) {
      const take = new Set(); let tries = 0;
      el.innerHTML = `<div class="ksack"></div><div class="kbars"></div><div class="actions"><button type="button" class="btn primary pack">Pack</button></div>`;
      const box = el.querySelector(".ksack"), bars = el.querySelector(".kbars"), pack = el.querySelector(".pack");
      const tot = (k) => [...take].reduce((s, i) => s + P.items[i][k], 0);
      function render() {
        box.innerHTML = P.items.map((x, i) => `<button type="button" class="kitem${take.has(i) ? " on" : ""}" data-i="${i}"><b>${P.names[i]}</b><span>${x.w} kg${P.two ? ` · ${x.vol} L` : ""}</span><span class="kv">$${x.v}</span></button>`).join("");
        const w = tot("w"), vol = tot("vol");
        bars.innerHTML = `<div class="kbar${w > P.cap ? " over" : ""}"><span>Weight ${w}/${P.cap} kg</span><i style="width:${Math.min(100, (w / P.cap) * 100)}%"></i></div>` + (P.two ? `<div class="kbar${vol > P.vcap ? " over" : ""}"><span>Volume ${vol}/${P.vcap} L</span><i style="width:${Math.min(100, (vol / P.vcap) * 100)}%"></i></div>` : "");
        pack.disabled = api.over || w > P.cap || vol > P.vcap;
        api.stats([["Value", "$" + tot("v")], ["Tries", `${tries}/3`]]);
      }
      function move(m) {
        if (api.over) return;
        if (m === "pack") {
          if (tot("w") > P.cap || tot("vol") > P.vcap) return;
          tries++;
          const v = tot("v");
          if (v === P.best) { render(); return api.win({ stars: 4 - tries, text: `$${v} is the best possible. Taking items by value-per-weight would only reach $${P.greedy}, because whole items leave gaps. The DP table best[i][capacity] checks every useful combination in O(n · capacity).` }); }
          if (tries >= 3) { render(); return api.lose(`The best load was worth $${P.best}. Greedy by ratio reaches $${P.greedy}. Only checking combinations finds the real optimum.`); }
          api.say(`$${v} fits, but a better load exists.`, "lose");
          render(); return;
        }
        if (take.has(m)) take.delete(m); else take.add(m);
        api.say(""); render();
      }
      C.onPick(box, "data-i", (v) => move(+v));
      pack.addEventListener("click", () => move("pack"));
      render();
      return { move };
    },
  });

  /* ===================== Matrix Chain / Stone Merge ===================== */
  function chainDP(n, costFn) {
    // dp over intervals of blocks [i..j]
    const dp = U.range(n).map(() => Array(n).fill(0)), split = U.range(n).map(() => Array(n).fill(-1));
    for (let len = 2; len <= n; len++) for (let i = 0; i + len - 1 < n; i++) {
      const j = i + len - 1; dp[i][j] = Infinity;
      for (let k = i; k < j; k++) { const c = dp[i][k] + dp[k + 1][j] + costFn(i, k, j); if (c < dp[i][j]) { dp[i][j] = c; split[i][j] = k; } }
    }
    return { best: dp[0][n - 1], split };
  }
  C.register({
    id: "chain", cat: "greedy", name: "Matrix Chain", concept: "Interval DP",
    blurb: "Choose which neighbours to combine first. The order changes the cost a lot.",
    tiers: ["3 matrices", "4 matrices", "5–6 matrices", "Merging stone piles"],
    lesson: `<p>Multiplying a p×q matrix by a q×r one costs p·q·r. Matrix multiplication is associative, so (AB)C and A(BC) give the same result, but their costs can differ by orders of magnitude.</p>
      <p><b>Interval DP:</b> cost(i, j) = min over split points k of cost(i, k) + cost(k+1, j) + (cost of the final multiplication). Solving all intervals from short to long takes O(n³).</p>
      <p><b>Stone merging</b> has the same shape: merging two neighbouring piles costs their combined size. "Cheapest merge first" is greedy and can be wrong, while interval DP is always right.</p>`,
    hint: "The cheapest multiplication right now isn't always best. Think about which dimension you want to get rid of first, and which to keep until the last multiplication.",
    gen(L, R, t) {
      const stones = t === 3;
      const k = t === 0 ? 3 : t === 1 ? 4 : t === 2 ? (L <= 25 ? 5 : 6) : 5 + Math.floor((L - 31) / 4);
      const dims = stones ? U.range(k).map(() => R.int(1, 15)) : U.range(k + 1).map(() => R.pick([2, 3, 4, 5, 6, 8, 10, 12, 15, 20]));
      const pre = [0]; if (stones) dims.forEach((x) => pre.push(pre[pre.length - 1] + x));
      const costFn = stones ? (i, _k, j) => pre[j + 1] - pre[i] : (i, kk, j) => dims[i] * dims[kk + 1] * dims[j + 1];
      const { best, split } = chainDP(k, costFn);
      // simulate greedy (cheapest available merge first) — should be worse from Medium on
      const greedy = (() => {
        let blocks = U.range(k).map((i) => [i, i]); let total = 0;
        while (blocks.length > 1) {
          let bi = 0, bc = Infinity;
          for (let i = 0; i + 1 < blocks.length; i++) { const c = costFn(blocks[i][0], blocks[i][1], blocks[i + 1][1]); if (c < bc) { bc = c; bi = i; } }
          total += bc; blocks.splice(bi, 2, [blocks[bi][0], blocks[bi + 1][1]]);
        }
        return total;
      })();
      if (t >= 1 && greedy === best) return null;
      if (t === 0 && best === greedy && R.chance(0.5)) return null;
      // build the move list: gap indices in the current block list
      const order = [];
      (function post(i, j) { if (i === j) return; const s = split[i][j]; post(i, s); post(s + 1, j); order.push([i, s, j]); })(0, k - 1);
      let blocks = U.range(k).map((i) => [i, i]); const sol = [];
      order.forEach(([i, , j]) => { const g = blocks.findIndex((b) => b[0] === i); sol.push(g); blocks.splice(g, 2, [i, j]); });
      return { stones, dims, k, best, greedy, par: best, solution: sol,
        goal: stones
          ? `Merge neighbouring piles of stones until one pile remains. Each merge costs the size of the new pile. Get the <b>lowest total cost</b> (par <b>${best}</b>).`
          : `Multiply the chain down to one matrix by tapping the <b>×</b> between two neighbours. Each multiplication of a p×q by a q×r matrix costs p·q·r. Get the <b>lowest total</b> (par <b>${best}</b>).` };
    },
    view(el, P, api) {
      const names = "ABCDEFGHIJ";
      let blocks = U.range(P.k).map((i) => ({ i, j: i, label: P.stones ? String(P.dims[i]) : names[i] })), total = 0;
      el.innerHTML = `<div class="chain"></div><div class="ptr-readout"></div>`;
      const box = el.querySelector(".chain"), out = el.querySelector(".ptr-readout");
      const rows = (b) => P.dims[b.i], cols = (b) => P.dims[b.j + 1];
      const size = (b) => P.dims.slice(b.i, b.j + 1).reduce((s, x) => s + x, 0);
      const mergeCost = (a, b) => (P.stones ? size(a) + size(b) : rows(a) * cols(a) * cols(b));
      function render() {
        box.innerHTML = blocks.map((b, g) => {
          const blk = P.stones
            ? `<span class="blk stone" style="--s:${Math.min(1, size(b) / 40)}"><b>${size(b)}</b><small>${b.label}</small></span>`
            : `<span class="blk"><b>${U.esc(b.label)}</b><small>${rows(b)}×${cols(b)}</small></span>`;
          const gap = g < blocks.length - 1 ? `<button type="button" class="gap" data-g="${g}" aria-label="Combine ${U.esc(b.label)} with ${U.esc(blocks[g + 1].label)}">${P.stones ? "+" : "×"}<small>${mergeCost(b, blocks[g + 1])}</small></button>` : "";
          return blk + gap;
        }).join("");
        out.innerHTML = `Cost so far: <b>${total}</b>`;
        api.stats([["Cost", total], ["Par", P.par]]);
      }
      function move(g) {
        if (api.over || g < 0 || g >= blocks.length - 1) return;
        const a = blocks[g], b = blocks[g + 1];
        total += mergeCost(a, b);
        blocks.splice(g, 2, { i: a.i, j: b.j, label: P.stones ? `${a.label}+${b.label}`.replace(/^(.{14}).+$/, "$1…") : `(${a.label}${b.label})` });
        render();
        if (blocks.length === 1) {
          if (total === P.par) api.win({ stars: 3, text: `Total ${total}, the minimum. Always taking the cheapest step available would cost ${P.greedy}. Interval DP tries every final split and reuses the answers for sub-chains.` });
          else api.lose(`Total ${total}, but ${P.par} was possible${P.greedy !== P.par ? ` (cheapest-step-first gives ${P.greedy})` : ""}. Decide which pair is multiplied <i>last</i>, then solve each side.`);
        }
      }
      C.onPick(box, "data-g", (v) => move(+v));
      render();
      return { move };
    },
  });

  /* ===================== Stock Trader ===================== */
  function bestTrades(p, maxTx, fee) {
    const n = p.length; let best = 0, bestDays = [];
    // brute force over day subsets: chosen days alternate buy, sell, buy, sell …
    for (let m = 0; m < 1 << n; m++) {
      const days = []; for (let i = 0; i < n; i++) if (m >> i & 1) days.push(i);
      if (days.length % 2 || days.length / 2 > maxTx) continue;
      let pr = 0; for (let k = 0; k < days.length; k += 2) pr += p[days[k + 1]] - p[days[k]] - fee;
      if (pr > best || (pr === best && days.length < bestDays.length)) { best = pr; bestDays = days; }
    }
    return { best, days: bestDays };
  }
  const profitOf = (p, days, fee) => { let pr = 0; for (let k = 0; k + 1 < days.length; k += 2) pr += p[days[k + 1]] - p[days[k]] - fee; return pr; };
  C.register({
    id: "stocks", cat: "greedy", name: "Stock Trader", concept: "State-machine DP",
    blurb: "Buy low, sell high, under different trading rules.",
    tiers: ["One trade", "Unlimited trades", "At most two trades", "Unlimited trades with a fee"],
    lesson: `<p><b>One trade:</b> scan once, tracking the lowest price so far. Today's best sale is today's price minus that minimum.</p>
      <p><b>Unlimited trades:</b> collect every rise, the sum of all positive day-to-day differences. That's greedy, and it's optimal.</p>
      <p><b>At most k trades</b> or <b>with a fee</b>: think of states ("holding a share" and "not holding") and transitions between them. The DP is hold[i] = max(hold[i−1], cash[i−1] − price) and cash[i] = max(cash[i−1], hold[i−1] + price − fee). A fee makes small wiggles not worth trading.</p>`,
    hint: "Tap days to mark them. Markers alternate buy, sell, buy, sell. Check whether merging two trades into one would save a fee.",
    gen(L, R, t) {
      const n = t === 0 ? 6 + Math.floor((L - 1) / 3) : t === 1 ? 8 + Math.floor((L - 11) / 3) : 9 + Math.floor(((L - 1) % 10) / 3);
      const maxTx = t === 0 ? 1 : t === 2 ? 2 : 99, fee = t === 3 ? R.int(2, 3) : 0;
      let v = R.int(8, 14); const p = [];
      for (let i = 0; i < n; i++) { p.push(v); v = Math.max(1, v + R.int(-5, 5)); }
      const { best, days } = bestTrades(p, maxTx, fee);
      if (best <= 0 || days.length < (t === 0 ? 2 : 4)) return null;
      // naive "biggest single rise" should be worse when more trades are allowed
      return { p, n, maxTx, fee, best, par: best, solution: [...days, "lock"],
        goal: `Tap days to mark trades. Markers alternate <b>buy → sell</b>. ${t === 0 ? "Make <b>one</b> trade." : t === 2 ? "Make <b>at most two</b> trades." : "Trade as often as you like" + (fee ? `, but each trade pays a <b>$${fee} fee</b>.` : ".")} Get the <b>maximum profit</b>, then lock in. Three tries.` };
    },
    view(el, P, api) {
      const days = new Set(); let tries = 0;
      el.innerHTML = `<div class="stock"></div><div class="ptr-readout"></div><div class="actions"><button type="button" class="btn primary lock">Lock in</button></div>`;
      const box = el.querySelector(".stock"), out = el.querySelector(".ptr-readout"), lock = el.querySelector(".lock");
      const maxP = Math.max(...P.p);
      function render() {
        const d = [...days].sort((a, b) => a - b);
        box.innerHTML = P.p.map((v, i) => { const k = d.indexOf(i); const role = k < 0 ? "" : k % 2 ? " sell" : " buy"; return `<button type="button" class="sday${role}" data-i="${i}" aria-label="Day ${i + 1}, price ${v}${role ? "," + role : ""}"><span class="scol"><span class="sfill" style="height:${(v / maxP) * 100}%"></span></span><span class="sv">$${v}</span><span class="sd">${role ? (role === " buy" ? "BUY" : "SELL") : "D" + (i + 1)}</span></button>`; }).join("");
        const valid = d.length % 2 === 0 && d.length / 2 <= P.maxTx;
        out.innerHTML = `${d.length / 2 >> 0} trade${(d.length / 2 >> 0) === 1 ? "" : "s"}${d.length % 2 ? " + an open buy" : ""} · profit <b>$${profitOf(P.p, d, P.fee)}</b>${d.length / 2 > P.maxTx ? ' · <span class="lose">too many trades</span>' : ""}`;
        lock.disabled = api.over || !valid || !d.length;
        api.stats([["Profit", "$" + profitOf(P.p, d, P.fee)], ["Tries", `${tries}/3`]]);
      }
      function move(m) {
        if (api.over) return;
        if (m === "lock") {
          const d = [...days].sort((a, b) => a - b);
          if (d.length % 2 || d.length / 2 > P.maxTx) return;
          tries++;
          const pr = profitOf(P.p, d, P.fee);
          if (pr === P.best) { render(); return api.win({ stars: 4 - tries, text: `$${pr} is the maximum. ${P.maxTx === 1 ? "Track the lowest price so far and sell where price minus that minimum peaks." : P.fee ? "With a fee, merge rises separated by small dips into one trade." : P.maxTx === 2 ? "With two trades, the best split point divides the days into two one-trade problems." : "With unlimited trades, every upward step is profit."}` }); }
          if (tries >= 3) { render(); return api.lose(`The maximum was $${P.best}, for example buying and selling on days ${(() => { const s = []; for (let k = 0; k < P.solution.length - 1; k += 2) s.push(`${P.solution[k] + 1}→${P.solution[k + 1] + 1}`); return s.join(", "); })()}.`); }
          api.say(`$${pr} isn't the maximum.`, "lose");
          render(); return;
        }
        if (days.has(m)) days.delete(m); else days.add(m);
        api.say(""); render();
      }
      C.onPick(box, "data-i", (v) => move(+v));
      lock.addEventListener("click", () => move("lock"));
      render();
      return { move };
    },
  });

  /* ===================== Meeting Planner ===================== */
  const overlap = (a, b) => a.s < b.e && b.s < a.e;
  C.register({
    id: "meetings", cat: "greedy", name: "Meeting Planner", concept: "Interval scheduling",
    blurb: "Fit the most meetings into one room, the most valuable ones, then use as few rooms as possible.",
    tiers: ["Most meetings", "More meetings", "Most valuable meetings", "Fewest rooms"],
    lesson: `<p><b>Most meetings in one room:</b> repeatedly take the meeting that <i>ends earliest</i> among those that don't clash. Ending early leaves the most room for everything else, and an exchange argument proves it optimal. Picking the shortest or the earliest-starting meeting can fail.</p>
      <p><b>With values</b> greedy breaks. Sort by end time; best(i) = max(best(i−1), value_i + best(last meeting that ends before i starts)). That's weighted interval scheduling with binary search, O(n log n).</p>
      <p><b>Fewest rooms</b> equals the largest number of meetings happening at the same instant. Sweep the starts in order and reuse any room that has already freed up.</p>`,
    hint: "One room: keep choosing the compatible meeting that finishes first. Rooms: process meetings by start time and reuse a free room whenever possible.",
    gen(L, R, t) {
      const n = t === 0 ? 6 + Math.floor((L - 1) / 3) : t === 1 ? 9 + Math.floor((L - 11) / 3) : t === 2 ? 7 + Math.floor((L - 21) / 3) : 8 + Math.floor((L - 31) / 2.5);
      const iv = U.range(n).map(() => { const s = R.int(8, 17), len = R.int(1, t === 3 ? 4 : 3); return { s, e: Math.min(20, s + len), v: t === 2 ? R.int(1, 9) : 1 }; });
      if (iv.some((a, i) => iv.some((b, j) => i < j && a.s === b.s && a.e === b.e))) return null;
      if (t === 3) {
        const sorted = iv.map((x, i) => ({ ...x, i })).sort((a, b) => a.s - b.s);
        const roomEnd = [], assign = [];
        sorted.forEach((x) => { let r = roomEnd.findIndex((e) => e <= x.s); if (r < 0) { r = roomEnd.length; roomEnd.push(0); } roomEnd[r] = x.e; assign.push([x.i, r]); });
        const rooms = roomEnd.length;
        if (rooms < 3) return null;
        return { mode: "rooms", iv, rooms, par: rooms, solution: assign, goal: `Pick a room, then tap meetings to book them there. Meetings in the same room can't overlap. Book everything using only <b>${rooms}</b> rooms.` };
      }
      let best = -1, bestSet = 0;
      for (let m = 0; m < 1 << n; m++) {
        const pick = iv.filter((_, i) => m >> i & 1);
        if (pick.some((a, i) => pick.some((b, j) => i < j && overlap(a, b)))) continue;
        const v = pick.reduce((s, x) => s + x.v, 0);
        if (v > best) { best = v; bestSet = m; }
      }
      // tempting wrong rules should fail
      const greedyBy = (key) => { const chosen = []; iv.slice().sort(key).forEach((x) => { if (!chosen.some((c) => overlap(c, x))) chosen.push(x); }); return chosen.reduce((s, x) => s + x.v, 0); };
      const shortest = greedyBy((a, b) => a.e - a.s - (b.e - b.s) || a.s - b.s), earliest = greedyBy((a, b) => a.s - b.s), endFirst = greedyBy((a, b) => a.e - b.e);
      if (t < 2 && shortest === best && earliest === best) return null;
      if (t === 2 && endFirst === best) return null;
      const sol = U.range(n).filter((i) => bestSet >> i & 1);
      return { mode: t === 2 ? "value" : "count", iv, best, par: best, solution: [...sol, "lock"],
        goal: t === 2 ? "Tap meetings to schedule them in one room. They can't overlap (back-to-back is fine). Get the <b>highest total value</b>, then lock in. Three tries."
          : "Tap meetings to schedule them in one room. They can't overlap (back-to-back is fine). Fit in <b>as many as possible</b>, then lock in. Three tries." };
    },
    view(el, P, api) {
      const n = P.iv.length, room = Array(n).fill(-1), chosen = new Set();
      let tries = 0, pen = 0, paints = 0;
      const COLORS = ["#1c7ed6", "#e8590c", "#2f9e44", "#ae3ec9", "#f59f00", "#0ca678"];
      // stack meetings into display lanes
      const lanes = []; const laneOf = [];
      P.iv.map((x, i) => ({ ...x, i })).sort((a, b) => a.s - b.s).forEach((x) => { let k = lanes.findIndex((end) => end <= x.s); if (k < 0) { k = lanes.length; lanes.push(0); } lanes[k] = x.e; laneOf[x.i] = k; });
      el.innerHTML = `${P.mode === "rooms" ? `<div class="palette">${U.range(P.rooms).map((r) => `<button type="button" class="swatch" data-r="${r}" style="--sw:${COLORS[r]}" aria-label="Room ${r + 1}">${r + 1}</button>`).join("")}</div>` : ""}
        <div class="timeline" style="--lanes:${lanes.length}"><div class="hours">${U.range(13).map((h) => `<span style="left:${(h / 12) * 100}%">${h + 8}</span>`).join("")}</div><div class="slots"></div></div>
        <div class="ptr-readout"></div>${P.mode === "rooms" ? "" : `<div class="actions"><button type="button" class="btn primary lock">Lock in</button></div>`}`;
      const slots = el.querySelector(".slots"), out = el.querySelector(".ptr-readout"), lock = el.querySelector(".lock");
      const clashes = () => {
        if (P.mode === "rooms") return P.iv.some((a, i) => P.iv.some((b, j) => i < j && room[i] >= 0 && room[i] === room[j] && overlap(a, b)));
        const c = [...chosen]; return c.some((i) => c.some((j) => i < j && overlap(P.iv[i], P.iv[j])));
      };
      function render() {
        slots.innerHTML = P.iv.map((x, i) => {
          const on = P.mode === "rooms" ? room[i] >= 0 : chosen.has(i);
          const bad = on && (P.mode === "rooms" ? P.iv.some((b, j) => j !== i && room[j] === room[i] && overlap(x, b)) : [...chosen].some((j) => j !== i && overlap(x, P.iv[j])));
          const style = `left:${((x.s - 8) / 12) * 100}%;width:${((x.e - x.s) / 12) * 100}%;top:${laneOf[i] * 40}px;${P.mode === "rooms" && room[i] >= 0 ? `--rc:${COLORS[room[i]]};` : ""}`;
          return `<button type="button" class="mtg${on ? " on" : ""}${bad ? " clash" : ""}${P.mode === "rooms" && room[i] >= 0 ? " roomed" : ""}" data-i="${i}" style="${style}" aria-label="Meeting ${x.s}:00 to ${x.e}:00${P.mode === "value" ? ", value " + x.v : ""}">${x.s}–${x.e}${P.mode === "value" ? ` · <b>${x.v}</b>` : ""}${P.mode === "rooms" && room[i] >= 0 ? ` · R${room[i] + 1}` : ""}</button>`;
        }).join("");
        if (P.mode === "rooms") {
          el.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("on", +b.dataset.r === pen));
          out.innerHTML = `${room.filter((r) => r >= 0).length}/${n} booked${clashes() ? ' · <span class="lose">double-booked room</span>' : ""}`;
          api.stats([["Booked", `${room.filter((r) => r >= 0).length}/${n}`], ["Rooms", P.rooms]]);
        } else {
          const v = [...chosen].reduce((s, i) => s + P.iv[i].v, 0);
          out.innerHTML = `${chosen.size} meetings${P.mode === "value" ? ` · value <b>${v}</b>` : ""}${clashes() ? ' · <span class="lose">overlap!</span>' : ""}`;
          lock.disabled = api.over || clashes() || !chosen.size;
          api.stats([[P.mode === "value" ? "Value" : "Meetings", P.mode === "value" ? v : chosen.size], ["Tries", `${tries}/3`]]);
        }
      }
      function move(m) {
        if (api.over) return;
        if (P.mode === "rooms") {
          const [i, r] = m;
          room[i] = room[i] === r ? -1 : r; paints++;
          render();
          if (room.every((x) => x >= 0) && !clashes()) api.win({ stars: C.stars(paints, n, Math.ceil(n / 3)), text: `All ${n} meetings in ${P.rooms} rooms. At some moment ${P.rooms} meetings overlap, so fewer rooms is impossible. Sweeping meetings by start time and reusing freed rooms always reaches that bound.` });
          return;
        }
        if (m === "lock") {
          if (clashes() || !chosen.size) return;
          tries++;
          const v = [...chosen].reduce((s, i) => s + P.iv[i].v, 0);
          if (v === P.best) { render(); return api.win({ stars: 4 - tries, text: P.mode === "count" ? `${v} meetings is the maximum. "Earliest finish first" leaves as much of the day free as possible after each choice.` : `Value ${v} is the maximum. Greedy by end time ignores value, so this needs DP over meetings sorted by end time.` }); }
          if (tries >= 3) { render(); return api.lose(`The best was ${P.best}. ${P.mode === "count" ? "Repeatedly pick the compatible meeting that ends first." : "Sort by end time. For each meeting, compare skipping it with taking it plus the best schedule that ends before it starts."}`); }
          api.say(`${v} isn't the best possible.`, "lose");
          render(); return;
        }
        if (chosen.has(m)) chosen.delete(m); else chosen.add(m);
        api.say(""); render();
      }
      C.onPick(slots, "data-i", (v) => move(P.mode === "rooms" ? [+v, pen] : +v));
      if (lock) lock.addEventListener("click", () => move("lock"));
      el.querySelectorAll(".swatch").forEach((b) => b.addEventListener("click", () => { pen = +b.dataset.r; render(); }));
      render();
      return { move };
    },
  });
})();
