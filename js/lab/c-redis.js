/* Systems Lab · Redis & caching (part 1: the redis-cli sandbox and terminal scenarios, cluster key design).
   Shared helpers are exposed on LB.redisKit for part 2 (c-redis-2.js). */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const GB = 1024 ** 3, MB = 1024 ** 2;

  /* ---------- redis-cli reply formatting ---------- */
  const OK = { raw: "OK" };
  const rep = (v, pad = "") => {
    if (Array.isArray(v)) {
      if (!v.length) return "(empty array)";
      const w = String(v.length).length;
      return v.map((x, i) => { const lab = `${String(i + 1).padStart(w)}) `; return (i ? pad : "") + lab + rep(x, pad + " ".repeat(lab.length)); }).join("\n");
    }
    if (typeof v === "number") return `(integer) ${v}`;
    if (v === null) return "(nil)";
    if (v && v.raw != null) return v.raw;
    return `"${v}"`;
  };
  const human = (b) => (b >= GB ? (b / GB).toFixed(2) + "G" : b >= MB ? (b / MB).toFixed(2) + "M" : b >= 1024 ? (b / 1024).toFixed(2) + "K" : b + "B");
  const parseMem = (s) => {
    const m = String(s).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb)?$/);
    if (!m) return null;
    return Math.round(+m[1] * { b: 1, k: 1e3, kb: 1024, m: 1e6, mb: MB, g: 1e9, gb: GB }[m[2] || "b"]);
  };
  const unq = (s) => (s == null ? s : String(s).replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
  const argv = (s) => (String(s).match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unq);
  const glob = (p) => new RegExp("^" + [...p].map((c) => (c === "*" ? ".*" : c === "?" ? "." : /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c)).join("") + "$");
  // CRC16-XMODEM, as Redis Cluster uses for key slots
  const crc16 = (s) => {
    let crc = 0;
    for (let i = 0; i < s.length; i++) {
      crc ^= (s.charCodeAt(i) & 0xff) << 8;
      for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  };
  const slotOf = (key) => {
    const s = key.indexOf("{");
    if (s >= 0) { const e = key.indexOf("}", s + 1); if (e > s + 1) key = key.slice(s + 1, e); }
    return crc16(key) % 16384;
  };
  const POLICIES = ["noeviction", "allkeys-lru", "allkeys-lfu", "allkeys-random", "volatile-lru", "volatile-lfu", "volatile-random", "volatile-ttl"];
  const NOLFU = "ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.";

  /* ---------- node model and INFO ---------- */
  const clientLine = (c) => `id=${c.id} addr=${c.addr} laddr=${c.laddr || "10.0.1.5:6379"} fd=${c.fd || 8 + (c.id % 900)} name=${c.name || ""} age=${c.age || 0} idle=${c.idle || 0} flags=${c.flags || "N"} db=0 sub=${c.sub || 0} psub=0 ssub=0 multi=-1 qbuf=${c.qbuf || 0} qbuf-free=${c.qbuf ? 0 : 20474} obl=0 oll=${c.oll || 0} omem=${c.omem || 0} tot-mem=${(c.omem || 0) + (c.qbuf || 0) + 22426} events=${c.events || "r"} cmd=${c.cmd || "get"} user=default lib-name=${c.lib || "redis-py"}`;
  function infoOf(N) {
    const S = [];
    S.push(["Server", [["redis_version", N.ver || "7.2.5"], ["redis_mode", N.mode || "standalone"], ["os", "Linux 6.8.0-1016-aws x86_64"], ["process_id", N.pid || 1], ["tcp_port", 6379], ["uptime_in_days", N.uptime || 41]]]);
    S.push(["Clients", [["connected_clients", (N.nclients || 0) + (N.clients || []).length], ["blocked_clients", 0], ["maxclients", 10000]]]);
    if (N.used != null) {
      const rss = N.rss || Math.round(N.used * 1.08);
      const memClients = N.memClients != null ? N.memClients : (N.clients || []).reduce((s, c) => s + (c.omem || 0) + (c.qbuf || 0) + 22426, 0) + (N.nclients || 0) * 22426;
      S.push(["Memory", [
        ["used_memory", N.used], ["used_memory_human", human(N.used)], ["used_memory_rss", rss], ["used_memory_rss_human", human(rss)],
        ["used_memory_peak_human", human(Math.max(N.peak || 0, N.used))],
        ...(N.dataset != null ? [["used_memory_dataset", N.dataset], ["used_memory_dataset_perc", (N.dataset / N.used * 100).toFixed(2) + "%"]] : []),
        ["total_system_memory_human", human(N.sys || 16 * GB)],
        ["maxmemory", N.cfg.maxmemory || 0], ["maxmemory_human", human(+N.cfg.maxmemory || 0)], ["maxmemory_policy", N.cfg["maxmemory-policy"] || "noeviction"],
        ["mem_fragmentation_ratio", (rss / N.used).toFixed(2)], ["mem_fragmentation_bytes", rss - N.used],
        ["mem_not_counted_for_evict", 0], ["mem_clients_slaves", 0], ["mem_clients_normal", memClients],
        ["mem_allocator", N.alloc || "jemalloc-5.3.0"], ["active_defrag_running", N.defragRunning || 0], ["lazyfree_pending_objects", 0],
      ]]);
    }
    if (N.pers) S.push(["Persistence", Object.entries(N.pers)]);
    if (N.stats) S.push(["Stats", Object.entries(N.stats)]);
    if (N.repl) S.push(["Replication", Object.entries(N.repl)]);
    if (N.cpu) S.push(["CPU", Object.entries(N.cpu)]);
    if (N.cmdstats) S.push(["Commandstats", N.cmdstats.map(([c, calls, usec]) => [`cmdstat_${c}`, `calls=${calls},usec=${Math.round(usec)},usec_per_call=${(usec / calls).toFixed(2)},rejected_calls=0,failed_calls=0`])]);
    if (N.errstats) S.push(["Errorstats", Object.entries(N.errstats).map(([k, v]) => [`errorstat_${k}`, `count=${v}`])]);
    if (N.mode === "cluster") S.push(["Cluster", [["cluster_enabled", 1]]]);
    if (N.dbsize != null) S.push(["Keyspace", N.dbsize ? [["db0", `keys=${N.dbsize},expires=${N.expires || 0},avg_ttl=${N.avgTtl || 0}`]] : []]);
    return S;
  }
  const renderInfo = (N, sec) => {
    const all = infoOf(N);
    const want = !sec || /^(all|everything|default)$/i.test(sec) ? all.filter(([n]) => n !== "Commandstats" && n !== "Errorstats" || /^(all|everything)$/i.test(sec || "")) : all.filter(([n]) => n.toLowerCase() === sec.toLowerCase());
    if (!want.length) return "";
    return want.map(([n, kv]) => `# ${n}\n` + kv.map(([k, v]) => `${k}:${v}`).join("\n")).join("\n\n");
  };

  /* ---------- the sandbox ----------
     rcli(o) -> shell spec for LB.term.
     o.init: { def: host, nodes: { host: Node } }. Node: { role, cfg, keys: {name: {t, ttl, mem, n, enc, idle, freq}}, dbsize, expires,
             used, rss, sys, clients, slowlog, latency, stats, repl, pers, cpu, down?: "refused" }
     o.raw: defs matched against the whole line first (shell pipelines); o.extra: defs matched after the redis-cli prefix is stripped.
     o.on: hooks { set(N, key, val, st) -> undefined | "error text" | {danger, out}, kill(N, c, st) -> {danger}?,
                   del(N, names, lazy, st) -> {danger}?, cmd(N, words, st) -> string|object|undefined (intercepts any command) } */
  const node = (st, h) => st.nodes[h || st.h || st.def];
  function rcli(o) {
    const on = o.on || {};
    const ttlOf = (k) => (k ? (k.ttl == null ? -1 : k.ttl) : -2);
    const builtins = [
      { re: /^PING$/i, use: "PING", desc: "", hidden: true, run: () => "PONG" },
      { re: /^INFO(?: (\w+))?$/i, use: "INFO [section]", desc: "server, memory, stats, replication, persistence, keyspace, commandstats, errorstats...", run: (m, st) => renderInfo(node(st), m[1]) },
      { re: /^CONFIG GET (\S+)$/i, use: "CONFIG GET <pattern>", desc: "read config (glob patterns allowed)", run: (m, st) => { const N = node(st), re = glob(unq(m[1]).toLowerCase()); const ks = Object.keys(N.cfg).filter((k) => re.test(k)); return rep(ks.flatMap((k) => [k, String(N.cfg[k])])); } },
      { re: /^CONFIG SET (\S+) (.+)$/i, use: "CONFIG SET <param> <value>", desc: "change config at runtime", run: (m, st) => {
        const N = node(st), k = unq(m[1]).toLowerCase(); let v = unq(m[2].trim());
        if (!(k in N.cfg)) return `(error) ERR Unknown option or number of arguments for CONFIG SET - '${k}'`;
        if (k === "maxmemory-policy" && !POLICIES.includes(v)) return `(error) ERR CONFIG SET failed (possibly related to argument 'maxmemory-policy') - argument(s) must be one of the following: ${POLICIES.join(", ")}`;
        if (k === "maxmemory") { const b = parseMem(v); if (b == null) return "(error) ERR CONFIG SET failed (possibly related to argument 'maxmemory') - argument couldn't be parsed into an integer"; v = String(b); }
        if (/^(activedefrag|lazyfree-|appendonly|replica-lazy)/.test(k) && !/^(yes|no)$/i.test(v)) return `(error) ERR CONFIG SET failed (possibly related to argument '${k}') - argument must be 'yes' or 'no'`;
        const r = on.set ? on.set(N, k, v, st) : undefined;
        if (typeof r === "string") return r;
        N.cfg[k] = /^\d+$/.test(v) && typeof N.cfg[k] === "number" ? +v : v;
        if (k === "maxmemory") N.cfg[k] = +v;
        return r && (r.danger || r.out) ? { out: r.out || "OK", danger: r.danger } : "OK";
      } },
      { re: /^CONFIG REWRITE$/i, use: "CONFIG REWRITE", desc: "persist runtime config to redis.conf", run: (m, st) => { node(st).rewritten = true; return "OK"; } },
      { re: /^DBSIZE$/i, use: "DBSIZE", desc: "number of keys", run: (m, st) => rep(node(st).dbsize || 0) },
      { re: /^P?TTL (\S+)$/i, use: "TTL <key>", desc: "seconds to live (-1 none, -2 missing)", run: (m, st) => { const t = ttlOf(node(st).keys[unq(m[1])]); return rep(/^PTTL/i.test(m[0]) && t > 0 ? t * 1000 : t); } },
      { re: /^TYPE (\S+)$/i, use: "TYPE <key>", desc: "", run: (m, st) => { const k = node(st).keys[unq(m[1])]; return k ? k.t : "none"; } },
      { re: /^EXISTS (.+)$/i, use: "EXISTS <key>", desc: "", hidden: true, run: (m, st) => rep(argv(m[1]).filter((n) => node(st).keys[n]).length) },
      { re: /^OBJECT (ENCODING|FREQ|IDLETIME) (\S+)$/i, use: "OBJECT ENCODING|FREQ|IDLETIME <key>", desc: "internal encoding, LFU counter, idle seconds", run: (m, st) => {
        const N = node(st), k = N.keys[unq(m[2])], sub = m[1].toUpperCase();
        if (!k) return "(nil)";
        if (sub === "ENCODING") return `"${k.enc || { string: "raw", hash: "hashtable", list: "quicklist", set: "hashtable", zset: "skiplist", stream: "stream" }[k.t]}"`;
        const lfu = /lfu/.test(N.cfg["maxmemory-policy"] || "");
        if (sub === "FREQ") return lfu ? rep(k.freq || 1) : "(error) " + NOLFU;
        return lfu ? "(error) ERR An LRU maxmemory policy is not selected, no idle time tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust." : rep(k.idle || 0);
      } },
      { re: /^MEMORY USAGE (\S+)(?: SAMPLES (\d+))?$/i, use: "MEMORY USAGE <key> [SAMPLES n]", desc: "bytes a key uses", run: (m, st) => { const k = node(st).keys[unq(m[1])]; return k ? rep(k.mem) : "(nil)"; } },
      { re: /^SCAN (\d+)((?: (?:MATCH|COUNT|TYPE) \S+)*)$/i, use: "SCAN <cursor> [MATCH pattern] [COUNT n]", desc: "iterate keys without blocking", run: (m, st) => {
        const N = node(st), opt = argv(m[2]); let pat = null, cnt = 10;
        for (let i = 0; i < opt.length; i += 2) { if (/^match$/i.test(opt[i])) pat = opt[i + 1]; if (/^count$/i.test(opt[i])) cnt = Math.max(1, +opt[i + 1] || 10); }
        const names = Object.keys(N.keys).sort(), cur = +m[1], page = Math.max(1, Math.round(cnt / Math.max(1, (N.dbsize || names.length) / Math.max(1, names.length))));
        const slice = names.slice(cur, cur + page), nxt = cur + page >= names.length ? 0 : cur + page;
        return rep([String(nxt), slice.filter((n) => !pat || glob(pat).test(n))]);
      } },
      { re: /^KEYS (\S+)$/i, use: "KEYS <pattern>", desc: "list matching keys (O(N), blocks the server)", run: (m, st) => {
        const N = node(st), re = glob(unq(m[1])), hits = Object.keys(N.keys).filter((n) => re.test(n));
        const out = hits.length ? rep(hits.slice(0, 12)) + (hits.length > 12 ? `\n... (${hits.length - 12} more)` : "") : "(empty array)";
        return (N.dbsize || 0) > 20000 ? { out, danger: `KEYS walks all ${K.num(N.dbsize)} keys in one go on the single command thread: Redis served nothing else for ~${K.num(Math.round(N.dbsize / 9000))} ms. Use SCAN.` } : out;
      } },
      { re: /^(DEL|UNLINK) (.+)$/i, use: "DEL|UNLINK <key> [key ...]", desc: "delete keys (UNLINK frees memory in a background thread)", run: (m, st) => {
        const N = node(st), names = argv(m[2]), lazy = /^unlink$/i.test(m[1]);
        if (N.role === "slave" || N.role === "replica") return "(error) READONLY You can't write against a read only replica.";
        if (N.mode === "cluster" && new Set(names.map(slotOf)).size > 1) return "(error) CROSSSLOT Keys in request don't hash to the same slot";
        const hit = names.filter((n) => N.keys[n]);
        const r = on.del ? on.del(N, hit, lazy || N.cfg["lazyfree-lazy-user-del"] === "yes", st) || {} : {};
        let danger = r.danger;
        if (!danger && !lazy && N.cfg["lazyfree-lazy-user-del"] !== "yes") { const big = hit.map((n) => N.keys[n]).find((k) => (k.n || 0) > 200000); if (big) danger = `DEL frees ${K.num(big.n)} elements synchronously: Redis was blocked for ~${K.ms(big.n / 5000)} and every client timed out. UNLINK frees big values in a background thread.`; }
        hit.forEach((n) => { if (N.keys[n].ttl > 0) N.expires = Math.max(0, (N.expires || 0) - 1); N.used = Math.max(0, (N.used || 0) - (N.keys[n].mem || 0)); delete N.keys[n]; N.dbsize = Math.max(0, (N.dbsize || 0) - 1); });
        if (r.out) return { out: r.out, danger };
        return danger ? { out: rep(hit.length), danger } : rep(hit.length);
      } },
      { re: /^P?EXPIRE (\S+) (\d+)$/i, use: "EXPIRE <key> <seconds>", desc: "", run: (m, st) => { const N = node(st), k = N.keys[unq(m[1])]; if (!k) return rep(0); if (on.expire) { const r = on.expire(N, unq(m[1]), +m[2], st); if (r) return r; } k.ttl = +m[2]; return rep(1); } },
      { re: /^SLOWLOG (GET|LEN|RESET)(?: (\d+))?$/i, use: "SLOWLOG GET [n] | LEN | RESET", desc: "commands slower than slowlog-log-slower-than", run: (m, st) => {
        const N = node(st), sl = N.slowlog || [], sub = m[1].toUpperCase();
        if (sub === "LEN") return rep(sl.length);
        if (sub === "RESET") { N.slowlog = []; return "OK"; }
        const n = m[2] ? +m[2] : 10;
        return rep(sl.slice(0, n).map((e) => [e.id, e.ts, e.us, e.args, e.addr, e.name || ""]));
      } },
      { re: /^LATENCY (LATEST|HISTORY (\S+)|RESET|DOCTOR)$/i, use: "LATENCY LATEST | HISTORY <event>", desc: "latency monitor (spikes above latency-monitor-threshold)", run: (m, st) => {
        const N = node(st), lt = N.latency || [];
        if (/^RESET/i.test(m[1])) { N.latency = []; return rep(lt.length); }
        if (/^DOCTOR/i.test(m[1])) return lt.length ? `Dave, I have observed latency spikes in this Redis instance.\n${lt.map((e, i) => `${i + 1}. ${e.ev}: ${e.n || 3} latency spikes (average ${e.avg || e.last}ms, mean deviation ${Math.round((e.max - e.last) / 2) || 1}ms, period ${e.period || 60} sec). Worst all time event ${e.max}ms.`).join("\n")}` : "Dave, no latency spike was observed during the lifetime of this Redis instance, not in the slightest bit.";
        if (/^HISTORY/i.test(m[1])) { const e = lt.find((x) => x.ev === m[2]); return e ? rep((e.hist || [[e.ts, e.last]]).map(([t, v]) => [t, v])) : "(empty array)"; }
        return rep(lt.map((e) => [e.ev, e.ts, e.last, e.max]));
      } },
      { re: /^CLIENT LIST$/i, use: "CLIENT LIST", desc: "connected clients (name, cmd, output buffer omem)", run: (m, st) => (node(st).clients || []).map(clientLine).join("\n") + ((node(st).nclients || 0) ? `\n... (${node(st).nclients} more app clients like the ones above, omem=0)` : "") },
      { re: /^CLIENT KILL (?:ID )?(\S+)$/i, use: "CLIENT KILL ID <id>", desc: "disconnect one client", run: (m, st) => {
        const N = node(st), c = (N.clients || []).find((x) => String(x.id) === m[1] || x.addr === m[1]);
        if (!c) return /^\d+$/.test(m[1]) ? rep(0) : "(error) ERR No such client";
        N.clients = N.clients.filter((x) => x !== c);
        const r = on.kill ? on.kill(N, c, st) || {} : {};
        return r.danger ? { out: rep(1), danger: r.danger } : rep(1);
      } },
      { re: /^CLUSTER KEYSLOT (\S+)$/i, use: "CLUSTER KEYSLOT <key>", desc: "hash slot of a key", run: (m) => rep(slotOf(unq(m[1]))) },
      { re: /^(FLUSHALL|FLUSHDB)(?: (?:ASYNC|SYNC))?$/i, use: "FLUSHALL", desc: "delete every key", run: (m, st) => { const N = node(st); if (N.role === "slave") return "(error) READONLY You can't write against a read only replica."; N.keys = {}; N.dbsize = 0; N.expires = 0; st.flushed = true; return { out: "OK", danger: "You just deleted every key in production. Every request is now a cache miss and goes to the database." }; } },
      { re: /^MONITOR$/i, use: "MONITOR", desc: "stream every command (expensive)", run: (m, st) => ({ out: (node(st).monitor || ['1760000000.112341 [0 10.0.4.21:51234] "GET" "cache:home"']).join("\n") + "\n^C", danger: "MONITOR streams every command to your client and can cut a busy server's throughput in half. Prefer --hotkeys, SLOWLOG or commandstats." }) },
      { re: /^SAVE$/i, use: "SAVE", desc: "", hidden: true, run: () => ({ out: "OK", danger: "SAVE writes the RDB on the main thread: the server served nothing until it finished." }) },
      { re: /^BGSAVE$/i, use: "BGSAVE", desc: "", hidden: true, run: () => "Background saving started" },
      { re: /^SHUTDOWN.*$/i, use: "SHUTDOWN", desc: "", hidden: true, run: (m, st) => { st.shutdown = true; return { out: "(error) ERR Errors trying to SHUTDOWN. Check logs.", danger: "You tried to shut down a production Redis." }; } },
    ];
    const head = K.shell([...(o.extra || []), ...builtins], { sh: "redis-cli" });
    const raw = o.raw ? K.shell(o.raw, { sh: "bash" }) : null;
    const prefix = /^redis-cli((?:\s+(?:-h\s+\S+|-p\s+\d+|-c|-a\s+\S+|--no-auth-warning|--user\s+\S+))*)\s*(.*)$/i;
    const run = (line, st) => {
      const s = String(line).trim().replace(/\s+/g, " ");
      if (raw) { for (const d of o.raw) { if (d.re.test(s)) return raw.run(s, st); } }
      const m = s.match(prefix);
      let rest = s, host = null;
      if (m) { rest = m[2]; const hm = m[1].match(/-h (\S+)/); if (hm) host = hm[1]; const pm = m[1].match(/-p (\d+)/); if (pm && pm[1] === "26379") host = (host || "") + ":26379"; }
      if (m && !rest) return { out: "(interactive mode is not available here: pass the command, e.g. redis-cli -h host INFO memory)", silent: true };
      st.h = host && (st.nodes[host] || st.nodes[host.replace(/:26379$/, "")] || /:26379$/.test(host)) ? host : host ? "?" + host : null;
      if (st.h && st.h[0] === "?") { const h = st.h.slice(1); st.h = null; return { out: `Could not connect to Redis at ${h}:6379: Name or service not known` }; }
      const N = node(st);
      if (N && N.down) { st.h = null; return { out: `Could not connect to Redis at ${host || st.def}:6379: Connection refused` }; }
      // upper-case the command word so K.shell's usage hints work
      const w = rest.split(" ");
      if (w[0] && !w[0].startsWith("-")) w[0] = w[0].toUpperCase();
      rest = w.join(" ");
      if (on.cmd) { const r = on.cmd(N, rest, st); if (r != null) { st.h = null; return typeof r === "string" ? { out: r } : r; } }
      const r = head.run(rest, st);
      st.h = null;
      if (/command not found/.test(r.out || "")) return { out: `(error) ERR unknown command '${w[0]}', with args beginning with: ${w.slice(1).map((x) => `'${x}' `).join("")}`.trim() + "  (type help)", silent: true };
      return r;
    };
    return { prompt: o.prompt || "$", init: o.init, run, motd: o.motd, cmds: o.cmds, par: o.par, opts: o.opts, optq: o.optq };
  }
  const R_K = { rep, human, parseMem, unq, argv, glob, crc16, slotOf, rcli, node, OK, POLICIES };
  LB.redisKit = R_K;
  const hostOf = (I, i) => I.hosts[i];
  void hostOf;

  /* ---------- shared bits for briefings ---------- */
  const appName = (R) => R.pick(["Larkspur", "Quillmart", "Tidewell", "Brindle", "Copperleaf", "Northwind Foods", "Orbitly", "Pinecart"]);

  /* ================= scenarios ================= */
  const S = [];

  /* ----- 1. OOM with volatile-lru ----- */
  function oomShell(I) {
    const lv = I.lv, maxm = I.maxGB * GB;
    const keys = {
      [`cache:product:${I.pid}`]: { t: "string", ttl: lv === 3 ? 812 : -1, mem: 4216, enc: "raw", idle: 3 },
      [`cache:page:home:${I.loc}`]: { t: "string", ttl: lv === 3 ? 41 : -1, mem: 51320, enc: "raw", idle: 0 },
      [`sess:${I.sid}`]: { t: "hash", ttl: 1620, mem: 912, enc: "listpack", idle: 120 },
    };
    if (lv === 2) { keys[`bull:emails:${I.job}`] = { t: "hash", ttl: -1, mem: 1840, enc: "listpack", idle: 4 }; keys["bull:emails:wait"] = { t: "list", ttl: -1, mem: 2210512, n: 18320, enc: "quicklist", idle: 0 }; }
    const clients = [
      { id: 812, addr: "10.0.4.21:51234", name: "catalog-api", age: 81211, idle: 0, cmd: "get" },
      { id: 813, addr: "10.0.4.22:40112", name: "catalog-api", age: 81210, idle: 0, cmd: "set" },
      { id: 901, addr: "10.0.6.14:39001", name: "worker", age: 3612, idle: 1, cmd: lv === 2 ? "brpoplpush" : "get", flags: lv === 2 ? "b" : "N" },
    ];
    if (lv === 3) clients.push({ id: I.subId, addr: "10.0.9.40:52210", name: I.subName, age: 52211, idle: 0, flags: "P", sub: 3, cmd: "subscribe", omem: I.omem, oll: 912340, lib: "ioredis" }, { id: I.subId + 7, addr: "10.0.9.41:52244", name: I.subName.replace(/\d+$/, (d) => +d + 1), age: 52190, idle: 0, flags: "P", sub: 3, cmd: "subscribe", omem: 0, lib: "ioredis" });
    const used = lv === 3 ? maxm - 2 * MB : maxm + 1200 * 1024;
    const N = {
      role: "master", ver: "7.2.5", used, rss: Math.round(used * (lv === 3 ? 1.03 : 1.09)), sys: I.sysGB * GB, dbsize: I.keys, expires: I.expires, avgTtl: lv === 3 ? 902000 : 1500000,
      dataset: lv === 3 ? used - I.omem - 40 * MB : Math.round(used * 0.93),
      cfg: { maxmemory: maxm, "maxmemory-policy": I.policy, "maxmemory-samples": 5, "client-output-buffer-limit": lv === 3 ? "normal 0 0 0 slave 268435456 67108864 60 pubsub 0 0 0" : "normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60", "lfu-log-factor": 10, "lfu-decay-time": 1 },
      keys, clients, nclients: 140,
      stats: { total_commands_processed: 98123311, instantaneous_ops_per_sec: 31840, expired_keys: lv === 3 ? 41203 : 812, evicted_keys: lv === 3 ? 18912044 : lv === 2 ? 3402 : 0, keyspace_hits: 81233019, keyspace_misses: lv === 3 ? 61233102 : 4120013, total_error_replies: I.errs },
      errstats: { OOM: I.errs },
    };
    return rcli({
      prompt: `${I.host}:6379>`,
      init: { def: I.host, nodes: { [I.host]: N } },
      motd: `ALERT ${I.app} catalog-api error rate ${I.errPct}%: "OOM command not allowed when used memory > 'maxmemory'."${lv === 3 ? "\nALERT cache hit ratio 93% -> 46% in 20 min" : ""}\nredis-cli 7.2.5 connected to ${I.host}:6379`,
      cmds: ["INFO memory", "INFO keyspace", "INFO stats", "CONFIG GET maxmemory*", "TTL <key>", "SCAN 0 COUNT 100", "CLIENT LIST", "CONFIG SET <param> <value>", ...(lv === 3 ? ["CLIENT KILL ID <id>"] : [])],
      par: lv === 3 ? 7 : 6,
      opts: lv === 2 ? I.opts : undefined, optq: "Root cause",
      on: {
        set(N, k, v, st) {
          if (k === "maxmemory" && +v === 0) return { danger: `maxmemory 0 means "no limit": on a ${I.sysGB} GB host Redis now grows until the kernel OOM-kills it, taking every key with it.` };
          if (k === "maxmemory-policy" && lv === 2 && /^allkeys/.test(v)) st.queueRisk = true;
          if (k === "client-output-buffer-limit") { const m = v.match(/pubsub (\S+) (\S+) (\d+)/i); if (!m || !(parseMem(m[1]) > 0)) return "(error) ERR CONFIG SET failed (possibly related to argument 'client-output-buffer-limit') - Wrong format"; st.pubsubLimit = parseMem(m[1]); }
          return undefined;
        },
        kill(N, c, st) {
          if (c.id === I.subId) { N.used -= I.omem; st.killedSub = true; return null; }
          return { danger: `Client ${c.id} (${c.name}) was a healthy application connection.` };
        },
      },
    });
  }
  S.push({
    id: "redis-oom-volatile",
    name: "Writes fail with OOM",
    kind: "Incident",
    skills: ["diagnose", "tune"],
    ...LB.term({
      shell: oomShell,
      goal(st, I, a) {
        const N = st.nodes[I.host], pol = N.cfg["maxmemory-policy"], mm = +N.cfg.maxmemory;
        if (st.flushed) return "Flushing the cache 'fixes' OOM by throwing away the whole working set: the database just took 100% of the traffic.";
        if (mm === 0) return "With no maxmemory, Redis will grow until the kernel kills it.";
        if (I.lv === 1) {
          if (/^allkeys-(lru|lfu)$/.test(pol)) return true;
          if (pol === "allkeys-random") return "That stops the errors, but random eviction throws out hot keys as readily as cold ones. Pick a policy that keeps the working set.";
          if (mm > I.maxGB * GB) return `Raising maxmemory only postpones it: <code>INFO keyspace</code> shows <b>expires=0</b>, so under <code>${esc(pol)}</code> nothing is ever evictable and you'll hit the new limit too.`;
          return `Writes still fail: under <code>${esc(pol)}</code> only keys with a TTL can be evicted, and none of the ${K.num(I.keys)} keys have one.`;
        }
        if (I.lv === 2) {
          if (st.queueRisk || /^allkeys/.test(pol)) return "An <code>allkeys-*</code> policy lets Redis evict the BullMQ job keys (<code>bull:emails:*</code>, no TTL) that share this instance: queued emails would silently disappear.";
          if (mm < N.used * 1.1) return `Writes still fail: used_memory is ${human(N.used)} against maxmemory ${human(mm)}, and under <code>${esc(pol)}</code> the TTL-less cache keys can't be evicted. Buy headroom first.`;
          if (mm > I.sysGB * GB * 0.7) return `maxmemory ${human(mm)} on a ${I.sysGB} GB host leaves no room for fragmentation and copy-on-write during BGSAVE/replica sync; keep it under ~${Math.floor(I.sysGB * 0.7)} GB.`;
          if (a.pick !== I.ans) return "Writes work again, but the diagnosis is off. Compare INFO keyspace <code>expires</code> with the key count and check a few cache keys' TTL.";
          return true;
        }
        if (!st.killedSub) return `Memory is still full: <code>mem_clients_normal</code> is ${human(I.omem)}. Something other than the dataset is using it.`;
        if (!(st.pubsubLimit > 0)) return "You freed the memory, but <code>client-output-buffer-limit</code> for pubsub is still <code>0 0 0</code> (unlimited): the subscriber reconnects and does it again within the hour.";
        return true;
      },
      solve: (I) => ({
        log: I.lv === 1 ? ["INFO memory", "INFO keyspace", "CONFIG SET maxmemory-policy allkeys-lru"]
          : I.lv === 2 ? ["INFO memory", "INFO keyspace", `TTL cache:product:${I.pid}`, `CONFIG SET maxmemory ${Math.min(Math.floor(I.sysGB * 0.6), I.maxGB + 2)}gb`]
            : ["INFO memory", "CLIENT LIST", `CLIENT KILL ID ${I.subId}`, 'CONFIG SET client-output-buffer-limit "pubsub 32mb 8mb 60"'],
        pick: I.lv === 2 ? I.ans : null,
      }),
    }),
    gen(lv, R) {
      const maxGB = lv === 1 ? R.pick([4, 6, 8]) : lv === 2 ? R.pick([5, 6]) : R.pick([8, 10, 12]);
      const I = { lv, app: appName(R), host: `cache-${R.pick(["catalog", "web", "edge"])}-${R.int(1, 4)}`, maxGB, sysGB: lv === 2 ? 16 : maxGB + R.pick([4, 6, 8]), keys: R.int(28, 61) * 100000 + R.int(0, 99999), pid: R.int(10000, 99999), sid: R.int(100000, 999999).toString(16), loc: R.pick(["en-gb", "de-de", "fr-fr"]), errPct: R.int(18, 64), errs: R.int(20000, 90000), job: R.int(1000, 9999) };
      I.policy = lv === 3 ? R.pick(["allkeys-lru", "allkeys-lfu"]) : "volatile-lru";
      I.expires = lv === 1 ? 0 : lv === 2 ? R.int(150, 260) * 1000 : Math.round(I.keys * 0.97);
      if (lv === 3) { I.subId = R.int(5000, 9000); I.subName = `ws-fanout-${R.int(2, 9)}`; I.omem = Math.round((maxGB * 0.62 + R.next() * 0.1 * maxGB) * GB); }
      if (lv === 2) { const o = ["maxmemory is too small for the dataset; the instance needs more RAM", "cache:* keys are being written without a TTL, so volatile-lru has almost nothing it may evict", "memory fragmentation is inflating used_memory", "the BullMQ queue is backing up and filling memory"]; const ord = R.shuffle([0, 1, 2, 3]); I.opts = ord.map((i) => o[i]); I.ans = ord.indexOf(1); }
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: ["CONFIG SET maxmemory 0"] }, { log: [`CONFIG SET maxmemory ${I.maxGB + 2}gb`] }, { log: ["CONFIG SET maxmemory-policy volatile-lfu"] }]
      : I.lv === 2 ? [{ log: ["CONFIG SET maxmemory-policy allkeys-lru"], pick: I.ans }, { log: [`CONFIG SET maxmemory ${I.maxGB + 2}gb`], pick: (I.ans + 1) % 4 }, { log: ["CONFIG SET maxmemory 15gb"], pick: I.ans }]
        : [{ log: ["CONFIG SET maxmemory-policy allkeys-random"] }, { log: [`CLIENT KILL ID ${I.subId}`] }, { log: ["CLIENT KILL ID 812", 'CONFIG SET client-output-buffer-limit "pubsub 32mb 8mb 60"'] }],
    text: (I) => `<p><b>PAGE:</b> ${esc(I.app)}'s catalog API is failing ${I.errPct}% of requests with <code>OOM command not allowed when used memory &gt; 'maxmemory'</code>.${I.lv === 3 ? " The cache hit ratio has also halved in the last 20 minutes." : ""} ${I.lv === 2 ? "This instance is shared: the catalog cache plus the BullMQ queue for transactional emails. A deploy went out yesterday." : I.lv === 1 ? "The instance is a pure cache: everything in it can be rebuilt from Postgres." : `The eviction policy is already <code>${esc(I.policy)}</code>.`}</p><p>You have <code>redis-cli</code> on <code>${esc(I.host)}</code>. Find out why writes are refused and fix it${I.lv === 2 ? " safely, then name the root cause" : ""}. Type <code>help</code> for what this sandbox understands.</p>`,
    hint: (I) => I.lv === 1 ? "Which keys does a volatile-* policy consider for eviction? Compare INFO keyspace keys= and expires=." : I.lv === 2 ? "Some keys here must never be evicted. Check TTLs on the cache keys, then buy headroom without exposing the queue." : "Evictions are running hot yet memory is still full. How much of used_memory is the dataset? Look at mem_clients_normal and CLIENT LIST omem.",
    concept: "maxmemory, eviction policies and what counts as used memory",
    how: "When used_memory reaches maxmemory, Redis evicts keys according to maxmemory-policy before executing a write. volatile-* policies only consider keys that have a TTL; if none (or too few) do, there is nothing to evict and writes fail with OOM. allkeys-lru/lfu evict any key, which is right for a pure cache and dangerous for data that must not disappear (queues, locks, sessions without a backing store). used_memory also includes client buffers: a slow Pub/Sub subscriber with an unlimited output buffer can eat gigabytes, forcing Redis to evict the dataset to make room, until the hit ratio collapses.",
    rule: "Pure caches: allkeys-lru or allkeys-lfu and a TTL on everything. Never mix must-keep data (queues, locks) with evictable cache in one instance, and keep a pubsub client-output-buffer-limit so one slow consumer can't eat your memory.",
    why: (I) => I.lv === 1 ? `INFO keyspace showed <b>expires=0</b> across ${K.num(I.keys)} keys. Under volatile-lru Redis may only evict keys with a TTL, so at ${I.maxGB} GB every write failed. As a pure cache, allkeys-lru (or allkeys-lfu) is the right policy.`
      : I.lv === 2 ? `Only ~${K.num(I.expires)} of ${K.num(I.keys)} keys had a TTL: yesterday's deploy started writing <code>cache:*</code> keys without one, so volatile-lru had almost nothing to evict. Switching to allkeys-* would have let Redis evict BullMQ's job hashes. The safe stopgap is headroom (the host has ${I.sysGB} GB) while the code fix restores the TTL; long-term, split the queue onto its own instance with noeviction.`
        : `The dataset was only a fraction of used_memory: subscriber <code>${esc(I.subName)}</code> had a ${human(I.omem)} output buffer because the pubsub limit was <code>0 0 0</code>. Redis counted that against maxmemory and evicted the dataset to make room (hit ratio halved), then ran out of evictable keys. Killing the client freed the memory; restoring the pubsub limit (e.g. 32mb hard / 8mb for 60 s) makes Redis disconnect slow consumers instead.`,
  });

  /* ----- 2. big keys: DEL vs UNLINK, lazyfree ----- */
  function bigShell(I) {
    const lv = I.lv, P = I.host, Rh = I.host + "-replica";
    const keys = {
      [`cache:user:${I.uid}`]: { t: "string", ttl: 3400, mem: 2104, enc: "embstr" },
      [`ratelimit:${I.uid}`]: { t: "string", ttl: 41, mem: 72, enc: "int" },
    };
    if (lv === 1) keys[I.big] = { t: "set", ttl: -1, mem: I.mem, n: I.n, enc: "hashtable", idle: 2592000 };
    if (lv === 2) { keys[I.big] = { t: "hash", ttl: 310, mem: I.mem, n: I.n, enc: "hashtable", idle: 1 }; keys[I.big.replace(/\d+$/, (d) => +d + 1)] = { t: "hash", ttl: 540, mem: Math.round(I.mem * 0.9), n: Math.round(I.n * 0.9), enc: "hashtable", idle: 2 }; }
    if (lv === 3) keys[I.big] = { t: "zset", ttl: -1, mem: I.mem, n: I.n, enc: "skiplist", idle: 5 };
    const now = 1760100000;
    const base = (role) => ({
      role, ver: "7.2.5", used: 9.2 * GB, sys: 32 * GB, dbsize: 2140331, expires: 2101992,
      cfg: { "lazyfree-lazy-user-del": "no", "lazyfree-lazy-expire": "no", "lazyfree-lazy-eviction": "no", "lazyfree-lazy-server-del": "no", "latency-monitor-threshold": 100, "slowlog-log-slower-than": 10000 },
      keys: role === "master" ? keys : K.clone(keys), clients: [{ id: 31, addr: "10.0.4.12:50122", name: "api", age: 9123, cmd: "get" }, ...(lv === 3 && role === "master" ? [{ id: 77, addr: "10.0.7.3:43110", name: "rollup-cron", age: 1810, idle: 1790, cmd: "del" }] : [])], nclients: 212,
      slowlog: role !== "master" ? [] : lv === 1 ? [{ id: 91, ts: now - 400, us: 14211, args: ["HGETALL", `cart:${I.uid}`], addr: "10.0.4.12:50122", name: "api" }]
        : lv === 2 ? [{ id: 412, ts: now - 50, us: 12880, args: ["HGETALL", `cart:${I.uid}`], addr: "10.0.4.12:50122", name: "api" }, { id: 411, ts: now - 190, us: 11020, args: ["ZRANGE", "trending", "0", "199"], addr: "10.0.4.19:40012", name: "api" }]
          : [{ id: 220, ts: now - 1790, us: I.us, args: ["DEL", I.big.replace(/\d+$/, (d) => +d - 1)], addr: "10.0.7.3:43110", name: "rollup-cron" }, { id: 219, ts: now - 5390, us: I.us - 41000, args: ["DEL", I.big.replace(/\d+$/, (d) => +d - 2)], addr: "10.0.7.3:43110", name: "rollup-cron" }],
      latency: lv === 1 ? [] : lv === 2 ? [{ ev: "expire-del", ts: now - 30, last: Math.round(I.us / 1000), max: Math.round(I.us / 1000 * 1.3), n: 14, period: 300 }, { ev: "fork", ts: now - 900, last: 182, max: 201 }]
        : [{ ev: role === "master" ? "command" : "fast-command", ts: now - 1790, last: Math.round(I.us / 1000), max: Math.round(I.us / 1000) + 40, n: 9, period: 3600 }, { ev: "fork", ts: now - 600, last: 171, max: 188 }],
      repl: role === "master" ? { role: "master", connected_slaves: 1, slave0: `ip=10.0.1.6,port=6379,state=online,offset=88123112,lag=0`, master_repl_offset: 88123112 } : { role: "slave", master_host: "10.0.1.5", master_port: 6379, master_link_status: "up", slave_repl_offset: 88123112, slave_read_only: 1, slave_priority: 100 },
      stats: { instantaneous_ops_per_sec: role === "master" ? 48211 : 22104, expired_keys: 8123441, evicted_keys: 0 },
    });
    const nodes = { [P]: base("master") };
    if (lv === 3) nodes[Rh] = base("slave");
    return rcli({
      prompt: "$",
      init: { def: P, nodes },
      motd: lv === 1 ? `Ticket: "${I.host} is at ${human(9.2 * GB)}; there's a leftover export key from last month eating memory. Please delete it, but this is production: don't cause a latency spike."`
        : lv === 2 ? `ALERT api p99 > 1s on ${I.host}, recurring every few minutes since the reports feature launched\nredis-cli 7.2.5`
          : `ALERT api p99 stalls ~${(I.us / 1e6).toFixed(1)} s at the top of every hour on ${P} AND ${Rh} (reads are served from the replica)\nredis-cli 7.2.5`,
      cmds: lv === 1 ? ["redis-cli --bigkeys", "redis-cli MEMORY USAGE <key>", "redis-cli OBJECT IDLETIME <key>", "redis-cli UNLINK <key>", "redis-cli DEL <key>"]
        : lv === 2 ? ["redis-cli SLOWLOG GET 5", "redis-cli LATENCY LATEST", "redis-cli --bigkeys", "redis-cli CONFIG GET lazyfree*", "redis-cli CONFIG SET <param> <value>"]
          : ["redis-cli SLOWLOG GET 5", "redis-cli LATENCY LATEST", `redis-cli -h ${Rh} LATENCY LATEST`, "redis-cli CONFIG GET lazyfree*", `redis-cli -h ${Rh} CONFIG SET <param> <value>`, "redis-cli CLIENT LIST"],
      par: lv === 3 ? 7 : 5,
      raw: [{ re: /^redis-cli(?: -h (\S+))? --(bigkeys|memkeys)$/i, use: "redis-cli [-h host] --bigkeys | --memkeys", desc: "sample the keyspace for the biggest keys", run: (m, st) => {
        const N = st.nodes[m[1] || st.def]; if (!N) return `Could not connect to Redis at ${m[1]}:6379: Name or service not known`;
        const ks = Object.entries(N.keys);
        const by = {}; ks.forEach(([n, k]) => { const v = m[2] === "memkeys" ? k.mem : k.t === "string" ? k.mem : k.n || 1; if (!by[k.t] || v > by[k.t][1]) by[k.t] = [n, v]; });
        const unit = (t) => (m[2] === "memkeys" ? "bytes" : { string: "bytes", hash: "fields", set: "members", zset: "members", list: "items", stream: "entries" }[t]);
        return `# Scanning the entire keyspace to find biggest keys as well as\n# average sizes per key type.  You can use -i 0.1 to sleep 0.1 sec\n# per 100 SCAN commands (not usually needed).\n\n` + Object.entries(by).map(([t, [n, v]]) => `[${(20 + n.length % 70).toFixed(2)}%] Biggest ${t.padStart(6)} found so far '"${n}"' with ${v} ${unit(t)}`).join("\n") + `\n\n-------- summary -------\n\nSampled ${N.dbsize} keys in the keyspace!\n\n` + Object.entries(by).map(([t, [n, v]]) => `Biggest ${t.padStart(6)} found '"${n}"' has ${v} ${unit(t)}`).join("\n");
      } }],
      on: {
        del(N, names, lazy, st) {
          if (names.includes(I.big) && lv > 1) { st.deletedLive = true; return { danger: `${I.big} is live data that the ${lv === 2 ? "reports feature" : "dashboards"} read; deleting it broke them${lazy ? "" : ", and DEL blocked the server while freeing it"}.` }; }
          return null;
        },
        expire(N, name, secs, st) { if (name === I.big && N.cfg["lazyfree-lazy-expire"] !== "yes") { delete N.keys[name]; N.dbsize--; st.expiredBig = true; return { out: rep(1), danger: `With lazyfree-lazy-expire no, the expiry cycle frees those ${K.num(I.n)} members synchronously: the same stall as DEL, ${secs}s later.` }; } return null; },
      },
    });
  }
  S.push({
    id: "redis-big-key-unlink",
    name: "Delete a giant key without a stall",
    kind: "Incident",
    skills: ["safe", "diagnose"],
    ...LB.term({
      shell: bigShell,
      goal(st, I, a, rp) {
        const P = st.nodes[I.host], Rn = st.nodes[I.host + "-replica"];
        if (I.lv === 1 && rp && rp.danger) return "The key is gone, but freeing it synchronously stalled Redis for seconds: exactly the latency spike the ticket asked you to avoid.";
        if (I.lv === 1) return P.keys[I.big] ? `<code>${esc(I.big)}</code> is still there (${human(I.mem)}).` : true;
        if (st.deletedLive) return "You deleted live data. The keys are fine; the way they're freed is the problem.";
        if (I.lv === 2) return P.cfg["lazyfree-lazy-expire"] === "yes" ? true : "The stalls continue: LATENCY LATEST shows <code>expire-del</code> spikes when the big report hashes expire.";
        if (P.cfg["lazyfree-lazy-user-del"] !== "yes") return "The hourly rollup job's <code>DEL</code> still frees the big zset on the main thread of the primary.";
        if (Rn.cfg["lazyfree-lazy-user-del"] !== "yes") return `The primary is fixed, but the replica executes the same replicated <code>DEL</code> with its own config: <code>${esc(I.host)}-replica</code> still stalls at the top of the hour, and that's where reads go.`;
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["redis-cli --bigkeys", `redis-cli OBJECT IDLETIME ${I.big}`, `redis-cli UNLINK ${I.big}`]
        : I.lv === 2 ? ["redis-cli SLOWLOG GET 5", "redis-cli LATENCY LATEST", "redis-cli CONFIG SET lazyfree-lazy-expire yes"]
          : ["redis-cli SLOWLOG GET 5", `redis-cli -h ${I.host}-replica LATENCY LATEST`, "redis-cli CONFIG SET lazyfree-lazy-user-del yes", `redis-cli -h ${I.host}-replica CONFIG SET lazyfree-lazy-user-del yes`] }),
    }),
    gen(lv, R) {
      const n = lv === 1 ? R.int(12, 30) * 1000000 : lv === 2 ? R.int(15, 40) * 100000 : R.int(30, 80) * 100000;
      const I = { lv, host: `cache-${R.pick(["main", "api", "core"])}-${R.int(1, 3)}`, uid: R.int(100000, 999999), n };
      I.big = lv === 1 ? `tmp:export:2026-${String(R.int(1, 8)).padStart(2, "0")}:emails` : lv === 2 ? `report:${R.int(4000, 9000)}` : `agg:hourly:${R.int(10, 20)}`;
      I.mem = Math.round(n * (lv === 1 ? 72 : lv === 2 ? 110 : 96));
      I.us = Math.round(n / 5) + R.int(1000, 90000);
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: [`redis-cli DEL ${I.big}`] }, { log: [`redis-cli EXPIRE ${I.big} 1`] }] : I.lv === 2 ? [{ log: [`redis-cli UNLINK ${I.big}`] }, { log: ["redis-cli CONFIG SET lazyfree-lazy-user-del yes"] }] : [{ log: ["redis-cli CONFIG SET lazyfree-lazy-user-del yes"] }, { log: ["redis-cli CONFIG SET lazyfree-lazy-expire yes", `redis-cli -h ${I.host}-replica CONFIG SET lazyfree-lazy-expire yes`] }],
    text: (I) => I.lv === 1 ? `<p>A ticket asks you to delete a leftover export key from <code>${esc(I.host)}</code> (Redis 7.2). It's large, and this instance serves ~48k ops/s for the API, so any multi-second pause pages someone.</p><p>Find the key and remove it without blocking Redis.</p>`
      : I.lv === 2 ? `<p>Since the new reports feature launched, API p99 on <code>${esc(I.host)}</code> jumps above 1 s every few minutes. The feature writes each generated report as a hash with a TTL. SLOWLOG doesn't show anything near a second.</p><p>Find what's stalling the server and fix it with a config change; the reports themselves must stay.</p>`
        : `<p>At the top of every hour, both the primary <code>${esc(I.host)}</code> and its replica stall for about ${(I.us / 1e6).toFixed(1)} s. Reads are served from the replica. A rollup cron owned by another team runs hourly; you can't ship a code change to it today.</p><p>Stop the stalls on <b>both</b> nodes with configuration only.</p>`,
    hint: (I) => I.lv === 1 ? "Deleting a value with millions of members costs time proportional to its size. Which command does that work off the main thread?" : I.lv === 2 ? "Deletion doesn't only happen when someone runs DEL. What does LATENCY LATEST call these spikes?" : "There's a config that makes plain DEL behave like UNLINK. Which nodes execute the cron's DEL?",
    concept: "Freeing big keys: DEL vs UNLINK and lazyfree",
    how: "Redis executes commands on one main thread. Freeing a value with millions of elements (DEL, an expiry, an eviction, or an overwrite) walks every element, so the server stalls for hundreds of milliseconds to seconds. UNLINK unlinks the key in O(1) and frees memory in a background thread. The lazyfree-lazy-* settings apply the same trick to implicit deletes: lazyfree-lazy-expire for expiries, lazyfree-lazy-eviction for evictions, lazyfree-lazy-server-del for overwrites, and lazyfree-lazy-user-del makes DEL behave like UNLINK. A replica runs every replicated delete with its own config.",
    rule: "Use UNLINK for anything that might be big, turn on the lazyfree-lazy-* options on every node (primary and replicas), and find big keys with --bigkeys/--memkeys before they find you.",
    why: (I) => I.lv === 1 ? `<code>${esc(I.big)}</code> held ${K.num(I.n)} members (${human(I.mem)}) and hadn't been touched in 30 days. DEL would have blocked the server for seconds; setting a 1 s TTL does the same work on expiry. UNLINK returned at once and freed it in the background.`
      : I.lv === 2 ? `LATENCY LATEST showed <code>expire-del</code> spikes around ${Math.round(I.us / 1000)} ms: each report hash (${K.num(I.n)} fields) was freed synchronously when its TTL fired, which never shows up in SLOWLOG because no client command was slow. lazyfree-lazy-expire yes moves that work to a background thread.`
        : `The rollup cron's hourly <code>DEL</code> of a ${K.num(I.n)}-member zset took ~${(I.us / 1e6).toFixed(1)} s. lazyfree-lazy-user-del yes makes DEL non-blocking without touching the cron, and it has to be set on the replica too, because the replica applies the replicated DEL using its own settings. Persist both with CONFIG REWRITE (or your config management).`,
  });

  /* ----- 3. purge keys with --scan, not KEYS ----- */
  function scanShell(I) {
    const lv = I.lv;
    const groups = (h, f) => ({
      [I.pre]: { n: Math.round(I.n * f), s: I.samples },
      [I.near]: { n: Math.round(I.nNear * f), s: I.nearSamples },
      "cache:product:": { n: Math.round(4100000 * f), s: ["cache:product:81234", "cache:product:1922"] },
      "sess:": { n: Math.round(910000 * f), s: ["sess:9f1c2a", "sess:a77b10"] },
    });
    const nodes = {};
    I.hosts.forEach((h, i) => {
      const isRep = lv === 2 ? h === I.hosts[0] : lv === 3 ? i >= 3 : false;
      const f = lv === 3 ? [0.34, 0.31, 0.35][i % 3] : 1;
      nodes[h] = { role: isRep ? "slave" : "master", mode: lv === 3 ? "cluster" : "standalone", groups: groups(h, f), dbsize: 0, cfg: {}, keys: {}, used: 0, repl: isRep ? { role: "slave", master_host: lv === 2 ? I.hosts[1] : I.hosts[i - 3], master_port: 6379, master_link_status: "up", slave_read_only: 1 } : { role: "master", connected_slaves: 1 } };
      nodes[h].dbsize = Object.values(nodes[h].groups).reduce((s, g) => s + g.n, 0);
    });
    const match = (g, pat) => { const re = glob(pat); const hit = g.s.filter((x) => re.test(x)).length; return Math.round(g.n * hit / g.s.length); };
    const flags = (s) => { const hm = (s || "").match(/-h (\S+)/); return hm ? hm[1] : null; };
    const scanOut = (N, pat) => { const ks = []; Object.values(N.groups).forEach((g) => { const re = glob(pat); g.s.filter((x) => re.test(x)).forEach((x) => ks.push(x)); }); return ks; };
    const conn = (h) => (nodes[h] ? null : `Could not connect to Redis at ${h}:6379: Name or service not known`);
    return rcli({
      prompt: "$",
      init: { def: I.hosts[0], nodes },
      motd: lv === 3 ? `cluster: ${I.hosts.slice(0, 3).join(", ")} (primaries) + 3 replicas · redis 7.2` : `${lv === 2 ? "REDIS_URL=redis://" + I.hosts[0] + ":6379   (the read endpoint the app uses)" : "connected to " + I.hosts[0]} · redis 7.2`,
      cmds: ["redis-cli INFO keyspace", "redis-cli INFO replication", ...(lv === 3 ? ["redis-cli CLUSTER NODES"] : []), `redis-cli --scan --pattern '${I.pat}' | wc -l`, `redis-cli --scan --pattern '${I.pat}' | xargs redis-cli unlink`, ...(lv === 3 ? ["redis-cli -h <host> --scan --pattern '<pattern>' | xargs -n 100 redis-cli -h <host> unlink"] : []), "redis-cli KEYS <pattern>"],
      par: lv === 1 ? 4 : lv === 2 ? 5 : 8,
      raw: [
        { re: /^redis-cli((?: -h \S+| -p \d+| -c)*) --scan --pattern (\S+)(?: --count \d+)?(?: \| (.+))?$/i, use: "redis-cli [-h host] --scan --pattern 'p' [| wc -l | xargs [-n N] redis-cli [-h host] unlink]", desc: "iterate keys with SCAN (non-blocking)", run: (m, st) => {
          const h = flags(m[1]) || st.def, pat = unq(m[2]), tail = m[3];
          const c = conn(h); if (c) return c;
          const N = st.nodes[h];
          const total = Object.values(N.groups).reduce((s, g) => s + match(g, pat), 0);
          if (!tail) { const ks = scanOut(N, pat); return total ? ks.join("\n") + `\n... (${K.num(total)} keys in total)` : ""; }
          if (/^wc -l$/.test(tail)) return String(total);
          const x = tail.match(/^xargs(?: (?:-n ?|-L ?)(\d+))? redis-cli((?: -h \S+| -p \d+| -c)*) (unlink|del)$/i);
          if (!x) return "bash: unsupported pipeline here; try | wc -l or | xargs [-n N] redis-cli [-h host] unlink";
          const th = flags(x[2]) || st.def; const c2 = conn(th); if (c2) return c2;
          if (th !== h) return `(integer) 0\n... (the keys came from ${h} but you deleted on ${th}: nothing matched there)`;
          if (N.role === "slave") return "(error) READONLY You can't write against a read only replica.";
          if (!total) return "";
          const per = x[1] ? +x[1] : 5000;
          if (N.mode === "cluster" && per > 1 && !/-c/.test(x[2])) return "(error) CROSSSLOT Keys in request don't hash to the same slot\n(repeated for every batch: xargs packed many keys from different hash slots into each UNLINK)";
          if (N.mode === "cluster" && per > 1) return "(error) CROSSSLOT Keys in request don't hash to the same slot\n(-c follows MOVED redirects, but a multi-key command still needs all its keys in one slot)";
          let deleted = 0;
          Object.values(N.groups).forEach((g) => { const k = match(g, pat); g.n -= k; deleted += k; });
          N.dbsize -= deleted;
          st.deleted = (st.deleted || 0) + deleted;
          const out = x[1] === "1" || per === 1 ? `(integer) 1\n(integer) 1\n... (${K.num(deleted)} lines)` : `(integer) ${Math.min(per, deleted)}\n... (${K.num(Math.ceil(deleted / per))} batches, ${K.num(deleted)} keys unlinked)`;
          return /del$/i.test(x[3]) ? out : out;
        } },
        { re: /^redis-cli((?: -h \S+| -p \d+| -c)*) KEYS (\S+)$/i, use: "redis-cli [-h host] KEYS 'pattern'", desc: "", run: (m, st) => {
          const h = flags(m[1]) || st.def; const c = conn(h); if (c) return c;
          const N = st.nodes[h], pat = unq(m[2]);
          return { out: scanOut(N, pat).map((k, i) => `${i + 1}) "${k}"`).join("\n") + "\n...", danger: `KEYS ${pat} walked all ${K.num(N.dbsize)} keys on ${h}'s single thread: ~${K.num(Math.round(N.dbsize / 9000))} ms of total outage.` };
        } },
        { re: /^redis-cli((?: -h \S+| -p \d+| -c)*) CLUSTER NODES$/i, use: "redis-cli CLUSTER NODES", desc: "", run: (m, st) => {
          if (lv < 3) return "(error) ERR This instance has cluster support disabled";
          const ids = I.hosts.map((h) => (K.hash(h) >>> 0).toString(16).padStart(8, "0").repeat(5));
          const ranges = ["0-5460", "5461-10922", "10923-16383"];
          return I.hosts.map((h, i) => `${ids[i]} ${h}:6379@16379 ${i === 0 ? "myself," : ""}${i < 3 ? "master" : "slave"} ${i < 3 ? "-" : ids[i - 3]} 0 1760100${i}12000 ${i + 1} connected${i < 3 ? " " + ranges[i] : ""}`).join("\n");
        } },
      ],
    });
  }
  S.push({
    id: "redis-scan-purge",
    name: "Purge keys without KEYS *",
    kind: "Change plan",
    skills: ["safe"],
    ...LB.term({
      shell: scanShell,
      goal(st, I) {
        const prim = I.lv === 3 ? I.hosts.slice(0, 3) : I.lv === 2 ? [I.hosts[1]] : [I.hosts[0]];
        const left = prim.reduce((s, h) => s + st.nodes[h].groups[I.pre].n, 0);
        const lost = I.hosts.reduce((s, h) => s + (st.nodes[h].role === "master" ? Math.round((I.lv === 3 ? 4100000 * [0.34, 0.31, 0.35][I.hosts.indexOf(h) % 3] : 4100000) - st.nodes[h].groups["cache:product:"].n) + (Math.round(I.nNear * (I.lv === 3 ? [0.34, 0.31, 0.35][I.hosts.indexOf(h) % 3] : 1)) - st.nodes[h].groups[I.near].n) : 0), 0);
        if (lost > 0) return `Your pattern also deleted ${K.num(lost)} keys that weren't stale flags (look at what <code>${esc(I.near)}*</code> and the cache keys look like).`;
        if (left > 0) return `${K.num(left)} <code>${esc(I.pre)}*</code> keys are still there${I.lv === 3 ? " (each primary only holds its own slots, so --scan on one node only sees a third of them)" : I.lv === 2 ? " (check which node you're actually writing to)" : ""}.`;
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["redis-cli INFO keyspace", `redis-cli --scan --pattern '${I.pat}' | wc -l`, `redis-cli --scan --pattern '${I.pat}' | xargs redis-cli unlink`]
        : I.lv === 2 ? ["redis-cli INFO replication", `redis-cli -h ${I.hosts[1]} --scan --pattern '${I.pat}' | wc -l`, `redis-cli -h ${I.hosts[1]} --scan --pattern '${I.pat}' | xargs redis-cli -h ${I.hosts[1]} unlink`]
          : ["redis-cli CLUSTER NODES", ...I.hosts.slice(0, 3).map((h) => `redis-cli -h ${h} --scan --pattern '${I.pat}' | xargs -n 1 redis-cli -h ${h} unlink`)] }),
    }),
    gen(lv, R) {
      const flag = R.pick(["beta", "exp", "rollout"]);
      const pre = `flag:${flag}:`, near = `flag:${flag}-v2:`;
      const hosts = lv === 3 ? ["10.0.1.11", "10.0.2.11", "10.0.3.11", "10.0.2.12", "10.0.3.12", "10.0.1.12"] : lv === 2 ? ["cache-ro.internal", "cache-1.internal"] : ["cache-1.internal"];
      return { lv, pre, near, pat: pre + "*", hosts, n: R.int(20, 90) * 100 + R.int(0, 99), nNear: R.int(5, 30) * 100, samples: [`${pre}checkout-redesign:u:${R.int(1000, 9999)}`, `${pre}new-search:u:${R.int(1000, 9999)}`, `${pre}dark-mode:org:${R.int(10, 99)}`], nearSamples: [`${near}checkout-redesign:u:${R.int(1000, 9999)}`, `${near}pricing:u:${R.int(1000, 9999)}`] };
    },
    bad: (I) => [{ log: [`redis-cli KEYS '${I.pat}'`] }, { log: [`redis-cli --scan --pattern 'flag:*' | xargs ${I.lv === 3 ? "-n 1 " : ""}redis-cli${I.lv === 2 ? " -h " + I.hosts[1] : I.lv === 3 ? " -h " + I.hosts[0] : ""} unlink`.replace("redis-cli --scan", I.lv === 2 ? `redis-cli -h ${I.hosts[1]} --scan` : I.lv === 3 ? `redis-cli -h ${I.hosts[0]} --scan` : "redis-cli --scan")] }, ...(I.lv === 3 ? [{ log: I.hosts.slice(0, 3).map((h) => `redis-cli -h ${h} --scan --pattern '${I.pat}' | xargs redis-cli -h ${h} unlink`) }] : I.lv === 2 ? [{ log: [`redis-cli --scan --pattern '${I.pat}' | xargs redis-cli unlink`] }] : [])],
    text: (I) => `<p>A cleanup ticket: delete every stale feature-flag key matching <code>${esc(I.pat)}</code>${I.lv === 3 ? " from the 3-shard Redis Cluster" : ""}. The instance${I.lv === 3 ? "s hold" : " holds"} millions of other keys and serve${I.lv === 3 ? "" : "s"} live traffic, and the newer <code>${esc(I.near)}*</code> flags must stay.</p><p>Do it from your shell without blocking Redis. Pipelines like <code>redis-cli --scan ... | xargs redis-cli unlink</code> work here.</p>`,
    hint: (I) => I.lv === 1 ? "redis-cli --scan uses the SCAN cursor under the hood, a few keys per call. Check the count before you delete." : I.lv === 2 ? "Is the endpoint you're connected to allowed to accept writes? INFO replication says who the primary is." : "Each primary only owns a third of the slots, and a multi-key UNLINK must stay inside one slot. How many keys per command can xargs send safely?",
    concept: "SCAN instead of KEYS; deleting by pattern safely",
    how: "KEYS pattern is O(N) over the whole keyspace and runs on Redis's single command thread, so on millions of keys it is an outage. SCAN walks the keyspace incrementally with a cursor, a few keys per call; redis-cli --scan --pattern wraps it. Pipe the results into UNLINK so big values are freed in the background. Writes only work on a primary. In Redis Cluster every node holds only its own slots, so you scan each primary, and a multi-key command (UNLINK k1 k2 ...) fails with CROSSSLOT unless all its keys hash to one slot, so send one key per command (xargs -n 1) or group keys by slot.",
    rule: "Never run KEYS in production. Count with --scan | wc -l first, delete with --scan | xargs unlink on each primary, and make the pattern as specific as the namespace allows.",
    why: (I) => `There were ${K.num(I.lv === 3 ? I.n : I.n)} <code>${esc(I.pre)}*</code> keys among millions. ${I.lv === 1 ? "--scan streamed them without blocking and UNLINK freed them in the background." : I.lv === 2 ? `The app's endpoint <code>${esc(I.hosts[0])}</code> is a read-only replica, so UNLINK there fails with READONLY; you had to target the primary <code>${esc(I.hosts[1])}</code>.` : "Each of the three primaries held about a third of them. A plain xargs packs hundreds of keys from different slots into one UNLINK and gets CROSSSLOT, so xargs -n 1 (or batching per slot) on every primary was needed."} A pattern like <code>flag:*</code> would also have removed the live <code>${esc(I.near)}*</code> flags.`,
  });

  /* ----- 4. latency hunt: SLOWLOG, LATENCY, fork ----- */
  function latShell(I) {
    const lv = I.lv, now = 1760200000;
    const sl = lv === 1 ? [0, 1, 2, 3].map((k) => ({ id: 812 - k, ts: now - 20 - k * 60, us: I.us + k * 3011, args: ["KEYS", "session:*"], addr: "10.0.8.4:51200", name: "admin-dashboard" })).concat([{ id: 790, ts: now - 1400, us: 11203, args: ["HGETALL", "cart:88123"], addr: "10.0.4.12:50122", name: "api" }])
      : lv === 2 ? [{ id: 9012, ts: now - 6 * 86400 - 3000, us: 2104222, args: ["FLUSHDB"], addr: "10.0.0.5:61002", name: "" }, ...[0, 1, 2, 3, 4].map((k) => ({ id: 9101 - k, ts: now - 4 - k * 9, us: I.us - k * 1900, args: ["SMEMBERS", I.setKey], addr: `10.0.4.${12 + k}:5${k}122`, name: "presence-api" }))].sort((a, b) => b.ts - a.ts)
        : [{ id: 31, ts: now - 50, us: 14211, args: ["HGETALL", "cart:91812"], addr: "10.0.4.12:50122", name: "api" }, { id: 30, ts: now - 310, us: 12090, args: ["ZRANGEBYSCORE", "feed:42", "-inf", "+inf", "LIMIT", "0", "200"], addr: "10.0.4.18:50001", name: "api" }];
    const N = {
      role: "master", ver: "7.2.5", used: I.gb * GB, sys: (I.gb + 16) * GB, dbsize: I.keys, expires: Math.round(I.keys * 0.7),
      cfg: { save: lv === 3 ? "3600 1 300 100 60 10000" : "", "slowlog-log-slower-than": 10000, "slowlog-max-len": 128, "latency-monitor-threshold": 100, appendonly: "no" },
      keys: { [I.setKey]: { t: "set", ttl: -1, mem: I.setN * 64, n: I.setN, enc: "hashtable", idle: 0 }, "cart:91812": { t: "hash", ttl: 86000, mem: 9120, n: 41, enc: "listpack" } },
      clients: [{ id: 41, addr: "10.0.4.12:50122", name: "api", age: 99123, cmd: "get" }, { id: 77, addr: "10.0.8.4:51200", name: "admin-dashboard", age: 3123, idle: lv === 1 ? 2 : 41, cmd: lv === 1 ? "keys" : "get" }, { id: 92, addr: "10.0.4.13:51122", name: "presence-api", age: 4012, cmd: lv === 2 ? "smembers" : "get" }], nclients: 180,
      slowlog: sl,
      latency: lv === 3 ? [{ ev: "fork", ts: now - 22, last: I.fork, max: I.fork + 210, n: 31, period: 60, hist: [[now - 142, I.fork - 40], [now - 82, I.fork + 31], [now - 22, I.fork]] }] : lv === 1 ? [{ ev: "command", ts: now - 20, last: Math.round(I.us / 1000), max: Math.round(I.us / 1000) + 9 }] : [],
      pers: { loading: 0, rdb_changes_since_last_save: lv === 3 ? 4120 : 0, rdb_bgsave_in_progress: 0, rdb_last_save_time: now - 22, rdb_last_bgsave_status: "ok", rdb_last_bgsave_time_sec: lv === 3 ? 41 : -1, aof_enabled: 0 },
      stats: { instantaneous_ops_per_sec: 61203, latest_fork_usec: lv === 3 ? I.fork * 1000 : 0, total_forks: lv === 3 ? 6811 : 0, keyspace_hits: 91234011, keyspace_misses: 2210331 },
      cmdstats: [["get", 712331001, 712331001 * 1.1], ["set", 81203311, 81203311 * 1.6], ["smembers", lv === 2 ? 712044 : 1203, lv === 2 ? 712044 * I.us * 0.8 : 1203 * 30], ["keys", lv === 1 ? 4411 : 0, lv === 1 ? 4411 * I.us : 0], ["hgetall", 2103312, 2103312 * 7.1]].filter((c) => c[1] > 0),
    };
    return rcli({
      prompt: `${I.host}:6379>`,
      init: { def: I.host, nodes: { [I.host]: N } },
      motd: `ALERT p99 latency on ${I.host} spikes to ${lv === 3 ? (I.fork / 1000).toFixed(1) + " s roughly once a minute" : lv === 1 ? "~1 s every minute" : "40–90 ms and climbing all week"}\nredis-cli 7.2.5`,
      cmds: ["SLOWLOG GET 10", "LATENCY LATEST", "LATENCY DOCTOR", "INFO stats", "INFO persistence", "INFO commandstats", "CONFIG GET save", "CLIENT LIST", "CONFIG SET <param> <value>"],
      par: lv === 3 ? 6 : 5, opts: I.opts, optq: "Root cause",
      on: { set(N, k, v, st) { if (k === "save" && v.trim() === "") st.saveOff = true; return undefined; } },
    });
  }
  S.push({
    id: "redis-latency-hunt",
    name: "Find what stalls Redis",
    kind: "Investigation",
    skills: ["diagnose"],
    ...LB.term({
      shell: latShell,
      goal(st, I, a) {
        if (a.pick !== I.ans) return I.lv === 2 && I.opts[a.pick] && /FLUSHDB/.test(I.opts[a.pick]) ? "Check the timestamp of that FLUSHDB entry: SLOWLOG keeps the slowest recent commands, not necessarily today's." : "That doesn't match the evidence. Correlate the spike timing with SLOWLOG timestamps, LATENCY LATEST events and commandstats.";
        if (I.lv === 3 && !st.saveOff) return "Right diagnosis. Now mitigate: the primary forks a 40+ GB process every minute. The replica already takes the backup snapshots.";
        return true;
      },
      solve: (I) => ({ log: I.lv === 3 ? ["SLOWLOG GET 10", "LATENCY LATEST", "INFO persistence", 'CONFIG SET save ""'] : ["SLOWLOG GET 10", "CLIENT LIST"], pick: I.ans }),
    }),
    gen(lv, R) {
      const I = { lv, host: `cache-${R.pick(["feed", "core", "api"])}-${R.int(1, 4)}`, keys: R.int(20, 90) * 100000, gb: lv === 3 ? R.pick([38, 44, 52]) : R.pick([6, 9, 12]), us: lv === 1 ? R.int(700, 1200) * 1000 : R.int(48, 88) * 1000, setKey: `online:users:${R.pick(["web", "app", "all"])}`, setN: lv === 2 ? R.int(9, 16) * 100000 : 12000, fork: R.int(14, 22) * 100 };
      const opts = [
        "An admin dashboard runs KEYS session:* every minute",
        "SMEMBERS on an online-users set that grows without bound",
        "A FLUSHDB blocked the server",
        "fork() for BGSAVE every minute on a very large dataset",
        "HGETALL on shopping carts",
        "Network saturation between the app and Redis",
      ];
      const ansText = opts[lv === 1 ? 0 : lv === 2 ? 1 : 3];
      const pickSet = lv === 1 ? [0, 2, 4, 5] : lv === 2 ? [1, 2, 4, 5] : [3, 0, 4, 5];
      I.opts = R.shuffle(pickSet.map((i) => opts[i]));
      I.ans = I.opts.indexOf(ansText);
      return I;
    },
    bad: (I) => [{ log: ["SLOWLOG GET 10"], pick: I.opts.findIndex((o) => /HGETALL/.test(o)) }, ...(I.lv === 2 ? [{ log: ["SLOWLOG GET 10"], pick: I.opts.findIndex((o) => /FLUSHDB/.test(o)) }] : []), ...(I.lv === 3 ? [{ log: ["LATENCY LATEST"], pick: I.ans }] : [])],
    text: (I) => `<p>${I.lv === 1 ? "Every minute or so, API calls to Redis time out for about a second." : I.lv === 2 ? "Redis p99 has crept from 2 ms to 40–90 ms over the week. Nothing was deployed to Redis." : `Roughly once a minute, Redis on <code>${esc(I.host)}</code> (${I.gb} GB dataset, on a VM) stops responding for ${(I.fork / 1000).toFixed(1)} s. The team says SLOWLOG is \"clean\".`} Find the cause on <code>${esc(I.host)}</code>${I.lv === 3 ? " and apply a mitigation. Backups are taken from the replica, which has its own snapshot schedule" : ""}.</p>`,
    hint: (I) => I.lv === 1 ? "SLOWLOG GET shows the command, its duration in microseconds, and the client name." : I.lv === 2 ? "SLOWLOG entries carry a Unix timestamp. Which slow command is recent and repeating, and why would it get slower every day?" : "SLOWLOG only times command execution. Pauses outside commands (fork, expiry, eviction) show up in LATENCY LATEST.",
    concept: "Finding latency: SLOWLOG, LATENCY and fork",
    how: "SLOWLOG records commands whose execution exceeded slowlog-log-slower-than (default 10 ms), with a timestamp, duration in microseconds, arguments and client: it reveals O(N) commands like KEYS, SMEMBERS/HGETALL/LRANGE 0 -1 on big collections. It doesn't include time spent waiting in queue, or pauses outside command execution. The latency monitor (latency-monitor-threshold > 0) records those: fork, expire-cycle, eviction-del, aof-fsync. fork() for BGSAVE or AOF rewrite copies the page tables, roughly 10–20 ms per GB on many VMs, during which the server is frozen.",
    rule: "Read SLOWLOG with its timestamps and client names, check LATENCY LATEST for non-command stalls, and don't snapshot a large primary every minute: persist on a replica or snapshot rarely.",
    why: (I) => I.lv === 1 ? `SLOWLOG showed <code>KEYS session:*</code> from client <code>admin-dashboard</code> taking ~${Math.round(I.us / 1000)} ms, once a minute: KEYS scans all ${K.num(I.keys)} keys on the main thread. Replace it with SCAN or a maintained index (a set of session ids).`
      : I.lv === 2 ? `The FLUSHDB entry was six days old. The recent, repeating entries were <code>SMEMBERS ${esc(I.setKey)}</code> at ${Math.round(I.us / 1000)} ms: the set has ${K.num(I.setN)} members and grows daily, and SMEMBERS is O(N). Use SSCAN, SCARD, or a structure with expiry per member (a sorted set scored by last-seen time, trimmed with ZREMRANGEBYSCORE).`
        : `LATENCY LATEST showed <code>fork</code> spikes of ~${I.fork} ms, matching <code>latest_fork_usec</code>. With <code>save ... 60 10000</code> a ${I.gb} GB primary forked every minute. SLOWLOG can't see this. Disabling RDB on the primary (the replica snapshots) removes the stalls; consider also disabling Transparent Huge Pages and moving to instances where fork is cheaper.`,
  });

  /* ----- 5. hot keys ----- */
  function hotShell(I) {
    const lv = I.lv;
    const nodes = {};
    I.hosts.forEach((h, i) => {
      const hot = i === I.hot;
      nodes[h] = {
        role: "master", mode: "cluster", ver: "7.2.5", used: (3 + i) * GB, dbsize: 1200000 + i * 31201, expires: 1100000,
        cfg: { "maxmemory-policy": lv === 2 ? "allkeys-lru" : "allkeys-lfu", "lfu-log-factor": 10, "lfu-decay-time": 1, maxmemory: 8 * GB },
        keys: hot ? { [I.key]: { t: lv === 3 ? "string" : "string", ttl: -1, mem: I.mem, enc: lv === 1 ? "raw" : "int", freq: 255, idle: 0 } } : {},
        stats: { instantaneous_ops_per_sec: hot ? I.ops : I.ops / I.ratio | 0, instantaneous_input_kbps: hot ? 41210.2 : 9120.1, instantaneous_output_kbps: hot ? (lv === 1 ? 512331.9 : 30211.5) : 11002.3 },
        cpu: { used_cpu_sys: hot ? 81233.1 : 21211.4, used_cpu_user: hot ? 191232.9 : 50121.3, used_cpu_sys_main_thread: hot ? 80012.4 : 20112.9 },
        cmdstats: hot ? (lv === 1 ? [["get", 9123311021, 9123311021 * 2.1], ["set", 1203311, 1203311 * 2]] : [["incrby", 3123311021, 3123311021 * 1.2], ["decrby", lv === 3 ? 3123311021 : 0, 3123311021 * 1.3], ["get", 812311, 812311 * 1.1], ["evalsha", lv === 3 ? 212331 : 0, 212331 * 9]].filter((c) => c[1] > 0)) : [["get", 2123311021, 2123311021 * 1.4], ["set", 211331021, 211331021 * 1.8]],
      };
    });
    const others = (h) => ["cache:user:" + (K.hash(h) % 99999), "cache:product:" + (K.hash(h + "p") % 99999)];
    return rcli({
      prompt: "$",
      init: { def: I.hosts[0], nodes },
      motd: `ALERT redis cluster shard ${I.hosts[I.hot]} main thread CPU 100%, p99 ${lv === 1 ? "41" : "63"} ms; other shards ~30%\nredis 7.2 cluster: ${I.hosts.join(", ")}`,
      cmds: [...I.hosts.map((h) => `redis-cli -h ${h} INFO stats`), "redis-cli -h <host> --hotkeys", "redis-cli -h <host> INFO commandstats", "redis-cli -h <host> CONFIG GET maxmemory-policy", "redis-cli -h <host> CONFIG SET maxmemory-policy allkeys-lfu", "redis-cli -h <host> MONITOR"],
      par: lv === 2 ? 7 : 6, opts: I.opts, optq: "Best fix for this hot key",
      raw: [{ re: /^redis-cli(?: -c)?(?: -h (\S+))?(?: -c)? --hotkeys$/i, use: "redis-cli [-h host] --hotkeys", desc: "find keys with the highest LFU counters", run: (m, st) => {
        const h = m[1] || st.def, N = st.nodes[h];
        if (!N) return `Could not connect to Redis at ${h}:6379: Name or service not known`;
        if (!/lfu/.test(N.cfg["maxmemory-policy"])) return `# Scanning the entire keyspace to find hot keys as well as\n# average sizes per key type.  You can use -i 0.1 to sleep 0.1 sec\n# per 100 SCAN commands (not usually needed).\n\nError: ${NOLFU}`;
        st.found = st.found || {}; st.found[h] = true;
        const hot = I.hosts.indexOf(h) === I.hot;
        const list = hot ? [[I.key, 255], ...others(h).map((k, j) => [k, 41 - j * 9])] : others(h).map((k, j) => [k, 38 - j * 7]);
        return `# Scanning the entire keyspace to find hot keys as well as\n# average sizes per key type.  You can use -i 0.1 to sleep 0.1 sec\n# per 100 SCAN commands (not usually needed).\n\n` + list.map(([k, c]) => `[${(10 + (c % 80)).toFixed(2)}%] Hot key '"${k}"' found so far with counter ${c}`).join("\n") + `\n\n-------- summary -------\n\nSampled ${N.dbsize} keys in the keyspace!\n` + list.map(([k, c]) => `hot key found with counter: ${c}\tkeyname: "${k}"`).join("\n");
      } }],
    });
  }
  S.push({
    id: "redis-hot-key",
    name: "Track down the hot key",
    kind: "Incident",
    skills: ["diagnose", "design"],
    ...LB.term({
      shell: hotShell,
      goal(st, I, a) {
        if (!(st.found && st.found[I.hosts[I.hot]])) return "You haven't actually identified the key yet: run --hotkeys against the shard that's on fire.";
        if (a.pick !== I.ans) return I.why[a.pick] || "That fix doesn't address this kind of hotness.";
        return true;
      },
      solve: (I) => ({ log: [`redis-cli -h ${I.hosts[I.hot]} INFO stats`, ...(I.lv === 2 ? [`redis-cli -h ${I.hosts[I.hot]} CONFIG SET maxmemory-policy allkeys-lfu`] : []), `redis-cli -h ${I.hosts[I.hot]} --hotkeys`, `redis-cli -h ${I.hosts[I.hot]} INFO commandstats`], pick: I.ans }),
    }),
    gen(lv, R) {
      const hosts = ["10.0.1.21", "10.0.2.21", "10.0.3.21"];
      const I = { lv, hosts, hot: R.int(0, 2), ops: R.int(150, 190) * 1000, ratio: R.pick([4, 5, 6]) };
      I.key = lv === 1 ? `config:feature-flags:${R.pick(["web", "mobile"])}` : lv === 2 ? `ratelimit:partner:${R.pick(["acme", "globex", "initech"])}:global` : `stock:sku-${R.int(10000, 99999)}`;
      I.mem = lv === 1 ? R.int(40, 90) * 1024 : 56;
      const O = lv === 1 ? [
        ["Cache it in each app process for a few seconds (local in-process cache)", "It's a small, read-only blob that changes on deploy: every app instance can hold it locally and Redis sees one read per instance per TTL."],
        ["Split it into N copies with different hash tags and read a random copy", "Works, but it multiplies writes and still sends every read over the network; a local copy removes the load entirely."],
        ["Reshard: add more primaries to the cluster", "A single key lives in exactly one slot on one shard. More shards don't spread one key's traffic."],
        ["Raise maxmemory on the hot shard", "Memory isn't the problem: CPU and network on one shard are."],
      ] : lv === 2 ? [
        ["Split the counter across N keys in different slots (INCRBY a random shard, sum the shards to check the limit)", "Correct for a write-hot counter that tolerates a slightly approximate total."],
        ["Cache it in each app process for a few seconds (local in-process cache)", "It's written on every request (INCRBY). A local cache helps reads, not writes."],
        ["Add replicas and send reads to them with READONLY", "Replicas only serve reads; every INCRBY still goes to the one primary."],
        ["Reshard: add more primaries to the cluster", "A single key lives in exactly one slot on one shard. More shards don't spread one key's traffic."],
      ] : [
        ["Split the stock into N bucket keys that each hold a share, decrement one bucket atomically (fail over to another when it hits 0)", "Correct: each bucket enforces 'never below zero' atomically, and the load spreads over N slots."],
        ["Split the counter across N keys and sum them before each decrement", "Summing then decrementing isn't atomic across slots: two buyers can both see stock left and oversell."],
        ["Cache stock in each app process for a second", "Stock is decremented on every purchase; a stale local count oversells."],
        ["Add replicas and send reads to them with READONLY", "The load is DECRBY writes; replicas can't take them."],
      ];
      const ord = R.shuffle([0, 1, 2, 3]);
      I.opts = ord.map((i) => O[i][0]); I.why = ord.map((i) => O[i][1]); I.ans = ord.indexOf(0);
      return I;
    },
    bad: (I) => [{ log: [`redis-cli -h ${I.hosts[I.hot]} --hotkeys`], pick: (I.ans + 1) % 4 }, { log: [`redis-cli -h ${I.hosts[(I.hot + 1) % 3]} --hotkeys`], pick: I.ans }, ...(I.lv === 2 ? [{ log: [`redis-cli -h ${I.hosts[I.hot]} --hotkeys`], pick: I.ans }] : [])],
    text: (I) => `<p>One shard of a 3-primary Redis Cluster is pegged at 100% main-thread CPU while the others idle at 30%. ${I.lv === 1 ? "The keyspace is evenly spread; something is far more popular than the rest." : I.lv === 2 ? "A partner integration launched this morning; each API call it makes is metered in Redis." : "A flash sale started 10 minutes ago. Each purchase decrements the item's stock in Redis and must never sell more than exists."}</p><p>Identify the hot key <b>without MONITOR</b> (it would halve throughput on the struggling shard), then choose the fix.</p>`,
    hint: (I) => I.lv === 1 ? "Find the hot shard with INFO stats, then --hotkeys there. Is the key read-heavy or write-heavy? INFO commandstats tells you." : I.lv === 2 ? "--hotkeys relies on LFU counters. What does it need from maxmemory-policy?" : "Once you know it's a write-hot counter with an invariant (never below zero), which fix keeps the invariant?",
    concept: "Hot keys: finding them and spreading the load",
    how: "Redis Cluster spreads keys over 16,384 slots, but one key always lives on one shard, and that shard's single main thread (and NIC) caps its throughput. redis-cli --hotkeys scans the keyspace and reports the highest LFU access counters, so it needs an allkeys-lfu or volatile-lfu policy; MONITOR works anywhere but costs a lot of throughput. Read-hot keys are best absorbed by a short-TTL in-process cache, or replicas with READONLY reads. Write-hot keys need splitting: N sub-keys in different slots, combined on read. If the value carries an invariant (stock ≥ 0), split the quantity itself into buckets so each bucket can enforce it atomically.",
    rule: "Classify the hot key first: read-hot → local cache (or replicas); write-hot → split it, and if there's an invariant, split the budget, not just the counter.",
    why: (I) => `<code>${esc(I.key)}</code> on ${esc(I.hosts[I.hot])} ${I.lv === 1 ? `was a ~${Math.round(I.mem / 1024)} KB read-only blob fetched on every request (output bandwidth ~500 MB/s). A few seconds of in-process caching cuts that to one read per instance per TTL.` : I.lv === 2 ? "was a rate-limit counter written with INCRBY on every partner request. A local cache or replicas don't take writes; splitting it over N slots and summing for the check spreads the load, at the cost of a slightly approximate limit. --hotkeys first needed the policy switched to allkeys-lfu (LFU counters take a moment to build up after switching)." : "was the sale item's stock, decremented on every purchase. Splitting a counter and summing isn't atomic across slots and oversells; splitting the stock into buckets (e.g. 10 × 1/10 of the units), each guarded by an atomic check-and-decrement, keeps the guarantee and spreads load."}`,
  });

  /* ----- 6. manual failover: promote the right replica ----- */
  function foShell(I) {
    const lv = I.lv;
    const nodes = {};
    nodes[I.old] = { role: "master", down: lv < 3 ? "refused" : undefined, keys: {}, dbsize: I.keys, cfg: { "min-replicas-to-write": 0, "min-replicas-max-lag": 10 }, used: 6 * GB, clients: [], nclients: lv === 3 ? 63 : 0,
      repl: { role: "master", connected_slaves: 0, master_failover_state: "no-failover", master_replid: "8f1d1c22a1c0a6ac6e2ea72a69c0e1b2d3f40a11", master_repl_offset: I.oldOff } };
    I.reps.forEach((r, i) => {
      nodes[r.h] = { role: "slave", keys: {}, dbsize: r.sync ? Math.round(I.keys * 0.04) : I.keys, used: 6 * GB, cfg: { "min-replicas-to-write": 0, "min-replicas-max-lag": 10, "replica-priority": r.prio }, clients: [], nclients: 4,
        repl: { role: "slave", master_host: I.old, master_port: 6379, master_link_status: "down", master_last_io_seconds_ago: -1, master_sync_in_progress: r.sync ? 1 : 0, slave_read_repl_offset: r.off, slave_repl_offset: r.off, master_link_down_since_seconds: I.down, slave_priority: r.prio, slave_read_only: 1, replica_announced: 1, connected_slaves: 0 } };
    });
    const promote = (st, h) => {
      const N = st.nodes[h];
      N.role = "master";
      N.repl = { role: "master", connected_slaves: 0, master_failover_state: "no-failover", master_replid: (K.hash(h) >>> 0).toString(16).padStart(8, "0").repeat(5), master_repl_offset: N.repl.slave_repl_offset };
    };
    const follow = (st, h, target) => {
      const N = st.nodes[h];
      const T = st.nodes[target];
      N.role = "slave";
      const off = T && T.repl ? T.repl.master_repl_offset || T.repl.slave_repl_offset : 0;
      N.repl = { role: "slave", master_host: target, master_port: 6379, master_link_status: T && !T.down ? "up" : "down", slave_repl_offset: off, master_sync_in_progress: 0, slave_read_only: 1, slave_priority: N.cfg["replica-priority"] };
    };
    return rcli({
      prompt: "$",
      init: { def: I.reps[0].h, nodes },
      motd: `INCIDENT: primary ${I.old} ${lv === 3 ? "unreachable from the sentinels' subnet" : "lost (EC2 instance retired)"} · Sentinel quorum lost, no automatic failover\nreplicas: ${I.reps.map((r) => r.h).join(", ")}${lv === 2 ? "  (" + I.reps[I.dr].h + " is the DR replica in another region)" : ""}`,
      cmds: [`redis-cli -h ${I.old} INFO replication`, ...I.reps.map((r) => `redis-cli -h ${r.h} INFO replication`), "redis-cli -h <host> INFO keyspace", "redis-cli -h <host> REPLICAOF NO ONE", "redis-cli -h <host> REPLICAOF <primary> 6379"],
      par: I.reps.length + (lv === 3 ? 5 : 3),
      extra: [
        { re: /^REPLICAOF NO ONE$/i, use: "REPLICAOF NO ONE | REPLICAOF <host> <port>", desc: "promote to primary / follow a primary", run: (m, st) => { const h = st.h || st.def; if (st.nodes[h].role === "master") return "OK"; promote(st, h); st.promoted = (st.promoted || []).concat(h); return "OK"; } },
        { re: /^(?:REPLICAOF|SLAVEOF) (\S+) (\d+)$/i, use: "REPLICAOF <host> <port>", desc: "", hidden: true, run: (m, st) => { const h = st.h || st.def; if (m[1] === h) return "(error) ERR Can't replicate myself"; follow(st, h, m[1]); return "OK"; } },
      ],
    });
  }
  S.push({
    id: "redis-manual-failover",
    name: "Promote the right replica",
    kind: "Incident",
    skills: ["safe", "diagnose"],
    ...LB.term({
      shell: foShell,
      goal(st, I) {
        const masters = Object.keys(st.nodes).filter((h) => st.nodes[h].role === "master" && !(st.nodes[h].down));
        const best = I.reps[I.best].h;
        const reps = I.reps.map((r) => r.h);
        const promoted = reps.filter((h) => st.nodes[h].role === "master");
        if (!promoted.length) return "No replica has been promoted yet: the app still has nowhere to write.";
        if (promoted.length > 1) return `Two replicas (${promoted.join(", ")}) are now primaries: writes will split between them.`;
        if (promoted[0] !== best) { const p = I.reps.find((r) => r.h === promoted[0]); return p.sync ? `${esc(p.h)} was in the middle of a full resync (master_sync_in_progress:1): it holds a fraction of the dataset.` : p.prio === 0 && I.lv === 2 ? `${esc(p.h)} is the DR replica (replica-priority 0, another region). Its offset isn't higher than the local candidate's, so you'd move the primary 70 ms away from every app server for nothing.` : `${esc(p.h)} was at offset ${p.off}, behind ${esc(best)} at ${I.reps[I.best].off}: ${I.reps[I.best].off - p.off} bytes of acknowledged writes are gone, and ${esc(best)} will throw them away when it resyncs from the new primary.`; }
        const stray = reps.filter((h) => h !== best && !(st.nodes[h].role === "slave" && st.nodes[h].repl.master_host === best));
        if (stray.length) return `${stray.join(", ")} still replicate${stray.length > 1 ? "" : "s"} from ${stray.map((h) => st.nodes[h].repl.master_host).join(", ")}: point every other replica at the new primary.`;
        if (I.lv === 3) {
          const o = st.nodes[I.old];
          if (o.role === "master") return `${esc(I.old)} isn't dead: it's partitioned from the sentinels but still has ${o.nclients} app clients writing to it. Two primaries = split brain. Demote it under the new primary.`;
          if (o.repl.master_host !== best) return `${esc(I.old)} must follow the new primary ${esc(best)}.`;
        }
        void masters;
        return true;
      },
      solve: (I) => ({ log: [...I.reps.map((r) => `redis-cli -h ${r.h} INFO replication`), `redis-cli -h ${I.reps[I.best].h} REPLICAOF NO ONE`, ...I.reps.filter((_, i) => i !== I.best).map((r) => `redis-cli -h ${r.h} REPLICAOF ${I.reps[I.best].h} 6379`), ...(I.lv === 3 ? [`redis-cli -h ${I.old} REPLICAOF ${I.reps[I.best].h} 6379`] : [])] }),
    }),
    gen(lv, R) {
      const n = lv === 1 ? 2 : 3;
      const base = R.int(4000, 9000) * 100000;
      const hosts = R.shuffle(["10.0.1.31", "10.0.2.31", "10.0.3.31", "10.0.1.32"]);
      const old = hosts[3];
      const offs = R.distinct(n, 1, 40).map((x) => base - x * R.int(50, 400));
      const reps = hosts.slice(0, n).map((h, i) => ({ h, off: offs[i], prio: 100, sync: false }));
      let best = reps.reduce((b, r, i) => (r.off > reps[b].off ? i : b), 0);
      const I = { lv, old, reps, keys: R.int(30, 90) * 100000, down: R.int(40, 400), oldOff: base + R.int(100, 900) };
      if (lv === 2) {
        // the replica with the largest offset is mid full-resync and actually holds little; the DR replica has priority 0 but is not ahead
        const order = reps.map((_, i) => i).sort((a, b) => reps[b].off - reps[a].off);
        reps[order[0]].sync = true; reps[order[0]].off = 0;
        I.dr = order[2]; reps[order[2]].prio = 0;
        best = order[1];
        reps[order[0]].h = reps[order[0]].h; // keep
        reps[order[0]].off = 0;
      }
      I.best = best;
      if (lv === 3) I.oldOff = base + R.int(5000, 9000);
      return I;
    },
    bad: (I) => { const other = I.reps.findIndex((_, i) => i !== I.best); const cmds = (b) => [`redis-cli -h ${I.reps[b].h} REPLICAOF NO ONE`, ...I.reps.filter((_, i) => i !== b).map((r) => `redis-cli -h ${r.h} REPLICAOF ${I.reps[b].h} 6379`)]; return [{ log: cmds(other) }, { log: [`redis-cli -h ${I.reps[I.best].h} REPLICAOF NO ONE`] }, ...(I.lv === 3 ? [{ log: cmds(I.best) }] : [])]; },
    text: (I) => `<p>The Redis primary <code>${esc(I.old)}</code> ${I.lv === 3 ? "stopped answering the sentinels" : "is gone"}, and Sentinel can't reach quorum, so nobody promoted a replica. Writes have been failing for ${Math.round(I.down / 60) || 1} minute(s).</p><p>Do the failover by hand: promote the replica that loses the least data, make every other replica follow it${I.lv === 3 ? ", and make sure there is only one primary left" : ""}. The app will be pointed at whatever you promote.</p>`,
    hint: (I) => I.lv === 1 ? "INFO replication on each replica shows slave_repl_offset: how far into the old primary's replication stream it got." : I.lv === 2 ? "An offset only means something if the replica actually holds the data. Check master_sync_in_progress, the keyspace, and replica-priority." : "Is the old primary really dead? Ask it.",
    concept: "Manual failover: replication offsets and split brain",
    how: "Redis replication is asynchronous: the primary acknowledges a write before replicas receive it, and each replica's slave_repl_offset says how far into the primary's stream it got. Promote the replica with the highest offset that holds a complete dataset (not one in the middle of a full sync), then REPLICAOF the others to it; a replica that was ahead of the new primary discards its extra data on resync. replica-priority 0 marks replicas Sentinel must never promote, like DR copies far from the apps. If the old primary is only partitioned, it keeps accepting writes from clients that can still reach it: demote it with REPLICAOF so there is one primary, accepting that its writes since the partition are lost. min-replicas-to-write limits how much that can be.",
    rule: "Compare offsets and sync state before promoting, re-point every replica, and fence the old primary. Then set min-replicas-to-write / min-replicas-max-lag so an isolated primary stops accepting writes.",
    why: (I) => { const b = I.reps[I.best]; return I.lv === 1 ? `${esc(b.h)} had the highest offset (${b.off}); promoting the other replica would have thrown away ${Math.abs(I.reps.find((_, i) => i !== I.best).off - b.off)} bytes of acknowledged writes.` : I.lv === 2 ? `The replica with a full sync in progress held only a few percent of the keys, and the DR replica has priority 0 and sits in another region. ${esc(b.h)} was the complete, local, most up-to-date copy.` : `${esc(I.old)} was partitioned, not dead: ${63} app clients were still writing to it. After promoting ${esc(b.h)} and repointing the replicas, demoting the old primary removed the split brain; its writes since the partition are lost, which is exactly what min-replicas-to-write 1 with min-replicas-max-lag 10 would have bounded to ~10 s.`; },
  });

  /* ----- 7. fragmentation ----- */
  function fragShell(I) {
    const lv = I.lv;
    const used = I.used, rss = lv === 2 ? Math.round(used * 0.61) : Math.round(used * I.ratio);
    const N = {
      role: "master", ver: "7.2.5", used, rss, sys: I.sys, dbsize: I.keys, expires: Math.round(I.keys * 0.9), alloc: lv === 3 ? "libc" : "jemalloc-5.3.0",
      cfg: { maxmemory: lv === 2 ? 0 : I.maxm, "maxmemory-policy": lv === 2 ? "noeviction" : "allkeys-lru", activedefrag: "no", "active-defrag-ignore-bytes": 104857600, "active-defrag-threshold-lower": 10 },
      keys: {}, clients: [], nclients: 120,
      stats: { instantaneous_ops_per_sec: 22041, expired_keys: 91203311, evicted_keys: lv === 2 ? 0 : 1203, keyspace_hits: 8123301, keyspace_misses: 912330 },
      repl: { role: "master", connected_slaves: lv === 3 ? 1 : 0, ...(lv === 3 ? { slave0: "ip=10.0.2.41,port=6379,state=online,offset=99123412,lag=0" } : {}), master_repl_offset: 99123412 },
      info: {},
    };
    const nodes = { [I.host]: N };
    if (lv === 3) nodes["10.0.2.41"] = { role: "slave", ver: "7.2.5", used: used + 3 * MB, rss: Math.round(used * 1.07), sys: I.sys, dbsize: I.keys, expires: Math.round(I.keys * 0.9), alloc: "libc", cfg: { maxmemory: I.maxm, "maxmemory-policy": "allkeys-lru", activedefrag: "no" }, keys: {}, clients: [], nclients: 2, repl: { role: "slave", master_host: I.host, master_port: 6379, master_link_status: "up", slave_repl_offset: 99123412, slave_read_only: 1, slave_priority: 100 } };
    return rcli({
      prompt: "$",
      init: { def: I.host, nodes, failed: false },
      motd: lv === 1 ? `ALERT ${I.host} RSS ${human(rss)} (container limit ${human(I.sys)}). Yesterday's cleanup job deleted ~60% of the keys, but RSS didn't drop.` : lv === 2 ? `ALERT ${I.host} p99 280 ms, host load average 14, disk read IO 90 MB/s on a cache box` : `ALERT ${I.host} RSS ${human(rss)} of ${human(I.sys)} after a key-schema migration · sentinel: mymaster on :26379`,
      cmds: ["redis-cli INFO memory", "redis-cli INFO stats", "redis-cli CONFIG GET maxmemory*", "redis-cli CONFIG GET activedefrag", "redis-cli CONFIG SET <param> <value>", "redis-cli MEMORY PURGE", ...(lv === 3 ? ["redis-cli -h 10.0.2.41 INFO memory", "redis-cli INFO replication", "redis-cli -p 26379 SENTINEL FAILOVER mymaster"] : [])],
      par: lv === 3 ? 7 : 5, opts: lv === 2 ? I.opts : undefined, optq: "What is the memory telling you?",
      extra: [
        { re: /^MEMORY PURGE$/i, use: "MEMORY PURGE", desc: "ask the allocator to release dirty pages", run: (m, st) => { const N = node(st); if (/libc/.test(N.alloc)) return "OK"; N.rss = Math.round(N.rss - (N.rss - N.used) * 0.08); return "OK"; } },
        { re: /^SENTINEL FAILOVER (\S+)$/i, use: "SENTINEL FAILOVER <master>", desc: "(port 26379) fail over to a replica", run: (m, st) => {
          if (!/26379/.test(st.h || "")) return "(error) ERR unknown command 'SENTINEL', with args beginning with: (this is a Redis server; Sentinel listens on port 26379)";
          if (m[1] !== "mymaster") return "(error) ERR No such master with that name";
          st.failed = true; const a = st.nodes[I.host], b = st.nodes["10.0.2.41"]; a.role = "slave"; b.role = "master"; a.repl = { role: "slave", master_host: "10.0.2.41", master_port: 6379, master_link_status: "up", slave_read_only: 1 }; b.repl = { role: "master", connected_slaves: 1, slave0: `ip=${I.host},port=6379,state=online,offset=99123500,lag=0`, master_repl_offset: 99123500 };
          a.rss = Math.round(a.used * 1.07); st.def = "10.0.2.41"; return "OK";
        } },
      ],
      on: {
        set(N, k, v, st) {
          if (k === "activedefrag" && v === "yes" && /libc/.test(N.alloc)) return "(error) ERR CONFIG SET failed (possibly related to argument 'activedefrag') - Active defragmentation cannot be enabled: it requires a Redis server compiled with a modified Jemalloc like the one shipped by default with the Redis source distribution";
          if (k === "activedefrag" && v === "yes" && lv === 1) { N.defragRunning = 25; N.rss = Math.round(N.used * 1.12); }
          if (k === "maxmemory" && lv === 2 && +v > 0) st.capped = +v;
          return undefined;
        },
      },
    });
  }
  S.push({
    id: "redis-fragmentation",
    name: "RSS is far from used_memory",
    kind: "Investigation",
    skills: ["diagnose", "tune"],
    ...LB.term({
      shell: fragShell,
      goal(st, I, a) {
        const N = st.nodes[I.host];
        if (st.flushed) return "Flushing the cache isn't a memory fix.";
        if (I.lv === 1) return N.cfg.activedefrag === "yes" ? true : `RSS is still ${human(N.rss)} for ${human(N.used)} of data (fragmentation ratio ${(N.rss / N.used).toFixed(2)}). MEMORY PURGE returns only free dirty pages; the holes are inside partially used pages.`;
        if (I.lv === 2) {
          if (a.pick !== I.ans) return "Look again at the ratio: RSS is <i>smaller</i> than used_memory. How can resident memory be smaller than what Redis allocated?";
          const mm = +N.cfg.maxmemory, pol = N.cfg["maxmemory-policy"];
          if (!(mm > 0) || mm > I.sys * 0.75) return `maxmemory must be well under the host's ${human(I.sys)} RAM (leave room for the OS, buffers and fork copy-on-write).`;
          if (!/^allkeys-(lru|lfu)$/.test(pol)) return `With <code>${esc(pol)}</code> Redis will refuse writes (or barely evict) once it reaches the new maxmemory. This is a cache: let it evict.`;
          return true;
        }
        if (!st.failed) return `Fragmentation is ${(N.rss / N.used).toFixed(2)} and active defrag can't run with the libc allocator. You need the memory back without a cold cache.`;
        return true;
      },
      solve: (I) => ({ log: I.lv === 1 ? ["redis-cli INFO memory", "redis-cli CONFIG SET activedefrag yes"] : I.lv === 2 ? ["redis-cli INFO memory", `redis-cli CONFIG SET maxmemory ${Math.floor(I.sys / GB * 0.6)}gb`, "redis-cli CONFIG SET maxmemory-policy allkeys-lru"] : ["redis-cli INFO memory", "redis-cli CONFIG SET activedefrag yes", "redis-cli -h 10.0.2.41 INFO memory", "redis-cli -p 26379 SENTINEL FAILOVER mymaster"], pick: I.lv === 2 ? I.ans : null }),
    }),
    gen(lv, R) {
      const sysGB = lv === 2 ? R.pick([8, 16]) : R.pick([16, 32]);
      const I = { lv, host: `cache-${R.pick(["sess", "feed", "geo"])}-${R.int(1, 5)}`, sys: sysGB * GB, keys: R.int(10, 60) * 100000, ratio: 1.55 + R.int(0, 30) / 100 };
      I.used = lv === 2 ? Math.round(sysGB * GB * (1.12 + R.next() * 0.2)) : Math.round(sysGB * GB * 0.33);
      I.maxm = Math.round(sysGB * 0.6) * GB;
      if (lv === 2) { const o = ["Severe fragmentation: enable activedefrag", "Part of Redis's memory has been swapped out: the dataset no longer fits in RAM", "A memory leak in Redis", "Big client output buffers"]; const ord = R.shuffle([0, 1, 2, 3]); I.opts = ord.map((i) => o[i]); I.ans = ord.indexOf(1); }
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: ["redis-cli MEMORY PURGE"] }, { log: ["redis-cli FLUSHALL"] }] : I.lv === 2 ? [{ log: ["redis-cli CONFIG SET activedefrag yes"], pick: I.ans }, { log: [`redis-cli CONFIG SET maxmemory ${Math.floor(I.sys / GB * 0.6)}gb`], pick: I.ans }, { log: [`redis-cli CONFIG SET maxmemory ${Math.floor(I.sys / GB * 0.6)}gb`, "redis-cli CONFIG SET maxmemory-policy allkeys-lru"], pick: (I.ans + 1) % 4 }] : [{ log: ["redis-cli CONFIG SET activedefrag yes"] }, { log: ["redis-cli FLUSHALL"] }],
    text: (I) => I.lv === 1 ? `<p><code>${esc(I.host)}</code> is a cache running Redis 7.2 with jemalloc. A cleanup job deleted most of its keys yesterday; <code>used_memory</code> dropped, but the process's resident memory didn't, and the container is near its limit.</p><p>Get RSS back down without losing data.</p>` : I.lv === 2 ? `<p><code>${esc(I.host)}</code> is a cache on a ${human(I.sys)} VM. Latency is terrible, the host shows heavy disk reads, and someone on the team wants to "turn on activedefrag".</p><p>Read the memory stats, diagnose, and fix it.</p>` : `<p>After a key-schema migration rewrote most values, <code>${esc(I.host)}</code>'s RSS is far above its dataset. It has one in-sync replica managed by Sentinel (<code>mymaster</code>). This build uses the libc allocator.</p><p>Reclaim the memory without flushing the cache.</p>`,
    hint: (I) => I.lv === 1 ? "mem_fragmentation_ratio = RSS / used_memory. jemalloc builds can defragment live." : I.lv === 2 ? "A ratio below 1.0 is the dangerous one. Then make sure this cache can't outgrow the box again." : "Active defrag needs Redis's jemalloc. A replica that loaded the dataset via full sync has compact memory.",
    concept: "Memory fragmentation and swap",
    how: "used_memory is what Redis allocated; used_memory_rss is what the OS has resident. After many deletes or value-size changes, the allocator keeps partly empty pages, so RSS stays high (ratio well above 1.0). With jemalloc, activedefrag yes moves live values into fresh pages in the background; with other allocators the practical fix is to fail over to a replica, which rebuilt its memory compactly during full sync. A ratio below 1.0 means part of Redis's memory isn't resident: it has been swapped out, and every access to it waits for disk. That happens when maxmemory is unset or larger than RAM.",
    rule: "Always set maxmemory well under RAM. Read the fragmentation ratio both ways: >1.5 → defrag (jemalloc) or fail over; <1.0 → you're swapping, fix the memory limit now.",
    why: (I) => I.lv === 1 ? `RSS was ${human(Math.round(I.used * I.ratio))} for ${human(I.used)} of data (ratio ${I.ratio.toFixed(2)}): holes left by yesterday's deletes. Active defrag compacts them while serving traffic.` : I.lv === 2 ? `used_memory was ${human(I.used)} on a ${human(I.sys)} host with maxmemory 0, so the kernel had swapped part of Redis out (ratio 0.61): the disk reads were Redis page faults. A maxmemory around 60% of RAM with allkeys-lru brings it back into RAM; defrag would make things worse while swapping.` : `The libc allocator can't do active defrag. The replica, which loaded its data by full sync, was at ratio 1.07 and in sync (lag 0), so a Sentinel failover swapped roles with no cold cache, and the old primary will rebuild compactly when it resyncs as a replica.`,
  });

  /* ----- 8. streams: unstick a consumer group ----- */
  function streamShell(I) {
    const lv = I.lv;
    const ids = (n, t0) => Array.from({ length: n }, (_, i) => `${t0 + i * 37}-0`);
    const pel = [];
    const t0 = 1760300000000;
    if (lv < 3) {
      ids(I.dead, t0).forEach((id) => pel.push({ id, c: I.deadName, idle: I.deadIdle, dc: 1 }));
      if (lv === 2) pel[I.poisonAt].dc = I.poisonDc;
      ids(3, t0 + 900000).forEach((id) => pel.push({ id, c: "worker-2", idle: 380, dc: 1 }));
    } else {
      ids(I.live, t0).forEach((id, i) => pel.push({ id, c: `worker-${1 + (i % 3)}`, idle: 1000 + (i * 7919) % I.p99, dc: 1 + (i % 4 === 0 ? 2 : 0) }));
      ids(I.dead, t0 + 500000).forEach((id) => pel.push({ id, c: I.deadName, idle: I.deadIdle, dc: 1 }));
    }
    const S0 = { pel, dlq: [], acked: [], claimed: [], stolen: 0, poisonTo: null, delc: false };
    const fmtEntry = (p) => [p.id, ["order_id", String(400000 + (K.hash(p.id) % 99999)), "type", "order.paid"]];
    const consumers = (st) => { const m = {}; st.x.pel.forEach((p) => (m[p.c] = (m[p.c] || 0) + 1)); const names = new Set(["worker-1", "worker-2", "worker-3", I.deadName, ...Object.keys(m)]); if (st.x.delc) names.delete(I.deadName); return [...names].map((n) => [n, m[n] || 0]); };
    const N = { role: "master", ver: "7.2.5", keys: { [I.stream]: { t: "stream", ttl: -1, mem: 81233011, n: 1203311, enc: "stream" } }, cfg: {}, dbsize: 12, clients: lv === 3 ? [{ id: 55, addr: "10.0.7.9:40122", name: "reclaimer-cron", age: 9121, idle: 4, cmd: "xautoclaim" }] : [], nclients: 12 };
    return rcli({
      prompt: `${I.host}:6379>`,
      init: { def: I.host, nodes: { [I.host]: N }, x: S0 },
      motd: lv === 3 ? `ALERT fulfilment: duplicate shipments created (${I.dups} in the last hour) · consumer group "${I.group}"` : `ALERT ${I.group} consumer group pending > ${I.dead} for 2h · pod ${I.deadName} was deleted during a node drain`,
      cmds: [`XINFO GROUPS ${I.stream}`, `XINFO CONSUMERS ${I.stream} ${I.group}`, `XPENDING ${I.stream} ${I.group}`, `XPENDING ${I.stream} ${I.group} IDLE 0 - + 10`, `XAUTOCLAIM ${I.stream} ${I.group} <consumer> <min-idle-ms> 0-0 COUNT 1000`, "XACK <stream> <group> <id>", "XADD <dlq-stream> * <field> <value>", `XRANGE ${I.stream} <id> <id>`, "CLIENT LIST"],
      par: lv === 2 ? 8 : 6, opts: lv === 3 ? I.opts : undefined, optq: "Why are orders processed twice?",
      extra: [
        { re: /^XINFO GROUPS (\S+)$/i, use: "XINFO GROUPS <stream>", desc: "", run: (m, st) => m[1] !== I.stream ? "(error) ERR no such key" : rep([["name", I.group, "consumers", consumers(st).length, "pending", st.x.pel.length, "last-delivered-id", `${t0 + 2000000}-0`, "entries-read", 1203311, "lag", 0]]) },
        { re: /^XINFO CONSUMERS (\S+) (\S+)$/i, use: "XINFO CONSUMERS <stream> <group>", desc: "", run: (m, st) => m[2] !== I.group ? "(error) NOGROUP No such consumer group for key name '" + m[1] + "'" : rep(consumers(st).map(([n, c]) => ["name", n, "pending", c, "idle", n === I.deadName ? I.deadIdle : 120 + (K.hash(n) % 900), "inactive", n === I.deadName ? I.deadIdle : 120 + (K.hash(n) % 900)])) },
        { re: /^XPENDING (\S+) (\S+)(?: IDLE (\d+))? (\S+) (\S+) (\d+)(?: (\S+))?$/i, use: "XPENDING <stream> <group> [IDLE ms] - + <count> [consumer]", desc: "pending entries: id, owner, idle ms, delivery count", run: (m, st) => {
          let ps = st.x.pel.filter((p) => !m[3] || p.idle >= +m[3]); if (m[7]) ps = ps.filter((p) => p.c === m[7]);
          ps = ps.slice().sort((a, b) => b.dc - a.dc || (a.id < b.id ? -1 : 1));
          const out = rep(ps.slice(0, +m[6]).map((p) => [p.id, p.c, p.idle, p.dc]));
          return out + (ps.length > +m[6] ? `\n(showing ${m[6]} of ${ps.length}, highest delivery count first)` : "");
        } },
        { re: /^XPENDING (\S+) (\S+)$/i, use: "XPENDING <stream> <group>", desc: "summary per consumer", run: (m, st) => { const ps = st.x.pel; if (!ps.length) return rep([0, null, null, null]); return rep([ps.length, ps[0].id, ps[ps.length - 1].id, consumers(st).filter(([, c]) => c).map(([n, c]) => [n, String(c)])]); } },
        { re: /^XRANGE (\S+) (\S+) (\S+)(?: COUNT \d+)?$/i, use: "XRANGE <stream> <start> <end>", desc: "", run: (m, st) => { const p = st.x.pel.find((x) => x.id === m[2]) || { id: m[2] }; return rep([fmtEntry(p)]); } },
        { re: /^XAUTOCLAIM (\S+) (\S+) (\S+) (\d+) (\S+)(?: COUNT (\d+))?(?: JUSTID)?$/i, use: "XAUTOCLAIM <stream> <group> <consumer> <min-idle-ms> <start> [COUNT n]", desc: "transfer idle pending entries to a consumer", run: (m, st) => {
          if (m[1] !== I.stream) return "(error) ERR no such key";
          if (m[2] !== I.group) return `(error) NOGROUP No such key '${m[1]}' or consumer group '${m[2]}'`;
          const minIdle = +m[4], cnt = +(m[6] || 100), to = m[3];
          const cand = st.x.pel.filter((p) => p.idle >= minIdle && p.c !== to).slice(0, cnt);
          cand.forEach((p) => { if (p.c !== I.deadName) st.x.stolen++; if (lv === 2 && p.dc >= I.poisonDc) st.x.poisonTo = to; p.c = to; p.idle = 0; p.dc++; });
          st.x.claimed.push(...cand.map((p) => p.id));
          const more = st.x.pel.filter((p) => p.idle >= minIdle && p.c !== to).length;
          return rep([more ? cand[cand.length - 1].id : "0-0", cand.slice(0, 3).map(fmtEntry), []]) + (cand.length > 3 ? `\n   ... (${cand.length} entries claimed)` : "");
        } },
        { re: /^XACK (\S+) (\S+) (.+)$/i, use: "XACK <stream> <group> <id> [id ...]", desc: "acknowledge entries", run: (m, st) => { const ids2 = argv(m[3]); const before = st.x.pel.length; st.x.pel = st.x.pel.filter((p) => !ids2.includes(p.id)); st.x.acked.push(...ids2); return rep(before - st.x.pel.length); } },
        { re: /^XADD (\S+)(?: MAXLEN ~? ?\d+)? (\*|\S+-\S+) (.+)$/i, use: "XADD <stream> * field value [...]", desc: "append an entry", run: (m, st) => { if (m[1] === I.stream) return { out: `"${t0 + 3000000}-0"`, danger: "You appended a new event to the live orders stream: consumers will process it as a real order." }; st.x.dlq.push({ s: m[1], f: m[3] }); return `"${t0 + 3000001}-0"`; } },
        { re: /^XGROUP (DELCONSUMER|SETID|DESTROY) (\S+) (\S+)(?: (\S+))?.*$/i, use: "XGROUP DELCONSUMER|SETID ...", desc: "", run: (m, st) => {
          const sub = m[1].toUpperCase();
          if (sub === "DELCONSUMER") { const n = st.x.pel.filter((p) => p.c === m[4]).length; st.x.pel = st.x.pel.filter((p) => p.c !== m[4]); if (m[4] === I.deadName) st.x.delc = true; if (n) { st.x.lost = (st.x.lost || 0) + n; return { out: rep(n), danger: `DELCONSUMER dropped ${n} pending entries along with the consumer: those orders will never be processed.` }; } return rep(0); }
          if (sub === "SETID") { st.x.lost = (st.x.lost || 0) + st.x.pel.length; return { out: "OK", danger: "SETID moves the group's cursor: entries between the old and new ID are skipped for good." }; }
          st.x.lost = 1e9; return { out: rep(1), danger: "You destroyed the consumer group." };
        } },
        { re: /^XTRIM .*$/i, use: "XTRIM <stream> MAXLEN n", desc: "", hidden: true, run: () => ({ out: rep(120331), danger: "Trimming deletes unprocessed entries from the stream." }) },
      ],
    });
  }
  S.push({
    id: "redis-stream-pending",
    name: "Unstick the consumer group",
    kind: "Incident",
    skills: ["diagnose", "safe"],
    ...LB.term({
      shell: streamShell,
      goal(st, I, a) {
        const x = st.x;
        if (x.lost) return "Pending entries were dropped instead of processed: those orders are lost.";
        if (x.stolen) return `Your claim took ${x.stolen} entries that live consumers were still working on: they'll be processed twice. Choose a min-idle-time above how long a healthy consumer can hold an entry.`;
        if (I.lv === 2) {
          if (x.poisonTo) return `${esc(x.poisonTo)} received the entry delivered ${I.poisonDc} times (the one that crashes workers) and is now crash-looping. Park it in a dead-letter stream and XACK it first.`;
          if (!x.acked.includes(I.poisonId) || !x.dlq.some((d) => d.f.includes(I.poisonId))) return `Entry <code>${I.poisonId}</code> (delivered ${I.poisonDc} times) must be copied to a dead-letter stream (include its id) and acknowledged.`;
        }
        if (I.lv === 3 && a.pick !== I.ans) return "Look at delivery counts and idle times of the <i>live</i> consumers, and what the reclaimer client does.";
        const deadLeft = x.pel.filter((p) => p.c === I.deadName).length;
        if (deadLeft) return `${deadLeft} entries are still owned by <code>${esc(I.deadName)}</code>, which no longer exists.`;
        return true;
      },
      solve: (I) => ({ log: [`XINFO CONSUMERS ${I.stream} ${I.group}`, ...(I.lv === 2 ? [`XPENDING ${I.stream} ${I.group} IDLE 0 - + 10`, `XADD ${I.stream}.dlq * id ${I.poisonId} reason poison`, `XACK ${I.stream} ${I.group} ${I.poisonId}`] : []), ...(I.lv === 3 ? ["CLIENT LIST"] : []), `XAUTOCLAIM ${I.stream} ${I.group} worker-1 ${I.lv === 3 ? I.p99 * 3 : 600000} 0-0 COUNT ${I.dead + 50}`], pick: I.lv === 3 ? I.ans : null }),
    }),
    gen(lv, R) {
      const I = { lv, host: `stream-${R.int(1, 3)}`, stream: R.pick(["orders.events", "payments.events", "shipments.events"]), group: R.pick(["fulfil", "ledger", "notify"]), dead: R.int(40, 120) * 10, deadName: `worker-${R.int(4, 9)}-${R.pick(["7d9f", "x2kq", "m81c"])}`, deadIdle: R.int(2, 4) * 3600000 + R.int(0, 99999), dups: R.int(30, 140) };
      if (lv === 2) { I.poisonAt = R.int(5, I.dead - 5); I.poisonDc = R.int(18, 46); I.poisonId = `${1760300000000 + I.poisonAt * 37}-0`; }
      if (lv === 3) {
        I.live = R.int(30, 80); I.p99 = R.int(35, 55) * 1000; I.dead = R.int(4, 12) * 10;
        const o = ["The reclaimer cron's XAUTOCLAIM min-idle-time is shorter than how long a healthy worker holds an entry", "Producers publish each order twice", "Consumers don't XACK after processing", "The dead consumer still owns entries"];
        const ord = R.shuffle([0, 1, 2, 3]); I.opts = ord.map((i) => o[i]); I.ans = ord.indexOf(0);
      }
      return I;
    },
    bad: (I) => [{ log: [`XGROUP DELCONSUMER ${I.stream} ${I.group} ${I.deadName}`] }, { log: [`XAUTOCLAIM ${I.stream} ${I.group} worker-1 0 0-0 COUNT 5000`], pick: I.lv === 3 ? I.ans : null }, ...(I.lv === 2 ? [{ log: [`XAUTOCLAIM ${I.stream} ${I.group} worker-1 600000 0-0 COUNT 5000`] }] : []), ...(I.lv === 3 ? [{ log: [`XAUTOCLAIM ${I.stream} ${I.group} worker-1 600000 0-0 COUNT 5000`], pick: (I.ans + 1) % 4 }, { log: [`XAUTOCLAIM ${I.stream} ${I.group} worker-1 10000 0-0 COUNT 5000`], pick: I.ans }] : [])],
    text: (I) => I.lv === 3 ? `<p>Fulfilment created ${I.dups} duplicate shipments in the last hour. Workers consume <code>${esc(I.stream)}</code> in group <code>${esc(I.group)}</code>; a single job can legitimately take up to ~${Math.round(I.p99 / 1000)} s (a slow carrier API). A <code>reclaimer-cron</code> was added last week "to recover stuck messages". Also, a worker pod was scaled away earlier.</p><p>Diagnose the duplicates and recover the dead consumer's entries without causing more.</p>`
      : `<p>Workers consume <code>${esc(I.stream)}</code> in consumer group <code>${esc(I.group)}</code>. A node drain deleted pod <code>${esc(I.deadName)}</code> mid-batch; its delivered-but-unacknowledged entries are stuck in the pending list${I.lv === 2 ? ". Workers have also been crashing on and off all day" : ""}.</p><p>Get every stuck entry processed by a live consumer (<code>worker-1</code> is healthy), without losing any or processing any twice.</p>`,
    hint: (I) => I.lv === 1 ? "XAUTOCLAIM transfers entries idle for at least min-idle-time. What do the live consumers' idle times look like?" : I.lv === 2 ? "XPENDING's extended form shows delivery counts. An entry delivered dozens of times is a poison message." : "If a reclaimer claims entries that a healthy worker is still processing, both finish them.",
    concept: "Streams consumer groups: pending entries, XAUTOCLAIM, poison messages",
    how: "In a consumer group, XREADGROUP hands an entry to one consumer and records it in the Pending Entries List (PEL) until XACK. If the consumer dies, its entries stay pending forever; XAUTOCLAIM (or XCLAIM) transfers entries idle for at least min-idle-time to another consumer and increments their delivery count. min-idle-time must exceed the longest time a healthy consumer may hold an entry, or you steal in-flight work and process it twice. An entry with a high delivery count is a poison message: copy it to a dead-letter stream and XACK it. XGROUP DELCONSUMER discards a consumer's pending entries, so claim first. Pub/Sub has none of this: a disconnected subscriber simply misses messages.",
    rule: "Claim with min-idle-time above your processing p99 (with margin), dead-letter anything past N deliveries, and only delete a consumer once its PEL is empty.",
    why: (I) => I.lv === 1 ? `${K.num(I.dead)} entries were pending on the deleted <code>${esc(I.deadName)}</code>, idle for hours. XAUTOCLAIM with a min-idle-time of minutes moved them to worker-1 without touching the 3 entries worker-2 was still processing (idle ~380 ms).`
      : I.lv === 2 ? `Entry <code>${I.poisonId}</code> had been delivered ${I.poisonDc} times: it crashes whoever processes it. Parking it in a dead-letter stream and acknowledging it before XAUTOCLAIM let the other ${K.num(I.dead - 1)} entries flow to worker-1 safely.`
        : `Healthy workers hold entries for up to ~${Math.round(I.p99 / 1000)} s, but the reclaimer claimed anything idle over 10 s, so slow jobs were handed to a second worker and both completed them (delivery counts of 3+ on live entries). Its min-idle-time needs to sit well above the processing p99 (and processing must be idempotent anyway). The dead consumer's entries were safe to claim with min-idle ${Math.round(I.p99 * 3 / 1000)} s.`,
  });

  /* ----- 9. Cluster hash tags (code) ----- */
  const HT = {
    keys: (lv) => lv === 1 ? ["cart", "cart_items"] : lv === 2 ? ["cart", "cart_items", "wishlist"] : ["cart", "cart_items", "orders_index", "order"],
  };
  function htCheck(I, src) {
    const lines = String(src || "").split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
    const map = {};
    for (const l of lines) { const m = l.match(/^(\w+)\s*[:=]\s*(\S+)$/); if (!m) return { err: `Can't read <code>${esc(l)}</code>: write <code>name = template</code>.` }; map[m[1]] = m[2]; }
    const need = HT.keys(I.lv);
    for (const k of need) if (!map[k]) return { err: `Missing a template for <code>${k}</code>.` };
    const users = Array.from({ length: 40 }, (_, i) => String(1000 + i * 7919 % 90000)), orders = users.map((u, i) => String(500000 + i * 104729 % 400000));
    const res = { perUser: [], slots: new Set(), keyset: new Set(), err: null };
    for (const k of need) {
      const t = map[k];
      if (!t.includes("<user_id>") && k !== "order") return { err: `<code>${k}</code> must contain <code>&lt;user_id&gt;</code> so each user gets their own key.` };
      if (k === "order" && !t.includes("<order_id>")) return { err: "<code>order</code> must contain <code>&lt;order_id&gt;</code>." };
      if (/[{}]/.test(t.replace(/\{[^{}]*\}/g, ""))) return { err: `Unbalanced braces in <code>${esc(t)}</code>.` };
    }
    users.forEach((u, i) => {
      const ks = need.map((k) => map[k].replace(/<user_id>/g, u).replace(/<order_id>/g, orders[i]));
      ks.forEach((x) => res.keyset.add(x));
      const sl = new Set(ks.map(slotOf));
      res.perUser.push({ u, ks, n: sl.size });
      ks.forEach((x) => res.slots.add(slotOf(x)));
    });
    res.dupe = res.keyset.size < users.length * need.length;
    res.cross = res.perUser.filter((p) => p.n > 1).length;
    res.distinct = res.slots.size;
    if (I.lv === 3 && !map.order.includes("<user_id>")) res.orderNoUser = true;
    return res;
  }
  S.push({
    id: "redis-cluster-hashtags",
    name: "Fix CROSSSLOT with hash tags",
    kind: "Code review",
    skills: ["design"],
    w: "code",
    gen(lv, R) { return { lv, svc: R.pick(["checkout", "cart", "storefront"]), uid: R.int(10000, 99999), oid: R.int(500000, 900000) }; },
    text: (I) => `<p>The ${esc(I.svc)} service is moving from a single Redis to <b>Redis Cluster</b>. Its checkout path runs one Lua script (or MULTI/EXEC) per user touching ${I.lv === 1 ? "the cart and its items" : I.lv === 2 ? "the cart, its items and the wishlist" : "the cart, its items, the user's order index and the new order record (looked up later by order id alone, e.g. <code>GET order:…</code> from the support tool, which also knows the user id)"}. In staging every call fails:</p>${K.pre(`(error) CROSSSLOT Keys in request don't hash to the same slot`)}<p>Rewrite the key templates (one per line, <code>name = template</code>, placeholders <code>&lt;user_id&gt;</code>${I.lv === 3 ? ", <code>&lt;order_id&gt;</code>" : ""}). The live panel computes real CRC16 slots for 40 sample users. Each user's keys must share a slot, and different users must still spread across the cluster.</p>`,
    ui: (I) => ({ lang: "text", file: "keys.conf", rows: 6, starter: I.lv === 1 ? "cart = cart:<user_id>\ncart_items = cart:<user_id>:items" : I.lv === 2 ? "cart = cart:<user_id>\ncart_items = cart:<user_id>:items\nwishlist = wishlist:<user_id>" : "cart = cart:<user_id>\ncart_items = cart:<user_id>:items\norders_index = orders:<user_id>\norder = order:<order_id>", live: (src) => {
      const r = htCheck(I, src);
      if (r.err) return `<p class="lose small">${r.err}</p>`;
      const ex = r.perUser[0];
      return K.table(["key (user " + ex.u + ")", "slot"], ex.ks.map((k) => [`<span class="mono">${esc(k)}</span>`, String(slotOf(k))]), { compact: true }) + K.metrics([
        { name: "Users whose keys span slots", value: `${r.cross}/40`, ok: r.cross === 0, target: "0 (else CROSSSLOT)" },
        { name: "Distinct slots used", value: String(r.distinct), ok: r.distinct >= 30, target: "spread across the cluster" },
      ]);
    } }),
    accept(I, src) {
      const r = htCheck(I, src);
      if (r.err) return r.err;
      if (r.dupe) return "Two different keys collapse into one name: each template must stay distinct.";
      if (r.cross) return `${r.cross} of 40 users still have keys in different slots: their script would fail with CROSSSLOT. The hash tag (the part in <code>{…}</code>) must be identical for all of a user's keys.`;
      if (r.distinct < 30) return `Every user's keys land in only ${r.distinct} slot(s): one shard would take all checkout traffic. Tag by something per-user, not a constant like <code>{cart}</code>.`;
      return true;
    },
    solve: (I) => I.lv === 1 ? "cart = cart:{<user_id>}\ncart_items = cart:{<user_id>}:items" : I.lv === 2 ? "cart = cart:{<user_id>}\ncart_items = cart:{<user_id>}:items\nwishlist = wishlist:{<user_id>}" : "cart = cart:{<user_id>}\ncart_items = cart:{<user_id>}:items\norders_index = orders:{<user_id>}\norder = order:{<user_id>}:<order_id>",
    bad: (I) => I.lv === 1 ? ["cart = {cart}:<user_id>\ncart_items = {cart}:<user_id>:items", "cart = cart:<user_id>\ncart_items = cart:<user_id>:items"] : I.lv === 2 ? ["cart = {cart}:<user_id>\ncart_items = {cart}:<user_id>:items\nwishlist = {wishlist}:<user_id>", "cart = cart:{<user_id>}\ncart_items = cart:{<user_id>}:items\nwishlist = {wishlist}:<user_id>"] : ["cart = cart:{<user_id>}\ncart_items = cart:{<user_id>}:items\norders_index = orders:{<user_id>}\norder = order:{<order_id>}", "cart = {u}:cart:<user_id>\ncart_items = {u}:cart:<user_id>:items\norders_index = {u}:orders:<user_id>\norder = {u}:order:<order_id>"],
    hint: (I) => I.lv === 1 ? "Redis Cluster hashes only the substring inside the first {…} if one is present." : I.lv === 2 ? "The tag must be the same for all of one user's keys, but different between users." : "The order record must live in the user's slot, so its name has to carry the user id in the tag. That's why the support tool needs the user id.",
    concept: "Redis Cluster hash slots and hash tags",
    how: "Redis Cluster maps every key to one of 16,384 slots with CRC16(key) mod 16384, and each primary owns a range of slots. Multi-key commands, MULTI/EXEC transactions and Lua scripts must touch keys in a single slot, or they fail with CROSSSLOT. A hash tag changes what is hashed: if a key contains {…} with non-empty content, only the content of the first such pair is hashed. Tag by the entity that defines your transaction boundary (a user id), not by a constant, or all keys collapse into one slot and one shard takes all the traffic.",
    rule: "Design key names around transaction boundaries: put the entity id in a hash tag ({user:42}) for everything one atomic operation must touch, and keep the tag high-cardinality.",
    why: (I, sol) => `With tags like <code>cart:{&lt;user_id&gt;}</code> every key of user ${I.uid} hashes the same string, e.g. slot ${slotOf(`cart:{${I.uid}}`)}, while different users spread over thousands of slots. ${I.lv === 3 ? `The order record had to become <code>order:{&lt;user_id&gt;}:&lt;order_id&gt;</code>: tagging it by order id puts it in another slot, so the checkout script can't create it atomically with the index.` : "A constant tag like {cart} would also avoid CROSSSLOT, but would send every user to one shard."}`,
  });

  LB.addAll("redis", S);
})();
