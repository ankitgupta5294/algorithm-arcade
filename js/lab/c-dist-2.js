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
  /* ---------- Snowflake layout (scenario 31) ---------- */
  const YEAR_MS = 365.25 * 24 * 3600 * 1000;
  function flakeEval(I, cfg) {
    const seq = 63 - cfg.ts - cfg.worker, unit = cfg.unit === "10ms" ? 10 : 1;
    const life = (2 ** cfg.ts * unit) / YEAR_MS, workers = 2 ** cfg.worker, rate = seq >= 0 ? (2 ** seq * 1000) / unit : 0;
    const errs = [];
    if (seq < 1) errs.push("no bits left for the sequence");
    if (life < I.life) errs.push(`timestamps run out after ${K.num(life, 1)} years (need ${I.life})`);
    if (workers < I.workers) errs.push(`${K.num(workers)} worker ids, fewer than the ${K.num(I.workers)} needed`);
    if (rate < I.rate) errs.push(`only ${K.num(rate)} ids/s per worker (peak ${K.num(I.rate)})`);
    return { seq, life, workers, rate, errs };
  }

  /* ---------- Snowflake code review (scenario 32) ---------- */
  function flakeCode(I) {
    const L = (t, k = " ") => ({ t, k });
    const head = [L("@@ func (g *Generator) Next() int64 @@", "@"), L("\tg.mu.Lock()"), L("\tdefer g.mu.Unlock()"), L("\tnow := time.Now().UnixMilli() - epoch")];
    if (I.lv === 1) return { bug: [5], file: "idgen/generator.go", lines: [...head,
      L("\tif now == g.last {"), L("\t\tg.seq = (g.seq + 1) & seqMask", "+"), L("\t} else {"), L("\t\tg.seq = 0"), L("\t}"), L("\tg.last = now"), L(`\treturn now<<${I.tsShift} | g.worker<<${I.wShift} | g.seq`)] };
    if (I.lv === 2) return { bug: [4], file: "idgen/generator.go", lines: [...head,
      L("\tif now < g.last {", "+"), L(`\t\tlog.Printf("clock moved backwards by %dms, continuing", g.last-now)`, "+"), L("\t}", "+"),
      L("\tif now == g.last {"), L("\t\tg.seq = (g.seq + 1) & seqMask"), L("\t\tif g.seq == 0 {"), L("\t\t\tfor now <= g.last { now = time.Now().UnixMilli() - epoch }"), L("\t\t}"), L("\t} else {"), L("\t\tg.seq = 0"), L("\t}"), L("\tg.last = now"), L(`\treturn now<<${I.tsShift} | g.worker<<${I.wShift} | g.seq`)] };
    return { bug: [2], file: "idgen/main.go", lines: [L("@@ func main() @@", "@"), L("\thost := os.Getenv(\"HOSTNAME\") // pod name, e.g. ids-7d9f8c6b5-x2kqp"),
      L(`\tworker := int64(crc32.ChecksumIEEE([]byte(host)) % ${2 ** I.wbits})`, "+"),
      L("\tgen := idgen.New(worker)", "+"), L("\tsrv := grpcServer(gen)"), L("\tsrv.Serve(lis)"),
      L("@@ func (g *Generator) Next() int64 @@", "@"), L("\tnow := time.Now().UnixMilli() - epoch"), L("\tif now < g.last {"), L("\t\treturn 0, ErrClockMovedBackwards // caller retries after a short sleep"), L("\t}"), L("\tif now == g.last {"), L("\t\tg.seq = (g.seq + 1) & seqMask"), L("\t\tif g.seq == 0 { now = g.waitNextMilli(g.last) }"), L("\t} else {"), L("\t\tg.seq = 0"), L("\t}")] };
  }

  /* ---------- LWW multi-region (scenario 33) ---------- */
  function lwwModel(I) {
    const skew = { e: 0, u: I.skew || 0 };
    const reg = (r) => (r === "e" ? I.east : I.eu);
    const init = { k: 0, e: { val: I.init, ts: -1e9, w: "init", seen: [] }, u: { val: I.init, ts: -1e9, w: "init", seen: [] }, writes: {}, reads: {} };
    const tick = (s) => (s.k += 100);
    const write = (r, id, val) => (s) => { tick(s); const cur = s[r]; const v = typeof val === "function" ? val(s, r) : val; const ts = s.k + skew[r]; s.writes[id] = { val: v, seen: [...cur.seen, cur.w].filter((x) => x !== "init") }; s[r] = { val: v, ts, w: id, seen: s.writes[id].seen }; return `${reg(r)} stores ${fmtV(v)} @ ts ${ts}`; };
    const ship = (from, to) => (s) => { tick(s); const a = s[from], b = s[to]; if (a.w === b.w) return "already in sync"; if (a.ts > b.ts) { s[to] = { ...a, seen: [...new Set([...a.seen, ...b.seen, b.w].filter((x) => x !== "init" && x !== a.w))] }; return `${reg(to)} takes ${fmtV(a.val)} (newer ts)`; } s[to] = { ...b, seen: [...new Set([...b.seen, ...a.seen, a.w].filter((x) => x !== "init" && x !== b.w))] }; return `${reg(to)} keeps ${fmtV(b.val)} (incoming ts ${a.ts} is older)`; };
    const fmtV = (v) => (Array.isArray(v) ? "[" + v.join(", ") + "]" : `"${v}"`);
    const final = (s) => { const w = s.e.ts >= s.u.ts ? s.e : s.u; return w; };
    let lanes, broken, verdict, solve, bad;
    if (I.lv === 1) {
      lanes = [
        { name: `${I.east} (customer)`, steps: [`set address = "${I.a}"`], ops: [write("e", "A", I.a)] },
        { name: `${I.eu} (support agent)`, steps: [`set address = "${I.b}"`], ops: [write("u", "B", I.b)] },
        { name: `${I.east} → ${I.eu}`, steps: ["replicate"], ops: [ship("e", "u")] },
        { name: `${I.eu} → ${I.east}`, steps: ["replicate"], ops: [ship("u", "e")] },
      ];
      broken = (s) => { const f = final(s); return ["A", "B"].some((id) => s.writes[id] && f.w !== id && !s.writes[f.w].seen.includes(id)); };
      verdict = (s) => { const f = final(s); return `both regions converge on ${fmtV(f.val)}; ${["A", "B"].filter((id) => f.w !== id && !(s.writes[f.w] && s.writes[f.w].seen.includes(id))).map((id) => (id === "A" ? "the customer's" : "the agent's") + " write was dropped without anyone seeing it").join("") || "every overwritten write had been seen first"}`; };
      solve = [0, 1, 2, 3]; bad = [[0, 2, 1, 3], [1, 3, 0, 2]];
    } else if (I.lv === 2) {
      lanes = [
        { name: `${I.east} (customer)`, steps: [`set address = "${I.a}"`], ops: [write("e", "A", I.a)] },
        { name: `${I.east} → ${I.eu}`, steps: ["replicate"], ops: [ship("e", "u")] },
        { name: `${I.eu} (support agent, clock ${I.skew} ms)`, steps: ["open the ticket and read the address", `correct it to "${I.b}"`], ops: [(s) => { tick(s); s.reads.agent = s.u.val; return `agent sees ${fmtV(s.u.val)}`; }, write("u", "B", I.b)] },
        { name: `${I.eu} → ${I.east}`, steps: ["replicate"], ops: [ship("u", "e")] },
      ];
      broken = (s) => { const f = final(s); return !!(s.writes.B && s.writes.B.seen.includes("A") && f.w === "A"); };
      verdict = (s) => { const f = final(s); return `final address ${fmtV(f.val)}${s.writes.B && s.writes.B.seen.includes("A") && f.w === "A" ? ": the agent's correction, made after seeing the customer's value, lost to an older write" : ""}`; };
      solve = [0, 1, 2, 2, 3]; bad = [[2, 2, 0, 1, 3], [0, 2, 2, 1, 3]];
    } else {
      const add = (item) => (s, r) => [...new Set([...s[r].val, item])].sort();
      lanes = [
        { name: `${I.east} (phone)`, steps: ["read cart", `write cart + ${I.a}`], ops: [(s) => { tick(s); return "reads " + fmtV(s.e.val); }, write("e", "A", add(I.a))] },
        { name: `${I.eu} (laptop)`, steps: ["read cart", `write cart + ${I.b}`], ops: [(s) => { tick(s); return "reads " + fmtV(s.u.val); }, write("u", "B", add(I.b))] },
        { name: `${I.east} → ${I.eu}`, steps: ["replicate"], ops: [ship("e", "u")] },
        { name: `${I.eu} → ${I.east}`, steps: ["replicate"], ops: [ship("u", "e")] },
      ];
      broken = (s) => { const f = final(s); return !(f.val.includes(I.a) && f.val.includes(I.b)); };
      verdict = (s) => { const f = final(s); return `both regions converge on ${fmtV(f.val)}${broken(s) ? ": an added item vanished" : ""}`; };
      solve = [0, 0, 1, 1, 2, 3]; bad = [[0, 0, 2, 1, 1, 3], [1, 1, 3, 0, 0, 2]];
    }
    return { init: I.lv === 3 ? { ...init, e: { ...init.e, val: [I.init] }, u: { ...init.u, val: [I.init] } } : init, lanes, broken, verdict, solve, bad };
  }

  /* ---------- hedged requests (scenario 34) ---------- */
  const hedgeCache = new Map();
  function hedgeSamples(I) {
    const key = I.seed;
    if (hedgeCache.has(key)) return hedgeCache.get(key);
    const R = rng(I.seed), N = I.fan > 1 ? 3000 : 20000, M = N * I.fan;
    const heavy = [], a = [], b = [];
    for (let i = 0; i < M; i++) {
      const hv = I.heavy && R.next() < I.heavy ? I.heavyMs : 0;
      const one = () => K.logn(R, I.med, 0.35) + (R.next() < I.q ? K.exp(R, I.hic) : 0) + hv;
      heavy.push(hv); a.push(one()); b.push(one());
    }
    const single = a.slice().sort((x, y) => x - y);
    const pct = (p) => single[Math.min(single.length - 1, Math.floor(p * single.length))];
    const out = { N, a, b, pct };
    hedgeCache.set(key, out);
    return out;
  }
  function hedgeEval(I, cfg) {
    const S = hedgeSamples(I);
    const d = cfg.at === "off" ? Infinity : S.pct(+cfg.at / 100);
    const lat = [];
    let hedges = 0, extra = 0;
    for (let r = 0; r < S.N; r++) {
      let mx = 0;
      for (let j = 0; j < I.fan; j++) {
        const i = r * I.fan + j, x = S.a[i];
        let l = x;
        if (x > d) { hedges++; const y = d + S.b[i]; l = Math.min(x, y); extra += cfg.cancel === "yes" ? (l - d) / S.b[i] : 1; }
        if (l > mx) mx = l;
      }
      lat.push(mx);
    }
    const p99 = K.quantile(lat, 0.99), load = extra / (S.N * I.fan);
    return { p99, load, hedges, d, errs: load > I.budget ? [`hedges add ${K.pct(load, 1)} load (budget ${K.pct(I.budget, 0)})`] : [] };
  }

  /* ---------- gossip (scenario 35) ---------- */
  function gossipRounds(I) {
    const R = rng(I.seed), runs = 12, res = [];
    for (let k = 0; k < runs; k++) {
      const inf = new Uint8Array(I.n); inf[0] = 1; let cnt = 1, rounds = 0;
      while (cnt < I.n && rounds < 200) {
        rounds++;
        const add = [];
        for (let i = 0; i < I.n; i++) {
          if (inf[i]) { for (let f = 0; f < I.f; f++) { if (I.loss && R.next() < I.loss) continue; add.push(Math.floor(R.next() * I.n)); } }
          else if (I.pull) { for (let f = 0; f < I.f; f++) { const j = Math.floor(R.next() * I.n); if (inf[j] && !(I.loss && R.next() < I.loss)) { add.push(i); break; } } }
        }
        add.forEach((j) => { if (!inf[j]) { inf[j] = 1; cnt++; } });
      }
      res.push(rounds);
    }
    return K.mean(res);
  }

  /* ---------- quorum availability topology (scenario 37) ---------- */
  function quorumTopo(I, a) {
    const down = new Set(a.down || []), cut = new Set(a.cut || []);
    const adj = I.nodes.map(() => []);
    I.links.forEach(([x, y], i) => { if (cut.has(i) || down.has(x) || down.has(y)) return; adj[x].push(y); adj[y].push(x); });
    const comp = I.nodes.map(() => -1); let c = 0;
    I.nodes.forEach((_, s) => { if (comp[s] >= 0 || down.has(s)) return; const st = [s]; comp[s] = c; while (st.length) { const u = st.pop(); adj[u].forEach((v) => { if (comp[v] < 0) { comp[v] = c; st.push(v); } }); } c++; });
    const voters = I.nodes.map((n, i) => (n.voter ? i : -1)).filter((i) => i >= 0);
    const n = voters.length, need = maj(n);
    const sizes = {};
    voters.forEach((v) => { if (!down.has(v)) sizes[comp[v]] = (sizes[comp[v]] || 0) + 1; });
    const best = Math.max(0, ...Object.values(sizes));
    return { best, need, ok: best >= need, groups: Object.values(sizes).sort((x, y) => y - x) };
  }

  /* ---------- split brain (scenario 38) ---------- */
  function splitBrain(I, cut) {
    const cs = new Set(cut || []);
    const link = (a, b) => I.links.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
    const up = (a, b) => { const i = link(a, b); return i >= 0 && !cs.has(i); };
    const P = 0, S = 1, W = I.witness ? 2 : -1, apps = I.apps;
    const sPromotes = !up(S, P) && (W < 0 || (up(S, W) && !up(W, P)));
    const pStays = I.lv < 3 ? true : up(P, S) || (W >= 0 && up(P, W)) || apps.some((x) => up(P, x));
    const pWrites = pStays && apps.some((x) => up(x, P));
    const sWrites = sPromotes && apps.some((x) => up(x, S));
    return { sPromotes, pStays, pWrites, sWrites, split: pWrites && sWrites };
  }

  /* ---------- etcd shell (scenario 39) ---------- */
  function etcdShell(I) {
    const hex = (k) => I.ids[k];
    const members = I.names.map((n, k) => ({ id: hex(k), name: n, ip: I.ips[k], up: !(I.lv === 1 && k === I.dead) && !(I.lv === 3 && k !== I.alive), started: true }));
    const quorum = (st) => st.members.filter((m) => m.up && m.started).length >= maj(st.members.length);
    const sh = K.shell([
      { re: /^etcdctl member list(?: -w table| --write-out=table)?$/, use: "etcdctl member list -w table", desc: "cluster membership", run: (m, st) => {
        if (!quorum(st)) return "{\"level\":\"warn\",\"msg\":\"retrying of unary invoker failed\",\"error\":\"rpc error: code = DeadlineExceeded desc = context deadline exceeded\"}\nError: context deadline exceeded";
        return K.cols([["ID", "STATUS", "NAME", "PEER ADDRS", "CLIENT ADDRS", "IS LEARNER"], ...st.members.map((x) => [x.id, x.started ? "started" : "unstarted", x.started ? x.name : "", `https://${x.ip}:2380`, x.started ? `https://${x.ip}:2379` : "", "false"])]);
      } },
      { re: /^etcdctl endpoint health(?: --cluster)?$/, use: "etcdctl endpoint health", desc: "health of each endpoint", run: (m, st) => st.members.map((x) => (x.up && x.started && quorum(st) ? `https://${x.ip}:2379 is healthy: successfully committed proposal: took = ${(1.6 + (x.ip.length % 5) / 3).toFixed(6)}ms` : `https://${x.ip}:2379 is unhealthy: failed to commit proposal: context deadline exceeded`)).join("\n") + (st.members.some((x) => !(x.up && x.started && quorum(st))) ? "\nError: unhealthy cluster" : "") },
      { re: /^etcdctl endpoint status(?: --cluster)?(?: -w (table|json)| --write-out=(table|json))?$/, use: "etcdctl endpoint status -w table|json", desc: "db size, leader, raft term, revision", run: (m, st) => {
        const live = st.members.filter((x) => x.up && x.started);
        if ((m[1] || m[2]) === "json") return JSON.stringify(live.map((x) => ({ Endpoint: `https://${x.ip}:2379`, Status: { header: { member_id: x.id, revision: st.rev, raft_term: I.term }, version: "3.5.16", dbSize: Math.round(st.db * 1024 ** 3), dbSizeInUse: Math.round(st.inuse * 1024 ** 3), leader: live[0].id, raftIndex: I.idx, raftTerm: I.term, errors: st.alarm ? ["memberID:" + x.id + " alarm:NOSPACE "] : [] } })));
        return K.cols([["ENDPOINT", "ID", "VERSION", "DB SIZE", "IS LEADER", "IS LEARNER", "RAFT TERM", "RAFT INDEX", "ERRORS"], ...live.map((x, k) => [`https://${x.ip}:2379`, x.id, "3.5.16", `${K.num(st.db, 1)} GB`, quorum(st) && k === 0 ? "true" : "false", "false", String(I.term), String(I.idx), st.alarm ? "memberID:" + x.id + " alarm:NOSPACE" : ""])]) + (st.members.length > live.length ? `\n{"level":"warn","msg":"failed to get the status of endpoint","endpoint":"https://${st.members.find((x) => !x.up).ip}:2379","error":"context deadline exceeded"}` : "");
      } },
      { re: /^etcdctl alarm list$/, use: "etcdctl alarm list", desc: "", run: (m, st) => (st.alarm ? st.members.map((x) => `memberID:${parseInt(x.id.slice(0, 8), 16)} alarm:NOSPACE`).join("\n") : "") },
      { re: /^etcdctl alarm disarm$/, use: "etcdctl alarm disarm", desc: "clear alarms", run: (m, st) => { if (!st.alarm) return ""; if (st.db > I.quota) { return { out: "memberID:… alarm:NOSPACE\n(the database is still over its quota; the alarm is raised again on the next write)" }; } st.alarm = false; return st.members.map((x) => `memberID:${parseInt(x.id.slice(0, 8), 16)} alarm:NOSPACE`).join("\n"); } },
      { re: /^etcdctl compact (\d+)(?: --physical)?$/, use: "etcdctl compact <revision>", desc: "drop history older than a revision", run: (m, st) => { const r = +m[1]; if (r > st.rev) return `Error: etcdserver: mvcc: required revision is a future revision`; if (r <= st.compacted) return "Error: etcdserver: mvcc: required revision has been compacted"; st.compacted = r; st.inuse = I.live + (st.rev - r) * 0.00002; return `compacted revision ${r}`; } },
      { re: /^etcdctl defrag(?: --cluster)?$/, use: "etcdctl defrag --cluster", desc: "release free pages to the filesystem", run: (m, st) => { st.db = Math.min(st.db, st.inuse); return st.members.filter((x) => x.up).map((x) => `Finished defragmenting etcd member[https://${x.ip}:2379]`).join("\n"); } },
      { re: /^etcdctl del --prefix (\S+)$/, use: "etcdctl del --prefix <key>", desc: "delete keys", run: (m, st) => { if (st.alarm) return { out: "Error: etcdserver: mvcc: database space exceeded", danger: "Deleting live data is the wrong lever: deletes write new revisions, and space only returns after compaction and defrag." }; return { out: "48211", danger: "You deleted live data from the cluster." }; } },
      { re: /^etcdctl member remove ([0-9a-f]+)$/, use: "etcdctl member remove <id>", desc: "remove a member", run: (m, st) => {
        if (!quorum(st)) return "Error: context deadline exceeded";
        const x = st.members.find((y) => y.id === m[1]); if (!x) return `Error: etcdserver: member not found`;
        st.members = st.members.filter((y) => y !== x);
        return { out: `Member ${x.id} removed from cluster ${I.cluster}`, danger: x.up ? `${x.name} was healthy: you just reduced the cluster's fault tolerance.` : null };
      } },
      { re: /^etcdctl member add (\S+) --peer-urls=https:\/\/([\d.]+):2380$/, use: "etcdctl member add <name> --peer-urls=https://<ip>:2380", desc: "add a member (start it afterwards)", run: (m, st) => {
        if (!quorum(st)) return "Error: context deadline exceeded";
        const deadIn = st.members.some((x) => !x.up);
        st.members.push({ id: I.newId, name: m[1], ip: m[2], up: true, started: false });
        return { out: `Member ${I.newId} added to cluster ${I.cluster}\n\nETCD_NAME="${m[1]}"\nETCD_INITIAL_CLUSTER="${st.members.map((x) => `${x.name}=https://${x.ip}:2380`).join(",")}"\nETCD_INITIAL_ADVERTISE_PEER_URLS="https://${m[2]}:2380"\nETCD_INITIAL_CLUSTER_STATE="existing"`, danger: deadIn ? `With the dead member still listed the cluster now has ${st.members.length} members and needs ${maj(st.members.length)} for quorum, while only ${st.members.filter((x) => x.up && x.started).length} are running. Remove the dead member first.` : null };
      } },
      { re: /^ssh (\S+) sudo systemctl (start|restart|stop) etcd$/, use: "ssh <host> sudo systemctl start|stop etcd", desc: "", run: (m, st) => {
        const x = st.members.find((y) => y.name === m[1] || y.ip === m[1]);
        if (!x) return `ssh: Could not resolve hostname ${m[1]}`;
        if (m[2] === "stop") { x.started = false; return quorum(st) || I.lv === 3 ? "" : { out: "", danger: "Stopping that member cost the cluster its quorum." }; }
        if (!x.up && I.lv !== 3) return `ssh: connect to host ${x.ip} port 22: No route to host`;
        if (I.lv === 3 && x.name !== I.names[I.alive]) return `ssh: connect to host ${x.ip} port 22: No route to host`;
        x.started = true;
        if (I.lv === 3 && st.flag && !st.forced) { if (!st.snap) return { out: "", danger: "You forced a new cluster without a fresh snapshot to fall back on." }; st.forced = true; st.members = st.members.filter((y) => y === x); }
        if (I.lv === 3 && st.forced && st.flag && st.restartsWithFlag++ > 0) return { out: "", danger: "Restarting with ETCD_FORCE_NEW_CLUSTER still set rewrites membership again on every start; remove it once the cluster is up." };
        return "";
      } },
      { re: /^etcdctl snapshot save (\S+)$/, use: "etcdctl snapshot save <file>", desc: "save a backup from the endpoint", run: (m, st) => { st.snap = true; return `{"level":"info","msg":"fetched snapshot","endpoint":"https://${I.ips[I.alive != null ? I.alive : 0]}:2379","size":"${K.num(I.live || 1.2, 1)} GB"}\nSnapshot saved at ${m[1]}`; } },
      { re: /^ssh (\S+) "?echo ETCD_FORCE_NEW_CLUSTER=true \| sudo tee -a \/etc\/etcd\/etcd\.env"?$/, use: `ssh <host> "echo ETCD_FORCE_NEW_CLUSTER=true | sudo tee -a /etc/etcd/etcd.env"`, desc: "set --force-new-cluster for the next start", run: (m, st) => { st.flag = true; return "ETCD_FORCE_NEW_CLUSTER=true"; } },
      { re: /^ssh (\S+) "?sudo sed -i '\/ETCD_FORCE_NEW_CLUSTER\/d' \/etc\/etcd\/etcd\.env"?$/, use: `ssh <host> "sudo sed -i '/ETCD_FORCE_NEW_CLUSTER/d' /etc/etcd/etcd.env"`, desc: "remove the flag again", run: (m, st) => { st.flag = false; return ""; } },
      { re: /^ssh (\S+) sudo rm -rf \/var\/lib\/etcd\S*$/, use: "ssh <host> sudo rm -rf /var/lib/etcd", desc: "", hidden: true, run: (m, st) => { st.wiped = true; return { out: "", danger: "You deleted the only surviving copy of the data." }; } },
    ], { sh: "bash" });
    return {
      prompt: "ops@bastion:~$", run: (line, st) => sh.run(line, st), par: I.lv === 3 ? 8 : 6,
      init: { members, rev: I.rev, compacted: I.rev - 2000000, db: I.lv === 2 ? I.quota + 0.01 : 1.1, inuse: I.lv === 2 ? I.quota + 0.01 : 1.1, alarm: I.lv === 2, snap: false, flag: false, forced: false, restartsWithFlag: 0, wiped: false },
      motd: I.lv === 1 ? `ALERT etcd member ${I.names[I.dead]} (${I.ips[I.dead]}) unreachable for 2h: disk failed, host replaced by ${I.newName} (${I.newIp}).\nETCDCTL_ENDPOINTS set to all members.` : I.lv === 2 ? "ALERT kube-apiserver: etcdserver: mvcc: database space exceeded. Writes failing cluster-wide.\nETCDCTL_ENDPOINTS set to all members." : `ALERT etcd: ${I.names.filter((_, k) => k !== I.alive).join(" and ")} lost with their disks (AZ incident). Only ${I.names[I.alive]} (${I.ips[I.alive]}) survives.\nETCDCTL_ENDPOINTS=https://${I.ips[I.alive]}:2379`,
      cmds: I.lv === 1 ? ["etcdctl member list -w table", "etcdctl endpoint health", "etcdctl member remove <id>", `etcdctl member add ${I.newName} --peer-urls=https://${I.newIp}:2380`, `ssh ${I.newName} sudo systemctl start etcd`]
        : I.lv === 2 ? ["etcdctl endpoint status -w table", "etcdctl alarm list", "etcdctl endpoint status -w json", "etcdctl compact <revision>", "etcdctl defrag --cluster", "etcdctl alarm disarm"]
          : ["etcdctl member list -w table", "etcdctl endpoint status -w table", "etcdctl snapshot save /backup/etcd-pre-recovery.db", `ssh ${I.names[I.alive]} sudo systemctl stop etcd`, `ssh ${I.names[I.alive]} "echo ETCD_FORCE_NEW_CLUSTER=true | sudo tee -a /etc/etcd/etcd.env"`, `ssh ${I.names[I.alive]} sudo systemctl start etcd`, `ssh ${I.names[I.alive]} "sudo sed -i '/ETCD_FORCE_NEW_CLUSTER/d' /etc/etcd/etcd.env"`],
    };
  }

  LB.addAll("dist", [
    /* 31 */ {
      id: "dist-snowflake-layout",
      name: "Lay out the 64-bit ID",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "tune",
      vname: "a lifetime of",
      gen(lv, R) {
        return { lv, life: lv === 1 ? 40 : lv === 2 ? 100 : 60, workers: lv === 1 ? R.pick([200, 500]) : lv === 2 ? R.pick([1000, 3000]) : R.pick([20000, 30000]), rate: lv === 1 ? R.pick([20000, 50000]) : lv === 2 ? R.pick([200000, 400000]) : R.pick([40000, 60000]), svc: R.pick(["order ids", "event ids", "message ids"]) };
      },
      text: (I) => `<p>You're designing Snowflake-style ${esc(I.svc)}: a 64-bit signed integer = 1 sign bit (0) + timestamp since a custom epoch + worker id + per-worker sequence. Requirements: ids last <b>${I.life} years</b> from the epoch, support <b>${K.num(I.workers)} concurrent worker ids</b>${I.lv === 3 ? " (Kubernetes pods lease an id at start; ids are not reused until the lease expires, so churn multiplies the count)" : ""}, and <b>${K.num(I.rate)} ids/s per worker</b> at peak. Maximise lifetime.</p>`,
      ui: (I) => ({ knobs: [
        { k: "ts", label: "Timestamp bits", min: 36, max: 42, step: 1 },
        { k: "worker", label: "Worker-id bits", min: 5, max: 16, step: 1 },
        { k: "unit", label: "Timestamp unit", opts: ["1ms", "10ms"] },
      ], init: { ts: 41, worker: 10 }, live: (cfg) => { const r = flakeEval(I, cfg); return K.metrics([
        { name: "Sequence bits", value: String(r.seq), ok: r.seq >= 1 },
        { name: "Lifetime", value: `${K.num(r.life, 1)} years`, ok: r.life >= I.life, target: `≥ ${I.life}` },
        { name: "Worker ids", value: K.num(r.workers), ok: r.workers >= I.workers, target: `≥ ${K.num(I.workers)}` },
        { name: "Ids/s per worker", value: K.num(r.rate), ok: r.rate >= I.rate, target: `≥ ${K.num(I.rate)}` },
      ]); } }),
      valid: (I, cfg) => { const r = flakeEval(I, cfg); return r.errs.length ? r.errs[0] : true; },
      val: (I, cfg) => Math.round(flakeEval(I, cfg).life * 10),
      vfmt: (v) => `${K.num(v / 10, 1)} years`,
      hint: (I) => I.lv === 1 ? "41 bits of milliseconds is about 69.7 years. Each bit doubles it." : I.lv === 2 ? "A coarser timestamp unit trades lifetime against sequence space per tick." : "Worker bits come first: 2^bits must cover every id that can be leased at once.",
      concept: "Snowflake ID bit budgets",
      how: "A Snowflake id packs a timestamp, a worker id and a sequence into 63 usable bits, so every bit you give one field halves another's range. Timestamp bits × unit set the lifetime from the custom epoch (41 bits of ms ≈ 69.7 years). Worker bits cap how many generators can run at once without coordination, including ids held by recently dead pods. Sequence bits cap ids per tick per worker; when they run out, the generator must wait for the next tick. Ids sort roughly by time, which keeps B-tree inserts append-mostly.",
      rule: "Size worker bits from peak concurrent generators (with churn), sequence bits from peak rate per tick, and give the rest to the timestamp; check the lifetime against the epoch you pick.",
      why: (I, sol) => { const r = flakeEval(I, sol); return `${sol.ts} timestamp bits at ${sol.unit}, ${sol.worker} worker bits, ${r.seq} sequence bits: ${K.num(r.life, 1)} years, ${K.num(r.workers)} workers, ${K.num(r.rate)} ids/s each.`; },
    },
    /* 32 */ {
      id: "dist-snowflake-review",
      name: "Review the ID generator",
      kind: "Code review",
      skills: ["diagnose"],
      w: "lines",
      gen(lv, R) { const wbits = R.pick([10, 12]); return { lv, wbits, wShift: 12, tsShift: 12 + wbits }; },
      text: (I) => I.lv === 1 ? `<p>A teammate wrote this Snowflake generator. During a load test at 2M ids/s on one worker, the database reported duplicate primary keys. Flag the line responsible.</p>`
        : I.lv === 2 ? `<p>The generator now waits for the next millisecond when the sequence wraps. After a VM live-migration, chrony stepped the clock back 300 ms and duplicate ids appeared again. Flag the line responsible.</p>`
          : `<p>The service now refuses to issue ids while the clock is behind. It runs as a Deployment of 300 pods with ${I.wbits}-bit worker ids, and duplicates still appear about once a week. Flag the line responsible.</p>`,
      ui: (I) => { const c = flakeCode(I); return { lines: c.lines, file: c.file, k: 1 }; },
      ans: (I) => flakeCode(I).bug,
      diag: (I) => I.lv === 1 ? "Not that one. What happens on the 4097th id within the same millisecond?" : I.lv === 2 ? "Not that one. What does the code do after noticing the clock went backwards?" : "Not that one. How likely is it that two of 300 pods get the same worker id?",
      hint: (I) => I.lv === 1 ? "When the sequence wraps to 0 in the same millisecond, the next id equals the first one of that millisecond." : I.lv === 2 ? "Logging isn't handling." : "Birthday problem: 300 values hashed into a small space.",
      concept: "Snowflake failure modes",
      how: "A Snowflake generator is unique only if three things hold: the sequence never wraps within one tick (on overflow it must wait for the next tick), the timestamp never goes backwards for a given worker (on a backwards step it must wait or refuse, never reuse old timestamps), and no two live generators share a worker id. Wall clocks do step backwards (NTP/chrony corrections, VM migration, leap-second smearing differences). Worker ids derived by hashing hostnames collide by the birthday paradox: 300 pods in 1,024 ids collide with near certainty. Lease worker ids from a coordinator (etcd/ZooKeeper/a database row) instead.",
      rule: "Wait on sequence overflow, refuse or wait on clock regression, and assign worker ids by lease, not by hash.",
      why: (I) => I.lv === 1 ? "At 2M ids/s a millisecond needs more than 4,096 ids; the sequence wraps to 0 and repeats ids already issued in that millisecond." : I.lv === 2 ? "When the clock stepped back 300 ms, the generator kept going and reissued timestamps (and sequences) it had already used." : `With 300 pods hashed into ${K.num(2 ** I.wbits)} worker ids, the chance that some pair collides is ${K.pct(1 - Math.exp((-300 * 299) / (2 * 2 ** I.wbits)), 0)}; colliding pods issue identical ids whenever they hit the same millisecond and sequence.`,
    },
    /* 33 */ {
      id: "dist-lww-data-loss",
      name: "Lose a write to last-writer-wins",
      kind: "Experiment",
      skills: ["diagnose", "design"],
      gen(lv, R) {
        const [east, eu] = R.pick([["us-east-1", "eu-west-1"], ["us-west-2", "eu-central-1"], ["us-east-2", "ap-south-1"]]);
        if (lv === 3) return { lv, east, eu, init: R.pick(["coffee", "tea"]), a: R.pick(["mug", "filter"]), b: R.pick(["grinder", "kettle"]), skew: 0 };
        return { lv, east, eu, init: "12 Old St", a: R.pick(["4 Elm Rd", "9 Oak Ave", "77 Pine Ln"]), b: R.pick(["4 Elm Road, Apt 2", "9 Oak Avenue #3", "77 Pine Lane, Unit 5"]), skew: lv === 2 ? -R.pick([300, 450, 600]) : 0 };
      },
      ...laneScenario(lwwModel),
      text: (I) => I.lv === 1 ? `<p>Customer profiles are active-active in ${esc(I.east)} and ${esc(I.eu)}, replicated asynchronously; conflicts resolve by <b>last writer wins</b> on a write timestamp. Steps happen 100 ms apart. Build a schedule where a write is <b>silently discarded</b> without the other writer ever having seen it.</p>`
        : I.lv === 2 ? `<p>Same setup, but ${esc(I.eu)}'s clock runs <b>${-I.skew} ms behind</b>. A support agent fixes the customer's address after reading it. Build a schedule where the agent's correction, made <b>after</b> seeing the customer's value, loses to it.</p>`
          : `<p>Shopping carts are stored as one document per user, active-active with last-writer-wins, clocks in sync. The same user adds items on two devices routed to different regions. Build a schedule where, after replication settles, <b>an added item is gone</b>.</p>`,
      hint: (I) => I.lv === 1 ? "Two writes that happen before either region hears about the other are concurrent; LWW picks one." : I.lv === 2 ? "Timestamps from a slow clock look older even when the write happened later." : "Each device writes back the whole cart it read.",
      concept: "Last-writer-wins loses data",
      how: "Active-active replication must resolve concurrent writes somehow; last-writer-wins keeps the version with the highest timestamp and discards the other, without telling anyone. That's fine only when losing a concurrent write is acceptable. Wall-clock skew makes it worse: a write that causally follows another (its author saw the earlier value) can still lose if its region's clock is behind. Whole-document LWW on collections (carts, sets) drops additions made concurrently. Alternatives: per-field merges, CRDTs (OR-Set for a cart), version vectors with siblings, or routing each record's writes to a single home region.",
      rule: "Use LWW only for data where dropping a concurrent update is acceptable; for collections use CRDTs, and for causally ordered edits use version vectors or a single writer region.",
      why: (I) => I.lv === 1 ? "Both writes were made before replication crossed; LWW kept the one with the higher timestamp and dropped the other with no conflict surfaced." : I.lv === 2 ? `The agent wrote after seeing the customer's value, but ${esc(I.eu)}'s clock is ${-I.skew} ms behind, so its timestamp was lower and LWW threw the correction away.` : "Each device read the cart before the other's write replicated and wrote back its own full copy; LWW kept one document and the other item vanished. An OR-Set merges both adds.",
    },
    /* 34 */ {
      id: "dist-hedged-requests",
      name: "Hedge the tail",
      kind: "Experiment",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "p99 of",
      gen(lv, R) {
        return { lv, seed: `hedge/${lv}/${R.int(1, 1e9)}`, fan: lv === 1 ? 1 : R.pick([20, 40]), med: R.pick([8, 10, 12]), q: R.pick([0.02, 0.03]), hic: R.pick([150, 200]), heavy: lv === 3 ? 0.012 : 0, heavyMs: 400, budget: 0.05, svc: R.pick(["search leaves", "the feature store", "the KV cache tier"]) };
      },
      text: (I) => `<p>Calls to ${esc(I.svc)} take ~${I.med} ms, but ${K.pct(I.q, 0)} hit a replica-side hiccup (GC, compaction) adding ~${I.hic} ms.${I.lv === 3 ? ` About ${K.pct(I.heavy, 1)} of requests are inherently expensive (huge keys) and take ~${I.heavyMs} ms on any replica.` : ""} ${I.fan > 1 ? `Each user request fans out to <b>${I.fan}</b> of them and waits for all.` : ""}</p><p>A hedged request sends a second copy to another replica if the first hasn't answered after a delay. Minimise the user-facing p99 while hedging adds at most <b>${K.pct(I.budget, 0)}</b> extra load. (Simulated on recorded latency samples.)</p>`,
      ui: (I) => ({ knobs: [
        { k: "at", label: "Hedge after the single-call", opts: ["off", "50", "90", "95", "98", "99"], fmt: (v) => (v === "off" ? "never" : "p" + v) },
        { k: "cancel", label: "Cancel the slower copy when one answers", opts: ["no", "yes"] },
      ], liveDelay: 200, live: (cfg) => { const r = hedgeEval(I, cfg), base = hedgeEval(I, { at: "off", cancel: "no" }); return K.metrics([
        { name: "Hedge delay", value: Number.isFinite(r.d) ? K.ms(r.d) : "–", ok: null },
        { name: "User p99", value: K.ms(r.p99), ok: null, target: `unhedged ${K.ms(base.p99)}` },
        { name: "Extra load", value: K.pct(r.load, 1), ok: r.load <= I.budget, target: `≤ ${K.pct(I.budget, 0)}` },
      ]); } }),
      valid: (I, cfg) => { const r = hedgeEval(I, cfg); return r.errs.length ? r.errs[0] : true; },
      val: (I, cfg) => Math.round(hedgeEval(I, cfg).p99 * 10),
      vfmt: (v) => K.ms(v / 10),
      hint: (I) => I.lv === 1 ? "Hedging after the p95 sends a second copy for about 5% of calls." : I.lv === 2 ? `With ${I.fan} calls per request, the user's p99 is set by roughly the p99.9+ of a single call.` : "A hedge to another replica can't help a request that is slow everywhere; cancelling losers recovers some budget.",
      concept: "Hedged requests and tail at scale",
      how: "When a request fans out to N servers and waits for all, its latency is the maximum of N samples, so rare per-server slowness becomes common: with 1% slow calls and 40 leaves, a third of user requests hit one. Hedging sends a backup request after a delay (typically the p90–p99 of normal latency) and takes whichever answers first, cutting tails caused by transient, server-specific hiccups for a few percent extra load. Cancelling the loser reduces the cost. Hedging does nothing for requests that are inherently slow everywhere, and it adds load, so it must be budgeted.",
      rule: "Hedge at a high percentile (p95-ish), cancel the loser, cap the extra load, and fix inherently slow requests separately.",
      why: (I, sol) => { const r = hedgeEval(I, sol), b = hedgeEval(I, { at: "off", cancel: "no" }); return `Hedging at ${sol.at === "off" ? "never" : "p" + sol.at}${sol.cancel === "yes" ? " with cancellation" : ""}: p99 ${K.ms(b.p99)} → ${K.ms(r.p99)} for ${K.pct(r.load, 1)} extra load.`; },
    },
    /* 35 */ {
      id: "dist-gossip-rounds",
      name: "How long until everyone knows?",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) { const I = { lv, seed: `gossip/${lv}/${R.int(1, 1e9)}`, n: lv === 1 ? R.pick([500, 1000, 2000]) : lv === 2 ? R.pick([2000, 5000]) : R.pick([4000, 8000]), f: lv === 1 ? 1 : lv === 2 ? 3 : 1, pull: lv === 3, loss: lv === 3 ? 0.2 : 0 }; I.truth = K.round(gossipRounds(I), 1); return I; },
      text: (I) => `<p>A membership change starts at one node of a <b>${K.num(I.n)}-node</b> cluster and spreads by gossip. Every round, each node that knows it ${I.pull ? "pushes it to 1 random peer, and each node that doesn't know it pulls from 1 random peer" : `sends it to <b>${I.f}</b> random peer${I.f > 1 ? "s" : ""}`}${I.loss ? `; <b>${K.pct(I.loss, 0)}</b> of messages are lost` : ""}. About how many rounds until <b>every</b> node knows?</p>`,
      ui: () => ({ unit: "rounds" }),
      accept: LB.near((I) => I.truth, 0.25),
      solve: (I) => I.truth,
      bad: (I) => [Math.round(Math.log2(I.n) / 3), I.n / 10].filter((x) => Math.abs(x - I.truth) > I.truth * 0.25),
      hint: (I) => I.pull ? "Push spreads fast early; pull finishes fast late (each uninformed node finds an informed one with high probability once most know). Loss slows both a little." : "Push gossip: about log_(1+f) N rounds to reach most nodes, plus about ln N / f more to reach the last stragglers.",
      concept: "Epidemic (gossip) dissemination",
      how: "In push gossip each informed node contacts f random peers per round. Early on the informed set grows by a factor of about (1 + f) per round, so reaching most nodes takes about log_(1+f) N rounds; the last few uninformed nodes are found only by chance, which adds about ln N / f rounds. Push-pull also lets uninformed nodes ask, which finishes the tail quickly (the uninformed fraction squares each round), so total time is around log₂ N + ln ln N. Message loss slows spreading proportionally but rarely stops it, which is why gossip is used for membership, failure detection and anti-entropy (SWIM, Cassandra, Consul/Serf).",
      rule: "Gossip convergence grows with log N: budget a few dozen rounds for thousands of nodes, and use push-pull or anti-entropy to catch the stragglers.",
      why: (I) => `Simulating it gives about ${K.num(I.truth, 1)} rounds. log2(${K.num(I.n)}) ≈ ${K.num(Math.log2(I.n), 1)}${I.pull ? "; pull finishes the tail in a couple of rounds" : `, and the straggler tail adds about ln N / f ≈ ${K.num(Math.log(I.n) / I.f, 1)}`}.`,
    },
    /* 36 */ {
      id: "dist-cap-choices",
      name: "Consistency or availability?",
      kind: "Decision",
      skills: ["design", "comms"],
      w: "classify",
      gen(lv, R) {
        const bank = {
          1: [["Claiming a unique username at sign-up", 0], ["Showing the like count on a post", 1], ["Moving money between two customer accounts", 0], ["Showing a user's recently viewed items", 1], ["Issuing a lock that guarantees one leader runs the nightly billing job", 0], ["Adding an item to a shopping cart", 1], ["Rendering the product catalog page", 1], ["Assigning the last seat on a flight", 0]],
          2: [["Selling 50,000 concert tickets from 3 regions, each region given a quota it can sell offline", 2], ["Rate limiting API calls to ~1,000/min per tenant across 4 regions (a few % over is fine)", 2], ["Changing a password so the old one stops working everywhere", 0], ["Posting a comment", 1], ["Debiting a prepaid balance that must never go negative", 0], ["Spending from a per-region slice of a marketing budget", 2], ["Updating a user's avatar", 1], ["Reserving a unique invoice number for a legal document", 0]],
          3: [["Revoking a compromised API key", 0], ["Shopping cart quantities during a region partition", 1], ["Selling limited-edition sneakers (500 pairs) across regions during a partition", 2], ["Showing a delivery ETA computed from the courier's last GPS ping", 1], ["Committing a schema migration to the shared config store", 0], ["Charging a card for an order when the payment service in one region is cut off", 0], ["Allowing up to 3 concurrent streams per subscription across regions", 2], ["Personalised recommendations", 1]],
        };
        const cats = lv === 1 ? ["Refuse during a partition (CP)", "Keep serving, reconcile later (AP)"] : ["Refuse during a partition (CP)", "Keep serving, reconcile later (AP)", "Keep serving within pre-allocated limits (escrow / bounded)"];
        return { lv, cats, items: R.sample(bank[lv], 6) };
      },
      text: (I) => `<p>Your platform runs in several regions. When the network partitions a region from the others, each feature must either <b>refuse</b> operations it can't do safely, or <b>keep serving</b> and reconcile afterwards${I.lv > 1 ? ", or keep serving only within limits allocated to each region in advance" : ""}. For each feature, choose what the product actually needs.</p>`,
      ui: (I) => ({ items: I.items.map((x) => x[0]), cats: I.cats }),
      ans: (I) => I.items.map((x) => x[1]),
      diag: () => "Not quite. Ask what goes wrong if two partitioned regions both accept the operation, and whether you can repair it afterwards (merge, apologise, refund) or not.",
      hint: (I) => I.lv === 1 ? "If two sides both say yes, can you fix it later? Two users with the same username can't both keep it." : "Escrow fits invariants on quantities (stock, budgets, quotas) where each region can safely spend its own share without asking.",
      concept: "CAP choices per feature",
      how: "During a partition a replicated system must either reject some operations (stay consistent) or accept them on both sides (stay available) and reconcile later. The choice is per operation, not per database: uniqueness, money movement and security revocations break if both sides say yes, while likes, carts and caches can merge afterwards. For quantity invariants there's a middle path: split the total into per-region allowances (escrow) so each side can keep serving within its share without coordination. PACELC adds that even without partitions, strong consistency costs latency.",
      rule: "Decide per operation: if two sides saying yes is irreparable, coordinate (and accept unavailability); if it can be merged or apologised for, stay available; for quantities, pre-allocate.",
      why: (I) => `${I.items.map((x) => `${esc(x[0].split(",")[0].split("(")[0].trim())} → ${["CP", "AP", "escrow"][x[1]]}`).join("; ")}.`,
    },
    /* 37 */ {
      id: "dist-quorum-loss-drill",
      name: "Find the weakest point",
      kind: "Design review",
      skills: ["design", "diagnose"],
      w: "topo",
      sense: "min",
      vname: "failures:",
      gen(lv, R) {
        const azs = R.pick([["a", "b", "c"], ["1a", "1b", "1c"]]);
        const layout = lv === 1 ? [1, 1, 1] : lv === 2 ? [3, 2] : [2, 2];
        const nodes = [], links = [];
        const W = 640, cols = layout.length;
        layout.forEach((cnt, z) => {
          const x = Math.round((W / cols) * (z + 0.5));
          const sw = nodes.length;
          nodes.push({ label: `AZ ${azs[z]} switch`, x, y: 50, cls: "muted" });
          for (let k = 0; k < cnt; k++) { const idx = nodes.length; nodes.push({ label: `etcd-${idx}`, sub: `AZ ${azs[z]}`, x: x + (k - (cnt - 1) / 2) * 120, y: 200 + (k % 2) * 60, voter: true }); links.push([sw, idx]); }
        });
        const sws = nodes.map((n, i) => (n.voter ? -1 : i)).filter((i) => i >= 0);
        for (let i = 0; i < sws.length; i++) for (let j = i + 1; j < sws.length; j++) links.push([sws[i], sws[j], "inter-AZ"]);
        nodes.forEach((n, i) => { if (n.voter) n.label = `etcd-${nodes.slice(0, i + 1).filter((x) => x.voter).length}`; });
        return { lv, nodes, links, azs, sys: R.pick(["etcd", "the Raft-based metadata store", "the Consul servers"]) };
      },
      text: (I) => `<p>Before a game day, you're checking ${esc(I.sys)}: ${I.nodes.filter((n) => n.voter).length} voting members placed as shown. Fail <b>nodes</b> (members or AZ switches) and cut <b>links</b> to find the <b>smallest set of failures</b> that leaves no group of connected members with a quorum, i.e. the cluster can't commit writes.</p>`,
      ui: (I) => ({ nodes: I.nodes.map((n) => ({ label: n.label, sub: n.sub, x: n.x, y: n.y, cls: n.cls })), links: I.links, mode: "both", H: 300, live: (a) => { const r = quorumTopo(I, a || {}); return K.metrics([{ name: "Largest connected group", value: `${r.best} member${r.best === 1 ? "" : "s"}`, ok: null }, { name: "Quorum", value: String(r.need), ok: null }, { name: "Writes", value: r.ok ? "still available" : "unavailable", ok: r.ok ? null : true }]); } }),
      valid: (I, a) => (quorumTopo(I, a).ok ? "a connected majority still exists" : true),
      val: (I, a) => (a.down || []).length + (a.cut || []).length,
      bad: () => [{ down: [], cut: [] }],
      hint: (I) => I.lv === 1 ? "With one member per AZ, how many members must be lost or isolated?" : I.lv === 2 ? "A whole AZ can disappear in one event. How many members are in the biggest one?" : "Count members on each side of the only inter-AZ link.",
      concept: "Quorum loss and failure domains",
      how: "A consensus cluster stays writable while some connected group holds a majority of all voting members. The useful question in a design review is the smallest set of correlated failures (an AZ switch, a link, a node) that removes every majority. With members spread one per zone over three zones, it takes two independent failures. Putting a majority in one zone makes that zone a single point of failure; an even split across two zones means one link cut leaves two halves with no majority and no way to break the tie. A third site, even a small witness or tie-breaker, fixes both.",
      rule: "Spread voters over at least three failure domains with no domain holding half or more of them, and test the 'one domain down' case explicitly.",
      why: (I, sol) => `${sol.down.length + sol.cut.length} failure${sol.down.length + sol.cut.length === 1 ? "" : "s"} suffice${sol.down.length + sol.cut.length === 1 ? "s" : ""}: ${[...sol.down.map((i) => "lose " + I.nodes[i].label), ...sol.cut.map((i) => "cut " + I.nodes[I.links[i][0]].label.replace(" switch", "") + "–" + I.nodes[I.links[i][1]].label.replace(" switch", ""))].join(", ")}. ${I.lv === 1 ? "One member per AZ needs two independent failures." : I.lv === 2 ? "Three of five members in one AZ: losing that AZ removes the majority." : "Two AZs with two members each: cutting the link leaves 2 + 2, and neither half has 3."}`,
    },
    /* 38 */ {
      id: "dist-split-brain",
      name: "Cause a split brain",
      kind: "Experiment",
      skills: ["diagnose", "safe"],
      w: "topo",
      sense: "min",
      vname: "links cut:",
      gen(lv, R) {
        const db = R.pick(["pg-1", "db-a", "mysql-1"]), sb = R.pick(["pg-2", "db-b", "mysql-2"]);
        const nodes = [{ label: db, sub: "primary", x: 140, y: 150 }, { label: sb, sub: "standby", x: 500, y: 150 }];
        const links = [[0, 1, "heartbeat"]];
        if (lv > 1) { nodes.push({ label: "witness", sub: "arbiter", x: 320, y: 40 }); links.push([0, 2], [1, 2]); }
        const a1 = nodes.length; nodes.push({ label: "app-1", x: 220, y: 265 }); const a2 = nodes.length; nodes.push({ label: "app-2", x: 420, y: 265 });
        links.push([a1, 0], [a1, 1], [a2, 0], [a2, 1]);
        return { lv, nodes, links, witness: lv > 1, apps: [a1, a2] };
      },
      text: (I) => `<p>A primary/standby database pair with automatic failover. ${I.lv === 1 ? "The standby promotes itself when it misses the primary's heartbeats." : I.lv === 2 ? "The standby promotes only if it can't reach the primary <b>and</b> the witness confirms it can't reach the primary either. The old primary keeps accepting writes until someone stops it." : "The standby promotes as in the witness setup. To avoid split brain, the primary now demotes itself when it's isolated; the code treats it as isolated only if it can reach <b>none</b> of: the standby, the witness, or any app server."}</p>
        <p>As a chaos experiment, cut the <b>fewest links</b> so that <b>both</b> nodes accept writes from app servers at the same time.</p>`,
      ui: (I) => ({ nodes: I.nodes.map((n) => ({ label: n.label, sub: n.sub, x: n.x, y: n.y })), links: I.links, mode: "links", H: 300, live: (a) => { const r = splitBrain(I, a && a.cut); return K.metrics([{ name: `${esc(I.nodes[0].label)}`, value: r.pStays ? (r.pWrites ? "primary, taking writes" : "primary, no clients") : "demoted", ok: null }, { name: `${esc(I.nodes[1].label)}`, value: r.sPromotes ? (r.sWrites ? "promoted, taking writes" : "promoted, no clients") : "standby", ok: null }, { name: "Split brain", value: r.split ? "yes: two primaries" : "no", ok: r.split ? true : null }]); } }),
      valid: (I, a) => (splitBrain(I, a.cut).split ? true : "only one node is accepting writes"),
      val: (I, a) => (a.cut || []).length,
      bad: () => [{ down: [], cut: [] }],
      hint: (I) => I.lv === 1 ? "What does the standby conclude when only the heartbeat link fails?" : I.lv === 2 ? "The witness must lose the primary too, while the standby still reaches the witness." : "Which of the primary's 'can I still see someone?' checks is not a vote at all?",
      concept: "Split brain and fencing the old primary",
      how: "Failover based on 'I can't see the primary' confuses a dead primary with a network partition; if the standby promotes while the old primary is alive and reachable by clients, both accept writes and the histories diverge. A witness (arbiter) helps the standby decide, but safety also requires the old primary to stop: it must step down when it loses contact with a quorum of the failover group (standby + witness), or be fenced (STONITH, revoking its storage or network access, or fencing tokens). Clients are not quorum members: being able to reach app servers says nothing about whether a new primary exists.",
      rule: "Promote only with a quorum's agreement, make the old primary step down when it loses that quorum (or fence it), and never count clients as votes.",
      why: (I, sol) => `Cutting ${sol.cut.map((i) => `${I.nodes[I.links[i][0]].label}–${I.nodes[I.links[i][1]].label}`).join(" and ")} makes the standby promote while the old primary still serves an app. ${I.lv === 3 ? "The primary stayed up because it could still reach app servers, which aren't part of the quorum." : I.lv === 2 ? "Nothing told the old primary to stop." : "A single heartbeat link was the only evidence of the primary's death."}`,
    },
    /* 39 */ {
      id: "dist-etcd-recovery",
      name: "Nurse the etcd cluster",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      ...LB.term({
        shell: (I) => etcdShell(I),
        goal(st, I) {
          if (st.wiped) return "The data directory is gone.";
          const healthy = st.members.filter((m) => m.up && m.started).length;
          if (I.lv === 1) {
            if (st.members.some((m) => !m.up)) return `The dead member ${I.names[I.dead]} is still in the member list, so quorum still counts it.`;
            if (!st.members.some((m) => m.ip === I.newIp)) return "The replacement member hasn't been added.";
            if (!st.members.find((m) => m.ip === I.newIp).started) return "The new member is added but not started.";
            return healthy >= 3 ? true : "Fewer than 3 healthy members.";
          }
          if (I.lv === 2) { if (st.alarm) return "The NOSPACE alarm is still active, so writes still fail."; return true; }
          if (!st.forced) return "The cluster still has no quorum; nothing can be written.";
          if (st.flag) return "ETCD_FORCE_NEW_CLUSTER is still set: the next restart would rewrite membership again.";
          return st.members.some((m) => m.started) ? true : "etcd isn't running on the survivor.";
        },
        solve: (I) => I.lv === 1 ? { log: ["etcdctl member list -w table", `etcdctl member remove ${I.ids[I.dead]}`, `etcdctl member add ${I.newName} --peer-urls=https://${I.newIp}:2380`, `ssh ${I.newName} sudo systemctl start etcd`] }
          : I.lv === 2 ? { log: ["etcdctl alarm list", "etcdctl endpoint status -w json", `etcdctl compact ${I.rev}`, "etcdctl defrag --cluster", "etcdctl alarm disarm"] }
            : { log: ["etcdctl member list -w table", "etcdctl snapshot save /backup/etcd-pre-recovery.db", `ssh ${I.names[I.alive]} sudo systemctl stop etcd`, `ssh ${I.names[I.alive]} "echo ETCD_FORCE_NEW_CLUSTER=true | sudo tee -a /etc/etcd/etcd.env"`, `ssh ${I.names[I.alive]} sudo systemctl start etcd`, `ssh ${I.names[I.alive]} "sudo sed -i '/ETCD_FORCE_NEW_CLUSTER/d' /etc/etcd/etcd.env"`] },
      }),
      gen(lv, R) {
        const base = R.pick(["10.0.1.", "10.20.4.", "172.16.8."]), ips = R.distinct(4, 10, 99).map((x) => base + x);
        const ids = U.range(4).map(() => R.str(16, "0123456789abcdef"));
        const names = ["etcd-1", "etcd-2", "etcd-3"];
        return { lv, ips: ips.slice(0, 3), ids: ids.slice(0, 3), newId: ids[3], names, newName: "etcd-4", newIp: ips[3], dead: R.int(0, 2), alive: R.int(0, 2), cluster: R.str(16, "0123456789abcdef"), rev: R.int(4000000, 9000000), term: R.int(4, 40), idx: R.int(1e6, 9e6), quota: 2, live: K.round(R.int(6, 12) / 10, 1) };
      },
      bad: (I) => I.lv === 1 ? [{ log: [`etcdctl member add ${I.newName} --peer-urls=https://${I.newIp}:2380`, `ssh ${I.newName} sudo systemctl start etcd`] }, { log: [`etcdctl member remove ${I.ids[(I.dead + 1) % 3]}`] }]
        : I.lv === 2 ? [{ log: ["etcdctl alarm disarm"] }, { log: ["etcdctl defrag --cluster", "etcdctl alarm disarm"] }]
          : [{ log: [`ssh ${I.names[I.alive]} "echo ETCD_FORCE_NEW_CLUSTER=true | sudo tee -a /etc/etcd/etcd.env"`, `ssh ${I.names[I.alive]} sudo systemctl restart etcd`, `ssh ${I.names[I.alive]} "sudo sed -i '/ETCD_FORCE_NEW_CLUSTER/d' /etc/etcd/etcd.env"`] }, { log: ["etcdctl snapshot save /backup/x.db", `ssh ${I.names[I.alive]} "echo ETCD_FORCE_NEW_CLUSTER=true | sudo tee -a /etc/etcd/etcd.env"`, `ssh ${I.names[I.alive]} sudo systemctl restart etcd`] }],
      text: (I) => `<p>You're on the bastion with <code>etcdctl</code> 3.5 for the control-plane etcd (3 members). Read the alert above the prompt and restore a healthy, writable cluster without making things worse. Type <code>help</code> for what this sandbox understands.</p>`,
      hint: (I) => I.lv === 1 ? "Which order keeps the quorum requirement satisfiable at every step: remove, then add, or add, then remove?" : I.lv === 2 ? "Space is reclaimed in three steps: drop old revisions, return free pages to the filesystem, then clear the alarm." : "Without quorum, membership can't be changed normally. The survivor can be forced into a new one-member cluster; take a backup first and don't leave the flag behind.",
      concept: "Operating a Raft cluster: membership, space and quorum loss",
      how: "Membership changes are themselves Raft writes and need a quorum. To replace a dead member, remove it first (quorum is then computed over the remaining members), then add the replacement and start it with initial-cluster-state=existing; adding first raises the quorum size while a member is still dead. etcd's backend keeps every revision until compaction; when the database hits its quota it raises a NOSPACE alarm and rejects writes: compact old revisions, defragment to give pages back to the filesystem, then disarm the alarm. If a majority is permanently lost, the survivor's data can be turned into a new single-member cluster (--force-new-cluster, or restoring a snapshot), after which the flag must be removed and new members added one by one.",
      rule: "Remove before you add, compact + defrag + disarm for NOSPACE, and for quorum loss take a snapshot, force a new cluster from the best survivor once, then rebuild membership.",
      why: (I) => I.lv === 1 ? `Removing ${I.names[I.dead]} first left a healthy 2-member cluster (quorum 2); adding ${I.newName} then needed 2 of 3, which the running members had.` : I.lv === 2 ? `The backend had reached its ${I.quota} GB quota. Compaction marked old revisions free, defrag returned the space, and only then could the alarm stay cleared.` : `${I.names[I.alive]} alone can't form a quorum of 3. A snapshot protects against a botched recovery; forcing a new cluster makes it a 1-member cluster with all its data, and removing the flag prevents it from being re-applied on the next restart.`,
    },
    /* 40 */ {
      id: "dist-retry-amplification",
      name: "Count the retry amplification",
      kind: "Estimate",
      skills: ["estimate", "diagnose"],
      w: "num",
      gen(lv, R) {
        const layers = lv === 1 ? [["mobile app", R.pick([2, 3])], ["API gateway", R.pick([2, 3])], ["orders service", R.pick([2, 3])]]
          : [["web client", R.pick([1, 2])], ["edge proxy", R.pick([1, 2])], ["BFF", R.pick([2, 3])], [lv === 3 ? "orders service's DB client (per query)" : "orders service", R.pick([2, 3])]];
        const q = lv === 3 ? R.pick([2, 3]) : 1;
        return { lv, layers, q, rps: R.pick([200, 500, 800]) };
      },
      text: (I) => `<p>The database behind the orders service is down; every call to it fails after its timeout. Each layer retries a failed downstream call this many times (attempts = retries + 1):</p>${K.table(["layer", "retries on failure"], I.layers.map(([n, r]) => [esc(n), String(r)]), { compact: true })}${I.lv === 3 ? `<p>Each orders-service request runs <b>${I.q}</b> database queries in sequence (it keeps going after a failed one to fill in partial data), and its DB client retries each query as shown in the last row.</p>` : ""}<p>At <b>${I.rps}</b> user requests/s, how many ${I.lv === 3 ? "database queries" : "calls to the orders service"} per second hit the failing tier${I.lv === 1 ? " (count attempts at the deepest layer listed)" : ""}?</p>`,
      ui: () => ({ unit: "per second" }),
      accept: LB.near((I) => ampTruth(I), 0.1),
      solve: (I) => ampTruth(I),
      bad: (I) => [I.rps * K.sum(I.layers.map(([, r]) => r + 1)), I.rps * (I.layers[I.layers.length - 1][1] + 1)],
      hint: () => "Attempts multiply through the layers: each attempt from above triggers a full set of attempts below.",
      concept: "Retry amplification across layers",
      how: "When every layer of a call chain retries independently, attempts multiply: three layers that each try 3 times turn one user request into 27 calls at the bottom, exactly when the bottom is failing. This is how small outages become retry storms. The standard fix is to retry at one layer only (usually closest to the failure or at the edge), use retry budgets and backoff everywhere else, and propagate deadlines so inner layers stop once the caller has given up.",
      rule: "Retry at a single layer; everywhere else fail fast, and cap total retries with a budget.",
      why: (I) => `Attempts multiply: ${I.layers.map(([, r]) => r + 1).join(" × ")}${I.lv === 3 ? ` × ${I.q} queries` : ""} = ${K.num(ampTruth(I) / I.rps)} per user request, so ${K.num(ampTruth(I))}/s hit the failing tier, against ${I.rps}/s of real demand.`,
    },
  ]);
  function ampTruth(I) { return I.rps * I.layers.reduce((p, [, r]) => p * (r + 1), 1) * I.q; }
})();
