/* Systems Lab · Postgres, part 2: real-SQL levels (PGlite runs a real Postgres in WebAssembly). */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;

  /* ---------- helpers (private to this file) ---------- */
  const stmtsOf = (sql) => String(sql || "").split(";").map((s) => s.trim()).filter(Boolean);
  // Only statements matching one of `res` are allowed; returns an error string or null.
  const allowOnly = (sql, res, what) => {
    const ss = stmtsOf(sql);
    if (!ss.length) return "Write at least one statement.";
    for (const s of ss) if (!res.some((r) => r.test(s))) return `Only ${what} here; found: <code>${esc(s.slice(0, 70))}</code>`;
    return LB.sql.guard(sql);
  };
  // A single SELECT/WITH query, trailing semicolon removed.
  const oneQuery = (sql) => {
    const ss = stmtsOf(sql);
    if (ss.length !== 1) return { err: "Write exactly one query (one statement)." };
    if (!/^(select|with|\()/i.test(ss[0])) return { err: "The answer must be a SELECT (or WITH ...) query." };
    const g = LB.sql.guard(ss[0]); if (g) return { err: g };
    return { q: ss[0] };
  };
  const runAll = async (db, sql) => { const out = []; for (const s of stmtsOf(sql)) out.push(await db.raw.query(s)); return out; };
  const explain = async (db, q) => {
    const r = await db.q("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + q);
    const v = r.rows[0]["QUERY PLAN"];
    return (typeof v === "string" ? JSON.parse(v) : v)[0].Plan;
  };
  const bufsOf = (plan) => (plan["Shared Hit Blocks"] || 0) + (plan["Shared Read Blocks"] || 0);
  const scanOf = (plan, rel) => LB.sql.nodes(plan).find((n) => n["Relation Name"] === rel && /Scan/.test(n["Node Type"]));
  // Compare two result sets as multisets, inside Postgres (types are coerced the same way for both).
  const diffRows = async (db, mine, ref) => {
    const r = await db.q(`SELECT (SELECT count(*) FROM ((${mine}) EXCEPT ALL (${ref})) a)::int AS extra, (SELECT count(*) FROM ((${ref}) EXCEPT ALL (${mine})) b)::int AS missing`);
    return r.rows[0];
  };
  const pgErr = (e) => `Postgres: ${esc(String(e && e.message || e))}`;
  const planBox = (plan, extra) => `<div class="mono small">${esc(LB.sql.planLine(plan))}</div>` + K.metrics([
    { name: "Buffers touched", value: K.num(bufsOf(plan)), ok: extra && extra.budget != null ? bufsOf(plan) <= extra.budget : null, target: extra && extra.budget != null ? `budget ${extra.budget}` : "" },
    { name: "Rows", value: K.num(plan["Actual Rows"]), ok: null },
    { name: "Time", value: K.ms(plan["Actual Total Time"]), ok: null },
    ...(extra && extra.more ? extra.more : []),
  ]);
  const estTable = (plan) => K.table(["Node", "Estimated rows", "Actual rows", "Off by"], LB.sql.nodes(plan).map((n) => {
    const est = n["Plan Rows"], act = n["Actual Rows"] * (n["Actual Loops"] || 1) / Math.max(1, n["Actual Loops"] || 1);
    const f = Math.max(est, 1) / Math.max(act, 1), off = f >= 1 ? f : 1 / f;
    return [`${"&nbsp;".repeat(n.depth * 3)}${esc(n["Node Type"])}${n["Relation Name"] ? " on " + esc(n["Relation Name"]) : ""}`, K.num(est), K.num(act), `<span class="${off >= 3 ? "lose" : ""}">${off >= 1.05 ? "×" + K.num(off, off < 10 ? 1 : 0) : "ok"}</span>`];
  }), { compact: true });
  const idxSize = async (db, table) => +(await db.q(`SELECT coalesce(sum(pg_relation_size(i.indexrelid)), 0)::bigint AS s FROM pg_index i WHERE i.indrelid = '${table}'::regclass AND NOT i.indisprimary`)).rows[0].s;
  const S = [];

  /* ======================= 1. fix the misestimate ======================= */
  const MIS = {
    1: (I) => ({
      table: "events",
      setup: `CREATE TABLE events (id bigint PRIMARY KEY, kind text NOT NULL, account_id int NOT NULL, created_at timestamptz NOT NULL);
INSERT INTO events SELECT g, (ARRAY['view','click','signup'])[1 + g % 3], g % 400, timestamptz '2026-03-01' + g * interval '1 minute' FROM generate_series(1, 3000) g;
ANALYZE events;
INSERT INTO events SELECT g, '${I.kind}', g % 400, timestamptz '2026-04-01' + g * interval '1 second' FROM generate_series(3001, ${3000 + I.n}) g;`,
      q: `SELECT account_id, count(*) FROM events WHERE kind = '${I.kind}' GROUP BY account_id`,
    }),
    2: (I) => ({
      table: "addresses",
      setup: `CREATE TABLE addresses (id bigint PRIMARY KEY, customer_id int NOT NULL, zip text NOT NULL, city text NOT NULL);
INSERT INTO addresses SELECT g, g % 7000, 'Z' || lpad((g % 400)::text, 4, '0'), 'city_' || ((g % 400) / 20) FROM generate_series(1, ${I.n}) g;
ANALYZE addresses;`,
      q: `SELECT count(*) FROM addresses WHERE city = 'city_${Math.floor(I.zip / 20)}' AND zip = 'Z${String(I.zip).padStart(4, "0")}'`,
    }),
    3: (I) => ({
      table: "accounts",
      setup: `CREATE TABLE accounts (id bigint PRIMARY KEY, payload jsonb NOT NULL);
INSERT INTO accounts SELECT g, jsonb_build_object('tier', CASE WHEN g % 10 < ${I.share} THEN '${I.tier}' ELSE 'free' END, 'region', 'r' || (g % 9)) FROM generate_series(1, ${I.n}) g;
ANALYZE accounts;`,
      q: `SELECT id FROM accounts WHERE payload->>'tier' = '${I.tier}'`,
    }),
  };
  const misRun = async (I, sql) => LB.sql.session(async (db) => {
    const M = MIS[I.lv](I);
    await db.exec(M.setup);
    if (sql) await runAll(db, sql);
    const plan = await explain(db, M.q);
    const n = scanOf(plan, M.table);
    const est = n["Plan Rows"], act = n["Actual Rows"];
    return { plan, est, act, off: Math.max(est, act, 1) / Math.max(1, Math.min(est, act)) };
  });
  const MIS_OK = [/^analyze\b/i, /^vacuum\b/i, /^create\s+statistics\b/i, /^create\s+(unique\s+)?index\b/i, /^alter\s+table\s+\S+\s+alter\s+(column\s+)?\S+\s+set\s+statistics\b/i];
  S.push({
    id: "pg-fix-misestimate",
    name: "Fix the row estimate",
    kind: "Investigation",
    skills: ["diagnose", "tune"],
    w: "code",
    gen(lv, R) {
      if (lv === 1) return { lv, kind: R.pick(["import", "backfill", "replay"]), n: R.int(12, 20) * 1000 };
      if (lv === 2) return { lv, n: R.int(16, 24) * 1000, zip: R.int(20, 399) };
      return { lv, n: R.int(12, 18) * 1000, tier: R.pick(["gold", "pro", "team"]), share: R.int(3, 5) };
    },
    text: (I) => {
      const M = MIS[I.lv](I);
      return `<p>${I.lv === 1 ? `A bulk import just loaded ${K.num(I.n)} rows into <code>events</code>, and since then the dashboards' plans look odd.` : I.lv === 2 ? `A delivery report joins on this filter and picked a nested loop that crawls. The planner's estimate for the scan is far from reality.` : `Queries on the account tier (stored in a <code>jsonb</code> column) get terrible plans: hash joins sized for a handful of rows spill, parallelism is never used.`} The live panel shows the real <code>EXPLAIN ANALYZE</code> of:</p>${K.pre(M.q)}
        <p>Write the statement(s) that make the planner's <b>estimated rows</b> for the scan of <code>${M.table}</code> land within <b>3×</b> of the actual rows. Allowed: <code>ANALYZE</code>, <code>CREATE STATISTICS</code>, <code>CREATE INDEX</code>, <code>ALTER TABLE ... SET STATISTICS</code>. Don't change the query.</p>`;
    },
    ui: (I) => ({ lang: "sql", rows: 4, ph: "ANALYZE ... / CREATE STATISTICS ...", liveDelay: 900, live: async (sql) => {
      const bad = sql && sql.trim() ? allowOnly(sql, MIS_OK, "statistics and index statements") : null;
      if (bad) return `<p class="lose small">${bad}</p>`;
      try { const r = await misRun(I, sql && sql.trim() ? sql : ""); return (sql && sql.trim() ? "" : `<p class="muted small">Current plan, before your change:</p>`) + estTable(r.plan) + K.verdict(r.off <= 3, `scan estimate ${K.num(r.est)} rows vs ${K.num(r.act)} actual`); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => I.lv === 1 ? "ANALYZE events;" : I.lv === 2 ? "CREATE STATISTICS addr_zip_city (dependencies) ON zip, city FROM addresses;\nANALYZE addresses;" : "CREATE STATISTICS acct_tier ON ((payload->>'tier')) FROM accounts;\nANALYZE accounts;",
    bad: (I) => I.lv === 1 ? ["CREATE INDEX ON events (kind);"] : I.lv === 2 ? ["ANALYZE addresses;", "ALTER TABLE addresses ALTER COLUMN zip SET STATISTICS 1000;"] : ["ANALYZE accounts;", "CREATE INDEX ON accounts ((payload->>'tier'));"],
    async accept(I, sql) {
      const bad = allowOnly(sql, MIS_OK, "statistics and index statements"); if (bad) return bad;
      let r; try { r = await misRun(I, sql); } catch (e) { return pgErr(e); }
      if (r.off > 3) return `The planner still estimates <b>${K.num(r.est)}</b> rows for the scan but gets <b>${K.num(r.act)}</b> (×${K.num(r.off, 1)} off).${I.lv === 2 ? " Per-column statistics are fine already; the problem is how the two conditions are combined." : I.lv === 3 ? " Postgres has no statistics for an expression unless you ask for them, so it falls back to a hard-coded 0.5% guess." : " Statistics were gathered before the import. Indexes don't refresh them."}`;
      return true;
    },
    hint: (I) => I.lv === 1 ? "When were the table's statistics last collected, relative to the import?" : I.lv === 2 ? "The planner multiplies the selectivities of city and zip as if they were independent. Are they?" : "Statistics are kept per column. What about an expression like payload->>'tier'?",
    concept: "Planner statistics and row estimates",
    how: "The planner chooses join methods, join order and memory sizing from estimated row counts, which come from pg_statistic: per-column most-common values, histograms and n_distinct, gathered by ANALYZE (or autoanalyze after enough changes). Stale statistics after a bulk load make new values look rare. For several conditions it assumes independence and multiplies selectivities, which badly underestimates correlated columns (zip implies city); CREATE STATISTICS ... (dependencies, mcv) fixes that. Expressions such as jsonb->>'key' have no statistics at all and get a fixed default selectivity (0.5% for equality) unless you add expression statistics (PG14+) or an expression index, then ANALYZE.",
    rule: "In EXPLAIN ANALYZE, find the lowest node where estimated and actual rows diverge by 10× or more: fix the estimate there (ANALYZE, extended statistics, expression statistics) before touching indexes or planner settings.",
    why: (I) => I.lv === 1 ? `Statistics were collected when <code>events</code> held only view/click/signup rows, so '${esc(I.kind)}' looked almost nonexistent. ANALYZE after a bulk load fixes it (autoanalyze would get there eventually, but not before the next dashboards run).`
      : I.lv === 2 ? `Each zip belongs to exactly one city, so P(city ∧ zip) = P(zip), but the planner multiplied 1/20 × 1/400 and underestimated ${K.num(I.n)} rows by 20×. A dependencies statistic tells it zip determines city.`
        : `With no statistics for <code>payload->>'tier'</code>, the planner assumed 0.5% of rows; really ${I.share * 10}% are '${esc(I.tier)}'. Expression statistics (or an expression index, then ANALYZE) give it a real MCV list.`,
  });

  /* ======================= 2. pick the index type ======================= */
  const IDX = {
    1: (I) => ({ table: "users", setup: `CREATE TABLE users (id bigint PRIMARY KEY, email text NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL);
INSERT INTO users SELECT g, (ARRAY['User','user','USER','Usr'])[1 + g % 4] || g || '@' || (ARRAY['Example.com','example.COM','mail.example.org'])[1 + g % 3], 'name ' || g, timestamptz '2025-01-01' + g * interval '7 minutes' FROM generate_series(1, 20000) g;`,
      q: `SELECT id, name FROM users WHERE lower(email) = lower('${I.email}')`, budget: 6 }),
    2: (I) => ({ table: "products", setup: `CREATE TABLE products (id bigint PRIMARY KEY, title text NOT NULL, attrs jsonb NOT NULL);
INSERT INTO products SELECT g, 'product ' || g, jsonb_build_object('color', (ARRAY['red','blue','green','black','white','grey','navy'])[1 + g % 7], 'size', (ARRAY['S','M','L','XL','XXL'])[1 + g % 5], 'brand', 'b' || (g % 300), 'stock', g % 50) FROM generate_series(1, 20000) g;`,
      q: `SELECT id, title FROM products WHERE attrs @> '{"brand": "b${I.brand}", "color": "${I.color}"}'`, budget: 40 }),
    3: (I) => ({ table: "jobs", setup: `CREATE TABLE jobs (id bigint PRIMARY KEY, status text NOT NULL, queue text NOT NULL, created_at timestamptz NOT NULL, payload text);
INSERT INTO jobs SELECT g, CASE WHEN g % 1000 < ${I.pend} THEN 'pending' WHEN g % 50 = 0 THEN 'failed' ELSE 'done' END, 'q' || (g % 4), timestamptz '2026-01-01' + g * interval '20 seconds', 'payload-' || g FROM generate_series(1, 30000) g;`,
      q: `SELECT id, created_at FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 20`, budget: 8, size: 64 * 1024 }),
  };
  const idxRun = (I, sql) => LB.sql.session(async (db) => {
    const M = IDX[I.lv](I);
    await db.exec(M.setup);
    if (sql) await runAll(db, sql);
    await db.exec("VACUUM ANALYZE " + M.table);
    const plan = await explain(db, M.q);
    return { plan, size: await idxSize(db, M.table), M };
  });
  const idxStatus = (I, r) => {
    const b = bufsOf(r.plan);
    if (b > r.M.budget) return `The plan is <code>${esc(LB.sql.planLine(r.plan))}</code> and touched <b>${b}</b> buffers (budget ${r.M.budget}).`;
    if (r.M.size && r.size > r.M.size) return `Fast, but your new index(es) take <b>${K.bytes(r.size)}</b> (budget ${K.bytes(r.M.size)}). Almost every row is indexed even though the query only ever wants a tiny fraction of them.`;
    return true;
  };
  S.push({
    id: "pg-pick-index-type",
    name: "Choose the right kind of index",
    kind: "Design review",
    skills: ["design", "tune"],
    w: "code",
    gen(lv, R) {
      if (lv === 1) { const g = R.int(100, 19900); return { lv, email: `user${g}@example.com`.replace("example.com", ["example.com", "example.com", "mail.example.org"][g % 3]) }; }
      if (lv === 2) return { lv, brand: R.int(1, 299), color: R.pick(["red", "blue", "green", "black", "white", "grey", "navy"]) };
      return { lv, pend: R.int(2, 5) };
    },
    text: (I) => {
      const M = IDX[I.lv](I);
      const ctx = I.lv === 1 ? "Login looks users up by email, case-insensitively, because people type their address however they like."
        : I.lv === 2 ? "The catalogue stores facets in a <code>jsonb</code> column, and the filter sidebar sends any combination of them as a containment query."
          : `A worker polls the <code>jobs</code> table every 100 ms. Only about ${I.pend / 10}% of the ${K.num(30000)} rows are ever pending; the rest are history.`;
      return `<p>${ctx} The query:</p>${K.pre(M.q)}<p>Write the <b>CREATE INDEX</b> statement(s). It runs on a real Postgres with <code>EXPLAIN (ANALYZE, BUFFERS)</code>. Pass by touching at most <b>${M.budget}</b> buffers${M.size ? ` with at most <b>${K.bytes(M.size)}</b> of new index (every write pays to maintain it)` : ""}.</p>`;
    },
    ui: (I) => ({ lang: "sql", rows: 4, ph: "CREATE INDEX ...", liveDelay: 900, live: async (sql) => {
      if (!sql || !sql.trim()) return `<p class="muted small">Type an index definition to see the real plan.</p>`;
      const bad = allowOnly(sql, [/^create\s+(unique\s+)?index\b/i], "CREATE INDEX statements"); if (bad) return `<p class="lose small">${bad}</p>`;
      try { const r = await idxRun(I, sql); return planBox(r.plan, { budget: r.M.budget, more: [{ name: "New index size", value: K.bytes(r.size), ok: r.M.size ? r.size <= r.M.size : null, target: r.M.size ? "budget " + K.bytes(r.M.size) : "" }] }); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => I.lv === 1 ? "CREATE INDEX ON users (lower(email));" : I.lv === 2 ? "CREATE INDEX ON products USING gin (attrs jsonb_path_ops);" : "CREATE INDEX ON jobs (created_at) WHERE status = 'pending';",
    bad: (I) => I.lv === 1 ? ["CREATE INDEX ON users (email);"] : I.lv === 2 ? ["CREATE INDEX ON products (attrs);", "CREATE INDEX ON products ((attrs->>'brand'));"] : ["CREATE INDEX ON jobs (status, created_at);", "CREATE INDEX ON jobs (status);"],
    async accept(I, sql) {
      const bad = allowOnly(sql, [/^create\s+(unique\s+)?index\b/i], "CREATE INDEX statements"); if (bad) return bad;
      let r; try { r = await idxRun(I, sql); } catch (e) { return pgErr(e); }
      return idxStatus(I, r);
    },
    hint: (I) => I.lv === 1 ? "An index on a column can't serve a condition on a function of that column." : I.lv === 2 ? "B-tree indexes support =, <, > on whole values. Which index type knows about containment inside a document?" : "Can an index cover only the rows the query asks for?",
    concept: "Index types: expression, GIN, partial",
    how: "A B-tree indexes the value of a column (or expression) and serves =, ranges and ORDER BY; a predicate like lower(email) = ... needs an index on exactly that expression. GIN is an inverted index: one entry per key/element inside a jsonb document, array or tsvector, so it answers containment (@>), key existence and full-text queries; jsonb_path_ops is smaller and faster but supports only @> style operators. A partial index (WHERE ...) stores only rows matching its predicate, so a hot query over a tiny subset gets a tiny, cheap-to-maintain index; the query's WHERE must imply the index predicate. For substring search (LIKE '%x%') you'd add the pg_trgm extension and a GIN trigram index; it isn't installed in this sandbox.",
    rule: "Match the index to the operator: B-tree for equality, ranges and sorting; GIN for containment, arrays, full text and trigrams; BRIN for huge naturally ordered tables. Index the exact expression the query uses, and use a partial index when queries only want a small, fixed subset.",
    why: (I, sol) => `<code>${esc(sol)}</code> ${I.lv === 1 ? "matches the query's <code>lower(email)</code> expression, so Postgres can seek directly instead of lower-casing 20,000 emails. (A UNIQUE version also enforces case-insensitive uniqueness.)" : I.lv === 2 ? "indexes every key/value path inside the documents, so the containment query intersects two posting lists. An index on <code>attrs->>'brand'</code> isn't used by <code>@&gt;</code>." : `holds only the ~${Math.round(30000 * I.pend / 1000)} pending rows in created_at order: the worker reads the first 20 entries and stops, and inserts of finished jobs never touch it.`}`,
  });

  /* ======================= 3. BRIN for time series ======================= */
  const brinSetup = (I) => `CREATE TABLE metrics (id bigint, ts timestamptz NOT NULL, device_id int NOT NULL, value float8 NOT NULL, tags text);
INSERT INTO metrics SELECT g, timestamptz '2026-01-01' + ${I.lv === 2 ? `((g * 7919) % 40000)` : "g"} * interval '15 seconds', g % 50, (g % 997) * 0.25, 'dc=eu-west-1,rack=r' || (g % 40) FROM generate_series(1, 40000) g;`;
  const brinQ = (I) => { const m = I.lv === 1 ? 120 : I.lv === 2 ? 20 : 60, t = (x) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; return `SELECT device_id, avg(value) FROM metrics WHERE ts >= timestamptz '2026-01-0${I.day} ${t(I.h * 60)}Z' AND ts < timestamptz '2026-01-0${I.day} ${t(I.h * 60 + m)}Z' GROUP BY device_id`; };
  const brinRun = (I, sql) => LB.sql.session(async (db) => {
    await db.exec(brinSetup(I));
    if (sql) await runAll(db, sql);
    await db.exec("VACUUM ANALYZE metrics");
    const plan = await explain(db, brinQ(I));
    const corr = (await db.q("SELECT round(correlation::numeric, 2) AS c FROM pg_stats WHERE tablename = 'metrics' AND attname = 'ts'")).rows[0];
    return { plan, size: await idxSize(db, "metrics"), corr: corr ? +corr.c : null };
  });
  S.push({
    id: "pg-brin-timeseries",
    name: "Index a huge append-only table",
    kind: "Design review",
    skills: ["design", "tune"],
    w: "code",
    gen(lv, R) {
      const day = R.int(2, 5), h = R.int(1, 20);
      return { lv, day, h, budget: lv === 1 ? 300 : lv === 2 ? 100 : 60, size: lv === 2 ? 2 * 1024 * 1024 : 48 * 1024 };
    },
    text: (I) => `<p><code>metrics</code> is append-only: ${I.lv === 2 ? "but last night a backfill job re-inserted months of history in device order, so the physical row order no longer follows <code>ts</code>. A teammate proposes the same BRIN index that worked for the other metrics tables." : "devices write rows in time order and nothing is ever updated. In production it's 3 TB; here it's a 40,000-row sample with the same shape."} Dashboards run:</p>${K.pre(brinQ(I))}
      <p>Write the <b>CREATE INDEX</b> statement(s). Pass by touching at most <b>${I.budget}</b> buffers with at most <b>${K.bytes(I.size)}</b> of index${I.lv === 2 ? "" : " (a B-tree on ts would be ~20× that and would itself need to be cached)"}.</p>`,
    ui: (I) => ({ lang: "sql", rows: 4, ph: "CREATE INDEX ...", liveDelay: 900, live: async (sql) => {
      const has = sql && sql.trim();
      const bad = has ? allowOnly(sql, [/^create\s+index\b/i], "CREATE INDEX statements") : null; if (bad) return `<p class="lose small">${bad}</p>`;
      try { const r = await brinRun(I, has ? sql : ""); return (has ? "" : `<p class="muted small">Without an index:</p>`) + planBox(r.plan, { budget: I.budget, more: [{ name: "Index size", value: K.bytes(r.size), ok: r.size <= I.size, target: "budget " + K.bytes(I.size) }, { name: "pg_stats correlation(ts)", value: r.corr == null ? "–" : String(r.corr), ok: null, target: "1 = physical order matches ts" }] }); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => I.lv === 1 ? "CREATE INDEX ON metrics USING brin (ts);" : I.lv === 2 ? "CREATE INDEX ON metrics (ts);" : "CREATE INDEX ON metrics USING brin (ts) WITH (pages_per_range = 8);",
    bad: (I) => I.lv === 1 ? ["CREATE INDEX ON metrics (ts);"] : I.lv === 2 ? ["CREATE INDEX ON metrics USING brin (ts);"] : ["CREATE INDEX ON metrics USING brin (ts);", "CREATE INDEX ON metrics (ts);"],
    async accept(I, sql) {
      const bad = allowOnly(sql, [/^create\s+index\b/i], "CREATE INDEX statements"); if (bad) return bad;
      let r; try { r = await brinRun(I, sql); } catch (e) { return pgErr(e); }
      const b = bufsOf(r.plan);
      if (b > I.budget) return `Plan <code>${esc(LB.sql.planLine(r.plan))}</code> touched <b>${b}</b> buffers (budget ${I.budget}).${I.lv === 2 ? ` Physical order vs ts correlation is ${r.corr}: every block range now spans the whole time range, so a BRIN summary can't exclude anything.` : I.lv === 3 ? " A BRIN index can only skip whole block ranges; with the default 128 pages per range, the window lands in one big range that must be read in full." : ""}`;
      if (r.size > I.size) return `It's fast, but the index is <b>${K.bytes(r.size)}</b> (budget ${K.bytes(I.size)}).`;
      return true;
    },
    hint: (I) => I.lv === 1 ? "When rows arrive in time order, each block of the table covers a narrow, non-overlapping time range. Which index type stores just a min/max per range of blocks?" : I.lv === 2 ? "A BRIN index is only as good as the correlation between physical order and the column. Check it in the live panel." : "BRIN has a storage parameter for how many heap pages each summary covers.",
    concept: "BRIN indexes and physical correlation",
    how: "A BRIN (block range) index stores one tiny summary, the min and max of the column, per range of heap pages (128 by default). A query reads the summaries, skips ranges that can't match, and scans every page of the ranges that might (a lossy bitmap heap scan with a recheck). On an append-only table where the column follows insertion order this is thousands of times smaller than a B-tree and nearly free to maintain. It's useless when physical order and column order diverge (updates, backfills, out-of-order ingestion): every range then covers everything. pages_per_range trades index size for precision.",
    rule: "Use BRIN for very large, append-only tables queried by a column that tracks insertion order (check pg_stats.correlation near 1); otherwise use a B-tree. Tune pages_per_range so a typical query reads only a few ranges.",
    why: (I) => I.lv === 1 ? "Rows were inserted in ts order, so each 128-page range covers a narrow time window. The BRIN index is a few kilobytes and lets the query skip every range outside the window." : I.lv === 2 ? "After the backfill, pages hold rows from all over the time range, so every BRIN range's min/max spans nearly the whole table and nothing can be skipped. A B-tree doesn't depend on physical order." : `A one-hour window covers only a few dozen pages, but default BRIN ranges are 128 pages each, so Postgres had to read a whole range. With pages_per_range = 8 (or 16) the summaries are fine-grained enough to stay within ${I.budget} buffers while the index stays tiny.`,
  });

  /* ======================= 4. SKIP LOCKED job queue ======================= */
  const qSetup = (I) => `CREATE TABLE jobs (id bigint PRIMARY KEY, queue text NOT NULL, priority int NOT NULL, run_at timestamptz NOT NULL, state text NOT NULL, locked_by text, locked_at timestamptz, attempts int NOT NULL DEFAULT 0);
INSERT INTO jobs SELECT g, (ARRAY['email','billing','export'])[1 + g % 3], (g / 7) % 5, timestamptz '2026-05-01 11:00Z' + ((g * 37) % 180) * interval '1 minute', CASE WHEN g % 9 = 0 THEN 'done' WHEN g % 11 = 0 THEN 'running' ELSE 'queued' END, CASE WHEN g % 11 = 0 THEN 'w-' || (g % 4) END, CASE WHEN g % 11 = 0 THEN timestamptz '2026-05-01 12:00Z' - ((g * 7) % 30) * interval '1 minute' END, (g * 3) % 7 FROM generate_series(1, 1500) g;`;
  const NOW = "timestamptz '2026-05-01 12:00Z'";
  const qRef = (I) => I.lv === 1
    ? `UPDATE jobs SET state = 'running', locked_by = '${I.w}', locked_at = ${NOW} WHERE id = (SELECT id FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`
    : I.lv === 2
      ? `UPDATE jobs SET state = 'running', locked_by = '${I.w}', locked_at = ${NOW}, attempts = attempts + 1 WHERE id IN (SELECT id FROM jobs WHERE state = 'queued' AND queue = '${I.queue}' AND run_at <= ${NOW} ORDER BY priority DESC, run_at, id LIMIT ${I.n} FOR UPDATE SKIP LOCKED) RETURNING id`
      : `UPDATE jobs SET state = 'running', locked_by = '${I.w}', locked_at = ${NOW}, attempts = attempts + 1 WHERE id IN (SELECT id FROM jobs WHERE queue = '${I.queue}' AND run_at <= ${NOW} AND attempts < 5 AND (state = 'queued' OR (state = 'running' AND locked_at < ${NOW} - interval '${I.lease} minutes')) ORDER BY priority DESC, run_at, id LIMIT ${I.n} FOR UPDATE SKIP LOCKED) RETURNING id`;
  const qRun = (I, sql) => LB.sql.session(async (db) => {
    await db.exec(qSetup(I));
    await db.exec("BEGIN");
    const r1 = await db.q(qRef(I));
    const snapRef = (await db.q("SELECT id, state, locked_by, locked_at, attempts FROM jobs ORDER BY id")).rows;
    await db.exec("ROLLBACK");
    await db.exec("BEGIN");
    let r2;
    try { r2 = await db.q(sql); } catch (e) { await db.exec("ROLLBACK"); throw e; }
    const snap = (await db.q("SELECT id, state, locked_by, locked_at, attempts FROM jobs ORDER BY id")).rows;
    await db.exec("ROLLBACK");
    return { ref: r1.rows.map((r) => Number(r.id)).sort((a, b) => a - b), got: (r2.rows || []).map((r) => Number(r.id != null ? r.id : Object.values(r)[0])).sort((a, b) => a - b), same: LB.sql.sameRows(snapRef, snap, true), hasRet: !!(r2.fields && r2.fields.length) };
  });
  const qCheck = (I, sql) => {
    const ss = stmtsOf(sql);
    if (ss.length !== 1) return "Claim the jobs in one statement, so there's no window between choosing and marking them.";
    if (!/^(update|with)\b/i.test(ss[0])) return "Write an UPDATE (optionally with a WITH clause) that claims the jobs and returns their ids.";
    const g = LB.sql.guard(ss[0]); if (g) return g;
    return null;
  };
  S.push({
    id: "pg-skip-locked-queue",
    name: "Build a Postgres job queue",
    kind: "Design review",
    skills: ["design", "safe"],
    w: "code",
    gen(lv, R) { return { lv, w: "w-" + R.int(10, 99), queue: R.pick(["email", "billing", "export"]), n: lv === 1 ? 1 : R.int(3, 8), lease: R.pick([10, 15, 20]) }; },
    text: (I) => `<p>${K.num(40)} worker processes poll a <code>jobs</code> table (<code>id, queue, priority, run_at, state, locked_by, locked_at, attempts</code>). Today they <code>SELECT</code> a job then <code>UPDATE</code> it, so two workers regularly grab the same job, and the obvious fix (<code>FOR UPDATE</code>) makes all 40 queue up behind one row.</p>
      <p>Write <b>one statement</b> that worker <code>${I.w}</code> runs to claim ${I.lv === 1 ? "the oldest queued job (lowest id)" : `up to <b>${I.n}</b> due jobs from queue <code>${I.queue}</code>, highest priority first, then oldest run_at, then id`}: set <code>state = 'running'</code>, <code>locked_by</code>, <code>locked_at</code> = ${K.code("timestamptz '2026-05-01 12:00Z'")} (use this literal for "now")${I.lv > 1 ? ", increment <code>attempts</code>" : ""}, and <code>RETURNING id</code>. Concurrent workers must neither wait for nor double-claim each other's jobs.${I.lv === 3 ? ` Workers can crash: a <code>running</code> job whose <code>locked_at</code> is more than <b>${I.lease} minutes</b> old must be reclaimable, and jobs that have already been attempted 5 times must not be picked again.` : ""}</p>`,
    ui: (I) => ({ lang: "sql", rows: 7, ph: "UPDATE jobs SET ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING id", liveDelay: 900, live: async (sql) => {
      if (!sql || !sql.trim()) return `<p class="muted small">Write the claim statement; it runs inside a transaction that is rolled back, against 1,500 jobs.</p>`;
      const bad = qCheck(I, sql); if (bad) return `<p class="lose small">${bad}</p>`;
      try { const r = await qRun(I, sql); return K.metrics([{ name: "Claimed ids", value: esc(r.got.slice(0, 8).join(", ") + (r.got.length > 8 ? "…" : "")) || "none", ok: LB.same(r.got, r.ref) }, { name: "Expected", value: esc(r.ref.join(", ")), ok: null }, { name: "Table state", value: r.same ? "matches" : "differs", ok: r.same }, { name: "SKIP LOCKED", value: /for\s+update\s+skip\s+locked/i.test(sql) ? "yes" : "no", ok: /for\s+update\s+skip\s+locked/i.test(sql) }]); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => qRef(I) + ";",
    bad: (I) => [qRef(I).replace(" SKIP LOCKED", ""), qRef(I).replace(" FOR UPDATE SKIP LOCKED", ""), ...(I.lv === 3 ? [qRef({ ...I, lv: 2 })] : I.lv === 2 ? [qRef(I).replace("priority DESC, run_at, id", "run_at, id")] : [])],
    async accept(I, sql) {
      const bad = qCheck(I, sql); if (bad) return bad;
      let r; try { r = await qRun(I, stmtsOf(sql)[0]); } catch (e) { return pgErr(e); }
      if (!LB.same(r.got, r.ref)) return `It claimed ids <b>${esc(r.got.join(", ") || "none")}</b>; the right jobs are <b>${esc(r.ref.join(", "))}</b>.${r.hasRet ? "" : " (Did you forget RETURNING id?)"}`;
      if (!r.same) return "The right jobs, but the rows aren't updated as specified (state, locked_by, locked_at, attempts).";
      if (!/for\s+update\s+skip\s+locked/i.test(sql)) return /for\s+update/i.test(sql) ? (/nowait/i.test(sql) ? "NOWAIT makes a worker error out instead of moving on to the next free job." : "Correct on one worker, but with plain FOR UPDATE every concurrent worker blocks on the same first row and waits for its transaction to finish: 40 workers process one job at a time.") : "Correct on one worker, but two workers running this concurrently both pick the same rows: nothing locks the chosen jobs between choosing and updating. (Under READ COMMITTED the second UPDATE re-checks the row and may claim it again or claim nothing.)";
      return true;
    },
    hint: (I) => I.lv === 1 ? "Lock the chosen row in a subquery, and let other workers skip rows that are already locked." : I.lv === 2 ? "The ORDER BY and LIMIT go inside the locking subquery; UPDATE itself has no LIMIT." : "A crashed worker's job stays 'running' forever unless the claim query also treats an expired lease as claimable.",
    concept: "FOR UPDATE SKIP LOCKED queues",
    how: "SELECT ... FOR UPDATE locks the rows it returns; with SKIP LOCKED, rows already locked by another transaction are silently skipped instead of waited for. Wrapping that in UPDATE ... WHERE id IN (SELECT ... ORDER BY ... LIMIT n FOR UPDATE SKIP LOCKED) RETURNING id claims a batch atomically: concurrent workers each get different rows and nobody blocks. Without locking, two workers read the same 'queued' row and both process it; with plain FOR UPDATE they serialise on the first row. A lease (locked_at plus a timeout) lets jobs from crashed workers be reclaimed, and an attempts cap stops poison jobs from looping forever.",
    rule: "For a Postgres-backed queue, claim with UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n) RETURNING, index the claim predicate (a partial index on queued jobs), keep the claiming transaction short, and use leases plus an attempts limit.",
    why: (I) => `Worker ${esc(I.w)} claims ${I.lv === 1 ? "one job" : `${I.n} jobs`} in a single statement; other workers running the same statement skip those locked rows and take the next ones instead of waiting.${I.lv === 3 ? ` Including expired ${I.lease}-minute leases makes crashed workers' jobs come back, and <code>attempts &lt; 5</code> keeps a poison job from being retried forever.` : ""}`,
  });

  /* ======================= 5. keyset pagination ======================= */
  const ksSetup = `CREATE TABLE posts (id bigint PRIMARY KEY, author_id int NOT NULL, created_at timestamptz NOT NULL, score int NOT NULL, title text NOT NULL);
INSERT INTO posts SELECT g, g % 900, timestamptz '2026-01-01' + (((g * 7919) % 30000) / 4) * interval '1 minute', (g * 7919) % 1000, 'post #' || g FROM generate_series(1, 30000) g;
CREATE INDEX posts_created_id ON posts (created_at, id);
CREATE INDEX posts_score_id ON posts (score DESC, id);`;
  const ksRef = (I) => I.lv === 1 ? `SELECT id, title FROM posts WHERE id < ${I.id} ORDER BY id DESC LIMIT 20`
    : I.lv === 2 ? `SELECT id, created_at, title FROM posts WHERE (created_at, id) < (timestamptz '${I.ts}', ${I.id}) ORDER BY created_at DESC, id DESC LIMIT 20`
      : `SELECT id, score, title FROM posts WHERE score <= ${I.score} AND (score < ${I.score} OR id > ${I.id}) ORDER BY score DESC, id LIMIT 20`;
  const ksRun = (I, q) => LB.sql.session(async (db) => {
    await db.exec(ksSetup); await db.exec("VACUUM ANALYZE posts");
    const ref = await db.q(ksRef(I)), got = await db.q(q), plan = await explain(db, q);
    return { ref, got, plan, same: LB.sql.sameRows(ref.rows, got.rows, true) };
  });
  const KSB = { 1: 10, 2: 40, 3: 60 };
  const ksTsOf = (g) => { const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(((g * 7919) % 30000) / 4) * 60000); return d.toISOString().slice(0, 16).replace("T", " ") + "Z"; };
  S.push({
    id: "pg-keyset-pagination",
    name: "Paginate a feed without OFFSET",
    kind: "Code review",
    skills: ["design", "tune"],
    w: "code",
    gen(lv, R) {
      if (lv === 1) return { lv, id: R.int(3000, 9000), page: R.int(800, 1300) };
      if (lv === 2) { const g = R.int(8000, 24000); return { lv, id: g, ts: ksTsOf(g), page: R.int(600, 1100) }; }
      const score = R.int(150, 450);
      let id = R.int(1000, 25000);
      // the cursor must be a real row with that score
      for (let k = 0; k < 30000 && (id * 7919) % 1000 !== score; k++) id = (id % 30000) + 1;
      return { lv, id, score, page: R.int(300, 900) };
    },
    text: (I) => {
      const shape = I.lv === 1 ? ["newest first (ORDER BY id DESC)", "id", `id = ${I.id}`, "id, title"] : I.lv === 2 ? ["newest first (ORDER BY created_at DESC, id DESC). Several posts share the same minute", "(created_at, id)", `created_at = '${I.ts}', id = ${I.id}`, "id, created_at, title"] : ["by score, highest first, ties by id ascending (ORDER BY score DESC, id)", "(score, id)", `score = ${I.score}, id = ${I.id}`, "id, score, title"];
      return `<p>The mobile feed lists 30,000 posts ${shape[0]}, 20 per page. It uses <code>LIMIT 20 OFFSET page*20</code>, and on page ${I.page} that costs a scan of ${K.num(I.page * 20)} rows; posts inserted meanwhile also make users see duplicates.</p>
      <p>Write the query for the <b>next page</b> after the last row the client saw: <code>${esc(shape[2])}</code>. Return <code>${shape[3]}</code>, in feed order, 20 rows, <b>no OFFSET</b>. Indexes: <code>posts (created_at, id)</code>, <code>posts (score DESC, id)</code> and the primary key. Pass with the exact same rows as the reference and at most <b>${KSB[I.lv]}</b> buffers.</p>`;
    },
    ui: (I) => ({ lang: "sql", rows: 5, ph: "SELECT ... FROM posts WHERE ... ORDER BY ... LIMIT 20", liveDelay: 900, live: async (sql) => {
      if (!sql || !sql.trim()) return `<p class="muted small">Write the next-page query to run it.</p>`;
      const o = oneQuery(sql); if (o.err) return `<p class="lose small">${o.err}</p>`;
      try { const r = await ksRun(I, o.q); return planBox(r.plan, { budget: KSB[I.lv], more: [{ name: "Rows match reference", value: r.same ? "yes" : "no", ok: r.same }] }) + LB.sql.table(r.got, 6); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => ksRef(I) + ";",
    bad: (I) => I.lv === 1 ? [`SELECT id, title FROM posts ORDER BY id DESC LIMIT 20 OFFSET ${(30000 - I.id + 1)}`] : I.lv === 2 ? [ksRef(I).replace(`(created_at, id) < (timestamptz '${I.ts}', ${I.id})`, `created_at < timestamptz '${I.ts}'`), ksRef(I).replace(`(created_at, id) < (timestamptz '${I.ts}', ${I.id})`, `created_at <= timestamptz '${I.ts}' AND id <> ${I.id}`)] : [ksRef(I).replace(`score <= ${I.score} AND (score < ${I.score} OR id > ${I.id})`, `(score, id) < (${I.score}, ${I.id})`), ksRef(I).replace(`score <= ${I.score} AND (score < ${I.score} OR id > ${I.id})`, `(score < ${I.score} OR (score = ${I.score} AND id > ${I.id}))`)],
    async accept(I, sql) {
      const o = oneQuery(sql); if (o.err) return o.err;
      if (/\boffset\b/i.test(o.q)) return "No OFFSET: Postgres still has to produce and throw away every skipped row, and rows inserted since the last page shift everything by one.";
      let r; try { r = await ksRun(I, o.q); } catch (e) { return pgErr(e); }
      if (!r.same) return `Not the right page: you returned ${r.got.rows.length} rows${r.got.rows.length ? ` starting at id ${esc(String(Object.values(r.got.rows[0])[0]))}` : ""}; the next page starts at id ${esc(String(r.ref.rows[0].id))}.${I.lv === 2 ? " Watch the rows that share the cursor's created_at." : I.lv === 3 ? " The two sort keys go in opposite directions, so a row-value comparison (a, b) &lt; (x, y) doesn't describe 'after the cursor'." : ""}`;
      const b = bufsOf(r.plan), budget = KSB[I.lv];
      if (b > budget) return `Right rows, but the plan touched <b>${b}</b> buffers (budget ${budget}): <code>${esc(LB.sql.planLine(r.plan))}</code>.${I.lv === 3 ? " With only an OR, the index scan starts at the top of the index and filters out every row before the cursor. Give it a condition it can use as an index bound." : ""}`;
      return true;
    },
    hint: (I) => I.lv === 1 ? "Instead of skipping rows, filter for rows that sort after the last one seen." : I.lv === 2 ? "Rows that share the cursor's created_at but have a smaller id still belong on the next page. Postgres compares row values lexicographically." : "Split it: rows with a lower score, or the same score and a higher id. Then add a redundant bound the index can seek to.",
    concept: "Keyset (seek) pagination",
    how: "OFFSET n makes Postgres produce and discard n rows on every page, so deep pages get linearly slower, and concurrent inserts shift rows between pages. Keyset pagination remembers the sort key of the last row and asks for rows strictly after it, which an index on the sort key answers by seeking straight to the cursor and reading 20 entries. The sort key must be unique, so add a tiebreaker (usually id). When every key sorts the same direction a row comparison (a, b) < (x, y) matches the index directly; with mixed directions you expand it to a < x OR (a = x AND b > y) and add a plain bound (a <= x) the planner can use as an index condition.",
    rule: "Paginate by a unique, indexed sort key: WHERE (sort_key, id) < (:last_key, :last_id) ORDER BY sort_key DESC, id DESC LIMIT n, and hand the client an opaque cursor instead of a page number.",
    why: (I) => I.lv === 1 ? `WHERE id < ${I.id} lets the primary key index seek straight to the cursor and read 20 entries, however deep the page.` : I.lv === 2 ? `Several posts share each minute, so <code>created_at &lt; '${esc(I.ts)}'</code> skips the cursor's siblings with smaller ids. The row comparison keeps them, and matches the (created_at, id) index order exactly.` : `score DESC with id ASC can't be expressed as one row comparison. <code>score &lt;= ${I.score}</code> gives the index scan a starting point at the cursor; the OR then removes the rows with score ${I.score} at or before id ${I.id}.`,
  });

  /* ======================= 6. top-N per group ======================= */
  const tnSetup = (I) => `CREATE TABLE customers (id int PRIMARY KEY, name text NOT NULL);
INSERT INTO customers SELECT g, 'customer ' || g FROM generate_series(1, 250) g;
CREATE TABLE orders (id bigint PRIMARY KEY, customer_id int NOT NULL, total numeric(10,2) NOT NULL, created_at timestamptz NOT NULL);
INSERT INTO orders SELECT g, 1 + (g * ${I.mul}) % 200, ((g * 37) % 40) * 5, timestamptz '2026-01-01' + ((g * 7919) % 4000) * interval '1 hour' FROM generate_series(1, 4000) g;
CREATE TABLE products (id int PRIMARY KEY, category text NOT NULL);
INSERT INTO products SELECT g, 'cat_' || (g % 12) FROM generate_series(1, 240) g;
CREATE TABLE sales (id bigint PRIMARY KEY, product_id int NOT NULL, sold_at timestamptz NOT NULL, amount numeric(10,2) NOT NULL);
INSERT INTO sales SELECT g, 1 + ((g * g * ${I.mul} + g / 3) % 240), timestamptz '2026-02-20' + ((g * 31) % 960) * interval '1 hour', 100 FROM generate_series(1, 3000) g;`;
  const tnRef = (I) => I.lv === 1 ? `SELECT customer_id, id, total FROM (SELECT customer_id, id, total, row_number() OVER (PARTITION BY customer_id ORDER BY total DESC, id) AS rn FROM orders) t WHERE rn <= 3`
    : I.lv === 2 ? `SELECT c.id AS customer_id, o.id AS order_id, o.created_at FROM customers c LEFT JOIN LATERAL (SELECT id, created_at FROM orders WHERE customer_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) o ON true`
      : `SELECT category, product_id, revenue FROM (SELECT p.category, s.product_id, sum(s.amount) AS revenue, rank() OVER (PARTITION BY p.category ORDER BY sum(s.amount) DESC) AS r FROM sales s JOIN products p ON p.id = s.product_id WHERE s.sold_at >= timestamptz '2026-03-01' AND s.sold_at < timestamptz '2026-04-01' GROUP BY p.category, s.product_id) t WHERE r <= 2`;
  const cmpRun = (setup, ref) => (q) => LB.sql.session(async (db) => {
    await db.exec(setup);
    const d = await diffRows(db, q, ref);
    const got = await db.q(q);
    return { ...d, got };
  });
  const cmpLive = (run) => async (sql) => {
    if (!sql || !sql.trim()) return `<p class="muted small">Write the query to run it against the sample data.</p>`;
    const o = oneQuery(sql); if (o.err) return `<p class="lose small">${o.err}</p>`;
    try { const r = await run(o.q); return K.metrics([{ name: "Rows returned", value: K.num(r.got.rows.length), ok: null }, { name: "Missing vs reference", value: K.num(r.missing), ok: r.missing === 0 }, { name: "Extra vs reference", value: K.num(r.extra), ok: r.extra === 0 }]) + LB.sql.table(r.got, 8); }
    catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
  };
  const cmpAccept = (run, more) => async (I, sql) => {
    const o = oneQuery(sql); if (o.err) return o.err;
    let r; try { r = await run(o.q); } catch (e) { return pgErr(e); }
    if (r.missing || r.extra) return `Compared with the reference: <b>${r.missing}</b> row(s) missing and <b>${r.extra}</b> extra.${more ? " " + more(I, r) : ""}`;
    return true;
  };
  S.push({
    id: "pg-top-n-per-group",
    name: "Top N per group",
    kind: "Code review",
    skills: ["design"],
    w: "code",
    gen(lv, R) { return { lv, mul: R.pick([7, 11, 13, 17, 19, 23]) }; },
    text: (I) => `<p>${I.lv === 1 ? "The account page shows each customer's <b>3 largest orders</b>. Totals repeat a lot; break ties by the lower order id, so every customer with 3+ orders gets exactly 3 rows. Return <code>customer_id, id, total</code>." : I.lv === 2 ? "The CRM export needs every customer's <b>most recent order</b> (ties on created_at: higher id wins). Customers who never ordered must still appear, with NULLs. Return <code>customer_id, order_id, created_at</code>, one row per customer in <code>customers</code>." : "Merchandising wants the <b>top 2 products per category by March 2026 revenue</b> (sales with <code>sold_at</code> in March, UTC). If products tie at the cut-off, include <b>all</b> of the tied products: a category may return more than 2 rows, but never skip a revenue level. Return <code>category, product_id, revenue</code>."}</p>
      <p>Tables: <code>customers(id, name)</code>, <code>orders(id, customer_id, total, created_at)</code>, <code>products(id, category)</code>, <code>sales(id, product_id, sold_at, amount)</code>. Your query runs on real Postgres and is compared row by row (order doesn't matter) with the reference.</p>`,
    ui: (I) => ({ lang: "sql", rows: 7, ph: "SELECT ... OVER (PARTITION BY ... ORDER BY ...) ...", liveDelay: 900, live: cmpLive(cmpRun(tnSetup(I), tnRef(I))) }),
    solve: (I) => tnRef(I) + ";",
    bad: (I) => I.lv === 1 ? [tnRef(I).replace("row_number() OVER (PARTITION BY customer_id ORDER BY total DESC, id)", "rank() OVER (PARTITION BY customer_id ORDER BY total DESC)"), `SELECT customer_id, id, total FROM orders ORDER BY total DESC, id LIMIT 3`] : I.lv === 2 ? [tnRef(I).replace("LEFT JOIN LATERAL", "JOIN LATERAL")] : [tnRef(I).replace("rank()", "row_number()"), tnRef(I).replace("rank()", "dense_rank()")],
    accept: (I, sql) => cmpAccept(cmpRun(tnSetup(I), tnRef(I)), (I2) => I2.lv === 1 ? "rank() gives tied rows the same number, so some customers get 4+ rows; row_number() with a tiebreaker gives exactly 3." : I2.lv === 2 ? "An inner join (or a WHERE on the joined row) drops customers with no orders." : "row_number() cuts ties arbitrarily; dense_rank() includes a third revenue level. 'Two places, with ties' is rank().")(I, sql),
    hint: (I) => I.lv === 1 ? "Number the rows within each customer with a window function, then filter on that number in an outer query." : I.lv === 2 ? "For each customer, fetch one order with a correlated subquery that may return nothing. LATERAL lets a subquery in FROM refer to the outer row." : "Three ranking functions differ only in how they treat ties: row_number, rank, dense_rank.",
    concept: "Top-N per group",
    how: "Window functions compute a value per row over a partition without collapsing rows: row_number() OVER (PARTITION BY g ORDER BY x DESC, id) numbers rows within each group, and an outer WHERE rn <= N keeps the top N (a window function can't be used directly in WHERE). row_number() breaks ties arbitrarily unless the ORDER BY is unique; rank() gives ties the same rank and leaves gaps (1, 1, 3); dense_rank() leaves no gaps (1, 1, 2). For 'one latest row per group' on large tables, a LATERAL subquery with ORDER BY ... LIMIT 1 per group (backed by an index on (group, sort key)) or DISTINCT ON can be much faster than ranking every row, and LEFT JOIN LATERAL keeps groups with no rows.",
    rule: "Decide what ties mean before writing the query: exactly N (row_number with a unique tiebreaker) or 'N places' (rank). For latest-per-group, use LEFT JOIN LATERAL ... ORDER BY ... LIMIT 1 with an index on (group_key, sort_key).",
    why: (I) => I.lv === 1 ? "Order totals are multiples of 5 and repeat, so ranking with ties would return 4 or 5 rows for some customers. row_number() with id as the tiebreaker returns exactly 3." : I.lv === 2 ? "50 of the 250 customers have no orders. LEFT JOIN LATERAL returns them with NULLs; the per-customer LIMIT 1 is answered from an index on (customer_id, created_at) in production." : "Every sale is 100, so revenues tie often. rank() keeps every product at the first two revenue levels-with-gaps, exactly 'top 2 with ties'.",
  });

  /* ======================= 7. gaps and islands ======================= */
  const giSetup = (I) => `CREATE TABLE logins (user_id int NOT NULL, at timestamptz NOT NULL);
INSERT INTO logins SELECT u, timestamptz '2026-01-01' + d * interval '1 day' + ((u * 7 + d * 13) % 20) * interval '1 hour'${I.lv >= 2 ? " + r * interval '37 minutes'" : ""} FROM generate_series(1, 60) u, generate_series(0, 120) d${I.lv >= 2 ? ", generate_series(0, 2) r" : ""} WHERE ((u * ${I.a} + d * ${I.b}) % 9) < 6 AND (d + u) % 17 <> 0${I.lv >= 2 ? " AND (r = 0 OR (u + d + r) % 3 = 0)" : ""};
CREATE TABLE events (user_id int NOT NULL, ts timestamptz NOT NULL);
INSERT INTO events SELECT u, timestamptz '2026-03-01 08:00Z' + (k * 10 + ((u * k) % 7 = 0)::int * 20 + ((k % 9 = 4)::int) * 0) * interval '1 minute' + (k / 6) * interval '${I.gap} minutes' FROM generate_series(1, 25) u, generate_series(0, 40) k WHERE (u + k) % 5 <> 0;`;
  const giRef = (I) => I.lv === 1 ? `SELECT min(day) AS start_day, max(day) AS end_day, count(*) AS days FROM (SELECT day, day - (row_number() OVER (ORDER BY day))::int AS grp FROM (SELECT (at AT TIME ZONE 'UTC')::date AS day FROM logins WHERE user_id = ${I.u}) d) t GROUP BY grp`
    : I.lv === 2 ? `SELECT user_id, max(days) AS longest FROM (SELECT user_id, grp, count(*) AS days FROM (SELECT user_id, day, day - (row_number() OVER (PARTITION BY user_id ORDER BY day))::int AS grp FROM (SELECT DISTINCT user_id, (at AT TIME ZONE 'UTC')::date AS day FROM logins) d) t GROUP BY user_id, grp) s GROUP BY user_id`
      : `SELECT user_id, min(ts) AS session_start, max(ts) AS session_end, count(*) AS events FROM (SELECT user_id, ts, sum(CASE WHEN prev IS NULL OR ts - prev > interval '30 minutes' THEN 1 ELSE 0 END) OVER (PARTITION BY user_id ORDER BY ts) AS sid FROM (SELECT user_id, ts, lag(ts) OVER (PARTITION BY user_id ORDER BY ts) AS prev FROM events) a) b GROUP BY user_id, sid`;
  S.push({
    id: "pg-gaps-islands",
    name: "Find the streaks",
    kind: "Code review",
    skills: ["design"],
    w: "code",
    gen(lv, R) { return { lv, u: R.int(1, 60), a: R.pick([2, 4, 5, 7]), b: R.pick([1, 2, 4]), gap: R.pick([10, 15, 20]) }; },
    text: (I) => `<p>${I.lv === 1 ? `Product wants to show user <b>${I.u}</b> their login streaks. <code>logins(user_id, at timestamptz)</code> has one row per day the user logged in. Return one row per streak of consecutive days (UTC): <code>start_day, end_day, days</code> (dates and a count).` : I.lv === 2 ? "The streak leaderboard needs every user's <b>longest streak</b> of consecutive login days (UTC). <code>logins(user_id, at timestamptz)</code> has a row per login, often several per day. Return <code>user_id, longest</code>." : "Analytics wants sessions from the click stream <code>events(user_id, ts)</code>: a new session starts at a user's first event and whenever <b>more than 30 minutes</b> passed since that user's previous event (exactly 30 minutes is the same session). Return <code>user_id, session_start, session_end, events</code>."}</p><p>Your query runs on real Postgres and is compared with the reference result (any row order).</p>`,
    ui: (I) => ({ lang: "sql", rows: 8, ph: "SELECT ... row_number() / lag() OVER (...) ...", liveDelay: 900, live: cmpLive(cmpRun(giSetup(I), giRef(I))) }),
    solve: (I) => giRef(I) + ";",
    bad: (I) => I.lv === 1 ? [`SELECT min((at AT TIME ZONE 'UTC')::date), max((at AT TIME ZONE 'UTC')::date), count(*) FROM logins WHERE user_id = ${I.u}`] : I.lv === 2 ? [giRef(I).replace("SELECT DISTINCT user_id", "SELECT user_id")] : [giRef(I).replace("ts - prev > interval", "ts - prev >= interval")],
    accept: (I, sql) => cmpAccept(cmpRun(giSetup(I), giRef(I)), (I2) => I2.lv === 1 ? "Consecutive days have a constant difference between the date and its row number within the user's logins; group by that difference." : I2.lv === 2 ? "Several logins on the same day break the date − row_number trick: count distinct days." : "Check the boundary: a gap of exactly 30 minutes continues the session.")(I, sql),
    hint: (I) => I.lv === 1 ? "Subtract row_number() (as days) from each date: consecutive days produce the same result." : I.lv === 2 ? "Make it one row per user per day before numbering." : "Mark each event that starts a session (lag() gives the previous timestamp), then a running sum() of those marks numbers the sessions.",
    concept: "Gaps and islands",
    how: "An 'island' is a run of consecutive values. For dates, date − row_number() OVER (ORDER BY date) is constant within a run of consecutive days and changes after each gap, so grouping by it yields one group per island; this needs one row per day, so de-duplicate first. For gap-based grouping (sessions), lag() exposes the previous row's value, a CASE flags rows that start a new group, and a running sum() OVER (ORDER BY ts) turns those flags into group ids. Both run in a single pass over sorted data, unlike self-joins or procedural loops.",
    rule: "For runs and sessions, flag boundaries with lag()/row_number() and turn them into group ids with a running sum, then aggregate; be explicit about duplicates and about whether the boundary condition is > or >=.",
    why: (I) => I.lv === 1 ? `For user ${I.u}, each day minus its position in the sorted list stays constant across a streak, so GROUP BY that value returns one row per streak.` : I.lv === 2 ? "Some days have 2–3 logins. Without DISTINCT, the duplicate rows advance row_number() without advancing the date and split streaks into fragments." : "Events are 10 minutes apart with occasional larger jumps, some of them exactly 30 minutes. Using >= would split sessions the spec says to keep together.",
  });

  /* ======================= 8. upsert ======================= */
  const upSetup = (I) => `CREATE TABLE inventory (sku text PRIMARY KEY, qty int NOT NULL, version int NOT NULL, updated_at timestamptz NOT NULL DEFAULT timestamptz '2026-01-01');
INSERT INTO inventory (sku, qty, version) SELECT 'SKU-' || g, (g * 17) % 90, 1 + g % 4 FROM generate_series(1, 400) g;
CREATE TABLE staging (sku text NOT NULL, qty int NOT NULL, version int NOT NULL);
INSERT INTO staging SELECT 'SKU-' || (300 + g${I.lv === 3 ? " % 120" : ""}), ${I.lv === 2 ? "(g * 7) % 50" : "1 + (g * 7) % 9"}, ${I.lv === 2 ? "1 + (g * 5) % 6" : "1"} FROM generate_series(1, ${I.lv === 3 ? 200 : 160}) g;
CREATE TABLE inventory_ref AS SELECT * FROM inventory; ALTER TABLE inventory_ref ADD PRIMARY KEY (sku);`;
  const upRef = (I) => I.lv === 1 ? `INSERT INTO inventory (sku, qty, version) SELECT sku, qty, version FROM staging ON CONFLICT (sku) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`
    : I.lv === 2 ? `INSERT INTO inventory (sku, qty, version) SELECT sku, qty, version FROM staging ON CONFLICT (sku) DO UPDATE SET qty = EXCLUDED.qty, version = EXCLUDED.version WHERE inventory.version < EXCLUDED.version`
      : `INSERT INTO inventory (sku, qty, version) SELECT sku, sum(qty), 1 FROM staging GROUP BY sku ON CONFLICT (sku) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`;
  const upRun = (I, q) => LB.sql.session(async (db) => {
    await db.exec(upSetup(I));
    await db.exec(upRef(I).replace("INSERT INTO inventory ", "INSERT INTO inventory_ref AS inventory ").replace("ON CONFLICT (sku)", "ON CONFLICT (sku)"));
    await db.q(q);
    const d = await diffRows(db, "SELECT sku, qty, version FROM inventory", "SELECT sku, qty, version FROM inventory_ref");
    const n = (await db.q("SELECT count(*)::int AS n FROM inventory")).rows[0].n;
    return { ...d, n };
  });
  S.push({
    id: "pg-upsert",
    name: "Merge a batch with ON CONFLICT",
    kind: "Code review",
    skills: ["design", "safe"],
    w: "code",
    gen(lv, R) { return { lv, feed: R.pick(["warehouse", "supplier", "POS"]), n: R.int(2, 9) }; },
    text: (I) => `<p>The ${esc(I.feed)} sync loads a batch into <code>staging(sku, qty, version)</code> and must apply it to <code>inventory(sku PRIMARY KEY, qty, version, updated_at)</code>. Several sync workers run at once, so check-then-insert in application code races.</p><p>${I.lv === 1 ? "Staging rows are <b>deltas</b>: add <code>qty</code> to an existing SKU, insert new SKUs as they are (version 1)." : I.lv === 2 ? "Staging rows are <b>full snapshots</b> with a version. Apply a row only if its version is <b>newer</b> than the stored one (stale, re-delivered messages must be ignored); new SKUs are inserted as they are." : "Staging rows are <b>deltas</b> (add qty; new SKUs get version 1). This feed batches events, so the same SKU can appear <b>several times</b> in one batch; all of its deltas must be applied."}</p><p>Write <b>one INSERT ... ON CONFLICT</b> statement. The resulting <code>inventory</code> (sku, qty, version) is compared with the reference.</p>`,
    ui: (I) => ({ lang: "sql", rows: 6, ph: "INSERT INTO inventory (...) SELECT ... FROM staging ON CONFLICT (sku) DO ...", liveDelay: 900, live: async (sql) => {
      if (!sql || !sql.trim()) return `<p class="muted small">Write the statement to run it.</p>`;
      const ss = stmtsOf(sql); if (ss.length !== 1 || !/^(insert|with)\b/i.test(ss[0])) return `<p class="lose small">Write a single INSERT statement.</p>`;
      try { const r = await upRun(I, ss[0]); return K.metrics([{ name: "SKUs", value: K.num(r.n), ok: null }, { name: "Rows differing from reference", value: K.num(r.missing), ok: r.missing === 0 }]); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => upRef(I) + ";",
    bad: (I) => I.lv === 1 ? [upRef(I).replace("DO UPDATE SET qty = inventory.qty + EXCLUDED.qty", "DO NOTHING"), upRef(I).replace("inventory.qty + EXCLUDED.qty", "EXCLUDED.qty")] : I.lv === 2 ? [upRef(I).replace(" WHERE inventory.version < EXCLUDED.version", "")] : [upRef({ lv: 1 }), `INSERT INTO inventory (sku, qty, version) SELECT DISTINCT ON (sku) sku, qty, 1 FROM staging ORDER BY sku ON CONFLICT (sku) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty`],
    async accept(I, sql) {
      const ss = stmtsOf(sql); if (ss.length !== 1 || !/^(insert|with)\b/i.test(ss[0])) return "Write a single INSERT ... ON CONFLICT statement: one statement is atomic per row, with no race between check and write.";
      const g = LB.sql.guard(sql); if (g) return g;
      if (!/on\s+conflict/i.test(sql)) return "Use ON CONFLICT so concurrent workers can't both insert the same new SKU.";
      let r; try { r = await upRun(I, ss[0]); } catch (e) { return pgErr(e) + (/second time/.test(String(e.message)) ? " One INSERT can't update the same row twice: combine the duplicate SKUs in the SELECT first." : ""); }
      if (r.missing || r.extra) return `<b>${r.missing}</b> SKU(s) end up different from the reference.${I.lv === 2 ? " Old versions must not overwrite newer data: DO UPDATE accepts a WHERE clause." : I.lv === 1 ? " EXCLUDED is the row you tried to insert; inventory.qty is the existing one." : " Every delta for a SKU must count."}`;
      return true;
    },
    hint: (I) => I.lv === 1 ? "In DO UPDATE, EXCLUDED.qty is the incoming value and inventory.qty the existing one." : I.lv === 2 ? "DO UPDATE SET ... WHERE <condition> skips the update when the condition is false." : "What does Postgres do when one INSERT proposes two rows with the same key? Aggregate in the SELECT.",
    concept: "Upserts with INSERT ... ON CONFLICT",
    how: "INSERT ... ON CONFLICT (key) DO UPDATE is atomic per row: Postgres either inserts or, if a conflicting row exists (or is being inserted concurrently, in which case it waits for that transaction), updates it, so no check-then-insert race. EXCLUDED refers to the row proposed for insertion; the table name refers to the existing row. A WHERE on DO UPDATE makes the update conditional, which is how you ignore stale or out-of-order messages. One statement may not affect the same row twice, so a batch with duplicate keys fails with 'ON CONFLICT DO UPDATE command cannot affect row a second time'; aggregate or de-duplicate in the SELECT first.",
    rule: "Upsert with INSERT ... ON CONFLICT (natural key) DO UPDATE, guard with WHERE existing.version < EXCLUDED.version for idempotent replays, and pre-aggregate batches by key.",
    why: (I) => I.lv === 1 ? "SKUs 300–400 already existed and got their deltas added; the rest were inserted. DO NOTHING or SET qty = EXCLUDED.qty would lose stock counts." : I.lv === 2 ? "Some staged snapshots carry a lower version than the stored row (re-delivered old messages). The WHERE on DO UPDATE ignores them instead of rolling inventory back." : "The batch has up to two deltas per SKU. Inserting them raw fails on the second occurrence; DISTINCT ON silently drops deltas; SUM ... GROUP BY applies them all in one row each.",
  });

  /* ======================= 9. time zones ======================= */
  const tzSetup = `CREATE TABLE stores (id int PRIMARY KEY, name text NOT NULL, tz text NOT NULL);
INSERT INTO stores VALUES (1, 'Brooklyn', 'America/New_York'), (2, 'Berlin Mitte', 'Europe/Berlin'), (3, 'Sydney CBD', 'Australia/Sydney');
CREATE TABLE orders (id bigint PRIMARY KEY, store_id int NOT NULL, created_at timestamptz NOT NULL, total numeric(10,2) NOT NULL);
INSERT INTO orders SELECT g, 1 + g % 3, timestamptz '2026-03-01 00:00Z' + g * interval '9 minutes 50 seconds', 5 + (g * 37) % 120 FROM generate_series(1, 6000) g;`;
  const TZ = { 1: "America/New_York", 2: "Europe/Berlin", 3: "Australia/Sydney" };
  const tzRef = (I) => I.lv === 1
    ? `SELECT (created_at AT TIME ZONE 'America/New_York')::date AS day, count(*) AS orders, sum(total) AS revenue FROM orders WHERE created_at >= timestamptz '${I.from} 00:00 America/New_York' AND created_at < timestamptz '${I.to} 00:00 America/New_York' GROUP BY 1`
    : I.lv === 2
      ? `SELECT s.id AS store_id, (o.created_at AT TIME ZONE s.tz)::date AS day, sum(o.total) AS revenue FROM orders o JOIN stores s ON s.id = o.store_id WHERE (o.created_at AT TIME ZONE s.tz)::date BETWEEN date '${I.from}' AND date '${I.last}' GROUP BY 1, 2`
      : `SELECT s.id AS store_id, date_trunc('week', o.created_at AT TIME ZONE s.tz)::date AS week_start, count(*) AS orders FROM orders o JOIN stores s ON s.id = o.store_id GROUP BY 1, 2`;
  const dayAdd = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  S.push({
    id: "pg-timezone-report",
    name: "Report by the store's local day",
    kind: "Code review",
    skills: ["design", "diagnose"],
    w: "code",
    gen(lv, R) {
      const from = lv === 1 ? `2026-03-0${R.int(5, 7)}` : `2026-${R.pick(["03-26", "03-27", "03-28"])}`;
      const n = lv === 1 ? R.int(3, 4) : R.int(5, 7);
      return { lv, from, to: dayAdd(from, n), last: dayAdd(from, n - 1) };
    },
    text: (I) => `<p>Finance says the daily numbers don't match the tills. <code>orders.created_at</code> is <code>timestamptz</code>; the database session runs in UTC. <code>stores(id, name, tz)</code> holds each store's IANA time zone (New York, Berlin, Sydney). Data runs from 1 March to mid-April 2026, across several daylight-saving changes.</p>
      <p>${I.lv === 1 ? `Write the report for the Brooklyn manager: orders and revenue <b>per local day in America/New_York</b>, for local dates <b>${I.from}</b> up to but not including <b>${I.to}</b>, all stores. Return <code>day (date), orders, revenue</code>.` : I.lv === 2 ? `Return revenue <b>per store per store-local day</b>, for local dates <b>${I.from}</b> through <b>${I.last}</b> (each store's own calendar). Return <code>store_id, day (date), revenue</code>.` : "Return order counts <b>per store per local week</b> (weeks start Monday at local midnight), over all data. Return <code>store_id, week_start (date), orders</code>."}</p><p>Compared with the reference result on real Postgres.</p>`,
    ui: (I) => ({ lang: "sql", rows: 6, ph: "SELECT ... AT TIME ZONE ...", liveDelay: 900, live: cmpLive(cmpRun(tzSetup, tzRef(I))) }),
    solve: (I) => tzRef(I) + ";",
    bad: (I) => I.lv === 1 ? [`SELECT created_at::date AS day, count(*), sum(total) FROM orders WHERE created_at >= date '${I.from}' AND created_at < date '${I.to}' GROUP BY 1`, `SELECT (created_at - interval '5 hours')::date AS day, count(*), sum(total) FROM orders WHERE created_at - interval '5 hours' >= date '${I.from}' AND created_at - interval '5 hours' < date '${I.to}' GROUP BY 1`]
      : I.lv === 2 ? [`SELECT o.store_id, o.created_at::date AS day, sum(o.total) FROM orders o WHERE o.created_at::date BETWEEN date '${I.from}' AND date '${I.last}' GROUP BY 1, 2`]
        : [`SELECT s.id, date_trunc('week', o.created_at, s.tz)::date, count(*) FROM orders o JOIN stores s ON s.id = o.store_id GROUP BY 1, 2`, `SELECT o.store_id, date_trunc('week', o.created_at)::date, count(*) FROM orders o GROUP BY 1, 2`],
    accept: (I, sql) => cmpAccept(cmpRun(tzSetup, tzRef(I)), (I2) => I2.lv === 1 ? "A cast to date (or a fixed offset) uses UTC or a fixed number of hours; New York switched from UTC−5 to UTC−4 on 8 March 2026." : I2.lv === 2 ? "Each store needs its own zone: join stores and convert with AT TIME ZONE s.tz before taking the date." : "Truncate in local time: date_trunc on created_at AT TIME ZONE s.tz. A timestamptz cast to date is taken in the session zone (UTC), which moves Berlin's and Sydney's local midnight to the previous day.")(I, sql),
    hint: (I) => I.lv === 1 ? "timestamptz AT TIME ZONE 'zone' gives the local wall-clock time; take the date of that. Bound the range with local-midnight timestamps." : I.lv === 2 ? "The zone differs per row: join stores and use AT TIME ZONE s.tz." : "Convert to local wall time first, then truncate to the week, then cast to date.",
    concept: "timestamptz, time zones and DST",
    how: "timestamptz stores an absolute instant (internally UTC); it's displayed and cast using the session's TimeZone setting. 'ts AT TIME ZONE zone' converts it to the local wall-clock timestamp in that zone, using the zone's DST rules for that instant, so local days, weeks and hours must be computed on that value. A cast ts::date or date_trunc('day', ts) silently uses the session zone, usually UTC on servers. Fixed offsets (minus 5 hours) break twice a year. A local day isn't always 24 hours, so bound ranges with local midnights converted back to instants (timestamp 'YYYY-MM-DD 00:00' AT TIME ZONE zone) and use half-open intervals.",
    rule: "Store instants as timestamptz, keep each user's or store's IANA zone name, and do calendar math (day, week, month boundaries) only after converting with AT TIME ZONE that zone; never hard-code offsets or rely on the session time zone.",
    why: (I) => I.lv === 1 ? `Orders between local midnight and 05:00 UTC (04:00 after 8 March) belong to the previous New York day; casting in UTC moves them to the wrong day, and a fixed −5 h offset is wrong after the DST switch.` : I.lv === 2 ? `Sydney is UTC+11 (UTC+10 after 5 April), Berlin UTC+1/+2 (switching 29 March): the same instant falls on different local dates per store, so converting with each store's own zone matters.` : "date_trunc(..., created_at, tz) returns a timestamptz for local Monday midnight, but casting that to date happens in UTC: for Berlin and Sydney that's still Sunday. Truncating the local wall-clock timestamp keeps the date local.",
  });

  /* ======================= 10. row-level security ======================= */
  const rlsSetup = (I) => `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lab_app') THEN CREATE ROLE lab_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lab_support') THEN CREATE ROLE lab_support NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lab_owner') THEN CREATE ROLE lab_owner NOLOGIN; END IF;
END $$;
CREATE TABLE invoices (id bigint PRIMARY KEY, tenant_id int NOT NULL, amount numeric(10,2) NOT NULL);
INSERT INTO invoices SELECT g, 1 + g % ${I.tenants}, (g * 13) % 900 FROM generate_series(1, 600) g;
GRANT USAGE ON SCHEMA lab TO lab_app, lab_support, lab_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO lab_app;
GRANT SELECT, INSERT ON invoices TO lab_support;
${I.lv === 3 ? "ALTER TABLE invoices OWNER TO lab_owner;" : ""}`;
  const RLS_APP = (I) => (I.lv === 3 ? "lab_owner" : "lab_app");
  const rlsRef = (I) => I.lv === 1 ? "ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;\nCREATE POLICY tenant_isolation ON invoices USING (tenant_id = current_setting('app.tenant_id')::int);"
    : I.lv === 2 ? "ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;\nCREATE POLICY tenant_isolation ON invoices TO lab_app USING (tenant_id = current_setting('app.tenant_id')::int);\nCREATE POLICY support_read ON invoices FOR SELECT TO lab_support USING (true);"
      : "ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;\nALTER TABLE invoices FORCE ROW LEVEL SECURITY;\nCREATE POLICY tenant_isolation ON invoices USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);";
  const RLS_OK = [/^alter\s+table\s+(lab\.)?invoices\s+(enable|force|disable|no\s+force)\s+row\s+level\s+security$/i, /^(create|drop|alter)\s+policy\b/i];
  // Runs the checks as the application role(s); returns a list of {name, ok, note}
  const rlsRun = (I, sql) => LB.sql.session(async (db) => {
    await db.exec(rlsSetup(I));
    for (const s of stmtsOf(sql)) await db.exec(s);
    const out = [];
    const as = async (role, tenant, fn) => {
      await db.exec(`SET app.tenant_id = '${tenant}'`);
      await db.exec(`SET ROLE ${role}`);
      try { return await fn(); } catch (e) { return { err: String(e.message) }; } finally { await db.exec("RESET ROLE").catch(() => {}); }
    };
    const app = RLS_APP(I), t = I.tenant, other = (I.tenant % I.tenants) + 1;
    const expect = (await db.q(`SELECT count(*)::int AS n FROM invoices WHERE tenant_id = ${t}`)).rows[0].n;
    const r1 = await as(app, t, async () => (await db.q("SELECT count(*)::int AS n, count(*) FILTER (WHERE tenant_id <> " + t + ")::int AS leak FROM invoices")).rows[0]);
    out.push({ name: `${app} as tenant ${t} sees`, ok: !r1.err && r1.n === expect && r1.leak === 0, note: r1.err ? "error: " + r1.err : `${r1.n} rows (${r1.leak} from other tenants; expected ${expect})` });
    if (I.lv >= 2) {
      const r2 = await as(app, t, async () => { await db.q(`INSERT INTO invoices VALUES (900001, ${other}, 1)`); return { ok: true }; });
      out.push({ name: `${app} inserts a row for tenant ${other}`, ok: !!r2.err && /row-level security/.test(r2.err), note: r2.err ? "rejected" : "allowed!" });
    }
    if (I.lv === 2) {
      const r3 = await as("lab_support", "", async () => (await db.q("SELECT count(*)::int AS n FROM invoices")).rows[0]);
      out.push({ name: "lab_support (no tenant set) sees", ok: !r3.err && r3.n === 600, note: r3.err ? "error: " + r3.err : `${r3.n} of 600 rows` });
      const r4 = await as("lab_support", "", async () => { await db.q(`INSERT INTO invoices VALUES (900002, ${t}, 1)`); return { ok: true }; });
      out.push({ name: "lab_support inserts a row", ok: !!r4.err, note: r4.err ? "rejected" : "allowed!" });
    }
    if (I.lv === 3) {
      const r5 = await as(app, "", async () => (await db.q("SELECT count(*)::int AS n FROM invoices")).rows[0]);
      out.push({ name: `${app} with app.tenant_id unset ('') sees`, ok: !r5.err && r5.n === 0, note: r5.err ? "error: " + r5.err : `${r5.n} rows` });
    }
    return out;
  });
  const rlsHTML = (out) => K.table(["Check", "Result", ""], out.map((c) => [esc(c.name), esc(c.note), c.ok ? '<span class="win">✓</span>' : '<span class="lose">✗</span>']), { compact: true });
  S.push({
    id: "pg-row-level-security",
    name: "Isolate tenants with row-level security",
    kind: "Hardening",
    skills: ["safe", "design"],
    w: "code",
    gen(lv, R) { const tenants = R.int(4, 9); return { lv, tenants, tenant: R.int(1, tenants) }; },
    text: (I) => `<p>A SaaS app stores all tenants in one <code>invoices(id, tenant_id, amount)</code> table. After a bug leaked one customer's invoices to another, the team wants the database to enforce isolation. Each request runs <code>SET app.tenant_id = '&lt;id&gt;'</code> on its pooled connection.</p>
      <p>${I.lv === 1 ? "The app connects as role <code>lab_app</code>. Make every query by lab_app see only the current tenant's rows." : I.lv === 2 ? "The app connects as <code>lab_app</code> and must see and write only the current tenant's rows. The support tool connects as <code>lab_support</code>, never sets a tenant, and must be able to <b>read every tenant but write nothing</b>." : "The app connects as <code>lab_owner</code>, the role that ran the migrations and <b>owns</b> the table. It must see and write only the current tenant's rows, and a request that forgot to set the tenant (the setting is then an empty string) must see <b>zero rows, not an error</b>."}</p>
      <p>Write the statements (<code>ALTER TABLE ... ROW LEVEL SECURITY</code>, <code>CREATE POLICY</code>). They're checked on real Postgres by switching to those roles.</p>`,
    ui: (I) => ({ lang: "sql", rows: 6, ph: "ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;\nCREATE POLICY ...", liveDelay: 900, live: async (sql) => {
      const has = sql && sql.trim();
      const bad = has ? allowOnly(sql, RLS_OK, "ROW LEVEL SECURITY and POLICY statements") : null; if (bad) return `<p class="lose small">${bad}</p>`;
      try { return (has ? "" : `<p class="muted small">Without any policy:</p>`) + rlsHTML(await rlsRun(I, has ? sql : "")); } catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => rlsRef(I),
    bad: (I) => I.lv === 1 ? ["CREATE POLICY tenant_isolation ON invoices USING (tenant_id = current_setting('app.tenant_id')::int);"] : I.lv === 2 ? [rlsRef({ lv: 1 }), rlsRef({ lv: 1 }) + "\nCREATE POLICY support_read ON invoices TO lab_support USING (true);"] : [rlsRef({ lv: 1 }), rlsRef(I).replace("nullif(current_setting('app.tenant_id', true), '')::int", "current_setting('app.tenant_id')::int")],
    async accept(I, sql) {
      const bad = allowOnly(sql, RLS_OK, "ROW LEVEL SECURITY and POLICY statements"); if (bad) return bad;
      let out; try { out = await rlsRun(I, sql); } catch (e) { return pgErr(e); }
      const f = out.find((c) => !c.ok);
      if (f) return `Check failed: <b>${esc(f.name)}</b>: ${esc(f.note)}.${/sees/.test(f.name) && /600|rows \(/.test(f.note) && I.lv === 3 ? " Table owners bypass RLS unless the table is set to FORCE ROW LEVEL SECURITY." : /support/.test(f.name) && /error/.test(f.note) ? " Policies apply to PUBLIC unless you say TO role; the tenant policy is evaluated for support too, and its setting is empty." : /inserts/.test(f.name) ? " A policy without FOR applies to all commands; for INSERT its USING expression doubles as WITH CHECK, but only for the roles it applies to." : ""}`;
      return true;
    },
    hint: (I) => I.lv === 1 ? "A policy does nothing until row level security is enabled on the table." : I.lv === 2 ? "Policies can be limited to a role (TO ...) and to a command (FOR SELECT). Permissive policies for the same role are OR-ed." : "Owners bypass row security unless you FORCE it. current_setting(name, true) returns NULL instead of erroring for an unknown setting, but a setting that was set and reset is an empty string.",
    concept: "Row-level security",
    how: "ALTER TABLE ... ENABLE ROW LEVEL SECURITY makes Postgres add each applicable policy's USING expression to every query on the table (rows not passing are invisible) and its WITH CHECK expression to new or updated rows (a policy for ALL commands uses USING as the check when WITH CHECK is omitted). With RLS enabled and no policy for a role, that role sees nothing. Policies apply to PUBLIC unless TO names roles, and permissive policies for the same role are combined with OR. Superusers, roles with BYPASSRLS and the table owner bypass RLS; FORCE ROW LEVEL SECURITY makes it apply to the owner too. Policies that read a session setting are a common way to pass the tenant from a pooled connection.",
    rule: "Enforce multi-tenancy in the database: ENABLE and FORCE row level security, scope each policy with TO role and FOR command, make a missing tenant mean zero rows (nullif(current_setting('app.tenant_id', true), '')), and never let the app connect as a superuser or BYPASSRLS role.",
    why: (I) => I.lv === 1 ? `With RLS enabled, lab_app's queries get <code>tenant_id = current_setting('app.tenant_id')::int</code> added, so tenant ${I.tenant} sees only its own rows. Creating a policy without enabling RLS does nothing.` : I.lv === 2 ? "Scoping the tenant policy TO lab_app means it isn't evaluated for support; support gets a SELECT-only policy, so its INSERT finds no applicable policy and is rejected." : "The app role owns the table, and owners bypass RLS by default: FORCE fixes that. nullif(current_setting(..., true), '') turns a missing or reset tenant into NULL, and tenant_id = NULL matches nothing instead of failing every request with an invalid integer.",
  });

  /* ======================= 11. retention with partitions ======================= */
  const MONTHS = ["2025_07", "2025_08", "2025_09", "2025_10", "2025_11", "2025_12", "2026_01", "2026_02", "2026_03"];
  const mStart = (m) => m.replace("_", "-") + "-01";
  const partSetup = `CREATE TABLE events (id bigint NOT NULL, ts timestamptz NOT NULL, kind text NOT NULL) PARTITION BY RANGE (ts);
${MONTHS.map((m, i) => `CREATE TABLE events_${m} PARTITION OF events FOR VALUES FROM ('${mStart(m)}') TO ('${i + 1 < MONTHS.length ? mStart(MONTHS[i + 1]) : "2026-04-01"}');`).join("\n")}
INSERT INTO events SELECT g, timestamptz '2025-07-01' + g * interval '23 minutes', (ARRAY['view','click','buy'])[1 + g % 3] FROM generate_series(1, 17000) g WHERE timestamptz '2025-07-01' + g * interval '23 minutes' < timestamptz '2026-04-01';`;
  const partRef = (I) => {
    const old = MONTHS.slice(0, I.keepFrom);
    if (I.lv === 1) return old.map((m) => `DROP TABLE events_${m};`).join("\n");
    if (I.lv === 2) return old.map((m) => `ALTER TABLE events DETACH PARTITION events_${m} CONCURRENTLY;`).join("\n") + "\nCREATE TABLE events_2026_04 PARTITION OF events FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');";
    return old.map((m) => `DROP TABLE events_${m};`).join("\n") + `\nDELETE FROM events_${MONTHS[I.keepFrom]} WHERE ts < timestamptz '${I.cut}';`;
  };
  const PART_OK = [/^drop\s+table\b/i, /^alter\s+table\b/i, /^create\s+table\b/i, /^delete\s+from\b/i, /^truncate\b/i];
  const partRun = (I, sql) => LB.sql.session(async (db) => {
    await db.exec(partSetup);
    const cut = I.lv === 3 ? I.cut : mStart(MONTHS[I.keepFrom]);
    const keep = (await db.q(`SELECT count(*)::int AS n FROM events WHERE ts >= timestamptz '${cut}'`)).rows[0].n;
    const old = (await db.q(`SELECT count(*)::int AS n FROM events WHERE ts < timestamptz '${cut}'`)).rows[0].n;
    let deleted = 0;
    for (const s of stmtsOf(sql)) { const r = await db.raw.query(s); if (/^delete/i.test(s)) deleted += r.affectedRows || 0; }
    const now = (await db.q("SELECT count(*)::int AS n, count(*) FILTER (WHERE ts < timestamptz '" + cut + "')::int AS old FROM events")).rows[0];
    const parts = (await db.q("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'events'::regclass ORDER BY 1")).rows.map((r) => r.relname);
    const tables = (await db.q("SELECT relname FROM pg_class WHERE relnamespace = 'lab'::regnamespace AND relkind IN ('r', 'p') ORDER BY 1")).rows.map((r) => r.relname);
    let april = true;
    if (I.lv === 2) { try { await db.exec("INSERT INTO events VALUES (99999999, timestamptz '2026-04-02 10:00Z', 'view')"); } catch (e) { april = false; } }
    const archived = {};
    if (I.lv === 2) for (const m of MONTHS.slice(0, I.keepFrom)) { const t = "events_" + m; archived[t] = tables.includes(t) ? (await db.q(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n : -1; }
    return { keep, old, deleted, now, parts, tables, april, archived, cut };
  });
  const partVerdict = (I, r) => {
    if (r.now.n !== r.keep || r.now.old !== 0) return `<code>events</code> now has ${K.num(r.now.n)} rows, ${K.num(r.now.old)} of them before ${esc(r.cut)}; it should have exactly ${K.num(r.keep)}, none older.`;
    const oldParts = MONTHS.slice(0, I.keepFrom).map((m) => "events_" + m).filter((t) => r.parts.includes(t));
    if (oldParts.length) return `The old data is gone but <code>${esc(oldParts.join(", "))}</code> ${oldParts.length > 1 ? "are" : "is"} still attached and empty: you deleted rows instead of removing partitions.`;
    if (I.lv === 2) {
      const lost = Object.entries(r.archived).filter(([, n]) => n <= 0).map(([t]) => t);
      if (lost.length) return `Compliance needs the old months archived, but <code>${esc(lost.join(", "))}</code> ${lost.length > 1 ? "are" : "is"} gone or empty. Detach, don't drop.`;
      if (!r.april) return "Tomorrow's inserts fail: there is no partition for April 2026 (and no default partition), so <code>INSERT</code> errors with 'no partition of relation \"events\" found for row'.";
    }
    const allowed = I.lv === 3 ? r.boundary : 0;
    if (r.deleted > allowed) return `You deleted ${K.num(r.deleted)} rows one by one${allowed ? ` (only ${K.num(allowed)} rows sit before the cut-off inside a partition you must keep)` : ""}. On the real 4 TB table that's hours of WAL, replication lag and dead tuples for VACUUM, when removing whole partitions is instant.`;
    return true;
  };
  S.push({
    id: "pg-partition-retention",
    name: "Enforce retention on a partitioned table",
    kind: "Change plan",
    skills: ["safe", "design"],
    w: "code",
    gen(lv, R) { const keepFrom = R.int(2, 4); return { lv, keepFrom, cut: `${mStart(MONTHS[keepFrom]).slice(0, 8)}${String(R.int(8, 22)).padStart(2, "0")}` }; },
    text: (I) => `<p><code>events</code> is range-partitioned by month on <code>ts</code> (<code>events_2025_07</code> … <code>events_2026_03</code>); in production it's 4 TB and takes 20k inserts/s. ${I.lv === 1 ? `The retention policy changed: delete everything before <b>${mStart(MONTHS[I.keepFrom])}</b>.` : I.lv === 2 ? `Compliance needs everything before <b>${mStart(MONTHS[I.keepFrom])}</b> out of the live table but <b>kept</b> as standalone tables for the archive job (nothing may be deleted). Also, it's 31 March: make sure tomorrow's inserts have somewhere to go.` : `The new retention policy keeps data from <b>${I.cut}</b> (UTC) on; nothing older may remain, and nothing newer may be lost.`}</p>
      <p>Write the statements. A real Postgres runs them one by one (so <code>DETACH ... CONCURRENTLY</code> works) on a 17,000-row sample and checks the result.</p>`,
    ui: (I) => ({ lang: "sql", rows: 7, ph: "DROP TABLE ... / ALTER TABLE events DETACH PARTITION ...", liveDelay: 900, live: async (sql) => {
      const has = sql && sql.trim();
      const bad = has ? allowOnly(sql, PART_OK, "DROP/ALTER/CREATE TABLE, DELETE and TRUNCATE statements") : null; if (bad) return `<p class="lose small">${bad}</p>`;
      try { const r = await partRun(I, has ? sql : ""); r.boundary = I.lv === 3 ? await partBoundary(I) : 0; const v = has ? partVerdict(I, r) : null; return K.metrics([{ name: "Rows in events", value: K.num(r.now.n), ok: r.now.n === r.keep, target: `want ${K.num(r.keep)}` }, { name: "Rows deleted by DELETE", value: K.num(r.deleted), ok: null }, { name: "Attached partitions", value: String(r.parts.length), ok: null }]) + `<div class="mono small">${esc(r.parts.join("  "))}</div>` + (has ? K.verdict(v === true, v === true ? "Retention done." : v) : ""); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => partRef(I),
    bad: (I) => I.lv === 1 ? [`DELETE FROM events WHERE ts < timestamptz '${mStart(MONTHS[I.keepFrom])}';`] : I.lv === 2 ? [MONTHS.slice(0, I.keepFrom).map((m) => `ALTER TABLE events DETACH PARTITION events_${m};`).join("\n"), partRef({ ...I, lv: 1 }) + "\nCREATE TABLE events_2026_04 PARTITION OF events FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');"] : [`DELETE FROM events WHERE ts < timestamptz '${I.cut}';`, partRef({ ...I, lv: 1 })],
    async accept(I, sql) {
      const bad = allowOnly(sql, PART_OK, "DROP/ALTER/CREATE TABLE, DELETE and TRUNCATE statements"); if (bad) return bad;
      let r; try { r = await partRun(I, sql); r.boundary = I.lv === 3 ? await partBoundary(I) : 0; } catch (e) { return pgErr(e); }
      return partVerdict(I, r);
    },
    hint: (I) => I.lv === 1 ? "A whole month is a whole table. What's the cheapest way to make a table's rows disappear?" : I.lv === 2 ? "DETACH PARTITION turns a partition into a normal table. Is there a version that doesn't block queries on the parent?" : "The cut-off falls inside a partition: remove the whole months before it, and delete only the leftover rows in that one partition.",
    concept: "Partition-based retention",
    how: "Deleting old rows from a big table writes WAL for every row, leaves dead tuples that VACUUM must clean up, bloats indexes and adds replication lag. With range partitioning by time, removing a month is DROP TABLE on that partition (or DETACH PARTITION to keep it as a standalone table for archiving), which is a catalog change: instant, no per-row WAL, no bloat. DETACH ... CONCURRENTLY (PG14+) avoids taking an ACCESS EXCLUSIVE lock on the parent, so queries keep running; it can't run inside a transaction block. Inserts for a range with no partition fail, so create future partitions ahead of time (a scheduled job or pg_partman).",
    rule: "Partition big time-series tables by time, enforce retention by dropping or detaching whole partitions, align retention to partition boundaries where you can, and always pre-create the next partitions.",
    why: (I) => I.lv === 1 ? `Dropping ${I.keepFrom} monthly partitions removes those rows with a catalog change. The equivalent DELETE would have to rewrite every row's visibility, write WAL for each and leave the space for VACUUM.` : I.lv === 2 ? "DETACH ... CONCURRENTLY keeps the old months as ordinary tables for the archive job without blocking traffic on events, and creating events_2026_04 now prevents tomorrow's inserts from failing." : `Whole months before ${I.cut.slice(0, 7)} were dropped; only the ${I.cut.slice(8)} leading days of the boundary partition needed a DELETE, touching a few hundred rows instead of months of data.`,
  });
  const partBoundary = (I) => LB.sql.session(async (db) => { await db.exec(partSetup); return (await db.q(`SELECT count(*)::int AS n FROM events_${MONTHS[I.keepFrom]} WHERE ts < timestamptz '${I.cut}'`)).rows[0].n; });

  /* ======================= 12. sargable predicates ======================= */
  const sgSetup = `CREATE TABLE orders (id bigint PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL, total numeric(10,2) NOT NULL);
INSERT INTO orders SELECT g, (g * 7919) % 1000, (ARRAY['paid','pending','refunded','paid'])[1 + g % 4], timestamptz '2026-01-01' + g * interval '97 seconds', ((g * 37) % 50000) / 100.0 FROM generate_series(1, 30000) g;
CREATE INDEX orders_created ON orders (created_at);
CREATE INDEX orders_status_created ON orders (status, created_at);
CREATE INDEX orders_customer_created ON orders (customer_id, created_at);`;
  const sgSlow = (I) => I.lv === 1 ? `SELECT id, total FROM orders WHERE created_at::date = date '2026-01-${String(I.d).padStart(2, "0")}'`
    : I.lv === 2 ? `SELECT id, total FROM orders WHERE status = 'refunded' AND date_trunc('week', created_at) = timestamptz '${I.wk}'`
      : `SELECT id, created_at, total FROM orders WHERE customer_id::bigint = ${I.c} AND created_at + interval '7 days' >= timestamptz '2026-01-${String(I.d).padStart(2, "0")}'`;
  const sgFast = (I) => I.lv === 1 ? `SELECT id, total FROM orders WHERE created_at >= timestamptz '2026-01-${String(I.d).padStart(2, "0")}' AND created_at < timestamptz '2026-01-${String(I.d + 1).padStart(2, "0")}'`
    : I.lv === 2 ? `SELECT id, total FROM orders WHERE status = 'refunded' AND created_at >= timestamptz '${I.wk}' AND created_at < timestamptz '${dayAdd(I.wk, 7)}'`
      : `SELECT id, created_at, total FROM orders WHERE customer_id = ${I.c} AND created_at >= timestamptz '2026-01-${String(I.d).padStart(2, "0")}' - interval '7 days'`;
  const SGB = { 1: 20, 2: 90, 3: 22 };
  const sgRun = (I, q) => LB.sql.session(async (db) => {
    await db.exec(sgSetup); await db.exec("VACUUM ANALYZE orders");
    const d = await diffRows(db, q, sgSlow(I));
    const plan = await explain(db, q);
    return { ...d, plan };
  });
  S.push({
    id: "pg-sargable-rewrite",
    name: "Rewrite the query so the index applies",
    kind: "Code review",
    skills: ["tune", "diagnose"],
    w: "code",
    gen(lv, R) { return { lv, d: lv === 3 ? R.int(25, 31) : R.int(10, 27), wk: dayAdd("2026-01-05", 7 * R.int(0, 3)), c: R.int(1, 999) }; },
    text: (I) => `<p>${I.lv === 1 ? "A report runs this hundreds of times a day and always does a sequential scan, even though <code>orders (created_at)</code> is indexed:" : I.lv === 2 ? "The refunds dashboard is slow. There's an index on <code>orders (status, created_at)</code>:" : "The 'recent orders' widget for one customer scans the whole table. There's an index on <code>orders (customer_id, created_at)</code>, and the ORM generated this:"}</p>${K.pre(sgSlow(I))}
      <p>Rewrite the query (no new indexes) so it returns <b>exactly the same rows</b> and touches at most <b>${SGB[I.lv]}</b> buffers. The table has 30,000 rows; the session time zone is UTC.</p>`,
    ui: (I) => ({ lang: "sql", rows: 4, starter: sgSlow(I), liveDelay: 900, live: async (sql) => {
      if (!sql || !sql.trim()) return "";
      const o = oneQuery(sql); if (o.err) return `<p class="lose small">${o.err}</p>`;
      try { const r = await sgRun(I, o.q); return planBox(r.plan, { budget: SGB[I.lv], more: [{ name: "Same rows as original", value: r.missing || r.extra ? `no (${r.missing} missing, ${r.extra} extra)` : "yes", ok: !(r.missing || r.extra) }] }); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => sgFast(I) + ";",
    bad: (I) => I.lv === 1 ? [sgSlow(I), `SELECT id, total FROM orders WHERE date_trunc('day', created_at) = timestamptz '2026-01-${String(I.d).padStart(2, "0")}'`] : I.lv === 2 ? [sgSlow(I)] : [sgSlow(I).replace("customer_id::bigint", "customer_id"), sgSlow(I)],
    async accept(I, sql) {
      const o = oneQuery(sql); if (o.err) return o.err;
      let r; try { r = await sgRun(I, o.q); } catch (e) { return pgErr(e); }
      if (r.missing || r.extra) return `Not the same result: ${r.missing} row(s) missing, ${r.extra} extra.${I.lv === 1 ? " BETWEEN includes both ends: an order at exactly midnight of the next day would count twice across reports. Use a half-open range." : ""}`;
      const b = bufsOf(r.plan);
      if (b > SGB[I.lv]) return `Same rows, but <code>${esc(LB.sql.planLine(r.plan))}</code> touched <b>${b}</b> buffers (budget ${SGB[I.lv]}).${I.lv === 3 ? " Both conditions must be index-friendly: the bare column on one side, constants on the other." : " The index can't be used while the column is wrapped in a function or cast."}`;
      return true;
    },
    hint: (I) => I.lv === 1 ? "Express 'that calendar day' as a half-open range on the raw column." : I.lv === 2 ? "date_trunc on the column hides it from the index; a week is also a range." : "Two problems: a cast on the indexed column, and arithmetic on the indexed column. Move everything to the constant side.",
    concept: "Sargable predicates",
    how: "An index on column c can serve conditions of the form c <op> constant-expression. Wrapping the column (c::date, date_trunc('month', c), lower(c), c + interval, c::bigint) turns it into an expression the index doesn't contain, so Postgres must evaluate it for every row: a sequential scan. Rewrite to move the computation to the constant side (c >= x AND c < y) or index the exact expression. Casting an int column to bigint to compare with a bigint parameter is a classic ORM trap; casting the parameter instead is fine. Prefer half-open ranges [start, next_start) over BETWEEN for timestamps, so boundaries are never counted twice.",
    rule: "Keep indexed columns bare in WHERE clauses: compute on the constant side, use half-open ranges for dates and times, and check EXPLAIN when an ORM generates casts.",
    why: (I) => I.lv === 1 ? "created_at::date is computed per row, so the index on created_at is useless. A half-open range on created_at selects the same day and walks a slice of the index." : I.lv === 2 ? "With date_trunc on created_at, only the status part of the (status, created_at) index can be used, which still covers a quarter of the table. A week range uses both columns." : `customer_id::bigint stops the (customer_id, created_at) index from being used at all, and created_at + 7 days hides the second column. Comparing the bare columns lets Postgres seek to customer ${I.c} and the date in one step.`,
  });

  /* ======================= 13. HOT updates and fillfactor (tune, real SQL) ======================= */
  const hotRun = (I, cfg) => LB.sql.session(async (db) => {
    const t = "sessions";
    await db.exec(`CREATE TABLE ${t} (id int PRIMARY KEY, user_id int NOT NULL, last_seen timestamptz NOT NULL, hits int NOT NULL, agent text NOT NULL) WITH (fillfactor = ${+cfg.ff});
INSERT INTO ${t} SELECT g, g % 900, timestamptz '2026-05-01' + g * interval '1 second', 0, 'Mozilla/5.0 ' || md5(g::text) FROM generate_series(1, ${I.rows}) g;
${cfg.seen === "btree" ? `CREATE INDEX ON ${t} (last_seen);` : cfg.seen === "brin" ? `CREATE INDEX ON ${t} USING brin (last_seen);` : ""}
${cfg.user === "include" ? `CREATE INDEX ON ${t} (user_id) INCLUDE (hits);` : `CREATE INDEX ON ${t} (user_id);`}`);
    for (let r = 1; r <= 3; r++) await db.exec(`UPDATE ${t} SET last_seen = last_seen + interval '1 hour', hits = hits + 1 WHERE id % 3 = ${r % 3}`);
    for (let r = 1; r <= 3; r++) await db.exec(`UPDATE ${t} SET last_seen = last_seen + interval '1 hour', hits = hits + 1 WHERE id % 3 = ${(r + 1) % 3}`);
    await db.q("SELECT pg_stat_force_next_flush()");
    const s = (await db.q(`SELECT n_tup_upd::int AS upd, n_tup_hot_upd::int AS hot, (pg_relation_size('${t}') / 8192)::int AS heap, (pg_indexes_size('${t}') / 8192)::int AS idx FROM pg_stat_user_tables WHERE relname = '${t}'`)).rows[0];
    return { ...s, ratio: s.upd ? s.hot / s.upd : 0, pages: s.heap + s.idx };
  });
  const hotKnobs = (I) => [
    { k: "ff", label: "fillfactor", opts: [100, 90, 80, 70, 50], unit: "%", help: "how full INSERTs pack each heap page" },
    { k: "seen", label: "Index on last_seen", opts: I.lv === 1 ? ["btree", "none"] : ["btree", "brin"], help: I.lv === 1 ? "pg_stat_user_indexes: idx_scan = 0 since the stats reset 90 days ago" : "the 'active in the last 5 minutes' dashboard filters on a last_seen range" },
    ...(I.lv === 3 ? [{ k: "user", label: "Index on user_id", opts: ["include", "plain"], fmt: (v) => (v === "include" ? "(user_id) INCLUDE (hits)" : "(user_id)"), help: "INCLUDE (hits) was added so a monthly report could do an index-only scan" }] : []),
  ];
  const hotDefault = (I) => ({ ff: 100, seen: "btree", user: I.lv === 3 ? "include" : "plain" });
  const hotSol = (I) => ({ ff: 70, seen: I.lv === 1 ? "none" : "brin", user: "plain" });
  const hotVerdict = async (I, cfg) => {
    const c = { ...hotDefault(I), ...cfg };
    const r = await hotRun(I, c);
    if (r.ratio < 0.95) return { r, msg: `Only <b>${K.pct(r.ratio, 0)}</b> of updates were HOT (target 95%).${c.seen === "btree" ? " The updated column last_seen is in a B-tree index, so every update needs new index entries." : c.user === "include" ? " hits is updated on every request and sits in an index (INCLUDE columns count)." : " Pages are too full to hold the new row version on the same page."}` };
    const best = await hotRun(I, hotSol(I));
    if (r.pages > best.pages * 1.03) return { r, msg: `Every update is HOT, but the table and its indexes end up at <b>${r.pages}</b> pages; <b>${best.pages}</b> is achievable. Lower fillfactor leaves room for updates; too low just wastes space.` };
    return { r, msg: true };
  };
  S.push({
    id: "pg-hot-updates",
    name: "Make the hot table's updates HOT",
    kind: "Config change",
    skills: ["tune", "diagnose"],
    w: "tune",
    gen(lv, R) { return { lv, rows: R.pick([3000, 3500, 4000]), qps: R.int(8, 30) * 1000 }; },
    text: (I) => `<p><code>sessions</code> takes <b>${K.num(I.qps)} updates/s</b> (<code>SET last_seen = now(), hits = hits + 1</code>), and its indexes keep bloating: WAL volume is 3× what the team expected and autovacuum never finishes.</p>
      <p>Choose the table and index settings. The live panel runs the real workload (every row updated twice) on Postgres and reads <code>n_tup_hot_upd</code> from <code>pg_stat_user_tables</code>. Pass with <b>≥ 95% HOT updates</b> and the <b>smallest total size</b> (heap + indexes) after the workload.${I.lv > 1 ? " The dashboard query on last_seen must keep an index." : ""}</p>`,
    ui: (I) => ({ knobs: hotKnobs(I), init: hotDefault(I), liveDelay: 600, live: async (cfg) => {
      try { const r = await hotRun(I, { ...hotDefault(I), ...(cfg || {}) }); return K.metrics([{ name: "HOT updates", value: `${K.num(r.hot)} / ${K.num(r.upd)}`, ok: r.ratio >= 0.95, target: "≥ 95%" }, { name: "Heap pages", value: K.num(r.heap), ok: null }, { name: "Index pages", value: K.num(r.idx), ok: null }, { name: "Total", value: K.num(r.pages), ok: null, target: "smaller is better" }]); }
      catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => hotSol(I),
    bad: (I) => [hotDefault(I), { ...hotSol(I), ff: 100 }, { ...hotSol(I), ff: 50 }, ...(I.lv > 1 ? [{ ...hotSol(I), seen: "btree" }] : []), ...(I.lv === 3 ? [{ ...hotSol(I), user: "include" }] : [])],
    async accept(I, cfg) { try { return (await hotVerdict(I, cfg)).msg; } catch (e) { return pgErr(e); } },
    hint: (I) => I.lv === 1 ? "A HOT update needs two things: no indexed column changes, and free space on the same page." : I.lv === 2 ? "Since Postgres 16, some index types don't block HOT updates because they summarise ranges of pages rather than pointing at row versions." : "Columns in INCLUDE are stored in the index too.",
    concept: "HOT updates and fillfactor",
    how: "Postgres never updates a row in place: an UPDATE writes a new row version. If no indexed column changed and the new version fits on the same heap page, it's a Heap-Only Tuple (HOT) update: indexes aren't touched, and the old version can be pruned during normal page access without VACUUM. Otherwise every index gets a new entry, which bloats indexes and multiplies WAL. fillfactor below 100 leaves free space on each page for future versions. Any indexed column blocks HOT, including INCLUDE columns and expression/partial index inputs; since PG16, 'summarizing' indexes such as BRIN don't block it.",
    rule: "For update-heavy tables, check n_tup_hot_upd / n_tup_upd: drop unused indexes on frequently updated columns, keep hot counters out of indexes (including INCLUDE), and lower fillfactor (70–90) so new versions fit on the same page.",
    why: (I, sol) => I.lv === 1 ? "The last_seen index had no scans in 90 days; dropping it makes the columns being updated unindexed, and fillfactor 70 leaves room on each page, so every update is HOT and pruning keeps the table compact." : I.lv === 2 ? "A BRIN index on last_seen still serves the range query (rows are roughly in last_seen order) but, being a summarizing index, doesn't block HOT. fillfactor 70 gives the new versions room on the page." : `Even with BRIN on last_seen, <code>INCLUDE (hits)</code> put the counter into a B-tree, so every update touched it. Dropping the INCLUDE (the monthly report can afford a heap visit) plus fillfactor ${sol.ff} makes the updates HOT.`,
  });

  /* ======================= 14. work_mem and sorts spilling to disk (tune, real SQL) ======================= */
  const wmSetup = `CREATE TABLE orders (id bigint PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL, total numeric(10,2) NOT NULL, note text);
INSERT INTO orders SELECT g, (g * 7919) % 1000, (ARRAY['paid','pending','refunded','paid'])[1 + g % 4], timestamptz '2026-01-01' + g * interval '97 seconds', ((g * 37) % 50000) / 100.0, 'note ' || md5(g::text) FROM generate_series(1, 30000) g;`;
  const WMQ = {
    narrow: { q: "SELECT id, customer_id, total FROM orders ORDER BY total DESC, id", need: "2MB", nodes: 1 },
    agg: { q: "SELECT customer_id, created_at::date AS day, count(*) AS n, sum(total) AS revenue FROM orders GROUP BY 1, 2 ORDER BY revenue DESC", need: "6MB", nodes: 2 },
    wide: { q: "SELECT * FROM orders ORDER BY created_at DESC", need: "4MB", nodes: 1 },
  };
  const WM_OPTS = ["1MB", "2MB", "3MB", "4MB", "6MB", "8MB", "16MB", "64MB"];
  const mb = (v) => parseInt(v, 10);
  const wmRun = (I, wm) => LB.sql.session(async (db) => {
    await db.exec(wmSetup); await db.exec("VACUUM ANALYZE orders");
    await db.exec(`SET work_mem = '${wm}'`);
    const plan = await explain(db, WMQ[I.q].q);
    const spills = LB.sql.nodes(plan).filter((n) => n["Sort Space Type"] === "Disk" || (n["HashAgg Batches"] || 1) > 1 || (n["Disk Usage"] || 0) > 0).map((n) => n["Node Type"] + (n["Sort Method"] ? ` (${n["Sort Method"]}, ${n["Sort Space Used"]} kB on disk)` : n["HashAgg Batches"] > 1 ? ` (hash aggregate, ${n["HashAgg Batches"]} batches, ${n["Disk Usage"] || 0} kB on disk)` : ""));
    return { plan, spills };
  });
  const SCOPES = { conf: "postgresql.conf (every session)", role: "ALTER ROLE reporting SET work_mem", local: "SET LOCAL inside the export transaction" };
  const wmMem = (I, cfg) => mb(cfg.wm) * WMQ[I.q].nodes * (cfg.scope === "conf" ? I.maxc : cfg.scope === "role" ? I.repc : 1) * (WMQ[I.q].nodes > 1 ? 1.5 : 1);
  S.push({
    id: "pg-work-mem-spill",
    name: "Stop the export sorting on disk",
    kind: "Config change",
    skills: ["tune", "safe"],
    w: "tune",
    gen(lv, R) { return { lv, q: lv === 1 ? R.pick(["narrow", "wide"]) : lv === 2 ? "agg" : "wide", maxc: lv === 3 ? R.pick([800, 1000]) : 300, repc: R.pick([4, 6, 8]), head: lv === 3 ? R.pick([2, 3]) * 1024 : 8 * 1024 }; },
    text: (I) => `<p>The nightly CSV export runs this query and is slow; <code>log_temp_files</code> shows it writing temp files every night:</p>${K.pre(WMQ[I.q].q)}
      <p>Pick the <b>smallest work_mem</b> that keeps every sort${I.q === "agg" ? " and hash aggregate" : ""} in memory${I.lv === 3 ? `, and where to set it. The server has <code>max_connections = ${I.maxc}</code>, the reporting role has a pool of ${I.repc}, and there is about <b>${K.num(I.head / 1024)} GB</b> of RAM to spare: the worst case (every connection running such a query at once) must fit` : ""}. The live panel runs the real query on Postgres (a 30,000-row sample, scaled so it behaves like production) with your setting.</p>`,
    ui: (I) => ({ knobs: [{ k: "wm", label: "work_mem", opts: WM_OPTS, help: "per sort/hash operation, per query, per connection" }, ...(I.lv === 3 ? [{ k: "scope", label: "Where to set it", opts: ["conf", "role", "local"], fmt: (v) => SCOPES[v], select: true }] : [])], init: { wm: "1MB", scope: "conf" }, liveDelay: 500, live: async (cfg) => {
      const c = { wm: "1MB", scope: I.lv === 3 ? "conf" : "local", ...(cfg || {}) };
      try {
        const r = await wmRun(I, c.wm), mem = wmMem(I, c);
        return `<div class="mono small">${esc(LB.sql.planLine(r.plan))}</div>` + K.metrics([{ name: "Operations spilling to disk", value: r.spills.length ? esc(r.spills.join("; ")) : "none", ok: !r.spills.length }, { name: "Query time", value: K.ms(r.plan["Actual Total Time"]), ok: null }, ...(I.lv === 3 ? [{ name: "Worst-case work_mem use", value: mem >= 1024 ? K.num(mem / 1024, 1) + " GB" : K.num(mem) + " MB", ok: mem <= I.head, target: `spare ${K.num(I.head / 1024)} GB` }] : [])]);
      } catch (e) { return `<p class="lose small">${pgErr(e)}</p>`; }
    } }),
    solve: (I) => ({ wm: WMQ[I.q].need, ...(I.lv === 3 ? { scope: "role" } : {}) }),
    bad: (I) => [{ wm: "1MB", ...(I.lv === 3 ? { scope: "role" } : {}) }, { wm: "64MB", ...(I.lv === 3 ? { scope: "role" } : {}) }, ...(I.lv === 3 ? [{ wm: WMQ[I.q].need, scope: "conf" }] : [])],
    async accept(I, cfg) {
      const c = { scope: "local", ...cfg };
      if (I.lv === 3) { const mem = wmMem(I, c); if (mem > I.head) return `Set in ${SCOPES[c.scope]}, ${c.wm} applies to up to ${c.scope === "conf" ? I.maxc : I.repc} connections at once: about ${K.num(mem / 1024, 1)} GB in the worst case, more than the ${K.num(I.head / 1024)} GB to spare. A burst of big queries would push the box into swap or the OOM killer.`; }
      let r; try { r = await wmRun(I, c.wm); } catch (e) { return pgErr(e); }
      if (r.spills.length) return `Still spilling at ${c.wm}: ${esc(r.spills.join("; "))}.`;
      const i = WM_OPTS.indexOf(c.wm);
      if (i > 0) { let r2; try { r2 = await wmRun(I, WM_OPTS[i - 1]); } catch (e) { return pgErr(e); } if (!r2.spills.length) return `No spill at ${c.wm}, but ${WM_OPTS[i - 1]} is already enough. work_mem is a per-operation allowance multiplied by every concurrent query: don't hand out more than needed.`; }
      return true;
    },
    hint: (I) => I.lv === 1 ? "Watch the Sort Method in the plan: 'external merge' means disk, 'quicksort' means memory." : I.lv === 2 ? "Hash aggregation spills in batches too. It may use work_mem × hash_mem_multiplier (2 by default), and the query has more than one memory-hungry node." : "work_mem in postgresql.conf applies to every one of the max_connections sessions. Can you give it only to the export?",
    concept: "work_mem, sorts and hashes spilling",
    how: "Each sort, hash join and hash aggregate in a query may use up to work_mem (hashes up to work_mem × hash_mem_multiplier) before spilling to temporary files: EXPLAIN ANALYZE then shows 'Sort Method: external merge  Disk: N kB' or a hash aggregate with several batches. Raising it avoids the disk I/O, but the limit is per operation, per query, per connection, so a global value is multiplied by max_connections and by the number of such nodes in concurrent queries. Set big values narrowly: per role (ALTER ROLE reporting SET work_mem), per database, or per transaction (SET LOCAL). log_temp_files shows which queries spill.",
    rule: "Keep the global work_mem modest (a few MB on busy OLTP servers) and raise it only for the roles or transactions that run big sorts, sized from EXPLAIN ANALYZE: just above the reported disk usage.",
    why: (I, sol) => `At ${sol.wm} the plan switches from external merge${I.q === "agg" ? " and a batched hash aggregate" : ""} to in-memory operations; one step lower still spills.${I.lv === 3 ? ` Setting it for the reporting role (pool of ${I.repc}) caps the worst case near ${K.num(wmMem(I, sol))} MB, whereas postgresql.conf would allow ${K.num(wmMem(I, { ...sol, scope: "conf" }) / 1024, 1)} GB across ${I.maxc} connections.` : ""}`,
  });

  /* @@MORE@@ */

  LB.addAll("pg", S);
})();
