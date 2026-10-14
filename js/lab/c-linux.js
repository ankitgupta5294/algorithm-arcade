/* Systems Lab · Linux & production debugging (part 1: disks, files, memory, processes, sockets).
   Most levels are shell sandboxes: realistic output from df, du, lsof, ss, ps, dmesg, journalctl, systemctl, strace, /proc. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;

  /* ---------- shared helpers ---------- */
  // df -h style size from MB
  const hs = (mb) => { if (mb >= 1048576) return (mb / 1048576).toFixed(1) + "T"; if (mb >= 1024) { const g = mb / 1024; return (g < 10 ? g.toFixed(1) : String(Math.round(g))) + "G"; } return Math.max(0, Math.round(mb)) + "M"; };
  const mkOpts = (R, right, wrong) => { const opts = R.shuffle([right, ...wrong]); return { opts, ans: opts.indexOf(right) }; };
  const pickGoal = (st, I, a) => (a.pick === I.ans ? true : `Not the root cause the evidence supports. ${I.miss || "Look again at what the commands showed."}`);
  // a filesystem row for df: avail excludes the 5% reserved for root, Use% = used / (used + avail), rounded up like df
  const dfUse = (size, used, res = 0.05) => { const avail = Math.max(0, size - used - size * res); return { avail, pct: used + avail ? Math.min(100, Math.ceil((used / (used + avail)) * 100)) : 100 }; };
  const dfLine = (dev, size, used, mnt, res) => { const u = dfUse(size, used, res); return [dev, hs(size), hs(used), hs(u.avail), u.pct + "%", mnt]; };
  const DFH = ["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted on"];
  // systemd drop-in written with printf/echo: returns { unit, kv: {Key: value} } or null
  const DROP = /^(?:printf|echo(?: -e)?) (['"])(.*)\1 *>>? *\/etc\/systemd\/system\/([\w@.-]+?)\.service\.d\/[\w.-]+\.conf$/;
  const dropIn = (line) => {
    const m = line.match(DROP);
    if (!m) return null;
    const kv = {};
    m[2].split(/\\n|\n/).forEach((l) => { const x = l.trim().match(/^(\w+)=(.*)$/); if (x) kv[x[1]] = x[2].trim(); });
    return { unit: m[3], kv };
  };
  const reloadWarn = (u) => `Warning: The unit file, source configuration file or drop-ins of ${u}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`;
  const lsofHead = ["COMMAND", "PID", "USER", "FD", "TYPE", "DEVICE", "SIZE/OFF", "NLINK", "NODE", "NAME"];
  const day = (R) => `Oct ${R.int(3, 10)}`;

  LB.addAll("linux", [
    /* ======================================================================== */
    {
      id: "linux-disk-deleted-open",
      name: "Disk full, but du disagrees",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        const size = R.pick([50, 80, 100]) * 1024;
        const svc = R.pick(["orders-api", "billing-api", "ledger-api", "catalog-api"]);
        const pids = R.distinct(4, 900, 9800);
        const used = Math.round(size * 0.95);
        const vis = Math.round(size * (lv === 1 ? 0.55 : lv === 2 ? 0.5 : 0.45));
        const del = used - vis;
        const app = { pid: pids[0], cmd: "java", user: "app", fd: R.int(40, 90), path: `/var/log/${svc}/${svc}.log`, kind: "app", unit: svc };
        let dels;
        if (lv === 1) dels = [{ ...app, mb: del }];
        else if (lv === 2) { const small = R.int(300, 600); dels = [{ ...app, mb: del - small }, { pid: pids[1], cmd: "dockerd", user: "root", fd: R.int(100, 180), path: `/var/lib/docker/containers/${R.int(1e5, 9e5).toString(16)}e1/json.log.1`, mb: small, kind: "docker", unit: "docker" }]; }
        else {
          const sys = Math.round(size * 0.22), my = Math.round(size * 0.18);
          dels = [{ pid: pids[2], cmd: "rsyslogd", user: "syslog", fd: 8, path: "/var/log/syslog.1", mb: sys, kind: "syslog", unit: "rsyslog" }, { ...app, mb: del - sys - my }, { pid: pids[3], cmd: "mysqld", user: "mysql", fd: R.int(30, 60), path: `/tmp/ib${R.pick(["Xk2Q", "a91F", "Pq7z", "M0cd"])}${R.int(10, 99)}`, mb: my, kind: "mysql", unit: "mysql" }];
        }
        const tree = { "/usr": Math.round(vis * 0.12), "/var/log": Math.round(vis * 0.08), "/var/lib/docker": Math.round(vis * (lv === 2 ? 0.45 : 0.2)), "/opt": Math.round(vis * 0.15), "/home": Math.round(vis * 0.04), "/var/cache": Math.round(vis * 0.03) };
        if (lv === 3) tree["/var/lib/mysql"] = Math.round(vis * 0.25);
        tree["/root"] = vis - Object.values(tree).reduce((a, b) => a + b, 0);
        return { lv, host: `${svc.split("-")[0]}-${R.int(1, 9)}${R.pick(["a", "b", "c"])}`, svc, size, vis, dels, tree, target: lv === 1 ? 90 : lv === 2 ? 85 : 80 };
      },
      text: (I) => `<p><b>PAGE:</b> <code>${I.host}</code> root filesystem at <b>100%</b>; <code>${I.svc}</code> is failing writes with <code>ENOSPC</code>. ${I.lv === 1 ? "Someone already ran <code>rm</code> on the big log file an hour ago, and the disk is still full." : I.lv === 2 ? `Logrotate and an engineer have both tried deleting files. <code>${I.svc}</code> is a single instance holding ${K.num(2000 + I.size % 997)} live websocket sessions: <b>restarting it is not acceptable</b> right now.` : "Logrotate ran last night. A large ALTER is running on the MySQL instance on this host and must not be interrupted."}</p><p>Get the root filesystem under <b>${I.target}%</b> without collateral damage. Type <code>help</code> for what this sandbox understands.</p>`,
      ...LB.term({
        shell(I) {
          const self = LB.byId.get("linux-disk-deleted-open");
          const usedNow = (st) => I.vis + st.dels.reduce((s, d) => s + (d.gone ? 0 : d.mb), 0);
          const findFd = (st, pid, fd) => st.dels.find((d) => d.pid === +pid && d.fd === +fd && !d.gone);
          const release = (st, pred) => st.dels.forEach((d) => { if (pred(d)) d.gone = true; });
          const sh = K.shell([
            { re: /^df(?: -[a-zA-Z]+)*(?: \/\S*)?$/, use: "df -h [path]", desc: "filesystem usage", run: (m, st, line) => /-\w*i/.test(line) ? K.cols([["Filesystem", "Inodes", "IUsed", "IFree", "IUse%", "Mounted on"], ["/dev/nvme0n1p1", "6.3M", "412K", "5.9M", "7%", "/"]]) : K.cols([DFH, ["tmpfs", "1.6G", "1.2M", "1.6G", "1%", "/run"], dfLine("/dev/nvme0n1p1", I.size, usedNow(st), "/"), ["tmpfs", "7.8G", "0", "7.8G", "0%", "/dev/shm"], dfLine("/dev/nvme0n1p15", 105, 6, "/boot/efi", 0)]) },
            { re: /^du (.*)$/, use: "du -xh --max-depth=1 <dir>  |  du -sh /var/*", desc: "space used by visible files", run: (m) => {
              const p = (m[1].split(" ").reverse().find((t) => t.startsWith("/")) || "/").replace(/\/\*$/, "").replace(/(.)\/$/, "$1") || "/";
              const keys = Object.keys(I.tree).filter((k) => p === "/" || k === p || k.startsWith(p + "/"));
              if (!keys.length) return `du: cannot access '${p}': No such file or directory`;
              const groups = {};
              keys.forEach((k) => { const rest = p === "/" ? k : k.slice(p.length); const seg = rest.split("/")[1]; const g = seg ? (p === "/" ? "" : p) + "/" + seg : p; groups[g] = (groups[g] || 0) + I.tree[k]; });
              const rows = Object.keys(groups).sort().map((g) => hs(groups[g]) + "\t" + g);
              const tot = keys.reduce((s, k) => s + I.tree[k], 0);
              return rows.join("\n") + (/\*/.test(m[1]) ? "" : `\n${hs(p === "/" ? I.vis : tot)}\t${p}`);
            } },
            { re: /^lsof(?: -\w+)*(?: \+L1| \| grep -i (?:deleted|del))(?: -\w+)*$/, use: "lsof +L1", desc: "open files whose link count is 0 (deleted but still open)", run: (m, st) => K.cols([lsofHead, ...st.dels.filter((d) => !d.gone).map((d) => [d.cmd, d.pid, d.user, d.fd + "w", "REG", "259,1", String(d.trunc ? 0 : d.mb * 1048576), "0", String(100000 + d.fd * 97 + d.pid), d.path + " (deleted)"])]) || "" },
            { re: /^ls -l(?:a|h)* \/proc\/(\d+)\/fd\/?$/, use: "ls -l /proc/<pid>/fd", desc: "a process's open file descriptors", run: (m, st) => {
              const ds = st.dels.filter((d) => d.pid === +m[1] && !d.gone);
              const known = I.dels.some((d) => d.pid === +m[1]);
              if (!known) return `ls: cannot access '/proc/${m[1]}/fd': No such file or directory`;
              if (!ds.length) return `ls: cannot access '/proc/${m[1]}/fd': No such file or directory`;
              return ["total 0", "lr-x------ 1 root root 64 Oct 11 03:02 0 -> /dev/null", "l-wx------ 1 root root 64 Oct 11 03:02 1 -> /dev/null", "l-wx------ 1 root root 64 Oct 11 03:02 2 -> /dev/null", ...ds.map((d) => `l-wx------ 1 root root 64 Oct 11 03:02 ${d.fd} -> ${d.path} (deleted)`)].join("\n");
            } },
            { re: /^(?:truncate -s ?0 |: ?> ?|> ?|cat \/dev\/null ?> ?)\/proc\/(\d+)\/fd\/(\d+)$/, use: ": > /proc/<pid>/fd/<fd>   (or truncate -s 0 ...)", desc: "truncate a deleted-but-open file through its fd", run: (m, st) => {
              const d = findFd(st, m[1], m[2]);
              if (!d) return `bash: /proc/${m[1]}/fd/${m[2]}: No such file or directory`;
              d.gone = true; d.trunc = true;
              if (d.kind === "mysql") { st.broke = `You truncated mysqld's temporary file ${esc(d.path)}: that was the working file of the running ALTER, not a log. MySQL failed the statement with "Incorrect key file for table" and the hours-long ALTER must start again.`; return { out: "", danger: "That file was MySQL's in-use temporary table data, not a log." }; }
              if (d.kind === "syslog") st.sysTrunc = true;
              return "";
            } },
            { re: /^systemctl (restart|stop|reload|kill -s (?:HUP|SIGHUP)) ([\w@.-]+?)(?:\.service)?$/, use: "systemctl restart|reload <unit>  ·  systemctl kill -s HUP <unit>", desc: "restart a service or signal it", run: (m, st) => {
              const u = m[2], act = m[1];
              const ds = I.dels.filter((d) => d.unit === u);
              if (!ds.length && !["cron", "ssh", "nginx"].includes(u)) return `Failed to ${act.split(" ")[0]} ${u}.service: Unit ${u}.service not found.`;
              if (act === "reload" && u === "rsyslog") return "Failed to reload rsyslog.service: Job type reload is not applicable for unit rsyslog.service.";
              if (act === "reload") return "";
              if (/HUP/.test(act)) { if (u === "rsyslog") { release(st, (d) => d.kind === "syslog"); st.sysFixed = true; return ""; } if (u === I.svc) { release(st, (d) => d.kind === "app"); if (I.lv === 2) st.broke = `SIGHUP killed ${esc(I.svc)} (the JVM exits on SIGHUP) and dropped every live session.`; return { out: "", danger: `${u} has no SIGHUP handler: the JVM's default action for SIGHUP is to exit, so this killed the service.` }; } return ""; }
              release(st, (d) => d.unit === u);
              if (u === "rsyslog") st.sysFixed = true;
              if (u === I.svc && I.lv === 2) { st.broke = `Restarting ${esc(I.svc)} dropped every live websocket session, which the page said was not acceptable. The fd could have been truncated in place.`; return { out: "", danger: "Restarted a service the incident said must stay up." }; }
              if (u === "mysql") { st.broke = "Restarting MySQL killed the running ALTER (and every connection). Its temp file was not a log to reclaim."; return { out: "", danger: "Restarted the database mid-ALTER." }; }
              if (u === "docker") { st.broke = "Restarting dockerd restarted every container on the host (live-restore is off). The 400 MB log wasn't worth it."; return { out: "", danger: "Restarted the container runtime." }; }
              return "";
            } },
            { re: /^kill (-9|-KILL|-SIGKILL|-HUP|-SIGHUP|-1|-15|-TERM)? ?(\d+)$/, use: "kill [-HUP|-9] <pid>", desc: "signal a process", run: (m, st) => {
              const sig = m[1] || "-15", pid = +m[2];
              const ds = I.dels.filter((d) => d.pid === pid);
              if (!ds.length) return `bash: kill: (${pid}) - No such process`;
              const d0 = ds[0];
              if (/HUP|-1/.test(sig) && d0.kind === "syslog") { release(st, (d) => d.kind === "syslog"); st.sysFixed = true; return ""; }
              release(st, (d) => d.pid === pid);
              if (d0.kind === "syslog") { st.sysFixed = true; return { out: "", danger: "You killed rsyslogd; systemd restarts it, but messages in flight were lost. SIGHUP is the documented way to make it reopen files." }; }
              if (d0.kind === "app") { if (I.lv === 2) st.broke = `Killing ${esc(I.svc)} dropped every live session, which the page said was not acceptable.`; return { out: "", danger: `You killed ${I.svc} (in-flight requests lost).` }; }
              if (d0.kind === "mysql") { st.broke = "Killing mysqld aborted the ALTER and forced crash recovery."; return { out: "", danger: "You killed the database." }; }
              st.broke = "Killing dockerd took down every container on the host."; return { out: "", danger: "You killed the container runtime." };
            } },
            { re: /^rm (?:-\w+ )*(\S+)$/, use: "rm <file>", desc: "remove a file", run: (m) => { const p = m[1]; if (I.dels.some((d) => d.path === p)) return `rm: cannot remove '${p}': No such file or directory`; if (/^\/(proc|var\/lib\/mysql|usr|opt)/.test(p) || p === "/" ) return { out: `rm: refusing in this sandbox: ${p}`, danger: "Deleting application or system files to make room is never the fix." }; return `rm: cannot remove '${p}': No such file or directory`; } },
            { re: /^ps(?: .*)?$/, use: "ps -o pid,user,etime,cmd -p <pid>  |  ps aux", desc: "processes", run: (m, st, line) => { const pm = line.match(/-p (\d+)/); const all = [...new Map(I.dels.map((d) => [d.pid, d])).values()]; const list = pm ? all.filter((d) => d.pid === +pm[1]) : all; const cmdOf = (d) => d.kind === "app" ? `/usr/bin/java -Xmx4g -jar /opt/${I.svc}/${I.svc}.jar` : d.kind === "syslog" ? "/usr/sbin/rsyslogd -n -iNONE" : d.kind === "mysql" ? "/usr/sbin/mysqld" : "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock"; return K.cols([["PID", "USER", "ELAPSED", "CMD"], ...list.map((d) => [d.pid, d.user, d.kind === "mysql" ? "4-02:11:09" : "12-07:44:31", cmdOf(d)])]); } },
            { re: /^cat \/etc\/logrotate\.d\/(\S+)$/, use: "cat /etc/logrotate.d/<name>", desc: "logrotate config", run: (m) => m[1] === "rsyslog" ? "/var/log/syslog\n{\n\trotate 1\n\tdaily\n\tmissingok\n\tnotifempty\n\tnocompress\n}" : `cat: /etc/logrotate.d/${m[1]}: No such file or directory` },
          ]);
          void self;
          return {
            prompt: `root@${I.host}:~#`, init: { dels: K.clone(I.dels), broke: null }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 7 : 6,
            motd: `ALERT disk_used_percent{mount="/"} = 100 on ${I.host}\n${I.svc}: java.io.IOException: No space left on device`,
            cmds: ["df -h", "du -xh --max-depth=1 /", "lsof +L1", "ls -l /proc/<pid>/fd", ": > /proc/<pid>/fd/<fd>", "systemctl kill -s HUP <unit>", "systemctl restart <unit>", ...(I.lv === 3 ? ["cat /etc/logrotate.d/rsyslog"] : [])],
          };
        },
        goal(st, I) {
          if (st.broke) return st.broke;
          const used = I.vis + st.dels.reduce((s, d) => s + (d.gone ? 0 : d.mb), 0);
          const pct = dfUse(I.size, used).pct;
          if (pct >= I.target) return `Root is still at ${pct}% (target under ${I.target}%). The space is held by files that were deleted while a process still has them open.`;
          if (I.lv === 3 && !st.sysFixed) return "Space is back for now, but rsyslogd is still writing into the deleted syslog.1. It will fill again tonight. Make it reopen its files (that's what the missing postrotate step should have done).";
          return true;
        },
        solve: (I) => {
          const a = I.dels.find((d) => d.kind === "app");
          if (I.lv === 3) { return { log: ["df -h", "lsof +L1", "systemctl kill -s HUP rsyslog", "df -h"] }; }
          return { log: ["df -h", "du -xh --max-depth=1 /", "lsof +L1", `: > /proc/${a.pid}/fd/${a.fd}`, "df -h"] };
        },
      }),
      bad: (I) => {
        const a = I.dels.find((d) => d.kind === "app"), my = I.dels.find((d) => d.kind === "mysql");
        if (I.lv === 1) return [{ log: ["df -h", `rm ${a.path}`] }, { log: ["du -xh --max-depth=1 /"] }];
        if (I.lv === 2) return [{ log: [`systemctl restart ${I.svc}`] }, { log: [`kill -9 ${a.pid}`] }];
        return [{ log: [`: > /proc/${my.pid}/fd/${my.fd}`, `: > /proc/${a.pid}/fd/${a.fd}`] }, { log: [`: > /proc/${a.pid}/fd/${a.fd}`] }, { log: ["systemctl restart mysql", "systemctl kill -s HUP rsyslog"] }];
      },
      hint: (I) => I.lv === 1 ? "df counts blocks still allocated; du only sees files that have a name. Which files have no name but are still open?" : I.lv === 2 ? "You can empty a deleted-but-open file through the process's /proc/<pid>/fd entry without restarting the process." : "Three deleted files are open. Which one is a log, which one is a working data file, and which process just needs to be told to reopen its files?",
      concept: "Deleted-but-open files",
      how: "Deleting a file only removes its name. The inode and its blocks stay allocated until the last process holding it open closes it, so df (which counts allocated blocks) and du (which walks names) disagree. lsof +L1 lists open files with a link count of 0. You can free the space by making the holder close the file (restart, or a signal that makes it reopen logs, like SIGHUP for rsyslog or USR1 for nginx), or by truncating it in place through /proc/PID/fd/N, which is only safe for append-only logs. Some programs (MySQL, many temp-file libraries) deliberately create a file and unlink it immediately, so a deleted file is not automatically garbage.",
      rule: "When df and du disagree, run lsof +L1 before deleting anything else. Truncate logs through /proc/PID/fd, signal daemons to reopen, and never truncate a file you can't prove is a log.",
      why: (I) => {
        const a = I.dels.find((d) => d.kind === "app");
        if (I.lv === 1) return `${hs(a.mb)} was still allocated to <code>${esc(a.path)}</code> because java (pid ${a.pid}) kept fd ${a.fd} open after the rm. Truncating via <code>/proc/${a.pid}/fd/${a.fd}</code> (or restarting the service) released it.`;
        if (I.lv === 2) return `The deleted ${hs(a.mb)} log was held by ${esc(I.svc)} (pid ${a.pid}, fd ${a.fd}). <code>: &gt; /proc/${a.pid}/fd/${a.fd}</code> frees the blocks while the process keeps writing at its current offset (with O_APPEND, from 0). /var/lib/docker looked big in du but was real, live data.`;
        const s = I.dels.find((d) => d.kind === "syslog");
        return `logrotate's rsyslog config has <code>rotate 1</code> and no postrotate step, so rsyslogd (pid ${s.pid}) kept writing to the old file after it was rotated out and deleted: ${hs(s.mb)}. SIGHUP makes it reopen /var/log/syslog. The ${hs(I.dels.find((d) => d.kind === "mysql").mb)} /tmp/ib* file is MySQL's working temp file for the running ALTER: deleted by design, not reclaimable.`;
      },
    },
    /* ======================================================================== */
    {
      id: "linux-disk-hog",
      name: "Find what's eating the root disk",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        const size = R.pick([40, 60, 80]) * 1024, base = Math.round(size * R.int(38, 46) / 100);
        const hog = Math.round(size * 0.95) - base;
        const tree = { "/usr": Math.round(base * 0.3), "/var/lib/apt": Math.round(base * 0.04), "/var/log": Math.round(base * 0.04), "/opt": Math.round(base * 0.22), "/home": Math.round(base * 0.06), "/var/cache": Math.round(base * 0.05), "/var/lib/docker": Math.round(base * 0.2) };
        tree["/snap"] = base - Object.values(tree).reduce((a, b) => a + b, 0);
        const cid = (K.hash("c" + R.int(1, 1e9)).toString(16) + K.hash("d" + R.int(1, 1e9)).toString(16)).padEnd(16, "0").slice(0, 12);
        const name = R.pick(["ingest-worker", "pdf-render", "event-relay", "scraper"]);
        if (lv === 1) tree["/var/log/journal"] = hog;
        if (lv === 2) tree[`/var/lib/docker/containers/${cid}`] = hog;
        const host = `${R.pick(["worker", "batch", "app"])}-${R.int(10, 40)}`;
        return { lv, size, base, hog, tree, cid, name, host, files: R.int(12, 40) * 1000 };
      },
      text: (I) => `<p><b>PAGE:</b> <code>${I.host}</code> root filesystem at <b>100%</b>. ${I.lv === 1 ? "Nothing was deployed this week." : I.lv === 2 ? `The only workload is a few containers; <code>${I.name}</code> got a debug flag turned on yesterday.` : "The host rebooted for kernel patching 40 minutes ago; since then root has filled steadily. The app stores customer uploads on a separate data volume."}</p><p>Find the space and bring root under <b>80%</b> without losing anything that matters.</p>`,
      ...LB.term({
        shell(I) {
          const used = (st) => I.base + st.hog;
          const visTree = (st) => { const t = { ...I.tree }; if (I.lv === 1) t["/var/log/journal"] = st.hog; if (I.lv === 2) t[`/var/lib/docker/containers/${I.cid}`] = st.rmd ? 1 : st.hog; return t; };
          const du = (tree, p) => {
            const keys = Object.keys(tree).filter((k) => p === "/" || k === p || k.startsWith(p + "/"));
            if (!keys.length) return null;
            const groups = {};
            keys.forEach((k) => { const rest = p === "/" ? k : k.slice(p.length); const seg = rest.split("/")[1]; const g = seg ? (p === "/" ? "" : p) + "/" + seg : p; groups[g] = (groups[g] || 0) + tree[k]; });
            return { rows: Object.keys(groups).sort().map((g) => hs(groups[g]) + "\t" + g), tot: keys.reduce((s, k) => s + tree[k], 0) };
          };
          const upl = "/var/lib/app/uploads";
          const sh = K.shell([
            { re: /^df(?: -[a-zA-Z]+)*(?: \/\S*)?$/, use: "df -h [path]", desc: "filesystem usage", run: (m, st) => K.cols([DFH, dfLine("/dev/nvme0n1p1", I.size, used(st), "/"), ["tmpfs", "3.9G", "0", "3.9G", "0%", "/dev/shm"], ...(I.lv === 3 ? [dfLine("/dev/nvme1n1", 500 * 1024, 212 * 1024, upl)] : [])]) },
            { re: /^du (.*)$/, use: "du -xh --max-depth=1 <dir>", desc: "space used by files (stays on one filesystem with -x)", run: (m, st) => {
              const arg = m[1].split(" ").reverse().find((t) => t.startsWith("/")) || "/";
              const p = arg.replace(/\/\*$/, "").replace(/(.)\/$/, "$1") || "/";
              if (I.lv === 3 && p.startsWith("/mnt/rootfs")) {
                if (!st.bind) return `du: cannot access '${p}': No such file or directory`;
                const inner = p.slice("/mnt/rootfs".length) || "/";
                const t = { ...I.tree, [upl]: st.hidden };
                const r = du(t, inner); if (!r) return `du: cannot access '${p}': No such file or directory`;
                return r.rows.map((x) => x.replace("\t", "\t/mnt/rootfs")).join("\n") + `\n${hs(r.tot)}\t${p}`;
              }
              if (I.lv === 3 && (p === upl || p.startsWith(upl))) return `${hs(212 * 1024)}\t${upl}`;
              const r = du(visTree(st), p); if (!r) return `du: cannot access '${p}': No such file or directory`;
              const tot = p === "/" ? (I.lv === 3 ? I.base : r.tot) : r.tot;
              return r.rows.join("\n") + `\n${hs(tot)}\t${p}`;
            } },
            { re: /^lsof(?: -\w+)* \+L1(?: -\w+)*$/, use: "lsof +L1", desc: "deleted-but-open files", run: (m, st) => st.rmd ? K.cols([lsofHead, ["dockerd", "1187", "root", "38w", "REG", "259,1", String(st.hog * 1048576), "0", "524411", `/var/lib/docker/containers/${I.cid}…/${I.cid}…-json.log (deleted)`]]) : "" },
            { re: /^journalctl --disk-usage$/, use: "journalctl --disk-usage", desc: "journal size", run: (m, st) => `Archived and active journals take up ${hs(I.lv === 1 ? st.hog : 412)} in the file system.` },
            { re: /^journalctl --vacuum-(size|time)=(\d+)([KMGd]|h|weeks?|days?)?$/, use: "journalctl --vacuum-size=<N>M | --vacuum-time=<N>d", desc: "delete archived journal files", run: (m, st) => {
              if (I.lv !== 1) return "Vacuuming done, freed 0B of archived journals from /var/log/journal/3f1c0d….";
              const before = st.hog;
              let keep = 0;
              if (m[1] === "size") keep = +m[2] * (m[3] === "G" ? 1024 : m[3] === "K" ? 1 / 1024 : 1);
              else keep = (m[3] && /^h/.test(m[3]) ? +m[2] / 24 : +m[2]) * 380;
              st.hog = Math.max(128, Math.min(before, Math.round(keep)));
              return `Deleted archived journal /var/log/journal/3f1c0d9e…/system@0006…-0000000000a1b2c3.journal~ (128.0M).\n…\nVacuuming done, freed ${hs(before - st.hog)} of archived journals from /var/log/journal/3f1c0d9e….`;
            } },
            { re: /^cat \/etc\/systemd\/journald\.conf$/, use: "cat /etc/systemd/journald.conf", desc: "", run: () => "[Journal]\n#Storage=auto\n#Compress=yes\n#SystemMaxUse=\n#SystemKeepFree=\n#MaxRetentionSec=\n#RateLimitIntervalSec=30s\n#RateLimitBurst=10000" },
            { re: /^docker ps(?: -a)?$/, use: "docker ps", desc: "containers", run: () => K.cols([["CONTAINER ID", "IMAGE", "STATUS", "NAMES"], [I.cid, `registry.internal/${I.name}:2026.10.2`, "Up 26 hours", I.name], ["9b1e77c0a412", "registry.internal/node-exporter:1.8.2", "Up 3 weeks", "node-exporter"]]) },
            { re: /^docker inspect (?:--format|-f) ['"]?\{\{\.LogPath\}\}['"]? (\S+)$/, use: "docker inspect --format '{{.LogPath}}' <container>", desc: "where a container's json log lives", run: (m) => (m[1] === I.name || I.cid.startsWith(m[1])) ? `/var/lib/docker/containers/${I.cid}e3a9/${I.cid}e3a9-json.log` : `Error: No such object: ${m[1]}` },
            { re: /^ls -l\w* (\S+)$/, use: "ls -lh <path>", desc: "list files", run: (m, st) => {
              const p = m[1];
              if (I.lv === 2 && p.includes(I.cid)) return st.rmd ? "total 8.0K\n-rw-r--r-- 1 root root 4.0K Oct  9 08:12 config.v2.json" : `total ${hs(st.hog)}\n-rw-r--r-- 1 root root 4.0K Oct  9 08:12 config.v2.json\n-rw-r----- 1 root root ${hs(st.hog)} Oct 11 03:12 ${I.cid}e3a9-json.log`;
              if (I.lv === 3 && p.startsWith("/mnt/rootfs" + upl)) return st.bind ? (st.hidden > 1 ? `total ${hs(st.hidden)}\ndrwxr-x--- 2 app app 4.0K Oct 11 02:31 2026-10-11\n(${K.num(I.files)} files, all written today between 02:31 and 03:11)` : "total 0") : `ls: cannot access '${p}': No such file or directory`;
              if (I.lv === 3 && p.startsWith(upl)) return "total 212G\ndrwxr-x--- 2 app app 4.0K Oct 10 23:59 2026-10-10\ndrwxr-x--- 2 app app 4.0K Oct 11 03:11 2026-10-11  (only files written after 03:11 are here)";
              return `ls: cannot access '${p}': No such file or directory`;
            } },
            { re: /^truncate -s ?0 (\S+)$/, use: "truncate -s 0 <file>", desc: "empty a file in place", run: (m, st) => { if (I.lv === 2 && m[1].includes(I.cid) && m[1].endsWith("-json.log") && !st.rmd) { st.hog = 0; return ""; } return `truncate: cannot open '${m[1]}' for writing: No such file or directory`; } },
            { re: /^rm (?:-\w+ )*(\S+)$/, use: "rm [-rf] <path>", desc: "remove files", run: (m, st) => {
              const p = m[1];
              if (I.lv === 1 && p.startsWith("/var/log/journal")) { st.hog = 0; st.broke = "rm under a running journald deleted the active journal files too: this boot's logs are gone and journald keeps writing to unlinked files until restarted. journalctl --vacuum-size/--vacuum-time removes archived files safely."; return { out: "", danger: "Deleting journal files under a running journald (including the active ones) loses the current boot's logs and leaves journald writing to unlinked files. journalctl --vacuum-* exists for this." }; }
              if (I.lv === 2 && p.includes(I.cid)) { if (p.endsWith("-json.log")) { st.rmd = true; return ""; } st.broke = "You deleted the container's state directory under a running dockerd; the container can no longer be managed or restarted cleanly."; return { out: "", danger: "Deleted dockerd's container state." }; }
              if (I.lv === 3 && p.startsWith("/mnt/rootfs" + upl)) { if (!st.bind) return `rm: cannot remove '${p}': No such file or directory`; if (!st.copied) st.broke = `You deleted ${K.num(I.files)} customer uploads that exist nowhere else: they were written to the root disk while the data volume wasn't mounted yet.`; st.hidden = 1; return st.copied ? "" : { out: "", danger: "Deleted customer data that had no other copy." }; }
              if (p === "/" || /^\/(usr|var\/lib\/docker\/?$|opt|var\/lib\/app)/.test(p)) return { out: `rm: refusing in this sandbox: ${p}`, danger: "Deleting application or system files to make room is never the fix." };
              return `rm: cannot remove '${p}': No such file or directory`;
            } },
            { re: /^docker (system prune.*|image prune.*|restart \S+|rm -f \S+)$/, use: "docker system prune … | docker restart <name>", desc: "", run: (m, st) => {
              if (/^restart/.test(m[1])) return m[1].split(" ")[1];
              if (/^rm/.test(m[1])) { st.broke = `You removed the ${esc(I.name)} container (its log goes with it, but so does the running workload).`; return { out: m[1].split(" ")[2], danger: "Force-removed a running container." }; }
              if (/--volumes/.test(m[1])) { st.broke = "docker system prune --volumes deleted every volume not attached to a running container, including the stopped database's data."; return { out: "Deleted Volumes:\npgdata\nminio-cache\n\nTotal reclaimed space: 31.4GB", danger: "Pruned volumes." }; }
              return "Total reclaimed space: 1.2GB";
            } },
            { re: /^(?:findmnt(?: \S+)?|mount(?: \| grep \S+)?|lsblk(?: -f)?)$/, use: "findmnt | mount | lsblk", desc: "mounted filesystems", run: () => I.lv === 3 ? `TARGET                  SOURCE         FSTYPE OPTIONS\n/                       /dev/nvme0n1p1 ext4   rw,relatime,discard\n├─/boot/efi             /dev/nvme0n1p15 vfat  rw,relatime\n└─${upl}    /dev/nvme1n1   xfs    rw,noatime    (mounted 03:11 by app-data.mount)` : "TARGET  SOURCE         FSTYPE OPTIONS\n/       /dev/nvme0n1p1 ext4   rw,relatime,discard\n└─/boot/efi /dev/nvme0n1p15 vfat rw,relatime" },
            { re: /^journalctl -u (\S+?)(?:\.mount)?(?: .*)?$/, use: "journalctl -u <unit>", desc: "a unit's logs", run: (m) => /app-data/.test(m[1]) ? `Oct 11 02:29:58 ${I.host} systemd[1]: Mounting app-data.mount - /var/lib/app/uploads...\nOct 11 02:31:28 ${I.host} systemd[1]: dev-nvme1n1.device: Job dev-nvme1n1.device/start timed out.\nOct 11 02:31:28 ${I.host} systemd[1]: Timed out waiting for device dev-nvme1n1.device - /dev/nvme1n1.\nOct 11 02:31:28 ${I.host} systemd[1]: Dependency failed for app-data.mount - /var/lib/app/uploads.\nOct 11 03:11:04 ${I.host} systemd[1]: Mounted app-data.mount - /var/lib/app/uploads.` : "-- No entries --" },
            { re: /^mount --bind \/ \/mnt\/rootfs$/, use: "mount --bind / /mnt/rootfs", desc: "see the root fs without anything mounted on top", run: (m, st) => { st.bind = true; return ""; } },
            { re: /^umount \/mnt\/rootfs$/, use: "umount /mnt/rootfs", desc: "", run: (m, st) => { st.bind = false; return ""; } },
            { re: /^rsync -a\w* \/mnt\/rootfs\/var\/lib\/app\/uploads\/? \/var\/lib\/app\/uploads\/?$/, use: "rsync -a <src>/ <dst>/", desc: "copy files preserving owners and times", run: (m, st) => { if (!st.bind) return "rsync: change_dir \"/mnt/rootfs/var/lib/app/uploads\" failed: No such file or directory (2)"; st.copied = true; return ""; } },
          ]);
          return {
            prompt: `root@${I.host}:~#`, init: { hog: I.lv === 3 ? 0 : I.hog, hidden: I.lv === 3 ? I.hog : 0, rmd: false, bind: false, copied: false, broke: null }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 9 : 6,
            motd: `ALERT disk_used_percent{mount="/"} = 100 on ${I.host}`,
            cmds: ["df -h", "du -xh --max-depth=1 /", "lsof +L1", ...(I.lv === 1 ? ["journalctl --disk-usage", "journalctl --vacuum-size=<N>M"] : I.lv === 2 ? ["docker ps", "docker inspect --format '{{.LogPath}}' <container>", "truncate -s 0 <file>"] : ["findmnt", "journalctl -u app-data.mount", "mount --bind / /mnt/rootfs", "rsync -a <src>/ <dst>/", "rm -rf <path>"])],
          };
        },
        goal(st, I) {
          if (st.broke) return st.broke;
          const used = I.base + (I.lv === 3 ? (st.hidden > 1 ? st.hidden : 0) : st.hog);
          const pct = dfUse(I.size, used).pct;
          if (I.lv === 2 && st.rmd) return "The json log is unlinked but dockerd still has it open, so no space came back (check lsof +L1). Docker log files must be truncated, not deleted.";
          if (pct >= 80) return `Root is still at ${pct}%.${I.lv === 3 ? " du of / doesn't add up to what df says, and nothing deleted is open. Where can files hide from du?" : ""}`;
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: ["df -h", "du -xh --max-depth=1 /var", "journalctl --disk-usage", "journalctl --vacuum-size=500M", "df -h"] }
          : I.lv === 2 ? { log: ["du -xh --max-depth=1 /var/lib/docker", "docker ps", `docker inspect --format '{{.LogPath}}' ${I.name}`, `truncate -s 0 /var/lib/docker/containers/${I.cid}e3a9/${I.cid}e3a9-json.log`, "df -h"] }
            : { log: ["df -h", "du -xh --max-depth=1 /", "findmnt", "mount --bind / /mnt/rootfs", "du -xh --max-depth=1 /mnt/rootfs/var/lib/app", "rsync -a /mnt/rootfs/var/lib/app/uploads/ /var/lib/app/uploads/", "rm -rf /mnt/rootfs/var/lib/app/uploads/2026-10-11", "umount /mnt/rootfs"] },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["rm -rf /var/log/journal/*"] }, { log: ["journalctl --vacuum-size=40G"] }] : I.lv === 2 ? [{ log: [`rm /var/lib/docker/containers/${I.cid}e3a9/${I.cid}e3a9-json.log`] }, { log: ["docker system prune -a --volumes -f"] }] : [{ log: ["mount --bind / /mnt/rootfs", "rm -rf /mnt/rootfs/var/lib/app/uploads/2026-10-11"] }, { log: ["du -xh --max-depth=1 /"] }],
      hint: (I) => I.lv === 1 ? "Walk down with du -x one level at a time. Then use the owning tool to clean up, not rm." : I.lv === 2 ? "Docker's json-file logs live under /var/lib/docker/containers and dockerd keeps them open." : "du of / is much smaller than df's Used, and lsof +L1 is empty. What happens to files written into a directory before a filesystem is mounted on top of it?",
      concept: "Finding disk hogs: du -x, owning tools, shadowed files",
      how: "du -x walks one filesystem and attributes space to names; drill down a level at a time. Clean up with the tool that owns the data: journalctl --vacuum-size for the journal, truncation for files a daemon keeps open (docker's json-file logs), the app's own retention for app data. If du of a filesystem is far below df's Used and lsof +L1 shows nothing, the space is usually in files hidden under a mount point: written into the directory while the real volume wasn't mounted, then shadowed when it was. A bind mount of / shows the underlying directory.",
      rule: "Drill down with du -x, delete through the owning tool, and before removing anything you can't explain, copy it somewhere safe. Prevent recurrence with SystemMaxUse, docker log-opts max-size, and mounts the app depends on (RequiresMountsFor=).",
      why: (I) => I.lv === 1 ? `The systemd journal had grown to ${hs(I.hog)} because journald.conf sets no SystemMaxUse and the default cap scales with filesystem size. Vacuuming kept the recent journal and freed the rest; setting SystemMaxUse=1G stops it recurring.` : I.lv === 2 ? `${esc(I.name)}'s debug output went to its json-file log (${hs(I.hog)}). dockerd keeps that file open, so rm would only have unlinked it; truncating frees it immediately. Setting log-opts max-size/max-file in daemon.json caps it for good.` : `After the reboot the data volume timed out and mounted 40 minutes late, so ${K.num(I.files)} customer uploads (${hs(I.hog)}) went into /var/lib/app/uploads on the root disk and were then hidden by the mount. The bind mount exposed them; copying them onto the volume before deleting kept every upload. RequiresMountsFor=/var/lib/app/uploads on the app unit would have kept the app down until the mount existed.`,
    },
    /* ======================================================================== */
    {
      id: "linux-inode-exhaustion",
      name: "No space left, with 40% free",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        const total = R.pick([6553600, 3276800, 13107200]);
        const baseUsed = Math.round(total * R.int(6, 10) / 100);
        const hog = total - baseUsed;
        const dir = lv === 1 ? "/var/lib/php/sessions" : lv === 2 ? "/srv/uploads/.chunks" : "/var/spool/postfix/maildrop";
        return { lv, total, baseUsed, hog, dir, old: R.int(93, 98), host: `${R.pick(["web", "app", "edge"])}-${R.int(2, 30)}`, pct: R.int(52, 64), log: R.int(9, 18) };
      },
      text: (I) => `<p><b>PAGE:</b> on <code>${I.host}</code> writes fail with <code>No space left on device</code>, yet the dashboard shows the root disk only <b>${I.pct}%</b> full. ${I.lv === 2 ? "Resumable uploads are in progress right now; chunks newer than an hour may belong to them." : I.lv === 3 ? "Nobody has deployed anything here for months." : ""}</p><p>Restore writes (inode use under <b>80%</b>) without breaking anything that is live${I.lv === 3 ? ", and make sure it doesn't come back" : ""}.</p>`,
      ...LB.term({
        shell(I) {
          const used = (st) => I.baseUsed + st.hog;
          const tree = (st) => ({ "/usr": Math.round(I.baseUsed * 0.55), "/var/lib/dpkg": Math.round(I.baseUsed * 0.05), "/var/log": 2310, "/home": Math.round(I.baseUsed * 0.1), "/opt": Math.round(I.baseUsed * 0.2), "/etc": 2900, [I.dir]: st.hog });
          const sh = K.shell([
            { re: /^df(?: -[a-zA-Z]+)*(?: \/\S*)?$/, use: "df -h | df -i", desc: "blocks or inodes", run: (m, st, line) => {
              if (/-\w*i/.test(line)) { const u = used(st), f = I.total - u, pc = Math.ceil(u / I.total * 100) + "%"; const h = /-\w*h/.test(line); const f2 = (x) => h ? (x >= 1e6 ? (x / 1048576).toFixed(1) + "M" : Math.round(x / 1024) + "K") : String(x); return K.cols([["Filesystem", "Inodes", "IUsed", "IFree", "IUse%", "Mounted on"], ["/dev/nvme0n1p1", f2(I.total), f2(u), f2(f), pc, "/"], ["tmpfs", f2(1007718), f2(1103), f2(1006615), "1%", "/run"]]); }
              const size = I.total / 16384 * 1024, usedMb = size * I.pct / 100 * 0.95;
              return K.cols([DFH, dfLine("/dev/nvme0n1p1", size, usedMb, "/"), ["tmpfs", "3.9G", "0", "3.9G", "0%", "/dev/shm"]]);
            } },
            { re: /^touch (\S+)$/, use: "touch <file>", desc: "", run: (m, st) => used(st) >= I.total ? `touch: cannot touch '${m[1]}': No space left on device` : "" },
            { re: /^du (?:-\w+ )*--inodes(?: -\w+)* (\S+)$|^du (?:-\w+ )*-\w*d1 --inodes (\S+)$/, use: "du --inodes -xd1 <dir>", desc: "inode count per directory", run: (m, st) => {
              const p = ((m[1] || m[2]).replace(/(.)\/$/, "$1"));
              const t = tree(st), keys = Object.keys(t).filter((k) => p === "/" || k === p || k.startsWith(p + "/"));
              if (!keys.length) return `du: cannot access '${p}': No such file or directory`;
              const g = {}; keys.forEach((k) => { const rest = p === "/" ? k : k.slice(p.length); const seg = rest.split("/")[1]; const n = seg ? (p === "/" ? "" : p) + "/" + seg : p; g[n] = (g[n] || 0) + t[k]; });
              return Object.keys(g).sort().map((n) => g[n] + "\t" + n).join("\n") + `\n${keys.reduce((s, k) => s + t[k], 0) + (p === "/" ? 1200 : 0)}\t${p}`;
            } },
            { re: /^du (?!.*--inodes)(.*)$/, use: "du -xh --max-depth=1 <dir>", desc: "space per directory", run: (m) => { const p = (m[1].split(" ").reverse().find((x) => x.startsWith("/")) || "/"); if (p === "/" || p === "/var") return (p === "/" ? `2.1G\t/usr\n${I.lv === 2 ? I.log + "G\t/var" : "1.4G\t/var"}\n310M\t/opt\n96M\t/home\n` : `${I.lv === 2 ? I.log + "G\t/var/log\n" : "120M\t/var/log\n"}410M\t/var/lib\n38M\t/var/cache\n`) + `${p === "/" ? (I.lv === 2 ? I.log + 4 : 4) : (I.lv === 2 ? I.log + 1 : 1)}G\t${p}`; return `${I.lv === 2 && p.startsWith("/var/log") ? I.log + "G" : "180M"}\t${p}`; } },
            { re: /^find (\S+?)\/? (?:-xdev )?-type f \| wc -l$/, use: "find <dir> -type f | wc -l", desc: "count files", run: (m, st) => (m[1] === I.dir ? String(st.hog) : m[1].startsWith("/var/lib/dpkg") ? "18211" : "2304") },
            { re: /^ls (?:-\w+ )*(\S+?)\/?(?: \| head(?: -n ?\d+| -\d+)?)?$/, use: "ls -lt <dir> | head", desc: "list a directory", run: (m) => {
              if (m[1] !== I.dir) return `ls: cannot access '${m[1]}': No such file or directory`;
              if (I.lv === 1) return "total 23412088\n-rw------- 1 www-data www-data 0 Oct 11 03:12 sess_9qk2h1c0m4a\n-rw------- 1 www-data www-data 412 Oct 11 03:12 sess_c81e0pf3j2b\n-rw------- 1 www-data www-data 389 Oct 11 03:11 sess_p01bd7a2kq9";
              if (I.lv === 2) return "total 39101776\n-rw-r----- 1 app app 5242880 Oct 11 03:12 u_7f3a9c.part0042\n-rw-r----- 1 app app 5242880 Oct 11 03:12 u_7f3a9c.part0041\n-rw-r----- 1 app app 5242880 Oct 11 03:11 u_11b0e2.part0007";
              return "total 23601144\n-rwxr--r-- 1 root postdrop 611 Oct 11 03:12 4XkJ7c1rWz\n-rwxr--r-- 1 root postdrop 611 Oct 11 03:11 4XkJ6b0yQm\n-rwxr--r-- 1 root postdrop 611 Oct 11 03:10 4XkJ5Z8sLp";
            } },
            { re: /^rm (?:-\w+ )*(\S+)$/, use: "rm [-rf] <path>", desc: "", run: (m, st) => {
              const p = m[1];
              if (p.startsWith(I.dir + "/*") || p === I.dir + "/*") return "-bash: /usr/bin/rm: Argument list too long";
              if (p.replace(/\/$/, "") === I.dir) { st.hog = 0; st.broke = I.lv === 3 ? "You removed postfix's maildrop directory itself; postdrop now fails outright and the cron output errors pile up in the journal instead. Delete the files, keep the directory." : I.lv === 1 ? "Removing the sessions directory logged out every active user and PHP can't create new sessions until the directory (with its www-data ownership and mode) is recreated." : "Removing the chunks directory destroyed in-progress uploads and the uploader now fails to create new chunks."; return { out: "", danger: "Removed the directory itself, not the stale files." }; }
              return `rm: cannot remove '${p}': No such file or directory`;
            } },
            { re: /^find (\S+?)\/? (.*)-delete$/, use: "find <dir> -type f -mmin +<minutes> -delete", desc: "delete matching files without a huge argument list", run: (m, st) => {
              if (m[1] !== I.dir) return `find: '${m[1]}': nothing to delete here`;
              const age = m[2].match(/-m(min|time) \+(\d+)/);
              const mins = age ? (age[1] === "min" ? +age[2] : (+age[2] + 1) * 1440) : 0;
              if (I.lv === 1 && mins < 24) { st.broke = "That deleted sessions that were still in use: every logged-in user was signed out mid-checkout. PHP's session lifetime here is 24 minutes (session.gc_maxlifetime=1440 s); delete only files older than that."; }
              if (I.lv === 2 && mins < 60) { st.broke = "That deleted chunks of uploads still in progress; those customers' uploads now fail at the end. Only chunks older than an hour are abandoned."; }
              st.hog = mins === 0 || I.lv === 3 ? 0 : Math.round(st.hog * (100 - I.old) / 100);
              if (I.lv === 3 && st.fixed !== true) st.hog = 0;
              return "";
            } },
            ...(I.lv === 1 ? [{ re: /^(?:php -i \| grep (?:-i )?gc|grep -r (?:-i )?gc_ \/etc\/php\S*|cat \/etc\/cron\.d\/php)$/, use: "php -i | grep gc  |  cat /etc/cron.d/php", desc: "PHP session garbage collection settings", run: (m, st, line) => /cron/.test(line) ? "# Look for and purge old sessions every 30 minutes\n# 09,39 *     * * *     root   [ -x /usr/lib/php/sessionclean ] && if [ ! -d /run/systemd/system ]; then /usr/lib/php/sessionclean; fi\n# (disabled by config management on 2026-07-02)" : "session.gc_divisor => 1000 => 1000\nsession.gc_maxlifetime => 1440 => 1440\nsession.gc_probability => 0 => 0" }] : []),
            ...(I.lv === 3 ? [
              { re: /^(?:postcat|cat|head(?: -n ?\d+| -\d+)?) \/var\/spool\/postfix\/maildrop\/(\S+)$/, use: "postcat /var/spool/postfix/maildrop/<file>", desc: "show a queued mail", run: () => `*** ENVELOPE RECORDS maildrop ***\nsender: root\n*** MESSAGE CONTENTS ***\nFrom: root (Cron Daemon)\nTo: root\nSubject: Cron <root@${I.host}> /usr/local/bin/push-metrics.sh\n\npushed 214 series to metrics-gw.internal:9091 in 38ms` },
              { re: /^systemctl status postfix(?:\.service)?$/, use: "systemctl status postfix", desc: "", run: () => "○ postfix.service - Postfix Mail Transport Agent\n     Loaded: loaded (/lib/systemd/system/postfix.service; disabled; preset: enabled)\n     Active: inactive (dead)" },
              { re: /^systemctl (?:start|enable --now) postfix$/, use: "systemctl start postfix", desc: "", run: (m, st) => { st.postfix = true; return { out: "", danger: "Postfix now tries to deliver millions of cron mails into /var/mail/root and relay them; that moves the problem, it doesn't remove it." }; } },
              { re: /^cat \/etc\/cron\.d\/metrics-push$/, use: "cat /etc/cron.d/metrics-push", desc: "", run: (m, st) => `${st.fixed ? 'MAILTO=""\n' : ""}# push host metrics every minute\n* * * * * root /usr/local/bin/push-metrics.sh${st.fixed === "redir" ? " >/dev/null 2>&1" : ""}${st.tail ? '\nMAILTO=""' : ""}` },
              { re: /^ls \/etc\/cron\.d\/?$/, use: "ls /etc/cron.d", desc: "", run: () => "e2scrub_all  metrics-push  sysstat" },
              { re: /^sed -i (.*) \/etc\/cron\.d\/metrics-push$/, use: "sed -i '1i MAILTO=\"\"' /etc/cron.d/metrics-push", desc: "edit the cron file", run: (m, st) => { if (/MAILTO/.test(m[1]) && /1i/.test(m[1])) st.fixed = true; else if (/\/dev\/null/.test(m[1])) st.fixed = "redir"; return ""; } },
              { re: /^echo ['"]?MAILTO=.*>> ?\/etc\/cron\.d\/metrics-push$/, use: "echo 'MAILTO=\"\"' >> /etc/cron.d/metrics-push", desc: "", run: (m, st) => { st.tail = true; return ""; } },
            ] : []),
          ]);
          return {
            prompt: `root@${I.host}:~#`, init: { hog: I.hog, broke: null, fixed: false, tail: false }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 8 : 6,
            motd: `${I.lv === 1 ? "PHP Warning:  session_start(): open(/var/lib/php/sessions/sess_x1…, O_RDWR) failed: No space left on device (28)" : I.lv === 2 ? "upload-api: open /srv/uploads/.chunks/u_93ac1f.part0001: no space left on device" : "postdrop: warning: mail_queue_enter: create file maildrop/…: No space left on device"}`,
            cmds: ["df -h", "df -i", "du --inodes -xd1 /", "ls -lt <dir> | head", "find <dir> -type f -mmin +<minutes> -delete", ...(I.lv === 1 ? ["php -i | grep gc"] : []), ...(I.lv === 3 ? ["postcat /var/spool/postfix/maildrop/<file>", "cat /etc/cron.d/metrics-push", "sed -i '1i MAILTO=\"\"' /etc/cron.d/metrics-push"] : [])],
          };
        },
        goal(st, I) {
          if (st.broke) return st.broke;
          const u = (I.baseUsed + st.hog) / I.total;
          if (u >= 0.8) return `Inode use is still ${Math.ceil(u * 100)}%. ${I.lv > 1 ? "" : "Which directory holds millions of tiny files?"}`;
          if (I.lv === 3 && !st.fixed) return st.tail ? "MAILTO at the end of the file applies only to lines after it, so the job above still mails its output every minute." : "The maildrop is empty again, but the cron job still mails its output every minute to a postfix that isn't running. It will refill.";
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: ["df -i", "du --inodes -xd1 /var/lib/php", "find /var/lib/php/sessions -type f -mmin +1440 -delete", "df -i"] }
          : I.lv === 2 ? { log: ["df -i", "du --inodes -xd1 /srv/uploads", "ls -lt /srv/uploads/.chunks | head", "find /srv/uploads/.chunks -type f -mmin +120 -delete", "df -i"] }
            : { log: ["df -i", "du --inodes -xd1 /var/spool/postfix", "postcat /var/spool/postfix/maildrop/4XkJ7c1rWz", "cat /etc/cron.d/metrics-push", "sed -i '1i MAILTO=\"\"' /etc/cron.d/metrics-push", "find /var/spool/postfix/maildrop -type f -delete", "df -i"] },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["rm -rf /var/lib/php/sessions"] }, { log: ["find /var/lib/php/sessions -type f -delete"] }, { log: ["rm /var/lib/php/sessions/*"] }] : I.lv === 2 ? [{ log: ["find /srv/uploads/.chunks -type f -delete"] }, { log: ["rm -rf /srv/uploads/.chunks/*"] }] : [{ log: ["find /var/spool/postfix/maildrop -type f -delete"] }, { log: ["echo 'MAILTO=\"\"' >> /etc/cron.d/metrics-push", "find /var/spool/postfix/maildrop -type f -delete"] }],
      hint: (I) => I.lv === 1 ? "df -h counts blocks; df -i counts inodes. Then find the directory with the most files, and delete only files nobody is using." : I.lv === 2 ? "A shell glob over millions of files exceeds the argument limit. find -delete doesn't. Mind the in-progress uploads." : "Who writes into the postfix maildrop when postfix isn't even running? Read one of the files.",
      concept: "Inode exhaustion",
      how: "ext4 allocates a fixed number of inodes at mkfs time (by default one per 16 KiB of space). Every file, however small, needs one, so millions of tiny files exhaust inodes while df -h still shows free blocks, and every create fails with ENOSPC. df -i shows it; du --inodes finds the directory. Globs like rm dir/* expand to an argument list too long for execve, so use find -delete with an age filter to keep live files. Typical sources: session or cache files whose garbage collection is off, abandoned upload chunks, and mail queued by cron for an MTA that isn't running.",
      rule: "Alert on inode use (df -i) as well as bytes. Clean with find -mmin/-mtime -delete, and fix the producer: GC, retention, or MAILTO=\"\" / output redirection for cron jobs.",
      why: (I) => I.lv === 1 ? `PHP's probabilistic session GC is off (gc_probability 0) and the sessionclean cron was disabled, so ${K.num(I.hog)} session files accumulated. Deleting those older than session.gc_maxlifetime (1440 s) frees the inodes without logging anyone out.` : I.lv === 2 ? `${K.num(I.hog)} abandoned upload chunks filled the inode table while the ${I.log} GB debug log in /var/log was a red herring (bytes, not inodes). An age filter of an hour or more spares uploads still in progress.` : `A cron job runs every minute and prints a line; cron mails any output to root via postdrop, which drops each message into /var/spool/postfix/maildrop, and postfix (which would pick them up) is disabled. Months of that is ${K.num(I.hog)} files. MAILTO="" before the job (or redirecting its output) stops the mail; then the backlog can be deleted.`,
    },
    /* ======================================================================== */
    {
      id: "linux-fd-limit",
      name: "Too many open files",
      kind: "Incident",
      skills: ["diagnose", "tune"],
      gen(lv, R) {
        const svc = R.pick(["gateway", "edge-proxy", "notify-api", "feed-api"]);
        const pid = R.int(1500, 30000), need = R.int(13, 22) * 100;
        const up = `10.20.${R.int(1, 9)}.${R.int(10, 250)}`;
        const I = { lv, svc, pid, need, up, host: `${svc}-${R.int(1, 6)}`, cw: R.int(60, 64) * 1000 };
        if (lv === 2) { const o = mkOpts(R, "A connection leak: sockets to the upstream sit in CLOSE_WAIT because the code never closes them", ["LimitNOFILE is too low for this much traffic", "The system-wide fs.file-max table is exhausted", "The upstream is slow, so healthy connections pile up in ESTABLISHED"]); I.opts = o.opts; I.ans = o.ans; I.miss = "Count the sockets by state: ESTABLISHED is real work, CLOSE_WAIT means the peer closed and we never did."; }
        return I;
      },
      text: (I) => `<p><b>PAGE:</b> <code>${I.svc}</code> on <code>${I.host}</code> refuses new connections; its log is full of <code>accept4: too many open files</code>. ${I.lv === 2 ? "It was fine for three days after the last deploy, then started failing." : I.lv === 3 ? `Last month someone "fixed" this by adding <code>nofile 65535</code> for the service user in <code>/etc/security/limits.conf</code>; it's back.` : "Traffic doubled this week after a partner launch."}</p><p>${I.lv === 2 ? "Find the root cause and get the service healthy again (it runs on 6 hosts behind a load balancer, so restarting one is fine)." : `Restore service with enough headroom for the real number of connections${I.lv === 3 ? ", in a way that survives the next restart or reboot" : ""}.`}</p>`,
      ...LB.term({
        shell(I) {
          const S = I.svc;
          const fdsOf = (st) => st.leakReset ? 312 : I.lv === 2 ? st.soft : Math.min(st.soft, I.need + 40);
          const limitsTxt = (st) => K.cols([["Limit", "Soft Limit", "Hard Limit", "Units"], ["Max cpu time", "unlimited", "unlimited", "seconds"], ["Max file size", "unlimited", "unlimited", "bytes"], ["Max data size", "unlimited", "unlimited", "bytes"], ["Max stack size", "8388608", "unlimited", "bytes"], ["Max core file size", "0", "unlimited", "bytes"], ["Max processes", "63428", "63428", "processes"], ["Max open files", String(st.soft), String(st.hard), "files"], ["Max locked memory", "8388608", "8388608", "bytes"]]);
          const pidOk = (st, p) => +p === st.pid;
          const unitTxt = (st) => `# /etc/systemd/system/${S}.service\n[Unit]\nDescription=${S}\nAfter=network-online.target\n\n[Service]\nUser=${S}\nExecStart=/opt/${S}/bin/${S} --listen :8443\nRestart=on-failure\n${I.lv === 2 ? "LimitNOFILE=65536\n" : ""}${st.dropin ? `\n# /etc/systemd/system/${S}.service.d/override.conf\n[Service]\nLimitNOFILE=${st.dropin}` : ""}`;
          const states = (st) => I.lv === 2 && !st.leakReset ? [["ESTAB", 1180], ["CLOSE-WAIT", I.cw], ["TIME-WAIT", 2210], ["LISTEN", 3]] : [["ESTAB", I.need - 20], ["CLOSE-WAIT", 4], ["TIME-WAIT", 1890], ["LISTEN", 3]];
          const sh = K.shell([
            { re: new RegExp(`^journalctl -u ${S}(?:\\.service)?(?: (?:-n ?\\d+|--no-pager|-e|--since \\S+))*$`), use: `journalctl -u ${S} -n 20`, desc: "service log", run: (m, st) => st.leakReset || (st.soft >= I.need * 2 && I.lv !== 2) ? `Oct 11 03:20:01 ${I.host} ${S}[${st.pid}]: listening on :8443` : Array.from({ length: 5 }, (_, k) => `Oct 11 03:1${k}:0${k} ${I.host} ${S}[${st.pid}]: http: Accept error: accept tcp [::]:8443: accept4: too many open files; retrying in ${[5, 10, 20, 40, 80][k]}ms`).join("\n") },
            { re: new RegExp(`^systemctl status ${S}(?:\\.service)?$`), use: `systemctl status ${S}`, desc: "", run: (m, st) => `● ${S}.service - ${S}\n     Loaded: loaded (/etc/systemd/system/${S}.service; enabled; preset: enabled)${st.dropin ? `\n    Drop-In: /etc/systemd/system/${S}.service.d\n             └─override.conf` : ""}\n     Active: active (running) since ${st.leakReset || st.restarted ? "Sat 2026-10-11 03:21:40 UTC; 12s ago" : "Wed 2026-10-08 09:02:11 UTC; 2 days ago"}\n   Main PID: ${st.pid} (${S})\n      Tasks: 41 (limit: 18922)` },
            { re: new RegExp(`^systemctl cat ${S}(?:\\.service)?$`), use: `systemctl cat ${S}`, desc: "unit file and drop-ins", run: (m, st) => unitTxt(st) },
            { re: new RegExp(`^systemctl show ${S}(?:\\.service)? (?:-p|--property=?) ?LimitNOFILE\\w*$`), use: `systemctl show ${S} -p LimitNOFILE`, desc: "", run: (m, st) => `LimitNOFILE=${st.unitLimit}` },
            { re: /^(?:pgrep -f \S+|pidof \S+)$/, use: "pgrep -f <name>", desc: "", run: (m, st) => String(st.pid) },
            { re: /^(?:cat|grep -i ['"]?open files['"]?) \/proc\/(\d+)\/limits$/, use: "cat /proc/<pid>/limits", desc: "the limits the running process actually has", run: (m, st, line) => pidOk(st, m[1]) ? (/grep/.test(line) ? limitsTxt(st).split("\n").filter((l, i) => !i || /open files/.test(l)).join("\n") : limitsTxt(st)) : `cat: /proc/${m[1]}/limits: No such file or directory` },
            { re: /^ls (?:-\w+ )?\/proc\/(\d+)\/fd \| wc -l$/, use: "ls /proc/<pid>/fd | wc -l", desc: "open descriptors right now", run: (m, st) => pidOk(st, m[1]) ? String(fdsOf(st)) : `ls: cannot access '/proc/${m[1]}/fd': No such file or directory\n0` },
            { re: /^ss -s$/, use: "ss -s", desc: "socket summary", run: (m, st) => { const s = states(st), tot = s.reduce((a, b) => a + b[1], 0); return `Total: ${tot + 220}\nTCP:   ${tot} (estab ${s[0][1]}, closed ${s[1][1] + 30}, orphaned 0, timewait ${s[2][1]})\n\nTransport Total     IP        IPv6\nRAW       0         0         0\nUDP       6         4         2\nTCP       ${tot - s[2][1]}     ${tot - s[2][1] - 40}       40`; } },
            { re: /^ss -\w*t\w*a\w*n?\w*p?(?: .*)?\| ?(?:awk|cut).*(?:uniq -c|sort).*$/, use: "ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c", desc: "TCP sockets by state", run: (m, st) => states(st).map(([k, v]) => `${String(v).padStart(7)} ${k}`).join("\n") },
            { re: /^ss -\w*t\w*n\w* state close-wait(?: .*)?$/, use: "ss -tnp state close-wait", desc: "sockets the peer closed but we didn't", run: (m, st, line) => { const n = states(st)[1][1]; if (/wc -l/.test(line)) return String(n + 1); return `Recv-Q Send-Q Local Address:Port   Peer Address:Port Process\n` + Array.from({ length: Math.min(4, n) }, (_, k) => `1      0      10.0.3.17:${41000 + k * 37}  ${I.up}:443  users:(("${S}",pid=${st.pid},fd=${200 + k * 13}))`).join("\n") + (n > 4 ? `\n… ${n - 4} more` : ""); } },
            { re: /^ulimit -(?:n|Sn|Hn)$/, use: "ulimit -n", desc: "your shell's limit (not the service's)", run: () => (I.lv === 3 ? "65535" : "1024") },
            { re: /^cat \/etc\/security\/limits\.conf$/, use: "cat /etc/security/limits.conf", desc: "PAM limits for login sessions", run: () => "# /etc/security/limits.conf\n#<domain>      <type>  <item>         <value>\n#*               soft    core            0\n#@student        hard    nproc           20\n" + (I.lv === 3 ? `${S}           soft    nofile          65535\n${S}           hard    nofile          65535\n*               soft    nofile          65535\n` : "") + "# End of file" },
            { re: /^sysctl fs\.file-(?:max|nr)$|^cat \/proc\/sys\/fs\/file-nr$/, use: "cat /proc/sys/fs/file-nr", desc: "system-wide file handles: allocated, free, max", run: () => "18432\t0\t9223372036854775807" },
            { re: /^prlimit (?:--pid[= ]|-p ?)(\d+) --nofile[= ](\d+):(\d+)$/, use: "prlimit --pid <pid> --nofile=<soft>:<hard>", desc: "change a running process's limit", run: (m, st) => { if (!pidOk(st, m[1])) return `prlimit: failed to get the nofile resource limit: No such process`; st.soft = +m[2]; st.hard = Math.max(+m[3], +m[2]); st.live = true; return ""; } },
            { re: /^systemctl daemon-reload$/, use: "systemctl daemon-reload", desc: "", run: (m, st) => { if (st.dropin) { st.unitLimit = st.dropin; st.reloaded = true; } return ""; } },
            { re: new RegExp(`^systemctl restart ${S}(?:\\.service)?$`), use: `systemctl restart ${S}`, desc: "", run: (m, st) => { st.pid += 7; st.restarted = true; const [s, h] = String(st.unitLimit).split(":"); st.soft = +s || 1024; st.hard = +(h || s) || 524288; if (I.lv === 2) st.leakReset = true; return st.dropin && !st.reloaded ? reloadWarn(S) : ""; } },
            { re: /^(?:printf|echo).*$/, use: `printf '[Service]\\nLimitNOFILE=65536\\n' > /etc/systemd/system/${S}.service.d/override.conf`, desc: "write a systemd drop-in", run: (m, st, line) => { const d = dropIn(line); if (!d) return "(nothing written: this sandbox understands printf '...' > /etc/systemd/system/<unit>.service.d/<name>.conf)"; if (d.unit !== S) return `(written to ${d.unit}.service.d, which isn't this service)`; if (d.kv.LimitNOFILE) { st.dropin = d.kv.LimitNOFILE; st.reloaded = false; } return ""; } },
            { re: /^ulimit -n \d+$/, use: "ulimit -n <N>", desc: "", run: () => "" },
          ]);
          return {
            prompt: `root@${I.host}:~#`, init: { pid: I.pid, soft: I.lv === 2 ? 65536 : 1024, hard: I.lv === 2 ? 65536 : 524288, unitLimit: I.lv === 2 ? "65536" : "1024:524288", dropin: null, reloaded: false, live: false, restarted: false, leakReset: false }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 9 : 7,
            motd: `${S}[${I.pid}]: http: Accept error: accept tcp [::]:8443: accept4: too many open files; retrying in 1s`,
            cmds: [`journalctl -u ${S} -n 20`, `systemctl status ${S}`, "cat /proc/<pid>/limits", "ls /proc/<pid>/fd | wc -l", "ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c", "prlimit --pid <pid> --nofile=<soft>:<hard>", `printf '[Service]\\nLimitNOFILE=65536\\n' > /etc/systemd/system/${S}.service.d/override.conf`, "systemctl daemon-reload", `systemctl restart ${S}`, ...(I.lv === 3 ? ["ulimit -n", "cat /etc/security/limits.conf"] : [])],
            ...(I.lv === 2 ? { opts: I.opts, optq: "Root cause" } : {}),
          };
        },
        goal(st, I, a) {
          if (I.lv === 2) { if (a.pick !== I.ans) return pickGoal(st, I, a); if (!st.leakReset) return "The diagnosis is right, but the service is still refusing connections. Mitigate now (this host can be restarted), then fix the leak in code."; return true; }
          if (st.soft < I.need * 2) return `The running process has a soft limit of ${st.soft} open files, but it needs about ${I.need} and spikes go higher. Give it real headroom (at least ${I.need * 2}).`;
          if (I.lv === 3 && !(st.dropin && st.reloaded && +String(st.dropin).split(":")[0] >= I.need * 2)) return "The running process is fine now, but nothing persistent changed: the next restart starts with 1024 again. limits.conf only applies to PAM login sessions, not to systemd services; set LimitNOFILE in a drop-in and daemon-reload.";
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: [`journalctl -u ${I.svc} -n 20`, `cat /proc/${I.pid}/limits`, `ls /proc/${I.pid}/fd | wc -l`, `printf '[Service]\\nLimitNOFILE=65536\\n' > /etc/systemd/system/${I.svc}.service.d/override.conf`, "systemctl daemon-reload", `systemctl restart ${I.svc}`] }
          : I.lv === 2 ? { log: [`cat /proc/${I.pid}/limits`, `ls /proc/${I.pid}/fd | wc -l`, "ss -tan | awk 'NR>1 {print $1}' | sort | uniq -c", "ss -tnp state close-wait", `systemctl restart ${I.svc}`], pick: I.ans }
            : { log: ["ulimit -n", `cat /proc/${I.pid}/limits`, `prlimit --pid ${I.pid} --nofile=65536:524288`, `printf '[Service]\\nLimitNOFILE=65536:524288\\n' > /etc/systemd/system/${I.svc}.service.d/override.conf`, "systemctl daemon-reload", `cat /proc/${I.pid}/limits`] },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["ulimit -n 65536"] }, { log: [`printf '[Service]\\nLimitNOFILE=65536\\n' > /etc/systemd/system/${I.svc}.service.d/override.conf`, `systemctl restart ${I.svc}`] }] : I.lv === 2 ? [{ log: [`prlimit --pid ${I.pid} --nofile=1048576:1048576`], pick: (I.ans + 1) % 4 }, { log: [], pick: I.ans }] : [{ log: [`prlimit --pid ${I.pid} --nofile=65536:524288`] }, { log: ["ulimit -n 65536", `systemctl restart ${I.svc}`] }],
      hint: (I) => I.lv === 1 ? "Your shell's ulimit isn't the service's. Read /proc/<pid>/limits, then change the unit (a drop-in), reload systemd, and restart." : I.lv === 2 ? "Before raising any limit, look at what the descriptors are: count TCP sockets by state." : "limits.conf is applied by pam_limits at login. Which component starts this service, and where does it take limits from?",
      concept: "File descriptor limits (RLIMIT_NOFILE)",
      how: "Every socket and file uses a descriptor, capped per process by RLIMIT_NOFILE (soft limit enforced, hard limit is the ceiling the soft may be raised to). systemd services get theirs from LimitNOFILE= (default soft 1024, hard 524288), not from /etc/security/limits.conf, which pam_limits applies only to login sessions. /proc/PID/limits shows what the running process really has; prlimit can change it live, and a drop-in plus daemon-reload makes it stick. If the descriptor count grows forever, a higher limit only delays the failure: CLOSE_WAIT sockets mean the peer closed and the application never called close().",
      rule: "Check /proc/PID/limits and the descriptor mix (ss by state) before touching limits. Set LimitNOFILE in the unit, alert on fd usage / limit, and treat steadily growing CLOSE_WAIT as a leak, not a capacity problem.",
      why: (I) => I.lv === 1 ? `${esc(I.svc)} needed about ${I.need} descriptors for real connections but ran with systemd's default soft limit of 1024. A LimitNOFILE drop-in, daemon-reload and restart gave it 65536.` : I.lv === 2 ? `${K.num(I.cw)} of the 65,536 descriptors were sockets in CLOSE_WAIT to ${I.up}:443: the upstream closed them, the code (likely an HTTP response body never closed) did not. Restarting buys time; the fix is in code, and raising the limit would only have delayed the next outage.` : `limits.conf set 65535 for logins, so your shell showed 65535, but systemd started ${esc(I.svc)} with 1024 soft. prlimit fixed the live process without a restart and the LimitNOFILE drop-in (after daemon-reload) makes it permanent.`,
    },
    /* ======================================================================== */
    {
      id: "linux-oom-killer",
      name: "Who killed the process?",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        const pid = R.int(3000, 30000), t = `Sat Oct 11 0${R.int(1, 5)}:${R.int(10, 59)}:${R.int(10, 59)} 2026`;
        let o;
        if (lv === 1) o = mkOpts(R, "report-worker's own memory grew until the host ran out of RAM; the global OOM killer chose it as the biggest process", ["A cgroup memory limit on report-worker was reached", "Page cache filled RAM and starved the worker", "The kernel killed it for exceeding its stack limit"]);
        else if (lv === 2) o = mkOpts(R, "The unit's MemoryMax=2G is no bigger than the heap (-Xmx2g), and heap plus the JVM's off-heap memory exceeds it: a cgroup OOM kill", ["The host ran out of memory", "A heap leak: the JVM threw OutOfMemoryError and exited", "Swap is disabled, so the kernel killed the largest process"]);
        else o = mkOpts(R, "The ETL job exhausted host memory; the OOM killer picked a postgres process because shared_buffers pages count toward its RSS", ["A work_mem leak in postgres", "A cgroup limit on postgres was hit", "postgres was killed because its oom_score_adj is +1000"]);
        return { lv, pid, t, ...o, rss: R.int(105, 125) / 10, host: `${R.pick(["data", "jobs", "svc"])}-${R.int(1, 9)}`, miss: lv === 2 ? "Compare the host's free memory with the limit in the kill message." : lv === 3 ? "The victim isn't always the process that grew. Compare anon-rss with shmem-rss in the kill line." : "Read the oom-kill line: constraint, task and anon-rss." };
      },
      text: (I) => `<p><b>PAGE:</b> ${I.lv === 1 ? "<code>report-worker</code> died at night and the monthly report is missing." : I.lv === 2 ? "<code>billing</code> (a JVM service) restarts every few hours. The host has 32 GB of RAM and is mostly idle." : "The primary Postgres on this host went into crash recovery at night; every connection was dropped. A nightly ETL job runs on the same host."}</p><p>Use the shell to find out what happened, then pick the root cause.</p>`,
      ...LB.term({
        shell(I) {
          const ts = `[${I.t}]`;
          const dm = I.lv === 1 ? [
            `report-worker invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0`,
            `Mem-Info:`, `active_anon:3021112 inactive_anon:22011 isolated_anon:0 active_file:812 inactive_file:1104 isolated_file:0`,
            `Tasks state (memory values in pages):`, `[  pid  ]   uid  tgid total_vm      rss pgtables_bytes swapents oom_score_adj name`,
            `[    812]     0   812     4210      931    61440        0             0 sshd`, `[   1104]   113  1104   612001    41220   720896        0             0 node_exporter`, `[   1421]   998  1421   811234   112004  1196032        0             0 api`, `[  ${I.pid}]   998 ${I.pid}  3183353  2953011 23973888        0             0 report-worker`,
            `oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/report-worker.service,task=report-worker,pid=${I.pid},uid=998`,
            `Out of memory: Killed process ${I.pid} (report-worker) total-vm:12733412kB, anon-rss:${Math.round(I.rss * 1048576)}kB, file-rss:2048kB, shmem-rss:0kB, UID:998 pgtables:23412kB oom_score_adj:0`,
          ] : I.lv === 2 ? [
            `java invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0`,
            `memory: usage 2097152kB, limit 2097152kB, failcnt 1841`, `swap: usage 0kB, limit 0kB, failcnt 0`,
            `Memory cgroup stats for /system.slice/billing.service:`, `anon 2131214336`, `file 4718592`,
            `oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/system.slice/billing.service,task_memcg=/system.slice/billing.service,task=java,pid=${I.pid},uid=997`,
            `Memory cgroup out of memory: Killed process ${I.pid} (java) total-vm:6011820kB, anon-rss:2081164kB, file-rss:21844kB, shmem-rss:0kB, UID:997 pgtables:5212kB oom_score_adj:0`,
          ] : [
            `etl.py invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0`,
            `Tasks state (memory values in pages):`, `[  pid  ]   uid  tgid total_vm      rss pgtables_bytes swapents oom_score_adj name`,
            `[   1302]   113  1302  2201812    12044   348160        0         -1000 postgres`, `[  ${I.pid}]   113 ${I.pid}  2243511  2150877  4648960        0             0 postgres`, `[  ${I.pid + 911}]  1001 ${I.pid + 911}  2041222  1900310 15532032        0             0 etl.py`,
            `oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/postgresql@16-main.service,task=postgres,pid=${I.pid},uid=113`,
            `Out of memory: Killed process ${I.pid} (postgres) total-vm:8974044kB, anon-rss:401220kB, file-rss:9012kB, shmem-rss:8193276kB, UID:113 pgtables:4540kB oom_score_adj:0`,
          ];
          const sh = K.shell([
            { re: /^(?:dmesg|journalctl -k)(?: .*)?$/, use: "dmesg -T | grep -i -A2 -B2 oom", desc: "kernel log", run: () => dm.map((l) => `${ts} ${l}`).join("\n") },
            { re: /^free(?: -\w+)?$/, use: "free -m", desc: "", run: () => I.lv === 2 ? "               total        used        free      shared  buff/cache   available\nMem:           31812        6210       12011          18       13590       25102\nSwap:              0           0           0" : I.lv === 1 ? "               total        used        free      shared  buff/cache   available\nMem:           15988        2211        9104          12        4672       13401\nSwap:              0           0           0" : "               total        used        free      shared  buff/cache   available\nMem:           31812       10420        1102        8312       20290       12210\nSwap:              0           0           0" },
            { re: /^systemctl cat (\S+?)(?:\.service)?$/, use: "systemctl cat <unit>", desc: "", run: (m) => I.lv === 2 && m[1] === "billing" ? "# /etc/systemd/system/billing.service\n[Service]\nUser=billing\nEnvironment=JAVA_OPTS=-Xms2g -Xmx2g -XX:MaxMetaspaceSize=256m\nExecStart=/opt/billing/bin/billing\nMemoryMax=2G\nRestart=always" : I.lv === 3 && /postgres/.test(m[1]) ? "# /lib/systemd/system/postgresql@.service\n[Service]\nType=forking\nUser=postgres\nExecStart=-/usr/bin/pg_ctlcluster --skip-systemctl-redirect %i start\nOOMScoreAdjust=-900" : `No files found for ${m[1]}.service.` },
            { re: /^systemctl status (\S+)$/, use: "systemctl status <unit>", desc: "", run: (m) => `● ${m[1]}\n     Active: active (running) since Sat 2026-10-11 0${I.lv}:31:02 UTC; 1h ago\n${I.lv === 2 ? "    Process: (previous run) Main process exited, code=killed, status=9/KILL\n      Memory: 1.9G (max: 2.0G available: 98.0M)" : ""}` },
            { re: /^cat \/sys\/fs\/cgroup\/(\S+)\/memory\.(max|events|current)$/, use: "cat /sys/fs/cgroup/<cgroup>/memory.max|memory.events", desc: "cgroup v2 memory files", run: (m) => m[2] === "max" ? (I.lv === 2 && /billing/.test(m[1]) ? "2147483648" : "max") : m[2] === "events" ? (I.lv === 2 && /billing/.test(m[1]) ? "low 0\nhigh 0\nmax 18842\noom 7\noom_kill 7\noom_group_kill 0" : "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0") : (I.lv === 2 ? "2093514752" : "412331008") },
            { re: /^ps (?:aux|-eo \S+)(?: --sort=-?rss)?(?: \| head(?: -n ?\d+| -\d+)?)?$/, use: "ps aux --sort=-rss | head", desc: "processes by resident memory", run: () => I.lv === 3 ? `USER       PID %MEM    RSS COMMAND\npostgres  1302 26.2 8540112 /usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main\npostgres  ${I.pid + 3} 25.8 8402110 postgres: 16/main: app orders 10.0.2.4(51220) idle\netl      ${I.pid + 1400}  2.1 690112 python3 /opt/etl/etl.py --since yesterday` : `USER       PID %MEM    RSS COMMAND\n${I.lv === 2 ? "billing" : "app    "}  ${I.pid + 5} ${I.lv === 2 ? "6.1 1992231 java -Xms2g -Xmx2g -jar /opt/billing/billing.jar" : "1.1 180223 /opt/report-worker/bin/report-worker (restarted 02:44)"}` },
            { re: /^cat \/proc\/(\d+)\/oom_score(?:_adj)?$/, use: "cat /proc/<pid>/oom_score_adj", desc: "", run: (m) => (I.lv === 3 && +m[1] === 1302 ? "-1000" : "0") },
            { re: /^(?:cat \/var\/log\/etl\.log|journalctl -u etl\S*(?: .*)?)$/, use: "journalctl -u etl", desc: "", run: () => I.lv === 3 ? "02:10:01 etl: loading 41,220,118 rows from events into a pandas DataFrame\n02:31:44 etl: merging with customers (left join)\n02:41:12 etl: Killed" : "-- No entries --" },
          ]);
          return { prompt: `root@${I.host}:~#`, init: {}, run: (l, st) => sh.run(l, st), par: 5, motd: I.lv === 3 ? "postgres: LOG:  server process (PID " + I.pid + ") was terminated by signal 9: Killed\npostgres: LOG:  terminating any other active server processes" : "", cmds: ["dmesg -T | grep -i -A2 -B2 oom", "free -m", "ps aux --sort=-rss | head", ...(I.lv === 2 ? ["systemctl cat billing", "cat /sys/fs/cgroup/system.slice/billing.service/memory.events"] : []), ...(I.lv === 3 ? ["journalctl -u etl", "systemctl cat postgresql@16-main"] : [])], opts: I.opts, optq: "Root cause" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["dmesg -T | grep -i -A2 -B2 oom", "free -m", ...(I.lv === 2 ? ["systemctl cat billing"] : I.lv === 3 ? ["journalctl -u etl"] : [])], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["dmesg -T"], pick: (I.ans + 1) % 4 }, { log: ["free -m"], pick: (I.ans + 2) % 4 }],
      hint: (I) => I.lv === 1 ? "The kernel logs every OOM kill. The oom-kill line says whether it was global or a cgroup limit." : I.lv === 2 ? "CONSTRAINT_MEMCG means a cgroup hit its own limit, regardless of free memory on the host." : "The process that grew and the process that got killed can differ. What counts toward a process's RSS?",
      concept: "Reading OOM kills",
      how: "When memory can't be reclaimed the kernel picks a victim by badness: roughly its RSS (anonymous, file-mapped and shared-memory pages) plus swap and page tables, as a share of available memory, adjusted by oom_score_adj (-1000 makes a process immune). A global OOM (CONSTRAINT_NONE) means the whole machine ran out; a cgroup OOM (CONSTRAINT_MEMCG, 'Memory cgroup out of memory') means one cgroup hit memory.max even with free RAM on the host. JVMs need memory beyond -Xmx (metaspace, thread stacks, code cache, direct buffers), so a limit equal to the heap is too small. Shared memory such as Postgres shared_buffers counts in each process's RSS, so a database backend can outscore the process that actually grew.",
      rule: "Read the oom-kill line first: constraint, victim, anon vs shmem RSS. Size cgroup limits at heap plus 25-50%, run batch jobs in their own memory-capped cgroup, and protect critical daemons with OOMScoreAdjust.",
      why: (I) => I.lv === 1 ? `A global OOM (CONSTRAINT_NONE): report-worker's anon-rss reached ${I.rss} GB on a 16 GB host with no limit, and as the largest process it was the victim. Cap it with MemoryMax= so it fails alone and early, and fix its memory use.` : I.lv === 2 ? "CONSTRAINT_MEMCG with oom_memcg=/system.slice/billing.service: the cgroup's 2 GiB limit was hit while the host had 25 GB available. -Xmx2g fills the limit by itself; metaspace, threads and buffers pushed it over. Use MemoryMax around 2.75G or lower the heap (or -XX:MaxRAMPercentage)." : `etl.py loaded 41 million rows into memory; the OOM killer then chose a postgres backend (pid ${I.pid}) whose RSS was 8 GB, almost all shmem-rss: shared_buffers it had touched. The postmaster had -900 via OOMScoreAdjust (shown as -1000 here) but backends reset to 0. Give the ETL its own MemoryMax cgroup or another host.`,
    },
    /* ======================================================================== */
    {
      id: "linux-load-no-cpu",
      name: "Load average 40, CPU idle",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "A backup (tar) is saturating the spinning data disk; other processes wait in D state for I/O", ["Too many runnable threads for 8 CPUs", "The NFS server is unreachable", "Memory pressure: kswapd is thrashing"]);
        else if (lv === 2) o = mkOpts(R, "The hypervisor is taking about half of the CPU time (steal): the vCPUs are runnable but not running", ["Disk I/O wait from the root volume", "The application is spinning in a busy loop", "The load average counts idle threads and can be ignored"]);
        else o = mkOpts(R, "The hard-mounted NFS server stopped responding; tasks blocked on it sit in uninterruptible sleep and count toward load", ["The local data disk is saturated by the backup", "CPU steal from a noisy neighbour", "A kernel lock contention bug; reboot the host"]);
        return { lv, ...o, cores: lv === 1 ? 8 : lv === 2 ? 4 : 32, load: lv === 1 ? R.int(18, 26) : lv === 2 ? R.int(8, 11) : R.int(55, 70), st: R.int(46, 58), host: `${R.pick(["app", "build", "render"])}-${R.int(1, 30)}`, nas: R.pick(["nas01", "filer-2", "nfs-a"]), miss: lv === 2 ? "Read every column of the CPU line, including the last one." : lv === 3 ? "Which wait channel are most of the D-state tasks in? The disk is busy, but is it the reason?" : "Look at the b column of vmstat and at iostat for the busiest device." };
      },
      text: (I) => `<p><b>PAGE:</b> <code>${I.host}</code> (${I.cores} vCPU) shows load average <b>${I.load}</b> and requests are slow, yet the CPU graph says it's ${I.lv === 2 ? "only about 40% busy" : "mostly idle"}. ${I.lv === 3 ? "A nightly backup is also running on the local data disk." : ""}</p><p>Investigate and pick the root cause.</p>`,
      ...LB.term({
        shell(I) {
          const la = `${I.load}.${String(I.load * 7 % 100).padStart(2, "0")}`;
          const top = I.lv === 1 ? `%Cpu(s):  4.1 us,  2.0 sy,  0.0 ni, 28.7 id, 64.9 wa,  0.0 hi,  0.3 si,  0.0 st` : I.lv === 2 ? `%Cpu(s): 31.2 us,  3.1 sy,  0.0 ni, 12.4 id,  0.0 wa,  0.0 hi,  0.4 si, ${I.st}.9 st` : `%Cpu(s):  6.0 us,  2.1 sy,  0.0 ni, 88.6 id,  3.1 wa,  0.0 hi,  0.2 si,  0.0 st`;
          const dlist = I.lv === 1 ? [["D", 2211, "tar", "io_schedule"], ["D", 3012, "php-fpm", "io_schedule"], ["D", 3013, "php-fpm", "io_schedule"], ["D", 3020, "php-fpm", "folio_wait_bit_common"], ["D", 611, "jbd2/sdb1-8", "jbd2_journal_commit_transaction"]] : I.lv === 2 ? [] : [["D", 4120, "render", "rpc_wait_bit_killable"], ["D", 4121, "render", "rpc_wait_bit_killable"], ["D", 4188, "render", "rpc_wait_bit_killable"], ["D", 5102, "rsync", "nfs_wait_bit_killable"], ["D", 2290, "tar", "io_schedule"], ["D", 7781, "df", "rpc_wait_bit_killable"]];
          const sh = K.shell([
            { re: /^(?:uptime|cat \/proc\/loadavg)$/, use: "uptime", desc: "", run: (m, st, l) => l === "uptime" ? ` 03:14:07 up 41 days,  2:11,  1 user,  load average: ${la}, ${I.load - 1}.80, ${I.load - 3}.12` : `${la} ${I.load - 1}.80 ${I.load - 3}.12 ${I.lv === 2 ? 9 : 2}/1834 88211` },
            { re: /^top(?: -\w+)*(?: \| head(?: -n ?\d+| -\d+)?)?$/, use: "top -bn1 | head -15", desc: "", run: () => `top - 03:14:09 up 41 days,  2:11,  1 user,  load average: ${la}, ${I.load - 1}.80, ${I.load - 3}.12\nTasks: 412 total,   ${I.lv === 2 ? 9 : 2} running, ${I.lv === 2 ? 403 : 340} sleeping,   0 stopped,   0 zombie\n${top}\nMiB Mem :  31812.4 total,   2101.2 free,   9120.7 used,  20590.5 buff/cache\n\n    PID USER      PR  NI    VIRT    RES  %CPU  S COMMAND\n${I.lv === 2 ? "   3310 app       20   0 4912334 1.2g   48.2  R java\n   3388 app       20   0 4912334 1.2g   44.9  R java" : I.lv === 1 ? "   2211 backup    20   0   22104   4012   3.1  D tar\n   3012 www-data  20   0  412331  61220   0.7  D php-fpm" : "   4120 render    20   0 2210443 812211   0.0  D render\n   2290 backup    20   0   22104   4012   2.1  D tar"}` },
            { re: /^vmstat(?: \d+)*$/, use: "vmstat 1 5", desc: "r = runnable, b = blocked (D state), wa = iowait, st = steal", run: () => `procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu\n` + [0, 1, 2, 3].map((k) => I.lv === 1 ? ` 1 ${21 + k}      0 2101120  81220 20510332    0    0 ${88120 + k * 311} 2210 3120 5011  4  2 29 65  0  0` : I.lv === 2 ? ` ${9 + (k % 2)}  0      0 2101120  81220 20510332    0    0     4   120 9120 15011 31  3 12  0 ${I.st}  0` : ` 2 ${I.load - 6 + k}      0 2101120  81220 20510332    0    0 41220 1210 2212 4011  6  2 88  3  0  0`).join("\n") },
            { re: /^mpstat(?: -P ALL)?(?: \d+)*$/, use: "mpstat -P ALL 1 1", desc: "per-CPU breakdown", run: () => `03:14:12 AM  CPU    %usr   %sys %iowait  %steal  %idle\n` + Array.from({ length: Math.min(I.cores, 4) }, (_, c) => `03:14:12 AM  ${c}    ${I.lv === 2 ? (30 + c).toFixed(2) : "5.10"}   ${I.lv === 2 ? "3.20" : "2.00"}   ${I.lv === 1 ? "64.00" : I.lv === 3 ? "3.10" : "0.00"}   ${I.lv === 2 ? (I.st - c) + ".40" : "0.00"}   ${I.lv === 2 ? (12 - c) + ".00" : I.lv === 1 ? "28.90" : "89.00"}`).join("\n") + (I.cores > 4 ? `\n…  (${I.cores - 4} more CPUs, similar)` : "") },
            { re: /^iostat(?: -\w+)*(?: \d+)*$/, use: "iostat -x 1 2", desc: "per-device latency and utilisation", run: () => `Device     r/s     w/s   rkB/s   wkB/s  r_await w_await aqu-sz  %util\nnvme0n1   4.0    18.0    96.0   412.0     0.21    0.40   0.01    0.9\n${I.lv === 1 ? "sdb     181.0    22.0 88120.0  2210.0   612.40  141.20  118.4  100.0" : I.lv === 2 ? "sdb       2.0     1.0    64.0    12.0     4.10    3.20   0.01    0.3" : "sdb      92.0    12.0 41220.0  1210.0    11.20    9.80    1.1   72.4"}` },
            { re: /^ps -\w*e\w*o [\w,:]+(?: .*)?$|^ps aux(?: .*)?$/, use: "ps -eo state,pid,comm,wchan:32 | grep '^D'", desc: "tasks in uninterruptible sleep and where they wait", run: () => dlist.length ? K.cols([["S", "PID", "COMMAND", "WCHAN"], ...dlist]) + (I.lv === 3 ? `\n… ${I.load - 8} more render tasks in rpc_wait_bit_killable` : I.lv === 1 ? `\n… ${I.load - 6} more php-fpm tasks in io_schedule` : "") : "S   PID COMMAND WCHAN\n(no tasks in D state)" },
            { re: /^cat \/proc\/(\d+)\/stack$/, use: "cat /proc/<pid>/stack", desc: "kernel stack of a blocked task", run: (m) => { const d = dlist.find((x) => x[1] === +m[1]); if (!d) return `cat: /proc/${m[1]}/stack: No such file or directory`; return /rpc|nfs/.test(d[3]) ? "[<0>] rpc_wait_bit_killable+0x1e/0xa0 [sunrpc]\n[<0>] __rpc_execute+0x10c/0x420 [sunrpc]\n[<0>] rpc_execute+0xd3/0x100 [sunrpc]\n[<0>] nfs4_call_sync_custom+0xb/0x30 [nfsv4]\n[<0>] nfs4_proc_getattr+0x10f/0x150 [nfsv4]\n[<0>] __nfs_revalidate_inode+0xc6/0x2f0 [nfs]\n[<0>] vfs_statx+0x9b/0x140" : "[<0>] io_schedule+0x46/0x70\n[<0>] folio_wait_bit_common+0x13d/0x350\n[<0>] filemap_read+0x1e1/0x340\n[<0>] vfs_read+0x22d/0x350\n[<0>] ksys_read+0x6f/0xf0"; } },
            { re: /^dmesg(?: .*)?$/, use: "dmesg -T | tail", desc: "", run: () => I.lv === 3 ? `[Sat Oct 11 02:58:41 2026] nfs: server ${I.nas} not responding, still trying\n[Sat Oct 11 02:58:41 2026] nfs: server ${I.nas} not responding, still trying\n[Sat Oct 11 03:01:12 2026] INFO: task render:4120 blocked for more than 122 seconds.\n[Sat Oct 11 03:01:12 2026] "echo 0 > /proc/sys/kernel/hung_task_timeout_secs" disables this message.` : "[Sat Oct 11 01:02:11 2026] systemd-journald[402]: Data hash table of /var/log/journal/… has a fill level at 75.0, suggesting rotation." },
            { re: /^(?:findmnt -t nfs4?|mount \| grep nfs|mount -t nfs4?|cat \/proc\/mounts \| grep nfs)$/, use: "findmnt -t nfs4", desc: "", run: () => I.lv === 3 ? `TARGET        SOURCE              FSTYPE OPTIONS\n/mnt/shared   ${I.nas}:/export/shared nfs4   rw,relatime,vers=4.2,rsize=1048576,wsize=1048576,hard,proto=tcp,timeo=600,retrans=2` : "" },
            { re: /^df(?: .*)?$/, use: "df -h", desc: "", run: (m, st, l) => I.lv === 3 && !/-x nfs|-l\b|-t ext4/.test(l) ? "^C\n(df hung: it called statfs() on /mnt/shared and blocked; you pressed Ctrl-C after 30 s)" : K.cols([DFH, ["/dev/nvme0n1p1", "96G", "41G", "51G", "45%", "/"], ["/dev/sdb1", "3.6T", "2.1T", "1.4T", "61%", "/data"]]) },
            { re: /^(?:cat \/sys\/fs\/cgroup\/cpu\.stat|curl -s http:\/\/169\.254\.169\.254\S*)$/, use: "", hidden: true, desc: "", run: () => "" },
          ]);
          return { prompt: `root@${I.host}:~#`, init: {}, run: (l, st) => sh.run(l, st), par: 6, cmds: ["uptime", "top -bn1 | head -15", "vmstat 1 5", "iostat -x 1 2", "ps -eo state,pid,comm,wchan:32 | grep '^D'", "cat /proc/<pid>/stack", "dmesg -T | tail", "df -h"], opts: I.opts, optq: "Root cause" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["uptime", "vmstat 1 5", I.lv === 2 ? "top -bn1 | head -15" : "ps -eo state,pid,comm,wchan:32 | grep '^D'", ...(I.lv === 3 ? ["dmesg -T | tail"] : I.lv === 1 ? ["iostat -x 1 2"] : [])], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["uptime"], pick: (I.ans + 1) % 4 }, { log: ["vmstat 1 5"], pick: (I.ans + 3) % 4 }],
      hint: (I) => I.lv === 1 ? "On Linux the load average counts runnable tasks and tasks in uninterruptible (D) sleep. vmstat's b column counts the latter." : I.lv === 2 ? "'Idle' on a graph often means 'not user time'. Look for the column the graph doesn't show." : "Two suspects. A blocked task's wait channel and kernel stack say what it's waiting for. Careful: some commands will hang on this host.",
      concept: "Load average is not CPU usage",
      how: "Linux load average is an exponentially-damped count of tasks that are runnable or in uninterruptible sleep (D state), usually waiting on disk or network filesystems. So load can be huge on an idle CPU. vmstat splits it: r is runnable, b is blocked. iowait only counts CPU idle time while block I/O is pending, so NFS waits often don't show up there; the wait channel (ps wchan) and /proc/PID/stack tell you where tasks are stuck. On VMs, steal (st) is time the hypervisor gave your vCPU's turn to someone else; dashboards that show only user+system call that idle.",
      rule: "Compare load with vmstat r and b and the full CPU line (wa, st) before blaming CPU. For D-state pileups, read wchan and /proc/PID/stack; on NFS hosts use df -x nfs4 so your own shell doesn't hang too.",
      why: (I) => I.lv === 1 ? `vmstat showed ~21 tasks blocked (b) with 65% iowait, and sdb (a spinning disk) was at 100% util with 600 ms reads and a queue of 118: the tar backup's sequential reads starved php-fpm's random reads. Throttle the backup (ionice -c3, IOReadBandwidthMax=) or move it off-peak.` : I.lv === 2 ? `The run queue (r ≈ 9) exceeded 4 vCPUs while ${I.st}% of time went to steal: the hypervisor wasn't scheduling the vCPUs. On burstable instances that means CPU credits are exhausted; otherwise a noisy neighbour. Move to a non-burstable size or a different host.` : `Dozens of render tasks were stuck in rpc_wait_bit_killable on /mnt/shared, a hard NFS mount (timeo=600), and dmesg said "${esc(I.nas)} not responding". Hard mounts retry forever, so every task touching it, df included, joins the load. The backup on sdb (72% util, 11 ms await) was busy but healthy: a red herring.`,
    },
    /* ======================================================================== */
    {
      id: "linux-zombies-pids",
      name: "Fork fails inside the container",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "PID 1 is node, which never reaps orphaned grandchildren; the zombies fill the container's pids.max. Run it under an init (tini / --init)", ["convert crashes and leaves core dumps behind", "node leaks threads", "The zombies hold memory; the container is out of RAM"]);
        else if (lv === 2) o = mkOpts(R, "worker.py starts subprocesses and never wait()s for them; zombies stay until their parent reaps them or exits", ["There is no init process in the container; add tini", "The zombies hold memory and must be killed with kill -9", "The kernel's pid_max is too low"]);
        else o = mkOpts(R, "A thread leak in the JVM: every thread is a task, and the cgroup's pids.max counts tasks", ["Zombie processes exhausted pids.max", "The Java heap is full", "kernel.pid_max is too low for this host"]);
        return { lv, ...o, z: lv === 1 ? R.int(3800, 4000) : lv === 2 ? R.int(900, 1400) : 3, max: lv === 2 ? 2048 : 4096, thr: R.int(3950, 4030), pod: `${R.pick(["thumbs", "ingest", "pdf"])}-${R.int(5, 9)}c${R.int(10, 99)}f-${R.pick(["x2kq9", "mm7pl", "b8wq1"])}`, miss: lv === 3 ? "Count tasks (threads), not processes." : lv === 2 ? "Who is the zombies' parent? Only the parent (or init, after the parent dies) can reap them." : "Who is PID 1 here, and whose children are the zombies?" };
      },
      text: (I) => `<p><b>PAGE:</b> pod <code>${I.pod}</code> errors with <code>${I.lv === 3 ? "java.lang.OutOfMemoryError: unable to create native thread: possibly out of memory or process/resource limits reached" : "spawn EAGAIN"}</code>${I.lv === 3 ? "" : " when it shells out to an image converter"}. Memory is at 40% of its limit. ${I.lv === 2 ? "The image runs <code>tini</code> as PID 1." : ""}</p><p>You have <code>kubectl exec</code> into the container. Find the cause.</p>`,
      ...LB.term({
        shell(I) {
          const p1 = I.lv === 1 ? "node /app/server.js" : I.lv === 2 ? "/sbin/tini -- python /app/worker.py" : "/sbin/tini -- java -Xmx2g -jar /app/indexer.jar";
          const ps = () => {
            const rows = [["PID", "PPID", "STAT", "ELAPSED", "CMD"], ["1", "0", "Ssl", "3-02:11:41", p1]];
            if (I.lv === 2) rows.push(["7", "1", "Sl", "3-02:11:40", "python /app/worker.py"]);
            if (I.lv === 3) rows.push(["7", "1", "Sl", "3-02:11:40", "java -Xmx2g -jar /app/indexer.jar"]);
            const zp = I.lv === 1 ? "1" : "7", zc = I.lv === 1 ? "[convert] <defunct>" : I.lv === 2 ? "[ffprobe] <defunct>" : "[sh] <defunct>";
            for (let k = 0; k < Math.min(3, I.z); k++) rows.push([String(412 + k * 211), zp, "Z", `2-2${k}:02:10`, zc]);
            rows.push(["9921", "0", "Ss", "00:01:02", "bash"], ["9960", "9921", "R+", "00:00:00", "ps -eo pid,ppid,stat,etime,cmd"]);
            return K.cols(rows) + (I.z > 3 ? `\n… ${I.z - 3} more ${zc} with PPID ${zp}` : "");
          };
          const tasks = I.lv === 3 ? I.max : I.z + (I.lv === 1 ? 14 : 22);
          const sh = K.shell([
            { re: /^ps(?: .*)?$/, use: "ps -eo pid,ppid,stat,etime,cmd", desc: "processes (Z = zombie)", run: (m, st, l) => /-L/.test(l) && /wc -l/.test(l) ? String(tasks + 1) : /grep -c Z|awk.*Z/.test(l) ? String(I.z) : ps() },
            { re: /^cat \/sys\/fs\/cgroup\/pids\.(max|current|events)$/, use: "cat /sys/fs/cgroup/pids.max | pids.current", desc: "the cgroup's task limit and usage", run: (m) => m[1] === "max" ? String(I.max) : m[1] === "current" ? String(tasks) : `max ${I.lv === 3 ? 18211 : 6120}` },
            { re: /^(?:cat \/proc\/1\/cmdline(?: \| tr .*)?|cat \/proc\/1\/comm)$/, use: "cat /proc/1/cmdline | tr '\\0' ' '", desc: "what is PID 1?", run: () => p1 },
            { re: /^(?:grep -i threads|cat) \/proc\/(\d+)\/status(?: \| grep -i threads)?$/, use: "grep -i threads /proc/<pid>/status", desc: "", run: (m) => +m[1] === 7 && I.lv === 3 ? `Threads:\t${I.thr}` : +m[1] === 1 ? `Threads:\t${I.lv === 1 ? 11 : 1}` : +m[1] === 7 ? "Threads:\t4" : `grep: /proc/${m[1]}/status: No such file or directory` },
            { re: /^ps -o nlwp= -p (\d+)$/, use: "ps -o nlwp= -p <pid>", desc: "thread count", run: (m) => (+m[1] === 7 && I.lv === 3 ? String(I.thr) : "4") },
            { re: /^kill (?:-\w+ )?(\d+)$/, use: "kill [-9] <pid>", desc: "", run: (m) => { const z = +m[1] >= 412 && +m[1] < 1100; if (z) return ""; if (+m[1] === 1) return { out: "", danger: "Signalling PID 1 restarts the whole container." }; return { out: "", danger: "Killing the main process restarts the container: mitigation, not diagnosis." }; } },
            { re: /^(?:jstack \d+|jcmd \d+ Thread\.print)(?: \| .*)?$/, use: "jcmd <pid> Thread.print | grep -c 'pool-'", desc: "", run: () => I.lv === 3 ? `"pool-${I.thr - 12}-thread-1" #${I.thr} prio=5 os_prio=0 cpu=0.21ms elapsed=88.10s tid=0x… nid=${I.thr + 3000} waiting on condition\n   java.lang.Thread.State: WAITING (parking)\n… ${I.thr - 40} threads named pool-N-thread-1: one new Executors.newFixedThreadPool(1) per request, never shut down` : "jcmd: command not found" },
            { re: /^(?:tail|cat) (?:-n ?\d+ )?\/app\/logs\/app\.log$/, use: "tail /app/logs/app.log", desc: "", run: () => I.lv === 3 ? "WARN  [http-412] java.lang.OutOfMemoryError: unable to create native thread: possibly out of memory or process/resource limits reached\n\tat java.base/java.lang.Thread.start0(Native Method)\n\tat java.base/java.util.concurrent.ThreadPoolExecutor.addWorker(ThreadPoolExecutor.java:945)" : "Error: spawn EAGAIN\n    at ChildProcess.spawn (node:internal/child_process:421:11)" },
          ]);
          return { prompt: `root@${I.pod}:/app#`, init: {}, run: (l, st) => sh.run(l, st), par: 6, cmds: ["ps -eo pid,ppid,stat,etime,cmd", "cat /proc/1/cmdline | tr '\\0' ' '", "cat /sys/fs/cgroup/pids.max", "cat /sys/fs/cgroup/pids.current", "grep -i threads /proc/<pid>/status", "tail /app/logs/app.log", "kill -9 <pid>"], opts: I.opts, optq: "Root cause" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["ps -eo pid,ppid,stat,etime,cmd", "cat /sys/fs/cgroup/pids.current", ...(I.lv === 3 ? ["grep -i threads /proc/7/status"] : ["cat /proc/1/cmdline | tr '\\0' ' '"])], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["ps -eo pid,ppid,stat,etime,cmd"], pick: (I.ans + 1) % 4 }, { log: [], pick: (I.ans + 2) % 4 }],
      hint: (I) => I.lv === 1 ? "A zombie is a finished process whose parent hasn't called wait(). When a parent dies, its children are re-parented to PID 1." : I.lv === 2 ? "kill -9 on a zombie does nothing: it's already dead. Look at the PPID column." : "pids.max limits tasks: processes and threads alike.",
      concept: "Zombies, PID 1 and pids.max",
      how: "A process that exits stays as a zombie (state Z) until its parent reads its exit status with wait(). Zombies use no memory but each holds a PID, and in a container every task (process or thread) counts against the cgroup's pids.max, after which fork() and thread creation fail with EAGAIN. Orphans are re-parented to PID 1, and a normal init reaps them; an application running as PID 1 usually doesn't. kill -9 can't remove a zombie: only its parent can, or init after the parent exits. Threads are tasks too, so a thread leak hits the same limit.",
      rule: "Run containers with a real init (tini, dumb-init or --init / shareProcessNamespace) when the app spawns processes, always wait() for children, and watch pids.current against pids.max.",
      why: (I) => I.lv === 1 ? `node was PID 1. The converter ran via a shell that exited first, so each convert process was re-parented to PID 1 and, because node only reaps children it spawned itself, became one of ${K.num(I.z)} zombies until pids.max (${I.max}) was hit.` : I.lv === 2 ? `tini was PID 1 and fine; the ${K.num(I.z)} zombies all had PPID 7, worker.py, which starts ffprobe with subprocess.Popen and never calls wait()/communicate(). Fix the code (or use subprocess.run); restarting the worker lets tini reap them.` : `Only 3 zombies (a red herring). The JVM (PID 7) had ${K.num(I.thr)} threads: a new single-thread pool per request, never shut down. Threads are tasks, so pids.current hit pids.max (${I.max}) and Thread.start failed.`,
    },
    /* ======================================================================== */
    {
      id: "linux-port-in-use",
      name: "Address already in use",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        const port = R.pick([8080, 8443, 9000, 3000]), svc = R.pick(["api", "web", "ledger"]);
        return { lv, port, svc, hp: R.int(2000, 60000), old: R.int(60, 1999), host: `${svc}-${R.int(1, 12)}` };
      },
      text: (I) => `<p><b>PAGE:</b> after a routine deploy on <code>${I.host}</code>, <code>${I.svc}.service</code> won't start: <code>listen tcp :${I.port}: bind: address already in use</code>. ${I.lv === 3 ? "This host was converted from an older setup last quarter." : I.lv === 2 ? "The previous version used to transcode media by spawning ffmpeg." : ""}</p><p>Free the port with the least collateral damage and get <code>${I.svc}</code> running${I.lv === 3 ? " in a way that survives a reboot" : ""}.</p>`,
      ...LB.term({
        shell(I) {
          const S = I.svc, P = I.port;
          const holder = I.lv === 1 ? { cmd: S, pid: I.hp, ppid: I.hp - 3, fd: 3, user: "deploy", line: `./${S} --port ${P}`, etime: "3-04:11:02", parent: `tmux: server` } : I.lv === 2 ? { cmd: "ffmpeg", pid: I.hp, ppid: 1, fd: 3, user: S, line: `ffmpeg -i /srv/media/in/a81c.mov -c:v libx264 /srv/media/out/a81c.mp4`, etime: "06:02:44", parent: "systemd" } : { cmd: "systemd", pid: 1, ppid: 0, fd: 61, user: "root", line: "/sbin/init", etime: "41-02:12:09", parent: "" };
          const listen = (st) => (st.free ? (st.running ? [["LISTEN", "0", "4096", `*:${P}`, "*:*", `users:(("${S}",pid=${I.hp + 900},fd=7))`]] : []) : [["LISTEN", "0", "4096", `0.0.0.0:${P}`, "0.0.0.0:*", `users:(("${holder.cmd}",pid=${holder.pid},fd=${holder.fd}))`]]);
          const free = (st) => { st.free = true; };
          const sh = K.shell([
            { re: /^ss -\w*l\w*(?: .*)?$/, use: `ss -ltnp 'sport = :${P}'`, desc: "listening sockets and their owners", run: (m, st) => K.cols([["State", "Recv-Q", "Send-Q", "Local Address:Port", "Peer Address:Port", "Process"], ["LISTEN", "0", "4096", "127.0.0.53%lo:53", "0.0.0.0:*", `users:(("systemd-resolve",pid=611,fd=14))`], ["LISTEN", "0", "128", "0.0.0.0:22", "0.0.0.0:*", `users:(("sshd",pid=902,fd=3))`], ...listen(st)]) },
            { re: /^lsof (?:-\w+ )*-i ?(?:TCP)?:(\d+)(?: -\w+(?::\w+)?)*$/, use: `lsof -nP -iTCP:${P} -sTCP:LISTEN`, desc: "", run: (m, st) => +m[1] !== P || st.free ? "" : K.cols([["COMMAND", "PID", "USER", "FD", "TYPE", "DEVICE", "SIZE/OFF", "NODE", "NAME"], [holder.cmd, holder.pid, holder.user, holder.fd + "u", "IPv4", "88211", "0t0", "TCP", `*:${P} (LISTEN)`]]) },
            { re: /^ps(?: .*)?$/, use: "ps -o pid,ppid,user,etime,cmd -p <pid>", desc: "", run: (m, st, l) => { const pm = l.match(/-p ?(\d+)/), pid = pm ? +pm[1] : 0; if (pid && pid !== holder.pid && pid !== holder.ppid) return "    PID    PPID USER     ELAPSED CMD"; const rows = [["PID", "PPID", "USER", "ELAPSED", "CMD"], [holder.pid, holder.ppid, holder.user, holder.etime, holder.line]]; if (holder.parent && (!pid || pid === holder.ppid)) rows.push([holder.ppid, 1, holder.user, holder.etime, holder.parent]); return K.cols(rows); } },
            { re: new RegExp(`^(?:systemctl status ${S}(?:\\.service)?|journalctl -u ${S}(?:\\.service)?(?: .*)?)$`), use: `journalctl -u ${S} -n 10`, desc: "", run: (m, st) => st.running ? `● ${S}.service\n     Active: active (running)` : `Oct 11 03:02:11 ${I.host} ${S}[${I.hp + 41}]: listen tcp :${P}: bind: address already in use\nOct 11 03:02:11 ${I.host} systemd[1]: ${S}.service: Main process exited, code=exited, status=1/FAILURE\nOct 11 03:02:11 ${I.host} systemd[1]: ${S}.service: Failed with result 'exit-code'.` },
            { re: /^systemctl (?:list-sockets|list-units --type=socket)(?: --all)?$/, use: "systemctl list-sockets", desc: "sockets systemd itself listens on", run: (m, st) => K.cols([["LISTEN", "UNIT", "ACTIVATES"], ["/run/dbus/system_bus_socket", "dbus.socket", "dbus.service"], ["/run/systemd/journal/stdout", "systemd-journald.socket", "systemd-journald.service"], ...(I.lv === 3 && !st.free ? [[`[::]:${P}`, `legacy-${S}.socket`, `legacy-${S}.service`]] : [])]) },
            { re: /^systemctl cat (\S+)$/, use: "systemctl cat <unit>", desc: "", run: (m) => I.lv === 3 && /legacy/.test(m[1]) ? `# /etc/systemd/system/legacy-${S}.socket\n[Socket]\nListenStream=${P}\n\n[Install]\nWantedBy=sockets.target` : `# /etc/systemd/system/${S}.service\n[Service]\nExecStart=/opt/${S}/bin/${S} --port ${P}\nRestart=on-failure` },
            { re: new RegExp(`^systemctl (start|restart) ${S}(?:\\.service)?$`), use: `systemctl start ${S}`, desc: "", run: (m, st) => { if (!st.free) return `Job for ${S}.service failed because the control process exited with error code.\nSee "systemctl status ${S}.service" and "journalctl -xeu ${S}.service" for details.`; st.running = true; return ""; } },
            { re: /^systemctl (stop|disable(?: --now)?|mask(?: --now)?) (legacy-\S+?)(?:\.socket)?$/, use: "systemctl stop|disable --now <unit>", desc: "", run: (m, st) => { if (I.lv !== 3 || m[2] !== `legacy-${S}`) return `Failed to ${m[1].split(" ")[0]} ${m[2]}: Unit ${m[2]} not loaded.`; const v = m[1]; if (/stop|--now/.test(v)) free(st); if (/disable|mask/.test(v)) { st.disabled = true; return `Removed "/etc/systemd/system/sockets.target.wants/legacy-${S}.socket".`; } return ""; } },
            { re: /^kill (-9|-KILL|-15|-TERM|-HUP)? ?(\d+)$/, use: "kill [-9] <pid>", desc: "", run: (m, st) => {
              const pid = +m[2];
              if (pid === 1) { st.broke = "You signalled PID 1 (systemd). SIGTERM to systemd is ignored at best; SIGKILL to init panics the kernel."; return { out: "", danger: "Signalled init." }; }
              if (pid !== holder.pid && pid !== holder.ppid) return `bash: kill: (${pid}) - No such process`;
              if (I.lv === 1 && pid === holder.ppid) { st.broke = "That was the tmux server: you killed every session in it, including a colleague's running database migration shell."; return { out: "", danger: "Killed an unrelated parent process." }; }
              free(st);
              return /9|KILL/.test(m[1] || "") ? { out: "", danger: "SIGKILL first gives the process no chance to finish in-flight work or clean up. Try SIGTERM and wait." } : "";
            } },
            { re: /^fuser -k (\d+)\/tcp$/, use: "fuser -k <port>/tcp", desc: "kill whatever holds a port", run: (m, st) => { if (+m[1] !== P) return ""; if (I.lv === 3) { st.broke = "fuser -k sent SIGKILL to the holder of the port, which was PID 1. The host panicked and rebooted."; return { out: `${P}/tcp:                  1`, danger: "SIGKILLed init." }; } free(st); return { out: `${P}/tcp:             ${holder.pid}`, danger: "fuser -k sends SIGKILL to every process using the port, without checking what they are." }; } },
          ]);
          return { prompt: `root@${I.host}:~#`, init: { free: false, running: false, disabled: false, broke: null }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 6 : 5, cmds: [`journalctl -u ${S} -n 10`, `ss -ltnp 'sport = :${P}'`, "ps -o pid,ppid,user,etime,cmd -p <pid>", "kill <pid>", `systemctl start ${S}`, ...(I.lv === 3 ? ["systemctl list-sockets", "systemctl disable --now <unit>"] : [])] };
        },
        goal(st, I) {
          if (st.broke) return st.broke;
          if (!st.running) return `${I.svc} isn't running yet.`;
          if (I.lv === 3 && !st.disabled) return `${I.svc} is up, but legacy-${I.svc}.socket is still enabled: after the next reboot systemd grabs :${I.port} again before ${I.svc} starts.`;
          return true;
        },
        solve: (I) => I.lv === 3 ? { log: [`ss -ltnp 'sport = :${I.port}'`, "systemctl list-sockets", `systemctl disable --now legacy-${I.svc}.socket`, `systemctl start ${I.svc}`] } : { log: [`ss -ltnp 'sport = :${I.port}'`, `ps -o pid,ppid,user,etime,cmd -p ${I.hp}`, `kill ${I.hp}`, `systemctl start ${I.svc}`] },
      }),
      bad: (I) => I.lv === 3 ? [{ log: [`fuser -k ${I.port}/tcp`, `systemctl start ${I.svc}`] }, { log: [`systemctl stop legacy-${I.svc}.socket`, `systemctl start ${I.svc}`] }, { log: [`systemctl restart ${I.svc}`] }] : I.lv === 1 ? [{ log: [`kill ${I.hp - 3}`, `systemctl start ${I.svc}`] }, { log: [`systemctl restart ${I.svc}`] }] : [{ log: [`systemctl restart ${I.svc}`] }],
      hint: (I) => I.lv === 1 ? "ss -ltnp shows the process holding a listening socket. Check what it is (and what its parent is) before killing anything." : I.lv === 2 ? "A child process inherits its parent's open sockets unless they're close-on-exec. The holder may not be the process you expect." : "If the process holding the port is systemd itself, it's listening on behalf of a socket unit.",
      concept: "Who holds the port",
      how: "Only one socket can listen on an address:port (without SO_REUSEPORT), so bind() fails with EADDRINUSE while anything else holds it. ss -ltnp (or lsof -iTCP:PORT -sTCP:LISTEN) names the owning process and fd. Usual culprits: a stale instance someone started by hand, a child process that inherited the listening socket because it wasn't opened close-on-exec (it survives its parent), or systemd itself holding the socket for a socket-activated unit. Prefer SIGTERM to SIGKILL, and never fuser -k blindly: it SIGKILLs whatever holds the port.",
      rule: "Identify the holder (and its parent) with ss -ltnp before killing anything; stop socket units with systemctl, not kill; open listeners with CLOEXEC so children can't inherit them.",
      why: (I) => I.lv === 1 ? `PID ${I.hp} was a copy of ${esc(I.svc)} a developer had started by hand inside tmux three days ago. SIGTERM let it exit cleanly and the unit started. Killing its parent would have taken down the whole tmux server.` : I.lv === 2 ? `An ffmpeg (PID ${I.hp}, PPID 1) spawned by the old ${esc(I.svc)} inherited its listening socket as fd 3 and outlived it. Until it exited, nobody else could bind :${I.port}. The fix in code is SOCK_CLOEXEC on the listener.` : `PID 1 holding :${I.port} meant systemd listening for legacy-${esc(I.svc)}.socket, left enabled from the old setup. disable --now stops it and removes it from sockets.target, so it won't grab the port at boot.`,
    },
    /* ======================================================================== */
    {
      id: "linux-systemd-restart-loop",
      name: "Service stuck in a restart loop",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) { return { lv, svc: R.pick(["orders", "invoicer", "matcher", "relay"]), pid: R.int(3000, 40000), host: `${R.pick(["svc", "core", "app"])}-${R.int(1, 20)}` }; },
      text: (I) => `<p><b>PAGE:</b> <code>${I.svc}.service</code> on <code>${I.host}</code> is down after this morning's deploy. ${I.lv === 3 ? "It starts, runs for a minute or two under load, then dies." : "systemd keeps restarting it and has now given up."} The deploy ${I.lv === 1 ? "moved its config files into a new directory layout" : I.lv === 2 ? "unpacked a new release tarball into /opt" : "raised the JVM heap from 768m to 1g for a new cache"}.</p><p>Find the cause in the logs, fix it on the host, and get the service running.</p>`,
      ...LB.term({
        shell(I) {
          const S = I.svc;
          const bin = `/opt/${S}/bin/${S}`;
          const unit = (st) => `# /etc/systemd/system/${S}.service\n[Unit]\nDescription=${S}\nAfter=network-online.target\n\n[Service]\nUser=${S}\n${I.lv === 1 ? `EnvironmentFile=-/etc/${S}/${S}.env\n` : ""}${I.lv === 3 ? `Environment=JAVA_OPTS=-Xms1g -Xmx1g\nMemoryMax=${st.mem}\n` : ""}ExecStart=${I.lv === 3 ? `/usr/bin/java $JAVA_OPTS -jar /opt/${S}/${S}.jar` : bin}\nRestart=always\nRestartSec=2\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Install]\nWantedBy=multi-user.target`;
          const errLines = (pid) => I.lv === 1 ? [`${S}[${pid}]: time=2026-10-11T08:02:11Z level=FATAL msg="config: DATABASE_URL is not set"`, `systemd[1]: ${S}.service: Main process exited, code=exited, status=1/FAILURE`, `systemd[1]: ${S}.service: Failed with result 'exit-code'.`] : I.lv === 2 ? [`systemd[1]: Started ${S}.service - ${S}.`, `(${S})[${pid}]: ${S}.service: Unable to locate executable '${bin}': Permission denied`, `(${S})[${pid}]: ${S}.service: Failed at step EXEC spawning ${bin}: Permission denied`, `systemd[1]: ${S}.service: Main process exited, code=exited, status=203/EXEC`, `systemd[1]: ${S}.service: Failed with result 'exit-code'.`] : [`${S}[${pid}]: INFO  Warming cache: 412,000 entries`, `systemd[1]: ${S}.service: A process of this unit has been killed by the OOM killer.`, `systemd[1]: ${S}.service: Main process exited, code=killed, status=9/KILL`, `systemd[1]: ${S}.service: Failed with result 'oom-kill'.`];
          const journal = (st) => {
            if (st.running) return `Oct 11 08:41:02 ${I.host} systemd[1]: Started ${S}.service - ${S}.\nOct 11 08:41:03 ${I.host} ${S}[${I.pid + 99}]: listening on :8080`;
            const out = [];
            if (I.lv === 2) out.push(`${S}[${I.pid - 40}]: WARN config key "http.timeout" is deprecated, use "http.read_timeout"`);
            for (let k = 0; k < 2; k++) errLines(I.pid + k * 3).forEach((l) => out.push(l));
            out.push(`systemd[1]: ${S}.service: Scheduled restart job, restart counter is at 5.`, `systemd[1]: ${S}.service: Start request repeated too quickly.`, `systemd[1]: ${S}.service: Failed with result 'start-limit-hit'.`, `systemd[1]: Failed to start ${S}.service - ${S}.`);
            return out.map((l, k) => `Oct 11 08:0${2 + Math.floor(k / 4)}:${String(11 + k * 2).padStart(2, "0")} ${I.host} ${l}`).join("\n");
          };
          const fixed = (st) => I.lv === 1 ? st.envOk : I.lv === 2 ? st.execOk : st.memOk;
          const start = (st) => {
            if (st.limit) return `Job for ${S}.service failed because start of the service was attempted too often.\nSee "systemctl status ${S}.service" and "journalctl -xeu ${S}.service" for details.\nTo force a start use "systemctl reset-failed ${S}.service",\nfollowed by "systemctl start ${S}.service" again.`;
            if (fixed(st)) { st.running = true; return st.pendingWarn ? reloadWarn(S) : ""; }
            st.limit = true; return st.pendingWarn ? reloadWarn(S) : "";
          };
          const sh = K.shell([
            { re: new RegExp(`^systemctl status ${S}(?:\\.service)?(?: --no-pager)?$`), use: `systemctl status ${S}`, desc: "", run: (m, st) => `${st.running ? "●" : "×"} ${S}.service - ${S}\n     Loaded: loaded (/etc/systemd/system/${S}.service; enabled; preset: enabled)${st.dropMem ? `\n    Drop-In: /etc/systemd/system.control/${S}.service.d\n             └─50-MemoryMax.conf` : ""}\n     Active: ${st.running ? "active (running) since Sat 2026-10-11 08:41:02 UTC; 5s ago" : st.limit ? `failed (Result: ${I.lv === 3 ? "oom-kill" : "start-limit-hit"}) since Sat 2026-10-11 08:03:01 UTC; 38min ago` : "activating (auto-restart)"}\n${st.running ? `   Main PID: ${I.pid + 99} (${I.lv === 3 ? "java" : S})` : `    Process: ${I.pid + 3} ExecStart=${I.lv === 3 ? "/usr/bin/java $JAVA_OPTS -jar /opt/" + S + "/" + S + ".jar" : bin} (code=${I.lv === 3 ? "killed, signal=KILL" : `exited, status=${I.lv === 2 ? "203/EXEC" : "1/FAILURE"}`})`}` },
            { re: new RegExp(`^journalctl (?:(?:-xe|-x|-e|--no-pager|-n ?\\d+|-b) )*-[xe]*u ?${S}(?:\\.service)?(?: (?:-n ?\\d+|--no-pager|-e|-b|--since \\S+))*$`), use: `journalctl -u ${S} -n 30 --no-pager`, desc: "the unit's log", run: (m, st) => journal(st) },
            { re: new RegExp(`^systemctl cat ${S}(?:\\.service)?$`), use: `systemctl cat ${S}`, desc: "unit file", run: (m, st) => unit(st) },
            { re: /^ls (?:-\w+ )*(\S+)$/, use: "ls -l <path>", desc: "", run: (m, st) => {
              const p = m[1].replace(/\/$/, "");
              if (p === `/etc/${S}`) return `total 8\n-rw-r----- 1 root ${S} 412 Oct 11 07:58 ${st.envOk ? S + ".env" : "app.env"}\n-rw-r--r-- 1 root root 1210 Oct 11 07:58 logging.yaml`;
              if (p === bin || p === `/opt/${S}/bin`) return `-rw${st.execOk ? "xr-xr-x" : "-r--r--"} 1 root root 31842112 Oct 11 07:58 ${bin}`;
              if (p === `/etc/default/${S}`) return `ls: cannot access '${p}': No such file or directory`;
              return `ls: cannot access '${p}': No such file or directory`;
            } },
            { re: /^cat (\/etc\/\S+)$/, use: "cat <file>", desc: "", run: (m, st) => m[1] === `/etc/${S}/app.env` && !st.envOk ? `DATABASE_URL=postgres://${S}@db-1.internal:5432/${S}\nREDIS_URL=redis://cache-1.internal:6379/0\nLOG_LEVEL=info` : m[1] === `/etc/${S}/${S}.env` && st.envOk ? `DATABASE_URL=postgres://${S}@db-1.internal:5432/${S}\nREDIS_URL=redis://cache-1.internal:6379/0\nLOG_LEVEL=info` : `cat: ${m[1]}: No such file or directory` },
            { re: /^(mv|cp|ln -s) (\S+) (\S+)$/, use: "mv <src> <dst>", desc: "", run: (m, st) => { if (I.lv === 1 && m[2] === `/etc/${S}/app.env` && m[3] === `/etc/${S}/${S}.env`) { st.envOk = true; return ""; } return `${m[1].split(" ")[0]}: cannot stat '${m[2]}': No such file or directory`; } },
            { re: /^chmod (\S+) (\S+)$/, use: "chmod <mode> <file>", desc: "", run: (m, st) => { if (m[2] !== bin) return `chmod: cannot access '${m[2]}': No such file or directory`; const md = m[1]; if (/^(a|o|ugo|go|)\+[rwx]*x/.test(md) || /^0?[0-7][0-7][1357]$/.test(md)) { st.execOk = true; if (/^0?7?77$|^0?777$|o\+w|a\+w/.test(md)) return { out: "", danger: "World-writable executable: any local user can replace what this service runs." }; return ""; } return ""; } },
            { re: /^systemctl set-property (\S+?)(?:\.service)? (.+)$/, use: `systemctl set-property ${S}.service MemoryMax=<size>`, desc: "change a resource-control setting (applies live and persists)", run: (m, st) => { if (m[1] !== S) return `Failed to set unit properties on ${m[1]}.service: Unit ${m[1]}.service not found.`; const mm = m[2].match(/MemoryMax=(\S+)/); if (!mm) return "(this sandbox only models MemoryMax here)"; const v = mm[1]; st.mem = v; st.dropMem = true; const mb = /^infinity$/i.test(v) ? Infinity : parseFloat(v) * (/G$/i.test(v) ? 1024 : /M$/i.test(v) ? 1 : 1 / 1048576); st.memOk = mb >= 1536 && mb <= 4096; st.memInf = !Number.isFinite(mb); return ""; } },
            { re: /^systemctl daemon-reload$/, use: "systemctl daemon-reload", desc: "", run: (m, st) => { st.pendingWarn = false; return ""; } },
            { re: new RegExp(`^systemctl reset-failed ${S}(?:\\.service)?$`), use: `systemctl reset-failed ${S}`, desc: "clear the failed state and the start-rate counter", run: (m, st) => { st.limit = false; return ""; } },
            { re: new RegExp(`^systemctl (start|restart) ${S}(?:\\.service)?$`), use: `systemctl start ${S}`, desc: "", run: (m, st) => start(st) },
            { re: /^free -\w+$/, use: "free -m", desc: "", run: () => "               total        used        free      shared  buff/cache   available\nMem:            7940        2110        3012          10        2818        5530\nSwap:              0           0           0" },
          ]);
          return { prompt: `root@${I.host}:~#`, init: { limit: true, running: false, envOk: false, execOk: false, memOk: false, mem: "1G", pendingWarn: false }, run: (l, st) => sh.run(l, st), par: 7, motd: `${S}.service: Failed with result '${I.lv === 3 ? "oom-kill" : "start-limit-hit"}'.`, cmds: [`systemctl status ${S}`, `journalctl -u ${S} -n 30 --no-pager`, `systemctl cat ${S}`, "ls -l <path>", `systemctl reset-failed ${S}`, `systemctl start ${S}`, ...(I.lv === 3 ? [`systemctl set-property ${S}.service MemoryMax=<size>`] : [])] };
        },
        goal(st, I) {
          if (I.lv === 3 && st.memInf) return "MemoryMax=infinity removes the guard entirely: the next leak takes the whole host down instead of one service. Size the limit for heap plus JVM overhead.";
          if (!st.running) return st.limit && (I.lv === 1 ? st.envOk : I.lv === 2 ? st.execOk : st.memOk) ? "The cause is fixed, but systemd still refuses to start the unit: it hit its start rate limit (start-limit-hit). Clear that first." : `${I.svc} still isn't running.`;
          return true;
        },
        solve: (I) => ({ log: [`systemctl status ${I.svc}`, `journalctl -u ${I.svc} -n 30 --no-pager`, ...(I.lv === 1 ? [`systemctl cat ${I.svc}`, `ls -l /etc/${I.svc}`, `mv /etc/${I.svc}/app.env /etc/${I.svc}/${I.svc}.env`] : I.lv === 2 ? [`ls -l /opt/${I.svc}/bin/${I.svc}`, `chmod 755 /opt/${I.svc}/bin/${I.svc}`] : [`systemctl cat ${I.svc}`, `systemctl set-property ${I.svc}.service MemoryMax=1536M`]), `systemctl reset-failed ${I.svc}`, `systemctl start ${I.svc}`] }),
      }),
      bad: (I) => [{ log: [`systemctl restart ${I.svc}`] }, I.lv === 1 ? { log: [`mv /etc/${I.svc}/app.env /etc/${I.svc}/${I.svc}.env`, `systemctl start ${I.svc}`] } : I.lv === 2 ? { log: [`chmod u+x /opt/${I.svc}/bin/${I.svc}`, `systemctl reset-failed ${I.svc}`, `systemctl start ${I.svc}`] } : { log: [`systemctl set-property ${I.svc}.service MemoryMax=infinity`, `systemctl reset-failed ${I.svc}`, `systemctl start ${I.svc}`] }],
      hint: (I) => I.lv === 1 ? "The app says a variable is missing. Where does the unit load its environment from, and does that file exist? Note the '-' prefix." : I.lv === 2 ? "status=203/EXEC means systemd couldn't execute the binary at all. Check its mode and owner against User=." : "Result 'oom-kill' plus MemoryMax: what does a JVM need beyond its heap?",
      concept: "Debugging systemd restart loops",
      how: "systemctl status shows the last result and exit code; journalctl -u UNIT shows the program's own output plus systemd's messages. Exit codes 200-243 are systemd's own failures before or while starting the program (203/EXEC: couldn't execute the binary). A '-' before EnvironmentFile= makes a missing file silently ignored. Restart=always retries, and after StartLimitBurst starts within StartLimitIntervalSec the unit enters start-limit-hit and even a manual start is refused until systemctl reset-failed. Unit file edits need daemon-reload; systemctl set-property applies resource limits live and persists them.",
      rule: "Read journalctl -u for the first real error (not the last line), fix that, then reset-failed and start. Don't drop the '-' guard or limits to silence errors; make the config correct.",
      why: (I) => I.lv === 1 ? `EnvironmentFile=-/etc/${I.svc}/${I.svc}.env pointed at a file the deploy had named app.env; the '-' made systemd ignore the missing file, so the app started without DATABASE_URL and exited 1. After the rename, reset-failed cleared start-limit-hit.` : I.lv === 2 ? `The new binary was unpacked as root:root mode 644, and the unit runs as User=${esc(I.svc)}, so exec failed (203/EXEC). chmod u+x wouldn't help: the service user isn't the owner. The deprecation warning was noise.` : `MemoryMax=1G equalled the new -Xmx1g heap; with metaspace, threads and code cache the JVM crossed the limit under load and the cgroup OOM killer ended it. MemoryMax around 1.5G (heap + ~50%) fixes it without removing the guard.`,
    },
    /* ======================================================================== */
    {
      id: "linux-conntrack-full",
      name: "Conntrack table full, dropping packets",
      kind: "Incident",
      skills: ["diagnose", "tune", "safe"],
      gen(lv, R) {
        const max = lv === 3 ? 262144 : 65536;
        return { lv, max, active: lv === 3 ? R.int(35, 45) * 1000 : R.int(52, 60) * 1000, aband: R.int(25, 40) / 10, host: `${R.pick(["lb", "nat", "edge"])}-${R.int(1, 9)}` };
      },
      text: (I) => `<p><b>PAGE:</b> clients of <code>${I.host}</code> see random connection timeouts; retries usually work. ${I.lv >= 2 ? "This host is rebuilt from its image every Sunday and reboots for patching monthly." : ""} ${I.lv === 3 ? "The table was already doubled once last quarter; it filled again within days." : ""}</p><p>Stop the drops now${I.lv >= 2 ? ", make the fix survive a reboot" : ""}${I.lv === 3 ? ", and size it so it won't refill (memory budget: at most 1,048,576 entries)" : ""}. Don't break existing connections.</p>`,
      ...LB.term({
        shell(I) {
          const proj = (st) => I.active + (I.lv === 3 ? Math.min(I.aband * st.est, 5e6) : 0);
          const count = (st) => Math.min(st.max, Math.round(I.lv === 3 ? Math.max(proj(st), st.flushed ? 0 : I.max) : I.active * 1.25));
          const keys = { "net.netfilter.nf_conntrack_max": "max", "net.nf_conntrack_max": "max", "net.netfilter.nf_conntrack_tcp_timeout_established": "est" };
          const sh = K.shell([
            { re: /^dmesg(?: .*)?$|^journalctl -k(?: .*)?$/, use: "dmesg -T | tail", desc: "", run: (m, st) => count(st) >= st.max ? Array.from({ length: 4 }, (_, k) => `[Sat Oct 11 03:1${k}:0${k} 2026] nf_conntrack: nf_conntrack: table full, dropping packet`).join("\n") + "\n[Sat Oct 11 03:14:22 2026] net_ratelimit: 1412 callbacks suppressed" : "[Sat Oct 11 03:20:41 2026] (no new messages)" },
            { re: /^cat \/proc\/sys\/net\/netfilter\/nf_conntrack_(count|max)$/, use: "cat /proc/sys/net/netfilter/nf_conntrack_count", desc: "", run: (m, st) => String(m[1] === "count" ? count(st) : st.max) },
            { re: /^sysctl ([\w.]+)$/, use: "sysctl <key>", desc: "read a kernel setting", run: (m, st) => { const k = m[1]; if (k.endsWith("nf_conntrack_count")) return `${k} = ${count(st)}`; if (keys[k]) return `${k} = ${st[keys[k]]}`; if (k === "net.netfilter.nf_conntrack_buckets") return `${k} = ${Math.max(16384, I.max / 4)}`; return `sysctl: cannot stat /proc/sys/${k.replace(/\./g, "/")}: No such file or directory`; } },
            { re: /^sysctl -w ([\w.]+)=(\d+)$/, use: "sysctl -w <key>=<value>", desc: "change it live (lost on reboot)", run: (m, st) => { const k = m[1]; if (!keys[k]) return `sysctl: cannot stat /proc/sys/${k.replace(/\./g, "/")}: No such file or directory`; st[keys[k]] = +m[2]; st.live[keys[k]] = +m[2]; return `${k} = ${m[2]}`; } },
            { re: /^conntrack -S$/, use: "conntrack -S", desc: "per-CPU conntrack statistics", run: (m, st) => [0, 1, 2, 3].map((c) => `cpu=${c}   \tfound=${12 + c} invalid=${211 + c * 7} insert=0 insert_failed=${count(st) >= st.max ? 8120 + c * 311 : 0} drop=${count(st) >= st.max ? 8120 + c * 311 : 0} early_drop=${count(st) >= st.max ? 410 + c : 0} error=2 search_restart=${120 + c}`).join("\n") },
            { re: /^conntrack -C$/, use: "conntrack -C", desc: "count entries", run: (m, st) => String(count(st)) },
            { re: /^conntrack -L.*(?:uniq -c|wc -l).*$/, use: "conntrack -L -p tcp | awk '{print $4}' | sort | uniq -c", desc: "entries by TCP state", run: (m, st) => { const c = count(st); const est = I.lv === 3 ? Math.round(c * 0.86) : Math.round(c * 0.41); const tw = I.lv === 3 ? Math.round(c * 0.09) : Math.round(c * 0.47); return `conntrack v1.4.8 (conntrack-tools): ${c} flow entries have been shown.\n${String(tw).padStart(7)} TIME_WAIT\n${String(est).padStart(7)} ESTABLISHED\n${String(Math.round(c * 0.03)).padStart(7)} SYN_SENT\n${String(c - est - tw - Math.round(c * 0.03)).padStart(7)} CLOSE`; } },
            { re: /^conntrack -L(?: -p tcp)?(?: \| head(?: -n ?\d+| -\d+)?)?$/, use: "conntrack -L | head", desc: "", run: (m, st) => `tcp      6 ${I.lv === 3 ? 401233 : 118} ESTABLISHED src=100.64.${12}.${40} dst=10.0.1.10 sport=51211 dport=443 src=10.0.1.10 dst=100.64.12.40 sport=443 dport=51211 [ASSURED] mark=0 use=1\ntcp      6 ${I.lv === 3 ? 388012 : 97} ESTABLISHED src=100.71.3.9 dst=10.0.1.10 sport=40102 dport=443 src=10.0.1.10 dst=100.71.3.9 sport=443 dport=40102 [ASSURED] mark=0 use=1\ntcp      6 31 TIME_WAIT src=100.66.1.2 dst=10.0.1.10 sport=33010 dport=443 src=10.0.1.10 dst=100.66.1.2 sport=443 dport=33010 [ASSURED] mark=0 use=1\nconntrack v1.4.8 (conntrack-tools): ${count(st)} flow entries have been shown.` },
            { re: /^conntrack -F$/, use: "conntrack -F", desc: "flush the table", run: (m, st) => { st.flushed = true; st.broke = "Flushing conntrack dropped the state of every live flow: NATed and stateful-firewalled connections that relied on it were reset or blackholed. The table refilled within minutes anyway."; return { out: "conntrack v1.4.8 (conntrack-tools): connection tracking table has been emptied.", danger: "Flushed the state of every live connection." }; } },
            { re: /^(?:echo|printf) ['"]?([\w.]+) ?= ?(\d+)(?:\\n)?['"]? (>>?) ?(\/etc\/sysctl\.d\/[\w.-]+\.conf)$/, use: "echo '<key> = <value>' >> /etc/sysctl.d/90-conntrack.conf", desc: "persist a setting", run: (m, st) => { if (!keys[m[1]]) return ""; if (!m[4].endsWith(".conf")) return ""; st.persist[keys[m[1]]] = +m[2]; return ""; } },
            { re: /^cat \/etc\/sysctl\.d\/(\S+)$/, use: "cat /etc/sysctl.d/<file>", desc: "", run: (m, st) => Object.keys(st.persist).length ? Object.entries(st.persist).map(([k, v]) => `${k === "max" ? "net.netfilter.nf_conntrack_max" : "net.netfilter.nf_conntrack_tcp_timeout_established"} = ${v}`).join("\n") : `cat: /etc/sysctl.d/${m[1]}: No such file or directory` },
            { re: /^sysctl (?:--system|-p(?: \S+)?)$/, use: "sysctl --system", desc: "apply all files in /etc/sysctl.d", run: (m, st) => { Object.entries(st.persist).forEach(([k, v]) => { st[k] = v; st.live[k] = v; }); return "* Applying /etc/sysctl.d/10-network-security.conf ...\n" + Object.entries(st.persist).map(([k, v]) => `${k === "max" ? "net.netfilter.nf_conntrack_max" : "net.netfilter.nf_conntrack_tcp_timeout_established"} = ${v}`).join("\n"); } },
            { re: /^free -\w+$/, use: "free -m", desc: "", run: () => "               total        used        free      shared  buff/cache   available\nMem:            7940        1210        4920           8        1810        6420\nSwap:              0           0           0" },
          ]);
          return { prompt: `root@${I.host}:~#`, init: { max: I.max, est: 432000, live: {}, persist: {}, flushed: false, broke: null }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 9 : I.lv === 2 ? 7 : 5, cmds: ["dmesg -T | tail", "conntrack -S", "sysctl net.netfilter.nf_conntrack_max", "cat /proc/sys/net/netfilter/nf_conntrack_count", "conntrack -L -p tcp | awk '{print $4}' | sort | uniq -c", "sysctl -w <key>=<value>", ...(I.lv >= 2 ? ["echo '<key> = <value>' >> /etc/sysctl.d/90-conntrack.conf", "sysctl --system"] : []), ...(I.lv === 3 ? ["sysctl net.netfilter.nf_conntrack_tcp_timeout_established"] : []), "conntrack -F"] };
        },
        goal(st, I) {
          if (st.broke) return st.broke;
          const proj = I.active * (I.lv === 3 ? 1 : 1.25) + (I.lv === 3 ? I.aband * st.est : 0);
          const cur = I.lv === 3 ? Math.max(proj, I.max) : proj;
          if (cur >= st.max * 0.8 && !(I.lv === 3 && proj < st.max * 0.8 && cur < st.max)) return `The table would sit at ${Math.round(Math.min(cur, st.max) / st.max * 100)}% of nf_conntrack_max (${st.max}). Keep it under 80% so bursts don't drop packets.`;
          if (I.lv === 3) {
            if (st.max > 1048576) return `nf_conntrack_max = ${st.max} is over the memory budget (1,048,576 entries).`;
            if (proj >= st.max * 0.8) return `With ESTABLISHED entries kept for ${st.est} s, abandoned flows (about ${I.aband}/s from clients that vanish without FIN/RST) pile up to ~${K.num(Math.round(proj))} entries. No affordable max holds that; shorten how long idle established flows are tracked.`;
          }
          if (I.lv >= 2) {
            if ((st.persist.max || 0) !== st.max) return "The live value is fixed, but nothing in /etc/sysctl.d sets it: the next reboot or rebuild brings back the old limit.";
            if (I.lv === 3 && (st.persist.est || 432000) !== st.est) return "The timeout change isn't persisted in /etc/sysctl.d.";
          }
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: ["dmesg -T | tail", "sysctl net.netfilter.nf_conntrack_max", "cat /proc/sys/net/netfilter/nf_conntrack_count", "sysctl -w net.netfilter.nf_conntrack_max=262144"] }
          : I.lv === 2 ? { log: ["dmesg -T | tail", "conntrack -S", "sysctl net.netfilter.nf_conntrack_max", "echo 'net.netfilter.nf_conntrack_max = 262144' >> /etc/sysctl.d/90-conntrack.conf", "sysctl --system"] }
            : { log: ["dmesg -T | tail", "conntrack -L -p tcp | awk '{print $4}' | sort | uniq -c", "sysctl net.netfilter.nf_conntrack_tcp_timeout_established", "echo 'net.netfilter.nf_conntrack_max = 1048576' >> /etc/sysctl.d/90-conntrack.conf", "echo 'net.netfilter.nf_conntrack_tcp_timeout_established = 86400' >> /etc/sysctl.d/90-conntrack.conf", "sysctl --system"] },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["conntrack -F"] }, { log: ["sysctl -w net.netfilter.nf_conntrack_max=70000"] }] : I.lv === 2 ? [{ log: ["sysctl -w net.netfilter.nf_conntrack_max=262144"] }] : [{ log: ["sysctl -w net.netfilter.nf_conntrack_max=1048576", "echo 'net.netfilter.nf_conntrack_max = 1048576' >> /etc/sysctl.d/90-conntrack.conf"] }, { log: ["echo 'net.netfilter.nf_conntrack_max = 4194304' >> /etc/sysctl.d/90-conntrack.conf", "echo 'net.netfilter.nf_conntrack_tcp_timeout_established = 432000' >> /etc/sysctl.d/90-conntrack.conf", "sysctl --system"] }],
      hint: (I) => I.lv === 1 ? "Compare nf_conntrack_count with nf_conntrack_max." : I.lv === 2 ? "sysctl -w changes the running kernel only. Where do settings that survive a reboot live?" : "Look at which state dominates and how long the kernel keeps an idle ESTABLISHED entry by default.",
      concept: "Connection tracking table exhaustion",
      how: "With netfilter connection tracking loaded (any stateful iptables/nftables rule, NAT, Docker, kube-proxy), every flow gets an entry. When nf_conntrack_count reaches nf_conntrack_max, new flows are dropped ('table full, dropping packet'), which clients see as random timeouts. Each entry costs a few hundred bytes of kernel memory. The default timeout for an ESTABLISHED TCP entry is 432000 s (5 days), so flows that vanish without FIN or RST (mobile clients, crashed peers) linger for days. sysctl -w changes the live kernel only; /etc/sysctl.d files make it stick. Flushing the table drops the state of live connections.",
      rule: "Alert on nf_conntrack_count / nf_conntrack_max. Size max for steady state plus bursts, persist it in sysctl.d, lower tcp_timeout_established when abandoned flows dominate, and exempt high-volume traffic with NOTRACK where you can.",
      why: (I) => I.lv === 1 ? `Legitimate traffic needed about ${K.num(Math.round(I.active * 1.25))} entries against a max of ${K.num(I.max)}. Raising nf_conntrack_max live (262,144) stopped the drops immediately.` : I.lv === 2 ? "Same mechanism, but a live sysctl -w would vanish on Sunday's rebuild. A file in /etc/sysctl.d plus sysctl --system fixes it now and at every boot." : `Roughly ${I.aband} abandoned flows per second times the 5-day ESTABLISHED timeout is ~${K.num(Math.round(I.aband * 432000))} entries: no affordable max holds that. With the timeout at 86,400 s (1 day) the steady state is ~${K.num(Math.round(I.active + I.aband * 86400))}, comfortably under 80% of 1,048,576. Lowering the timeout doesn't affect flows that are actually exchanging packets.`,
    },
    /* ======================================================================== */
    {
      id: "linux-listen-backlog",
      name: "Connections dropped at the front door",
      kind: "Investigation",
      skills: ["diagnose", "tune"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "The app listens with a backlog of 128, too small for the connection bursts; the accept queue overflows (raise the app's backlog)", ["net.core.somaxconn is too low", "The server's CPUs are saturated", "A SYN flood attack: enable syncookies"]);
        else if (lv === 2) o = mkOpts(R, "net.core.somaxconn = 128 silently caps the 4096 backlog the app asks for", ["The app ignores its backlog setting (a bug in the server library)", "tcp_max_syn_backlog is too low", "The load balancer opens too many connections; rate-limit it"]);
        else o = mkOpts(R, "The app's single event-loop thread is pinned at 100% CPU and can't accept fast enough; a larger backlog would only add latency", ["The backlog is too small; raise it and somaxconn to 65535", "net.core.somaxconn caps the backlog", "A SYN flood attack: enable syncookies"]);
        return { lv, ...o, port: R.pick([8080, 9000, 8443]), pid: R.int(2000, 30000), ov: R.int(40, 400) * 1000, svc: R.pick(["quote-api", "checkout-edge", "score-svc"]), miss: lv === 2 ? "Compare the backlog in the app's config with Send-Q on the listening socket." : lv === 3 ? "The queue is full, but is the backlog the bottleneck? Look at what the app's threads are doing." : "Read Recv-Q and Send-Q of the LISTEN socket." };
      },
      text: (I) => `<p><b>PAGE:</b> clients of <code>${I.svc}</code> see connect timeouts and 1-3 s connection setup times, mostly in bursts at the top of each minute. ${I.lv === 2 ? "The team already raised <code>server.backlog</code> to 4096 last week; nothing changed." : I.lv === 3 ? "Backlog and somaxconn were both raised to 4096 last month." : ""}</p><p>Investigate on one instance and pick the root cause.</p>`,
      ...LB.term({
        shell(I) {
          const bl = I.lv === 1 ? 128 : I.lv === 2 ? 128 : 4096;
          const sh = K.shell([
            { re: /^ss -\w*l\w*(?: .*)?$/, use: "ss -lnt", desc: "for LISTEN sockets: Recv-Q = queued connections, Send-Q = backlog", run: () => K.cols([["State", "Recv-Q", "Send-Q", "Local Address:Port", "Peer Address:Port"], ["LISTEN", "0", "4096", "0.0.0.0:22", "0.0.0.0:*"], ["LISTEN", String(bl + 1), String(bl), `0.0.0.0:${I.port}`, "0.0.0.0:*"], ["LISTEN", "0", "4096", "0.0.0.0:9100", "0.0.0.0:*"]]) },
            { re: /^nstat(?: -\w+)*(?: \w+)*$/, use: "nstat -az TcpExtListenOverflows TcpExtListenDrops", desc: "", run: () => `#kernel\nTcpExtListenOverflows           ${I.ov}                0.0\nTcpExtListenDrops               ${I.ov}                0.0` },
            { re: /^netstat -s(?: \| grep -i \S+)?$/, use: "netstat -s | grep -i listen", desc: "", run: () => `    ${I.ov} times the listen queue of a socket overflowed\n    ${I.ov} SYNs to LISTEN sockets dropped` },
            { re: /^sysctl ([\w.]+)$/, use: "sysctl net.core.somaxconn", desc: "", run: (m) => ({ "net.core.somaxconn": `net.core.somaxconn = ${I.lv === 2 ? 128 : 4096}`, "net.ipv4.tcp_max_syn_backlog": "net.ipv4.tcp_max_syn_backlog = 4096", "net.ipv4.tcp_syncookies": "net.ipv4.tcp_syncookies = 1" })[m[1]] || `sysctl: cannot stat /proc/sys/${m[1].replace(/\./g, "/")}: No such file or directory` },
            { re: /^(?:grep -r \S+ \/etc\/sysctl\.d\/?|cat \/etc\/sysctl\.d\/\S+)$/, use: "grep -r somaxconn /etc/sysctl.d/", desc: "", run: () => I.lv === 2 ? "/etc/sysctl.d/99-legacy-tuning.conf:net.core.somaxconn = 128" : "" },
            { re: /^cat \/etc\/\S+\/(?:server|app)\.(?:ya?ml|conf)$/, use: `cat /etc/${"<svc>"}/server.yaml`, desc: "app config", run: () => `server:\n  port: ${I.port}\n  backlog: ${I.lv === 1 ? 128 : 4096}\n  workers: ${I.lv === 3 ? 1 : 64}\n  keepalive_timeout: 5s` },
            { re: /^top (?=.*-H)(?=.*-p ?\d+).*$/, use: "top -H -bn1 -p <pid>", desc: "per-thread CPU", run: () => `  PID USER      PR  NI    VIRT    RES  %CPU  S COMMAND\n${I.lv === 3 ? ` ${I.pid} app       20   0 1220431 412211  99.7  R event-loop\n ${I.pid + 1} app       20   0 1220431 412211   0.3  S gc-worker\n ${I.pid + 2} app       20   0 1220431 412211   0.0  S signal` : ` ${I.pid} app       20   0 1220431 412211   2.1  S acceptor\n ${I.pid + 1} app       20   0 1220431 412211   1.3  S worker-1\n ${I.pid + 2} app       20   0 1220431 412211   1.1  S worker-2\n … 61 more workers at 0-2% CPU`}` },
            { re: /^(?:pgrep -f \S+|pidof \S+|systemctl status \S+)$/, use: "pgrep -f <name>", desc: "", run: () => String(I.pid) },
            { re: /^mpstat(?: -P ALL)?(?: \d+)*$/, use: "mpstat -P ALL 1 1", desc: "", run: () => `CPU    %usr   %sys  %idle\nall    ${I.lv === 3 ? "14.1" : "6.2"}    3.1   ${I.lv === 3 ? "82.8" : "90.7"}\n  0    ${I.lv === 3 ? "97.0" : "6.0"}    2.9    ${I.lv === 3 ? "0.1" : "91.1"}\n  1     6.1    3.0   90.9\n…  (6 more CPUs, ~90% idle)` },
          ]);
          return { prompt: `root@${I.svc}-3:~#`, init: {}, run: (l, st) => sh.run(l, st), par: 6, cmds: ["ss -lnt", "nstat -az TcpExtListenOverflows TcpExtListenDrops", "sysctl net.core.somaxconn", `cat /etc/${I.svc}/server.yaml`, "top -H -bn1 -p <pid>", "mpstat -P ALL 1 1", "pgrep -f <name>"], opts: I.opts, optq: "Root cause" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["ss -lnt", "nstat -az TcpExtListenOverflows TcpExtListenDrops", I.lv === 3 ? `top -H -bn1 -p ${I.pid}` : I.lv === 2 ? "sysctl net.core.somaxconn" : `cat /etc/${I.svc}/server.yaml`], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["ss -lnt"], pick: (I.ans + 1) % 4 }, { log: ["nstat -az TcpExtListenOverflows TcpExtListenDrops"], pick: (I.ans + 3) % 4 }],
      hint: (I) => I.lv === 1 ? "For a LISTEN socket, ss shows the queued, not-yet-accepted connections as Recv-Q and the backlog as Send-Q." : I.lv === 2 ? "The kernel uses min(backlog passed to listen(), net.core.somaxconn)." : "A full queue means connections arrive faster than accept() takes them. Is the queue too short, or is the consumer too slow?",
      concept: "Listen backlog and accept queue overflow",
      how: "After the handshake completes, the kernel parks a connection in the listening socket's accept queue until the application calls accept(). Its length is min(the backlog the app passes to listen(), net.core.somaxconn); ss -lnt shows it as Send-Q, and the current depth as Recv-Q. When it's full, the kernel drops the client's final ACK or SYN (TcpExtListenOverflows / ListenDrops), and the client retransmits after about 1 s, then 3 s: connection setup latency in whole seconds. A bigger queue absorbs bursts, but if the app accepts slower than connections arrive on average, a bigger queue only adds waiting time.",
      rule: "If ListenOverflows is rising, compare Send-Q to what the app asked for (somaxconn caps it), size the backlog for your burst, and check whether the accepting thread is saturated before raising anything.",
      why: (I) => I.lv === 1 ? `Send-Q 128 with Recv-Q 129: the queue was full, and ${K.num(I.ov)} overflows were counted. somaxconn was 4096, so the app's own backlog of 128 was the limit for the top-of-minute bursts.` : I.lv === 2 ? `The app asked for 4096 but Send-Q showed 128: /etc/sysctl.d/99-legacy-tuning.conf sets somaxconn = 128 and the kernel takes the minimum. Since kernel 5.4 the default is 4096; the legacy file overrode it.` : `Backlog 4096 was full, but the only thread that accepts and serves (workers: 1, the event loop) was at 99.7% of one core while the other cores idled. Accepting is CPU-starved; add workers/processes (SO_REUSEPORT) or move work off the loop.`,
    },
    /* ======================================================================== */
    {
      id: "linux-strace-hung",
      name: "The process that does nothing",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "Blocked in read() on an HTTPS connection to the partner API that will never answer; the client has no read timeout", ["A deadlock between two threads", "Waiting for disk I/O", "Starved of CPU by other processes"]);
        else if (lv === 2) o = mkOpts(R, "One thread holds a lock while blocked reading from Redis with no timeout; every other thread waits for that lock", ["A classic deadlock: two locks taken in opposite order", "GIL contention from CPU-bound threads", "Redis is down: connections are refused"]);
        else o = mkOpts(R, "stdout is a pipe to the log forwarder, which is stopped (state T); the pipe buffer filled, so write(1) blocks", ["The disk holding the log file is full", "A futex deadlock inside the logging library", "The process is being throttled by its cgroup CPU quota"]);
        return { lv, ...o, pid: R.int(2000, 40000), sock: R.int(40000, 99999), fd: R.int(5, 14), svc: R.pick(["invoice-sync", "ledger-worker", "feed-builder"]), miss: lv === 1 ? "Follow the fd from strace to the socket and its peer." : lv === 2 ? "strace -f shows every thread. Which one is not waiting on a futex, and what is it waiting for?" : "Who is on the other end of fd 1?" };
      },
      text: (I) => `<p><b>PAGE:</b> <code>${I.svc}</code> (pid ${I.pid}) stopped making progress ${I.lv === 3 ? "about 20 minutes ago" : "an hour ago"}: no log lines, no CPU, queue growing. It is still running. ${I.lv === 2 ? "It's a multi-threaded Python service." : ""}</p><p>Find out what it is waiting for and pick the root cause.</p>`,
      ...LB.term({
        shell(I) {
          const P = I.pid;
          const sh = K.shell([
            { re: /^ps (?:-\w+ )*(?:-o \S+ )?(?:-p ?\d+|aux|-ef)(?: .*)?$/, use: "ps -o pid,stat,wchan:24,etime,cmd -p <pid>", desc: "", run: () => K.cols([["PID", "STAT", "WCHAN", "ELAPSED", "CMD"], [P, I.lv === 2 ? "Sl" : "S", I.lv === 1 ? "sk_wait_data" : I.lv === 2 ? "futex_wait_queue" : "pipe_write", "6-01:12:09", `python3 /opt/${I.svc}/main.py`], ...(I.lv === 3 ? [[P - 311, "T", "do_signal_stop", "41-02:01:44", "/usr/bin/log-forwarder --input stdin --to logs.internal:5140"]] : [])]) },
            { re: /^cat \/proc\/(\d+)\/wchan$/, use: "cat /proc/<pid>/wchan", desc: "", run: () => (I.lv === 1 ? "sk_wait_data" : I.lv === 2 ? "futex_wait_queue" : "pipe_write") },
            { re: /^strace (?:-\w+ )*-p ?(\d+)(?: .*)?$/, use: "strace -p <pid>   |   strace -f -p <pid>", desc: "attach and show system calls (-f: all threads)", run: (m, st, l) => {
              const f = /-\w*f/.test(l.split("-p")[0]);
              const hdr = `strace: Process ${P} attached${f && I.lv === 2 ? " with 9 threads" : ""}\n`;
              const tail = "\n^Cstrace: Process " + P + " detached\n(no further system calls in 60 s)";
              if (I.lv === 1) return hdr + `read(${I.fd}, ` + tail;
              if (I.lv === 3) return hdr + `write(1, "2026-10-11T03:12:44Z INFO processed batch 88213 (412 rows)\\n", 62` + tail;
              if (!f) return hdr + "futex(0x55d1c2a0f0a0, FUTEX_WAIT_BITSET_PRIVATE|FUTEX_CLOCK_REALTIME, 0, NULL, FUTEX_BITSET_MATCH_ANY" + tail;
              return hdr + Array.from({ length: 4 }, (_, k) => `[pid ${P + 2 + k}] futex(0x55d1c2a0f0a0, FUTEX_WAIT_BITSET_PRIVATE|FUTEX_CLOCK_REALTIME, 0, NULL, FUTEX_BITSET_MATCH_ANY <unfinished ...>`).join("\n") + `\n[pid ${P + 9}] recvfrom(${I.fd}, ` + `\n[pid ${P}] futex(0x55d1c2a0f0a0, FUTEX_WAIT_BITSET_PRIVATE|FUTEX_CLOCK_REALTIME, 0, NULL, FUTEX_BITSET_MATCH_ANY` + tail;
            } },
            { re: /^ls -l\w* \/proc\/(\d+)\/fd(?:\/(\d+))?\/?$/, use: "ls -l /proc/<pid>/fd", desc: "", run: (m) => { const lines = [`lr-x------ 1 app app 64 Oct 11 02:00 0 -> /dev/null`, `l-wx------ 1 app app 64 Oct 11 02:00 1 -> pipe:[${I.sock + 7}]`, `l-wx------ 1 app app 64 Oct 11 02:00 2 -> pipe:[${I.sock + 7}]`, `lrwx------ 1 app app 64 Oct 11 02:00 3 -> anon_inode:[eventpoll]`, `lrwx------ 1 app app 64 Oct 11 02:00 ${I.fd} -> socket:[${I.sock}]`]; return m[2] ? lines.filter((l) => l.includes(` ${m[2]} -> `)).join("\n") || `ls: cannot access '/proc/${m[1]}/fd/${m[2]}': No such file or directory` : "total 0\n" + lines.join("\n"); } },
            { re: /^ss -\w*(?: .*)?$/, use: "ss -tnpi | grep pid=<pid>", desc: "TCP sockets with owners", run: () => I.lv === 3 ? `ESTAB 0 0 10.0.3.17:51022 10.0.9.4:5432 users:(("python3",pid=${P},fd=${I.fd}))` : I.lv === 1 ? `State  Recv-Q Send-Q Local Address:Port   Peer Address:Port Process\nESTAB  0      0      10.0.3.17:51812      203.0.113.40:443  users:(("python3",pid=${P},fd=${I.fd})) ino:${I.sock}\n\t cubic rto:204 rtt:3.1/1.2 lastsnd:3601120 lastrcv:3601104 lastack:3601104` : `State  Recv-Q Send-Q Local Address:Port   Peer Address:Port Process\nESTAB  0      0      10.0.3.17:44120      10.0.5.9:6379     users:(("python3",pid=${P},fd=${I.fd})) ino:${I.sock}\n\t cubic rto:201 rtt:0.4/0.1 lastsnd:3550211 lastrcv:3550209` },
            { re: /^(?:lsof .*|find \/proc\/\*\/fd .*)$/, use: "lsof | grep 'pipe:\\[<inode>\\]'  (or: find /proc/*/fd -lname 'pipe:\\[<inode>\\]')", desc: "who else has this pipe/socket open", run: (m, st, l) => /pipe/.test(l) || l.includes(String(I.sock + 7)) ? `python3   ${P}  app    1w  FIFO   0,14  0t0  ${I.sock + 7} pipe\npython3   ${P}  app    2w  FIFO   0,14  0t0  ${I.sock + 7} pipe\nlog-forwa ${P - 311} root  0r  FIFO   0,14  0t0  ${I.sock + 7} pipe` : `python3 ${P} app ${I.fd}u IPv4 ${I.sock} 0t0 TCP ${I.lv === 1 ? "10.0.3.17:51812->203.0.113.40:443" : I.lv === 2 ? "10.0.3.17:44120->10.0.5.9:6379" : "10.0.3.17:51022->10.0.9.4:5432"} (ESTABLISHED)` },
            { re: /^py-spy dump (?:--pid |-p )(\d+)$/, use: "py-spy dump --pid <pid>", desc: "Python stacks of every thread", run: () => I.lv === 2 ? `Thread ${P + 9} (idle): "refresh"\n    readline (socket.py:720)\n    read_response (redis/connection.py:512)\n    get (app/cache.py:41)        <- inside "with cache_lock:"\nThread ${P + 2} (idle): "worker-1"\n    acquire (app/cache.py:33)    "with cache_lock:"\n… 7 more threads waiting in acquire (app/cache.py:33)` : `Thread ${P} (idle): "MainThread"\n    ${I.lv === 1 ? "recv_into (ssl.py:1251)\n    readinto (socket.py:720)\n    _read_status (http/client.py:292)\n    post (app/partner.py:58)" : "write (app/log.py:19)\n    emit (logging/__init__.py:1163)"}` },
            { re: /^cat \/proc\/(\d+)\/status(?: \| grep \S+)?$/, use: "cat /proc/<pid>/status", desc: "", run: (m) => +m[1] === P - 311 && I.lv === 3 ? "Name:\tlog-forwarder\nState:\tT (stopped)\nPid:\t" + (P - 311) : `Name:\tpython3\nState:\tS (sleeping)\nThreads:\t${I.lv === 2 ? 10 : 2}` },
          ]);
          return { prompt: `root@${I.svc}-2:~#`, init: {}, run: (l, st) => sh.run(l, st), par: 6, cmds: ["ps -o pid,stat,wchan:24,etime,cmd -p <pid>", "strace -p <pid>", "strace -f -p <pid>", "ls -l /proc/<pid>/fd", "ss -tnpi | grep pid=<pid>", "lsof | grep 'pipe:\\[<inode>\\]'", "py-spy dump --pid <pid>"], opts: I.opts, optq: "Root cause" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: [`strace ${I.lv === 2 ? "-f " : ""}-p ${I.pid}`, `ls -l /proc/${I.pid}/fd`, I.lv === 3 ? `lsof | grep 'pipe:\\[${I.sock + 7}\\]'` : `ss -tnpi | grep pid=${I.pid}`, ...(I.lv === 3 ? [`ps -o pid,stat,wchan:24,etime,cmd -p ${I.pid - 311}`] : [])], pick: I.ans }),
      }),
      bad: (I) => [{ log: [`strace -p ${I.pid}`], pick: (I.ans + 1) % 4 }, { log: [], pick: (I.ans + 2) % 4 }],
      hint: (I) => I.lv === 1 ? "strace shows the system call the process is stuck in; its first argument is a file descriptor you can look up in /proc/<pid>/fd." : I.lv === 2 ? "A futex wait is a symptom: someone holds the lock. strace -f (or py-spy) shows what the other threads are doing." : "write() to fd 1 blocks when fd 1 is a pipe whose reader isn't reading.",
      concept: "Diagnosing a hung process with strace and /proc",
      how: "A process that uses no CPU is waiting in a system call. strace -p shows which (strace -f for all threads), /proc/PID/wchan and ps's WCHAN show the kernel wait point, and /proc/PID/fd maps the descriptor to a file, socket or pipe; ss -tnp and lsof find the peer. read() on a socket blocks forever without a timeout if the peer (or a NAT in between) silently forgets the connection. futex() waits mean a lock or condition: find the thread that holds it. A pipe holds 64 KiB by default; when the reader stops, the writer blocks in write().",
      rule: "Put timeouts on every network call, never hold a lock across I/O, and when something hangs: strace for the syscall, /proc/PID/fd for the object, ss/lsof for the other end.",
      why: (I) => I.lv === 1 ? `The main thread was in read(${I.fd}) on socket:[${I.sock}], an ESTABLISHED connection to 203.0.113.40:443 with nothing sent or received for an hour (lastrcv ~3,600,000 ms). The HTTP client had no read timeout, so it waits forever.` : I.lv === 2 ? `Eight threads waited on the same futex (cache_lock); the ninth held it while blocked in recvfrom(${I.fd}) on its Redis connection, which had gone silent. A socket timeout on the Redis client (and not doing I/O under the lock) fixes it.` : `fd 1 and 2 were pipe:[${I.sock + 7}], read by log-forwarder (pid ${I.pid - 311}), which was in state T: someone had stopped it (SIGSTOP / Ctrl-Z). Once the 64 KiB pipe buffer filled, every log write blocked the app. SIGCONT to the forwarder releases it.`,
    },
    /* ======================================================================== */
    {
      id: "linux-iostat-util",
      name: "Is the disk really the bottleneck?",
      kind: "Investigation",
      skills: ["diagnose", "estimate"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "The spinning disk is saturated by random reads: ~180 IOPS is about all one HDD can do", ["%util 100% means the disk is failing", "The process is CPU-bound", "The page cache is too small; add RAM"]);
        else if (lv === 2) o = mkOpts(R, "The NVMe isn't saturated: the app issues one 4 KiB read at a time (queue depth ≈ 1), so %util is 100% while the device sits mostly idle", ["The NVMe is saturated; a faster disk is needed", "Read latency (await) is far too high for NVMe", "The disk is throttled by the cloud provider"]);
        else o = mkOpts(R, "The volume's burst credits are exhausted: it's throttled to its baseline of 300 IOPS (3 IOPS per GiB × 100 GiB)", ["An application regression doubled the I/O rate", "The filesystem is fragmented", "A noisy neighbour on the host is stealing CPU"]);
        return { lv, ...o, pid: R.int(2000, 40000), host: `${R.pick(["db", "search", "report"])}-${R.int(1, 9)}`, vol: `vol-0${R.int(100000, 999999).toString(16)}`, rs: R.int(4600, 5200), miss: lv === 2 ? "%util is the share of time with at least one request in flight. For a device that serves many requests in parallel, look at aqu-sz and await instead." : lv === 3 ? "r/s + w/s is suspiciously flat. Is something capping it?" : "Look at the device type (ROTA) and its await." };
      },
      text: (I) => `<p><b>PAGE:</b> ${I.lv === 1 ? "the nightly report on" : I.lv === 2 ? "a batch scorer on" : "the API backed by"} <code>${I.host}</code> is ${I.lv === 3 ? "timing out since about 09:40; it was fine for the first hour after this morning's reindex started" : "3× slower than last week"}. ${I.lv === 2 ? "The dashboard shows its NVMe disk at 100% utilisation and someone wants to order a faster instance." : ""}</p><p>Investigate the I/O and pick the root cause.</p>`,
      ...LB.term({
        shell(I) {
          const row = I.lv === 1 ? ["sdb", "182.0", "11.0", "728.0", "88.0", "85.40", "41.20", "16.20", "100.0"] : I.lv === 2 ? ["nvme1n1", `${I.rs}.0`, "2.0", `${I.rs * 4}.0`, "16.0", "0.19", "0.31", "0.95", "99.8"] : ["nvme1n1", "212.0", "88.0", "6784.0", "1408.0", "38.10", "41.70", "11.40", "100.0"];
          const sh = K.shell([
            { re: /^iostat(?: -\w+)*(?: \S+)*$/, use: "iostat -x 1 3", desc: "extended device statistics", run: () => `avg-cpu:  %user   %nice %system %iowait  %steal   %idle\n           ${I.lv === 2 ? "12.40" : "3.10"}    0.00    ${I.lv === 2 ? "9.80" : "1.20"}   ${I.lv === 2 ? "1.10" : "22.40"}    0.00   ${I.lv === 2 ? "76.70" : "73.30"}\n\n` + K.cols([["Device", "r/s", "w/s", "rkB/s", "wkB/s", "r_await", "w_await", "aqu-sz", "%util"], ["nvme0n1", "1.0", "6.0", "4.0", "92.0", "0.18", "0.40", "0.00", "0.6"], row]) },
            { re: /^lsblk(?: .*)?$|^cat \/sys\/block\/\w+\/queue\/rotational$/, use: "lsblk -d -o NAME,ROTA,SIZE,MODEL", desc: "device type (ROTA 1 = spinning)", run: (m, st, l) => /rotational/.test(l) ? (I.lv === 1 && /sdb/.test(l) ? "1" : "0") : K.cols([["NAME", "ROTA", "SIZE", "MODEL"], ["nvme0n1", "0", "50G", "NVMe boot volume"], I.lv === 1 ? ["sdb", "1", "8T", "HGST HUS728T8TAL"] : I.lv === 2 ? ["nvme1n1", "0", "3.5T", "local NVMe SSD"] : ["nvme1n1", "0", "100G", `network block volume ${I.vol}`]]) },
            { re: /^(?:pidstat -d(?: \d+)*|iotop -\w+(?: -\w+)*)$/, use: "pidstat -d 1 1", desc: "I/O per process", run: () => `      UID       PID   kB_rd/s   kB_wr/s kB_ccwr/s iodelay  Command\n      998     ${I.pid}  ${I.lv === 1 ? "722.10" : I.lv === 2 ? (I.rs * 4) + ".00" : "6702.00"}     ${I.lv === 3 ? "1390.00" : "12.00"}      0.00    ${I.lv === 2 ? 1 : 98}  ${I.lv === 1 ? "report-gen" : I.lv === 2 ? "scorer" : "search-node"}` },
            { re: /^strace (?:-\w+ )*-p ?\d+(?: .*)?$/, use: "strace -c -p <pid>", desc: "", run: () => I.lv === 2 ? `% time     seconds  usecs/call     calls    errors syscall\n------ ----------- ----------- --------- --------- ----------------\n 98.12    1.201220          24     49120           pread64\n  1.88    0.023011          11      2004           futex\n(one thread; each pread64 is 4096 bytes at an offset taken from the previous read)` : "% time     seconds  usecs/call     calls    errors syscall\n 97.4     2.412     13120       184           pread64" },
            { re: /^(?:cloudctl volume metrics \S+(?: .*)?)$/, use: `cloudctl volume metrics ${I.vol}`, desc: "the provider's view of the volume", run: () => I.lv === 3 ? `volume ${I.vol}  type=burst  size=100GiB  baseline=300 IOPS  burst=3000 IOPS\nTIME   IOPS  BURST_BALANCE\n08:30  2980  100%\n09:00  2990   61%\n09:30  2985   18%\n09:40   301    0%\n10:10   300    0%` : "cloudctl: volume not found (this disk is local)" },
            { re: /^vmstat(?: \d+)*$/, use: "vmstat 1 3", desc: "", run: () => ` r  b   swpd   free  cache   si   so    bi    bo  us sy id wa st\n ${I.lv === 2 ? 1 : 0}  ${I.lv === 2 ? 1 : 9}      0 812211 9120334    0    0 ${I.lv === 2 ? I.rs * 4 : 7000}  ${I.lv === 3 ? 1400 : 90} ${I.lv === 2 ? "12 10 77  1" : " 3  1 73 22"}  0` },
          ]);
          return { prompt: `root@${I.host}:~#`, init: {}, run: (l, st) => sh.run(l, st), par: 5, cmds: ["iostat -x 1 3", "lsblk -d -o NAME,ROTA,SIZE,MODEL", "pidstat -d 1 1", "strace -c -p <pid>", ...(I.lv === 3 ? [`cloudctl volume metrics ${I.vol}`] : [])], opts: I.opts, optq: "Root cause" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["iostat -x 1 3", "lsblk -d -o NAME,ROTA,SIZE,MODEL", I.lv === 3 ? `cloudctl volume metrics ${I.vol}` : I.lv === 2 ? `strace -c -p ${I.pid}` : "pidstat -d 1 1"], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["iostat -x 1 3"], pick: (I.ans + 1) % 4 }, { log: [], pick: (I.ans + 2) % 4 }],
      hint: (I) => I.lv === 1 ? "A 7,200 rpm disk does on the order of 100-200 random IOPS. Compare with r/s and r_await." : I.lv === 2 ? "With aqu-sz below 1 and sub-millisecond await, is the device busy or just never idle?" : "Throughput that plateaus at a round number, with latency climbing, usually means a cap.",
      concept: "Reading iostat: %util, await and queue depth",
      how: "%util is the fraction of time the device had at least one request outstanding. For a single spinning disk that serves one request at a time, 100% means saturated. SSDs and NVMe devices serve many requests in parallel, so 100% util with a queue (aqu-sz) near 1 and sub-millisecond await means one request is always in flight, not that the device is full: the workload is latency-bound. Saturation shows up as rising await with a growing queue. Cloud block volumes add their own caps: burstable volumes spend credits above a baseline (often proportional to size) and drop to the baseline when credits run out.",
      rule: "Judge a disk by await and aqu-sz against what the device can do, not by %util alone. Check the device type and, for network volumes, the provider's IOPS/throughput limits and credit balance.",
      why: (I) => I.lv === 1 ? "sdb is a 7,200 rpm HDD (ROTA 1) doing 182 random reads/s with 85 ms await and 16 requests queued: it is at its mechanical limit. Moving the report to SSD, or making its reads sequential, fixes it." : I.lv === 2 ? `The scorer reads one dependent 4 KiB block at a time (${K.num(I.rs)} reads/s × 0.19 ms ≈ 95% of each second), so util is ~100% with aqu-sz 0.95. The NVMe could do far more in parallel: issue reads concurrently (async I/O, more threads) instead of buying a faster disk.` : `The reindex ran the volume at ~3,000 IOPS on burst credits; at 09:40 the balance hit 0% and it fell to its 300 IOPS baseline (3 × 100 GiB). Flat r/s + w/s ≈ 300 with 38 ms await is the throttle. Use a provisioned-IOPS volume or a bigger one, or rate-limit the reindex.`,
    },
    /* ======================================================================== */
    {
      id: "linux-clock-drift",
      name: "Tokens rejected: clock skew",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) { return { lv, off: lv === 1 ? R.int(38, 70) : lv === 2 ? R.int(9, 20) : R.int(80, 120), host: `${R.pick(["auth", "api", "pay"])}-${R.int(1, 9)}` }; },
      text: (I) => `<p><b>PAGE:</b> requests through <code>${I.host}</code> fail token validation with <code>token used before issued (iat in future)</code> / <code>expired</code>. Other hosts are fine. ${I.lv === 2 ? "This host is in a new VPC whose egress is locked down to internal services; the platform team runs <code>time.internal</code> for NTP." : I.lv === 3 ? "chrony is running and says it's synchronised. The platform team runs four NTP servers: <code>time-a.internal</code> to <code>time-d.internal</code>." : ""}</p><p>Get the clock right and keep it right${I.lv === 1 ? ", including after reboots" : ""}.</p>`,
      ...LB.term({
        shell(I) {
          const synced = (st) => st.running && (I.lv === 1 ? true : I.lv === 2 ? st.appliedInternal : st.appliedGood > st.appliedBad);
          const offset = (st) => (synced(st) ? 0.000412 : I.off + 0.21);
          const srcs = (st) => {
            if (!st.running) return "506 Cannot talk to daemon";
            const rows = [];
            if (I.lv === 2) { rows.push(["^?", "prod-ntp-1.ntp1.ps5.canonical.com", "0", "6", "0", "-", "+0ns[ +0ns] +/- 0ns"], ["^?", "alphyn.canonical.com", "0", "6", "0", "-", "+0ns[ +0ns] +/- 0ns"]); if (st.appliedInternal) rows.push(["^*", "time.internal", "3", "6", "17", "12", "+211us[ +311us] +/- 4120us"]); }
            if (I.lv === 3) {
              const both = st.appliedBad && st.appliedGood > 0;
              if (st.appliedBad) rows.push([both && st.appliedGood > st.appliedBad ? "^x" : both ? "^?" : "^*", "time-a.internal", "2", "6", "377", "33", `${both && st.appliedGood > st.appliedBad ? "+95s" : "+412us"}[ +401us] +/- 2210us`]);
              ["b", "c", "d"].slice(0, st.appliedGood).forEach((x, k) => rows.push([st.appliedGood > st.appliedBad ? (k ? "^+" : "^*") : "^?", `time-${x}.internal`, "2", "6", "17", "12", "+188us[ +201us] +/- 2410us"]));
            }
            if (I.lv === 1) rows.push(["^*", "prod-ntp-3.ntp4.ps5.canonical.com", "2", "6", "17", "21", "+511us[ +601us] +/- 18ms"], ["^+", "alphyn.canonical.com", "2", "6", "17", "20", "-210us[ -120us] +/- 21ms"]);
            return "MS Name/IP address         Stratum Poll Reach LastRx Last sample\n===============================================================================\n" + K.cols(rows.map((r) => [r[0] + " " + r[1], r[2], r[3], r[4], r[5], r[6]]));
          };
          const conf = (st) => `# /etc/chrony/chrony.conf\n${I.lv === 3 ? st.conf.join("\n") : I.lv === 2 ? ["pool ntp.ubuntu.com        iburst maxsources 4", "pool 2.ubuntu.pool.ntp.org iburst maxsources 2", ...st.conf].join("\n") : "pool ntp.ubuntu.com        iburst maxsources 4\npool 2.ubuntu.pool.ntp.org iburst maxsources 2"}\nkeyfile /etc/chrony/chrony.keys\ndriftfile /var/lib/chrony/chrony.drift\nmakestep 1 3\nrtcsync`;
          const restart = (st) => { st.running = true; if (I.lv === 2) st.appliedInternal = st.conf.some((l) => /time\.internal/.test(l)); if (I.lv === 3) { st.appliedBad = st.conf.some((l) => /time-a\./.test(l)) ? 1 : 0; st.appliedGood = ["b", "c", "d"].filter((x) => st.conf.some((l) => l.includes(`time-${x}.internal`))).length; } };
          const sh = K.shell([
            { re: /^timedatectl(?: status)?$/, use: "timedatectl", desc: "", run: (m, st) => `               Local time: Sat 2026-10-11 03:14:${String(Math.round(offset(st)) % 60).padStart(2, "0")} UTC\n           Universal time: Sat 2026-10-11 03:14:${String(Math.round(offset(st)) % 60).padStart(2, "0")} UTC\n                Time zone: Etc/UTC (UTC, +0000)\nSystem clock synchronized: ${synced(st) || (I.lv === 3 && st.running && !st.appliedGood) ? "yes" : "no"}\n              NTP service: ${st.running ? "active" : "inactive"}\n          RTC in local TZ: no` },
            { re: /^chronyc tracking$/, use: "chronyc tracking", desc: "", run: (m, st) => !st.running ? "506 Cannot talk to daemon" : I.lv === 3 && !st.appliedGood ? "Reference ID    : 0A000A01 (time-a.internal)\nStratum         : 3\nSystem time     : 0.000211 seconds fast of NTP time\nLast offset     : +0.000190 seconds\nLeap status     : Normal" : synced(st) ? `Reference ID    : 0A000A0${I.lv} (${I.lv === 2 ? "time.internal" : I.lv === 3 ? "time-b.internal" : "prod-ntp-3.ntp4.ps5.canonical.com"})\nStratum         : 3\nSystem time     : 0.000412 seconds slow of NTP time\nLast offset     : -0.000301 seconds\nLeap status     : Normal` : `Reference ID    : 00000000 ()\nStratum         : 0\nSystem time     : 0.000000000 seconds fast of NTP time\nLeap status     : Not synchronised` },
            { re: /^chronyc sources(?: -v)?$/, use: "chronyc sources -v", desc: "", run: (m, st) => srcs(st) },
            { re: /^systemctl (status|enable --now|enable|start|restart) (?:chrony|chronyd)(?:\.service)?$/, use: "systemctl status|restart|enable --now chrony", desc: "", run: (m, st) => { const v = m[1]; if (v === "status") return `${st.running ? "●" : "○"} chrony.service - chrony, an NTP client/server\n     Loaded: loaded (/usr/lib/systemd/system/chrony.service; ${st.enabled ? "enabled" : "disabled"}; preset: enabled)\n     Active: ${st.running ? "active (running)" : "inactive (dead)"}`; if (/enable/.test(v)) st.enabled = true; if (v === "enable") return 'Created symlink /etc/systemd/system/multi-user.target.wants/chrony.service → /usr/lib/systemd/system/chrony.service.'; if (v === "start" && st.running) return ""; restart(st); return /enable/.test(v) ? "Synchronizing state of chrony.service with SysV service script with /usr/lib/systemd/systemd-sysv-install.\nCreated symlink /etc/systemd/system/multi-user.target.wants/chrony.service → /usr/lib/systemd/system/chrony.service." : ""; } },
            { re: /^cat \/etc\/chrony\/chrony\.conf$/, use: "cat /etc/chrony/chrony.conf", desc: "", run: (m, st) => conf(st) },
            { re: /^echo ['"]((?:server|pool) [\w.-]+(?: \w+)*)['"] >> ?\/etc\/chrony\/chrony\.conf$/, use: "echo 'server <host> iburst' >> /etc/chrony/chrony.conf", desc: "add a time source", run: (m, st) => { st.conf.push(m[1]); return ""; } },
            { re: /^sed -i ['"]\/([\w.-]+)\/d['"] \/etc\/chrony\/chrony\.conf$/, use: "sed -i '/<pattern>/d' /etc/chrony/chrony.conf", desc: "delete matching lines", run: (m, st) => { st.conf = st.conf.filter((l) => !l.includes(m[1].replace(/\\/g, ""))); return ""; } },
            { re: /^chronyd -Q ['"](?:server|pool) ([\w.-]+)(?: \w+)*['"]$/, use: "chronyd -Q 'server <host> iburst'", desc: "measure the offset against a server without changing the clock", run: (m, st) => { const h = m[1]; const reach = I.lv === 2 ? h === "time.internal" : I.lv === 3 ? /^time-[a-d]\.internal$/.test(h) : true; if (!reach) return `2026-10-11T03:14:22Z chronyd version 4.5 starting\n2026-10-11T03:14:32Z No suitable source for synchronisation\n2026-10-11T03:14:32Z chronyd exiting`; const off = I.lv === 3 ? (h === "time-a.internal" ? 0.000213 : -(st.appliedGood > st.appliedBad ? 0.0004 : I.off + 0.21)) : -offset(st); return `2026-10-11T03:14:22Z chronyd version 4.5 starting\n2026-10-11T03:14:26Z System clock wrong by ${off.toFixed(6)} seconds (ignored)\n2026-10-11T03:14:26Z chronyd exiting`; } },
            { re: /^chronyc makestep$/, use: "chronyc makestep", desc: "step the clock to the current source now", run: (m, st) => (st.running ? "200 OK" : "506 Cannot talk to daemon") },
            { re: /^date(?: -u)?$/, use: "date -u", desc: "", run: (m, st) => `Sat Oct 11 03:14:${String(Math.round(offset(st)) % 60).padStart(2, "0")} AM UTC 2026` },
            { re: /^date -s .*$|^hwclock .*$|^timedatectl set-time .*$/, use: "date -s '<time>'", desc: "set the clock by hand", run: (m, st) => ({ out: "Sat Oct 11 03:14:02 AM UTC 2026", danger: "Setting the clock by hand jumps it (possibly backwards) under running services, and nothing keeps it right afterwards." }) },
          ]);
          const conf0 = I.lv === 3 ? ["server time-a.internal iburst"] : [];
          return { prompt: `root@${I.host}:~#`, init: { running: I.lv > 1, enabled: I.lv > 1, conf: conf0, appliedInternal: false, appliedGood: 0, appliedBad: I.lv === 3 ? 1 : 0 }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 8 : 6, cmds: ["timedatectl", "chronyc tracking", "chronyc sources -v", "systemctl status chrony", "cat /etc/chrony/chrony.conf", "echo 'server <host> iburst' >> /etc/chrony/chrony.conf", "chronyd -Q 'server <host> iburst'", "systemctl restart chrony", "chronyc makestep"] };
        },
        goal(st, I) {
          const ok = st.running && (I.lv === 1 ? true : I.lv === 2 ? st.appliedInternal : st.appliedGood > st.appliedBad);
          if (!ok) return I.lv === 3 ? `The clock is still about ${I.off} s fast. chrony is 'synchronised', but to what? With a single source it can't tell when that source is wrong.` : I.lv === 2 ? "chrony still has no reachable source, so the clock keeps drifting." : "No NTP client is running, so nothing corrects the clock.";
          if (I.lv === 1 && !st.enabled) return "Synced now, but chrony isn't enabled: after a reboot the clock drifts again.";
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: ["timedatectl", "systemctl status chrony", "systemctl enable --now chrony", "chronyc tracking"] } : I.lv === 2 ? { log: ["chronyc sources -v", "chronyd -Q 'server time.internal iburst'", "echo 'server time.internal iburst' >> /etc/chrony/chrony.conf", "systemctl restart chrony", "chronyc tracking"] } : { log: ["chronyc sources -v", "chronyd -Q 'server time-b.internal iburst'", "echo 'server time-b.internal iburst' >> /etc/chrony/chrony.conf", "echo 'server time-c.internal iburst' >> /etc/chrony/chrony.conf", "echo 'server time-d.internal iburst' >> /etc/chrony/chrony.conf", "systemctl restart chrony", "chronyc sources -v"] },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["systemctl start chrony"] }, { log: ["date -s '03:14:02'"] }] : I.lv === 2 ? [{ log: ["echo 'server time.internal iburst' >> /etc/chrony/chrony.conf", "chronyc makestep"] }, { log: ["systemctl restart chrony"] }] : [{ log: ["chronyc makestep"] }, { log: ["echo 'server time-b.internal iburst' >> /etc/chrony/chrony.conf", "systemctl restart chrony"] }],
      hint: (I) => I.lv === 1 ? "Is anything keeping the clock in sync at all? Check timedatectl." : I.lv === 2 ? "^? with Reach 0 means chrony has never heard back from that source. chronyd -Q tests a server without touching the clock. Config changes need a restart." : "With one source, chrony trusts it blindly. How many sources does it need to outvote a wrong one?",
      concept: "Keeping clocks in sync with chrony",
      how: "Token validation, TLS, distributed locks and log correlation all assume clocks agree to within seconds. chrony disciplines the clock against NTP sources: chronyc sources shows each (^* selected, ^+ combined, ^? unreachable or unusable, ^x falseticker) and Reach is an octal bitmask of recent replies (0 = nothing heard). makestep 1 3 lets chrony step the clock if it is off by more than 1 s during the first three updates after start; afterwards it slews gradually. A single source can't be cross-checked: with three or more, chrony detects one that disagrees and marks it a falseticker.",
      rule: "Run an NTP client on every host, enabled at boot, with at least three (ideally four) reachable sources, and alert on chronyc tracking offset. Don't set clocks by hand on production hosts.",
      why: (I) => I.lv === 1 ? `chrony was installed but disabled, so the clock had drifted ${I.off} s over weeks. enable --now started it at boot and now; makestep 1 3 stepped the clock on the first updates.` : I.lv === 2 ? `The default Ubuntu pools were unreachable (Reach 0) because egress to the internet is blocked, so the clock drifted ${I.off} s. Adding time.internal and restarting chrony (it doesn't re-read chrony.conf on its own) synced it, stepping via makestep.` : `chrony was happily 'synchronised' to time-a.internal, which itself was ${I.off} s off. With b, c and d added, the majority outvoted it (^x falseticker) and makestep corrected the clock at restart. One source is a single point of failure for time.`,
    },
    /* ======================================================================== */
    {
      id: "linux-thp-latency",
      name: "Latency spikes from huge pages",
      kind: "Config change",
      skills: ["diagnose", "tune", "safe"],
      gen(lv, R) { return { lv, host: `${R.pick(["kv", "cache", "session"])}-${R.int(1, 30)}`, stall: R.int(80, 400) * 100, p99: R.int(40, 180) }; },
      text: (I) => `<p><b>PAGE:</b> the in-memory key-value store on <code>${I.host}</code> has p99 spikes of <b>${I.p99} ms</b> (normally under 2 ms), worst during its fork-based snapshots. Its log warns about Transparent Huge Pages. ${I.lv >= 2 ? "The same host also runs a JVM sidecar started with <code>-XX:+UseTransparentHugePages</code>, which relies on THP via madvise and loses ~15% throughput without it." : ""} ${I.lv === 3 ? "This host is one of 200 built from the same image; your fix must survive reboots." : ""}</p><p>Fix the THP settings.</p>`,
      ...LB.term({
        shell(I) {
          const show = (opts, cur) => opts.map((o) => (o === cur ? `[${o}]` : o)).join(" ");
          const EN = ["always", "madvise", "never"], DF = ["always", "defer", "defer+madvise", "madvise", "never"];
          const sh = K.shell([
            { re: /^cat \/sys\/kernel\/mm\/transparent_hugepage\/(enabled|defrag)$/, use: "cat /sys/kernel/mm/transparent_hugepage/enabled|defrag", desc: "current THP mode (in brackets)", run: (m, st) => (m[1] === "enabled" ? show(EN, st.en) : show(DF, st.df)) },
            { re: /^echo ([\w+]+) > ?\/sys\/kernel\/mm\/transparent_hugepage\/(enabled|defrag)$/, use: "echo <mode> > /sys/kernel/mm/transparent_hugepage/enabled", desc: "change it now (lost on reboot)", run: (m, st) => { const list = m[2] === "enabled" ? EN : DF; if (!list.includes(m[1])) return `bash: echo: write error: Invalid argument`; st[m[2] === "enabled" ? "en" : "df"] = m[1]; return ""; } },
            { re: /^grep (?:-E )?['"]?[\w|]+['"]? \/proc\/vmstat$/, use: "grep -E 'compact_stall|thp_fault_alloc' /proc/vmstat", desc: "", run: (m, st) => `compact_stall ${I.stall}\ncompact_fail ${Math.round(I.stall * 0.4)}\ncompact_success ${Math.round(I.stall * 0.6)}\nthp_fault_alloc ${st.en === "always" ? 9120331 : 412211}\nthp_collapse_alloc ${st.en === "always" ? 88120 : 2010}` },
            { re: /^grep -i huge \/proc\/meminfo$|^grep AnonHugePages \/proc\/meminfo$/, use: "grep AnonHugePages /proc/meminfo", desc: "", run: (m, st) => `AnonHugePages:  ${st.en === "always" ? "24117248" : st.en === "madvise" ? "3145728" : "0"} kB` },
            { re: /^(?:tail|cat) (?:-n ?\d+ )?\/var\/log\/kvstore\/\S+$/, use: "tail /var/log/kvstore/kvstore.log", desc: "", run: () => "# WARNING you have Transparent Huge Pages (THP) support enabled in your kernel. This will create latency and memory usage issues. To fix this issue run the command 'echo never > /sys/kernel/mm/transparent_hugepage/enabled' as root.\n* Background saving started by pid 88211\n* Fork CoW for RDB: current 4211 MB, peak 4211 MB, average 2106 MB\n* Background saving terminated with success" },
            { re: /^cat \/proc\/cmdline$/, use: "cat /proc/cmdline", desc: "", run: (m, st) => `BOOT_IMAGE=/vmlinuz-6.8.0-45-generic root=LABEL=cloudimg-rootfs ro console=ttyS0${st.grub ? " (next boot: + transparent_hugepage=" + st.grub + ")" : ""}` },
            { re: /^(?:echo|printf) ['"]w \/sys\/kernel\/mm\/transparent_hugepage\/(enabled|defrag) - - - - ([\w+]+)(?:\\n)?['"] >>? ?\/etc\/tmpfiles\.d\/[\w.-]+\.conf$/, use: "echo 'w /sys/kernel/mm/transparent_hugepage/enabled - - - - <mode>' > /etc/tmpfiles.d/thp.conf", desc: "systemd-tmpfiles writes this at every boot", run: (m, st) => { st.persist[m[1]] = m[2]; return ""; } },
            { re: /^grubby --update-kernel=ALL --args=['"]?transparent_hugepage=(\w+)['"]?$/, use: "grubby --update-kernel=ALL --args=transparent_hugepage=<mode>", desc: "kernel command line (needs a reboot)", run: (m, st) => { st.grub = m[1]; st.persist.enabled = m[1]; return ""; } },
            { re: /^ps (?:aux|-ef)(?: .*)?$/, use: "ps aux | grep java", desc: "", run: () => I.lv >= 2 ? "app   4121  java -XX:+UseTransparentHugePages -Xmx6g -jar /opt/sidecar/sidecar.jar\nkv    1802  /usr/bin/kvstore-server 0.0.0.0:7000" : "kv    1802  /usr/bin/kvstore-server 0.0.0.0:7000" },
          ]);
          return { prompt: `root@${I.host}:~#`, init: { en: "always", df: I.lv === 2 ? "always" : "madvise", persist: {}, grub: null }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 7 : 6, cmds: ["cat /sys/kernel/mm/transparent_hugepage/enabled", "cat /sys/kernel/mm/transparent_hugepage/defrag", "grep -E 'compact_stall|thp_fault_alloc' /proc/vmstat", "tail /var/log/kvstore/kvstore.log", "echo <mode> > /sys/kernel/mm/transparent_hugepage/enabled", ...(I.lv === 3 ? ["echo 'w /sys/kernel/mm/transparent_hugepage/enabled - - - - <mode>' > /etc/tmpfiles.d/thp.conf"] : [])] };
        },
        goal(st, I) {
          if (st.en === "always") return "THP is still 'always': every large anonymous allocation can trigger huge page faults and compaction, and forks copy 2 MiB pages on write.";
          if (I.lv >= 2 && st.en === "never") return "'never' fixes the store but also turns THP off for the JVM sidecar that explicitly asks for it via madvise. Which mode gives huge pages only to processes that request them?";
          if (I.lv === 2 && st.df === "always") return "enabled=madvise is right, but defrag=always still makes every madvised fault (the JVM's) stall in direct compaction. Use the default (madvise) or defer+madvise.";
          if (I.lv === 3 && st.persist.enabled !== st.en) return "Fixed live, but /sys settings reset at boot: the next reboot brings back 'always' on all 200 hosts. Persist it (tmpfiles.d or the kernel command line).";
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: ["cat /sys/kernel/mm/transparent_hugepage/enabled", "grep -E 'compact_stall|thp_fault_alloc' /proc/vmstat", "echo never > /sys/kernel/mm/transparent_hugepage/enabled"] } : I.lv === 2 ? { log: ["cat /sys/kernel/mm/transparent_hugepage/enabled", "cat /sys/kernel/mm/transparent_hugepage/defrag", "echo madvise > /sys/kernel/mm/transparent_hugepage/enabled", "echo madvise > /sys/kernel/mm/transparent_hugepage/defrag"] } : { log: ["cat /sys/kernel/mm/transparent_hugepage/enabled", "echo madvise > /sys/kernel/mm/transparent_hugepage/enabled", "echo 'w /sys/kernel/mm/transparent_hugepage/enabled - - - - madvise' > /etc/tmpfiles.d/thp.conf"] },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["echo never > /sys/kernel/mm/transparent_hugepage/defrag"] }] : I.lv === 2 ? [{ log: ["echo never > /sys/kernel/mm/transparent_hugepage/enabled"] }, { log: ["echo madvise > /sys/kernel/mm/transparent_hugepage/enabled"] }] : [{ log: ["echo madvise > /sys/kernel/mm/transparent_hugepage/enabled"] }, { log: ["echo never > /sys/kernel/mm/transparent_hugepage/enabled", "echo 'w /sys/kernel/mm/transparent_hugepage/enabled - - - - never' > /etc/tmpfiles.d/thp.conf"] }],
      hint: (I) => I.lv === 1 ? "The store's own log tells you what it wants." : I.lv === 2 ? "Two consumers want different things. One THP mode applies huge pages only where a process asks for them with madvise. Check defrag too." : "Writes to /sys don't survive a reboot.",
      concept: "Transparent Huge Pages",
      how: "THP backs anonymous memory with 2 MiB pages to cut TLB misses. With enabled=always, any large allocation may take a huge-page fault; if no free 2 MiB block exists, defrag settings decide whether the faulting thread stalls in direct compaction (compact_stall in /proc/vmstat). After fork(), copy-on-write duplicates whole 2 MiB pages, so snapshotting stores see latency and memory spikes. enabled=madvise gives huge pages only to regions a process marks with madvise(MADV_HUGEPAGE), which is what JVMs with -XX:+UseTransparentHugePages do. /sys settings are reset at boot; persist them with a tmpfiles.d 'w' line, a unit, or transparent_hugepage= on the kernel command line.",
      rule: "Default latency-sensitive hosts to THP enabled=madvise with defrag=madvise (or defer+madvise), let applications opt in, and persist the setting in the image.",
      why: (I) => I.lv === 1 ? `THP was 'always' and compact_stall had reached ${K.num(I.stall)}: allocations stalled in compaction and every snapshot fork copied 2 MiB pages. 'never' (or 'madvise', since the store doesn't madvise) removes both.` : I.lv === 2 ? "enabled=madvise keeps huge pages for the JVM sidecar (which madvises its heap) and off for the store; defrag=always had been making the JVM's faults stall in direct compaction, so it goes back to the default madvise." : "madvise live, plus a tmpfiles.d 'w' entry so systemd-tmpfiles writes it at every boot (the kernel argument transparent_hugepage=madvise works too). 'never' would have cost the JVM sidecars their huge pages on all 200 hosts.",
    },
    /* ======================================================================== */
    {
      id: "linux-container-memory",
      name: "Memory alert: leak or cache?",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "Mostly page cache from log and file writes: reclaimable, so the working set is far below the limit and nothing is at risk", ["A memory leak in the app; restart it", "The limit is too low; double it", "A memory-backed tmpfs is filling up"]);
        else if (lv === 2) o = mkOpts(R, "Anonymous memory keeps growing: a real leak in the process heap, already causing OOM kills", ["Page cache; the kernel will reclaim it", "A tmpfs volume is filling up", "Kernel slab memory leak"]);
        else o = mkOpts(R, "Files in a memory-backed tmpfs (emptyDir medium: Memory) count as shmem and can't be reclaimed without swap", ["Page cache from file reads; it will be reclaimed", "An anonymous-memory leak in the app", "Kernel slab memory leak"]);
        return { lv, ...o, pod: `${R.pick(["exporter", "thumbs", "etl"])}-${R.int(5, 9)}f${R.int(10, 99)}-${R.pick(["kq2x", "p0w9", "zz81"])}`, anon: lv === 2 ? R.int(1680, 1760) : R.int(360, 420), shm: R.int(1250, 1400), miss: lv === 1 ? "memory.current includes page cache. Which part of memory.stat is reclaimable?" : lv === 3 ? "file includes shmem. Where does shmem come from in a container?" : "Which counter in memory.stat is growing, and are there OOM kills already?" };
      },
      text: (I) => `<p><b>ALERT:</b> pod <code>${I.pod}</code> memory is at <b>${I.lv === 2 ? 97 : 95}%</b> of its 2 GiB limit. ${I.lv === 1 ? "It writes a lot of log and export files to its volume." : I.lv === 2 ? "It has restarted twice today." : "It renders reports into a scratch directory; the alert started after a change that moved scratch from disk to an <code>emptyDir</code> with <code>medium: Memory</code> for speed."}</p><p>You have a shell in the container. Is this a problem, and why?</p>`,
      ...LB.term({
        shell(I) {
          const MiB = 1048576;
          const file = I.lv === 1 ? 1510 : I.lv === 2 ? 118 : I.shm + 160;
          const inact = I.lv === 1 ? 1310 : I.lv === 2 ? 60 : 90;
          const cur = I.anon + file + 42;
          const sh = K.shell([
            { re: /^cat \/sys\/fs\/cgroup\/memory\.(current|max|events|peak|pressure)$/, use: "cat /sys/fs/cgroup/memory.current | memory.max | memory.events", desc: "", run: (m) => ({ current: String(cur * MiB), max: String(2048 * MiB), peak: String(2046 * MiB), events: `low 0\nhigh 0\nmax ${I.lv === 2 ? 30211 : 8120}\noom ${I.lv === 2 ? 2 : 0}\noom_kill ${I.lv === 2 ? 2 : 0}\noom_group_kill 0`, pressure: `some avg10=${I.lv === 1 ? "0.00" : "4.12"} avg60=${I.lv === 1 ? "0.00" : "3.80"} avg300=1.02 total=812211\nfull avg10=0.00 avg60=${I.lv === 1 ? "0.00" : "1.10"} avg300=0.40 total=212211` })[m[1]] },
            { re: /^(?:cat|grep (?:-E )?\S+) \/sys\/fs\/cgroup\/memory\.stat(?: \| (?:head|grep).*)?$/, use: "cat /sys/fs/cgroup/memory.stat", desc: "breakdown (bytes)", run: () => [["anon", I.anon], ["file", file], ["kernel", 38], ["kernel_stack", 2], ["pagetables", 4], ["shmem", I.lv === 3 ? I.shm : 0], ["file_mapped", 22], ["file_dirty", I.lv === 1 ? 12 : 0], ["file_writeback", 0], ["active_anon", Math.round(I.anon * 0.95)], ["inactive_anon", Math.round(I.anon * 0.05) + (I.lv === 3 ? I.shm : 0)], ["active_file", file - inact - (I.lv === 3 ? I.shm : 0)], ["inactive_file", inact], ["unevictable", 0], ["slab_reclaimable", 18], ["slab_unreclaimable", 9]].map(([k, v]) => `${k} ${v * MiB}`).join("\n") },
            { re: /^ps (?:aux|-eo \S+)(?: .*)?$/, use: "ps aux --sort=-rss", desc: "", run: () => `USER  PID %MEM    RSS COMMAND\napp     1  ${(I.anon / 20.48).toFixed(1)} ${I.anon * 1024} /app/server\napp    37   0.1   2210 /bin/sh` },
            { re: /^df(?: -\w+)*(?: \S+)*$/, use: "df -h", desc: "", run: () => K.cols([DFH, ["overlay", "96G", "41G", "51G", "45%", "/"], ["tmpfs", "64M", "0", "64M", "0%", "/dev"], ["/dev/nvme1n1", "50G", "12G", "38G", "24%", "/data"], ...(I.lv === 3 ? [["tmpfs", "2.0G", hs(I.shm), hs(2048 - I.shm), Math.ceil(I.shm / 20.48) + "%", "/scratch"]] : []), ["shm", "64M", "0", "64M", "0%", "/dev/shm"]]) },
            { re: /^(?:mount|findmnt)(?: .*)?$/, use: "findmnt", desc: "", run: () => `/        overlay   overlay rw,relatime\n/data    /dev/nvme1n1 ext4 rw,relatime${I.lv === 3 ? "\n/scratch tmpfs     tmpfs   rw,relatime,size=2097152k" : ""}` },
            { re: /^du (?:-\w+ )*(\S+)$/, use: "du -sh <dir>", desc: "", run: (m) => (I.lv === 3 && m[1].startsWith("/scratch") ? `${hs(I.shm)}\t/scratch` : `${I.lv === 1 ? "11G" : "1.2G"}\t${m[1]}`) },
          ]);
          return { prompt: `app@${I.pod}:/$`, init: {}, run: (l, st) => sh.run(l, st), par: 5, cmds: ["cat /sys/fs/cgroup/memory.current", "cat /sys/fs/cgroup/memory.max", "cat /sys/fs/cgroup/memory.stat", "cat /sys/fs/cgroup/memory.events", "ps aux --sort=-rss", "df -h"], opts: I.opts, optq: "Diagnosis" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["cat /sys/fs/cgroup/memory.current", "cat /sys/fs/cgroup/memory.stat", ...(I.lv === 2 ? ["cat /sys/fs/cgroup/memory.events"] : I.lv === 3 ? ["df -h"] : [])], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["cat /sys/fs/cgroup/memory.current"], pick: (I.ans + 1) % 4 }, { log: ["cat /sys/fs/cgroup/memory.stat"], pick: (I.ans + 2) % 4 }],
      hint: (I) => I.lv === 1 ? "memory.current counts page cache too. The kubelet's 'working set' is usage minus inactive_file." : I.lv === 2 ? "anon is memory the process allocated itself. Check memory.events for oom_kill." : "tmpfs pages are counted as shmem (inside 'file'), but they have no disk to be written back to.",
      concept: "Container memory: working set vs cache",
      how: "A cgroup's memory.current includes anonymous memory (heaps, stacks), page cache for files it read or wrote, tmpfs/shmem, and some kernel memory. Clean page cache is reclaimed when the cgroup nears memory.max, so a container sitting at 95% mostly in inactive_file is fine; Kubernetes uses the working set (usage minus inactive_file) for eviction. Anonymous memory and shmem can only be reclaimed by swapping, and most containers have no swap, so their growth leads to OOM kills (memory.events oom_kill). An emptyDir with medium: Memory is a tmpfs whose files are charged to the pod as shmem.",
      rule: "Alert on working set (anon + shmem + active file), not on usage including cache. Treat steady anon growth as a leak, and size memory limits to include any memory-backed volumes.",
      why: (I) => I.lv === 1 ? `Of ~${K.num(I.anon + 1552)} MiB in use, 1,310 MiB was inactive_file (clean page cache from export files); anon was only ${I.anon} MiB and there were no OOM kills. The alert was on the wrong metric.` : I.lv === 2 ? `anon was ${K.num(I.anon)} MiB of the 2 GiB limit, page cache was tiny, and memory.events showed oom_kill 2: the heap is leaking. Get a heap profile; raising the limit only delays the next kill.` : `${K.num(I.shm)} MiB sat in /scratch, a tmpfs (emptyDir medium: Memory), counted as shmem: it looks like 'file' memory but can't be reclaimed without swap. Clean up scratch files, cap it with sizeLimit, or put scratch back on disk.`,
    },
    /* ======================================================================== */
    {
      id: "linux-tmp-noexec",
      name: "Permission denied, as root",
      kind: "Hardening",
      skills: ["diagnose", "safe"],
      gen(lv, R) { return { lv, host: `${R.pick(["app", "batch", "api"])}-${R.int(1, 40)}`, rnd: R.pick(["Xy12", "k9Qe", "b7Tm", "Pz40"]), svc: R.pick(["ledger", "search", "pricing"]) }; },
      text: (I) => I.lv === 3 ? `<p><b>PAGE:</b> after the CIS hardening baseline was applied to <code>${I.host}</code>, <code>${I.svc}.service</code> (a Java service using Netty's native epoll transport) fails to start.</p><p>Get it running <b>without weakening the hardening</b>. It runs as user <code>app</code>.</p>` : `<p>You're installing the monitoring agent on <code>${I.host}</code> as root, following the vendor's instructions: <code>/tmp/agent-install/install.sh</code>. It fails with <code>Permission denied</code>. ${I.lv === 2 ? "This host has the full CIS hardening baseline applied." : ""}</p><p>Get the agent installed <b>without weakening the host's hardening</b>.</p>`,
      ...LB.term({
        shell(I) {
          const noexec = (p) => /^\/tmp(\/|$)/.test(p) || /^\/dev\/shm(\/|$)/.test(p) || (I.lv >= 2 && /^\/var\/tmp(\/|$)/.test(p));
          const S = I.svc;
          const sh = K.shell([
            { re: /^\/tmp\/agent-install\/install\.sh$|^\.\/install\.sh$/, use: "/tmp/agent-install/install.sh", desc: "", run: () => "-bash: /tmp/agent-install/install.sh: Permission denied" },
            { re: /^(?:TMPDIR=(\S+) )?(?:bash|sh) \/tmp\/agent-install\/install\.sh$/, use: "[TMPDIR=<dir>] bash /tmp/agent-install/install.sh", desc: "run the installer through the shell", run: (m, st) => {
              const t = (m[1] || "/tmp").replace(/\/$/, "");
              if (I.lv === 3) return "agent already installed";
              if (t !== "/tmp" && t !== "/var/tmp" && !st.dirs.includes(t)) return `mktemp: failed to create directory via template '${t}/agent.XXXXXXXX': No such file or directory`;
              if (noexec(t)) return `Extracting agent to ${t}/agent.${I.rnd} ...\n/tmp/agent-install/install.sh: line 41: ${t}/agent.${I.rnd}/agentctl: Permission denied\ninstall failed (exit 126)`;
              st.ok = true;
              return `Extracting agent to ${t}/agent.${I.rnd} ...\nRunning ${t}/agent.${I.rnd}/agentctl install --prefix /opt/agent\nInstalled agent 7.4.2 to /opt/agent\nCreated symlink /etc/systemd/system/multi-user.target.wants/agent.service → /etc/systemd/system/agent.service.\nCleaning up ${t}/agent.${I.rnd}`;
            } },
            { re: /^ls -l\w* (\S+)$/, use: "ls -l <path>", desc: "", run: (m, st) => m[1].startsWith("/tmp/agent-install") ? "-rwxr-xr-x 1 root root 4211 Oct 11 03:02 install.sh\n-rw-r--r-- 1 root root 31M Oct 11 03:02 agent-7.4.2.tar.gz" : m[1].startsWith("/var/lib/app") ? (st.dirs.includes("/var/lib/app/tmp") ? `drwxr-x--- 2 ${st.owner} ${st.owner} 4096 Oct 11 03:20 tmp` : "drwxr-x--- 4 app app 4096 Sep 2 10:01 data") : `ls: cannot access '${m[1]}': No such file or directory` },
            { re: /^(?:findmnt(?: \S+)?|mount(?: \| grep \S+)?)$/, use: "findmnt /tmp", desc: "mount options", run: () => `TARGET   SOURCE    FSTYPE OPTIONS\n/tmp     tmpfs     tmpfs  rw,nosuid,nodev,noexec,relatime,size=2G\n/dev/shm tmpfs     tmpfs  rw,nosuid,nodev,noexec\n${I.lv >= 2 ? "/var/tmp /dev/nvme0n1p3 ext4 rw,nosuid,nodev,noexec,relatime" : "/var/tmp (part of /, no special options)"}` },
            { re: /^id(?: \S+)?$|^whoami$/, use: "id", desc: "", run: () => "uid=0(root) gid=0(root) groups=0(root)" },
            { re: /^mount -o remount,exec (\S+)$/, use: "mount -o remount,exec <mountpoint>", desc: "", run: (m, st) => { st.broke = `Remounting ${esc(m[1])} with exec undoes a hardening control (noexec on world-writable temp directories is there to stop dropped payloads from running). The task said not to weaken it.`; return { out: "", danger: "Removed noexec from a hardened mount." }; } },
            { re: /^mkdir (?:-p )?(\S+?)\/?$/, use: "mkdir -p <dir>", desc: "", run: (m, st) => { st.dirs.push(m[1]); st.owner = "root"; return ""; } },
            { re: /^install -d(?: -m ?\d+)? -o (\w+) -g (\w+)(?: -m ?\d+)? (\S+?)\/?$/, use: "install -d -o <user> -g <group> <dir>", desc: "create a directory with owner", run: (m, st) => { st.dirs.push(m[3]); st.owner = m[1]; return ""; } },
            { re: /^chown (?:-R )?(\w+)(?::\w+)? (\S+?)\/?$/, use: "chown <user>:<group> <dir>", desc: "", run: (m, st) => { if (!st.dirs.includes(m[2])) return `chown: cannot access '${m[2]}': No such file or directory`; st.owner = m[1]; return ""; } },
            ...(I.lv === 3 ? [
              { re: new RegExp(`^journalctl -u ${S}(?:\\.service)?(?: .*)?$`), use: `journalctl -u ${S} -n 20`, desc: "", run: (m, st) => st.running ? `${S}[4411]: Started ${S} in 3.2 seconds` : st.permFail ? `${S}[4410]: java.io.IOException: Permission denied\n${S}[4410]:   at java.base/java.io.UnixFileSystem.createFileExclusively0(Native Method)\n${S}[4410]:   at io.netty.util.internal.PlatformDependent.createTempFile(PlatformDependent.java:1525)` : `${S}[4410]: java.lang.UnsatisfiedLinkError: /tmp/libnetty_transport_native_epoll_x86_644417291.so: /tmp/libnetty_transport_native_epoll_x86_644417291.so: failed to map segment from shared object\n${S}[4410]:   at io.netty.util.internal.NativeLibraryLoader.load(NativeLibraryLoader.java:...)\nsystemd[1]: ${S}.service: Main process exited, code=exited, status=1/FAILURE` },
              { re: new RegExp(`^systemctl cat ${S}(?:\\.service)?$`), use: `systemctl cat ${S}`, desc: "", run: (m, st) => `# /etc/systemd/system/${S}.service\n[Service]\nUser=app\nExecStart=/usr/bin/java -jar /opt/${S}/${S}.jar\nRestart=on-failure${st.drop ? `\n\n# /etc/systemd/system/${S}.service.d/tmpdir.conf\n[Service]\nEnvironment=${st.drop}` : ""}` },
              { re: /^(?:printf|echo).*$/, use: `printf '[Service]\\nEnvironment=JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=<dir>\\n' > /etc/systemd/system/${S}.service.d/tmpdir.conf`, desc: "systemd drop-in", run: (m, st, l) => { const d = dropIn(l); if (!d || d.unit !== S) return "(nothing written: use printf '...' > /etc/systemd/system/<unit>.service.d/<name>.conf)"; if (d.kv.Environment) { st.drop = d.kv.Environment; st.reloaded = false; } return ""; } },
              { re: /^systemctl daemon-reload$/, use: "systemctl daemon-reload", desc: "", run: (m, st) => { st.reloaded = true; return ""; } },
              { re: new RegExp(`^systemctl (?:re)?start ${S}(?:\\.service)?$`), use: `systemctl restart ${S}`, desc: "", run: (m, st) => {
                const tm = st.reloaded && st.drop ? (st.drop.match(/-Djava\.io\.tmpdir=(\S+)/) || st.drop.match(/-Dio\.netty\.native\.workdir=(\S+)/) || [])[1] : null;
                const dir = tm ? tm.replace(/['"]/g, "").replace(/\/$/, "") : "/tmp";
                st.permFail = false;
                if (noexec(dir)) return (st.drop && !st.reloaded ? reloadWarn(S) + "\n" : "") + `Job for ${S}.service failed: see journalctl -u ${S}`;
                if (!st.dirs.includes(dir) || st.owner !== "app") { st.permFail = true; return `Job for ${S}.service failed: see journalctl -u ${S}`; }
                st.running = true; return "";
              } },
            ] : []),
          ]);
          return { prompt: `root@${I.host}:~#`, init: { ok: false, dirs: [], owner: "root", broke: null, running: false, drop: null, reloaded: false }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 9 : 6, cmds: I.lv === 3 ? [`journalctl -u ${S} -n 20`, "findmnt /tmp", `systemctl cat ${S}`, "install -d -o <user> -g <group> <dir>", `printf '[Service]\\nEnvironment=JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=<dir>\\n' > /etc/systemd/system/${S}.service.d/tmpdir.conf`, "systemctl daemon-reload", `systemctl restart ${S}`] : ["/tmp/agent-install/install.sh", "ls -l /tmp/agent-install", "findmnt /tmp", "bash /tmp/agent-install/install.sh", "mkdir -p <dir>", "TMPDIR=<dir> bash /tmp/agent-install/install.sh", "mount -o remount,exec /tmp"] };
        },
        goal(st, I) {
          if (st.broke) return st.broke;
          if (I.lv === 3) return st.running ? true : `${I.svc} still fails to start.`;
          return st.ok ? true : "The agent isn't installed yet.";
        },
        solve: (I) => I.lv === 1 ? { log: ["/tmp/agent-install/install.sh", "findmnt /tmp", "bash /tmp/agent-install/install.sh", "TMPDIR=/var/tmp bash /tmp/agent-install/install.sh"] } : I.lv === 2 ? { log: ["findmnt /tmp", "bash /tmp/agent-install/install.sh", "mkdir -p /opt/agent/tmp", "TMPDIR=/opt/agent/tmp bash /tmp/agent-install/install.sh"] } : { log: [`journalctl -u ${I.svc} -n 20`, "findmnt /tmp", "install -d -o app -g app -m 750 /var/lib/app/tmp", `printf '[Service]\\nEnvironment=JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=/var/lib/app/tmp\\n' > /etc/systemd/system/${I.svc}.service.d/tmpdir.conf`, "systemctl daemon-reload", `systemctl restart ${I.svc}`] },
      }),
      bad: (I) => I.lv === 3 ? [{ log: ["mkdir -p /var/lib/app/tmp", `printf '[Service]\\nEnvironment=JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=/var/lib/app/tmp\\n' > /etc/systemd/system/${I.svc}.service.d/tmpdir.conf`, "systemctl daemon-reload", `systemctl restart ${I.svc}`] }, { log: ["mount -o remount,exec /tmp", `systemctl restart ${I.svc}`] }] : I.lv === 2 ? [{ log: ["TMPDIR=/var/tmp bash /tmp/agent-install/install.sh"] }, { log: ["mount -o remount,exec /tmp", "bash /tmp/agent-install/install.sh"] }] : [{ log: ["bash /tmp/agent-install/install.sh"] }, { log: ["mount -o remount,exec /tmp", "/tmp/agent-install/install.sh"] }],
      hint: (I) => I.lv === 1 ? "Root can't execute files on a filesystem mounted noexec. Check the mount options; most installers honour TMPDIR." : I.lv === 2 ? "Every standard temp directory is noexec here. Make your own working directory on a filesystem that allows exec." : "The JVM extracts the native library into java.io.tmpdir and maps it executable. Point that somewhere exec-capable that the service user can write.",
      concept: "noexec mounts and temp directories",
      how: "Hardening baselines mount /tmp, /var/tmp and /dev/shm with noexec, nosuid and nodev, so files there can't be executed (execve and executable mmap fail with EACCES) even by root, which blocks a common path for dropped payloads. Running a script through its interpreter (bash script.sh) bypasses noexec for the script itself, but anything it extracts and runs from /tmp still fails. Most tools honour TMPDIR; the JVM uses java.io.tmpdir, where libraries such as Netty extract native .so files. The fix is a dedicated, exec-capable directory owned by the service user, not removing the mount option.",
      rule: "Keep noexec on shared temp directories. Give installers and services their own working directory (TMPDIR, java.io.tmpdir, or systemd's StateDirectory=/CacheDirectory=) on an exec-capable filesystem.",
      why: (I) => I.lv === 1 ? "/tmp is mounted noexec, so neither install.sh nor the agentctl binary it extracted could run. /var/tmp on this host allows exec, so TMPDIR=/var/tmp made the installer work with /tmp still locked down." : I.lv === 2 ? "/tmp, /var/tmp and /dev/shm are all noexec under the full baseline, so the installer needed its own directory: TMPDIR=/opt/agent/tmp (created first; mktemp won't create parents)." : `Netty copies its epoll .so into java.io.tmpdir (/tmp) and mmaps it executable: 'failed to map segment from shared object' is noexec. A directory owned by app (install -d -o app) plus JAVA_TOOL_OPTIONS=-Djava.io.tmpdir in a drop-in fixed it; a root-owned directory fails with Permission denied instead.`,
    },
    /* ======================================================================== */
    {
      id: "linux-core-dumps",
      name: "Segfault: where's the core?",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "A segfault inside libpng (png_read_row) while generating a PNG thumbnail", ["A segfault in the JPEG decoder", "The kernel OOM killer", "An abort() from glibc's malloc"]);
        else if (lv === 2) o = mkOpts(R, "The unit sets LimitCORE=0, so the kernel never writes a core and systemd-coredump receives nothing", ["core_pattern points to a directory that doesn't exist", "systemd-coredump is disabled on this host", "Segfaults don't produce core dumps"]);
        else o = mkOpts(R, "glibc detected heap corruption in free(); the crash site is a victim of an earlier bad write or double free. Reproduce under AddressSanitizer or valgrind", ["A bug in glibc's malloc: upgrade glibc", "The Session destructor is the bug: delete the free() call", "The process ran out of memory"]);
        return { lv, ...o, pid: R.int(2000, 60000), host: `${R.pick(["img", "media", "render"])}-${R.int(1, 20)}`, miss: lv === 3 ? "Signal 6 (ABRT) with malloc_printerr in the stack means glibc noticed corruption; who caused it?" : lv === 2 ? "Check the core size limit of the service, not of your shell." : "Read the stack trace from frame #0 down." };
      },
      text: (I) => `<p><b>PAGE:</b> <code>imgproc.service</code> on <code>${I.host}</code> crashes a few times an hour. ${I.lv === 2 ? "A developer looked for <code>core</code> files in the working directory and in <code>/var/lib/systemd/coredump</code>: nothing." : "The developers ask for the crash location."}</p><p>Find out ${I.lv === 2 ? "why there's no core dump" : "what crashed and where"}.</p>`,
      ...LB.term({
        shell(I) {
          const P = I.pid;
          const sig = I.lv === 3 ? "6/ABRT" : "11/SEGV";
          const stack = I.lv === 1 ? ["#0  0x00007f3a91e2c4d1 png_read_row (libpng16.so.16 + 0x1e4d1)", "#1  0x00007f3a91e2d0a2 png_read_image (libpng16.so.16 + 0x1f0a2)", "#2  0x000055d1c2a1f3e0 thumbnail_png (imgproc + 0x1f3e0)", "#3  0x000055d1c2a1a812 handle_job (imgproc + 0x1a812)", "#4  0x00007f3a91a94ac3 start_thread (libc.so.6 + 0x94ac3)"]
            : ["#0  0x00007f3a91a969fc __pthread_kill_implementation (libc.so.6 + 0x969fc)", "#1  0x00007f3a91a42476 raise (libc.so.6 + 0x42476)", "#2  0x00007f3a91a287f3 abort (libc.so.6 + 0x287f3)", "#3  0x00007f3a91a89676 __libc_message (libc.so.6 + 0x89676)", "#4  0x00007f3a91aa0cfc malloc_printerr (libc.so.6 + 0xa0cfc)", "#5  0x00007f3a91aa2a9d _int_free (libc.so.6 + 0xa2a9d)", "#6  0x00007f3a91aa54c3 free (libc.so.6 + 0xa54c3)", "#7  0x000055d1c2a20b11 Session::~Session() (imgproc + 0x20b11)", "#8  0x000055d1c2a1a9f0 handle_job (imgproc + 0x1a9f0)"];
          const sh = K.shell([
            { re: /^journalctl -u imgproc(?:\.service)?(?: .*)?$/, use: "journalctl -u imgproc -n 20", desc: "", run: () => `${I.lv === 3 ? `Oct 11 03:12:44 ${I.host} imgproc[${P}]: free(): invalid pointer\n` : ""}Oct 11 03:12:44 ${I.host} systemd[1]: imgproc.service: Main process exited, code=${I.lv === 2 ? "killed" : "dumped"}, status=${sig}\nOct 11 03:12:44 ${I.host} systemd[1]: imgproc.service: Failed with result '${I.lv === 2 ? "signal" : "core-dump"}'.\nOct 11 03:12:46 ${I.host} systemd[1]: imgproc.service: Scheduled restart job, restart counter is at 14.` },
            { re: /^cat \/proc\/sys\/kernel\/core_pattern$|^sysctl kernel\.core_pattern$/, use: "cat /proc/sys/kernel/core_pattern", desc: "where the kernel sends cores", run: () => "|/usr/lib/systemd/systemd-coredump %P %u %g %s %t %c %h" },
            { re: /^coredumpctl(?: list)?(?: \S+)?$/, use: "coredumpctl list imgproc", desc: "", run: () => I.lv === 2 ? "No coredumps found." : `TIME                          PID  UID  GID SIG     COREFILE EXE                      SIZE\nSat 2026-10-11 03:12:44 UTC ${P}  998  998 SIG${I.lv === 3 ? "ABRT" : "SEGV"} present  /opt/imgproc/bin/imgproc 41.2M` },
            { re: /^coredumpctl info(?: (\d+|imgproc))?$/, use: "coredumpctl info <pid>", desc: "metadata and stack trace", run: () => I.lv === 2 ? "No coredumps found." : `           PID: ${P} (imgproc)\n        Signal: ${I.lv === 3 ? "6 (ABRT)" : "11 (SEGV)"}\n    Executable: /opt/imgproc/bin/imgproc\n       Storage: /var/lib/systemd/coredump/core.imgproc.998.….zst (present)\n       Message: Process ${P} (imgproc) of user 998 dumped core.\n\n                Stack trace of thread ${P + 3}:\n                ${stack.join("\n                ")}` },
            { re: /^(?:cat|grep -i core) \/proc\/(\d+)\/limits$|^grep -i core \/proc\/(\d+)\/limits$/, use: "grep -i core /proc/<pid>/limits", desc: "the service's core size limit", run: () => `Limit                     Soft Limit           Hard Limit           Units\nMax core file size        ${I.lv === 2 ? "0                    0" : "unlimited            unlimited"}                    bytes` },
            { re: /^(?:pgrep -f imgproc|pidof imgproc|systemctl status imgproc)$/, use: "pgrep -f imgproc", desc: "", run: () => String(P + 40) },
            { re: /^systemctl cat imgproc(?:\.service)?$/, use: "systemctl cat imgproc", desc: "", run: () => `# /etc/systemd/system/imgproc.service\n[Service]\nUser=imgproc\nExecStart=/opt/imgproc/bin/imgproc --workers 8\nRestart=always\n${I.lv === 2 ? "LimitCORE=0\n" : ""}` },
            { re: /^ulimit -c$/, use: "ulimit -c", desc: "your shell's core limit", run: () => "unlimited" },
            { re: /^ls (?:-\w+ )*(\S+)$/, use: "ls -l /var/lib/systemd/coredump", desc: "", run: (m) => /coredump/.test(m[1]) ? (I.lv === 2 ? "total 0" : `-rw-r----- 1 root root 41M Oct 11 03:12 core.imgproc.998.….zst`) : "total 0" },
          ]);
          return { prompt: `root@${I.host}:~#`, init: {}, run: (l, st) => sh.run(l, st), par: 5, cmds: ["journalctl -u imgproc -n 20", "cat /proc/sys/kernel/core_pattern", "coredumpctl list imgproc", "coredumpctl info <pid>", "grep -i core /proc/<pid>/limits", "systemctl cat imgproc", "ulimit -c"], opts: I.opts, optq: I.lv === 2 ? "Why no core" : "What happened" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["journalctl -u imgproc -n 20", ...(I.lv === 2 ? ["coredumpctl list imgproc", `grep -i core /proc/${I.pid + 40}/limits`, "systemctl cat imgproc"] : ["coredumpctl list imgproc", `coredumpctl info ${I.pid}`])], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["coredumpctl list imgproc"], pick: (I.ans + 1) % 4 }, { log: [], pick: (I.ans + 3) % 4 }],
      hint: (I) => I.lv === 1 ? "With core_pattern piped to systemd-coredump, cores aren't in the working directory: coredumpctl finds them." : I.lv === 2 ? "Your shell's ulimit -c says nothing about the service. Read /proc/<pid>/limits of the service and its unit file." : "SIGABRT from inside free() means glibc's consistency check failed. Is free() the bug, or the witness?",
      concept: "Getting and reading core dumps",
      how: "When a process dies from SIGSEGV, SIGABRT and similar, the kernel writes a core if RLIMIT_CORE allows it, to the path or pipe in /proc/sys/kernel/core_pattern. On systemd hosts that's usually a pipe to systemd-coredump, which stores compressed cores under /var/lib/systemd/coredump; coredumpctl list/info/debug finds them and prints a stack trace. A service's limit comes from LimitCORE= in its unit, not your shell's ulimit -c. A SIGABRT with malloc_printerr/_int_free in the stack means glibc detected heap corruption: the real bug (overflow, use-after-free, double free) happened earlier, so tools like AddressSanitizer or valgrind are needed to catch it at the source.",
      rule: "Make sure services can dump core (LimitCORE, core_pattern, disk space for cores, and access control since cores contain secrets), use coredumpctl to read them, and treat heap-corruption aborts as 'find the earlier writer', not 'fix the frame that crashed'.",
      why: (I) => I.lv === 1 ? `coredumpctl had the core (systemd-coredump caught it via core_pattern). The trace shows SIGSEGV in png_read_row in libpng16, called from thumbnail_png: a malformed PNG or a buffer sized wrong for the image's rows.` : I.lv === 2 ? "core_pattern pipes to systemd-coredump, but the unit sets LimitCORE=0 (soft and hard 0 in /proc/PID/limits), so the kernel never produced a core: the journal says code=killed, not code=dumped. Set LimitCORE=infinity (and mind disk space and who can read cores)." : "glibc printed 'free(): invalid pointer' and aborted (SIGABRT) from malloc_printerr inside free() in Session::~Session. The heap was already corrupted, by a double free or an overflow elsewhere, so a build with -fsanitize=address will show the real culprit at the moment it happens.",
    },
    /* ======================================================================== */
    {
      id: "linux-perf-hot-path",
      name: "CPU pegged: find the hot path",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "std::regex's backtracking executor in validate_email() is burning the CPU in user space", ["Lock contention in the kernel", "Memory allocation (malloc) overhead", "Page faults from a cold cache"]);
        else if (lv === 2) o = mkOpts(R, "Threads fight over one global mutex (StatsRegistry::increment); the kernel time is futex contention, a symptom of that lock", ["A kernel bug in the scheduler; upgrade the kernel", "Network interrupt load (softirq)", "malloc arena contention"]);
        else o = mkOpts(R, "The kernel marked the TSC unstable and switched to HPET; clock_gettime can't use the fast vDSO path, so every timestamp is a slow syscall", ["The app reads the clock too often; remove timestamps from logs", "Contention on a global mutex", "A memory leak causing constant page faults"]);
        return { lv, ...o, pid: R.int(2000, 60000), svc: R.pick(["matcher", "quote-engine", "risk-svc"]), sys: R.int(36, 46), miss: lv === 1 ? "The top symbol is in user space ([.]); what calls it?" : lv === 2 ? "Kernel spinlock time under futex calls comes from user-space locks. Which lock?" : "Why would clock_gettime enter the kernel at all? Check the clocksource." };
      },
      text: (I) => `<p><b>PAGE:</b> <code>${I.svc}</code> (C++, built with frame pointers) uses ${I.lv === 1 ? "100% of 8 cores" : `8 cores, about ${I.sys}% of it system time`} at normal traffic; latency tripled ${I.lv === 3 ? "after the host was live-migrated last night" : I.lv === 2 ? "after a release that added more metrics" : "since a release that added stricter input validation"}.</p><p>Profile it and pick the root cause.</p>`,
      ...LB.term({
        shell(I) {
          const P = I.pid, S = I.svc;
          const rep = I.lv === 1 ? [
            `    61.22%  ${S}  ${S}            [.] std::__detail::_Executor<…, true>::_M_dfs`, "            |", "            ---_M_dfs", "               _M_dfs", "               std::regex_match<…>", `               validate_email(std::string const&)`, "               handle_signup",
            `     7.10%  ${S}  libc.so.6        [.] __memmove_avx_unaligned_erms`, `     5.31%  ${S}  libc.so.6        [.] _int_malloc`, `     3.02%  ${S}  [kernel.kallsyms] [k] clear_page_erms`]
            : I.lv === 2 ? [
              `    38.41%  ${S}  [kernel.kallsyms] [k] native_queued_spin_lock_slowpath`, "            |", "            ---native_queued_spin_lock_slowpath", "               _raw_spin_lock", "               futex_wait / futex_wake", "               do_futex", "               __x64_sys_futex", "               __lll_lock_wait (libc.so.6)", "               pthread_mutex_lock", "               StatsRegistry::increment(char const*)",
              `    11.70%  ${S}  [kernel.kallsyms] [k] __schedule`, `     6.12%  ${S}  ${S}            [.] Matcher::score`, `     2.40%  ${S}  libc.so.6        [.] _int_malloc`]
              : [
                `    31.82%  ${S}  [kernel.kallsyms] [k] read_hpet`, "            |", "            ---read_hpet", "               ktime_get_ts64", "               posix_get_monotonic_timespec", "               __x64_sys_clock_gettime", "               do_syscall_64", "               entry_SYSCALL_64_after_hwframe", "               clock_gettime (libc.so.6)", "               std::chrono::steady_clock::now()", "               Tracer::span_start",
                `     8.20%  ${S}  [kernel.kallsyms] [k] syscall_return_via_sysret`, `     6.01%  ${S}  ${S}            [.] Quote::price`, `     2.10%  ${S}  [kernel.kallsyms] [k] entry_SYSCALL_64`];
          const sh = K.shell([
            { re: /^top(?: -\w+)*(?: \| head(?: -n ?\d+| -\d+)?)?$/, use: "top -bn1 | head -12", desc: "", run: () => `%Cpu(s): ${I.lv === 1 ? "97.1 us,  2.3 sy" : `${100 - I.sys - 4}.0 us, ${I.sys}.0 sy`},  0.0 ni,  0.4 id,  0.0 wa,  0.0 hi,  0.2 si,  0.0 st\n    PID USER   PR  NI    VIRT    RES  %CPU  S COMMAND\n   ${P} app    20   0 4122110 812211  789.2  S ${S}` },
            { re: /^mpstat(?: -P ALL)?(?: \d+)*$/, use: "mpstat 1 1", desc: "", run: () => `CPU    %usr   %sys  %soft  %idle\nall   ${I.lv === 1 ? "97.10   2.30" : `${(96 - I.sys).toFixed(2)}  ${I.sys}.00`}   0.20   0.40` },
            { re: /^perf top(?: .*)?$/, use: "perf top -p <pid>", desc: "live view of hot symbols", run: () => rep.filter((l) => /%/.test(l)).map((l) => l.replace(/^\s+/, "  ")).join("\n") + "\n(press q)" },
            { re: /^perf record (?:-\w+ ?\d* )*-p ?\d+(?: -g)?(?: -- sleep \d+)?$/, use: "perf record -F 99 -g -p <pid> -- sleep 10", desc: "sample stacks", run: (m, st) => { st.rec = true; return "[ perf record: Woken up 3 times to write data ]\n[ perf record: Captured and wrote 2.418 MB perf.data (7,920 samples) ]"; } },
            { re: /^perf report(?: .*)?$/, use: "perf report --stdio --no-children | head -40", desc: "", run: (m, st) => (st.rec ? `# Samples: 7K of event 'cpu-clock:pppH'\n# Overhead  Command  Shared Object     Symbol\n#\n${rep.join("\n")}` : "failed to open perf.data: No such file or directory  (try 'perf record' first)") },
            { re: /^(?:dmesg(?: .*)?|journalctl -k(?: .*)?)$/, use: "dmesg -T | grep -i clocksource", desc: "", run: () => I.lv === 3 ? "[Sat Oct 11 01:02:11 2026] clocksource: timekeeping watchdog on CPU3: Marking clocksource 'tsc' as unstable because the skew is too large:\n[Sat Oct 11 01:02:11 2026] clocksource:                       'hpet' wd_nsec: 511998213 wd_now: 3a1f2c0 wd_last: 1e4c210 mask: ffffffff\n[Sat Oct 11 01:02:11 2026] tsc: Marking TSC unstable due to clocksource watchdog\n[Sat Oct 11 01:02:11 2026] clocksource: Switched to clocksource hpet" : "[Fri Oct  3 09:12:01 2026] clocksource: Switched to clocksource tsc" },
            { re: /^cat \/sys\/devices\/system\/clocksource\/clocksource0\/(current|available)_clocksource$/, use: "cat /sys/devices/system/clocksource/clocksource0/current_clocksource", desc: "", run: (m) => (m[1] === "current" ? (I.lv === 3 ? "hpet" : "tsc") : "tsc hpet acpi_pm") },
            { re: /^strace -c(?: -f)? -p ?\d+(?: .*)?$/, use: "strace -c -f -p <pid>", desc: "syscall counts", run: () => `% time     seconds  usecs/call     calls    errors syscall\n------ ----------- ----------- --------- --------- ----------------\n${I.lv === 3 ? " 71.20    4.120331           2   1912033           clock_gettime\n 12.10    0.700120          31     22011           sendto" : I.lv === 2 ? " 88.40    9.912011          41    241220     41211 futex\n  4.10    0.460110          21     22011           sendto" : "  61.0    0.212011          10     22011           sendto\n  30.2    0.105120           4     22011           recvfrom"}` },
          ]);
          return { prompt: `root@${S}-4:~#`, init: { rec: false }, run: (l, st) => sh.run(l, st), par: 6, cmds: ["top -bn1 | head -12", "perf top -p <pid>", "perf record -F 99 -g -p <pid> -- sleep 10", "perf report --stdio --no-children | head -40", "strace -c -f -p <pid>", "dmesg -T | grep -i clocksource"], opts: I.opts, optq: "Root cause" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["top -bn1 | head -12", `perf record -F 99 -g -p ${I.pid} -- sleep 10`, "perf report --stdio --no-children | head -40", ...(I.lv === 3 ? ["dmesg -T | grep -i clocksource"] : [])], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["top -bn1 | head -12"], pick: (I.ans + 1) % 4 }, { log: [], pick: (I.ans + 2) % 4 }],
      hint: (I) => I.lv === 1 ? "Sample stacks with perf record -g, then read the report from the top symbol down its call chain." : I.lv === 2 ? "[k] symbols are kernel code. Follow the chain down to the user-space caller." : "clock_gettime is normally answered in user space by the vDSO without a syscall. When can't it be?",
      concept: "CPU profiling with perf",
      how: "perf record -g samples on-CPU stacks (about 99 times a second per CPU); perf report shows where time goes, [.] for user space and [k] for kernel, with call chains (frame pointers or DWARF needed for good stacks). High system time is a symptom: follow the kernel frames down to the user-space call that entered the kernel. Spinlock time under futex calls means contended user-space mutexes. clock_gettime normally runs entirely in user space via the vDSO when the clocksource is the TSC; if the kernel's watchdog marks the TSC unstable (common after VM live migration) and falls back to HPET or acpi_pm, every call becomes a slow syscall plus a slow hardware read.",
      rule: "Profile before guessing: perf record -g, read the hottest stack to its user-space root, and treat high %sys as a pointer to which syscall the app is making too expensively.",
      why: (I) => I.lv === 1 ? "61% of samples were in libstdc++'s std::regex backtracking executor (_M_dfs) under validate_email(). std::regex is notoriously slow and backtracks on some patterns; a hand-written check or a linear-time engine (RE2, Hyperscan) fixes it." : I.lv === 2 ? "38% of CPU was the kernel spinning on futex hash locks, called from pthread_mutex_lock in StatsRegistry::increment: every request on every thread updates metrics behind one mutex. Per-thread or atomic counters remove it." : "After live migration the kernel's clocksource watchdog marked the TSC unstable and switched to HPET. clock_gettime (called ~200k times/s by the tracer) became a syscall reading HPET. Fix the host (or select a stable clocksource such as kvm-clock/tsc where supported) rather than ripping out timestamps.",
    },
    /* ======================================================================== */
    {
      id: "linux-permissions",
      name: "Uploads fail: Permission denied",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) { return { lv, host: `${R.pick(["web", "app"])}-${R.int(1, 20)}`, f: `${R.pick(["invoice", "avatar", "receipt"])}-${R.int(1000, 9999)}.pdf` }; },
      text: (I) => I.lv === 3 ? `<p><b>PAGE:</b> on <code>${I.host}</code> the app (user <code>app</code>) writes uploads to <code>/srv/app/shared/uploads</code> and nginx (user <code>www-data</code>) serves them directly. Since a hardening change set <code>UMask=0077</code> on the app's unit, new uploads return <b>403</b>.</p><p>Make both existing and future uploads readable by nginx, without making them readable by every user on the host.</p>` : `<p><b>PAGE:</b> on <code>${I.host}</code> every upload fails with <code>EACCES: permission denied, open '/srv/app/shared/uploads/${I.f}'</code>. The app runs as user <code>app</code>. ${I.lv === 2 ? "The uploads directory itself is owned by app; someone already checked." : "The directory was recreated by last night's deploy."}</p><p>Fix it with the least privilege necessary.</p>`,
      ...LB.term({
        shell(I) {
          const U = "/srv/app/shared/uploads", SH = "/srv/app/shared";
          const perm = (mode) => ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
          const str = (mode, dir, setgid) => { const p = perm(); const s = (dir ? "d" : "-") + p[(mode >> 6) & 7] + p[(mode >> 3) & 7] + p[mode & 7]; return setgid ? s.slice(0, 6) + (s[6] === "x" ? "s" : "S") + s.slice(7) : s; };
          const applyMode = (cur, spec, isDir) => {
            if (/^[0-7]{3,4}$/.test(spec)) { const n = parseInt(spec, 8); return { m: n & 0o777, sg: spec.length === 4 ? !!(n & 0o2000) : null }; }
            let m = cur, sg = null;
            for (const part of spec.split(",")) {
              const x = part.match(/^([ugoa]*)([+-=])([rwxXs]*)$/); if (!x) return null;
              const who = x[1] || "a", ws = who.includes("a") ? "ugo" : who;
              let bits = 0;
              for (const w of ws) { const sh = w === "u" ? 6 : w === "g" ? 3 : 0; if (x[3].includes("r")) bits |= 4 << sh; if (x[3].includes("w")) bits |= 2 << sh; if (x[3].includes("x") || (x[3].includes("X") && (isDir || cur & 0o111))) bits |= 1 << sh; if (x[3].includes("s") && w === "g") sg = x[2] !== "-"; }
              m = x[2] === "+" ? m | bits : x[2] === "-" ? m & ~bits : bits;
            }
            return { m, sg };
          };
          const nginxGroups = (st) => ["www-data", ...(st.inApp && st.nginxRestarted ? ["app"] : [])];
          const appCanWrite = (st) => { const sh = st.sh, up = st.up; const trav = sh.owner === "app" ? sh.m & 0o100 : sh.group === "app" ? sh.m & 0o010 : sh.m & 0o001; const w = up.owner === "app" ? (up.m & 0o300) === 0o300 : up.group === "app" ? (up.m & 0o030) === 0o030 : (up.m & 0o003) === 0o003; return !!trav && w; };
          const newFile = (st) => ({ group: st.up.sg ? st.up.group : "app", m: 0o666 & ~parseInt(st.umaskLive, 8) });
          const nginxRead = (st, f) => { const g = nginxGroups(st); const dirOk = g.includes(st.up.group) ? st.up.m & 0o010 : st.up.m & 0o001; const fOk = g.includes(f.group) ? f.m & 0o040 : f.m & 0o004; return !!dirOk && !!fOk; };
          const target = (st, p) => (p === U ? "up" : p === SH ? "sh" : p.startsWith(U + "/") ? "files" : null);
          const sh = K.shell([
            { re: /^namei -l (\S+)$/, use: "namei -l <path>", desc: "permissions of every component of a path", run: (m, st) => `f: ${m[1]}\ndrwxr-xr-x root root /\ndrwxr-xr-x root root srv\ndrwxr-xr-x root root app\n${str(st.sh.m, true)} ${st.sh.owner} ${st.sh.group} shared\n${str(st.up.m, true, st.up.sg)} ${st.up.owner} ${st.up.group} uploads${m[1].startsWith(U + "/") ? `\n${str(st.files.m)} app ${st.files.group} ${m[1].split("/").pop()}` : ""}` },
            { re: /^ls -l\w* (\S+?)\/?$/, use: "ls -la <dir>", desc: "", run: (m, st) => { const p = m[1]; if (p === U) return `total 12\n${str(st.up.m, true, st.up.sg)} 2 ${st.up.owner} ${st.up.group} 4096 Oct 11 02:01 .\n${str(st.sh.m, true)} 3 ${st.sh.owner} ${st.sh.group} 4096 Sep  2 10:00 ..${I.lv === 3 ? `\n${str(st.files.m)} 1 app ${st.files.group} 88211 Oct 11 03:02 ${I.f}` : ""}`; if (p === SH) return `total 8\n${str(st.sh.m, true)} 3 ${st.sh.owner} ${st.sh.group} 4096 Sep  2 10:00 .\n${str(st.up.m, true, st.up.sg)} 2 ${st.up.owner} ${st.up.group} 4096 Oct 11 02:01 uploads`; return `ls: cannot access '${p}': Permission denied`; } },
            { re: /^id (\S+)$/, use: "id <user>", desc: "", run: (m, st) => m[1] === "app" ? "uid=998(app) gid=998(app) groups=998(app)" : m[1] === "www-data" ? `uid=33(www-data) gid=33(www-data) groups=33(www-data)${st.inApp ? ",998(app)" : ""}` : `id: '${m[1]}': no such user` },
            { re: /^sudo -u (\S+) (touch|cat|ls) (\S+)$/, use: "sudo -u <user> touch|cat <file>", desc: "test access as another user", run: (m, st) => { if (m[1] === "app" && m[2] === "touch") return appCanWrite(st) ? "" : `touch: cannot touch '${m[3]}': Permission denied`; if (m[1] === "www-data" && m[2] === "cat") return nginxRead(st, st.files) ? "%PDF-1.7 …" : `cat: ${m[3]}: Permission denied`; return ""; } },
            { re: /^chown (?:-R )?([\w-]+)(?::([\w-]+))? (\S+?)\/?$/, use: "chown [-R] <user>:<group> <path>", desc: "", run: (m, st) => { const t = target(st, m[3]); if (!t) return `chown: cannot access '${m[3]}': No such file or directory`; if (t !== "files") st[t].owner = m[1]; if (m[2]) st[t].group = m[2]; if (/-R/.test(m[0]) && t === "up" && m[2]) st.files.group = m[2]; return ""; } },
            { re: /^chgrp (?:-R )?([\w-]+) (\S+?)\/?$/, use: "chgrp [-R] <group> <path>", desc: "", run: (m, st) => { const t = target(st, m[2]); if (!t) return `chgrp: cannot access '${m[2]}': No such file or directory`; st[t].group = m[1]; if (/-R/.test(m[0]) && t === "up") st.files.group = m[1]; return ""; } },
            { re: /^chmod (-R )?(\S+) (\S+?)\/?$/, use: "chmod [-R] <mode> <path>", desc: "", run: (m, st) => {
              const t = target(st, m[3]); if (!t) return `chmod: cannot access '${m[3]}': No such file or directory`;
              const tgts = m[1] && t === "up" ? ["up", "files"] : [t];
              let worldW = false, worldR = false;
              for (const k of tgts) { const r = applyMode(st[k].m, m[2], k !== "files"); if (!r) return `chmod: invalid mode: '${m[2]}'`; st[k].m = r.m; if (r.sg != null && k !== "files") st[k].sg = r.sg; if (r.m & 0o002) worldW = true; if (k === "files" && r.m & 0o004) worldR = true; }
              if (worldW) { st.broke = "World-writable: any local user or compromised process can now drop or replace files the app (and nginx) serve."; return { out: "", danger: "Made a directory or files world-writable." }; }
              if (worldR && I.lv === 3) st.worldR = true;
              return "";
            } },
            ...(I.lv === 3 ? [
              { re: /^usermod -a?G ([\w-]+) (\S+)$/, use: "usermod -aG <group> <user>", desc: "add a user to a group", run: (m, st) => { const g = m[1], u = m[2]; if (g === "app" && u === "www-data") { st.inApp = true; st.nginxRestarted = false; } return ""; } },
              { re: /^systemctl cat app(?:\.service)?$/, use: "systemctl cat app", desc: "", run: (m, st) => `# /etc/systemd/system/app.service\n[Service]\nUser=app\nUMask=0077\nExecStart=/opt/app/bin/app${st.umaskDrop ? `\n\n# /etc/systemd/system/app.service.d/umask.conf\n[Service]\nUMask=${st.umaskDrop}` : ""}` },
              { re: /^(?:printf|echo).*$/, use: "printf '[Service]\\nUMask=0027\\n' > /etc/systemd/system/app.service.d/umask.conf", desc: "drop-in", run: (m, st, l) => { const d = dropIn(l); if (!d || d.unit !== "app") return "(nothing written: use printf '...' > /etc/systemd/system/app.service.d/<name>.conf)"; if (d.kv.UMask) { st.umaskDrop = d.kv.UMask; st.reloaded = false; } return ""; } },
              { re: /^systemctl daemon-reload$/, use: "systemctl daemon-reload", desc: "", run: (m, st) => { st.reloaded = true; return ""; } },
              { re: /^systemctl (?:restart|reload) (app|nginx)(?:\.service)?$/, use: "systemctl restart app|nginx", desc: "", run: (m, st) => { if (m[1] === "nginx") { st.nginxRestarted = true; return ""; } if (st.umaskDrop && st.reloaded) st.umaskLive = st.umaskDrop; return st.umaskDrop && !st.reloaded ? reloadWarn("app") : ""; } },
              { re: /^tail (?:-n ?\d+ )?\/var\/log\/nginx\/error\.log$/, use: "tail /var/log/nginx/error.log", desc: "", run: () => `2026/10/11 03:12:44 [error] 4121#4121: *88211 open() "${U}/${I.f}" failed (13: Permission denied), client: 10.0.2.4, server: _, request: "GET /uploads/${I.f} HTTP/2.0"` },
            ] : []),
          ]);
          const init = I.lv === 1 ? { sh: { owner: "root", group: "root", m: 0o755 }, up: { owner: "root", group: "root", m: 0o755, sg: false }, files: { group: "app", m: 0o600 } } : I.lv === 2 ? { sh: { owner: "root", group: "root", m: 0o700 }, up: { owner: "app", group: "app", m: 0o750, sg: false }, files: { group: "app", m: 0o600 } } : { sh: { owner: "root", group: "root", m: 0o755 }, up: { owner: "app", group: "app", m: 0o750, sg: false }, files: { group: "app", m: 0o600 } };
          return { prompt: `root@${I.host}:~#`, init: { ...init, umaskLive: "0077", umaskDrop: null, reloaded: false, inApp: false, nginxRestarted: false, broke: null, worldR: false }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 10 : 5, cmds: [`namei -l ${U}/${I.f}`, `ls -la ${U}`, "id app", ...(I.lv === 3 ? ["id www-data", "tail /var/log/nginx/error.log", "systemctl cat app", "chgrp -R <group> <path>", "chmod -R <mode> <path>", "printf '[Service]\\nUMask=0027\\n' > /etc/systemd/system/app.service.d/umask.conf", "systemctl daemon-reload", "systemctl restart app", `sudo -u www-data cat ${U}/${I.f}`] : ["chown <user>:<group> <path>", "chmod <mode> <path>", `sudo -u app touch ${U}/test`])] };
        },
        goal(st, I) {
          if (st.broke) return st.broke;
          if (I.lv < 3) { const ok = (() => { const sh = st.sh, up = st.up; const trav = sh.owner === "app" ? sh.m & 0o100 : sh.group === "app" ? sh.m & 0o010 : sh.m & 0o001; const w = up.owner === "app" ? (up.m & 0o300) === 0o300 : up.group === "app" ? (up.m & 0o030) === 0o030 : (up.m & 0o003) === 0o003; return !!trav && w; })(); if (!ok) return "The app still can't create files in the uploads directory (it needs write+execute on the directory and execute on every parent)."; if (I.lv === 2 && st.sh.owner === "app") return "Handing /srv/app/shared to app works but gives the app ownership of a directory it only needs to pass through. Grant traverse (x) instead."; return true; }
          if (st.worldR || st.files.m & 0o004 || st.up.m & 0o004) return "Readable by every user on the host (o+r): that's exactly what the task said to avoid. Use group permissions.";
          const g = ["www-data", ...(st.inApp && st.nginxRestarted ? ["app"] : [])];
          const dirOk = g.includes(st.up.group) ? st.up.m & 0o010 : 0;
          const exOk = g.includes(st.files.group) && st.files.m & 0o040;
          const nf = { group: st.up.sg ? st.up.group : "app", m: 0o666 & ~parseInt(st.umaskLive, 8) };
          const newOk = g.includes(nf.group) && nf.m & 0o040;
          if (!dirOk) return "nginx can't even enter the uploads directory: it needs group execute via a group it's in.";
          if (!exOk) return "Existing uploads are still unreadable by nginx (owner-only or wrong group).";
          if (!newOk) return st.inApp && !st.nginxRestarted ? "www-data was added to the app group, but the running nginx workers still have their old group list: restart nginx." : `New uploads would be created with group ${nf.group} and mode ${(nf.m).toString(8)}, which nginx can't read. Both the group new files get and the app's umask matter.`;
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: [`namei -l /srv/app/shared/uploads/${I.f}`, "chown app:app /srv/app/shared/uploads", "sudo -u app touch /srv/app/shared/uploads/test"] } : I.lv === 2 ? { log: [`namei -l /srv/app/shared/uploads/${I.f}`, "chmod 711 /srv/app/shared", "sudo -u app touch /srv/app/shared/uploads/test"] } : { log: ["tail /var/log/nginx/error.log", `ls -la /srv/app/shared/uploads`, "chgrp -R www-data /srv/app/shared/uploads", "chmod -R g+rX /srv/app/shared/uploads", "chmod g+s /srv/app/shared/uploads", "printf '[Service]\\nUMask=0027\\n' > /etc/systemd/system/app.service.d/umask.conf", "systemctl daemon-reload", "systemctl restart app", `sudo -u www-data cat /srv/app/shared/uploads/${I.f}`] },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["chmod 777 /srv/app/shared/uploads"] }, { log: ["chown app:app /srv/app/shared"] }] : I.lv === 2 ? [{ log: ["chmod 777 /srv/app/shared"] }, { log: ["chown app:app /srv/app/shared/uploads"] }] : [{ log: ["chmod -R 644 /srv/app/shared/uploads", "chmod 755 /srv/app/shared/uploads"] }, { log: ["chgrp -R www-data /srv/app/shared/uploads", "chmod -R g+rX /srv/app/shared/uploads"] }, { log: ["usermod -aG app www-data", "chmod -R g+rX /srv/app/shared/uploads", "printf '[Service]\\nUMask=0027\\n' > /etc/systemd/system/app.service.d/umask.conf", "systemctl daemon-reload", "systemctl restart app"] }],
      hint: (I) => I.lv === 1 ? "namei -l shows owner and mode of every path component. Who owns the uploads directory now?" : I.lv === 2 ? "To reach a directory you need execute (search) permission on every directory above it." : "Three things decide whether nginx can read a new file: the group the file gets (setgid on the directory makes it inherit the directory's group), the mode the umask leaves, and whether www-data is in that group.",
      concept: "Unix permissions, umask and setgid directories",
      how: "To create a file you need write and execute on its directory; to reach any path you need execute (search) on every directory above it, which namei -l shows at a glance. A new file's mode is the requested mode (usually 0666) minus the process's umask, so UMask=0077 makes files owner-only. A new file takes the creating process's primary group, unless the directory has the setgid bit, in which case it inherits the directory's group. Group membership is read when a process starts, so adding a user to a group only affects processes started afterwards. chmod 777 'fixes' everything by giving everyone everything.",
      rule: "Fix permissions with the narrowest grant: ownership for the writer, a shared group plus setgid directory and a 0027 umask for readers, x-only on parent directories. Never 777.",
      why: (I) => I.lv === 1 ? "The deploy recreated uploads as root:root 755, so app couldn't create files in it. chown app:app restores exactly the access the app needs." : I.lv === 2 ? "uploads was fine, but its parent /srv/app/shared was root:root 700, so app couldn't traverse into it. 711 (or 751) grants search only, without letting anyone list or modify it." : "Existing files were app:app 600 and new ones would be too (UMask=0077). Group www-data on the directory with setgid makes new files inherit www-data; UMask=0027 makes them 640; chgrp/chmod -R g+rX fixes the backlog. Nothing is world-readable.",
    },
    /* ======================================================================== */
    {
      id: "linux-readonly-fs",
      name: "Read-only file system",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        let o;
        if (lv === 1) o = mkOpts(R, "The disk is returning I/O errors; ext4 remounted itself read-only to protect the data. Fail over and replace the disk", ["Someone remounted it read-only by mistake: remount rw", "The filesystem is full", "A kernel bug; reboot and carry on"]);
        else if (lv === 2) o = mkOpts(R, "ext4 found metadata corruption (no I/O errors from the device); it needs an offline fsck before it's trusted again", ["The disk is failing: replace it", "Remount read-write and keep serving", "The inode table is full"]);
        else o = mkOpts(R, "The container's root filesystem is read-only by policy (readOnlyRootFilesystem); the cache path needs its own writable volume", ["ext4 on the node hit an error and remounted read-only", "The node's disk is full", "SELinux is blocking the write"]);
        return { lv, ...o, dev: R.pick(["nvme1n1", "sdb", "xvdf"]), host: `${R.pick(["db", "files", "api"])}-${R.int(1, 20)}`, sec: R.int(100000, 900000), miss: lv === 2 ? "Are there any I/O errors from the block layer, or only ext4 complaining about its own structures?" : lv === 3 ? "Look at what kind of mount / is inside the container, and whether the kernel logged anything." : "Read the kernel log above the remount message." };
      },
      text: (I) => `<p><b>PAGE:</b> ${I.lv === 3 ? "after a security hardening change, the <code>render</code> pod crash-loops" : `writes on <code>${I.host}</code> fail`} with <code>${I.lv === 3 ? "OSError: [Errno 30] Read-only file system: '/app/cache/fonts.idx'" : "EROFS: read-only file system"}</code>. ${I.lv === 2 ? "The host had a hard power-off during maintenance yesterday." : ""}</p><p>Find out why and pick the right response.</p>`,
      ...LB.term({
        shell(I) {
          const d = I.dev;
          const p1 = /nvme/.test(d) ? d + "p1" : d + "1";
          const sh = K.shell([
            { re: /^(?:dmesg|journalctl -k)(?: .*)?$/, use: "dmesg -T | tail -20", desc: "", run: () => I.lv === 1 ? `[Sat Oct 11 02:41:07 2026] ${/nvme/.test(d) ? `nvme ${d.slice(0, 5)}: I/O 412 QID 3 timeout, aborting` : `sd 2:0:0:0: [${d}] tag#12 FAILED Result: hostbyte=DID_OK driverbyte=DRIVER_OK`}\n[Sat Oct 11 02:41:07 2026] I/O error, dev ${d}, sector ${I.sec} op 0x1:(WRITE) flags 0x800 phys_seg 4 prio class 2\n[Sat Oct 11 02:41:07 2026] Buffer I/O error on dev ${p1}, logical block ${Math.round(I.sec / 8)}, lost async page write\n[Sat Oct 11 02:41:08 2026] EXT4-fs error (device ${p1}): ext4_journal_check_start:83: comm kworker/u8:2: Detected aborted journal\n[Sat Oct 11 02:41:08 2026] EXT4-fs (${p1}): Remounting filesystem read-only` : I.lv === 2 ? `[Sat Oct 11 02:41:08 2026] EXT4-fs error (device ${p1}): ext4_lookup:1855: inode #${I.sec}: comm app: deleted inode referenced: ${I.sec + 41}\n[Sat Oct 11 02:41:08 2026] EXT4-fs (${p1}): Remounting filesystem read-only\n[Fri Oct 10 09:02:11 2026] EXT4-fs (${p1}): recovery complete\n[Fri Oct 10 09:02:11 2026] EXT4-fs (${p1}): mounted filesystem with ordered data mode. Quota mode: none.` : "dmesg: read kernel buffer failed: Operation not permitted" },
            { re: /^(?:findmnt(?: \S+)?|mount(?: \| grep \S+)?|cat \/proc\/mounts)$/, use: "findmnt", desc: "", run: () => I.lv === 3 ? "TARGET    SOURCE  FSTYPE  OPTIONS\n/         overlay overlay ro,relatime,lowerdir=…,upperdir=…,workdir=…\n/tmp      tmpfs   tmpfs   rw,nosuid,nodev,size=65536k\n/etc/hosts /dev/nvme0n1p1 ext4 ro,relatime" : `TARGET   SOURCE      FSTYPE OPTIONS\n/        /dev/nvme0n1p1 ext4 rw,relatime\n/data    /dev/${p1}   ext4   ro,relatime,errors=remount-ro` },
            { re: /^touch (\S+)$/, use: "touch <file>", desc: "", run: (m) => (I.lv === 3 && m[1].startsWith("/tmp") ? "" : `touch: cannot touch '${m[1]}': Read-only file system`) },
            { re: /^(?:smartctl -a \S+|nvme smart-log \S+)$/, use: `${/nvme/.test(d) ? "nvme smart-log" : "smartctl -a"} /dev/${d}`, desc: "device health", run: () => I.lv === 3 ? "(no block devices visible inside the container)" : I.lv === 1 ? (/nvme/.test(d) ? "critical_warning : 0x4\nmedia_errors : 1,412\nnum_err_log_entries : 2,210\npercentage_used : 103%" : "SMART overall-health self-assessment test result: FAILED!\n  5 Reallocated_Sector_Ct   0x0033   001   001   005    Pre-fail  Always   FAILING_NOW 4011\n197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       212") : (/nvme/.test(d) ? "critical_warning : 0\nmedia_errors : 0\nnum_err_log_entries : 0\npercentage_used : 7%" : "SMART overall-health self-assessment test result: PASSED\n  5 Reallocated_Sector_Ct   0x0033   100   100   005    Pre-fail  Always       -       0") },
            { re: /^tune2fs -l \S+(?: \| grep .*)?$|^dumpe2fs -h \S+$/, use: `tune2fs -l /dev/${p1} | grep -i state`, desc: "", run: () => I.lv === 3 ? "tune2fs: no such device inside the container" : `Filesystem state:         clean with errors\nErrors behavior:          Remount read-only\nFS Error count:           ${I.lv === 1 ? 4 : 1}\nFirst error function:     ${I.lv === 1 ? "ext4_journal_check_start" : "ext4_lookup"}` },
            { re: /^mount -o remount,rw (\S+)$/, use: "mount -o remount,rw <mountpoint>", desc: "", run: () => ({ out: I.lv === 3 ? "mount: permission denied (are you root?)" : "", danger: I.lv === 3 ? "Trying to remount inside a container." : "Forcing a filesystem with known errors back to read-write risks spreading the corruption." }) },
            { re: /^df(?: .*)?$/, use: "df -h", desc: "", run: () => I.lv === 3 ? K.cols([DFH, ["overlay", "96G", "31G", "61G", "34%", "/"], ["tmpfs", "64M", "0", "64M", "0%", "/tmp"]]) : K.cols([DFH, ["/dev/nvme0n1p1", "48G", "12G", "34G", "27%", "/"], [`/dev/${p1}`, "1.8T", "1.1T", "620G", "65%", "/data"]]) },
            { re: /^(?:cat \/run\/secrets\/pod-spec|kubectl get pod \S+ -o yaml.*)$/, use: "kubectl get pod render-… -o yaml | grep -A6 securityContext", desc: "", run: () => I.lv === 3 ? "    securityContext:\n      allowPrivilegeEscalation: false\n      readOnlyRootFilesystem: true\n      runAsNonRoot: true\n    volumeMounts:\n    - mountPath: /tmp\n      name: tmp" : "error: not in a Kubernetes cluster" },
            { re: /^id$/, use: "id", desc: "", run: () => (I.lv === 3 ? "uid=10001(app) gid=10001(app)" : "uid=0(root) gid=0(root)") },
          ]);
          return { prompt: I.lv === 3 ? "app@render-7d9c-x2kq:/app$" : `root@${I.host}:~#`, init: {}, run: (l, st) => sh.run(l, st), par: 5, cmds: ["dmesg -T | tail -20", "findmnt", `${/nvme/.test(d) ? "nvme smart-log" : "smartctl -a"} /dev/${d}`, `tune2fs -l /dev/${p1} | grep -i state`, ...(I.lv === 3 ? ["kubectl get pod render-… -o yaml | grep -A6 securityContext"] : []), "mount -o remount,rw <mountpoint>"], opts: I.opts, optq: "Root cause and response" };
        },
        goal: pickGoal,
        solve: (I) => ({ log: ["dmesg -T | tail -20", "findmnt", ...(I.lv === 3 ? ["kubectl get pod render-… -o yaml | grep -A6 securityContext"] : [`${/nvme/.test(I.dev) ? "nvme smart-log" : "smartctl -a"} /dev/${I.dev}`])], pick: I.ans }),
      }),
      bad: (I) => [{ log: ["findmnt"], pick: (I.ans + 1) % 4 }, { log: ["dmesg -T | tail -20"], pick: (I.ans + 2) % 4 }],
      hint: (I) => I.lv === 1 ? "errors=remount-ro means ext4 flips to read-only when it hits an error. What came before that line?" : I.lv === 2 ? "Compare the device's own health with what ext4 reported." : "Is this a host filesystem at all? Look at the mount type of / and the pod's securityContext.",
      concept: "Why a filesystem goes read-only",
      how: "ext4 mounted with errors=remount-ro switches to read-only when it detects an error, to stop further damage. The kernel log says why: block-layer I/O errors and SMART/NVMe media errors point at failing hardware (replace and restore from a replica), while ext4 errors without device errors point at metadata corruption, typically after an unclean shutdown, which needs e2fsck on the unmounted filesystem. Forcing remount,rw on a filesystem with errors risks compounding the damage. Containers add a third case: a read-only root by policy (readOnlyRootFilesystem), where the app must write to an explicitly mounted volume.",
      rule: "Read dmesg before touching the mount. Device errors: fail over and replace. ext4 errors only: unmount and fsck. Container EROFS: give the path a writable volume (emptyDir) instead of relaxing the policy.",
      why: (I) => I.lv === 1 ? `The block layer logged I/O errors on ${esc(I.dev)} and the device's health data shows media errors, then ext4 aborted its journal and remounted read-only. The disk is failing; remounting rw would only lose more writes.` : I.lv === 2 ? `No block-layer errors and a healthy device, but ext4 hit 'deleted inode referenced' after yesterday's hard power-off: metadata corruption. Fail over, unmount, run e2fsck -f, then bring it back.` : "/ inside the pod is an overlay mounted ro because the hardening change set readOnlyRootFilesystem: true, and the kernel logged nothing. Mount an emptyDir at /app/cache (as was done for /tmp) and keep the policy.",
    },
    /* ======================================================================== */
    {
      id: "linux-stop-worker",
      name: "Stop the worker without losing a job",
      kind: "Change plan",
      skills: ["safe", "diagnose"],
      gen(lv, R) {
        const I = { lv, w: R.int(3000, 30000), drain: R.int(15, 40), job: R.int(80000, 99999), host: `${R.pick(["jobs", "queue", "billing"])}-${R.int(1, 9)}`, nas: R.pick(["nas01", "filer-2"]) };
        I.s = I.w - R.int(2, 9);
        if (lv === 3) { const o = mkOpts(R, "It's in uninterruptible sleep (D) inside an NFS write; no signal, not even SIGKILL, is acted on until that call returns. Fix or wait for the NFS server", ["It ignores SIGKILL; run kill -9 as root", "It's a zombie; kill its parent", "It's stopped (SIGSTOP); send SIGCONT then SIGKILL"]); I.opts = o.opts; I.ans = o.ans; I.miss = "Look at the STAT column and the wait channel."; }
        return I;
      },
      text: (I) => I.lv === 3 ? `<p>The payout worker on <code>${I.host}</code> has been stuck for 40 minutes. A colleague ran <code>kill</code> and then <code>kill -9</code>; it is still there. You need it gone so the host can be patched.</p><p>Find out why it won't die and pick the explanation.</p>` : `<p>You need to stop the payout worker on <code>${I.host}</code> for a config change. It processes card payouts one job at a time; a job interrupted halfway is retried later and <b>pays out twice</b>. ${I.lv === 2 ? "It was started by an old supervisor via a wrapper script, <code>run-worker.sh</code>." : ""}</p><p>Stop it ${I.lv === 2 ? "(wrapper and worker) " : ""}without losing or duplicating a job.</p>`,
      ...LB.term({
        shell(I) {
          const W = I.w, S = I.s;
          const procs = (st) => {
            const rows = [["PID", "PPID", "PGID", "STAT", "ELAPSED", "WCHAN", "CMD"]];
            if (I.lv === 2 && st.script) rows.push([S, 1, S, "Ss", "6-02:11:09", "do_wait", "/bin/bash /opt/payout/run-worker.sh"]);
            if (st.worker) rows.push([W, I.lv === 2 && st.script ? S : 1, I.lv === 2 ? S : W, I.lv === 3 ? "D" : "S", "6-02:11:08", I.lv === 3 ? "rpc_wait_bit_killable" : "do_epoll_wait", "python3 /opt/payout/worker.py"]);
            return K.cols(rows);
          };
          const term = (st, sig, pid) => {
            if (I.lv === 3) { if (pid === W) st.pending = true; return ""; }
            if (pid === S && I.lv === 2 && st.script) { st.script = false; if (/9|KILL/.test(sig)) return { out: "", danger: "SIGKILL to the wrapper." }; return ""; }
            if (pid === W && st.worker) { if (/9|KILL/.test(sig)) { st.worker = false; st.broke = `SIGKILL ended the worker in the middle of job ${I.job}: the payout was sent but never marked done, so the retry pays it out a second time.`; return { out: "", danger: "SIGKILLed a worker mid-job." }; } if (!st.draining) { st.draining = true; st.t0 = st.t; } return ""; }
            return `bash: kill: (${pid}) - No such process`;
          };
          const tick = (st, s) => { st.t += s; if (st.draining && st.t - st.t0 >= I.drain) { st.worker = false; if (I.lv === 2 && st.script) st.script = false; } };
          const sh = K.shell([
            { re: /^ps(?: .*)?$|^pgrep .*$/, use: "ps -eo pid,ppid,pgid,stat,etime,wchan:24,cmd | grep payout", desc: "", run: (m, st) => procs(st) },
            { re: /^kill (?:-s )?(-?(?:9|15|2|KILL|TERM|INT|SIGKILL|SIGTERM|SIGINT)) (?:-- )?(-?\d+)$|^kill (?:-- )?(-?\d+)$/, use: "kill [-TERM|-9] <pid>   (kill -TERM -- -<pgid> for a process group)", desc: "", run: (m, st) => {
              const sig = (m[1] || "TERM").replace(/^-/, ""), tgt = +(m[2] || m[3]);
              if (tgt < 0) { const g = -tgt; if (I.lv === 2 && g === S) { const a = term(st, sig, S); const b = term(st, sig, W); return typeof b === "object" ? b : typeof a === "object" ? a : ""; } return `bash: kill: (${tgt}) - No such process`; }
              return term(st, sig, tgt);
            } },
            { re: /^pkill (?:-(?:TERM|15|9|KILL) )?-f (\S+)$/, use: "pkill -f <pattern>", desc: "", run: (m, st, l) => (/worker\.py/.test(m[1]) ? term(st, /-9|KILL/.test(l) ? "KILL" : "TERM", W) : /run-worker/.test(m[1]) ? term(st, /-9|KILL/.test(l) ? "KILL" : "TERM", S) : "") },
            { re: /^sleep (\d+)$/, use: "sleep <seconds>", desc: "wait", run: (m, st) => { tick(st, +m[1]); return ""; } },
            { re: /^(?:tail|cat) (?:-n ?\d+ )?\/var\/log\/payout\/worker\.log$/, use: "tail /var/log/payout/worker.log", desc: "", run: (m, st) => `03:14:01 job ${I.job} started (payout 412.20 EUR)${I.lv === 3 ? `\n03:14:02 writing receipt to /mnt/${I.nas}/receipts/${I.job}.pdf` : ""}${st.draining ? `\n03:14:${String(5 + Math.min(st.t - st.t0, 50)).padStart(2, "0")} SIGTERM received: finishing job ${I.job}, then exiting` : ""}${st.draining && !st.worker ? `\n03:14:${String(5 + I.drain).padStart(2, "0")} job ${I.job} done; worker exiting cleanly` : ""}` },
            { re: /^(?:grep -E? ?['"]?\S+['"]? |cat )\/proc\/(\d+)\/status$/, use: "grep -E 'State|SigCgt|SigPnd|ShdPnd' /proc/<pid>/status", desc: "state and signal masks (hex)", run: (m, st) => { const pid = +m[1]; if (pid === W && st.worker) return `State:\t${I.lv === 3 ? "D (disk sleep)" : "S (sleeping)"}\nShdPnd:\t${st.pending || I.lv === 3 ? "0000000000004100" : "0000000000000000"}\nSigCgt:\t0000000180004002`; if (pid === S && st.script) return "State:\tS (sleeping)\nSigCgt:\t0000000000010000"; return `grep: /proc/${pid}/status: No such file or directory`; } },
            { re: /^cat \/proc\/(\d+)\/stack$/, use: "cat /proc/<pid>/stack", desc: "", run: (m) => +m[1] === W && I.lv === 3 ? "[<0>] rpc_wait_bit_killable+0x1e/0xa0 [sunrpc]\n[<0>] __rpc_execute+0x10c/0x420 [sunrpc]\n[<0>] nfs4_do_close+0x2a1/0x2f0 [nfsv4]\n[<0>] nfs_file_flush+0x1d/0x40 [nfs]\n[<0>] filp_flush+0x35/0x80" : `cat: /proc/${m[1]}/stack: No such file or directory` },
            { re: /^cat \/opt\/payout\/run-worker\.sh$/, use: "cat /opt/payout/run-worker.sh", desc: "", run: () => "#!/bin/bash\nsource /opt/payout/env\ncd /opt/payout\npython3 /opt/payout/worker.py\necho \"worker exited with $?\"" },
            { re: /^dmesg(?: .*)?$/, use: "dmesg -T | tail", desc: "", run: () => I.lv === 3 ? `[Sat Oct 11 03:14:31 2026] nfs: server ${I.nas} not responding, still trying\n[Sat Oct 11 03:18:41 2026] INFO: task python3:${W} blocked for more than 245 seconds.` : "" },
          ]);
          return { prompt: `root@${I.host}:~#`, init: { t: 0, worker: true, script: I.lv === 2, draining: false, t0: 0, pending: I.lv === 3, broke: null }, run: (l, st) => sh.run(l, st), par: I.lv === 2 ? 6 : 5, cmds: ["ps -eo pid,ppid,pgid,stat,etime,wchan:24,cmd | grep payout", "grep -E 'State|SigCgt|SigPnd|ShdPnd' /proc/<pid>/status", "kill -TERM <pid>", "sleep <seconds>", "tail /var/log/payout/worker.log", ...(I.lv === 2 ? ["cat /opt/payout/run-worker.sh", "kill -TERM -- -<pgid>"] : []), ...(I.lv === 3 ? ["cat /proc/<pid>/stack", "dmesg -T | tail"] : []), "kill -9 <pid>"], ...(I.lv === 3 ? { opts: I.opts, optq: "Why it won't die" } : {}) };
        },
        goal(st, I, a) {
          if (I.lv === 3) return pickGoal(st, I, a);
          if (st.broke) return st.broke;
          if (st.worker) return st.draining ? `The worker got SIGTERM and is finishing job ${I.job}; it hasn't exited yet. Give it time.` : I.lv === 2 && !st.script ? "The wrapper is gone, but worker.py is still running (now orphaned, PPID 1): the signal went to bash, which doesn't forward it to its child." : "The worker is still running.";
          if (I.lv === 2 && st.script) return "The worker stopped but the wrapper is still there.";
          return true;
        },
        solve: (I) => I.lv === 3 ? { log: ["ps -eo pid,ppid,pgid,stat,etime,wchan:24,cmd | grep payout", `cat /proc/${I.w}/stack`, "dmesg -T | tail"], pick: I.ans } : I.lv === 2 ? { log: ["ps -eo pid,ppid,pgid,stat,etime,wchan:24,cmd | grep payout", "cat /opt/payout/run-worker.sh", `kill -TERM -- -${I.s}`, "sleep 60", "ps -eo pid,ppid,pgid,stat,etime,wchan:24,cmd | grep payout"] } : { log: ["ps -eo pid,ppid,pgid,stat,etime,wchan:24,cmd | grep payout", `kill -TERM ${I.w}`, "sleep 60", "tail /var/log/payout/worker.log"] },
      }),
      bad: (I) => I.lv === 3 ? [{ log: [], pick: (I.ans + 1) % 4 }] : I.lv === 2 ? [{ log: [`kill ${I.s}`, "sleep 60"] }, { log: [`kill -9 -- -${I.s}`] }] : [{ log: [`kill -9 ${I.w}`] }, { log: [`kill ${I.w}`] }],
      hint: (I) => I.lv === 1 ? "SIGTERM asks; SIGKILL can't be caught. Check SigCgt to see whether the worker handles SIGTERM, then give it time to finish." : I.lv === 2 ? "bash running a foreground command dies on SIGTERM without passing it on. Signal the process group (negative PID) or the worker itself." : "What state is it in, and where in the kernel is it waiting?",
      concept: "Signals: TERM, KILL and process groups",
      how: "SIGTERM is a request: a process can catch it (SigCgt in /proc/PID/status is a hex bitmask; bit 15-1 = 0x4000 is SIGTERM), finish its current work and exit. SIGKILL can't be caught, so in-flight work is cut off wherever it is. A shell script running a foreground command doesn't forward signals: killing the script orphans the child, which keeps running under PID 1. kill -- -PGID signals the whole process group. No signal, SIGKILL included, is acted on while a task is in uninterruptible sleep (D): the kill stays pending until the kernel call returns.",
      rule: "Stop things with SIGTERM, wait for the drain, and only escalate to SIGKILL after a deadline. Use exec in wrapper scripts (or signal the process group), and fix the I/O a D-state process is stuck on rather than re-killing it.",
      why: (I) => I.lv === 1 ? `SigCgt showed the worker handles SIGTERM. After kill -TERM it finished job ${I.job} (about ${I.drain} s) and exited cleanly; kill -9 would have cut the payout in half.` : I.lv === 2 ? `run-worker.sh (pid ${I.s}) runs worker.py in the foreground without exec, so SIGTERM to the script would have killed bash and orphaned the worker. kill -TERM -- -${I.s} signalled the whole group: bash exited, the worker drained and exited.` : `The worker was in state D inside an NFS close/flush on ${esc(I.nas)}, which wasn't responding (hard mount). SIGTERM and SIGKILL were both pending (ShdPnd 0x4100) and will take effect only when that call returns; restore the NFS server or, as a last resort, umount -f the share.`,
    },
    /* ======================================================================== */
    {
      id: "linux-journald-logs",
      name: "Where did the logs go?",
      kind: "Incident",
      skills: ["diagnose", "tune"],
      gen(lv, R) { return { lv, svc: lv === 3 ? "audit-relay" : R.pick(["payments-api", "ledger-api", "orders-api"]), sup: R.int(20, 90) * 1000, rate: R.int(16, 22) * 100, host: `${R.pick(["svc", "app"])}-${R.int(1, 20)}` }; },
      text: (I) => I.lv === 1 ? `<p><b>PAGE:</b> during an incident, <code>${I.svc}</code>'s logs on <code>${I.host}</code> have gaps of several seconds. A hotfix two days ago left <code>LOG_LEVEL=debug</code> on, and journal disk use is climbing.</p><p>Get complete, useful logs back.</p>` : I.lv === 2 ? `<p>Yesterday <code>${I.host}</code> crashed and rebooted. You want <code>${I.svc}</code>'s logs from before the crash, but <code>journalctl</code> only shows entries since the reboot.</p><p>Make sure logs survive the next reboot.</p>` : `<p><code>audit-relay</code> on <code>${I.host}</code> legitimately emits about <b>${K.num(I.rate)} lines/s</b> of audit events at peak, and compliance found gaps in the journal. Other services on the host are chatty too, and the platform team relies on journald's rate limiting to protect the host from runaway loggers.</p><p>Stop losing audit-relay's lines without removing protection for everything else.</p>`,
      ...LB.term({
        shell(I) {
          const S = I.svc;
          const sh = K.shell([
            { re: /^journalctl -u systemd-journald(?:\.service)?(?: .*)?$/, use: "journalctl -u systemd-journald -n 20", desc: "journald's own messages", run: (m, st) => I.lv === 2 ? "Oct 11 07:02:11 systemd-journald[402]: Journal started\nOct 11 07:02:11 systemd-journald[402]: Runtime Journal (/run/log/journal/3f1c…) is 8.0M, max 64.0M, 56.0M free." : (I.lv === 1 ? st.level === "info" : st.unitRate >= 2000) ? "Oct 11 03:20:01 systemd-journald[402]: (no suppression since the change)" : Array.from({ length: 3 }, (_, k) => `Oct 11 03:1${k}:31 systemd-journald[402]: Suppressed ${K.num(I.sup + k * 1211)} messages from ${S}.service`).join("\n") },
            { re: new RegExp(`^journalctl (?:-\\w+ )*-u ${S}(?:\\.service)?(?: .*)?$`), use: `journalctl -u ${S} --since "10 min ago"`, desc: "", run: () => I.lv === 1 ? `Oct 11 03:14:01 ${S}[4121]: DEBUG pool: acquired conn 17 (idle=3)\nOct 11 03:14:01 ${S}[4121]: DEBUG http: GET /v1/charges/ch_81 headers={…}\nOct 11 03:14:01 ${S}[4121]: DEBUG pool: released conn 17\n… (gap: nothing from 03:14:01 to 03:14:29)\nOct 11 03:14:29 ${S}[4121]: ERROR charge ch_92 failed: upstream timeout` : I.lv === 2 ? `-- Boot 7c1e… --\nOct 11 07:02:14 ${S}[911]: listening on :8080` : `Oct 11 03:14:01 ${S}[812]: audit event 88121 forwarded\n… (gap: nothing from 03:14:01 to 03:14:30)` },
            { re: /^journalctl --list-boots$/, use: "journalctl --list-boots", desc: "", run: (m, st) => st.persist && st.applied ? "IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n  0 7c1e9a0b2f4d4b1e9d3c5a7f0e2b4c6d Sat 2026-10-11 07:02:11 UTC Sat 2026-10-11 09:14:02 UTC\n(earlier boots weren't stored; from now on they will be)" : "IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n  0 7c1e9a0b2f4d4b1e9d3c5a7f0e2b4c6d Sat 2026-10-11 07:02:11 UTC Sat 2026-10-11 09:14:02 UTC" },
            { re: /^journalctl --disk-usage$/, use: "journalctl --disk-usage", desc: "", run: () => `Archived and active journals take up ${I.lv === 2 ? "8.0M" : I.lv === 1 ? "11.2G" : "3.1G"} in the file system.` },
            { re: /^ls (?:-\w+ )*(\/(?:var|run)\/log\/journal)\/?$/, use: "ls /var/log/journal", desc: "", run: (m, st) => m[1].startsWith("/run") ? "3f1c0d9e8b7a4c2d9e1f0a3b5c7d9e1f" : I.lv === 2 && !st.dir ? "ls: cannot access '/var/log/journal': No such file or directory" : "3f1c0d9e8b7a4c2d9e1f0a3b5c7d9e1f" },
            { re: /^cat \/etc\/systemd\/journald\.conf$/, use: "cat /etc/systemd/journald.conf", desc: "", run: (m, st) => `[Journal]\n${st.storageCfg ? "Storage=persistent" : "#Storage=auto"}\n#Compress=yes\nSystemMaxUse=4G\n${st.global ? `RateLimitIntervalSec=0\nRateLimitBurst=0` : "#RateLimitIntervalSec=30s\n#RateLimitBurst=10000"}` },
            { re: /^sed -i (.*) \/etc\/systemd\/journald\.conf$/, use: "sed -i 's/^#Storage=auto/Storage=persistent/' /etc/systemd/journald.conf", desc: "edit journald.conf", run: (m, st) => { if (/Storage=persistent/.test(m[1])) st.storageCfg = true; if (/RateLimit(?:Burst|IntervalSec)=0/.test(m[1])) st.global = true; return ""; } },
            { re: /^mkdir (?:-p )?\/var\/log\/journal\/?$/, use: "mkdir -p /var/log/journal", desc: "", run: (m, st) => { st.dir = true; st.persist = true; return ""; } },
            { re: /^systemd-tmpfiles --create(?: --prefix \/var\/log\/journal)?$/, use: "systemd-tmpfiles --create --prefix /var/log/journal", desc: "set the journal directory's owner and ACLs", run: () => "" },
            { re: /^systemctl restart systemd-journald(?:\.service)?$|^journalctl --flush$/, use: "systemctl restart systemd-journald  |  journalctl --flush", desc: "", run: (m, st) => { if (st.storageCfg) { st.persist = true; st.dir = true; } if (st.persist) st.applied = true; if (st.global) st.globalApplied = true; return ""; } },
            ...(I.lv === 1 ? [
              { re: new RegExp(`^cat \\/etc\\/${S}\\/env$`), use: `cat /etc/${S}/env`, desc: "", run: (m, st) => `DATABASE_URL=postgres://${S}@db-1.internal/${S}\nLOG_LEVEL=${st.level}` },
              { re: new RegExp(`^sed -i (.*) \\/etc\\/${S}\\/env$`), use: `sed -i 's/LOG_LEVEL=debug/LOG_LEVEL=info/' /etc/${S}/env`, desc: "", run: (m, st) => { const x = m[1].match(/LOG_LEVEL=(\w+)\/['"]?$/) || m[1].match(/LOG_LEVEL=debug\/LOG_LEVEL=(\w+)/); if (x) st.pendingLevel = x[1]; return ""; } },
            ] : []),
            { re: /^(?:printf|echo).*$/, use: `printf '[Service]\\nLogRateLimitIntervalSec=30s\\nLogRateLimitBurst=<N>\\n' > /etc/systemd/system/${S}.service.d/ratelimit.conf`, desc: "per-unit drop-in", run: (m, st, l) => { const d = dropIn(l); if (!d) return "(nothing written: use printf '...' > /etc/systemd/system/<unit>.service.d/<name>.conf)"; if (d.unit !== S) return ""; const iv = d.kv.LogRateLimitIntervalSec, b = d.kv.LogRateLimitBurst; if (iv != null || b != null) { const secs = iv == null ? 30 : /^0/.test(iv) ? 0 : K.dur(iv) / 1000; const burst = b == null ? 10000 : +b; st.pendRate = secs === 0 || burst === 0 ? Infinity : burst / secs; st.reloaded = false; } return ""; } },
            { re: /^systemctl daemon-reload$/, use: "systemctl daemon-reload", desc: "", run: (m, st) => { st.reloaded = true; return ""; } },
            { re: new RegExp(`^systemctl restart ${S}(?:\\.service)?$`), use: `systemctl restart ${S}`, desc: "", run: (m, st) => { if (st.pendingLevel) st.level = st.pendingLevel; if (st.pendRate != null && st.reloaded) st.unitRate = st.pendRate; return st.pendRate != null && !st.reloaded ? reloadWarn(S) : ""; } },
            { re: new RegExp(`^systemctl show ${S}(?:\\.service)? -p \\S+$`), use: `systemctl show ${S} -p LogRateLimitBurst`, desc: "", run: (m, st) => `LogRateLimitIntervalUSec=${st.unitRate === 333 ? "30s" : "?"}\nLogRateLimitBurst=${st.unitRate === 333 ? 0 : "(set)"}` },
          ]);
          return { prompt: `root@${I.host}:~#`, init: { level: "debug", pendingLevel: null, dir: I.lv !== 2, persist: I.lv !== 2, applied: false, storageCfg: false, global: false, globalApplied: false, unitRate: 333, pendRate: null, reloaded: false }, run: (l, st) => sh.run(l, st), par: I.lv === 3 ? 6 : 6, cmds: ["journalctl -u systemd-journald -n 20", `journalctl -u ${S} --since "10 min ago"`, "journalctl --disk-usage", "cat /etc/systemd/journald.conf", ...(I.lv === 1 ? [`cat /etc/${S}/env`, `sed -i 's/LOG_LEVEL=debug/LOG_LEVEL=info/' /etc/${S}/env`, `systemctl restart ${S}`] : I.lv === 2 ? ["journalctl --list-boots", "ls /var/log/journal", "mkdir -p /var/log/journal", "systemd-tmpfiles --create --prefix /var/log/journal", "journalctl --flush"] : [`printf '[Service]\\nLogRateLimitIntervalSec=30s\\nLogRateLimitBurst=<N>\\n' > /etc/systemd/system/${S}.service.d/ratelimit.conf`, "systemctl daemon-reload", `systemctl restart ${S}`])] };
        },
        goal(st, I) {
          if (st.global) return "Turning off rate limiting in journald.conf removes the protection for every unit on the host, which the platform team relies on." + (I.lv === 1 ? " And with debug still on, it would just let the flood fill the disk faster." : " Scope the change to the one unit.");
          if (I.lv === 1) { if (st.unitRate !== 333) return "Raising the limit lets the debug flood through and fills the disk faster; the gaps were caused by the debug noise, so remove that."; return st.level === "info" ? true : st.pendingLevel ? "The env file is fixed, but the running process still has LOG_LEVEL=debug: it reads the file at start." : "The service still logs at debug level and journald keeps suppressing its messages."; }
          if (I.lv === 2) return st.persist && st.applied ? true : st.persist ? "The directory exists, but the running journald still writes to /run; make it switch (flush or restart)." : "journald is still in volatile mode: with Storage=auto it only persists if /var/log/journal exists.";
          if (st.unitRate < I.rate * 1.2) return st.pendRate != null && !st.reloaded ? "The drop-in isn't loaded: systemd needs a daemon-reload before the restart." : `audit-relay is still limited to about ${Number.isFinite(st.unitRate) ? K.num(Math.round(st.unitRate)) : "∞"} lines/s (default 10,000 per 30 s) while it needs ${K.num(I.rate)}/s plus headroom.`;
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: ["journalctl -u systemd-journald -n 20", `cat /etc/${I.svc}/env`, `sed -i 's/LOG_LEVEL=debug/LOG_LEVEL=info/' /etc/${I.svc}/env`, `systemctl restart ${I.svc}`] } : I.lv === 2 ? { log: ["journalctl --list-boots", "ls /var/log/journal", "mkdir -p /var/log/journal", "systemd-tmpfiles --create --prefix /var/log/journal", "journalctl --flush"] } : { log: ["journalctl -u systemd-journald -n 20", `printf '[Service]\\nLogRateLimitIntervalSec=30s\\nLogRateLimitBurst=${Math.ceil(I.rate * 30 * 1.5 / 10000) * 10000}\\n' > /etc/systemd/system/${I.svc}.service.d/ratelimit.conf`, "systemctl daemon-reload", `systemctl restart ${I.svc}`] },
      }),
      bad: (I) => I.lv === 1 ? [{ log: [`printf '[Service]\\nLogRateLimitIntervalSec=0\\n' > /etc/systemd/system/${I.svc}.service.d/ratelimit.conf`, "systemctl daemon-reload", `systemctl restart ${I.svc}`] }, { log: [`sed -i 's/LOG_LEVEL=debug/LOG_LEVEL=info/' /etc/${I.svc}/env`] }] : I.lv === 2 ? [{ log: ["mkdir -p /var/log/journal"] }] : [{ log: ["sed -i 's/^#RateLimitBurst=10000/RateLimitBurst=0/' /etc/systemd/journald.conf", "systemctl restart systemd-journald"] }, { log: [`printf '[Service]\\nLogRateLimitBurst=50000\\n' > /etc/systemd/system/${I.svc}.service.d/ratelimit.conf`, "systemctl daemon-reload", `systemctl restart ${I.svc}`] }],
      hint: (I) => I.lv === 1 ? "journald logs when it drops a unit's messages. Is the problem the limit or the volume?" : I.lv === 2 ? "With the default Storage=auto, where does journald write if /var/log/journal doesn't exist?" : "Since systemd 240 a unit can set its own LogRateLimitIntervalSec= and LogRateLimitBurst=. Compute the burst you need over the interval.",
      concept: "journald storage and rate limiting",
      how: "journald rate-limits each service: by default more than 10,000 messages in 30 s (RateLimitBurst/RateLimitIntervalSec, scaled by free disk space) and the rest of that interval is dropped, logged as 'Suppressed N messages'. Units can override this with LogRateLimitIntervalSec= and LogRateLimitBurst=. With the default Storage=auto, journald keeps logs on disk only if /var/log/journal exists; otherwise everything lives in /run/log/journal and disappears at reboot. journalctl --flush moves the runtime journal to persistent storage once it's available.",
      rule: "Fix noisy logging at the source; scope rate-limit exceptions to the unit that needs them, sized from its real peak rate; and make journal storage persistent (with SystemMaxUse) on every server.",
      why: (I) => I.lv === 1 ? `Debug logging produced far more than 10,000 lines per 30 s, so journald suppressed ${K.num(I.sup)}+ messages per interval, including the errors you needed. Back to info level (and a restart to apply it), the volume fits under the limit.` : I.lv === 2 ? "/var/log/journal didn't exist, so Storage=auto kept the journal in /run and the crash took it with it. Creating the directory (with tmpfiles setting its permissions) and flushing switched journald to persistent storage." : `At ${K.num(I.rate)} lines/s audit-relay needs ${K.num(I.rate * 30)} per 30 s, over the default 10,000. A per-unit drop-in with a burst of ${K.num(Math.ceil(I.rate * 30 * 1.5 / 10000) * 10000)} per 30 s fixes it while every other unit keeps the default protection.`,
    },
  ]);
})();
