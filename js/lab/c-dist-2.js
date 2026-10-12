/* Systems Lab · Distributed systems (part 2): versions and CRDTs, session guarantees, repair, cron and queues, IDs, multi-region, tail latency, partitions. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const rng = (s) => D.campaign.rng(s);
  const maj = (n) => Math.floor(n / 2) + 1;
  const cap1 = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

  /* lane-schedule simulator (same contract as part 1) */
  function runLanes(M, seq) {
    const st = K.clone(M.init), pos = M.lanes.map(() => 0), log = [];
    for (const l of seq || []) {
      const i = pos[l]++;
      if (i >= M.lanes[l].steps.length) continue;
      const note = M.lanes[l].ops[i](st) || "";
      log.push({ t: l, label: M.lanes[l].steps[i], note, err: /^!/.test(note) });
    }
    return { st, log, complete: (seq || []).length === M.lanes.reduce((s, x) => s + x.steps.length, 0) };
  }
  const laneTrace = (M, r) => r.log.length ? K.table(["#", ...M.lanes.map((l) => esc(l.name))], r.log.map((e, k) => [String(k + 1), ...M.lanes.map((_, j) => (j === e.t ? `<span class="mono small">${esc(e.label)}</span>${e.note ? `<br><small class="${e.err ? "lose" : "muted"}">${esc(e.note.replace(/^!/, ""))}</small>` : ""}` : ""))]), { compact: true }) : `<p class="muted small">Schedule steps to see what each component observes.</p>`;
  const laneScenario = (model) => ({
    w: "interleave",
    ui: (I) => { const M = model(I); return { lanes: M.lanes.map((l) => ({ name: l.name, steps: l.steps })), live: (seq) => { const r = runLanes(M, seq || []); return laneTrace(M, r) + (r.complete ? K.verdict(M.broken(r.st), M.verdict(r.st)) : ""); } }; },
    accept(I, seq) { const M = model(I); const r = runLanes(M, seq); if (!r.complete) return "Schedule every step."; return M.broken(r.st) ? true : `Nothing went wrong in that schedule: ${M.verdict(r.st)}.`; },
    solve(I) { return model(I).solve; },
    bad(I) { return model(I).bad; },
  });

  /* ---------- vector helpers ---------- */
  const vcCmp = (a, b, ids) => { let le = true, ge = true; ids.forEach((k) => { const x = a[k] || 0, y = b[k] || 0; if (x > y) le = false; if (x < y) ge = false; }); return le && ge ? 3 : le ? 0 : ge ? 1 : 2; };
  const vcStr = (v, ids) => "{" + ids.filter((k) => v[k]).map((k) => `${k}:${v[k]}`).join(", ") + "}";

  /* ---------- Lamport diagram ---------- */
  function lamportGen(lv, R) {
    const P = lv === 1 ? 2 : 3, n = lv === 1 ? 6 : lv === 2 ? 9 : 12;
    const ev = [], inflight = [];
    let m = 0;
    for (let k = 0; k < n; k++) {
      const p = R.int(0, P - 1);
      const mine = inflight.filter((x) => x.to === p);
      const r = R.next();
      if (mine.length && r < 0.45) { const msg = mine[0]; inflight.splice(inflight.indexOf(msg), 1); ev.push({ p, k: "recv", m: msg.m }); }
      else if (r < 0.75) { const to = R.pick(U.range(P).filter((x) => x !== p)); m++; inflight.push({ m, to }); ev.push({ p, k: "send", m, to }); }
      else ev.push({ p, k: "local" });
    }
    // deliver what's left at the end
    inflight.forEach((x) => ev.push({ p: x.to, k: "recv", m: x.m }));
    const L = U.range(P).map(() => 0), sentAt = {};
    ev.forEach((e) => { if (e.k === "recv") L[e.p] = Math.max(L[e.p], sentAt[e.m]) + 1; else L[e.p] += 1; if (e.k === "send") sentAt[e.m] = L[e.p]; e.ts = L[e.p]; });
    const recvs = ev.map((e, i) => (e.k === "recv" ? i : -1)).filter((i) => i >= 0);
    if (recvs.length < (lv === 1 ? 1 : 2)) return null;
    // target: the last receive (most interesting), or for lv3 the last event on the busiest-late process
    const target = lv === 3 ? ev.length - 1 : recvs[recvs.length - 1];
    if (ev[target].ts <= ev.filter((e) => e.p === ev[target].p).length) return null; // make sure a jump happens
    return { lv, P, ev: ev.map(({ p, k, m, to }) => ({ p, k, m, to })), target, ts: ev[target].ts };
  }
  const lamportTable = (I) => K.table(["step", ...U.range(I.P).map((p) => "P" + (p + 1))], I.ev.map((e, i) => [String(i + 1), ...U.range(I.P).map((p) => (p === e.p ? `${i === I.target ? "<b>★ </b>" : ""}${e.k === "send" ? `send m${e.m} → P${e.to + 1}` : e.k === "recv" ? `receive m${e.m}` : "local event"}` : ""))]), { compact: true });

  /* ---------- CRDT counters ---------- */
  function counterGen(lv, R) {
    const reps = lv === 3 ? ["r1", "r2", "r3", "r4"] : ["r1", "r2", "r3"];
    const truth = Object.fromEntries(reps.map((r) => [r, { p: R.int(3, 40), n: lv === 1 ? 0 : R.int(0, 15) }]));
    // each replica has seen a (possibly stale) view of the others
    const views = reps.map((me) => Object.fromEntries(reps.map((r) => [r, r === me ? { ...truth[r] } : { p: Math.max(0, truth[r].p - R.int(0, 8)), n: Math.max(0, truth[r].n - R.int(0, 5)) }])));
    if (lv === 3) { const k = R.int(0, reps.length - 1); views[k] = Object.fromEntries(reps.map((r) => [r, { p: Math.max(0, truth[r].p - R.int(5, 12)), n: Math.max(0, truth[r].n - R.int(2, 6)) }])); }
    const merged = Object.fromEntries(reps.map((r) => [r, { p: Math.max(...views.map((v) => v[r].p)), n: Math.max(...views.map((v) => v[r].n)) }]));
    const value = K.sum(reps.map((r) => merged[r].p - merged[r].n));
    const naive = K.sum(views.map((v) => K.sum(reps.map((r) => v[r].p - v[r].n))));
    return { lv, reps, views, value, naive, restored: lv === 3 ? views.findIndex((v, i) => reps.some((r) => v[r].p < truth[r].p && r === reps[i])) : -1, what: R.pick(["likes on a post", "seats reserved for the event", "items in stock at the warehouse", "active sessions for the tenant"]) };
  }

  /* ---------- session routing (scenario 25) ---------- */
  const ROUTES = { any: "any replica (round-robin)", sticky: "same replica for the whole session", window: "primary for 5 s after the user writes", lsn: "replica whose replay LSN ≥ the session's last-seen LSN (else primary)" };
  function routeEval(I, cfg) {
    const r = cfg.route, store = I.lv === 3 ? cfg.store : "cookie";
    const out = { ryw: false, mono: false, cross: false, load: 0 };
    if (r === "any") { out.load = 0; }
    if (r === "sticky") { out.load = 0; out.mono = !I.replicaFailover; }
    if (r === "window") { out.load = I.readsAfterWrite; out.ryw = I.lagP99 < 5; }
    if (r === "lsn") { out.load = I.behindFrac; out.ryw = true; out.mono = true; out.cross = store === "server"; }
    if (r === "window") out.cross = I.lagP99 < 5;
    const errs = [];
    if (!out.ryw) errs.push(r === "window" ? `replica lag reaches ${I.lagP99} s at p99, so after the 5 s window a user can still read a replica that lacks their write` : "a user can read a replica that hasn't replayed their own write yet");
    if (I.lv >= 2 && !out.mono) errs.push(r === "sticky" ? "when the session's replica fails over to another one that is further behind, time goes backwards" : "consecutive reads can hit replicas at different positions, so values jump back");
    if (I.lv === 3 && !out.cross) errs.push("a write made on the phone isn't visible to the same user on the laptop: a cookie doesn't travel between devices");
    return { ...out, errs };
  }

  /* ---------- Cassandra repair shell (scenario 26) ---------- */
  function cassShell(I) {
    const nodes = I.ips.map((ip, i) => ({ ip, id: I.ids[i], load: `${(120 + i * 7.3).toFixed(2)} GiB`, tokens: 16, own: `${(300 / I.ips.length).toFixed(1)}%`, rack: "rack" + ((i % 3) + 1), state: i === I.bad ? (I.lv === 3 ? "DN" : "UN") : "UN" }));
    const statusTxt = (st) => `Datacenter: ${I.dc}\n${"=".repeat(12 + I.dc.length)}\nStatus=Up/Down\n|/ State=Normal/Leaving/Joining/Moving\n` + K.cols([["--", "Address", "Load", "Tokens", "Owns (effective)", "Host ID", "Rack"], ...st.nodes.map((n) => [n.state, n.ip, n.state === "DN" ? "?" : n.load, n.tokens, n.own, n.id, n.rack])]);
    const logTxt = I.lv === 1
      ? `INFO  [GossipStage:1] ${I.day} 02:10:41,118 Gossiper.java:1240 - InetAddress /${I.ips[I.bad]}:7000 is now DOWN\nINFO  [RMI TCP Connection(311)] ${I.day} 02:12:03,551 StorageService.java:2410 - Hinted handoff disabled by operator (nodetool disablehandoff)\nINFO  [GossipStage:1] ${I.day} 02:51:17,402 Gossiper.java:1222 - InetAddress /${I.ips[I.bad]}:7000 is now UP\nINFO  [HintsDispatcher:2] ${I.day} 02:51:17,950 HintsDispatchExecutor.java:154 - Hints dispatch is paused; not delivering ${I.hints} hints to /${I.ips[I.bad]}:7000`
      : I.lv === 2
        ? `INFO  [GossipStage:1] ${I.day} 01:02:11,310 Gossiper.java:1240 - InetAddress /${I.ips[I.bad]}:7000 is now DOWN\nINFO  [MutationStage-4] ${I.day} 04:02:11,912 StorageProxy.java:2733 - Not writing hints for /${I.ips[I.bad]}:7000: it has been down longer than max_hint_window (10800000 ms)\nINFO  [GossipStage:1] ${I.day} 06:14:55,027 Gossiper.java:1222 - InetAddress /${I.ips[I.bad]}:7000 is now UP\nINFO  [HintsDispatcher:3] ${I.day} 06:20:08,441 HintsDispatchExecutor.java:281 - Finished hinted handoff of file ${I.ids[I.bad]}-1.hints to endpoint /${I.ips[I.bad]}:7000`
        : `INFO  [GossipStage:1] ${I.day} 22:41:09,133 Gossiper.java:1240 - InetAddress /${I.ips[I.bad]}:7000 is now DOWN   (12 days ago; disk controller replaced since)\nINFO  [MutationStage-2] ... StorageProxy.java:2733 - Not writing hints for /${I.ips[I.bad]}:7000: it has been down longer than max_hint_window (10800000 ms)`;
    const ks = I.ks, tbl = I.tbl;
    const sh = K.shell([
      { re: /^nodetool status(?: \S+)?$/, use: "nodetool status [keyspace]", desc: "ring membership and state", run: (m, st) => statusTxt(st) },
      { re: /^nodetool statushandoff$/, use: "nodetool statushandoff", desc: "is hinted handoff running?", run: (m, st) => (st.handoff ? "Hinted handoff is running" : "Hinted handoff is not running") },
      { re: /^nodetool enablehandoff$/, use: "nodetool enablehandoff", desc: "resume hinted handoff", run: (m, st) => { st.handoff = true; if (I.lv === 1) st.fixed = true; return ""; } },
      { re: /^nodetool disablehandoff$/, use: "nodetool disablehandoff", desc: "pause hinted handoff", run: (m, st) => { st.handoff = false; return { out: "", danger: "Disabling hinted handoff makes every short outage leave replicas inconsistent." }; } },
      { re: /^nodetool getmaxhintwindow$/, use: "nodetool getmaxhintwindow", desc: "", run: () => "Current max hint window: 10800000 ms" },
      { re: /^(?:sudo )?grep -i hint\S* \/var\/log\/cassandra\/system\.log$|^(?:sudo )?grep -i (?:down|gossip)\S* \/var\/log\/cassandra\/system\.log$/i, use: "grep -i hint /var/log/cassandra/system.log", desc: "search the log", run: () => logTxt },
      { re: /^cqlsh -e "?describe table (\S+?);?"?$/i, use: `cqlsh -e "DESCRIBE TABLE ${ks}.${tbl}"`, desc: "table options", run: () => `CREATE TABLE ${ks}.${tbl} (\n    id uuid PRIMARY KEY,\n    items map<text, int>,\n    updated_at timestamp\n) WITH compaction = {'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy'}\n    AND default_time_to_live = 0\n    AND gc_grace_seconds = 864000;` },
      { re: /^nodetool repair(?: (-full|-pr|--full|--partitioner-range))*(?: (\S+))?$/, use: `nodetool repair [-full] [-pr] <keyspace>`, desc: "anti-entropy repair (Merkle trees)", run: (m, st, line) => {
        const k = (line.match(/ ([a-z_]+)$/) || [])[1];
        if (!k || k !== ks) return `error: Keyspace [${k || ""}] does not exist (try ${ks})`;
        if (st.nodes.some((n) => n.state === "DN")) return { out: `[${I.day} 09:14:02,551] Repair command #1 failed with error Endpoint not alive: /${I.ips[I.bad]}:7000`, danger: null };
        if (/-pr|--partitioner-range/.test(line) && I.lv === 2) { st.partial = true; return `[${I.day} 09:14:02,551] Starting repair command #1 (${ks}, primary range only)\n[${I.day} 09:31:40,002] Repair completed successfully\n(note: -pr repairs only this node's primary ranges; ranges it replicates for its neighbours were not repaired)`; }
        st.fixed = true;
        return `[${I.day} 09:14:02,551] Starting repair command #1, repairing keyspace ${ks} with repair options (parallelism: parallel, primary range: false, incremental: false, job threads: 1, ColumnFamilies: [], dataCenters: [], hosts: [], # of ranges: 48)\n[${I.day} 09:52:17,880] Repair session ... for range ... finished\n[${I.day} 09:52:18,014] Repair completed successfully`;
      } },
      { re: /^nodetool removenode ([0-9a-f-]+)$/, use: "nodetool removenode <host-id>", desc: "remove a dead node; its ranges are re-streamed from the other replicas", run: (m, st) => {
        const n = st.nodes.find((x) => x.id === m[1]);
        if (!n) return `error: Host ID not found: ${m[1]}`;
        if (n.state !== "DN") return { out: `error: Node /${n.ip}:7000 is alive and owns this ID. Use decommission command to remove it from the ring`, danger: null };
        st.nodes = st.nodes.filter((x) => x !== n); st.removed = true;
        return "RemovalStatus: Removed node; streaming its ranges from the remaining replicas.";
      } },
      { re: /^nodetool assassinate (\S+)$/, use: "nodetool assassinate <ip>", desc: "forcefully drop a node from gossip (last resort)", run: (m, st) => { st.nodes = st.nodes.filter((x) => x.ip !== m[1]); st.assassinated = true; return { out: "", danger: "assassinate drops the node without re-replicating its data: some ranges are now under-replicated." }; } },
      { re: /^ssh (\S+) sudo systemctl (start|restart) cassandra$/, use: "ssh <ip> sudo systemctl start cassandra", desc: "start Cassandra on a node", run: (m, st) => {
        const n = st.nodes.find((x) => x.ip === m[1]);
        if (!n) return `ssh: connect to host ${m[1]} port 22: No route to host`;
        if (n.state === "DN") { n.state = "UN"; st.zombie = true; return { out: "", danger: `The node was down longer than gc_grace_seconds: its old data includes rows whose tombstones the other replicas have already purged. The next repair or read repair will resurrect them.` }; }
        return { out: "", danger: "Restarting a healthy node causes a brief availability dip and doesn't repair anything." };
      } },
    ], { sh: "bash" });
    return {
      prompt: "ops@cass-bastion:~$", init: { nodes, handoff: I.lv !== 1, fixed: false, removed: false, zombie: false }, run: (line, st) => sh.run(line, st), par: I.lv === 3 ? 6 : 5,
      motd: I.lv === 1 ? `TICKET: users see their cart revert after maintenance on ${I.ips[I.bad]} last night (down ~40 min).\nReads use LOCAL_ONE; writes LOCAL_QUORUM; RF=3.` : I.lv === 2 ? `TICKET: stale rows on ${I.ips[I.bad]} after it was down ~5 h for a disk swap. It's UN again.\nReads use LOCAL_ONE; writes LOCAL_QUORUM; RF=3.` : `TICKET: ${I.ips[I.bad]} is back from hardware repair after 12 days. Plan says "just start Cassandra on it".\nRF=3; carts are deleted heavily (abandoned-cart cleanup job).`,
      cmds: ["nodetool status", "nodetool statushandoff", "grep -i hint /var/log/cassandra/system.log", `cqlsh -e "DESCRIBE TABLE ${ks}.${tbl}"`, `nodetool repair -full ${ks}`, "nodetool removenode <host-id>", "ssh <ip> sudo systemctl start cassandra"],
    };
  }

  /* ---------- distributed cron (scenario 28) ---------- */
  function cronReplay(I, st) {
    const hosts = I.hosts.filter((h) => st.running[h]);
    const nights = I.nights.map((nt) => {
      const enabled = hosts.filter((h) => st.lockEnabled[h] !== false && st.cfg.enabled);
      const unlocked = hosts.filter((h) => !(st.lockEnabled[h] !== false && st.cfg.enabled));
      const ran = unlocked.slice();
      const ttl = st.cfg.ttl, renew = st.cfg.renew !== "off", cas = st.cfg.release === "cas";
      // first lock-enabled host acquires at t=0
      let t = 0, holder = null, holderExp = Infinity;
      const queue = enabled.slice(), runs = [];
      const acquire = (time) => { const h = queue.shift(); if (!h) return; holder = h; const pause = h === I.hosts[0] ? nt.pause : 0; const run = { h, start: time, end: time + nt.rt + pause }; runs.push(run); ran.push(h); holderExp = renew ? (pause > ttl ? time + nt.ps + ttl : Infinity) : time + ttl; return run; };
      if (queue.length) acquire(0);
      for (let guard = 0; guard < 10 && runs.length; guard++) {
        const cur = runs[runs.length - 1];
        // does the lock expire before the current holder finishes?
        const nextExp = holderExp;
        const firstEnd = Math.min(...runs.filter((r) => !r.done).map((r) => r.end));
        if (nextExp < firstEnd && queue.length && nextExp < 600) { holder = null; acquire(nextExp); continue; }
        const fin = runs.find((r) => !r.done && r.end === firstEnd);
        if (!fin) break;
        fin.done = true; t = fin.end;
        if (holder && holder !== fin.h && !cas && queue.length && t < 600) { holder = null; acquire(t); continue; }
        if (holder === fin.h) holder = null;
        if (runs.every((r) => r.done)) break;
        void cur;
      }
      return { date: nt.date, ran: [...new Set(ran)], runs: runs.length + unlocked.length };
    });
    return nights;
  }
  function cronShell(I) {
    const job = I.job;
    const sh = K.shell([
      { re: /^consul kv get -recurse reportd\/?$/, use: "consul kv get -recurse reportd/", desc: "shared reportd config", run: (m, st) => `reportd/lock.enabled:${st.cfg.enabled}\nreportd/lock.release:${st.cfg.release}\nreportd/lock.renew:${st.cfg.renew}\nreportd/lock.ttl:${st.cfg.ttl}s\nreportd/schedule:0 2 * * *` },
      { re: /^consul kv put reportd\/lock\.(ttl|renew|release|enabled) (\S+)$/, use: "consul kv put reportd/lock.<ttl|renew|release|enabled> <value>", desc: "change shared config (all hosts reload)", run: (m, st) => {
        const k = m[1], v = m[2];
        if (k === "ttl") { const ms = K.dur(v); if (ms == null) return `Error! Invalid duration "${v}" (use e.g. 120s)`; st.cfg.ttl = ms / 1000; }
        else if (k === "renew") { if (!/^(off|\d+s)$/.test(v)) return `Error! renew must be "off" or an interval like 10s`; st.cfg.renew = v; }
        else if (k === "release") { if (!/^(del|cas)$/.test(v)) return 'Error! release must be "del" or "cas"'; st.cfg.release = v; }
        else { if (!/^(true|false)$/.test(v)) return "Error! enabled must be true or false"; st.cfg.enabled = v === "true"; if (v === "false") return { out: `Success! Data written to: reportd/lock.${k}`, danger: "Disabling the lock makes every host run the job every night." }; }
        return `Success! Data written to: reportd/lock.${k}`;
      } },
      { re: /^ssh (\S+) (?:sudo )?journalctl -u reportd(?: --since \S+)?(?: --no-pager)?$/, use: "ssh <host> journalctl -u reportd --since yesterday", desc: "the job's log on one host", run: (m, st) => {
        const h = m[1]; if (!I.hosts.includes(h)) return `ssh: Could not resolve hostname ${h}: Name or service not known`;
        const nt = I.nights[I.nights.length - 1], first = h === I.hosts[0];
        const lines = [];
        lines.push(`${nt.date} 02:00:00 ${h} reportd[${2100 + I.hosts.indexOf(h)}]: tick ${job}`);
        if (I.lv === 2 && h === I.override) lines.push(`${nt.date} 02:00:00 ${h} reportd[2102]: lock disabled by /etc/reportd/override.yaml; running ${job} without lock`, `${nt.date} 02:${String(Math.floor(nt.rt / 60)).padStart(2, "0")}:${String(nt.rt % 60).padStart(2, "0")} ${h} reportd: ${job} finished in ${nt.rt}s (sent ${I.mails} invoices)`);
        else if (first) { lines.push(`${nt.date} 02:00:00 ${h} reportd: acquired lock:${job} (SET NX PX ${I.ttl0 * 1000})`); if (nt.pause) lines.push(`${nt.date} 02:00:${String(nt.ps).padStart(2, "0")} ${h} reportd: WARN JVM pause detected: ${nt.pause}s (G1 Full GC)`); lines.push(`${nt.date} 02:${String(Math.floor((nt.rt + nt.pause) / 60)).padStart(2, "0")}:${String((nt.rt + nt.pause) % 60).padStart(2, "0")} ${h} reportd: ${job} finished in ${nt.rt + nt.pause}s (sent ${I.mails} invoices); DEL lock:${job}`); }
        else { const t2 = (I.lv === 1 || I.lv === 3) && I.hosts.indexOf(h) === 1 ? I.ttl0 : null; if (t2 != null) lines.push(`${nt.date} 02:${String(Math.floor(t2 / 60)).padStart(2, "0")}:${String(t2 % 60).padStart(2, "0")} ${h} reportd: acquired lock:${job}`, `${nt.date} 02:${String(Math.floor((t2 + nt.rt) / 60)).padStart(2, "0")}:${String((t2 + nt.rt) % 60).padStart(2, "0")} ${h} reportd: ${job} finished in ${nt.rt}s (sent ${I.mails} invoices); DEL lock:${job}`); else lines.push(`${nt.date} 02:00:00 ${h} reportd: lock:${job} held by ${I.hosts[0]}; skipping`); }
        return lines.join("\n");
      } },
      { re: /^ssh (\S+) (?:sudo )?cat \/etc\/reportd\/override\.yaml$/, use: "ssh <host> cat /etc/reportd/override.yaml", desc: "per-host overrides", run: (m, st) => { const h = m[1]; if (!I.hosts.includes(h)) return `ssh: Could not resolve hostname ${h}`; return st.lockEnabled[h] === false ? `# temporary: debugging INC-${I.inc}\nlock:\n  enabled: false` : `cat: /etc/reportd/override.yaml: No such file or directory`; } },
      { re: /^ssh (\S+) sudo rm(?: -f)? \/etc\/reportd\/override\.yaml$/, use: "ssh <host> sudo rm /etc/reportd/override.yaml", desc: "drop the per-host override", run: (m, st) => { const h = m[1]; if (st.lockEnabled[h] !== false) return `rm: cannot remove '/etc/reportd/override.yaml': No such file or directory`; st.lockEnabled[h] = true; return ""; } },
      { re: /^ssh (\S+) sudo systemctl (stop|disable --now) reportd$/, use: "ssh <host> sudo systemctl stop reportd", desc: "stop the daemon on a host", run: (m, st) => { if (!I.hosts.includes(m[1])) return `ssh: Could not resolve hostname ${m[1]}`; st.running[m[1]] = false; return { out: "", danger: "Fewer hosts running reportd means less failover, and it doesn't fix the lock." }; } },
      { re: /^redis-cli (GET|PTTL|TTL) lock:(\S+)$/i, use: `redis-cli PTTL lock:${job}`, desc: "inspect the lock key", run: (m) => (m[1].toUpperCase() === "GET" ? "(nil)" : "(integer) -2") },
      { re: /^reportd replay(?: --nights \d+)?$/, use: "reportd replay --nights 7", desc: "replay last week's schedule against the current config", run: (m, st) => { const r = cronReplay(I, st); return K.cols([["night", "hosts that ran " + job, "runs"], ...r.map((x) => [x.date, x.ran.join(", ") || "-", String(x.runs) + (x.runs > 1 ? "  <-- duplicate" : "")])]); } },
    ], { sh: "bash" });
    const lockEnabled = Object.fromEntries(I.hosts.map((h) => [h, !(I.lv === 2 && h === I.override)]));
    return {
      prompt: "ops@bastion:~$", run: (line, st) => sh.run(line, st), par: I.lv === 1 ? 5 : 6,
      init: { cfg: { ttl: I.ttl0, renew: "off", release: "del", enabled: true }, lockEnabled, running: Object.fromEntries(I.hosts.map((h) => [h, true])) },
      motd: `TICKET: customers received the ${I.job} email twice on ${I.nights[I.nights.length - 1].date}.\nreportd runs on ${I.hosts.join(", ")}; each fires at 02:00 and takes a Redis lock so only one runs.`,
      cmds: ["consul kv get -recurse reportd/", `ssh ${I.hosts[0]} journalctl -u reportd --since yesterday`, `ssh ${I.hosts[1]} journalctl -u reportd --since yesterday`, `ssh ${I.hosts[2]} journalctl -u reportd --since yesterday`, "ssh <host> cat /etc/reportd/override.yaml", "consul kv put reportd/lock.<key> <value>", "reportd replay --nights 7"],
    };
  }

  /* ---------- queue processing models (scenario 29) ---------- */
  function queueModel(I) {
    if (I.lv === 3) {
      const recv = (w) => (s) => { const m = s.q.find((x) => !x.taken); if (!m) { s[w] = null; return "ReceiveMessage: no messages"; } m.taken = true; s[w] = m.id; return `got MessageId ${m.id}`; };
      const charge = (w) => (s) => { if (!s[w]) return "nothing to do"; const key = s[w]; if (s.psp.includes(key)) return `PSP: idempotency key ${key} seen, returns the first result`; s.psp.push(key); s.charges++; return (s.charges > 1 ? "!" : "") + `card charged (key ${key})`; };
      const del = (w) => (s) => (s[w] ? "DeleteMessage ok" : "nothing to delete");
      return {
        init: { q: [], psp: [], charges: 0, W1: null, W2: null },
        lanes: [
          { name: "checkout API (producer)", steps: [`SendMessage {order: ${I.ord}} (times out client-side, but succeeded)`, `retry SendMessage {order: ${I.ord}}`], ops: [(s) => { s.q.push({ id: I.mids[0], taken: false }); return "message 1 enqueued"; }, (s) => { s.q.push({ id: I.mids[1], taken: false }); return "message 2 enqueued: a new MessageId"; }] },
          { name: "worker A", steps: ["ReceiveMessage", "charge card, idempotency key = MessageId", "DeleteMessage"], ops: [recv("W1"), charge("W1"), del("W1")] },
          { name: "worker B", steps: ["ReceiveMessage", "charge card, idempotency key = MessageId", "DeleteMessage"], ops: [recv("W2"), charge("W2"), del("W2")] },
        ],
        broken: (s) => s.charges > 1, verdict: (s) => `the customer was charged ${s.charges} time${s.charges === 1 ? "" : "s"} for order ${I.ord}`,
        solve: [0, 0, 1, 1, 2, 2, 1, 2], bad: [[0, 1, 1, 1, 2, 2, 2, 0], [1, 2, 0, 0, 1, 1, 2, 2]],
      };
    }
    const recv = (w) => (s) => { if (s.deleted) { s[w] = false; return "ReceiveMessage: no messages"; } if (!s.visible) { s[w] = false; return "ReceiveMessage: no messages (in flight, invisible)"; } s.visible = false; s.inflight = w; s[w] = true; return `got the message (receive #${++s.recvs})`; };
    const check = (w) => (s) => { if (!s[w]) return "nothing to do"; s[w + "seen"] = s.rows > 0; return s.rows ? "row exists: skip" : "no row yet"; };
    const charge = (w) => (s) => { if (!s[w] || s[w + "seen"]) return "skipped"; s.charges++; return (s.charges > 1 ? "!" : "") + "card charged"; };
    const ins = (w) => (s) => { if (!s[w] || s[w + "seen"]) return "skipped"; s.rows++; return "INSERT charges row"; };
    const del = (w) => (s) => { if (!s[w]) return "nothing to delete"; s.deleted = true; return "DeleteMessage ok"; };
    const W = (w) => I.lv === 1 ? { steps: ["ReceiveMessage", `charge card for order ${I.ord}`, "DeleteMessage"], ops: [recv(w), (s) => { if (!s[w]) return "skipped"; s.charges++; return (s.charges > 1 ? "!" : "") + "card charged"; }, del(w)] }
      : { steps: ["ReceiveMessage", `SELECT 1 FROM charges WHERE order_id = ${I.ord}`, "charge card", "INSERT INTO charges", "DeleteMessage"], ops: [recv(w), check(w), charge(w), ins(w), del(w)] };
    const A = W("W1"), B = W("W2");
    return {
      init: { visible: true, deleted: false, inflight: null, recvs: 0, charges: 0, rows: 0, W1: false, W2: false },
      lanes: [
        { name: "worker A", steps: A.steps, ops: A.ops },
        { name: "SQS", steps: [`visibility timeout (${I.vis} s) expires; PSP call still running`], ops: [(s) => { if (s.deleted || s.visible) return "nothing in flight"; s.visible = true; return "!message visible again"; }] },
        { name: "worker B", steps: B.steps, ops: B.ops },
      ],
      broken: (s) => s.charges > 1, verdict: (s) => `the card was charged ${s.charges} time${s.charges === 1 ? "" : "s"}`,
      solve: I.lv === 1 ? [0, 1, 2, 2, 0, 0, 2] : [0, 0, 1, 2, 2, 2, 0, 0, 0, 2, 2],
      bad: I.lv === 1 ? [[0, 0, 0, 1, 2, 2, 2], [1, 0, 0, 0, 2, 2, 2]] : [[0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 0]],
    };
  }

  /* ---------- partition keys (scenario 30) ---------- */
  function partEval(I, cfg) {
    const scopeOk = I.scope === "order" ? ["order_id", "customer_id", "merchant_id"].includes(cfg.key) : cfg.key === I.scope + "_id";
    const orderOk = scopeOk && cfg.mode !== "pool";
    const per = I.total / I.P;
    const hot = cfg.key === "merchant_id" ? I.total * I.topMerchant : cfg.key === "customer_id" ? I.total * I.topCustomer : 0;
    const maxPart = Math.max(per, hot + (I.total - hot) / I.P);
    const keyLoad = cfg.key === "merchant_id" ? I.total * I.topMerchant : cfg.key === "customer_id" ? I.total * I.topCustomer : 3;
    const capP = cfg.mode === "single" ? I.c1 : I.c1 * 8;
    const util = Math.max(maxPart / capP, cfg.mode === "keyed" ? keyLoad / I.c1 : 0);
    const errs = [];
    if (!scopeOk) errs.push(`events for one ${I.scope} land on different partitions, so their relative order is lost`);
    else if (cfg.mode === "pool") errs.push("a thread pool processes events from the same partition in any order");
    if (util > 1) errs.push(`the hottest partition needs ${K.pct(util, 0)} of its consumer's capacity, so lag grows without bound`);
    return { orderOk, util, maxPart, errs };
  }

  LB.addAll("dist", [
    /* 21 */ {
      id: "dist-siblings",
      name: "Return the right siblings",
      kind: "Investigation",
      skills: ["diagnose", "design"],
      w: "select",
      gen(lv, R) {
        const ids = lv === 1 ? ["a", "b"] : lv === 2 ? ["a", "b", "c"] : ["n1", "n2", "n3"];
        const nv = lv === 1 ? 3 : lv === 2 ? 4 : 5;
        const vs = [];
        const base = Object.fromEntries(ids.map((k) => [k, R.int(0, 2)]));
        for (let i = 0; i < nv * 4 && vs.length < nv; i++) {
          const v = K.clone(R.chance(0.5) && vs.length ? R.pick(vs).v : base);
          const k = R.pick(ids); v[k] = (v[k] || 0) + R.int(1, 2);
          if (lv === 3 && R.chance(0.4) && vs.length >= 2) { const [x, y] = R.sample(vs, 2); ids.forEach((q) => (v[q] = Math.max(x.v[q] || 0, y.v[q] || 0))); }
          if (vs.some((o) => vcCmp(o.v, v, ids) === 3)) continue;
          vs.push({ v, val: "" });
        }
        if (vs.length < nv) return null;
        const items = ["oat milk", "espresso beans", "croissant", "green tea", "bagels", "honey", "rye bread", "granola"];
        vs.forEach((x, i) => (x.val = R.sample(items, 2).join(" + ") + (i % 2 ? "" : ", x2")));
        const sib = vs.map((x, i) => (vs.some((o, j) => j !== i && vcCmp(x.v, o.v, ids) === 0) ? -1 : i)).filter((i) => i >= 0);
        if (sib.length < 2 || sib.length === vs.length) return null;
        return { lv, ids, vs, key: R.pick(["cart:5531", "cart:u-918", "cart:guest-77"]) };
      },
      text: (I) => `<p>A read of <code>${esc(I.key)}</code> at quorum gathered these versions from the replicas (a Dynamo-style store with ${I.lv === 3 ? "version vectors" : "vector clocks"}; missing entries are 0).</p>
        <p>Select exactly the versions the store must <b>return to the client as siblings</b>: everything else is safe to discard because a newer version already includes it.</p>`,
      ui: (I) => ({ opts: I.vs.map((x, i) => `v${i + 1} ${vcStr(x.v, I.ids)}  "${x.val}"`), live: (sel) => {
        if (!sel || !sel.length) return "";
        const ctx = Object.fromEntries(I.ids.map((k) => [k, Math.max(...sel.map((i) => I.vs[i].v[k] || 0))]));
        return K.note(`If the client merges these and writes back, the write carries context <code>${esc(vcStr(ctx, I.ids))}</code>, which supersedes ${I.vs.filter((x) => vcCmp(x.v, ctx, I.ids) !== 2 && vcCmp(x.v, ctx, I.ids) !== 1).length} of the ${I.vs.length} versions.`);
      } }),
      ans: (I) => I.vs.map((x, i) => (I.vs.some((o, j) => j !== i && vcCmp(x.v, o.v, I.ids) === 0) ? -1 : i)).filter((i) => i >= 0),
      diag: () => "Not quite. A version can be discarded only if some single other version is ≥ it in every entry. Versions that nobody dominates must all be returned.",
      hint: (I) => I.lv === 3 ? "Being dominated by the merge of two versions doesn't count: it must be dominated by one actual version." : "For each version, look for another one that is ≥ in every entry.",
      concept: "Siblings and causal context",
      how: "When replicas hold versions that no single version supersedes, the store can't pick a winner without losing a write, so a read returns all of them as siblings. A version is obsolete only if another version's vector is ≥ in every entry. The client resolves the siblings (for a cart, usually a set union, with care for removals) and writes back with the merged causal context (the element-wise max), which supersedes every sibling it saw. Writes without context, or last-writer-wins, silently drop concurrent updates instead.",
      rule: "Always read before write and send the causal context back; resolve siblings with a merge function that's commutative and idempotent, or use a CRDT.",
      why: (I) => { const s = I.vs.map((x, i) => (I.vs.some((o, j) => j !== i && vcCmp(x.v, o.v, I.ids) === 0) ? -1 : i)).filter((i) => i >= 0); return `v${s.map((i) => i + 1).join(", v")} are not dominated by any other version, so each holds an update the others haven't seen; the rest are ancestors of one of them.`; },
    },
    /* 22 */ {
      id: "dist-lamport-clock",
      name: "Stamp the Lamport clock",
      kind: "Estimate",
      skills: ["diagnose"],
      w: "num",
      gen: lamportGen,
      text: (I) => `<p>Processes use Lamport clocks: every event increments the local counter; a message carries the sender's counter; on receive, the counter becomes <code>max(local, received) + 1</code>. All counters start at 0. Events happen in the order below.</p>${lamportTable(I)}<p>What is the Lamport timestamp of the event marked <b>★</b>?</p>`,
      ui: () => ({ unit: "" }),
      accept: LB.near((I) => I.ts, 0),
      solve: (I) => I.ts,
      bad: (I) => [I.ts - 1, I.ev.filter((e) => e.p === I.ev[I.target].p).slice(0, I.ev.filter((e, i) => i <= I.target && e.p === I.ev[I.target].p).length).length === I.ts ? I.ts + 1 : I.ev.filter((e, i) => i <= I.target && e.p === I.ev[I.target].p).length],
      hint: () => "Track the counter of every process step by step; remember the value a send stamps on its message.",
      concept: "Lamport clocks",
      how: "A Lamport clock is a single counter per process: increment before each event, attach it to outgoing messages, and on receipt jump to max(local, received) + 1. This guarantees that if event a happened before b (same process earlier, or a send before its receive, transitively) then L(a) < L(b). The converse does not hold: L(a) < L(b) can also happen for concurrent events, so Lamport clocks give a total order consistent with causality (with a node id tie-break) but can't detect concurrency. Vector clocks can.",
      rule: "Use Lamport timestamps when you need an order that respects causality (e.g. tie-breaking, log merging); use vector clocks or version vectors when you must detect concurrent updates.",
      why: (I) => `Replaying the steps, P${I.ev[I.target].p + 1}'s counter reaches ${I.ts} at ★${I.ev[I.target].k === "recv" ? ": the receive jumps past the sender's stamp" : ""}. Counting only P${I.ev[I.target].p + 1}'s own events would give ${I.ev.filter((e, i) => i <= I.target && e.p === I.ev[I.target].p).length}.`,
    },
    /* 23 */ {
      id: "dist-crdt-pick",
      name: "Pick the CRDT",
      kind: "Design review",
      skills: ["design"],
      w: "classify",
      gen(lv, R) {
        const bank = {
          1: [["Page views of an article, counted on every edge node", 0], ["Seats left in a venue: reserve and release from any region", 1], ["Items in a shopping cart; a removed item can be added again later", 2], ["A user's display name; the latest edit should win", 3], ["Total API calls per tenant for billing, incremented on every gateway", 0], ["Upvotes minus downvotes on a comment", 1], ["Tags on a shared document; people add and remove tags offline", 2], ["Profile photo URL, set from any device", 3]],
          2: [["Banned word list for chat; a word is never un-banned once removed... no, once added it can be removed, but never re-added", 4], ["Members of a group chat who can leave and rejoin", 2], ["Likes on a post, where each user can like and unlike any number of times", 2], ["Inventory delta from many warehouses (receipts and shipments)", 1], ["Feature flag value; show the user both if edits conflict so they choose", 5], ["Document title edited on two laptops offline; keep both for the user to resolve", 5], ["Pageview counter", 0], ["One-shot checklist: items are added once and, once ticked off and deleted, never come back", 4]],
          3: [["Collaborators on a doc, removed and re-invited often, edited offline on phones", 2], ["Remaining quota that must never go below zero across regions", 6], ["Count of distinct users who ever opened the app (approximate is fine)", 7], ["Bank account balance with an overdraft limit, debited in two regions", 6], ["Shopping cart quantities per item, incremented and decremented on several devices", 1], ["Last known GPS position of a delivery van, reported by the van only", 3], ["Unique visitors per day across 40 edge PoPs", 7], ["Unread-message count that goes up and down", 1]],
        };
        const cats = lv === 1 ? ["G-Counter", "PN-Counter", "OR-Set", "LWW-Register"] : lv === 2 ? ["G-Counter", "PN-Counter", "OR-Set", "LWW-Register", "2P-Set", "MV-Register"] : ["G-Counter", "PN-Counter", "OR-Set", "LWW-Register", "2P-Set", "MV-Register", "Not a CRDT: needs coordination", "HyperLogLog (merge = max per register)"];
        const items = R.sample(bank[lv].filter((x) => !/no, once/.test(x[0])), lv === 1 ? 5 : 6);
        return { lv, cats, items };
      },
      text: (I) => `<p>Your team is building offline-first and multi-region features where replicas accept writes independently and merge later. For each piece of state, pick the replicated data type that gives the right merged result${I.lv === 3 ? ", or flag the ones that can't be done without coordination" : ""}.</p>`,
      ui: (I) => ({ items: I.items.map((x) => x[0]), cats: I.cats }),
      ans: (I) => I.items.map((x) => x[1]),
      diag: () => "Not quite. Ask: does it only grow? can it shrink? can removed elements come back? should the latest write win, or should conflicts be shown? does it need an invariant across replicas?",
      hint: (I) => I.lv === 3 ? "Merging can't enforce a global invariant like 'never below zero': two replicas can each approve the last unit." : "Counters: grow-only vs up-and-down. Sets: can a removed element be re-added? Registers: pick one or keep both?",
      concept: "Choosing a CRDT",
      how: "CRDTs are data types whose replicas can be updated independently and merged in any order with the same result. A G-Counter keeps one count per replica and sums them (merge = per-replica max); a PN-Counter pairs two G-Counters for increments and decrements. An OR-Set tags each add uniquely so a remove only cancels the adds it has seen, allowing re-adds; a 2P-Set makes removal permanent. An LWW-Register keeps the value with the highest timestamp, silently dropping the other; an MV-Register keeps all concurrent values for the user to resolve. Invariants that span replicas (non-negative balances, uniqueness) can't be guaranteed by merging alone and need coordination or escrow.",
      rule: "Match the merge semantics to the business rule: counters for counts, OR-Sets for add/remove collections, MV-Registers when losing an edit is unacceptable, and coordination when an invariant spans replicas.",
      why: (I) => `${I.items.map((x) => `${esc(x[0].split(";")[0].split(",")[0])} → ${esc(I.cats[x[1]])}`).join("; ")}.`,
    },
    /* 24 */ {
      id: "dist-crdt-merge",
      name: "Merge the counters",
      kind: "Estimate",
      skills: ["diagnose"],
      w: "num",
      gen: counterGen,
      text: (I) => `<p>${cap1(I.what)} is a ${I.lv === 1 ? "G-Counter" : "PN-Counter"} replicated on ${I.reps.length} nodes. Each node's state is its view of every node's ${I.lv === 1 ? "increments" : "increments (P) and decrements (N)"}; views of other nodes may be stale.${I.lv === 3 ? " One node was just restored from a backup taken hours ago." : ""}</p>
        ${K.table(["state on", ...I.reps], I.views.map((v, i) => [`<b>${I.reps[i]}</b>`, ...I.reps.map((r) => (I.lv === 1 ? String(v[r].p) : `P ${v[r].p} · N ${v[r].n}`))]), { compact: true, mono: I.reps.map((_, i) => i + 1) })}
        <p>After all states are merged, what value does every node report?${I.lv >= 2 ? ` (A dashboard that just adds up every cell shows ${I.naive}.)` : ""}</p>`,
      ui: () => ({ unit: "" }),
      accept: LB.near((I) => I.value, 0),
      solve: (I) => I.value,
      bad: (I) => [I.naive, ...(I.lv === 1 ? [] : [K.sum(I.reps.map((r) => Math.max(...I.views.map((v) => v[r].p))))])].filter((x) => x !== I.value),
      hint: (I) => I.lv === 1 ? "Merge takes, for each node's slot, the maximum any view has seen. Then sum the slots." : "Merge P and N slot by slot with max, then value = ΣP − ΣN. A stale view can never lower a slot.",
      concept: "CRDT counter merge",
      how: "In a G-Counter each replica only increments its own slot, so the true value of a slot is the largest anyone has seen; merge is the element-wise maximum, and the value is the sum of slots. Because max is commutative, associative and idempotent, states can be merged in any order, any number of times. A PN-Counter keeps two such vectors, increments and decrements, and reports ΣP − ΣN. Summing everything you see, or merging by taking a single replica's total, double-counts or loses updates; a stale replica (e.g. restored from backup) is harmless because max ignores old values.",
      rule: "Merge per-replica slots with max, then aggregate. Never add up replicas' totals.",
      why: (I) => `Per-slot maxima give the value ${I.value}. Adding every cell gives ${I.naive}, which counts each update once per replica that has seen it.${I.lv === 3 ? " The restored node's old numbers lose every max comparison, so they change nothing." : ""}`,
    },
    /* 25 */ {
      id: "dist-session-routing",
      name: "Route reads for session guarantees",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "primary read share:",
      gen(lv, R) { return { lv, lagP99: lv === 1 ? R.pick([0.4, 0.8]) : R.pick([7, 9, 12]), readsAfterWrite: R.pick([0.18, 0.25, 0.3]), behindFrac: R.pick([0.02, 0.04]), replicaFailover: lv >= 2, app: R.pick(["the profile service", "the notes app", "the order history page"]) }; },
      text: (I) => `<p>${cap1(I.app)} reads from async Postgres replicas to keep load off the primary. Replica lag p99 is <b>${I.lagP99} s</b>${I.lv >= 2 ? " (spikes during vacuum and bulk jobs); replicas are also replaced during maintenance, and a session's replica can change to one further behind" : ""}. ${K.pct(I.readsAfterWrite, 0)} of reads come within 5 s of the same user's write.</p>
        <p>Users must ${I.lv === 1 ? "always see their own writes" : I.lv === 2 ? "see their own writes and never see data go backwards" : "see their own writes and never go backwards, <b>including across their devices</b> (edit on the phone, open the laptop)"}. Pick the routing that guarantees this with the <b>smallest share of reads on the primary</b>.</p>`,
      ui: (I) => {
        const knobs = [{ k: "route", label: "Read routing", opts: Object.keys(ROUTES).filter((r) => I.lv > 1 || r !== "lsn"), fmt: (v) => ROUTES[v], select: true }];
        if (I.lv === 3) knobs.push({ k: "store", label: "Where the last-seen LSN is kept", opts: ["cookie", "server"], fmt: (v) => (v === "cookie" ? "signed cookie in the browser/app" : "server-side, per user id (e.g. Redis)") });
        return { knobs, live: (cfg) => { const r = routeEval(I, cfg); return K.metrics([{ name: "Read-your-writes", value: r.ryw ? "yes" : "no", ok: r.ryw }, ...(I.lv >= 2 ? [{ name: "Monotonic reads", value: r.mono ? "yes" : "no", ok: r.mono }] : []), ...(I.lv === 3 ? [{ name: "Across devices", value: r.cross ? "yes" : "no", ok: r.cross }] : []), { name: "Reads on primary", value: K.pct(r.load, 0), ok: null }]) + (r.errs.length ? K.note(esc(r.errs[0]), "bad") : ""); } };
      },
      valid: (I, cfg) => { const r = routeEval(I, cfg); return r.errs.length ? r.errs[0] : true; },
      val: (I, cfg) => Math.round(routeEval(I, cfg).load * 1000),
      vfmt: (v) => K.pct(v / 1000, 1),
      hint: (I) => I.lv === 1 ? "If lag is always well under the window, a time window is enough and cheap." : I.lv === 2 ? "A fixed window is a guess about lag. What tracks the actual position the user has seen?" : "The token has to follow the user, not the device.",
      concept: "Implementing session guarantees",
      how: "Read-your-writes and monotonic reads are per-session promises layered on asynchronous replicas. A time window ('read from the primary for N seconds after a write') works only if lag never exceeds N. Sticky routing gives monotonic reads until the replica changes. The robust approach records the WAL position (LSN) of the user's last write and of every read, and serves a read from a replica only if its replay position (pg_last_wal_replay_lsn()) has reached that LSN, otherwise waits briefly or falls back to the primary. Where the token lives defines the 'session': a cookie covers one device, a server-side record keyed by user covers all of them.",
      rule: "Track positions, not time: carry the last-seen LSN/version with the user and route reads to replicas that have caught up to it.",
      why: (I, sol) => { const r = routeEval(I, sol); return `${cap1(ROUTES[sol.route])}${sol.store ? ` with the token stored ${sol.store === "server" ? "server-side per user" : "in a cookie"}` : ""}: guarantees hold and only ${K.pct(r.load, 0)} of reads hit the primary.${I.lv >= 2 ? ` A 5 s window fails because lag reaches ${I.lagP99} s.` : ""}`; },
    },
    /* 26 */ {
      id: "dist-hinted-handoff",
      name: "Heal the stale replica",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      ...LB.term({
        shell: (I) => cassShell(I),
        goal(st, I) {
          if (st.zombie) return "You brought back a node that was down longer than gc_grace_seconds; deleted carts will reappear.";
          if (st.assassinated) return "assassinate removed the node without re-replicating its ranges.";
          if (I.lv === 3) return st.removed ? true : "The dead node is still in the ring, holding a third of the replicas for its ranges.";
          if (I.lv === 2 && st.partial && !st.fixed) return "A primary-range repair on one node leaves the ranges it holds as a replica unrepaired.";
          return st.fixed ? true : "Replicas are still inconsistent: reads at LOCAL_ONE can return old data.";
        },
        solve: (I) => I.lv === 1 ? { log: ["nodetool statushandoff", "grep -i hint /var/log/cassandra/system.log", "nodetool enablehandoff"] } : I.lv === 2 ? { log: ["grep -i hint /var/log/cassandra/system.log", `nodetool repair -full ${I.ks}`] } : { log: ["nodetool status", `cqlsh -e "DESCRIBE TABLE ${I.ks}.${I.tbl}"`, `nodetool removenode ${I.ids[I.bad]}`] },
      }),
      gen(lv, R) {
        const base = R.pick(["10.0.2.", "10.4.1.", "172.20.3."]), ips = R.distinct(lv === 1 ? 3 : 6, 10, 60).map((x) => base + x);
        const ids = ips.map(() => U.range(5).map((k) => R.str([8, 4, 4, 4, 12][k], "0123456789abcdef")).join("-"));
        return { lv, ips, ids, bad: R.int(0, ips.length - 1), dc: R.pick(["dc1", "eu-west", "us-east"]), ks: R.pick(["shop", "carts", "commerce"]), tbl: R.pick(["carts", "cart_items"]), day: `2026-09-${String(R.int(10, 28)).padStart(2, "0")}`, hints: R.int(20000, 90000) };
      },
      bad: (I) => [{ log: ["nodetool status"] }, ...(I.lv === 3 ? [{ log: [`ssh ${I.ips[I.bad]} sudo systemctl start cassandra`, `nodetool repair -full ${I.ks}`] }, { log: [`nodetool assassinate ${I.ips[I.bad]}`] }] : I.lv === 2 ? [{ log: ["nodetool enablehandoff"] }, { log: [`nodetool repair -pr ${I.ks}`] }] : [{ log: ["nodetool getmaxhintwindow"] }])],
      text: (I) => `<p>You're on the bastion of a Cassandra ${I.lv === 3 ? "5.0" : "4.1"} cluster. Read the ticket above the prompt, find out why replicas disagree (or would), and fix it with the least risk. Type <code>help</code> for what this sandbox understands.</p>`,
      hint: (I) => I.lv === 1 ? "Hinted handoff should have replayed the missed writes when the node came back. Did it?" : I.lv === 2 ? "Hints are only kept for max_hint_window. What fixes data older than that?" : "Compare how long the node was down with gc_grace_seconds before you start anything.",
      concept: "Hinted handoff, repair and gc_grace",
      how: "When a replica is down, coordinators store hints for writes it missed and replay them when it returns, but only for max_hint_window (3 h by default) and only if hinted handoff is enabled. Anything older must be fixed by anti-entropy repair, which compares Merkle trees between replicas and streams the differences; -pr limits a run to the node's primary ranges and must then be run on every node. Deletes are tombstones kept for gc_grace_seconds (10 days by default); a replica that missed a delete and comes back after the tombstone was purged elsewhere will resurrect the deleted data. Such a node must not rejoin with its old data: remove it (nodetool removenode) and bootstrap a fresh replacement.",
      rule: "Repair every node at least once per gc_grace_seconds, repair after any outage longer than the hint window, and never restart a node that was down longer than gc_grace with its old data.",
      why: (I) => I.lv === 1 ? `Someone ran disablehandoff during maintenance, so ${I.hints} hints for ${I.ips[I.bad]} were never delivered. Re-enabling handoff replays them.` : I.lv === 2 ? `The node was down ~5 h; coordinators stopped writing hints after 3 h, so later writes exist only on the other replicas. A full repair streams the differences.` : `The node was down 12 days, longer than gc_grace_seconds (864000 s = 10 days). Tombstones for carts deleted meanwhile are gone elsewhere, so its old rows would come back. Remove it and bootstrap a clean replacement.`,
    },
    /* 27 */ {
      id: "dist-replication-lag",
      name: "When does the replica catch up?",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) { const w = R.int(3, 6) * 10, r = w + R.int(2, 4) * 10, extra = R.int(6, 12) * 10, mins = R.int(5, 15); return { lv, w, r, extra, mins }; }
        if (lv === 2) { const w = R.int(3, 6) * 10, r = w + R.int(1, 3) * 10, extra = R.int(8, 14) * 10, mins = R.int(10, 20); return { lv, w, r, extra, mins }; }
        const rows = R.pick([3, 4, 6]) * 1e6, base = R.int(15, 25) * 100, apply = base + R.int(10, 20) * 100, jobMin = R.int(4, 8);
        return { lv, rows, base, apply, jobMin };
      },
      text: (I) => I.lv === 1 ? `<p>The primary normally generates <b>${I.w} MB/s</b> of WAL; the replica can replay <b>${I.r} MB/s</b>. A backfill adds <b>${I.extra} MB/s</b> more WAL for <b>${I.mins} minutes</b>. How many <b>minutes after the backfill ends</b> until the replica has caught up?</p>`
        : I.lv === 2 ? `<p>The primary writes <b>${I.w} MB/s</b> of WAL; the replica replays at most <b>${I.r} MB/s</b>. A migration adds <b>${I.extra} MB/s</b> for <b>${I.mins} minutes</b>. For how many <b>minutes in total</b>, from the start of the migration, is the replica behind at all?</p>`
          : `<p>A MySQL replica applies the binlog with a single SQL thread at about <b>${K.num(I.apply)} row changes/s</b>. Normal traffic produces <b>${K.num(I.base)} row changes/s</b>. A cleanup job deletes <b>${K.num(I.rows)}</b> rows in ${I.jobMin} minutes with row-based replication. How many <b>minutes after the job starts</b> until the replica is caught up?</p>`,
      ui: () => ({ unit: "minutes" }),
      accept: LB.near((I) => truthLag(I), 0.15),
      solve: (I) => K.round(truthLag(I), 1),
      bad: (I) => I.lv === 1 ? [I.mins, (I.extra * I.mins) / I.r] : I.lv === 2 ? [I.mins] : [I.jobMin, I.rows / I.apply / 60],
      hint: (I) => I.lv === 3 ? "Total work to apply = (normal + job) changes; the replica drains the excess at (apply − normal)." : "Backlog grows at (write − replay) while the extra load runs, then drains at (replay − normal write).",
      concept: "Replication lag arithmetic",
      how: "A replica falls behind whenever the primary produces changes faster than the replica can apply them. During a burst the backlog grows at (incoming − apply rate); afterwards it drains only at (apply rate − normal incoming rate), which is often much smaller, so lag outlives the burst by a large factor. Replicas that apply single-threaded (classic MySQL SQL thread, or a Postgres standby stuck on I/O) have an apply ceiling far below the primary's write capacity. Bulk jobs should be throttled to the replica's spare apply capacity.",
      rule: "Before a bulk job, compute spare apply capacity (apply − normal) and throttle the job below it, or plan for lag ≈ excess volume ÷ spare capacity.",
      why: (I) => I.lv === 1 ? `Backlog = (${I.w + I.extra} − ${I.r}) MB/s × ${I.mins} min = ${K.num((I.w + I.extra - I.r) * I.mins * 60 / 1000, 1)} GB; it drains at ${I.r - I.w} MB/s, so ≈ ${K.num(truthLag(I), 1)} min.` : I.lv === 2 ? `Lag grows for ${I.mins} min and then drains at only ${I.r - I.w} MB/s: ≈ ${K.num(truthLag(I), 1)} min behind in total.` : `The job adds ${K.num(I.rows)} changes; spare apply capacity is ${K.num(I.apply - I.base)}/s, so ≈ ${K.num(truthLag(I), 1)} min.`,
    },
  ]);
  function truthLag(I) {
    if (I.lv === 1) return ((I.w + I.extra - I.r) * I.mins) / (I.r - I.w);
    if (I.lv === 2) return I.mins + ((I.w + I.extra - I.r) * I.mins) / (I.r - I.w);
    const jobRate = I.rows / (I.jobMin * 60);
    if (I.base + jobRate <= I.apply) return I.jobMin;
    return I.rows / (I.apply - I.base) / 60;
  }

  LB.addAll("dist", [
    /* 28 */ {
      id: "dist-cron-runs-twice",
      name: "The nightly job ran twice",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      ...LB.term({
        shell: (I) => cronShell(I),
        goal(st, I) {
          if (I.hosts.some((h) => !st.running[h])) return "Stopping reportd on hosts removes failover; the lock should make one run happen, not fewer daemons.";
          if (!st.cfg.enabled) return "The lock is disabled: every host would run the job.";
          const r = cronReplay(I, st);
          const bad = r.filter((x) => x.runs !== 1);
          return bad.length ? `Replaying last week with your config still runs the job ${bad[0].runs} times on ${bad[0].date}.` : true;
        },
        solve: (I) => I.lv === 1 ? { log: [`ssh ${I.hosts[0]} journalctl -u reportd --since yesterday`, "consul kv put reportd/lock.renew 10s", "reportd replay --nights 7"] }
          : I.lv === 2 ? { log: [`ssh ${I.override} journalctl -u reportd --since yesterday`, `ssh ${I.override} cat /etc/reportd/override.yaml`, `ssh ${I.override} sudo rm /etc/reportd/override.yaml`, "reportd replay --nights 7"] }
            : { log: [`ssh ${I.hosts[0]} journalctl -u reportd --since yesterday`, "consul kv put reportd/lock.renew 10s", "consul kv put reportd/lock.ttl 120s", "consul kv put reportd/lock.release cas", "reportd replay --nights 7"] },
      }),
      gen(lv, R) {
        const hosts = R.sample(["worker-a", "worker-b", "worker-c", "batch-1", "batch-2", "batch-3"], 3);
        const ttl0 = lv === 1 ? 30 : 60;
        const nights = U.range(7).map((k) => ({ date: `2026-10-0${k + 2}`, rt: lv === 1 ? R.int(40, 95) : R.int(25, 50), pause: lv === 3 && (k === 6 || k === 3) ? R.int(62, 72) : 0, ps: R.int(15, 25) }));
        return { lv, hosts, override: lv === 2 ? R.pick(hosts.slice(1)) : null, ttl0, nights, job: R.pick(["invoice-run", "dunning-emails", "monthly-statements"]), mails: R.int(4000, 30000), inc: R.int(1000, 9999) };
      },
      bad: (I) => [{ log: [`ssh ${I.hosts[1]} sudo systemctl stop reportd`, `ssh ${I.hosts[2]} sudo systemctl stop reportd`] }, ...(I.lv === 3 ? [{ log: ["consul kv put reportd/lock.release cas"] }, { log: ["consul kv put reportd/lock.renew 10s"] }] : I.lv === 1 ? [{ log: ["consul kv put reportd/lock.release cas"] }] : [{ log: ["consul kv put reportd/lock.renew 10s"] }])],
      text: (I) => `<p>Customers got duplicate emails from the nightly <code>${esc(I.job)}</code>. reportd is meant to run it exactly once per night through a Redis lock (<code>SET lock:${esc(I.job)} &lt;host&gt; NX PX ttl</code>). Find out why it ran more than once and fix the configuration; <code>reportd replay</code> re-runs last week against your config. Keep all three hosts running for failover.</p>`,
      hint: (I) => I.lv === 1 ? "Compare how long the job takes with the lock TTL." : I.lv === 2 ? "Is every host actually using the lock? Check the logs host by host." : "Renewal stops while the process is frozen. And once a lock has expired, whose lock does a plain DEL remove? Replay after each change.",
      concept: "Distributed cron and lock-based leader election",
      how: "Running a job on several hosts and letting a lock pick one only works if the lock outlives the job: a TTL shorter than the run lets a second host acquire it mid-run. Renewing the lock (a heartbeat that extends it while the job is alive) fixes slow jobs but not process pauses longer than the TTL. Releasing with a plain DEL can delete another host's lock if yours already expired; release must be compare-and-delete (a Lua script checking the value is your token). Per-host overrides that bypass the lock are a classic source of duplicates. Even with all of this, a lock is a best-effort guard; make the job itself idempotent (e.g. a per-night run id).",
      rule: "Lock TTL > worst-case runtime (or renew it), release only your own lock with compare-and-delete, and make the job idempotent per run date anyway.",
      why: (I) => I.lv === 1 ? `The job takes up to ${Math.max(...I.nights.map((n) => n.rt))} s but the lock expired after ${I.ttl0} s, so a second host took it and ran again. Renewal keeps it while the job is alive.` : I.lv === 2 ? `${I.override} had a forgotten override disabling the lock (left from INC-${I.inc}), so it always ran alongside the lock holder.` : `On nights with a ${Math.max(...I.nights.map((n) => n.pause))} s GC pause the lock expired mid-run and a second host ran the job. Renewal alone doesn't help (renewals stop during the pause) and makes it worse: the frozen host finishes first and its plain DEL removes the second host's lock, so a third host runs. A TTL longer than the worst pause, plus compare-and-delete on release, gives one run.`,
    },
    /* 29 */ {
      id: "dist-at-least-once-queue",
      name: "Double charge from the queue",
      kind: "Experiment",
      skills: ["diagnose", "design"],
      gen(lv, R) { return { lv, ord: R.int(10000, 99999), vis: R.pick([30, 60]), mids: [R.str(8, "0123456789abcdef"), R.str(8, "0123456789abcdef")] }; },
      ...laneScenario(queueModel),
      text: (I) => I.lv === 1 ? `<p>Payment workers consume an SQS standard queue with a ${I.vis} s visibility timeout. The payment provider sometimes takes longer than that. Build a schedule in which order ${I.ord} is <b>charged twice</b>.</p>`
        : I.lv === 2 ? `<p>The team added a dedupe check: before charging, a worker looks for a row in <code>charges</code> for the order and inserts one after charging. Build a schedule that still charges <b>twice</b>.</p>`
          : `<p>Now each charge passes the SQS <b>MessageId</b> as the provider's idempotency key, so a redelivered message can't charge twice. But the checkout API sometimes times out on <code>SendMessage</code> and retries. Build a schedule that charges order ${I.ord} <b>twice</b>.</p>`,
      hint: (I) => I.lv === 1 ? "What makes the message visible again while worker A is still busy?" : I.lv === 2 ? "Both workers can check before either inserts." : "Is the retry the same message as far as SQS is concerned?",
      concept: "At-least-once delivery needs idempotent consumers",
      how: "Queues like SQS deliver at least once: a message reappears if it isn't deleted within the visibility timeout, standard queues can occasionally deliver duplicates, and producers that retry after a timeout enqueue a second copy with a new MessageId. Consumers must therefore be idempotent on a key that identifies the business operation (order id, payment intent id), enforced atomically: a unique constraint written in the same transaction as the effect, or an idempotency key passed to the external system. A check-then-act sequence leaves a race window; a delivery-level id doesn't catch producer duplicates.",
      rule: "Assume every message arrives more than once. Deduplicate on a business key with an atomic constraint, and extend visibility (heartbeat) for long work.",
      why: (I) => I.lv === 1 ? `The provider call outlasted the ${I.vis} s visibility timeout, the message became visible, and worker B charged again.` : I.lv === 2 ? "Both workers ran the SELECT before either INSERT, so both saw no row. Use INSERT ... ON CONFLICT (order_id) DO NOTHING first, or pass the order id as the provider's idempotency key." : `The producer's retry created a second message with a different MessageId, so the provider saw two different keys. Use the order id (or a client-generated payment id) as the idempotency key.`,
    },
    /* 30 */ {
      id: "dist-partition-ordering",
      name: "Choose the partition key",
      kind: "Design review",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "peak consumer utilisation:",
      gen(lv, R) {
        return { lv, P: R.pick([24, 32, 48]), total: lv === 1 ? R.int(5, 7) * 1000 : R.int(8, 10) * 1000, c1: R.pick([400, 500]), topCustomer: lv === 2 ? R.pick([0.025, 0.03]) : 0.01, topMerchant: lv === 3 ? R.pick([0.25, 0.3]) : 0.05, scope: lv === 2 ? "customer" : "order", topic: R.pick(["order-events", "commerce.events", "orders.v2"]) };
      },
      text: (I) => `<p>The <code>${esc(I.topic)}</code> topic has <b>${I.P} partitions</b> and carries <b>${K.num(I.total)} events/s</b>: order created, paid, refunded, shipped. One consumer thread handles about <b>${I.c1} events/s</b>.${I.lv === 3 ? ` The largest merchant produces <b>${K.pct(I.topMerchant, 0)}</b> of all events.` : I.lv === 2 ? ` The largest customer (a reseller) produces <b>${K.pct(I.topCustomer, 1)}</b> of events.` : ""}</p>
        <p>Consumers must apply events in order <b>per ${I.scope}</b>${I.scope === "customer" ? " (they maintain a running credit balance across that customer's orders)" : ""}. Pick the partition key and consumer threading that keep that order with the lowest peak utilisation.</p>`,
      ui: (I) => ({ knobs: [
        { k: "key", label: "Partition key", opts: ["event_id", "order_id", "customer_id", "merchant_id"] },
        { k: "mode", label: "Consumer threading", opts: ["single", "pool", "keyed"], fmt: (v) => (v === "single" ? "one thread per partition" : v === "pool" ? "thread pool, any order" : "8 threads, same key → same thread") },
      ], live: (cfg) => { const r = partEval(I, cfg); return K.metrics([{ name: `Order per ${I.scope}`, value: r.orderOk ? "kept" : "broken", ok: r.orderOk }, { name: "Hottest partition", value: `${K.num(r.maxPart)} ev/s`, ok: null }, { name: "Peak utilisation", value: K.pct(r.util, 0), ok: r.util <= 1 }]) + (r.errs.length ? K.note(esc(r.errs[0]), "bad") : ""); } }),
      valid: (I, cfg) => { const r = partEval(I, cfg); return r.errs.length ? r.errs[0] : true; },
      val: (I, cfg) => Math.round(partEval(I, cfg).util * 1000),
      vfmt: (v) => K.pct(v / 1000, 0),
      hint: (I) => I.lv === 1 ? "Order is only guaranteed within a partition, and only if the consumer processes a partition's events in order." : I.lv === 2 ? "Events that must be ordered together must share a key; the coarser the key, the hotter the hottest partition." : "Every order belongs to one merchant, so merchant_id would keep order... at what cost?",
      concept: "Ordering across partitions",
      how: "Log-based brokers (Kafka, Kinesis, Pub/Sub ordering keys) only order messages within a partition, and the producer chooses the partition by hashing a key. Everything that must be ordered together must share that key, so the key's granularity is a trade-off: fine-grained keys spread load evenly, coarse keys (customer, merchant) keep more things ordered but concentrate hot entities on one partition, whose throughput is capped by a single consumer. Consumers can parallelise within a partition only by key (a keyed executor), never with a plain thread pool.",
      rule: "Key by the smallest entity whose events must stay ordered; parallelise per key inside the consumer; check the hottest key's rate against one consumer's capacity.",
      why: (I, sol) => { const r = partEval(I, sol); return `Key ${sol.key}, ${sol.mode === "keyed" ? "keyed executor" : sol.mode === "single" ? "one thread per partition" : "pool"}: order per ${I.scope} holds and peak utilisation is ${K.pct(r.util, 0)}.${I.lv === 3 ? ` Keying by merchant would put ${K.pct(I.topMerchant, 0)} of traffic (${K.num(I.total * I.topMerchant)} events/s) behind one consumer.` : ""}`; },
    },
  ]);
})();
