/* Systems Lab · Postgres. Some levels run real SQL on PGlite (Postgres compiled to WebAssembly). */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;

  /* ---------- shared: a deterministic orders table for real-SQL levels ---------- */
  const ordersSetup = (n = 50000) => `CREATE TABLE orders (id bigint PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL, total numeric(10,2) NOT NULL);
INSERT INTO orders SELECT g, (g * 7919) % 1000, (ARRAY['paid','pending','refunded','paid'])[1 + g % 4], timestamptz '2026-01-01' + g * interval '97 seconds', ((g * 37) % 50000) / 100.0 FROM generate_series(1, ${n}) g;`;
  // Only CREATE INDEX statements are allowed in index-design levels.
  const onlyIndexes = (sql) => {
    const stmts = sql.split(";").map((s) => s.trim()).filter(Boolean);
    if (!stmts.length) return "Write at least one CREATE INDEX statement.";
    for (const s of stmts) if (!/^create\s+(unique\s+)?index\b/i.test(s)) return `Only CREATE INDEX statements are allowed here; found: <code>${esc(s.slice(0, 60))}</code>`;
    return LB.sql.guard(sql);
  };
  const analyzePlan = async (db, setup, ddl, query) => {
    await db.exec(setup);
    if (ddl) await db.exec(ddl);
    await db.exec("VACUUM ANALYZE");
    const r = await db.q("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + query);
    const v = r.rows[0]["QUERY PLAN"];
    const plan = (typeof v === "string" ? JSON.parse(v) : v)[0].Plan;
    const nodes = LB.sql.nodes(plan);
    return { plan, nodes, buffers: (plan["Shared Hit Blocks"] || 0) + (plan["Shared Read Blocks"] || 0), heapFetches: nodes.reduce((s, n) => s + (n["Heap Fetches"] || 0), 0), ios: nodes.some((n) => n["Node Type"] === "Index Only Scan") };
  };
  const planHTML = (r) => `<div class="mono small">${esc(LB.sql.planLine(r.plan))}</div>` + K.metrics([
    { name: "Buffers touched", value: K.num(r.buffers), ok: null },
    { name: "Rows returned", value: K.num(r.plan["Actual Rows"]), ok: null },
    { name: "Plan time", value: K.ms(r.plan["Actual Total Time"]), ok: null },
  ]);

  /* ---------- shared: a tiny MVCC simulator for two-transaction schedules ----------
     Each lane is a list of ops: {k:'begin'} {k:'read', rows:[...], as:'x'} {k:'write', row, val(vars, cur) -> new value, when?(vars)}
     {k:'commit'}. iso 'rc' (READ COMMITTED) or 'rr' (REPEATABLE READ). Row locks are held to commit; a blocked write waits
     until the holder finishes, exactly like Postgres. Under RR a write to a row changed by a transaction that committed
     after our snapshot fails with a serialization error and the transaction aborts. */
  function mvcc(I, seq) {
    const db = K.clone(I.rows), ver = Object.fromEntries(Object.keys(db).map((k) => [k, 0]));
    let clock = 0;
    const commitAt = {}; // row -> clock of last committed write
    const T = I.lanes.map(() => ({ snap: null, snapClock: 0, writes: {}, vars: {}, state: "idle", backlog: [], waitOn: null }));
    const lockOf = {}; // row -> txn index holding the write lock
    const log = [];
    const view = (t, row) => (row in T[t].writes ? T[t].writes[row] : I.iso === "rr" && T[t].snap ? T[t].snap[row] : db[row]);
    const exec = (t, i) => {
      const tx = T[t], op = I.lanes[t].ops[i], label = I.lanes[t].steps[i];
      if (tx.state === "aborted") { log.push({ t, label, note: "skipped: transaction already aborted" }); return; }
      if (op.k === "begin") { tx.state = "active"; log.push({ t, label, note: "" }); return; }
      if (I.iso === "rr" && !tx.snap && op.k !== "commit") { tx.snap = K.clone(db); tx.snapClock = clock; }
      if (op.k === "read") {
        const vals = op.rows.map((r) => view(t, r));
        tx.vars[op.as] = op.rows.length === 1 ? vals[0] : vals;
        log.push({ t, label, note: `sees ${op.rows.map((r, j) => `${I.names[r] || r} = ${vals[j]}`).join(", ")}` });
        return;
      }
      if (op.k === "write") {
        if (op.when && !op.when(tx.vars)) { log.push({ t, label, note: "condition false: no row updated" }); return; }
        const holder = lockOf[op.row];
        if (holder != null && holder !== t) { tx.waitOn = holder; tx.backlog.push(i); log.push({ t, label, note: `blocked: waits for T${holder + 1}'s lock on ${I.names[op.row] || op.row}` }); return; }
        if (I.iso === "rr" && (commitAt[op.row] || 0) > tx.snapClock) {
          tx.state = "aborted"; tx.writes = {};
          Object.keys(lockOf).forEach((r) => { if (lockOf[r] === t) delete lockOf[r]; });
          log.push({ t, label, note: "ERROR: could not serialize access due to concurrent update; transaction rolled back", err: true });
          wake(t);
          return;
        }
        lockOf[op.row] = t;
        const cur = I.iso === "rr" ? view(t, op.row) : op.row in tx.writes ? tx.writes[op.row] : db[op.row];
        tx.writes[op.row] = op.val(tx.vars, cur);
        log.push({ t, label, note: `${I.names[op.row] || op.row} := ${tx.writes[op.row]} (uncommitted)` });
        return;
      }
      if (op.k === "commit") {
        clock++;
        Object.entries(tx.writes).forEach(([r, v]) => { db[r] = v; ver[r]++; commitAt[r] = clock; });
        Object.keys(lockOf).forEach((r) => { if (lockOf[r] === t) delete lockOf[r]; });
        tx.state = "committed";
        log.push({ t, label, note: Object.keys(tx.writes).length ? "committed " + Object.entries(tx.writes).map(([r, v]) => `${I.names[r] || r} = ${v}`).join(", ") : "committed" });
        wake(t);
      }
    };
    const wake = (t) => {
      T.forEach((tx, u) => {
        if (tx.waitOn !== t) return;
        tx.waitOn = null;
        const bl = tx.backlog; tx.backlog = [];
        for (const i of bl) { if (tx.waitOn != null) { tx.backlog.push(i); continue; } log.push({ t: u, label: "", note: `T${u + 1} wakes up` }); exec(u, i); }
      });
    };
    const pos = I.lanes.map(() => 0);
    for (const l of seq) {
      const i = pos[l]++;
      if (T[l].waitOn != null) { T[l].backlog.push(i); continue; }
      exec(l, i);
    }
    const stuck = T.some((tx) => tx.waitOn != null);
    return { db, log, T, stuck, complete: seq.length === I.lanes.reduce((s, x) => s + x.steps.length, 0) };
  }
  const traceHTML = (I, r) => K.table(["", ...I.lanes.map((_, k) => "T" + (k + 1))], r.log.map((e, k) => [String(k + 1), ...I.lanes.map((_, j) => (j === e.t ? `<span class="mono">${esc(e.label)}</span>${e.note ? `<br><small class="${e.err ? "lose" : "muted"}">${esc(e.note)}</small>` : ""}` : ""))]), { compact: true });

  const ANOM = {
    lost: (R) => {
      const a = R.int(8, 30) * 10, x = R.int(2, 6) * 10, y = R.int(1, 5) * 10;
      return {
        kind: "lost", iso: "rc", rows: { acct: a }, names: { acct: "balance" },
        story: `Two withdrawals hit account 7 at the same moment. The app reads the balance, subtracts in Python, and writes the result back. Balance starts at <b>${a}</b>; one request withdraws <b>${x}</b>, the other <b>${y}</b>.`,
        goal: `Find a schedule that ends with the wrong balance (anything but ${a - x - y}).`,
        expect: a - x - y,
        lanes: [
          { name: "T1 (withdraw " + x + ")", steps: ["BEGIN", "SELECT balance FROM accounts WHERE id = 7", `UPDATE accounts SET balance = <read> - ${x} WHERE id = 7`, "COMMIT"], ops: [{ k: "begin" }, { k: "read", rows: ["acct"], as: "b" }, { k: "write", row: "acct", val: (v) => v.b - x }, { k: "commit" }] },
          { name: "T2 (withdraw " + y + ")", steps: ["BEGIN", "SELECT balance FROM accounts WHERE id = 7", `UPDATE accounts SET balance = <read> - ${y} WHERE id = 7`, "COMMIT"], ops: [{ k: "begin" }, { k: "read", rows: ["acct"], as: "b" }, { k: "write", row: "acct", val: (v) => v.b - y }, { k: "commit" }] },
        ],
        broken: (r) => r.db.acct !== a - x - y,
        verdict: (r) => `final balance ${r.db.acct}, expected ${a - x - y}`,
        why: `Both transactions read <b>${a}</b> before either wrote. READ COMMITTED doesn't stop that: the second UPDATE waits for the first transaction's row lock, then overwrites it with a value computed from a stale read. Fixes: <code>UPDATE ... SET balance = balance - ${x}</code> (the database does the arithmetic on the latest row), <code>SELECT ... FOR UPDATE</code>, or a version column checked in the WHERE clause.`,
      };
    },
    readskew: (R) => {
      const a = R.int(5, 15) * 100, b = R.int(5, 15) * 100, x = R.int(1, 4) * 100;
      return {
        kind: "readskew", iso: "rc", rows: { A: a, B: b }, names: { A: "checking", B: "savings" },
        story: `A nightly report sums a customer's two accounts with two separate SELECTs, while a transfer moves <b>${x}</b> from checking to savings. The true total is always <b>${a + b}</b>.`,
        goal: `Find a schedule where the report (T1) computes a total other than ${a + b}, even though every transaction commits.`,
        expect: a + b,
        lanes: [
          { name: "T1 (report)", steps: ["BEGIN", "SELECT balance FROM accounts WHERE id = 'checking'", "SELECT balance FROM accounts WHERE id = 'savings'", "COMMIT"], ops: [{ k: "begin" }, { k: "read", rows: ["A"], as: "a" }, { k: "read", rows: ["B"], as: "b" }, { k: "commit" }] },
          { name: "T2 (transfer " + x + ")", steps: ["BEGIN", `UPDATE accounts SET balance = balance - ${x} WHERE id = 'checking'`, `UPDATE accounts SET balance = balance + ${x} WHERE id = 'savings'`, "COMMIT"], ops: [{ k: "begin" }, { k: "write", row: "A", val: (v, cur) => cur - x }, { k: "write", row: "B", val: (v, cur) => cur + x }, { k: "commit" }] },
        ],
        broken: (r) => r.T[0].vars.a + r.T[0].vars.b !== a + b,
        verdict: (r) => `report saw ${r.T[0].vars.a} + ${r.T[0].vars.b} = ${r.T[0].vars.a + r.T[0].vars.b}, true total ${a + b}`,
        why: `Under READ COMMITTED every <i>statement</i> gets a fresh snapshot, so the report read checking before the transfer committed and savings after it, counting the ${x} twice. That's read skew (a non-repeatable read across rows). Run the report in REPEATABLE READ (one snapshot for the whole transaction) or as a single statement.`,
      };
    },
    writeskew: (R) => {
      const docs = R.sample(["alice", "bob", "carol", "dmitri", "erin", "farah"], 2);
      return {
        kind: "writeskew", iso: "rr", rows: { d0: 1, d1: 1 }, names: { d0: docs[0] + ".on_call", d1: docs[1] + ".on_call" },
        story: `The hospital rota must always have at least one doctor on call. <b>${docs[0]}</b> and <b>${docs[1]}</b> are both on call and both click "go off call" at once. The app checks <code>count(*) &gt;= 2</code> before updating, inside a <b>REPEATABLE READ</b> transaction.`,
        goal: `Find a schedule where both transactions commit and nobody is left on call.`,
        lanes: [
          { name: `T1 (${docs[0]})`, steps: ["BEGIN ISOLATION LEVEL REPEATABLE READ", "SELECT count(*) FROM rota WHERE on_call", `UPDATE rota SET on_call = false WHERE doctor = '${docs[0]}' -- only if count >= 2`, "COMMIT"], ops: [{ k: "begin" }, { k: "read", rows: ["d0", "d1"], as: "c" }, { k: "write", row: "d0", val: () => 0, when: (v) => v.c[0] + v.c[1] >= 2 }, { k: "commit" }] },
          { name: `T2 (${docs[1]})`, steps: ["BEGIN ISOLATION LEVEL REPEATABLE READ", "SELECT count(*) FROM rota WHERE on_call", `UPDATE rota SET on_call = false WHERE doctor = '${docs[1]}' -- only if count >= 2`, "COMMIT"], ops: [{ k: "begin" }, { k: "read", rows: ["d0", "d1"], as: "c" }, { k: "write", row: "d1", val: () => 0, when: (v) => v.c[0] + v.c[1] >= 2 }, { k: "commit" }] },
        ],
        broken: (r) => r.db.d0 + r.db.d1 === 0,
        verdict: (r) => `${r.db.d0 + r.db.d1} doctor(s) left on call`,
        why: `Each transaction read a snapshot with two doctors on call and updated a <i>different</i> row, so there was no write-write conflict for REPEATABLE READ to catch. That's write skew. SERIALIZABLE (SSI) detects the read/write dependency cycle and aborts one transaction; alternatively lock the rows you read with <code>SELECT ... FOR UPDATE</code>.`,
      };
    },
  };
  const anomalyOf = (I) => ANOM[I.kind](C_RNG(I.seed));
  const C_RNG = (seed) => D.campaign.rng(seed);


  /* ---------- psql lock-queue sandbox ---------- */
  const hms = (min, sec) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  function pgLockShell(I) {
    const T = I.table;
    const sessions = [
      { pid: I.alter, user: "deploy", app: "migrate", state: "active", age: "00:03:12", query: `ALTER TABLE ${T} ADD COLUMN ${I.col} text`, kind: "ddl", waiting: true, mode: "AccessExclusiveLock" },
      ...I.apps.map((pid, k) => ({ pid, user: "app", app: "checkout-api", state: "active", age: `00:0${k % 3}:${String(10 + k * 6).slice(0, 2)}`, query: k % 2 ? `SELECT * FROM ${T} WHERE id = $1` : `UPDATE ${T} SET status = $1 WHERE id = $2`, kind: "app", waiting: true, mode: k % 2 ? "AccessShareLock" : "RowExclusiveLock" })),
      { pid: I.other[0], user: "replicator", app: "walreceiver", state: "active", age: "41 days", query: "START_REPLICATION SLOT replica_1", kind: "repl" },
      { pid: I.other[1], user: "app", app: "checkout-api", state: "idle", age: "", query: "COMMIT", kind: "idle" },
    ];
    if (I.lv === 1) sessions.push({ pid: I.blocker, user: "maria", app: "psql", state: "idle in transaction", age: hms(I.age, 7), query: `SELECT * FROM ${T} WHERE id = 4211`, kind: "blocker", mode: "AccessShareLock" });
    if (I.lv === 2) sessions.push({ pid: I.blocker, user: "analytics", app: "Metabase", state: "active", age: hms(I.age, 41), query: `SELECT date_trunc('day', created_at), sum(total) FROM ${T} JOIN customers USING (customer_id) GROUP BY 1`, kind: "blocker", mode: "AccessShareLock" });
    if (I.lv === 3) sessions.push({ pid: I.blocker, user: "postgres", app: "", state: "active", age: hms(I.age, 19), query: `autovacuum: VACUUM public.${T} (to prevent wraparound)`, kind: "vacuum", mode: "ShareUpdateExclusiveLock" });
    sessions.push({ pid: I.other[2], user: "app", app: "reports-worker", state: "idle", age: "", query: "SELECT 1", kind: "idle" });
    const fix = (st) => {
      const ddl = st.sessions.find((s) => s.kind === "ddl");
      const holder = st.sessions.find((s) => (s.kind === "blocker" || s.kind === "vacuum") && s.mode);
      if (ddl && !holder) { st.sessions = st.sessions.filter((s) => s !== ddl); st.migrated = true; }
      const stillDdl = st.sessions.some((s) => s.kind === "ddl");
      st.sessions.forEach((s) => { if (s.kind === "app") s.waiting = stillDdl; });
      if (!stillDdl) st.sessions.forEach((s) => { if (s.kind === "app") { s.state = "idle"; s.query = "COMMIT"; } });
    };
    const find = (st, pid) => st.sessions.find((s) => s.pid === +pid);
    const header = ["pid", "usename", "application_name", "state", "wait_event_type", "xact_age", "query"];
    const table = (rows) => { const t = K.cols([header, header.map((h) => "-".repeat(h.length)), ...rows]); return t + `\n(${rows.length} rows)`; };
    const act = (st) => table(st.sessions.map((s) => [s.pid, s.user, s.app || "", s.state, s.waiting ? "Lock" : "", s.age, s.query.length > 70 ? s.query.slice(0, 67) + "..." : s.query]));
    const sh = K.shell([
      { re: /^select .*from pg_stat_activity(?! .*pg_terminate)(?! .*pg_cancel)(?! .*pg_blocking).*$/i, use: "SELECT ... FROM pg_stat_activity;", desc: "sessions, their state and current query", run: (m, st) => act(st) },
      { re: /^select .*pg_blocking_pids\(pid\).*$/i, use: "SELECT pid, pg_blocking_pids(pid) FROM pg_stat_activity ...;", desc: "who is waiting on whom", run: (m, st) => { const ddl = st.sessions.find((s) => s.kind === "ddl"); const holder = st.sessions.find((s) => (s.kind === "blocker" || s.kind === "vacuum") && s.mode); const rows = st.sessions.filter((s) => s.waiting).map((s) => [s.pid, s.kind === "ddl" ? `{${holder ? holder.pid : ""}}` : `{${ddl ? ddl.pid : ""}}`, s.query.slice(0, 50)]); return K.cols([["pid", "pg_blocking_pids", "query"], ["---", "----------------", "-----"], ...rows]) + `\n(${rows.length} rows)`; } },
      { re: /^select .*from pg_locks.*$/i, use: "SELECT ... FROM pg_locks WHERE relation = '<table>'::regclass;", desc: "locks held and requested", run: (m, st) => { const rows = st.sessions.filter((s) => s.mode).map((s) => [T, s.mode, s.waiting ? "f" : "t", s.pid]); return K.cols([["relation", "mode", "granted", "pid"], ["--------", "----", "-------", "---"], ...rows]) + `\n(${rows.length} rows)`; } },
      { re: /^select pg_terminate_backend\(pid\) from pg_stat_activity.*$/i, use: "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ...;", desc: "terminate many sessions at once", run: (m, st) => { const n = st.sessions.length; st.sessions = []; fix(st); return { out: K.cols([["pg_terminate_backend"], ["--------------------"], ...Array(n).fill(["t"])]) + `\n(${n} rows)`, danger: `Terminated all ${n} sessions, including live customer requests and replication.` }; } },
      { re: /^select pg_(cancel|terminate)_backend\((\d+)\);?$/i, use: "SELECT pg_cancel_backend(<pid>); / pg_terminate_backend(<pid>);", desc: "cancel a running query / end a session", run: (m, st) => {
        const how = m[1].toLowerCase(), s = find(st, m[2]);
        if (!s) return `pg_${how}_backend\n----\nf\n(1 row)\nWARNING:  PID ${m[2]} is not a PostgreSQL backend process`;
        let danger = null;
        if (how === "cancel") {
          if (s.state !== "active") return "pg_cancel_backend\n-----------------\nt\n(1 row)";
          if (s.kind === "app") { s.waiting = false; s.state = "idle"; s.query = "ROLLBACK"; danger = "You cancelled a customer's checkout request."; }
          else if (s.kind === "repl") { danger = "You interrupted replication."; }
          else { st.sessions = st.sessions.filter((x) => x !== s); if (s.kind === "blocker") st.sessions.push({ ...s, state: "idle", query: s.query, mode: null, kind: "idle" }); }
        } else {
          st.sessions = st.sessions.filter((x) => x !== s);
          if (s.kind === "app") danger = "You killed a customer's checkout request.";
          if (s.kind === "repl") danger = "You killed the replication connection; the replica is now falling behind.";
          if (s.kind === "idle") danger = "That session wasn't involved; its pool will reconnect, but it was collateral damage.";
        }
        fix(st);
        return { out: `pg_${how}_backend\n${"-".repeat(18 + how.length)}\nt\n(1 row)`, danger };
      } },
      { re: /^show lock_timeout;?$/i, use: "SHOW lock_timeout;", desc: "", run: () => " lock_timeout\n--------------\n 0\n(1 row)" },
      { re: /^\\d\+? ?(\w+)?$/i, use: "\\d <table>", desc: "describe a table", run: (m) => `Table "public.${m[1] || T}"\n Column     | Type\n------------+---------\n id         | bigint\n status     | text\n created_at | timestamptz\n total      | numeric` },
    ], { sh: "psql" });
    return {
      prompt: "prod=#", init: { sessions, migrated: false }, run: (line, st) => sh.run(line, st), par: 5,
      motd: `ALERT checkout-api p99 > 30s · error rate 41%\nDeploy "add ${T}.${I.col}" running migration since 3 min\npsql (16.4) · connected to prod primary as admin`,
      cmds: ["SELECT pid, state, query FROM pg_stat_activity;", "SELECT pid, pg_blocking_pids(pid) FROM pg_stat_activity WHERE wait_event_type = 'Lock';", `SELECT relation::regclass, mode, granted, pid FROM pg_locks WHERE relation = '${T}'::regclass;`, "SELECT pg_cancel_backend(<pid>);", "SELECT pg_terminate_backend(<pid>);"],
    };
  }

  /* ---------- connection pool model ---------- */
  function poolSim(I, cfg) {
    const mode = I.lv === 1 ? "none" : cfg.bouncer;
    const clientConns = I.inst * cfg.pool;
    const conns = mode === "none" ? clientConns : Math.min(cfg.server, mode === "session" ? clientConns : cfg.server);
    if (mode === "none" && clientConns > I.maxc) return { err: `${I.inst} instances × pool ${cfg.pool} = ${clientConns} connections, but max_connections is ${I.maxc}: new instances fail with "too many clients"`, conns, clientConns };
    if (mode !== "none" && cfg.server > I.maxc) return { err: `PgBouncer would open ${cfg.server} server connections, over max_connections ${I.maxc}`, conns, clientConns };
    if (mode === "session" && cfg.server < clientConns) return { err: `Session pooling pins one server connection to each client connection for as long as the client stays connected. App pools keep their ${clientConns} connections open, so ${clientConns - cfg.server} of them would wait forever for one of the ${cfg.server} server connections`, conns, clientConns };
    // time a request pins a connection: query time, plus the held external call unless the pool releases between transactions
    const holdPin = I.q + I.hold, holdTx = I.q;
    const lam = I.rps / 1000; // per ms
    // the database's per-query time grows once more queries run at once than it has cores for
    const slots = mode === "transaction" ? cfg.server : mode === "session" ? Math.min(cfg.server, clientConns) : clientConns;
    const holdServer = mode === "transaction" ? holdTx : holdPin;
    let q = I.q, busy = 0;
    for (let it = 0; it < 30; it++) { const h = holdServer - I.q + q; busy = lam * h; const runningDb = Math.min(slots, lam * q); q = I.q * (1 + 0.04 * Math.max(0, runningDb - 2 * I.cores)); }
    const h = holdServer - I.q + q;
    const perServer = 1 / h;
    // client pool (per instance) must also keep up: in session/none modes the client pool pins as long as the server
    const clientHold = mode === "transaction" ? I.q + I.hold - I.q + q : h;
    const qc = K.mmc(lam / I.inst, 1 / clientHold, cfg.pool);
    const qs = K.mmc(lam, perServer, slots);
    const t99 = (x, mu, c, lamb) => (x.rho >= 1 ? Infinity : x.pw <= 0.01 ? 0 : Math.log(x.pw / 0.01) / (c * mu - lamb));
    const wait = t99(qc, 1 / clientHold, cfg.pool, lam / I.inst) + (mode !== "none" ? t99(qs, perServer, slots, lam) : 0);
    const p99 = (qc.rho >= 1 || qs.rho >= 1) ? Infinity : wait + (I.hold + q) * 1.6 + 2;
    return { conns, clientConns, busy, p99, slots, q, rho: Math.max(qc.rho, qs.rho) };
  }
  function poolHTML(I, cfg) {
    const r = poolSim(I, cfg);
    if (r.err) return K.verdict(false, r.err);
    return K.metrics([
      { name: "Server connections", value: `${r.conns}`, ok: r.conns <= I.maxc, target: `max ${I.maxc}` },
      { name: "Busy on average", value: r.busy.toFixed(1), ok: null, target: "rate × hold time" },
      { name: "DB query time", value: K.ms(r.q), ok: r.q <= I.q * 1.2, target: `${I.q} ms uncontended` },
      { name: "Pool utilisation", value: r.rho >= 1 ? "≥100%" : K.pct(r.rho, 0), ok: r.rho < 0.85, target: "keep < 85%" },
      { name: "p99 latency", value: Number.isFinite(r.p99) ? K.ms(r.p99) : "∞ (queue grows)", ok: r.p99 <= I.target, target: `< ${I.target} ms` },
    ]);
  }

  LB.addAll("pg", [
    {
      id: "pg-index-for-query",
      name: "Index the slow endpoint",
      kind: "Incident",
      skills: ["tune", "diagnose"],
      w: "code",
      gen(lv, R) {
        const cust = R.int(1, 998), limit = R.pick([10, 20, 25, 50]);
        const day = R.int(5, 25);
        const q = lv === 1 ? `SELECT * FROM orders WHERE customer_id = ${cust}`
          : lv === 2 ? `SELECT id, total FROM orders WHERE customer_id = ${cust} AND created_at >= timestamptz '2026-02-${String(day).padStart(2, "0")}' ORDER BY created_at DESC LIMIT ${limit}`
            : `SELECT created_at, total FROM orders WHERE customer_id = ${cust} AND status = 'paid' ORDER BY created_at DESC LIMIT ${limit}`;
        return { lv, cust, limit, q, budget: lv === 1 ? 80 : lv === 2 ? 25 : 4 };
      },
      text: (I) => `<p>The <code>orders</code> table has 50,000 rows and only a primary key. This query, behind a hot endpoint, now does a sequential scan:</p>${K.pre(I.q)}
        <p>Write the <b>CREATE INDEX</b> statement(s) that make it fast. It runs on a real Postgres: your index is built, the table is analyzed, and the query is run with <code>EXPLAIN (ANALYZE, BUFFERS)</code>. Pass by touching at most <b>${I.budget}</b> buffers${I.lv === 3 ? " and answering from the index alone (an Index Only Scan with no heap fetches)" : ""}.</p>`,
      ui: (I) => ({ lang: "sql", rows: 4, ph: "CREATE INDEX ...", liveDelay: 900, live: async (sql) => {
        if (!sql || !sql.trim()) return `<p class="muted small">Type an index definition to see the real plan.</p>`;
        const bad = onlyIndexes(sql); if (bad) return `<p class="lose small">${bad}</p>`;
        try { const r = await LB.sql.session((db) => analyzePlan(db, ordersSetup(), sql, I.q)); return planHTML(r); }
        catch (e) { return `<p class="lose small">Postgres: ${esc(e.message)}</p>`; }
      } }),
      solve: (I) => I.lv === 1 ? "CREATE INDEX ON orders (customer_id);" : I.lv === 2 ? "CREATE INDEX ON orders (customer_id, created_at);" : "CREATE INDEX ON orders (customer_id, status, created_at) INCLUDE (total);",
      bad: (I) => I.lv === 1 ? ["CREATE INDEX ON orders (created_at);"] : I.lv === 2 ? ["CREATE INDEX ON orders (created_at, customer_id);", "CREATE INDEX ON orders (customer_id);"] : ["CREATE INDEX ON orders (customer_id, created_at);", "CREATE INDEX ON orders (customer_id, status, created_at);"],
      async accept(I, sql) {
        const bad = onlyIndexes(sql); if (bad) return bad;
        let r;
        try { r = await LB.sql.session((db) => analyzePlan(db, ordersSetup(), sql, I.q)); }
        catch (e) { return "Postgres rejected it: " + esc(e.message); }
        if (r.buffers > I.budget) return `The plan is <code>${esc(LB.sql.planLine(r.plan))}</code> and touched <b>${r.buffers}</b> buffers (budget ${I.budget}).${I.lv === 2 ? " Think about which column is compared with = and which with a range." : ""}`;
        if (I.lv === 3 && !(r.ios && r.heapFetches === 0)) return `Fast enough (${r.buffers} buffers) but it still visits the table: <code>${esc(LB.sql.planLine(r.plan))}</code>. Every column the query needs must be in the index.`;
        return true;
      },
      hint: (I) => I.lv === 1 ? "Which column does the WHERE clause filter on?" : I.lv === 2 ? "Equality columns first, then the range/sort column: the index then hands rows over already in order." : "An index-only scan needs every selected and filtered column in the index. INCLUDE adds payload columns without making them part of the key.",
      concept: "Composite index column order",
      how: "A B-tree index is sorted by its first column, then the second within ties, and so on. Postgres can seek directly to the rows that match equality conditions on a leading prefix of the key, then walk a contiguous range in key order, which also satisfies ORDER BY for free. A range or sort column placed first scatters the matching rows across the whole index. If every column the query reads is in the index (key or INCLUDE), it can answer from the index alone (Index Only Scan) as long as the visibility map is current.",
      rule: "Put equality columns first, then the range or ORDER BY column, then INCLUDE whatever else the query selects. Verify with EXPLAIN (ANALYZE, BUFFERS), not by guessing.",
      why: (I, sol) => `The reference index <code>${esc(sol)}</code> lets Postgres seek straight to customer ${I.cust}${I.lv > 1 ? " and read rows already in created_at order, so no sort is needed" : ""}${I.lv === 3 ? "; INCLUDE (total) means the heap is never touched" : ""}.`,
    },
    {
      id: "pg-isolation-anomalies",
      name: "Break the transaction",
      kind: "Investigation",
      skills: ["diagnose", "design"],
      w: "interleave",
      gen(lv, R) { return { kind: ["lost", "readskew", "writeskew"][lv - 1], seed: `pg-iso/${lv}/${R.int(1, 1e9)}` }; },
      text: (I) => { const A = anomalyOf(I); return `<p>${A.story}</p><p><b>${A.goal}</b> Pick which transaction runs its next statement; the simulator applies Postgres's ${A.iso === "rc" ? "READ COMMITTED" : "REPEATABLE READ"} rules, including row locks that make a writer wait.</p>`; },
      ui: (I) => { const A = anomalyOf(I); return { lanes: A.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = mvcc({ ...A }, seq || []); return traceHTML(A, r) + (r.complete ? K.verdict(A.broken(r), A.verdict(r)) : ""); } }; },
      accept(I, seq) { const A = anomalyOf(I); const r = mvcc({ ...A }, seq); if (r.stuck) return "A transaction is still waiting for a lock."; return A.broken(r) ? true : `Everything is consistent: ${A.verdict(r)}. Try overlapping the transactions differently.`; },
      solve(I, spec) { const A = anomalyOf(I); for (const s of LB.byId.get("pg-isolation-anomalies").space(I, spec)) { const r = mvcc({ ...A }, s); if (!r.stuck && A.broken(r)) return s; } return null; },
      bad: (I) => { const A = anomalyOf(I); return [[...A.lanes[0].steps.map(() => 0), ...A.lanes[1].steps.map(() => 1)], [...A.lanes[1].steps.map(() => 1), ...A.lanes[0].steps.map(() => 0)]]; },
      hint: (I) => ({ lost: "Let both transactions read before either one writes.", readskew: "Put the whole transfer between the report's two reads.", writeskew: "Both transactions must take their snapshot (the count) before either commits." })[I.kind],
      concept: "Isolation anomalies: lost update, read skew, write skew",
      how: "Postgres uses MVCC: readers see a snapshot, writers take row locks held until commit. READ COMMITTED takes a new snapshot per statement, so a read-modify-write done in the application can overwrite a concurrent change (lost update) and two reads in one transaction can see different moments (read skew). REPEATABLE READ keeps one snapshot per transaction and aborts on write-write conflicts, but two transactions that read overlapping data and write different rows can still both commit (write skew). SERIALIZABLE tracks those read/write dependencies and aborts one of them.",
      rule: "Do arithmetic in the UPDATE (SET x = x - n), lock what you read with FOR UPDATE, or use SERIALIZABLE and retry on serialization failures. Never compute new values from a stale SELECT.",
      why: (I) => anomalyOf(I).why,
    },
    {
      id: "pg-lock-queue",
      name: "The migration that froze checkout",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      ...LB.term({
        shell: (I) => pgLockShell(I),
        goal(st, I) {
          if (st.sessions.some((s) => s.kind === "app" && s.waiting)) return "Requests on <code>" + I.table + "</code> are still queued behind a lock.";
          if (I.lv === 3 && !st.sessions.some((s) => s.kind === "vacuum")) return "Traffic is flowing, but you stopped an anti-wraparound VACUUM. It restarts immediately and blocks the next DDL again, and every time it's killed the table gets closer to transaction ID wraparound.";
          return true;
        },
        solve: (I) => ({ log: ["SELECT pid, state, query FROM pg_stat_activity;", "SELECT pid, pg_blocking_pids(pid) FROM pg_stat_activity WHERE wait_event_type = 'Lock';", I.lv === 3 ? `SELECT pg_cancel_backend(${I.alter});` : `SELECT pg_terminate_backend(${I.blocker});`] }),
      }),
      gen(lv, R) {
        const table = R.pick(["orders", "payments", "carts", "invoices"]);
        const pids = R.distinct(14, 1200, 98000);
        return { lv, table, alter: pids[0], blocker: pids[1], apps: pids.slice(2, 10), other: pids.slice(10, 13), age: R.int(25, 95), col: R.pick(["note", "gift_message", "promo_code", "source"]) };
      },
      bad: (I) => [
        { log: [`SELECT pg_terminate_backend(${I.apps[0]});`] },
        { log: [I.lv === 1 ? `SELECT pg_cancel_backend(${I.blocker});` : `SELECT pg_terminate_backend(${I.other[0]});`] },
        ...(I.lv === 3 ? [{ log: [`SELECT pg_terminate_backend(${I.blocker});`] }] : []),
      ],
      text: (I) => `<p><b>PAGE:</b> checkout p99 is over 30 s and 40% of requests time out. Three minutes ago a deploy started the migration <code>ALTER TABLE ${I.table} ADD COLUMN ${I.col} text</code>.</p><p>You have a <code>psql</code> session on the primary. Find out what's holding things up and restore traffic with the least collateral damage. Type <code>help</code> for what this sandbox understands.</p>`,
      hint: (I) => I.lv === 1 ? "pg_cancel_backend cancels the running query. What if the session isn't running anything?" : I.lv === 2 ? "ALTER TABLE needs an ACCESS EXCLUSIVE lock, and every later query on the table queues behind it. Who holds the lock the ALTER is waiting for?" : "Not every lock holder is safe to kill. Read the query text of the blocker carefully.",
      concept: "Lock queues behind DDL",
      how: "Most ALTER TABLE forms need an ACCESS EXCLUSIVE lock. If any transaction holds even a weak lock on the table (a plain SELECT inside an open transaction counts), the ALTER waits, and every new query on that table queues behind the waiting ALTER, because Postgres grants locks in order. A metadata-only ALTER that should take milliseconds can take the whole table down this way. pg_blocking_pids() shows the chain; pg_cancel_backend() cancels a running statement; pg_terminate_backend() ends the session, including an idle open transaction. An anti-wraparound autovacuum doesn't yield to other lock requests and must not be killed.",
      rule: "Run DDL with SET lock_timeout = '3s' and retry, so a migration fails fast instead of queuing the world behind it. During the incident: kill the true blocker if it's safe, otherwise cancel the migration.",
      why: (I) => I.lv === 1 ? `Session ${I.blocker} had been <i>idle in transaction</i> for ${I.age} minutes: someone ran a SELECT in psql and never committed. Cancelling does nothing to an idle session; terminating it releases its lock, the ALTER finishes instantly and the queue drains.`
        : I.lv === 2 ? `The ALTER (pid ${I.alter}) was waiting behind a ${I.age}-minute analytics query (pid ${I.blocker}), and every checkout query queued behind the ALTER. Stopping the report or cancelling the migration both clear the queue.`
          : `The ALTER was waiting behind autovacuum running <i>to prevent wraparound</i>, which never yields its lock. Killing it only postpones necessary work and it restarts at once. Cancel the migration instead and retry it later with lock_timeout.`,
    },
    {
      id: "pg-pool-sizing",
      name: "Size the connection pools",
      kind: "Capacity plan",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "server connections:",
      gen(lv, R) {
        const cores = lv === 1 ? 8 : 16;
        const I = { lv, cores, maxc: lv === 1 ? 100 : lv === 2 ? 200 : 400, inst: lv === 1 ? 4 : lv === 2 ? 120 : 60, rps: lv === 1 ? R.int(8, 14) * 100 : lv === 2 ? R.int(25, 35) * 100 : R.int(40, 55) * 100, q: R.pick([4, 5, 6]), hold: lv === 3 ? R.pick([35, 45, 60]) : 0, target: lv === 1 ? 50 : 60 };
        if (lv === 3) I.target = Math.round(((I.hold + I.q) * 1.6 + 30) / 10) * 10;
        return I;
      },
      text: (I) => `<p>${I.inst} app instances serve <b>${K.num(I.rps)} requests/s</b>. Each request runs queries totalling about <b>${I.q} ms</b> of database time${I.hold ? `, but the code holds its connection for the whole request, including a <b>${I.hold} ms</b> call to a payment provider in the middle of the transaction` : ""}. Postgres has ${I.cores} cores and <code>max_connections = ${I.maxc}</code>.</p>
        <p>Choose the pool settings that keep <b>p99 under ${I.target} ms</b> with no connection errors, using as <b>few server connections</b> as possible (each costs ~10 MB of RAM and adds contention).</p>`,
      ui: (I) => {
        const knobs = [{ k: "pool", label: "Pool size per app instance", opts: I.lv === 1 ? [2, 4, 6, 8, 12, 16, 24] : [2, 5, 10, 20, 40], help: "client-side pool (e.g. HikariCP maximumPoolSize)" }];
        if (I.lv > 1) knobs.push({ k: "bouncer", label: "PgBouncer", opts: ["none", "session", "transaction"], help: "in front of Postgres" }, { k: "server", label: "PgBouncer server pool", opts: [10, 20, 40, 80, 160, 320], help: "connections PgBouncer opens to Postgres (ignored without PgBouncer)" });
        return { knobs, init: I.lv > 1 ? { bouncer: "none" } : {}, live: (cfg) => poolHTML(I, cfg) };
      },
      valid: (I, cfg) => { const r = poolSim(I, cfg); return r.err ? r.err : r.p99 <= I.target ? true : `p99 is ${Math.round(r.p99)} ms (target ${I.target} ms)`; },
      val: (I, cfg) => poolSim(I, cfg).conns,
      hint: (I) => I.lv === 1 ? "Little's law: connections busy at once = arrival rate × time each request holds one. Then leave headroom for bursts." : I.lv === 2 ? "Count the server connections all instances open together, and compare with max_connections." : "With session pooling, a connection is pinned for the whole request, payment call included. Which pooling mode returns it to the pool between transactions? Hint: with that mode, move the payment call out of the transaction in real life.",
      concept: "Connection pool sizing and PgBouncer",
      how: "Little's law says busy connections ≈ arrival rate × hold time. A pool smaller than that queues requests; a pool far bigger just adds idle backends (each a Postgres process using memory) and, once more queries run than the CPU has cores for, context switching and lock contention slow everything down. Many app instances multiply small per-instance pools past max_connections. PgBouncer in transaction mode multiplexes many client connections onto a few server connections, giving the connection back after each transaction. Session mode pins one server connection per client and saves nothing.",
      rule: "Size the database side for busy work (a few × CPU cores), not for the number of clients. Put PgBouncer in transaction mode in front when instance count × pool size approaches max_connections, and never hold a transaction open across a network call.",
      why: (I, sol) => { const r = poolSim(I, sol); return `The cheapest passing setup uses <b>${r.conns}</b> server connections${sol.bouncer && sol.bouncer !== "none" ? ` (PgBouncer ${sol.bouncer} mode with a server pool of ${sol.server})` : ` (pool size ${sol.pool} × ${I.inst} instances)`}, with about ${r.busy.toFixed(0)} connections busy on average and p99 ≈ ${Math.round(r.p99)} ms.`; },
    },
  ]);
})();
