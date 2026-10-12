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
})();
