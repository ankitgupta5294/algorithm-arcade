/* DP Lab: small dynamic-programming instances, solved exactly, with greedy and off-by-one traps. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;
  const fmt = U.fmt, esc = U.esc;
  const choice = (o) => ({ kind: "choice", tag: "Dynamic programming", ...o });
  const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); };

  function stairsQ(lvl) {
    const steps = lvl === 1 ? [1, 2] : lvl === 2 ? [1, 2, 3] : U.pick([[1, 3, 4], [1, 3, 5], [2, 3], [1, 4, 5]]);
    const n = lvl === 1 ? U.randInt(4, 8) : lvl === 2 ? U.randInt(5, 9) : U.randInt(8, 13);
    const w = [1];
    for (let i = 1; i <= n; i++) w[i] = steps.reduce((s, k) => s + (i >= k ? w[i - k] : 0), 0);
    return choice({
      tag: "Counting",
      prompt: `How many distinct ways are there to climb <b>${n}</b> stairs if each move climbs ${steps.join(" or ")} step${steps.length > 1 ? "s" : ""}? Order matters, so 1+2 and 2+1 are different.`,
      options: U.numOptions(w[n], [w[n - 1], w[n] + w[n - 1], 2 ** (n - 1)]), answer: String(w[n]),
      explain: `ways(i) = ${steps.map((k) => `ways(i−${k})`).join(" + ")}, with ways(0) = 1.<br><span class="mono">ways = ${fmt(w)}</span>`,
    });
  }

  function coinsMin(coins, amt) {
    const INF = 1e9, dp = Array(amt + 1).fill(INF), from = Array(amt + 1).fill(-1);
    dp[0] = 0;
    for (let a = 1; a <= amt; a++) for (const c of coins) if (c <= a && dp[a - c] + 1 < dp[a]) { dp[a] = dp[a - c] + 1; from[a] = c; }
    const used = []; for (let a = amt; a > 0 && from[a] > 0; a -= from[a]) used.push(from[a]);
    return { n: dp[amt], used };
  }
  function greedyCoins(coins, amt) { let c = 0; for (const x of coins.slice().sort((a, b) => b - a)) { c += Math.floor(amt / x); amt %= x; } return amt ? null : c; }

  function minCoinsQ(lvl) {
    const sets = lvl <= 2 ? [[1, 2, 5], [1, 5, 10], [1, 2, 5, 10]] : lvl === 3 ? [[1, 3, 4], [1, 5, 6, 9], [1, 4, 6]] : [[1, 5, 6, 9], [1, 7, 10], [1, 6, 10, 15], [1, 3, 7, 12]];
    for (let t = 0; t < 100; t++) {
      const coins = U.pick(sets);
      const amt = lvl <= 2 ? U.randInt(7, 23) : U.randInt(8, 30);
      const { n, used } = coinsMin(coins, amt);
      const g = greedyCoins(coins, amt);
      if (lvl >= 3 && g === n && t < 90) continue;     // want greedy to fail on hard levels
      return choice({
        tag: "Coin change",
        prompt: `Coins: ${coins.join(", ")} (unlimited supply). What is the <b>minimum number of coins</b> that make <b>${amt}</b>?`,
        options: U.numOptions(n, [g, n + 1]), answer: String(n),
        explain: `One optimal way: ${used.sort((a, b) => b - a).join(" + ")} = ${amt}.` + (g !== n && g != null ? ` Greedy (largest coin first) uses ${g} coins, which is why this needs DP: best(a) = 1 + min(best(a − c)).` : " best(a) = 1 + min over coins c of best(a − c)."),
      });
    }
  }

  function coinWaysQ(lvl) {
    const coins = U.pick(lvl === 3 ? [[1, 2, 5], [2, 3, 5], [1, 3, 4]] : [[1, 2, 5, 10], [2, 3, 7], [1, 5, 10, 25]]);
    const amt = U.randInt(lvl === 3 ? 6 : 10, lvl === 3 ? 12 : 20);
    const comb = Array(amt + 1).fill(0); comb[0] = 1;
    coins.forEach((c) => { for (let a = c; a <= amt; a++) comb[a] += comb[a - c]; });
    const perm = Array(amt + 1).fill(0); perm[0] = 1;
    for (let a = 1; a <= amt; a++) coins.forEach((c) => { if (c <= a) perm[a] += perm[a - c]; });
    if (comb[amt] === 0) return minCoinsQ(lvl);
    return choice({
      tag: "Coin change",
      prompt: `Coins: ${coins.join(", ")} (unlimited supply). In how many ways can you make <b>${amt}</b> if order doesn't matter (2+3 is the same as 3+2)?`,
      options: U.numOptions(comb[amt], [perm[amt], comb[amt] + 1]), answer: String(comb[amt]),
      explain: `Loop over coins on the outside and amounts on the inside so each combination is counted once. Counting ordered sequences instead would give ${perm[amt]}.`,
    });
  }

  function gridFigure(r, c, blocked) {
    let cells = "";
    for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
      const cls = blocked.has(i * c + j) ? "block" : i === 0 && j === 0 ? "start" : i === r - 1 && j === c - 1 ? "end" : "";
      cells += `<span class="${cls}">${cls === "start" ? "S" : cls === "end" ? "E" : ""}</span>`;
    }
    return `<div class="gridfig" style="grid-template-columns:repeat(${c}, 30px)" role="img" aria-label="${r} by ${c} grid">${cells}</div>`;
  }
  function gridQ(lvl) {
    const r = lvl === 1 ? U.randInt(2, 3) : U.randInt(3, 4), c = lvl === 1 ? U.randInt(3, 4) : U.randInt(4, 5);
    const blocked = new Set();
    if (lvl >= 3) {
      const k = lvl === 3 ? 2 : 3;
      while (blocked.size < k) { const x = U.rand(r * c); if (x !== 0 && x !== r * c - 1) blocked.add(x); }
    }
    const dp = U.range(r).map(() => Array(c).fill(0));
    for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
      if (blocked.has(i * c + j)) continue;
      dp[i][j] = i === 0 && j === 0 ? 1 : (i ? dp[i - 1][j] : 0) + (j ? dp[i][j - 1] : 0);
    }
    const ans = dp[r - 1][c - 1];
    if (lvl >= 3 && ans === 0) return gridQ(lvl);
    const free = binom(r + c - 2, r - 1);
    return choice({
      tag: "Grid paths", figure: gridFigure(r, c, blocked),
      prompt: `Moving only <b>right</b> or <b>down</b>, how many paths lead from S to E${blocked.size ? " while avoiding the dark cells" : ""}?`,
      options: U.numOptions(ans, [free, r * c, r + c - 2]), answer: String(ans),
      explain: `paths(i, j) = paths(i−1, j) + paths(i, j−1), and blocked cells have 0.` + (blocked.size ? ` Without obstacles the answer would be C(${r + c - 2}, ${r - 1}) = ${free}.` : ` That equals C(${r + c - 2}, ${r - 1}): choose which of the ${r + c - 2} moves go down.`) + `<br><span class="mono">${dp.map((row) => row.join(" ")).join("<br>")}</span>`,
    });
  }

  function lcsQ(lvl) {
    const al = "ABCD", len = lvl === 2 ? U.randInt(5, 6) : U.randInt(7, 8);
    const s = U.range(len).map(() => U.pick(al)).join(""), t = U.range(len + U.randInt(-1, 1)).map(() => U.pick(al)).join("");
    const n = s.length, m = t.length, dp = U.range(n + 1).map(() => Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = s[i - 1] === t[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    let i = n, j = m, w = "";
    while (i && j) { if (s[i - 1] === t[j - 1]) { w = s[i - 1] + w; i--; j--; } else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--; }
    const common = [...al].reduce((acc, ch) => acc + Math.min(s.split(ch).length - 1, t.split(ch).length - 1), 0);
    return choice({
      tag: "LCS",
      prompt: `What is the length of the <b>longest common subsequence</b> of these two strings? (Characters keep their order but needn't be adjacent.)`,
      code: `s = "${s}"\nt = "${t}"`,
      options: U.numOptions(dp[n][m], [common, dp[n][m] + 1]), answer: String(dp[n][m]),
      explain: `One LCS is "${w}". dp[i][j] = dp[i−1][j−1] + 1 when the characters match, otherwise max(dp[i−1][j], dp[i][j−1]).` + (common !== dp[n][m] ? ` Counting shared letters gives ${common}, but that ignores order.` : ""),
    });
  }

  function editQ(lvl) {
    const pairs = [["kitten", "sitting"], ["sunday", "saturday"], ["horse", "ros"], ["intention", "execution"], ["flaw", "lawn"], ["gumbo", "gambol"], ["book", "back"], ["algorithm", "altruistic"], ["heap", "help"], ["graph", "giraffe"], ["stack", "track"], ["queue", "quiet"]];
    let s, t;
    if (Math.random() < 0.5) [s, t] = U.pick(pairs);
    else { const al = "ACGT", n = lvl === 3 ? U.randInt(5, 6) : U.randInt(6, 8); s = U.range(n).map(() => U.pick(al)).join(""); t = s.split(""); for (let k = 0; k < U.randInt(2, 4); k++) { const op = U.rand(3), p = U.rand(t.length); if (op === 0) t[p] = U.pick(al); else if (op === 1 && t.length > 3) t.splice(p, 1); else t.splice(p, 0, U.pick(al)); } t = t.join(""); }
    const n = s.length, m = t.length, dp = U.range(n + 1).map((i) => U.range(m + 1).map((j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    const ans = dp[n][m];
    let ham = Math.abs(n - m); for (let i = 0; i < Math.min(n, m); i++) if (s[i] !== t[i]) ham++;
    return choice({
      tag: "Edit distance",
      prompt: "What is the <b>edit distance</b> between the strings? (Minimum single-character inserts, deletes or replacements.)",
      code: `s = "${s}"\nt = "${t}"`,
      options: U.numOptions(ans, [ham, Math.abs(n - m), ans + 1]), answer: String(ans),
      explain: `dp[i][j] = min(delete: dp[i−1][j] + 1, insert: dp[i][j−1] + 1, replace or match: dp[i−1][j−1] + (0 or 1)).` + (ham !== ans ? ` Comparing position by position gives ${ham}, which misses the savings from inserts and deletes.` : ""),
    });
  }

  function knapQ(lvl) {
    for (let t = 0; t < 100; t++) {
      const n = lvl === 3 ? 4 : 5;
      const items = U.range(n).map(() => ({ w: U.randInt(1, 7), v: U.randInt(2, 15) }));
      const cap = lvl === 3 ? U.randInt(7, 10) : U.randInt(10, 14);
      const dp = Array(cap + 1).fill(0), keep = U.range(n).map(() => Array(cap + 1).fill(false));
      items.forEach((it, i) => { for (let w = cap; w >= it.w; w--) if (dp[w - it.w] + it.v > dp[w]) { dp[w] = dp[w - it.w] + it.v; keep[i][w] = true; } });
      const chosen = []; let w = cap; for (let i = n - 1; i >= 0; i--) if (keep[i][w]) { chosen.push(i); w -= items[i].w; }
      const greedy = (key) => { let c = cap, v = 0; items.map((it, i) => ({ ...it, i })).sort(key).forEach((it) => { if (it.w <= c) { c -= it.w; v += it.v; } }); return v; };
      const gRatio = greedy((a, b) => b.v / b.w - a.v / a.w), gVal = greedy((a, b) => b.v - a.v);
      if (gRatio === dp[cap] && gVal === dp[cap] && t < 80) continue;
      return choice({
        tag: "Knapsack",
        prompt: `0/1 knapsack, capacity <b>${cap}</b>. Each item can be taken at most once. What is the <b>maximum total value</b>?`,
        code: items.map((it, i) => `item ${String.fromCharCode(65 + i)}: weight ${it.w}, value ${it.v}`).join("\n"),
        options: U.numOptions(dp[cap], [gRatio, gVal, dp[cap] - 1]), answer: String(dp[cap]),
        explain: `Best: items ${chosen.reverse().map((i) => String.fromCharCode(65 + i)).join(", ")} (weight ${chosen.reduce((s, i) => s + items[i].w, 0)}, value ${dp[cap]}). Greedy by value/weight gives ${gRatio} and greedy by value gives ${gVal}. Neither is safe for 0/1 knapsack.`,
      });
    }
  }

  function lisQ(lvl) {
    const a = U.range(lvl === 2 ? 7 : 9).map(() => U.randInt(1, 30));
    const dp = a.map(() => 1), prev = a.map(() => -1);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < i; j++) if (a[j] < a[i] && dp[j] + 1 > dp[i]) { dp[i] = dp[j] + 1; prev[i] = j; }
    const best = Math.max(...dp); let k = dp.indexOf(best); const seq = [];
    while (k >= 0) { seq.unshift(a[k]); k = prev[k]; }
    let run = 1, cur = 1; for (let i = 1; i < a.length; i++) { cur = a[i] > a[i - 1] ? cur + 1 : 1; run = Math.max(run, cur); }
    return choice({
      tag: "LIS",
      prompt: "What is the length of the <b>longest strictly increasing subsequence</b>? (Elements needn't be adjacent.)",
      code: `a = ${fmt(a)}`,
      options: U.numOptions(best, [run, best + 1]), answer: String(best),
      explain: `One example: ${fmt(seq)}. lis[i] = 1 + max(lis[j] for j < i with a[j] < a[i]).` + (run !== best ? ` The longest contiguous increasing run is only ${run}.` : ""),
    });
  }

  function robberQ() {
    const a = U.range(U.randInt(6, 7)).map(() => U.randInt(1, 15));
    let take = 0, skip = 0;
    a.forEach((x) => { [take, skip] = [skip + x, Math.max(take, skip)]; });
    const ans = Math.max(take, skip);
    const even = a.filter((_, i) => i % 2 === 0).reduce((s, x) => s + x, 0), odd = a.filter((_, i) => i % 2).reduce((s, x) => s + x, 0);
    return choice({
      tag: "House robber",
      prompt: "Houses hold these amounts. You can't rob two adjacent houses. What is the <b>maximum</b> you can take?",
      code: `houses = ${fmt(a)}`,
      options: U.numOptions(ans, [even, odd, ans + 1]), answer: String(ans),
      explain: `best(i) = max(best(i−1), best(i−2) + a[i]). Taking every other house gives ${even} or ${odd}, but skipping two in a row can be better.`,
    });
  }

  function kadaneQ() {
    const a = U.range(U.randInt(7, 8)).map(() => U.randInt(-9, 9));
    if (a.every((x) => x <= 0)) a[U.rand(a.length)] = U.randInt(1, 9);
    let best = -Infinity, cur = 0;
    a.forEach((x) => { cur = Math.max(x, cur + x); best = Math.max(best, cur); });
    const pos = a.filter((x) => x > 0).reduce((s, x) => s + x, 0), mx = Math.max(...a), tot = a.reduce((s, x) => s + x, 0);
    return choice({
      tag: "Max subarray",
      prompt: "What is the largest sum of a <b>contiguous</b>, non-empty subarray?",
      code: `a = ${fmt(a)}`,
      options: U.numOptions(best, [pos, mx, tot]), answer: String(best),
      explain: `Kadane's algorithm: best ending here = max(x, x + best ending at the previous index). Adding up all the positives (${pos}) ignores the contiguity requirement.`,
    });
  }

  function catalanQ() {
    const n = U.randInt(3, 6), C = [1, 1, 2, 5, 14, 42, 132][n];
    const fact = [1, 1, 2, 6, 24, 120, 720][n];
    return choice({
      tag: "Catalan",
      prompt: `How many structurally different binary search trees can store the keys 1…${n}?`,
      options: U.numOptions(C, [fact, 2 ** n, n * n]), answer: String(C),
      explain: `count(n) = Σ count(i−1) · count(n−i) over each root i. These are the Catalan numbers: 1, 1, 2, 5, 14, 42, 132…`,
    });
  }

  function partitionQ() {
    const a = U.range(U.randInt(5, 6)).map(() => U.randInt(1, 12));
    if (Math.random() < 0.5) { const s = a.reduce((x, y) => x + y, 0); if (s % 2) a[0] += 1; }
    const total = a.reduce((x, y) => x + y, 0);
    let ok = false, subset = [];
    if (total % 2 === 0) {
      const half = total / 2, reach = new Map([[0, []]]);
      a.forEach((x, i) => { [...reach.entries()].forEach(([s, idx]) => { if (!reach.has(s + x) && s + x <= half) reach.set(s + x, [...idx, i]); }); });
      if (reach.has(half)) { ok = true; subset = reach.get(half).map((i) => a[i]); }
    }
    return choice({
      tag: "Subset sum", mono: false,
      prompt: "Can this array be split into two groups with <b>equal sums</b>?",
      code: `a = ${fmt(a)}     # total = ${total}`,
      options: ["Yes", "No"], answer: ok ? "Yes" : "No",
      explain: ok ? `Yes: ${fmt(subset)} sums to ${total / 2}. Subset-sum DP tracks which sums up to total/2 are reachable.` : total % 2 ? `No. The total ${total} is odd.` : `No. No subset reaches ${total / 2}, which subset-sum DP over reachable sums confirms.`,
    });
  }

  function chainQ() {
    const k = U.randInt(3, 4), dims = U.range(k + 1).map(() => U.pick([2, 3, 4, 5, 6, 8, 10, 12]));
    const n = k, dp = U.range(n).map(() => Array(n).fill(0));
    for (let len = 2; len <= n; len++) for (let i = 0; i + len - 1 < n; i++) { const j = i + len - 1; dp[i][j] = Infinity; for (let m = i; m < j; m++) dp[i][j] = Math.min(dp[i][j], dp[i][m] + dp[m + 1][j] + dims[i] * dims[m + 1] * dims[j + 1]); }
    let left = 0, rows = dims[0]; for (let i = 1; i < n; i++) left += rows * dims[i] * dims[i + 1];
    let right = 0; for (let i = n - 2; i >= 0; i--) right += dims[i] * dims[i + 1] * dims[n];
    const ans = dp[0][n - 1];
    const names = U.range(n).map((i) => `M${i + 1}: ${dims[i]}×${dims[i + 1]}`).join("\n");
    return choice({
      tag: "Matrix chain",
      prompt: "Multiplying a p×q matrix by a q×r one costs p·q·r scalar multiplications. What is the <b>minimum</b> cost to compute the whole product?",
      code: names,
      options: U.numOptions(ans, [left, right, ans + dims[0]]), answer: String(ans),
      explain: `cost(i, j) = min over splits m of cost(i, m) + cost(m+1, j) + p[i]·p[m+1]·p[j+1]. Left to right costs ${left} and right to left costs ${right}.`,
    });
  }

  const TYPES = {
    1: [() => stairsQ(1), () => gridQ(1), () => kadaneQ(), () => minCoinsQ(1), () => stairsQ(1)],
    2: [() => stairsQ(2), () => gridQ(2), () => minCoinsQ(2), () => lcsQ(2), () => lisQ(2), () => robberQ(), () => kadaneQ()],
    3: [() => minCoinsQ(3), () => coinWaysQ(3), () => gridQ(3), () => lcsQ(3), () => editQ(3), () => knapQ(3), () => lisQ(3), () => catalanQ(), () => stairsQ(3)],
    4: [() => editQ(4), () => knapQ(4), () => coinWaysQ(4), () => minCoinsQ(4), () => partitionQ(), () => chainQ(), () => gridQ(4), () => catalanQ()],
  };

  D.registerMode({
    id: "dp",
    name: "DP Lab",
    group: "Simulators",
    topic: "Dynamic programming",
    blurb: "Solve coin change, knapsack, LCS, edit distance, LIS and more on fresh inputs.",
    generated: true,
    count: 8,
    make: (lvl, count) => D.mixFrom(TYPES[lvl], count),
  });
})();
