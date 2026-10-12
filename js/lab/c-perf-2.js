/* Systems Lab · Concurrency & performance (part 2): connections, overload, GC, leaks, cancellation, budgets, layout, benchmarks. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const rng = (s) => D.campaign.rng(s);
  const fin = (x) => Number.isFinite(x);
  const msOr = (x) => (fin(x) ? K.ms(x) : "∞ (queue grows)");
  const wait99 = (lam, mu, c) => { const x = K.mmc(lam, mu, c); if (x.rho >= 1) return Infinity; return x.pw <= 0.01 ? 0 : Math.log(x.pw / 0.01) / (c * mu - lam); };
  const diffLines = (L) => L.map(([k, t]) => ({ k, t }));
  const flagged = (L) => L.map((x, i) => (x[2] ? i : -1)).filter((i) => i >= 0);

  /* ---------- N+1 diffs ---------- */
  const NP1 = [
    { file: "orders/views.py", lines: [
      ["@", "@@ -10,7 +10,11 @@ def order_list(request):"],
      [" ", "    orders = Order.objects.filter(customer=request.user).order_by('-created_at')[:50]"],
      ["+", "    currency = request.user.profile.currency"],
      [" ", "    rows = []"],
      [" ", "    for o in orders:"],
      ["-", "        rows.append({'id': o.id, 'total': str(o.total)})"],
      ["+", "        rows.append({'id': o.id, 'total': str(o.total), 'store': o.store.name})", 1],
      ["+", "    log.info('listed %d orders', len(rows))"],
      [" ", "    return JsonResponse({'orders': rows, 'currency': currency})"],
    ] },
    { file: "src/cart/summary.ts", lines: [
      ["@", "@@ -22,8 +22,14 @@ export async function cartSummary(cartId: string, userId: string) {"],
      [" ", "  const items = await cartRepo.items(cartId);                    // ~40 items"],
      ["+", "  const prices = await Promise.all(items.map((i) => pricing.get(i.sku)));", 1],
      ["+", "  const user = await users.get(userId);"],
      ["+", "  for (const i of items) { i.stock = await inventory.check(i.sku); }", 1],
      ["+", "  const promo = await promos.forCart(cartId);"],
      ["+", "  const total = items.reduce((s, i, k) => s + prices[k] * i.qty, 0);"],
      [" ", "  return { items, total, promo, tier: user.tier };"],
    ] },
    { file: "src/graphql/resolvers.ts", lines: [
      ["@", "@@ -5,9 +5,16 @@ export const resolvers = {"],
      [" ", "  Query: { orders: (_, args, ctx) => ctx.db.orders.list(args) },        // 100 per page"],
      ["+", "  Order: {"],
      ["+", "    customer: (o, _, ctx) => ctx.loaders.customer.load(o.customerId),"],
      ["+", "    items: (o, _, ctx) => ctx.db.items.byOrder(o.id),", 1],
      ["+", "    total: (o) => o.totalCents / 100,"],
      ["+", "  },"],
      ["+", "  Item: { product: (i, _, ctx) => ctx.db.products.get(i.productId) },", 1],
      [" ", "};"],
      ["+", "export const makeLoaders = (db) => ({ customer: new DataLoader((ids) => db.customers.getMany(ids)) });"],
    ] },
  ];

  /* ---------- HTTP client connection reuse ---------- */
  function poisTail(m, P) { // E[max(0, X - P)] for X ~ Poisson(m)
    let p = Math.exp(-m), cdf = 0, ex = 0;
    for (let k = 0; k < m * 4 + 50; k++) { if (k > P) ex += (k - P) * p; cdf += p; p *= m / (k + 1); }
    return ex;
  }
  function kaModel(I, cfg) {
    const C = (I.rps * I.lat) / 1000; // average in flight
    const churnFrac = cfg.ka === "off" ? 1 : Math.min(1, poisTail(C, cfg.idle) / C + 0.0005);
    const newPerSec = I.rps * churnFrac, tw = newPerSec * 60;
    const hand = 2 * I.rtt + 1.5; // TCP + TLS 1.3 handshake, plus crypto
    const p99 = I.lat * 2.2 + (churnFrac > 0.01 ? hand : 0);
    const resets = I.lv === 3 && cfg.ka === "on" && cfg.idleTO >= I.serverTO ? Math.round(I.rps * 0.0006 * 3600) : 0;
    return { C, churnFrac, newPerSec, tw, p99, resets, idleHeld: cfg.ka === "on" ? cfg.idle : 0 };
  }
  const kaCheck = (I, r) => r.tw > 28232 ? `~${K.num(r.tw)} sockets in TIME_WAIT (60 s each) exceed the 28,232 ephemeral ports (32768–60999): connects fail with EADDRNOTAVAIL` : r.p99 > I.target ? `p99 is ${K.ms(r.p99)} (target ${I.target} ms): ${K.pct(r.churnFrac, 0)} of requests pay a ${K.ms(2 * I.rtt + 1.5)} handshake` : r.resets ? `~${K.num(r.resets)} requests/hour fail with ECONNRESET: the server closes idle connections after ${I.serverTO} s, the client keeps them ${r.idleTO || "longer"}` : true;

  /* ---------- overload: bounded queues with K.qsim ---------- */
  function bpRun(I, cfg) {
    const R = rng(I.seed);
    const rateAt = (t) => (t >= I.s0 && t < I.s0 + I.sl ? I.peak : I.base);
    return K.qsim({ R, dur: I.dur, rateAt, servers: I.servers, svc: I.svc, timeout: I.to, queueMax: cfg.q === "∞" ? Infinity : cfg.q, dropExpired: cfg.drop === "on", retries: cfg.retries || 0, backoff: 50, jitter: true });
  }
  const bpCheck = (I, r) => { const good = r.ok / r.n; return I.lv === 3 && r.amp > 1.5 ? `clients send ${r.amp.toFixed(2)} attempts per request: retries multiply the load on a service that is already shedding it (limit 1.5)` : good < I.goodT ? `only ${K.pct(good)} of requests succeeded within the client's ${I.to} ms timeout (need ≥ ${K.pct(I.goodT, 0)})` : r.p99 > I.p99T ? `successful requests have p99 ${K.ms(r.p99)} (target ${I.p99T} ms)` : true; };

  /* ---------- bulkhead over a shared thread pool ---------- */
  function bhDep(I) {
    const R = rng(I.seed), out = [];
    for (let i = 0; i < 4000; i++) out.push(R.next() < I.fastF ? K.logn(R, 150, 0.4) : K.logn(R, 5000, 0.3));
    return out;
  }
  function bhModel(I, cfg) {
    const dep = bhDep(I), to = cfg.to === "none" ? Infinity : cfg.to, tries = (cfg.retry || 0) + 1;
    const ok1 = dep.filter((x) => x <= to).length / dep.length;
    const hold1 = K.mean(dep.map((x) => Math.min(x, to))) / 1000; // seconds a B call holds a thread
    let demand = 0, ok = 0, att = 1;
    for (let k = 0; k < tries; k++) { demand += I.lb * att * hold1; ok += att * ok1; att *= 1 - ok1; }
    const cap = cfg.bh === "none" ? I.pool : cfg.bh;
    const occ = Math.min(cap, demand), admitted = demand > 0 ? Math.min(1, cap / demand) : 1;
    const bOk = ok * admitted;
    const freeT = I.pool - occ;
    const la = I.la / 1000, mu = 1 / I.sa;
    const aP99 = freeT < 1 ? Infinity : wait99(la, mu, Math.floor(freeT)) + I.sa * 3;
    const worstFree = I.pool - cap, aWorst = worstFree < 1 ? Infinity : wait99(la, mu, Math.floor(worstFree)) + I.sa * 3;
    return { bOk, aP99, occ, demand, freeT, aWorst, cap };
  }
  const bhCheck = (I, r) => fin(r.aP99) && r.aP99 <= I.aT && (!fin(r.aWorst) || r.aWorst > I.aT) ? `A is fine today, but if the dependency stops answering entirely, B's calls can hold ${r.cap} threads and A's p99 becomes ${msOr(r.aWorst)}: the blast radius isn't contained` : !fin(r.aP99) || r.aP99 > I.aT ? `endpoint A's p99 is ${msOr(r.aP99)} (target ${I.aT} ms): B's calls hold ${Math.round(r.occ)} of the ${I.pool} threads` : r.bOk < I.bMin ? `only ${K.pct(r.bOk)} of B's calls succeed (need ≥ ${K.pct(I.bMin, 0)})` : true;

  /* ---------- JVM heap sizing model ---------- */
  function gcModel(I, cfg) {
    const col = cfg.col || I.col, heap = cfg.pct ? (I.limit * cfg.pct) / 100 : I.heap; // GB
    const young = (cfg.young || Math.min(heap * 0.3, 2)) * 1024, a = I.alloc, live = I.live * 1024; // MB, MB/s
    const rss = heap + I.native;
    if (rss > I.limit) return { oom: true, heap, rss };
    const iy = young / a, survive = Math.min(young, a * I.life);
    const yp = col === "ZGC" ? 0.5 : 3 + survive * 0.35;
    const q = I.life / (I.life + iy), promo = (survive * q) / iy; // MB/s
    const oldFree = heap * 1024 - young - live;
    if (col === "ZGC") {
      const head = heap * 1024 - live, cycle = live / 1000 + 0.5, need = a * cycle * 1.5;
      return { heap, rss, col, yp: 0.5, maxPause: head < need ? 1500 : 0.8, stall: head < need, cpu: head > 0 ? 0.06 + (a / (head / cycle)) * 0.04 : 1, fullEvery: Infinity, iy: null };
    }
    if (oldFree <= 0) return { heap, rss, col, thrash: true, yp, maxPause: Infinity, cpu: 1, fullEvery: 0, iy };
    const fullEvery = oldFree / promo; // s
    const fullPause = 300 + live * 0.8;
    const markTime = live / 200 + 2;
    const g1Full = col === "G1" && fullEvery < markTime * 3;
    const maxPause = col === "Parallel" ? Math.max(yp, fullPause) : g1Full ? fullPause : Math.max(yp, 40 + live * 0.02);
    const cpu = yp / 1000 / iy + (col === "Parallel" ? fullPause / 1000 / fullEvery : g1Full ? fullPause / 1000 / fullEvery : 0.05);
    return { heap, rss, col, yp, iy, promo, fullEvery, maxPause, cpu, g1Full };
  }
  function gcCheck(I, r) {
    if (r.oom) return `heap ${K.num(r.heap, 1)} GB + ~${I.native} GB of metaspace, thread stacks and direct buffers = ${K.num(r.rss, 1)} GB, over the ${I.limit} GB container limit: the kernel OOM-kills the pod`;
    if (r.thrash) return "the old generation can't even hold the live set: back-to-back full GCs, then OutOfMemoryError";
    if (r.stall) return "ZGC can't finish a cycle before the free headroom is allocated away: threads hit allocation stalls";
    if (r.cpu > I.cpuT) return `GC uses ${K.pct(r.cpu)} of CPU (budget ${K.pct(I.cpuT, 0)})`;
    if (r.maxPause > I.pauseT) return `worst pause ≈ ${K.ms(r.maxPause)} (limit ${I.pauseT} ms)`;
    return true;
  }

  /* ---------- heap snapshots ---------- */
  const HEAP = [
    { q: "Which object should you fix?", head: ["Constructor / retainer", "# New", "Shallow size", "Retained size"], rows: (I) => [
      [`Map @${I.id}  ← sessionCache (src/session.js)`, "+1", "88 B", "1.21 GB"],
      ["(string)", `+${K.num(I.n * 3)}`, "402 MB", "402 MB"],
      ["Object (Session)", `+${K.num(I.n)}`, "61 MB", "1.18 GB"],
      ["(compiled code)", "+212", "3.1 MB", "3.1 MB"],
      ["Array  ← pendingTimers", "+0", "16 KB", "2.2 MB"],
    ], opts: ["Map ← sessionCache: entries are added on login and never removed", "(string): too many strings", "Object (Session): sessions are too large", "(compiled code)", "pendingTimers array"], ans: 0 },
    { q: "Which object should you fix?", head: ["Constructor / retainer", "# New", "Shallow size", "Retained size"], rows: (I) => [
      ["system / JSArrayBufferData", `+${K.num(I.n)}`, "1.64 GB", "1.64 GB"],
      ["Buffer (Uint8Array)", `+${K.num(I.n)}`, "94 MB", "1.73 GB"],
      [`Array @${I.id}  ← pendingRetries (src/webhooks/retry.js)`, "+1", "3.9 MB", "1.74 GB"],
      ["Object (WebhookJob)", `+${K.num(I.n)}`, "37 MB", "1.74 GB"],
      ["(closure) onResponse", `+${K.num(40)}`, "2 KB", "18 KB"],
    ], opts: ["system / JSArrayBufferData: raw buffer memory", "Buffer: request bodies are too big", "Array ← pendingRetries: failed jobs (with their payload buffers) are queued forever", "Object (WebhookJob)", "(closure) onResponse"], ans: 2 },
    { q: "Which object should you fix?", head: ["Constructor / retainer", "# New", "Shallow size", "Retained size"], rows: (I) => [
      ["IncomingMessage", `+${K.num(I.n)}`, "412 MB", "1.38 GB"],
      ["(closure) onMessage  ← subscribe() in src/live.js", `+${K.num(I.n)}`, "28 MB", "1.47 GB"],
      [`Array @${I.id}  ← redisSub._events.message`, "+1", "3.1 MB", "1.49 GB"],
      ["(string)", `+${K.num(I.n * 4)}`, "210 MB", "210 MB"],
      ["Socket", "+3", "4 KB", "1.1 MB"],
    ], opts: ["IncomingMessage: requests are too large", "redisSub._events.message: every request adds a listener to the shared subscriber and never removes it", "(string)", "Socket", "Raise --max-old-space-size"], ans: 1 },
  ];

  /* ---------- JVM leak terminal ---------- */
  const LEAK_OPTS = ["An unbounded application cache keeps every entry", "ThreadLocal values leak through pooled threads", "Class/metaspace leak: classes are generated per request and never unloaded", "The heap is simply too small for normal load", "Off-heap direct buffers are never released"];
  function leakShell(I) {
    const P = I.pid, co = I.co;
    const hist = (st) => {
      const t = st.t++, g = 1 + t * 0.18;
      const R = (n) => Math.round(n * g), F = (n) => Math.round(n);
      const rows = [[" num", "#instances", "#bytes", "class name (module)"], ["-------------------------------------------------------", "", "", ""]];
      const list = I.lv === 1 ? [[R(4200000), R(201600000), "[B (java.base@21.0.4)"], [R(3900000), R(93600000), "java.lang.String (java.base@21.0.4)"], [R(1310000), R(41920000), "java.util.HashMap$Node (java.base@21.0.4)"], [R(1302000), R(52080000), `com.${co}.pricing.CachedQuote`], [F(212000), F(13568000), "java.util.concurrent.ConcurrentHashMap$Node (java.base@21.0.4)"], [F(48000), F(4608000), "java.lang.reflect.Method (java.base@21.0.4)"]]
        : I.lv === 2 ? [[R(5100000), R(311000000), "[B (java.base@21.0.4)"], [R(4700000), R(112800000), "java.lang.String (java.base@21.0.4)"], [R(830000), R(26560000), "java.lang.ThreadLocal$ThreadLocalMap$Entry (java.base@21.0.4)"], [R(828000), R(46368000), `com.${co}.web.RequestContext`], [F(212000), F(13568000), "java.util.concurrent.ConcurrentHashMap$Node (java.base@21.0.4)"], [F(400), F(83200), "java.lang.Thread (java.base@21.0.4)"]]
          : [[F(3100000), F(148800000), "[B (java.base@21.0.4)"], [F(2900000), F(69600000), "java.lang.String (java.base@21.0.4)"], [F(612000), F(19584000), "java.util.HashMap$Node (java.base@21.0.4)"], [F(212000), F(13568000), "java.util.concurrent.ConcurrentHashMap$Node (java.base@21.0.4)"], [R(41000), R(2952000), "java.lang.Class (java.base@21.0.4)"], [F(48000), F(4608000), "java.lang.reflect.Method (java.base@21.0.4)"]];
      list.forEach((r, k) => rows.push([`   ${k + 1}:`, r[0], r[1], r[2]]));
      return K.cols(rows, 3) + `\nTotal ${K.num(list.reduce((s, r) => s + r[0], 0) * 2)}   (uptime ${41 + t * 5} min)`;
    };
    const sh = K.shell([
      { re: /^jcmd (\d+) GC\.class_histogram(?: -all)?(?: \| head(?: -n)?(?: -?\d+)?)?$/, use: "jcmd <pid> GC.class_histogram | head -12", desc: "live objects by class (forces a full GC)", run: (m, st) => { if (+m[1] !== P) return `${m[1]}: com.sun.tools.attach.AttachNotSupportedException: Unable to open socket file`; st.hist = (st.hist || 0) + 1; return `${P}:\n` + hist(st); } },
      { re: /^jcmd (\d+) GC\.heap_info$/, use: "jcmd <pid> GC.heap_info", desc: "heap regions and occupancy", run: (m, st) => `${P}:\n garbage-first heap   total ${I.lv === 3 ? "4194304K, used 1310720K" : `4194304K, used ${3200000 + st.t * 180000}K`} [0x0000000700000000, 0x0000000800000000)\n  region size 2048K, 98 young (200704K), 7 survivors (14336K)\n Metaspace       used ${I.lv === 3 ? 612000 + st.t * 90000 : 118200}K, committed ${I.lv === 3 ? 640000 + st.t * 90000 : 121856}K, reserved ${I.lv === 3 ? "1703936K" : "1179648K"}\n  class space    used ${I.lv === 3 ? 88000 + st.t * 13000 : 14100}K` },
      { re: /^jcmd (\d+) VM\.metaspace(?: summary)?$/, use: "jcmd <pid> VM.metaspace", desc: "metaspace usage and class loaders", run: (m, st) => { st.meta = true; const t = st.t++; return `${P}:\nTotal Usage - ${I.lv === 3 ? 1850 + t * 260 : 412} loaders, ${I.lv === 3 ? 61200 + t * 8700 : 18904} classes (${I.lv === 3 ? 61100 + t * 8700 : 18790} shared):\n  Non-Class: ${I.lv === 3 ? "  610.12 MB" : "  104.12 MB"}\n      Class: ${I.lv === 3 ? "   87.40 MB" : "   13.80 MB"}\n       Both: ${I.lv === 3 ? "  697.52 MB" : "  117.92 MB"}\n\nPer-loader type breakdown (top):\n  ${I.lv === 3 ? `groovy.lang.GroovyClassLoader$InnerLoader  ${1840 + t * 260} loaders, ${1840 + t * 260} classes` : "jdk.internal.loader.ClassLoaders$AppClassLoader  1 loader, 14210 classes"}\n  jdk.internal.reflect.DelegatingClassLoader  ${I.lv === 3 ? 22 : 400} loaders` ; } },
      { re: /^jcmd (\d+) VM\.uptime$/, use: "jcmd <pid> VM.uptime", desc: "", run: (m, st) => `${P}:\n${(41 + st.t * 5) * 60}.112 s` },
      { re: /^jcmd (\d+) VM\.native_memory(?: summary)?$/, use: "jcmd <pid> VM.native_memory summary", desc: "native memory (needs -XX:NativeMemoryTracking)", run: () => `${P}:\nNative memory tracking is not enabled` },
      { re: /^(?:jps(?: -l)?|pgrep -f java)$/, use: "jps -l", desc: "find the JVM", run: () => `${P} com.${co}.Application` },
      { re: /^kill(?: -\S+)? (\d+)$/, use: "kill <pid>", desc: "", run: () => ({ out: "", danger: "Restarting buys a few hours and destroys the evidence." }) },
    ]);
    return { prompt: "app@" + co + "-api-2:~$", init: { t: 0 }, run: (l, st) => sh.run(l, st), par: 5, opts: LEAK_OPTS, optq: "Root cause",
      motd: `ALERT ${co}-api memory: RSS +${I.lv === 3 ? 600 : 400} MB/hour, pods OOM-killed every ~${I.lv === 3 ? 9 : 6} h\nJVM pid ${P} (OpenJDK 21, G1, -Xmx4g)`,
      cmds: ["jps -l", `jcmd ${P} GC.class_histogram | head -12`, `jcmd ${P} GC.heap_info`, `jcmd ${P} VM.metaspace`, `jcmd ${P} VM.native_memory summary`] };
  }

  /* ---------- Go goroutine leak terminal ---------- */
  const GO_OPTS = ["Goroutines block forever sending on an unbuffered channel after the caller timed out", "A per-request ticker loop never checks ctx.Done()", "HTTP response bodies are never closed, so connections and their read/write loops pile up", "A mutex deadlock freezes the worker pool", "GOMAXPROCS is too low"];
  function goShell(I) {
    const svc = I.svc;
    const prof = (st) => {
      const n = 1200 + st.t * 4100;
      st.t++;
      const leak = I.lv === 1 ? `${n} @ 0x43ab56 0x407f05 0x407a9b 0x8a6c1d 0x471e41\n#\t0x8a6c1c\tmain.(*Server).fetchPrices.func1+0x7c\t/app/prices.go:58\n` : I.lv === 2 ? `${n} @ 0x43ab56 0x44d3c5 0x8a7e12 0x471e41\n#\t0x8a7e11\tmain.watchQuota+0x91\t/app/quota.go:31\n` : `${n} @ 0x43ab56 0x43c9f1 0x6b2c35 0x471e41\n#\t0x6b2c34\tnet/http.(*persistConn).readLoop+0xb94\t/usr/local/go/src/net/http/transport.go:2325\n\n${n} @ 0x43ab56 0x44d3c5 0x6b3e8f 0x471e41\n#\t0x6b3e8e\tnet/http.(*persistConn).writeLoop+0x10e\t/usr/local/go/src/net/http/transport.go:2519\n`;
      return `goroutine profile: total ${n * (I.lv === 3 ? 2 : 1) + 166}\n${leak}\n64 @ 0x43ab56 0x407f05 0x8a51d2 0x471e41\n#\t0x8a51d1\tmain.(*Pool).worker+0x71\t/app/pool.go:22\n\n38 @ 0x43ab56 0x43c9f1 0x6a1e2b 0x471e41\n#\t0x6a1e2a\tnet/http.(*conn).serve+0x5ca\t/usr/local/go/src/net/http/server.go:2098\n`;
    };
    const src = { "prices.go": `52  func (s *Server) fetchPrices(ctx context.Context, skus []string) ([]Price, error) {\n53  \tch := make(chan []Price)\n54  \tgo func() {\n55  \t\tp, _ := s.pricing.Get(skus)\n58  \t\tch <- p\n59  \t}()\n60  \tselect {\n61  \tcase p := <-ch:\n62  \t\treturn p, nil\n63  \tcase <-time.After(200 * time.Millisecond):\n64  \t\treturn nil, ErrTimeout\n65  \t}`, "quota.go": `24  func watchQuota(ctx context.Context, tenant string, q *Quota) {\n25  \tt := time.NewTicker(5 * time.Second)\n26  \tdefer t.Stop()\n27  \tfor {\n31  \t\t<-t.C\n32  \t\tq.Refresh(tenant)\n33  \t}\n34  }\n...\n88  \tgo watchQuota(r.Context(), tenant, q) // in the request handler`, "client.go": `40  resp, err := s.http.Do(req)\n41  if err != nil {\n42  \treturn err\n43  }\n44  if resp.StatusCode != 200 {\n45  \treturn fmt.Errorf("partner: %s", resp.Status)\n46  }\n47  defer resp.Body.Close()\n48  return json.NewDecoder(resp.Body).Decode(&out)` };
    const sh = K.shell([
      { re: /^curl -s ['"]?(?:http:\/\/)?localhost:6060\/debug\/pprof\/goroutine\?debug=1['"]?(?: \| head(?: -n)?(?: -?\d+)?)?$/, use: "curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | head -30", desc: "goroutines grouped by stack", run: (m, st) => { st.prof = true; return prof(st); } },
      { re: /^curl -s ['"]?(?:http:\/\/)?localhost:9090\/metrics['"]? \| grep go_goroutines$/, use: "curl -s localhost:9090/metrics | grep go_goroutines", desc: "current goroutine count", run: (m, st) => { const n = 1200 + st.t * 4100; st.t++; return `# HELP go_goroutines Number of goroutines that currently exist.\n# TYPE go_goroutines gauge\ngo_goroutines ${n * (I.lv === 3 ? 2 : 1) + 166}`; } },
      { re: /^cat (?:\/app\/)?(prices|quota|client)\.go$/, use: "cat /app/<file>.go", desc: "read a source file", run: (m, st) => { st.src = true; return src[m[1] + ".go"]; } },
      { re: /^ls(?: \/app)?$/, use: "ls /app", desc: "", run: () => "client.go  main.go  pool.go  prices.go  quota.go  server.go" },
      { re: /^kubectl rollout restart deploy\/\S+$/, use: "kubectl rollout restart deploy/<name>", desc: "", run: () => ({ out: "deployment.apps restarted", danger: "A restart resets the count; the leak is back in hours." }) },
    ]);
    return { prompt: `${svc}-0:/app$`, init: { t: 0 }, run: (l, st) => sh.run(l, st), par: 5, opts: GO_OPTS, optq: "Root cause",
      motd: `ALERT ${svc}: memory +300 MB/h, go_goroutines climbing linearly since the last deploy\npprof is enabled on :6060, metrics on :9090`,
      cmds: ["curl -s localhost:9090/metrics | grep go_goroutines", "curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | head -30", "ls /app", "cat /app/<file>.go"] };
  }

  /* ---------- cancellation diffs (Go) ---------- */
  const CANCEL = [
    { file: "internal/api/search.go", lines: [
      ["@", "@@ -31,9 +31,10 @@ func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {"],
      [" ", "\tq := r.URL.Query().Get(\"q\")"],
      ["+", "\tctx := context.Background()", 1],
      ["-", "\trows, err := h.db.QueryContext(r.Context(), searchSQL, q)"],
      ["+", "\trows, err := h.db.QueryContext(ctx, searchSQL, q)"],
      [" ", "\tif err != nil {"],
      [" ", "\t\thttp.Error(w, err.Error(), 500)"],
      [" ", "\t\treturn"],
      [" ", "\t}"],
      [" ", "\tdefer rows.Close()"],
    ] },
    { file: "internal/partner/client.go", lines: [
      ["@", "@@ -18,12 +18,16 @@ func (c *Client) Quote(ctx context.Context, sku string) (*Quote, error) {"],
      ["+", "\tctx, cancel := context.WithTimeout(ctx, 2*time.Second)"],
      ["+", "\tdefer cancel()"],
      [" ", "\tfor attempt := 0; attempt < 4; attempt++ {"],
      ["+", "\t\treq, _ := http.NewRequest(\"GET\", c.base+\"/quote/\"+sku, nil)", 1],
      [" ", "\t\tresp, err := c.http.Do(req)"],
      [" ", "\t\tif err == nil && resp.StatusCode == 200 {"],
      [" ", "\t\t\treturn decode(resp)"],
      [" ", "\t\t}"],
      ["+", "\t\ttime.Sleep(backoff(attempt))", 1],
      [" ", "\t}"],
      [" ", "\treturn nil, ErrUnavailable"],
    ] },
    { file: "internal/search/fanout.go", lines: [
      ["@", "@@ -40,14 +40,18 @@ func (s *Service) Query(ctx context.Context, q string) (Result, error) {"],
      ["+", "\tctx, _ = context.WithTimeout(ctx, 300*time.Millisecond)", 1],
      ["+", "\tresults := make(chan Result)", 1],
      [" ", "\tgo func() { results <- s.index.Search(ctx, q) }()"],
      ["+", "\tgo s.audit.Record(context.WithoutCancel(ctx), q) // must finish even if the client leaves"],
      [" ", "\tselect {"],
      [" ", "\tcase r := <-results:"],
      [" ", "\t\treturn r, nil"],
      [" ", "\tcase <-ctx.Done():"],
      [" ", "\t\treturn Result{}, ctx.Err()"],
      [" ", "\t}"],
    ] },
  ];

  LB.addAll("perf", [
    /* 21 */ {
      id: "perf-n-plus-one",
      name: "One query per row",
      kind: "Code review",
      skills: ["diagnose"],
      w: "lines",
      gen(lv, R) { return { lv, rtt: R.pick([0.5, 1, 2]), n: [50, 40, 100][lv - 1], svcRtt: R.pick([8, 12, 15]) }; },
      text: (I) => `<p>${I.lv === 1 ? `This Django view got slow after the PR below: the order list page went from 3 queries to ${I.n + 3}.` : I.lv === 2 ? `The cart summary endpoint's p50 went from 30 ms to 600 ms. Each call to another service costs ~${I.svcRtt} ms.` : `The orders GraphQL query now issues hundreds of SQL statements per request. The team already uses DataLoader for some fields.`}</p><p><b>Flag the ${I.lv === 1 ? "line that issues" : "two lines that issue"} one call per row (the N+1 pattern).</b></p>`,
      ui: (I) => { const d = NP1[I.lv - 1]; return { file: d.file, lines: diffLines(d.lines), k: I.lv === 1 ? 1 : 2 }; },
      ans: (I) => flagged(NP1[I.lv - 1].lines),
      diag: (I, a) => { const L = NP1[I.lv - 1].lines, w = a.filter((i) => !L[i][2]); return w.length ? `<code>${esc(L[w[0]][1].trim().slice(0, 70))}</code> runs once per request, not once per row${/loaders\.customer|DataLoader/.test(L[w[0]][1]) ? " (DataLoader batches the per-row loads into one query)" : ""}.` : "You found one, there's another."; },
      hint: (I) => I.lv === 1 ? "Accessing a ForeignKey attribute on each row triggers a lazy load." : I.lv === 2 ? "Promise.all makes N calls concurrently; a loop of awaits makes them one by one. Both are N calls." : "A field resolver runs once per parent object. Which ones hit the database directly?",
      concept: "N+1 queries and calls",
      how: "N+1 happens when code fetches a list with one call and then makes one more call per element: an ORM lazily loading a relation inside a loop, a GraphQL resolver that queries per parent, or a client calling another service per item. Each call pays a round trip, so latency grows linearly with N (sequentially) or the downstream gets N requests at once (in parallel). Fixes batch the work: eager loading (select_related/prefetch_related, JOIN FETCH), a bulk endpoint (getMany), or a per-request DataLoader that collects keys within one tick and issues one query.",
      rule: "Watch query and call counts per request in tests and traces; fetch relations in bulk, and give services batch endpoints before callers loop over them.",
      why: (I) => I.lv === 1 ? `<code>o.store.name</code> lazily loads each order's store: ${I.n} extra queries × ~${I.rtt} ms round trip. <code>select_related('store')</code> makes it one JOIN.` : I.lv === 2 ? `~40 items meant 40 parallel pricing calls plus 40 sequential inventory calls (~40 × ${I.svcRtt} ms ≈ ${K.num(40 * I.svcRtt)} ms). Use the services' batch endpoints.` : `<code>items</code> queries once per order (100 per page) and <code>product</code> once per item; route both through DataLoaders like <code>customer</code> already does.`,
    },
    /* 22 */ {
      id: "perf-amdahl-usl",
      name: "How much will more cores help?",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) return { lv, p: R.pick([0.9, 0.95]), N: R.pick([8, 16, 32]) };
        if (lv === 2) return { lv, S4: R.pick([2.9, 3.1, 3.3]), N: R.pick([32, 64]) };
        return { lv, sig: R.pick([0.02, 0.03, 0.05]), kap: R.pick([0.0002, 0.0005, 0.001]) };
      },
      text: (I) => I.lv === 1 ? `<p>A rendering job spends <b>${Math.round(I.p * 100)}%</b> of its single-threaded run time in a loop you can parallelise perfectly; the rest (reading input, writing output) stays serial. <b>What speedup do you get on ${I.N} cores?</b></p>`
        : I.lv === 2 ? `<p>You parallelised a batch job. On 4 cores it runs <b>${I.S4}×</b> faster than on 1. The team wants to buy ${I.N}-core machines. Assuming the non-parallel part stays fixed, <b>what speedup should they expect on ${I.N} cores?</b></p>`
          : `<p>Load tests of a service fit the Universal Scalability Law, X(N) = N / (1 + σ(N − 1) + κN(N − 1)), with contention σ = <b>${I.sig}</b> and coherency κ = <b>${I.kap}</b>, where N is the number of concurrent workers. <b>At what N does throughput peak?</b></p>`,
      ui: (I) => ({ unit: I.lv === 3 ? "workers" : "× speedup" }),
      accept: (I, a) => LB.near(amdahlTruth, I.lv === 3 ? 0.12 : 0.08)(I, a),
      solve: (I) => Math.round(amdahlTruth(I) * 10) / 10,
      bad: (I) => I.lv === 1 ? [I.N, I.N * I.p] : I.lv === 2 ? [Math.round(((I.S4 * I.N) / 4) * 10) / 10] : [Math.round(1 / I.sig), Math.round(1 / Math.sqrt(I.kap) / 3)],
      hint: (I) => I.lv === 1 ? "Speedup = 1 / ((1 − p) + p / N)." : I.lv === 2 ? "Solve 1 / (s + (1 − s)/4) = measured speedup for the serial fraction s, then plug in the new N." : "Set the derivative to zero: N* = √((1 − σ) / κ).",
      concept: "Amdahl's law and the Universal Scalability Law",
      how: "Amdahl: if a fraction s of the work is serial, the speedup on N processors is 1 / (s + (1 − s)/N), which can never exceed 1/s; 5% serial caps you at 20× no matter how many cores. You can back out s from one measured speedup (the Karp-Flatt metric). Real systems are worse: the Universal Scalability Law adds a coherency term κN(N − 1) for the cost of keeping shared state consistent (cache lines bouncing, lock handoffs, cross-node chatter), so throughput peaks at N* = √((1 − σ)/κ) and then falls as you add workers.",
      rule: "Measure scaling at a few points, fit σ and κ, and stop adding workers (threads, pods, connections) before the peak; shrink the serial and shared parts first.",
      why: (I) => I.lv === 1 ? `1 / (${K.num(1 - I.p, 2)} + ${I.p}/${I.N}) ≈ ${K.num(amdahlTruth(I), 1)}×; the cap is ${K.num(1 / (1 - I.p))}× however many cores you add.` : I.lv === 2 ? `Serial fraction s = (4/${I.S4} − 1)/3 ≈ ${K.num((4 / I.S4 - 1) / 3, 3)}, so ${I.N} cores give ≈ ${K.num(amdahlTruth(I), 1)}×, not ${K.num((I.S4 * I.N) / 4, 1)}×.` : `N* = √((1 − ${I.sig}) / ${I.kap}) ≈ ${K.num(amdahlTruth(I))}; beyond that, coherency costs make throughput fall.`,
    },
    /* 23 */ {
      id: "perf-keepalive",
      name: "Reuse the connections",
      kind: "Config change",
      skills: ["tune", "diagnose"],
      w: "tune",
      sense: "min",
      vname: "idle connections:",
      gen(lv, R) { return { lv, rps: lv === 1 ? R.pick([600, 800]) : R.pick([1500, 2000, 2500]), lat: R.pick([20, 30, 40]), rtt: lv === 1 ? R.pick([10, 15]) : R.pick([20, 30]), target: lv === 1 ? 120 : 140, serverTO: 5 }; },
      text: (I) => `<p>A Go service calls a partner API at <b>${K.num(I.rps)} requests/s</b> (mean ${I.lat} ms, ~${K.num((I.rps * I.lat) / 1000)} in flight) over TLS, ${I.rtt} ms RTT away. ${I.lv === 1 ? "It sets <code>DisableKeepAlives: true</code> \"to avoid stale connections\"." : "It uses <code>http.Transport</code> defaults, including <code>MaxIdleConnsPerHost: 2</code>."} Errors like <code>dial tcp: connect: cannot assign requested address</code> started this week.${I.lv === 3 ? ` The partner's Node.js server closes idle connections after <b>${I.serverTO} s</b> (its keepAliveTimeout default); Go's <code>IdleConnTimeout</code> defaults to 90 s.` : ""}</p><p>Get p99 under <b>${I.target} ms</b> with no port exhaustion${I.lv === 3 ? " and no reset errors" : ""}, keeping as few idle connections as possible.</p>`,
      ui: (I) => {
        const knobs = [{ k: "ka", label: "Keep-alive", opts: ["off", "on"], fixed: I.lv === 1 ? undefined : "on", help: "reuse connections between requests" }, { k: "idle", label: "MaxIdleConnsPerHost", opts: [2, 10, 50, 100, 200], help: "idle connections kept per host; extra ones are closed after use" }];
        if (I.lv === 3) knobs.push({ k: "idleTO", label: "IdleConnTimeout", opts: [90, 30, 4], unit: "s", help: "how long the client keeps an idle connection" });
        return { knobs, init: { ka: I.lv === 1 ? "off" : "on", idleTO: 90 }, live: (cfg) => { const r = kaModel(I, { idleTO: 90, ...cfg }); r.idleTO = cfg.idleTO; const c = kaCheck(I, r); return K.metrics([{ name: "New connections/s", value: K.num(r.newPerSec), ok: r.churnFrac < 0.01 }, { name: "TIME_WAIT sockets", value: K.num(r.tw), ok: r.tw < 28232, target: "< 28,232 ports" }, { name: "p99", value: K.ms(r.p99), ok: r.p99 <= I.target, target: `≤ ${I.target} ms` }, ...(I.lv === 3 ? [{ name: "Resets/hour", value: K.num(r.resets), ok: r.resets === 0 }] : [])]) + K.verdict(c === true, c === true ? "healthy" : c); } };
      },
      valid: (I, cfg) => { const r = kaModel(I, { idleTO: 90, ...cfg }); r.idleTO = (cfg.idleTO || 90) + " s"; return kaCheck(I, r); },
      val: (I, cfg) => kaModel(I, { idleTO: 90, ...cfg }).idleHeld,
      hint: (I) => I.lv === 1 ? "Every closed connection sits in TIME_WAIT for 60 s on the side that closed it, holding a local port." : I.lv === 2 ? "With ~" + Math.round((I.rps * I.lat) / 1000) + " requests in flight and 2 idle slots, most connections are closed right after use." : "Keep the client's idle timeout shorter than the server's, so the client never sends on a connection the server is closing.",
      concept: "Connection reuse, TIME_WAIT and idle timeouts",
      how: "A new TLS connection costs a TCP handshake plus a TLS 1.3 handshake (two round trips) and CPU on both ends. Without keep-alive, every request pays that, and every closed connection leaves a socket in TIME_WAIT for 60 s on the side that closed it, each holding one of ~28k ephemeral ports to that destination; at a few hundred connections per second you run out. Keep-alive pools fix this only if the pool can hold as many idle connections as you have concurrent requests: Go's default MaxIdleConnsPerHost is 2, so bursts above 2 open and close connections constantly. Finally, if the server closes idle connections sooner than the client stops reusing them, a request can race the server's FIN and fail with a reset.",
      rule: "Keep connections alive, size the idle pool to peak concurrency per host (Little's law), and set the client idle timeout below the server's.",
      why: (I, sol) => { const r = kaModel(I, { idleTO: 90, ...sol }); return `With keep-alive and ${sol.idle} idle connections per host (~${K.num(r.C)} in flight on average), only ${K.pct(r.churnFrac, 1)} of requests open a new connection${I.lv === 3 ? `, and a ${sol.idleTO} s idle timeout stays below the server's ${I.serverTO} s` : ""}.`; },
    },
    /* 24 */ {
      id: "perf-backpressure",
      name: "Bound the queue",
      kind: "Hardening",
      skills: ["tune", "design"],
      w: "tune",
      gen(lv, R) {
        return { lv, seed: `perf-bp/${lv}/${R.int(1, 1e9)}`, dur: 32, servers: 8, svc: 20, base: R.pick([240, 280]), peak: R.pick([560, 640]), s0: 8, sl: 12, to: 1000, goodT: lv === 1 ? 0.6 : 0.62, p99T: lv === 1 ? 700 : 500 };
      },
      text: (I) => `<p>A service has 8 workers at ~20 ms per request (capacity ≈ 400/s). Normal traffic is ${I.base}/s; a <b>${I.sl} s</b> burst at <b>${I.peak}/s</b> arrives at t = ${I.s0} s. Clients time out after <b>${I.to} ms</b> and give up${I.lv === 3 ? ", unless retries are configured" : ""}. Today the work queue is unbounded${I.lv > 1 ? " and workers process requests whose clients have already gone" : ""}.</p><p>Make the service shed load cleanly: at least <b>${K.pct(I.goodT, 0)}</b> of requests succeed within the timeout and successful requests have p99 ≤ <b>${I.p99T} ms</b>${I.lv === 3 ? ", with at most <b>1.5 attempts per request</b>" : ""} (live simulation: ${I.dur} s).</p>`,
      ui: (I) => {
        const knobs = [{ k: "q", label: "Queue limit", opts: ["∞", 2000, 400, 100, 25], help: "requests beyond it get 503 immediately" }];
        if (I.lv > 1) knobs.push({ k: "drop", label: "Drop expired", opts: ["off", "on"], help: "skip queued requests older than the client timeout" });
        if (I.lv === 3) knobs.push({ k: "retries", label: "Client retries", opts: [3, 1, 0], help: "on timeout or 503, with jittered backoff" });
        return { knobs, init: I.lv === 1 ? { q: "∞" } : I.lv === 2 ? { q: "∞", drop: "off" } : { q: "∞", drop: "off", retries: 3 }, live: (cfg) => { const r = bpRun(I, { drop: "off", retries: I.lv === 3 ? 3 : 0, ...cfg }); const c = bpCheck(I, r); return K.metrics([{ name: "Succeeded", value: K.pct(r.ok / r.n), ok: r.ok / r.n >= I.goodT, target: `≥ ${K.pct(I.goodT, 0)}` }, { name: "p99 (successes)", value: K.ms(r.p99), ok: r.p99 <= I.p99T, target: `≤ ${I.p99T} ms` }, { name: "Rejected fast", value: K.num(r.rejected), ok: null }, { name: "Timed out", value: K.num(r.timeouts), ok: null }, { name: "Attempts / request", value: r.amp.toFixed(2), ok: r.amp < 1.3 }]) + K.chart([{ name: "goodput/s", pts: r.series.goodput, cls: "good" }, { name: "queue depth", pts: r.series.queue.map((x) => Math.min(x, 2000) / 4) }], { title: "goodput per second, and queue depth ÷ 4", xlabel: "s" }) + K.verdict(c === true, c === true ? "sheds load cleanly" : c); } };
      },
      accept(I, cfg) { const c = bpCheck(I, bpRun(I, { drop: "off", retries: I.lv === 3 ? 3 : 0, ...cfg })); return c === true ? true : c[0].toUpperCase() + c.slice(1) + "."; },
      solve(I, spec) { const pref = [100, 25, 400].flatMap((q) => (I.lv === 1 ? [{ q }] : I.lv === 2 ? [{ q, drop: "on" }, { q, drop: "off" }] : [1, 0].flatMap((retries) => [{ q, drop: "on", retries }, { q, drop: "off", retries }]))); for (const c of pref) if (bpCheck(I, bpRun(I, { drop: "off", retries: 0, ...c })) === true) return c; for (const c of LB.byId.get("perf-backpressure").space(I, spec)) if (bpCheck(I, bpRun(I, { drop: "off", retries: 0, ...c })) === true) return c; return null; },
      bad: (I) => I.lv === 1 ? [{ q: "∞" }] : I.lv === 2 ? [{ q: "∞", drop: "off" }, { q: 2000, drop: "off" }] : [{ q: "∞", drop: "off", retries: 3 }, { q: 25, drop: "on", retries: 3 }, { q: 400, drop: "off", retries: 0 }],
      hint: (I) => I.lv === 1 ? "A queue that holds more than timeout × throughput requests only holds requests nobody will wait for." : I.lv === 2 ? "Even a bounded queue can fill with requests whose clients already gave up." : "Retrying every 503 three times multiplies the overload exactly when you're shedding it.",
      concept: "Backpressure and bounded queues",
      how: "An unbounded queue in front of an overloaded service converts overload into latency: the queue grows, every request waits longer than its client's timeout, and the server spends its capacity on work nobody is waiting for, so goodput collapses even after the burst ends. A queue bound of about timeout × throughput keeps waiting times below the timeout and rejects the excess immediately (a fast 503 the client can handle). Dropping requests whose deadline has passed before working on them (deadline propagation) saves more capacity. Client retries must be budgeted, or a burst of rejections becomes a multiplied burst of retries.",
      rule: "Bound every queue to what can be served before clients give up, reject early, skip expired work, and cap retries with a budget.",
      why: (I, sol) => { const r = bpRun(I, { drop: "off", retries: 0, ...sol }); return `Queue limit ${sol.q}${sol.drop ? `, drop expired ${sol.drop}` : ""}${sol.retries != null ? `, ${sol.retries} retries` : ""}: ${K.pct(r.ok / r.n)} succeeded with p99 ${K.ms(r.p99)}. Unbounded, the queue holds tens of seconds of work during the burst and requests finish after their clients left.`; },
    },
    /* 25 */ {
      id: "perf-bulkhead",
      name: "Isolate the slow dependency",
      kind: "Hardening",
      skills: ["tune", "design"],
      w: "tune",
      sense: "max",
      vname: "B success",
      vfmt: (v) => K.pct(v),
      gen(lv, R) { return { lv, seed: `perf-bh/${lv}/${R.int(1, 1e9)}`, pool: 200, la: R.pick([800, 900, 1000]), sa: 20, lb: R.pick([90, 100, 110]), fastF: R.pick([0.55, 0.6, 0.65]), aT: 100, bMin: lv === 1 ? 0 : lv === 2 ? 0.5 : 0.6 }; },
      text: (I) => `<p>A Tomcat service has one pool of <b>${I.pool}</b> request threads. Endpoint A (${I.la}/s, ~${I.sa} ms, no dependencies) shares it with endpoint B (${I.lb}/s), which calls a recommendations API. That API is degraded: ~${Math.round(I.fastF * 100)}% of calls answer in ~150 ms, the rest hang ~5 s. A is timing out too.</p><p>Keep A's p99 under <b>${I.aT} ms</b>${I.bMin ? ` and at least <b>${K.pct(I.bMin, 0)}</b> of B's calls succeeding` : ""}, and A must survive even if the API stops answering entirely; then maximise B's success rate. A bulkhead is a semaphore that caps how many threads B's calls may hold; excess B calls fail fast.</p>`,
      ui: (I) => {
        const knobs = [{ k: "bh", label: "Bulkhead for B", opts: ["none", 10, 25, 50, 100, 150], help: "max concurrent calls to the dependency" }];
        if (I.lv > 1) knobs.push({ k: "to", label: "Timeout for B's call", opts: ["none", 3000, 1000, 300], unit: "ms" });
        if (I.lv === 3) knobs.push({ k: "retry", label: "Retries on timeout", opts: [0, 1], help: "retry once, immediately" });
        return { knobs, init: { bh: "none", to: "none", retry: 0 }, live: (cfg) => { const r = bhModel(I, { to: "none", retry: 0, ...cfg }); const c = bhCheck(I, r); return K.metrics([{ name: "Threads held by B", value: K.num(r.occ), ok: r.occ < I.pool * 0.8, target: `of ${I.pool}` }, { name: "A p99", value: msOr(r.aP99), ok: fin(r.aP99) && r.aP99 <= I.aT, target: `≤ ${I.aT} ms` }, { name: "A p99 if B hangs", value: msOr(r.aWorst), ok: fin(r.aWorst) && r.aWorst <= I.aT }, { name: "B success", value: K.pct(r.bOk), ok: r.bOk >= I.bMin }]) + K.verdict(c === true, c === true ? "A is isolated" : c); } };
      },
      valid: (I, cfg) => bhCheck(I, bhModel(I, { to: "none", retry: 0, ...cfg })),
      val: (I, cfg) => K.round(bhModel(I, { to: "none", retry: 0, ...cfg }).bOk, 4),
      hint: (I) => I.lv === 1 ? "Little's law: B's calls hold ~" + Math.round(I.lb * 2.1) + " threads with no limit. How many can you give B and still leave A enough?" : I.lv === 2 ? "A timeout shrinks how long each B call holds a thread, so the same bulkhead serves more calls." : "A retry rescues some hung calls but doubles the threads they use. Check whether it fits.",
      concept: "Bulkheads and timeouts",
      how: "A shared thread pool couples every endpoint to its slowest dependency: by Little's law, calls that take 5 s at 100/s hold 500 threads, so a degraded dependency starves endpoints that never call it. A bulkhead (a semaphore or a separate pool per dependency) caps the threads one dependency can hold, turning starvation into fast failures for that dependency only. A timeout shortens how long each call holds its slot, so the bulkhead admits more calls and more of them succeed. Retries add load to a slot budget that's already full; they help only when the bulkhead has room.",
      rule: "Give each remote dependency its own bulkhead and a timeout near its healthy p99, size the bulkhead with Little's law, and keep retries inside the same budget.",
      why: (I, sol) => { const r = bhModel(I, { to: "none", retry: 0, ...sol }); return `Bulkhead ${sol.bh}${sol.to ? `, timeout ${sol.to}${sol.to === "none" ? "" : " ms"}` : ""}${sol.retry ? ", 1 retry" : ""}: B holds ~${K.num(r.occ)} threads, A's p99 ≈ ${K.ms(r.aP99)}, ${K.pct(r.bOk)} of B's calls succeed.`; },
    },
    /* 26 */ {
      id: "perf-gc-sizing",
      name: "Tune the garbage collector",
      kind: "Config change",
      skills: ["tune"],
      w: "tune",
      gen(lv, R) {
        if (lv === 1) return { lv, col: "Parallel", heap: 4, limit: 6, native: 0.8, alloc: R.pick([400, 500, 600]), live: 1.2, life: 0.4, cpuT: 0.05, pauseT: 2500 };
        if (lv === 2) return { lv, col: "G1", limit: 8, native: 1.3, alloc: R.pick([300, 400]), live: R.pick([2.4, 2.8]), life: 0.4, cpuT: 0.1, pauseT: 300 };
        return { lv, limit: 12, native: 1.5, alloc: R.pick([600, 800]), live: R.pick([3, 3.5]), life: 0.4, cpuT: 0.15, pauseT: 10 };
      },
      text: (I) => I.lv === 1 ? `<p>A batch API runs on the Parallel collector with <code>-Xmx4g</code>. It allocates ~<b>${I.alloc} MB/s</b>; most objects die within ~${I.life * 1000} ms, and ~${I.live} GB is long-lived. Someone set <code>-Xmn128m</code>, and GC now takes a big share of CPU with frequent long full GCs.</p><p>Choose a young generation size that keeps GC CPU under <b>5%</b> (full GCs are fine if rare).</p>`
        : I.lv === 2 ? `<p>A service on G1 runs in a container with an <b>${I.limit} GB</b> memory limit. Heap is set by <code>-XX:MaxRAMPercentage</code> (default <b>25%</b>). Live data is ~<b>${I.live} GB</b>, allocation ~${I.alloc} MB/s, and the JVM's non-heap memory (metaspace, thread stacks, code cache, direct buffers) is ~${I.native} GB. Today it has frequent full GCs.</p><p>Pick a setting with no full GCs, pauses under ${I.pauseT} ms and no OOM kills.</p>`
          : `<p>A latency-critical service (p99.9 SLO needs every GC pause under <b>${I.pauseT} ms</b>) has ~${I.live} GB of live data and allocates ~${I.alloc} MB/s. The container limit is <b>${I.limit} GB</b> with ~${I.native} GB of non-heap memory. JDK 21.</p><p>Choose the collector and heap share that meet the pause limit with GC CPU under ${K.pct(I.cpuT, 0)} and no OOM kills.</p>`,
      ui: (I) => {
        const knobs = I.lv === 1 ? [{ k: "young", label: "Young generation (-Xmn)", opts: [0.125, 0.25, 0.5, 1, 1.5], fmt: (v) => (v < 1 ? v * 1024 + " MB" : v + " GB") }]
          : I.lv === 2 ? [{ k: "pct", label: "MaxRAMPercentage", opts: [25, 50, 70, 85, 95], unit: "%" }]
            : [{ k: "col", label: "Collector", opts: ["Parallel", "G1", "ZGC"], fmt: (v) => (v === "ZGC" ? "Generational ZGC" : v) }, { k: "pct", label: "MaxRAMPercentage", opts: [25, 40, 55, 70, 85], unit: "%" }];
        return { knobs, init: I.lv === 1 ? { young: 0.125 } : I.lv === 2 ? { pct: 25 } : { col: "G1", pct: 25 }, live: (cfg) => { const r = gcModel(I, cfg || {}); const c = gcCheck(I, r); if (r.oom) return K.verdict(false, c); return K.metrics([{ name: "Heap", value: K.num(r.heap, 1) + " GB", ok: null }, { name: "Young GC every", value: r.iy ? K.ms(r.iy * 1000) : "–", ok: null }, { name: r.col === "G1" ? "Old-gen cycle every" : "Full GC every", value: r.thrash ? "constantly" : fin(r.fullEvery) ? (r.fullEvery > 3600 ? K.num(r.fullEvery / 3600, 1) + " h" : K.num(r.fullEvery) + " s") : "never", ok: !r.thrash && (r.fullEvery > 600 || !fin(r.fullEvery)) }, { name: "Worst pause", value: fin(r.maxPause) ? K.ms(r.maxPause) : "–", ok: fin(r.maxPause) && r.maxPause <= I.pauseT, target: `≤ ${I.pauseT} ms` }, { name: "GC CPU", value: K.pct(Math.min(1, r.cpu)), ok: r.cpu <= I.cpuT, target: `≤ ${K.pct(I.cpuT, 0)}` }, { name: "Container memory", value: K.num(r.rss, 1) + " GB", ok: r.rss <= I.limit, target: `≤ ${I.limit} GB` }]) + K.verdict(c === true, c === true ? "meets the targets" : c); } };
      },
      accept(I, cfg) { const c = gcCheck(I, gcModel(I, cfg)); return c === true ? true : c[0].toUpperCase() + c.slice(1) + "."; },
      solve(I, spec) { for (const c of LB.byId.get("perf-gc-sizing").space(I, spec)) if (gcCheck(I, gcModel(I, c)) === true) return c; return null; },
      bad: (I) => I.lv === 1 ? [{ young: 0.125 }] : I.lv === 2 ? [{ pct: 25 }, { pct: 95 }] : [{ col: "G1", pct: 70 }, { col: "ZGC", pct: 25 }, { col: "ZGC", pct: 95 }].filter((c) => c.pct !== 95),
      hint: (I) => I.lv === 1 ? "If the young generation fills faster than objects die, short-lived objects survive and get promoted, filling the old generation." : I.lv === 2 ? "25% of 8 GB is 2 GB, less than the live set. But the heap isn't the only thing in the container." : "Only a concurrent collector keeps pauses in single-digit ms, and it needs headroom to run concurrently with allocation.",
      concept: "Generational GC, heap sizing and pause goals",
      how: "Most objects die young, so generational collectors copy the few survivors out of a young generation that fills at the allocation rate. If it's too small, collections are so frequent that medium-lived objects are still alive, get copied repeatedly and promoted, and fill the old generation, triggering expensive full GCs. In containers, the JVM sizes the heap as a percentage of the memory limit (MaxRAMPercentage, default 25%), which is often too small, while setting it near 100% ignores non-heap memory and gets the pod OOM-killed. G1 targets ~200 ms pauses; ZGC (generational by default since JDK 23, opt-in with -XX:+ZGenerational in 21) keeps pauses under a millisecond by working concurrently, but needs free heap headroom to keep up with allocation, or threads stall.",
      rule: "Size the young generation so objects die before it fills, leave heap headroom of 2–3× the live set, size heap as a share of the container minus non-heap memory, and pick the collector by pause target.",
      why: (I, sol) => { const r = gcModel(I, sol); return I.lv === 1 ? `With -Xmn${sol.young < 1 ? sol.young * 1024 + "m" : sol.young + "g"}, young GCs run every ${K.ms(r.iy * 1000)}, long after most objects die, so little is promoted and full GCs become rare.` : I.lv === 2 ? `${sol.pct}% gives a ${K.num(r.heap, 1)} GB heap: room for ${I.live} GB of live data, while heap + ~${I.native} GB non-heap stays under ${I.limit} GB.` : `${sol.col === "ZGC" ? "Generational ZGC" : sol.col} at ${sol.pct}% (${K.num(r.heap, 1)} GB): sub-millisecond pauses with enough headroom to collect concurrently, inside the container limit.`; },
    },
    /* 27 */ {
      id: "perf-heap-dominators",
      name: "Read the heap snapshot",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "select",
      gen(lv, R) { return { lv, n: R.int(300, 900) * 1000, id: R.int(100000, 999999), order: R.perm(5).map((x) => x - 1) }; },
      text: (I) => { const H = HEAP[I.lv - 1]; return `<p>A Node.js service's heap grows until it crashes with <code>FATAL ERROR: Reached heap limit</code>. You took two heap snapshots an hour apart in Chrome DevTools; this is the comparison, with each row's retainer and its <b>retained size</b> (what would be freed if that object were gone).</p>${K.table(H.head, H.rows(I).map((r) => [`<span class="mono">${esc(r[0])}</span>`, r[1], r[2], r[3]]), { compact: true })}<p><b>${H.q}</b></p>`; },
      ui: (I) => ({ opts: I.order.map((k) => HEAP[I.lv - 1].opts[k]), k: 1 }),
      ans: (I) => [I.order.indexOf(HEAP[I.lv - 1].ans)],
      diag: (I, a) => { const o = HEAP[I.lv - 1].opts[I.order[a[0]]]; return /string|ArrayBuffer|IncomingMessage|Buffer|Session|WebhookJob/.test(o) ? `Those objects are what leaks, not why. What retains them all?` : /max-old-space/.test(o) ? "A bigger heap only delays the crash." : "That retains almost nothing."; },
      hint: (I) => "Shallow size tells you what the leaked objects are; retained size of their dominator tells you who keeps them alive.",
      concept: "Shallow vs retained size, dominators",
      how: "A heap snapshot's shallow size is an object's own memory; its retained size is everything that would be freed if it were collected, i.e. everything it dominates (every path from the GC roots to those objects passes through it). Leaks show up as huge counts of small objects (strings, buffers, requests) with large shallow totals, but the fix is at their dominator: a module-level Map or array that only grows, or a long-lived EventEmitter collecting listeners (Node warns with MaxListenersExceededWarning after 10). Comparing two snapshots by growth ('# New') separates the leak from normal churn.",
      rule: "Diff two snapshots, sort by retained size, and follow the retainer chain up to the long-lived owner; fix the owner (bound it, evict, remove the listener), not the leaked objects.",
      why: (I) => [`The sessionCache Map dominated 1.21 GB: sessions were added on login and never evicted. Use a bounded LRU with TTL or an external store.`, `pendingRetries held every failed webhook job and its payload buffer forever; JSArrayBufferData was only the symptom. Cap the queue and drop or dead-letter after N attempts.`, `Each request called subscribe() and added an onMessage listener to the shared Redis subscriber; every closure kept its request alive. Remove the listener when the request ends, or route messages through one listener.`][I.lv - 1],
    },
    /* 28 */ {
      id: "perf-jvm-leak",
      name: "Hunt the JVM leak",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) { return { lv, pid: R.int(2000, 60000), co: R.pick(["acme", "nimbus", "kestrel", "orbit"]) }; },
      text: (I) => `<p>The pods' memory climbs steadily and they get OOM-killed every few hours. Before the next restart, use the JDK tools to find out <b>what</b> grows and <b>why</b>. One snapshot rarely proves a leak; compare over time.</p>`,
      ...LB.term({
        shell: (I) => leakShell(I),
        goal(st, I, a) {
          const want = I.lv - 1;
          if (a.pick !== want) return a.pick === 3 ? "A heap that's too small plateaus; this keeps growing." : "The evidence doesn't support that. Compare two measurements taken a few minutes apart.";
          if (I.lv < 3 && (st.hist || 0) < 2) return "Right idea, but one histogram can't show growth. Take two and compare.";
          if (I.lv === 3 && !st.meta) return "Right, but you haven't looked at the evidence that proves it (metaspace and class loaders).";
          return true;
        },
        solve: (I) => ({ log: I.lv < 3 ? [`jcmd ${I.pid} GC.class_histogram | head -12`, `jcmd ${I.pid} GC.class_histogram | head -12`] : [`jcmd ${I.pid} GC.heap_info`, `jcmd ${I.pid} VM.metaspace`], pick: I.lv - 1 }),
      }),
      bad: (I) => [{ log: [`jcmd ${I.pid} GC.class_histogram | head -12`, `jcmd ${I.pid} GC.class_histogram | head -12`, `jcmd ${I.pid} VM.metaspace`], pick: 3 }, { log: [`jcmd ${I.pid} GC.class_histogram | head -12`, `jcmd ${I.pid} GC.class_histogram | head -12`, `jcmd ${I.pid} VM.metaspace`], pick: I.lv % 3 }],
      hint: (I) => I.lv === 1 ? "Which application class's instance count grows between histograms, in step with HashMap$Node?" : I.lv === 2 ? "byte[] and String always top the list. Which less common classes grow in lockstep?" : "The heap after GC is stable, so look outside it: metaspace and the number of class loaders.",
      concept: "Finding a memory leak from growth",
      how: "A leak is memory that grows with time or traffic and never comes back after GC. jcmd GC.class_histogram forces a full GC and lists live objects by class, so two histograms minutes apart show what grows; generic classes (byte[], String) are usually payload, and the telling rows are application classes or structural ones growing in lockstep with them (HashMap$Node with a cache entry type; ThreadLocalMap$Entry with a request context left in pooled threads). If the heap is stable but RSS grows, look off-heap: metaspace grows when classes are generated per request (scripting engines, proxies, lambdas from a new class loader each time) and never unloaded.",
      rule: "Prove growth with two measurements, follow the growing application class to its owner, and check metaspace and native memory when the heap is flat.",
      why: (I) => [`com.${I.co}.pricing.CachedQuote and HashMap$Node grew ~18% between histograms in lockstep: a cache with no size limit or TTL.`, `RequestContext grew with ThreadLocalMap$Entry while the thread count stayed at 400: a ThreadLocal set per request and never removed, so pooled threads keep every context.`, `The heap after GC stayed ~1.3 GB, but metaspace and GroovyClassLoader loaders grew every few minutes: a new class loader compiles scripts per request. Cache compiled scripts or reuse one GroovyShell.`][I.lv - 1],
    },
    /* 29 */ {
      id: "perf-goroutine-leak",
      name: "Goroutines that never return",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) { return { lv, svc: R.pick(["pricing", "quota", "catalog", "gateway"]) }; },
      text: (I) => `<p><code>${esc(I.svc)}</code>'s memory and goroutine count grow linearly until the pod is OOM-killed. A goroutine that blocks forever is never collected, along with everything it references. Use pprof's goroutine profile (it groups goroutines by identical stack) and the code to find the leak.</p>`,
      ...LB.term({
        shell: (I) => goShell(I),
        goal(st, I, a) {
          if (a.pick !== I.lv - 1) return a.pick === 3 ? "A deadlock freezes a fixed set of goroutines; this count grows with traffic." : a.pick === 4 ? "GOMAXPROCS limits parallelism; it doesn't create goroutines." : "Look at which stack the growing goroutines are parked in, and read that code.";
          if (!st.prof) return "Right, but you haven't looked at the goroutine profile that proves it.";
          return true;
        },
        solve: (I) => ({ log: ["curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | head -30", `cat /app/${["prices", "quota", "client"][I.lv - 1]}.go`], pick: I.lv - 1 }),
      }),
      bad: (I) => [{ log: ["curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | head -30"], pick: (I.lv) % 3 }, { log: ["curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | head -30"], pick: 3 }],
      hint: (I) => I.lv === 1 ? "What happens to the sender when the select takes the time.After branch?" : I.lv === 2 ? "r.Context() is cancelled when the request ends. Does the loop ever look at it?" : "Two goroutines per leaked connection in persistConn read/write loops. Look at every return path before Body.Close is deferred.",
      concept: "Goroutine leaks",
      how: "Goroutines are cheap but not free: each has a stack and keeps everything it references alive, and the runtime never kills a blocked one. Classic leaks: a sender on an unbuffered channel whose receiver gave up (fix: a buffered channel of size 1, or select on ctx.Done() when sending); a loop that never checks ctx.Done(), started per request; and HTTP responses whose Body isn't closed on every path, which keeps the connection, plus its readLoop and writeLoop goroutines, alive. The goroutine profile (?debug=1) groups identical stacks with a count, so the leak is the group that grows between two samples.",
      rule: "Every goroutine you start needs a guaranteed way to finish: give senders a buffer or a ctx.Done() case, loop on ctx, and defer resp.Body.Close() right after checking the error.",
      why: (I) => [`fetchPrices returns on time.After, but its goroutine still blocks on ch <- p forever because nobody receives. make(chan []Price, 1) lets it finish.`, `watchQuota is started per request with r.Context() but only reads t.C, so it runs forever after the request ends. Add case <-ctx.Done(): return.`, `client.go returns on a non-200 status before Body.Close is deferred, so those connections are never released and each keeps a readLoop and a writeLoop goroutine. Defer Close right after the error check.`][I.lv - 1],
    },
    /* 30 */ {
      id: "perf-cancellation",
      name: "Let cancellation through",
      kind: "Code review",
      skills: ["diagnose", "design"],
      w: "lines",
      gen(lv, R) { return { lv, n: R.int(20, 60) }; },
      text: (I) => `<p>${I.lv === 1 ? `When clients cancel a slow search, the database keeps running their queries: pg_stat_activity shows ~${I.n} long-running searches for clients that are long gone.` : I.lv === 2 ? "The partner client's 2 s timeout doesn't seem to work: calls sometimes take 9 s, and requests keep retrying after the caller has given up." : `Under load, the search service's goroutine count and the number of in-flight index searches climb whenever queries time out. A teammate also asked whether the audit line is a bug.`}</p><p><b>Flag the ${I.lv === 1 ? "line that breaks" : "two lines that break"} cancellation or deadline propagation.</b></p>`,
      ui: (I) => { const d = CANCEL[I.lv - 1]; return { file: d.file, lines: diffLines(d.lines), k: I.lv === 1 ? 1 : 2 }; },
      ans: (I) => flagged(CANCEL[I.lv - 1].lines),
      diag: (I, a) => { const L = CANCEL[I.lv - 1].lines, w = a.filter((i) => !L[i][2]); if (!w.length) return "One found; there's another."; const t = L[w[0]][1]; return /WithoutCancel/.test(t) ? "Detaching the audit write is deliberate (Go 1.21's context.WithoutCancel keeps values but drops cancellation); it's bounded work that should finish." : /WithTimeout\(ctx, 2/.test(t) ? "Deriving a timeout from the caller's ctx is correct; the problem is whether the requests use it." : `<code>${esc(t.trim().slice(0, 60))}</code> is fine.`; },
      hint: (I) => I.lv === 1 ? "Which context does the query use now, and is it cancelled when the client leaves?" : I.lv === 2 ? "The request must carry the context, and the wait between attempts must stop when it's done." : "What happens to the searching goroutine if ctx expires first? And what happens to the timer if you throw away cancel?",
      concept: "Propagating cancellation and deadlines",
      how: "A request's context carries its deadline and is cancelled when the client disconnects or the server gives up. Work started for it should observe that: pass ctx to database and HTTP calls (QueryContext, NewRequestWithContext) so they abort, and wait with select on ctx.Done() instead of time.Sleep. Replacing it with context.Background() orphans the work: it runs to completion for nobody, using connections and CPU during exactly the overload that caused the timeouts. Discarding cancel from WithTimeout leaks the timer until it fires (go vet's lostcancel check flags it), and a goroutine sending on an unbuffered channel after its receiver returned blocks forever. Work that must outlive the request can be detached on purpose with context.WithoutCancel.",
      rule: "Thread ctx through every call, wait with select on ctx.Done(), always defer cancel(), and detach only deliberately, with a bound of its own.",
      why: (I) => ["context.Background() isn't cancelled when the client leaves, so QueryContext keeps the query running. Use r.Context().", "http.NewRequest has no context, so the 2 s deadline never reaches the HTTP call, and time.Sleep keeps retrying after the deadline. Use http.NewRequestWithContext(ctx, ...) and select on ctx.Done() or a timer.", "Discarding cancel leaks the timer (go vet lostcancel), and the unbuffered results channel leaves the search goroutine blocked forever after a timeout; make(chan Result, 1) fixes that. The audit line is deliberate detachment."][I.lv - 1],
    },
  ]);
  function amdahlTruth(I) {
    if (I.lv === 1) return 1 / (1 - I.p + I.p / I.N);
    if (I.lv === 2) { const s = (4 / I.S4 - 1) / 3; return 1 / (s + (1 - s) / I.N); }
    return Math.sqrt((1 - I.sig) / I.kap);
  }

  /* ================= budgets, herds, sharing, layout, benchmarks, switching, contention, percentiles, fan-out, profiling ================= */
  /* timeout budget Monte Carlo: gateway → A (local work) → B with per-attempt timeout and retries */
  const tbCache = new Map();
  function tbSamples(I) {
    if (tbCache.has(I.seed)) return tbCache.get(I.seed);
    const R = rng(I.seed), M = 3000, a = [], b = [];
    for (let i = 0; i < M; i++) { a.push(K.logn(R, I.aMed, 0.3)); const row = []; for (let k = 0; k < 4; k++) row.push(R.next() < I.pSlow ? 1500 + R.next() * 1500 : K.logn(R, I.bMed, 0.5)); b.push(row); }
    const v = { a, b, M }; tbCache.set(I.seed, v); return v;
  }
  function tbEval(I, cfg) {
    const { a, b, M } = tbSamples(I), r = cfg.r, T = cfg.tb, prop = cfg.prop === "on";
    let ok = 0, att = 0;
    for (let i = 0; i < M; i++) {
      let t = a[i];
      for (let k = 0; k <= r; k++) {
        const rem = I.G - t;
        if (prop && rem <= 5) break;
        const tt = prop ? Math.min(T, rem) : T;
        att++;
        const l = b[i][k];
        if (l <= tt) { t += l; if (t <= I.G) ok++; break; }
        t += tt + 25;
      }
    }
    const worst = I.aMax + (r + 1) * T + r * 25;
    return { succ: ok / M, load: att / M, worst, orphan: !prop && worst > I.G };
  }
  const tbCheck = (I, cfg, e) => e.orphan ? `worst case ${K.num(I.aMax)} + ${cfg.r + 1} × ${cfg.tb} ms${cfg.r ? " + backoff" : ""} = ${K.num(e.worst)} ms, past the gateway's ${I.G} ms: A keeps calling B after the client already got a 504` : I.maxLoad && e.load > I.maxLoad ? `B receives ${e.load.toFixed(2)} attempts per request (limit ${I.maxLoad})` : true;

  /* OAuth token refresh herd */
  function herdModel(I, cfg) {
    const sf = cfg.sf === "on", ra = cfg.ra === "on", jit = cfg.jit === "on";
    const inflightPerPod = (I.rps * I.refLat) / 1000; // requests that see the expired token while the refresh is in flight
    const podsPerSec = I.sync ? I.pods : Math.max(1, I.pods / I.rollout);
    let peak;
    if (ra) peak = jit ? Math.max(1, Math.ceil(I.pods / (I.ttl * 60 * 0.1))) : Math.ceil(podsPerSec);
    else peak = Math.ceil(podsPerSec * (sf ? 1 : Math.max(1, inflightPerPod)));
    const rejected = peak > I.limit;
    const blockMs = ra && !rejected ? 0 : rejected ? 5000 : I.refLatTop; // requests wait for an inline refresh (or fail)
    const frac = ra && !rejected ? 0 : (blockMs / 60000) * 1; // share of a minute's requests affected
    const p99min = frac > 0.01 ? blockMs : I.base;
    return { peak, rejected, p99min, frac };
  }
  const herdCheck = (I, r) => r.rejected ? `${K.num(r.peak)} token requests hit the IdP in one second (limit ${I.limit}/s): 429s, and every request waiting on them fails` : r.p99min > I.target ? `at each expiry, requests block on an inline refresh (~${K.ms(r.p99min)} when the IdP is busy), so that minute's p99 is ${K.ms(r.p99min)} (target ${I.target} ms)` : true;

  /* false sharing */
  const LAYOUT = { atomic: "one shared AtomicLong", packed: "long[threads] (packed)", pad64: "per-thread slots padded to 64 B", pad128: "per-thread slots padded to 128 B" };
  function fsModel(I, cfg) {
    const T = I.threads, L = cfg.layout;
    const nsOp = L === "atomic" ? 22 * T : L === "packed" ? 45 : L === "pad64" ? (I.pairPrefetch ? 6 : 1.2) : 1.2;
    const scope = cfg.scope || "all";
    const bytes = { atomic: 8, packed: 8 * T, pad64: 64 * T, pad128: 128 * T }[L];
    const nCounters = I.counters, hot = Math.ceil(nCounters * 0.01);
    const mem = scope === "hot" ? hot * bytes + (nCounters - hot) * 8 * T : nCounters * bytes;
    // hot counters dominate the work; cold ones are rarely touched
    const hotNs = nsOp, coldNs = scope === "hot" ? (L === "atomic" ? nsOp : 45) : nsOp;
    const ops = L === "atomic" ? 1e9 / (nsOp / T) / T * 1 : (T * 1e9) / (0.995 * hotNs + 0.005 * coldNs);
    return { ops: L === "atomic" ? 1e9 / 22 : ops, mem, nsOp };
  }
  const fsCheck = (I, r) => r.ops < I.target ? `${K.num(r.ops / 1e6)} M increments/s (need ${K.num(I.target / 1e6)} M)` : r.mem > I.memB ? `${K.bytes(r.mem)} of counters is over the ${K.bytes(I.memB)} budget` : true;

  /* layout estimates */
  function layoutTruth(I) {
    if (I.lv === 1) return I.s / 4;
    if (I.lv === 2) return (I.N * I.miss) / 1e6; // ms
    return ((I.N * 64) / (I.bw * 1e9)) * 1000; // ms
  }

  /* benchmark diffs */
  const BENCH = [
    { file: "orders/sort_bench_test.go", lines: [
      ["@", "@@ -1,0 +1,11 @@"],
      ["+", "func BenchmarkSortOrders(b *testing.B) {"],
      ["+", "\torders := loadFixture(b, \"orders-100k.json\") // ~120 ms to read and decode", 1],
      ["+", "\tfor i := 0; i < b.N; i++ {"],
      ["+", "\t\ts := slices.Clone(orders)"],
      ["+", "\t\tslices.SortFunc(s, byTotal)"],
      ["+", "\t\tsink = s"],
      ["+", "\t}"],
      ["+", "}"],
    ] },
    { file: "bench/src/jmh/java/EncodeBench.java", lines: [
      ["@", "@@ -1,0 +1,16 @@"],
      ["+", "@State(Scope.Thread)"],
      ["+", "@Fork(1)"],
      ["+", "@Warmup(iterations = 0)", 1],
      ["+", "@Measurement(iterations = 5, time = 1)"],
      ["+", "@BenchmarkMode(Mode.AverageTime)"],
      ["+", "@OutputTimeUnit(TimeUnit.NANOSECONDS)"],
      ["+", "public class EncodeBench {"],
      ["+", "  byte[] payload = Fixtures.randomBytes(512);"],
      ["+", "  @Benchmark"],
      ["+", "  public void encode() {"],
      ["+", "    Base64.getEncoder().encodeToString(payload);", 1],
      ["+", "  }"],
      ["+", "}"],
    ] },
    { file: "bench/src/jmh/java/CacheBench.java", lines: [
      ["@", "@@ -1,0 +1,17 @@ // decides between two caches for the checkout path (SLO: p99 < 2 µs)"],
      ["+", "@State(Scope.Benchmark)"],
      ["+", "@Fork(3)"],
      ["+", "@Warmup(iterations = 5, time = 2)"],
      ["+", "@BenchmarkMode(Mode.AverageTime)", 1],
      ["+", "@OutputTimeUnit(TimeUnit.MICROSECONDS)"],
      ["+", "public class CacheBench {"],
      ["+", "  @Param({\"caffeine\", \"guava\"}) String impl;"],
      ["+", "  Cache<String, Cart> cache;"],
      ["+", "  @Setup public void setup() { cache = Caches.create(impl); Fixtures.load(cache, 1_000_000); }"],
      ["+", "  @Benchmark"],
      ["+", "  public Cart get() { return cache.get(\"cart:42\"); }", 1],
      ["+", "}"],
    ] },
  ];

  /* context switching terminal */
  const CS_OPTS = ["Too many runnable threads: the CPU spends its time switching between them", "Lock contention: threads constantly block and wake on a futex", "CPU throttling: the runtime runs more parallel threads than the container's CPU quota", "Disk I/O wait", "Memory pressure: the box is swapping"];
  function csShell(I) {
    const P = I.pid, k = I.lv - 1;
    const vm = () => { const rows = [["r", "b", "swpd", "free", "buff", "cache", "si", "so", "bi", "bo", "in", "cs", "us", "sy", "id", "wa", "st"]]; for (let j = 0; j < 3; j++) rows.push(k === 0 ? [380 + j * 7, 0, 0, 4120000, 88120, 9510000, 0, 0, 0, 40, 51000, 612000 + j * 4100, 41, 52, 7, 0, 0] : k === 1 ? [3, 0, 0, 4120000, 88120, 9510000, 0, 0, 0, 40, 98000, 905000 + j * 3100, 18, 44, 38, 0, 0] : [2 + j, 0, 0, 4120000, 88120, 9510000, 0, 0, 0, 22, 9100, 31000, 22, 4, 74, 0, 0]); return "procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n" + K.cols(rows, 1); };
    const pid = () => K.cols([["Average:", "UID", "PID", "cswch/s", "nvcswch/s", "Command"], ["Average:", 1000, P, k === 0 ? "21410.00" : k === 1 ? "861203.00" : "4120.00", k === 0 ? "583200.00" : k === 1 ? "9120.00" : "26880.00", I.proc]], 2);
    const sh = K.shell([
      { re: /^vmstat(?: \d+(?: \d+)?)?$/, use: "vmstat 1 3", desc: "run queue, context switches (cs), CPU split", run: (m, st) => { st.seen.vm = 1; return vm(); } },
      { re: /^pidstat -w(?: -p (\d+))?(?: \d+(?: \d+)?)?$/, use: "pidstat -w -p <pid> 1 1", desc: "voluntary vs involuntary context switches", run: (m, st) => { st.seen.pid = 1; return pid(); } },
      { re: /^ps -o nlwp= -p (\d+)$|^ps -o nlwp -p (\d+)$/, use: "ps -o nlwp= -p <pid>", desc: "thread count", run: (m, st) => { st.seen.ps = 1; return String(k === 0 ? st.threads + 23 : k === 1 ? 72 : 71); } },
      { re: /^nproc$/, use: "nproc", desc: "CPUs visible", run: () => (k === 2 ? "64" : "8") },
      { re: /^cat \/sys\/fs\/cgroup\/cpu\.max$/, use: "cat /sys/fs/cgroup/cpu.max", desc: "CPU quota (quota period)", run: () => (k === 2 ? "200000 100000" : "max 100000") },
      { re: /^cat \/sys\/fs\/cgroup\/cpu\.stat$/, use: "cat /sys/fs/cgroup/cpu.stat", desc: "throttling counters", run: (m, st) => { st.seen.cg = 1; return k === 2 && !st.fixed ? "usage_usec 912384112\nuser_usec 801223412\nsystem_usec 111160700\nnr_periods 81240\nnr_throttled 79310\nthrottled_usec 1821993120" : "usage_usec 412384112\nuser_usec 391223412\nsystem_usec 21160700\nnr_periods 81240\nnr_throttled 12\nthrottled_usec 41220"; } },
      { re: /^offcputime(?:-bpfcc)? -p (\d+)(?: \d+)?$/, use: "offcputime-bpfcc -p <pid> 5", desc: "where threads block (off-CPU stacks)", run: (m, st) => { st.seen.off = 1; return k === 1 ? `    finish_task_switch.isra.0\n    schedule\n    futex_wait_queue\n    futex_wait\n    __lll_lock_wait\n    pthread_mutex_lock\n    ${I.proc}::MetricsRegistry::record(std::string_view, double)\n    ${I.proc}::Pipeline::process(Batch&)\n    -                ${I.proc} (${P})\n        4120331011\n\n    finish_task_switch.isra.0\n    schedule\n    do_epoll_wait\n    -                ${I.proc} (${P})\n        612003114` : `    finish_task_switch.isra.0\n    schedule\n    exit_to_user_mode_loop\n    -                ${I.proc} (${P})\n        3812090211\n\n    finish_task_switch.isra.0\n    schedule\n    do_epoll_wait\n    -                ${I.proc} (${P})\n        412003114`; } },
      { re: /^go version (\S+)$/, use: "go version /app/server", desc: "Go toolchain the binary was built with", run: () => "/app/server: go1.23.4" },
      { re: /^app config get(?: (\S+))?$/, use: "app config get worker_threads", desc: "", run: (m, st) => `worker_threads = ${st.threads}` },
      { re: /^app config set worker_threads (\d+)$/, use: "app config set worker_threads <n>", desc: "resize the request thread pool (hot reload)", run: (m, st) => { st.threads = +m[1]; return `worker_threads = ${st.threads} (applied)`; } },
      { re: /^kubectl set env deploy\/(\S+) GOMAXPROCS=(\d+)$/, use: "kubectl set env deploy/<name> GOMAXPROCS=<n>", desc: "set an env var and roll the deployment", run: (m, st) => { st.gmp = +m[2]; st.fixed = st.gmp <= 2; return `deployment.apps/${m[1]} env updated`; } },
      { re: /^loadtest$/, use: "loadtest", desc: "replay 60 s of production traffic and report", run: (m, st) => { st.tested = 1; const good = k === 0 ? st.threads >= 8 && st.threads <= 64 : k === 2 ? st.fixed : false; return good ? `throughput 9,840 req/s · p99 41 ms · errors 0.00%` : `throughput ${k === 1 ? "3,120" : "4,410"} req/s · p99 ${k === 1 ? "380" : "910"} ms · errors 0.02%`; } },
    ]);
    return { prompt: `ops@${I.proc}-3:~$`, init: { seen: {}, threads: k === 0 ? I.threads : 64, gmp: 64, fixed: false }, run: (l, st) => sh.run(l, st), par: k === 1 ? 5 : 6, opts: CS_OPTS, optq: "Root cause",
      motd: `ALERT ${I.proc} throughput down ${k === 1 ? "60" : "45"}%, p99 ${k === 1 ? "380" : "910"} ms\n${k === 2 ? "Go service, container limit cpu: 2 on a 64-core node" : `8-core VM, process ${I.proc} pid ${P}`}`,
      cmds: ["vmstat 1 3", `pidstat -w -p ${P} 1 1`, `ps -o nlwp= -p ${P}`, "nproc", "cat /sys/fs/cgroup/cpu.max", "cat /sys/fs/cgroup/cpu.stat", `offcputime-bpfcc -p ${P} 5`, ...(k === 0 ? ["app config set worker_threads <n>"] : k === 2 ? ["go version /app/server", `kubectl set env deploy/${I.proc} GOMAXPROCS=<n>`] : []), "loadtest"] };
  }

  /* lock contention */
  const LOCKD = { mutex: "one mutex around the map", s16: "16 lock stripes", s256: "256 lock stripes", shard: "per-thread shards, merged on read" };
  function lcModel(I, cfg) {
    const c = cfg.sect === "io" ? I.cIO : I.c, T = I.T, w = I.w; // µs
    const S = { mutex: 1, s16: 16, s256: 256, shard: Infinity }[cfg.lock];
    const frac = S === Infinity ? 0 : Math.max(I.hot + (1 - I.hot) / S, 1 / S);
    const thr = T / (w + c) * 1e6;
    const lockCap = frac ? 1e6 / (c * frac) : Infinity;
    const ops = Math.min(thr, lockCap * 0.9);
    return { ops, util: frac ? Math.min(1, ops / lockCap) : 0, cost: { mutex: 0, s16: 1, s256: 2, shard: 4 }[cfg.lock] + (cfg.sect === "io" ? 0.5 : 0) };
  }

  /* percentiles */
  const BK = [10, 25, 50, 100, 250, 500, 1000, 2500];
  function pctTruth(I) {
    if (I.lv === 3) { const tot = I.hosts.reduce((s, h) => s + h.inf, 0), over = I.hosts.reduce((s, h) => s + (h.inf - h.le[I.thrI]), 0); return (over / tot) * 100; }
    const counts = I.lv === 1 ? I.counts : BK.map((_, b) => I.hosts.reduce((s, h) => s + h.counts[b], 0));
    const tot = counts.reduce((s, x) => s + x, 0), need = tot * 0.99;
    let acc = 0;
    for (let b = 0; b < counts.length; b++) { acc += counts[b]; if (acc >= need) return b; }
    return counts.length - 1;
  }

  /* bounded concurrency against a rate-limited API */
  function fanModel(I, cfg) {
    const c = cfg.c === "∞" ? I.items : cfg.c;
    const lat = I.lat * (1 + (I.grow ? c / I.grow : 0));
    const offered = (c / lat) * 1000, limit = I.limit;
    const good = Math.min(offered, limit), rej = Math.max(0, offered - limit) / offered;
    const time = I.items / good;
    return { lat, offered, good, rej, time };
  }
  const fanCheck = (I, r) => r.rej > 0.01 ? `${K.pct(r.rej)} of calls get 429 Too Many Requests (offering ${K.num(r.offered)}/s against a ${I.limit}/s limit)` : r.time > I.deadline ? `the batch takes ${K.num(r.time)} s (deadline ${I.deadline} s)` : true;

  /* profiling steps */
  const PROF = [
    { opts: ["Pick one pod that shows the regression (not the whole fleet)", "Capture 30 s of CPU: curl -o cpu.pprof 'localhost:6060/debug/pprof/profile?seconds=30'", "Open it as a flame graph: go tool pprof -http=:8081 cpu.pprof", "Capture the same profile on a healthy pod (or before the deploy) and compare", "Rebuild with -gcflags='all=-N -l' so the profile is easier to read, then redeploy", "Restart the pod first so the profile starts clean", "Set runtime.SetBlockProfileRate(1) on every pod to see everything"], req: [0, 1, 2, 3], before: [[0, 1], [1, 2]] },
    { opts: ["Restart one canary instance with node --perf-basic-prof so perf can name JIT-compiled JS frames", "perf record -F 99 -g -p <pid> -- sleep 30", "perf script | stackcollapse-perf.pl | flamegraph.pl > cpu.svg", "Read the widest top edges of the JS frames", "perf record -F 10000 -a -g on every host for 5 minutes", "strace -f -p <pid> to see what the event loop is doing", "Add console.time() around every function and redeploy"], req: [0, 1, 2, 3], before: [[0, 1], [1, 2], [2, 3]] },
    { opts: ["Pick one canary pod and check perf access: kernel.perf_event_paranoid is 2 and the container lacks CAP_PERFMON", "Use async-profiler's timer-based sampling, which needs no perf_events: asprof -d 30 -e itimer -f /tmp/cpu.html 1", "Copy the result out: kubectl cp <pod>:/tmp/cpu.html ./cpu.html", "Open the flame graph; enable -XX:+DebugNonSafepoints next time for accurate inlined frames", "Set privileged: true on the deployment so perf works in every pod", "Take jstack every 10 ms in a loop to sample stacks", "Enable JFR's method tracing on all methods across the fleet"], req: [0, 1, 2, 3], before: [[0, 1], [1, 2], [2, 3]] },
  ];

  LB.addAll("perf", [
    /* 31 */ {
      id: "perf-timeout-budget",
      name: "Budget the timeouts",
      kind: "Config change",
      skills: ["tune", "design"],
      w: "tune",
      sense: "max",
      vname: "success rate",
      vfmt: (v) => K.pct(v, 2),
      gen(lv, R) { return { lv, seed: `perf-tb/${lv}/${R.int(1, 1e9)}`, G: lv === 3 ? 800 : R.pick([800, 1000]), aMed: 40, aMax: 120, bMed: R.pick([50, 60, 80]), pSlow: R.pick([0.12, 0.15]), maxLoad: lv === 2 ? 1.2 : 0 }; },
      text: (I) => `<p>The gateway gives each request <b>${I.G} ms</b>, then returns 504. Service A spends ~40 ms (up to ${I.aMax} ms) on its own work, then calls B, whose latency is ~${I.bMed} ms median, but ${K.pct(I.pSlow, 0)} of calls hit a slow replica and take 1.5–3 s; a retry usually lands on a healthy one. Retries back off 25 ms.</p><p>Choose A's per-attempt timeout and retries to <b>maximise the share of requests that succeed within the gateway's budget</b>, without A ever still calling B after the gateway gave up${I.lv === 2 ? `, and with at most <b>${I.maxLoad}</b> attempts per request on B` : ""}.${I.lv === 3 ? " A can now read the remaining deadline from the incoming request." : ""}</p>`,
      ui: (I) => {
        const knobs = [{ k: "tb", label: "A → B timeout per attempt", opts: I.lv === 3 ? [100, 200, 300, 500, 1000] : [100, 150, 200, 300, 500, 1000], unit: "ms" }, { k: "r", label: "Retries", opts: [0, 1, 2, 3] }];
        if (I.lv === 3) knobs.push({ k: "prop", label: "Deadline propagation", opts: ["off", "on"], help: "cap each attempt at the time left in the caller's deadline" });
        return { knobs, init: { tb: 1000, r: 0, prop: "off" }, live: (cfg) => { const e = tbEval(I, { prop: "off", ...cfg }), c = tbCheck(I, { prop: "off", ...cfg }, e); return K.metrics([{ name: "Success in budget", value: K.pct(e.succ, 2), ok: null }, { name: "Worst case", value: cfg.prop === "on" ? `≤ ${I.G} ms` : K.ms(e.worst), ok: !e.orphan, target: `≤ ${I.G} ms` }, { name: "Attempts / request", value: e.load.toFixed(3), ok: !I.maxLoad || e.load <= I.maxLoad }]) + K.verdict(c === true, c === true ? "fits the budget" : c); } };
      },
      valid: (I, cfg) => tbCheck(I, { prop: "off", ...cfg }, tbEval(I, { prop: "off", ...cfg })),
      val: (I, cfg) => K.round(tbEval(I, { prop: "off", ...cfg }).succ, 4),
      hint: (I) => I.lv === 1 ? "A long timeout waits out the slow replica; a short one plus a retry usually doesn't. The sum still has to fit." : I.lv === 2 ? "Every timed-out attempt is extra load on B. How short can the timeout be before healthy calls start timing out too?" : "With the deadline propagated, the last attempt just gets whatever time is left.",
      concept: "Timeout budgets across a call chain",
      how: "Each hop's timeout must fit inside its caller's: local work + (retries + 1) × per-attempt timeout + backoff ≤ the caller's remaining budget, or the callee keeps working, and retrying, after the client has already been told it failed. Within that, a shorter per-attempt timeout plus a retry beats one long timeout when slowness is per-replica: the retry usually lands somewhere healthy. Too short and healthy calls time out, multiplying load. Propagating the deadline (gRPC deadlines, a header with the remaining budget, Go contexts) lets every hop cap its attempts at the time actually left.",
      rule: "Derive each hop's timeout from the caller's budget, set the per-attempt timeout a bit above the callee's healthy p99, retry only within the remaining deadline, and propagate it downstream.",
      why: (I, sol) => { const e = tbEval(I, { prop: "off", ...sol }); return `${sol.tb} ms × ${sol.r + 1} attempt${sol.r ? "s" : ""}${sol.prop === "on" ? " with deadline propagation" : ""}: ${K.pct(e.succ, 2)} succeed in budget at ${e.load.toFixed(2)} attempts per request${sol.prop !== "on" ? `, worst case ${K.num(e.worst)} ms` : ""}.`; },
    },
    /* 32 */ {
      id: "perf-token-herd",
      name: "Every pod refreshes at once",
      kind: "Hardening",
      skills: ["design", "tune"],
      w: "tune",
      gen(lv, R) { return { lv, pods: lv === 3 ? R.pick([120, 150]) : R.pick([30, 40]), rps: R.pick([200, 300]), refLat: 300, refLatTop: lv === 1 ? 300 : 1500, ttl: 60, limit: 50, rollout: 120, sync: lv === 3, base: 80, target: lv === 1 ? 500 : 250 }; },
      text: (I) => `<p>${I.pods} pods each serve ~${I.rps} requests/s and call a partner API with an OAuth access token cached in memory for ${I.ttl} minutes. When it expires, requests fetch a new one from the identity provider inline (~${I.refLat} ms${I.refLatTop > I.refLat ? `, ~${K.ms(I.refLatTop)} at the top of the hour when every tenant refreshes` : ""}). The IdP allows <b>${I.limit} token requests/s</b> for your client, then returns 429. ${I.lv === 3 ? "Last night a node-pool upgrade restarted <b>all pods within the same few seconds</b>." : `Pods normally start over a ${I.rollout} s rolling deploy.`}</p><p>Stay under the IdP limit and keep the per-minute p99 under <b>${I.target} ms</b>.</p>`,
      ui: (I) => {
        const knobs = [{ k: "sf", label: "Coalesce refreshes (singleflight)", opts: ["off", "on"], help: "one in-flight refresh per pod; other requests wait for it" }];
        if (I.lv > 1) knobs.push({ k: "ra", label: "Refresh ahead", opts: ["off", "on"], help: "background refresh at 80% of the token's lifetime" });
        if (I.lv === 3) knobs.push({ k: "jit", label: "Jitter the refresh time", opts: ["off", "on"], help: "random point in the last 20% of the lifetime" });
        return { knobs, init: { sf: "off", ra: "off", jit: "off" }, live: (cfg) => { const r = herdModel(I, { ra: "off", jit: "off", ...cfg }), c = herdCheck(I, r); return K.metrics([{ name: "Peak IdP calls/s", value: K.num(r.peak), ok: !r.rejected, target: `≤ ${I.limit}` }, { name: "Expiry-minute p99", value: K.ms(r.p99min), ok: r.p99min <= I.target, target: `≤ ${I.target} ms` }]) + K.verdict(c === true, c === true ? "no herd" : c); } };
      },
      accept(I, cfg) { const c = herdCheck(I, herdModel(I, { ra: "off", jit: "off", ...cfg })); return c === true ? true : c[0].toUpperCase() + c.slice(1) + "."; },
      solve(I, spec) { for (const c of LB.byId.get("perf-token-herd").space(I, spec)) if (herdCheck(I, herdModel(I, { ra: "off", jit: "off", ...c })) === true) return c; return null; },
      bad: (I) => I.lv === 1 ? [{ sf: "off" }] : I.lv === 2 ? [{ sf: "on", ra: "off" }, { sf: "off", ra: "off" }] : [{ sf: "on", ra: "on", jit: "off" }, { sf: "on", ra: "off", jit: "on" }],
      hint: (I) => I.lv === 1 ? `At expiry, ~${Math.round((I.rps * I.refLat) / 1000)} requests per pod arrive while the first refresh is still in flight.` : I.lv === 2 ? "Coalescing fixes the IdP load, but requests still wait for the refresh. Can they never wait?" : "Refreshing ahead at exactly 80% keeps pods that started together in lockstep.",
      concept: "Thundering herds and synchronised expiry",
      how: "When many callers notice the same expiry at once, they all do the expensive thing at once: every request on every pod fetches a token, rebuilds the cache entry or wakes on the same lock. Coalescing (singleflight, a per-key lock with waiters) makes one caller do the work while the rest wait for its result. Refreshing ahead in the background removes the wait from the request path entirely. But anything that started together stays synchronised: pods restarted at the same moment refresh at the same moment forever, so add jitter to expiries and refresh times.",
      rule: "Coalesce concurrent refreshes, refresh before expiry off the request path, and jitter every TTL and timer that many instances share.",
      why: (I, sol) => { const r = herdModel(I, { ra: "off", jit: "off", ...sol }); return `Peak ${K.num(r.peak)} IdP calls/s and expiry-minute p99 ${K.ms(r.p99min)} with ${[`singleflight ${sol.sf}`, sol.ra ? `refresh-ahead ${sol.ra}` : "", sol.jit ? `jitter ${sol.jit}` : ""].filter(Boolean).join(", ")}.`; },
    },
    /* 33 */ {
      id: "perf-false-sharing",
      name: "Counters that fight over a cache line",
      kind: "Experiment",
      skills: ["tune", "diagnose"],
      w: "tune",
      sense: "min",
      vname: "memory:",
      vfmt: (v) => K.bytes(v),
      gen(lv, R) { return { lv, threads: lv === 1 ? 8 : 16, pairPrefetch: lv > 1, counters: lv === 3 ? R.pick([40000, 60000]) : 1, target: lv === 1 ? 4e9 : 1e10, memB: lv === 3 ? 64 * 1024 * 1024 : 1e12 }; },
      text: (I) => `<p>${I.threads} threads each increment their own statistics counter in a hot loop. ${I.lv === 1 ? "They're stored in a <code>long[]</code>, one slot per thread, on a 64-byte-cache-line ARM server." : `It runs on x86 servers whose L2 spatial prefetcher pulls cache lines in 128-byte pairs.`}${I.lv === 3 ? ` There are <b>${K.num(I.counters)}</b> counter groups (one per tenant); ~1% of them are hot, and the counter memory budget is <b>${K.bytes(I.memB)}</b>.` : ""} Scaling is terrible: adding threads makes it slower.</p><p>Reach <b>${K.num(I.target / 1e9)} billion increments/s</b> with the least memory.</p>`,
      ui: (I) => {
        const knobs = [{ k: "layout", label: "Counter layout", opts: I.lv === 1 ? ["packed", "pad64"] : ["atomic", "packed", "pad64", "pad128"], fmt: (v) => LAYOUT[v], select: true }];
        if (I.lv === 3) knobs.push({ k: "scope", label: "Apply to", opts: ["all", "hot"], fmt: (v) => (v === "all" ? "every counter group" : "only the hot 1%"), help: "cold groups keep the packed layout" });
        return { knobs, init: { layout: "packed", scope: "all" }, live: (cfg) => { const r = fsModel(I, cfg || { layout: "packed" }), c = fsCheck(I, r); return K.metrics([{ name: "ns per increment", value: r.nsOp.toFixed(1), ok: r.nsOp < 2 }, { name: "Throughput", value: K.num(r.ops / 1e6) + " M/s", ok: r.ops >= I.target, target: `≥ ${K.num(I.target / 1e6)} M/s` }, { name: "Counter memory", value: K.bytes(r.mem), ok: r.mem <= I.memB }]) + K.verdict(c === true, c === true ? "scales" : c); } };
      },
      valid: (I, cfg) => fsCheck(I, fsModel(I, cfg)),
      val: (I, cfg) => fsModel(I, cfg).mem,
      hint: (I) => I.lv === 1 ? "Eight longs fit in one 64-byte line. Every write invalidates that line in every other core's cache." : I.lv === 2 ? "With adjacent-line prefetch, two threads 64 bytes apart still drag each other's lines around." : "Padding every group by 128 bytes per thread blows the budget; cold counters barely contend.",
      concept: "False sharing",
      how: "Caches move memory in lines (64 bytes on most x86 and ARM servers). When two cores write different variables that live on the same line, the coherence protocol bounces the line between them on every write, so 'independent' counters run as if they shared a lock. Padding each thread's slot to its own line fixes it; on x86 the spatial prefetcher pairs adjacent lines, so 128-byte separation is the safe choice (Java's @Contended pads 128 bytes, C++ exposes std::hardware_destructive_interference_size). A single shared atomic is worse still. Padding costs memory, so apply it where contention actually is.",
      rule: "Give per-thread hot data its own (128-byte) line, keep read-mostly and write-heavy fields apart, and pad only the hot structures.",
      why: (I, sol) => { const r = fsModel(I, sol); return `${LAYOUT[sol.layout]}${sol.scope === "hot" ? " for the hot 1% only" : ""}: ~${r.nsOp.toFixed(1)} ns per increment, ${K.num(r.ops / 1e6)} M/s, ${K.bytes(r.mem)} of counters.`; },
    },
    /* 34 */ {
      id: "perf-data-layout",
      name: "Count the cache lines",
      kind: "Estimate",
      skills: ["estimate", "design"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) return { lv, s: R.pick([32, 48, 64]), N: R.pick([10, 20]) * 1e6 };
        if (lv === 2) return { lv, N: R.pick([2, 4, 8]) * 1e6, miss: R.pick([80, 100]), bw: R.pick([10, 15]) };
        return { lv, N: R.pick([4, 5, 8]) * 1e6, stride: R.pick([256, 320, 512]), bw: R.pick([10, 12, 16]) };
      },
      text: (I) => I.lv === 1 ? `<p>A particle simulation stores ${K.num(I.N / 1e6)} M particles as an array of structs, <b>${I.s} bytes</b> each. The hot loop reads only one 4-byte <code>float</code> field per particle. You propose a struct-of-arrays layout so that field lives in its own contiguous array. <b>By what factor does the memory traffic of the loop shrink?</b></p>`
        : I.lv === 2 ? `<p>A service walks a linked list of <b>${K.num(I.N / 1e6)} M</b> nodes allocated over months, so they're scattered across a 30 GB heap and every node is a cache miss costing ~<b>${I.miss} ns</b> (DRAM latency; the prefetcher can't guess the next address). The same data as a packed array of 8-byte values would stream at ~${I.bw} GB/s. <b>How long does one walk of the list take, in ms?</b></p>`
          : `<p>A filter scans <b>${K.num(I.N / 1e6)} M</b> order records stored as an array of <b>${I.stride}-byte</b> structs and reads only the 1-byte <code>status</code> field of each. Memory bandwidth is ~<b>${I.bw} GB/s</b> and the hardware prefetcher handles the constant stride. Cache lines are 64 bytes. <b>How long does one scan take, in ms?</b></p>`,
      ui: (I) => ({ unit: I.lv === 1 ? "× less traffic" : "ms" }),
      accept: (I, a) => LB.near(layoutTruth, I.lv === 1 ? 0.05 : 0.15)(I, a),
      solve: (I) => Math.round(layoutTruth(I) * 10) / 10,
      bad: (I) => I.lv === 1 ? [64 / 4 === I.s / 4 ? 1 : 16] : I.lv === 2 ? [Math.round(((I.N * 16) / (I.bw * 1e9)) * 1000 * 10) / 10] : [Math.round(((I.N * I.stride) / (I.bw * 1e9)) * 1000)],
      hint: (I) => I.lv === 1 ? "Consecutive structs share lines, so the loop pulls in the whole array: bytes per element ≈ struct size, versus 4 with SoA." : I.lv === 2 ? "Each node costs a full memory round trip, and the next address isn't known until it arrives." : "When the stride exceeds a cache line, each record costs one 64-byte line, not the whole struct.",
      concept: "Memory layout and cache lines",
      how: "CPUs fetch memory in 64-byte cache lines, and DRAM latency (~80–100 ns) is hundreds of cycles, so performance of data-heavy loops is set by how many lines you touch and whether the hardware can prefetch them. Reading one field from an array of structs drags every other field through the cache; a struct of arrays (or hot/cold splitting) packs the field you need densely. Sequential and constant-stride access is prefetched and runs at memory bandwidth; pointer chasing (linked lists, trees of small nodes) pays full latency per node because the next address depends on the current load. With a stride above 64 bytes, each element costs one line rather than its whole struct, which still wastes most of each line.",
      rule: "Count cache lines, not bytes: lay hot fields out contiguously, prefer arrays to pointer-linked structures, and split hot from cold data.",
      why: (I) => I.lv === 1 ? `AoS moves ~${I.s} bytes per particle (the whole array streams through the cache); SoA moves 4, a ${K.num(I.s / 4)}× reduction.` : I.lv === 2 ? `${K.num(I.N / 1e6)} M misses × ${I.miss} ns ≈ ${K.num(layoutTruth(I))} ms, versus ~${K.num(((I.N * 8) / (I.bw * 1e9)) * 1000, 1)} ms to stream the same values from an array.` : `${K.num(I.N / 1e6)} M records × 64 B = ${K.num((I.N * 64) / 1e6)} MB at ${I.bw} GB/s ≈ ${K.num(layoutTruth(I), 1)} ms. A 1-byte status array would need just ${K.num(((I.N) / (I.bw * 1e9)) * 1000, 2)} ms.`,
    },
    /* 35 */ {
      id: "perf-benchmark-mistakes",
      name: "Benchmarks that lie",
      kind: "Code review",
      skills: ["diagnose"],
      w: "lines",
      gen(lv, R) { return { lv, ns: R.int(80, 400) }; },
      text: (I) => `<p>${I.lv === 1 ? "A PR claims a 3× faster order sort, backed by this new Go benchmark." : I.lv === 2 ? `A JMH benchmark says Base64-encoding 512 bytes takes ${I.ns} ns, then a later run says 0.3 ns.` : "The team will pick a cache for the checkout path from this JMH benchmark. The SLO is on p99."}</p><p><b>Flag the ${I.lv === 1 ? "line that makes" : "two lines that make"} the result misleading.</b></p>`,
      ui: (I) => { const d = BENCH[I.lv - 1]; return { file: d.file, lines: diffLines(d.lines), k: I.lv === 1 ? 1 : 2 }; },
      ans: (I) => flagged(BENCH[I.lv - 1].lines),
      diag: (I, a) => { const L = BENCH[I.lv - 1].lines, w = a.filter((i) => !L[i][2]); if (!w.length) return "One found; there's another."; const t = L[w[0]][1]; return /Clone|sink/.test(t) ? "Cloning keeps every iteration sorting unsorted data, and the sink keeps the result alive; both are good practice." : /Fork\(|Scope\.Thread|State|Warmup\(iterations = 5|OutputTimeUnit|Param|Setup/.test(t) ? `<code>${esc(t.trim())}</code> is a sound setting.` : `<code>${esc(t.trim().slice(0, 60))}</code> isn't the problem.`; },
      hint: (I) => I.lv === 1 ? "What runs before the loop, and is it inside the timed region?" : I.lv === 2 ? "What does the JIT do with a result nobody uses? And what state is the JIT in on the first iteration?" : "What does AverageTime say about p99? And how realistic is asking for the same key every time?",
      concept: "Benchmarking pitfalls",
      how: "Micro-benchmarks measure what you wrote, not what you meant. Setup inside the timed region inflates results (Go: call b.ResetTimer after setup, or use b.Loop in Go 1.24+). Without warmup, JMH measures the interpreter and early compilation tiers. A result that isn't returned or passed to a Blackhole can be removed entirely by the JIT (dead-code elimination), producing impossibly fast numbers. Averages hide tails: use SampleTime or a histogram when the SLO is a percentile. And a single hot key keeps everything in L1 cache and the branch predictor trained, which production traffic never does.",
      rule: "Warm up, keep setup out of the timed region, consume every result, measure the statistic your SLO uses, and drive realistic, varied inputs.",
      why: (I) => ["loadFixture runs inside the timed function without b.ResetTimer, so ~120 ms of decoding is charged to the first runs, skewing ns/op whenever b.N is small.", "@Warmup(iterations = 0) measures the interpreter and C1, and the discarded encodeToString result lets C2 delete the work: hence 0.3 ns. Return the String (or pass it to a Blackhole) and warm up.", "AverageTime can't tell you p99 (use Mode.SampleTime), and always reading \"cart:42\" measures one L1-resident entry with a perfectly trained branch predictor; draw keys from a realistic distribution."][I.lv - 1],
    },
    /* 36 */ {
      id: "perf-context-switching",
      name: "Busy doing nothing",
      kind: "Incident",
      skills: ["diagnose", "tune"],
      gen(lv, R) { return { lv, pid: R.int(2000, 60000), threads: R.pick([1200, 2000, 3000]), proc: lv === 1 ? R.pick(["ledgerd", "quoted"]) : lv === 2 ? R.pick(["ingestd", "tracerd"]) : R.pick(["router", "edge-proxy"]) }; },
      text: (I) => `<p>${esc(I.proc)}'s throughput dropped and p99 rose. CPU looks busy${I.lv === 3 ? " on the container dashboard (it's at its limit)" : ""}, but it isn't doing more work. ${I.lv === 1 ? "Someone raised the worker pool \"to handle more load\" last week." : I.lv === 2 ? "The system CPU share is unusually high." : "The Go service runs with a CPU limit of 2 on 64-core nodes."} Find the cause${I.lv !== 2 ? ", fix it, and verify with <code>loadtest</code>" : ""}.</p>`,
      ...LB.term({
        shell: (I) => csShell(I),
        goal(st, I, a) {
          const want = I.lv - 1;
          if (a.pick !== want) return a.pick === 0 && I.lv === 2 ? "Look at the type of switches: these threads give up the CPU voluntarily. Why?" : a.pick === 1 && I.lv === 1 ? "Most switches are involuntary (nvcswch/s): the scheduler preempts runnable threads." : "That doesn't match the evidence.";
          if (I.lv === 2 && !st.seen.off) return "Right idea, but confirm where the threads block (off-CPU stacks).";
          if (I.lv === 1) { if (!(st.threads >= 8 && st.threads <= 64)) return `The pool still has ${st.threads} threads for 8 cores.`; if (!st.tested) return "Fixed? Verify with loadtest."; }
          if (I.lv === 3) { if (!st.fixed) return "GOMAXPROCS still defaults to the 64 host CPUs, and go1.23 doesn't read the cgroup quota (Go 1.25 does)."; if (!st.tested) return "Verify with loadtest."; }
          return true;
        },
        solve: (I) => ({ log: I.lv === 1 ? ["vmstat 1 3", `pidstat -w -p ${I.pid} 1 1`, "app config set worker_threads 16", "loadtest"] : I.lv === 2 ? ["vmstat 1 3", `pidstat -w -p ${I.pid} 1 1`, `offcputime-bpfcc -p ${I.pid} 5`] : ["cat /sys/fs/cgroup/cpu.max", "cat /sys/fs/cgroup/cpu.stat", "go version /app/server", `kubectl set env deploy/${I.proc} GOMAXPROCS=2`, "loadtest"], pick: I.lv - 1 }),
      }),
      bad: (I) => [{ log: ["vmstat 1 3", "app config set worker_threads 4000", "loadtest"], pick: 0 }, { log: ["vmstat 1 3", `offcputime-bpfcc -p ${I.pid} 5`, "kubectl set env deploy/x GOMAXPROCS=64", "loadtest"], pick: (I.lv) % 3 }],
      hint: (I) => I.lv === 1 ? "Compare the run queue with the core count, and voluntary with involuntary switches." : I.lv === 2 ? "Voluntary switches mean threads block. On what?" : "How many threads does the Go scheduler run in parallel, and how much CPU time does the cgroup allow per period?",
      concept: "Context switches: too many threads, contention, throttling",
      how: "A context switch costs microseconds directly and more in lost cache and TLB state. Involuntary switches (nvcswch/s) with a run queue far above the core count mean too many runnable threads time-slicing: shrink the pool toward the core count. Voluntary switches (cswch/s) mean threads block and wake: with high system time, usually a contended lock (futex) or tiny blocking I/O, which off-CPU stacks reveal. In containers, a runtime that sizes its parallelism to the host's cores (GOMAXPROCS before Go 1.25, older JVMs) burns the CFS quota in a fraction of each period and then is throttled (nr_throttled in cpu.stat), adding up to ~100 ms stalls.",
      rule: "Read vmstat cs/r and pidstat -w before resizing anything; size thread pools and runtime parallelism to the CPUs you're actually allowed to use.",
      why: (I) => [`${I.threads} worker threads on 8 cores gave a run queue of ~380 and ~600k involuntary switches/s: the scheduler spent its time switching. A pool near the core count (or a bit above for I/O) restored throughput.`, `~860k voluntary switches/s with 44% system CPU, and off-CPU stacks ending in pthread_mutex_lock under MetricsRegistry::record: threads were queuing on one mutex. Shard or batch the metrics updates.`, `cpu.max allows 2 CPUs per period, but GOMAXPROCS defaulted to 64 (go1.23), so the process exhausted its quota early in every period and was throttled in 79,310 of 81,240 periods. GOMAXPROCS=2 (or Go 1.25+, or automaxprocs) fixes it.`][I.lv - 1],
    },
    /* 37 */ {
      id: "perf-lock-contention",
      name: "One mutex to rule them all",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "complexity:",
      gen(lv, R) { const w = lv === 3 ? 4 : R.pick([4, 5, 6]), c = 0.4; return { lv, T: 32, w, c, cIO: R.pick([4, 6]), hot: lv === 3 ? R.pick([0.5, 0.6]) : 0, target: lv === 1 ? 2e6 : Math.round((0.8 * 32 * 1e6) / (w + c) / 1e5) * 1e5 }; },
      text: (I) => `<p>32 request threads on 32 cores each update an in-memory <code>Map&lt;String, Stats&gt;</code> guarded by one mutex. Outside the lock a request does ~${I.w} µs of work; inside, the update takes ~${I.c} µs${I.lv === 1 ? `, but someone added a log line in the critical section that takes ~${I.cIO} µs` : ""}. ${I.lv === 3 ? `Traffic is skewed: <b>${Math.round(I.hot * 100)}%</b> of updates go to a single key (the top customer).` : "Keys are spread evenly."}</p><p>Reach <b>${K.num(I.target / 1e6, 1)} M updates/s</b> with the simplest design (complexity: mutex 0 &lt; 16 stripes &lt; 256 stripes &lt; per-thread shards).</p>`,
      ui: (I) => {
        const knobs = [{ k: "lock", label: "Locking", opts: ["mutex", "s16", "s256", "shard"], fmt: (v) => LOCKD[v], select: true }];
        if (I.lv === 1) knobs.unshift({ k: "sect", label: "Critical section", opts: ["io", "upd"], fmt: (v) => (v === "io" ? "update + log line" : "update only; log after unlock") });
        return { knobs, init: I.lv === 1 ? { sect: "io", lock: "mutex" } : { lock: "mutex" }, live: (cfg) => { const r = lcModel(I, { sect: "upd", ...cfg }); return K.metrics([{ name: "Throughput", value: K.num(r.ops / 1e6, 2) + " M/s", ok: r.ops >= I.target, target: `≥ ${K.num(I.target / 1e6, 1)} M/s` }, { name: "Hottest lock busy", value: K.pct(r.util, 0), ok: r.util < 0.85 }]) + K.verdict(r.ops >= I.target, r.ops >= I.target ? "fast enough" : "the lock is the bottleneck"); } };
      },
      valid: (I, cfg) => { const r = lcModel(I, { sect: "upd", ...cfg }); return r.ops >= I.target ? true : `${K.num(r.ops / 1e6, 2)} M updates/s (need ${K.num(I.target / 1e6, 1)} M)`; },
      val: (I, cfg) => lcModel(I, { sect: "upd", ...cfg }).cost,
      hint: (I) => I.lv === 1 ? "A lock can serve at most 1 / (critical section) operations per second. What's in yours?" : I.lv === 2 ? "Striping divides the load across locks; how many stripes until one lock isn't the limit?" : "Striping can't split one key: the stripe that holds it still serialises its share.",
      concept: "Reducing lock contention",
      how: "A lock admits one holder at a time, so throughput through it can't exceed 1 / (time held), whatever the thread count, and as utilisation approaches 100% the queue of waiting threads grows (with context switches on top). First shrink the critical section: never do I/O or logging inside it. Then split the lock: striping by key hash divides load across N locks. Skew defeats striping, because every update to the hot key lands on the same stripe; per-thread (or per-core) shards with merge-on-read, like Java's LongAdder, remove sharing for the hot path at the cost of memory and slower reads.",
      rule: "Measure lock hold time and wait time, move work out of critical sections first, stripe for uniform keys, and shard per thread for hot keys.",
      why: (I, sol) => { const r = lcModel(I, { sect: "upd", ...sol }); return `${sol.sect ? (sol.sect === "upd" ? "Logging after unlock, " : "") : ""}${LOCKD[sol.lock]}: ${K.num(r.ops / 1e6, 2)} M updates/s, hottest lock ${K.pct(r.util, 0)} busy.${I.lv === 3 ? ` With ${Math.round(I.hot * 100)}% of updates on one key, any striping leaves that key's stripe saturated.` : ""}`; },
    },
    /* 38 */ {
      id: "perf-percentiles",
      name: "Percentiles don't average",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) { const tot = 100000, c = [R.int(30, 40), R.int(25, 30), R.int(15, 20), R.int(5, 9), R.int(2, 3)]; const used = c.reduce((s, x) => s + x * 1000, 0); const tail = tot - used; const counts = [...c.map((x) => x * 1000), Math.round(tail * 0.6), Math.round(tail * 0.3), tail - Math.round(tail * 0.6) - Math.round(tail * 0.3)]; return { lv, counts }; }
        if (lv === 2) { const mk = (n, slow) => { const f = slow ? [0.05, 0.15, 0.25, 0.2, 0.15, 0.1, 0.07, 0.03] : [0.3, 0.35, 0.2, 0.1, 0.035, 0.012, 0.002, 0.001]; return { n, counts: f.map((x) => Math.round(x * n)) }; }; const hosts = [mk(R.pick([90, 100]) * 1000, 0), mk(R.pick([90, 100]) * 1000, 0), mk(R.pick([90, 100]) * 1000, 0), mk(R.pick([3, 4]) * 1000, 1)]; return { lv, hosts }; }
        const thrI = 4, hosts = [0, 1, 2].map((h) => { const inf = R.int(40, 90) * 1000, le = [0.4, 0.75, 0.9, 0.96, 0.985 - (h === 2 ? 0.05 : 0), 0.994, 0.998, 1].map((f) => Math.round(f * inf)); return { inf, le }; });
        return { lv, hosts, thrI };
      },
      text: (I) => I.lv === 1 ? `<p>One host's request latency histogram for the last hour (count per bucket):</p>${K.table(BK.map((b, i) => `${i ? BK[i - 1] : 0}–${b} ms`), [I.counts.map((x) => K.num(x))], { compact: true })}<p><b>In which bucket is the p99?</b> Answer with the bucket's upper bound in ms.</p>`
        : I.lv === 2 ? `<p>Four hosts serve one endpoint. Hosts 1–3 are healthy; host 4 is a canary with a bad build and little traffic. Per-host histograms (counts per bucket):</p>${K.table(["host", ...BK.map((b, i) => `≤${b}`)], I.hosts.map((h, k) => [`${k + 1}`, ...h.counts.map((x) => K.num(x))]), { compact: true })}<p>The dashboard averages the per-host p99s. <b>What's the true p99 of the endpoint?</b> Answer with the bucket upper bound in ms.</p>`
          : `<p>Prometheus <code>http_request_duration_seconds_bucket</code> counters for the last 30 days (cumulative, as Prometheus stores them):</p>${K.table(["host", ...BK.map((b) => `le="${b / 1000}"`)], I.hosts.map((h, k) => [`${k + 1}`, ...h.le.map((x) => K.num(x))]), { compact: true })}<p>The SLO is "requests faster than 250 ms". <b>What percentage of all requests were slower than 250 ms?</b></p>`,
      ui: (I) => ({ unit: I.lv === 3 ? "%" : "ms" }),
      accept: (I, a) => { if (a == null || !fin(a)) return "Enter a number."; if (I.lv === 3) return LB.near(pctTruth, 0.08)(I, a); const b = pctTruth(I); return a === BK[b] ? true : a > BK[b] ? "Too high. Count from the bottom to 99% of all requests." : "Too low. 99% of requests must be at or below it."; },
      solve: (I) => (I.lv === 3 ? Math.round(pctTruth(I) * 100) / 100 : BK[pctTruth(I)]),
      bad: (I) => { if (I.lv === 1) return [BK[Math.max(0, pctTruth(I) - 1)]]; if (I.lv === 2) { const p = I.hosts.map((h) => { const t = h.counts.reduce((s, x) => s + x, 0); let acc = 0; for (let b = 0; b < BK.length; b++) { acc += h.counts[b]; if (acc >= t * 0.99) return BK[b]; } return BK[BK.length - 1]; }); const avg = p.reduce((s, x) => s + x, 0) / 4; return BK.filter((b) => b !== BK[pctTruth(I)] && Math.abs(b - avg) === Math.min(...BK.map((x) => Math.abs(x - avg)))); } const tot = I.hosts.reduce((s, h) => s + h.inf, 0); return [Math.round((I.hosts.reduce((s, h) => s + h.le[I.thrI], 0) / tot) * 10000) / 100]; },
      hint: (I) => I.lv === 1 ? "Accumulate counts from the fastest bucket until you pass 99% of the total." : I.lv === 2 ? "Merge the histograms (add the counts), then find the p99 of the merged one. Averages of percentiles weight a tiny canary like a full host." : "Cumulative buckets: requests slower than 250 ms = +Inf count − le=\"0.25\" count. Sum across hosts before dividing.",
      concept: "Aggregating percentiles correctly",
      how: "A percentile is a property of a whole distribution, so it can't be averaged: the mean of per-host p99s weights a host with 3% of the traffic the same as one with 30%, and is not the p99 of anything. Merge the underlying histograms (add bucket counts) and compute the percentile from the merged counts; that's why Prometheus histograms are aggregated with sum by (le) before histogram_quantile, and why summaries (pre-computed quantiles) can't be aggregated at all. Prometheus buckets are cumulative (le = less than or equal), so a bucket's own count is the difference between neighbours, and the share above a threshold is (+Inf − le) / +Inf.",
      rule: "Never average percentiles; sum histogram buckets across instances, then compute the quantile or the share over the threshold.",
      why: (I) => I.lv === 3 ? `Slower than 250 ms = Σ(+Inf − le="0.25") / Σ(+Inf) ≈ ${K.num(pctTruth(I), 2)}%. Reading the cumulative le="0.25" count as "requests in that bucket" gives nonsense.` : I.lv === 1 ? `Counting up from the fastest bucket, 99% of ${K.num(I.counts.reduce((s, x) => s + x, 0))} requests is reached in the bucket ending at ${BK[pctTruth(I)]} ms.` : `Merged, the endpoint's p99 is in the ≤${BK[pctTruth(I)]} ms bucket. The canary's terrible p99 dominates an average of four p99s, though it served a tiny share of requests.`,
    },
    /* 39 */ {
      id: "perf-bounded-fanout",
      name: "Promise.all on 20,000 items",
      kind: "Config change",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "concurrency:",
      gen(lv, R) { return { lv, items: R.pick([20000, 30000]), lat: R.pick([80, 100]), limit: lv === 3 ? R.pick([150, 200]) : R.pick([400, 500]), grow: lv === 1 ? 0 : lv === 2 ? 100 : 400, deadline: 0 }; },
      text: (I) => { const d = effI(I).deadline; return `<p>A nightly job enriches <b>${K.num(I.items)}</b> records by calling a partner API, ~${I.lat} ms per call${I.grow ? " when lightly loaded (the API slows down as your concurrency rises)" : ""}. It does <code>await Promise.all(records.map(enrich))</code> and gets a flood of <b>429 Too Many Requests</b>: the API allows <b>${I.limit} requests/s</b>${I.lv === 3 ? " for your whole account, and two other jobs already use 40% of it" : ""}.</p><p>Bound the concurrency (e.g. with <code>p-limit</code>) so that under 1% of calls get 429 and the job finishes within <b>${d} s</b>, using the lowest concurrency that does.</p>`; },
      ui: (I) => ({ knobs: [{ k: "c", label: "Max concurrent calls", opts: [5, 10, 20, 30, 40, 50, 80, 160, "∞"] }], init: { c: "∞" }, live: (cfg) => { const r = fanModel(effI(I), cfg || { c: "∞" }), c = fanCheck(effI(I), r); return K.metrics([{ name: "Offered", value: K.num(r.offered) + "/s", ok: r.offered <= effI(I).limit, target: `limit ${effI(I).limit}/s` }, { name: "Call latency", value: K.ms(r.lat), ok: null }, { name: "429 rate", value: K.pct(r.rej), ok: r.rej <= 0.01 }, { name: "Job time", value: K.num(r.time) + " s", ok: r.time <= effI(I).deadline, target: `≤ ${effI(I).deadline} s` }]) + K.verdict(c === true, c === true ? "fits" : c); } }),
      valid: (I, cfg) => fanCheck(effI(I), fanModel(effI(I), cfg)),
      val: (I, cfg) => (cfg.c === "∞" ? 1e9 : cfg.c),
      hint: (I) => I.lv === 1 ? "Little's law: in-flight = rate × latency. What concurrency makes the rate equal the limit?" : I.lv === 2 ? "Latency rises with concurrency, so the same rate needs more in flight than the unloaded math says." : "Your share is only 60% of the account limit.",
      concept: "Bounding concurrency with Little's law",
      how: "Unbounded fan-out (Promise.all over thousands of items, a goroutine per item) offers load as fast as the client can create requests, so a rate-limited or capacity-limited API rejects most of it, and naive retries make it worse. With a concurrency limit c and per-call latency L, throughput is c / L (Little's law), so the right limit is about rate limit × latency. If the server slows down under load, latency grows with c, so you need a bit more concurrency for the same throughput, and pushing past the limit only adds queueing. Shared quotas must be divided between the clients that use them.",
      rule: "Never fan out unbounded; set concurrency ≈ allowed rate × latency, honour Retry-After with jittered backoff, and budget shared quotas explicitly.",
      why: (I, sol) => { const J = effI(I), r = fanModel(J, sol); return `Concurrency ${sol.c} offers ${K.num(r.offered)} calls/s (latency ${K.ms(r.lat)}) against ${J.limit}/s, finishing in ~${K.num(r.time)} s. Unbounded, the job offered ${K.num(fanModel(J, { c: "∞" }).offered)} calls/s.`; },
    },
    /* 40 */ {
      id: "perf-profile-in-prod",
      name: "Profile production safely",
      kind: "Change plan",
      skills: ["diagnose", "safe"],
      w: "steps",
      gen(lv, R) { return { lv, order: R.perm(7).map((x) => x - 1) }; },
      text: (I) => `<p>${["A Go API got 30% slower after a deploy. It exposes net/http/pprof on localhost:6060.", "A Node.js service burns CPU in production. A previous attempt with perf showed mostly [unknown] frames for JavaScript.", "A JVM service in Kubernetes is CPU-hot. The cluster runs with the default kernel.perf_event_paranoid = 2 and pods don't have CAP_PERFMON or CAP_SYS_ADMIN."][I.lv - 1]} Plan how to get a trustworthy CPU profile <b>without hurting production</b>. Pick the steps you'd take, in order; leave out anything risky or misleading.</p>`,
      ui: (I) => ({ opts: I.order.map((k) => PROF[I.lv - 1].opts[k]) }),
      accept(I, seq) {
        const P = PROF[I.lv - 1], orig = seq.map((i) => I.order[i]);
        const trap = orig.find((k) => !P.req.includes(k));
        if (trap != null) return `“${esc(P.opts[trap])}” ${[4, 5, 6].includes(trap) ? ["changes what you're measuring or adds heavy overhead", "throws away the state you're trying to observe", "adds heavy overhead across the whole fleet"][trap - 4] : "doesn't belong"}.`;
        const miss = P.req.find((k) => !orig.includes(k));
        if (miss != null) return `Missing: “${esc(P.opts[miss])}”.`;
        for (const [a, b] of P.before) if (orig.indexOf(a) > orig.indexOf(b)) return `“${esc(P.opts[b])}” can't come before “${esc(P.opts[a])}”.`;
        return true;
      },
      solve: (I) => PROF[I.lv - 1].req.map((k) => I.order.indexOf(k)),
      bad: (I) => [[4, 0, 1, 2, 3].map((k) => I.order.indexOf(k)), [1, 0, 2, 3].map((k) => I.order.indexOf(k)), [0, 1, 2].map((k) => I.order.indexOf(k))],
      hint: (I) => I.lv === 1 ? "A profile alone tells you what's hot, not what changed." : I.lv === 2 ? "perf can only name JIT-compiled frames if the runtime writes a symbol map." : "Without perf_events, you need a sampling mode that uses timers instead.",
      concept: "Low-overhead production profiling",
      how: "Sampling profilers interrupt threads at a fixed rate and record stacks, so their overhead is small and bounded (sample at an odd rate like 99 Hz to avoid lockstep with periodic work). Profile one instance that shows the problem, compare against a baseline, and don't change what you're measuring: unoptimised builds, restarts or instrumenting every method distort it. JIT runtimes need help for native profilers to name frames (Node's --perf-basic-prof writes /tmp/perf-PID.map; the JVM needs async-profiler or a perf map agent). In locked-down containers where perf_events is unavailable, async-profiler's itimer mode samples with timers instead, and -XX:+DebugNonSafepoints improves attribution of inlined code.",
      rule: "Sample, don't instrument: one canary, a bounded duration, a baseline to compare, and the runtime's symbol support turned on.",
      why: (I) => ["Two pprof captures (regressed vs healthy) on one pod show what changed; pprof's built-in endpoints sample at 100 Hz with low overhead.", "With --perf-basic-prof on one canary, perf can resolve JIT frames; 99 Hz for 30 s on one process costs little and avoids lockstep with timers.", "itimer sampling works without perf_events or extra privileges, so you don't need a privileged pod; copy the HTML out and read it, and turn on DebugNonSafepoints for the next capture."][I.lv - 1],
    },
  ]);
  function effI(I) { const limit = I.lv === 3 ? Math.round(I.limit * 0.6) : I.limit; return { ...I, limit, deadline: I.deadline || Math.ceil(((I.items / limit) * 1.25) / 10) * 10 }; }
})();
