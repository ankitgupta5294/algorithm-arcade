/* Systems Lab · System design. Back-of-envelope estimates and architecture choices, validated against a small
   launch-day simulator: tiers of replicas with capacity, latency, cost and availability; a diurnal traffic profile
   with launch spikes; caches with hit ratios; queues. Shared helpers are published on LB.sdKit so c-sd-2.js can use
   them: either file may load first, and helpers are only read inside functions, after every script has loaded. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const SD = (LB.sdKit = LB.sdKit || {});

  /* ---------- formatting ---------- */
  const M = (x, d = 1) => (x >= 1e12 ? K.num(x / 1e12, d) + "T" : x >= 1e9 ? K.num(x / 1e9, d) + "B" : x >= 1e6 ? K.num(x / 1e6, d) + "M" : x >= 1e4 ? K.num(x / 1e3, d) + "k" : K.num(x, x < 10 ? 2 : 0));
  const nines = (a) => (a >= 0.9999999 ? "≈100%" : (a * 100).toFixed(5).replace(/0+$/, "").replace(/\.$/, "") + "%");
  const down = (a) => { const m = (1 - a) * 30 * 24 * 60; return m < 1 ? Math.round(m * 60) + " s/month" : m < 120 ? K.num(m, m < 10 ? 1 : 0) + " min/month" : K.num(m / 60, 1) + " h/month"; };
  const mo = (x) => K.usd(x) + "/mo";
  const pc = (f) => K.pct(f, f < 0.01 ? 2 : f < 0.1 ? 1 : 0);
  const hm = (x) => `${Math.floor(x)}:${x % 1 ? "30" : "00"}`;

  /* ---------- availability ---------- */
  const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  // P(at least k of n independent replicas are up), each up with probability a.
  const kofn = (n, k, a) => { if (k <= 0) return 1; let s = 0; for (let i = k; i <= n; i++) s += binom(n, i) * a ** i * (1 - a) ** (n - i); return s; };

  /* ---------- the launch-day simulator ----------
     tier(): one tier of identical replicas behind a load balancer. lam = req/s offered, cap = req/s one replica serves
     at 100% busy, base = p99 at low load (ms), slots = requests one replica works on at once. Queueing per replica is
     M/M/c (Sakasegawa's approximation for the mean queue), p99 wait ≈ 4.6 × mean. Past ~98% busy the queue grows
     without bound: requests time out and the excess turns into errors. */
  const tier = (lam, n, cap, base, o = {}) => {
    const slots = o.slots || 8, tmo = o.timeout || 2000;
    if (lam <= 0) return { rho: 0, p99: base, err: 0 };
    if (!n || !cap) return { rho: Infinity, p99: tmo, err: 1 };
    const rho = lam / (n * cap);
    if (rho >= 0.98) return { rho, p99: tmo, err: Math.max(0.02, 1 - 0.98 / rho) };
    const lq = rho ** Math.sqrt(2 * (slots + 1)) / (1 - rho), wq = lq / (lam / n);
    return { rho, p99: Math.min(tmo, base + 4.6 * wq * 1000), err: 0 };
  };
  // Requests that pass through several tiers in series: latencies add (conservative for p99), errors compound.
  const chain = (parts) => ({ p99: parts.reduce((s, r) => s + r.p99, 0), err: 1 - parts.reduce((p, r) => p * (1 - r.err), 1), rho: Math.max(0, ...parts.map((r) => r.rho)) });
  // Launch day: 48 half-hour points; organic peak (1.0) in the evening, a lunch bump, a quiet night.
  const DAY = (() => { const raw = U.range(48).map((i) => { const h = i / 2; return 0.14 + 0.5 * Math.exp(-(((h - 13) / 2.4) ** 2)) + 0.86 * Math.exp(-(((h - 20.5) / 2.2) ** 2)); }); const m = Math.max(...raw); return raw.map((x) => x / m); })();
  // Offered load across the day for an organic peak `peak`; o.spike = hour of a launch spike that reaches o.x × peak.
  const day = (peak, o = {}) => DAY.map((f, i) => { let v = peak * f; if (o.spike != null) { const d = i / 2 - o.spike; v = Math.max(v, peak * (o.x || 1) * Math.exp(-((d / 0.5) ** 2))); } return v; });
  // Run a load profile through f(load, index) -> {p99, err, rho}; summarise the day.
  const runDay = (loads, f) => {
    let worst = 0, errN = 0, tot = 0, maxRho = 0, peakErr = 0;
    const p99 = [], err = [];
    loads.forEach((l, i) => { const r = f(l, i); p99.push(r.p99); err.push(r.err); worst = Math.max(worst, r.p99); errN += l * r.err; tot += l; maxRho = Math.max(maxRho, r.rho || 0); peakErr = Math.max(peakErr, r.err); });
    return { p99, err, worst, errRate: tot ? errN / tot : 0, peakErr, maxRho };
  };
  const dayChart = (r, slo, title) => K.chart([{ name: "p99 (ms)", pts: r.p99.map((v, i) => [i / 2, v]), cls: r.worst > slo ? "bad" : "s0" }], { h: 120, ymin: 0, ymax: Math.max(slo * 1.5, Math.min(r.worst * 1.1, slo * 4)), hline: { y: slo, label: `SLO ${slo} ms` }, title: title || "Launch day: p99 latency by time of day", xfmt: hm, fmt: (v) => K.num(v) });
  const loadChart = (loads, capLine, title, unit) => K.chart([{ name: "offered load", pts: loads.map((v, i) => [i / 2, v]), cls: Math.max(...loads) > capLine ? "bad" : "s0" }], { h: 110, ymin: 0, hline: { y: capLine, label: "capacity" }, title: title || "Launch day: offered load", xfmt: hm, fmt: (v) => M(v, 0) + (unit || "") });

  Object.assign(SD, { M, nines, down, mo, pc, hm, kofn, tier, chain, day, runDay, dayChart, loadChart });

  const APPS = ["Pinwheel", "Quokka", "Driftwood", "Lumen", "Tidepool", "Bramble", "Marmot", "Juniper", "Kestrel", "Otterly"];
  const need = (x) => Math.ceil(x - 1e-9);
  const exact = (truth, unit) => (I, a) => (a == null || !Number.isFinite(a) ? "Enter a number." : a === truth(I) ? true : `${a < truth(I) ? "Too low" : "Too high"}: ${K.num(a)} ${unit} doesn't meet every constraint${a < truth(I) ? "" : " with the fewest " + unit}. Recheck which constraint binds and how you round.`);

  LB.addAll("sd", [
    /* ======================= estimates ======================= */
    {
      id: "sd-peak-qps",
      name: "Estimate peak QPS from DAU",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        const app = R.pick(APPS), dau = R.pick([2, 3, 5, 8, 12, 20, 30]) * 1e6, pf = R.pick([2, 2.5, 3]);
        if (lv === 1) return { lv, app, dau, pf, opens: R.int(4, 12), calls: R.int(3, 8) };
        if (lv === 2) return { lv, app, dau, pf, opens: R.int(5, 15), reads: R.int(4, 10), writes: R.int(2, 9), hit: R.pick([0.8, 0.9, 0.95]) };
        return { lv, app, base: R.int(15, 60) * 1000, push: R.pick([5, 10, 20, 40]) * 1e6, en: R.pick([0.5, 0.6, 0.7]), open: R.pick([0.03, 0.05, 0.08]), calls: R.int(8, 16), win: R.pick([2, 3]) };
      },
      text: (I) => I.lv === 1 ? `<p>${I.app} expects <b>${M(I.dau)} daily active users</b>. An average user opens the app <b>${I.opens}×/day</b> and each open makes <b>${I.calls} API calls</b>. Traffic is diurnal: the busiest hour runs at <b>${I.pf}×</b> the daily average.</p><p>Estimate the <b>peak API requests per second</b> the backend must serve.</p>`
        : I.lv === 2 ? `<p>${I.app} has <b>${M(I.dau)} DAU</b>. Each user opens the app <b>${I.opens}×/day</b>; each open issues <b>${I.reads} reads</b>. Users also make about <b>${I.writes} writes/day</b> (likes, comments). The busiest hour runs at <b>${I.pf}×</b> the daily average.</p><p>Reads go through a cache with a <b>${pc(I.hit)} hit ratio</b>. Estimate the <b>peak read QPS that reaches the database</b>.</p>`
          : `<p>At the evening peak ${I.app}'s API already serves <b>${K.num(I.base)} req/s</b>. Marketing will send a launch push notification to <b>${M(I.push)} users</b> at that hour.</p><ul><li><b>${pc(I.en)}</b> of them have notifications enabled</li><li><b>${pc(I.open)}</b> of those who receive it open the app within <b>${I.win} minutes</b>, spread evenly</li><li>a cold app open makes <b>${I.calls} API calls</b> (config, session, feed, images metadata...)</li></ul><p>Estimate the <b>peak API requests per second</b> during those ${I.win} minutes.</p>`,
      ui: () => ({ unit: "req/s" }),
      accept: LB.near((I) => sdPeak(I), 0.25),
      solve: (I) => Math.round(sdPeak(I)),
      bad: (I) => I.lv === 1 ? [Math.round(sdPeak(I) / I.pf), Math.round(sdPeak(I) * 24)] : I.lv === 2 ? [Math.round(sdPeak(I) / (1 - I.hit)), Math.round(sdPeak(I) / I.pf)] : [I.base, Math.round(I.base + (I.push * I.en * I.open * I.calls) / 3600)],
      hint: (I) => I.lv === 1 ? "A day has 86,400 seconds. Compute the daily average first, then apply the peak factor." : I.lv === 2 ? "Only reads go to the cache, and only the misses reach the database. Writes are a red herring here." : "The burst is (opens in the window × calls per open) ÷ window length in seconds, on top of the existing peak.",
      concept: "Peak QPS from daily volume",
      how: "Daily volume ÷ 86,400 gives the average rate, but capacity is set by the busiest minutes, not the average. Consumer traffic is diurnal, so the peak hour is typically 2–3× the daily average, and coordinated events (a push notification, a TV ad, a launch) create bursts far above that. A cache in front of the database means only misses reach it, so database load is total reads × (1 − hit ratio). Bursts from push notifications are short and steep: the same opens spread over a day are nothing, squeezed into two minutes they can double the peak.",
      rule: "Always estimate the peak, not the average: average × peak factor, plus any synchronised burst you're about to cause yourself.",
      why: (I) => I.lv === 1 ? `${M(I.dau)} × ${I.opens} × ${I.calls} = ${M(I.dau * I.opens * I.calls)} calls/day ÷ 86,400 = ${K.num(I.dau * I.opens * I.calls / 86400)} req/s average × ${I.pf} = <b>${K.num(sdPeak(I))} req/s</b> at peak.`
        : I.lv === 2 ? `${M(I.dau)} × ${I.opens} × ${I.reads} = ${M(I.dau * I.opens * I.reads)} reads/day → ${K.num(I.dau * I.opens * I.reads / 86400 * I.pf)} reads/s at peak; ${pc(1 - I.hit)} miss the cache → <b>${K.num(sdPeak(I))} req/s</b> on the database.`
          : `${M(I.push)} × ${pc(I.en)} × ${pc(I.open)} = ${K.num(I.push * I.en * I.open)} opens in ${I.win * 60} s × ${I.calls} calls = ${K.num(I.push * I.en * I.open * I.calls / (I.win * 60))} req/s extra, on top of ${K.num(I.base)}: <b>${K.num(sdPeak(I))} req/s</b>. Staggering the push over 20 minutes would cut the burst tenfold.`,
    },
    {
      id: "sd-storage-growth",
      name: "Estimate storage for the next years",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        const app = R.pick(APPS);
        if (lv === 1) return { lv, app, posts: R.pick([5, 10, 20, 50]) * 1e6, bytes: R.pick([400, 600, 800, 1200, 1500]), repl: 3 };
        if (lv === 2) return { lv, app, msgs: R.pick([50, 100, 200, 400]) * 1e6, text: R.pick([120, 160, 240]), meta: R.pick([150, 200, 250]), idx: R.pick([0.3, 0.4, 0.5]), att: R.pick([0.02, 0.03, 0.05]), attKB: R.pick([200, 350, 500]), repl: 3 };
        return { lv, app, up: R.pick([1, 2, 4, 6]) * 1e6, g: R.pick([0.03, 0.05, 0.08]), orig: R.pick([1.5, 2, 3]), thumbs: R.pick([150, 250, 400]), months: 36 };
      },
      text: (I) => I.lv === 1 ? `<p>${I.app} stores <b>${M(I.posts)} posts/day</b>. A post row averages <b>${K.num(I.bytes)} bytes</b> including indexes. The database keeps <b>${I.repl} replicas</b> of everything.</p><p>Estimate the <b>disk needed for one year</b> of posts, across all replicas, in TB (1 TB = 10<sup>12</sup> bytes).</p>`
        : I.lv === 2 ? `<p>${I.app}'s chat service stores <b>${M(I.msgs)} messages/day</b>. Each message has <b>${I.text} bytes</b> of text and a <b>${I.meta}-byte</b> metadata row; indexes add <b>${pc(I.idx)}</b> on top. <b>${pc(I.att)}</b> of messages carry an attachment averaging <b>${I.attKB} KB</b>, uploaded to object storage (the database stores only its key, already counted in metadata). The message database keeps <b>${I.repl} replicas</b>.</p><p>Estimate the <b>message database disk for one year</b>, all replicas, in TB.</p>`
          : `<p>${I.app} receives <b>${M(I.up)} photo uploads/day</b> today, growing <b>${pc(I.g)} month over month</b>. Each upload is stored as the original (<b>${I.orig} MB</b> average) plus resized renditions totalling <b>${I.thumbs} KB</b>. Nothing is deleted. Object storage bills per logical byte (the provider's internal replication is not your problem).</p><p>Estimate the <b>total stored after ${I.months} months</b>, in TB (use 30-day months).</p>`,
      ui: () => ({ unit: "TB" }),
      accept: LB.near((I) => sdStore(I), 0.25),
      solve: (I) => +sdStore(I).toFixed(1),
      bad: (I) => I.lv === 1 ? [+(sdStore(I) / 3).toFixed(1)] : I.lv === 2 ? [+(sdStore(I) + (I.msgs * I.att * I.attKB * 1000 * 365 * 3) / 1e12).toFixed(1), +(sdStore(I) / 3).toFixed(1)] : [+((I.up * 30 * I.months * (I.orig * 1e6 + I.thumbs * 1e3)) / 1e12).toFixed(1), +((I.up * 30 * I.orig * 1e6 * (Math.pow(1 + I.g, I.months) - 1) / I.g) / 1e12 * 3).toFixed(1)],
      hint: (I) => I.lv === 1 ? "posts/day × bytes × 365 × replicas." : I.lv === 2 ? "Attachments live in object storage, not in this database. Text + metadata, plus index overhead, times replicas." : "Uploads grow geometrically: month m has today's volume × (1+g)^m. Sum the series (or add it up month by month).",
      concept: "Storage growth estimates",
      how: "Storage = items/day × bytes per item × days, multiplied by every copy you keep: replicas, indexes, renditions, backups. Separate what lives where: large blobs belong in object storage, while the database holds small rows that point to them, so a chat database is sized by message rows, not attachments. When volume grows, the total is a geometric series: monthly volume × ((1+g)^n − 1) / g, which after three years at 5%/month is about 2.6× what linear growth would give.",
      rule: "List every copy (replicas, indexes, renditions) and every store separately, and model growth explicitly; never multiply today's daily volume by 365 × years for a growing product.",
      why: (I) => I.lv === 1 ? `${M(I.posts)} × ${K.num(I.bytes)} B × 365 × ${I.repl} = <b>${K.num(sdStore(I), 1)} TB</b>.`
        : I.lv === 2 ? `${M(I.msgs)} × (${I.text} + ${I.meta}) B × ${1 + I.idx} (indexes) × 365 × 3 = <b>${K.num(sdStore(I), 1)} TB</b>. The ${pc(I.att)} of messages with attachments add ${K.num((I.msgs * I.att * I.attKB * 1e3 * 365) / 1e12, 0)} TB/year to object storage, not to this database.`
          : `Month 1 stores ${K.num(I.up * 30 * (I.orig * 1e6 + I.thumbs * 1e3) / 1e12, 1)} TB; the series Σ (1+${I.g})^m over ${I.months} months is ${K.num((Math.pow(1 + I.g, I.months) - 1) / I.g, 1)} months' worth, so <b>${K.num(sdStore(I), 0)} TB</b>. Linear extrapolation would have said ${K.num(I.up * 30 * I.months * (I.orig * 1e6 + I.thumbs * 1e3) / 1e12, 0)} TB.`,
    },
    {
      id: "sd-egress",
      name: "Estimate egress bandwidth",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        const app = R.pick(APPS);
        if (lv === 1) return { lv, app, loads: R.pick([2, 4, 6, 10, 15]) * 1000, imgs: R.int(8, 20), kb: R.pick([60, 80, 120, 150, 200]) };
        if (lv === 2) return { lv, app, loads: R.pick([10, 20, 30, 40]) * 1000, imgs: R.int(10, 24), kb: R.pick([80, 100, 150]), hit: R.pick([0.9, 0.95, 0.97, 0.98]) };
        const mix = R.pick([[0.35, 0.45, 0.2], [0.5, 0.35, 0.15], [0.25, 0.5, 0.25]]);
        return { lv, app, hours: R.pick([2, 5, 10, 20]) * 1e6, mix, rates: [R.pick([5, 6]), 3, 1.5], off: R.pick([0.95, 0.97, 0.98]) };
      },
      text: (I) => I.lv === 1 ? `<p>At peak, ${I.app} serves <b>${K.num(I.loads)} feed loads/s</b>. Each load displays <b>${I.imgs} images</b> averaging <b>${I.kb} KB</b> (1 KB = 1,000 bytes).</p><p>Estimate the <b>peak image egress</b> in <b>Gbps</b>.</p>`
        : I.lv === 2 ? `<p>${I.app} peaks at <b>${K.num(I.loads)} feed loads/s</b>, each showing <b>${I.imgs} images</b> of <b>${I.kb} KB</b>. Images are served through a CDN with a <b>${pc(I.hit)} byte hit ratio</b>; misses are fetched from the origin (your object storage).</p><p>Estimate the <b>peak origin egress</b> in <b>Gbps</b>.</p>`
          : `<p>${I.app}'s video-on-demand service streams <b>${M(I.hours)} hours of video per day</b>. Viewers' players settle on these renditions:</p>${K.table(["Rendition", "Bitrate", "Share of watch time"], [["1080p", I.rates[0] + " Mbps", pc(I.mix[0])], ["720p", I.rates[1] + " Mbps", pc(I.mix[1])], ["480p", I.rates[2] + " Mbps", pc(I.mix[2])]], { compact: true })}<p>The CDN serves <b>${pc(I.off)}</b> of bytes from cache. Estimate the <b>origin egress per 30-day month</b> in <b>TB</b> (decimal units).</p>`,
      ui: (I) => ({ unit: I.lv === 3 ? "TB/month" : "Gbps" }),
      accept: LB.near((I) => sdEgress(I), 0.25),
      solve: (I) => +sdEgress(I).toFixed(2),
      bad: (I) => I.lv === 1 ? [+(sdEgress(I) / 8).toFixed(2)] : I.lv === 2 ? [+(sdEgress(I) / (1 - I.hit) * I.hit).toFixed(2), +(sdEgress(I) / 8).toFixed(2)] : [+(sdEgress(I) / (1 - I.off)).toFixed(0), +(sdEgress(I) * 8).toFixed(0)],
      hint: (I) => I.lv === 1 ? "Bytes per second × 8 = bits per second. 1 Gbps = 10⁹ bits/s." : I.lv === 2 ? "The origin only serves what the CDN misses: total × (1 − hit ratio)." : "Average bitrate = Σ share × bitrate. Bytes = hours × 3600 × bits/s ÷ 8. Then only the CDN misses come from origin.",
      concept: "Bandwidth: bits, bytes and offload",
      how: "Network links and egress are quoted in bits per second, object sizes in bytes, so multiply bytes/s by 8. Egress = request rate × payload size; for streaming it's concurrent viewers × bitrate, or watch-hours × 3600 × average bitrate for monthly volume. A CDN with byte hit ratio h serves h of the bytes from its edge; your origin (and its egress bill) sees only (1 − h). Going from 95% to 98% hit ratio cuts origin egress by 60%, which is why CDN tuning pays off disproportionately.",
      rule: "Write units on every line (B vs b, per second vs per month), and size the origin for the miss traffic, not the total.",
      why: (I) => I.lv === 1 ? `${K.num(I.loads)} × ${I.imgs} × ${I.kb} KB = ${K.num(I.loads * I.imgs * I.kb / 1e6, 1)} GB/s × 8 = <b>${K.num(sdEgress(I), 1)} Gbps</b>.`
        : I.lv === 2 ? `Total ${K.num(I.loads * I.imgs * I.kb * 8 / 1e6, 1)} Gbps at the edge; ${pc(1 - I.hit)} misses → <b>${K.num(sdEgress(I), 2)} Gbps</b> from origin.`
          : `Average bitrate ${K.num(I.mix[0] * I.rates[0] + I.mix[1] * I.rates[1] + I.mix[2] * I.rates[2], 2)} Mbps × ${M(I.hours)} h × 3600 s ÷ 8 = ${K.num(sdEgress(I) / (1 - I.off) / 30, 0)} TB/day at the edge; × 30 days × ${pc(1 - I.off)} misses = <b>${K.num(sdEgress(I), 0)} TB/month</b> from origin.`,
    },
    {
      id: "sd-cache-size",
      name: "Size the cache for the working set",
      kind: "Capacity plan",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        const app = R.pick(APPS);
        if (lv === 1) return { lv, app, items: R.pick([10, 20, 50, 80]) * 1e6, kb: R.pick([1, 2, 4, 8]), hot: 0.2 };
        if (lv === 2) return { lv, app, items: R.pick([20, 40, 60, 100]) * 1e6, val: R.pick([500, 800, 1200, 2000]), key: R.pick([40, 60]), ovh: R.pick([60, 80]), hot: 0.2, mm: 0.75 };
        return { lv, app, items: R.pick([100, 200, 300, 500]) * 1e6, val: R.pick([600, 1000, 1500]), key: 50, ovh: 70, hot: 0.2, mm: 0.75, ram: R.pick([13, 26, 52]), ops: R.pick([300, 600, 900, 1500]) * 1000, perShard: 80000 };
      },
      text: (I) => I.lv === 1 ? `<p>${I.app}'s product pages read <b>${M(I.items)} distinct items per day</b>; traffic follows the usual 80/20 rule, so caching the hottest <b>${pc(I.hot)}</b> of them serves most reads. A cached item is about <b>${I.kb} KB</b> (1 KB = 1,000 B).</p><p>Estimate the cache memory needed, in <b>GB</b>.</p>`
        : I.lv === 2 ? `<p>${I.app} wants Redis to hold the hottest <b>${pc(I.hot)}</b> of the <b>${M(I.items)}</b> items read each day. Values average <b>${I.val} B</b>, keys <b>${I.key} B</b>, and Redis's per-key overhead (dict entry, object headers, expiry) measured at <b>${I.ovh} B</b>. You'll set <code>maxmemory</code> to <b>${pc(I.mm)}</b> of RAM to leave room for fragmentation and the fork during persistence, and every primary has <b>one replica</b>.</p><p>Estimate the <b>total RAM to provision across all nodes</b>, in GB.</p>`
          : `<p>${I.app}'s Redis Cluster must hold the hottest <b>${pc(I.hot)}</b> of <b>${M(I.items)}</b> daily items: value <b>${I.val} B</b> + key ${I.key} B + overhead ${I.ovh} B each. Nodes have <b>${I.ram} GB RAM</b> with <code>maxmemory</code> at ${pc(I.mm)}. At peak the cache serves <b>${M(I.ops)} ops/s</b>; one shard's primary sustains <b>${M(I.perShard)} ops/s</b> at the target CPU (replicas take no reads). Every shard has one replica.</p><p>How many <b>nodes</b> (primaries + replicas) do you need?</p>`,
      ui: (I) => ({ unit: I.lv === 3 ? "nodes" : "GB" }),
      accept: (I, a) => I.lv === 3 ? exact(sdCache, "nodes")(I, a) : LB.near(sdCache, 0.25)(I, a),
      solve: (I) => I.lv === 3 ? sdCache(I) : +sdCache(I).toFixed(1),
      bad: (I) => I.lv === 1 ? [+(sdCache(I) * 5).toFixed(1), +(sdCache(I) / 1000).toFixed(3)] : I.lv === 2 ? [+(I.items * I.hot * I.val / 1e9).toFixed(1), +(sdCache(I) / 2).toFixed(1)] : [sdCacheShards(I).mem * 2, sdCacheShards(I).ops * 2, Math.max(sdCacheShards(I).mem, sdCacheShards(I).ops)].filter((x) => x !== sdCache(I)),
      hint: (I) => I.lv === 1 ? "items × 20% × size." : I.lv === 2 ? "Per key: value + key + overhead. Divide by the maxmemory fraction, then double for replicas." : "Shards needed = the larger of (memory ÷ usable memory per node) and (ops ÷ ops per shard). Then count replicas.",
      concept: "Cache sizing for a skewed working set",
      how: "Access patterns are usually skewed (Zipf-like): a small fraction of keys gets most reads, so caching the hottest ~20% captures most hits. Real memory per entry is value + key + the store's per-key overhead, which dominates for small values. maxmemory should leave headroom for fragmentation and the copy-on-write fork used by RDB/AOF rewrite. A cluster's shard count is set by whichever runs out first, memory or throughput, and replicas double the node count without adding write capacity.",
      rule: "Size caches per entry (value + key + overhead), leave ~25% RAM headroom, and compute shards from both memory and ops/s, taking the max.",
      why: (I) => I.lv === 1 ? `${M(I.items)} × ${pc(I.hot)} × ${I.kb} KB = <b>${K.num(sdCache(I), 1)} GB</b>.`
        : I.lv === 2 ? `${M(I.items * I.hot)} keys × ${I.val + I.key + I.ovh} B = ${K.num(I.items * I.hot * (I.val + I.key + I.ovh) / 1e9, 1)} GB of data ÷ ${I.mm} = ${K.num(sdCache(I) / 2, 1)} GB per copy × 2 = <b>${K.num(sdCache(I), 1)} GB</b>. Values alone would have suggested ${K.num(I.items * I.hot * I.val / 1e9, 1)} GB.`
          : `Memory needs ${sdCacheShards(I).mem} shard(s) (${K.num(I.items * I.hot * (I.val + I.key + I.ovh) / 1e9, 0)} GB ÷ ${K.num(I.ram * I.mm, 1)} GB usable); throughput needs ${sdCacheShards(I).ops} (${M(I.ops)} ÷ ${M(I.perShard)}). The ${sdCacheShards(I).mem >= sdCacheShards(I).ops ? "memory" : "throughput"} constraint binds: ${Math.max(sdCacheShards(I).mem, sdCacheShards(I).ops)} shards × 2 = <b>${sdCache(I)} nodes</b>.`,
    },
    {
      id: "sd-ws-servers",
      name: "Count WebSocket servers",
      kind: "Capacity plan",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        const app = R.pick(APPS), conns = R.pick([1, 2, 3, 5, 8]) * 1e6, kb = R.pick([40, 60, 80, 120]), gb = R.pick([16, 24, 48]);
        if (lv === 1) return { lv, app, conns, kb, gb };
        const msgs = R.pick([2, 4, 6, 10]), push = R.pick([40, 60, 80]) * 1000;
        const I = { lv, app, conns, kb, gb, msgs, push };
        const s = sdWs(I);
        if (lv === 2 && R.chance(0.6) && s.cpu <= s.mem) return null;
        return I;
      },
      text: (I) => `<p>${I.app}'s realtime gateway keeps <b>${M(I.conns)} concurrent WebSocket connections</b> at peak. Load tests show each connection costs about <b>${I.kb} KB</b> of memory (TLS state + read/write buffers) and a server has <b>${I.gb} GB</b> usable for connections.</p>${I.lv > 1 ? `<p>Each connection receives about <b>${I.msgs} messages per minute</b>; one server can push <b>${M(I.push)} messages/s</b> at the target CPU.</p>` : ""}${I.lv === 3 ? `<p>Servers run in <b>3 zones</b> behind a zonal load balancer. If a zone fails, its clients reconnect to the other two, which must absorb them. Deploys roll one server per zone at a time, and that server drains its connections first; deploys may coincide with a zone outage.</p>` : ""}<p>How many <b>servers</b> do you need${I.lv === 3 ? " in total across the 3 zones (same count in every zone)" : ""}?</p>`,
      ui: () => ({ unit: "servers" }),
      accept: exact((I) => sdWs(I).total, "servers"),
      solve: (I) => sdWs(I).total,
      bad: (I) => { const s = sdWs(I); return I.lv === 1 ? [s.total - 1, s.total * 2].filter((x) => x > 0) : I.lv === 2 ? [Math.min(s.mem, s.cpu), s.mem + s.cpu].filter((x) => x !== s.total) : [Math.max(s.mem, s.cpu), 3 * Math.ceil(Math.max(s.mem, s.cpu) / 3) + 3, 3 * Math.ceil(Math.max(s.mem, s.cpu) / 2)].filter((x) => x !== s.total); },
      hint: (I) => I.lv === 1 ? "Total memory for all connections ÷ memory per server, rounded up." : I.lv === 2 ? "Two limits: memory per connection and messages pushed per second. The bigger requirement wins." : "Per zone you need enough to carry half the base requirement (two zones carry everything), plus one draining during a deploy.",
      concept: "Connection-bound capacity",
      how: "Long-lived connection servers are usually limited by memory per connection (kernel socket buffers, TLS state, user-space buffers) and by the CPU to fan messages out, not by request rate. Compute both and take the larger. Redundancy is then planned per failure domain: with 3 zones and N+1 zone redundancy, the two surviving zones must carry the full load, so each zone needs half the base requirement. Rolling deploys of stateful connection servers drain clients, so a server per zone is effectively out during every deploy.",
      rule: "For connection servers, size on max(memory, fan-out CPU), then plan zone loss and deploy drain on top. Remember reconnect storms after a failure.",
      why: (I) => { const s = sdWs(I); return I.lv === 1 ? `${M(I.conns)} × ${I.kb} KB = ${K.num(I.conns * I.kb / 1e6, 0)} GB ÷ ${I.gb} GB = <b>${s.total} servers</b>.` : I.lv === 2 ? `Memory needs ${s.mem}; fan-out needs ${M(I.conns)} × ${I.msgs}/60 = ${M(I.conns * I.msgs / 60)} msg/s ÷ ${M(I.push)} = ${s.cpu}. ${s.cpu > s.mem ? "CPU" : "Memory"} binds: <b>${s.total}</b>.` : `Base need max(${s.mem}, ${s.cpu}) = ${Math.max(s.mem, s.cpu)}. Two zones must carry it: ${Math.ceil(Math.max(s.mem, s.cpu) / 2)} per zone, +1 draining for deploys = ${Math.ceil(Math.max(s.mem, s.cpu) / 2) + 1} per zone × 3 = <b>${s.total}</b>.`; },
    },
    {
      id: "sd-shard-count",
      name: "Choose the number of shards",
      kind: "Capacity plan",
      skills: ["estimate", "design"],
      w: "num",
      gen(lv, R) {
        const app = R.pick(APPS);
        if (lv === 1) return { lv, app, tb: R.int(8, 60), disk: R.pick([2, 4]), fill: 0.7 };
        if (lv === 2) { const I = { lv, app, tb: R.int(6, 40), disk: R.pick([2, 4]), fill: 0.7, wps: R.pick([20, 40, 60, 90]) * 1000, perShard: R.pick([4, 5, 6]) * 1000 }; return I; }
        return { lv, app, tb: R.int(6, 20), disk: 4, fill: 0.6, addTB: R.pick([1, 1.5, 2, 3]), wps: R.pick([15, 25, 35]) * 1000, wg: R.pick([0.03, 0.05, 0.07]), perShard: 5000, months: 18 };
      },
      text: (I) => I.lv === 1 ? `<p>${I.app}'s orders database holds <b>${I.tb} TB</b> and must be split across shards. Each shard has <b>${I.disk} TB</b> of disk and the DBAs want shards at most <b>${pc(I.fill)} full</b> (room for VACUUM/compaction, index builds and growth).</p><p>What's the <b>minimum number of shards</b>?</p>`
        : I.lv === 2 ? `<p>${I.app} is sharding a <b>${I.tb} TB</b> table. Each shard: <b>${I.disk} TB</b> disk, keep under <b>${pc(I.fill)}</b> full, sustains <b>${K.num(I.perShard)} writes/s</b> at the target CPU. Peak write load is <b>${K.num(I.wps)} writes/s</b>, spread evenly by a hashed key. The routing layer maps hash slots to shards and requires a <b>power-of-two</b> shard count.</p><p>How many shards?</p>`
          : `<p>${I.app} is planning shards to last <b>${I.months} months</b> without a resharding. Today: <b>${I.tb} TB</b> growing <b>${I.addTB} TB/month</b> (linear); peak <b>${K.num(I.wps)} writes/s</b> growing <b>${pc(I.wg)} month over month</b>. Each shard: ${I.disk} TB disk, keep under <b>${pc(I.fill)}</b> full, <b>${K.num(I.perShard)} writes/s</b> max. Shard count must be a <b>power of two</b>.</p><p>How many shards do you need to provision now?</p>`,
      ui: () => ({ unit: "shards" }),
      accept: exact((I) => sdShards(I).n, "shards"),
      solve: (I) => sdShards(I).n,
      bad: (I) => { const s = sdShards(I); return [s.disk, s.write, s.n / 2, s.n * 2].filter((x, i, a) => x !== s.n && x >= 1 && a.indexOf(x) === i); },
      hint: (I) => I.lv === 1 ? "Usable per shard = disk × max fill." : I.lv === 2 ? "Compute shards for storage and for writes; take the larger and round up to a power of two." : "Project both data and write rate to month 18 first, then size for whichever needs more shards.",
      concept: "Shard count from storage and throughput",
      how: "A shard must fit its data with headroom (compaction, index builds, a bad week of growth) and sustain its share of write traffic at a CPU level that survives a spike. Compute shards from each constraint and take the max. Schemes built on hash slots or consistent hashing often split shards in halves, so counts are powers of two. Resharding a live database is expensive and risky, so plan for the growth horizon: linear data growth and compounding traffic growth reach very different multiples after 18 months.",
      rule: "Shards = max(data ÷ usable disk, peak writes ÷ writes per shard), projected to the end of your planning horizon, rounded up to the scheme's granularity.",
      why: (I) => { const s = sdShards(I); return I.lv === 1 ? `${I.tb} TB ÷ (${I.disk} TB × ${pc(I.fill)}) = ${K.num(I.tb / (I.disk * I.fill), 1)} → <b>${s.n} shards</b>.` : `Storage${I.lv === 3 ? ` at month ${I.months} (${K.num(s.tb, 1)} TB)` : ""} needs ${s.disk}; writes${I.lv === 3 ? ` at month ${I.months} (${K.num(s.w)} writes/s)` : ""} need ${s.write}. Max ${Math.max(s.disk, s.write)} → next power of two: <b>${s.n}</b>.`; },
    },
    {
      id: "sd-estimate-review",
      name: "Review the launch estimate",
      kind: "Design review",
      skills: ["estimate", "comms"],
      w: "lines",
      gen(lv, R) {
        const pool = lv === 1 ? ["sec", "hit"] : lv === 2 ? ["sec", "hit", "repl", "bits"] : ["bits", "peakday", "repl", "avgsrv", "hit"];
        const errs = R.sample(pool, lv).sort();
        return { lv, app: R.pick(APPS), dau: R.pick([4, 6, 8, 12, 20]) * 1e6, upu: R.pick([0.2, 0.3, 0.4, 0.5]), pf: R.pick([2, 3]), size: R.pick([1.5, 2, 2.5, 3]), vpu: R.pick([20, 30, 50]), disp: R.pick([150, 200, 250]), hit: R.pick([0.9, 0.95]), per: R.pick([40, 50, 80]), errs };
      },
      text: (I) => `<p>A teammate wrote this back-of-envelope estimate for the ${I.app} photo launch and asked for review before the capacity request goes out. It contains exactly <b>${I.lv}</b> mistake${I.lv > 1 ? "s" : ""}.</p><p>Flag the line${I.lv > 1 ? "s" : ""} where each mistake is <b>introduced</b>. Lines that merely carry an earlier wrong number forward are computed correctly and shouldn't be flagged. (Decimal units: 1 GB = 1,000 MB.)</p>`,
      ui: (I) => ({ lines: estDoc(I).lines.map(({ t, k }) => ({ t, k })), file: "launch-estimate.txt", k: I.lv }),
      ans: (I) => estDoc(I).lines.map((l, i) => (l.err ? i : -1)).filter((i) => i >= 0),
      diag: (I, a) => { const want = estDoc(I).lines.map((l, i) => (l.err ? i : -1)).filter((i) => i >= 0); const hit = a.filter((i) => want.includes(i)).length; return `${hit} of your ${a.length} flag${a.length === 1 ? " is" : "s are"} right. Recompute each line from the lines above it, checking units and which rate (average or peak) it should use.`; },
      hint: (I) => I.lv === 1 ? "Check the constants: seconds per day, and what a hit ratio means for the origin." : I.lv === 2 ? "Check the constants, the units (bytes vs bits) and every copy the storage line claims to include." : "Be suspicious of which rate each line uses: average, peak, or per day. And of bits vs bytes.",
      concept: "Reviewing a capacity estimate",
      how: "Back-of-envelope estimates fail in a handful of repeatable ways: wrong time constants (3,600 vs 86,400 s), bytes vs bits (×8), using the hit ratio where the miss ratio belongs, forgetting copies (replicas, renditions), and mixing average and peak rates: storage per day comes from daily volume, while servers and bandwidth must be sized for the peak rate. Reviewing means recomputing each line from its inputs and checking the units, not eyeballing the final number.",
      rule: "Put units on every number and recompute each line from the one above; servers and links are sized for peak, storage for volume.",
      why: (I) => { const d = estDoc(I); return d.lines.map((l, i) => (l.err ? `<li>Line ${i}: ${l.why}</li>` : "")).join("").replace(/^/, "<ul>") + "</ul>"; },
    },
    /* ======================= availability ======================= */
    {
      id: "sd-availability-chain",
      name: "Hit the availability target",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const api = { name: "API service", a: R.pick([0.99, 0.995]), need: lv === 2 ? 3 : lv === 3 ? 2 : 1, cost: R.int(10, 18) * 10 };
        const cache = { name: "Redis", a: R.pick([0.995, 0.998]), need: 1, cost: R.int(15, 30) * 10 };
        const db = { name: "Postgres", a: R.pick([0.998, 0.999]), need: 1, cost: R.int(40, 90) * 10 };
        const comps = [api, cache, db];
        if (lv >= 2) comps.push({ name: "Payment provider", a: R.pick([0.9995, 0.9998]), fixed: true, need: 1, cost: 0 });
        return { lv, app: R.pick(APPS), comps, target: lv === 1 ? R.pick([0.999, 0.9995]) : lv === 2 ? 0.999 : 0.9995, z: lv === 3 ? R.pick([0.999, 0.9995]) : null, xz: lv === 3 ? R.int(4, 9) * 10 : 0 };
      },
      text: (I) => `<p>${I.app}'s checkout request passes through every component below in series; if any is down, checkout is down. The SLO is <b>${nines(I.target)}</b> monthly availability (${down(I.target)} of downtime).</p><ul>${I.comps.map((c) => `<li><b>${c.name}</b>: ${c.fixed ? `third party, ${nines(c.a)} measured, nothing you can change` : `each replica up ${nines(c.a)} of the time, ${K.usd(c.cost)}/mo per replica${c.need > 1 ? `, needs <b>${c.need}</b> replicas up to carry peak load` : ""}`}</li>`).join("")}</ul><p>Assume instant failover and independent replica failures${I.z ? `, except that all three zones fail independently with availability <b>${nines(I.z)}</b> each and take down every replica in them. Spreading a component across 3 zones costs <b>${K.usd(I.xz)}/mo</b> in cross-zone traffic; replicas are placed round-robin` : ""}. Choose replica counts${I.z ? " and placement" : ""} that meet the SLO at the <b>lowest cost</b>.</p>`,
      ui: (I) => {
        const knobs = [];
        I.comps.forEach((c, i) => { if (c.fixed) return; knobs.push({ k: "n" + i, label: c.name + " replicas", opts: U.range(4).map((j) => c.need + j) }); if (I.z) knobs.push({ k: "z" + i, label: c.name + " placement", opts: ["1 zone", "3 zones"] }); });
        return { knobs, live: (cfg) => chainHTML(I, cfg) };
      },
      valid: (I, cfg) => { const r = chainAvail(I, cfg); return r.total >= I.target ? true : `availability ${nines(r.total)} is below the ${nines(I.target)} SLO`; },
      val: (I, cfg) => chainAvail(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Series availability is the product. Which component's single replica costs you the most nines, and which redundancy is cheap?" : I.lv === 2 ? "The third party eats part of your error budget. A component that needs 3 replicas up isn't made safe by having exactly 3." : "A component with every replica in one zone can never beat that zone's availability, and a zone outage hits every component placed there at once.",
      concept: "Availability of serial and redundant components",
      how: "Components in series multiply: three 99.9% services give 99.7%, about 2 hours of downtime a month. Redundancy turns a component's failure probability (1 − a) into roughly (1 − a)^n for n replicas when one suffices; when k replicas must be up to carry the load, it's the probability that at least k of n are up, so the spare is what buys the nines. A third-party dependency caps what you can reach and consumes error budget you can't win back. Correlated failures dominate real systems: replicas in one zone share its fate, so spreading across zones matters more than adding replicas.",
      rule: "Multiply along the request path, add N+1 spares beyond what load needs, spread replicas across failure domains, and spend money where (1 − a) is largest.",
      why: (I, sol) => { const r = chainAvail(I, sol); return `Cheapest passing design: ${I.comps.map((c, i) => (c.fixed ? "" : `${c.name} ×${sol["n" + i]}${I.z ? ` in ${sol["z" + i]}` : ""}`)).filter(Boolean).join(", ")} → <b>${nines(r.total)}</b> (${down(r.total)}) for ${mo(r.cost)}.${I.z ? ` Zones at ${nines(I.z)} make single-zone placement a hard ceiling.` : ""}`; },
    },
    {
      id: "sd-zone-headroom",
      name: "Survive a zone outage at peak",
      kind: "Capacity plan",
      skills: ["estimate", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const small = { name: "c-small (2 vCPU)", cap: R.pick([300, 350, 400]), price: R.int(6, 9) * 10 };
        const large = { name: "c-large (8 vCPU)", cap: small.cap * R.pick([4.4, 4.6]), price: small.price * 4 };
        const peak = lv === 1 ? R.int(6, 18) * 1000 : R.int(12, 30) * 1000;
        const I = { lv, app: R.pick(APPS), svc: R.pick(K.NAMES.svc), peak, small, large, U: lv === 1 ? 0.8 : 0.75, deploy: lv === 3 ? 1 : 0, share: lv === 3 ? R.pick([[0.5, 0.3, 0.2], [0.45, 0.35, 0.2], [0.55, 0.25, 0.2]]) : null, xzCost: lv === 3 ? R.int(8, 20) * 100 : 0 };
        return I;
      },
      text: (I) => `<p>The <b>${I.svc}</b> service peaks at <b>${K.num(I.peak)} req/s</b> and runs in 3 zones. Policy: at peak, with <b>any one zone lost</b>${I.deploy ? " <b>and a deploy in progress</b> (one instance per zone out of rotation)" : ""}, no instance may run above <b>${pc(I.U)}</b> of its tested capacity.</p>${I.lv === 1 ? `<p>Instances handle <b>${I.small.cap} req/s</b> each at ${K.usd(I.small.price)}/mo. The same count runs in every zone.</p>` : `<p>Instance types:</p>${K.table(["Type", "Capacity", "Price"], [[I.small.name, I.small.cap + " req/s", mo(I.small.price)], [I.large.name, K.num(I.large.cap) + " req/s", mo(I.large.price)]], { compact: true })}`}${I.share ? `<p>Clients are zone-affine: <b>${I.share.map((s, z) => `zone ${"ABC"[z]} ${pc(s)}`).join(", ")}</b> of traffic. With cross-zone load balancing <b>off</b>, each zone serves its own clients (a failed zone's clients split evenly across the other two). Turning it <b>on</b> spreads load evenly but costs <b>${mo(I.xzCost)}</b> in cross-zone data transfer.</p>` : ""}<p>Find the <b>cheapest</b> configuration that meets the policy.</p>`,
      ui: (I) => {
        const knobs = [];
        if (I.lv > 1) knobs.push({ k: "type", label: "Instance type", opts: ["small", "large"], fmt: (v) => (v === "small" ? I.small.name : I.large.name) });
        if (I.lv < 3) knobs.push({ k: "n", label: "Instances per zone", min: 1, max: 60, step: 1 });
        else { ["A", "B", "C"].forEach((z) => knobs.push({ k: "n" + z, label: `Instances in zone ${z}`, min: 2, max: 60, step: 1 })); knobs.push({ k: "xz", label: "Cross-zone load balancing", opts: ["off", "on"] }); }
        return { knobs, init: I.lv === 1 ? { n: 3 } : I.lv === 2 ? { type: "small", n: 3 } : { type: "small", nA: 4, nB: 4, nC: 4, xz: "off" }, live: (cfg) => zoneHTML(I, cfg) };
      },
      valid: (I, cfg) => { const r = zoneSim(I, cfg); return r.worst <= I.U + 1e-9 ? true : `with ${r.worstCase} an instance runs at ${pc(r.worst)} (limit ${pc(I.U)})`; },
      val: (I, cfg) => zoneSim(I, cfg).cost,
      solve: (I) => zoneSolve(I),
      noBrute: true,
      hint: (I) => I.lv === 1 ? "If one zone is lost, the other two zones carry the whole peak." : I.lv === 2 ? "Compare price per req/s, but also how coarse each step is: you buy whole instances in 3 zones." : "With cross-zone LB off, each zone must carry its own clients plus half of a failed zone's. Size zones individually and compare with paying for cross-zone traffic.",
      concept: "N+1 zone headroom",
      how: "To survive losing one of three zones, the remaining two must carry the peak, so each zone needs 50% of the load's capacity: 150% total, before any utilisation ceiling. A utilisation cap (e.g. 75%) leaves room for spikes, retries and slower hosts. Deploys take instances out of rotation, and a zone outage during a deploy is the case that actually happens. With zone-affine traffic and no cross-zone load balancing, each zone is sized by its own clients plus its share of a failed neighbour's, which can beat paying for cross-zone transfer, or not.",
      rule: "Size each zone for (its load + its share of the biggest zone's load) ÷ target utilisation, with deploy surge on top, and compare instance shapes on whole-instance cost, not price per unit.",
      why: (I, sol) => { const r = zoneSim(I, sol); return `Cheapest: ${I.lv > 1 ? `${sol.type === "large" ? I.large.name : I.small.name}, ` : ""}${I.lv < 3 ? `${sol.n} per zone` : `zones A/B/C = ${sol.nA}/${sol.nB}/${sol.nC}, cross-zone LB ${sol.xz}`} for <b>${mo(r.cost)}</b>; the tightest case is ${r.worstCase} at ${pc(r.worst)} utilisation.`; },
    },
    {
      id: "sd-url-ids",
      name: "Generate short URL codes",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a code length of",
      vfmt: (x) => x + " characters",
      gen(lv, R) {
        return { lv, app: R.pick(APPS), total: R.pick(lv === 1 ? [1, 5, 20, 100] : [10, 30, 50, 200]) * 1e9 * (lv === 1 ? 0.1 : 0.1), wps: lv === 1 ? 2000 : R.pick([20, 30, 50]) * 1000, seqMax: 8000, block: 10000 };
      },
      text: (I) => `<p>${I.app}'s URL shortener expects <b>${M(I.total)} short links</b> over its lifetime, created at up to <b>${K.num(I.wps)}/s</b> at peak. Codes are base62 (<code>[0-9A-Za-z]</code>); shorter is better (they're typed and printed on posters).</p><ul>${I.lv === 1 ? `<li>Codes are random; on a collision the insert (<code>INSERT ... ON CONFLICT DO NOTHING</code>) is retried with a new code. Product wants fewer than <b>0.1%</b> of creates to need a retry, even when the table is full.</li>` : `<li>Random codes must keep the retry rate under <b>0.1%</b> at end of life.</li><li>The same long URL shortened by two users must get <b>two different codes</b> (per-user click analytics).</li><li>A single ID database can hand out at most <b>${K.num(I.seqMax)} IDs/s</b>.</li>${I.lv === 3 ? "<li>Links can point to private documents: codes must <b>not be enumerable</b> (seeing one code mustn't let you guess others).</li>" : ""}`}</ul><p>Choose the scheme and the <b>shortest code length</b> that meets every requirement.</p>`,
      ui: (I) => {
        const methods = I.lv === 1 ? ["random"] : I.lv === 2 ? ["random", "db sequence", "counter ranges", "hash of URL"] : ["random", "db sequence", "counter ranges", "hash of URL", "ranges + FPE shuffle"];
        const knobs = [{ k: "m", label: "ID scheme", opts: methods, fixed: I.lv === 1 ? "random" : undefined, fmt: (v) => URL_M[v].label, help: I.lv === 1 ? "" : "how a new code is produced" }, { k: "len", label: "Code length", opts: [5, 6, 7, 8, 9, 10, 11], unit: "chars" }];
        return { knobs, init: { m: "random", len: 6 }, live: (cfg) => urlHTML(I, cfg) };
      },
      valid: (I, cfg) => { const r = urlSim(I, cfg); return r.fail.length ? r.fail[0] : true; },
      val: (I, cfg) => cfg.len,
      hint: (I) => I.lv === 1 ? "Retry probability for a random code ≈ fill ratio = links ÷ 62^length." : I.lv === 2 ? "A counter never collides, so it can fill the keyspace. But one sequence can't take the write rate. How do you hand out counters without a round trip per link?" : "Sequential counters are enumerable. Is there a way to keep a counter's density without its ordering? (Think of encrypting the counter within the same keyspace.)",
      concept: "Short-code ID generation",
      how: "Random codes need no coordination but collide: the chance a new code hits an existing one equals the fill ratio (links ÷ 62^L), so random schemes waste most of the keyspace to keep retries rare. A counter never collides and can fill the space, but a single sequence is a throughput bottleneck and single point of failure; leasing blocks of IDs to each app server (counter ranges) removes the round trip per link. Hashing the long URL deduplicates identical URLs, which is wrong when each user needs their own code. Counters are enumerable; a keyed format-preserving permutation (e.g. FF1 or a Feistel network with cycle-walking) maps each counter to a unique, unguessable code of the same length.",
      rule: "Pick ID schemes by their requirements (coordination, density, guessability), then size the length from fill ratio: random needs ~1000× headroom for 0.1% retries, counters only need the space to fit.",
      why: (I, sol) => { const r = urlSim(I, sol); return `<b>${URL_M[sol.m].label}</b> with <b>${sol.len}</b> characters: keyspace ${M(62 ** sol.len)}, fill ${pc(r.fill)}${sol.m === "random" ? `, retry rate ${pc(r.fill)}` : ""}. ${I.lv === 1 ? "" : I.lv === 2 ? "Random codes would need about two more characters for the same retry rate; leased ranges need one coordinator call per 10,000 links." : "Plain ranges are sequential and guessable; encrypting the counter inside the 62^L space keeps their density without the ordering."}`; },
    },
  ]);


  /* ======================= designs (launch-day simulator) ======================= */
  LB.addAll("sd", [
    {
      id: "sd-shortener-cache",
      name: "Keep redirects fast on launch day",
      kind: "Capacity plan",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        return { lv, app: R.pick(APPS), peak: lv === 1 ? R.int(20, 45) * 1000 : R.int(40, 80) * 1000, links: R.pick([1, 2, 5]) * 1e8, viral: lv === 1 ? 0 : R.int(15, 30) * 10000, spike: 10, dbCap: 6000, dbPrice: R.int(5, 9) * 100, gbPrice: R.pick([6, 8, 10]), edgePrice: R.int(9, 16) * 100, slo: 40 };
      },
      text: (I) => `<p>${I.app}'s URL shortener peaks at <b>${K.num(I.peak)} redirects/s</b> in the evening, over <b>${M(I.links)}</b> active links with a Zipf-like popularity. A redirect looks up the code in Redis (≈500 B per cached link) and falls back to Postgres read replicas (each sustains <b>${K.num(I.dbCap)} lookups/s</b>, ${mo(I.dbPrice)}). Redis costs <b>${K.usd(I.gbPrice)}/GB-month</b>.</p>${I.viral ? `<p>At the 10:00 launch, one link goes viral and peaks at <b>${K.num(I.viral)} req/s</b> on its own. One Redis shard serves a single key at up to <b>100,000 ops/s</b>.</p>` : ""}${I.lv === 2 ? `<p>Click analytics can be rebuilt from CDN logs, so caching redirects at the edge (${mo(I.edgePrice)}, absorbs ≈85% of requests) is allowed.</p>` : I.lv === 3 ? `<p>Every click must be counted by your servers in real time (advertisers are billed per click). One read replica is always assumed to be out for maintenance.</p>` : ""}<p>Meet <b>p99 ≤ ${I.slo} ms</b> and <b>error rate ≤ 0.1%</b> all day for the lowest monthly cost.</p>`,
      ui: (I) => {
        const knobs = [{ k: "gb", label: "Redis memory", opts: [0, 8, 16, 32, 64, 128], unit: "GB" }, { k: "reps", label: "Postgres read replicas", opts: [1, 2, 3, 4, 5, 6, 8, 10] }];
        if (I.lv > 1) knobs.push({ k: "local", label: "In-process cache (5 s TTL)", opts: ["off", "on"], help: "each app instance keeps its hottest codes in memory" }, { k: "edge", label: "Edge caching of redirects", opts: ["off", "301 at CDN", "302 max-age=60"] });
        return { knobs, init: { gb: 0, reps: 1, local: "off", edge: "off" }, live: (cfg) => scHTML(I, cfg) };
      },
      valid: (I, cfg) => scSim(I, cfg).fail || true,
      val: (I, cfg) => scSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Watch the hit ratio: with Zipf popularity, a modest cache catches most traffic, and only misses reach the replicas. Once more than 1% of requests miss, p99 is the database's latency." : I.lv === 2 ? "A single hot key lives on one Redis shard no matter how big the cluster is. Something in front of Redis has to absorb it." : "Edge-cached redirects never reach your servers. Then compare buying cache memory against buying replicas (remember one is always out).",
      concept: "Read-heavy caching and hot keys",
      how: "With Zipf-like popularity, caching the top k of N items yields a hit ratio of roughly ln k ÷ ln N, so the first gigabytes buy most of the benefit and each doubling buys less. The database then sees only misses. Because p99 is the 99th percentile of all requests, once more than 1% of requests miss the cache, p99 is set by the database path, not by the cache. A single hot key is served by one shard regardless of cluster size; an in-process cache with a short TTL (or key replication) absorbs it. Edge caching removes load entirely but also removes your visibility of each request.",
      rule: "Size caches from the popularity curve, keep p99 in mind when misses exceed 1%, put a tiny local cache in front of hot keys, and only cache at the edge what you don't need to see.",
      why: (I, sol) => { const r = scSim(I, sol); return `Cheapest: ${sol.gb} GB Redis (hit ratio ${pc(r.hit)}), ${sol.reps} replica${sol.reps > 1 ? "s" : ""}${I.lv > 1 ? `, local cache ${sol.local}, edge ${sol.edge}` : ""}: peak p99 ${K.ms(r.day.worst)}, ${mo(r.cost)}.${I.viral && sol.local === "on" ? ` The viral link (${K.num(I.viral)} req/s) would otherwise saturate its Redis shard.` : ""}`; },
    },
    {
      id: "sd-feed-fanout",
      name: "Tune the feed fan-out threshold",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const m = R.pick([0.7, 1, 1.3]);
        return { lv, app: R.pick(APPS), posts: [3000, 300, 30, 3, 0.2].map((p) => +(p * m).toFixed(2)), fol: [200, 3000, 30000, 300000, R.pick([3, 5]) * 1e6], follows: [120, 40, 15, 6, R.pick([3, 4, 6])], reads: R.pick([30, 50, 80]) * 1000, slo: lv === 1 ? 300 : lv === 2 ? 150 : 80, burst: lv === 1 ? null : { big: R.int(15, 40), mid: R.int(100, 300) }, lag: 60, ina: lv === 3 ? R.pick([0.4, 0.5, 0.6]) : 0, wPrice: 120, rPrice: 150, rebuild: lv === 3 ? R.int(10, 25) * 100 : 0 };
      },
      text: (I) => `<p>${I.app}'s home feed: when someone posts, fan-out workers can <b>push</b> the post ID into each follower's timeline cache (one worker inserts <b>40,000/s</b>, ${mo(I.wPrice)}), or followers can <b>pull</b> the author's recent posts at read time and merge them. Authors below the threshold are pushed; authors at or above it are pulled.</p>${K.table(["Followers", "Posts/s (all authors)", "Avg followers", "Followed per user"], ["< 1k", "1k–10k", "10k–100k", "100k–1M", "> 1M"].map((b, i) => [b, K.num(I.posts[i], 1), M(I.fol[i]), I.follows[i]]), { compact: true })}<p>Feeds are read <b>${K.num(I.reads)}/s</b>; read p99 ≈ 25 ms + 3.5 ms per pulled author, and read servers (4,000 merge-units/s each, ${mo(I.rPrice)}) do 1 unit per read + 0.25 per pulled author.</p><p>Posts must reach timelines within <b>${I.lag} s</b>; keep workers ≤ 85% busy.${I.burst ? ` During tonight's live final, <b>${I.burst.big}</b> accounts with > 1M followers and <b>${I.burst.mid}</b> with 100k–1M post within the same minute.` : ""}${I.ina ? ` <b>${pc(I.ina)}</b> of followers haven't opened the app in 30 days; skipping their fan-out (rebuilding a timeline when they return) costs ${mo(I.rebuild)} in rebuild capacity.` : ""} Feed p99 SLO: <b>${I.slo} ms</b>. Find the cheapest design.</p>`,
      ui: (I) => {
        const knobs = [{ k: "t", label: "Push threshold", opts: [0, 1, 2, 3, 4, 5], fmt: (v) => FAN_T[v] }, { k: "w", label: "Fan-out workers", opts: [8, 16, 24, 32, 48, 64, 96, 128, 192] }];
        if (I.ina) knobs.push({ k: "skip", label: "Skip inactive followers", opts: ["off", "on"] });
        return { knobs, init: { t: 5, w: 32, skip: "off" }, live: (cfg) => fanHTML(I, cfg) };
      },
      valid: (I, cfg) => fanSim(I, cfg).fail || true,
      val: (I, cfg) => fanSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Pull-everything makes reads slow; push-everything makes writes expensive. The middle buckets are where the trade happens." : I.lv === 2 ? "Pushing a multi-million-follower post means millions of inserts. Work out how long the live-final burst takes to drain for each threshold." : "The SLO forces the threshold one way and the burst the other. Then look at who you're pushing to.",
      concept: "Fan-out on write vs read (and the celebrity problem)",
      how: "Fan-out on write precomputes each follower's timeline, making reads a cheap cache lookup, but a post costs one insert per follower: a 3M-follower account costs 3M writes per post and bursts can back up the fan-out queue for minutes. Fan-out on read costs nothing at write time but every feed load must fetch and merge the recent posts of every followed author, which grows read latency and CPU. Hybrids push for normal authors and pull for celebrities, so the threshold trades write volume against read work. Skipping fan-out for inactive users is a common further saving, paid for by rebuilding their timeline when they return.",
      rule: "Push for the long tail, pull for the head: set the threshold where the fan-out burst drains within your delivery SLO and the pulled-author count still fits the read latency budget.",
      why: (I, sol) => { const r = fanSim(I, sol); return `Cheapest passing: ${FAN_T[sol.t]} with ${sol.w} workers${I.ina ? `, skip inactive ${sol.skip}` : ""}: ${M(r.push)} inserts/s, read p99 ${K.num(r.p99)} ms (${r.pulled} pulled authors), ${I.burst ? `burst drains in ${K.num(r.drain, 0)} s, ` : ""}${mo(r.cost)}.`; },
    },
    {
      id: "sd-presence",
      name: "Design chat presence",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        return { lv, app: R.pick(APPS), conc: (lv === 3 ? R.pick([20, 25, 30]) : R.pick([4, 8, 12, 20])) * 1e6, friends: lv === 3 ? 250 : R.pick([100, 150, 250]), onl: R.pick([0.1, 0.15, 0.2]), sub: R.pick([0.02, 0.03]), ch: R.int(4, 10), stale: lv === 1 ? R.pick([35, 45]) : lv === 2 ? R.pick([40, 50]) : 70, mobileMin: lv === 3 ? 30 : 0, shardCap: 150000, shardPrice: R.int(3, 6) * 100, gwCap: 300000, gwPrice: R.int(2, 4) * 100, gwMin: lv === 3 ? 40 : 20 };
      },
      text: (I) => `<p>${I.app} shows a green dot next to online friends. <b>${M(I.conc)}</b> users are connected at peak with <b>${I.friends}</b> friends each, of whom ~${pc(I.onl)} are online. Each user changes status (online/away/offline) about <b>${I.ch}× per hour</b>.</p><ul><li>Clients send a heartbeat every <i>h</i> seconds; a user is marked offline after 2 missed heartbeats plus a 5 s sweep, which must happen within <b>${I.stale} s</b>.${I.mobileMin ? ` The mobile team won't wake the radio more than once per <b>${I.mobileMin} s</b>.` : ""}</li><li>The presence store (heartbeats and changes are writes) handles <b>${M(I.shardCap)} writes/s</b> per shard (${mo(I.shardPrice)}).</li><li>Gateways receive heartbeats and push presence updates: <b>${M(I.gwCap)} messages/s</b> each at ≤ 70% CPU (${mo(I.gwPrice)}); you already run at least <b>${I.gwMin}</b> for connections.</li>${I.lv > 1 ? `<li>Fan-out options: push each change to all friends, only to online friends, or only to friends whose open screen shows you (~${pc(I.sub)} of friends subscribe).</li>` : "<li>Each change is pushed to the user's online friends.</li>"}</ul><p>Find the cheapest design.</p>`,
      ui: (I) => {
        const knobs = [{ k: "h", label: "Heartbeat interval", opts: [5, 10, 15, 20, 30, 60], unit: "s" }];
        if (I.lv > 1) knobs.push({ k: "mode", label: "Presence fan-out", opts: ["all friends", "online friends", "subscribed viewers"] });
        knobs.push({ k: "shards", label: "Presence store shards", opts: [1, 2, 3, 4, 6, 8, 12, 16, 24] }, { k: "gw", label: "Gateway servers", opts: U.range(12).map((i) => I.gwMin + i * (I.lv === 1 ? 5 : 10)) });
        return { knobs, init: { h: 5, mode: "all friends", shards: 1, gw: I.gwMin }, live: (cfg) => presHTML(I, cfg) };
      },
      valid: (I, cfg) => presSim(I, cfg).fail || true,
      val: (I, cfg) => presSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Heartbeat writes are users ÷ interval. Use the longest interval the staleness target allows." : I.lv === 2 ? "Presence fan-out is changes/s × recipients: who actually needs to know right now?" : "The radio limit and the staleness target leave one interval. Then the fan-out mode decides the gateway fleet.",
      concept: "Presence: heartbeats and fan-out",
      how: "Presence is a write-heavy, ephemeral system: every connected client refreshes a TTL'd key every heartbeat interval, so store load is users ÷ interval, and offline detection takes about two intervals. Shorter intervals give fresher dots but cost writes and mobile battery. The bigger cost is fan-out: a status change sent to every friend multiplies by hundreds, while most friends aren't looking. Sending only to clients with a screen open that shows the user (subscriptions), and letting others fetch presence on demand, cuts fan-out by an order of magnitude or more.",
      rule: "Make heartbeats as slow as freshness allows, and fan presence out only to viewers who are subscribed right now; fetch the rest lazily.",
      why: (I, sol) => { const r = presSim(I, sol); return `Cheapest: ${sol.h} s heartbeats (offline detected in ${2 * sol.h + 5} s)${I.lv > 1 ? `, fan-out to ${sol.mode}` : ""}, ${sol.shards} shard(s), ${sol.gw} gateways: ${M(r.writes)} store writes/s and ${M(r.msgs)} gateway messages/s for ${mo(r.cost)}.`; },
    },
    {
      id: "sd-notify-campaign",
      name: "Deliver the push campaign on time",
      kind: "Config change",
      skills: ["tune", "design"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const I = { lv, app: R.pick(APPS), N: R.pick([5, 10, 20, 30]) * 1e6, mins: R.pick([20, 30, 45]), L: R.pick([10, 20, 30]) * 1000, e: R.pick([0.03, 0.05, 0.08]), w: R.pick([400, 500, 800]), price: R.int(3, 6) * 10, opt: lv === 3 ? R.pick([0.1, 0.15, 0.2]) : 0 };
        // Senior/Staff: the deadline needs more than 70% of the provider quota, so 429 handling matters
        if (lv > 1) { const need = (I.N * (1 - I.opt) * (1 + I.e + I.e * I.e)) / (I.mins * 60); I.L = Math.ceil(need / R.pick([0.8, 0.85]) / 500) * 500; }
        return I;
      },
      text: (I) => `<p>${I.app} sends a launch notification to <b>${M(I.N)}</b> devices and it must finish within <b>${I.mins} minutes</b>. The push provider accepts up to <b>${K.num(I.L)} requests/s</b> and answers <code>429 Too Many Requests</code> above that (transactional pushes share this quota in bursts, so expect 429s once you use more than ~70% of it); <b>${pc(I.e)}</b> of sends fail transiently (5xx or timeout). Each worker sends <b>${I.w}/s</b> (${mo(I.price)} each). At least <b>99.9%</b> of devices must get the notification.${I.lv === 1 ? " Retries already use exponential backoff with jitter." : ""}</p>${I.lv > 1 ? `<p>Half of the transient failures are timeouts where the provider actually delivered the message; product allows at most <b>0.01%</b> duplicates. The provider honours an <code>Idempotency-Key</code> header. 429 responses are retried until accepted (they don't use up attempts) according to the backoff policy.</p>` : ""}${I.opt ? `<p><b>${pc(I.opt)}</b> of users have opted out of marketing. Opt-outs must take effect within <b>60 s</b>, even mid-campaign. Checking preferences per message at send time halves a worker's throughput; a local preferences cache (30 s TTL) costs 10%.</p>` : ""}<p>Configure the cheapest campaign that meets every requirement.</p>`,
      ui: (I) => {
        const knobs = [{ k: "workers", label: "Workers", opts: [5, 10, 15, 20, 30, 40, 60, 80, 100, 150] }, { k: "att", label: "Max attempts", opts: [1, 2, 3, 4, 5] }];
        if (I.lv > 1) knobs.push({ k: "backoff", label: "Retry backoff", opts: ["none", "fixed 1 s", "exponential + jitter"] }, { k: "idem", label: "Idempotency-Key", opts: ["off", "on"] });
        if (I.opt) knobs.push({ k: "prefs", label: "Preferences check", opts: ["filter at enqueue", "lookup at send", "cached (30 s) at send"] });
        return { knobs, init: { workers: 5, att: 1, backoff: "none", idem: "off", prefs: "filter at enqueue" }, live: (cfg) => notifHTML(I, cfg) };
      },
      valid: (I, cfg) => notifSim(I, cfg).fail || true,
      val: (I, cfg) => notifSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Delivery probability with a attempts is 1 − e^a. Retries add work: plan throughput for the amplified volume, under the provider's limit." : I.lv === 2 ? "Above the provider's limit, synchronised retries make things worse. And a retried timeout can deliver twice." : "Filtering at enqueue doesn't see opt-outs during the send. Which option honours them without halving throughput?",
      concept: "Notification delivery: retries, rate limits and idempotency",
      how: "A notification fan-out is a big batch pushed through a rate-limited third party. Retries raise delivery probability (1 − e^a) but amplify load by 1 + e + e² + …; sending faster than the provider's limit just converts throughput into 429s, and retrying them without backoff and jitter synchronises clients into storms that waste much of the quota. Timeouts are ambiguous (the send may have succeeded), so retries need an idempotency key the provider dedupes on. User preferences must be checked as late as the opt-out SLA requires, ideally from a short-TTL cache rather than a remote call per message.",
      rule: "Stay just under the provider's rate limit, retry transient errors with capped exponential backoff, jitter and an idempotency key, and check preferences at send time from a cache.",
      why: (I, sol) => { const r = notifSim(I, sol); return `Cheapest: ${sol.workers} workers, ${sol.att} attempts${I.lv > 1 ? `, ${sol.backoff}, idempotency ${sol.idem}` : ""}${I.opt ? `, ${sol.prefs}` : ""}: delivers ${K.pct(r.success, 3)} in ${K.num(r.minutes, 1)} min at ${K.num(r.good)} sends/s for ${mo(r.cost)}.`; },
    },
    {
      id: "sd-global-rate-limit",
      name: "Build a global rate limiter",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        const regions = lv === 1 ? 1 : lv === 2 ? 3 : 4;
        return { lv, app: R.pick(APPS), regions, limit: R.pick([100, 500, 1000, 2000]), keys: R.pick([200, 500, 1000]) * 1000, hot: R.pick([10, 20, 40]) * 1000, eps: lv === 3 ? 0.15 : 0.1, budget: lv === 1 ? 5 : R.pick([5, 10]), rtt: R.int(70, 140), memGB: R.pick([8, 16]), central: R.int(4, 8) * 100, regional: R.int(3, 6) * 100, gbPrice: 0.02 };
      },
      text: (I) => `<p>${I.app}'s public API limits each key to <b>${K.num(I.limit)} req/s</b>; <b>${M(I.keys)}</b> keys are active. Requirements: no key may get more than <b>${pc(I.eps)}</b> over its limit in any 1-second window; the limiter may add at most <b>${I.budget} ms</b> to p99; limiter state must fit in <b>${I.memGB} GB</b> of Redis.</p><ul><li>Clients hold long-lived connections, so one key's traffic can sit on one or two of the many API nodes.</li><li>Token buckets here are configured with a burst of 0.5 s of rate; the sliding-window counter's interpolation error is up to 3% for bursty keys; a sliding log stores one ~64 B entry per request in the window.</li>${I.regions > 1 ? `<li>API runs in <b>${I.regions} regions</b>; a central Redis is <b>${I.rtt} ms</b> away from the other regions. With a Redis per region, regions exchange counts every <i>Δ</i>; a key whose traffic arrives everywhere at once can then overshoot by (regions − 1) × Δ of its per-second limit. About <b>${M(I.hot)}</b> keys are active in several regions; each sync ships 16 B per such key to every other region at $${I.gbPrice}/GB.</li>` : ""}</ul><p>Redis costs ${mo(I.central)} for a central cluster${I.regions > 1 ? `, ${mo(I.regional)} per regional one` : ""}. Find the cheapest design that meets every requirement.</p>`,
      ui: (I) => {
        const knobs = [{ k: "algo", label: "Algorithm", opts: ["fixed window", "sliding log", "sliding window counter", "token bucket"] }, { k: "store", label: "Counter location", opts: I.regions > 1 ? ["per-node memory", "central Redis", "Redis per region + sync"] : ["per-node memory", "central Redis"] }];
        if (I.regions > 1) knobs.push({ k: "sync", label: "Sync interval Δ", opts: [10, 25, 50, 100, 250, 1000], unit: "ms", help: "only for Redis per region" });
        return { knobs, init: { algo: "fixed window", store: "per-node memory", sync: 1000 }, live: (cfg) => rlHTML(I, cfg) };
      },
      valid: (I, cfg) => rlSim(I, cfg).fail || true,
      val: (I, cfg) => rlSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "A fixed window lets a client send a full window at 0.999 s and another at 1.001 s. And a per-node limit can't see the key's other nodes." : I.lv === 2 ? "Cross-region round trips blow the latency budget. With local Redis, how stale can each region's view be?" : "Multiply the algorithm's own error by the sync overshoot; the product must stay within the tolerance. An exact algorithm buys a longer sync interval, if its memory fits.",
      concept: "Distributed rate limiting",
      how: "Fixed windows are cheap but allow 2× the limit across a window boundary; sliding logs are exact but store every request; a sliding-window counter interpolates between two fixed windows with small error and constant memory; token buckets allow a configured burst on top of the rate. Limits must be enforced where all of a key's traffic is visible: per-node counters fail when traffic is uneven across nodes. A single central store adds a round trip to every request, so global limiters keep a counter per region and periodically exchange counts, accepting an overshoot proportional to the sync interval.",
      rule: "Use sliding-window counters in a store close to the API, sync regions as rarely as the overshoot budget allows, and fail open (with alarms) if the limiter itself is down.",
      why: (I, sol) => { const r = rlSim(I, sol); return `Cheapest passing: ${sol.algo}, ${sol.store}${sol.store === "Redis per region + sync" ? ` every ${sol.sync} ms` : ""}: worst case ${K.num(r.factor, 3)}× the limit, +${r.lat} ms p99, ${K.num(r.mem, 2)} GB, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-upload-pipeline",
      name: "Design the upload pipeline",
      kind: "Design review",
      skills: ["design", "safe"],
      w: "steps",
      gen(lv, R) { return { lv, app: R.pick(APPS), mb: R.pick([50, 200, 500, 2000]), ups: R.pick([20, 50, 100, 200]), order: R.shuffle(U.range(UP_ALL(lv).length)) }; },
      text: (I) => `<p>${I.app} is launching video uploads: files up to <b>${K.bytes(I.mb * 1048576)}</b>, about <b>${I.ups} uploads/s</b> at peak. Processing (renditions and thumbnails) takes 10 s to several minutes per file.${I.lv > 1 ? " Uploaded files are untrusted until scanned for malware, and only clean files may ever be publicly reachable." : ""}${I.lv === 3 ? " Some files are corrupt and crash the transcoder every time." : ""}</p><p>Build the pipeline from the steps below, in order. Leave out steps that would break under these numbers or lose files.</p>`,
      ui: (I) => ({ opts: I.order.map((k) => UP_ALL(I.lv)[k].t), live: (seq) => upHTML(I, seq) }),
      accept: (I, seq) => upCheck(I, seq),
      solve: (I) => UP_REQ(I.lv).map((id) => I.order.findIndex((k) => UP_ALL(I.lv)[k].id === id)),
      bad: (I) => { const ix = (id) => I.order.findIndex((k) => UP_ALL(I.lv)[k].id === id); const req = UP_REQ(I.lv).map(ix); return [[ix("t1"), ...req.slice(2)], [...req.slice(0, -1), ix("t4"), req[req.length - 1]], req.slice().reverse(), req.slice(0, -1)]; },
      hint: (I) => I.lv === 1 ? "Large bytes shouldn't flow through your API servers, and slow work shouldn't happen inside the request." : I.lv === 2 ? "Where does an unscanned file live, and when does it become public?" : "What happens to a message whose processing crashes every time? And can a crash between steps lose the file?",
      concept: "Direct-to-storage uploads and async processing",
      how: "API servers shouldn't proxy large uploads: a presigned URL scoped to one key, size and short expiry lets the client upload straight to object storage (multipart and resumable for big files), keeping gigabytes off your fleet. Processing is slow and failure-prone, so it runs asynchronously from a storage event on a queue, with workers that are idempotent because queues deliver at least once; a message is acknowledged only after the work is recorded. Untrusted files stay in a private bucket until scanned; only clean renditions are copied to the public path. Poison messages go to a dead-letter queue after a few attempts instead of blocking workers forever.",
      rule: "Presigned direct upload → event → queue → idempotent workers that ack last; quarantine until scanned; dead-letter what keeps failing.",
      why: (I) => `At ${I.ups} uploads/s of up to ${K.bytes(I.mb * 1048576)}, proxying through the API would need up to ${K.num((I.ups * I.mb * 8) / 1000, 0)} Gbps of API bandwidth at peak, and synchronous processing would hold requests for minutes. The reference plan keeps bytes on object storage and does the work from a queue with idempotent, ack-after-write workers${I.lv > 1 ? ", publishing only scanned files" : ""}${I.lv === 3 ? ", and dead-letters poison files after 5 attempts" : ""}.`,
    },
    {
      id: "sd-autocomplete",
      name: "Make autocomplete feel instant",
      kind: "Capacity plan",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        return { lv, app: R.pick(APPS), typing: R.pick([50, 100, 200, 400]) * 1000, rtt: 40, slo: lv === 1 ? 200 : lv === 2 ? 150 : 130, fresh: lv === 1 ? 3600 : lv === 2 ? 600 : 120, cjk: lv === 3, idx: { cap: 1500, base: 45, price: 600 }, trie: { cap: 15000, base: 4, price: 300 } };
      },
      text: (I) => `<p>${I.app}'s search box suggests completions as people type. At peak <b>${M(I.typing)}</b> people are typing at ~5 keystrokes/s. Perceived latency = debounce + ${I.rtt} ms network + server p99 (or ≈5 ms when the edge cache answers); it must stay under <b>${I.slo} ms</b>. Trending queries must show up within <b>${I.fresh >= 3600 ? "an hour" : I.fresh / 60 + " minutes"}</b>${I.cjk ? "; for Chinese and Japanese, single characters are meaningful, so suggestions must start at the <b>first character</b>" : ""}.</p>${K.table(["Serving option", "Per node", "Base p99", "Price"], [["query the search index per keystroke", "1,500 req/s", "45 ms", mo(I.idx.price)], ["precomputed top-10 per prefix, in memory", "15,000 req/s", "4 ms", mo(I.trie.price)]], { compact: true })}<p>${I.lv === 1 ? "Clients debounce 150 ms and skip 1-character prefixes; there is no edge cache yet." : `Debounce 0/50/150/300 ms sends 100/90/60/30% of keystrokes; skipping prefixes shorter than 2 or 3 characters drops 15% or 30% more. Edge cache TTL of 1 min / 10 min / 1 h answers 55% / 80% / 90%.`} Find the cheapest setup.</p>`,
      ui: (I) => ({ knobs: [{ k: "serve", label: "Serving", opts: ["search index", "prefix top-k"] }, { k: "deb", label: "Client debounce", opts: [0, 50, 150, 300], unit: "ms", fixed: I.lv === 1 ? 150 : undefined }, { k: "minp", label: "Minimum prefix", opts: [1, 2, 3], unit: "chars", fixed: I.lv < 3 ? 2 : undefined }, ...(I.lv > 1 ? [{ k: "ttl", label: "Edge cache TTL", opts: [0, 60, 600, 3600], fmt: (v) => (v ? (v < 3600 ? v / 60 + " min" : "1 h") : "off") }] : []), { k: "nodes", label: "Nodes", opts: [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192] }], init: { serve: "search index", deb: 0, minp: 1, ttl: 0, nodes: 2 }, live: (cfg) => acHTML(I, cfg) }),
      valid: (I, cfg) => acSim(I, cfg).fail || true,
      val: (I, cfg) => acSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "Compare cost per request of the two serving options, then size nodes for the peak." : I.lv === 2 ? "Debounce costs perceived latency but cuts requests; edge caching cuts requests without latency but bounds freshness." : "Every millisecond of the budget is precious now: which knobs reduce load without adding latency?",
      concept: "Autocomplete: precompute, debounce, cache",
      how: "Autocomplete is a read storm: every keystroke of every typing user is a potential request, and it must feel instant (well under 200 ms end to end). Serving from a precomputed prefix → top-k map in memory is two orders of magnitude cheaper than running a search query per keystroke. Client debounce and a minimum prefix length cut requests but add latency or hurt languages where one character matters. Short prefixes are shared by everyone, so an edge cache with a TTL absorbs most requests; the TTL is bounded by how quickly trending queries must appear.",
      rule: "Precompute top-k per prefix, cache short prefixes at the edge with a TTL set by freshness needs, and spend the remaining latency budget on debounce.",
      why: (I, sol) => { const r = acSim(I, sol); return `Cheapest: ${sol.serve}, debounce ${sol.deb} ms, min prefix ${sol.minp}, edge TTL ${sol.ttl ? sol.ttl + " s" : "off"}, ${sol.nodes} nodes: ${K.num(r.load)} origin req/s at peak, perceived ${K.ms(r.perceived)}, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-leaderboard",
      name: "Serve a global leaderboard",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a monthly cost of",
      vfmt: (x) => mo(x),
      gen(lv, R) {
        return { lv, app: R.pick(APPS), N: lv === 1 ? R.pick([1, 2, 3]) * 1e6 : lv === 2 ? R.pick([20, 40, 60]) * 1e6 : R.pick([400, 500, 600]) * 1e6, upd: lv === 1 ? R.pick([2, 5]) * 1000 : R.pick([20, 30, 40, 60]) * 1000, q: lv === 1 ? R.pick([3, 5, 8]) * 1000 : lv === 2 ? R.pick([200, 300, 400]) * 1000 : R.pick([150, 200, 250]) * 1000, slo: 20, node: R.int(3, 5) * 100, pg: R.int(6, 10) * 100 };
      },
      text: (I) => `<p>${I.app}'s game shows every player their <b>global rank</b>. <b>${M(I.N)}</b> players, <b>${M(I.upd)} score updates/s</b>, <b>${M(I.q)} rank lookups/s</b>; rank p99 must be <b>≤ ${I.slo} ms</b>.</p><ul><li>Postgres (${mo(I.pg)} per node): rank = <code>SELECT count(*) FROM scores WHERE score &gt; $1</code> on an index; the scan visits every higher entry, ~10M index entries/s.</li><li>Redis sorted set: <code>ZADD</code>/<code>ZREVRANK</code> are O(log N); ~110 B per member; a node (${mo(I.node)}) holds <b>24 GB</b> and serves <b>100k ops/s</b>. Replicas can serve rank reads (lag is milliseconds) but also apply every write.</li><li>Sharding by score range: each shard holds a score band (bands set by quantiles); rank = <code>ZCOUNT</code> on the higher shards + <code>ZREVRANK</code> on your own, so a lookup costs about half the shards + 1 ops in total.</li></ul><p>Find the cheapest design.</p>`,
      ui: (I) => ({ knobs: [{ k: "store", label: "Store", opts: ["postgres", "redis sorted set", "redis, score-range shards"] }, { k: "shards", label: "Shards (sharded store only)", opts: [2, 4, 8, 16] }, { k: "reps", label: "Replicas per primary", opts: [0, 1, 2, 3, 4, 6] }], init: { store: "postgres", shards: 2, reps: 0 }, live: (cfg) => lbHTML(I, cfg) }),
      valid: (I, cfg) => lbSim(I, cfg).fail || true,
      val: (I, cfg) => lbSim(I, cfg).cost,
      hint: (I) => I.lv === 1 ? "How many index entries does a rank query visit for a player near the bottom of the table?" : I.lv === 2 ? "Memory fits one node easily. What about ops/s, on the primary and on replicas (which also apply every write)?" : "Memory forces sharding. Then count the ops each shard receives per rank lookup: does adding shards reduce them?",
      concept: "Ranking at scale",
      how: "Counting rows above a score in a B-tree visits every higher entry, so rank queries cost O(rank) and are slow for most players of a large table. A Redis sorted set (skip list + hash) answers rank in O(log N) from memory. When the set outgrows one node, shard by score range rather than by player: each shard knows its band, and a rank is the sum of ZCOUNTs of higher bands plus a local rank. But every lookup now touches about half the shards, so adding shards adds memory but barely any read capacity; read replicas do, though each replica also applies every write.",
      rule: "Use an in-memory ordered structure for ranks; shard by score band only when memory forces it, and scale reads with replicas, since scatter-gather reads don't get cheaper with more shards.",
      why: (I, sol) => { const r = lbSim(I, sol); return `Cheapest: ${sol.store}${sol.store === "redis, score-range shards" ? ` × ${sol.shards} shards` : ""} with ${sol.reps} replica(s) per primary: ${r.nodes} node(s), ${K.num(r.memPer, 1)} GB per shard, busiest node ${M(r.opsMax)} ops/s, ${mo(r.cost)}.`; },
    },
    {
      id: "sd-geo-cells",
      name: "Pick the geohash cell size",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a scan of",
      vfmt: (x) => K.num(x) + " drivers per query",
      gen(lv, R) {
        if (lv === 1) return { lv, city: R.pick(["Valmora", "Port Ellis", "Casterly"]), lat: R.pick([20, 35, 40]), areas: [{ name: "city", d: R.pick([20, 50, 100, 200]), r: R.pick([0.5, 1, 2]), share: 1 }], budget: 2500 };
        if (lv === 2) return { lv, city: R.pick(["Nordvik", "Lahtamo", "Skarsund"]), lat: R.pick([58, 60, 62]), areas: [{ name: "city", d: R.pick([20, 30, 40, 60]), r: R.pick([0.8, 1, 1.2]), share: 1 }], budget: 2000 };
        return { lv, city: R.pick(["Valmora", "Corriva", "Port Ellis"]), lat: R.pick([35, 40, 45]), areas: [{ name: "downtown", d: R.pick([150, 250, 400]), r: R.pick([0.4, 0.5, 0.6]), share: 0.7 }, { name: "suburbs", d: R.pick([2, 4, 6]), r: R.pick([3, 4, 6]), share: 0.3 }], budget: 1500 };
      },
      text: (I) => `<p>The ride-hailing app in <b>${I.city}</b> (latitude ${I.lat}°) indexes available drivers by geohash cell. To find drivers within radius <i>r</i> of a rider, it scans the rider's cell and its neighbours; that ring covers the radius only if the cell's smaller side ≥ <i>r</i> (3×3) or ≥ <i>r</i>/2 (5×5). Each query may scan at most <b>${K.num(I.budget)}</b> drivers.</p>${K.table(["Area", "Drivers per km²", "Search radius"], I.areas.map((a) => [a.name, a.d, a.r + " km"]), { compact: true })}${K.table(["Precision", "Cell at the equator (w × h)", `Width here (× cos ${I.lat}°)`], [4, 5, 6, 7].map((p) => [p, `${GH[p][0]} × ${GH[p][1]} km`, `${K.num(GH[p][0] * Math.cos((I.lat * Math.PI) / 180), 2)} km`]), { compact: true })}<p>Pick the cells that cover the radius while scanning the fewest drivers${I.areas.length > 1 ? " (weighted by query share: 70% downtown, 30% suburbs)" : ""}.</p>`,
      ui: (I) => {
        const knobs = [];
        I.areas.forEach((a, i) => { const pre = I.areas.length > 1 ? a.name + ": " : ""; knobs.push({ k: "p" + i, label: pre + "geohash precision", opts: [4, 5, 6, 7] }, { k: "g" + i, label: pre + "neighbourhood", opts: ["3×3", "5×5"], fixed: I.lv === 1 ? "3×3" : undefined }); });
        return { knobs, init: { p0: 4, g0: "3×3", p1: 4, g1: "3×3" }, live: (cfg) => geoHTML(I, cfg) };
      },
      valid: (I, cfg) => geoSim(I, cfg).fail || true,
      val: (I, cfg) => Math.round(geoSim(I, cfg).scan),
      hint: (I) => I.lv === 1 ? "Smaller cells scan fewer drivers, but the ring of neighbours must still reach the search radius." : I.lv === 2 ? "Far from the equator, geohash cells get narrow. If the 3×3 ring is too small, a bigger ring of smaller cells may beat one ring of huge cells." : "One precision can't suit hundreds of drivers/km² and a handful. Size each area on its own.",
      concept: "Geospatial cell size",
      how: "Geohashes (like S2 cells or H3 hexagons) map locations to cells of fixed precision; a nearby search scans the rider's cell plus a ring of neighbours, so the ring has to reach the search radius and everything inside it is scanned. Cells that are too big scan thousands of irrelevant drivers; cells that are too small need a bigger ring (more cell lookups). Geohash cells are defined in degrees, so their east-west width shrinks with cos(latitude): a precision that works at the equator may not cover the radius in Scandinavia. Real systems pick the resolution per area by density, or widen the ring until enough candidates are found.",
      rule: "Pick the smallest cell whose neighbour ring still covers the search radius at your latitude, and vary resolution with density instead of using one size everywhere.",
      why: (I, sol) => { const r = geoSim(I, sol); return I.areas.map((a, i) => `${a.name}: precision ${sol["p" + i]} with a ${sol["g" + i] || "3×3"} ring scans ${K.num(r.per[i])} drivers (reaches ${K.num(r.cover[i], 2)} km ≥ ${a.r} km)`).join("; ") + "."; },
    },
    {
      id: "sd-ledger-entries",
      name: "Write the ledger entries",
      kind: "Design review",
      skills: ["design", "safe"],
      w: "code",
      gen(lv, R) {
        const amt = R.int(2000, 50000) / 100, fee = R.pick([0.02, 0.025, 0.03]), m = R.pick(["m_4821", "m_1307", "m_9954"]);
        const I = { lv, amt, fee: Math.round(amt * fee * 100) / 100, feePct: fee, m };
        if (lv === 2) I.refund = Math.round(amt * R.pick([0.2, 0.25, 0.4]) * 100) / 100;
        if (lv === 3) { I.rate = R.pick([1.08, 1.1, 1.12]); I.usd = Math.round(amt * I.rate * 100) / 100; I.fee = Math.round(I.usd * fee * 100) / 100; }
        return I;
      },
      text: (I) => `<p>The payments ledger is double-entry: every transaction is a set of entries whose debits equal credits${I.lv === 3 ? " <b>in each currency</b>" : ""}, and balances are never edited, only derived from entries. Accounts: ${ledAccounts(I).map((a) => `<code>${esc(a)}</code>`).join(", ")}.</p>${I.lv === 1 ? `<p>A customer's card payment of <b>$${I.amt.toFixed(2)}</b> to merchant <code>${I.m}</code> is captured as transaction <b>t1</b>. The processor will pay us later (<code>psp_clearing</code> is what it owes us). The platform keeps a <b>${pc(I.feePct)}</b> fee ($${I.fee.toFixed(2)}); the rest is owed to the merchant.</p>` : I.lv === 2 ? `<p>Record three transactions: <b>t1</b> capture of <b>$${I.amt.toFixed(2)}</b> for <code>${I.m}</code> with a ${pc(I.feePct)} platform fee ($${I.fee.toFixed(2)}); <b>t2</b> a partial refund of <b>$${I.refund.toFixed(2)}</b> paid back through the processor, borne by the merchant (the fee is not returned); <b>t3</b> the processor settles what it owes us into <code>bank_cash</code>.</p>` : `<p>Transaction <b>t1</b>: a customer pays <b>€${I.amt.toFixed(2)}</b>; merchant <code>${I.m}</code> is paid in USD. Treasury converts at <b>${I.rate}</b> USD/EUR, giving <b>$${I.usd.toFixed(2)}</b>; the ${pc(I.feePct)} platform fee is taken in USD ($${I.fee.toFixed(2)}). Every entry needs a <code>"ccy"</code>, and each currency must balance on its own: route the conversion through the <code>fx_clearing</code> account in both currencies.</p>`}<p>Write the entries as JSON: <code>{"txn", "account", "dr" | "cr"${I.lv === 3 ? ', "ccy"' : ""}}</code> with positive amounts in currency units. The live panel shows the resulting balances.</p>`,
      ui: (I) => ({ lang: "json", file: "entries.json", rows: 12, starter: `[\n  { "txn": "t1", "account": "psp_clearing", "dr": 0${I.lv === 3 ? ', "ccy": "EUR"' : ""} }\n]`, live: (src) => ledHTML(I, src) }),
      accept: (I, src) => ledCheck(I, src).msg,
      solve: (I) => JSON.stringify(ledSolve(I), null, 1),
      bad: (I) => { const s = ledSolve(I); const one = s.filter((e) => e.account !== "fee_revenue"); const unbal = s.map((e, i) => (i === 0 ? { ...e, dr: r2(e.dr + 1) } : e)); const flip = s.map((e) => (e.dr != null ? { txn: e.txn, account: e.account, cr: e.dr, ccy: e.ccy } : { txn: e.txn, account: e.account, dr: e.cr, ccy: e.ccy })); return [JSON.stringify(one), JSON.stringify(unbal), JSON.stringify(flip)]; },
      hint: (I) => I.lv === 1 ? "Debit what we're now owed (an asset goes up); credit what we owe the merchant and what we earned." : I.lv === 2 ? "A refund reduces both what the processor owes us and what we owe the merchant. Settlement moves money from one asset to another." : "Euros come in and are converted: in EUR, fx_clearing takes the euros; in USD, fx_clearing hands out the dollars.",
      concept: "Double-entry ledgers",
      how: "In a double-entry ledger every movement is recorded as balanced debits and credits across accounts, so money is never created or lost by a bug in one place: the sum over all accounts is always zero, and any balance is a sum over immutable entries. Assets (what we hold or are owed) increase with debits; liabilities and revenue increase with credits. Refunds, fees and settlement are new entries, never edits. Multi-currency ledgers balance per currency and bridge currencies through an FX clearing account whose two legs record the conversion. Entries are written idempotently, keyed by the business event, so a retried payment webhook can't post twice.",
      rule: "Never update a balance: append balanced entries per transaction and currency, derive balances from them, and key each posting by the event ID so retries are idempotent.",
      why: (I) => `Expected balances: ${Object.entries(ledExpected(I)).map(([k, v]) => `<code>${esc(k)}</code> ${v > 0 ? "dr" : "cr"} ${Math.abs(v).toFixed(2)}`).join(", ")}. Every transaction balances, so the whole ledger sums to zero.`,
    },
  ]);

  /* ---------- per-scenario models (hoisted function declarations) ---------- */
  function sdPeak(I) {
    if (I.lv === 1) return (I.dau * I.opens * I.calls / 86400) * I.pf;
    if (I.lv === 2) return (I.dau * I.opens * I.reads / 86400) * I.pf * (1 - I.hit);
    return I.base + (I.push * I.en * I.open * I.calls) / (I.win * 60);
  }
  function sdStore(I) {
    if (I.lv === 1) return (I.posts * I.bytes * 365 * I.repl) / 1e12;
    if (I.lv === 2) return (I.msgs * (I.text + I.meta) * (1 + I.idx) * 365 * I.repl) / 1e12;
    return (I.up * 30 * (I.orig * 1e6 + I.thumbs * 1e3) * (Math.pow(1 + I.g, I.months) - 1) / I.g) / 1e12;
  }
  function sdEgress(I) {
    if (I.lv === 1) return (I.loads * I.imgs * I.kb * 1e3 * 8) / 1e9;
    if (I.lv === 2) return (I.loads * I.imgs * I.kb * 1e3 * 8 * (1 - I.hit)) / 1e9;
    const avg = I.mix[0] * I.rates[0] + I.mix[1] * I.rates[1] + I.mix[2] * I.rates[2];
    return (I.hours * 3600 * avg * 1e6 / 8 * 30 * (1 - I.off)) / 1e12;
  }
  function sdCacheShards(I) {
    const bytes = I.items * I.hot * (I.val + I.key + I.ovh);
    return { mem: need(bytes / (I.ram * 1e9 * I.mm)), ops: need(I.ops / I.perShard) };
  }
  function sdCache(I) {
    if (I.lv === 1) return (I.items * I.hot * I.kb * 1e3) / 1e9;
    if (I.lv === 2) return ((I.items * I.hot * (I.val + I.key + I.ovh)) / I.mm / 1e9) * 2;
    const s = sdCacheShards(I);
    return Math.max(s.mem, s.ops) * 2;
  }
  function sdWs(I) {
    const mem = need((I.conns * I.kb * 1e3) / (I.gb * 1e9));
    const cpu = I.lv > 1 ? need((I.conns * I.msgs / 60) / I.push) : 0;
    const base = Math.max(mem, cpu);
    return { mem, cpu, total: I.lv === 3 ? 3 * (need(base / 2) + 1) : base };
  }
  function sdShards(I) {
    const pow2 = (x) => { let n = 1; while (n < x) n *= 2; return n; };
    const tb = I.lv === 3 ? I.tb + I.addTB * I.months : I.tb;
    const w = I.lv === 3 ? I.wps * Math.pow(1 + I.wg, I.months) : I.wps || 0;
    const disk = need(tb / (I.disk * I.fill)), write = I.lv > 1 ? need(w / I.perShard) : 0;
    const n = I.lv === 1 ? disk : pow2(Math.max(disk, write));
    return { tb, w, disk, write, n };
  }

  /* estimate review: a calculation sheet with injected mistakes (downstream lines stay consistent with them) */
  function estDoc(I) {
    const e = new Set(I.errs), L = [];
    const add = (t, err, why) => L.push({ t, k: " ", err: !!err, why });
    const f = (x, d = 0) => K.num(x, d);
    L.push({ t: `# ${I.app} photo launch: capacity estimate (draft)`, k: "@" });
    const up = I.dau * I.upu;
    add(`DAU                    = ${M(I.dau)}`);
    add(`uploads/day            = DAU × ${I.upu} = ${M(up)}`);
    const secs = e.has("sec") ? 3600 : 86400, avg = up / secs;
    add(`avg upload rate        = ${M(up)} / ${f(secs)} s = ${f(avg)}/s`, e.has("sec"), `a day has 86,400 seconds, not 3,600: the average rate is ${f(up / 86400)}/s, not ${f(avg)}/s.`);
    const peak = avg * I.pf;
    add(`peak upload rate       = avg × ${I.pf} (peak hour) = ${f(peak)}/s`);
    add(`avg photo size         = ${I.size} MB`);
    const MBs = peak * I.size, ing = e.has("bits") ? MBs / 1000 : (MBs * 8) / 1000;
    add(`peak ingest bandwidth  = ${f(peak)}/s × ${I.size} MB = ${f(MBs)} MB/s = ${f(ing, 2)} Gbps`, e.has("bits"), `${f(MBs)} MB/s is ${f((MBs * 8) / 1000, 2)} Gbps: bytes must be multiplied by 8 to get bits.`);
    const tbd = e.has("peakday") ? (peak * 86400 * I.size) / 1e6 : (up * I.size) / 1e6;
    add(e.has("peakday") ? `storage/day            = ${f(peak)}/s × 86,400 s × ${I.size} MB = ${f(tbd, 1)} TB` : `storage/day            = ${M(up)} × ${I.size} MB = ${f(tbd, 1)} TB`, e.has("peakday"), `storage comes from daily volume (${M(up)} uploads), not the peak rate held for 24 hours; that overstates it ${I.pf}×.`);
    const pb = e.has("repl") ? (tbd * 365) / 1000 : (tbd * 365 * 3) / 1000;
    add(e.has("repl") ? `storage/year (3 replicas) = ${f(tbd, 1)} TB × 365 = ${f(pb, 2)} PB` : `storage/year (3 replicas) = ${f(tbd, 1)} TB × 365 × 3 = ${f(pb, 2)} PB`, e.has("repl"), `the label says 3 replicas but the arithmetic never multiplies by 3: ${f(pb * 3, 2)} PB.`);
    const views = I.dau * I.vpu;
    add(`photo views/day        = DAU × ${I.vpu} = ${M(views)}`);
    const vpk = (views / 86400) * I.pf;
    add(`peak view rate         = ${M(views)} / 86,400 × ${I.pf} = ${f(vpk)}/s`);
    const eg = (vpk * I.disp * 8) / 1e6;
    add(`CDN egress             = ${f(vpk)}/s × ${I.disp} KB = ${f(eg, 1)} Gbps`);
    add(`CDN hit ratio          = ${pc(I.hit)}`);
    const org = e.has("hit") ? eg * I.hit : eg * (1 - I.hit);
    add(`origin egress          = ${f(eg, 1)} Gbps × ${pc(e.has("hit") ? I.hit : 1 - I.hit)} = ${f(org, 2)} Gbps`, e.has("hit"), `the origin serves the CDN's misses: × ${pc(1 - I.hit)}, not × ${pc(I.hit)}; ${f(eg * (1 - I.hit), 2)} Gbps.`);
    const srvRate = e.has("avgsrv") ? avg : peak;
    add(`upload API servers     = ${f(srvRate)}/s ÷ ${I.per}/s per server = ${need(srvRate / I.per)} (+1 spare)`, e.has("avgsrv"), `servers must handle the peak (${f(peak)}/s), not the average: ${need(peak / I.per)} + 1.`);
    return { lines: L };
  }

  /* availability chain */
  function chainAvail(I, cfg) {
    const comps = I.comps.map((c, i) => ({ ...c, n: c.fixed ? 1 : cfg["n" + i] || c.need, spread: !I.z || cfg["z" + i] === "3 zones" }));
    const cost = comps.reduce((s, c) => s + (c.fixed ? 0 : c.n * c.cost + (I.z && c.spread ? I.xz : 0)), 0);
    if (!I.z) { const per = comps.map((c) => (c.fixed ? c.a : kofn(c.n, c.need, c.a))); return { per, comps, cost, total: per.reduce((p, x) => p * x, 1) }; }
    let total = 0; const per = comps.map(() => 0);
    for (let s = 0; s < 8; s++) {
      const up = [0, 1, 2].map((z) => (s >> z) & 1), ps = up.reduce((p, u) => p * (u ? I.z : 1 - I.z), 1);
      let prod = 1;
      comps.forEach((c, i) => { let av; if (c.fixed) av = c.a; else { const m = U.range(c.n).filter((j) => up[c.spread ? j % 3 : 0]).length; av = kofn(m, c.need, c.a); } per[i] += ps * av; prod *= av; });
      total += ps * prod;
    }
    return { per, comps, cost, total };
  }
  function chainHTML(I, cfg) {
    const r = chainAvail(I, cfg);
    return K.table(["Component", "Replicas", "Availability", "Cost"], r.comps.map((c, i) => [esc(c.name), c.fixed ? "–" : `${c.n}${I.z ? (c.spread ? " · 3 zones" : " · 1 zone") : ""}`, nines(r.per[i]), c.fixed ? "–" : mo(c.n * c.cost + (I.z && c.spread ? I.xz : 0))]), { compact: true })
      + K.metrics([{ name: "Checkout availability", value: nines(r.total), ok: r.total >= I.target, target: `SLO ${nines(I.target)}` }, { name: "Expected downtime", value: down(r.total), ok: r.total >= I.target, target: `budget ${down(I.target)}` }, { name: "Monthly cost", value: mo(r.cost), ok: null }]);
  }

  /* zone headroom */
  function zoneSim(I, cfg) {
    const ty = I.lv === 1 || cfg.type !== "large" ? I.small : I.large;
    const n = I.lv < 3 ? [cfg.n, cfg.n, cfg.n] : [cfg.nA, cfg.nB, cfg.nC];
    const share = I.share || [1 / 3, 1 / 3, 1 / 3], xz = I.lv < 3 || cfg.xz === "on";
    const cases = [];
    for (const f of [-1, 0, 1, 2]) {
      const live = [0, 1, 2].filter((z) => z !== f), util = [null, null, null];
      if (xz) { const cap = live.reduce((s, z) => s + Math.max(0, n[z] - I.deploy) * ty.cap, 0); live.forEach((z) => (util[z] = cap ? I.peak / cap : Infinity)); }
      else live.forEach((z) => { const load = I.peak * (share[z] + (f >= 0 ? share[f] / 2 : 0)); const cap = Math.max(0, n[z] - I.deploy) * ty.cap; util[z] = cap ? load / cap : Infinity; });
      cases.push({ f, util, worst: Math.max(...util.filter((u) => u != null)) });
    }
    const zc = cases.filter((c) => c.f >= 0).reduce((a, b) => (b.worst > a.worst ? b : a));
    const cost = (n[0] + n[1] + n[2]) * ty.price + (I.lv === 3 && cfg.xz === "on" ? I.xzCost : 0);
    return { cases, worst: zc.worst, worstCase: `zone ${"ABC"[zc.f]} down${I.deploy ? " during a deploy" : ""}`, cost, ty, n };
  }
  // Direct search (the 3-zone knob space is too big to brute-force quickly): per-zone minimums when zones are
  // independent, otherwise the smallest third zone for every pair of the other two.
  function zoneSolve(I) {
    const MAX = 60, ok = (c) => zoneSim(I, c).worst <= I.U + 1e-9;
    let best = null;
    const consider = (c) => { if (ok(c)) { const v = zoneSim(I, c).cost; if (!best || v < best.v) best = { v, c }; } };
    for (const type of I.lv > 1 ? ["small", "large"] : ["small"]) {
      if (I.lv < 3) { for (let n = 1; n <= MAX; n++) { const c = I.lv === 1 ? { n } : { type, n }; if (ok(c)) { consider(c); break; } } continue; }
      // cross-zone off: each zone sized independently
      const per = [0, 1, 2].map((z) => { for (let n = 2; n <= MAX; n++) { const c = { type, xz: "off", nA: MAX, nB: MAX, nC: MAX }; c["n" + "ABC"[z]] = n; const r = zoneSim(I, c); if (r.cases.every((k) => k.util[z] == null || k.util[z] <= I.U + 1e-9)) return n; } return null; });
      if (per.every((n) => n != null)) consider({ type, xz: "off", nA: per[0], nB: per[1], nC: per[2] });
      // cross-zone on: only the total matters and the most balanced split is the strongest; first passing total wins
      for (let T = 6; T <= 3 * MAX; T++) { const q = Math.floor(T / 3), r = T % 3, cfg = { type, xz: "on", nA: q + (r > 0 ? 1 : 0), nB: q + (r > 1 ? 1 : 0), nC: q }; if (ok(cfg)) { consider(cfg); break; } }
    }
    return best ? best.c : null;
  }
  function zoneHTML(I, cfg) {
    const r = zoneSim(I, cfg);
    const cell = (u) => (u == null ? `<span class="muted">down</span>` : `<span class="${u > I.U ? "lose" : ""}">${Number.isFinite(u) ? pc(u) : "∞"}</span>`);
    return K.table(["Scenario", "Zone A", "Zone B", "Zone C"], r.cases.map((c) => [c.f < 0 ? "all zones up" + (I.deploy ? " (deploying)" : "") : `zone ${"ABC"[c.f]} lost${I.deploy ? " + deploy" : ""}`, ...c.util.map(cell)]), { compact: true })
      + K.metrics([{ name: "Worst utilisation", value: Number.isFinite(r.worst) ? pc(r.worst) : "∞", ok: r.worst <= I.U + 1e-9, target: `≤ ${pc(I.U)}` }, { name: "Instances", value: `${r.n.join(" + ")} = ${r.n[0] + r.n[1] + r.n[2]}`, ok: null }, { name: "Monthly cost", value: mo(r.cost), ok: null }]);
  }

  /* URL shortener ids */
  const URL_M = {
    random: { label: "random code + insert-if-absent" },
    "db sequence": { label: "single DB sequence" },
    "counter ranges": { label: "counter ranges leased per server" },
    "hash of URL": { label: "hash(long URL), truncated" },
    "ranges + FPE shuffle": { label: "counter ranges + format-preserving encryption" },
  };
  function urlSim(I, cfg) {
    const m = cfg.m || "random", space = 62 ** cfg.len, fill = I.total / space, fail = [];
    const collides = m === "random" || m === "hash of URL";
    const cap = m === "counter ranges" || m === "ranges + FPE shuffle" ? space * 0.95 : space; // leased blocks lost on crashes waste up to ~5%
    if (collides && fill > 0.001) fail.push(`with ${M(I.total)} links in a ${M(space)} keyspace, ${pc(Math.min(1, fill))} of new random codes would collide (limit 0.1%)`);
    if (!collides && I.total > cap) fail.push(`${M(I.total)} links don't fit in ${M(space)} codes${cap < space ? " (allowing ~5% lost to abandoned blocks)" : ""}`);
    if (m === "db sequence" && I.wps > I.seqMax) fail.push(`one sequence hands out ${K.num(I.seqMax)} IDs/s but peak creation is ${K.num(I.wps)}/s`);
    if (m === "hash of URL") fail.push("the same long URL always hashes to the same code, but each user needs their own");
    if (I.lv === 3 && (m === "db sequence" || m === "counter ranges")) fail.push("sequential codes are enumerable: anyone can walk neighbouring codes to private documents");
    const coord = m === "db sequence" ? I.wps : m === "counter ranges" || m === "ranges + FPE shuffle" ? I.wps / I.block : 0;
    return { fill, fail, coord, collides };
  }
  function urlHTML(I, cfg) {
    const r = urlSim(I, cfg);
    return K.metrics([
      { name: "Keyspace", value: M(62 ** cfg.len), ok: null, target: `62^${cfg.len}` },
      { name: "Fill at end of life", value: r.fill > 1 ? "> 100%" : pc(r.fill), ok: r.collides ? r.fill <= 0.001 : r.fill <= 0.95 },
      { name: r.collides ? "Create retry rate" : "Collisions", value: r.collides ? pc(Math.min(1, r.fill)) : "none", ok: r.collides ? r.fill <= 0.001 : true, target: "< 0.1%" },
      { name: "Coordinator calls", value: `${K.num(r.coord, r.coord < 10 ? 1 : 0)}/s`, ok: cfg.m === "db sequence" ? I.wps <= I.seqMax : true },
    ]) + (r.fail.length ? K.note(r.fail.map(esc).join("<br>"), "bad") : K.note("Meets every requirement.", "good"));
  }

  /* shortener cache */
  function scSim(I, cfg) {
    const k = (cfg.gb * 1e9) / 500, hit = cfg.gb ? Math.min(0.995, Math.log(k) / Math.log(I.links)) : 0;
    const edge = cfg.edge && cfg.edge !== "off" && I.lv > 1, off = edge ? 0.85 : 0, local = cfg.local === "on" && I.lv > 1;
    const reps = I.lv === 3 ? cfg.reps - 1 : cfg.reps;
    let hotMax = 0;
    const day1 = runDay(day(I.peak), (l, i) => {
      const v = I.viral * Math.exp(-(((i / 2 - I.spike) / 0.5) ** 2));
      const origin = (l + v) * (1 - off), hot = cfg.gb ? v * (1 - off) * (local ? 0.02 : 1) : 0;
      hotMax = Math.max(hotMax, hot);
      const hotErr = hot > 100000 ? (hot - 100000) / origin : 0;
      const db = tier(l * (1 - off) * (1 - hit), reps, I.dbCap, 12, { timeout: 1000 });
      const missFrac = origin ? (l * (1 - off) * (1 - hit)) / origin : 0;
      return { p99: 4 + (missFrac > 0.01 ? 1 + db.p99 : 1.5), err: 1 - (1 - db.err) * (1 - hotErr), rho: db.rho };
    });
    const cost = cfg.gb * I.gbPrice + cfg.reps * I.dbPrice + (edge ? I.edgePrice : 0);
    let fail = null;
    if (I.lv === 3 && edge) fail = "edge-cached redirects are answered by the CDN or the browser, so those clicks never reach your servers and go unbilled";
    else if (day1.peakErr > 0.001) fail = `${pc(day1.peakErr)} of requests fail at the worst moment${hotMax > 100000 ? ` (the viral link's Redis shard gets ${K.num(hotMax)} ops/s)` : ""}`;
    else if (day1.worst > I.slo) fail = `p99 reaches ${K.ms(day1.worst)} (SLO ${I.slo} ms)`;
    return { hit, day: day1, cost, fail, hotMax, reps };
  }
  function scHTML(I, cfg) {
    const r = scSim(I, cfg);
    return K.metrics([
      { name: "Cache hit ratio", value: pc(r.hit), ok: null },
      { name: "Replica peak load", value: Number.isFinite(r.day.maxRho) ? pc(r.day.maxRho) : "∞", ok: r.day.maxRho < 0.98, target: I.lv === 3 ? `${r.reps} serving (1 in maintenance)` : "" },
      ...(I.viral ? [{ name: "Viral key shard", value: K.num(r.hotMax) + " ops/s", ok: r.hotMax <= 100000, target: "≤ 100k" }] : []),
      { name: "Worst p99", value: K.ms(r.day.worst), ok: r.day.worst <= I.slo, target: `≤ ${I.slo} ms` },
      { name: "Worst error rate", value: pc(r.day.peakErr), ok: r.day.peakErr <= 0.001, target: "≤ 0.1%" },
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + dayChart(r.day, I.slo) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* feed fan-out */
  const FAN_T = ["pull everyone", "push < 1k", "push < 10k", "push < 100k", "push < 1M", "push everyone"];
  function fanSim(I, cfg) {
    const t = cfg.t, skip = I.ina && cfg.skip === "on" ? 1 - I.ina : 1;
    let push = 0, pulled = 0;
    for (let b = 0; b < 5; b++) { if (b < t) push += I.posts[b] * I.fol[b] * skip; else pulled += I.follows[b]; }
    const cap = cfg.w * 40000, rho = push / cap, p99 = 25 + 3.5 * pulled;
    let burst = 0;
    if (I.burst) { if (t >= 5) burst += I.burst.big * I.fol[4] * skip; if (t >= 4) burst += I.burst.mid * I.fol[3] * skip; }
    const drain = burst ? (rho < 1 ? burst / (cap - push) : Infinity) : 0;
    const readSrv = need((I.reads * (1 + 0.25 * pulled)) / 4000);
    const cost = cfg.w * I.wPrice + readSrv * I.rPrice + (I.ina && cfg.skip === "on" ? I.rebuild : 0);
    let fail = null;
    if (rho > 0.85) fail = `fan-out workers would be ${pc(rho)} busy (${M(push)} inserts/s for ${M(cap)}/s of capacity)`;
    else if (drain > I.lag) fail = `the live-final burst (${M(burst)} inserts) takes ${Number.isFinite(drain) ? K.num(drain, 0) + " s" : "forever"} to drain (limit ${I.lag} s)`;
    else if (p99 > I.slo) fail = `feed p99 is ${K.num(p99)} ms with ${pulled} pulled authors per read (SLO ${I.slo} ms)`;
    return { push, pulled, rho, p99, burst, drain, readSrv, cost, fail };
  }
  function fanHTML(I, cfg) {
    const r = fanSim(I, cfg);
    return K.metrics([
      { name: "Fan-out inserts", value: M(r.push) + "/s", ok: r.rho <= 0.85, target: `workers ${pc(r.rho)} busy` },
      ...(I.burst ? [{ name: "Burst drain time", value: Number.isFinite(r.drain) ? K.num(r.drain, 0) + " s" : "∞", ok: r.drain <= I.lag, target: `≤ ${I.lag} s` }] : []),
      { name: "Feed read p99", value: K.num(r.p99) + " ms", ok: r.p99 <= I.slo, target: `≤ ${I.slo} ms` },
      { name: "Read servers", value: String(r.readSrv), ok: null },
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* presence */
  function presSim(I, cfg) {
    const mode = I.lv > 1 ? cfg.mode : "online friends";
    const rec = { "all friends": I.friends, "online friends": I.friends * I.onl, "subscribed viewers": I.friends * I.sub }[mode];
    const changes = (I.conc * I.ch) / 3600, hb = I.conc / cfg.h;
    const writes = hb + changes, msgs = hb + changes * rec;
    const sCap = cfg.shards * I.shardCap, gCap = cfg.gw * I.gwCap * 0.7, stale = 2 * cfg.h + 5;
    let fail = null;
    if (cfg.h < I.mobileMin) fail = `a ${cfg.h} s heartbeat wakes mobile radios more often than once per ${I.mobileMin} s`;
    else if (stale > I.stale) fail = `offline is detected after ${stale} s (target ${I.stale} s)`;
    else if (writes > sCap) fail = `${M(writes)} presence writes/s exceed ${cfg.shards} shard(s) × ${M(I.shardCap)}`;
    else if (msgs > gCap) fail = `${M(msgs)} gateway messages/s exceed ${cfg.gw} gateways at 70% CPU (${M(gCap)}/s)`;
    return { mode, rec, writes, msgs, stale, sCap, gCap, cost: cfg.shards * I.shardPrice + cfg.gw * I.gwPrice, fail };
  }
  function presHTML(I, cfg) {
    const r = presSim(I, cfg);
    return K.metrics([
      { name: "Offline detected after", value: r.stale + " s", ok: r.stale <= I.stale, target: `≤ ${I.stale} s` },
      { name: "Store writes", value: M(r.writes) + "/s", ok: r.writes <= r.sCap, target: `capacity ${M(r.sCap)}/s` },
      { name: "Gateway messages", value: M(r.msgs) + "/s", ok: r.msgs <= r.gCap, target: `capacity ${M(r.gCap)}/s` },
      { name: "Recipients per change", value: K.num(r.rec, 1), ok: null },
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* notification campaign */
  function notifSim(I, cfg) {
    const e = I.e, att = cfg.att, success = 1 - e ** att, amp = (1 - e ** att) / (1 - e);
    const prefs = I.opt ? cfg.prefs : "filter at enqueue";
    const wf = prefs === "lookup at send" ? 0.5 : prefs === "cached (30 s) at send" ? 0.9 : 1;
    const rate = cfg.workers * I.w * wf, backoff = I.lv === 1 ? "exponential + jitter" : cfg.backoff;
    // transactional pushes share the quota in bursts, so above ~70% of the limit some requests get 429s; how they are retried decides the waste
    const good = rate <= 0.7 * I.L ? rate : Math.min(rate, I.L) * (backoff === "none" ? 0.5 : backoff === "fixed 1 s" ? 0.75 : 0.95);
    const sends = I.N * (1 - I.opt) * amp, minutes = sends / good / 60;
    const dup = I.lv > 1 && att > 1 && cfg.idem !== "on" ? e / 2 : 0;
    let fail = null;
    if (success < 0.999) fail = `only ${K.pct(success, 2)} of devices get it (need 99.9%)`;
    else if (I.opt && prefs === "filter at enqueue") fail = "users who opt out after the campaign is enqueued still get the notification";
    else if (dup > 0.0001) fail = `${pc(dup)} of devices get a duplicate: a retried timeout that had actually been delivered`;
    else if (minutes > I.mins) fail = `the campaign takes ${K.num(minutes, 1)} min (limit ${I.mins})${rate > I.L ? `; workers offer ${K.num(rate)} req/s, over the provider's ${K.num(I.L)}/s limit` : ""}`;
    return { success, amp, rate, good, minutes, dup, cost: cfg.workers * I.price, fail };
  }
  function notifHTML(I, cfg) {
    const r = notifSim(I, cfg);
    return K.metrics([
      { name: "Delivered", value: K.pct(r.success, 3), ok: r.success >= 0.999, target: "≥ 99.9%" },
      { name: "Offered rate", value: K.num(r.rate) + "/s", ok: r.rate <= I.L, target: `limit ${K.num(I.L)}/s` },
      { name: "Accepted sends", value: K.num(r.good) + "/s", ok: null },
      { name: "Campaign time", value: K.num(r.minutes, 1) + " min", ok: r.minutes <= I.mins, target: `≤ ${I.mins} min` },
      ...(I.lv > 1 ? [{ name: "Duplicates", value: pc(r.dup), ok: r.dup <= 0.0001, target: "≤ 0.01%" }] : []),
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* global rate limiter */
  function rlSim(I, cfg) {
    const burst = { "fixed window": 2, "sliding log": 1, "sliding window counter": 1.03, "token bucket": 1.5 }[cfg.algo];
    const per = { "fixed window": 80, "sliding log": 64 * I.limit, "sliding window counter": 160, "token bucket": 100 }[cfg.algo];
    const mem = (per * I.keys) / 1e9;
    let lat = 1, over = 0, cost = 0, fail = null;
    if (cfg.store === "central Redis") { lat = I.regions > 1 ? I.rtt : 1; cost = I.central; }
    else if (cfg.store === "Redis per region + sync") { over = ((I.regions - 1) * cfg.sync) / 1000; const gb = (I.hot * 16 * I.regions * (I.regions - 1) * (1000 / cfg.sync) * 2.592e6) / 1e9; cost = I.regions * I.regional + Math.round(gb * I.gbPrice); }
    else lat = 0;
    const factor = burst * (1 + over);
    if (cfg.store === "per-node memory") fail = "each node only sees its own share: a key whose connections sit on one or two nodes is throttled far below its limit (or, split evenly, overshoots it)";
    else if (mem > I.memGB) fail = `state needs ${K.num(mem, 1)} GB (budget ${I.memGB} GB)`;
    else if (factor > 1 + I.eps + 1e-9) fail = `a key can get ${K.num(factor, 2)}× its limit in a 1-second window (max ${K.num(1 + I.eps, 2)}×)`;
    else if (lat > I.budget) fail = `the limiter adds ${lat} ms to p99 (budget ${I.budget} ms)`;
    return { factor, mem, lat, cost, fail };
  }
  function rlHTML(I, cfg) {
    const r = rlSim(I, cfg);
    return K.metrics([
      { name: "Worst 1-s window", value: K.num(r.factor, 3) + "× limit", ok: r.factor <= 1 + I.eps + 1e-9, target: `≤ ${K.num(1 + I.eps, 2)}×` },
      { name: "Limiter state", value: K.num(r.mem, 2) + " GB", ok: r.mem <= I.memGB, target: `≤ ${I.memGB} GB` },
      { name: "Added p99", value: r.lat + " ms", ok: r.lat <= I.budget, target: `≤ ${I.budget} ms` },
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : K.note("Meets every requirement.", "good"));
  }

  /* upload pipeline */
  const UP_STEPS = [
    { id: "a", t: "API returns a presigned PUT URL for one object key (size limit, content type, 15-minute expiry)" },
    { id: "b", t: "Client uploads directly to object storage (multipart, resumable)" },
    { id: "c", t: "Storage publishes an object-created event to a queue" },
    { id: "g", t: "Worker scans the file for malware while it sits in the private upload bucket", lv: 2 },
    { id: "d", t: "Worker generates renditions and thumbnails" },
    { id: "h", t: "Worker copies the clean renditions to the public CDN bucket", lv: 2 },
    { id: "e", t: "Worker upserts the media row as ready (keyed by object key + version), then acks the message" },
    { id: "f", t: "Notify the client (WebSocket or push) that the video is ready" },
    { id: "i", t: "After 5 failed attempts, move the message to a dead-letter queue and mark the upload failed", lv: 3 },
    { id: "t1", t: "Client POSTs the file to the API, which streams it to object storage", trap: "proxying uploads puts every byte through the API fleet" },
    { id: "t2", t: "API transcodes the video before responding 201 Created", trap: "processing takes minutes; the request would time out and hold a server thread the whole time" },
    { id: "t3", t: "Make the upload bucket public-read so clients can preview immediately", trap: "unscanned, untrusted files become publicly reachable", lv: 2 },
    { id: "t4", t: "Worker acks the queue message before processing, so a crash can't cause duplicates", trap: "a worker crash after the ack loses the upload forever; make processing idempotent instead" },
    { id: "t5", t: "Retry failed messages immediately and forever until they succeed", trap: "a corrupt file crashes the transcoder every time and blocks workers forever", lv: 3 },
  ];
  const UP_ALL = (lv) => UP_STEPS.filter((s) => !s.lv || s.lv <= lv);
  const UP_REQ = (lv) => (lv === 1 ? ["a", "b", "c", "d", "e", "f"] : lv === 2 ? ["a", "b", "c", "g", "d", "h", "e", "f"] : ["a", "b", "c", "g", "d", "h", "e", "f", "i"]);
  const UP_ORDER = { 1: [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"], ["e", "f"]], 2: [["a", "b"], ["b", "c"], ["c", "g"], ["c", "d"], ["g", "h"], ["d", "h"], ["h", "e"], ["e", "f"]] };
  function upCheck(I, seq) {
    const all = UP_ALL(I.lv), ids = seq.map((k) => all[I.order[k]].id), pos = (id) => ids.indexOf(id);
    const trap = ids.map((id) => all.find((s) => s.id === id)).find((s) => s.trap);
    if (trap) return `<b>${esc(trap.t)}</b>: ${esc(trap.trap)}.`;
    const missing = UP_REQ(I.lv).filter((id) => pos(id) < 0);
    if (missing.length) return `The plan is missing ${missing.length === 1 ? "a required step" : missing.length + " required steps"}${missing.includes("i") ? " (what happens to a file that fails every time?)" : ""}.`;
    for (const [a, b] of UP_ORDER[Math.min(2, I.lv)]) if (pos(a) > pos(b)) return `Order problem: <b>${esc(all.find((s) => s.id === b).t)}</b> can't happen before <b>${esc(all.find((s) => s.id === a).t)}</b>.`;
    if (I.lv === 3 && pos("i") < pos("c")) return "The dead-letter policy applies to queue messages, so it belongs after the queue exists.";
    return true;
  }
  function upHTML(I, seq) {
    if (!seq || !seq.length) return "";
    const all = UP_ALL(I.lv), ids = seq.map((k) => all[I.order[k]].id), has = (id) => ids.includes(id);
    const apiGbps = has("t1") ? (I.ups * I.mb * 8) / 1000 : 0.01;
    return K.metrics([
      { name: "API bandwidth at peak", value: K.num(apiGbps, apiGbps < 1 ? 2 : 0) + " Gbps", ok: !has("t1") },
      { name: "Upload request time", value: has("t2") ? "minutes" : "< 1 s", ok: !has("t2") },
      { name: "Unscanned files public", value: has("t3") || (I.lv > 1 && has("h") && !has("g")) ? "yes" : "no", ok: !(has("t3") || (I.lv > 1 && has("h") && !has("g"))) },
      { name: "Lost on worker crash", value: has("t4") ? "yes" : "no", ok: !has("t4") },
      ...(I.lv === 3 ? [{ name: "Poison files", value: has("t5") ? "block workers forever" : has("i") ? "dead-lettered" : "retried forever", ok: has("i") && !has("t5") }] : []),
    ]);
  }

  /* autocomplete */
  function acSim(I, cfg) {
    const sv = cfg.serve === "prefix top-k" ? I.trie : I.idx;
    const ttl = I.lv > 1 ? cfg.ttl || 0 : 0, df = { 0: 1, 50: 0.9, 150: 0.6, 300: 0.3 }[cfg.deb], pf = { 1: 1, 2: 0.85, 3: 0.7 }[cfg.minp], hit = { 0: 0, 60: 0.55, 600: 0.8, 3600: 0.9 }[ttl];
    const load = I.typing * 5 * df * pf * (1 - hit);
    const d = runDay(day(load), (l) => tier(l, cfg.nodes, sv.cap, sv.base, { timeout: 1000 }));
    const perceived = cfg.deb + I.rtt + (1 - hit >= 0.01 ? d.worst : 5);
    let fail = null;
    if (I.cjk && cfg.minp > 1) fail = "single-character queries get no suggestions, which breaks Chinese and Japanese search";
    else if (ttl > I.fresh) fail = `a ${ttl / 60}-minute edge TTL hides new trending queries for too long`;
    else if (d.peakErr > 0.001) fail = `the nodes saturate at peak: ${pc(d.peakErr)} of requests fail`;
    else if (perceived > I.slo) fail = `perceived latency is ${K.ms(perceived)} (target ${I.slo} ms)`;
    return { load, d, perceived, cost: cfg.nodes * sv.price, fail };
  }
  function acHTML(I, cfg) {
    const r = acSim(I, cfg);
    return K.metrics([
      { name: "Origin requests at peak", value: K.num(r.load) + "/s", ok: null },
      { name: "Node utilisation", value: Number.isFinite(r.d.maxRho) ? pc(Math.min(r.d.maxRho, 9.99)) : "∞", ok: r.d.maxRho < 0.98 },
      { name: "Perceived latency", value: K.ms(r.perceived), ok: r.perceived <= I.slo, target: `≤ ${I.slo} ms` },
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* leaderboard */
  function lbSim(I, cfg) {
    let fail = null, nodes, cost, p99, memPer = 0, opsMax = 0;
    if (cfg.store === "postgres") {
      nodes = 1 + cfg.reps; cost = nodes * I.pg; p99 = (I.N / 1e7) * 1000;
      fail = `a player near the bottom makes the count visit ~${M(I.N)} index entries: p99 ≈ ${K.ms(p99)} (SLO ${I.slo} ms)`;
    } else {
      const s = cfg.store === "redis sorted set" ? 1 : cfg.shards;
      memPer = (I.N * 110) / 1e9 / s;
      const reads = s === 1 ? I.q : (I.q * (s / 2 + 1)) / s, writes = I.upd / s;
      const prim = writes + (cfg.reps ? 0 : reads), rep = cfg.reps ? reads / cfg.reps + writes : 0;
      opsMax = Math.max(prim, rep); nodes = s * (1 + cfg.reps); cost = nodes * I.node; p99 = s === 1 ? 1.5 : 3;
      if (memPer > 24) fail = `each shard needs ${K.num(memPer, 1)} GB (a node holds 24 GB)`;
      else if (opsMax > 100000) fail = `the busiest node gets ${M(opsMax)} ops/s (max 100k)`;
    }
    return { nodes, cost, p99, memPer, opsMax, fail };
  }
  function lbHTML(I, cfg) {
    const r = lbSim(I, cfg);
    return K.metrics([
      { name: "Rank p99", value: K.ms(r.p99), ok: r.p99 <= I.slo, target: `≤ ${I.slo} ms` },
      { name: "Memory per shard", value: cfg.store === "postgres" ? "on disk" : K.num(r.memPer, 1) + " GB", ok: cfg.store === "postgres" ? null : r.memPer <= 24, target: "≤ 24 GB" },
      { name: "Busiest node", value: cfg.store === "postgres" ? "–" : M(r.opsMax) + " ops/s", ok: cfg.store === "postgres" ? null : r.opsMax <= 100000, target: "≤ 100k" },
      { name: "Nodes", value: String(r.nodes), ok: null },
      { name: "Monthly cost", value: mo(r.cost), ok: null },
    ]) + (r.fail ? K.note(esc(r.fail), "bad") : "");
  }

  /* geohash cells */
  const GH = { 4: [39.1, 19.5], 5: [4.89, 4.89], 6: [1.22, 0.61], 7: [0.153, 0.153] };
  function geoSim(I, cfg) {
    const c = Math.cos((I.lat * Math.PI) / 180), per = [], cover = [];
    let fail = null, scan = 0;
    I.areas.forEach((a, i) => {
      const p = cfg["p" + i], g = I.lv === 1 ? "3×3" : cfg["g" + i] || "3×3", w = GH[p][0] * c, h = GH[p][1];
      const cv = (g === "3×3" ? 1 : 2) * Math.min(w, h), sc = (g === "3×3" ? 9 : 25) * w * h * a.d;
      per.push(Math.round(sc)); cover.push(cv); scan += a.share * sc;
      if (!fail && cv < a.r - 1e-9) fail = `${a.name}: a ${g} ring of precision-${p} cells reaches only ${K.num(cv, 2)} km (radius ${a.r} km)`;
      else if (!fail && sc > I.budget) fail = `${a.name}: each query scans ${K.num(sc)} drivers (max ${K.num(I.budget)})`;
    });
    return { per, cover, scan, fail };
  }
  function geoHTML(I, cfg) {
    const r = geoSim(I, cfg);
    return K.table(["Area", "Covers", "Drivers scanned"], I.areas.map((a, i) => [a.name, `<span class="${r.cover[i] < a.r - 1e-9 ? "lose" : ""}">${K.num(r.cover[i], 2)} km</span> (need ${a.r})`, `<span class="${r.per[i] > I.budget ? "lose" : ""}">${K.num(r.per[i])}</span>`]), { compact: true }) + (r.fail ? K.note(esc(r.fail), "bad") : K.note(`Weighted scan: ${K.num(r.scan)} drivers per query.`, "good"));
  }

  /* ledger */
  const r2 = (x) => Math.round(x * 100) / 100;
  function ledAccounts(I) {
    const mp = "merchant_payable:" + I.m;
    return I.lv === 1 ? ["psp_clearing", mp, "fee_revenue"] : I.lv === 2 ? ["psp_clearing", "bank_cash", mp, "fee_revenue"] : ["psp_clearing", "fx_clearing", mp, "fee_revenue"];
  }
  function ledSolve(I) {
    const mp = "merchant_payable:" + I.m;
    if (I.lv === 3) return [
      { txn: "t1", account: "psp_clearing", dr: I.amt, ccy: "EUR" }, { txn: "t1", account: "fx_clearing", cr: I.amt, ccy: "EUR" },
      { txn: "t1", account: "fx_clearing", dr: I.usd, ccy: "USD" }, { txn: "t1", account: mp, cr: r2(I.usd - I.fee), ccy: "USD" }, { txn: "t1", account: "fee_revenue", cr: I.fee, ccy: "USD" },
    ];
    const out = [{ txn: "t1", account: "psp_clearing", dr: I.amt }, { txn: "t1", account: mp, cr: r2(I.amt - I.fee) }, { txn: "t1", account: "fee_revenue", cr: I.fee }];
    if (I.lv === 2) out.push({ txn: "t2", account: mp, dr: I.refund }, { txn: "t2", account: "psp_clearing", cr: I.refund }, { txn: "t3", account: "bank_cash", dr: r2(I.amt - I.refund) }, { txn: "t3", account: "psp_clearing", cr: r2(I.amt - I.refund) });
    return out;
  }
  const ledKey = (I, e) => (I.lv === 3 ? `${e.account} (${e.ccy})` : e.account);
  function ledNets(I, list) { const n = {}; list.forEach((e) => { const k = ledKey(I, e); n[k] = r2((n[k] || 0) + (e.dr || 0) - (e.cr || 0)); }); return n; }
  function ledExpected(I) { const n = ledNets(I, ledSolve(I)); Object.keys(n).forEach((k) => { if (Math.abs(n[k]) < 0.005) delete n[k]; }); return n; }
  function ledCheck(I, src) {
    const p = K.json(src || "");
    if (!p.ok) return { msg: "That isn't valid JSON: " + esc(p.err) };
    if (!Array.isArray(p.val) || !p.val.length) return { msg: "Write a JSON array of entries." };
    const acc = ledAccounts(I), list = p.val;
    for (const e of list) {
      if (!e || typeof e !== "object" || typeof e.txn !== "string") return { msg: 'Every entry needs a "txn" string.' };
      if (!acc.includes(e.account)) return { msg: `Unknown account <code>${esc(String(e.account))}</code>.` };
      const has = (e.dr != null) + (e.cr != null);
      if (has !== 1) return { msg: 'Each entry has exactly one of "dr" or "cr".' };
      const v = e.dr != null ? e.dr : e.cr;
      if (typeof v !== "number" || !(v > 0) || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return { msg: "Amounts are positive numbers with at most 2 decimals." };
      if (I.lv === 3 && !["EUR", "USD"].includes(e.ccy)) return { msg: 'Every entry needs "ccy": "EUR" or "USD".' };
    }
    const bal = {};
    list.forEach((e) => { const k = e.txn + (I.lv === 3 ? " " + e.ccy : ""); bal[k] = r2((bal[k] || 0) + (e.dr || 0) - (e.cr || 0)); });
    const unb = Object.keys(bal).find((k) => Math.abs(bal[k]) >= 0.005);
    if (unb) return { msg: `Transaction <code>${esc(unb)}</code> doesn't balance: debits − credits = ${bal[unb].toFixed(2)}.`, bal };
    const got = ledNets(I, list), want = ledExpected(I);
    const keys = [...new Set([...Object.keys(got), ...Object.keys(want)])];
    const wrong = keys.find((k) => Math.abs((got[k] || 0) - (want[k] || 0)) >= 0.005);
    if (wrong) return { msg: `Everything balances, but <code>${esc(wrong)}</code> ends at ${(got[wrong] || 0) >= 0 ? "dr" : "cr"} ${Math.abs(got[wrong] || 0).toFixed(2)}, which isn't what this business event means. Recheck which side each account moves on.`, bal };
    return { msg: true, bal };
  }
  function ledHTML(I, src) {
    const p = K.json(src || "");
    if (!p.ok || !Array.isArray(p.val)) return `<p class="muted small">${p.ok ? "Write a JSON array." : "JSON: " + esc(p.err)}</p>`;
    const n = {}, bal = {};
    p.val.forEach((e) => { if (!e || typeof e !== "object") return; const k = ledKey(I, e), v = (+e.dr || 0) - (+e.cr || 0); n[k] = r2((n[k] || 0) + v); const t = String(e.txn) + (I.lv === 3 ? " " + e.ccy : ""); bal[t] = r2((bal[t] || 0) + v); });
    return K.table(["Account", "Balance"], Object.keys(n).map((k) => [`<code>${esc(k)}</code>`, n[k] === 0 ? "0.00" : `${n[k] > 0 ? "dr" : "cr"} ${Math.abs(n[k]).toFixed(2)}`]), { compact: true })
      + K.metrics(Object.keys(bal).map((t) => ({ name: "txn " + esc(t), value: Math.abs(bal[t]) < 0.005 ? "balanced" : `off by ${bal[t].toFixed(2)}`, ok: Math.abs(bal[t]) < 0.005 })));
  }
})();
