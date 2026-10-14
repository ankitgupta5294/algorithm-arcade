/* Systems Lab · Distributed systems (part 1): quorums, linearizability, Raft, fencing, leases, hashing, 2PC/sagas, failure handling. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const rng = (s) => D.campaign.rng(s);
  const maj = (n) => Math.floor(n / 2) + 1;

  /* ---------- shared: lane-schedule simulator for interleave scenarios ----------
     M = { init, lanes: [{ name, steps: [text], ops: [fn(st) -> note] }], broken(st) -> bool, verdict(st) -> html } */
  function runLanes(M, seq) {
    const st = K.clone(M.init), pos = M.lanes.map(() => 0), log = [];
    for (const l of seq || []) {
      const i = pos[l]++;
      if (i >= M.lanes[l].steps.length) continue;
      const note = M.lanes[l].ops[i](st) || "";
      log.push({ t: l, label: M.lanes[l].steps[i], note, err: /^!/.test(note) });
    }
    const total = M.lanes.reduce((s, x) => s + x.steps.length, 0);
    return { st, log, complete: (seq || []).length === total };
  }
  const laneTrace = (M, r) => r.log.length ? K.table(["#", ...M.lanes.map((l) => esc(l.name))], r.log.map((e, k) => [String(k + 1), ...M.lanes.map((_, j) => (j === e.t ? `<span class="mono small">${esc(e.label)}</span>${e.note ? `<br><small class="${e.err ? "lose" : "muted"}">${esc(e.note.replace(/^!/, ""))}</small>` : ""}` : ""))]), { compact: true }) : `<p class="muted small">Schedule steps to see what each component observes.</p>`;
  const seqOf = (M, order) => order; // explicit schedules are written as lane-index arrays
  const sequential = (M, order) => order.flatMap((l) => M.lanes[l].steps.map(() => l));
  // Build interleave scenario fields from a model factory.
  const laneScenario = (model) => ({
    w: "interleave",
    ui: (I) => { const M = model(I); return { lanes: M.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = runLanes(M, seq || []); return laneTrace(M, r) + (r.complete ? K.verdict(M.broken(r.st), M.verdict(r.st)) : ""); } }; },
    accept(I, seq) { const M = model(I); const r = runLanes(M, seq); if (!r.complete) return "Schedule every step."; return M.broken(r.st) ? true : `Nothing went wrong in that schedule: ${M.verdict(r.st)}.`; },
    solve(I) { const M = model(I); return M.solve; },
    bad(I) { const M = model(I); return M.bad || [sequential(M, M.lanes.map((_, k) => k))]; },
  });
  void seqOf;

  /* ---------- shared: Raft election rules ---------- */
  const lastT = (log) => (log.length ? log[log.length - 1] : 0);
  const atLeastAsUpToDate = (a, b) => lastT(a) > lastT(b) || (lastT(a) === lastT(b) && a.length >= b.length);
  // Can candidate c win? voters = nodes in c's connected group (alive) whose log c is at least as up to date as.
  function canWin(c, nodes, n) {
    const me = nodes[c];
    if (!me.alive || me.isolated) return false;
    const votes = nodes.filter((x) => x.alive && !x.isolated && atLeastAsUpToDate(me.log, x.log)).length;
    return votes >= maj(n);
  }
  const logTable = (nodes) => {
    const mx = Math.max(...nodes.map((x) => x.log.length));
    return K.table(["node", ...U.range(mx).map((i) => String(i + 1)), "status"], nodes.map((x) => [`<b>${esc(x.name)}</b>`, ...U.range(mx).map((i) => (x.log[i] != null ? `<span class="mono">${x.log[i]}</span>` : `<span class="muted">·</span>`)), x.alive ? (x.isolated ? "partitioned away" : x.note || "up") : "<b>crashed</b>"]), { compact: true });
  };

  /* ---------- quorum simulation (scenario 1) ---------- */
  function quorumSim(I, cut) {
    const cs = new Set(cut || []);
    const reachA = (i) => !cs.has(2 * i), reachB = (i) => !cs.has(2 * i + 1);
    const ws = U.range(I.N).filter(reachA);
    const hinted = [];
    if (I.F && ws.length < I.W) for (let f = I.N; f < I.N + I.F; f++) if (reachA(f) && ws.length + hinted.length < I.W) hinted.push(f);
    const wOk = ws.length + hinted.length >= I.W;
    const rs = I.prefB.filter(reachB).slice(0, I.R);
    const rOk = rs.length === I.R;
    const stale = wOk && rOk && rs.every((i) => !ws.includes(i));
    return { ws, hinted, wOk, rs, rOk, stale };
  }
  const qName = (I, i) => (i < I.N ? I.names[i] : "fallback-" + (i - I.N + 1));

  /* ---------- quorum latency model (scenario 2) ---------- */
  function quorumCfg(I, cfg) {
    let lats, regionOf, N;
    if (I.lv < 3) { N = cfg.N; lats = I.lat.slice(0, N); regionOf = null; }
    else { N = cfg.e + cfg.w + cfg.u; lats = [...Array(cfg.e).fill(1), ...Array(cfg.w).fill(I.west), ...Array(cfg.u).fill(I.eu)]; regionOf = [...Array(cfg.e).fill(0), ...Array(cfg.w).fill(1), ...Array(cfg.u).fill(2)]; }
    const s = lats.slice().sort((a, b) => a - b);
    const R = cfg.R, W = cfg.W;
    const kth = (k) => (k >= 1 && k <= s.length ? s[k - 1] : Infinity);
    const lat = I.rshare * kth(R) + (1 - I.rshare) * kth(W);
    const errs = [];
    if (R > N || W > N) errs.push(`R and W can't exceed N = ${N}`);
    if (R + W <= N) errs.push(`R + W = ${R + W} ≤ N = ${N}: a read quorum can miss the latest write quorum entirely`);
    if (I.lv < 3) {
      if (N - I.fr < R) errs.push(`with ${I.fr} replica${I.fr > 1 ? "s" : ""} down only ${N - I.fr} answer, fewer than R = ${R}: reads fail`);
      if (N - I.fw < W) errs.push(`with ${I.fw} replica${I.fw > 1 ? "s" : ""} down only ${N - I.fw} answer, fewer than W = ${W}: writes fail`);
    } else {
      [cfg.e, cfg.w, cfg.u].forEach((c, k) => { if (c && N - c < Math.max(R, W)) errs.push(`losing ${I.regions[k]} leaves ${N - c} replicas, fewer than ${R >= W ? "R" : "W"} = ${Math.max(R, W)}`); });
    }
    return { N, lat, errs, rl: kth(R), wl: kth(W), regionOf };
  }

  /* ---------- linearizability checker (register, initial value 0) ---------- */
  function linearizable(ops) {
    const n = ops.length, memo = new Set();
    const go = (mask, val) => {
      if (mask === (1 << n) - 1) return true;
      const key = mask + ":" + val;
      if (memo.has(key)) return false;
      memo.add(key);
      // earliest end among pending ops: any op that starts after it can't go next
      let minEnd = Infinity;
      for (let i = 0; i < n; i++) if (!(mask >> i & 1)) minEnd = Math.min(minEnd, ops[i].e);
      for (let i = 0; i < n; i++) {
        if (mask >> i & 1) continue;
        const o = ops[i];
        if (o.s > minEnd) continue;
        if (o.k === "r" && o.v !== val) continue;
        if (go(mask | (1 << i), o.k === "w" ? o.v : val)) return true;
      }
      return false;
    };
    return go(0, 0);
  }
  function timelineSVG(ops, clients) {
    const tmax = Math.max(...ops.map((o) => o.e)) + 5, W = 560, lh = 34, H = 22 + clients.length * lh;
    const X = (t) => 70 + (t / tmax) * (W - 80);
    const rows = clients.map((c, k) => `<text x="4" y="${26 + k * lh}" font-size="12" fill="currentColor">${esc(c)}</text><line x1="70" x2="${W - 10}" y1="${22 + k * lh}" y2="${22 + k * lh}" stroke="currentColor" stroke-opacity=".15"/>`).join("");
    const bars = ops.map((o) => { const y = 12 + clients.indexOf(o.c) * lh; return `<rect x="${X(o.s)}" y="${y}" width="${Math.max(6, X(o.e) - X(o.s))}" height="20" rx="4" fill="${o.k === "w" ? "#1c7ed6" : "#2f9e44"}" fill-opacity=".22" stroke="currentColor" stroke-opacity=".5"/><text x="${X(o.s) + 3}" y="${y + 14}" font-size="10" fill="currentColor">${esc(o.id)}${o.k === "w" ? " w(" + o.v + ")" : "→" + o.v}</text>`; }).join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<text x="${X(f * tmax)}" y="${H - 1}" font-size="10" fill="currentColor" fill-opacity=".6" text-anchor="middle">${Math.round(f * tmax)} ms</text>`).join("");
    return `<figure class="lab-chart"><svg viewBox="0 0 ${W} ${H + 12}" role="img" aria-label="Operation history timeline">${rows}${bars}${ticks}</svg></figure>`;
  }

  /* ---------- causal / session models (scenario 4) ---------- */
  function causalModel(I) {
    if (I.kind === "ryw") {
      return {
        init: { primary: I.old, replica: I.old, saw: null },
        lanes: [
          { name: `${I.user} (browser)`, steps: [`PUT /me display_name="${I.nu}" → primary (200 OK)`, "GET /me → read replica"], ops: [(s) => { s.primary = I.nu; return "primary now has the new name"; }, (s) => { s.saw = s.replica; return (s.replica === I.nu ? "" : "!") + `page shows "${s.replica}"`; }] },
          { name: "WAL replay on replica", steps: ["replica replays WAL up to the primary's current LSN"], ops: [(s) => { s.replica = s.primary; return `replica has "${s.replica}"`; }] },
        ],
        broken: (s) => s.saw !== I.nu,
        verdict: (s) => `${esc(I.user)} saved "${esc(I.nu)}" and then saw "${esc(s.saw)}"`,
        solve: [0, 0, 1],
        bad: [[0, 1, 0]],
      };
    }
    if (I.kind === "mono") {
      return {
        init: { primary: I.old, r1: I.old, r2: I.old, saw: [] },
        lanes: [
          { name: "price service", steps: [`UPDATE price = ${I.nu} (primary)`], ops: [(s) => { s.primary = I.nu; return "committed on primary"; }] },
          { name: "replica-1", steps: ["replays WAL"], ops: [(s) => { s.r1 = s.primary; return "replica-1 has " + s.r1; }] },
          { name: "replica-2", steps: ["replays WAL"], ops: [(s) => { s.r2 = s.primary; return "replica-2 has " + s.r2; }] },
          { name: `shopper (${I.user})`, steps: ["GET /item → LB → replica-1", "refresh → LB → replica-2"], ops: [(s) => { s.saw.push(s.r1); return "sees " + s.r1; }, (s) => { s.saw.push(s.r2); return (s.saw[0] === I.nu && s.r2 !== I.nu ? "!" : "") + "sees " + s.r2; }] },
        ],
        broken: (s) => s.saw[0] === I.nu && s.saw[1] !== I.nu,
        verdict: (s) => `the shopper saw ${s.saw.join(" then ")}`,
        solve: [0, 1, 3, 3, 2],
        bad: [[0, 1, 2, 3, 3], [3, 3, 0, 1, 2], [0, 2, 3, 3, 1]],
      };
    }
    // causal: reply visible before the post it answers
    return {
      init: { s1: false, s2: false, eu1: false, eu2: false, bobSaw: false, carol: null },
      lanes: [
        { name: I.a, steps: [`post "${I.post}" (shard-1, us-east)`], ops: [(s) => { s.s1 = true; return "stored on shard-1 primary"; }] },
        { name: I.b, steps: ["read thread (us-east)", "post reply (shard-2), only if the post was there"], ops: [(s) => { s.bobSaw = s.s1; return s.s1 ? "sees the post" : "thread is empty"; }, (s) => { if (!s.bobSaw) return "nothing to reply to"; s.s2 = true; return "reply stored on shard-2 primary"; }] },
        { name: "shard-1 → eu", steps: ["ship shard-1 changes to eu replica"], ops: [(s) => { s.eu1 = s.s1; return s.eu1 ? "eu has the post" : "nothing to ship"; }] },
        { name: "shard-2 → eu", steps: ["ship shard-2 changes to eu replica"], ops: [(s) => { s.eu2 = s.s2; return s.eu2 ? "eu has the reply" : "nothing to ship"; }] },
        { name: `${I.c} (eu)`, steps: ["read thread from eu replicas"], ops: [(s) => { s.carol = { post: s.eu1, reply: s.eu2 }; return (s.eu2 && !s.eu1 ? "!" : "") + `sees ${s.eu1 ? "the post" : "no post"} and ${s.eu2 ? "the reply" : "no reply"}`; }] },
      ],
      broken: (s) => !!(s.carol && s.carol.reply && !s.carol.post),
      verdict: (s) => s.carol ? `${esc(I.c)} saw ${s.carol.post ? "the post" : "no post"} and ${s.carol.reply ? "a reply" : "no reply"}` : "",
      solve: [0, 1, 1, 3, 4, 2],
      bad: [[0, 1, 1, 2, 3, 4], [0, 1, 1, 3, 2, 4]],
    };
  }

  LB.addAll("dist", [
    /* 1 */ {
      id: "dist-quorum-stale-read",
      name: "Make the quorum read stale",
      kind: "Experiment",
      skills: ["diagnose", "design"],
      w: "topo",
      sense: "min",
      vname: "links cut:",
      gen(lv, R) {
        const cfg = lv === 1 ? { N: 3, W: 1, R: 1, F: 0 } : lv === 2 ? { N: 5, W: 3, R: 2, F: 0 } : { N: 3, W: 2, R: 2, F: 2 };
        const names = R.sample(["db-a", "db-b", "db-c", "db-d", "db-e", "db-f", "db-g"], cfg.N).sort();
        return { lv, ...cfg, names, prefB: R.shuffle(U.range(cfg.N)), key: R.pick(["cart:8812", "user:4410:email", "flag:checkout_v2", "inv:sku-118"]) };
      },
      text: (I) => `<p>A Dynamo-style store keeps <code>${esc(I.key)}</code> on <b>N = ${I.N}</b> replicas with <b>W = ${I.W}</b>, <b>R = ${I.R}</b>${I.F ? ` and <b>sloppy quorums</b>: if fewer than W home replicas are reachable, the write is accepted by fallback nodes that keep a hint for the missing replica` : ""}. Client A writes v2 to every replica it can reach and succeeds once W acknowledge. Client B then reads, querying home replicas in its preference order <b>${I.prefB.map((i) => esc(I.names[i])).join(" → ")}</b> and taking the first R that answer.</p>
        <p><b>Cut the fewest network links</b> so that A's write <b>succeeds</b>, B's read <b>succeeds</b>, and B still gets the old value.</p>`,
      ui: (I) => {
        const M = I.N + I.F;
        const nodes = [{ label: "client A", sub: "writes v2", x: 80, y: 150, fixed: true }, { label: "client B", sub: "reads", x: 560, y: 150, fixed: true }];
        U.range(M).forEach((i) => nodes.push({ label: qName(I, i), sub: i < I.N ? "home replica" : "fallback", x: 320, y: Math.round(30 + (240 * (i + 0.5)) / M), cls: i < I.N ? "" : "muted" }));
        const links = U.range(M).flatMap((i) => [[0, 2 + i], [1, 2 + i]]);
        return { nodes, links, mode: "links", linkVerb: "cut", H: 300, live: (a) => {
          const r = quorumSim(I, a && a.cut);
          const rows = U.range(M).map((i) => [esc(qName(I, i)), r.ws.includes(i) ? "<b>v2</b>" : r.hinted.includes(i) ? "v2 (hint)" : "v1", r.rs.includes(i) ? "read by B" : ""]);
          return K.table(["replica", "holds", "B's read"], rows, { compact: true }) + K.metrics([
            { name: "A's write", value: r.wOk ? `ok (${r.ws.length + r.hinted.length} acks)` : "fails", ok: r.wOk, target: `needs ${I.W}` },
            { name: "B's read", value: r.rOk ? `ok (${r.rs.length} replies)` : "fails", ok: r.rOk, target: `needs ${I.R}` },
            { name: "B sees", value: r.rOk ? (r.stale ? "v1 (stale)" : "v2") : "–", ok: r.stale ? true : null },
          ]);
        } };
      },
      valid: (I, a) => { const r = quorumSim(I, a.cut); if (!r.wOk) return "A's write doesn't reach W replicas, so the client gets an error (no silent staleness)"; if (!r.rOk) return "B's read can't reach R replicas and fails"; return r.stale ? true : "B's read quorum overlaps a replica that has v2"; },
      val: (I, a) => (a.cut || []).length + (a.down || []).length,
      bad: () => [{ down: [], cut: [] }],
      hint: (I) => I.lv === 1 ? "B reads only one replica. Which one does it ask first?" : I.lv === 2 ? `R + W = ${I.R + I.W} ≤ N = ${I.N}. Keep A away from exactly the replicas B asks first.` : "R + W > N, so the home quorums must overlap... unless the write never lands on enough home replicas.",
      concept: "Quorum overlap (R + W > N) and sloppy quorums",
      how: "With N replicas, a write acknowledged by W and a read that asks R overlap in at least one replica only when R + W > N. If they don't overlap, a successful write followed by a successful read can return the old value with no error anywhere. Sloppy quorums (hinted handoff) improve write availability by letting fallback nodes outside the key's home set accept the write, but those acknowledgements don't count toward overlap with a read of the home replicas until the hints are delivered. Network partitions that separate clients from different replicas are exactly what exposes this.",
      rule: "If you need read-after-write, make R + W > N with strict quorums; treat sloppy quorums and R = 1 as eventually consistent and design the feature for that.",
      why: (I, sol) => { const r = quorumSim(I, sol.cut); return `Cutting ${sol.cut.length} link${sol.cut.length > 1 ? "s" : ""} puts v2 on ${r.ws.map((i) => esc(qName(I, i))).join(", ")}${r.hinted.length ? ` plus a hint on ${r.hinted.map((i) => esc(qName(I, i))).join(", ")}` : ""}, while B reads ${r.rs.map((i) => esc(qName(I, i))).join(", ")}. ${I.F ? `R + W = ${I.R + I.W} > N looked safe, but the fallback's acknowledgement doesn't overlap any home read quorum.` : `R + W = ${I.R + I.W} ≤ N = ${I.N}, so nothing forces the quorums to intersect.`}`; },
    },
    /* 2 */ {
      id: "dist-quorum-settings",
      name: "Pick N, R and W",
      kind: "Config change",
      skills: ["tune", "design"],
      w: "tune",
      sense: "min",
      vname: "a cost of",
      gen(lv, R) {
        if (lv === 1) return { lv, lat: [R.int(8, 14) / 10, R.int(15, 22) / 10, R.int(50, 80) / 10], fr: 1, fw: 1, rshare: R.pick([0.9, 0.95]) };
        if (lv === 2) return { lv, lat: [R.int(8, 12) / 10, R.int(13, 18) / 10, R.int(19, 25) / 10, R.int(60, 90) / 10, R.int(95, 130) / 10], fr: 2, fw: 1, rshare: R.pick([0.95, 0.97]) };
        const west = R.int(55, 75), eu = R.int(70, 95);
        return { lv, west, eu, rshare: R.pick([0.8, 0.9]), regions: ["us-east", "us-west", "eu-west"] };
      },
      text: (I) => I.lv < 3
        ? `<p>A replicated key-value store serves a <b>${K.pct(I.rshare, 0)} read</b> workload. Measured p99 to each replica from the app: <b>${I.lat.map((x) => x + " ms").join(", ")}</b> (fastest first${I.lv === 2 ? "; N = 3 uses the first three" : ""}). A request finishes when the R-th (or W-th) fastest replica answers.</p>
          <p>Requirements: reads stay <b>strongly consistent</b> (every read sees the latest acknowledged write), reads keep working with <b>${I.fr}</b> replica${I.fr > 1 ? "s" : ""} down and writes with <b>${I.fw}</b> down. Minimise the weighted p99.</p>`
        : `<p>The app runs in <b>us-east</b>; a standby copy of it in us-west takes over if us-east is lost. Replica round trips from us-east: same region ~1 ms, us-west <b>${I.west} ms</b>, eu-west <b>${I.eu} ms</b>. The workload is ${K.pct(I.rshare, 0)} reads.</p>
          <p>Place replicas and choose R and W so reads stay <b>strongly consistent</b> and both reads and writes keep working if <b>any one region</b> is lost. Minimise weighted latency from us-east first, then the number of replicas.</p>`,
      ui: (I) => {
        const knobs = I.lv === 1 ? [{ k: "N", label: "Replicas (N)", opts: [3], fixed: 3 }, { k: "W", label: "Write quorum (W)", opts: [1, 2, 3] }, { k: "R", label: "Read quorum (R)", opts: [1, 2, 3] }]
          : I.lv === 2 ? [{ k: "N", label: "Replicas (N)", opts: [3, 5] }, { k: "W", label: "Write quorum (W)", opts: [1, 2, 3, 4, 5] }, { k: "R", label: "Read quorum (R)", opts: [1, 2, 3, 4, 5] }]
            : [{ k: "e", label: "Replicas in us-east", opts: [1, 2, 3] }, { k: "w", label: "Replicas in us-west", opts: [0, 1, 2, 3] }, { k: "u", label: "Replicas in eu-west", opts: [0, 1, 2] }, { k: "W", label: "Write quorum (W)", opts: U.range(8).map((i) => i + 1), select: true }, { k: "R", label: "Read quorum (R)", opts: U.range(8).map((i) => i + 1), select: true }];
        return { knobs, live: (cfg) => {
          const r = quorumCfg(I, cfg);
          return K.metrics([
            { name: "N", value: String(r.N), ok: null },
            { name: "R + W > N", value: `${cfg.R} + ${cfg.W} vs ${r.N}`, ok: cfg.R + cfg.W > r.N },
            { name: "Read p99", value: Number.isFinite(r.rl) ? K.ms(r.rl) : "–", ok: null },
            { name: "Write p99", value: Number.isFinite(r.wl) ? K.ms(r.wl) : "–", ok: null },
            { name: "Weighted", value: Number.isFinite(r.lat) ? K.ms(r.lat) : "–", ok: r.errs.length ? false : null },
          ]) + (r.errs.length ? K.note(r.errs.map(esc).join("<br>"), "bad") : K.note("Meets every requirement.", "good"));
        } };
      },
      valid: (I, cfg) => { const r = quorumCfg(I, cfg); return r.errs.length ? r.errs[0] : true; },
      val: (I, cfg) => { const r = quorumCfg(I, cfg); return Math.round(r.lat * 100) * 100 + (I.lv === 3 ? r.N : 0); },
      vfmt: (v) => `${(Math.floor(v / 100) / 100).toFixed(2)} ms weighted p99`,
      hint: (I) => I.lv === 1 ? "Write down both constraints: R + W > N, and R, W ≤ N − failures." : I.lv === 2 ? "Can N = 3 keep strong reads with two replicas down? If not, with N = 5, which quorum should be small: the one used 95% of the time?" : "After losing the biggest region, R and W must each fit in what's left, and still overlap. How fast can a quorum that must survive the loss of us-east possibly be?",
      concept: "Choosing N, R and W",
      how: "Strong reads need R + W > N so every read quorum intersects every write quorum. Availability needs R ≤ N − f_read and W ≤ N − f_write for the failures you must survive. Within those bounds you can shift cost: a small R with a large W makes reads fast and writes slow, which suits read-heavy data. A request completes when the R-th (or W-th) fastest replica answers, so quorum size directly picks which replica latency you pay. When the failure unit is a whole region, every quorum must span regions, so you pay a cross-region round trip on every strongly consistent operation.",
      rule: "Start from the failures you must survive, derive the allowed R and W, then make the quorum you use most often the small one. If you must survive a region and be strongly consistent, budget a cross-region RTT per operation.",
      why: (I, sol) => { const r = quorumCfg(I, sol); return I.lv < 3 ? `N = ${r.N}, R = ${sol.R}, W = ${sol.W}: reads wait for the ${sol.R}${sol.R === 1 ? "st" : sol.R === 2 ? "nd" : "rd"}-fastest replica (${K.ms(r.rl)}), writes for the ${sol.W}th-fastest (${K.ms(r.wl)}), weighted ${K.ms(r.lat)}.${I.lv === 2 ? " N = 3 can't do it: with two replicas down only one answers, and R = 1 would need W = 3, which a single failure blocks." : ""}` : `${sol.e}/${sol.w}/${sol.u} replicas with R = ${sol.R}, W = ${sol.W}. Every quorum that survives losing a region must include a replica outside us-east, so ${K.ms(r.lat)} is the floor; more replicas only add cost.`; },
    },
    /* 3 */ {
      id: "dist-linearizability-history",
      name: "Audit the register history",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "select",
      sense: "min",
      vname: "reads discarded:",
      gen(lv, R) {
        const off = R.int(0, 6), sc = R.pick([1, 2, 3]);
        const v1 = R.int(2, 9), v2 = v1 + R.int(1, 9);
        const cl = R.sample(["api-1", "api-2", "api-3", "worker", "cron", "admin"], 4);
        const T = (x) => off + x * sc;
        let ops;
        if (lv === 1) ops = [
          { c: cl[0], k: "w", v: v1, s: T(10), e: T(50) },
          { c: cl[1], k: "r", v: v1, s: T(20), e: T(35) },
          { c: cl[2], k: "r", v: 0, s: T(12), e: T(28) },
          { c: cl[3], k: "r", v: 0, s: T(58), e: T(70) },
          { c: cl[1], k: "r", v: v1, s: T(74), e: T(84) },
        ];
        else if (lv === 2) ops = [
          { c: cl[0], k: "w", v: v1, s: T(10), e: T(60) },
          { c: cl[1], k: "r", v: v1, s: T(20), e: T(30) },
          { c: cl[2], k: "r", v: 0, s: T(38), e: T(48) },
          { c: cl[3], k: "r", v: 0, s: T(12), e: T(22) },
          { c: cl[1], k: "r", v: v1, s: T(70), e: T(80) },
        ];
        else ops = [
          { c: cl[0], k: "w", v: v1, s: T(0), e: T(40) },
          { c: cl[1], k: "w", v: v2, s: T(20), e: T(70) },
          { c: cl[2], k: "r", v: v2, s: T(45), e: T(55) },
          { c: cl[3], k: "r", v: v1, s: T(58), e: T(66) },
          { c: cl[2], k: "r", v: v2, s: T(75), e: T(85) },
          { c: cl[3], k: "r", v: v1, s: T(72), e: T(82) },
          { c: cl[3], k: "r", v: 0, s: T(4), e: T(14) },
        ];
        // label ops: writes W1.., reads R1.. in start order
        ops.sort((a, b) => a.s - b.s);
        let w = 0, r = 0;
        ops.forEach((o) => (o.id = o.k === "w" ? "W" + ++w : "R" + ++r));
        return { lv, ops, clients: cl.slice().sort(), key: R.pick(["config/primary", "leader", "balance:77", "feature/limit"]) };
      },
      text: (I) => `<p>A Jepsen-style test recorded this history of operations on the register <code>${esc(I.key)}</code> (initial value 0). Each bar is one operation from invocation to response; the store claims to be <b>linearizable</b>.</p>${timelineSVG(I.ops, I.clients)}
        <p>Pick the <b>fewest reads</b> you'd have to discard for the remaining history to be linearizable. Those are the reads you report as violations.</p>`,
      ui: (I) => {
        const reads = I.ops.filter((o) => o.k === "r");
        return { opts: reads.map((o) => `${o.id} · ${o.c} · read → ${o.v} · ${o.s}–${o.e} ms`), live: (sel) => {
          const drop = new Set((sel || []).map((i) => reads[i].id));
          const ok = linearizable(I.ops.filter((o) => !drop.has(o.id)));
          return K.verdict(ok, ok ? "The remaining history has a valid linearization." : "The remaining history is still not linearizable.");
        } };
      },
      valid: (I, sel) => { const reads = I.ops.filter((o) => o.k === "r"); const drop = new Set(sel.map((i) => reads[i].id)); return linearizable(I.ops.filter((o) => !drop.has(o.id))) ? true : "what's left still can't be ordered consistently with real time"; },
      val: (I, sel) => sel.length,
      bad: () => [],
      hint: (I) => I.lv === 1 ? "An operation that starts after another one finished must be ordered after it." : I.lv === 2 ? "Two reads that each look fine alone can still contradict each other: once anyone has seen the new value, no later read may see the old one." : "Try both orders of the two writes. Which reads does each order force out?",
      concept: "Linearizability",
      how: "A history is linearizable if every operation can be given a single instant between its invocation and response such that the resulting sequential order is a legal execution of the object. Real time is the key constraint: if operation A returns before B is invoked, A must come before B. Concurrent operations may be ordered either way, which is why a read overlapping a write may return either value. But once any read has returned the new value, every read that starts afterwards must return it too (no going back in time). Checkers like Knossos and Porcupine search for such an order; finding the smallest set of contradicting reads tells you which responses were wrong.",
      rule: "When judging a read, ask only: which operations had completed before it started? Those are fixed in the past; everything overlapping can go either way, but the order must be the same for every observer.",
      why: (I, sol) => { const reads = I.ops.filter((o) => o.k === "r"); return `Discarding ${sol.map((i) => reads[i].id).join(" and ")} leaves a history with a valid order. ${I.lv === 1 ? "That read started after the write had been acknowledged yet returned the old value." : I.lv === 2 ? "One read saw the new value and a later read (started after it finished) saw the old one: either could be the liar, so discarding either is a minimal fix." : "Whichever order the two writes take, some reads contradict it; there are several minimal sets of two."}`; },
    },
    /* 4 */ {
      id: "dist-session-anomaly",
      name: "Catch the replica lying",
      kind: "Experiment",
      skills: ["diagnose", "design"],
      gen(lv, R) {
        const user = R.pick(["maya", "omar", "lin", "jonas", "ines"]);
        if (lv === 1) return { kind: "ryw", user, old: R.pick(["Sam K", "sam_k", "Sammy"]), nu: R.pick(["Samantha K.", "Sam Kowalski", "S. Kowalski"]) };
        if (lv === 2) { const o = R.int(20, 60); return { kind: "mono", user, old: "$" + o, nu: "$" + (o + R.int(2, 9)) }; }
        const [a, b, c] = R.sample(["Ana", "Ben", "Chen", "Dara", "Eli", "Femi"], 3);
        return { kind: "causal", a, b, c, post: R.pick(["Is the API down?", "Release notes v4.2", "Lunch at 1?"]) };
      },
      ...laneScenario(causalModel),
      text: (I) => I.kind === "ryw"
        ? `<p>Profile writes go to the Postgres primary; reads go to an async streaming replica behind a load balancer. Support says users "lose" their edits right after saving. Build a schedule in which <b>${esc(I.user)}</b> saves a new display name and then sees the old one.</p>`
        : I.kind === "mono"
          ? `<p>Prices are written to a primary and read from two async replicas with different lag; the LB round-robins requests. A shopper reports the price "jumping back". Build a schedule where the shopper sees the <b>new</b> price ${esc(I.nu)} and then, on refresh, the <b>old</b> price ${esc(I.old)}.</p>`
          : `<p>A forum stores posts on shard-1 and replies on shard-2, each replicating to the eu-west region on its own stream. ${esc(I.b)} only replies after reading ${esc(I.a)}'s post. Build a schedule where <b>${esc(I.c)}</b>, reading in eu-west, sees the <b>reply but not the post</b> it answers.</p>`,
      hint: (I) => I.kind === "ryw" ? "When does the replica replay relative to the user's read?" : I.kind === "mono" ? "One replica must catch up before the first read and the other must still be behind at the second." : "The two shards replicate independently. Nothing forces shard-1's stream to arrive first.",
      concept: "Session guarantees and causal consistency",
      how: "Asynchronous replicas serve a past snapshot, and different replicas can be at different points. Read-your-writes breaks when a user's read lands on a replica that hasn't replayed their own write. Monotonic reads breaks when consecutive reads hit replicas at different positions, so time appears to go backwards. Causal consistency breaks when two causally related writes travel on independent replication streams (different shards or partitions) and arrive out of order. The fixes carry a position with the session: route to the primary for a while after a write, pin a session to one replica, or pass the last-seen LSN/version and make the replica wait until it has caught up.",
      rule: "Decide per feature which session guarantees users need, then implement them explicitly (LSN tokens, sticky routing, or primary reads) instead of hoping lag stays small.",
      why: (I) => I.kind === "ryw" ? `The read went to the replica before it replayed ${esc(I.user)}'s write. Track the commit LSN in the session and only read from a replica whose replay LSN is at least that (or read from the primary for a few seconds after a write).` : I.kind === "mono" ? `replica-1 had caught up and replica-2 hadn't; round-robin sent the two reads to different points in time. Pin the session to one replica or carry the last-seen LSN.` : `The reply's shard replicated first. Each shard's stream is in order, but nothing orders them relative to each other. Causal consistency needs dependency tracking (e.g. the reply carries the post's version and the eu reader waits for it) or co-locating causally related data.`,
    },
    /* 5 */ {
      id: "dist-raft-who-can-lead",
      name: "Who can win the election?",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "select",
      gen(lv, R) {
        const T = R.int(4, 9), b = R.int(2, 4);
        const base = U.range(b).map((i) => Math.max(1, T - 3 + Math.floor((i * 2) / b)));
        const n = lv === 1 ? 3 : 5;
        const names = U.range(n).map((i) => "n" + (i + 1));
        const lead = R.int(0, n - 1);
        const others = R.shuffle(U.range(n).filter((i) => i !== lead));
        const nodes = names.map((name) => ({ name, alive: true, isolated: false, log: base.slice() }));
        nodes[lead].alive = false;
        const k = R.int(3, 4);
        nodes[lead].log = [...base, ...Array(k).fill(T)];
        if (lv === 1) {
          const m = R.shuffle([R.int(1, k), R.int(0, k)]);
          others.forEach((o, j) => (nodes[o].log = [...base, ...Array(m[j]).fill(T)]));
        } else if (lv === 2) {
          const iso = others[0];
          nodes[iso].isolated = true; nodes[iso].log = [...base, ...Array(k).fill(T)];
          const m = [R.int(1, k - 1), R.int(0, k - 1), R.int(0, k - 1)];
          others.slice(1).forEach((o, j) => (nodes[o].log = [...base, ...Array(m[j]).fill(T)]));
        } else {
          // a deposed leader of term T-1 left a long tail of uncommitted entries
          const m1 = R.int(1, 2);
          nodes[others[0]].log = [...base, ...Array(R.int(3, 5)).fill(T - 1)];
          nodes[others[1]].log = [...base, ...Array(m1).fill(T)];
          nodes[others[2]].log = [...base, ...Array(m1 + R.int(0, 1)).fill(T)];
          nodes[others[3]].log = R.chance(0.5) ? base.slice() : [...base, T - 1];
        }
        const winners = U.range(n).filter((c) => canWin(c, nodes, n));
        if (!winners.length) return null;
        return { lv, n, T, nodes, lead };
      },
      text: (I) => `<p>A ${I.n}-node Raft cluster just lost its leader <b>${esc(I.nodes[I.lead].name)}</b> (term ${I.T}). Each cell is the <b>term</b> of the log entry at that index.${I.lv === 2 ? " One node is also cut off from the rest by a network partition." : ""}</p>${logTable(I.nodes)}
        <p>Select <b>every node that can win</b> the next election (assuming it times out first and all reachable nodes vote).</p>`,
      ui: (I) => ({ opts: I.nodes.map((x, i) => i).filter((i) => i !== I.lead).map((i) => `${I.nodes[i].name}: last entry term ${lastT(I.nodes[i].log)}, length ${I.nodes[i].log.length}${I.nodes[i].isolated ? " (partitioned)" : ""}`) }),
      ans: (I) => { const ids = U.range(I.n).filter((i) => i !== I.lead); return ids.map((c, k) => (canWin(c, I.nodes, I.n) ? k : -1)).filter((k) => k >= 0); },
      diag: () => "Not quite. A voter grants its vote only if the candidate's log is at least as up to date: compare the term of the last entry first, and length only to break ties. A candidate also needs a majority of the whole cluster.",
      hint: (I) => I.lv === 1 ? "With 3 nodes, a candidate needs 2 votes: its own and one more." : I.lv === 2 ? "A node that can't reach a majority can't collect a majority of votes, however good its log." : "Compare last-entry terms before lengths.",
      concept: "Raft leader election restriction",
      how: "A Raft candidate increments its term and asks for votes; a node votes for at most one candidate per term, and only if the candidate's log is at least as up to date as its own: the candidate's last entry has a higher term, or the same term and the log is at least as long. The candidate needs votes from a majority of the full cluster, counting itself. Because every committed entry is on a majority, and any winning candidate needed votes from a majority, the two majorities overlap, so the new leader always holds every committed entry. A long log full of entries from an old term loses to a shorter log whose last entry has a newer term.",
      rule: "Up to date means last term first, then length. Never count nodes you can't reach, and count the majority against the full membership, not the survivors.",
      why: (I) => { const w = U.range(I.n).filter((c) => c !== I.lead && canWin(c, I.nodes, I.n)).map((c) => I.nodes[c].name); return `Majority is ${maj(I.n)} of ${I.n}. ${w.join(" and ")} can collect that many votes. ${I.lv === 2 ? "The partitioned node has the best log but can reach nobody." : I.lv === 3 ? `The node with the long tail of term-${I.T - 1} entries loses to any node whose last entry is from term ${I.T}.` : ""}`; },
    },
    /* 6 */ {
      id: "dist-raft-cluster-size",
      name: "Size the consensus cluster",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "tune",
      sense: "min",
      vname: "voting members:",
      gen(lv, R) {
        const sys = R.pick(["etcd", "a Raft-based config store", "the lock service", "the metadata service"]);
        const azs = R.pick([["a", "b", "c"], ["1a", "1b", "1c"], ["east-1", "east-2", "east-3"]]);
        return { lv, sys, azs, req: lv === 1 ? "az" : lv === 2 ? "az-or-2" : "az-plus-1" };
      },
      text: (I) => `<p>You're placing the voting members of <b>${esc(I.sys)}</b> across three availability zones (${I.azs.map(esc).join(", ")}). Every member adds replication traffic and slows commits, so use <b>as few as possible</b>.</p>
        <p>It must keep a quorum (stay writable) through ${I.req === "az" ? "the loss of <b>any one AZ</b>" : I.req === "az-or-2" ? "the loss of <b>any one AZ</b>, and separately through <b>any two members</b> failing at once" : "the loss of <b>any one AZ while one more member elsewhere is down</b> (e.g. mid rolling upgrade)"}.</p>`,
      ui: (I) => ({ knobs: I.azs.map((z, k) => ({ k: "z" + k, label: `Members in AZ ${z}`, opts: [0, 1, 2, 3, 4] })), live: (cfg) => {
        const c = [cfg.z0, cfg.z1, cfg.z2], n = c[0] + c[1] + c[2];
        if (!n) return `<p class="muted small">Place some members.</p>`;
        const cases = raftCases(I, c);
        return K.metrics([{ name: "Members", value: String(n), ok: null }, { name: "Quorum", value: String(maj(n)), ok: null }, { name: "Tolerates", value: `${n - maj(n)} failure${n - maj(n) === 1 ? "" : "s"}`, ok: null }]) +
          K.table(["failure", "members left", "quorum?"], cases.map((x) => [esc(x.name), String(x.left), x.ok ? "yes" : "<b>no: unavailable</b>"]), { compact: true });
      } }),
      valid: (I, cfg) => { const c = [cfg.z0, cfg.z1, cfg.z2]; if (!(c[0] + c[1] + c[2])) return "no members"; const bad = raftCases(I, c).find((x) => !x.ok); return bad ? `losing ${bad.name} leaves ${bad.left}, short of a quorum` : true; },
      val: (I, cfg) => cfg.z0 + cfg.z1 + cfg.z2,
      hint: (I) => I.req === "az" ? "Quorum is a majority of all members, counted before the failure. What's left after losing the biggest AZ?" : I.req === "az-or-2" ? "Check both failure modes separately; 4 members tolerate exactly as many failures as 3." : "Write it as an inequality: N − (largest AZ) − 1 ≥ ⌊N/2⌋ + 1. Try small N.",
      concept: "Quorum math and failure domains",
      how: "A Raft or Paxos group of N voters needs ⌊N/2⌋ + 1 of them to elect a leader and commit. That tolerates ⌊(N − 1)/2⌋ failures, so 4 voters tolerate one failure, the same as 3, while adding a member that must acknowledge writes; 2 voters tolerate none (both must be up), which is worse than 1. Real failures come in correlated units: a zone, a rack, a rolling upgrade. Placement must keep a majority after losing the largest unit, plus whatever else you plan to have down at the same time.",
      rule: "Use an odd number of voters, spread so no single failure domain holds half of them; then check every failure scenario you promise to survive, including 'one zone down during maintenance'.",
      why: (I, sol) => { const c = [sol.z0, sol.z1, sol.z2], n = c[0] + c[1] + c[2]; return `${c.join("/")} = ${n} members, quorum ${maj(n)}. ${I.req === "az-plus-1" ? "Surprisingly, 5 and 7 can't do it: losing an AZ of 2 or 3 plus one more node drops below a majority. 9 members (3/3/3) leave 5 of 9." : I.req === "az-or-2" ? "Three members survive an AZ but not two node failures; 5 spread 2/2/1 survive both." : "One per AZ: losing any AZ leaves 2 of 3. Putting two members in one AZ would make that AZ a single point of failure for the quorum."}`; },
    },
    /* 7 */ {
      id: "dist-raft-committed-entries",
      name: "Which entries survive the crash?",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "classify",
      gen(lv, R) {
        const n = lv === 1 ? 3 : 5, b = R.int(2, 4);
        const t0 = R.int(1, 3);
        const base = U.range(b).map((i) => t0 + (i >= b - 1 ? 1 : 0));
        const names = U.range(n).map((i) => "s" + (i + 1));
        const nodes = names.map((name) => ({ name, alive: true, isolated: false, log: base.slice() }));
        const lead = R.int(0, n - 1), ot = R.shuffle(U.range(n).filter((i) => i !== lead));
        nodes[lead].alive = false;
        let T;
        if (lv === 1) {
          T = t0 + 2; const k = R.int(3, 4); nodes[lead].log = [...base, ...Array(k).fill(T)];
          const m = R.shuffle([R.int(1, k - 1), R.int(0, 1)]);
          ot.forEach((o, j) => (nodes[o].log = [...base, ...Array(m[j]).fill(T)]));
        } else if (lv === 2) {
          T = t0 + 2; const k = 4; nodes[lead].log = [...base, ...Array(k).fill(T)];
          const m = [3, 2, 1, 0].map((x) => Math.max(0, x - R.int(0, 1)));
          ot.forEach((o, j) => (nodes[o].log = [...base, ...Array(m[j]).fill(T)]));
        } else {
          const t2 = t0 + 2, t3 = t2 + 1; T = t3 + 1;
          nodes[lead].log = [...base, t2, T];
          nodes[ot[0]].log = [...base, t2]; nodes[ot[1]].log = [...base, t2];
          nodes[ot[2]].log = base.slice(); nodes[ot[3]].log = [...base, t3];
        }
        nodes[lead].note = "leader (crashed)";
        const first = Math.max(0, b - 2);
        const items = U.range(nodes[lead].log.length - first).map((j) => first + j);
        return { lv, n, nodes, lead, items, T };
      },
      text: (I) => `<p>The leader <b>${esc(I.nodes[I.lead].name)}</b> of this ${I.n}-node Raft cluster has just crashed and won't come back soon. Cells show the <b>term</b> of each log entry.</p>${logTable(I.nodes)}
        <p>For each entry in the dead leader's log, decide: is it guaranteed to survive <b>whichever node wins the next election</b>, or could the new leader overwrite it?</p>`,
      ui: (I) => ({ items: I.items.map((i) => `index ${i + 1} (term ${I.nodes[I.lead].log[i]})`), cats: ["Survives any election", "Could be lost"] }),
      ans: (I) => { const w = U.range(I.n).filter((c) => canWin(c, I.nodes, I.n)); return I.items.map((i) => (w.every((c) => I.nodes[c].log[i] === I.nodes[I.lead].log[i]) ? 0 : 1)); },
      diag: () => "Not quite. For each entry, find every node that could win (log at least as up to date as a majority's) and check whether it holds that exact entry.",
      hint: (I) => I.lv === 3 ? "Being stored on a majority is not the same as being committed when the entry is from an older term. Could a node holding a different entry at that index win?" : "List the nodes that can win; an entry survives only if all of them have it.",
      concept: "Committed vs. uncommitted Raft entries",
      how: "An entry is safe once it's committed: stored on a majority by the leader of the entry's own term. Any future leader must win votes from a majority, which overlaps that majority, and the up-to-date check then guarantees it holds the entry. Entries on fewer nodes may or may not survive, depending on who wins. Raft's subtle case (Figure 8 of the paper): an entry from an older term can sit on a majority and still be overwritten, because a node with a newer-term entry at that index can win. That's why a leader only counts replicas for entries of its current term, and older entries become committed indirectly.",
      rule: "Acknowledge a client write only when the leader has committed an entry from its current term that covers it; 'on a majority' is not enough for old-term entries.",
      why: (I) => { const w = U.range(I.n).filter((c) => canWin(c, I.nodes, I.n)).map((c) => I.nodes[c].name); return `Possible winners: ${w.join(", ")}. ${I.lv === 3 ? "The older-term entry was on a majority, yet the node holding a newer-term entry at the same index can win and will overwrite it on the followers." : "Entries that every possible winner holds survive; the rest depend on who wins."}`; },
    },
  ]);

  function raftCases(I, c) {
    const n = c[0] + c[1] + c[2], q = maj(n), out = [];
    c.forEach((x, k) => { if (I.req !== "az-plus-1") out.push({ name: `AZ ${I.azs[k]}`, left: n - x, ok: n - x >= q }); });
    if (I.req === "az-or-2") out.push({ name: "any 2 members", left: n - 2, ok: n - 2 >= q });
    if (I.req === "az-plus-1") c.forEach((x, k) => { const left = n - x - (n - x > 0 ? 1 : 0); out.push({ name: `AZ ${I.azs[k]} + 1 member`, left, ok: left >= q }); });
    return out;
  }
  /* ---------- fencing models (scenario 8) ---------- */
  function fenceModel(I) {
    const acc = (s, who) => {
      const me = s[who];
      if (!me.has) return `no lease: ${who} skips the write`;
      if (I.kind !== "none" && I.kind !== "check" && me.tok < s.maxTok) return `storage rejects token ${me.tok} (< ${s.maxTok})`;
      if (I.kind === "check" && !me.checked) return `check failed earlier: ${who} skips`;
      const stale = me.epoch < s.maxEpoch;
      s.maxEpoch = Math.max(s.maxEpoch, me.epoch); s.maxTok = Math.max(s.maxTok, me.tok);
      if (stale) s.broken = true;
      s.writes.push(who + ":" + me.tok);
      return (stale ? "!" : "") + `storage accepts ${who}'s write (token ${me.tok})${stale ? ", overwriting a newer holder's data" : ""}`;
    };
    if (I.kind === "redis") {
      const acquire = (who) => (s) => {
        if (s.lock) { s[who].has = false; return `lock held by ${s.lock}: ${who} backs off`; }
        s.lock = who; s.fence++; s.epoch++;
        s[who] = { has: true, tok: s.fence, epoch: s.epoch };
        return `${who} gets the lock, token ${s.fence}`;
      };
      return {
        init: { lock: null, fence: I.tok - 1, epoch: 0, A: { has: false }, B: { has: false }, maxTok: 0, maxEpoch: 0, writes: [], broken: false, failed: false },
        lanes: [
          { name: `${I.a} (A)`, steps: ["SET lock NX PX 30000; INCR fence (Redis primary)", `write ${I.file} part 1 with token`, `write ${I.file} part 2 with token`], ops: [acquire("A"), (s) => acc(s, "A"), (s) => acc(s, "A")] },
          { name: "Redis failover", steps: ["primary dies; async replica (missing the last writes) is promoted"], ops: [(s) => { if (!s.lock) return "replica was up to date: nothing lost"; s.lock = null; s.fence = I.tok - 1; return "!lock key and fence counter roll back"; }] },
          { name: `${I.b} (B)`, steps: ["SET lock NX PX 30000; INCR fence (current primary)", `write ${I.file} with token`], ops: [acquire("B"), (s) => acc(s, "B")] },
        ],
        broken: (s) => s.broken,
        verdict: (s) => s.broken ? `storage accepted an older holder's write after a newer one (writes: ${s.writes.join(", ")})` : `writes in order: ${s.writes.join(", ") || "none"}`,
        solve: [0, 1, 2, 2, 0, 0],
        bad: [[0, 0, 0, 1, 2, 2], [1, 0, 0, 0, 2, 2], [0, 2, 2, 1, 0, 0]],
      };
    }
    const acquire = (who, tok, epoch) => (s) => {
      if (s.holder) { s[who].has = false; return `lease held by ${s.holder}: ${who} retries later`; }
      s.holder = who; s[who] = { has: true, tok, epoch, checked: false };
      return `${who} holds the lease, token ${tok}`;
    };
    const check = (who) => (s) => { if (!s[who].has) return "no lease"; s[who].checked = s[who].tok >= s.maxTok; return `reads last_token = ${s.maxTok}: ${s[who].checked ? "ok, " + s[who].tok + " ≥ " + s.maxTok : "stale, gives up"}`; };
    const A = [acquire("A", I.tok, 1)], B = [acquire("B", I.tok + 1, 2)];
    const As = [`acquire lease (TTL ${I.ttl} s) → token ${I.tok}`], Bs = [`acquire lease → token ${I.tok + 1}`];
    if (I.kind === "check") { A.push(check("A")); As.push("SELECT last_token (app-side fencing check)"); B.push(check("B")); Bs.push("SELECT last_token (app-side fencing check)"); }
    A.push((s) => acc(s, "A")); As.push(`(after a ${I.pause} s GC pause) write ${I.file}`);
    B.push((s) => acc(s, "B")); Bs.push(`write ${I.file}`);
    return {
      init: { holder: null, A: { has: false }, B: { has: false }, maxTok: 0, maxEpoch: 0, writes: [], broken: false },
      lanes: [
        { name: `${I.a} (A)`, steps: As, ops: A },
        { name: "lock service clock", steps: [`${I.ttl} s pass: A's lease expires`], ops: [(s) => { if (s.holder !== "A") return "nothing to expire"; s.holder = null; return "lease free (A is paused and doesn't know)"; }] },
        { name: `${I.b} (B)`, steps: Bs, ops: B },
      ],
      broken: (s) => s.broken,
      verdict: (s) => s.broken ? `storage accepted A's stale write after B's (writes: ${s.writes.join(", ")})` : `writes in order: ${s.writes.join(", ") || "none"}`,
      solve: I.kind === "check" ? [0, 0, 1, 2, 2, 2, 0] : [0, 1, 2, 2, 0],
      bad: I.kind === "check" ? [[0, 0, 0, 1, 2, 2, 2], [0, 1, 2, 2, 2, 0, 0]] : [[0, 0, 1, 2, 2], [2, 2, 1, 0, 0]],
    };
  }

  /* ---------- lease timing model (scenario 9) ---------- */
  function leaseEval(I, cfg) {
    const clock = I.lv === 1 ? cfg.clock : "monotonic";
    const hazard = I.lv === 1 ? (clock === "wall" ? I.jump : 0) : I.pause;
    const fenced = I.lv === 3 && cfg.fence === "on";
    const safe = fenced || cfg.margin >= hazard;
    const slack = cfg.ttl - cfg.margin - (I.miss + 1) * cfg.renew;
    const live = slack > 0;
    const fast = cfg.ttl <= I.target;
    return { clock, hazard, fenced, safe, live, slack, fast, ok: safe && live && fast };
  }

  /* ---------- hash ring (scenario 11) ---------- */
  const fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
  const ptCache = new Map();
  const pts = (name, v) => { let a = ptCache.get(name); if (!a || a.length < v) { a = U.range(Math.max(v, 256)).map((j) => fmix(K.hash(name + "#" + j)) / 4294967296); ptCache.set(name, a); } return a.slice(0, v); };
  function ringLoads(nodes) {
    const all = [];
    nodes.forEach((n, i) => pts(n.name, n.v).forEach((p) => all.push([p, i])));
    all.sort((a, b) => a[0] - b[0]);
    const load = nodes.map(() => 0);
    all.forEach(([p, i], k) => { const prev = k ? all[k - 1][0] : all[all.length - 1][0] - 1; load[i] += p - prev; });
    return load;
  }
  function vnodeEval(I, cfg) {
    const nodes = I.nodes.map((n) => ({ name: n.name, v: cfg[n.cls], cap: n.cap }));
    const capT = K.sum(nodes.map((n) => n.cap));
    const ratio = (ns) => { const l = ringLoads(ns), ct = K.sum(ns.map((n) => n.cap)); return ns.map((n, i) => l[i] / (n.cap / ct)); };
    const r = ratio(nodes);
    let worstFail = 0, failName = "";
    if (I.lv === 3) nodes.forEach((_, d) => { const ns = nodes.filter((__, i) => i !== d); const rr = ratio(ns); const m = Math.max(...rr); if (m > worstFail) { worstFail = m; failName = nodes[d].name; } });
    return { nodes, r, max: Math.max(...r), worstFail, failName, total: K.sum(nodes.map((n) => n.v)), capT };
  }

  /* ---------- two-phase commit model (scenario 12) ---------- */
  function tpcModel(I) {
    const P = I.p;
    const init = { prep: false, decision: null, sent: Array(P).fill(false), crashed: false, voted: Array(P).fill(false), done: Array(P).fill(null) };
    const C = [
      (s) => { if (s.crashed) return "!coordinator is down"; s.prep = true; return "PREPARE sent"; },
      (s) => { if (s.crashed) return "!coordinator is down"; s.decision = s.voted.every(Boolean) ? "COMMIT" : "ABORT"; return `decision ${s.decision} fsynced to the coordinator log`; },
      ...U.range(P).map((i) => (s) => { if (s.crashed) return "!coordinator is down"; if (!s.decision) return "no decision yet"; s.sent[i] = true; return `${s.decision} sent to ${I.names[i]}`; }),
    ];
    const lanes = [{ name: "coordinator", steps: ["send PREPARE to all", "collect votes, log decision", ...U.range(P).map((i) => `send decision to ${I.names[i]}`)], ops: C }];
    U.range(P).forEach((i) => lanes.push({ name: I.names[i], steps: ["vote YES (prepare record fsynced, locks held)", "apply decision, release locks"], ops: [
      (s) => { if (!s.prep) return "no PREPARE received yet"; s.voted[i] = true; return "voted YES; now must wait for the decision"; },
      (s) => { if (s.sent[i]) { s.done[i] = s.decision; return `${s.decision === "COMMIT" ? "committed" : "rolled back"}, locks released`; } if (!s.voted[i]) { s.done[i] = "ABORT"; return "never prepared: aborts on its own"; } return "!in doubt: holding row locks, can't decide alone"; },
    ] }));
    lanes.push({ name: "failure", steps: ["coordinator host dies (down for hours)"], ops: [(s) => { s.crashed = true; return "coordinator crashed"; }] });
    const inDoubt = (s) => U.range(P).filter((i) => s.voted[i] && !s.sent[i]);
    const broken = (s) => {
      const d = inDoubt(s);
      if (I.lv === 1) return d.length > 0;
      const all = d.length === P;
      return I.lv === 2 ? all : all && s.decision === "COMMIT";
    };
    const X = P + 1;
    const solve = I.lv < 3 ? [0, 1, 2, X, 0, 0, 0, 1, 2] : [0, 1, 2, 3, 0, X, 0, 0, 0, 1, 2, 3];
    const bad = I.lv === 1 ? [[0, 0, 0, 0, 1, 1, 2, 2, X], [X, 0, 0, 0, 0, 1, 1, 2, 2]] : I.lv === 2 ? [[0, 1, 2, 0, 0, X, 0, 1, 2]] : [[0, 1, 2, 3, X, 0, 0, 0, 0, 1, 2, 3]];
    return {
      init, lanes, broken, solve, bad,
      verdict: (s) => { const d = inDoubt(s); return d.length ? `${d.map((i) => I.names[i]).join(", ")} in doubt holding locks; coordinator ${s.decision ? "had logged " + s.decision : "had logged no decision"}${I.lv > 1 && d.length < P ? "; but another participant knows the outcome (or never voted), so the cooperative termination protocol resolves it" : ""}${I.lv === 3 && d.length === P && s.decision !== "COMMIT" ? "; with no logged decision a recovering coordinator presumes abort, which is still blocking but not the case asked for" : ""}` : "no participant is stuck"; },
    };
  }

  /* ---------- saga plans (scenario 13) ---------- */
  function sagaSpec(I) {
    if (I.lv === 1) return {
      opts: [`Cancel hotel reservation ${I.h}`, `Release the seat hold ${I.f}`, "Refund the card payment", `Mark trip ${I.trip} FAILED and email the customer`, "ROLLBACK the transaction across flights and hotels", "Retry the card charge until it succeeds", `Delete trip ${I.trip} so it looks like it never happened`],
      check(seq) {
        const s = new Set(seq);
        if (s.has(2)) return "There's nothing to refund: the charge was declined, so no money moved. A compensation must undo a step that actually completed.";
        if (s.has(4)) return "There is no transaction spanning the flight and hotel services: each step already committed locally. That's the whole reason a saga needs compensations.";
        if (s.has(5)) return "A decline is a business failure, not a transient error. Retrying forever keeps the seat and room held and annoys the bank.";
        if (s.has(6)) return "Deleting the record destroys the audit trail and leaves the holds in place in the other services.";
        if (!s.has(0) || !s.has(1)) return "The completed steps still hold inventory in other services: compensate each one.";
        if (!s.has(3)) return "The trip is left in limbo: record the outcome and tell the customer.";
        if (seq[seq.length - 1] !== 3) return "Report the failure after the compensations have run, so the customer isn't told it's cancelled while holds still exist.";
        return true;
      },
      solve: [0, 1, 3],
      bad: [[0, 1, 2, 3], [4, 3], [0, 1, 6], [3, 0, 1]],
    };
    const v3 = I.lv === 3;
    const opts = v3
      ? [`Create order ${I.ord} with status PENDING (other flows treat it as locked)`, `Create order ${I.ord} with status CONFIRMED (fix it up if a later step fails)`, `Reserve stock with reservation id = ${I.ord} (idempotent; release by id)`, "Decrement stock: UPDATE stock SET qty = qty - n (compensate: qty + n)", `Authorize card with idempotency key ${I.ord}-auth`, "Authorize card (new request id on every attempt)", "Book carrier pickup (non-refundable, can't be cancelled)", `Capture payment with idempotency key ${I.ord}-cap (retry until it succeeds)`, `Set order ${I.ord} CONFIRMED and send the email (retry until it succeeds)`]
      : [`Create order ${I.ord} (status PENDING)`, "Reserve inventory (compensation: release)", "Authorize the card (compensation: void the authorization)", "Book carrier pickup (non-refundable, can't be cancelled)", "Capture the authorized payment (retry until it succeeds)", "Mark order CONFIRMED and send the email (retry until it succeeds)", "Open an XA transaction across inventory, payments and shipping"];
    const role = v3 ? ["start", "trap", "comp", "trap", "comp", "trap", "pivot", "retry", "retry"] : ["start", "comp", "comp", "pivot", "retry", "retry", "trap"];
    const trapMsg = v3 ? { 1: "Writing CONFIRMED first exposes an order that may still fail: other flows (emails, analytics, cancellations) act on it. Use a PENDING semantic lock.", 3: "A blind decrement isn't idempotent: a retried step or a retried compensation changes stock twice. Key the reservation by order id.", 5: "A fresh request id per attempt means a retry after a timeout can authorize the card twice." } : { 6: "The payment provider and carrier don't speak XA, and a distributed lock across three services is exactly what a saga avoids." };
    return {
      opts,
      check(seq) {
        for (const i of seq) if (role[i] === "trap") return trapMsg[i];
        const need = role.map((r, i) => (r !== "trap" ? i : -1)).filter((i) => i >= 0);
        const miss = need.filter((i) => !seq.includes(i));
        if (miss.length) return `Missing: ${esc(opts[miss[0]])}.`;
        if (role[seq[0]] !== "start") return "Create the order record first: every later step and compensation refers to it.";
        const pos = (r) => seq.map((i, k) => (role[i] === r ? k : -1)).filter((k) => k >= 0);
        const pv = pos("pivot")[0];
        if (pos("comp").some((k) => k > pv)) return "A compensatable step comes after the pivot. If it fails, you can't undo the carrier booking. Do everything that can be undone first.";
        if (pos("retry").some((k) => k < pv)) return "A step that can't be compensated runs before the pivot. If the pivot then fails, there's no way to undo it.";
        return true;
      },
      solve: need0(role),
      bad: v3 ? [[1, 2, 4, 6, 7, 8], [0, 3, 4, 6, 7, 8], [0, 2, 4, 7, 6, 8]] : [[0, 1, 3, 2, 4, 5], [0, 1, 2, 4, 3, 5], [6, 0, 1, 2, 3, 4, 5]],
      role,
    };
  }
  function need0(role) { const ord = ["start", "comp", "pivot", "retry"]; return ord.flatMap((r) => role.map((x, i) => (x === r ? i : -1)).filter((i) => i >= 0)); }

  /* ---------- exactly-once code review (scenario 14) ---------- */
  function eoLines(I) {
    const L = (t, k = " ") => ({ t, k });
    if (I.lv === 1) return { file: "refunds/consumer.py", bug: [9], lines: [
      L("@@ def run(): @@", "@"),
      L(`conf = {"bootstrap.servers": BROKERS, "group.id": "${I.group}",`),
      L(`        "enable.auto.commit": True}`, "-"),
      L(`        "enable.auto.commit": False}`, "+"),
      L("consumer = Consumer(conf)"),
      L(`consumer.subscribe(["${I.topic}"])`),
      L("while True:"),
      L("    msg = consumer.poll(1.0)"),
      L("    if msg is None or msg.error(): continue"),
      L("    consumer.commit(message=msg, asynchronous=False)  # don't reprocess slow refunds", "+"),
      L("    req = json.loads(msg.value())"),
      L(`    psp.refund(req["payment_id"], req["amount"], idempotency_key=req["refund_id"])`),
      L("    consumer.commit(message=msg)", "-"),
    ] };
    if (I.lv === 2) return { file: "billing/worker.py", bug: [6], lines: [
      L("@@ def on_message(msg): @@", "@"),
      L("    evt = json.loads(msg.value())"),
      L("    # processed.event_id is the PRIMARY KEY", "+"),
      L(`    if db.fetchone("SELECT 1 FROM processed WHERE event_id = %s", [evt["event_id"]]):`, "+"),
      L("        consumer.commit(message=msg)", "+"),
      L("        return", "+"),
      L(`    psp.charge(evt["customer_id"], evt["amount_cents"], currency=evt["currency"])`, "+"),
      L(`    db.execute("INSERT INTO processed (event_id) VALUES (%s)", [evt["event_id"]])`, "+"),
      L("    consumer.commit(message=msg)"),
    ] };
    return { file: "wallets/consumer.py", bug: [2], lines: [
      L("@@ def on_message(msg): @@", "@"),
      L("    evt = json.loads(msg.value())"),
      L("    dedupe_key = f\"{msg.topic()}:{msg.partition()}:{msg.offset()}\"", "+"),
      L("    with db.transaction():", "+"),
      L(`        inserted = db.execute("INSERT INTO processed (key) VALUES (%s) ON CONFLICT DO NOTHING", [dedupe_key]).rowcount`, "+"),
      L("        if inserted:", "+"),
      L(`            db.execute("UPDATE wallets SET balance = balance + %s WHERE id = %s", [evt["amount"], evt["wallet_id"]])`, "+"),
      L("    consumer.commit(message=msg)", "+"),
    ] };
  }

  LB.addAll("dist", [
    /* 8 */ {
      id: "dist-fencing-token",
      name: "The paused leader writes anyway",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        const [a, b] = R.sample(["worker-1", "worker-2", "worker-3", "compactor-a", "compactor-b"], 2);
        return { lv, kind: ["none", "check", "redis"][lv - 1], a, b, tok: R.int(30, 90), ttl: R.pick([10, 15, 30]), pause: R.pick([25, 40, 45]), file: R.pick(["s3://reports/daily.parquet", "gs://ledger/snapshot.json", "/data/compaction/manifest"]) };
      },
      ...laneScenario(fenceModel),
      text: (I) => I.kind === "none"
        ? `<p>Two workers use a lease from a lock service so only one writes <code>${esc(I.file)}</code> at a time. The storage accepts any write. ${esc(I.a)} occasionally hits ${I.pause} s GC pauses; the lease TTL is ${I.ttl} s. Build a schedule where storage ends up with <b>A's stale data overwriting B's</b>.</p>`
        : I.kind === "check"
          ? `<p>After an incident the team added fencing tokens, implemented in the app: each worker <code>SELECT</code>s the highest token seen, and writes only if its own is not lower. Find a schedule where <b>a stale write still lands after the newer holder's</b>.</p>`
          : `<p>Fencing is now enforced atomically by storage (a conditional write rejecting tokens lower than the highest seen). The lock and the token counter live in Redis with an async replica and automatic failover. Find a schedule where storage accepts a write from the <b>old holder after the new holder's</b>.</p>`,
      hint: (I) => I.kind === "none" ? "Let A take the lease, then expire it while A is paused." : I.kind === "check" ? "The check and the write are separate steps. What can happen in between?" : "A token only helps if it's never handed out twice. What does an async failover do to the counter?",
      concept: "Fencing tokens",
      how: "A lease holder can't know it has lost the lease: a GC pause, VM freeze or network delay can stop it for longer than the TTL, and it then resumes and writes as if nothing happened. A fencing token is a number that increases every time the lease is granted; the resource being protected remembers the highest token it has accepted and rejects lower ones. Two things must hold for this to work: the check and the write must be one atomic operation at the storage (a conditional write, compare-and-set, or a version column), and the token source itself must never go backwards, which means it has to live in a linearizable store (etcd, ZooKeeper, a consensus-backed lock service), not an asynchronously replicated cache.",
      rule: "Leases give you mostly-one leader; fencing tokens checked atomically by the storage give you safety. Generate tokens from a consensus-backed store.",
      why: (I) => I.kind === "none" ? `${esc(I.a)} took the lease, froze for ${I.pause} s, and resumed after its ${I.ttl} s lease expired and ${esc(I.b)} had written. Nothing at the storage could tell the writes apart.` : I.kind === "check" ? "Both workers passed the check before either wrote, so the check proved nothing by the time A wrote. Move it into the storage: e.g. UPDATE ... WHERE last_token <= :token, or a conditional put." : `The failover rolled the lock and the counter back, so ${esc(I.b)} got the lock and the same token ${I.tok} that ${esc(I.a)} still held. Storage can't distinguish equal tokens. Use a consensus-backed lock (etcd revision, ZooKeeper zxid) as the token source.`,
    },
    /* 9 */ {
      id: "dist-lease-timing",
      name: "Tune the leader lease",
      kind: "Config change",
      skills: ["tune", "safe"],
      w: "tune",
      sense: "min",
      vname: "a score of",
      gen(lv, R) {
        return { lv, miss: lv === 3 ? 3 : 2, jump: R.pick([0.8, 1.5]), pause: lv === 2 ? R.pick([1.2, 1.8]) : lv === 3 ? R.pick([18, 25]) : 0, target: lv === 1 ? 15 : 10, svc: R.pick(["the scheduler", "the shard-assignment leader", "the billing cron leader"]) };
      },
      text: (I) => `<p>${esc(I.svc).replace(/^./, (c) => c.toUpperCase())} holds a lease from the lock service. The leader renews every <i>renew</i> seconds and stops acting once its own timer says less than <i>margin</i> remains of the TTL. Requirements:</p><ul>
        <li>Keep leadership through <b>${I.miss} consecutive lost renewals</b>.</li>
        <li>Never act after the lock service considers the lease expired. ${I.lv === 1 ? `Hosts run chronyd; operators have seen NTP <b>step</b> wall clocks by up to ${I.jump} s.` : I.lv === 2 ? `Profiling shows stop-the-world GC pauses of up to <b>${I.pause} s</b> between the lease check and the write.` : `Besides GC, live migration has frozen VMs for up to <b>${I.pause} s</b> (rare, but it happened twice this quarter).`}</li>
        <li>Failover after the leader dies (≈ TTL) within <b>${I.target} s</b>.</li></ul><p>Find the setting with the fastest failover; among those, renew as rarely as possible.</p>`,
      ui: (I) => {
        const knobs = [];
        if (I.lv === 1) knobs.push({ k: "clock", label: "Leader's lease timer", opts: ["wall", "monotonic"], fmt: (v) => (v === "wall" ? "wall clock (CLOCK_REALTIME)" : "monotonic (CLOCK_MONOTONIC)") });
        knobs.push({ k: "ttl", label: "Lease TTL", opts: [2, 5, 10, 15, 30], unit: "s" }, { k: "renew", label: "Renew every", opts: [0.5, 1, 2, 5], unit: "s" }, { k: "margin", label: "Safety margin", opts: [0, 0.5, 1, 2, 5], unit: "s", help: "leader stops when less than this remains" });
        if (I.lv === 3) knobs.push({ k: "fence", label: "Fencing tokens checked by storage", opts: ["off", "on"] });
        return { knobs, live: (cfg) => { const r = leaseEval(I, cfg); return K.metrics([
          { name: "Failover", value: `≈ ${cfg.ttl} s`, ok: r.fast, target: `≤ ${I.target} s` },
          { name: "Renewal slack", value: `${K.num(r.slack, 1)} s`, ok: r.live, target: `TTL − margin − ${I.miss + 1} × renew > 0` },
          { name: "Safety", value: r.fenced ? "fenced" : `margin ${cfg.margin} s vs ${r.hazard} s`, ok: r.safe, target: r.fenced ? "storage rejects stale tokens" : "margin must cover the hazard" },
        ]) + (r.ok ? K.note("Meets every requirement.", "good") : ""); } };
      },
      valid: (I, cfg) => { const r = leaseEval(I, cfg); if (!r.safe) return `a ${r.hazard} s ${I.lv === 1 ? "clock step" : "pause"} can make the leader act after its lease expired`; if (!r.live) return `${I.miss} lost renewals would drop a healthy leader`; if (!r.fast) return `failover takes about ${cfg.ttl} s`; return true; },
      val: (I, cfg) => cfg.ttl * 1000 - cfg.renew * 10,
      vfmt: (v) => `TTL ${Math.ceil(v / 1000)} s`,
      hint: (I) => I.lv === 1 ? "Which clock can jump? Leases should measure elapsed time, not time of day." : I.lv === 2 ? "The margin has to cover the longest pause between checking the lease and acting on it." : "No margin that fits the failover target can cover that freeze. What makes a late write harmless instead of impossible?",
      concept: "Leases, clocks and pauses",
      how: "A lease is only safe if the holder's view of expiry is never later than the grantor's. Measure lease time with a monotonic clock, starting when you sent the request: wall clocks can be stepped by NTP or an operator, in either direction. Clock rates drift by parts per million, which a small margin covers. Process pauses are the real killer: if the holder can stall between 'my lease is valid' and the write, the margin must exceed the longest stall, which pushes TTL (and therefore failover time) up. When stalls are unbounded, no margin works; fencing tokens make a late write harmless instead.",
      rule: "Use monotonic time for leases, size TTL ≥ margin + (missed renewals + 1) × renew interval, and add fencing whenever a pause longer than the margin is possible.",
      why: (I, sol) => `TTL ${sol.ttl} s, renew every ${sol.renew} s, margin ${sol.margin} s${sol.clock ? ", " + sol.clock + " clock" : ""}${sol.fence === "on" ? ", fencing on" : ""}. ${I.lv === 1 ? `A wall-clock timer would need a ${I.jump}+ s margin; monotonic time can't be stepped.` : I.lv === 2 ? `The margin must cover the ${I.pause} s pause, and the slack must still absorb ${I.miss} lost renewals.` : `Covering a ${I.pause} s freeze would need TTL > ${I.target} s; fencing makes the stale leader's writes bounce instead.`}`,
    },
    /* 10 */ {
      id: "dist-hash-keys-moved",
      name: "How many keys move?",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        const keys = R.pick([24, 36, 48, 60, 120]);
        const n = lv === 3 ? R.int(6, 12) : R.int(4, 9);
        return { lv, keys, n, store: R.pick(["the session cache", "the rate-limit counters", "the feature-store shards", "the object metadata store"]) };
      },
      text: (I) => I.lv === 1 ? `<p>${esc(I.store).replace(/^./, (c) => c.toUpperCase())} holds <b>${I.keys} million</b> keys spread over <b>${I.n}</b> nodes with consistent hashing (256 virtual nodes each, so ownership is even). You add one node. About how many keys (in millions) change owner?</p>`
        : I.lv === 2 ? `<p>${esc(I.store).replace(/^./, (c) => c.toUpperCase())} holds <b>${I.keys} million</b> keys and picks the node with <code>hash(key) % ${I.n}</code>. Traffic is up, so you go to ${I.n + 1} nodes. About how many keys (in millions) now map to a different node and become cache misses or must be migrated?</p>`
          : `<p>${esc(I.store).replace(/^./, (c) => c.toUpperCase())} holds <b>${I.keys} million</b> keys on a consistent-hash ring of <b>${I.n}</b> equal nodes, with <b>replication factor 3</b> (each key on 3 distinct nodes). One node is decommissioned. About how many key <b>copies</b> (in millions) must be streamed to restore 3 replicas everywhere?</p>`,
      ui: () => ({ unit: "million" }),
      accept: LB.near((I) => (I.lv === 1 ? I.keys / (I.n + 1) : I.lv === 2 ? (I.keys * I.n) / (I.n + 1) : (3 * I.keys) / I.n), 0.15),
      solve: (I) => K.round(I.lv === 1 ? I.keys / (I.n + 1) : I.lv === 2 ? (I.keys * I.n) / (I.n + 1) : (3 * I.keys) / I.n, 1),
      bad: (I) => I.lv === 1 ? [(I.keys * I.n) / (I.n + 1), I.keys / 2] : I.lv === 2 ? [I.keys / (I.n + 1)] : [I.keys / I.n, I.keys * 3],
      hint: (I) => I.lv === 1 ? "The new node takes an equal share from everyone. What's its share?" : I.lv === 2 ? "A key stays put only if hash % N equals hash % (N+1). How often does that happen?" : "The departing node held 3 × keys / N replica copies. Each must be recreated somewhere.",
      concept: "Consistent hashing vs. modulo hashing",
      how: "With hash(key) % N, changing N remaps almost every key: going from N to N+1 nodes keeps a key in place only about 1/(N+1) of the time, so roughly N/(N+1) of keys move, which for a cache means a near-total miss storm. Consistent hashing places nodes (or many virtual nodes per node) on a ring and assigns each key to the next node clockwise, so adding a node moves only the keys it takes over, about 1/(N+1) of them, and removing one moves only its own share. With replication factor R, a departing node held about R/N of all key copies, all of which must be re-replicated.",
      rule: "Never shard with hash % N when N changes; use consistent or rendezvous hashing, and budget for re-replicating a whole node's data (R × keys / N copies) when one leaves.",
      why: (I, sol) => I.lv === 1 ? `${I.keys}M / ${I.n + 1} ≈ ${K.num(sol, 1)}M keys move to the new node; nothing else changes owner.` : I.lv === 2 ? `Only about 1/${I.n + 1} of keys stay put, so ≈ ${K.num(sol, 1)}M of ${I.keys}M move. Consistent hashing would move about ${K.num(I.keys / (I.n + 1), 1)}M.` : `The node held 3 × ${I.keys}M / ${I.n} ≈ ${K.num(sol, 1)}M copies; each needs a new home.`,
    },
    /* 11 */ {
      id: "dist-vnodes-balance",
      name: "Balance the hash ring",
      kind: "Capacity plan",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "total virtual nodes:",
      gen(lv, R) {
        const pre = R.pick(["cache", "kv", "shard", "store"]), ids = R.distinct(lv === 1 ? 4 : 6, 10, 99);
        const nodes = ids.map((x, i) => ({ name: `${pre}-${x}`, cls: lv === 1 ? "v" : i < (lv === 2 ? 1 : 2) ? "big" : "small", cap: lv === 1 ? 1 : i < (lv === 2 ? 1 : 2) ? 2 : 1 }));
        const I = { lv, nodes, target: lv === 1 ? 1.15 : 1.2, ftarget: 1.35 };
        const ui = this.ui(I);
        let ok = false;
        for (const cfg of LB.byId.get("dist-vnodes-balance").space(I, ui)) if (this.valid(I, cfg) === true) { ok = true; break; }
        return ok ? I : null;
      },
      text: (I) => `<p>${I.nodes.length} nodes share a consistent-hash ring${I.lv > 1 ? `; ${I.nodes.filter((n) => n.cls === "big").map((n) => esc(n.name)).join(" and ")} ${I.lv === 2 ? "has" : "have"} <b>twice the RAM and CPU</b> of the others` : ""}. Each virtual node is a token on the ring; more tokens smooth out ownership but cost gossip, metadata and longer rebalances.</p>
        <p>Keep every node's load within <b>${Math.round((I.target - 1) * 100)}%</b> of its fair share (by capacity)${I.lv === 3 ? `, and after <b>any single node fails</b>, within <b>${Math.round((I.ftarget - 1) * 100)}%</b> of the fair share among the survivors` : ""}, with the fewest total virtual nodes. The ring below is computed from the real token hashes.</p>`,
      ui: (I) => {
        const opts = [1, 2, 4, 8, 16, 32, 64, 128, 256];
        const knobs = I.lv === 1 ? [{ k: "v", label: "Virtual nodes per node", opts }] : [{ k: "small", label: "Virtual nodes per standard node", opts }, { k: "big", label: "Virtual nodes per big node", opts }];
        return { knobs, live: (cfg) => { const r = vnodeEval(I, cfg); return K.bars(r.nodes.map((n, i) => ({ label: esc(n.name) + (n.cap > 1 ? " (2×)" : ""), value: r.r[i], cls: r.r[i] > I.target ? "bad" : "good", note: K.pct(r.r[i] - 1 >= 0 ? r.r[i] - 1 : r.r[i] - 1, 0).replace(/^(?!-)/, "+") + " vs fair" })), { max: Math.max(1.6, ...r.r) }) + K.metrics([{ name: "Worst node", value: `${K.num(r.max, 2)}× fair`, ok: r.max <= I.target, target: `≤ ${I.target}×` }, ...(I.lv === 3 ? [{ name: "Worst after a failure", value: `${K.num(r.worstFail, 2)}× (${esc(r.failName)} down)`, ok: r.worstFail <= I.ftarget, target: `≤ ${I.ftarget}×` }] : []), { name: "Total tokens", value: String(r.total), ok: null }]); } };
      },
      valid: (I, cfg) => { const r = vnodeEval(I, cfg); if (r.max > I.target) return `the hottest node carries ${K.num(r.max, 2)}× its fair share`; if (I.lv === 3 && r.worstFail > I.ftarget) return `with ${r.failName} down, a survivor carries ${K.num(r.worstFail, 2)}× its share`; return true; },
      val: (I, cfg) => vnodeEval(I, cfg).total,
      hint: (I) => I.lv === 1 ? "With a handful of tokens per node, arcs are wildly uneven; imbalance shrinks roughly like 1/√tokens." : I.lv === 2 ? "Ownership is proportional to token count. A node with twice the capacity needs about twice the tokens." : "When a node dies, each of its arcs goes to the next token clockwise. More tokens spread that load across more survivors.",
      concept: "Virtual nodes and ring balance",
      how: "With one token per node, a consistent-hash ring splits into arcs of very different sizes, so some nodes own several times the average. Giving each node many virtual nodes (tokens) averages those arcs out; the spread shrinks roughly as 1/√(tokens per node). Token count also lets you weight heterogeneous hardware: ownership is proportional to tokens. When a node fails, each of its arcs moves to the next token clockwise, so many small arcs spread its load across many survivors instead of dumping it on one neighbour. The cost is metadata, gossip and rebalance work that grows with the token count.",
      rule: "Use enough virtual nodes to keep imbalance inside your headroom (tens to a few hundred per node), weight them by capacity, and check the 'one node down' distribution, not just the steady state.",
      why: (I, sol) => { const r = vnodeEval(I, sol); return `${I.lv === 1 ? sol.v + " tokens per node" : `${sol.small} per standard node and ${sol.big} per big node`}: worst node at ${K.num(r.max, 2)}× fair share${I.lv === 3 ? `, ${K.num(r.worstFail, 2)}× after the worst single failure` : ""}, ${r.total} tokens in total.`; },
    },
    /* 12 */ {
      id: "dist-2pc-blocking",
      name: "Strand the two-phase commit",
      kind: "Experiment",
      skills: ["diagnose", "design"],
      gen(lv, R) {
        const p = lv === 3 ? 3 : 2;
        return { lv, p, names: R.sample(["orders-db", "inventory-db", "ledger-db", "payments-db", "loyalty-db"], p) };
      },
      ...laneScenario(tpcModel),
      text: (I) => `<p>A transaction spans ${I.names.map(esc).join(", ")} using two-phase commit; a coordinator drives it. Participants that voted YES keep their row locks until they hear the decision. ${I.lv === 1 ? "Build a schedule that leaves at least one participant <b>blocked</b>: holding locks with no way to finish." : I.lv === 2 ? "Participants run the <b>cooperative termination protocol</b>: an in-doubt participant asks the others, and if any of them knows the decision (or never voted, so can abort), everyone can finish. Build a schedule that blocks them anyway." : "With cooperative termination, find a schedule where the coordinator <b>had already durably decided COMMIT</b>, yet every participant is stuck holding locks."}</p>`,
      hint: (I) => I.lv === 1 ? "A participant is in doubt between voting YES and hearing the decision." : I.lv === 2 ? "Cooperation only helps if someone knows something. When does nobody?" : "The decision must reach the coordinator's log but not leave the coordinator.",
      concept: "2PC is a blocking protocol",
      how: "In two-phase commit, a participant that votes YES promises to commit if told to, so it must keep its locks and can't decide alone: committing might contradict an abort, aborting might contradict a commit already applied elsewhere. If the coordinator fails after collecting the votes and before telling anyone the outcome, all participants are stuck until it recovers and reads its log. Asking other participants helps only if one of them has heard the decision or never voted. That is why 2PC across services ties your availability to the coordinator; consensus-replicated coordinators (as in Spanner-style systems) or sagas avoid the single blocking point.",
      rule: "Use 2PC only inside one system with a highly available (replicated) coordinator; across services, prefer sagas with compensations, and always alert on long-lived prepared transactions.",
      why: (I) => I.lv === 3 ? "Every participant voted YES and the coordinator fsynced COMMIT, then died before sending it. Nobody else knows the outcome and nobody can abort, so the locks stay held until the coordinator's log is readable again." : "Every participant that voted YES is waiting for a decision only the dead coordinator has; nobody can safely commit or abort.",
    },
    /* 13 */ {
      id: "dist-saga-compensation",
      name: "Plan the saga",
      kind: "Design review",
      skills: ["design", "safe"],
      w: "steps",
      gen(lv, R) {
        return { lv, trip: "T-" + R.int(1000, 9999), h: "H-" + R.int(100, 999), f: "F-" + R.int(100, 999), ord: "ord_" + R.int(10000, 99999) };
      },
      text: (I) => I.lv === 1 ? `<p>Trip booking is a saga across three services: (1) hold a seat on the flight, (2) reserve the hotel, (3) charge the card. For trip <b>${esc(I.trip)}</b>, steps 1 and 2 succeeded and the card was <b>declined</b>. Choose the steps to run now, in order.</p>`
        : `<p>Checkout spans inventory, payments and a shipping carrier; there is no shared database. Design the order of the saga's forward steps so that a failure at <b>any</b> step can be handled: either undone by compensations or completed by retries.${I.lv === 3 ? " Steps are retried on timeouts and run concurrently with other checkouts for the same stock, so choose the variants that stay correct under retries and concurrent sagas." : ""}</p>`,
      ui: (I) => { const S = sagaSpec(I); return { opts: S.opts, live: (seq) => {
        if (!seq || !seq.length || I.lv === 1) return "";
        const rows = seq.map((i, k) => { const r = S.role[i]; const before = seq.slice(0, k); const pivotDone = before.some((j) => S.role[j] === "pivot"); return [esc(S.opts[i].split(" (")[0]), r === "trap" ? "<b>unsafe step</b>" : pivotDone ? "retry until it succeeds" : `compensate ${before.filter((j) => S.role[j] === "comp").length} earlier step(s) in reverse`]; });
        return K.table(["if this step fails", "recovery"], rows, { compact: true });
      } }; },
      accept: (I, seq) => sagaSpec(I).check(seq),
      solve: (I) => sagaSpec(I).solve,
      bad: (I) => sagaSpec(I).bad,
      hint: (I) => I.lv === 1 ? "Undo only what actually happened, then record the outcome." : "Compensatable steps first, then the single step that can't be undone (the pivot), then steps that can only be retried.",
      concept: "Sagas, compensations and the pivot",
      how: "A saga replaces one distributed transaction with a sequence of local transactions, each with a compensating action that semantically undoes it (release, void, refund). Compensations run in reverse for the steps that completed; nothing rolls back automatically. Order matters: all compensatable steps go before the pivot (the first step that can't be undone), and everything after the pivot must be retriable until it succeeds. Because there's no isolation, other flows can see intermediate state: a PENDING status acts as a semantic lock. Steps and compensations are retried, so each must be idempotent, keyed by the saga or order id.",
      rule: "Compensatable → pivot → retriable. Make every step and compensation idempotent with a stable key, and expose intermediate state only behind a PENDING-style semantic lock.",
      why: (I, sol) => I.lv === 1 ? "Only the seat hold and the hotel reservation completed, so only they need compensating; the trip is then marked failed and the customer told." : `Plan: ${sol.map((i) => esc(sagaSpec(I).opts[i].split(" (")[0])).join(" → ")}. If anything before the carrier booking fails, the earlier steps are compensated; after it, the remaining steps are retried until they succeed.`,
    },
    /* 14 */ {
      id: "dist-exactly-once-review",
      name: "Review the exactly-once consumer",
      kind: "Code review",
      skills: ["diagnose", "safe"],
      w: "lines",
      gen(lv, R) { return { lv, topic: R.pick(["refunds.requested", "refund-requests", "payments.refunds"]), group: R.pick(["refunds", "refund-worker", "psp-refunds"]) }; },
      text: (I) => I.lv === 1 ? `<p>The PR description says: "Make refunds exactly-once: commit offsets manually." The payment provider dedupes on <code>idempotency_key</code>. Flag the line that breaks the guarantee.</p>`
        : I.lv === 2 ? `<p>The billing worker consumes <code>charge.requested</code> events (delivered at least once) and is supposed to charge each customer exactly once. Flag the line that still allows a double charge after a crash or a rebalance.</p>`
          : `<p>The wallet consumer credits balances. The event is produced from an outbox by a relay that, after a crash, can publish the same event again (at-least-once). The dedupe insert and the balance update share a database transaction. Flag the line that still lets a wallet be credited twice.</p>`,
      ui: (I) => { const c = eoLines(I); return { lines: c.lines, file: c.file, k: 1 }; },
      ans: (I) => eoLines(I).bug,
      diag: (I) => I.lv === 1 ? "Not that one. Think about a crash between two specific lines: what is lost?" : I.lv === 2 ? "Not that one. Imagine the process dies right after the external call: what happens on redelivery?" : "Not that one. When the same event is published twice, would this code recognise the second copy?",
      hint: (I) => I.lv === 1 ? "What happens if the process crashes after committing the offset but before the refund call?" : I.lv === 2 ? "The dedupe table protects the database, not the payment provider." : "A dedupe key must be identical for every copy of the same logical event.",
      concept: "Exactly-once = at-least-once + idempotency",
      how: "Messaging systems deliver at least once (or at most once); 'exactly once' is something the consumer builds by making the effect idempotent. Commit the offset only after the effect is durable, so a crash means redelivery rather than loss. For effects inside your database, record the message's dedupe key in the same transaction as the effect. For external side effects (a payment provider), pass a stable idempotency key so the provider dedupes. The key must identify the logical event (an event id set by the producer, or a business key), not the delivery: offsets, timestamps and fresh UUIDs differ between copies of the same event.",
      rule: "Commit after the effect, dedupe on a key the producer assigns to the logical event, and pass that key to every external system that supports one.",
      why: (I) => I.lv === 1 ? "Committing first turns the pipeline into at-most-once: a crash after the commit and before psp.refund loses that refund forever. The provider's idempotency key already makes redelivery safe, so commit after the call." : I.lv === 2 ? "If the worker dies after psp.charge and before the INSERT, the event is redelivered, the SELECT finds nothing, and the customer is charged again. Pass event_id as the provider's idempotency key." : "Two copies of the same event published by the relay land at different offsets, so topic:partition:offset differs and both are applied. Dedupe on the event id from the outbox row.",
    },
  ]);
  /* ---------- request simulator with correct units (all times in ms) ----------
     o: { seed, dur (s), rateAt(t s), servers, svcAt(t s, R) ms, timeout ms, retries, backoff ms, jitter, budget (retry tokens per request, null = unlimited),
          dropExpired (server skips requests whose client already gave up), queueMax, retryOn503 } */
  function rsim(o) {
    const R = rng(o.seed), dur = o.dur, nb = Math.ceil(dur);
    const heap = [];
    const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].t <= heap[i].t) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].t < heap[m].t) m = l; if (r < heap.length && heap[r].t < heap[m].t) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    let maxRate = 0; for (let t = 0; t < dur; t += 0.25) maxRate = Math.max(maxRate, o.rateAt(t));
    { let t = 0; for (;;) { t += K.exp(R, 1 / maxRate); if (t >= dur) break; if (R.next() * maxRate <= o.rateAt(t)) push({ t: t * 1000, k: "arr", req: { t0: t * 1000, att: 0, done: false, given: false } }); } }
    const S = { n: 0, ok: 0, attempts: 0, lat: [], wasted: 0, rejected: 0 };
    const offered = Array(nb).fill(0), good = Array(nb).fill(0), att = Array(nb).fill(0), qd = Array(nb).fill(0);
    const B = (ms) => Math.min(nb - 1, Math.floor(ms / 1000));
    const q = []; let qh = 0, busy = 0, tokens = 10;
    const timeout = o.timeout || Infinity, qmax = o.queueMax == null ? Infinity : o.queueMax;
    const retry = (req, t) => {
      if (req.att >= (o.retries || 0) || req.done) return false;
      if (o.budget != null) { if (tokens < 1) return false; tokens -= 1; }
      const base = (o.backoff || 0) * 2 ** req.att, d = o.jitter ? R.next() * base : base;
      req.att++; push({ t: t + d, k: "arr", req, retry: true }); return true;
    };
    const start = (t) => {
      while (busy < o.servers && qh < q.length) {
        const job = q[qh++];
        if (o.dropExpired && (job.req.done || job.dead || t - job.ta > timeout)) continue;
        busy++; push({ t: t + o.svcAt(t / 1000, R), k: "done", job });
      }
      if (qh > 4096 && qh * 2 > q.length) { q.splice(0, qh); qh = 0; }
    };
    while (heap.length) {
      const e = pop();
      if (e.t > dur * 3000) break;
      if (e.t < dur * 1000) qd[B(e.t)] = Math.max(qd[B(e.t)], q.length - qh);
      if (e.k === "arr") {
        const req = e.req;
        if (!e.retry) { S.n++; if (e.t < dur * 1000) offered[B(e.t)]++; if (o.budget != null) tokens = Math.min(50, tokens + o.budget); }
        S.attempts++; if (e.t < dur * 1000) att[B(e.t)]++;
        const u = R.next();
        if (o.failP && u < o.failP) { if (!retry(req, e.t)) req.given = true; continue; }
        if (o.lossP && u < (o.failP || 0) + o.lossP) { push({ t: e.t + timeout, k: "to", job: { req, ta: e.t, att: req.att, lost: true } }); continue; }
        if (q.length - qh >= qmax) { S.rejected++; if (!(o.retryOn503 && retry(req, e.t))) req.given = true; continue; }
        const job = { req, ta: e.t, att: req.att };
        q.push(job);
        if (timeout < Infinity) push({ t: e.t + timeout, k: "to", job });
        start(e.t);
      } else if (e.k === "done") {
        busy--;
        const job = e.job;
        if (job.dead || job.req.done) S.wasted++;
        else { job.req.done = true; S.ok++; S.lat.push(e.t - job.req.t0); if (e.t < dur * 1000) good[B(e.t)]++; }
        start(e.t);
      } else {
        const job = e.job;
        if (job.req.done) continue;
        job.dead = true;
        if (job.att !== job.req.att) continue;
        if (o.retryOn === "errors" || !retry(job.req, e.t)) job.req.given = true;
      }
    }
    return { ...S, offered, good, att, qd, p99: K.quantile(S.lat, 0.99), succ: S.n ? S.ok / S.n : 1, amp: S.n ? S.attempts / S.n : 1 };
  }
  const simChart = (r, o) => K.chart([{ name: "offered (req/s)", pts: r.offered, cls: "s0" }, { name: "attempts incl. retries", pts: r.att, cls: "bad" }, { name: "goodput", pts: r.good, cls: "good" }], { title: o.title || "Requests per second", xlabel: "s", vline: o.vline, h: 150 });

  /* retry storm (scenario 15) */
  function retryRun(I, cfg) {
    const svc = I.svc;
    return rsim({ seed: I.seed, dur: I.dur, rateAt: () => I.rate, servers: I.servers, svcAt: (t, R) => K.exp(R, t >= I.b0 && t < I.b1 ? svc * I.slow : svc), timeout: cfg.timeout || I.timeout, retries: cfg.retries, backoff: cfg.backoff, jitter: cfg.jitter === "on", budget: cfg.budget === "10%" ? 0.1 : null, dropExpired: I.lv === 3 && cfg.drop === "on", retryOn: cfg.on || "all", failP: I.failP, lossP: I.lossP });
  }
  function retryJudge(I, cfg, r) {
    const tail = r.good.slice(-I.tail), offT = r.offered.slice(-I.tail);
    const rec = K.sum(tail) / Math.max(1, K.sum(offT));
    const errs = [];
    if (rec < I.recNeed) errs.push(`in the last ${I.tail} s, after the dependency is healthy again, only ${K.pct(rec, 0)} of requests succeed${rec < 0.5 ? " (metastable failure)" : ""}`);
    if (r.succ < I.need) errs.push(`overall success ${K.pct(r.succ, 1)} is below ${K.pct(I.need, 1)}`);
    return { rec, errs };
  }

  /* load shedding (scenario 19) */
  function shedRun(I, cfg) {
    return rsim({ seed: I.seed, dur: I.dur, rateAt: (t) => (t >= I.o0 && t < I.o1 ? I.cap * I.over : I.cap * 0.7), servers: I.servers, svcAt: (t, R) => K.exp(R, I.svc), timeout: I.timeout, queueMax: cfg.queue === "unbounded" ? Infinity : cfg.queue, dropExpired: cfg.drop === "on", retries: I.lv >= 2 ? 3 : 0, retryOn503: I.lv >= 2 });
  }
  function shedJudge(I, cfg, r) {
    const win = U.range(I.o1 - I.o0 - 2).map((i) => i + I.o0 + 2);
    const gp = K.mean(win.map((t) => r.good[t]));
    const after = K.sum(r.good.slice(I.o1 + 3)) / Math.max(1, K.sum(r.offered.slice(I.o1 + 3)));
    const errs = [];
    if (gp < I.cap * 0.85) errs.push(`goodput during the overload is ${K.num(gp)} req/s, under 85% of capacity (${K.num(I.cap * 0.85)})`);
    if (r.p99 > I.slo) errs.push(`p99 of successful requests is ${K.ms(r.p99)} (SLO ${I.slo} ms)`);
    if (after < 0.95) errs.push(`after the spike only ${K.pct(after, 0)} of requests succeed`);
    return { gp, after, errs };
  }

  /* circuit breaker (scenario 16) */
  const cbCache = new Map();
  function breakerRun(I, cfg) {
    const ck = `${I.seed}/${I.rate}/${I.dur}`;
    let calls = cbCache.get(ck);
    if (!calls) { const R = rng(I.seed); calls = []; let t = 0; for (;;) { t += K.exp(R, 1 / I.rate); if (t >= I.dur) break; calls.push([t, R.next()]); } cbCache.set(ck, calls); }
    const errAt = (x) => (x >= I.o0 && x < I.o1 ? 1 : I.burst && x % I.burst.every < I.burst.len ? I.burst.p : I.e);
    let st = "closed", win = [], openUntil = 0, probes = 0, okProbes = 0, sentP = 0;
    const trips = [], states = [];
    let wasted = 0, closedAt = null, fails = 0, rejected = 0, sent = 0;
    for (const [x, u] of calls) {
      if (st === "open" && x >= openUntil) { st = "half"; probes = 0; okProbes = 0; sentP = 0; }
      let send = false;
      if (st === "closed") send = true;
      else if (st === "half" && sentP < cfg.probes) { send = true; sentP++; }
      if (!send) { rejected++; continue; }
      sent++;
      const fail = u < errAt(x);
      if (x >= I.o0 && x < I.o1) wasted++;
      if (fail) fails++;
      if (st === "closed") {
        win.push(fail ? 1 : 0); if (win.length > cfg.window) win.shift();
        if (win.length >= cfg.window && K.sum(win) / win.length >= cfg.thr / 100) { st = "open"; openUntil = x + cfg.wait; trips.push(x); }
      } else {
        if (fail) { st = "open"; openUntil = x + cfg.wait; }
        else if (++okProbes >= cfg.probes) { st = "closed"; win = []; if (x >= I.o1 && closedAt == null) closedAt = x; }
      }
      states.push([x, st]);
    }
    const falseTrips = trips.filter((x) => x < I.o0 || x >= I.o1).length;
    const openedInOutage = trips.some((x) => x >= I.o0 && x < I.o1);
    const recovery = !openedInOutage ? 0 : closedAt == null ? Infinity : closedAt - I.o1;
    return { falseTrips, wasted, recovery, openedInOutage, trips, sent, rejected };
  }

  /* bulkheads (scenario 17) */
  const p99wait = (lam, mu, c) => { const x = K.mmc(lam, mu, c); if (x.rho >= 1) return Infinity; return x.pw <= 0.01 ? 0 : Math.log(x.pw / 0.01) / (c * mu - lam); };
  function bulkEval(I, cfg) {
    const shared = cfg.mode === "shared";
    const to = I.lv === 1 ? I.to : cfg.to;
    const lamB = I.rb * (I.lv === 3 ? 1 + cfg.retries : 1);
    const total = cfg.a + cfg.b;
    const busyB = shared ? Math.min(total, lamB * to) : Math.min(cfg.b, lamB * to);
    const forA = shared ? total - busyB : cfg.a;
    const waitA = forA <= 0 ? Infinity : p99wait(I.ra, 1000 / I.sa, Math.floor(forA)) * 1000;
    const pA = waitA + I.sa * 4.6;
    const healthyB = p99wait(I.rbPeak, 1000 / I.sb, cfg.b) * 1000;
    const rhoB = (I.rbPeak * I.sb) / 1000 / cfg.b;
    const errs = [];
    if (!(pA <= I.sloA)) errs.push(`during the ${esc(I.depB)} outage, ${esc(I.depA)} calls see p99 ${Number.isFinite(pA) ? K.ms(pA) : "∞ (no threads left)"} (SLO ${I.sloA} ms)`);
    if (to * 1000 < I.pB) errs.push(`a ${to * 1000} ms timeout cuts off healthy ${esc(I.depB)} calls (their p99 is ${I.pB} ms)`);
    if (rhoB >= 0.8 || healthyB > 50) errs.push(`the ${esc(I.depB)} pool is too small for its normal peak (${K.num(I.rbPeak)} req/s × ${I.sb} ms ≈ ${K.num((I.rbPeak * I.sb) / 1000, 1)} busy threads)`);
    if (I.lv === 3 && cfg.retries === 0) errs.push(`without a retry, ${K.pct(I.transient, 0)} transient ${esc(I.depB)} errors break the ${esc(I.depB)} success SLO`);
    if (total > I.maxT) errs.push(`${total} threads exceed the ${I.maxT}-thread memory budget`);
    return { pA, busyB, forA, rhoB, errs, total };
  }

  /* failure detector (scenario 18) */
  function fdEval(I, cfg) {
    const iv = cfg.iv, T = cfg.to * 1000, ind = I.lv === 3 && cfg.ind === "on";
    const pauseFP = K.sum(I.pauses.filter((p) => p.d + iv > T).map((p) => p.n));
    const kmin = Math.floor(T / iv);
    const lossFP = I.loss ? (86400000 / iv) * Math.pow(I.loss, kmin) * (ind ? 0.001 : 1) : 0;
    const flapFP = I.flap && !ind && I.flap.d > T ? I.flap.n : 0;
    const fp = pauseFP + lossFP + flapFP;
    const msgs = (I.n * (I.n - 1) * 1000) / iv * (ind ? 1.05 : 1);
    const detect = cfg.to + iv / 2000 + (ind ? 0.3 : 0);
    const errs = [];
    if (fp > I.maxFP) errs.push(`${K.num(fp, 2)} false failovers/day (budget ${I.maxFP})`);
    if (iv * 2 > T) errs.push("fewer than two heartbeats fit in the timeout");
    if (msgs > I.maxMsgs) errs.push(`${K.num(msgs)} heartbeat messages/s across the cluster (budget ${K.num(I.maxMsgs)})`);
    return { pauseFP, lossFP, flapFP, fp, msgs, detect, errs };
  }

  /* vector clocks (scenario 20) */
  const vcCmp = (a, b, ids) => { let le = true, ge = true; ids.forEach((k) => { const x = a[k] || 0, y = b[k] || 0; if (x > y) le = false; if (x < y) ge = false; }); return le && ge ? 3 : le ? 0 : ge ? 1 : 2; };
  const vcStr = (v, ids, sparse) => "{" + ids.filter((k) => !sparse || v[k]).map((k) => `${k}:${v[k] || 0}`).join(", ") + "}";

  LB.addAll("dist", [
    /* 15 */ {
      id: "dist-retry-storm",
      name: "Stop the retry storm",
      kind: "Incident",
      skills: ["tune", "diagnose"],
      w: "tune",
      gen(lv, R) {
        const I = { lv, seed: `retry/${lv}/${R.int(1, 1e9)}`, servers: 10, svc: 20, rate: R.pick([340, 350, 360]), dur: 40, b0: 8, b1: lv === 1 ? 11 : lv === 2 ? 12 : 14, slow: lv === 1 ? 3 : 3.5, timeout: 1000, tail: 8,
          failP: 0.03, lossP: lv === 1 ? 0 : 0.05, need: lv === 1 ? 0.92 : lv === 2 ? 0.8 : 0.875, recNeed: lv === 1 ? 0.95 : 0.97, dep: R.pick(["inventory", "pricing", "profile", "risk"]) };
        const ok = (cfg) => retryJudge(I, cfg, retryRun(I, cfg)).errs.length === 0;
        if (!ok(this.solve(I))) return null;
        return this.bad(I).some(ok) ? null : I;
      },
      text: (I) => `<p><b>PAGE:</b> a ${I.b1 - I.b0} s slowdown in <code>${esc(I.dep)}</code> (latency ×${I.slow}) turned into a long outage of the API in front of it: even after ${esc(I.dep)} recovered, the API stayed near zero goodput. ${I.servers} workers, ~${I.svc} ms per call, ${I.rate} req/s (${K.pct(I.rate / ((I.servers * 1000) / I.svc), 0)} of capacity). Normally ${K.pct(I.failP, 0)} of calls fail fast with a 503 from a flaky sidecar${I.lossP ? ` and ${K.pct(I.lossP, 0)} are silently dropped by a lossy network path (the client only sees a timeout)` : ""}. ${I.lv === 3 ? "The user-facing deadline is 1 s." : `Client timeout: ${I.timeout} ms.`}</p>
        <p>Replay the incident (seconds ${I.b0}–${I.b1} are slow) and pick a client retry policy so the API <b>recovers on its own</b> (≥ ${K.pct(I.recNeed, 0)} success over the last ${I.tail} s) and at least <b>${K.pct(I.need, 1)}</b> of all requests succeed.${I.lv === 3 ? " The server can also skip queued requests whose client has already given up." : ""}</p>`,
      ui: (I) => {
        const knobs = [{ k: "retries", label: "Max retries", opts: [0, 1, 3] }, { k: "on", label: "Retry on", opts: ["all", "errors"], fmt: (v) => (v === "all" ? "errors and timeouts" : "fast errors only (503)") }, { k: "backoff", label: "Initial backoff", opts: [0, 50, 200], unit: "ms", help: "doubles on each retry" }, { k: "jitter", label: "Jitter", opts: ["off", "on"], help: "random delay in [0, backoff]" }];
        if (I.lv >= 2) knobs.push({ k: "budget", label: "Retry budget", opts: ["none", "10%"], help: "retries ≤ ~10% of requests (token bucket)" });
        if (I.lv === 3) knobs.push({ k: "timeout", label: "Client timeout", opts: [300, 1000], unit: "ms" }, { k: "drop", label: "Server drops requests whose client gave up", opts: ["off", "on"] });
        return { knobs, liveDelay: 250, live: (cfg) => { const r = retryRun(I, cfg), j = retryJudge(I, cfg, r); return simChart(r, { vline: { x: I.b0, label: "slowdown" } }) + K.metrics([
          { name: "Success", value: K.pct(r.succ, 1), ok: r.succ >= I.need, target: `≥ ${K.pct(I.need, 1)}` },
          { name: "Recovered", value: K.pct(j.rec, 0), ok: j.rec >= I.recNeed, target: `last ${I.tail} s` },
          { name: "Load amplification", value: K.num(r.amp, 2) + "×", ok: null },
          { name: "Wasted work", value: K.num(r.wasted), ok: null, target: "served after client gave up" },
        ]); } };
      },
      accept(I, cfg) { const r = retryRun(I, cfg), j = retryJudge(I, cfg, r); return j.errs.length ? j.errs[0] + "." : true; },
      solve: (I) => I.lv === 1 ? { retries: 3, on: "errors", backoff: 200, jitter: "on" } : I.lv === 2 ? { retries: 3, on: "all", backoff: 200, jitter: "on", budget: "10%" } : { retries: 3, on: "all", backoff: 200, jitter: "on", budget: "10%", timeout: 1000, drop: "on" },
      bad: (I) => I.lv === 1 ? [{ retries: 3, on: "all", backoff: 200, jitter: "on" }, { retries: 0, on: "all", backoff: 0, jitter: "off" }]
        : I.lv === 2 ? [{ retries: 3, on: "all", backoff: 200, jitter: "on", budget: "none" }, { retries: 3, on: "errors", backoff: 200, jitter: "on", budget: "10%" }, { retries: 0, on: "all", backoff: 0, jitter: "off", budget: "none" }]
          : [{ retries: 3, on: "all", backoff: 200, jitter: "on", budget: "10%", timeout: 1000, drop: "off" }, { retries: 3, on: "errors", backoff: 200, jitter: "on", budget: "10%", timeout: 1000, drop: "on" }, { retries: 3, on: "all", backoff: 200, jitter: "on", budget: "none", timeout: 1000, drop: "on" }],
      hint: (I) => I.lv === 1 ? "Which failures are caused by the overload, and which are independent of it? Retrying the first kind adds load exactly when capacity is lowest." : I.lv === 2 ? "Lost requests only show up as timeouts, so you must retry timeouts, but something has to cap how much extra load that can create." : "With a 1 s deadline the server spends the slowdown finishing requests nobody is waiting for.",
      concept: "Retry storms and metastable failure",
      how: "When a dependency slows down, requests queue and time out; clients retry, which adds load at the moment capacity is lowest. If the extra load keeps the queue full after the trigger is gone, the system stays down: a metastable failure. Servers make it worse by finishing requests whose client already gave up. The fixes limit and spread the extra load: exponential backoff with jitter decorrelates retries, a retry budget (e.g. retries ≤ 10% of requests, as in gRPC retry throttling or Finagle's RetryBudget) caps amplification, and server-side deadlines drop work that's already useless.",
      rule: "Retry with exponential backoff and jitter, cap retries with a budget, propagate deadlines so servers drop expired work, and test recovery after the trigger is removed, not just survival during it.",
      why: (I, sol) => { const r = retryRun(I, sol); return `With ${sol.retries} retries on ${sol.on === "all" ? "errors and timeouts" : "fast errors only"}, ${sol.backoff} ms backoff with jitter${sol.budget === "10%" ? ", a 10% budget" : ""}${sol.drop === "on" ? " and server-side drops of abandoned requests" : ""}: ${K.pct(r.succ, 1)} success at ${K.num(r.amp, 2)}× load. Uncapped retries of timeouts nearly doubled the offered load during the slowdown, so the queue never drained and the API stayed down after ${esc(I.dep)} recovered.`; },
    },
    /* 16 */ {
      id: "dist-circuit-breaker",
      name: "Configure the circuit breaker",
      kind: "Config change",
      skills: ["tune"],
      w: "tune",
      sense: "min",
      vname: "a cost of",
      gen(lv, R) {
        const o0 = R.int(30, 45);
        const I = { lv, seed: `cb/${lv}/${R.int(1, 1e9)}`, dur: 160, o0, o1: o0 + R.int(62, 75), rate: lv === 3 ? R.pick([3, 4]) : R.pick([40, 60]), e: lv === 3 ? 0.05 : R.pick([0.01, 0.02]), burst: lv === 2 ? { every: 17, len: 2, p: 0.35 } : null, maxRec: lv === 3 ? 15 : 8, dep: R.pick(["fraud-score", "geo-lookup", "recommendations", "tax-quote"]) };
        const best = PB_brute(LB.byId.get("dist-circuit-breaker"), I);
        return best ? I : null;
      },
      text: (I) => `<p>Calls to <code>${esc(I.dep)}</code> (≈ ${I.rate} req/s) normally fail ${K.pct(I.e, 0)} of the time${I.burst ? `, plus <b>${I.burst.len} s bursts of ${K.pct(I.burst.p, 0)} errors every ${I.burst.every} s</b> during its cache flushes` : ""}. Replay: it's <b>down from t = ${I.o0} s to ${I.o1} s</b>, and each call during the outage hangs a worker until its 2 s timeout.</p>
        <p>Configure a count-based breaker (Resilience4j-style) that <b>never trips outside the outage</b>, closes within <b>${I.maxRec} s</b> after the dependency recovers, and sends as <b>few calls as possible</b> into the outage.</p>`,
      ui: (I) => ({ knobs: [
        { k: "window", label: "Sliding window (calls)", opts: [10, 50, 200], help: "also the minimum number of calls before it can trip" },
        { k: "thr", label: "Failure-rate threshold", opts: [10, 25, 50, 80], unit: "%" },
        { k: "wait", label: "Wait in OPEN", opts: [1, 5, 30, 60], unit: "s" },
        { k: "probes", label: "Calls permitted in HALF_OPEN", opts: [1, 3, 10] },
      ], live: (cfg) => { const r = breakerRun(I, cfg); return K.metrics([
        { name: "False trips", value: String(r.falseTrips), ok: r.falseTrips === 0, target: "outside the outage" },
        { name: "Calls into the outage", value: K.num(r.wasted), ok: null, target: "each holds a worker 2 s" },
        { name: "Recovery", value: Number.isFinite(r.recovery) ? (r.openedInOutage ? `${K.num(r.recovery, 1)} s` : "never opened") : "never closes", ok: Number.isFinite(r.recovery) && r.recovery <= I.maxRec && r.openedInOutage, target: `≤ ${I.maxRec} s` },
      ]) + K.note(`Trips at: ${r.trips.length ? r.trips.map((x) => `t=${K.num(x, 1)} s`).slice(0, 8).join(", ") : "none"}`); } }),
      valid: (I, cfg) => { const r = breakerRun(I, cfg); if (r.falseTrips) return `it tripped ${r.falseTrips} time${r.falseTrips > 1 ? "s" : ""} on normal errors`; if (!r.openedInOutage) return "it never opened during the outage"; if (!(r.recovery <= I.maxRec)) return `it took ${Number.isFinite(r.recovery) ? K.num(r.recovery, 1) + " s" : "forever"} to close after recovery`; return true; },
      val: (I, cfg) => breakerRun(I, cfg).wasted,
      vfmt: (v) => `${v} calls into the outage`,
      hint: (I) => I.lv === 1 ? "A small window with a low threshold trips on ordinary noise; a long OPEN wait delays recovery." : I.lv === 2 ? "The bursts are real errors but not an outage. How big must the window be to average a 2 s burst away?" : "At a few requests per second, how long does it take to fill a 200-call window? Every call while filling it is wasted.",
      concept: "Circuit breaker tuning",
      how: "A circuit breaker watches recent calls; when the failure rate over a window (with a minimum number of calls) exceeds a threshold, it opens and fails fast, protecting both the caller's threads and the struggling dependency. After a wait it goes half-open, lets a few trial calls through, and closes if they succeed or reopens if one fails. A small window or low threshold trips on normal noise; a large window reacts slowly, especially at low traffic, because it must fill before deciding. A long open wait delays recovery; many half-open probes make recovery fragile when background errors exist.",
      rule: "Size the window in calls so it covers a few seconds of traffic, set the threshold well above normal error bursts, keep the open wait short (seconds) and use a few half-open probes.",
      why: (I, sol) => { const r = breakerRun(I, sol); return `Window ${sol.window}, threshold ${sol.thr}%, wait ${sol.wait} s, ${sol.probes} probe${sol.probes > 1 ? "s" : ""}: ${r.wasted} calls reached ${esc(I.dep)} during the outage, no false trips, closed ${K.num(r.recovery, 1)} s after recovery.`; },
    },
    /* 17 */ {
      id: "dist-bulkheads",
      name: "Bulkhead the slow dependency",
      kind: "Hardening",
      skills: ["tune", "design"],
      w: "tune",
      sense: "min",
      vname: "threads:",
      gen(lv, R) {
        const [depA, depB] = R.sample(["catalog", "pricing", "reviews", "recommendations", "loyalty", "ads"], 2);
        const rb = R.pick([40, 60]);
        return { lv, depA, depB, ra: R.pick([300, 400, 500]), sa: R.pick([20, 25]), rb, rbPeak: lv === 1 ? rb : rb * 2, sb: 80, pB: lv === 1 ? 400 : R.pick([600, 800]), to: 10, sloA: 150, maxT: 200, transient: 0.03 };
      },
      text: (I) => `<p>The product page service calls <b>${esc(I.depA)}</b> (${I.ra} req/s, ~${I.sa} ms) and <b>${esc(I.depB)}</b> (${I.rb} req/s, ~${I.sb} ms, healthy p99 ${I.pB} ms) on blocking worker threads. Yesterday ${esc(I.depB)} started hanging every call${I.lv === 1 ? ` until the ${I.to} s timeout` : ""}, threads piled up and ${esc(I.depA)} calls failed too.</p>
        <p>Keep <b>${esc(I.depA)} p99 ≤ ${I.sloA} ms</b> during a ${esc(I.depB)} hang, keep ${esc(I.depB)} healthy at its normal peak (${I.lv === 1 ? I.rb : I.rb * 2} req/s)${I.lv === 3 ? `, survive its ${K.pct(I.transient, 0)} transient errors (one retry needed), ` : " "}and stay within <b>${I.maxT} threads</b>, using as few threads as possible.</p>`,
      ui: (I) => {
        const knobs = [];
        knobs.push({ k: "mode", label: "Thread pools", opts: ["shared", "bulkheads"], fmt: (v) => (v === "shared" ? "one shared pool" : "separate pool per dependency") });
        knobs.push({ k: "a", label: `Threads for ${I.depA}`, opts: [10, 15, 20, 30, 40, 60] }, { k: "b", label: `Threads for ${I.depB}`, opts: [5, 10, 15, 20, 40, 80] });
        if (I.lv > 1) knobs.push({ k: "to", label: `${I.depB} timeout`, opts: [0.25, 0.5, 1, 2, 5, 10], unit: "s" });
        if (I.lv === 3) knobs.push({ k: "retries", label: `${I.depB} retries`, opts: [0, 1, 2] });
        return { knobs, live: (cfg) => { const r = bulkEval(I, cfg); return K.metrics([
          { name: `${esc(I.depB)} threads stuck`, value: K.num(r.busyB, 0), ok: null, target: "during the hang" },
          { name: `Left for ${esc(I.depA)}`, value: K.num(Math.max(0, r.forA), 0), ok: null },
          { name: `${esc(I.depA)} p99`, value: Number.isFinite(r.pA) ? K.ms(r.pA) : "∞", ok: r.pA <= I.sloA, target: `≤ ${I.sloA} ms` },
          { name: "Total threads", value: String(r.total), ok: r.total <= I.maxT, target: `≤ ${I.maxT}` },
        ]) + (r.errs.length ? K.note(r.errs.join("<br>"), "bad") : K.note("All requirements met.", "good")); } };
      },
      valid: (I, cfg) => { const r = bulkEval(I, cfg); return r.errs.length ? r.errs[0] : true; },
      val: (I, cfg) => cfg.a + cfg.b,
      hint: (I) => I.lv === 1 ? "In a shared pool, how many threads does a hanging dependency eventually hold? Little's law: rate × time held." : I.lv === 2 ? "The timeout bounds how long a hung call holds a thread, but must stay above the healthy p99." : "Retries multiply the calls that hang. The bulkhead caps the damage no matter how many there are.",
      concept: "Bulkheads",
      how: "With one shared pool, a dependency that hangs eventually holds every thread: by Little's law it pins rate × timeout threads, which for 50 req/s and a 10 s timeout is 500. Everything else on the service then queues and fails. A bulkhead gives each dependency its own bounded pool (or semaphore): when the bad dependency's pool is full, its calls fail fast and the rest of the service keeps its threads. Size each pool from its normal peak (rate × latency, plus headroom), set timeouts just above the healthy p99, and remember retries multiply the in-flight calls.",
      rule: "Isolate each downstream behind its own bounded pool or concurrency limit sized by Little's law, with a timeout just above its healthy p99.",
      why: (I, sol) => { const r = bulkEval(I, sol); return `${sol.mode === "shared" ? "One shared pool" : "Separate pools"}: ${sol.a} threads for ${esc(I.depA)} and ${sol.b} for ${esc(I.depB)}${sol.to ? `, ${sol.to * 1000} ms timeout` : ""}${sol.retries != null ? `, ${sol.retries} retr${sol.retries === 1 ? "y" : "ies"}` : ""}: during the hang only ${K.num(r.busyB, 0)} threads are stuck, and ${esc(I.depA)} keeps p99 ≈ ${K.ms(r.pA)}.`; },
    },
    /* 18 */ {
      id: "dist-failure-detector",
      name: "Tune the failure detector",
      kind: "Config change",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "detection time:",
      gen(lv, R) {
        const pauses = [{ d: 200, n: R.int(300, 600) }, { d: R.pick([500, 600]), n: R.int(20, 40) }, { d: R.pick([1300, 1500]), n: R.int(2, 4) }, { d: R.pick([2600, 2800]), n: 0.01 }];
        return { lv, n: lv === 1 ? 5 : R.pick([150, 200]), pauses, loss: lv === 1 ? 0 : R.pick([0.01, 0.02]), flap: lv === 3 ? { d: R.pick([6000, 7000]), n: R.int(3, 6) } : null, maxFP: 0.05, maxMsgs: lv === 1 ? 1e6 : 45000, svc: R.pick(["the shard leader", "the queue broker", "the primary database"]) };
      },
      text: (I) => `<p>A ${I.n}-node cluster declares a member dead when no heartbeat arrives within the timeout, then fails over ${esc(I.svc)}. Every false declaration triggers a needless failover; budget: <b>≤ ${I.maxFP} per day</b> per member.</p>
        <p>Evidence per member per day: JVM pauses of ${I.pauses.map((p) => `${K.num(p.d)} ms × ${p.n}`).join(", ")}.${I.loss ? ` Heartbeats are lost independently ${K.pct(I.loss, 0)} of the time.` : ""}${I.flap ? ` The observer↔member path also <b>flaps ${I.flap.n} times a day for ${I.flap.d / 1000} s</b> (other paths unaffected).` : ""}${I.lv > 1 ? ` All-to-all heartbeats must stay under <b>${K.num(I.maxMsgs)} messages/s</b>.` : ""} Minimise the time to detect a real crash.</p>`,
      ui: (I) => {
        const knobs = [{ k: "iv", label: "Heartbeat interval", opts: [100, 250, 500, 1000, 2000], unit: "ms" }, { k: "to", label: "Timeout", opts: [0.5, 1, 2, 3, 5, 8, 10], unit: "s" }];
        if (I.lv === 3) knobs.push({ k: "ind", label: "Indirect probes (SWIM-style)", opts: ["off", "on"], help: "before declaring, ask 3 other members to ping it" });
        return { knobs, live: (cfg) => { const r = fdEval(I, cfg); return K.bars([{ label: "GC pauses", value: r.pauseFP, note: K.num(r.pauseFP, 2) + "/day", cls: r.pauseFP > I.maxFP ? "bad" : "" }, { label: "lost heartbeats", value: r.lossFP, note: K.num(r.lossFP, 2) + "/day", cls: r.lossFP > I.maxFP ? "bad" : "" }, ...(I.flap ? [{ label: "path flaps", value: r.flapFP, note: K.num(r.flapFP, 2) + "/day", cls: r.flapFP > I.maxFP ? "bad" : "" }] : [])], { max: Math.max(1, r.fp) }) + K.metrics([
          { name: "False failovers", value: K.num(r.fp, 3) + "/day", ok: r.fp <= I.maxFP, target: `≤ ${I.maxFP}` },
          { name: "Detection time", value: `${K.num(r.detect, 2)} s`, ok: null },
          { name: "Heartbeat msgs", value: `${K.num(r.msgs)}/s`, ok: r.msgs <= I.maxMsgs },
        ]); } };
      },
      valid: (I, cfg) => { const r = fdEval(I, cfg); return r.errs.length ? r.errs[0] : true; },
      val: (I, cfg) => Math.round(fdEval(I, cfg).detect * 1000),
      vfmt: (v) => `${K.num(v / 1000, 2)} s`,
      hint: (I) => I.lv === 1 ? "A pause of d ms plus up to one interval passes without a heartbeat. Which pauses happen more than once in 20 days?" : I.lv === 2 ? "The message budget forces a slow heartbeat. How many consecutive losses fit in the timeout, and how likely is that run?" : "A flap on one path isn't a dead node. What lets you tell the difference without waiting it out?",
      concept: "Failure detection: timeouts vs. false positives",
      how: "A heartbeat detector can't distinguish a dead node from a slow one or a lossy path; it only sees silence. A false positive happens whenever the silence exceeds the timeout: a GC pause of d plus up to one heartbeat interval, or k consecutive lost heartbeats where k × interval ≥ timeout. Shorter timeouts detect real crashes faster but turn every pause into a failover; longer ones keep you down longer after a real crash. Indirect probing (SWIM) asks other members to ping the suspect before declaring it dead, which filters out problems on one network path. Phi-accrual detectors adapt the threshold to the observed heartbeat distribution.",
      rule: "Set the timeout above your longest frequent pause plus one interval, make sure several heartbeats fit in it, and confirm suspicion through independent paths before failing over.",
      why: (I, sol) => { const r = fdEval(I, sol); return `Interval ${sol.iv} ms, timeout ${sol.to} s${sol.ind ? ", indirect probes " + sol.ind : ""}: ${K.num(r.fp, 3)} false failovers/day and ${K.num(r.detect, 2)} s to detect a crash. ${I.flap ? `Without indirect probes the ${I.flap.d / 1000} s flaps would force a timeout above ${I.flap.d / 1000} s.` : I.loss ? "With heartbeats this sparse, short timeouts tolerate only one or two lost packets." : ""}`; },
    },
    /* 19 */ {
      id: "dist-load-shedding",
      name: "Shed load before it sheds you",
      kind: "Incident",
      skills: ["tune", "diagnose"],
      w: "tune",
      gen(lv, R) {
        const servers = R.pick([8, 12]), svc = 20, cap = (servers * 1000) / svc;
        const I = { lv, seed: `shed/${lv}/${R.int(1, 1e9)}`, servers, svc, cap, over: lv === 1 ? 1.5 : 1.8, o0: 5, o1: 25, dur: 35, timeout: 1000, slo: lv === 3 ? 150 : 400, svcName: R.pick(["search", "checkout", "feed", "quotes"]) };
        const sol = this.solve(I);
        return shedJudge(I, sol, shedRun(I, sol)).errs.length ? null : I;
      },
      text: (I) => `<p>A marketing push sends <b>${I.over}×</b> the capacity of <code>${esc(I.svcName)}</code> (${K.num(I.cap)} req/s: ${I.servers} workers × ${I.svc} ms) for 20 s. Clients time out after ${I.timeout} ms${I.lv >= 2 ? " and <b>retry up to 3 times</b>, including on 503s (each rejection is cheap for the server)" : ""}. Last time the queue grew without bound and goodput fell to almost nothing.</p>
        <p>Configure overload protection so that during the spike goodput stays <b>≥ 85% of capacity</b>, successful requests keep <b>p99 ≤ ${I.slo} ms</b>, and the service is healthy right after.</p>`,
      ui: (I) => {
        const knobs = [{ k: "queue", label: "Max queued requests (then 503)", opts: ["unbounded", 2000, 400, 100, 20] }, { k: "drop", label: "Drop queued requests past their deadline", opts: ["off", "on"] }];
        return { knobs, liveDelay: 250, live: (cfg) => { const r = shedRun(I, cfg), j = shedJudge(I, cfg, r); return simChart(r, { vline: { x: I.o0, label: "spike" } }) + K.metrics([
          { name: "Goodput in spike", value: `${K.num(j.gp)} req/s`, ok: j.gp >= I.cap * 0.85, target: `≥ ${K.num(I.cap * 0.85)}` },
          { name: "p99 (successes)", value: K.ms(r.p99), ok: r.p99 <= I.slo, target: `≤ ${I.slo} ms` },
          { name: "After the spike", value: K.pct(j.after, 0), ok: j.after >= 0.95 },
          { name: "Wasted work", value: K.num(r.wasted), ok: null, target: "finished after the client left" },
        ]); } };
      },
      accept(I, cfg) { const j = shedJudge(I, cfg, shedRun(I, cfg)); return j.errs.length ? j.errs[0] + "." : true; },
      solve: (I) => (I.lv === 3 ? { queue: 20, drop: "on" } : { queue: 100, drop: "on" }),
      bad: (I) => I.lv === 1 ? [{ queue: "unbounded", drop: "off" }, { queue: 2000, drop: "off" }, { queue: 400, drop: "on" }] : I.lv === 2 ? [{ queue: "unbounded", drop: "on" }, { queue: 400, drop: "on" }] : [{ queue: 100, drop: "on" }, { queue: 400, drop: "on" }],
      hint: (I) => I.lv === 1 ? "A queue only helps if a request can wait in it and still finish before its client gives up. How long is a wait behind 2,000 requests?" : I.lv === 2 ? "Retries keep the offered load high for the whole spike. Which requests is the server actually able to finish in time?" : "The queue length you allow sets the worst-case wait: queue depth ÷ throughput.",
      concept: "Load shedding and bounded queues",
      how: "When arrivals exceed capacity, an unbounded queue just converts overload into latency: soon every request waits longer than its client's timeout, so the server spends all its capacity on requests nobody is waiting for and goodput collapses. Bounding the queue (by length or by expected wait) and rejecting the excess quickly keeps the work that's admitted useful. Dropping requests whose deadline has passed reclaims more. Rejections must be cheap and must not come straight back: clients need backoff (Retry-After) and retry budgets, otherwise shedding just multiplies the offered load.",
      rule: "Bound queues by the wait you can afford (≈ capacity × latency budget), drop expired work, reject early and cheaply, and make clients back off on 503.",
      why: (I, sol) => { const r = shedRun(I, sol), j = shedJudge(I, sol, r); return `Queue limit ${sol.queue}, deadline drops ${sol.drop}: ${K.num(j.gp)} req/s goodput during the spike with p99 ${K.ms(r.p99)}. A full queue of ${K.num(I.cap)} req/s capacity drains about ${K.num(I.cap / 10)} requests per 100 ms, so anything much deeper than the latency budget only stores requests that will time out.`; },
    },
    /* 20 */ {
      id: "dist-vector-clocks",
      name: "Order the versions",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "classify",
      gen(lv, R) {
        const ids = lv === 1 ? ["a", "b"] : lv === 2 ? ["a", "b", "c"] : ["n1", "n2", "n3", "n4"];
        const rv = () => Object.fromEntries(ids.map((k) => [k, R.int(0, lv === 1 ? 4 : 3)]));
        const want = R.shuffle([0, 1, 2, 2, 0, 1, 3].slice(0, lv === 1 ? 5 : 6));
        const pairs = [];
        for (const w of want) {
          let a, b, tries = 0;
          do {
            a = rv(); b = K.clone(a);
            if (w === 0 || w === 1) { const k = R.pick(ids); b[k] += R.int(1, 2); if (lv === 3 && R.chance(0.5)) { const k2 = R.pick(ids); b[k2] += 1; } if (w === 1) [a, b] = [b, a]; }
            else if (w === 2) { const [k1, k2] = R.sample(ids, 2); a[k1] += R.int(1, 2); b[k2] += R.int(1, 2); if (lv === 3) { const k3 = R.pick(ids); a[k3] += 1; b[k3] += 1; } }
            tries++;
          } while (vcCmp(a, b, ids) !== w && tries < 20);
          if (vcCmp(a, b, ids) !== w) return null;
          pairs.push([a, b]);
        }
        return { lv, ids, pairs, key: R.pick(["cart:user-77", "doc:roadmap", "profile:4410"]), sparse: lv >= 2 };
      },
      text: (I) => `<p>Replicas of <code>${esc(I.key)}</code> tag each version with a ${I.lv === 3 ? "version vector (one counter per replica)" : "vector clock"}${I.sparse ? "; entries that are 0 are omitted" : ""}. For each pair, decide how version A relates to version B. This decides whether the store can discard one or must keep both as siblings.</p>`,
      ui: (I) => ({ items: I.pairs.map(([a, b]) => `A ${vcStr(a, I.ids, I.sparse)}   B ${vcStr(b, I.ids, I.sparse)}`), cats: ["A happened before B", "B happened before A", "Concurrent", "Same version"] }),
      ans: (I) => I.pairs.map(([a, b]) => vcCmp(a, b, I.ids)),
      diag: () => "Not quite. A happened before B only if every entry of A is ≤ the matching entry of B (missing entries count as 0) and at least one is strictly less.",
      hint: (I) => I.sparse ? "Fill in the missing entries as 0, then compare entry by entry." : "Compare entry by entry: all ≤ means before; mixed means concurrent.",
      concept: "Vector clocks and version vectors",
      how: "A vector clock keeps one counter per node; a node increments its own entry on each update and takes the element-wise maximum when it learns another version. Version A happened before B if every entry of A is ≤ B's and at least one is smaller; then B supersedes A and A can be discarded. If some entries are bigger in A and others in B, neither saw the other: the versions are concurrent and must be kept as siblings (or merged by the application or a CRDT). A total of the entries or the latest timestamp says nothing about causality.",
      rule: "Compare vectors element-wise: dominated versions can be dropped, concurrent ones must be merged, never silently overwritten.",
      why: (I) => `${I.pairs.filter(([a, b]) => vcCmp(a, b, I.ids) === 2).length} of the ${I.pairs.length} pairs are concurrent: each side has an entry the other hasn't seen, so a store that keeps only one of them loses an update.`,
    },
  ]);
  function PB_brute(p, I) { try { return D.pb.brute(p, I, p.ui(I)); } catch (e) { return null; } }
})();
