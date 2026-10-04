/* Sort Lab: predict intermediate states of sorting algorithms, count swaps, identify algorithms from snapshots. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util;
  const fmt = U.fmt;
  const swap = (a, i, j) => ([a[i], a[j]] = [a[j], a[i]]);

  /* ---------- algorithms that record a snapshot after every pass ---------- */
  const ALG = {
    bubble(a) {
      a = a.slice(); const s = [], n = a.length;
      for (let i = 0; i < n - 1; i++) { for (let j = 0; j < n - 1 - i; j++) if (a[j] > a[j + 1]) swap(a, j, j + 1); s.push(a.slice()); }
      return s;
    },
    selection(a) {
      a = a.slice(); const s = [], n = a.length;
      for (let i = 0; i < n - 1; i++) { let m = i; for (let j = i + 1; j < n; j++) if (a[j] < a[m]) m = j; swap(a, i, m); s.push(a.slice()); }
      return s;
    },
    insertion(a) {
      a = a.slice(); const s = [];
      for (let i = 1; i < a.length; i++) { const key = a[i]; let j = i - 1; while (j >= 0 && a[j] > key) { a[j + 1] = a[j]; j--; } a[j + 1] = key; s.push(a.slice()); }
      return s;
    },
    merge(a) {
      a = a.slice(); const s = [], n = a.length;
      for (let w = 1; w < n; w *= 2) {
        const out = [];
        for (let lo = 0; lo < n; lo += 2 * w) out.push(...a.slice(lo, lo + w).concat(a.slice(lo + w, lo + 2 * w)).sort((x, y) => x - y));
        a = out; s.push(a.slice());
      }
      return s;
    },
    heapsort(a) {
      a = a.slice(); const s = [], n = a.length;
      const down = (i, end) => { for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < end && a[l] > a[m]) m = l; if (r < end && a[r] > a[m]) m = r; if (m === i) return; swap(a, i, m); i = m; } };
      for (let i = (n >> 1) - 1; i >= 0; i--) down(i, n);
      s.push(a.slice()); // snapshot 0 = after build
      for (let end = n - 1; end > 0; end--) { swap(a, 0, end); down(0, end); s.push(a.slice()); }
      return s;
    },
    radix(a) {
      let cur = a.slice(); const s = [];
      for (let p = 1; p <= 100; p *= 10) { const b = U.range(10).map(() => []); cur.forEach((x) => b[Math.floor(x / p) % 10].push(x)); cur = b.flat(); s.push(cur.slice()); }
      return s;
    },
  };
  function lomuto(a) {
    a = a.slice(); const hi = a.length - 1, pivot = a[hi]; let i = 0;
    for (let j = 0; j < hi; j++) if (a[j] < pivot) { swap(a, i, j); i++; }
    swap(a, i, hi);
    return { arr: a, p: i, pivot };
  }
  const inversions = (a) => { let c = 0; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i] > a[j]) c++; return c; };

  const NAMES = { bubble: "Bubble sort", selection: "Selection sort", insertion: "Insertion sort", merge: "Merge sort (bottom-up)" };
  const RULES = {
    bubble: "One pass sweeps left to right, swapping adjacent pairs that are out of order.",
    selection: "One pass finds the minimum of the unsorted part and swaps it to the front of that part.",
    insertion: "One pass takes the next element and shifts it left into the sorted prefix.",
    merge: "Pass 1 merges single elements into sorted pairs, pass 2 merges pairs into runs of 4, and so on.",
  };
  const HALLMARK = {
    bubble: "Bubble sort pushes the largest remaining values to the end, so the tail is sorted and final.",
    selection: "Selection sort fills the front with the smallest values in final position and leaves the rest roughly as it was.",
    insertion: "Insertion sort keeps a sorted prefix of the original first elements and leaves the suffix untouched.",
    merge: "Bottom-up merge sort produces sorted runs of length 2, 4, … aligned to the start.",
  };

  const arr = (n, lo = 1, hi = 40) => U.distinctInts(n, lo, hi);
  const choice = (o) => ({ kind: "choice", ...o });

  function passQ(lvl) {
    const n = [5, 6, 7, 8][lvl - 1];
    const algos = lvl >= 3 ? ["bubble", "selection", "insertion", "merge"] : ["bubble", "selection", "insertion"];
    for (let t = 0; t < 100; t++) {
      const a = arr(n);
      const alg = U.pick(algos);
      const snaps = ALG[alg](a);
      const maxK = Math.min(lvl === 1 ? 1 : lvl === 2 ? 2 : 3, snaps.length);
      const k = U.randInt(1, maxK);
      const ans = snaps[k - 1];
      if (U.eq(ans, a) || U.eq(ans, a.slice().sort((x, y) => x - y))) continue;
      const traps = [];
      if (snaps[k]) traps.push(snaps[k]);
      if (k >= 2) traps.push(snaps[k - 2]);
      algos.filter((x) => x !== alg).forEach((x) => { const o = ALG[x](a); if (o[k - 1]) traps.push(o[k - 1]); });
      const tr = U.shuffle(traps.filter((x) => !U.eq(x, ans)));
      return choice({
        tag: "Sorting",
        prompt: `<b>${NAMES[alg]}</b>, ascending. ${RULES[alg]} What is the array after pass <b>${k}</b>?`,
        code: `a = ${fmt(a)}`,
        options: U.listOptions(ans, tr),
        answer: fmt(ans),
        explain: "Passes: " + snaps.slice(0, Math.max(k, 1) + (snaps[k] ? 1 : 0)).map((s, i) => `<br><span class="mono">${i + 1}: ${fmt(s)}</span>`).join(""),
      });
    }
    return swapsQ(lvl);
  }

  function lomutoQ() {
    const a = arr(U.randInt(6, 8));
    const { arr: res, p, pivot } = lomuto(a);
    const stable = [...a.slice(0, -1).filter((x) => x < pivot), pivot, ...a.slice(0, -1).filter((x) => x > pivot)];
    const firstPivot = (() => { const b = [a[a.length - 1], ...a.slice(0, -1)]; return lomuto(b.reverse()).arr; })();
    return choice({
      tag: "Quicksort",
      prompt: "Run one Lomuto partition (pivot = last element). What is the array afterwards?",
      code: `def partition(a, lo, hi):\n    pivot = a[hi]\n    i = lo\n    for j in range(lo, hi):\n        if a[j] < pivot:\n            a[i], a[j] = a[j], a[i]\n            i += 1\n    a[i], a[hi] = a[hi], a[i]\n    return i\n\na = ${fmt(a)}\npartition(a, 0, ${a.length - 1})`,
      options: U.listOptions(res, [stable, firstPivot, a.slice().sort((x, y) => x - y)].filter((x) => !U.eq(x, res))),
      answer: fmt(res),
      explain: `The pivot ${pivot} lands at index ${p}, with everything smaller to its left. Lomuto's swaps do not preserve the order inside each side, which is why quicksort isn't stable.`,
    });
  }

  function heapQ() {
    const a = arr(U.randInt(6, 8));
    const snaps = ALG.heapsort(a);
    const k = U.randInt(0, 2);
    const ans = snaps[k];
    const traps = [snaps[k + 1], k ? snaps[k - 1] : a, a.slice().sort((x, y) => y - x)].filter((x) => x && !U.eq(x, ans));
    return choice({
      tag: "Heap sort",
      prompt: k === 0
        ? "Heap sort first builds a <b>max-heap</b> in place (sift down from the last parent back to the root). What is the array after the build?"
        : `Heap sort: build a max-heap, then each extraction swaps the root with the last heap slot and sifts the new root down. What is the array after the build plus <b>${k}</b> extraction${k > 1 ? "s" : ""}?`,
      code: `a = ${fmt(a)}`,
      options: U.listOptions(ans, traps),
      answer: fmt(ans),
      explain: `After build: <span class="mono">${fmt(snaps[0])}</span>` + snaps.slice(1, k + 1).map((s, i) => `<br>After extraction ${i + 1}: <span class="mono">${fmt(s)}</span>`).join("") + ". The sorted part grows from the right.",
    });
  }

  function radixQ() {
    const a = U.distinctInts(7, 100, 999);
    const snaps = ALG.radix(a);
    const k = U.randInt(1, 2);
    const ans = snaps[k - 1];
    const msd = a.slice().sort((x, y) => Math.floor(x / 100) - Math.floor(y / 100));
    return choice({
      tag: "Radix sort",
      prompt: `LSD radix sort buckets by one digit per pass, stably, starting from the ones digit. What is the array after pass <b>${k}</b>?`,
      code: `a = ${fmt(a)}`,
      options: U.listOptions(ans, [snaps[k] || snaps[0], k === 2 ? snaps[0] : snaps[1], msd].filter((x) => !U.eq(x, ans))),
      answer: fmt(ans),
      explain: "Pass by pass: " + snaps.map((s, i) => `<br><span class="mono">${["ones", "tens", "hundreds"][i]}: ${fmt(s)}</span>`).join("") + "<br>Stability is what makes later passes keep the earlier ordering inside each bucket.",
    });
  }

  function whichQ(lvl) {
    const pool = ["bubble", "selection", "insertion", "merge"];
    for (let t = 0; t < 200; t++) {
      const a = arr(lvl >= 4 ? 8 : 7);
      const all = Object.fromEntries(pool.map((x) => [x, ALG[x](a)]));
      const alg = U.pick(pool);
      const k = U.randInt(1, Math.min(lvl >= 4 ? 3 : 2, all[alg].length - 1));
      const S = all[alg][k - 1];
      if (U.eq(S, a.slice().sort((x, y) => x - y))) continue;
      const ambiguous = pool.some((x) => x !== alg && all[x].some((s) => U.eq(s, S)));
      if (ambiguous) continue;
      return choice({
        tag: "Sorting",
        prompt: `An algorithm was sorting the array ascending. After a few passes the array looked like this. Which algorithm was it?<div class="mono strong">${fmt(S)}</div>`,
        code: `a = ${fmt(a)}`,
        options: U.shuffle(pool.map((x) => NAMES[x])),
        mono: false,
        answer: NAMES[alg],
        explain: `It is ${NAMES[alg]} after pass ${k}. ${HALLMARK[alg]}`,
        review: `Original ${fmt(a)} became ${fmt(S)}. Which algorithm?`,
      });
    }
    return passQ(lvl);
  }

  function swapsQ(lvl) {
    const n = [5, 6, 7, 8][lvl - 1];
    const a = arr(n);
    const inv = inversions(a);
    const which = lvl >= 3 && Math.random() < 0.5 ? "insertion" : "bubble";
    return choice({
      tag: "Sorting",
      prompt: which === "bubble"
        ? "How many swaps does bubble sort make to sort this array ascending?"
        : "How many element shifts does insertion sort make to sort this array ascending?",
      code: `a = ${fmt(a)}`,
      options: U.numOptions(inv, [n * (n - 1) / 2, n - 1, inv + 2]),
      answer: String(inv),
      explain: `Both equal the number of inversions, the pairs i < j with a[i] > a[j]. Each adjacent swap or shift fixes exactly one. This array has ${inv}. The maximum for n = ${n} is ${n * (n - 1) / 2}.`,
    });
  }

  const FACTS = [
    [1, "Which of these sorting algorithms is stable?", "Merge sort", ["Quicksort", "Heap sort", "Selection sort"], "Stable sorts keep equal keys in their original order. Merge sort takes from the left run on ties."],
    [1, "Best-case running time of insertion sort, on input that is already sorted?", "O(n)", ["O(n log n)", "O(n²)", "O(1)"], "Each element is compared once with its left neighbour and stays put."],
    [1, "Which sort makes O(n²) comparisons even on already-sorted input?", "Selection sort", ["Insertion sort", "Bubble sort with an early exit", "Timsort"], "Selection sort always scans the whole unsorted part for its minimum."],
    [1, "What does it mean for a sort to be stable?", "Equal keys keep their original relative order", ["It never uses extra memory", "It always runs in O(n log n)", "It gives the same output for any input order"], "Stability matters when sorting by one key after another, for example by name and then by department."],
    [2, "Worst-case running time of quicksort with a naive pivot choice?", "O(n²)", ["O(n log n)", "O(n)", "O(2ⁿ)"], "Consistently bad pivots, such as the first element of sorted input, peel off one element per level."],
    [2, "Which sort guarantees O(n log n) in the worst case while using only O(1) extra space?", "Heap sort", ["Merge sort", "Quicksort", "Insertion sort"], "Heap sort works in place. Merge sort needs O(n) buffer space and quicksort can degrade to O(n²)."],
    [2, "Extra memory used by a standard top-down merge sort on an array?", "O(n)", ["O(1)", "O(log n)", "O(n²)"], "Merging needs a temporary buffer as large as the runs being merged."],
    [2, "Which algorithm do Python's sorted() and Java's object sort use?", "Timsort", ["Quicksort", "Heap sort", "Introsort"], "Timsort is a merge sort / insertion sort hybrid that exploits existing runs."],
    [3, "Which of these is not a comparison sort?", "Radix sort", ["Heap sort", "Shell sort", "Merge sort"], "Radix sort inspects digits instead of comparing keys, so it can beat n log n for bounded keys."],
    [3, "Lower bound on comparisons for any comparison sort in the worst case?", "Ω(n log n)", ["Ω(n)", "Ω(n²)", "Ω(log n)"], "A decision tree needs n! leaves, and log₂(n!) = Θ(n log n)."],
    [3, "Which of these sorts makes the fewest swaps in the worst case?", "Selection sort", ["Bubble sort", "Insertion sort", "Quicksort"], "Selection sort makes at most n−1 swaps, which helps when writes are expensive."],
    [3, "What does C++ std::sort typically implement?", "Introsort", ["Timsort", "Merge sort", "Heap sort"], "Introsort is quicksort that falls back to heap sort on deep recursion and finishes small ranges with insertion sort."],
    [3, "Randomised quicksort's expected running time on any input is…", "O(n log n)", ["O(n²)", "O(n)", "O(n log² n)"], "A random pivot makes balanced-enough splits likely regardless of the input order."],
    [4, "When does introsort switch from quicksort to heap sort?", "When recursion depth exceeds about 2·log₂ n", ["When a subarray has fewer than 16 elements", "When the pivot equals the median", "When the input is detected as sorted"], "The depth limit caps the worst case at O(n log n). Small subarrays go to insertion sort instead."],
    [4, "When is counting sort a poor choice?", "When the key range k is much larger than n", ["When keys repeat often", "When the sort must be stable", "When n is very large"], "Counting sort is O(n + k), so a huge k dominates time and memory."],
    [4, "Expected number of comparisons made by randomised quicksort?", "About 1.39 · n log₂ n", ["Exactly n log₂ n", "About n²/4", "About 2n"], "It is 2n ln n ≈ 1.39 n log₂ n."],
    [4, "Which sort is adaptive, getting faster as the input gets closer to sorted?", "Insertion sort", ["Heap sort", "Selection sort", "Standard merge sort"], "Its running time is O(n + inversions)."],
    [4, "Can a comparison sort be stable, in place and O(n log n) worst case all at once?", "Yes, with in-place merge sorts such as block sort", ["No, it's impossible", "Only for integers", "Only with O(n) extra memory"], "Block sort (WikiSort) achieves all three, at the cost of a lot of complexity."],
  ];
  function factQ(lvl) {
    const pool = FACTS.filter((f) => f[0] === lvl);
    const [, q, a, wrong, why] = U.pick(pool.length ? pool : FACTS);
    return choice({ tag: "Sorting facts", prompt: q, options: U.shuffle([a, ...wrong]), mono: false, wide: a.length > 24, answer: a, explain: why });
  }

  const TYPES = {
    1: [() => passQ(1), () => passQ(1), () => passQ(1), () => swapsQ(1), () => factQ(1), () => factQ(1)],
    2: [() => passQ(2), () => passQ(2), () => lomutoQ(), () => swapsQ(2), () => factQ(2), () => factQ(2)],
    3: [() => passQ(3), () => passQ(3), () => whichQ(3), () => heapQ(), () => swapsQ(3), () => lomutoQ(), () => factQ(3)],
    4: [() => heapQ(), () => radixQ(), () => whichQ(4), () => passQ(4), () => lomutoQ(), () => factQ(4), () => heapQ(), () => factQ(4)],
  };

  D.registerMode({
    id: "sortlab",
    name: "Sort Lab",
    group: "Simulators",
    topic: "Sorting",
    blurb: "Predict snapshots of bubble, selection, insertion, merge, quick, heap and radix sort.",
    generated: true,
    count: 10,
    make: (lvl, count) => D.mixFrom(TYPES[lvl], count),
  });
})();
