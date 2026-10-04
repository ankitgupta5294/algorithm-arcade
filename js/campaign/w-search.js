/* Campaign worlds: Searching & scanning. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign;
  const lg = (n) => Math.ceil(Math.log2(n + 1));

  /* ===================== Binary Hunt ===================== */
  C.register({
    id: "binhunt", cat: "search", name: "Binary Hunt", concept: "Binary search",
    blurb: "Find a hidden number in a sorted row with a flip budget of log₂ n.",
    tiers: ["7–15 cards", "31 cards, target may be missing", "Duplicates: find the first", "Unsorted: find a peak"],
    lesson: `<p>In a sorted row, one flip of the <b>middle</b> card rules out half of the candidates. After k flips at most n / 2ᵏ remain, so ⌈log₂(n+1)⌉ flips always suffice: 3 for 7 cards, 5 for 31, 6 for 63.</p>
      <p><b>Missing targets.</b> When the live range becomes empty you have proved the target is absent.</p>
      <p><b>Duplicates.</b> To find the <i>first</i> copy, a match doesn't end the search: remember it and keep going left. This is <code>bisect_left</code> / <code>lower_bound</code>.</p>
      <p><b>Peaks.</b> Even unsorted data can be binary-searched. Compare a[mid] with a[mid+1]: if the right one is bigger, a peak must exist on the right (the values climb until they can't), otherwise on the left.</p>`,
    hint: "Always flip the middle of the live range. For peaks, flip mid and mid+1 and walk towards the bigger one.",
    gen(L, R, t) {
      if (t === 3) {
        const n = L <= 35 ? 15 : 31;
        for (let tries = 0; tries < 100; tries++) {
          const a = R.distinct(n, 1, 99);
          const sol = [], flipped = new Set();
          let lo = 0, hi = n - 1;
          const f = (i) => { if (i >= 0 && i < n && !flipped.has(i)) { flipped.add(i); sol.push(i); } };
          while (lo < hi) { const m = (lo + hi) >> 1; f(m); f(m + 1); if (a[m] < a[m + 1]) lo = m + 1; else hi = m; }
          f(lo - 1); f(lo + 1); f(lo);
          const peaks = a.filter((v, i) => (i === 0 || a[i - 1] < v) && (i === n - 1 || a[i + 1] < v)).length;
          if (peaks < 2 || peaks > Math.ceil(n / 4)) continue;
          return { mode: "peak", vals: a, n, par: sol.length, budget: sol.length + 2, solution: sol,
            goal: `The ${n} numbers are <b>not sorted</b>. Find a <b>peak</b>: a card bigger than both neighbours (the ends only need their one neighbour). A card counts once it and its neighbours are face up. You have <b>${sol.length + 2}</b> flips.` };
        }
        return null;
      }
      const mode = t === 2 ? "first" : "find";
      const n = t === 0 ? (L <= 4 ? 7 : 15) : t === 1 ? 31 : L <= 25 ? 31 : 63;
      let vals, target;
      if (mode === "first") {
        vals = []; let v = R.int(1, 4);
        while (vals.length < n) { const reps = R.chance(0.3) ? R.int(2, 6) : 1; for (let r = 0; r < reps && vals.length < n; r++) vals.push(v); v += R.int(1, 5); }
        const dups = U.uniq(vals).filter((x) => vals.filter((y) => y === x).length >= 3);
        if (!dups.length) return null;
        target = R.pick(dups);
      } else {
        vals = R.distinct(n, 1, n * 7).sort((a, b) => a - b);
        target = R.pick(vals);
        if (t === 1 && R.chance(0.4)) { const set = new Set(vals); do target = R.int(vals[0] + 1, vals[n - 1] - 1); while (set.has(target)); }
      }
      const sol = []; let lo = 0, hi = n - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1; sol.push(m);
        if (vals[m] === target && mode === "find") break;
        if (vals[m] < target) lo = m + 1; else hi = m - 1;
      }
      const bound = lg(n), budget = t === 0 ? bound + 1 : bound;
      const present = vals.includes(target);
      return { mode, vals, n, target, par: bound, budget, solution: sol,
        goal: mode === "first"
          ? `The sorted row has <b>duplicates</b>. Find the index of the <b>first</b> <span class="target-inline">${target}</span>. A match isn't the end: narrow until the live range is empty. You have <b>${budget}</b> flips.`
          : `Find <span class="target-inline">${target}</span> in the sorted row${t === 1 ? `, or prove it's <b>missing</b> by emptying the live range` : ""}. You have <b>${budget}</b> flips.` + (present || t !== 1 ? "" : "") };
    },
    view(el, P, api) {
      const n = P.n, vals = P.vals, flipped = new Set();
      let lo = 0, hi = n - 1, cand = -1, flips = 0;
      el.innerHTML = `<div class="range"></div><div class="cells camp-cells"></div><ol class="log"></ol>`;
      const box = el.querySelector(".cells"), log = el.querySelector(".log"), rng = el.querySelector(".range");
      const isPeak = (i) => flipped.has(i) && (i === 0 || (flipped.has(i - 1) && vals[i - 1] < vals[i])) && (i === n - 1 || (flipped.has(i + 1) && vals[i + 1] < vals[i]));
      function render() {
        const peak = P.mode === "peak";
        box.innerHTML = vals.map((v, i) => {
          const live = peak || (i >= lo && i <= hi);
          const shown = api.over || flipped.has(i);
          const cls = (!live && !api.over ? " dead" : "") + (flipped.has(i) ? " probed" : "") + (i === cand ? " cand" : "") + (api.over && peak && isPeak(i) ? " found" : "");
          return `<button type="button" class="cell${cls}" data-i="${i}" ${(!live || flipped.has(i)) && !api.over ? "disabled" : ""}><span class="v">${shown ? v : "?"}</span><span class="i">${i}</span></button>`;
        }).join("");
        rng.innerHTML = P.mode === "peak" ? "" : lo <= hi ? `Live range: <b>[${lo} … ${hi}]</b> · ${hi - lo + 1} candidates` : "Live range is empty.";
        api.stats([["Flips", `${flips}/${P.budget}`], ["log₂ bound", P.mode === "peak" ? P.par : lg(n)]]);
      }
      function note(s) { log.insertAdjacentHTML("beforeend", `<li>${s}</li>`); }
      function move(i) {
        if (api.over || flipped.has(i)) return;
        if (P.mode !== "peak" && (i < lo || i > hi)) return;
        flipped.add(i); flips++;
        const v = vals[i], t = P.target, mid = (lo + hi) >> 1;
        if (P.mode === "peak") {
          note(`Index ${i} = <b>${v}</b>.`);
          for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < n && isPeak(j)) {
            render();
            return api.win({ stars: C.stars(flips, P.par, 1), text: `Index ${j} (${vals[j]}) is a peak, found in ${flips} flips. The array had ${n} cards, but comparing neighbours told you which half must contain a peak. That's how binary search works on data that isn't sorted.` });
          }
        } else {
          let s = `Index ${i} = <b>${v}</b>. `;
          if (v === t && P.mode === "find") {
            note(s + "Found it."); render();
            return api.win({ stars: C.stars(flips, P.par, 1), text: `Found ${t} in ${flips} flips. A linear scan from the left would have needed ${i + 1}. Every middle flip halves the candidates: ${n} → ${(n - 1) >> 1} → …` });
          }
          if (v === t) { cand = i; hi = i - 1; s += "A match. Remember it and keep looking left."; }
          else if (v < t) { lo = i + 1; s += `${v} &lt; ${t}, so go right.`; }
          else { hi = i - 1; s += `${v} &gt; ${t}, so go left.`; }
          note(s + (i === mid ? " A perfect split." : ` The midpoint was ${mid}.`));
          if (lo > hi) {
            render();
            return api.win({ stars: C.stars(flips, P.par, 1), text: P.mode === "first"
              ? `The range is empty, so the first ${t} is at index ${cand}. This lower-bound search never stops on a match. It always finishes in ⌈log₂(n+1)⌉ flips.`
              : `The range is empty, which proves ${t} isn't in the row. Binary search proves absence just as fast as it finds things.` });
          }
        }
        if (flips >= P.budget) { render(); return api.lose(P.mode === "peak" ? "Out of flips. Flip a[mid] and a[mid+1], then keep the half on the side of the bigger one: it must contain a peak." : `Out of flips. ${P.mode === "first" ? `The first ${t} was at index ${vals.indexOf(t)}.` : vals.includes(t) ? `${t} was at index ${vals.indexOf(t)}.` : `${t} wasn't there.`} Flipping the exact middle guarantees success in ${lg(n)}.`); }
        render();
      }
      C.onPick(box, "data-i", (v) => move(+v));
      render();
      return { move };
    },
  });

  /* ===================== Pair Hunter ===================== */
  function closest(a, target) { let best = Infinity; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) best = Math.min(best, Math.abs(a[i] + a[j] - target)); return best; }
  C.register({
    id: "pairs", cat: "search", name: "Pair Hunter", concept: "Two pointers",
    blurb: "Two pointers walk inward. Move the right one and you never miss the answer.",
    tiers: ["Two-sum, 6–10 numbers", "Two-sum, 11–16 numbers", "Container with most water", "Closest pair to a target"],
    lesson: `<p>On a sorted array, start one pointer at each end. If the sum is too small, the left number is useless with every remaining partner (they're all ≤ the right one), so move <b>left</b> inward. If it's too big, move <b>right</b>. Each step discards a whole row of pairs, giving O(n) instead of O(n²).</p>
      <p><b>Container with most water.</b> The area is the shorter wall × the distance between them. Moving the <i>taller</i> wall can never help (the width shrinks and the shorter wall still limits the height), so always move the shorter one.</p>`,
    hint: "Sum too small: move the left pointer. Too big: move the right pointer. For water, move the shorter wall.",
    gen(L, R, t) {
      if (t <= 1) {
        const n = t === 0 ? 6 + Math.floor((L - 1) / 2.5) : 11 + Math.floor((L - 11) / 2);
        for (let tries = 0; tries < 200; tries++) {
          const a = R.distinct(n, 1, n * 6).sort((x, y) => x - y);
          const i = R.int(1, n - 3), j = R.int(i + 1, n - 2);
          const target = a[i] + a[j];
          let count = 0; for (let x = 0; x < n; x++) for (let y = x + 1; y < n; y++) if (a[x] + a[y] === target) count++;
          if (count !== 1) continue;
          const sol = []; let l = 0, r = n - 1;
          while (a[l] + a[r] !== target) { if (a[l] + a[r] < target) { sol.push("L"); l++; } else { sol.push("R"); r--; } }
          if (sol.length < 3) continue;
          return { mode: "sum", a, n, target, par: sol.length, solution: sol, goal: `Move the pointers inward until the two numbers add up to <span class="target-inline">${target}</span>. Exactly one pair works, and a wrong move can skip past it.` };
        }
        return null;
      }
      const n = t === 2 ? 7 + Math.floor((L - 21) / 2) : 8 + Math.floor((L - 31) / 2);
      for (let tries = 0; tries < 300; tries++) {
        const a = t === 2 ? U.range(n).map(() => R.int(1, 12)) : R.distinct(n, 1, 60).sort((x, y) => x - y);
        const target = t === 3 ? R.int(a[0] + a[1] + 3, a[n - 1] + a[n - 2] - 3) : 0;
        if (t === 3 && a.some((x, i) => a.some((y, j) => i < j && x + y === target))) continue; // no exact hit: you must judge closeness
        const val = (l, r) => (t === 2 ? Math.min(a[l], a[r]) * (r - l) : -Math.abs(a[l] + a[r] - target));
        let best = -Infinity; for (let l = 0; l < n; l++) for (let r = l + 1; r < n; r++) best = Math.max(best, val(l, r));
        const sol = []; let l = 0, r = n - 1, seen = val(l, r);
        while (r - l > 1) { const left = t === 2 ? a[l] <= a[r] : a[l] + a[r] < target; sol.push(left ? "L" : "R"); left ? l++ : r--; seen = Math.max(seen, val(l, r)); }
        // a greedy-the-wrong-way walk should usually miss the optimum
        let bad = val(0, n - 1); { let l2 = 0, r2 = n - 1; while (r2 - l2 > 1) { const left = t === 2 ? a[l2] > a[r2] : a[l2] + a[r2] >= target; left ? l2++ : r2--; bad = Math.max(bad, val(l2, r2)); } }
        if (seen !== best || bad === best) continue;
        if (val(0, n - 1) === best) continue;
        return { mode: t === 2 ? "water" : "closest", a, n, target, best: t === 2 ? best : -best, par: sol.length, solution: sol,
          goal: t === 2
            ? `Each bar is a wall. Water between the two pointers holds <b>shorter wall × distance</b>. Walk the pointers inward until they meet and pass through the <b>largest container</b>.`
            : `No pair hits <span class="target-inline">${target}</span> exactly. Walk the pointers inward until they meet and pass through the pair whose sum is <b>closest</b> to it.` };
      }
      return null;
    },
    view(el, P, api) {
      const a = P.a, n = P.n;
      let l = 0, r = n - 1, moves = 0;
      const val = (x, y) => (P.mode === "water" ? Math.min(a[x], a[y]) * (y - x) : Math.abs(a[x] + a[y] - P.target));
      let best = val(l, r), bestAt = [l, r];
      el.innerHTML = `<div class="ptr-row"></div><div class="ptr-readout"></div><div class="actions"><button type="button" class="btn primary" data-m="L">Move left pointer →</button><button type="button" class="btn primary" data-m="R">← Move right pointer</button></div>`;
      const row = el.querySelector(".ptr-row"), out = el.querySelector(".ptr-readout");
      const maxV = Math.max(...a);
      function render() {
        row.innerHTML = a.map((v, i) => {
          const cls = i === l ? " pl" : i === r ? " pr" : i < l || i > r ? " gone" : "";
          const inWater = P.mode === "water" && i > l && i < r ? ` style="--water:${(Math.min(a[l], a[r]) / maxV) * 100}%"` : "";
          return P.mode === "water"
            ? `<div class="wall${cls}${i > l && i < r ? " wet" : ""}"${inWater}><span class="wfill" style="height:${(v / maxV) * 100}%"></span><span class="wv">${v}</span>${i === l ? '<span class="tagp">L</span>' : i === r ? '<span class="tagp">R</span>' : ""}</div>`
            : `<div class="pnum${cls}"><b>${v}</b>${i === l ? '<span class="tagp">L</span>' : i === r ? '<span class="tagp">R</span>' : ""}</div>`;
        }).join("");
        const cur = val(l, r);
        out.innerHTML = P.mode === "sum"
          ? `${a[l]} + ${a[r]} = <b>${a[l] + a[r]}</b> ${a[l] + a[r] < P.target ? "&lt;" : a[l] + a[r] > P.target ? "&gt;" : "="} ${P.target}`
          : P.mode === "water"
          ? `min(${a[l]}, ${a[r]}) × ${r - l} = <b>${cur}</b> · best so far <b>${best}</b>`
          : `${a[l]} + ${a[r]} = <b>${a[l] + a[r]}</b>, off by ${cur} · best so far: off by <b>${best}</b>`;
        api.stats([["Moves", moves], [P.mode === "sum" ? "Target" : "Best", P.mode === "sum" ? P.target : best]]);
      }
      function move(m) {
        if (api.over) return;
        if (m === "L") l++; else r--;
        moves++;
        if (P.mode === "sum") {
          const s = a[l] + a[r];
          if (s === P.target) { render(); return api.win({ stars: 3, text: `Found ${a[l]} + ${a[r]} = ${P.target} after ${moves} moves. Each move discarded every pair using the number you stepped past, so you checked ${moves + 1} pairs instead of ${(n * (n - 1)) / 2}.` }); }
          const i = a.findIndex((x, xi) => a.some((y, yi) => yi > xi && x + y === P.target));
          const j = a.findIndex((y, yi) => yi > i && a[i] + y === P.target);
          if (l > i || r < j) { render(); return api.lose(`You stepped past the pair (${a[i]}, ${a[j]}). When the sum is too small, only moving the left pointer is safe, because the right number already can't help any smaller partner.`); }
          render();
        } else {
          const cur = val(l, r);
          if (P.mode === "water" ? cur > best : cur < best) { best = cur; bestAt = [l, r]; }
          render();
          if (r - l <= 1) {
            const ok = best === P.best;
            if (ok) api.win({ stars: 3, text: P.mode === "water" ? `Largest container: ${best}. By always moving the shorter wall, you never skipped a container that could have been bigger.` : `Closest sum: off by ${best}. Moving left when the sum was low and right when it was high kept the best pair in range.` });
            else api.lose(P.mode === "water" ? `Best seen ${best}, but ${P.best} was possible. Moving the taller wall shrinks the width while the shorter wall still caps the height, so that container can only get worse.` : `Best seen off by ${best}, but off by ${P.best} was possible. If the sum is too low, the left number is too small for every remaining partner. That's the one to drop.`);
          }
        }
      }
      el.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => move(b.dataset.m)));
      render();
      return { move };
    },
  });

  /* ===================== Range Picker ===================== */
  const rangeVal = (mode, a, i, j) => {
    const s = a.slice(i, j + 1);
    if (mode === "sum") return s.reduce((x, y) => x + y, 0);
    if (mode === "hist") return Math.min(...s) * s.length;
    return s.reduce((x, y) => x * y, 1);
  };
  C.register({
    id: "ranges", cat: "search", name: "Range Picker", concept: "Kadane · monotonic stack",
    blurb: "Pick the best contiguous range: biggest sum, biggest rectangle, biggest product.",
    tiers: ["Max subarray sum", "Longer arrays", "Largest rectangle in a histogram", "Max product subarray"],
    lesson: `<p><b>Max subarray (Kadane).</b> Scan left to right keeping the best sum of a range ending here: either extend the previous range or start fresh at this element, whichever is bigger. A negative running total is dead weight, so drop it.</p>
      <p><b>Largest rectangle.</b> Every rectangle's height is set by its shortest bar. For each bar, stretch left and right until you hit something shorter. A <b>monotonic stack</b> finds those limits for all bars in O(n).</p>
      <p><b>Max product.</b> Negatives flip signs, so track both the largest and the smallest product ending here. Today's minimum times a negative can become tomorrow's maximum.</p>`,
    hint: "Tap a start bar, then an end bar, then lock in. You get three tries.",
    gen(L, R, t) {
      const mode = t <= 1 ? "sum" : t === 2 ? "hist" : "prod";
      const n = t === 0 ? 6 + Math.floor((L - 1) / 3) : t === 1 ? 10 + Math.floor((L - 11) / 2.5) : t === 2 ? 7 + Math.floor((L - 21) / 2) : 7 + Math.floor((L - 31) / 3);
      for (let tries = 0; tries < 300; tries++) {
        const a = U.range(n).map(() => (mode === "sum" ? R.int(-9, 9) : mode === "hist" ? R.int(1, 9) : R.pick([-3, -2, -2, -1, 1, 2, 2, 3, 4, ...(L > 35 ? [0] : [])])));
        let best = -Infinity, at = null, count = 0;
        for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const v = rangeVal(mode, a, i, j); if (v > best) { best = v; at = [i, j]; count = 1; } else if (v === best) count++; }
        if (count > 2 || at[1] - at[0] < 1 || (at[0] === 0 && at[1] === n - 1)) continue;
        if (mode === "sum" && a.filter((x) => x > 0).length === n) continue;
        return { mode, a, n, best, par: 1, solution: [at, "lock"], goal: ({
          sum: "Select the contiguous range with the <b>largest sum</b>. Tap its first bar, then its last bar, then lock in.",
          hist: "Select the range of bars that holds the <b>largest rectangle</b>: width × the shortest bar in it.",
          prod: "Select the contiguous range with the <b>largest product</b>. Watch the negative numbers.",
        })[mode] };
      }
      return null;
    },
    view(el, P, api) {
      const a = P.a, n = P.n, maxAbs = Math.max(...a.map(Math.abs), 1);
      let sel = null, start = null, tries = 0;
      el.innerHTML = `<div class="rbars ${P.mode}"></div><div class="ptr-readout"></div><div class="actions"><button type="button" class="btn primary lock" disabled>Lock in</button><span class="muted small tries"></span></div>`;
      const box = el.querySelector(".rbars"), out = el.querySelector(".ptr-readout"), lock = el.querySelector(".lock");
      function render() {
        box.innerHTML = a.map((v, i) => {
          const on = sel && i >= sel[0] && i <= sel[1], st = start === i;
          const h = (Math.abs(v) / maxAbs) * 100;
          return `<button type="button" class="rbar${on ? " on" : ""}${st ? " start" : ""}${v < 0 ? " neg" : ""}" data-i="${i}" aria-label="Value ${v}"><span class="rcol"><span class="rfill" style="height:${P.mode === "hist" ? h : h / 2}%"></span></span><span class="rv">${v}</span></button>`;
        }).join("");
        out.innerHTML = sel ? `Range [${sel[0]} … ${sel[1]}] → ${P.mode === "sum" ? "sum" : P.mode === "hist" ? `${Math.min(...a.slice(sel[0], sel[1] + 1))} × ${sel[1] - sel[0] + 1} =` : "product"} <b>${rangeVal(P.mode, a, sel[0], sel[1])}</b>` : start != null ? "Now tap the last bar of the range." : "Tap the first bar of a range.";
        lock.disabled = !sel || api.over;
        el.querySelector(".tries").textContent = `${3 - tries} ${3 - tries === 1 ? "try" : "tries"} left`;
        api.stats([["Tries", `${tries}/3`]]);
      }
      function move(m) {
        if (api.over) return;
        if (m === "lock") {
          if (!sel) return;
          tries++;
          const v = rangeVal(P.mode, a, sel[0], sel[1]);
          if (v === P.best) { render(); return api.win({ stars: 4 - tries, text: explain(v) }); }
          if (tries >= 3) { render(); return api.lose(`The best value was ${P.best}. ` + explain(P.best)); }
          api.say(`${v} isn't the best. A range worth more exists. ${tries === 2 ? "Last try!" : ""}`, "lose");
          render();
          return;
        }
        sel = [Math.min(m[0], m[1]), Math.max(m[0], m[1])];
        start = null;
        render();
      }
      function explain(v) {
        return ({
          sum: `Kadane's scan keeps a running sum and resets it whenever it goes negative, because a negative prefix only drags a range down. The best sum is ${v}.`,
          hist: `For each bar, the biggest rectangle it can be the shortest bar of reaches to the nearest shorter bar on each side. A monotonic stack finds those in one pass. Best area: ${v}.`,
          prod: `Keep both the max and the min product ending at each position, since a negative swaps them. Best product: ${v}.`,
        })[P.mode];
      }
      C.onPick(box, "data-i", (v) => {
        const i = +v;
        if (start == null) { start = i; sel = null; render(); box.children[i].focus({ preventScroll: true }); }
        else move([start, i]);
      });
      lock.addEventListener("click", () => move("lock"));
      render();
      return { move };
    },
  });
})();
