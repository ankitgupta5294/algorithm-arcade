/* Systems Lab · Concurrency & performance (part 1): profiling, races, deadlocks, event loops, queueing. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const rng = (s) => D.campaign.rng(s);

  /* ---------- queueing helpers ---------- */
  // p99 of the queueing delay in an M/M/c queue (ms if mu is per ms): P(W > t) = pw * exp(-(c*mu - lambda) t)
  const wait99 = (lam, mu, c) => { const x = K.mmc(lam, mu, c); if (x.rho >= 1) return Infinity; return x.pw <= 0.01 ? 0 : Math.log(x.pw / 0.01) / (c * mu - lam); };
  const fin = (x) => Number.isFinite(x);
  const msOr = (x) => (fin(x) ? K.ms(x) : "∞ (queue grows)");

  /* ---------- flame graphs ----------
     A tree node is [name, selfSamples, [children]]. Rendered bottom-up like flamegraph.pl; frames carry <title> tooltips. */
  const ftot = (n) => n[1] + (n[2] || []).reduce((s, c) => s + ftot(c), 0);
  function flameSVG(tree, o = {}) {
    const hl = new Set(o.hl || []);
    const fr = []; let depth = 0;
    const total = ftot(tree);
    const go = (n, x, d) => { const t = ftot(n); fr.push({ n: n[0], x, t, d }); depth = Math.max(depth, d); let cx = x; (n[2] || []).forEach((c) => { go(c, cx, d + 1); cx += ftot(c); }); };
    go(tree, 0, 0);
    const W = 640, rh = 17, H = (depth + 1) * rh + 2;
    const body = fr.map((f) => {
      const x = (f.x / total) * W, w = Math.max(0.6, (f.t / total) * W - 0.6), y = H - (f.d + 1) * rh;
      const h = K.hash(f.n), on = hl.has(f.n);
      const fill = on ? "#c264fe" : `hsl(${6 + (h % 44)}, ${72 + (h % 18)}%, ${57 + ((h >> 4) % 14)}%)`;
      const maxc = Math.floor((w - 6) / 6.3);
      const lab = maxc >= 3 ? (f.n.length > maxc ? f.n.slice(0, maxc - 2) + ".." : f.n) : "";
      return `<g><title>${esc(f.n)}: ${K.pct(f.t / total)} of samples</title><rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${rh - 1}" rx="2" fill="${fill}"${on ? ' stroke="#111" stroke-width="1.5"' : ""}/>${lab ? `<text x="${(x + 3).toFixed(1)}" y="${y + 12}" font-size="10.5" font-family="ui-monospace, Menlo, monospace" fill="#1b1b1b">${esc(lab)}</text>` : ""}</g>`;
    }).join("");
    return `<figure class="lab-chart">${o.title ? `<figcaption>${esc(o.title)}</figcaption>` : ""}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title || "Flame graph")}">${body}</svg></figure>`;
  }
  // per-function sums across every stack it appears in
  const selfBy = (tree, m = {}) => { m[tree[0]] = (m[tree[0]] || 0) + tree[1]; (tree[2] || []).forEach((c) => selfBy(c, m)); return m; };
  const totBy = (tree, m = {}) => { m[tree[0]] = (m[tree[0]] || 0) + ftot(tree); (tree[2] || []).forEach((c) => totBy(c, m)); return m; };
  const names = (tree, s = new Set()) => { s.add(tree[0]); (tree[2] || []).forEach((c) => names(c, s)); return s; };

  /* ---------- the hot-path flame graphs, one per level ---------- */
  function hotTree(I) {
    const R = rng(I.seed);
    if (I.lv === 1) {
      const leaves = ["jwt.verify", "Parser.parseDataRow", "JSON.stringify", "RegExp.exec"];
      const s = leaves.map((l) => (l === I.hot ? R.int(300, 380) : R.int(25, 70)));
      const tree = ["(root)", 0, [
        ["processTicksAndRejections", 6, [["handleOrders", 14, [
          ["authenticate", 6, [["jwt.verify", s[0]]]],
          ["loadOrders", 9, [["pg.Client.query", 12, [["Parser.parseDataRow", s[1]]]]]],
          ["renderOrders", 8, [["JSON.stringify", s[2]]]],
          ["validateBody", 5, [["RegExp.exec", s[3]]]],
        ]]]],
        ["(garbage collector)", R.int(40, 70)],
        ["(program)", R.int(15, 30)],
      ]];
      return tree;
    }
    if (I.lv === 2) {
      const spread = I.hot, single = "PriceCalculator.applyRules";
      const j = [R.int(95, 120), R.int(95, 120), R.int(95, 120)];
      const big = Math.min(j[0] + j[1] + j[2] - R.int(70, 110), Math.max(...j) + R.int(90, 130));
      return ["all", 0, [
        ["SocketProcessor.doRun", 4, [["DispatcherServlet.doDispatch", 6, [
          ["OrderController.list", 5, [["OrderRepository.findAll", R.int(40, 60)], [spread, j[0]]]],
          ["CartController.get", 4, [[single, big], [spread, j[1]]]],
          ["SearchController.query", 6, [["SearchClient.execute", R.int(40, 60)], [spread, j[2]]]],
        ]]]],
        ["GCTaskThread::run", R.int(50, 80)],
        ["CompileBroker::compiler_thread_loop", R.int(20, 35)],
      ]];
    }
    const a1 = R.int(170, 220), b1 = R.int(50, 70);
    const [search, index] = I.hot === "main.buildResults" ? [a1, b1] : [b1, a1];
    return ["total", 0, [
      ["net/http.(*conn).serve", 4, [["main.(*Server).ServeHTTP", 3, [
        ["main.handleSearch", 5, [["main.buildResults", 8, [["runtime.mallocgc", search], ["runtime.growslice", R.int(20, 30)]]], ["main.scoreDocs", R.int(140, 165)]]],
        ["main.handleIndex", 4, [["encoding/json.Marshal", 9, [["runtime.mallocgc", index]]]]],
        ["main.handleHealth", 3],
      ]]]],
      ["runtime.gcBgMarkWorker", 3, [["runtime.gcDrain", 8, [["runtime.scanobject", R.int(230, 270)], ["runtime.greyobject", R.int(25, 40)]]]]],
    ]];
  }
  const LANG = ["Node.js", "JVM", "Go"];

  /* ---------- wall-clock vs CPU profiles ---------- */
  function wallTrees(I) {
    const R = rng(I.seed);
    const C = I.culprit, waitLeaf = C === "InventoryClient.reserve" ? "SocketInputStream.socketRead0" : "Unsafe.park";
    if (I.lv === 1) {
      const cpu = ["all", 0, [["SocketProcessor.doRun", 5, [["OrderController.create", 6, [["OrderService.price", R.int(110, 140)], [C, 4, [[waitLeaf, 3]]], ["ObjectMapper.writeValueAsString", R.int(150, 190)]]]]], ["GCTaskThread::run", R.int(35, 50)]]];
      const wall = ["all", 0, [["SocketProcessor.doRun", 8, [["OrderController.create", 10, [["OrderService.price", R.int(60, 80)], [C, 6, [[waitLeaf, R.int(560, 640)]]], ["ObjectMapper.writeValueAsString", R.int(70, 90)]]]]]]];
      return { cpu, wall };
    }
    if (I.lv === 2) {
      const cpu = ["all", 0, [["SocketProcessor.doRun", 5, [["OrderController.create", 6, [["OrderService.price", R.int(110, 140)], [C, 4, [[waitLeaf, 3]]], ["ObjectMapper.writeValueAsString", R.int(150, 190)]]]]], ["GCTaskThread::run", R.int(35, 50)]]];
      const wall = ["all", 0, [
        ["ThreadPoolExecutor.getTask", 3, [["LinkedBlockingQueue.take", 4, [["Unsafe.park", R.int(700, 800)]]]]],
        ["SocketProcessor.doRun", 6, [["OrderController.create", 8, [["OrderService.price", R.int(50, 70)], [C, 5, [[waitLeaf, R.int(300, 360)]]], ["ObjectMapper.writeValueAsString", R.int(60, 80)]]]]],
        ["NioEndpoint$Poller.run", 2, [["EPoll.wait", R.int(120, 160)]]],
      ]];
      return { cpu, wall };
    }
    const m = [R.int(150, 175), R.int(150, 175)], pq = Math.max(m[0], m[1]) + R.int(50, 80);
    const cpu = ["all", 0, [["SocketProcessor.doRun", 5, [
      ["OrderController.create", 6, [["MetricsRegistry.record", 6, [["Unsafe.park", 2]]], ["PricingClient.quote", 5, [["SocketInputStream.socketRead0", 2]]], ["ObjectMapper.writeValueAsString", R.int(140, 170)]]],
      ["CartController.update", 6, [["MetricsRegistry.record", 5, [["Unsafe.park", 2]]], ["CartService.merge", R.int(120, 150)]]],
    ]], ["GCTaskThread::run", R.int(35, 50)]]];
    const wall = ["all", 0, [
      ["ThreadPoolExecutor.getTask", 3, [["LinkedBlockingQueue.take", 4, [["Unsafe.park", R.int(600, 700)]]]]],
      ["SocketProcessor.doRun", 6, [
        ["OrderController.create", 6, [["MetricsRegistry.record", 4, [["ReentrantLock.lock", 3, [["Unsafe.park", m[0]]]]]], ["PricingClient.quote", 4, [["SocketInputStream.socketRead0", pq]]], ["ObjectMapper.writeValueAsString", R.int(50, 70)]]],
        ["CartController.update", 6, [["MetricsRegistry.record", 4, [["ReentrantLock.lock", 3, [["Unsafe.park", m[1]]]]]], ["CartService.merge", R.int(40, 60)]]],
      ]],
    ]];
    return { cpu, wall };
  }

  /* ---------- JVM triage terminal: CPU-bound vs lock contention vs GC thrash ---------- */
  const CAUSES = ["CPU-bound: a hot code path saturates the cores", "Lock contention: request threads queue on one monitor", "GC thrashing: the old generation is full and the JVM collects back-to-back", "Slow downstream: threads wait on network I/O", "Thread pool too small for the load"];
  function jvmShell(I) {
    const P = I.pid, cause = I.cause;
    const top = () => {
      const head = cause === 1 ? "%Cpu(s): 10.4 us,  2.2 sy,  0.0 ni, 86.9 id,  0.1 wa,  0.0 hi,  0.4 si,  0.0 st" : cause === 0 ? "%Cpu(s): 93.8 us,  4.1 sy,  0.0 ni,  1.6 id,  0.0 wa,  0.0 hi,  0.5 si,  0.0 st" : "%Cpu(s): 96.2 us,  2.9 sy,  0.0 ni,  0.6 id,  0.0 wa,  0.0 hi,  0.3 si,  0.0 st";
      const rows = [["PID", "USER", "PR", "NI", "VIRT", "RES", "S", "%CPU", "%MEM", "TIME+", "COMMAND"]];
      const R = rng(I.seed + "/top");
      for (let k = 0; k < 8; k++) {
        const tid = P + 31 + k * 3;
        if (cause === 0) rows.push([tid, "app", 20, 0, "14.2g", "6.1g", "R", (88 + R.int(0, 110) / 10).toFixed(1), "19.4", `41:${String(10 + k).padStart(2, "0")}.17`, "http-nio-8080-e"]);
        else if (cause === 1) rows.push([tid, "app", 20, 0, "14.2g", "6.1g", k === 0 ? "S" : "S", k === 0 ? "6.3" : (R.int(0, 9) / 10).toFixed(1), "19.4", `3:${String(10 + k).padStart(2, "0")}.02`, k === 0 ? "price-refresh" : "http-nio-8080-e"]);
        else rows.push([tid, "app", 20, 0, "14.2g", "13.9g", "R", (91 + R.int(0, 80) / 10).toFixed(1), "44.1", `88:${String(10 + k).padStart(2, "0")}.51`, k < 7 ? `GC Thread#${k}` : "G1 Conc#0"]);
      }
      return `top - 09:41:07 up 12 days,  3:02,  1 user,  load average: ${cause === 1 ? "1.84, 1.91, 2.02" : "17.92, 17.40, 16.88"}\nThreads: 214 total, ${cause === 1 ? 2 : 16} running, ${cause === 1 ? 212 : 198} sleeping\n${head}\nMiB Mem :  32112.4 total,   1841.2 free,  ${cause === 2 ? "29870.1" : "17406.3"} used\n\n` + K.cols(rows, 2);
    };
    const lockAddr = "0x00000006c1a2b3c8";
    const th = (name, n, state, frames, extra = "") => `"${name}" #${n} [${P + n}] daemon prio=5 os_prio=0 cpu=${(n * 731.4).toFixed(2)}ms elapsed=3612.40s tid=0x00007f2c3c0${(1000 + n).toString(16)}00 nid=${P + n} ${extra}\n   java.lang.Thread.State: ${state}\n${frames.map((f) => "\t" + f).join("\n")}\n`;
    const dump = () => {
      const h = `2026-10-11 09:41:12\nFull thread dump OpenJDK 64-Bit Server VM (21.0.4+7-LTS mixed mode, sharing):\n\n`;
      if (cause === 0) return h + [41, 44, 47].map((n) => th(`http-nio-8080-exec-${n - 30}`, n, "RUNNABLE", ["at java.util.regex.Pattern$Loop.match(java.base@21.0.4/Pattern.java:4846)", "at java.util.regex.Pattern$GroupTail.match(java.base@21.0.4/Pattern.java:4806)", "at java.util.regex.Matcher.matches(java.base@21.0.4/Matcher.java:729)", `at com.${I.co}.orders.SkuValidator.validate(SkuValidator.java:41)`, `at com.${I.co}.orders.OrderController.create(OrderController.java:88)`], "runnable  [0x00007f2bf91fe000]")).join("\n") + `\n... 211 more threads (RUNNABLE 58, WAITING 131, TIMED_WAITING 22)`;
      if (cause === 1) return h + th("price-refresh", 38, "RUNNABLE", ["at sun.nio.ch.SocketDispatcher.read0(java.base@21.0.4/Native Method)", "at sun.nio.ch.NioSocketImpl.read(java.base@21.0.4/NioSocketImpl.java:331)", `at com.${I.co}.pricing.PriceClient.fetchAll(PriceClient.java:73)`, `at com.${I.co}.orders.PriceCache.refresh(PriceCache.java:44)`, `- locked <${lockAddr}> (a com.${I.co}.orders.PriceCache)`], "runnable  [0x00007f2bf8efd000]") + "\n" + [41, 44, 47].map((n) => th(`http-nio-8080-exec-${n - 30}`, n, "BLOCKED (on object monitor)", [`at com.${I.co}.orders.PriceCache.get(PriceCache.java:57)`, `- waiting to lock <${lockAddr}> (a com.${I.co}.orders.PriceCache)`, `at com.${I.co}.orders.OrderService.quote(OrderService.java:112)`], "waiting for monitor entry  [0x00007f2bf91fe000]")).join("\n") + `\n... 210 more threads (BLOCKED 196, WAITING 9, TIMED_WAITING 5)`;
      return h + [41, 44, 47].map((n, k) => th(`http-nio-8080-exec-${n - 30}`, n, "RUNNABLE", [["at java.util.Arrays.copyOf(java.base@21.0.4/Arrays.java:3540)", "at java.util.ArrayList.grow(java.base@21.0.4/ArrayList.java:237)"][k % 2] || "at java.lang.StringLatin1.newString(java.base@21.0.4/StringLatin1.java:769)", `at com.${I.co}.reports.ExportService.rows(ExportService.java:${90 + k * 7})`, `at com.${I.co}.reports.ExportController.csv(ExportController.java:52)`], "runnable  [0x00007f2bf91fe000]")).join("\n") + "\n" + th("logback-appender", 52, "BLOCKED (on object monitor)", ["at ch.qos.logback.core.OutputStreamAppender.writeBytes(OutputStreamAppender.java:203)", "- waiting to lock <0x00000006c0f1a7e0> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)"], "waiting for monitor entry  [0x00007f2bf7cfa000]") + `\n... 210 more threads (RUNNABLE 64, BLOCKED 3, WAITING 121, TIMED_WAITING 22)`;
    };
    const states = () => cause === 0 ? [["  121", "java.lang.Thread.State: WAITING (parking)"], ["   61", "java.lang.Thread.State: RUNNABLE"], ["   22", "java.lang.Thread.State: TIMED_WAITING (sleeping)"]] : cause === 1 ? [["  199", "java.lang.Thread.State: BLOCKED (on object monitor)"], ["    9", "java.lang.Thread.State: WAITING (parking)"], ["    5", "java.lang.Thread.State: TIMED_WAITING (parking)"], ["    1", "java.lang.Thread.State: RUNNABLE"]] : [["  121", "java.lang.Thread.State: WAITING (parking)"], ["   67", "java.lang.Thread.State: RUNNABLE"], ["   22", "java.lang.Thread.State: TIMED_WAITING (sleeping)"], ["    4", "java.lang.Thread.State: BLOCKED (on object monitor)"]];
    const jstat = () => {
      const rows = [["S0", "S1", "E", "O", "M", "CCS", "YGC", "YGCT", "FGC", "FGCT", "CGC", "CGCT", "GCT"]];
      for (let k = 0; k < 5; k++) {
        if (cause === 2) rows.push(["0.00", "0.00", "100.00", (99.6 + (k % 3) / 10).toFixed(2), "97.12", "93.40", 18211, "312.554", 1408 + k, (2911.2 + k * 0.94).toFixed(3), 2210, "41.207", (3265.0 + k * 0.94).toFixed(3)]);
        else rows.push(["0.00", "100.00", (12 + k * 17).toFixed(2), "46.31", "97.12", "93.40", 9120 + Math.floor(k / 3), "51.204", 0, "0.000", 112, "3.118", (54.32 + Math.floor(k / 3) * 0.01).toFixed(3)]);
      }
      return K.cols(rows, 2);
    };
    const vmstat = () => {
      const rows = [["r", "b", "swpd", "free", "buff", "cache", "si", "so", "bi", "bo", "in", "cs", "us", "sy", "id", "wa", "st"]];
      for (let k = 0; k < 5; k++) rows.push(cause === 1 ? [1 + (k % 2), 0, 0, 1885120, 210112, 9921800, 0, 0, 0, 24, 8122, 61200 + k * 913, 10, 2, 88, 0, 0] : [17 + (k % 3), 0, 0, cause === 2 ? 118240 : 1885120, 210112, 9921800, 0, 0, 0, 31, 21011, 14100 + k * 211, cause === 2 ? 96 : 94, cause === 2 ? 3 : 4, 1, 0, 0]);
      return "procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n" + K.cols(rows, 1);
    };
    const look = (st, k) => { st.seen[k] = true; };
    const sh = K.shell([
      { re: /^top(?: -H)?(?: -p (\d+))?(?: -b)?(?: -n \d+)?$/, use: "top -H -p <pid>", desc: "per-thread CPU", run: (m, st) => { look(st, "top"); return top(); } },
      { re: /^jstack(?: -l)? (\d+) \| grep (?:-c )?["']?java\.lang\.Thread\.State["']? \| sort \| uniq -c(?: \| sort -rn)?$/, use: "jstack <pid> | grep 'java.lang.Thread.State' | sort | uniq -c", desc: "count threads by state", run: (m, st) => { if (+m[1] !== P) return `${m[1]}: no such process`; look(st, "jstack"); return K.cols(states(), 1); } },
      { re: /^jstack(?: -l)? (\d+)$/, use: "jstack <pid>", desc: "thread dump", run: (m, st) => { if (+m[1] !== P) return `${m[1]}: no such process`; look(st, "jstack"); return dump(); } },
      { re: /^jstat -gcutil (\d+)(?: \d+(?: \d+)?)?$/, use: "jstat -gcutil <pid> 1000 5", desc: "GC utilisation every second", run: (m, st) => { if (+m[1] !== P) return `${m[1]} not found`; look(st, "jstat"); return jstat(); } },
      { re: /^vmstat(?: \d+(?: \d+)?)?$/, use: "vmstat 1 5", desc: "run queue, context switches, CPU split", run: (m, st) => { look(st, "vmstat"); return vmstat(); } },
      { re: /^nproc$/, use: "nproc", desc: "CPU count", run: () => "16" },
      { re: /^(?:pgrep -f java|jps(?: -l)?)$/, use: "jps -l", desc: "find the JVM", run: () => `${P} com.${I.co}.orders.Application\n${P + 4410} jdk.jcmd/sun.tools.jps.Jps` },
      { re: /^kill(?: -(?:9|KILL|15|TERM))? (\d+)$/, use: "kill <pid>", desc: "stop a process", run: (m, st) => { st.killed = true; return { out: "", danger: "You restarted the service mid-incident: the evidence is gone and the problem will come back." }; } },
      { re: /^systemctl restart \S+$/, use: "systemctl restart <unit>", desc: "restart a unit", run: (m, st) => { st.killed = true; return { out: "", danger: "A restart hides the evidence; the problem will return under the same load." }; } },
    ]);
    return {
      prompt: "app@orders-7:~$", init: { seen: {} }, run: (line, st) => sh.run(line, st), par: 4,
      motd: `PAGE orders-api p99 4.8 s (SLO 300 ms) since 09:31\nJVM pid ${P} (OpenJDK 21, G1, -Xmx${cause === 2 ? 14 : 12}g) on a 16-core host`,
      cmds: ["jps -l", `top -H -p ${P}`, `jstack ${P}`, `jstack ${P} | grep 'java.lang.Thread.State' | sort | uniq -c`, `jstat -gcutil ${P} 1000 5`, "vmstat 1 5"],
      opts: CAUSES, optq: "Root cause",
    };
  }

  /* ---------- USE-method triage terminal ---------- */
  const USE_OPTS = ["CPU saturation: more runnable threads than cores", "One hot CPU: a single-threaded bottleneck", "Disk saturation", "Memory pressure: the box is swapping", "Network interface saturated", "NIC errors and drops"];
  function useShell(I) {
    const k = I.kind, N = I.cores;
    const load = k === 0 ? `${(N * 3.9).toFixed(2)}, ${(N * 3.6).toFixed(2)}, ${(N * 3.1).toFixed(2)}` : k === 1 ? "1.21, 1.18, 1.10" : `${(N * 0.42).toFixed(2)}, ${(N * 0.4).toFixed(2)}, ${(N * 0.41).toFixed(2)}`;
    const vm = () => { const rows = [["r", "b", "swpd", "free", "buff", "cache", "si", "so", "bi", "bo", "in", "cs", "us", "sy", "id", "wa", "st"]]; for (let j = 0; j < 3; j++) rows.push(k === 0 ? [N * 4 - 2 + j, 0, 0, 412000, 88120, 25510000, 0, 0, 2, 140, 41220, 98000 + j * 1200, 84, 15, 1, 0, 0] : k === 1 ? [1, 0, 0, 9120000, 88120, 14510000, 0, 0, 0, 52, 3020, 4100, 12, 1, 87, 0, 0] : [3 + j, 0, 0, 9120000, 88120, 14510000, 0, 0, 180, 182000, 98120, 21000, 22, 19, 58, 1, 0]); return "procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n" + K.cols(rows, 1); };
    const mp = () => { const rows = [["Average:", "CPU", "%usr", "%nice", "%sys", "%iowait", "%irq", "%soft", "%steal", "%idle"]]; const all = k === 0 ? [84.1, 14.6, 1.3] : k === 1 ? [12.4, 0.8, 86.8] : [21.5, 12.0, 58.0]; rows.push(["Average:", "all", all[0], "0.00", all[1], "0.02", "0.00", k === 2 ? "8.40" : "0.10", "0.00", all[2]]); for (let c = 0; c < N; c++) { const hot = k === 1 && c === I.hotCpu; rows.push(["Average:", c, hot ? "99.01" : k === 0 ? (83 + (c % 3)).toFixed(2) : k === 1 ? (0.5 + (c % 3) * 0.7).toFixed(2) : (20 + (c % 4)).toFixed(2), "0.00", hot ? "0.99" : k === 0 ? "14.71" : k === 1 ? "0.60" : "12.10", "0.00", "0.00", k === 2 ? "8.30" : "0.00", "0.00", hot ? "0.00" : k === 0 ? "1.20" : k === 1 ? (98 - (c % 3) * 0.7).toFixed(2) : "58.10"]); } return K.cols(rows, 2); };
    const io = () => { const rows = [["Device", "r/s", "w/s", "rkB/s", "wkB/s", "r_await", "w_await", "aqu-sz", "%util"]]; rows.push(k === 2 ? ["nvme0n1", "12.0", "8410.0", "96.0", "182240.0", "0.11", "0.10", "0.86", "99.60"] : ["nvme0n1", "3.0", "41.0", "24.0", "1320.0", "0.12", "0.31", "0.01", k === 1 ? "35.20" : "2.40"]); return "avg-cpu:  %user   %nice %system %iowait  %steal   %idle\n" + `          ${k === 0 ? "84.10    0.00   14.60    0.02    0.00    1.28" : k === 1 ? "12.40    0.00    0.80    0.00    0.00   86.80" : "21.50    0.00   20.40    0.40    0.00   57.70"}\n\n` + K.cols(rows, 2); };
    const mem = () => K.cols([["", "total", "used", "free", "shared", "buff/cache", "available"], ["Mem:", 63912, k === 0 ? 37410 : 22010, k === 0 ? 402 : 8906, 112, k === 0 ? 26100 : 32996, k === 0 ? 25980 : 41120], ["Swap:", 0, 0, 0]], 3);
    const dev = () => { const rows = [["Average:", "IFACE", "rxpck/s", "txpck/s", "rxkB/s", "txkB/s", "rxcmp/s", "txcmp/s", "rxmcst/s", "%ifutil"]]; rows.push(["Average:", "lo", "102.0", "102.0", "11.2", "11.2", "0.00", "0.00", "0.00", "0.00"]); rows.push(k === 2 ? ["Average:", "eth0", "391204.0", "842310.0", "24410.5", "1218840.2", "0.00", "0.00", "0.00", "99.85"] : ["Average:", "eth0", "41204.0", "39310.0", "8410.5", "22840.2", "0.00", "0.00", "0.00", "1.87"]); return K.cols(rows, 2); };
    const edev = () => K.cols([["Average:", "IFACE", "rxerr/s", "txerr/s", "coll/s", "rxdrop/s", "txdrop/s", "txcarr/s", "rxfram/s", "rxfifo/s", "txfifo/s"], ["Average:", "lo", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00"], ["Average:", "eth0", "0.00", "0.00", "0.00", "0.00", k === 2 ? "0.40" : "0.00", "0.00", "0.00", "0.00", "0.00"]], 2);
    const pid = () => { const rows = [["Average:", "UID", "PID", "%usr", "%system", "%guest", "%wait", "%CPU", "CPU", "Command"]]; if (k === 1) rows.push(["Average:", 1000, I.pid, "99.00", "1.00", "0.00", "0.00", "100.00", I.hotCpu, I.proc]); else if (k === 0) { rows.push(["Average:", 1000, I.pid, `${(N * 70).toFixed(2)}`, `${(N * 12).toFixed(2)}`, "0.00", "71.20", `${(N * 82).toFixed(2)}`, 3, I.proc]); } else rows.push(["Average:", 1000, I.pid, "310.00", "180.00", "0.00", "0.40", "490.00", 5, I.proc]); rows.push(["Average:", 0, 812, "0.20", "0.40", "0.00", "0.00", "0.60", 1, "node_exporter"]); return K.cols(rows, 2); };
    const look = (st, x) => (st.seen[x] = true);
    const sh = K.shell([
      { re: /^uptime$/, use: "uptime", desc: "load averages", run: (m, st) => { look(st, "uptime"); return ` 09:41:07 up 41 days,  3:02,  1 user,  load average: ${load}`; } },
      { re: /^nproc$/, use: "nproc", desc: "CPU count", run: (m, st) => { look(st, "nproc"); return String(N); } },
      { re: /^vmstat(?: \d+(?: \d+)?)?$/, use: "vmstat 1 3", desc: "run queue, memory, swap, CPU", run: (m, st) => { look(st, "vmstat"); return vm(); } },
      { re: /^mpstat(?: -P ALL)?(?: \d+(?: \d+)?)?$/, use: "mpstat -P ALL 1 1", desc: "per-CPU utilisation", run: (m, st) => { look(st, "mpstat"); return mp(); } },
      { re: /^iostat(?: -[xzd]+)*(?: \d+(?: \d+)?)?$/, use: "iostat -xz 1 2", desc: "per-disk utilisation and latency", run: (m, st) => { look(st, "iostat"); return io(); } },
      { re: /^free(?: -[mhg])?$/, use: "free -m", desc: "memory", run: (m, st) => { look(st, "free"); return mem(); } },
      { re: /^sar -n DEV(?: \d+(?: \d+)?)?$/, use: "sar -n DEV 1 1", desc: "network throughput per interface", run: (m, st) => { look(st, "dev"); return dev(); } },
      { re: /^sar -n EDEV(?: \d+(?: \d+)?)?$/, use: "sar -n EDEV 1 1", desc: "network errors and drops", run: (m, st) => { look(st, "edev"); return edev(); } },
      { re: /^pidstat(?: -u)?(?: \d+(?: \d+)?)?$/, use: "pidstat 1 1", desc: "CPU per process", run: (m, st) => { look(st, "pidstat"); return pid(); } },
      { re: /^ethtool (\S+)(?: \| grep -i speed)?$/, use: "ethtool eth0", desc: "link speed", run: (m, st) => { look(st, "ethtool"); return m[1] === "eth0" ? "Settings for eth0:\n\tSpeed: 10000Mb/s\n\tDuplex: Full\n\tLink detected: yes" : `netlink error: no device matches name (offset 24)\nnetlink error: No such device`; } },
    ]);
    return {
      prompt: "ops@" + I.host + ":~$", init: { seen: {} }, run: (line, st) => sh.run(line, st), par: 6,
      motd: `ALERT ${I.svc} latency p99 ${["2.9 s", "1.4 s", "3.3 s"][k]} (SLO 250 ms)\nHost ${I.host}: ${N} vCPU, 64 GB RAM, 1× NVMe, eth0`,
      cmds: ["uptime", "nproc", "vmstat 1 3", "mpstat -P ALL 1 1", "pidstat 1 1", "iostat -xz 1 2", "free -m", "sar -n DEV 1 1", "sar -n EDEV 1 1", "ethtool eth0"],
      opts: USE_OPTS, optq: "Which resource is the bottleneck?",
    };
  }

  /* ---------- profiler choice items ---------- */
  const PROF_CATS = ["CPU sampling profile", "Wall-clock / off-CPU profile", "Distributed trace", "Heap / allocation profile"];
  const PROF_ITEMS = [
    { t: "Pods sit at 100% CPU after a release; which functions burn it?", c: 0, d: 1 },
    { t: "p99 doubled but CPU is at 15%; request threads seem to be waiting on something", c: 1, d: 1 },
    { t: "1 checkout in 1,000 takes 4 s; you need to see which downstream call was slow for that request", c: 2, d: 1 },
    { t: "RSS grows 200 MB an hour until the OOM killer fires", c: 3, d: 1 },
    { t: "A request crosses 6 services and a queue; where does the end-to-end time go?", c: 2, d: 1 },
    { t: "GC uses 30% of CPU; which code creates the garbage?", c: 3, d: 2 },
    { t: "Throughput plateaus at 4 busy cores out of 32 while threads pile up", c: 1, d: 2 },
    { t: "A tight loop got 5% slower after a compiler upgrade", c: 0, d: 2 },
    { t: "A nightly batch got slower although it now uses 3 cores instead of 8", c: 1, d: 2 },
    { t: "Node.js event-loop lag spikes to 800 ms; which synchronous function runs during the spike?", c: 0, d: 3 },
    { t: "Memory jumps by 2 GB whenever one particular report is exported", c: 3, d: 3 },
    { t: "Only requests that go through the EU payment provider are slow, and only for some merchants", c: 2, d: 3 },
    { t: "A Go service is slow while `runtime.futex` is barely visible on the CPU flame graph", c: 1, d: 3 },
    { t: "Latency rises with the number of in-flight requests, CPU stays at 40%, a mutex guards the cache", c: 1, d: 3 },
  ];

  LB.addAll("perf", [
    /* 1 */ {
      id: "perf-flame-hot-path",
      name: "Read the flame graph",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "select",
      gen(lv, R) {
        const hot = lv === 1 ? R.pick(["jwt.verify", "Parser.parseDataRow", "JSON.stringify", "RegExp.exec"]) : lv === 2 ? R.pick(["ObjectMapper.writeValueAsString", "PatternLayout.doLayout"]) : R.pick(["main.buildResults", "main.handleIndex"]);
        const I = { lv, hot, seed: `perf-flame/${lv}/${R.int(1, 1e9)}` };
        const t = hotTree(I);
        const opts = R.shuffle([...names(t)].filter((n) => !/^(\(root\)|all|total)$/.test(n)));
        I.opts = opts;
        return I;
      },
      text: (I) => I.lv === 1 ? `<p>The <b>orders</b> Node.js API burns 90% CPU at modest traffic. You captured a 30-second CPU profile (<code>node --cpu-prof</code>) and rendered it as a flame graph below (hover a frame for its share of samples). The width of a frame is time on CPU <i>including</i> everything it calls; the part not covered by frames above it is its own <b>self time</b>.</p><p><b>Pick the function that is actually doing the burning</b>: the one with the most self time.</p>`
        : I.lv === 2 ? `<p>A Spring service's CPU profile (async-profiler, <code>-e cpu</code>, 60 s) is below. The team wants to optimise the single biggest block they see. Before they do: <b>which function, summed over every stack it appears in, costs the most CPU?</b></p><p>Hover frames for their share of samples; the same function can appear in several towers.</p>`
          : `<p>A Go search service spends a third of its CPU in garbage collection. Below is <code>go tool pprof -http</code>'s flame graph of a 30 s CPU profile. GC marking (<code>runtime.gcBgMarkWorker</code>) runs on its own goroutines, so it isn't attributed to the code that caused it; allocation (<code>runtime.mallocgc</code>) is.</p><p><b>Which of your own functions (package <code>main</code>) should you change first to cut GC cost?</b></p>`,
      ui: (I) => ({ opts: I.opts, k: 1, live: (a) => { const t = hotTree(I); const sel = a && a.length ? I.opts[a[0]] : null; return flameSVG(t, { hl: sel ? [sel] : [], title: `${LANG[I.lv - 1]} CPU profile${sel ? " · highlighted: " + sel : ""}` }) + (sel ? `<p class="muted small">${esc(sel)} appears in ${(function c(n) { return (n[0] === sel ? 1 : 0) + (n[2] || []).reduce((s, x) => s + c(x), 0); })(t)} stack(s).</p>` : `<p class="muted small">Choose a function below to highlight every frame of it.</p>`); } }),
      ans: (I) => [I.opts.indexOf(I.hot)],
      diag: (I, a) => {
        const n = I.opts[a[0]], t = hotTree(I), tot = ftot(t), s = selfBy(t), tb = totBy(t);
        if (I.lv === 1) return `<code>${esc(n)}</code> has ${K.pct(s[n] / tot)} self time${tb[n] > s[n] * 2 ? ` (it's wide, ${K.pct(tb[n] / tot)}, only because of what it calls)` : ""}. Look for the widest frame with nothing on top of it.`;
        if (I.lv === 2) return `<code>${esc(n)}</code> totals ${K.pct(tb[n] / tot)}. Add up every tower a function appears in, not just the widest single block.`;
        return /^runtime\./.test(n) || /^encoding/.test(n) ? `<code>${esc(n)}</code> isn't your code. Which <code>main.*</code> function sits under the most <code>runtime.mallocgc</code>?` : `<code>${esc(n)}</code> is your code, but is it the one that allocates the most? GC cost follows allocation, not CPU self time.`;
      },
      hint: (I) => I.lv === 1 ? "A wide frame with frames stacked on top of it is mostly time spent in its children." : I.lv === 2 ? "Sum the widths of the same function across all towers." : "GC work is proportional to allocation. Find the main.* function whose subtree contains the most runtime.mallocgc.",
      concept: "Reading flame graphs: self time, merged call sites, allocation attribution",
      how: "A flame graph merges sampled stacks: each frame's width is the share of samples in which that function was on the stack, and its children sit on top of it. Self time is the part of a frame's width not covered by children, so the top edges are where the CPU actually executes. The same function called from several places appears as several narrow towers; a reverse (icicle) or 'merged by function' view adds them up. In garbage-collected runtimes the collector often runs on its own threads, so the cost shows up under GC roots while the cause is whoever allocates (mallocgc, TLAB refills, new objects).",
      rule: "Optimise the widest top edge, sum a function across call sites before ranking it, and for GC-heavy profiles chase the allocators, not the collector.",
      why: (I) => { const t = hotTree(I), tot = ftot(t), s = selfBy(t), tb = totBy(t); return I.lv === 1 ? `<code>${esc(I.hot)}</code> had ${K.pct(s[I.hot] / tot)} self time; <code>handleOrders</code> was the widest frame but almost all of its width belonged to its children.` : I.lv === 2 ? `<code>${esc(I.hot)}</code> appeared under three controllers for ${K.pct(tb[I.hot] / tot)} in total, more than <code>PriceCalculator.applyRules</code> (${K.pct(tb["PriceCalculator.applyRules"] / tot)}) even though that was the widest single block.` : `<code>${esc(I.hot)}</code> was responsible for the bigger share of <code>runtime.mallocgc</code>; <code>runtime.scanobject</code> was the widest frame, but marking is a consequence of allocation, and <code>main.scoreDocs</code> burns CPU without creating much garbage.`; },
    },
    /* 2 */ {
      id: "perf-wall-vs-cpu",
      name: "Profile the right clock",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "select",
      gen(lv, R) {
        const culprit = lv === 3 ? "MetricsRegistry.record" : R.pick(["HikariPool.getConnection", "RateLimiter.acquire", "InventoryClient.reserve"]);
        const I = { lv, culprit, seed: `perf-wall/${lv}/${R.int(1, 1e9)}` };
        const { wall } = wallTrees(I);
        I.opts = R.shuffle([...names(wall)].filter((n) => n !== "all" && !/^(Unsafe\.park|SocketInputStream\.socketRead0|EPoll\.wait|LinkedBlockingQueue\.take|ReentrantLock\.lock)$/.test(n)));
        I.p99 = R.int(8, 16) * 100;
        return I;
      },
      text: (I) => `<p><code>POST /orders</code> has a p99 of <b>${K.num(I.p99)} ms</b>, yet the JVM uses only ${I.lv === 1 ? 14 : 11}% CPU. The on-call engineer attached async-profiler twice: <code>-e cpu</code> (samples threads that are running) and <code>-e wall</code> (samples every thread at a fixed interval, running or not). Both flame graphs are below.</p><p><b>Which function is responsible for most of the request latency?</b>${I.lv > 1 ? " Remember what a wall-clock profile samples." : ""}</p>`,
      ui: (I) => ({ opts: I.opts, k: 1, live: (a) => { const t = wallTrees(I), sel = a && a.length ? [I.opts[a[0]]] : []; return flameSVG(t.cpu, { hl: sel, title: "CPU profile (-e cpu)" }) + flameSVG(t.wall, { hl: sel, title: "Wall-clock profile (-e wall)" }); } }),
      ans: (I) => [I.opts.indexOf(I.culprit)],
      diag: (I, a) => { const n = I.opts[a[0]]; return /ObjectMapper|price|Service\.price|CartService/.test(n) ? `<code>${esc(n)}</code> is the biggest thing on the <i>CPU</i> profile, but CPU is ${I.lv === 1 ? 14 : 11}%: the latency is time spent not running.` : /getTask|Poller/.test(n) ? `<code>${esc(n)}</code> is an idle pool thread waiting for work. Wall-clock profiles sample idle threads too; filter to request threads.` : `Not the biggest contributor. Compare the request-path waits${I.lv === 3 ? " and add up every call site" : ""}.`; },
      hint: (I) => I.lv === 1 ? "A CPU profile only sees running threads. Where do request threads spend wall time?" : I.lv === 2 ? "Idle worker threads parked in getTask are sampled by a wall-clock profiler too, and they aren't serving anyone." : "Two waits sit on the request path; one of them appears under two controllers.",
      concept: "On-CPU vs wall-clock (off-CPU) profiling",
      how: "A CPU profiler samples only threads that are running, so time spent blocked on locks, sockets, connection pools or sleeps is invisible to it. A wall-clock profiler samples every thread at a fixed interval regardless of state, which shows where requests wait, but it also samples idle threads (pool workers parked waiting for tasks, selector threads in epoll_wait), which can dominate the picture. Filter to the threads that serve requests (async-profiler can split by thread), then look for waits under your code: Unsafe.park under a lock or pool, socketRead0 under a client call.",
      rule: "When latency is high and CPU is low, take a wall-clock profile, ignore idle threads, and fix the biggest wait on the request path.",
      why: (I) => I.lv < 3 ? `Request threads spent most of their wall time in <code>${esc(I.culprit)}</code>, which barely shows on the CPU profile because waiting doesn't use CPU.${I.lv === 2 ? " The widest wall-clock tower, ThreadPoolExecutor.getTask, was idle workers waiting for work." : ""}` : `<code>MetricsRegistry.record</code> blocked on a lock under both controllers; together that outweighed the single <code>PricingClient.quote</code> tower. A contended lock in a metrics path is a classic latency source; per-thread or striped counters fix it.`,
    },
    /* 3 */ {
      id: "perf-cpu-lock-gc",
      name: "Busy, blocked or collecting?",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) { return { lv, cause: lv - 1, pid: R.int(2000, 60000), co: R.pick(["acme", "nimbus", "kestrel", "orbit"]), seed: `perf-jvm/${lv}/${R.int(1, 1e9)}` }; },
      text: (I) => `<p><b>PAGE:</b> <code>orders-api</code> p99 went from 120 ms to 4.8 s ten minutes ago at normal traffic. Nothing was deployed. You're on the host with the JDK tools. Gather the evidence that tells a CPU-bound service from a lock-contended one from a GC-bound one, then name the root cause. Don't restart anything: you'd lose the evidence.</p>`,
      ...LB.term({
        shell: (I) => jvmShell(I),
        goal(st, I, a) {
          if (a.pick !== I.cause) return "That's not what the evidence says. " + (a.pick === 0 ? "Is the CPU actually busy, and with what?" : a.pick === 1 ? "Are request threads really BLOCKED on one monitor?" : a.pick === 2 ? "Is the old generation full and are full GCs climbing?" : "Nothing in the thread dump points at network waits or an idle pool.");
          const need = I.cause === 0 ? ["top", "jstack"] : I.cause === 1 ? ["jstack"] : ["jstat"];
          if (!need.some((k) => st.seen[k])) return `Right answer, but you haven't looked at the evidence that proves it (${I.cause === 2 ? "GC statistics" : "a thread dump or per-thread CPU"}).`;
          return true;
        },
        solve: (I) => ({ log: [`top -H -p ${I.pid}`, I.cause === 2 ? `jstat -gcutil ${I.pid} 1000 5` : `jstack ${I.pid}`], pick: I.cause }),
      }),
      bad: (I) => [{ log: [`top -H -p ${I.pid}`, `jstack ${I.pid}`], pick: (I.cause + 1) % 3 }, { log: [`top -H -p ${I.pid}`], pick: 4 }],
      hint: (I) => I.lv === 1 ? "Per-thread CPU tells you whether threads are running; a thread dump tells you where." : I.lv === 2 ? "Low CPU and high latency: what state are the request threads in, and who holds what they want?" : "The busiest threads aren't request threads. Check how full the heap is and how often it's being collected.",
      concept: "Triage: CPU-bound vs contended vs GC-bound",
      how: "Start with where time goes. If the cores are busy with application threads (top -H, high us%) and the thread dump shows them RUNNABLE in the same frames, the service is CPU-bound. If CPU is low and many threads are BLOCKED waiting for the same monitor, it's lock contention; find the holder in the dump ('- locked <0x...>') and see what it's doing while holding it. If the busy threads are GC threads and jstat shows the old generation near 100% with the full-GC count rising every second, the JVM is thrashing: it spends most of its time collecting and reclaims almost nothing, usually from a leak or an undersized heap.",
      rule: "Look before you restart: top -H for who's on CPU, jstack for where threads are and what they wait on, jstat -gcutil for whether GC is eating the box.",
      why: (I) => [`Request threads were RUNNABLE at 90%+ CPU each, all inside <code>SkuValidator.validate</code>'s regex: a CPU-bound hot path (often a pathological regex or input).`, `CPU was 10% busy while 199 threads were BLOCKED on one <code>PriceCache</code> monitor held by <code>price-refresh</code>, which was doing a network call inside <code>synchronized</code>. Don't do I/O while holding a lock.`, `The CPU was busy, but with <code>GC Thread#n</code>, and jstat showed the old generation at 99.7% with a full GC every second (about 0.94 s of every 1 s spent in GC). App threads looked RUNNABLE in allocation sites, which made it look CPU-bound.`][I.cause],
    },
    /* 4 */ {
      id: "perf-use-method",
      name: "USE-method triage",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) { return { lv, kind: lv - 1, cores: lv === 2 ? 8 : 16, hotCpu: R.int(0, 7), pid: R.int(1500, 40000), host: R.pick(["web", "api", "edge"]) + "-" + R.int(10, 99), svc: R.pick(K.NAMES.svc), proc: lv === 2 ? R.pick(["node", "redis-server"]) : R.pick(["java", "envoy"]) }; },
      text: (I) => `<p>${esc(I.svc)} is slow on host <code>${esc(I.host)}</code>. Work the USE method: for each resource (CPU, memory, disk, network), check <b>U</b>tilisation, <b>S</b>aturation and <b>E</b>rrors, and find the one that's the bottleneck. ${I.lv === 3 ? "A dashboard already shows the NVMe disk at 99.6% util." : I.lv === 1 ? "The memory graph shows only 400 MB free." : "Overall CPU on the dashboard is only 13%."}</p>`,
      ...LB.term({
        shell: (I) => useShell(I),
        goal(st, I, a) {
          if (a.pick !== I.kind + (I.kind === 2 ? 2 : 0)) {
            if (a.pick === 3 && I.lv === 1) return "Low <i>free</i> memory isn't pressure: Linux uses spare RAM as page cache. Look at <i>available</i> and at swap (si/so).";
            if (a.pick === 2 && I.lv === 3) return "On NVMe, %util only says the device had at least one request in flight; it can serve many in parallel. Await is 0.1 ms and the queue is under 1: the disk isn't saturated.";
            if (a.pick === 0 && I.lv === 2) return "Average CPU is low and the run queue is ~1. Look per CPU.";
            return "The evidence doesn't support that. Check utilisation and saturation of each resource.";
          }
          const need = [["vmstat", "uptime"], ["mpstat", "pidstat"], ["dev"]][I.kind];
          if (!need.some((x) => st.seen[x])) return "Right, but you haven't gathered the measurement that proves it.";
          return true;
        },
        solve: (I) => ({ log: I.lv === 1 ? ["uptime", "nproc", "vmstat 1 3"] : I.lv === 2 ? ["vmstat 1 3", "mpstat -P ALL 1 1"] : ["iostat -xz 1 2", "sar -n DEV 1 1"], pick: I.kind + (I.kind === 2 ? 2 : 0) }),
      }),
      bad: (I) => [I.lv === 1 ? { log: ["free -m"], pick: 3 } : I.lv === 2 ? { log: ["vmstat 1 3"], pick: 0 } : { log: ["iostat -xz 1 2"], pick: 2 }],
      hint: (I) => I.lv === 1 ? "Saturation for CPU is the run queue (vmstat r, load average) compared with the number of cores." : I.lv === 2 ? "An average across 8 CPUs can hide one CPU at 100%." : "%util is misleading for devices that serve requests in parallel; what does the network say about utilisation?",
      concept: "The USE method",
      how: "For every resource, check Utilisation (how busy), Saturation (how much work is queued waiting for it) and Errors. CPU saturation is a run queue (vmstat r, load average) larger than the core count; a single-threaded process saturates one CPU while the average looks idle, so look per CPU (mpstat -P ALL). Memory pressure shows as swapping (si/so) or low 'available', not low 'free', because Linux fills spare RAM with page cache. Disk %util means 'busy at least once per interval' and over-reports for SSD/NVMe, which serve many requests in parallel; await and queue size are the saturation signals. A NIC is saturated when throughput approaches link speed.",
      rule: "Walk every resource with U, S and E before deep-diving, and trust saturation signals (queues, waits) over utilisation percentages.",
      why: (I) => [`The run queue was ~${I.cores * 4} on ${I.cores} cores with 0% idle: CPU saturated. 'free' was low only because of page cache; available memory was 25 GB with no swap.`, `CPU ${I.hotCpu} ran at 99% while the other ${I.cores - 1} idled: ${esc(I.proc)} is single-threaded and maxed out one core, so the 13% average hid a bottleneck.`, `eth0 pushed ~1.22 GB/s on a 10 Gb/s link (%ifutil 99.85): the network is saturated. The NVMe's 99.6% util was a red herring: 0.1 ms await and a queue below 1.`][I.kind],
    },
    /* 5 */ {
      id: "perf-which-profiler",
      name: "Pick the right profiler",
      kind: "Decision",
      skills: ["diagnose", "design"],
      w: "classify",
      gen(lv, R) {
        const pool = PROF_ITEMS.filter((x) => x.d <= lv);
        const must = PROF_ITEMS.filter((x) => x.d === lv);
        const picks = R.shuffle([...R.sample(must, lv === 1 ? 4 : 3), ...R.sample(pool.filter((x) => x.d < lv), lv === 1 ? 0 : lv === 2 ? 2 : 3)]);
        return { lv, items: picks.map((x) => x.t), cats: picks.map((x) => x.c) };
      },
      text: (I) => `<p>Your team is triaging a backlog of performance tickets. For each one, choose the tool that would actually show the answer.</p>`,
      ui: (I) => ({ items: I.items, cats: PROF_CATS }),
      ans: (I) => I.cats,
      diag: (I, a) => { const i = a.findIndex((x, k) => x !== I.cats[k]); return `Look again at “${esc(I.items[i])}”. ${I.cats[i] === 1 ? "Is the thread running while the time passes?" : I.cats[i] === 3 ? "A CPU profile shows GC or growth, not who allocates." : I.cats[i] === 2 ? "Profiles aggregate; you need one request across services." : "The time is spent running code on the CPU."}`; },
      hint: (I) => "Ask: is the time spent running (CPU), waiting (wall/off-CPU), spread across services (trace), or is it about memory (heap/allocation)?",
      concept: "Choosing a profiler",
      how: "A CPU sampling profiler (perf, async-profiler -e cpu, pprof CPU, --cpu-prof) shows where running code spends cycles at low overhead. Wall-clock or off-CPU profiles show where threads wait: locks, I/O, pools, sleeps. Distributed tracing follows a single request across services and is the only tool for 'this request was slow' questions, because profiles aggregate across all requests. Heap and allocation profiles answer memory questions: what is retained (heap snapshot) and who allocates (allocation profile), which is what drives GC cost. A blocked Node.js event loop is on-CPU running JavaScript, so a CPU profile shows the culprit.",
      rule: "Match the tool to where the time or memory goes: running → CPU profile, waiting → wall/off-CPU, one request across services → trace, memory or GC → allocation/heap profile.",
      why: (I) => `${I.items.length} tickets, ${I.cats.filter((c) => c === 1).length} of them about waiting rather than running, which a CPU profile can't see.`,
    },
  ]);

  /* ================= races, deadlocks, lock ordering, RW locks ================= */
  function* interleavings(lens) {
    const left = lens.slice(), cur = [], total = lens.reduce((a, b) => a + b, 0);
    function* go() { if (cur.length === total) { yield cur.slice(); return; } for (let l = 0; l < left.length; l++) if (left[l] > 0) { left[l]--; cur.push(l); yield* go(); cur.pop(); left[l]++; } }
    yield* go();
  }
  const seqOf = (lens, order) => order.flatMap((l) => Array(lens[l]).fill(l));
  const traceTable = (lanes, log, extra) => K.table(["#", ...lanes.map((l) => esc(l.name)), ...(extra ? [extra.head] : [])], log.map((e, k) => [String(k + 1), ...lanes.map((_, j) => (j === e.t ? `<span class="mono">${esc(e.label)}</span>${e.note ? `<br><small class="${e.err ? "lose" : "muted"}">${esc(e.note)}</small>` : ""}` : "")), ...(extra ? [`<span class="mono">${esc(String(e.v))}</span>`] : [])]), { compact: true });

  /* counter / stock races */
  function ctrDef(I) {
    const v = I.lv === 2 ? "stock" : I.lv === 1 ? "views" : "requestsTotal";
    const step = I.lv === 2 ? [`s = ${v}            // read, no lock`, `if (s > 0) { lock(); ${v} = s - 1; unlock(); ship(); }`] : [`tmp = ${v}         // load`, `${v} = tmp + 1     // store`];
    return { v, lanes: [0, 1].map((t) => ({ name: `Thread ${t + 1}`, steps: Array.from({ length: I.n }, () => step).flat() })) };
  }
  function ctrSim(I, seq) {
    const d = ctrDef(I);
    let v = I.init; const reg = [null, null], sold = [0, 0], pos = [0, 0], log = [];
    for (const l of seq) {
      const i = pos[l]++, label = d.lanes[l].steps[i];
      if (i % 2 === 0) { reg[l] = v; log.push({ t: l, label, note: `reads ${v}`, v }); }
      else if (I.lv === 2 && !(reg[l] > 0)) log.push({ t: l, label, note: "saw 0: out of stock, nothing shipped", v });
      else { v = I.lv === 2 ? reg[l] - 1 : reg[l] + 1; sold[l]++; log.push({ t: l, label, note: I.lv === 2 ? `writes ${v}, ships 1 unit` : `writes ${v}`, v }); }
    }
    const complete = seq.length === I.n * 4;
    const broken = complete && (I.lv === 1 ? v !== I.init + 2 : I.lv === 2 ? sold[0] + sold[1] > I.init : v === 2);
    const verdict = I.lv === 2 ? `shipped ${sold[0] + sold[1]} units from a stock of ${I.init}; stock now ${v}` : `final ${d.v} = ${v} after ${I.n * 2} increments (expected ${I.init + I.n * 2})`;
    return { v, sold, log, complete, broken, verdict };
  }

  /* get-or-create races and double-checked locking */
  function goc(I) {
    if (I.lv < 3) {
      const old = (k) => ({ name: `Request ${k + 1} (${I.items[k]})`, steps: ["cart = carts.get(userId)", `if (cart == null) { cart = new Cart(#${k + 1}); carts.put(userId, cart); }`, `cart.add("${I.items[k]}")`], ops: ["get", "create", "add"] });
      const lanes = I.lv === 1 ? [old(0), old(1)] : [{ name: `Request 1 (${I.items[0]})`, steps: [`cart = carts.computeIfAbsent(userId, id -> new Cart(#1))`, `cart.add("${I.items[0]}")`], ops: ["cia", "add"] }, old(1)];
      return { lanes };
    }
    return { lanes: [
      { name: "Thread 1 (first caller)", steps: ["if (config == null)        // unsynchronised check", "synchronized (Config.class) {", "  if (config == null)      // second check", "    config = <new Config>  // reference stored first (reordered)", `    config.timeoutMs = ${I.to}  // constructor writes land later`, "}"], ops: ["chk", "lock", "chk", "pub", "init", "unlock"] },
      { name: "Thread 2 (another request)", steps: ["Config c = config          // unsynchronised read", "if (c != null) http.call(c.timeoutMs) else take the lock"], ops: ["read", "use"] },
    ] };
  }
  function gocSim(I, seq) {
    const { lanes } = goc(I), pos = lanes.map(() => 0), log = [];
    if (I.lv < 3) {
      let slot = null; const carts = {}, reg = [null, null];
      for (const l of seq) {
        const i = pos[l]++, op = lanes[l].ops[i], label = lanes[l].steps[i];
        if (op === "get") { reg[l] = slot; log.push({ t: l, label, note: slot ? `gets Cart#${slot}` : "gets null" }); }
        else if (op === "create") { if (reg[l] == null) { reg[l] = l + 1; carts[l + 1] = []; slot = l + 1; log.push({ t: l, label, note: `creates Cart#${l + 1} and stores it` }); } else log.push({ t: l, label, note: "cart exists, nothing to do" }); }
        else if (op === "cia") { if (slot == null) { slot = 1; carts[1] = []; log.push({ t: l, label, note: "atomically creates Cart#1" }); } else log.push({ t: l, label, note: `atomically returns Cart#${slot}` }); reg[l] = slot; }
        else { carts[reg[l]].push(I.items[l]); log.push({ t: l, label, note: `adds to Cart#${reg[l]}` }); }
      }
      const complete = seq.length === lanes[0].steps.length + lanes[1].steps.length;
      const kept = slot ? carts[slot] : [];
      const lost = I.items.filter((x) => !kept.includes(x));
      return { log, complete, broken: complete && lost.length > 0, verdict: `carts[user] is Cart#${slot} with [${kept.join(", ")}]${lost.length ? `; "${lost.join(", ")}" went into an orphaned cart and vanished` : ""}` };
    }
    let config = null, obj = null, reg = null, used = null;
    for (const l of seq) {
      const i = pos[l]++, op = lanes[l].ops[i], label = lanes[l].steps[i];
      if (op === "pub") { obj = { timeoutMs: 0 }; config = obj; log.push({ t: l, label, note: "config is now non-null; timeoutMs still 0" }); }
      else if (op === "init") { obj.timeoutMs = I.to; log.push({ t: l, label, note: `timeoutMs = ${I.to}` }); }
      else if (op === "read") { reg = config; log.push({ t: l, label, note: reg ? "sees a non-null config" : "sees null" }); }
      else if (op === "use") { used = reg ? reg.timeoutMs : "slow"; log.push({ t: l, label, note: reg ? `calls with timeoutMs = ${reg.timeoutMs}` : "takes the lock and waits: safe" }); }
      else log.push({ t: l, label, note: "" });
    }
    const complete = seq.length === 8;
    return { log, complete, broken: complete && used === 0, verdict: used === 0 ? "Thread 2 used a half-constructed Config: every call made with a 0 ms timeout fails" : used === "slow" ? "Thread 2 took the slow path and got a fully built Config" : `Thread 2 used timeoutMs = ${used}` };
  }

  /* lock acquisition with blocking (deadlock finder) */
  function dlDef(I) {
    const L = (name, ops) => ({ name, steps: ops.map((o) => o[1]), ops: ops.map((o) => o[0]) });
    if (I.lv === 1) {
      const o = `order#${I.oid}`, v = "inventory";
      return [L("cancelOrder()", [[["lock", o], `lock(${o})`], [["lock", v], `lock(${v})`], [["work"], "restore stock"], [["unlock", v], `unlock(${v})`], [["unlock", o], `unlock(${o})`]]),
        L("restockJob()", [[["lock", v], `lock(${v})`], [["lock", o], `lock(${o})`], [["work"], "release backorder"], [["unlock", o], `unlock(${o})`], [["unlock", v], `unlock(${v})`]])];
    }
    if (I.lv === 2) {
      const [a, b, c] = I.accts, tr = (x, y) => L(`transfer(${x} → ${y})`, [[["lock", x], `synchronized (from=${x})`], [["lock", y], `synchronized (to=${y})`], [["work"], "move money"], [["unlock", y], `} // release ${y}`], [["unlock", x], `} // release ${x}`]]);
      return [tr(a, b), tr(b, a), tr(a, c)];
    }
    return [
      L("CacheLoader.load()", [[["lock", "cache"], "synchronized (cache) {"], [["work"], "  v = compute(key)"], [["lock", "appender"], "  log.info(...)  // appender lock"], [["unlock", "appender"], "  // log written"], [["unlock", "cache"], "}"]]),
      L("LogFlusher.run()", [[["lock", "appender"], "synchronized (appender) {"], [["lock", "cache"], "  write(\"size=\" + cache.size())  // synchronized"], [["unlock", "cache"], "  // size read"], [["unlock", "appender"], "}"]]),
      L("ApiHandler.get()", [[["lock", "cache"], "synchronized (cache) {"], [["work"], "  v = map.get(key)"], [["unlock", "cache"], "}"]]),
    ];
  }
  function dlSim(I, seq) {
    const lanes = dlDef(I), held = {}, T = lanes.map(() => ({ waiting: null, backlog: [] })), log = [], pos = lanes.map(() => 0);
    const exec = (t, i) => {
      const [k, l] = lanes[t].ops[i], label = lanes[t].steps[i];
      if (k === "lock") {
        if (held[l] != null && held[l] !== t) { T[t].waiting = l; T[t].backlog.push(i); log.push({ t, label, note: `blocks: ${l} is held by ${lanes[held[l]].name}`, err: true }); return; }
        held[l] = t; log.push({ t, label, note: `holds ${l}` }); return;
      }
      if (k === "unlock") { delete held[l]; log.push({ t, label, note: `releases ${l}` }); wake(); return; }
      log.push({ t, label, note: "" });
    };
    const wake = () => {
      for (let u = 0; u < T.length; u++) {
        const x = T[u];
        if (x.waiting == null || held[x.waiting] != null) continue;
        x.waiting = null;
        const bl = x.backlog; x.backlog = [];
        log.push({ t: u, label: "", note: "wakes up" });
        for (const i of bl) { if (x.waiting != null) x.backlog.push(i); else exec(u, i); }
      }
    };
    for (const l of seq) { const i = pos[l]++; if (T[l].waiting != null) T[l].backlog.push(i); else exec(l, i); }
    const stuck = T.map((x, t) => (x.waiting != null ? t : -1)).filter((t) => t >= 0);
    const complete = seq.length === lanes.reduce((s, l) => s + l.steps.length, 0);
    const desc = stuck.map((t) => `${lanes[t].name} holds ${Object.keys(held).filter((l) => held[l] === t).join(", ") || "nothing"} and waits for ${T[t].waiting}`).join("; ");
    return { log, stuck, complete, broken: complete && stuck.length > 0, verdict: stuck.length ? `DEADLOCK: ${desc}` : "every thread finished" };
  }
  const findSched = (lens, sim, I) => { for (const s of interleavings(lens)) if (sim(I, s).broken) return s; return null; };

  /* lock-order graph */
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const ARW = " → ";
  function lockPaths(I) {
    if (I.lv === 1) return [{ k: "p0", name: "cancelOrder()", locks: ["order", "inventory"] }, { k: "p1", name: "restockJob()", locks: ["order", "inventory"] }];
    if (I.lv === 2) return [{ k: "p0", name: "Transfer.execute()", locks: ["account", "ledger", "audit"] }, { k: "p1", name: "Statement.render()", locks: ["account", "ledger"] }, { k: "p2", name: "AuditSink.flush() (vendor library)", locks: ["audit", "ledger"], fixed: "audit → ledger" }];
    return [
      { k: "p0", name: "Checkout.handle() (framework calls it holding session)", locks: ["session", "account", "audit"], first: "session" },
      { k: "p1", name: "Refund.process()", locks: ["account", "ledger", "audit"] },
      { k: "p2", name: "Reconcile.run()", locks: ["ledger", "account"] },
      { k: "p3", name: "AdminTool.lockUser()", locks: ["account", "session"] },
      { k: "p4", name: "AuditSink.flush() (vendor library)", locks: ["audit", "ledger"], fixed: "audit → ledger" },
    ];
  }
  function lockCycle(I, cfg) {
    const edges = [];
    lockPaths(I).forEach((p) => { const o = String(p.fixed || cfg[p.k] || "").split(ARW); for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) edges.push([o[i], o[j], p.name]); });
    const adj = {}; edges.forEach(([a, b, n]) => (adj[a] = adj[a] || []).push([b, n]));
    const color = {}, stack = [];
    let cyc = null;
    const dfs = (u) => { color[u] = 1; stack.push(u); for (const [v, n] of adj[u] || []) { if (cyc) return; if (color[v] === 1) { cyc = [...stack.slice(stack.indexOf(v)), v]; return; } if (!color[v]) dfs(v); } stack.pop(); color[u] = 2; };
    Object.keys(adj).forEach((u) => { if (!color[u] && !cyc) dfs(u); });
    return { edges, cyc };
  }

  /* reader-writer lock simulator: readers Poisson, writers periodic; policies rp (reader-preferring), wp (writer-preferring), cow (copy-on-write swap) */
  function rwSim(I, cfg) {
    const R = rng(I.seed), dur = I.dur, ev = [];
    let t = 0;
    for (;;) { t += K.exp(R, 1 / I.lam); if (t >= dur) break; ev.push({ t, w: false, h: K.exp(R, 1) }); }
    for (let s = I.wEvery * R.next(); s < dur; s += I.wEvery) ev.push({ t: s, w: true, h: 1 });
    ev.sort((a, b) => a.t - b.t);
    const pol = cfg.policy, rh = (e) => e.h * (cfg.sect === "copy" ? I.rShort : I.rLong), wh = pol === "cow" ? I.wCow : I.wHold;
    const active = [], rq = [], wq = [], rl = [], wl = [];
    let wActive = false, wEnd = 0, readerTurn = false, i = 0;
    const startR = (now) => { const e = rq.shift(); const h = rh(e); active.push(now + h); rl.push(now - e.t + h); };
    const startW = (now) => { const e = wq.shift(); wActive = true; wEnd = now + wh; wl.push(now - e.t + wh); };
    const admit = (now) => {
      if (pol === "cow") { while (rq.length) startR(now); if (!wActive && wq.length) startW(now); return; }
      if (wActive) return;
      if (pol === "rp") { while (rq.length) startR(now); if (!active.length && wq.length) startW(now); return; }
      if (wq.length && !readerTurn) { if (!active.length) startW(now); return; }
      while (rq.length) startR(now);
      readerTurn = false;
      if (!active.length && wq.length) startW(now);
    };
    for (let guard = 0; guard < 400000; guard++) {
      const na = i < ev.length ? ev[i].t : Infinity;
      let nr = wActive ? wEnd : Infinity, ri = -1;
      for (let k = 0; k < active.length; k++) if (active[k] < nr) { nr = active[k]; ri = k; }
      if (na === Infinity && nr === Infinity) break;
      if (na <= nr) { const e = ev[i++]; (e.w ? wq : rq).push(e); admit(na); }
      else { if (ri < 0) { wActive = false; if (pol === "wp") readerTurn = true; } else active.splice(ri, 1); admit(nr); }
    }
    return { rp99: K.quantile(rl, 0.99), wp99: K.quantile(wl, 0.99), wmax: Math.max(...wl), mem: pol === "cow" ? I.mapMB * 2 : I.mapMB };
  }
  const rwCheck = (I, r) => r.wp99 > I.wT ? `writers wait: config updates take ${K.ms(r.wp99)} at p99 (must apply within ${I.wT} ms)` : r.rp99 > I.rT ? `reader p99 is ${K.ms(r.rp99)} (target ${I.rT} ms)` : r.mem > I.memMB ? `peak memory ${K.num(r.mem)} MB is over the ${K.num(I.memMB)} MB budget` : true;
  const POL = { rp: "reader-preferring (glibc pthread default)", wp: "writer-preferring (like Go's sync.RWMutex)", cow: "copy-on-write: build a new map, swap an atomic reference" };

  LB.addAll("perf", [
    /* 6 */ {
      id: "perf-race-counter",
      name: "Lose an update",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "interleave",
      gen(lv, R) { return lv === 1 ? { lv, n: 1, init: R.int(100, 900) } : lv === 2 ? (() => { const n = R.pick([2, 3]); return { lv, n, init: n * 2 - 1 }; })() : { lv, n: 3, init: 0 }; },
      text: (I) => { return I.lv === 1 ? `<p>A Java handler counts page views with a plain field: <code>views++</code>. Under load the dashboard shows fewer views than the access log. <code>views++</code> is really a load and a store. The counter is at <b>${I.init}</b> and two threads each record one view.</p><p><b>Find a schedule that ends with the wrong count.</b></p>`
        : I.lv === 2 ? `<p>A flash sale oversold. A teammate's fix wraps the write in a lock, but the read of <code>stock</code> still happens before the lock. Stock starts at <b>${I.n * 2 - 1}</b>, and two threads each try to sell ${I.n} units.</p><p><b>Show the fix doesn't work: find a schedule that ships more than ${I.n * 2 - 1} units.</b></p>`
          : `<p>A metrics counter declared <code>volatile long requestsTotal</code> is incremented with <code>requestsTotal++</code> from two threads, ${I.n} times each. Someone claims volatile makes it "almost right, off by one at most". <code>volatile</code> makes each load and store visible, but the increment is still two steps.</p><p><b>Find a schedule that ends with requestsTotal = 2</b> (6 increments, 4 lost).</p>`; },
      ui: (I) => { const J = I; const d = ctrDef(J); return { lanes: d.lanes, live: (seq) => { const r = ctrSim(J, seq || []); return traceTable(d.lanes, r.log, { head: d.v }) + (r.complete ? K.verdict(r.broken, r.verdict) : ""); } }; },
      accept(I, seq) { const J = I; const r = ctrSim(J, seq); return r.broken ? true : `No bug shown: ${r.verdict}. ${I.lv === 3 ? "To lose almost everything, one thread must hold a very old value for a long time." : "Overlap a read with the other thread's read-then-write."}`; },
      solve(I) { const J = I; return findSched([I.n * 2, I.n * 2], ctrSim, J); },
      bad: (I) => [seqOf([I.n * 2, I.n * 2], [0, 1]), seqOf([I.n * 2, I.n * 2], [1, 0])],
      hint: (I) => I.lv === 1 ? "Let both threads load before either stores." : I.lv === 2 ? "The lock only protects the write. Let both threads read the same stock value." : "Thread 1 loads 0 and waits; thread 2 does all but its last increment; thread 1 stores 1; thread 2 loads 1; thread 1 finishes; thread 2 stores 2.",
      concept: "Read-modify-write races",
      how: "x++ compiles to a load, an add and a store. If two threads load the same value, both store value + 1 and one increment is lost. Locking only the write doesn't help, because the decision was made from a stale read taken outside the lock; the read and the write must be in the same critical section. volatile (Java) only guarantees visibility and ordering of each individual load and store, not atomicity of the pair, so a volatile counter still loses updates, and with long stalls between a load and its store it can lose almost all of them.",
      rule: "Make read-modify-write atomic: AtomicLong/LongAdder, atomic fetch-add, a single critical section around read and write, or let the database do it (UPDATE ... SET n = n - 1 WHERE n > 0).",
      why: (I) => I.lv === 1 ? `Both threads loaded ${I.init} and both stored ${I.init + 1}: one view vanished.` : I.lv === 2 ? `Both threads read the same stock and each decremented its stale copy, so the sale shipped more units than existed. Put the read inside the lock or use a conditional atomic update.` : `With 6 increments the final value can be as low as 2. 'Off by one at most' is wrong: the loss is unbounded relative to contention. Use LongAdder or AtomicLong.incrementAndGet().`,
    },
    /* 7 */ {
      id: "perf-race-check-then-act",
      name: "Check, then act, then regret",
      kind: "Code review",
      skills: ["diagnose", "design"],
      w: "interleave",
      gen(lv, R) { const items = R.sample(["socks", "lamp", "kettle", "headphones", "mug", "charger", "notebook"], 2); return { lv, items, to: R.pick([1500, 2000, 3000, 5000]) }; },
      text: (I) => I.lv === 1 ? `<p>Users who double-click "Add to cart" sometimes lose an item. The cart service keeps carts in a <code>ConcurrentHashMap</code> and does a get, then a put if missing. Two requests arrive for the same new user: one adds <b>${esc(I.items[0])}</b>, the other <b>${esc(I.items[1])}</b>.</p><p><b>Find the schedule that loses an item.</b></p>`
        : I.lv === 2 ? `<p>The fix landed: the main endpoint now uses <code>computeIfAbsent</code>, which is atomic. But the mobile endpoint still uses the old get-then-put helper. Two requests for the same new user hit one of each.</p><p><b>Show the item can still be lost.</b></p>`
          : `<p>A shared HTTP client <code>Config</code> is lazily created with double-checked locking. The field <code>config</code> is <b>not volatile</b>. Without a happens-before edge, the JIT or CPU may make the reference visible to another thread before the constructor's writes. The lanes show what the first thread may effectively do.</p><p><b>Find a schedule where thread 2 uses a half-built object.</b></p>`,
      ui: (I) => { const { lanes } = goc(I); return { lanes, live: (seq) => { const r = gocSim(I, seq || []); return traceTable(lanes, r.log) + (r.complete ? K.verdict(r.broken, r.verdict) : ""); } }; },
      accept(I, seq) { const r = gocSim(I, seq); return r.broken ? true : `No bug shown: ${r.verdict}.`; },
      solve(I) { const { lanes } = goc(I); return findSched(lanes.map((l) => l.steps.length), gocSim, I); },
      bad: (I) => { const { lanes } = goc(I), n = lanes.map((l) => l.steps.length); return [seqOf(n, [0, 1]), seqOf(n, [1, 0])]; },
      hint: (I) => I.lv === 1 ? "Both requests must see an empty map before either one stores its cart." : I.lv === 2 ? "Let the old path read null, then let the atomic path create its cart, then let the old path put." : "Thread 2's unsynchronised read must happen after the reference is stored but before the constructor's write.",
      concept: "Check-then-act and safe publication",
      how: "Any 'if absent then create' sequence spread over two operations is a race, even on a thread-safe map, because another thread can act between the check and the act. Use a single atomic operation (computeIfAbsent, putIfAbsent, INSERT ... ON CONFLICT) and make every code path use it; one old path is enough to reintroduce the bug. Double-checked locking adds a second problem: publication. Without volatile (or final fields, or a holder class), the Java memory model lets another thread see the reference before the constructor's writes, so it can read default values.",
      rule: "Replace check-then-act with one atomic operation on every path, and publish lazily-built shared objects through volatile, a static holder, or an atomic reference.",
      why: (I) => I.lv === 1 ? `Both requests read null and each created a cart; the second put overwrote the first, so the item added to the first cart went into an object nobody references.` : I.lv === 2 ? `computeIfAbsent is atomic only relative to other computeIfAbsent calls; the old get-then-put path read null before it ran and overwrote its cart afterwards.` : `Thread 2 saw a non-null reference whose timeoutMs was still 0. Declaring the field volatile forbids that reordering; a static holder class (lazy, thread-safe class initialisation) is simpler still.`,
    },
    /* 8 */ {
      id: "perf-deadlock-find",
      name: "Reproduce the deadlock",
      kind: "Incident",
      skills: ["diagnose"],
      w: "interleave",
      gen(lv, R) { return { lv, oid: R.int(1000, 9999), accts: R.sample(["acct-17", "acct-42", "acct-88", "acct-203", "acct-311"], 3) }; },
      text: (I) => I.lv === 1 ? `<p>Twice a week the order service stops responding and a restart fixes it. A thread dump from the last hang shows two threads each "waiting to lock" something the other holds. Below are the two code paths involved.</p><p><b>Build a schedule that deadlocks.</b> A thread that asks for a held lock blocks until it's released.</p>`
        : I.lv === 2 ? `<p>The ledger service's <code>transfer(from, to)</code> locks <code>from</code>, then <code>to</code>. Code review said "every call takes locks in the same order, so it's safe". Three transfers run at once.</p><p><b>Show that it can deadlock.</b></p>`
          : `<p>A cache hangs a few times a month. <code>CacheLoader</code> logs while holding the cache lock; the logging appender's flusher thread writes a status line that calls <code>cache.size()</code>, which is <code>synchronized</code> on the cache. A third, innocent thread reads the cache.</p><p><b>Find the deadlocking schedule.</b></p>`,
      ui: (I) => { const lanes = dlDef(I); return { lanes: lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = dlSim(I, seq || []); return traceTable(lanes, r.log) + (r.complete ? K.verdict(r.broken, r.verdict) : r.stuck.length ? K.note("Blocked steps queue until the lock frees up.") : ""); } }; },
      accept(I, seq) { const r = dlSim(I, seq); return r.broken ? true : `No deadlock: ${r.verdict}. Each thread must grab its first lock before either asks for its second.`; },
      solve(I) { return findSched(dlDef(I).map((l) => l.steps.length), dlSim, I); },
      bad: (I) => { const n = dlDef(I).map((l) => l.steps.length); return [seqOf(n, n.map((_, i) => i)), seqOf(n, n.map((_, i) => n.length - 1 - i))]; },
      hint: (I) => I.lv === 1 ? "Let each thread take its first lock, then ask for the second." : I.lv === 2 ? "'From' and 'to' depend on the arguments. Which two transfers take the same locks in opposite order?" : "The cache lock and the appender lock are taken in opposite orders by the loader and the flusher; the reader is a distraction.",
      concept: "Deadlock: a cycle in the wait-for graph",
      how: "A deadlock needs four things at once: mutual exclusion, hold-and-wait, no preemption, and a circular wait. Two threads that take the same two locks in opposite orders can each grab one and wait forever for the other. Ordering by argument (from, to) is not a global order: transfer(a, b) and transfer(b, a) reverse it. Hidden locks are common: logging appenders, synchronized getters, class initialisation, connection pools. A thread dump shows the cycle directly ('Found one Java-level deadlock').",
      rule: "Acquire locks in one global order (e.g. by account id), never call out to code you don't control while holding a lock, and use tryLock with a timeout where you can't guarantee an order.",
      why: (I) => I.lv === 1 ? "cancelOrder held the order and wanted inventory; restockJob held inventory and wanted the order." : I.lv === 2 ? `transfer(${I.accts[0]} → ${I.accts[1]}) and transfer(${I.accts[1]} → ${I.accts[0]}) locked the same accounts in opposite orders. Lock min(id) first, then max(id). The third transfer only made the trace noisier.` : "CacheLoader held the cache and wanted the appender; LogFlusher held the appender and wanted the cache via the synchronized size(). Don't log (or call any callback) while holding a lock.",
    },
    /* 9 */ {
      id: "perf-lock-ordering",
      name: "Impose a lock order",
      kind: "Change plan",
      skills: ["design", "safe"],
      w: "tune",
      gen(lv, R) { return { lv, v: R.int(1, 1e6) }; },
      text: (I) => `<p>${I.lv === 1 ? "The deadlock between cancelOrder() and restockJob() is confirmed." : I.lv === 2 ? "The ledger service has three code paths that take two or three of these locks. One of them is inside a vendor library and can't change." : "Five code paths in checkout take overlapping locks. The web framework calls Checkout.handle() with the session already locked, and the vendor audit sink's order is fixed."} Choose the order each path acquires its locks in so that <b>no deadlock is possible</b>: the combined lock-order graph must have no cycle.</p>`,
      ui: (I) => {
        const knobs = lockPaths(I).map((p) => {
          if (p.fixed) return { k: p.k, label: p.name, opts: [p.fixed], fixed: p.fixed, help: "can't change" };
          let o = perms(p.locks);
          if (p.first) o = o.filter((x) => x[0] === p.first);
          return { k: p.k, label: p.name, opts: o.map((x) => x.join(ARW)), seg: true, help: p.first ? `${p.first} is already held when it's called` : "acquisition order" };
        });
        const init = {};
        const bad0 = I.lv === 1 ? { p0: "order → inventory", p1: "inventory → order" } : I.lv === 2 ? { p0: "account → ledger → audit", p1: "account → ledger" } : { p0: "session → account → audit", p1: "account → ledger → audit", p2: "ledger → account", p3: "account → session" };
        Object.assign(init, bad0);
        return { knobs, init, live: (cfg) => { const r = lockCycle(I, cfg || {}); return K.table(["Held", "then acquired", "by"], r.edges.map((e) => [`<code>${esc(e[0])}</code>`, `<code>${esc(e[1])}</code>`, esc(e[2])]), { compact: true }) + K.verdict(!r.cyc, r.cyc ? `cycle: ${esc(r.cyc.join(ARW))}: those paths can deadlock` : "no cycle: a global order exists"); } };
      },
      accept(I, cfg) { const r = lockCycle(I, cfg); return r.cyc ? `The lock-order graph has a cycle <code>${esc(r.cyc.join(ARW))}</code>, so some interleaving of those paths deadlocks.` : true; },
      solve(I, spec) { for (const c of LB.byId.get("perf-lock-ordering").space(I, spec)) if (!lockCycle(I, c).cyc) return c; return null; },
      bad: (I) => [LB.byId.get("perf-lock-ordering").ui(I).init],
      hint: (I) => I.lv === 1 ? "Make both paths agree." : I.lv === 2 ? "The vendor path fixes audit before ledger; everyone else must respect that." : "Collect the fixed constraints first (session before account, audit before ledger), then pick one global order and make every path follow it.",
      concept: "Global lock ordering",
      how: "Draw an edge from lock X to lock Y whenever some path holds X while acquiring Y. If that graph has no cycle, the locks admit a total order and no circular wait, and so no deadlock, is possible among them. Constraints you can't change (a framework that calls you holding a lock, a library's internal order) fix some edges; every other path must be made consistent with them. Tools help: lock-order checkers (Linux lockdep, Go's -race doesn't catch these but go-deadlock does, ThreadSanitizer's lock-order inversion reports) flag a new inversion the first time both orders are seen, even if no deadlock happened yet.",
      rule: "Write the global lock order down, derive it from the constraints you can't change, and enforce it in code review or with a lock-order checker.",
      why: (I, sol) => `One safe assignment: ${lockPaths(I).map((p) => `<code>${esc(p.name.split(" ")[0])}</code>: ${esc(p.fixed || sol[p.k])}`).join("; ")}.`,
    },
    /* 10 */ {
      id: "perf-rwlock-starvation",
      name: "Starving writer",
      kind: "Config change",
      skills: ["tune", "design"],
      w: "tune",
      gen(lv, R) {
        const base = { lv, seed: `perf-rw/${lv}/${R.int(1, 1e9)}`, dur: 3000 };
        if (lv === 1) return { ...base, lam: R.pick([1.8, 2, 2.2]), rLong: 3, rShort: 3, wEvery: 200, wHold: 2, wCow: 2, wT: 50, rT: 40, mapMB: 40, memMB: 512 };
        if (lv === 2) return { ...base, lam: R.pick([1.8, 2, 2.2]), rLong: 3, rShort: 0.2, wEvery: 20, wHold: 1.5, wCow: 1.5, wT: 20, rT: 8, mapMB: 40, memMB: 512 };
        return { ...base, lam: R.pick([1.8, 2, 2.2]), rLong: 3, rShort: 0.2, wEvery: 250, wHold: 25, wCow: 60, wT: 300, rT: 5, mapMB: R.pick([1200, 1500]), memMB: 4096 };
      },
      text: (I) => `<p>A routing table is read by ~${K.num(I.lam * 1000)} requests/s through a read-write lock; each reader holds it ${I.lv === 1 ? `for ~${I.rLong} ms` : `for ~${I.rLong} ms because it JSON-encodes the route under the lock`}. A writer ${I.lv === 3 ? `rebuilds the table in place every ${I.wEvery} ms, holding the write lock ${I.wHold} ms` : `updates it every ${I.wEvery} ms (${I.wHold} ms under the write lock)`}.</p><p>Updates must apply within <b>${I.wT} ms</b> at p99; reader p99 must stay under <b>${I.rT} ms</b>${I.lv === 3 ? `; the table is ${K.num(I.mapMB)} MB and the pod has ${K.num(I.memMB)} MB` : ""}. ${I.lv === 1 ? "Today updates sometimes take seconds." : ""}</p>`,
      ui: (I) => {
        const knobs = [{ k: "policy", label: "Lock policy", opts: I.lv === 3 ? ["rp", "wp", "cow"] : ["rp", "wp"], fmt: (v) => POL[v].split(" (")[0].split(":")[0], help: I.lv === 3 ? "rp/wp = reader/writer-preferring lock · cow = readers load an atomic reference; the writer builds a copy and swaps it" : "who goes first when both wait" }];
        if (I.lv > 1) knobs.push({ k: "sect", label: "Reader critical section", opts: ["encode", "copy"], fmt: (v) => (v === "encode" ? "encode JSON under the lock" : "copy the route, encode after"), help: "how long a reader holds the lock" });
        return { knobs, init: { policy: "rp", sect: "encode" }, live: (cfg) => { const r = rwSim(I, { sect: "encode", ...cfg }); const c = rwCheck(I, r); return K.metrics([{ name: "Writer p99", value: K.ms(r.wp99), ok: r.wp99 <= I.wT, target: `≤ ${I.wT} ms` }, { name: "Reader p99", value: K.ms(r.rp99), ok: r.rp99 <= I.rT, target: `≤ ${I.rT} ms` }, { name: "Peak memory", value: K.num(r.mem) + " MB", ok: r.mem <= I.memMB, target: `≤ ${K.num(I.memMB)} MB` }]) + K.verdict(c === true, c === true ? "meets all targets" : c); } };
      },
      accept(I, cfg) { const c = rwCheck(I, rwSim(I, { sect: "encode", ...cfg })); return c === true ? true : c[0].toUpperCase() + c.slice(1) + "."; },
      solve(I, spec) { for (const c of LB.byId.get("perf-rwlock-starvation").space(I, spec)) if (rwCheck(I, rwSim(I, { sect: "encode", ...c })) === true) return c; return null; },
      bad: (I) => I.lv === 1 ? [{ policy: "rp" }] : I.lv === 2 ? [{ policy: "wp", sect: "encode" }, { policy: "rp", sect: "encode" }] : [{ policy: "wp", sect: "copy" }, { policy: "cow", sect: "encode" }],
      hint: (I) => I.lv === 1 ? "With ~6 readers inside at any moment, how often is the reader count zero?" : I.lv === 2 ? "Even a fair lock can't make a 3 ms read fast enough. What's inside the read lock?" : "Any lock that blocks readers for 25 ms every 250 ms puts ~10% of reads over 5 ms.",
      concept: "Reader-writer locks: starvation and copy-on-write",
      how: "A reader-preferring RW lock lets new readers in whenever no writer holds the lock, so with overlapping readers the count never reaches zero and a writer can wait indefinitely (glibc's default rwlock prefers readers). Writer-preferring locks (Go's sync.RWMutex, Java's ReentrantReadWriteLock heuristics) block new readers once a writer waits, which bounds writer latency but makes readers queue behind the drain plus the write. Shrinking the read critical section helps every policy. When reads must never block and writes are rare, copy-on-write wins: readers load an atomic reference to an immutable snapshot, the writer builds a new copy and swaps it, at the cost of double memory during the swap.",
      rule: "Keep critical sections tiny, use a writer-preferring lock if writers must make progress, and switch to copy-on-write snapshots for read-mostly data with strict read latency.",
      why: (I, sol) => { const r = rwSim(I, { sect: "encode", ...sol }); return `${POL[sol.policy]}${sol.sect ? (sol.sect === "copy" ? " with encoding moved out of the lock" : "") : ""}: writer p99 ${K.ms(r.wp99)}, reader p99 ${K.ms(r.rp99)}${I.lv === 3 ? `, peak memory ${K.num(r.mem)} MB` : ""}.`; },
    },
  ]);

  /* ================= event loops and thread pools ================= */
  const LOOP_DIFFS = {
    pbkdf2: { file: "src/routes/auth.js", lines: [
      ["@", "@@ -18,8 +18,11 @@ router.post('/login', async (req, res) => {"],
      [" ", "  const { email, password } = req.body;"],
      [" ", "  const user = await db.users.findByEmail(email);"],
      [" ", "  if (!user) return res.status(401).end();"],
      ["-", "  const ok = await verifyPassword(password, user);"],
      ["+", "  const hash = crypto.pbkdf2Sync(password, user.salt, 600000, 32, 'sha256');", 1],
      ["+", "  const ok = crypto.timingSafeEqual(hash, user.passwordHash);"],
      [" ", "  if (!ok) return res.status(401).end();"],
      ["+", "  await audit.log({ userId: user.id, event: 'login' });"],
      [" ", "  res.json({ token: await issueToken(user) });"],
    ] },
    gzip: { file: "src/routes/exports.js", lines: [
      ["@", "@@ -31,7 +31,10 @@ router.get('/exports/:id', async (req, res) => {"],
      [" ", "  const rows = await db.exports.rows(req.params.id);   // up to 400k rows"],
      ["+", "  const csv = await toCsv(rows);                       // ~40 MB string"],
      ["+", "  const body = zlib.gzipSync(csv);", 1],
      ["+", "  res.set('Content-Encoding', 'gzip');"],
      ["-", "  res.send(await toCsv(rows));"],
      ["+", "  res.send(body);"],
      ["+", "  metrics.exportBytes.observe(body.length);"],
    ] },
    readsync: { file: "src/routes/geo.js", lines: [
      ["@", "@@ -9,6 +9,9 @@ router.get('/geo/:ip', async (req, res) => {"],
      [" ", "  const ip = req.params.ip;"],
      ["+", "  if (!net.isIP(ip)) return res.status(400).end();"],
      ["+", "  const db = JSON.parse(fs.readFileSync('/data/geoip-city.json', 'utf8'));   // 180 MB", 1],
      ["+", "  const hit = lookup(db, ip);"],
      ["-", "  const hit = await geoClient.lookup(ip);"],
      [" ", "  res.json(hit ?? {});"],
    ] },
  };
  const LOOP_L2 = { file: "src/routes/import.js", lines: [
    ["@", "@@ -40,9 +40,18 @@ router.post('/catalog/import', upload.single('file'), async (req, res) => {"],
    ["+", "  const raw = await fs.promises.readFile(req.file.path, 'utf8');   // uploads are ~80 MB"],
    ["+", "  const records = JSON.parse(raw);", 1],
    ["+", "  logger.info({ count: records.length }, 'import parsed');"],
    ["+", "  records.sort((a, b) => a.sku.localeCompare(b.sku));               // ~600k records", 1],
    ["+", "  const digest = await crypto.subtle.digest('SHA-256', Buffer.from(raw));"],
    ["+", "  await new Promise((r) => setImmediate(r));"],
    ["+", "  const resp = await fetch(`${PRICING_URL}/bulk`, { method: 'POST', body: JSON.stringify(records.slice(0, 500)) });"],
    ["-", "  await queue.publish('catalog.import', { path: req.file.path });"],
    [" ", "  res.status(202).json({ digest: Buffer.from(digest).toString('hex') });"],
  ] };
  const LOOP_L3 = { file: "src/routes/profile.js", lines: [
    ["@", "@@ -12,10 +12,19 @@ router.put('/profile', async (req, res) => {"],
    ["+", "  const { bio, password } = req.body;"],
    ["+", "  if (!/^(\\w+\\s?)*$/.test(bio)) return res.status(400).json({ error: 'bio: letters and spaces only' });", 1],
    ["+", "  const hash = password ? await bcrypt.hash(password, 12) : undefined;"],
    ["+", "  const prefs = JSON.parse(req.get('x-prefs') ?? '{}');                 // < 1 KB header"],
    ["+", "  for (const tag of req.body.tags) await tags.upsert(req.user.id, tag);"],
    ["+", "  const report = await buildActivityReport(req.user.id);                // ~120 MB object graph"],
    ["+", "  await cache.set(`report:${req.user.id}`, JSON.stringify(report));", 1],
    ["+", "  const id = crypto.randomUUID();"],
    [" ", "  await db.users.update(req.user.id, { bio, hash, prefs, reportId: id });"],
    [" ", "  res.status(204).end();"],
  ] };
  const loopDiff = (I) => (I.lv === 1 ? LOOP_DIFFS[I.v] : I.lv === 2 ? LOOP_L2 : LOOP_L3);

  const LOOP_ITEMS = [
    { t: "`await pool.query(sql)` with node-postgres", c: 0, d: 1 },
    { t: "`crypto.pbkdf2Sync(pw, salt, 600000, 32, 'sha256')` in the login handler", c: 1, d: 1 },
    { t: "`fs.readFileSync('/data/rates.json')` (90 MB) on every request", c: 1, d: 1 },
    { t: "`await fetch(url)` to a slow partner API", c: 0, d: 1 },
    { t: "`while (Date.now() < until) {}` as a retry delay", c: 1, d: 1 },
    { t: "`JSON.parse()` of a 60 MB request body", c: 1, d: 2 },
    { t: "`await fs.promises.readFile(path)` of a 60 MB file", c: 0, d: 2 },
    { t: "`zlib.gzipSync()` of a 40 MB export", c: 1, d: 2 },
    { t: "`await bcrypt.hash(pw, 12)` (native addon, async API)", c: 0, d: 2 },
    { t: "`rows.sort(...)` on 2 million rows", c: 1, d: 2 },
    { t: "`/^(\\w+\\s?)*$/.test(input)` where input is 40 word characters then '!'", c: 1, d: 3 },
    { t: "`JSON.parse()` of a 2 KB webhook payload", c: 0, d: 3 },
    { t: "`for (const x of items) await save(x)` over 10,000 items", c: 0, d: 3 },
    { t: "Python: `requests.get(url)` inside an `async def` FastAPI endpoint", c: 1, d: 3 },
    { t: "Python: `await asyncio.to_thread(parse_pdf, data)`", c: 0, d: 3 },
    { t: "`structuredClone(state)` of a 150 MB in-memory state object", c: 1, d: 3 },
  ];

  /* libuv thread pool model: bcrypt (CPU) and dns.lookup (blocking getaddrinfo) share UV_THREADPOOL_SIZE threads */
  function uvModel(I, cfg) {
    const T = cfg.size, N = I.cores, sp = I.sp, sd = I.sd;
    const lp = I.lp / 1000, ld = (I.ld * (cfg.ka === "on" ? 0.05 : 1)) / 1000; // per ms
    const rhoC = (lp * sp) / N;
    if (rhoC >= 0.98) return { sat: true, rhoC };
    const cpu = K.mmc(lp, 1 / sp, N);
    const stretch = T > N ? cpu.w / sp : 1; // CPU jobs time-share the cores once threads outnumber them
    const hp = sp * stretch, lam = lp + ld, sbar = (lp * hp + ld * sd) / lam;
    const pool = K.mmc(lam, 1 / sbar, T);
    if (pool.rho >= 0.99) return { sat: true, rhoC, poolRho: pool.rho };
    const w = wait99(lam, 1 / sbar, T);
    return { rhoC, poolRho: pool.rho, dns: w + sd * 3, login: w + hp * 1.6 + (T <= N ? 0 : 0), busy: lam * sbar };
  }
  const uvCheck = (I, r) => r.sat ? "the thread pool (or the CPU) is saturated: queues grow without bound" : r.dns > I.dT ? `outbound calls wait ${K.ms(r.dns)} at p99 for dns.lookup (target ${I.dT} ms)` : r.login > I.lT ? `login p99 is ${K.ms(r.login)} (target ${I.lT} ms)` : true;

  /* worker pool sizing model: c ms CPU + w ms waiting per task on N cores */
  function poolModel(I, T, c = I.c, w = I.w, lam = I.lam) {
    const ov = 1 + I.csw * Math.max(0, T - I.N) * (c / (c + w)); // scheduler and cache overhead from runnable threads beyond the cores
    const cEff = c * ov, l = lam / 1000;
    const rhoC = (l * cEff) / I.N;
    if (rhoC >= 0.98) return { sat: "cpu", rhoC, ov };
    const stretch = T > I.N ? K.mmc(l, 1 / cEff, I.N).w / cEff : 1;
    const s = w + cEff * stretch;
    const q = K.mmc(l, 1 / s, T);
    if (q.rho >= 0.99) return { sat: "pool", rhoC, rho: q.rho, ov };
    const p99 = wait99(l, 1 / s, T) + s * 2.3;
    return { p99, rhoC, rho: q.rho, ov, s, mem: T };
  }
  const poolChart = (I, cur, opts, f) => {
    const pts = opts.map((t) => { const r = f(t); return [t, r.p99 != null ? Math.min(r.p99, I.target * 4) : I.target * 4]; });
    return K.chart([{ name: "p99 latency", pts }], { hline: { y: I.target, label: `SLO ${I.target} ms` }, vline: cur != null ? { x: cur, label: "you" } : null, ymax: I.target * 4, xlabel: "threads", fmt: (v) => K.num(v) + " ms", title: "p99 vs pool size (capped at 4× SLO)" });
  };

  LB.addAll("perf", [
    /* 11 */ {
      id: "perf-blocked-event-loop",
      name: "Who blocked the event loop?",
      kind: "Code review",
      skills: ["diagnose"],
      w: "lines",
      gen(lv, R) { return { lv, v: lv === 1 ? R.pick(Object.keys(LOOP_DIFFS)) : lv, lag: R.int(4, 12) * 100 }; },
      text: (I) => `<p>Since this PR shipped, <b>every</b> endpoint of the Node.js service (health checks included) stalls for up to ${K.num(I.lag)} ms under load, and <code>perf_hooks.monitorEventLoopDelay()</code> p99 matches. Node runs your JavaScript on one thread: anything synchronous and slow stops all other requests.</p><p><b>Flag the ${I.lv === 1 ? "line" : "two lines"} that block the event loop.</b>${I.lv === 3 ? " Not everything slow blocks the loop." : ""}</p>`,
      ui: (I) => { const d = loopDiff(I); return { file: d.file, lines: d.lines.map(([k, t]) => ({ k, t })), k: I.lv === 1 ? 1 : 2 }; },
      ans: (I) => loopDiff(I).lines.map((x, i) => (x[2] ? i : -1)).filter((i) => i >= 0),
      diag: (I, a) => { const L = loopDiff(I).lines; const wrong = a.filter((i) => !L[i][2]); if (!wrong.length) return "Close: you flagged one blocking line but missed another."; const t = L[wrong[0]][1]; return /await|fetch|setImmediate|subtle|bcrypt\.hash|for \(const/.test(t) ? `<code>${esc(t.trim().slice(0, 70))}</code> awaits: the loop serves other requests while it waits${/for \(const/.test(t) ? " (slow for this request, but not blocking)" : ""}.` : `<code>${esc(t.trim().slice(0, 70))}</code> is cheap or tiny. Look for synchronous work proportional to a big input.`; },
      hint: (I) => I.lv === 1 ? "Look for a *Sync call or CPU work on a large input." : I.lv === 2 ? "Reading the file is async; what happens to its 80 MB contents afterwards?" : "One line is a regex that backtracks exponentially on a crafted input; another serialises a huge object.",
      concept: "Blocking the Node.js event loop",
      how: "Node executes JavaScript on a single thread. Awaited I/O (sockets, fs.promises, the async crypto and zlib APIs) is handed to the kernel or libuv's thread pool, so the loop keeps serving other requests. Anything synchronous runs to completion first: *Sync APIs, JSON.parse/stringify of big payloads, sorting large arrays, and regexes with catastrophic backtracking (nested quantifiers like (\\w+\\s?)* on input that almost matches, a ReDoS). While it runs, every request, timer and health check waits, so the symptom is a stall across all endpoints rather than one slow route.",
      rule: "Keep per-request synchronous work small and bounded; move CPU-heavy work to worker_threads or another service, stream large payloads, and use linear-time regexes (or RE2) on user input.",
      why: (I) => { const L = loopDiff(I).lines.filter((x) => x[2]).map((x) => `<code>${esc(x[1].trim().split("//")[0].trim().slice(0, 60))}</code>`); return `Blocking: ${L.join(" and ")}. ${I.lv === 1 ? "A synchronous call that takes hundreds of milliseconds freezes every other request for that long." : I.lv === 2 ? "fs.promises.readFile didn't block, but parsing and sorting its 80 MB result did." : "bcrypt.hash and the sequential awaits are slow for this request only; the regex and the 120 MB JSON.stringify stall everyone."}`; },
    },
    /* 12 */ {
      id: "perf-uv-threadpool",
      name: "Four threads for everything",
      kind: "Config change",
      skills: ["tune", "diagnose"],
      w: "tune",
      sense: "min",
      vname: "threads:",
      gen(lv, R) {
        if (lv === 1) return { lv, cores: 8, lp: R.pick([55, 60]), sp: 60, ld: R.pick([500, 600]), sd: 3, dT: 50, lT: 400 };
        if (lv === 2) return { lv, cores: 4, lp: R.pick([48, 52]), sp: 60, ld: R.pick([700, 800]), sd: 3, dT: 20, lT: 450 };
        return { lv, cores: 2, lp: R.pick([22, 24]), sp: 60, ld: R.pick([1500, 1800]), sd: 3, dT: 25, lT: 400 };
      },
      text: (I) => `<p>A Node.js auth gateway on ${I.cores} vCPUs does <code>await bcrypt.compare()</code> (~${I.sp} ms of CPU each) for <b>${I.lp} logins/s</b>, and calls internal services ${K.num(I.ld)} times/s with a fresh connection each time, so every call starts with <code>dns.lookup()</code> (blocking <code>getaddrinfo</code>, ~${I.sd} ms). Both run on libuv's thread pool, default <code>UV_THREADPOOL_SIZE=4</code>. Outbound calls now spend hundreds of ms "connecting".</p><p>Keep outbound-call setup p99 under <b>${I.dT} ms</b> and login p99 under <b>${I.lT} ms</b> with the fewest pool threads.</p>`,
      ui: (I) => {
        const knobs = [{ k: "size", label: "UV_THREADPOOL_SIZE", opts: [4, 8, 16, 32, 64], help: "set in the environment before Node starts" }];
        if (I.lv === 3) knobs.push({ k: "ka", label: "Outbound HTTP agent", opts: ["off", "on"], fmt: (v) => (v === "on" ? "keepAlive: true" : "new connection per call"), help: "reused connections skip dns.lookup" });
        return { knobs, init: { ka: "off" }, live: (cfg) => { const r = uvModel(I, { ka: "off", ...cfg }); const c = uvCheck(I, r); return K.metrics([{ name: "CPU (bcrypt)", value: K.pct(r.rhoC, 0), ok: r.rhoC < 0.9 }, { name: "Pool busy", value: r.poolRho != null ? K.pct(Math.min(1, r.poolRho), 0) : "–", ok: r.poolRho != null && r.poolRho < 0.85 }, { name: "Call setup p99", value: r.sat ? "∞" : K.ms(r.dns), ok: !r.sat && r.dns <= I.dT, target: `≤ ${I.dT} ms` }, { name: "Login p99", value: r.sat ? "∞" : K.ms(r.login), ok: !r.sat && r.login <= I.lT, target: `≤ ${I.lT} ms` }]) + K.verdict(c === true, c === true ? "both targets met" : c); } };
      },
      valid: (I, cfg) => uvCheck(I, uvModel(I, { ka: "off", ...cfg })),
      val: (I, cfg) => cfg.size + (cfg.ka === "on" ? 0.5 : 0),
      vfmt: (v) => String(Math.floor(v)),
      hint: (I) => I.lv === 1 ? "A 3 ms lookup waits behind 60 ms bcrypt jobs when all 4 threads are busy hashing." : I.lv === 2 ? "More threads than cores don't make bcrypt faster; they let short lookups get a thread while hashes time-share the CPU." : "Fewer lookups means fewer threads needed. Why does every call need a lookup at all?",
      concept: "libuv's shared thread pool",
      how: "Node offloads work with no non-blocking OS API to libuv's thread pool: fs operations, dns.lookup (getaddrinfo), the async crypto and zlib functions, and many native addons such as bcrypt. The pool defaults to 4 threads, shared by all of them. When 4 long CPU jobs occupy it, a 3 ms lookup queues behind them, so unrelated outbound calls look like slow connects. UV_THREADPOOL_SIZE must be set before the pool is first used (in the environment, not later in code). More threads than cores lets short tasks slip past long ones but doesn't add CPU; reusing connections (keep-alive) or dns.resolve (c-ares, off the pool) removes the lookups altogether.",
      rule: "Know what shares the libuv pool; size it above the number of concurrent long jobs, and keep DNS and hashing from competing (keep-alive, caching, or a separate worker for CPU work).",
      why: (I, sol) => { const r = uvModel(I, { ka: "off", ...sol }); return `With ${sol.size} threads${sol.ka === "on" ? " and keep-alive (95% fewer lookups)" : ""}, call setup p99 ≈ ${K.ms(r.dns)} and login p99 ≈ ${K.ms(r.login)}. At the default 4, lookups queued behind bcrypt jobs.`; },
    },
    /* 13 */ {
      id: "perf-loop-safe",
      name: "Safe on the loop?",
      kind: "Code review",
      skills: ["diagnose"],
      w: "classify",
      gen(lv, R) {
        const now = LOOP_ITEMS.filter((x) => x.d === lv), old = LOOP_ITEMS.filter((x) => x.d < lv);
        const picks = R.shuffle([...R.sample(now, lv === 1 ? 5 : lv === 2 ? 4 : 5), ...R.sample(old, lv === 1 ? 0 : 2)]);
        return { lv, items: picks.map((x) => x.t), cats: picks.map((x) => x.c) };
      },
      text: (I) => `<p>You're reviewing a batch of changes to async services (Node.js unless marked Python). For each operation in a request handler, decide whether it's fine on the event loop or blocks it, stalling every other request.</p>`,
      ui: (I) => ({ items: I.items, cats: ["Fine on the loop", "Blocks the loop"] }),
      ans: (I) => I.cats,
      diag: (I, a) => { const i = a.findIndex((x, k) => x !== I.cats[k]); return `Look again at “${esc(I.items[i])}”. ${I.cats[i] ? "It runs synchronously on the loop thread for a long time." : "It yields while it waits, or it's tiny."}`; },
      hint: () => "Blocking = synchronous work on the loop thread that takes a long time. Awaited I/O yields; slow-but-awaited isn't blocking.",
      concept: "What blocks an event loop",
      how: "An event loop runs one callback at a time. Awaiting I/O yields control, so even a slow fetch or a long sequence of awaits only delays that one request. Synchronous work holds the thread: *Sync APIs, busy-wait loops, parsing or cloning huge objects, big sorts and catastrophic regexes. Python's asyncio has the same rule: a blocking library call such as requests.get inside async def freezes the loop; asyncio.to_thread or an async client avoids it. Size matters: JSON.parse of 2 KB is microseconds, of 60 MB is hundreds of milliseconds.",
      rule: "In async code, ask 'does this hold the thread for more than a millisecond or so?' If yes, make it async, stream it, or move it to a worker.",
      why: (I) => `${I.cats.filter((c) => c).length} of the ${I.items.length} operations block; the rest yield while they wait or are too small to matter.`,
    },
    /* 14 */ {
      id: "perf-pool-cpu-vs-io",
      name: "Size the worker pool",
      kind: "Capacity plan",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "threads:",
      gen(lv, R) {
        if (lv === 1) return { lv, N: 8, c: R.pick([35, 40, 45]), w: 2, lam: R.pick([140, 150]), csw: 0.004, target: 250, opts: [4, 8, 12, 16, 32, 64, 128, 256] };
        if (lv === 2) return { lv, N: 8, c: 3, w: R.pick([90, 100, 120]), lam: R.pick([500, 600]), csw: 0.004, target: 450, opts: [8, 16, 32, 64, 96, 128, 192, 256, 512] };
        return { lv, N: 8, c: R.pick([30, 35]), w: R.pick([80, 100]), lam: R.pick([170, 180]), csw: 0.004, target: 500, ioOpts: [8, 16, 24, 32, 48, 64, 96], cpuOpts: [4, 8, 12, 16, 32, 64], opts: [] };
      },
      text: (I) => I.lv < 3 ? `<p>A Java worker service on <b>${I.N} cores</b> takes jobs from a queue at <b>${I.lam}/s</b>. Each job spends about <b>${I.c} ms on CPU</b> and <b>${I.w} ms waiting</b> on ${I.lv === 1 ? "a local cache" : "S3 and a partner API"}. The pool is a fixed-size <code>ThreadPoolExecutor</code>.</p><p>Choose the <b>smallest pool</b> that keeps job p99 under <b>${I.target} ms</b>. Extra threads aren't free: each costs a stack, and runnable threads beyond the core count add context switches and cache misses.</p>`
        : `<p>A thumbnail service on <b>${I.N} cores</b> handles <b>${I.lam} images/s</b>: a <b>${I.w} ms</b> S3 download (waiting) then a <b>${I.c} ms</b> resize (CPU). It used one pool for both; you're splitting it into an I/O pool and a CPU pool.</p><p>Keep p99 under <b>${I.target} ms</b> with the <b>fewest threads in total</b>.</p>`,
      ui: (I) => {
        if (I.lv < 3) return { knobs: [{ k: "T", label: "Pool size", opts: I.opts, help: "threads" }], live: (cfg) => { const T = cfg && cfg.T, r = poolModel(I, T); return K.metrics([{ name: "CPU busy", value: K.pct(Math.min(1, r.rhoC), 0), ok: r.rhoC < 0.85 }, { name: "Pool busy", value: r.rho != null ? K.pct(Math.min(1, r.rho), 0) : "100%", ok: r.rho != null && r.rho < 0.9 }, { name: "Overhead", value: "+" + K.pct(r.ov - 1, 0) + " CPU/job", ok: r.ov < 1.15 }, { name: "p99", value: msOr(r.p99), ok: fin(r.p99) && r.p99 <= I.target, target: `≤ ${I.target} ms` }]) + poolChart(I, T, I.opts, (t) => poolModel(I, t)); } };
        return { knobs: [{ k: "io", label: "I/O pool (download)", opts: I.ioOpts }, { k: "cpu", label: "CPU pool (resize)", opts: I.cpuOpts }], live: (cfg) => { const r = splitModel(I, cfg || {}); return K.metrics([{ name: "Download stage p99", value: msOr(r.io), ok: fin(r.io) }, { name: "Resize stage p99", value: msOr(r.cpu), ok: fin(r.cpu) }, { name: "Total p99", value: msOr(r.p99), ok: fin(r.p99) && r.p99 <= I.target, target: `≤ ${I.target} ms` }, { name: "Threads", value: String((cfg.io || 0) + (cfg.cpu || 0)), ok: null }]); } };
      },
      valid: (I, cfg) => { const p = I.lv < 3 ? poolModel(I, cfg.T).p99 : splitModel(I, cfg).p99; return fin(p) && p <= I.target ? true : `p99 is ${msOr(p)} (target ${I.target} ms)`; },
      val: (I, cfg) => (I.lv < 3 ? cfg.T : cfg.io + cfg.cpu),
      hint: (I) => I.lv === 1 ? "The job is almost all CPU. How many jobs can run at once on 8 cores?" : I.lv === 2 ? "Little's law: threads busy ≈ arrival rate × time each job holds a thread." : "The I/O pool needs ≈ rate × download time threads; the CPU pool needs about one thread per core.",
      concept: "Pool sizing for CPU-bound vs I/O-bound work",
      how: "A thread only needs a core while it's running. For CPU-bound jobs, threads beyond the core count just queue for the CPU and add context-switch and cache overhead, so the right size is about the number of cores. For I/O-bound jobs, a thread is parked most of the time, so you need roughly arrival rate × time per job (Little's law), or cores × (1 + wait/compute), plus headroom. Mixing both kinds in one pool means sizing for the I/O wait lets CPU work oversubscribe the cores; separate pools (or virtual threads for the waiting part) size each to its own bottleneck.",
      rule: "CPU-bound pool ≈ cores; I/O-bound pool ≈ rate × latency with ~20–30% headroom; split mixed work into separate pools.",
      why: (I, sol) => I.lv < 3 ? `${sol.T} threads is the smallest pool under ${I.target} ms (p99 ≈ ${K.ms(poolModel(I, sol.T).p99)}). ${I.lv === 1 ? `With ${I.c} ms of CPU per job, more threads than cores can't add throughput.` : `Little's law: ${I.lam}/s × ${I.w + I.c} ms ≈ ${Math.round((I.lam * (I.w + I.c)) / 1000)} threads busy on average.`}` : `I/O pool ${sol.io} (≈ ${I.lam}/s × ${I.w} ms = ${Math.round((I.lam * I.w) / 1000)} busy) and CPU pool ${sol.cpu} (${I.N} cores) give p99 ≈ ${K.ms(splitModel(I, sol).p99)}.`,
    },
    /* 15 */ {
      id: "perf-littles-law",
      name: "How many in flight?",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) return { lv, rps: R.int(12, 30) * 100, lat: R.pick([80, 120, 150, 250]) };
        if (lv === 2) return { lv, rps: R.int(30, 60) * 100, lat: R.pick([100, 150]), to: 1000, pto: R.pick([3, 4, 5]), pods: R.pick([8, 12, 16]) };
        const workers = R.pick([32, 48, 64]); return { lv, workers, queue: workers * R.pick([2, 3, 4]) + R.int(-5, 5), svc: R.pick([150, 200, 250]) };
      },
      text: (I) => I.lv === 1 ? `<p>The ${"checkout"} API serves <b>${K.num(I.rps)} requests/s</b> with a mean latency of <b>${I.lat} ms</b>. You're setting the gateway's concurrency limit and need to know: <b>how many requests are in flight on average?</b></p>`
        : I.lv === 2 ? `<p>${I.pods} pods serve <b>${K.num(I.rps)} requests/s</b> (evenly balanced) with mean latency <b>${I.lat} ms</b>. But <b>${I.pto}%</b> of first attempts hit the client's <b>${I.to} ms</b> timeout (the server keeps working on them until the timeout) and are retried once; retries take the normal ${I.lat} ms.</p><p><b>How many requests are in flight per pod on average?</b> (count timed-out attempts and retries)</p>`
          : `<p>A job worker pool of <b>${I.workers}</b> threads is pinned at 100% busy, and the queue in front of it holds a steady <b>${I.queue}</b> jobs. Logs say each job takes about <b>${I.svc} ms</b> once it starts.</p><p><b>What's the average time from enqueue to completion, in ms?</b></p>`,
      ui: (I) => ({ unit: I.lv === 3 ? "ms" : "requests" }),
      accept: (I, a) => LB.near(littleTruth, I.lv === 3 ? 0.12 : 0.1)(I, a),
      solve: (I) => Math.round(littleTruth(I)),
      bad: (I) => I.lv === 1 ? [I.rps * I.lat, Math.round(I.rps / I.lat)] : I.lv === 2 ? [Math.round((I.rps * I.lat) / 1000 / I.pods), Math.round((I.rps * I.lat) / 1000)] : [I.svc, Math.round((I.queue / ((I.workers * 1000) / I.svc)) * 1000)],
      hint: (I) => I.lv === 1 ? "L = λ × W. Mind the units: requests per second × seconds." : I.lv === 2 ? "Timed-out attempts occupy a slot for the full timeout, then the retry adds another normal request." : "First derive throughput from the busy workers (λ = workers / service time), then count everything in the system, queue included.",
      concept: "Little's law",
      how: "For any stable system, the average number of items inside equals the arrival rate times the average time each spends inside: L = λW. It holds regardless of the distribution, so it turns throughput and latency into required concurrency (threads, connections, pool slots) and back. Count everything that occupies the resource: attempts that time out still hold a slot until the server gives up, and retries add arrivals. Inverted, W = L/λ gives latency from a queue length; include queued items, not just the ones being served.",
      rule: "Concurrency = throughput × latency. Use it to size pools and limits, and to sanity-check any latency or queue number someone shows you.",
      why: (I) => I.lv === 1 ? `${K.num(I.rps)}/s × ${I.lat / 1000} s = ${K.num(littleTruth(I))} in flight.` : I.lv === 2 ? `First attempts that finish: ${100 - I.pto}% × ${K.num(I.rps)} × ${I.lat / 1000} s; timed-out attempts: ${I.pto}% × ${K.num(I.rps)} × 1 s; retries: ${I.pto}% × ${K.num(I.rps)} × ${I.lat / 1000} s; total ≈ ${K.num(littleTruth(I) * I.pods)}, or ≈ ${K.num(littleTruth(I))} per pod.` : `Throughput = ${I.workers} / ${I.svc / 1000} s = ${K.num((I.workers * 1000) / I.svc)} jobs/s; in system = ${I.workers} + ${I.queue}; W = ${I.workers + I.queue} / ${K.num((I.workers * 1000) / I.svc)} ≈ ${K.num(littleTruth(I))} ms.`,
    },
  ]);
  function littleTruth(I) {
    if (I.lv === 1) return (I.rps * I.lat) / 1000;
    if (I.lv === 2) { const f = I.pto / 100; return (I.rps * (1 - f) * (I.lat / 1000) + I.rps * f * (I.to / 1000) + I.rps * f * (I.lat / 1000)) / I.pods; }
    return ((I.workers + I.queue) / ((I.workers * 1000) / I.svc)) * 1000;
  }
  function splitModel(I, cfg) {
    if (!cfg.io || !cfg.cpu) return { p99: Infinity, io: Infinity, cpu: Infinity };
    const io = poolModel({ ...I, csw: 0 }, cfg.io, 0.0001, I.w);
    const cpu = poolModel(I, cfg.cpu, I.c, 0.0001);
    const a = io.p99 != null ? io.p99 : Infinity, b = cpu.p99 != null ? cpu.p99 : Infinity;
    return { io: a, cpu: b, p99: a + b };
  }

  /* ================= queueing, tails, hedging, benchmarks, batching ================= */
  const Z = { p50: 0, p90: 1.2816, p99: 2.3263, "p99.9": 3.0902, "p99.95": 3.2905, "p99.99": 3.719 };
  function kneeTruth(I) {
    if (I.lv === 1) return I.S / (1 - I.rho2);
    if (I.lv === 2) { const S = I.lat * (1 - I.rho1); return S / (1 - I.rho1 * (1 + I.g)); }
    const mu = 1000 / I.S, lmax = Math.min(mu - 1000 / I.A, mu - (Math.log(100) * 1000) / I.B);
    return Math.ceil(I.X / lmax);
  }
  function fanTruth(I) {
    if (I.lv === 1) return (1 - 0.99 ** I.N) * 100;
    if (I.lv === 2) return I.med * Math.exp(I.sig * Z[I.N === 10 ? "p99.9" : "p99.95"]);
    return (1 - (1 - I.p / 100) ** (I.N - I.bad) * (1 - I.q / 100) ** I.bad) * 100;
  }
  /* open-loop latencies for a run with stalls: requests scheduled every 1/r s, a stall delays everything scheduled inside it */
  function coLat(I) {
    const out = [], n = Math.round(I.T * I.r);
    for (let k = 0; k < n; k++) {
      const t = k / I.r;
      let lat = I.base;
      for (const [s, L] of I.stalls) if (t >= s && t < s + L) lat = (s + L - t) * 1000 + I.base;
      out.push(lat);
    }
    return out;
  }
  function coTruth(I) {
    const lat = coLat(I);
    if (I.lv === 1) return lat.filter((x) => x > 100).length;
    return K.quantile(lat, I.lv === 2 ? 0.99 : 0.999);
  }

  /* hedged requests: Monte Carlo over a fixed sample of request pairs */
  const hedgeCache = new Map();
  function hedgeSamples(I) {
    if (hedgeCache.has(I.seed)) return hedgeCache.get(I.seed);
    const R = rng(I.seed), M = 20000, a = new Float64Array(M), b = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      a[i] = K.logn(R, I.med, 0.35); b[i] = K.logn(R, I.med, 0.35);
      if (R.next() < I.pSlow) a[i] += I.slowLo + R.next() * (I.slowHi - I.slowLo);
      if (R.next() < I.pSlow) b[i] += I.slowLo + R.next() * (I.slowHi - I.slowLo);
      if (R.next() < (I.pCorr || 0)) { const x = I.slowLo + R.next() * (I.slowHi - I.slowLo); a[i] += x; b[i] += x; }
    }
    const v = { a, b, M };
    hedgeCache.set(I.seed, v);
    return v;
  }
  function hedgeEval(I, d) {
    const { a, b, M } = hedgeSamples(I);
    let f = 1, extra = 0, lat = new Float64Array(M);
    for (let it = 0; it < (I.k ? 6 : 1); it++) {
      let h = 0;
      for (let i = 0; i < M; i++) { const l1 = a[i] * f; if (d == null || l1 <= d) lat[i] = l1; else { h++; lat[i] = Math.min(l1, d + b[i] * f); } }
      extra = h / M;
      const nf = 1 + (I.k || 0) * extra;
      if (Math.abs(nf - f) < 1e-4) break;
      f = (f + nf) / 2;
    }
    const s = Array.from(lat).sort((x, y) => x - y);
    return { p99: s[Math.ceil(0.99 * M) - 1], p999: s[Math.ceil(0.999 * M) - 1], extra, f };
  }
  const hedgeDelays = (I) => { const { a } = hedgeSamples(I), s = Array.from(a).sort((x, y) => x - y), q = (p) => Math.round(s[Math.ceil(p * s.length) - 1]); const o = { off: null }; I.pcts.forEach((p) => (o["p" + p] = q(p / 100))); return o; };
  const hedgeCheck = (I, r) => r.extra > I.budget + 1e-9 ? `hedges add ${K.pct(r.extra)} extra backend load (budget ${K.pct(I.budget, 0)})` : r.p99 > I.target ? `p99 is ${K.ms(r.p99)} (target ${K.ms(I.target)})` : true;

  /* batching writer: one writer flushes when the batch is full or maxWait after its first item; each flush costs o + n*p ms */
  function batchSim(lam, o, p, maxB, maxW, seed, dur) {
    const R = rng(seed), arr = [];
    let t = 0;
    for (;;) { t += K.exp(R, 1000 / lam); if (t >= dur) break; arr.push(t); }
    const lat = []; let free = 0, i = 0, calls = 0;
    while (i < arr.length) {
      const first = arr[i], deadline = Math.max(free, first + maxW);
      let j = i;
      while (j < arr.length && j - i < maxB && arr[j] <= deadline) j++;
      const full = j - i >= maxB;
      const start = full ? Math.max(free, arr[j - 1]) : deadline;
      const done = start + o + p * (j - i);
      for (let k = i; k < j; k++) lat.push(done - arr[k]);
      free = done; calls++; i = j;
    }
    return { p99: K.quantile(lat, 0.99), calls: (calls / dur) * 1000, backlog: free - dur };
  }
  function batchRun(I, cfg) {
    const pk = batchSim(I.peak, I.o, I.p, cfg.maxB, cfg.maxW, I.seed + "/peak", 2000);
    const nt = I.night ? batchSim(I.night, I.o, I.p, cfg.maxB, cfg.maxW, I.seed + "/night", 30000) : null;
    return { pk, nt, cost: I.lv === 3 ? pk.calls * 8 * 3600 + (nt ? nt.calls * 16 * 3600 : 0) : pk.calls };
  }
  const batchCheck = (I, cfg, r) => I.maxRows && cfg.maxB > I.maxRows ? `the bulk API rejects batches over ${I.maxRows} rows (HTTP 413)` : r.pk.backlog > 200 ? `the writer can't keep up at peak: backlog grows (each call is ${I.o} ms + ${I.p} ms/row)` : r.pk.p99 > I.target ? `peak p99 is ${K.ms(r.pk.p99)} (target ${I.target} ms)` : r.nt && r.nt.p99 > I.target ? `off-peak p99 is ${K.ms(r.nt.p99)}: at ${I.night} rows/s batches rarely fill, so items wait the full maxWait` : true;

  LB.addAll("perf", [
    /* 16 */ {
      id: "perf-utilisation-knee",
      name: "Where the latency curve bends",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) return { lv, S: R.pick([10, 20, 25, 40]), rho2: R.pick([0.9, 0.95]) };
        if (lv === 2) return { lv, lat: R.pick([40, 50, 60]), rho1: R.pick([0.6, 0.65, 0.7]), g: R.pick([0.2, 0.25, 0.3]) };
        return { lv, S: R.pick([5, 8, 10]), A: 40, B: R.pick([100, 120]), X: R.int(15, 30) * 100 };
      },
      text: (I) => I.lv === 1 ? `<p>A single-threaded worker (M/M/1: random arrivals, ${I.S} ms average service time) has this mean latency curve, measured up to 80% busy:</p>${K.chart([{ name: "mean latency", pts: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((r) => [Math.round(r * 100), I.S / (1 - r)]) }], { xlabel: "% busy", fmt: (v) => K.num(v) + " ms", title: "measured mean latency" })}<p>Product wants to run it at <b>${Math.round(I.rho2 * 100)}% busy</b> to save money. <b>What mean latency should they expect, in ms?</b></p>`
        : I.lv === 2 ? `<p>A queue-backed service (behaves like M/M/1) runs at <b>${Math.round(I.rho1 * 100)}% utilisation</b> with a mean latency of <b>${I.lat} ms</b>. Marketing expects <b>${Math.round(I.g * 100)}% more traffic</b> next week. A colleague says "latency will grow ${Math.round(I.g * 100)}% too". <b>What mean latency do you predict, in ms?</b></p>`
          : `<p>Each instance of a service is a single worker (M/M/1) with a ${I.S} ms mean service time. The SLO: mean latency ≤ <b>${I.A} ms</b> <i>and</i> p99 ≤ <b>${I.B} ms</b>. In M/M/1 the response time is exponential with rate μ − λ, so p99 = ln(100)/(μ − λ) ≈ 4.6/(μ − λ).</p><p>Peak load is <b>${K.num(I.X)} requests/s</b>, balanced evenly. <b>How many instances do you need?</b></p>`,
      ui: (I) => ({ unit: I.lv === 3 ? "instances" : "ms" }),
      accept: (I, a) => (I.lv === 3 ? (a == null || !fin(a) ? "Enter a number." : Math.abs(a - kneeTruth(I)) <= Math.max(1, 0.06 * kneeTruth(I)) ? true : a < kneeTruth(I) ? "Too few: check the p99 constraint, not just the mean." : "More than you need.") : LB.near(kneeTruth, 0.1)(I, a)),
      solve: (I) => Math.round(kneeTruth(I) * (I.lv === 3 ? 1 : 10)) / (I.lv === 3 ? 1 : 10),
      bad: (I) => I.lv === 1 ? [Math.round((I.S / 0.2) * (I.rho2 / 0.8))] : I.lv === 2 ? [Math.round(I.lat * (1 + I.g))] : [Math.ceil(I.X / (1000 / I.S - 1000 / I.A))],
      hint: (I) => I.lv === 1 ? "M/M/1 mean response time = S / (1 − ρ). It isn't linear." : I.lv === 2 ? "Back out the service time from today's numbers first: S = W × (1 − ρ)." : "Find the largest λ per instance that satisfies both constraints; the p99 one is tighter.",
      concept: "Utilisation and the latency knee",
      how: "In a queue with random arrivals, waiting time grows like ρ/(1 − ρ): doubling utilisation from 40% to 80% quadruples queueing, and the last few percent toward 100% explode it. For M/M/1 the mean response time is S/(1 − ρ) and the whole distribution is exponential with rate μ − λ, so tails are ~4.6× the mean at p99. Multi-server queues (M/M/c, Erlang C) bend later and more sharply but the shape is the same. That's why capacity is planned to a utilisation target (often 60–80%) and why p99 SLOs need more headroom than mean SLOs.",
      rule: "Don't extrapolate latency linearly with load; back out the service time, apply S/(1 − ρ), and plan to the tail SLO, which binds before the mean.",
      why: (I) => I.lv === 1 ? `${I.S} / (1 − ${I.rho2}) = ${K.num(kneeTruth(I))} ms, versus ${K.num(I.S / 0.2)} ms at 80%.` : I.lv === 2 ? `S = ${I.lat} × (1 − ${I.rho1}) = ${K.num(I.lat * (1 - I.rho1), 1)} ms; new ρ = ${K.num(I.rho1 * (1 + I.g), 3)}; W = S / (1 − ρ) ≈ ${K.num(kneeTruth(I))} ms, not ${Math.round(I.lat * (1 + I.g))} ms.` : `μ = ${K.num(1000 / I.S)}/s. The mean needs μ − λ ≥ ${K.num(1000 / I.A)}; p99 needs μ − λ ≥ ${K.num((Math.log(100) * 1000) / I.B, 1)}, so λ ≤ ${K.num(1000 / I.S - (Math.log(100) * 1000) / I.B, 1)}/s per instance → ${kneeTruth(I)} instances.`,
    },
    /* 17 */ {
      id: "perf-fanout-tail",
      name: "Tail at scale",
      kind: "Estimate",
      skills: ["estimate", "design"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) return { lv, N: R.pick([20, 50, 100]) };
        if (lv === 2) return { lv, N: R.pick([10, 20]), med: R.pick([8, 10, 12]), sig: R.pick([0.55, 0.6, 0.7]) };
        return { lv, N: R.pick([40, 50, 60]), p: R.pick([0.05, 0.1]), bad: R.pick([2, 3]), q: R.pick([4, 5, 6]) };
      },
      text: (I) => I.lv === 1 ? `<p>A search query fans out to <b>${I.N} shards</b> in parallel and waits for all of them. Each shard is slower than 1 s on <b>1%</b> of requests, independently. <b>What percentage of user queries take longer than 1 s?</b></p>`
        : I.lv === 2 ? `<p>A page waits for <b>${I.N}</b> parallel calls to the same backend. The backend's latency percentiles:</p>${K.table(["p50", "p90", "p99", "p99.9", "p99.95", "p99.99"], [Object.keys(Z).map((k) => K.ms(I.med * Math.exp(I.sig * Z[k])))], { compact: true })}<p><b>What's the page's p99 latency</b> (from these calls alone), in ms?</p>`
          : `<p>A query fans out to <b>${I.N}</b> leaves. Healthy leaves exceed the 200 ms budget on <b>${I.p}%</b> of calls. <b>${I.bad}</b> leaves sit on a host with a noisy neighbour and exceed it on <b>${I.q}%</b> of calls. <b>What percentage of user queries exceed 200 ms?</b></p>`,
      ui: (I) => ({ unit: I.lv === 2 ? "ms" : "%" }),
      accept: (I, a) => LB.near(fanTruth, 0.1)(I, a),
      solve: (I) => Math.round(fanTruth(I) * 10) / 10,
      bad: (I) => I.lv === 1 ? [1, 99] : I.lv === 2 ? [Math.round(I.med * Math.exp(I.sig * Z.p99))] : [Math.round((1 - (1 - I.p / 100) ** I.N) * 1000) / 10],
      hint: (I) => I.lv === 1 ? "The query is fast only if every shard is fast: 0.99^N." : I.lv === 2 ? `The page is under X only if all ${I.N} calls are. Which backend percentile q satisfies q^${I.N} = 0.99?` : "Multiply the probabilities that each leaf is fast, healthy and degraded separately.",
      concept: "Tail latency amplification under fan-out",
      how: "When a request waits for N parallel sub-requests, it is as slow as the slowest one. If each is slow with probability p, the request is slow with probability 1 − (1 − p)^N: with 100 sub-requests, a 1-in-100 backend hiccup hits 63% of user requests. Equivalently, the user's p99 is the backend's 0.99^(1/N) quantile: about p99.9 at N = 10 and p99.99 at N = 100. A few degraded leaves dominate the user tail, so fixing or ejecting outliers often matters more than tuning the median, and techniques like hedged requests, partial results and tail-tolerant timeouts exist for this reason.",
      rule: "For fan-out of N, set leaf SLOs at the 1 − (1 − target)/N percentile and hunt the worst few leaves first.",
      why: (I) => I.lv === 1 ? `1 − 0.99^${I.N} = ${K.num(fanTruth(I), 1)}% of queries hit at least one slow shard.` : I.lv === 2 ? `0.99^(1/${I.N}) ≈ ${I.N === 10 ? "0.999" : "0.9995"}, so the page's p99 is the backend's ${I.N === 10 ? "p99.9" : "p99.95"}: ≈ ${K.ms(fanTruth(I))}.` : `1 − ${1 - I.p / 100}^${I.N - I.bad} × ${1 - I.q / 100}^${I.bad} ≈ ${K.num(fanTruth(I), 1)}%; the ${I.bad} degraded leaves alone cause most of it (a healthy fleet would give ${K.num((1 - (1 - I.p / 100) ** I.N) * 100, 1)}%).`,
    },
    /* 18 */ {
      id: "perf-hedged-requests",
      name: "Hedge the tail",
      kind: "Experiment",
      skills: ["tune", "design"],
      w: "tune",
      sense: "min",
      vname: "extra load",
      vfmt: (v) => K.pct(v),
      gen(lv, R) {
        const I = { lv, seed: `perf-hedge/${lv}/${R.int(1, 1e9)}`, med: R.pick([8, 10, 12]), pSlow: lv === 3 ? 0.03 : R.pick([0.025, 0.03]), slowLo: 120, slowHi: 400, k: lv === 1 ? 0 : 1.2, pCorr: lv === 3 ? 0.003 : 0, pcts: lv === 3 ? [50, 90, 95, 97, 99] : [50, 90, 95, 99], budget: lv === 3 ? 0.04 : 0.12 };
        const D0 = hedgeDelays(I);
        const pick = lv === 3 ? D0.p97 : D0.p95;
        const r = hedgeEval(I, pick);
        I.target = Math.ceil((r.p99 * 1.15) / 5) * 5;
        // the intended answer must pass and the tempting ones must fail
        if (hedgeCheck(I, hedgeEval(I, null)) === true || hedgeCheck(I, hedgeEval(I, D0.p99)) === true) return null;
        if (lv > 1 && hedgeCheck(I, hedgeEval(I, D0.p50)) === true) return null;
        if (lv === 3 && hedgeCheck(I, hedgeEval(I, D0.p95)) === true) return null;
        return I;
      },
      text: (I) => `<p>A read API calls a replicated key-value store. Median latency is ~${I.med} ms, but about ${K.pct(I.pSlow, 1)} of calls hit a replica pausing for GC or compaction and take ${I.slowLo}–${I.slowHi} ms${I.lv === 3 ? "; a few requests are slow on every replica (huge values)" : ""}. Hedging: if the first call hasn't answered after a delay, send a second call to another replica and take whichever answers first.</p><p>Pick the hedge delay that gets p99 under <b>${K.ms(I.target)}</b> with extra backend load ≤ <b>${K.pct(I.budget, 0)}</b>, using as little extra load as possible.${I.lv > 1 ? " Careful: the store slows down as its load rises." : ""}</p>`,
      ui: (I) => { const DL = hedgeDelays(I); return { knobs: [{ k: "d", label: "Hedge after", opts: Object.keys(DL), fmt: (v) => (v === "off" ? "never" : `${v} (${DL[v]} ms)`), help: "delay before sending the backup call" }], init: { d: "off" }, live: (cfg) => { const r = hedgeEval(I, DL[(cfg && cfg.d) || "off"]); const c = hedgeCheck(I, r); return K.metrics([{ name: "p99", value: K.ms(r.p99), ok: r.p99 <= I.target, target: `≤ ${K.ms(I.target)}` }, { name: "p99.9", value: K.ms(r.p999), ok: null }, { name: "Extra load", value: K.pct(r.extra), ok: r.extra <= I.budget, target: `≤ ${K.pct(I.budget, 0)}` }, ...(I.k ? [{ name: "Store slowdown", value: "×" + r.f.toFixed(2), ok: r.f < 1.1 }] : [])]) + K.chart([{ name: "p99 by hedge delay", pts: Object.keys(DL).slice(1).map((k, i) => [i, Math.min(hedgeEval(I, DL[k]).p99, I.target * 3)]) }], { hline: { y: I.target, label: "target" }, fmt: (v) => K.num(v) + " ms", xfmt: (x) => Object.keys(DL)[x + 1] || "", title: `p99 for hedge at ${Object.keys(DL).slice(1).join(", ")}` }) + K.verdict(c === true, c === true ? "within target and budget" : c); } }; },
      valid: (I, cfg) => hedgeCheck(I, hedgeEval(I, hedgeDelays(I)[cfg.d])),
      val: (I, cfg) => K.round(hedgeEval(I, hedgeDelays(I)[cfg.d]).extra, 5),
      hint: (I) => I.lv === 1 ? "Hedging after the median doubles load for little gain; hedging after p99 is too late to save the p99." : I.lv === 2 ? "Extra calls slow the store for everyone. Find the latest delay that still fixes the tail." : "Each step earlier costs a few % of load. The budget rules out the usual p95.",
      concept: "Hedged requests",
      how: "Most tail latency comes from transient per-server events (GC pauses, compaction, a noisy neighbour) that a different replica is unlikely to share. Sending a backup request after the primary has been outstanding longer than, say, its p95 means only ~5% of requests are duplicated, yet the slow ones usually get rescued by the backup. Hedge too early and you add load proportional to how early (hedging at p50 doubles half the traffic), which slows the backend and can cause the very latency you're fighting. Hedge too late and the backup can't finish in time to help the percentile you care about. Hedging can't fix slowness that every replica shares, and it's only safe for idempotent reads.",
      rule: "Hedge idempotent reads at roughly the p95 of normal latency, cap the extra load, and measure the backend's load response before going earlier.",
      why: (I, sol) => { const r = hedgeEval(I, hedgeDelays(I)[sol.d]); return `Hedging at ${sol.d} (${hedgeDelays(I)[sol.d]} ms) gave p99 ${K.ms(r.p99)} for ${K.pct(r.extra)} extra load.${I.lv === 3 ? " Requests that are slow on every replica stay slow; that floor is why p99.9 barely moves." : ""}`; },
    },
    /* 19 */ {
      id: "perf-coordinated-omission",
      name: "The benchmark that hid the stall",
      kind: "Estimate",
      skills: ["estimate", "diagnose"],
      w: "num",
      gen(lv, R) {
        const r = R.pick([100, 200, 500]), base = 1;
        if (lv === 1) return { lv, r, base, T: 60, stalls: [[R.int(10, 40), R.pick([1.5, 2, 3])]] };
        if (lv === 2) return { lv, r, base, T: 60, stalls: [[R.int(10, 40), R.pick([1.5, 2, 2.5, 3])]] };
        return { lv, r, base, T: 120, stalls: [[R.int(10, 40), R.pick([0.4, 0.6])], [R.int(60, 100), R.pick([0.25, 0.3])]] };
      },
      text: (I) => { const s = I.stalls.map(([a, L]) => `<b>${L * 1000} ms</b> stall at t = ${a} s`).join(" and "); return `<p>A load test drives a service at a target of <b>${I.r} requests/s</b> for ${I.T} s, but the tool is closed-loop: each connection waits for a response before sending the next request. Normally responses take ${I.base} ms. During the run there was a ${s} (a GC pause). The tool's report: p99 = ${I.base} ms, max = ${I.stalls[0][1] * 1000} ms, ${I.stalls.length === 1 ? "one slow sample" : "two slow samples"}.</p><p>${I.lv === 1 ? "With a constant-rate (open-loop) generator, <b>how many requests would have taken longer than 100 ms?</b>" : I.lv === 2 ? "<b>What's the real p99 a constant-rate client would have seen</b>, in ms?" : "<b>What's the real p99.9</b> a constant-rate client would have seen, in ms?"}</p>`; },
      ui: (I) => ({ unit: I.lv === 1 ? "requests" : "ms" }),
      accept: (I, a) => LB.near(coTruth, 0.1)(I, a),
      solve: (I) => Math.round(coTruth(I)),
      bad: (I) => I.lv === 1 ? [1] : [I.base, I.stalls[0][1] * 1000],
      hint: (I) => I.lv === 1 ? "The stall delayed every request that was supposed to be sent during it." : I.lv === 2 ? "Requests scheduled during the stall waited from their send time until it ended. Which latency is exceeded by exactly 1% of all requests?" : "List each stall's delayed requests (latency falls linearly from the stall length to 0); find the value exceeded by 0.1% of all requests.",
      concept: "Coordinated omission",
      how: "A closed-loop load generator only sends the next request after the previous response, so when the server stalls, the generator stalls with it and simply doesn't send the requests that real users, arriving independently, would have sent. The stall shows up as one slow sample instead of thousands, and percentiles look excellent. With a constant-rate (open-loop) schedule, every request intended during an L-second stall waits until it ends, so a 2 s stall in a 60 s run at any rate puts ~3% of requests between 0 and 2 s. Tools like wrk2 and k6's constant-arrival-rate executor, or HdrHistogram's expected-interval correction, measure latency from the intended send time.",
      rule: "Benchmark latency with an open-loop, constant-arrival-rate generator and measure from the intended send time; distrust any p99 from a closed-loop tool.",
      why: (I) => { const lat = coLat(I); return I.lv === 1 ? `At ${I.r}/s, a ${I.stalls[0][1]} s stall delays ~${K.num(coTruth(I))} requests by more than 100 ms; the closed-loop tool recorded just one.` : `${K.num(lat.filter((x) => x > 10).length)} of ${K.num(lat.length)} requests were delayed by the stall${I.stalls.length > 1 ? "s" : ""}; the true ${I.lv === 2 ? "p99" : "p99.9"} is ≈ ${K.ms(coTruth(I))}, not ${I.base} ms.`; },
    },
    /* 20 */ {
      id: "perf-batching-latency",
      name: "Batch size vs latency",
      kind: "Config change",
      skills: ["tune"],
      w: "tune",
      sense: "min",
      vname: "cost:",
      vfmt: (v) => K.num(v),
      gen(lv, R) {
        const base = { lv, seed: `perf-batch/${lv}/${R.int(1, 1e9)}`, o: R.pick([4, 5]), p: 0.02 };
        if (lv === 1) return { ...base, peak: R.pick([2000, 3000]), target: R.pick([40, 50]) };
        if (lv === 2) return { ...base, peak: R.pick([4000, 5000]), night: R.pick([20, 40]), target: R.pick([18, 22]) };
        return { ...base, peak: R.pick([6000, 8000]), night: R.pick([30, 50]), target: R.pick([25, 30]), maxRows: 500 };
      },
      text: (I) => `<p>An ingest service writes events to a store whose insert call costs <b>${I.o} ms</b> of round trip and commit plus ${I.p} ms per row, from a single writer. Events arrive at <b>${K.num(I.peak)}/s</b> at peak${I.night ? ` and <b>${I.night}/s</b> off-peak` : ""}. The writer flushes when a batch reaches <i>max batch</i> rows or <i>max wait</i> after its first row.</p><p>Keep event-to-commit p99 under <b>${I.target} ms</b>${I.night ? " at peak <i>and</i> off-peak" : ""}${I.maxRows ? `; the bulk API rejects batches over ${I.maxRows} rows` : ""}, with the fewest ${I.lv === 3 ? "calls per day (8 h peak, 16 h off-peak; calls are billed)" : "insert calls per second at peak"}.</p>`,
      ui: (I) => ({ knobs: [{ k: "maxB", label: "Max batch", opts: [1, 10, 50, 200, 500, 1000], unit: "rows" }, { k: "maxW", label: "Max wait", opts: [0, 1, 5, 10, 20, 50], unit: "ms" }], live: (cfg) => { if (!cfg) return ""; const r = batchRun(I, cfg), c = batchCheck(I, cfg, r); return K.metrics([{ name: "Peak p99", value: r.pk.backlog > 200 ? "∞ (backlog grows)" : K.ms(r.pk.p99), ok: r.pk.backlog <= 200 && r.pk.p99 <= I.target, target: `≤ ${I.target} ms` }, ...(r.nt ? [{ name: "Off-peak p99", value: K.ms(r.nt.p99), ok: r.nt.p99 <= I.target, target: `≤ ${I.target} ms` }] : []), { name: "Calls/s at peak", value: K.num(r.pk.calls), ok: null }, ...(I.lv === 3 ? [{ name: "Calls per day", value: K.num(r.cost), ok: null }] : [])]) + K.verdict(c === true, c === true ? "meets the latency target" : c); } }),
      valid: (I, cfg) => batchCheck(I, cfg, batchRun(I, cfg)),
      val: (I, cfg) => Math.round(batchRun(I, cfg).cost),
      hint: (I) => I.lv === 1 ? "One row per call can't keep up: each call has a fixed cost. Bigger batches amortise it, but each row waits for its batch." : I.lv === 2 ? "Off-peak, a big batch never fills, so every row waits the whole max wait." : "The 413 limit caps the batch; then balance max wait between the off-peak latency and the number of calls.",
      concept: "Batching: amortised overhead vs added latency",
      how: "A fixed per-call cost (round trip, commit, fsync, request overhead) limits a one-at-a-time writer to 1/overhead calls per second. Batching amortises it: n rows cost overhead + n × per-row, so throughput rises and per-call cost falls. The price is latency: a row waits until its batch is full or the linger timer fires. At high rates batches fill quickly and the timer rarely matters; at low rates they never fill, so every row waits the full max wait. Kafka producers (batch.size, linger.ms), database bulk inserts and log shippers all expose the same pair of knobs.",
      rule: "Batch by size and time: size the batch for peak throughput, and set the max wait from the latency budget at your quietest traffic, not your busiest.",
      why: (I, sol) => { const r = batchRun(I, sol); return `Max batch ${sol.maxB}, max wait ${sol.maxW} ms: peak p99 ${K.ms(r.pk.p99)}${r.nt ? `, off-peak p99 ${K.ms(r.nt.p99)}` : ""}, ${K.num(r.pk.calls)} calls/s at peak. One row per call would need ${K.num(I.peak)} calls/s at ${I.o} ms each, ${K.num((I.peak * I.o) / 1000, 1)} s of work per second.`; },
    },
  ]);
})();
