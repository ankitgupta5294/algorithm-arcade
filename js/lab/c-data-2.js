/* Systems Lab · Data-centric engineering (part 2): tuning load, retries and data layouts against small models,
   real SQL on PGlite, and terminal investigations. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const S = [];
  const rng = (s) => D.campaign.rng(s);

  /* ---------- a small request simulator (all times in ms) ----------
     Poisson arrivals, `servers` workers, FIFO queue. Client timeout; retries with exponential backoff (optional full
     jitter) on timeouts, fast failures and rejections; an optional retry budget (retries ≤ budget × requests);
     dropExpired skips queued work whose caller already gave up; queueMax rejects (503) when the queue is full;
     prio: { frac, qLo } marks a fraction of requests high priority and sheds low priority once the queue exceeds qLo. */
  function simQ(o) {
    const R = o.R, dur = o.dur * 1000, heap = [];
    const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].t <= heap[i].t) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].t < heap[m].t) m = l; if (r < heap.length && heap[r].t < heap[m].t) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const nb = o.dur, ser = { off: Array(nb).fill(0), att: Array(nb).fill(0), good: Array(nb).fill(0), q: Array(nb).fill(0) };
    const B = (t) => Math.min(nb - 1, Math.floor(t / 1000));
    let t = 0;
    for (;;) { t += (-Math.log(1 - R.next()) * 1000) / o.rateAt(t / 1000); if (t >= dur) break; push({ t, k: 0, req: { t0: t, att: 0, done: false, hi: o.prio ? R.next() < o.prio.frac : true } }); }
    const q = []; let qh = 0, busy = 0, n = 0, ok = 0, att = 0, rej = 0, retried = 0;
    const lat = [], cls = { hi: [0, 0], lo: [0, 0] }, win = o.win || [0, 0], out = [0, 0];
    const T = o.timeout, budget = o.budget == null ? Infinity : o.budget, cap = o.budgetCap || 100;
    let tokens = cap;
    const retry = (req, now) => {
      if (req.att >= (o.retries || 0)) return;
      if (budget < Infinity) { if (tokens < 1) return; tokens -= 1; }
      const base = (o.backoff || 0) * 2 ** req.att, d = o.jitter ? R.next() * base : base;
      req.att++; retried++; push({ t: now + d, k: 0, req });
    };
    const start = (now) => {
      while (busy < o.servers && qh < q.length) {
        const j = q[qh++];
        if (o.dropExpired && now - j.ta > T) continue;
        busy++; push({ t: now + o.svcAt(now / 1000, R), k: 1, j });
      }
      if (qh > 2048) { q.splice(0, qh); qh = 0; }
    };
    let guard = 0;
    while (heap.length) {
      const e = pop();
      if (e.t > dur + 20000 || ++guard > 250000) break;
      if (e.k === 0) {
        const req = e.req;
        if (req.att === 0) { n++; tokens = Math.min(cap, tokens + (budget < Infinity ? budget : 0)); if (req.hi) cls.hi[0]++; else cls.lo[0]++; if (e.t < dur) ser.off[B(e.t)]++; if (e.t / 1000 < win[0] || e.t / 1000 >= win[1]) out[0]++; }
        att++; if (e.t < dur) ser.att[B(e.t)]++;
        if (o.failAt && o.failAt(e.t / 1000, R)) { push({ t: e.t + 3, k: 3, req }); continue; }
        const ql = q.length - qh;
        if (ql >= o.queueMax || (o.prio && !req.hi && ql >= o.prio.qLo)) { rej++; push({ t: e.t + 1, k: 3, req }); continue; }
        const j = { req, ta: e.t, a: req.att };
        q.push(j); push({ t: e.t + T, k: 2, j }); start(e.t);
        if (e.t < dur) ser.q[B(e.t)] = Math.max(ser.q[B(e.t)], q.length - qh);
      } else if (e.k === 1) {
        busy--;
        const j = e.j;
        if (!j.to && !j.req.done) { j.req.done = true; ok++; lat.push(e.t - j.req.t0); if (j.req.hi) cls.hi[1]++; else cls.lo[1]++; if (e.t < dur) ser.good[B(e.t)]++; if (j.req.t0 / 1000 < win[0] || j.req.t0 / 1000 >= win[1]) out[1]++; }
        start(e.t);
      } else if (e.k === 2) { const j = e.j; if (j.req.done) continue; j.to = true; if (j.a === j.req.att) retry(j.req, e.t); }
      else if (e.k === 3) { if (!e.req.done && e.req.att === e.req.att) retry(e.req, e.t); }
    }
    lat.sort((a, b) => a - b);
    let rec = null;
    if (o.recFrom != null) for (let s = o.recFrom; s < nb - 2; s++) if ([0, 1, 2].every((k) => ser.good[s + k] >= 0.95 * ser.off[s + k])) { rec = s - o.recFrom; break; }
    return { n, ok, att, rej, amp: att / Math.max(1, n), succ: ok / Math.max(1, n), outside: out[1] / Math.max(1, out[0]), hi: cls.hi[1] / Math.max(1, cls.hi[0]), lo: cls.lo[1] / Math.max(1, cls.lo[0]), p99: lat.length ? lat[Math.min(lat.length - 1, Math.ceil(0.99 * lat.length) - 1)] : null, rec, ser };
  }
  const qChart = (r, o = {}) => K.chart([{ name: "offered (new requests)", pts: r.ser.off }, { name: "attempts incl. retries", pts: r.ser.att, cls: "bad" }, { name: "successful", pts: r.ser.good, cls: "good" }], { title: o.title || "requests per second", xlabel: "s", h: 150, ...(o.vline ? { vline: o.vline } : {}) });

  /* ================= tune: retries ================= */
  function retryRun(I, c) {
    const blip = I.lv !== 2, slow = I.lv !== 1;
    const b0 = I.lv === 1 ? 10 : 5, s0 = I.lv === 2 ? 8 : 14, s1 = s0 + I.slowFor;
    return simQ({
      R: rng("retry/" + I.seed), dur: I.lv === 1 ? 26 : 34, rateAt: () => I.rate, servers: 8, timeout: 600,
      svcAt: (t, R) => K.exp(R, slow && t >= s0 && t < s1 ? I.svc * 4 : I.svc),
      failAt: (t, R) => (blip && t >= b0 && t < b0 + I.blip) || R.next() < I.fail,
      budgetCap: I.lv === 3 ? 1000 : 100, retries: c.retries, backoff: c.backoff, jitter: c.jitter === "full jitter", budget: c.budget === "none" || c.budget == null ? null : c.budget, dropExpired: c.drop === "on",
      win: slow ? [s0, s1] : [0, 0], recFrom: slow ? s1 : null, queueMax: Infinity,
    });
  }
  const retryGoal = (I) => ({ succ: I.lv === 1 ? 0.995 : 0.99, amp: I.lv === 1 ? 1.3 : I.lv === 2 ? 1.2 : 1.4, rec: 3 });
  function retryCheck(I, r) {
    const g = retryGoal(I), out = [];
    if (I.lv === 1) { if (r.succ < g.succ) out.push(`only ${K.pct(r.succ, 2)} of requests succeeded (target ${K.pct(g.succ, 1)})`); }
    else if (r.outside < g.succ) out.push(`only ${K.pct(r.outside, 2)} of requests outside the slowdown succeeded (target ${K.pct(g.succ, 0)})`);
    if (r.amp > g.amp) out.push(`clients sent ${r.amp.toFixed(2)}× the original traffic (cap ${g.amp}×)`);
    if (I.lv > 1 && (r.rec == null || r.rec > g.rec)) out.push(r.rec == null ? "the service never recovered after the dependency did (metastable failure)" : `recovery took ${r.rec} s after the dependency recovered (target ≤ ${g.rec} s)`);
    return out;
  }
  S.push({
    id: "data-retry-storm",
    name: "Tune retries without a storm",
    kind: "Config change",
    skills: ["tune", "safe"],
    w: "tune",
    gen(lv, R) { return { lv, seed: R.int(1, 1e9), rate: R.pick([120, 140, 160]), svc: 25, blip: R.pick([1.5, 2, 2.5]), slowFor: R.pick([8, 10]), fail: lv === 1 ? 0.01 : 0.03 }; },
    text: (I) => `<p>The orders API (8 workers, ~${I.svc} ms per request, so ~${Math.round(8000 / I.svc)} req/s of capacity) serves <b>${I.rate} req/s</b>. Callers time out after 600 ms. ${I.lv === 1 ? `Its downstream occasionally fails every call for about <b>${I.blip} s</b> (a leader election), and ${K.pct(I.fail)} of calls fail randomly at any time.` : I.lv === 2 ? `${K.pct(I.fail)} of calls fail transiently, and last week the downstream slowed down 4× for ${I.slowFor} s. After it recovered, the API stayed down for 20 minutes.` : `There are three hazards: ${K.pct(I.fail)} random transient failures, a ${I.blip} s total outage of the downstream, and a ${I.slowFor} s 4× slowdown.`}</p><p><b>Choose a client retry policy${I.lv > 1 ? " and server settings" : ""}</b> that meets the targets in the panel. Each change re-runs the simulation.</p>`,
    ui: (I) => {
      const knobs = [{ k: "retries", label: "Max retries", opts: I.lv === 2 ? [0, 1, 3] : [0, 1, 2, 3, 5] }, { k: "backoff", label: "Base backoff", opts: [0, 50, 200, 1000], unit: "ms", help: "doubles each attempt" }];
      if (I.lv !== 2) knobs.push({ k: "jitter", label: "Jitter", opts: ["none", "full jitter"], help: "full jitter: wait random(0, backoff)" });
      if (I.lv > 1) knobs.push({ k: "budget", label: "Retry budget", opts: ["none", 0.1], fmt: (v) => (v === "none" ? "none" : "≤ 10% of requests") }, { k: "drop", label: "Server drops requests whose caller already timed out", opts: ["off", "on"] });
      return { knobs, init: { jitter: "full jitter" }, live: (c) => { const r = retryRun(I, c), g = retryGoal(I), bad = retryCheck(I, r); return qChart(r) + K.metrics([I.lv === 1 ? { name: "success", value: K.pct(r.succ, 2), ok: r.succ >= g.succ, target: `≥ ${K.pct(g.succ, 1)}` } : { name: "success outside slowdown", value: K.pct(r.outside, 2), ok: r.outside >= g.succ, target: `≥ ${K.pct(g.succ, 0)}` }, { name: "amplification", value: r.amp.toFixed(2) + "×", ok: r.amp <= g.amp, target: `≤ ${g.amp}×` }, ...(I.lv > 1 ? [{ name: "recovery", value: r.rec == null ? "never" : r.rec + " s", ok: r.rec != null && r.rec <= g.rec, target: `≤ ${g.rec} s` }] : [])]) + (bad.length ? "" : K.verdict(true, "All targets met.")); } };
    },
    valid: (I, c) => { const b = retryCheck(I, retryRun(I, c)); return b.length ? b[0] : true; },
    val: () => 1,
    noBrute: true,
    solve(I) {
      const cands = I.lv === 1 ? [{ retries: 3, backoff: 1000, jitter: "none" }, { retries: 5, backoff: 200, jitter: "none" }, { retries: 5, backoff: 1000, jitter: "full jitter" }]
        : I.lv === 2 ? [{ retries: 1, backoff: 200, budget: 0.1, drop: "on" }, { retries: 3, backoff: 200, budget: 0.1, drop: "on" }, { retries: 1, backoff: 0, budget: 0.1, drop: "on" }]
          : [{ retries: 3, backoff: 1000, jitter: "none", budget: 0.1, drop: "on" }, { retries: 5, backoff: 1000, jitter: "full jitter", budget: 0.1, drop: "on" }, { retries: 3, backoff: 1000, jitter: "full jitter", budget: 0.1, drop: "on" }];
      const ok = cands.find((c) => !retryCheck(I, retryRun(I, c)).length);
      return ok || null;
    },
    bad: (I) => I.lv === 1 ? [{ retries: 0, backoff: 0, jitter: "none" }, { retries: 3, backoff: 0, jitter: "none" }] : I.lv === 2 ? [{ retries: 3, backoff: 200, budget: "none", drop: "off" }, { retries: 0, backoff: 0, budget: "none", drop: "on" }, { retries: 1, backoff: 200, budget: 0.1, drop: "off" }] : [{ retries: 1, backoff: 200, jitter: "full jitter", budget: 0.1, drop: "on" }, { retries: 0, backoff: 0, jitter: "none", budget: "none", drop: "on" }, { retries: 3, backoff: 1000, jitter: "none", budget: 0.1, drop: "off" }],
    hint: (I) => I.lv === 1 ? "Retries have to outlast the outage: how long do 3 attempts with exponential backoff span?" : I.lv === 2 ? "Retries during an overload add load exactly when there's none to spare. Cap them, and don't spend capacity on requests nobody is waiting for." : "You need enough retries to ride out the outage, a cap so they can't amplify the slowdown, and a server that sheds dead work.",
    concept: "Retry storms and metastable failure",
    how: "Retries turn transient failures into successes, but only if the retries outlast the failure: exponential backoff spreads attempts over time, and jitter keeps clients from retrying in synchronised waves. During an overload, every timeout becomes another request, so a slowdown can push offered load above capacity; the queue then holds requests whose callers already gave up, latency stays above the timeout, and the system stays down after the trigger is gone (a metastable failure). A retry budget (retries ≤ ~10% of requests) caps amplification, and dropping queued work past its deadline lets the server recover.",
    rule: "Exponential backoff with jitter, a retry budget per client, and servers that drop requests whose deadline has passed.",
    why: (I, sol) => { const r = retryRun(I, sol); return `With retries=${sol.retries}, backoff ${sol.backoff} ms${sol.jitter ? ", " + sol.jitter : ""}${sol.budget ? ", budget " + (sol.budget === "none" ? "none" : "10%") + ", drop " + sol.drop : ""}: success ${K.pct(I.lv === 1 ? r.succ : r.outside, 2)}, amplification ${r.amp.toFixed(2)}×${r.rec != null ? `, recovered ${r.rec} s after the dependency` : ""}.`; },
  });

  /* ================= tune: load shedding ================= */
  function shedRun(I, c) {
    const s0 = 8, s1 = 8 + I.surgeFor;
    return simQ({
      R: rng("shed/" + I.seed), dur: s1 + 8, rateAt: (t) => (t >= s0 && t < s1 ? I.rate * I.mult : I.rate), servers: 8, timeout: 1000,
      svcAt: (t, R) => K.exp(R, 40), queueMax: c.qmax === "unbounded" ? Infinity : c.qmax, dropExpired: c.drop === "on",
      retries: I.lv === 2 ? 2 : 0, backoff: 0, jitter: true,
      prio: I.lv === 3 ? { frac: 0.25, qLo: c.prio === "off" ? Infinity : c.prio } : null, win: [s0, s1], recFrom: s1,
    });
  }
  function shedCheck(I, r) {
    const out = [];
    if (I.lv === 3) { if (r.hi < 0.99) out.push(`only ${K.pct(r.hi, 1)} of checkout requests succeeded (target 99%)`); }
    else { const good = r.ser.good.slice(9, 8 + I.surgeFor).reduce((a, b) => a + b, 0) / (I.surgeFor - 1); if (good < 170) out.push(`only ${Math.round(good)} useful responses/s during the surge (target ≥ 170, capacity 200)`); }
    if (r.outside < 0.99) out.push(`${K.pct(1 - r.outside, 1)} of requests failed even outside the surge`);
    if (r.rec == null || r.rec > 2) out.push(r.rec == null ? "never recovered after the surge" : `took ${r.rec} s to recover after the surge`);
    if (I.lv === 2 && r.amp > 1.4) out.push(`retries multiplied edge traffic to ${r.amp.toFixed(2)}× (cap 1.4×)`);
    return out;
  }
  S.push({
    id: "data-load-shed",
    name: "Shed load before it sheds you",
    kind: "Config change",
    skills: ["tune", "design"],
    w: "tune",
    gen(lv, R) { return { lv, seed: R.int(1, 1e9), rate: R.pick([130, 140, 150]), mult: lv === 3 ? 3 : 2, surgeFor: R.pick([12, 15]) }; },
    text: (I) => `<p>The search API has 8 workers at ~40 ms per request (capacity ~200 req/s) and normally serves ${I.rate} req/s. A marketing push will send <b>${I.mult}× traffic for ${I.surgeFor} s</b>. Clients give up after 1 s.${I.lv === 2 ? " The mobile SDK retries timeouts and 503s twice, immediately, and you can't ship a new SDK before the push." : ""}${I.lv === 3 ? " 25% of requests are <b>checkout</b> calls that must keep working; the rest are browse calls you may shed." : ""}</p><p><b>Configure admission control</b> so the API keeps doing useful work through the surge and recovers immediately afterwards.</p>`,
    ui: (I) => {
      const knobs = [{ k: "qmax", label: "Max queue length (reject with 503 beyond)", opts: ["unbounded", 2000, 400, 150, 40, 5] }];
      if (I.lv > 1) knobs.push({ k: "drop", label: "Drop queued requests older than the client timeout", opts: ["off", "on"] });
      if (I.lv === 3) knobs.push({ k: "prio", label: "Shed browse requests when the queue exceeds", opts: ["off", 100, 20, 5] });
      return { knobs, live: (c) => { const r = shedRun(I, c), bad = shedCheck(I, r); return qChart(r) + K.chart([{ name: "queue length", pts: r.ser.q, cls: "bad" }], { h: 110, title: "max queue length per second" }) + K.metrics([{ name: "p99 of successes", value: K.ms(r.p99), ok: null }, { name: "rejected (503)", value: K.num(r.rej), ok: null }, ...(I.lv === 3 ? [{ name: "checkout success", value: K.pct(r.hi, 1), ok: r.hi >= 0.99, target: "≥ 99%" }, { name: "browse success", value: K.pct(r.lo, 1), ok: null }] : [])]) + (bad.length ? K.verdict(false, esc(bad[0])) : K.verdict(true, "Targets met.")); } };
    },
    valid: (I, c) => { const b = shedCheck(I, shedRun(I, c)); return b.length ? b[0] : true; },
    val: () => 1,
    hint: (I) => I.lv === 1 ? "A queue longer than capacity × timeout only holds requests that will be answered after the client has left." : I.lv === 2 ? "Every timeout comes back as two more requests. A fast 503 is cheaper than a slow timeout, and queued requests whose client has left are pure waste." : "Reserve capacity for what matters: shed the low-priority class first.",
    concept: "Load shedding and bounded queues",
    how: "When arrivals exceed capacity, an unbounded queue grows until every response arrives after the client has given up: the server stays 100% busy producing nothing useful (goodput collapse). Bounding the queue near capacity × timeout keeps admitted requests fast and rejects the rest cheaply with 503. Dropping requests whose deadline has passed avoids wasting work after a backlog. Rejections must not become retry storms: send Retry-After and have clients back off with jitter. With mixed traffic, shed by priority so critical requests keep their share.",
    rule: "Bound every queue by what you can serve within the caller's deadline, reject early and cheaply, and shed low-priority work first.",
    why: (I, sol) => { const r = shedRun(I, sol); return `With a queue limit of ${sol.qmax}${sol.drop ? `, drop ${sol.drop}` : ""}${sol.prio != null ? `, browse shed above ${sol.prio}` : ""}: p99 ${K.ms(r.p99)}, ${K.num(r.rej)} fast rejections${I.lv === 3 ? `, checkout success ${K.pct(r.hi, 1)}` : ""}.`; },
  });

  /* ================= tune: batching writes ================= */
  function batchModel(I, c) {
    const W = I.lv === 1 ? 1 : c.writers, lam = I.lam;
    const n = Math.max(1, Math.min(c.batch, (lam * c.interval) / 1000));
    const tf = n >= c.batch ? (c.batch / lam) * 1000 : c.interval;
    const st = lam / n, ws = I.o + n * I.r;
    const u = (st * ws) / 1000 / W;
    if (u >= 0.85) return { n, st, ws, u, behind: true };
    const m = K.mmc(st, 1000 / ws, W);
    const wq = m.wq * 1000;
    const fresh = tf + ws + 3 * wq;
    const risk = n * (1 + m.lq + u * W);
    return { n, st, ws, u, fresh, risk, behind: false };
  }
  const batchCheck = (I, r) => r.behind ? `the writer can't keep up (utilisation ${K.pct(r.u, 0)})` : r.fresh > I.F ? `p99 freshness ${K.ms(r.fresh)} is over ${I.F} ms` : I.lv === 3 && r.risk > I.risk ? `up to ${K.num(r.risk)} buffered rows would be lost in a crash (limit ${K.num(I.risk)})` : true;
  S.push({
    id: "data-batch-writes",
    name: "Batch the event writer",
    kind: "Config change",
    skills: ["tune", "estimate"],
    w: "tune",
    sense: "min",
    vname: "statements/s:",
    vfmt: (v) => K.num(v, 1),
    gen(lv, R) { return { lv, lam: lv === 1 ? R.pick([2000, 3000, 4000]) : R.pick([25000, 40000, 60000]), o: lv === 3 ? R.pick([8, 10, 12]) : R.pick([3, 4]), r: 0.03, F: lv === 1 ? 500 : lv === 2 ? 250 : 200, risk: R.pick([1500, 2500]) }; },
    text: (I) => `<p>An ingestion service receives <b>${K.num(I.lam)} events/s</b> and inserts them into Postgres one row per statement. Each statement costs about <b>${I.o} ms</b> of round trip and commit plus <b>${I.r} ms per row</b> (a multi-row INSERT or COPY). The writer has fallen hours behind.</p><p>Choose batching so events are queryable within <b>${I.F} ms (p99)</b>${I.lv === 3 ? ` and a crash loses at most <b>${K.num(I.risk)}</b> buffered events (the producer can't replay more)` : ""}, with the <b>fewest statements per second</b> (each one is load on the primary).</p>`,
    ui: (I) => ({ knobs: [{ k: "batch", label: "Max rows per batch", opts: [1, 10, 100, 500, 2000, 5000] }, { k: "interval", label: "Flush at least every", opts: [5, 20, 100, 500, 2000], unit: "ms" }, ...(I.lv > 1 ? [{ k: "writers", label: "Parallel writer connections", opts: [1, 2, 4, 8] }] : [])], live: (c) => { const r = batchModel(I, c), ok = batchCheck(I, r); return K.metrics([{ name: "rows per statement", value: K.num(r.n, 0), ok: null }, { name: "statements/s", value: K.num(r.st, 1), ok: null }, { name: "writer utilisation", value: K.pct(r.u, 0), ok: r.u < 0.85, target: "< 85%" }, { name: "p99 freshness", value: r.behind ? "∞" : K.ms(r.fresh), ok: !r.behind && r.fresh <= I.F, target: `≤ ${I.F} ms` }, ...(I.lv === 3 ? [{ name: "rows at risk", value: r.behind ? "∞" : K.num(r.risk), ok: !r.behind && r.risk <= I.risk, target: `≤ ${K.num(I.risk)}` }] : [])]) + (ok === true ? K.verdict(true, "Meets the targets.") : K.verdict(false, esc(ok))); } }),
    valid: (I, c) => batchCheck(I, batchModel(I, c)),
    val: (I, c) => Math.round(batchModel(I, c).st * 10) / 10,
    hint: (I) => I.lv === 1 ? "Per-statement overhead dominates single-row inserts. How many rows per statement does it take to amortise it?" : I.lv === 2 ? "A batch that waits too long to fill hurts freshness; parallel writers add throughput without making batches wait longer." : "Rows sitting in the buffer and in queued batches are lost on a crash. Bigger batches cut statements but raise that number.",
    concept: "Batching writes: throughput vs latency vs durability",
    how: "Every statement pays a fixed cost (network round trip, parse, commit and WAL flush) on top of per-row work, so single-row inserts top out at roughly 1000 / overhead-ms per connection. Batching N rows per statement divides the fixed cost by N. A batch is flushed when it's full or when a timer fires, so the wait to fill a batch adds to freshness; parallel writers add throughput without longer waits. Rows buffered in memory are lost if the process dies, so either size batches to what the source can replay or acknowledge to the producer only after the batch commits.",
    rule: "Flush on size or time, whichever comes first; size batches so the overhead is amortised but the fill wait and the crash-loss window stay within budget.",
    why: (I, sol) => { const r = batchModel(I, sol); return `Batches of up to ${sol.batch} rows flushed every ${sol.interval} ms${sol.writers ? ` on ${sol.writers} connection${sol.writers > 1 ? "s" : ""}` : ""} carry ~${K.num(r.n)} rows each: ${K.num(r.st, 1)} statements/s, p99 freshness ${K.ms(r.fresh)}${I.lv === 3 ? `, ${K.num(r.risk)} rows at risk` : ""}.`; },
  });

  /* ================= tune: key choice ================= */
  function keyModel(I, c) {
    const kb = c.pk === "bigint identity" ? 8 : 16, rndPk = c.pk === "UUIDv4";
    const idx = [{ name: "orders PK", key: kb, rnd: rndPk, rows: I.N }, { name: "order_items FK index", key: kb, rnd: rndPk, rows: I.N * 5 }];
    if (c.pub === "separate random UUIDv4 column") idx.push({ name: "public_id unique index", key: 16, rnd: true, rows: I.N });
    const ram = I.ram * 1e9;
    let iops = 0, wal = 0, gb = 0;
    idx.forEach((x) => { x.gb = (x.rows * (x.key + 16)) / (x.rnd ? 0.7 : 0.9) / 1e9; gb += x.gb; if (x.rnd) { const rate = x.name.startsWith("order_items") ? I.ins * 5 : I.ins; x.miss = Math.max(0, 1 - ram / 2 / (x.gb * 1e9)); iops += rate * x.miss; wal += (rate * 8192 * 0.5) / 1e6; } else x.miss = 0; });
    const viol = [];
    if (I.lv === 1 && c.pk === "bigint identity") viol.push("mobile clients must create ids offline; a database sequence can't hand them out");
    if (I.lv >= 2 && c.pub === "none (PK in URLs)" && c.pk === "bigint identity") viol.push("sequential ids in public URLs let anyone enumerate orders and estimate your volume");
    if (I.lv === 3 && c.pub === "none (PK in URLs)" && c.pk === "UUIDv7") viol.push("a UUIDv7 starts with a 48-bit millisecond timestamp, so public URLs would reveal when each order was created");
    if (I.lv === 1 && c.pub !== "none (PK in URLs)") viol.push("a second public id isn't needed here and costs a random index");
    return { idx, iops, wal, gb, viol };
  }
  S.push({
    id: "data-key-choice",
    name: "Choose the primary key type",
    kind: "Design review",
    skills: ["design", "estimate"],
    w: "tune",
    sense: "min",
    vname: "cost score",
    gen(lv, R) { return { lv, N: R.pick([1.5, 2, 3]) * 1e9, ins: R.pick([8000, 15000, 25000]), ram: R.pick([32, 48]) }; },
    text: (I) => `<p>A new <code>orders</code> table will hold <b>${K.num(I.N / 1e9, 1)} billion rows</b> (plus ~5 <code>order_items</code> each), taking <b>${K.num(I.ins)} inserts/s</b>. The database has about <b>${I.ram} GB</b> of RAM for caching indexes. ${I.lv === 1 ? "Orders are created by the mobile app while offline and synced later, so the client must generate the id." : I.lv === 2 ? "Order ids appear in public URLs; security says they must not be enumerable or reveal order volume." : "Order ids appear in public URLs; they must not be enumerable, and legal says they must not reveal when an order was placed."}</p><p><b>Pick the cheapest design that meets the requirements</b> (cost score = random-read IOPS + 50 × WAL MB/s from full-page writes + 10 × index GB).</p>`,
    ui: (I) => ({ knobs: [{ k: "pk", label: "Primary key", opts: ["bigint identity", "UUIDv4", "UUIDv7"] }, { k: "pub", label: "Id used in public URLs", opts: ["none (PK in URLs)", "separate random UUIDv4 column"] }], live: (c) => { const r = keyModel(I, c); return K.table(["index", "size", "insert pattern", "cache miss per insert"], r.idx.map((x) => [x.name, K.num(x.gb, 0) + " GB", x.rnd ? "random" : "append to right edge", K.pct(x.miss, 0)]), { compact: true }) + K.metrics([{ name: "random read IOPS", value: K.num(r.iops), ok: null }, { name: "extra WAL (FPW)", value: K.num(r.wal, 0) + " MB/s", ok: null }, { name: "index size", value: K.num(r.gb, 0) + " GB", ok: null }, { name: "cost score", value: K.num(Math.round(r.iops + 50 * r.wal + 10 * r.gb)), ok: null }]) + (r.viol.length ? K.verdict(false, esc(r.viol[0])) : K.verdict(true, "Meets the requirements.")); } }),
    valid: (I, c) => { const r = keyModel(I, c); return r.viol.length ? r.viol[0] : true; },
    val: (I, c) => { const r = keyModel(I, c); return Math.round(r.iops + 50 * r.wal + 10 * r.gb); },
    hint: (I) => I.lv === 1 ? "Some UUIDs are random; some are ordered by time. Which one inserts at the right edge of the B-tree?" : I.lv === 2 ? "Unguessable doesn't have to mean random insert order." : "If the public id can't contain a timestamp, it has to be random; keep the random index to one, and keep keys small where they're copied into child tables.",
    concept: "Key choice: locality, size and what ids reveal",
    how: "B-tree inserts with ever-increasing keys (identity, UUIDv7, ULID) touch the rightmost leaf page, which stays in cache. Random keys (UUIDv4) land on a random page anywhere in the index, so once the index outgrows RAM most inserts read a page from disk, pages split half-full, and after every checkpoint the first change to each page writes a full-page image to WAL. Key width matters too: every foreign key and secondary index copies it. Sequential integers leak volume and are enumerable in URLs; UUIDv7 is unguessable but embeds a millisecond timestamp. When ids must reveal nothing, keep a compact internal key and add a separate random public id.",
    rule: "Default to time-ordered keys (identity or UUIDv7) for locality; expose a random public id only when the URL must reveal nothing, and keep it to one random index.",
    why: (I, sol) => { const r = keyModel(I, sol); return `${sol.pk} with ${sol.pub === "none (PK in URLs)" ? "the PK in URLs" : "a separate random public id"}: ~${K.num(r.iops)} random reads/s, ${K.num(r.wal, 0)} MB/s of extra WAL, ${K.num(r.gb, 0)} GB of indexes.`; },
  });

  /* ================= tune: hot counters ================= */
  function counterModel(I, c) {
    const flush = I.lv === 3 ? c.buffer : "off";
    const writes = flush === "off" ? I.lam : I.inst * (1000 / flush);
    const N = c.shards, h = 2;
    const rho = (writes * h) / 1000 / N;
    const wq = rho >= 1 ? Infinity : (rho * h) / (2 * (1 - rho));
    const incP99 = rho >= 0.9 ? Infinity : h + 4.6 * wq + (flush === "off" ? 0 : 0);
    const readP99 = c.read === "sum shards" ? 1 + 0.04 * N : 0.5;
    const stale = (c.read === "sum shards" ? 0 : 1000) + (flush === "off" ? 0 : flush);
    return { writes, rho, incP99, readP99, stale };
  }
  const counterCheck = (I, r) => !Number.isFinite(r.incP99) ? `shard rows are saturated (${K.pct(Math.min(r.rho, 9.99), 0)} lock utilisation)` : r.incP99 > I.inc ? `increment p99 ${K.ms(r.incP99)} is over ${I.inc} ms` : r.readP99 > I.read ? `read p99 ${K.ms(r.readP99)} is over ${I.read} ms` : r.stale > I.stale ? `counts can be ${r.stale} ms stale (limit ${I.stale} ms)` : true;
  S.push({
    id: "data-hot-counter",
    name: "The like counter on a viral post",
    kind: "Incident",
    skills: ["tune", "design"],
    w: "tune",
    sense: "min",
    vname: "shards:",
    gen(lv, R) { return { lv, lam: lv === 1 ? R.pick([1500, 2000, 2500]) : lv === 2 ? R.pick([8000, 10000]) : R.pick([20000, 30000]), inc: 10, read: lv === 1 ? 5 : 2, stale: lv === 1 ? 2000 : lv === 2 ? 2000 : 300, inst: R.pick([20, 30, 40]), reads: lv === 1 ? 500 : 40000 }; },
    text: (I) => `<p>One post is going viral: <b>${K.num(I.lam)} likes/s</b>, each doing <code>UPDATE counters SET n = n + 1 WHERE post_id = $1</code>. Each update holds the row lock for ~2 ms until commit, so one row can absorb at most ~500 updates/s and like requests are timing out. The post is read <b>${K.num(I.reads)} times/s</b>.</p><p>Split the counter into N shard rows (each like updates a random one)${I.lv === 3 ? `; the ${I.inst} app instances could also buffer likes in memory and flush one delta per interval (a crash loses that interval's likes, which product accepts)` : ""}. Targets: increment p99 ≤ ${I.inc} ms, read p99 ≤ ${I.read} ms, counts at most ${I.stale} ms stale. <b>Use as few shards as possible.</b></p>`,
    ui: (I) => ({ knobs: [{ k: "shards", label: "Counter shards", opts: [1, 2, 4, 8, 16, 32, 64, 128] }, { k: "read", label: "Reads", opts: ["sum shards", "cached total, refreshed every 1 s"] }, ...(I.lv === 3 ? [{ k: "buffer", label: "Buffer likes in each app instance, flush every", opts: ["off", 50, 200], fmt: (v) => (v === "off" ? "off" : v + " ms") }] : [])], live: (c) => { const r = counterModel(I, c), ok = counterCheck(I, r); return K.metrics([{ name: "row updates/s", value: K.num(r.writes), ok: null }, { name: "lock utilisation per shard", value: K.pct(Math.min(r.rho, 9.99), 0), ok: r.rho < 0.9, target: "< 90%" }, { name: "increment p99", value: Number.isFinite(r.incP99) ? K.ms(r.incP99) : "timeouts", ok: r.incP99 <= I.inc, target: `≤ ${I.inc} ms` }, { name: "read p99", value: K.ms(r.readP99), ok: r.readP99 <= I.read, target: `≤ ${I.read} ms` }, { name: "staleness", value: r.stale + " ms", ok: r.stale <= I.stale, target: `≤ ${I.stale} ms` }]) + (ok === true ? K.verdict(true, "Meets the targets.") : K.verdict(false, esc(ok))); } }),
    valid: (I, c) => counterCheck(I, counterModel(I, c)),
    val: (I, c) => c.shards,
    hint: (I) => I.lv === 1 ? "Lock utilisation per row = updates/s × hold time ÷ shards. Keep it well under 1." : I.lv === 2 ? "Summing many shards on every read is too slow for this read rate; a slightly stale total is fine." : "Even 128 shards can't take this write rate inside the read budget. What if far fewer row updates reached the database?",
    concept: "Hot counters: sharding and buffering",
    how: "Every update to one row serialises on its row lock, so throughput per row ≈ 1 / lock-hold time, and queueing delay explodes as utilisation nears 100%. Sharding the counter into N rows divides the write rate per row by N, at the cost of reads that sum N rows. When reads are frequent, serve a cached total refreshed periodically. When writes are extreme, aggregate in the application and flush deltas, which turns thousands of increments into a few writes per second per instance, trading a small crash-loss window and staleness.",
    rule: "Keep per-row lock utilisation well below 1: shard to spread writes, cache or roll up for reads, and buffer increments when exact durability of each one doesn't matter.",
    why: (I, sol) => { const r = counterModel(I, sol); return `${sol.shards} shard${sol.shards > 1 ? "s" : ""}${sol.buffer && sol.buffer !== "off" ? `, buffering ${sol.buffer} ms per instance (${K.num(r.writes)} row updates/s)` : ""} with ${sol.read}: lock utilisation ${K.pct(r.rho, 0)}, increment p99 ${K.ms(r.incP99)}, read p99 ${K.ms(r.readP99)}.`; },
  });

  /* ================= tune: throttled backfill ================= */
  function backfillModel(I, c) {
    const t = 5 + c.batch * 0.1;
    let rate = (c.workers * c.batch) / (t + c.sleep) * 1000;
    const busy = (c.workers * t) / (t + c.sleep);
    let walMB = (rate * 1.5) / 1000;
    let lag = 0, guardSlow = 1;
    if (I.lv > 1) {
      const head = I.apply - I.prodPeak, headAvg = I.apply - I.prod;
      if (c.guard === "pause while lag > 2 s") { if (walMB > head) { guardSlow = Math.max(head, 0.01) / walMB; } lag = 2; }
      else if (walMB > head) lag = ((walMB - head) * (I.peakMin * 60)) / I.apply + (walMB > headAvg ? 9999 : 0);
    }
    const rateEff = rate * (c.guard === "pause while lag > 2 s" ? (0.8 + 0.2 * guardSlow) : 1);
    const hours = I.N / rateEff / 3600;
    return { t, rate: rateEff, busy, walMB, lag, hours };
  }
  const backfillCheck = (I, r) => r.t > 200 ? `each batch holds row locks for ${K.ms(r.t)}; requests touching those rows stall (limit 200 ms)` : r.busy > 2 ? `the backfill keeps ${r.busy.toFixed(1)} cores busy; production needs all but 2` : I.lv > 1 && r.lag > I.maxLag ? (r.lag > 9000 ? "replicas fall further behind all night" : `replica lag peaks at ${K.num(r.lag, 0)} s (limit ${I.maxLag} s)`) : r.hours > I.deadline ? `it would take ${K.num(r.hours, 1)} h (deadline ${I.deadline} h)` : true;
  S.push({
    id: "data-backfill-throttle",
    name: "Backfill without hurting production",
    kind: "Change plan",
    skills: ["tune", "safe"],
    w: "tune",
    gen(lv, R) { return { lv, N: (lv === 1 ? R.pick([120, 140, 160]) : lv === 2 ? R.pick([180, 200]) : R.pick([700, 800])) * 1e6, deadline: lv === 1 ? 3 : lv === 2 ? 6 : 24, apply: 40, prod: lv === 3 ? 18 : 12, prodPeak: lv === 3 ? 34 : 12, peakMin: 20, maxLag: lv === 2 ? 5 : 2 }; },
    text: (I) => `<p>You must fill a new column for <b>${K.num(I.N / 1e6)}M rows</b> within <b>${I.deadline} hours</b>, while the table serves live traffic. Each batch <code>UPDATE … WHERE id BETWEEN …</code> takes ~5 ms plus 0.1 ms per row (indexes included) and holds those rows' locks until it commits. Production can spare <b>2 cores</b>.${I.lv > 1 ? ` Every row writes ~1.5 KB of WAL; replicas apply <b>${I.apply} MB/s</b> and production already writes <b>${I.prod} MB/s</b>${I.lv === 3 ? `, rising to <b>${I.prodPeak} MB/s</b> for ~20 minutes during the nightly batch jobs` : ""}. Reads go to replicas, so lag must stay under <b>${I.maxLag} s</b>.` : ""}</p><p><b>Configure the backfill.</b></p>`,
    ui: (I) => ({ knobs: [{ k: "batch", label: "Rows per batch", opts: [500, 1000, 2000, 5000] }, { k: "sleep", label: "Sleep between batches", opts: [0, 50, 200, 1000], unit: "ms" }, { k: "workers", label: "Parallel workers", opts: [1, 2, 4, 8] }, ...(I.lv === 3 ? [{ k: "guard", label: "Replica-lag guard", opts: ["off", "pause while lag > 2 s"] }] : [])], live: (c) => { const r = backfillModel(I, c), ok = backfillCheck(I, r); return K.metrics([{ name: "lock time per batch", value: K.ms(r.t), ok: r.t <= 200, target: "≤ 200 ms" }, { name: "cores busy", value: r.busy.toFixed(2), ok: r.busy <= 2, target: "≤ 2" }, ...(I.lv > 1 ? [{ name: "WAL from backfill", value: K.num(r.walMB, 1) + " MB/s", ok: null }, { name: "replica lag", value: r.lag > 9000 ? "grows without bound" : K.num(r.lag, 1) + " s", ok: r.lag <= I.maxLag, target: `≤ ${I.maxLag} s` }] : []), { name: "duration", value: K.num(r.hours, 1) + " h", ok: r.hours <= I.deadline, target: `≤ ${I.deadline} h` }]) + (ok === true ? K.verdict(true, "Safe and on time.") : K.verdict(false, esc(ok))); } }),
    valid: (I, c) => backfillCheck(I, backfillModel(I, c)),
    val: () => 1,
    hint: (I) => I.lv === 1 ? "Small batches keep locks short; sleeping between them limits CPU. Then check the deadline." : I.lv === 2 ? "Replicas can only apply so much WAL; the backfill gets whatever production leaves." : "A fixed rate that's safe at the nightly peak is too slow for the deadline. Let the backfill slow down only when it has to.",
    concept: "Throttled, adaptive backfills",
    how: "A backfill competes with production for locks, CPU, I/O and replication bandwidth. Small batches keep each transaction short so row locks and long-running snapshots don't hurt live queries; sleeping between batches bounds CPU; parallel workers buy throughput back. Every changed row also produces WAL that replicas must replay, so the sustainable rate is what's left of the replicas' apply capacity after production's own writes, which varies over the day. Adaptive throttling (pause while replica lag or p99 is above a threshold) uses spare capacity off-peak without breaking things at peak.",
    rule: "Backfill in small, short transactions, throttle on live signals (replica lag, p99), make it resumable, and size it against the deadline.",
    why: (I, sol) => { const r = backfillModel(I, sol); return `${K.num(sol.batch)} rows per batch, ${sol.sleep} ms sleep, ${sol.workers} worker${sol.workers > 1 ? "s" : ""}${sol.guard ? `, guard ${sol.guard}` : ""}: ${K.ms(r.t)} per batch, ${r.busy.toFixed(2)} cores, ${K.num(r.hours, 1)} h${I.lv > 1 ? `, lag ≤ ${K.num(r.lag, 1)} s` : ""}.`; },
  });

  /* ================= tune: read-your-writes ================= */
  const RYW_D = [0.1, 0.5, 1, 2, 3, 5, 8, 20];
  const RYW_LAG = { 1: { 0.1: 0.3, 0.5: 0.05, 1: 0.01, 2: 0, 3: 0, 5: 0, 8: 0, 20: 0 }, 2: { 0.1: 0.4, 0.5: 0.1, 1: 0.05, 2: 0.03, 3: 0.02, 5: 0.01, 8: 0, 20: 0 } };
  const RYW_LOAD = { 1: 0.04, 2: 0.07, 5: 0.14, 10: 0.24, 30: 0.51 };
  function rywModel(I, c) {
    const lag = RYW_LAG[I.lv === 1 ? 1 : 2], f = 0.1, cross = I.lv === 3 ? 0.3 : 0;
    const pl = (d) => lag[d];
    const plus = (d, tau) => { const x = RYW_D.find((v) => v >= d + tau / 1000); return x == null ? 0 : lag[x]; };
    const userScope = c.scope === "per user (last-write LSN in Redis)";
    const prot = userScope ? 1 : 1 - cross;
    let stale = 0, load = 0, p99 = 6;
    const unprot = RYW_D.reduce((s, d) => s + pl(d), 0) / RYW_D.length;
    if (c.route === "all reads → replicas") stale = f * unprot;
    else if (c.route === "all reads → primary") load = 1;
    else if (c.route === "primary for a window after a write") { const w = c.window; stale = f * (prot * RYW_D.filter((d) => d >= w).reduce((s, d) => s + pl(d), 0) / RYW_D.length + (1 - prot) * unprot); load = RYW_LOAD[w]; }
    else { stale = f * (1 - prot) * unprot; load = f * prot * RYW_D.reduce((s, d) => s + plus(d, c.tau), 0) / RYW_D.length; const waitFrac = f * prot * RYW_D.reduce((s, d) => s + pl(d), 0) / RYW_D.length; p99 += waitFrac > 0.01 ? c.tau : 0; }
    if (userScope) p99 += 1;
    return { stale, load, p99 };
  }
  const rywCheck = (I, r) => r.stale > 1e-9 ? `${K.pct(r.stale, 2)} of reads show a user stale data right after their own write` : r.load > I.cap ? `the primary would serve ${K.pct(r.load, 0)} of reads (it can take ${K.pct(I.cap, 0)})` : r.p99 > 30 ? `read p99 ${K.ms(r.p99)} is over 30 ms` : true;
  S.push({
    id: "data-read-your-writes",
    name: "My edit disappeared",
    kind: "Design review",
    skills: ["design", "tune"],
    w: "tune",
    gen(lv, R) { return { lv, cap: R.pick([0.15, 0.2]) }; },
    text: (I) => `<p>Users edit their profile and the next page shows the old value; refreshing \"fixes\" it. Reads go to async replicas whose lag is usually ${I.lv === 1 ? "under 300 ms and never over 1.5 s" : "under 500 ms but spikes to 6 s during batch jobs"}. 10% of reads follow the user's own write within 0–20 s.${I.lv === 3 ? " <b>30% of those follow-up reads come from another device</b> (edit on the laptop, check on the phone)." : ""} The primary can absorb at most <b>${K.pct(I.cap, 0)}</b> of read traffic.</p><p><b>Choose a routing policy</b> so users always see their own writes, within the primary's capacity and a 30 ms read p99.</p>`,
    ui: (I) => ({ knobs: [{ k: "route", label: "Routing", opts: ["all reads → replicas", "all reads → primary", "primary for a window after a write", "wait for replica to reach the write's LSN"] }, { k: "window", label: "Window (for the window policy)", opts: [1, 2, 5, 10, 30], unit: "s" }, { k: "tau", label: "Max wait before falling back to the primary (LSN policy)", opts: [100, 500, 2000], unit: "ms" }, ...(I.lv === 3 ? [{ k: "scope", label: "Remember the last write", opts: ["per session (cookie)", "per user (last-write LSN in Redis)"] }] : [])], init: I.lv === 3 ? {} : { scope: "per session (cookie)" }, live: (c) => { const r = rywModel(I, c), ok = rywCheck(I, r); return K.table(["read delay after write", ...RYW_D.map((d) => d + " s")], [["P(replica lag > delay)", ...RYW_D.map((d) => K.pct(RYW_LAG[I.lv === 1 ? 1 : 2][d], 0))]], { compact: true }) + K.metrics([{ name: "stale own-write reads", value: K.pct(r.stale, 2), ok: r.stale <= 1e-9, target: "0" }, { name: "primary read share", value: K.pct(r.load, 1), ok: r.load <= I.cap, target: `≤ ${K.pct(I.cap, 0)}` }, { name: "read p99", value: K.ms(r.p99), ok: r.p99 <= 30, target: "≤ 30 ms" }]) + (ok === true ? K.verdict(true, "Users always see their own writes.") : K.verdict(false, esc(ok))); } }),
    valid: (I, c) => rywCheck(I, rywModel(I, c)),
    val: () => 1,
    hint: (I) => I.lv === 1 ? "How long after a write can a replica still be behind?" : I.lv === 2 ? "A window long enough to cover 6 s spikes sends too many reads to the primary. Can a read wait for exactly the data it needs?" : "A cookie only travels with one device.",
    concept: "Read-your-writes on replicated databases",
    how: "Async replicas lag the primary, so a user who writes and then reads from a replica can see the old value. Sending every read to the primary fixes it but defeats the replicas. Routing a user's reads to the primary for a short window after they write works if the window exceeds the worst lag, but the longer the window, the more load lands on the primary. The precise fix is causal: remember the WAL position (LSN) of the user's last write and have the replica wait until it has replayed past it (Postgres: compare pg_last_wal_replay_lsn()), falling back to the primary after a timeout. The token must follow the user, not the device.",
    rule: "Track the user's last-write position and route or wait on it; size any stickiness window from the lag distribution, not the median.",
    why: (I, sol) => { const r = rywModel(I, sol); return `${sol.route}${sol.route.startsWith("primary for") ? ` (${sol.window} s)` : sol.route.startsWith("wait") ? ` (fallback after ${sol.tau} ms)` : ""}${I.lv === 3 ? `, ${sol.scope}` : ""}: stale reads ${K.pct(r.stale, 2)}, primary share ${K.pct(r.load, 1)}, p99 ${K.ms(r.p99)}.`; },
  });

  /* ================= tune: event-sourcing snapshots ================= */
  function snapModel(I, c) {
    const every = c.every === "never" ? Infinity : c.every;
    const p99 = 3 + Math.min(I.E, every) * I.e;
    const after = I.lv === 3 && c.rebuild === "lazily, on first load" ? 3 + I.E * I.e : p99;
    const snapsPerSec = every === Infinity ? 0 : I.evps / every;
    const mbps = (snapsPerSec * I.size) / 1024;
    return { p99, after, snapsPerSec, mbps };
  }
  const snapCheck = (I, r) => r.p99 > I.L ? `loading a hot account takes ${K.ms(r.p99)} at p99 (target ${I.L} ms)` : r.after > I.L ? `right after the deploy, every first load replays the full history: ${K.ms(r.after)}` : I.lv > 1 && r.mbps > I.mb ? `snapshot writes cost ${K.num(r.mbps, 1)} MB/s (budget ${I.mb} MB/s)` : true;
  S.push({
    id: "data-es-snapshots",
    name: "Tune event-sourcing snapshots",
    kind: "Config change",
    skills: ["tune", "design"],
    w: "tune",
    sense: "min",
    vname: "snapshot writes/s:",
    vfmt: (v) => K.num(v, 1),
    gen(lv, R) { return { lv, E: R.pick([200000, 400000, 800000]), e: R.pick([0.02, 0.03]), evps: R.pick([3000, 5000, 8000]), size: lv === 1 ? 4 : R.pick([60, 120]), L: lv === 1 ? 50 : 30, mb: lv === 1 ? 1e9 : R.pick([20, 40]) }; },
    text: (I) => `<p>Account aggregates are event-sourced: loading one replays its events (${I.e} ms each) on top of the latest snapshot (~3 ms to load). The busiest accounts have <b>${K.num(I.E)}</b> events; the system appends <b>${K.num(I.evps)} events/s</b> overall. Snapshots are ~${I.size} KB.${I.lv > 1 ? ` The event store's write budget for snapshots is <b>${I.mb} MB/s</b>.` : ""}${I.lv === 3 ? " Next week's release changes the snapshot format, so every existing snapshot becomes unreadable." : ""}</p><p>Keep p99 load time under <b>${I.L} ms</b> with the <b>fewest snapshot writes</b>.</p>`,
    ui: (I) => ({ knobs: [{ k: "every", label: "Snapshot every N events", opts: ["never", 100, 500, 1000, 2000, 10000] }, ...(I.lv === 3 ? [{ k: "rebuild", label: "After a snapshot-format change, rebuild", opts: ["lazily, on first load", "eagerly, with a background job before switching reads"] }] : [])], live: (c) => { const r = snapModel(I, c), ok = snapCheck(I, r); return K.metrics([{ name: "p99 load", value: K.ms(r.p99), ok: r.p99 <= I.L, target: `≤ ${I.L} ms` }, ...(I.lv === 3 ? [{ name: "p99 load after deploy", value: K.ms(r.after), ok: r.after <= I.L, target: `≤ ${I.L} ms` }] : []), { name: "snapshot writes/s", value: K.num(r.snapsPerSec, 1), ok: null }, { name: "snapshot MB/s", value: K.num(r.mbps, 1), ok: I.lv === 1 ? null : r.mbps <= I.mb, target: I.lv === 1 ? "" : `≤ ${I.mb}` }]) + (ok === true ? K.verdict(true, "Meets the targets.") : K.verdict(false, esc(ok))); } }),
    valid: (I, c) => snapCheck(I, snapModel(I, c)),
    val: (I, c) => Math.round(snapModel(I, c).snapsPerSec * 10) / 10,
    hint: (I) => I.lv === 1 ? "Worst case, a load replays (N − 1) events after the last snapshot." : I.lv === 2 ? "Snapshots too often blow the write budget; too rarely blows the load time." : "An unreadable snapshot is no snapshot: what does the first load after the deploy cost?",
    concept: "Snapshots in event-sourced systems",
    how: "Rebuilding an aggregate replays every event since its last snapshot, so load time grows with history length. Snapshotting every N events bounds replay to N − 1 events, at the cost of writing a snapshot every N events. Snapshots are a cache: they can be thrown away and rebuilt from events, which is exactly what happens when their format changes. Rebuild them in the background (versioned snapshots side by side) before switching readers, or the first load of every busy aggregate replays its entire history.",
    rule: "Pick the snapshot interval from the load-time budget, version snapshot formats, and rebuild them ahead of the switch.",
    why: (I, sol) => { const r = snapModel(I, sol); return `Snapshotting every ${sol.every} events bounds replay to ${K.num(sol.every - 1)} events: p99 ≈ ${K.ms(r.p99)}, ${K.num(r.snapsPerSec, 1)} snapshots/s (${K.num(r.mbps, 1)} MB/s).${I.lv === 3 ? " Eager rebuild keeps the post-deploy load time inside the budget." : ""}`; },
  });

  /* ================= tune: idempotency design ================= */
  const IDC = {
    a: ["The app times out after 3 s and retries the same checkout", (c) => c.src === "client key per checkout intent (reused on retry)" || c.src === "hash of request body"],
    b: ["A customer deliberately buys the same $4 coffee twice in a minute", (c) => c.src !== "hash of request body"],
    c: ["The retry lands on a different app instance after a deploy restarted the first", (c) => c.store !== "in-process cache"],
    e: ["Two merchants' integrations both generate the key \"order-1001\"", (c) => c.scope === "per merchant account"],
    d: ["A phone queues the request offline and retries 30 hours later", (c) => c.ttl === "7 days"],
    f: ["Redis fails over and loses the last second of writes; the retry arrives 2 s later", (c) => c.store === "DB row, in the charge's transaction"],
    g: ["A buggy client reuses a key with a different amount", (c) => c.mismatch === "reject with 422"],
  };
  const idcCases = (lv) => lv === 1 ? ["a", "b", "c"] : lv === 2 ? ["a", "b", "c", "e"] : ["a", "b", "c", "e", "d", "f", "g"];
  const idcCost = (c) => ({ "in-process cache": 0, "Redis SET NX with TTL": 1, "DB row, in the charge's transaction": 3 })[c.store] + ({ "1 hour": 0, "24 hours": 1, "7 days": 2 })[c.ttl];
  S.push({
    id: "data-idem-design",
    name: "Design the idempotency key",
    kind: "Design review",
    skills: ["design", "safe"],
    w: "tune",
    sense: "min",
    vname: "cost:",
    gen(lv, R) { return { lv, api: R.pick(["payments", "checkout", "payouts"]) }; },
    text: (I) => `<p>You're adding idempotency to <code>POST /v1/${I.api}</code>. Choose where the key comes from, how it's scoped and stored, how long it lives${I.lv === 3 ? ", and what happens when a key is reused with a different body" : ""}. The panel replays the test cases against your design. <b>Pass them all with the cheapest storage and retention</b> (in-process 0, Redis 1, DB row 3; TTL 1 h 0, 24 h 1, 7 d 2).</p>`,
    ui: (I) => ({ knobs: [{ k: "src", label: "Key source", opts: ["server-generated per request", "client key per attempt", "client key per checkout intent (reused on retry)", "hash of request body"] }, { k: "scope", label: "Key scope", opts: ["global", "per merchant account"] }, { k: "store", label: "Storage", opts: ["in-process cache", "Redis SET NX with TTL", "DB row, in the charge's transaction"] }, { k: "ttl", label: "Retention", opts: ["1 hour", "24 hours", "7 days"] }, { k: "mismatch", label: "Same key, different body", opts: ["ignore (return stored response)", "reject with 422"] }],
      live: (c) => K.table(["case", "outcome"], idcCases(I.lv).map((k) => [esc(IDC[k][0]), IDC[k][1](c) ? '<span class="win">handled</span>' : '<span class="lose">wrong charge or wrong response</span>']), { compact: true }) + K.metrics([{ name: "cost", value: String(idcCost(c)), ok: null }]) }),
    valid: (I, c) => { const f = idcCases(I.lv).find((k) => !IDC[k][1](c)); return f ? `fails: ${IDC[f][0]}` : true; },
    val: (I, c) => idcCost(c),
    hint: (I) => I.lv === 1 ? "The key must be the same on every retry of one purchase and different for two purchases." : I.lv === 2 ? "Keys are chosen by clients you don't control." : "Some retries arrive much later, some stores lose writes, and some clients are buggy.",
    concept: "Designing idempotency keys",
    how: "An idempotency key names one logical operation: the client generates it when the user commits to the action and reuses it on every retry. Server-generated or per-attempt keys change on retry; hashing the body merges genuinely separate identical purchases. Keys are chosen by clients, so scope them per account or two customers' keys collide and one gets the other's response. Store the key durably for as long as retries can arrive: in-process caches vanish on restart, async-replicated caches can lose acknowledged writes on failover, and a row written in the same transaction as the charge record can't disagree with it. Reject a reused key with a different body instead of replaying a response for a different request.",
    rule: "Client-generated key per intent, scoped per account, stored as durably and as long as the side effect matters, and bound to a hash of the request.",
    why: (I, sol) => `Passing design: ${esc(sol.src)}, ${esc(sol.scope)}, ${esc(sol.store)}, ${esc(sol.ttl)}, ${esc(sol.mismatch)} (cost ${idcCost(sol)}).`,
  });

  /* ================= real SQL (PGlite) ================= */
  const oneStmt = (sql, kinds) => {
    const t = String(sql || "").trim().replace(/;\s*$/, "");
    if (!t) return "Write a statement first.";
    if (/;/.test(t.replace(/'[^']*'/g, ""))) return "One statement only, please.";
    if (!kinds.test(t)) return `Write ${kinds === RX_SEL ? "a SELECT (or WITH … SELECT)" : kinds === RX_INS ? "an INSERT (or WITH … INSERT)" : "a DELETE (or WITH … DELETE)"} statement.`;
    return LB.sql.guard(t);
  };
  const RX_SEL = /^(select|with)\b/i, RX_INS = /^(insert|with)\b/i, RX_DEL = /^(delete|with)\b/i;
  const vals = (rows) => rows.map((r) => Object.values(r));
  const rowsHTML = (res) => LB.sql.table(res, 10);
  // A SELECT graded by result-set equality against a reference on the same data.
  function sqlSelect(o) {
    const grade = (I, sql) => LB.sql.session(async (db) => {
      const bad = oneStmt(sql, RX_SEL); if (bad) return { msg: bad };
      await db.exec(o.setup(I));
      const ref = await db.q(o.ref(I));
      let res;
      try { res = await db.q(sql.trim().replace(/;\s*$/, "")); } catch (e) { return { msg: "Postgres: " + esc(e.message) }; }
      if (o.cols && res.fields.length !== o.cols) return { res, msg: `Return exactly ${o.cols} column${o.cols > 1 ? "s" : ""} (${o.colNames}).` };
      const same = LB.sql.sameRows(res.rows, ref.rows, !!o.ordered);
      if (!same) return { res, msg: o.diag ? o.diag(I, res.rows, ref.rows) : `Your query returns ${res.rows.length} row${res.rows.length === 1 ? "" : "s"}; the correct answer has ${ref.rows.length}${o.ordered ? " (order matters)" : ""}.` };
      if (o.extra) { const x = await o.extra(db, I, sql); if (x !== true) return { res, msg: x }; }
      return { res, ok: true };
    });
    return {
      w: "code",
      ui: (I) => ({ lang: "sql", rows: o.rows || 6, ph: o.ph || "SELECT ...", starter: o.starter ? o.starter(I) : "", liveDelay: 900, live: async (sql) => {
        if (!sql || !sql.trim()) return `<p class="muted small">Write a query to run it against the real data.</p>`;
        try { const g = await grade(I, sql); return (g.res ? rowsHTML(g.res) : "") + (g.ok ? K.verdict(true, "Matches the expected result.") : `<p class="lose small">${g.msg}</p>`); } catch (e) { return `<p class="lose small">${esc(e.message)}</p>`; }
      } }),
      async accept(I, sql) { let g; try { g = await grade(I, sql); } catch (e) { return "Couldn't run it: " + esc(e.message); } return g.ok ? true : g.msg; },
      solve: (I) => o.ref(I),
      ...o,
    };
  }
  // Statements that change data, graded by running them and comparing the final state with the reference's.
  function sqlApply(o) {
    const final = (I, sql) => LB.sql.session(async (db) => {
      await db.exec(o.setup(I));
      try { await o.apply(db, I, sql); } catch (e) { return { err: e.message }; }
      const r = await db.q(o.state(I));
      return { rows: r.rows, res: r };
    });
    const grade = async (I, sql) => {
      const bad = o.guard(sql); if (bad) return { msg: bad };
      const ref = await final(I, o.ref(I)), got = await final(I, sql);
      if (got.err) return { msg: "Postgres: " + esc(got.err) };
      if (!LB.sql.sameRows(got.rows, ref.rows, false)) return { res: got.res, msg: o.diag ? o.diag(I, got.rows, ref.rows) : "The resulting table isn't right." };
      return { res: got.res, ok: true };
    };
    return {
      w: "code",
      ui: (I) => ({ lang: "sql", rows: o.rows || 6, ph: o.ph, starter: o.starter ? o.starter(I) : "", liveDelay: 900, live: async (sql) => {
        if (!sql || !sql.trim()) return `<p class="muted small">Write the statement to replay it against the test data.</p>`;
        try { const g = await grade(I, sql); return (g.res ? `<div class="muted small">${esc(o.stateLabel)}</div>` + rowsHTML(g.res) : "") + (g.ok ? K.verdict(true, "Final state matches.") : `<p class="lose small">${g.msg}</p>`); } catch (e) { return `<p class="lose small">${esc(e.message)}</p>`; }
      } }),
      async accept(I, sql) { let g; try { g = await grade(I, sql); } catch (e) { return "Couldn't run it: " + esc(e.message); } return g.ok ? true : g.msg; },
      solve: (I) => o.ref(I),
      ...o,
    };
  }

  const postsSetup = (I) => `CREATE TABLE posts (id bigint PRIMARY KEY, author_id int NOT NULL, created_at timestamptz NOT NULL, body text NOT NULL);
INSERT INTO posts SELECT g, g % 97, timestamptz '2026-09-01' + (g / 7) * interval '1 minute', 'post ' || g FROM generate_series(1, ${I.n}) g;
CREATE INDEX posts_created_id ON posts (created_at, id);
INSERT INTO posts SELECT ${I.n} + g, 1, now(), 'brand new' FROM generate_series(1, 5) g;`;
  const tsOf = (g) => { const d = new Date(Date.UTC(2026, 8, 1) + Math.floor(g / 7) * 60000); return d.toISOString().replace("T", " ").replace(".000Z", "+00"); };
  S.push({
    id: "data-keyset-sql",
    name: "Write the next-page query",
    kind: "Code review",
    skills: ["design", "tune"],
    ...sqlSelect({
      setup: postsSetup,
      ref: (I) => I.lv === 1 ? `SELECT id, created_at FROM posts WHERE id < ${I.g} ORDER BY id DESC LIMIT 20` : `SELECT id, created_at FROM posts WHERE (created_at, id) < ('${I.ts}', ${I.g}) ORDER BY created_at DESC, id DESC LIMIT 20`,
      ordered: true,
      diag: (I, got, ref) => { const gi = got.map((r) => +r.id), ri = ref.map((r) => +r.id); const miss = ri.filter((x) => !gi.includes(x)), extra = gi.filter((x) => !ri.includes(x)); return miss.length ? `Your page is missing post${miss.length > 1 ? "s" : ""} ${miss.slice(0, 4).map((x) => "#" + x).join(", ")}${I.lv > 1 ? " (they share the cursor's created_at)" : ""}.` : extra.length ? `Your page includes ${extra.slice(0, 4).map((x) => "#" + x).join(", ")}, which ${I.lv > 1 ? "the user already saw or" : ""} shouldn't be on this page.` : "Right rows, wrong order."; },
      extra: async (db, I, sql) => { if (I.lv < 3) return true; const r = await db.q("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql.trim().replace(/;\s*$/, "")); const v = r.rows[0]["QUERY PLAN"]; const plan = (typeof v === "string" ? JSON.parse(v) : v)[0].Plan; const b = (plan["Shared Hit Blocks"] || 0) + (plan["Shared Read Blocks"] || 0); return b <= 12 ? true : `Correct rows, but the plan (<code>${esc(LB.sql.planLine(plan))}</code>) touched ${b} buffers; the budget is 12. Write the condition so the index can seek straight to the cursor.`; },
      rows: 5,
    }),
    gen(lv, R) { const n = lv === 3 ? 40000 : 20000; let g; do g = R.int(n * 0.3, n * 0.7); while (g % 7 === 0 || g % 7 === 6); return { lv, n, g, ts: tsOf(g) }; },
    text: (I) => `<p>The feed shows posts newest first, 20 per page, ordered by <code>${I.lv === 1 ? "id DESC" : "created_at DESC, id DESC"}</code>. Bulk imports mean <b>many posts share a created_at</b>. The last post on the page the client just showed is <b>#${I.g}</b>${I.lv > 1 ? ` with <code>created_at = '${I.ts}'</code>` : ""}, and five new posts have arrived since.</p><p><b>Write the query for the next page</b> (return <code>id, created_at</code>). It runs on a real Postgres with ${K.num(I.n)} posts and an index on <code>(created_at, id)</code>${I.lv === 3 ? "; it must touch at most 12 buffers" : ""}.</p>`,
    bad: (I) => I.lv === 1 ? [`SELECT id, created_at FROM posts ORDER BY id DESC LIMIT 20 OFFSET 20`] : [`SELECT id, created_at FROM posts WHERE created_at < '${I.ts}' ORDER BY created_at DESC, id DESC LIMIT 20`, `SELECT id, created_at FROM posts WHERE created_at <= '${I.ts}' AND id <> ${I.g} ORDER BY created_at DESC, id DESC LIMIT 20`, ...(I.lv === 3 ? [`SELECT id, created_at FROM posts WHERE created_at < '${I.ts}' OR (created_at = '${I.ts}' AND id < ${I.g}) ORDER BY created_at DESC, id DESC LIMIT 20`] : [])],
    hint: (I) => I.lv === 1 ? "Ask for rows strictly after the cursor in sort order, not for a page number." : I.lv === 2 ? "created_at alone isn't unique. Postgres compares row values lexicographically: (a, b) < (x, y)." : "An OR of two conditions is hard for the planner to turn into one index range; a row comparison is a single range on (created_at, id).",
    concept: "Keyset pagination in SQL",
    how: "A keyset query asks for rows strictly after the last row seen, in the same order: <code>WHERE (created_at, id) &lt; (:ts, :id) ORDER BY created_at DESC, id DESC LIMIT n</code>. Including the unique id makes the cursor unambiguous when sort values tie. Postgres compares row constructors lexicographically and can use them as a single index range condition on a matching composite index, so the query reads only the rows it returns at any depth. The equivalent OR form returns the same rows but usually can't be used as one index range, and OFFSET both drifts with new rows and gets slower with depth.",
    rule: "Cursor = the full sort key including a unique tie-breaker; filter with a row comparison that matches a composite index and its order.",
    why: (I, sol) => `Reference: <code>${esc(sol)}</code>.`,
  });

  const softSetup = () => `CREATE TABLE users (id serial PRIMARY KEY, tenant_id int NOT NULL DEFAULT 1, email text NOT NULL, deleted_at timestamptz);
INSERT INTO users (tenant_id, email, deleted_at) VALUES (1, 'ann@acme.test', '2026-05-01'), (1, 'bob@acme.test', NULL), (1, 'Cara@acme.test', NULL), (1, 'dan@acme.test', '2026-02-01'), (1, 'dan@acme.test', '2026-03-01'), (2, 'bob@acme.test', '2026-04-01');`;
  const SOFT_TESTS = [
    [1, "ann signs up again after deleting her account", "INSERT INTO users (email) VALUES ('ann@acme.test')", true],
    [1, "a second live bob@acme.test", "INSERT INTO users (email) VALUES ('bob@acme.test')", false],
    [1, "dan signs up again (two deleted copies exist)", "INSERT INTO users (email) VALUES ('dan@acme.test')", true],
    [2, "BOB@acme.test while bob@acme.test is live", "INSERT INTO users (email) VALUES ('BOB@acme.test')", false],
    [2, "cara@acme.test while Cara@acme.test is live", "INSERT INTO users (email) VALUES ('cara@acme.test')", false],
    [3, "bob@acme.test in tenant 2", "INSERT INTO users (tenant_id, email) VALUES (2, 'bob@acme.test')", true],
    [3, "Ann deletes her account again (second deleted copy)", "UPDATE users SET deleted_at = now() WHERE email = 'ann@acme.test' AND deleted_at IS NULL", true],
  ];
  const softGuard = (sql) => { const st = String(sql || "").split(";").map((x) => x.trim()).filter(Boolean); if (!st.length) return "Write at least one CREATE UNIQUE INDEX (or ALTER TABLE … ADD CONSTRAINT … UNIQUE) statement."; for (const x of st) if (!/^(create\s+unique\s+index|alter\s+table\s+\w+\s+add\s+(constraint\s+\w+\s+)?unique)\b/i.test(x)) return `Only unique indexes or constraints are allowed here; found <code>${esc(x.slice(0, 60))}</code>.`; return LB.sql.guard(sql); };
  const softRun = (I, sql) => LB.sql.session(async (db) => {
    await db.exec(softSetup());
    try { await db.exec(sql); } catch (e) { return { err: e.message }; }
    const out = [];
    for (const [lv, name, stmt, want] of SOFT_TESTS.filter((x) => x[0] <= I.lv)) { let ok = true; try { await db.exec(stmt); } catch (e) { ok = false; } out.push({ name, want, ok, pass: ok === want }); void lv; }
    return { out };
  });
  S.push({
    id: "data-soft-delete-unique",
    name: "Let deleted users sign up again",
    kind: "Hardening",
    skills: ["design"],
    w: "code",
    gen(lv, R) { return { lv, n: R.int(1, 9) }; },
    text: (I) => `<p>Accounts are soft-deleted (<code>deleted_at</code> is set). A unique constraint on <code>email</code> stops people who deleted their account from signing up again, so it was dropped, and now duplicates of live emails are creeping in.${I.lv >= 2 ? " Emails must be unique <b>case-insensitively</b> (<code>Bob@…</code> and <code>bob@…</code> are the same person)." : ""}${I.lv === 3 ? " The table is multi-tenant: uniqueness applies <b>within each <code>tenant_id</code></b>, and a user may delete and re-create their account many times." : ""}</p>${K.pre("users (id serial, tenant_id int, email text, deleted_at timestamptz)  -- existing rows include deleted duplicates")}<p><b>Write the unique index(es)</b>. They're built on a real Postgres with the existing rows, then the test cases in the panel run.</p>`,
    ui: (I) => ({ lang: "sql", rows: 4, ph: "CREATE UNIQUE INDEX ...", liveDelay: 900, live: async (sql) => {
      if (!sql || !sql.trim()) return `<p class="muted small">Write an index definition to run the tests.</p>`;
      const g = softGuard(sql); if (g) return `<p class="lose small">${g}</p>`;
      const r = await softRun(I, sql);
      if (r.err) return `<p class="lose small">Postgres: ${esc(r.err)}</p>`;
      return K.table(["test", "expected", "got"], r.out.map((x) => [esc(x.name), x.want ? "allowed" : "rejected", `<span class="${x.pass ? "win" : "lose"}">${x.ok ? "allowed" : "rejected"}</span>`]), { compact: true });
    } }),
    async accept(I, sql) { const g = softGuard(sql); if (g) return g; const r = await softRun(I, sql); if (r.err) return "Postgres: " + esc(r.err); const f = r.out.find((x) => !x.pass); return f ? `Test failed: <b>${esc(f.name)}</b> was ${f.ok ? "allowed" : "rejected"}.` : true; },
    solve: (I) => I.lv === 1 ? "CREATE UNIQUE INDEX users_email_live ON users (email) WHERE deleted_at IS NULL;" : I.lv === 2 ? "CREATE UNIQUE INDEX users_email_live ON users (lower(email)) WHERE deleted_at IS NULL;" : "CREATE UNIQUE INDEX users_email_live ON users (tenant_id, lower(email)) WHERE deleted_at IS NULL;",
    bad: (I) => ["CREATE UNIQUE INDEX ON users (email);", "CREATE UNIQUE INDEX ON users (email, deleted_at);", ...(I.lv >= 2 ? ["CREATE UNIQUE INDEX ON users (email) WHERE deleted_at IS NULL;"] : []), ...(I.lv === 3 ? ["CREATE UNIQUE INDEX ON users (lower(email)) WHERE deleted_at IS NULL;"] : [])],
    hint: (I) => I.lv === 1 ? "A partial index only covers rows matching its WHERE clause." : I.lv === 2 ? "Unique indexes can be built on expressions." : "Put the tenant in the key, and remember that NULLs are distinct in unique indexes by default.",
    concept: "Partial and expression unique indexes",
    how: "A partial unique index (<code>CREATE UNIQUE INDEX … WHERE deleted_at IS NULL</code>) enforces uniqueness only among live rows, so soft-deleted rows don't block re-registration and any number of deleted copies can exist. An expression index on <code>lower(email)</code> makes uniqueness case-insensitive (or use the citext type or a nondeterministic collation). Including <code>deleted_at</code> in the key doesn't work by default because NULLs are distinct in unique indexes, so live duplicates (all NULL) pass. Lookups must use the same expression and predicate to use the index.",
    rule: "Express 'unique among live rows' as a partial unique index on exactly the normalised key you mean, scoped by tenant.",
    why: (I, sol) => `Reference: <code>${esc(sol)}</code>`,
  });

  const UPS = {
    1: { setup: "CREATE TABLE page_views (page_id int PRIMARY KEY, views bigint NOT NULL);", state: "SELECT page_id, views FROM page_views ORDER BY page_id", ph: "INSERT INTO page_views ... -- use :page",
      ref: "INSERT INTO page_views (page_id, views) VALUES (:page, 1) ON CONFLICT (page_id) DO UPDATE SET views = page_views.views + 1",
      bad: ["INSERT INTO page_views (page_id, views) VALUES (:page, 1) ON CONFLICT (page_id) DO UPDATE SET views = excluded.views", "INSERT INTO page_views (page_id, views) VALUES (:page, 1) ON CONFLICT DO NOTHING"] },
    2: { setup: "CREATE TABLE prices (sku text PRIMARY KEY, price numeric(10,2) NOT NULL, as_of timestamptz NOT NULL);", state: "SELECT sku, price, as_of FROM prices ORDER BY sku", ph: "INSERT INTO prices ... -- use :sku, :price, :as_of",
      ref: "INSERT INTO prices (sku, price, as_of) VALUES (:sku, :price, :as_of) ON CONFLICT (sku) DO UPDATE SET price = excluded.price, as_of = excluded.as_of WHERE prices.as_of < excluded.as_of",
      bad: ["INSERT INTO prices (sku, price, as_of) VALUES (:sku, :price, :as_of) ON CONFLICT (sku) DO UPDATE SET price = excluded.price, as_of = excluded.as_of"] },
    3: { setup: "CREATE TABLE stock (sku text PRIMARY KEY, qty int NOT NULL); CREATE TABLE applied (event_id text PRIMARY KEY);", state: "SELECT sku, qty FROM stock ORDER BY sku", ph: "WITH ... INSERT ... -- use :event_id, :sku, :delta",
      ref: "WITH ins AS (INSERT INTO applied (event_id) VALUES (:event_id) ON CONFLICT DO NOTHING RETURNING event_id) INSERT INTO stock (sku, qty) SELECT :sku, :delta FROM ins ON CONFLICT (sku) DO UPDATE SET qty = stock.qty + excluded.qty",
      bad: ["INSERT INTO stock (sku, qty) VALUES (:sku, :delta) ON CONFLICT (sku) DO UPDATE SET qty = stock.qty + excluded.qty"] },
  };
  const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const fill = (sql, ev) => sql.replace(/(^|[^:]):(page|sku|price|as_of|event_id|delta)\b/g, (m, pre, k) => pre + (k === "as_of" ? `timestamptz ${lit(ev[k])}` : k === "price" ? `${lit(ev[k])}::numeric` : k === "delta" || k === "page" ? `${ev[k]}::int` : lit(ev[k])));
  S.push({
    id: "data-upsert-sql",
    name: "Write the upsert",
    kind: "Code review",
    skills: ["design"],
    ...sqlApply({
      setup: (I) => UPS[I.lv].setup,
      state: (I) => UPS[I.lv].state,
      stateLabel: "Table after replaying the event stream:",
      guard: (sql) => oneStmt(sql, RX_INS),
      apply: async (db, I, sql) => { for (const ev of I.events) await db.exec(fill(sql.trim().replace(/;\s*$/, ""), ev)); },
      ref: (I) => UPS[I.lv].ref,
      ph: "INSERT ...",
      diag: (I, got, ref) => `After replaying ${I.events.length} events your table has ${got.length} row${got.length === 1 ? "" : "s"}: ${got.slice(0, 3).map((r) => Object.values(r).map((v) => (v instanceof Date ? v.toISOString().slice(0, 16) : v)).join(" / ")).join("; ")}…, but should hold ${ref.slice(0, 3).map((r) => Object.values(r).map((v) => (v instanceof Date ? v.toISOString().slice(0, 16) : v)).join(" / ")).join("; ")}…`,
      rows: 5,
    }),
    gen(lv, R) {
      const events = [];
      if (lv === 1) { for (let k = 0; k < 14; k++) events.push({ page: R.int(1, 4) }); }
      if (lv === 2) { const skus = ["A-1", "B-2", "C-3"]; for (let k = 0; k < 10; k++) events.push({ sku: R.pick(skus), price: (R.int(500, 5000) / 100).toFixed(2), as_of: `2026-10-0${R.int(1, 9)} ${String(R.int(10, 23))}:${String(R.int(10, 59))}:00+00` }); }
      if (lv === 3) { const skus = ["A-1", "B-2"]; for (let k = 0; k < 9; k++) { const e = { event_id: "ev-" + (100 + k), sku: R.pick(skus), delta: R.pick([-2, -1, 3, 5, 10]) }; events.push(e); if (R.chance(0.4)) events.push({ ...e }); } }
      return { lv, events };
    },
    text: (I) => I.lv === 1 ? `<p>Count page views: for each event, insert the page with 1 view or add one to its count. Write <b>one statement</b> using the placeholder <code>:page</code>; it's replayed for each of ${I.events.length} events.</p>${K.pre("page_views (page_id int PRIMARY KEY, views bigint)")}`
      : I.lv === 2 ? `<p>A price feed sends <code>(sku, price, as_of)</code> updates <b>out of order</b> (retries, parallel consumers). Keep the price with the newest <code>as_of</code>. Write one statement using <code>:sku</code>, <code>:price</code>, <code>:as_of</code>; it's replayed for ${I.events.length} events.</p>${K.pre("prices (sku text PRIMARY KEY, price numeric(10,2), as_of timestamptz)")}`
        : `<p>Stock movements <code>(event_id, sku, delta)</code> arrive <b>at least once</b>: some are redelivered. Apply each event exactly once, creating the stock row if needed. Write <b>one statement</b> using <code>:event_id</code>, <code>:sku</code>, <code>:delta</code>; it's replayed for ${I.events.length} deliveries.</p>${K.pre("stock   (sku text PRIMARY KEY, qty int)\napplied (event_id text PRIMARY KEY)")}`,
    bad: (I) => UPS[I.lv].bad,
    hint: (I) => I.lv === 1 ? "INSERT … ON CONFLICT (page_id) DO UPDATE can refer to the existing row by the table name and to the proposed row as excluded." : I.lv === 2 ? "DO UPDATE accepts a WHERE clause; when it's false, the existing row is left alone." : "A data-modifying CTE can record the event id; only if that insert produced a row should the stock change.",
    concept: "Upserts: increments, last-write-wins and exactly-once apply",
    how: "<code>INSERT … ON CONFLICT (key) DO UPDATE</code> atomically inserts or updates one row, with no race between a check and an insert. In the update, the table name refers to the existing row and <code>excluded</code> to the row you tried to insert, so increments are <code>SET n = t.n + 1</code>. A <code>WHERE</code> on DO UPDATE makes it conditional: comparing timestamps or versions turns an out-of-order stream into last-writer-wins by event time. To apply an at-least-once stream exactly once, record the event id in the same statement or transaction (a data-modifying CTE with ON CONFLICT DO NOTHING RETURNING) and only change state when the id was new.",
    rule: "Write upserts as one atomic statement; make out-of-order updates conditional on event time or version, and gate non-idempotent changes on a recorded event id.",
    why: (I, sol) => `Reference: <code>${esc(sol)}</code>`,
  });

  const nullSetup = (I) => `CREATE TABLE customers (id int PRIMARY KEY, name text NOT NULL, referred_by int);
INSERT INTO customers SELECT g, 'c' || g, CASE WHEN g % 5 = 0 THEN NULL ELSE 1 + (g * 7) % ${I.k} END FROM generate_series(1, 60) g;
CREATE TABLE orders (id int PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL, coupon text);
INSERT INTO orders SELECT g, 1 + (g * 13) % 50, (ARRAY['paid','pending','paid','refunded'])[1 + g % 4], CASE WHEN g % 3 = 0 THEN NULL WHEN g % 3 = 1 THEN 'SPRING' ELSE 'VIP' END FROM generate_series(1, ${I.o}) g;`;
  S.push({
    id: "data-null-sql",
    name: "The query that forgot NULL",
    kind: "Investigation",
    skills: ["diagnose"],
    ...sqlSelect({
      setup: nullSetup,
      ref: (I) => I.lv === 1 ? "SELECT count(*) AS n FROM orders WHERE coupon IS DISTINCT FROM 'SPRING'" : I.lv === 2 ? "SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customers r WHERE r.referred_by = c.id)" : "SELECT c.id, count(o.id) AS paid FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid' GROUP BY c.id",
      cols: 0,
      diag: (I, got, ref) => I.lv === 1 ? `You counted ${got.length ? Object.values(got[0])[0] : "nothing"}; the right count is ${Object.values(ref[0])[0]}.` : `Your query returns ${got.length} row${got.length === 1 ? "" : "s"}; there should be ${ref.length}.${I.lv === 3 && got.length < ref.length ? " Some customers are missing entirely." : ""}`,
      rows: 5,
    }),
    gen(lv, R) { return { lv, k: R.int(12, 30), o: R.int(150, 260) }; },
    text: (I) => {
      const schema = "customers (id int PRIMARY KEY, name text, referred_by int NULL)\norders    (id int PRIMARY KEY, customer_id int, status text, coupon text NULL)";
      const ask = I.lv === 1 ? `Marketing asks: <b>how many orders did not use the coupon <code>SPRING</code></b>? (Orders without any coupon count.) The dashboard uses <code>WHERE coupon &lt;&gt; 'SPRING'</code> and the number looks low.`
        : I.lv === 2 ? `Growth asks: <b>which customers have never referred anyone</b>? (Return their <code>id</code>.) The current query <code>WHERE id NOT IN (SELECT referred_by FROM customers)</code> returns nothing at all.`
          : `Finance asks for <b>every customer with their number of paid orders</b>, including customers with 0. Return <code>id</code> and the count. The current report joins and filters on <code>o.status = 'paid'</code> in the WHERE clause.`;
      return `<p>${ask}</p>${K.pre(schema)}<p>Write the correct query; it runs on a real Postgres and is compared with the right answer.</p>`;
    },
    bad: (I) => I.lv === 1 ? ["SELECT count(*) FROM orders WHERE coupon <> 'SPRING'"] : I.lv === 2 ? ["SELECT id FROM customers WHERE id NOT IN (SELECT referred_by FROM customers)"] : ["SELECT c.id, count(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.status = 'paid' GROUP BY c.id", "SELECT c.id, count(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid' GROUP BY c.id"],
    hint: (I) => I.lv === 1 ? "NULL <> 'SPRING' is not true; it's NULL." : I.lv === 2 ? "If the subquery contains a NULL, x NOT IN (…) can never be true." : "A WHERE condition on the outer-joined table discards the NULL-extended rows; and count(*) counts them as 1.",
    concept: "NULL is unknown: three-valued logic in SQL",
    how: "Comparisons with NULL yield NULL (unknown), and WHERE keeps only true rows, so <code>coupon &lt;&gt; 'SPRING'</code> silently drops rows with no coupon; use <code>IS DISTINCT FROM</code>. <code>x NOT IN (subquery)</code> is NULL whenever the subquery contains a NULL, so it returns nothing; use <code>NOT EXISTS</code>. In outer joins, a WHERE predicate on the inner table removes the NULL-extended rows and turns the join back into an inner join; move the predicate into ON. <code>count(*)</code> counts rows, <code>count(col)</code> counts non-NULL values.",
    rule: "Assume every nullable column holds NULLs: prefer IS DISTINCT FROM, NOT EXISTS, predicates in the ON clause and count(column).",
    why: (I, sol) => `Reference: <code>${esc(sol)}</code>`,
  });

  const dedupSetup = (I) => `CREATE TABLE events (id bigint PRIMARY KEY, event_id text NOT NULL, user_id int NOT NULL, client_req_id text NOT NULL, received_at timestamptz NOT NULL);
INSERT INTO events SELECT (g * 7919) % 100003, 'e' || (g / 3 + g % 2), 1 + g % 6, 'r' || (g % 9), timestamptz '2026-10-01' + (g * ${I.step}) * interval '1 minute' + ((g * 37) % 29) * interval '1 second' FROM generate_series(1, ${I.n}) g;`;
  S.push({
    id: "data-dedup-sql",
    name: "Deduplicate at-least-once events",
    kind: "Investigation",
    skills: ["design"],
    w: "code",
    gen(lv, R) { return { lv, n: R.int(180, 260), step: lv === 3 ? R.pick([2, 3]) : 1 }; },
    ...(function () {
      const sel = sqlSelect({
        setup: dedupSetup,
        ref: (I) => I.lv === 1 ? "SELECT DISTINCT ON (event_id) id FROM events ORDER BY event_id, received_at" : "SELECT id FROM (SELECT id, received_at - lag(received_at) OVER (PARTITION BY user_id, client_req_id ORDER BY received_at) AS gap FROM events) t WHERE gap IS NULL OR gap > interval '10 minutes'",
        cols: 1, colNames: "id",
        diag: (I, got, ref) => `You keep ${got.length} event${got.length === 1 ? "" : "s"}; the right answer keeps ${ref.length}.`,
        rows: 6,
      });
      const del = sqlApply({
        setup: dedupSetup,
        state: () => "SELECT id FROM events ORDER BY id",
        stateLabel: "Rows left:",
        guard: (sql) => oneStmt(sql, RX_DEL),
        apply: async (db, I, sql) => { await db.exec(sql); },
        ref: () => "DELETE FROM events e USING events f WHERE f.event_id = e.event_id AND (f.received_at, f.id) < (e.received_at, e.id)",
        ph: "DELETE FROM events ...",
        diag: (I, got, ref) => `${got.length} rows remain; there should be ${ref.length}.${got.length === ref.length ? " Same count, different rows: keep the earliest received copy, not the lowest id." : ""}`,
        rows: 6,
      });
      const pick = (I) => (I.lv === 2 ? del : sel);
      return {
        ui: (I) => pick(I).ui(I),
        accept: (I, a) => pick(I).accept(I, a),
        solve: (I) => pick(I).solve(I),
      };
    })(),
    text: (I) => {
      const schema = "events (id bigint PRIMARY KEY, event_id text, user_id int, client_req_id text, received_at timestamptz)";
      return `${K.pre(schema)}<p>${I.lv === 1 ? "The ingestion pipeline delivers events at least once, so some <code>event_id</code>s appear several times. <b>Return the <code>id</code> of one row per <code>event_id</code>: the earliest received copy.</b> (Row ids are random, not in arrival order.)" : I.lv === 2 ? "The duplicates now need to go. <b>Write one DELETE that removes every copy except the earliest received one per <code>event_id</code>.</b> Row ids are random, not in arrival order." : "Mobile clients retry with the same <code>client_req_id</code>, but each retry gets a new <code>event_id</code>. Product's rule: a row is a duplicate if the same <code>(user_id, client_req_id)</code> arrived <b>within 10 minutes before it</b>; ids get reused legitimately after longer gaps. <b>Return the <code>id</code>s of rows to keep.</b>"}</p>`;
    },
    bad: (I) => I.lv === 1 ? ["SELECT min(id) AS id FROM events GROUP BY event_id"] : I.lv === 2 ? ["DELETE FROM events WHERE id NOT IN (SELECT min(id) FROM events GROUP BY event_id)"] : ["SELECT DISTINCT ON (user_id, client_req_id) id FROM events ORDER BY user_id, client_req_id, received_at"],
    hint: (I) => I.lv === 1 ? "DISTINCT ON (key) keeps the first row per key in ORDER BY order." : I.lv === 2 ? "Delete a row if another row with the same event_id arrived earlier." : "Compare each row with the previous one for the same key: lag() over a window partitioned by the key.",
    concept: "Deduplication queries",
    how: "Deduplicating means choosing a survivor per key deterministically. <code>DISTINCT ON (key) … ORDER BY key, received_at</code> or <code>row_number() OVER (PARTITION BY key ORDER BY received_at) = 1</code> keeps the earliest copy; <code>min(id)</code> only works if ids follow arrival order. A self-join DELETE (<code>USING</code>) removes rows that have an earlier twin. When duplicates are defined by a time window rather than an id, compare each row with its predecessor using <code>lag()</code>, so legitimate repeats after the window survive. Then prevent new duplicates at write time with a unique key or an idempotent upsert.",
    rule: "Pick survivors by an explicit ordering (arrival time, then id), never by an incidental id, and fix the writer so dedup isn't a recurring job.",
    why: (I, sol) => `Reference: <code>${esc(sol)}</code>`,
  });

  const lbSetup = (I) => `CREATE TABLE scores (player text NOT NULL, region text NOT NULL, score int NOT NULL, achieved_at timestamptz NOT NULL);
INSERT INTO scores SELECT 'p' || (g % ${I.players}), (ARRAY['eu','na','apac'])[1 + (g % ${I.players}) % 3], 100 + ((g * 7919) % ${I.spread}) * 5, timestamptz '2026-10-01' + g * interval '7 minutes' FROM generate_series(1, ${I.players * (I.lv === 3 ? 3 : 1)}) g;`;
  S.push({
    id: "data-leaderboard-sql",
    name: "Rank the leaderboard",
    kind: "Code review",
    skills: ["design"],
    ...sqlSelect({
      setup: lbSetup,
      ref: (I) => I.lv === 1 ? "SELECT player, score, rnk FROM (SELECT player, score, rank() OVER (ORDER BY score DESC) AS rnk FROM scores) t WHERE rnk <= 10"
        : I.lv === 2 ? `SELECT player, pos FROM (SELECT player, row_number() OVER (ORDER BY score DESC, achieved_at) AS pos FROM scores) t WHERE pos BETWEEN (SELECT pos FROM (SELECT player, row_number() OVER (ORDER BY score DESC, achieved_at) AS pos FROM scores) u WHERE player = '${I.me}') - 2 AND (SELECT pos FROM (SELECT player, row_number() OVER (ORDER BY score DESC, achieved_at) AS pos FROM scores) u WHERE player = '${I.me}') + 2 ORDER BY pos`
          : "SELECT region, player, best, rnk FROM (SELECT region, player, best, rank() OVER (PARTITION BY region ORDER BY best DESC) AS rnk FROM (SELECT region, player, max(score) AS best FROM scores GROUP BY region, player) b) t WHERE rnk <= 3",
      ordered: false,
      diag: (I, got, ref) => `Your query returns ${got.length} row${got.length === 1 ? "" : "s"}; the right answer has ${ref.length}${I.lv !== 2 && got.length !== ref.length ? " (ties share a rank, so there can be more rows than the cut-off)" : ""}.${got.length === ref.length ? " Check the rank values and which rows you kept." : ""}`,
      rows: 6,
    }),
    gen(lv, R) { const players = lv === 3 ? R.int(40, 60) : R.int(60, 90); return { lv, players, spread: lv === 3 ? R.int(8, 12) : R.int(15, 25), me: "p" + R.int(10, players - 10) }; },
    text: (I) => {
      const ask = I.lv === 1 ? "Return the <b>top 10 with standard competition ranking</b> (ties share a rank and the next rank is skipped: 1, 2, 2, 4). Columns: <code>player, score, rank</code>. Include everyone whose rank is ≤ 10."
        : I.lv === 2 ? `Show an \"around me\" view for <b>${I.me}</b>: their position and the two players directly above and below. Position is <code>score DESC</code>, ties broken by who got the score first (<code>achieved_at</code>). Columns: <code>player, position</code>.`
          : "Players have several scores. For each <code>region</code>, return the <b>top 3 players by their best score</b>, with ties sharing a rank (include everyone with rank ≤ 3). Columns: <code>region, player, best, rank</code>.";
      return `${K.pre("scores (player text, region text, score int, achieved_at timestamptz)")}<p>${ask}</p><p>It runs on a real Postgres and is compared with the right answer (column order matters, row order doesn't${I.lv === 2 ? "" : ""}).</p>`;
    },
    bad: (I) => I.lv === 1 ? ["SELECT player, score, row_number() OVER (ORDER BY score DESC) FROM scores ORDER BY score DESC LIMIT 10", "SELECT player, score, dense_rank() OVER (ORDER BY score DESC) AS r FROM scores ORDER BY score DESC LIMIT 10"] : I.lv === 2 ? [`SELECT player, pos FROM (SELECT player, rank() OVER (ORDER BY score DESC) AS pos FROM scores) t WHERE player = '${I.me}'`] : ["SELECT region, player, max(score), rank() OVER (PARTITION BY region ORDER BY max(score) DESC) FROM scores GROUP BY region, player ORDER BY 1, 4 LIMIT 9"],
    hint: (I) => I.lv === 1 ? "rank() vs dense_rank() vs row_number(); filter on the rank in an outer query, not with LIMIT." : I.lv === 2 ? "Compute positions for everyone in a subquery, find mine, then filter positions within ±2." : "Aggregate to one best score per player first, then rank within each region with PARTITION BY.",
    concept: "Window functions for rankings",
    how: "<code>row_number()</code> numbers rows uniquely, <code>rank()</code> gives ties the same rank and skips (1, 2, 2, 4), <code>dense_rank()</code> doesn't skip (1, 2, 2, 3). Window functions run after WHERE and GROUP BY, so filter on their result in an outer query; LIMIT cuts ties arbitrarily. <code>PARTITION BY</code> restarts the ranking per group, and aggregating before ranking (best score per player) avoids ranking the same player twice. For hot, frequently-read leaderboards, precompute (materialised view, sorted set) instead of ranking millions of rows per request.",
    rule: "Decide the tie semantics first (rank, dense_rank, or a tie-breaker with row_number), then filter on the window result in an outer query.",
    why: (I, sol) => `Reference: <code>${esc(sol)}</code>`,
  });

  /* ================= terminals ================= */
  const utf8 = (str) => { const out = []; for (const ch of str) { const c = ch.codePointAt(0); if (c < 0x80) out.push(c); else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); } return out; };
  const hex = (str) => utf8(str).map((b) => b.toString(16).padStart(2, "0")).join("");
  const isNFC = (x) => x === x.normalize("NFC");
  const psqlRows = (head, rows) => K.cols([head, head.map((h) => "-".repeat(Math.max(3, h.length))), ...rows]) + `\n(${rows.length} row${rows.length === 1 ? "" : "s"})`;
  function uniShell(I) {
    const users = [{ id: 1001, u: "anna" }, { id: 1002, u: I.nfd }, { id: 1003, u: "zoë" }, { id: 1004, u: "mike " }, { id: 1005, u: "lukas" }];
    if (I.lv === 3) users.push({ id: 1009, u: I.nfd.normalize("NFC") });
    const show = (st, rows) => psqlRows(["id", "username"], rows.map((x) => [x.id, x.u]));
    const sh = K.shell([
      { re: /^select .*encode\(convert_to\(username.*from users.*;?$/i, use: "SELECT id, username, encode(convert_to(username, 'UTF8'), 'hex') FROM users ...;", desc: "show the raw bytes", run: (m, st) => psqlRows(["id", "username", "length", "hex"], st.users.map((x) => [x.id, JSON.stringify(x.u).slice(1, -1), x.u.length, hex(x.u)])) },
      { re: /^select count\(\*\) from users where username is not (nfc )?normalized;?$/i, use: "SELECT count(*) FROM users WHERE username IS NOT NFC NORMALIZED;", desc: "count non-NFC usernames", run: (m, st) => psqlRows(["count"], [[st.users.filter((x) => !isNFC(x.u)).length]]) },
      { re: /^select .*from users a join users b on normalize\(a\.username(, ?nfc)?\) ?= ?b\.username.*;?$/i, use: "SELECT a.id, b.id, b.username FROM users a JOIN users b ON normalize(a.username, NFC) = b.username AND a.id <> b.id;", desc: "find accounts that collide after normalising", run: (m, st) => { st.sawCollide = true; const rows = []; st.users.forEach((a) => st.users.forEach((b) => { if (a.id !== b.id && a.u.normalize("NFC") === b.u) rows.push([a.id, b.id, b.u]); })); return psqlRows(["id", "id", "username"], rows); } },
      { re: /^select .*from users where (normalize\()?username(, ?nfc\))? = (normalize\()?'([^']*)'(, ?nfc\))?;?$/i, use: "SELECT id, username FROM users WHERE username = '<name>';", desc: "look a user up", run: (m, st) => { const norm = !!m[1] && !!m[3]; const want = m[4]; return show(st, st.users.filter((x) => (norm ? x.u.normalize("NFC") === want.normalize("NFC") : x.u === want))); } },
      { re: /^select .*from users;?$/i, use: "SELECT id, username FROM users;", desc: "list users", run: (m, st) => show(st, st.users) },
      { re: /^update users set username = normalize\(username(?:, ?nfc)?\)(.*?);?$/i, use: "UPDATE users SET username = normalize(username, NFC) WHERE ...;", desc: "normalise stored usernames", run: (m, st) => {
        const where = m[1] || "";
        const cand = st.users.filter((x) => !isNFC(x.u));
        const safe = /not exists/i.test(where);
        const coll = cand.filter((x) => st.users.some((y) => y !== x && y.u === x.u.normalize("NFC")));
        if (coll.length && !safe) return `ERROR:  duplicate key value violates unique constraint "users_username_key"\nDETAIL:  Key (username)=(${coll[0].u.normalize("NFC")}) already exists.`;
        const upd = cand.filter((x) => !coll.includes(x));
        upd.forEach((x) => (x.u = x.u.normalize("NFC")));
        return `UPDATE ${upd.length}`;
      } },
      { re: /^alter table users add constraint \w+ check \(username is (nfc )?normalized\);?$/i, use: "ALTER TABLE users ADD CONSTRAINT username_nfc CHECK (username IS NFC NORMALIZED);", desc: "reject non-NFC usernames from now on", run: (m, st) => { if (st.users.some((x) => !isNFC(x.u))) return `ERROR:  check constraint "username_nfc" of relation "users" is violated by some row`; st.check = true; return "ALTER TABLE"; } },
      { re: /^update users set username = (trim|btrim|rtrim)\(username\).*;?$/i, use: "UPDATE users SET username = trim(username) ...;", desc: "", hidden: true, run: (m, st) => { const n = st.users.filter((x) => x.u !== x.u.trim()).length; st.users.forEach((x) => (x.u = x.u.trim())); return `UPDATE ${n}`; } },
      { re: /^delete from users.*$/i, use: "DELETE FROM users WHERE ...;", desc: "", hidden: true, run: (m, st) => ({ out: "DELETE 1", danger: "Deleting a customer's account to fix a lookup bug destroys their data and history." }) },
      { re: /^\\d\+? ?users;?$/i, use: "\\d users", desc: "describe the table", run: () => 'Table "public.users"\n  Column  |  Type  | Collation | Nullable\n----------+--------+-----------+----------\n id       | bigint |           | not null\n username | text   |           | not null\nIndexes:\n    "users_pkey" PRIMARY KEY, btree (id)\n    "users_username_key" UNIQUE CONSTRAINT, btree (username)' },
      { re: /^show server_encoding;?$/i, use: "SHOW server_encoding;", desc: "", run: () => " server_encoding\n-----------------\n UTF8\n(1 row)" },
    ], { sh: "psql" });
    return {
      prompt: "prod=#", init: { users, check: false, sawCollide: false }, run: (line, st) => sh.run(line, st), par: I.lv === 3 ? 6 : 5,
      motd: `support ticket #${I.ticket}: "I can't log in as ${I.nfd.normalize("NFC")}. Password reset says the account doesn't exist."\napp log: auth.lookup username='${I.nfd.normalize("NFC")}' → user_not_found\npsql (16.4) · prod (read-write)`,
      cmds: [`SELECT id, username FROM users WHERE username = '${I.nfd.normalize("NFC")}';`, "SELECT id, username, encode(convert_to(username, 'UTF8'), 'hex') FROM users;", "SELECT count(*) FROM users WHERE username IS NOT NFC NORMALIZED;", "UPDATE users SET username = normalize(username, NFC) WHERE username IS NOT NFC NORMALIZED;", ...(I.lv > 1 ? ["ALTER TABLE users ADD CONSTRAINT username_nfc CHECK (username IS NFC NORMALIZED);"] : []), ...(I.lv === 3 ? ["SELECT a.id, b.id, b.username FROM users a JOIN users b ON normalize(a.username, NFC) = b.username AND a.id <> b.id;"] : []), "\\d users"],
      opts: ["Stored usernames are NFD (decomposed accents); the login form sends NFC", "Trailing whitespace in stored usernames", "The lookup is case-sensitive", "The database encoding isn't UTF-8"], optq: "Root cause",
    };
  }
  S.push({
    id: "data-unicode-login",
    name: "José can't log in",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    ...LB.term({
      shell: uniShell,
      goal(st, I, a) {
        if (a.pick !== 0) return "That isn't what the bytes show.";
        const bad = st.users.filter((x) => !isNFC(x.u));
        if (I.lv < 3 && bad.length) return `${bad.length} username${bad.length > 1 ? "s are" : " is"} still stored in decomposed form.`;
        if (I.lv === 2 && !st.check) return "Fixed for now, but nothing stops the next sign-up from storing NFD again. Add a guard in the database.";
        if (I.lv === 3) { if (bad.length !== 1) return "Normalise every username that doesn't collide with an existing account."; if (!st.sawCollide) return "One account can't be normalised. Find out which accounts it collides with before you hand this to support."; }
        return true;
      },
      solve: (I) => ({ log: I.lv === 3 ? ["SELECT id, username, encode(convert_to(username, 'UTF8'), 'hex') FROM users;", "SELECT a.id, b.id, b.username FROM users a JOIN users b ON normalize(a.username, NFC) = b.username AND a.id <> b.id;", "UPDATE users SET username = normalize(username, NFC) WHERE username IS NOT NFC NORMALIZED AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.username = normalize(users.username, NFC));"] : ["SELECT id, username, encode(convert_to(username, 'UTF8'), 'hex') FROM users;", "UPDATE users SET username = normalize(username, NFC) WHERE username IS NOT NFC NORMALIZED;", ...(I.lv === 2 ? ["ALTER TABLE users ADD CONSTRAINT username_nfc CHECK (username IS NFC NORMALIZED);"] : [])], pick: 0 }),
    }),
    gen(lv, R) { const name = R.pick(["josé", "renée", "zoë", "chloë", "björn"]); if (name === "zoë") return null; return { lv, nfd: name, ticket: R.int(10000, 99999) }; },
    bad: (I) => [{ log: ["UPDATE users SET username = trim(username);"], pick: 1 }, { log: ["SELECT id, username FROM users;"], pick: 0 }, ...(I.lv === 3 ? [{ log: ["UPDATE users SET username = normalize(username, NFC) WHERE username IS NOT NFC NORMALIZED;"], pick: 0 }] : [])],
    text: (I) => `<p>A customer can't log in or reset their password: the app says their account doesn't exist, but support can see it in the admin UI. Their name has an accent. Accounts were imported from a partner system last year.</p><p>Investigate in <code>psql</code>, fix the data${I.lv === 2 ? ", and make sure it can't recur" : ""}${I.lv === 3 ? " without breaking anyone else's account" : ""}, then name the root cause.</p>`,
    hint: (I) => I.lv === 1 ? "Two strings can look identical and have different bytes. Compare the hex." : I.lv === 2 ? "Postgres 13+ has normalize() and the IS NFC NORMALIZED predicate; both work in a CHECK constraint." : "When the customer couldn't log in, what did they probably do next? Normalising can create a duplicate of an existing username.",
    concept: "Unicode normalisation",
    how: "Many characters have more than one encoding: 'é' is U+00E9 (NFC, composed) or 'e' + U+0301 combining acute (NFD, decomposed). They render identically but compare unequal byte-for-byte, so lookups, unique constraints and joins miss. Browsers and most keyboards produce NFC; macOS file names and some import tools produce NFD. Normalise at the boundary (on write and on lookup) to one form, usually NFC, and enforce it in the database (<code>CHECK (col IS NFC NORMALIZED)</code>, Postgres 13+). Backfilling can merge two previously distinct strings into one, so check for collisions first.",
    rule: "Pick one normalisation form, apply it to every input at the edge, enforce it with a constraint, and check for collisions before you backfill.",
    why: (I) => `The stored username was ${JSON.stringify(I.nfd).slice(1, -1)} (hex ${hex(I.nfd)}), the NFD form; the login form sent the NFC form (hex ${hex(I.nfd.normalize("NFC"))}).${I.lv === 3 ? " The customer had already created a second account with the NFC spelling, so a blanket UPDATE violates the unique constraint: normalise the rest, and route that pair to support to merge." : ""}`,
  });

  const CSV_REQ = { 1: { encoding: "utf-8-sig" }, 2: { delimiter: ";", decimal: "," }, 3: { parser: "csv", dtype: "sku=str" } };
  function csvShell(I) {
    const F = I.file;
    const parse = (line) => { const f = {}; const re = /--(\w[\w-]*)(?:[ =]('([^']*)'|"([^"]*)"|(\S+)))?/g; let m; while ((m = re.exec(line))) f[m[1]] = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : true; return f; };
    const run = (f) => {
      const req = CSV_REQ[I.lv];
      if (I.lv === 1 && f.encoding !== "utf-8-sig") return { err: `Traceback (most recent call last):\n  File "import.py", line 41, in load\n    sku = row["sku"]\nKeyError: 'sku'\n(header columns: ['\\ufeffsku', 'name', 'price', 'currency'])` };
      if (I.lv === 2) { if (f.delimiter !== ";") return { err: `ERROR row 1: expected columns [sku, name, price, currency], found ['sku;name;price;currency']` }; if (f.decimal !== ",") return { err: `ERROR row 2: invalid decimal literal '1.299,00' for column price` }; }
      if (I.lv === 3) { if (f.parser !== "csv") return { err: `ERROR row ${I.badRow}: expected 4 fields, got 2 ('"Steel bolt, M8')\nERROR row ${I.badRow + 1}: expected 4 fields, got 3 ('zinc plated", 4.20, EUR')\n... 37 more` }; }
      const sample = I.lv === 3 && f.dtype !== "sku=str" ? "sku=123 name='Steel bolt, M8\\nzinc plated' price=4.20" : I.lv === 3 ? "sku='00123' name='Steel bolt, M8\\nzinc plated' price=4.20" : I.lv === 2 ? "sku='DE-4471' price=1299.00 currency=EUR" : "sku='A-1001' price=19.99 currency=USD";
      void req;
      return { ok: true, sample };
    };
    const sh = K.shell([
      { re: /^ls( -\w+)*$/, use: "ls -l", desc: "list files", run: () => `-rw-r--r-- 1 etl etl ${K.num(I.bytes)} Oct 12 02:00 ${F}\n-rwxr-xr-x 1 etl etl   6120 Sep 30 11:12 import.py` },
      { re: new RegExp(`^file ${F}$`), use: `file ${F}`, desc: "detect encoding", run: () => `${F}: ${I.lv === 1 ? "Unicode text, UTF-8 (with BOM) text" : I.lv === 2 ? "Unicode text, UTF-8 text, with CRLF line terminators" : "CSV text"}` },
      { re: new RegExp(`^head(?: -n ?(\\d+))? ${F}(?: \\| cat -A)?$`), use: `head -n 5 ${F} [| cat -A]`, desc: "first lines", run: (m, st, line) => { const raw = I.lv === 1 ? ["﻿sku,name,price,currency", "A-1001,Coffee mug,19.99,USD", "A-1002,Tea pot,34.50,USD"] : I.lv === 2 ? ["sku;name;price;currency", "DE-4471;Wasserkocher;1.299,00;EUR", "DE-4472;Toaster;49,90;EUR"] : ["sku,name,price,currency", "00121,Washer M8,0.12,EUR", "00122,Hex nut M8,0.09,EUR", "00123,\"Steel bolt, M8", "zinc plated\",4.20,EUR"]; const n = +(m[1] || 5); const lines = raw.slice(0, n); return / cat -A/.test(line) ? lines.map((l, k) => (k === 0 && I.lv === 1 ? "M-oM-;M-?" + l.slice(1) : l) + (I.lv === 2 ? "^M$" : "$")).join("\n") : lines.join("\n"); } },
      { re: new RegExp(`^wc -l ${F}$`), use: `wc -l ${F}`, desc: "count lines", run: () => `${K.num(I.rows + 1 + (I.lv === 3 ? 39 : 0)).replace(/,/g, "")} ${F}` },
      { re: new RegExp(`^python3 import\\.py(.*) ${F}$`), use: `python3 import.py [--dry-run] [--encoding E] [--delimiter D] [--decimal C] [--parser csv|fast] [--dtype col=str] ${F}`, desc: "run the importer", run: (m, st) => {
        const f = parse(m[1]); const r = run(f);
        if (f["skip-errors"] && r.err) { if (!f["dry-run"]) { st.imported = { bad: true }; return { out: `skipped ${I.lv === 3 ? 39 : I.rows} bad rows; imported ${I.lv === 3 ? I.rows - 39 : 0}`, danger: "--skip-errors silently dropped rows into production." }; } return `dry run: would skip ${I.lv === 3 ? 39 : I.rows} rows`; }
        if (r.err) return r.err;
        if (f["dry-run"]) return `dry run OK: ${K.num(I.rows)} rows parsed, 0 errors\nsample: ${r.sample}`;
        const okAll = Object.entries(CSV_REQ[I.lv]).every(([k, v]) => f[k] === v);
        st.imported = { ok: okAll };
        return okAll ? `imported ${K.num(I.rows)} rows into staging.prices; swapped into prices` : { out: `imported ${K.num(I.rows)} rows into staging.prices; swapped into prices`, danger: "You loaded data you hadn't verified: the sample shows SKUs without their leading zeros, so they no longer match the catalog." };
      } },
      { re: /^python3 import\.py --help$/, use: "python3 import.py --help", desc: "importer options", run: () => "usage: import.py [--dry-run] [--encoding ENC] [--delimiter CH] [--decimal CH]\n                 [--parser {fast,csv}] [--dtype COL=TYPE] [--skip-errors] FILE\n  --parser fast   split on newlines, then commas (default; 4x faster)\n  --parser csv    RFC 4180 parser (quoted fields, embedded newlines)\n  --dtype         override type inference, e.g. sku=str\n  --encoding      default utf-8" },
    ]);
    return {
      prompt: "etl@batch-01:~/partner$", init: { imported: null }, run: (line, st) => sh.run(line, st), par: 6,
      motd: `ALERT nightly partner price import FAILED (exit 1)\n${I.partner} sent a new export format this week.`,
      cmds: [`file ${F}`, `head -n 5 ${F} | cat -A`, `wc -l ${F}`, "python3 import.py --help", `python3 import.py --dry-run ${F}`],
      opts: I.lv === 1 ? ["The file starts with a UTF-8 byte-order mark, which became part of the first header name", "Windows CRLF line endings", "The file is UTF-16", "A column was renamed"] : I.lv === 2 ? ["European format: semicolon delimiter and decimal comma", "Windows CRLF line endings break the parser", "A byte-order mark on the header", "Prices exceed the column's precision"] : ["Quoted fields with embedded newlines break line splitting, and type inference strips SKU leading zeros", "The file is too large for the fast parser", "Windows CRLF line endings", "A byte-order mark on the header"],
      optq: "Root cause",
    };
  }
  S.push({
    id: "data-csv-import",
    name: "Fix the partner CSV import",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    ...LB.term({
      shell: csvShell,
      goal(st, I, a) { if (a.pick !== 0) return "Your root cause doesn't match what the file shows."; if (!st.imported) return "The prices still haven't been imported."; if (!st.imported.ok) return "The import ran, but with settings that load wrong data."; return true; },
      solve: (I) => { const fl = I.lv === 1 ? "--encoding utf-8-sig" : I.lv === 2 ? "--delimiter ';' --decimal ','" : "--parser csv --dtype sku=str"; return { log: [`head -n 5 ${I.file} | cat -A`, `python3 import.py --dry-run ${fl} ${I.file}`, `python3 import.py ${fl} ${I.file}`], pick: 0 }; },
    }),
    gen(lv, R) { return { lv, file: R.pick(["prices.csv", "export_prices.csv"]), rows: R.int(8000, 12000), bytes: R.int(700000, 900000), badRow: R.int(1000, 5000), partner: R.pick(["Nordlicht GmbH", "Kestrel Supply", "Arcadia Trading"]) }; },
    bad: (I) => [{ log: [`python3 import.py --skip-errors ${I.file}`], pick: 0 }, { log: [`python3 import.py ${I.lv === 3 ? "--parser csv" : "--encoding utf-16"} ${I.file}`], pick: 0 }, { log: [`python3 import.py ${I.lv === 1 ? "--encoding utf-8-sig" : I.lv === 2 ? "--delimiter ';' --decimal ','" : "--parser csv --dtype sku=str"} ${I.file}`], pick: 2 }],
    text: (I) => `<p>The nightly import of ${esc(I.partner)}'s price list failed. Yesterday's prices are still live, so nothing is broken for customers yet, but the import must run today. Inspect the file, find the right importer options, verify with a dry run, then import.</p>`,
    hint: (I) => I.lv === 1 ? "Look at the very first bytes of the header with cat -A." : I.lv === 2 ? "What separates fields, and what separates decimals, in this file?" : "Count records vs lines, and look closely at the dry-run sample.",
    concept: "CSV is not a format, it's a family",
    how: "Real-world CSV varies in encoding (UTF-8 with or without a byte-order mark, UTF-16, Windows-1252), delimiter (comma, semicolon in locales that use the decimal comma, tab), decimal and thousands separators, quoting, and line endings. RFC 4180 allows quoted fields containing delimiters and newlines, so splitting on newlines breaks records. Type inference turns identifiers like 00123 or 1E5 into numbers. Treat imports as a pipeline: detect the dialect, parse with a real CSV parser, declare column types explicitly, validate row counts and samples in a dry run, and load into staging before swapping.",
    rule: "Never infer types for identifiers, always use a real CSV parser, and dry-run into staging with counts and samples before touching production tables.",
    why: (I) => I.lv === 1 ? "The header started with EF BB BF (a UTF-8 byte-order mark), so the first column was named '\\ufeffsku'. Reading with utf-8-sig strips it." : I.lv === 2 ? "The export switched to a German locale: ';' between fields and ',' as the decimal separator (1.299,00 = 1299.00). CRLF endings were harmless." : `wc -l counted more lines than records because quoted names contain newlines, which the default fast parser splits on. With the CSV parser the rows parsed, but the sample showed sku=123: type inference dropped the leading zeros, so --dtype sku=str is needed too.`,
  });

  function gdprShell(I) {
    const U = I.uid;
    const has = { replica: true, orders: I.lv > 1, kafka: I.lv === 3, backups: true };
    const sh = K.shell([
      { re: new RegExp(`^datamap user ${U}$`), use: `datamap user ${U}`, desc: "where this user's data lives (data catalog)", run: () => K.cols([["store", "what", "notes"], ["postgres primary", "users row (name, email, phone, address)", I.lv > 1 ? "referenced by orders.user_id" : ""], ...(has.orders ? [["postgres primary", `orders (${I.orders} rows, shipping name/address)`, "financial records: keep 10 years (tax law)"]] : []), ["postgres replicas", "copies of the above", "streaming replication from primary, read-only"], ["redis", `user:${U}, session:${U}:*`, "profile cache, sessions"], ["search", `customers/_doc/${U}`, "support search index"], ...(has.kafka ? [["kafka", `customers.profile (compacted), key=${U}`, "compacted topic: latest value kept forever"]] : []), ["logs", "user id only", "30-day retention, no PII by policy"], ["backups", "nightly snapshots", "35-day retention, immutable"]]) },
      { re: /^psql -c "select .*"$/i, use: 'psql -c "SELECT ..."', desc: "query the primary", run: (m, st) => `users: ${st.users === "present" ? "1 row (Ada Example, ada@example.test)" : st.users === "anon" ? "1 row (deleted user, NULL)" : "0 rows"}${has.orders ? `\norders: ${st.orders} rows` : ""}` },
      { re: new RegExp(`^psql -c "delete from users where id = ${U};?"$`, "i"), use: `psql -c "DELETE FROM users WHERE id = ${U}"`, desc: "delete the user row", run: (m, st) => { if (has.orders && st.orders > 0) return `ERROR:  update or delete on table "users" violates foreign key constraint "orders_user_id_fkey" on table "orders"\nDETAIL:  Key (id)=(${U}) is still referenced from table "orders".`; st.users = "gone"; return "DELETE 1"; } },
      { re: new RegExp(`^psql -c "update users set (.*) where id = ${U};?"$`, "i"), use: `psql -c "UPDATE users SET name = 'deleted user', email = NULL, phone = NULL, address = NULL WHERE id = ${U}"`, desc: "pseudonymise the user row", run: (m, st) => { const set = m[1].toLowerCase(); if (!["email", "phone", "address", "name"].every((c) => set.includes(c))) return { out: "UPDATE 1", danger: "Some personal columns (name, email, phone, address) were left in place." }; st.users = "anon"; return "UPDATE 1"; } },
      { re: new RegExp(`^psql -c "update orders set (.*) where user_id = ${U};?"$`, "i"), use: `psql -c "UPDATE orders SET ship_name = NULL, ship_address = NULL WHERE user_id = ${U}"`, desc: "strip personal fields from orders", run: (m, st) => { st.ordersAnon = true; return `UPDATE ${I.orders}`; } },
      { re: new RegExp(`^psql -c "delete from orders where user_id = ${U};?"$`, "i"), use: `psql -c "DELETE FROM orders WHERE user_id = ${U}"`, desc: "", hidden: true, run: (m, st) => { if (!has.orders) return "DELETE 0"; st.orders = 0; return { out: `DELETE ${I.orders}`, danger: "Orders are financial records you're legally required to keep; erasure doesn't override that. Strip the personal fields instead." }; } },
      { re: /^psql -h replica.*$/i, use: 'psql -h replica-1 -c "..."', desc: "", run: () => "ERROR:  cannot execute DELETE in a read-only transaction\nHINT:  replicas apply changes from the primary automatically." },
      { re: new RegExp(`^redis-cli del user:${U}$`, "i"), use: `redis-cli DEL user:${U}`, desc: "drop the cached profile", run: (m, st) => { st.cache = true; return "(integer) 1"; } },
      { re: new RegExp(`^redis-cli --scan --pattern 'session:${U}:\\*' \\| xargs redis-cli del$`, "i"), use: `redis-cli --scan --pattern 'session:${U}:*' | xargs redis-cli DEL`, desc: "drop the user's sessions", run: (m, st) => { st.sessions = true; return "(integer) 3"; } },
      { re: /^redis-cli keys .*$/i, use: "redis-cli KEYS <pattern>", desc: "", hidden: true, run: (m, st) => (st.keys = true, { out: `1) "session:${U}:a81f"\n2) "session:${U}:c02d"\n3) "session:${U}:f7e9"\n4) "user:${U}"`, danger: "KEYS walks the whole keyspace in one blocking call; on a production Redis with millions of keys that stalls every client. Use SCAN." }) },
      { re: new RegExp(`^curl -X DELETE http://search:9200/customers/_doc/${U}$`), use: `curl -X DELETE http://search:9200/customers/_doc/${U}`, desc: "remove from the search index", run: (m, st) => { st.search = true; return `{"_index":"customers","_id":"${U}","result":"deleted"}`; } },
      { re: new RegExp(`^kcat -P -b kafka:9092 -t customers\\.profile -K: -Z <<< '${U}:'$`), use: `kcat -P -b kafka:9092 -t customers.profile -K: -Z <<< '${U}:'`, desc: "produce a tombstone (null value) for the key", run: (m, st) => { st.tomb = true; return ""; } },
      { re: new RegExp(`^erasure-ledger add ${U}( --reason \\w+)?$`), use: `erasure-ledger add ${U} --reason dsar`, desc: "record the erasure so it's re-applied after any backup restore", run: (m, st) => { st.ledger = true; return `ledger: ${U} recorded (re-applied automatically on restore)`; } },
      { re: /^aws s3 rm .*$/i, use: "aws s3 rm s3://...", desc: "", hidden: true, run: (m, st) => (st.s3 = true, { out: "delete: s3://acme-backups/2026-10-11/base.tar.zst", danger: "You deleted a whole-database backup to remove one person. Backups age out; record the erasure in the ledger instead." }) },
      { re: new RegExp(`^grep ${U} /var/log/app/\\*\\.log( \\| head)?$`), use: `grep ${U} /var/log/app/*.log | head`, desc: "check application logs", run: () => `app.log: 2026-10-02T09:12:44Z level=info msg="login ok" user_id=${U} request_id=7c1e\napp.log: 2026-10-05T17:03:10Z level=info msg="order placed" user_id=${U} order_id=88121` },
    ]);
    return {
      prompt: "ops@bastion:~$", init: { users: "present", orders: has.orders ? I.orders : 0, ordersAnon: false, cache: false, sessions: false, search: false, tomb: false, ledger: false }, run: (line, st) => sh.run(line, st), par: I.lv === 1 ? 6 : I.lv === 2 ? 8 : 10,
      motd: `DSAR-${I.req}: erasure request for user ${U} (verified identity). Due in 30 days.`,
      cmds: [`datamap user ${U}`, 'psql -c "SELECT ..."', `psql -c "DELETE FROM users WHERE id = ${U}"`, `redis-cli DEL user:${U}`, `curl -X DELETE http://search:9200/customers/_doc/${U}`, `grep ${U} /var/log/app/*.log | head`, "help"],
    };
  }
  S.push({
    id: "data-gdpr-erase",
    name: "Erase a customer everywhere",
    kind: "Change plan",
    skills: ["safe", "comms"],
    ...LB.term({
      shell: gdprShell,
      goal(st, I) {
        if (st.keys) return "KEYS blocked production Redis while it scanned every key; use SCAN for pattern lookups.";
        if (st.s3) return "You deleted a backup every other customer depends on.";
        if (I.lv > 1 && st.orders === 0) return "You deleted orders the company is legally required to keep.";
        if (st.users === "present") return "The user's row still holds their personal data.";
        if (!st.cache) return "Their profile is still cached in Redis.";
        if (!st.search) return "Support search still returns them.";
        if (I.lv > 1 && !st.sessions) return "Their sessions are still in Redis.";
        if (I.lv > 1 && st.orders > 0 && !st.ordersAnon) return "The orders keep their shipping name and address.";
        if (I.lv === 3 && !st.tomb) return "The compacted Kafka topic keeps the latest profile for this key forever.";
        if (I.lv === 3 && !st.ledger) return "If a backup from before today is restored, the user comes back. Nothing records that they must be erased again.";
        return true;
      },
      solve: (I) => { const U = I.uid; const l = [`datamap user ${U}`]; if (I.lv === 1) l.push(`psql -c "DELETE FROM users WHERE id = ${U}"`); else l.push(`psql -c "UPDATE users SET name = 'deleted user', email = NULL, phone = NULL, address = NULL WHERE id = ${U}"`, `psql -c "UPDATE orders SET ship_name = NULL, ship_address = NULL WHERE user_id = ${U}"`); l.push(`redis-cli DEL user:${U}`); if (I.lv > 1) l.push(`redis-cli --scan --pattern 'session:${U}:*' | xargs redis-cli DEL`); l.push(`curl -X DELETE http://search:9200/customers/_doc/${U}`); if (I.lv === 3) l.push(`kcat -P -b kafka:9092 -t customers.profile -K: -Z <<< '${U}:'`, `erasure-ledger add ${U} --reason dsar`); return { log: l }; },
    }),
    gen(lv, R) { return { lv, uid: R.int(10000, 99999), orders: R.int(3, 25), req: R.int(1000, 9999) }; },
    bad: (I) => { const U = I.uid, full = [`redis-cli DEL user:${U}`, `redis-cli --scan --pattern 'session:${U}:*' | xargs redis-cli DEL`, `curl -X DELETE http://search:9200/customers/_doc/${U}`, `kcat -P -b kafka:9092 -t customers.profile -K: -Z <<< '${U}:'`, `erasure-ledger add ${U}`]; return [{ log: [`psql -c "DELETE FROM users WHERE id = ${U}"`] }, { log: [`psql -c "DELETE FROM users WHERE id = ${U}"`, `redis-cli KEYS *${U}*`, ...full] }, ...(I.lv > 1 ? [{ log: [`psql -c "DELETE FROM orders WHERE user_id = ${U}"`, `psql -c "DELETE FROM users WHERE id = ${U}"`, ...full] }] : []), { log: [`psql -c "UPDATE users SET name = 'deleted user', email = NULL, phone = NULL, address = NULL WHERE id = ${U}"`, `psql -c "UPDATE orders SET ship_name = NULL, ship_address = NULL WHERE user_id = ${U}"`, ...full, "aws s3 rm s3://acme-backups/2026-10-11/base.tar.zst"] }]; },
    text: (I) => `<p>A verified customer (user <b>${I.uid}</b>) asked you to erase their personal data (GDPR Art. 17). You have a bastion shell with the usual tools. Start with the data catalog (<code>datamap</code>), erase what must go everywhere it lives${I.lv > 1 ? ", keep what the law requires you to keep" : ""}, and don't break anything for other customers. Type <code>help</code> for the available commands.</p>`,
    hint: (I) => I.lv === 1 ? "Database, cache and search index are three separate copies." : I.lv === 2 ? "Erasure doesn't override a legal duty to keep financial records: keep the orders, remove what identifies the person." : "Compacted topics keep the last value per key until a tombstone arrives, and immutable backups need a plan for restores.",
    concept: "Erasure across derived data",
    how: "Personal data is copied into caches, search indexes, event streams, analytics, logs and backups, and an erasure request covers all of them. Keep a data map so you know where each kind of data lives. Replicas follow the primary, so erase at the source. Records you must keep by law (invoices, orders) stay, with the identifying fields removed or pseudonymised. Compacted Kafka topics retain the latest value per key until you write a tombstone. Immutable backups can't be edited: let them expire on schedule and record erasures in a ledger that's replayed after any restore (or encrypt per user and delete the key: crypto-shredding). Keeping PII out of logs saves a whole category of work.",
    rule: "Erase at the source and in every derived copy you can change, pseudonymise what you must retain, tombstone streams, and ledger the erasure so a backup restore re-applies it.",
    why: (I) => I.lv === 1 ? "Delete the row, the cached profile and the search document. Replicas follow the primary; logs only contain the user id and expire in 30 days." : I.lv === 2 ? `The user row can't be deleted while ${I.orders} orders reference it, and those orders must be kept for tax purposes, so the user and order rows were pseudonymised instead, and sessions cleared with SCAN (not KEYS).` : "On top of the database, cache, sessions and search, the compacted customers.profile topic needs a tombstone, and the erasure ledger makes sure a restore of a backup taken before today re-erases the user.",
  });

  function dupShell(I) {
    const [o1, o2] = I.orders;
    const apiLines = (o) => I.lv === 1 ? `2026-10-11T14:02:11.204Z pod=api-7f9c POST /v1/orders/${o}/pay idem_key=- status=200 dur=3412ms psp_charge=ch_${o}a\n2026-10-11T14:02:14.230Z pod=api-7f9c POST /v1/orders/${o}/pay idem_key=- status=200 dur=2970ms psp_charge=ch_${o}b\n2026-10-11T14:02:14.229Z client=ios/5.12 msg="request timed out after 3000ms, retrying" order=${o}`
      : I.lv === 2 ? `2026-10-11T14:02:11.204Z pod=api-7f9c POST /v1/orders/${o}/pay idem_key=7f3a9c1e status=200 dur=3412ms idem=miss psp_charge=ch_${o}a\n2026-10-11T14:02:14.236Z pod=api-2b41 POST /v1/orders/${o}/pay idem_key=c91e04d2 status=200 dur=2970ms idem=miss psp_charge=ch_${o}b`
        : `2026-10-11T14:02:11.204Z pod=api-7f9c POST /v1/orders/${o}/pay idem_key=7f3a9c1e status=200 dur=812ms idem=miss psp_charge=ch_${o}a\n2026-10-11T14:02:11.208Z pod=api-2b41 POST /v1/orders/${o}/pay idem_key=7f3a9c1e status=200 dur=790ms idem=miss psp_charge=ch_${o}b`;
    const gw = (o) => `[2026-10-11T14:02:11.203Z] "POST /v1/orders/${o}/pay HTTP/2" 200 UF,URX upstream=api-7f9c x-envoy-attempt-count=2 retry_reason=reset_before_request upstream_reset_before_response_started{connection_termination}`;
    const sh = K.shell([
      { re: /^psql -c "select order_id, count\(\*\) from charges group by order_id having count\(\*\) > 1;?"$/i, use: 'psql -c "SELECT order_id, count(*) FROM charges GROUP BY order_id HAVING count(*) > 1"', desc: "orders charged more than once", run: () => psqlRows(["order_id", "count"], [[o1, 2], [o2, 2]]) },
      { re: /^grep (\S+) api\.log$/, use: "grep <pattern> api.log", desc: "search the API access log", run: (m, st) => { const o = +m[1]; if (o === o1 || o === o2) { st.saw = true; return apiLines(o); } if (/idem/.test(m[1])) return `${K.num(I.lv === 1 ? 0 : 41822)} lines (too many to print; grep for an order id)`; return ""; } },
      { re: /^grep (\S+) gateway\.log$/, use: "grep <pattern> gateway.log", desc: "search the edge proxy (Envoy) access log", run: (m, st) => { const o = +m[1]; if ((o === o1 || o === o2) && I.lv === 3) { st.sawGw = true; return gw(o); } if (o === o1 || o === o2) return `[2026-10-11T14:02:11.203Z] "POST /v1/orders/${o}/pay HTTP/2" 200 - upstream=api-7f9c x-envoy-attempt-count=1\n[2026-10-11T14:02:14.229Z] "POST /v1/orders/${o}/pay HTTP/2" 200 - upstream=api-2b41 x-envoy-attempt-count=1`; return ""; } },
      { re: /^cat idempotency\.py$/, use: "cat idempotency.py", desc: "the idempotency middleware", run: () => I.lv === 1 ? "# applied only when the Idempotency-Key header is present\nif key := request.headers.get('Idempotency-Key'):\n    cached = redis.get(f'idem:{key}')\n    if cached: return cached\n    resp = handler(request)\n    redis.set(f'idem:{key}', resp, ex=86400)\n    return resp\nreturn handler(request)" : I.lv === 2 ? "key = request.headers['Idempotency-Key']\ncached = redis.get(f'idem:{key}')\nif cached: return cached\nresp = handler(request)\nredis.set(f'idem:{key}', resp, ex=86400)\nreturn resp\n\n# ios client (PaymentClient.swift):\n#   func pay(order) { var req = ...; req.setValue(UUID().uuidString, forHTTPHeaderField: \"Idempotency-Key\"); retry(3) { send(req) } }\n#   (wait: the retry closure rebuilds req on every attempt)" : "key = request.headers['Idempotency-Key']\ncached = redis.get(f'idem:{key}')     # GET\nif cached: return cached\nresp = handler(request)               # charges the card\nredis.set(f'idem:{key}', resp, ex=86400)   # SET after the fact\nreturn resp" },
      { re: /^cat envoy\.yaml$/, use: "cat envoy.yaml", desc: "edge proxy route config", run: () => `routes:\n- match: { prefix: "/v1/" }\n  route:\n    cluster: api\n    timeout: 15s\n    retry_policy:\n      retry_on: "5xx,reset,connect-failure"\n      num_retries: 2` },
    ]);
    return {
      prompt: "oncall@logs:~$", init: { saw: false, sawGw: false }, run: (line, st) => sh.run(line, st), par: 5,
      motd: `JIRA PAY-${I.ticket}: "Customers charged twice" (${I.n} reports since Friday's release)`,
      cmds: ['psql -c "SELECT order_id, count(*) FROM charges GROUP BY order_id HAVING count(*) > 1"', "grep <order_id> api.log", "grep <order_id> gateway.log", "cat idempotency.py", "cat envoy.yaml"],
      opts: I.lv === 1 ? ["The iOS client retries after a 3 s timeout and sends no idempotency key", "The PSP sends duplicate webhooks", "The edge proxy retries POSTs on reset", "A Redis outage lost idempotency keys"]
        : I.lv === 2 ? ["The client generates a new idempotency key on every retry attempt", "Redis keys expire too soon (TTL)", "The edge proxy retries POSTs on reset", "Two pods don't share the Redis cache"]
          : ["The edge proxy retries POSTs on connection resets, and the GET-then-SET idempotency check lets two concurrent requests with the same key both charge", "The client generates a new key per attempt", "Redis keys expire too soon (TTL)", "The PSP is slow, so the client times out and retries"],
      optq: "Root cause",
    };
  }
  S.push({
    id: "data-dup-charge-investigation",
    name: "Who charged them twice?",
    kind: "Investigation",
    skills: ["diagnose", "comms"],
    ...LB.term({
      shell: dupShell,
      goal(st, I, a) { if (!st.saw) return "Back the diagnosis with evidence: look at the requests for one of the double-charged orders."; if (I.lv === 3 && !st.sawGw) return "The API log shows two requests 4 ms apart with the same key. Where did the second one come from?"; return a.pick === 0 ? true : "That's not what the logs show."; },
      solve: (I) => ({ log: ['psql -c "SELECT order_id, count(*) FROM charges GROUP BY order_id HAVING count(*) > 1"', `grep ${I.orders[0]} api.log`, ...(I.lv === 3 ? [`grep ${I.orders[0]} gateway.log`] : [])], pick: 0 }),
    }),
    gen(lv, R) { const o = R.distinct(2, 400000, 499999); return { lv, orders: o, ticket: R.int(1000, 9999), n: R.int(12, 60) }; },
    bad: (I) => [{ log: [`grep ${I.orders[0]} api.log`, `grep ${I.orders[0]} gateway.log`], pick: 1 }, { log: [], pick: 0 }],
    text: (I) => `<p>Support has ${I.n} reports of customers charged twice since Friday's release. You have the charges table, the API and edge-proxy logs, and the code. <b>Find an affected order, read what happened to it, and name the root cause.</b> The fix depends on it.</p>`,
    hint: (I) => I.lv === 1 ? "Look at the idem_key field and the gap between the two requests." : I.lv === 2 ? "Compare the idempotency keys of the two requests for one order." : "4 ms apart is no human retry. Check the gateway log's attempt count, then the middleware.",
    concept: "Tracing duplicate side effects",
    how: "Duplicate charges come from something sending the request twice (client retry, proxy retry, queue redelivery) plus nothing on the server recognising the second one. Start from the effect (charges grouped by order), pick one example, and line up every hop's logs by time: the gap between requests tells you who retried (seconds suggests a client timeout, milliseconds a proxy or a race), and the keys tell you whether idempotency was even possible. Proxies such as Envoy retry on resets unless told not to, so non-idempotent routes need their retry policy restricted, and an idempotency check must claim the key atomically (SET NX) before the side effect.",
    rule: "Follow one duplicated effect through every hop: count the requests, compare their keys and timing, and find which layer re-sent and which layer failed to deduplicate.",
    why: (I) => I.lv === 1 ? "Two requests 3 s apart, both without an idempotency key, right when the iOS client logs its 3,000 ms timeout: the client retried and the server had nothing to deduplicate with." : I.lv === 2 ? "The two requests carry different keys (7f3a9c1e, c91e04d2): the client builds the key inside the retry closure, so each attempt gets a fresh UUID. Generate it once per payment intent." : "The gateway log shows x-envoy-attempt-count=2 after a connection reset: Envoy re-sent the POST while the first copy was still being processed. Both copies did GET idem:key → miss before either SET it. Restrict retries on non-idempotent routes and claim the key with SET NX before charging.",
  });

  LB.addAll("data", S);
})();
