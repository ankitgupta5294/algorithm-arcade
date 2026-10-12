/* Systems Lab · Postgres, part 3: simulator-driven scenarios (psql sandboxes, tuning models, plans, topologies). */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const S = [];

  /* ---------- helpers ---------- */
  // Ordered-plan checker for `steps` scenarios. P = { text:{key: text}, need(I): [keys], before:{key:[keys]}, trap:{key: why}, extra?:{key: why-not-needed} }
  const planCheck = (P, I, keys) => {
    const need = P.need(I), seen = new Set();
    for (const k of keys) {
      if (!k) return "Pick steps from the list.";
      if (P.trap[k]) return `<b>${esc(P.text[k])}</b>: ${P.trap[k]}`;
      if (!need.includes(k)) return `"${esc(P.text[k])}" isn't needed for this change.`;
      for (const b of P.before[k] || []) if (need.includes(b) && !seen.has(b)) return `"${esc(P.text[k])}" comes too early: it needs "${esc(P.text[b])}" first.`;
      seen.add(k);
    }
    const miss = need.filter((k) => !seen.has(k));
    if (miss.length) return `Missing a step: "${esc(P.text[miss[0]])}".`;
    return true;
  };
  const planUI = (P, I) => ({ opts: I.keys.map((k) => P.text[k]), live: (seq) => {
    if (!seq || !seq.length) return `<p class="muted small">Pick steps in the order you'd run them.</p>`;
    const r = planCheck(P, I, seq.map((i) => I.keys[i]));
    return r === true ? K.verdict(true, "This plan works.") : /^Missing/.test(r) ? K.note(r) : K.verdict(false, r);
  } });
  const planDef = (P) => ({
    w: "steps",
    ui: (I) => planUI(P, I),
    accept: (I, seq) => planCheck(P, I, seq.map((i) => I.keys[i])),
    solve: (I) => P.need(I).map((k) => I.keys.indexOf(k)),
  });
  const planKeys = (P, lv, R) => R.shuffle(P.pool(lv));

  /* ======================= 1. which indexes can go ======================= */
  const IDXS = {
    used: (R, t) => ({ name: `${t}_customer_created_idx`, def: "(customer_id, created_at)", size: R.int(3, 9) + " GB", scans: R.int(2, 90) * 1e6, drop: false }),
    used2: (R, t) => ({ name: `${t}_status_idx`, def: "(status) WHERE status = 'pending'", size: R.int(20, 90) + " MB", scans: R.int(5, 60) * 1e5, drop: false }),
    unused: (R, t) => ({ name: `${t}_legacy_ref_idx`, def: "(legacy_ref)", size: R.int(4, 12) + " GB", scans: 0, drop: true }),
    unused2: (R, t) => ({ name: `${t}_updated_at_idx`, def: "(updated_at)", size: R.int(4, 9) + " GB", scans: 0, drop: true }),
    pk: (R, t) => ({ name: `${t}_pkey`, def: "PRIMARY KEY (id)", size: R.int(5, 12) + " GB", scans: 0, drop: false, why: "it backs the primary key constraint" }),
    dup: (R, t) => ({ name: `${t}_customer_created_idx1`, def: "(customer_id, created_at)", size: R.int(3, 9) + " GB", scans: 0, drop: true }),
    prefix: (R, t) => ({ name: `${t}_customer_id_idx`, def: "(customer_id)", size: R.int(2, 6) + " GB", scans: R.int(1, 30) * 1e5, drop: true }),
    uniq: (R, t) => ({ name: `${t}_external_ref_key`, def: "UNIQUE (external_ref)", size: R.int(4, 9) + " GB", scans: 0, drop: false, why: "it enforces uniqueness of external_ref: every insert checks it even though no query reads it" }),
    replica: (R, t) => ({ name: `${t}_region_created_idx`, def: "(region, created_at)", size: R.int(4, 9) + " GB", scans: 0, drop: false, why: "the finance reports run on the replica, and pg_stat_user_indexes counts only scans on the server you query" }),
    fk: (R, t) => ({ name: `${t}_shipment_id_idx`, def: "(shipment_id)", size: R.int(1, 4) + " GB", scans: R.int(3, 40), drop: false, why: `${t}.shipment_id references shipments(id) ON DELETE CASCADE: without it each shipment purge does a sequential scan of ${t}` }),
  };
  const idxPick = (lv) => lv === 1 ? ["used", "unused", "pk", "dup", "used2"] : lv === 2 ? ["used", "unused2", "pk", "dup", "prefix", "uniq", "used2"] : ["used", "unused", "pk", "prefix", "uniq", "replica", "fk", "used2"];
  S.push({
    id: "pg-drop-unused-indexes",
    name: "Drop the indexes that only cost writes",
    kind: "Investigation",
    skills: ["diagnose", "safe"],
    w: "select",
    gen(lv, R) {
      const t = R.pick(["orders", "payments", "line_items", "invoices"]);
      const list = R.shuffle(idxPick(lv)).map((k) => ({ k, ...IDXS[k](R, t) }));
      return { lv, t, list, days: R.int(60, 120), wps: R.int(3, 12) * 1000 };
    },
    text: (I) => `<p><code>${I.t}</code> takes <b>${K.num(I.wps)} inserts/s</b> and its insert latency has doubled in a year; every index adds work (and WAL) to every insert. Statistics were last reset <b>${I.days} days ago</b>, which covers every monthly job. Here is <code>pg_stat_user_indexes</code> on the primary:</p>
      ${I.lv === 3 ? `<p>Context: finance runs its reports on the read replica <code>db-replica-2</code>. Old shipments are purged weekly with <code>DELETE FROM shipments WHERE ...</code>.</p>` : ""}<p>Select every index that is <b>safe to drop</b>.</p>`,
    ui: (I) => ({ opts: I.list.map((x) => `<b class="mono">${esc(x.name)}</b> <span class="mono">${esc(x.def)}</span><br><small class="muted">${esc(x.size)} · idx_scan ${K.num(x.scans)}</small>`), html: true }),
    ans: (I) => I.list.map((x, i) => (x.drop ? i : -1)).filter((i) => i >= 0),
    diag: () => "Not quite. For each index ask: is it unused, or fully covered by another index, and does it do any job besides speeding up reads on this server?",
    hint: (I) => I.lv === 1 ? "Zero scans in a long window is a strong signal, unless the index does something besides serving reads. Two identical definitions are never both needed." : I.lv === 2 ? "An index on (a) is redundant when (a, b) exists: its scans would simply move to the wider index." : "Statistics are per server, and some index scans come from foreign-key enforcement rather than queries.",
    concept: "Finding unused and redundant indexes",
    how: "Every index is updated on every INSERT (and on UPDATEs that aren't HOT), costing CPU, WAL and cache; unused ones are pure overhead. pg_stat_user_indexes.idx_scan counts index scans since the last statistics reset on that server only: replicas keep their own counters, so check them all, and make sure the window covers monthly jobs. Indexes that back PRIMARY KEY or UNIQUE constraints enforce correctness even with zero scans. Exact duplicates and left-prefix indexes ((a) when (a, b) exists) are redundant: queries switch to the remaining index. Indexes on foreign key columns are what make cascaded deletes and parent-key updates fast. Drop with DROP INDEX CONCURRENTLY, ideally after a trial period watching for regressions.",
    rule: "Before dropping an index: check idx_scan on every node over a window that covers periodic jobs, keep anything that enforces a constraint or supports a foreign key, and drop duplicates and left-prefix indexes first with DROP INDEX CONCURRENTLY.",
    why: (I) => "Safe to drop: " + I.list.filter((x) => x.drop).map((x) => `<code>${esc(x.name)}</code>`).join(", ") + ". Keep: " + I.list.filter((x) => !x.drop).map((x) => `<code>${esc(x.name)}</code>${x.why ? ` (${esc(x.why)})` : " (heavily used)"}`).join("; ") + ".",
  });

  /* ======================= 2. find the misestimate in a plan ======================= */
  function misPlan(I) {
    const L = [];
    const a = I.a, b = I.b;
    if (I.lv === 1) {
      L.push([`Hash Join  (cost=231.50..18874.20 rows=${I.e1} width=72) (actual time=4.1..${I.t1}.3 rows=${a} loops=1)`, 0]);
      L.push(["  Hash Cond: (o.customer_id = c.id)", 0]);
      L.push([`  ->  Seq Scan on orders o  (cost=0.00..18642.00 rows=${I.e1} width=48) (actual time=0.02..${I.t1 - 9}.8 rows=${a} loops=1)`, 1]);
      L.push([`        Filter: ((status = 'pending'::text) AND (created_at > (now() - '1 day'::interval)))`, 0]);
      L.push([`        Rows Removed by Filter: ${K.num(I.big)}`, 0]);
      L.push(["  ->  Hash  (cost=169.00..169.00 rows=5000 width=24) (actual time=3.9..3.9 rows=5000 loops=1)", 0]);
      L.push(["        Buckets: 8192  Batches: 1  Memory Usage: 334kB", 0]);
      L.push(["        ->  Seq Scan on customers c  (cost=0.00..169.00 rows=5000 width=24) (actual time=0.01..1.2 rows=5000 loops=1)", 0]);
    } else if (I.lv === 2) {
      L.push([`Nested Loop  (cost=12.47..1311.85 rows=${I.e1} width=96) (actual time=0.41..${I.t1}.7 rows=${a} loops=1)`, 0]);
      L.push([`  ->  Bitmap Heap Scan on shipments s  (cost=12.04..410.21 rows=${I.e1} width=40) (actual time=0.38..${Math.round(I.t1 / 4)}.1 rows=${a} loops=1)`, 1]);
      L.push([`        Recheck Cond: (carrier = '${I.carrier}'::text)`, 0]);
      L.push([`        Filter: (service_level = '${I.svc}'::text)`, 0]);
      L.push([`        Rows Removed by Filter: ${K.num(b)}`, 0]);
      L.push([`        Heap Blocks: exact=${K.num(I.blocks)}`, 0]);
      L.push([`        ->  Bitmap Index Scan on shipments_carrier_idx  (cost=0.00..12.03 rows=${a + b - 40} width=0) (actual time=0.31..0.31 rows=${a + b} loops=1)`, 0]);
      L.push([`              Index Cond: (carrier = '${I.carrier}'::text)`, 0]);
      L.push([`  ->  Index Scan using orders_pkey on orders o  (cost=0.43..8.45 rows=1 width=56) (actual time=0.004..0.004 rows=1 loops=${a})`, 0]);
      L.push(["        Index Cond: (id = s.order_id)", 0]);
    } else {
      L.push([`Hash Join  (cost=48211.30..61873.11 rows=${I.e1} width=40) (actual time=${I.t1 - 300}.2..${I.t1}.9 rows=${a} loops=1)`, 0]);
      L.push(["  Hash Cond: ((d.tenant_id = t.tenant_id) AND (d.day = t.day))", 0]);
      L.push([`  ->  HashAggregate  (cost=47100.00..47102.00 rows=200 width=20) (actual time=${I.t1 - 420}.4..${I.t1 - 330}.1 rows=${K.num(b).replace(/,/g, "")} loops=1)`, 1]);
      L.push(["        Group Key: e.tenant_id, (e.created_at)::date", 0]);
      L.push(["        Batches: 5  Memory Usage: 8241kB  Disk Usage: 21480kB", 0]);
      L.push([`        ->  Seq Scan on events e  (cost=0.00..41820.00 rows=${K.num(I.big).replace(/,/g, "")} width=12) (actual time=0.01..${I.t1 - 610}.3 rows=${K.num(I.big).replace(/,/g, "")} loops=1)`, 0]);
      L.push([`  ->  Hash  (cost=611.00..611.00 rows=${a} width=20) (actual time=9.8..9.8 rows=${a} loops=1)`, 0]);
      L.push([`        ->  Seq Scan on targets t  (cost=0.00..611.00 rows=${a} width=20) (actual time=0.01..4.1 rows=${a} loops=1)`, 0]);
    }
    return L;
  }
  S.push({
    id: "pg-find-misestimate",
    name: "Find where the plan went wrong",
    kind: "Investigation",
    skills: ["diagnose"],
    w: "lines",
    gen(lv, R) {
      if (lv === 1) return { lv, a: R.int(30, 60) * 1000, e1: R.int(1, 9), t1: R.int(400, 900), big: R.int(800, 1900) * 1000 };
      if (lv === 2) return { lv, a: R.int(9, 30) * 1000, b: R.int(40, 200), e1: R.int(2, 12), t1: R.int(2000, 6000), blocks: R.int(3, 9) * 1000, carrier: R.pick(["UPS", "DHL", "PostNL", "FedEx"]), svc: R.pick(["express", "economy", "freight"]) };
      return { lv, a: R.int(3, 9) * 1000, b: R.int(40, 120) * 1000, e1: R.int(1, 4), t1: R.int(1400, 2400), big: R.int(2, 6) * 1e6 };
    },
    text: (I) => `<p>${I.lv === 1 ? "The 'pending orders' report went from 200 ms to several seconds after a schema change." : I.lv === 2 ? "Carrier dashboards time out. Someone suggests the nested loop's inner index scan is the problem because it runs thousands of times." : "A nightly job that matches per-tenant daily event counts against targets spills to disk and takes 20 minutes."} Here's <code>EXPLAIN (ANALYZE)</code>:</p><p>Flag the <b>one plan node where the planner's row estimate first goes badly wrong</b>: the root cause the rest of the plan inherits.</p>`,
    ui: (I) => ({ lines: misPlan(I).map(([t]) => ({ t, k: " " })), file: "EXPLAIN ANALYZE", k: 1 }),
    ans: (I) => [misPlan(I).findIndex((x) => x[1])],
    diag: (I) => I.lv === 2 ? "Not that one. For a node executed many times, rows is per loop: rows=1 loops=N matches an estimate of 1 perfectly." : "Not quite. Compare 'rows=' in the cost part (estimate) with 'rows=' in the actual part, starting from the leaves; a parent that's off just inherits its child's error.",
    hint: (I) => I.lv === 1 ? "Read bottom-up. Which is the deepest node whose estimate and actual rows disagree?" : I.lv === 2 ? "Actual rows are reported per loop. And look at which conditions were estimated from an index and which were applied as a filter." : "A node can be accurate on input and wildly wrong on output. Grouping by two columns is estimated how?",
    concept: "Reading row estimates in EXPLAIN ANALYZE",
    how: "Each plan node shows the planner's estimate (cost=... rows=N) and, with ANALYZE, what happened (actual ... rows=M loops=L). Actual rows are an average per loop, so the inner side of a nested loop with rows=1 loops=50000 is a perfect estimate of 1. Errors propagate upward: once a scan or aggregate underestimates, every join above it is planned for the wrong size (nested loops instead of hash joins, hash tables too small, no parallelism). So find the lowest node where estimate and actual diverge by an order of magnitude, and fix the statistics behind it: stale stats, correlated columns (extended statistics), expressions, or GROUP BY over several columns (ndistinct statistics).",
    rule: "Read EXPLAIN ANALYZE bottom-up, normalise actual rows by loops, and fix the first big misestimate; ignore nodes that merely inherit it.",
    why: (I) => I.lv === 1 ? `The Seq Scan on orders expected ${I.e1} rows and got ${K.num(I.a)}: the filter combines status and a recent date, and the planner's statistics for that (after the schema change, likely stale) are wrong. The Hash Join above is off only because its input was.` : I.lv === 2 ? `The bitmap heap scan expected ${I.e1} rows after filtering on service_level, but ${K.num(I.a)} survived: carrier and service_level are correlated, and the planner multiplied their selectivities. The index scan below it was estimated correctly, and the inner index scan's rows=1 is per loop: also correct. Extended statistics on (carrier, service_level) fix it.` : `The HashAggregate expected 200 groups (the default when it can't estimate the number of distinct (tenant_id, day) pairs) and produced ${K.num(I.b)}, so its hash table spilled and the join above was planned for 200 rows. The scan under it is accurate. CREATE STATISTICS (ndistinct) on (tenant_id, (created_at::date)) fixes the estimate.`,
  });

  /* ======================= 3. deadlocks ======================= */
  // Row-lock modes and their conflicts (Postgres row-level locks).
  const CONFLICT = { KS: ["U"], S: ["NKU", "U"], NKU: ["S", "NKU", "U"], U: ["KS", "S", "NKU", "U"] };
  const MODE_NAME = { KS: "FOR KEY SHARE", S: "FOR SHARE", NKU: "FOR NO KEY UPDATE", U: "FOR UPDATE" };
  function lockSim(I, seq) {
    const held = {}; // row -> [{t, mode}]
    const T = I.lanes.map(() => ({ state: "active", wait: null, backlog: [] }));
    const log = [];
    let deadlock = null;
    const blockers = (t, row, mode) => (held[row] || []).filter((h) => h.t !== t && CONFLICT[mode].includes(h.mode)).map((h) => h.t);
    const release = (t) => { Object.keys(held).forEach((r) => { held[r] = held[r].filter((h) => h.t !== t); }); };
    const waitsFor = (t, seen = new Set()) => { const w = T[t].wait; if (!w) return false; for (const b of w.on) { if (seen.has(b)) return true; seen.add(b); if (b === w.start || waitsFor(b, seen)) return true; } return false; };
    const exec = (t, i) => {
      const op = I.lanes[t].ops[i], label = I.lanes[t].steps[i];
      if (T[t].state !== "active") { log.push({ t, label, note: "skipped: transaction already ended" }); return; }
      if (op.k === "commit") { T[t].state = "done"; release(t); log.push({ t, label, note: "committed, locks released" }); wake(); return; }
      if (op.k === "noop") { log.push({ t, label, note: "" }); return; }
      const bs = blockers(t, op.row, op.mode);
      if (bs.length) {
        T[t].wait = { row: op.row, mode: op.mode, on: bs, i };
        // cycle detection
        const cyc = (x, path) => { const w = T[x].wait; if (!w) return false; return w.on.some((b) => b === t || (!path.has(b) && cyc(b, new Set([...path, b])))); };
        if (bs.some((b) => b === t || cyc(b, new Set([b])))) {
          deadlock = { t, row: op.row, on: bs };
          T[t].state = "aborted"; T[t].wait = null; release(t);
          log.push({ t, label, note: `ERROR: deadlock detected. Process waits for ${MODE_NAME[op.mode]} on ${I.names[op.row]} held by T${bs[0] + 1}, which waits for T${t + 1}. Transaction rolled back.`, err: true });
          wake(); return;
        }
        log.push({ t, label, note: `waits for T${bs.map((b) => b + 1).join(", T")} (${MODE_NAME[op.mode]} on ${I.names[op.row]})` });
        return;
      }
      (held[op.row] = held[op.row] || []).push({ t, mode: op.mode });
      log.push({ t, label, note: `locks ${I.names[op.row]} (${MODE_NAME[op.mode]})` });
    };
    const wake = () => {
      let again = true;
      while (again) {
        again = false;
        T.forEach((tx, u) => {
          if (!tx.wait || tx.state !== "active") return;
          const bs = blockers(u, tx.wait.row, tx.wait.mode);
          if (bs.length) { tx.wait.on = bs; return; }
          const w = tx.wait; tx.wait = null;
          (held[w.row] = held[w.row] || []).push({ t: u, mode: w.mode });
          log.push({ t: u, label: "", note: `T${u + 1} wakes up and locks ${I.names[w.row]}` });
          const bl = tx.backlog; tx.backlog = [];
          for (const i of bl) { if (tx.wait) { tx.backlog.push(i); continue; } exec(u, i); }
          again = true;
        });
      }
    };
    void waitsFor;
    const pos = I.lanes.map(() => 0);
    for (const l of seq) { const i = pos[l]++; if (T[l].wait) { T[l].backlog.push(i); continue; } exec(l, i); }
    return { log, deadlock, stuck: T.some((x) => x.wait && x.state === "active") };
  }
  const DL = {
    1: (R) => { const a = R.int(100, 499), b = R.int(500, 999), x = R.int(2, 9) * 10; return { names: { A: `account ${a}`, B: `account ${b}` }, story: `Two transfers run at the same moment: T1 moves ${x} from account ${a} to ${b}, T2 moves money from ${b} to ${a}. Each updates the debited account first.`, lanes: [
      { name: `T1 (${a} → ${b})`, steps: ["BEGIN", `UPDATE accounts SET balance = balance - ${x} WHERE id = ${a}`, `UPDATE accounts SET balance = balance + ${x} WHERE id = ${b}`, "COMMIT"], ops: [{ k: "noop" }, { row: "A", mode: "NKU" }, { row: "B", mode: "NKU" }, { k: "commit" }] },
      { name: `T2 (${b} → ${a})`, steps: ["BEGIN", `UPDATE accounts SET balance = balance - 15 WHERE id = ${b}`, `UPDATE accounts SET balance = balance + 15 WHERE id = ${a}`, "COMMIT"], ops: [{ k: "noop" }, { row: "B", mode: "NKU" }, { row: "A", mode: "NKU" }, { k: "commit" }] },
    ] }; },
    2: (R) => { const ids = R.distinct(3, 100, 999); return { names: { A: `account ${ids[0]}`, B: `account ${ids[1]}`, C: `account ${ids[2]}` }, story: `A settlement batch runs three transfers in parallel: ${ids[0]} → ${ids[1]}, ${ids[1]} → ${ids[2]} and ${ids[2]} → ${ids[0]}. Each locks both rows with SELECT ... FOR UPDATE, debited account first.`, lanes: [0, 1, 2].map((k) => { const f = "ABC"[k], to = "ABC"[(k + 1) % 3]; return { name: `T${k + 1} (${ids[k]} → ${ids[(k + 1) % 3]})`, steps: [`SELECT ... WHERE id = ${ids[k]} FOR UPDATE`, `SELECT ... WHERE id = ${ids[(k + 1) % 3]} FOR UPDATE`, "UPDATE both; COMMIT"], ops: [{ row: f, mode: "U" }, { row: to, mode: "U" }, { k: "commit" }] }; }) }; },
    3: (R) => { const o = R.int(1000, 9999); return { names: { O: `orders row ${o}` }, story: `Two API requests add an item to the same order ${o} at once. Each inserts into <code>order_items</code> (which has a foreign key to <code>orders</code>), then locks the order with <code>SELECT ... FOR UPDATE</code> to recompute its total. No two statements touch the same order_items row.`, lanes: [1, 2].map((k) => ({ name: `T${k} (add item)`, steps: ["BEGIN", `INSERT INTO order_items (order_id, sku) VALUES (${o}, 'SKU-${k}')`, `SELECT total FROM orders WHERE id = ${o} FOR UPDATE`, "UPDATE orders SET total = ...; COMMIT"], ops: [{ k: "noop" }, { row: "O", mode: "KS" }, { row: "O", mode: "U" }, { k: "commit" }] })) }; },
  };
  const dlOf = (I) => DL[I.lv](D.campaign.rng(I.seed));
  const dlTrace = (A, r) => K.table(["", ...A.lanes.map((_, k) => "T" + (k + 1))], r.log.map((e, k) => [String(k + 1), ...A.lanes.map((_, j) => (j === e.t ? `${e.label ? `<span class="mono">${esc(e.label)}</span>` : ""}${e.note ? `<br><small class="${e.err ? "lose" : "muted"}">${esc(e.note)}</small>` : ""}` : ""))]), { compact: true });
  S.push({
    id: "pg-deadlock",
    name: "Reproduce the deadlock",
    kind: "Investigation",
    skills: ["diagnose", "design"],
    w: "interleave",
    gen(lv, R) { return { lv, seed: `pg-dl/${lv}/${R.int(1, 1e9)}` }; },
    text: (I) => { const A = dlOf(I); return `<p>The logs show <code>ERROR: deadlock detected</code> a few times an hour. ${A.story}</p><p><b>Find a schedule that deadlocks.</b> Pick which transaction runs its next statement; the simulator applies Postgres's row-lock rules (${I.lv === 3 ? "including the FOR KEY SHARE lock a foreign-key check takes on the referenced row" : "a lock is held until commit and a conflicting request waits"}).</p>`; },
    ui: (I) => { const A = dlOf(I); return { lanes: A.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = lockSim(A, seq || []); return dlTrace(A, r) + (r.deadlock ? K.verdict(true, "Deadlock: Postgres aborted one transaction.") : ""); } }; },
    accept(I, seq) { const r = lockSim(dlOf(I), seq); return r.deadlock ? true : "No deadlock: every lock request was eventually granted. Make each transaction hold something the other one needs next."; },
    solve(I, spec) { const A = dlOf(I); for (const s of LB.byId.get("pg-deadlock").space(I, spec)) if (lockSim(A, s).deadlock) return s; return null; },
    bad: (I) => { const A = dlOf(I); return [A.lanes.flatMap((l, k) => l.steps.map(() => k))]; },
    hint: (I) => I.lv === 1 ? "Let each transaction take its first lock before either takes its second." : I.lv === 2 ? "With three transactions, a cycle needs each to hold one row and want the next." : "FOR KEY SHARE locks don't conflict with each other, but FOR UPDATE conflicts with them.",
    concept: "Deadlocks and lock ordering",
    how: "Row locks are held until the transaction ends. If T1 holds row A and waits for B while T2 holds B and waits for A, neither can proceed: after deadlock_timeout (1 s by default) Postgres runs its deadlock detector, aborts one of the transactions with 'deadlock detected', and the other continues. Cycles can involve any number of transactions and any lock modes, including the FOR KEY SHARE lock that inserting a child row takes on the referenced parent row, which conflicts with a later SELECT ... FOR UPDATE of that parent. The fix is to acquire locks in one consistent global order (e.g. by ascending id), lock the parent first, or use a weaker lock (FOR NO KEY UPDATE) when key columns don't change; and retry transactions that fail with deadlock or serialization errors.",
    rule: "Acquire row locks in a consistent order (sort ids before locking, lock parents before children), keep transactions short, prefer FOR NO KEY UPDATE over FOR UPDATE, and make the application retry on SQLSTATE 40P01.",
    why: (I) => I.lv === 1 ? "Each transfer locked its debited account first, so opposite transfers locked the same two rows in opposite orders. Locking both accounts in ascending id order (e.g. SELECT ... WHERE id IN (a, b) ORDER BY id FOR UPDATE) makes the cycle impossible." : I.lv === 2 ? "Three transfers formed a ring: each held one account and waited for the next. Sorting the ids before locking breaks every such cycle, however many transactions take part." : "The INSERT's foreign-key check took FOR KEY SHARE on the order row in both transactions (compatible), then each SELECT ... FOR UPDATE needed to wait for the other's key-share lock. Locking the order first (SELECT ... FOR NO KEY UPDATE before inserting the item) or using FOR NO KEY UPDATE, which doesn't conflict with KEY SHARE, removes the deadlock.",
  });

  /* ======================= 4. advisory locks code review ======================= */
  const ADV = {
    1: { file: "jobs/nightly_billing.py", lines: [
      ["@@ def run_nightly_billing(): @@", "@"], ["def run_nightly_billing():", " "], ["    # runs from a CronJob on every replica of the billing service", "+"], ["    with db.connect() as conn:  # direct connection, no pooler", "+"],
      ["        conn.execute(\"SELECT pg_advisory_lock(4242)\")", "+", 1], ["        try:", "+"], ["            for customer in due_customers(conn):", "+"], ["                charge(customer)", "+"], ["        finally:", "+"], ["            conn.execute(\"SELECT pg_advisory_unlock(4242)\")", "+"]], k: 1 },
    2: { file: "jobs/nightly_billing.py", lines: [
      ["@@ def run_nightly_billing(): @@", "@"], ["def run_nightly_billing():", " "], ["    conn = pool.getconn()  # psycopg pool, direct to Postgres", "+"], ["    got = conn.execute(\"SELECT pg_try_advisory_lock(4242)\").scalar()", "+"], ["    if not got:", "+"], ["        pool.putconn(conn)", "+"], ["        return  # another replica is billing", "+"],
      ["    for customer in due_customers(conn):", "+"], ["        charge(customer)", "+"], ["    conn.execute(\"SELECT pg_advisory_unlock(4242)\")", "+", 1], ["    pool.putconn(conn)", "+"]], k: 1 },
    3: { file: "jobs/scheduler.py", lines: [
      ["@@ def run_exclusive(job_name, fn): @@", "@"], ["def run_exclusive(job_name, fn):", " "], ["    # app talks to PgBouncer (pool_mode = transaction)", "+"], ["    key = hash(job_name) & 0x7fffffff", "+", 1], ["    with engine.connect() as conn:", "+"],
      ["        if not conn.execute(text(\"SELECT pg_try_advisory_lock(:k)\"), {\"k\": key}).scalar():", "+", 1], ["            return False", "+"], ["        try:", "+"], ["            fn(conn)", "+"], ["        finally:", "+"], ["            conn.execute(text(\"SELECT pg_advisory_unlock(:k)\"), {\"k\": key})", "+"], ["    return True", "+"]], k: 2 },
  };
  S.push({
    id: "pg-advisory-lock-review",
    name: "Review the run-once cron job",
    kind: "Code review",
    skills: ["design", "safe"],
    w: "lines",
    gen(lv, R) { return { lv, pods: R.int(3, 8), cust: R.int(20, 90) * 1000 }; },
    text: (I) => `<p>The billing service runs as <b>${I.pods} replicas</b>, and each one fires the same nightly job. Exactly one replica must bill the ${K.num(I.cust)} due customers each night; a second run double-charges people. The PR uses a Postgres advisory lock to make the job run once.</p><p>Flag the line${ADV[I.lv].k > 1 ? "s" : ""} that ${ADV[I.lv].k > 1 ? "are bugs" : "is the bug"} (${ADV[I.lv].k}).</p>`,
    ui: (I) => ({ lines: ADV[I.lv].lines.map(([t, k]) => ({ t, k })), file: ADV[I.lv].file, k: ADV[I.lv].k }),
    ans: (I) => ADV[I.lv].lines.map((x, i) => (x[2] ? i : -1)).filter((i) => i >= 0),
    diag: (I) => I.lv === 3 ? "Think about where the session-level lock lives when a pooler hands out a different server connection per transaction, and about whether every replica computes the same key." : "Not quite. Walk through what happens on the second replica, and on an exception.",
    hint: (I) => I.lv === 1 ? "What does the second replica do when the lock is taken: give up, or wait and then run?" : I.lv === 2 ? "What happens to the lock if charge() raises?" : "Python's hash() of a string is randomised per process. And session-level locks belong to a server connection.",
    concept: "Advisory locks for leader election",
    how: "pg_advisory_lock(key) takes an application-defined lock; pg_try_advisory_lock returns false immediately if someone else holds it. Session-level advisory locks last until explicitly unlocked or the session ends, even across transactions and rollbacks; pg_advisory_xact_lock / pg_try_advisory_xact_lock release automatically at transaction end. A blocking lock in a run-once job just serialises the replicas: each one runs after the previous finishes. An unlock on the success path only leaks the lock on an exception while the pooled connection lives on. Behind PgBouncer in transaction mode, consecutive transactions may run on different server connections, so a session-level lock and its unlock can land on different backends; use the transaction-level variant inside the job's transaction. The key must be identical in every process.",
    rule: "For run-once jobs use pg_try_advisory_xact_lock(stable_key) inside the job's transaction (or try-lock plus unlock in finally on a dedicated, non-pooled connection), and derive the key deterministically (a constant or hashtext('job-name') in SQL), never from a per-process hash.",
    why: (I) => I.lv === 1 ? `pg_advisory_lock waits: the other ${I.pods - 1} replicas queue up and each bills everyone again as soon as the previous one unlocks. pg_try_advisory_lock and returning when it's false is what makes it run once.` : I.lv === 2 ? "If charge() raises, the unlock never runs and the connection goes back to the pool still holding the session-level lock: tomorrow the job silently skips on every replica whose pool hands out that connection. Unlock in a finally block, or use a transaction-level lock." : "hash() of a str is salted per process (PYTHONHASHSEED), so each replica locks a different key and all of them run. And with PgBouncer in transaction mode, the session-level lock is taken on whichever server connection served that statement; later statements and the unlock can run elsewhere, leaving a lock stuck on a backend. Use a fixed key (or hashtext in SQL) with pg_try_advisory_xact_lock in the same transaction as the work.",
  });

  /* ======================= 5. int4 primary key runway ======================= */
  const INT4 = 2147483647;
  const runwayDays = (I) => {
    if (I.lv === 1) return (INT4 - I.max) / I.rate;
    if (I.lv === 2) return (INT4 - I.seq) / (I.seqWeek / 7);
    let left = INT4 - I.seq, w = 0, r = I.seqWeek;
    while (left > 0 && w < 10000) { r *= 1 + I.g / 100; if (r >= left) return w * 7 + (left / r) * 7; left -= r; w++; }
    return w * 7;
  };
  S.push({
    id: "pg-int4-runway",
    name: "How long until the id overflows?",
    kind: "Estimate",
    skills: ["estimate", "diagnose"],
    w: "num",
    gen(lv, R) {
      const max = (lv === 3 ? R.int(1200, 1500) : R.int(1850, 2050)) * 1e6 + R.int(0, 999999);
      if (lv === 1) return { lv, max, rate: R.int(2, 6) * 1e6 };
      const seq = max + R.int(30, 90) * 1e6, rowsWeek = R.int(8, 20) * 1e6, seqWeek = rowsWeek * R.pick([2, 3, 4]);
      return { lv, max, seq, rowsWeek, seqWeek, g: lv === 3 ? R.pick([3, 4, 5, 6]) : 0 };
    },
    text: (I) => `<p><code>events.id</code> is an <code>integer</code> (int4) fed by a sequence, max value <b>2,147,483,647</b>. When it runs out, every insert fails with <code>nextval: reached maximum value of sequence</code>.</p>${I.lv === 1
      ? K.pre(`SELECT max(id) FROM events;        -- ${K.num(I.max)}\n-- the table grows by a steady ${K.num(I.rate)} rows/day`)
      : K.pre(`SELECT max(id) FROM events;                    -- ${K.num(I.max)}\nSELECT last_value FROM events_id_seq;          -- ${K.num(I.seq)}\n-- over the last 7 days: rows +${K.num(I.rowsWeek)}, last_value +${K.num(I.seqWeek)}\n-- writes use INSERT ... ON CONFLICT (event_key) DO UPDATE`) + (I.lv === 3 ? `<p>Traffic has grown <b>${I.g}% week over week</b> for a year and Product expects that to continue.</p>` : "")}
      <p>How many <b>days</b> until inserts start failing?</p>`,
    ui: () => ({ unit: "days" }),
    accept: (I, a) => LB.near(runwayDays, I.lv === 3 ? 0.12 : 0.1)(I, a),
    solve: (I) => Math.round(runwayDays(I)),
    bad: (I) => I.lv === 1 ? [Math.round((INT4 - I.max) / I.rate * 2), Math.round((4294967295 - I.max) / I.rate)] : I.lv === 2 ? [Math.round((INT4 - I.max) / (I.rowsWeek / 7))] : [Math.round((INT4 - I.seq) / (I.seqWeek / 7))],
    hint: (I) => I.lv === 1 ? "Remaining ids divided by ids used per day." : I.lv === 2 ? "Rows aren't what runs out. What does an upsert that hits a conflict do to the sequence?" : "Sum a growing weekly consumption until it covers the remaining ids.",
    concept: "Integer key exhaustion",
    how: "int4 tops out at 2,147,483,647. A sequence hands out values whether or not the row survives: rolled-back inserts, failed inserts and INSERT ... ON CONFLICT (which calls nextval before discovering the conflict) all consume ids, so the sequence's last_value, not max(id) or the row count, measures what's left. Runway is remaining values divided by sequence consumption rate, and with growing traffic it shrinks faster than a linear estimate suggests. Converting a big table to bigint safely takes weeks of preparation (new column, trigger, batched backfill, concurrent index, a short swap), so you want the alarm long before the last month.",
    rule: "Alert on sequence usage (last_value / max) at 50% and 75%, measure consumption from the sequence rather than the table, use bigint for every new key, and start the migration while the runway is still measured in months.",
    why: (I, sol) => I.lv === 1 ? `${K.num(INT4 - I.max)} ids left ÷ ${K.num(I.rate)} per day ≈ <b>${K.num(sol)} days</b>.` : I.lv === 2 ? `The sequence, not the table, runs out: ${K.num(INT4 - I.seq)} values left at ${K.num(I.seqWeek / 7)} per day (upserts burn a value even when they update) ≈ <b>${K.num(sol)} days</b>, versus ${K.num(Math.round((INT4 - I.max) / (I.rowsWeek / 7)))} days if you counted rows.` : `With ${I.seqWeek / 1e6}M values/week growing ${I.g}% weekly, the remaining ${K.num(INT4 - I.seq)} values last about <b>${K.num(sol)} days</b>, against ${K.num(Math.round((INT4 - I.seq) / (I.seqWeek / 7)))} days at today's rate.`,
  });

  /* ======================= 6. int4 → bigint without downtime ======================= */
  const BIG = {
    text: {
      add: "ALTER TABLE events ADD COLUMN id_new bigint;",
      trig: "Install a trigger that sets NEW.id_new := NEW.id on INSERT and UPDATE",
      fill: "Backfill id_new in batches of 10k rows (UPDATE ... WHERE id BETWEEN x AND y), pausing when replica lag grows",
      idx: "CREATE UNIQUE INDEX CONCURRENTLY events_id_new_key ON events (id_new);",
      chk: "ADD CONSTRAINT id_new_not_null CHECK (id_new IS NOT NULL) NOT VALID; then VALIDATE CONSTRAINT id_new_not_null",
      seq: "ALTER SEQUENCE events_id_seq AS bigint;",
      child: "Give event_attachments.event_id (int4, FK to events.id) a bigint twin the same way, then add its FK to events.id_new as NOT VALID and VALIDATE it",
      swap: "One short transaction with SET lock_timeout = '2s': drop the old PK (and old FKs), ADD CONSTRAINT events_pkey PRIMARY KEY USING INDEX events_id_new_key, swap column names, move the id default to the new column, drop the trigger",
      dropold: "After a few days, drop the old int4 column(s)",
      t_alter: "ALTER TABLE events ALTER COLUMN id TYPE bigint;",
      t_onebig: "Backfill with a single UPDATE events SET id_new = id;",
      t_idx: "CREATE UNIQUE INDEX events_id_new_key ON events (id_new);",
      t_neg: "ALTER SEQUENCE events_id_seq MINVALUE -2147483648 RESTART WITH -2147483648; and call it done",
      t_fkplain: "Re-create the child foreign key with a plain ALTER TABLE ... ADD FOREIGN KEY during the swap transaction",
    },
    pool: (lv) => ["add", "trig", "fill", "idx", "chk", "swap", "dropold", "t_alter", "t_onebig", "t_idx", ...(lv >= 2 ? ["seq", "t_neg"] : []), ...(lv === 3 ? ["child", "t_fkplain"] : [])],
    need: (I) => ["add", "trig", "fill", "idx", "chk", ...(I.lv >= 2 ? ["seq"] : []), ...(I.lv === 3 ? ["child"] : []), "swap", "dropold"],
    before: { trig: ["add"], fill: ["trig"], idx: ["add"], chk: ["fill"], child: ["idx"], swap: ["idx", "chk", "fill", "seq", "child"], dropold: ["swap"] },
    trap: {
      t_alter: "rewrites the whole table and every index under an ACCESS EXCLUSIVE lock: hours of downtime on a table this size.",
      t_onebig: "one transaction touching every row: it locks them all against concurrent updates, doubles the table with dead tuples that VACUUM can't remove until it commits, and floods replicas with WAL.",
      t_idx: "a plain CREATE INDEX blocks every insert and update on the table for the whole build.",
      t_neg: "buys time by using negative ids, but it's a stopgap that breaks code assuming positive or increasing ids, not a fix (and the sequence still needs to become bigint).",
      t_fkplain: "a plain ADD FOREIGN KEY validates every child row while holding locks inside the swap transaction, turning a millisecond swap into minutes of blocked writes.",
    },
  };
  S.push({
    id: "pg-int-to-bigint",
    name: "Widen the primary key to bigint, online",
    kind: "Change plan",
    skills: ["safe", "design"],
    ...planDef(BIG),
    gen(lv, R) { return { lv, keys: planKeys(BIG, lv, R), rows: R.int(9, 18) * 100, days: R.int(40, 75) }; },
    text: (I) => `<p><code>events.id</code> (int4, primary key, ${I.rows}M rows, 6k inserts/s) will overflow in about <b>${I.days} days</b>. The service can't take more than a few seconds of write downtime.${I.lv >= 2 ? " The id comes from <code>events_id_seq</code>, created by <code>serial</code>." : ""}${I.lv === 3 ? " <code>event_attachments.event_id</code> (int4, 300M rows) has a foreign key to <code>events.id</code>." : ""}</p><p>Build the migration plan, in order. Some steps are traps.</p>`,
    bad: (I) => [[I.keys.indexOf("t_alter")], BIG.need(I).filter((k) => k !== "trig").map((k) => I.keys.indexOf(k)), BIG.need(I).map((k) => I.keys.indexOf(k === "idx" ? "t_idx" : k))],
    hint: (I) => I.lv === 1 ? "Expand, copy, then swap in a short transaction. New rows must get the new column before the backfill starts, or they'll be missed." : I.lv === 2 ? "serial creates its sequence AS integer. What's the sequence's maximum?" : "The child table's FK column is int4 too, and its constraint points at the old column.",
    concept: "Online int → bigint migration",
    how: "ALTER COLUMN ... TYPE bigint rewrites the table and its indexes under an ACCESS EXCLUSIVE lock. The online alternative adds a bigint column, keeps it in sync with a trigger, backfills existing rows in small batches, builds the unique index CONCURRENTLY, proves NOT NULL with a NOT VALID check constraint that's validated separately (SET NOT NULL then skips its scan, PG12+), and finally swaps in one short transaction: ADD PRIMARY KEY USING INDEX reuses the prebuilt index. Sequences created by serial are AS integer and must be altered to bigint too. Referencing foreign-key columns need the same treatment, with the new FK added NOT VALID and validated outside the swap.",
    rule: "Never ALTER TYPE a large hot column in place: add, sync with a trigger, backfill in batches, index concurrently, validate constraints separately, then swap in a lock_timeout-guarded transaction; and create new keys as bigint from day one.",
    why: (I) => `The plan keeps every step either instant (catalog changes) or online (batched backfill, CONCURRENTLY, NOT VALID + VALIDATE)${I.lv >= 2 ? ", widens the serial sequence, which is capped at 2^31−1 itself" : ""}${I.lv === 3 ? ", migrates event_attachments.event_id before the swap" : ""}, and limits the exclusive lock to the final swap transaction, guarded by lock_timeout.`,
  });

  /* ======================= 7. dead tuples held by the xmin horizon (term) ======================= */
  const tbl = (head, rows) => K.cols([head, head.map((h) => "-".repeat(h.length)), ...rows]) + `\n(${rows.length} row${rows.length === 1 ? "" : "s"})`;
  const ago = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:${String((min * 7) % 60).padStart(2, "0")}`;
  function xminShell(I) {
    const P = I.pids;
    const prim = [
      { pid: P[0], user: "app", app: "sessions-api", state: "active", xact: 0, xmin: 2, query: "UPDATE sessions SET last_seen = now() WHERE id = $1", kind: "app" },
      { pid: P[1], user: "app", app: "sessions-api", state: "idle", xact: null, xmin: null, query: "COMMIT", kind: "app" },
      { pid: P[2], user: "app", app: "billing-worker", state: "active", xact: 1, xmin: 40, query: "SELECT ... FROM invoices WHERE due_at < now() FOR UPDATE SKIP LOCKED", kind: "app" },
      { pid: P[3], user: "postgres", app: "", state: "active", xact: 3, xmin: null, query: "autovacuum: VACUUM public.sessions", kind: "av" },
    ];
    if (I.lv === 1) prim.push({ pid: P[4], user: I.who, app: "psql", state: "idle in transaction", xact: I.hours * 60, xmin: I.xid, query: "SELECT count(*) FROM sessions WHERE user_id = 4711", kind: "culprit" });
    const replica = I.lv === 3 ? [
      { pid: P[5], user: "analytics", app: "Metabase", state: "active", xact: I.hours * 60 + 7, xmin: I.xid, query: "SELECT date_trunc('week', created_at), count(DISTINCT user_id) FROM events JOIN sessions USING (user_id) GROUP BY 1", kind: "culprit" },
      { pid: P[6], user: "app", app: "search-indexer", state: "active", xact: 0, xmin: 3, query: "SELECT id, title FROM products WHERE updated_at > $1", kind: "app" },
    ] : [];
    const slots = [{ name: "replica_1", type: "physical", active: "t", xmin: I.lv === 3 ? I.xid : 60, kind: "live" }];
    if (I.lv === 2) slots.push({ name: "replica_old_az_b", type: "physical", active: "f", xmin: I.xid, kind: "culprit" });
    const st = { host: "primary", prim, replica, slots, vacuumed: false, cleared: false };
    const horizon = (s) => Math.max(...s.prim.filter((x) => x.xmin != null).map((x) => x.xmin), ...s.slots.filter((x) => x.xmin != null).map((x) => (I.lv === 3 && x.kind === "live" ? (s.replica.some((r) => r.kind === "culprit") ? I.xid : 60) : x.xmin)), ...(I.lv === 3 ? s.replica.filter((x) => x.xmin != null).map((x) => x.xmin) : [0]));
    const cur = (s) => (s.host === "primary" ? s.prim : s.replica);
    const act = (s) => tbl(["pid", "usename", "application_name", "state", "xact_age", "age(backend_xmin)", "query"], cur(s).map((x) => [x.pid, x.user, x.app, x.state, x.xact == null ? "" : ago(x.xact), x.xmin == null ? "" : K.num(x.xmin * 1000).replace(/,/g, ""), x.query.length > 60 ? x.query.slice(0, 57) + "..." : x.query]));
    const sh = K.shell([
      { re: /^select .*from pg_stat_activity.*;?$/i, use: "SELECT pid, usename, state, ... FROM pg_stat_activity;", desc: "sessions, open transactions and their xmin", run: (m, s) => act(s) },
      { re: /^select .*from pg_stat_user_tables.*;?$/i, use: "SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ...;", desc: "dead tuples per table", run: (m, s) => s.host !== "primary" ? "(replica: statistics are not collected here for vacuum)" : tbl(["relname", "n_live_tup", "n_dead_tup", "last_autovacuum"], [["sessions", "4210338", s.vacuumed && s.cleared ? "1204" : String(I.dead), "2026-10-12 09:" + String(I.hours + 10).slice(-2) + ":11+00"], ["invoices", "18003221", "40112", "2026-10-12 08:12:40+00"], ["users", "2210931", "981", "2026-10-11 23:01:09+00"]]) },
      { re: /^select .*from pg_replication_slots.*;?$/i, use: "SELECT slot_name, slot_type, active, xmin, ... FROM pg_replication_slots;", desc: "replication slots and the xmin they hold", run: (m, s) => tbl(["slot_name", "slot_type", "active", "age(xmin)", "wal_status"], s.slots.map((x) => [x.name, x.type, x.active, x.xmin == null ? "" : String((I.lv === 3 && x.kind === "live" ? (s.replica.some((r) => r.kind === "culprit") ? I.xid : 60) : x.xmin) * 1000), x.active === "t" ? "reserved" : "extended"])) },
      { re: /^select .*from pg_stat_replication.*;?$/i, use: "SELECT application_name, state, replay_lag, backend_xmin ... FROM pg_stat_replication;", desc: "connected standbys (with hot_standby_feedback xmin)", run: (m, s) => tbl(["application_name", "state", "replay_lag", "age(backend_xmin)"], s.slots.filter((x) => x.active === "t").map((x) => ["replica1", "streaming", "00:00:00.4", I.lv === 3 && s.replica.some((r) => r.kind === "culprit") ? String(I.xid * 1000) : "61000"])) },
      { re: /^select .*from pg_prepared_xacts.*;?$/i, use: "SELECT * FROM pg_prepared_xacts;", desc: "two-phase transactions", run: () => "transaction | gid | prepared | owner | database\n------------+-----+----------+-------+---------\n(0 rows)" },
      { re: /^\\c(?:onnect)? (primary|replica1?)$/i, use: "\\c primary | \\c replica1", desc: "connect to another server", run: (m, s) => { s.host = /^replica/i.test(m[1]) ? "replica1" : "primary"; return `You are now connected to database "app" on host "${s.host}".`; } },
      { re: /^select pg_(cancel|terminate)_backend\((\d+)\);?$/i, use: "SELECT pg_cancel_backend(<pid>); / pg_terminate_backend(<pid>);", desc: "cancel a query / end a session", run: (m, s) => {
        const list = cur(s), x = list.find((y) => y.pid === +m[2]);
        if (!x) return `WARNING:  PID ${m[2]} is not a PostgreSQL backend process\n pg_${m[1]}_backend\n---\n f\n(1 row)`;
        let danger = null;
        if (m[1] === "cancel" && x.state !== "active") return ` pg_cancel_backend\n-------------------\n t\n(1 row)\n-- (nothing to cancel: the session is ${x.state}; its transaction stays open)`;
        if (x.kind === "app") danger = `${x.app} was doing normal short work; killing it errored a live request and freed nothing.`;
        if (x.kind === "av") danger = "You stopped the autovacuum worker that was doing the cleanup; it restarts later and has to start over.";
        if (m[1] === "terminate" || x.kind === "culprit") { const i = list.indexOf(x); list.splice(i, 1); }
        else { x.state = "idle"; x.xact = null; x.xmin = null; }
        return { out: ` pg_${m[1]}_backend\n${"-".repeat(19 + m[1].length - 6)}\n t\n(1 row)`, danger };
      } },
      { re: /^select pg_drop_replication_slot\('([\w-]+)'\);?$/i, use: "SELECT pg_drop_replication_slot('<slot>');", desc: "drop a replication slot", run: (m, s) => {
        const x = s.slots.find((y) => y.name === m[1]);
        if (!x) return `ERROR:  replication slot "${m[1]}" does not exist`;
        if (x.active === "t") return `ERROR:  replication slot "${m[1]}" is active for PID ${I.pids[7]}`;
        s.slots = s.slots.filter((y) => y !== x);
        return " pg_drop_replication_slot\n--------------------------\n \n(1 row)";
      } },
      { re: /^alter system set hot_standby_feedback = (on|off);?$/i, use: "ALTER SYSTEM SET hot_standby_feedback = off;", desc: "(on the replica) stop reporting the replica's xmin", run: (m, s) => s.host === "primary" ? "ALTER SYSTEM\n-- (hot_standby_feedback only matters on a standby)" : { out: "ALTER SYSTEM\n-- takes effect after SELECT pg_reload_conf()", danger: "Turning feedback off makes VACUUM on the primary remove rows the replica's queries still need: those queries will now be cancelled with 'conflict with recovery'. It doesn't end the 7-hour query either." } },
      { re: /^vacuum(?: \(([\w, ]+)\))? ?(\w+)?;?$/i, use: "VACUUM (VERBOSE) sessions;", desc: "vacuum a table now", run: (m, s) => {
        if (s.host !== "primary") return "ERROR:  cannot execute VACUUM during recovery";
        if (/full/i.test(m[1] || "")) return { out: "VACUUM", danger: "VACUUM FULL rewrites the table under an ACCESS EXCLUSIVE lock: sessions-api was down for the duration, and dead rows still visible to the old snapshot are copied along anyway." };
        const h = horizon(s), held = h >= I.xid;
        s.vacuumed = true; s.cleared = !held;
        return `INFO:  vacuuming "app.public.sessions"\nINFO:  finished vacuuming "app.public.sessions": index scans: ${held ? 0 : 1}\npages: 0 removed, 412881 remain, 401220 scanned (97.18% of total)\ntuples: ${held ? 0 : I.dead} removed, 4210338 remain, ${held ? I.dead : 0} are dead but not yet removable\nremovable cutoff: ${9e8 - h * 1000}, which was ${h * 1000} XIDs old when operation ended\nVACUUM`;
      } },
      { re: /^show (\w+);?$/i, use: "SHOW <setting>;", desc: "", run: (m, s) => ({ hot_standby_feedback: s.host === "primary" ? "off" : "on", idle_in_transaction_session_timeout: "0", old_snapshot_threshold: "ERROR:  unrecognized configuration parameter \"old_snapshot_threshold\"" }[m[1].toLowerCase()] || `${m[1]}\n----\n(default)`) },
    ], { sh: "psql" });
    return { prompt: "app=#", init: st, run: (line, s) => sh.run(line, s), par: I.lv === 3 ? 8 : 6,
      motd: `ALERT sessions table 3x its size in 6 days · disk 81% · p99 reads +240%\nautovacuum runs on sessions every few minutes but n_dead_tup keeps climbing\npsql (17.6) · connected to primary as admin`,
      cmds: ["SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;", "SELECT pid, usename, application_name, state, xact_start, age(backend_xmin), query FROM pg_stat_activity;", "SELECT slot_name, slot_type, active, age(xmin) FROM pg_replication_slots;", "SELECT application_name, state, replay_lag, age(backend_xmin) FROM pg_stat_replication;", "VACUUM (VERBOSE) sessions;", "\\c replica1", "SELECT pg_terminate_backend(<pid>);"] };
  }
  S.push({
    id: "pg-xmin-horizon",
    name: "VACUUM runs but nothing gets cleaned",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    gen(lv, R) { return { lv, pids: R.distinct(8, 1100, 98000), hours: R.int(5, 30), xid: R.int(300, 900) * 100, dead: R.int(3, 9) * 1e6 + R.int(0, 999999), who: R.pick(["maria", "dev_ops", "jsmith", "analyst"]) }; },
    ...LB.term({
      shell: (I) => xminShell(I),
      goal(st, I) {
        if (!st.cleared) return st.vacuumed ? "VACUUM still reports dead rows that are not yet removable: something still holds back the xmin horizon." : "The dead rows are still there. Once whatever holds them is gone, run VACUUM to reclaim them (autovacuum would get there too, but show it).";
        return true;
      },
      solve: (I) => ({ log: ["SELECT pid, usename, application_name, state, xact_start, age(backend_xmin), query FROM pg_stat_activity;", ...(I.lv === 1 ? [`SELECT pg_terminate_backend(${I.pids[4]});`] : I.lv === 2 ? ["SELECT slot_name, slot_type, active, age(xmin) FROM pg_replication_slots;", "SELECT pg_drop_replication_slot('replica_old_az_b');"] : ["SELECT application_name, state, replay_lag, age(backend_xmin) FROM pg_stat_replication;", "\\c replica1", "SELECT pid, usename, application_name, state, xact_start, age(backend_xmin), query FROM pg_stat_activity;", `SELECT pg_cancel_backend(${I.pids[5]});`, "\\c primary"]), "VACUUM (VERBOSE) sessions;"] }),
    }),
    bad: (I) => [{ log: ["VACUUM (VERBOSE) sessions;"] }, { log: ["VACUUM (FULL, VERBOSE) sessions;"] }, { log: [`SELECT pg_terminate_backend(${I.pids[3]});`, "VACUUM (VERBOSE) sessions;"] }, ...(I.lv === 3 ? [{ log: ["\\c replica1", "ALTER SYSTEM SET hot_standby_feedback = off;", "\\c primary", "VACUUM (VERBOSE) sessions;"] }] : [])],
    text: (I) => `<p><b>PAGE:</b> <code>sessions</code> (4M live rows, updated constantly) has tripled in size in under a week and reads are slowing down. Autovacuum is running on it all the time. You have <code>psql</code> on the primary${I.lv === 3 ? " and can connect to the streaming replica" : ""}.</p><p>Find out why VACUUM can't remove the dead rows, fix it with the least collateral damage, and show that VACUUM now reclaims them. Type <code>help</code> for what the sandbox understands.</p>`,
    hint: (I) => I.lv === 1 ? "VACUUM can only remove row versions no running transaction could still see. Look for the oldest backend_xmin." : I.lv === 2 ? "No session is old. What else can pin an old xmin on the primary even when nothing is connected?" : "With hot_standby_feedback on, the replica's oldest query holds back the primary's horizon. Where is that query running?",
    concept: "The xmin horizon and dead tuples",
    how: "VACUUM may remove a dead row version only if no transaction could still need it: anything older than the oldest xmin still in use (the 'xmin horizon') must be kept. That horizon is held back by long-running or idle-in-transaction sessions, by replication slots with an xmin (a standby that used hot_standby_feedback, even if it's gone and the slot is inactive), by a standby's long queries reported through hot_standby_feedback, and by orphaned prepared transactions. Autovacuum then runs repeatedly, burns I/O and removes nothing; VACUUM VERBOSE says rows are 'dead but not yet removable'. Ending the holder lets the next VACUUM clean up; space already bloated is reused, not returned to the OS.",
    rule: "When n_dead_tup grows despite autovacuum, check the oldest backend_xmin in pg_stat_activity, xmin in pg_replication_slots, backend_xmin in pg_stat_replication and pg_prepared_xacts; set idle_in_transaction_session_timeout and alert on transaction age and inactive slots.",
    why: (I) => I.lv === 1 ? `Session ${I.pids[4]} (${esc(I.who)}, psql) had been idle in transaction for ~${I.hours} hours: its snapshot kept every row version since then alive. Cancelling does nothing to an idle session; terminating it ends the transaction.` : I.lv === 2 ? "The physical slot replica_old_az_b belonged to a decommissioned standby that had hot_standby_feedback on. Inactive, it still pinned its last xmin (and WAL). Dropping it released the horizon; the live replica_1 slot must stay." : `The replica runs with hot_standby_feedback = on, so its ${I.hours}-hour Metabase query was reported to the primary as an xmin to keep. Cancelling that query on the replica released it. Turning feedback off would instead get the replica's queries cancelled by recovery conflicts; the long-term fix is a statement_timeout for analytics on the replica.`,
  });

  /* ======================= 8. transaction ID wraparound (term) ======================= */
  function wrapShell(I) {
    const tables = [
      { name: "public.events", age: I.lv === 1 ? 1.9e9 : 1.2e9, size: "2.1 TB", cat: false },
      { name: "public.orders", age: 1.05e9, size: "380 GB", cat: false },
      { name: "public.users", age: 6.1e8, size: "41 GB", cat: false },
      { name: "pg_catalog.pg_attribute", age: I.lv === 3 ? 2.09e9 : 2.1e8, size: "190 MB", cat: true },
      { name: "pg_catalog.pg_class", age: I.lv === 3 ? 2.07e9 : 2.0e8, size: "60 MB", cat: true },
    ];
    if (I.lv === 2) tables.push({ name: `pg_temp_${I.tmp}.import_buffer`, age: 2.1e9, size: "12 MB", cat: false, temp: true });
    const st = { tables, prepared: I.lv === 1 ? [{ gid: I.gid, age: 1.95e9 }] : [], slots: [{ name: "cdc_orders", type: "logical", active: "t", catalog: 9.8e7, live: true }], sessions: [{ pid: I.pids[0], app: "importer", state: "idle", age: "4 days", tmp: I.lv === 2 }, { pid: I.pids[1], app: "orders-api", state: "active", age: "" }, { pid: I.pids[2], app: "orders-api", state: "idle", age: "" }] };
    if (I.lv === 3) st.slots.push({ name: "cdc_search_old", type: "logical", active: "f", catalog: 2.1e9, live: false });
    const horizonAll = (s) => Math.max(0, ...s.prepared.map((p) => p.age));
    const horizonCat = (s) => Math.max(horizonAll(s), ...s.slots.map((x) => x.catalog));
    const dbAge = (s) => Math.max(...s.tables.map((t) => t.age));
    const left = (s) => Math.max(0, 2147483647 - 3e6 - dbAge(s));
    const vac = (s, t) => { if (t.temp) return `WARNING:  skipping vacuum of "${t.name.split(".")[1]}" --- cannot vacuum temporary tables of other sessions`; t.age = Math.max(t.cat ? horizonCat(s) : horizonAll(s), 5e4); return null; };
    const sh = K.shell([
      { re: /^select .*from pg_database.*;?$/i, use: "SELECT datname, age(datfrozenxid) FROM pg_database;", desc: "how old each database's oldest unfrozen XID is", run: (m, s) => tbl(["datname", "age(datfrozenxid)", "xids_left"], [["app", String(dbAge(s)), String(left(s))], ["postgres", "38211904", ""], ["template1", "38211904", ""]]) },
      { re: /^select .*from pg_class.*;?$/i, use: "SELECT c.oid::regclass, age(c.relfrozenxid), ... FROM pg_class c WHERE relkind IN ('r','t','m') ORDER BY 2 DESC LIMIT 10;", desc: "the oldest tables (including catalogs and temp tables)", run: (m, s) => tbl(["relation", "age(relfrozenxid)", "size"], s.tables.slice().sort((a, b) => b.age - a.age).map((t) => [t.name, String(t.age), t.size])) },
      { re: /^select .*from pg_prepared_xacts.*;?$/i, use: "SELECT gid, prepared, age(transaction) FROM pg_prepared_xacts;", desc: "two-phase transactions waiting for COMMIT/ROLLBACK PREPARED", run: (m, s) => tbl(["gid", "prepared", "age(transaction)"], s.prepared.map((p) => [p.gid, "2026-09-10 03:12:44+00", String(p.age)])) },
      { re: /^select .*from pg_replication_slots.*;?$/i, use: "SELECT slot_name, slot_type, active, age(xmin), age(catalog_xmin) FROM pg_replication_slots;", desc: "slots and the XIDs they pin", run: (m, s) => tbl(["slot_name", "slot_type", "active", "age(xmin)", "age(catalog_xmin)"], s.slots.map((x) => [x.name, x.type, x.active, "", String(x.catalog)])) },
      { re: /^select .*from pg_stat_activity.*;?$/i, use: "SELECT pid, application_name, state, backend_start, query FROM pg_stat_activity;", desc: "sessions", run: (m, s) => tbl(["pid", "application_name", "state", "connected_for", "query"], s.sessions.map((x) => [x.pid, x.app, x.state, x.age || "00:01:12", x.tmp ? "INSERT INTO import_buffer SELECT ..." : "SELECT ..."])) },
      { re: /^select .*from pg_stat_progress_vacuum.*;?$/i, use: "SELECT * FROM pg_stat_progress_vacuum;", desc: "running vacuums", run: () => tbl(["pid", "relid", "phase", "heap_blks_scanned"], [[I.pids[3], "events", "scanning heap", "88112311"]]) + "\n-- autovacuum: VACUUM public.events (to prevent wraparound), restarts every time it finishes: the horizon doesn't move" },
      { re: /^rollback prepared '([\w.:-]+)';?$/i, use: "ROLLBACK PREPARED '<gid>';", desc: "abort an orphaned prepared transaction", run: (m, s) => { const p = s.prepared.find((x) => x.gid === m[1]); if (!p) return `ERROR:  prepared transaction with identifier "${m[1]}" does not exist`; s.prepared = s.prepared.filter((x) => x !== p); return "ROLLBACK PREPARED"; } },
      { re: /^commit prepared '([\w.:-]+)';?$/i, use: "COMMIT PREPARED '<gid>';", desc: "", run: (m, s) => { const p = s.prepared.find((x) => x.gid === m[1]); if (!p) return `ERROR:  prepared transaction with identifier "${m[1]}" does not exist`; s.prepared = s.prepared.filter((x) => x !== p); return { out: "COMMIT PREPARED", danger: "That transaction's coordinator crashed a month ago and nobody knows what it did; committing it applied month-old writes blindly. Rolling it back is the safe default for an orphan." }; } },
      { re: /^select pg_drop_replication_slot\('([\w-]+)'\);?$/i, use: "SELECT pg_drop_replication_slot('<slot>');", desc: "drop a slot", run: (m, s) => { const x = s.slots.find((y) => y.name === m[1]); if (!x) return `ERROR:  replication slot "${m[1]}" does not exist`; s.slots = s.slots.filter((y) => y !== x); return x.live ? { out: " pg_drop_replication_slot\n---\n \n(1 row)", danger: "cdc_orders is the live CDC pipeline: dropping it forces a full re-snapshot of every downstream consumer." } : " pg_drop_replication_slot\n--------------------------\n \n(1 row)"; } },
      { re: /^select pg_terminate_backend\((\d+)\);?$/i, use: "SELECT pg_terminate_backend(<pid>);", desc: "end a session (its temp tables are dropped)", run: (m, s) => { const x = s.sessions.find((y) => y.pid === +m[1]); if (!x) return `WARNING:  PID ${m[1]} is not a PostgreSQL backend process`; s.sessions = s.sessions.filter((y) => y !== x); if (x.tmp) s.tables = s.tables.filter((t) => !t.temp); return { out: " pg_terminate_backend\n----------------------\n t\n(1 row)", danger: x.tmp ? null : "That session wasn't involved." }; } },
      { re: /^drop table (pg_temp_\d+\.\w+);?$/i, use: "DROP TABLE <schema.table>;", desc: "", run: (m, s) => { const t = s.tables.find((x) => x.name === m[1]); if (!t) return `ERROR:  table "${m[1]}" does not exist`; s.tables = s.tables.filter((x) => x !== t); return "DROP TABLE"; } },
      { re: /^vacuum(?: \(([\w, ]+)\))?(?: ([\w.]+))?;?$/i, use: "VACUUM (FREEZE, VERBOSE) <table>;", desc: "vacuum (and freeze) one table, or the whole database", run: (m, s) => {
        if (/full/i.test(m[1] || "")) return { out: "VACUUM", danger: "VACUUM FULL rewrites the table under an ACCESS EXCLUSIVE lock: hours of downtime on 2 TB, when a normal VACUUM freezes rows just as well." };
        const before = dbAge(s);
        if (m[2]) { const t = s.tables.find((x) => x.name === m[2] || x.name.endsWith("." + m[2])); if (!t) return `ERROR:  relation "${m[2]}" does not exist`; const w = vac(s, t); if (w) return w + "\nVACUUM"; }
        else { const ws = s.tables.map((t) => vac(s, t)).filter(Boolean); if (ws.length) return ws.join("\n") + "\nVACUUM"; }
        const after = dbAge(s);
        return `INFO:  aggressively vacuuming ...\nnew relfrozenxid: advanced\nVACUUM${after >= before ? "\n-- age(datfrozenxid) unchanged: something still holds the oldest XID back" : ""}`;
      } },
    ], { sh: "psql" });
    return { prompt: "app=#", init: st, run: (line, s) => sh.run(line, s), par: I.lv === 3 ? 8 : 7,
      motd: `WARNING:  database "app" must be vacuumed within ${K.num(2147483647 - 3e6 - 2.1e9)} transactions\nHINT:  To avoid XID assignment failures, execute a database-wide VACUUM in that database.\nYou might also need to commit or roll back old prepared transactions, or drop stale replication slots.\n-- the app burns ~2,500 XIDs/s: roughly 4 hours left`,
      cmds: ["SELECT datname, age(datfrozenxid) FROM pg_database;", "SELECT c.oid::regclass, age(c.relfrozenxid) FROM pg_class c WHERE relkind IN ('r','t','m') ORDER BY 2 DESC LIMIT 10;", "SELECT gid, prepared, age(transaction) FROM pg_prepared_xacts;", "SELECT slot_name, slot_type, active, age(xmin), age(catalog_xmin) FROM pg_replication_slots;", "SELECT pid, application_name, state, backend_start, query FROM pg_stat_activity;", "VACUUM (FREEZE, VERBOSE) <table>;"] };
  }
  S.push({
    id: "pg-xid-wraparound",
    name: "Hours from transaction ID wraparound",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    gen(lv, R) { return { lv, pids: R.distinct(4, 1100, 98000), tmp: R.int(3, 60), gid: `tx_${R.int(100000, 999999)}_billing` }; },
    ...LB.term({
      shell: (I) => wrapShell(I),
      goal(st) {
        const age = Math.max(...st.tables.map((t) => t.age));
        if (age > 1.5e9) return `<code>age(datfrozenxid)</code> is still ${K.num(age)}: Postgres will stop assigning XIDs in hours. Find what keeps the oldest XID from advancing, remove it, then freeze the oldest relations.`;
        return true;
      },
      solve: (I) => ({ log: ["SELECT c.oid::regclass, age(c.relfrozenxid) FROM pg_class c WHERE relkind IN ('r','t','m') ORDER BY 2 DESC LIMIT 10;", ...(I.lv === 1 ? ["SELECT gid, prepared, age(transaction) FROM pg_prepared_xacts;", `ROLLBACK PREPARED '${I.gid}';`, "VACUUM (FREEZE, VERBOSE) public.events;"] : I.lv === 2 ? ["SELECT pid, application_name, state, backend_start, query FROM pg_stat_activity;", `SELECT pg_terminate_backend(${I.pids[0]});`, "VACUUM (FREEZE, VERBOSE) public.events;"] : ["SELECT slot_name, slot_type, active, age(xmin), age(catalog_xmin) FROM pg_replication_slots;", "SELECT pg_drop_replication_slot('cdc_search_old');", "VACUUM (FREEZE, VERBOSE) pg_catalog.pg_attribute;", "VACUUM (FREEZE, VERBOSE) pg_catalog.pg_class;"])] }),
    }),
    bad: (I) => [{ log: ["VACUUM (FREEZE, VERBOSE);"] }, { log: ["VACUUM (FULL, FREEZE) public.events;"] }, ...(I.lv === 3 ? [{ log: ["SELECT pg_drop_replication_slot('cdc_orders');", "VACUUM (FREEZE);"] }] : [])],
    text: (I) => `<p><b>PAGE:</b> the primary's log is full of wraparound warnings (below). At the current XID burn rate there are about <b>4 hours</b> left before Postgres refuses new transactions to protect the data. Autovacuum has been running "to prevent wraparound" for days.</p><p>Find what's stopping the oldest XID from advancing, fix it with the least collateral damage, and bring <code>age(datfrozenxid)</code> for <code>app</code> back under 1.5 billion.</p>`,
    hint: (I) => I.lv === 1 ? "The HINT names the usual suspects. Freezing can't move past the oldest XID still in use." : I.lv === 2 ? "Look at what the oldest relation is. Can autovacuum (or you) vacuum it at all?" : "The oldest relations are system catalogs. Which kind of slot pins catalog rows?",
    concept: "Transaction ID wraparound",
    how: "XIDs are 32-bit and compared modulo 2^32, so a row's xmin must be 'frozen' before it becomes 2 billion transactions old or it would appear to be in the future. VACUUM freezes old rows and advances relfrozenxid; a database's datfrozenxid is the oldest of its tables, catalogs and temp tables included. Autovacuum forces anti-wraparound vacuums at autovacuum_freeze_max_age (200M), warns at 40M XIDs left and stops assigning XIDs at 3M left. VACUUM can't freeze past the oldest XID still needed: orphaned prepared transactions, long transactions, and replication slots (a logical slot's catalog_xmin pins catalog rows) block it. Temp tables can only be vacuumed by their own session.",
    rule: "Monitor age(datfrozenxid) and the oldest relfrozenxid and alert well before 1 billion; when it climbs, first remove what pins the horizon (prepared transactions, slots, long sessions, orphaned temp tables), then VACUUM (FREEZE) the oldest relations, never VACUUM FULL.",
    why: (I) => I.lv === 1 ? `A two-phase transaction '${esc(I.gid)}' from a crashed coordinator had been prepared for a month; every VACUUM stopped freezing at its XID. ROLLBACK PREPARED released it and a freeze of events advanced datfrozenxid.` : I.lv === 2 ? `The oldest relation was a temp table (pg_temp_${I.tmp}.import_buffer) of an importer connection idle for 4 days. Only its own session can vacuum it, so autovacuum skipped it forever. Ending that session dropped the table.` : "The oldest relations were catalogs, pinned by the inactive logical slot cdc_search_old (its catalog_xmin was 2.1 billion XIDs old). Dropping the stale slot, never the live cdc_orders, let the catalogs be frozen.",
  });

  /* ======================= 9. CREATE INDEX CONCURRENTLY gone wrong (term) ======================= */
  function cicShell(I) {
    const parts = ["events_2026_06", "events_2026_07", "events_2026_08", "events_2026_09"];
    const st = { idx: {}, done: false, blocker: I.lv === 2, waiting: I.lv === 2, parts, partIdx: {}, parentIdx: null, attached: {} };
    if (I.lv === 1) st.idx.users_email_lower_key = { def: "UNIQUE, btree (lower(email))", valid: false };
    if (I.lv === 2) st.idx.orders_merchant_created_idx = { def: "btree (merchant_id, created_at)", valid: false, building: true };
    const P = I.pids;
    const sh = K.shell([
      { re: /^\\d\+? (\w+)$/i, use: "\\d <table>", desc: "describe a table and its indexes", run: (m, s) => {
        const t = m[1];
        if (I.lv === 3 && t === "events") return `Partitioned table "public.events"\n Column  | Type\n---------+------------\n id      | bigint\n user_id | bigint\n ts      | timestamptz\nPartition key: RANGE (ts)\nIndexes:\n    "events_pkey" PRIMARY KEY, btree (id, ts)${s.parentIdx ? `\n    "${s.parentIdx}" btree (user_id)${parts.every((p) => s.attached[p]) ? "" : " INVALID"}` : ""}\nNumber of partitions: 4 (Use \\d+ to list them.)`;
        if (I.lv === 3 && parts.includes(t)) return `Table "public.${t}"\nPartition of: events\nIndexes:\n    "${t}_pkey" PRIMARY KEY, btree (id, ts)${s.partIdx[t] ? `\n    "${s.partIdx[t]}" btree (user_id)` : ""}`;
        const main = I.lv === 1 ? "users" : "orders";
        if (t !== main) return `Did not find any relation named "${t}".`;
        return `Table "public.${main}"\n${I.lv === 1 ? " id         | bigint\n email      | text\n deleted_at | timestamptz" : " id          | bigint\n merchant_id | bigint\n created_at  | timestamptz"}\nIndexes:\n    "${main}_pkey" PRIMARY KEY, btree (id)` + Object.entries(s.idx).map(([n, x]) => `\n    "${n}" ${x.def}${x.valid ? "" : " INVALID"}`).join("");
      } },
      { re: /^select .*count\(\*\).*from users.*group by.*;?$/i, use: "SELECT lower(email), count(*), ... FROM users GROUP BY 1 HAVING count(*) > 1;", desc: "find duplicate emails", run: () => tbl(["lower", "count", "ids", "deleted_at"], [[I.dup[0], "2", `{${P[0]},${P[1]}}`, "{2025-11-02 10:12:00+00,NULL}"], [I.dup[1], "2", `{${P[2]},${P[3]}}`, "{NULL,2026-02-17 08:40:31+00}"]]) },
      { re: /^select .*from pg_stat_progress_create_index.*;?$/i, use: "SELECT pid, phase, ... FROM pg_stat_progress_create_index;", desc: "progress of index builds", run: (m, s) => s.waiting ? tbl(["pid", "relid", "phase", "lockers_total", "lockers_done", "current_locker_pid"], [[P[4], "orders", "waiting for old snapshots", "1", "0", String(P[5])]]) : "(0 rows)" },
      { re: /^select .*from pg_stat_activity.*;?$/i, use: "SELECT pid, application_name, state, xact_start, query FROM pg_stat_activity;", desc: "sessions", run: (m, s) => tbl(["pid", "application_name", "state", "xact_age", "query"], [[P[6], "orders-api", "active", "00:00:00", "INSERT INTO orders ..."], ...(s.waiting ? [[P[4], "psql", "active", "02:41:19", "CREATE INDEX CONCURRENTLY orders_merchant_created_idx ON orders (merchant_id, created_at)"]] : []), ...(s.blocker ? [[P[5], "Metabase", "idle in transaction", "05:12:40", "SELECT merchant_id, sum(total) FROM payouts GROUP BY 1"]] : []), [P[7], "orders-api", "idle", "", "COMMIT"]]) },
      { re: /^select pg_(cancel|terminate)_backend\((\d+)\);?$/i, use: "SELECT pg_cancel_backend(<pid>); / pg_terminate_backend(<pid>);", desc: "", run: (m, s) => {
        const pid = +m[2];
        if (s.blocker && pid === P[5]) { if (m[1] === "cancel") return " pg_cancel_backend\n-------------------\n t\n(1 row)\n-- (the session is idle in transaction: nothing to cancel)"; s.blocker = false; s.waiting = false; s.idx.orders_merchant_created_idx = { def: "btree (merchant_id, created_at)", valid: true }; return " pg_terminate_backend\n----------------------\n t\n(1 row)\n-- CREATE INDEX CONCURRENTLY (pid " + P[4] + ") finished"; }
        if (s.waiting && pid === P[4]) { s.waiting = false; s.idx.orders_merchant_created_idx = { def: "btree (merchant_id, created_at)", valid: false }; return { out: ` pg_${m[1]}_backend\n---\n t\n(1 row)\n-- ERROR:  canceling statement due to user request (CREATE INDEX CONCURRENTLY)`, danger: "You threw away 2h40m of index build; the index is left INVALID and still slows every write until dropped." }; }
        if (pid === P[6] || pid === P[7]) return { out: ` pg_${m[1]}_backend\n---\n t\n(1 row)`, danger: "That was live API traffic." };
        return `WARNING:  PID ${pid} is not a PostgreSQL backend process`;
      } },
      { re: /^drop index (concurrently )?(?:if exists )?(\w+);?$/i, use: "DROP INDEX CONCURRENTLY <index>;", desc: "", run: (m, s) => { if (!s.idx[m[2]]) return `ERROR:  index "${m[2]}" does not exist`; delete s.idx[m[2]]; return m[1] ? "DROP INDEX" : { out: "DROP INDEX", danger: "Plain DROP INDEX takes an ACCESS EXCLUSIVE lock on the table: it queued behind running queries and every query on the table queued behind it." }; } },
      { re: /^create (unique )?index (concurrently )?(?:(\w+) )?on (only )?(\w+)(?: using \w+)? ?\(([^)]*\)?)\)( where .+)?;?$/i, use: "CREATE [UNIQUE] INDEX [CONCURRENTLY] <name> ON [ONLY] <table> (...) [WHERE ...];", desc: "build an index", run: (m, s, line) => {
        const uniq = !!m[1], conc = !!m[2], name = m[3] || `${m[5]}_idx`, only = !!m[4], t = m[5], cols = m[6].toLowerCase().replace(/\s+/g, ""), where = (m[7] || "").toLowerCase();
        if (I.lv === 1) {
          if (t !== "users") return `ERROR:  relation "${t}" does not exist`;
          if (!uniq || !/lower\(email\)/.test(cols)) return `CREATE INDEX\n-- (that doesn't enforce unique emails)`;
          if (s.idx[name]) return `ERROR:  relation "${name}" already exists`;
          const ok = /deleted_at is null/.test(where);
          if (!ok) { if (conc) s.idx[name] = { def: "UNIQUE, btree (lower(email))", valid: false }; return { out: `ERROR:  could not create unique index "${name}"\nDETAIL:  Key (lower(email))=(${I.dup[0]}) is duplicated.`, danger: conc ? null : "A plain CREATE INDEX held a lock blocking all writes to users for the whole build, then failed anyway." }; }
          s.idx[name] = { def: "UNIQUE, btree (lower(email)) WHERE deleted_at IS NULL", valid: true, good: true };
          return conc ? "CREATE INDEX" : { out: "CREATE INDEX", danger: "Without CONCURRENTLY the build blocked every INSERT/UPDATE on users (80M rows: ~20 minutes)." };
        }
        if (I.lv === 2) return `ERROR:  relation "${name}" already exists`;
        if (t === "events") {
          if (conc) return "ERROR:  cannot create index on partitioned table \"events\" concurrently";
          if (!only) { s.parentIdx = name; parts.forEach((p) => { s.partIdx[p] = `${p}_user_id_idx`; s.attached[p] = true; }); return { out: "CREATE INDEX", danger: "CREATE INDEX on the partitioned parent built every partition's index while blocking writes to all of them: 9 minutes of failed inserts." }; }
          s.parentIdx = name; return "CREATE INDEX";
        }
        if (parts.includes(t)) { s.partIdx[t] = name; return conc ? "CREATE INDEX" : { out: "CREATE INDEX", danger: `That blocked writes to ${t} during the build; use CONCURRENTLY.` }; }
        return `ERROR:  relation "${t}" does not exist`;
      } },
      { re: /^alter index (\w+) attach partition (\w+);?$/i, use: "ALTER INDEX <parent_index> ATTACH PARTITION <partition_index>;", desc: "attach a partition's index to the parent index", run: (m, s) => {
        if (s.parentIdx !== m[1]) return `ERROR:  "${m[1]}" is not an index on events`;
        const p = parts.find((x) => s.partIdx[x] === m[2]);
        if (!p) return `ERROR:  index "${m[2]}" does not exist`;
        s.attached[p] = true; return "ALTER INDEX";
      } },
      { re: /^reindex (index|table) (concurrently )?(\w+);?$/i, use: "REINDEX INDEX CONCURRENTLY <index>;", desc: "", run: (m, s) => { if (I.lv === 1) return `ERROR:  could not create unique index "${m[3]}_ccnew"\nDETAIL:  Key (lower(email))=(${I.dup[0]}) is duplicated.`; return "REINDEX"; } },
    ], { sh: "psql" });
    return { prompt: "app=#", init: st, run: (line, s) => sh.run(line, s), par: I.lv === 3 ? 12 : 6,
      motd: I.lv === 1 ? "Last night's migration log:\n  CREATE UNIQUE INDEX CONCURRENTLY users_email_lower_key ON users (lower(email));\n  ERROR:  could not create unique index \"users_email_lower_key\"\nsince then: users write latency +18%" : I.lv === 2 ? "Migration job 'add orders_merchant_created_idx' running for 2h41m (usually 6 minutes)\n12,000 orders/minute keep flowing" : "Ticket: add an index on events(user_id) for the GDPR export. events is partitioned by month, 4 partitions, 30k inserts/s.",
      cmds: I.lv === 3 ? ["\\d events", "CREATE INDEX events_user_id_idx ON ONLY events (user_id);", "CREATE INDEX CONCURRENTLY <name> ON <partition> (user_id);", "ALTER INDEX events_user_id_idx ATTACH PARTITION <name>;"] : I.lv === 1 ? ["\\d users", "SELECT lower(email), count(*), array_agg(id), array_agg(deleted_at) FROM users GROUP BY 1 HAVING count(*) > 1;", "DROP INDEX CONCURRENTLY <index>;", "CREATE UNIQUE INDEX CONCURRENTLY <name> ON users (...) WHERE ...;"] : ["\\d orders", "SELECT pid, phase, lockers_total, current_locker_pid FROM pg_stat_progress_create_index;", "SELECT pid, application_name, state, xact_start, query FROM pg_stat_activity;", "SELECT pg_terminate_backend(<pid>);"] };
  }
  S.push({
    id: "pg-create-index-concurrently",
    name: "Rescue the concurrent index build",
    kind: "Incident",
    skills: ["safe", "diagnose"],
    gen(lv, R) { return { lv, pids: R.distinct(8, 1100, 98000), dup: R.sample(["ana@example.com", "li.wei@example.org", "sam@example.net", "j.doe@example.com", "kofi@example.org"], 2) }; },
    ...LB.term({
      shell: (I) => cicShell(I),
      goal(st, I, a, replay) {
        if (replay && replay.danger) return "The index exists, but getting there blocked production writes (see the warnings). Find the way that never blocks.";
        if (I.lv === 1) {
          const bad = Object.entries(st.idx).filter(([, x]) => !x.valid);
          if (bad.length) return `<code>${esc(bad[0][0])}</code> is still INVALID: it isn't used by queries but is still updated on every write.`;
          if (!Object.values(st.idx).some((x) => x.good)) return "Active users' emails still aren't guaranteed unique.";
          return true;
        }
        if (I.lv === 2) { const x = st.idx.orders_merchant_created_idx; if (!x) return "The index is gone; the migration still needs it."; if (!x.valid) return "The index is INVALID: drop it CONCURRENTLY and build it again (and remove what blocked it first)."; return true; }
        if (!st.parentIdx) return "There's no index on events(user_id) yet.";
        const miss = st.parts.filter((p) => !st.attached[p]);
        if (miss.length) return `The parent index is INVALID until every partition's index is attached (missing: ${esc(miss.join(", "))}).`;
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["\\d users", "SELECT lower(email), count(*), array_agg(id), array_agg(deleted_at) FROM users GROUP BY 1 HAVING count(*) > 1;", "DROP INDEX CONCURRENTLY users_email_lower_key;", "CREATE UNIQUE INDEX CONCURRENTLY users_active_email_key ON users (lower(email)) WHERE deleted_at IS NULL;"]
        : I.lv === 2 ? ["SELECT pid, phase, lockers_total, current_locker_pid FROM pg_stat_progress_create_index;", "SELECT pid, application_name, state, xact_start, query FROM pg_stat_activity;", `SELECT pg_terminate_backend(${I.pids[5]});`, "\\d orders"]
          : ["\\d events", "CREATE INDEX events_user_id_idx ON ONLY events (user_id);", ...["events_2026_06", "events_2026_07", "events_2026_08", "events_2026_09"].flatMap((p) => [`CREATE INDEX CONCURRENTLY ${p}_user_id_idx ON ${p} (user_id);`, `ALTER INDEX events_user_id_idx ATTACH PARTITION ${p}_user_id_idx;`])] }),
    }),
    bad: (I) => I.lv === 1 ? [{ log: ["DROP INDEX CONCURRENTLY users_email_lower_key;", "CREATE UNIQUE INDEX CONCURRENTLY users_email_lower_key ON users (lower(email));"] }, { log: ["REINDEX INDEX CONCURRENTLY users_email_lower_key;"] }] : I.lv === 2 ? [{ log: [`SELECT pg_cancel_backend(${I.pids[4]});`] }, { log: [`SELECT pg_cancel_backend(${I.pids[5]});`] }] : [{ log: ["CREATE INDEX events_user_id_idx ON events (user_id);"] }, { log: ["CREATE INDEX CONCURRENTLY events_user_id_idx ON events (user_id);"] }],
    text: (I) => `<p>${I.lv === 1 ? "Last night's migration tried to make emails unique (case-insensitively) on <code>users</code> (80M rows) and failed. Product clarifies: an email must be unique among <b>active</b> users; soft-deleted users (<code>deleted_at</code> set) may share it." : I.lv === 2 ? "A migration building an index on <code>orders</code> with <code>CREATE INDEX CONCURRENTLY</code> usually takes 6 minutes. It's been running for almost 3 hours." : "You need an index on <code>events(user_id)</code>. <code>events</code> is partitioned by month and takes 30k inserts/s: no write may block for more than a moment."}</p><p>Get the database to a state where the index exists and is valid, without blocking writes. Type <code>help</code> for what the sandbox understands.</p>`,
    hint: (I) => I.lv === 1 ? "A failed CREATE INDEX CONCURRENTLY leaves an INVALID index behind. Look at the duplicates before trying again." : I.lv === 2 ? "CONCURRENTLY waits for every transaction that could still see old row versions. Which phase is it in, and who is it waiting for?" : "CONCURRENTLY isn't supported on a partitioned parent. You can create the parent index on ONLY the parent and attach per-partition indexes.",
    concept: "CREATE INDEX CONCURRENTLY",
    how: "A plain CREATE INDEX blocks writes (SHARE lock) for the whole build. CREATE INDEX CONCURRENTLY builds in several passes under a weaker lock, waiting between phases for all transactions that might see older snapshots to finish, so one long or idle-in-transaction session can stall it for hours (pg_stat_progress_create_index shows 'waiting for old snapshots' and the locker pid). If it fails or is cancelled, it leaves an INVALID index that queries don't use but every write still maintains: drop it with DROP INDEX CONCURRENTLY before retrying. It can't run on a partitioned table: create the parent index ON ONLY the parent (invalid at first), build each partition's index concurrently, and ALTER INDEX ... ATTACH PARTITION each; the parent becomes valid when all are attached.",
    rule: "Build indexes on live tables with CONCURRENTLY, check for INVALID indexes after any failure (pg_index.indisvalid), make sure no long transactions are running first, and for partitioned tables use ON ONLY + per-partition CONCURRENTLY + ATTACH.",
    why: (I) => I.lv === 1 ? `Both duplicated emails had one soft-deleted copy, so the requirement fits a partial unique index (WHERE deleted_at IS NULL). The INVALID index from the failed build had to be dropped concurrently first: it was slowing every write and protecting nothing.` : I.lv === 2 ? `The build was waiting for old snapshots, and pg_stat_progress_create_index named pid ${I.pids[5]}: a Metabase session idle in transaction for 5 hours. Terminating it let the build finish; cancelling the build would have wasted the work and left an INVALID index.` : "CREATE INDEX ... ON ONLY events made an invalid parent index instantly; each partition's index was built CONCURRENTLY and attached, and the parent became valid once all four were attached. No step blocked writes for more than a moment.",
  });

  /* ======================= 10. pg_stat_statements triage (term) ======================= */
  function pssRows(I) {
    const Q = [
      { id: "lookup", q: "SELECT * FROM carts WHERE session_token = $1", calls: I.c1, mean: I.m1, rows: I.c1, read: I.lv === 3 ? 1.2e5 : 2.1e6, temp: 0 },
      { id: "report", q: "SELECT merchant_id, date_trunc($1, created_at), sum(total) FROM orders GROUP BY 1, 2", calls: 31, mean: 41200 + I.c1 % 9000, rows: 31 * 9000, read: 8.2e7, temp: 1.1e6 },
      { id: "nplus1", q: "SELECT * FROM line_items WHERE order_id = $1", calls: I.c2, mean: 0.09, rows: I.c2 * 3, read: 3.0e4, temp: 0 },
      { id: "scan", q: "SELECT id FROM products WHERE lower(sku) LIKE $1", calls: I.c3, mean: I.m3, rows: I.c3 * 2, read: I.lv === 3 ? 9.4e8 : 2.2e6, temp: 0 },
      { id: "upd", q: "UPDATE inventory SET qty = qty - $1 WHERE sku = $2", calls: I.c4, mean: 0.4, rows: I.c4, read: 1.1e5, temp: 0 },
      { id: "export", q: "SELECT * FROM events WHERE created_at >= $1 ORDER BY created_at", calls: 120, mean: 9800, rows: 120 * 2e5, read: 4.1e6, temp: 3.8e7 },
    ];
    Q.forEach((x) => (x.total = x.calls * x.mean));
    return Q;
  }
  const PSS_OPTS = { lookup: "Add an index for the carts lookup by session_token", report: "Rewrite the 40-second merchant report", nplus1: "Batch the per-order line_items lookups in the app (N+1)", scan: "Fix the sku LIKE search that reads from disk on every call", upd: "Shard the inventory UPDATE", export: "Raise work_mem for the events export" };
  const pssAns = (I) => (I.lv === 1 ? "lookup" : I.lv === 2 ? "nplus1" : "scan");
  function pssShell(I) {
    const Q = pssRows(I), order = Object.keys(PSS_OPTS);
    const sortCol = { total_exec_time: "total", mean_exec_time: "mean", calls: "calls", shared_blks_read: "read", temp_blks_written: "temp", rows: "rows" };
    const fmt = (x) => [x.q.length > 58 ? x.q.slice(0, 55) + "..." : x.q, String(x.calls), (x.total / 1000).toFixed(0) + " s", x.mean.toFixed(2), String(x.rows), String(Math.round(x.read)), String(Math.round(x.temp))];
    const sh = K.shell([
      { re: /^select .*from pg_stat_statements(?: .*order by (\w+)(?: desc)?)?.*;?$/i, use: "SELECT query, calls, total_exec_time, mean_exec_time, rows, shared_blks_read, temp_blks_written FROM pg_stat_statements ORDER BY <column> DESC LIMIT 10;", desc: "top statements", run: (m) => {
        const k = sortCol[(m[1] || "total_exec_time").toLowerCase()];
        if (!k) return `ERROR:  column "${m[1]}" does not exist`;
        return tbl(["query", "calls", "total_time", "mean_ms", "rows", "shared_blks_read", "temp_blks_written"], Q.slice().sort((a, b) => b[k] - a[k]).map(fmt));
      } },
      { re: /^select pg_stat_statements_reset\(\);?$/i, use: "SELECT pg_stat_statements_reset();", desc: "", run: () => ({ out: " pg_stat_statements_reset\n---\n 2026-10-12 10:02:11+00\n(1 row)", danger: "You wiped the evidence: 30 days of statistics are gone, and you'd have to wait hours to see the pattern again." }) },
      { re: /^select .*from pg_stat_database.*;?$/i, use: "SELECT datname, blks_hit, blks_read, temp_bytes FROM pg_stat_database;", desc: "cache hit ratio", run: () => tbl(["datname", "blks_hit", "blks_read", "hit_ratio"], [["shop", "88112009331", I.lv === 3 ? "9511020311" : "1201003317", I.lv === 3 ? "0.903" : "0.986"]]) },
      { re: /^select .*from pg_stat_activity.*;?$/i, use: "SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;", desc: "", run: () => tbl(["state", "count"], [["active", I.lv === 3 ? "61" : "38"], ["idle", "211"], ["idle in transaction", "3"]]) },
    ], { sh: "psql" });
    return { prompt: "shop=#", init: {}, run: (line, s) => sh.run(line, s), par: 5,
      motd: I.lv === 3 ? "Dashboard: DB CPU 41% · disk read IOPS 100% of provisioned (saturated) · read latency 18 ms\npg_stat_statements: 30 days of data" : `Dashboard: DB CPU ${I.lv === 2 ? 88 : 92}% for the last two weeks, growing with traffic\npg_stat_statements: 30 days of data`,
      cmds: ["SELECT query, calls, total_exec_time, mean_exec_time, rows, shared_blks_read, temp_blks_written FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;", "SELECT query, calls, total_exec_time, mean_exec_time, rows, shared_blks_read, temp_blks_written FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;", "SELECT query, calls, total_exec_time, mean_exec_time, rows, shared_blks_read, temp_blks_written FROM pg_stat_statements ORDER BY shared_blks_read DESC LIMIT 10;", "SELECT datname, blks_hit, blks_read, temp_bytes FROM pg_stat_database;"],
      opts: order.map((k) => PSS_OPTS[k]), optq: I.lv === 3 ? "What do you fix first to get disk reads under control?" : "What do you fix first to bring CPU down?" };
  }
  S.push({
    id: "pg-stat-statements-triage",
    name: "Triage with pg_stat_statements",
    kind: "Investigation",
    skills: ["diagnose", "estimate"],
    gen(lv, R) {
      const I = { lv, c1: R.int(30, 60) * 1e6, m1: lv === 1 ? R.int(18, 30) / 10 : 0.05, c2: lv === 2 ? R.int(300, 500) * 1e6 : R.int(10, 30) * 1e6, c3: R.int(2, 6) * 1e5, m3: lv === 3 ? R.int(80, 140) : R.int(4, 9), c4: R.int(5, 9) * 1e6 };
      return I;
    },
    ...LB.term({
      shell: (I) => pssShell(I),
      goal(st, I, a) {
        const key = Object.keys(PSS_OPTS)[a.pick];
        if (key === pssAns(I)) return true;
        const Q = pssRows(I), x = Q.find((q) => q.id === key), best = Q.find((q) => q.id === pssAns(I));
        return `${esc(PSS_OPTS[key])}: that statement accounts for ${(x.total / 1000 / 3600).toFixed(1)} h of execution time${I.lv === 3 ? ` and ${K.num(x.read)} blocks read from disk` : ""}, against ${(best.total / 1000 / 3600).toFixed(1)} h${I.lv === 3 ? ` and ${K.num(best.read)} blocks` : ""} for the top offender. ${I.lv === 3 ? "Sort by what's saturated." : "Sort by total time, not by mean."}`;
      },
      solve: (I) => ({ log: [I.lv === 3 ? "SELECT query, calls, total_exec_time, mean_exec_time, rows, shared_blks_read, temp_blks_written FROM pg_stat_statements ORDER BY shared_blks_read DESC LIMIT 10;" : "SELECT query, calls, total_exec_time, mean_exec_time, rows, shared_blks_read, temp_blks_written FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"], pick: Object.keys(PSS_OPTS).indexOf(pssAns(I)) }),
    }),
    bad: (I) => [{ log: [], pick: Object.keys(PSS_OPTS).indexOf("report") }, { log: [], pick: Object.keys(PSS_OPTS).indexOf(I.lv === 3 ? "lookup" : "export") }, ...(I.lv === 3 ? [{ log: [], pick: Object.keys(PSS_OPTS).indexOf("nplus1") }] : [])],
    text: (I) => `<p>${I.lv === 3 ? "Reads have become slow across the board: the storage volume's read IOPS are pinned at their provisioned limit while CPU sits at 41%." : "The primary's CPU has been above 85% for two weeks and the team wants to buy a bigger instance."} Before anyone resizes anything, find the query that's worth fixing first. <code>pg_stat_statements</code> has 30 days of data.</p><p>Look at the numbers, then pick what to fix first.</p>`,
    hint: (I) => I.lv === 1 ? "A query's load is calls × mean time. The slowest query isn't necessarily the most expensive one." : I.lv === 2 ? "A tiny mean time multiplied by hundreds of millions of calls is still a lot of CPU, and the fix may not be in the database." : "When disk is the bottleneck, rank by blocks read, not by time.",
    concept: "Finding the expensive queries",
    how: "pg_stat_statements aggregates every normalised statement: calls, total and mean execution time, rows, shared buffer hits and reads, temp blocks. The database's load is the sum of calls × time, so rank by total_exec_time to find what to fix for CPU: a 2 ms lookup called 40 million times costs far more than a 40-second nightly report. Hundreds of millions of sub-millisecond calls returning a few rows each usually means an N+1 query pattern in the application, fixed by batching. When I/O is the bottleneck, rank by shared_blks_read (blocks that missed shared_buffers), and look at temp_blks_written for spills. Don't reset the statistics before you've read them.",
    rule: "Rank pg_stat_statements by the resource that's saturated: total_exec_time for CPU, shared_blks_read for disk reads, temp_blks_written for spills. Fix the top few, then re-measure before buying hardware.",
    why: (I) => { const Q = pssRows(I), b = Q.find((q) => q.id === pssAns(I)); return I.lv === 1 ? `The carts lookup averages only ${I.m1} ms, but ${K.num(I.c1)} calls make it ${(b.total / 3.6e6).toFixed(0)} hours of execution: by far the largest share, and a classic missing-index scan. The 40-second report runs once a day.` : I.lv === 2 ? `line_items by order_id averages 0.09 ms, but ${K.num(I.c2)} calls (an ORM loading line items one order at a time) add up to ${(b.total / 3.6e6).toFixed(0)} hours. Batching it into one query per page removes most of that load.` : `The sku LIKE search read ${K.num(b.read)} blocks from disk: a scan on every call. Its total time isn't the largest, but it's what saturates the volume; the cache hit ratio dropped to 90%.`; },
  });

  /* ======================= 11. autovacuum on a 500M-row table (tune) ======================= */
  function avSim(I, c) {
    const N = I.rows * 1e6, T = c.thr + c.sf * N;
    const rate = Math.min(I.diskMax, (c.cost / 200) * I.base); // MB/s while vacuuming
    const heapFrac = Math.min(1, 3 * T / N);
    const workMB = (I.idxGB + I.heapGB * heapFrac) * 1024;
    const D = workMB / rate; // seconds per run
    const fill = T / I.upd; // seconds to accumulate the trigger
    const peak = T + I.upd * D;
    const cycle = Math.max(fill, D);
    const io = workMB / cycle;
    return { T, rate, D, fill, peak, io, cont: D >= fill };
  }
  const AV_SF = [0.2, 0.1, 0.05, 0.01, 0.002], AV_THR = [50, 100000, 1000000, 5000000], AV_COST = [200, 800, 2000, 10000];
  S.push({
    id: "pg-autovacuum-tuning",
    name: "Tune autovacuum for a 500M-row table",
    kind: "Config change",
    skills: ["tune", "estimate"],
    w: "tune",
    sense: "min",
    vname: "average vacuum I/O of",
    vfmt: (v) => K.num(v, 1) + " MB/s",
    gen(lv, R) {
      return { lv, rows: R.pick([400, 500, 600]), upd: R.int(2, 6) * 1000, heapGB: R.int(160, 260), idxGB: lv === 1 ? R.int(40, 70) : R.int(120, 220), base: R.pick([30, 40, 50]), diskMax: 600, target: lv === 3 ? 0.01 : 0.02, burst: lv === 1 ? 600 : lv === 2 ? 300 : 160 };
    },
    text: (I) => `<p><code>orders</code> has <b>${I.rows}M rows</b> (${I.heapGB} GB heap, ${I.idxGB} GB of indexes) and takes <b>${K.num(I.upd)} updates/s</b>. With the defaults (scale factor 0.2), autovacuum waits for ${K.num(I.rows * 0.2)}M dead rows, then grinds for days: the table is bloated and queries slow down. The cluster runs Postgres 16.</p>
      <p>Set per-table storage parameters (<code>ALTER TABLE orders SET (...)</code>) so dead rows never exceed <b>${K.pct(I.target, 0)}</b> of the table${I.lv > 1 ? ` and a vacuum never reads faster than <b>${I.burst} MB/s</b> (the disk's spare bandwidth)` : ""}, with the <b>least average vacuum I/O</b>. Each run scans all indexes once, plus the heap pages with dead rows; at cost limit 200 vacuum reads about ${I.base} MB/s.</p>`,
    ui: (I) => ({ knobs: [
      { k: "sf", label: "autovacuum_vacuum_scale_factor", opts: AV_SF },
      { k: "thr", label: "autovacuum_vacuum_threshold", opts: AV_THR, fmt: (v) => K.num(v) },
      { k: "cost", label: "autovacuum_vacuum_cost_limit", opts: AV_COST, help: "cost_delay stays at 2 ms", fixed: I.lv === 1 ? 2000 : undefined },
    ], init: { sf: 0.2, thr: 50, cost: 200 }, live: (c) => {
      const r = avSim(I, c);
      return K.metrics([
        { name: "Vacuum triggers at", value: K.num(r.T / 1e6, 1) + "M dead rows", ok: null },
        { name: "One run takes", value: r.D > 7200 ? K.num(r.D / 3600, 1) + " h" : K.num(r.D / 60, 0) + " min", ok: !r.cont, target: r.cont ? "never catches up" : "then idle " + K.num((r.fill - r.D) / 60, 0) + " min" },
        { name: "Peak dead rows", value: K.pct(r.peak / (I.rows * 1e6)), ok: r.peak <= I.target * I.rows * 1e6, target: "≤ " + K.pct(I.target, 0) },
        { name: "Vacuum read rate", value: K.num(r.rate) + " MB/s", ok: r.rate <= I.burst, target: "≤ " + I.burst },
        { name: "Average vacuum I/O", value: K.num(r.io, 1) + " MB/s", ok: null, target: "lower is better" },
      ]);
    } }),
    valid: (I, c) => { const r = avSim(I, c); if (r.rate > I.burst) return `vacuum would read at ${K.num(r.rate)} MB/s, more than the ${I.burst} MB/s the disk can spare: foreground queries slow down`; if (r.peak > I.target * I.rows * 1e6) return `dead rows peak at ${K.pct(r.peak / (I.rows * 1e6))} of the table (limit ${K.pct(I.target, 0)})${r.cont ? ": each run takes longer than it takes to accumulate the next batch" : ""}`; return true; },
    val: (I, c) => +avSim(I, c).io.toFixed(2),
    hint: (I) => I.lv === 1 ? "The trigger is threshold + scale_factor × rows. On a huge table, 20% is an enormous number of dead rows." : I.lv === 2 ? "Each run reads every index in full, so triggering too often costs a lot of I/O; and while a slow run is going, dead rows keep piling up." : "Balance: trigger early enough that trigger + (update rate × run time) stays under the cap, but late enough that full index scans don't run back-to-back.",
    concept: "Per-table autovacuum tuning",
    how: "Autovacuum vacuums a table when dead tuples exceed autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples. The default 0.2 is fine for small tables but means 100M dead rows on a 500M-row table, so big tables need a much smaller scale factor (or 0 plus an absolute threshold; Postgres 18 adds autovacuum_vacuum_max_threshold, default 100M, to cap it). Each run scans every index in full and the heap pages with dead tuples, throttled by the cost-based delay (cost_limit per cost_delay), so a run takes a while, and dead tuples keep accumulating meanwhile. Triggering very often repeats the full index scans; triggering rarely lets dead rows pile up. Raise the cost limit per table so big tables finish in reasonable time, within the disk's spare bandwidth.",
    rule: "On large, busy tables set a per-table scale factor around 0.01 or below (or an absolute threshold), raise autovacuum_vacuum_cost_limit so a run finishes well before the next one is due, and check n_dead_tup and run duration in pg_stat_user_tables / pg_stat_progress_vacuum.",
    why: (I, sol) => { const r = avSim(I, sol); return `With scale factor ${sol.sf}, threshold ${K.num(sol.thr)} and cost limit ${sol.cost}, vacuum starts at ${K.num(r.T / 1e6, 1)}M dead rows, runs ${K.num(r.D / 60, 0)} minutes at ${K.num(r.rate)} MB/s and peaks at ${K.pct(r.peak / (I.rows * 1e6))} dead rows, averaging ${K.num(r.io, 1)} MB/s of vacuum I/O. More frequent runs would re-read ${I.idxGB} GB of indexes each time.`; },
  });

  /* ======================= 12. timeouts (tune) ======================= */
  const TO = {
    app_stmt: { label: "app: statement_timeout", opts: ["0", "2s", "30s", "5min"] },
    app_idle: { label: "app: idle_in_transaction_session_timeout", opts: ["0", "10s", "5min", "1h"] },
    mig_lock: { label: "migrator: lock_timeout", opts: ["0", "2s", "1min"] },
    an_stmt: { label: "analytics: statement_timeout", opts: ["0", "30s", "15min", "2h"] },
    app_tx: { label: "app: transaction_timeout (PG17+)", opts: ["0", "30s", "5min"] },
  };
  const toSec = (v) => (v === "0" ? Infinity : K.dur(v.replace("min", "m")) / 1000);
  const toEvents = (I) => [
    { key: "app_stmt", what: `a runaway API query (missing WHERE) ran ${I.runaway} minutes and pinned 4 CPUs`, bad: (v) => toSec(v) > I.runaway * 60 / 4, why: "must be stopped within a few minutes" },
    { key: "app_stmt", what: `the CSV export endpoint legitimately runs up to ${I.export} s`, bad: (v) => toSec(v) < I.export, why: "legitimate work killed", legit: true },
    { key: "app_idle", what: "a code path forgot to commit; the session sat idle in transaction for 40 min holding row locks", bad: (v) => toSec(v) > 60, why: "locks held far too long: must end within a minute" },
    { key: "app_idle", what: "checkout pauses up to 2 s between statements while calling the fraud API", bad: (v) => toSec(v) < 3, why: "legitimate transactions killed", legit: true },
    ...(I.lv >= 2 ? [{ key: "mig_lock", what: "a migration's ALTER TABLE waited 3 min for a lock and every query on the table queued behind it", bad: (v) => toSec(v) > 10, why: "the lock queue must be short (the migrator retries)" }, { key: "mig_lock", what: "the migrator retries a failed lock attempt every 30 s, up to 20 times", bad: () => false, why: "", legit: true }] : []),
    ...(I.lv === 3 ? [
      { key: "an_stmt", what: `the month-end revenue report runs ${I.report} min`, bad: (v) => toSec(v) < I.report * 60, why: "legitimate report killed", legit: true },
      { key: "an_stmt", what: "an accidental cross join from a BI tool ran 9 hours", bad: (v) => toSec(v) > 3 * 3600, why: "must be stopped within a few hours" },
      { key: "app_tx", what: "the nightly invoice batch runs as one transaction of 2–3 minutes", bad: (v) => toSec(v) < 200, why: "legitimate batch killed", legit: true },
      { key: "app_tx", what: "a retry loop kept one transaction open 25 minutes, issuing a query every few seconds (never idle long)", bad: (v) => toSec(v) > 600, why: "must be stopped: idle_in_transaction can't catch it" },
    ] : []),
  ];
  const toKeys = (I) => ["app_stmt", "app_idle", ...(I.lv >= 2 ? ["mig_lock"] : []), ...(I.lv === 3 ? ["an_stmt", "app_tx"] : [])];
  const toCheck = (I, c) => toEvents(I).map((e) => ({ ...e, fail: e.bad(c[e.key]) }));
  S.push({
    id: "pg-timeouts",
    name: "Set the timeouts that stop the next outage",
    kind: "Hardening",
    skills: ["safe", "tune"],
    w: "tune",
    gen(lv, R) { return { lv, runaway: R.int(20, 50), export: R.pick([8, 12, 20]), report: R.pick([35, 50, 70]) }; },
    text: (I) => `<p>Last quarter's incidents and the legitimate workloads they must not break are listed in the live panel. Every timeout below is set per role (<code>ALTER ROLE app SET ...</code>), so each workload gets its own. <code>0</code> means disabled.</p><p>Pick values that would have stopped every incident without killing any legitimate work.</p>`,
    ui: (I) => ({ knobs: toKeys(I).map((k) => ({ k, label: TO[k].label, opts: TO[k].opts })), init: Object.fromEntries(toKeys(I).map((k) => [k, "0"])), live: (c) => K.table(["Event", "Setting", ""], toCheck(I, c).map((e) => [esc(e.what), `<span class="mono">${esc(TO[e.key].label.split(": ")[1])} = ${esc(c[e.key])}</span>`, e.fail ? `<span class="lose">✗ ${esc(e.why)}</span>` : `<span class="win">✓ ${e.legit ? "unaffected" : "stopped"}</span>`]), { compact: true }) }),
    accept: (I, c) => { const f = toCheck(I, c).find((e) => e.fail); return f ? `${esc(TO[f.key].label)} = ${esc(c[f.key])}: ${esc(f.what)}; ${esc(f.why)}.` : true; },
    solve: (I) => ({ app_stmt: "30s", app_idle: "10s", ...(I.lv >= 2 ? { mig_lock: "2s" } : {}), ...(I.lv === 3 ? { an_stmt: "2h", app_tx: "5min" } : {}) }),
    bad: (I) => [Object.fromEntries(toKeys(I).map((k) => [k, "0"])), { app_stmt: "2s", app_idle: "10s", mig_lock: "2s", an_stmt: "2h", app_tx: "5min" }, { app_stmt: "30s", app_idle: "5min", mig_lock: "2s", an_stmt: "2h", app_tx: "5min" }, ...(I.lv === 3 ? [{ app_stmt: "30s", app_idle: "10s", mig_lock: "2s", an_stmt: "15min", app_tx: "5min" }, { app_stmt: "30s", app_idle: "10s", mig_lock: "2s", an_stmt: "2h", app_tx: "0" }] : [])],
    hint: (I) => I.lv === 1 ? "Each timeout guards one failure mode: a statement running too long, or a transaction sitting idle while holding locks. Size each just above the legitimate worst case." : I.lv === 2 ? "lock_timeout limits how long a statement waits for a lock, which is what keeps a waiting ALTER from becoming a queue." : "A transaction that keeps issuing statements is never idle. Which timeout bounds the whole transaction?",
    concept: "statement, lock, idle and transaction timeouts",
    how: "statement_timeout cancels any single statement that runs longer than the limit. lock_timeout cancels a statement that waits longer than the limit for a lock, which is what makes DDL fail fast instead of building a queue of blocked queries behind it. idle_in_transaction_session_timeout terminates a session left idle inside an open transaction (holding locks and the xmin horizon). transaction_timeout (Postgres 17+) bounds the whole transaction, catching long transactions that are never idle. All can be set per role, per database or per session, so each workload gets limits just above its legitimate worst case.",
    rule: "Never run production roles with timeouts disabled: set statement_timeout and idle_in_transaction_session_timeout per role just above legitimate maxima, and run every migration with a short lock_timeout plus retries.",
    why: (I, sol) => `Chosen: ${Object.entries(sol).map(([k, v]) => `${esc(TO[k].label)} = ${esc(v)}`).join("; ")}. Each sits above the legitimate worst case (${I.export} s export, 2 s pauses${I.lv === 3 ? `, ${I.report}-minute report, 3-minute batch` : ""}) and below the incident it guards against.`,
  });

  /* ======================= 13. replica query conflicts (tune) ======================= */
  function hsSim(I, c) {
    const ded = c.topo === "dedicated";
    const appRep = { fb: ded ? "off" : c.fb, delay: ded ? 30 : c.delay };
    const anRep = ded ? { fb: c.fb, delay: c.delay } : appRep;
    // analytics queries on their replica: cancelled if a conflicting WAL record can't wait long enough
    const cancels = anRep.fb === "on" ? I.lockConf : anRep.delay === -1 || anRep.delay * 60 >= I.q * 60 ? 0 : Math.round(I.perDay * Math.min(1, (I.q - anRep.delay) / I.q));
    const maxLagApp = appRep.delay === -1 && !ded ? I.q * 60 : appRep.fb === "on" ? I.base : Math.min(appRep.delay === -1 ? I.q * 60 : appRep.delay * 60, I.q * 60);
    const lagApp = ded ? I.base : maxLagApp;
    const bloatGB = c.fb === "on" ? (I.upd * I.q * 60 * I.row) / 1e9 : 0;
    const cost = ded ? I.repCost : 0;
    return { cancels, lagApp, bloatGB, cost };
  }
  S.push({
    id: "pg-replica-conflicts",
    name: "Stop the replica cancelling reports",
    kind: "Design review",
    skills: ["design", "tune"],
    w: "tune",
    sense: "min",
    vname: "an extra cost of",
    vfmt: (v) => K.usd(v) + "/month",
    gen(lv, R) { return { lv, q: lv === 1 ? R.pick([8, 12, 20]) : R.pick([180, 240, 360]), perDay: R.int(8, 30), upd: R.int(2, 8) * 1000, row: 300, bloat: lv === 3 ? 20 : 60, base: 0.3, lagMax: lv === 1 ? 60 : 5, lockConf: 0, repCost: R.int(9, 16) * 100 }; },
    text: (I) => `<p>The analytics team runs reports of up to <b>${I.q} minutes</b> on the streaming replica that also serves the app's read traffic. About ${I.perDay} a day die with <code>ERROR: canceling statement due to conflict with recovery</code> (VACUUM on the primary removed rows the report still needed). The primary takes ${K.num(I.upd)} updates/s.</p>
      <p>Constraints: no cancelled reports; the app's replica must stay within <b>${I.lagMax} s</b> of the primary; extra dead rows kept on the primary must stay under <b>${I.bloat} GB</b>. Minimise extra cost (a dedicated analytics replica costs ${K.usd(I.repCost)}/month).</p>`,
    ui: (I) => ({ knobs: [
      { k: "topo", label: "Where reports run", opts: ["shared", "dedicated"], fmt: (v) => (v === "shared" ? "the app's replica" : "a dedicated analytics replica") },
      { k: "fb", label: "hot_standby_feedback (on the reports' replica)", opts: ["off", "on"] },
      { k: "delay", label: "max_standby_streaming_delay (reports' replica)", opts: [0.5, 5, 30, -1], fmt: (v) => (v === -1 ? "-1 (wait forever)" : v < 1 ? "30 s" : v + " min") },
    ], init: { topo: "shared", fb: "off", delay: 0.5 }, live: (c) => { const r = hsSim(I, c); return K.metrics([{ name: "Reports cancelled/day", value: String(r.cancels), ok: r.cancels === 0 }, { name: "App replica worst lag", value: r.lagApp < 60 ? K.num(r.lagApp, 1) + " s" : K.num(r.lagApp / 60) + " min", ok: r.lagApp <= I.lagMax, target: `≤ ${I.lagMax} s` }, { name: "Extra dead rows on primary", value: K.num(r.bloatGB, 1) + " GB", ok: r.bloatGB <= I.bloat, target: `≤ ${I.bloat} GB` }, { name: "Extra cost", value: K.usd(r.cost) + "/mo", ok: null }]); } }),
    valid: (I, c) => { const r = hsSim(I, c); if (r.cancels) return `${r.cancels} reports a day would still be cancelled`; if (r.lagApp > I.lagMax) return `the app's replica could fall ${r.lagApp < 60 ? K.num(r.lagApp, 0) + " s" : K.num(r.lagApp / 60) + " min"} behind while replay waits for a report`; if (r.bloatGB > I.bloat) return `hot_standby_feedback would make the primary keep ~${K.num(r.bloatGB, 0)} GB of dead rows for the duration of every long report`; return true; },
    val: (I, c) => hsSim(I, c).cost,
    hint: (I) => I.lv === 1 ? "Either the replica tells the primary which rows it still needs, or replay waits for the query. What does each cost?" : I.lv === 2 ? "Hours-long reports make both remedies expensive on a replica that must stay current." : "Separate the workloads, then pick the settings for each replica.",
    concept: "Hot standby query conflicts",
    how: "A standby replays the primary's WAL. If VACUUM on the primary removed row versions that a standby query still needs, replay must either wait or cancel the query; max_standby_streaming_delay is how long it waits (then cancels), and -1 means forever, which lets replication lag grow without bound. hot_standby_feedback = on reports the standby's oldest snapshot to the primary so VACUUM keeps those rows: no cancellations, but long standby queries cause bloat on the primary. For hours-long analytics the usual answer is a dedicated replica where lag doesn't matter (long delay or -1, feedback off), keeping the app's replica current.",
    rule: "Keep hot_standby_feedback for short standby queries; route long analytics to a separate replica with a large max_standby_streaming_delay and no feedback, and give it statement timeouts so lag can't grow forever.",
    why: (I, sol) => sol.topo === "shared" ? `${I.q}-minute reports with feedback on keep only ~${K.num(hsSim(I, sol).bloatGB, 1)} GB of extra dead rows on the primary, so the shared replica works at no extra cost.` : `Hours-long reports would either hold ~${K.num(hsSim(I, { ...sol, fb: "on" }).bloatGB, 0)} GB of dead rows on the primary (feedback) or stall the app replica's replay (delay). A dedicated analytics replica with max_standby_streaming_delay = ${sol.delay === -1 ? "-1" : sol.delay + " min"} isolates the lag for ${K.usd(I.repCost)}/month.`,
  });

  /* ======================= 14. checkpoints and WAL volume (tune) ======================= */
  function ckSim(I, c) {
    const maxWal = c.maxwal * 1024, tmo = K.dur(c.tmo) / 1000;
    const walOf = (T) => { const touched = I.hot * (1 - Math.exp(-I.pagesPerSec * T / I.hot)); return (I.base * T + touched * 8 / 1024 * I.fpiFactor) / T; }; // MB/s
    let T = tmo;
    for (let k = 0; k < 40; k++) { const r = walOf(T), byWal = maxWal / (1 + c.cct) / r; T = Math.min(tmo, byWal); }
    const rate = walOf(T), perHour = rate * 3600 / 1024;
    const recovery = (rate * T * (1 + c.cct)) / I.replay; // seconds of WAL replay worst case
    const dirty = Math.min(I.hot, I.pagesPerSec * T) * 8 / 1024; // MB to write per checkpoint
    const writeRate = dirty / (T * c.cct);
    return { T, rate, perHour, recovery, writeRate, warn: T < 30 };
  }
  S.push({
    id: "pg-checkpoint-tuning",
    name: "Tame checkpoints and WAL volume",
    kind: "Config change",
    skills: ["tune", "estimate"],
    w: "tune",
    sense: "min",
    vname: "WAL volume of",
    vfmt: (v) => K.num(v, 0) + " GB/h",
    gen(lv, R) { return { lv, hot: R.int(3, 6) * 1e6, pagesPerSec: R.int(3, 8) * 1000, base: R.int(4, 9), fpiFactor: 1.0, replay: R.pick([60, 80, 100]), rto: lv === 3 ? R.pick([3, 4]) * 60 : 15 * 60, disk: lv === 1 ? 500 : R.pick([60, 80, 100]) }; },
    text: (I) => `<p>The primary logs <code>LOG: checkpoints are occurring too frequently (9 seconds apart)</code>, ships about <b>${K.num((I.base + 40) * 3.6 / 1.024 * 2, 0)} GB of WAL per hour</b> to the archive and replicas, and write latency spikes every few minutes. Most of the WAL is <b>full-page images</b>: the first change to each page after a checkpoint logs the whole 8 kB page.</p>
      <p>Tune checkpoints for the <b>lowest WAL volume</b>, keeping worst-case crash recovery (WAL replay at ${I.replay} MB/s) under <b>${I.rto / 60} minutes</b>${I.lv > 1 ? ` and checkpoint writes under <b>${I.disk} MB/s</b> of spare disk bandwidth` : ""}.</p>`,
    ui: (I) => ({ knobs: [
      { k: "maxwal", label: "max_wal_size", opts: [1, 4, 16, 64], unit: "GB" },
      { k: "tmo", label: "checkpoint_timeout", opts: ["5m", "15m", "30m", "60m"], fmt: (v) => v.replace("m", " min") },
      { k: "cct", label: "checkpoint_completion_target", opts: [0.5, 0.9], help: "fraction of the interval to spread checkpoint writes over", fixed: I.lv === 1 ? 0.9 : undefined },
    ], init: { maxwal: 1, tmo: "5m", cct: 0.5 }, live: (c) => {
      const r = ckSim(I, { cct: 0.9, ...c });
      return K.metrics([
        { name: "Checkpoint every", value: r.T < 120 ? K.num(r.T, 0) + " s" : K.num(r.T / 60, 1) + " min", ok: !r.warn, target: r.T < (K.dur(c.tmo) / 1000) - 1 ? "triggered by max_wal_size" : "by checkpoint_timeout" },
        { name: "WAL generated", value: K.num(r.perHour, 0) + " GB/h", ok: null, target: "lower is better" },
        { name: "Worst-case recovery", value: K.num(r.recovery / 60, 1) + " min", ok: r.recovery <= I.rto, target: `≤ ${I.rto / 60} min` },
        { name: "Checkpoint write rate", value: K.num(r.writeRate, 0) + " MB/s", ok: r.writeRate <= I.disk, target: `≤ ${I.disk}` },
      ]);
    } }),
    valid: (I, c) => { const r = ckSim(I, { cct: 0.9, ...c }); if (r.recovery > I.rto) return `crash recovery could replay ${K.num(r.rate * r.T * (1 + (c.cct || 0.9)) / 1024, 1)} GB of WAL: ${K.num(r.recovery / 60, 1)} min, over the ${I.rto / 60}-minute objective`; if (r.writeRate > I.disk) return `checkpoints would write ${K.num(r.writeRate, 0)} MB/s, more than the disk can spare`; return true; },
    val: (I, c) => Math.round(ckSim(I, { cct: 0.9, ...c }).perHour),
    hint: (I) => I.lv === 1 ? "Fewer checkpoints means fewer full-page images. Which setting is forcing them every few seconds?" : I.lv === 2 ? "Spreading the checkpoint over more of the interval lowers its write rate." : "Longer intervals save WAL but lengthen crash recovery. Find the longest interval the recovery objective allows.",
    concept: "Checkpoints, full-page writes and WAL volume",
    how: "A checkpoint flushes all dirty buffers so recovery can start from it. After each checkpoint, the first modification of every page writes a full-page image into WAL (protection against torn pages), so frequent checkpoints multiply WAL volume, archive size and replication traffic. Checkpoints happen every checkpoint_timeout or when WAL since the last one approaches max_wal_size, whichever comes first; 'checkpoints are occurring too frequently' means max_wal_size is too small. checkpoint_completion_target spreads the writes over that fraction of the interval to avoid I/O spikes. Longer intervals mean more WAL to replay after a crash, so recovery time bounds how far you can go.",
    rule: "Size max_wal_size so checkpoints are triggered by checkpoint_timeout (15–30 min is common), keep checkpoint_completion_target at 0.9, and check the worst-case replay time against your recovery objective.",
    why: (I, sol) => { const r = ckSim(I, { cct: 0.9, ...sol }); return `max_wal_size ${sol.maxwal} GB with checkpoint_timeout ${sol.tmo.replace("m", " min")} gives a checkpoint every ${K.num(r.T / 60, 1)} min and ${K.num(r.perHour, 0)} GB/h of WAL, with at most ${K.num(r.recovery / 60, 1)} min of replay after a crash and ${K.num(r.writeRate, 0)} MB/s of checkpoint writes.`; },
  });

  /* ======================= 15. bulk loads (tune) ======================= */
  function blSim(I, c) {
    const rows = I.rows * 1e6;
    const per = { single: 0.35, multi: 0.025, copy: 0.008 }[c.method]; // ms per row, no indexes, logged
    const commit = c.method === "single" ? (c.sync === "on" ? I.fsync : 0.05) : 0;
    let t = rows * (per + commit) / 1000;
    const idxMaint = rows * 0.006 * I.nidx / 1000, idxRebuild = I.nidx * I.rows * 0.9;
    t += c.idx === "keep" ? idxMaint : idxRebuild;
    if (c.logged === "unlogged") t *= 0.7;
    const wal = c.logged === "unlogged" ? 0 : I.rows * 0.25;
    return { t, wal };
  }
  S.push({
    id: "pg-bulk-load",
    name: "Load 40 million rows before the morning",
    kind: "Design review",
    skills: ["tune", "design"],
    w: "tune",
    sense: "min",
    vname: "a load time of",
    vfmt: (v) => K.num(v / 60, 1) + " min",
    gen(lv, R) { return { lv, rows: R.int(30, 60), nidx: R.int(3, 6), fsync: R.pick([0.4, 0.8, 1.5]), window: R.pick([60, 90]) }; },
    text: (I) => `<p>A nightly job loads <b>${I.rows}M rows</b> from a partner file into Postgres. Today it does one INSERT per row with autocommit and takes most of the night. The target table has ${I.nidx} indexes.</p><p>${I.lv === 1 ? "It loads into <code>staging_import</code>, a scratch table nothing else reads; it's truncated and reloaded from the file if anything goes wrong." : I.lv === 2 ? "It loads directly into <code>shipments</code>, which the tracking API queries around the clock by id and by tracking number." : "It loads into <code>staging_import</code>; the analytics team reads it from the <b>read replica</b> as soon as it's loaded, and point-in-time recovery must cover it."}</p><p>Choose the fastest approach that's acceptable.</p>`,
    ui: (I) => ({ knobs: [
      { k: "method", label: "Load method", opts: ["single", "multi", "copy"], fmt: (v) => ({ single: "INSERT per row", multi: "multi-row INSERT, 1k rows/txn", copy: "COPY FROM STDIN" })[v] },
      { k: "idx", label: "Indexes during load", opts: ["keep", "rebuild"], fmt: (v) => (v === "keep" ? "keep them" : "drop, load, recreate") },
      { k: "logged", label: "Table", opts: ["logged", "unlogged"], fmt: (v) => (v === "logged" ? "normal (WAL-logged)" : "UNLOGGED") },
      { k: "sync", label: "synchronous_commit for the session", opts: ["on", "off"] },
    ], init: { method: "single", idx: "keep", logged: "logged", sync: "on" }, live: (c) => { const r = blSim(I, c); const v = blValid(I, c); return K.metrics([{ name: "Estimated load time", value: K.num(r.t / 60, 1) + " min", ok: r.t / 60 <= I.window, target: `window ${I.window} min` }, { name: "WAL written", value: K.num(r.wal, 1) + " GB", ok: null }]) + (v === true ? "" : K.verdict(false, v)); } }),
    valid: (I, c) => blValid(I, c),
    val: (I, c) => Math.round(blSim(I, c).t),
    hint: (I) => I.lv === 1 ? "Per-row round trips and per-row commits dominate. Which method streams rows in one statement?" : I.lv === 2 ? "Dropping indexes on a table that's serving queries isn't free." : "What happens to an UNLOGGED table on a replica, and after a crash?",
    concept: "Bulk loading",
    how: "Row-at-a-time INSERTs pay a network round trip, parsing and (with autocommit) a WAL flush per row. Multi-row INSERTs in larger transactions amortise that; COPY streams rows through one command with minimal per-row overhead and is usually several times faster still. Maintaining indexes row by row is slower than building them once afterwards, but only if nothing needs those indexes meanwhile. UNLOGGED tables skip WAL entirely, so they're fast, but they're truncated after a crash and are not replicated (and can't be restored by PITR); ALTER TABLE ... SET LOGGED later writes the whole table to WAL. synchronous_commit = off only matters when commits are frequent, and loses at most the last moments of commits on a crash.",
    rule: "Bulk-load with COPY (or batched multi-row INSERTs), build secondary indexes after loading into tables nothing else is using, and use UNLOGGED only for scratch data you can regenerate and don't need on replicas.",
    why: (I, sol) => { const r = blSim(I, sol); return `COPY with ${sol.idx === "keep" ? "indexes kept (the table is live)" : "indexes rebuilt afterwards"}${sol.logged === "unlogged" ? " into an UNLOGGED scratch table" : ""} loads ${I.rows}M rows in about ${K.num(r.t / 60, 1)} minutes.${I.lv === 3 ? " The replica and PITR need the data, so the table stays logged." : ""}`; },
  });
  const blValid = (I, c) => {
    if (I.lv === 2 && c.idx === "rebuild") return "the tracking API queries this table all night: without its indexes every lookup becomes a sequential scan for the whole load";
    if (I.lv === 2 && c.logged === "unlogged") return "shipments is a live table: making it UNLOGGED would truncate it after a crash and drop it from the replicas";
    if (I.lv === 3 && c.logged === "unlogged") return "UNLOGGED tables aren't replicated (the replica sees an empty table) and aren't covered by PITR";
    return true;
  };

  /* ======================= 16. read-your-writes with replicas (tune) ======================= */
  function rywSim(I, c) {
    // lag: normal p99 I.lag ms, nightly spikes up to I.spike s
    const writersShare = I.writeShare; // fraction of reads that come within 60 s of the same user's write
    let stale = 0, primary = 0, extra = 0;
    if (c.route === "replica") stale = writersShare * (I.lag / 1000 > 0.05 ? 0.3 : 0.1);
    if (c.route === "primary") primary = 1;
    if (c.route === "sticky") { primary = writersShare * Math.min(1, c.win / 60); stale = I.spike > c.win ? writersShare * 0.02 : 0; }
    if (c.route === "lsn") { const fb = (ms) => (ms >= I.lag ? 0.01 : 0.3) + (I.spikeFrac); const f = fb(c.wait); primary = writersShare * f; extra = Math.min(c.wait, I.lag); }
    return { stale, primary: primary * I.reads, extra, p99: I.base + extra };
  }
  S.push({
    id: "pg-read-your-writes",
    name: "Users can't see what they just saved",
    kind: "Design review",
    skills: ["design", "tune"],
    w: "tune",
    sense: "min",
    vname: "primary read load of",
    vfmt: (v) => K.num(v) + " reads/s",
    gen(lv, R) { return { lv, reads: R.int(20, 40) * 1000, writeShare: lv === 1 ? 0.05 : 0.1, lag: R.pick([40, 80, 150]), spike: lv === 1 ? 2 : R.int(20, 60), spikeFrac: lv === 1 ? 0 : 0.05, cap: lv === 3 ? 1500 : 4000, base: 18, budget: lv === 3 ? 120 : 400 }; },
    text: (I) => `<p>Profile reads (${K.num(I.reads)}/s) go to async streaming replicas whose replay lag is usually under ${I.lag} ms${I.lv > 1 ? `, but reaches <b>${I.spike} s</b> during the nightly batch` : ""}. Users who edit their profile and reload sometimes see the old version, and support tickets are piling up. About ${K.pct(I.writeShare, 0)} of reads come within a minute of the same user's own write.</p>
      <p>Choose a routing policy with <b>no stale reads of a user's own writes</b>, at most <b>${K.num(I.cap)}</b> reads/s on the primary${I.lv === 3 ? ` and p99 read latency under <b>${I.budget} ms</b>` : ""}, and as little primary read load as possible.</p>`,
    ui: (I) => ({ knobs: [
      { k: "route", label: "Read routing", opts: ["replica", "primary", "sticky", "lsn"], fmt: (v) => ({ replica: "always the replica", primary: "always the primary", sticky: "primary for N s after the user's write", lsn: "replica, after it has replayed the user's last commit LSN (else primary)" })[v], select: true },
      { k: "win", label: "Sticky window N", opts: [1, 5, 30, 90], unit: "s" },
      { k: "wait", label: "LSN wait before falling back", opts: [20, 200, 1000], unit: "ms" },
    ], init: { route: "replica", win: 5, wait: 200 }, live: (c) => { const r = rywSim(I, c); return K.metrics([{ name: "Stale own-write reads", value: K.pct(r.stale, 2), ok: r.stale === 0 }, { name: "Reads on primary", value: K.num(r.primary) + "/s", ok: r.primary <= I.cap, target: `≤ ${K.num(I.cap)}` }, { name: "p99 read latency", value: K.ms(r.p99), ok: r.p99 <= I.budget, target: `≤ ${I.budget} ms` }]); } }),
    valid: (I, c) => { const r = rywSim(I, c); if (r.stale > 0) return c.route === "sticky" ? `lag reaches ${I.spike} s, longer than the ${c.win}-second window, so some users still read stale data` : "users still read their own stale writes"; if (r.primary > I.cap) return `${K.num(r.primary)} reads/s land on the primary (limit ${K.num(I.cap)})`; if (r.p99 > I.budget) return `p99 read latency ${K.ms(r.p99)} exceeds ${I.budget} ms`; return true; },
    val: (I, c) => Math.round(rywSim(I, c).primary),
    hint: (I) => I.lv === 1 ? "Only reads right after the user's own write need to be fresh: send just those to the primary." : I.lv === 2 ? "A fixed window must cover the worst lag, which makes it expensive. Can the app know exactly when the replica has caught up?" : "The LSN wait adds latency to the reads that wait. Pick a wait long enough to cover normal lag but short enough for the latency budget.",
    concept: "Read-your-writes with async replicas",
    how: "Asynchronous streaming replicas apply WAL a little behind the primary; lag is usually milliseconds but spikes under heavy writes, long replays or recovery conflicts. Reading your own write from a replica can therefore return old data. Options: send all reads to the primary (no benefit from replicas), pin a user to the primary for a window after they write (simple, but the window must exceed worst-case lag), or track the commit LSN (pg_current_wal_lsn() after the write, stored in the session) and read from a replica only once pg_last_wal_replay_lsn() has passed it, falling back to the primary after a short wait. synchronous_commit = remote_apply makes commits wait for replicas to apply, at the cost of write latency.",
    rule: "Route only the reads that need freshness: track the user's last commit LSN and read from a replica that has replayed it (or the primary), and size any fixed sticky window from measured worst-case lag, not the average.",
    why: (I, sol) => { const r = rywSim(I, sol); return sol.route === "sticky" ? `A ${sol.win}-second sticky window covers the worst lag (${I.spike} s) and puts ${K.num(r.primary)} reads/s on the primary.` : `Waiting up to ${sol.wait} ms for the replica to replay the user's commit LSN gives fresh reads, with only ${K.num(r.primary)} reads/s falling back to the primary${I.lv === 3 ? ` and p99 ${K.ms(r.p99)}` : ""}.`; },
  });

  /* ======================= 17. synchronous_commit per workload (tune) ======================= */
  const SC = ["off", "local", "remote_write", "on", "remote_apply"];
  function scLat(I, mode, ssn) {
    const sync = ssn !== "";
    const f = I.fsync, r = I.rtt, a = I.apply;
    const effective = !sync && mode !== "off" ? "local" : mode;
    const quorum = ssn.startsWith("ANY") ? 0.85 : 1; // the faster of two standbys answers
    return { off: 0.1, local: f, remote_write: Math.max(f, r * quorum + 0.1), on: Math.max(f, r * quorum + f), remote_apply: Math.max(f, r * quorum + f + a) }[effective];
  }
  const SC_CLASSES = (I) => [
    { k: "pay", name: "payments", tps: 400, need: "survive losing the primary AND a standby power failure", ok: (m, ssn) => ssn !== "" && (m === "on" || m === "remote_apply") },
    { k: "chat", name: "chat messages", tps: 6000, need: "may lose the last fraction of a second on a crash", ok: () => true },
    ...(I.lv >= 2 ? [{ k: "prof", name: "profile edits", tps: 300, need: "the next request reads it from a standby and must see it", ok: (m, ssn) => ssn !== "" && m === "remote_apply" }, { k: "audit", name: "audit log", tps: 2000, need: "must survive a crash of the primary itself (no standby needed)", ok: (m) => m !== "off" }] : []),
  ];
  const scCheck = (I, c) => {
    const ssn = I.lv === 3 ? c.ssn : "FIRST 1 (s1)";
    for (const x of SC_CLASSES(I)) if (!x.ok(c[x.k], ssn)) return `${x.name}: ${x.need}; synchronous_commit = ${c[x.k]}${ssn === "" ? " with no synchronous standby configured" : ""} doesn't guarantee that`;
    if (I.lv === 3 && ssn.startsWith("FIRST")) return "with a single named synchronous standby, every synchronous commit hangs when s1 is down for patching: payments stop";
    return true;
  };
  S.push({
    id: "pg-synchronous-commit",
    name: "Choose durability per transaction",
    kind: "Design review",
    skills: ["design", "tune"],
    w: "tune",
    sense: "min",
    vname: "a total commit wait of",
    vfmt: (v) => K.num(v / 1000, 1) + " s per second",
    gen(lv, R) { return { lv, fsync: R.pick([0.5, 1, 2]), rtt: R.pick([0.6, 1.5, 3]), apply: R.pick([2, 5, 10]) }; },
    text: (I) => `<p>The primary has ${I.lv === 3 ? "two standbys, <code>s1</code> and <code>s2</code> (one of them is regularly down for patching)" : "a synchronous standby <code>s1</code> (<code>synchronous_standby_names = 'FIRST 1 (s1)'</code>)"}. Local WAL flush takes ${I.fsync} ms, a round trip to the standby ${I.rtt} ms, and the standby applies WAL about ${I.apply} ms after receiving it. <code>synchronous_commit</code> can be set per transaction (<code>SET LOCAL</code>).</p>
      <p>Choose a level per workload that meets each requirement (shown in the live panel), minimising the total time spent waiting for commits.</p>`,
    ui: (I) => ({ knobs: [...SC_CLASSES(I).map((x) => ({ k: x.k, label: `${x.name} (${K.num(x.tps)} commits/s)`, opts: SC, help: esc(x.need), select: true })), ...(I.lv === 3 ? [{ k: "ssn", label: "synchronous_standby_names", opts: ["", "FIRST 1 (s1)", "ANY 1 (s1, s2)"], fmt: (v) => (v === "" ? "'' (async only)" : `'${v}'`), select: true }] : [])], init: { ...Object.fromEntries(SC_CLASSES(I).map((x) => [x.k, "on"])), ssn: "" }, live: (c) => {
      const ssn = I.lv === 3 ? c.ssn : "FIRST 1 (s1)";
      return K.table(["Workload", "Level", "Commit wait", "Requirement"], SC_CLASSES(I).map((x) => [esc(x.name), `<span class="mono">${esc(c[x.k])}</span>`, K.ms(scLat(I, c[x.k], ssn)), x.ok(c[x.k], ssn) ? `<span class="win">✓</span> ${esc(x.need)}` : `<span class="lose">✗</span> ${esc(x.need)}`]), { compact: true }) + K.metrics([{ name: "Total commit wait", value: K.num(scVal(I, c) / 1000, 2) + " s/s", ok: null }]);
    } }),
    valid: (I, c) => scCheck(I, c),
    val: (I, c) => scVal(I, c),
    hint: (I) => I.lv === 1 ? "Not everything needs to wait for a standby, and some data can tolerate losing the last moments before a crash." : I.lv === 2 ? "Which level waits until the standby has applied the change so queries there can see it?" : "A single named synchronous standby is a single point of failure for commits. Quorum commit can wait for any one of several.",
    concept: "synchronous_commit levels",
    how: "synchronous_commit decides when COMMIT returns. off: before the WAL is flushed locally (a crash can lose the last few hundred milliseconds of commits, never corrupts). local: after the local flush. With synchronous standbys configured: remote_write waits until a standby has written the WAL to its OS (survives a primary failure, not a simultaneous standby OS crash), on waits until a standby has flushed it to disk, and remote_apply until a standby has applied it so its queries see the change. Without synchronous_standby_names, the remote levels behave like local. 'FIRST 1 (s1)' makes commits hang when s1 is unavailable; 'ANY 1 (s1, s2)' (quorum commit) waits for whichever answers first. The level can be set per transaction.",
    rule: "Set synchronous_commit per transaction by what the data needs: off for disposable high-volume writes, local or on for most, remote_apply only where a standby read must see it, and use quorum (ANY n) standbys so one standby's outage doesn't stop commits.",
    why: (I, sol) => `Payments use <code>${sol.pay}</code>, chat <code>${sol.chat}</code>${I.lv >= 2 ? `, profile edits <code>${sol.prof}</code>, audit <code>${sol.audit}</code>` : ""}${I.lv === 3 ? `, with synchronous_standby_names = '${esc(sol.ssn)}' so either standby can acknowledge` : ""}. Every requirement is met while chat traffic, the bulk of commits, doesn't wait for anything.`,
  });
  const scVal = (I, c) => { const ssn = I.lv === 3 ? c.ssn : "FIRST 1 (s1)"; return Math.round(SC_CLASSES(I).reduce((s, x) => s + x.tps * scLat(I, c[x.k], ssn), 0)); };

  /* @@MORE@@ */

  LB.addAll("pg", S);
})();
