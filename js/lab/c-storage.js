/* Systems Lab · Storage internals: B-trees vs LSM trees, amplification, fsync and durability, devices, RAID and SSDs. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;
  const f1 = (x) => K.num(x, 1), f2 = (x) => K.num(x, 2);

  /* ---------- B-tree vs LSM engine model ---------- */
  const ENG = { bt: "B-tree (in-place 16 KB pages)", lev: "LSM tree, leveled compaction", tier: "LSM tree, size-tiered compaction" };
  const ENG_PROFILE = {
    bt: { wa: "16 KB page per random insert (≈ row size if keys arrive in order) + WAL", pt: "1", seeks: "0 (leaves are contiguous)", sa: "1.47 random / 1.11 sequential" },
    lev: { wa: "15× row size (WAL + flush + compactions)", pt: "1.05", seeks: "8", sa: "1.12" },
    tier: { wa: "6× row size", pt: "1.3", seeks: "24", sa: "2.0 (free space for the largest merge)" },
  };
  function engModel(I, e) {
    const page = 16384, r = I.row;
    if (e === "bt") {
      const fill = I.seq ? 0.9 : 0.68;
      const wB = (I.seq ? r : page) + r;
      return { wMB: (I.W * wB) / 1e6, iops: I.P + I.S * (1 + Math.ceil((I.N * r) / (page * fill))), disk: I.data / fill };
    }
    const lev = e === "lev";
    return { wMB: (I.W * r * (lev ? 15 : 6)) / 1e6, iops: I.P * (lev ? 1.05 : 1.3) + I.S * ((lev ? 8 : 24) + (I.N * r) / page), disk: I.data * (lev ? 1.12 : 2.0) };
  }
  const engOk = (I, e) => { const m = engModel(I, e); return m.wMB <= I.wcap && m.iops <= I.iopsCap && m.disk <= I.disk; };

  /* ---------- crash-consistency simulator for file replacement ---------- */
  // Files live in inodes {dur, cache}; directories have a durable map plus pending (not yet fsynced) entry changes.
  // A crash keeps any subset of each directory's pending changes and, for each un-fsynced inode, the old bytes, the new bytes or a torn mix.
  const FS_OPS = {
    create: { t: "Create <code>config.json.tmp</code> in <code>/etc/app/</code> and write the new bytes", run: (S) => { const id = S.mk(""); S.ino[id].cache = "new"; S.pend("app", { "config.json.tmp": id }); } },
    odirect: { t: "Create <code>config.json.tmp</code> in <code>/etc/app/</code> and write the new bytes with <code>O_DIRECT</code>", run: (S) => { const id = S.mk(""); S.ino[id].cache = "new"; S.pend("app", { "config.json.tmp": id }); } },
    fsyncTmp: { t: "<code>fsync(tmp_fd)</code>", run: (S) => { const id = S.view("app")["config.json.tmp"]; if (!id) return "tmp_fd isn't open yet"; S.ino[id].dur = S.ino[id].cache; } },
    sfr: { t: "<code>sync_file_range(tmp_fd, 0, 0, SYNC_FILE_RANGE_WRITE)</code>", run: (S) => { if (!S.view("app")["config.json.tmp"]) return "tmp_fd isn't open yet"; } },
    rename: { t: "<code>rename(\"config.json.tmp\", \"config.json\")</code>", run: (S) => { const id = S.view("app")["config.json.tmp"]; if (!id) return "rename: ENOENT (no config.json.tmp)"; S.pend("app", { "config.json": id, "config.json.tmp": null }); } },
    fsyncDir: { t: "<code>fsync()</code> a descriptor opened on the directory <code>/etc/app/</code>", run: (S) => { S.syncDir("app"); } },
    inplace: { t: "Open <code>config.json</code> with <code>O_TRUNC</code> and write the new bytes in place", run: (S) => { const id = S.view("app")["config.json"]; S.ino[id].cache = "new"; S.ino[id].trunc = true; } },
    unlink: { t: "<code>unlink(\"config.json\")</code> so the name is free for the rename", run: (S) => { S.pend("app", { "config.json": null }); } },
    tmpfs: { t: "Create <code>/tmp/config.json.new</code> (tmpfs) and write the new bytes", run: (S) => { S.tmpfs = true; } },
    renameTmpfs: { t: "<code>rename(\"/tmp/config.json.new\", \"/etc/app/config.json\")</code>", run: (S) => (S.tmpfs ? "rename: EXDEV (Invalid cross-device link): /tmp is a different filesystem" : "rename: ENOENT") },
    fsyncAfter: { t: "After the rename, open <code>config.json</code> and <code>fsync()</code> it", run: (S) => { const id = S.view("app")["config.json"]; if (id) S.ino[id].dur = S.ino[id].cache; } },
    // Staff: SST + CURRENT pointer
    sstCreate: { t: "Create <code>db/sst/000042.sst</code> and write the new table", run: (S) => { const id = S.mk(""); S.ino[id].cache = "T42"; S.pend("sst", { "000042.sst": id }); } },
    sstFsync: { t: "<code>fsync()</code> 000042.sst", run: (S) => { const id = S.view("sst")["000042.sst"]; if (!id) return "000042.sst doesn't exist yet"; S.ino[id].dur = S.ino[id].cache; } },
    sstDir: { t: "<code>fsync()</code> the directory <code>db/sst/</code>", run: (S) => { S.syncDir("sst"); } },
    sfrSst: { t: "<code>sync_file_range()</code> on 000042.sst with <code>SYNC_FILE_RANGE_WRITE</code>", run: (S) => { if (!S.view("sst")["000042.sst"]) return "000042.sst doesn't exist yet"; } },
    curTmp: { t: "Create <code>db/CURRENT.tmp</code> and write <code>000042</code>", run: (S) => { const id = S.mk(""); S.ino[id].cache = "000042"; S.pend("db", { "CURRENT.tmp": id }); } },
    curFsync: { t: "<code>fsync()</code> CURRENT.tmp", run: (S) => { const id = S.view("db")["CURRENT.tmp"]; if (!id) return "CURRENT.tmp doesn't exist yet"; S.ino[id].dur = S.ino[id].cache; } },
    curRename: { t: "<code>rename(\"db/CURRENT.tmp\", \"db/CURRENT\")</code>", run: (S) => { const id = S.view("db")["CURRENT.tmp"]; if (!id) return "rename: ENOENT (no CURRENT.tmp)"; S.pend("db", { CURRENT: id, "CURRENT.tmp": null }); } },
    dbDir: { t: "<code>fsync()</code> the directory <code>db/</code>", run: (S) => { S.syncDir("db"); } },
    curInplace: { t: "Open <code>db/CURRENT</code> with <code>O_TRUNC</code> and write <code>000042</code> in place", run: (S) => { const id = S.view("db").CURRENT; S.ino[id].cache = "000042"; S.ino[id].trunc = true; } },
    dropOld: { t: "<code>unlink(\"db/sst/000041.sst\")</code>, the table the new one replaces", run: (S) => { S.pend("sst", { "000041.sst": null }); } },
  };
  function fsInit(staff) {
    const S = { ino: {}, dirs: {}, n: 0, tmpfs: false };
    S.mk = (c) => { const id = "i" + ++S.n; S.ino[id] = { dur: c, cache: c }; return id; };
    S.view = (d) => { const v = { ...S.dirs[d].dur }; S.dirs[d].pend.forEach((p) => Object.entries(p).forEach(([k, x]) => (x == null ? delete v[k] : (v[k] = x)))); return v; };
    S.pend = (d, p) => S.dirs[d].pend.push(p);
    S.syncDir = (d) => { S.dirs[d].dur = S.view(d); S.dirs[d].pend = []; };
    if (!staff) { const a = S.mk("old"); S.dirs.app = { dur: { "config.json": a }, pend: [] }; }
    else { const c = S.mk("000041"), t = S.mk("T41"); S.dirs.db = { dur: { CURRENT: c }, pend: [] }; S.dirs.sst = { dur: { "000041.sst": t }, pend: [] }; }
    return S;
  }
  // every possible post-crash world: subsets of pending dir changes × per-inode data outcome
  function fsWorlds(S) {
    const dirs = Object.keys(S.dirs), out = [];
    const dirOpts = dirs.map((d) => { const p = S.dirs[d].pend, res = []; for (let m = 0; m < 1 << p.length; m++) { const v = { ...S.dirs[d].dur }; p.forEach((x, i) => { if (m >> i & 1) Object.entries(x).forEach(([k, y]) => (y == null ? delete v[k] : (v[k] = y))); }); res.push(v); } return res; });
    const ids = Object.keys(S.ino);
    const inoOpts = ids.map((id) => { const o = S.ino[id]; return o.dur === o.cache && !o.trunc ? [o.dur] : o.dur === o.cache ? [o.dur] : [o.dur, o.cache, "TORN"]; });
    const rec = (i, acc) => { if (i === dirs.length) { recI(0, acc, {}); return; } dirOpts[i].forEach((v) => rec(i + 1, { ...acc, [dirs[i]]: v })); };
    const recI = (j, dv, iv) => { if (j === ids.length) { out.push({ dirs: dv, data: iv }); return; } inoOpts[j].forEach((c) => recI(j + 1, dv, { ...iv, [ids[j]]: c })); };
    rec(0, {});
    return out;
  }
  const fsRead = (w, d, name) => { const id = w.dirs[d][name]; return id ? w.data[id] : undefined; };
  function fsState(staff, w) {
    if (!staff) { const c = fsRead(w, "app", "config.json"); return c === "old" ? "old" : c === "new" ? "new" : c === undefined ? "config.json missing" : c === "" ? "empty config.json" : "half-written config.json"; }
    const c = fsRead(w, "db", "CURRENT");
    if (c === undefined) return "CURRENT missing";
    if (c !== "000041" && c !== "000042") return c === "" ? "empty CURRENT" : "half-written CURRENT";
    const t = fsRead(w, "sst", c + ".sst");
    if (t === undefined) return `CURRENT → ${c}.sst, which doesn't exist`;
    if (t !== (c === "000041" ? "T41" : "T42")) return `CURRENT → ${c}.sst, whose data is ${t === "" ? "empty" : "torn"}`;
    return c === "000041" ? "old" : "new";
  }
  function fsRun(I, seq) {
    const staff = I.lv === 3, S = fsInit(staff), crash = [];
    const at = () => { const outs = new Set(fsWorlds(S).map((w) => fsState(staff, w))); return [...outs]; };
    crash.push(at());
    for (const i of seq) {
      const err = FS_OPS[I.ops[i]].run(S);
      if (err) return { err, crash, step: i };
      crash.push(at());
    }
    const fin = fsState(staff, { dirs: Object.fromEntries(Object.keys(S.dirs).map((d) => [d, S.view(d)])), data: Object.fromEntries(Object.entries(S.ino).map(([k, v]) => [k, v.cache])) });
    return { crash, fin };
  }
  function fsJudge(I, seq) {
    const r = fsRun(I, seq || []);
    if (r.err) return { ok: false, msg: esc(r.err) };
    const bad = r.crash.findIndex((o) => o.some((x) => x !== "old" && x !== "new"));
    if (bad >= 0) return { ok: false, msg: `A crash ${bad === 0 ? "before the first step" : "after step " + bad} can leave <b>${esc(r.crash[bad].filter((x) => x !== "old" && x !== "new")[0])}</b>.` };
    if (r.fin !== "new") return { ok: false, msg: "When the plan finishes, the new version isn't in place." };
    if (I.lv > 1 && r.crash[r.crash.length - 1].some((x) => x !== "new")) return { ok: false, msg: "Atomic, but not durable: a power cut right after the function returns can still bring back the <b>old</b> version." };
    return { ok: true };
  }
  function fsLive(I, seq) {
    const r = fsRun(I, seq || []);
    const rows = r.crash.map((o, k) => [k === 0 ? "before step 1" : "after step " + k, o.map((x) => (x === "old" || x === "new" ? `<span class="${x === "new" ? "win" : "muted"}">${x}</span>` : `<b class="lose">${esc(x)}</b>`)).join(" · ")]);
    let h = K.table(["Power cut…", "Possible state after reboot"], rows, { compact: true });
    if (r.err) h += K.verdict(false, esc(r.err));
    else if (seq && seq.length) { const j = fsJudge(I, seq); h += K.verdict(j.ok, j.ok ? "Every crash point recovers to the old or the new version" + (I.lv > 1 ? ", and the change is durable once the plan returns." : ".") : j.msg); }
    return h;
  }

  /* ---------- Postgres-on-NVMe durability shell ---------- */
  function durShell(I) {
    const dev = I.dev;
    const log = I.lv === 1
      ? `2026-10-11 03:12:40.118 UTC [812] LOG:  database system was interrupted; last known up at 2026-10-11 03:04:11 UTC\n2026-10-11 03:12:40.402 UTC [812] LOG:  database system was not properly shut down; automatic recovery in progress\n2026-10-11 03:12:40.511 UTC [812] LOG:  redo starts at 3A/1F000028\n2026-10-11 03:12:41.903 UTC [812] LOG:  invalid record length at 3A/2C61B2E8: expected at least 24, got 0\n2026-10-11 03:12:41.903 UTC [812] LOG:  redo done at 3A/2C61B2B0\n2026-10-11 03:31:07.220 UTC [1450] ERROR:  could not read block 1182 in file "base/16384/16521": read only 0 of 8192 bytes`
      : I.lv === 2
        ? `2026-10-11 03:12:40.402 UTC [812] LOG:  database system was not properly shut down; automatic recovery in progress\n2026-10-11 03:12:40.511 UTC [812] LOG:  redo starts at 3A/1F000028\n2026-10-11 03:12:40.977 UTC [812] LOG:  invalid record length at 3A/1F9A3C10: expected at least 24, got 0\n2026-10-11 03:12:40.977 UTC [812] LOG:  redo done at 3A/1F9A3BD8\n2026-10-11 03:12:41.010 UTC [812] LOG:  database system is ready to accept connections\n# app team: ${I.lost} orders acknowledged to customers between 03:03:52 and 03:04:11 are missing`
        : `2026-10-11 03:12:41.010 UTC [812] LOG:  database system is ready to accept connections\n2026-10-11 03:40:12.551 UTC [2204] WARNING:  page verification failed, calculated checksum ${I.ck1} but expected ${I.ck2}\n2026-10-11 03:40:12.551 UTC [2204] ERROR:  invalid page in block ${I.blk} of relation base/16384/24576\n2026-10-11 03:41:30.006 UTC [2213] WARNING:  page verification failed, calculated checksum ${I.ck2 - 911} but expected ${I.ck1 + 77}\n2026-10-11 03:41:30.006 UTC [2213] ERROR:  invalid page in block ${I.blk + 3} of relation base/16384/24576`;
    const settingsTable = (st) => K.cols([["name", "setting", "source"], ["--------------------", "-------", "--------------------"], ["data_checksums", "on", "default"], ["fsync", st.pg.fsync, st.pg.fsync === "off" ? "configuration file" : "default"], ["full_page_writes", st.pg.full_page_writes, st.pg.full_page_writes === "off" ? "configuration file" : "default"], ["synchronous_commit", "on", "default"], ["wal_sync_method", "fdatasync", "default"]]) + "\n(5 rows)";
    const sh = K.shell([
      { re: /^psql -c "?show (\w+);?"?$/i, use: 'psql -c "SHOW <setting>"', desc: "show one Postgres setting", run: (m, st) => { const k = m[1].toLowerCase(); const v = st.pg[k] != null ? st.pg[k] : { synchronous_commit: "on", wal_sync_method: "fdatasync", data_checksums: "on", shared_buffers: "32GB" }[k]; return v == null ? `ERROR:  unrecognized configuration parameter "${k}"` : ` ${k}\n${"-".repeat(k.length + 2)}\n ${v}\n(1 row)`; } },
      { re: /^psql -c "?select .*from pg_settings.*"?$/i, use: 'psql -c "SELECT name, setting, source FROM pg_settings WHERE ..."', desc: "durability-related settings", run: (m, st) => settingsTable(st) },
      { re: /^psql -c "?select .*from pg_roles.*"?$/i, use: 'psql -c "SELECT rolname, rolconfig FROM pg_roles WHERE rolconfig IS NOT NULL"', desc: "per-role setting overrides", run: () => ` rolname   | rolconfig\n-----------+-------------------------------\n analytics | {synchronous_commit=off,work_mem=256MB}\n(1 row)` },
      { re: /^psql -c "?alter system (?:set (\w+) ?(?:=|to) ?'?(\w+)'?|reset (\w+));?"?$/i, use: "psql -c \"ALTER SYSTEM SET <setting> = '<value>'\"", desc: "write postgresql.auto.conf (needs a reload)", run: (m, st) => { const k = (m[1] || m[3]).toLowerCase(), v = m[3] ? "on" : m[2].toLowerCase(); if (!["fsync", "full_page_writes", "synchronous_commit", "wal_sync_method"].includes(k)) return "ALTER SYSTEM"; st.pending[k] = v; return "ALTER SYSTEM"; } },
      { re: /^psql -c "?select pg_reload_conf\(\);?"?$/i, use: 'psql -c "SELECT pg_reload_conf()"', desc: "reload configuration", run: (m, st) => { Object.assign(st.pg, st.pending); st.pending = {}; return " pg_reload_conf\n----------------\n t\n(1 row)"; } },
      { re: /^(?:tail|cat|less)(?: -n ?\d+)? \/var\/log\/postgresql\/\S+$/, use: "tail /var/log/postgresql/postgresql-16-main.log", desc: "server log", run: () => log },
      { re: /^cat \/var\/lib\/postgresql\/16\/main\/postgresql\.auto\.conf$/, use: "cat /var/lib/postgresql/16/main/postgresql.auto.conf", desc: "ALTER SYSTEM overrides", run: (m, st) => `# Do not edit this file manually!\n# It will be overwritten by the ALTER SYSTEM command.\nmax_wal_size = '16GB'\n${st.pg.fsync === "off" ? "fsync = 'off'  # set during 2026-10-09 bulk import\n" : ""}${st.pg.full_page_writes === "off" ? "full_page_writes = 'off'  # safe: ZFS recordsize=8k (pgdata-2024 host)\n" : ""}` },
      { re: /^cat \/sys\/block\/(\w+)\/queue\/write_cache$/, use: `cat /sys/block/${dev}/queue/write_cache`, desc: "what the kernel thinks the device cache is", run: (m, st) => (m[1] === dev ? st.wc : `cat: /sys/block/${m[1]}/queue/write_cache: No such file or directory`) },
      { re: /^(?:sudo )?(?:echo "?'?write back'?"? > |echo "?'?write back'?"? \| (?:sudo )?tee )\/sys\/block\/(\w+)\/queue\/write_cache$/, use: `echo "write back" > /sys/block/${dev}/queue/write_cache`, desc: "tell the kernel to send cache flushes", run: (m, st) => { if (m[1] !== dev) return "No such file or directory"; st.wc = "write back"; return ""; } },
      { re: /^(?:sudo )?(?:echo "?'?write through'?"? > |echo "?'?write through'?"? \| (?:sudo )?tee )\/sys\/block\/(\w+)\/queue\/write_cache$/, use: `echo "write through" > /sys/block/${dev}/queue/write_cache`, desc: "tell the kernel the cache is non-volatile", run: (m, st) => { st.wc = "write through"; return { out: "", danger: "That tells the kernel to stop sending FLUSH commands to a device whose cache is volatile." }; } },
      { re: /^(?:sudo )?nvme get-feature \/dev\/(\w+)(?: -f (?:6|0x0?6))(?: -H)?$/, use: `nvme get-feature /dev/${dev} -f 6 -H`, desc: "Volatile Write Cache feature", run: () => `get-feature:0x06 (Volatile Write Cache), Current value:0x00000001\n\tVolatile Write Cache Enable (WCE): Enabled` },
      { re: /^(?:mount \| grep \S+|findmnt \S+|mount)$/, use: "findmnt /var/lib/postgresql", desc: "filesystem and mount options", run: () => `TARGET               SOURCE         FSTYPE OPTIONS\n/var/lib/postgresql  /dev/${dev}p1  ext4   rw,noatime,data=ordered` },
      { re: /^(?:ls|cat) \/etc\/udev\/rules\.d\/?\S*$/, use: "cat /etc/udev/rules.d/*", desc: "udev rules", run: (m, st) => (I.lv === 2 ? `# /etc/udev/rules.d/60-nvme-perf.rules  (from the 2025 "NVMe tuning" runbook)\nACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/write_cache}="write through"` : `# /etc/udev/rules.d/60-scheduler.rules\nACTION=="add|change", KERNEL=="nvme[0-9]n[0-9]", ATTR{queue/scheduler}="none"`) },
      { re: /^(?:sudo )?rm \/etc\/udev\/rules\.d\/60-nvme-perf\.rules$/, use: "rm /etc/udev/rules.d/60-nvme-perf.rules", desc: "delete the udev rule", run: (m, st) => { st.rule = false; return ""; } },
      { re: /^(?:sudo -u postgres )?pg_resetwal\b.*$/, use: "pg_resetwal -f <datadir>", desc: "reset the WAL", run: () => ({ out: "Write-ahead log reset", danger: "pg_resetwal throws away WAL and can silently corrupt the cluster; it's a last resort, not a fix for durability settings." }) },
      { re: /^psql -c "?set zero_damaged_pages.*"?$/i, use: 'psql -c "SET zero_damaged_pages = on"', desc: "zero pages that fail verification", run: () => ({ out: "SET", danger: "zero_damaged_pages silently destroys the rows on any damaged page it reads." }) },
    ]);
    return {
      prompt: "root@db-3:~#",
      motd: `INCIDENT: power loss in rack B4 at 03:04 UTC; db-3 came back at 03:12.\nPostgres 16 on /dev/${dev}p1 (ext4). Primary only, no replica yet.`,
      init: { pg: { fsync: I.lv === 1 ? "off" : "on", full_page_writes: I.lv === 3 ? "off" : "on" }, pending: {}, wc: I.lv === 2 ? "write through" : "write back", rule: I.lv === 2 },
      run: (line, st) => sh.run(line, st),
      cmds: ["tail /var/log/postgresql/postgresql-16-main.log", 'psql -c "SELECT name, setting, source FROM pg_settings WHERE name IN (\'fsync\',\'full_page_writes\',\'synchronous_commit\',\'wal_sync_method\',\'data_checksums\')"', 'psql -c "SELECT rolname, rolconfig FROM pg_roles WHERE rolconfig IS NOT NULL"', `cat /sys/block/${dev}/queue/write_cache`, `nvme get-feature /dev/${dev} -f 6 -H`, "findmnt /var/lib/postgresql", "cat /etc/udev/rules.d/*", "psql -c \"ALTER SYSTEM SET <setting> = '<value>'\"", 'psql -c "SELECT pg_reload_conf()"'],
      par: 7,
      opts: DUR_CAUSES, optq: "Root cause of the lost or damaged data",
    };
  }
  const DUR_CAUSES = ["fsync = off: Postgres never forced WAL or data to stable storage", "synchronous_commit = off for the analytics role", "The kernel was told the volatile device cache is write-through, so it never sent FLUSH commands", "full_page_writes = off on a filesystem that can tear 8 KB pages", "The ext4 data=ordered mount mode"];

  /* ---------- group commit model ---------- */
  function gcModel(I, cfg, lam) {
    const syncF = cfg.sync === "fdatasync" && cfg.prealloc === "yes" ? 0.55 : 1;
    const maxB = cfg.maxB || 1024;
    const f = (B) => I.f0 * syncF + (B * I.rec) / I.bw; // ms
    if (cfg.mode === "each") {
      const ff = f(1), rho = (lam * ff) / 1000;
      if (rho >= 0.95) return { B: 1, fl: ff, rho, p99: Infinity };
      return { B: 1, fl: ff, rho, p99: ff + 4.6 * (rho / (2 * (1 - rho))) * ff };
    }
    if (cfg.mode === "window") {
      const w = cfg.w, interval = Math.min(w, (maxB * 1000) / lam), B = Math.max(1, (lam * interval) / 1000), ff = f(B), rho = ff / interval;
      if (rho >= 0.95) return { B, fl: ff, rho, p99: Infinity };
      return { B, fl: ff, rho, p99: interval + ff + (rho > 0.7 ? (ff * rho) / (1 - rho) : 0) };
    }
    let B = 1;
    for (let k = 0; k < 40; k++) B = Math.min(maxB, Math.max(1, (lam * f(B)) / 1000));
    const ff = f(B), rho = (lam * ff) / (1000 * B);
    if (rho >= 0.98) return { B, fl: ff, rho, p99: Infinity };
    return { B, fl: ff, rho: Math.min(rho, 0.99), p99: 2.2 * ff };
  }
  const gcRates = (I) => (I.lv === 3 ? [["peak", I.lam], ["off-peak", I.lamLow]] : [["load", I.lam]]);
  function gcCheck(I, cfg) {
    for (const [nm, lam] of gcRates(I)) { const r = gcModel(I, cfg, lam); if (!Number.isFinite(r.p99)) return `at ${nm} (${K.num(lam)} commits/s) the log device can't keep up: the flush queue grows without bound`; if (r.p99 > I.target) return `p99 commit latency at ${nm} is ${f2(r.p99)} ms (target ${I.target} ms)`; }
    return true;
  }

  /* ---------- WAL code review sources ---------- */
  const WAL_SRC = {
    1: { file: "wal/append.go", k: 1, lines: [
      ["@", "@@ func (w *WAL) Append(rec []byte) error @@"],
      [" ", "func (w *WAL) Append(rec []byte) error {"],
      ["+", "    hdr := make([]byte, 8)"],
      ["+", "    binary.LittleEndian.PutUint32(hdr[0:4], uint32(len(rec)))"],
      ["+", "    crc := crc32.Checksum(hdr[0:4], castagnoli)"],
      ["+", "    binary.LittleEndian.PutUint32(hdr[4:8], crc)"],
      ["+", "    if _, err := w.f.Write(append(hdr, rec...)); err != nil {"],
      ["+", "        return err"],
      ["+", "    }"],
      ["+", "    return w.f.Sync()"],
      [" ", "}"],
    ], bugs: [4], why: "The CRC covers only the 4-byte length field. A torn or bit-flipped payload still passes verification on replay, so recovery happily applies garbage. The checksum must cover the length <i>and</i> the payload (and ideally the record's offset/LSN, so a stale record from a recycled segment can't masquerade as a new one)." },
    2: { file: "wal/recover.go", k: 2, lines: [
      ["@", "@@ func (w *WAL) Replay(apply func([]byte)) error @@"],
      [" ", "    off := int64(0)"],
      [" ", "    for {"],
      [" ", "        hdr := make([]byte, 8)"],
      [" ", "        if _, err := io.ReadFull(w.r, hdr); err == io.EOF {"],
      [" ", "            return nil"],
      [" ", "        }"],
      ["+", "        n := binary.LittleEndian.Uint32(hdr[0:4])"],
      ["+", "        rec := make([]byte, n)"],
      ["+", "        if _, err := io.ReadFull(w.r, rec); err != nil {"],
      ["+", "            return err"],
      ["+", "        }"],
      ["+", "        if crc32.Checksum(append(hdr[0:4:4], rec...), castagnoli) != binary.LittleEndian.Uint32(hdr[4:8]) {"],
      ["+", "            return fmt.Errorf(\"wal: corrupt record at offset %d\", off)"],
      ["+", "        }"],
      [" ", "        apply(rec)"],
      [" ", "        off += 8 + int64(n)"],
      [" ", "    }"],
    ], bugs: [8, 13], why: "The length comes from disk unchecked: a torn header can claim 3 GB and <code>make</code> allocates it (or the process OOMs) before the CRC is ever checked; bound it by the maximum record size and the bytes left in the file. And a CRC mismatch on the <i>last</i> record is the normal result of a power cut mid-append: that record was never acknowledged, so recovery must truncate the log there and start, not refuse to start. As written, every power loss turns into a crash loop." },
    3: { file: "wal/recover.go", k: 2, lines: [
      ["@", "@@ func (w *WAL) Replay(apply func([]byte)) error @@"],
      [" ", "    for off := int64(0); ; {"],
      [" ", "        n, rec, ok, err := w.readRecord(off) // bounds-checks n, verifies CRC32C over len+payload"],
      [" ", "        if err == io.EOF {"],
      [" ", "            return nil"],
      [" ", "        }"],
      ["+", "        if !ok {"],
      ["+", "            log.Printf(\"wal: bad record at %d, truncating\", off)"],
      ["+", "            return w.f.Truncate(off)"],
      ["+", "        }"],
      [" ", "        apply(rec)"],
      [" ", "        off += 8 + int64(n)"],
      [" ", "    }"],
      ["@", "@@ func (w *WAL) Append(rec []byte) error @@"],
      [" ", "    if _, err := w.f.Write(frame(rec)); err != nil {"],
      [" ", "        return err"],
      [" ", "    }"],
      ["+", "    _ = w.f.Sync() // best effort; the OS will flush eventually"],
      [" ", "    return nil"],
    ], bugs: [8, 17], why: "Truncating at the first bad record is right only for a torn <i>tail</i>. A bad record in the middle (a latent sector error or bit rot) is followed by valid, acknowledged records, and this code silently deletes all of them. Check whether valid frames follow the bad one: if so, fail loudly and recover from a replica or backup. And ignoring <code>Sync()</code>'s error acknowledges writes that may never reach the disk; after a failed fsync on Linux the dirty pages may already be dropped, so the only safe reaction is to stop and recover from the log." },
  };

  LB.addAll("storage", [
    /* 1 */ {
      id: "storage-btree-vs-lsm",
      name: "Pick the storage engine",
      kind: "Decision",
      skills: ["design", "estimate"],
      w: "choice",
      gen(lv, R) {
        let I;
        if (lv === 1) I = { lv, row: R.pick([150, 200, 250]), W: R.int(30, 60) * 1000, seq: false, P: R.int(2, 5) * 1000, S: 0, N: 0, wcap: R.pick([300, 400]), iopsCap: 20000, data: R.int(3, 6) * 100, disk: 2000 };
        else if (lv === 2) I = { lv, row: 200, W: R.int(10, 30) * 1000, seq: true, P: 5000, S: R.int(3, 6) * 1000, N: R.pick([20, 50, 100]), wcap: 300, iopsCap: R.pick([20000, 24000]), data: R.int(4, 8) * 100, disk: 2000 };
        else { const data = R.int(10, 20) * 100; I = { lv, row: R.pick([100, 128]), W: R.int(20, 40) * 1000, seq: false, P: 4000, S: R.int(1, 3) * 100, N: 1000, wcap: 300, iopsCap: 15000, data, disk: Math.round(data * R.pick([1.4, 1.5, 1.6])) }; }
        I.opts = lv === 1 ? ["bt", "lev"] : ["bt", "lev", "tier"];
        const ok = I.opts.filter((e) => engOk(I, e));
        if (ok.length !== 1) return null;
        I.ans = ok[0];
        return I;
      },
      text: (I) => `<p>A new service needs an embedded storage engine on one NVMe drive. Expected load:</p>
        <ul><li><b>${K.num(I.W)}</b> inserts/s of ~${I.row}-byte rows, keys ${I.seq ? "<b>arriving in order</b> (time-ordered ids)" : "<b>random</b> (UUIDv4)"}</li><li><b>${K.num(I.P)}</b> point reads/s${I.S ? `, <b>${K.num(I.S)}</b> range scans/s of ~${I.N} rows each` : ""}</li><li>${K.num(I.data)} GB of live data</li></ul>
        <p>Budgets: device writes ≤ <b>${I.wcap} MB/s</b>, read I/O ≤ <b>${K.num(I.iopsCap)} IOPS</b>, disk ≤ <b>${K.num(I.disk)} GB</b>. Your benchmark profile (per row / per lookup):</p>
        ${K.table(["Engine", "Bytes written", "I/Os per point read", "Extra seeks per scan", "Space amp"], I.opts.map((e) => [esc(ENG[e]), ENG_PROFILE[e].wa, ENG_PROFILE[e].pt, ENG_PROFILE[e].seeks, ENG_PROFILE[e].sa]), { compact: true })}
        <p class="muted small">A scan also reads its rows' bytes in 16 KB blocks.</p>`,
      ui: (I) => ({ opts: I.opts.map((e) => ENG[e]) }),
      ans: (I) => ENG[I.ans],
      diag: (I, a) => { const e = Object.keys(ENG).find((k) => ENG[k] === a); if (!e) return "Pick an engine."; const m = engModel(I, e); const why = []; if (m.wMB > I.wcap) why.push(`it writes ~${K.num(m.wMB)} MB/s (budget ${I.wcap})`); if (m.iops > I.iopsCap) why.push(`reads need ~${K.num(m.iops)} IOPS (budget ${K.num(I.iopsCap)})`); if (m.disk > I.disk) why.push(`it needs ~${K.num(m.disk)} GB of disk (budget ${K.num(I.disk)})`); return `With that engine ${why.join(", and ")}.`; },
      hint: (I) => I.lv === 1 ? "Multiply inserts/s by the bytes each engine writes per row." : I.lv === 2 ? "In-order keys change the B-tree's write cost completely. Then count I/Os for the scans." : "Check all three budgets for every engine: writes, read IOPS and disk.",
      concept: "B-tree vs LSM: the RUM trade-off",
      how: "A B-tree updates pages in place: a random insert dirties a whole 16 KB page for a 100-byte row, but reads are one I/O and scans walk contiguous leaves. When keys arrive in order, inserts fill the rightmost page sequentially and the write cost drops to about the row size. An LSM tree buffers writes in memory and writes sorted runs sequentially, then compacts them: write amplification is set by compaction (leveled ≈ 10–30×, tiered less), point reads use bloom filters to skip runs, but range scans must merge every overlapping run. Tiered compaction writes less but keeps more overlapping runs and needs free space for big merges.",
      rule: "Estimate write, read and space amplification for your actual workload before picking an engine. Random-key write-heavy loads favour LSM; scan-heavy or in-order-key loads are often fine, or better, on a B-tree.",
      why: (I, sol) => { const rows = I.opts.map((e) => { const m = engModel(I, e); return `${esc(ENG[e])}: ~${K.num(m.wMB)} MB/s written, ~${K.num(m.iops)} read IOPS, ~${K.num(m.disk)} GB`; }); return `<p>Only <b>${esc(sol)}</b> fits all three budgets.</p><ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>`; },
    },

    /* 2 */ {
      id: "storage-lsm-write-amp",
      name: "Read the compaction stats",
      kind: "Estimate",
      skills: ["estimate", "diagnose"],
      w: "num",
      gen(lv, R) {
        const G = R.int(40, 120);
        const lw = [G * R.int(97, 100) / 100, G * R.int(16, 24) / 10, G * R.int(40, 75) / 10, G * R.int(55, 85) / 10, G * R.int(30, 60) / 10].map((x) => Math.round(x * 10) / 10);
        const wal = Math.round(G * 1.04 * 10) / 10;
        const I = { lv, G, lw, wal, files: [R.int(2, 6), R.int(8, 20), R.int(60, 140), R.int(500, 900), R.int(3000, 7000)] };
        if (lv >= 2) { I.bulk = R.int(15, 30) * 100; I.up = R.int(60, 300) * 10; }
        if (lv === 3) { I.ftl = R.pick([1.2, 1.3, 1.4, 1.6]); I.grow = R.pick([1.5, 2, 3]); }
        return I;
      },
      text: (I) => {
        const sumW = K.sum(I.lw);
        const tbl = (scale) => K.cols([["Level", "Files", "Read(GB)", "Write(GB)", "W-Amp"], ...I.lw.map((w, i) => ["L" + i, I.files[i], f1(i === 0 ? 0 : w * 0.93 * scale), f1(w * scale), i === 0 ? "1.0" : f1(w / (I.lw[i - 1] * 0.93))]), ["Sum", K.sum(I.files), f1(K.sum(I.lw.slice(1)) * 0.93 * scale), f1(sumW * scale), ""]]);
        if (I.lv === 1) return `<p>An ingest node running RocksDB has been up for exactly one day. From <code>rocksdb.stats</code>:</p>${K.pre(`** Compaction Stats [default] **\n${tbl(1)}\n\nCumulative writes: ${K.num(I.G * 7200)}K writes, ingest: ${f1(I.G)} GB\nCumulative WAL: ${f1(I.wal)} GB written`)}<p>What is the <b>write amplification</b>: bytes written to the device (WAL + flushes + compactions) per byte of user data?</p>`;
        const c0 = { ingest: I.bulk + I.G * 4, wal: I.G * 4 * 1.04, comp: sumW * 4 }; const c1 = { ingest: c0.ingest + I.G, wal: c0.wal + I.wal, comp: c0.comp + sumW };
        const dump = (t, c) => `${t}  Cumulative: ingest ${K.num(c.ingest, 1)} GB · WAL ${K.num(c.wal, 1)} GB · flush+compaction writes ${K.num(c.comp, 1)} GB`;
        return `<p>The node was seeded at startup with a <b>${K.num(I.bulk)} GB</b> bulk load via <code>IngestExternalFile()</code> (pre-built SSTs, no WAL, no compaction), then took live traffic. Two snapshots of the cumulative counters, one hour apart:</p>${K.pre(dump("09:00", c0) + "\n" + dump("10:00", c1))}<p>Per-level stats for the last hour:</p>${K.pre(tbl(1))}
          ${I.lv === 2 ? `<p>What is the write amplification of <b>live traffic</b> right now?</p>` : `<p>The drive's vendor log shows NAND writes / host writes = <b>${I.ftl}</b>. Traffic is forecast to grow <b>${I.grow}×</b>. At that rate, how many <b>TB per day</b> will be written to NAND? (Assume the amplification stays the same.)</p>`}`;
      },
      ui: (I) => ({ unit: I.lv === 3 ? "TB/day" : "×" }),
      solve: (I) => { const wa = (I.wal + K.sum(I.lw)) / I.G; return I.lv < 3 ? K.round(wa, 1) : K.round((I.G * 24 * I.grow * wa * I.ftl) / 1000, 2); },
      accept: (I, a) => LB.near((J) => (J.lv < 3 ? (J.wal + K.sum(J.lw)) / J.G : (J.G * 24 * J.grow * ((J.wal + K.sum(J.lw)) / J.G) * J.ftl) / 1000), 0.1)(I, a),
      bad: (I) => { const wa = (I.wal + K.sum(I.lw)) / I.G; if (I.lv === 1) return [K.round(K.sum(I.lw) / I.G * 0.8, 1), K.round(wa * 2, 1)]; const c1i = I.bulk + I.G * 5, c1 = (I.G * 5 * 1.04 + K.sum(I.lw) * 5); if (I.lv === 2) return [K.round(c1 / c1i, 2)]; return [K.round((I.G * 24 * wa) / 1000, 2), K.round((I.G * 24 * I.grow * wa) / 1000, 2)]; },
      hint: (I) => I.lv === 1 ? "Add the WAL to the Sum of the Write(GB) column, then divide by ingest." : I.lv === 2 ? "The cumulative counters include the bulk load, which never went through the WAL or compaction. Use the hour's deltas." : "Hourly WA from the deltas, × 24 h × growth × the drive's own amplification.",
      concept: "Measuring write amplification",
      how: "Write amplification (WA) is device bytes written divided by user bytes written. In an LSM tree every byte is written once to the WAL, once when the memtable flushes to L0, and again every time compaction moves it down a level, each time merging it with roughly fanout-many bytes already there. RocksDB's compaction stats list the bytes written per level; their sum plus the WAL over user ingest is the engine's WA. Cumulative counters mix in one-off events like bulk loads, so measure rates over an interval. The SSD adds its own amplification below that (garbage collection inside the flash translation layer), so NAND wear is engine WA × device WA.",
      rule: "Compute WA from interval deltas, not lifetime totals, and multiply engine and device amplification when budgeting SSD endurance.",
      why: (I, sol) => { const wa = (I.wal + K.sum(I.lw)) / I.G; return `Over the interval, user ingest was ${f1(I.G)} GB while the WAL wrote ${f1(I.wal)} GB and flushes + compactions wrote ${f1(K.sum(I.lw))} GB: WA ≈ <b>${f1(wa)}</b>.${I.lv >= 2 ? ` The lifetime counters suggest a much lower number only because the ${K.num(I.bulk)} GB bulk load counts as ingest but cost no WAL or compaction writes.` : ""}${I.lv === 3 ? ` At ${I.grow}× traffic that's ${f1(I.G * 24 * I.grow)} GB/day of user data × ${f1(wa)} × ${I.ftl} ≈ <b>${sol} TB/day</b> of NAND writes.` : ""}`; },
    },

    /* 3 */ {
      id: "storage-bloom-bits",
      name: "Size the bloom filters",
      kind: "Config change",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "filter memory",
      vfmt: (v) => f2(v) + " GB",
      gen(lv, R) {
        const f0 = R.int(2, 5), fr = [0.001, 0.009, 0.09];
        const I = { lv, f0, fr: [...Array(f0).fill(0.0004 / f0), ...fr, 1 - 0.0004 - K.sum(fr)], keys: R.int(2, 9), hit: lv === 3 ? R.pick([0.96, 0.97, 0.98]) : R.pick([0.05, 0.1, 0.2, 0.3]), tau: lv === 3 ? R.pick([0.06, 0.08]) : R.pick([0.02, 0.03, 0.05]) };
        if (lv === 2) I.evict = R.pick([0.25, 0.35, 0.45]);
        if (lv === 3) I.budget = R.pick([1.0, 1.2]) * I.keys * 0.3;
        return I;
      },
      text: (I) => `<p>A ${I.lv === 3 ? "user-profile" : "dedup"} service runs RocksDB with <b>${I.keys} billion keys</b> in ${I.f0} L0 files and 4 levels (L4 holds ~90% of keys). ${I.lv === 3 ? `Lookups are reads of profiles that <b>almost always exist</b> (${K.pct(I.hit, 0)} hits).` : `Most lookups are for keys that <b>don't exist yet</b> (only ${K.pct(I.hit, 0)} are hits).`}</p>
        <p>Every sorted run probed without a bloom-filter rejection costs a wasted read. Keep <b>wasted reads ≤ ${I.tau} per lookup</b>${I.lv === 3 ? ` within a filter memory budget of <b>${f2(I.budget)} GB</b>` : ""}, using as little filter memory as possible.${I.lv === 2 ? ` Block-cache stats show <code>rocksdb.block.cache.filter.miss</code> / (hit + miss) = <b>${K.pct(I.evict, 0)}</b>: filter blocks keep getting evicted.` : ""}</p>
        <p class="muted small">False-positive rate with b bits/key ≈ 0.6185<sup>b</sup>; 0 bits = no filter.</p>`,
      ui: (I) => {
        const bits = [0, 2, 4, 6, 8, 10, 12, 14, 16, 20];
        const knobs = I.lv === 3 ? [{ k: "up", label: "Bits/key, L0–L3", opts: bits, help: "upper levels" }, { k: "last", label: "Bits/key, L4 (last level)", opts: bits, help: "0 = no filter on the bottom level" }] : [{ k: "bits", label: "bloom bits per key", opts: bits, help: "<code>NewBloomFilterPolicy(bits)</code>" }];
        if (I.lv === 2) knobs.push({ k: "pin", label: "Filter blocks", opts: ["block cache (evictable)", "pinned in memory"], help: "<code>cache_index_and_filter_blocks</code> + <code>pin_l0_filter_and_index_blocks_in_cache</code> / unpartitioned pinning" });
        return { knobs, init: I.lv === 3 ? { up: 0, last: 0 } : { bits: 0, pin: "block cache (evictable)" }, live: (cfg) => bloomHTML(I, cfg) };
      },
      valid: (I, cfg) => { const r = bloomModel(I, cfg); if (r.waste > I.tau + 1e-9) return `${f2(r.waste)} wasted reads per lookup (target ≤ ${I.tau})`; if (I.budget && r.mem > I.budget + 1e-9) return `filters need ${f2(r.mem)} GB (budget ${f2(I.budget)} GB)`; return true; },
      val: (I, cfg) => K.round(bloomModel(I, cfg).mem, 4),
      hint: (I) => I.lv === 1 ? "Misses probe every run. How low must the false-positive rate be, with this many runs?" : I.lv === 2 ? "A filter you have to read from disk first is an I/O, not a saving." : "For a key that exists, which level's filter almost never saves a read? That level holds 90% of the filter memory.",
      concept: "Bloom filters and read amplification",
      how: "Each LSM sorted run has a bloom filter: a lookup checks it and skips the run unless the filter says 'maybe'. With b bits per key and the optimal number of hash functions the false-positive rate is about 0.6185^b (10 bits ≈ 1%), so memory buys fewer wasted reads. A miss consults every run, so miss-heavy workloads need more bits. Filters only help if they're in memory: an evicted filter block costs an I/O to read before it can save one. For hit-heavy workloads the last level's filter almost never saves anything (the key is usually found there), so dropping it (RocksDB's optimize_filters_for_hits) saves ~90% of filter memory.",
      rule: "Size bits per key from the miss rate and the number of runs, keep filters pinned in memory, and skip the bottom-level filter when nearly all lookups find their key.",
      why: (I, sol) => { const r = bloomModel(I, sol); return `The cheapest setting that meets the target is ${I.lv === 3 ? `<b>${sol.up}</b> bits/key on L0–L3 and <b>${sol.last}</b> on L4` : `<b>${sol.bits}</b> bits/key${I.lv === 2 ? `, ${esc(sol.pin)}` : ""}`}: ${f2(r.waste)} wasted reads per lookup with ${f2(r.mem)} GB of filters.${I.lv === 2 ? ` Left evictable, ${K.pct(I.evict, 0)} of filter checks would themselves need a disk read.` : ""}${I.lv === 3 ? " With hits at " + K.pct(I.hit, 0) + ", the bottom filter only helps the few misses." : ""}`; },
    },
  ]);

  function bloomModel(I, cfg) {
    const n = I.fr.length, bitsOf = (j) => (I.lv === 3 ? (j === n - 1 ? cfg.last : cfg.up) : cfg.bits);
    const fp = (b) => (b ? Math.pow(0.6185, b) : 1);
    let eHit = 0, above = 0, checksHit = 0;
    for (let j = 0; j < n; j++) { eHit += I.fr[j] * above; checksHit += I.fr[j] * (j + 1); above += fp(bitsOf(j)); }
    const eMiss = above;
    let waste = I.hit * eHit + (1 - I.hit) * eMiss;
    if (I.lv === 2 && cfg.pin !== "pinned in memory" && cfg.bits > 0) waste += I.evict * (I.hit * checksHit + (1 - I.hit) * n);
    let mem = 0;
    for (let j = 0; j < n; j++) mem += (bitsOf(j) * I.fr[j] * I.keys) / 8; // GB (keys in billions)
    return { waste, mem, fpU: fp(bitsOf(0)) };
  }
  function bloomHTML(I, cfg) {
    const r = bloomModel(I, cfg);
    return K.metrics([
      { name: "False-positive rate", value: I.lv === 3 ? `${K.pct(Math.pow(0.6185, cfg.up || 0) * (cfg.up ? 1 : 1), 2)} / ${cfg.last ? K.pct(Math.pow(0.6185, cfg.last), 2) : "100%"}` : cfg.bits ? K.pct(Math.pow(0.6185, cfg.bits), 2) : "100%", ok: null },
      { name: "Wasted reads / lookup", value: f2(r.waste), ok: r.waste <= I.tau + 1e-9, target: `≤ ${I.tau}` },
      { name: "Filter memory", value: f2(r.mem) + " GB", ok: I.budget ? r.mem <= I.budget + 1e-9 : null, target: I.budget ? `≤ ${f2(I.budget)} GB` : "minimise" },
    ]);
  }

  /* expose helpers for the second file */
  LB._storage = { engModel, FS_OPS, fsJudge, fsLive, durShell, DUR_CAUSES, gcModel, gcCheck, gcRates, WAL_SRC };
})();
