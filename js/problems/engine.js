/* Problem Set engine: every problem has three levels (Easy, Medium, Hard).
   A problem picks an answer widget and defines either
     ans(I)                  exact answer, or
     accept(I, a)            any answer passing this check, or
     valid(I, a) + val(I, a) an optimisation: the best value is found by brute force over the widget's answer space
                             (or by solve(I) when the space is too large to enumerate). */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign;
  const PB = (D.pb = { list: [], byId: new Map() });
  PB.LV = ["Easy", "Medium", "Hard"];
  PB.CATS = [
    { id: "classic", name: "Classic puzzles" },
    { id: "arrays", name: "Arrays & hashing" },
    { id: "windows", name: "Two pointers & sliding windows" },
    { id: "strings", name: "Strings" },
    { id: "stacks", name: "Stacks, queues & linked lists" },
    { id: "search", name: "Searching & sorting" },
    { id: "grids", name: "Grids & matrices" },
    { id: "graphs", name: "Graphs" },
    { id: "trees", name: "Trees" },
    { id: "greedy", name: "Greedy, intervals & heaps" },
    { id: "dp", name: "Dynamic programming" },
    { id: "math", name: "Math, bits & geometry" },
    { id: "backtrack", name: "Backtracking & state search" },
    { id: "games", name: "Games & simulation" },
  ];

  PB.add = function (def) {
    if (!def.id || PB.byId.has(def.id)) throw new Error("bad or duplicate problem id " + def.id);
    def.sense = def.sense || "max";
    PB.list.push(def);
    PB.byId.set(def.id, def);
  };
  PB.addAll = (cat, defs) => defs.forEach((d) => PB.add({ cat, ...d }));

  /* ---------- helpers for problem authors ---------- */
  const H = (PB.h = {
    sum: (a, i = 0, j = a.length - 1) => { let s = 0; for (let k = i; k <= j; k++) s += a[k]; return s; },
    seg: (a, [i, j]) => a.slice(i, j + 1),
    isInc: (a) => a.every((x, i) => i === 0 || a[i - 1] < x),
    isNonDec: (a) => a.every((x, i) => i === 0 || a[i - 1] <= x),
    isPal: (s) => { const t = [...s]; return t.join("") === t.reverse().join(""); },
    pick: (a, idx) => idx.map((i) => a[i]),
    count: (a, f) => a.filter(f).length,
    max: (a) => Math.max(...a),
    min: (a) => Math.min(...a),
    gcd: (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; },
    isSubseq: (s, t) => { let i = 0; for (const ch of t) if (i < s.length && s[i] === ch) i++; return i === s.length; },
    cnt: (s) => { const m = new Map(); for (const x of s) m.set(x, (m.get(x) || 0) + 1); return m; },
    distinct: (a) => new Set(a).size,
    fmt: U.fmt,
    code: (s) => `<code>${U.esc(s)}</code>`,
    tt: (s) => `<span class="mono">${U.esc(s)}</span>`,
    cells: (rows, cols) => { const out = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([r, c]); return out; },
  });

  /* ---------- answer spaces for brute force ---------- */
  function* subsets(n) { for (let m = 0; m < 1 << n; m++) { const s = []; for (let i = 0; i < n; i++) if (m >> i & 1) s.push(i); yield s; } }
  function* combos(n, k, start = 0, cur = []) { if (cur.length === k) { yield cur.slice(); return; } for (let i = start; i < n; i++) { cur.push(i); yield* combos(n, k, i + 1, cur); cur.pop(); } }
  function* perms(n) { const a = U.range(n), used = Array(n).fill(false), cur = []; function* go() { if (cur.length === n) { yield cur.slice(); return; } for (let i = 0; i < n; i++) if (!used[i]) { used[i] = true; cur.push(i); yield* go(); cur.pop(); used[i] = false; } } yield* go(); void a; }
  function* tuples(n, k) { const t = Array(n).fill(0); for (;;) { yield t.slice(); let i = 0; while (i < n && ++t[i] === k) t[i++] = 0; if (i === n) return; } }
  PB.gen = { subsets, combos, perms, tuples };

  const PAIRED = new Set(["pick", "nodes", "edges"]);
  const sortCells = (a) => a.map((x) => x.slice()).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  PB.norm = (w, a) => (a == null ? a : PAIRED.has(w) ? a.slice().sort((x, y) => x - y) : w === "gpick" ? sortCells(a) : a);
  PB.same = (w, a, b) => JSON.stringify(PB.norm(w, a)) === JSON.stringify(PB.norm(w, b));

  function space(p, spec, I) {
    if (p.space) return p.space(I, spec);
    const n = spec.items ? spec.items.length : spec.G ? spec.G.n : 0;
    switch (p.w) {
      case "pick": return spec.k != null ? combos(n, spec.k) : subsets(n);
      case "range": return (function* () { for (let i = 0; i < n; i++) for (let j = i; j < n; j++) yield [i, j]; if (spec.wrap) for (let i = 1; i < n; i++) for (let j = 0; j < i - 1; j++) yield [i, j]; })();
      case "cuts": return subsets(n - 1);
      case "order": return perms(spec.items.length);
      case "groups": return tuples(n, spec.k);
      case "counts": return (function* () { const m = spec.types.length, mx = spec.max; const t = Array(m).fill(0); for (;;) { yield t.slice(); let i = 0; while (i < m && ++t[i] > (Array.isArray(mx) ? mx[i] : mx)) t[i++] = 0; if (i === m) return; } })();
      case "gpick": if (spec.k === 1) return (function* () { for (let r = 0; r < spec.grid.length; r++) for (let c = 0; c < spec.grid[0].length; c++) if (!spec.blocked || !spec.blocked(r, c)) yield [[r, c]]; })(); break;
      case "grect": return (function* () { const R = spec.grid.length, Cc = spec.grid[0].length; for (let r1 = 0; r1 < R; r1++) for (let r2 = r1; r2 < R; r2++) for (let c1 = 0; c1 < Cc; c1++) for (let c2 = c1; c2 < Cc; c2++) yield [r1, c1, r2, c2]; })();
      case "nodes": return spec.k != null ? combos(n, spec.k) : subsets(n);
      case "edges": return spec.k != null ? combos(spec.G.edges.length, spec.k) : subsets(spec.G.edges.length);
      case "ncolor": return tuples(n, spec.k);
      case "npath": return simplePaths(spec);
      case "gpath": return gridPaths(spec);
    }
    throw new Error(`${p.id}: no answer space for widget ${p.w}; give solve() or ans()`);
  }
  function* simplePaths(spec) {
    const G = spec.G, A = C.adj(G, spec.directed), path = [], used = new Set();
    function* go(u) {
      path.push(u); used.add(u);
      if (path.length >= 2 && (spec.end == null || u === spec.end)) yield path.slice();
      if (spec.end == null || u !== spec.end) for (const { v } of A[u]) if (!used.has(v)) yield* go(v);
      path.pop(); used.delete(u);
    }
    const starts = spec.start != null ? [spec.start] : U.range(G.n);
    for (const s of starts) yield* go(s);
  }
  // All simple grid paths from spec.start (or every open cell) ending anywhere or at spec.end; refuses huge spaces.
  function gridPaths(spec) {
    const R = spec.grid.length, Cc = spec.grid[0].length, out = [], path = [], used = new Set();
    let count = 0;
    const cand = (r, c) => { const res = []; for (let y = 0; y < R; y++) for (let x = 0; x < Cc; x++) if (PB.gstep(spec, [r, c], [y, x])) res.push([y, x]); return res; };
    const go = (r, c) => {
      if (++count > 200000) throw new Error("no answer space: grid too large to enumerate");
      path.push([r, c]); used.add(r * 100 + c);
      if (path.length >= 2 && (!spec.end || (r === spec.end[0] && c === spec.end[1]))) out.push(path.map((p) => p.slice()));
      if (!spec.end || r !== spec.end[0] || c !== spec.end[1]) for (const [y, x] of cand(r, c)) if (!used.has(y * 100 + x)) go(y, x);
      path.pop(); used.delete(r * 100 + c);
    };
    if (spec.start) go(spec.start[0], spec.start[1]);
    else for (let r = 0; r < R; r++) for (let c = 0; c < Cc; c++) if (!spec.blocked || !spec.blocked(r, c)) go(r, c);
    return out;
  }
  PB.space = space;

  function brute(p, I, spec) {
    let best = null, bestA = null;
    const better = p.sense === "min" ? (a, b) => a < b : (a, b) => a > b;
    for (const a of space(p, spec, I)) {
      if (p.valid && p.valid(I, a) !== true) continue;
      const v = p.val(I, a);
      if (v == null || Number.isNaN(v)) continue;
      if (best === null || better(v, best)) { best = v; bestA = a; }
    }
    return bestA;
  }
  PB.brute = brute;

  /* ---------- building a level ---------- */
  const cache = new Map();
  PB.spec = (p, I) => {
    const base = { items: I.a || (typeof I.s === "string" ? [...I.s] : undefined), G: I.G, grid: I.grid };
    return { ...base, ...(p.ui ? p.ui(I) : {}) };
  };
  PB.level = function (p, lv) {
    const key = p.id + "/" + lv;
    if (cache.has(key)) return cache.get(key);
    if (p.world) {
      const w = C.world(p.world);
      const out = { p, lv, world: w, P: C.level(w, p.levels[lv - 1]) };
      cache.set(key, out);
      return out;
    }
    const others = new Set();
    for (let k = 1; k < lv; k++) others.add(PB.level(p, k).sig);
    let out = null, lastErr = null;
    for (let attempt = 0; attempt < 80 && !out; attempt++) {
      const R = C.rng(`${p.id}/${lv}/${attempt}`);
      let I;
      try { I = p.gen(lv, R); } catch (e) { lastErr = e; continue; }
      if (!I) continue;
      const sig = JSON.stringify(I);
      if (others.has(sig)) continue;
      const spec = PB.spec(p, I);
      const sol = p.ans ? p.ans(I) : p.solve ? p.solve(I, spec) : p.val ? brute(p, I, spec) : null;
      if (sol == null) continue;
      if (p.reject && p.reject(I, sol)) continue;
      const best = p.val ? p.val(I, sol) : null;
      out = { p, lv, I, spec, sol, best, sig };
    }
    if (!out) throw lastErr || new Error("could not generate " + key);
    cache.set(key, out);
    return out;
  };

  const fmtV = (v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2).replace(/\.?0+$/, "") : String(v));
  PB.grade = function (L, a) {
    const { p, I, sol, best } = L;
    if (a == null) return { ok: false, incomplete: true, msg: "Finish your answer first." };
    if (p.accept) {
      const r = p.accept(I, a);
      return r === true ? { ok: true } : { ok: false, msg: typeof r === "string" ? r : p.diag ? p.diag(I, a) : "Not quite." };
    }
    if (p.val) {
      const v = p.valid ? p.valid(I, a) : true;
      if (v !== true) return { ok: false, msg: `Not valid: ${typeof v === "string" ? v : "it breaks a rule"}.` };
      const got = p.val(I, a);
      const better = p.sense === "min" ? got < best : got > best;
      if (got === best || better) return { ok: true, got, beat: better };
      return { ok: false, msg: `That works, with ${p.vname || "a value of"} ${fmtV(got)}, but the best possible is <b>${fmtV(best)}</b>.` };
    }
    return PB.same(p.w, a, sol) ? { ok: true } : { ok: false, msg: p.diag ? p.diag(I, a) : "Not quite. Check your work and try again." };
  };

  /* ================= Widgets ================= */
  const W = (PB.widgets = {});
  const esc = U.esc;

  function stripHTML(spec, i, cls, extra = "") {
    const v = spec.items[i];
    const sub = spec.sub ? spec.sub[i] || "\u00a0" : spec.idx ? i : "";
    const style = spec.style || (typeof v === "number" && spec.items.length > 1 ? "bars" : "tiles");
    if (style === "bars") {
      const nums = spec.items.map(Number), mx = Math.max(1, ...nums.map(Math.abs)), neg = nums.some((x) => x < 0);
      const h = (Math.abs(v) / mx) * (neg ? 50 : 100);
      return `<button type="button" class="pi bars${v < 0 ? " neg" : ""}${neg ? " split" : ""} ${cls}" data-i="${i}" aria-label="${esc(v)}${sub !== "" ? ", " + sub : ""}" ${extra}><span class="pcol"><span class="pfill" style="height:${h}%"></span></span><span class="pv">${esc(v)}</span>${sub !== "" ? `<span class="ps">${esc(sub)}</span>` : ""}</button>`;
    }
    return `<button type="button" class="pi ${style} ${cls}" data-i="${i}" ${extra}><span class="pv">${esc(v)}</span>${sub !== "" ? `<span class="ps">${esc(sub)}</span>` : ""}</button>`;
  }

  W.pick = (el, spec, onChange) => {
    let sel = new Set(), locked = false;
    el.innerHTML = `<div class="pstrip ${spec.wrapRow ? "wrap" : ""}"></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.lastChild;
    const render = () => {
      box.innerHTML = spec.items.map((_, i) => stripHTML(spec, i, (sel.has(i) ? "on" : "") + (spec.hl && spec.hl.includes(i) ? " hl" : ""), locked ? "disabled" : "")).join("");
      note.textContent = spec.k === 1 ? "" : `${sel.size} selected${spec.k ? ` (pick ${spec.k})` : ""}`;
    };
    C.onPick(box, "data-i", (v) => {
      if (locked) return;
      const i = +v;
      if (spec.k === 1) sel = new Set(sel.has(i) ? [] : [i]);
      else if (sel.has(i)) sel.delete(i);
      else { if (spec.k && sel.size >= spec.k) return; sel.add(i); }
      render(); onChange();
    });
    render();
    return {
      get: () => (spec.k && sel.size !== spec.k ? null : [...sel].sort((a, b) => a - b)),
      set: (a) => { sel = new Set(a); render(); },
      clear: () => { sel = new Set(); render(); },
      lock: () => { locked = true; render(); },
    };
  };

  W.range = (el, spec, onChange) => {
    let a = null, b = null, locked = false;
    el.innerHTML = `<div class="pstrip"></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.lastChild, n = spec.items.length;
    const inSel = (i) => { if (a == null || b == null) return false; return a <= b ? i >= a && i <= b : i >= a || i <= b; };
    const render = () => {
      box.innerHTML = spec.items.map((_, i) => stripHTML(spec, i, (inSel(i) ? "on" : "") + (a === i && b == null ? " start" : "") + (spec.hl && spec.hl.includes(i) ? " hl" : ""), locked ? "disabled" : "")).join("");
      note.textContent = a == null ? "Tap the first element of the range." : b == null ? "Now tap the last element." : `Range ${a} … ${b}${spec.wrap && a > b ? " (wraps around)" : ""}`;
    };
    C.onPick(box, "data-i", (v) => {
      if (locked) return;
      const i = +v;
      if (a == null || b != null) { a = i; b = null; }
      else { b = i; if (!spec.wrap && b < a) [a, b] = [b, a]; }
      render(); onChange();
    });
    render();
    void n;
    return { get: () => (a == null || b == null ? null : [a, b]), set: ([x, y]) => { a = x; b = y; render(); }, clear: () => { a = b = null; render(); }, lock: () => { locked = true; render(); } };
  };

  W.cuts = (el, spec, onChange) => {
    let cuts = new Set(), locked = false;
    el.innerHTML = `<div class="pstrip cutstrip"></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.lastChild;
    const render = () => {
      box.innerHTML = spec.items.map((_, i) => stripHTML(spec, i, "") + (i < spec.items.length - 1 ? `<button type="button" class="cutgap${cuts.has(i) ? " on" : ""}" data-g="${i}" aria-label="Cut after item ${i}" ${locked ? "disabled" : ""}></button>` : "")).join("");
      const pieces = []; let start = 0;
      [...cuts].sort((x, y) => x - y).concat(spec.items.length - 1).forEach((g) => { pieces.push(spec.items.slice(start, g + 1).join(spec.style === "chars" ? "" : " ")); start = g + 1; });
      note.innerHTML = `${cuts.size + 1} piece${cuts.size ? "s" : ""}: ${pieces.map((p) => `<span class="piece">${esc(p)}</span>`).join(" ")}`;
    };
    C.onPick(box, "data-g", (v) => { if (locked) return; const g = +v; if (cuts.has(g)) cuts.delete(g); else cuts.add(g); render(); onChange(); });
    render();
    return { get: () => [...cuts].sort((a, b) => a - b), set: (a) => { cuts = new Set(a); render(); }, clear: () => { cuts = new Set(); render(); }, lock: () => { locked = true; render(); } };
  };

  W.order = (el, spec, onChange) => {
    let seq = [], locked = false;
    const need = spec.len || spec.items.length;
    el.innerHTML = `<div class="seq"></div><div class="chips"></div><div class="actions"><button type="button" class="btn ghost undo">Undo</button><button type="button" class="btn ghost clr">Clear</button></div>`;
    const seqEl = el.querySelector(".seq"), chips = el.querySelector(".chips");
    const render = () => {
      seqEl.innerHTML = U.range(need).map((k) => `<span class="slot ${seq[k] != null ? "filled" : ""}">${seq[k] != null ? esc(spec.items[seq[k]]) : ""}</span>`).join('<span class="arrow">→</span>');
      chips.innerHTML = spec.items.map((it, i) => `<button type="button" class="chip-btn" data-i="${i}" ${locked || (!spec.repeat && seq.includes(i)) || seq.length >= need ? "disabled" : ""}>${esc(it)}</button>`).join("");
    };
    C.onPick(chips, "data-i", (v) => { if (locked || seq.length >= need) return; seq.push(+v); render(); onChange(); });
    el.querySelector(".undo").addEventListener("click", () => { if (!locked) { seq.pop(); render(); onChange(); } });
    el.querySelector(".clr").addEventListener("click", () => { if (!locked) { seq = []; render(); onChange(); } });
    render();
    return { get: () => (seq.length === need ? seq.slice() : null), set: (a) => { seq = a.slice(); render(); }, clear: () => { seq = []; render(); }, lock: () => { locked = true; render(); el.querySelectorAll(".undo,.clr").forEach((b) => (b.disabled = true)); } };
  };

  W.num = (el, spec, onChange) => {
    el.innerHTML = `<div class="numbox"><button type="button" class="btn ghost dec" aria-label="Decrease">−</button><input type="number" inputmode="numeric" class="numin" aria-label="Your answer" placeholder="?"><button type="button" class="btn ghost inc" aria-label="Increase">+</button>${spec.unit ? `<span class="muted">${esc(spec.unit)}</span>` : ""}</div>`;
    const inp = el.querySelector("input");
    const bump = (d) => { inp.value = String((Number(inp.value) || 0) + d); onChange(); };
    el.querySelector(".dec").addEventListener("click", () => bump(-1));
    el.querySelector(".inc").addEventListener("click", () => bump(1));
    inp.addEventListener("input", onChange);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.dispatchEvent(new CustomEvent("pb-submit", { bubbles: true })); } });
    return { get: () => (inp.value.trim() === "" || Number.isNaN(Number(inp.value)) ? null : Number(inp.value)), set: (v) => { inp.value = String(v); }, clear: () => { inp.value = ""; }, lock: () => { inp.disabled = true; el.querySelectorAll("button").forEach((b) => (b.disabled = true)); } };
  };

  W.choice = (el, spec, onChange) => {
    let cur = null, locked = false;
    el.innerHTML = `<div class="opts ${spec.opts.some((o) => String(o).length > 18) ? "one-col" : ""}"></div>`;
    const box = el.firstChild;
    const render = () => { box.innerHTML = spec.opts.map((o, k) => `<button type="button" class="opt${cur === o ? " right" : ""}" data-k="${k}" ${locked ? "disabled" : ""}><span>${esc(o)}</span></button>`).join(""); };
    C.onPick(box, "data-k", (v) => { if (locked) return; cur = spec.opts[+v]; render(); onChange(); });
    render();
    return { get: () => cur, set: (v) => { cur = v; render(); }, clear: () => { cur = null; render(); }, lock: () => { locked = true; render(); } };
  };

  const GROUP_COLORS = ["#1c7ed6", "#e8590c", "#2f9e44", "#ae3ec9", "#f59f00", "#0ca678", "#d6336c", "#5c7cfa"];
  W.groups = (el, spec, onChange) => {
    let g = Array(spec.items.length).fill(-1), pen = 0, locked = false;
    const names = spec.names || U.range(spec.k).map((k) => "Group " + (k + 1));
    el.innerHTML = `<div class="palette">${names.map((nm, k) => `<button type="button" class="gswatch" data-c="${k}" style="--sw:${GROUP_COLORS[k % 8]}">${esc(nm)}</button>`).join("")}</div>${spec.table ? '<div class="table-wrap gtable"></div>' : '<div class="pstrip wrap gstrip"></div>'}<div class="pnote"></div>`;
    const pal = el.querySelector(".palette"), note = el.querySelector(".pnote");
    const box = el.querySelector(spec.table ? ".gtable" : ".gstrip");
    const render = () => {
      pal.querySelectorAll(".gswatch").forEach((b) => b.classList.toggle("on", +b.dataset.c === pen));
      if (spec.table) {
        box.innerHTML = `<table class="assign"><thead><tr><th></th>${spec.items.map((it) => `<th>${esc(it)}</th>`).join("")}</tr></thead><tbody>${names.map((nm, k) => `<tr><th>${esc(nm)}</th>${spec.items.map((_, i) => `<td><button type="button" class="acell${g[i] === k ? " on" : ""}" data-ik="${i},${k}" ${locked ? "disabled" : ""}>${esc(spec.table[k][i])}</button></td>`).join("")}</tr>`).join("")}</tbody></table>`;
      } else {
        box.innerHTML = spec.items.map((_, i) => stripHTML({ ...spec, style: spec.style || "tiles" }, i, g[i] >= 0 ? "grouped" : "", `${locked ? "disabled" : ""} style="${g[i] >= 0 ? `--gc:${GROUP_COLORS[g[i] % 8]}` : ""}"`)).join("");
      }
      const tally = names.map((nm, k) => { const xs = spec.items.filter((_, i) => g[i] === k); return xs.length ? `${esc(nm)}: ${spec.sumLabel ? spec.sumLabel(xs, k) : xs.length}` : ""; }).filter(Boolean);
      note.innerHTML = `${g.filter((x) => x < 0).length} unassigned${tally.length ? " · " + tally.join(" · ") : ""}`;
    };
    pal.addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (b) { pen = +b.dataset.c; render(); } });
    if (spec.table) C.onPick(box, "data-ik", (v) => { if (locked) return; const [i, k] = v.split(",").map(Number); g[i] = g[i] === k ? -1 : k; render(); onChange(); });
    else C.onPick(box, "data-i", (v) => { if (locked) return; const i = +v; g[i] = g[i] === pen ? -1 : pen; render(); onChange(); });
    render();
    return { get: () => (g.some((x) => x < 0) ? null : g.slice()), set: (a) => { g = a.slice(); render(); }, clear: () => { g = g.map(() => -1); render(); }, lock: () => { locked = true; render(); } };
  };

  W.counts = (el, spec, onChange) => {
    let c = spec.types.map(() => 0), locked = false;
    el.innerHTML = `<div class="counts"></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.lastChild;
    const render = () => {
      box.innerHTML = spec.types.map((t, i) => `<div class="cnt"><span class="cl">${esc(t)}</span><button type="button" class="btn ghost small" data-d="${i},-1" ${locked ? "disabled" : ""}>−</button><b>${c[i]}</b><button type="button" class="btn ghost small" data-d="${i},1" ${locked ? "disabled" : ""}>+</button></div>`).join("");
      note.innerHTML = spec.total ? spec.total(c) : "";
    };
    C.onPick(box, "data-d", (v) => { if (locked) return; const [i, d] = v.split(",").map(Number); const mx = Array.isArray(spec.max) ? spec.max[i] : spec.max; c[i] = Math.max(0, Math.min(mx, c[i] + d)); render(); onChange(); });
    render();
    return { get: () => c.slice(), set: (a) => { c = a.slice(); render(); }, clear: () => { c = c.map(() => 0); render(); }, lock: () => { locked = true; render(); } };
  };

  /* ----- grids ----- */
  function gridCell(spec, r, c, cls, extra = "") {
    const v = spec.grid[r][c];
    const blocked = spec.blocked && spec.blocked(r, c);
    const k = spec.cls ? spec.cls(r, c) : "";
    return `<button type="button" class="gc${blocked ? " blk" : ""} ${k} ${cls}" data-rc="${r},${c}" ${extra} aria-label="Row ${r + 1}, column ${c + 1}${v !== "" && v != null ? ", " + esc(v) : ""}">${v == null ? "" : esc(v)}</button>`;
  }
  const gridWrap = (spec) => `<div class="pgrid" style="--cols:${spec.grid[0].length};--cell:${spec.cell || (spec.grid[0].length > 9 ? 30 : 40)}px"></div>`;

  W.gpick = (el, spec, onChange) => {
    let sel = [], locked = false;
    el.innerHTML = gridWrap(spec) + `<div class="pnote"></div>`;
    const box = el.firstChild, note = el.lastChild;
    const has = (r, c) => sel.findIndex(([y, x]) => y === r && x === c);
    const render = () => {
      let s = "";
      for (let r = 0; r < spec.grid.length; r++) for (let c = 0; c < spec.grid[0].length; c++) s += gridCell(spec, r, c, has(r, c) >= 0 ? "on" : "", locked ? "disabled" : "");
      box.innerHTML = s;
      note.textContent = spec.k === 1 ? "" : `${sel.length} cell${sel.length === 1 ? "" : "s"} selected`;
    };
    C.onPick(box, "data-rc", (v) => {
      if (locked) return;
      const [r, c] = v.split(",").map(Number);
      if (spec.blocked && spec.blocked(r, c) && !spec.pickBlocked) return;
      const i = has(r, c);
      if (spec.k === 1) sel = i >= 0 ? [] : [[r, c]];
      else if (i >= 0) sel.splice(i, 1);
      else sel.push([r, c]);
      render(); onChange();
    });
    render();
    return { get: () => (spec.k && sel.length !== spec.k ? null : sortCells(sel)), set: (a) => { sel = a.map((x) => x.slice()); render(); }, clear: () => { sel = []; render(); }, lock: () => { locked = true; render(); } };
  };

  const MOVES = {
    "4": [[1, 0], [-1, 0], [0, 1], [0, -1]],
    "8": [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
    rd: [[1, 0], [0, 1]],
    down3: [[1, -1], [1, 0], [1, 1]],
    dr: [[1, 0], [1, 1]],
    right3: [[-1, 1], [0, 1], [1, 1]],
    knight: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
  };
  PB.MOVES = MOVES;
  PB.gstep = function (spec, [r, c], [y, x]) {
    if (y < 0 || x < 0 || y >= spec.grid.length || x >= spec.grid[0].length) return false;
    if (spec.blocked && spec.blocked(y, x)) return false;
    if (spec.moves === "rook") {
      if (r !== y && c !== x) return false;
      if (r === y && c === x) return false;
      const dr = Math.sign(y - r), dc = Math.sign(x - c);
      for (let a = r + dr, b = c + dc; a !== y || b !== x; a += dr, b += dc) if (spec.blocked && spec.blocked(a, b)) return false;
      return true;
    }
    if (spec.step) return spec.step([r, c], [y, x]);
    return (MOVES[spec.moves || "4"]).some(([dr, dc]) => r + dr === y && c + dc === x);
  };
  W.gpath = (el, spec, onChange) => {
    let path = spec.start ? [spec.start.slice()] : [], locked = false;
    el.innerHTML = gridWrap(spec) + `<div class="actions"><button type="button" class="btn ghost undo">Undo step</button><button type="button" class="btn ghost clr">Clear</button></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.querySelector(".pnote");
    const idx = (r, c) => { for (let i = path.length - 1; i >= 0; i--) if (path[i][0] === r && path[i][1] === c) return i; return -1; };
    const render = () => {
      let s = "";
      const head = path[path.length - 1];
      for (let r = 0; r < spec.grid.length; r++) for (let c = 0; c < spec.grid[0].length; c++) {
        const i = idx(r, c);
        const lab = spec.start && r === spec.start[0] && c === spec.start[1] ? " gstart" : spec.end && r === spec.end[0] && c === spec.end[1] ? " gend" : "";
        s += gridCell(spec, r, c, (i >= 0 ? "on" : "") + (head && head[0] === r && head[1] === c ? " head" : "") + lab, locked ? "disabled" : "");
      }
      box.innerHTML = s;
      note.textContent = path.length ? `${path.length - 1} step${path.length === 2 ? "" : "s"}` + (spec.pathNote ? " · " + spec.pathNote(path) : "") : "Tap a starting cell.";
    };
    C.onPick(box, "data-rc", (v) => {
      if (locked) return;
      const p = v.split(",").map(Number);
      if (!path.length) { if (!(spec.blocked && spec.blocked(...p))) path.push(p); render(); onChange(); return; }
      const i = idx(...p);
      if (!spec.walk && i >= 0) { path.length = i + 1; render(); onChange(); return; }
      if (!PB.gstep(spec, path[path.length - 1], p)) return;
      path.push(p); render(); onChange();
    });
    el.querySelector(".undo").addEventListener("click", () => { if (!locked && path.length > (spec.start ? 1 : 0)) { path.pop(); render(); onChange(); } });
    el.querySelector(".clr").addEventListener("click", () => { if (!locked) { path = spec.start ? [spec.start.slice()] : []; render(); onChange(); } });
    render();
    return { get: () => (path.length < 2 && !spec.allowEmpty ? null : path.map((x) => x.slice())), set: (a) => { path = a.map((x) => x.slice()); render(); }, clear: () => { path = spec.start ? [spec.start.slice()] : []; render(); }, lock: () => { locked = true; render(); } };
  };

  W.grect = (el, spec, onChange) => {
    let a = null, b = null, locked = false;
    el.innerHTML = gridWrap(spec) + `<div class="pnote"></div>`;
    const box = el.firstChild, note = el.lastChild;
    const rect = () => (a && b ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] : null);
    const render = () => {
      const R = rect();
      let s = "";
      for (let r = 0; r < spec.grid.length; r++) for (let c = 0; c < spec.grid[0].length; c++) {
        const on = R ? r >= R[0] && r <= R[2] && c >= R[1] && c <= R[3] : a && a[0] === r && a[1] === c;
        s += gridCell(spec, r, c, on ? "on" : "", locked ? "disabled" : "");
      }
      box.innerHTML = s;
      note.textContent = !a ? "Tap one corner of the rectangle." : !b ? "Now tap the opposite corner." : `${R[2] - R[0] + 1} × ${R[3] - R[1] + 1} rectangle`;
    };
    C.onPick(box, "data-rc", (v) => { if (locked) return; const p = v.split(",").map(Number); if (!a || b) { a = p; b = null; } else b = p; render(); onChange(); });
    render();
    return { get: rect, set: (x) => { a = [x[0], x[1]]; b = [x[2], x[3]]; render(); }, clear: () => { a = b = null; render(); }, lock: () => { locked = true; render(); } };
  };

  W.gorder = (el, spec, onChange) => {
    let seq = [], locked = false;
    const need = spec.len;
    el.innerHTML = gridWrap(spec) + `<div class="actions"><button type="button" class="btn ghost undo">Undo</button><button type="button" class="btn ghost clr">Clear</button></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.querySelector(".pnote");
    const pos = (r, c) => seq.findIndex(([y, x]) => y === r && x === c);
    const render = () => {
      let s = "";
      for (let r = 0; r < spec.grid.length; r++) for (let c = 0; c < spec.grid[0].length; c++) { const i = pos(r, c); s += gridCell(spec, r, c, i >= 0 ? "on ordered" : "", `${locked ? "disabled" : ""} data-ord="${i >= 0 ? i + 1 : ""}"`); }
      box.innerHTML = s;
      note.textContent = `${seq.length}${need ? "/" + need : ""} cells in order`;
    };
    C.onPick(box, "data-rc", (v) => { if (locked) return; const p = v.split(",").map(Number); if (pos(...p) >= 0 && !spec.repeat) return; if (need && seq.length >= need) return; seq.push(p); render(); onChange(); });
    el.querySelector(".undo").addEventListener("click", () => { if (!locked) { seq.pop(); render(); onChange(); } });
    el.querySelector(".clr").addEventListener("click", () => { if (!locked) { seq = []; render(); onChange(); } });
    render();
    return { get: () => (need && seq.length !== need ? null : seq.map((x) => x.slice())), set: (a) => { seq = a.map((x) => x.slice()); render(); }, clear: () => { seq = []; render(); }, lock: () => { locked = true; render(); } };
  };

  /* ----- graphs and trees ----- */
  const graphOpts = (spec, extra) => ({ weights: spec.weights, directed: spec.directed, label: spec.label || (spec.labels ? (i) => spec.labels[i] : undefined), r: spec.r, aria: spec.aria, under: spec.under, ...extra });

  W.npath = (el, spec, onChange) => {
    let path = spec.start != null ? [spec.start] : [], locked = false;
    el.innerHTML = `<div class="figure camp-fig"></div><div class="actions"><button type="button" class="btn ghost undo">Undo step</button><button type="button" class="btn ghost clr">Clear</button></div><div class="pnote"></div>`;
    const fig = el.firstChild, note = el.querySelector(".pnote"), A = C.adj(spec.G, spec.directed);
    const usedEdge = (e) => { for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i]; if ((e.u === a && e.v === b) || (!spec.directed && e.u === b && e.v === a)) return true; } return false; };
    const render = () => {
      fig.innerHTML = C.svgGraph(spec.G, graphOpts(spec, {
        pickNodes: !locked,
        nodeClass: (i) => (i === path[path.length - 1] ? "head" : path.includes(i) ? "on" : "") + (i === spec.start ? " src" : i === spec.end ? " dst" : "") + (spec.nodeClass ? " " + spec.nodeClass(i) : ""),
        edgeClass: (e) => (usedEdge(e) ? "on" : ""),
      }));
      note.innerHTML = path.length ? `Path: <b>${path.map((v) => esc(spec.labels ? spec.labels[v] : U.letters[v])).join(" → ")}</b>${spec.pathNote ? " · " + spec.pathNote(path) : ""}` : "Tap a starting node.";
    };
    C.onPick(fig, "data-node", (v) => {
      if (locked) return;
      const u = +v;
      if (!path.length) { path = [u]; render(); onChange(); return; }
      const i = path.lastIndexOf(u);
      if (!spec.walk && i >= 0) { path.length = i + 1; render(); onChange(); return; }
      if (!A[path[path.length - 1]].some((x) => x.v === u)) return;
      if (spec.closed && u === path[0] && path.length >= 3) { path.push(u); render(); onChange(); return; }
      if (!spec.walk && i >= 0) return;
      path.push(u); render(); onChange();
    });
    el.querySelector(".undo").addEventListener("click", () => { if (!locked && path.length > (spec.start != null ? 1 : 0)) { path.pop(); render(); onChange(); } });
    el.querySelector(".clr").addEventListener("click", () => { if (!locked) { path = spec.start != null ? [spec.start] : []; render(); onChange(); } });
    render();
    return { get: () => (path.length < 2 ? null : path.slice()), set: (a) => { path = a.slice(); render(); }, clear: () => { path = spec.start != null ? [spec.start] : []; render(); }, lock: () => { locked = true; render(); } };
  };

  W.nodes = (el, spec, onChange) => {
    let sel = new Set(), locked = false;
    el.innerHTML = `<div class="figure camp-fig"></div><div class="pnote"></div>`;
    const fig = el.firstChild, note = el.lastChild;
    const render = () => {
      fig.innerHTML = C.svgGraph(spec.G, graphOpts(spec, { pickNodes: !locked, nodeClass: (i) => (sel.has(i) ? "head" : "") + (spec.nodeClass ? " " + spec.nodeClass(i) : "") }));
      note.textContent = spec.k === 1 ? "" : `${sel.size} selected${spec.k ? ` (pick ${spec.k})` : ""}`;
    };
    C.onPick(fig, "data-node", (v) => {
      if (locked) return;
      const i = +v;
      if (spec.k === 1) sel = new Set(sel.has(i) ? [] : [i]);
      else if (sel.has(i)) sel.delete(i);
      else { if (spec.k && sel.size >= spec.k) return; sel.add(i); }
      render(); onChange();
    });
    render();
    return { get: () => (spec.k && sel.size !== spec.k ? null : [...sel].sort((a, b) => a - b)), set: (a) => { sel = new Set(a); render(); }, clear: () => { sel = new Set(); render(); }, lock: () => { locked = true; render(); } };
  };

  W.edges = (el, spec, onChange) => {
    let sel = new Set(), locked = false;
    el.innerHTML = `<div class="figure camp-fig"></div><div class="pnote"></div>`;
    const fig = el.firstChild, note = el.lastChild;
    const render = () => {
      fig.innerHTML = C.svgGraph(spec.G, graphOpts(spec, { pickEdges: !locked, edgeClass: (e, k) => (sel.has(k) ? "on" : ""), nodeClass: spec.nodeClass }));
      note.textContent = `${sel.size} edge${sel.size === 1 ? "" : "s"} selected` + (spec.weights ? ` · total ${[...sel].reduce((s, k) => s + spec.G.edges[k].w, 0)}` : "");
    };
    C.onPick(fig, "data-edge", (v) => { if (locked) return; const k = +v; if (sel.has(k)) sel.delete(k); else { if (spec.k && sel.size >= spec.k) return; sel.add(k); } render(); onChange(); });
    render();
    return { get: () => (spec.k && sel.size !== spec.k ? null : [...sel].sort((a, b) => a - b)), set: (a) => { sel = new Set(a); render(); }, clear: () => { sel = new Set(); render(); }, lock: () => { locked = true; render(); } };
  };

  W.ncolor = (el, spec, onChange) => {
    let col = Array(spec.G.n).fill(-1), pen = 0, locked = false;
    const names = spec.names || U.range(spec.k).map((k) => String(k + 1));
    el.innerHTML = `<div class="palette">${names.map((nm, k) => `<button type="button" class="gswatch" data-c="${k}" style="--sw:${GROUP_COLORS[k % 8]}">${esc(nm)}</button>`).join("")}</div><div class="figure camp-fig"></div><div class="pnote"></div>`;
    const pal = el.querySelector(".palette"), fig = el.querySelector(".figure"), note = el.querySelector(".pnote");
    const render = () => {
      pal.querySelectorAll(".gswatch").forEach((b) => b.classList.toggle("on", +b.dataset.c === pen));
      fig.innerHTML = C.svgGraph(spec.G, graphOpts(spec, { pickNodes: !locked, nodeClass: (v) => (col[v] >= 0 ? "paint" : "") }));
      fig.querySelectorAll(".node.paint").forEach((g) => { g.querySelector("circle").style.fill = GROUP_COLORS[col[+g.dataset.node] % 8]; });
      note.textContent = `${col.filter((x) => x < 0).length} uncoloured`;
    };
    pal.addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (b) { pen = +b.dataset.c; render(); } });
    C.onPick(fig, "data-node", (v) => { if (locked) return; const i = +v; col[i] = col[i] === pen ? -1 : pen; render(); onChange(); });
    render();
    return { get: () => (col.some((x) => x < 0) ? null : col.slice()), set: (a) => { col = a.slice(); render(); }, clear: () => { col = col.map(() => -1); render(); }, lock: () => { locked = true; render(); } };
  };

  /* ----- interactive search widgets: they submit by themselves ----- */
  W.probe = (el, spec, onChange, host) => {
    const shown = new Set(); let mode = "reveal", locked = false, probes = 0;
    const slots = spec.items.length + (spec.extra ? spec.extra.length : 0);
    el.innerHTML = `<div class="pstrip probe${spec.cols ? " pgridlike" : ""}"${spec.cols ? ` style="--pc:${spec.cols}"` : ""}></div><div class="actions"><button type="button" class="btn ghost mode">I know the answer →</button><span class="muted small pinfo"></span></div><div class="pnote"></div>`;
    const box = el.firstChild, info = el.querySelector(".pinfo"), mbtn = el.querySelector(".mode"), note = el.querySelector(".pnote");
    const render = () => {
      box.innerHTML = spec.items.map((v, i) => `<button type="button" class="pi tiles${shown.has(i) ? " shown" : ""}${mode === "answer" ? " answering" : ""}" data-i="${i}" ${locked ? "disabled" : ""}><span class="pv">${shown.has(i) || locked ? esc(spec.show ? spec.show(v, i) : v) : "?"}</span><span class="ps">${i}</span></button>`).join("") +
        (spec.extra || []).map((lab, k) => `<button type="button" class="pi tiles extra${mode === "answer" ? " answering" : ""}" data-i="${spec.items.length + k}" ${locked || mode !== "answer" ? "disabled" : ""}><span class="pv">${esc(lab)}</span></button>`).join("");
      info.textContent = `${probes} reveal${probes === 1 ? "" : "s"} used · budget ${spec.budget}`;
      mbtn.textContent = mode === "answer" ? "← Back to revealing" : "I know the answer →";
      note.textContent = mode === "answer" ? spec.answerNote || "Tap the answer." : spec.revealNote || "Tap a card to reveal it.";
    };
    C.onPick(box, "data-i", (v) => {
      if (locked) return;
      const i = +v;
      if (mode === "answer") { host.submit(i); return; }
      if (i >= spec.items.length || shown.has(i)) return;
      shown.add(i); probes++; render(); onChange();
    });
    mbtn.addEventListener("click", () => { mode = mode === "answer" ? "reveal" : "answer"; render(); });
    render();
    void slots;
    return { get: () => null, set: (a) => { host.lastAnswer = a; }, clear: () => {}, lock: () => { locked = true; render(); }, penalty: () => (probes <= spec.budget ? 0 : probes <= spec.budget + 1 ? 1 : 2), selfSubmit: true, probes: () => probes, reveal: (i) => { shown.add(i); probes++; render(); } };
  };

  W.oracle = (el, spec, onChange, host) => {
    let tests = 0, locked = false;
    el.innerHTML = `<div class="numbox"><input type="number" inputmode="numeric" class="numin" aria-label="Number to test"><button type="button" class="btn test">Test</button><button type="button" class="btn primary sub">Submit as answer</button></div><div class="muted small pinfo"></div><ol class="log olog"></ol>`;
    const inp = el.querySelector("input"), log = el.querySelector(".olog"), info = el.querySelector(".pinfo");
    const render = () => { info.textContent = `${tests} test${tests === 1 ? "" : "s"} used · budget ${spec.budget} · answer is between ${spec.lo} and ${spec.hi}`; };
    const val = () => (inp.value.trim() === "" ? null : Math.round(Number(inp.value)));
    el.querySelector(".test").addEventListener("click", () => { if (locked) return; const x = val(); if (x == null) return; tests++; log.insertAdjacentHTML("afterbegin", `<li><b>${x}</b>: ${spec.ask(x)}</li>`); render(); onChange(); });
    el.querySelector(".sub").addEventListener("click", () => { if (locked) return; const x = val(); if (x != null) host.submit(x); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.querySelector(".test").click(); } });
    render();
    return { get: () => null, set: (v) => { inp.value = String(v); }, clear: () => {}, lock: () => { locked = true; inp.disabled = true; el.querySelectorAll("button").forEach((b) => (b.disabled = true)); }, penalty: () => (tests <= spec.budget ? 0 : tests <= spec.budget + 2 ? 1 : 2), selfSubmit: true, test: (x) => { inp.value = String(x); el.querySelector(".test").click(); } };
  };

  /* ----- operation puzzles: apply moves to a state until it's solved; graded on the number of moves ----- */
  // spec: { start, arity, apply(state, taps) -> next | null, done(state), label?(v,i), style?, note?(state) }
  W.ops = (el, spec, onChange, host) => {
    let state = spec.start.slice(), moves = [], taps = [], hist = [], locked = false;
    el.innerHTML = `<div class="pstrip opsstrip"></div><div class="actions"><button type="button" class="btn ghost undo">Undo move</button><button type="button" class="btn ghost rst">Restart</button></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.querySelector(".pnote");
    const render = () => {
      const view = { ...spec, items: state.map((v, i) => (spec.label ? spec.label(v, i) : v)) };
      box.innerHTML = state.map((_, i) => stripHTML(view, i, (taps.includes(i) ? "on" : "") + (spec.home && spec.home(state, i) ? " hl" : ""), locked ? "disabled" : "")).join("") + (spec.endSlot ? `<button type="button" class="pi tiles extra" data-i="${state.length}" ${locked ? "disabled" : ""}><span class="pv">end</span></button>` : "");
      note.textContent = `${moves.length} move${moves.length === 1 ? "" : "s"}` + (taps.length ? ` · ${spec.tapNote ? spec.tapNote(taps) : "choose the next position"}` : spec.hintNote ? " · " + spec.hintNote : "");
    };
    C.onPick(box, "data-i", (v) => {
      if (locked) return;
      const i = +v;
      if (taps.length && taps[taps.length - 1] === i && spec.arity > 1) { taps.pop(); render(); return; }
      taps.push(i);
      if (taps.length < spec.arity) { render(); return; }
      const nx = spec.apply(state, taps);
      const mv = taps; taps = [];
      if (!nx) { host.say && host.say(spec.illegal || "That move isn't allowed."); render(); return; }
      hist.push(state); state = nx; moves.push(mv); render(); onChange();
      if (spec.done(state)) host.submit(moves.map((m) => m.slice()));
    });
    el.querySelector(".undo").addEventListener("click", () => { if (!locked && hist.length) { state = hist.pop(); moves.pop(); taps = []; render(); } });
    el.querySelector(".rst").addEventListener("click", () => { if (!locked) { state = spec.start.slice(); moves = []; hist = []; taps = []; render(); } });
    render();
    return { get: () => null, set: (a) => { state = spec.start.slice(); a.forEach((m) => (state = spec.apply(state, m) || state)); moves = a.map((m) => m.slice()); render(); }, clear: () => {}, lock: () => { locked = true; render(); }, selfSubmit: true };
  };
  // Breadth-first search over states; returns a shortest move list or null.
  PB.bfsMoves = function (start, next, isGoal, key = (s) => s.join(","), limit = 400000) {
    const k0 = key(start);
    if (isGoal(start)) return [];
    const prev = new Map([[k0, null]]);
    let q = [start], seen = 1;
    while (q.length) {
      const nq = [];
      for (const s of q) for (const [m, t] of next(s)) {
        const k = key(t);
        if (prev.has(k)) continue;
        prev.set(k, [key(s), m]);
        if (isGoal(t)) { const path = []; for (let x = k; prev.get(x); x = prev.get(x)[0]) path.unshift(prev.get(x)[1]); return path; }
        nq.push(t);
        if (++seen > limit) return null;
      }
      q = nq;
    }
    return null;
  };
  // Grade an operation puzzle: replay the moves, require a solved end state, minimise the count.
  PB.opsProblem = (o) => ({
    w: "ops", sense: "min", vname: "moves:",
    valid: (I, moves) => { const sp = o.spec(I); let st = sp.start.slice(); for (const m of moves) { st = sp.apply(st, m); if (!st) return "an illegal move"; } return sp.done(st) || "it isn't solved"; },
    val: (I, moves) => moves.length,
    solve: (I) => { const sp = o.spec(I); return PB.bfsMoves(sp.start, (s) => sp.moves(s).map((m) => [m, sp.apply(s, m)]).filter((x) => x[1]), sp.done); },
    ui: (I) => o.spec(I),
    ...o,
  });

  /* ================= Progress ================= */
  PB.prog = D.store.get("pb", {});
  PB.starsFor = (id, lv) => ((PB.prog[id] || [])[lv - 1] || 0);
  PB.solvedLevels = () => Object.values(PB.prog).reduce((s, a) => s + a.filter((x) => x > 0).length, 0);
  PB.totalStars = () => Object.values(PB.prog).reduce((s, a) => s + a.reduce((x, y) => x + Math.max(0, y || 0), 0), 0);
  PB.record = function (id, lv, stars) {
    const a = (PB.prog[id] = PB.prog[id] || [0, 0, 0]);
    const before = Math.max(0, a[lv - 1] || 0);
    let xp = 0;
    if (stars > before) { a[lv - 1] = stars; xp = (stars - before) * 5 * lv; D.progress.data.xp += xp; D.progress.save(); }
    else if (stars < 0 && !a[lv - 1]) a[lv - 1] = -1;
    D.store.set("pb", PB.prog);
    return xp;
  };
  const starStr = (n) => "★".repeat(Math.max(0, n)) + "☆".repeat(3 - Math.max(0, n));

  /* ================= Screens ================= */
  /* The technique stays hidden until a level of the problem is solved. */
  const solvedAny = (id) => [1, 2, 3].some((k) => PB.starsFor(id, k) > 0);
  const metaHTML = (p, open) => `<span class="tag">${esc(PB.CATS.find((c) => c.id === p.cat).name)}</span>${open && p.tags ? `<span class="kind">${esc(PB.familyOf(p).name)} · ${esc(p.tags)}</span>` : `<span class="kind muted">Technique revealed when solved</span>`}`;
  function algoCard(p, here) {
    const f = PB.familyOf(p);
    return `<div class="algo-card">
      <div class="algo-head"><span class="eyebrow">Algorithm type</span><b>${esc(f.name)}</b>${p.tags ? `<span class="algo-tags">${esc(p.tags)}</span>` : ""}</div>
      <p class="algo-how"><b>How it works.</b> ${f.how}</p>
      ${here ? `<div class="algo-here"><span class="eyebrow">In this problem</span>${/^\s*</.test(here) ? here : `<p>${here}</p>`}</div>` : ""}
    </div>`;
  }
  PB._algoCard = algoCard;

  function mount(root, cfg) {
    const ci = (p) => PB.CATS.findIndex((c) => c.id === p.cat);
    PB.list.sort((a, b) => ci(a) - ci(b));
    let ctrl = null;
    const clear = () => { if (ctrl && ctrl.destroy) ctrl.destroy(); ctrl = null; PB._current = null; };
    let filter = { q: "", cat: D.store.get("pb-cat", "all"), status: "all" };

    function catalog(focusId) {
      clear();
      const total = PB.list.length;
      root.innerHTML = `
        <div class="camp">
          <div class="camp-head">
            <button class="btn ghost back" type="button">← All games</button>
            <div class="camp-title"><div class="eyebrow">Problem Set</div><h2>${total.toLocaleString()} problems · ${(total * 3).toLocaleString()} levels</h2></div>
            <div class="stats">
              <div class="stat"><span>Levels solved</span><b>${PB.solvedLevels()}<small>/${total * 3}</small></b></div>
              <div class="stat"><span>Stars</span><b>${PB.totalStars()}<small>/${total * 9}</small></b></div>
            </div>
          </div>
          <p class="lede">Every problem is a real algorithmic task you solve with your hands: select, cut, order, trace or build the answer. Each has an Easy, Medium and Hard level. The checker finds the true optimum by exhaustive search, so any optimal answer counts.</p>
          <div class="pb-filters">
            <input type="search" class="pb-q" id="pb-q" placeholder="Search problems (techniques of solved ones too)…" value="${esc(filter.q)}" aria-label="Search problems">
            <select class="pb-status" id="pb-status" aria-label="Filter by status">
              <option value="all">All problems</option><option value="todo">Not started</option><option value="part">In progress</option><option value="done">All 3 solved</option>
            </select>
          </div>
          <div class="pb-cats"><button type="button" class="chipf" data-cat="all">All</button>${PB.CATS.map((c) => { const n = PB.list.filter((p) => p.cat === c.id).length; return n ? `<button type="button" class="chipf" data-cat="${c.id}">${esc(c.name)} <small>${n}</small></button>` : ""; }).join("")}</div>
          <div class="pb-list"></div>
        </div>`;
      root.querySelector(".pb-status").value = filter.status;
      root.querySelector(".back").addEventListener("click", () => cfg.exit());
      const listEl = root.querySelector(".pb-list");
      const draw = () => {
        root.querySelectorAll(".chipf").forEach((b) => b.classList.toggle("on", b.dataset.cat === filter.cat));
        const q = filter.q.trim().toLowerCase();
        const ok = (p) => {
          if (filter.cat !== "all" && p.cat !== filter.cat) return false;
          if (q && !(`${p.name} ${p.cat} ${solvedAny(p.id) ? `${p.tags || ""} ${PB.familyOf(p).name}` : ""}`.toLowerCase().includes(q))) return false;
          const s = [1, 2, 3].map((lv) => PB.starsFor(p.id, lv) > 0).filter(Boolean).length;
          if (filter.status === "todo" && s) return false;
          if (filter.status === "part" && (s === 0 || s === 3)) return false;
          if (filter.status === "done" && s !== 3) return false;
          return true;
        };
        let html = "", shown = 0;
        PB.CATS.forEach((c) => {
          const ps = PB.list.filter((p) => p.cat === c.id && ok(p));
          if (!ps.length) return;
          shown += ps.length;
          html += `<section class="pb-sec"><h3>${esc(c.name)} <span class="muted small">${ps.length}</span></h3><div class="pb-rows">${ps.map((p) => {
            const st = [1, 2, 3].map((lv) => PB.starsFor(p.id, lv));
            return `<button type="button" class="pb-row" data-id="${p.id}"><span class="pb-num">${PB.list.indexOf(p) + 1}</span><span class="pb-name">${esc(p.name)}</span><span class="pb-tags">${solvedAny(p.id) ? esc(`${PB.familyOf(p).name} · ${p.tags || ""}`) : "Technique hidden until solved"}</span><span class="pb-lv">${st.map((s, k) => `<i class="lvdot lv${k + 1}${s > 0 ? " done" : s < 0 ? " rev" : ""}" title="${PB.LV[k]}${s > 0 ? ": " + s + "★" : ""}"></i>`).join("")}</span></button>`;
          }).join("")}</div></section>`;
        });
        listEl.innerHTML = html || `<p class="muted">No problems match.</p>`;
        void shown;
      };
      root.querySelector(".pb-q").addEventListener("input", (e) => { filter.q = e.target.value; draw(); });
      root.querySelector(".pb-status").addEventListener("change", (e) => { filter.status = e.target.value; draw(); });
      root.querySelector(".pb-cats").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (b) { filter.cat = b.dataset.cat; D.store.set("pb-cat", filter.cat); draw(); } });
      listEl.addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) problem(b.dataset.id); });
      draw();
      if (focusId) { const el = root.querySelector(`[data-id="${focusId}"]`); if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "center" }); } }
      else window.scrollTo(0, 0);
    }

    function nextLevelOf(id) {
      const p = PB.byId.get(id);
      for (let lv = 1; lv <= 3; lv++) if (PB.starsFor(id, lv) <= 0) return lv;
      void p;
      return 1;
    }

    function problem(id, lv) {
      clear();
      const p = PB.byId.get(id);
      lv = lv || nextLevelOf(id);
      const idx = PB.list.indexOf(p);
      let L;
      try { L = PB.level(p, lv); } catch (e) { root.innerHTML = `<p class="lose">Couldn't build this level: ${esc(e.message)}</p>`; return; }
      const world = L.world;
      const goal = world ? L.P.goal : typeof p.text === "function" ? p.text(L.I) : p.text;
      root.innerHTML = `
        <div class="game camp-level">
          <div class="game-top">
            <button class="btn ghost back" type="button">← Problem list</button>
            <div class="game-title"><h2><span class="muted">#${idx + 1}</span> ${esc(p.name)}</h2></div>
            <div class="stats camp-stats"></div>
          </div>
          <div class="lvtabs" role="tablist" aria-label="Level">${[1, 2, 3].map((k) => `<button type="button" role="tab" class="lvtab lvl-${k}${k === lv ? " on" : ""}" aria-selected="${k === lv}" data-lv="${k}">${PB.LV[k - 1]} <span>${PB.starsFor(id, k) > 0 ? starStr(PB.starsFor(id, k)) : PB.starsFor(id, k) < 0 ? "revealed" : ""}</span></button>`).join("")}</div>
          <div class="q">
            <div class="q-meta">${metaHTML(p, solvedAny(id))}</div>
            <div class="prompt camp-goal">${goal}</div>
            <div class="camp-stage"></div>
            <div class="feedback camp-say" role="status" hidden></div>
            <div class="actions camp-tools">
              ${world ? `<button class="btn ghost restart" type="button">Restart</button>` : `<button class="btn primary check" type="button">Check answer</button><button class="btn ghost reset" type="button">Clear</button><button class="btn ghost reveal" type="button" hidden>Show solution</button>`}
              <details class="strategy"><summary class="btn ghost">Hint</summary><div class="strategy-body">${p.hint || (world && world.hint) || PB.CAT_HINTS[p.cat] || "Try a small case by hand first."}</div></details>
            </div>
            <div class="camp-result" hidden></div>
          </div>
        </div>`;
      const $ = (s) => root.querySelector(s);
      $(".back").addEventListener("click", () => catalog(id));
      root.querySelectorAll(".lvtab").forEach((b) => b.addEventListener("click", () => problem(id, +b.dataset.lv)));
      let finished = false, fails = 0;

      const say = (html, kind) => { const el = $(".camp-say"); el.hidden = !html; el.innerHTML = html ? `<p class="${kind || ""}">${html}</p>` : ""; };
      function finish(won, stars, text, revealed) {
        if (finished) return;
        finished = true;
        PB._lastResult = { won, stars, id, lv, revealed: !!revealed };
        say("");
        $(".camp-tools").hidden = true;
        const xp = won ? PB.record(id, lv, stars) : revealed ? PB.record(id, lv, -1) : 0;
        const res = $(".camp-result");
        const nextLv = lv < 3 ? lv + 1 : null, nextP = PB.list[idx + 1];
        res.hidden = false;
        res.innerHTML = `<div class="result-banner ${won ? "win" : "lose"}">${won ? `<div class="big-stars" aria-label="${stars} of 3 stars">${starStr(stars)}</div><div><b>Solved!</b> ${xp ? `+${xp} XP.` : ""}</div>` : revealed ? `<b>Here's a solution.</b>` : `<b>Not this time.</b>`}</div>
          ${world && text ? `<div class="learned">${text}</div>` : ""}
          ${won || revealed ? algoCard(p, world ? world.lesson : text) : !world && text ? `<div class="learned">${text}</div>` : ""}
          <div class="actions">
            ${nextLv ? `<button class="btn primary nextlv" type="button">${PB.LV[nextLv - 1]} level →</button>` : nextP ? `<button class="btn primary nextp" type="button">Next problem →</button>` : ""}
            ${nextLv && nextP ? `<button class="btn nextp" type="button">Next problem</button>` : ""}
            <button class="btn ghost replay" type="button">Try again</button>
            <button class="btn ghost list" type="button">Problem list</button>
          </div>`;
        if (won) $(".q-meta").innerHTML = metaHTML(p, true);
        res.querySelectorAll(".nextlv").forEach((b) => b.addEventListener("click", () => problem(id, nextLv)));
        res.querySelectorAll(".nextp").forEach((b) => b.addEventListener("click", () => problem(nextP.id, 1)));
        res.querySelector(".replay").addEventListener("click", () => problem(id, lv));
        res.querySelector(".list").addEventListener("click", () => catalog(id));
        (res.querySelector(".nextlv, .nextp") || res.querySelector(".replay")).focus({ preventScroll: true });
        res.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }

      const stage = $(".camp-stage");
      if (world) {
        const api = {
          L: world.id, tier: C.tierOf(p.levels[lv - 1]), P: L.P,
          stats(list) { $(".camp-stats").innerHTML = list.map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${v}</b></div>`).join(""); },
          say,
          win({ stars = 3, text = "" } = {}) { finish(true, stars, text); },
          lose(text) { finish(false, 0, text); },
          get over() { return finished; },
        };
        const start = () => { if (ctrl && ctrl.destroy) ctrl.destroy(); finished = false; $(".camp-result").hidden = true; $(".camp-tools").hidden = false; say(""); stage.innerHTML = ""; ctrl = world.view(stage, L.P, api) || {}; PB._current = { L, ctrl, api }; };
        $(".restart").addEventListener("click", start);
        start();
      } else {
        const why = () => (p.why ? p.why(L.I, L.sol, L.best) : "");
        const host = {
          say,
          submit(a) {
            if (finished) return;
            const g = PB.grade(L, a);
            if (g.ok) {
              const pen = widget.penalty ? widget.penalty() : 0;
              return finish(true, Math.max(1, 3 - Math.min(fails, 2) - pen), why());
            }
            fails++;
            say(g.msg, "lose");
            if (fails >= 2) $(".reveal").hidden = false;
          },
        };
        const widget = W[p.w](stage, L.spec, () => { if (!finished) say(""); }, host);
        PB._current = { L, widget, host };
        stage.addEventListener("pb-submit", () => $(".check").click());
        if (widget.selfSubmit) { $(".check").hidden = true; $(".reset").hidden = true; }
        $(".check").addEventListener("click", () => {
          const a = widget.get();
          if (a == null) { say(PB.grade(L, null).msg); return; }
          host.submit(a);
        });
        $(".reset").addEventListener("click", () => { widget.clear(); say(""); });
        $(".reveal").addEventListener("click", () => {
          widget.set(L.sol); widget.lock();
          const shownAns = p.show ? p.show(L.I, L.sol) : "";
          finish(false, 0, (shownAns ? shownAns + "<br>" : "") + why(), true);
        });
        // a reveal button also appears for the self-submitting widgets after two misses
        $(".camp-stats").innerHTML = `<div class="stat"><span>Level</span><b>${PB.LV[lv - 1]}</b></div><div class="stat"><span>Best</span><b>${PB.starsFor(id, lv) > 0 ? starStr(PB.starsFor(id, lv)) : "–"}</b></div>`;
      }
      window.scrollTo(0, 0);
    }

    PB._app = { catalog, problem };
    if (cfg.startProblem && PB.byId.has(cfg.startProblem)) problem(cfg.startProblem);
    else catalog();
    return { destroy: clear };
  }

  D.registerMode({
    id: "problems",
    name: "Problem Set",
    group: "Puzzles",
    topic: "1,000 problems",
    blurb: "1,000 different algorithm problems, each with an Easy, Medium and Hard level. Solve them hands-on.",
    custom: true,
    noBadges: true,
    featured: true,
    footer: () => `${PB.solvedLevels()}/${PB.list.length * 3} levels · ${PB.totalStars()}★`,
    mount,
  });
})();
