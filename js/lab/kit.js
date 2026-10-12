/* Systems Lab toolkit (LB.k): shared simulators, parsers and renderers that chapter files build scenarios from.
   Everything here is deterministic given its inputs (simulations take a seeded rng R from C.rng). */
(function () {
  "use strict";
  const D = window.DSA, U = D.util, C = D.campaign, LB = D.lab;
  const esc = U.esc;
  const K = (LB.k = {});

  /* ---------- formatting ---------- */
  K.esc = esc;
  K.num = (x, d = 0) => (x == null || Number.isNaN(x) ? "–" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  K.ms = (x) => (x == null || Number.isNaN(x) ? "–" : x >= 10000 ? (x / 1000).toFixed(1) + " s" : x >= 1000 ? (x / 1000).toFixed(2) + " s" : x >= 10 ? Math.round(x) + " ms" : x.toFixed(1) + " ms");
  K.pct = (x, d = 1) => (x == null || Number.isNaN(x) ? "–" : (x * 100).toFixed(d).replace(/\.0+$/, "") + "%");
  K.bytes = (b) => { if (b == null) return "–"; const u = ["B", "KB", "MB", "GB", "TB", "PB"]; let i = 0; while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i ? b.toFixed(b >= 100 ? 0 : 1) : b) + " " + u[i]; };
  K.usd = (x) => (x == null ? "–" : "$" + K.num(x, x < 10 ? 2 : 0));
  K.code = (s) => `<code>${esc(s)}</code>`;
  K.pre = (s) => `<pre class="lab-pre">${esc(s)}</pre>`;
  K.dur = (s) => { const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/); if (!m) return null; return +m[1] * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] || "s"]; };
  // Pad rows of cells into aligned text columns (for terminal output: kubectl get, ps, ...).
  K.cols = (rows, gap = 3) => {
    const w = [];
    rows.forEach((r) => r.forEach((c, i) => (w[i] = Math.max(w[i] || 0, String(c).length))));
    return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(w[i] + gap))).join("")).join("\n");
  };

  /* ---------- HTML building blocks ---------- */
  // rows: arrays of cells (cells are HTML strings); opts.cls per-row class fn, opts.num column indexes right-aligned
  K.table = (head, rows, o = {}) => `<div class="table-wrap"><table class="lab-table${o.compact ? " compact" : ""}">${head ? `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` : ""}<tbody>${rows.map((r, ri) => `<tr${o.cls ? ` class="${o.cls(r, ri) || ""}"` : ""}>${r.map((c, i) => `<td${o.mono && o.mono.includes(i) ? ' class="mono"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  // Metric checks: [{name, value (html), ok: true|false|null, target?}] → a row of pass/fail tiles.
  K.metrics = (list) => `<div class="lab-metrics">${list.map((m) => `<div class="lab-metric${m.ok === true ? " ok" : m.ok === false ? " bad" : ""}"><span>${m.name}</span><b>${m.value}</b>${m.target ? `<small>${m.target}</small>` : ""}</div>`).join("")}</div>`;
  // Horizontal bars: [{label, value, max?, cls?, note?}]
  K.bars = (items, o = {}) => {
    const mx = o.max || Math.max(1e-9, ...items.map((x) => x.value));
    return `<div class="lab-bars">${items.map((x) => `<div class="lab-bar ${x.cls || ""}"><span class="bl">${x.label}</span><span class="bt"><span class="bf" style="width:${Math.max(0, Math.min(100, (x.value / mx) * 100))}%"></span></span><span class="bv">${x.note != null ? x.note : K.num(x.value, 1)}</span></div>`).join("")}</div>`;
  };
  K.note = (html, kind = "") => `<div class="lab-note ${kind}">${html}</div>`;
  K.verdict = (ok, html) => `<div class="lab-verdict ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${html}</div>`;

  /* Line chart as inline SVG. series: [{name, pts:[y...] (x = index) or [[x,y]...], cls?: 'a'|'b'|'c'|'d'|'bad'|'good'}]
     o: {h, ymin, ymax, hline:{y, label}, vline:{x,label}, xlabel, ylabel, fmt(y), xfmt(x)} */
  K.chart = (series, o = {}) => {
    const W = 560, H = o.h || 170, pl = 46, pr = 10, pt = 10, pb = 24;
    const S = series.map((s) => ({ ...s, pts: s.pts.map((p, i) => (Array.isArray(p) ? p : [i, p])).filter((p) => p[1] != null && Number.isFinite(p[1])) }));
    const xs = S.flatMap((s) => s.pts.map((p) => p[0])), ys = S.flatMap((s) => s.pts.map((p) => p[1]));
    if (o.hline) ys.push(o.hline.y);
    const x0 = Math.min(...xs, 0), x1 = Math.max(...xs, 1);
    const y0 = o.ymin != null ? o.ymin : Math.min(0, ...ys), y1 = o.ymax != null ? o.ymax : Math.max(...ys, y0 + 1) * 1.08;
    const X = (x) => pl + ((x - x0) / (x1 - x0 || 1)) * (W - pl - pr), Y = (y) => pt + (1 - (Math.min(y1, Math.max(y0, y)) - y0) / (y1 - y0 || 1)) * (H - pt - pb);
    const fmt = o.fmt || ((v) => K.num(v, Math.abs(v) < 10 ? 1 : 0));
    const ticks = [0, 0.5, 1].map((f) => y0 + f * (y1 - y0));
    const grid = ticks.map((t) => `<line x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}" class="cg"/><text x="${pl - 6}" y="${Y(t) + 4}" class="ct" text-anchor="end">${esc(fmt(t))}</text>`).join("");
    const lines = S.map((s, k) => `<polyline class="cl ${s.cls || "s" + k}" fill="none" points="${s.pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}"/>`).join("");
    const hl = o.hline ? `<line x1="${pl}" x2="${W - pr}" y1="${Y(o.hline.y)}" y2="${Y(o.hline.y)}" class="ch"/><text x="${W - pr - 4}" y="${Y(o.hline.y) - 4}" class="ct" text-anchor="end">${esc(o.hline.label || "")}</text>` : "";
    const vl = o.vline ? `<line y1="${pt}" y2="${H - pb}" x1="${X(o.vline.x)}" x2="${X(o.vline.x)}" class="ch"/><text x="${X(o.vline.x) + 4}" y="${pt + 10}" class="ct">${esc(o.vline.label || "")}</text>` : "";
    const xl = `<text x="${pl}" y="${H - 6}" class="ct">${esc(o.xfmt ? o.xfmt(x0) : x0)}</text><text x="${W - pr}" y="${H - 6}" class="ct" text-anchor="end">${esc(o.xfmt ? o.xfmt(x1) : x1)}${o.xlabel ? " " + esc(o.xlabel) : ""}</text>`;
    const legend = S.length > 1 || o.legend ? `<div class="chart-legend">${S.map((s, k) => `<span><i class="lg ${s.cls || "s" + k}"></i>${esc(s.name || "")}</span>`).join("")}</div>` : "";
    return `<figure class="lab-chart">${o.title ? `<figcaption>${esc(o.title)}</figcaption>` : ""}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title || S.map((s) => s.name).join(", "))}">${grid}${hl}${vl}${lines}${xl}${o.ylabel ? `<text x="4" y="${pt + 8}" class="ct">${esc(o.ylabel)}</text>` : ""}</svg>${legend}</figure>`;
  };

  /* ---------- statistics ---------- */
  K.quantile = (arr, q) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); const i = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1)); return a[i]; };
  K.mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  K.sum = (a) => a.reduce((s, x) => s + x, 0);
  // Exponential sample with mean m; lognormal with median m and shape sigma.
  K.exp = (R, m) => -Math.log(1 - R.next()) * m;
  K.gauss = (R) => { const u = 1 - R.next(), v = R.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  K.logn = (R, med, sigma = 0.5) => med * Math.exp(sigma * K.gauss(R));
  K.round = (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; };
  // Erlang-C for an M/M/c queue: lambda arrivals/s, mu completions/s per server, c servers.
  K.mmc = (lambda, mu, c) => {
    const a = lambda / mu, rho = a / c;
    if (rho >= 1) return { rho, pw: 1, wq: Infinity, w: Infinity, lq: Infinity };
    let sum = 0, term = 1; // term = a^k / k!
    for (let k = 0; k < c; k++) { if (k > 0) term *= a / k; sum += term; }
    const tc = (term * a) / c / (1 - rho); // a^c / c! / (1 - rho)
    const pw = tc / (sum + tc), wq = pw / (c * mu - lambda);
    return { rho, pw, wq, w: wq + 1 / mu, lq: lambda * wq };
  };

  /* ---------- hashing ---------- */
  K.hash = (s) => { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

  /* ---------- discrete-event queue simulator ----------
     A service with `servers` workers handling requests FIFO, fed by Poisson arrivals.
     o: { R, dur (s), rate (req/s) | rateAt(t), svc (mean service ms) | svcAt(t, R), dist 'exp'|'const'|'logn',
          queueMax (Infinity), timeout (client timeout ms, Infinity), retries (0), backoff (ms, base), jitter (bool),
          retryOn: 'timeout' | 'all', failAt(t, R) -> bool (request fails fast), bucket (s, default 1) }
     returns { n, ok, timeouts, rejected, failed, attempts, lat: [ms of successful first-completions], p50, p95, p99,
               util, series: { t:[], rps:[], goodput:[], p99:[], queue:[], util:[] } } */
  K.qsim = function (o) {
    const R = o.R, dur = o.dur || 60, servers = Math.max(1, o.servers || 1);
    const bucket = o.bucket || 1, nb = Math.ceil(dur / bucket);
    const rateAt = o.rateAt || (() => o.rate);
    const svcAt = o.svcAt || ((t, R2) => { const m = o.svc || 10; return o.dist === "const" ? m : o.dist === "logn" ? K.logn(R2, m, o.sigma || 0.5) : K.exp(R2, m); });
    const timeout = o.timeout || Infinity, queueMax = o.queueMax == null ? Infinity : o.queueMax, retries = o.retries || 0;
    const heap = [];
    const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].t <= heap[i].t) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].t < heap[m].t) m = l; if (r < heap.length && heap[r].t < heap[m].t) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    // pre-generate first-attempt arrivals by thinning
    let maxRate = 0; for (let t = 0; t < dur; t += 0.25) maxRate = Math.max(maxRate, rateAt(t));
    if (maxRate > 0) { let t = 0; for (;;) { t += K.exp(R, 1 / maxRate); if (t >= dur) break; if (R.next() * maxRate <= rateAt(t)) push({ t, k: "arr", req: { id: 0, t0: t, att: 0, done: false } }); } }
    const S = { n: 0, ok: 0, timeouts: 0, rejected: 0, failed: 0, attempts: 0, lat: [] };
    const ser = { t: [], rps: [], goodput: [], p99: [], queue: [], util: [], lat: [] };
    for (let b = 0; b < nb; b++) { ser.t.push(b * bucket); ser.rps.push(0); ser.goodput.push(0); ser.queue.push(0); ser.util.push(0); ser.lat.push([]); }
    const B = (t) => Math.min(nb - 1, Math.floor(t / bucket));
    const q = []; let busy = 0, busyTime = 0, lastT = 0, qhead = 0;
    const retry = (req, t) => {
      if (req.att >= retries || req.given) return false;
      const base = (o.backoff || 0) * 2 ** req.att;
      const d = o.jitter ? R.next() * base : base;
      req.att++;
      push({ t: t + d / 1000, k: "arr", req, retry: true }); // backoff is in ms, the clock in s
      return true;
    };
    const startNext = (t) => {
      while (busy < servers && qhead < q.length) {
        const job = q[qhead++];
        if (o.dropExpired && (t - job.ta) * 1000 > timeout) continue;
        busy++;
        push({ t: t + svcAt(t, R) / 1000, k: "done", job });
      }
      if (qhead > 4096 && qhead * 2 > q.length) { q.splice(0, qhead); qhead = 0; }
    };
    while (heap.length) {
      const e = pop();
      if (e.t > dur * 3) break;
      busyTime += busy * (e.t - lastT); lastT = e.t;
      if (e.t < dur) { ser.queue[B(e.t)] = Math.max(ser.queue[B(e.t)], q.length - qhead); }
      if (e.k === "arr") {
        const req = e.req;
        if (!e.retry) S.n++;
        S.attempts++;
        if (e.t < dur) ser.rps[B(e.t)]++;
        if (o.failAt && o.failAt(e.t, R)) { if (!retry(req, e.t)) { S.failed++; req.given = true; } continue; }
        if (q.length - qhead >= queueMax) { if (!retry(req, e.t)) { S.rejected++; req.given = true; } continue; }
        const job = { req, ta: e.t, att: req.att };
        q.push(job);
        if (timeout < Infinity) push({ t: e.t + timeout / 1000, k: "to", job });
        startNext(e.t);
      } else if (e.k === "done") {
        busy--;
        const job = e.job;
        if (!job.timedOut && !job.req.done) {
          job.req.done = true; S.ok++;
          const lat = (e.t - job.req.t0) * 1000;
          S.lat.push(lat);
          if (e.t < dur) { ser.goodput[B(e.t)]++; ser.lat[B(e.t)].push(lat); }
        }
        startNext(e.t);
      } else if (e.k === "to") {
        const job = e.job;
        if (job.req.done) continue;
        job.timedOut = true;
        if (job.att !== job.req.att) continue; // a newer attempt is in flight
        if (!retry(job.req, e.t)) { S.timeouts++; job.req.given = true; }
      }
    }
    for (let b = 0; b < nb; b++) { ser.p99.push(K.quantile(ser.lat[b], 0.99)); ser.rps[b] /= bucket; ser.goodput[b] /= bucket; }
    delete ser.lat;
    const sum = { ...S, p50: K.quantile(S.lat, 0.5), p95: K.quantile(S.lat, 0.95), p99: K.quantile(S.lat, 0.99), util: Math.min(1, busyTime / Math.max(1e-9, lastT) / servers), series: ser };
    sum.errRate = S.n ? 1 - S.ok / S.n : 0;
    sum.amp = S.n ? S.attempts / S.n : 1;
    return sum;
  };

  /* ---------- networking helpers ---------- */
  K.ip = (s) => s.split(".").reduce((a, x) => a * 256 + (+x), 0);
  K.ipStr = (n) => [24, 16, 8, 0].map((b) => Math.floor(n / 2 ** b) % 256).join(".");
  K.cidr = (s) => { const [ip, bits] = s.split("/"); const b = +bits, size = 2 ** (32 - b), base = Math.floor(K.ip(ip) / size) * size; return { base, bits: b, size, first: base, last: base + size - 1, str: `${K.ipStr(base)}/${b}` }; };
  K.inCidr = (ip, c) => { const x = typeof ip === "number" ? ip : K.ip(ip), r = typeof c === "string" ? K.cidr(c) : c; return x >= r.first && x <= r.last; };
  K.overlap = (a, b) => { const x = K.cidr(a), y = K.cidr(b); return x.first <= y.last && y.first <= x.last; };

  /* ---------- versions ---------- */
  K.semver = (s) => String(s).replace(/^v/, "").split(/[.-]/).slice(0, 3).map((x) => +x || 0);
  K.semcmp = (a, b) => { const x = K.semver(a), y = K.semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

  /* ---------- tokens (GenAI): rough estimate of 4 characters per token ---------- */
  K.tokens = (s) => Math.ceil(String(s).length / 4);

  /* ---------- deep helpers ---------- */
  K.clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
  K.stable = function stable(x) {
    if (Array.isArray(x)) return "[" + x.map(stable).join(",") + "]";
    if (x && typeof x === "object") return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + stable(x[k])).join(",") + "}";
    return JSON.stringify(x);
  };
  K.get = (o, path) => path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);

  /* ---------- YAML (the subset real configs use) ----------
     maps, lists (incl. "- key: v" items), nested blocks, scalars (numbers, booleans, null, quoted strings),
     flow collections [a, b] / {a: 1}, block scalars | and >, comments, and "---". Returns {ok, val} or {ok:false, err}. */
  K.yaml = function (src) {
    const raw = String(src).replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
    let i = 0;
    const fail = (ln, m) => { throw new Error(`line ${ln + 1}: ${m}`); };
    const strip = (s) => { let q = null; for (let k = 0; k < s.length; k++) { const c = s[k]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === "#" && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).replace(/\s+$/, ""); } return s.replace(/\s+$/, ""); };
    const peek = () => { while (i < raw.length) { const t = strip(raw[i]); if (t.trim() === "" || t.trim() === "---") { i++; continue; } return { ind: t.match(/^ */)[0].length, text: t.trim(), ln: i }; } return null; };
    const isItem = (t) => t === "-" || t.startsWith("- ");
    const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'{[#-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*)|)$/;
    const unq = (s) => (s[0] === '"' ? JSON.parse(s) : s[0] === "'" ? s.slice(1, -1).replace(/''/g, "'") : s);
    function flow(s, ln) {
      let p = 0;
      const ws = () => { while (p < s.length && /\s/.test(s[p])) p++; };
      const val = () => {
        ws();
        if (s[p] === "[") { p++; const a = []; ws(); if (s[p] === "]") { p++; return a; } for (;;) { a.push(val()); ws(); if (s[p] === ",") { p++; continue; } if (s[p] === "]") { p++; return a; } fail(ln, "bad flow list"); } }
        if (s[p] === "{") { p++; const o = {}; ws(); if (s[p] === "}") { p++; return o; } for (;;) { ws(); const k = atom(":"); ws(); if (s[p] !== ":") fail(ln, "bad flow map"); p++; o[k] = val(); ws(); if (s[p] === ",") { p++; continue; } if (s[p] === "}") { p++; return o; } fail(ln, "bad flow map"); } }
        return scalar(atom(""), ln);
      };
      const atom = (stop) => {
        ws();
        if (s[p] === '"' || s[p] === "'") { const q = s[p]; let j = p + 1; while (j < s.length && (s[j] !== q || (q === '"' && s[j - 1] === "\\"))) j++; const t = s.slice(p, j + 1); p = j + 1; return stop ? unq(t) : t; }
        let j = p; while (j < s.length && !",]}".includes(s[j]) && !(stop && s[j] === stop)) j++;
        const t = s.slice(p, j).trim(); p = j; return t;
      };
      const v = val(); ws();
      if (p < s.length) fail(ln, "unexpected text after flow collection");
      return v;
    }
    function scalar(s, ln) {
      if (s === "" || s === "~" || s === "null") return null;
      if (s[0] === "[" || s[0] === "{") return flow(s, ln);
      if (s[0] === '"' || s[0] === "'") { try { return unq(s); } catch (e) { fail(ln, "bad quoted string"); } }
      if (s === "true" || s === "True") return true;
      if (s === "false" || s === "False") return false;
      if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) && !/^0\d/.test(s)) return Number(s);
      return s;
    }
    function block(ind, style, ln) {
      const lines = [];
      while (i < raw.length) { const t = raw[i]; if (t.trim() !== "" && t.match(/^ */)[0].length <= ind) break; lines.push(t); i++; }
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      const m = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
      const body = lines.map((l) => l.slice(m));
      void ln;
      const keep = style[0] === "|" ? body.join("\n") : body.join(" ").replace(/\s+/g, " ").trim();
      return style.endsWith("-") ? keep : keep + "\n";
    }
    function node(minInd) {
      const L = peek();
      if (!L || L.ind < minInd) return null;
      return isItem(L.text) ? list(L.ind) : map(L.ind);
    }
    function list(ind) {
      const out = [];
      for (;;) {
        const L = peek();
        if (!L || L.ind < ind) break;
        if (L.ind > ind) fail(L.ln, "unexpected indentation");
        if (!isItem(L.text)) break;
        const rest = L.text === "-" ? "" : L.text.slice(1).replace(/^ +/, "");
        const col = L.ind + (L.text.length - rest.length);
        if (rest === "") { i++; out.push(node(ind + 1)); continue; }
        if (KEY.test(rest) && rest[0] !== "[" && rest[0] !== "{") { raw[i] = " ".repeat(col) + rest; out.push(map(col)); continue; }
        if (isItem(rest)) { raw[i] = " ".repeat(col) + rest; out.push(list(col)); continue; }
        i++; out.push(scalar(rest, L.ln));
      }
      return out;
    }
    function map(ind) {
      const o = {};
      for (;;) {
        const L = peek();
        if (!L || L.ind < ind) break;
        if (L.ind > ind) fail(L.ln, "unexpected indentation");
        if (isItem(L.text)) break;
        const m = L.text.match(KEY);
        if (!m) fail(L.ln, `expected "key: value" but found "${L.text}"`);
        const key = unq(m[1]), v = m[2];
        if (Object.prototype.hasOwnProperty.call(o, key)) fail(L.ln, `duplicate key "${key}"`);
        i++;
        if (v === undefined || v === "") {
          const N = peek();
          if (N && N.ind > ind) o[key] = node(N.ind);
          else if (N && N.ind === ind && isItem(N.text)) o[key] = list(ind);
          else o[key] = null;
        } else if (/^[|>][-+]?$/.test(v)) o[key] = block(ind, v, L.ln);
        else o[key] = scalar(v, L.ln);
      }
      return o;
    }
    try {
      const first = peek();
      if (!first) return { ok: true, val: null };
      let val;
      if (!isItem(first.text) && !KEY.test(first.text)) { i++; val = scalar(first.text, first.ln); }
      else val = node(0);
      const rest = peek();
      if (rest) fail(rest.ln, "unexpected indentation or content");
      return { ok: true, val };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  };
  K.json = (src) => { try { return { ok: true, val: JSON.parse(src) }; } catch (e) { return { ok: false, err: e.message }; } };

  /* ---------- shell: build a simulated command line ----------
     defs: [{ re: /^kubectl get pods(?: -n (\S+))?$/, use: "kubectl get pods [-n NS]", desc: "...",
              run(m, st, line) -> "text" | { out: "text", danger?: "why this was risky", silent?: true } }]
     The shell normalises spacing, provides `help` and `clear`, and prints usage for a known command with bad arguments. */
  K.shell = function (defs, o = {}) {
    const words = new Set(defs.map((d) => (d.use || "").split(" ")[0]).filter(Boolean));
    const help = () => "Available commands:\n" + K.cols(defs.filter((d) => d.use && !d.hidden).map((d) => ["  " + d.use, d.desc || ""]), 2) + "\n  clear" + "\n  help";
    const run = (line, st) => {
      const s = String(line).trim().replace(/\s+/g, " ");
      if (!s) return { out: "", silent: true };
      if (s === "help" || s === "?" || s === "--help") return { out: help(), silent: true };
      if (s === "clear") return { out: "", clear: true, silent: true };
      for (const d of defs) {
        const m = s.match(d.re);
        if (m) { const r = d.run(m, st, s); return typeof r === "string" ? { out: r } : r || { out: "" }; }
      }
      const w = s.split(" ")[0];
      if (words.has(w)) {
        const us = defs.filter((d) => d.use && d.use.split(" ")[0] === w && !d.hidden).map((d) => "  " + d.use);
        return { out: `${w}: unrecognised arguments. Usage:\n${us.join("\n")}`, silent: true };
      }
      return { out: `${o.sh || "bash"}: ${w}: command not found (type "help")`, silent: true };
    };
    return { run, help, uses: defs.filter((d) => d.use && !d.hidden).map((d) => d.use) };
  };

  /* ---------- names for realistic scenarios ---------- */
  K.NAMES = {
    svc: ["checkout", "payments", "orders", "inventory", "search", "profile", "auth", "cart", "billing", "notify", "ledger", "catalog", "pricing", "shipping", "reviews", "feed", "media", "gateway", "accounts", "risk"],
    team: ["Payments", "Growth", "Platform", "Search", "Checkout", "Identity", "Data", "Mobile", "Infra", "Risk"],
    table: ["orders", "users", "payments", "events", "invoices", "sessions", "products", "shipments", "accounts", "audit_log"],
    topic: ["orders.created", "payments.settled", "clicks", "inventory.updates", "user.signups", "audit.events", "cart.events", "shipments.tracked"],
    region: ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1", "ap-southeast-1"],
    host: ["web", "api", "worker", "db", "cache", "queue", "batch"],
  };
})();
