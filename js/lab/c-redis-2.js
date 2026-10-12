/* Systems Lab · Redis & caching (part 2: simulators for eviction, stampedes, persistence, rate limiting and caching layers;
   schedules, failure injection, reviews and plans). */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const RNG = (s) => D.campaign.rng(String(s));
  const GB = 1024 ** 3, MB = 1024 ** 2;
  const human = (b) => (b >= GB ? (b / GB).toFixed(1) + " GB" : b >= MB ? (b / MB).toFixed(0) + " MB" : (b / 1024).toFixed(0) + " KB");
    const S = [];

  /* ---------- shared: steps checker ---------- */
  // P: { opts:[{t, id, trap?:"why", opt?:true}], order:[ids in required order], need:[ids required, any position] }
  const stepsSpec = (P) => ({ opts: P.opts.map((o) => o.t) });
  function stepsCheck(P, seq) {
    const ids = seq.map((i) => P.opts[i].id);
    for (const i of seq) if (P.opts[i].trap) return `<b>${esc(P.opts[i].t)}</b>: ${P.opts[i].trap}`;
    for (const id of P.order) if (!ids.includes(id)) return `Your plan is missing a step: <b>${esc(P.opts.find((o) => o.id === id).t)}</b>${P.miss && P.miss[id] ? " " + P.miss[id] : ""}.`;
    const pos = (id) => ids.indexOf(id);
    for (let k = 1; k < P.order.length; k++) {
      const a = P.order[k - 1], b = P.order[k];
      if (pos(a) > pos(b)) return `<b>${esc(P.opts.find((o) => o.id === b).t)}</b> can't come before <b>${esc(P.opts.find((o) => o.id === a).t)}</b>${P.whyOrder && P.whyOrder[b] ? ": " + P.whyOrder[b] : "."}`;
    }
    return true;
  }
  const stepsSolve = (P) => P.order.map((id) => P.opts.findIndex((o) => o.id === id));
  // shuffle step options deterministically (keeps ids)
  const shuf = (R, arr) => R.shuffle(arr.slice());

  /* ---------- shared: interleave runner ----------
     lanes: [{name, steps:[text], ops:[fn(st, me)->note]}]; run(I, seq) replays ops in order */
  const runLanes = (lanes, init, seq) => {
    const st = K.clone(init), pos = lanes.map(() => 0), log = [];
    for (const l of seq || []) { const i = pos[l]++; if (i >= lanes[l].ops.length) continue; const note = lanes[l].ops[i](st, l) || ""; log.push({ l, label: lanes[l].steps[i], note }); }
    return { st, log, complete: (seq || []).length === lanes.reduce((s, x) => s + x.steps.length, 0) };
  };
  const laneHTML = (lanes, r) => K.table(["#", ...lanes.map((l) => esc(l.name))], r.log.map((e, k) => [String(k + 1), ...lanes.map((_, j) => (j === e.l ? `<span class="mono">${esc(e.label)}</span>${e.note ? `<br><small class="${/stale|LOST|both|oversold|corrupt|lost/.test(e.note) ? "lose" : "muted"}">${esc(e.note)}</small>` : ""}` : ""))]), { compact: true });
  const firstBreaking = (lanes, init, broken) => { for (const s of LB.interleavings ? [] : interleave(lanes.map((l) => l.steps.length))) { const r = runLanes(lanes, init, s); if (broken(r)) return s; } return null; };
  function* interleave(lens) {
    const left = lens.slice(), cur = [], total = lens.reduce((a, b) => a + b, 0);
    function* go() { if (cur.length === total) { yield cur.slice(); return; } for (let l = 0; l < left.length; l++) if (left[l] > 0) { left[l]--; cur.push(l); yield* go(); cur.pop(); left[l]++; } }
    yield* go();
  }
  const sequential = (lanes) => lanes.flatMap((l, i) => l.steps.map(() => i));

  /* ================================================================
     TUNE: eviction policy (LRU vs LFU, decay) on a simulated trace
     ================================================================ */
  function evSim(I, cfg) {
    const R = RNG(I.seed), N = I.keys, T = I.ops;
    const cap = Math.round(cfg.mem * I.perGB);
    const zipf = []; let tot = 0; for (let i = 0; i < N; i++) { tot += 1 / Math.pow(i + 1, I.zs || 0.95); zipf.push(tot); }
    const pick = () => { const u = R.next() * tot; let lo = 0, hi = N - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (zipf[m] < u) lo = m + 1; else hi = m; } return lo; };
    const perm2 = []; for (let i = 0; i < N; i++) perm2.push((i * 7919 + 13) % N);
    const lfu = cfg.policy === "allkeys-lfu", decay = cfg.decay == null ? 1 : cfg.decay;
    const arr = [], idx = new Map(), meta = new Map();
    let hits = 0, reqs = 0, clock = 0, scanNext = I.scanEvery || Infinity, scanId = 0;
    const touch = (k, tmin) => {
      const m = meta.get(k);
      if (lfu) {
        if (decay > 0) { const per = Math.floor((tmin - m.ldt) / decay); if (per > 0) m.c = Math.max(0, m.c - per); }
        m.ldt = tmin;
        if (m.c < 255) { const base = Math.max(0, m.c - 5); if (R.next() < 1 / (base * (I.lf == null ? 10 : I.lf) + 1)) m.c++; }
      }
      m.t = clock;
    };
    const evict = (tmin) => {
      let best = -1, bv = Infinity;
      for (let s = 0; s < (cfg.samples || 5); s++) {
        const j = Math.floor(R.next() * arr.length), k = arr[j], m = meta.get(k);
        let v;
        if (cfg.policy === "allkeys-random") v = R.next();
        else if (lfu) { let c = m.c; if (decay > 0) c = Math.max(0, c - Math.floor((tmin - m.ldt) / decay)); v = c * 1e9 + m.t; }
        else v = m.t;
        if (v < bv) { bv = v; best = j; }
      }
      const k = arr[best], last = arr.pop();
      if (best < arr.length) { arr[best] = last; idx.set(last, best); }
      idx.delete(k); meta.delete(k);
    };
    const access = (k, tmin, count) => {
      clock++;
      if (idx.has(k)) { touch(k, tmin); if (count) hits++; return; }
      if (arr.length >= cap) evict(tmin);
      idx.set(k, arr.length); arr.push(k); meta.set(k, { c: 5, ldt: tmin, t: clock });
    };
    const hitSeries = []; let wh = 0, wr = 0;
    for (let i = 0; i < T; i++) {
      const tmin = (i / T) * I.minutes;
      if (i >= scanNext) { for (let s = 0; s < I.scanLen; s++) access(N + scanId++, tmin, false); scanNext += I.scanEvery; }
      let k = pick();
      if (I.shift && i > T * I.shift) k = perm2[k];
      const before = hits;
      access(k, tmin, true);
      reqs++; wr++; wh += hits - before;
      if (wr === 1000) { hitSeries.push(wh / wr); wh = 0; wr = 0; }
    }
    const warm = Math.floor(hitSeries.length * 0.15);
    const tail = hitSeries.slice(warm);
    return { hit: K.mean(tail), series: hitSeries, cap };
  }
  const evKey = (c) => `${c.policy}/${c.mem}`;
  S.push({
    id: "redis-eviction-policy",
    name: "Pick the eviction policy and size",
    kind: "Capacity plan",
    skills: ["tune", "estimate"],
    w: "tune",
    sense: "min",
    vname: "maxmemory",
    vfmt: (v) => v + " GB",
    gen(lv, R) {
      const I = { lv, seed: `ev/${lv}/${R.int(1, 1e9)}`, keys: 20000, ops: 20000, perGB: 150, minutes: 80, lf: 1, zs: lv === 3 ? 1.2 : 1.1, target: 0, app: R.pick(["product catalog", "recommendations", "user profile"]) };
      if (lv === 2) { I.scanEvery = 1500; I.scanLen = 1500; }
      if (lv === 3) { I.scanEvery = 1000; I.scanLen = 2000; }
      const mems = [1, 2, 3, 4, 6, 8], pols = lv === 1 ? ["allkeys-lru", "allkeys-lfu", "allkeys-random"] : ["allkeys-lru", "allkeys-lfu"];
      const sims = {};
      for (const p of pols) for (const m of mems) sims[`${p}/${m}`] = K.round(evSim(I, { policy: p, mem: m, decay: 1 }).hit, 4);
      I.sims = sims;
      const best = (pol, t) => { for (const m of mems) if (sims[`${pol}/${m}`] >= t) return m; return 99; };
      const cands = [...new Set(Object.values(sims).map((v) => Math.floor(v * 200) / 200))].sort((x, y) => x - y);
      const ok = cands.filter((t) => {
        const lru = best("allkeys-lru", t), lfu = best("allkeys-lfu", t), rnd = lv === 1 ? best("allkeys-random", t) : 99, all = Math.min(lru, lfu, rnd);
        if (all > 8 || all < 2) return false;
        if (lv === 1) return rnd > all + 0 && rnd < 99 && (lru === all || lfu === all) && lru <= lfu + 1 && lfu <= lru + 1;
        if (lv === 2) return lfu === all && lru > lfu && lru < 99;
        return lfu === all && lru === 99;
      });
      if (!ok.length) return null;
      I.target = R.pick(ok);
      return I;
    },
    text: (I) => `<p>You're sizing a Redis cache for the ${esc(I.app)} service: ${K.num(I.keys)} distinct keys with Zipf-like popularity${I.lv >= 2 ? `, plus a batch job that reads <b>${K.num(I.scanLen)} one-off keys</b> through the same cache every ${K.num(I.scanEvery)} user requests (an export, a crawler, a reindex)` : ""}.</p><p>Choose the policy and the <b>smallest maxmemory</b> that keeps the user-facing hit ratio at or above <b>${K.pct(I.target, 1)}</b>. The simulator replays a ${K.num(I.ops)}-request trace with Redis's sampled eviction (maxmemory-samples 5; LFU counters start at 5 for new keys and decay over idle minutes).</p>`,
    ui: (I) => ({ knobs: [
      { k: "policy", label: "maxmemory-policy", opts: I.lv === 1 ? ["allkeys-lru", "allkeys-lfu", "allkeys-random"] : ["allkeys-lru", "allkeys-lfu"] },
      { k: "mem", label: "maxmemory", opts: [1, 2, 3, 4, 6, 8], unit: "GB", help: `≈ ${I.perGB} keys per GB` },
    ], live: (cfg) => {
      const r = evSim(I, { decay: 1, ...cfg });
      return K.metrics([{ name: "User hit ratio", value: K.pct(I.sims[evKey(cfg)], 1), ok: I.sims[evKey(cfg)] >= I.target, target: `≥ ${K.pct(I.target, 1)}` }, { name: "Capacity", value: K.num(r.cap) + " keys", ok: null }]) + K.chart([{ name: "hit ratio per 1k requests", pts: r.series.map((x) => x * 100) }], { ymin: 0, ymax: 100, hline: { y: I.target * 100, label: "target" }, fmt: (v) => v.toFixed(0) + "%", xlabel: "×1k requests" });
    } }),
    valid: (I, cfg) => { const h = I.sims[evKey(cfg)]; return h >= I.target ? true : `hit ratio ${K.pct(h, 1)} is below ${K.pct(I.target, 1)}${I.lv === 3 && cfg.policy === "allkeys-lru" && cfg.mem >= 4 ? " (and more memory barely helps: every batch run flushes the cache under LRU)" : ""}`; },
    val: (I, cfg) => cfg.mem,
    hint: (I) => I.lv === 1 ? "Policies that keep frequently or recently used keys beat random eviction on skewed traffic." : I.lv === 2 ? "Each batch run touches thousands of keys exactly once. Which policy lets a one-off key in without pushing out the hot set?" : "Try LRU at a few sizes. Does the hit ratio keep growing with memory? Why not?",
    concept: "LRU vs LFU eviction under scans",
    how: "Redis approximates LRU and LFU by sampling maxmemory-samples keys and evicting the worst of the sample. LRU ranks by last access, so a scan of one-off keys (a batch job, a crawler) makes those keys the most recent and pushes the hot set out; past a point, extra memory doesn't help because each scan flushes it again. LFU keeps a small logarithmic access counter per key (lfu-log-factor controls how fast it saturates); new keys start at 5, so one-off keys are the first evicted while frequently used keys stay. Counters decay by one per lfu-decay-time minutes of inactivity so yesterday's favourites eventually age out.",
    rule: "Skewed, stable traffic: LRU or LFU both work (random wastes memory). Scans or one-off reads through the cache: allkeys-lfu, or keep the batch job out of the shared cache.",
    why: (I, sol) => `The cheapest config that met ${K.pct(I.target, 1)} was <b>${esc(sol.policy)}</b> at <b>${sol.mem} GB</b> (hit ratio ${K.pct(I.sims[evKey(sol)], 1)}). ${I.lv === 1 ? "Random eviction needed more memory for the same hit ratio." : I.lv === 2 ? "Under LRU every batch run flushed part of the hot set, so it needed more memory; LFU let the one-off keys in at counter 5 and evicted them first." : `LRU tops out around ${K.pct(I.sims["allkeys-lru/8"], 1)} even at 8 GB: each batch run of ${K.num(I.scanLen)} keys flushes the cache. LFU keeps the hot set through the scans.`}`,
  });

  /* ================================================================
     TUNE: cache stampede
     ================================================================ */
  function stampede(I, cfg) {
    const R = RNG(I.seed + "/" + K.stable(cfg));
    const dur = I.dur, servers = I.dbConns, svcBase = I.cost;
    const free = Array(servers).fill(0);
    const nk = I.nkeys;
    const ttl = I.ttl;
    const keys = [];
    for (let k = 0; k < nk; k++) { const j = cfg.jitter ? 1 - cfg.jitter * R.next() : 1; keys.push({ exp: (I.lv === 2 ? I.warmAt : ttl * (k / nk) * 0) + ttl * j - (I.lv === 2 ? 0 : ttl - I.first), soft: 0, fill: null, lock: -1, lockUntil: -1, refreshing: false, delta: svcBase / 1000 }); }
    if (I.lv !== 2) keys.forEach((k) => (k.exp = I.first));
    const dbArr = new Array(Math.ceil(dur)).fill(0), dbErr = { n: 0 };
    let inflight = [];
    const lat = [], errs = { n: 0 };
    const db = (t) => {
      // returns completion time or null (timeout while queued)
      inflight = inflight.filter((x) => x > t);
      const slow = 1 + Math.max(0, inflight.length - servers) / servers * 0.5;
      let j = 0; for (let s = 1; s < servers; s++) if (free[s] < free[j]) j = s;
      const start = Math.max(t, free[j]);
      if (start - t > I.dbTimeout) { dbErr.n++; return null; }
      const end = start + (svcBase * slow * (0.8 + 0.4 * R.next())) / 1000;
      free[j] = end; inflight.push(end);
      if (t < dur) dbArr[Math.floor(t)]++;
      return end;
    };
    const lam = I.rps;
    let t = 0;
    const pend = []; // pending fills: {k, at}
    while (t < dur) {
      t += K.exp(R, 1 / lam);
      const key = keys[Math.floor(R.next() * nk)];
      // apply fills that completed
      if (key.fill != null && key.fill <= t) { key.exp = key.fill + ttl * (cfg.jitter ? 1 - cfg.jitter * R.next() : 1); key.fill = null; key.refreshing = false; }
      const fresh = t < key.exp;
      if (fresh) {
        if (cfg.protect === "early" && !key.refreshing) {
          const gap = key.exp - t, x = -key.delta * 1.0 * Math.log(1 - R.next());
          if (x >= gap) { key.refreshing = true; const e = db(t); if (e == null) { errs.n++; lat.push(I.dbTimeout * 1000); key.refreshing = false; } else { key.fill = e; lat.push((e - t) * 1000); } continue; }
        }
        lat.push(1); continue;
      }
      // expired
      if (cfg.protect === "swr" && t < key.exp + ttl) {
        if (!key.refreshing) { key.refreshing = true; const e = db(t); if (e == null) key.refreshing = false; else key.fill = e; }
        lat.push(1); continue;
      }
      if (cfg.protect === "lock") {
        if (key.lockUntil > t && key.fill != null) { lat.push(Math.max(1, (key.fill - t) * 1000 + 25)); continue; }
        if (key.lockUntil > t && key.fill == null) { lat.push(I.dbTimeout * 1000); errs.n++; continue; }
        key.lockUntil = t + cfg.lockTtl;
        const e = db(t);
        if (e == null) { errs.n++; lat.push(I.dbTimeout * 1000); continue; }
        key.fill = key.fill == null ? e : Math.min(key.fill, e);
        lat.push((e - t) * 1000); continue;
      }
      const e = db(t);
      if (e == null) { errs.n++; lat.push(I.dbTimeout * 1000); continue; }
      key.fill = key.fill == null ? e : Math.min(key.fill, e);
      lat.push((e - t) * 1000);
      void pend;
    }
    const peak = Math.max(...dbArr);
    return { peak, series: dbArr, p99: K.quantile(lat, 0.99), errs: errs.n + dbErr.n * 0, n: lat.length, dbq: K.sum(dbArr) };
  }
  const stCheck = (I, r) => r.errs > 0 ? `${K.num(r.errs)} requests failed (DB connection-pool queue exceeded ${I.dbTimeout} s)` : r.peak > I.cap ? `DB peaked at ${K.num(r.peak)} queries/s (limit ${K.num(I.cap)})` : r.p99 > I.p99 ? `p99 latency ${K.ms(r.p99)} (target ${K.ms(I.p99)})` : true;
  S.push({
    id: "redis-stampede",
    name: "Stop the cache stampede",
    kind: "Incident",
    skills: ["tune", "design"],
    w: "tune",
    gen(lv, R) {
      const I = { lv, seed: `st/${lv}/${R.int(1, 1e9)}`, dur: 40, dbTimeout: 2 };
      if (lv === 1) Object.assign(I, { nkeys: 1, rps: R.int(15, 25) * 100, cost: R.int(25, 40) * 10, ttl: 60, first: 10, dbConns: 20, cap: 50, p99: 2000, key: "home:feed:top" });
      if (lv === 2) Object.assign(I, { nkeys: 2000, rps: R.int(20, 30) * 100, cost: R.int(10, 16) * 10, ttl: 60, warmAt: 0, dbConns: 40, cap: 400, p99: 400, key: "product:<id>", dur: 75 });
      if (lv === 3) Object.assign(I, { nkeys: 1, rps: R.int(15, 25) * 100, cost: R.int(30, 45) * 100, ttl: 60, first: 8, dbConns: 30, cap: 40, p99: 250, key: "dashboard:global:stats" });
      return I;
    },
    text: (I) => I.lv === 1 ? `<p><code>${I.key}</code> is read ${K.num(I.rps)} times a second and costs a ${I.cost} ms query to rebuild. Every ${I.ttl} s it expires and Postgres (${I.dbConns}-connection pool) falls over for a few seconds.</p><p>Tune the cache so the DB never sees more than <b>${I.cap} queries/s</b> and no request fails.</p>`
      : I.lv === 2 ? `<p>A deploy restarted the cache, and a warmup job filled all ${K.num(I.nkeys)} product keys within a second, each with TTL ${I.ttl} s. Every ${I.ttl} s since, Postgres gets slammed. Traffic is ${K.num(I.rps)} req/s spread over the products; a rebuild costs ${I.cost} ms.</p><p>Keep the DB under <b>${I.cap} queries/s</b>, p99 under ${I.p99} ms, with no failed requests.</p>`
        : `<p><code>${I.key}</code> is read ${K.num(I.rps)} times a second. Rebuilding it is a ${(I.cost / 1000).toFixed(1)} s aggregation. The team already added a lock (<code>SET lock NX PX</code>) so only one request rebuilds, but the DB still spikes and the dashboard p99 is awful.</p><p>Meet: DB ≤ <b>${I.cap} queries/s</b>, user p99 ≤ <b>${I.p99} ms</b>, no failed requests. A slightly stale dashboard is fine.</p>`,
    ui: (I) => ({ knobs: [
      { k: "protect", label: "Miss handling", opts: ["none", "lock", "early", "swr"], fmt: (v) => ({ none: "every miss queries DB", lock: "lock + wait (single flight)", early: "probabilistic early refresh", swr: "serve stale, refresh async" })[v], help: "how requests behave around expiry" },
      { k: "jitter", label: "TTL jitter", opts: [0, 0.1, 0.3], fmt: (v) => (v ? "−" + v * 100 + "% random" : "none") },
      ...(I.lv === 3 ? [{ k: "lockTtl", label: "Lock TTL", opts: [1, 5, 30], unit: "s", help: "only used by lock + wait" }] : []),
    ], init: { protect: I.lv === 3 ? "lock" : "none", jitter: 0, lockTtl: 1 }, live: (cfg) => {
      const r = stampede(I, { lockTtl: 1, ...cfg });
      return K.metrics([{ name: "DB peak", value: K.num(r.peak) + " q/s", ok: r.peak <= I.cap, target: `≤ ${I.cap}` }, { name: "User p99", value: K.ms(r.p99), ok: r.p99 <= I.p99, target: `≤ ${K.ms(I.p99)}` }, { name: "Failed requests", value: K.num(r.errs), ok: r.errs === 0, target: "0" }]) + K.chart([{ name: "DB queries/s", pts: r.series, cls: r.peak > I.cap ? "bad" : "good" }], { hline: { y: I.cap, label: "DB limit" }, xlabel: "s" });
    } }),
    accept: (I, cfg) => stCheck(I, stampede(I, { lockTtl: 1, ...cfg })),
    solve: (I) => I.lv === 1 ? { protect: "lock", jitter: 0 } : I.lv === 2 ? { protect: "none", jitter: 0.3 } : { protect: "swr", jitter: 0, lockTtl: 1 },
    bad: (I) => I.lv === 1 ? [{ protect: "none", jitter: 0.3 }, { protect: "none", jitter: 0 }] : I.lv === 2 ? [{ protect: "lock", jitter: 0 }, { protect: "early", jitter: 0 }] : [{ protect: "lock", jitter: 0, lockTtl: 1 }, { protect: "lock", jitter: 0, lockTtl: 30 }],
    hint: (I) => I.lv === 1 ? "One key, thousands of readers: when it expires, how many of them go to the database at once?" : I.lv === 2 ? "Each key is only missed a handful of times, but they all expire in the same second." : "Requests that wait for the lock wait the full rebuild time. And what happens when the lock expires before the rebuild finishes?",
    concept: "Cache stampede (thundering herd) protection",
    how: "When a hot key expires, every request that arrives during the rebuild misses and hits the database, which slows the rebuild and widens the window. Single-flight (a SET NX lock; others wait or retry) collapses that to one query, but waiters block for the full rebuild and a lock TTL shorter than the rebuild lets a second rebuild start. Probabilistic early refresh (XFetch) lets one lucky request rebuild shortly before expiry; serving stale while one background refresh runs keeps latency flat. When many keys were written together (a warmup), they expire together: per-key protection doesn't help, random TTL jitter spreads them out.",
    rule: "Hot keys: refresh before expiry or serve stale while revalidating. Bulk-loaded keys: add TTL jitter. Locks: TTL longer than the worst rebuild, and don't make users wait on them.",
    why: (I, sol) => { const r = stampede(I, { lockTtl: 1, ...sol }); const r0 = stampede(I, { protect: I.lv === 3 ? "lock" : "none", jitter: 0, lockTtl: 1 }); return `Before: DB peak ${K.num(r0.peak)} q/s, p99 ${K.ms(r0.p99)}. With ${sol.protect}${sol.jitter ? ` and ${sol.jitter * 100}% jitter` : ""}: ${K.num(r.peak)} q/s, p99 ${K.ms(r.p99)}. ${I.lv === 1 ? "Collapsing the misses into one rebuild (or refreshing early) removes the herd; jitter alone does nothing for a single key." : I.lv === 2 ? `All ${K.num(I.nkeys)} keys were set in the same second, so they expired together; jitter spread the rebuilds across the TTL. A lock per key doesn't help: each key is only one query anyway.` : `The ${(I.cost / 1000).toFixed(1)} s rebuild outlived a 1 s lock, so rebuilds stacked up, and with a long lock every waiting request still waited seconds. Serving the stale value while one refresh runs (or refreshing early) keeps p99 near cache latency.`}`; },
  });

  /* ================================================================
     TUNE: persistence (RDB / AOF / where)
     ================================================================ */
  function persist(I, c) {
    const aof = c.aof === "yes", forkMs = I.gb * I.forkPerGB;
    const onRep = c.where === "replica";
    const rdbP = c.save === "off" ? 0 : +c.save;
    const aofBw = aof ? I.wps * I.bytes / MB : 0;
    const rdbBw = rdbP ? (I.gb * 1024) / rdbP : 0;
    let rpo = aof ? (c.fsync === "always" ? 0 : c.fsync === "everysec" ? 2 : 30) : rdbP ? rdbP + I.gb * 1024 / 400 : Infinity;
    if (onRep && rpo !== Infinity) rpo += I.lag;
    if (aof && c.fsync === "always" && !onRep) rpo = 0;
    const pfx = onRep ? 0 : 1;
    const writeP99 = (aof && c.fsync === "always" && !onRep ? I.fsyncMs : 0) + 0.4;
    const rewriteEvery = aof ? Math.max(600, (I.gb * 1024) / Math.max(0.01, aofBw)) : Infinity;
    const forks = pfx ? (rdbP ? 1 / rdbP : 0) + (aof ? 1 / rewriteEvery : 0) : 0;
    const stallFrac = forks * forkMs / 1000;
    const maxStall = pfx && forks > 0 ? forkMs : 0;
    const disk = aofBw + rdbBw;
    return { rpo, writeP99, maxStall, stallFrac, disk, forkMs, aofBw };
  }
  const persistCheck = (I, c) => {
    const r = persist(I, c);
    if (r.disk > I.diskMBs) return `the disk can sustain ${I.diskMBs} MB/s but this needs ${r.disk.toFixed(0)} MB/s${r.aofBw > I.diskMBs ? " (the AOF alone can't keep up with the write rate)" : ""}`;
    if (r.rpo > I.rpo) return `worst-case data loss ${r.rpo === Infinity ? "everything since start" : "≈ " + K.num(r.rpo, 1) + " s"}, budget ${I.rpo} s`;
    if (r.writeP99 > I.p99) return `write p99 ≈ ${r.writeP99.toFixed(1)} ms (an fsync per write), budget ${I.p99} ms`;
    if (I.maxStall != null && r.maxStall > I.maxStall) return `the primary freezes ~${K.num(r.forkMs)} ms on every fork (BGSAVE or AOF rewrite); the max-stall budget is ${I.maxStall} ms`;
    if (r.stallFrac > I.stallFrac) return `fork stalls take ${K.pct(r.stallFrac, 2)} of the time, so ~${K.pct(r.stallFrac, 2)} of requests wait ~${K.num(r.forkMs)} ms: that breaks the p99.9 target`;
    return true;
  };
  S.push({
    id: "redis-persistence-rpo",
    name: "Choose RDB, AOF and fsync",
    kind: "Config change",
    skills: ["tune", "design"],
    w: "tune",
    sense: "min",
    vname: "worst-case data loss",
    vfmt: (v) => (v === Infinity ? "everything" : K.num(v, 1) + " s"),
    gen(lv, R) {
      const I = { lv, lag: 0.2 };
      if (lv === 1) Object.assign(I, { use: "the job queue for transactional emails", gb: R.pick([2, 3, 4]), wps: R.int(2, 6) * 1000, bytes: 600, fsyncMs: R.pick([3, 4, 6]), diskMBs: 250, rpo: 3, p99: 2, forkPerGB: 12, stallFrac: 0.001 });
      if (lv === 2) Object.assign(I, { use: "a clickstream counter store (losing a few minutes is acceptable)", gb: R.pick([10, 12, 16]), wps: R.int(150, 220) * 1000, bytes: 900, fsyncMs: 5, diskMBs: 125, rpo: 900, p99: 2, forkPerGB: 15, stallFrac: 0.001 });
      if (lv === 3) Object.assign(I, { use: "the order-state store for checkout", gb: R.pick([40, 48, 56]), wps: R.int(8, 15) * 1000, bytes: 500, fsyncMs: 4, diskMBs: 250, rpo: 3, p99: 2, forkPerGB: 15, stallFrac: 0.001, maxStall: 100 });
      return I;
    },
    text: (I) => `<p>Configure persistence for ${esc(I.use)}: ${I.gb} GB dataset, ~${K.num(I.wps)} writes/s of ~${I.bytes} B, disk fsync ≈ ${I.fsyncMs} ms, disk bandwidth ${I.diskMBs} MB/s. fork() costs ~${I.forkPerGB} ms per GB on these VMs.${I.lv === 3 ? " There is an in-sync replica (lag ~200 ms) that can run persistence instead of the primary." : ""}</p><p>Requirements: write p99 ≤ ${I.p99} ms, p99.9 not ruined by fork stalls${I.maxStall ? `, <b>no stall over ${I.maxStall} ms</b> on the primary` : ""}, and worst-case data loss ≤ <b>${I.rpo} s</b> if the node dies. Among valid configs, minimise data loss.</p>`,
    ui: (I) => ({ knobs: [
      { k: "aof", label: "appendonly", opts: ["no", "yes"] },
      { k: "fsync", label: "appendfsync", opts: ["always", "everysec", "no"], help: "only with appendonly yes" },
      { k: "save", label: "RDB snapshots (save)", opts: ["off", "60", "300", "3600"], fmt: (v) => (v === "off" ? 'save ""' : "every " + v + " s") },
      ...(I.lv === 3 ? [{ k: "where", label: "Persist on", opts: ["primary", "replica"] }] : []),
    ], init: { aof: "no", fsync: "everysec", save: "3600", where: "primary" }, live: (c) => {
      const r = persist(I, { where: "primary", ...c });
      const v = persistCheck(I, { where: "primary", ...c });
      return K.metrics([
        { name: "Worst-case loss", value: r.rpo === Infinity ? "all" : K.num(r.rpo, 1) + " s", ok: r.rpo <= I.rpo, target: `≤ ${I.rpo} s` },
        { name: "Write p99", value: r.writeP99.toFixed(1) + " ms", ok: r.writeP99 <= I.p99, target: `≤ ${I.p99} ms` },
        { name: "Disk write", value: r.disk.toFixed(0) + " MB/s", ok: r.disk <= I.diskMBs, target: `≤ ${I.diskMBs}` },
        { name: "Fork stalls (primary)", value: r.maxStall ? `${K.num(r.maxStall)} ms, ${K.pct(r.stallFrac, 3)} of time` : "none", ok: r.stallFrac <= I.stallFrac && (!I.maxStall || r.maxStall <= I.maxStall) },
      ]) + (v === true ? K.verdict(true, "meets every requirement") : K.verdict(false, v));
    } }),
    valid: (I, c) => persistCheck(I, { where: "primary", ...c }),
    val: (I, c) => K.round(persist(I, { where: "primary", ...c }).rpo, 1),
    hint: (I) => I.lv === 1 ? "appendfsync always fsyncs before replying; everysec fsyncs in the background once a second." : I.lv === 2 ? "Compare the AOF's write bandwidth with the disk. Then: how often can you snapshot before forks hurt p99.9?" : "Every BGSAVE and every AOF rewrite forks the process doing it. Which process has to fork?",
    concept: "RDB vs AOF, appendfsync and fork cost",
    how: "RDB snapshots fork the process and write the whole dataset: compact and fast to load, but you lose everything since the last snapshot, and each fork briefly freezes a big instance. AOF appends every write: appendfsync always fsyncs before acknowledging (no loss, latency = fsync), everysec fsyncs once a second in a background thread (up to ~1–2 s lost on a crash), no leaves it to the OS (~30 s). The AOF is periodically rewritten by a forked child; with aof-use-rdb-preamble (default) the rewrite starts with an RDB image, so restarts stay fast. Persisting on a replica moves the forks and disk I/O off the primary at the cost of replication lag.",
    rule: "Queues and state you can't rebuild: AOF everysec (always only if each write is worth an fsync). Rebuildable caches: no AOF, rare or no snapshots. Large latency-sensitive primaries: persist on a replica, but never let a persistence-less primary auto-restart empty and wipe its replicas.",
    why: (I, sol) => { const r = persist(I, { where: "primary", ...sol }); return `Best: appendonly ${sol.aof}${sol.aof === "yes" ? `, appendfsync ${sol.fsync}` : ""}, ${sol.save === "off" ? "no RDB" : "RDB every " + sol.save + " s"}${I.lv === 3 ? `, on the ${sol.where}` : ""}: worst-case loss ≈ ${K.num(r.rpo, 1)} s. ${I.lv === 1 ? `appendfsync always would add a ${I.fsyncMs} ms fsync to every write.` : I.lv === 2 ? `At ~${K.num(I.wps)} writes/s the AOF needs ~${(I.wps * I.bytes / MB).toFixed(0)} MB/s, more than the disk; RDB every 60 s would write ${(I.gb * 1024 / 60).toFixed(0)} MB/s and fork every minute.` : `Any fork of a ${I.gb} GB primary stalls it ~${K.num(I.gb * I.forkPerGB)} ms, and even AOF needs periodic rewrites (forks). Persisting on the replica keeps the primary fork-free; replication lag adds ~${I.lag * 1000} ms to the loss window.`}`; },
  });

  /* ================================================================
     TUNE: fork copy-on-write and maxmemory sizing
     ================================================================ */
  function forkMem(I, c) {
    const D = c.mem; // GB of data
    const saveSec = (D * 1024) / 300; // RDB write ~300 MB/s
    const pageKB = c.thp === "always" ? 2048 : 4;
    const pages = (D * 1024 * 1024) / pageKB;
    const touched = 1 - Math.exp(-(I.wps * saveSec) / pages);
    const cow = D * touched;
    const forks = I.lv === 3 || c.persist !== "replica" || I.replicas > 0;
    const rss = D * I.frag + I.overhead;
    const peak = rss + (forks ? cow : 0);
    let forkFail = c.overcommit === 0 && forks && rss > I.ram * 0.5;
    return { peak, cow: forks ? cow : 0, rss, forkFail, saveSec, touched, forks };
  }
  const fmCheck = (I, c) => {
    const r = forkMem(I, c);
    if (r.forkFail) return `BGSAVE fails: "Can't save in background: fork: Cannot allocate memory" (with vm.overcommit_memory = 0 the kernel can refuse to fork a ${r.rss.toFixed(0)} GB process)`;
    if (r.peak > I.ram * 0.95) return `peak RSS during ${r.forks && c.persist === "replica" ? "replica full sync" : "BGSAVE"} ≈ ${r.peak.toFixed(1)} GB on a ${I.ram} GB host: the kernel OOM-kills Redis`;
    return true;
  };
  S.push({
    id: "redis-fork-cow",
    name: "Leave room for BGSAVE",
    kind: "Capacity plan",
    skills: ["estimate", "tune"],
    w: "tune",
    vname: "maxmemory",
    vfmt: (v) => v + " GB",
    gen(lv, R) {
      const I = { lv, ram: R.pick([32, 64]), frag: 1.1, overhead: 1, replicas: 1 };
      I.wps = lv === 1 ? R.int(2, 5) * 1000 : R.int(20, 40) * 1000;
      return I;
    },
    text: (I) => `<p>A Redis primary runs alone on a <b>${I.ram} GB</b> VM with one replica. It takes ${I.wps >= 20000 ? "a heavy" : "a light"} write load (~${K.num(I.wps)} writes/s spread over the keyspace) and ${I.lv === 3 ? "the team proposes moving RDB snapshots to the replica \"so the primary never forks and we can give it almost all the RAM\"" : "snapshots with BGSAVE every hour"}.</p><p>Choose the <b>largest maxmemory</b> that survives a fork: during the snapshot, pages the parent writes are copied (copy-on-write), on top of ~10% fragmentation and 1 GB of overhead.</p>`,
    ui: (I) => ({ knobs: [
      { k: "mem", label: "maxmemory", opts: I.ram === 32 ? [12, 16, 20, 24, 28] : [24, 32, 40, 48, 56], unit: "GB" },
      { k: "overcommit", label: "vm.overcommit_memory", opts: [0, 1], fmt: (v) => (v ? "1 (always)" : "0 (heuristic, default)") },
      ...(I.lv >= 2 ? [{ k: "thp", label: "Transparent Huge Pages", opts: ["always", "never"] }] : []),
      ...(I.lv === 3 ? [{ k: "persist", label: "RDB snapshots on", opts: ["primary", "replica"] }] : []),
    ], init: { overcommit: 0, ...(I.lv >= 2 ? { thp: "always" } : {}), ...(I.lv === 3 ? { persist: "primary" } : {}) }, live: (c) => {
      const r = forkMem(I, { thp: "never", persist: "primary", ...c });
      const v = fmCheck(I, { thp: "never", persist: "primary", ...c });
      return K.bars([{ label: "RSS (data + frag + overhead)", value: r.rss, note: r.rss.toFixed(1) + " GB" }, { label: "copy-on-write during fork", value: r.cow, cls: "hot", note: r.cow.toFixed(1) + ` GB (${K.pct(r.touched, 0)} of pages)` }, { label: "peak", value: r.peak, cls: r.peak > I.ram * 0.95 ? "bad" : "good", note: r.peak.toFixed(1) + " GB" }], { max: I.ram * 1.3 }) + `<p class="muted small">Host RAM ${I.ram} GB · fork snapshot ≈ ${r.saveSec.toFixed(0)} s</p>` + (v === true ? K.verdict(true, "survives a fork") : K.verdict(false, v));
    } }),
    valid: (I, c) => fmCheck(I, { thp: "never", persist: "primary", ...c }),
    val: (I, c) => c.mem,
    hint: (I) => I.lv === 1 ? "Two things can kill a BGSAVE: the kernel refusing the fork, and memory running out while both copies exist." : I.lv === 2 ? "With huge pages, writing one byte copies 2 MB instead of 4 KB." : "If the snapshot moves to the replica, does the primary still ever fork? Think about what happens when the replica needs a full resync.",
    concept: "fork(), copy-on-write and maxmemory headroom",
    how: "BGSAVE, AOF rewrite and replica full sync all fork() the Redis process. Parent and child share memory pages; every page the parent writes during the snapshot gets copied, so peak memory is RSS plus the pages dirtied during the save, which grows with write rate and snapshot duration. With Transparent Huge Pages a single write copies a 2 MB page instead of 4 KB, inflating copy-on-write and latency (Redis warns about THP at startup). With vm.overcommit_memory=0 the kernel may refuse the fork of a large process outright. Moving snapshots to a replica doesn't remove the primary's fork: a replica's full resync makes the primary fork to produce the RDB (diskless sync still forks).",
    rule: "Set vm.overcommit_memory=1, disable THP, and size maxmemory so RSS + copy-on-write for a full snapshot fits in RAM, on every node that may ever fork (which includes any primary with replicas).",
    why: (I, sol) => { const r = forkMem(I, { thp: "never", persist: "primary", ...sol }); return `At ${sol.mem} GB the fork peak is ≈ ${r.peak.toFixed(1)} GB of ${I.ram} GB (copy-on-write ${r.cow.toFixed(1)} GB). ${I.lv === 1 ? "overcommit_memory=1 is needed or the kernel refuses to fork a process this large." : I.lv === 2 ? "With THP on, almost every page gets copied during the snapshot." : "Snapshots on the replica don't save the primary: the replica's next full resync forks it, so the same headroom is needed."}`; },
  });

  /* ================================================================
     TUNE: rate limiter algorithm
     ================================================================ */
  function rlRun(c, times) {
    const out = [];
    const L = c.limit, W = 60;
    if (c.algo === "fixed") { const m = new Map(); for (const t of times) { const w = Math.floor(t / W); const n = (m.get(w) || 0) + 1; m.set(w, n); out.push(n <= L); } }
    else if (c.algo === "log") { const log = []; for (const t of times) { while (log.length && log[0] <= t - W) log.shift(); if (log.length < L) { log.push(t); out.push(true); } else out.push(false); } }
    else if (c.algo === "counter") { const m = new Map(); for (const t of times) { const w = Math.floor(t / W), f = (t - w * W) / W; const est = (m.get(w - 1) || 0) * (1 - f) + (m.get(w) || 0); if (est < L) { m.set(w, (m.get(w) || 0) + 1); out.push(true); } else out.push(false); } }
    else { let tok = c.burst, last = 0; const r = L / W; for (const t of times) { tok = Math.min(c.burst, tok + (t - last) * r); last = t; if (tok >= 1) { tok -= 1; out.push(true); } else out.push(false); } }
    return out;
  }
  const maxWin = (ts) => { let best = 0, j = 0; for (let i = 0; i < ts.length; i++) { while (ts[i] - ts[j] >= 60) j++; best = Math.max(best, i - j + 1); } return best; };
  function rlEval(I, c) {
    const legit = [], R = RNG(I.seed);
    for (let b = 0; b < 600 / I.every; b++) { const t0 = 5 + b * I.every + R.next() * 2; for (let k = 0; k < I.burst; k++) legit.push(t0 + k * 0.01); }
    const lAllowed = rlRun(c, legit), denied = lAllowed.filter((x) => !x).length;
    const att = [];
    for (let t = 0.5; t < 600; t += 60 / (I.limit * 4)) att.push(t);
    for (const edge of [180, 360]) { for (let k = 0; k < I.limit * 1.5; k++) { att.push(edge - 0.5 + k * 0.001); att.push(edge + 0.01 + k * 0.001); } }
    att.sort((a, b) => a - b);
    const aOk = rlRun(c, att), allowedTs = att.filter((_, i) => aOk[i]);
    const peak = maxWin(allowedTs);
    const per = c.algo === "fixed" ? 72 : c.algo === "counter" ? 144 : c.algo === "tb" ? 96 : 40 + c.limit * 64;
    const mem = per * I.users;
    return { denied, peak, mem, per };
  }
  const rlCheck = (I, c) => { const r = rlEval(I, c); if (r.denied) return `the legitimate client gets ${r.denied} requests rejected (it sends bursts of ${I.burst})`; if (r.peak > I.cap) return `an abusive client gets ${r.peak} requests through in some 60 s window (cap ${I.cap})`; if (r.mem > I.memBudget) return `${human(r.mem)} of Redis memory for ${K.num(I.users)} active clients (budget ${human(I.memBudget)})`; return true; };
  S.push({
    id: "redis-rate-limiter",
    name: "Pick the rate limiter",
    kind: "Design review",
    skills: ["design", "tune"],
    w: "tune",
    sense: "min",
    vname: "memory",
    vfmt: (v) => human(v),
    gen(lv, R) {
      const I = { lv, seed: `rl/${lv}/${R.int(1, 1e9)}` };
      if (lv === 1) Object.assign(I, { limit: 100, burst: 40, every: 30, cap: 150, users: 20000, memBudget: 64 * MB });
      if (lv === 2) Object.assign(I, { limit: 100, burst: 100, every: 90, cap: 100, users: 5000, memBudget: 256 * MB });
      if (lv === 3) Object.assign(I, { limit: 600, burst: 200, every: 30, cap: 650, users: R.pick([4, 5, 6]) * 1000000, memBudget: 2 * GB });
      return I;
    },
    text: (I) => `<p>The public API needs a per-client rate limit in Redis (${K.num(I.users)} active clients). Requirements from the ${I.lv === 2 ? "<b>partner contract</b>" : "API team"}:</p><ul><li>A well-behaved client averages ≤ ${I.burst * 60 / I.every} req/min but sends <b>bursts of ${I.burst}</b> at once${I.lv === 2 ? " (a nightly sync)" : ""}: it must never be rejected.</li><li>No client may get more than <b>${I.cap} requests in any rolling 60 s</b>${I.lv === 2 ? " (contractual, exact)" : ""}, including one that hammers the window boundary.</li><li>Limiter state must fit in <b>${human(I.memBudget)}</b>.</li></ul><p>The simulator replays a bursty legit client and an attacker (steady overload plus 1.5× the limit on each side of a minute boundary). Pick the cheapest limiter that passes.</p>`,
    ui: (I) => ({ knobs: [
      { k: "algo", label: "Algorithm", opts: ["fixed", "log", "counter", "tb"], fmt: (v) => ({ fixed: "fixed window (INCR+EXPIRE)", log: "sliding log (ZSET)", counter: "sliding window counter", tb: "token bucket (Lua)" })[v] },
      { k: "limit", label: "Limit / refill per minute", opts: I.lv === 3 ? [300, 450, 600, 900] : [60, 100, 150, 200] },
      { k: "burst", label: "Bucket capacity", opts: I.lv === 3 ? [50, 100, 200, 300] : [20, 40, 60, 100], help: "token bucket only" },
    ], init: { algo: "fixed", limit: I.lv === 3 ? 600 : 100, burst: I.lv === 3 ? 200 : 40 }, live: (c) => {
      const r = rlEval(I, c);
      return K.metrics([{ name: "Legit requests rejected", value: K.num(r.denied), ok: r.denied === 0, target: "0" }, { name: "Attacker max / 60 s", value: K.num(r.peak), ok: r.peak <= I.cap, target: `≤ ${I.cap}` }, { name: "Memory", value: human(r.mem), ok: r.mem <= I.memBudget, target: `≤ ${human(I.memBudget)} (${r.per} B/client)` }]);
    } }),
    valid: (I, c) => rlCheck(I, c),
    val: (I, c) => rlEval(I, c).mem,
    hint: (I) => I.lv === 1 ? "A fixed window lets a client spend its whole limit just before the minute ends and again just after." : I.lv === 2 ? "Which algorithms can guarantee a hard cap in every rolling window while still allowing a burst equal to the limit?" : "A ZSET with hundreds of entries per client × millions of clients is a lot of memory. A token bucket's 60 s worst case is capacity + 60 s of refill.",
    concept: "Rate limiting algorithms in Redis",
    how: "Fixed window (INCR a per-minute key, EXPIRE it) is cheapest but allows up to 2× the limit across a window boundary. A sliding log (ZADD each request's timestamp, ZREMRANGEBYSCORE old ones, ZCARD) is exact but stores one entry per request. The sliding window counter weights the previous window's count by how much of it still overlaps: two integers, approximate. A token bucket (tokens and last-refill time in a hash, updated by a Lua script) allows bursts up to its capacity and sustains the refill rate; in any window of length T it admits at most capacity + rate × T. Do the read-modify-write in a Lua script (or a single atomic command) so concurrent requests can't race.",
    rule: "Default to a token bucket in Lua: it encodes 'average rate + allowed burst' directly. Use a sliding log only when you need an exact cap and the per-client limit is small.",
    why: (I, sol) => { const r = rlEval(I, sol); return `${({ fixed: "Fixed window", log: "Sliding log", counter: "Sliding window counter", tb: "Token bucket" })[sol.algo]} (limit ${sol.limit}/min${sol.algo === "tb" ? `, capacity ${sol.burst}` : ""}) passed at ${r.per} B per client (${human(r.mem)}); the attacker peaked at ${r.peak} per 60 s. ${I.lv === 1 ? "The fixed window let ~2× through at the boundary." : I.lv === 2 ? "Only the sliding log gives an exact rolling cap while allowing a burst of the whole limit; a token bucket that allows the burst also adds refill on top." : `A sliding log of ${sol.limit} entries per client would need ~${human((40 + 600 * 64) * I.users)}. The token bucket's capacity and refill had to be chosen so capacity + refill ≤ ${I.cap} per minute while still covering bursts of ${I.burst}.`}`; },
  });

  /* ================================================================
     TUNE: near cache (local TTL, invalidation, replicas)
     ================================================================ */
  function nearSim(I, c) {
    const nodes = 1 + c.replicas;
    const reads = c.ttl === 0 ? I.rps : Math.min(I.rps, I.inst / c.ttl);
    const inval = c.inval === "on" ? I.writes * I.inst : 0;
    const loadPrimary = reads / nodes + inval;
    const lagS = c.replicas ? 0.05 : 0;
    const typical = c.inval === "on" ? 0.01 + lagS : c.ttl / 2 + lagS;
    const worst = c.ttl === 0 ? lagS : c.ttl + lagS;
    return { reads, inval, loadPrimary, typical, worst, nodes };
  }
  const nearCheck = (I, c) => { const r = nearSim(I, c); if (r.loadPrimary > I.cap) return `the busiest Redis node serves ${K.num(r.loadPrimary)} ops/s for this key${r.inval ? ` (incl. ${K.num(r.inval)} invalidation pushes/s)` : ""}, limit ${K.num(I.cap)}`; if (r.typical > I.typ) return `typical staleness ${K.num(r.typical, 2)} s, target ${I.typ} s`; if (r.worst > I.worst) return `worst-case staleness ${K.num(r.worst, 2)} s, limit ${I.worst} s`; return true; };
  S.push({
    id: "redis-near-cache",
    name: "Tune the in-process near cache",
    kind: "Config change",
    skills: ["tune", "estimate"],
    w: "tune",
    sense: "min",
    vname: "Redis nodes",
    gen(lv, R) {
      const I = { lv, key: R.pick(["pricing:rules", "config:features", "catalog:menu"]) };
      if (lv === 1) Object.assign(I, { inst: R.pick([150, 200, 300]), rps: 120000, writes: 0.01, cap: 1000, typ: 5, worst: 10 });
      if (lv === 2) Object.assign(I, { inst: 800, rps: 300000, writes: 0.1, cap: 300, typ: 1, worst: 30 });
      if (lv === 3) Object.assign(I, { inst: 800, rps: 300000, writes: 20, cap: 300, typ: 1, worst: 2 });
      return I;
    },
    text: (I) => `<p>${K.num(I.inst)} app instances read <code>${esc(I.key)}</code> ${K.num(I.rps)} times/s in total; it changes ${I.writes >= 1 ? `${I.writes} times per second` : `about once every ${Math.round(1 / I.writes)} s`}. You're adding an in-process cache in front of Redis. Optionally enable invalidation push (Redis client-side caching / CLIENT TRACKING: Redis notifies each client that read a key when it changes) and add read replicas.</p><p>Keep each Redis node under <b>${K.num(I.cap)} ops/s</b> for this key, typical staleness ≤ <b>${I.typ} s</b>, worst case ≤ <b>${I.worst} s</b>, with as few Redis nodes as possible.</p>`,
    ui: (I) => ({ knobs: [
      { k: "ttl", label: "Local TTL", opts: [0, 0.5, 1, 2, 5, 10, 30], unit: "s", help: "0 = no local cache" },
      { k: "inval", label: "Invalidation push (tracking)", opts: ["off", "on"] },
      { k: "replicas", label: "Read replicas", opts: [0, 1, 2, 3] },
    ], live: (c) => { const r = nearSim(I, c); return K.metrics([{ name: "Redis reads/s", value: K.num(r.reads), ok: null }, { name: "Busiest node ops/s", value: K.num(r.loadPrimary), ok: r.loadPrimary <= I.cap, target: `≤ ${K.num(I.cap)}` }, { name: "Typical staleness", value: K.num(r.typical, 2) + " s", ok: r.typical <= I.typ, target: `≤ ${I.typ} s` }, { name: "Worst staleness", value: K.num(r.worst, 2) + " s", ok: r.worst <= I.worst, target: `≤ ${I.worst} s` }, { name: "Redis nodes", value: String(r.nodes), ok: null }]); } }),
    valid: (I, c) => nearCheck(I, c),
    val: (I, c) => nearSim(I, c).nodes,
    hint: (I) => I.lv === 1 ? "Each instance refetches once per local TTL: Redis load ≈ instances / TTL." : I.lv === 2 ? "With a TTL long enough to protect Redis, values are stale for seconds. What keeps the typical case fresh?" : "Invalidation push costs one message per change per instance that cached it. Count them.",
    concept: "Near caches: TTL, invalidation and fan-out",
    how: "A short-TTL in-process cache turns per-request reads into one Redis read per instance per TTL, which is what makes read-hot keys survivable. Staleness is bounded by the TTL. Redis client-side caching (CLIENT TRACKING, RESP3 push or a redirect connection) lets Redis tell each client to drop a key when it changes, so the typical case is fresh and the TTL becomes a safety net for lost notifications; but every change produces one message per tracking client, which explodes for frequently written keys. Read replicas divide read load at the cost of replication lag.",
    rule: "Local TTL bounds staleness and load; invalidation buys freshness for rarely-changing keys. For keys that change often, use a short TTL and spread reads (replicas) instead of pushing invalidations to every instance.",
    why: (I, sol) => { const r = nearSim(I, sol); return `TTL ${sol.ttl} s, invalidation ${sol.inval}, ${sol.replicas} replica(s): ${K.num(r.loadPrimary)} ops/s on the busiest node, typical staleness ${K.num(r.typical, 2)} s. ${I.lv === 1 ? "Even a sub-second local TTL cuts 120k reads/s to a few hundred." : I.lv === 2 ? "A TTL short enough for 1 s freshness would mean ≥ 800 reads/s; invalidation push keeps it fresh with a long TTL, for only ~80 messages/s." : `At ${I.writes} changes/s, invalidation would push ${K.num(I.writes * I.inst)} messages/s. A 1–2 s TTL with replicas sharing the ${K.num(I.inst / Math.max(0.5, sol.ttl))} refetches/s is the cheapest way to meet the 1 s target.`}`; },
  });

  /* ================================================================
     TUNE: negative caching and Bloom filters
     ================================================================ */
  function negSim(I, c) {
    const ttl = c.neg === "off" ? 0 : +c.neg;
    let fromRepeat = I.repeatRate;
    if (ttl > 0) fromRepeat = Math.min(I.repeatRate, I.repeatIds / ttl);
    let fromRandom = I.randomRate;
    const p = c.bloom === "off" ? 1 : +c.bloom;
    if (c.bloom !== "off") { fromRandom = I.randomRate * p; }
    const db = fromRepeat + fromRandom;
    const bits = c.bloom === "off" ? 0 : (-I.items * Math.log(p)) / (Math.LN2 * Math.LN2);
    const mem = bits / 8 + (ttl > 0 ? Math.min(I.repeatIds + I.randomRate * ttl, 1e9) * 80 : 0);
    let visible = ttl;
    if (c.bloom !== "off" && c.update === "nightly") visible = 86400;
    return { db, mem, visible, fromRepeat, fromRandom };
  }
  const negCheck = (I, c) => { const r = negSim(I, c); if (r.visible > I.vis) return r.visible >= 86400 ? "a product created after the nightly rebuild isn't in the filter: the filter says \"definitely absent\" and it's invisible until tomorrow" : `a newly created item stays invisible for up to ${r.visible} s (negative entry still cached), limit ${I.vis} s`; if (r.db > I.cap) return `the DB still gets ${K.num(r.db)} not-found queries/s (limit ${I.cap})`; if (r.mem > I.memBudget) return `${human(r.mem)} of memory (budget ${human(I.memBudget)})`; return true; };
  S.push({
    id: "redis-negative-cache",
    name: "Stop not-found lookups hitting the DB",
    kind: "Hardening",
    skills: ["design", "tune"],
    w: "tune",
    sense: "min",
    vname: "memory",
    vfmt: (v) => human(v),
    gen(lv, R) {
      const I = { lv, items: R.pick([20, 40, 60]) * 1000000, vis: lv === 3 ? 5 : 60 };
      if (lv === 1) Object.assign(I, { repeatIds: R.pick([1500, 2000]), repeatRate: 900, randomRate: 0, cap: 50, memBudget: 64 * MB });
      if (lv === 2) Object.assign(I, { repeatIds: 1500, repeatRate: 900, randomRate: R.pick([3000, 4000]), cap: 120, memBudget: 512 * MB });
      if (lv === 3) Object.assign(I, { repeatIds: 300, repeatRate: 400, randomRate: R.pick([20000, 30000]), cap: 120, memBudget: 512 * MB });
      return I;
    },
    text: (I) => `<p>Product lookups that miss Redis go to Postgres (${K.num(I.items)} products). ${I.lv === 1 ? `A crawler keeps requesting ~${K.num(I.repeatIds)} deleted product ids, ${K.num(I.repeatRate)} req/s in total; each is a cache miss and a DB query returning nothing.` : `Besides a crawler re-requesting ~${K.num(I.repeatIds)} deleted ids (${K.num(I.repeatRate)} req/s), a scraper enumerates <b>random ids</b> at ${K.num(I.randomRate)} req/s, each different.`}${I.lv === 3 ? " The team's Bloom filter (RedisBloom BF.*) is rebuilt from the DB every night." : ""}</p><p>Keep not-found DB queries ≤ <b>${I.cap}/s</b>; a newly created product must be visible within <b>${I.vis} s</b>; minimise memory.</p>`,
    ui: (I) => ({ knobs: [
      { k: "neg", label: "Negative cache TTL", opts: ["off", "5", "60", "600"], fmt: (v) => (v === "off" ? "off" : v + " s"), help: "cache \"not found\" markers" },
      { k: "bloom", label: "Bloom filter of existing ids", opts: ["off", "0.1", "0.01", "0.001"], fmt: (v) => (v === "off" ? "off" : "FP " + +v * 100 + "%") },
      ...(I.lv === 3 ? [{ k: "update", label: "Filter updates", opts: ["nightly", "on-create"], fmt: (v) => (v === "nightly" ? "nightly rebuild" : "BF.ADD on create + nightly rebuild") }] : []),
    ], init: I.lv === 3 ? { update: "nightly" } : {}, live: (c) => { const r = negSim(I, { update: "on-create", ...c }); return K.metrics([{ name: "DB not-found q/s", value: K.num(r.db), ok: r.db <= I.cap, target: `≤ ${I.cap}` }, { name: "New item visible in", value: r.visible >= 86400 ? "next day" : r.visible + " s", ok: r.visible <= I.vis, target: `≤ ${I.vis} s` }, { name: "Memory", value: human(r.mem), ok: r.mem <= I.memBudget, target: `≤ ${human(I.memBudget)}` }]) + K.bars([{ label: "repeat misses", value: r.fromRepeat, note: K.num(r.fromRepeat) + "/s" }, { label: "random ids", value: r.fromRandom, cls: "hot", note: K.num(r.fromRandom) + "/s" }]); } }),
    valid: (I, c) => negCheck(I, { update: "on-create", ...c }),
    val: (I, c) => Math.round(negSim(I, { update: "on-create", ...c }).mem),
    hint: (I) => I.lv === 1 ? "Repeated misses for the same ids are exactly what a short negative-cache entry absorbs. Mind the visibility requirement." : I.lv === 2 ? "Random ids are never repeated, so caching 'not found' for them doesn't help. What can answer 'definitely doesn't exist' without the DB?" : "A Bloom filter never gives false negatives, unless an id was never added to it.",
    concept: "Negative caching and Bloom filters",
    how: "Caching 'not found' for a short TTL absorbs repeated lookups of missing keys, but a new item with that id stays invisible until the marker expires, and it does nothing against requests for ever-different ids. A Bloom filter of all existing ids answers 'definitely absent' with no false negatives and a tunable false-positive rate p, using about −n·ln(p)/(ln 2)² bits: ~9.6 bits per item at 1%, ~14.4 at 0.1%. Only false positives reach the database. The filter must learn about every new id at creation time (BF.ADD in the create path), or new items look absent until the next rebuild.",
    rule: "Short negative TTLs for repeated misses; a Bloom filter (sized for the FP rate you can afford) for enumeration traffic; and add to the filter in the same code path that creates the item.",
    why: (I, sol) => { const r = negSim(I, { update: "on-create", ...sol }); return `Negative TTL ${sol.neg}, Bloom ${sol.bloom === "off" ? "off" : "FP " + +sol.bloom * 100 + "%"}${I.lv === 3 ? `, ${sol.update}` : ""}: ${K.num(r.db)} DB q/s, ${human(r.mem)}. ${I.lv === 1 ? `With ${K.num(I.repeatIds)} ids re-requested, a ${sol.neg} s marker means at most ${K.num(I.repeatIds / +sol.neg)} queries/s.` : I.lv === 2 ? `Random ids pass a Bloom filter only at its FP rate: ${K.num(I.randomRate)} × ${+sol.bloom * 100}% ≈ ${K.num(I.randomRate * +sol.bloom)}/s.` : `At ${K.num(I.randomRate)} random lookups/s only a 0.1% filter is tight enough, the 5 s visibility rule caps the negative TTL, and a nightly-only filter hides new products until the rebuild.`}`; },
  });

  /* ================================================================
     CODE: redis.conf for a role
     ================================================================ */
  function parseConf(src) {
    const cfg = {}, errs = [];
    String(src || "").split("\n").forEach((l, i) => {
      const t = l.replace(/#.*$/, "").trim(); if (!t) return;
      const m = t.match(/^([a-z][a-z0-9-]*)\s+(.+)$/i);
      if (!m) { errs.push(`line ${i + 1}: expected "directive value"`); return; }
      const k = m[1].toLowerCase(); let v = m[2].trim();
      if (k === "save") { cfg.save = cfg.save == null ? [] : cfg.save; if (/^""$|^''$/.test(v)) cfg.save = []; else cfg.save.push(v); return; }
      cfg[k] = v.replace(/^"(.*)"$/, "$1");
    });
    return { cfg, errs };
  }
  const memOf = (v) => {
    if (v == null) return null;
    const m = String(v).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb)?$/);
    if (!m) return null;
    return Math.round(+m[1] * { b: 1, k: 1e3, kb: 1024, m: 1e6, mb: MB, g: 1e9, gb: GB }[m[2] || "b"]);
  };
  function confCheck(I, src) {
    const { cfg, errs } = parseConf(src);
    if (errs.length) return { ok: false, rows: [], err: errs[0] };
    const rows = [];
    const req = (name, ok, msg) => rows.push({ name, ok, msg });
    const mm = memOf(cfg.maxmemory), pol = cfg["maxmemory-policy"] || "noeviction";
    const aof = (cfg.appendonly || "no").toLowerCase() === "yes", fs = (cfg.appendfsync || "everysec").toLowerCase();
    const save = cfg.save == null ? ["3600 1", "300 100", "60 10000"] : cfg.save;
    req("maxmemory", mm != null && mm > 0 && mm <= I.ram * GB * 0.75 && mm >= I.ram * GB * 0.4, `set maxmemory to 40–75% of the ${I.ram} GB host (got ${cfg.maxmemory || "unset = unlimited"})`);
    if (I.lv === 1) {
      req("eviction", /^allkeys-(lru|lfu)$/.test(pol), `a pure cache should evict any key under pressure (got ${pol})`);
      req("no RDB", save.length === 0, "a rebuildable cache doesn't need snapshots: set save \"\" (the default schedules three)");
      req("no AOF", !aof, "no AOF for a cache");
    } else if (I.lv === 2) {
      req("eviction", !/^allkeys/.test(pol), `allkeys-* would evict logged-in users' sessions (got ${pol})`);
      req("AOF", aof && (fs === "everysec" || fs === "always"), "sessions must survive a restart with ≤ 1 s of loss: appendonly yes with appendfsync everysec");
    } else {
      req("noeviction", pol === "noeviction", `a BullMQ queue must never lose keys to eviction; it requires noeviction (got ${pol})`);
      req("AOF", aof && fs === "everysec", "durable queue: appendonly yes, appendfsync everysec");
      const mr = +(cfg["min-replicas-to-write"] || 0), lag = +(cfg["min-replicas-max-lag"] || 10);
      req("min-replicas", mr >= 1 && lag <= 10, "stop accepting writes when no replica is in sync: min-replicas-to-write 1, min-replicas-max-lag ≤ 10");
      const cob = (cfg["client-output-buffer-limit"] || "");
      req("no unlimited buffers", !/pubsub\s+0\s+0\s+0/.test(cob), "don't disable the pubsub output-buffer limit");
    }
    return { ok: rows.every((r) => r.ok), rows };
  }
  S.push({
    id: "redis-conf-role",
    name: "Write the redis.conf for its role",
    kind: "Config change",
    skills: ["design", "safe"],
    w: "code",
    gen(lv, R) { return { lv, ram: R.pick([8, 16, 32]), name: lv === 1 ? "cache" : lv === 2 ? "sessions" : "jobs" }; },
    text: (I) => `<p>You're provisioning a dedicated Redis 7.2 node (${I.ram} GB RAM) for ${I.lv === 1 ? "<b>the product cache</b>: everything in it can be rebuilt from Postgres" : I.lv === 2 ? "<b>web sessions</b>: each has a 30-minute TTL; losing them logs users out, and they must survive a restart with at most ~1 s of loss" : "<b>BullMQ job queues</b> (payments webhooks): a job accepted must not vanish, including on failover to the one replica"}. Write the redis.conf directives that matter for this role. Anything you don't set keeps the default (<code>maxmemory 0</code>, <code>noeviction</code>, three <code>save</code> points, <code>appendonly no</code>).</p>`,
    ui: (I) => ({ lang: "conf", file: `redis-${I.name}.conf`, rows: 8, ph: "maxmemory 6gb\nmaxmemory-policy ...", starter: "# redis.conf\n", live: (src) => { const r = confCheck(I, src); if (r.err) return `<p class="lose small">${esc(r.err)}</p>`; return K.table(["requirement", ""], r.rows.map((x) => [esc(x.name), x.ok ? "✓" : `<span class="lose">${esc(x.msg)}</span>`]), { compact: true }); } }),
    accept: (I, src) => { const r = confCheck(I, src); if (r.err) return esc(r.err); const bad = r.rows.find((x) => !x.ok); return bad ? esc(bad.msg) : true; },
    solve: (I) => { const mm = Math.floor(I.ram * 0.6) + "gb"; return I.lv === 1 ? `maxmemory ${mm}\nmaxmemory-policy allkeys-lfu\nsave ""\nappendonly no` : I.lv === 2 ? `maxmemory ${mm}\nmaxmemory-policy volatile-lru\nappendonly yes\nappendfsync everysec` : `maxmemory ${mm}\nmaxmemory-policy noeviction\nappendonly yes\nappendfsync everysec\nmin-replicas-to-write 1\nmin-replicas-max-lag 10`; },
    bad: (I) => { const mm = Math.floor(I.ram * 0.6) + "gb"; return I.lv === 1 ? [`maxmemory ${mm}\nmaxmemory-policy allkeys-lru`, `maxmemory-policy allkeys-lru\nsave ""`] : I.lv === 2 ? [`maxmemory ${mm}\nmaxmemory-policy allkeys-lru\nappendonly yes`, `maxmemory ${mm}\nmaxmemory-policy volatile-lru\nsave 60 1000`] : [`maxmemory ${mm}\nmaxmemory-policy volatile-lru\nappendonly yes\nmin-replicas-to-write 1`, `maxmemory ${mm}\nmaxmemory-policy noeviction\nappendonly yes\nappendfsync everysec`]; },
    hint: (I) => I.lv === 1 ? "Three defaults hurt a pure cache: unlimited memory, noeviction and the default save schedule." : I.lv === 2 ? "Which policies evict only keys with a TTL? And how do you get ~1 s durability?" : "Queues can't be evicted, and with async replication an acknowledged job can still be lost on failover unless...",
    concept: "Configuring Redis for its role",
    how: "Defaults are a compromise: no memory limit, noeviction, RDB snapshots at three thresholds, no AOF. A cache wants a maxmemory well under RAM (leave room for fragmentation and fork copy-on-write), an allkeys-lru/lfu policy and no persistence. A session store must survive restarts (AOF everysec) and must not evict live sessions in bulk (volatile-* or noeviction plus monitoring). A queue must never lose keys: noeviction (BullMQ refuses other policies), AOF, and min-replicas-to-write so a primary cut off from its replica stops accepting jobs it could lose in a failover.",
    rule: "Give every Redis a single role and configure for it: memory limit + eviction policy + persistence + replication safety. Don't share a cache instance with data you can't lose.",
    why: (I, sol) => `For a ${I.ram} GB ${I.name} node: <code>${esc(sol.split("\n").join(" · "))}</code>. ${I.lv === 1 ? "Without save \"\" the node forks for snapshots it never needs." : I.lv === 2 ? "volatile-lru only evicts keys with a TTL, and AOF everysec bounds a crash to ~1 s." : "min-replicas-to-write makes the primary refuse writes when its replica is gone, so an accepted job is on two nodes (barring the last ~lag seconds)."}`,
  });

  /* ================================================================
     CODE: versioned cache keys across deploys
     ================================================================ */
  const VK_TOK = ["id", "locale", "currency", "tier", "user", "schema", "sha"];
  function vkCheck(I, src) {
    const t = String(src || "").trim();
    if (!t) return { err: "Write a key template." };
    if (/\s/.test(t)) return { err: "Key templates can't contain spaces." };
    const toks = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const unk = toks.find((x) => !VK_TOK.includes(x)); if (unk) return { err: `Unknown placeholder {${esc(unk)}}. Available: ${VK_TOK.map((x) => "{" + x + "}").join(" ")}` };
    const has = (x) => toks.includes(x);
    const r = { has: Object.fromEntries(VK_TOK.map((x) => [x, has(x)])), problems: [] };
    if (!has("id")) r.problems.push(["Wrong product served", "the key doesn't include {id}: every product shares one entry"]);
    if (!has("schema")) r.problems.push(["Decode errors in rolling deploy", `old and new pods share keys while the payload format changes (v${I.schema - 1} → v${I.schema}): old pods crash on new entries and vice versa`]);
    if (has("sha")) r.problems.push(["Cache wiped every deploy", `${I.deploys} deploys/day: each one starts from an empty cache and the DB takes the full load until it warms up`]);
    if (I.lv >= 2 && (!has("locale") || !has("currency"))) r.problems.push(["Wrong language/currency", "responses differ by locale and currency; without both in the key, a German shopper can get a cached English/USD page"]);
    if (has("user")) r.problems.push(["Hit ratio collapses", "per-user keys: millions of copies of the same page, almost every request misses"]);
    if (I.lv === 3 && !has("tier")) r.problems.push(["Price leak", "prices differ by loyalty tier: a basic customer could be served a gold customer's cached prices"]);
    const variants = (has("id") ? 1 : 0) * (has("locale") ? 12 : 1) * (has("currency") ? 4 : 1) * (has("tier") ? 3 : 1) * (has("user") ? 1e6 : 1);
    r.variants = variants;
    return r;
  }
  S.push({
    id: "redis-versioned-keys",
    name: "Version the cache keys",
    kind: "Code review",
    skills: ["design", "safe"],
    w: "code",
    gen(lv, R) { return { lv, schema: R.int(3, 9), deploys: R.int(12, 30), svc: R.pick(["product-page", "catalog-api", "pricing"]) }; },
    text: (I) => `<p>The ${esc(I.svc)} service caches rendered product JSON in Redis. The next release changes the payload format (schema v${I.schema - 1} → v${I.schema}), and deploys are rolling, so old and new pods run side by side for ~10 minutes. The team ships ~${I.deploys} times a day. ${I.lv === 1 ? "The response depends only on the product." : I.lv === 2 ? "Responses vary by <b>locale</b> (12) and <b>currency</b> (4)." : "Responses vary by locale and currency, and logged-in shoppers see prices for their <b>loyalty tier</b> (basic/silver/gold)."}</p><p>Write the key template. Placeholders: ${VK_TOK.map((x) => `<code>{${x}}</code>`).join(" ")} (<code>schema</code> = payload format version, <code>sha</code> = git commit of the build).</p>`,
    ui: (I) => ({ lang: "text", rows: 2, file: "cache_key_template", starter: "product:{id}", live: (src) => { const r = vkCheck(I, src); if (r.err) return `<p class="lose small">${r.err}</p>`; return (r.problems.length ? K.table(["simulated problem", "why"], r.problems.map(([a, b]) => [`<b class="lose">${esc(a)}</b>`, esc(b)]), { compact: true }) : K.verdict(true, "rolling deploy, cache hit ratio and correctness all fine")) + `<p class="muted small">Variants per product: ${K.num(r.variants)}</p>`; } }),
    accept: (I, src) => { const r = vkCheck(I, src); if (r.err) return r.err; return r.problems.length ? `<b>${esc(r.problems[0][0])}</b>: ${esc(r.problems[0][1])}.` : true; },
    solve: (I) => I.lv === 1 ? "product:v{schema}:{id}" : I.lv === 2 ? "product:v{schema}:{id}:{locale}:{currency}" : "product:v{schema}:{id}:{locale}:{currency}:{tier}",
    bad: (I) => I.lv === 1 ? ["product:{id}", "product:{sha}:{id}"] : I.lv === 2 ? ["product:v{schema}:{id}", "product:v{schema}:{id}:{user}"] : ["product:v{schema}:{id}:{locale}:{currency}", "product:v{schema}:{id}:{locale}:{currency}:{user}"],
    hint: (I) => I.lv === 1 ? "Old and new code must not read each other's entries, but a deploy that doesn't change the format shouldn't empty the cache." : I.lv === 2 ? "Everything that changes the response must be in the key; nothing else." : "Per-user keys are correct but useless. What's the coarsest thing that determines the price?",
    concept: "Cache key design: versioning and cardinality",
    how: "A cache key must contain every input that changes the cached value, and nothing that doesn't. During a rolling deploy old and new code share the cache, so a payload format change needs a version in the key (a schema version, bumped only when the format changes); keying by build SHA is safe but empties the cache on every deploy, shifting full load to the database. Personalisation belongs in the key only at the granularity it actually varies (tier, segment), never per user unless the value truly is per user.",
    rule: "Key = namespace + payload version + every dimension the response varies on, at the coarsest granularity that is correct. Bump the version when the format changes, not on every deploy.",
    why: (I, sol) => `<code>${esc(sol)}</code> isolates v${I.schema - 1} and v${I.schema} payloads during the rolling deploy, survives the other ~${I.deploys - 1} deploys a day with a warm cache${I.lv >= 2 ? ", and varies exactly by what the response depends on" : ""}${I.lv === 3 ? " (3 tiers, not millions of users)" : ""}.`,
  });

  /* ================================================================
     CODE: leaderboard scores (doubles!)
     ================================================================ */
  const LBV = ["points", "ts", "season_start", "user_id", "pad"];
  function lbCompile(src) {
    const lines = String(src || "").split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean);
    const out = {};
    for (const l of lines) {
      const m = l.match(/^(score|member)\s*=\s*(.+)$/); if (!m) return { err: `Can't read <code>${esc(l)}</code>: write <code>score = ...</code> and <code>member = ...</code>.` };
      const ex = m[2];
      if (!/^[\w\s+\-*/%().,:'"]*$/.test(ex)) return { err: `Only arithmetic, string literals, + and the names ${LBV.join(", ")} are allowed.` };
      const ids = (ex.replace(/'[^']*'|"[^"]*"/g, "").match(/[A-Za-z_]\w*/g) || []).filter((x) => !/^\d/.test(x));
      const badId = ids.find((x) => !LBV.includes(x) && !/^e\d*$/.test(x)); if (badId) return { err: `Unknown name <code>${esc(badId)}</code>. Allowed: ${LBV.join(", ")}.` };
      try { out[m[1]] = new Function("points", "ts", "season_start", "user_id", "pad", `"use strict"; return (${ex});`); } catch (e) { return { err: "Syntax error: " + esc(e.message) }; }
    }
    if (!out.score) return { err: "Define <code>score = ...</code>." };
    if (!out.member) out.member = (p, t, s, u) => u;
    return out;
  }
  function lbCase(I) {
    const R = RNG(I.seed), rows = [];
    const maxP = I.maxPoints, s0 = 1767225600, unit = I.ms ? 1000 : 1;
    const t = (sec) => (s0 + sec) * unit + (I.ms ? Math.floor(R.next() * 1000) : 0);
    for (let i = 0; i < 24; i++) rows.push({ u: "u" + String(100000 + i * 7), p: Math.floor(R.next() * maxP), ts: t(Math.floor(R.next() * 80 * 86400)) });
    // ties: same points, different time
    const top = maxP - 1;
    const tb = t(86400 * 3);
    rows.push({ u: "u100001", p: top, ts: tb }, { u: "u900002", p: top, ts: tb + 1 }, { u: "u500000", p: top, ts: t(86400 * 50) });
    rows.push({ u: "u700000", p: 5, ts: t(100) }, { u: "u100009", p: 5, ts: t(101) });
    return { rows, s0: s0 * unit };
  }
  function lbRank(I, src) {
    const f = lbCompile(src); if (f.err) return f;
    const { rows, s0 } = lbCase(I);
    const pad = (x, n) => String(Math.max(0, Math.floor(x))).padStart(n, "0");
    let ent;
    try { ent = rows.map((r) => ({ r, score: Number(f.score(r.p, r.ts, s0, r.u, pad)), member: String(f.member(r.p, r.ts, s0, r.u, pad)) })); } catch (e) { return { err: "Evaluation error: " + esc(e.message) }; }
    if (ent.some((e) => !Number.isFinite(e.score))) return { err: "Some score isn't a finite number." };
    if (new Set(ent.map((e) => e.member)).size < ent.length) return { err: "Two users map to the same member: ZADD would overwrite one with the other. Include user_id in the member." };
    // ZREVRANGE order: score desc, then member desc (byte order)
    const got = ent.slice().sort((a, b) => b.score - a.score || (a.member < b.member ? 1 : a.member > b.member ? -1 : 0));
    const want = rows.slice().sort((a, b) => b.p - a.p || a.ts - b.ts);
    const wrong = [];
    for (let i = 0; i < want.length; i++) if (got[i].r !== want[i]) wrong.push(i);
    const lost = ent.find((e) => e.score > 9007199254740992);
    return { got, want, wrong, lost };
  }
  S.push({
    id: "redis-leaderboard-score",
    name: "Encode ties in a leaderboard",
    kind: "Code review",
    skills: ["design"],
    w: "code",
    gen(lv, R) { return { lv, seed: `lb/${lv}/${R.int(1, 1e9)}`, maxPoints: lv === 1 ? 10000 : lv === 2 ? 2000000 : 100000000, ms: lv === 3, game: R.pick(["Word Sprint", "Puzzle Rush", "Trivia Duel"]) }; },
    text: (I) => `<p>${esc(I.game)}'s season leaderboard is a sorted set read with <code>ZREVRANGE lb 0 99 WITHSCORES</code>. Rank by points (up to ${K.num(I.maxPoints)}); on equal points, whoever reached the score <b>first</b> ranks higher. <code>ts</code> is the Unix time in ${I.ms ? "<b>milliseconds</b>" : "seconds"} of the user's last score change; <code>season_start</code> is the season's start in the same unit (seasons last 90 days).</p><p>Write <code>score = …</code> (and optionally <code>member = …</code>, default <code>user_id</code>). Scores are IEEE-754 doubles (exact integers only up to 2<sup>53</sup> ≈ 9.007e15); equal scores are ordered by member, byte-wise, descending in ZREVRANGE. Helper: <code>pad(x, n)</code> zero-pads an integer.</p>`,
    ui: (I) => ({ lang: "js", rows: 4, file: "leaderboard.expr", starter: "score = points", live: (src) => {
      const r = lbRank(I, src); if (r.err) return `<p class="lose small">${r.err}</p>`;
      const show = r.got.slice(0, 6);
      return K.table(["#", "member", "score", "points", "ts"], show.map((e, i) => [String(i + 1), `<span class="mono">${esc(e.member)}</span>`, `<span class="mono">${esc(String(e.score))}</span>`, K.num(e.r.p), `<span class="${r.wrong.includes(i) ? "lose" : ""}">${e.r.ts}</span>`]), { compact: true }) + K.metrics([{ name: "Positions wrong (of 29)", value: String(r.wrong.length), ok: !r.wrong.length }, { name: "Max score", value: Math.max(...r.got.map((e) => e.score)).toExponential(3), ok: !r.lost, target: "≤ 9.007e15" }]);
    } }),
    accept: (I, src) => { const r = lbRank(I, src); if (r.err) return r.err; if (r.wrong.length) return `${r.wrong.length} of 29 users are in the wrong position${r.lost ? ": some scores exceed 2^53, so the low digits (your tie-break) are rounded away" : ". Check how ties on points are ordered"}.`; return true; },
    solve: (I) => I.lv === 1 ? "score = points * 1e10 + (9999999999 - ts)" : I.lv === 2 ? "score = points * 1e7 + (9999999 - (ts - season_start))" : "score = points\nmember = pad(99999999999 - (ts - season_start), 11) + ':' + user_id",
    bad: (I) => I.lv === 1 ? ["score = points", "score = points * 1e10 + ts"] : I.lv === 2 ? ["score = points * 1e10 + (9999999999 - ts)", "score = points + 1 / ts"] : ["score = points * 1e10 + (9999999999 - (ts - season_start))", "score = points\nmember = pad(ts - season_start, 11) + ':' + user_id"],
    hint: (I) => I.lv === 1 ? "Combine both into one number: points in the high digits, something that is larger for earlier times in the low digits." : I.lv === 2 ? "points × 10^10 with points up to 2 million is ~2e16, above 2^53. Make the time part smaller: time since season start." : "With millisecond resolution and points up to 1e8, points × (season length in ms) doesn't fit in 53 bits at all. What does Redis use to order members with equal scores?",
    concept: "Sorted-set scores are doubles; ties order by member",
    how: "Sorted sets order by a 64-bit floating point score, then by member (byte-wise) for equal scores; ZREVRANGE reverses both. A composite score (primary × 10^k + secondary) works only while the result stays below 2^53, after which doubles can't represent every integer and the low digits, which hold your tie-break, get rounded. Shrink the secondary (time since season start instead of since 1970) or, when it still doesn't fit, keep the score as the primary key and encode the tie-break into a fixed-width member prefix, since equal scores are ordered by member.",
    rule: "Check the magnitude of composite scores against 2^53 ≈ 9.007e15 before you ship. If both parts don't fit, move the tie-break into a zero-padded member.",
    why: (I, sol) => I.lv === 1 ? `points ≤ 10,000 × 1e10 ≈ 1e14 fits comfortably below 2^53, and (9999999999 − ts) is larger for earlier times, so earlier achievers sort first in ZREVRANGE.` : I.lv === 2 ? `2,000,000 × 1e10 = 2e16 exceeds 2^53, rounding away the time digits. Seconds since season start (< 7.8 M for 90 days) needs only 1e7: max score ≈ 2e13.` : `1e8 points × 7.8e9 ms per season ≈ 7.8e17 can't be exact in a double. Keeping score = points and using a zero-padded inverted time as the member prefix makes equal scores order by time, then user.`,
  });

  /* ================================================================
     INTERLEAVE: cache-aside invalidation race
     ================================================================ */
  function invLanes(I) {
    const v0 = I.v0, v1 = I.v1;
    const reader = I.lv === 3 ? {
      name: "Reader (GET /product)", steps: ["GET cache → miss?", "SELECT price FROM replica", "SET cache <price> EX 3600"],
      ops: [(s) => { s.rHit = s.cache != null; return s.rHit ? `hit: ${s.cache}` : "miss"; }, (s) => { if (s.rHit) return "skipped (hit)"; s.rv = s.dbR; return `replica returns ${s.dbR}`; }, (s) => { if (s.rHit) return "skipped (hit)"; s.cache = s.rv; return s.rv !== s.dbP ? `cache = ${s.rv} (stale!)` : `cache = ${s.rv}`; }],
    } : {
      name: "Reader (GET /product)", steps: ["GET cache → miss?", "SELECT price FROM db", "SET cache <price> EX 3600"],
      ops: [(s) => { s.rHit = s.cache != null; return s.rHit ? `hit: ${s.cache}` : "miss"; }, (s) => { if (s.rHit) return "skipped (hit)"; s.rv = s.dbP; return `db returns ${s.dbP}`; }, (s) => { if (s.rHit) return "skipped (hit)"; s.cache = s.rv; return s.rv !== s.dbP ? `cache = ${s.rv} (stale!)` : `cache = ${s.rv}`; }],
    };
    const upd = (s) => { s.dbP = v1; return `db price = ${v1}`; }, del = (s) => { s.cache = null; return "cache deleted"; };
    const writer = I.lv === 2 ? { name: "Writer (price update)", steps: ["DEL cache", `UPDATE price = ${v1}; COMMIT`], ops: [del, upd] }
      : { name: "Writer (price update)", steps: [`UPDATE price = ${v1}; COMMIT`, "DEL cache"], ops: [upd, del] };
    const lanes = [reader, writer];
    if (I.lv === 3) lanes.push({ name: "Replication", steps: ["replica applies the update"], ops: [(s) => { s.dbR = s.dbP; return `replica price = ${s.dbP}`; }] });
    return { lanes, init: { dbP: v0, dbR: v0, cache: I.lv === 1 ? null : null } };
  }
  const invBroken = (r) => r.st.cache != null && r.st.cache !== r.st.dbP;
  S.push({
    id: "redis-invalidation-race",
    name: "Find the stale-cache race",
    kind: "Investigation",
    skills: ["diagnose", "design"],
    w: "interleave",
    gen(lv, R) { const v0 = R.int(20, 90) * 10 - 1; return { lv, v0, v1: v0 + R.int(1, 9) * 10 }; },
    text: (I) => `<p>The catalog uses cache-aside with a 1-hour TTL: readers fill the cache on a miss; the price-update job ${I.lv === 2 ? "<b>deletes the cache key first</b>, then updates the database" : "updates the database, then deletes the cache key"}.${I.lv === 3 ? " Readers query a <b>Postgres read replica</b> (asynchronous, usually a few ms behind)." : ""} The cache starts empty, price ${I.v0}. Support reports products stuck at an old price for an hour.</p><p>Find a schedule that ends with the cache holding a price different from the database, with no TTL to save you.</p>`,
    ui: (I) => { const L = invLanes(I); return { lanes: L.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = runLanes(L.lanes, L.init, seq || []); return laneHTML(L.lanes, r) + (r.complete ? K.verdict(invBroken(r), invBroken(r) ? `cache ${r.st.cache}, database ${r.st.dbP}: stale for up to an hour` : `consistent (cache ${r.st.cache == null ? "empty" : r.st.cache}, db ${r.st.dbP})`) : ""); } }; },
    accept: (I, seq) => { const L = invLanes(I); const r = runLanes(L.lanes, L.init, seq); return invBroken(r) ? true : `Consistent: cache ${r.st.cache == null ? "empty" : r.st.cache}, database ${r.st.dbP}. Try another interleaving.`; },
    solve: (I) => { const L = invLanes(I); for (const s of interleave(L.lanes.map((l) => l.steps.length))) if (invBroken(runLanes(L.lanes, L.init, s))) return s; return null; },
    bad: (I) => { const L = invLanes(I); return [sequential(L.lanes), I.lv === 3 ? [1, 1, 2, 0, 0, 0] : [1, 1, 0, 0, 0]]; },
    hint: (I) => I.lv === 1 ? "Let the reader fetch from the database before the update, and write to the cache after the delete." : I.lv === 2 ? "Deleting first leaves a window before the database changes. Who can refill the cache in it?" : "The writer does everything right in order. But where does the reader read from, and when does that copy change?",
    concept: "Cache-aside invalidation races",
    how: "In cache-aside the reader's read-from-DB and write-to-cache are two separate steps. If the writer updates the database and deletes the key between them, the reader then writes the old value it already fetched, and it stays until the TTL expires. Deleting before updating opens an even wider window. Reading from an async replica adds another: the reader can fetch the old value from the replica after the primary changed and the key was deleted. Mitigations: short TTLs as a bound, delete again after a delay (delayed double delete), version-checked writes (SET only if the cached version is older, via Lua), or invalidation from the database's change stream (CDC) after replication.",
    rule: "Assume cache-aside can cache stale data: keep a TTL that bounds the damage, fill caches from the primary or check versions, and invalidate from CDC when staleness matters.",
    why: (I) => I.lv === 1 ? `The reader fetched ${I.v0}, the writer committed ${I.v1} and deleted the key, then the reader's SET put ${I.v0} back for an hour.` : I.lv === 2 ? `With delete-first, a reader that misses right after the DEL reads the still-old ${I.v0} from the database and caches it; the UPDATE lands after.` : `The writer updated the primary to ${I.v1} and deleted the key, but the reader's miss went to a replica that hadn't applied the change yet, and cached ${I.v0}.`,
  });

  /* ================================================================
     INTERLEAVE: distributed locks
     ================================================================ */
  function lockLanes(I) {
    if (I.lv === 3) {
      const acq = (me, n) => (s) => { if (s.nodes[n] === null) { s.nodes[n] = me; s.got[me] = (s.got[me] || 0) + 1; return `node ${n + 1}: OK (${s.got[me]}/3)`; } return `node ${n + 1}: held by ${s.nodes[n]}`; };
      const write = (me) => (s) => { if ((s.got[me] || 0) >= 2) { s.writers.push(me); return s.writers.length > 1 ? `${me} writes (believes it holds a majority): two holders!` : `${me} writes (majority)`; } return `${me} has no majority: gives up`; };
      return { lanes: [
        { name: "Client A", steps: ["SET lock A NX PX 30000 on node 1", "SET lock A NX PX 30000 on node 2", "majority? → write to storage"], ops: [acq("A", 0), acq("A", 1), write("A")] },
        { name: "Client B", steps: ["SET lock B NX PX 30000 on node 2", "SET lock B NX PX 30000 on node 3", "majority? → write to storage"], ops: [acq("B", 1), acq("B", 2), write("B")] },
        { name: "Node 2", steps: ["crashes and restarts (appendonly no)"], ops: [(s) => { if (s.nodes[1]) { s.got[s.nodes[1]]--; } s.nodes[1] = null; return "lock key gone after restart"; }] },
      ], init: { nodes: [null, null, null], got: {}, writers: [] } };
    }
    const acq = (me) => (s) => { if (s.holder == null) { s.holder = me; s.has[me] = true; return `${me} acquires (token ${++s.tok})`; } s.has[me] = false; return `held by ${s.holder}: ${me} waits`; };
    const write = (me) => (s) => { if (!s.has[me]) return `${me} never acquired: skips`; s.writers.push(me); const bad = s.holder !== me; if (bad) s.bad = true; return bad ? `${me} writes, but the lock is ${s.holder ? "held by " + s.holder : "free"}: corrupt!` : `${me} writes (holds lock)`; };
    const rel = (me) => (s) => { if (!s.has[me]) return "nothing to release"; if (I.lv === 2) { const was = s.holder; s.holder = null; return was !== me ? `DEL lock: deleted ${was || "nothing"}'s lock!` : "DEL lock"; } if (s.holder === me) { s.holder = null; return "released (owner check ok)"; } return "not owner: no-op"; };
    const expire = (s) => { const was = s.holder; s.holder = null; return was ? `lock of ${was} expired (PX elapsed)` : "nothing to expire"; };
    const lanes = [
      { name: "Worker A", steps: ["SET lock A NX PX 10000", I.lv === 1 ? "… 14 s stop-the-world GC pause …" : "process (slow)", "write to storage", I.lv === 2 ? "DEL lock" : "release (Lua: delete if value = A)"], ops: [acq("A"), () => "", write("A"), rel("A")] },
      { name: "Worker B", steps: ["SET lock B NX PX 10000", "write to storage", I.lv === 2 ? "DEL lock" : "release (Lua: delete if value = B)"], ops: [acq("B"), write("B"), rel("B")] },
      { name: "Redis TTL", steps: ["lock key expires"], ops: [expire] },
    ];
    if (I.lv === 2) lanes.push({ name: "Worker C", steps: ["SET lock C NX PX 10000", "write to storage"], ops: [acq("C"), write("C")] });
    return { lanes, init: { holder: null, has: {}, tok: 33, writers: [], bad: false } };
  }
  const lockBroken = (I, r) => (I.lv === 3 ? r.st.writers.length > 1 : r.st.bad);
  S.push({
    id: "redis-lock-expiry",
    name: "Break the Redis lock",
    kind: "Investigation",
    skills: ["design", "diagnose"],
    w: "interleave",
    gen(lv, R) { return { lv, job: R.pick(["invoice generation", "nightly payout", "inventory sync"]), n: R.int(2, 9) }; },
    text: (I) => I.lv === 3 ? `<p>To make ${esc(I.job)} "safe", the team switched to Redlock over 3 independent Redis nodes: a client that sets the lock on a majority (2 of 3) proceeds. The nodes run without AOF to keep latency low.</p><p>Find a schedule where <b>both</b> clients believe they hold the lock and write.</p>`
      : `<p>${esc(I.job)} runs on several workers and uses a Redis lock so only one writes at a time: <code>SET lock &lt;me&gt; NX PX 10000</code>${I.lv === 2 ? ", released with a plain <code>DEL lock</code>" : ", released with a compare-and-delete Lua script"}.${I.lv === 1 ? " Worker A runs on a JVM that occasionally pauses for GC." : ""}</p><p>Find a schedule where a worker writes to storage while it <b>doesn't</b> hold the lock.</p>`,
    ui: (I) => { const L = lockLanes(I); return { lanes: L.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = runLanes(L.lanes, L.init, seq || []); return laneHTML(L.lanes, r) + (r.complete ? K.verdict(lockBroken(I, r), lockBroken(I, r) ? "mutual exclusion violated" : "no overlap in this schedule") : ""); } }; },
    accept: (I, seq) => { const L = lockLanes(I); const r = runLanes(L.lanes, L.init, seq); return lockBroken(I, r) ? true : "Mutual exclusion held in that schedule. Let time pass (expiry, crash) at the worst moment."; },
    solve: (I) => { const L = lockLanes(I); for (const s of interleave(L.lanes.map((l) => l.steps.length))) if (lockBroken(I, runLanes(L.lanes, L.init, s))) return s; return null; },
    bad: (I) => { const L = lockLanes(I); return [sequential(L.lanes)]; },
    hint: (I) => I.lv === 1 ? "A lock with a TTL can expire while its owner is paused. The owner doesn't notice." : I.lv === 2 ? "If A's lock expires and B takes it, what does A's DEL delete?" : "What does node 2 remember about a lock after a restart without persistence?",
    concept: "Distributed locks: expiry, ownership and fencing",
    how: "SET key value NX PX ttl is the right primitive: atomic acquire with an expiry so a crashed holder can't block forever. But the expiry also means a holder that pauses (GC, swap, a slow network call) longer than the TTL loses the lock without knowing, and another worker acquires it. Releasing with a plain DEL can delete somebody else's lock, so release with a Lua compare-and-delete on a unique value. Redlock adds majority voting across nodes but still relies on timing and on nodes not forgetting locks (a restart without fsync loses them). For correctness, the storage must reject stale holders: issue a monotonically increasing fencing token with each lock and have the storage refuse writes with an older token.",
    rule: "Use Redis locks for efficiency (avoiding duplicate work). If a double write would corrupt data, enforce it at the storage with fencing tokens or a transaction/constraint there.",
    why: (I) => I.lv === 1 ? "A acquired, paused past its 10 s TTL, the key expired, B acquired and wrote, then A woke and wrote too, believing it still held the lock." : I.lv === 2 ? "After A's lock expired and B acquired, A's unconditional DEL removed B's lock, so C acquired while B was still working: two writers." : "A got nodes 1–2; node 2 restarted and forgot the key; B then got nodes 2–3. Both had a majority. Redlock's safety assumes nodes don't lose acknowledged locks and clocks behave; a fencing token at the storage doesn't.",
  });

  /* ================================================================
     INTERLEAVE: MULTI/WATCH oversell
     ================================================================ */
  function txLanes(I) {
    const mk = (me) => {
      const steps = [], ops = [];
      const watch = (s) => { s.w[me] = s.ver; return `WATCH stock (version ${s.ver})`; };
      const get = (s) => { s.r[me] = s.stock; return `stock = ${s.stock}`; };
      const check = (s) => { if (s.r[me] <= 0) { s.ab[me] = true; return "sold out: abort"; } return "> 0: proceed"; };
      const multi = (s) => (s.ab[me] ? "skipped" : "MULTI");
      const decr = (s) => (s.ab[me] ? "skipped" : "DECR stock → QUEUED");
      const exec = (s) => { if (s.ab[me]) return "skipped"; if (s.w[me] != null && s.w[me] !== s.ver) { s.nil[me] = true; return "EXEC → (nil): aborted, key changed"; } s.stock--; s.ver++; return `EXEC → stock = ${s.stock}`; };
      const confirm = (s) => { if (s.ab[me]) return "skipped"; if (s.nil[me] && I.lv !== 3) return "nil reply: retry later"; s.conf++; return s.conf > I.stock0 ? `order confirmed (${s.conf} confirmed, ${I.stock0} in stock): oversold!` : `order confirmed (${s.conf})`; };
      if (I.lv === 1) { steps.push("GET stock", "if stock > 0:", "MULTI", "DECR stock", "EXEC", "confirm order"); ops.push(get, check, multi, decr, exec, confirm); }
      else if (I.lv === 2) { steps.push("GET stock", "if stock > 0:", "WATCH stock", "MULTI", "DECR stock", "EXEC", "confirm order if EXEC succeeded"); ops.push(get, check, watch, multi, decr, exec, confirm); }
      else { steps.push("WATCH stock", "GET stock", "if stock > 0:", "MULTI", "DECR stock", "EXEC", "confirm order  # code: `if result is not False`"); ops.push(watch, get, check, multi, decr, exec, confirm); }
      return { name: `Buyer ${me}`, steps, ops };
    };
    return { lanes: [mk("A"), mk("B")], init: { stock: I.stock0, ver: 0, w: {}, r: {}, ab: {}, nil: {}, conf: 0 } };
  }
  const txBroken = (I, r) => r.st.conf > I.stock0;
  S.push({
    id: "redis-watch-multi",
    name: "Oversell through MULTI/EXEC",
    kind: "Code review",
    skills: ["diagnose", "design"],
    w: "interleave",
    gen(lv, R) { return { lv, stock0: 1, item: R.pick(["concert ticket", "limited sneaker", "GPU"]) }; },
    text: (I) => `<p>The last <b>${esc(I.item)}</b> (stock = ${I.stock0}) is being bought by two people at once. The checkout code ${I.lv === 1 ? "reads the stock, checks it, then decrements it inside <code>MULTI</code>/<code>EXEC</code> \"so it's atomic\"" : I.lv === 2 ? "uses optimistic locking: it reads the stock, then <code>WATCH</code>es it, then decrements in <code>MULTI</code>/<code>EXEC</code>" : "uses <code>WATCH</code> before reading, then <code>MULTI</code>/<code>EXEC</code>. The client library returns <code>None</code> when EXEC is aborted; the confirm step checks <code>result is not False</code>"}.</p><p>Find a schedule where more orders are confirmed than there was stock.</p>`,
    ui: (I) => { const L = txLanes(I); return { lanes: L.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = runLanes(L.lanes, L.init, seq || []); return laneHTML(L.lanes, r) + (r.complete ? K.verdict(txBroken(I, r), `${r.st.conf} order(s) confirmed, stock ${r.st.stock}`) : ""); } }; },
    accept: (I, seq) => { const L = txLanes(I); const r = runLanes(L.lanes, L.init, seq); return txBroken(I, r) ? true : `${r.st.conf} order(s) confirmed for ${I.stock0} item: no oversell in that schedule.`; },
    solve: (I) => { const L = txLanes(I); for (const s of interleave(L.lanes.map((l) => l.steps.length))) if (txBroken(I, runLanes(L.lanes, L.init, s))) return s; return null; },
    bad: (I) => { const L = txLanes(I); return [sequential(L.lanes)]; },
    hint: (I) => I.lv === 1 ? "MULTI makes the queued commands run together. Is the GET inside it?" : I.lv === 2 ? "WATCH only notices changes made after the WATCH." : "What does the confirm step do when EXEC returns nil?",
    concept: "MULTI/EXEC, WATCH and Lua atomicity",
    how: "MULTI/EXEC queues commands and runs them back-to-back, but you can't read a value and decide inside the transaction: reads before MULTI see a moment that may be gone by EXEC. WATCH adds optimistic locking: if a watched key changes after the WATCH, EXEC returns nil and nothing runs, so the WATCH must come before the read, and the nil reply must be handled as a failure (retry). A Lua script (or a single command like DECR with a check, or a function) runs atomically with logic inside, which is usually simpler: read, check and decrement in one script.",
    rule: "For check-then-act, use a Lua script; if you use WATCH, WATCH before reading and treat a nil EXEC as a conflict to retry.",
    why: (I) => I.lv === 1 ? "Both buyers read stock = 1 before either EXEC ran; MULTI only made each DECR atomic, so stock went to −1 and both orders were confirmed." : I.lv === 2 ? "B's purchase completed between A's GET and A's WATCH, so A watched a key that had already changed, and A's EXEC succeeded on stale information." : "WATCH worked: A's EXEC returned nil. But the client returns None for an aborted EXEC, and <code>None is not False</code> is true, so the order was confirmed anyway.",
  });

  /* ================================================================
     INTERLEAVE: acknowledged writes lost in failover
     ================================================================ */
  function ackLanes(I) {
    const lanes = [];
    const set = (s) => { if (s.down) return "primary is down: error to client"; s.p = true; s.setOk = true; return "primary: OK (acknowledged)"; };
    const wait = (s) => { if (!s.setOk) return "skipped"; s.acks = (s.r1 ? 1 : 0) + (I.lv === 3 && s.r2 ? 1 : 0); return `WAIT returns ${s.acks}`; };
    const respond = (s) => { if (!s.setOk) return "500 to user"; if (I.lv === 3 && !(s.acks >= 1)) return "not replicated: 503, user retries"; s.told = true; return "200 OK: payment recorded"; };
    lanes.push({ name: "API request", steps: I.lv === 1 ? ["SET payment:9 paid", "respond to user"] : ["SET payment:9 paid", I.lv === 2 ? "WAIT 1 100 (result ignored)" : "WAIT 1 100", I.lv === 2 ? "respond 200" : "respond 200 if ≥ 1 replica acked"], ops: I.lv === 1 ? [set, respond] : [set, wait, respond] });
    lanes.push({ name: "Replication → replica-1", steps: ["replica-1 receives the write"], ops: [(s) => { if (s.p && !s.down) { s.r1 = true; return "replica-1 has it"; } return s.down ? "primary already dead: nothing streamed" : "nothing to stream yet"; }] });
    if (I.lv === 3) lanes.push({ name: "Replication → replica-2", steps: ["replica-2 receives the write"], ops: [(s) => { if (s.p && !s.down) { s.r2 = true; return "replica-2 has it"; } return "nothing streamed"; }] });
    lanes.push({ name: "Failure", steps: ["primary crashes", `Sentinel promotes replica-${I.lv === 3 ? 2 : 1}`], ops: [(s) => { s.down = true; return "primary gone"; }, (s) => { s.promoted = I.lv === 3 ? s.r2 : s.r1; return s.promoted ? "new primary has the write" : "new primary does NOT have the write"; }] });
    return { lanes, init: {} };
  }
  const ackBroken = (r) => r.st.told && r.complete && !r.st.promoted;
  S.push({
    id: "redis-acked-write-loss",
    name: "Lose an acknowledged write",
    kind: "Investigation",
    skills: ["diagnose", "design"],
    w: "interleave",
    gen(lv, R) { return { lv, amt: R.int(20, 400) }; },
    text: (I) => `<p>A payments service records "paid" in Redis (Sentinel-managed, ${I.lv === 3 ? "two replicas" : "one replica"}) and tells the user it worked. ${I.lv === 1 ? "It responds as soon as the primary says OK." : I.lv === 2 ? "After a previous incident someone added <code>WAIT 1 100</code> after the write (wait up to 100 ms for 1 replica)." : "It now checks WAIT's return value and only responds 200 once at least one replica has the write."}</p><p>Find a schedule where the user got a <b>200</b> but, after the failover, the new primary doesn't have the payment.</p>`,
    ui: (I) => { const L = ackLanes(I); return { lanes: L.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = runLanes(L.lanes, L.init, seq || []); return laneHTML(L.lanes, r) + (r.complete ? K.verdict(ackBroken(r), ackBroken(r) ? "acknowledged payment LOST" : "no acknowledged write was lost") : ""); } }; },
    accept: (I, seq) => { const L = ackLanes(I); const r = runLanes(L.lanes, L.init, seq); return ackBroken(r) ? true : "No acknowledged write was lost in that schedule."; },
    solve: (I) => { const L = ackLanes(I); for (const s of interleave(L.lanes.map((l) => l.steps.length))) if (ackBroken(runLanes(L.lanes, L.init, s))) return s; return null; },
    bad: (I) => { const L = ackLanes(I); return [sequential(L.lanes)]; },
    hint: (I) => I.lv === 1 ? "Replication is asynchronous: the primary acknowledges before the replica has the write." : I.lv === 2 ? "What does WAIT return if the replica hasn't caught up within 100 ms, and what does the code do with it?" : "WAIT 1 means one replica, any replica. Which one does Sentinel promote?",
    concept: "Async replication, WAIT and failover data loss",
    how: "A Redis primary replies OK before replicas receive the write. If it crashes before streaming it, the promoted replica never had it: the acknowledged write is gone. WAIT numreplicas timeout blocks until that many replicas acknowledged, or the timeout passes, and returns how many did; it doesn't roll anything back, so the caller must check the count. Even then, Sentinel may promote a replica that wasn't among those that acknowledged (it prefers the highest offset at election time, but nothing ties it to your WAIT). WAIT reduces the window; it does not make Redis a strongly consistent store. min-replicas-to-write limits writes when replicas are missing.",
    rule: "Don't make Redis the only record of anything you've promised a user (payments, orders). Write it to a durable store; if you rely on WAIT, check its result and accept the residual risk.",
    why: (I) => I.lv === 1 ? "The primary said OK and the user got 200, then the primary died before streaming to replica-1, which Sentinel promoted without the payment." : I.lv === 2 ? "WAIT timed out returning 0 because the replica hadn't received the write yet, the code ignored the 0 and responded 200, and the primary died before replicating." : "replica-1 acknowledged, so WAIT returned 1 and the user got 200; the primary died before replica-2 got the write, and Sentinel promoted replica-2.",
  });

  /* ================================================================
     TOPO: Sentinel quorum and split brain
     ================================================================ */
  function sentTopo(I) {
    const azs = I.lv === 3 ? ["a", "b"] : ["a", "b", "c"];
    const nodes = [], links = [];
    const sw = {};
    azs.forEach((z, i) => { sw[z] = nodes.length; nodes.push({ label: `AZ-${z} network`, x: 95 + i * (I.lv === 3 ? 420 : 225), y: 150, cls: "sw", sub: "switch", role: "sw", az: z }); });
    const add = (label, role, az, dx0, dy) => { const dx = dx0 * 1.05; const i = nodes.length; nodes.push({ label, role, az, x: nodes[sw[az]].x + dx, y: nodes[sw[az]].y + dy }); links.push([i, sw[az]]); return i; };
    const P = add("Redis primary", "P", "a", -55, -90), R1 = add("Redis replica", "R", "b", -55, -90);
    add("app (AZ-a)", "app", "a", -55, 95); add("app (AZ-b)", "app", "b", -55, 95);
    if (I.lv === 3) { add("sentinel 1", "S", "a", 60, -90); add("sentinel 2", "S", "a", 60, 95); add("sentinel 3", "S", "b", 60, -90); }
    else { add("sentinel 1", "S", "a", 60, -90); add("sentinel 2", "S", "b", 60, -90); add("sentinel 3", "S", "c", 0, -90); }
    for (let i = 0; i < azs.length; i++) for (let j = i + 1; j < azs.length; j++) links.push([sw[azs[i]], sw[azs[j]], `${azs[i]}↔${azs[j]}`]);
    void P; void R1;
    return { nodes, links };
  }
  function sentSim(I, T, a) {
    const down = new Set(a.down || []), cut = new Set(a.cut || []);
    const n = T.nodes.length, adj = Array.from({ length: n }, () => []);
    T.links.forEach(([x, y], i) => { if (cut.has(i) || down.has(x) || down.has(y)) return; adj[x].push(y); adj[y].push(x); });
    const comp = Array(n).fill(-1); let c = 0;
    for (let i = 0; i < n; i++) { if (comp[i] >= 0 || down.has(i)) continue; const q = [i]; comp[i] = c; while (q.length) { const u = q.pop(); for (const v of adj[u]) if (comp[v] < 0) { comp[v] = c; q.push(v); } } c++; }
    const reach = (x, y) => !down.has(x) && !down.has(y) && comp[x] === comp[y];
    const idx = (r) => T.nodes.map((nd, i) => (nd.role === r ? i : -1)).filter((i) => i >= 0);
    const P = idx("P")[0], Rr = idx("R")[0], Ss = idx("S"), apps = idx("app");
    const pAlive = !down.has(P);
    // sentinels that can't see P, grouped by component; need >= quorum (2) and a majority of all sentinels (2 of 3) together, able to reach R
    let promoted = false;
    if (!down.has(Rr)) { const g = Ss.filter((s) => !down.has(s) && !reach(s, P) && reach(s, Rr)); if (g.length >= 2) promoted = true; }
    const pWrites = pAlive && (!I.minRep || reach(P, Rr)) && apps.some((ap) => reach(ap, P));
    const rWrites = promoted && apps.some((ap) => reach(ap, Rr)) && (!I.minRep || false);
    const anyWrite = pWrites || (promoted && apps.some((ap) => reach(ap, Rr)) && !I.minRep);
    return { promoted, pWrites, rWrites, split: pWrites && promoted && apps.some((ap) => reach(ap, Rr)), anyWrite };
  }
  S.push({
    id: "redis-sentinel-split",
    name: "Break Sentinel failover",
    kind: "Experiment",
    skills: ["diagnose", "design"],
    w: "topo",
    gen(lv, R) { return { lv, minRep: lv === 2, quorum: 2, app: R.pick(["checkout", "sessions", "matchmaking"]) }; },
    text: (I) => `<p>Chaos game-day for the ${esc(I.app)} Redis: one primary, one replica, three Sentinels (quorum 2), apps in ${I.lv === 3 ? "both AZs. The platform team put two Sentinels in AZ-a \"next to the primary, for fast detection\"" : "two AZs"}.${I.lv === 2 ? " The primary has <code>min-replicas-to-write 1</code>, <code>min-replicas-max-lag 10</code>." : ""} Sentinels promote the replica only when at least 2 of them can't reach the primary and can reach each other and the replica.</p><p>${I.lv === 1 ? "Cut <b>two network links</b> so that two primaries accept writes from apps at the same time (split brain)." : I.lv === 2 ? "Inject <b>one</b> failure (a node or a link) that leaves the apps unable to write at all, even though no Sentinel failover happens." : "Inject <b>one</b> failure that leaves no writable primary: the primary is gone and Sentinel can't fail over."}</p>`,
    ui: (I) => { const T = sentTopo(I); return { nodes: T.nodes, links: T.links, mode: I.lv === 1 ? "links" : "both", k: I.lv === 1 ? 2 : 1, H: 310, bw: 100, W: I.lv === 3 ? 640 : 640, live: (a) => { if (!a) return ""; const r = sentSim(I, T, a); return K.metrics([{ name: "Replica promoted", value: r.promoted ? "yes" : "no", ok: null }, { name: "Old primary takes writes", value: r.pWrites ? "yes" : "no", ok: null }, { name: "Split brain", value: r.split ? "YES" : "no", ok: r.split ? false : null }, { name: "Apps can write", value: r.anyWrite ? "yes" : "NO", ok: r.anyWrite ? null : false }]); } }; },
    valid: (I, a) => { const T = sentTopo(I); const r = sentSim(I, T, a); if (I.lv === 1) return r.split ? true : "no split brain: either Sentinels can still see the primary or the old primary is cut off from all apps"; if (I.lv === 2) return !r.anyWrite && !r.promoted ? true : r.promoted ? "that triggers a failover; find a failure where nobody fails over yet writes still stop" : "apps can still write"; return !r.anyWrite ? true : "a primary is still writable"; },
    val: () => 1,
    hint: (I) => I.lv === 1 ? "Isolate the primary's AZ from the Sentinel majority, but keep an app with it." : I.lv === 2 ? "min-replicas-to-write makes the primary depend on something besides itself." : "How many Sentinels survive if a whole AZ goes away? Is that a majority of 3?",
    concept: "Sentinel quorum, majorities and split brain",
    how: "Sentinels mark the primary objectively down when quorum of them agree, but a failover also needs a leader elected by a majority of all Sentinels. If the primary is partitioned with some apps but away from the Sentinel majority, a replica is promoted while the old primary keeps accepting writes from the apps on its side: split brain, and those writes are discarded when it rejoins as a replica. min-replicas-to-write N makes a primary refuse writes when it can't see N replicas, which bounds split brain, but also makes the replica a write dependency. Sentinels must be spread so that losing any one failure domain leaves a majority.",
    rule: "Run ≥ 3 Sentinels in ≥ 3 failure domains (never a majority in one), and set min-replicas-to-write with min-replicas-max-lag to cap what an isolated primary can accept.",
    why: (I) => I.lv === 1 ? "Cutting both links out of AZ-a left the primary, Sentinel 1 and an app together; Sentinels 2 and 3 couldn't see it and promoted the replica, which AZ-b's app wrote to. Two primaries." : I.lv === 2 ? "With min-replicas-to-write 1, losing just the replica (or its link) makes the primary refuse writes, while Sentinels still see a healthy primary and don't fail over: an outage from a replica failure." : "Losing AZ-a takes the primary and two of three Sentinels. Sentinel 3 alone can't reach the majority needed to authorise a failover, so the replica is never promoted.",
  });

  /* ================================================================
     TOPO: Redis Cluster survivability
     ================================================================ */
  function clTopo(I) {
    const nodes = [], links = [];
    const azx = [110, 320, 530];
    azx.forEach((x, i) => nodes.push({ label: `AZ-${i + 1}`, x, y: 40, sub: "whole zone", cls: "sw" }));
    I.place.forEach((p, k) => { const az = p.az, cnt = I.place.slice(0, k).filter((q) => q.az === az).length; nodes.push({ label: p.label, x: azx[az], y: 120 + cnt * 70, sub: p.role === "P" ? p.slots : `replica of ${p.of.replace("primary ", "")}` }); links.push([az, nodes.length - 1]); });
    return { nodes, links };
  }
  function clSim(I, a) {
    const down = new Set();
    (a.down || []).forEach((i) => { if (i < 3) I.place.forEach((p, k) => { if (p.az === i) down.add(k); }); else down.add(i - 3); });
    const prims = I.place.map((p, k) => (p.role === "P" ? k : -1)).filter((k) => k >= 0);
    const alivePrims = prims.filter((k) => !down.has(k)).length;
    const lost = [];
    prims.forEach((k) => {
      if (!down.has(k)) return;
      const rep = I.place.findIndex((p, j) => p.role === "R" && p.of === I.place[k].label && !down.has(j));
      if (rep < 0) lost.push(`${I.place[k].label}: primary and replica both down`);
      else if (alivePrims < 2) lost.push(`${I.place[k].label}: its replica can't get votes from a majority of primaries (${alivePrims} of 3 alive)`);
    });
    return { lost, fail: lost.length > 0, n: (a.down || []).length };
  }
  S.push({
    id: "redis-cluster-survival",
    name: "Find the cluster's weakest failure",
    kind: "Experiment",
    skills: ["diagnose", "design"],
    w: "topo",
    sense: "min",
    vname: "failures needed:",
    gen(lv, R) {
      const P = ["A", "B", "C"], sl = ["0-5460", "5461-10922", "10923-16383"];
      let az;
      if (lv === 1) { const bad = R.int(0, 2); az = { P: [0, 1, 2], R: [0, 1, 2].map((i) => (i === bad ? i : (i + 1) % 3)) }; }
      else if (lv === 2) { az = { P: [0, 0, 1], R: [1, 2, 2] }; }
      else { az = { P: [0, 1, 2], R: [1, 2, 0] }; }
      const place = [];
      P.forEach((p, i) => place.push({ label: `primary ${p}`, role: "P", az: az.P[i], slots: sl[i] }));
      P.forEach((p, i) => place.push({ label: `replica ${p}'`, role: "R", az: az.R[i], of: `primary ${p}` }));
      return { lv, place: R.shuffle(place) };
    },
    text: (I) => `<p>A 3-shard Redis Cluster (3 primaries, 1 replica each, <code>cluster-require-full-coverage yes</code>) runs across three AZs as shown. A failover needs the votes of a <b>majority of primaries</b> (2 of 3).</p><p>Fail the <b>fewest</b> components (whole AZs or single nodes) that take the cluster to <code>cluster_state:fail</code>. ${I.lv === 3 ? "The team claims no single failure can do it. Is that true, and what's the cheapest way?" : ""}</p>`,
    ui: (I) => { const T = clTopo(I); return { nodes: T.nodes, links: T.links, mode: "nodes", H: 360, nodeVerb: "failed", live: (a) => { if (!a) return ""; const r = clSim(I, a); return r.fail ? K.verdict(false, "cluster_state:fail: " + esc(r.lost.join("; "))) : K.verdict(true, "cluster_state:ok: every slot still has a primary or a replica that can be promoted"); } }; },
    valid: (I, a) => (clSim(I, a).fail ? true : "the cluster survives that"),
    val: (I, a) => (a.down || []).length,
    hint: (I) => I.lv === 1 ? "Look for a primary and its replica in the same zone." : I.lv === 2 ? "Replicas are placed away from their primaries, but count the primaries per zone." : "No zone holds two primaries or a primary with its own replica. What if two primaries die at once, wherever they are?",
    concept: "Redis Cluster failover and placement",
    how: "Every slot must be served for the cluster to be OK (with cluster-require-full-coverage yes). When a primary fails, its replica is promoted only after a majority of the primaries vote for it. So a shard is lost if its primary and replica fail together, and every failover stalls if a majority of primaries fail at once, even when their replicas are healthy. Placement should put each replica in a different zone from its primary and no more than a minority of primaries in any zone.",
    rule: "Spread primaries evenly across ≥ 3 zones, keep each replica out of its primary's zone, and remember the cluster needs a surviving majority of primaries to fail over anything.",
    why: (I, sol, best) => `Minimum: <b>${best}</b> failure(s). ${I.lv === 1 ? "One primary shared a zone with its own replica, so that zone alone took a shard offline." : I.lv === 2 ? "AZ-1 held two of the three primaries: losing it left one primary, which can't form a majority to promote the replicas." : "No single zone can do it, but any two primaries failing together leave one primary: no majority, so no replica can be promoted."}`,
  });

  /* ================================================================
     STEPS (4)
     ================================================================ */
  const migP = (lv) => {
    const o = [
      { id: "new", t: "Provision the new cache cluster (same maxmemory and policy)" },
      { id: "dual", t: "Deploy: write/invalidate to both caches, keep reading from the old one" },
      { id: "fill", t: "Wait one TTL period so the new cache fills from real traffic" },
      { id: "r1", t: "Shift 5% of reads to the new cache; watch hit ratio and DB QPS" },
      { id: "r100", t: "Shift the rest of the reads in steps (25% → 50% → 100%)" },
      { id: "stop", t: "Stop writing to the old cache" },
      { id: "off", t: "Decommission the old cache after a soak period" },
      { id: "flip", t: "Point all reads at the new cache in one deploy", trap: "an empty cache takes 100% of reads at once: every request misses and the database melts (cold start)." },
      { id: "keys", t: "Copy data over with KEYS * and DUMP/RESTORE", trap: "KEYS * blocks the old production cache for seconds; use SCAN, or let traffic warm it." },
      { id: "flush", t: "FLUSHALL the old cache to force clients onto the new one", trap: "it drops the fallback while the new cache is cold." },
    ];
    if (lv === 3) o.push({ id: "inv", t: "Make the update path send invalidations (DEL) to both caches", opt: false }, { id: "readnew", t: "Read from the new cache, fall back to the old one on a miss", trap: "falling back to the old cache returns values whose invalidations it may have missed; fill from the database instead." });
    return o;
  };
  const MIG = {
    1: ["new", "dual", "fill", "r1", "r100", "stop", "off"],
    2: ["new", "dual", "fill", "r1", "r100", "stop", "off"],
    3: ["new", "inv", "dual", "fill", "r1", "r100", "stop", "off"],
  };
  S.push({
    id: "redis-cache-migration",
    name: "Move to a new cache without a cold start",
    kind: "Change plan",
    skills: ["safe"],
    w: "steps",
    gen(lv, R) {
      const P = { opts: shuf(R, migP(lv).filter((o) => lv > 1 || o.id !== "keys")), order: MIG[lv] };
      return { lv, P, qps: R.int(40, 90) * 1000, db: R.int(3, 8) * 1000, ttl: R.pick([10, 15, 30]) };
    },
    text: (I) => `<p>You're moving the product cache from an old Redis to a new Redis Cluster (different endpoint, no replication between them). The cache serves <b>${K.num(I.qps)} reads/s</b> at a 97% hit ratio; Postgres can take ~${K.num(I.db)} queries/s. Keys have a ${I.ttl}-minute TTL.${I.lv === 3 ? " Prices are invalidated with <code>DEL</code> on every update; stale prices are a correctness bug." : ""}</p><p>Build the cut-over plan. Some steps are traps.</p>`,
    ui: (I) => ({ ...stepsSpec(I.P) }),
    accept: (I, seq) => stepsCheck(I.P, seq),
    solve: (I) => stepsSolve(I.P),
    bad: (I) => [[I.P.opts.findIndex((o) => o.id === "new"), I.P.opts.findIndex((o) => o.id === "flip")], stepsSolve(I.P).slice().reverse()],
    hint: (I) => I.lv === 3 ? "While two caches exist, an update must reach both, or the one you're about to read from serves old prices." : "Cold caches are the danger: fill the new one before it takes reads, and move reads gradually.",
    concept: "Cache migration and cold starts",
    how: "A cache that suddenly receives all reads while empty sends nearly all of them to the database (a cold start), which at 97% hit ratio means a ~30× load increase. Warm it first: write to both (or let traffic populate it for a TTL), then move reads gradually while watching hit ratio and DB load, and keep the old cache as the fallback until the new one is proven. During the dual period, invalidations must reach both caches, or the cache you switch to will serve values that were invalidated only in the old one.",
    rule: "Never point full traffic at an empty cache. Dual-write and dual-invalidate, warm for a TTL, shift reads in steps with a rollback, decommission last.",
    why: (I) => `At ${K.num(I.qps)} reads/s, a cold cut-over would send ~${K.num(I.qps * 0.97)} extra queries/s to a database that handles ~${K.num(I.db)}. Writing to both and waiting ${I.ttl} minutes fills the new cache naturally; ${I.lv === 3 ? "sending DELs to both keeps the new cache from serving prices that changed during the dual period; " : ""}stepping reads lets you roll back at the first sign of DB pressure.`,
  });

  const upgP = (lv) => {
    const o = lv < 3 ? [
      { id: "r1", t: "Upgrade replica 1, wait for master_link_status:up and offsets to match" },
      { id: "r2", t: "Upgrade replica 2, wait for it to resync" },
      { id: "fo", t: "SENTINEL FAILOVER mymaster (promotes an upgraded replica)" },
      { id: "old", t: "Upgrade the old primary (now a replica), let it resync" },
      { id: "chk", t: "Check INFO replication on all nodes and the client error rate" },
      { id: "pfirst", t: "Upgrade the primary first, then the replicas", trap: "restarting the primary forces an unplanned failover (or an outage), and a newer primary can't stream its RDB format to older replicas." },
      { id: "all", t: "Restart all three nodes with the new version at once", trap: "total outage, and with no persistence on the primary the data is gone." },
      { id: "foEarly", t: "SENTINEL FAILOVER before upgrading any replica", trap: "you just move the primary to another old-version node and still have to fail over again." },
    ] : [
      { id: "chk0", t: "redis-cli --cluster check: all slots covered, every primary has a replica" },
      { id: "reps", t: "Upgrade the replica of shard 1, wait until it's in sync" },
      { id: "cf", t: "On that upgraded replica: CLUSTER FAILOVER (coordinated, no data loss)" },
      { id: "old", t: "Upgrade the demoted node (now a replica), wait for sync" },
      { id: "next", t: "Verify cluster_state:ok, then repeat for shards 2 and 3, one at a time" },
      { id: "force", t: "CLUSTER FAILOVER TAKEOVER on the replica", trap: "TAKEOVER skips agreement with the primary and other nodes: it's for when the majority is gone, and it can lose writes." },
      { id: "par", t: "Upgrade all three shards' replicas and primaries in parallel to save time", trap: "if two primaries are restarting together, the cluster has no majority of primaries to authorise failovers." },
      { id: "pfirst", t: "Restart each primary first; its replica takes over automatically", trap: "an uncoordinated failover after node timeout: seconds of errors and possible loss of the last writes; CLUSTER FAILOVER on the replica is the graceful path." },
    ];
    return o;
  };
  const UPG = { 1: ["r1", "r2", "fo", "old", "chk"], 2: ["r1", "r2", "fo", "old", "chk"], 3: ["chk0", "reps", "cf", "old", "next"] };
  S.push({
    id: "redis-rolling-upgrade",
    name: "Upgrade Redis with no downtime",
    kind: "Change plan",
    skills: ["safe"],
    w: "steps",
    gen(lv, R) { return { lv, P: { opts: shuf(R, upgP(lv)), order: UPG[lv] }, from: lv === 3 ? "7.0.15" : R.pick(["6.2.14", "7.0.15"]), to: "7.2.5" }; },
    text: (I) => I.lv === 3 ? `<p>Upgrade a 3-shard Redis Cluster (1 replica per shard) from ${I.from} to ${I.to} during business hours. Clients are cluster-aware and follow MOVED/failovers.</p><p>Order the steps for one safe rollout.</p>` : `<p>Upgrade a Sentinel-managed Redis (1 primary, 2 replicas) from ${I.from} to ${I.to} with no write outage beyond a failover blip. ${I.lv === 2 ? "The app's client library reconnects on <code>READONLY</code> errors and re-resolves the primary via Sentinel." : ""}</p><p>Order the steps. Some are traps.</p>`,
    ui: (I) => stepsSpec(I.P),
    accept: (I, seq) => stepsCheck(I.P, seq),
    solve: (I) => stepsSolve(I.P),
    bad: (I) => [[I.P.opts.findIndex((o) => o.id === "pfirst")], stepsSolve(I.P).slice().reverse()],
    hint: (I) => I.lv === 3 ? "One shard at a time, replicas before primaries, and a coordinated failover for each." : "Replicas first; a newer primary must never feed older replicas.",
    concept: "Rolling upgrades: replicas first, controlled failover",
    how: "Replication is designed so an older primary can feed newer replicas, not the other way round (a newer RDB format can't be loaded by an older replica). So upgrade replicas first, then move the primary role to an upgraded replica with a controlled failover (SENTINEL FAILOVER, or CLUSTER FAILOVER on the replica, which waits for it to catch up before switching), then upgrade the old primary as a replica. In Cluster, do one shard at a time so a majority of primaries is always available to authorise failovers.",
    rule: "Replicas first, controlled failover, old primary last, one shard at a time, verifying sync between steps.",
    why: (I) => I.lv === 3 ? "CLUSTER FAILOVER on an in-sync upgraded replica swaps roles without losing writes, and doing shards one at a time keeps a majority of primaries for any unexpected failover." : "Upgrading both replicas first means the failover promotes an upgraded node and no newer primary ever feeds an older replica. The primary only restarts once it's a replica.",
  });

  const shardP = (lv) => {
    const o = [
      { id: "add", t: "redis-cli --cluster add-node new-1:6379 existing:6379" },
      { id: "rep", t: "redis-cli --cluster add-node new-1r:6379 existing:6379 --cluster-slave --cluster-master-id <new-1 id>" },
      { id: "reb", t: "redis-cli --cluster rebalance existing:6379 --cluster-use-empty-masters" },
      { id: "chk", t: "redis-cli --cluster check existing:6379" },
      { id: "reset", t: "CLUSTER RESET HARD on an existing node to make room", trap: "it wipes that node's slot assignments and data." },
      { id: "ka", t: "Use KEYS * on each shard to plan which keys to move", trap: "KEYS blocks each production shard; slot migration doesn't need a key list." },
    ];
    if (lv >= 2) o.push({ id: "off", t: "Schedule the rebalance off-peak and watch latency (MIGRATE blocks per key batch)" });
    if (lv === 3) o.push({ id: "big", t: "Run --bigkeys and split or remove multi-GB keys before rebalancing" }, { id: "bigIgnore", t: "Raise cluster-node-timeout to 10 minutes so big MIGRATEs don't trigger failovers", trap: "a 10-minute node timeout means a real failure goes undetected for 10 minutes." });
    return o;
  };
  const SHARD = { 1: ["add", "rep", "reb", "chk"], 2: ["add", "rep", "off", "reb", "chk"], 3: ["big", "add", "rep", "off", "reb", "chk"] };
  S.push({
    id: "redis-cluster-add-shard",
    name: "Add a shard to the cluster",
    kind: "Change plan",
    skills: ["safe", "design"],
    w: "steps",
    gen(lv, R) { return { lv, P: { opts: shuf(R, shardP(lv)), order: SHARD[lv], whyOrder: { reb: "moving slots onto a primary with no replica leaves that data unprotected", rep: "the replica needs its primary to exist first" } }, mem: R.int(60, 85), big: R.int(3, 9) }; },
    text: (I) => `<p>The 3-shard Redis Cluster is at ${I.mem}% of maxmemory. Add a fourth shard (<code>new-1</code> with replica <code>new-1r</code>, both started with <code>cluster-enabled yes</code>) and move a quarter of the slots to it${I.lv >= 2 ? ", while it serves production traffic" : ""}.${I.lv === 3 ? ` A --memkeys run last month found a ${I.big} GB hash in one slot.` : ""}</p><p>Order the steps; leave out the traps.</p>`,
    ui: (I) => stepsSpec(I.P),
    accept: (I, seq) => stepsCheck(I.P, seq),
    solve: (I) => stepsSolve(I.P),
    bad: (I) => { const s = stepsSolve(I.P); const a = s.slice(); const ir = I.P.opts.findIndex((o) => o.id === "rep"), ib = I.P.opts.findIndex((o) => o.id === "reb"); const x = a.indexOf(ir), y = a.indexOf(ib); [a[x], a[y]] = [a[y], a[x]]; return [a, [I.P.opts.findIndex((o) => o.id === "reset"), ...s]]; },
    hint: (I) => I.lv === 3 ? "Slots move key by key with MIGRATE, and each key moves atomically. What does that mean for a multi-GB key?" : "Protect the new shard before it holds data.",
    concept: "Resharding Redis Cluster",
    how: "A new node joins with --cluster add-node, gets a replica, and then receives slots via --cluster rebalance (or reshard), which marks each slot MIGRATING/IMPORTING and moves its keys with MIGRATE in batches; clients follow ASK/MOVED redirects meanwhile. MIGRATE serialises, transfers and deletes each key atomically, blocking both nodes for that key, so a multi-GB key stalls them for seconds, long enough to trigger timeouts or even a failover. Add the replica before moving data so the new shard is never a single point of failure.",
    rule: "Add primary, add its replica, then rebalance off-peak, after dealing with big keys; check the cluster before and after.",
    why: (I) => `Rebalancing with --cluster-use-empty-masters moves ~${Math.round(16384 / 4)} slots to new-1. ${I.lv === 3 ? `The ${I.big} GB hash would be moved by a single MIGRATE, blocking both nodes for many seconds; split it first.` : "With the replica attached first, the new shard never holds data without a copy."}`,
  });

  const splitP = (lv) => {
    const o = [
      { id: "dual", t: "Deploy dual-write: every update goes to the hash and to the new per-user key" },
      { id: "back", t: lv === 3 ? "Backfill with HSCAN in batches, writing new keys with SET NX (skip if present)" : "Backfill with HSCAN in batches of ~500 fields, pipelined writes to the new keys" },
      { id: "verify", t: "Verify: sample users, compare hash field vs new key; compare counts" },
      { id: "reads", t: "Switch reads to the new keys behind a feature flag" },
      { id: "stopw", t: "Stop writing to the old hash" },
      { id: "drop", t: lv >= 2 ? "Remove the old hash with UNLINK (or HSCAN + HDEL in batches)" : "UNLINK the old hash" },
      { id: "hgetall", t: "Export the hash with HGETALL and import the result", trap: "HGETALL on a multi-GB hash blocks Redis for seconds and needs gigabytes of client memory." },
      { id: "readsEarly", t: "Switch reads to the new keys first so you can test them", trap: "until the backfill finishes most users have no new key: reads miss or return nothing." },
    ];
    if (lv >= 2) o.push({ id: "del", t: "DEL the old hash", trap: "DEL frees millions of fields on the main thread: a multi-second stall (use UNLINK or batched HDEL)." });
    if (lv === 3) o.push({ id: "backSet", t: "Backfill with HSCAN, writing new keys with plain SET (overwrite)", trap: "the backfill read a field, then a dual-write updated the new key, then the backfill overwrote it with the older value." });
    return o;
  };
  S.push({
    id: "redis-big-hash-split",
    name: "Split a giant hash online",
    kind: "Change plan",
    skills: ["safe", "design"],
    w: "steps",
    gen(lv, R) { return { lv, P: { opts: shuf(R, splitP(lv)), order: ["dual", "back", "verify", "reads", "stopw", "drop"], whyOrder: { back: "without dual-write, updates made during the backfill are lost", reads: "reads can only move once the new keys are complete and verified" } }, gb: R.int(3, 9), fields: R.int(15, 40) }; },
    text: (I) => `<p><code>user:profiles</code> is a single ${I.gb} GB hash with ${I.fields} M fields (one per user). It's the biggest key in the cluster, pins one shard and makes every failover resync painful. Migrate to one key per user (<code>profile:{&lt;id&gt;}</code>) with no downtime and no lost updates.${I.lv === 3 ? " Profiles are updated ~2,000 times/s during the migration." : ""}</p><p>Order the steps; leave out the traps.</p>`,
    ui: (I) => stepsSpec(I.P),
    accept: (I, seq) => stepsCheck(I.P, seq),
    solve: (I) => stepsSolve(I.P),
    bad: (I) => { const f = (id) => I.P.opts.findIndex((o) => o.id === id); return [[f("dual"), f("back"), f("verify"), f("reads"), f("stopw"), f(I.lv >= 2 ? "del" : "hgetall")], [f("back"), f("dual"), f("verify"), f("reads"), f("stopw"), f("drop")]]; },
    hint: (I) => I.lv === 3 ? "The backfill and the live dual-writes race for the same new keys. Which one should win?" : "Start capturing new writes before copying old data, and never read or delete the whole hash in one command.",
    concept: "Online data migration in Redis (dual-write + backfill)",
    how: "Migrating live data follows expand/contract: start dual-writing so new changes land in both shapes, backfill old data incrementally (HSCAN with a cursor, pipelined writes) so nothing blocks, verify, move reads behind a flag, stop the old writes, then delete the old structure without blocking (UNLINK, or HSCAN + HDEL in batches). The backfill must never overwrite a value the dual-write already set: use SET NX or compare versions, because the backfill may have read the field before the latest update.",
    rule: "Dual-write first, backfill with SCAN-family commands and NX semantics, verify, switch reads, then contract with non-blocking deletes.",
    why: (I) => `With ${I.fields} M fields, HGETALL or DEL on the hash would block a shard for seconds. Dual-writing first means no update is missed while HSCAN copies the rest${I.lv === 3 ? ", and SET NX keeps a fresh dual-write from being overwritten by the backfill's older copy" : ""}.`,
  });

  /* ================================================================
     LINES: code reviews
     ================================================================ */
  const diff = (arr) => arr.map(([k, t]) => ({ k, t }));
  const LOCKS = {
    1: { file: "jobs/lock.py", lines: diff([["@", "@@ -1,18 +1,22 @@"], [" ", "import uuid, redis"], [" ", "r = redis.Redis(host=REDIS_HOST)"], ["+", "def acquire(name):"], ["+", '    token = "1"'], ["+", "    ok = r.set(f\"lock:{name}\", token, nx=True, px=30_000)"], ["+", "    return token if ok else None"], ["+", ""], ["+", "def release(name, token):"], ["+", '    r.delete(f"lock:{name}")'], ["+", ""], ["+", "def run_payout(batch):"], ["+", "    t = acquire(f\"payout:{batch.id}\")"], ["+", "    if not t:"], ["+", "        return"], ["+", "    try:"], ["+", "        do_payout(batch)  # p99 4 s"], ["+", "    finally:"], ["+", "        release(f\"payout:{batch.id}\", t)"]]), bugs: [5, 10], why: { 5: "Every worker uses the same token, so ownership can't be checked.", 10: "Plain DEL can delete a lock another worker acquired after ours expired; release must compare the token (Lua: if GET == token then DEL)." } },
    2: { file: "jobs/lock.py", lines: diff([["@", "@@ -1,24 +1,30 @@"], [" ", "import uuid, redis"], [" ", "RELEASE = r.register_script(\"if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0\")"], ["+", "def acquire(name):"], ["+", "    token = uuid.uuid4().hex"], ["+", "    ok = r.set(f\"lock:{name}\", token, nx=True)"], ["+", "    return token if ok else None"], ["+", ""], ["+", "def extend(name, token):"], ["+", "    r.expire(f\"lock:{name}\", 30)"], ["+", ""], ["+", "def release(name, token):"], ["+", "    RELEASE(keys=[f\"lock:{name}\"], args=[token])"], ["+", ""], ["+", "def run(batch):"], ["+", "    t = acquire(batch.id)"], ["+", "    if t:"], ["+", "        for chunk in batch.chunks():"], ["+", "            process(chunk); extend(batch.id, t)"], ["+", "        release(batch.id, t)"]]), bugs: [5, 9], why: { 5: "No expiry: if the worker crashes, the lock is held forever (add px=...).", 9: "extend() refreshes the TTL without checking the token: it can extend a lock someone else now holds. Do the check in Lua." } },
    3: { file: "billing/settle.py", lines: diff([["@", "@@ -10,22 +10,26 @@"], [" ", "LOCK_TTL_MS = 5_000"], [" ", "def acquire(name):"], [" ", "    token = next_fencing_token()  # INCR lock:fence"], [" ", "    ok = r.set(f\"lock:{name}\", token, nx=True, px=LOCK_TTL_MS)"], [" ", "    return token if ok else None"], ["+", "def settle(account_id):"], ["+", "    t = acquire(f\"settle:{account_id}\")"], ["+", "    if t is None:"], ["+", "        return"], ["+", "    try:"], ["+", "        rows = fetch_unsettled(account_id)   # can take 20–40 s at month end"], ["+", "        db.execute(\"UPDATE ledger SET settled = true WHERE account_id = %s\", [account_id])"], ["+", "    finally:"], ["+", "        release(f\"settle:{account_id}\", t)"]]), bugs: [1, 12], why: { 1: "A 5 s lock TTL for work that takes 20–40 s: the lock expires mid-job and another worker settles the same account.", 12: "The fencing token is generated but never used: the UPDATE should carry it (e.g. WHERE last_fence < %s, then set it) so a stale holder's write is rejected." } },
  };
  S.push({
    id: "redis-lock-review",
    name: "Review the lock helper",
    kind: "Code review",
    skills: ["diagnose", "design"],
    w: "lines",
    gen(lv, R) { return { lv, pr: R.int(1200, 9800), author: R.pick(["jordan", "priya", "mateo", "aisha"]) }; },
    text: (I) => `<p>PR #${I.pr} by ${esc(I.author)} adds a Redis-based lock around ${I.lv === 3 ? "month-end ledger settlement" : "a job that must not run twice concurrently"}. Flag the <b>${LOCKS[I.lv].bugs.length}</b> lines that make the lock unsafe.</p>`,
    ui: (I) => ({ lines: LOCKS[I.lv].lines, file: LOCKS[I.lv].file, k: LOCKS[I.lv].bugs.length }),
    ans: (I) => LOCKS[I.lv].bugs,
    diag: (I, a) => { const b = LOCKS[I.lv].bugs; const miss = b.filter((x) => !a.includes(x)); return miss.length ? `You missed one: look again at line "${esc(LOCKS[I.lv].lines[miss[0]].t.trim())}" and what it allows.` : "Not quite."; },
    show: (I) => LOCKS[I.lv].bugs.map((b) => LOCKS[I.lv].why[b]).join(" "),
    hint: (I) => I.lv === 1 ? "How does release() know it's releasing its own lock?" : I.lv === 2 ? "What if the process dies while holding the lock? And who can extend it?" : "Compare the lock TTL with the work's duration, and follow the fencing token: where is it used?",
    concept: "Safe Redis locks in code",
    how: "A correct Redis lock uses SET key <unique token> NX PX <ttl> in one command, releases and extends with a Lua script that checks the token, and has a TTL comfortably longer than the protected work (or extends it while working). Because TTL-based locks can still expire under pauses, the protected resource should verify a fencing token: a number that increases with every acquisition, checked by the storage so older holders' writes are rejected.",
    rule: "Unique token, NX + PX in one SET, compare-and-delete/extend in Lua, TTL longer than the work, and fencing at the storage when correctness matters.",
    why: (I) => LOCKS[I.lv].bugs.map((b) => LOCKS[I.lv].why[b]).join(" "),
  });

  const CACHE = {
    1: { file: "catalog/cache.py", lines: diff([["@", "@@ -5,20 +5,26 @@"], [" ", "def get_product(pid):"], [" ", "    key = f\"product:v3:{pid}\""], [" ", "    raw = r.get(key)"], [" ", "    if raw:"], [" ", "        return json.loads(raw)"], [" ", "    p = db.fetch_product(pid)"], ["+", "    r.set(key, json.dumps(p))"], [" ", "    return p"], [" ", ""], [" ", "def on_product_updated(pid):"], ["+", "    for k in r.keys(f\"product:*:{pid}\"):"], ["+", "        r.delete(k)"]]), bugs: [7, 11], why: { 7: "No TTL: anything a missed invalidation leaves behind stays stale forever, and memory only grows.", 11: "KEYS scans the whole keyspace on every product update; delete the known key name(s) instead." } },
    2: { file: "catalog/cache.py", lines: diff([["@", "@@ -5,22 +5,26 @@"], [" ", "def get_product(pid):"], [" ", "    key = f\"product:v3:{pid}\""], [" ", "    raw = r.get(key)"], [" ", "    if raw is not None:"], [" ", "        return json.loads(raw)"], [" ", "    p = db.fetch_product(pid)  # None if not found"], ["+", "    r.set(key, json.dumps(p), ex=86_400)"], [" ", "    return p"], [" ", ""], [" ", "def update_product(pid, fields):"], [" ", "    with db.transaction() as tx:"], ["+", "        r.delete(f\"product:v3:{pid}\")"], [" ", "        tx.update_product(pid, fields)"]]), bugs: [7, 12], why: { 7: "Caches 'not found' (null) for 24 h: a product created right after a lookup stays invisible for a day. Negative entries need a short TTL.", 12: "Deleting inside the transaction, before COMMIT: a reader can refill the cache with the old row before the commit lands. Delete after commit." } },
    3: { file: "web/session.py", lines: diff([["@", "@@ -1,24 +1,30 @@"], [" ", "SESSION_TTL = 1800"], [" ", "def login(user):"], [" ", "    sid = secrets.token_urlsafe(32)"], [" ", "    r.hset(f\"sess:{sid}\", mapping=user.session_fields())"], [" ", "    r.expire(f\"sess:{sid}\", SESSION_TTL)"], [" ", "    return sid"], [" ", ""], [" ", "def load_session(sid):"], ["+", "    return r.hgetall(f\"sess:{sid}\")  # 30 min idle timeout per product spec"], [" ", ""], [" ", "def warm_cache(products):"], ["+", "    for p in products:"], ["+", "        r.set(f\"product:v4:{p.id}\", p.json(), ex=3600)"]]), bugs: [9, 13], why: { 9: "The spec says idle timeout, but the TTL is only set at login: active users get logged out 30 minutes after logging in. Refresh it on access (EXPIRE, or GETEX/pipeline).", 13: "Warm-up writes every product with exactly the same TTL: they all expire in the same second an hour later, a stampede. Add jitter." } },
  };
  S.push({
    id: "redis-cache-code-review",
    name: "Review the caching code",
    kind: "Code review",
    skills: ["diagnose"],
    w: "lines",
    gen(lv, R) { return { lv, pr: R.int(1200, 9800) }; },
    text: (I) => `<p>PR #${I.pr} touches ${I.lv === 3 ? "session handling and a cache warm-up job" : "the product cache"}. Flag the <b>2</b> lines that will cause production problems.</p>`,
    ui: (I) => ({ lines: CACHE[I.lv].lines, file: CACHE[I.lv].file, k: 2 }),
    ans: (I) => CACHE[I.lv].bugs,
    show: (I) => CACHE[I.lv].bugs.map((b) => CACHE[I.lv].why[b]).join(" "),
    hint: (I) => I.lv === 1 ? "What bounds how long a value lives? And what does the invalidation path cost on a big keyspace?" : I.lv === 2 ? "What gets cached when the product doesn't exist? And when exactly does the delete happen relative to the commit?" : "When is the session TTL refreshed? What happens an hour after warm-up?",
    concept: "Cache-aside code pitfalls",
    how: "Every cache entry needs a TTL as the backstop for missed invalidations. Invalidate by exact key names, never by KEYS. Cache 'not found' only with a short TTL. Invalidate after the database commit, not before or inside the transaction, or readers can repopulate the old value. Idle-timeout sessions need their TTL refreshed on access. Bulk-written keys need TTL jitter so they don't all expire together.",
    rule: "TTL on everything (with jitter for bulk writes), exact-key invalidation after commit, short negative TTLs, sliding expiry for idle timeouts.",
    why: (I) => CACHE[I.lv].bugs.map((b) => CACHE[I.lv].why[b]).join(" "),
  });

  const RL = {
    1: { file: "ratelimit.lua", lines: diff([["@", "-- fixed window: KEYS[1] = rl:<client>:<minute>, ARGV[1] = window s, ARGV[2] = limit"], [" ", "local n = redis.call('INCR', KEYS[1])"], ["+", "redis.call('EXPIRE', KEYS[1], ARGV[1])"], [" ", "if n > tonumber(ARGV[2]) then"], [" ", "  return 0"], [" ", "end"], [" ", "return 1"]]), bugs: [2], why: { 2: "EXPIRE on every call pushes the expiry forward; with a key name that doesn't change per window, a client that keeps calling never gets its counter reset. Set it only when n == 1." } },
    2: { file: "ratelimit.lua", lines: diff([["@", "-- KEYS: none   ARGV[1] = client id, ARGV[2] = limit"], ["+", "local key = 'rl:' .. ARGV[1] .. ':' .. math.floor(redis.call('TIME')[1] / 60)"], [" ", "local n = redis.call('INCR', key)"], [" ", "if n == 1 then redis.call('EXPIRE', key, 60) end"], ["+", "if n > ARGV[2] then"], [" ", "  return 0"], [" ", "end"], [" ", "return 1"]]), bugs: [1, 4], why: { 1: "The key is built inside the script instead of being passed in KEYS: Redis Cluster can't route it (and it breaks script replication assumptions). Pass it as KEYS[1], with a hash tag if needed.", 4: "ARGV values are strings: comparing a number with a string raises 'attempt to compare number with string'. Use tonumber(ARGV[2])." } },
    3: { file: "sliding_log.lua", lines: diff([["@", "-- KEYS[1] = rl:{client}  ARGV[1] = now ms, ARGV[2] = window ms, ARGV[3] = limit"], [" ", "local now = tonumber(ARGV[1])"], [" ", "redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - tonumber(ARGV[2]))"], [" ", "if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then"], [" ", "  return 0"], [" ", "end"], ["+", "redis.call('ZADD', KEYS[1], now, now)"], ["+", "return 1"]]), bugs: [6, 7], why: { 6: "The member is the timestamp: two requests in the same millisecond collapse into one entry, so bursts are under-counted. Use a unique member (now .. '-' .. a request id).", 7: "No PEXPIRE on the key: every client that ever called keeps a sorted set forever. Set PEXPIRE KEYS[1] to the window after ZADD." } },
  };
  S.push({
    id: "redis-ratelimit-lua-review",
    name: "Review the rate-limit script",
    kind: "Code review",
    skills: ["diagnose"],
    w: "lines",
    gen(lv, R) { return { lv, pr: R.int(1200, 9800), team: R.pick(["API Platform", "Edge", "Identity"]) }; },
    text: (I) => `<p>The ${esc(I.team)} team's Lua rate limiter, run with <code>EVALSHA</code> on every API request${I.lv >= 2 ? " against Redis Cluster" : ""}. Flag the <b>${RL[I.lv].bugs.length}</b> line${RL[I.lv].bugs.length > 1 ? "s" : ""} that ${RL[I.lv].bugs.length > 1 ? "are" : "is"} wrong.</p>`,
    ui: (I) => ({ lines: RL[I.lv].lines, file: RL[I.lv].file, k: RL[I.lv].bugs.length }),
    ans: (I) => RL[I.lv].bugs,
    show: (I) => RL[I.lv].bugs.map((b) => RL[I.lv].why[b]).join(" "),
    hint: (I) => I.lv === 1 ? "When does the window's counter ever go away?" : I.lv === 2 ? "How does Redis Cluster know which node a script's keys live on? And what type is ARGV[2]?" : "What is a sorted set member, and what happens when two members are equal? What cleans up idle clients?",
    concept: "Writing Redis Lua scripts correctly",
    how: "Scripts run atomically, so read-check-write logic is safe inside one. Every key a script touches must be passed in KEYS (Cluster routes by them, and all must hash to one slot). ARGV values arrive as strings: convert with tonumber. Sorted-set members are unique: identical members overwrite each other. Expiries must be set deliberately: once per window for counters (not on every call), and on every write for per-client structures so idle clients disappear.",
    rule: "Pass all keys in KEYS, tonumber every numeric ARGV, use unique members, and give every key the script creates an expiry.",
    why: (I) => RL[I.lv].bugs.map((b) => RL[I.lv].why[b]).join(" "),
  });

  /* ================================================================
     CLASSIFY (3)
     ================================================================ */
  const PAT_CATS = ["Cache-aside", "Read-through", "Write-through", "Write-behind", "Don't cache"];
  const PAT_BANK = [
    [1, "Product pages: the app checks Redis, on a miss queries Postgres and stores the result for 5 minutes", 0],
    [1, "View counters: INCR in Redis on every view, a job flushes the totals to Postgres every 10 s; losing a few seconds of counts in a crash is fine", 3],
    [1, "Account balance used to authorise a card payment", 4],
    [1, "Users edit their profile and must see the change on the very next page load; the cache layer writes to Postgres synchronously before acknowledging", 2],
    [2, "App code only calls cache.get(key); a caching library with a configured loader fetches from the database on a miss", 1],
    [2, "Exchange rates from a paid API (charged per call), same for every request, updated hourly", 0],
    [2, "Game player positions updated 20×/s, persisted to the database once a minute for analytics", 3],
    [2, "One-time password codes that must be checked exactly against what was issued", 4],
    [3, "Inventory count shown on product pages, approximate is fine; the checkout decrements stock in Postgres", 0],
    [3, "Shopping cart where every change must survive a cache restart and be visible immediately; the cache library persists each change to Postgres before returning", 2],
    [3, "Audit log of admin actions (compliance)", 4],
    [3, "Like counts on posts: aggregated in Redis and written to Postgres in batches, reconciled nightly", 3],
  ];
  S.push({
    id: "redis-cache-patterns",
    name: "Pick the caching pattern",
    kind: "Design review",
    skills: ["design"],
    w: "classify",
    gen(lv, R) { const items = R.shuffle(PAT_BANK.filter((x) => x[0] === lv || (lv === 3 && x[0] === 2 && R.chance(0.3)))).slice(0, lv === 1 ? 4 : 5); if (items.length < 4) return null; return { lv, items: items.map((x) => x[1]), ans: items.map((x) => x[2]) }; },
    text: (I) => `<p>Design review for a new service. For each piece of data, choose how (or whether) it should go through Redis. ${I.lv === 3 ? "Some are close calls: think about who owns correctness." : ""}</p>`,
    ui: (I) => ({ items: I.items, cats: PAT_CATS }),
    ans: (I) => I.ans,
    diag: (I, a) => { const i = a.findIndex((x, k) => x !== I.ans[k]); return `Look again at: "${esc(I.items[i])}".`; },
    hint: () => "Cache-aside: app loads on miss. Read-through: a library loads on miss. Write-through: writes go to cache and DB synchronously. Write-behind: cache first, DB later (can lose recent writes). Some data must come from the source of truth every time.",
    concept: "Cache-aside, read-through, write-through, write-behind",
    how: "Cache-aside puts the logic in the application: read the cache, on a miss load from the database and populate; simple, and stale up to the TTL. Read-through moves the loading into a cache library or provider, so callers only ask the cache. Write-through writes to the cache and the database synchronously, so reads after writes are fresh, at the cost of write latency. Write-behind acknowledges writes in the cache and persists them asynchronously in batches: great for high-rate counters, but a crash loses unflushed writes. Data that authorises money or must be exact belongs in the source of truth, not a cache.",
    rule: "Default to cache-aside with a TTL; write-through when read-after-write freshness matters; write-behind only for data you can afford to lose a few seconds of; never cache what must be exact.",
    why: (I) => I.items.map((t, k) => `${esc(t.split(":")[0].split(",")[0])} → <b>${PAT_CATS[I.ans[k]]}</b>`).join("; ") + ".",
  });

  const MSG_CATS = ["Pub/Sub", "Stream + consumer group", "Sorted set (scheduled)", "Stream, read by ID (no group)"];
  const MSG_BANK = [
    [1, "Push live cursor positions to every connected WebSocket server; a missed update is replaced 50 ms later", 0],
    [1, "Order-paid events processed by a pool of workers; each must be handled once even if a worker crashes", 1],
    [1, "Send each reminder email at its scheduled time (minutes to weeks ahead)", 2],
    [2, "Cache-invalidation broadcast to all 300 app instances (local caches also have a 30 s TTL as a backstop)", 0],
    [2, "Webhook deliveries with retries; a delivery that fails 10 times goes to a dead-letter queue", 1],
    [2, "Retry failed payments after 1 min, 5 min, then 30 min", 2],
    [3, "A single audit service replays the full history from where it stopped after a restart; nobody else consumes it", 3],
    [3, "Chat typing indicators fanned out to the room's members", 0],
    [3, "Image-resize jobs spread across 40 workers, with visibility into which worker holds which job", 1],
  ];
  S.push({
    id: "redis-messaging-choice",
    name: "Pub/Sub, Streams or sorted set?",
    kind: "Design review",
    skills: ["design"],
    w: "classify",
    gen(lv, R) { const it = R.shuffle(MSG_BANK.filter((x) => x[0] === lv || (lv > 1 && x[0] === lv - 1 && R.chance(0.35)))).slice(0, 4); if (it.length < 3) return null; return { lv, items: it.map((x) => x[1]), ans: it.map((x) => x[2]) }; },
    text: (I) => `<p>Your team uses Redis for messaging. For each use case pick the Redis structure that fits.</p>`,
    ui: (I) => ({ items: I.items, cats: MSG_CATS }),
    ans: (I) => I.ans,
    diag: (I, a) => { const i = a.findIndex((x, k) => x !== I.ans[k]); return `Reconsider: "${esc(I.items[i])}".`; },
    hint: (I) => I.lv === 1 ? "Pub/Sub delivers only to whoever is connected right now and keeps nothing." : I.lv === 2 ? "Consumer groups give you pending lists, acks and claiming; sorted sets give you 'due at time T'." : "A consumer group is for sharing work between consumers. A single reader that tracks its own position doesn't need one.",
    concept: "Pub/Sub vs Streams vs sorted-set queues",
    how: "Pub/Sub is fire-and-forget: messages go to currently connected subscribers and are never stored, so a disconnect means loss; ideal for ephemeral fan-out. Streams are an append-only log: consumer groups share entries among workers with a pending list, acknowledgements, delivery counts and XAUTOCLAIM for crashed consumers; a lone reader can simply XREAD from its last ID. A sorted set scored by due time (ZADD, then ZRANGEBYSCORE ... LIMIT and ZREM atomically) is the usual Redis delayed queue.",
    rule: "Ephemeral fan-out: Pub/Sub. Work that must be done: Stream with a consumer group. Work due later: sorted set by timestamp.",
    why: (I) => I.items.map((t, k) => `${esc(t.slice(0, 48))}… → <b>${MSG_CATS[I.ans[k]]}</b>`).join("; ") + ".",
  });

  const LAYER_CATS = ["CDN (shared edge)", "Redis app cache", "Browser only (private)", "Don't cache"];
  const LAYER_BANK = [
    [1, "Product images and JS/CSS bundles with content-hashed file names", 0],
    [1, "Public product listing JSON, identical for all anonymous visitors, refreshed every minute", 0],
    [1, "GET /api/me (the logged-in user's profile)", 2],
    [1, "Checkout total with the user's promo code applied", 3],
    [2, "Exchange rates from a metered third-party API, used by 12 internal services", 1],
    [2, "\"Recommended for you\" list computed by an expensive model, per user, valid for an hour", 1],
    [2, "Search results for popular anonymous queries", 0],
    [2, "Order history page with the customer's address", 2],
    [3, "Product page HTML that includes the logged-in user's name and cart count in the header", 1],
    [3, "Price API whose responses carry Vary: Cookie because of an analytics cookie", 1],
    [3, "Password-reset confirmation page", 3],
    [3, "Store-locator results by city, same for everyone, change weekly", 0],
  ];
  S.push({
    id: "redis-cdn-layers",
    name: "Which layer caches it?",
    kind: "Design review",
    skills: ["design"],
    w: "classify",
    gen(lv, R) { const it = R.shuffle(LAYER_BANK.filter((x) => x[0] === lv)).slice(0, 4); return { lv, items: it.map((x) => x[1]), ans: it.map((x) => x[2]) }; },
    text: (I) => `<p>You're planning caching for a storefront: a CDN in front, Redis behind the app, and browser caching via Cache-Control. Put each response or dataset in the layer that should cache it (the outermost layer that is safe and effective).${I.lv === 3 ? " Mind what a shared cache could leak, and what kills its hit ratio." : ""}</p>`,
    ui: (I) => ({ items: I.items, cats: LAYER_CATS }),
    ans: (I) => I.ans,
    diag: (I, a) => { const i = a.findIndex((x, k) => x !== I.ans[k]); return `Reconsider: "${esc(I.items[i])}".`; },
    hint: (I) => I.lv === 3 ? "A response that mixes shared content with per-user bits can't go to a shared cache as-is. And Vary: Cookie gives every visitor their own CDN entry." : "A CDN entry is shared by everyone who sends the same request. Private data must never land there.",
    concept: "Caching layers: CDN, application cache, browser",
    how: "The CDN is a shared cache keyed by URL (plus whatever Vary lists): perfect for public, identical responses and immutable assets, dangerous for anything personal (it will serve one user's data to another), and useless when Vary includes a per-visitor header like Cookie. An application cache in Redis sits behind authentication and can key by user, tier or fragment, and can hold data used by many services. Browser caching (Cache-Control: private) suits per-user responses the same user re-reads. Anything that must reflect the exact current state, or is a one-off sensitive page, shouldn't be cached.",
    rule: "Cache as far out as is safe: public → CDN; personalised or shared-between-services → Redis; per-user re-reads → browser private; exact or sensitive → no-store.",
    why: (I) => I.items.map((t, k) => `${esc(t.slice(0, 50))}… → <b>${LAYER_CATS[I.ans[k]]}</b>`).join("; ") + ".",
  });

  /* ================================================================
     NUM (3)
     ================================================================ */
  S.push({
    id: "redis-hit-ratio-load",
    name: "Estimate DB load from the hit ratio",
    kind: "Estimate",
    skills: ["estimate"],
    w: "num",
    gen(lv, R) {
      const I = { lv, rps: R.int(20, 90) * 1000 };
      if (lv === 1) I.h = R.pick([0.95, 0.97, 0.98]);
      if (lv === 2) { I.h1 = 0.99; I.h2 = R.pick([0.95, 0.96, 0.98]); }
      if (lv === 3) { I.hotShare = R.pick([0.8, 0.85, 0.9]); I.hHot = 0.995; I.hTail = R.pick([0.6, 0.7]); I.q = R.pick([2, 3]); }
      return I;
    },
    text: (I) => I.lv === 1 ? `<p>The product API serves <b>${K.num(I.rps)} reads/s</b> through a Redis cache with a <b>${K.pct(I.h, 0)}</b> hit ratio. Each miss runs one Postgres query. How many queries/s reach Postgres?</p>`
      : I.lv === 2 ? `<p>The cache hit ratio dropped from <b>99%</b> to <b>${K.pct(I.h2, 0)}</b> after a deploy changed key names. Traffic is unchanged (${K.num(I.rps)} reads/s). By what <b>factor</b> did database load from cache misses grow?</p>`
        : `<p>${K.num(I.rps)} reads/s: ${K.pct(I.hotShare, 0)} go to a hot set with a ${K.pct(I.hHot, 1)} hit ratio; the rest go to a long tail with a ${K.pct(I.hTail, 0)} hit ratio. Each miss runs <b>${I.q} queries</b>. How many DB queries/s?</p>`,
    ui: (I) => ({ unit: I.lv === 2 ? "×" : "queries/s" }),
    accept: LB.near((I) => I.lv === 1 ? I.rps * (1 - I.h) : I.lv === 2 ? (1 - I.h2) / 0.01 : I.rps * (I.hotShare * (1 - I.hHot) + (1 - I.hotShare) * (1 - I.hTail)) * I.q, 0.1),
    solve: (I) => Math.round(I.lv === 1 ? I.rps * (1 - I.h) : I.lv === 2 ? (1 - I.h2) / 0.01 : I.rps * (I.hotShare * (1 - I.hHot) + (1 - I.hotShare) * (1 - I.hTail)) * I.q),
    bad: (I) => I.lv === 1 ? [I.rps * I.h] : I.lv === 2 ? [Math.round((0.99 - I.h2) * 100)] : [Math.round(I.rps * (1 - (I.hotShare * I.hHot + (1 - I.hotShare) * I.hTail)))],
    hint: (I) => I.lv === 2 ? "Compare miss ratios, not hit ratios." : "DB load comes from misses: traffic × (1 − hit ratio)" + (I.lv === 3 ? ", per segment, times queries per miss." : "."),
    concept: "Hit ratio → backend load",
    how: "The database sees traffic × miss ratio (× queries per miss). Because load depends on the miss ratio, small changes in hit ratio near 100% are large in relative terms: going from 99% to 95% is a 5× increase in misses. Averages across segments hide this: a long tail with a modest hit ratio can dominate database load even if it's a small share of traffic.",
    rule: "Reason about miss ratio, not hit ratio, and break it down by segment; alert on miss rate × traffic, which is what the database feels.",
    why: (I, sol) => I.lv === 1 ? `${K.num(I.rps)} × ${K.pct(1 - I.h, 0)} = <b>${K.num(sol)}</b> queries/s.` : I.lv === 2 ? `Miss ratio went from 1% to ${K.pct(1 - I.h2, 0)}: <b>${sol}×</b> the database load, from a hit ratio that only fell ${Math.round((0.99 - I.h2) * 100)} points.` : `Hot: ${K.num(I.rps * I.hotShare)} × ${K.pct(1 - I.hHot, 1)}; tail: ${K.num(I.rps * (1 - I.hotShare))} × ${K.pct(1 - I.hTail, 0)}; × ${I.q} queries = <b>${K.num(sol)}</b>/s. The tail is almost all of it.`,
  });

  S.push({
    id: "redis-pipeline-latency",
    name: "Estimate the pipelining win",
    kind: "Estimate",
    skills: ["estimate"],
    w: "num",
    gen(lv, R) { return { lv, n: lv === 3 ? R.pick([600, 900, 1200]) : R.pick([500, 1000, 2000]), rtt: lv === 3 ? R.pick([0.8, 1.0, 1.2]) : R.pick([0.3, 0.5, 0.8]), us: 4, batch: R.pick([50, 100, 200]), shards: 3 }; },
    text: (I) => I.lv === 1 ? `<p>A request handler loops over <b>${K.num(I.n)}</b> keys calling <code>GET</code> one at a time. Network round-trip to Redis is <b>${I.rtt} ms</b>; Redis spends ~${I.us} µs per GET. Roughly how many milliseconds does the loop take?</p>`
      : I.lv === 2 ? `<p>Same handler (${K.num(I.n)} GETs, RTT ${I.rtt} ms, ~${I.us} µs server time each), rewritten to <b>pipeline in batches of ${I.batch}</b> (send a batch, read all replies, send the next). Roughly how many ms now?</p>`
        : `<p>The service moved to a <b>${I.shards}-shard Redis Cluster</b> (cross-AZ RTT <b>${I.rtt} ms</b>). The client groups the ${K.num(I.n)} keys by node, then pipelines to the ${I.shards} nodes <b>in parallel</b>, in batches of ${I.batch} per node. Keys spread evenly; ~${I.us} µs server time each. Roughly how many ms?</p>`,
    ui: () => ({ unit: "ms" }),
    accept: LB.near((I) => I.lv === 1 ? I.n * (I.rtt + I.us / 1000) : I.lv === 2 ? Math.ceil(I.n / I.batch) * I.rtt + I.n * I.us / 1000 : Math.ceil(I.n / I.shards / I.batch) * I.rtt + (I.n / I.shards) * I.us / 1000, 0.3),
    solve: (I) => K.round(I.lv === 1 ? I.n * (I.rtt + I.us / 1000) : I.lv === 2 ? Math.ceil(I.n / I.batch) * I.rtt + I.n * I.us / 1000 : Math.ceil(I.n / I.shards / I.batch) * I.rtt + (I.n / I.shards) * I.us / 1000, 1),
    bad: (I) => I.lv === 1 ? [I.n * I.us / 1000] : I.lv === 2 ? [I.n * I.rtt] : [Math.ceil(I.n / I.batch) * I.rtt * I.shards + I.n * I.us / 1000],
    hint: (I) => I.lv === 1 ? "Each GET waits a full round trip." : I.lv === 2 ? "One round trip per batch, plus the server's work for every command." : "Each node gets a third of the keys, and the nodes work at the same time.",
    concept: "Round trips dominate: pipelining and fan-out",
    how: "For small commands, Redis does microseconds of work while the network round trip costs hundreds of microseconds to milliseconds, so N sequential commands cost about N × RTT. Pipelining sends many commands before reading replies, paying one round trip per batch; server time then becomes visible. In Redis Cluster, multi-key commands only work within a slot, so clients group keys by node and pipeline to the nodes in parallel; total time is the slowest node's batches.",
    rule: "Count round trips: batch with pipelining or MGET/MSET (within a slot), and fan out to shards in parallel.",
    why: (I, sol) => I.lv === 1 ? `${K.num(I.n)} × (${I.rtt} ms + ${I.us} µs) ≈ <b>${K.num(sol)} ms</b>, almost all waiting on the network.` : I.lv === 2 ? `${Math.ceil(I.n / I.batch)} round trips × ${I.rtt} ms + ${K.num(I.n)} × ${I.us} µs ≈ <b>${K.num(sol, 1)} ms</b> (vs ~${K.num(I.n * I.rtt)} ms).` : `Each node handles ~${Math.round(I.n / I.shards)} keys: ${Math.ceil(I.n / I.shards / I.batch)} batches × ${I.rtt} ms + server time ≈ <b>${K.num(sol, 1)} ms</b>, in parallel across nodes.`,
  });

  S.push({
    id: "redis-hll-error",
    name: "How wrong is the HyperLogLog?",
    kind: "Estimate",
    skills: ["estimate"],
    w: "num",
    gen(lv, R) { return { lv, n: R.int(15, 60) * 100000, days: 30, a: R.int(80, 120) * 100000, b: 0 }; },
    text: (I) => I.lv === 1 ? `<p>Daily unique visitors are counted with <code>PFADD</code>/<code>PFCOUNT</code> (Redis HyperLogLog: 12 KB, standard error 0.81%). Today's count is <b>${K.num(I.n)}</b>. What is the typical (1σ) error, in visitors?</p>`
      : I.lv === 2 ? `<p>Monthly uniques are computed with <code>PFMERGE</code> over ${I.days} daily HLLs; the merged count is <b>${K.num(I.a)}</b>. A PM asks how much the merge "adds up" the error from 30 sketches. What is the typical (1σ) error of the monthly count, in visitors?</p>`
        : `<p>To count visitors who came <b>only on web</b>, an analyst computes <code>PFCOUNT web+app (merged)</code> − <code>PFCOUNT app</code> = ${K.num(I.a)} − ${K.num(Math.round(I.a * 0.96))} = ${K.num(I.a - Math.round(I.a * 0.96))}. Treating the two counts' errors (0.81% each) as independent, what is the 1σ error of that difference, in visitors?</p>`,
    ui: () => ({ unit: "visitors" }),
    accept: LB.near((I) => I.lv === 1 ? I.n * 0.0081 : I.lv === 2 ? I.a * 0.0081 : Math.hypot(I.a * 0.0081, Math.round(I.a * 0.96) * 0.0081), 0.15),
    solve: (I) => Math.round(I.lv === 1 ? I.n * 0.0081 : I.lv === 2 ? I.a * 0.0081 : Math.hypot(I.a * 0.0081, Math.round(I.a * 0.96) * 0.0081)),
    bad: (I) => I.lv === 1 ? [Math.round(I.n * 0.081)] : I.lv === 2 ? [Math.round(I.a * 0.0081 * 30)] : [Math.round((I.a - Math.round(I.a * 0.96)) * 0.0081)],
    hint: (I) => I.lv === 1 ? "The error is relative to the count." : I.lv === 2 ? "A merged HLL is just another HLL of the union." : "Errors of a difference add in quadrature, and they scale with the big counts, not the small difference.",
    concept: "HyperLogLog accuracy",
    how: "Redis's HyperLogLog uses 16,384 registers in 12 KB to estimate cardinality with a standard error of 0.81%, regardless of size. PFMERGE produces the HLL of the union, with the same relative error, so merging doesn't compound error. But derived quantities can be terrible: a difference of two large counts carries the absolute errors of both (≈ 0.81% of each, combined in quadrature), which may be a large fraction of a small difference. For intersections and differences, use exact sets or dedicated sketches.",
    rule: "Use HLL for unions and totals (≈ ±0.8%), never for small differences or intersections of large sets.",
    why: (I, sol) => I.lv === 1 ? `0.81% of ${K.num(I.n)} ≈ <b>${K.num(sol)}</b> visitors.` : I.lv === 2 ? `The merged HLL estimates the union with the same 0.81%: ≈ <b>${K.num(sol)}</b>, not 30× anything.` : `√((0.81% × ${K.num(I.a)})² + (0.81% × ${K.num(Math.round(I.a * 0.96))})²) ≈ <b>${K.num(sol)}</b>, about ${K.pct(sol / (I.a - Math.round(I.a * 0.96)), 0)} of the ${K.num(I.a - Math.round(I.a * 0.96))} being measured.`,
  });

  /* ================================================================
     CHOICE (2)
     ================================================================ */
  const LOCKQ = {
    1: { story: (I) => `A cron job that rebuilds the sitemap (${I.mins} minutes of CPU) runs on all ${I.n} pods; it should only run on one. If it occasionally runs twice, the only cost is wasted CPU.`, opts: ["A single Redis SET NX PX lock with a TTL longer than the job", "Redlock across 5 Redis nodes", "A ZooKeeper/etcd lease with fencing tokens checked by storage", "No lock: let every pod run it"], ans: 0, why: "It's an efficiency lock: a rare double run is harmless, so one Redis SET NX PX is the simplest thing that works." },
    2: { story: (I) => `Settlement for each merchant must never run twice concurrently, or merchants get paid twice. The settlement writes to Postgres, where the payout rows live. ${I.n} workers pick merchants from a queue.`, opts: ["Enforce it in Postgres: a transaction with SELECT … FOR UPDATE on the merchant row (or a unique constraint per payout period)", "A Redis SET NX PX lock per merchant", "Redlock across 5 Redis nodes", "A Redis lock plus a longer TTL"], ans: 0, why: "Correctness matters and the protected data is in Postgres, so the database's own locking or constraints give a guarantee that can't expire mid-transaction; a Redis lock can expire during a pause." },
    3: { story: (I) => `A teammate proposes Redlock (5 nodes) to guard writes of ledger files to an object store that supports conditional writes on a version number. JVM GC pauses of ${I.gc} s have been seen. Double writes would corrupt balances.`, opts: ["A lease from a consensus store (etcd/ZooKeeper) and a fencing token, with the object store's conditional write rejecting older tokens", "Redlock as proposed: majority voting makes it safe", "Redlock with a TTL longer than the longest GC pause", "A single Redis lock with a Lua compare-and-delete release"], ans: 0, why: "No TTL-based lock survives an arbitrary pause by itself; Redlock also depends on bounded clock drift and nodes not losing keys. The guarantee must come from the storage rejecting stale writers: a monotonically increasing fencing token checked by the conditional write." },
  };
  S.push({
    id: "redis-lock-decision",
    name: "Is a Redis lock enough?",
    kind: "Decision",
    skills: ["design"],
    w: "choice",
    gen(lv, R) { const Q = LOCKQ[lv]; const opts = R.shuffle(Q.opts.slice()); return { lv, opts, ans: Q.opts[Q.ans], n: R.int(4, 24), mins: R.int(3, 12), gc: R.int(8, 25) }; },
    text: (I) => `<p>${LOCKQ[I.lv].story(I)}</p><p>What should guard it?</p>`,
    ui: (I) => ({ opts: I.opts }),
    ans: (I) => I.ans,
    hint: (I) => I.lv === 1 ? "What actually goes wrong if the guard fails once?" : "Where does the data live, and can the guard expire while the work is still running?",
    concept: "Efficiency locks vs correctness locks",
    how: "Locks serve two different purposes. Efficiency locks avoid duplicate work; occasional failure is harmless, so a single Redis SET NX PX is ideal. Correctness locks prevent corruption; any TTL-based lock can expire while its holder is paused, and Redlock adds assumptions about clocks and node persistence. For correctness, make the resource itself enforce exclusion: database row locks or constraints when the data is in a database, or fencing tokens from a consensus system checked by the storage.",
    rule: "Ask what happens if the lock fails once. If the answer is 'some wasted work', use Redis. If it's 'corrupt data', enforce it where the data lives.",
    why: (I) => LOCKQ[I.lv].why,
  });

  const LAGQ = {
    1: { story: (I) => `Users update their display name, the page reloads, and ${I.pct}% of the time they see the old name. Reads go to a Redis replica; INFO replication shows lag of 50–400 ms. Writes are rare (a few per user per day).`, opts: ["Read a user's own profile from the primary for a few seconds after they write it", "Use WAIT 1 0 on every read", "Add a second replica", "Lower the cache TTL to 1 second"], ans: 0, why: "Read-your-writes: route the writer's own reads to the primary for a short window after a write; everyone else can keep reading from replicas." },
    2: { story: (I) => `Replicas normally lag < 10 ms, but during nightly full resyncs one replica serves reads ${I.sec} s behind (its master_last_io_seconds_ago grows, and slave_repl_offset falls far behind the primary's master_repl_offset). Users see orders "disappear" for half a minute.`, opts: ["Take a replica out of the read pool when its lag exceeds a threshold (compare offsets, or set replica-serve-stale-data no)", "Always read from the primary", "Increase repl-backlog-size", "Use WAIT on writes"], ans: 0, why: "Lag is only bad on one replica at a time: route around replicas whose lag (offset difference or link status) exceeds a budget, or stop them serving stale data during sync." },
    3: { story: (I) => `The product cache (Redis, TTL 1 h) is filled on misses by reading Postgres <b>read replicas</b>. Price updates write the primary, then DEL the cache key. About ${I.pct}% of price changes show the old price for an hour.`, opts: ["Fill the cache from the primary (or after the replica has applied the change, e.g. invalidate from CDC on the replica)", "Lower the TTL to 1 minute", "Read the cache from a Redis replica", "Use WAIT on the DEL"], ans: 0, why: "After the DEL, a miss reads a Postgres replica that hasn't applied the update yet and re-caches the old price for the whole TTL. Fill from the primary, or invalidate only after replicas have the change (CDC)." },
  };
  S.push({
    id: "redis-replica-lag-reads",
    name: "Stale reads from replicas",
    kind: "Decision",
    skills: ["design", "diagnose"],
    w: "choice",
    gen(lv, R) { const Q = LAGQ[lv]; return { lv, opts: R.shuffle(Q.opts.slice()), ans: Q.opts[Q.ans], pct: R.int(2, 9), sec: R.int(20, 45) }; },
    text: (I) => `<p>${LAGQ[I.lv].story(I)}</p><p>Which change fixes it at the source?</p>`,
    ui: (I) => ({ opts: I.opts }),
    ans: (I) => I.ans,
    hint: (I) => I.lv === 1 ? "Who needs fresh data: everyone, or the person who just wrote?" : I.lv === 2 ? "The lag isn't everywhere all the time." : "Where does the stale value come from before it gets cached?",
    concept: "Replica lag and read consistency",
    how: "Asynchronous replicas trail the primary by milliseconds normally and by seconds or more during resyncs or load. Reading from them is eventually consistent: a user can miss their own write, and a cache filled from a replica can capture an old value and keep serving it for the whole TTL. Fixes target where freshness matters: read-your-writes routing after a write, excluding lagging replicas using replication offsets, and filling caches from the primary or invalidating after replication (CDC).",
    rule: "Decide per read whether it can be stale. Route the writer's own reads to the primary, drop lagging replicas from rotation, and never fill a long-lived cache from a source that may be behind.",
    why: (I) => LAGQ[I.lv].why,
  });

  LB.addAll("redis", S);
  void stepsSpec; void firstBreaking; void MB;
})();
