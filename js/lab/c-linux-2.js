/* Systems Lab · Linux & production debugging (part 2: tuning simulators, plans, reviews and estimates). */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const hs = (mb) => { if (mb >= 1024) { const g = mb / 1024; return (g < 10 ? g.toFixed(1) : String(Math.round(g))) + "G"; } return Math.max(0, Math.round(mb)) + "M"; };

  /* ---------- ephemeral ports ---------- */
  const RANGES = { "32768 60999": 28232, "15000 60999": 46000, "1024 65535": 64512 };
  const portSim = (I, c) => {
    const ka = I.lv === 1 ? false : c.ka === "on (pooled connections)";
    const newPerS = ka ? Math.ceil(I.rate / 200) : I.rate;
    const reuse = c.reuse === 1 && I.ts;
    const hold = reuse ? 1 : 60;
    const need = newPerS * hold, ports = RANGES[c.range];
    return { newPerS, need, ports, tw: newPerS * 60, err: need >= ports * 0.95, ka, reuse };
  };
  const portDefaults = { ka: "off (Connection: close)", range: "32768 60999", reuse: 2, fin: 60 };

  /* ---------- DNS search-list resolution (glibc res_search) ---------- */
  const SEARCH = (I, c) => ["shop.svc.cluster.local", "svc.cluster.local", "cluster.local", ...(I.lv === 3 && c.search !== "cluster domains only" ? ["corp.internal"] : [])];
  const EXIST = new Set(["redis.shop.svc.cluster.local", "orders.billing.svc.cluster.local", "api.paygate.example", "vault.corp.internal"]);
  const resolve = (name, I, c) => {
    if (name.endsWith(".")) return { tries: 1, ok: EXIST.has(name.slice(0, -1)) };
    const dots = (name.match(/\./g) || []).length;
    const cands = [];
    const s = SEARCH(I, c).map((d) => name + "." + d);
    if (dots >= c.ndots) cands.push(name, ...s); else cands.push(...s, name);
    for (let k = 0; k < cands.length; k++) if (EXIST.has(cands[k])) return { tries: k + 1, ok: true };
    return { tries: cands.length, ok: false };
  };
  const dnsNames = (I, c) => I.names.map((n) => ({ ...n, q: n.ext && c.fqdn === "with trailing dot" ? n.name + "." : n.name }));
  const dnsSim = (I, c) => { const rows = dnsNames(I, c).map((n) => ({ ...n, ...resolve(n.q, I, c) })); return { rows, qps: rows.reduce((s, r) => s + r.rate * r.tries * 2, 0), bad: rows.filter((r) => !r.ok) }; };

  /* ---------- CPU quota throttling (100 ms CFS periods) ---------- */
  const cpuSim = (I, c) => {
    const L = c.limit, P = c.gmp === "unset (sees 32)" ? 32 : +c.gmp;
    const Q = 100 * L, B = 100 * I.u, Dm = B + I.G;
    const over = Dm > Q;
    const throttle = over && P > L ? Math.max(0, 100 - Q / P) : 0;
    const stall = I.G / Math.min(P, L);
    const carry = over ? (Dm - Q) / L : 0;
    const p99 = I.base + 0.5 * stall + throttle + carry;
    return { L, P, throttle, stall, carry, p99, thrPct: throttle > 0 ? I.f : 0, avgPct: I.u / L, ok: p99 <= I.target && I.u <= 0.8 * L };
  };

  /* ---------- OOM victim selection ---------- */
  const oomVictim = (snap, adj, T) => {
    let best = null;
    snap.procs.forEach((p) => { const a = adj[p.k] != null ? adj[p.k] : 0; if (a <= -1000) return; const s = (p.mb / T) * 1000 + a; if (!best || s > best.s) best = { ...p, s }; });
    return best;
  };

  /* ---------- logrotate outcomes ---------- */
  const rotSim = (I, c) => {
    const m = c.method, delay = c.comp === "compress + delaycompress";
    const r = { lost: false, disk: true, crash: false, holes: false, notes: [] };
    if (m.startsWith("create + postrotate")) {
      if (!I.reopen) { r.crash = true; r.notes.push(`The app has no ${I.sig} handler; the default action for ${I.sig} terminates it.`); }
      else if (!delay) { r.lost = true; r.notes.push("The signal is asynchronous: lines written to the renamed file between rename and reopen end up in app.log.1, which is compressed (and removed) immediately. Those lines are lost."); }
      else r.notes.push("Rename, signal, the app reopens app.log; app.log.1 is compressed one cycle later, after the app has let go of it.");
    } else if (m === "create (no signal)") { r.lost = true; r.disk = false; r.notes.push("The app keeps writing to its open file, now app.log.1; compression or the next rotation deletes it while it's still open: lines vanish and the space is never freed (lsof +L1)."); }
    else if (m === "copytruncate") {
      r.lost = true; r.notes.push("Lines written between the copy and the truncate are lost (a small window).");
      if (!I.append) { r.holes = true; r.notes.push("The app doesn't open with O_APPEND, so after truncation it keeps writing at its old offset: the file becomes sparse with a hole of NUL bytes."); }
    } else { r.notes.push("The app writes to stdout; journald (or the container runtime) stores and rotates it. No file to rotate, nothing to signal."); }
    return r;
  };
  const rotOK = (I, r) => { if (r.crash) return "the app dies at rotation"; if (!r.disk) return "disk space is never reclaimed"; if (I.noLoss && r.lost) return "lines are lost, which this log can't tolerate"; if (r.holes) return "the file fills with NUL holes"; return true; };

  LB.addAll("linux", [
    /* ======================================================================== */
    {
      id: "linux-ephemeral-ports",
      name: "Cannot assign requested address",
      kind: "Config change",
      skills: ["tune", "diagnose"],
      w: "tune",
      sense: "min",
      vname: "changes:",
      gen(lv, R) { return { lv, rate: lv === 1 ? R.int(55, 65) * 10 : lv === 2 ? R.int(115, 135) * 10 : R.int(190, 230) * 10, ts: lv !== 3, up: `10.40.${R.int(1, 9)}.${R.int(10, 99)}:443` }; },
      text: (I) => `<p>A worker calls one upstream, <code>${I.up}</code>, about <b>${K.num(I.rate)} times/s</b>. Its HTTP client opens a new TCP connection per request and closes it (<code>Connection: close</code>). Since traffic grew, a share of calls fail with <code>connect: cannot assign requested address</code>. <code>ss -s</code> shows ~${K.num(Math.min(I.rate * 60, 28000))} sockets in TIME-WAIT. The host also runs services listening on <b>8080</b> and <b>9100</b>.</p>${I.lv === 1 ? "<p>The client can't be changed today; only kernel settings.</p>" : ""}${I.lv === 3 ? "<p>The upstream sits behind a load balancer that <b>strips TCP timestamps</b>.</p>" : ""}<p>Stop the errors with the <b>fewest changes</b>.</p>`,
      ui: (I) => ({
        knobs: [
          ...(I.lv === 1 ? [] : [{ k: "ka", label: "HTTP client connections", opts: ["off (Connection: close)", "on (pooled connections)"], help: "a one-line client config change, deployed normally" }]),
          { k: "range", label: "net.ipv4.ip_local_port_range", opts: Object.keys(RANGES), help: "ephemeral ports for outgoing connections" },
          { k: "reuse", label: "net.ipv4.tcp_tw_reuse", opts: [2, 1, 0], fmt: (v) => (v === 2 ? "2 (loopback only, default)" : String(v)), help: "reuse TIME-WAIT ports for new outgoing connections (needs TCP timestamps)" },
          { k: "fin", label: "net.ipv4.tcp_fin_timeout", opts: [60, 30, 10], unit: "s" },
        ],
        init: { ...portDefaults },
        live: (c) => { const r = portSim(I, c); return K.metrics([{ name: "New connections/s", value: K.num(r.newPerS), ok: null }, { name: "Ports held (per destination)", value: K.num(r.need), ok: !r.err, target: `of ${K.num(r.ports)} ephemeral ports` }, { name: "EADDRNOTAVAIL errors", value: r.err ? "yes" : "none", ok: !r.err }]) + (c.range === "1024 65535" ? K.note("This range includes 8080 and 9100: an outgoing connection can grab one of those ports while its service restarts.", "bad") : "") + (c.fin !== 60 ? K.note("tcp_fin_timeout sets the FIN-WAIT-2 timeout, not TIME-WAIT, which is fixed at 60 s.") : ""); },
      }),
      valid: (I, c) => { if (c.range === "1024 65535") return "the range overlaps 8080 and 9100; an outgoing connection can take one of those ports and the service then fails to bind"; const r = portSim(I, c); return r.err ? `${K.num(r.need)} ports would be held per destination against ${K.num(r.ports)} available: still failing` : true; },
      val: (I, c) => ["ka", "range", "reuse", "fin"].filter((k) => c[k] !== undefined && c[k] !== portDefaults[k]).length,
      hint: (I) => I.lv === 1 ? "Each closed outgoing connection holds its port in TIME-WAIT for 60 s. Compare rate × 60 with the size of the port range." : I.lv === 2 ? "Widening the range isn't enough at this rate. What lets a port be reused before TIME-WAIT ends, or avoids new connections altogether?" : "tcp_tw_reuse relies on TCP timestamps to tell old segments from new ones.",
      concept: "Ephemeral port exhaustion and TIME-WAIT",
      how: "Every outgoing TCP connection needs a unique (source IP, source port, destination IP, destination port). To one destination, only the ephemeral range varies: 28,232 ports by default. The side that closes first keeps the socket in TIME-WAIT for 60 s (fixed in Linux; tcp_fin_timeout is for FIN-WAIT-2), so new connections per second × 60 must fit in the range or connect() fails with EADDRNOTAVAIL. tcp_tw_reuse=1 lets outgoing connections reuse a TIME-WAIT port after about a second, but only with TCP timestamps. The real fix is fewer connections: keep-alive and pooling. Widening the range into ports your services listen on risks stealing them unless you set ip_local_reserved_ports.",
      rule: "Reuse connections (keep-alive, pools) to busy upstreams. If you must tune, prefer tcp_tw_reuse=1 for clients, reserve listening ports before widening the range, and ignore advice about tcp_tw_recycle (removed in Linux 4.12) or tcp_fin_timeout.",
      why: (I, sol) => { const r = portSim(I, sol); return `At ${K.num(I.rate)} new connections/s, TIME-WAIT holds ${K.num(I.rate * 60)} ports, over the 28,232 available. ${r.ka ? "Pooled keep-alive connections cut new connections to a handful per second" : r.reuse ? "tcp_tw_reuse=1 lets the kernel reuse a TIME-WAIT port after ~1 s" : "Widening the range to 15000-60999 (still above 8080 and 9100) gives 46,000 ports"}.${I.lv === 3 ? " With timestamps stripped, tcp_tw_reuse can't help: only connection reuse works." : ""}`; },
    },
    /* ======================================================================== */
    {
      id: "linux-dns-ndots",
      name: "Slow DNS from ndots:5",
      kind: "Config change",
      skills: ["tune", "diagnose"],
      w: "tune",
      sense: "min",
      vname: "DNS queries/s:",
      vfmt: (v) => K.num(v),
      gen(lv, R) {
        const names = [{ name: "redis", rate: R.int(20, 40) * 10, ext: false }, { name: "api.paygate.example", rate: R.int(60, 90) * 10, ext: true }];
        if (lv >= 2) names.push({ name: "orders.billing", rate: R.int(30, 50) * 10, ext: false });
        if (lv === 3) names.push({ name: "vault", rate: R.int(5, 15) * 10, ext: false });
        return { lv, names };
      },
      text: (I) => `<p>A pod in namespace <code>shop</code> resolves these names (no local DNS cache; glibc sends A and AAAA for every attempt):</p>${K.table(["Name", "Lookups/s", "What it is"], I.names.map((n) => [`<code>${n.name}</code>`, K.num(n.rate), n.ext ? "external partner API" : n.name === "redis" ? "Service in the same namespace" : n.name === "vault" ? "vault.corp.internal, found via the node's search domain" : "Service <code>orders</code> in namespace <code>billing</code>"]), { compact: true })}<p>The pod's <code>/etc/resolv.conf</code> has <code>search shop.svc.cluster.local svc.cluster.local cluster.local${I.lv === 3 ? " corp.internal" : ""}</code> and <code>options ndots:5</code>. CoreDNS is overloaded. Change the pod's DNS settings to send the <b>fewest queries</b> while every name still resolves.</p>`,
      ui: (I) => ({
        knobs: [
          { k: "ndots", label: "dnsConfig options ndots", opts: [5, 2, 1] },
          { k: "fqdn", label: "Partner hostname in app config", opts: ["as is", "with trailing dot"], help: "api.paygate.example. is absolute: no search list" },
          ...(I.lv === 3 ? [{ k: "search", label: "Search list", opts: ["inherit node's (adds corp.internal)", "cluster domains only"], help: "dnsPolicy None / dnsConfig.searches" }] : []),
        ],
        init: { ndots: 5, fqdn: "as is", ...(I.lv === 3 ? { search: "inherit node's (adds corp.internal)" } : {}) },
        live: (c) => { const r = dnsSim(I, c); return K.table(["Name queried", "Attempts", "Queries/s"], r.rows.map((x) => [`<code>${esc(x.q)}</code>`, x.ok ? String(x.tries) : `<span class="lose">${x.tries}, NXDOMAIN</span>`, K.num(x.rate * x.tries * 2)]), { compact: true }) + K.metrics([{ name: "Total DNS queries/s", value: K.num(r.qps), ok: null }, { name: "Names resolving", value: `${r.rows.length - r.bad.length}/${r.rows.length}`, ok: !r.bad.length }]); },
      }),
      valid: (I, c) => { const r = dnsSim(I, c); return r.bad.length ? `${r.bad.map((b) => b.q).join(", ")} no longer resolves` : true; },
      val: (I, c) => dnsSim(I, c).qps,
      hint: (I) => I.lv === 1 ? "A name with fewer dots than ndots is tried with every search domain first, and each failed attempt is an A and an AAAA query." : I.lv === 2 ? "orders.billing has one dot. With ndots:1 it's tried as an absolute name first (and fails) before the search list." : "Dropping a search domain is free only if no name depends on it.",
      concept: "Resolver search lists and ndots",
      how: "glibc's resolver treats a name with fewer dots than ndots as relative: it tries each search domain in turn and the bare name last; a name with at least ndots dots is tried as-is first. Kubernetes sets ndots:5 so that short service names work, which means an external name like api.example.com is first tried as api.example.com.ns.svc.cluster.local, svc.cluster.local, cluster.local and any node search domains, each failing with NXDOMAIN, each as A and AAAA queries. A trailing dot makes a name absolute and skips the search list. Lowering ndots helps external names but can make dotted internal names (svc.namespace) try the absolute name first.",
      rule: "For pods that call external hosts heavily, set ndots to 1 or 2 (check names like svc.namespace), use trailing-dot FQDNs for hot external names, run a node-local DNS cache, and keep search domains that something still depends on.",
      why: (I, sol, best) => { const r = dnsSim(I, sol), base = dnsSim(I, { ndots: 5, fqdn: "as is", search: "inherit node's (adds corp.internal)" }); return `With ndots:5 the partner API took ${resolve("api.paygate.example", I, { ndots: 5, search: "x" }).tries} attempts per lookup and the pod sent ${K.num(base.qps)} queries/s. With ndots ${sol.ndots}${sol.fqdn === "with trailing dot" ? " and a trailing-dot partner name" : ""} it's ${K.num(r.qps)}/s, and every name still resolves${I.lv === 3 ? " (vault needs corp.internal in the search list)" : ""}.`; },
    },
    /* ======================================================================== */
    {
      id: "linux-cpu-throttling",
      name: "Throttled at 40% CPU",
      kind: "Capacity plan",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a CPU limit of",
      vfmt: (v) => v + " cores",
      gen(lv, R) {
        const P = [{ u: 1.2, G: 150, target: 60 }, { u: 1.6, G: 300, target: 80 }, { u: 2.2, G: 500, target: 90 }][lv - 1];
        return { lv, ...P, u: +(P.u + R.int(-1, 1) * 0.05).toFixed(2), base: 20, f: R.int(25, 35) / 100, svc: R.pick(["pricing", "search-api", "recs"]) };
      },
      text: (I) => `<p><code>${I.svc}</code> (Go 1.22, so the runtime sees all <b>32</b> host CPUs, not its cgroup limit) averages <b>${I.u} cores</b>, but every few periods a burst of ~<b>${I.G} ms</b> of CPU work (GC plus parallel fan-out) runs on as many threads as GOMAXPROCS allows. p99 must stay under <b>${I.target} ms</b> (it's ${I.base} ms without contention), and average use must stay under 80% of the limit.</p><p>CFS enforces <code>cpu.max</code> per 100 ms period: once the quota is used up, every thread waits for the next period. Pick the <b>smallest CPU limit</b> that meets the target${I.lv > 1 ? "; you may also set GOMAXPROCS" : ""}.</p>`,
      ui: (I) => ({
        knobs: [{ k: "limit", label: "CPU limit (cpu.max)", opts: [1, 2, 3, 4, 6, 8], unit: "cores" }, I.lv === 1 ? { k: "gmp", label: "GOMAXPROCS", opts: ["unset (sees 32)"], fixed: "unset (sees 32)" } : { k: "gmp", label: "GOMAXPROCS", opts: ["unset (sees 32)", "2", "4", "6", "8"] }],
        init: { limit: 1, gmp: "unset (sees 32)" },
        live: (c) => { const r = cpuSim(I, c); return K.metrics([{ name: "Throttled periods", value: K.pct(r.thrPct, 0), ok: r.thrPct === 0, target: "nr_throttled / nr_periods" }, { name: "Throttle per burst", value: K.ms(r.throttle), ok: r.throttle === 0 }, { name: "Average use of limit", value: K.pct(r.avgPct, 0), ok: r.avgPct <= 0.8, target: "≤ 80%" }, { name: "p99 latency", value: K.ms(r.p99), ok: r.p99 <= I.target, target: `< ${I.target} ms` }]) + K.bars([{ label: "base", value: I.base, note: K.ms(I.base) }, { label: "burst stall", value: 0.5 * r.stall, note: K.ms(0.5 * r.stall) }, { label: "throttled", value: r.throttle, cls: r.throttle ? "bad" : "", note: K.ms(r.throttle) }, { label: "spill-over", value: r.carry, note: K.ms(r.carry) }]); },
      }),
      valid: (I, c) => { const r = cpuSim(I, c); if (I.u > 0.8 * c.limit) return `average use would be ${K.pct(r.avgPct, 0)} of the limit`; return r.p99 <= I.target ? true : `p99 would be ${K.ms(r.p99)} (target ${I.target} ms)${r.throttle ? `, including ${K.ms(r.throttle)} throttled per burst` : ""}`; },
      val: (I, c) => c.limit,
      hint: (I) => I.lv === 1 ? "With 32 threads, a quota of L cores × 100 ms is gone after (L × 100) / 32 ms; the rest of the period is throttled." : I.lv === 2 ? "If the runtime never runs more threads than the limit, the quota can't be burned faster than it refills." : "Too few threads stretch the burst; too many burn the quota early. Look for the limit where both fit.",
      concept: "CFS bandwidth throttling",
      how: "A cgroup CPU limit (cpu.max quota/period, Kubernetes limits.cpu) is enforced per period, 100 ms by default: the cgroup may use quota microseconds of CPU across all its threads, then every thread waits until the next period. A process that averages 40% of its limit can still be throttled hard if bursts run many threads in parallel: 32 threads burn a 2-core quota in about 6 ms. cpu.stat shows nr_throttled and throttled_usec. Runtimes that size thread pools from the host CPU count (Go before 1.25, many thread pools) make this worse; matching GOMAXPROCS to the limit (or a container-aware runtime) keeps parallelism within quota.",
      rule: "Watch cpu.stat nr_throttled/nr_periods, not average CPU. Set GOMAXPROCS (or the runtime's equivalent) to the CPU limit, and size limits for bursts, not averages, or don't set a CPU limit at all where policy allows.",
      why: (I, sol) => { const r = cpuSim(I, sol); return `With limit ${sol.limit} and GOMAXPROCS ${sol.gmp}, the ${I.G} ms burst ${r.throttle ? `is throttled ${K.ms(r.throttle)}` : "is never throttled"} and p99 ≈ ${K.ms(r.p99)}. ${sol.gmp === "unset (sees 32)" ? "Without GOMAXPROCS the only way to avoid throttling is a quota big enough to absorb the whole burst." : "Matching GOMAXPROCS to the limit keeps the burst from draining the quota in a few milliseconds, so a smaller limit suffices."}`; },
    },
    /* ======================================================================== */
    {
      id: "linux-oom-score-adj",
      name: "Choose who the OOM killer takes",
      kind: "Hardening",
      skills: ["tune", "safe"],
      w: "tune",
      sense: "min",
      vname: "settings changed:",
      gen(lv, R) {
        const T = 32768, pg = R.int(85, 95) * 100;
        const snaps = [{ name: "ETL job runs away", want: "etl", procs: [{ k: "postgres", name: "postgres backend", mb: pg }, { k: "etl", name: "etl.py", mb: R.int(55, 70) * 100 }, { k: "app", name: "api worker", mb: R.int(15, 25) * 100 }, { k: "sshd", name: "sshd", mb: 12 }] }];
        if (lv >= 2) snaps.push({ name: "an api worker leaks", want: "app", procs: [{ k: "postgres", name: "postgres backend", mb: pg }, { k: "etl", name: "etl.py", mb: R.int(8, 14) * 100 }, { k: "app", name: "api worker", mb: R.int(68, 78) * 100 }, { k: "sshd", name: "sshd", mb: 12 }] });
        if (lv === 3) snaps.push({ name: "a postgres query runs away (huge hash join)", want: "postgres", procs: [{ k: "postgres", name: "postgres backend", mb: R.int(190, 210) * 100 }, { k: "etl", name: "etl.py", mb: R.int(8, 14) * 100 }, { k: "app", name: "api worker", mb: R.int(15, 25) * 100 }, { k: "sshd", name: "sshd", mb: 12 }] });
        return { lv, T, snaps };
      },
      text: (I) => `<p>A 32 GB host runs Postgres, an API, a nightly ETL and sshd. Postgres backends show ~${hs(I.snaps[0].procs[0].mb)} RSS each, mostly shared_buffers. Set <code>OOMScoreAdjust=</code> so that in every scenario below the kernel kills the process that <b>caused</b> the shortage, changing as <b>few</b> settings as possible:</p><ul>${I.snaps.map((s) => `<li>${s.name}: kill <b>${s.want === "app" ? "the api worker" : s.want === "etl" ? "etl.py" : "the postgres backend"}</b></li>`).join("")}</ul><p>Badness ≈ RSS as a share of RAM × 1000, plus oom_score_adj; -1000 means never kill.</p>`,
      ui: (I) => ({
        knobs: [{ k: "postgres", label: "postgres", opts: [0, -500, -1000, 500] }, { k: "etl", label: "etl.py", opts: [0, 500, 1000, -500] }, ...(I.lv >= 2 ? [{ k: "app", label: "api worker", opts: [0, 500, -500, -1000] }] : []), { k: "sshd", label: "sshd", opts: [-1000], fixed: -1000 }],
        init: { postgres: 0, etl: 0, app: 0, sshd: -1000 },
        live: (c) => K.table(["Scenario", "Victim", "Badness"], I.snaps.map((s) => { const v = oomVictim(s, c, I.T); const ok = v && v.k === s.want; return [esc(s.name), v ? `<span class="${ok ? "win" : "lose"}">${esc(v.name)}</span>` : '<span class="lose">nothing killable: panic</span>', v ? K.num(v.s) : "–"]; }), { compact: true }) + K.table(["Process", ...I.snaps.map((_, k) => "Score " + (k + 1))], I.snaps[0].procs.filter((p) => p.k !== "sshd").map((p) => [esc(p.name), ...I.snaps.map((s) => { const q = s.procs.find((x) => x.k === p.k); const a = c[p.k] || 0; return a <= -1000 ? "immune" : K.num((q.mb / I.T) * 1000 + a); })]), { compact: true }),
      }),
      valid: (I, c) => { for (const s of I.snaps) { const v = oomVictim(s, c, I.T); if (!v) return `in "${s.name}" nothing is killable`; if (v.k !== s.want) return `in "${s.name}" the kernel would kill ${v.name}`; } return true; },
      val: (I, c) => ["postgres", "etl", "app"].filter((k) => c[k] != null && c[k] !== 0).length,
      hint: (I) => I.lv === 1 ? "Postgres's RSS includes shared buffers, so it outscores the ETL. Lower one or raise the other." : I.lv === 2 ? "Making the ETL a lightning rod (+1000) also makes it the victim when something else leaks." : "Full immunity (-1000) means a runaway query takes everything else down with it.",
      concept: "oom_score_adj",
      how: "When the kernel must kill, it scores each process by memory footprint (RSS including shared pages, swap and page tables) relative to available memory, scaled to 0-1000, then adds oom_score_adj (-1000 to +1000). -1000 makes a process immune; +1000 makes it the first choice. systemd sets it with OOMScoreAdjust=, and children inherit it. Shared memory inflates the score of database processes, so they get killed for other processes' growth. Adjustments are relative: favouring one process to die makes it the victim in every scenario, including ones it didn't cause.",
      rule: "Protect critical processes with a moderate negative adjust (not -1000 unless you truly prefer a frozen host), cap batch jobs with their own memory cgroup, and test your settings against each failure you care about.",
      why: (I, sol) => `Setting ${["postgres", "etl", "app"].filter((k) => sol[k]).map((k) => `${k}=${sol[k]}`).join(", ") || "nothing"} makes each scenario pick its culprit: ${I.snaps.map((s) => `${s.name} → ${oomVictim(s, sol, I.T).name}`).join("; ")}.${I.lv >= 2 ? " Pushing the ETL to +1000 would have killed it in the api-leak scenario, and the leak would continue." : ""}${I.lv === 3 ? " -1000 on postgres would have made a runaway query kill everything else first." : ""}`,
    },
    /* ======================================================================== */
    {
      id: "linux-logrotate",
      name: "Rotate logs without losing lines",
      kind: "Config change",
      skills: ["design", "safe"],
      w: "tune",
      gen(lv, R) { return { lv, app: lv === 1 ? "nginx" : lv === 2 ? "legacy-billing" : "audit-writer", reopen: lv === 1, sig: lv === 1 ? "USR1" : "HUP", append: lv !== 3, noLoss: lv !== 2, size: R.int(8, 30) }; },
      text: (I) => `<p>Configure daily rotation for <code>/var/log/${I.app}/app.log</code> (~${I.size} GB/day). ${I.lv === 1 ? "nginx reopens its log files on <code>SIGUSR1</code>. Access logs feed billing, so <b>no lines may be lost</b>." : I.lv === 2 ? "This legacy Java app has no signal handler for reopening logs (a SIGHUP would kill it) and restarting it takes minutes. Losing a handful of lines at rotation is acceptable; filling the disk is not." : "This audit writer can't reopen its file, opens it <b>without O_APPEND</b>, and compliance requires <b>no lost lines</b>. A change to the app is possible if needed."}</p><p>Pick a rotation method that meets the requirements.</p>`,
      ui: (I) => ({
        knobs: [{ k: "method", label: "Method", opts: ["create + postrotate signal", "create (no signal)", "copytruncate", ...(I.lv === 3 ? ["log to stdout (journald), no file"] : [])] }, { k: "comp", label: "Compression", opts: ["compress", "compress + delaycompress"] }],
        init: { method: "create (no signal)", comp: "compress" },
        live: (c) => { const r = rotSim(I, c); const ok = rotOK(I, r); return K.metrics([{ name: "Lines lost", value: r.lost ? "some" : "none", ok: I.noLoss ? !r.lost : null }, { name: "Disk reclaimed", value: r.disk ? "yes" : "no", ok: r.disk }, { name: "App survives", value: r.crash ? "no" : "yes", ok: !r.crash }, { name: "File integrity", value: r.holes ? "NUL holes" : "ok", ok: !r.holes }]) + `<ul class="small">${r.notes.map((n) => `<li>${n}</li>`).join("")}</ul>` + K.verdict(ok === true, ok === true ? "Meets the requirements" : ok); },
      }),
      accept: (I, c) => { const ok = rotOK(I, rotSim(I, c)); return ok === true ? true : `With that config ${ok}.`; },
      solve: (I) => (I.lv === 1 ? { method: "create + postrotate signal", comp: "compress + delaycompress" } : I.lv === 2 ? { method: "copytruncate", comp: "compress + delaycompress" } : { method: "log to stdout (journald), no file", comp: "compress" }),
      bad: (I) => I.lv === 1 ? [{ method: "copytruncate", comp: "compress + delaycompress" }, { method: "create + postrotate signal", comp: "compress" }] : I.lv === 2 ? [{ method: "create + postrotate signal", comp: "compress + delaycompress" }, { method: "create (no signal)", comp: "compress" }] : [{ method: "copytruncate", comp: "compress + delaycompress" }, { method: "create + postrotate signal", comp: "compress + delaycompress" }],
      hint: (I) => I.lv === 1 ? "After the rename, nginx keeps writing to the renamed file until it handles the signal." : I.lv === 2 ? "If the app can't be told to reopen, the file it has open must stay the same file." : "copytruncate can't avoid its race, and without O_APPEND the writer continues at its old offset. Is a file the right interface at all?",
      concept: "Log rotation: create vs copytruncate",
      how: "logrotate's default renames app.log to app.log.1 and creates a new app.log; the writer keeps its file descriptor, so it continues writing to app.log.1 until told to reopen (postrotate sending USR1 to nginx, HUP to rsyslog). Because the signal is asynchronous, delaycompress keeps .1 uncompressed for one cycle so late writes aren't lost. copytruncate copies the file and truncates it in place, for apps that can't reopen; lines written between copy and truncate are lost, and a writer without O_APPEND keeps writing at its old offset, leaving a sparse file full of NUL bytes. Sending a signal the app doesn't handle usually kills it.",
      rule: "Prefer create + a reopen signal + delaycompress for apps that support it, copytruncate only where small loss is acceptable and the app uses O_APPEND, and for logs that must be complete, write to stdout/journald or let the app rotate its own files.",
      why: (I, sol) => I.lv === 1 ? "Rename, then USR1 makes nginx reopen app.log; delaycompress leaves app.log.1 alone until the next day, so lines written in the gap aren't compressed away." : I.lv === 2 ? "copytruncate keeps the app's file descriptor pointing at the same app.log (the app opens it with O_APPEND), at the cost of the few lines in the copy-to-truncate window. A HUP would have killed it, and create without a signal leaves it writing into deleted files." : "No file-based option meets 'no loss' for a writer that can't reopen and doesn't use O_APPEND. Writing to stdout and letting journald (or the container runtime) handle storage and rotation does.",
    },
    /* ======================================================================== */
    {
      id: "linux-graceful-shutdown",
      name: "Order a graceful shutdown",
      kind: "Design review",
      skills: ["design", "safe"],
      w: "steps",
      gen(lv, R) {
        const steps = lv === 1 ? [
          ["sig", "Receive SIGTERM"], ["close", "Stop accepting new connections (close the listener)"], ["drain", "Finish in-flight requests, up to a 20 s drain timeout"], ["pool", "Close the database pool and flush logs and metrics"], ["exit", "Exit with status 0"],
          ["T:exit", "Call os.Exit(0) inside the signal handler"], ["T:poolfirst", "Close the database pool, then wait for in-flight requests"], ["T:kill", "SIGKILL the worker threads so they stop quickly"],
        ] : [
          ...(lv === 3 ? [["grace", "Deploy-time: set terminationGracePeriodSeconds: 45"]] : []),
          ["term", "Pod marked Terminating; endpoints controller starts removing it from Services (asynchronously)"], ["pre", "preStop hook: sleep 10 s while load balancers and kube-proxy stop routing to the pod"], ["sig", "Container receives SIGTERM"], ["close", "Stop accepting new connections"],
          ...(lv === 3 ? [["drain", "Drain in-flight requests, up to 25 s"], ["T:drain15", "Drain in-flight requests, up to 15 s"]] : [["drain", "Drain in-flight requests, up to 15 s"]]),
          ["pool", "Close the database pool and flush telemetry (~2 s)"], ["exit", "Exit with status 0"],
          ["T:exit", "Exit immediately on SIGTERM; Kubernetes already stopped the traffic"], ["T:closefirst", "Close the listener as soon as the pod is marked Terminating, before the preStop sleep"], ["T:kill", "Let the kubelet's SIGKILL at the end of the grace period stop it"],
        ];
        const order = R.shuffle(steps.map((s, i) => i));
        return { lv, keys: order.map((i) => steps[i][0]), opts: order.map((i) => steps[i][1]), longest: lv === 3 ? R.int(20, 23) : null };
      },
      text: (I) => I.lv === 1 ? "<p>A service runs under systemd behind a load balancer. On deploy, systemd sends <code>SIGTERM</code> and, after <code>TimeoutStopSec=30</code>, <code>SIGKILL</code>. Requests take up to 5 s. Build the shutdown sequence the service should follow so no request is cut off.</p>" : `<p>A Kubernetes Deployment rolls a pod. Kubernetes runs the preStop hook, then sends SIGTERM; the whole thing must fit in <code>terminationGracePeriodSeconds</code> (default <b>30 s</b>), after which the kubelet sends SIGKILL. Endpoint removal propagates to load balancers asynchronously, over several seconds.${I.lv === 3 ? ` The slowest legitimate request (a report export) takes <b>${I.longest} s</b>.` : " Requests take up to 5 s."}</p><p>Build the termination sequence, in order, so no request fails.</p>`,
      ui: (I) => ({ opts: I.opts, live: (seq) => { if (!seq || !seq.length) return ""; const ks = seq.map((i) => I.keys[i]); if (I.lv === 1) return ""; let t = 0; const grace = ks.includes("grace") ? 45 : 30; const rows = []; ks.forEach((k) => { const d = k === "pre" ? 10 : k === "drain" ? (I.lv === 3 ? 25 : 15) : k === "T:drain15" ? 15 : k === "pool" ? 2 : 0; if (k !== "grace") { rows.push([`${t}s`, esc(I.opts[I.keys.indexOf(k)])]); t += d; } }); return K.table(["t", "step"], rows, { compact: true }) + K.verdict(t <= grace, `Worst case ${t} s of a ${grace} s grace period${t > grace ? ": the kubelet SIGKILLs the pod mid-drain" : ""}.`); } }),
      accept(I, seq) {
        const ks = seq.map((i) => I.keys[i]);
        const trap = ks.find((k) => k.startsWith("T:") && k !== "T:drain15");
        if (trap) return { "T:exit": "Exiting straight away cuts off every request still in flight.", "T:poolfirst": "In-flight requests still need the database; closing the pool first makes them fail.", "T:kill": "SIGKILL can't be handled: whatever those threads were doing is lost.", "T:closefirst": "Endpoint removal is asynchronous: for several seconds load balancers still send new connections, which would now be refused." }[trap];
        const need = I.lv === 1 ? ["sig", "close", "drain", "pool", "exit"] : I.lv === 2 ? ["term", "pre", "sig", "close", "drain", "pool", "exit"] : ["grace", "term", "pre", "sig", "close", "drain", "pool", "exit"];
        if (I.lv === 3 && ks.includes("T:drain15")) return `A 15 s drain cuts off the ${I.longest} s report exports. Drain long enough for the slowest request, and make sure the grace period covers preStop + drain + cleanup.`;
        const miss = need.filter((k) => !ks.includes(k));
        if (miss.length) return I.lv === 3 && miss.includes("grace") ? `preStop 10 s + drain 25 s + cleanup 2 s = 37 s, more than the default 30 s grace period: the kubelet would SIGKILL mid-drain.` : `Something essential is missing: ${esc(I.opts[I.keys.indexOf(miss[0])])}.`;
        for (let i = 1; i < need.length; i++) if (ks.indexOf(need[i - 1]) > ks.indexOf(need[i])) return `Order problem: "${esc(I.opts[I.keys.indexOf(need[i - 1])])}" has to happen before "${esc(I.opts[I.keys.indexOf(need[i])])}".`;
        return true;
      },
      solve: (I) => (I.lv === 1 ? ["sig", "close", "drain", "pool", "exit"] : I.lv === 2 ? ["term", "pre", "sig", "close", "drain", "pool", "exit"] : ["grace", "term", "pre", "sig", "close", "drain", "pool", "exit"]).map((k) => I.keys.indexOf(k)),
      bad: (I) => { const ix = (a) => a.map((k) => I.keys.indexOf(k)); return I.lv === 1 ? [ix(["sig", "T:exit"]), ix(["sig", "close", "pool", "drain", "exit"]), ix(["sig", "T:poolfirst", "close", "exit"])] : I.lv === 2 ? [ix(["term", "sig", "close", "drain", "pool", "exit"]), ix(["term", "T:closefirst", "pre", "sig", "drain", "pool", "exit"])] : [ix(["term", "pre", "sig", "close", "drain", "pool", "exit"]), ix(["grace", "term", "pre", "sig", "close", "T:drain15", "pool", "exit"])]; },
      hint: (I) => I.lv === 1 ? "Stop new work, finish old work, release resources, exit." : I.lv === 2 ? "Traffic keeps arriving for a few seconds after the pod is marked Terminating. What keeps the pod serving during that window?" : "Add up preStop, the drain and cleanup, and compare with the grace period.",
      concept: "Graceful shutdown",
      how: "Process managers stop services with SIGTERM and, after a timeout (systemd TimeoutStopSec, Kubernetes terminationGracePeriodSeconds, Docker's 10 s), SIGKILL. A graceful handler stops accepting new work, lets in-flight requests finish within a bounded drain, then releases dependencies like database pools and exits. In Kubernetes, removing a pod from Service endpoints and from load balancers happens in parallel with termination and takes seconds, so a preStop sleep keeps the pod serving while traffic is steered away. The grace period covers the preStop hook plus the SIGTERM handling, so it must exceed preStop + drain + cleanup.",
      rule: "Handle SIGTERM: stop accepting, drain with a deadline shorter than the kill timeout, then close dependencies and exit 0. In Kubernetes add a preStop sleep and size terminationGracePeriodSeconds for preStop + longest request + cleanup.",
      why: (I) => I.lv === 1 ? "Closing the listener first means no new request starts; draining before closing the pool lets in-flight requests finish their queries; everything completes well inside TimeoutStopSec=30." : I.lv === 2 ? "The preStop sleep covers the seconds in which load balancers still route to the pod; only then does SIGTERM start the drain. 10 + 15 + 2 s fits in the 30 s default." : `The ${I.longest} s exports need a 25 s drain; 10 + 25 + 2 = 37 s exceeds the default 30 s grace, so the Deployment must set terminationGracePeriodSeconds: 45 first.`,
    },
    /* ======================================================================== */
    {
      id: "linux-library-patch",
      name: "Patch OpenSSL and make it take effect",
      kind: "Change plan",
      skills: ["safe", "design"],
      w: "steps",
      gen(lv, R) {
        const steps = [
          ["inst", "Install the patched libssl package"], ["find", "Find processes still mapping the old, deleted library: lsof -n | grep 'DEL.*libssl' (or needrestart -r l)"], ["restart", "Restart those services one at a time, draining each from the load balancer"], ["verify", "Verify that no process still maps the deleted libssl"],
          ["T:auto", "Nothing more: running processes pick up the new library automatically"], ["T:rm", "Delete the old libssl.so file to force processes to reload it"], ["T:reboot", "Reboot every host in the fleet at the same time"],
          ...(lv >= 2 ? [["canary", "Patch one canary host first and watch error rates and TLS handshakes"], ["batch", "Roll out to the remaining hosts in batches of 10%"]] : []),
          ...(lv === 3 ? [["images", "Rebuild and redeploy container images: containers ship their own libssl and don't see the host's package"], ["static", "Find binaries that statically link or bundle their own OpenSSL (lsof won't show them) and rebuild those"]] : []),
        ];
        const order = R.shuffle(steps.map((s, i) => i));
        return { lv, keys: order.map((i) => steps[i][0]), opts: order.map((i) => steps[i][1]), cve: `CVE-2026-${R.int(10000, 49999)}` };
      },
      text: (I) => `<p>A critical OpenSSL vulnerability (${I.cve}) is being exploited. ${I.lv === 1 ? "You run one web host behind a load balancer pair." : I.lv === 2 ? "You run a fleet of 120 VMs behind load balancers; a bad patch fleet-wide would be its own outage." : "The fleet is 120 VMs, half of the services run in containers on those VMs, and a few teams ship Go and Rust binaries."}</p><p>Build the plan that actually gets every running process onto the patched library, safely.</p>`,
      ui: (I) => ({ opts: I.opts }),
      accept(I, seq) {
        const ks = seq.map((i) => I.keys[i]);
        const trap = ks.find((k) => k.startsWith("T:"));
        if (trap) return { "T:auto": "A running process keeps the old library mapped until it restarts; the vulnerable code is still in memory.", "T:rm": "The old file is already unlinked by the package upgrade; deleting files doesn't change what's mapped into running processes.", "T:reboot": "Rebooting the whole fleet at once is an outage, and if the patch is bad, it's everywhere." }[trap];
        const need = I.lv === 1 ? ["inst", "find", "restart", "verify"] : ["canary", "inst", "find", "restart", "verify", "batch"];
        const miss = need.filter((k) => !ks.includes(k));
        if (miss.length) return `Missing: ${esc(I.opts[I.keys.indexOf(miss[0])])}.`;
        for (let i = 1; i < need.length; i++) if (ks.indexOf(need[i - 1]) > ks.indexOf(need[i])) return `Order problem: "${esc(I.opts[I.keys.indexOf(need[i - 1])])}" should come before "${esc(I.opts[I.keys.indexOf(need[i])])}".`;
        if (I.lv === 3) { for (const k of ["images", "static"]) if (!ks.includes(k)) return k === "images" ? "Host packages don't reach containers: their images carry their own libssl." : "Statically linked and bundled copies of OpenSSL never show up in lsof or the package manager."; }
        return true;
      },
      solve: (I) => (I.lv === 1 ? ["inst", "find", "restart", "verify"] : I.lv === 2 ? ["canary", "inst", "find", "restart", "verify", "batch"] : ["canary", "inst", "find", "restart", "verify", "batch", "images", "static"]).map((k) => I.keys.indexOf(k)),
      bad: (I) => { const ix = (a) => a.map((k) => I.keys.indexOf(k)); return I.lv === 1 ? [ix(["inst", "T:auto"]), ix(["inst", "restart", "find", "verify"])] : I.lv === 2 ? [ix(["inst", "find", "restart", "verify"]), ix(["inst", "T:reboot"])] : [ix(["canary", "inst", "find", "restart", "verify", "batch"])]; },
      hint: (I) => I.lv === 1 ? "Upgrading a package replaces the file on disk. What about the copy already mapped into running processes?" : I.lv === 2 ? "Prove the patch on one host before trusting it on 120." : "Which copies of OpenSSL will lsof on the host and the package manager never see?",
      concept: "Making library updates take effect",
      how: "Shared libraries are mapped into each process at start. Upgrading the package unlinks the old file and installs a new one, but running processes keep the old (now deleted) mapping, so they stay vulnerable until restarted; lsof shows them as DEL entries and tools like needrestart list them. Containers carry their own copies in their images and need rebuilding, and statically linked or bundled copies (common in Go, Rust and some vendored runtimes) never show up in the host's package database. Fleet-wide changes go canary first, then in batches, with draining so restarts don't drop traffic.",
      rule: "A patch isn't applied until every process using the library has restarted: install, find holders (lsof DEL / needrestart), restart with draining, verify, and don't forget container images and bundled copies. Canary, then batches.",
      why: (I) => I.lv === 1 ? "After the upgrade, every TLS-serving process still had the deleted old libssl mapped. Restarting them one at a time behind the load balancer moved them to the patched copy without downtime, and the DEL check proves it." : I.lv === 2 ? "A canary host shows whether the patched library breaks handshakes or crashes services before 119 more hosts get it; batches limit the blast radius." : "Host patching covers only processes linked against the host's libssl. Containers must be rebuilt from patched base images, and statically linked or bundled OpenSSL must be found (SBOMs help) and rebuilt.",
    },
    /* ======================================================================== */
    {
      id: "linux-bash-pitfalls",
      name: "Review the shell script",
      kind: "Code review",
      skills: ["diagnose", "safe"],
      w: "lines",
      gen(lv, R) {
        const name = R.pick(["BUILD_ROOT", "STAGE_DIR", "WORK_DIR"]), db = R.pick(["orders", "ledger", "billing"]);
        let lines, bad;
        if (lv === 1) { lines = [["@", "@@ clean-build.sh (new file) @@"], ["+", "#!/bin/bash"], ["+", "# Clean the build workspace before each CI run"], ["+", `${name}=$(grep -s '^build_root=' /etc/ci/agent.conf | cut -d= -f2)`], ["+", `echo "Cleaning ${"$"}${name}"`], ["+", `rm -rf "${"$"}${name}"/*`], ["+", `mkdir -p "${"$"}${name}/cache"`], ["+", 'echo "workspace ready"']]; bad = [5]; }
        else if (lv === 2) { lines = [["@", "@@ backup.sh (new file) @@"], ["+", "#!/bin/bash"], ["+", "set -e"], ["+", 'CONFIG_SRC="/mnt/Config Share/app.yaml"'], ["+", '[[ -n "$1" ]] || { echo "usage: backup.sh <db>"; exit 2; }'], ["+", "cd /srv/backups || exit 1"], ["+", "cp $CONFIG_SRC /srv/backups/"], ["+", 'mysqldump --single-transaction "$1" | gzip > "/srv/backups/$1.sql.gz"'], ["+", 'echo "backup of $1 done"']]; bad = [6, 7]; }
        else { lines = [["@", "@@ migrate.sh (new file) @@"], ["+", "#!/usr/bin/env bash"], ["+", "set -euo pipefail"], ["+", "run_migration() {"], ["+", '  local out=$(psql -v ON_ERROR_STOP=1 -f "$1" 2>&1)'], ["+", '  echo "$out" >> /var/log/migrate.log'], ["+", "}"], ["+", "apply_all() {"], ["+", '  for f in "${MIGRATIONS[@]}"; do run_migration "$f"; done'], ["+", "}"], ["+", `MIGRATIONS=(/srv/${db}/migrations/*.sql)`], ["+", "if ! apply_all; then"], ["+", '  echo "migration failed" >&2; exit 1'], ["+", "fi"], ["+", 'echo "all migrations applied"']]; bad = [4, 11]; }
        return { lv, lines: lines.map(([k, t]) => ({ k, t })), bad, name, db };
      },
      text: (I) => `<p>Review this new script before it ships. ${I.lv === 1 ? "It runs as root on every CI agent." : I.lv === 2 ? "It runs nightly from cron; nobody reads its output unless it fails." : `It runs the ${I.db} schema migrations during deploys; the deploy must stop if any migration fails.`} Flag the <b>${I.bad.length}</b> line${I.bad.length > 1 ? "s" : ""} that can cause real damage or hide a failure.</p>`,
      ui: (I) => ({ lines: I.lines, k: I.bad.length, file: I.lv === 1 ? "clean-build.sh" : I.lv === 2 ? "backup.sh" : "migrate.sh" }),
      ans: (I) => I.bad,
      diag: (I) => I.lv === 1 ? "Think about what each line does if the config value is missing." : I.lv === 2 ? "Check word splitting and what set -e sees in a pipeline." : "set -e has two famous blind spots; both are here.",
      hint: (I) => I.lv === 1 ? "What does the rm line expand to when the variable is empty?" : I.lv === 2 ? "One line splits a path with a space into two arguments; one line can 'succeed' after its first command failed." : "Exit status of local x=$(cmd) is the status of 'local'. And errexit is disabled inside anything run as an if condition.",
      concept: "Shell scripting pitfalls",
      how: "An empty or unset variable in rm -rf \"$DIR\"/* expands to rm -rf /*; set -u (or ${DIR:?}) turns that into an error. Unquoted variables are split on whitespace and glob-expanded. In a pipeline the exit status is the last command's, so mysqldump | gzip 'succeeds' with an empty backup unless set -o pipefail is on. local var=$(cmd) returns the status of local, not cmd, so declare first and assign separately. set -e is ignored inside functions or commands run as the condition of if, while, && or ||, so a failure in the middle of apply_all doesn't stop it and only the last command's status counts.",
      rule: "Start scripts with set -euo pipefail, quote every expansion, guard destructive paths with ${VAR:?}, split local declarations from command substitutions, and don't rely on set -e inside functions called from conditions: check statuses explicitly.",
      why: (I) => I.lv === 1 ? `If agent.conf has no build_root line, ${I.name} is empty and rm -rf "$${I.name}"/* becomes rm -rf /* as root. Use set -u, \${${I.name}:?} or an explicit check.` : I.lv === 2 ? "cp $CONFIG_SRC splits '/mnt/Config Share/app.yaml' into two paths and fails (set -e then aborts before the backup). And without pipefail, a failed mysqldump still leaves a 'successful' 20-byte gzip: the backup is silently empty." : "local out=$(psql …) always returns 0, so a failed migration is logged and ignored; and because apply_all runs as an if condition, set -e is off inside it, so only the last migration's status decides. The deploy would continue after a failed migration.",
    },
    /* ======================================================================== */
    {
      id: "linux-container-signals",
      name: "Why does docker stop take 10 seconds?",
      kind: "Code review",
      skills: ["diagnose", "design"],
      w: "lines",
      gen(lv, R) {
        const img = R.pick(["eclipse-temurin:21-jre", "node:22-slim", "python:3.13-slim"]);
        let lines, bad;
        if (lv === 1) { lines = [["@", "@@ Dockerfile @@"], [" ", "FROM eclipse-temurin:21-jre"], [" ", "COPY app.jar /app/app.jar"], [" ", "COPY entrypoint.sh /entrypoint.sh"], [" ", 'ENTRYPOINT ["/entrypoint.sh"]'], ["@", "@@ entrypoint.sh @@"], [" ", "#!/bin/sh"], [" ", "set -e"], [" ", 'export JAVA_OPTS="-XX:MaxRAMPercentage=75"'], [" ", "/app/wait-for-db.sh"], [" ", 'java $JAVA_OPTS -jar /app/app.jar "$@"']]; bad = [10]; }
        else if (lv === 2) { lines = [["@", "@@ Dockerfile @@"], [" ", "FROM node:22-slim"], [" ", "WORKDIR /app"], [" ", "COPY . ."], [" ", "STOPSIGNAL SIGTERM"], [" ", "ENTRYPOINT /app/entrypoint.sh"], ["@", "@@ entrypoint.sh @@"], [" ", "#!/bin/sh"], [" ", "node /app/migrate.js"], [" ", "node /app/server.js"]]; bad = [5, 9]; }
        else { lines = [["@", "@@ Dockerfile @@"], [" ", "FROM node:22-slim"], [" ", "RUN apt-get update && apt-get install -y --no-install-recommends imagemagick"], [" ", "COPY . /app"], [" ", 'ENTRYPOINT ["node", "/app/server.js"]'], ["@", "@@ server.js (excerpt) @@"], [" ", 'const { exec } = require("node:child_process");'], [" ", "exec(`convert ${src} -resize 256x256 ${dst}`, done);"], [" ", 'process.on("SIGTERM", () => {'], [" ", '  console.log("shutting down");'], [" ", "  process.exit(0);"], [" ", "});"]]; bad = [4, 10]; }
        return { lv, img, lines: lines.map(([k, t]) => ({ k, t })), bad };
      },
      text: (I) => `<p>${I.lv === 3 ? "This image runs a thumbnail API. Pods accumulate <code>&lt;defunct&gt;</code> processes, and every rollout produces a burst of 502s." : "<code>docker stop</code> on this container always takes the full 10 seconds and then the app is killed with SIGKILL, mid-request."} Flag the <b>${I.bad.length}</b> line${I.bad.length > 1 ? "s" : ""} responsible.</p>`,
      ui: (I) => ({ lines: I.lines, k: I.bad.length }),
      ans: (I) => I.bad,
      diag: () => "Ask, for each line: which process ends up as PID 1, and does it pass SIGTERM on?",
      hint: (I) => I.lv === 1 ? "The script stays PID 1 while java runs as its child. What does PID 1 do with a signal it has no handler for?" : I.lv === 2 ? "Docker's shell-form ENTRYPOINT runs your command under /bin/sh -c. And the script itself has the same problem as a classic entrypoint bug." : "Who reaps the orphaned children of the shells that exec() starts? And what does the SIGTERM handler do with in-flight requests?",
      concept: "PID 1 and signals in containers",
      how: "The first process in a container is PID 1, and the kernel doesn't apply default signal actions to PID 1: a SIGTERM it has no handler for is ignored, so docker stop waits its timeout and sends SIGKILL. A shell script that runs the app as a child stays PID 1 and doesn't forward signals; ending it with exec replaces the shell with the app. Docker's shell-form ENTRYPOINT (no JSON array) wraps the command in /bin/sh -c, which also blocks signals and ignores CMD arguments. PID 1 must also reap orphaned processes; most apps don't, so a tiny init (tini, dumb-init, docker run --init) is the usual fix. A SIGTERM handler that calls exit immediately drops in-flight requests.",
      rule: "Use exec-form ENTRYPOINT, end wrapper scripts with exec, run an init like tini when the app spawns processes, and handle SIGTERM by draining before exiting.",
      why: (I) => I.lv === 1 ? "entrypoint.sh stays PID 1 and starts java as a child; PID 1 without a handler ignores SIGTERM, and the shell doesn't forward it. exec java … makes java PID 1 so it receives the signal." : I.lv === 2 ? "ENTRYPOINT /app/entrypoint.sh (shell form) runs under /bin/sh -c, and the script then runs node as a child rather than exec-ing it: two layers of shell, neither forwarding SIGTERM. Use ENTRYPOINT [\"/app/entrypoint.sh\"] and exec node /app/server.js." : "node is PID 1 with no init: exec() runs convert through /bin/sh -c, and orphaned processes re-parented to PID 1 are never reaped (zombies). Use tini (ENTRYPOINT [\"tini\", \"--\", \"node\", …] or --init). The SIGTERM handler exits at once, killing in-flight requests: call server.close() and exit when it finishes.",
    },
    /* ======================================================================== */
    {
      id: "linux-cron-pitfalls",
      name: "The cron job that works by hand",
      kind: "Code review",
      skills: ["diagnose"],
      w: "lines",
      gen(lv, R) {
        let lines, bad, log;
        const h = R.int(1, 4);
        if (lv === 1) { lines = [["@", "@@ crontab -l (user deploy) @@"], [" ", "SHELL=/bin/bash"], [" ", "MAILTO=ops-alerts@corp.internal"], [" ", "# m h dom mon dow command"], [" ", "*/10 * * * * /usr/bin/flock -n /run/lock/sync.lock /opt/sync/sync.sh"], [" ", `0 ${h} * * * /opt/backup/push-to-bucket.sh`], [" ", "30 4 * * 0 /opt/maintenance/vacuum.sh >> /var/log/vacuum.log 2>&1"]]; bad = [5]; log = `push-to-bucket.sh: line 12: objctl: command not found\n$ which objctl\n/usr/local/bin/objctl`; }
        else if (lv === 2) { lines = [["@", "@@ /etc/cron.d/reports @@"], [" ", "SHELL=/bin/sh"], [" ", "PATH=/usr/local/bin:/usr/bin:/bin"], [" ", "*/5 * * * * reports /opt/reports/sync-ledger.sh"], [" ", "15 * * * * reports /usr/bin/flock -n /run/lock/hourly.lock /opt/reports/hourly.sh"], [" ", `0 ${h + 5} * * * reports /opt/reports/daily.sh > /var/log/reports/daily-$(date +%F).log 2>&1`]]; bad = [3, 5]; log = `CRON[4121]: (reports) CMD (/opt/reports/sync-ledger.sh)\nCRON[4188]: (reports) CMD (/opt/reports/sync-ledger.sh)   <- the 03:00 run is still going (runs take ~7 min)\nsync-ledger: duplicate key value violates unique constraint "ledger_entries_pkey"\nCRON[5012]: (reports) CMD (/opt/reports/daily.sh > /var/log/reports/daily-$(date +)\n/bin/sh: 1: Syntax error: end of file unexpected (expecting ")")`; }
        else { lines = [["@", "@@ $ ls /etc/cron.d @@"], [" ", "e2scrub_all"], [" ", "db-backup.cron"], [" ", "metrics"], [" ", "php"], ["@", "@@ $ cat /etc/cron.d/metrics @@"], [" ", "SHELL=/bin/sh"], [" ", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], [" ", "* * * * * /usr/local/bin/push-metrics.sh >/dev/null 2>&1"], [" ", "17 * * * * root /usr/bin/flock -n /run/lock/rollup.lock /usr/local/bin/rollup.sh"]]; bad = [2, 8]; log = `cron[612]: Error: bad username; while reading /etc/cron.d/metrics\n(and nothing at all about db-backup.cron, which has a valid 'root' line inside)`; }
        return { lv, lines: lines.map(([k, t]) => ({ k, t })), bad, log, host: `${R.pick(["ops", "batch", "util"])}-${R.int(1, 9)}` };
      },
      text: (I) => `<p>${I.lv === 3 ? "Two jobs on" : "Jobs on"} <code>${I.host}</code> ${I.lv === 1 ? "work when run by hand but fail from cron" : I.lv === 2 ? "misbehave from cron" : "never run at all"}. Evidence from the logs:</p>${K.pre(I.log)}<p>Flag the <b>${I.bad.length}</b> line${I.bad.length > 1 ? "s" : ""} at fault.</p>`,
      ui: (I) => ({ lines: I.lines, k: I.bad.length }),
      ans: (I) => I.bad,
      diag: (I) => I.lv === 3 ? "Debian's cron is strict about file names in /etc/cron.d and about the format of lines there." : "Match each log line to a job.",
      hint: (I) => I.lv === 1 ? "cron's default PATH is /usr/bin:/bin. Where does the missing command live?" : I.lv === 2 ? "Overlapping runs, and a character that crontab treats specially in the command field." : "One file is ignored because of its name; one line is missing a field that system crontabs require.",
      concept: "Cron's environment and syntax",
      how: "cron runs jobs with a minimal environment: PATH=/usr/bin:/bin, no login profile, and SHELL=/bin/sh unless set. An unescaped % in the command field ends the command (the rest becomes stdin), so $(date +%F) must be written \\%F. cron happily starts a new run while the previous one is still going; wrap long jobs in flock -n. Lines in /etc/crontab and /etc/cron.d need a user field before the command, and Debian/Ubuntu cron ignores files in /etc/cron.d whose names contain a dot (they must match run-parts naming).",
      rule: "Set PATH (or use absolute paths) in crontabs, escape %, wrap anything that can overrun in flock -n, include the user field in system crontabs, name cron.d files without dots, and send job output somewhere you'll see it.",
      why: (I) => I.lv === 1 ? "push-to-bucket.sh calls objctl, which lives in /usr/local/bin, not in cron's default PATH (/usr/bin:/bin). Add PATH= to the crontab or use the absolute path." : I.lv === 2 ? "sync-ledger.sh runs every 5 minutes but takes ~7, so runs overlap and insert duplicates: wrap it in flock -n like the hourly job. The daily job's $(date +%F) is cut at the % (the log shows the command ending at 'date +'), so the shell sees an unterminated $( ... ). Escape it as \\%F." : "db-backup.cron is silently ignored because the file name contains a dot. And the metrics line has no user field, so cron reads '/usr/local/bin/push-metrics.sh' as the user name: 'bad username'.",
    },
    /* ======================================================================== */
    {
      id: "linux-unit-hardening",
      name: "Bind port 443 without root",
      kind: "Hardening",
      skills: ["safe", "design"],
      w: "lines",
      gen(lv, R) {
        const svc = R.pick(["web", "edge", "portal"]);
        let lines, bad;
        if (lv === 1) { lines = [["@", `@@ ${svc}.service @@`], [" ", "[Service]"], ["-", `User=${svc}`], ["+", "# binding :443 needs root"], ["+", "User=root"], [" ", `ExecStart=/opt/${svc}/bin/${svc} --listen :443`], [" ", "NoNewPrivileges=yes"], [" ", "ProtectSystem=strict"], [" ", `StateDirectory=${svc}`]]; bad = [4]; }
        else if (lv === 2) { lines = [["@", `@@ ${svc}.service @@`], [" ", "[Service]"], [" ", `User=${svc}`], ["+", "ExecStartPre=+/usr/sbin/setcap cap_net_bind_service=+ep /usr/bin/python3.12"], ["+", "AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_SYS_ADMIN"], ["-", `ExecStart=/usr/bin/python3.12 /opt/${svc}/server.py --port 8443`], ["+", `ExecStart=/usr/bin/python3.12 /opt/${svc}/server.py --port 443`], [" ", "NoNewPrivileges=yes"], [" ", "ProtectSystem=strict"], [" ", "PrivateTmp=yes"]]; bad = [3, 4]; }
        else { lines = [["@", `@@ ${svc}.service @@`], [" ", "[Service]"], [" ", `User=${svc}`], [" ", "AmbientCapabilities=CAP_NET_BIND_SERVICE"], [" ", "CapabilityBoundingSet=CAP_NET_BIND_SERVICE"], [" ", "NoNewPrivileges=yes"], [" ", "ProtectSystem=strict"], ["+", "ReadWritePaths=/"], ["+", `ExecStartPre=+/bin/chmod u+s /opt/${svc}/bin/${svc}-helper`], ["+", "PrivateTmp=yes"], ["+", `StateDirectory=${svc}`], [" ", `ExecStart=/opt/${svc}/bin/${svc} --listen :443`]]; bad = [7, 8]; }
        return { lv, svc, lines: lines.map(([k, t]) => ({ k, t })), bad };
      },
      text: (I) => `<p>A pull request changes the systemd unit of <code>${I.svc}</code> so it can serve on port 443 directly. ${I.lv === 3 ? "It also adds a helper that needs to write a cache file." : ""} Flag the <b>${I.bad.length}</b> line${I.bad.length > 1 ? "s" : ""} that grant far more privilege than needed.</p>`,
      ui: (I) => ({ lines: I.lines, k: I.bad.length, file: `/etc/systemd/system/${I.svc}.service` }),
      ans: (I) => I.bad,
      diag: () => "Binding a port below 1024 needs exactly one capability. Which lines hand out more than that, to more than this service?",
      hint: (I) => I.lv === 1 ? "Ports below 1024 need CAP_NET_BIND_SERVICE, not full root." : I.lv === 2 ? "A file capability on an interpreter applies to every script anyone runs with it. And one capability in the list is close to root." : "One line undoes ProtectSystem; one creates a setuid binary.",
      concept: "Capabilities instead of root",
      how: "Linux splits root's powers into capabilities. Binding ports below 1024 needs only CAP_NET_BIND_SERVICE, which systemd can give a non-root service with AmbientCapabilities= (and restrict everything else with CapabilityBoundingSet=). File capabilities (setcap) attach to a binary for everyone who runs it, so setting one on python3 grants it to every Python script on the host. CAP_SYS_ADMIN is nearly equivalent to root. A setuid-root binary runs as root for any user who executes it. ProtectSystem=strict makes the filesystem read-only for the service; ReadWritePaths=/ cancels that.",
      rule: "Run services as a dedicated user with exactly the capabilities they need (AmbientCapabilities + CapabilityBoundingSet), never setcap an interpreter or add setuid bits, and grant write access to specific paths (StateDirectory=, ReadWritePaths=/var/lib/x).",
      why: (I) => I.lv === 1 ? `User=root gives ${I.svc} every privilege to bind one port. Keep User=${I.svc} and add AmbientCapabilities=CAP_NET_BIND_SERVICE.` : I.lv === 2 ? "setcap on /usr/bin/python3.12 lets every Python program on the host bind low ports (and runs as root on each start via '+'), and CAP_SYS_ADMIN is effectively root. AmbientCapabilities=CAP_NET_BIND_SERVICE alone is enough." : `ReadWritePaths=/ makes the whole filesystem writable again, cancelling ProtectSystem=strict; the helper only needs StateDirectory=${I.svc} (already added). chmod u+s makes the helper setuid root for any local user.`,
    },
    // @@more@@
    // @@more@@
  ]);
})();
