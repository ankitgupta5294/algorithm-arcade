/* Systems Lab: real-world engineering scenarios, played hands-on against small simulators.
   A scenario is like a Problem Set problem: { id, name, w, gen(lv, R), ui(I), text(I), grader..., why(I, sol) }
   plus a debrief (concept, how, rule), the skills it trains and the kind of work it is.
   Levels are Junior / Senior / Staff. Chapters (LB.CHAPTERS) are grouped into layers of the job.
   Graders (exactly one):  ans(I) exact answer · accept(I, a) any valid answer (may be async; needs solve(I) for the reference)
                           · valid/val/sense optimisation (brute force over the widget's space, or solve(I)). */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign, PB = D.pb;
  const esc = U.esc;
  const LB = (D.lab = { list: [], byId: new Map(), bosses: [], bossById: new Map() });
  LB.LV = ["Junior", "Senior", "Staff"];

  LB.LAYERS = [
    { id: "found", name: "Foundations", blurb: "The machine under everything: processes, CPUs, networks and disks." },
    { id: "data", name: "Data", blurb: "Where state lives, how it moves, and how it breaks." },
    { id: "systems", name: "Systems", blurb: "Many machines, one behaviour: consistency, contracts and whole-system design." },
    { id: "platform", name: "Platform & delivery", blurb: "Run it, ship it, pay for it." },
    { id: "operate", name: "Operate", blurb: "Keep it up, keep it safe, prove it works." },
    { id: "craft", name: "Craft & judgment", blurb: "Code, AI systems and the decisions that sit above any one system." },
  ];
  LB.CHAPTERS = [
    { id: "linux", layer: "found", name: "Linux & production debugging", short: "Linux", blurb: "Disks that are full but aren't, file descriptors, the OOM killer, cgroup throttling, sockets and signals." },
    { id: "perf", layer: "found", name: "Concurrency & performance", short: "Performance", blurb: "Flame graphs, races and deadlocks, blocked event loops, GC pauses, queueing theory and tail latency." },
    { id: "net", layer: "found", name: "Networking", short: "Networking", blurb: "DNS, TLS, load balancers, TCP behaviour, HTTP versions, proxies and MTU." },
    { id: "storage", layer: "found", name: "Storage internals", short: "Storage", blurb: "B-trees vs LSM trees, amplification, fsync and durability, object storage, row vs column." },
    { id: "data", layer: "data", name: "Data-centric engineering", short: "Data eng.", blurb: "Indexes, safe migrations, idempotency, pagination, outbox, cache races, retries, money and time." },
    { id: "pg", layer: "data", name: "Postgres", short: "Postgres", blurb: "EXPLAIN plans, index types, isolation anomalies, locks, VACUUM, pooling, partitioning, replication. Some levels run real SQL." },
    { id: "redis", layer: "data", name: "Redis & caching", short: "Redis", blurb: "Eviction, stampedes, hot keys, cache patterns, persistence, atomic scripts and distributed locks." },
    { id: "es", layer: "data", name: "Elasticsearch", short: "Elasticsearch", blurb: "Analyzers, mappings, query DSL, relevance, shards, cluster health and reindexing." },
    { id: "kafka", layer: "data", name: "Kafka", short: "Kafka", blurb: "Partition keys, consumer lag, rebalances, durability settings, compaction, exactly-once and DLQs." },
    { id: "pipe", layer: "data", name: "Data pipelines & streaming", short: "Pipelines", blurb: "CDC, watermarks and late data, exactly-once sinks, skew, backfills, data contracts, lakehouse tables." },
    { id: "dist", layer: "systems", name: "Distributed systems", short: "Distributed", blurb: "Quorums, partitions, linearizability, consensus, clocks, sagas, consistent hashing and failure modes." },
    { id: "api", layer: "systems", name: "API design & evolution", short: "APIs", blurb: "Compatibility, versioning, schema evolution, pagination, errors, webhooks and rate limits." },
    { id: "sd", layer: "systems", name: "System design", short: "System design", blurb: "Back-of-envelope estimates, architecture choices and simulated launch days that tie everything together." },
    { id: "k8s", layer: "platform", name: "Kubernetes", short: "Kubernetes", blurb: "Scheduling, probes, rollouts, autoscaling, disruption budgets, network policy and RBAC." },
    { id: "cloud", layer: "platform", name: "Cloud & infrastructure as code", short: "Cloud & IaC", blurb: "Terraform plans and drift, VPC design, IAM policies, multi-AZ and multi-region, quotas." },
    { id: "cicd", layer: "platform", name: "CI/CD & release engineering", short: "CI/CD", blurb: "Canaries, feature flags, rollbacks, flaky tests, build caching, bisecting and pipelines." },
    { id: "cost", layer: "platform", name: "Cost engineering", short: "FinOps", blurb: "Rightsizing, spot and reserved capacity, egress traps, storage tiers and unit economics." },
    { id: "obs", layer: "operate", name: "Observability & on-call", short: "Observability", blurb: "SLOs and error budgets, burn-rate alerts, metrics cardinality, traces, logs and incident triage." },
    { id: "sec", layer: "operate", name: "Security", short: "Security", blurb: "OAuth/OIDC, secrets, injection, SSRF, access control, supply chain, TLS and least privilege." },
    { id: "test", layer: "operate", name: "Testing & reliability", short: "Testing", blurb: "Test strategy, contract and property tests, chaos experiments and load tests that don't lie." },
    { id: "review", layer: "craft", name: "Code review & software design", short: "Code review", blurb: "Spot the bug in realistic diffs, error handling, API surface, coupling and when to refactor." },
    { id: "ai", layer: "craft", name: "GenAI engineering", short: "GenAI", blurb: "RAG, context and token budgets, caching, routing, evals, agents and tools, guardrails and serving." },
    { id: "staff", layer: "craft", name: "Staff-level judgment", short: "Judgment", blurb: "Build vs buy, migrations, incident command, postmortems, prioritisation and estimation." },
  ];
  LB.chById = new Map(LB.CHAPTERS.map((c) => [c.id, c]));
  LB.SKILLS = [
    { id: "diagnose", name: "Diagnose" },
    { id: "design", name: "Design" },
    { id: "tune", name: "Tune" },
    { id: "estimate", name: "Estimate" },
    { id: "safe", name: "Change safely" },
    { id: "comms", name: "Communicate" },
  ];
  const SKILL_IDS = new Set(LB.SKILLS.map((s) => s.id));
  LB.KINDS = ["Incident", "Investigation", "Design review", "Config change", "Capacity plan", "Code review", "Change plan", "Decision", "Estimate", "Hardening", "Experiment"];

  /* ---------- registration ---------- */
  function* subsets(n) { for (let m = 0; m < 1 << n; m++) { const s = []; for (let i = 0; i < n; i++) if (m >> i & 1) s.push(i); yield s; } }
  function* tuples(n, k) { const t = Array(n).fill(0); if (!n) { yield []; return; } for (;;) { yield t.slice(); let i = 0; while (i < n && ++t[i] === k) t[i++] = 0; if (i === n) return; } }
  function* interleavings(lens) {
    const left = lens.slice(), cur = [], total = lens.reduce((a, b) => a + b, 0);
    function* go() { if (cur.length === total) { yield cur.slice(); return; } for (let l = 0; l < left.length; l++) if (left[l] > 0) { left[l]--; cur.push(l); yield* go(); cur.pop(); left[l]++; } }
    yield* go();
  }
  LB.knobValues = (kb) => kb.fixed != null && !kb.opts && kb.min == null ? [kb.fixed] : kb.opts ? kb.opts.slice() : U.range(Math.floor((kb.max - kb.min) / kb.step + 1e-9) + 1).map((i) => +(kb.min + i * kb.step).toFixed(6));
  function* tuneSpace(spec) {
    const ks = spec.knobs.filter((kb) => !kb.fixed), vals = ks.map(LB.knobValues);
    let total = 1; vals.forEach((v) => (total *= v.length));
    if (total > 300000) throw new Error("tune space too large to enumerate; give solve()");
    for (const t of tuples(ks.length, Math.max(1, ...vals.map((v) => v.length)))) {
      if (t.some((x, i) => x >= vals[i].length)) continue;
      const cfg = { ...(spec.init || {}) };
      spec.knobs.forEach((kb) => { if (kb.fixed) cfg[kb.k] = kb.fixed; });
      ks.forEach((kb, i) => (cfg[kb.k] = vals[i][t[i]]));
      yield cfg;
    }
  }
  const DEFAULT_SPACE = {
    select: (I, s) => (s.k ? PB.gen.combos(s.opts.length, s.k) : subsets(s.opts.length)),
    classify: (I, s) => tuples(s.items.length, s.cats.length),
    tune: (I, s) => tuneSpace(s),
    interleave: (I, s) => interleavings(s.lanes.map((l) => l.steps.length)),
    lines: (I, s) => { const idx = (s.lines || String(s.src).split("\n")).map((x, i) => (x.k === "@" ? -1 : i)).filter((i) => i >= 0); return (function* () { for (const c of s.k ? PB.gen.combos(idx.length, s.k) : subsets(idx.length)) if (c.length) yield c.map((j) => idx[j]); })(); },
    topo: (I, s) => { const m = s.mode || "nodes", nn = m === "links" ? 0 : s.nodes.length, nl = m === "nodes" ? 0 : (s.links || []).length; return (function* () { for (const c of s.k ? PB.gen.combos(nn + nl, s.k) : subsets(nn + nl)) yield { down: c.filter((x) => x < nn), cut: c.filter((x) => x >= nn).map((x) => x - nn) }; })(); },
  };

  // Scenarios held back from play until their checks pass again.
  LB.SKIP = new Set(["kafka-unclean-election", "k8s-pod-security"]);
  LB.add = function (def) {
    if (LB.SKIP.has(def.id)) return;
    const bad = (m) => { throw new Error(`lab scenario ${def.id || "?"}: ${m}`); };
    if (!def.id || LB.byId.has(def.id) || LB.bossById.has(def.id) || PB.byId.has(def.id)) bad("missing or duplicate id");
    if (!LB.chById.has(def.ch)) bad("unknown chapter " + def.ch);
    if (!def.name) bad("missing name");
    if (!PB.widgets[def.w]) bad("unknown widget " + def.w);
    if (!Array.isArray(def.skills) || !def.skills.length || def.skills.some((s) => !SKILL_IDS.has(s))) bad("skills must be a non-empty subset of " + [...SKILL_IDS].join(", "));
    if (!def.concept || !def.how || !def.rule) bad("needs concept, how and rule for the debrief");
    if (typeof def.gen !== "function" || typeof def.ui !== "function") bad("needs gen(lv, R) and ui(I)");
    const graders = [def.ans, def.accept, def.val].filter(Boolean).length;
    if (graders !== 1) bad("needs exactly one of ans, accept, val");
    if (def.accept && !def.solve) bad("accept needs solve(I) for the reference answer");
    def.sense = def.sense || "max";
    def.kind = def.kind || "Investigation";
    if (!def.space && DEFAULT_SPACE[def.w]) def.space = DEFAULT_SPACE[def.w];
    LB.list.push(def);
    LB.byId.set(def.id, def);
  };
  LB.addAll = (ch, defs) => defs.forEach((d) => LB.add({ ch, ...d }));
  // Boss incidents: multi-stage scenarios across chapters. stages: [{ title, text(I), w, ui(I), ans|accept+solve|val..., why? }]
  LB.addBoss = function (def) {
    const bad = (m) => { throw new Error(`boss ${def.id || "?"}: ${m}`); };
    if (!def.id || LB.byId.has(def.id) || LB.bossById.has(def.id)) bad("missing or duplicate id");
    if (!Array.isArray(def.stages) || def.stages.length < 2) bad("needs 2+ stages");
    if (!def.concept || !def.how || !def.rule) bad("needs concept, how and rule");
    (def.chs || []).forEach((c) => { if (!LB.chById.has(c)) bad("unknown chapter " + c); });
    def.stages.forEach((s, k) => {
      if (!PB.widgets[s.w]) bad(`stage ${k}: unknown widget ${s.w}`);
      if ([s.ans, s.accept, s.val].filter(Boolean).length !== 1) bad(`stage ${k}: needs exactly one grader`);
      if (s.accept && !s.solve) bad(`stage ${k}: accept needs solve`);
      s.sense = s.sense || "max";
      s.id = def.id + "#" + k;
      if (!s.space && DEFAULT_SPACE[s.w]) s.space = DEFAULT_SPACE[s.w];
    });
    def.skills = def.skills || ["diagnose"];
    def.kind = "Boss incident";
    LB.bosses.push(def);
    LB.bossById.set(def.id, def);
  };

  /* ---------- helpers for scenario authors ---------- */
  // Exact or near answers for estimates: accept within a relative tolerance (default 25%).
  LB.near = (truth, tol = 0.25) => (I, a) => {
    const t = typeof truth === "function" ? truth(I) : truth;
    if (a == null || !Number.isFinite(a)) return "Enter a number.";
    return Math.abs(a - t) <= Math.abs(t) * tol + 1e-9 ? true : a < t ? "Too low. Recheck your assumptions." : "Too high. Recheck your assumptions.";
  };
  // Replay terminal commands against a fresh shell state.
  LB.replay = function (spec, log) {
    const st = LB.k.clone(spec.init || {});
    let danger = 0;
    const outs = [];
    for (const line of log || []) { const r = spec.run(line, st) || {}; const o = typeof r === "string" ? { out: r } : r; if (o.danger) danger++; outs.push(o.out || ""); }
    return { st, danger, outs };
  };
  /* Terminal scenarios. o.shell(I) -> { init, run(line, st), motd?, cmds?: [suggested commands], par, opts?, optq?, prompt? }
     o.goal(st, I, a, replay) -> true | "what is still wrong"; o.solve(I) -> { log: [...commands], pick? } */
  LB.term = (o) => ({
    w: "term",
    ui: (I) => o.shell(I),
    accept: (I, a) => {
      const sp = o.shell(I);
      const r = LB.replay(sp, a.log);
      if (sp.opts && a.pick == null) return "Pick the root cause too.";
      return o.goal(r.st, I, a, r);
    },
    ...o,
  });

  /* ---------- building a level ---------- */
  const cache = new Map();
  function solveOf(p, I, spec) {
    return p.ans ? p.ans(I) : p.solve ? p.solve(I, spec) : p.val ? PB.brute(p, I, spec) : null;
  }
  LB.level = function (p, lv) {
    const key = p.id + "/" + lv;
    if (cache.has(key)) return cache.get(key);
    const others = new Set();
    for (let k = 1; k < lv; k++) others.add(LB.level(p, k).sig);
    let out = null, lastErr = null;
    for (let attempt = 0; attempt < 80 && !out; attempt++) {
      const R = C.rng(`${p.id}/${lv}/${attempt}`);
      let I;
      try { I = p.gen(lv, R); } catch (e) { lastErr = e; continue; }
      if (!I) continue;
      const sig = JSON.stringify(I);
      if (others.has(sig)) continue;
      if (p.stages) {
        const st = [];
        for (const s of p.stages) {
          const spec = s.ui(I), sol = solveOf(s, I, spec);
          if (sol == null) break;
          st.push({ p: s, lv, I, spec, sol, best: s.val ? s.val(I, sol) : null });
        }
        if (st.length !== p.stages.length) continue;
        out = { p, lv, I, sig, stages: st };
      } else {
        const spec = p.ui(I);
        const sol = solveOf(p, I, spec);
        if (sol == null) continue;
        if (p.reject && p.reject(I, sol)) continue;
        out = { p, lv, I, spec, sol, best: p.val ? p.val(I, sol) : null, sig };
      }
    }
    if (!out) throw lastErr || new Error("could not generate " + key);
    cache.set(key, out);
    return out;
  };
  LB.stagesOf = (L) => (L.stages ? L.stages : [L]);

  const fmtV = (v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2).replace(/\.?0+$/, "") : String(v));
  LB.same = (a, b) => LB.k.stable(a) === LB.k.stable(b);
  // Grade one stage; always returns a Promise of { ok, msg?, beat? }.
  LB.grade = async function (L, a) {
    const { p, I, sol, best } = L;
    if (a == null) return { ok: false, incomplete: true, msg: "Finish your answer first." };
    if (p.accept) {
      let r;
      try { r = await p.accept(I, a, L); } catch (e) { return { ok: false, msg: "Your answer couldn't be checked: " + esc(e.message || e) }; }
      if (r === true) return { ok: true };
      if (r && typeof r === "object") return r;
      return { ok: false, msg: typeof r === "string" ? r : p.diag ? p.diag(I, a) : "Not quite." };
    }
    if (p.val) {
      const v = p.valid ? p.valid(I, a) : true;
      if (v !== true) return { ok: false, msg: `Not valid: ${typeof v === "string" ? v : "it breaks a requirement"}.` };
      const got = p.val(I, a);
      const better = p.sense === "min" ? got < best : got > best;
      if (got === best || better) return { ok: true, got, beat: better };
      return { ok: false, msg: `That works, with ${p.vname || "a score of"} ${p.vfmt ? p.vfmt(got) : fmtV(got)}, but <b>${p.vfmt ? p.vfmt(best) : fmtV(best)}</b> is achievable.` };
    }
    const x = p.norm ? p.norm(a) : a, y = p.norm ? p.norm(sol) : sol;
    return LB.same(x, y) ? { ok: true } : { ok: false, msg: p.diag ? p.diag(I, a) : "Not quite. Look again at the evidence." };
  };

  /* ---------- progress, ranks and skills ---------- */
  LB.prog = D.store.get("lab", {});
  LB.starsFor = (id, lv) => ((LB.prog[id] || [])[lv - 1] || 0);
  LB.solvedAny = (id) => [1, 2, 3].some((k) => LB.starsFor(id, k) > 0);
  LB.record = function (id, lv, stars) {
    const a = (LB.prog[id] = LB.prog[id] || [0, 0, 0]);
    const before = Math.max(0, a[lv - 1] || 0);
    let xp = 0;
    if (stars > before) { a[lv - 1] = stars; xp = (stars - before) * 6 * lv; D.progress.data.xp += xp; D.progress.save(); }
    else if (stars < 0 && !a[lv - 1]) a[lv - 1] = -1;
    D.store.set("lab", LB.prog);
    return xp;
  };
  const solvedIn = (list) => list.reduce((s, p) => s + [1, 2, 3].filter((k) => LB.starsFor(p.id, k) > 0).length, 0);
  const starsIn = (list) => list.reduce((s, p) => s + [1, 2, 3].reduce((x, k) => x + Math.max(0, LB.starsFor(p.id, k)), 0), 0);
  LB.inChapter = (ch) => LB.list.filter((p) => p.ch === ch);
  LB.RANKS = [
    { name: "Intern", at: 0 }, { name: "Junior", at: 0.0001 }, { name: "Mid-level", at: 0.2 },
    { name: "Senior", at: 0.45 }, { name: "Staff", at: 0.7 }, { name: "Principal", at: 0.95 },
  ];
  LB.rankOf = (list) => {
    const total = list.length * 3, f = total ? solvedIn(list) / total : 0;
    let r = LB.RANKS[0];
    LB.RANKS.forEach((x) => { if (f >= x.at) r = x; });
    return { ...r, f, solved: solvedIn(list), total, stars: starsIn(list) };
  };
  LB.skillScores = () => LB.SKILLS.map((s) => {
    const ps = LB.list.filter((p) => p.skills.includes(s.id));
    return { ...s, f: ps.length ? solvedIn(ps) / (ps.length * 3) : 0, n: ps.length };
  });

  /* ---------- rendering helpers ---------- */
  const starStr = (n) => "★".repeat(Math.max(0, n)) + "☆".repeat(3 - Math.max(0, n));
  const chName = (id) => (LB.chById.get(id) || { name: id }).name;
  const skillNames = (p) => (p.skills || []).map((s) => LB.SKILLS.find((x) => x.id === s).name);
  function radar(scores) {
    const n = scores.length, cx = 120, cy = 112, R = 78;
    const pt = (i, f) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f]; };
    const ring = (f) => scores.map((_, i) => pt(i, f).map((v) => v.toFixed(1)).join(",")).join(" ");
    const shape = scores.map((s, i) => pt(i, Math.max(0.04, s.f)).map((v) => v.toFixed(1)).join(",")).join(" ");
    const labels = scores.map((s, i) => { const [x, y] = pt(i, 1.24); return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${x < cx - 5 ? "end" : x > cx + 5 ? "start" : "middle"}">${esc(s.name)} ${Math.round(s.f * 100)}%</text>`; }).join("");
    return `<svg class="radar" viewBox="-78 0 396 228" role="img" aria-label="Skill profile: ${scores.map((s) => `${s.name} ${Math.round(s.f * 100)}%`).join(", ")}">${[0.33, 0.66, 1].map((f) => `<polygon class="rg" points="${ring(f)}"/>`).join("")}<polygon class="rs" points="${shape}"/>${labels}</svg>`;
  }
  LB.debrief = function (p, here) {
    return `<div class="algo-card debrief">
      <div class="algo-head"><span class="eyebrow">Debrief</span><b>${esc(p.concept)}</b><span class="algo-tags">${esc(skillNames(p).join(" · "))}</span></div>
      <p class="algo-how"><b>How it works.</b> ${p.how}</p>
      <p class="algo-how rule"><b>Rule of thumb.</b> ${p.rule}</p>
      ${here ? `<div class="algo-here"><span class="eyebrow">In this scenario</span>${/^\s*</.test(here) ? here : `<p>${here}</p>`}</div>` : ""}
    </div>`;
  };

  /* ================= Screens ================= */
  function mount(root, cfg) {
    const chIdx = (id) => LB.CHAPTERS.findIndex((c) => c.id === id);
    LB.list.sort((a, b) => chIdx(a.ch) - chIdx(b.ch));
    let ctrl = null;
    const clear = () => { if (ctrl && ctrl.destroy) ctrl.destroy(); ctrl = null; LB._current = null; };
    const top = (back, eyebrow, title, stats) => `
      <div class="camp-head">
        <button class="btn ghost back" type="button">${back}</button>
        <div class="camp-title"><div class="eyebrow">${eyebrow}</div><h2>${title}</h2></div>
        <div class="stats">${stats.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join("")}</div>
      </div>`;

    function home(focus) {
      clear();
      const all = LB.rankOf(LB.list);
      root.innerHTML = `<div class="camp lab">
        ${top("← All games", "Systems Lab", `${LB.list.length.toLocaleString()} scenarios · ${(LB.list.length * 3).toLocaleString()} levels`, [["Levels solved", `${all.solved}<small>/${all.total}</small>`], ["Stars", `${all.stars}<small>/${all.total * 3}</small>`], ["Title", esc(all.name)]])}
        <div class="lab-hero">
          <div>
            <p class="lede">Real engineering decisions, played against simulators: run commands on a broken system, tune configs until the load test passes, order a migration so the rolling deploy survives, write the YAML, SQL or query that actually runs. Each scenario has a Junior, Senior and Staff level, and a debrief once you solve it.</p>
            <div class="actions">
              <button class="btn primary shift" type="button">Start an on-call shift</button>
              ${LB.bosses.length ? `<button class="btn bosses" type="button">Boss incidents <small>${LB.bosses.length}</small></button>` : ""}
            </div>
            <p class="muted small">${D.store.get("lab-shift-best", 0) ? `Best shift: ${D.store.get("lab-shift-best", 0)} incidents resolved.` : "On-call shift: a random queue of scenarios. Wrong answers burn your error budget."}</p>
          </div>
          <div class="lab-radar"><div class="eyebrow">Skill profile</div>${radar(LB.skillScores())}</div>
        </div>
        <div class="pb-filters"><input type="search" class="pb-q" placeholder="Search scenarios…" aria-label="Search scenarios"></div>
        <div class="lab-search" hidden></div>
        <div class="lab-layers">${LB.LAYERS.map((ly) => {
          const chs = LB.CHAPTERS.filter((c) => c.layer === ly.id && LB.inChapter(c.id).length);
          if (!chs.length) return "";
          return `<section class="lab-layer"><h3>${esc(ly.name)} <span class="muted small">${esc(ly.blurb)}</span></h3><div class="lab-chs">${chs.map((c) => {
            const r = LB.rankOf(LB.inChapter(c.id));
            return `<button type="button" class="lab-ch" data-ch="${c.id}"><span class="mc-top"><span class="mc-topic">${r.total / 3} scenarios</span><span class="rank r${LB.RANKS.indexOf(LB.RANKS.find((x) => x.name === r.name))}">${esc(r.name)}</span></span><span class="mc-name">${esc(c.name)}</span><span class="mc-blurb">${esc(c.blurb)}</span><span class="lab-prog"><span style="width:${(r.f * 100).toFixed(1)}%"></span></span><span class="mc-foot"><span>${r.solved}/${r.total} levels · ${r.stars}★</span><span>Open</span></span></button>`;
          }).join("")}</div></section>`;
        }).join("")}</div>
      </div>`;
      const $ = (s) => root.querySelector(s);
      $(".back").addEventListener("click", () => cfg.exit());
      $(".shift").addEventListener("click", () => shiftSetup());
      if ($(".bosses")) $(".bosses").addEventListener("click", () => bossList());
      root.querySelectorAll(".lab-ch").forEach((b) => b.addEventListener("click", () => chapter(b.dataset.ch)));
      const sr = $(".lab-search"), layers = $(".lab-layers");
      $(".pb-q").addEventListener("input", (e) => {
        const q = e.target.value.trim().toLowerCase();
        layers.hidden = !!q; sr.hidden = !q;
        if (!q) return;
        const hits = LB.list.filter((p) => `${p.name} ${chName(p.ch)} ${p.kind} ${LB.solvedAny(p.id) ? p.concept : ""}`.toLowerCase().includes(q)).slice(0, 80);
        sr.innerHTML = hits.length ? `<div class="pb-rows">${hits.map(rowHTML).join("")}</div>` : `<p class="muted">No scenarios match.</p>`;
      });
      sr.addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) scenario(b.dataset.id); });
      if (focus) { const el = root.querySelector(`[data-ch="${focus}"]`); if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "center" }); } }
      else window.scrollTo(0, 0);
    }

    function rowHTML(p) {
      const st = [1, 2, 3].map((lv) => LB.starsFor(p.id, lv));
      return `<button type="button" class="pb-row" data-id="${p.id}"><span class="pb-num">${LB.inChapter(p.ch).indexOf(p) + 1}</span><span class="pb-name">${esc(p.name)}</span><span class="pb-tags"><span class="kindchip">${esc(p.kind)}</span> ${LB.solvedAny(p.id) ? esc(p.concept) : esc(skillNames(p).join(" · "))}</span><span class="pb-lv">${st.map((s, k) => `<i class="lvdot lv${k + 1}${s > 0 ? " done" : s < 0 ? " rev" : ""}" title="${LB.LV[k]}${s > 0 ? ": " + s + "★" : ""}"></i>`).join("")}</span></button>`;
    }

    function chapter(ch, focusId) {
      clear();
      const c = LB.chById.get(ch), ps = LB.inChapter(ch), r = LB.rankOf(ps);
      D.store.set("lab-ch", ch);
      root.innerHTML = `<div class="camp lab">
        ${top("← Systems Lab", esc(LB.LAYERS.find((l) => l.id === c.layer).name), esc(c.name), [["Rank", esc(r.name)], ["Levels", `${r.solved}<small>/${r.total}</small>`], ["Stars", `${r.stars}<small>/${r.total * 3}</small>`]])}
        <p class="lede">${esc(c.blurb)} Concepts are revealed in each debrief once you solve a level.</p>
        <div class="actions"><button class="btn primary next" type="button">Continue →</button><button class="btn shiftch" type="button">On-call shift in this chapter</button></div>
        <div class="pb-rows">${ps.map(rowHTML).join("")}</div>
      </div>`;
      root.querySelector(".back").addEventListener("click", () => home(ch));
      root.querySelector(".pb-rows").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) scenario(b.dataset.id); });
      root.querySelector(".next").addEventListener("click", () => { const p = ps.find((x) => [1, 2, 3].some((k) => LB.starsFor(x.id, k) <= 0)) || ps[0]; scenario(p.id); });
      root.querySelector(".shiftch").addEventListener("click", () => startShift([ch]));
      if (focusId) { const el = root.querySelector(`[data-id="${focusId}"]`); if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "center" }); } }
      else window.scrollTo(0, 0);
    }

    const nextLevelOf = (id) => { for (let lv = 1; lv <= 3; lv++) if (LB.starsFor(id, lv) <= 0) return lv; return 1; };

    function bossList() {
      clear();
      root.innerHTML = `<div class="camp lab">
        ${top("← Systems Lab", "Boss incidents", "Cascading failures across systems", [["Cleared", `${LB.bosses.filter((b) => LB.solvedAny(b.id)).length}<small>/${LB.bosses.length}</small>`]])}
        <p class="lede">Multi-stage incidents where one failure triggers the next. Each stage is a different system; solve them in order.</p>
        <div class="pb-rows">${LB.bosses.map((b, i) => { const st = [1, 2, 3].map((lv) => LB.starsFor(b.id, lv)); return `<button type="button" class="pb-row" data-id="${b.id}"><span class="pb-num">${i + 1}</span><span class="pb-name">${esc(b.name)}</span><span class="pb-tags">${b.stages.length} stages · ${esc((b.chs || []).map((c) => LB.chById.get(c).short).join(" → "))}</span><span class="pb-lv">${st.map((s, k) => `<i class="lvdot lv${k + 1}${s > 0 ? " done" : s < 0 ? " rev" : ""}"></i>`).join("")}</span></button>`; }).join("")}</div>
      </div>`;
      root.querySelector(".back").addEventListener("click", () => home());
      root.querySelector(".pb-rows").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) scenario(b.dataset.id); });
      window.scrollTo(0, 0);
    }

    /* ----- one scenario (or boss incident) ----- */
    function scenario(id, lv, shift) {
      clear();
      const p = LB.byId.get(id) || LB.bossById.get(id);
      const isBoss = !!p.stages;
      lv = lv || nextLevelOf(id);
      let L;
      try { L = LB.level(p, lv); } catch (e) { root.innerHTML = `<p class="lose">Couldn't build this level: ${esc(e.message)}</p><button class="btn back" type="button">Back</button>`; root.querySelector(".back").addEventListener("click", () => home()); return; }
      const stages = LB.stagesOf(L);
      const ch = isBoss ? null : LB.chById.get(p.ch);
      const num = isBoss ? LB.bosses.indexOf(p) + 1 : LB.inChapter(p.ch).indexOf(p) + 1;
      const brief = typeof p.text === "function" ? p.text(L.I) : p.text || "";
      const metaHTML = (open) => `<span class="tag">${esc(isBoss ? "Boss incident" : ch.short)}</span><span class="kindchip">${esc(p.kind)}</span>${skillNames(p).map((s) => `<span class="skillchip">${esc(s)}</span>`).join("")}${open ? `<span class="kind">${esc(p.concept)}</span>` : ""}`;
      root.innerHTML = `
        <div class="game camp-level lab-level">
          ${shift ? shift.bar() : ""}
          <div class="game-top">
            <button class="btn ghost back" type="button">${shift ? "End shift" : isBoss ? "← Boss incidents" : "← " + esc(ch.short)}</button>
            <div class="game-title"><h2><span class="muted">#${num}</span> ${esc(p.name)}</h2></div>
            <div class="stats camp-stats"><div class="stat"><span>Level</span><b>${LB.LV[lv - 1]}</b></div><div class="stat"><span>Best</span><b>${LB.starsFor(id, lv) > 0 ? starStr(LB.starsFor(id, lv)) : "–"}</b></div></div>
          </div>
          ${shift ? "" : `<div class="lvtabs" role="tablist" aria-label="Level">${[1, 2, 3].map((k) => `<button type="button" role="tab" class="lvtab lvl-${k}${k === lv ? " on" : ""}" aria-selected="${k === lv}" data-lv="${k}">${LB.LV[k - 1]} <span>${LB.starsFor(id, k) > 0 ? starStr(LB.starsFor(id, k)) : LB.starsFor(id, k) < 0 ? "revealed" : ""}</span></button>`).join("")}</div>`}
          <div class="q">
            <div class="q-meta">${metaHTML(LB.solvedAny(id))}</div>
            <div class="prompt camp-goal ticket">${brief}</div>
            ${isBoss ? `<ol class="boss-steps">${stages.map((s, k) => `<li data-k="${k}">${esc(s.p.title || "Stage " + (k + 1))}</li>`).join("")}</ol>` : ""}
            <div class="lab-stage"></div>
            <div class="camp-result" hidden></div>
          </div>
        </div>`;
      const $ = (s) => root.querySelector(s);
      $(".back").addEventListener("click", () => (shift ? shift.end() : isBoss ? bossList() : chapter(p.ch, id)));
      root.querySelectorAll(".lvtab").forEach((b) => b.addEventListener("click", () => scenario(id, +b.dataset.lv)));
      let fails = 0, pen = 0, revealed = false, finished = false, k = 0;
      const host = $(".lab-stage");

      function runStage() {
        const S = stages[k], sp = S.p;
        root.querySelectorAll(".boss-steps li").forEach((li) => { li.classList.toggle("on", +li.dataset.k === k); li.classList.toggle("done", +li.dataset.k < k); });
        const stext = isBoss ? (typeof sp.text === "function" ? sp.text(S.I) : sp.text || "") : "";
        host.innerHTML = `${isBoss ? `<div class="stage-head"><span class="eyebrow">Stage ${k + 1} of ${stages.length}</span><b>${esc(sp.title || "")}</b></div><div class="prompt">${stext}</div>` : ""}
          <div class="camp-stage"></div>
          <div class="lab-live" hidden></div>
          <div class="feedback camp-say" role="status" hidden></div>
          <div class="actions camp-tools">
            <button class="btn primary check" type="button">Check</button>
            <button class="btn ghost reset" type="button">Clear</button>
            <button class="btn ghost reveal" type="button" hidden>Show solution</button>
            <details class="strategy"><summary class="btn ghost">Hint</summary><div class="strategy-body">${hintOf(sp, S.I)}</div></details>
          </div>`;
        const q = (s) => host.querySelector(s);
        let stageFails = 0, busy = false, liveT = 0, liveTok = 0;
        const say = (html, kind) => { const el = q(".camp-say"); el.hidden = !html; el.innerHTML = html ? `<p class="${kind || ""}">${html}</p>` : ""; };
        const live = q(".lab-live");
        const doLive = () => {
          if (!S.spec.live) return;
          const tok = ++liveTok;
          const showErr = (e) => { live.hidden = false; live.innerHTML = `<p class="lose small">${esc(e && e.message || e)}</p>`; };
          try {
            const v = widget.peek ? widget.peek() : widget.get();
            const h = S.spec.live(v);
            if (h && typeof h.then === "function") { if (live.hidden) { live.hidden = false; live.innerHTML = `<p class="muted small">Running…</p>`; } h.then((x) => { if (tok === liveTok) { live.hidden = !x; live.innerHTML = x || ""; } }, (e) => tok === liveTok && showErr(e)); }
            else { live.hidden = !h; live.innerHTML = h || ""; }
          } catch (e) { showErr(e); }
        };
        const onChange = () => { if (finished) return; say(""); clearTimeout(liveT); liveT = setTimeout(doLive, S.spec.liveDelay || 120); };
        const stageHost = {
          say,
          async submit(a) {
            if (finished || busy) return;
            busy = true; q(".check").disabled = true;
            const slow = setTimeout(() => say("Checking…"), 150);
            const g = await LB.grade(S, a);
            clearTimeout(slow);
            busy = false; q(".check").disabled = false;
            if (g.ok) {
              pen += widget.penalty ? widget.penalty() : 0;
              widget.lock(); doLive();
              say(g.beat ? "Better than the reference answer!" : "", "win");
              return next(true);
            }
            fails++; stageFails++;
            if (shift && !g.incomplete) shift.burn(20);
            say(g.msg, "lose");
            if (stageFails >= 2) q(".reveal").hidden = false;
          },
        };
        const widget = PB.widgets[sp.w](q(".camp-stage"), S.spec, onChange, stageHost);
        LB._current = { L: S, widget, host: stageHost, stage: k };
        q(".camp-stage").addEventListener("pb-submit", () => q(".check").click());
        if (widget.selfSubmit) { q(".check").hidden = true; q(".reset").hidden = true; }
        q(".check").addEventListener("click", () => { const a = widget.get(); if (a == null) { say("Finish your answer first."); return; } stageHost.submit(a); });
        q(".reset").addEventListener("click", () => { widget.clear(); say(""); doLive(); });
        q(".reveal").addEventListener("click", () => {
          widget.set(S.sol); widget.lock(); revealed = true; doLive();
          if (shift) shift.burn(40);
          const why = sp.why ? sp.why(S.I, S.sol, S.best) : "";
          const shown = sp.show ? sp.show(S.I, S.sol) : "";
          say(`<b>Solution shown.</b> ${shown}${why && isBoss ? " " + why : ""}`);
          next(false);
        });
        doLive();
      }
      function next(won) {
        if (k < stages.length - 1) {
          const tools = host.querySelector(".camp-tools");
          tools.innerHTML = `<button class="btn primary cont" type="button">Next stage →</button>`;
          const why = stages[k].p.why ? stages[k].p.why(stages[k].I, stages[k].sol, stages[k].best) : "";
          if (why && won) host.querySelector(".camp-say").insertAdjacentHTML("beforeend", `<div class="learned">${why}</div>`), (host.querySelector(".camp-say").hidden = false);
          tools.querySelector(".cont").addEventListener("click", () => { k++; runStage(); window.scrollTo({ top: host.offsetTop - 80, behavior: "smooth" }); });
          tools.querySelector(".cont").focus({ preventScroll: true });
          return;
        }
        finish(won && !revealed);
      }
      function finish(won) {
        if (finished) return;
        finished = true;
        const stars = won ? Math.max(1, 3 - Math.min(fails, 2) - Math.min(pen, 2)) : 0;
        const xp = won ? LB.record(id, lv, stars) : LB.record(id, lv, -1);
        const tools = host.querySelector(".camp-tools"); if (tools) tools.hidden = true;
        LB._lastResult = { won, stars, id, lv, revealed };
        const last = stages[stages.length - 1];
        const here = isBoss ? (p.why ? p.why(L.I) : "") : p.why ? p.why(L.I, L.sol, L.best) : "";
        const res = $(".camp-result");
        res.hidden = false;
        const nextLv = lv < 3 ? lv + 1 : null;
        const list = isBoss ? LB.bosses : LB.inChapter(p.ch), nextP = list[list.indexOf(p) + 1];
        res.innerHTML = `<div class="result-banner ${won ? "win" : "lose"}">${won ? `<div class="big-stars" aria-label="${stars} of 3 stars">${starStr(stars)}</div><div><b>Resolved.</b> ${xp ? `+${xp} XP.` : ""}${pen ? ` <span class="muted small">(${pen} star${pen > 1 ? "s" : ""} lost to extra or risky actions)</span>` : ""}</div>` : `<b>Here's a solution.</b>`}</div>
          ${LB.debrief(p, here)}
          <div class="actions">
            ${shift ? `<button class="btn primary snext" type="button">Next page →</button>` : `${nextLv ? `<button class="btn primary nextlv" type="button">${LB.LV[nextLv - 1]} level →</button>` : nextP ? `<button class="btn primary nextp" type="button">Next scenario →</button>` : ""}
            ${nextLv && nextP ? `<button class="btn nextp" type="button">Next scenario</button>` : ""}
            <button class="btn ghost replay" type="button">Try again</button>
            <button class="btn ghost list" type="button">${isBoss ? "Boss incidents" : "Chapter"}</button>`}
          </div>`;
        void last;
        $(".q-meta").innerHTML = metaHTML(true);
        if (shift) { shift.done(won, stars); res.querySelector(".snext").addEventListener("click", () => shift.next()); }
        else {
          res.querySelectorAll(".nextlv").forEach((b) => b.addEventListener("click", () => scenario(id, nextLv)));
          res.querySelectorAll(".nextp").forEach((b) => b.addEventListener("click", () => scenario(nextP.id, 1)));
          res.querySelector(".replay").addEventListener("click", () => scenario(id, lv));
          res.querySelector(".list").addEventListener("click", () => (isBoss ? bossList() : chapter(p.ch, id)));
        }
        (res.querySelector(".nextlv, .nextp, .snext") || res.querySelector(".replay")).focus({ preventScroll: true });
        res.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      runStage();
      window.scrollTo(0, 0);
    }
    const hintOf = (p, I) => (typeof p.hint === "function" ? p.hint(I) : p.hint) || "Gather evidence before acting: what changed, what is saturated, what do the numbers say?";

    /* ----- on-call shift: a random queue; wrong answers burn the error budget ----- */
    function shiftSetup() {
      clear();
      const sel = new Set(D.store.get("lab-shift-chs", LB.CHAPTERS.map((c) => c.id)));
      root.innerHTML = `<div class="camp lab">
        ${top("← Systems Lab", "On-call shift", "Pick your rotation", [["Best shift", String(D.store.get("lab-shift-best", 0))]])}
        <p class="lede">You get a random queue of scenarios from the chapters you choose, at the level that matches your progress. Each shift starts with a 100% error budget. A wrong answer burns 20%, a revealed solution burns 40%, a 3-star fix earns 5% back. The shift ends when the budget is gone.</p>
        <div class="pb-cats">${LB.CHAPTERS.filter((c) => LB.inChapter(c.id).length).map((c) => `<button type="button" class="chipf${sel.has(c.id) ? " on" : ""}" data-ch="${c.id}">${esc(c.short)}</button>`).join("")}</div>
        <div class="actions"><button class="btn ghost all" type="button">All</button><button class="btn ghost none" type="button">None</button><button class="btn primary go" type="button">Start shift</button></div>
      </div>`;
      const sync = () => root.querySelectorAll(".chipf").forEach((b) => b.classList.toggle("on", sel.has(b.dataset.ch)));
      root.querySelector(".pb-cats").addEventListener("click", (e) => { const b = e.target.closest("[data-ch]"); if (!b) return; sel.has(b.dataset.ch) ? sel.delete(b.dataset.ch) : sel.add(b.dataset.ch); sync(); });
      root.querySelector(".all").addEventListener("click", () => { LB.CHAPTERS.forEach((c) => sel.add(c.id)); sync(); });
      root.querySelector(".none").addEventListener("click", () => { sel.clear(); sync(); });
      root.querySelector(".back").addEventListener("click", () => home());
      root.querySelector(".go").addEventListener("click", () => { if (!sel.size) return; D.store.set("lab-shift-chs", [...sel]); startShift([...sel]); });
      window.scrollTo(0, 0);
    }
    function startShift(chs) {
      const pool = LB.list.filter((p) => chs.includes(p.ch));
      if (!pool.length) return home();
      const S = { budget: 100, resolved: 0, pages: 0, seen: new Set() };
      const pickNext = () => {
        // prefer scenarios with unsolved levels; the level is the first unsolved one
        let cands = pool.filter((p) => !S.seen.has(p.id) && [1, 2, 3].some((k) => LB.starsFor(p.id, k) <= 0));
        if (!cands.length) cands = pool.filter((p) => !S.seen.has(p.id));
        if (!cands.length) { S.seen.clear(); cands = pool; }
        const p = cands[Math.floor(Math.random() * cands.length)];
        S.seen.add(p.id);
        return p;
      };
      const shift = {
        bar: () => `<div class="shiftbar"><span class="eyebrow">On call</span><span>Page ${S.pages}</span><span>Resolved ${S.resolved}</span><span class="budget"><span class="bl">Error budget</span><span class="bt"><span class="bf${S.budget <= 30 ? " low" : ""}" style="width:${S.budget}%"></span></span><b>${S.budget}%</b></span></div>`,
        done(won, stars) {
          if (won) { S.resolved++; if (stars === 3) S.budget = Math.min(100, S.budget + 5); }
          const sb = root.querySelector(".shiftbar"); if (sb) sb.outerHTML = shift.bar();
        },
        next() { if (S.budget <= 0) return shift.end(); S.pages++; const p = pickNext(); scenario(p.id, nextLevelOf(p.id), shift); },
        end() {
          if (S.ended) return;
          S.ended = true;
          clear();
          const best = Math.max(D.store.get("lab-shift-best", 0), S.resolved);
          D.store.set("lab-shift-best", best);
          root.innerHTML = `<div class="camp lab">${top("← Systems Lab", "Shift over", S.budget <= 0 ? "Error budget exhausted" : "You handed off the pager", [["Resolved", String(S.resolved)], ["Pages", String(S.pages)], ["Best", String(best)]])}
            <p class="lede">${S.resolved ? `You resolved ${S.resolved} of ${S.pages} pages.` : "No pages resolved this time."} The debriefs of every scenario you played are in their chapters.</p>
            <div class="actions"><button class="btn primary again" type="button">New shift</button><button class="btn ghost home" type="button">Systems Lab</button></div></div>`;
          root.querySelector(".back").addEventListener("click", () => home());
          root.querySelector(".home").addEventListener("click", () => home());
          root.querySelector(".again").addEventListener("click", () => startShift(chs));
        },
      };
      shift.burn = (n) => { S.budget = Math.max(0, S.budget - n); const sb = root.querySelector(".shiftbar"); if (sb) sb.outerHTML = shift.bar(); if (S.budget <= 0) setTimeout(() => shift.end(), 900); };
      shift.next();
    }

    LB._app = { home, chapter, scenario, bossList, shiftSetup, startShift };
    if (cfg.startScenario && (LB.byId.has(cfg.startScenario) || LB.bossById.has(cfg.startScenario))) scenario(cfg.startScenario);
    else home();
    return { destroy: clear };
  }

  D.registerMode({
    id: "lab",
    name: "Systems Lab",
    group: "Engineering",
    topic: "Real-world engineering",
    blurb: "Hands-on engineering scenarios across 23 chapters: debug, tune, design and ship against live simulators. Junior, Senior and Staff levels.",
    custom: true,
    noBadges: true,
    featured: true,
    levelsLabel: () => (LB.list.length * 3).toLocaleString() + " levels",
    footer: () => { const r = LB.rankOf(LB.list); return `${r.solved}/${r.total} levels · ${esc(r.name)}`; },
    mount,
  });
})();
