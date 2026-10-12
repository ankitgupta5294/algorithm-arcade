/* Systems Lab answer widgets (registered alongside the Problem Set widgets in PB.widgets).
   Every widget: (el, spec, onChange, host) -> { get, set, clear, lock, peek?, penalty?, selfSubmit? }
     term        simulated terminal; answer { log: [commands], pick? }        spec: init, run, motd, cmds, par, opts, optq, prompt, doneLabel
     tune        knobs (segmented / select / slider); answer {key: value}      spec: knobs [{k, label, opts | min,max,step, unit, fmt, help}], init
     interleave  build a schedule from lanes; answer [lane index per step]     spec: lanes [{name, steps}]
     code        text editor; answer string                                   spec: lang, starter, rows, ph
     lines       flag lines in a diff / file; answer sorted line indexes      spec: lines [{t, k:'+'|'-'|' '|'@'}] or src, file, k
     select      choose cards; answer sorted indexes                          spec: opts, k?, html?
     steps       pick and order steps; answer [indexes in order]             spec: opts, len?, html?
     classify    put each item in a category; answer [category per item]     spec: items, cats, html?
     topo        toggle nodes/links of a topology; answer {down:[], cut:[]}   spec: nodes [{label, x, y, sub?}], links [[a,b,label?]], mode 'nodes'|'links'|'both', k?
   spec.live(answer-or-partial) may return HTML, shown under the widget and refreshed on every change. */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign, PB = D.pb, LB = D.lab, K = LB.k;
  const esc = U.esc, W = PB.widgets;
  const show = (spec, x) => (spec.html ? x : esc(x));

  /* ---------- terminal ---------- */
  W.term = (el, spec, onChange, host) => {
    let st, log, hist = [], hpos = 0, pick = null, locked = false, danger = 0;
    el.innerHTML = `<div class="term">
        <div class="term-out" tabindex="0" aria-live="polite" aria-label="Terminal output"></div>
        <form class="term-in"><span class="term-ps">${esc(spec.prompt || "$")}</span><input class="term-line" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" aria-label="Command"><button type="submit" class="btn small term-run">Run</button></form>
      </div>
      ${spec.cmds && spec.cmds.length ? `<div class="term-chips"><span class="muted small">Commands:</span>${spec.cmds.map((c, i) => `<button type="button" class="chip-btn mono" data-c="${i}">${esc(c)}</button>`).join("")}</div>` : ""}
      ${spec.opts ? `<div class="term-q"><div class="eyebrow">${esc(spec.optq || "Root cause")}</div><div class="opts one-col"></div></div>` : ""}
      <div class="actions"><button type="button" class="btn primary term-done">${esc(spec.doneLabel || (spec.opts ? "Submit diagnosis" : "Mark resolved"))}</button><span class="muted small term-info"></span></div>`;
    const out = el.querySelector(".term-out"), inp = el.querySelector(".term-line"), info = el.querySelector(".term-info"), optsEl = el.querySelector(".term-q .opts");
    const print = (html) => { out.insertAdjacentHTML("beforeend", html); out.scrollTop = out.scrollHeight; };
    const counted = () => log.length;
    const answer = () => (spec.opts ? { log: log.slice(), pick } : { log: log.slice() });
    const renderInfo = () => { info.textContent = `${counted()} command${counted() === 1 ? "" : "s"}${spec.par ? ` · par ${spec.par}` : ""}${danger ? ` · ${danger} risky` : ""}`; };
    const renderOpts = () => { if (optsEl) optsEl.innerHTML = spec.opts.map((o, k) => `<button type="button" class="opt${pick === k ? " right" : ""}" data-k="${k}" ${locked ? "disabled" : ""}><span>${esc(o)}</span></button>`).join(""); };
    const reset = () => {
      st = K.clone(spec.init || {}); log = []; danger = 0; pick = null;
      out.innerHTML = spec.motd ? `<div class="term-motd">${esc(spec.motd)}</div>` : "";
      renderInfo(); renderOpts();
    };
    const exec = (line, quiet) => {
      const r0 = spec.run(line, st) || {};
      const r = typeof r0 === "string" ? { out: r0 } : r0;
      if (r.clear) { out.innerHTML = ""; return; }
      if (!r.silent) log.push(line);
      if (r.danger) danger++;
      if (!quiet || true) print(`<div class="term-cmd"><span class="term-ps">${esc(spec.prompt || "$")}</span> ${esc(line)}</div>${r.out ? `<pre class="term-res">${esc(r.out)}</pre>` : ""}${r.danger ? `<div class="term-warn">⚠ ${esc(r.danger)}</div>` : ""}`);
    };
    el.querySelector(".term-in").addEventListener("submit", (e) => {
      e.preventDefault();
      if (locked) return;
      const line = inp.value.trim();
      if (!line) return;
      hist.push(line); hpos = hist.length;
      inp.value = "";
      exec(line);
      renderInfo(); onChange();
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" && hist.length) { e.preventDefault(); hpos = Math.max(0, hpos - 1); inp.value = hist[hpos]; }
      else if (e.key === "ArrowDown" && hist.length) { e.preventDefault(); hpos = Math.min(hist.length, hpos + 1); inp.value = hist[hpos] || ""; }
      else if (e.key === "Tab" && spec.cmds) {
        const v = inp.value; const m = spec.cmds.find((c) => c.startsWith(v) && c !== v);
        if (m) { e.preventDefault(); inp.value = m; }
      }
    });
    const chips = el.querySelector(".term-chips");
    if (chips) C.onPick(chips, "data-c", (v) => { if (locked) return; inp.value = spec.cmds[+v]; inp.focus(); const ph = inp.value.search(/<[^>]+>/); if (ph >= 0) inp.setSelectionRange(ph, inp.value.indexOf(">", ph) + 1); });
    if (optsEl) C.onPick(optsEl, "data-k", (v) => { if (locked) return; pick = +v; renderOpts(); onChange(); });
    el.querySelector(".term-done").addEventListener("click", () => {
      if (locked) return;
      if (spec.opts && pick == null) { host.say("Pick the root cause first."); return; }
      host.submit(answer());
    });
    reset();
    return {
      get: answer,
      peek: () => ({ log: log.slice(), pick, st }),
      set: (a) => { reset(); (a.log || []).forEach((l) => exec(l)); pick = a.pick == null ? null : a.pick; renderInfo(); renderOpts(); },
      clear: reset,
      lock: () => { locked = true; inp.disabled = true; el.querySelectorAll("button").forEach((b) => (b.disabled = true)); renderOpts(); },
      penalty: () => {
        const extra = spec.par ? counted() - spec.par : 0;
        return Math.min(2, (extra > 0 ? 1 : 0) + (spec.par && extra > spec.par ? 1 : 0) + danger);
      },
      selfSubmit: true,
    };
  };

  /* ---------- tune: knobs ---------- */
  W.tune = (el, spec, onChange) => {
    const vals = (kb) => LB.knobValues(kb);
    const def = () => { const c = { ...(spec.init || {}) }; spec.knobs.forEach((kb) => { if (kb.fixed != null) c[kb.k] = kb.fixed; else if (c[kb.k] === undefined) c[kb.k] = vals(kb)[0]; }); return c; };
    let cfg = def(), locked = false;
    const fmt = (kb, v) => (kb.fmt ? kb.fmt(v) : String(v)) + (kb.unit ? " " + kb.unit : "");
    el.innerHTML = `<div class="knobs">${spec.knobs.map((kb, i) => `<div class="knob${kb.fixed != null ? " fixed" : ""}" data-i="${i}"><div class="kl"><b>${esc(kb.label)}</b>${kb.help ? `<small class="muted">${kb.help}</small>` : ""}</div><div class="kc"></div></div>`).join("")}</div>`;
    const render = () => {
      el.querySelectorAll(".knob").forEach((row) => {
        const kb = spec.knobs[+row.dataset.i], vs = vals(kb), box = row.querySelector(".kc"), cur = cfg[kb.k];
        if (kb.fixed != null) { box.innerHTML = `<span class="mono">${esc(fmt(kb, kb.fixed))}</span>`; return; }
        if (kb.opts && (kb.opts.length <= 6 || kb.seg) && !kb.select) {
          box.innerHTML = `<div class="seg" role="radiogroup" aria-label="${esc(kb.label)}">${vs.map((v, j) => `<button type="button" role="radio" aria-checked="${LB.same(v, cur)}" class="seg-btn${LB.same(v, cur) ? " on" : ""}" data-j="${j}" ${locked ? "disabled" : ""}>${esc(fmt(kb, v))}</button>`).join("")}</div>`;
        } else if (kb.opts) {
          box.innerHTML = `<select aria-label="${esc(kb.label)}" ${locked ? "disabled" : ""}>${vs.map((v, j) => `<option value="${j}" ${LB.same(v, cur) ? "selected" : ""}>${esc(fmt(kb, v))}</option>`).join("")}</select>`;
        } else {
          const j = Math.max(0, vs.findIndex((v) => v === cur));
          box.innerHTML = `<input type="range" min="0" max="${vs.length - 1}" step="1" value="${j}" aria-label="${esc(kb.label)}" ${locked ? "disabled" : ""}><output class="mono">${esc(fmt(kb, cur))}</output>`;
        }
      });
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".seg-btn"); if (!b || locked) return;
      const kb = spec.knobs[+b.closest(".knob").dataset.i];
      cfg[kb.k] = vals(kb)[+b.dataset.j]; render(); onChange();
    });
    el.addEventListener("change", (e) => {
      const s = e.target.closest("select"); if (!s || locked) return;
      const kb = spec.knobs[+s.closest(".knob").dataset.i];
      cfg[kb.k] = vals(kb)[+s.value]; onChange();
    });
    el.addEventListener("input", (e) => {
      const s = e.target.closest("input[type=range]"); if (!s || locked) return;
      const kb = spec.knobs[+s.closest(".knob").dataset.i];
      cfg[kb.k] = vals(kb)[+s.value]; s.nextElementSibling.textContent = fmt(kb, cfg[kb.k]); onChange();
    });
    render();
    return { get: () => K.clone(cfg), set: (v) => { cfg = { ...def(), ...K.clone(v) }; render(); }, clear: () => { cfg = def(); render(); }, lock: () => { locked = true; render(); } };
  };
  W.form = W.tune;

  /* ---------- interleave: build a schedule from parallel lanes ---------- */
  W.interleave = (el, spec, onChange) => {
    let seq = [], locked = false;
    const n = spec.lanes.length, total = spec.lanes.reduce((s, l) => s + l.steps.length, 0);
    el.innerHTML = `<div class="table-wrap"><table class="sched"><thead><tr><th>#</th>${spec.lanes.map((l) => `<th>${esc(l.name)}</th>`).join("")}</tr></thead><tbody></tbody></table></div><div class="lanes"></div><div class="actions"><button type="button" class="btn ghost undo">Undo</button><button type="button" class="btn ghost clr">Clear</button><span class="muted small pinfo"></span></div>`;
    const tb = el.querySelector("tbody"), lanes = el.querySelector(".lanes"), info = el.querySelector(".pinfo");
    const pos = () => { const c = Array(n).fill(0); seq.forEach((l) => c[l]++); return c; };
    const render = () => {
      const c = Array(n).fill(0);
      tb.innerHTML = seq.map((l, t) => { const s = spec.lanes[l].steps[c[l]++]; return `<tr><td class="muted">${t + 1}</td>${spec.lanes.map((_, j) => `<td class="mono">${j === l ? show(spec, s) : ""}</td>`).join("")}</tr>`; }).join("") || `<tr><td colspan="${n + 1}" class="muted">Run steps from the lanes below to build the schedule.</td></tr>`;
      const p = pos();
      lanes.innerHTML = spec.lanes.map((l, j) => `<button type="button" class="lane-btn" data-l="${j}" ${locked || p[j] >= l.steps.length ? "disabled" : ""}><span class="eyebrow">${esc(l.name)} next</span><span class="mono">${p[j] < l.steps.length ? show(spec, l.steps[p[j]]) : "done"}</span></button>`).join("");
      info.textContent = `${seq.length}/${total} steps scheduled`;
    };
    C.onPick(lanes, "data-l", (v) => { if (locked) return; const l = +v; if (pos()[l] >= spec.lanes[l].steps.length) return; seq.push(l); render(); onChange(); });
    el.querySelector(".undo").addEventListener("click", () => { if (!locked) { seq.pop(); render(); onChange(); } });
    el.querySelector(".clr").addEventListener("click", () => { if (!locked) { seq = []; render(); onChange(); } });
    render();
    return { get: () => (seq.length === total ? seq.slice() : null), peek: () => seq.slice(), set: (a) => { seq = a.slice(); render(); }, clear: () => { seq = []; render(); }, lock: () => { locked = true; render(); el.querySelectorAll(".undo,.clr").forEach((b) => (b.disabled = true)); } };
  };

  /* ---------- code: a plain editor ---------- */
  W.code = (el, spec, onChange) => {
    el.innerHTML = `<div class="code-wrap"><div class="code-bar"><span class="eyebrow">${esc(spec.lang || "text")}</span>${spec.file ? `<span class="mono small">${esc(spec.file)}</span>` : ""}</div><textarea class="code-in" rows="${spec.rows || Math.min(18, Math.max(6, (spec.starter || "").split("\n").length + 2))}" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="${esc(spec.lang || "Code")} editor" placeholder="${esc(spec.ph || "")}"></textarea></div><div class="muted small">Ctrl/⌘ + Enter to check.</div>`;
    const ta = el.querySelector("textarea");
    ta.value = spec.starter || "";
    ta.addEventListener("input", onChange);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText("  ", s, ta.selectionEnd, "end"); onChange(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); el.dispatchEvent(new CustomEvent("pb-submit", { bubbles: true })); }
    });
    return { get: () => (ta.value.trim() ? ta.value : null), peek: () => ta.value, set: (v) => { ta.value = v; }, clear: () => { ta.value = spec.starter || ""; }, lock: () => { ta.readOnly = true; } };
  };

  /* ---------- lines: flag lines of a diff or file ---------- */
  W.lines = (el, spec, onChange) => {
    const L = spec.lines || String(spec.src).split("\n").map((t) => ({ t, k: " " }));
    let sel = new Set(), locked = false;
    el.innerHTML = `<div class="diff">${spec.file ? `<div class="diff-file mono">${esc(spec.file)}</div>` : ""}<div class="diff-body"></div></div><div class="pnote"></div>`;
    const body = el.querySelector(".diff-body"), note = el.querySelector(".pnote");
    let ln = 0;
    const nums = L.map((x) => (x.k === "@" ? "" : x.k === "-" ? "" : ++ln));
    const render = () => {
      body.innerHTML = L.map((x, i) => x.k === "@" ? `<div class="dl hunk mono">${esc(x.t)}</div>` : `<button type="button" class="dl k${x.k === "+" ? "add" : x.k === "-" ? "del" : "ctx"}${sel.has(i) ? " on" : ""}" data-i="${i}" ${locked ? "disabled" : ""}><span class="dn">${nums[i]}</span><span class="ds">${x.k === " " ? "" : esc(x.k)}</span><span class="dt mono">${esc(x.t) || " "}</span>${sel.has(i) ? '<span class="dflag">flagged</span>' : ""}</button>`).join("");
      note.textContent = `${sel.size} line${sel.size === 1 ? "" : "s"} flagged${spec.k ? ` (flag ${spec.k})` : ""}`;
    };
    C.onPick(body, "data-i", (v) => {
      if (locked) return;
      const i = +v;
      if (spec.k === 1) sel = new Set(sel.has(i) ? [] : [i]);
      else if (sel.has(i)) sel.delete(i);
      else { if (spec.k && sel.size >= spec.k) return; sel.add(i); }
      render(); onChange();
    });
    render();
    const out = () => [...sel].sort((a, b) => a - b);
    return { get: () => (!sel.size || (spec.k && sel.size !== spec.k) ? null : out()), peek: out, set: (a) => { sel = new Set(a); render(); }, clear: () => { sel = new Set(); render(); }, lock: () => { locked = true; render(); } };
  };

  /* ---------- select: choose one or more cards ---------- */
  W.select = (el, spec, onChange) => {
    let sel = new Set(), locked = false;
    el.innerHTML = `<div class="lab-cards"></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.lastChild;
    const render = () => {
      box.innerHTML = spec.opts.map((o, i) => `<button type="button" class="card-opt${sel.has(i) ? " on" : ""}" data-i="${i}" aria-pressed="${sel.has(i)}" ${locked ? "disabled" : ""}><span class="cbox">${sel.has(i) ? "✓" : ""}</span><span>${show(spec, o)}</span></button>`).join("");
      note.textContent = spec.k === 1 ? "Choose one." : `${sel.size} selected${spec.k ? ` (choose ${spec.k})` : ""}`;
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
    const out = () => [...sel].sort((a, b) => a - b);
    return { get: () => (spec.k ? (sel.size === spec.k ? out() : null) : sel.size || spec.allowNone ? out() : null), peek: out, set: (a) => { sel = new Set(a); render(); }, clear: () => { sel = new Set(); render(); }, lock: () => { locked = true; render(); } };
  };

  /* ---------- steps: build an ordered plan from a pool (which may include traps) ---------- */
  W.steps = (el, spec, onChange) => {
    let seq = [], locked = false;
    el.innerHTML = `<div class="plan"><div class="eyebrow">Your plan</div><ol class="plan-list"></ol></div><div class="eyebrow">Available steps</div><div class="lab-cards pool"></div><div class="actions"><button type="button" class="btn ghost undo">Undo</button><button type="button" class="btn ghost clr">Clear</button><span class="muted small pinfo"></span></div>`;
    const list = el.querySelector(".plan-list"), pool = el.querySelector(".pool"), info = el.querySelector(".pinfo");
    const render = () => {
      list.innerHTML = seq.map((i, k) => `<li><span>${show(spec, spec.opts[i])}</span><span class="plan-act">${k > 0 ? `<button type="button" class="btn ghost small" data-up="${k}" aria-label="Move up" ${locked ? "disabled" : ""}>↑</button>` : ""}<button type="button" class="btn ghost small" data-rm="${k}" aria-label="Remove" ${locked ? "disabled" : ""}>✕</button></span></li>`).join("") || `<li class="muted empty">Tap steps below in the order you'd run them.</li>`;
      pool.innerHTML = spec.opts.map((o, i) => `<button type="button" class="card-opt${seq.includes(i) ? " used" : ""}" data-i="${i}" ${locked || seq.includes(i) || (spec.len && seq.length >= spec.len) ? "disabled" : ""}><span>${show(spec, o)}</span></button>`).join("");
      info.textContent = spec.len ? `${seq.length}/${spec.len} steps` : `${seq.length} step${seq.length === 1 ? "" : "s"}`;
    };
    C.onPick(pool, "data-i", (v) => { if (locked) return; const i = +v; if (seq.includes(i) || (spec.len && seq.length >= spec.len)) return; seq.push(i); render(); onChange(); });
    list.addEventListener("click", (e) => {
      if (locked) return;
      const up = e.target.closest("[data-up]"), rm = e.target.closest("[data-rm]");
      if (up) { const k = +up.dataset.up; [seq[k - 1], seq[k]] = [seq[k], seq[k - 1]]; }
      else if (rm) seq.splice(+rm.dataset.rm, 1);
      else return;
      render(); onChange();
    });
    el.querySelector(".undo").addEventListener("click", () => { if (!locked) { seq.pop(); render(); onChange(); } });
    el.querySelector(".clr").addEventListener("click", () => { if (!locked) { seq = []; render(); onChange(); } });
    render();
    return { get: () => (!seq.length || (spec.len && seq.length !== spec.len) ? null : seq.slice()), peek: () => seq.slice(), set: (a) => { seq = a.slice(); render(); }, clear: () => { seq = []; render(); }, lock: () => { locked = true; render(); el.querySelectorAll(".undo,.clr").forEach((b) => (b.disabled = true)); } };
  };

  /* ---------- classify: one category per item ---------- */
  W.classify = (el, spec, onChange) => {
    let g = spec.items.map(() => -1), locked = false;
    el.innerHTML = `<div class="classify"></div><div class="pnote"></div>`;
    const box = el.firstChild, note = el.lastChild;
    const render = () => {
      box.innerHTML = spec.items.map((it, i) => `<div class="cl-row"><div class="cl-item">${show(spec, it)}</div><div class="seg" role="radiogroup">${spec.cats.map((c, k) => `<button type="button" role="radio" aria-checked="${g[i] === k}" class="seg-btn${g[i] === k ? " on" : ""}" data-ik="${i},${k}" ${locked ? "disabled" : ""}>${esc(c)}</button>`).join("")}</div></div>`).join("");
      note.textContent = `${g.filter((x) => x < 0).length} left to classify`;
    };
    C.onPick(box, "data-ik", (v) => { if (locked) return; const [i, k] = v.split(",").map(Number); g[i] = g[i] === k ? -1 : k; render(); onChange(); });
    render();
    return { get: () => (g.some((x) => x < 0) ? null : g.slice()), peek: () => g.slice(), set: (a) => { g = a.slice(); render(); }, clear: () => { g = g.map(() => -1); render(); }, lock: () => { locked = true; render(); } };
  };

  /* ---------- topo: toggle components of a topology (fail nodes, cut links) ---------- */
  W.topo = (el, spec, onChange) => {
    const mode = spec.mode || "nodes";
    let down = new Set(), cut = new Set(), locked = false;
    const N = spec.nodes, Lk = spec.links || [];
    const w = spec.W || 640, h = spec.H || 300, bw = spec.bw || 108, bh = 40;
    el.innerHTML = `<div class="figure topo-fig"></div><div class="pnote"></div>`;
    const fig = el.firstChild, note = el.lastChild;
    const render = () => {
      const links = Lk.map(([a, b, lab], i) => {
        const A = N[a], B = N[b], on = cut.has(i), mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
        return `<g class="tl-g${on ? " cut" : ""}"${mode !== "nodes" && !locked ? ` data-l="${i}" role="button" tabindex="0" aria-label="Link ${esc(N[a].label)} to ${esc(N[b].label)}${on ? ", cut" : ""}"` : ""}><line class="hit" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/><line class="tl" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>${lab ? `<text class="tlab" x="${mx}" y="${my - 6}">${esc(lab)}</text>` : ""}${on ? `<text class="tx" x="${mx}" y="${my + 5}">✕</text>` : ""}</g>`;
      }).join("");
      const nodes = N.map((n, i) => `<g class="tn ${n.cls || ""}${down.has(i) ? " down" : ""}"${mode !== "links" && !locked && !n.fixed ? ` data-n="${i}" role="button" tabindex="0" aria-label="${esc(n.label)}${down.has(i) ? ", down" : ""}"` : ""}><rect x="${n.x - bw / 2}" y="${n.y - bh / 2}" width="${bw}" height="${bh}" rx="8"/><text x="${n.x}" y="${n.y + (n.sub ? -2 : 4)}">${esc(n.label)}</text>${n.sub ? `<text class="tsub" x="${n.x}" y="${n.y + 13}">${esc(n.sub)}</text>` : ""}</g>`).join("");
      fig.innerHTML = `<svg class="diagram topo" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(spec.aria || "Topology")}">${links}${nodes}</svg>`;
      note.textContent = [mode !== "links" ? `${down.size} node${down.size === 1 ? "" : "s"} ${spec.nodeVerb || "down"}` : "", mode !== "nodes" ? `${cut.size} link${cut.size === 1 ? "" : "s"} ${spec.linkVerb || "cut"}` : ""].filter(Boolean).join(" · ") + (spec.k ? ` (choose ${spec.k})` : "");
    };
    const size = () => down.size + cut.size;
    C.onPick(fig, "data-n", (v) => { if (locked) return; const i = +v; if (down.has(i)) down.delete(i); else { if (spec.k && size() >= spec.k) return; down.add(i); } render(); onChange(); });
    C.onPick(fig, "data-l", (v) => { if (locked) return; const i = +v; if (cut.has(i)) cut.delete(i); else { if (spec.k && size() >= spec.k) return; cut.add(i); } render(); onChange(); });
    render();
    const out = () => ({ down: [...down].sort((a, b) => a - b), cut: [...cut].sort((a, b) => a - b) });
    return { get: () => (spec.k && size() !== spec.k ? null : out()), peek: out, set: (a) => { down = new Set(a.down || []); cut = new Set(a.cut || []); render(); }, clear: () => { down = new Set(); cut = new Set(); render(); }, lock: () => { locked = true; render(); } };
  };
})();
