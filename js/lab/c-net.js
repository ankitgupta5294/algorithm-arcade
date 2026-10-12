/* Systems Lab · Networking (part 1): DNS, TLS, load balancers and certificate rotation. Part 2 is c-net-2.js. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;

  /* ---------- shared helpers ---------- */
  const DOMS = ["larkpay.io", "northwind.dev", "tallyho.app", "brightcart.com", "quokka.cloud", "fernhill.io", "pebbleworks.net", "orbitalfox.com"];
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(((min % 60) + 60) % 60).padStart(2, "0")}`;
  const fq = (n) => (n.endsWith(".") ? n : n + ".");
  // dig output in BIND 9.18 shape. o: {cmd, name, type, server, status, ans:[[name, ttl, type, data]], auth:[...], ms, aa, err, short}
  function digOut(o) {
    const server = o.server || "127.0.0.53";
    if (o.err) return `;; communications error to ${server}#53: timed out\n;; communications error to ${server}#53: timed out\n;; communications error to ${server}#53: timed out\n\n; <<>> DiG 9.18.28 <<>> ${o.cmd}\n;; global options: +cmd\n;; no servers could be reached`;
    const a = o.ans || [], au = o.auth || [];
    if (o.short) return a.map((r) => r[3]).join("\n");
    const rr = (r) => `${fq(r[0]).padEnd(24)}${String(r[1]).padEnd(8)}IN\t${r[2]}\t${r[3]}`;
    const id = (K.hash(o.name + (o.type || "A") + server) % 60000) + 1000;
    return `; <<>> DiG 9.18.28 <<>> ${o.cmd}
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: ${o.status || "NOERROR"}, id: ${id}
;; flags: qr${o.aa ? " aa" : ""} rd${o.aa ? "" : " ra"}; QUERY: 1, ANSWER: ${a.length}, AUTHORITY: ${au.length}, ADDITIONAL: 1

;; QUESTION SECTION:
;${fq(o.name).padEnd(23)}\tIN\t${o.type || "A"}
${a.length ? "\n;; ANSWER SECTION:\n" + a.map(rr).join("\n") + "\n" : ""}${au.length ? "\n;; AUTHORITY SECTION:\n" + au.map(rr).join("\n") + "\n" : ""}
;; Query time: ${o.ms == null ? 1 : o.ms} msec
;; SERVER: ${server}#53(${server}) (UDP)
;; WHEN: Sun Oct 11 09:14:02 UTC 2026
;; MSG SIZE  rcvd: ${60 + a.length * 16 + au.length * 48}`;
  }
  // parse "dig [@server] name [type] [+short]" in any order
  function digArgs(line) {
    const t = line.split(" ").slice(1);
    const o = { type: "A", short: false, server: null, name: null };
    for (const x of t) {
      if (x[0] === "@") o.server = x.slice(1);
      else if (x === "+short") o.short = true;
      else if (/^\+/.test(x)) continue;
      else if (/^(A|AAAA|CNAME|MX|TXT|NS|SOA|CAA|ANY)$/i.test(x)) o.type = x.toUpperCase();
      else if (x === "-t") continue;
      else o.name = x.replace(/\.$/, "").toLowerCase();
    }
    return o;
  }
  // root-cause options for diagnosis terminals: I.opts is a shuffled list of keys, I.ans the right key
  const optsOf = (I, TXT) => I.opts.map((k) => TXT[k]);
  const pickCheck = (I, a, WHY) => { const k = I.opts[a.pick]; return k === I.ans ? true : WHY[k] || "That doesn't explain all of the evidence."; };
  const optIdx = (I, k) => I.opts.indexOf(k);
  const b64 = (seed, n) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; let h = K.hash(seed), s = ""; for (let i = 0; i < n; i++) { h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0; s += A[h % 64]; } return s; };

  /* ---------- DNS cutover model ---------- */
  function cutover(I, c) {
    const lowerS = c.lower * 3600, keepS = c.keep * 3600;
    const lowered = lowerS >= I.oldTtl;
    const eff = Math.max(c.ttl, I.floor || 0);
    const tail = Math.max(lowered ? eff : I.oldTtl, I.jvm || 0);
    const rollback = lowered ? eff : I.oldTtl;
    const qph = (ttl) => (I.resolvers * 3600) / ttl;
    const dnsCost = ((c.lower + c.keep) * qph(c.ttl) * I.qPrice) / 1e6;
    const cost = c.keep * I.oldCost + dnsCost;
    return { lowered, tail, rollback, cost, dnsCost, early: c.lower > I.lead };
  }
  const cutoverValid = (I, c) => {
    const r = cutover(I, c);
    if (r.early) return `you only have ${I.lead} h until the cutover window`;
    if (!r.lowered) return `the old TTL is ${K.num(I.oldTtl)} s; lowering it ${c.lower} h ahead leaves resolvers that cached the record earlier holding it for up to ${K.num(I.oldTtl / 3600, 1)} h after cutover`;
    if (r.rollback > I.rollbackMax) return `a rollback would take up to ${K.num(r.rollback / 60, 1)} min to reach resolvers (limit ${I.rollbackMax / 60} min)`;
    if (c.keep * 3600 < r.tail) return `some clients keep using the old address for up to ${K.num(r.tail / 60, 1)} min after cutover, but you turn the old servers off after ${K.num(c.keep * 60)} min`;
    return true;
  };

  /* ---------- negative caching ---------- */
  const soaLine = (dom, serial, min) => `ns1.dnsvendor.net. hostmaster.${dom}. ${serial} 7200 900 1209600 ${min}`;

  /* ---------- zone file checker (BIND syntax subset) ---------- */
  function parseZone(src, origin) {
    const lines = String(src).replace(/;[^\n]*/g, "").replace(/\([^)]*\)/g, (m) => m.replace(/\s+/g, " ").replace(/[()]/g, "")).split("\n");
    const recs = [], errs = [];
    let last = null;
    lines.forEach((ln, i) => {
      if (!ln.trim() || /^\s*\$/.test(ln)) return;
      const indent = /^\s/.test(ln);
      const t = ln.trim().split(/\s+/);
      let name;
      if (indent) name = last; else name = t.shift();
      if (!name) { errs.push(`line ${i + 1}: record without a name`); return; }
      if (/^\d+$/.test(t[0])) t.shift();
      if (/^IN$/i.test(t[0])) t.shift();
      const type = (t.shift() || "").toUpperCase();
      if (!/^(A|AAAA|CNAME|MX|TXT|NS|SOA|ALIAS|CAA|SRV)$/.test(type)) { errs.push(`line ${i + 1}: unknown record type "${type}"`); return; }
      const full = name === "@" ? origin : name.endsWith(".") ? name.slice(0, -1) : `${name}.${origin}`;
      last = name;
      recs.push({ name: full.toLowerCase(), type, data: t.join(" "), line: i + 1 });
    });
    return { recs, errs };
  }

  /* ---------- resolver model (glibc / musl stub resolvers) ---------- */
  function resolverSim(I, c) {
    // returns latency for an external lookup, queries per lookup, internal lookups OK
    const out = { qpl: 0, lat: 0, p999: 0, notes: [] };
    if (I.lv === 1) {
      const deadFirst = c.order === "dead first";
      const rot = c.order === "rotate";
      const slow = (c.timeout * 1000) + 2;
      out.qpl = 1;
      out.lat = deadFirst ? slow : rot ? 0.5 * slow + 0.5 * 2 : 2;
      out.p99 = deadFirst || rot ? slow : 2;
      out.ok = !deadFirst || c.attempts >= 1;
      return out;
    }
    const tryList = (name, fqdn) => {
      const dots = (name.match(/\./g) || []).length;
      if (fqdn) return [name];
      const search = I.search.map((s) => `${name}.${s}`);
      return dots >= c.ndots ? [name, ...search] : [...search, name];
    };
    const exists = (n) => I.exist.includes(n);
    const cost = (n) => (/cluster\.local$/.test(n) ? 0.6 : /compute\.internal$/.test(n) ? 3 : 12);
    const lookup = (name, fqdn) => { let q = 0, ms = 0; for (const n of tryList(name, fqdn)) { q += 2; ms += cost(n); if (exists(n)) return { q, ms, ok: true }; } return { q, ms, ok: false }; };
    const ext = lookup(I.ext, c.fqdn === "yes");
    out.qpl = ext.q; out.lat = ext.ms;
    out.internal = I.internal.map((n) => ({ n, r: lookup(n, false) }));
    out.ok = ext.ok && out.internal.every((x) => x.r.ok);
    if (I.lv === 3) {
      const race = c.nodelocal === "on" ? 0 : c.opt !== "none" && !I.musl ? 0 : 0.004;
      out.race = race;
      out.p999 = race > 0.001 ? c.timeout * 1000 + out.lat : out.lat * 2 + 1;
    }
    return out;
  }

  /* ================= scenarios ================= */
  LB.addAll("net", [
    {
      id: "net-dns-cutover-plan",
      name: "Plan the DNS cutover",
      kind: "Change plan",
      skills: ["safe", "estimate"],
      w: "tune",
      sense: "min",
      vname: "a cost of",
      vfmt: (v) => K.usd(v),
      gen(lv, R) {
        const dom = R.pick(DOMS), host = R.pick(["api", "app", "shop", "pay"]) + "." + dom;
        return {
          lv, host,
          oldTtl: lv === 1 ? 3600 : lv === 2 ? 86400 : 172800,
          lead: lv === 3 ? 60 : 96,
          rollbackMax: lv === 1 ? 900 : lv === 2 ? 300 : 600,
          jvm: lv >= 2 ? 3600 : 0,
          floor: lv === 3 ? 600 : 0,
          resolvers: R.int(15, 30) * 10000,
          qPrice: 0.4,
          oldCost: R.int(3, 8) * 10,
        };
      },
      text: (I) => `<p>You're moving <code>${esc(I.host)}</code> to a new load balancer with a new IP. The A record has <b>TTL ${K.num(I.oldTtl)} s</b>. About ${K.num(I.resolvers)} distinct resolvers query it; the DNS provider bills <b>$${I.qPrice} per million queries</b>, and the old cluster costs <b>$${I.oldCost}/hour</b> while it stays up.</p><ul>
        <li>If the new LB misbehaves you must be able to <b>roll back within ${I.rollbackMax / 60} minutes</b>.</li>
        ${I.jvm ? `<li>A partner's Java service caches lookups for <b>3600 s</b> (<code>networkaddress.cache.ttl=3600</code>), whatever the TTL says.</li>` : ""}
        ${I.floor ? `<li>Resolver telemetry shows a large ISP resolver that <b>floors TTLs at ${I.floor} s</b>.</li><li>The cutover window starts in <b>${I.lead} hours</b>.</li>` : ""}
      </ul><p>Choose the plan that's safe (no client ever hits a turned-off server; rollback fast enough) at the <b>lowest cost</b>.</p>`,
      ui: (I) => ({
        knobs: [
          { k: "lower", label: "Lower the TTL this long before cutover", opts: [0, 1, 6, 24, 48, 72], unit: "h" },
          { k: "ttl", label: "Temporary TTL", opts: [30, 60, 300, 900, 3600], unit: "s", help: "kept until the old servers are turned off" },
          { k: "keep", label: "Keep the old servers serving after cutover", opts: [0, 0.25, 0.5, 1, 2, 6, 24], fmt: (v) => (v < 1 ? v * 60 + " min" : v + " h") },
        ],
        live: (c) => {
          if (!c) return "";
          const r = cutover(I, c), v = cutoverValid(I, c);
          return K.metrics([
            { name: "Old TTL flushed before cutover", value: r.early ? "too early" : r.lowered ? "yes" : "no", ok: r.lowered && !r.early },
            { name: "Stragglers after cutover", value: K.num(r.tail / 60, 1) + " min", ok: c.keep * 3600 >= r.tail, target: `old servers up ${c.keep < 1 ? c.keep * 60 + " min" : c.keep + " h"}` },
            { name: "Rollback reaches resolvers in", value: K.num(r.rollback / 60, 1) + " min", ok: r.rollback <= I.rollbackMax, target: `≤ ${I.rollbackMax / 60} min` },
            { name: "Extra DNS queries", value: K.usd(r.dnsCost), ok: null },
            { name: "Total cost", value: K.usd(r.cost), ok: null },
          ]) + (v === true ? K.verdict(true, "Safe plan.") : K.verdict(false, esc(v)));
        },
      }),
      valid: cutoverValid,
      val: (I, c) => Math.round(cutover(I, c).cost * 100) / 100,
      hint: (I) => I.lv === 1 ? "Resolvers that cached the record before you lowered the TTL keep it for the old TTL. Lower it at least one old TTL ahead." : I.lv === 2 ? "Some clients ignore your TTL entirely. How long must the old servers keep answering for them?" : "A resolver that floors TTLs makes very short TTLs pointless and expensive. And check your calendar.",
      concept: "TTL-driven DNS cutovers",
      how: "A resolver that cached a record keeps it until the TTL it received runs out, so lowering a TTL only takes effect once the old TTL has expired everywhere. Lower it at least one old-TTL before the change, cut over, keep the old endpoint serving for at least the new TTL (or the longest client-side cache you know of, such as a JVM's networkaddress.cache.ttl), then raise the TTL again. The low TTL is also your rollback speed. Very low TTLs multiply query volume and some resolvers floor them anyway, so pick the largest TTL that meets the rollback requirement.",
      rule: "Lower the TTL one old-TTL ahead, keep the old target alive for the longest cache you know of, and pick the largest TTL your rollback time allows.",
      why: (I, sol) => { const r = cutover(I, sol); return `The old TTL of ${K.num(I.oldTtl)} s means lowering it ${sol.lower} h ahead; a ${sol.ttl} s TTL keeps rollback under ${I.rollbackMax / 60} min${I.floor ? ` (the ISP floor makes anything under ${I.floor} s cost more without being faster for that resolver)` : ""}; stragglers last ${K.num(r.tail / 60, 1)} min${I.jvm ? " because of the partner's JVM cache" : ""}, so the old servers stay up ${sol.keep < 1 ? sol.keep * 60 + " min" : sol.keep + " h"}. Total ≈ ${K.usd(r.cost)}.`; },
    },
    {
      id: "net-negative-cache",
      name: "The record exists, but they still get NXDOMAIN",
      kind: "Estimate",
      skills: ["estimate", "diagnose"],
      w: "num",
      gen(lv, R) {
        const dom = R.pick(DOMS), sub = R.pick(["status", "beta", "docs", "hooks", "eu"]) + "." + dom;
        const min = R.pick([1800, 3600, 7200]);
        const soaTtl = lv === 1 ? min : R.pick([300, 600, 900]);
        const neg = Math.min(min, soaTtl);
        const created = 14 * 60 + R.int(0, 10);
        const I = { lv, dom, sub, min, soaTtl, neg, created, serial: 2026101100 + R.int(1, 9) };
        if (lv === 3) {
          I.lastNeg = created - R.int(3, 12); // last NXDOMAIN cached before the record existed
          I.check = created + R.int(4, 9);
          I.remain = I.lastNeg * 60 + neg - I.check * 60;
          if (I.remain <= 60) return null;
          I.truth = (I.lastNeg * 60 + neg - created * 60) / 60;
        } else I.truth = neg / 60;
        return I;
      },
      text: (I) => {
        const auth = digOut({ cmd: `${I.sub} @ns1.dnsvendor.net`, name: I.sub, server: "ns1.dnsvendor.net", status: "NXDOMAIN", aa: true, auth: [[I.dom, I.soaTtl, "SOA", soaLine(I.dom, I.serial, I.min)]], ms: 18 });
        const head = `<p>A marketing launch link pointed at <code>${esc(I.sub)}</code> before the record existed. ${I.lv < 3 ? "Thousands of people clicked it" : "Only the uptime checker hit it, through the office resolver"}; the record was created at <b>${hhmm(I.created)}</b>. Before that, the authoritative server answered:</p>${K.pre(auth)}`;
        if (I.lv < 3) return head + `<p>Resolvers cache that NXDOMAIN. <b>How many minutes after ${hhmm(I.created)}</b> can you be sure every resolver returns the new record? (Assume no resolver caps negative answers.)</p>`;
        const cached = digOut({ cmd: `${I.sub} @10.0.0.2`, name: I.sub, server: "10.0.0.2", status: "NXDOMAIN", auth: [[I.dom, I.remain, "SOA", soaLine(I.dom, I.serial, I.min)]], ms: 0 });
        return head + `<p>At <b>${hhmm(I.check)}</b> the office resolver still says:</p>${K.pre(cached)}<p><b>How many minutes after the record was created (${hhmm(I.created)})</b> will the office resolver start returning it?</p>`;
      },
      ui: () => ({ unit: "minutes" }),
      accept: (I, a) => LB.near(I.truth, 0.12)(I, a),
      solve: (I) => Math.round(I.truth),
      bad: (I) => (I.lv === 1 ? [I.min / 60 * 3, 0] : I.lv === 2 ? [I.min / 60] : [I.neg / 60 + 30, (I.check - I.created) + 0.5]).filter((x) => Math.abs(x - I.truth) > I.truth * 0.15),
      hint: (I) => I.lv === 1 ? "RFC 2308: a negative answer is cached for the smaller of the SOA record's own TTL and its MINIMUM field (the last number)." : I.lv === 2 ? "Two numbers in that SOA line could be the negative TTL. The resolver uses the smaller one." : "A cached answer shows its remaining TTL, counting down.",
      concept: "Negative caching (RFC 2308)",
      how: "When a name doesn't exist, the authoritative server returns NXDOMAIN with the zone's SOA record in the authority section. Resolvers cache that negative answer for the minimum of the SOA record's TTL and the SOA MINIMUM field (the last number in the SOA). Creating the record doesn't flush those caches. A cached answer shows the remaining TTL counting down, so dig against the resolver tells you exactly how long is left.",
      rule: "Create DNS records before anything links to them. If you can't, keep the SOA negative TTL short (a few minutes) and read the remaining TTL from the cached answer instead of guessing.",
      why: (I) => I.lv < 3 ? `Negative TTL = min(SOA TTL ${I.soaTtl} s, MINIMUM ${I.min} s) = ${I.neg} s, so the worst case is a resolver that cached the NXDOMAIN just before ${hhmm(I.created)}: <b>${I.neg / 60} minutes</b>.` : `The office resolver cached NXDOMAIN at ${hhmm(I.lastNeg)} for ${I.neg} s; at ${hhmm(I.check)} it showed ${I.remain} s left, so it expires ${K.num(I.truth, 1)} min after the record was created. The lookup at ${hhmm(I.check)} was served from cache and didn't refresh it.`,
    },
    {
      id: "net-cname-apex",
      name: "Point the bare domain at the CDN",
      kind: "Config change",
      skills: ["design", "safe"],
      w: "code",
      gen(lv, R) {
        const dom = R.pick(DOMS), edge = `${dom.split(".")[0]}-prod.${R.pick(["edgefleet.net", "fastlane-cdn.net", "cachewave.net"])}`;
        const ips = R.distinct(3, 10, 250).map((x) => `198.51.100.${x}`);
        return { lv, dom, edge, ips, mailIp: `203.0.113.${R.int(10, 200)}`, verify: "site-verify=" + b64(dom + lv, 22).replace(/[+/]/g, "x") };
      },
      text: (I) => `<p>The <code>${esc(I.dom)}</code> zone is about to be uploaded so that the bare domain (apex) and <code>www</code> are served by the CDN, whose edge hostname is <code>${esc(I.edge)}</code>. The CDN's IPs rotate (<code>dig ${esc(I.edge)}</code> returns ${I.ips.join(", ")} today, different ones tomorrow). The upload fails:</p>${K.pre(`$ named-checkzone ${I.dom} db.${I.dom}\n${I.lv === 3 ? `zone ${I.dom}/IN: ${I.dom}: CNAME and other data\nzone ${I.dom}/IN: shop.${I.dom}: CNAME and other data\nzone ${I.dom}/IN: ${I.dom}/MX 'mail.${I.dom}' is a CNAME (illegal)` : I.lv === 2 ? `zone ${I.dom}/IN: ${I.dom}: CNAME and other data\nzone ${I.dom}/IN: shop.${I.dom}: CNAME and other data` : `zone ${I.dom}/IN: ${I.dom}: CNAME and other data`}\nzone ${I.dom}/IN: loading from master file db.${I.dom} failed: CNAME and other data`)}<p>The DNS provider supports an <b><code>ALIAS</code></b> record type (it resolves the target itself and answers with A/AAAA records). Fix the zone without breaking mail${I.lv >= 2 ? ", SPF or the shop's domain verification" : ""}.</p>`,
      ui: (I) => {
        const lines = [`$ORIGIN ${I.dom}.`, "$TTL 300", `@        IN SOA   ns1.dnsvendor.net. hostmaster.${I.dom}. ( 2026101101 7200 900 1209600 300 )`, "@        IN NS    ns1.dnsvendor.net.", "@        IN NS    ns2.dnsvendor.net."];
        if (I.lv === 3) lines.push(`@        IN MX    10 mail.${I.dom}.`, `mail     IN CNAME mx-pool.mailrelay.net.`); else lines.push("@        IN MX    10 mx1.mailrelay.net.");
        if (I.lv >= 2) lines.push('@        IN TXT   "v=spf1 include:mailrelay.net -all"');
        lines.push(`@        IN CNAME ${I.edge}.`, `www      IN CNAME ${I.edge}.`);
        if (I.lv >= 2) lines.push(`shop     IN CNAME shops.storefront-host.net.`, `shop     IN TXT   "${I.verify}"`);
        const starter = lines.join("\n");
        return {
          lang: "zone", file: `db.${I.dom}`, starter, rows: lines.length + 2,
          live: (src) => { const r = zoneCheck(I, src || ""); return r === true ? K.verdict(true, "named-checkzone: OK, and every name resolves as required.") : K.verdict(false, r); },
        };
      },
      accept: (I, src) => zoneCheck(I, src),
      solve: (I) => {
        const lines = [`$ORIGIN ${I.dom}.`, "$TTL 300", `@        IN SOA   ns1.dnsvendor.net. hostmaster.${I.dom}. ( 2026101101 7200 900 1209600 300 )`, "@        IN NS    ns1.dnsvendor.net.", "@        IN NS    ns2.dnsvendor.net."];
        if (I.lv === 3) lines.push(`@        IN MX    10 mx-pool.mailrelay.net.`); else lines.push("@        IN MX    10 mx1.mailrelay.net.");
        if (I.lv >= 2) lines.push('@        IN TXT   "v=spf1 include:mailrelay.net -all"');
        lines.push(`@        IN ALIAS ${I.edge}.`, `www      IN CNAME ${I.edge}.`);
        if (I.lv >= 2) lines.push(`shop     IN ALIAS shops.storefront-host.net.`, `shop     IN TXT   "${I.verify}"`);
        return lines.join("\n");
      },
      bad: (I) => {
        const s = LB.byId.get("net-cname-apex").solve(I);
        return [
          s.replace(`@        IN ALIAS ${I.edge}.`, I.ips.map((ip) => `@        IN A     ${ip}`).join("\n")),
          s.replace(/^@\s+IN MX.*$/m, ""),
          ...(I.lv >= 2 ? [s.replace(/^shop\s+IN TXT.*$/m, ""), s.replace(/^@\s+IN TXT.*$/m, "")] : []),
          ...(I.lv === 3 ? [s.replace("10 mx-pool.mailrelay.net.", `10 mail.${I.dom}.`) + `\nmail     IN CNAME mx-pool.mailrelay.net.`] : []),
        ];
      },
      hint: (I) => I.lv === 1 ? "A CNAME can't share a name with any other record, and the apex always has SOA and NS." : I.lv === 2 ? "The same rule applies to every name in the zone, not just the apex. Which record type lets a name alias a hostname and still carry a TXT record?" : "RFC 2181: an MX target must be a name with A/AAAA records, not an alias.",
      concept: "CNAME at the apex, ALIAS/ANAME and the CNAME rules",
      how: "A CNAME says 'this name is entirely another name', so it can't coexist with any other record type at the same name. The zone apex always has SOA and NS records (plus usually MX and TXT), so a CNAME there is illegal. Providers offer ALIAS/ANAME (or 'CNAME flattening'): the authoritative server resolves the target itself and answers with A/AAAA records, so the apex keeps its other records and follows the CDN's rotating IPs. Hard-coding today's CDN IPs works until the CDN moves them. MX and NS targets must be hostnames with address records, never CNAMEs.",
      rule: "Use CNAME for subdomains that hold nothing else, ALIAS/flattening for the apex or for any name that also needs TXT or MX, and never pin a CDN's IPs in your zone.",
      why: (I) => `The apex now uses <code>ALIAS ${esc(I.edge)}.</code>, so SOA, NS, MX${I.lv >= 2 ? " and the SPF TXT" : ""} can stay${I.lv >= 2 ? `; <code>shop</code> needed the same treatment because it carries a verification TXT next to its alias` : ""}${I.lv === 3 ? `; and the MX now names the mail relay directly because <code>mail.${esc(I.dom)}</code> was a CNAME` : ""}.`,
    },
    {
      id: "net-split-horizon",
      name: "Internal names don't resolve on the VPN",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) {
        const dom = R.pick(DOMS), co = dom.split(".")[0];
        const intIp = `10.${R.int(20, 60)}.${R.int(1, 9)}.${R.int(10, 200)}`;
        const keys = lv === 1 ? ["noroute", "vpnDown", "dnsDown", "recordMissing"] : lv === 2 ? ["shadow", "noroute", "pubMissing", "ttl"] : ["noRoute53", "dnsDown", "noroute", "firewall"];
        const ans = keys[0];
        return { lv, dom, co, intDom: `corp.${dom}`, intIp, dnsIp: `10.${R.int(20, 60)}.0.53`, pubIp: `203.0.113.${R.int(10, 200)}`, name: lv === 2 ? R.pick(["status", "grafana", "sso"]) + "." + dom : R.pick(["git", "wiki", "jira", "vault"]) + ".corp." + dom, opts: R.shuffle(keys.slice()), ans };
      },
      text: (I) => `<p>${I.lv === 2 ? `Since this morning, employees on the VPN get <b>NXDOMAIN</b> for <code>${esc(I.name)}</code>, a public name that marketing created yesterday. From home without VPN it works.` : `On the VPN, <code>${esc(I.name)}</code> doesn't resolve for engineers on the new laptop image. The VPN shows <i>connected</i>.`}</p><p>You're on an affected laptop (systemd-resolved). Find out why${I.lv === 1 ? " and fix the laptop's DNS routing so internal names go to the VPN's resolver" : " and pick the root cause"}.</p>`,
      ...LB.term({
        shell: (I) => splitShell(I),
        goal: (st, I, a) => {
          if (I.lv === 1 && !st.routed) return "The laptop still sends queries for the internal domain to the public resolver.";
          if (I.lv === 1) return true;
          return pickCheck(I, a, {
            noroute: "Queries for the domain do go to the VPN resolver (see <code>resolvectl status</code>).",
            dnsDown: "The resolver answers other queries fine.",
            vpnDown: "The tunnel is up and routes traffic.",
            recordMissing: "The record exists on the internal resolver.",
            pubMissing: "Public DNS returns the record; the internal resolver is the one saying NXDOMAIN.",
            ttl: "There's no cached old answer; it's an authoritative NXDOMAIN from the internal zone.",
            noRoute53: "",
            firewall: "Nothing on the path rejects the packets; they leave through the wrong interface.",
            shadow: "",
          });
        },
        solve: (I) => I.lv === 1 ? { log: ["resolvectl status", `dig ${I.name}`, `resolvectl domain tun0 '~corp.${I.dom}'`, `dig ${I.name}`] }
          : I.lv === 2 ? { log: ["resolvectl status", `dig ${I.name}`, `dig @1.1.1.1 ${I.name}`], pick: optIdx(I, "shadow") }
            : { log: ["resolvectl status", `dig @${I.dnsIp} ${I.name}`, `ip route get ${I.dnsIp}`], pick: optIdx(I, "noRoute53") },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["resolvectl status", `resolvectl dns wlan0 ${I.dnsIp}`] }, { log: ["resolvectl status"] }] : [{ log: ["resolvectl status"], pick: (optIdx(I, I.ans) + 1) % 4 }, { log: ["resolvectl status"], pick: (optIdx(I, I.ans) + 2) % 4 }],
      hint: (I) => I.lv === 1 ? "systemd-resolved sends a query to the link whose routing domain matches it best. Which link claims the internal domain?" : I.lv === 2 ? "Compare the answer from the VPN resolver with a public resolver, and look at whose SOA comes back." : "The resolver's address is configured, but can packets to it actually go through the tunnel?",
      concept: "Split-horizon DNS and per-link DNS routing",
      how: "Split-horizon DNS serves different answers to internal and external clients. On the client, systemd-resolved (and macOS/Windows equivalents) route each query to a link's DNS servers by matching routing domains like ~corp.example; without one, queries go to the default link's public resolver, which has never heard of internal names. If the internal server hosts its own copy of a public zone, it is authoritative for the whole zone and answers NXDOMAIN for any record added only to the public copy. And the resolver's IP must be reachable through the tunnel: a split-tunnel route table that omits it sends DNS out the wrong interface.",
      rule: "When a name fails on the VPN, check three things in order: which server got the query (resolvectl status / dig with no @), what that server answers (dig @server), and whether the server is reachable over the tunnel (ip route get).",
      why: (I) => I.lv === 1 ? `tun0 had the VPN resolver ${I.dnsIp} but no routing domain, so <code>${esc(I.name)}</code> went to the Wi-Fi link's public resolver. <code>resolvectl domain tun0 '~corp.${esc(I.dom)}'</code> routes the internal domain to the VPN resolver.` : I.lv === 2 ? `The internal DNS server hosts its own copy of <code>${esc(I.dom)}</code> (split horizon), and the VPN routes that whole domain to it. Marketing added <code>${esc(I.name)}</code> only to the public zone, so the internal copy answers NXDOMAIN with its own SOA. Add the record to the internal view too, or delegate only an internal subdomain.` : `resolved is configured to use ${I.dnsIp}, but the split-tunnel routes cover only 10.${I.dnsIp.split(".")[1]}.1.0/24, so DNS packets leave via Wi-Fi and time out. Push a route for the resolver (or the whole 10.x range) over the tunnel.`,
    },
    {
      id: "net-resolver-timeouts",
      name: "Fix the slow lookups",
      kind: "Config change",
      skills: ["tune", "diagnose"],
      w: "tune",
      sense: "min",
      vname: "queries per lookup:",
      gen(lv, R) {
        if (lv === 1) return { lv, dead: `10.0.${R.int(0, 3)}.${R.int(2, 9)}`, live: `10.0.${R.int(4, 9)}.2`, target: 50 };
        const ns = R.pick(["shop", "billing", "ledger", "media"]), other = R.pick(["orders", "risk", "search"]);
        const ext = R.pick(["api.paygate-partner.com", "hooks.mailrelay.net", "auth.idp-vendor.io"]);
        return {
          lv, ns, ext, musl: lv === 3,
          search: [`${ns}.svc.cluster.local`, "svc.cluster.local", "cluster.local", `${R.pick(["us-east-2", "eu-west-1"])}.compute.internal`],
          exist: [`${other}.${ns}.svc.cluster.local`, `${other}.risk.svc.cluster.local`, ext],
          internal: [other, `${other}.risk`],
          maxQ: lv === 2 ? 4 : 6, target: lv === 2 ? 20 : 60,
        };
      },
      text: (I) => I.lv === 1 ? `<p>Every request from the <code>worker</code> VMs takes over a second; profiling shows the time in <code>getaddrinfo()</code>. Their <code>/etc/resolv.conf</code>:</p>${K.pre(`nameserver ${I.dead}    # old resolver, decommissioned last week\nnameserver ${I.live}`)}<p>The app does one lookup per request (no DNS cache). Configure the resolver so <b>lookups take under ${I.target} ms</b>, with as few queries as possible.</p>`
        : `<p>A pod in namespace <code>${esc(I.ns)}</code> calls <code>${esc(I.ext)}</code> thousands of times a second, and CoreDNS is drowning. Its <code>/etc/resolv.conf</code>:</p>${K.pre(`search ${I.search.join(" ")}\nnameserver 10.96.0.10\noptions ndots:5`)}<p>It must still reach <code>${esc(I.internal[0])}</code> (same namespace) and <code>${esc(I.internal[1])}</code> (another namespace) by short name.${I.lv === 3 ? ` Separately, about 1 lookup in 250 takes exactly <b>5 s</b>. The image is Alpine (musl libc), and A and AAAA queries go out in parallel from the same socket, through kube-proxy's DNAT. Keep p99.9 lookup time under ${I.target} ms.` : ` Keep external lookups under ${I.target} ms.`}</p><p>Minimise <b>DNS queries per external lookup</b>.</p>`,
      ui: (I) => {
        const knobs = I.lv === 1 ? [
          { k: "order", label: "Nameservers", opts: ["dead first", "live first", "rotate"], help: "order in resolv.conf (rotate = options rotate)" },
          { k: "timeout", label: "options timeout", opts: [1, 2, 5], unit: "s" },
          { k: "attempts", label: "options attempts", opts: [1, 2], help: "" },
        ] : [
          { k: "ndots", label: "options ndots", opts: [1, 2, 5], help: "names with fewer dots try the search list first" },
          { k: "fqdn", label: `Call the partner as "${I.ext}." (trailing dot)`, opts: ["no", "yes"] },
          ...(I.lv === 3 ? [
            { k: "timeout", label: "options timeout", opts: [1, 5], unit: "s" },
            { k: "opt", label: "Extra resolv.conf option", opts: ["none", "single-request-reopen"] },
            { k: "nodelocal", label: "NodeLocal DNSCache", opts: ["off", "on"], help: "per-node cache on a link-local IP, no DNAT/conntrack for pod DNS" },
          ] : []),
        ];
        return { knobs, live: (c) => { if (!c) return ""; return resolverLive(I, c); } };
      },
      valid: (I, c) => {
        const r = resolverSim(I, c);
        if (I.lv === 1) return r.p99 <= I.target ? true : `the slow path still takes ${K.ms(r.p99)}`;
        if (!r.ok) { const bad = (r.internal || []).find((x) => !x.r.ok); return bad ? `${bad.n} no longer resolves` : "the partner name doesn't resolve"; }
        if (r.qpl > I.maxQ) return `${r.qpl} queries per lookup (CoreDNS can take at most ${I.maxQ})`;
        if (I.lv === 2 && r.lat > I.target) return `external lookups take ${K.ms(r.lat)}`;
        if (I.lv === 3 && r.p999 > I.target) return `p99.9 is ${K.ms(r.p999)}: the 5 s stalls are still there`;
        return true;
      },
      val: (I, c) => resolverSim(I, c).qpl,
      hint: (I) => I.lv === 1 ? "glibc tries nameservers in order and waits the full timeout on each dead one. Rotate spreads the pain instead of removing it." : I.lv === 2 ? `Count the dots in ${I.ext}. With ndots:5, every search domain is tried first, for A and AAAA. Short internal names still need the search list.` : "Which resolver options does musl actually implement? The 5 s is a lost UDP reply waiting out the timeout.",
      concept: "Stub resolver behaviour: nameserver order, ndots and search lists",
      how: "The libc stub resolver tries nameservers in resolv.conf order, waiting the full timeout (default 5 s) on each that doesn't answer, so a dead first entry adds seconds to every lookup. A name with fewer dots than ndots is tried with every search suffix first; Kubernetes sets ndots:5 and four suffixes, so an external name with two dots costs 8 or more queries (A and AAAA for each) before the real one. A trailing dot makes a name absolute and skips the search list; lowering ndots does the same for dotted names while keeping short names working. Parallel A/AAAA queries from one socket through conntrack/DNAT can race and drop a reply, which surfaces as exactly-timeout stalls; glibc's single-request-reopen works around it, musl ignores that option, and NodeLocal DNSCache avoids the DNAT path entirely.",
      rule: "Remove dead resolvers instead of tuning timeouts, use FQDNs with a trailing dot (or ndots:1-2) for external names in Kubernetes, and when lookups take exactly the timeout, suspect a lost UDP packet, not a slow server.",
      why: (I, sol) => { const r = resolverSim(I, sol); return I.lv === 1 ? `With the dead resolver first, every lookup waited the timeout before trying ${I.live}. Putting the live one first answers in ~2 ms (and remove the dead entry for good).` : `With ndots:${sol.ndots}${sol.fqdn === "yes" ? " and a trailing dot" : ""}, an external lookup takes ${r.qpl} queries instead of ${resolverSim(I, { ndots: 5, fqdn: "no", timeout: 5, opt: "none", nodelocal: "off" }).qpl}, and short internal names still resolve through the search list.${I.lv === 3 ? " musl ignores single-request-reopen, so only NodeLocal DNSCache (no DNAT, no conntrack race) removes the 5 s stalls." : ""}`; },
    },
  ]);

  function resolverLive(I, c) {
    const r = resolverSim(I, c), v = LB.byId.get("net-resolver-timeouts").valid(I, c);
    if (I.lv === 1) return K.metrics([{ name: "Typical lookup", value: K.ms(r.lat), ok: r.lat <= I.target }, { name: "Slow path", value: K.ms(r.p99), ok: r.p99 <= I.target, target: `< ${I.target} ms` }]) + K.verdict(v === true, v === true ? "Lookups are fast." : esc(v));
    const rows = [[`${esc(I.ext)}`, String(r.qpl), K.ms(r.lat)], ...r.internal.map((x) => [esc(x.n), String(x.r.q), x.r.ok ? K.ms(x.r.ms) : '<span class="lose">NXDOMAIN</span>'])];
    return K.table(["lookup", "queries", "time"], rows, { compact: true, mono: [0] }) + K.metrics([
      { name: "Queries per external lookup", value: String(r.qpl), ok: r.qpl <= I.maxQ, target: `≤ ${I.maxQ}` },
      ...(I.lv === 3 ? [{ name: "Lost-reply stalls", value: r.race ? "1 in 250" : "none", ok: !r.race }, { name: "p99.9", value: K.ms(r.p999), ok: r.p999 <= I.target, target: `< ${I.target} ms` }] : []),
    ]) + K.verdict(v === true, v === true ? "Meets the requirements." : esc(v));
  }

  function zoneCheck(I, src) {
    const { recs, errs } = parseZone(src, I.dom);
    if (errs.length) return esc(errs[0]);
    const at = (n) => recs.filter((r) => r.name === n);
    const names = [...new Set(recs.map((r) => r.name))];
    for (const n of names) { const rs = at(n); if (rs.some((r) => r.type === "CNAME") && rs.length > 1) return `<code>${esc(n)}: CNAME and other data</code>: a CNAME must be the only record at its name.`; }
    const apex = at(I.dom);
    if (!apex.some((r) => r.type === "SOA") || apex.filter((r) => r.type === "NS").length < 2) return "Keep the SOA and both NS records at the apex.";
    const mx = apex.filter((r) => r.type === "MX");
    if (!mx.length) return "Mail for the domain is gone: keep an MX record at the apex.";
    for (const m of mx) {
      const tgt = (m.data.split(/\s+/)[1] || "").replace(/\.$/, "").toLowerCase();
      if (at(tgt).some((r) => r.type === "CNAME")) return `MX points at <code>${esc(tgt)}</code>, which is a CNAME. Mail servers may refuse it (RFC 2181 §10.3): point the MX at a host with A/AAAA records.`;
      if (I.lv === 3 && tgt.endsWith(I.dom) && !at(tgt).some((r) => r.type === "A" || r.type === "AAAA")) return `MX target <code>${esc(tgt)}</code> has no address record.`;
    }
    if (I.lv >= 2 && !apex.some((r) => r.type === "TXT" && /v=spf1/.test(r.data))) return "The SPF TXT record at the apex is gone; outgoing mail will start failing SPF.";
    if (apex.some((r) => r.type === "A" && I.ips.some((ip) => r.data.includes(ip)))) return "You pinned today's CDN IPs. They rotate, and the apex will break when they do. Alias the edge hostname instead.";
    if (!apex.some((r) => r.type === "ALIAS" && r.data.replace(/\.$/, "") === I.edge)) return `The apex must follow the CDN hostname <code>${esc(I.edge)}</code>.`;
    const www = at("www." + I.dom);
    if (!www.some((r) => (r.type === "CNAME" || r.type === "ALIAS") && r.data.replace(/\.$/, "") === I.edge)) return "www must still point at the CDN.";
    if (I.lv >= 2) {
      const shop = at("shop." + I.dom);
      if (!shop.some((r) => r.type === "TXT" && r.data.includes(I.verify))) return "The shop's verification TXT record is gone; the storefront host will un-verify the domain.";
      if (!shop.some((r) => (r.type === "ALIAS" || r.type === "CNAME") && /shops\.storefront-host\.net/.test(r.data))) return "shop must still point at the storefront host.";
    }
    return true;
  }

  /* ---------- split-horizon sandbox ---------- */
  function splitShell(I) {
    const init = { routed: false };
    const statusOut = (st) => `Global
         Protocols: +LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
  resolv.conf mode: stub

Link 2 (wlan0)
    Current Scopes: DNS
         Protocols: +DefaultRoute -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: 192.168.1.1
       DNS Servers: 192.168.1.1 1.1.1.1

Link 5 (tun0)
    Current Scopes: DNS
         Protocols: -DefaultRoute -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: ${I.dnsIp}
       DNS Servers: ${I.dnsIp}
        DNS Domain: ${I.lv === 1 && !st.routed ? "" : I.lv === 2 ? `~${I.dom}` : `~corp.${I.dom}`}`;
    const isInternal = (n) => n.endsWith("corp." + I.dom);
    const viaVpn = (n, st) => (I.lv === 1 ? st.routed && isInternal(n) : I.lv === 2 ? n.endsWith(I.dom) : isInternal(n));
    const answer = (name, server, st, cmd, short) => {
      const internalServer = server === I.dnsIp;
      if (internalServer && I.lv === 3) return digOut({ cmd, name, server, err: true });
      const soaInt = [I.dom, 300, "SOA", `dns1.corp.${I.dom}. hostmaster.${I.dom}. 2026100902 3600 600 604800 300`];
      const soaPub = [I.dom, 900, "SOA", soaLine(I.dom, 2026101003, 900)];
      if (name === I.name) {
        if (I.lv === 2) return internalServer ? digOut({ cmd, name, server, status: "NXDOMAIN", auth: [soaInt], ms: 3, short }) : digOut({ cmd, name, server, ans: [[name, 300, "A", I.pubIp]], ms: 21, short });
        if (internalServer) return digOut({ cmd, name, server, ans: [[name, 300, "A", I.intIp]], ms: 4, short });
        return digOut({ cmd, name, server, status: "NXDOMAIN", auth: [soaPub], ms: 24, short });
      }
      if (name.endsWith(I.dom)) return digOut({ cmd, name, server, ans: [[name, 300, "A", internalServer ? I.intIp : I.pubIp]], ms: 9, short });
      return digOut({ cmd, name, server, ans: [[name, 300, "A", "93.184.215.14"]], ms: 12, short });
    };
    const sh = K.shell([
      { re: /^resolvectl( status)?$/, use: "resolvectl status", desc: "per-link DNS servers and routing domains", run: (m, st) => statusOut(st) },
      { re: /^cat \/etc\/resolv\.conf$/, use: "cat /etc/resolv.conf", desc: "", run: () => "# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch ." },
      { re: /^dig( .*)?$/, use: "dig [@server] <name> [type] [+short]", desc: "query DNS", run: (m, st, line) => {
        const o = digArgs(line); if (!o.name) return "usage: dig [@server] <name>";
        const server = o.server || (viaVpn(o.name, st) ? I.dnsIp : "192.168.1.1");
        const out = answer(o.name, server, st, line.slice(4), o.short);
        return o.server ? out : out.replace(new RegExp(`SERVER: ${server.replace(/\./g, "\\.")}#53\\(${server.replace(/\./g, "\\.")}\\)`), "SERVER: 127.0.0.53#53(127.0.0.53)");
      } },
      { re: /^nslookup (\S+)(?: (\S+))?$/, use: "nslookup <name> [server]", desc: "", run: (m, st) => {
        const name = m[1].toLowerCase(), server = m[2] || (viaVpn(name, st) ? I.dnsIp : "192.168.1.1");
        if (server === I.dnsIp && I.lv === 3) return ";; communications error to " + server + "#53: timed out\n;; no servers could be reached";
        const out = answer(name, server, st, name, true);
        return `Server:\t\t${m[2] || "127.0.0.53"}\nAddress:\t${m[2] || "127.0.0.53"}#53\n\n` + (out ? `Non-authoritative answer:\nName:\t${name}\nAddress: ${out}` : `** server can't find ${name}: NXDOMAIN`);
      } },
      { re: /^resolvectl query (\S+)$/, use: "resolvectl query <name>", desc: "resolve through systemd-resolved", run: (m, st) => {
        const n = m[1].toLowerCase(), vpn = viaVpn(n, st);
        if (vpn && I.lv === 3) return `${n}: resolve call failed: All attempts to contact name servers or networks failed`;
        const o = answer(n, vpn ? I.dnsIp : "192.168.1.1", st, n, true);
        return o ? `${n}: ${o}                      -- link: ${vpn ? "tun0" : "wlan0"}` : `${n}: resolve call failed: '${n}' not found`;
      } },
      { re: /^ip route get (\S+)$/, use: "ip route get <ip>", desc: "which interface a packet would use", run: (m) => {
        const ip = m[1];
        const tun = I.lv === 3 ? ip.startsWith("10.") && ip.split(".")[2] === "1" : ip.startsWith("10.");
        return tun ? `${ip} dev tun0 src 10.250.0.17 uid 1000\n    cache` : `${ip} via 192.168.1.1 dev wlan0 src 192.168.1.34 uid 1000\n    cache`;
      } },
      { re: /^ip route( show)?$/, use: "ip route", desc: "routing table", run: () => `default via 192.168.1.1 dev wlan0 proto dhcp metric 600\n${I.lv === 3 ? `10.${I.dnsIp.split(".")[1]}.1.0/24 dev tun0 scope link` : "10.0.0.0/8 dev tun0 scope link"}\n192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.34` },
      { re: /^ping (?:-c \d+ )?(\S+)$/, use: "ping -c 3 <host>", desc: "", run: (m) => /^[\d.]+$/.test(m[1]) || m[1] === I.name ? `PING ${m[1]}: 56 data bytes\n64 bytes from ${m[1]}: icmp_seq=1 ttl=62 time=21.4 ms\n64 bytes from ${m[1]}: icmp_seq=2 ttl=62 time=20.9 ms\n\n--- ${m[1]} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss` : `ping: ${m[1]}: Name or service not known` },
      { re: /^resolvectl domain (\S+) (.+)$/, use: "resolvectl domain <link> '~domain'", desc: "set routing domains for a link", run: (m, st) => {
        const dmn = m[2].replace(/['"]/g, "").trim();
        if (I.lv !== 1) return "";
        if (m[1] === "tun0" && (dmn === `~corp.${I.dom}` || dmn === `~${I.dom}` || dmn === `corp.${I.dom}`)) { st.routed = true; return ""; }
        if (m[1] === "tun0" && dmn === "~.") return { out: "", danger: "'~.' routes ALL DNS through the VPN, including personal browsing; full-tunnel DNS wasn't asked for and adds load and latency." };
        return "";
      } },
      { re: /^resolvectl dns (\S+) (\S+)$/, use: "resolvectl dns <link> <server>", desc: "set DNS servers for a link", run: (m) => m[1] === "wlan0" ? { out: "", danger: "You pointed the Wi-Fi link at the VPN resolver: everything breaks the moment the VPN disconnects." } : "" },
    ]);
    return {
      prompt: "eng@laptop:~$", init, run: (line, st) => sh.run(line, st), par: 6,
      motd: I.lv === 3 ? `VPN: connected (split tunnel)\n$ ping ${I.intIp}   # works` : "VPN: connected",
      cmds: ["resolvectl status", `dig ${I.name}`, `dig @${I.dnsIp} ${I.name}`, `dig @1.1.1.1 ${I.name}`, "ip route", `ip route get ${I.dnsIp}`, ...(I.lv === 1 ? ["resolvectl domain tun0 '~<domain>'"] : [])],
      ...(I.lv > 1 ? { opts: optsOf(I, {
        noroute: "The VPN link has no routing domain, so the query goes to the Wi-Fi resolver",
        dnsDown: "The internal DNS server is down",
        vpnDown: "The VPN tunnel isn't passing traffic",
        recordMissing: "The record was never created",
        shadow: `The internal server hosts its own copy of ${I.dom}, which lacks the new record`,
        pubMissing: "The public zone doesn't have the record yet",
        ttl: "An old cached answer hasn't expired yet",
        noRoute53: "The split-tunnel routes don't include the VPN resolver's IP, so DNS goes out via Wi-Fi",
        firewall: "A firewall on the VPN concentrator blocks port 53",
      }) } : {}),
    };
  }

  /* ================= TLS ================= */
  const INT = "C = US, O = Larkspur Trust, CN = Larkspur TLS RSA CA G2", ROOT = "C = US, O = Larkspur Trust, CN = Larkspur Root R1";
  const pem = (id) => `-----BEGIN CERTIFICATE-----\nMIIF${b64(id, 60)}\n${b64(id + "b", 64)}\n${b64(id + "c", 64)}\n...\n${b64(id + "d", 40)}==\n-----END CERTIFICATE-----`;
  const sclean = (line) => line.replace(/ ?<\s*\/dev\/null/g, "").replace(/ ?2>\s*\/dev\/null/g, "").replace(/ ?2>&1/g, "").replace(/\s+/g, " ").trim();

  function tlsChainShell(I) {
    const dir = "/etc/nginx/tls", P = (f) => (f.startsWith("/") ? f : dir + "/" + f);
    const subj = (id) => (id === "int" ? INT : id === "root" ? ROOT : `CN = ${id === "leaf:www" ? I.www : I.host}`);
    const iss = (id) => (id === "int" ? ROOT : id === "root" ? ROOT : INT);
    const files = {};
    files[P("api.key")] = { key: "api" };
    files[P("api.crt")] = { certs: ["leaf:api"] };
    if (I.lv === 1) { files[P("chain.pem")] = { certs: ["int"] }; files[P("fullchain.pem")] = { certs: ["leaf:api", "int"] }; }
    if (I.lv === 2) { files[P("intermediate.pem")] = { certs: ["int"] }; files[P("fullchain.pem")] = { certs: ["int", "leaf:api"] }; }
    if (I.lv === 3) { files[P("ca-bundle.crt")] = { certs: ["int"] }; files[P("www-fullchain.pem")] = { certs: ["leaf:www", "int"] }; files[P("www.key")] = { key: "www" }; }
    const block = (name, cert, key, def) => `server {\n    listen 443 ssl${def ? " default_server" : ""};\n    http2 on;\n    server_name ${name};\n\n    ssl_certificate     ${cert};\n    ssl_certificate_key ${key};\n\n    location / {\n        proxy_pass http://127.0.0.1:${def ? 8081 : 8080};\n    }\n}`;
    const conf = { "/etc/nginx/conf.d/api.conf": block(I.host, P("api.crt"), P("api.key"), false) };
    if (I.lv === 3) conf["/etc/nginx/conf.d/www.conf"] = block(I.www, P("www-fullchain.pem"), P("www.key"), true);
    const parse = (st) => Object.entries(st.conf).map(([f, t]) => ({ f, name: (t.match(/server_name\s+([^;\s]+)/) || [])[1], cert: (t.match(/ssl_certificate\s+([^;\s]+)/) || [])[1], key: (t.match(/ssl_certificate_key\s+([^;\s]+)/) || [])[1], def: /default_server/.test(t) }));
    const test = (st) => {
      for (const b of parse(st)) {
        const c = st.files[b.cert], k = st.files[b.key];
        if (!c || !c.certs) return `nginx: [emerg] cannot load certificate "${b.cert}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory:calling fopen(${b.cert}, r) error:10000080:BIO routines::no such file)`;
        if (!k || !k.key) return `nginx: [emerg] cannot load certificate key "${b.key}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory)`;
        const first = c.certs[0];
        if (first !== "leaf:" + k.key) return `nginx: [emerg] SSL_CTX_use_PrivateKey("${b.key}") failed (SSL: error:05800074:x509 certificate routines::key values mismatch)`;
      }
      return null;
    };
    const liveOf = (st) => Object.fromEntries(parse(st).map((b) => [b.name, { certs: st.files[b.cert].certs.slice(), def: b.def }]));
    const init = { files, conf, live: null, down: false };
    init.live = liveOf(init);
    const served = (st, sni) => { const L = st.live; if (sni && L[sni]) return L[sni].certs; const d = Object.values(L).find((x) => x.def) || Object.values(L)[0]; return d.certs; };
    const complete = (certs) => /^leaf/.test(certs[0]) && certs.includes("int");
    const sclient = (st, line) => {
      const l = sclean(line);
      const m = l.match(/-connect (\S+?):(\d+)/); if (!m) return "s_client: Use -help for summary.";
      if (st.down) return `${m[1]}:${m[2]}: Connection refused\nconnect:errno=111`;
      const sn = (l.match(/-servername (\S+)/) || [])[1];
      const isIp = /^[\d.]+$/.test(m[1]);
      const sni = /-noservername/.test(l) ? null : sn || (isIp ? null : m[1]);
      const certs = served(st, sni);
      const ok = complete(certs);
      const depth = ok ? `depth=2 ${ROOT}\nverify return:1\ndepth=1 ${INT}\nverify return:1\ndepth=0 ${subj(certs[0])}\nverify return:1` : `depth=0 ${subj(certs[0])}\nverify error:num=20:unable to get local issuer certificate\nverify return:1\ndepth=0 ${subj(certs[0])}\nverify error:num=21:unable to verify the first certificate\nverify return:1`;
      const chain = certs.map((c, i) => ` ${i} s:${subj(c)}\n   i:${iss(c)}\n   a:PKEY: rsaEncryption, 2048 (bit); sigalg: RSA-SHA256\n   v:NotBefore: Sep 14 00:00:00 2026 GMT; NotAfter: Dec 13 23:59:59 2026 GMT${/-showcerts/.test(l) ? "\n" + pem(c) : ""}`).join("\n");
      return `CONNECTED(00000003)\n${depth}\n---\nCertificate chain\n${chain}\n---\nServer certificate\nsubject=${subj(certs[0])}\nissuer=${iss(certs[0])}\n---\nNo client certificate CA names sent\nPeer signing digest: SHA256\n---\nSSL handshake has read ${2400 + certs.length * 1400} bytes and written 403 bytes\nVerification${ok ? "" : " error"}: ${ok ? "OK" : "unable to verify the first certificate"}\n---\nNew, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384\nServer public key is 2048 bit\nVerify return code: ${ok ? "0 (ok)" : "21 (unable to verify the first certificate)"}\n---\nDONE`;
    };
    const curl = (st, line) => {
      const m = line.match(/https:\/\/([^/\s:]+)/); if (!m) return "curl: (3) URL rejected: No host part in the URL";
      const h = m[1];
      if (st.down) return `*   Trying ${I.ip}:443...\n* connect to ${I.ip} port 443 failed: Connection refused\ncurl: (7) Failed to connect to ${h} port 443 after 2 ms: Couldn't connect to server`;
      const certs = served(st, h);
      const head = `*   Trying ${I.ip}:443...\n* Connected to ${h} (${I.ip}) port 443\n* ALPN: curl offers h2,http/1.1\n* TLSv1.3 (OUT), TLS handshake, Client hello (1):\n* TLSv1.3 (IN), TLS handshake, Server hello (2):\n* TLSv1.3 (IN), TLS handshake, Encrypted Extensions (8):\n* TLSv1.3 (IN), TLS handshake, Certificate (11):`;
      if (!complete(certs)) return `${head}\n* TLSv1.3 (OUT), TLS alert, unknown CA (560):\n* SSL certificate problem: unable to get local issuer certificate\n* Closing connection\ncurl: (60) SSL certificate problem: unable to get local issuer certificate\nMore details here: https://curl.se/docs/sslcerts.html`;
      const cn = subj(certs[0]).slice(5);
      if (cn !== h) return `${head}\n* TLSv1.3 (IN), TLS handshake, CERT verify (15):\n* TLSv1.3 (IN), TLS handshake, Finished (20):\n* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384\n* Server certificate:\n*  subject: CN=${cn}\n*  subjectAltName does not match ${h}\n* SSL: no alternative certificate subject name matches target host name '${h}'\ncurl: (60) SSL: no alternative certificate subject name matches target host name '${h}'`;
      return `${head}\n* TLSv1.3 (IN), TLS handshake, CERT verify (15):\n* TLSv1.3 (IN), TLS handshake, Finished (20):\n* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384\n* ALPN: server accepted h2\n* Server certificate:\n*  subject: CN=${cn}\n*  issuer: C=US; O=Larkspur Trust; CN=Larkspur TLS RSA CA G2\n*  SSL certificate verify ok.\n> GET / HTTP/2\n> Host: ${h}\n< HTTP/2 200\n< content-type: application/json\n{"status":"ok"}`;
    };
    const sh = K.shell([
      { re: /^ls(?: -\w+)*(?: (\S+))?$/, use: "ls -l [dir]", desc: "list files", run: (m, st) => {
        const d = (m[1] || dir).replace(/\/$/, "");
        if (d === "/etc/nginx/conf.d") return Object.keys(st.conf).map((f) => `-rw-r--r-- 1 root root  ${st.conf[f].length} Oct  2 11:20 ${f.split("/").pop()}`).join("\n");
        if (d !== dir) return `ls: cannot access '${d}': No such file or directory`;
        return Object.keys(st.files).sort().map((f) => { const x = st.files[f]; return `-rw-${x.key ? "------" : "r--r--"} 1 root root ${String(x.key ? 1704 : x.certs.length * 2155).padStart(5)} Oct  2 11:18 ${f.split("/").pop()}`; }).join("\n");
      } },
      { re: /^cat (\S+)$/, use: "cat <file>", desc: "", run: (m, st) => { const f = m[1].startsWith("/etc/nginx/conf.d") || !m[1].includes("/") && st.conf["/etc/nginx/conf.d/" + m[1]] ? (m[1].includes("/") ? m[1] : "/etc/nginx/conf.d/" + m[1]) : P(m[1]); if (st.conf[f]) return st.conf[f]; const x = st.files[f]; if (!x) return `cat: ${m[1]}: No such file or directory`; return x.key ? "cat: " + m[1] + ": Permission denied" : x.certs.map(pem).join("\n"); } },
      { re: /^openssl x509 .*-in (\S+).*$/, use: "openssl x509 -in <file> -noout -subject -issuer -enddate", desc: "first certificate in a file", run: (m, st) => { const x = st.files[P(m[1])]; if (!x || !x.certs) return `Could not open file or uri for loading certificate from ${m[1]}`; const c = x.certs[0]; return `subject=${subj(c)}\nissuer=${iss(c)}\nnotAfter=${c === "int" ? "Mar 12 23:59:59 2030 GMT" : "Dec 13 23:59:59 2026 GMT"}`; } },
      { re: /^grep -c (?:BEGIN|'BEGIN CERTIFICATE'|"BEGIN CERTIFICATE") (\S+)$/, use: "grep -c BEGIN <file>", desc: "count certificates in a file", run: (m, st) => { const x = st.files[P(m[1])]; return x ? String(x.certs ? x.certs.length : 1) : `grep: ${m[1]}: No such file or directory`; } },
      { re: /^openssl crl2pkcs7 -nocrl -certfile (\S+) \| openssl pkcs7 -print_certs -noout$/, use: "openssl crl2pkcs7 -nocrl -certfile <file> | openssl pkcs7 -print_certs -noout", desc: "every certificate in a file, in order", run: (m, st) => { const x = st.files[P(m[1])]; if (!x || !x.certs) return "unable to load certificates"; return x.certs.map((c) => `subject=${subj(c)}\nissuer=${iss(c)}\n`).join("\n"); } },
      { re: /^openssl s_client .*$/, use: "openssl s_client -connect <host|ip>:443 [-servername <name>] [-showcerts]", desc: "what the server actually sends", run: (m, st, line) => sclient(st, line) },
      { re: /^curl .*https:\/\/.*$/, use: "curl -v https://<host>/", desc: "", run: (m, st, line) => curl(st, line) },
      { re: /^(?:sudo )?cat (\S+(?: \S+)+) > (\S+)$/, use: "cat <a> <b> > <out>", desc: "concatenate files", run: (m, st) => { const srcs = m[1].split(" ").map(P); const certs = []; for (const s of srcs) { const x = st.files[s]; if (!x) return `cat: ${s}: No such file or directory`; if (x.key) return { out: "", danger: "You wrote a private key into a certificate file that nginx serves to every client." }; certs.push(...x.certs); } st.files[P(m[2])] = { certs }; return ""; } },
      { re: /^(?:sudo )?cp (\S+) (\S+)$/, use: "cp <src> <dst>", desc: "", run: (m, st) => { const x = st.files[P(m[1])]; if (!x) return `cp: cannot stat '${m[1]}': No such file or directory`; st.files[P(m[2])] = K.clone(x); return ""; } },
      { re: /^(?:sudo )?sed -i(?:\.bak)? (['"]?)s(.)(.+?)\2(.*?)\2g?\1 (\S+)$/, use: "sed -i 's#old#new#' <conf>", desc: "edit a config file", run: (m, st) => { const f = m[5].includes("/") ? m[5] : "/etc/nginx/conf.d/" + m[5]; if (!st.conf[f]) return `sed: can't read ${m[5]}: No such file or directory`; if (!st.conf[f].includes(m[3])) return ""; st.conf[f] = st.conf[f].split(m[3]).join(m[4]); return ""; } },
      { re: /^(?:sudo )?nginx -t$/, use: "nginx -t", desc: "test the configuration", run: (m, st) => { const e = test(st); return e ? `${e}\nnginx: configuration file /etc/nginx/nginx.conf test failed` : "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful"; } },
      { re: /^(?:sudo )?(?:systemctl reload nginx|nginx -s reload)$/, use: "systemctl reload nginx", desc: "graceful reload", run: (m, st) => { if (st.down) return "nginx.service is not active, cannot reload."; const e = test(st); if (e) return "Job for nginx.service failed because the control process exited with error code.\nSee \"systemctl status nginx.service\" and \"journalctl -xeu nginx.service\" for details.\n(the old configuration keeps running)"; st.live = liveOf(st); return ""; } },
      { re: /^(?:sudo )?systemctl restart nginx$/, use: "systemctl restart nginx", desc: "", run: (m, st) => { const e = test(st); if (e) { st.down = true; return { out: "Job for nginx.service failed because the control process exited with error code.", danger: "Restarting with a broken config took nginx down for everyone. Run nginx -t first, and prefer reload." }; } st.live = liveOf(st); st.down = false; return { out: "", danger: "A restart drops every open connection; a reload swaps the certificate gracefully." }; } },
    ]);
    return {
      prompt: `root@edge-1:${dir}#`, init, run: (line, st) => sh.run(line, st), par: I.lv === 1 ? 7 : 9,
      motd: `Ticket: partner integration to https://${I.host} fails:\n  PKIX path building failed: sun.security.provider.certpath.SunCertPathBuilderException:\n  unable to find valid certification path to requested target\nChrome and Firefox load the site fine.${I.lv === 3 ? `\nedge-1 (${I.ip}) serves ${I.www} and ${I.host}.` : ""}`,
      cmds: [I.lv === 3 ? `openssl s_client -connect ${I.ip}:443` : `openssl s_client -connect ${I.host}:443`, `curl -v https://${I.host}/`, "ls -l", "cat /etc/nginx/conf.d/api.conf", "openssl crl2pkcs7 -nocrl -certfile <file> | openssl pkcs7 -print_certs -noout", "sed -i 's#<old>#<new>#' /etc/nginx/conf.d/api.conf", "nginx -t", "systemctl reload nginx"],
    };
  }

  function tlsExpiredShell(I) {
    const le = `/etc/letsencrypt/live/${I.host}`;
    const init = { stale: I.lv === 1 ? [I.ip] : I.lv === 2 ? [I.bad] : [], n: 0 };
    const dates = (fresh) => fresh ? `notBefore=Sep 12 08:14:31 2026 GMT\nnotAfter=Dec 11 08:14:30 2026 GMT` : I.lv === 3 ? `notBefore=Jul 16 06:02:10 2026 GMT\nnotAfter=Oct 14 06:02:09 2026 GMT` : `notBefore=Jul 12 08:20:02 2026 GMT\nnotAfter=Oct 10 08:20:01 2026 GMT`;
    const backendOf = (st, ip) => (ip === I.host || ip === I.ip ? (I.lv === 2 ? I.backs[st.n++ % 3] : I.ip) : ip);
    const dryRun = `Saving debug log to /var/log/letsencrypt/letsencrypt.log\nProcessing /etc/letsencrypt/renewal/${I.host}.conf\nSimulating renewal of an existing certificate for ${I.host}\n\nCertbot failed to authenticate some domains (authenticator: webroot). The Certificate Authority reported these problems:\n  Domain: ${I.host}\n  Type:   unauthorized\n  Detail: ${I.ip}: Invalid response from http://${I.host}/.well-known/acme-challenge/${b64(I.host, 43).replace(/[+/]/g, "_")}: 403\n\nHint: The Certificate Authority failed to download the temporary challenge files created by Certbot. Ensure that the listed domains serve their content from the provided --webroot-path/-w and that files created there can be downloaded from the internet.\n\nFailed to renew certificate ${I.host} with error: Some challenges have failed.`;
    const shopConf = `server {\n    listen 80;\n    server_name ${I.host};\n\n    # security hardening (PR #${I.pr}, merged ${I.prDate})\n    location ~ /\\. {\n        deny all;\n    }\n\n    location /.well-known/acme-challenge/ {\n        root /var/www/certbot;\n    }\n\n    location / {\n        return 301 https://$host$request_uri;\n    }\n}`;
    const sh = K.shell([
      { re: /^(?:echo \| )?openssl s_client (.*)$/, use: "openssl s_client -connect <host|ip>:443 -servername <host> | openssl x509 -noout -dates", desc: "dates of the certificate actually served", run: (m, st, line) => {
        const l = sclean(line); const c = l.match(/-connect (\S+?):443/); if (!c) return "s_client: Use -help for summary.";
        const ip = backendOf(st, c[1]);
        if (I.lv === 2 && !I.backs.includes(ip) && ip !== I.host) return `connect: Connection timed out`;
        const fresh = !st.stale.includes(ip) && I.lv !== 3;
        if (/\| openssl x509/.test(l)) return dates(fresh) + (I.lv === 2 && (c[1] === I.host) ? `\n(answered by backend ${ip})` : "");
        return `CONNECTED(00000003)\ndepth=0 CN = ${I.host}\n${fresh || I.lv === 3 ? "verify return:1" : "verify error:num=10:certificate has expired\nnotAfter=Oct 10 08:20:01 2026 GMT\nverify return:1"}\n---\nServer certificate\nsubject=CN = ${I.host}\nissuer=C = US, O = Let's Encrypt, CN = R11\n---\nVerify return code: ${fresh || I.lv === 3 ? "0 (ok)" : "10 (certificate has expired)"}`;
      } },
      { re: /^openssl x509 .*-in (\S+).*$/, use: `openssl x509 -in ${le}/fullchain.pem -noout -dates`, desc: "dates of the certificate on disk", run: (m) => m[1].includes(I.host) ? dates(I.lv !== 3) : `Could not open file or uri for loading certificate from ${m[1]}` },
      { re: /^(?:sudo )?certbot certificates$/, use: "certbot certificates", desc: "", run: () => `Found the following certs:\n  Certificate Name: ${I.host}\n    Serial Number: 4f1c${b64(I.host, 8).toLowerCase().replace(/[^a-f0-9]/g, "a")}\n    Key Type: ECDSA\n    Domains: ${I.host}\n    Expiry Date: ${I.lv === 3 ? "2026-10-14 06:02:09+00:00 (VALID: 2 days)" : "2026-12-11 08:14:30+00:00 (VALID: 60 days)"}\n    Certificate Path: ${le}/fullchain.pem\n    Private Key Path: ${le}/privkey.pem` },
      { re: /^(?:sudo )?systemctl status nginx$/, use: "systemctl status nginx", desc: "", run: () => `● nginx.service - A high performance web server and a reverse proxy server\n     Loaded: loaded (/lib/systemd/system/nginx.service; enabled; preset: enabled)\n     Active: active (running) since Thu 2026-07-09 03:12:44 UTC; 3 months 1 day ago\n   Main PID: 912 (nginx)` },
      { re: /^(?:sudo )?systemctl list-timers.*$/, use: "systemctl list-timers", desc: "", run: () => `NEXT                        LEFT     LAST                        PASSED  UNIT          ACTIVATES\nSun 2026-10-11 21:41:00 UTC 12h left Sun 2026-10-11 09:41:00 UTC 13min ago certbot.timer certbot.service` },
      { re: /^(?:sudo )?(?:journalctl -u certbot.*|tail .*letsencrypt\.log|cat \/var\/log\/letsencrypt\/letsencrypt\.log)$/, use: "journalctl -u certbot --since today", desc: "renewal logs", run: () => I.lv === 3 ? `Oct 11 09:41:03 web-1 certbot[22817]: Failed to renew certificate ${I.host} with error: Some challenges have failed.\nOct 11 09:41:03 web-1 certbot[22817]: All renewals failed. The following certificates could not be renewed:\nOct 11 09:41:03 web-1 certbot[22817]:   ${le}/fullchain.pem (failure)\nOct 11 09:41:03 web-1 systemd[1]: certbot.service: Main process exited, code=exited, status=1/FAILURE` : `Sep 12 08:14:33 web-1 certbot[1771]: Congratulations, all renewals succeeded:\nSep 12 08:14:33 web-1 certbot[1771]:   ${le}/fullchain.pem (success)` },
      { re: /^(?:sudo )?certbot renew --dry-run$/, use: "certbot renew --dry-run", desc: "", run: () => I.lv === 3 ? dryRun : `Simulating renewal of an existing certificate for ${I.host}\nCongratulations, all simulated renewals succeeded:\n  ${le}/fullchain.pem (success)` },
      { re: /^(?:sudo )?certbot renew --force-renewal$/, use: "", hidden: true, desc: "", run: () => ({ out: I.lv === 3 ? dryRun.replace("Simulating renewal of", "Renewing") : "Renewing an existing certificate for " + I.host, danger: "Forced renewals burn the CA's duplicate-certificate rate limit and don't fix the cause." }) },
      { re: /^dig .*caa.*$/i, use: `dig CAA ${I.dom} +short`, desc: "", run: () => `0 issue "letsencrypt.org"` },
      { re: /^curl .*http:\/\/\S*\.well-known\/acme-challenge\/\S*$/, use: `curl -I http://${I.host}/.well-known/acme-challenge/test`, desc: "", run: () => I.lv === 3 ? `HTTP/1.1 403 Forbidden\nServer: nginx\nContent-Type: text/html\nContent-Length: 153` : "HTTP/1.1 404 Not Found\nServer: nginx" },
      { re: /^cat \/etc\/nginx\/(?:conf\.d|sites-enabled)\/\S+$/, use: `cat /etc/nginx/conf.d/${I.host}.conf`, desc: "", run: () => shopConf },
      { re: /^curl .*https:\/\/.*$/, use: `curl -v https://${I.host}/`, desc: "", run: (m, st) => { const ip = backendOf(st, I.host); return st.stale.includes(ip) ? `* SSL certificate problem: certificate has expired\ncurl: (60) SSL certificate problem: certificate has expired` : `* SSL certificate verify ok.\n< HTTP/2 200` + (I.lv === 2 ? `\n< x-served-by: ${ip}` : ""); } },
      { re: /^(?:sudo )?(?:systemctl reload nginx|nginx -s reload)$/, use: "systemctl reload nginx", desc: "", run: (m, st) => { if (I.lv === 2) return "(this is the jump host; nginx runs on the backends)"; st.stale = []; return ""; } },
      { re: /^(?:sudo )?nginx -t$/, use: "nginx -t", desc: "", run: () => "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful" },
      { re: /^ssh (\S+) (?:sudo )?(?:systemctl (reload|restart) nginx|nginx -s reload)$/, use: "ssh <ip> sudo systemctl reload nginx", desc: "", run: (m, st) => { if (!I.backs || !I.backs.includes(m[1])) return `ssh: connect to host ${m[1]} port 22: No route to host`; st.stale = st.stale.filter((x) => x !== m[1]); return m[2] === "restart" ? { out: "", danger: "restart drops in-flight connections; reload picks up the new certificate gracefully" } : ""; } },
      { re: /^ssh (\S+) .*$/, use: "", hidden: true, desc: "", run: (m) => (I.backs && I.backs.includes(m[1]) ? "(try: ssh <ip> sudo systemctl reload nginx)" : `ssh: connect to host ${m[1]} port 22: No route to host`) },
    ]);
    return {
      prompt: I.lv === 2 ? "ops@jump-1:~$" : "root@web-1:~#", init, run: (line, st) => sh.run(line, st), par: I.lv === 2 ? 9 : 6,
      motd: I.lv === 1 ? `ALERT ssl_cert_expired ${I.host}: certificate expired Oct 10 08:20 UTC\nSupport: customers see NET::ERR_CERT_DATE_INVALID` : I.lv === 2 ? `ALERT ${I.host}: ~1 in 3 health probes fail with "certificate has expired"\nBackends behind the LB: ${I.backs.join(", ")}` : `WARN ssl_cert_expiry ${I.host}: certificate expires in 2 days (Oct 14)\ncertbot.timer runs twice a day`,
      cmds: I.lv === 2 ? [`openssl s_client -connect ${I.host}:443 -servername ${I.host} | openssl x509 -noout -dates`, `openssl s_client -connect <ip>:443 -servername ${I.host} | openssl x509 -noout -dates`, "ssh <ip> sudo systemctl reload nginx"]
        : I.lv === 1 ? [`openssl s_client -connect ${I.host}:443 -servername ${I.host} | openssl x509 -noout -dates`, `openssl x509 -in ${le}/fullchain.pem -noout -dates`, "certbot certificates", "systemctl status nginx", "nginx -t", "systemctl reload nginx"]
          : ["certbot certificates", "systemctl list-timers", "journalctl -u certbot --since today", "certbot renew --dry-run", `dig CAA ${I.dom} +short`, `curl -I http://${I.host}/.well-known/acme-challenge/test`, `cat /etc/nginx/conf.d/${I.host}.conf`],
      ...(I.lv === 3 ? { opts: optsOf(I, {
        dotfiles: "The new 'deny dotfiles' regex location also matches /.well-known/, so the HTTP-01 challenge gets 403",
        caa: "A CAA record forbids this CA from issuing for the domain",
        port80: "Port 80 is closed, so the CA can't reach the challenge",
        ratelimit: "The CA is rate-limiting renewals for this domain",
        timer: "The certbot timer isn't running",
      }) } : {}),
    };
  }

  function mtlsShell(I) {
    const issuer = I.lv === 1 ? "Internal Issuing CA 2024" : "Internal Issuing CA 2026";
    const acceptable = I.lv === 3 ? ["O = Pebble Internal, CN = Internal Root CA"] : ["O = Pebble Internal, CN = Internal Issuing CA 2024"];
    const err = I.lv === 1 ? "error:0A000415:SSL routines::sslv3 alert certificate expired" : "error:0A000418:SSL routines::tlsv1 alert unknown ca";
    const after = I.lv === 1 ? "Oct  9 12:00:00 2026 GMT" : "Oct 16 12:00:00 2026 GMT";
    const sh = K.shell([
      { re: /^curl .*ledger.*$/, use: `curl -v --cert /etc/tls/client.crt --key /etc/tls/client.key --cacert /etc/tls/ca.crt https://${I.svc}:8443/health`, desc: "", run: (m, st, line) => {
        const head = `*   Trying 10.40.3.17:8443...\n* Connected to ${I.svc} (10.40.3.17) port 8443\n* TLSv1.3 (OUT), TLS handshake, Client hello (1):\n* TLSv1.3 (IN), TLS handshake, Server hello (2):\n* TLSv1.3 (IN), TLS handshake, Request CERT (13):\n* TLSv1.3 (IN), TLS handshake, Certificate (11):\n* TLSv1.3 (IN), TLS handshake, CERT verify (15):\n* TLSv1.3 (IN), TLS handshake, Finished (20):\n* TLSv1.3 (OUT), TLS handshake, Certificate (11):\n* TLSv1.3 (OUT), TLS handshake, CERT verify (15):\n* TLSv1.3 (OUT), TLS handshake, Finished (20):\n* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384\n* Server certificate:\n*  subject: CN=${I.svc}\n*  SSL certificate verify ok.\n> GET /health HTTP/1.1`;
        if (!/--cert/.test(line)) return head.replace(/\n\* TLSv1\.3 \(OUT\), TLS handshake, CERT verify \(15\):/, "") + `\n* OpenSSL SSL_read: OpenSSL/3.0.13: error:0A00045C:SSL routines::tlsv13 alert certificate required, errno 0\ncurl: (56) OpenSSL SSL_read: error:0A00045C:SSL routines::tlsv13 alert certificate required, errno 0`;
        return `${head}\n* OpenSSL SSL_read: OpenSSL/3.0.13: ${err}, errno 0\ncurl: (56) OpenSSL SSL_read: ${err}, errno 0`;
      } },
      { re: /^openssl x509 .*-in (\S+).*$/, use: "openssl x509 -in /etc/tls/client.crt -noout -subject -issuer -dates", desc: "", run: (m) => /client/.test(m[1]) ? `subject=O = Pebble Internal, CN = ${I.me}\nissuer=O = Pebble Internal, CN = ${issuer}\nnotBefore=${I.lv === 1 ? "Oct  9 12:00:00 2025 GMT" : "Oct  1 12:00:00 2026 GMT"}\nnotAfter=${I.lv === 1 ? after : "Oct  1 12:00:00 2027 GMT"}` : /ca\.crt/.test(m[1]) ? "subject=O = Pebble Internal, CN = Internal Root CA\nissuer=O = Pebble Internal, CN = Internal Root CA\nnotAfter=Jan  1 00:00:00 2035 GMT" : `Could not open file or uri for loading certificate from ${m[1]}` },
      { re: /^grep -c \S+ (\S+)$/, use: "grep -c BEGIN /etc/tls/client.crt", desc: "", run: (m) => /client\.crt/.test(m[1]) ? "1" : /ca\.crt/.test(m[1]) ? "1" : `grep: ${m[1]}: No such file or directory` },
      { re: /^ls(?: -\w+)*(?: \/etc\/tls\/?)?$/, use: "ls -l /etc/tls", desc: "", run: () => `-rw-r--r-- 1 app app 1310 Oct  1 12:04 ca.crt\n-rw-r--r-- 1 app app 1188 Oct  1 12:04 client.crt\n-rw------- 1 app app  241 Oct  1 12:04 client.key` },
      { re: /^openssl s_client .*$/, use: `openssl s_client -connect ${I.svc}:8443 -cert /etc/tls/client.crt -key /etc/tls/client.key`, desc: "handshake details, incl. the CAs the server accepts", run: () => `CONNECTED(00000003)\ndepth=1 O = Pebble Internal, CN = Internal Root CA\nverify return:1\ndepth=0 CN = ${I.svc}\nverify return:1\n---\nAcceptable client certificate CA names\n${acceptable.join("\n")}\nRequested Signature Algorithms: ECDSA+SHA256:RSA-PSS+SHA256:RSA+SHA256\n---\nSSL handshake has read 2133 bytes and written 2018 bytes\nVerification: OK\n---\nNew, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384\n${err.replace(/^error:\w+:/, "")}\n---` },
      { re: /^date$/, use: "date", desc: "", run: () => "Sun Oct 11 09:14:02 UTC 2026" },
      { re: /^kubectl logs .*$/, use: `kubectl logs deploy/${I.svcShort} --tail=3`, desc: "server-side log (read-only access)", run: () => I.lv === 1 ? `[2026-10-11T09:13:58Z] tls: client certificate rejected: x509: certificate has expired or is not yet valid (peer ${I.me})` : `[2026-10-11T09:13:58Z] tls: failed to verify client certificate: x509: certificate signed by unknown authority (peer ${I.me})` },
    ]);
    return {
      prompt: `app@${I.me}-7f9c:/$`, init: {}, run: (line, st) => sh.run(line, st), par: 6,
      motd: `${I.me} → ${I.svc}:8443 (mutual TLS) failing since ${I.lv === 1 ? "Friday 12:00" : "this morning's deploy of " + I.me}\n${I.lv >= 2 ? `Security rotated ${I.me}'s client certificate yesterday.` : ""}`.trim(),
      cmds: [`curl -v --cert /etc/tls/client.crt --key /etc/tls/client.key --cacert /etc/tls/ca.crt https://${I.svc}:8443/health`, "openssl x509 -in /etc/tls/client.crt -noout -subject -issuer -dates", "grep -c BEGIN /etc/tls/client.crt", `openssl s_client -connect ${I.svc}:8443 -cert /etc/tls/client.crt -key /etc/tls/client.key`, "date", `kubectl logs deploy/${I.svcShort} --tail=3`],
      opts: optsOf(I, {
        expired: "The client certificate has expired",
        untrusted: "The server doesn't trust the CA that issued the new client certificate",
        nochain: "The client sends only its leaf certificate, without the intermediate the server needs to build a path to its trusted root",
        nocert: "The client isn't sending a certificate at all",
        servername: "The server certificate doesn't match the hostname",
        serverexp: "The server's certificate has expired",
      }),
    };
  }

  // TLS policy model
  const TLSV = ["1.0", "1.1", "1.2", "1.3"];
  const CIPH = ["AEAD + ECDHE only", "+ ECDHE-CBC", "+ RSA key exchange"];
  function tlsClients(I) {
    const c = [
      { n: "Browsers", share: 0.68, v: ["1.2", "1.3"], need: 0 },
      { n: "Mobile apps (iOS/Android)", share: 0.22, v: ["1.2", "1.3"], need: 0 },
      { n: "Partner settlement batch (Java, TLS 1.2 only)", share: 0.02, v: ["1.2"], need: 0 },
    ];
    if (I.lv >= 2) c.push({ n: "Payment terminals (TLS 1.0, AES128-SHA)", share: 0.05, v: ["1.0"], need: 2, legacyOk: true });
    if (I.lv >= 3) c.push({ n: "Cloud uptime probe (TLS 1.2, ECDHE-RSA-AES128-SHA only)", share: 0.01, v: ["1.2"], need: 1 });
    return c;
  }
  function tlsEval(I, cfg) {
    const minI = TLSV.indexOf(cfg.min), ci = CIPH.indexOf(cfg.ciphers), legacy = cfg.legacy && cfg.legacy !== "none";
    return tlsClients(I).map((c) => {
      const main = c.v.some((v) => TLSV.indexOf(v) >= minI) && (c.need <= ci || c.v.includes("1.3"));
      const ok = main || (legacy && c.legacyOk);
      return { ...c, ok, via: main ? "main" : ok ? "legacy host" : "" };
    });
  }
  const tlsValid = (I, cfg) => {
    if (TLSV.indexOf(cfg.min) < 2) return "the compliance scan fails: TLS 1.0/1.1 must be disabled on the public endpoint";
    if (I.lv === 3 && cfg.ciphers === CIPH[2]) return "the security policy requires forward secrecy on the public endpoint (no RSA key exchange)";
    const lost = tlsEval(I, cfg).filter((c) => !c.ok);
    if (lost.length) return `${lost.map((c) => c.n).join(", ")} can no longer connect`;
    return true;
  };

  // CA rotation model
  function rotLanes(I) {
    const S = [], C = [], B = [];
    if (I.lv === 1) {
      S.push({ t: "Add CA-2026 to ledger's client-CA trust bundle (keep CA-2024), reload", op: (s) => s.sTrust.push(26) });
      S.push({ t: "Remove CA-2024 from ledger's trust bundle, reload", op: (s) => (s.sTrust = s.sTrust.filter((x) => x !== 24)) });
      C.push({ t: "Roll out client certificates issued by CA-2026 to all 14 services", op: (s) => (s.cCert = 26) });
      return [{ name: "Server (ledger)", steps: S }, { name: "Clients", steps: C }];
    }
    S.push({ t: "Add CA-2026 to ledger's client-CA trust bundle, reload", op: (s) => s.sTrust.push(26) });
    S.push({ t: "Switch ledger's serving certificate to one issued by CA-2026", op: (s) => (s.sCert = 26) });
    S.push({ t: "Remove CA-2024 from ledger's client-CA trust bundle", op: (s) => (s.sTrust = s.sTrust.filter((x) => x !== 24)) });
    C.push({ t: "Add CA-2026 to every client's server-CA bundle", op: (s) => s.cTrust.push(26) });
    C.push({ t: "Switch client certificates to CA-2026", op: (s) => (s.cCert = 26) });
    C.push({ t: "Remove CA-2024 from clients' server-CA bundle", op: (s) => (s.cTrust = s.cTrust.filter((x) => x !== 24)) });
    const lanes = [{ name: "Server (ledger)", steps: S }, { name: "Online clients", steps: C }];
    if (I.lv === 3) { B.push({ t: "Ship the weekly batch image with a CA-2026 cert and both CAs in its bundle", op: (s) => { s.bCert = 26; s.bTrust = [24, 26]; } }); lanes.push({ name: "Weekly batch job", steps: B }); }
    return lanes;
  }
  function rotRun(I, seq) {
    const lanes = rotLanes(I), s = { sTrust: [24], sCert: 24, cTrust: [24], cCert: 24, bTrust: [24], bCert: 24 }, pos = lanes.map(() => 0), log = [];
    let broken = null;
    for (const l of seq) {
      const st = lanes[l].steps[pos[l]++];
      if (!st) break;
      st.op(s);
      const issues = [];
      if (!s.sTrust.includes(s.cCert)) issues.push("online clients rejected (unknown ca)");
      if (I.lv > 1 && !s.cTrust.includes(s.sCert)) issues.push("clients reject ledger's certificate");
      if (I.lv === 3 && !s.sTrust.includes(s.bCert)) issues.push("batch job rejected");
      if (I.lv === 3 && !s.bTrust.includes(s.sCert)) issues.push("batch job rejects ledger's certificate");
      log.push({ l, t: st.t, issues });
      if (issues.length && broken == null) broken = log.length - 1;
    }
    return { log, broken, complete: seq.length === lanes.reduce((a, x) => a + x.steps.length, 0), lanes };
  }

  LB.addAll("net", [
    {
      id: "net-tls-chain",
      name: "Works in Chrome, fails in Java",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        const dom = R.pick(DOMS);
        return { lv, dom, host: R.pick(["api", "partners", "gateway"]) + "." + dom, www: "www." + dom, ip: `203.0.113.${R.int(10, 250)}` };
      },
      text: (I) => `<p>A partner's Java client can't connect to <code>${esc(I.host)}</code>; browsers are fine. The certificate was renewed on this nginx box last week${I.lv === 3 ? `, which also serves <code>${esc(I.www)}</code> on the same IP` : ""}.</p><p>Find what the server actually sends, fix it, and apply the change <b>without dropping live connections</b>. Type <code>help</code> to see what this sandbox supports.</p>`,
      ...LB.term({
        shell: (I) => tlsChainShell(I),
        goal(st, I) {
          if (st.down) return "nginx is down.";
          const c = st.live[I.host];
          if (c && c.certs[0] !== "leaf:api") return `<code>${esc(I.host)}</code> now serves a certificate for a different name: every client gets a hostname mismatch.`;
          if (!c || !c.certs.includes("int")) return `<code>${esc(I.host)}</code> still serves an incomplete chain (check with <code>openssl s_client -connect ${esc(I.host)}:443</code>).`;
          if (I.lv === 3) { const w = st.live[I.www]; if (!w || w.certs[0] !== "leaf:www" || !w.certs.includes("int")) return `You broke <code>${esc(I.www)}</code>.`; }
          return true;
        },
        solve: (I) => ({ log: I.lv === 1 ? [`openssl s_client -connect ${I.host}:443`, "ls -l", "sed -i 's#api.crt#fullchain.pem#' /etc/nginx/conf.d/api.conf", "nginx -t", "systemctl reload nginx"]
          : I.lv === 2 ? [`openssl s_client -connect ${I.host}:443`, "ls -l", "openssl crl2pkcs7 -nocrl -certfile fullchain.pem | openssl pkcs7 -print_certs -noout", "cat api.crt intermediate.pem > api-fullchain.pem", "sed -i 's#api.crt#api-fullchain.pem#' /etc/nginx/conf.d/api.conf", "nginx -t", "systemctl reload nginx"]
            : [`openssl s_client -connect ${I.host}:443`, "cat /etc/nginx/conf.d/api.conf", "cat api.crt ca-bundle.crt > api-fullchain.pem", "sed -i 's#api.crt#api-fullchain.pem#' /etc/nginx/conf.d/api.conf", "nginx -t", "systemctl reload nginx"] }),
      }),
      bad: (I) => [
        { log: ["systemctl reload nginx"] },
        { log: I.lv === 2 ? ["sed -i 's#api.crt#fullchain.pem#' /etc/nginx/conf.d/api.conf", "systemctl reload nginx"] : I.lv === 3 ? ["sed -i 's#api.crt#www-fullchain.pem#' /etc/nginx/conf.d/api.conf", "sed -i 's#api.key#www.key#' /etc/nginx/conf.d/api.conf", "systemctl reload nginx"] : ["sed -i 's#api.crt#chain.pem#' /etc/nginx/conf.d/api.conf", "systemctl reload nginx"] },
      ],
      hint: (I) => I.lv === 1 ? "Browsers quietly fetch or cache missing intermediates; curl, Java and Go don't. Count the certificates the server sends." : I.lv === 2 ? "nginx wants the leaf certificate first, then the intermediates. Look inside the existing fullchain file." : "When you connect by IP, no SNI is sent and you get the default server's certificate. Test the hostname the partner uses.",
      concept: "Certificate chains, intermediates and SNI",
      how: "A server must send its leaf certificate followed by every intermediate up to (not including) a root the client trusts. Browsers often hide a missing intermediate by fetching it from the certificate's AIA URL or using one cached from another site, so 'works in Chrome' proves little; curl, Java, Go and most mobile stacks fail with 'unable to get local issuer certificate' or 'PKIX path building failed'. nginx expects the leaf first in ssl_certificate (it checks it against the key: 'key values mismatch' means the wrong cert is first). With several names on one IP, the client's SNI picks the server block; connecting by IP sends no SNI and returns the default server, which can hide the broken one.",
      rule: "Verify TLS with openssl s_client against the exact hostname, look at the whole chain it prints, run nginx -t, then reload (never restart) to apply.",
      why: (I) => I.lv === 1 ? `nginx served <code>api.crt</code>, the leaf alone. <code>fullchain.pem</code> already had leaf + intermediate; pointing ssl_certificate at it and reloading fixed Java without touching browsers.` : I.lv === 2 ? `The existing fullchain.pem had the intermediate first, so nginx -t failed with "key values mismatch". Building leaf + intermediate in the right order fixed it.` : `Connecting to ${I.ip} without SNI returned the default server (<code>${esc(I.www)}</code>), whose chain is complete, which hid the problem. With SNI <code>${esc(I.host)}</code> the leaf came alone. Its own server block needed leaf + ca-bundle.`,
    },
    {
      id: "net-tls-expired",
      name: "The certificate expired anyway",
      kind: "Incident",
      skills: ["diagnose", "safe"],
      gen(lv, R) {
        const dom = R.pick(DOMS), host = R.pick(["shop", "store", "checkout"]) + "." + dom;
        const backs = ["10.0.1.11", "10.0.1.12", "10.0.1.13"];
        const keys = ["dotfiles", "caa", "port80", "ratelimit", "timer"];
        return { lv, dom, host, ip: `203.0.113.${R.int(10, 250)}`, backs: lv === 2 ? backs : null, bad: lv === 2 ? R.pick(backs) : null, pr: R.int(300, 900), prDate: "Oct 1", opts: R.shuffle(keys.slice()), ans: "dotfiles" };
      },
      text: (I) => I.lv === 1 ? `<p>Users get certificate errors on <code>${esc(I.host)}</code>. Certbot runs on this box and reports success. Find out what's being served and fix it <b>without dropping connections</b>.</p>` : I.lv === 2 ? `<p>About a third of requests to <code>${esc(I.host)}</code> fail with an expired-certificate error. The renewal pipeline copied the new certificate to all three backends on Sept 12. You're on the jump host. Find the culprit and fix it gracefully.</p>` : `<p>The certificate for <code>${esc(I.host)}</code> expires in two days and auto-renewal hasn't succeeded. Find out why <b>before</b> anything breaks, and pick the root cause.</p>`,
      ...LB.term({
        shell: (I) => tlsExpiredShell(I),
        goal(st, I, a) {
          if (I.lv === 3) return pickCheck(I, a, { caa: "The CAA record explicitly allows letsencrypt.org.", port80: "The challenge URL answers over port 80: with a 403.", ratelimit: "The CA's error is 'unauthorized' with a 403, not a rate limit.", timer: "certbot.timer ran 13 minutes ago." });
          if (st.stale.length) return I.lv === 2 ? "One backend is still serving the expired certificate." : "nginx is still serving the expired certificate.";
          return true;
        },
        solve: (I) => I.lv === 1 ? { log: [`openssl s_client -connect ${I.host}:443 -servername ${I.host} | openssl x509 -noout -dates`, `openssl x509 -in /etc/letsencrypt/live/${I.host}/fullchain.pem -noout -dates`, "nginx -t", "systemctl reload nginx"] }
          : I.lv === 2 ? { log: [...I.backs.map((b) => `openssl s_client -connect ${b}:443 -servername ${I.host} | openssl x509 -noout -dates`), `ssh ${I.bad} sudo systemctl reload nginx`] }
            : { log: ["journalctl -u certbot --since today", "certbot renew --dry-run", `cat /etc/nginx/conf.d/${I.host}.conf`], pick: optIdx(I, "dotfiles") },
      }),
      bad: (I) => I.lv === 1 ? [{ log: ["certbot certificates"] }] : I.lv === 2 ? [{ log: [`ssh ${I.backs.find((b) => b !== I.bad)} sudo systemctl reload nginx`] }] : [{ log: [], pick: optIdx(I, "caa") }, { log: [], pick: optIdx(I, "port80") }],
      hint: (I) => I.lv === 1 ? "Compare the dates of the certificate on disk with the one actually served. nginx reads certificates only at start or reload." : I.lv === 2 ? "Test each backend directly by IP, with the right SNI." : "Run the renewal in dry-run mode and read the CA's error. Then look at which nginx location matches the challenge path.",
      concept: "Certificate renewal is not deployment",
      how: "ACME clients like certbot write new certificate files, but servers such as nginx and HAProxy load certificates into memory at start or reload, so a renewed file isn't served until something reloads them (certbot's --deploy-hook exists for this). Behind a load balancer each backend must be checked separately, by IP with the right SNI, or one stale node shows up as intermittent failures. Renewal itself can silently break: HTTP-01 needs http://host/.well-known/acme-challenge/ to serve the token, and in nginx a regex location like `location ~ /\\.` beats a plain prefix location, so a 'deny dotfiles' hardening rule returns 403 for the challenge unless the challenge location uses `^~`.",
      rule: "Monitor the certificate actually served (per backend), not the file on disk; make renewal reload the server; and alert on renewal failures weeks before expiry.",
      why: (I) => I.lv === 1 ? "The file on disk was renewed on Sept 12, but nginx had been running since July and still held the old certificate in memory. A reload (after nginx -t) served the new one without dropping connections. Add a deploy hook so it can't happen again." : I.lv === 2 ? `Backend ${I.bad} still had the old certificate in memory: its reload never ran. The other two were fine, so a third of requests failed.` : `The dry run shows the CA got a 403 for the challenge URL. PR #${I.pr} added <code>location ~ /\\.</code>, a regex location, which wins over the prefix location for <code>/.well-known/acme-challenge/</code>. Mark the challenge location <code>^~</code> (or exclude .well-known from the deny rule), then renew.`,
    },
    {
      id: "net-san-coverage",
      name: "Which hostnames does this certificate cover?",
      kind: "Investigation",
      skills: ["diagnose"],
      w: "classify",
      gen(lv, R) {
        const dom = R.pick(DOMS);
        let pool;
        if (lv === 1) pool = [[dom, 0], ["www." + dom, 0], ["WWW." + dom.toUpperCase(), 0], ["api." + dom, 1], [`www.${dom}:8443`, 0], ["m.www." + dom, 1], ["www-" + dom, 1]];
        else if (lv === 2) pool = [["shop." + dom, 0], [dom, 0], ["eu.shop." + dom, 1], ["api." + dom, 0], ["a.b." + dom, 1], [dom.split(".")[0] + ".net", 1], ["status." + dom, 0]];
        else pool = [["https://203.0.113.10/ (cert A)", 0], ["https://203.0.113.11/ (cert A)", 1], [`legacy.${dom} (cert B)`, 1], [`pay.${dom} (cert A)`, 0], [`${dom} (cert A)`, 1], [`eu.pay.${dom} (cert A)`, 1], [`legacy.${dom} (cert A)`, 0]];
        const items = R.sample(pool, 6);
        if (!items.some((x) => x[1] === 0) || !items.some((x) => x[1] === 1)) return null;
        return { lv, dom, items };
      },
      text: (I) => {
        const certs = I.lv === 1 ? `X509v3 Subject Alternative Name:\n    DNS:${I.dom}, DNS:www.${I.dom}` : I.lv === 2 ? `X509v3 Subject Alternative Name:\n    DNS:*.${I.dom}, DNS:${I.dom}` : `Cert A  Subject: CN = *.${I.dom}\n        X509v3 Subject Alternative Name:\n            DNS:*.${I.dom}, IP Address:203.0.113.10\n\nCert B  Subject: CN = legacy.${I.dom}\n        (no Subject Alternative Name extension)`;
        return `<p>${I.lv === 3 ? "Two certificates are in use" : "The certificate on the load balancer"}:</p>${K.pre(certs)}<p>For each URL a modern client (current browsers, curl, Go, Java) might request, decide whether hostname verification passes or fails.</p>`;
      },
      ui: (I) => ({ items: I.items.map((x) => x[0]), cats: ["Passes", "Name mismatch"] }),
      ans: (I) => I.items.map((x) => x[1]),
      diag: () => "Not quite. Remember: a wildcard matches exactly one whole left-most label, the apex isn't covered by *.domain, matching is case-insensitive, ports don't matter, and modern clients ignore the Subject CN.",
      hint: (I) => I.lv === 1 ? "Only the names listed in the SAN count. Case and port don't matter." : I.lv === 2 ? "*.example.com matches exactly one label: not the apex, not two levels down." : "An IP in the URL is checked against IP Address SANs. And since 2017 browsers ignore the CN when deciding validity.",
      concept: "Hostname verification: SANs and wildcards",
      how: "Clients check the hostname they asked for (the URL host, also sent as SNI) against the certificate's Subject Alternative Names. DNS names compare case-insensitively and the port is irrelevant. A wildcard covers exactly one full left-most label: *.example.com matches a.example.com but not example.com or a.b.example.com. URLs with an IP address are checked against IP Address SAN entries, never DNS names. Chrome since 58, Go, and current Java and curl builds ignore the Subject CN, so a certificate without a SAN fails everywhere modern.",
      rule: "List every hostname (including the apex) in the SAN, remember wildcards are one level deep, and check with openssl x509 -noout -ext subjectAltName before you deploy.",
      why: (I) => `Here: ${I.items.map((x) => `<code>${esc(x[0])}</code> ${x[1] ? "fails" : "passes"}`).join(", ")}.`,
    },
    {
      id: "net-mtls-client",
      name: "Mutual TLS rejects the client",
      kind: "Incident",
      skills: ["diagnose"],
      gen(lv, R) {
        const me = R.pick(["payments", "payouts", "billing", "risk"]), svcShort = R.pick(["ledger", "vault-proxy", "settlement"]);
        const keys = lv === 1 ? ["expired", "nocert", "untrusted", "serverexp"] : lv === 2 ? ["untrusted", "expired", "nochain", "servername"] : ["nochain", "untrusted", "expired", "nocert"];
        return { lv, me, svcShort, svc: `ledger.internal`, opts: R.shuffle(keys.slice()), ans: keys[0] };
      },
      text: (I) => `<p><code>${esc(I.me)}</code> calls <code>${esc(I.svc)}:8443</code>, which requires a client certificate. Every call fails. You have a shell in a <code>${esc(I.me)}</code> pod with its certificate files in <code>/etc/tls</code>. Work out exactly why the handshake is rejected.</p>${I.lv === 3 ? "<p>Security already confirmed that ledger's trust store contains the company root CA.</p>" : ""}`,
      ...LB.term({
        shell: (I) => mtlsShell(I),
        goal: (st, I, a) => pickCheck(I, a, {
          expired: I.lv === 1 ? "" : "The client certificate is valid until 2027.",
          nocert: "curl sent a certificate (see 'TLS handshake, Certificate (11)' going OUT).",
          untrusted: I.lv === 3 ? "The server trusts the root that issued the intermediate; the problem is that it can't build a path to it from what the client sends." : "",
          serverexp: "The client verified the server certificate fine ('SSL certificate verify ok').",
          servername: "The server certificate verified fine for this hostname.",
          nochain: I.lv === 3 ? "" : "The server only trusts the 2024 issuing CA itself; sending more of the chain wouldn't help.",
        }),
        solve: (I) => ({ log: I.lv === 1 ? [`curl -v --cert /etc/tls/client.crt --key /etc/tls/client.key --cacert /etc/tls/ca.crt https://${I.svc}:8443/health`, "openssl x509 -in /etc/tls/client.crt -noout -subject -issuer -dates", "date"] : I.lv === 2 ? [`curl -v --cert /etc/tls/client.crt --key /etc/tls/client.key --cacert /etc/tls/ca.crt https://${I.svc}:8443/health`, "openssl x509 -in /etc/tls/client.crt -noout -subject -issuer -dates", `openssl s_client -connect ${I.svc}:8443 -cert /etc/tls/client.crt -key /etc/tls/client.key`] : [`openssl s_client -connect ${I.svc}:8443 -cert /etc/tls/client.crt -key /etc/tls/client.key`, "openssl x509 -in /etc/tls/client.crt -noout -subject -issuer -dates", "grep -c BEGIN /etc/tls/client.crt"], pick: optIdx(I, I.ans) }),
      }),
      bad: (I) => I.opts.filter((k) => k !== I.ans).slice(0, 2).map((k) => ({ log: [], pick: optIdx(I, k) })),
      hint: (I) => I.lv === 1 ? "Read the TLS alert in the curl error carefully, then check the certificate's dates." : I.lv === 2 ? "The server tells you which CAs it accepts client certificates from." : "A server that trusts only a root needs the client to send the intermediate. How many certificates are in client.crt?",
      concept: "Mutual TLS failure modes",
      how: "In mTLS the server sends a CertificateRequest listing the CA names it accepts, and the client must present a certificate chain that leads to one of them. The TLS alert the server sends back names the failure: 'certificate required' (no certificate sent), 'certificate expired', 'unknown ca' (no path to a trusted CA). In TLS 1.3 the client learns about the rejection only on its first read, so curl reports it as an SSL_read error after the handshake looked complete. 'unknown ca' has two common causes: the issuing CA really isn't trusted (after a CA rotation), or the server trusts only the root and the client sent its leaf without the intermediate.",
      rule: "Read the alert, compare the client cert's issuer with the server's 'Acceptable client certificate CA names', and make clients send leaf + intermediates.",
      why: (I) => I.lv === 1 ? "The server alerted 'certificate expired': the client certificate's notAfter was Oct 9, two days ago. Nothing renewed it." : I.lv === 2 ? "The rotated certificate is issued by Internal Issuing CA 2026, but ledger accepts only certificates issued by the 2024 CA. Add the new CA to ledger's trust bundle (before rotating clients, next time). The cert expiring in 5 days was a red herring: it hasn't expired." : "Ledger trusts the Internal Root CA, and the client cert is issued by Internal Issuing CA 2026 (signed by that root), but client.crt contains only the leaf. Without the intermediate the server can't build a path and answers 'unknown ca'. Ship client.crt as leaf + intermediate.",
    },
    {
      id: "net-tls-policy",
      name: "Turn off old TLS without losing customers",
      kind: "Hardening",
      skills: ["safe", "design"],
      w: "tune",
      sense: "min",
      vname: "a weakness score of",
      gen(lv, R) { return { lv, dom: R.pick(DOMS) }; },
      text: (I) => `<p>The compliance scan of <code>api.${esc(I.dom)}</code> fails: it still accepts TLS 1.0/1.1. Traffic by client type:</p>${K.table(["client", "share", "can do"], tlsClients(I).map((c) => [esc(c.n), K.pct(c.share, 0), c.v.map((v) => "TLS " + v).join(", ")]), { compact: true })}${I.lv >= 2 ? "<p>The terminals can't be upgraded this year and their traffic must keep flowing. A separate hostname for them, reachable only from the payment processor's IP ranges, is acceptable to the auditors.</p>" : ""}${I.lv === 3 ? "<p>Policy also requires forward secrecy on the public endpoint. The uptime probe is a cloud service with changing IPs.</p>" : ""}<p>Pass the scan, keep every client working, and accept <b>as little weakness as possible</b> (each extra cipher family or extra endpoint adds risk).</p>`,
      ui: (I) => ({
        knobs: [
          { k: "min", label: "Minimum TLS version (public endpoint)", opts: TLSV },
          { k: "ciphers", label: "TLS 1.2 cipher suites (public endpoint)", opts: CIPH, help: "TLS 1.3 always uses its own AEAD suites" },
          ...(I.lv >= 2 ? [{ k: "legacy", label: "Legacy endpoint", opts: ["none", "separate host, TLS 1.0+, IP allowlist"] }] : []),
        ],
        init: I.lv >= 2 ? { legacy: "none" } : {},
        live: (cfg) => {
          if (!cfg) return "";
          const ev = tlsEval(I, cfg), v = tlsValid(I, cfg);
          return K.table(["client", "share", "connects via"], ev.map((c) => [esc(c.n), K.pct(c.share, 0), c.ok ? c.via : '<span class="lose">handshake failure</span>']), { compact: true }) + K.verdict(v === true, v === true ? "Scan passes and every client connects." : esc(v));
        },
      }),
      valid: tlsValid,
      val: (I, cfg) => CIPH.indexOf(cfg.ciphers) * 2 + (cfg.legacy && cfg.legacy !== "none" ? 1 : 0),
      hint: (I) => I.lv === 1 ? "Can every listed client do TLS 1.3?" : I.lv === 2 ? "You can't keep TLS 1.0 on the public endpoint. Where else can the terminals go?" : "One client needs CBC suites with ECDHE. That's weaker than AEAD-only but keeps forward secrecy, unlike RSA key exchange.",
      concept: "TLS version and cipher policy",
      how: "TLS 1.0 and 1.1 are deprecated (RFC 8996) and compliance regimes such as PCI DSS require disabling them on public endpoints. TLS 1.3 fixes its own AEAD cipher suites; the TLS 1.2 list is where choices remain: ECDHE gives forward secrecy, RSA key exchange doesn't, and CBC-mode suites are older and more fragile than AEAD (GCM, ChaCha20-Poly1305). Requiring 1.3 only would cut off clients stuck on 1.2. Clients that can't be upgraded are best isolated on a separate endpoint with a narrow audience rather than weakening the main one.",
      rule: "Measure who negotiates what before you change it, keep the public endpoint at TLS 1.2+ with ECDHE/AEAD, and quarantine legacy clients on their own restricted endpoint.",
      why: (I, sol) => `Minimum TLS ${sol.min} (the Java batch can't do 1.3), ${sol.ciphers.toLowerCase()}${I.lv === 3 ? " because the probe needs ECDHE-CBC" : ""}${I.lv >= 2 ? ", and the terminals moved to an IP-allowlisted legacy host" : ""}.`,
    },
    {
      id: "net-ca-rotation",
      name: "Rotate the CA without an outage",
      kind: "Change plan",
      skills: ["safe", "comms"],
      w: "interleave",
      gen(lv, R) { return { lv, svc: R.pick(["ledger", "vault-proxy", "settlement"]) }; },
      text: (I) => `<p>The internal CA-2024 that signs ${I.lv === 1 ? "client certificates for the 14 services calling" : "both ledger's serving certificate and the client certificates of services calling"} <b>ledger</b> (mutual TLS) is being retired for CA-2026. Each step below is a separate deploy owned by a different team.${I.lv === 3 ? " The weekly batch job only picks up new certificates and bundles when its image is shipped." : ""}</p><p>Schedule every step so that <b>no connection fails at any point</b>. The simulator checks after each step whether each side still trusts the other.</p>`,
      ui: (I) => ({
        lanes: rotLanes(I).map((l) => ({ name: l.name, steps: l.steps.map((s) => s.t) })),
        live: (seq) => {
          const r = rotRun(I, seq || []);
          if (!r.log.length) return "";
          return K.table(["#", "step", "connections"], r.log.map((e, k) => [String(k + 1), esc(e.t), e.issues.length ? `<span class="lose">${esc(e.issues.join("; "))}</span>` : "all OK"]), { compact: true }) + (r.complete ? K.verdict(r.broken == null, r.broken == null ? "Rotation completed with zero failed handshakes." : `Outage at step ${r.broken + 1}.`) : "");
        },
      }),
      accept: (I, seq) => { const r = rotRun(I, seq); if (r.broken != null) return `After step ${r.broken + 1} (<i>${esc(r.log[r.broken].t)}</i>): ${esc(r.log[r.broken].issues.join("; "))}.`; return true; },
      solve: (I, spec) => { for (const s of LB.byId.get("net-ca-rotation").space(I, spec)) if (rotRun(I, s).broken == null) return s; return null; },
      bad: (I) => { const L = rotLanes(I); const seqLane = (order) => order.flatMap((l) => L[l].steps.map(() => l)); return [seqLane(L.map((_, i) => i)), seqLane(L.map((_, i) => L.length - 1 - i))]; },
      hint: (I) => I.lv === 1 ? "Trust first, then switch, then remove the old trust." : I.lv === 2 ? "Each side must trust the new CA before the other side starts presenting certificates from it." : "Nothing old can be removed until the slowest consumer (the batch job) has moved.",
      concept: "Overlap-based certificate and CA rotation",
      how: "A rotation is safe when every relying party trusts both the old and new CA before anyone presents a certificate from the new one, and the old CA is removed only after the last certificate it issued has been replaced everywhere. With mutual TLS this applies in both directions independently: clients' server-CA bundles and the server's client-CA bundle. The slowest consumer (a batch job, an embedded device, a partner) sets the pace of the final removal step.",
      rule: "Add trust, switch identities, remove old trust: in that order, per direction, and only after the slowest consumer has moved.",
      why: (I, sol) => { const L = rotLanes(I), pos = L.map(() => 0); return `One safe order: ${sol.map((l) => `<i>${esc(L[l].steps[pos[l]++].t)}</i>`).join(" → ")}.`; },
    },
  ]);


  /* ================= Load balancers ================= */
  const KA = {
    1: { hops: [["lb", "app"]], knobs: [{ k: "lb", label: "LB idle timeout", opts: [30, 60, 120], unit: "s" }, { k: "app", label: "App server keepAliveTimeout", opts: [5, 30, 60, 65, 120, 400], unit: "s", help: "Node.js default is 5 s" }] },
    2: { hops: [["lb", "ngc"], ["ngu", "app"]], knobs: [{ k: "lb", label: "LB idle timeout", opts: [60, 120], unit: "s" }, { k: "ngc", label: "nginx keepalive_timeout (client side, LB → nginx)", opts: [60, 65, 75, 150], unit: "s" }, { k: "ngu", label: "nginx upstream keepalive_timeout (nginx → app)", opts: [30, 60, 120], unit: "s" }, { k: "app", label: "App keepAliveTimeout", opts: [5, 65, 125], unit: "s" }] },
    3: { hops: [["cdn", "lb"], ["lb", "ngc"], ["ngu", "app"]], knobs: [{ k: "cdn", label: "CDN origin keep-alive (vendor-managed)", fixed: 90, unit: "s" }, { k: "lb", label: "LB idle timeout", opts: [60, 120, 300], unit: "s" }, { k: "ngc", label: "nginx keepalive_timeout (client side)", opts: [75, 150, 350], unit: "s" }, { k: "ngu", label: "nginx upstream keepalive_timeout", opts: [60, 120], unit: "s" }, { k: "app", label: "App keepAliveTimeout", opts: [5, 65, 125], unit: "s" }] },
  };
  const KAN = { cdn: "CDN", lb: "LB", ngc: "nginx", ngu: "nginx (as client)", app: "app" };
  function kaEval(I, c) {
    const cfg = { ...c, cdn: 90 };
    return KA[I.lv].hops.map(([cl, sv]) => {
      const ok = cfg[sv] > cfg[cl];
      const rate = ok ? 0 : Math.round((I.rps * 3600 * 0.0004 * (cfg[cl] - cfg[sv] + 1)) / cfg[cl]);
      return { cl, sv, a: cfg[cl], b: cfg[sv], ok, rate };
    });
  }
  const kaValid = (I, c) => {
    if (c.lb <= 50) return "long-poll requests sit idle for up to 50 s; the LB would cut them";
    const bad = kaEval(I, c).find((h) => !h.ok);
    return bad ? `${KAN[bad.sv]} closes idle connections after ${bad.b} s while ${KAN[bad.cl]} may reuse them for ${bad.a} s: intermittent 502s` : true;
  };

  function drainEval(I, c) {
    const r = I.rmax, P = I.prop, out = { errs: [], time: 0 };
    if (I.lv === 1) {
      if (c.stop === "immediately") out.errs.push("the app stops while the LB still routes to it and in-flight requests are cut");
      if (c.dereg < r) out.errs.push(`deregistration delay ${c.dereg} s cuts requests that run up to ${r} s`);
      out.time = c.dereg + c.drain;
      return out;
    }
    if (c.preStop < P) out.errs.push(`the LB keeps sending new requests for up to ${P} s after the pod starts terminating, but the app stops accepting after ${c.preStop} s: connection refused → 502`);
    if (c.drain < r) out.errs.push(`the app's shutdown timeout (${c.drain} s) kills requests that run up to ${r} s`);
    const wsT = I.lv === 3 && c.ws === "gradual" ? 60 : 0;
    const need = c.preStop + Math.max(c.drain, wsT);
    if (c.grace < need) out.errs.push(`terminationGracePeriodSeconds ${c.grace} s < preStop ${c.preStop} s + shutdown ${Math.max(c.drain, wsT)} s: the kubelet SIGKILLs the pod mid-drain`);
    if (c.dereg < r) out.errs.push(`deregistration delay ${c.dereg} s: the LB drops connections still serving requests of up to ${r} s`);
    if (I.lv === 3) {
      if (c.ws === "wait") out.errs.push("WebSocket clients stay connected for hours; the pod hits the grace period and every socket is dropped at once by SIGKILL");
      if (c.ws === "all") out.errs.push(`${K.num(I.sockets)} clients reconnect within a second: the auth service (limit ${K.num(I.authLimit)}/s) falls over`);
    }
    out.time = Math.max(c.preStop + Math.min(c.drain, r) + wsT, c.dereg);
    return out;
  }

  const HC_PATHS = ["/healthz (process only)", "/ready (local checks, no remote calls)", "/deep (DB, Redis, payments API)"];
  function hcEval(I, c) {
    const p = HC_PATHS.indexOf(c.path), out = {};
    out.detect = c.interval * c.threshold;
    const fails = (dur) => Math.ceil(dur / c.interval);
    out.blipFails = p >= 1 ? fails(I.blip) : 0;
    out.blipOutage = out.blipFails >= c.threshold;
    out.gcFails = I.gc > c.timeout ? Math.ceil((I.gc - c.timeout) / c.interval) : 0;
    out.flap = out.gcFails >= c.threshold;
    out.thirdParty = p === 2 && I.lv === 3;
    out.wedge = p >= 1;
    return out;
  }
  const hcValid = (I, c) => {
    const r = hcEval(I, c);
    if (r.detect > I.detectMax) return `a crashed instance keeps receiving traffic for ${r.detect} s (limit ${I.detectMax} s)`;
    if (r.blipOutage) return `the ${I.blip} s database failover fails ${r.blipFails} checks in a row on every instance at once: all targets unhealthy, full outage`;
    if (r.flap) return `a ${I.gc} s GC pause fails ${r.gcFails} consecutive checks: healthy instances get pulled out (flapping)`;
    if (r.thirdParty) return "the payments API had a 3-hour outage last month; with it in the health check every instance would be marked unhealthy and the whole site would go down, not just payments";
    if (I.lv === 3 && !r.wedge) return "a process-only check never notices an instance whose DB connection pool is wedged";
    return true;
  };

  function migCheck(I, seq) {
    const O = migOpts(I), at = (k) => seq.findIndex((i) => O[i].k === k);
    for (const i of seq) if (O[i].trap) return O[i].trap;
    const need = O.filter((o) => o.need).map((o) => o.k);
    const missing = need.filter((k) => at(k) < 0);
    if (missing.length) return `Missing: <i>${esc(O.find((o) => o.k === missing[0]).t)}</i>`;
    const before = [["import", "verify"], ["verify", "ns"], ["ns", "wait"], ["wait", "delete"], ["freeze", "import"], ["ds", "dswait"], ["dswait", "ns"], ["wait", "sign"]];
    const why = { "verify>ns": "switching before verifying sends resolvers to a provider you haven't checked", "import>verify": "there's nothing to verify yet", "ns>wait": "the wait only starts once the delegation changes", "wait>delete": "resolvers keep using the old nameservers for up to the parent's NS TTL; deleting early answers REFUSED/NXDOMAIN to them", "freeze>import": "changes made after the export would exist only at the old provider", "ds>dswait": "removing the DS only helps once cached copies expire", "dswait>ns": "validating resolvers still holding the old DS would see signatures from the wrong keys (or none) and return SERVFAIL", "wait>sign": "publishing the new DS while some resolvers still use the old nameservers makes those answers fail validation" };
    for (const [a, b] of before) if (at(a) >= 0 && at(b) >= 0 && at(a) > at(b)) return `Order problem: <i>${esc(O.find((o) => o.k === a).t)}</i> must come before <i>${esc(O.find((o) => o.k === b).t)}</i>: ${why[a + ">" + b]}.`;
    return true;
  }
  function migOpts(I) {
    const o = [
      { k: "import", t: "Export the zone from the old provider and import it at the new one", need: true },
      { k: "verify", t: `Query the new provider directly for every record (dig @ns1.newdns.net ${I.dom} ...) and diff against the old one`, need: true },
      { k: "ns", t: "Change the NS records at the registrar to the new provider's nameservers", need: true },
      { k: "wait", t: "Wait at least 48 h (the .com NS TTL is 172800 s) with both providers serving identical data", need: true },
      { k: "delete", t: "Delete the zone at the old provider", need: true },
      { k: "early", t: "Delete the old zone as soon as dig shows the new NS records", trap: "Your own resolver seeing the new NS says nothing about the others: resolvers that cached the delegation keep asking the old provider for up to 48 h." },
      { k: "nsfirst", t: "Point the registrar at the new nameservers, then create the records there", trap: "Between those steps the new provider answers authoritatively for an empty zone: NXDOMAIN for everything, cached by resolvers." },
    ];
    if (I.lv >= 2) o.push({ k: "freeze", t: "Freeze DNS changes (or apply every change at both providers) until the old zone is deleted", need: true }, { k: "lowerns", t: "Lower the TTL of the .com delegation to 60 s at the registrar", trap: "The delegation NS records live in the TLD zone and their TTL is set by the registry, not by you." });
    if (I.lv === 3) o.push(
      { k: "ds", t: "Remove the DS record at the registrar", need: true },
      { k: "dswait", t: "Wait for the DS TTL to expire so validators treat the zone as unsigned", need: true },
      { k: "sign", t: "Enable DNSSEC signing at the new provider and publish its DS at the registrar", need: true },
      { k: "unsign", t: "Turn off DNSSEC signing at the old provider while the DS stays published", trap: "A published DS with an unsigned zone is bogus: every validating resolver (a large share of users) gets SERVFAIL." },
    );
    return o;
  }

  const L47 = {
    1: [["Route /api/* to the API service and /static/* to a storage bucket", 1], ["Postgres primary endpoint for 300 app instances", 0], ["Redirect HTTP to HTTPS and add HSTS", 1], ["Syslog over UDP from 2,000 network devices", 0], ["Canary 5% of HTTP requests by a header", 1], ["MQTT broker with 2 million mostly idle device connections", 0], ["Block SQL-injection patterns with WAF rules", 1]],
    2: [["gRPC service where 6 client pods hold long-lived HTTP/2 connections; each RPC must be balanced", 1], ["Partner requires mutual TLS terminated by our app; the LB must never see plaintext", 0], ["Per-path rate limits on /login and /signup", 1], ["Game server traffic over UDP at 2 M packets/s, lowest possible latency", 0], ["SMTP relay that must see the client's source IP", 0], ["Serve two hostnames with different certificates from one IP and route by host", 1], ["Kafka brokers advertised to clients outside the VPC", 0]],
    3: [["WebSocket chat app that needs cookie-based stickiness", 1], ["Static IPs that a bank must allowlist in its firewall", 0], ["Retry idempotent GETs on another backend when one returns 503", 1], ["TLS passthrough to pods that use SNI to pick a tenant certificate", 0], ["Strip an internal header (X-Debug-User) before requests reach the app", 1], ["A database proxy speaking the Postgres wire protocol", 0], ["Compress JSON responses and add CORS headers centrally", 1]],
  };

  LB.addAll("net", [
    {
      id: "net-l4-vs-l7",
      name: "L4 or L7 load balancer?",
      kind: "Design review",
      skills: ["design"],
      w: "classify",
      gen(lv, R) { const items = R.sample(L47[lv], 6); if (items.filter((x) => x[1]).length < 2 || items.filter((x) => !x[1]).length < 2) return null; return { lv, items }; },
      text: (I) => `<p>The platform team offers two managed load balancers: an <b>L4</b> one (TCP/UDP pass-through: fast, static IPs, preserves the connection end-to-end, sees no HTTP) and an <b>L7</b> one (terminates HTTP/TLS: routes by host, path and header, balances individual requests, rewrites headers). For each workload, pick the one that fits.</p>`,
      ui: (I) => ({ items: I.items.map((x) => x[0]), cats: ["L4 (TCP/UDP)", "L7 (HTTP)"] }),
      ans: (I) => I.items.map((x) => x[1]),
      diag: () => "Not quite. Ask: does the balancer need to understand HTTP (paths, headers, cookies, individual requests), or must it stay out of the bytes (non-HTTP protocols, end-to-end TLS, static IPs, raw throughput)?",
      hint: () => "Anything that inspects or changes HTTP needs L7. Anything that isn't HTTP, or must not be decrypted, needs L4.",
      concept: "Layer 4 vs layer 7 load balancing",
      how: "An L4 balancer picks a backend per connection from the 5-tuple and forwards bytes; it works for any TCP/UDP protocol, can keep TLS end-to-end, often offers static IPs and very high throughput, but can't see requests, so one long-lived connection (gRPC, HTTP/2) stays on one backend. An L7 balancer terminates the connection, parses HTTP, and can route by host/path/header, balance each request across backends, retry, rewrite headers, apply WAF rules and stickiness cookies. The price is TLS termination at the balancer and HTTP-only scope.",
      rule: "Default to L7 for HTTP APIs and websites; choose L4 for non-HTTP protocols, end-to-end TLS, static IP requirements, or extreme packet rates.",
      why: (I) => I.items.map((x) => `<code>${esc(x[0])}</code>: ${x[1] ? "L7" : "L4"}`).join("; ") + ".",
    },
    {
      id: "net-keepalive-502",
      name: "Intermittent 502s behind the load balancer",
      kind: "Incident",
      skills: ["diagnose", "tune"],
      w: "tune",
      sense: "min",
      vname: "idle-socket seconds of",
      gen(lv, R) { return { lv, rps: R.int(4, 12) * 100, svc: R.pick(K.NAMES.svc) }; },
      text: (I) => `<p><code>${esc(I.svc)}</code> serves ${K.num(I.rps)} req/s with a steady trickle of <b>502 Bad Gateway</b> (about 0.05%). LB logs show the backend <i>closed the connection</i> before sending a response; the app logs show nothing for those requests. They cluster after quiet seconds. Clients long-poll for up to 50 s.</p><p>The chain is ${I.lv === 1 ? "LB → Node.js app" : I.lv === 2 ? "LB → nginx sidecar → Node.js app" : "CDN → LB → nginx → Node.js app"}; every hop reuses idle keep-alive connections. Set the timeouts so the 502s stop, holding <b>as few idle sockets as possible</b> (minimise the sum of timeouts you control).</p>`,
      ui: (I) => ({
        knobs: KA[I.lv].knobs,
        live: (c) => {
          if (!c) return "";
          const hs = kaEval(I, c), v = kaValid(I, c);
          return K.table(["connection", "client reuses idle conn for", "server closes idle conn after", "est. 502s/hour"], hs.map((h) => [`${KAN[h.cl]} → ${KAN[h.sv].replace(" (as client)", "")}`, h.a + " s", h.b + " s", h.ok ? "0" : `<span class="lose">${K.num(h.rate)}</span>`]), { compact: true }) + K.verdict(v === true, v === true ? "No hop can reuse a connection the next hop has already closed." : esc(v));
        },
      }),
      valid: kaValid,
      val: (I, c) => KA[I.lv].knobs.filter((k) => !k.fixed).reduce((s, k) => s + c[k.k], 0),
      hint: (I) => I.lv === 1 ? "If the app closes an idle connection at the same moment the LB sends a request on it, the LB gets a reset and returns 502. Which side must time out first?" : "Apply the same rule to every hop: the server side of each connection must keep idle connections open longer than its client side.",
      concept: "Keep-alive idle timeouts across proxy hops",
      how: "Proxies keep idle connections to upstreams open for reuse. If the upstream's idle timeout is shorter than the proxy's, the upstream closes a connection just as the proxy sends a new request on it; the proxy sees a reset or EOF and returns 502, and the app never logs the request. The fix is ordering: on each connection the server side (upstream) must keep idle connections longer than the client side (proxy) will reuse them. Node.js's default keepAliveTimeout is 5 s, well below typical LB idle timeouts of 60 s, which makes this a classic.",
      rule: "Along every hop, upstream keep-alive timeout > downstream idle timeout. Write the chain down and check each pair.",
      why: (I, sol) => `${kaEval(I, sol).map((h) => `${KAN[h.cl]} ${h.a} s &lt; ${KAN[h.sv].replace(" (as client)", "")} ${h.b} s`).join("; ")}.${I.lv === 3 ? " The CDN's 90 s is fixed, so the LB must wait longer than that, which pushes nginx's client-side timeout up too." : ""}`,
    },
    {
      id: "net-drain-deploy",
      name: "Deploys without dropped requests",
      kind: "Config change",
      skills: ["safe", "tune"],
      w: "tune",
      sense: "min",
      vname: "a drain time per instance of",
      vfmt: (v) => v + " s",
      gen(lv, R) { return { lv, rmax: R.pick([20, 25]), prop: lv === 1 ? 0 : R.pick([5, 8]), sockets: R.int(20, 40) * 1000, authLimit: R.int(2, 5) * 1000, svc: R.pick(K.NAMES.svc) }; },
      text: (I) => I.lv === 1 ? `<p>Every deploy of <code>${esc(I.svc)}</code> (VMs behind a load balancer) causes a burst of 502s. The deploy script deregisters an instance, stops the app, upgrades and re-registers it. The slowest legitimate requests (report exports) take <b>${I.rmax} s</b>.</p><p>Configure the rollout so no request fails, with the <b>shortest time per instance</b>.</p>`
        : `<p><code>${esc(I.svc)}</code> runs on Kubernetes behind a cloud LB targeting pod IPs. On pod deletion the kubelet runs preStop, then sends SIGTERM; the app then stops accepting connections and finishes in-flight requests for up to its shutdown timeout. The LB learns about the removed endpoint up to <b>${I.prop} s</b> later. Slowest requests: <b>${I.rmax} s</b>.${I.lv === 3 ? ` Each pod also holds about ${K.num(I.sockets / 10)} WebSocket connections (${K.num(I.sockets)} across the fleet) that last hours; every reconnect hits the auth service, which handles ${K.num(I.authLimit)} logins/s.` : ""}</p><p>Configure rollouts so nothing fails, with the <b>shortest drain time per pod</b>.</p>`,
      ui: (I) => ({
        knobs: I.lv === 1 ? [
          { k: "dereg", label: "LB deregistration delay (connection draining)", opts: [0, 15, 30, 60, 300], unit: "s" },
          { k: "stop", label: "Deploy script stops the app", opts: ["immediately", "after deregistration completes"] },
          { k: "drain", label: "App graceful-shutdown timeout", opts: [0, 30], unit: "s" },
        ] : [
          { k: "preStop", label: "preStop hook: sleep", opts: [0, 5, 10, 15], unit: "s" },
          { k: "drain", label: "App shutdown timeout (finish in-flight)", opts: [10, 30], unit: "s" },
          { k: "grace", label: "terminationGracePeriodSeconds", opts: [30, 45, 60, 90], unit: "s" },
          { k: "dereg", label: "LB deregistration delay", opts: [0, 30, 60, 300], unit: "s" },
          ...(I.lv === 3 ? [{ k: "ws", label: "WebSockets on SIGTERM", opts: ["wait", "all", "gradual"], fmt: (v) => ({ wait: "wait for clients to leave", all: "close all at once", gradual: "close gradually over 60 s, clients reconnect with jitter" })[v] }] : []),
        ],
        live: (c) => { if (!c) return ""; const r = drainEval(I, c); return K.metrics([{ name: "Failed requests per deploy", value: r.errs.length ? "some" : "0", ok: !r.errs.length }, { name: "Drain time per instance", value: r.time + " s", ok: null }]) + (r.errs.length ? r.errs.map((e) => K.verdict(false, esc(e))).join("") : K.verdict(true, "Clean rollout.")); },
      }),
      valid: (I, c) => { const r = drainEval(I, c); return r.errs.length ? r.errs[0] : true; },
      val: (I, c) => drainEval(I, c).time,
      hint: (I) => I.lv === 1 ? "The LB needs time to let in-flight requests finish after it stops sending new ones, and the app must still be running during that time." : I.lv === 2 ? "Endpoint removal and SIGTERM happen in parallel. The preStop sleep keeps the app serving until the LB has stopped routing to it. Then add up what has to fit in the grace period." : "Long-lived connections can't be drained by waiting. Spread their reconnects out.",
      concept: "Connection draining and graceful shutdown",
      how: "Removing an instance from a load balancer is not instant: the LB keeps existing connections alive for the deregistration delay (connection draining) and, in Kubernetes, takes a few seconds to even learn the endpoint is gone. Meanwhile the kubelet sends SIGTERM right after the preStop hook. If the app stops accepting connections before the LB stops sending, new requests fail; if the grace period expires before in-flight work finishes, SIGKILL cuts it. A preStop sleep longer than the propagation delay, a shutdown timeout longer than the slowest request, and terminationGracePeriodSeconds above their sum make rollouts clean. Long-lived connections (WebSockets, gRPC streams) need the server to close them deliberately and clients to reconnect with jitter.",
      rule: "preStop sleep > LB propagation delay; app drain > slowest request; grace period > preStop + drain; deregistration delay ≥ slowest request; and close long-lived connections gradually.",
      why: (I, sol) => I.lv === 1 ? `Deregistration delay ${sol.dereg} s covers the ${I.rmax} s requests, and the script waits for it before stopping the app.` : `preStop ${sol.preStop} s ≥ the ${I.prop} s propagation delay, shutdown timeout ${sol.drain} s ≥ ${I.rmax} s requests, grace ${sol.grace} s covers both${I.lv === 3 ? " plus the 60 s gradual WebSocket close, which spreads " + K.num(I.sockets / 10) + " reconnects per pod over a minute instead of a thundering herd" : ""}.`,
    },
    {
      id: "net-health-checks",
      name: "Tune the health check",
      kind: "Config change",
      skills: ["tune", "safe"],
      w: "tune",
      sense: "min",
      vname: "a detection time of",
      vfmt: (v) => v + " s",
      gen(lv, R) { return { lv, blip: R.pick([15, 20, 25]), gc: lv >= 2 ? R.pick([11, 12, 14]) : 0, detectMax: lv === 3 ? 60 : 30, svc: R.pick(K.NAMES.svc) }; },
      text: (I) => `<p>The load balancer in front of 12 <code>${esc(I.svc)}</code> instances marks a target unhealthy after <i>threshold</i> consecutive failed checks and returns 503 when no targets are healthy. Facts:</p><ul><li>The database fails over every few weeks; queries fail for about <b>${I.blip} s</b>.</li>${I.gc ? `<li>Instances occasionally stall for <b>${I.gc} s</b> in GC pauses (a known issue being worked on), then recover.</li>` : ""}<li>A crashed instance must stop receiving traffic within <b>${I.detectMax} s</b>.</li>${I.lv === 3 ? "<li>Last week one instance's DB connection pool wedged (process alive, every request failing) and nothing noticed. That must be caught.</li><li>The deep check also calls the third-party payments API.</li>" : ""}</ul><p>Choose a check that meets all of these with the <b>fastest crash detection</b>.</p>`,
      ui: (I) => ({
        knobs: [
          { k: "path", label: "Health check path", opts: HC_PATHS },
          { k: "interval", label: "Interval", opts: [5, 10, 30], unit: "s" },
          { k: "threshold", label: "Unhealthy threshold", opts: [2, 3, 5], help: "consecutive failures" },
          { k: "timeout", label: "Timeout", opts: [2, 5], unit: "s" },
        ],
        live: (c) => {
          if (!c) return "";
          const r = hcEval(I, c), v = hcValid(I, c);
          return K.metrics([
            { name: "Crash detected after", value: r.detect + " s", ok: r.detect <= I.detectMax, target: `≤ ${I.detectMax} s` },
            { name: "DB failover", value: r.blipOutage ? "full outage" : r.blipFails ? `${r.blipFails} failed checks, no action` : "not checked", ok: !r.blipOutage },
            ...(I.gc ? [{ name: `${I.gc} s GC pause`, value: r.flap ? "instance pulled" : "tolerated", ok: !r.flap }] : []),
            ...(I.lv === 3 ? [{ name: "Wedged DB pool", value: r.wedge ? "detected" : "missed", ok: r.wedge }] : []),
          ]) + K.verdict(v === true, v === true ? "Meets every requirement." : esc(v));
        },
      }),
      valid: hcValid,
      val: (I, c) => hcEval(I, c).detect,
      hint: (I) => I.lv === 1 ? "If the health check depends on the database, a database blip fails every instance at the same moment." : I.lv === 2 ? "Fast detection with threshold 2 means a single long pause can trip it. Count how many checks a pause can fail." : "Check what's local to the instance, never shared dependencies, and make the threshold outlast the DB failover.",
      concept: "Health check design",
      how: "A load balancer health check should answer one question: should this instance get traffic? Checks that call shared dependencies (database, cache, third-party APIs) fail on every instance at once when that dependency blips, turning a partial problem into a total outage. Checks that only prove the process is alive miss instances that are up but broken. The middle ground checks local state, such as this instance's own connection pool, with a threshold that outlasts expected transient failures. Detection time is roughly interval × threshold; failures from pauses are about ceil((pause − timeout) / interval).",
      rule: "Health checks test the instance, not its dependencies; set interval × threshold to beat both your detection target and your longest expected transient.",
      why: (I, sol) => { const r = hcEval(I, sol); return `${esc(sol.path)} every ${sol.interval} s with threshold ${sol.threshold} detects a crash in ${r.detect} s; the ${I.blip} s failover fails only ${r.blipFails} check${r.blipFails === 1 ? "" : "s"}${I.gc ? ` and the ${I.gc} s pause ${r.gcFails}` : ""}, below the threshold.`; },
    },
    {
      id: "net-sticky-sessions",
      name: "Sticky sessions: keep or kill?",
      kind: "Decision",
      skills: ["design", "diagnose"],
      w: "choice",
      gen(lv, R) {
        const n0 = R.pick([4, 6]);
        const opts = lv === 1 ? ["Move sessions to a shared store (e.g. Redis) and turn stickiness off", "Switch the LB algorithm to least outstanding requests", "Shorten the stickiness cookie to 5 minutes", "Scale out further, to " + n0 * 4 + " instances"]
          : lv === 2 ? ["Enable cookie-based stickiness for the Socket.IO path", "Add the Redis adapter so nodes share broadcasts", "Raise pingTimeout to 60 s", "Switch the LB to least connections"]
            : ["Route by consistent hashing on tenant ID with bounded load, and drop the cookie", "Keep the 24 h stickiness cookie and add instances", "Disable stickiness and add two DB read replicas", "Move to bigger instances so the hot tenants fit"];
        return { lv, n0, cpuOld: R.int(85, 95), cpuNew: R.int(10, 20), hit: R.int(80, 90), opts: R.shuffle(opts.slice()), right: opts[0] };
      },
      text: (I) => I.lv === 1 ? `<p>During the sale the shop autoscaled from ${I.n0} to ${I.n0 * 2} instances. Ten minutes later the original ${I.n0} run at <b>${I.cpuOld}% CPU</b> and the new ones at <b>${I.cpuNew}%</b>. Sessions (including carts) live in each instance's memory, and the LB uses a 24 h stickiness cookie. Which change fixes the imbalance <b>without logging anyone out or losing carts</b>, and keeps working at the next spike?</p>`
        : I.lv === 2 ? `<p>A chat app uses Socket.IO behind an LB with round robin. After scaling from 1 to 4 nodes, users on corporate networks (whose proxies block WebSocket upgrades, so Socket.IO falls back to HTTP long-polling) get <code>400 {"code":1,"message":"Session ID unknown"}</code>. Users on home networks are fine. What fixes it?</p>`
          : `<p>A B2B analytics API keeps a per-instance in-memory cache of each tenant's dimension tables; cookie stickiness gives a <b>${I.hit}% hit rate</b>. Without stickiness it drops to about 8% and the database can't cope. But three enterprise tenants send 40% of traffic: the instances they stick to run hot while others idle, and cookies don't help API clients that don't keep them. What's the best design?</p>`,
      ui: (I) => ({ opts: I.opts }),
      ans: (I) => I.right,
      diag: (I, a) => ({
        "Switch the LB algorithm to least outstanding requests": "Stickiness overrides the algorithm for every user who already has a cookie, so the old instances keep their users.",
        "Shorten the stickiness cookie to 5 minutes": "Users would move to instances that don't have their session: logouts and lost carts.",
        "Add the Redis adapter so nodes share broadcasts": "The adapter shares broadcasts between nodes, but a long-polling client's next HTTP request still lands on a node that never saw its handshake.",
        "Raise pingTimeout to 60 s": "The session isn't timing out; the request reaches a node that never had it.",
        "Switch the LB to least connections": "Any algorithm that can send consecutive polls to different nodes fails the same way.",
        "Keep the 24 h stickiness cookie and add instances": "New instances only get new cookies; the hot tenants stay where they are, and cookieless API clients still scatter.",
        "Disable stickiness and add two DB read replicas": "A 10× drop in cache hit rate is far more load than two replicas absorb, and latency rises for everyone.",
        "Move to bigger instances so the hot tenants fit": "That buys time but keeps the imbalance and the cookie dependence.",
      })[a] || "Not the best option here.",
      hint: (I) => I.lv === 1 ? "As long as state lives in one instance, stickiness can't be turned off, and stickiness pins existing users to old instances." : I.lv === 2 ? "With long-polling, a Socket.IO session is a series of separate HTTP requests that must all reach the node holding the session." : "You want locality keyed by what the cache is keyed by, without a single tenant overloading one instance.",
      concept: "Sticky sessions trade-offs",
      how: "Stickiness pins a client to one backend, usually with an LB cookie. It's needed when the backend holds per-client state (in-memory sessions, Socket.IO polling sessions) and useful for cache locality, but it defeats load balancing: existing clients stay on old instances after a scale-out, hot clients overload their instance, and an instance failure loses its clients' state. Externalising state (Redis sessions) removes the need. When locality matters, routing by a stable key with consistent hashing and bounded load gives locality without cookies and caps how hot any instance gets.",
      rule: "Keep state out of instances so you can balance freely; use stickiness only where a protocol demands it, and prefer key-based consistent hashing with bounded load for cache locality.",
      why: (I) => I.lv === 1 ? "Moving sessions to a shared store makes every instance able to serve every user, so stickiness can go and the LB spreads load immediately, including onto the next scale-out." : I.lv === 2 ? "Socket.IO's HTTP long-polling sends each poll as a separate request; with round robin they hit nodes that never saw the handshake. Its docs require sticky sessions for this; the Redis adapter is a separate concern (cross-node broadcasts)." : "Hashing on tenant ID keeps each tenant's cache on a small set of instances regardless of cookies, and bounded-load consistent hashing spills a hot tenant to the next instance before one overloads.",
    },
    {
      id: "net-dns-provider-migration",
      name: "Move DNS to a new provider",
      kind: "Change plan",
      skills: ["safe", "comms"],
      w: "steps",
      gen(lv, R) { const dom = R.pick(DOMS.filter((d) => d.endsWith(".com"))); return { lv, dom, order: R.perm(migOpts({ lv, dom }).length).map((x) => x - 1) }; },
      text: (I) => `<p><code>${esc(I.dom)}</code> (~${I.lv === 1 ? 40 : 180} records${I.lv >= 2 ? ", edited by several teams every day" : ""}${I.lv === 3 ? ", <b>DNSSEC-signed</b> by the old provider with a DS record at the registrar" : ""}) is moving to a new DNS provider. The old provider can't co-sign with the new one. Build the plan: pick the steps you need, in order. Some options are traps.</p>`,
      ui: (I) => { const O = migOpts(I); return { opts: I.order.map((i) => O[i].t), live: (seq) => { if (!seq || !seq.length) return ""; const r = migCheck(I, seq.map((i) => I.order[i])); return r === true ? K.verdict(true, "No resolver ever gets a wrong or failed answer.") : K.note(r, "bad"); } }; },
      accept: (I, seq) => migCheck(I, seq.map((i) => I.order[i])),
      solve: (I) => { const O = migOpts(I), want = ["freeze", "import", "verify", "ds", "dswait", "ns", "wait", "sign", "delete"]; return want.map((k) => O.findIndex((o) => o.k === k)).filter((i) => i >= 0).map((i) => I.order.indexOf(i)); },
      bad: (I) => { const O = migOpts(I), idx = (k) => I.order.indexOf(O.findIndex((o) => o.k === k)); const base = LB.byId.get("net-dns-provider-migration").solve(I); return [base.map((i) => (i === idx("delete") ? idx("early") : i)), base.filter((i) => i !== idx("verify")), [idx("nsfirst"), ...base.filter((i) => i !== idx("ns"))]]; },
      hint: (I) => I.lv === 1 ? "Resolvers cache the delegation (NS) for the parent zone's TTL. Both providers must serve the same answers for that long." : I.lv === 2 ? "What happens to a record someone edits at the old provider after you exported the zone?" : "A DS record at the registrar tells validators which keys must sign the zone. The new provider's signatures won't match it.",
      concept: "Migrating authoritative DNS (and DNSSEC)",
      how: "Resolvers find your nameservers through the NS records in the parent zone (.com), cached for the parent's TTL (two days for .com), which you can't change. During that window some resolvers ask the old provider and some the new one, so both must serve identical data: import, verify directly against the new nameservers, switch the delegation, wait out the parent TTL, then delete. Edits must be frozen or applied in both places. With DNSSEC, the DS at the registrar pins the signing keys; if the new provider can't co-sign, remove the DS and wait for its TTL to expire (the zone becomes unsigned), migrate, then sign at the new provider and publish its DS.",
      rule: "Overlap, don't flip: both providers serve the same zone for at least the parent's NS TTL, and with DNSSEC the DS must never point at keys the answering nameserver doesn't use.",
      why: (I, sol) => `One safe plan: ${sol.map((i, k) => `${k + 1}. ${esc(migOpts(I)[I.order[i]].t)}`).join("; ")}.`,
    },
  ]);

})();
