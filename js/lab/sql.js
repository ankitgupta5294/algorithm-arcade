/* Real Postgres in the browser (PGlite, Postgres compiled to WebAssembly), loaded lazily the first time a SQL level runs.
   LB.sql.session(async (db) => ...) runs work exclusively against one shared instance; every session starts by
   resetting the "lab" schema, so levels never see each other's tables.
     db.exec(sql)            run one or more statements
     db.q(sql, params?)      one statement -> { rows, fields }
     db.plan(sql)            EXPLAIN (FORMAT JSON) of a query -> the plan tree (root "Plan" node)
     db.planText(sql)        EXPLAIN text lines
   Helpers: LB.sql.nodes(plan) flattens a plan tree; LB.sql.sameRows(a, b, ordered) compares result sets;
            LB.sql.table(res) renders rows as an HTML table. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, U = D.util;
  const esc = U.esc;
  let inst = null, chain = Promise.resolve();
  const S = (LB.sql = {});
  // Overridable for tests (node): LB.sql.factory = async () => new PGlite()
  S.factory = async () => {
    if (!/^https?:$/.test(location.protocol)) throw new Error("Real-SQL levels need the game served over http(s) (they can't load Postgres from a file:// page).");
    const mod = await import(new URL("js/vendor/pglite/index.js", document.baseURI).href);
    return new mod.PGlite();
  };
  S.status = "idle";
  S.ready = () => {
    if (!inst) { S.status = "loading"; inst = S.factory().then((db) => { S.status = "ready"; return db; }, (e) => { inst = null; S.status = "idle"; throw e; }); }
    return inst;
  };
  const wrap = (pg) => ({
    exec: (sql) => pg.exec(sql),
    q: (sql, params) => pg.query(sql, params || []),
    plan: async (sql) => { const r = await pg.query("EXPLAIN (FORMAT JSON) " + sql); const v = r.rows[0]["QUERY PLAN"]; return (typeof v === "string" ? JSON.parse(v) : v)[0].Plan; },
    planText: async (sql) => (await pg.query("EXPLAIN " + sql)).rows.map((r) => r["QUERY PLAN"]),
    raw: pg,
  });
  S.session = (fn) => {
    const run = chain.then(async () => {
      const pg = await S.ready();
      await pg.exec("ROLLBACK").catch(() => {});
      await pg.exec("DROP SCHEMA IF EXISTS lab CASCADE; CREATE SCHEMA lab; SET search_path TO lab; RESET ALL; SET search_path TO lab;");
      return fn(wrap(pg));
    });
    chain = run.catch(() => {});
    return run;
  };
  S.nodes = (plan) => { const out = []; const go = (n, d) => { out.push({ ...n, depth: d }); (n.Plans || []).forEach((c) => go(c, d + 1)); }; go(plan, 0); return out; };
  S.uses = (plan, type) => S.nodes(plan).some((n) => n["Node Type"] === type);
  const norm = (v) => (v == null ? null : typeof v === "number" ? +v.toFixed(6) : v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : typeof v === "object" ? JSON.stringify(v) : /^-?\d+(\.\d+)?$/.test(String(v)) ? +(+v).toFixed(6) : String(v));
  S.rowKeys = (rows) => rows.map((r) => JSON.stringify(Object.values(r).map(norm)));
  S.sameRows = (a, b, ordered) => {
    const x = S.rowKeys(a), y = S.rowKeys(b);
    if (x.length !== y.length) return false;
    if (!ordered) { x.sort(); y.sort(); }
    return x.every((k, i) => k === y[i]);
  };
  S.table = (res, max = 12) => {
    const f = res.fields ? res.fields.map((x) => x.name) : res.rows.length ? Object.keys(res.rows[0]) : [];
    const rows = res.rows.slice(0, max);
    return `<div class="table-wrap"><table class="lab-table compact"><thead><tr>${f.map((n) => `<th>${esc(n)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${f.map((n) => `<td class="mono">${r[n] == null ? '<span class="muted">NULL</span>' : esc(r[n] instanceof Date ? r[n].toISOString().slice(0, 19) : r[n])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><div class="muted small">${res.rows.length} row${res.rows.length === 1 ? "" : "s"}${res.rows.length > max ? ` (first ${max} shown)` : ""}</div>`;
  };
  // A one-line plan summary: "Index Only Scan using idx on t → Sort → Limit"
  S.planLine = (plan) => S.nodes(plan).reverse().map((n) => n["Node Type"] + (n["Index Name"] ? ` (${n["Index Name"]})` : n["Relation Name"] ? ` on ${n["Relation Name"]}` : "")).join(" → ");
  // Reject statements that would escape the sandbox schema or take forever.
  S.guard = (sql) => {
    if (/\b(search_path|pg_sleep|copy\s|lo_|dblink|create\s+extension|alter\s+system|set\s+role)\b/i.test(sql)) return "That statement isn't allowed here.";
    return null;
  };
})();
