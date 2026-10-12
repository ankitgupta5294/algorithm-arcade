/* Systems Lab · Kafka (part 1: partitioning, durability, producers, delivery semantics, log cleanup, schemas).
   Simulators in this file: a partitioner (FNV-1a hash mod partitions as a stand-in for Kafka's murmur2), a replica/ISR
   log model replayed against broker faults, and small interpreters for consume-transform-produce schedules. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util, C = D.campaign;
  const esc = U.esc;
  const rng = (s) => C.rng(s);
  // Kafka's default partitioner hashes the serialized key with murmur2 and takes it modulo the partition count.
  // FNV-1a (K.hash) stands in for murmur2 here: same mechanism, different numbers.
  const partOf = (key, n) => K.hash(String(key)) % n;
  // A tiny argv parser for kafka-*.sh style command lines: --flag value | --flag
  const argv = (line) => {
    const t = line.match(/'[^']*'|"[^"]*"|\S+/g) || [], o = { _: [] };
    const uq = (x) => x.replace(/^['"]|['"]$/g, "");
    for (let i = 1; i < t.length; i++) {
      const x = uq(t[i]);
      if (x.startsWith("--")) { const nx = t[i + 1]; if (nx != null && !nx.startsWith("--")) { o[x.slice(2)] = uq(nx); i++; } else o[x.slice(2)] = true; }
      else o._.push(x);
    }
    return o;
  };
  const trace = (lanes, log) => K.table(["#", ...lanes.map((l) => esc(l.name))], log.map((e, k) => [String(k + 1), ...lanes.map((_, j) => (j === e.t ? `<span class="mono">${esc(e.label)}</span>${e.note ? `<br><small class="${e.err ? "lose" : "muted"}">${esc(e.note)}</small>` : ""}` : ""))]), { compact: true });
  const allInterleavings = function* (lens) {
    const left = lens.slice(), cur = [], total = lens.reduce((a, b) => a + b, 0);
    function* go() { if (cur.length === total) { yield cur.slice(); return; } for (let l = 0; l < left.length; l++) if (left[l] > 0) { left[l]--; cur.push(l); yield* go(); cur.pop(); left[l]++; } }
    yield* go();
  };

  /* ================= partition key model ================= */
  const KEYLV = {
    1: {
      topic: "order-events", P: 12, lam: 6000, need: "every event of one order (created → paid → shipped) is processed in order",
      keys: [
        { id: "null", label: "no key (null: sticky partitioner)", ok: false, why: "Null-keyed records are spread over partitions batch by batch, so an order's events land on different partitions and are consumed out of order." },
        { id: "order_id", label: "order_id", ok: true },
        { id: "customer_id", label: "customer_id", ok: true },
        { id: "merchant_id", label: "merchant_id", ok: true },
        { id: "event_type", label: "event_type", ok: false, why: "An order's <i>created</i> and <i>shipped</i> events have different event types, so they go to different partitions with no ordering between them. It also gives you at most 5 busy partitions." },
      ],
    },
    2: {
      topic: "wallet-ledger", lam: 12000, need: "every debit and credit of one wallet is applied in order, and the stream is joined with <code>wallet-limits</code> (24 partitions, keyed by wallet_id) in Kafka Streams",
      keys: [
        { id: "null", label: "no key (null: sticky partitioner)", ok: false, why: "Without a key a wallet's entries are scattered across partitions, so balances are applied out of order, and the join can't find matching keys in the co-partitioned topic." },
        { id: "wallet_id", label: "wallet_id", ok: true },
        { id: "txn_id", label: "txn_id", ok: false, why: "Every transaction id is unique, so one wallet's debits and credits are scattered over all partitions." },
        { id: "merchant_id", label: "merchant_id", ok: false, why: "A wallet pays many merchants, so its entries end up on many partitions." },
        { id: "wallet_cur", label: "wallet_id + currency", ok: false, why: "Balance checks span the whole wallet; splitting a wallet by currency lets a EUR debit overtake a USD credit it depends on. The join on wallet_id also stops being co-partitioned." },
      ],
    },
    3: {
      topic: "inventory-reservations", P: 32, lam: 20000, need: "reservations for one store's stock are applied in order (stock counts are kept per store; nothing is shared across a merchant's stores)",
      keys: [
        { id: "merchant_id", label: "merchant_id", ok: true },
        { id: "store_id", label: "store_id", ok: true },
        { id: "salted", label: "merchant_id + random suffix 0–7", ok: false, why: "Salting spreads the whale merchant, but a random suffix sends reservations for the same store to different partitions, so they race and stock goes negative." },
        { id: "sku", label: "sku", ok: false, why: "The same SKU is stocked in many stores and one store's reservations span many SKUs, so per-store ordering is lost." },
        { id: "order_id", label: "order_id", ok: false, why: "Two orders against the same store's stock land on different partitions, so they are applied in no particular order." },
      ],
    },
  };
  function keyEvents(I) {
    const R = rng(I.seed), ev = [];
    for (let i = 0; i < 2400; i++) {
      const whale = R.next() < I.whale;
      const m = whale ? 0 : 1 + Math.floor(R.next() * 60);
      const store = whale ? Math.floor(R.next() * 40) : Math.floor(R.next() * 4);
      const wallet = R.next() < 0.03 ? 0 : 1 + Math.floor(R.next() * 20000);
      ev.push({
        i, order_id: "o-" + (500000 + Math.floor(i / 3) * 7 + I.off), customer_id: "c-" + (1 + Math.floor(R.next() * 6000)), merchant_id: "m-" + m,
        event_type: ["created", "paid", "packed", "shipped", "delivered"][i % 5], wallet_id: "w-" + wallet, txn_id: "t-" + (i * 13 + I.off),
        cur: ["USD", "EUR", "GBP"][Math.floor(R.next() * 3)], store_id: `m-${m}/s-${store}`, sku: "sku-" + Math.floor(R.next() * 900), salt: Math.floor(R.next() * 8),
      });
    }
    return ev;
  }
  function keyLoads(I, key, P) {
    const ev = keyEvents(I), c = Array(P).fill(0);
    ev.forEach((e) => {
      let p;
      if (key === "null") p = Math.floor(e.i / 16) % P;
      else if (key === "wallet_cur") p = partOf(e.wallet_id + "|" + e.cur, P);
      else if (key === "salted") p = partOf(e.merchant_id + "#" + e.salt, P);
      else p = partOf(e[key], P);
      c[p]++;
    });
    return c.map((x) => Math.round((x / ev.length) * I.lam));
  }
  const keyCheck = (I, a) => {
    const L = KEYLV[I.lv], k = L.keys.find((x) => x.id === a.key);
    if (!k) return { ok: false, msg: "Pick a key." };
    const P = I.lv === 2 ? a.partitions : L.P;
    const loads = keyLoads(I, a.key, P), mx = Math.max(...loads);
    if (!k.ok) return { ok: false, msg: k.why, loads, P };
    if (I.lv === 2 && P !== 24) return { ok: false, msg: `A Kafka Streams join needs both inputs <b>co-partitioned</b>: same key and the same partition count. <code>wallet-limits</code> has 24 partitions; with ${P}, wallet w-123 lives on different partition numbers in the two topics and Streams refuses to start (TopologyException).`, loads, P };
    if (mx > I.cap) return { ok: false, msg: `Ordering is fine, but the hottest partition gets <b>${K.num(mx)} msg/s</b> and one consumer can only process ${K.num(I.cap)} msg/s on a partition. Its lag will grow forever no matter how many consumers you add.`, loads, P };
    return { ok: true, loads, P, mx };
  };

  /* ================= replica / ISR log model ================= */
  // cfg: { rf, minisr, acks: '0'|'1'|'all', unclean: 'true'|'false' }. Script events:
  // ['w', n] write n records · ['tick'] followers catch up · ['slow', b] follower b falls out of ISR · ['down', b] crash (comes back) ·
  // ['lose', b] crash with the disk destroyed · ['up', b] broker restarts. Brokers are 0..2, replicas are the first rf brokers, leader starts at 0.
  function durSim(cfg, events) {
    const rf = cfg.rf, reps = [0, 1, 2].slice(0, rf), unclean = cfg.unclean === "true";
    const B = [0, 1, 2].map(() => ({ log: [], up: true, gone: false, slow: false }));
    let leader = 0, isr = new Set(reps), id = 0, rejected = 0, unav = 0, uncleanUsed = false;
    const acked = [], notes = [];
    const live = (b) => B[b].up && !B[b].gone;
    const elect = () => {
      const c = [...isr].filter(live);
      if (c.length) { leader = c[0]; return; }
      if (unclean) { const o = reps.filter(live); if (o.length) { leader = o[0]; isr = new Set([leader]); uncleanUsed = true; notes.push(`unclean election: B${leader + 1} (out of sync) became leader`); return; } }
      leader = -1;
    };
    const removeFromIsr = (b) => { if (!(isr.size === 1 && isr.has(b))) isr.delete(b); };
    for (const e of events) {
      const [k, x] = e;
      if (k === "w") {
        for (let n = 0; n < x; n++) {
          if (leader < 0) { rejected++; unav++; continue; }
          const rid = ++id;
          if (cfg.acks === "all") {
            if (isr.size < cfg.minisr) { rejected++; continue; }
            B[leader].log.push(rid);
            isr.forEach((f) => { if (f !== leader && live(f)) B[f].log = B[leader].log.slice(); });
          } else B[leader].log.push(rid);
          acked.push(rid);
        }
      } else if (k === "tick") {
        if (leader < 0) continue;
        reps.forEach((f) => { if (f !== leader && live(f) && !B[f].slow) { B[f].log = B[leader].log.slice(); isr.add(f); } });
      } else if (k === "slow") { if (reps.includes(x)) { B[x].slow = true; removeFromIsr(x); } }
      else if (k === "down" || k === "lose") {
        if (!reps.includes(x)) continue;
        B[x].up = false; if (k === "lose") { B[x].gone = true; B[x].log = []; }
        removeFromIsr(x);
        if (x === leader) elect();
      } else if (k === "up") {
        if (!reps.includes(x) || B[x].gone) continue;
        B[x].up = true; B[x].slow = false;
        if (leader < 0) { if (isr.has(x)) leader = x; else if (unclean) { leader = x; isr = new Set([x]); uncleanUsed = true; notes.push(`unclean election: B${x + 1} became leader`); } }
      }
    }
    // end of the story: every surviving broker comes back and catches up. A partition still offline would need an operator
    // to force an unclean election, so its contents are whatever the most complete surviving replica holds.
    reps.forEach((b) => { if (!B[b].gone) { B[b].up = true; B[b].slow = false; } });
    let offline = false;
    if (leader < 0) { const c = [...isr].filter(live); if (c.length) leader = c[0]; }
    let truth;
    if (leader >= 0) truth = B[leader].log;
    else { offline = true; const c = reps.filter(live).map((b) => B[b].log); truth = c.length ? c.sort((a, b) => b.length - a.length)[0] : []; }
    const have = new Set(truth);
    const lost = acked.filter((r) => !have.has(r)).length;
    return { acked: acked.length, rejected, unav, lost, offline, uncleanUsed, notes };
  }
  const DSCRIPTS = {
    A: { name: "Leader's disk dies", need: "noloss", text: "B1 (leader) takes 5 writes, followers catch up, 5 more writes arrive, then B1's disk fails for good.", ev: [["w", 5], ["tick"], ["w", 5], ["lose", 0]] },
    B: { name: "Rolling restart", need: "writable", text: "Brokers restart one at a time for a patch while producers keep writing.", ev: [["down", 1], ["w", 10], ["up", 1], ["tick"], ["down", 2], ["w", 10], ["up", 2], ["tick"], ["down", 0], ["w", 10], ["up", 0], ["tick"]] },
    C: { name: "Followers cut off, then leader dies", need: "noloss", text: "A network partition isolates the followers (they drop out of the ISR), writes continue for a minute, then B1's disk fails.", ev: [["w", 5], ["tick"], ["slow", 1], ["slow", 2], ["w", 10], ["lose", 0]] },
    D: { name: "Cascading crash", need: "noloss", text: "B3 lags out of the ISR, B1 (leader) crashes, then B2 crashes too. B1 and B2 come back 20 minutes later.", ev: [["w", 5], ["tick"], ["slow", 2], ["w", 10], ["down", 0], ["w", 10], ["down", 1], ["w", 5], ["up", 0], ["up", 1], ["tick"]] },
  };
  const DLV = { 1: ["A"], 2: ["A", "B", "C"], 3: ["A", "B", "C", "D"] };
  const durCheck = (I, cfg) => DLV[I.lv].map((k) => { const s = DSCRIPTS[k], r = durSim(cfg, s.ev); return { k, s, r, ok: s.need === "noloss" ? r.lost === 0 : r.rejected === 0 }; });

  /* ================= producer retry/ordering model ================= */
  function prodSim(I, c) {
    const idem = c.idem === "true", inflight = c.inflight;
    if (idem && c.acks !== "all") return { err: "ConfigException: Must set acks to all in order to use the idempotent producer. Otherwise we cannot guarantee idempotence." };
    if (idem && inflight > 5) return { err: "ConfigException: Must set max.in.flight.requests.per.connection to at most 5 to use the idempotent producer." };
    if (idem && c.retries === 0) return { err: "ConfigException: Must set retries to non-zero when using the idempotent producer." };
    const r = { lost: 0, dup: 0, reorder: false, thr: 0, events: [] };
    // fault 1: batch 2 hits NOT_LEADER_OR_FOLLOWER while batch 3 is already in flight
    if (c.retries === 0) { r.lost += I.batch; r.events.push("batch 2 failed with NOT_LEADER_OR_FOLLOWER and was not retried: " + I.batch + " records lost"); }
    else if (inflight > 1 && !idem) { r.reorder = true; r.events.push("batch 3 was written before the retry of batch 2: records out of order"); }
    else r.events.push("batch 2 retried after the leader moved" + (idem ? "; the broker keeps sequence order, so batch 3 waits its turn" : ""));
    // fault 2: batch 4 is written but its response is lost (request timeout), so the producer resends it
    if (c.retries === 0) { r.events.push("batch 4's response was lost; with no retries the send failed (it was actually written)"); }
    else if (!idem) { r.dup += I.batch; r.events.push("batch 4's response was lost and the retry wrote it again: " + I.batch + " duplicates"); }
    else r.events.push("batch 4's retry carried the same producer id and sequence number, so the broker dropped the duplicate");
    if (c.acks === "1") r.events.push("acks=1: the leader acknowledges before followers have the data (loses writes if the leader dies)");
    if (I.lv === 3) {
      if (c.dto < I.outage) { r.lost += I.outRecs; r.events.push(`the ${I.outage / 60000}-minute outage outlived delivery.timeout.ms=${c.dto / 1000}s: ${K.num(I.outRecs)} buffered records expired`); }
      else r.events.push(`records waited out the ${I.outage / 60000}-minute outage in the producer buffer and were delivered`);
    }
    r.thr = Math.round((inflight * I.batchKB) / (I.rtt / 1000) / 1024 * 10) / 10; // MB/s per connection
    return r;
  }
  const prodOk = (I, c) => {
    const r = prodSim(I, c);
    if (r.err) return { ok: false, msg: `The producer won't start: <code>${esc(r.err)}</code>`, r };
    if (c.acks !== "all") return { ok: false, msg: "acks=1 acknowledges a write the leader alone holds; if it dies before followers fetch, acknowledged payments are gone.", r };
    if (r.lost) return { ok: false, msg: `${K.num(r.lost)} records were lost: ${esc(r.events.find((e) => /lost|expired/.test(e)))}.`, r };
    if (r.dup) return { ok: false, msg: "Retries without idempotence wrote batch 4 twice. Retries are what make delivery reliable, and they are also what create duplicates unless the broker can recognise a resend.", r };
    if (I.lv >= 2 && r.reorder) return { ok: false, msg: "With several requests in flight and no idempotence, a retried batch lands after a later one: per-key order is broken.", r };
    if (I.lv >= 2 && r.thr < I.need) return { ok: false, msg: `Correct, but each connection only pushes ${r.thr} MB/s (in-flight × batch ÷ RTT) and you need ${I.need} MB/s.`, r };
    if (I.lv === 3 && c.dto > I.surface) return { ok: false, msg: `Delivery is safe, but with delivery.timeout.ms=${c.dto / 1000}s a dead partition isn't reported to the app for ${c.dto / 60000} minutes; the requirement is ${I.surface / 60000} minutes.`, r };
    return { ok: true, r };
  };

  /* ================= compaction model ================= */
  function compLog(I) {
    const R = rng(I.seed), keys = R.sample(["user-17", "user-42", "user-88", "user-91", "user-103", "user-256"], I.lv === 1 ? 4 : 5);
    const segs = [];
    let off = I.base;
    const nseg = 3;
    for (let s = 0; s < nseg; s++) {
      const recs = [];
      const n = s === nseg - 1 ? 3 : 4;
      for (let j = 0; j < n; j++) {
        const key = R.pick(keys);
        const tomb = I.lv > 1 && R.chance(0.22);
        recs.push({ off: off++, key, val: tomb ? null : `{"tier":"${R.pick(["gold", "silver", "free", "pro"])}","v":${R.int(2, 40)}}` });
      }
      segs.push({ recs, active: s === nseg - 1, cleaned: I.lv === 3 && s === 0 });
    }
    return segs;
  }
  function compRemoved(I, segs) {
    // cleanable = closed segments (the active segment is never cleaned)
    const cleanable = segs.filter((s) => !s.active).flatMap((s) => s.recs.map((r) => ({ ...r, seg: s })));
    const last = {};
    cleanable.forEach((r) => (last[r.key] = r.off));
    const gone = new Set();
    cleanable.forEach((r) => {
      if (last[r.key] !== r.off) gone.add(r.off);
      else if (r.val === null && r.seg.cleaned) gone.add(r.off); // tombstone older than delete.retention.ms
    });
    return gone;
  }
  function compLines(I) {
    const segs = compLog(I), lines = [], offs = [];
    segs.forEach((s, k) => {
      const name = String(s.recs[0].off).padStart(20, "0") + ".log";
      lines.push({ t: `${name}  ${s.active ? "(active segment)" : s.cleaned ? `(closed; cleaned 30 h ago, delete.retention.ms = 24 h)` : "(closed, never cleaned)"}`, k: "@" });
      offs.push(null);
      s.recs.forEach((r) => { lines.push({ t: `offset=${r.off}  key=${r.key}  value=${r.val === null ? "null  (tombstone)" : r.val}`, k: " " }); offs.push(r.off); });
      void k;
    });
    return { segs, lines, offs };
  }

  /* ================= consume-transform-produce interpreters ================= */
  const EOS = {
    1: {
      lanes: [
        { name: "consumer A (GC pause)", steps: ["poll() → offsets 40–49", "produce 10 results to payouts.out", "commitSync(offset 50)"] },
        { name: "consumer B", steps: ["rebalance: B is assigned the partition, fetches committed offset", "poll() from committed offset; produce results", "commitSync(offset 50)"] },
      ],
      goal: "Find a schedule where <code>payouts.out</code> ends up with duplicate results.",
    },
    2: {
      lanes: [
        { name: "enricher-0 (paused by GC)", steps: ["beginTransaction(); poll() → 40–49", "send 10 results (inside the transaction)", "sendOffsetsToTransaction(50); commitTransaction()"] },
        { name: "enricher-0' (replacement pod)", steps: ["initTransactions() with the same transactional.id", "beginTransaction(); poll() from committed offset; send results", "sendOffsetsToTransaction(50); commitTransaction()"] },
      ],
      goal: "Transactions are on. Find a schedule where the downstream <code>fraud-scorer</code> (default <code>isolation.level=read_uncommitted</code>) sees a result twice.",
    },
    3: {
      lanes: [
        { name: "payout-worker-0 (paused by GC)", steps: ["beginTransaction(); poll() → 40–49", "INSERT 10 rows into Postgres payouts; send 10 results", "sendOffsetsToTransaction(50); commitTransaction()"] },
        { name: "payout-worker-0' (replacement)", steps: ["initTransactions() with the same transactional.id", "beginTransaction(); poll() from committed offset; INSERT rows; send results", "sendOffsetsToTransaction(50); commitTransaction()"] },
      ],
      goal: "Exactly-once is on and every downstream Kafka consumer uses <code>read_committed</code>. Find a schedule where a customer is paid twice (duplicate rows in the Postgres <code>payouts</code> table).",
    },
  };
  function eosRun(lv, seq) {
    const S = { committed: 40, out: [], db: [], bJoined: false, aFenced: false, aOpen: false, aGot: false, bGot: false, aDone: false };
    const log = [], pos = [0, 0];
    const tx = lv >= 2;
    for (const l of seq || []) {
      const i = pos[l]++, label = EOS[lv].lanes[l].steps[i];
      let note = "", err = false;
      if (l === 0) {
        if (i === 0) {
          if (S.bJoined) { note = tx ? "fenced: the replacement already owns this transactional.id" : "partition was revoked; A has nothing to process"; err = true; }
          else { S.aGot = true; S.aOpen = tx; note = "A holds records 40–49"; }
        } else if (i === 1) {
          if (!S.aGot) note = "nothing to do";
          else {
            if (lv === 3) { S.db.push("A"); note = "10 payout rows INSERTed and committed in Postgres; "; }
            if (tx && S.aFenced) { note += "send() fails: ProducerFencedException"; err = true; }
            else { S.out.push({ by: "A", st: tx ? "open" : "committed" }); note += tx ? "10 results written, transaction still open" : "10 results written"; }
          }
        } else {
          if (!S.aGot) note = "nothing to commit";
          else if (tx && S.aFenced) { note = "ProducerFencedException: the transaction was aborted"; err = true; }
          else if (!tx && S.bJoined) { note = "CommitFailedException: the group rebalanced, the partition belongs to B now"; err = true; }
          else { S.committed = 50; S.out.forEach((o) => { if (o.by === "A" && o.st === "open") o.st = "committed"; }); S.aOpen = false; S.aDone = true; note = "offset 50 committed" + (tx ? " atomically with the results" : ""); }
        }
      } else {
        if (i === 0) {
          S.bJoined = true;
          if (tx) { S.aFenced = true; let ab = 0; S.out.forEach((o) => { if (o.by === "A" && o.st === "open") { o.st = "aborted"; ab++; } }); note = `producer epoch bumped: A is fenced${ab ? "; A's open transaction is aborted (its records stay in the log, marked aborted)" : ""}`; }
          else note = `B's committed offset is ${S.committed}`;
        } else if (i === 1) {
          if (S.committed >= 50) note = "committed offset is 50: nothing new to process";
          else { S.bGot = true; if (lv === 3) S.db.push("B"); S.out.push({ by: "B", st: tx ? "open" : "committed" }); note = (lv === 3 ? "10 payout rows INSERTed; " : "") + "reprocessed 40–49 and wrote 10 results"; }
        } else {
          if (!S.bGot) note = "nothing to commit";
          else { S.committed = 50; S.out.forEach((o) => { if (o.by === "B" && o.st === "open") o.st = "committed"; }); note = "offset 50 committed"; }
        }
      }
      log.push({ t: l, label, note, err });
    }
    const ru = S.out.length, rc = S.out.filter((o) => o.st === "committed").length;
    const broken = lv === 1 ? rc > 1 : lv === 2 ? ru > 1 : S.db.length > 1;
    return { S, log, ru, rc, broken, complete: (seq || []).length === 6 };
  }

  const COMMIT = {
    1: {
      lanes: [
        { name: "consumer (commits first)", steps: ["poll() → offsets 100–104", "commitSync(105)", "process 100–104: charge cards"] },
        { name: "chaos", steps: ["kubectl delete pod --force (SIGKILL); a new pod resumes from the committed offset"] },
      ],
      goal: "Find a schedule where a payment is never charged.",
    },
    2: {
      lanes: [
        { name: "poll loop (enable.auto.commit=true)", steps: ["poll() → 100–109, handed to a worker pool", "poll() → 110–119 (auto-commits 110 first)", "poll() → 120–129 (auto-commits 120 first)"] },
        { name: "worker pool", steps: ["finish 100–109", "finish 110–119"] },
        { name: "chaos", steps: ["SIGKILL; the new pod resumes from the committed offset"] },
      ],
      goal: "Find a schedule where some records are never processed.",
    },
    3: {
      lanes: [
        { name: "consumer", steps: ["poll() + process 100–109", "commitAsync(110) → request #1", "poll() + process 110–119", "commitAsync(120) → request #2", "OOMKilled; the new pod resumes from the committed offset"] },
        { name: "group coordinator", steps: ["request #1 fails (COORDINATOR_LOAD_IN_PROGRESS); the callback re-sends commitAsync(110) as #3", "request #2 succeeds", "request #3 succeeds"] },
      ],
      goal: "Find a schedule where the restarted consumer processes records a second time even though the code committed after processing.",
    },
  };
  function commitRun(lv, seq) {
    const S = { committed: 100, done: new Set(), dead: false, polled: 100, q: [], dupes: 0, lost: [] };
    const lanes = COMMIT[lv].lanes, pos = lanes.map(() => 0), log = [];
    const proc = (a, b) => { for (let o = a; o < b; o++) { if (S.done.has(o)) S.dupes++; S.done.add(o); } };
    let sent1 = false, sent2 = false, retry = false, f1 = false;
    for (const l of seq || []) {
      const i = pos[l]++, label = lanes[l].steps[i];
      let note = "", err = false;
      const isChaos = (lv === 1 && l === 1) || (lv === 2 && l === 2) || (lv === 3 && l === 0 && i === 4);
      if (isChaos) {
        S.dead = true;
        const end = lv === 1 ? 105 : lv === 2 ? 130 : 120;
        note = `restart resumes at offset ${S.committed}`;
        const before = new Set(S.done);
        proc(S.committed, Math.max(S.committed, end));
        const re = [...Array(Math.max(0, end - S.committed)).keys()].map((k) => k + S.committed).filter((o) => before.has(o));
        if (re.length) { note += `: reprocesses ${re[0]}–${re[re.length - 1]}`; err = true; }
        log.push({ t: l, label, note, err });
        continue;
      }
      if (S.dead && !(lv === 3 && l === 1)) { log.push({ t: l, label, note: "process is gone: skipped", err: false }); continue; }
      if (lv === 1) {
        if (i === 1) { S.committed = 105; note = "committed 105"; }
        if (i === 2) { proc(100, 105); note = "charged"; }
      } else if (lv === 2) {
        if (l === 0) {
          if (i === 1) { S.committed = 110; note = "auto-commit: offset 110 (whatever the workers have done)"; }
          if (i === 2) { S.committed = 120; note = "auto-commit: offset 120"; }
        } else { proc(i === 0 ? 100 : 110, i === 0 ? 110 : 120); note = "done"; }
      } else {
        if (l === 0) {
          if (i === 0) { proc(100, 110); note = "processed"; }
          if (i === 1) { sent1 = true; note = "in flight"; }
          if (i === 2) { proc(110, 120); note = "processed"; }
          if (i === 3) { sent2 = true; note = "in flight"; }
        } else {
          if (i === 0) { if (!sent1) note = "no request #1 in flight yet: nothing happens"; else { f1 = true; retry = true; note = "retry #3 = commit 110 queued"; } }
          if (i === 1) { if (!sent2) note = "no request #2 in flight yet: nothing happens"; else { S.committed = Math.max(S.committed, 120) === 120 ? 120 : S.committed; S.committed = 120; note = "committed 120"; } }
          if (i === 2) { if (!retry) note = f1 ? "" : "nothing to retry: request #1 hasn't failed"; else { S.committed = 110; note = "committed 110: the committed offset went backwards"; err = true; } }
        }
      }
      log.push({ t: l, label, note, err });
    }
    const end = lv === 1 ? 105 : lv === 2 ? 130 : 120;
    for (let o = 100; o < (lv === 2 ? 120 : end); o++) if (!S.done.has(o)) S.lost.push(o);
    const total = lanes.reduce((s, x) => s + x.steps.length, 0);
    const complete = (seq || []).length === total;
    const broken = lv === 3 ? S.dupes > 0 : complete && S.lost.length > 0;
    return { S, log, broken, complete };
  }

  /* ================= scenarios ================= */
  LB.addAll("kafka", [
    {
      id: "kafka-partition-key",
      name: "Choose the partition key",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      gen(lv, R) {
        const L = KEYLV[lv];
        const I = { lv, seed: `kpk/${lv}/${R.int(1, 1e9)}`, off: R.int(0, 999), whale: lv === 1 ? R.pick([0.3, 0.35, 0.4]) : lv === 3 ? R.pick([0.38, 0.42, 0.45]) : 0.1, lam: L.lam };
        const goodKey = lv === 1 ? "order_id" : lv === 2 ? "wallet_id" : "store_id";
        const loads = keyLoads(I, goodKey, lv === 2 ? 24 : L.P), mx = Math.max(...loads);
        I.cap = Math.ceil((mx * 1.25) / 100) * 100;
        const hot = Math.max(...keyLoads(I, "merchant_id", lv === 2 ? 24 : L.P));
        if (lv !== 2 && hot <= I.cap) return null;
        if (lv === 3 && Math.max(...keyLoads(I, "salted", L.P)) <= I.cap) { /* salting fails on ordering anyway */ }
        return I;
      },
      text: (I) => { const L = KEYLV[I.lv]; return `<p>You're designing the producer for <code>${L.topic}</code>: <b>${K.num(I.lam)} msg/s</b>${I.lv === 2 ? "" : ` over <b>${L.P}</b> partitions`}. The requirement: ${L.need}. A consumer can process at most <b>${K.num(I.cap)} msg/s</b> from one partition.</p>${I.lv === 1 ? `<p>One merchant accounts for about ${K.pct(I.whale, 0)} of all orders.</p>` : I.lv === 3 ? `<p>One merchant (a supermarket chain with 40 stores) produces about ${K.pct(I.whale, 0)} of all reservations.</p>` : "<p>The topic doesn't exist yet, so you also pick its partition count.</p>"}<p>Pick the key (the live panel runs a 2,400-event sample through the partitioner).</p>`; },
      ui: (I) => {
        const L = KEYLV[I.lv];
        const knobs = [{ k: "key", label: "Record key", opts: L.keys.map((k) => k.id), fmt: (v) => L.keys.find((k) => k.id === v).label, select: true }];
        if (I.lv === 2) knobs.push({ k: "partitions", label: "Partitions", opts: [12, 24, 36] });
        return {
          knobs, init: { key: L.keys[0].id },
          live: (a) => {
            if (!a) return "";
            const r = keyCheck(I, a), P = r.P || L.P;
            const loads = r.loads || keyLoads(I, a.key, P);
            return K.metrics([{ name: "Hottest partition", value: K.num(Math.max(...loads)) + " msg/s", ok: Math.max(...loads) <= I.cap, target: `≤ ${K.num(I.cap)}` }, { name: "Ordering requirement", value: L.keys.find((k) => k.id === a.key).ok ? "kept" : "broken", ok: L.keys.find((k) => k.id === a.key).ok }])
              + K.bars(loads.map((v, p) => ({ label: "p" + p, value: v, cls: v > I.cap ? "bad" : "", note: K.num(v) })), { max: Math.max(I.cap * 1.3, ...loads) });
          },
        };
      },
      accept: (I, a) => { const r = keyCheck(I, a); return r.ok ? true : r.msg; },
      solve: (I) => (I.lv === 2 ? { key: "wallet_id", partitions: 24 } : { key: I.lv === 1 ? "order_id" : "store_id" }),
      bad: (I) => I.lv === 1 ? [{ key: "merchant_id" }, { key: "event_type" }, { key: "null" }] : I.lv === 2 ? [{ key: "wallet_id", partitions: 12 }, { key: "txn_id", partitions: 24 }, { key: "wallet_cur", partitions: 24 }] : [{ key: "merchant_id" }, { key: "salted" }, { key: "sku" }],
      hint: (I) => I.lv === 1 ? "Any key that's the same for every event of an order keeps that order's events together. Then look at the bars." : I.lv === 2 ? "A stream-table join reads partition N of both topics in the same task." : "What does ordering actually need to be per: the merchant, or something smaller?",
      concept: "Partition keys: ordering vs skew",
      how: "Kafka only orders records within a partition, and the default partitioner sends every record with the same key to the same partition (murmur2 hash of the key modulo the partition count). So the key must be the entity whose events need ordering, or something coarser that contains it. Coarser keys keep ordering but concentrate load: a partition is consumed by one consumer thread, so a hot key caps throughput no matter how many consumers you run. Joins in Kafka Streams also need both inputs co-partitioned: same key, same partition count.",
      rule: "Key by the smallest entity that needs ordering. Check the hottest key's rate against what one consumer can do on one partition, and never add random salt to a key you rely on for ordering.",
      why: (I, sol) => { const r = keyCheck(I, sol); return `Keying by <code>${sol.key}</code> keeps ${KEYLV[I.lv].need.split(",")[0]} and the hottest partition peaks at ${K.num(r.mx)} msg/s (limit ${K.num(I.cap)}).${I.lv !== 2 ? ` Keying by merchant_id would have put ${K.num(Math.max(...keyLoads(I, "merchant_id", KEYLV[I.lv].P)))} msg/s on one partition.` : " 24 partitions match wallet-limits, so the join is co-partitioned."}`; },
    },
    {
      id: "kafka-durability-matrix",
      name: "Settings that survive broker failures",
      kind: "Config change",
      skills: ["tune", "safe"],
      w: "tune",
      sense: "min",
      vname: "replication factor",
      gen(lv, R) { return { lv, topic: R.pick(["payments.settled", "ledger.entries", "orders.created", "refunds.issued"]), team: R.pick(K.NAMES.team) }; },
      text: (I) => `<p>The ${esc(I.team)} team's <code>${I.topic}</code> topic lives on a 3-broker cluster (B1, B2, B3; B1 leads). Choose the topic and producer settings, then replay the fault scripts below against a model of the replica log, ISR and leader election.</p><ul>${DLV[I.lv].map((k) => `<li><b>${DSCRIPTS[k].name}.</b> ${DSCRIPTS[k].text} <i>Must: ${DSCRIPTS[k].need === "noloss" ? "lose no acknowledged write" : "keep accepting writes"}.</i></li>`).join("")}</ul><p>Use the <b>lowest replication factor</b> that passes (disk is the main cost).</p>`,
      ui: (I) => ({
        knobs: [
          { k: "rf", label: "replication.factor", opts: [1, 2, 3] },
          { k: "minisr", label: "min.insync.replicas", opts: [1, 2, 3] },
          { k: "acks", label: "producer acks", opts: ["0", "1", "all"] },
          { k: "unclean", label: "unclean.leader.election.enable", opts: ["false", "true"] },
        ],
        init: { rf: 1, minisr: 1, acks: "1", unclean: "false" },
        live: (cfg) => cfg ? K.table(["Fault script", "Acked", "Rejected", "Acked writes lost", "Verdict"], durCheck(I, cfg).map((x) => [esc(x.s.name), String(x.r.acked), String(x.r.rejected), String(x.r.lost) + (x.r.offline ? " (stays offline)" : ""), x.ok ? '<span class="win">✓</span>' : `<span class="lose">✗ ${x.s.need === "noloss" ? "data loss" : "writes failed"}</span>`]), { compact: true }) : "",
      }),
      valid: (I, cfg) => { const f = durCheck(I, cfg).find((x) => !x.ok); return f ? `${f.s.name}: ${f.s.need === "noloss" ? `${f.r.lost} acknowledged writes were lost${f.r.uncleanUsed ? " (an out-of-sync replica was elected)" : ""}` : `${f.r.rejected} writes were rejected`}` : true; },
      val: (I, cfg) => cfg.rf,
      hint: (I) => I.lv === 1 ? "With acks=1 the leader acknowledges before any follower has the record." : I.lv === 2 ? "min.insync.replicas is what makes acks=all refuse writes when only the leader is left in the ISR." : "What does an out-of-sync replica have that the ISR doesn't?",
      concept: "acks × min.insync.replicas × RF × unclean election",
      how: "A write is acknowledged with acks=1 as soon as the leader has it, with acks=all once every replica currently in the ISR has it. The ISR shrinks when followers fall behind, so acks=all alone can mean 'acknowledged by the leader only'; min.insync.replicas makes the leader reject acks=all writes (NotEnoughReplicas) when the ISR is smaller than that. A new leader is normally chosen only from the ISR. Unclean leader election lets an out-of-sync replica take over, which brings the partition back but silently drops whatever it never fetched.",
      rule: "For data you can't lose: RF=3, min.insync.replicas=2, acks=all, unclean.leader.election.enable=false. That tolerates one broker down for writes and any single failure for durability.",
      why: (I, sol) => I.lv === 1 ? `With RF=${sol.rf} and acks=all the follower holds every acknowledged record before the producer hears back, so losing B1's disk loses nothing. acks=1 would have lost the last 5 writes.` : I.lv === 2 ? "RF=3 keeps two in-sync copies while one broker restarts, and min.insync.replicas=2 turns 'followers cut off' into rejected writes instead of writes only B1 held. With min.insync.replicas=1 the leader acknowledged 10 writes alone and took them with it." : "In the cascading crash only B1 and B2 had the last writes. Unclean election would hand leadership to B3, which had fallen behind, and drop them; keeping it off leaves the partition offline until B1 or B2 is back, with nothing lost.",
    },
    {
      id: "kafka-unclean-election",
      name: "Partition offline: Leader none",
      kind: "Incident",
      skills: ["diagnose", "safe", "comms"],
      ...LB.term({
        shell: (I) => uncleanShell(I),
        goal(st, I) {
          if (st.leader == null) return `Partition ${I.topic}-${I.p} is still offline.`;
          if (st.clusterUnclean) return "The partition is back, but you enabled unclean leader election for <b>every topic in the cluster</b>, including ones that can't lose data. Scope it to the topic, or use kafka-leader-election.sh for this partition.";
          if (st.lostRecs && I.lv !== 2) return `The partition is back, but broker ${st.leader} was out of sync: <b>${K.num(st.lostRecs)} acknowledged records</b> are gone. ${I.lv === 1 ? "Broker " + I.b + " only needed restarting." : "Broker " + I.b + "'s data volume was intact."}`;
          return true;
        },
        solve: (I) => ({ log: [`kafka-topics.sh --bootstrap-server kafka-1:9092 --describe --topic ${I.topic}`, `ssh kafka-${I.b} systemctl status kafka`, ...(I.lv === 1 ? [`ssh kafka-${I.b} sudo systemctl start kafka`] : I.lv === 2 ? [`kafka-leader-election.sh --bootstrap-server kafka-1:9092 --election-type unclean --topic ${I.topic} --partition ${I.p}`] : ["cat /var/log/ops/asg-events.log", `./runbooks/replace-broker.sh --node-id ${I.b} --attach-volume ${I.vol}`]), `kafka-topics.sh --bootstrap-server kafka-1:9092 --describe --topic ${I.topic}`] }),
      }),
      gen(lv, R) {
        const b = R.int(2, 5), others = R.sample([1, 2, 3, 4, 5, 6].filter((x) => x !== b), 2);
        return { lv, b, others, p: R.int(0, 11), topic: lv === 2 ? R.pick(["clickstream", "page-views", "search-impressions"]) : R.pick(["payments.settled", "ledger.entries", "orders.created"]), lag: R.int(1200, 9000), vol: "vol-0" + R.int(100000, 999999).toString(16) + "a7" };
      },
      bad: (I) => [
        { log: [`kafka-leader-election.sh --bootstrap-server kafka-1:9092 --election-type unclean --topic ${I.topic} --partition ${I.p}`] },
        { log: ["kafka-configs.sh --bootstrap-server kafka-1:9092 --alter --entity-type brokers --entity-default --add-config unclean.leader.election.enable=true"] },
        ...(I.lv === 2 ? [{ log: [`ssh kafka-${I.b} sudo systemctl start kafka`] }] : []),
      ],
      text: (I) => `<p><b>PAGE:</b> <code>OfflinePartitionsCount = 1</code>. Producers to <code>${I.topic}</code> get <code>NOT_LEADER_OR_FOLLOWER</code> for one partition${I.lv === 2 ? "; the analytics team says the topic is best-effort clickstream and a gap is fine, but it must accept writes again" : I.lv === 3 ? "; this topic feeds settlement, where every acknowledged record is money" : ""}.</p><p>Bring the partition back with the least data loss and the smallest blast radius.</p>`,
      hint: (I) => I.lv === 1 ? "Find out why the only in-sync replica is down before electing anything." : I.lv === 2 ? "The host is gone for good. Which tool forces a leader for one partition only?" : "Is the data really gone, or just the machine?",
      concept: "Offline partitions and unclean leader election",
      how: "When the last in-sync replica of a partition dies, Kafka keeps it offline rather than promote a follower that missed writes. You can force an unclean election (topic config unclean.leader.election.enable=true, or kafka-leader-election.sh --election-type unclean for one partition): the stale replica becomes leader, everything it never fetched is gone, and the old leader truncates to match when it returns. That trade is right for loss-tolerant data whose host is truly gone, and wrong when the in-sync replica can come back: a restart, or a replacement broker with the same node id and the original data volume.",
      rule: "Before an unclean election, ask whether the in-sync replica's data can come back. If yes, bring it back. If not, scope the unclean election to the one partition and record what was lost.",
      why: (I) => I.lv === 1 ? `Broker ${I.b} had been OOM-killed. Starting it brought the only in-sync replica back, and it resumed leadership with every acknowledged record. An unclean election would have discarded ${K.num(I.lag)} records.` : I.lv === 2 ? `kafka-${I.b} was gone with its disk, so waiting meant offline forever. An unclean election on ${I.topic}-${I.p} alone brought it back, losing about ${K.num(I.lag)} clickstream events, which the owners accepted. A cluster-wide default would have exposed payment topics to the same silent loss.` : `kafka-${I.b}'s instance was terminated, but its EBS volume (${I.vol}) survived. A replacement broker with node id ${I.b} and the same volume rejoined as the in-sync leader with no loss. An unclean election would have dropped ${K.num(I.lag)} settled payments.`,
    },
  ]);

  function uncleanShell(I) {
    const B = "(?:--bootstrap-server \\S+ )?";
    const reps = [I.b, ...I.others];
    const desc = (st) => {
      const lines = [`Topic: ${I.topic}\tTopicId: Q2x8vT1nRkS0d9Wc1pLm3A\tPartitionCount: 12\tReplicationFactor: 3\tConfigs: min.insync.replicas=2${st.topicUnclean ? ",unclean.leader.election.enable=true" : ""}`];
      for (let p = Math.max(0, I.p - 1); p <= Math.min(11, I.p + 1); p++) {
        if (p === I.p) lines.push(`\tTopic: ${I.topic}\tPartition: ${p}\tLeader: ${st.leader == null ? "none" : st.leader}\tReplicas: ${reps.join(",")}\tIsr: ${st.isr.join(",")}`);
        else lines.push(`\tTopic: ${I.topic}\tPartition: ${p}\tLeader: ${I.others[p % 2]}\tReplicas: ${[I.others[p % 2], I.others[(p + 1) % 2], I.b].join(",")}\tIsr: ${[I.others[p % 2], I.others[(p + 1) % 2]].join(",")}${st.bUp ? "," + I.b : ""}`);
      }
      return lines.join("\n");
    };
    const recover = (st) => { st.bUp = true; st.leader = I.b; st.isr = [I.b]; };
    const unclean = (st) => { st.leader = I.others[0]; st.isr = [I.others[0]]; st.lostRecs = I.lag; };
    const sh = K.shell([
      { re: /^kafka-topics(?:\.sh)? .*--describe.*$/, use: "kafka-topics.sh --bootstrap-server kafka-1:9092 --describe --topic <topic>", desc: "partition leaders, replicas and ISR", run: (m, st) => desc(st) },
      { re: new RegExp(`^ssh kafka-(\\d+) (?:sudo )?systemctl status kafka$`), use: "ssh kafka-<n> systemctl status kafka", desc: "service status on a broker", run: (m, st) => {
        const n = +m[1];
        if (n !== I.b) return `● kafka.service - Apache Kafka\n     Loaded: loaded (/etc/systemd/system/kafka.service; enabled)\n     Active: active (running) since Mon 2026-10-05 02:11:40 UTC; 6 days ago`;
        if (I.lv > 1 && !st.bUp) return `ssh: connect to host kafka-${n} port 22: No route to host`;
        if (st.bUp) return `● kafka.service - Apache Kafka\n     Active: active (running) since Sun 2026-10-11 09:42:13 UTC; 20s ago`;
        return `● kafka.service - Apache Kafka\n     Loaded: loaded (/etc/systemd/system/kafka.service; enabled)\n     Active: failed (Result: oom-kill) since Sun 2026-10-11 09:31:02 UTC; 11min ago\n    Process: 1187 ExecStart=/opt/kafka/bin/kafka-server-start.sh /etc/kafka/server.properties (code=killed, signal=KILL)\nOct 11 09:31:02 kafka-${n} systemd[1]: kafka.service: A process of this unit has been killed by the OOM killer.`;
      } },
      { re: /^ssh kafka-(\d+) (?:sudo )?(?:journalctl.*|tail .*server\.log.*)$/, use: "ssh kafka-<n> journalctl -u kafka -n 30", desc: "broker logs", run: (m, st) => (+m[1] === I.b && I.lv > 1 && !st.bUp ? `ssh: connect to host kafka-${m[1]} port 22: No route to host` : +m[1] === I.b && !st.bUp ? `Oct 11 09:31:01 kafka-${m[1]} kernel: Out of memory: Killed process 1187 (java) total-vm:14.2G\nOct 11 09:31:02 kafka-${m[1]} systemd[1]: kafka.service: Failed with result 'oom-kill'.` : `[2026-10-11 09:30:58,114] INFO [Partition ${I.topic}-${I.p} broker=${m[1]}] Shrinking ISR from ${reps.join(",")} to ${I.b}. Leader: (highWatermark: 88123401, endOffset: 88123401). Out of sync replicas: (brokerId: ${I.others[0]}, endOffset: ${88123401 - I.lag}) (brokerId: ${I.others[1]}, endOffset: ${88123401 - I.lag - 311}).`) },
      { re: /^ssh kafka-(\d+) sudo systemctl (?:start|restart) kafka$/, use: "ssh kafka-<n> sudo systemctl start kafka", desc: "start the broker service", run: (m, st) => {
        if (+m[1] !== I.b) return "";
        if (I.lv > 1) return `ssh: connect to host kafka-${m[1]} port 22: No route to host`;
        recover(st); return "";
      } },
      { re: /^cat \/var\/log\/ops\/asg-events\.log$/, use: "cat /var/log/ops/asg-events.log", desc: "recent auto-scaling / instance events", run: () => I.lv === 3 ? `2026-10-11T09:29:40Z kafka-brokers-asg: Terminating EC2 instance i-0c71d2: instance failed EC2 status checks (hardware)\n2026-10-11T09:30:05Z volume ${I.vol} (kafka-${I.b} data, 2 TiB) detached, state: available\n2026-10-11T09:31:10Z kafka-brokers-asg: launch of replacement paused (manual approval required for stateful brokers)` : I.lv === 2 ? `2026-10-11T09:29:40Z kafka-${I.b}: host retired by provider; instance store volumes (data) destroyed` : "no events in the last 24h" },
      { re: /^\.\/runbooks\/replace-broker\.sh(?: .*)?$/, use: "./runbooks/replace-broker.sh --node-id <id> --attach-volume <vol-id>", desc: "launch a replacement broker (optionally on an existing data volume)", run: (m, st, line) => {
        const a = argv(line);
        if (!a["node-id"]) return "usage: replace-broker.sh --node-id <id> [--attach-volume <vol-id>]";
        if (+a["node-id"] !== I.b) return { out: `replacement started as node ${a["node-id"]}, which already exists in the cluster: it fails to register (InconsistentClusterIdException / duplicate node id)`, danger: "Launched a broker with another live broker's node id." };
        if (I.lv !== 3) return "launching... error: the original data volume is gone; a fresh broker would join with an empty log and isn't in the ISR";
        if (a["attach-volume"] !== I.vol) return { out: `launching i-0f3a90 as node ${I.b} with an EMPTY data volume...\nbroker registered; it is not in the ISR of ${I.topic}-${I.p} (empty log), partition stays offline`, danger: "Brought the node id back without its data." };
        recover(st); return `launching i-0f3a90 (node.id=${I.b}) with ${I.vol} attached at /var/lib/kafka...\n[...] Loaded 412 logs in 38s; recovered ${I.topic}-${I.p} up to offset 88123401\nbroker ${I.b} registered with the controller`;
      } },
      { re: /^kafka-leader-election(?:\.sh)? .*$/, use: "kafka-leader-election.sh --bootstrap-server kafka-1:9092 --election-type <preferred|unclean> --topic <t> --partition <p>", desc: "trigger leader election", run: (m, st, line) => {
        const a = argv(line), t = String(a["election-type"] || "").toLowerCase();
        if (!t || (!a["all-topic-partitions"] && (!a.topic || a.partition == null))) return "Missing required option(s): --election-type and (--topic with --partition, or --all-topic-partitions)";
        if (a["all-topic-partitions"] && t === "unclean") { if (st.leader == null) unclean(st); return { out: `Successfully completed leader election (UNCLEAN) for partitions ${I.topic}-${I.p}`, danger: "Unclean election across ALL partitions of the cluster." }; }
        if (a.topic !== I.topic || +a.partition !== I.p) return `Valid replica already elected for partitions ${a.topic}-${a.partition}`;
        if (t === "preferred") return `Error completing leader election (PREFERRED) for partition: ${I.topic}-${I.p}: org.apache.kafka.common.errors.PreferredLeaderNotAvailableException: Failed to elect leader for partition ${I.topic}-${I.p} under strategy PreferredReplicaPartitionLeaderElectionStrategy`;
        if (st.leader != null) return `Valid replica already elected for partitions ${I.topic}-${I.p}`;
        unclean(st);
        return `Successfully completed leader election (UNCLEAN) for partitions ${I.topic}-${I.p}`;
      } },
      { re: /^kafka-configs(?:\.sh)? .*--alter.*unclean\.leader\.election\.enable=true.*$/, use: "kafka-configs.sh --bootstrap-server kafka-1:9092 --alter --entity-type <topics|brokers> --entity-name <name> | --entity-default --add-config unclean.leader.election.enable=true", desc: "enable unclean election (topic or cluster scope)", run: (m, st, line) => {
        const a = argv(line);
        if (a["entity-type"] === "brokers") { st.clusterUnclean = true; if (st.leader == null) unclean(st); return { out: "Completed updating default config for brokers in the cluster.", danger: "Unclean leader election is now the default for every topic in the cluster." }; }
        if (a["entity-type"] === "topics" && a["entity-name"] === I.topic) { st.topicUnclean = true; if (st.leader == null) unclean(st); return `Completed updating config for topic ${I.topic}.`; }
        return `Completed updating config for topic ${a["entity-name"] || "?"}.`;
      } },
    ]);
    return {
      prompt: "ops@bastion:~$", par: 6, init: { leader: null, isr: [I.b], bUp: false, lostRecs: 0, clusterUnclean: false, topicUnclean: false },
      motd: `ALERT OfflinePartitionsCount=1 (kafka-prod)\nUnderReplicatedPartitions=${I.lv === 1 ? 31 : 44}`,
      run: (line, st) => sh.run(line, st),
      cmds: [`kafka-topics.sh --bootstrap-server kafka-1:9092 --describe --topic ${I.topic}`, "ssh kafka-<n> systemctl status kafka", "ssh kafka-<n> journalctl -u kafka -n 30", "cat /var/log/ops/asg-events.log", "kafka-leader-election.sh --bootstrap-server kafka-1:9092 --election-type unclean --topic <t> --partition <p>"],
    };
    void B;
  }

  /*__MORE__*/
})();
