/* Systems Lab · System design, part 2. Uses the launch-day simulator helpers that c-sd.js publishes on LB.sdKit.
   This file may load before c-sd.js, so helpers are looked up when called, never at load time. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const SD = (LB.sdKit = LB.sdKit || {});
  const call = (n) => (...a) => SD[n](...a);
  const M = call("M"), mo = call("mo"), pc = call("pc"), nines = call("nines"), tier = call("tier"), day = call("day"), runDay = call("runDay"), dayChart = call("dayChart");
  const APPS = ["Pinwheel", "Quokka", "Driftwood", "Lumen", "Tidepool", "Bramble", "Marmot", "Juniper", "Kestrel", "Otterly"];
  const need = (x) => Math.ceil(x - 1e-9);

  /* ---------- idempotent charge: tiny interleaving model ---------- */
  const IDEM = {
    1: [
      { name: "Request A (original)", steps: ["SELECT response FROM idem_keys WHERE key = $k", "psp.charge(card, $amt)", "INSERT INTO idem_keys (key, response) VALUES ($k, ...)", "return 201"], ops: ["check", "charge", "insert", "ret"] },
      { name: "Request B (client retry, same key)", steps: ["SELECT response FROM idem_keys WHERE key = $k", "psp.charge(card, $amt)", "INSERT INTO idem_keys (key, response) VALUES ($k, ...)", "return 201"], ops: ["check", "charge", "insert", "ret"] },
    ],
    2: [
      { name: "Request A (original)", steps: ["INSERT INTO idem_keys (key, status) VALUES ($k, 'pending') ON CONFLICT DO NOTHING", "psp.charge(card, $amt)  -- succeeds, but the response times out", "on timeout: DELETE FROM idem_keys WHERE key = $k  -- so the client can retry", "return 504"], ops: ["setnx", "charge", "del", "ret"] },
      { name: "Request B (client retry, same key)", steps: ["INSERT INTO idem_keys (key, status) VALUES ($k, 'pending') ON CONFLICT DO NOTHING", "psp.charge(card, $amt)", "UPDATE idem_keys SET status = 'done', response = ... WHERE key = $k", "return 201"], ops: ["setnx", "charge", "done", "ret"] },
    ],
    3: [
      { name: "Request A (original)", steps: ["SET idem:$k pending NX EX 30", "psp.charge(card, $amt)  -- takes 45 s under launch load", "SET idem:$k done", "return 201"], ops: ["setnx", "charge", "done", "ret"] },
      { name: "Request B (client retry, same key)", steps: ["SET idem:$k pending NX EX 30", "psp.charge(card, $amt)", "SET idem:$k done", "return 201"], ops: ["setnx", "charge", "done", "ret"] },
      { name: "Clock", steps: ["30 s pass: the key idem:$k expires"], ops: ["expire"] },
    ],
  };
  const idemLanes = (I) => IDEM[I.lv].map((l) => ({ ...l, steps: l.steps.map((s) => s.replace(/\$k/g, `'${I.key}'`).replace(/\$amt/g, "$" + I.amt)) }));
  function idemRun(I, seq) {
    const L = idemLanes(I), st = { present: false, charges: 0 }, go = L.map(() => true), pos = L.map(() => 0), log = [];
    for (const l of seq || []) {
      const i = pos[l]++, op = L[l].ops[i], label = L[l].steps[i];
      let note = "";
      if (op === "expire") { st.present = false; note = "key gone"; }
      else if (!go[l]) note = "skipped: request already answered";
      else if (op === "check") { if (st.present) { go[l] = false; note = "row found: return the stored response"; } else note = "no row"; }
      else if (op === "setnx") { if (st.present) { go[l] = false; note = I.lv === 3 ? "(nil): key exists → 409 Conflict" : "0 rows: key exists → 409 Conflict"; } else { st.present = true; note = I.lv === 3 ? "OK" : "1 row: we own the key"; } }
      else if (op === "charge") { st.charges++; note = `card charged (charge #${st.charges})`; }
      else if (op === "insert") { if (st.present) note = "ERROR: duplicate key value violates unique constraint (the charge already happened)"; else { st.present = true; note = "row stored"; } }
      else if (op === "del") { st.present = false; note = "key deleted"; }
      else if (op === "done") { st.present = true; note = "stored"; }
      log.push({ l, label, note, bad: /charge #[2-9]/.test(note) });
    }
    return { ...st, log, complete: (seq || []).length === L.reduce((s, x) => s + x.steps.length, 0) };
  }
  const idemHTML = (I, seq) => { const L = idemLanes(I), r = idemRun(I, seq); return K.table(["#", ...L.map((l) => esc(l.name))], r.log.map((e, k) => [String(k + 1), ...L.map((_, j) => (j === e.l ? `<span class="mono">${esc(e.label)}</span><br><small class="${e.bad ? "lose" : "muted"}">${esc(e.note)}</small>` : ""))]), { compact: true }) + (r.complete ? K.verdict(r.charges >= 2, `customer charged ${r.charges}×`) : ""); };

  /* ---------- flash sale ---------- */
  function fsSim(I, cfg) {
    const ap = cfg.ap, room = cfg.room === "off" ? 0 : cfg.room;
    const thr = ap === "conditional UPDATE, one row" ? 1000 / I.lock : ap === "bucket rows" ? (1000 / I.lock) * cfg.buckets * 0.8 : ap === "Redis DECR + order queue" ? 50000 : Infinity;
    const admitted = room ? Math.min(room, I.peak) : I.peak, util = admitted / thr;
    const sellout = I.units / (Math.min(admitted, thr * 0.8) * 0.7);
    const cost = (room ? I.roomPrice : 0) + (ap === "Redis DECR + order queue" ? I.redisPrice : 0);
    let fail = null, lost = 0, unsold = 0;
    if (ap === "read, check, write") fail = "two buyers read stock = 1 and both write 0: the last units are sold twice (oversell)";
    else if (util > 0.8) fail = `inventory handles ~${K.num(thr)} decrements/s but ${K.num(admitted)}/s arrive: ${pc(1 - (0.8 * thr) / admitted)} of checkouts time out on the hot row(s)`;
    else if (sellout > I.maxSell) fail = `admitting ${K.num(admitted)} buyers/s, the sale takes ${K.num(sellout)} s to sell out (limit ${I.maxSell} s); people sit in the queue far too long`;
    if (!fail && I.lv === 3) {
      lost = { 2: 0.25, 10: 0.04, 30: 0.01 }[cfg.ttl]; unsold = I.abandon ** Math.floor(60 / cfg.ttl);
      if (lost > 0.05) fail = `${pc(lost)} of paying buyers (3-D Secure, bank apps) lose their reservation before paying`;
      else if (unsold > 0.02) fail = `abandoned carts recycle only every ${cfg.ttl} min, so ${pc(unsold)} of units are still unsold when the 60-minute sale ends`;
    }
    return { thr, admitted, util, sellout, cost, fail, lost, unsold };
  }
  function fsHTML(I, cfg) {
    const r = fsSim(I, cfg);
    return K.metrics([
      { name: "Inventory throughput", value: Number.isFinite(r.thr) ? K.num(r.thr) + "/s" : "unbounded", ok: null },
      { name: "Admitted buyers", value: K.num(r.admitted) + "/s", ok: r.util <= 0.8, target: Number.isFinite(r.thr) ? `≤ 80% of throughput` : "" },
      { name: "Sell-out time", value: Number.isFinite(r.sellout) ? K.num(r.sellout) + " s" : "–", ok: r.sellout <= I.maxSell, target: `≤ ${I.maxSell} s` },
      { name: "Oversold units", value: cfg.ap === "read, check, write" ? "yes" : "0", ok: cfg.ap !== "read, check, write" },
      ...(I.lv === 3 ? [{ name: "Unsold at close", value: pc(r.unsold), ok: r.unsold <= 0.02, target: "≤ 2%" }, { name: "Payers timed out", value: pc(r.lost), ok: r.lost <= 0.05, target: "≤ 5%" }] : []),
      { name: "Extra cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* ---------- live video CDN ---------- */
  function cdnSim(I, cfg) {
    const shield = I.lv > 1 && cfg.shield === "on", collapse = cfg.collapse === "on", seg = I.lv === 1 ? 6 : cfg.seg;
    const edges = shield ? I.shields : I.pops, requesters = shield ? I.pops / I.shields : I.viewers / (I.pops * I.rend);
    const perSeg = collapse ? 1 : 1 + requesters * Math.min(1, 0.25 / seg);
    const rps = (edges * I.rend * (2 + perSeg)) / seg;
    const latency = 3 * seg + 1 + (shield ? 0.3 : 0);
    const gbps = (edges * I.ladder * perSeg) / 1000; // each edge pulls every rendition once per segment period (more without collapsing)
    const util = Math.max(rps / (cfg.servers * I.cap), gbps / cfg.servers);
    const cost = cfg.servers * I.price + (shield ? I.shieldPrice : 0);
    let fail = null;
    if (latency > I.lat) fail = `glass-to-glass latency is ~${K.num(latency, 1)} s (target ${I.lat} s): players buffer about three segments`;
    else if (util > 0.75) fail = `origin gets ${K.num(rps)} req/s and serves ${K.num(gbps, 1)} Gbps: ${pc(util)} of ${cfg.servers} server(s)`;
    return { rps, gbps, latency, util, cost, fail, seg };
  }
  function cdnHTML(I, cfg) {
    const r = cdnSim(I, cfg);
    return K.metrics([
      { name: "Origin requests", value: K.num(r.rps) + "/s", ok: r.rps <= 0.75 * cfg.servers * I.cap, target: `≤ ${K.num(0.75 * cfg.servers * I.cap)}/s` },
      { name: "Origin egress", value: K.num(r.gbps, 2) + " Gbps", ok: r.gbps <= 0.75 * cfg.servers, target: `≤ ${K.num(0.75 * cfg.servers, 2)} Gbps` },
      { name: "Glass-to-glass", value: K.num(r.latency, 1) + " s", ok: r.latency <= I.lat, target: `≤ ${I.lat} s` },
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* ---------- metrics cardinality ---------- */
  function cardSeries(I, sel) {
    let p = 1, buckets = I.buckets;
    sel.forEach((i) => { const l = I.labels[i]; if (l.buckets) buckets = l.buckets; else p *= l.c; });
    return Math.round(I.fill * p * (buckets + 2));
  }
  function cardCheck(I, sel) {
    const has = (id) => sel.some((i) => I.labels[i].id === id);
    if (!has("route")) return "the latency SLO dashboards are per route: keep the templated route label";
    if (!has("code") && !has("class")) return "the 5xx-ratio alert needs a status label";
    if (I.lv > 1 && !has("region")) return "the per-region SLO needs the region label";
    const s = cardSeries(I, sel);
    if (s > I.budget) return `${K.num(s)} active series exceed the budget of ${K.num(I.budget)}`;
    return true;
  }
  const cardVal = (I, sel) => sel.reduce((s, i) => s + I.labels[i].w, 0);

  /* ---------- job scheduler ---------- */
  function jobSim(I, cfg) {
    const slots = cfg.workers * 4, drain = slots / I.avg, jitter = cfg.jitter * 60;
    const lateness = Math.max(jitter, I.jobs / drain);
    // at :00 every free slot grabs a job at once, so without jitter the first-second burst is the slot count
    const burst = jitter ? Math.min(slots, I.jobs / jitter) : slots;
    const lease = { "30 s": 30, "2 min": 120, "10 min": 600, "2 min + heartbeat": 120 }[cfg.lease], hb = cfg.lease === "2 min + heartbeat";
    const dup = !hb && lease < I.p99run;
    let fail = null;
    if (lateness > I.sla * 60) fail = `the last job starts ${K.num(lateness / 60, 1)} min after its scheduled time (limit ${I.sla} min)`;
    else if (burst > I.api) fail = `jobs hit the billing API at up to ${K.num(burst)} calls/s (limit ${K.num(I.api)}/s)`;
    else if (dup) fail = `a ${cfg.lease} lease expires while a slow job (p99 ${K.num(I.p99run / 60, 1)} min) is still running, so another worker runs it again`;
    else if (I.lv === 3 && lease > I.recover * 60) fail = `jobs on a crashed worker wait for the ${cfg.lease} lease to expire before anyone retries them (limit ${I.recover} min)`;
    return { slots, lateness, burst, cost: cfg.workers * I.price, fail };
  }
  function jobHTML(I, cfg) {
    const r = jobSim(I, cfg);
    return K.metrics([
      { name: "Worst start delay", value: K.num(r.lateness / 60, 1) + " min", ok: r.lateness <= I.sla * 60, target: `≤ ${I.sla} min` },
      { name: "Billing API burst", value: K.num(r.burst) + "/s", ok: r.burst <= I.api, target: `≤ ${K.num(I.api)}/s` },
      { name: "Concurrent slots", value: String(r.slots), ok: null },
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* ---------- multi-region ---------- */
  const REG = ["NA", "EU", "APAC"];
  function mrSim(I, cfg) {
    const t = cfg.topo, rep = I.lv === 3 ? cfg.repl : "async to another region";
    const rtt = I.rtt, read = [], write = [];
    REG.forEach((r, i) => {
      const local = 10;
      if (t === "single region (NA)") { read.push(rtt[i][0]); write.push(rtt[i][0]); }
      else if (t === "NA primary + read replicas everywhere") { read.push(local); write.push(rtt[i][0]); }
      else if (t === "active-passive (EU standby)") { read.push(rtt[i][0]); write.push(rtt[i][0]); }
      else { read.push(local); write.push(local); }
    });
    const syncAdd = rep === "sync to a nearby region (same jurisdiction)" ? 15 : rep === "sync to the farthest region" ? 150 : 0;
    const w = write.map((x) => x + syncAdd + 5), rd = read.map((x) => x + 5);
    const rpo = rep === "async to another region" ? (t === "single region (NA)" ? 3600 : 5) : 0;
    let fail = null;
    const worstRead = Math.max(...rd);
    if (worstRead > I.readSlo) fail = `${REG[rd.indexOf(worstRead)]} users wait ${worstRead} ms for reads (target ${I.readSlo} ms)`;
    else if (I.euWrite && w[1] > I.euWrite) fail = `EU writes take ${w[1]} ms (target ${I.euWrite} ms)`;
    else if (I.noLost && t === "active-active, multi-primary (last-writer-wins)") fail = "two regions accept concurrent updates to the same balance and last-writer-wins silently drops one";
    else if (rpo > I.rpo) fail = `losing a region loses up to ${rpo >= 3600 ? "1 h (last backup)" : rpo + " s"} of writes (RPO ${I.rpo ? I.rpo + " s" : "0"})`;
    else if (I.resid && t !== "home region per user") fail = "EU customers' personal data would be stored outside the EU";
    else if (I.resid && rep === "sync to the farthest region") fail = "the farthest replica of EU data sits outside the EU";
    return { rd, w, rpo, cost: I.cost[t] + (rep !== "async to another region" ? I.syncCost : 0), fail };
  }
  function mrHTML(I, cfg) {
    const r = mrSim(I, cfg);
    return K.table(["Users", "Share", "Read p95", "Write p95"], REG.map((g, i) => [g, pc(I.share[i]), `<span class="${r.rd[i] > I.readSlo ? "lose" : ""}">${r.rd[i]} ms</span>`, `<span class="${i === 1 && I.euWrite && r.w[i] > I.euWrite ? "lose" : ""}">${r.w[i]} ms</span>`]), { compact: true })
      + K.metrics([{ name: "RPO on region loss", value: r.rpo >= 3600 ? "1 h" : r.rpo + " s", ok: r.rpo <= I.rpo, target: `≤ ${I.rpo} s` }, { name: "Monthly cost", value: mo(r.cost), ok: null }]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* ---------- shard key ---------- */
  function skSim(I, cfg) {
    const n = cfg.n, T = I.ops, W = T * I.wr, Rd = T - W, list = Rd * I.listF, k = cfg.key;
    const loads = Array(n).fill(0);
    let scatter = 0;
    if (k === "created_at (range)") { for (let i = 0; i < n; i++) loads[i] = (0.3 * Rd) / n; loads[n - 1] += W + 0.7 * Rd; }
    else if (k === "order_id (hash)") { for (let i = 0; i < n; i++) loads[i] = (T - list) / n + list * 0.3; scatter = list / T; }
    else {
      const ws = I.whales.reduce((s, w) => s + w, 0);
      for (let i = 0; i < n; i++) loads[i] = ((1 - ws) * T) / n;
      I.whales.forEach((w, j) => {
        if (k === "tenant_id (hash)") loads[(j * 3) % n] += w * T;
        else { const m = Math.min(8, n); for (let q = 0; q < m; q++) loads[(j * 3 + q) % n] += (w * T) / m; scatter += (w * list) / T; }
      });
    }
    const max = Math.max(...loads);
    let fail = null;
    if (max > 0.7 * I.cap) fail = `the hottest shard gets ${K.num(max)} ops/s (keep under ${K.num(0.7 * I.cap)})`;
    else if (scatter > I.scatterMax + 1e-9) fail = `${pc(scatter)} of queries must fan out to many shards (limit ${pc(I.scatterMax)})`;
    return { loads, max, scatter, fail };
  }
  function skHTML(I, cfg) {
    const r = skSim(I, cfg);
    return K.bars(r.loads.map((v, i) => ({ label: "shard " + i, value: v, max: I.cap, cls: v > 0.7 * I.cap ? "bad" : v > 0.5 * I.cap ? "hot" : "good", note: K.num(v) + "/s" })), { max: I.cap })
      + K.metrics([{ name: "Hottest shard", value: pc(r.max / I.cap), ok: r.max <= 0.7 * I.cap, target: "≤ 70%" }, { name: "Scatter-gather queries", value: pc(r.scatter), ok: r.scatter <= I.scatterMax + 1e-9, target: `≤ ${pc(I.scatterMax)}` }])
      + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* ---------- hot shard terminal ---------- */
  function hsInit(I) {
    const shards = I.base.map((b, i) => ({ id: "s" + (i + 1), node: "kv-" + (11 + i), base: b, keys: {} }));
    I.hot.forEach((h) => { shards[h.s].keys[h.key] = { r: h.r, w: h.w, counter: !!h.counter }; });
    return { shards, cached: {}, split: {}, cap: 100000 };
  }
  function hsLoad(st) {
    const L = st.shards.map((s) => s.base);
    st.shards.forEach((s, i) => Object.entries(s.keys).forEach(([k, v]) => {
      const rf = st.cached[k] ? 0.02 : 1, n = st.split[k] || 1;
      for (let b = 0; b < n; b++) L[(i + b) % L.length] += v.r * rf + v.w / n;
    }));
    return L;
  }
  const hsCpu = (st) => hsLoad(st).map((l) => l / st.cap);
  function hsShell(I) {
    const findShard = (st, id) => st.shards.find((s) => s.id === id);
    const keyShard = (st, key) => st.shards.find((s) => s.keys[key]);
    const sh = K.shell([
      { re: /^shardctl status$/, use: "shardctl status", desc: "shard load per node", run: (m, st) => { const L = hsLoad(st); return K.cols([["SHARD", "NODE", "KEYS", "OPS/S", "CPU"], ...st.shards.map((s, i) => [s.id, s.node, M(I.keys[i] || 4e6), K.num(L[i]), Math.round((L[i] / st.cap) * 100) + "%"])]); } },
      { re: /^shardctl top-keys (s\d+)$/, use: "shardctl top-keys <shard>", desc: "hottest keys on a shard", run: (m, st) => { const s = findShard(st, m[1]); if (!s) return `error: no shard ${m[1]}`; const rows = Object.entries(s.keys).map(([k, v]) => [k, K.num(v.r * (st.cached[k] ? 0.02 : 1)), K.num(v.w), st.cached[k] ? "cached" : st.split[k] ? `split ×${st.split[k]}` : ""]); const other = [`(other keys: ${M(I.keys[+m[1].slice(1) - 1] || 4e6)})`, K.num(s.base * 0.8), K.num(s.base * 0.2), "max 40/s per key"]; return K.cols([["KEY", "READS/S", "WRITES/S", "NOTE"], ...rows, other]); } },
      { re: /^shardctl split (s\d+)$/, use: "shardctl split <shard>", desc: "split a shard's key range in two (new shard on a new node)", run: (m, st) => { const s = findShard(st, m[1]); if (!s) return `error: no shard ${m[1]}`; const ns = { id: "s" + (st.shards.length + 1), node: "kv-" + (11 + st.shards.length), base: s.base / 2, keys: {} }; s.base /= 2; st.shards.push(ns); I.keys.push(I.keys[+m[1].slice(1) - 1] / 2 || 2e6); const hk = Object.keys(s.keys); return `split ${s.id} at its median key: ${s.id} [lo, mid) stays on ${s.node}, ${ns.id} [mid, hi) on ${ns.node}\nbackfill complete in 4m12s${hk.length ? `\nnote: ${hk.join(", ")} stayed on ${s.id}` : ""}`; } },
      { re: /^shardctl move (s\d+) (kv-\d+)$/, use: "shardctl move <shard> <node>", desc: "move a shard to another node", run: (m, st) => { const s = findShard(st, m[1]); if (!s) return `error: no shard ${m[1]}`; const cpu = hsCpu(st)[st.shards.indexOf(s)]; s.node = m[2]; return cpu > 0.8 ? { out: `moving ${s.id} to ${m[2]}... copy throttled, retried 3 times\nmoved (load unchanged: the same keys are just as hot on the new node)`, danger: `${s.id} was at ${Math.round(cpu * 100)}% CPU; streaming its data out added load and timed out client requests` } : `moved ${s.id} to ${m[2]} (load unchanged)`; } },
      { re: /^cachectl hot-key add (\S+)(?: --ttl \S+)?$/, use: "cachectl hot-key add <key> --ttl 5s", desc: "serve a key's reads from every app instance's local cache", run: (m, st) => { const s = keyShard(st, m[1]); if (!s) return `error: ${m[1]} is not a tracked hot key`; st.cached[m[1]] = true; return `hot-key cache enabled for ${m[1]} (ttl 5s): reads now served from app memory; writes still go to ${s.id}`; } },
      { re: /^kvctl counter split (\S+) --buckets (\d+)$/, use: "kvctl counter split <key> --buckets <n>", desc: "spread a counter's writes over n bucket keys (reads sum all buckets)", run: (m, st) => { const s = keyShard(st, m[1]); if (!s) return `error: ${m[1]} is not a tracked hot key`; if (!s.keys[m[1]].counter) return `error: ${m[1]} is not a counter (only INCR-style keys can be split into buckets)`; const n = Math.max(2, Math.min(64, +m[2])); st.split[m[1]] = n; return `${m[1]} now spread over ${n} buckets ${m[1]}#0..${n - 1} on consecutive shards; each read sums ${n} buckets`; } },
      { re: /^shardctl rebalance --all$/, use: "shardctl rebalance --all", desc: "rebalance every shard", run: (m, st) => { st.shards.forEach((s) => { s.base *= 1.05; }); return { out: "rebalancing 38% of keyspace... in progress (ETA 3h)", danger: "a full rebalance moves 38% of the data during peak traffic and doesn't fix single hot keys" }; } },
    ], { sh: "bash" });
    return {
      prompt: "$", init: hsInit(I), run: (line, st) => sh.run(line, st), par: I.lv === 3 ? 8 : 6,
      motd: `ALERT kv-cluster: ${I.alert}\nTarget: every shard under 70% CPU. Type "help".`,
      cmds: ["shardctl status", "shardctl top-keys <shard>", "shardctl split <shard>", "cachectl hot-key add <key> --ttl 5s", "kvctl counter split <key> --buckets <n>", "shardctl move <shard> <node>"],
      live: (a) => { const st = a && a.st ? a.st : hsInit(I); const L = hsLoad(st); return K.bars(st.shards.map((s, i) => ({ label: s.id, value: L[i], max: st.cap, cls: L[i] > 0.7 * st.cap ? "bad" : L[i] > 0.55 * st.cap ? "hot" : "good", note: Math.round((L[i] / st.cap) * 100) + "% CPU" })), { max: st.cap }); },
    };
  }

  /* ---------- queue placement (topo) ---------- */
  const QDEPS = {
    pay: { label: "Payments", sub: "card authorisation", p99: 350, a: 0.9995, cap: Infinity, need: "the response says whether the card was accepted" },
    inv: { label: "Inventory", sub: "reserve stock", p99: 40, a: 0.9995, cap: Infinity, need: "you can't confirm an order for stock you didn't reserve" },
    mail: { label: "Email", sub: "receipt", p99: 900, a: 0.995, cap: "mailCap" },
    ana: { label: "Analytics", sub: "events", p99: 150, a: 0.99, cap: Infinity },
    fraud: { label: "Fraud score", sub: "before auth", p99: 120, a: 0.9995, cap: Infinity, need: "the score decides whether to authorise the card at all" },
    loyal: { label: "Loyalty", sub: "points", p99: 200, a: 0.998, cap: Infinity },
    search: { label: "Search index", sub: "update", p99: 300, a: 0.995, cap: Infinity },
    ship: { label: "Shipping", sub: "label", p99: 1200, a: 0.99, cap: "shipCap" },
  };
  function qpSpec(I) {
    const nodes = [{ label: "Client", x: 60, y: 150, fixed: true }, { label: "API gateway", x: 190, y: 150, fixed: true }, { label: "Orders", x: 330, y: 150, fixed: true }];
    const n = I.deps.length, links = [[0, 1], [1, 2]];
    I.deps.forEach((d, i) => { nodes.push({ label: QDEPS[d].label, sub: QDEPS[d].sub, x: 545, y: 24 + (i * 252) / Math.max(1, n - 1), fixed: true }); links.push([2, 3 + i]); });
    return { nodes, links };
  }
  function qpSim(I, a) {
    const cut = new Set((a && a.cut) || []);
    if (cut.has(0) || cut.has(1)) return { fail: "the client is waiting for the order confirmation; a queue there means no synchronous answer at all", p99: 0, avail: 0, err: 0, sync: [] };
    let p99 = 30, avail = I.base, err = 0, fail = null;
    const sync = [];
    I.deps.forEach((d, i) => {
      const q = QDEPS[d], queued = cut.has(2 + i), needed = q.need && !(I.loyalNeeded === false && d === "loyal");
      if (queued) { if (needed && !fail) fail = `${q.label} can't be queued: ${q.need}`; if (d === "loyal" && I.loyalNeeded && !fail) fail = "Loyalty can't be queued: the confirmation page must show the updated points balance"; return; }
      sync.push(q.label); p99 += q.p99; avail *= q.a;
      const cap = typeof q.cap === "string" ? I[q.cap] : q.cap;
      if (cap < I.peak) err = 1 - (1 - err) * (cap / I.peak);
    });
    if (!fail && err > 0.001) fail = `at the ${K.num(I.peak)} orders/s launch peak, synchronous calls to a rate-limited provider fail ${pc(err)} of checkouts`;
    else if (!fail && p99 > I.slo) fail = `checkout p99 is ${K.num(p99)} ms (SLO ${I.slo} ms)`;
    else if (!fail && avail < I.target) fail = `checkout availability is ${nines(avail)} (SLO ${nines(I.target)})`;
    return { fail, p99, avail, err, sync };
  }
  QDEPS.loyal.need = null;

  /* ---------- cache placement ---------- */
  const CP = [
    { id: "static", t: "CDN: cache static assets (fingerprinted URLs, 1-year max-age)", cost: "cdn" },
    { id: "page", t: "CDN: cache product page HTML for 60 s", cost: "cdn2" },
    { id: "redis", t: "Redis cache-aside for product rows (5 min TTL, deleted on update)", cost: "redis" },
    { id: "lru", t: "In-process LRU for pricing rules (10 s TTL)", cost: null },
    { id: "me", t: "CDN: cache GET /me (account summary) for 60 s", cost: "cdn2" },
    { id: "inv", t: "CDN: cache GET /inventory/{sku} for 60 s (checkout calls it before reserving)", cost: "cdn2" },
    { id: "replica", t: "Two Postgres read replicas", cost: "replica" },
  ];
  function cpSim(I, sel) {
    const on = (id) => sel.some((i) => CP[i].id === id);
    if (on("me")) return { fail: "GET /me returns one user's account: a shared CDN cache would serve it to other users" };
    if (on("inv")) return { fail: "checkout would decide on stock counts up to 60 s old and oversell during the sale" };
    if (on("page") && I.personal) return { fail: "product pages now show member prices and the cart count: a shared 60 s page cache serves one member's page to everyone" };
    const pageOrigin = on("page") ? I.page * 0.08 : I.page;
    const web = (on("static") ? 0 : I.stat) + pageOrigin + I.api;
    const perPage = 3 - (on("lru") ? 1 : 0), perApi = 2 - (on("lru") ? 1 : 0);
    const prodFactor = on("redis") ? 0.15 : 1;
    const db = (pageOrigin * perPage + I.api * perApi) * prodFactor + I.other;
    const dbCap = I.dbCap * (on("replica") ? 3 : 1);
    const cost = sel.reduce((s, i) => s + (CP[i].cost ? I.price[CP[i].cost] : 0), 0);
    let fail = null;
    if (web > I.webCap) fail = `the web tier gets ${K.num(web)} req/s (capacity ${K.num(I.webCap)})`;
    else if (db > dbCap * 0.75) fail = `Postgres gets ${K.num(db)} queries/s (keep under ${K.num(dbCap * 0.75)})`;
    return { web, db, dbCap, cost, fail };
  }
  function cpHTML(I, sel) {
    const r = cpSim(I, sel || []);
    if (r.web == null) return K.note(esc(r.fail), "bad");
    return K.metrics([{ name: "Web tier", value: K.num(r.web) + " req/s", ok: r.web <= I.webCap, target: `≤ ${K.num(I.webCap)}` }, { name: "Postgres", value: K.num(r.db) + " q/s", ok: r.db <= r.dbCap * 0.75, target: `≤ ${K.num(r.dbCap * 0.75)}` }, { name: "Monthly cost", value: mo(r.cost), ok: null }]) + (r.fail ? K.note(esc(r.fail), "bad") : K.note("Launch traffic fits.", "good"));
  }

  LB.addAll("sd", [
    {
      id: "sd-idempotent-charge",
      name: "Find the double charge",
      kind: "Investigation",
      skills: ["diagnose", "design"],
      w: "interleave",
      gen(lv, R) { return { lv, key: R.pick(["7f3a-91c2", "b04e-5d17", "e9c1-2a80"]), amt: R.pick([49, 89, 129, 249]) }; },
      text: (I) => `<p>The checkout API takes an <code>Idempotency-Key</code> header so that a mobile client can safely retry a charge after a timeout. Support says some customers were charged twice during the launch. Here's the ${I.lv === 3 ? "Redis-based " : ""}implementation:</p>${I.lv === 3 ? "<p>Under launch load the payment provider takes up to <b>45 s</b> to answer, and the provider call carries no idempotency key of its own.</p>" : ""}<p><b>Find a schedule</b> of the requests' steps that charges the card twice. Pick which lane runs its next step; the trace shows what each step sees.</p>`,
      ui: (I) => ({ lanes: idemLanes(I).map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => idemHTML(I, seq) }),
      accept: (I, seq) => { const r = idemRun(I, seq); return r.charges >= 2 ? true : `The customer was charged ${r.charges}×. ${I.lv === 1 ? "Let both requests look before either one records anything." : I.lv === 2 ? "What does the retry see if it arrives after the original gave up?" : "The key only lives for 30 s, but the charge takes 45."}`; },
      solve: (I, spec) => { for (const s of LB.byId.get("sd-idempotent-charge").space(I, spec)) if (idemRun(I, s).charges >= 2) return s; return null; },
      bad: (I) => { const L = idemLanes(I); const seqOf = (order) => order.flatMap((l) => L[l].steps.map(() => l)); return I.lv === 3 ? [seqOf([0, 1, 2]), seqOf([2, 0, 1])] : I.lv === 2 ? [seqOf([1, 0]), [0, 1, 0, 0, 0, 1, 1, 1]] : [seqOf([0, 1]), seqOf([1, 0])]; },
      hint: (I) => I.lv === 1 ? "Check-then-act: both requests can pass the check before either inserts." : I.lv === 2 ? "Deleting the key on timeout assumes the charge failed. Did it?" : "Put the clock tick between the original's SET and the retry's SET.",
      concept: "Idempotency keys done right",
      how: "An idempotency key must be claimed atomically before the side effect (INSERT ... ON CONFLICT or SET NX), not checked and then written afterwards, or two concurrent requests both pass the check. The claim must outlive the operation: deleting it on timeout, or letting a cache TTL expire while the call is still running, reopens the door, because a timeout doesn't mean the charge failed. The robust pattern stores the key durably with status pending → done and the saved response, returns 409 for a key in progress, and passes the same key to the payment provider so its side is idempotent too.",
      rule: "Claim the key atomically before the side effect, keep it durably until the outcome is known, never release it on timeout, and propagate it to the downstream provider.",
      why: (I) => I.lv === 1 ? "Both requests ran the SELECT before either INSERT, so both charged; the unique constraint only fired after the money moved." : I.lv === 2 ? "The original timed out after the provider had already charged the card, then deleted its key; the retry claimed the free key and charged again." : "The 30-second TTL expired while the 45-second charge was still in flight, so the retry's SET NX succeeded and it charged again. Store keys durably (or extend the lease) and pass the key to the provider.",
    },
    {
      id: "sd-flash-sale",
      name: "Survive the flash sale",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "an extra cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const units = lv === 1 ? R.pick([2, 3, 5]) * 1000 : R.pick([30, 50, 80]) * 1000, buyers = R.pick([200, 400, 800]) * 1000;
        return { lv, app: R.pick(APPS), item: R.pick(["consoles", "sneakers", "concert tickets", "graphics cards"]), units, buyers, peak: Math.round((2 * buyers) / 60), lock: R.pick([4, 5, 8]), maxSell: 120, roomPrice: R.int(4, 9) * 100, redisPrice: R.int(5, 12) * 100, abandon: 0.3 };
      },
      text: (I) => `<p>${I.app} drops <b>${K.num(I.units)} ${I.item}</b> at noon. <b>${M(I.buyers)}</b> people will hit "Buy" in the first minute, peaking at <b>${K.num(I.peak)} attempts/s</b>. Requirements: <b>never oversell</b>; inventory work stays ≤ 80% of its throughput (beyond that, checkouts time out); and the sale must sell out within <b>${I.maxSell} s</b> (about 70% of admitted buyers complete a purchase).</p><ul><li>A conditional <code>UPDATE ... SET stock = stock - 1 WHERE stock &gt; 0</code> holds the row lock ~<b>${I.lock} ms</b> through commit, so one row allows ~${K.num(1000 / I.lock)} decrements/s; splitting stock across bucket rows multiplies that (buckets drain unevenly: ~80% efficiency).</li><li>Redis <code>DECR</code> reservations + an order queue handle ~50,000/s (${mo(I.redisPrice)}).</li><li>A virtual waiting room admits buyers at a fixed rate (${mo(I.roomPrice)}).</li>${I.lv === 3 ? `<li>Reserved units are held for a TTL while the buyer pays; <b>30%</b> of reservations are abandoned, and their units return to stock when the TTL expires. 25% of payers need over 2 min (3-D Secure, bank apps), 4% over 10 min, 1% over 30. At most 5% of payers may lose their reservation, and under 2% of units may be unsold when the 60-minute sale closes.</li>` : ""}</ul><p>Pick the cheapest design that meets every requirement.</p>`,
      ui: (I) => {
        const knobs = [{ k: "ap", label: "Inventory approach", opts: ["read, check, write", "conditional UPDATE, one row", "bucket rows", "Redis DECR + order queue"] }, { k: "buckets", label: "Bucket rows", opts: [4, 16, 64], help: "only for bucket rows" }, { k: "room", label: "Waiting room admits", opts: ["off", 100, 500, 2000, 8000], fmt: (v) => (v === "off" ? "off" : K.num(v) + "/s") }];
        if (I.lv === 3) knobs.push({ k: "ttl", label: "Reservation TTL", opts: [2, 10, 30], unit: "min" });
        return { knobs, init: { ap: "read, check, write", buckets: 4, room: "off", ttl: 30 }, live: (cfg) => fsHTML(I, cfg) };
      },
      valid: (I, cfg) => fsSim(I, cfg).fail || true,
      val: (I, cfg) => fsSim(I, cfg).cost + (cfg.ap === "bucket rows" ? cfg.buckets / 1000 : 0),
      hint: (I) => I.lv === 1 ? "Throughput of one hot row is 1 ÷ lock hold time. You don't have to let everyone in at once." : I.lv === 2 ? "With this much stock, a slow admission rate makes the sale drag. How many decrements/s do you need, and what gives them?" : "Short TTLs punish slow payers; long TTLs leave abandoned stock locked up until the sale is over.",
      concept: "Inventory contention in flash sales",
      how: "A flash sale funnels huge concurrency onto a few counters. Read-check-write in the application oversells under concurrency; a conditional UPDATE is correct but serialises on one row lock, so throughput is 1 ÷ lock hold time. Splitting stock into bucket rows (or Redis counters with DECR) multiplies throughput, and an asynchronous order queue moves the slow work out of the hot path. A waiting room turns a stampede into a steady admission rate, trading errors for a visible queue. Reservations need a TTL: long enough for real payers, short enough that abandoned units return to sale.",
      rule: "Make the decrement atomic, spread it over enough counters for the admitted rate, admit buyers at a rate the inventory can take, and tune reservation TTL to how long real payments take.",
      why: (I, sol) => { const r = fsSim(I, sol); return `Cheapest: ${sol.ap}${sol.ap === "bucket rows" ? ` × ${sol.buckets}` : ""}, waiting room ${sol.room === "off" ? "off" : K.num(sol.room) + "/s"}${I.lv === 3 ? `, ${sol.ttl}-min TTL` : ""}: ${Number.isFinite(r.thr) ? K.num(r.thr) + " decrements/s" : "no lock limit"}, sells out in ${K.num(r.sellout)} s, ${mo(r.cost)} extra.`; },
    },
    {
      id: "sd-live-cdn",
      name: "Stream the live final",
      kind: "Capacity plan",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        return { lv, app: R.pick(APPS), viewers: (lv === 1 ? R.pick([0.5, 1, 2]) : R.pick([2, 4, 6])) * 1e6, pops: R.pick([120, 150, 200]), shields: 6, rend: 5, ladder: R.pick([12, 15, 20]), cap: 1000, price: R.int(8, 14) * 100, shieldPrice: R.int(10, 20) * 100, lat: lv === 1 ? 25 : lv === 2 ? 15 : 8 };
      },
      text: (I) => `<p>${I.app} streams the live final to <b>${M(I.viewers)}</b> concurrent viewers over HLS: <b>${I.rend} renditions</b>, served through <b>${I.pops} CDN POPs</b>. Every segment period, each POP fetches the new segment and refreshes the playlist (≈2 playlist fetches) for each rendition from the origin. Each origin server (packager + auth) handles <b>${K.num(I.cap)} req/s</b> and <b>1 Gbps</b> (${mo(I.price)}); keep both under 75%. The rendition ladder adds up to <b>${I.ladder} Mbps</b>, so every cache that pulls all renditions from the origin costs ${I.ladder} Mbps of origin egress.</p><ul><li>Without <b>request collapsing</b>, every viewer who asks for a segment while the POP is still fetching it (~0.25 s) triggers another origin request.</li>${I.lv > 1 ? `<li>An <b>origin shield</b> (${I.shields} regional mid-tier caches, ${mo(I.shieldPrice)}) puts one cache layer between the POPs and the origin, adding ~0.3 s.</li>` : ""}<li>Glass-to-glass latency ≈ 3 segments + 1 s; it must be under <b>${I.lat} s</b>${I.lv === 1 ? " (segments are 6 s)" : ""}.</li></ul><p>Find the cheapest setup.</p>`,
      ui: (I) => {
        const knobs = [];
        if (I.lv > 1) knobs.push({ k: "seg", label: "Segment duration", opts: [2, 4, 6], unit: "s" }, { k: "shield", label: "Origin shield", opts: ["off", "on"] });
        knobs.push({ k: "collapse", label: "Request collapsing at the CDN", opts: ["off", "on"] }, { k: "servers", label: "Origin servers", opts: [1, 2, 4, 8, 16, 32, 64, 128] });
        return { knobs, init: { seg: 6, shield: "off", collapse: "off", servers: 1 }, live: (cfg) => cdnHTML(I, cfg) };
      },
      valid: (I, cfg) => cdnSim(I, cfg).fail || true,
      val: (I, cfg) => cdnSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Count origin requests per segment period with and without collapsing: how many viewers per POP per rendition ask during the fetch?" : I.lv === 2 ? "The latency target caps the segment length; shorter segments mean more origin fetches per second." : "Even with collapsing, every POP still fetches every new segment. What reduces the number of caches talking to the origin?",
      concept: "Live streaming through a CDN",
      how: "In live HLS/DASH every new segment is a cache miss at every POP, all at the same moment. Without request collapsing, all viewers asking during that first fetch go to the origin too: a thundering herd every few seconds. Collapsing turns that into one fetch per POP per rendition; an origin shield (mid-tier cache) further reduces it to one fetch per shield. Latency is roughly three segment durations, so low-latency targets force short segments, which multiply request rates and make collapsing and shielding essential.",
      rule: "For live video, always collapse requests and put a shield in front of the origin; choose segment length from the latency target, then size the origin for POPs × renditions ÷ segment duration.",
      why: (I, sol) => { const r = cdnSim(I, sol); return `Cheapest: ${I.lv > 1 ? `${sol.seg} s segments, shield ${sol.shield}, ` : ""}collapsing ${sol.collapse}, ${sol.servers} origin server(s): ${K.num(r.rps)} origin req/s, ~${K.num(r.latency, 1)} s latency, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-metric-labels",
      name: "Keep the metrics bill in check",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "select",
      gen(lv, R) {
        const routes = R.pick([60, 80, 120]), pods = R.pick([40, 60, 90]);
        const labels = [
          { id: "route", t: `route (templated, e.g. /orders/{id}): ${routes} values`, c: routes, w: 0 },
          { id: "method", t: "method: 5 values", c: 5, w: 2 },
          { id: "code", t: "status_code: 12 values", c: 12, w: 2 },
          { id: "class", t: "status_class (2xx/3xx/4xx/5xx): 4 values", c: 4, w: 1 },
          { id: "region", t: "region: 3 values", c: 3, w: lv > 1 ? 0 : 1 },
          { id: "pod", t: `pod: ${pods} values (new names on every deploy)`, c: pods, w: 2 },
          { id: "tier", t: "customer_tier: 4 values", c: 4, w: 2 },
          { id: "user", t: "user_id: ~2,000,000 values", c: 2e6, w: 4 },
          { id: "path", t: "raw URL path: ~500,000 values", c: 5e5, w: 3 },
        ];
        if (lv === 3) labels.push({ id: "fewer", t: "Cut histogram buckets from 12 to 6 (coarser percentiles)", buckets: 6, w: -1 });
        const order = R.shuffle(U.range(labels.length));
        return { lv, svc: R.pick(K.NAMES.svc), labels: order.map((i) => labels[i]), buckets: 12, fill: 0.4, budget: lv === 1 ? R.pick([60, 80]) * 1000 : lv === 2 ? R.pick([150, 200]) * 1000 : R.pick([120, 160]) * 1000 };
      },
      text: (I) => `<p>The <b>${I.svc}</b> service exports a latency histogram <code>http_request_duration_seconds</code> with <b>${I.buckets} buckets</b>, so every label combination costs ${I.buckets + 2} series (buckets + <code>_sum</code> + <code>_count</code>). In practice ~${pc(I.fill)} of label combinations occur. The team's budget for this metric is <b>${K.num(I.budget)} active series</b>.</p><p>Requirements: per-route latency SLO dashboards, a 5xx-ratio alert${I.lv > 1 ? ", and per-region SLOs" : ""}. Choose which labels to keep${I.lv === 3 ? " (and whether to cut buckets)" : ""}: stay within budget while keeping as much debugging value as possible.</p>`,
      ui: (I) => ({ opts: I.labels.map((l) => l.t), allowNone: false, live: (sel) => { const s = sel || []; const ser = cardSeries(I, s), ok = cardCheck(I, s); return K.metrics([{ name: "Active series", value: K.num(ser), ok: ser <= I.budget, target: `≤ ${K.num(I.budget)}` }, { name: "Debugging value", value: String(cardVal(I, s)), ok: null }]) + (ok === true ? "" : K.note(esc(ok), "bad")); } }),
      valid: (I, sel) => cardCheck(I, sel),
      val: (I, sel) => cardVal(I, sel),
      sense: "max",
      vname: "a debugging value of",
      hint: (I) => I.lv === 1 ? "Multiply the cardinalities you keep, then by series per combination. Anything per user or per raw path is unbounded." : I.lv === 2 ? "status_code and status_class answer the same alert; one is 3× more expensive. Which labels buy the most value per multiplier?" : "Coarser buckets halve the series per combination: sometimes that buys a whole extra label.",
      concept: "Metrics cardinality",
      how: "Every unique combination of label values is a separate time series that the TSDB keeps in memory and bills for, and histograms multiply that by the bucket count. Cardinality is the product of label cardinalities, so one high-cardinality label (user ID, raw URL, request ID) explodes it; labels like pod also churn on every deploy, multiplying series over the retention window. Per-request detail belongs in logs and traces (exemplars link a metric to a trace), while metrics keep bounded, aggregated dimensions such as templated route, status class and region.",
      rule: "Never put unbounded values in labels; template routes, prefer status class to status code when that's all the alert needs, and budget series per metric before adding a label.",
      why: (I, sol) => `Kept: ${sol.map((i) => esc(I.labels[i].t.split(":")[0])).join(", ")} → ${K.num(cardSeries(I, sol))} series (budget ${K.num(I.budget)}). Per-user and raw-path detail belongs in traces and logs.`,
    },
    {
      id: "sd-job-scheduler",
      name: "Run the hourly jobs on time",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        return { lv, app: R.pick(APPS), jobs: R.pick([50, 100, 200]) * 1000, avg: R.pick([10, 20, 30]), p99run: lv === 3 ? R.pick([360, 480]) : R.pick([90, 100]), sla: R.pick([10, 15]), api: lv === 1 ? Infinity : R.pick([200, 300, 500]), recover: 5, price: R.int(8, 15) * 10 };
      },
      text: (I) => `<p>${I.app} runs <b>${M(I.jobs)}</b> customer cron jobs, nearly all scheduled at minute :00 of every hour. A job takes <b>${I.avg} s</b> on average (p99 <b>${K.num(I.p99run / 60, 1)} min</b>); each worker runs 4 jobs at a time (${mo(I.price)}). Every job must <b>start within ${I.sla} min</b> of its scheduled time.</p><ul><li>Workers claim a job with a lease (<code>UPDATE jobs SET owner = $me, lease_until = now() + $lease ... FOR UPDATE SKIP LOCKED</code>); when a lease expires, another worker may run the job again. A job must never run twice concurrently.</li>${I.lv > 1 ? `<li>Each job calls the billing API first, which allows <b>${K.num(I.api)} calls/s</b>. The dispatcher can spread start times with a random jitter (each job's start is delayed by up to the window).</li>` : ""}${I.lv === 3 ? `<li>When a worker crashes, its jobs must be retried within <b>${I.recover} min</b>.</li>` : ""}</ul><p>Find the cheapest configuration.</p>`,
      ui: (I) => {
        const knobs = [{ k: "workers", label: "Workers", opts: [10, 20, 40, 60, 80, 120, 160, 240, 320] }];
        if (I.lv > 1) knobs.push({ k: "jitter", label: "Start jitter window", opts: [0, 1, 2, 5, 10], unit: "min" });
        knobs.push({ k: "lease", label: "Lease", opts: I.lv === 3 ? ["30 s", "2 min", "10 min", "2 min + heartbeat"] : ["30 s", "2 min", "10 min"] });
        return { knobs, init: { workers: 10, jitter: 0, lease: "30 s" }, live: (cfg) => jobHTML(I, cfg) };
      },
      valid: (I, cfg) => jobSim(I, { jitter: 0, ...cfg }).fail || true,
      val: (I, cfg) => jobSim(I, { jitter: 0, ...cfg }).cost,
      hint: (I) => I.lv === 1 ? "All jobs become due at once: how long does it take your slots to start the last one? And the lease must outlast slow jobs." : I.lv === 2 ? "Jitter doesn't add workers, but it caps how fast jobs hit the billing API. It also delays starts: keep it within the SLA." : "A lease long enough for the slowest job is too long for crash recovery. What lets a lease stay short for running jobs?",
      concept: "Distributed job scheduling",
      how: "Cron-style schedules concentrate work on round minutes, so a scheduler must drain the burst within the start-time SLA (slots ≥ jobs × duration ÷ SLA) and protect downstream systems from the synchronized start, usually with jitter or rate-limited dispatch. Workers claim jobs with leases; if a lease is shorter than a job's runtime, the job is re-dispatched while still running and executes twice. Long leases fix that but delay recovery after a crash. Heartbeats renew a short lease while the job runs, giving both fast failover and no duplicates (still make jobs idempotent, since a paused worker can outlive its lease).",
      rule: "Size slots for the top-of-hour burst, jitter starts to protect dependencies, and use short leases renewed by heartbeats plus idempotent jobs.",
      why: (I, sol) => { const r = jobSim(I, { jitter: 0, ...sol }); return `Cheapest: ${sol.workers} workers (${r.slots} slots)${I.lv > 1 ? `, ${sol.jitter} min jitter` : ""}, lease ${sol.lease}: last job starts after ${K.num(r.lateness / 60, 1)} min${I.lv > 1 ? `, billing API peaks at ${K.num(r.burst)}/s` : ""}, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-multi-region",
      name: "Go multi-region",
      kind: "Design review",
      skills: ["design"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const base = R.int(20, 40) * 1000;
        const share = R.pick([[0.5, 0.35, 0.15], [0.4, 0.4, 0.2], [0.45, 0.3, 0.25]]);
        const eu = R.pick([80, 90]), ap = R.pick([150, 170]);
        return { lv, app: R.pick(APPS), share, rtt: [[10, eu, ap], [eu, 10, 160], [ap, 160, 10]], readSlo: 60, euWrite: lv > 1 ? 50 : 0, noLost: lv > 1, rpo: lv === 3 ? 0 : 60, resid: lv === 3, syncCost: R.int(4, 9) * 1000, cost: { "single region (NA)": base, "NA primary + read replicas everywhere": Math.round(base * 1.7), "active-passive (EU standby)": Math.round(base * 1.6), "active-active, multi-primary (last-writer-wins)": Math.round(base * 2.6), "home region per user": Math.round(base * 2.2) } };
      },
      text: (I) => `<p>${I.app} serves users in NA (${pc(I.share[0])}), EU (${pc(I.share[1])}) and APAC (${pc(I.share[2])}). Round trips: NA–EU ${I.rtt[0][1]} ms, NA–APAC ${I.rtt[0][2]} ms, EU–APAC 160 ms, in-region ~10 ms. Requirements:</p><ul><li>reads under <b>${I.readSlo} ms</b> p95 for everyone</li>${I.euWrite ? `<li>EU writes under <b>${I.euWrite} ms</b> p95 (EU is the growth market)</li><li>account balances must never lose an update</li>` : ""}<li>RPO on losing a region: <b>${I.rpo ? "≤ " + I.rpo + " s" : "0 (no acknowledged write lost)"}</b></li>${I.resid ? "<li>EU customers' personal data must stay in the EU</li>" : ""}</ul>${K.table(["Topology", "Monthly cost"], Object.entries(I.cost).map(([k, v]) => [esc(k), mo(v)]), { compact: true })}${I.lv === 3 ? `<p>Synchronous replication costs ${mo(I.syncCost)} extra; a nearby region in the same jurisdiction adds ~15 ms per write, the farthest ~150 ms.</p>` : ""}<p>Pick the cheapest design that meets every requirement.</p>`,
      ui: (I) => {
        const knobs = [{ k: "topo", label: "Topology", opts: Object.keys(I.cost), select: true }];
        if (I.lv === 3) knobs.push({ k: "repl", label: "Replication", opts: ["async to another region", "sync to a nearby region (same jurisdiction)", "sync to the farthest region"], select: true });
        return { knobs, init: { topo: "single region (NA)", repl: "async to another region" }, live: (cfg) => mrHTML(I, cfg) };
      },
      valid: (I, cfg) => mrSim(I, cfg).fail || true,
      val: (I, cfg) => mrSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Reads need a copy of the data near every user; writes can still travel." : I.lv === 2 ? "Fast EU writes need a primary in the EU for EU users, without two primaries for the same row." : "RPO 0 means synchronous replication. Where can the synchronous copy live without breaking residency or the write budget?",
      concept: "Multi-region data strategies",
      how: "Read replicas in every region make reads local, but writes still cross the ocean to one primary and async replicas lag, so failover loses the last seconds. Active-passive adds a standby, not speed. Multi-primary (active-active) makes writes local but needs conflict resolution: last-writer-wins silently drops concurrent updates, which is unacceptable for balances. Partitioning users by home region keeps each user's reads and writes local with a single writer per row, and it's the natural fit for data-residency rules. RPO 0 requires synchronous replication, whose latency cost is the round trip to the replica, so pick a nearby region.",
      rule: "Replicate for read latency, partition by home region for write latency and residency, avoid multi-primary for data that can't merge, and put synchronous replicas close.",
      why: (I, sol) => { const r = mrSim(I, sol); return `Cheapest passing: ${esc(sol.topo)}${I.lv === 3 ? `, ${esc(sol.repl)}` : ""}: worst read ${Math.max(...r.rd)} ms, EU writes ${r.w[1]} ms, RPO ${r.rpo >= 3600 ? "1 h" : r.rpo + " s"}, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-shard-key",
      name: "Choose the shard key",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a shard count of",
      gen(lv, R) {
        const whales = lv === 1 ? [] : lv === 2 ? [R.pick([0.12, 0.15, 0.2])] : [R.pick([0.12, 0.15]), R.pick([0.08, 0.1])];
        return { lv, app: R.pick(APPS), ops: R.pick([60, 90, 120]) * 1000, wr: R.pick([0.3, 0.4]), listF: lv === 1 ? 0.5 : R.pick([0.5, 0.6]), cap: R.pick([15, 20]) * 1000, whales, scatterMax: lv === 1 ? 1 : lv === 2 ? 0.2 : 0.25 };
      },
      text: (I) => `<p>${I.app}'s multi-tenant <code>orders</code> table serves <b>${K.num(I.ops)} ops/s</b> (${pc(I.wr)} writes, mostly new orders). Of the reads, ${pc(I.listF)} are "list this tenant's recent orders", the rest point lookups by order ID. A shard sustains <b>${K.num(I.cap)} ops/s</b>; keep each under 70%.${I.whales.length ? ` The biggest tenant${I.whales.length > 1 ? "s generate" : " generates"} <b>${I.whales.map(pc).join(" and ")}</b> of all traffic.` : ""}${I.lv > 1 ? ` At most <b>${pc(I.scatterMax)}</b> of queries may fan out to many shards (scatter-gather tail latency).` : " A list query on a key that doesn't include the tenant must ask every shard."}</p><p>"Whale split" hashes (tenant_id, order_id mod 8) for tenants above 5% of traffic, spreading each over 8 shards (their list queries fan out); everyone else stays on one shard. Choose the key and the <b>fewest shards</b>.</p>`,
      ui: (I) => ({ knobs: [{ k: "key", label: "Shard key", opts: ["created_at (range)", "order_id (hash)", "tenant_id (hash)", "tenant_id + whale split"], select: true }, { k: "n", label: "Shards", opts: [2, 4, 8, 16, 32, 64] }], init: { key: "created_at (range)", n: 4 }, live: (cfg) => skHTML(I, cfg) }),
      valid: (I, cfg) => skSim(I, cfg).fail || true,
      val: (I, cfg) => cfg.n,
      hint: (I) => I.lv === 1 ? "Time-ordered keys send every new write to the same shard." : I.lv === 2 ? "Hashing the tenant keeps list queries on one shard, but one tenant is bigger than a shard's budget." : "Splitting whales costs scatter on their list queries. Check both whales against the scatter limit and the shard budget.",
      concept: "Shard keys and hot shards",
      how: "A shard key decides both load balance and which queries stay on one shard. Monotonic keys (timestamps, sequential IDs in range partitioning) send all new writes to the newest shard. Hashing a high-cardinality key spreads load but forces queries that don't include it to scatter to every shard, whose tail latency is the slowest shard's. Hashing by tenant keeps tenant queries local but a whale tenant can exceed any single shard; the fix is to split just the whales across a few shards with a composite key, accepting scatter for their queries only.",
      rule: "Shard by the key your hottest queries filter on, make sure no single key value can exceed a shard, and special-case the whales rather than scattering everyone.",
      why: (I, sol) => { const r = skSim(I, sol); return `${esc(sol.key)} on ${sol.n} shards: hottest at ${pc(r.max / I.cap)}, ${pc(r.scatter)} scatter-gather.${I.whales.length ? ` A whale at ${pc(I.whales[0])} of ${K.num(I.ops)} ops/s alone is ${K.num(I.whales[0] * I.ops)} ops/s, ${r.max ? "which no single shard could carry under 70%" : ""}.` : ""}`; },
    },
    {
      id: "sd-hot-shard",
      name: "Cool down the hot shard",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      ...LB.term({
        shell: (I) => hsShell(I),
        goal: (st) => { const c = hsCpu(st); const i = c.findIndex((x) => x > 0.7); return i < 0 ? true : `${st.shards[i].id} is still at ${Math.round(c[i] * 100)}% CPU.`; },
        solve: (I) => ({ log: I.solve }),
      }),
      gen(lv, R) {
        const base = U.range(6).map(() => R.int(30, 45) * 1000), hs = R.int(0, 5);
        const keys = U.range(6).map(() => R.int(30, 60) * 1e5);
        if (lv === 1) { base[hs] = R.int(84, 95) * 1000; return { lv, base, keys, hot: [], alert: `shard s${hs + 1} CPU ${Math.round(base[hs] / 1000)}% · p99 reads 180 ms`, solve: ["shardctl status", `shardctl split s${hs + 1}`] }; }
        const id = R.pick(["profile:celeb_ariadne", "profile:celeb_tomasz", "profile:celeb_ines"]);
        if (lv === 2) { const r = R.int(45, 60) * 1000; base[hs] = R.int(28, 35) * 1000; return { lv, base, keys, hot: [{ s: hs, key: id, r, w: 40 }], alert: `shard s${hs + 1} CPU ${Math.round((base[hs] + r + 40) / 1000)}% · p99 reads 240 ms`, solve: ["shardctl status", `shardctl top-keys s${hs + 1}`, `cachectl hot-key add ${id} --ttl 5s`] }; }
        const post = "likes:post:" + R.int(100000, 999999), other = (hs + 3) % 6;
        const w = R.int(36, 48) * 1000, r = R.int(6, 10) * 1000;
        base[hs] = 30000; base[other] = R.int(76, 82) * 1000;
        base[(hs + 1) % 6] = Math.min(base[(hs + 1) % 6], 34000); base[(hs + 2) % 6] = Math.min(base[(hs + 2) % 6], 34000); base[(hs + 3) % 6] = base[other];
        return { lv, base, keys, hot: [{ s: hs, key: post, r, w, counter: true }], alert: `shards s${hs + 1} and s${other + 1} above 70% CPU · write timeouts on ${post}`, solve: ["shardctl status", `shardctl top-keys s${hs + 1}`, `kvctl counter split ${post} --buckets 4`, `cachectl hot-key add ${post} --ttl 5s`, `shardctl split s${other + 1}`] };
      },
      bad: (I) => I.lv === 1 ? [{ log: ["shardctl rebalance --all"] }, { log: [`shardctl move s${I.base.indexOf(Math.max(...I.base)) + 1} kv-30`] }] : I.lv === 2 ? [{ log: [`shardctl split s${I.hot[0].s + 1}`] }] : [{ log: [`cachectl hot-key add ${I.hot[0].key} --ttl 5s`, `shardctl split s${I.hot[0].s + 1}`] }, { log: [`kvctl counter split ${I.hot[0].key} --buckets 16`] }],
      text: (I) => `<p><b>PAGE:</b> the key-value cluster behind ${I.lv === 3 ? "post likes and profiles" : "user profiles"} is struggling: ${esc(I.alert)}. Shards are range-partitioned over 6 nodes; each sustains ~100k ops/s.</p><p>Bring every shard under <b>70% CPU</b> using the admin tools, without risky bulk operations at peak. The bars below update as you act.</p>`,
      hint: (I) => I.lv === 1 ? "Is the shard hot because of many keys or one key? top-keys tells you." : I.lv === 2 ? "Splitting a range doesn't split a key. Where else can reads of one key be served?" : "Caching only absorbs reads; this key is mostly writes. And watch where the extra bucket traffic lands: each read sums every bucket.",
      concept: "Hot shards vs hot keys",
      how: "A hot shard has two possible causes. If many keys in its range are busy (skewed range partitioning), splitting the range spreads them. If one key is hot, no split helps, because a key can't be divided: hot reads are absorbed by caching the key in front of the store (in-process with a short TTL, or replicated read copies); hot writes, typically counters, are spread by write-sharding the key into N buckets on different shards, with reads summing the buckets. More buckets mean cheaper writes but costlier reads, so combine them with a cache for reads. Moving or rebalancing a hot shard during peak only adds copy load.",
      rule: "Find out whether it's a hot range or a hot key before acting: split ranges, cache hot read keys, bucket hot write keys, and don't move data off an overloaded node at peak.",
      why: (I) => I.lv === 1 ? "The shard's load came from many keys in its range, so splitting it put half the range on a new node." : I.lv === 2 ? `All the extra load was reads of ${esc(I.hot[0].key)}. A split leaves that key on one side; a 5 s local cache absorbs ~98% of its reads.` : `${esc(I.hot[0].key)} took ${K.num(I.hot[0].w)} writes/s. Bucketing spreads the writes, but every read now sums all buckets, so the counter's reads must be cached too; a 16-way split without that floods every shard with reads. The other shard was simply a hot range: split it.`,
    },
    {
      id: "sd-queue-placement",
      name: "Decide what goes async",
      kind: "Design review",
      skills: ["design"],
      w: "topo",
      gen(lv, R) {
        const deps = lv === 1 ? ["pay", "inv", "mail", "ana"] : lv === 2 ? ["fraud", "pay", "inv", "mail", "ana", "search"] : ["fraud", "pay", "inv", "loyal", "mail", "ana", "ship"];
        return { lv, deps, peak: R.pick([800, 1200, 2000]), mailCap: R.pick([200, 400]), shipCap: R.pick([100, 300]), slo: lv === 1 ? 800 : lv === 2 ? 700 : 900, base: 0.9995, target: lv === 2 ? 0.998 : 0.995, loyalNeeded: lv === 3 };
      },
      text: (I) => `<p>Checkout is the Orders service calling each dependency synchronously, one after another (p99 latencies add; availabilities multiply). Launch peak is <b>${K.num(I.peak)} orders/s</b>. The email provider accepts <b>${K.num(I.mailCap)} sends/s</b>${I.deps.includes("ship") ? `, the shipping-label provider <b>${K.num(I.shipCap)}/s</b>` : ""}. SLO: p99 under <b>${I.slo} ms</b>, availability <b>${nines(I.target)}</b>.</p>${K.table(["Dependency", "p99", "Availability"], I.deps.map((d) => [QDEPS[d].label + " (" + QDEPS[d].sub + ")", QDEPS[d].p99 + " ms", nines(QDEPS[d].a)]), { compact: true })}${I.loyalNeeded ? "<p>The confirmation page must show the customer's updated loyalty balance.</p>" : ""}<p>Click links to put a <b>queue</b> on them (the call becomes an event processed later). Use as <b>few queues</b> as possible (each is something to operate).</p>`,
      ui: (I) => ({ ...qpSpec(I), mode: "links", linkVerb: "queued", W: 640, H: 300, live: (a) => { const r = qpSim(I, a); if (r.fail && !r.p99) return K.note(esc(r.fail), "bad"); return K.metrics([{ name: "Checkout p99", value: K.num(r.p99) + " ms", ok: r.p99 <= I.slo, target: `≤ ${I.slo} ms` }, { name: "Availability", value: nines(r.avail), ok: r.avail >= I.target, target: `≥ ${nines(I.target)}` }, { name: "Errors at peak", value: pc(r.err), ok: r.err <= 0.001 }]) + (r.fail ? K.note(esc(r.fail), "bad") : K.note("Sync path: " + esc(r.sync.join(" → ")), "good")); } }),
      valid: (I, a) => qpSim(I, a).fail || true,
      val: (I, a) => (a.cut || []).length,
      sense: "min",
      vname: "a queue count of",
      hint: (I) => I.lv === 1 ? "Which calls does the customer's confirmation actually depend on? Everything else can happen after the response." : I.lv === 2 ? "Queue only what's needed for the SLO, but don't queue a step whose answer the next step needs." : "Count the budget: which async-able calls do you have to remove from the path to meet p99 and availability, and which are cheap enough to keep?",
      concept: "Decoupling with queues",
      how: "A synchronous call puts the dependency's latency, availability and capacity into your request path: p99s add up, availabilities multiply, and a rate-limited provider turns your launch peak into errors. Moving work behind a queue (emit an event, process it later) removes all three from the path and lets consumers drain spikes at the provider's pace. But anything whose result the response needs must stay synchronous, or be redesigned. Each queue is also something to operate (lag, DLQs, replays), so add them where they buy SLO, not everywhere.",
      rule: "Keep in the request path only what the response depends on; put rate-limited, slow or flaky side effects behind a queue, and no more queues than that.",
      why: (I, sol) => { const r = qpSim(I, sol); return `Queued: ${sol.cut.map((i) => (i >= 2 ? QDEPS[I.deps[i - 2]].label : "")).filter(Boolean).join(", ") || "nothing"}. The remaining sync path (${r.sync.join(" → ")}) gives p99 ${K.num(r.p99)} ms and ${nines(r.avail)}.`; },
    },
    {
      id: "sd-cache-placement",
      name: "Place the caches",
      kind: "Design review",
      skills: ["design"],
      w: "select",
      gen(lv, R) {
        return { lv, app: R.pick(APPS), stat: R.pick([20, 30, 40]) * 1000, page: R.pick([2, 3, 4]) * 1000, api: R.pick([3, 5, 8]) * 1000, other: R.pick([1, 2]) * 1000, webCap: R.pick([12, 15, 20]) * 1000, dbCap: R.pick([10, 15, 20]) * 1000, personal: lv === 3, price: { cdn: R.int(4, 8) * 100, cdn2: R.int(2, 5) * 100, redis: R.int(6, 12) * 100, replica: R.int(10, 16) * 100 } };
      },
      text: (I) => `<p>${I.app}'s launch forecast at peak: <b>${K.num(I.stat)}</b> static asset requests/s, <b>${K.num(I.page)}</b> product page views/s (3 DB queries each: product, pricing rules, stock), <b>${K.num(I.api)}</b> product API calls/s (2 queries: product, pricing rules), plus ${K.num(I.other)} other queries/s. The web tier serves <b>${K.num(I.webCap)} req/s</b>; Postgres should stay under 75% of <b>${K.num(I.dbCap)} queries/s</b> (read replicas triple read capacity).${I.personal ? " <b>Product pages now show member-only prices and the cart badge.</b>" : ""}</p><p>Choose the cheapest set of caches that carries the launch without serving wrong or someone else's data.</p>`,
      ui: (I) => ({ opts: CP.map((c) => `${c.t} · ${c.cost ? mo(I.price[c.cost]) : "free"}`), allowNone: true, live: (sel) => cpHTML(I, sel) }),
      valid: (I, sel) => cpSim(I, sel).fail || true,
      val: (I, sel) => cpSim(I, sel).cost,
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      hint: (I) => I.lv === 1 ? "Static assets don't belong on your web tier at all. Then look at what each DB query per request costs." : I.lv === 2 ? "Some caches are cheap and remove a query from every request; others serve data that must be exact or private." : "A shared cache must only hold responses that are identical for everyone.",
      concept: "Where to cache",
      how: "Each cache layer removes load from everything behind it: a CDN takes requests off the web tier, an in-process cache removes a query per request for tiny hot data at zero cost, and a shared cache-aside Redis absorbs repeated row reads. Placement is constrained by correctness: shared caches (CDN, gateway) may only hold responses that are identical for every user, or must key on the user; data used to make decisions (stock for reservation, balances) must be read from the source of truth. Read replicas add capacity but cost a full database each.",
      rule: "Cache as far out as the data's audience allows: immutable static at the CDN, shared-but-changing data in a TTL cache, per-user data only in per-user caches, and decision data never.",
      why: (I, sol) => { const r = cpSim(I, sol); return `Cheapest safe set: ${sol.map((i) => esc(CP[i].t.split(" (")[0])).join("; ") || "none"}: web ${K.num(r.web)} req/s, Postgres ${K.num(r.db)} q/s, ${mo(r.cost)}.`; },
    },
  ]);

  /* ---------- consistency classification ---------- */
  const CONS = {
    strong: ["Reserve the last seat on a flight", "Debit a prepaid wallet (the balance must never go negative)", "Claim a unique username at signup", "Redeem a single-use gift card code", "Acquire the job scheduler's leader lease", "Transfer money between two accounts"],
    ryw: ["A user edits their display name and reloads their own profile", "A user posts a comment and expects to see it under the post", "A user changes notification settings and reopens the settings page", "A seller updates a listing's photos and checks the listing"],
    eventual: ["Like count on a viral post", "'Customers also bought' recommendations", "Follower count shown on other people's profiles", "Search results including a product added a minute ago", "Daily active users on the analytics dashboard", "Trending hashtags", "'Only 3 left!' badge on the product page (checkout re-checks stock)"],
  };

  /* ---------- feature shedding ---------- */
  const SHED = [
    { id: "recs", t: "Personalised recommendations", load: 12, v: 3 },
    { id: "auto", t: "Search autocomplete", load: 6, v: 2 },
    { id: "rev", t: "Reviews and ratings widget", load: 5, v: 2 },
    { id: "recent", t: "Recently viewed items", load: 3, v: 1 },
    { id: "badge", t: "Live stock badges", load: 4, v: 1 },
    { id: "hist", t: "Order history pages", load: 7, v: 3 },
    { id: "wish", t: "Wishlists", load: 4, v: 2 },
    { id: "search5", t: "Degrade: serve search from a 5-minute cache", load: 8, v: 1, lv: 3 },
    { id: "img", t: "Degrade: lower image quality on product pages", load: 5, v: 1, lv: 3 },
    { id: "checkout", t: "Checkout and payment", load: 20, v: 50, core: true },
    { id: "login", t: "Login and sessions", load: 8, v: 50, core: true },
    { id: "pdp", t: "Product pages", load: 18, v: 50, core: true },
  ];
  function shedSim(I, sel) {
    const opts = I.feats.map((k) => SHED[k]);
    const shedSet = new Set(sel || []);
    const base = opts.reduce((s, f, i) => s + (shedSet.has(i) ? 0 : f.load), 0) + I.fixed;
    const util = (base * I.x) / 100;
    const core = opts.find((f, i) => shedSet.has(i) && f.core);
    const lost = opts.reduce((s, f, i) => s + (shedSet.has(i) ? f.v : 0), 0);
    const t = tier(util * 100, 100, 1, 40, { slots: 8 });
    let fail = null;
    if (core) fail = `${core.t} is the business: shedding it is an outage, not a degradation`;
    else if (util > 0.85) fail = `the fleet would run at ${pc(util)} (keep ≤ 85% so p99 holds)`;
    return { util, lost, p99: t.p99, fail };
  }

  /* ---------- edge vs regions ---------- */
  const ER_USERS = ["NA", "EU", "APAC"], ER_REG = { "US only": ["US"], "US + EU": ["US", "EU"], "US + APAC": ["US", "APAC"], "US + EU + APAC": ["US", "EU", "APAC"] };
  function erSim(I, cfg) {
    const regs = ER_REG[cfg.regions], edge = cfg.edge === "on", res = [];
    ER_USERS.forEach((u, i) => {
      const s = regs.reduce((b, r) => (I.rtt[i][r] < I.rtt[i][b] ? r : b), regs[0]), r = I.rtt[i][s];
      const read = edge ? 2 * 15 + r + 40 : 3 * r + 40;
      const write = edge ? 2 * 15 + I.rtt[i].US + 40 : 3 * r + (s === "US" ? 0 : I.toUS[s]) + 40;
      res.push({ u, s, read, write });
    });
    const cost = (regs.length - 1) * I.regionPrice + (edge ? I.edgePrice : 0);
    let fail = null;
    const badR = res.find((x) => x.read > I.readSlo), badW = I.writeSlo ? res.find((x) => x.write > I.writeSlo) : null;
    if (badR) fail = `${badR.u} users wait ${badR.read} ms for a first read (target ${I.readSlo} ms)`;
    else if (badW) fail = `${badW.u} users wait ${badW.write} ms for a write (target ${I.writeSlo} ms)`;
    return { res, cost, fail };
  }

  /* ---------- launch war room ---------- */
  const WR_HIT = { 0: 0, 16: 0.5, 32: 0.7, 64: 0.8 };
  function wrDay(I, c, coarse) {
    const hit = WR_HIT[c.cache], shed = c.shed, apiF = shed ? 0.75 : 1, rpr = (shed ? 1.5 : 2) * (1 - hit);
    const conn = c.api * 20 > I.maxConn ? 1 - I.maxConn / (c.api * 20) : 0;
    let loads = day(I.peak, { spike: I.spikeAt, x: I.spike });
    if (coarse) { const mx = Math.max(...loads); loads = loads.filter((l) => l > 0.6 * mx); }
    return runDay(loads, (l) => {
      let err = 0, r = null;
      for (let it = 0; it < (coarse ? 6 : 12); it++) {
        const amp = c.retries === "immediate-3x" ? 3 * err : Math.min(0.1, 2 * err), L = l * (1 + amp);
        const a = tier(L * apiF, c.api, I.apiCap, 30, { timeout: 3000 }), d = tier(L * rpr, c.reps, I.dbCap, 8, { timeout: 3000 });
        const e = 1 - (1 - a.err) * (1 - d.err) * (1 - conn);
        r = { p99: a.p99 + d.p99, err: e, rho: Math.max(a.rho, d.rho), a: a.rho, d: d.rho };
        err = e;
      }
      return r;
    });
  }
  const wrCost = (I, c) => c.api * I.apiPrice + c.reps * I.repPrice + c.cache * I.gbPrice;
  const wrPass = (I, c, coarse) => { const d = wrDay(I, c, coarse); return d.worst <= I.slo && d.peakErr <= 0.005; };
  function wrBest(I) {
    let best = null;
    for (const retries of [I.init.retries]) for (const shed of I.lv === 3 ? [false, true] : [false]) for (const cache of [0, 16, 32, 64]) for (let reps = 1; reps <= 8; reps++) {
      const lim = Math.min(120, Math.floor(I.maxConn / 20));
      for (let api = 4; api <= lim; api++) {
        const c = { api, reps, cache, retries, shed };
        if (best && wrCost(I, c) >= best.cost) break;
        if (wrPass(I, c, true) && wrPass(I, c, false)) { best = { c, cost: wrCost(I, c) }; break; }
      }
    }
    return best;
  }
  function wrShell(I) {
    const cfgOf = (st) => st.c;
    const simText = (st) => {
      const d = wrDay(I, st.c), rows = [];
      for (let i = 0; i < 48; i += 4) rows.push([SD.hm(i / 2), K.ms(d.p99[i]), pc(d.err[i])]);
      const sp = Math.round(I.spikeAt * 2); rows.push([SD.hm(I.spikeAt) + " (launch)", K.ms(d.p99[sp]), pc(d.err[sp])]);
      const ok = d.worst <= I.slo && d.peakErr <= 0.005;
      return K.cols([["TIME", "P99", "ERRORS"], ...rows]) + `\n\nworst p99 ${K.ms(d.worst)} (SLO ${I.slo} ms) · worst error rate ${pc(d.peakErr)} (SLO 0.5%) · api ${pc(Math.min(9.99, d.maxRho))} peak util\nverdict: ${ok ? "PASS" : "FAIL"} · cost ${mo(wrCost(I, st.c))} (budget ${mo(I.budget)})`;
    };
    const sh = K.shell([
      { re: /^launchctl status$/, use: "launchctl status", desc: "current capacity plan", run: (m, st) => { const c = cfgOf(st); return K.cols([["COMPONENT", "SETTING"], ["api replicas", `${c.api} × ${I.apiCap} req/s, 20 DB connections each (max_connections ${I.maxConn})`], ["db read replicas", `${c.reps} × ${K.num(I.dbCap)} reads/s`], ["cache", `${c.cache} GB (hit ratio ${pc(WR_HIT[c.cache])})`], ["client retries", c.retries], ["recommendations", c.shed ? "SHED" : "on"], ["monthly cost", `${mo(wrCost(I, c))} of ${mo(I.budget)} budget`]]); } },
      { re: /^launchctl forecast$/, use: "launchctl forecast", desc: "traffic forecast for launch day", run: () => `evening peak ${K.num(I.peak)} req/s; launch at ${SD.hm(I.spikeAt)} spikes to ${K.num(I.peak * I.spike)} req/s\neach request: API work + 2 DB reads (cache first; recommendations cause 0.5 of them) + 0.1 writes\nrecommendations are 25% of API work` },
      { re: /^launchctl simulate$/, use: "launchctl simulate", desc: "replay launch day against the current plan", run: (m, st) => simText(st) },
      { re: /^launchctl scale api (\d+)$/, use: "launchctl scale api <n>", desc: "set API replicas", run: (m, st) => { st.c.api = Math.max(1, Math.min(200, +m[1])); return `api scaled to ${st.c.api} replicas (${st.c.api * 20} DB connections)`; } },
      { re: /^launchctl db replicas (\d+)$/, use: "launchctl db replicas <n>", desc: "set read replica count", run: (m, st) => { st.c.reps = Math.max(1, Math.min(12, +m[1])); return `read replicas: ${st.c.reps}`; } },
      { re: /^launchctl cache resize (\d+)$/, use: "launchctl cache resize <0|16|32|64>", desc: "resize the cache (GB)", run: (m, st) => { if (WR_HIT[+m[1]] == null) return "error: size must be 0, 16, 32 or 64"; st.c.cache = +m[1]; return `cache resized to ${st.c.cache} GB (warms in ~20 min)`; } },
      { re: /^launchctl retries (immediate-3x|backoff-jitter-2x)$/, use: "launchctl retries <immediate-3x|backoff-jitter-2x>", desc: "client retry policy (pushed via remote config)", run: (m, st) => { st.c.retries = m[1]; return `client retry policy: ${m[1]}${m[1] === "backoff-jitter-2x" ? " (with a 10% retry budget)" : ""}`; } },
      { re: /^launchctl (shed|unshed) recommendations$/, use: "launchctl shed|unshed recommendations", desc: "turn recommendations off/on", run: (m, st) => { st.c.shed = m[1] === "shed"; st.shedTouched = true; return `recommendations ${st.c.shed ? "shed (hidden on all pages)" : "back on"}`; } },
      { re: /^launchctl cache flush$/, use: "launchctl cache flush", desc: "flush the cache", run: () => ({ out: "cache flushed", danger: "a cold cache sends every read to the database at once" }) },
      { re: /^launchctl db failover$/, use: "launchctl db failover", desc: "fail over the primary", run: () => ({ out: "failover complete in 41 s", danger: "an unnecessary failover dropped all writes for 41 s" }) },
    ], { sh: "bash" });
    return {
      prompt: "$", init: { c: { ...I.init } }, run: (line, st) => sh.run(line, st), par: I.solve.length + 3,
      motd: `Launch day prep for ${I.app} · go-live ${SD.hm(I.spikeAt)}\nSLO: p99 ≤ ${I.slo} ms, errors ≤ 0.5% · budget ${mo(I.budget)}/month\nType "help". Start with launchctl forecast / launchctl simulate.`,
      cmds: ["launchctl status", "launchctl forecast", "launchctl simulate", "launchctl scale api <n>", "launchctl db replicas <n>", "launchctl cache resize <gb>", "launchctl retries <policy>", "launchctl shed recommendations"],
      live: (a) => { const st = a && a.st ? a.st : { c: { ...I.init } }; const d = wrDay(I, st.c); return K.metrics([{ name: "Worst p99", value: K.ms(d.worst), ok: d.worst <= I.slo, target: `≤ ${I.slo} ms` }, { name: "Worst errors", value: pc(d.peakErr), ok: d.peakErr <= 0.005, target: "≤ 0.5%" }, { name: "Monthly cost", value: mo(wrCost(I, st.c)), ok: wrCost(I, st.c) <= I.budget, target: `≤ ${mo(I.budget)}` }]) + dayChart(d, I.slo); },
    };
  }

  /* ---------- queue smoothing ---------- */
  function qsSim(I, cfg) {
    const half = day(I.peak, { spike: 12, x: I.spike }), steps = [];
    half.forEach((v) => { for (let k = 0; k < 6; k++) steps.push(v); });
    const sync = cfg.mode === "synchronous call";
    const out = Math.min(cfg.cons * I.per, I.wh);
    let back = 0, worst = 0, worstX = 0, err = 0, tot = 0;
    const age = [];
    steps.forEach((inR) => {
      tot += inR;
      if (sync) { if (inR > I.wh) err += inR - I.wh; age.push(0); return; }
      back = Math.max(0, back + (inR - out) * 300);
      const a = back / out / 60;
      // a priority lane serves express first, so express only waits if express alone outruns the consumers
      const ax = !I.express ? 0 : cfg.lanes === "priority lane for express" ? (inR * I.express > out ? 99 : 0) : a;
      age.push(a); worst = Math.max(worst, a); worstX = Math.max(worstX, ax);
    });
    const cost = sync ? 0 : cfg.cons * I.price + I.qPrice + (I.express && cfg.lanes === "priority lane for express" ? I.lanePrice : 0);
    let fail = null;
    if (sync && err > 0) fail = `at peak the warehouse API rejects ${pc(err / tot)} of the day's orders with 429s (it accepts ${K.num(I.wh)}/s)`;
    else if (!sync && cfg.cons * I.per > I.wh * 1.0001) fail = `${cfg.cons} consumers send ${K.num(cfg.cons * I.per)} msgs/s, above the warehouse API's ${K.num(I.wh)}/s: the excess just collects 429s`;
    else if (!sync && worst > I.sla) fail = `the oldest message waits ${K.num(worst)} min at the worst point (limit ${I.sla} min)`;
    else if (!sync && I.express && worstX > I.xsla) fail = `express orders wait up to ${K.num(worstX)} min behind standard orders (limit ${I.xsla} min)`;
    return { age, worst, worstX, out, cost, fail };
  }

  /* ---------- DR plan ---------- */
  function drSim(I, cfg) {
    const restore = I.tb * 1 + 0.5; // hours: snapshot restore + WAL replay
    const logical = { "daily snapshots": 24 * 3600, "hourly snapshots": 3600, "continuous WAL archiving (PITR)": 0 }[cfg.backup];
    let region = { "daily snapshots": 24 * 3600, "hourly snapshots": 3600, "continuous WAL archiving (PITR)": 60 }[cfg.backup];
    const hasX = cfg.replica !== "none", az0 = cfg.replica === "sync standby in another AZ + async cross-region" || cfg.replica === "sync cross-region replica";
    if (cfg.replica === "async cross-region replica" || cfg.replica === "sync standby in another AZ + async cross-region") region = Math.min(region, 5);
    if (cfg.replica === "sync cross-region replica") region = 0;
    const az = az0 ? 0 : hasX ? 5 : region;
    const rto = cfg.standby === "hot (full size, automated failover)" && hasX ? 5 / 60 : cfg.standby === "warm (scaled-down replica, scale up)" && hasX ? 0.5 : restore + (cfg.standby === "cold (provision on failover)" ? 1 : 0.25);
    const writeAdd = cfg.replica === "sync cross-region replica" ? I.xrtt : az0 ? 2 : 0;
    const cost = I.price.backup[cfg.backup] + I.price.replica[cfg.replica] + I.price.standby[cfg.standby];
    let fail = null;
    const f = (s) => (s >= 3600 ? s / 3600 + " h" : s >= 60 ? s / 60 + " min" : s + " s");
    if (cfg.standby !== "cold (provision on failover)" && !hasX) fail = "a warm or hot standby needs a cross-region replica to keep it current";
    else if (region > I.rpoRegion) fail = `losing the region loses up to ${f(region)} of writes (RPO ${f(I.rpoRegion)})`;
    else if (rto > I.rtoRegion) fail = `recovering from a region loss takes ~${K.num(rto, 1)} h (RTO ${K.num(I.rtoRegion, 2)} h)`;
    else if (logical > I.rpoLogical) fail = `a bad migration that deletes rows replicates everywhere; restoring loses up to ${f(logical)} (RPO ${f(I.rpoLogical)})`;
    else if (I.rpoAz === 0 && az > 0) fail = `losing the primary's AZ loses up to ${f(az)} of acknowledged writes (RPO 0)`;
    else if (writeAdd > I.writeBudget) fail = `synchronous cross-region commits add ${writeAdd} ms to every write (budget ${I.writeBudget} ms)`;
    return { region, logical, az, rto, cost, fail, writeAdd };
  }

  /* ---------- cells ---------- */
  function cellSim(I, cfg) {
    const n = cfg.cells, wave = Math.min(cfg.wave, Math.max(1, n - 1));
    const waves = n === 1 ? 1 : 1 + need((n - 1) / wave), hours = (waves * I.bake) / 60;
    const blast = 1 / n, wave2 = Math.min(1, (1 + wave) / n), cellCap = (I.users / n) * 1.3, whaleFits = !I.whale || I.whale * I.users <= 0.5 * cellCap;
    const cost = n * I.fixed + I.users * I.perUser;
    let fail = null;
    if (blast > I.blast + 1e-9) fail = `one bad cell (poison tenant, bad config) takes out ${pc(blast)} of users (limit ${pc(I.blast)})`;
    else if (I.wave2 && wave2 > I.wave2 + 1e-9) fail = `a bug noticed only after the second wave has reached ${pc(wave2)} of users (limit ${pc(I.wave2)})`;
    else if (hours > I.deadline) fail = `a full rollout takes ${K.num(hours, 1)} h (${waves} waves × ${I.bake} min bake; limit ${I.deadline} h)`;
    else if (!whaleFits) fail = `the largest tenant (${pc(I.whale)} of users) needs more than half of a ${M(I.users / n)}-user cell`;
    return { blast, wave2, hours, waves, cost, fail };
  }

  /* ---------- SPOF hunt ---------- */
  const SPOF_POOL = {
    1: [
      { label: "DNS", sub: "managed, anycast", spof: false },
      { label: "Load balancer", sub: "managed, 3 zones", spof: false },
      { label: "API ×6", sub: "3 zones", spof: false },
      { label: "Redis ×1", sub: "session store", spof: true, why: "every API call looks up the session in a single Redis node" },
      { label: "Postgres", sub: "auto-failover standby", spof: false },
      { label: "Payment provider", sub: "single provider", spof: true, why: "one provider, no fallback: if it's down, nobody can pay" },
    ],
    2: [
      { label: "Load balancer", sub: "managed, 3 zones", spof: false },
      { label: "API ×9", sub: "3 zones", spof: false },
      { label: "NAT gateway", sub: "zone A only", spof: true, why: "every outbound call to the payment provider leaves through one NAT gateway in one zone" },
      { label: "Config svc ×3", sub: "read per request", spof: false },
      { label: "Feature flags ×1", sub: "SDK caches, fails open", spof: false },
      { label: "Kafka ×3", sub: "RF=3, min.insync=2", spof: false },
      { label: "Redis ×1", sub: "cart store", spof: true, why: "the cart lives only in one Redis node, so checkout can't read it" },
      { label: "Postgres", sub: "primary + sync standby", spof: false },
    ],
    3: [
      { label: "Load balancer", sub: "managed, 3 zones", spof: false },
      { label: "API ×12", sub: "3 zones", spof: false },
      { label: "Redis + Sentinel ×3", sub: "app pins primary IP", spof: true, why: "Sentinel promotes a replica, but the app has the old primary's IP hard-coded and never follows" },
      { label: "Postgres", sub: "async, manual failover", spof: true, why: "failover is manual (~30 min), so losing the primary is an outage until someone acts" },
      { label: "NAT ×2", sub: "one per zone", spof: false },
      { label: "Auth svc ×4", sub: "2 zones", spof: false },
      { label: "Receipts bucket", sub: "single region, async", spof: false },
      { label: "Feature flags ×1", sub: "SDK caches, fails open", spof: false },
      { label: "Internal CA", sub: "issues 24 h certs, ×1", spof: true, why: "service certificates live 24 h and only one CA instance renews them: if it's down for a day, every mTLS call fails" },
    ],
  };
  const spofNodes = (I) => I.order.map((k) => SPOF_POOL[I.lv][k]);

  /* ---------- notification pipeline ---------- */
  const NP_STEPS = [
    { id: "dedupe", t: "Drop duplicates by event ID (producers deliver at least once)" },
    { id: "prefs", t: "Load the user's channel preferences and opt-outs" },
    { id: "txn", t: "Route transactional messages (OTP, security alerts) around quiet hours and caps", lv: 3 },
    { id: "quiet", t: "Quiet hours in the user's time zone: defer marketing messages until morning", lv: 2 },
    { id: "cap", t: "Frequency cap: at most 3 marketing pushes per user per day", lv: 2 },
    { id: "render", t: "Render the template in the user's locale" },
    { id: "send", t: "Send via the provider with an idempotency key; retry 5xx and timeouts with backoff and jitter" },
    { id: "record", t: "Record the outcome; delete device tokens the provider reports as unregistered" },
    { id: "x1", t: "Send first, then check preferences to update analytics", trap: "opted-out users get messages" },
    { id: "x2", t: "Retry 400 'invalid device token' responses until they succeed", trap: "a permanent error never succeeds; it just burns quota" },
    { id: "x3", t: "Drop marketing messages that fall in quiet hours", trap: "quiet hours should defer, not lose, the message", lv: 2 },
    { id: "x4", t: "Apply quiet hours using the server's time zone (UTC)", trap: "users in other time zones get woken at night", lv: 2 },
    { id: "x5", t: "Apply the frequency cap to one-time passcodes too", trap: "a user who asks for a fourth OTP can't log in", lv: 3 },
  ];
  const NP_ALL = (lv) => NP_STEPS.filter((s) => !s.lv || s.lv <= lv);
  const NP_REQ = (lv) => (lv === 1 ? ["dedupe", "prefs", "render", "send", "record"] : lv === 2 ? ["dedupe", "prefs", "quiet", "cap", "render", "send", "record"] : ["dedupe", "prefs", "txn", "quiet", "cap", "render", "send", "record"]);
  const NP_ORDER = [["dedupe", "prefs"], ["prefs", "render"], ["prefs", "quiet"], ["prefs", "cap"], ["quiet", "render"], ["cap", "render"], ["txn", "quiet"], ["txn", "cap"], ["dedupe", "txn"], ["render", "send"], ["send", "record"]];
  function npCheck(I, seq) {
    const all = NP_ALL(I.lv), ids = seq.map((k) => all[I.order[k]].id), pos = (id) => ids.indexOf(id);
    const trap = ids.map((id) => all.find((s) => s.id === id)).find((s) => s.trap);
    if (trap) return `<b>${esc(trap.t)}</b>: ${esc(trap.trap)}.`;
    const miss = NP_REQ(I.lv).filter((id) => pos(id) < 0);
    if (miss.length) return `The pipeline is missing ${miss.length === 1 ? "a required step" : miss.length + " required steps"}.`;
    for (const [a, b] of NP_ORDER) if (pos(a) >= 0 && pos(b) >= 0 && pos(a) > pos(b)) return `Order problem: <b>${esc(all.find((s) => s.id === b).t)}</b> can't come before <b>${esc(all.find((s) => s.id === a).t)}</b>.`;
    return true;
  }

  /* ---------- degradation modes ---------- */
  const DM = [
    ["Auth token validation service is unreachable (any API call)", 0], ["Permission check for deleting a shared document times out", 0], ["Payment authorisation provider returns 503 at checkout", 0], ["Fraud check times out on a $4,000 order (policy: manual review above $500)", 0],
    ["Rate limiter's Redis is unreachable", 1], ["Analytics event collector is down", 1], ["Fraud check times out on a $12 order (policy: auto-approve below $50)", 1],
    ["Price service is down while rendering the catalog (checkout re-prices)", 2], ["Feature-flag service is down at startup (last-known flags cached on disk)", 2], ["Exchange-rate API is down when showing local-currency estimates", 2], ["Config service unreachable (last good config in memory)", 2],
    ["Recommendations service times out on the product page", 3], ["Reviews service is down", 3], ["Search suggestions service is down", 3], ["Loyalty-points widget in the header can't load", 3],
  ];

  LB.addAll("sd", [
    {
      id: "sd-consistency",
      name: "Choose consistency per feature",
      kind: "Design review",
      skills: ["design", "comms"],
      w: "classify",
      gen(lv, R) {
        const pick = (k, n) => R.sample(CONS[k], n).map((t) => ({ t, c: k }));
        const items = lv === 1 ? [...pick("strong", 3), ...pick("eventual", 3)] : lv === 2 ? [...pick("strong", 2), ...pick("ryw", 2), ...pick("eventual", 3)] : [...pick("strong", 3), ...pick("ryw", 2), ...pick("eventual", 3)];
        if (lv === 3 && !items.some((x) => /Only 3 left/.test(x.t))) items[items.length - 1] = { t: CONS.eventual[6], c: "eventual" };
        return { lv, items: R.shuffle(items) };
      },
      text: (I) => `<p>A product spans several regions. Strong (linearizable) operations need a coordinated write across replicas (~100 ms and less availability during a partition); weaker guarantees are local and cheap. For each feature, pick the <b>weakest guarantee that is still correct</b>:</p><ul><li><b>Strong</b>: every read sees the latest committed write; conflicting operations are serialised.</li>${I.lv > 1 ? "<li><b>Read-your-writes</b>: a user always sees their own changes (e.g. route that user's reads to the primary or a caught-up replica for a while); others may see them later.</li>" : ""}<li><b>Eventual</b>: replicas converge; a read may be a few seconds stale.</li></ul>`,
      ui: (I) => ({ items: I.items.map((x) => x.t), cats: I.lv === 1 ? ["Strong", "Eventual"] : ["Strong", "Read-your-writes", "Eventual"], live: (a) => { if (!a) return ""; const cats = I.lv === 1 ? ["strong", "eventual"] : ["strong", "ryw", "eventual"]; const s = a.filter((x) => cats[x] === "strong").length; return a.some((x) => x < 0) ? "" : K.metrics([{ name: "Coordinated operations", value: `${s} of ${a.length}`, ok: null, target: "each adds ~100 ms and fails during a partition" }]); } }),
      ans: (I) => { const cats = I.lv === 1 ? ["strong", "eventual"] : ["strong", "ryw", "eventual"]; return I.items.map((x) => cats.indexOf(x.c)); },
      diag: (I, a) => { const cats = I.lv === 1 ? ["strong", "eventual"] : ["strong", "ryw", "eventual"]; const wrong = I.items.map((x, i) => (cats.indexOf(x.c) !== a[i] ? i : -1)).filter((i) => i >= 0); const unsafe = wrong.find((i) => a[i] > cats.indexOf(I.items[i].c)); return `${wrong.length} feature${wrong.length === 1 ? " is" : "s are"} misclassified.${unsafe != null ? ` At least one is too weak: think about what goes wrong when two people do it at the same moment, or when someone reloads right after a change.` : " Some are stronger than they need to be, which costs latency and availability."}`; },
      hint: (I) => I.lv === 1 ? "Ask: if two requests race, or a replica is a few seconds behind, does anything break that can't be fixed later?" : I.lv === 2 ? "Read-your-writes is for things a user changes and immediately looks at themselves; nobody else needs to see it instantly." : "A display can be stale if the decision that matters is re-checked strongly somewhere else.",
      concept: "Per-feature consistency",
      how: "Consistency is a per-operation choice, not a system-wide one. Operations that enforce an invariant under concurrency (uniqueness, non-negative balances, the last unit of stock, a single leader) need linearizable, coordinated writes. Most user-facing reads only need read-your-writes: the author must see their own change immediately, typically by pinning their reads to the primary or a replica that has caught up to their last write. Counters, feeds, recommendations and analytics tolerate staleness and benefit from local, cheap, always-available reads. A stale display is fine when the decision is re-validated strongly at the point of commit.",
      rule: "Pay for strong consistency only where an invariant is enforced; give authors read-your-writes; let everything else be eventual, and re-check at commit time.",
      why: (I) => `<ul>${I.items.map((x) => `<li>${esc(x.t)}: <b>${{ strong: "Strong", ryw: "Read-your-writes", eventual: "Eventual" }[x.c]}</b></li>`).join("")}</ul>`,
    },
    {
      id: "sd-shed-load",
      name: "Shed features to survive the spike",
      kind: "Decision",
      skills: ["design", "comms"],
      w: "select",
      gen(lv, R) {
        const pool = U.range(SHED.length).filter((k) => !SHED[k].lv || SHED[k].lv <= lv);
        return { lv, feats: R.shuffle(pool), fixed: 0, x: lv === 1 ? R.pick([1.15, 1.2]) : lv === 2 ? R.pick([1.4, 1.5]) : R.pick([1.7, 1.8]), app: R.pick(APPS) };
      },
      text: (I) => `<p>${I.app}'s launch is drawing <b>${K.num(I.x, 2)}×</b> the forecast traffic and there's no time to add capacity. The table shows each feature's share of fleet capacity at the forecast (they add up to ${K.num(I.feats.reduce((s, k) => s + SHED[k].load, 0))}%). Keep the fleet at <b>≤ 85%</b> so p99 holds.</p>${K.table(["Feature", "Capacity at forecast", "Business value"], I.feats.map((k) => [esc(SHED[k].t) + (SHED[k].core ? " (core)" : ""), SHED[k].load + "%", SHED[k].core ? "core" : String(SHED[k].v)]), { compact: true })}<p>Select the features to <b>shed or degrade</b> so the fleet fits, losing as little value as possible.</p>`,
      ui: (I) => ({ opts: I.feats.map((k) => SHED[k].t), allowNone: true, live: (sel) => { const r = shedSim(I, sel || []); return K.metrics([{ name: "Fleet utilisation", value: pc(r.util), ok: r.util <= 0.85, target: "≤ 85%" }, { name: "Estimated p99", value: K.ms(r.p99), ok: r.util <= 0.85 }, { name: "Value lost", value: String(r.lost), ok: null }]) + (r.fail ? K.note(esc(r.fail), "bad") : ""); } }),
      valid: (I, sel) => shedSim(I, sel).fail || true,
      val: (I, sel) => shedSim(I, sel).lost,
      sense: "min",
      vname: "a value loss of",
      hint: (I) => I.lv === 1 ? "Find how much capacity you must free, then the cheapest-value features that free it." : I.lv === 2 ? "It's a knapsack: compare value lost per percent of capacity freed." : "Degraded modes keep most of a feature's value for little capacity. Count them first.",
      concept: "Graceful degradation",
      how: "When demand exceeds capacity, either everything gets slow and fails together, or you deliberately turn off what matters least so the core keeps working. That requires features to be independently switchable (kill switches, feature flags) and a pre-agreed priority list. Degraded modes, such as cached search results, lower image quality or static recommendations, keep most of a feature's value at a fraction of its cost and are often better than switching it off. Shedding has to happen before the fleet saturates: past ~85% utilisation, queueing makes p99 explode for everything.",
      rule: "Decide your shedding order before launch day: core flows never, degraded modes first, then the features with the least value per unit of capacity.",
      why: (I, sol) => { const r = shedSim(I, sol); return `Shed: ${sol.map((i) => esc(SHED[I.feats[i]].t)).join(", ") || "nothing"} → ${pc(r.util)} utilisation, value lost ${r.lost}.`; },
    },
    {
      id: "sd-edge-or-region",
      name: "Edge or another region?",
      kind: "Decision",
      skills: ["design", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const eu = R.pick([85, 90, 95]), ap = R.pick([150, 160, 170]);
        return { lv, app: R.pick(APPS), rtt: [{ US: R.pick([30, 35]), EU: eu + 10, APAC: ap + 20 }, { US: eu, EU: 25, APAC: 170 }, { US: ap, EU: 170, APAC: 25 }], toUS: { EU: eu - 5, APAC: ap - 10 }, readSlo: lv === 1 ? 350 : lv === 2 ? 200 : 140, writeSlo: lv === 3 ? 260 : 0, regionPrice: R.int(15, 25) * 1000, edgePrice: R.int(2, 5) * 1000 };
      },
      text: (I) => `<p>${I.app}'s API runs only in the US. A first request costs 3 round trips to wherever TLS terminates (TCP, TLS 1.3, request) + 40 ms of server time. A CDN edge terminates TLS ~15 ms from users and forwards over warm connections, so a request costs 2 × 15 ms + one round trip to the serving region + 40 ms.</p>${K.table(["Users", "→ US", "→ EU", "→ APAC"], ER_USERS.map((u, i) => [u, I.rtt[i].US + " ms", I.rtt[i].EU + " ms", I.rtt[i].APAC + " ms"]), { compact: true })}<p>Targets: first-request reads under <b>${I.readSlo} ms</b> for every user group${I.writeSlo ? `; writes (which must reach the single US primary: EU→US ${I.toUS.EU} ms, APAC→US ${I.toUS.APAC} ms from a regional deployment) under <b>${I.writeSlo} ms</b>` : ""}. Another region costs <b>${mo(I.regionPrice)}</b>; the edge costs <b>${mo(I.edgePrice)}</b>. Find the cheapest option.</p>`,
      ui: (I) => ({ knobs: [{ k: "regions", label: "Regions", opts: Object.keys(ER_REG) }, { k: "edge", label: "Edge TLS termination", opts: ["off", "on"] }], init: { regions: "US only", edge: "off" }, live: (cfg) => { const r = erSim(I, cfg); return K.table(["Users", "Served from", "First read", ...(I.writeSlo ? ["Write"] : [])], r.res.map((x) => [x.u, x.s, `<span class="${x.read > I.readSlo ? "lose" : ""}">${x.read} ms</span>`, ...(I.writeSlo ? [`<span class="${x.write > I.writeSlo ? "lose" : ""}">${x.write} ms</span>`] : [])]), { compact: true }) + K.metrics([{ name: "Monthly cost", value: mo(r.cost), ok: null }]) + (r.fail ? K.note(esc(r.fail), "bad") : ""); } }),
      valid: (I, cfg) => erSim(I, cfg).fail || true,
      val: (I, cfg) => erSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Most of the far users' latency is handshakes, not the request itself." : I.lv === 2 ? "The edge removes handshake round trips but not the last one to the region. Which users still miss the target with the edge alone?" : "Writes still go to the US primary. Which path to the primary is shortest: through a regional deployment, or straight from the edge?",
      concept: "Latency: handshakes, edges and regions",
      how: "A new HTTPS connection costs a TCP round trip plus a TLS 1.3 round trip before the request's own round trip, so a user 160 ms from your region waits ~500 ms before the server does anything. Terminating TLS at a nearby edge and reusing warm connections to the origin removes the long-distance handshakes: only one long round trip remains. A full region removes that last one for reads but costs a whole stack, and writes to a single primary still cross the ocean, sometimes via a longer path than the edge would take.",
      rule: "Cut round trips before adding regions: terminate TLS at the edge, keep connections warm, and add a region only where the remaining one round trip still misses the target.",
      why: (I, sol) => { const r = erSim(I, sol); return `Cheapest: ${sol.regions}, edge ${sol.edge}: ${r.res.map((x) => `${x.u} ${x.read} ms`).join(", ")}${I.writeSlo ? `; writes ${r.res.map((x) => `${x.u} ${x.write} ms`).join(", ")}` : ""}, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-launch-war-room",
      name: "Launch day war room",
      kind: "Capacity plan",
      skills: ["tune", "diagnose", "estimate"],
      ...LB.term({
        shell: (I) => wrShell(I),
        goal: (st, I) => {
          if (I.lv < 3 && st.c.shed) return "Product vetoed shedding recommendations today: there's a cheaper capacity fix.";
          const d = wrDay(I, st.c);
          if (d.worst > I.slo || d.peakErr > 0.005) return `The launch-day replay still fails: worst p99 ${K.ms(d.worst)}, worst errors ${pc(d.peakErr)}.`;
          const c = wrCost(I, st.c);
          return c <= I.budget ? true : `The plan passes but costs ${mo(c)}, over the ${mo(I.budget)} budget.`;
        },
        solve: (I) => ({ log: I.solve }),
      }),
      gen(lv, R) {
        const I = { lv, app: R.pick(APPS), peak: (lv === 1 ? R.int(15, 22) : lv === 2 ? R.int(24, 30) : R.int(26, 32)) * 1000, spike: lv === 3 ? 1.5 : 1.3, spikeAt: 18, apiCap: 900, dbCap: 6000, maxConn: lv === 1 ? 3000 : 1000, slo: 300, apiPrice: 250, repPrice: R.int(9, 12) * 100, gbPrice: 15 };
        I.init = lv === 1 ? { api: R.int(10, 16), reps: 3, cache: 32, retries: "backoff-jitter-2x", shed: false } : lv === 2 ? { api: 36, reps: 2, cache: 0, retries: "backoff-jitter-2x", shed: false } : { api: 40, reps: 3, cache: 16, retries: "backoff-jitter-2x", shed: false };
        const best = wrBest(I);
        if (!best) return null;
        I.budget = Math.ceil((best.cost * (lv === 1 ? 1.4 : lv === 2 ? 1.15 : 1.06)) / 100) * 100;
        if (wrPass(I, I.init) && wrCost(I, I.init) <= I.budget) return null;
        const b = best.c, log = ["launchctl simulate"];
        if (b.retries !== I.init.retries) log.push("launchctl retries " + b.retries);
        if (b.shed) log.push("launchctl shed recommendations");
        if (b.cache !== I.init.cache) log.push("launchctl cache resize " + b.cache);
        if (b.reps !== I.init.reps) log.push("launchctl db replicas " + b.reps);
        if (b.api !== I.init.api) log.push("launchctl scale api " + b.api);
        log.push("launchctl simulate");
        I.solve = log;
        return I;
      },
      bad: (I) => [{ log: ["launchctl scale api " + Math.min(200, Math.floor(I.maxConn / 20) + 10)] }, { log: ["launchctl db replicas 12", "launchctl scale api 60"] }],
      text: (I) => `<p>${I.app} launches at ${SD.hm(I.spikeAt)}, during the evening peak. You own the capacity plan. Use <code>launchctl</code> to replay launch day against the plan and change it until the replay passes (<b>p99 ≤ ${I.slo} ms, errors ≤ 0.5%</b>) within a <b>${mo(I.budget)}/month</b> budget.${I.lv === 3 ? " Recommendations may be shed if that's the only way to fit the budget." : ""}</p><p>Prices: API replica ${mo(I.apiPrice)}, DB read replica ${mo(I.repPrice)}, cache ${K.usd(I.gbPrice)}/GB-month.</p>`,
      hint: (I) => I.lv === 1 ? "Simulate first, then fix the tier that saturates." : I.lv === 2 ? "Each API replica opens 20 DB connections and max_connections is limited. If the database is the bottleneck, more API replicas make it worse; take reads off it instead." : "Price out the cheapest pure-capacity fix first. If it can't fit the budget, what does shedding recommendations remove from both the API and the database?",
      concept: "Launch-day capacity planning",
      how: "A launch plan is validated by replaying the expected traffic, including the launch spike on top of the organic peak, against every tier. The bottleneck moves: scaling the stateless tier pushes load onto the database and multiplies connections toward max_connections, so the fix is often to take reads off the database (cache, replicas). Client retry policy is part of capacity: immediate retries amplify load exactly when the system is struggling and can turn a brief overload into a collapse (a retry storm), while backoff, jitter and a retry budget cap amplification. Shedding a low-value feature is a legitimate lever when the budget is fixed.",
      rule: "Replay the launch against the whole stack, fix the bottleneck tier rather than the one that's easiest to scale, make clients back off, and keep a shed list for when money runs out.",
      why: (I) => `A plan that passes within budget: ${esc(I.solve.slice(1, -1).join("; ") || "no changes")}.${I.lv === 2 ? " The database, not the API, was saturated, and more API replicas would have exceeded max_connections." : I.lv === 3 ? " No capacity-only plan fits the budget: shedding recommendations removes a quarter of API work and a quarter of DB reads at once." : ""}`,
    },
    {
      id: "sd-queue-smoothing",
      name: "Smooth the peak with a queue",
      kind: "Capacity plan",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const peak = R.pick([120, 200, 300]);
        return { lv, app: R.pick(APPS), peak, spike: R.pick([2, 2.5]), per: R.pick([10, 15, 20]), wh: Math.round(peak * R.pick([1.2, 1.5])), sla: lv === 1 ? 60 : lv === 2 ? 20 : 30, express: lv === 3 ? R.pick([0.1, 0.15]) : 0, xsla: 2, price: R.int(4, 8) * 10, qPrice: 50, lanePrice: R.int(1, 3) * 100 };
      },
      text: (I) => `<p>Every ${I.app} order must be sent to the warehouse API, which accepts <b>${K.num(I.wh)} orders/s</b> (429 above that). Orders peak at <b>${K.num(I.peak)}/s</b> in the evening and a noon promotion spikes them to <b>${K.num(I.peak * I.spike)}/s</b> for about an hour.</p><p>Checkout can call the warehouse synchronously, or publish to a queue that consumers drain (each sends <b>${I.per}/s</b>, ${mo(I.price)}; the queue costs ${mo(I.qPrice)}). Every order must reach the warehouse within <b>${I.sla} minutes</b>${I.express ? `; <b>express</b> orders (${pc(I.express)}) within <b>${I.xsla} minutes</b>. A separate priority lane for express orders costs ${mo(I.lanePrice)}` : ""}.</p><p>Find the cheapest setup.</p>`,
      ui: (I) => {
        const knobs = [{ k: "mode", label: "Integration", opts: ["synchronous call", "queue + consumers"] }, { k: "cons", label: "Consumers", opts: U.range(30).map((i) => i + 1) }];
        if (I.express) knobs.push({ k: "lanes", label: "Queue layout", opts: ["one FIFO queue", "priority lane for express"] });
        return { knobs, init: { mode: "synchronous call", cons: 4, lanes: "one FIFO queue" }, live: (cfg) => { const r = qsSim(I, cfg); return K.metrics([{ name: "Drain rate", value: cfg.mode === "synchronous call" ? "–" : K.num(r.out) + "/s", ok: null }, { name: "Oldest message", value: cfg.mode === "synchronous call" ? "–" : K.num(r.worst) + " min", ok: r.worst <= I.sla, target: `≤ ${I.sla} min` }, ...(I.express ? [{ name: "Express wait", value: r.worstX >= 99 ? "unbounded" : K.num(r.worstX) + " min", ok: r.worstX <= I.xsla, target: `≤ ${I.xsla} min` }] : []), { name: "Monthly cost", value: mo(r.cost), ok: null }]) + (cfg.mode === "synchronous call" ? "" : K.chart([{ name: "oldest message (min)", pts: r.age.map((v, i) => [i / 12, v]), cls: r.worst > I.sla ? "bad" : "s0" }], { h: 110, ymin: 0, hline: { y: I.sla, label: `SLA ${I.sla} min` }, title: "Queue age across the day", xfmt: SD.hm, fmt: (v) => K.num(v) })) + (r.fail ? K.note(esc(r.fail), "bad") : ""); } };
      },
      valid: (I, cfg) => qsSim(I, cfg).fail || true,
      val: (I, cfg) => qsSim(I, cfg).cost + (cfg.mode === "synchronous call" ? 0 : 0),
      hint: (I) => I.lv === 1 ? "A queue lets consumers run near the average rate instead of the peak, as long as the backlog drains within the SLA." : I.lv === 2 ? "Size consumers so the spike's backlog clears in time, but never above what the warehouse accepts." : "In one FIFO, express orders wait behind the whole backlog. Is a bigger fleet or a separate lane cheaper?",
      concept: "Queues for load levelling",
      how: "A queue between a spiky producer and a rate-limited consumer turns a peak into a backlog: consumers can be sized near the average rate, and the backlog drains after the spike, at the cost of delay. The maximum delay is roughly the peak backlog divided by the drain rate, so the SLA on message age sets how far below the peak you can provision. Consumers above the downstream limit just collect 429s. Priority lanes let urgent messages bypass the backlog without sizing the whole fleet for their deadline.",
      rule: "Size consumers so the worst backlog drains within the age SLA, cap them at the downstream limit, and give urgent traffic its own lane instead of overprovisioning for it.",
      why: (I, sol) => { const r = qsSim(I, sol); return sol.mode === "synchronous call" ? "Synchronous calls fit." : `Cheapest: ${sol.cons} consumers (${K.num(r.out)}/s)${I.express ? `, ${sol.lanes}` : ""}: the noon spike builds a backlog that peaks at ${K.num(r.worst)} min of age, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-dr-plan",
      name: "Pick the disaster recovery plan",
      kind: "Design review",
      skills: ["design", "safe"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const p = (a, b) => R.int(a, b) * 100;
        return { lv, app: R.pick(APPS), tb: R.pick([2, 4, 6]), xrtt: R.pick([70, 80, 90]), rpoRegion: lv === 1 ? 3600 : lv === 2 ? 60 : 10, rtoRegion: lv === 1 ? 8 : lv === 2 ? 1 : 0.25, rpoLogical: lv === 1 ? 86400 : lv === 2 ? 900 : 300, rpoAz: lv === 3 ? 0 : 99999, writeBudget: lv === 3 ? 10 : 999, price: { backup: { "daily snapshots": p(1, 2), "hourly snapshots": p(3, 5), "continuous WAL archiving (PITR)": p(5, 8) }, replica: { none: 0, "async cross-region replica": p(20, 30), "sync standby in another AZ + async cross-region": p(40, 55), "sync cross-region replica": p(30, 40) }, standby: { "cold (provision on failover)": 0, "warm (scaled-down replica, scale up)": p(5, 10), "hot (full size, automated failover)": p(20, 30) } } };
      },
      text: (I) => `<p>${I.app}'s ${I.tb} TB Postgres needs a DR plan. Restoring from backups takes ~1 h per TB plus 30 min of WAL replay. Requirements:</p><ul><li>losing the region: RPO <b>${I.rpoRegion >= 3600 ? I.rpoRegion / 3600 + " h" : I.rpoRegion + " s"}</b>, RTO <b>${I.rtoRegion >= 1 ? I.rtoRegion + " h" : I.rtoRegion * 60 + " min"}</b></li><li>a bad migration that deletes rows (replicas copy the damage): RPO <b>${I.rpoLogical >= 3600 ? I.rpoLogical / 3600 + " h" : I.rpoLogical / 60 + " min"}</b></li>${I.lv === 3 ? `<li>losing the primary's AZ: <b>no acknowledged write lost</b>; writes may get at most <b>${I.writeBudget} ms</b> slower (cross-region RTT ${I.xrtt} ms)</li>` : ""}</ul><p>WAL archiving ships to the other region every 60 s; async replicas lag ~5 s. Pick the cheapest plan.</p>`,
      ui: (I) => ({ knobs: [{ k: "backup", label: "Backups", opts: Object.keys(I.price.backup), select: true }, { k: "replica", label: "Replication", opts: Object.keys(I.price.replica), select: true }, { k: "standby", label: "Standby compute", opts: Object.keys(I.price.standby), select: true }], init: { backup: "daily snapshots", replica: "none", standby: "cold (provision on failover)" }, live: (cfg) => { const r = drSim(I, cfg); const f = (s) => (s >= 3600 ? s / 3600 + " h" : s >= 60 ? s / 60 + " min" : s + " s"); return K.metrics([{ name: "Region RPO", value: f(r.region), ok: r.region <= I.rpoRegion }, { name: "Region RTO", value: r.rto >= 1 ? K.num(r.rto, 1) + " h" : Math.round(r.rto * 60) + " min", ok: r.rto <= I.rtoRegion }, { name: "Bad-migration RPO", value: f(r.logical), ok: r.logical <= I.rpoLogical }, ...(I.lv === 3 ? [{ name: "AZ-loss RPO", value: f(r.az), ok: r.az === 0 }, { name: "Added write latency", value: r.writeAdd + " ms", ok: r.writeAdd <= I.writeBudget }] : []), { name: "Monthly cost", value: mo(r.cost), ok: null }]) + (r.fail ? K.note(esc(r.fail), "bad") : ""); } }),
      valid: (I, cfg) => drSim(I, cfg).fail || true,
      val: (I, cfg) => drSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Daily backups lose up to a day; restore time grows with database size." : I.lv === 2 ? "Replicas protect against losing hardware, not against a bad DELETE: that needs point-in-time recovery." : "RPO 0 needs a synchronous copy, but a cross-region one blows the write budget. Where else can it live?",
      concept: "RPO, RTO and the failures they cover",
      how: "RPO is how much acknowledged data you can lose; RTO is how long recovery takes. Different failures need different mechanisms: replicas (async lose seconds, sync lose nothing but add the round trip to every commit) cover hardware, AZ and region loss; they faithfully replicate logical corruption, so a bad migration needs backups with point-in-time recovery (base backups plus continuous WAL archiving). RTO is set by what's waiting: restoring terabytes takes hours, a warm standby needs scaling up, a hot standby with automated failover takes minutes. Each step down in RPO/RTO multiplies cost, so match them to the business requirement per failure mode.",
      rule: "List failure modes separately (AZ, region, logical corruption), give each an RPO/RTO, and buy the cheapest mechanism per row: sync replication nearby, async far away, PITR always.",
      why: (I, sol) => { const r = drSim(I, sol); return `Cheapest plan: ${esc(sol.backup)}, ${esc(sol.replica)}, ${esc(sol.standby)}: ${mo(r.cost)}.`; },
    },
    {
      id: "sd-cells",
      name: "Size the cells",
      kind: "Design review",
      skills: ["design", "safe"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        return { lv, app: R.pick(APPS), users: R.pick([4, 8, 12]) * 1e6, fixed: R.int(3, 8) * 1000, perUser: 0.01, bake: R.pick([30, 45, 60]), deadline: lv === 1 ? 24 : R.pick([4, 6]), blast: lv === 1 ? R.pick([0.25, 0.15]) : R.pick([0.1, 0.07]), wave2: lv > 1 ? R.pick([0.25, 0.3]) : 0, whale: lv === 3 ? R.pick([0.025, 0.035, 0.04]) : 0 };
      },
      text: (I) => `<p>${I.app} is moving to a <b>cell-based architecture</b>: ${M(I.users)} users split across identical, independent cells (each with its own app tier and database), so one bad deploy, poison tenant or overloaded database hurts only one cell. Each cell has a fixed cost of <b>${mo(I.fixed)}</b> on top of per-user costs.</p><ul><li>One failed cell may affect at most <b>${pc(I.blast)}</b> of users.</li><li>Deploys go to one canary cell, then in waves; each wave bakes <b>${I.bake} min</b>. A full rollout must finish within <b>${I.deadline} h</b>.</li>${I.wave2 ? `<li>A bug noticed only after the second wave may reach at most <b>${pc(I.wave2)}</b> of users.</li>` : ""}${I.whale ? `<li>The largest tenant has <b>${pc(I.whale)}</b> of all users and must fit within half of one cell's capacity (cells have 30% headroom).</li>` : ""}</ul><p>Find the cheapest layout.</p>`,
      ui: (I) => ({ knobs: [{ k: "cells", label: "Cells", opts: [1, 2, 4, 8, 12, 16, 24, 32, 48, 64] }, { k: "wave", label: "Cells per wave after the canary", opts: [1, 2, 3, 4, 6, 8, 16] }], init: { cells: 1, wave: 1 }, live: (cfg) => { const r = cellSim(I, cfg); return K.metrics([{ name: "Blast radius", value: pc(r.blast), ok: r.blast <= I.blast + 1e-9, target: `≤ ${pc(I.blast)}` }, ...(I.wave2 ? [{ name: "After wave 2", value: pc(r.wave2), ok: r.wave2 <= I.wave2 + 1e-9, target: `≤ ${pc(I.wave2)}` }] : []), { name: "Rollout time", value: `${K.num(r.hours, 1)} h (${r.waves} waves)`, ok: r.hours <= I.deadline, target: `≤ ${I.deadline} h` }, { name: "Monthly cost", value: mo(r.cost), ok: null }]) + (r.fail ? K.note(esc(r.fail), "bad") : ""); } }),
      valid: (I, cfg) => cellSim(I, cfg).fail || true,
      val: (I, cfg) => cellSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Blast radius is 1 ÷ cells; each cell has a fixed cost." : I.lv === 2 ? "More cells mean more waves; bigger waves mean more users hit before you notice. Find a cell count where some wave size satisfies both." : "The whale puts an upper bound on the number of cells. Check it against the lower bound from the blast radius.",
      concept: "Cell-based architecture",
      how: "Cells are complete, isolated copies of a service, each serving a fixed slice of customers through a thin routing layer. They bound the blast radius of bad deploys, poison tenants and noisy neighbours to one cell, and let you roll out progressively cell by cell. More, smaller cells shrink the blast radius but add fixed per-cell cost and more deployment waves; bigger waves speed rollouts but expose more users before a problem is caught. The largest customer must still fit in a cell, which caps how small cells can be.",
      rule: "Pick the cell count from the blast radius you can tolerate, bounded above by your biggest tenant, then choose wave sizes that meet the rollout deadline without exposing too much before the bake catches problems.",
      why: (I, sol) => { const r = cellSim(I, sol); return `Cheapest: ${sol.cells} cells, ${sol.wave} per wave: blast radius ${pc(r.blast)}, rollout ${K.num(r.hours, 1)} h, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-spof-hunt",
      name: "Find the single points of failure",
      kind: "Design review",
      skills: ["diagnose", "design"],
      w: "topo",
      gen(lv, R) { return { lv, order: R.shuffle(U.range(SPOF_POOL[lv].length)) }; },
      text: (I) => `<p>Before launch, the reliability review asks: <b>which single component failure takes checkout down</b> (for more than a minute)? Every component below is on the checkout path; the small print on each box says how it's deployed.</p><p>Click every component that is a single point of failure for checkout.</p>`,
      ui: (I) => { const ns = spofNodes(I), rows = Math.ceil(ns.length / 3); return { nodes: ns.map((n, i) => ({ label: n.label, sub: n.sub, x: 140 + (i % 3) * 200, y: 150 + (Math.floor(i / 3) - (rows - 1) / 2) * 95 })), links: [], mode: "nodes", nodeVerb: "flagged", bw: 164, W: 720, H: 300 }; },
      ans: (I) => ({ down: spofNodes(I).map((n, i) => (n.spof ? i : -1)).filter((i) => i >= 0), cut: [] }),
      diag: (I, a) => { const want = spofNodes(I).map((n, i) => (n.spof ? i : -1)).filter((i) => i >= 0); const d = a.down || []; const hit = d.filter((i) => want.includes(i)).length; return `${hit} of your ${d.length} flags are real SPOFs, and you found ${hit} of ${want.length}. Read the deployment notes: a replica that clients can't fail over to, or a manual failover, doesn't count as redundancy.`; },
      hint: (I) => I.lv === 1 ? "Look for anything with exactly one instance that checkout can't do without." : I.lv === 2 ? "Redundancy in one zone isn't redundancy; a single instance behind a cache that fails open isn't fatal." : "Three nodes don't help if clients can't find the new one, and a failover that needs a human is an outage.",
      concept: "Single points of failure",
      how: "A SPOF is any component whose single failure stops the critical path. Counting replicas isn't enough: the redundancy must be reachable (clients follow a failover, not a hard-coded address), automatic (a manual 30-minute failover is an outage), independent (two instances in one zone share fate), and still needed (a dependency that's cached and fails open, or only used asynchronously, isn't on the critical path). Hidden SPOFs hide in plumbing: NAT gateways, certificate authorities, DNS, config services and secrets stores.",
      rule: "Walk the critical path component by component and ask what happens in the first minute after it dies: if the answer is 'someone has to do something', it's a SPOF.",
      why: (I) => `<ul>${spofNodes(I).filter((n) => n.spof).map((n) => `<li><b>${esc(n.label)}</b>: ${esc(n.why)}</li>`).join("")}</ul>`,
    },
    {
      id: "sd-notify-pipeline",
      name: "Order the notification pipeline",
      kind: "Design review",
      skills: ["design", "safe"],
      w: "steps",
      gen(lv, R) { return { lv, app: R.pick(APPS), order: R.shuffle(U.range(NP_ALL(lv).length)) }; },
      text: (I) => `<p>${I.app}'s notification service turns events (order shipped, new follower, weekly promo${I.lv === 3 ? ", login code, new-device alert" : ""}) into push notifications. Events are delivered at least once. ${I.lv > 1 ? "Marketing must respect each user's quiet hours and a daily cap. " : ""}${I.lv === 3 ? "Security messages and one-time passcodes must always go out immediately. " : ""}Build the per-message pipeline in order; leave out steps that would do the wrong thing.</p>`,
      ui: (I) => ({ opts: I.order.map((k) => NP_ALL(I.lv)[k].t) }),
      accept: (I, seq) => npCheck(I, seq),
      solve: (I) => NP_REQ(I.lv).map((id) => I.order.findIndex((k) => NP_ALL(I.lv)[k].id === id)),
      bad: (I) => { const ix = (id) => I.order.findIndex((k) => NP_ALL(I.lv)[k].id === id); const req = NP_REQ(I.lv).map(ix); return [[ix("x1"), ...req.filter((i) => i !== ix("prefs"))], req.slice().reverse(), req.slice(1)]; },
      hint: (I) => I.lv === 1 ? "Cheap filters first (duplicates, opt-outs), expensive work (rendering, sending) last." : I.lv === 2 ? "Deferring is not dropping, and 'night' depends on where the user is." : "Which messages must never be delayed or capped, and where do they leave the marketing path?",
      concept: "Notification pipelines",
      how: "Notification systems sit between at-least-once event streams and users who hate spam. The pipeline deduplicates by event ID first (producers retry), then applies preferences and opt-outs before doing any expensive work. Policies like quiet hours (in the user's local time) and frequency caps defer or drop marketing messages, while transactional messages such as passcodes and security alerts bypass them. Sending uses an idempotency key and retries only transient failures; permanent errors like unregistered tokens must clean up the token instead.",
      rule: "Dedupe, filter, then decide when (quiet hours, caps, with transactional bypass), then render and send idempotently; treat permanent errors as data, not retries.",
      why: (I) => `Reference pipeline: ${NP_REQ(I.lv).map((id) => esc(NP_STEPS.find((s) => s.id === id).t.split(":")[0].split(" (")[0])).join(" → ")}.`,
    },
    {
      id: "sd-degrade-modes",
      name: "Plan failure behaviour per dependency",
      kind: "Hardening",
      skills: ["design", "safe"],
      w: "classify",
      gen(lv, R) {
        const by = [0, 1, 2, 3].map((c) => DM.filter((d) => d[1] === c));
        let items;
        if (lv === 1) items = by.map((g) => R.pick(g));
        else if (lv === 2) items = [...R.sample(by[0], 2), ...R.sample(by[1].filter((d) => !/Fraud/.test(d[0])), 1), ...R.sample(by[2], 2), ...R.sample(by[3], 1)];
        else items = [DM[3], DM[6], ...R.sample(by[0].filter((d) => !/Fraud/.test(d[0])), 1), ...R.sample(by[1].filter((d) => !/Fraud/.test(d[0])), 1), ...R.sample(by[2], 2), ...R.sample(by[3], 2)];
        return { lv, items: R.shuffle(items) };
      },
      text: (I) => `<p>The resilience review asks each team to declare what happens when a dependency fails, so the behaviour is designed rather than accidental. For each failure, choose the response:</p><ul><li><b>Fail closed</b>: refuse the operation (safety or money is at stake).</li><li><b>Fail open</b>: carry on without the dependency.</li><li><b>Serve stale</b>: use the last known good data.</li><li><b>Hide feature</b>: drop that part of the page.</li></ul>`,
      ui: (I) => ({ items: I.items.map((d) => d[0]), cats: ["Fail closed", "Fail open", "Serve stale", "Hide feature"] }),
      ans: (I) => I.items.map((d) => d[1]),
      diag: (I, a) => { const wrong = I.items.filter((d, i) => d[1] !== a[i]).length; const openBad = I.items.some((d, i) => d[1] === 0 && a[i] !== 0); return `${wrong} answer${wrong === 1 ? " is" : "s are"} off.${openBad ? " Something that protects security or money is not failing closed." : ""}`; },
      hint: (I) => I.lv === 1 ? "Who gets hurt if you carry on: the user, the business, or nobody?" : I.lv === 2 ? "'Serve stale' needs a last-known-good copy and a later step that re-validates; 'hide' is for nice-to-haves." : "The same dependency can need different answers depending on the stakes: read the policy in each line.",
      concept: "Fail open, fail closed, serve stale, hide",
      how: "Every dependency call needs a designed failure mode. Security and money checks (authentication, authorisation, payment, high-value fraud) fail closed, because carrying on is worse than an error. Protective or observational systems (rate limiters, analytics) usually fail open, with alerts, so they can't take the product down. Data that changes slowly or is re-validated later (catalog prices re-checked at checkout, flags, config, FX estimates) is served from the last known good copy. Optional page components are hidden. The same dependency may need different policies depending on the stakes, like fraud checks on small vs large orders.",
      rule: "Fail closed on security and money, fail open on protective and observational systems, serve stale what is re-validated later, and hide what is optional; write it down per dependency and test it.",
      why: (I) => `<ul>${I.items.map((d) => `<li>${esc(d[0])}: <b>${["Fail closed", "Fail open", "Serve stale", "Hide feature"][d[1]]}</b></li>`).join("")}</ul>`,
    },
  ]);
})();
