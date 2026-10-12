/* Systems Lab · Elasticsearch, part 2: operations (cluster health, allocation, disk, hot nodes, breakers, tasks),
   capacity planning, relevance tuning, concurrency and review scenarios. Uses the simulator in c-es.js (LB.es),
   looked up lazily because this file may load before or after it. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const ES = () => LB.es;
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const J = (x) => JSON.stringify(x);
  const JP = (x) => JSON.stringify(x, null, 2);
  const pj = (x) => ES().pj(x);
  const fmtGb = (g) => (g >= 1000 ? (g / 1000).toFixed(1) + "tb" : g >= 10 ? Math.round(g) + "gb" : g.toFixed(1) + "gb");
  const ipOf = (i) => `10.0.${1 + (i >> 4)}.${10 + (i % 16)}`;
  // Split "VERB path {json}" into parts; returns {verb, path, query, body, bodyErr}
  function req(line) {
    const m = /^(GET|POST|PUT|DELETE|HEAD)\s+\/?([^\s{]*)\s*(\{[\s\S]*\})?\s*$/i.exec(line.trim());
    if (!m) return null;
    const [path, query] = m[2].split("?");
    let body = null, bodyErr = null;
    if (m[3]) { const p = K.json(m[3]); if (p.ok) body = p.val; else bodyErr = p.err; }
    return { verb: m[1].toUpperCase(), path, query: query || "", body, bodyErr };
  }
  const jerr = (type, reason, status = 400) => pj({ error: { root_cause: [{ type, reason }], type, reason }, status });
  const ack = () => pj({ acknowledged: true });

  /* =====================================================================
     A small cluster model: nodes, indices, shard copies and the allocation deciders
     ===================================================================== */
  // cl: { name, nodes:[{name, roles, master, disk:{total, base}, heap, zone, cpu?}], indices:[{name, pri, rep, gb, docs, settings:{}, created}],
  //       shards:[{i, s, p, node, why?}], settings:{} (flat cluster settings), lost:{"idx/s": true} }
  function wm(cl) {
    const g = (k, d) => parseFloat(cl.settings["cluster.routing.allocation.disk.watermark." + k] || d);
    return { low: g("low", "85%"), high: g("high", "90%"), flood: g("flood_stage", "95%") };
  }
  const idxOf = (cl, n) => cl.indices.find((x) => x.name === n);
  const copyGb = (cl, sh) => { const ix = idxOf(cl, sh.i); return ix ? ix.gb / ix.pri : 0; };
  function nodeUsed(cl, n) { return n.disk.base + cl.shards.filter((s) => s.node === n.name).reduce((a, s) => a + copyGb(cl, s), 0); }
  const nodePct = (cl, n) => (100 * nodeUsed(cl, n)) / n.disk.total;
  const dataNodes = (cl) => cl.nodes.filter((n) => /d/.test(n.roles) && !n.down);
  // reasons node n can't take shard sh; [] = yes
  function deciders(cl, sh, n) {
    const out = [], ix = idxOf(cl, sh.i), st = ix.settings || {};
    if (cl.shards.some((x) => x !== sh && x.i === sh.i && x.s === sh.s && x.node === n.name)) out.push(["same_shard", `a copy of this shard is already allocated to this node [[${sh.i}][${sh.s}], node[${n.name}], [${sh.p ? "R" : "P"}], s[STARTED]]`]);
    const en = cl.settings["cluster.routing.allocation.enable"];
    if (!sh.p && (en === "primaries" || en === "none")) out.push(["enable", `replica allocations are forbidden due to cluster setting [cluster.routing.allocation.enable=${en}]`]);
    const req = st["index.routing.allocation.require._name"];
    if (req && req !== n.name) out.push(["filter", `node does not match index setting [index.routing.allocation.require] filters [_name:"${req}"]`]);
    const ex = cl.settings["cluster.routing.allocation.exclude._name"];
    if (ex && ex.split(",").includes(n.name)) out.push(["filter", `node matches cluster setting [cluster.routing.allocation.exclude] filters [_name:"${ex}"]`]);
    const W = wm(cl), pct = nodePct(cl, n);
    if (pct > W.low) out.push(["disk_threshold", `the node is above the low watermark cluster setting [cluster.routing.allocation.disk.watermark.low=${W.low}%], using more disk space than the maximum allowed [${W.low.toFixed(1)}%], actual free: [${(100 - pct).toFixed(1)}%]`]);
    const tspn = st["index.routing.allocation.total_shards_per_node"];
    if (tspn != null && cl.shards.filter((x) => x.i === sh.i && x.node === n.name).length >= +tspn) out.push(["shards_limit", `too many shards [${tspn}] allocated to this node for index [${sh.i}], index setting [index.routing.allocation.total_shards_per_node=${tspn}]`]);
    if (sh.retries >= 5) out.push(["max_retry", `shard has exceeded the maximum number of retries [5] on failed allocation attempts - manually call [/_cluster/reroute?retry_failed] to retry, [unassigned_info[[reason=ALLOCATION_FAILED], at[2026-07-15T06:12:41.118Z], failed_attempts[5], failed_nodes[[${sh.failedOn || "es-data-2"}]], delayed=false, details[failed shard on node [${sh.failedOn || "es-data-2"}]: failed recovery, failure RecoveryFailedException[[${sh.i}][${sh.s}]: Recovery failed]; nested: IOException[No space left on device]; ], allocation_status[deciders_no]]]`]);
    return out;
  }
  // Allocate unassigned copies where the deciders allow; primaries only if a copy of the data exists.
  function allocate(cl) {
    cl.indices.forEach((ix) => {
      // grow/shrink replica copies to match settings
      for (let s = 0; s < ix.pri; s++) {
        const reps = cl.shards.filter((x) => x.i === ix.name && x.s === s && !x.p);
        for (let k = reps.length; k < ix.rep; k++) cl.shards.push({ i: ix.name, s, p: false, node: null, why: "REPLICA_ADDED" });
        reps.slice(ix.rep).forEach((r) => cl.shards.splice(cl.shards.indexOf(r), 1));
      }
    });
    for (let pass = 0; pass < 3; pass++) {
      cl.shards.filter((x) => !x.node).forEach((sh) => {
        if (sh.p && cl.lost && cl.lost[sh.i + "/" + sh.s]) return;
        if (!sh.p) { const pr = cl.shards.find((x) => x.i === sh.i && x.s === sh.s && x.p); if (!pr || !pr.node) { const r = cl.shards.find((x) => x.i === sh.i && x.s === sh.s && !x.p && x.node && x !== sh); if (pr && !pr.node && r) { r.p = true; pr.p = false; } else return; } }
        const cands = dataNodes(cl).filter((n) => !deciders(cl, sh, n).length).sort((a, b) => cl.shards.filter((x) => x.node === a.name).length - cl.shards.filter((x) => x.node === b.name).length || a.name.localeCompare(b.name));
        if (cands.length) { sh.node = cands[0].name; delete sh.why; }
      });
    }
  }
  function health(cl, idx) {
    const sh = cl.shards.filter((x) => !idx || x.i === idx);
    return sh.some((x) => x.p && !x.node) ? "red" : sh.some((x) => !x.node) ? "yellow" : "green";
  }
  const healthJson = (cl) => {
    const sh = cl.shards, act = sh.filter((x) => x.node);
    return pj({ cluster_name: cl.name, status: health(cl), timed_out: false, number_of_nodes: cl.nodes.filter((n) => !n.down).length, number_of_data_nodes: dataNodes(cl).length, active_primary_shards: act.filter((x) => x.p).length, active_shards: act.length, relocating_shards: 0, initializing_shards: 0, unassigned_shards: sh.length - act.length, delayed_unassigned_shards: 0, number_of_pending_tasks: 0, number_of_in_flight_fetch: 0, active_shards_percent_as_number: +((100 * act.length) / Math.max(1, sh.length)).toFixed(1) });
  };
  const catNodes = (cl) => K.cols([["ip", "heap.percent", "ram.percent", "cpu", "load_1m", "node.role", "master", "name"], ...cl.nodes.filter((n) => !n.down).map((n, i) => [ipOf(i), n.heap || 41, 96, Math.round(n.cpu != null ? n.cpu : 12), ((n.cpu != null ? n.cpu : 12) / 12).toFixed(2), n.roles, n.elected ? "*" : "-", n.name])]);
  const catIndices = (cl) => K.cols([["health", "status", "index", "pri", "rep", "docs.count", "store.size", "pri.store.size"], ...cl.indices.slice().sort((a, b) => a.name.localeCompare(b.name)).map((ix) => { const live = cl.shards.filter((x) => x.i === ix.name && x.node).length; return [health(cl, ix.name), ix.closed ? "close" : "open", ix.name, ix.pri, ix.rep, ix.lostData ? 0 : ix.docs, fmtGb((ix.gb * live) / ix.pri), fmtGb(ix.gb)]; })]);
  const catShards = (cl, idx, reason) => K.cols([["index", "shard", "prirep", "state", "docs", "store", "ip", "node", ...(reason ? ["unassigned.reason"] : [])], ...cl.shards.filter((x) => !idx || x.i === idx || (idx.endsWith("*") && x.i.startsWith(idx.slice(0, -1)))).slice().sort((a, b) => a.i.localeCompare(b.i) || a.s - b.s || (a.p ? -1 : 1)).map((x) => { const ix = idxOf(cl, x.i), n = cl.nodes.findIndex((y) => y.name === x.node); return [x.i, x.s, x.p ? "p" : "r", x.node ? "STARTED" : "UNASSIGNED", x.node ? Math.round(ix.docs / ix.pri) : "", x.node ? fmtGb(ix.gb / ix.pri) : "", x.node ? ipOf(n) : "", x.node || "", ...(reason ? [x.node ? "" : x.why || "INDEX_CREATED"] : [])]; })]);
  const catAlloc = (cl) => K.cols([["shards", "disk.indices", "disk.used", "disk.avail", "disk.total", "disk.percent", "host", "node"], ...dataNodes(cl).map((n) => { const u = nodeUsed(cl, n), i = cl.nodes.indexOf(n); return [cl.shards.filter((x) => x.node === n.name).length, fmtGb(u - n.disk.base), fmtGb(u), fmtGb(n.disk.total - u), fmtGb(n.disk.total), Math.round((100 * u) / n.disk.total), ipOf(i), n.name]; }), ...(cl.shards.some((x) => !x.node) ? [[cl.shards.filter((x) => !x.node).length, "", "", "", "", "", "", "UNASSIGNED"]] : [])]);
  function explain(cl, body) {
    let sh;
    if (body && body.index) { sh = cl.shards.find((x) => x.i === body.index && x.s === +(body.shard || 0) && x.p === (body.primary !== false) && (!x.node || true)); if (!sh) return jerr("illegal_argument_exception", `unable to find any shards to explain [ShardId[[${body.index}][${body.shard || 0}]]] in the routing table`); }
    else { sh = cl.shards.find((x) => !x.node && x.p) || cl.shards.find((x) => !x.node); if (!sh) return jerr("illegal_argument_exception", "No shard was specified in the request which means the response should explain a randomly-chosen unassigned shard, but there are no unassigned shards in this cluster. To explain the allocation of an assigned shard you must specify the target shard in the request."); }
    if (sh.node) return pj({ index: sh.i, shard: sh.s, primary: sh.p, current_state: "started", current_node: { name: sh.node }, can_remain_on_current_node: "yes", can_rebalance_cluster: "yes" });
    if (sh.p && cl.lost && cl.lost[sh.i + "/" + sh.s]) {
      const stale = cl.stale && cl.stale[sh.i + "/" + sh.s];
      return pj({ index: sh.i, shard: sh.s, primary: true, current_state: "unassigned", unassigned_info: { reason: "NODE_LEFT", at: "2026-07-15T08:41:07.511Z", details: `node_left [${cl.lostNode}]`, last_allocation_status: stale ? "no_valid_shard_copy" : "no_valid_shard_copy" }, can_allocate: "no_valid_shard_copy", allocate_explanation: stale ? "Elasticsearch can't allocate this shard because all the copies of its data in the cluster are stale or corrupt. Elasticsearch will allocate this shard when a node containing a good copy of its data joins the cluster. If no such node is available, restore this index from a recent snapshot." : "Elasticsearch can't allocate this shard because there are no copies of its data in the cluster. Elasticsearch will allocate this shard when a node containing a good copy of its data joins the cluster. If no such node is available, restore this index from a recent snapshot.", ...(stale ? { node_allocation_decisions: [{ node_name: stale.node, node_decision: "no", store: { in_sync: false, allocation_id: "Xq3vR8sYQ0a1", found_at: stale.when } }] } : {}) });
    }
    const decs = dataNodes(cl).map((n) => ({ node_name: n.name, node_attributes: n.zone ? { zone: n.zone } : {}, node_decision: deciders(cl, sh, n).length ? "no" : "yes", deciders: deciders(cl, sh, n).map(([d, e]) => ({ decider: d, decision: "NO", explanation: e })) }));
    return pj({ index: sh.i, shard: sh.s, primary: sh.p, current_state: "unassigned", unassigned_info: { reason: sh.retries >= 5 ? "ALLOCATION_FAILED" : sh.why || "INDEX_CREATED", at: "2026-07-15T06:12:41.118Z", ...(sh.retries ? { failed_allocation_attempts: sh.retries } : {}), last_allocation_status: "no_attempt" }, can_allocate: "no", allocate_explanation: "Elasticsearch isn't allowed to allocate this shard to any of the nodes in the cluster. Choose a node to which you expect this shard to be allocated, find this node in the node-by-node explanation, and address the reasons which prevent Elasticsearch from allocating this shard there.", node_allocation_decisions: decs.map((d) => (d.deciders.length ? d : { ...d, deciders: undefined })) });
  }
  // match an index expression (name, comma list, wildcard, _all) against the cluster
  const resolve = (cl, expr) => { if (expr === "_all" || expr === "*") return cl.indices.slice(); return expr.split(",").flatMap((e) => cl.indices.filter((ix) => (e.endsWith("*") ? ix.name.startsWith(e.slice(0, -1)) : ix.name === e))); };
  // Flatten a settings body: {"index":{"number_of_replicas":0}} / {"index.number_of_replicas":0} / {"number_of_replicas":0}
  const flatSettings = (b, pre = "") => { const o = {}; Object.entries(b || {}).forEach(([k, v]) => { if (isObj(v)) Object.assign(o, flatSettings(v, pre + k + ".")); else o[pre + k] = v; }); return o; };
  const idxKey = (k) => (k.startsWith("index.") ? k : k.startsWith("settings.") ? idxKey(k.slice(9)) : "index." + k);

  // Standard cluster commands; o.on: hooks {deleteIndex(ix, st) -> danger?, idxSettings(ix, flat, st) -> danger?, clusterSettings(flat, st) -> danger?}
  function clusterDefs(o = {}) {
    const C = (st) => st.cl;
    return [
      { re: /^GET \/?_cluster\/health(\?\S*)?$/i, use: "GET _cluster/health", desc: "cluster status and shard counts", run: (m, st) => healthJson(C(st)) },
      { re: /^GET \/?_cat\/nodes(\?\S*)?$/i, use: "GET _cat/nodes?v", desc: "nodes, roles, heap, cpu", run: (m, st) => catNodes(C(st)) },
      { re: /^GET \/?_cat\/indices(?:\/(\S+?))?(\?\S*)?$/i, use: "GET _cat/indices?v", desc: "indices, health and size", run: (m, st) => catIndices(C(st)) },
      { re: /^GET \/?_cat\/shards(?:\/([^?\s]+))?(\?\S*)?$/i, use: "GET _cat/shards[/<index>]?v[&h=...,unassigned.reason]", desc: "every shard copy and where it lives", run: (m, st) => catShards(C(st), m[1], /unassigned\.reason/.test(m[2] || "")) },
      { re: /^GET \/?_cat\/allocation(\?\S*)?$/i, use: "GET _cat/allocation?v", desc: "shards and disk per node", run: (m, st) => catAlloc(C(st)) },
      { re: /^GET \/?_cluster\/allocation\/explain(\?\S*)?(?:\s+(\{.*\}))?$/i, use: "GET _cluster/allocation/explain [{\"index\":..,\"shard\":0,\"primary\":false}]", desc: "why a shard is unassigned", run: (m, st) => { let b = null; if (m[2]) { const p = K.json(m[2]); if (!p.ok) return jerr("json_parse_exception", p.err); b = p.val; } return explain(C(st), b); } },
      { re: /^GET \/?_cluster\/settings(\?\S*)?$/i, use: "GET _cluster/settings", desc: "persistent/transient cluster settings", run: (m, st) => { const s = C(st).settings; const nest = {}; Object.entries(s).forEach(([k, v]) => { if (v != null) nest[k] = v; }); return pj({ persistent: nest, transient: {} }); } },
      { re: /^GET \/?([\w.*,-]+)\/_settings(\?\S*)?$/i, use: "GET <index>/_settings", desc: "index settings", run: (m, st) => { const xs = resolve(C(st), m[1]); if (!xs.length) return jerr("index_not_found_exception", `no such index [${m[1]}]`, 404); const out = {}; xs.forEach((ix) => { const s = { number_of_shards: String(ix.pri), number_of_replicas: String(ix.rep), refresh_interval: ix.refresh || "1s" }; Object.entries(ix.settings || {}).forEach(([k, v]) => { if (v != null) s[k.replace(/^index\./, "")] = String(v); }); out[ix.name] = { settings: { index: s } }; }); return pj(out); } },
      { re: /^PUT \/?([\w.*,-]+)\/_settings(?:\s+(\{.*\}))?$/i, use: "PUT <index>/_settings {\"index.number_of_replicas\": 1}", desc: "change dynamic index settings", run: (m, st) => {
        if (!m[2]) return jerr("action_request_validation_exception", "Validation Failed: 1: no settings to update;");
        const p = K.json(m[2]); if (!p.ok) return jerr("json_parse_exception", p.err);
        const xs = resolve(C(st), m[1]); if (!xs.length) return jerr("index_not_found_exception", `no such index [${m[1]}]`, 404);
        const flat = {}; Object.entries(flatSettings(p.val)).forEach(([k, v]) => (flat[idxKey(k)] = v));
        if (flat["index.number_of_shards"] != null) return jerr("illegal_argument_exception", `final ${xs[0].name} setting [index.number_of_shards], not updateable`);
        let danger = null;
        xs.forEach((ix) => {
          if (flat["index.number_of_replicas"] != null) ix.rep = +flat["index.number_of_replicas"];
          if (flat["index.refresh_interval"] !== undefined) ix.refresh = flat["index.refresh_interval"] == null ? "1s" : String(flat["index.refresh_interval"]);
          ix.settings = ix.settings || {};
          Object.entries(flat).forEach(([k, v]) => { if (!["index.number_of_replicas", "index.refresh_interval"].includes(k)) ix.settings[k] = v; });
          if (o.idxSettings) danger = o.idxSettings(ix, flat, st) || danger;
        });
        allocate(C(st));
        return danger ? { out: ack(), danger } : ack();
      } },
      { re: /^PUT \/?_cluster\/settings(?:\s+(\{.*\}))?$/i, use: "PUT _cluster/settings {\"persistent\": {...}}", desc: "change cluster settings (null resets)", run: (m, st) => {
        if (!m[1]) return jerr("action_request_validation_exception", "Validation Failed: 1: no settings to update;");
        const p = K.json(m[1]); if (!p.ok) return jerr("json_parse_exception", p.err);
        const flat = {}; ["persistent", "transient"].forEach((k) => Object.assign(flat, flatSettings(p.val[k] || {})));
        if (!Object.keys(flat).length) return jerr("action_request_validation_exception", "Validation Failed: 1: no settings to update;");
        Object.entries(flat).forEach(([k, v]) => (C(st).settings[k] = v == null ? undefined : String(v)));
        const danger = o.clusterSettings ? o.clusterSettings(flat, st) : null;
        allocate(C(st));
        if (o.after) o.after(st);
        const out = pj({ acknowledged: true, persistent: p.val.persistent || {}, transient: p.val.transient || {} });
        return danger ? { out, danger } : out;
      } },
      { re: /^DELETE \/?([\w.*,-]+)$/i, use: "DELETE <index>", desc: "delete an index (irreversible)", run: (m, st) => {
        if (m[1].includes("*") || m[1] === "_all") return jerr("illegal_argument_exception", "Wildcard expressions or all indices are not allowed (action.destructive_requires_name is true)");
        const xs = resolve(C(st), m[1]); if (!xs.length) return jerr("index_not_found_exception", `no such index [${m[1]}]`, 404);
        let danger = null;
        xs.forEach((ix) => { danger = (o.deleteIndex ? o.deleteIndex(ix, st) : null) || danger; C(st).indices = C(st).indices.filter((x) => x !== ix); C(st).shards = C(st).shards.filter((x) => x.i !== ix.name); });
        allocate(C(st));
        if (o.after) o.after(st);
        return danger ? { out: ack(), danger } : ack();
      } },
    ];
  }
  const mkNodes = (names, o = {}) => names.map((name, i) => ({ name, roles: o.roles ? o.roles[i] : "cdfhilmrstw", disk: { total: o.total || 1000, base: o.base ? o.base[i] : 20 }, heap: 30 + ((i * 17) % 40), zone: o.zones ? o.zones[i] : undefined, elected: i === (o.master || 0) }));
  // place every copy round-robin (primaries first), skipping same-node copies
  function place(cl, start = 0) {
    const dn = dataNodes(cl);
    let k = start;
    cl.indices.forEach((ix) => {
      for (let s = 0; s < ix.pri; s++) {
        for (let c = 0; c <= ix.rep; c++) {
          let tries = 0, node = null;
          while (tries < dn.length) { const n = dn[k++ % dn.length]; tries++; if (!cl.shards.some((x) => x.i === ix.name && x.s === s && x.node === n.name)) { node = n.name; break; } }
          cl.shards.push({ i: ix.name, s, p: c === 0, node, ...(node ? {} : { why: "INDEX_CREATED" }) });
        }
      }
    });
  }

  const MORE = [];

  /* ---------- T1. Why doesn't this match? (Kibana-style console) ---------- */
  function wnmShell(I) {
    const es = ES();
    const all = es.build(I.index, I.docs, { name: "products", now: Date.UTC(2026, 6, 15, 10) });
    const hidden = I.lv === 3 ? es.build(I.index, I.docs.filter((d) => d._id !== I.target), { name: "products" }) : all;
    const sh = K.shell([
      { re: /^GET \/?products\/_mapping$/i, use: "GET products/_mapping", desc: "field types and analyzers", run: () => pj({ products: { mappings: I.index.mappings && I.index.mappings.properties ? I.index.mappings : { properties: Object.fromEntries([...all.idx.fields.entries()].filter(([p, f]) => !f.multi && !p.includes(".")).map(([p, f]) => [p, f.type === "text" && all.idx.fields.has(p + ".keyword") ? { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } } : { type: f.type }])) } } }) },
      { re: /^GET \/?products\/_settings$/i, use: "GET products/_settings", desc: "index settings", run: (m, st) => pj({ products: { settings: { index: { number_of_shards: "1", number_of_replicas: "1", refresh_interval: st.interval, ...(I.index.settings && I.index.settings.analysis ? { analysis: I.index.settings.analysis } : {}) } } } }) },
      { re: /^GET \/?products\/_doc\/(\S+)$/i, use: "GET products/_doc/<id>", desc: "fetch one document (real-time)", run: (m) => { const d = I.docs.find((x) => x._id === m[1]); if (!d) return pj({ _index: "products", _id: m[1], found: false }); const { _id, ...src } = d; return pj({ _index: "products", _id, _version: 1, _seq_no: 4, _primary_term: 1, found: true, _source: src }); } },
      { re: /^(?:GET|POST) \/?products\/_search(?:\s+(\{.*\}))?$/i, use: "GET products/_search {\"query\": {...}}", desc: "run a search (JSON body on the same line)", run: (m, st) => {
        const src = m[1] || "{}";
        const vis = st.refreshed ? all : hidden;
        const r = es.run(vis.idx, src);
        if (r.error) return r.error.type === "json_parse_exception" ? jerr("parsing_exception", r.error.reason) : es.errJson(r.error);
        const hs = r.res.hits.hits;
        if (hs.some((h) => h._id === I.target)) st.found = true;
        return pj({ took: r.res.took, timed_out: false, hits: { total: r.res.hits.total, hits: hs.slice(0, 5).map((h) => ({ _id: h._id, _score: h._score == null ? null : +h._score.toFixed(3), _source: { [I.show]: h._source[I.show] } })) } }) + (hs.length > 5 ? `\n... ${hs.length - 5} more` : "");
      } },
      { re: /^(?:GET|POST) \/?products\/_analyze(?:\s+(\{.*\}))?$/i, use: "POST products/_analyze {\"field\": \"<field>\", \"text\": \"...\"}", desc: "see the tokens a field or analyzer produces", run: (m) => {
        if (!m[1]) return jerr("action_request_validation_exception", "Validation Failed: 1: text is missing;");
        const p = K.json(m[1]); if (!p.ok) return jerr("json_parse_exception", p.err);
        try { return pj({ tokens: es.analyze(all.idx, p.val).map((t) => ({ token: t.token, type: "<ALPHANUM>", position: t.position })) }); } catch (e) { if (e instanceof es.ESErr) return es.errJson(e); throw e; }
      } },
      { re: /^POST \/?products\/_refresh$/i, use: "POST products/_refresh", desc: "open new segments for search now", run: (m, st) => { st.refreshed = true; return pj({ _shards: { total: 2, successful: 2, failed: 0 } }); } },
      { re: /^PUT \/?products\/_settings(?:\s+(\{.*\}))?$/i, use: "PUT products/_settings {\"index\": {...}}", desc: "change a dynamic setting", run: (m, st) => {
        if (!m[1]) return jerr("action_request_validation_exception", "Validation Failed: 1: no settings to update;");
        const p = K.json(m[1]); if (!p.ok) return jerr("json_parse_exception", p.err);
        const flat = flatSettings(p.val);
        const k = Object.keys(flat).find((x) => /refresh_interval$/.test(x));
        if (k) { st.interval = flat[k] == null ? "1s" : String(flat[k]); if (st.interval !== "-1") st.refreshed = true; return ack(); }
        if (Object.keys(flat).some((x) => /analysis|analyzer/.test(x))) return jerr("illegal_argument_exception", "Can't update non dynamic settings [[index.analysis...]] for open indices [[products]]");
        return ack();
      } },
      { re: /^GET \/?_cat\/indices(\?\S*)?$/i, use: "GET _cat/indices?v", desc: "", run: () => K.cols([["health", "status", "index", "pri", "rep", "docs.count", "store.size"], ["green", "open", "products", "1", "1", String(I.docs.length * 3100), "1.2gb"]]) },
    ], { sh: "console" });
    return {
      prompt: ">", init: { found: false, refreshed: I.lv !== 3, interval: I.lv === 3 ? "-1" : "1s" }, run: (line, st) => sh.run(line, st), par: 6,
      motd: I.motd,
      cmds: ["GET products/_mapping", "GET products/_settings", `GET products/_doc/${I.target}`, `POST products/_analyze {"field": "${I.field}", "text": "${I.q}"}`, `GET products/_search {"query": {"match": {"${I.field}": "${I.q}"}}}`, "POST products/_refresh"],
      opts: I.opts, optq: "Root cause",
    };
  }
  MORE.push({
    id: "es-why-no-match",
    name: "Why doesn't this document match?",
    kind: "Investigation",
    skills: ["diagnose"],
    ...LB.term({
      shell: (I) => wnmShell(I),
      goal(st, I, a) {
        if (!st.found) return `No search in your session returned <b>${esc(I.target)}</b> yet. Find a request that does.`;
        if (I.lv === 3 && st.interval === "-1") return "You made the document visible once, but <code>refresh_interval</code> is still <code>-1</code>: the next import's documents will be invisible again.";
        if (a.pick !== I.ans) return "The search works now, but that's not the root cause the evidence shows.";
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["GET products/_mapping", `GET products/_search {"query": {"match": {"sku": "${I.q}"}}}`] : I.lv === 2 ? ["GET products/_mapping", `POST products/_analyze {"field": "name", "text": "${I.q}"}`, `GET products/_search {"query": {"match": {"name": {"query": "${I.q}", "analyzer": "folding"}}}}`] : [`GET products/_doc/${I.target}`, "GET products/_settings", "PUT products/_settings {\"index\": {\"refresh_interval\": \"1s\"}}", `GET products/_search {"query": {"match": {"name": "${I.q}"}}}`], pick: I.ans }),
    }),
    gen(lv, R) {
      const show = lv === 1 ? "sku" : "name";
      let docs, index, q, target, field, motd, opts;
      if (lv === 1) {
        const skus = R.distinct(6, 1000, 9999).map((n, i) => `${R.pick(["KX", "TR", "MB", "QZ"])}-${n}-${"ABCDEF"[i]}`);
        docs = skus.map((s, i) => ({ _id: "p" + (200 + i * 7), sku: s, name: R.pick(["Desk Lamp", "USB Hub", "Monitor Arm", "Webcam", "Dock"]) }));
        target = docs[2]._id; q = docs[2].sku; field = "sku"; index = {};
        motd = `Ticket #4471 from support:\n  GET products/_search {"query": {"term": {"sku": "${q}"}}}\nreturns 0 hits, but the product is live on the site (_id ${target}).`;
        opts = ["sku was mapped dynamically as text, so it holds lowercase tokens; an unanalysed term query for the whole SKU can't match them", "The document hasn't been refreshed into a searchable segment yet", "sku is a keyword field with a lowercase normalizer", "The search hit a different index than the document"];
      } else if (lv === 2) {
        const w = R.pick([["Café Racer Jacket", "café racer"], ["Crème Brûlée Set", "crème brûlée"], ["Jalapeño Hot Sauce", "jalapeño"]]);
        docs = [w[0], "Racer Gloves", "Leather Jacket", "Café Table", "Espresso Cups"].map((n, i) => ({ _id: "p" + (310 + i * 4), name: n }));
        target = docs[0]._id; q = w[1]; field = "name";
        index = { settings: { analysis: { analyzer: { folding: { type: "custom", tokenizer: "standard", filter: ["lowercase", "asciifolding"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "folding", search_analyzer: "standard" } } } };
        motd = `Ticket #5120: searching "${q}" (with the accent, as French and Spanish keyboards type it)\nreturns nothing, but "${ES().analyze(null, { analyzer: "standard", text: fold(q) }).map((t) => t.token).join(" ")}" without accents works. Product _id ${target}.`;
        opts = ["The search_analyzer doesn't fold accents, so the query keeps é while the index stored the folded token", "A term query is being used on a text field", "The english stopword filter removed the word", "The document is still in the translog and not refreshed"];
      } else {
        const n = R.pick(["Trail Running Vest", "Insulated Water Bottle", "Folding Camp Chair"]);
        docs = [n, "Running Belt", "Camp Stove", "Water Filter", "Hiking Poles"].map((x, i) => ({ _id: "p" + (900 + i * 9), name: x }));
        target = docs[0]._id; q = n.toLowerCase(); field = "name"; index = { mappings: { properties: { name: { type: "text" } } } };
        motd = `Ticket #6001: the new catalog import (bulk loader v2, ran 20 minutes ago) added\n"${n}" (_id ${target}). The product page loads it, but site search can't find it.\nOther products imported last week are found fine.`;
        opts = ["refresh_interval was left at -1 by the bulk loader, so new documents never become visible to search", "The document was routed to a replica that hasn't synced yet", "The standard analyzer split the name differently at index and search time", "The bulk request failed for that document"];
      }
      const order = R.shuffle([0, 1, 2, 3]);
      return { lv, docs, index, q, target, field, show, motd, opts: order.map((k) => opts[k]), ans: order.indexOf(0) };
    },
    bad: (I) => [{ log: ["GET products/_mapping"], pick: I.ans }, { log: (I.lv === 1 ? [`GET products/_search {"query": {"term": {"sku.keyword": "${I.q}"}}}`] : I.lv === 2 ? [`GET products/_search {"query": {"match": {"name": "${fold(I.q)}"}}}`] : ["POST products/_refresh", `GET products/_search {"query": {"match": {"name": "${I.q}"}}}`]), pick: (I.ans + 1) % 4 }, ...(I.lv === 3 ? [{ log: ["POST products/_refresh", `GET products/_search {"query": {"match": {"name": "${I.q}"}}}`], pick: I.ans }] : [])],
    text: (I) => `<p>A support ticket says a product can't be found. You have a console on the cluster (one request per line, JSON body on the same line). Find the root cause, and prove it by running a search that <b>does</b> return <code>${esc(I.target)}</code>${I.lv === 3 ? ", and leave the index so the next import doesn't hit the same problem" : ""}.</p>`,
    hint: (I) => I.lv === 1 ? "Compare the mapping of sku with the query type. _analyze shows what the field actually stores." : I.lv === 2 ? "Run _analyze with the field (index analyzer), then compare with what the standard analyzer does to the query text." : "GET _doc is real-time and reads from the translog; search only sees refreshed segments. Check the index settings.",
    concept: "Debugging a non-match: mapping, analysis, refresh",
    how: "When a document exists but a search doesn't find it, check three things in order. The mapping (<code>GET index/_mapping</code>): is the field text or keyword, and which analyzer runs at index and search time? The analysis (<code>POST index/_analyze</code>): do the tokens the query produces equal the tokens in the index, byte for byte? And visibility: <code>GET _doc</code> is real-time, but search only sees segments opened by a refresh, which happens every <code>refresh_interval</code> (1s by default; bulk loaders often set <code>-1</code> and forget to restore it).",
    rule: "Reproduce with _analyze on both sides before changing anything; when GET by id works but search doesn't, look at refresh before analysis.",
    why: (I) => I.lv === 1 ? `Dynamic mapping made sku text: "${esc(I.q)}" is stored as lowercase tokens split on hyphens, so the unanalysed term never matches. match on sku (or term on sku.keyword) finds it.` : I.lv === 2 ? `The index analyzer folds "${esc(I.q)}" to "${esc(fold(I.q))}", but search_analyzer is standard, which keeps the accent. Querying with the folding analyzer (and fixing search_analyzer, which needs a close/reopen or new index) aligns both sides.` : "The loader set refresh_interval: -1 for speed and never restored it. GET _doc reads the translog in real time, search doesn't. Setting it back to 1s refreshes the index and keeps future imports visible.",
  });
  function fold(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, ""); }

  /* ---------- T2. Yellow cluster ---------- */
  function yellowCluster(I) {
    let cl;
    if (I.lv === 1) {
      cl = { name: "dev-search", nodes: mkNodes(["es-dev-1"]), indices: I.idx.map((n, k) => ({ name: n, pri: 1, rep: 1, gb: 0.4 + k * 0.3, docs: 12000 + k * 5100 })), shards: [], settings: {} };
    } else if (I.lv === 2) {
      cl = { name: "prod-logs", nodes: mkNodes(["es-data-1", "es-data-2", "es-data-3"], { total: 2000, base: [40, 40, 40] }), indices: [], shards: [], settings: {} };
      I.old.forEach((n) => cl.indices.push({ name: n, pri: 3, rep: 1, gb: I.oldGb, docs: 41000000 }));
      I.cur.forEach((n) => cl.indices.push({ name: n, pri: 3, rep: 1, gb: I.curGb, docs: 52000000 }));
      cl.indices.push({ name: I.newIdx, pri: 3, rep: 1, gb: 60, docs: 7000000 });
      place(cl);
      // the new index's replicas can't be placed because two nodes are over the low watermark
      cl.shards.filter((x) => x.i === I.newIdx).forEach((x) => { x.node = x.p ? "es-data-3" : null; if (!x.p) x.why = "INDEX_CREATED"; });
      const fill = (name, pct) => { const n = cl.nodes.find((x) => x.name === name); n.disk.base += (pct / 100) * n.disk.total - nodeUsed(cl, n); };
      fill("es-data-1", I.p1); fill("es-data-2", I.p2); fill("es-data-3", 58);
      // es-data-3 can't take replicas of its own primaries
      return cl;
    } else {
      cl = { name: "prod-search", nodes: mkNodes(["es-data-1", "es-data-2", "es-data-3", "es-data-5"], { total: 1500, base: [400, 380, 1100, 300] }), indices: [{ name: I.bad, pri: 3, rep: 1, gb: 90, docs: 30000000, settings: { "index.routing.allocation.require._name": "es-data-4" } }, { name: "catalog", pri: 2, rep: 1, gb: 40, docs: 9000000 }, { name: "users", pri: 1, rep: 1, gb: 8, docs: 2000000 }], shards: [], settings: {} };
      place(cl);
      cl.shards.filter((x) => x.i === I.bad && !x.p).forEach((x) => { x.node = null; x.why = "NODE_LEFT"; });
      cl.shards.filter((x) => x.i === I.bad && x.p).forEach((x, k) => (x.node = ["es-data-1", "es-data-2", "es-data-5"][k]));
      return cl;
    }
    place(cl);
    return cl;
  }
  MORE.push({
    id: "es-cluster-yellow",
    name: "Get the cluster back to green",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => {
        const cl = yellowCluster(I);
        allocate(cl);
        const sh = K.shell(clusterDefs({
          deleteIndex: (ix, st) => { st.deleted.push(ix.name); return I.lv === 2 && !I.old.includes(ix.name) ? `${ix.name} is inside the 30-day retention window: you just deleted data you're required to keep.` : I.lv !== 2 ? `You deleted ${ix.name} and its data to make the health light green.` : null; },
          idxSettings: (ix, flat) => (flat["index.number_of_replicas"] != null && +flat["index.number_of_replicas"] === 0 && I.lv > 1 ? `${ix.name} now has no replica: losing one node loses data.` : null),
          clusterSettings: (flat) => (Object.keys(flat).some((k) => /watermark/.test(k)) ? "Raising the disk watermarks borrows the headroom the cluster needs for merges and relocations; the next spike will hit flood stage and block writes." : Object.keys(flat).some((k) => /allocation\.enable|exclude/.test(k)) && I.lv !== 3 ? null : null),
        }), { sh: "console" });
        return { prompt: ">", init: { cl, deleted: [] }, run: (line, st) => sh.run(line, st), par: I.lv === 1 ? 5 : 6, motd: I.motd, cmds: ["GET _cluster/health", "GET _cat/nodes?v", "GET _cat/indices?v", "GET _cat/shards?v&h=index,shard,prirep,state,node,unassigned.reason", "GET _cat/allocation?v", "GET _cluster/allocation/explain"] };
      },
      goal(st, I, a, rp) {
        const cl = st.cl;
        if (health(cl) !== "green") return `The cluster is still <b>${health(cl)}</b>: ${cl.shards.filter((x) => !x.node).length} shard copies are unassigned.`;
        if (I.lv > 1 && cl.indices.some((ix) => ix.rep < 1)) return "Green, but by dropping replicas: one node failure would now lose data. Fix the cause instead.";
        if (rp.danger) return "Green, but at a cost (see the warnings above).";
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["GET _cluster/health", "GET _cat/shards?v&h=index,shard,prirep,state,node,unassigned.reason", `PUT ${I.idx.join(",")}/_settings {"index": {"number_of_replicas": 0}}`] : I.lv === 2 ? ["GET _cluster/allocation/explain", "GET _cat/allocation?v", "GET _cat/indices?v", ...I.old.slice(0, I.needDel).map((n) => "DELETE " + n)] : ["GET _cluster/allocation/explain", `PUT ${I.bad}/_settings {"index.routing.allocation.require._name": null}`] }),
    }),
    gen(lv, R) {
      if (lv === 1) {
        const idx = R.sample(["products", "orders", "users", "reviews", "carts"], 3);
        return { lv, idx, motd: `Your laptop dev cluster (docker, single node) reports\n  GET _cluster/health -> "status": "yellow"\nand the CI health check waits for green.` };
      }
      if (lv === 2) {
        const day = R.int(10, 14);
        const old = [1, 2, 3, 4].map((k) => `logs-2026.06.${String(day - k).padStart(2, "0")}`);
        const cur = [1, 2, 3, 4, 5].map((k) => `logs-2026.07.${String(day - 2 + k).padStart(2, "0")}`);
        const I = { lv, old, cur, oldGb: 260, curGb: 200, newIdx: `logs-2026.07.${String(day + 4).padStart(2, "0")}`, p1: R.int(86, 89), p2: R.int(86, 89) };
        // how many old indices must go (each frees ~oldGb*2/3 per node on average)
        const cl = yellowCluster({ ...I }); allocate(cl);
        let need = 0;
        while (need < 4) { const c = K.clone(cl); I.old.slice(0, need).forEach((n) => { c.indices = c.indices.filter((x) => x.name !== n); c.shards = c.shards.filter((x) => x.i !== n); }); allocate(c); if (health(c) === "green") break; need++; }
        if (need === 0 || need >= 4) return null;
        I.needDel = need;
        I.motd = `PAGE prod-logs: cluster health YELLOW since 00:05 UTC (new daily index).\nRetention policy: 30 days. Today is 2026-07-${String(day + 4).padStart(2, "0")}. ILM is being migrated, so old indices are cleaned up manually this week.`;
        return I;
      }
      const bad = R.pick(["orders-v3", "invoices-v2", "payments-v4"]);
      return { lv, bad, motd: `PAGE prod-search: YELLOW after es-data-4 was decommissioned yesterday and replaced by es-data-5.\nThe migration runbook pinned some indices to es-data-4 while copying data off it.` };
    },
    bad: (I) => I.lv === 1 ? [{ log: [`DELETE ${I.idx[0]}`] }, { log: ["GET _cluster/health"] }] : I.lv === 2 ? [{ log: ['PUT _cluster/settings {"persistent": {"cluster.routing.allocation.disk.watermark.low": "93%", "cluster.routing.allocation.disk.watermark.high": "95%"}}'] }, { log: [`PUT ${I.newIdx}/_settings {"index.number_of_replicas": 0}`] }, { log: I.cur.slice(0, 3).map((n) => "DELETE " + n) }] : [{ log: [`PUT ${I.bad}/_settings {"index.number_of_replicas": 0}`] }, { log: ['PUT _cluster/settings {"persistent": {"cluster.routing.allocation.disk.watermark.low": "95%"}}'] }],
    text: (I) => `<p>${I.lv === 1 ? "Your single-node dev cluster is <b>yellow</b> and the CI pipeline waits for green." : I.lv === 2 ? "The logging cluster went <b>yellow</b> when today's index was created." : "The search cluster has been <b>yellow</b> since a node was replaced."} Find out why the shard copies are unassigned and get to <b>green</b> ${I.lv === 1 ? "without losing data" : "without reducing redundancy or deleting data you must keep"}. Type <code>help</code> for the console commands.</p>`,
    hint: (I) => I.lv === 1 ? "A replica is never allocated on the same node as its primary. How many nodes does this cluster have?" : I.lv === 2 ? "allocation/explain names the decider that says NO. Then look at disk per node and what's taking the space." : "Read the filter decider in allocation/explain carefully. Settings can be reset with null.",
    concept: "Unassigned replicas: reading allocation/explain",
    how: "Yellow means every primary is assigned but some replica isn't; red means a primary is missing. <code>GET _cluster/allocation/explain</code> picks an unassigned shard and lists, per node, which allocation decider said NO: <code>same_shard</code> (a replica can't live with its primary, so a single node can never host replicas), <code>disk_threshold</code> (no new shards on a node above the low watermark, 85% by default; above high, 90%, shards move away; at flood stage, 95%, indices go read-only), <code>filter</code> (index or cluster allocation filters, often left behind by a migration), <code>enable</code>, <code>max_retry</code> and more. Fix the cause the decider names.",
    rule: "Don't guess from _cat output: run allocation/explain, fix exactly what the NO decider names, and never reach green by dropping replicas or raising watermarks on a production cluster.",
    why: (I) => I.lv === 1 ? "With one node, every replica is refused by the same_shard decider. On a dev box set number_of_replicas to 0 (or add a node)." : I.lv === 2 ? `es-data-1 and es-data-2 were at ${I.p1}% and ${I.p2}%, above the 85% low watermark, so today's replicas had nowhere to go (es-data-3 holds the primaries). Deleting the ${I.needDel} oldest index(es) past the 30-day retention freed enough space.` : `${esc(I.bad)} still had index.routing.allocation.require._name: es-data-4 from the decommissioning runbook. With es-data-4 gone, the filter decider refuses every node for the replicas. Resetting the setting with null lets them allocate.`,
  });

  /* ---------- T3. Red cluster ---------- */
  function redCluster(I) {
    const nodes = mkNodes(["es-data-1", "es-data-2", "es-data-3"], { total: 2000, base: [300, 300, 300] });
    const cl = { name: "prod-audit", nodes, indices: [{ name: I.red, pri: 1, rep: I.lv === 3 ? 1 : 0, gb: 30, docs: 18000000 }, { name: "audit-2026.07.13", pri: 1, rep: 1, gb: 28, docs: 17000000 }, { name: "users", pri: 1, rep: 1, gb: 4, docs: 900000 }], shards: [], settings: {}, lost: {}, stale: {} };
    place(cl, 1);
    const sh = cl.shards.find((x) => x.i === I.red && x.p);
    if (I.lv === 1) { cl.nodes.push({ name: "es-data-4", roles: "cdfhilmrstw", disk: { total: 2000, base: 300 }, heap: 40, down: true }); sh.node = null; cl.lost[I.red + "/0"] = true; cl.lostNode = "es-data-4"; }
    if (I.lv === 2) { sh.node = null; sh.retries = 5; sh.why = "ALLOCATION_FAILED"; sh.failedOn = "es-data-2"; }
    if (I.lv === 3) { const r = cl.shards.find((x) => x.i === I.red && !x.p); sh.node = null; r.node = null; r.why = "NODE_LEFT"; cl.lost[I.red + "/0"] = true; cl.lostNode = "es-data-4"; cl.stale[I.red + "/0"] = { node: "es-data-2", when: "2026-07-15T09:16:02Z" }; cl.nodes.push({ name: "es-data-4", roles: "cdfhilmrstw", disk: { total: 2000, base: 300 }, down: true }); }
    return cl;
  }
  MORE.push({
    id: "es-cluster-red",
    name: "Red index: recover with the least data loss",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => {
        const cl = redCluster(I);
        const defs = clusterDefs({ deleteIndex: (ix, st) => { st.deletedRed = ix.name === I.red; return ix.name === I.red && I.lv !== 1 ? `You deleted ${ix.name}, including copies the cluster could still have recovered.` : ix.name !== I.red ? `${ix.name} was healthy.` : null; } });
        const snaps = [{ id: `nightly-2026.07.15-${I.snapH}h`, state: "SUCCESS", end: `2026-07-15T0${I.snapH}:12:40Z`, indices: 3 }, { id: "nightly-2026.07.14", state: "SUCCESS", end: "2026-07-14T02:10:05Z", indices: 3 }];
        defs.push(
          { re: /^GET \/?_cat\/snapshots(?:\/(\S+?))?(\?\S*)?$/i, use: "GET _cat/snapshots/backups?v", desc: "snapshots in the repository", run: () => K.cols([["id", "status", "end_time", "indices", "failed_shards"], ...snaps.map((s) => [s.id, s.state, s.end.slice(11, 19), s.indices, 0])]) },
          { re: /^POST \/?_snapshot\/backups\/(\S+)\/_restore(?:\s+(\{.*\}))?$/i, use: "POST _snapshot/backups/<snapshot>/_restore {\"indices\": \"<index>\"}", desc: "restore indices from a snapshot", run: (m, st) => {
            const snap = snaps.find((s) => s.id === m[1]); if (!snap) return jerr("snapshot_missing_exception", `[backups:${m[1]}] is missing`, 404);
            const p = m[2] ? K.json(m[2]) : { ok: true, val: {} }; if (!p.ok) return jerr("json_parse_exception", p.err);
            const want = String(p.val.indices || "*");
            const targets = want === "*" ? [I.red, "audit-2026.07.13", "users"] : want.split(",");
            const exists = targets.find((t) => st.cl.indices.some((x) => x.name === t && !x.closed));
            if (exists) return jerr("snapshot_restore_exception", `[backups:${m[1]}/x2Lk] cannot restore index [${exists}] because an open index with same name already exists in the cluster. Either close or delete the existing index or restore the index under a different name by providing a rename pattern and replacement name`, 500);
            targets.forEach((t) => { let ix = st.cl.indices.find((x) => x.name === t); if (!ix) { ix = { name: t, pri: 1, rep: 0, gb: 30, docs: 18000000 }; st.cl.indices.push(ix); } ix.closed = false; st.cl.shards = st.cl.shards.filter((x) => x.i !== t); st.cl.shards.push({ i: t, s: 0, p: true, node: null }); delete st.cl.lost[t + "/0"]; ix.restoredFrom = m[1]; });
            allocate(st.cl);
            st.restored = m[1];
            return { out: pj({ accepted: true }), danger: I.lv === 2 ? `Restoring threw away ${I.lv === 2 ? "hours" : ""} of audit writes that were still on disk; the shard only needed a retry.` : I.lv === 3 ? `The snapshot is from 0${I.snapH}:12; the stale copy on es-data-2 was ${I.staleMin} minutes behind. You lost more data than necessary.` : null };
          } },
          { re: /^POST \/?([\w.-]+)\/_close$/i, use: "POST <index>/_close", desc: "close an index", run: (m, st) => { const ix = st.cl.indices.find((x) => x.name === m[1]); if (!ix) return jerr("index_not_found_exception", `no such index [${m[1]}]`, 404); ix.closed = true; return pj({ acknowledged: true, shards_acknowledged: true, indices: { [m[1]]: { closed: true } } }); } },
          { re: /^POST \/?_cluster\/reroute(\?\S*)?(?:\s+(\{.*\}))?$/i, use: "POST _cluster/reroute[?retry_failed=true] [{\"commands\": [...]}]", desc: "retry failed allocations or force a primary", run: (m, st) => {
            const q = m[1] || "";
            let danger = null;
            if (/retry_failed(=true)?/.test(q)) st.cl.shards.forEach((x) => { if (x.retries >= 5) { x.retries = 0; } });
            if (m[2]) {
              const p = K.json(m[2]); if (!p.ok) return jerr("json_parse_exception", p.err);
              for (const c of p.val.commands || []) {
                const [kind, a] = Object.entries(c)[0];
                if (!["allocate_empty_primary", "allocate_stale_primary", "allocate_replica", "move", "cancel"].includes(kind)) return jerr("parsing_exception", `[cluster_reroute] unknown command [${kind}]`);
                if (/primary/.test(kind) && a.accept_data_loss !== true) return jerr("illegal_argument_exception", `[${kind}] allocating an empty primary for [${a.index}][${a.shard || 0}] can result in data loss. Please confirm by setting the accept_data_loss parameter to true`);
                const sh = st.cl.shards.find((x) => x.i === a.index && x.s === +(a.shard || 0) && x.p);
                if (!sh) return jerr("illegal_argument_exception", `[${kind}] failed to find [${a.index}][${a.shard || 0}]`);
                if (kind === "allocate_stale_primary") {
                  const stale = st.cl.stale[a.index + "/" + (a.shard || 0)];
                  if (!stale || stale.node !== a.node) return jerr("illegal_argument_exception", `[allocate_stale_primary] No data for shard [${a.shard || 0}] of index [${a.index}] found on node [${a.node}]`);
                  sh.node = a.node; delete st.cl.lost[a.index + "/0"]; st.stalePromoted = true;
                } else if (kind === "allocate_empty_primary") {
                  sh.node = a.node; delete st.cl.lost[a.index + "/0"]; const ix = st.cl.indices.find((x) => x.name === a.index); ix.lostData = true; danger = `allocate_empty_primary created an EMPTY shard: all ${K.num(ix.docs)} audit documents in ${a.index} are gone.`;
                }
              }
            }
            allocate(st.cl);
            return danger ? { out: ack(), danger } : ack();
          } },
        );
        const sh = K.shell(defs, { sh: "console" });
        return { prompt: ">", init: { cl, restored: null }, run: (line, st) => sh.run(line, st), par: 6, motd: I.motd, cmds: ["GET _cluster/health", "GET _cat/indices?v", "GET _cat/shards?v&h=index,shard,prirep,state,node,unassigned.reason", "GET _cluster/allocation/explain", "GET _cat/snapshots/backups?v", "POST _cluster/reroute?retry_failed=true"] };
      },
      goal(st, I, a, rp) {
        const cl = st.cl;
        if (!cl.indices.some((x) => x.name === I.red)) return `${esc(I.red)} no longer exists.`;
        if (health(cl, I.red) === "red") return `${esc(I.red)} is still <b>red</b>.`;
        if (rp.danger) return "The index is back, but you lost more data than necessary (see the warnings).";
        if (I.lv === 1 && !st.restored) return "Restore the data from the snapshot.";
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["GET _cluster/allocation/explain", "GET _cat/snapshots/backups?v", `DELETE ${I.red}`, `POST _snapshot/backups/nightly-2026.07.15-${I.snapH}h/_restore {"indices": "${I.red}"}`] : I.lv === 2 ? ["GET _cluster/allocation/explain", "GET _cat/allocation?v", "POST _cluster/reroute?retry_failed=true"] : ["GET _cluster/allocation/explain", `POST _cluster/reroute {"commands": [{"allocate_stale_primary": {"index": "${I.red}", "shard": 0, "node": "es-data-2", "accept_data_loss": true}}]}`] }),
    }),
    gen(lv, R) {
      const red = `audit-2026.07.${R.pick(["14", "15"])}`;
      const snapH = R.pick([3, 4, 5]), staleMin = R.int(6, 25);
      const motd = lv === 1 ? `PAGE prod-audit: cluster RED.\nes-data-4 died at 08:41 (motherboard failure; its disks are not recoverable).\nThe audit indices are append-only; a nightly snapshot runs at 0${snapH}:00 and the ingest pipeline\nre-sends anything written after the last snapshot from its own buffer once the index accepts writes.`
        : lv === 2 ? "PAGE prod-audit: cluster RED since 06:12.\nAt 06:05 es-data-2's disk hit 100% during a merge; the on-call freed space at 06:30 by deleting a\nstray heap dump, and disk is back to 60%. Nothing else changed."
          : `PAGE prod-audit: cluster RED.\nAt 09:16 the replica of ${red} on es-data-2 dropped out of the in-sync set during a network blip and never\ncaught up. At 09:${16 + staleMin} es-data-4, holding the only in-sync copy, died (disks destroyed).\nThe ingest pipeline can re-send the last 30 minutes of events; snapshots run nightly at 0${snapH}:00.`;
      return { lv, red, snapH, staleMin, motd };
    },
    bad: (I) => [{ log: [`POST _cluster/reroute {"commands": [{"allocate_empty_primary": {"index": "${I.red}", "shard": 0, "node": "es-data-1", "accept_data_loss": true}}]}`] }, ...(I.lv >= 2 ? [{ log: [`DELETE ${I.red}`, `POST _snapshot/backups/nightly-2026.07.15-${I.snapH}h/_restore {"indices": "${I.red}"}`] }] : [{ log: [`POST _snapshot/backups/nightly-2026.07.15-${I.snapH}h/_restore {"indices": "${I.red}"}`] }])],
    text: (I) => `<p>The audit cluster is <b>red</b>: an index has no active primary and writes to it fail. Bring <code>${esc(I.red)}</code> back with the <b>least possible data loss</b>. Type <code>help</code> for the console commands.</p>`,
    hint: (I) => I.lv === 1 ? "allocation/explain will say there's no copy left. Where else does the data exist? A restore can't overwrite an open index." : I.lv === 2 ? "Read the unassigned_info: the shard didn't lose its data, the allocator gave up after repeated failures." : "Compare what each option loses: an empty primary (everything), the snapshot (since 0" + I.snapH + ":00), the stale copy (a few minutes, which the pipeline can re-send).",
    concept: "Red cluster recovery options, ranked by data loss",
    how: "A red index has a primary shard with no active copy. allocation/explain tells you why. If copies were just failing to allocate (<code>max_retry</code> after a disk-full or a bad node), <code>POST _cluster/reroute?retry_failed=true</code> recovers with no loss. If the only in-sync copy is gone for good, the options cost increasing amounts of data: <code>allocate_stale_primary</code> promotes an out-of-date copy (loses writes since it fell out of sync), restoring a snapshot loses everything since the snapshot (and needs the red index deleted or closed first), and <code>allocate_empty_primary</code> loses the whole shard. Both forced allocations need <code>accept_data_loss: true</code> for a reason.",
    rule: "Before any forced allocation, find out exactly how old each available copy is (stale shard copy, snapshot, upstream replay) and pick the newest. Replicas ≥ 1 on anything you care about.",
    why: (I) => I.lv === 1 ? `The index had 0 replicas and its only copy died with es-data-4. The newest copy is the 0${I.snapH}:00 snapshot; the pipeline re-sends later events. Delete (or close) the red index and restore it.` : I.lv === 2 ? "The disk-full failures exhausted the 5 allocation retries, so the allocator stopped trying even though the shard's files were intact and disk was fixed. retry_failed brings it back with no loss; restoring a snapshot would have thrown away hours of writes." : `The stale copy on es-data-2 is ${I.staleMin} minutes behind and the pipeline can replay 30 minutes, so allocate_stale_primary loses nothing permanently. The snapshot would lose hours; an empty primary would lose everything.`,
  });

  /* ---------- T4. Flood stage: writes blocked ---------- */
  function floodCluster(I) {
    const cl = { name: "prod-logs", nodes: mkNodes(["es-data-1", "es-data-2", "es-data-3"], { total: 3000, base: [60, 60, 60] }), indices: [], shards: [], settings: {} };
    I.idx.forEach((x) => cl.indices.push({ name: x.n, pri: 3, rep: 1, gb: x.gb, docs: Math.round(x.gb * 260000), age: x.age, write: x.write, tmp: x.tmp }));
    place(cl);
    const tgt = (I.fill / 100) * 3000;
    cl.nodes.forEach((n) => (n.disk.base += tgt - nodeUsed(cl, n)));
    return cl;
  }
  function floodUpdate(st) {
    const cl = st.cl, W = wm(cl);
    const max = Math.max(...dataNodes(cl).map((n) => nodePct(cl, n)));
    if (max >= W.flood) st.blocked = true;
    else if (max < W.high) st.blocked = false;
  }
  MORE.push({
    id: "es-flood-stage",
    name: "Writes blocked at flood stage",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => {
        const cl = floodCluster(I);
        const ilm = { mode: I.lv === 3 ? "STOPPED" : "RUNNING" };
        const runIlm = (st) => { if (st.ilm.mode !== "RUNNING") return; const gone = st.cl.indices.filter((x) => x.age > I.ret && !x.write); gone.forEach((ix) => { st.cl.indices = st.cl.indices.filter((y) => y !== ix); st.cl.shards = st.cl.shards.filter((y) => y.i !== ix.name); }); if (gone.length) st.ilmDeleted = gone.length; floodUpdate(st); };
        const defs = clusterDefs({
          deleteIndex: (ix) => (ix.write ? `${ix.name} is the current write index: you just deleted today's logs and broke ingestion.` : ix.age <= I.ret && !ix.tmp ? `${ix.name} is ${ix.age} days old, inside the ${I.ret}-day retention.` : null),
          clusterSettings: (flat) => (Object.keys(flat).some((k) => /watermark/.test(k)) ? "Raising the flood-stage watermark lets the disks fill to 100%, where nodes crash and shards get corrupted." : null),
          idxSettings: (ix, flat, st) => { if (Object.keys(flat).some((k) => /blocks/.test(k))) { st.manualUnblock = true; return Math.max(...dataNodes(st.cl).map((n) => nodePct(st.cl, n))) >= wm(st.cl).high ? "You removed the block while disks are still above the high watermark: they will hit flood stage again within minutes." : null; } return null; },
          after: (st) => floodUpdate(st),
        });
        defs.push(
          { re: /^GET \/?_ilm\/status$/i, use: "GET _ilm/status", desc: "is ILM running?", run: (m, st) => pj({ operation_mode: st.ilm.mode }) },
          { re: /^POST \/?_ilm\/start$/i, use: "POST _ilm/start", desc: "start ILM", run: (m, st) => { st.ilm.mode = "RUNNING"; runIlm(st); return ack() + (st.ilmDeleted ? `\n\n(ILM runs: ${st.ilmDeleted} indices past the delete phase are removed)` : ""); } },
          { re: /^GET \/?([\w.*-]+)\/_ilm\/explain(\?\S*)?$/i, use: "GET logs-*/_ilm/explain", desc: "lifecycle phase of each index", run: (m, st) => pj({ indices: Object.fromEntries(st.cl.indices.filter((x) => !x.tmp).slice(0, 6).map((x) => [x.name, { index: x.name, managed: true, policy: "logs-30d", age: x.age + "d", phase: x.write ? "hot" : x.age > I.ret ? "delete" : "warm", action: x.age > I.ret ? "delete" : x.write ? "rollover" : "complete", step: x.age > I.ret ? "wait-for-shard-history-leases" : x.write ? "check-rollover-ready" : "complete" }])) }) + "\n... (truncated)" },
          { re: /^POST \/?logs\/_doc(?:\s+(\{.*\}))?$/i, use: "POST logs/_doc {\"message\": \"test\"}", desc: "test a write", run: (m, st) => (st.blocked ? jerr("cluster_block_exception", `index [${I.idx.find((x) => x.write).n}] blocked by: [TOO_MANY_REQUESTS/12/disk usage exceeded flood-stage watermark, index has read-only-allow-delete block; for more information, see https://ela.st/es-req-flood-stage];`, 429) : pj({ _index: I.idx.find((x) => x.write).n, _id: "Zt8kq5ABc1", result: "created" })) },
        );
        const sh = K.shell(defs, { sh: "console" });
        return { prompt: ">", init: { cl, ilm, blocked: true }, run: (line, st) => sh.run(line, st), par: I.lv === 1 ? 6 : 7, motd: I.motd, cmds: ["GET _cluster/health", "GET _cat/allocation?v", "GET _cat/indices?v&s=index", 'POST logs/_doc {"message": "test"}', "GET _ilm/status", "DELETE <index>"] };
      },
      goal(st, I, a, rp) {
        floodUpdate(st);
        if (st.blocked) return `Writes are still blocked: the nodes are at ${dataNodes(st.cl).map((n) => Math.round(nodePct(st.cl, n)) + "%").join(", ")} (the block lifts automatically below the ${wm(st.cl).high}% high watermark).`;
        if (rp.danger) return "Writes flow again, but at a cost (see the warnings).";
        if (I.lv === 3 && st.ilm.mode !== "RUNNING") return "Writes flow, but ILM is still stopped: nothing will be deleted and you'll be back here in a few days.";
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["GET _cat/allocation?v", "GET _cat/indices?v&s=index", "DELETE " + I.idx.filter((x) => x.age > I.ret && !x.write).map((x) => x.n).join(",")] : I.lv === 2 ? ["GET _cat/allocation?v", "GET _cat/indices?v&s=index", "DELETE " + I.idx.find((x) => x.tmp).n] : ["GET _cat/allocation?v", "GET _ilm/status", "POST _ilm/start"] }),
    }),
    gen(lv, R) {
      const ret = lv === 1 ? 14 : 30;
      const idx = [];
      const n = lv === 1 ? 30 : lv === 2 ? 30 : 44;
      for (let a = 0; a < n; a++) idx.push({ n: `logs-app-${String(200 - a).padStart(6, "0")}`, gb: R.int(42, 50), age: a, write: a === 0 });
      if (lv === 2) idx.push({ n: "logs-app-reindex-test-" + R.pick(["jul", "tmp", "copy"]), gb: R.int(520, 600), age: 9, tmp: true });
      const fill = 95.4 + R.next() * 1.5;
      const I = { lv, ret, idx, fill };
      // check: required deletions bring every node below 90%
      const cl = floodCluster(I);
      const del = lv === 1 ? idx.filter((x) => x.age > ret) : lv === 2 ? idx.filter((x) => x.tmp) : idx.filter((x) => x.age > ret && !x.write);
      const c = K.clone(cl); del.forEach((x) => { c.shards = c.shards.filter((s) => s.i !== x.n); c.indices = c.indices.filter((y) => y.name !== x.n); });
      if (Math.max(...dataNodes(c).map((nn) => nodePct(c, nn))) >= 89) return null;
      if (lv === 2) { const c2 = K.clone(cl); idx.filter((x) => x.age > 26 && !x.write).forEach((x) => { c2.shards = c2.shards.filter((s) => s.i !== x.n); c2.indices = c2.indices.filter((y) => y.name !== x.n); }); if (Math.max(...dataNodes(c2).map((nn) => nodePct(c2, nn))) < 90) return null; }
      I.motd = lv === 1 ? `PAGE prod-logs: ingestion failing with HTTP 429 cluster_block_exception.\nRetention: ${ret} days (ILM isn't set up on this cluster yet; old indices are deleted by hand).`
        : lv === 2 ? `PAGE prod-logs: ingestion failing with HTTP 429 cluster_block_exception.\nRetention: ${ret} days, enforced by ILM (policy logs-30d). Last week the team tested a reindex of the app logs.`
          : `PAGE prod-logs: ingestion failing with HTTP 429 cluster_block_exception.\nRetention: ${ret} days, enforced by ILM. Ten days ago ILM was paused during a cluster upgrade.`;
      return I;
    },
    bad: (I) => [{ log: ['PUT _cluster/settings {"persistent": {"cluster.routing.allocation.disk.watermark.flood_stage": "99%"}}', `PUT logs-app-*/_settings {"index.blocks.read_only_allow_delete": null}`] }, { log: ["DELETE " + I.idx.find((x) => x.write).n] }, ...(I.lv === 3 ? [{ log: I.idx.filter((x) => x.age > I.ret).map((x) => "DELETE " + x.n) }] : []), ...(I.lv === 2 ? [{ log: I.idx.filter((x) => x.age >= 25 && !x.tmp).map((x) => "DELETE " + x.n) }] : [])],
    text: (I) => `<p>Log ingestion is failing:</p>${K.pre(`HTTP 429 cluster_block_exception: index [${I.idx[0].n}] blocked by: [TOO_MANY_REQUESTS/12/disk usage exceeded flood-stage watermark, index has read-only-allow-delete block]`)}<p>Restore writes without losing logs inside the <b>${I.ret}-day</b> retention window${I.lv === 3 ? ", and make sure this doesn't come back" : ""}. Type <code>help</code> for the console commands.</p>`,
    hint: (I) => I.lv === 1 ? "Which indices are older than the retention period? The block is released automatically once every node is below the high watermark." : I.lv === 2 ? "ILM is deleting on schedule, so something else is eating the disk. Sort the indices by size, not by name." : "Look at the ILM status. Deleting by hand works today, but what deletes tomorrow's expired index?",
    concept: "Disk watermarks and the flood-stage block",
    how: "Elasticsearch protects nodes from full disks with three watermarks: above <b>low</b> (85%) no new shards are allocated to the node, above <b>high</b> (90%) shards are moved away, and at <b>flood stage</b> (95%) every index with a shard on that node gets an <code>index.blocks.read_only_allow_delete</code> block, so writes fail with 429 while reads and deletes still work. Since 7.4 the block is removed automatically once the node drops below the high watermark. The fix is freeing space (delete expired indices, stray copies) or adding capacity; raising the watermarks only postpones a much worse failure at 100%.",
    rule: "Free disk by deleting what retention allows (largest offenders first), let the block lift itself, then fix whatever stopped cleanup: an ILM policy, a stopped ILM, or a forgotten test index.",
    why: (I) => I.lv === 1 ? `${I.idx.filter((x) => x.age > I.ret).length} indices were older than the ${I.ret}-day retention. Deleting them dropped every node below 90% and the block lifted on its own.` : I.lv === 2 ? `ILM was deleting on schedule; a ${I.idx.find((x) => x.tmp).gb} GB reindex test copy (×2 with its replica) pushed the nodes over 95%. Deleting it is enough; deleting in-retention logs is not acceptable.` : `ILM had been STOPPED since the upgrade, so ${I.idx.filter((x) => x.age > I.ret).length} indices past the delete phase piled up. POST _ilm/start lets ILM delete them and keeps doing so tomorrow.`,
  });

  /* ---------- T5. Hot node ---------- */
  function hotCluster(I, st) {
    const cl = st ? st.cl : null;
    void cl;
  }
  void hotCluster;
  function hotModel(I) {
    const nodes = mkNodes(I.nodes, { total: 2000 });
    const cl = { name: "prod-search", nodes, indices: [{ name: I.index, pri: I.pri, rep: I.rep0, gb: I.pri * 20, docs: 50000000 }, ...I.others.map((o) => ({ name: o.n, pri: o.pri, rep: 1, gb: o.pri * 10, docs: 8000000 }))], shards: [], settings: {} };
    place(cl, I.offset);
    if (I.lv === 2) {
      // after a restart, es-data-2 got 3 of the 6 primaries and rebalancing was disabled
      cl.settings["cluster.routing.rebalance.enable"] = "none";
      cl.shards.filter((x) => x.i === I.index).forEach((x, k) => (x.node = k < 3 ? I.nodes[1] : I.nodes[[0, 2, 3][k - 3] % I.nodes.length]));
    }
    return cl;
  }
  function rebalance(cl) {
    if (cl.settings["cluster.routing.rebalance.enable"] === "none") return;
    // move copies of the busiest index from crowded nodes to the emptiest ones
    for (let it = 0; it < 20; it++) {
      const dn = dataNodes(cl), count = (n) => cl.shards.filter((x) => x.node === n.name).length;
      dn.sort((a, b) => count(b) - count(a));
      const hi = dn[0], lo = dn[dn.length - 1];
      if (count(hi) - count(lo) <= 1) return;
      const mv = cl.shards.find((x) => x.node === hi.name && !cl.shards.some((y) => y.i === x.i && y.s === x.s && y.node === lo.name));
      if (!mv) return;
      mv.node = lo.name;
    }
  }
  function cpuOf(I, cl) {
    const cpu = {};
    dataNodes(cl).forEach((n) => (cpu[n.name] = 9));
    cl.indices.forEach((ix) => {
      const share = ix.name === I.index ? I.searchShare : (1 - I.searchShare) / Math.max(1, I.others.length);
      for (let s = 0; s < ix.pri; s++) {
        const copies = cl.shards.filter((x) => x.i === ix.name && x.s === s && x.node);
        const w = ix.name === I.index && I.skew ? (s === I.hotShard ? I.skew : (1 - I.skew) / (ix.pri - 1)) : 1 / ix.pri;
        copies.forEach((c) => (cpu[c.node] += (I.load * share * w) / copies.length));
      }
    });
    return cpu;
  }
  MORE.push({
    id: "es-hot-node",
    name: "One node at 95% CPU",
    kind: "Incident",
    skills: ["diagnose", "tune"],
    ...LB.term({
      shell: (I) => {
        const cl = hotModel(I);
        const upd = (st) => { rebalance(st.cl); const c = cpuOf(I, st.cl); st.cl.nodes.forEach((n) => (n.cpu = c[n.name] != null ? Math.min(100, c[n.name]) : 0)); };
        const defs = clusterDefs({ after: upd, idxSettings: (ix, flat, st) => { upd(st); return flat["index.number_of_replicas"] != null && +flat["index.number_of_replicas"] > dataNodes(st.cl).length - 1 ? null : null; } });
        defs.push(
          { re: /^GET \/?_nodes\/hot_threads(\?\S*)?$/i, use: "GET _nodes/hot_threads", desc: "busiest threads per node", run: (m, st) => { const hot = st.cl.nodes.slice().sort((a, b) => b.cpu - a.cpu)[0]; return `::: {${hot.name}}{Kq1x7}{${ipOf(st.cl.nodes.indexOf(hot))}}\n   Hot threads at 2026-07-15T10:02:11.004Z, interval=500ms, busiestThreads=3:\n   ${Math.round(hot.cpu * 0.9)}.4% [cpu=${Math.round(hot.cpu * 0.9)}.4%, other=0.0%] (${Math.round(hot.cpu * 4.5)}ms out of 500ms) cpu usage by thread 'elasticsearch[${hot.name}][search][T#7]'\n     org.apache.lucene.search.TermScorer.score(...)\n     org.elasticsearch.search.query.QueryPhase.execute(...)\n   (other nodes: < 25% busy, mostly idle threads)`; } },
          { re: /^GET \/?_cat\/thread_pool(?:\/search)?(\?\S*)?$/i, use: "GET _cat/thread_pool/search?v", desc: "search queue and rejections per node", run: (m, st) => K.cols([["node_name", "name", "active", "queue", "rejected"], ...dataNodes(st.cl).map((n) => [n.name, "search", n.cpu > 85 ? 13 : Math.round(n.cpu / 8), n.cpu > 85 ? Math.round((n.cpu - 80) * 40) : 0, n.cpu > 85 ? 1840 : 0])]) },
          { re: /^GET \/?([\w-]+)\/_search_shards(\?\S*)?$/i, use: "GET <index>/_search_shards?routing=<value>", desc: "which shard a routing value goes to", run: (m) => (m[1] === I.index && /routing=/.test(m[2] || "") ? pj({ shards: [[{ index: I.index, shard: I.hotShard, primary: true }]] }) : jerr("illegal_argument_exception", "add ?routing=<value>")) },
          { re: /^GET \/?([\w-]+)\/_stats\/search(\?\S*)?$/i, use: "GET <index>/_stats/search?level=shards", desc: "query counts per shard", run: (m, st) => { if (m[1] !== I.index) return jerr("index_not_found_exception", `no such index [${m[1]}]`, 404); const rows = []; for (let s = 0; s < I.pri; s++) { const w = I.skew ? (s === I.hotShard ? I.skew : (1 - I.skew) / (I.pri - 1)) : 1 / I.pri; rows.push([s, Math.round(w * 8.4e6)]); } return K.cols([["shard", "query_total (all copies, last hour)"], ...rows]); } },
        );
        const sh = K.shell(defs, { sh: "console" });
        const init = { cl };
        upd(init);
        return { prompt: ">", init, run: (line, st) => sh.run(line, st), par: 6, motd: I.motd, cmds: ["GET _cat/nodes?v", "GET _cat/shards/" + I.index + "?v", "GET _cat/thread_pool/search?v", "GET _nodes/hot_threads", "GET _cluster/settings", `GET ${I.index}/_stats/search?level=shards`], opts: I.opts, optq: "Root cause" };
      },
      goal(st, I, a) {
        rebalance(st.cl);
        const c = cpuOf(I, st.cl), mx = Math.max(...Object.values(c));
        if (health(st.cl) !== "green") return `The cluster is ${health(st.cl)}: more replicas than nodes can hold.`;
        if (mx > 75) return `The busiest node is still at ${Math.round(Math.min(100, mx))}% CPU (target: under 75%).`;
        if (a.pick !== I.ans) return "Load is down, but that's not the root cause.";
        const ix = st.cl.indices.find((x) => x.name === I.index);
        if (ix.rep > I.maxRep) return `${ix.rep} replicas works, but each one multiplies indexing work and disk; ${I.maxRep} is enough here.`;
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["GET _cat/nodes?v", `GET _cat/shards/${I.index}?v`, `PUT ${I.index}/_settings {"index.number_of_replicas": ${I.fixRep}}`] : I.lv === 2 ? ["GET _cat/nodes?v", `GET _cat/shards/${I.index}?v`, "GET _cluster/settings", 'PUT _cluster/settings {"persistent": {"cluster.routing.rebalance.enable": null}}'] : ["GET _cat/nodes?v", `GET ${I.index}/_stats/search?level=shards`, `PUT ${I.index}/_settings {"index.number_of_replicas": ${I.fixRep}}`], pick: I.ans }),
    }),
    gen(lv, R) {
      const nodes = ["es-data-1", "es-data-2", "es-data-3", "es-data-4", "es-data-5", "es-data-6"];
      const index = R.pick(["catalog", "listings", "offers"]);
      let I;
      if (lv === 1) I = { lv, nodes, index, pri: 1, rep0: 1, others: [{ n: "users", pri: 2 }, { n: "reviews", pri: 3 }], searchShare: 0.8, load: R.int(260, 300), offset: R.int(0, 5) };
      else if (lv === 2) I = { lv, nodes: nodes.slice(0, 4), index, pri: 6, rep0: 0, others: [{ n: "users", pri: 2 }], searchShare: 0.85, load: R.int(170, 200), offset: 0 };
      else I = { lv, nodes, index, pri: 6, rep0: 1, others: [{ n: "users", pri: 2 }, { n: "reviews", pri: 3 }], searchShare: 0.8, load: R.int(260, 300), skew: 0.45, hotShard: R.int(0, 5), offset: R.int(0, 5) };
      // find the smallest replica count that brings max cpu under 75
      const test = (rep) => { const cl = hotModel(I); cl.indices[0].rep = rep; allocate(cl); rebalance(cl); return Math.max(...Object.values(cpuOf(I, cl))); };
      if (lv !== 2) { let r = I.rep0; while (r < 5 && test(r) > 75) r++; if (test(r) > 75 || r === I.rep0) return null; I.fixRep = r; I.maxRep = Math.min(5, r + 1); }
      else { const cl = hotModel(I); delete cl.settings["cluster.routing.rebalance.enable"]; rebalance(cl); if (Math.max(...Object.values(cpuOf(I, cl))) > 75) return null; const cl0 = hotModel(I); if (Math.max(...Object.values(cpuOf(I, cl0))) < 80) return null; I.maxRep = 1; }
      const opts = lv === 1 ? ["The index has 1 primary and 1 replica, so only 2 of 6 nodes can serve its searches", "The JVM heap on the hot node is too small", "A slow query from one client", "The hot node has a failing disk"]
        : lv === 2 ? ["Rebalancing was left disabled after maintenance, so one node holds half of the index's shards", "The index needs more primary shards", "The hot node's disk is above the low watermark", "Adaptive replica selection is disabled"]
          : [`Custom routing sends one huge tenant's traffic to a single shard (${I.hotShard}) and its copies`, "The index has too few primary shards for 6 nodes", "Rebalancing is disabled", "The hot nodes run an older JVM"];
      const order = R.shuffle([0, 1, 2, 3]);
      I.opts = order.map((k) => opts[k]); I.ans = order.indexOf(0);
      I.motd = lv === 1 ? `PAGE prod-search: ${index} search p99 1.8 s (SLO 300 ms), search rejections on two nodes.\nTraffic doubled after a marketing campaign. 6 data nodes, 4 of them nearly idle.`
        : lv === 2 ? `PAGE prod-search: one data node at ~95% CPU since last night's rolling restart.\n${index} search p99 up 4x. The other three nodes are mostly idle.`
          : `PAGE prod-search: two nodes pinned at ~95% CPU, the others at 30%.\n${index} is routed by tenant_id (routing=tenant_id) for per-tenant queries. Yesterday the biggest\ncustomer onboarded 40% of their stores.`;
      return I;
    },
    bad: (I) => [{ log: [`PUT ${I.index}/_settings {"index.number_of_replicas": ${I.lv === 2 ? 0 : I.rep0}}`], pick: I.ans }, { log: I.lv === 1 ? [`PUT ${I.index}/_settings {"index.number_of_replicas": 5}`] : I.lv === 2 ? [`PUT ${I.index}/_settings {"index.number_of_replicas": 1}`] : [`PUT ${I.index}/_settings {"index.number_of_replicas": ${I.fixRep}}`], pick: (I.ans + 1) % 4 }],
    text: (I) => `<p>${I.lv === 1 ? "Search latency is way over SLO and a couple of nodes reject searches while the rest idle." : I.lv === 2 ? "One data node is pinned at ~95% CPU." : "Two data nodes are pinned at ~95% CPU while the rest idle."} Find out why and bring every node under <b>75% CPU</b> with a setting change you can make right now. Then name the root cause. Type <code>help</code> for the console commands.</p>`,
    hint: (I) => I.lv === 1 ? "A search hits one copy of each shard. How many nodes hold a copy of this index's single shard?" : I.lv === 2 ? "Count the index's shards per node, then look at the cluster settings left over from the restart." : "Compare query counts per shard. A replica count increase spreads one shard's reads over more nodes; the real fix (routing_partition_size or a dedicated index for the tenant) needs a reindex.",
    concept: "Hot spots: copies, balance and routing",
    how: "Each search runs on one copy (primary or replica) of every shard, chosen by adaptive replica selection, so a shard's read load can only spread across its copies. An index with 1 primary and 1 replica can use exactly two nodes, however many you have. Shard balancing counts shards, not load: if <code>cluster.routing.rebalance.enable</code> is left at none after maintenance, a restarted node can keep an unfair share. Custom routing puts all of one routing value's documents in one shard, so a giant tenant makes that shard and its copies hot. More replicas spread reads (at the cost of indexing work and disk); fixing skew needs <code>index.routing_partition_size</code> or a separate index, which means reindexing.",
    rule: "For read-heavy hot spots, check copies per shard and shards per node first; add replicas to spread reads, re-enable rebalancing after maintenance, and don't route by a key with one dominant value.",
    why: (I) => I.lv === 1 ? `${esc(I.index)} had one shard and two copies, so all its searches landed on 2 of 6 nodes. number_of_replicas: ${I.fixRep} gives the shard ${I.fixRep + 1} copies on different nodes.` : I.lv === 2 ? `After the restart, es-data-2 held 3 of the 6 shards of ${esc(I.index)} and rebalance.enable was still none from the maintenance runbook. Resetting it to the default (all) moved shards back and spread the load.` : `Shard ${I.hotShard} received ~45% of all queries because of the big tenant's routing value. ${I.fixRep} replicas spread its reads over ${I.fixRep + 1} nodes as a stopgap; long-term, use routing_partition_size or give that tenant its own index.`,
  });

  /* ---------- T6. Circuit breakers ---------- */
  MORE.push({
    id: "es-circuit-breaker",
    name: "Data too large: the circuit breaker",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => {
        const sh = K.shell([
          { re: /^GET \/?_nodes\/stats\/breaker(\?\S*)?$/i, use: "GET _nodes/stats/breaker", desc: "breaker limits and estimates per node", run: (m, st) => pj({ nodes: { "Kq1x7": { name: "es-data-2", breakers: { request: { limit_size: "6gb", estimated_size: st.task ? I.reqEst : "12.1mb", tripped: I.lv === 3 ? 214 : 0 }, fielddata: { limit_size: "6gb", estimated_size: st.fd ? I.fdEst : "0b", tripped: I.lv < 3 ? 381 : 0 }, in_flight_requests: { limit_size: "15gb", estimated_size: "1.2mb", tripped: 0 }, parent: { limit_size: "14.2gb", estimated_size: st.task ? "14.1gb" : st.fd ? "11.8gb" : "5.2gb", tripped: I.lv === 3 ? 97 : 0 } } } } }) },
          { re: /^GET \/?_cat\/fielddata(\?\S*)?$/i, use: "GET _cat/fielddata?v&fields=*", desc: "fielddata memory per node and field", run: (m, st) => K.cols([["id", "host", "ip", "node", "field", "size"], ...(st.fd ? I.fdFields : []).flatMap(([f, s]) => [["Kq1x7", "10.0.1.11", "10.0.1.11", "es-data-2", f, s], ["Pz0a2", "10.0.1.12", "10.0.1.12", "es-data-3", f, s]])]) },
          { re: /^GET \/?([\w*.-]+)\/_mapping\/field\/(\S+)$/i, use: "GET logs-*/_mapping/field/<field>", desc: "mapping of one field", run: (m) => { const f = m[2]; const fd = I.fdFields.some(([x]) => x === f) && I.lv < 3; return pj({ "logs-2026.07.15": { mappings: { [f]: { full_name: f, mapping: { [f.split(".").pop()]: fd ? { type: "text", fielddata: true } : /keyword|id$/.test(f) ? { type: "keyword" } : { type: "text" } } } } } }); } },
          { re: /^POST \/?([\w*.-]+)\/_cache\/clear(\?\S*)?$/i, use: "POST logs-*/_cache/clear?fielddata=true", desc: "drop cached fielddata", run: (m, st) => { if (/fielddata=true/.test(m[2] || "") || !m[2]) st.fd = false; st.cleared = true; return pj({ _shards: { total: 60, successful: 60, failed: 0 } }); } },
          { re: /^GET \/?_tasks(\?\S*)?$/i, use: "GET _tasks?actions=*search*&detailed", desc: "running tasks", run: (m, st) => { const t = []; if (st.task) t.push([I.taskId, "indices:data/read/search", "transport", `${I.taskMin}m`, I.taskDesc]); t.push(["Kq1x7:88120", "indices:data/read/search", "transport", "212ms", 'indices[logs-*], search_type[QUERY_THEN_FETCH], source[{"size":50,"query":{"bool":{"filter":[...]}}}]']); t.push(["Pz0a2:7712", "indices:data/write/bulk", "transport", "48ms", "requests[1000], indices[logs-2026.07.15]"]); return K.cols([["task_id", "action", "type", "running_time", "description"], ...t]); } },
          { re: /^POST \/?_tasks\/(\S+)\/_cancel$/i, use: "POST _tasks/<task_id>/_cancel", desc: "cancel a running task", run: (m, st) => { if (m[1] === I.taskId && st.task) { st.task = false; return pj({ nodes: { Kq1x7: { tasks: { [I.taskId]: { action: "indices:data/read/search", cancellable: true, cancelled: true } } } } }); } if (m[1] === "Pz0a2:7712") return { out: pj({ nodes: {} }), danger: "You cancelled a live ingestion bulk request." }; if (m[1] === "Kq1x7:88120") return { out: pj({ nodes: {} }), danger: "That was an ordinary user search." }; return jerr("resource_not_found_exception", `task [${m[1]}] is missing`, 404); } },
          { re: /^PUT \/?_cluster\/settings(?:\s+(\{.*\}))?$/i, use: "PUT _cluster/settings {\"persistent\": {...}}", desc: "change cluster settings", run: (m, st) => { const p = K.json(m[1] || ""); if (!p.ok) return jerr("json_parse_exception", p.err || "body required"); st.raised = /breaker/.test(m[1]); return st.raised ? { out: ack(), danger: "Raising breaker limits trades a clean error for an OutOfMemoryError that kills the node." } : ack(); } },
          { re: /^PUT \/?([\w*.-]+)\/_mapping(?:\s+(\{.*\}))?$/i, use: "PUT logs-*/_mapping {\"properties\": {...}}", desc: "update a mapping", run: (m, st) => { if (/fielddata"\s*:\s*false/.test(m[2] || "")) { st.fdOff = true; return ack(); } return ack(); } },
        ], { sh: "console" });
        return { prompt: ">", init: { fd: I.lv < 3, task: I.lv === 3, cleared: false, raised: false }, run: (line, st) => sh.run(line, st), par: 6, motd: I.motd, cmds: ["GET _nodes/stats/breaker", "GET _cat/fielddata?v&fields=*", "GET _tasks?actions=*search*&detailed", "POST logs-*/_cache/clear?fielddata=true", "POST _tasks/<task_id>/_cancel"], opts: I.opts, optq: "Root cause" };
      },
      goal(st, I, a, rp) {
        if (rp.danger) return "Pressure is gone, but see the warnings above.";
        if (I.lv < 3 && st.fd) return "Fielddata is still occupying the heap; the breaker keeps tripping.";
        if (I.lv === 3 && st.task) return "The runaway request is still running and holding the request breaker.";
        if (a.pick !== I.ans) return "Memory is back to normal, but that's not the root cause.";
        return true;
      },
      solve: (I) => ({ log: I.lv < 3 ? ["GET _nodes/stats/breaker", "GET _cat/fielddata?v&fields=*", "POST logs-*/_cache/clear?fielddata=true"] : ["GET _nodes/stats/breaker", "GET _tasks?actions=*search*&detailed", `POST _tasks/${I.taskId}/_cancel`], pick: I.ans }),
    }),
    gen(lv, R) {
      const field = lv === 1 ? "message" : R.pick(["user_agent", "url.path", "error.stack"]);
      const fdFields = lv === 1 ? [["message", "5.8gb"]] : [["message", "210mb"], [field, "5.6gb"]];
      const taskId = `Kq1x7:${R.int(10000, 99999)}`;
      const I = { lv, field, fdFields, fdEst: lv === 1 ? "5.8gb" : "5.8gb", reqEst: "5.9gb", taskId, taskMin: R.int(9, 25) };
      I.taskDesc = `indices[logs-*], source[{"size":0,"aggs":{"by_session":{"terms":{"field":"session_id","size":${R.pick([500000, 1000000, 2000000])}}}}}]`;
      const opts = lv === 1 ? ["fielddata: true on the text field message, loaded by a dashboard aggregating on it", "The request breaker limit is too low for normal searches", "A bulk request larger than http.max_content_length", "Too many shards on es-data-2"]
        : lv === 2 ? [`fielddata: true on the text field ${field}, loaded by a dashboard aggregating on it`, "fielddata on message", "Too many concurrent searches", "The parent breaker uses real memory accounting"]
          : ["A terms aggregation on session_id with an enormous size, building millions of buckets in the request breaker", "Fielddata on a text field", "Indexing pressure from bulk requests", "Too many shards per node"];
      const order = R.shuffle([0, 1, 2, 3]);
      I.opts = order.map((k) => opts[k]); I.ans = order.indexOf(0);
      I.motd = lv < 3 ? `PAGE prod-logs: dashboards and searches failing with\n  circuit_breaking_exception: [fielddata] Data too large, data for [${field}] would be [6.2gb],\n  which is larger than the limit of [6gb]\nHeap on es-data-2/3 at 88%.` : "PAGE prod-logs: searches failing with\n  circuit_breaking_exception: [parent] Data too large, data for [<http_request>] would be [14.3gb],\n  which is larger than the limit of [14.2gb], usages [request=5.9gb, fielddata=0b, in_flight_requests=1.2mb]\nStarted 15 minutes ago; a data scientist mentioned an export.";
      return I;
    },
    bad: (I) => [{ log: ['PUT _cluster/settings {"persistent": {"indices.breaker.fielddata.limit": "80%", "indices.breaker.request.limit": "80%"}}'], pick: I.ans }, { log: I.lv < 3 ? ["GET _cat/fielddata?v&fields=*"] : ["POST _tasks/Pz0a2:7712/_cancel"], pick: I.ans }, { log: (I.lv < 3 ? ["POST logs-*/_cache/clear?fielddata=true"] : [`POST _tasks/${I.taskId}/_cancel`]), pick: (I.ans + 1) % 4 }],
    text: (I) => `<p>${I.lv < 3 ? "Searches and dashboards fail with a <b>fielddata</b> circuit breaker error." : "Searches fail with a <b>parent</b> circuit breaker error."} Relieve the memory pressure without risking the nodes, and name the root cause. Type <code>help</code> for the console commands.</p>`,
    hint: (I) => I.lv === 1 ? "Which field holds the fielddata? Text fields only have fielddata if someone enabled it." : I.lv === 2 ? "Check which field is actually big in _cat/fielddata; the error names only the request that tripped." : "The usages list shows which child breaker holds the memory. The tasks API shows what is running.",
    concept: "Circuit breakers: fielddata, request and parent",
    how: "Circuit breakers estimate memory before an operation allocates it and reject the request with a 429 <code>circuit_breaking_exception</code> instead of letting the JVM run out of heap. The <b>fielddata</b> breaker (40% of heap by default) guards the on-heap structure built by un-inverting a text field with <code>fielddata: true</code> to sort or aggregate on it; keyword fields use on-disk doc values and don't need it. The <b>request</b> breaker (60%) covers per-request structures such as aggregation buckets. The <b>parent</b> breaker (95% of heap with real-memory accounting) trips when total usage is too high and lists every child's usage. Raising limits turns a clean error into an OutOfMemoryError.",
    rule: "Read which breaker tripped and its usages, remove the cause (clear and disable fielddata on text fields, cancel or fix the oversized aggregation), and never raise breaker limits as a fix.",
    why: (I) => I.lv < 3 ? `${esc(I.field)} was mapped with fielddata: true and a dashboard aggregated on it, loading ${I.fdFields.find(([f]) => f === I.field)[1]} per node onto the heap. Clearing the fielddata cache relieves it now; the real fix is aggregating on a keyword field and turning fielddata off.` : `The export's terms aggregation asked for hundreds of thousands of session_id buckets in one response, holding 5.9 GB in the request breaker. Cancelling task ${esc(I.taskId)} frees it; the export should use a composite aggregation with pagination.`,
  });


  /* ---------- T7. Runaway tasks ---------- */
  MORE.push({
    id: "es-runaway-task",
    name: "Find and stop the runaway task",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => {
        const load = (st) => 22 + st.tasks.reduce((s, t) => s + (t.kind === "ubq" ? (t.rps < 0 ? 70 : Math.min(70, (t.rps / 9000) * 70)) : t.cpu), 0);
        const sh = K.shell([
          { re: /^GET \/?_cat\/nodes(\?\S*)?$/i, use: "GET _cat/nodes?v", desc: "nodes and cpu", run: (m, st) => K.cols([["ip", "heap.percent", "cpu", "load_1m", "node.role", "master", "name"], ...[1, 2, 3, 4].map((k) => [ipOf(k), 55 + k * 3, Math.min(99, Math.round(load(st) - k * 2)), (load(st) / 10).toFixed(2), "cdfhilmrstw", k === 1 ? "*" : "-", "es-data-" + k])]) },
          { re: /^GET \/?_cat\/thread_pool(?:\/([\w,]+))?(\?\S*)?$/i, use: "GET _cat/thread_pool/search,write?v", desc: "active / queue / rejected per pool", run: (m, st) => { const L = load(st), ubq = st.tasks.find((t) => t.kind === "ubq"); return K.cols([["node_name", "name", "active", "queue", "rejected"], ...[1, 2, 3, 4].flatMap((k) => [["es-data-" + k, "search", L > 85 ? 13 : 3, L > 85 && !ubq ? 900 + k * 37 : 0, L > 85 && !ubq ? 2210 + k * 101 : 0], ["es-data-" + k, "write", ubq && L > 85 ? 9 : 2, ubq && L > 85 ? 10000 : 0, ubq && L > 85 ? 4100 + k * 77 : 0]])]); } },
          { re: /^GET \/?_tasks(\?\S*)?$/i, use: "GET _tasks?detailed&actions=*search*,*byquery*", desc: "running tasks with descriptions", run: (m, st) => K.cols([["task_id", "action", "running_time", "cancellable", "description"], ...st.tasks.map((t) => [t.id, t.action, t.time, "true", t.desc]), ["Pz0a2:7712", "indices:data/write/bulk", "41ms", "false", "requests[500], indices[orders]"]]) },
          { re: /^GET \/?_tasks\/(\S+)$/i, use: "GET _tasks/<task_id>", desc: "one task's status", run: (m, st) => { const t = st.tasks.find((x) => x.id === m[1]); if (!t) return jerr("resource_not_found_exception", `task [${m[1]}] isn't running and hasn't stored its results`, 404); return pj({ completed: false, task: { node: t.id.split(":")[0], id: +t.id.split(":")[1], action: t.action, description: t.desc, running_time_in_nanos: 1, cancellable: true, ...(t.kind === "ubq" ? { status: { total: I.total, updated: I.done, batches: Math.round(I.done / 1000), requests_per_second: t.rps, throttled_millis: 0 } } : {}) } }); } },
          { re: /^POST \/?_tasks\/(\S+)\/_cancel$/i, use: "POST _tasks/<task_id>/_cancel", desc: "cancel a task", run: (m, st) => { const t = st.tasks.find((x) => x.id === m[1]); if (!t) return m[1] === "Pz0a2:7712" ? jerr("illegal_argument_exception", "task [Pz0a2:7712] doesn't support cancellation") : jerr("resource_not_found_exception", `task [${m[1]}] is missing`, 404); st.tasks = st.tasks.filter((x) => x !== t); st.cancelled.push(t.kind); return { out: pj({ nodes: { [t.id.split(":")[0]]: { tasks: { [t.id]: { action: t.action, cancellable: true, cancelled: true } } } } }), danger: t.danger || null }; } },
          { re: /^POST \/?_(update_by_query|reindex|delete_by_query)\/(\S+)\/_rethrottle\?requests_per_second=(-?[\d.]+)$/i, use: "POST _update_by_query/<task_id>/_rethrottle?requests_per_second=<n>", desc: "change a by-query task's throttle", run: (m, st) => { const t = st.tasks.find((x) => x.id === m[2]); if (!t || t.kind !== "ubq") return jerr("resource_not_found_exception", `task [${m[2]}] is missing`, 404); t.rps = +m[3]; return pj({ nodes: { [t.id.split(":")[0]]: { tasks: { [t.id]: { action: t.action, status: { requests_per_second: t.rps } } } } } }); } },
        ], { sh: "console" });
        return { prompt: ">", init: { tasks: K.clone(I.tasks), cancelled: [] }, run: (line, st) => sh.run(line, st), par: 5, motd: I.motd, cmds: ["GET _cat/nodes?v", "GET _cat/thread_pool/search,write?v", "GET _tasks?detailed&actions=*search*,*byquery*", "POST _tasks/<task_id>/_cancel", "POST _update_by_query/<task_id>/_rethrottle?requests_per_second=<n>"] };
      },
      goal(st, I, a, rp) {
        if (rp.danger) return "Load is down, but see the warnings above.";
        const bad = st.tasks.find((t) => t.bad);
        if (bad) return "The runaway work is still running.";
        if (I.lv === 3) {
          const t = st.tasks.find((x) => x.kind === "ubq");
          if (!t) return "The backfill was cancelled: half the documents have the new field and half don't, and the migration deadline is tomorrow morning.";
          if (t.rps < 0 || t.rps > I.maxRps) return `The backfill still runs at ${t.rps < 0 ? "unlimited" : t.rps + " docs/s"}; writes keep being rejected above about ${I.maxRps}/s.`;
          if ((I.total - I.done) / t.rps > I.hoursLeft * 3600) return `At ${t.rps}/s the remaining ${K.num(I.total - I.done)} documents need ${((I.total - I.done) / t.rps / 3600).toFixed(1)} h, past the ${I.hoursLeft} h deadline.`;
        }
        return true;
      },
      solve: (I) => ({ log: I.lv < 3 ? ["GET _cat/thread_pool/search,write?v", "GET _tasks?detailed&actions=*search*,*byquery*", `POST _tasks/${I.tasks.find((t) => t.bad).id}/_cancel`] : ["GET _cat/thread_pool/search,write?v", "GET _tasks?detailed&actions=*search*,*byquery*", `POST _update_by_query/${I.tasks[0].id}/_rethrottle?requests_per_second=${I.goodRps}`] }),
    }),
    gen(lv, R) {
      const id = (n) => `${R.pick(["Kq1x7", "Pz0a2", "Hn4c9"])}:${R.int(10000, 99999) + n}`;
      if (lv === 1) {
        const tasks = [{ id: id(1), action: "indices:data/read/search", time: `${R.int(11, 19)}m`, desc: `indices[products], source[{"query":{"wildcard":{"name":{"value":"*${R.pick(["phone", "case", "cable"])}*"}}},"size":10000}]`, cpu: 70, bad: true }];
        return { lv, tasks, motd: "PAGE prod-search: search rejections and p99 > 5 s on every node for 15 minutes.\nNo deploy today." };
      }
      if (lv === 2) {
        const tasks = R.shuffle([{ id: id(1), action: "indices:data/read/search", time: `${R.int(35, 50)}m`, desc: 'indices[orders-*], scroll[5m], source[{"size":5000,"sort":["_doc"],"query":{"range":{"created_at":{"gte":"now-1d/d"}}}}]', cpu: 3, danger: "That was the nightly finance export (scroll sorted by _doc, cheap). It has to restart from scratch now." }, { id: id(2), action: "indices:data/read/search", time: `${R.int(8, 14)}m`, desc: 'indices[orders-*], source[{"size":0,"aggs":{"emails":{"terms":{"field":"customer_email","include":".*@gmail\\\\..*","size":200000}}}}]', cpu: 68, bad: true }]);
        return { lv, tasks, motd: "PAGE prod-search: search rejections and p99 > 4 s for 12 minutes.\nThe nightly finance export runs 02:00-03:00 (it's 02:41)." };
      }
      const total = R.pick([60, 80, 90]) * 1e6, done = R.pick([30, 40]) * 1e6, hoursLeft = R.pick([8, 10, 12]);
      const minRps = Math.ceil((total - done) / (hoursLeft * 3600) / 100) * 100;
      const maxRps = 3000;
      if (minRps >= maxRps) return null;
      const tasks = [{ id: id(3), action: "indices:data/write/update/byquery", time: "3.1h", desc: 'update-by-query [orders][_doc] updated with Script{lang="painless", source="ctx._source.region = params.map[ctx._source.country]"}', kind: "ubq", rps: -1 }];
      return { lv, tasks, total, done, hoursLeft, minRps, maxRps, goodRps: Math.min(maxRps, Math.max(minRps, 2000)), motd: `PAGE prod-search: bulk indexing rejected (429 es_rejected_execution_exception) for 20 min; checkout writes failing.\nA backfill (_update_by_query adding orders.region) was started without a throttle. It must finish within ${hoursLeft} h\n(the region filter launches tomorrow). Load tests showed writes stay healthy below ~${maxRps} background docs/s.` };
    },
    bad: (I) => I.lv === 1 ? [{ log: ["GET _tasks?detailed&actions=*search*,*byquery*"] }] : I.lv === 2 ? [{ log: I.tasks.map((t) => `POST _tasks/${t.id}/_cancel`) }] : [{ log: [`POST _tasks/${I.tasks[0].id}/_cancel`] }, { log: [`POST _update_by_query/${I.tasks[0].id}/_rethrottle?requests_per_second=${Math.max(100, I.minRps - 400)}`] }, { log: [`POST _update_by_query/${I.tasks[0].id}/_rethrottle?requests_per_second=8000`] }],
    text: (I) => `<p>${I.lv < 3 ? "Searches are being rejected across the cluster." : "Writes are being rejected across the cluster."} Find the task responsible and stop the damage with the least collateral${I.lv === 3 ? ", without missing the backfill deadline" : ""}. Type <code>help</code> for the console commands.</p>`,
    hint: (I) => I.lv === 1 ? "The tasks API shows what each search is doing. A leading wildcard scans every term in the field." : I.lv === 2 ? "Long-running isn't the same as expensive. A scroll sorted by _doc is about the cheapest way to read an index." : `Rethrottle instead of cancelling: ${K.num(I.total - I.done)} documents left in ${I.hoursLeft} hours means at least ${I.minRps} docs/s.`,
    concept: "Task management: cancel, or rethrottle",
    how: "Searches, reindexes and by-query jobs run as tasks. <code>GET _tasks?detailed</code> lists them with their request description and running time, <code>POST _tasks/&lt;id&gt;/_cancel</code> stops cancellable ones, and <code>_update_by_query</code>, <code>_reindex</code> and <code>_delete_by_query</code> accept <code>_rethrottle?requests_per_second=N</code> while running (-1 means unthrottled). Expensive searches are usually leading wildcards, regex includes or huge terms aggregations; a scroll or PIT export sorted by <code>_doc</code> runs long but costs little. Cancelling a by-query job leaves the index half-updated (it isn't transactional), so slowing it down is often the safer move.",
    rule: "Read the task description before acting: cancel the expensive one, not the long one, and throttle background jobs (requests_per_second, slices) from the start instead of running them at -1.",
    why: (I) => I.lv === 1 ? "A leading-wildcard query with size 10000 was walking every term of name on every shard for minutes. Cancelling that one task restored search." : I.lv === 2 ? "The terms aggregation with a regex include and 200,000 buckets burned the CPU; the 40-minute scroll export was cheap. Cancel the aggregation only." : `The backfill ran unthrottled and saturated the write pool. ${K.num(I.total - I.done)} documents in ${I.hoursLeft} h needs ≥ ${I.minRps}/s, and writes stay healthy below ${I.maxRps}/s, so rethrottling to about ${I.goodRps}/s fixes both; cancelling would leave orders half-migrated.`,
  });

  /* ---------- S1. Predict the tokens ---------- */
  MORE.push({
    id: "es-predict-tokens",
    name: "Predict what the analyzer indexes",
    kind: "Investigation",
    skills: ["diagnose"],
    w: "select",
    gen(lv, R) {
      let text, an, analysis = {};
      if (lv === 1) { text = R.pick(["The Wi-Fi 6E Router's AX3000 speed!", "USB-C Hub: 4K@60Hz, 100W PD (2.0 edition)", "Don't miss the e-mail at 9.30am"]); an = "standard"; }
      else if (lv === 2) { text = R.pick(["The runners' charging batteries are running hot", "Connected headphones with wireless charging", "Happiness is generalization of jumping foxes"]); an = "english"; }
      else { text = R.pick(["The Crème Brûlée is THE best dessert", "Jalapeño Poppers and the Café Lattes", "The Résumé Builder is in the cloud"]); an = "custom"; analysis = { analyzer: { custom: { type: "custom", tokenizer: "standard", filter: ["stop", "lowercase", "asciifolding", "porter_stem"] } } }; }
      const toks = [...new Set(ES().analyze(ES().createIndex({ settings: { analysis } }), { analyzer: an, text }).map((t) => t.token))];
      const words = text.match(/[^\s]+/g);
      const cand = new Set();
      words.forEach((w) => { const clean = w.replace(/[^\p{L}\p{N}'.-]/gu, ""); [clean, clean.toLowerCase(), clean.toLowerCase().replace(/['.-]/g, ""), ...clean.toLowerCase().split(/[-']/), fold(clean.toLowerCase())].forEach((x) => x && cand.add(x)); });
      toks.forEach((t) => cand.add(t));
      ["the", "is", "and", "in", "are"].forEach((s) => { if (text.toLowerCase().split(/\W+/).includes(s)) cand.add(s); });
      const distract = R.shuffle([...cand].filter((x) => !toks.includes(x))).slice(0, Math.max(4, 12 - toks.length));
      const opts = R.shuffle([...toks, ...distract]);
      return { lv, text, an, analysis, toks, opts };
    },
    text: (I) => `<p>${I.lv === 1 ? "The <code>title</code> field uses the default <b>standard</b> analyzer." : I.lv === 2 ? "The <code>description</code> field uses the built-in <b>english</b> analyzer." : "The <code>name</code> field uses this custom analyzer:"}</p>${I.lv === 3 ? K.pre(JP(I.analysis.analyzer)) : ""}<p>A document is indexed with:</p>${K.pre(I.text)}<p>Select <b>every</b> token that ends up in the inverted index (and nothing else). The selection is checked against what <code>POST _analyze</code> returns.</p>`,
    ui: (I) => ({ opts: I.opts }),
    ans: (I) => I.opts.map((o, i) => (I.toks.includes(o) ? i : -1)).filter((i) => i >= 0),
    diag: (I, a) => { const got = a.map((i) => I.opts[i]); const miss = I.toks.filter((t) => !got.includes(t)), extra = got.filter((t) => !I.toks.includes(t)); return `${miss.length ? `Missing: ${miss.map((x) => `<code>${esc(x)}</code>`).join(" ")}. ` : ""}${extra.length ? `Not indexed: ${extra.map((x) => `<code>${esc(x)}</code>`).join(" ")}.` : ""}`; },
    hint: (I) => I.lv === 1 ? "The standard tokenizer splits on hyphens and most punctuation but keeps apostrophes and dots between letters/digits; the standard analyzer then lowercases and removes no stopwords." : I.lv === 2 ? "english = possessive removal, lowercase, English stopwords, then the Porter stemmer (which produces stems, not dictionary words: batteries → batteri)." : "Filters run in order. The stop filter is case-sensitive by default and runs here before lowercase.",
    concept: "Analysis chains: tokenizer, then filters in order",
    how: "An analyzer is a tokenizer followed by token filters applied in order. The <b>standard</b> tokenizer follows Unicode word boundaries: hyphens and most punctuation split words, but apostrophes and periods between letters or digits stay inside a token (<i>router's</i>, <i>9.30am</i>). The standard analyzer only lowercases (no stopwords since 5.0). The <b>english</b> analyzer adds possessive removal, English stopwords and the Porter stemmer, whose output is a stem (<i>batteri</i>, <i>charg</i>), not a word. In a custom chain, order matters: a stop filter before lowercase misses capitalised stopwords, and folding before stemming changes what the stemmer sees. <code>POST _analyze</code> shows the exact result.",
    rule: "Never guess tokens: run POST index/_analyze with the field name, and put lowercase/asciifolding before stop and stemming filters.",
    why: (I) => `<code>_analyze</code> returns: ${I.toks.map((t) => `<code>${esc(t)}</code>`).join(" ")}.${I.lv === 3 ? " The capitalised <i>The</i> survives the stop filter (it runs before lowercase), so <code>the</code> is indexed while the lowercase <i>the</i> and <i>is</i> are removed." : ""}`,
  });

  /* ---------- U1/U2. Relevance tuning against a judgment list ---------- */
  const rankIds = (I, query) => { const b = ES().build(I.index, I.docs, { name: "products", now: Date.UTC(2026, 6, 15, 10) }); const r = ES().run(b.idx, { query, size: 20 }); return r.error ? { err: ES().errText(r.error) } : { ids: r.res.hits.hits.map((h) => h._id), res: r.res }; };
  const consOk = (ids, [a, b]) => ids.includes(a) && (!ids.includes(b) || ids.indexOf(a) < ids.indexOf(b));
  function judgedTune(d) {
    const check = (I, cfg) => { const r = rankIds(I, d.query(I, cfg)); if (r.err) return { err: r.err }; return { ids: r.ids, res: r.res, fails: I.cons.filter((c) => !consOk(r.ids, c)) }; };
    return {
      w: "tune",
      ...d,
      gen(lv, R) {
        const I = d.make(lv, R);
        if (!I) return null;
        const ref = rankIds(I, d.query(I, I.ref)).ids, def = rankIds(I, d.query(I, I.def)).ids;
        const pairs = [];
        for (let i = 0; i < Math.min(ref.length, 6); i++) for (let j = i + 1; j < ref.length; j++) if (!consOk(def, [ref[i], ref[j]])) pairs.push([ref[i], ref[j], j - i]);
        if (pairs.length < 2) return null;
        pairs.sort((x, y) => x[2] - y[2]);
        const picked = [];
        pairs.forEach((p) => { if (picked.length < (I.nCons || 3) && !picked.some((q) => q[0] === p[0] && q[1] === p[1])) picked.push([p[0], p[1]]); });
        I.cons = picked;
        if (I.extraCons) I.cons.push(...I.extraCons.filter((c) => consOk(ref, c)));
        for (const bc of d.bads ? d.bads(I) : []) {
          const bi = rankIds(I, d.query(I, bc)).ids;
          if (I.cons.every((c) => consOk(bi, c))) {
            let add = null;
            for (let i = 0; i < ref.length && !add; i++) for (let j = i + 1; j < ref.length && !add; j++) if (!consOk(bi, [ref[i], ref[j]])) add = [ref[i], ref[j]];
            if (!add) return null;
            I.cons.push(add);
          }
        }
        return I;
      },
      ui: (I) => ({ knobs: d.knobs(I), init: I.def, live: (cfg) => {
        const r = check(I, cfg);
        if (r.err) return `<p class="lose small">${esc(r.err)}</p>`;
        const name = (id) => esc(I.docs.find((x) => x._id === id).title);
        return `<div class="small mono">${esc(J(d.query(I, cfg))).slice(0, 400)}</div>` + ES().hitsHTML({ hits: { total: { value: r.ids.length }, hits: r.res.hits.hits.slice(0, 7) } }, d.cols) + K.table(["Judgment", ""], I.cons.map((c) => [`${name(c[0])} above ${name(c[1])}`, consOk(r.ids, c) ? "✓" : "✗"]), { compact: true });
      } }),
      accept: (I, cfg) => { const r = check(I, cfg); if (r.err) return esc(r.err); if (r.fails.length) { const n = (id) => esc(I.docs.find((x) => x._id === id).title); return `${r.fails.length} judgment${r.fails.length > 1 ? "s" : ""} still fail, e.g. <b>${n(r.fails[0][0])}</b> should rank above <b>${n(r.fails[0][1])}</b>.`; } return true; },
      solve: (I) => I.ref,
      bad: (I) => [I.def, ...(d.bads ? d.bads(I) : [])],
    };
  }
  const titlesTable = (I, cols) => K.table(["_id", ...cols], I.docs.map((x) => [`<span class="mono">${esc(x._id)}</span>`, ...cols.map((c) => esc(String(x[c] == null ? "" : x[c])))]), { compact: true, mono: [0] });
  MORE.push(judgedTune({
    id: "es-boost-fields",
    name: "Tune field boosts to the judgment list",
    kind: "Experiment",
    skills: ["tune"],
    cols: ["title", { h: "tags", f: (s) => s.tags }],
    query: (I, c) => ({ multi_match: { query: I.q, type: c.type, fields: [`title^${c.title}`, `description^${c.desc}`, ...(c.tags ? [`tags^${c.tags}`] : [])], ...(c.type === "best_fields" ? { tie_breaker: c.tie } : {}) } }),
    knobs: () => [{ k: "title", label: "title boost", opts: [1, 2, 3, 5, 10] }, { k: "desc", label: "description boost", opts: [0.5, 1, 2] }, { k: "tags", label: "tags boost", opts: [0, 1, 2, 3], help: "0 = don't search tags" }, { k: "type", label: "multi_match type", opts: ["best_fields", "most_fields"] }, { k: "tie", label: "tie_breaker", opts: [0, 0.3, 0.7], help: "best_fields only" }],
    make(lv, R) {
      const q = R.pick(["waterproof hiking boots", "wireless noise cancelling headphones", "ergonomic office chair"]);
      const w = q.split(" ");
      const pool = [
        { title: `${cap(w[0])} ${cap(w[1])} ${cap(w[2])}`, description: `Our best ${w[2]} for every day.`, tags: [w[0]] },
        { title: `${cap(w[1])} ${cap(w[2])}`, description: `A ${w[0]} design with sealed seams, ${w[0]} and ${w[0]} tested.`, tags: [w[0], w[1]] },
        { title: `${cap(w[2])} Care Kit`, description: `Keeps your ${w[0]} ${w[1]} ${w[2]} like new. Works with any ${w[2]}.`, tags: [w[2]] },
        { title: `${cap(w[0])} Spray`, description: `Makes ${w[2]} ${w[0]}. Not for ${w[1]} gear.`, tags: [w[0]] },
        { title: `${cap(w[1])} Socks`, description: `Pair with ${w[1]} ${w[2]}.`, tags: [w[1], w[0]] },
        { title: `Budget ${cap(w[2])}`, description: `Entry-level ${w[2]}, ${w[1]} friendly, ${w[0]} coating.`, tags: [w[1], w[2], w[0]] },
        { title: `${cap(w[0])} ${cap(w[2])} Bag`, description: `Carry case.`, tags: [] },
        { title: `${cap(w[1])} ${cap(w[0])} Jacket`, description: `Layer for ${w[1]} trips.`, tags: [w[0]] },
      ];
      const docs = R.shuffle(pool).map((x, i) => ({ _id: "p" + (10 + i * 3), ...x }));
      const index = { mappings: { properties: { title: { type: "text" }, description: { type: "text" }, tags: { type: "text" } } } };
      const def = { title: 1, desc: 1, tags: 1, type: "best_fields", tie: 0 };
      const ref = lv === 1 ? { title: 5, desc: 1, tags: 1, type: "best_fields", tie: 0 } : lv === 2 ? { title: 3, desc: 0.5, tags: 2, type: "most_fields", tie: 0 } : { title: 5, desc: 0.5, tags: 1, type: "best_fields", tie: 0.3 };
      return { lv, q, docs, index, def, ref, nCons: lv + 1 };
    },
    text: (I) => `<p>Search for <code>${esc(I.q)}</code> uses a <code>multi_match</code> over <code>title</code>, <code>description</code> and <code>tags</code>. The relevance team's judgment list says which product should beat which. Tune the query until every judgment passes (the panel re-runs the search with BM25 on each change).</p>${titlesTable(I, ["title", "description"])}`,
    hint: (I) => I.lv === 1 ? "A word in a short title is a much stronger signal than the same word buried in a description, but BM25 doesn't know which field matters more." : I.lv === 2 ? "best_fields scores a document by its single best field; most_fields adds up all matching fields, rewarding documents whose words are spread across fields." : "tie_breaker blends: best field + tie_breaker × the other fields.",
    concept: "multi_match: field boosts, best_fields vs most_fields",
    how: "BM25 scores each field independently (term frequency, inverse document frequency, field length). <code>multi_match</code> combines them: <code>best_fields</code> (the default) takes the best single field's score, plus <code>tie_breaker</code> × the others; <code>most_fields</code> sums every matching field, rewarding documents that match across fields; <code>cross_fields</code> treats fields as one big field. Per-field boosts (<code>title^3</code>) multiply that field's contribution. Because scores depend on corpus statistics, tuning must be validated against a judgment list, not one query.",
    rule: "Boost short, high-signal fields (title, tags) over long ones, choose best_fields for 'one field says it all' and most_fields for words spread across fields, and keep a judgment list as a regression test.",
    why: (I, sol) => `The reference (${esc(J(sol))}) satisfies all ${I.cons.length} judgments. Equal boosts let long descriptions that repeat the query words outrank products whose title says exactly what was searched.`,
  }));
  function cap(s) { return s[0].toUpperCase() + s.slice(1); }

  MORE.push(judgedTune({
    id: "es-function-score",
    name: "Blend relevance, recency and popularity",
    kind: "Experiment",
    skills: ["tune", "design"],
    cols: ["title", "published", "views"],
    query: (I, c) => {
      const fns = [];
      if (c.pop !== "none") fns.push({ field_value_factor: { field: "views", modifier: c.pop === "raw" ? "none" : c.pop, missing: 1 } });
      if (c.rec !== "none") fns.push({ gauss: { published: { origin: "now", scale: c.rec, decay: 0.5 } } });
      const base = { match: { title: I.q } };
      return fns.length ? { function_score: { query: base, functions: fns, score_mode: "multiply", boost_mode: c.mode } } : base;
    },
    knobs: () => [{ k: "pop", label: "Popularity (views)", opts: ["none", "raw", "log1p", "sqrt"], help: "field_value_factor modifier" }, { k: "rec", label: "Recency decay (gauss scale)", opts: ["none", "7d", "30d", "180d"] }, { k: "mode", label: "boost_mode", opts: ["multiply", "sum", "replace"], help: "how the function score combines with the text score" }],
    make(lv, R) {
      const q = R.pick(["kubernetes outage", "database migration", "postgres upgrade"]);
      const [a, b] = q.split(" ");
      const day = (n) => new Date(Date.UTC(2026, 6, 15) - n * 86400000).toISOString().slice(0, 10);
      const pool = [
        [`${cap(a)} ${b} postmortem: what we learned`, 2, 900],
        [`The great ${a} ${b} of 2024`, 600, 250000],
        [`${cap(a)} ${b} checklist`, 40, 12000],
        [`Our ${a} ${b} runbook`, 8, 3000],
        [`${cap(a)} tips and tricks`, 1, 80000],
        [`Weekly ${b} digest`, 3, 400],
        [`${cap(a)} ${b}, explained`, 200, 60000],
        [`Why our ${b} took 9 hours`, 15, 7000],
      ];
      const docs = R.shuffle(pool).map(([t, d, v], i) => ({ _id: "a" + (20 + i * 5), title: t, published: day(d + R.int(0, 1)), views: Math.round(v * (0.8 + R.next() * 0.4)) }));
      const index = { mappings: { properties: { title: { type: "text" }, published: { type: "date" }, views: { type: "long" } } } };
      const def = { pop: "none", rec: "none", mode: "multiply" };
      const ref = lv === 1 ? { pop: "log1p", rec: "none", mode: "multiply" } : lv === 2 ? { pop: "log1p", rec: "30d", mode: "multiply" } : { pop: "log1p", rec: "180d", mode: "sum" };
      return { lv, q, docs, index, def, ref, nCons: lv + 1 };
    },
    bads: (I) => [{ pop: "raw", rec: "none", mode: "replace" }],
    text: (I) => `<p>The engineering blog's search for <code>${esc(I.q)}</code> should favour well-matching posts that are ${I.lv === 1 ? "popular" : "popular and recent"}, without letting one viral article bury everything. Tune the <code>function_score</code> until the editors' judgments pass. "now" is 2026-07-15.</p>${titlesTable(I, ["title", "published", "views"])}`,
    hint: (I) => I.lv === 1 ? "Raw view counts span 3 orders of magnitude. A log modifier compresses them so they nudge rather than dominate." : I.lv === 2 ? "A gauss decay scores 1.0 at the origin and 0.5 at origin ± scale. Too short a scale wipes out good older posts." : "boost_mode replace ignores text relevance entirely; sum adds a bonus instead of multiplying.",
    concept: "function_score: decay functions and field_value_factor",
    how: "<code>function_score</code> computes extra scores and combines them with the query score. <code>field_value_factor</code> uses a numeric field like views; without a modifier (<code>log1p</code>, <code>sqrt</code>) a value 1000× larger dominates everything. Decay functions (<code>gauss</code>, <code>exp</code>, <code>linear</code>) score by distance from an origin, here now: 1.0 at the origin and <code>decay</code> (0.5) at <code>scale</code> away. <code>score_mode</code> combines the functions, <code>boost_mode</code> combines the result with the text score (multiply by default; replace drops relevance altogether).",
    rule: "Dampen popularity with log1p or sqrt, choose a decay scale that matches how fast content goes stale, and keep text relevance in the formula; check against judgments, not single queries.",
    why: (I, sol) => `The reference (${esc(J(sol))}) passes every judgment. Raw views let the 250k-view article win every query; log1p turns a 100× popularity gap into roughly a 2× boost.`,
  }));

  /* ---------- U3. Shard sizing ---------- */
  const PERIODS = { "1d": 1, "7d": 7, "30d": 30 };
  function shardPlan(I, c) {
    const streams = I.streams.map((s, k) => {
      const pri = c["pri" + k], days = PERIODS[c["per" + k]];
      const size = (s.gb * days) / pri;
      const kept = Math.ceil(I.ret / days) + 1;
      return { name: s.name, pri, days, size, kept, shards: kept * pri * (1 + I.rep), ingestOk: !s.mbs || pri * I.perShardMbs >= s.mbs };
    });
    return { streams, total: K.sum(streams.map((x) => x.shards)) };
  }
  MORE.push({
    id: "es-shard-sizing",
    name: "Size shards for a log cluster",
    kind: "Capacity plan",
    skills: ["estimate", "design"],
    w: "tune",
    sense: "min",
    vname: "total shards:",
    gen(lv, R) {
      const ret = R.pick([30, 45, 60]);
      if (lv === 1) return { lv, ret, rep: 1, streams: [{ name: "app-logs", gb: R.pick([60, 80, 120, 150]) }] };
      if (lv === 2) return { lv, ret, rep: 1, streams: [{ name: "app-logs", gb: R.pick([90, 120, 150]) }, { name: "audit", gb: R.pick([2, 3, 4]) }] };
      return { lv, ret, rep: 1, perShardMbs: 6, streams: [{ name: "edge-logs", gb: R.pick([400, 500, 600]), mbs: R.pick([40, 50]) }, { name: "audit", gb: R.pick([2, 3]) }] };
    },
    text: (I) => `<p>Plan the indices for ${I.streams.length > 1 ? "these data streams" : "this data stream"} (retention <b>${I.ret} days</b>, ${I.rep} replica):</p><ul>${I.streams.map((s) => `<li><b>${esc(s.name)}</b>: ${s.gb} GB/day of primary data${s.mbs ? `, peaks at <b>${s.mbs} MB/s</b>` : ""}</li>`).join("")}</ul><p>Keep every primary shard between <b>10 and 50 GB</b>${I.perShardMbs ? `, and give the busy stream enough primaries to absorb its peak (one primary shard indexes about ${I.perShardMbs} MB/s here)` : ""}. Each shard costs heap and cluster-state overhead, so use as <b>few shards</b> as possible in total.</p>`,
    ui: (I) => ({ knobs: I.streams.flatMap((s, k) => [{ k: "pri" + k, label: `${s.name}: primary shards`, opts: [1, 2, 3, 4, 6, 8, 10, 12] }, { k: "per" + k, label: `${s.name}: new index every`, opts: ["1d", "7d", "30d"] }]), live: (c) => { const p = shardPlan(I, c); return K.table(["stream", "shard size", "indices kept", "shards (incl. replicas)"], p.streams.map((s) => [esc(s.name), `<span class="${s.size < 10 || s.size > 50 ? "lose" : ""}">${K.num(s.size, 1)} GB</span>`, s.kept, s.shards + (s.ingestOk ? "" : ' <span class="lose">too few primaries for the peak</span>')]), { compact: true }) + K.metrics([{ name: "Total shards", value: K.num(p.total), ok: null }]); } }),
    valid: (I, c) => { const p = shardPlan(I, c); const b = p.streams.find((s) => s.size < 10 || s.size > 50); if (b) return `${b.name} shards would be ${K.num(b.size, 1)} GB (outside 10–50 GB)`; const g = p.streams.find((s) => !s.ingestOk); if (g) return `${g.pri} primaries × ${I.perShardMbs} MB/s can't absorb ${g.name}'s peak`; return true; },
    val: (I, c) => shardPlan(I, c).total,
    hint: (I) => I.lv === 1 ? "Shard size = GB/day × days per index ÷ primaries. Fewer, bigger indices mean fewer shards." : I.lv === 2 ? "A tiny stream with daily indices makes shards of a few GB: give it a longer period." : "The busy stream needs enough primaries for its peak rate, which forces bigger indices or shorter periods to keep shards ≥ 10 GB.",
    concept: "Shard sizing: 10–50 GB, as few as possible",
    how: "Every shard is a Lucene index with fixed costs: heap for segment metadata, file handles, cluster-state entries and a task per search. Thousands of tiny shards (daily indices for small streams, too many primaries) waste memory and slow the master; giant shards (over ~50 GB) make recovery and relocation slow. The usual target is 10–50 GB per shard (20–40 GB for search-heavy indices). Total shards = indices kept × primaries × (1 + replicas), where indices kept ≈ retention ÷ period + 1. Primaries also cap indexing parallelism. In practice, ILM rollover on <code>max_primary_shard_size</code> sizes shards automatically.",
    rule: "Pick primaries from the ingest rate, then the rollover period (or a size-based rollover) so shards land at 10–50 GB; give small streams long periods instead of daily indices.",
    why: (I, sol) => { const p = shardPlan(I, sol); return `The cheapest plan: ${p.streams.map((s) => `${esc(s.name)} with ${s.pri} primar${s.pri > 1 ? "ies" : "y"} per ${s.days}-day index (${K.num(s.size, 1)} GB shards, ${s.shards} shards)`).join("; ")}: ${p.total} shards in total.`; },
  });

  /* ---------- U4. Replicas vs read throughput ---------- */
  function replicaModel(I, c) {
    const N = c.nodes, r = c.rep, copies = I.pri * (1 + r);
    const eff = Math.min(N, copies);
    const cores = 16;
    const searchCpu = (I.qps * I.pri * I.costMs) / 1000; // core-seconds per second
    const indexCpu = I.ingest * (1 + r) * I.idxCost;
    const rho = searchCpu / (eff * cores) + indexCpu / (N * cores);
    const p99 = rho >= 0.98 ? Infinity : I.base / (1 - rho);
    const disk = (I.dataGb * (1 + r)) / N;
    let p99Fail = null;
    if (I.surviveLoss) { const N2 = N - 1, eff2 = Math.min(N2, copies); const rho2 = searchCpu / (eff2 * cores) + indexCpu / (N2 * cores); p99Fail = rho2 >= 0.98 || r < 1 ? Infinity : I.base / (1 - rho2); }
    return { rho, p99, disk, p99Fail, eff };
  }
  MORE.push({
    id: "es-replicas-throughput",
    name: "Replicas, nodes and search throughput",
    kind: "Capacity plan",
    skills: ["estimate", "tune"],
    w: "tune",
    sense: "min",
    vname: "cost score",
    gen(lv, R) {
      const I = { lv, pri: R.pick([2, 3]), qps: R.pick([1500, 2000, 2500]), costMs: R.pick([8, 10]), base: 40, target: 120, ingest: lv === 3 ? R.pick([25000, 30000]) : 2000, idxCost: 0.0004, dataGb: R.pick([300, 400]), diskPerNode: lv === 3 ? 500 : 2000, surviveLoss: lv >= 2 };
      return I;
    },
    text: (I) => `<p>The <code>catalog</code> index has <b>${I.pri} primary shards</b> (${I.dataGb} GB of primary data) and serves <b>${K.num(I.qps)} searches/s</b>; each search costs about ${I.costMs} ms of CPU per shard it touches. Nodes have 16 cores${I.lv === 3 ? ` and ${I.diskPerNode} GB of usable disk` : ""}. ${I.lv === 3 ? `It also ingests <b>${K.num(I.ingest)} docs/s</b>, and every replica repeats that indexing work.` : ""}</p><p>Choose nodes and replicas to keep <b>p99 under ${I.target} ms</b>${I.surviveLoss ? ", <b>and still under " + I.target * 2 + " ms with one node down</b> (with no data loss)" : ""}, at the lowest cost (nodes first, then replicas).</p>`,
    ui: (I) => ({ knobs: [{ k: "nodes", label: "Data nodes", min: 2, max: 12, step: 1 }, { k: "rep", label: "Replicas", min: 0, max: 4, step: 1 }], live: (c) => { const m = replicaModel(I, c); return K.metrics([{ name: "Nodes serving searches", value: `${m.eff} of ${c.nodes}`, ok: null, target: `${I.pri} primaries × ${1 + c.rep} copies` }, { name: "CPU utilisation", value: K.pct(Math.min(1, m.rho), 0), ok: m.rho < 0.7 }, { name: "p99", value: Number.isFinite(m.p99) ? K.ms(m.p99) : "overloaded", ok: m.p99 <= I.target, target: `< ${I.target} ms` }, ...(I.surviveLoss ? [{ name: "p99, one node down", value: c.rep < 1 ? "data loss" : Number.isFinite(m.p99Fail) ? K.ms(m.p99Fail) : "overloaded", ok: m.p99Fail <= I.target * 2, target: `< ${I.target * 2} ms` }] : []), ...(I.lv === 3 ? [{ name: "Disk per node", value: `${K.num(m.disk)} GB`, ok: m.disk <= I.diskPerNode, target: `≤ ${I.diskPerNode} GB` }] : [])]); } }),
    valid: (I, c) => { const m = replicaModel(I, c); if (!(m.p99 <= I.target)) return `p99 would be ${Number.isFinite(m.p99) ? Math.round(m.p99) + " ms" : "unbounded (overloaded)"}`; if (I.surviveLoss && c.rep < 1) return "with 0 replicas, losing a node loses data"; if (I.surviveLoss && !(m.p99Fail <= I.target * 2)) return `with one node down p99 would be ${Number.isFinite(m.p99Fail) ? Math.round(m.p99Fail) + " ms" : "unbounded"}`; if (I.lv === 3 && m.disk > I.diskPerNode) return `${Math.round(m.disk)} GB per node exceeds the disk`; return true; },
    val: (I, c) => c.nodes * 10 + c.rep,
    hint: (I) => I.lv === 1 ? "A search hits one copy of each shard; copies are what let more nodes share the work. Count the copies." : I.lv === 2 ? "After a node failure the survivors absorb its share. Size for that." : "Every replica re-indexes every document and stores a full copy. More replicas aren't free here.",
    concept: "Replicas scale reads, not writes",
    how: "Each search runs on one copy of every shard, so the number of nodes that can share search work is capped at primaries × (1 + replicas). Adding replicas spreads reads over more nodes and adds redundancy, but every replica repeats all indexing work and stores a full copy of the data, so for write-heavy indices extra replicas cost throughput and disk. Size for the degraded case: when a node fails, its shard copies are rebuilt elsewhere and the survivors take its traffic.",
    rule: "replicas ≥ 1 for anything that matters; add replicas (and nodes) for read throughput only after checking the indexing and disk cost, and size for N−1 nodes.",
    why: (I, sol) => { const m = replicaModel(I, sol); return `Cheapest: ${sol.nodes} nodes with ${sol.rep} replica${sol.rep === 1 ? "" : "s"}, so ${m.eff} nodes share the searches at ${K.pct(m.rho, 0)} CPU and p99 ≈ ${Math.round(m.p99)} ms${I.surviveLoss ? ` (≈ ${Math.round(m.p99Fail)} ms with a node down)` : ""}.`; },
  });

  /* ---------- U5. Bulk load tuning ---------- */
  const BULK = { "1mb": 1, "5mb": 5, "15mb": 15, "50mb": 50, "150mb": 150 };
  function bulkModel(I, c) {
    const mb = BULK[c.bulk];
    if (mb > 100) return { err: "413 Request Entity Too Large: the request exceeds http.max_content_length (100mb)" };
    const lat = 30 + mb * 35;
    const client = (c.conc * mb) / (lat / 1000);
    const refF = { "1s": 0.7, "30s": 0.93, "-1": 1 }[c.refresh];
    const small = mb < 5 ? 0.55 : 1;
    const cap = (I.nodes * 45 * refF * small) / (1 + c.rep) * I.budget;
    const inflight = c.conc * mb * 2;
    const pressure = I.nodes * 3000 * 0.1 * I.budget; // MB of indexing_pressure budget
    const rejected = inflight > pressure || c.conc > I.nodes * 8 * 2;
    const thr = Math.min(client, cap);
    return { mb, lat, client, cap, thr, hours: (I.gb * 1000) / thr / 3600, rejected, inflight, pressure };
  }
  MORE.push({
    id: "es-bulk-load",
    name: "Tune the backfill bulk load",
    kind: "Config change",
    skills: ["tune"],
    w: "tune",
    sense: "min",
    vname: "load time (hours):",
    vfmt: (v) => v.toFixed(1),
    gen(lv, R) {
      return { lv, nodes: R.pick([3, 4, 6]), gb: R.pick([400, 600, 800]), maxH: lv === 1 ? 10 : 14, live: lv >= 2, budget: lv === 3 ? 0.6 : 1 };
    },
    text: (I) => `<p>Backfill <b>${I.gb} GB</b> of documents into ${I.live ? "the <b>live</b> <code>products</code> index (it serves production search the whole time)" : "a <b>new</b> index that isn't serving traffic yet"} on a ${I.nodes}-node cluster. ${I.lv === 3 ? "The cluster also indexes other production data, so the backfill may use at most <b>60%</b> of indexing capacity. " : ""}Finish within <b>${I.maxH} hours</b> with <b>no rejected requests</b>${I.live ? ", keep search results at most 30 s stale, and don't drop the index's redundancy" : ""}. Minimise the load time.</p>`,
    ui: (I) => ({ knobs: [{ k: "bulk", label: "Bulk request size", opts: Object.keys(BULK) }, { k: "conc", label: "Concurrent bulk clients", opts: [1, 2, 4, 8, 16, 32] }, { k: "refresh", label: "refresh_interval during load", opts: ["1s", "30s", "-1"] }, { k: "rep", label: "number_of_replicas during load", opts: [0, 1] }], live: (c) => { const m = bulkModel(I, c); if (m.err) return K.verdict(false, esc(m.err)); return K.metrics([{ name: "Client-side rate", value: `${K.num(m.client)} MB/s`, ok: null, target: `${c.conc} × ${m.mb} MB per ${K.ms(m.lat)}` }, { name: "Cluster capacity", value: `${K.num(m.cap)} MB/s`, ok: null }, { name: "In-flight indexing", value: `${K.num(m.inflight)} MB`, ok: !m.rejected, target: `pressure limit ${K.num(m.pressure)} MB` }, { name: "Load time", value: `${m.hours.toFixed(1)} h`, ok: m.hours <= I.maxH, target: `≤ ${I.maxH} h` }]) + (m.rejected ? K.note("429 es_rejected_execution_exception: too many bytes or requests in flight.", "bad") : ""); } }),
    valid: (I, c) => { const m = bulkModel(I, c); if (m.err) return m.err; if (m.rejected) return "the cluster rejects requests (429): too much in flight"; if (I.live && c.refresh === "-1") return "with refresh disabled, new documents never show up in live search"; if (I.live && c.rep === 0) return "dropping the live index to 0 replicas means a node failure takes production search down and loses data"; if (m.hours > I.maxH) return `it would take ${m.hours.toFixed(1)} h`; return true; },
    val: (I, c) => +bulkModel(I, c).hours.toFixed(2),
    hint: (I) => I.lv === 1 ? "On an index nobody reads yet, refreshes and replica copies are pure overhead during the load: add them back afterwards." : I.lv === 2 ? "Live index: replicas must stay, refresh can be relaxed up to the staleness you can accept. Then find the bulk size × concurrency sweet spot without 429s." : "Same as before, but only 60% of the cluster's indexing capacity and pressure budget are yours.",
    concept: "Bulk indexing throughput",
    how: "Bulk throughput depends on request size (5–15 MB per request is the usual sweet spot; tiny requests waste per-request overhead and anything over <code>http.max_content_length</code>, 100 MB, is rejected), client concurrency (enough to keep every node's write threads busy, not so much that indexing pressure or the write queue rejects with 429), refresh (each refresh creates a segment; <code>-1</code> or 30 s saves merge work) and replicas (each replica repeats the indexing). For an index nobody reads yet, load with <code>refresh_interval: -1</code> and 0 replicas, then restore both.",
    rule: "Load new indices with refresh off and 0 replicas, then restore; on live indices relax refresh only as far as freshness allows, keep replicas, and grow concurrency until the first 429, then back off.",
    why: (I, sol) => { const m = bulkModel(I, sol); return `Best: ${sol.bulk} bulks × ${sol.conc} clients, refresh ${sol.refresh}, ${sol.rep} replica(s): ~${K.num(m.thr)} MB/s, ${m.hours.toFixed(1)} h, ${K.num(m.inflight)} MB in flight (limit ${K.num(m.pressure)} MB).`; },
  });

  /* ---------- I1. Version conflicts ---------- */
  function occRun(I, seq) {
    const doc = { exists: true, val: I.init, seq: 7, ver: 100 }, tomb = { ver: null };
    const vars = I.lanes.map(() => ({}));
    const log = [];
    const pos = I.lanes.map(() => 0);
    seq.forEach((l) => {
      const i = pos[l]++, op = I.lanes[l].ops[i], v = vars[l], label = I.lanes[l].steps[i];
      let note = "";
      if (op.k === "get") { v.val = doc.val; v.seq = doc.seq; note = `sees stock=${doc.val}, _seq_no=${doc.seq}`; }
      else if (op.k === "put") { if (op.occ && v.seq !== doc.seq) { v.failed = true; note = `409 version_conflict_engine_exception: required seqNo [${v.seq}], current [${doc.seq}]`; } else { doc.val = v.val - op.d; doc.seq++; v.failed = false; v.body = doc.val; note = `stock := ${doc.val}`; } if (op.occ && v.failed) v.body = v.val - op.d; }
      else if (op.k === "retry") { if (!v.failed) note = "(previous write succeeded: skipped)"; else { v.seq = doc.seq; doc.val = v.body; doc.seq++; v.failed = false; note = `re-reads _seq_no=${v.seq}, resends stock=${v.body}`; } }
      else if (op.k === "xindex") { if (doc.exists ? op.ver <= doc.ver : tomb.ver != null && op.ver <= tomb.ver) note = `409 version conflict: current version [${doc.exists ? doc.ver : tomb.ver}] is higher than or equal to the one provided [${op.ver}]`; else { doc.exists = true; doc.ver = op.ver; doc.val = op.val; note = doc.exists ? `indexed (version ${op.ver})` : ""; } }
      else if (op.k === "xdelete") { if (doc.exists && op.ver > doc.ver) { doc.exists = false; tomb.ver = op.ver; note = `deleted (tombstone version ${op.ver})`; } else note = "409 version conflict"; }
      else if (op.k === "gc") { if (tomb.ver != null) { tomb.ver = null; note = "tombstone purged"; } else note = "(no tombstone)"; }
      log.push({ t: l, label, note, err: /^409/.test(note) });
    });
    return { doc, log, complete: seq.length === I.lanes.reduce((s, x) => s + x.steps.length, 0) };
  }
  const occBroken = (I, r) => (I.lv === 3 ? r.doc.exists : r.doc.val !== I.init - I.d1 - I.d2);
  MORE.push({
    id: "es-version-conflict",
    name: "Lost updates and optimistic concurrency",
    kind: "Investigation",
    skills: ["diagnose", "design"],
    w: "interleave",
    gen(lv, R) {
      const init = R.int(8, 30), d1 = R.int(1, 3), d2 = R.int(1, 3);
      let lanes;
      if (lv === 1) lanes = [1, 2].map((w) => { const d = w === 1 ? d1 : d2; return { name: `worker ${w} (sells ${d})`, steps: ["GET products/_doc/7", `PUT products/_doc/7 {stock: <read> - ${d}}`], ops: [{ k: "get" }, { k: "put", d }] }; });
      else if (lv === 2) lanes = [1, 2].map((w) => { const d = w === 1 ? d1 : d2; return { name: `worker ${w} (sells ${d})`, steps: ["GET products/_doc/7", `PUT products/_doc/7?if_seq_no=<read>&if_primary_term=1 {stock: <read> - ${d}}`, "on 409: GET _seq_no again, resend the same body"], ops: [{ k: "get" }, { k: "put", d, occ: true }, { k: "retry" }] }; });
      else lanes = [{ name: "CDC consumer A (partition lagging)", steps: ["PUT products/_doc/7?version=105&version_type=external {price: 39}"], ops: [{ k: "xindex", ver: 105, val: 39 }] }, { name: "CDC consumer B", steps: ["DELETE products/_doc/7?version=110&version_type=external"], ops: [{ k: "xdelete", ver: 110 }] }, { name: "time", steps: ["60 s pass (index.gc_deletes)"], ops: [{ k: "gc" }] }];
      return { lv, init, d1, d2, lanes };
    },
    text: (I) => I.lv === 1 ? `<p>Two checkout workers update product 7's stock (now <b>${I.init}</b>) by reading the document, subtracting in the app, and writing it back. Find a schedule that leaves the wrong stock (anything but ${I.init - I.d1 - I.d2}).</p>` : I.lv === 2 ? `<p>The fix used optimistic concurrency: the write carries <code>if_seq_no</code>/<code>if_primary_term</code> from the read, so a concurrent change causes a 409. But the retry handler, on 409, only fetches the new <code>_seq_no</code> and resends the <b>same body</b>. Stock starts at ${I.init}. Find a schedule that still ends wrong.</p>` : `<p>A CDC pipeline mirrors the products table into Elasticsearch with <code>version_type=external</code> (the version is the row's change number), so out-of-order events are rejected. Product 7 (version 100) was updated (v105) and then deleted (v110), but consumer A lags. Find a schedule where the deleted product <b>comes back</b>.</p>`,
    ui: (I) => ({ lanes: I.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = occRun(I, seq || []); return K.table(["", ...I.lanes.map((l) => esc(l.name))], r.log.map((e, k) => [String(k + 1), ...I.lanes.map((_, j) => (j === e.t ? `<span class="mono small">${esc(e.label)}</span><br><small class="${e.err ? "lose" : "muted"}">${esc(e.note)}</small>` : ""))]), { compact: true }) + (r.complete ? K.verdict(occBroken(I, r), I.lv === 3 ? (r.doc.exists ? `product 7 exists again with price ${r.doc.val}` : "product 7 stays deleted") : `final stock ${r.doc.val}, expected ${I.init - I.d1 - I.d2}`) : ""); } }),
    accept: (I, seq) => (occBroken(I, occRun(I, seq)) ? true : "That schedule ends consistent. Try a different overlap."),
    solve: (I, spec) => { for (const s of LB.byId.get("es-version-conflict").space(I, spec)) if (occBroken(I, occRun(I, s))) return s; return null; },
    bad: (I) => [I.lanes.flatMap((l, k) => l.steps.map(() => k))],
    hint: (I) => I.lv === 1 ? "Let both workers read before either writes." : I.lv === 2 ? "The 409 is correct; what the handler does next isn't. Let one worker's write land between the other's read and write." : "External versioning compares against the deleted document's tombstone, which is only kept for index.gc_deletes (60 s).",
    concept: "Optimistic concurrency: seq_no, primary term and external versions",
    how: "Elasticsearch has no locks: every write bumps the document's <code>_seq_no</code>, and a write sent with <code>if_seq_no</code> + <code>if_primary_term</code> fails with 409 if the document changed since it was read. The correct reaction to a 409 is to re-read and recompute, not to resend the old body with a fresh seq_no. <code>_update</code> with a script and <code>retry_on_conflict</code> does the read-modify-write inside the shard. With <code>version_type=external</code> a write only succeeds if its version is higher than the stored one; after a delete, the tombstone that remembers the version is kept only for <code>index.gc_deletes</code> (60 s by default), so a very late older event can resurrect the document.",
    rule: "Compute new values from a fresh read on every retry (or use scripted _update with retry_on_conflict), and for external versioning make sure consumers can't lag past index.gc_deletes, or soft-delete with a flag instead of deleting.",
    why: (I) => I.lv === 1 ? "Both workers read the same stock and each wrote its own result, so one sale vanished: a classic lost update." : I.lv === 2 ? "The 409 fired correctly, but resending the stale body with the new _seq_no overwrote the other worker's change. On conflict, recompute from a fresh read." : "Once the 60 s tombstone was purged, the late v105 write found no document and no tombstone, so it was accepted and the deleted product reappeared.",
  });

  /* ---------- registration (see c-es.js) ---------- */
  if (LB._esLoaded) LB.addAll("es", MORE);
  else LB._esMore = (LB._esMore || []).concat(MORE);
  LB._esPart2 = MORE;
})();
