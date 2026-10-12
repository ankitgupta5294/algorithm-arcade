/* Systems Lab · Networking (part 2): TCP behaviour, packets on the wire, proxies, HTTP and addressing. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;

  const DOMS = ["larkpay.io", "northwind.dev", "tallyho.app", "brightcart.com", "quokka.cloud", "fernhill.io", "pebbleworks.net", "orbitalfox.com"];
  const optsOf = (I, TXT) => I.opts.map((k) => TXT[k]);
  const pickCheck = (I, a, WHY) => { const k = I.opts[a.pick]; return k === I.ans ? true : WHY[k] || "That doesn't explain all of the evidence."; };
  const optIdx = (I, k) => I.opts.indexOf(k);
  const badPicks = (I) => I.opts.filter((k) => k !== I.ans).slice(0, 2).map((k) => ({ log: [], pick: optIdx(I, k) }));
  const f3 = (x) => x.toFixed(6);

  /* ---------- MTU / MSS clamping sandbox ---------- */
  function mtuShell(I) {
    const init = { rules: I.lv === 2 ? [{ chain: "OUTPUT", mss: "pmtu", dev: null }] : [] };
    const effMss = (st) => { const r = st.rules.filter((x) => x.chain === "FORWARD"); if (!r.length) return 1460; return Math.min(...r.map((x) => (x.mss === "pmtu" ? I.M - 40 : Math.min(1460, x.mss)))); };
    const sh = K.shell([
      { re: /^ip link(?: show)?(?: (?:dev )?(\S+))?$/, use: "ip link show [dev]", desc: "interfaces and their MTU", run: (m) => {
        const all = [["1", "lo", 65536, "LOOPBACK,UP,LOWER_UP"], ["2", "eth0", 1500, "BROADCAST,MULTICAST,UP,LOWER_UP"], ["3", "eth1", 1500, "BROADCAST,MULTICAST,UP,LOWER_UP"], ["7", I.dev, I.M, "POINTOPOINT,NOARP,UP,LOWER_UP"]];
        const rows = all.filter((x) => !m[1] || x[1] === m[1]);
        if (!rows.length) return `Device "${m[1]}" does not exist.`;
        return rows.map((x) => `${x[0]}: ${x[1]}: <${x[3]}> mtu ${x[2]} qdisc ${x[1] === I.dev ? "noqueue" : "fq_codel"} state ${x[1] === "lo" ? "UNKNOWN" : "UP"} mode DEFAULT group default qlen 1000`).join("\n");
      } },
      { re: /^ping (.*)$/, use: "ping -c 3 -M do -s <size> <host>", desc: "ping with Don't Fragment set; size = payload bytes (+28 header)", run: (m) => {
        const s = +((m[1].match(/-s (\d+)/) || [])[1] || 56), df = /-M do/.test(m[1]), host = m[1].split(" ").pop();
        const tot = s + 28;
        if (df && tot > I.M) return `PING ${host} (${I.srv}) ${s}(${tot}) bytes of data.\nping: local error: message too long, mtu=${I.M}\nping: local error: message too long, mtu=${I.M}\nping: local error: message too long, mtu=${I.M}\n\n--- ${host} ping statistics ---\n3 packets transmitted, 0 received, +3 errors, 100% packet loss, time 2042ms`;
        if (tot > I.P && df) return `PING ${host} (${I.srv}) ${s}(${tot}) bytes of data.\n\n--- ${host} ping statistics ---\n3 packets transmitted, 0 received, 100% packet loss, time 2051ms`;
        return `PING ${host} (${I.srv}) ${s}(${tot}) bytes of data.\n${s + 8} bytes from ${I.srv}: icmp_seq=1 ttl=62 time=11.8 ms\n${s + 8} bytes from ${I.srv}: icmp_seq=2 ttl=62 time=11.6 ms\n${s + 8} bytes from ${I.srv}: icmp_seq=3 ttl=62 time=11.7 ms\n\n--- ${host} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss, time 2003ms`;
      } },
      { re: /^tracepath(?: -n)? (\S+)$/, use: "tracepath -n <host>", desc: "path MTU discovery hop by hop", run: () => ` 1?: [LOCALHOST]                      pmtu 1500\n 1:  ${I.peer}                                        0.410ms pmtu ${I.M}\n 1:  ${I.peer}                                       11.402ms\n 2:  10.200.0.1                                       11.633ms\n` + (I.lv === 3 ? ` 3:  no reply\n 4:  no reply\n     Too many hops: pmtu ${I.M}\n     Resume: pmtu ${I.M}` : ` 3:  ${I.srv}                                     11.911ms reached\n     Resume: pmtu ${I.M} hops 3 back 3`) },
      { re: /^curl .*https?:\/\/\S+\/(\S+).*$|^curl .*https?:\/\/\S+$/, use: `curl -s -o /dev/null -w '%{http_code} %{size_download} %{time_total}\\n' -m 10 https://${I.host}/<path>`, desc: "fetch from the gateway itself", run: (m, st, line) => {
        const big = /large|report|export|big/.test(line);
        if (!big) return "200 612 0.031";
        if (I.M - 40 + 40 > I.P) return "000 0 10.001\n(curl: (28) Operation timed out after 10001 milliseconds with 2896 bytes received)";
        return "200 1843921 0.412";
      } },
      { re: /^(?:sudo )?iptables -t mangle -(?:L|S|nvL|vnL)(?: (\S+))?(?: -n| -v| -nv| -vn)*$/, use: "iptables -t mangle -L -n -v", desc: "show mangle rules", run: (m, st) => ["PREROUTING", "INPUT", "FORWARD", "OUTPUT", "POSTROUTING"].filter((c) => !m[1] || m[1] === c).map((c) => `Chain ${c} (policy ACCEPT)\n target     prot opt source               destination\n` + st.rules.filter((r) => r.chain === c).map((r) => ` TCPMSS     tcp  --  0.0.0.0/0            0.0.0.0/0            tcp flags:0x06/0x02 ${r.mss === "pmtu" ? "TCPMSS clamp to PMTU" : "TCPMSS set " + r.mss}`).join("\n")).join("\n\n") },
      { re: /^(?:sudo )?iptables -t mangle -[AI] (\S+)(?: -o (\S+))? -p tcp --tcp-flags SYN,RST SYN(?: -o (\S+))? -j TCPMSS (--clamp-mss-to-pmtu|--set-mss (\d+))$/, use: "iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu | --set-mss <n>", desc: "rewrite the MSS in SYN packets", run: (m, st) => { st.rules.push({ chain: m[1], dev: m[2] || m[3] || null, mss: m[4] === "--clamp-mss-to-pmtu" ? "pmtu" : +m[5] }); return ""; } },
      { re: /^(?:sudo )?iptables (?:-t \S+ )?-F.*$/, use: "", hidden: true, desc: "", run: (m, st) => { st.rules = []; return { out: "", danger: "Flushing iptables on a gateway also removes NAT and filter rules other traffic depends on." }; } },
      { re: /^(?:sudo )?ip link set (?:dev )?(\S+) mtu (\d+)$/, use: "ip link set dev <if> mtu <n>", desc: "", run: (m) => m[1] === I.dev ? "" : { out: "", danger: `Changing ${m[1]}'s MTU on a live gateway affects every LAN host and doesn't touch the tunnel path.` } },
      { re: /^(?:sudo )?sysctl net\.ipv4\.tcp_mtu_probing(?:=(\d))?$/, use: "sysctl net.ipv4.tcp_mtu_probing", desc: "", run: (m) => (m[1] ? `net.ipv4.tcp_mtu_probing = ${m[1]}\n(only affects TCP connections this host originates)` : "net.ipv4.tcp_mtu_probing = 0") },
    ]);
    return {
      prompt: "root@office-gw:~#", init, run: (line, st) => sh.run(line, st), par: I.lv === 3 ? 9 : 6,
      motd: `Office → cloud ${I.lvName} tunnel via ${I.dev}. Ticket: from office laptops, small API calls to ${I.host} work,\nbut large downloads (/export/report.csv) hang forever. Same requests from home work.${I.lv === 2 ? "\nNote from last week: \"added MSS clamping, didn't help\" — J." : ""}`,
      cmds: ["ip link show", `ping -c 3 -M do -s 1472 ${I.host}`, `ping -c 3 -M do -s <size> ${I.host}`, `tracepath -n ${I.host}`, `curl -s -o /dev/null -w '%{http_code} %{size_download} %{time_total}\\n' -m 10 https://${I.host}/export/report.csv`, "iptables -t mangle -L -n -v", "iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"],
      effMss,
    };
  }

  /* ---------- Nagle + delayed ACK sandbox ---------- */
  function nagleShell(I) {
    const cfile = `/etc/${I.cli}/rpc-client.yaml`, sfile = "/etc/quotes/server.yaml";
    const init = { cfg: { [cfile]: I.lv === 3, [sfile]: false }, live: { [cfile]: I.lv === 3, [sfile]: false } };
    const slow = (st) => (I.lv === 3 ? !st.live[sfile] : !st.live[cfile]);
    const yaml = (f, st) => f === cfile ? `upstream: quotes-1:7070\npool_size: 8\nconnect_timeout_ms: 200\nrequest_timeout_ms: 500\ntcp_nodelay: ${st.cfg[f]}\n` : `listen: 0.0.0.0:7070\nworkers: 16\ntcp_nodelay: ${st.cfg[f]}\nwrite_mode: header_then_body\n`;
    const dump = (st) => {
      if (!slow(st)) return `09:14:02.100112 IP 10.0.4.21.51834 > 10.0.7.9.7070: Flags [P.], seq 1:251, ack 1, win 502, length 250\n09:14:02.100391 IP 10.0.7.9.7070 > 10.0.4.21.51834: Flags [P.], seq 1:1181, ack 251, win 509, length 1180\n09:14:02.100422 IP 10.0.4.21.51834 > 10.0.7.9.7070: Flags [.], ack 1181, win 501, length 0`;
      if (I.lv < 3) return `09:14:02.100112 IP 10.0.4.21.51834 > 10.0.7.9.7070: Flags [P.], seq 1:33, ack 1, win 502, length 32\n09:14:02.140287 IP 10.0.7.9.7070 > 10.0.4.21.51834: Flags [.], ack 33, win 509, length 0\n09:14:02.140301 IP 10.0.4.21.51834 > 10.0.7.9.7070: Flags [P.], seq 33:251, ack 1, win 502, length 218\n09:14:02.140590 IP 10.0.7.9.7070 > 10.0.4.21.51834: Flags [P.], seq 1:1181, ack 251, win 509, length 1180\n09:14:02.140611 IP 10.0.4.21.51834 > 10.0.7.9.7070: Flags [.], ack 1181, win 501, length 0`;
      return `09:14:02.100112 IP 10.0.4.21.51834 > 10.0.7.9.7070: Flags [P.], seq 1:251, ack 1, win 502, length 250\n09:14:02.100380 IP 10.0.7.9.7070 > 10.0.4.21.51834: Flags [P.], seq 1:65, ack 251, win 509, length 64\n09:14:02.140402 IP 10.0.4.21.51834 > 10.0.7.9.7070: Flags [.], ack 65, win 502, length 0\n09:14:02.140431 IP 10.0.7.9.7070 > 10.0.4.21.51834: Flags [P.], seq 65:1181, ack 251, win 509, length 1116\n09:14:02.140460 IP 10.0.4.21.51834 > 10.0.7.9.7070: Flags [.], ack 1181, win 501, length 0`;
    };
    const fileOf = (p) => (p === cfile || p.endsWith("rpc-client.yaml") ? cfile : p === sfile || p.endsWith("server.yaml") ? sfile : null);
    const sh = K.shell([
      { re: /^(?:sudo )?tcpdump .*$/, use: "tcpdump -nn -i eth0 -c 5 port 7070", desc: "one request/response on the wire", run: (m, st) => `tcpdump: verbose output suppressed, use -v[v]... for full protocol decode\nlistening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes\n${dump(st)}\n5 packets captured` },
      { re: /^ss -\w+(?: .*)?$/, use: "ss -tni dst :7070", desc: "TCP internals of the connections", run: () => `State  Recv-Q Send-Q Local Address:Port   Peer Address:Port\nESTAB  0      0      10.0.4.21:51834      10.0.7.9:7070\n\t cubic wscale:7,7 rto:201 rtt:0.214/0.061 ato:40 mss:8948 pmtu:9001 rcvmss:536 advmss:8948 cwnd:10 bytes_sent:1883210 bytes_acked:1883210 segs_out:22811 segs_in:15040 send 3.34Gbps lastsnd:12 lastrcv:12 lastack:12 delivery_rate 1.2Gbps app_limited` },
      { re: /^(?:rpcbench|bench) .*$/, use: "rpcbench quotes-1:7070 -n 2000", desc: "measure request latency", run: (m, st) => slow(st) ? "requests: 2000  errors: 0\nlatency p50: 40.4 ms  p90: 40.9 ms  p99: 41.6 ms  max: 48.0 ms\nserver-reported handler time p50: 0.21 ms" : "requests: 2000  errors: 0\nlatency p50: 0.38 ms  p90: 0.52 ms  p99: 0.91 ms  max: 3.1 ms\nserver-reported handler time p50: 0.21 ms" },
      { re: /^(?:ssh quotes-1 )?(?:sudo )?cat (\S+)$/, use: `cat ${cfile}`, desc: "", run: (m, st, line) => { const f = fileOf(m[1]); if (!f || (f === sfile && !/^ssh/.test(line))) return `cat: ${m[1]}: No such file or directory`; return yaml(f, st); } },
      { re: /^(?:ssh quotes-1 )?(?:sudo )?sed -i (['"]?)s(.)(.+?)\2(.*?)\2g?\1 (\S+)$/, use: "sed -i 's/old/new/' <file>  (prefix with ssh quotes-1 for the server)", desc: "", run: (m, st, line) => { const f = fileOf(m[5]); if (!f || (f === sfile) !== /^ssh/.test(line)) return `sed: can't read ${m[5]}: No such file or directory`; const t = yaml(f, st).replace(m[3], m[4]); const v = t.match(/tcp_nodelay: (\w+)/); st.cfg[f] = v && v[1] === "true"; return ""; } },
      { re: /^(?:sudo )?systemctl (?:restart|reload) (\S+)$/, use: `systemctl restart ${I.cli}`, desc: "", run: (m, st) => { if (m[1] !== I.cli) return `Failed to restart ${m[1]}.service: Unit ${m[1]}.service not found.`; st.live[cfile] = st.cfg[cfile]; return ""; } },
      { re: /^ssh quotes-1 (?:sudo )?systemctl (?:restart|reload) quotes$/, use: "ssh quotes-1 sudo systemctl restart quotes", desc: "", run: (m, st) => { st.live[sfile] = st.cfg[sfile]; return ""; } },
      { re: /^(?:ssh quotes-1 )?(?:sudo )?sysctl -w net\.ipv4\.tcp_\S+$/, use: "", hidden: true, desc: "", run: () => ({ out: "sysctl: cannot stat /proc/sys/net/ipv4/tcp_delack_min: No such file or directory", danger: "Linux has no global switch for delayed ACKs or Nagle; poking random TCP sysctls in production is risky." }) },
      { re: /^(?:ssh quotes-1 )?(?:sudo )?journalctl -u quotes.*$|^ssh quotes-1 (?:sudo )?tail .*gc\.log$/, use: "ssh quotes-1 journalctl -u quotes --since -5m", desc: "server logs", run: () => `quotes[811]: [gc] pause young 3.1 ms\nquotes[811]: handled 41213 requests in last 10s, handler p50 0.21 ms p99 0.88 ms\n${I.lv >= 2 ? "quotes[811]: [gc] pause full 31.7 ms (allocation failure)\n" : ""}quotes[811]: [gc] pause young 2.8 ms` },
    ]);
    return {
      prompt: `deploy@${I.cli}-3:~$`, init, run: (line, st) => sh.run(line, st), par: I.lv === 3 ? 7 : 6,
      motd: `${I.cli} → quotes RPC (port 7070, same AZ): p50 ≈ 40 ms. The quotes team says their handler takes 0.2 ms.`,
      cmds: ["rpcbench quotes-1:7070 -n 2000", "tcpdump -nn -i eth0 -c 5 port 7070", "ss -tni dst :7070", `cat ${cfile}`, "ssh quotes-1 cat /etc/quotes/server.yaml", "ssh quotes-1 journalctl -u quotes --since -5m"],
    };
  }

  /* ---------- CORS sandbox ---------- */
  function corsShell(I) {
    const api = `https://api.${I.dom}`, shop = `https://shop.${I.dom}`, admin = `https://admin.${I.dom}`;
    const sh = K.shell([
      { re: /^curl .*$/, use: `curl -si -X OPTIONS ${api}/v1/cart -H 'Origin: ${shop}' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type'`, desc: "", run: (m, st, line) => {
        const pre = /-X ?OPTIONS/i.test(line);
        const org = (line.match(/Origin: ?([^'"\s]+)/i) || [])[1];
        const bust = /\/v1\/\S*\?/.test(line);
        const date = "date: Mon, 12 Oct 2026 09:14:02 GMT";
        if (pre) {
          if (I.lv === 1) return `HTTP/2 204\n${date}\naccess-control-allow-origin: ${org || shop}\naccess-control-allow-methods: GET, POST, PUT, DELETE, OPTIONS\naccess-control-allow-headers: content-type, x-request-id\naccess-control-max-age: 600\nvary: Origin`;
          if (I.lv === 2) return `HTTP/2 401\n${date}\ncontent-type: application/json\nwww-authenticate: Bearer realm="api"\naccess-control-allow-origin: ${org || shop}\nvary: Origin\n\n{"error":"missing_token","message":"Authorization header required"}`;
          return `HTTP/2 204\n${date}\naccess-control-allow-origin: ${org || shop}\naccess-control-allow-methods: GET, POST, OPTIONS\naccess-control-allow-headers: authorization, content-type\nvary: Origin\nx-cache: MISS`;
        }
        const auth = /Authorization/i.test(line);
        if (I.lv === 3) {
          if (bust) return `HTTP/2 200\n${date}\ncontent-type: application/json\ncache-control: public, max-age=300\naccess-control-allow-origin: ${org || shop}\nx-cache: MISS\nage: 0\n\n{"products":[...]}`;
          return `HTTP/2 200\n${date}\ncontent-type: application/json\ncache-control: public, max-age=300\naccess-control-allow-origin: ${admin}\nx-cache: HIT\nage: 141\n\n{"products":[...]}`;
        }
        return auth ? `HTTP/2 200\n${date}\ncontent-type: application/json\naccess-control-allow-origin: ${org || shop}\nvary: Origin\n\n{"items":[{"sku":"A-1931","qty":2}]}` : `HTTP/2 401\n${date}\nwww-authenticate: Bearer realm="api"\n${org ? `access-control-allow-origin: ${org}\n` : ""}\n{"error":"missing_token"}`;
      } },
      { re: /^(?:cat|less) .*cors.*$/, use: "cat config/cors.yaml", desc: "", run: () => I.lv === 1 ? `allowed_origins:\n  - ${shop}\n  - ${admin}\nallowed_methods: [GET, POST, PUT, DELETE, OPTIONS]\nallowed_headers: [content-type, x-request-id]\nmax_age: 600` : `allowed_origins:\n  - ${shop}\n  - ${admin}\nallowed_methods: [GET, POST, OPTIONS]\nallowed_headers: [authorization, content-type]\nmax_age: 600${I.lv === 3 ? "\n# CDN: /v1/products is cached for 300 s (cache key: URL)" : ""}` },
      { re: /^(?:cat|less) .*middleware.*$/, use: "cat src/middleware.ts", desc: "", run: () => `app.use(requestId());\n${I.lv === 2 ? "app.use(requireAuth());   // rejects requests without a valid bearer token\napp.use(cors(corsConfig));" : "app.use(cors(corsConfig));\napp.use(requireAuth({ skip: ['OPTIONS'] }));"}\napp.use('/v1', routes);` },
    ]);
    return {
      prompt: "dev@laptop:~/api$", init: {}, run: (line, st) => sh.run(line, st), par: 5,
      motd: `Browser console on ${shop}:\n${I.console}`,
      cmds: I.lv === 3 ? [`curl -si ${api}/v1/products -H 'Origin: ${shop}'`, `curl -si '${api}/v1/products?cb=1' -H 'Origin: ${shop}'`, "cat config/cors.yaml"] : [`curl -si -X OPTIONS ${api}/v1/cart -H 'Origin: ${shop}' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type'`, `curl -si ${api}/v1/cart -H 'Origin: ${shop}' -H 'Authorization: Bearer <token>'`, "cat config/cors.yaml", "cat src/middleware.ts"],
      opts: optsOf(I, {
        headers: "The preflight response doesn't list the Authorization header in Access-Control-Allow-Headers",
        auth: "Auth middleware rejects the preflight (OPTIONS never carries the token) before CORS can answer it",
        vary: "The CDN caches responses without Vary: Origin, so one origin's Access-Control-Allow-Origin is served to another",
        origin: "shop's origin isn't in allowed_origins",
        server: "The API is returning errors, and the browser reports them as CORS failures",
        creds: "A wildcard Access-Control-Allow-Origin is used with credentials",
      }),
    };
  }

  /* ---------- mtr / traceroute sandbox ---------- */
  function mtrRows(hops, lossFn, dest) {
    const head = "Start: 2026-10-12T09:14:02+0000\nHOST: " + dest.from.padEnd(28) + "Loss%   Snt   Last   Avg  Best  Wrst StDev";
    return head + "\n" + hops.map((h, i) => { const l = lossFn(i); const avg = h.ms; return `${String(i + 1).padStart(3)}.|-- ${h.ip.padEnd(26)}${l.toFixed(1).padStart(5)}%   100 ${avg.toFixed(1).padStart(6)} ${(avg + 0.3).toFixed(1).padStart(5)} ${(avg - 0.4).toFixed(1).padStart(5)} ${(avg + (l > 5 ? 38 : 2.1)).toFixed(1).padStart(5)} ${(l > 5 ? 6.4 : 0.4).toFixed(1).padStart(5)}`; }).join("\n");
  }
  function mtrShell(I) {
    const fwd = I.hops, rev = I.rhops;
    const fwdLoss = (i) => (I.lv === 1 ? (i === I.h ? I.loss : 0) : I.lv === 2 ? (i >= I.h ? I.loss + (i === fwd.length - 1 ? 0.3 : 0) : 0) : 0);
    const revLoss = (i) => (I.lv === 3 && i >= I.h ? I.loss : 0);
    const sh = K.shell([
      { re: /^mtr (?:-\w+ ?)*(?:\d+ )?(\S+)$/, use: `mtr -rwc 100 ${I.host}`, desc: "report mode: 100 probes per hop", run: (m) => mtrRows(fwd, fwdLoss, { from: "bastion-1" }) },
      { re: /^ssh (\S+) mtr (?:-\w+ ?)*(?:\d+ )?(\S+)$/, use: `ssh api-1 mtr -rwc 100 ${I.office}`, desc: "the path back from the server", run: (m) => (m[1] === "api-1" ? mtrRows(rev, revLoss, { from: "api-1" }) : `ssh: Could not resolve hostname ${m[1]}`) },
      { re: /^traceroute (?:-n )?(\S+)$/, use: `traceroute -n ${I.host}`, desc: "", run: () => `traceroute to ${I.host} (${I.ip}), 30 hops max, 60 byte packets\n` + fwd.map((h, i) => `${String(i + 1).padStart(2)}  ${h.ip}  ${h.ms.toFixed(3)} ms  ${(h.ms + 0.2).toFixed(3)} ms  ${I.lv === 1 && i === I.h ? "*" : (h.ms + 0.1).toFixed(3) + " ms"}`).join("\n") },
      { re: /^curl .*-w.*$/, use: `curl -s -o /dev/null -w 'connect=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\\n' https://${I.host}/v1/search?q=boots`, desc: "", run: () => I.lv === 1 ? `connect=0.031904 ttfb=2.318811 total=2.319402` : I.lv === 2 ? `connect=1.032871 ttfb=1.291144 total=1.904112` : `connect=0.031722 ttfb=0.212041 total=3.118210` },
      { re: /^ping (?:-c \d+ )?(\S+)$/, use: `ping -c 20 ${I.host}`, desc: "", run: () => `--- ${I.host} ping statistics ---\n20 packets transmitted, ${I.lv === 2 ? 18 : 20} received, ${I.lv === 2 ? 10 : 0}% packet loss, time 19027ms\nrtt min/avg/max/mdev = ${fwd[fwd.length - 1].ms.toFixed(3)}/${(fwd[fwd.length - 1].ms + 0.4).toFixed(3)}/${(fwd[fwd.length - 1].ms + 3).toFixed(3)}/0.811 ms` },
    ]);
    return {
      prompt: "ops@bastion-1:~$", init: {}, run: (line, st) => sh.run(line, st), par: 5,
      motd: I.lv === 1 ? `Ticket: "search on ${I.host} is slow from the office, mtr shows packet loss!"` : I.lv === 2 ? `Ticket: office users see stalls of a second or more talking to ${I.host}, many times an hour.` : `Ticket: office users downloading reports from ${I.host} get very slow transfers; small pages are fine. You ran mtr: clean.`,
      cmds: [`mtr -rwc 100 ${I.host}`, `curl -s -o /dev/null -w 'connect=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\\n' https://${I.host}/v1/search?q=boots`, `ping -c 20 ${I.host}`, ...(I.lv === 3 ? [`ssh api-1 mtr -rwc 100 ${I.office}`] : [])],
      opts: optsOf(I, {
        icmp: `Hop ${I.h + 1} rate-limits ICMP replies to probes; it forwards traffic fine, and the slowness is server time`,
        hop: `The router at hop ${I.h + 1} is dropping ${I.loss}% of traffic`,
        real: `Real packet loss starting at hop ${I.h + 1} (into the transit provider) and carried through to the destination`,
        reverse: "Loss on the return path (server → office), which a forward mtr can't see",
        server: "The application server is slow",
        dest: "The destination firewall drops some packets",
        wifi: "Office Wi-Fi is congested",
      }),
    };
  }

  /* ---------- curl timing sandbox ---------- */
  function curlTimingShell(I) {
    const fmt = (t) => `time_namelookup:  ${f3(t[0])}\ntime_connect:     ${f3(t[1])}\ntime_appconnect:  ${f3(t[2])}\ntime_pretransfer: ${f3(t[2] + 0.00012)}\ntime_starttransfer: ${f3(t[3])}\ntime_total:       ${f3(t[4])}`;
    const rtt = I.rtt / 1000;
    const sh = K.shell([
      { re: /^curl .*-w.*$/, use: `curl -s -o /dev/null -w @timing.txt https://${I.host}/v1/quote`, desc: "timing breakdown (cumulative seconds since start)", run: (m, st, line) => {
        if (I.lv === 1) return fmt([5.0041, 5.0062, 5.0228, 5.0611, 5.0614]);
        if (I.lv === 2) { const n = (line.match(/https:\/\//g) || []).length; const first = [0.0012, rtt + 0.0012, 3 * rtt + 0.004, 4 * rtt + 0.044, 4 * rtt + 0.045]; const second = [0.00002, 0, 0, rtt + 0.041, rtt + 0.042]; return n >= 2 ? fmt(first) + "\n---\n" + fmt(second) : fmt(first); }
        const big = /-d|--data|-T|--upload/.test(line), noexp = /Expect:['"]?(\s|$)/.test(line);
        if (!big) return fmt([0.0011, 0.0019, 0.0081, 0.0352, 0.0353]);
        return noexp ? fmt([0.0011, 0.0019, 0.0081, 0.0415, 0.0418]) : fmt([0.0011, 0.0019, 0.0081, 1.0412, 1.0415]);
      } },
      { re: /^curl .*-\w*v.*$/, use: `curl -sv -o /dev/null https://${I.host}/v1/quote`, desc: "", run: (m, st, line) => {
        const big = /-d|--data|-T|--upload/.test(line), noexp = /Expect:['"]?(\s|$)/.test(line);
        let s = `* Host ${I.host}:443 was resolved.\n*   Trying ${I.ip}:443...\n* Connected to ${I.host} (${I.ip}) port 443\n* SSL connection using TLSv1.2 / ECDHE-RSA-AES128-GCM-SHA256\n> ${big ? "POST" : "GET"} /v1/${big ? "batch" : "quote"} HTTP/1.1\n> Host: ${I.host}\n> User-Agent: curl/8.5.0`;
        if (big) s += `\n> Content-Length: ${I.body}\n> Content-Type: application/json${noexp ? "" : "\n> Expect: 100-continue"}\n>${noexp ? "" : "\n* Done waiting for 100-continue"}\n* upload completely sent off: ${I.body} bytes`;
        return s + `\n< HTTP/1.1 200 OK\n< x-upstream-time-ms: ${I.lv === 3 ? 31 : 38}\n< connection: keep-alive\n* Connection #0 to host ${I.host} left intact`;
      } },
      { re: /^cat \/etc\/resolv\.conf$/, use: "cat /etc/resolv.conf", desc: "", run: () => I.lv === 1 ? `nameserver ${I.dead}\nnameserver 10.0.0.2\noptions timeout:5` : "nameserver 10.0.0.2" },
      { re: /^dig (?:@(\S+) )?(\S+)(?: \+short)?$/, use: `dig @<server> ${I.host} +short`, desc: "", run: (m) => (m[1] === I.dead ? `;; communications error to ${I.dead}#53: timed out\n;; communications error to ${I.dead}#53: timed out\n;; no servers could be reached` : I.ip) },
      { re: /^grep .*(?:client|http).*$|^cat .*client.*$/, use: "cat src/quote_client.py", desc: "", run: () => I.lv === 2 ? `def get_quote(sym):\n    r = requests.get(f"https://${I.host}/v1/quote", params={"s": sym}, timeout=2)\n    return r.json()` : `session = requests.Session()\ndef get_quote(sym):\n    return session.get(f"https://${I.host}/v1/quote", params={"s": sym}, timeout=2).json()` },
    ]);
    return {
      prompt: "app@worker-2:~$", init: {}, run: (line, st) => sh.run(line, st), par: 5,
      motd: I.lv === 1 ? `Every call from worker-2 to ${I.host} takes just over 5 s. The server logs ~38 ms per request.` : I.lv === 2 ? `The quote service (${I.region}) logs ~40 ms per request, but the ${I.from} workers measure ~${Math.round(4 * I.rtt + 45)} ms per call.` : `Uploads of ${K.bytes(I.body)} JSON batches from the ingest job take just over 1 s each; the server logs ~31 ms.`,
      cmds: [`curl -s -o /dev/null -w @timing.txt https://${I.host}/v1/${I.lv === 3 ? "batch -d @batch.json" : "quote"}`, ...(I.lv === 2 ? [`curl -s -o /dev/null -w @timing.txt https://${I.host}/v1/quote https://${I.host}/v1/quote`, "cat src/quote_client.py"] : []), ...(I.lv === 3 ? [`curl -sv -o /dev/null https://${I.host}/v1/batch -d @batch.json`, `curl -s -o /dev/null -w @timing.txt https://${I.host}/v1/batch -d @batch.json -H 'Expect:'`] : []), ...(I.lv === 1 ? ["cat /etc/resolv.conf", `dig @${I.dead} ${I.host} +short`] : [])],
      opts: optsOf(I, {
        dns: "DNS: the first nameserver is dead and every lookup waits out its 5 s timeout",
        reuse: `No connection reuse: every call pays TCP + TLS handshakes across a ${I.rtt} ms RTT`,
        expect: "curl/the client sends Expect: 100-continue and the server never answers 100, so the client waits 1 s before sending the body",
        server: "The server is slow and its logs are wrong",
        tls: "Slow TLS handshake because of certificate verification (OCSP)",
        bw: "Not enough bandwidth for the request body",
      }),
    };
  }

  /* ---------- retransmits / drops sandbox ---------- */
  function retransShell(I) {
    const nstat = () => I.lv === 1 ? `#kernel\nTcpRetransSegs                  48211              0.0\nTcpExtTCPLostRetransmit         912                0.0\nTcpExtListenOverflows           0                  0.0\nTcpExtListenDrops               0                  0.0\nTcpExtTCPTimeouts               3011               0.0`
      : I.lv === 2 ? `#kernel\nTcpRetransSegs                  1207               0.0\nTcpExtListenOverflows           38842              0.0\nTcpExtListenDrops               38842              0.0\nTcpExtTCPTimeouts               40               0.0\nTcpExtTCPSynRetrans             39118              0.0`
        : `#kernel\nTcpRetransSegs                  88112              0.0\nTcpExtListenOverflows           0                  0.0\nTcpExtTCPTimeouts               214                0.0\nTcpExtTCPSACKRecovery           19210              0.0\nTcpExtTCPLossProbes             8012               0.0`;
    const sh = K.shell([
      { re: /^nstat.*$|^netstat -s.*$/, use: "nstat -az | grep -iE 'retrans|overflow|drop|timeout'", desc: "kernel TCP counters", run: nstat },
      { re: /^(?:sudo )?ethtool -S (\S+)(?: .*)?$/, use: "ethtool -S eth0 | grep -iE 'err|drop|miss'", desc: "NIC counters", run: () => I.lv === 1 ? `     rx_crc_errors: 184213\n     rx_frame_errors: 0\n     rx_missed_errors: 0\n     tx_errors: 0\n     rx_dropped: 0` : I.lv === 3 ? `     rx_crc_errors: 0\n     rx_missed_errors: 2210438\n     rx_queue_0_drops: 551203\n     rx_queue_1_drops: 549881\n     rx_no_buffer_count: 2210438\n     tx_errors: 0` : `     rx_crc_errors: 0\n     rx_missed_errors: 0\n     tx_errors: 0` },
      { re: /^(?:sudo )?ethtool -g (\S+)$/, use: "ethtool -g eth0", desc: "ring buffer sizes", run: () => `Ring parameters for eth0:\nPre-set maximums:\nRX:\t\t4096\nTX:\t\t4096\nCurrent hardware settings:\nRX:\t\t${I.lv === 3 ? 256 : 1024}\nTX:\t\t1024` },
      { re: /^ip -s link(?: show)?(?: (?:dev )?\S+)?$/, use: "ip -s link show eth0", desc: "", run: () => `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000\n    RX:  bytes  packets errors dropped  missed   mcast\n    9.1T   8.4G  ${I.lv === 1 ? "184213" : "0     "}      0  ${I.lv === 3 ? "2210438" : "0      "}       0\n    TX:  bytes  packets errors dropped carrier collsns\n    7.7T   6.9G       0       0       0       0` },
      { re: /^ss -lnt.*$/, use: "ss -lnt 'sport = :8080'", desc: "listen queues (Recv-Q = waiting to be accepted)", run: () => `State   Recv-Q  Send-Q   Local Address:Port   Peer Address:Port\nLISTEN  ${I.lv === 2 ? "129" : "0  "}     128      0.0.0.0:8080         0.0.0.0:*` },
      { re: /^ss -t?i.*$/, use: "ss -ti dst <peer>", desc: "per-connection TCP info", run: () => `ESTAB 0 0 10.0.5.14:8080 10.0.2.31:44120\n\t cubic wscale:9,7 rto:${I.lv === 1 ? 412 : 204} rtt:${I.lv === 1 ? "3.12/4.8" : "0.81/0.2"} mss:1448 cwnd:${I.lv === 1 ? 7 : 10} retrans:0/${I.lv === 1 ? 381 : I.lv === 3 ? 214 : 2} lost:0 send 52Mbps` },
      { re: /^(?:sudo )?sysctl (net\.\S+)$/, use: "sysctl net.core.somaxconn", desc: "", run: (m) => ({ "net.core.somaxconn": "net.core.somaxconn = 4096", "net.ipv4.tcp_max_syn_backlog": "net.ipv4.tcp_max_syn_backlog = 4096", "net.core.netdev_max_backlog": "net.core.netdev_max_backlog = 1000" })[m[1]] || `sysctl: cannot stat /proc/sys/${m[1].replace(/\./g, "/")}: No such file or directory` },
      { re: /^(?:cat|grep) .*(?:app|server)\.(?:yaml|conf|py|ts).*$/, use: "cat /etc/app/server.yaml", desc: "", run: () => `port: 8080\nworkers: 4\nlisten_backlog: 128   # passed to listen(); capped by somaxconn\nkeepalive: true` },
      { re: /^mtr .*$/, use: "mtr -rwc 100 10.0.2.31", desc: "", run: () => `HOST: ${I.host.padEnd(24)}Loss%   Snt   Last   Avg  Best  Wrst StDev\n  1.|-- 10.0.5.1                0.0%   100    0.3   0.3   0.2   0.6   0.1\n  2.|-- 10.0.2.31               0.0%   100    0.5   0.5   0.4   0.9   0.1` },
      { re: /^(?:sudo )?ethtool -G eth0 rx (\d+)$/, use: "ethtool -G eth0 rx <n>", desc: "resize the RX ring", run: (m) => (+m[1] > 4096 ? "netlink error: Invalid argument" : "") },
    ]);
    return {
      prompt: `root@${I.host}:~#`, init: {}, run: (line, st) => sh.run(line, st), par: 6,
      motd: I.lv === 1 ? `ALERT ${I.host}: p99 latency 6× the other ${I.svc} hosts; TCP retransmits elevated on this host only.` : I.lv === 2 ? `ALERT ${I.svc}: p99 jumps to ~1 s and ~3 s at peak, in neat steps; median is fine. CPU 55%.` : `ALERT ${I.host}: retransmits and throughput drops during traffic bursts (batch ingest, 9 Gbit/s peaks). Path to clients looks clean.`,
      cmds: ["nstat -az | grep -iE 'retrans|overflow|drop|timeout'", "ethtool -S eth0 | grep -iE 'err|drop|miss'", "ip -s link show eth0", "ss -lnt 'sport = :8080'", "ss -ti dst 10.0.2.31", "ethtool -g eth0", "sysctl net.core.somaxconn", "cat /etc/app/server.yaml"],
      opts: optsOf(I, {
        nic: "Physical layer: a bad cable, optic or NIC port corrupts frames (CRC errors), causing retransmits",
        listen: "The listen backlog (128, set by the app) overflows at peak; dropped SYNs are retried after 1 s, then 3 s",
        ring: "The NIC's RX ring (256 slots) overflows during bursts, so the host drops packets before the kernel sees them",
        network: "Congestion in the network between hosts",
        cpu: "CPU saturation slows request handling",
        somax: "net.core.somaxconn is too low",
      }),
    };
  }

  /* ---------- IPv6 / Happy Eyeballs sandbox ---------- */
  function v6Shell(I) {
    const v6ok = (ip) => (I.lv === 1 ? false : I.lv === 2 ? false : ip !== I.dead6);
    const sh = K.shell([
      { re: /^dig (?:\+short )?(\S+) (A|AAAA)(?: \+short)?$|^dig (?:\+short )?(A|AAAA) (\S+)(?: \+short)?$/i, use: `dig ${I.host} AAAA +short`, desc: "", run: (m) => { const t = (m[2] || m[3]).toUpperCase(); return t === "A" ? I.v4.join("\n") : I.v6.join("\n"); } },
      { re: /^getent ahosts (\S+)$/, use: `getent ahosts ${I.host}`, desc: "addresses in the order getaddrinfo() returns them", run: () => [...I.v6.map((x) => `${x}  STREAM ${I.host}`), ...I.v4.map((x) => `${x}  STREAM`)].join("\n") },
      { re: /^curl (.*)$/, use: `curl -sv -o /dev/null https://${I.host}/`, desc: "", run: (m) => {
        const a = m[1], host = (a.match(/https?:\/\/([^/\s]+)/) || [])[1] || I.host;
        const other = host !== I.host;
        if (/-6/.test(a)) { const okk = other ? I.lv !== 2 : I.v6.every(v6ok); return okk ? `*   Trying [${other ? "2001:db8:ff::10" : I.v6[0]}]:443...\n* Connected\n< HTTP/2 200` : `*   Trying [${other ? "2001:db8:ff::10" : I.v6.find((x) => !v6ok(x)) || I.v6[0]}]:443...\n* Connection timed out after 5001 milliseconds\ncurl: (28) Connection timed out after 5001 milliseconds`; }
        if (/-4/.test(a)) return `*   Trying ${I.v4[0]}:443...\n* Connected to ${host} (${I.v4[0]}) port 443\n< HTTP/2 200`;
        const bad6 = I.v6.find((x) => !v6ok(x));
        return bad6 ? `* Host ${host}:443 was resolved.\n* IPv6: ${I.v6.join(", ")}\n* IPv4: ${I.v4.join(", ")}\n*   Trying [${bad6}]:443...\n*   Trying ${I.v4[0]}:443...\n* Connected to ${host} (${I.v4[0]}) port 443\n< HTTP/2 200` : `*   Trying [${I.v6[0]}]:443...\n* Connected to ${host} (${I.v6[0]}) port 443\n< HTTP/2 200`;
      } },
      { re: /^nc -6 -zv -w ?\d+ (\S+) 443$/, use: "nc -6 -zv -w 3 <ipv6> 443", desc: "test one IPv6 address", run: (m) => v6ok(m[1]) ? `Connection to ${m[1]} 443 port [tcp/https] succeeded!` : `nc: connect to ${m[1]} port 443 (tcp) timed out: Operation now in progress` },
      { re: /^ip -6 (?:route|r)(?: show)?$/, use: "ip -6 route", desc: "", run: () => `2600:1f18:4a2:7c00::/64 dev eth0 proto kernel metric 256 pref medium\nfe80::/64 dev eth0 proto kernel metric 256 pref medium\ndefault via fe80::1 dev eth0 proto ra metric 1024 expires 1788sec pref medium` },
      { re: /^journalctl .*$|^tail .*$/, use: `journalctl -u ${I.svc} --since -10m | tail -3`, desc: "", run: () => `${I.svc}[2211]: WARN call to ${I.host} took 10.06s\n${I.svc}[2211]: ERROR urllib3.connectionpool: Retrying ... ConnectTimeoutError(<HTTPSConnection(host='${I.host}', port=443)>, 'Connection to ${I.host} timed out. (connect timeout=10)')\n${I.svc}[2211]: WARN call to ${I.host} took 10.04s` },
    ]);
    return {
      prompt: `app@${I.svc}-1:~$`, init: {}, run: (line, st) => sh.run(line, st), par: 6,
      motd: I.lv === 3 ? `Since last week, about 1 in ${I.v6.length} calls from ${I.svc} (Python, dual-stack hosts) to ${I.host} take 10 s extra. Browsers and curl are fine.` : `Since ${I.lv === 1 ? `the partner enabled IPv6 yesterday` : "our hosts got IPv6 addresses on Tuesday"}, every call from ${I.svc} (Python, requests) to ${I.host} takes 10 s extra. curl from the same host is fast.`,
      cmds: [`dig ${I.host} AAAA +short`, `getent ahosts ${I.host}`, `curl -sv -o /dev/null https://${I.host}/`, `curl -6 -sv -m 5 -o /dev/null https://${I.host}/`, `curl -6 -sv -m 5 -o /dev/null https://${I.probe}/`, "ip -6 route", "nc -6 -zv -w 3 <ipv6> 443", `journalctl -u ${I.svc} --since -10m | tail -3`],
      opts: optsOf(I, {
        partner: `${I.host}'s IPv6 endpoint doesn't answer; our client tries IPv6 first and has no Happy Eyeballs, so it waits out the 10 s connect timeout`,
        egress: "Our hosts have IPv6 addresses but no working IPv6 egress; every IPv6 connection hangs, and the client tries IPv6 first without Happy Eyeballs",
        stale: `One of ${I.host}'s AAAA records points at a decommissioned load balancer; clients without Happy Eyeballs hang whenever they pick it first`,
        dns: "DNS lookups are slow",
        tls: "TLS handshakes over IPv6 are slower",
        firewall: "Our firewall blocks IPv4 to the partner",
      }),
    };
  }

  /* ---------- idle connection reset sandbox ---------- */
  function idleShell(I) {
    const ka = I.lv === 3 ? 600 : I.lv === 2 ? 300 : 7200;
    const sh = K.shell([
      { re: /^(?:sudo )?tcpdump .*$/, use: "tcpdump -nn -r first-query.pcap", desc: "capture of this morning's first failing query", run: () => `08:01:13.412001 IP 10.0.4.21.48812 > 10.8.0.15.5432: Flags [P.], seq 1:83, ack 1, win 502, length 82\n08:01:13.412690 IP 10.8.0.15.5432 > 10.0.4.21.48812: Flags [R], seq 3119052211, win 0, length 0\n(no packets on this connection for the previous 41 minutes)` },
      { re: /^ss -t\w*o\w*(?: .*)?$/, use: "ss -tnoe dst :5432", desc: "connections with their timers", run: () => `ESTAB 0 0 10.0.4.21:48812 10.8.0.15:5432 ${I.lv === 3 ? `timer:(keepalive,${ka - 41}sec,0) ` : ""}uid:1001 ino:883121\nESTAB 0 0 10.0.4.21:48814 10.8.0.15:5432 ${I.lv === 3 ? `timer:(keepalive,${ka - 7}sec,0) ` : ""}uid:1001 ino:883125` },
      { re: /^(?:sudo )?sysctl (net\.ipv4\.tcp_keepalive_\w+)$|^(?:sudo )?sysctl -a.*keepalive.*$/, use: "sysctl net.ipv4.tcp_keepalive_time", desc: "", run: (m) => m[1] ? `${m[1]} = ${({ tcp_keepalive_time: ka, tcp_keepalive_intvl: 75, tcp_keepalive_probes: 9 })[m[1].split(".").pop()]}` : `net.ipv4.tcp_keepalive_intvl = 75\nnet.ipv4.tcp_keepalive_probes = 9\nnet.ipv4.tcp_keepalive_time = ${ka}` },
      { re: /^cat .*(?:application|db|datasource).*$/, use: "cat /etc/orders/application.properties", desc: "", run: () => `spring.datasource.url=jdbc:postgresql://pg-main.internal:5432/orders${I.lv === 3 ? "?tcpKeepAlive=true" : ""}\nspring.datasource.hikari.maximum-pool-size=20\nspring.datasource.hikari.minimum-idle=20\nspring.datasource.hikari.idle-timeout=600000\nspring.datasource.hikari.max-lifetime=1800000` },
      { re: /^cat .*(?:firewall|network).*$/, use: "cat /etc/network/README", desc: "", run: () => "App and DB subnets are separated by a stateful firewall.\nIdle TCP sessions are removed from its state table after 350 s.\nPackets for unknown sessions are answered with RST." },
      { re: /^grep .*(?:ERROR|reset|Exception).*$|^journalctl .*$/, use: "journalctl -u orders --since today | grep -i reset", desc: "", run: () => "08:01:13 orders[1882]: WARN HikariPool-1 - Failed to validate connection org.postgresql.jdbc.PgConnection@3e2d1a (This connection has been closed.)\n08:01:13 orders[1882]: ERROR o.h.e.j.s.SqlExceptionHelper - An I/O error occurred while sending to the backend.\n08:01:13 orders[1882]: Caused by: java.net.SocketException: Connection reset" },
    ]);
    return {
      prompt: "ops@orders-1:~$", init: {}, run: (line, st) => sh.run(line, st), par: 6,
      motd: `Every morning the first few requests to orders fail with "Connection reset"; after that it's fine.${I.lv >= 2 ? `\nChange log: "set net.ipv4.tcp_keepalive_time=${ka} on all orders hosts" (${I.lv === 2 ? "last Tuesday, didn't help" : "last month"})` : ""}`,
      cmds: ["journalctl -u orders --since today | grep -i reset", "tcpdump -nn -r first-query.pcap", "ss -tnoe dst :5432", "sysctl net.ipv4.tcp_keepalive_time", "cat /etc/orders/application.properties", "cat /etc/network/README"],
      opts: optsOf(I, {
        idle: "The firewall forgets connections idle > 350 s; the pool keeps them idle much longer, and the first query on one gets a RST",
        optin: "TCP keepalive is never enabled on these sockets (pgjdbc's tcpKeepAlive defaults to false), so the sysctl does nothing",
        interval: `Keepalives are enabled but the first probe goes out after ${ka} s, longer than the firewall's 350 s idle timeout`,
        db: "Postgres restarts every night and kills the connections",
        lifetime: "Hikari's max-lifetime (30 min) is too long",
        dns: "The DB hostname resolves to a different IP each morning",
      }),
    };
  }

  LB.addAll("net", [
    {
      id: "net-mtu-blackhole",
      name: "Small requests work, big downloads hang",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        const dom = R.pick(DOMS);
        const M = lv === 1 ? 1420 : lv === 2 ? R.pick([1400, 1438]) : 1476, P = lv === 3 ? R.pick([1362, 1366, 1374]) : M;
        return { lv, host: "files." + dom, srv: `10.200.${R.int(1, 9)}.${R.int(10, 99)}`, peer: "10.255.0.1", M, P, dev: lv === 1 ? "wg0" : lv === 2 ? "vti0" : "gre1", lvName: lv === 1 ? "WireGuard" : lv === 2 ? "IPsec" : "GRE-over-IPsec" };
      },
      text: (I) => `<p>You're on the office's VPN gateway, which forwards laptop traffic into the cloud. The cloud security groups drop all ICMP, and that won't change this week. Find out why large responses vanish and fix it <b>on this gateway</b> for all office laptops.</p>${I.lv === 3 ? "<p>The GRE tunnel itself runs over an IPsec link managed by another team.</p>" : ""}`,
      ...LB.term({
        shell: (I) => mtuShell(I),
        goal(st, I) {
          const sp = mtuShell(I), mss = sp.effMss(st);
          if (!st.rules.some((r) => r.chain === "FORWARD")) return st.rules.length ? "Your MSS rule isn't in the FORWARD chain. OUTPUT/POSTROUTING rules on OUTPUT only touch connections the gateway itself makes; laptop traffic is forwarded." : "Laptops still negotiate MSS 1460: large server segments still don't fit the tunnel.";
          if (mss + 40 > I.P) return `Laptops now negotiate MSS ${mss}, i.e. ${mss + 40}-byte packets, but the path only carries ${I.P}.${I.lv === 3 ? " --clamp-mss-to-pmtu uses the gre1 interface MTU, not the smaller MTU of the IPsec path underneath." : ""}`;
          if (mss < I.P - 40 - 120) return `MSS ${mss} works but wastes throughput; the path carries ${I.P}-byte packets.`;
          return true;
        },
        solve: (I) => ({ log: ["ip link show", `ping -c 3 -M do -s ${I.P - 28} ${I.host}`, `ping -c 3 -M do -s ${I.P - 27} ${I.host}`, I.lv === 3 ? `iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss ${I.P - 40}` : "iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"] }),
      }),
      bad: (I) => [{ log: ["iptables -t mangle -A OUTPUT -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"] }, { log: ["iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1460"] }, ...(I.lv === 3 ? [{ log: ["iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"] }] : [])],
      hint: (I) => I.lv === 1 ? "Find the largest packet that crosses the tunnel with Don't Fragment set. Then make TCP endpoints agree on segments that fit." : I.lv === 2 ? "Check which chain the existing rule is in. Forwarded traffic doesn't traverse OUTPUT." : "Bisect with ping -M do -s: the interface MTU and the real path MTU differ.",
      concept: "Path MTU black holes and MSS clamping",
      how: "Tunnels (WireGuard, IPsec, GRE) add headers, so the largest packet that fits is below 1500. Endpoints negotiate TCP MSS from their own interfaces (1460), so the server sends full-size segments with Don't Fragment set; the tunnel router drops them and sends ICMP 'fragmentation needed' back, and if ICMP is filtered the sender never learns (a PMTUD black hole). Small requests and responses fit and work; anything larger stalls. The fix on the router is MSS clamping: rewrite the MSS in SYN packets of forwarded connections (FORWARD chain) to path MTU − 40. --clamp-mss-to-pmtu uses the outgoing interface MTU, which is wrong when the bottleneck is further along the path.",
      rule: "When small works and big hangs across a tunnel, bisect with ping -M do -s, then clamp MSS on forwarded SYNs to path MTU − 40 (and stop filtering ICMP type 3 code 4).",
      why: (I) => `${I.dev} has MTU ${I.M}${I.lv === 3 ? `, but the IPsec path under it only carries ${I.P}` : ""}: ping -M do -s ${I.P - 28} works and ${I.P - 27} doesn't. ${I.lv === 3 ? `--set-mss ${I.P - 40}` : "Clamping MSS to the PMTU"} in FORWARD makes laptops and servers agree on segments that fit.${I.lv === 2 ? " The earlier rule was in OUTPUT, which only affects the gateway's own connections." : ""}`,
    },
    {
      id: "net-nagle-delayed-ack",
      name: "Every call takes exactly 40 ms",
      kind: "Incident",
      skills: ["diagnose", "tune"],
      gen(lv, R) { return { lv, cli: R.pick(["pricing", "checkout", "cart", "risk"]) }; },
      text: (I) => `<p>Calls from <code>${esc(I.cli)}</code> to the internal <code>quotes</code> RPC service take ~40 ms each, although both run in the same availability zone and the handler takes 0.2 ms. Find the cause on the wire and fix it so p50 drops below 1 ms.${I.lv === 3 ? " You can reach the quotes server with <code>ssh quotes-1 ...</code>." : ""}</p>`,
      ...LB.term({
        shell: (I) => nagleShell(I),
        goal(st, I) {
          const cf = Object.keys(st.live).find((k) => k.includes("rpc-client")), sf = "/etc/quotes/server.yaml";
          if (I.lv < 3 && !st.live[cf]) return st.cfg[cf] ? "The client config is changed but the running process still uses the old setting." : "Requests still wait 40 ms for an ACK before the body goes out.";
          if (I.lv === 3 && !st.live[sf]) return st.cfg[sf] ? "The server config is changed but not applied." : "The 40 ms gap is still there. Look at which side waits in the capture.";
          return true;
        },
        solve: (I) => ({ log: I.lv < 3 ? ["tcpdump -nn -i eth0 -c 5 port 7070", `cat /etc/${I.cli}/rpc-client.yaml`, `sed -i 's/tcp_nodelay: false/tcp_nodelay: true/' /etc/${I.cli}/rpc-client.yaml`, `systemctl restart ${I.cli}`, "rpcbench quotes-1:7070 -n 2000"] : ["tcpdump -nn -i eth0 -c 5 port 7070", "ssh quotes-1 cat /etc/quotes/server.yaml", "ssh quotes-1 sed -i 's/tcp_nodelay: false/tcp_nodelay: true/' /etc/quotes/server.yaml", "ssh quotes-1 sudo systemctl restart quotes", "rpcbench quotes-1:7070 -n 2000"] }),
      }),
      bad: (I) => [{ log: [`sed -i 's/tcp_nodelay: false/tcp_nodelay: true/' /etc/${I.cli}/rpc-client.yaml`] }, { log: [`systemctl restart ${I.cli}`] }],
      hint: (I) => I.lv === 1 ? "In the capture, who waits for what between the two halves of the request?" : I.lv === 2 ? "The GC pauses are rare; the 40 ms is on every call. Read the capture." : "Look at the direction of the delayed segment this time.",
      concept: "Nagle's algorithm meets delayed ACK",
      how: "Nagle's algorithm holds a small segment while earlier data is unacknowledged, to coalesce tiny writes. Delayed ACK makes the receiver wait (Linux: up to ~40 ms) before acknowledging, hoping to piggyback the ACK on a response. A sender that writes a request in two pieces (header, then body) sends the first, then Nagle holds the second until the ACK arrives, which the receiver delays because it has no response to send yet: a 40 ms stall per call. Setting TCP_NODELAY on the side that does the split writes, or writing each message with one call, removes it.",
      rule: "Any request/response protocol should set TCP_NODELAY (most RPC libraries do) and write each message in one call; a constant ~40 ms latency on a fast network is the signature.",
      why: (I) => I.lv < 3 ? `The capture shows the client sending a 32-byte header, the server's ACK 40 ms later, then the body: Nagle held the body until the delayed ACK. tcp_nodelay on the client fixed it.${I.lv === 2 ? " The 31 ms full GC is real but rare; it doesn't explain a 40 ms p50." : ""}` : "This time the client already had TCP_NODELAY. The server wrote its response header (64 bytes) and body separately with Nagle on, so the body waited for the client's delayed ACK. tcp_nodelay on the server fixed it.",
    },
    {
      id: "net-cors-preflight",
      name: "Blocked by CORS policy",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) {
        const dom = R.pick(DOMS), shop = `https://shop.${dom}`, api = `https://api.${dom}`;
        const keys = lv === 1 ? ["headers", "origin", "server", "creds"] : lv === 2 ? ["auth", "headers", "origin", "server"] : ["vary", "origin", "creds", "server"];
        const console = lv === 1 ? `Access to fetch at '${api}/v1/cart' from origin '${shop}' has been blocked by CORS policy: Request header field authorization is not allowed by Access-Control-Allow-Headers in preflight response.`
          : lv === 2 ? `Access to fetch at '${api}/v1/cart' from origin '${shop}' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: It does not have HTTP ok status.`
            : `Access to fetch at '${api}/v1/products' from origin '${shop}' has been blocked by CORS policy: The 'Access-Control-Allow-Origin' header has a value 'https://admin.${dom}' that is not equal to the supplied origin.  (only sometimes)`;
        return { lv, dom, console, opts: R.shuffle(keys.slice()), ans: keys[0] };
      },
      text: (I) => `<p>The shop frontend can't call the API from the browser${I.lv === 3 ? ", intermittently, mostly in the morning after the admin team logs in" : " since a release that added bearer-token auth"}. Postman and server-to-server calls work. Reproduce what the browser does with curl and find the root cause.</p>`,
      ...LB.term({
        shell: (I) => corsShell(I),
        goal: (st, I, a) => pickCheck(I, a, {
          origin: "The shop's origin is allowed and echoed back.",
          server: "The API answers normally to real requests.",
          creds: "No wildcard is involved: the server echoes a specific origin.",
          headers: "The preflight response allows authorization.",
        }),
        solve: (I) => ({ log: I.lv === 3 ? [`curl -si https://api.${I.dom}/v1/products -H 'Origin: https://shop.${I.dom}'`, `curl -si 'https://api.${I.dom}/v1/products?cb=1' -H 'Origin: https://shop.${I.dom}'`] : [`curl -si -X OPTIONS https://api.${I.dom}/v1/cart -H 'Origin: https://shop.${I.dom}' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type'`, "cat src/middleware.ts"], pick: optIdx(I, I.ans) }),
      }),
      bad: badPicks,
      hint: (I) => I.lv === 1 ? "A request with an Authorization header isn't 'simple', so the browser sends a preflight first. Compare what it asks for with what the server allows." : I.lv === 2 ? "Browsers never attach credentials or Authorization to a preflight. What does the API do with an OPTIONS request that has no token?" : "Look at the cache headers on the failing response, and at what's missing from them.",
      concept: "CORS preflights and caching",
      how: "Browsers send a cross-origin request directly only if it's 'simple' (GET/POST with basic headers). Anything else, such as an Authorization header or JSON content type, triggers an OPTIONS preflight carrying Origin, Access-Control-Request-Method and -Headers but no credentials. The preflight must return a 2xx with Access-Control-Allow-Origin matching the origin and Allow-Headers/Methods covering what was asked. Auth middleware that runs before CORS rejects preflights. When the server echoes the request's Origin, the response varies by origin and must carry Vary: Origin, or a shared cache will serve one origin's answer to another.",
      rule: "Reproduce the browser's preflight with curl -X OPTIONS and the Access-Control-Request-* headers; let OPTIONS bypass auth; and send Vary: Origin whenever the allowed origin is dynamic.",
      why: (I) => I.lv === 1 ? "The preflight asked for <code>authorization</code>, but Access-Control-Allow-Headers listed only content-type and x-request-id. Add authorization to allowed_headers." : I.lv === 2 ? "requireAuth() runs before cors(), so the token-less OPTIONS preflight gets a 401. Browsers require a 2xx preflight. Skip auth for OPTIONS (or mount CORS first)." : "The CDN caches /v1/products by URL only. The API echoes the request's Origin but doesn't send Vary: Origin, so after an admin-origin request fills the cache, shop users get <code>Access-Control-Allow-Origin: https://admin...</code>. A cache-busting query string returns the right header. Add Vary: Origin (or include Origin in the cache key).",
    },
    {
      id: "net-mtr-reading",
      name: "Is that packet loss real?",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        const dom = R.pick(DOMS), host = "api." + dom;
        const ips = ["192.168.10.1", "100.64.0.1", "203.0.113.1", "198.51.100.17", "198.51.100.62", "192.0.2.33", "192.0.2.89", "203.0.113.129"];
        const n = 8, mk = (arr) => arr.map((ip, i) => ({ ip, ms: [0.4, 2.1, 4.3, 9.8, 15.6, 22.4, 31.7, 38.2][i] + R.int(0, 9) / 10 }));
        const hops = mk([...ips.slice(0, n - 1), `203.0.113.${R.int(10, 99)}`]);
        const rhops = mk(["10.40.0.1", "10.40.255.1", "192.0.2.90", "192.0.2.34", "198.51.100.61", "198.51.100.18", "100.64.0.1", "192.168.10.20"]);
        const h = lv === 1 ? R.int(3, 5) : lv === 2 ? R.int(4, 5) : R.int(3, 5);
        const keys = lv === 1 ? ["icmp", "hop", "dest", "wifi"] : lv === 2 ? ["real", "icmp", "server", "dest"] : ["reverse", "icmp", "server", "wifi"];
        return { lv, host, ip: hops[n - 1].ip, office: "198.51.100.200", hops, rhops, h, loss: lv === 1 ? R.int(35, 70) : R.int(4, 9), opts: R.shuffle(keys.slice()), ans: keys[0] };
      },
      text: (I) => `<p>${I.lv === 1 ? "Someone attached an mtr screenshot with red numbers to a ticket. Work out" : "Work out"} what is really happening between the office bastion and <code>${esc(I.host)}</code>, and pick the root cause.</p>`,
      ...LB.term({
        shell: (I) => mtrShell(I),
        goal: (st, I, a) => pickCheck(I, a, {
          hop: `Loss at hop ${I.h + 1} that doesn't continue to later hops is the router declining to answer probes, not dropping forwarded traffic.`,
          icmp: I.lv === 1 ? "" : `If hop ${I.h + 1} were only rate-limiting ICMP, later hops and the destination would show 0% loss.`,
          dest: "The destination shows no loss of its own beyond what upstream hops show.",
          server: I.lv === 1 ? "" : I.lv === 2 ? "Connect times of ~1 s (a retransmitted SYN) point at the network, not the server." : "Small requests are fast and the server time is low; the problem is moving lots of data toward you.",
          wifi: "The first hops show no loss.",
        }),
        solve: (I) => ({ log: [`mtr -rwc 100 ${I.host}`, `curl -s -o /dev/null -w 'connect=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\\n' https://${I.host}/v1/search?q=boots`, ...(I.lv === 3 ? [`ssh api-1 mtr -rwc 100 ${I.office}`] : [])], pick: optIdx(I, I.ans) }),
      }),
      bad: badPicks,
      hint: (I) => I.lv === 1 ? "Loss that appears at one hop and disappears at the next can't be loss of forwarded traffic." : I.lv === 2 ? "Real loss starts at some hop and every hop after it shows at least as much." : "Packets travel back on a path a forward mtr never measures.",
      concept: "Reading mtr and traceroute",
      how: "mtr sends probes with increasing TTL; each router that decrements TTL to zero is supposed to reply with ICMP Time Exceeded. Routers generate those replies in their control plane, often rate-limited or deprioritised, so a hop can show heavy 'loss' while forwarding all traffic perfectly; the tell is that later hops show less. Real loss appears at some hop and persists, at a similar or higher rate, to every later hop and the destination. Return traffic may take a different path entirely, so loss affecting downloads can be invisible from your side: run mtr from the far end too.",
      rule: "Only trust loss that continues to the destination; check the reverse path from the server; and confirm with application timings (curl -w) before blaming the network.",
      why: (I) => I.lv === 1 ? `Hop ${I.h + 1} showed ${I.loss}% but every later hop and the destination showed 0%: it just rate-limits ICMP. curl showed connect in 32 ms and the first byte after 2.3 s: the server is slow.` : I.lv === 2 ? `Loss of ~${I.loss}% begins at hop ${I.h + 1} and persists to the destination: real. Connect times of ~1 s are SYN retransmits.` : `Forward path clean, but mtr from api-1 back to the office shows ${I.loss}% loss from hop ${I.h + 1}. Big downloads flow server → office, along that path.`,
    },
    {
      id: "net-curl-timing",
      name: "Where do the milliseconds go?",
      kind: "Investigation",
      skills: ["diagnose", "estimate"],
      gen(lv, R) {
        const dom = R.pick(DOMS), keys = lv === 1 ? ["dns", "server", "tls", "bw"] : lv === 2 ? ["reuse", "server", "tls", "dns"] : ["expect", "server", "bw", "tls"];
        return { lv, host: "quotes." + dom, ip: `203.0.113.${R.int(10, 250)}`, dead: `10.0.0.${R.int(5, 9)}`, rtt: R.pick([70, 90, 140, 180]), region: R.pick(["us-east-1", "eu-west-1"]), from: R.pick(["ap-south-1", "ap-southeast-1"]), body: R.int(2, 9) * 1024 * 1024, opts: R.shuffle(keys.slice()), ans: keys[0] };
      },
      text: (I) => `<p>A client spends far longer per call than the server says it works. curl's <code>-w</code> timings are cumulative from the start of the transfer: DNS done → TCP connected → TLS done → first response byte → end. Break the time down and pick the root cause.</p>${I.lv === 2 ? `<p><code>timing.txt</code> prints the six standard <code>%{time_*}</code> fields; curl can fetch several URLs in one run, reusing the connection.</p>` : ""}`,
      ...LB.term({
        shell: (I) => curlTimingShell(I),
        goal: (st, I, a) => pickCheck(I, a, { server: "The time to first byte minus TLS-done is small; the server isn't the problem.", tls: "TLS itself completes in a couple of round trips.", dns: "Name resolution takes about a millisecond.", bw: "The body is uploaded quickly once it starts." }),
        solve: (I) => ({ log: I.lv === 1 ? [`curl -s -o /dev/null -w @timing.txt https://${I.host}/v1/quote`, "cat /etc/resolv.conf", `dig @${I.dead} ${I.host} +short`] : I.lv === 2 ? [`curl -s -o /dev/null -w @timing.txt https://${I.host}/v1/quote https://${I.host}/v1/quote`, "cat src/quote_client.py"] : [`curl -s -o /dev/null -w @timing.txt https://${I.host}/v1/batch -d @batch.json`, `curl -sv -o /dev/null https://${I.host}/v1/batch -d @batch.json`], pick: optIdx(I, I.ans) }),
      }),
      bad: badPicks,
      hint: (I) => I.lv === 1 ? "Which phase ends 5 s in?" : I.lv === 2 ? "Compare the first and second transfer on the same connection, and the client code." : "Big uploads only. Read the request headers curl sends.",
      concept: "Reading curl -w timing phases",
      how: "curl's timers are cumulative: time_namelookup (DNS), time_connect (TCP handshake done), time_appconnect (TLS done), time_starttransfer (first response byte), time_total. Subtracting neighbours gives each phase. DNS stuck at exactly 5 s is a resolver timeout. Connect ≈ 1 RTT and TLS ≈ 1–2 more RTTs, so a client that opens a new connection per call across a long RTT pays 3+ RTTs before sending anything; reusing the connection removes them. For request bodies over a size threshold curl (and some HTTP clients) send Expect: 100-continue and wait up to 1 s for a 100 response the server may never send.",
      rule: "Before tuning anything, split latency into DNS / connect / TLS / server / transfer with curl -w; the phase that's large tells you the layer to fix.",
      why: (I) => I.lv === 1 ? `time_namelookup was 5.004 s: the first nameserver ${I.dead} is dead and glibc waited out its 5 s timeout before asking 10.0.0.2.` : I.lv === 2 ? `With a ${I.rtt} ms RTT, a fresh connection costs ~${3 * I.rtt} ms before the request is sent (TCP + TLS 1.2). The second request on the same connection took ~${I.rtt + 41} ms. The client calls requests.get() without a Session, so it never reuses connections.` : "curl sent Expect: 100-continue and waited the full 1 s for a 100 response the server never sent; with an empty Expect: header the upload took 41 ms.",
    },
    {
      id: "net-retransmits",
      name: "Retransmits and drops: whose fault?",
      kind: "Investigation",
      skills: ["diagnose"],
      gen(lv, R) {
        const keys = lv === 1 ? ["nic", "network", "cpu", "listen"] : lv === 2 ? ["listen", "somax", "network", "cpu"] : ["ring", "network", "nic", "cpu"];
        return { lv, host: `${R.pick(["api", "ingest", "edge"])}-${R.int(10, 40)}`, svc: R.pick(K.NAMES.svc), opts: R.shuffle(keys.slice()), ans: keys[0] };
      },
      text: (I) => `<p>You're root on the affected host. Use the kernel and NIC counters to find where packets are being lost, and pick the root cause.${I.lv === 2 ? " The host's sysctls were tuned last quarter." : ""}</p>`,
      ...LB.term({
        shell: (I) => retransShell(I),
        goal: (st, I, a) => pickCheck(I, a, {
          network: "The counters point at this host itself, and a one-hop mtr is clean.",
          cpu: "CPU isn't saturated and doesn't produce these counters.",
          listen: "There are no listen overflows.",
          somax: "somaxconn is 4096; the app passes 128 to listen(), and the smaller value wins.",
          nic: "There are no CRC/frame errors.",
        }),
        solve: (I) => ({ log: I.lv === 1 ? ["nstat -az | grep -iE 'retrans|overflow|drop|timeout'", "ethtool -S eth0 | grep -iE 'err|drop|miss'"] : I.lv === 2 ? ["nstat -az | grep -iE 'retrans|overflow|drop|timeout'", "ss -lnt 'sport = :8080'", "cat /etc/app/server.yaml"] : ["nstat -az | grep -iE 'retrans|overflow|drop|timeout'", "ethtool -S eth0 | grep -iE 'err|drop|miss'", "ethtool -g eth0"], pick: optIdx(I, I.ans) }),
      }),
      bad: badPicks,
      hint: (I) => I.lv === 1 ? "Retransmits on one host only: check the physical layer counters." : I.lv === 2 ? "Latency in steps of 1 s and 3 s is the SYN retransmission schedule. Who drops SYNs?" : "rx_missed / no_buffer means the NIC had nowhere to put the packet.",
      concept: "Finding where packets are dropped",
      how: "TCP retransmits say a segment was lost, not where. Host counters narrow it down: NIC CRC/frame errors mean a physical problem (cable, optic, port); rx_missed/no_buffer means the NIC's receive ring filled during a burst before the kernel drained it (raise it with ethtool -G, up to the pre-set maximum); ListenOverflows/ListenDrops mean the accept queue was full and SYNs were dropped, which clients see as connection setup delays of 1 s, then 3 s (initial RTO and backoff). The accept queue is min(backlog passed to listen(), net.core.somaxconn).",
      rule: "Before blaming the network, read nstat and ethtool -S on both ends; latency in 1 s / 3 s steps means dropped SYNs.",
      why: (I) => I.lv === 1 ? "rx_crc_errors at 184k and rising on this host only: frames arrive corrupted. Drain the host and get the cable/optic/port replaced." : I.lv === 2 ? "ListenOverflows = 38,842 and the listen socket's Recv-Q (129) exceeds its backlog (128): the app calls listen(128), so somaxconn = 4096 doesn't help. Dropped SYNs are retried after 1 s and 3 s, exactly the p99 steps." : "rx_missed_errors/rx_no_buffer_count are 2.2 M and the RX ring is 256 of a possible 4096: bursts overflow the ring. ethtool -G eth0 rx 4096 (and spreading interrupts) stops the drops.",
    },
    {
      id: "net-happy-eyeballs",
      name: "IPv6 made it slower",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) {
        const dom = R.pick(DOMS), keys = lv === 1 ? ["partner", "egress", "dns", "tls"] : lv === 2 ? ["egress", "partner", "dns", "firewall"] : ["stale", "partner", "egress", "tls"];
        const n6 = lv === 3 ? 4 : 2;
        const v6 = Array.from({ length: n6 }, (_, i) => `2001:db8:${R.int(10, 99)}:${i + 1}::${R.int(10, 99)}`);
        return { lv, host: "api." + dom, svc: R.pick(["payouts", "sync", "billing", "fx"]), v6, v4: [`203.0.113.${R.int(10, 120)}`, `203.0.113.${R.int(121, 250)}`], dead6: lv === 3 ? R.pick(v6) : null, probe: "mirror.pebbleworks.net", opts: R.shuffle(keys.slice()), ans: keys[0] };
      },
      text: (I) => `<p>The <code>${esc(I.svc)}</code> service uses Python <code>requests</code> with a 10 s connect timeout. It tries the addresses <code>getaddrinfo()</code> returns one by one. curl implements Happy Eyeballs (RFC 8305): it races IPv6 and IPv4. Find the cause and pick it.</p>`,
      ...LB.term({
        shell: (I) => v6Shell(I),
        goal: (st, I, a) => pickCheck(I, a, {
          partner: I.lv === 2 ? "IPv6 to an unrelated site fails too: the problem is on our side." : I.lv === 3 ? "Most of the partner's IPv6 addresses work." : "",
          egress: I.lv === 1 ? "IPv6 to an unrelated site works fine." : I.lv === 3 ? "Our IPv6 egress works: most addresses connect." : "",
          dns: "DNS answers immediately.",
          tls: "Connections time out before TLS even starts.",
          firewall: "IPv4 works fine.",
        }),
        solve: (I) => ({ log: I.lv === 3 ? [`dig ${I.host} AAAA +short`, ...I.v6.map((ip) => `nc -6 -zv -w 3 ${ip} 443`)] : [`getent ahosts ${I.host}`, `curl -6 -sv -m 5 -o /dev/null https://${I.host}/`, `curl -6 -sv -m 5 -o /dev/null https://${I.probe}/`], pick: optIdx(I, I.ans) }),
      }),
      bad: badPicks,
      hint: (I) => I.lv === 1 ? "Force IPv6 to the partner, then to some other IPv6 site." : I.lv === 2 ? "Is it the partner's IPv6, or all IPv6 from this host?" : "Test each IPv6 address on its own.",
      concept: "Dual stack, address selection and Happy Eyeballs",
      how: "On a host with global IPv6, getaddrinfo() orders IPv6 addresses before IPv4 (RFC 6724). A client that tries addresses sequentially with a long connect timeout hangs for the whole timeout when the IPv6 path is broken, then succeeds over IPv4. Browsers and curl use Happy Eyeballs (start IPv6, start IPv4 after ~250 ms if needed, keep the winner), which hides the breakage, so 'curl is fine' proves nothing. The break can be the far end (dead AAAA, missing IPv6 listener), your egress (no IPv6 route out), or one stale record among several.",
      rule: "When latency equals a connect timeout after IPv6 appeared, test curl -6 to the target and to an unrelated IPv6 site, test each AAAA address, and use clients with Happy Eyeballs or short connect timeouts.",
      why: (I) => I.lv === 1 ? `curl -6 to ${I.host} times out while IPv6 to another site works: the partner published AAAA records for an endpoint that doesn't answer. Our client tries IPv6 first and waits 10 s each time.` : I.lv === 2 ? "IPv6 to every destination hangs: our hosts got IPv6 addresses and a default route, but the path out drops IPv6. Fix egress (or stop advertising IPv6 until it works)." : `Only ${I.dead6} fails: a stale AAAA record for a decommissioned load balancer. Clients that pick it first (1 in ${I.v6.length}) wait out the 10 s timeout; Happy Eyeballs clients never notice.`,
    },
    {
      id: "net-idle-reset",
      name: "Connection reset every morning",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) {
        const keys = lv === 1 ? ["idle", "db", "dns", "lifetime"] : lv === 2 ? ["optin", "idle", "interval", "db"] : ["interval", "lifetime", "optin", "db"];
        return { lv, opts: R.shuffle(keys.slice()), ans: keys[0] };
      },
      text: (I) => `<p>The Java <code>orders</code> service keeps a HikariCP pool to Postgres. Overnight traffic is near zero. Each morning the first requests fail; retries succeed. Postgres logs show nothing unusual. Find the root cause${I.lv >= 2 ? ": the obvious fix has already been tried" : ""}.</p>`,
      ...LB.term({
        shell: (I) => idleShell(I),
        goal: (st, I, a) => pickCheck(I, a, {
          db: "Postgres didn't restart; it answered the query with a RST because it wasn't even the sender: the firewall was.",
          dns: "The IP is the same; the connection itself was dead.",
          lifetime: I.lv === 3 ? "Shortening max-lifetime to under 350 s would mask it by churning connections, but it isn't why keepalives fail to keep them alive." : "Max lifetime limits a connection's age, not its idle time.",
          idle: I.lv === 1 ? "" : "True as far as it goes, but the change log shows keepalives were supposed to fix that. Why didn't they?",
          optin: I.lv === 3 ? "ss shows keepalive timers on the sockets: keepalive is on." : "",
          interval: I.lv === 2 ? "There's no keepalive timer on the sockets at all." : "",
        }),
        solve: (I) => ({ log: I.lv === 1 ? ["tcpdump -nn -r first-query.pcap", "cat /etc/network/README"] : ["cat /etc/network/README", "ss -tnoe dst :5432", "sysctl net.ipv4.tcp_keepalive_time", "cat /etc/orders/application.properties"], pick: optIdx(I, I.ans) }),
      }),
      bad: badPicks,
      hint: (I) => I.lv === 1 ? "Look at what happened on the wire right before the RST, and at what sits between the app and the DB." : I.lv === 2 ? "A kernel keepalive sysctl only applies to sockets that enable SO_KEEPALIVE. Do these show a keepalive timer?" : "Compare the keepalive timer with the firewall's idle timeout.",
      concept: "Idle timeouts in middleboxes and TCP keepalive",
      how: "Stateful firewalls, NAT gateways and load balancers drop flows that stay idle longer than their timeout (often 350 s to 1 h) without telling either end. A pooled connection idle overnight looks fine to both sides until the next packet, which the middlebox answers with RST or silently drops. TCP keepalive sends probes on idle connections, but only for sockets that set SO_KEEPALIVE (pgjdbc's tcpKeepAlive defaults to false; libpq enables it by default), and only after net.ipv4.tcp_keepalive_time (default 7200 s). It must be shorter than the middlebox timeout. Pools can also validate or retire idle connections before that timeout.",
      rule: "Know the idle timeout of every middlebox in the path, and make sure pooled connections either send keepalives more often than that or are retired before it.",
      why: (I) => I.lv === 1 ? "The capture shows 41 idle minutes, then the query answered by a RST: the firewall had expired the session after 350 s. Enable TCP keepalive below 350 s (or retire idle connections sooner)." : I.lv === 2 ? "tcp_keepalive_time=300 is set, but ss shows no keepalive timers: the JDBC URL doesn't set tcpKeepAlive=true, so the sockets never opt in." : "Keepalive is on, but the first probe goes out after 600 s idle, while the firewall forgets the session at 350 s. Lower tcp_keepalive_time (e.g. 240 s) or have the pool keep connections active.",
    },
  ]);

  /* ================= capacity, addressing, HTTP and design ================= */
  const mathis = (mss, rttS, p) => ((mss * 8) / rttS) * (1.22 / Math.sqrt(p));
  function winEval(I, c) {
    const rtt = I.rtt / 1000, win = (c.rmem * 1e6 * 8) / rtt;
    const lossCap = I.loss && (I.lv < 3 || c.cc === "cubic") ? mathis(1448, rtt, I.loss) : Infinity;
    const per = Math.min(win, lossCap, (I.link * 1e9) / c.streams);
    return { per, tot: per * c.streams, mem: c.streams * c.rmem, lim: per === win ? "window" : per === lossCap ? "loss" : "link" };
  }
  const EXIST = {
    1: ["10.0.0.0/16", "192.168.0.0/16"],
    2: ["10.0.0.0/16", "192.168.0.0/16", "172.16.0.0/12", "10.64.0.0/14"],
    3: ["10.0.0.0/16", "192.168.0.0/16", "172.16.0.0/12", "10.64.0.0/14", "10.16.0.0/12"],
  };
  const EXN = { "10.0.0.0/16": "peered shared-services VPC", "192.168.0.0/16": "on-prem data centre", "172.16.0.0/12": "office VPN pool", "10.64.0.0/14": "Kubernetes pod range (other cluster)", "10.16.0.0/12": "partner network (new peering)" };
  function cidrEval(I, c) {
    const want = `${c.base}/${c.prefix}`, cr = K.cidr(want), aligned = cr.str === want;
    const clash = EXIST[I.lv].filter((e) => K.overlap(want, e));
    const sub = 2 ** (32 - c.sub), usable = sub - 5, need = 2 * I.n * sub;
    return { aligned, clash, usable, fits: need <= cr.size, size: cr.size, need };
  }
  const cidrValid = (I, c) => {
    const r = cidrEval(I, c);
    if (!r.aligned) return `${c.base}/${c.prefix} isn't a valid network address (the network is ${K.cidr(c.base + "/" + c.prefix).str})`;
    if (r.clash.length) return `overlaps ${r.clash.map((x) => `${x} (${EXN[x]})`).join(", ")}: routing between them breaks`;
    if (r.usable < I.hosts) return `a /${c.sub} has only ${r.usable} usable addresses; each subnet needs ${I.hosts}`;
    if (!r.fits) return `${I.n} subnets of /${c.sub}, doubled for growth, need ${K.num(r.need)} addresses; a /${c.prefix} has ${K.num(r.size)}`;
    return true;
  };
  function natEval(I, c) {
    const ka = c.ka === "on", dests = c.spread === "all" ? 4 : 1;
    const perDest = ka ? Math.ceil(I.rate * I.dur * 1.5) : Math.ceil((I.rate * (I.dur + 60)) / dests);
    const cap = 55000 * c.ips;
    return { perDest, cap, ok: perDest <= cap, util: perDest / cap, cost: c.ips * I.ipCost };
  }
  function grpcEval(I, c) {
    const C = I.conns, B = I.b1, B0 = I.b0, age = c.age !== "off" && parseInt(c.age, 10) <= 10;
    let imb;
    if (c.lb === "l7") imb = 1;
    else if (c.lb === "rr") imb = age ? 1 : B / B0;
    else imb = age ? Math.ceil(C / B) / (C / B) : Math.ceil(C / B0) / (C / B);
    const lat = c.lb === "l7" ? 0.8 : 0;
    const cost = (c.lb === "l7" ? I.l7Cost : 0) + (c.lb === "rr" ? 0 : 0);
    return { imb, lat, cost };
  }
  const grpcValid = (I, c) => {
    const r = grpcEval(I, c);
    if (r.imb > 1.25) return `the busiest backend gets ${r.imb.toFixed(2)}× the average load 10 minutes after the scale-out`;
    if (I.lv === 3 && r.lat > I.budget) return `the extra proxy hop adds ~${r.lat} ms p99, over the ${I.budget} ms budget`;
    return true;
  };

  function parseCC(src) {
    const out = {}, errs = [];
    String(src).split("\n").forEach((ln) => {
      const t = ln.trim(); if (!t || t.startsWith("#")) return;
      const m = t.match(/^(\S+?)\s*(?::|=>)\s*(.*)$/); if (!m) { errs.push(t); return; }
      const d = {};
      m[2].replace(/^cache-control:\s*/i, "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).forEach((x) => { const [k, v] = x.split("="); d[k.trim()] = v == null ? true : +v.trim(); });
      out[m[1]] = d;
    });
    return { out, errs };
  }
  function ccCheck(I, src) {
    const { out, errs } = parseCC(src);
    if (errs.length) return `Couldn't parse <code>${esc(errs[0])}</code>. Use <code>path: directives</code>.`;
    for (const p of ccPaths(I.lv)) {
      const d = out[p.path];
      if (!d) return `No header for <code>${esc(p.path)}</code>.`;
      const r = p.check(d);
      if (r !== true) return `<code>${esc(p.path)}</code>: ${r}`;
    }
    return true;
  }
  const CC = {
    asset: (imm) => ({ path: "/assets/app.3f9a1c.js", need: `fingerprinted file: cache it everywhere for a year${imm ? "; browsers must not even revalidate on reload" : ""}`, check: (d) => d["no-store"] || d["no-cache"] || d.private ? "this file never changes; let every cache keep it" : !(d["max-age"] >= 2592000) ? "max-age should be long (a year); the hash in the name changes on every deploy" : imm && !d.immutable ? "add <code>immutable</code> so reloads don't revalidate" : true, sol: `public, max-age=31536000${imm ? ", immutable" : ""}` }),
    html: () => ({ path: "/index.html", need: "may be stored, but every use must be revalidated with the origin (it has an ETag), so a deploy shows up immediately", check: (d) => d["no-store"] ? "no-store forbids keeping it at all, so every load re-downloads it; you only need revalidation" : d["no-cache"] || d["max-age"] === 0 || d["s-maxage"] === 0 ? (d["max-age"] > 0 ? "max-age > 0 lets browsers reuse it without asking" : true) : "without no-cache (or max-age=0) browsers and the CDN reuse a stale copy after a deploy", sol: "no-cache" }),
    account: (path) => ({ path, need: "personal data: never stored by shared caches (CDN, corporate proxies)", check: (d) => d.public ? "public lets the CDN serve one user's data to another" : d.private || d["no-store"] ? (d["s-maxage"] ? "s-maxage on a private response is contradictory" : true) : "add private (or no-store)", sol: "private, no-store" }),
    products: (sie) => ({ path: "/api/products", need: `CDN may cache 60 s and serve it stale for up to 30 s more while refreshing in the background; browsers must not cache it${sie ? "; if the origin is down, the CDN may keep serving it for a day" : ""}`, check: (d) => d.private || d["no-store"] ? "the CDN has to cache it" : d["s-maxage"] !== 60 ? "the CDN TTL should be s-maxage=60 (shared caches only)" : !(d["max-age"] === 0 || d["no-cache"]) ? "browsers fall back to max-age or heuristics; set max-age=0" : !(d["stale-while-revalidate"] > 0 && d["stale-while-revalidate"] <= 30) ? "allow serving stale while revalidating for up to 30 s (stale-while-revalidate=30)" : sie && !(d["stale-if-error"] >= 86400) ? "add stale-if-error=86400" : true, sol: `public, max-age=0, s-maxage=60, stale-while-revalidate=30${sie ? ", stale-if-error=86400" : ""}` }),
  };
  function ccPaths(lv) { return lv === 1 ? [CC.asset(false), CC.html(), CC.account("/account/orders")] : lv === 2 ? [CC.asset(false), CC.products(false), CC.account("/api/cart")] : [CC.asset(true), CC.html(), CC.products(true), CC.account("/api/cart")]; }

  function ngxListens(src) { const out = []; String(src).replace(/#[^\n]*/g, "").replace(/listen\s+([^;]+);/g, (m, a) => { const t = a.trim().split(/\s+/); out.push({ port: +(t[0].split(":").pop()), pp: t.includes("proxy_protocol"), ssl: t.includes("ssl") }); return m; }); return out; }
  function ppCheck(I, src) {
    const s = String(src).replace(/#[^\n]*/g, "");
    if ((s.match(/\{/g) || []).length !== (s.match(/\}/g) || []).length) return "nginx: [emerg] unexpected end of file, expecting \"}\"";
    const L = ngxListens(s), on = (p) => L.filter((x) => x.port === p);
    if (I.lv < 3) {
      if (!on(443).length) return "Nothing listens on 443 any more.";
      if (!on(443).every((x) => x.pp)) return "Port 443 doesn't expect the PROXY header yet, so nginx reads the header bytes as the start of the TLS handshake and every connection fails.";
      if (I.lv === 2 && !on(8081).length) return "The health-check listener on 8081 is gone.";
      if (I.lv === 2 && on(8081).some((x) => x.pp)) return "Health checks to 8081 are sent without a PROXY header; with proxy_protocol there, nginx waits for one, every check fails and all targets go unhealthy.";
    } else {
      if (!on(443).length || on(443).some((x) => x.pp)) return "During the migration, port 443 must keep working for the current target group, which sends no PROXY header.";
      if (!on(8443).length || !on(8443).every((x) => x.pp && x.ssl)) return "Add <code>listen 8443 ssl proxy_protocol;</code> for the new target group.";
    }
    const hdr = (s.match(/real_ip_header\s+(\S+?);/) || [])[1];
    if (hdr !== "proxy_protocol") return "Without <code>real_ip_header proxy_protocol;</code> $remote_addr stays the load balancer's address.";
    const froms = []; s.replace(/set_real_ip_from\s+(\S+?);/g, (m, a) => { froms.push(a); return m; });
    if (!froms.length) return "realip only trusts addresses listed in <code>set_real_ip_from</code>; add the LB subnet.";
    if (froms.some((f) => /^0\.0\.0\.0\/0$|^::\/0$/.test(f) || (/\//.test(f) && +f.split("/")[1] < 8))) return "Trusting every address lets anyone who can reach nginx directly forge their client IP. Trust only the LB subnet.";
    if (!froms.some((f) => f.includes("/") ? (K.overlap(f, I.lbNet) && +f.split("/")[1] >= 16) : K.inCidr(f, I.lbNet))) return `The LB connects from ${I.lbNet}; your set_real_ip_from doesn't cover it.`;
    return true;
  }
  function wsCheck(I, src) {
    const s = String(src).replace(/#[^\n]*/g, "");
    if ((s.match(/\{/g) || []).length !== (s.match(/\}/g) || []).length) return "nginx: [emerg] unexpected end of file, expecting \"}\"";
    if (!/proxy_http_version\s+1\.1\s*;/.test(s)) return "nginx speaks HTTP/1.0 to upstreams by default, which has no Upgrade mechanism: set <code>proxy_http_version 1.1;</code>";
    if (!/proxy_set_header\s+Upgrade\s+\$http_upgrade\s*;/i.test(s)) return "Upgrade is a hop-by-hop header: nginx drops it unless you forward it with <code>proxy_set_header Upgrade $http_upgrade;</code>";
    const conn = (s.match(/proxy_set_header\s+Connection\s+([^;]+);/i) || [])[1];
    if (!conn) return "The Connection: upgrade header must be set explicitly too (it's hop-by-hop).";
    if (I.lv === 3) {
      if (conn.trim() !== "$connection_upgrade") return "This location also serves normal API calls over keep-alive upstream connections. A hard-coded Connection \"upgrade\" asks to upgrade every request; map $http_upgrade to $connection_upgrade instead.";
      if (!/map\s+\$http_upgrade\s+\$connection_upgrade\s*\{[^}]*default\s+upgrade\s*;[^}]*\}/.test(s)) return "Define the map: <code>map $http_upgrade $connection_upgrade { default upgrade; '' ''; }</code> (at http level).";
    } else if (!/^("upgrade"|'upgrade'|upgrade|\$connection_upgrade)$/i.test(conn.trim())) return "Send <code>Connection \"upgrade\"</code> upstream.";
    if (I.lv >= 2) {
      const m = s.match(/proxy_read_timeout\s+(\d+)(ms|s|m|h|d)?\s*;/);
      const secs = m ? +m[1] * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2] || "s"]) : 60;
      if (secs < I.idle) return `proxy_read_timeout is ${secs} s: quiet rooms stay silent for up to ${I.idle / 60} min, and nginx closes the socket when nothing is read for that long.`;
      if (secs > 86400) return "That timeout effectively never closes dead connections; something like an hour or two is plenty.";
    }
    return true;
  }

  const KEYPOOL = {
    1: [["?page=2 on /products", 0], ["utm_source / gclid tracking parameters", 1], ["Accept-Encoding (the CDN stores gzip and br variants)", 0], ["Cookie: _ga analytics cookie on product pages", 1], ["Requests to /api/me carrying an Authorization header", 2], ["?sort=price on /products", 0], ["Responses that set a session cookie (Set-Cookie)", 2]],
    2: [["Accept-Language, when pages are localised from that header", 0], ["X-Forwarded-Host, which the app reflects into <link> and redirect URLs", 1], ["?fbclid=... on landing pages", 1], ["/cart (different for every user)", 2], ["?q= on /search", 0], ["Cookie: session=... on the anonymous homepage (the app ignores it there)", 1], ["Device class (mobile/desktop), normalised at the edge from User-Agent", 0]],
    3: [["X-HTTP-Method-Override, which the framework honours", 1], ["X-Original-URL, which the framework uses to rewrite the path", 1], ["The raw User-Agent string, when the app only branches on mobile vs desktop", 1], ["Origin, when the API echoes it in Access-Control-Allow-Origin", 0], ["Accept, when /api/report returns CSV or JSON depending on it", 0], ["A ?v=<build> parameter the frontend adds to versioned JS URLs", 0], ["POST /api/orders", 2]],
  };

  const TOPO_N = [
    { label: "Users", x: 60, y: 160 }, { label: "DNS", sub: "authoritative", x: 200, y: 50 }, { label: "CDN", x: 200, y: 170 }, { label: "Load balancer", x: 330, y: 170 },
    { label: "app (AZ a)", x: 460, y: 115 }, { label: "app (AZ b)", x: 460, y: 245 }, { label: "Postgres", sub: "primary", x: 640, y: 250 }, { label: "NAT gateway", sub: "AZ a", x: 610, y: 35 }, { label: "Payment API", sub: "partner", x: 740, y: 35 },
  ];
  const TOPO_L = [[0, 1], [0, 2], [2, 3], [3, 4], [3, 5], [4, 6], [5, 6], [4, 7], [5, 7], [7, 8]];
  const TOPO_SYM = {
    "n0": "Nothing: users aren't a component you can fail.", "n1": "New visitors (and anyone whose cached DNS answer expired) can't resolve the site at all; people mid-session keep working.", "n2": "Everything fails for everyone, cached assets included.", "n3": "All API calls fail; cached static assets still load from the CDN.",
    "n4": "The LB health check pulls AZ a; everything keeps working on AZ b, slower.", "n5": "The LB pulls AZ b; AZ a carries the load.", "n6": "Every request that touches the database fails, in both AZs.", "n7": "All outbound calls to the internet from both AZs time out (both route via this NAT); everything internal works.", "n8": "Payment calls fail fast with errors from the partner (its status page would be red).",
    "l0": "Same as a DNS outage for clients.", "l1": "Users can't reach the CDN at all.", "l2": "CDN → origin broken: cache misses fail, cache hits still work.", "l3": "LB → AZ a broken: health checks pull AZ a.", "l4": "LB → AZ b broken: health checks pull AZ b.", "l5": "app (AZ a) can't reach the database: its requests time out, but its health check (process-only) stays green.", "l6": "app (AZ b) can't reach the database: about half of requests (those routed to AZ b) time out after the pool timeout; AZ a is fine; health checks stay green.", "l7": "Only AZ a loses outbound internet.", "l8": "Only AZ b loses outbound internet.", "l9": "The NAT can't reach the partner: payment calls time out from both AZs.",
  };

  LB.addAll("net", [
    {
      id: "net-tcp-window",
      name: "Make the cross-region copy fast",
      kind: "Capacity plan",
      skills: ["tune", "estimate"],
      w: "tune",
      sense: "min",
      vname: "buffer memory of",
      vfmt: (v) => v + " MB",
      gen(lv, R) { return { lv, rtt: lv === 1 ? R.pick([60, 70, 80]) : lv === 2 ? 100 : 140, target: lv === 1 ? 1 : 2, loss: lv === 1 ? 0 : lv === 2 ? 1e-6 : 1e-5, link: 10, from: R.pick(["us-east-1", "eu-west-1"]), to: R.pick(["ap-southeast-2", "ap-south-1", "sa-east-1"]) }; },
      text: (I) => `<p>Nightly backups are copied from ${I.from} to ${I.to} over a 10 Gbit/s path with <b>RTT ${I.rtt} ms</b>${I.loss ? ` and a steady background packet loss of <b>${(I.loss * 100).toPrecision(1)}%</b>` : ""}. A single TCP stream with default buffers crawls. The copy needs <b>≥ ${I.target} Gbit/s</b>.</p><p>Pick the per-socket receive buffer (net.ipv4.tcp_rmem max; assume all of it is usable as window) and the number of parallel streams${I.lv === 3 ? ", and the congestion control algorithm" : ""}, using the <b>least buffer memory</b> (streams × buffer).</p>`,
      ui: (I) => ({
        knobs: [{ k: "rmem", label: "Receive buffer per socket", opts: [4, 8, 16, 32, 64], unit: "MB" }, { k: "streams", label: "Parallel streams", opts: [1, 2, 4, 8, 16, 32] }, ...(I.lv === 3 ? [{ k: "cc", label: "Congestion control", opts: ["cubic", "bbr"] }] : [])],
        live: (c) => { if (!c) return ""; const r = winEval(I, c); return K.metrics([{ name: "Per stream", value: `${K.num(r.per / 1e6)} Mbit/s`, ok: null, target: `limited by ${r.lim}` }, { name: "Total", value: `${K.num(r.tot / 1e9, 2)} Gbit/s`, ok: r.tot >= I.target * 1e9, target: `≥ ${I.target} Gbit/s` }, { name: "Buffer memory", value: r.mem + " MB", ok: null }]); },
      }),
      valid: (I, c) => { const r = winEval(I, c); return r.tot >= I.target * 1e9 ? true : `only ${K.num(r.tot / 1e9, 2)} Gbit/s (each stream is limited by ${r.lim})`; },
      val: (I, c) => winEval(I, c).mem,
      hint: (I) => I.lv === 1 ? "Throughput per stream ≤ window / RTT. Bandwidth-delay product = rate × RTT." : I.lv === 2 ? "With loss, a loss-based stream tops out near (MSS/RTT) × 1.22/√p (Mathis), whatever its window. More streams share the loss." : "At this loss rate CUBIC streams are tiny. BBR paces to the measured bottleneck rate and doesn't treat random loss as congestion.",
      concept: "Bandwidth-delay product, windows and loss",
      how: "TCP can have at most one window of unacknowledged data in flight, so one stream's throughput is at most window / RTT. Filling a path needs a window of at least bandwidth × RTT (the BDP): 1 Gbit/s × 80 ms = 10 MB. Linux caps the window by tcp_rmem/tcp_wmem maxima (and net.core.rmem_max for apps setting SO_RCVBUF). With loss, loss-based algorithms like Reno/CUBIC cut the window on every drop; the Mathis model gives throughput ≈ (MSS/RTT) · 1.22/√p, so long fat paths with even 0.001% loss stall single streams. Parallel streams or a model-based algorithm like BBR get around it.",
      rule: "Size buffers to the BDP of the path, and when loss caps a single stream, use parallel streams or BBR rather than ever-bigger buffers.",
      why: (I, sol) => { const r = winEval(I, sol); return `BDP for ${I.target} Gbit/s × ${I.rtt} ms = ${K.num((I.target * 1e9 * I.rtt) / 8000 / 1e6, 1)} MB. ${sol.streams} stream(s) × ${sol.rmem} MB${sol.cc ? " with " + sol.cc.toUpperCase() : ""} give ${K.num(r.tot / 1e9, 2)} Gbit/s${I.loss && sol.cc !== "bbr" ? `; each loss-limited stream manages only ~${K.num(mathis(1448, I.rtt / 1000, I.loss) / 1e6)} Mbit/s` : ""}.`; },
    },
    {
      id: "net-cidr-plan",
      name: "Pick the new VPC's address range",
      kind: "Design review",
      skills: ["design", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a VPC of",
      vfmt: (v) => `${K.num(v)} addresses`,
      gen(lv, R) { return { lv, n: 6, hosts: lv === 1 ? R.pick([180, 200, 240]) : lv === 2 ? R.pick([300, 400, 500]) : R.pick([1200, 1500, 2000]), name: R.pick(["payments", "data-platform", "ml-serving", "checkout"]) }; },
      text: (I) => `<p>The <code>${esc(I.name)}</code> VPC needs <b>${I.n} subnets</b> (3 AZs × public/private), each with room for <b>${I.hosts} hosts</b>${I.lv === 3 ? " (EKS nodes plus pod IPs)" : ""}. The cloud reserves 5 addresses per subnet. Leave room to <b>double</b> the subnets later. It will be connected to:</p>${K.table(["range", "what"], EXIST[I.lv].map((e) => [`<code>${e}</code>`, EXN[e]]), { compact: true })}<p>Choose a range that never overlaps and fits, using the <b>smallest VPC</b> that meets the requirement.</p>`,
      ui: (I) => ({
        knobs: [{ k: "base", label: "Network address", opts: ["10.0.0.0", "10.20.0.0", "10.64.0.0", "10.128.0.0", "172.20.0.0", "192.168.64.0"] }, { k: "prefix", label: "VPC prefix", opts: [16, 18, 20, 22], fmt: (v) => "/" + v }, { k: "sub", label: "Subnet prefix", opts: [20, 22, 24, 26], fmt: (v) => "/" + v }],
        live: (c) => { if (!c) return ""; const r = cidrEval(I, c), v = cidrValid(I, c); return K.metrics([{ name: "VPC", value: `${K.cidr(c.base + "/" + c.prefix).str}`, ok: r.aligned && !r.clash.length, target: `${K.num(r.size)} addresses` }, { name: "Usable per subnet", value: K.num(r.usable), ok: r.usable >= I.hosts, target: `need ${I.hosts}` }, { name: "Needed with 2× growth", value: K.num(r.need), ok: r.fits }]) + K.verdict(v === true, v === true ? "Fits, no overlaps." : esc(v)); },
      }),
      valid: cidrValid,
      val: (I, c) => 2 ** (32 - c.prefix),
      hint: (I) => I.lv === 1 ? "Usable = 2^(32 − prefix) − 5. Then make sure the VPC is at least twice the subnets you need." : I.lv === 2 ? "Check each candidate against every connected range, including the office VPN's 172.16.0.0/12 (172.16–172.31)." : "10.16.0.0/12 covers 10.16.x.x to 10.31.x.x. And a /16 must start on a /16 boundary.",
      concept: "CIDR planning for connected networks",
      how: "A /n block has 2^(32−n) addresses; clouds reserve some per subnet (five in AWS), so a /24 gives 251 usable. Networks that will ever be peered, VPN-connected or routed together must not overlap, or traffic to the overlapping addresses goes to the wrong place and peering is refused outright. That includes on-prem ranges, office VPN pools, other clusters' pod and service CIDRs and partners. A network address must be aligned to its prefix (a /16 starts at x.y.0.0). Plan subnets for growth up front: resizing a VPC later is painful.",
      rule: "Keep a central registry of every range in use (including VPN pools and pod CIDRs), check overlap before allocating, and size subnets for growth.",
      why: (I, sol) => { const r = cidrEval(I, sol); return `${sol.base}/${sol.prefix} avoids every connected range; /${sol.sub} subnets give ${r.usable} usable addresses (need ${I.hosts}), and ${I.n} × 2 of them need ${K.num(r.need)} of the ${K.num(r.size)} addresses.`; },
    },
    {
      id: "net-nat-port-exhaustion",
      name: "NAT gateway: ErrorPortAllocation",
      kind: "Incident",
      skills: ["diagnose", "tune"],
      w: "tune",
      sense: "min",
      vname: "a cost of",
      vfmt: (v) => K.usd(v) + "/month",
      gen(lv, R) { return { lv, rate: lv === 1 ? R.int(12, 16) * 100 : lv === 2 ? R.int(11, 14) * 100 : R.int(28, 34) * 100, dur: 0.2, ipCost: R.pick([40, 45, 60]), partner: R.pick(["fx-rates", "kyc-check", "geo-lookup"]) }; },
      text: (I) => `<p>Workers in private subnets call the partner API <code>${esc(I.partner)}.vendor.net:443</code> at <b>${K.num(I.rate)} requests/s</b> (~200 ms each) through a NAT gateway. During peaks the NAT reports port allocation errors and calls fail with connect timeouts.</p><p>This NAT allows at most <b>55,000 simultaneous connections per NAT IP to the same destination IP and port</b>, and keeps a mapping for <b>60 s after a connection closes</b>. Each extra NAT IP costs <b>${K.usd(I.ipCost)}/month</b>.${I.lv === 2 ? " The partner answers every request with <code>Connection: close</code>, so keep-alive is impossible." : ""}${I.lv === 3 ? " The partner's DNS returns 4 A records; the HTTP client resolves once at startup and uses the first one." : ""}</p><p>Stop the errors at the <b>lowest cost</b>.</p>`,
      ui: (I) => ({
        knobs: [{ k: "ips", label: "NAT IPs", opts: [1, 2, 3, 4] }, { k: "ka", label: "HTTP keep-alive (connection pool)", opts: ["off", "on"], ...(I.lv >= 2 ? { fixed: "off" } : {}) }, ...(I.lv === 3 ? [{ k: "spread", label: "Destination IPs used", opts: ["one", "all"], fmt: (v) => (v === "one" ? "first A record only" : "all 4 A records") }] : [])],
        init: { ka: "off", spread: "one" },
        live: (c) => { if (!c) return ""; const r = natEval(I, c); return K.bars([{ label: "Mappings per destination", value: Math.min(r.perDest, r.cap * 1.5), max: r.cap * 1.5, cls: r.ok ? "good" : "bad", note: `${K.num(r.perDest)} / ${K.num(r.cap)}` }]) + K.metrics([{ name: "Port allocation errors", value: r.ok ? "none" : "at peak", ok: r.ok }, { name: "Cost", value: K.usd(r.cost) + "/month", ok: null }]); },
      }),
      valid: (I, c) => { const r = natEval(I, c); return r.ok ? true : `${K.num(r.perDest)} simultaneous mappings to one destination, limit ${K.num(r.cap)}`; },
      val: (I, c) => natEval(I, c).cost,
      hint: (I) => I.lv === 1 ? "Without keep-alive, each request holds a mapping for its duration plus 60 s. With keep-alive, how many connections are open at once (Little's law)?" : I.lv === 2 ? "rate × (duration + 60 s) mappings, against 55,000 per NAT IP." : "The limit is per destination IP. How many destinations could you use?",
      concept: "NAT source port exhaustion",
      how: "A NAT rewrites each outbound connection to one of its public IPs and a source port. Connections to the same destination IP:port need distinct (NAT IP, port) pairs, so each NAT IP supports a fixed number of simultaneous connections per destination, and closed connections hold their mapping for a while longer. Opening a fresh connection per request multiplies the mappings needed by (request time + hold time) / request time. Fixes, cheapest first: reuse connections (keep-alive pools), spread across all of the destination's IPs, then add NAT IPs.",
      rule: "Mappings ≈ new connections/s × (connection lifetime + NAT hold time), per destination. Reuse connections before buying IPs.",
      why: (I, sol) => { const r = natEval(I, sol); return sol.ka === "on" ? `With keep-alive only ~${K.num(r.perDest)} connections are open at once (rate × 0.2 s, plus headroom), so one NAT IP is plenty.` : `${K.num(I.rate)}/s × 60.2 s ≈ ${K.num(Math.ceil(I.rate * 60.2))} mappings${sol.spread === "all" ? `, split over 4 destination IPs: ${K.num(r.perDest)} each, under one IP's 55,000` : `, so ${sol.ips} NAT IPs (${K.num(r.cap)})`}.`; },
    },
    {
      id: "net-grpc-balance",
      name: "New gRPC pods get no traffic",
      kind: "Config change",
      skills: ["design", "tune"],
      w: "tune",
      sense: "min",
      vname: "a cost of",
      vfmt: (v) => K.usd(v) + "/month",
      gen(lv, R) { return { lv, conns: lv === 1 ? R.int(25, 35) * 2 : 6, b0: 4, b1: 10, l7Cost: R.pick([600, 900, 1200]), budget: 0.5, svc: R.pick(["ranker", "pricing", "features", "embeddings"]) }; },
      text: (I) => `<p>The <code>${esc(I.svc)}</code> gRPC service autoscaled from ${I.b0} to ${I.b1} pods, yet 10 minutes later the new pods serve <b>nothing</b> and the old ones are saturated. Clients hold <b>${I.conns} long-lived HTTP/2 connections</b> in total, behind a Kubernetes ClusterIP (L4).</p><p>Options: keep L4 and have the server bound connection lifetime (gRPC <code>MAX_CONNECTION_AGE</code> sends GOAWAY, clients reconnect); put an HTTP/2-aware L7 proxy in the path (${K.usd(I.l7Cost)}/month, +0.8 ms p99)${I.lv === 3 ? "; or client-side round_robin over a headless Service (clients connect to every pod, re-resolving DNS when connections close)" : ""}.${I.lv === 3 ? ` The p99 budget leaves <b>${I.budget} ms</b> for extra hops.` : ""}</p><p>Requirement: busiest pod ≤ 1.25 × average load within 10 minutes of a scale-out, at the <b>lowest cost</b>.</p>`,
      ui: (I) => ({
        knobs: [{ k: "lb", label: "Balancing", opts: I.lv === 3 ? ["l4", "l7", "rr"] : ["l4", "l7"], fmt: (v) => ({ l4: "L4 (ClusterIP)", l7: "L7 HTTP/2 proxy", rr: "client-side round_robin" })[v] }, { k: "age", label: "Server MAX_CONNECTION_AGE", opts: ["off", "5m", "30m"] }],
        live: (c) => {
          if (!c) return "";
          const r = grpcEval(I, c), v = grpcValid(I, c);
          const loads = Array.from({ length: I.b1 }, (_, i) => { if (c.lb === "l7" || (c.lb === "rr" && r.imb === 1)) return 1; if (c.lb === "rr") return i < I.b0 ? I.b1 / I.b0 : 0; const per = r.imb === 1 || (c.age !== "off" && parseInt(c.age, 10) <= 10) ? Array.from({ length: I.b1 }, (_, j) => Math.floor(I.conns / I.b1) + (j < I.conns % I.b1 ? 1 : 0)) : Array.from({ length: I.b1 }, (_, j) => (j < I.b0 ? Math.floor(I.conns / I.b0) + (j < I.conns % I.b0 ? 1 : 0) : 0)); return per[i] / (I.conns / I.b1); });
          return K.bars(loads.map((x, i) => ({ label: `pod ${i + 1}${i >= I.b0 ? " (new)" : ""}`, value: x, max: Math.max(2.6, ...loads), cls: x > 1.25 ? "bad" : x === 0 ? "hot" : "good", note: `${x.toFixed(2)}×` }))) + K.verdict(v === true, v === true ? `Balanced; cost ${K.usd(r.cost)}/month.` : esc(v));
        },
      }),
      valid: grpcValid,
      val: (I, c) => grpcEval(I, c).cost,
      hint: (I) => I.lv === 1 ? "An L4 balancer picks a pod once per connection. How do you make connections get re-picked?" : I.lv === 2 ? `Even perfectly spread, ${I.conns} connections across ${I.b1} pods leave some pods with none. Something must balance individual RPCs.` : "The proxy hop blows the latency budget. Client-side balancing needs clients to learn about new pods.",
      concept: "Load balancing long-lived HTTP/2 (gRPC) connections",
      how: "gRPC multiplexes all RPCs over one long-lived HTTP/2 connection per backend. An L4 balancer (kube-proxy ClusterIP, NLB) chooses a backend only when a connection opens, so after a scale-out the existing connections stay on old pods and new pods idle; with few clients, even fresh connections can't cover all pods. Fixes: MAX_CONNECTION_AGE on the server so connections are periodically re-established (re-balanced at L4); an HTTP/2-aware L7 proxy or service mesh that balances each RPC; or client-side load balancing (round_robin over all pod IPs from a headless Service), which still needs connection recycling or re-resolution to discover new pods.",
      rule: "Never rely on L4 balancing for gRPC alone: balance per request (L7 or client-side) and bound connection age so new backends get used.",
      why: (I, sol) => sol.lb === "l4" ? `With ${I.conns} connections, MAX_CONNECTION_AGE ${sol.age} makes clients reconnect within the window, spreading them ${Math.floor(I.conns / I.b1)}–${Math.ceil(I.conns / I.b1)} per pod. No proxy needed.` : sol.lb === "l7" ? `Only ${I.conns} connections can't cover ${I.b1} pods, so RPCs must be balanced individually: the L7 proxy does that.` : `The L7 hop would add 0.8 ms against a ${I.budget} ms budget. Client-side round_robin balances each RPC across all known pods, and MAX_CONNECTION_AGE ${sol.age} makes clients reconnect and re-resolve, discovering new pods.`,
    },
    {
      id: "net-bdp-estimate",
      name: "Estimate TCP throughput",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) { const rtt = R.pick([40, 60, 80, 120]); return { lv, rtt, truth: (65535 * 8) / (rtt / 1000) / 1e6 }; }
        if (lv === 2) { const g = R.pick([1, 2, 5]), rtt = R.pick([90, 120, 150]); return { lv, g, rtt, truth: (g * 1e9 * rtt) / 1000 / 8 / 1e6 }; }
        const rtt = R.pick([80, 100, 120]), p = R.pick([1e-4, 4e-4]), g = 1;
        const per = mathis(1460, rtt / 1000, p);
        return { lv, rtt, p, g, per, truth: Math.ceil((g * 1e9) / per) };
      },
      text: (I) => I.lv === 1 ? `<p>An old appliance between two data centres strips the TCP window-scale option, so windows are capped at <b>65,535 bytes</b>. RTT is <b>${I.rtt} ms</b>; the link is 10 Gbit/s. What's the maximum throughput of <b>one</b> TCP stream, in <b>Mbit/s</b>?</p>` : I.lv === 2 ? `<p>You want a single stream to reach <b>${I.g} Gbit/s</b> across a <b>${I.rtt} ms</b> RTT. How large must the TCP window (and so the socket buffers) be, in <b>MB</b> (10<sup>6</sup> bytes)?</p>` : `<p>A replication link has RTT <b>${I.rtt} ms</b> and a steady <b>${(I.p * 100).toPrecision(1)}%</b> packet loss, MSS 1460 bytes, and uses a Reno-style loss-based congestion control. Using the Mathis model (throughput ≈ MSS/RTT × 1.22/√p), <b>how many parallel streams</b> do you need for 1 Gbit/s?</p>`,
      ui: (I) => ({ unit: I.lv === 1 ? "Mbit/s" : I.lv === 2 ? "MB" : "streams" }),
      accept: (I, a) => LB.near(I.truth, 0.15)(I, a),
      solve: (I) => (I.lv === 3 ? I.truth : Math.round(I.truth * 10) / 10),
      bad: (I) => I.lv === 1 ? [I.truth / 8, 10000] : I.lv === 2 ? [I.truth * 8, I.truth / 1000] : [1, Math.round(I.truth * 8)],
      hint: (I) => I.lv === 1 ? "Throughput ≤ window / RTT. Watch bytes vs bits." : I.lv === 2 ? "BDP = bandwidth × RTT; convert bits to bytes." : "Compute one stream's rate in bit/s, then divide.",
      concept: "Bandwidth-delay product and the Mathis model",
      how: "A TCP sender can't have more than one window in flight per round trip, so throughput ≤ window / RTT. To fill a path you need window ≥ bandwidth × RTT (the bandwidth-delay product). Without window scaling (RFC 7323) the window caps at 64 KiB, which over long RTTs means a few Mbit/s no matter how fat the link. With random loss, loss-based congestion control backs off on every drop; Mathis et al. approximate throughput as (MSS/RTT) · C/√p with C ≈ 1.22, so loss and RTT together cap single streams hard.",
      rule: "Single-stream throughput ≤ window/RTT and ≈ MSS/RTT × 1.22/√loss; when either is far below the link, fix window scaling and buffers, or go parallel.",
      why: (I) => I.lv === 1 ? `65,535 B × 8 / ${I.rtt / 1000} s ≈ <b>${K.num(I.truth, 1)} Mbit/s</b>, on a 10 Gbit/s link.` : I.lv === 2 ? `${I.g} Gbit/s × ${I.rtt / 1000} s = ${K.num(I.g * I.rtt / 1000, 2)} Gbit = <b>${K.num(I.truth, 1)} MB</b> in flight.` : `One stream ≈ 1460×8 / ${I.rtt / 1000} s × 1.22 / √${I.p} ≈ ${K.num(I.per / 1e6, 1)} Mbit/s, so 1 Gbit/s needs about <b>${I.truth}</b> streams.`,
    },
    {
      id: "net-subnet-math",
      name: "How many fit in this subnet?",
      kind: "Estimate",
      skills: ["estimate"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) { const p = R.pick([22, 23, 24, 25, 26]); return { lv, p, truth: 2 ** (32 - p) - 5 }; }
        if (lv === 2) { const v = R.pick([19, 20]), s = R.pick([23, 24]); const n = Math.min(6, 2 ** (s - v)); return { lv, v, s, n, truth: n * (2 ** (32 - s) - 5) }; }
        const p = R.pick([20, 21, 22]), pods = R.pick([17, 29, 58]);
        return { lv, p, pods, truth: Math.floor((2 ** (32 - p) - 5) / (pods + 1)) };
      },
      text: (I) => I.lv === 1 ? `<p>A private subnet is <code>10.40.8.0/${I.p}</code>. The cloud reserves the first four addresses and the last one. How many <b>instances</b> can it hold (one IP each)?</p>` : I.lv === 2 ? `<p>A VPC <code>10.40.0.0/${I.v}</code> is carved into <b>/${I.s}</b> subnets; ${I.n} of them are created (3 AZs × public/private). With 5 reserved addresses per subnet, how many <b>usable addresses</b> do those ${I.n} subnets provide in total?</p>` : `<p>An EKS node group uses the VPC CNI: every pod gets a VPC IP from the node's subnet. Each node consumes 1 IP for itself and pre-allocates <b>${I.pods}</b> pod IPs (its max pods). The subnet is a <b>/${I.p}</b> with 5 reserved addresses. How many <b>nodes</b> fit before IPs run out?</p>`,
      ui: (I) => ({ unit: I.lv === 3 ? "nodes" : "addresses" }),
      accept: (I, a) => (a === I.truth ? true : a == null || !Number.isFinite(a) ? "Enter a number." : a < I.truth ? "Too low. Recount the addresses in the block." : "Too high. Did you subtract the reserved addresses?"),
      solve: (I) => I.truth,
      bad: (I) => [I.truth + 5 * (I.lv === 2 ? I.n : 1), I.lv === 3 ? Math.floor((2 ** (32 - I.p)) / I.pods) : I.truth + 3],
      hint: (I) => I.lv === 1 ? "A /n has 2^(32 − n) addresses." : I.lv === 2 ? "Each subnet loses 5 addresses, not the VPC as a whole." : "Each node uses (1 + max pods) addresses.",
      concept: "Subnet arithmetic",
      how: "A /n IPv4 block holds 2^(32−n) addresses: /24 = 256, /22 = 1,024, /20 = 4,096. Cloud providers reserve some per subnet (AWS: network address, router, DNS, a future-use address and broadcast, five in total), and the reservation is per subnet, so many small subnets waste more. In Kubernetes with VPC-native pod networking (EKS VPC CNI, GKE alias IPs), every pod consumes a VPC address, often pre-allocated per node, so pod density, not node count, decides subnet size.",
      rule: "Usable = 2^(32 − prefix) − reserved, per subnet; and with VPC-native pods, budget (1 + max pods) addresses per node.",
      why: (I) => I.lv === 1 ? `2^${32 - I.p} − 5 = <b>${I.truth}</b>.` : I.lv === 2 ? `Each /${I.s} has ${2 ** (32 - I.s)} − 5 = ${2 ** (32 - I.s) - 5} usable; × ${I.n} = <b>${K.num(I.truth)}</b>.` : `(2^${32 - I.p} − 5) / (1 + ${I.pods}) = ${K.num((2 ** (32 - I.p) - 5) / (I.pods + 1), 1)}, so <b>${I.truth}</b> nodes.`,
    },
    {
      id: "net-ephemeral-ports",
      name: "Running out of source ports",
      kind: "Estimate",
      skills: ["estimate", "diagnose"],
      w: "num",
      gen(lv, R) {
        if (lv === 1) return { lv, truth: Math.floor(28232 / 60) };
        if (lv === 2) { const n = R.pick([2, 3, 4]); return { lv, n, truth: Math.floor((64512 * n) / 60) }; }
        const rps = R.int(8, 20) * 100, reuse = R.pick([20, 50, 100]);
        return { lv, rps, reuse, truth: Math.round((rps / reuse) * 60) };
      },
      text: (I) => I.lv === 1 ? `<p>A batch client opens a new TCP connection for every call to one backend (one IP, port 443) and closes it itself, so each closed socket sits in <b>TIME_WAIT for 60 s</b>. <code>net.ipv4.ip_local_port_range = 32768 60999</code>. What's the highest sustained rate of <b>new connections per second</b> before <code>connect()</code> fails with EADDRNOTAVAIL?</p>` : I.lv === 2 ? `<p>Same client, but the port range was widened to <code>1024 65535</code> and the backend now has <b>${I.n} IPs</b> that calls are spread across evenly. Source ports only need to be unique per destination IP:port. What's the new maximum rate of new connections per second?</p>` : `<p>The client now uses a keep-alive pool: each connection carries about <b>${I.reuse} requests</b> before it's closed by the client. At <b>${K.num(I.rps)} requests/s</b>, roughly how many sockets are in <b>TIME_WAIT</b> at any moment?</p>`,
      ui: (I) => ({ unit: I.lv === 3 ? "sockets" : "connections/s" }),
      accept: (I, a) => LB.near(I.truth, 0.1)(I, a),
      solve: (I) => I.truth,
      bad: (I) => I.lv === 1 ? [28232, 32768 / 60 * 2] : I.lv === 2 ? [Math.floor(64512 / 60), 28232 / 60 * I.n] : [I.rps * 60, I.rps / I.reuse],
      hint: (I) => I.lv === 1 ? "Ports in the range ÷ how long each one is held." : I.lv === 2 ? "Count the ports in the new range, and the number of distinct destinations." : "New connections per second × 60 s.",
      concept: "Ephemeral ports and TIME_WAIT",
      how: "Every outbound TCP connection needs a unique (source IP, source port, destination IP, destination port) tuple. The side that closes first keeps the socket in TIME_WAIT (60 s on Linux) so late packets can't corrupt a new connection, and the port can't be reused for the same destination meanwhile. So max new connections/s to one destination ≈ ports in ip_local_port_range / 60. Widening the range, adding destination IPs, or (best) reusing connections all raise the ceiling.",
      rule: "Reuse connections; if you must churn them, new connections/s per destination ≤ port range / 60 s.",
      why: (I) => I.lv === 1 ? `60999 − 32768 + 1 = 28,232 ports, each held 60 s: about <b>${I.truth}</b> new connections/s.` : I.lv === 2 ? `64,512 ports × ${I.n} destinations / 60 s ≈ <b>${K.num(I.truth)}</b>/s.` : `${K.num(I.rps)} / ${I.reuse} = ${K.num(I.rps / I.reuse)} new connections/s × 60 s ≈ <b>${K.num(I.truth)}</b> in TIME_WAIT.`,
    },
    {
      id: "net-proxy-protocol",
      name: "Preserve client IPs through the L4 balancer",
      kind: "Config change",
      skills: ["safe", "design"],
      w: "code",
      gen(lv, R) { const dom = R.pick(DOMS), o = R.int(1, 9); return { lv, dom, lbNet: `10.0.${o}.0/24`, o }; },
      text: (I) => `<p>An L4 load balancer (subnet <code>${I.lbNet}</code>) forwards TLS traffic to nginx, so nginx sees the LB's address as every client's IP. Rate limits and audit logs need the real one. The LB can prepend a <b>PROXY protocol v2</b> header to each connection.${I.lv === 2 ? " Its health checks go to port <b>8081</b> and do <b>not</b> carry the header." : ""}${I.lv === 3 ? ` The LB setting can't be flipped atomically with an nginx reload. The plan: a new target group on port <b>8443</b> with PROXY protocol on, shift traffic to it, then retire 443. Write the config for <b>step 1</b>: 443 keeps working exactly as today, 8443 expects the header.` : " PROXY protocol is now enabled on the target group; update nginx."}</p><p>Trust the header only from the LB.</p>`,
      ui: (I) => {
        const starter = `server {\n    listen 443 ssl;\n    server_name app.${I.dom};\n    ssl_certificate     /etc/nginx/tls/app.pem;\n    ssl_certificate_key /etc/nginx/tls/app.key;\n\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n        proxy_set_header X-Real-IP $remote_addr;\n    }\n}${I.lv === 2 ? "\n\nserver {\n    listen 8081;\n    location = /healthz { return 200 \"ok\\n\"; }\n}" : ""}`;
        return { lang: "nginx", file: "/etc/nginx/conf.d/app.conf", starter, rows: starter.split("\n").length + 4, live: (src) => { if (!src) return ""; const r = ppCheck(I, src); return K.table(["listener", "expects PROXY header"], ngxListens(src).map((l) => [String(l.port), l.pp ? "yes" : "no"]), { compact: true }) + K.verdict(r === true, r === true ? "Clients' real IPs reach the app; nothing else breaks." : r); } };
      },
      accept: (I, src) => ppCheck(I, src),
      solve: (I) => `server {\n    listen 443 ssl${I.lv === 3 ? "" : " proxy_protocol"};\n${I.lv === 3 ? "    listen 8443 ssl proxy_protocol;\n" : ""}    server_name app.${I.dom};\n    ssl_certificate     /etc/nginx/tls/app.pem;\n    ssl_certificate_key /etc/nginx/tls/app.key;\n\n    set_real_ip_from ${I.lbNet};\n    real_ip_header proxy_protocol;\n\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n        proxy_set_header X-Real-IP $remote_addr;\n    }\n}${I.lv === 2 ? "\n\nserver {\n    listen 8081;\n    location = /healthz { return 200 \"ok\\n\"; }\n}" : ""}`,
      bad: (I) => { const s = LB.byId.get("net-proxy-protocol").solve(I); return [s.replace(I.lbNet, "0.0.0.0/0"), s.replace("    real_ip_header proxy_protocol;\n", ""), ...(I.lv === 2 ? [s.replace("listen 8081;", "listen 8081 proxy_protocol;")] : []), ...(I.lv === 3 ? [s.replace("listen 443 ssl;", "listen 443 ssl proxy_protocol;")] : [])]; },
      hint: (I) => I.lv === 1 ? "The listen directive has a flag for it, and the realip module turns the header's address into $remote_addr." : I.lv === 2 ? "A listener with proxy_protocol rejects connections that don't start with the header." : "Two listeners in the same server block: one with the flag, one without.",
      concept: "PROXY protocol and the realip module",
      how: "An L4 balancer that doesn't terminate TCP can't add X-Forwarded-For; instead it can prepend a PROXY protocol header (v1 text or v2 binary) carrying the original source and destination addresses. The backend must be told per listener (nginx: listen ... proxy_protocol), and then requires the header on every connection on that port: connections without it (health checks, direct clients) fail, and a backend without the flag misreads the header as garbage. nginx's realip module (set_real_ip_from + real_ip_header proxy_protocol) replaces $remote_addr with the client address, but only for connections from trusted addresses. Rolling it out safely means a parallel listener, since the LB and backend can't change in the same instant.",
      rule: "Enable PROXY protocol per listener on both sides, keep health checks on a listener that matches what they send, trust only the LB's subnet, and migrate via a second port.",
      why: (I) => I.lv === 1 ? `443 now expects the header, and realip trusts it only from ${I.lbNet}, so $remote_addr (and X-Real-IP) is the client.` : I.lv === 2 ? "443 expects the header, 8081 stays plain for the header-less health checks, and realip trusts only the LB subnet." : "443 is untouched for the current target group; 8443 expects the header for the new one. Shift traffic, then retire 443.",
    },
    {
      id: "net-cache-control",
      name: "Write the Cache-Control headers",
      kind: "Config change",
      skills: ["design"],
      w: "code",
      gen(lv, R) { return { lv, dom: R.pick(DOMS) }; },
      text: (I) => `<p>The CDN in front of <code>${esc(I.dom)}</code> honours standard Cache-Control (including <code>s-maxage</code>, <code>stale-while-revalidate</code> and <code>stale-if-error</code>). Write the header for each path:</p><ul>${ccPaths(I.lv).map((p) => `<li><code>${esc(p.path)}</code>: ${p.need}</li>`).join("")}</ul><p>One line per path: <code>path: directives</code>.</p>`,
      ui: (I) => ({ lang: "text", file: "cache-headers.txt", starter: ccPaths(I.lv).map((p) => `${p.path}: `).join("\n"), rows: ccPaths(I.lv).length + 2, live: (src) => { if (!src) return ""; const r = ccCheck(I, src); return K.verdict(r === true, r === true ? "Every path is cached exactly as required." : r); } }),
      accept: (I, src) => { const r = ccCheck(I, src); return r === true ? true : r; },
      solve: (I) => ccPaths(I.lv).map((p) => `${p.path}: ${p.sol}`).join("\n"),
      bad: (I) => { const P = ccPaths(I.lv); const mk = (f) => P.map((p) => `${p.path}: ${f(p)}`).join("\n"); return [mk((p) => (p.path.includes("cart") || p.path.includes("account") ? "public, max-age=60" : p.sol)), mk((p) => (p.path.includes("assets") ? "no-cache" : p.sol)), ...(I.lv >= 2 ? [mk((p) => (p.path === "/api/products" ? "public, max-age=60" : p.sol))] : [mk((p) => (p.path === "/index.html" ? "public, max-age=3600" : p.sol))])]; },
      hint: (I) => I.lv === 1 ? "Fingerprinted files can be cached forever; the HTML that references them must be revalidated each time." : I.lv === 2 ? "max-age applies to every cache; s-maxage overrides it for shared caches only." : "stale-if-error and immutable are directives too.",
      concept: "Cache-Control for browsers and CDNs",
      how: "max-age sets freshness for every cache; s-maxage overrides it for shared caches (CDNs, proxies) only, so 'max-age=0, s-maxage=60' means the CDN caches 60 s while browsers revalidate. no-cache means 'store but revalidate before every use' (cheap with ETags), no-store means 'never store', private forbids shared caches. stale-while-revalidate lets a cache serve a stale copy while it refetches in the background; stale-if-error lets it serve stale when the origin fails. Fingerprinted assets (hash in the name) can be cached for a year with immutable, as long as the HTML that references them is always revalidated.",
      rule: "Long max-age + immutable for hashed assets, no-cache for HTML, s-maxage for what only the CDN should cache, private/no-store for anything personal.",
      why: (I, sol) => `Reference:<br>${sol.split("\n").map((l) => `<code>${esc(l)}</code>`).join("<br>")}`,
    },
    {
      id: "net-websocket-proxy",
      name: "WebSockets through nginx",
      kind: "Config change",
      skills: ["diagnose", "tune"],
      w: "code",
      gen(lv, R) { return { lv, idle: R.pick([600, 900, 1200]) }; },
      text: (I) => I.lv === 1 ? `<p>A chat app's WebSocket handshake fails behind nginx: the browser shows <code>WebSocket connection to 'wss://chat.../ws/' failed</code> and the app logs <code>400 Bad Request: missing Upgrade header</code>. Fix the location.</p>` : I.lv === 2 ? `<p>WebSockets now connect, but in quiet rooms clients get disconnected (close code 1006) after exactly <b>60 s</b> of silence. The app sends no pings, and rooms can be silent for up to <b>${I.idle / 60} minutes</b>. Fix the location so connections survive.</p>` : `<p>The API and WebSockets share <code>location /</code>, and the upstream uses keep-alive connections. Make WebSocket upgrades work (and survive ${I.idle / 60} silent minutes) without breaking plain API requests. You may add an http-level block above the server.</p>`,
      ui: (I) => {
        const starter = I.lv === 3 ? `upstream api_backend {\n    server 127.0.0.1:8080;\n    keepalive 32;\n}\n\nserver {\n    listen 443 ssl;\n    server_name app.example;\n\n    location / {\n        proxy_pass http://api_backend;\n        proxy_http_version 1.1;\n        proxy_set_header Connection "";\n    }\n}` : `location /ws/ {\n    proxy_pass http://chat_backend;\n${I.lv === 2 ? '    proxy_http_version 1.1;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n' : ""}}`;
        return { lang: "nginx", file: "/etc/nginx/conf.d/chat.conf", starter, rows: starter.split("\n").length + 6, live: (src) => { if (!src) return ""; const r = wsCheck(I, src); return K.verdict(r === true, r === true ? "Upgrades succeed and idle sockets stay open." : r); } };
      },
      accept: (I, src) => wsCheck(I, src),
      solve: (I) => I.lv === 3 ? `map $http_upgrade $connection_upgrade {\n    default upgrade;\n    ''      '';\n}\n\nupstream api_backend {\n    server 127.0.0.1:8080;\n    keepalive 32;\n}\n\nserver {\n    listen 443 ssl;\n    server_name app.example;\n\n    location / {\n        proxy_pass http://api_backend;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection $connection_upgrade;\n        proxy_read_timeout 1h;\n    }\n}` : `location /ws/ {\n    proxy_pass http://chat_backend;\n    proxy_http_version 1.1;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n${I.lv === 2 ? "    proxy_read_timeout 1h;\n" : ""}}`,
      bad: (I) => { const s = LB.byId.get("net-websocket-proxy").solve(I); return [s.replace(/ *proxy_http_version 1\.1;\n/, ""), s.replace(/ *proxy_set_header Upgrade \$http_upgrade;\n/, ""), ...(I.lv >= 2 ? [s.replace("proxy_read_timeout 1h;", "proxy_read_timeout 60s;")] : []), ...(I.lv === 3 ? [s.replace("Connection $connection_upgrade", 'Connection "upgrade"')] : [])]; },
      hint: (I) => I.lv === 1 ? "Upgrade and Connection are hop-by-hop headers, and nginx talks HTTP/1.0 to upstreams by default." : I.lv === 2 ? "nginx's proxy_read_timeout (default 60 s) applies to WebSockets too: it closes the connection when nothing is read for that long." : "Use a map so Connection is 'upgrade' only when the client asked to upgrade.",
      concept: "Proxying WebSockets",
      how: "A WebSocket starts as an HTTP/1.1 request with Upgrade: websocket and Connection: Upgrade. Both are hop-by-hop headers, so a proxy must forward them explicitly, and nginx must speak HTTP/1.1 upstream (proxy_http_version 1.1). After the upgrade nginx relays bytes, but proxy_read_timeout (default 60 s) still closes the tunnel if nothing arrives for that long, so either raise it or have the app ping. When one location serves both upgrades and normal requests over pooled upstream connections, map $http_upgrade to the Connection value so normal requests don't ask for an upgrade.",
      rule: "Forward Upgrade/Connection with proxy_http_version 1.1, set proxy_read_timeout above your longest silence (and ping below every idle timeout in the path), and use the $connection_upgrade map on shared locations.",
      why: (I) => I.lv === 1 ? "nginx dropped the hop-by-hop Upgrade and Connection headers and spoke HTTP/1.0 upstream, so the app never saw an upgrade request." : I.lv === 2 ? `Silent sockets hit nginx's default 60 s proxy_read_timeout. Raising it above ${I.idle / 60} min fixes it; an app-level ping every ~30 s is the more robust long-term fix (it also keeps other idle timeouts, like the LB's, happy).` : "The map sends Connection: upgrade only for upgrade requests and an empty value otherwise, so API requests keep using pooled keep-alive connections.",
    },
    {
      id: "net-cache-key",
      name: "Design the CDN cache key",
      kind: "Hardening",
      skills: ["design", "safe"],
      w: "classify",
      gen(lv, R) { const items = R.sample(KEYPOOL[lv], 6); if (new Set(items.map((x) => x[1])).size < 3) return null; return { lv, items }; },
      text: () => `<p>You're writing the CDN configuration for a site. For each request attribute, choose whether it should be <b>part of the cache key</b>, <b>stripped/ignored</b> at the edge (not in the key, and not forwarded to the origin where that matters), or whether such requests should <b>bypass the cache</b>. Get the hit rate up without ever serving a wrong or poisoned response.</p>`,
      ui: (I) => ({ items: I.items.map((x) => x[0]), cats: ["In the key", "Strip / ignore", "Bypass cache"] }),
      ans: (I) => I.items.map((x) => x[1]),
      diag: () => "Not quite. Ask for each one: does the response differ by it (key), does the origin act on it in ways the key doesn't capture (strip it, or it's a poisoning vector), or is the response per-user (bypass)?",
      hint: (I) => I.lv === 1 ? "Things that change the response belong in the key; things that don't (tracking params, analytics cookies) only fragment it." : I.lv === 2 ? "If the origin reflects a header into the page but the key ignores it, one attacker request can poison the cached page for everyone." : "Any header the framework uses to change the method or path is a poisoning vector unless stripped.",
      concept: "Cache keys, Vary and cache poisoning",
      how: "A CDN serves a cached response to every request with the same cache key (by default host + path + query). Anything that changes the response must be in the key (or covered by Vary), or users get the wrong variant. Anything that doesn't change it should be excluded, or the hit rate collapses (tracking parameters, raw User-Agent, cookies the page ignores). Unkeyed inputs that the origin still acts on, such as X-Forwarded-Host reflected into URLs or method/path override headers, let an attacker store a malicious response under a normal key: web cache poisoning. Strip them at the edge. Per-user responses shouldn't be cached at all.",
      rule: "Key on everything the response depends on, normalise or strip everything else before it reaches the origin, and bypass the cache for personalised responses.",
      why: (I) => I.items.map((x) => `<code>${esc(x[0])}</code>: ${["key", "strip", "bypass"][x[1]]}`).join("; ") + ".",
    },
    {
      id: "net-anycast-geodns",
      name: "Anycast or GeoDNS?",
      kind: "Decision",
      skills: ["design"],
      w: "choice",
      gen(lv, R) {
        const opts = lv === 1 ? ["Users' DNS resolvers are far from them and don't send EDNS Client Subnet, so GeoDNS sees the resolver's location", "The GeoDNS database is outdated", "Anycast routing is broken in Asia", "The TTL on the GeoDNS answer is too long"]
          : lv === 2 ? ["Anycast: withdrawing the route from the failed site moves traffic in seconds, independent of DNS caches", "GeoDNS with a 60 s TTL", "GeoDNS with health checks and a 300 s TTL", "Round-robin DNS across all sites"]
            : ["Keep anycast for DNS and short requests; serve large downloads from per-site unicast hostnames picked by the anycast front end", "Use anycast for everything; BGP routes never change", "Move everything to GeoDNS with a 30 s TTL", "Add TCP keepalive to all download connections"];
        return { lv, share: R.int(25, 40), opts: R.shuffle(opts.slice()), right: opts[0] };
      },
      text: (I) => I.lv === 1 ? `<p>Your GeoDNS sends users to the nearest of 5 sites. Logs show <b>${I.share}%</b> of users in Southeast Asia land in us-west, with 180 ms RTT. Those users mostly use a public resolver service and a large ISP whose resolvers are centralised in other countries. Why?</p>` : I.lv === 2 ? `<p>A site outage must move users elsewhere in under a minute. Measurements: ${I.share}% of clients' resolvers ignore TTLs below 300 s, and some apps cache DNS answers for the life of the process. Which approach meets the goal?</p>` : `<p>Your anycast edge serves API calls and multi-GB software downloads. During BGP changes at an internet exchange, about ${I.share / 10}% of in-progress downloads fail with connection resets, while API calls are unaffected. What's the best fix?</p>`,
      ui: (I) => ({ opts: I.opts }),
      ans: (I) => I.right,
      diag: (I, a) => ({
        "The GeoDNS database is outdated": "Even a perfect database can only locate the address that asked: the resolver, not the user.",
        "Anycast routing is broken in Asia": "This setup is GeoDNS; anycast isn't involved.",
        "The TTL on the GeoDNS answer is too long": "TTL affects how fast changes propagate, not where users are sent.",
        "GeoDNS with a 60 s TTL": `A third of resolvers ignore short TTLs and some apps never re-resolve: they'd keep hitting the dead site.`,
        "GeoDNS with health checks and a 300 s TTL": "Five minutes at best, much longer for apps that cache DNS.",
        "Round-robin DNS across all sites": "Clients keep trying the dead site's address.",
        "Use anycast for everything; BGP routes never change": "They change all the time; a route change mid-connection sends packets to a site that has no state for it.",
        "Move everything to GeoDNS with a 30 s TTL": "That gives up anycast's fast failover and DDoS absorption for the API, and the TTL won't be honoured.",
        "Add TCP keepalive to all download connections": "Keepalives don't stop packets from arriving at a different site after a route change.",
      })[a] || "Not the best option.",
      hint: (I) => I.lv === 1 ? "Who actually sends the query to your GeoDNS server?" : I.lv === 2 ? "Which mechanism doesn't depend on clients re-resolving?" : "Anycast is stateless routing; long TCP connections are stateful.",
      concept: "Anycast vs GeoDNS",
      how: "GeoDNS answers with a site chosen from the location of the querying resolver; unless the resolver sends EDNS Client Subnet, users of distant or centralised resolvers get steered by the resolver's location. Failover with GeoDNS is bounded by TTLs, which some resolvers and many applications don't honour. Anycast announces the same IP from every site via BGP; routing delivers each packet to the 'nearest' site, and withdrawing a route fails over in seconds. But a routing change mid-connection can move a TCP flow to a site without its state, so very long connections suffer; designs often keep anycast for DNS and short requests and hand long transfers to per-site unicast addresses.",
      rule: "Use anycast for fast failover and short-lived traffic, GeoDNS (with ECS) for fine-grained steering, and pin long-lived transfers to unicast endpoints.",
      why: (I) => I.lv === 1 ? "GeoDNS only sees the resolver's address. Resolvers in other countries without ECS make Southeast Asian users look American." : I.lv === 2 ? "Withdrawing the BGP announcement moves traffic within seconds and doesn't depend on any client re-resolving DNS." : "A BGP change can shift a TCP flow to another site mid-download, which resets it. Short API calls finish before it matters; long transfers should move to a unicast address chosen at the start.",
    },
    {
      id: "net-h2-h3",
      name: "HTTP/2, HTTP/3 and lossy networks",
      kind: "Decision",
      skills: ["design", "diagnose"],
      w: "choice",
      gen(lv, R) {
        const opts = lv === 1 ? ["Enable HTTP/3 (QUIC): streams are independent, so one lost packet only stalls the stream it belongs to", "Go back to HTTP/1.1 with 6 connections everywhere", "Increase the TCP initial congestion window", "Bundle all assets into one big file"]
          : lv === 2 ? ["Keep HTTP/2 over TCP alongside HTTP/3, advertised with Alt-Svc; clients fall back automatically where UDP is blocked", "Serve HTTP/3 only, to force firewalls to open UDP 443", "Disable HTTP/3 for everyone", "Move HTTP/3 to port 8443"]
            : ["Route QUIC by connection ID (QUIC-aware load balancing), not by the UDP 5-tuple", "Shorten the QUIC idle timeout", "Enable sticky sessions by client IP", "Disable connection migration in the browser"];
        return { lv, loss: R.pick([1, 2, 3]), opts: R.shuffle(opts.slice()), right: opts[0] };
      },
      text: (I) => I.lv === 1 ? `<p>Your mobile web app loads ~80 small assets over a single HTTP/2 connection. On networks with <b>${I.loss}% packet loss</b>, page loads are much worse than on HTTP/1.1 with 6 connections: every lost packet stalls all streams until it's retransmitted. Which change addresses that directly?</p>` : I.lv === 2 ? `<p>After enabling HTTP/3, a few enterprise customers report nothing broken but no speed-up either; their firewalls block outbound UDP 443. A colleague wants to drop HTTP/2 to "simplify". What's right?</p>` : `<p>HTTP/3 traffic goes through a UDP load balancer hashing the 5-tuple to backends. Users on phones see requests fail or restart when they move from Wi-Fi to cellular, although QUIC supports connection migration. Fix?</p>`,
      ui: (I) => ({ opts: I.opts }),
      ans: (I) => I.right,
      diag: (I, a) => ({
        "Go back to HTTP/1.1 with 6 connections everywhere": "That trades transport head-of-line blocking for application-level queuing and 6× the handshakes; it doesn't solve the problem.",
        "Increase the TCP initial congestion window": "A bigger window doesn't change the fact that TCP delivers bytes in order: a gap stalls everything behind it.",
        "Bundle all assets into one big file": "One big stream suffers the same stall and kills caching granularity.",
        "Serve HTTP/3 only, to force firewalls to open UDP 443": "Those users would simply be unable to connect.",
        "Disable HTTP/3 for everyone": "Users on lossy networks lose the benefit while the firewalled ones gain nothing.",
        "Move HTTP/3 to port 8443": "Firewalls that block UDP 443 block other UDP ports too, and clients find HTTP/3 via Alt-Svc anyway.",
        "Shorten the QUIC idle timeout": "The connection isn't idle; its packets are going to the wrong backend.",
        "Enable sticky sessions by client IP": "The client IP is exactly what changes on Wi-Fi → cellular.",
        "Disable connection migration in the browser": "You don't control users' browsers, and migration is the feature you want.",
      })[a] || "Not the best option.",
      hint: (I) => I.lv === 1 ? "HTTP/2 removed head-of-line blocking at the HTTP layer, not at the TCP layer." : I.lv === 2 ? "How do browsers discover HTTP/3, and what do they do when it doesn't work?" : "What stays constant across a QUIC connection migration?",
      concept: "Head-of-line blocking, HTTP/2 vs HTTP/3",
      how: "HTTP/2 multiplexes many streams over one TCP connection; TCP delivers bytes strictly in order, so one lost segment stalls every stream until it's retransmitted (transport head-of-line blocking), which hurts on lossy mobile networks. HTTP/3 runs over QUIC on UDP, where each stream is ordered independently. Browsers learn about HTTP/3 through Alt-Svc (or HTTPS DNS records) and fall back to TCP when UDP is blocked, so HTTP/2 must stay. QUIC connections are identified by connection IDs rather than addresses, so they survive network changes, but only if the load balancer routes by connection ID.",
      rule: "Offer HTTP/3 in addition to HTTP/2, never instead of it, and put QUIC behind connection-ID-aware load balancing.",
      why: (I) => I.lv === 1 ? `At ${I.loss}% loss, a single TCP connection stalls all ~80 streams on each loss. QUIC loses only the affected stream's progress.` : I.lv === 2 ? "Browsers race or fall back to TCP when QUIC fails, so firewalled users quietly use HTTP/2. Dropping HTTP/2 would cut them off." : "On a network change the client's IP and port change, so a 5-tuple hash sends packets to a backend that doesn't know the connection. Routing by QUIC connection ID keeps it on the right backend.",
    },
    {
      id: "net-xff-trust",
      name: "Review: getting the client IP",
      kind: "Code review",
      skills: ["safe", "diagnose"],
      w: "lines",
      gen(lv, R) { return { lv, max: R.pick([5, 10]) }; },
      text: (I) => I.lv === 1 ? `<p>Login is rate-limited per client IP (${I.max}/min). Traffic arrives through one load balancer, which appends the connecting address to <code>X-Forwarded-For</code>. An attacker is brute-forcing passwords at thousands of attempts per minute without being limited. Flag the line that lets them.</p>` : I.lv === 2 ? `<p>This PR "fixes" the issue above. Since last month traffic flows <b>client → CDN → load balancer → app</b>; both proxies append to <code>X-Forwarded-For</code>. After the PR, legitimate users are being rate-limited en masse. Flag the line responsible.</p>` : `<p>The client-IP code now accounts for both proxies. But the app also listens on <code>:8080</code>, which is reachable from the whole VPC and the partner VPN for internal callers, not only from the load balancer. Flag the line that still lets someone spoof their IP.</p>`,
      ui: (I) => {
        const lines = I.lv === 1 ? [
          { t: "@@ src/middleware/client-ip.js @@", k: "@" },
          { t: 'const rateLimit = require("./rate-limit");', k: " " },
          { t: "function clientIp(req) {", k: " " },
          { t: '  const xff = req.headers["x-forwarded-for"];', k: " " },
          { t: '  if (xff) return xff.split(",")[0].trim();', k: " " },
          { t: "  return req.socket.remoteAddress;", k: " " },
          { t: "}", k: " " },
          { t: `app.post("/login", rateLimit({ key: clientIp, max: ${I.max}, per: "1m" }), login);`, k: " " },
        ] : I.lv === 2 ? [
          { t: "@@ src/middleware/client-ip.js @@", k: "@" },
          { t: "function clientIp(req) {", k: " " },
          { t: '-  const xff = req.headers["x-forwarded-for"];', k: "-" },
          { t: '-  if (xff) return xff.split(",")[0].trim();', k: "-" },
          { t: '+  const parts = (req.headers["x-forwarded-for"] || "")', k: "+" },
          { t: '+    .split(",").map((s) => s.trim()).filter(Boolean);', k: "+" },
          { t: "+  // never trust client-supplied entries: take the one our proxy added", k: "+" },
          { t: "+  if (parts.length) return parts[parts.length - 1];", k: "+" },
          { t: "   return req.socket.remoteAddress;", k: " " },
          { t: "}", k: " " },
          { t: '+log.debug("client ip", { ip: clientIp(req) });', k: "+" },
        ] : [
          { t: "@@ src/middleware/client-ip.js @@", k: "@" },
          { t: "const TRUSTED_HOPS = 2; // CDN + load balancer", k: " " },
          { t: "function clientIp(req) {", k: " " },
          { t: '  const parts = (req.headers["x-forwarded-for"] || "")', k: " " },
          { t: '    .split(",").map((s) => s.trim()).filter(Boolean);', k: " " },
          { t: "  if (parts.length >= TRUSTED_HOPS) return parts[parts.length - TRUSTED_HOPS];", k: " " },
          { t: "  return req.socket.remoteAddress;", k: " " },
          { t: "}", k: " " },
          { t: 'app.listen(8080, "0.0.0.0");', k: " " },
        ];
        return { lines, file: "src/middleware/client-ip.js", k: 1 };
      },
      ans: (I) => [I.lv === 1 ? 4 : I.lv === 2 ? 7 : 5],
      diag: (I) => I.lv === 1 ? "Who controls the first entry of X-Forwarded-For?" : I.lv === 2 ? "With two proxies appending, which entry is the last one?" : "What if the request didn't come through the CDN and LB at all?",
      hint: (I) => I.lv === 1 ? "X-Forwarded-For is a list; clients can send their own, and proxies append to it." : I.lv === 2 ? "The LB appends the address it saw connecting: the CDN's." : "The header is only meaningful when the TCP peer is your own proxy.",
      concept: "X-Forwarded-For trust",
      how: "X-Forwarded-For is a comma-separated list: each proxy appends the address it received the connection from. Anything to the left of what your own proxies added was supplied by the client and can be forged. The client address is therefore the entry N positions from the right, where N is the number of trusted proxies that append; the left-most entry is attacker-controlled and the right-most is your outermost proxy's peer. And all of this only holds when the request actually came through those proxies: check that the TCP peer is a trusted proxy before reading the header at all.",
      rule: "Read X-Forwarded-For from the right, skip exactly your trusted hops, and only when the connection comes from a trusted proxy (or use your framework's trusted-proxy setting).",
      why: (I) => I.lv === 1 ? "The left-most entry is whatever the client sent: an attacker rotates a fake X-Forwarded-For value per request and gets a fresh rate-limit bucket each time." : I.lv === 2 ? "The last entry is appended by the load balancer and is the CDN edge's address, so thousands of users share one bucket. Take the second from the right." : "Anyone reaching :8080 directly can send a two-entry X-Forwarded-For and choose their IP. Only honour the header when req.socket.remoteAddress is in the load balancer's subnet (or bind 8080 to the LB only).",
    },
    {
      id: "net-blast-radius",
      name: "Which component failed?",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "topo",
      gen(lv, R) { return { lv, n: R.int(2, 9) }; },
      text: (I) => `<p>Symptoms right now:</p><ul>${(I.lv === 1 ? ["Browsing, search and the cart work normally.", "The payment step times out after 10 s, for requests served from <b>both</b> AZs.", "The payment partner's status page is green and other merchants are fine.", "Database and LB metrics are normal."] : I.lv === 2 ? ["About half of API requests fail with 504 after 30 s; the rest are fine.", "Every failing request was served by app (AZ b); its health check is green and CPU is low.", "app (AZ b) logs: <code>Connection is not available, request timed out after 30000ms</code> from its DB pool.", "app (AZ b) can still call the payment partner."] : ["New visitors can't open the site at all (their browsers report DNS_PROBE_FINISHED_NXDOMAIN or time out).", "Users who had the site open keep browsing and checking out normally.", "Origin and CDN error rates are flat; CDN traffic is dropping steadily.", "Nothing was deployed today."]).map((x) => `<li>${x}</li>`).join("")}</ul><p>Select the <b>single</b> component or link whose failure explains <b>all</b> of the symptoms.</p>`,
      ui: () => ({ nodes: TOPO_N, links: TOPO_L, mode: "both", k: 1, W: 800, H: 290, nodeVerb: "failed", linkVerb: "broken", live: (a) => { if (!a || (!a.down.length && !a.cut.length)) return `<p class="muted small">Select a component to see what its failure would look like.</p>`; const key = a.down.length ? "n" + a.down[0] : "l" + a.cut[0]; return K.note(`<b>If this failed:</b> ${esc(TOPO_SYM[key])}`); } }),
      ans: (I) => (I.lv === 1 ? { down: [7], cut: [] } : I.lv === 2 ? { down: [], cut: [6] } : { down: [1], cut: [] }),
      diag: (I, a) => { const key = a.down.length ? "n" + a.down[0] : "l" + a.cut[0]; return `If that failed: ${esc(TOPO_SYM[key] || "")} That doesn't match every symptom.`; },
      hint: (I) => I.lv === 1 ? "What do both AZs share on the way to the partner?" : I.lv === 2 ? "A failed node would be pulled by the health check. What fails while the node looks healthy?" : "Who is unaffected? What did they already have that new visitors don't?",
      concept: "Fault isolation by blast radius",
      how: "Each component's failure produces a characteristic pattern: who is affected, which operations fail, and how (fast errors vs timeouts). Matching the observed blast radius against the topology narrows the suspect list quickly: symptoms in both AZs point at something they share; half the traffic failing with a healthy-looking node points at one of that node's dependencies; existing users working while new ones fail points at something only consulted at the start, like DNS. Hidden shared dependencies, such as one NAT gateway serving several AZs, are both a common cause and a design smell.",
      rule: "Start every incident by mapping who is and isn't affected onto the architecture diagram; the smallest component that explains everything is your first suspect.",
      why: (I) => I.lv === 1 ? "Both AZs route 0.0.0.0/0 through the single NAT gateway in AZ a: outbound calls time out everywhere while internal traffic is fine. That shared dependency is also the design flaw to fix (one NAT per AZ)." : I.lv === 2 ? "app (AZ b) is up (process-only health check is green) but can't reach Postgres: its pool times out after 30 s. Check that subnet's security group / route / NACL to the DB." : "Resolvers can't get answers from the authoritative DNS; people whose answer was still cached keep working until it expires, which is why CDN traffic decays steadily rather than dropping at once.",
    },
  ]);

})();
