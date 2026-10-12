/* Systems Lab · Elasticsearch. Query and mapping levels run against a small in-file Elasticsearch simulator:
   analyzers (standard, simple, whitespace, keyword, english, custom chains with lowercase/asciifolding/stop/stemmer/
   synonym/edge_ngram), an inverted index over seeded documents, BM25 scoring, the bool/match/term/range/phrase/
   multi_match/nested/function_score query DSL, date math with time zones and terms/date_histogram/cardinality aggs.
   The simulator is exposed as LB.es so c-es-2.js can reuse it. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;

  /* =====================================================================
     Elasticsearch simulator
     ===================================================================== */
  class ESErr extends Error { constructor(type, reason, status) { super(reason); this.type = type; this.reason = reason; this.status = status || 400; } }
  const err = (type, reason, status) => { throw new ESErr(type, reason, status); };
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const one = (o, what) => { if (!isObj(o)) err("parsing_exception", `[${what}] query malformed, no start_object after query name`); const ks = Object.keys(o); if (ks.length !== 1) err("parsing_exception", `[${what}] query doesn't support multiple fields, found [${ks.join("] and [")}]`); return [ks[0], o[ks[0]]]; };

  /* ---------- Porter stemmer (the algorithm behind Lucene's PorterStemFilter / the english analyzer) ---------- */
  const porter = (() => {
    const s2 = { ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize", bli: "ble", alli: "al", entli: "ent", eli: "e", ousli: "ous", ization: "ize", ation: "ate", ator: "ate", alism: "al", iveness: "ive", fulness: "ful", ousness: "ous", aliti: "al", iviti: "ive", biliti: "ble", logi: "log" };
    const s3 = { icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "" };
    const c = "[^aeiou]", v = "[aeiouy]", Cs = c + "[^aeiouy]*", Vs = v + "[aeiou]*";
    const mgr0 = new RegExp("^(" + Cs + ")?" + Vs + Cs), meq1 = new RegExp("^(" + Cs + ")?" + Vs + Cs + "(" + Vs + ")?$"), mgr1 = new RegExp("^(" + Cs + ")?" + Vs + Cs + Vs + Cs), sv = new RegExp("^(" + Cs + ")?" + v);
    const cvc = new RegExp("^" + Cs + v + "[^aeiouwxy]$");
    return (w) => {
      if (w.length < 3 || /[^a-z]/.test(w)) return w;
      let fp;
      const y = w[0] === "y";
      if (y) w = "Y" + w.slice(1);
      if (/^(.+?)(ss|i)es$/.test(w)) w = w.replace(/^(.+?)(ss|i)es$/, "$1$2"); else if (/^(.+?)([^s])s$/.test(w)) w = w.replace(/^(.+?)([^s])s$/, "$1$2");
      if ((fp = /^(.+?)eed$/.exec(w))) { if (mgr0.test(fp[1])) w = w.slice(0, -1); }
      else if ((fp = /^(.+?)(ed|ing)$/.exec(w))) {
        const stem = fp[1];
        if (sv.test(stem)) { w = stem; if (/(at|bl|iz)$/.test(w)) w += "e"; else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1); else if (cvc.test(w)) w += "e"; }
      }
      if ((fp = /^(.+?)y$/.exec(w)) && sv.test(fp[1])) w = fp[1] + "i";
      if ((fp = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(w)) && mgr0.test(fp[1])) w = fp[1] + s2[fp[2]];
      if ((fp = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(w)) && mgr0.test(fp[1])) w = fp[1] + s3[fp[2]];
      if ((fp = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w))) { if (mgr1.test(fp[1])) w = fp[1]; }
      else if ((fp = /^(.+?)(s|t)(ion)$/.exec(w))) { if (mgr1.test(fp[1] + fp[2])) w = fp[1] + fp[2]; }
      if ((fp = /^(.+?)e$/.exec(w))) { const stem = fp[1]; if (mgr1.test(stem) || (meq1.test(stem) && !cvc.test(stem))) w = stem; }
      if (/ll$/.test(w) && mgr1.test(w)) w = w.slice(0, -1);
      if (y) w = "y" + w.slice(1);
      return w;
    };
  })();

  /* ---------- analysis ---------- */
  const EN_STOP = new Set("a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with".split(" "));
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/Æ/g, "AE").replace(/ø/g, "o").replace(/Ø/g, "O").replace(/œ/g, "oe").replace(/ł/g, "l");
  // tokenizers -> [{t, pos}]
  const TOKENIZERS = {
    // UAX#29-ish: runs of letters/digits; apostrophes and dots between letters/digits stay inside the token (don't, 2.5, u.s.a)
    standard: (s) => (s.match(/[\p{L}\p{N}_]+(?:[.'’][\p{L}\p{N}_]+)*/gu) || []).map((t, i) => ({ t, pos: i })),
    letter: (s) => (s.match(/\p{L}+/gu) || []).map((t, i) => ({ t, pos: i })),
    whitespace: (s) => (s.match(/\S+/g) || []).map((t, i) => ({ t, pos: i })),
    keyword: (s) => [{ t: s, pos: 0 }],
  };
  const parseSyn = (rules) => {
    const eq = [], map = [];
    arr(rules).forEach((r) => {
      const m = String(r).split("=>");
      const side = (x) => x.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
      if (m.length === 2) map.push({ from: side(m[0]), to: side(m[1]) }); else eq.push(side(m[0]));
    });
    return { eq, map };
  };
  // Synonyms: single- and multi-word; equivalent synonyms emit every alternative at the same position.
  function applySyn(toks, def) {
    const { eq, map } = parseSyn(def.synonyms || []);
    const rules = [];
    eq.forEach((g) => g.forEach((w) => rules.push({ from: w.split(" "), to: g.map((x) => x.split(" ")), keep: true })));
    map.forEach((m) => m.from.forEach((w) => rules.push({ from: w.split(" "), to: m.to.map((x) => x.split(" ")), keep: false })));
    rules.sort((a, b) => b.from.length - a.from.length);
    const out = [];
    let i = 0, shift = 0;
    while (i < toks.length) {
      const r = rules.find((x) => x.from.every((w, k) => toks[i + k] && toks[i + k].t === w));
      if (!r) { out.push({ ...toks[i], pos: toks[i].pos + shift }); i++; continue; }
      const p0 = toks[i].pos + shift;
      const alts = r.to.some((x) => LB.same(x, r.from)) ? r.to : r.keep ? [r.from, ...r.to] : r.to;
      const seen = new Set();
      let maxLen = 0;
      alts.forEach((ws) => { const key = ws.join(" "); if (seen.has(key)) return; seen.add(key); ws.forEach((w, k) => out.push({ t: w, pos: p0 + k, syn: alts.length > 1 })); maxLen = Math.max(maxLen, ws.length); });
      shift += maxLen - r.from.length;
      i += r.from.length;
    }
    return out.sort((a, b) => a.pos - b.pos);
  }
  const FILTERS = {
    lowercase: (ts) => ts.map((x) => ({ ...x, t: x.t.toLowerCase() })),
    uppercase: (ts) => ts.map((x) => ({ ...x, t: x.t.toUpperCase() })),
    asciifolding: (ts) => ts.map((x) => ({ ...x, t: fold(x.t) })),
    stop: (ts, def) => { const set = def && def.stopwords && def.stopwords !== "_english_" ? new Set(arr(def.stopwords).map((w) => String(w).toLowerCase())) : EN_STOP; return ts.filter((x) => !set.has(x.t)); },
    porter_stem: (ts) => ts.map((x) => ({ ...x, t: porter(x.t) })),
    stemmer: (ts, def) => { const lang = (def && (def.language || def.name)) || "english"; if (!/^(english|porter)$/.test(lang)) err("illegal_argument_exception", `the simulator only supports the english stemmer, got [${lang}]`); return ts.map((x) => ({ ...x, t: porter(x.t) })); },
    english_possessive: (ts) => ts.map((x) => ({ ...x, t: x.t.replace(/['’][sS]$/, "") })),
    synonym: (ts, def) => applySyn(ts, def || {}),
    synonym_graph: (ts, def) => applySyn(ts, def || {}),
    edge_ngram: (ts, def) => { const mn = (def && def.min_gram) || 1, mx = (def && def.max_gram) || 2; const out = []; ts.forEach((x) => { for (let n = mn; n <= Math.min(mx, x.t.length); n++) out.push({ ...x, t: x.t.slice(0, n) }); }); return out; },
    unique: (ts) => { const s = new Set(); return ts.filter((x) => (s.has(x.pos + "\u0000" + x.t) ? false : (s.add(x.pos + "\u0000" + x.t), true))); },
    trim: (ts) => ts.map((x) => ({ ...x, t: x.t.trim() })),
  };
  const BUILTIN_AN = {
    standard: { tokenizer: "standard", filter: ["lowercase"] },
    simple: { tokenizer: "letter", filter: ["lowercase"] },
    whitespace: { tokenizer: "whitespace", filter: [] },
    keyword: { tokenizer: "keyword", filter: [] },
    stop: { tokenizer: "letter", filter: ["lowercase", "stop"] },
    english: { tokenizer: "standard", filter: ["english_possessive", "lowercase", "stop", "porter_stem"] },
  };
  // Resolve an analyzer by name (built-in or from index settings.analysis) into a function text -> tokens.
  function analyzerFn(name, analysis) {
    analysis = analysis || {};
    const custom = (analysis.analyzer || {})[name];
    let def = custom || BUILTIN_AN[name];
    if (!def) err("illegal_argument_exception", `failed to find analyzer [${name}]`);
    if (custom && custom.type && custom.type !== "custom") {
      def = BUILTIN_AN[custom.type];
      if (!def) err("illegal_argument_exception", `Unknown analyzer type [${custom.type}] for [${name}]`);
      if (custom.type === "standard" && custom.stopwords) def = { tokenizer: "standard", filter: ["lowercase", { type: "stop", stopwords: custom.stopwords }] };
    }
    const tokName = def.tokenizer || "standard";
    const tdef = (analysis.tokenizer || {})[tokName];
    let tok;
    if (tdef) {
      if (tdef.type === "edge_ngram") {
        const mn = tdef.min_gram || 1, mx = tdef.max_gram || 2, chars = arr(tdef.token_chars);
        tok = (s) => { const words = chars.length ? s.match(chars.includes("digit") ? /[\p{L}\p{N}]+/gu : /\p{L}+/gu) || [] : [s]; const out = []; words.forEach((w) => { for (let n = mn; n <= Math.min(mx, w.length); n++) out.push({ t: w.slice(0, n), pos: out.length }); }); return out; };
      } else if (TOKENIZERS[tdef.type]) tok = TOKENIZERS[tdef.type];
      else err("illegal_argument_exception", `Unknown tokenizer type [${tdef.type}] for [${tokName}]`);
    } else if (TOKENIZERS[tokName]) tok = TOKENIZERS[tokName];
    else err("illegal_argument_exception", `failed to find tokenizer under [${tokName}]`);
    const chain = arr(def.filter).map((f) => {
      if (isObj(f)) { if (!FILTERS[f.type]) err("illegal_argument_exception", `Unknown filter type [${f.type}]`); return (ts) => FILTERS[f.type](ts, f); }
      const fd = (analysis.filter || {})[f];
      if (fd) { if (!FILTERS[fd.type]) err("illegal_argument_exception", `Unknown filter type [${fd.type}] for [${f}]`); return (ts) => FILTERS[fd.type](ts, fd); }
      if (!FILTERS[f]) err("illegal_argument_exception", `failed to find filter under [${f}]`);
      return (ts) => FILTERS[f](ts, null);
    });
    const charf = arr(def.char_filter).map((cf) => { if (cf === "html_strip") return (s) => s.replace(/<[^>]*>/g, " "); err("illegal_argument_exception", `failed to find char_filter under [${cf}]`); return null; });
    return (text) => { let s = String(text); charf.forEach((f) => (s = f(s))); let ts = tok(s); chain.forEach((f) => (ts = f(ts))); return ts.filter((x) => x.t !== ""); };
  }
  function normalizerFn(name, analysis) {
    if (name === "lowercase") return (s) => String(s).toLowerCase();
    const def = ((analysis || {}).normalizer || {})[name];
    if (!def) err("illegal_argument_exception", `normalizer [${name}] not found`);
    const fs = arr(def.filter).map((f) => {
      const fd = ((analysis || {}).filter || {})[f];
      const type = fd ? fd.type : f;
      if (!["lowercase", "uppercase", "asciifolding", "trim"].includes(type)) err("illegal_argument_exception", `Custom normalizer [${name}] may not use filter [${f}]`);
      return (s) => FILTERS[type]([{ t: s, pos: 0 }])[0].t;
    });
    return (s) => { let x = String(s); fs.forEach((f) => (x = f(x))); return x; };
  }

  /* ---------- dates, date math and time zones ---------- */
  const tzCache = new Map();
  const tzOffsetAt = (tz, ms) => { // minutes east of UTC at instant ms
    if (!tz || tz === "UTC" || tz === "Z" || tz === "GMT" || tz === "Etc/UTC") return 0;
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
    if (m) return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
    let f = tzCache.get(tz);
    if (!f) {
      try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
      catch (e) { err("illegal_argument_exception", `Unknown time-zone ID: ${tz}`); }
      tzCache.set(tz, f);
    }
    const p = {}; f.formatToParts(new Date(ms)).forEach((x) => (p[x.type] = x.value));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  };
  const localToUtc = (wall, tz) => { let off = tzOffsetAt(tz, wall); let t = wall - off * 60000; off = tzOffsetAt(tz, t); return wall - off * 60000; };
  // Parse an absolute date. Strings without an offset are read in tz (default UTC).
  function parseDate(v, tz) {
    if (typeof v === "number") return v;
    const s = String(v).trim();
    if (/^\d{10,}$/.test(s)) return +s;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if (!m) err("parse_exception", `failed to parse date field [${s}] with format [strict_date_optional_time||epoch_millis]`);
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +((m[7] || "0").padEnd(3, "0")));
    if (m[8]) return m[8] === "Z" ? wall : wall - tzOffsetAt(m[8].length === 5 ? m[8].slice(0, 3) + ":" + m[8].slice(3) : m[8], 0) * 60000;
    return localToUtc(wall, tz);
  }
  const UNIT = { y: "year", M: "month", w: "week", d: "day", h: "hour", H: "hour", m: "minute", s: "second" };
  function addUnit(ms, n, u, tz) {
    const off = tzOffsetAt(tz, ms), d = new Date(ms + off * 60000);
    if (u === "y") d.setUTCFullYear(d.getUTCFullYear() + n); else if (u === "M") d.setUTCMonth(d.getUTCMonth() + n);
    else if (u === "w") d.setUTCDate(d.getUTCDate() + 7 * n); else if (u === "d") d.setUTCDate(d.getUTCDate() + n);
    else return ms + n * { h: 3600000, H: 3600000, m: 60000, s: 1000 }[u];
    return localToUtc(d.getTime(), tz);
  }
  function roundDown(ms, u, tz) {
    const off = tzOffsetAt(tz, ms), d = new Date(ms + off * 60000);
    const Y = d.getUTCFullYear(), Mo = d.getUTCMonth(), Da = d.getUTCDate(), h = d.getUTCHours(), mi = d.getUTCMinutes(), se = d.getUTCSeconds();
    let w;
    if (u === "y") w = Date.UTC(Y, 0, 1); else if (u === "M") w = Date.UTC(Y, Mo, 1);
    else if (u === "w") { const dow = (d.getUTCDay() + 6) % 7; w = Date.UTC(Y, Mo, Da - dow); }
    else if (u === "d") w = Date.UTC(Y, Mo, Da); else if (u === "h" || u === "H") w = Date.UTC(Y, Mo, Da, h);
    else if (u === "m") w = Date.UTC(Y, Mo, Da, h, mi); else w = Date.UTC(Y, Mo, Da, h, mi, se);
    return localToUtc(w, tz);
  }
  // Date math: "now-7d/d", "2026-07-01||+1M/M". roundUp = true for gt and lte (rounds to the last ms of the unit).
  function dateMath(v, o) {
    const s = String(v).trim();
    let anchor, rest;
    if (s.startsWith("now")) { anchor = o.now; rest = s.slice(3); }
    else if (s.includes("||")) { const [a, b] = s.split("||"); anchor = parseDate(a, o.tz); rest = b; }
    else return parseDate(s, o.tz);
    let t = anchor;
    const re = /([+-])(\d+)([yMwdhHms])|\/([yMwdhHms])/g;
    let m, pos = 0;
    while ((m = re.exec(rest))) {
      if (m.index !== pos) err("parse_exception", `failed to parse date math [${s}]`);
      pos = re.lastIndex;
      if (m[4]) { t = roundDown(t, m[4], o.tz); if (o.roundUp) t = addUnit(t, 1, m[4], o.tz) - 1; }
      else t = addUnit(t, (m[1] === "-" ? -1 : 1) * +m[2], m[3], o.tz);
    }
    if (pos !== rest.length) err("parse_exception", `failed to parse date math [${s}]`);
    return t;
  }
  const iso = (ms, tz) => { const off = tzOffsetAt(tz, ms); const s = new Date(ms + off * 60000).toISOString().replace(/\.000Z$/, "").replace(/Z$/, ""); return s + (off ? (off > 0 ? "+" : "-") + String(Math.floor(Math.abs(off) / 60)).padStart(2, "0") + ":" + String(Math.abs(off) % 60).padStart(2, "0") : "Z"); };

  /* ---------- mappings ---------- */
  const TYPES = new Set(["text", "keyword", "long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "date", "boolean", "object", "nested", "flattened", "dense_vector", "search_as_you_type", "match_only_text", "wildcard", "constant_keyword", "ip"]);
  const NUMERIC = new Set(["long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float"]);
  // Flatten a mapping into a Map path -> field def ({type, analyzer, ..., nestedPath, multi})
  function compileMapping(props, analysis, prefix = "", nestedPath = null, out = new Map()) {
    Object.entries(props || {}).forEach(([name, d]) => {
      if (!isObj(d)) err("mapper_parsing_exception", `Expected map for property [fields] on field [${name}] but got a class java.lang.String`);
      const path = prefix + name;
      const type = d.type || (d.properties || d.enabled === false || d.dynamic != null ? "object" : null);
      if (!type) err("mapper_parsing_exception", `No type specified for field [${path}]`);
      if (!TYPES.has(type)) err("mapper_parsing_exception", `No handler for type [${type}] declared on field [${name}]`);
      if (type === "text" || type === "search_as_you_type") {
        analyzerFn(d.analyzer || "standard", analysis);
        const ian = (analysis.analyzer || {})[d.analyzer || "standard"];
        if (ian) { const upd = arr(ian.filter).filter((x) => { const fd = isObj(x) ? x : (analysis.filter || {})[x]; return fd && fd.updateable; }); if (upd.length) err("illegal_argument_exception", `Analyzer [${d.analyzer}] contains filters [${upd.join(",")}] that are not allowed to run in index time mode.`); }
        if (d.search_analyzer) analyzerFn(d.search_analyzer, analysis);
        if (d.search_analyzer && !d.analyzer) err("mapper_parsing_exception", `analyzer on field [${path}] must be set when search_analyzer is set`);
      } else {
        ["analyzer", "search_analyzer"].forEach((k) => { if (d[k] != null) err("mapper_parsing_exception", `unknown parameter [${k}] on mapper [${path}] of type [${type}]`); });
      }
      if (d.normalizer != null) { if (type !== "keyword") err("mapper_parsing_exception", `unknown parameter [normalizer] on mapper [${path}] of type [${type}]`); normalizerFn(d.normalizer, analysis); }
      const f = { ...d, type, path, nestedPath };
      delete f.properties; delete f.fields;
      out.set(path, f);
      if (type === "object" || type === "nested") compileMapping(d.properties, analysis, path + ".", type === "nested" ? path : nestedPath, out);
      if (d.fields) Object.entries(d.fields).forEach(([sub, sd]) => {
        const st = sd.type;
        if (!TYPES.has(st) || st === "object" || st === "nested") err("mapper_parsing_exception", `No handler for type [${st}] declared on field [${sub}]`);
        if (st === "text") analyzerFn(sd.analyzer || "standard", analysis);
        if (sd.normalizer) normalizerFn(sd.normalizer, analysis);
        out.set(path + "." + sub, { ...sd, type: st, path: path + "." + sub, nestedPath, multi: true });
      });
    });
    return out;
  }
  const countFields = (fields) => [...fields.values()].length;

  /* ---------- index ---------- */
  // body: { settings: {analysis, index:{...}, ...}, mappings: {dynamic, properties} }; o.now for date math
  function createIndex(body, o = {}) {
    body = body || {};
    const settings = body.settings || {};
    const analysis = settings.analysis || (settings.index && settings.index.analysis) || {};
    Object.entries(analysis.analyzer || {}).forEach(([n]) => analyzerFn(n, analysis));
    const mappings = body.mappings || {};
    if (mappings.properties == null && Object.keys(mappings).some((k) => !["dynamic", "properties", "dynamic_templates", "_source", "date_detection", "numeric_detection"].includes(k))) err("mapper_parsing_exception", `Root mapping definition has unsupported parameters: [${Object.keys(mappings).join(", ")}]`);
    const fields = compileMapping(mappings.properties || {}, analysis);
    const flat = {}; Object.entries(settings).forEach(([k, v]) => { if (k === "index" && isObj(v)) Object.assign(flat, v); else flat[k.replace(/^index\./, "")] = v; });
    const idx = { analysis, fields, dynamic: mappings.dynamic == null ? true : mappings.dynamic, limit: +(flat["mapping.total_fields.limit"] || (flat.mapping && flat.mapping.total_fields && flat.mapping.total_fields.limit) || 1000), docs: [], now: o.now || Date.UTC(2026, 6, 15, 10, 0, 0), maxWindow: +(flat.max_result_window || 10000), seq: 0 };
    if (countFields(fields) > idx.limit) err("illegal_argument_exception", `Limit of total fields [${idx.limit}] has been exceeded`);
    return idx;
  }
  const dynType = (v) => {
    if (typeof v === "boolean") return { type: "boolean" };
    if (typeof v === "number") return { type: Number.isInteger(v) ? "long" : "float" };
    if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) ? { type: "date" } : { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } };
    return null;
  };
  // Walk a source object, adding dynamic fields as needed. Returns the new field defs to add (path -> def).
  function walk(idx, src, prefix, nestedPath, added, ctx) {
    Object.entries(src).forEach(([k, v]) => {
      const path = prefix + k;
      let f = idx.fields.get(path) || added.get(path);
      const vals = arr(v).filter((x) => x != null);
      if (!vals.length) return;
      if (!f) {
        // dynamic: true (default), "runtime", false (ignore), "strict" (reject); inherited from the closest object
        const dyn = ctx.dyn;
        if (dyn === "strict") err("strict_dynamic_mapping_exception", `[${path}] dynamic introduction of [${k}] within [${prefix ? prefix.slice(0, -1) : "_doc"}] is not allowed`);
        if (dyn === false || dyn === "false") return;
        const first = vals[0];
        const t = isObj(first) ? { type: "object" } : dynType(first);
        if (!t) return;
        f = { ...t, path, nestedPath, dynamic: true };
        delete f.fields;
        added.set(path, f);
        if (t.fields) added.set(path + ".keyword", { type: "keyword", ignore_above: 256, path: path + ".keyword", nestedPath, multi: true, dynamic: true });
      }
      if (f.type === "flattened" || f.enabled === false) return;
      if (f.type === "object" || f.type === "nested") {
        vals.forEach((x) => {
          if (!isObj(x)) err("document_parsing_exception", `[1:${(k.length + 4)}] object mapping for [${path}] tried to parse field [${k}] as object, but found a concrete value`);
          walk(idx, x, path + ".", f.type === "nested" ? path : nestedPath, added, { dyn: f.dynamic != null ? f.dynamic : ctx.dyn });
        });
        return;
      }
      vals.forEach((x) => {
        if (isObj(x)) err("document_parsing_exception", `[1:${(k.length + 4)}] failed to parse field [${path}] of type [${f.type}] in document. Preview of field's value: '${JSON.stringify(x).slice(0, 40)}'`);
        coerce(f, x, path);
      });
    });
  }
  // Validate / coerce a value for a field type (throws like ES on bad values).
  function coerce(f, x, path) {
    if (NUMERIC.has(f.type)) {
      const n = typeof x === "number" ? x : f.coerce === false ? NaN : x === "" ? NaN : Number(x);
      if (typeof x === "boolean" || !Number.isFinite(n)) err("document_parsing_exception", `failed to parse field [${path}] of type [${f.type}] in document. Preview of field's value: '${x}'`);
      if (typeof x === "string" && f.coerce === false) err("document_parsing_exception", `failed to parse field [${path}] of type [${f.type}] in document`);
      return ["long", "integer", "short", "byte"].includes(f.type) ? Math.trunc(n) : n;
    }
    if (f.type === "date") { try { return parseDate(x, "UTC"); } catch (e) { err("document_parsing_exception", `failed to parse field [${path}] of type [date] in document. Preview of field's value: '${x}'`); } }
    if (f.type === "boolean") { if (x === true || x === "true") return true; if (x === false || x === "false" || x === "") return false; err("document_parsing_exception", `failed to parse field [${path}] of type [boolean] in document. Preview of field's value: '${x}'`); }
    return typeof x === "string" ? x : String(x);
  }
  // Index one document. Returns {result, added:[paths], coerced:[...]} or throws ESErr.
  function indexDoc(idx, id, src) {
    if (!isObj(src)) err("mapper_parsing_exception", "failed to parse, document is empty");
    const added = new Map();
    walk(idx, src, "", null, added, { dyn: idx.dynamic });
    if (countFields(idx.fields) + added.size > idx.limit) err("illegal_argument_exception", `Limit of total fields [${idx.limit}] has been exceeded while adding new fields [${added.size}]`);
    added.forEach((f, p) => idx.fields.set(p, f));
    const doc = { id: String(id), src: K.clone(src), ord: idx.docs.length, seq: idx.seq++ };
    const ex = idx.docs.findIndex((d) => d.id === doc.id);
    buildDoc(idx, doc);
    if (ex >= 0) { doc.ord = idx.docs[ex].ord; idx.docs[ex] = doc; } else idx.docs.push(doc);
    return { result: ex >= 0 ? "updated" : "created", added: [...added.keys()] };
  }
  // Build per-field postings for a doc: root values plus nested sub-docs.
  function buildDoc(idx, doc) {
    const root = { f: {}, nested: {} };
    const put = (scope, path, f, x) => {
      const e = (scope.f[path] = scope.f[path] || { toks: [], vals: [], len: 0, gap: 0 });
      if (f.type === "text" || f.type === "search_as_you_type" || f.type === "match_only_text") {
        const ts = analyzerFn(f.analyzer || "standard", idx.analysis)(x);
        const base = e.len ? e.gap + 100 : 0;
        ts.forEach((t) => e.toks.push({ t: t.t, pos: base + t.pos }));
        e.gap = base + (ts.length ? ts[ts.length - 1].pos + 1 : 0);
        e.len += ts.length;
      } else if (f.type === "keyword" || f.type === "wildcard" || f.type === "constant_keyword") {
        const s = String(x);
        if (f.ignore_above && s.length > f.ignore_above) return;
        e.vals.push(f.normalizer ? normalizerFn(f.normalizer, idx.analysis)(s) : s);
      } else if (f.type === "flattened") {
        // index every leaf as "key\0value" on the root field and on path.key
        const leaves = (o, pre) => Object.entries(o).forEach(([k, v]) => arr(v).forEach((y) => (isObj(y) ? leaves(y, pre + k + ".") : (e.vals.push(String(y)), put(scope, path + "." + pre + k, { type: "keyword" }, y)))));
        if (isObj(x)) leaves(x, "");
      } else e.vals.push(coerce(f, x, path));
    };
    const walkDoc = (scope, o, prefix) => Object.entries(o).forEach(([k, v]) => {
      const path = prefix + k, f = idx.fields.get(path);
      if (!f) return;
      arr(v).filter((x) => x != null).forEach((x) => {
        if (f.type === "nested") { const sub = { f: {}, nested: {}, src: x }; (scope.nested[path] = scope.nested[path] || []).push(sub); walkDoc(sub, x, path + "."); if (f.include_in_parent || f.include_in_root) walkDoc(scope, x, path + "."); return; }
        if (f.enabled === false) return;
        if (f.type === "object") { if (isObj(x)) walkDoc(scope, x, path + "."); return; }
        if (f.type === "flattened") { put(scope, path, f, x); return; }
        put(scope, path, f, x);
        idx.fields.forEach((g, gp) => { if (g.multi && gp.startsWith(path + ".") && gp.indexOf(".", path.length + 1) < 0) put(scope, gp, g, x); });
      });
    });
    walkDoc(root, doc.src, "");
    doc.root = root;
  }

  /* ---------- search ---------- */
  const K1 = 1.2, B = 0.75;
  const editDist = (a, b, max) => { // optimal string alignment (Damerau) distance, early exit
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d = []; for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      let best = Infinity;
      for (let j = 1; j <= b.length; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        best = Math.min(best, d[i][j]);
      }
      if (best > max) return max + 1;
    }
    return d[a.length][b.length];
  };
  const autoFuzz = (f, len) => {
    if (f == null) return 0;
    const s = String(f);
    const m = /^AUTO(?::(\d+),(\d+))?$/i.exec(s);
    if (m) { const lo = m[1] ? +m[1] : 3, hi = m[2] ? +m[2] : 6; return len < lo ? 0 : len < hi ? 1 : 2; }
    const n = +s; if (!Number.isFinite(n) || n < 0 || n > 2) err("illegal_argument_exception", `fuzziness [${s}] is not supported: valid values are 0, 1, 2 or AUTO`);
    return n;
  };
  // Search context: a set of scopes (root docs, or nested sub-docs for a nested query) with stats.
  function Ctx(idx, scopes, nestedPath) { this.idx = idx; this.scopes = scopes; this.nestedPath = nestedPath || null; this.stats = new Map(); }
  Ctx.prototype.field = function (name, what) {
    let f = this.idx.fields.get(name);
    if (!f) {
      const parts = name.split(".");
      for (let i = parts.length - 1; i > 0; i--) { const pf = this.idx.fields.get(parts.slice(0, i).join(".")); if (pf && pf.type === "flattened") return { type: "keyword", path: name, nestedPath: pf.nestedPath }; }
      return null;
    }
    if ((f.nestedPath || null) !== this.nestedPath && f.nestedPath && !(this.nestedPath && f.nestedPath.startsWith(this.nestedPath))) return { ...f, hidden: true };
    void what;
    return f;
  };
  Ctx.prototype.stat = function (field) {
    let s = this.stats.get(field);
    if (s) return s;
    let n = 0, tot = 0;
    const df = new Map();
    this.scopes.forEach((sc) => { const e = sc.f[field]; if (!e) return; const cnt = e.toks.length || e.vals.length; if (!cnt) return; n++; tot += e.toks.length || e.vals.length; new Set(e.toks.length ? e.toks.map((t) => t.t) : e.vals.map(String)).forEach((t) => df.set(t, (df.get(t) || 0) + 1)); });
    s = { n, avg: n ? tot / n : 1, df };
    this.stats.set(field, s);
    return s;
  };
  Ctx.prototype.bm25 = function (field, term, tf, dl, norms) {
    const s = this.stat(field), n = s.df.get(term) || 0;
    const idf = Math.log(1 + (s.n - n + 0.5) / (n + 0.5));
    const tfn = norms === false ? tf / (tf + K1) : tf / (tf + K1 * (1 - B + (B * dl) / s.avg));
    return idf * tfn;
  };
  const EMPTY = { toks: [], vals: [], len: 0 };
  // Each compiled query: (scope) -> score (number >= 0) when it matches, or -1 when it doesn't.
  function textFields(f) { return f && (f.type === "text" || f.type === "search_as_you_type" || f.type === "match_only_text"); }
  function searchAnalyzer(idx, f, override) { return analyzerFn(override || f.search_analyzer || f.analyzer || "standard", idx.analysis); }
  function keyNorm(idx, f, v) { return f.normalizer ? normalizerFn(f.normalizer, idx.analysis)(String(v)) : String(v); }
  function termMatcher(ctx, f, field, value, boost, opts = {}) {
    // value already analysed / normalised as needed; returns scorer
    if (f.type === "flattened") {
      return (sc) => { const e = sc.f[field] || EMPTY; return e.vals.includes(String(value)) ? boost * 1 : -1; };
    }
    if (textFields(f)) {
      return (sc) => {
        const e = sc.f[field] || EMPTY;
        const tf = e.toks.filter((t) => t.t === value).length;
        return tf ? boost * ctx.bm25(field, value, tf, e.len) : -1;
      };
    }
    if (f.type === "keyword" || f.type === "wildcard" || f.type === "constant_keyword") {
      return (sc) => {
        const e = sc.f[field] || EMPTY;
        const hit = opts.ci ? e.vals.some((x) => x.toLowerCase() === String(value).toLowerCase()) : e.vals.includes(String(value));
        return hit ? boost * (opts.noscore ? 1 : ctx.bm25(field, String(value), 1, 1, false)) : -1;
      };
    }
    let v;
    if (NUMERIC.has(f.type)) { v = Number(value); if (!Number.isFinite(v)) err("query_shard_exception", `failed to create query: For input string: "${value}"`); }
    else if (f.type === "date") v = dateMath(value, { now: ctx.idx.now, tz: "UTC" });
    else if (f.type === "boolean") v = value === true || value === "true";
    else v = value;
    return (sc) => { const e = sc.f[field] || EMPTY; return e.vals.some((x) => x === v) ? boost : -1; };
  }
  const NONE = () => -1;

  function compile(ctx, q) {
    if (!isObj(q)) err("parsing_exception", "query malformed, must start with start_object");
    const keys = Object.keys(q);
    if (keys.length !== 1) err("parsing_exception", keys.length ? `[${keys[1]}] malformed query, expected [END_OBJECT] but found [FIELD_NAME]` : "query malformed, empty clause found");
    const type = keys[0], body = q[type];
    const C = COMPILERS[type];
    if (!C) err("parsing_exception", `unknown query [${type}]`);
    return C(ctx, body);
  }
  // match-family helper: per position groups of tokens, combined with operator / minimum_should_match
  function msmCount(spec, n) {
    if (spec == null) return null;
    const s = String(spec).trim();
    let m;
    if ((m = /^(-?\d+)%$/.exec(s))) { const p = +m[1]; const k = Math.floor((n * Math.abs(p)) / 100); return p < 0 ? n - k : k; }
    if ((m = /^-?\d+$/.exec(s))) { const k = +s; return k < 0 ? n + k : k; }
    err("illegal_argument_exception", `minimum_should_match [${s}] is not supported here (use a number or a percentage)`);
    return null;
  }
  function matchQuery(ctx, field, p, extraBoost = 1) {
    const f = ctx.field(field);
    if (!f || f.hidden) return NONE;
    const boost = (p.boost == null ? 1 : +p.boost) * extraBoost;
    const text = p.query;
    if (text == null) err("parsing_exception", `No text specified for text query`);
    if (!textFields(f)) {
      // keyword/numeric/date: the whole input is one term (keyword normaliser applies)
      if (f.type === "keyword") return termMatcher(ctx, f, field, keyNorm(ctx.idx, f, text), boost);
      if (f.type === "flattened") return termMatcher(ctx, f, field, String(text), boost);
      if (NUMERIC.has(f.type) && !Number.isFinite(Number(text))) { if (p.lenient) return NONE; err("query_shard_exception", `failed to create query: For input string: "${text}"`); }
      return termMatcher(ctx, f, field, text, boost);
    }
    const toks = searchAnalyzer(ctx.idx, f, p.analyzer)(String(text));
    if (!toks.length) return p.zero_terms_query === "all" ? () => 0 : NONE;
    const groups = new Map();
    toks.forEach((t) => { if (!groups.has(t.pos)) groups.set(t.pos, []); if (!groups.get(t.pos).includes(t.t)) groups.get(t.pos).push(t.t); });
    const G = [...groups.values()];
    const lastIsPrefix = p._prefixLast;
    const scorers = G.map((terms, gi) => {
      const subs = [];
      terms.forEach((t) => {
        const fz = autoFuzz(p.fuzziness, t.length);
        if (lastIsPrefix && gi === G.length - 1) { subs.push((sc) => { const e = sc.f[field] || EMPTY; return e.toks.some((x) => x.t.startsWith(t)) ? boost : -1; }); return; }
        if (!fz) { subs.push(termMatcher(ctx, f, field, t, boost)); return; }
        const pl = +(p.prefix_length || 0), maxExp = +(p.max_expansions || 50);
        const st = ctx.stat(field);
        const cands = [...st.df.keys()].filter((x) => x.slice(0, pl) === t.slice(0, pl)).map((x) => ({ x, d: editDist(t, x, fz) })).filter((c) => c.d <= fz && (p.fuzzy_transpositions !== false || c.d === editDist(t, c.x, fz)))
          .sort((a, b) => a.d - b.d || (a.x < b.x ? -1 : 1)).slice(0, maxExp);
        cands.forEach((c) => { const sim = 1 - c.d / Math.min(t.length, c.x.length); const m = termMatcher(ctx, f, field, c.x, boost * Math.max(0, sim)); subs.push(m); });
      });
      // a position group scores as the best of its alternatives (Lucene blends them in a SynonymQuery)
      return (sc) => { let best = -1; subs.forEach((s) => { const v = s(sc); if (v > best) best = v; }); return best; };
    });
    const n = scorers.length;
    let need = p.operator && String(p.operator).toLowerCase() === "and" ? n : 1;
    const m = msmCount(p.minimum_should_match, n);
    if (m != null && !(p.operator && String(p.operator).toLowerCase() === "and")) need = Math.max(1, m);
    return (sc) => { let s = 0, hit = 0; scorers.forEach((g) => { const v = g(sc); if (v >= 0) { hit++; s += v; } }); return hit >= need ? s : -1; };
  }
  function phraseQuery(ctx, field, p, extraBoost = 1) {
    const f = ctx.field(field);
    if (!f || f.hidden) return NONE;
    if (!textFields(f)) return matchQuery(ctx, field, { query: p.query, boost: p.boost }, extraBoost);
    const boost = (p.boost == null ? 1 : +p.boost) * extraBoost, slop = +(p.slop || 0);
    const toks = searchAnalyzer(ctx.idx, f, p.analyzer)(String(p.query));
    if (!toks.length) return NONE;
    const qp = []; toks.forEach((t) => { const g = qp.find((x) => x.pos === t.pos); if (g) g.terms.push(t.t); else qp.push({ pos: t.pos, terms: [t.t] }); });
    return (sc) => {
      const e = sc.f[field] || EMPTY;
      const posOf = qp.map((g) => e.toks.filter((t) => g.terms.includes(t.t)).map((t) => t.pos));
      if (posOf.some((x) => !x.length)) return -1;
      let freq = 0;
      const rec = (i, chosen) => {
        if (i === qp.length) { const ds = chosen.map((p0, k) => p0 - qp[k].pos); const span = Math.max(...ds) - Math.min(...ds); if (span <= slop && new Set(chosen).size === chosen.length) freq += 1 / (1 + span); return; }
        posOf[i].forEach((x) => { if (freq < 50) rec(i + 1, [...chosen, x]); });
      };
      rec(0, []);
      if (!freq) return -1;
      const idf = qp.reduce((s, g) => { const st = ctx.stat(field), n = Math.max(...g.terms.map((t) => st.df.get(t) || 0)); return s + Math.log(1 + (st.n - n + 0.5) / (n + 0.5)); }, 0);
      const st = ctx.stat(field);
      return boost * idf * (freq / (freq + K1 * (1 - B + (B * e.len) / st.avg)));
    };
  }
  const fieldBoost = (s) => { const m = /^(.*?)(?:\^(\d+(?:\.\d+)?))?$/.exec(String(s)); return [m[1], m[2] ? +m[2] : 1]; };
  const expandFields = (ctx, pat) => { if (!pat.includes("*")) return [pat]; const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); return [...ctx.idx.fields.keys()].filter((k) => re.test(k) && textFields(ctx.idx.fields.get(k))); };
  const COMPILERS = {
    match_all: (ctx, b) => { const bo = (b && b.boost) || 1; return () => bo; },
    match_none: () => NONE,
    match: (ctx, b) => { const [field, v] = one(b, "match"); return matchQuery(ctx, field, isObj(v) ? v : { query: v }); },
    match_phrase: (ctx, b) => { const [field, v] = one(b, "match_phrase"); return phraseQuery(ctx, field, isObj(v) ? v : { query: v }); },
    match_phrase_prefix: (ctx, b) => { const [field, v] = one(b, "match_phrase_prefix"); return matchQuery(ctx, field, { ...(isObj(v) ? v : { query: v }), operator: "and", _prefixLast: true }); },
    match_bool_prefix: (ctx, b) => { const [field, v] = one(b, "match_bool_prefix"); return matchQuery(ctx, field, { ...(isObj(v) ? v : { query: v }), _prefixLast: true }); },
    multi_match: (ctx, b) => {
      if (!isObj(b) || b.query == null) err("parsing_exception", "[multi_match] requires query value");
      const fl = arr(b.fields || ["*"]).flatMap((s) => { const [n, bo] = fieldBoost(s); return expandFields(ctx, n).map((x) => [x, bo]); });
      const type = b.type || "best_fields", tb = b.tie_breaker == null ? (type === "most_fields" ? 1 : 0) : +b.tie_breaker;
      if (!["best_fields", "most_fields", "phrase", "phrase_prefix", "cross_fields", "bool_prefix"].includes(type)) err("illegal_argument_exception", `No type found for name: ${type}`);
      const base = { query: b.query, operator: b.operator, minimum_should_match: b.minimum_should_match, fuzziness: b.fuzziness, prefix_length: b.prefix_length, analyzer: b.analyzer, slop: b.slop };
      const subs = fl.map(([fname, bo]) => (type === "phrase" ? phraseQuery(ctx, fname, base, bo) : matchQuery(ctx, fname, { ...base, _prefixLast: type === "phrase_prefix" || type === "bool_prefix" }, bo)));
      const top = b.boost == null ? 1 : +b.boost;
      return (sc) => { let best = -1, sum = 0; subs.forEach((s) => { const v = s(sc); if (v >= 0) { sum += v; if (v > best) best = v; } }); return best < 0 ? -1 : top * (best + tb * (sum - best)); };
    },
    term: (ctx, b) => {
      const [field, v] = one(b, "term");
      const p = isObj(v) ? v : { value: v };
      if (p.value == null) err("parsing_exception", "[term] query does not support [" + Object.keys(p).join(",") + "]");
      const f = ctx.field(field);
      if (!f || f.hidden) return NONE;
      const val = f.type === "keyword" ? keyNorm(ctx.idx, f, p.value) : p.value;
      return termMatcher(ctx, f, field, typeof val === "string" && textFields(f) ? val : val, p.boost == null ? 1 : +p.boost, { ci: !!p.case_insensitive });
    },
    terms: (ctx, b) => {
      const ks = Object.keys(b || {}).filter((k) => k !== "boost");
      if (ks.length !== 1 || !Array.isArray(b[ks[0]])) err("parsing_exception", "[terms] query requires a field name with an array of values");
      const f = ctx.field(ks[0]);
      if (!f || f.hidden) return NONE;
      const ms = b[ks[0]].map((v) => termMatcher(ctx, f, ks[0], f.type === "keyword" ? keyNorm(ctx.idx, f, v) : v, 1, { noscore: true }));
      const bo = b.boost == null ? 1 : +b.boost;
      return (sc) => (ms.some((m) => m(sc) >= 0) ? bo : -1);
    },
    ids: (ctx, b) => { const vs = arr(b && b.values).map(String); return (sc) => (sc.id != null && vs.includes(sc.id) ? 1 : -1); },
    exists: (ctx, b) => { const field = b && b.field; const fs = [...ctx.idx.fields.keys()].filter((k) => k === field || k.startsWith(field + ".")); return (sc) => (fs.some((k) => { const e = sc.f[k]; return e && (e.toks.length || e.vals.length); }) || (sc.nested && Object.keys(sc.nested).some((k) => k === field)) ? 1 : -1); },
    prefix: (ctx, b) => {
      const [field, v] = one(b, "prefix"); const p = isObj(v) ? v : { value: v }; const f = ctx.field(field);
      if (!f || f.hidden) return NONE;
      const val = f.type === "keyword" ? keyNorm(ctx.idx, f, p.value) : String(p.value);
      return (sc) => { const e = sc.f[field] || EMPTY; const xs = e.toks.length ? e.toks.map((t) => t.t) : e.vals.map(String); const ci = p.case_insensitive; return xs.some((x) => (ci ? x.toLowerCase().startsWith(val.toLowerCase()) : x.startsWith(val))) ? 1 : -1; };
    },
    wildcard: (ctx, b) => {
      const [field, v] = one(b, "wildcard"); const p = isObj(v) ? v : { value: v }; const f = ctx.field(field);
      if (!f || f.hidden) return NONE;
      const re = new RegExp("^" + String(p.value || p.wildcard).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", p.case_insensitive ? "i" : "");
      return (sc) => { const e = sc.f[field] || EMPTY; const xs = e.toks.length ? e.toks.map((t) => t.t) : e.vals.map(String); return xs.some((x) => re.test(x)) ? 1 : -1; };
    },
    fuzzy: (ctx, b) => { const [field, v] = one(b, "fuzzy"); const p = isObj(v) ? v : { value: v }; return matchQuery(ctx, field, { query: p.value, fuzziness: p.fuzziness == null ? "AUTO" : p.fuzziness, prefix_length: p.prefix_length, max_expansions: p.max_expansions, boost: p.boost }); },
    range: (ctx, b) => {
      const [field, p] = one(b, "range");
      const f = ctx.field(field);
      if (!f || f.hidden) return NONE;
      const ok = ["gt", "gte", "lt", "lte", "time_zone", "format", "boost", "relation"];
      Object.keys(p).forEach((k) => { if (!ok.includes(k)) err("parsing_exception", `[range] query does not support [${k}]`); });
      const conv = (x, roundUp) => {
        if (f.type === "date") return dateMath(x, { now: ctx.idx.now, tz: p.time_zone || "UTC", roundUp });
        if (NUMERIC.has(f.type)) { const n = Number(x); if (!Number.isFinite(n)) err("query_shard_exception", `failed to create query: For input string: "${x}"`); return n; }
        return String(x);
      };
      const lo = p.gte != null ? [conv(p.gte, false), true] : p.gt != null ? [conv(p.gt, true), false] : null;
      const hi = p.lte != null ? [conv(p.lte, true), true] : p.lt != null ? [conv(p.lt, false), false] : null;
      const bo = p.boost == null ? 1 : +p.boost;
      return (sc) => {
        const e = sc.f[field] || EMPTY;
        const xs = textFields(f) ? e.toks.map((t) => t.t) : e.vals;
        return xs.some((x) => (!lo || (lo[1] ? x >= lo[0] : x > lo[0])) && (!hi || (hi[1] ? x <= hi[0] : x < hi[0]))) ? bo : -1;
      };
    },
    bool: (ctx, b) => {
      if (!isObj(b)) err("parsing_exception", "[bool] query malformed");
      Object.keys(b).forEach((k) => { if (!["must", "should", "filter", "must_not", "minimum_should_match", "boost"].includes(k)) err("parsing_exception", `[bool] query does not support [${k}]`); });
      const must = arr(b.must).map((x) => compile(ctx, x)), should = arr(b.should).map((x) => compile(ctx, x)), filter = arr(b.filter).map((x) => compile(ctx, x)), not = arr(b.must_not).map((x) => compile(ctx, x));
      const msm = b.minimum_should_match != null ? msmCount(b.minimum_should_match, should.length) : must.length || filter.length ? 0 : should.length ? 1 : 0;
      const bo = b.boost == null ? 1 : +b.boost;
      return (sc) => {
        let s = 0;
        for (const m of must) { const v = m(sc); if (v < 0) return -1; s += v; }
        for (const m of filter) if (m(sc) < 0) return -1;
        for (const m of not) if (m(sc) >= 0) return -1;
        let hit = 0;
        for (const m of should) { const v = m(sc); if (v >= 0) { hit++; s += v; } }
        if (hit < msm) return -1;
        return s * bo;
      };
    },
    constant_score: (ctx, b) => { const f = compile(ctx, b.filter); const bo = b.boost == null ? 1 : +b.boost; return (sc) => (f(sc) >= 0 ? bo : -1); },
    dis_max: (ctx, b) => { const qs = arr(b.queries).map((x) => compile(ctx, x)), tb = +(b.tie_breaker || 0); return (sc) => { let best = -1, sum = 0; qs.forEach((q) => { const v = q(sc); if (v >= 0) { sum += v; best = Math.max(best, v); } }); return best < 0 ? -1 : best + tb * (sum - best); }; },
    boosting: (ctx, b) => { const pq = compile(ctx, b.positive), nq = compile(ctx, b.negative), nb = +b.negative_boost; return (sc) => { const v = pq(sc); if (v < 0) return -1; return nq(sc) >= 0 ? v * nb : v; }; },
    nested: (ctx, b) => {
      const path = b.path;
      const f = ctx.idx.fields.get(path);
      if (!f || f.type !== "nested") err("query_shard_exception", `[nested] failed to find nested object under path [${path}]`);
      const mode = b.score_mode || "avg";
      return (sc) => {
        const subs = (sc.nested && sc.nested[path]) || [];
        if (!subs.length) return -1;
        const sub = new Ctx(ctx.idx, ctx.scopes.flatMap((s) => (s.nested && s.nested[path]) || []), path);
        const q = compile(sub, b.query);
        const vs = subs.map((x) => q(x)).filter((v) => v >= 0);
        if (!vs.length) return -1;
        return mode === "max" ? Math.max(...vs) : mode === "sum" ? K.sum(vs) : mode === "min" ? Math.min(...vs) : mode === "none" ? 0 : K.sum(vs) / vs.length;
      };
    },
    function_score: (ctx, b) => {
      const q = b.query ? compile(ctx, b.query) : () => 1;
      const fns = arr(b.functions).length ? arr(b.functions) : ["weight", "field_value_factor", "gauss", "exp", "linear", "random_score", "script_score"].some((k) => b[k] != null) ? [b] : [];
      const scoreMode = b.score_mode || "multiply", boostMode = b.boost_mode || "multiply", maxBoost = b.max_boost == null ? Infinity : +b.max_boost;
      const compiled = fns.map((fn) => {
        const flt = fn.filter ? compile(ctx, fn.filter) : null;
        const w = fn.weight == null ? null : +fn.weight;
        let g = null;
        if (fn.field_value_factor) {
          const v = fn.field_value_factor, fld = v.field, fac = v.factor == null ? 1 : +v.factor, mod = v.modifier || "none", miss = v.missing;
          const fdef = ctx.idx.fields.get(fld);
          if (!fdef) err("illegal_argument_exception", `Unable to find a field mapper for field [${fld}]. No 'missing' value defined.`);
          const M = { none: (x) => x, log: (x) => Math.log10(x), log1p: (x) => Math.log10(x + 1), log2p: (x) => Math.log10(x + 2), ln: (x) => Math.log(x), ln1p: (x) => Math.log1p(x), ln2p: (x) => Math.log(x + 2), square: (x) => x * x, sqrt: (x) => Math.sqrt(x), reciprocal: (x) => 1 / x };
          if (!M[mod]) err("illegal_argument_exception", `Illegal modifier: ${mod}`);
          g = (sc) => { const e = sc.f[fld]; let x = e && e.vals.length ? +e.vals[0] : miss; if (x == null) err("search_phase_execution_exception", `Missing value for field [${fld}]`); return M[mod](x * fac); };
        } else if (fn.gauss || fn.exp || fn.linear) {
          const kind = fn.gauss ? "gauss" : fn.exp ? "exp" : "linear", spec = fn[kind];
          const [fld, o] = Object.entries(spec).find(([k]) => k !== "multi_value_mode");
          const fdef = ctx.idx.fields.get(fld);
          if (!fdef) err("illegal_argument_exception", `unknown field [${fld}]`);
          const isDate = fdef.type === "date";
          const span = (x) => (isDate ? K.dur(String(x).replace(/^(\d+)w$/, (m0, n) => +n * 7 + "d")) : +x);
          const origin = o.origin == null ? (isDate ? ctx.idx.now : 0) : isDate ? dateMath(o.origin, { now: ctx.idx.now, tz: "UTC" }) : +o.origin;
          const scale = span(o.scale), off = o.offset ? span(o.offset) : 0, decay = o.decay == null ? 0.5 : +o.decay;
          if (!(scale > 0)) err("illegal_argument_exception", `[${kind}] scale must be positive`);
          g = (sc) => {
            const e = sc.f[fld]; if (!e || !e.vals.length) return 1;
            const dist = Math.max(0, Math.abs(+e.vals[0] - origin) - off);
            if (kind === "gauss") return Math.exp((dist * dist * Math.log(decay)) / (scale * scale));
            if (kind === "exp") return Math.exp((Math.log(decay) / scale) * dist);
            return Math.max(0, (scale / (1 - decay) - dist) / (scale / (1 - decay)));
          };
        } else if (fn.random_score) g = (sc) => (K.hash(String(sc.id) + (fn.random_score.seed || "")) % 1000) / 1000;
        else if (fn.script_score) err("illegal_argument_exception", "script_score is not supported by this simulator; use field_value_factor or a decay function");
        return (sc) => { if (flt && flt(sc) < 0) return null; let v = g ? g(sc) : 1; if (w != null) v *= w; return v; };
      });
      const bo = b.boost == null ? 1 : +b.boost, minScore = b.min_score == null ? null : +b.min_score;
      return (sc) => {
        const qs = q(sc); if (qs < 0) return -1;
        const vals = compiled.map((c) => c(sc)).filter((v) => v != null);
        let fv = 1;
        if (vals.length) {
          fv = scoreMode === "sum" ? K.sum(vals) : scoreMode === "avg" ? K.sum(vals) / vals.length : scoreMode === "first" ? vals[0] : scoreMode === "max" ? Math.max(...vals) : scoreMode === "min" ? Math.min(...vals) : vals.reduce((a, x) => a * x, 1);
        }
        fv = Math.min(fv, maxBoost);
        const s = boostMode === "replace" ? fv : boostMode === "sum" ? qs + fv : boostMode === "avg" ? (qs + fv) / 2 : boostMode === "max" ? Math.max(qs, fv) : boostMode === "min" ? Math.min(qs, fv) : qs * fv;
        const out = s * bo;
        if (minScore != null && out < minScore) return -1;
        return out;
      };
    },
  };

  /* ---------- sorting, aggregations, the search API ---------- */
  function docVals(idx, sc, field) { const e = sc.f[field]; if (!e) return []; return e.vals; }
  function needDocValues(idx, field, what) {
    const f = idx.fields.get(field);
    if (!f) return null;
    if (textFields(f) && !f.fielddata) err("illegal_argument_exception", `Text fields are not optimised for operations that require per-document field data like aggregations and sorting, so these operations are disabled by default. Please use a keyword field instead. Alternatively, set fielddata=true on [${field}] in order to load field data by uninverting the inverted index. Note that this can use significant memory.`);
    if (f.type === "nested" || f.type === "object") err("illegal_argument_exception", `Field [${field}] of type [${f.type}] is not supported for aggregation [${what}]`);
    return f;
  }
  const fdVals = (idx, f, sc) => { const e = sc.f[f.path]; if (!e) return []; return textFields(f) ? [...new Set(e.toks.map((t) => t.t))] : e.vals; };
  function runAggs(idx, aggs, scopes, o) {
    const out = {};
    Object.entries(aggs || {}).forEach(([name, a]) => {
      const sub = a.aggs || a.aggregations;
      const type = Object.keys(a).find((k) => k !== "aggs" && k !== "aggregations" && k !== "meta");
      const p = a[type];
      const subOf = (ss) => (sub ? runAggs(idx, sub, ss, o) : {});
      if (type === "terms") {
        const f = needDocValues(idx, p.field, "terms");
        const m = new Map();
        if (f) scopes.forEach((sc) => new Set(fdVals(idx, f, sc)).forEach((v) => { if (!m.has(v)) m.set(v, []); m.get(v).push(sc); }));
        let b = [...m.entries()].map(([key, ss]) => ({ key, doc_count: ss.length, ss }));
        const ord = p.order ? (isObj(p.order) ? p.order : p.order[0]) : null;
        if (ord && ord._key) b.sort((x, y) => (ord._key === "asc" ? 1 : -1) * (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
        else b.sort((x, y) => y.doc_count - x.doc_count || (x.key < y.key ? -1 : 1));
        const size = p.size == null ? 10 : +p.size;
        const shown = b.slice(0, size);
        out[name] = { doc_count_error_upper_bound: 0, sum_other_doc_count: K.sum(b.slice(size).map((x) => x.doc_count)), buckets: shown.map((x) => ({ key: x.key, doc_count: x.doc_count, ...subOf(x.ss) })) };
      } else if (type === "date_histogram") {
        const f = needDocValues(idx, p.field, "date_histogram");
        if (f && f.type !== "date") err("illegal_argument_exception", `Field [${p.field}] of type [${f.type}] is not supported for aggregation [date_histogram]`);
        const tz = p.time_zone || "UTC";
        const ci = p.calendar_interval, fi = p.fixed_interval;
        if (p.interval) err("illegal_argument_exception", "[interval] on [date_histogram] is deprecated and removed: use [calendar_interval] or [fixed_interval]");
        if (!ci && !fi) err("illegal_argument_exception", "Required one of fields [calendar_interval, fixed_interval], but none were specified.");
        const cu = { minute: "m", "1m": "m", hour: "h", "1h": "h", day: "d", "1d": "d", week: "w", "1w": "w", month: "M", "1M": "M", year: "y", "1y": "y" }[ci];
        if (ci && !cu) err("illegal_argument_exception", `The supplied interval [${ci}] could not be parsed as a calendar interval.`);
        const fms = fi ? K.dur(fi) : null;
        if (fi && !fms) err("illegal_argument_exception", `failed to parse setting [date_histogram.fixedInterval] with value [${fi}] as a time value`);
        const keyOf = (t) => (cu ? roundDown(t, cu, tz) : Math.floor((t + tzOffsetAt(tz, t) * 60000) / fms) * fms - tzOffsetAt(tz, t) * 60000);
        const m = new Map();
        if (f) scopes.forEach((sc) => new Set(docVals(idx, sc, p.field).map(keyOf)).forEach((k) => { if (!m.has(k)) m.set(k, []); m.get(k).push(sc); }));
        const keys = [...m.keys()].sort((a, b) => a - b);
        const all = [];
        if (keys.length && (p.min_doc_count == null || +p.min_doc_count === 0)) { for (let k = keys[0]; k <= keys[keys.length - 1]; k = cu ? addUnit(k, 1, cu, tz) : k + fms) all.push(k); }
        else all.push(...keys);
        out[name] = { buckets: all.filter((k) => !(+p.min_doc_count > 0) || (m.get(k) || []).length >= +p.min_doc_count).map((k) => ({ key_as_string: iso(k, tz), key: k, doc_count: (m.get(k) || []).length, ...subOf(m.get(k) || []) })) };
      } else if (type === "cardinality") {
        const f = needDocValues(idx, p.field, "cardinality");
        const s = new Set(); if (f) scopes.forEach((sc) => fdVals(idx, f, sc).forEach((v) => s.add(v)));
        out[name] = { value: s.size };
      } else if (["avg", "sum", "min", "max", "value_count"].includes(type)) {
        const f = needDocValues(idx, p.field, type);
        const xs = f ? scopes.flatMap((sc) => fdVals(idx, f, sc).map(Number)) : [];
        out[name] = { value: type === "value_count" ? xs.length : !xs.length ? (type === "sum" ? 0 : null) : type === "avg" ? K.sum(xs) / xs.length : type === "sum" ? K.sum(xs) : type === "min" ? Math.min(...xs) : Math.max(...xs) };
      } else if (type === "filter") {
        const ctx = new Ctx(idx, scopes); const q = compile(ctx, p); const ss = scopes.filter((sc) => q(sc) >= 0);
        out[name] = { doc_count: ss.length, ...subOf(ss) };
      } else err("parsing_exception", `Unknown aggregation type [${type}] did you mean [terms]?`);
    });
    return out;
  }
  const cmpVal = (a, b) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);
  // The _search API. Returns {took, hits:{total:{value}, hits:[{_id,_score,_source,sort?}]}, aggregations?} or throws ESErr.
  function search(idx, body) {
    body = body || {};
    Object.keys(body).forEach((k) => { if (!["query", "size", "from", "sort", "aggs", "aggregations", "_source", "track_total_hits", "search_after", "pit", "post_filter", "min_score", "highlight", "explain"].includes(k)) err("parsing_exception", `Unknown key for a START_OBJECT in [${k}].`); });
    const size = body.size == null ? 10 : +body.size, from = body.from == null ? 0 : +body.from;
    if (from + size > idx.maxWindow) err("illegal_argument_exception", `Result window is too large, from + size must be less than or equal to: [${idx.maxWindow}] but was [${from + size}]. See the scroll api for a more efficient way to request large data sets. This limit can be set by changing the [index.max_result_window] index level setting.`);
    const scopes = idx.docs.map((d) => ({ ...d.root, id: d.id, doc: d }));
    const ctx = new Ctx(idx, scopes);
    const q = body.query ? compile(ctx, body.query) : () => 1;
    let hits = scopes.map((sc) => ({ sc, score: q(sc) })).filter((h) => h.score >= 0);
    if (body.min_score != null) hits = hits.filter((h) => h.score >= +body.min_score);
    const aggs = body.aggs || body.aggregations ? runAggs(idx, body.aggs || body.aggregations, hits.map((h) => h.sc), {}) : null;
    if (body.post_filter) { const pf = compile(ctx, body.post_filter); hits = hits.filter((h) => pf(h.sc) >= 0); }
    const total = hits.length;
    const sorts = arr(body.sort).map((s) => {
      if (typeof s === "string") return { field: s, order: s === "_score" ? "desc" : "asc" };
      const [field, v] = Object.entries(s)[0];
      return { field, order: (isObj(v) ? v.order : v) || (field === "_score" ? "desc" : "asc") };
    });
    sorts.forEach((s) => { if (s.field !== "_score" && s.field !== "_doc" && s.field !== "_shard_doc") { const f = needDocValues(idx, s.field, "sort"); if (!f) err("query_shard_exception", `No mapping found for [${s.field}] in order to sort on`); } });
    const keyOf = (h) => sorts.map((s) => s.field === "_score" ? h.score : s.field === "_doc" || s.field === "_shard_doc" ? h.sc.doc.ord : (() => { const f = idx.fields.get(s.field); const vs = fdVals(idx, f, h.sc).slice().sort(cmpVal); return vs.length ? (s.order === "desc" ? vs[vs.length - 1] : vs[0]) : null; })());
    hits.forEach((h) => (h.key = keyOf(h)));
    if (sorts.length) hits.sort((a, b) => { for (let i = 0; i < sorts.length; i++) { const c = cmpVal(a.key[i], b.key[i]) * (sorts[i].order === "desc" ? -1 : 1); if (c) return c; } return a.sc.doc.ord - b.sc.doc.ord; });
    else hits.sort((a, b) => b.score - a.score || a.sc.doc.ord - b.sc.doc.ord);
    if (body.search_after) {
      if (!sorts.length) err("illegal_argument_exception", "Sort must contain at least one field.");
      const sa = arr(body.search_after);
      if (sa.length !== sorts.length) err("illegal_argument_exception", `search_after has ${sa.length} value(s) but sort has ${sorts.length}.`);
      hits = hits.filter((h) => { for (let i = 0; i < sorts.length; i++) { const c = cmpVal(h.key[i], sa[i]) * (sorts[i].order === "desc" ? -1 : 1); if (c) return c > 0; } return false; });
      if (from) err("illegal_argument_exception", "[from] parameter must be set to 0 when [search_after] is used");
    }
    const page = hits.slice(from, from + size);
    const res = { took: 1 + Math.round(total / 7), timed_out: false, hits: { total: { value: total, relation: "eq" }, max_score: sorts.length ? null : page.length ? page[0].score : null, hits: page.map((h) => ({ _index: idx.name || "index", _id: h.sc.id, _score: sorts.length && !sorts.some((s) => s.field === "_score") ? null : h.score, _source: h.sc.doc.src, ...(sorts.length ? { sort: h.key } : {}) })) } };
    if (aggs) res.aggregations = aggs;
    return res;
  }
  // POST _analyze: {analyzer|field|tokenizer+filter, text}
  function analyze(idx, body) {
    if (!isObj(body) || body.text == null) err("action_request_validation_exception", "Validation Failed: 1: text is missing;");
    let fn;
    if (body.field) {
      const f = idx && idx.fields.get(body.field);
      if (!f) fn = analyzerFn("standard", {});
      else if (textFields(f)) fn = analyzerFn(f.analyzer || "standard", idx.analysis);
      else if (f.type === "keyword") fn = (s) => [{ t: keyNorm(idx, f, s), pos: 0 }];
      else fn = (s) => [{ t: String(s), pos: 0 }];
    } else if (body.analyzer) fn = analyzerFn(body.analyzer, idx ? idx.analysis : {});
    else if (body.tokenizer) fn = analyzerFn("_adhoc", { analyzer: { _adhoc: { tokenizer: body.tokenizer, filter: body.filter || [] } } });
    else fn = analyzerFn("standard", {});
    return arr(body.text).flatMap((t) => fn(t)).map((x) => ({ token: x.t, position: x.pos }));
  }
  // Build an index from {settings, mappings} and docs [{_id, ...src}]; returns {idx} or {error}.
  function build(body, docs, o) {
    try {
      const idx = createIndex(body, o);
      idx.name = (o && o.name) || "products";
      const rejected = [];
      docs.forEach((d) => { const { _id, ...src } = d; try { indexDoc(idx, _id, src); } catch (e) { if (!(e instanceof ESErr)) throw e; rejected.push({ id: _id, err: e }); } });
      return { idx, rejected };
    } catch (e) { if (e instanceof ESErr) return { error: e }; throw e; }
  }
  // Run a search request given as JSON text or object. Returns {res} or {error}.
  function run(idx, req) {
    let body = req;
    if (typeof req === "string") { const p = K.json(req); if (!p.ok) return { error: { type: "json_parse_exception", reason: "Unexpected character: " + p.err } }; body = p.val; }
    if (!isObj(body)) return { error: { type: "parsing_exception", reason: "request body is required to be a JSON object" } };
    try { return { res: search(idx, body), body }; } catch (e) { if (e instanceof ESErr) return { error: e, body }; return { error: { type: "exception", reason: String(e.message || e) }, body }; }
  }
  const errText = (e) => `${e.type}: ${e.reason}`;
  // Pretty JSON for terminal output, compact for short arrays.
  const pj = (x, ind = "") => {
    if (Array.isArray(x)) { if (!x.length) return "[ ]"; if (x.every((v) => !isObj(v) && !Array.isArray(v))) return "[ " + x.map((v) => JSON.stringify(v)).join(", ") + " ]"; return "[\n" + x.map((v) => ind + "  " + pj(v, ind + "  ")).join(",\n") + "\n" + ind + "]"; }
    if (isObj(x)) { const ks = Object.keys(x); if (!ks.length) return "{ }"; return "{\n" + ks.map((k) => `${ind}  "${k}" : ${pj(x[k], ind + "  ")}`).join(",\n") + "\n" + ind + "}"; }
    return JSON.stringify(x);
  };
  const errJson = (e) => pj({ error: { root_cause: [{ type: e.type, reason: e.reason }], type: e.type, reason: e.reason }, status: e.status || 400 });

  // Results table for live panels: rank, id, score, a few source fields.
  function hitsHTML(res, cols, o = {}) {
    const hs = res.hits.hits;
    if (!hs.length) return `<p class="muted small">0 hits.</p>`;
    return `<div class="muted small">${res.hits.total.value} hit${res.hits.total.value === 1 ? "" : "s"}${o.note ? " · " + o.note : ""}</div>` + K.table(["#", "_id", "_score", ...cols.map((c) => esc(c.h || c))], hs.map((h, i) => [String(i + 1), `<span class="mono">${esc(h._id)}</span>`, h._score == null ? "–" : h._score.toFixed(3), ...cols.map((c) => { const v = typeof c === "string" ? K.get(h._source, c) : c.f(h._source); return esc(Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v)); })]), { compact: true, cls: o.cls ? (r, i) => o.cls(hs[i]) : undefined });
  }

  const ES = (LB.es = { porter, analyzerFn, normalizerFn, createIndex, indexDoc, search, analyze, build, run, errText, errJson, pj, hitsHTML, dateMath, parseDate, iso, tzOffsetAt, ESErr, EN_STOP });
  /* =====================================================================
     Scenario helpers
     ===================================================================== */
  const memo = new Map();
  const idxFor = (I, body, docs) => {
    body = body || I.index; docs = docs || I.docs;
    const key = K.stable([body, docs, I.now || 0, I.iname || ""]);
    let r = memo.get(key);
    if (!r) { r = build(body, docs, { name: I.iname || "products", now: I.now }); if (memo.size > 400) memo.clear(); memo.set(key, r); }
    return r;
  };
  const parseReq = (src) => { const p = K.json(String(src || "")); if (!p.ok) return { err: `That isn't valid JSON: ${esc(p.err)}` }; if (!isObj(p.val)) return { err: "The request body must be a JSON object." }; return { val: p.val }; };
  const forbidIds = (b) => (/"ids"\s*:|"_id"/.test(JSON.stringify(b)) ? "Don't hard-code document ids: the query has to work for the next document like this one too." : null);
  function runQ(I, body, o = {}) {
    const b = o.built || idxFor(I);
    if (b.error) return { err: `Index creation failed: <code>${esc(errText(b.error))}</code>` };
    const req = { ...body };
    if (o.allSize && req.size == null) req.size = 100;
    const r = run(b.idx, req);
    if (r.error) return { err: `Elasticsearch returned an error: <code>${esc(errText(r.error))}</code>` };
    return { res: r.res, ids: r.res.hits.hits.map((h) => h._id) };
  }
  const nameOf = (I, id) => { const d = I.docs.find((x) => x._id === id); const v = d ? K.get(d, I.label || "name") : null; return d ? `<b>${esc(id)}</b>${v != null ? ` (${esc(String(v).slice(0, 60))})` : ""}` : esc(id); };
  const listNames = (I, ids) => ids.map((id) => nameOf(I, id)).join(", ");
  function cmpHits(I, ids, want, ordered) {
    const miss = want.filter((x) => !ids.includes(x)), extra = ids.filter((x) => !want.includes(x));
    if (miss.length || extra.length) return `Returned ${ids.length} hit${ids.length === 1 ? "" : "s"}.${miss.length ? ` Missing: ${listNames(I, miss)}.` : ""}${extra.length ? ` Shouldn't match: ${listNames(I, extra)}.` : ""}`;
    if (ordered && !LB.same(ids, want)) return `Right documents, wrong order: you rank ${ids.map(esc).join(" → ")}, but relevance alone gives ${want.map(esc).join(" → ")}. Some clause is adding to the score.`;
    return true;
  }
  const cell = (v) => esc(Array.isArray(v) ? (v.length && isObj(v[0]) ? v.map((x) => Object.values(x).join("·")).join("; ") : v.join(", ")) : v == null ? "" : isObj(v) ? JSON.stringify(v) : String(v));
  const docsTable = (I, cols, docs) => K.table(["_id", ...cols.map(esc)], (docs || I.docs).map((d) => [`<span class="mono">${esc(d._id)}</span>`, ...cols.map((c) => cell(K.get(d, c)))]), { compact: true, mono: [0] });
  const J = (x) => JSON.stringify(x);
  const JP = (x) => JSON.stringify(x, null, 2);
  const pick = (R, xs, k) => R.sample(xs, k);
  const ids = (n, pre = "p") => Array.from({ length: n }, (_, i) => pre + (i + 1));

  // Query-writing scenarios: the player writes a _search body; graded by the hits it returns on the seeded index.
  // d.make(lv, R) -> I with { index, docs, ref, bads, starter, ordered?, label?, cols }
  function querySc(d) {
    const judge = (I, src) => {
      const p = parseReq(src); if (p.err) return p.err;
      const f = forbidIds(p.val); if (f) return f;
      if (d.check) { const c = d.check(I, p.val); if (c !== true) return c; }
      const r = runQ(I, p.val, { allSize: true });
      if (r.err) return r.err;
      return cmpHits(I, r.ids, I.want, I.ordered);
    };
    const def = {
      w: "code",
      ...d,
      gen(lv, R) {
        const I = d.make(lv, R);
        if (!I) return null;
        const r = runQ(I, JSON.parse(I.ref), { allSize: true });
        if (r.err) throw new Error("reference query failed: " + r.err);
        I.want = r.ids;
        if (I.want.length < (I.minWant || 1) || I.want.length === I.docs.length) return null;
        for (const b of I.bads) if (judge(I, b) === true) { if (LB._esDebug) console.log("BAD PASSES", d.id, lv, b); return null; }
        return I;
      },
      ui: (I) => ({ lang: "json", file: `GET ${I.iname || "products"}/_search`, starter: I.starter, rows: I.rows || 9, liveDelay: 350, live: (src) => {
        if (!src || !src.trim()) return `<p class="muted small">Write a request body to run it against the index.</p>`;
        const p = parseReq(src); if (p.err) return `<p class="lose small">${p.err}</p>`;
        const r = runQ(I, p.val, { allSize: true });
        if (r.err) return `<p class="lose small">${r.err}</p>`;
        return hitsHTML(r.res, I.cols || ["name"]);
      } }),
      accept: (I, src) => judge(I, src),
      solve: (I) => I.ref,
      bad: (I) => I.bads,
    };
    delete def.make; delete def.check;
    return def;
  }

  // Mapping scenarios: the player writes {settings?, mappings}; graded by a battery of requests whose expected
  // results come from a reference mapping. Tests: [{name, req, kind: 'set'|'order'|'buckets'|'count0'}]
  function testResult(I, built, t) {
    const r = runQ(I, t.req, { built, allSize: true });
    if (r.err) return { err: r.err };
    if (t.kind === "buckets") { const a = Object.values(r.res.aggregations || {})[0]; return { v: a && a.buckets ? a.buckets.map((b) => [b.key, b.doc_count]) : null }; }
    if (t.kind === "set") return { v: r.ids.slice().sort() };
    return { v: r.ids };
  }
  const showV = (I, t, v) => (v == null ? "–" : t.kind === "buckets" ? v.map(([k, n]) => `${esc(String(k))}: ${n}`).join(", ") || "no buckets" : v.length ? v.map(esc).join(", ") : "0 hits");
  function mappingSc(d) {
    const evalAll = (I, src) => {
      const p = parseReq(src); if (p.err) return { err: p.err };
      const body = p.val;
      if (!body.mappings) return { err: `Put the field definitions under <code>"mappings": { "properties": { ... } }</code>.` };
      const extra = Object.keys(body).filter((k) => !["settings", "mappings", "aliases"].includes(k));
      if (extra.length) return { err: `Unknown top-level key <code>${esc(extra[0])}</code>; a create-index body has <code>settings</code> and <code>mappings</code>.` };
      const built = idxFor(I, body);
      if (built.error) return { err: `<code>PUT ${esc(I.iname || "products")}</code> failed: <code>${esc(errText(built.error))}</code>` };
      if (built.rejected.length) return { err: `${built.rejected.length} document(s) were rejected while indexing, e.g. ${esc(built.rejected[0].id)}: <code>${esc(errText(built.rejected[0].err))}</code>` };
      const rows = I.tests.map((t, k) => { const got = testResult(I, built, t); return { t, got, ok: !got.err && LB.same(got.v, I.expect[k]) }; });
      return { rows, body, built };
    };
    const judge = (I, src) => {
      const e = evalAll(I, src);
      if (e.err) return e.err;
      if (d.check) { const c = d.check(I, e.body, e.built); if (c !== true) return c; }
      const f = e.rows.find((r) => !r.ok);
      if (f) return `Test <b>${esc(f.t.name)}</b> fails: ${f.got.err ? f.got.err : `got ${showV(I, f.t, f.got.v)}, expected ${showV(I, f.t, I.expect[e.rows.indexOf(f)])}`}.`;
      return true;
    };
    const def = {
      w: "code",
      ...d,
      gen(lv, R) {
        const I = d.make(lv, R);
        if (!I) return null;
        const built = idxFor(I, JSON.parse(I.ref));
        if (built.error || built.rejected.length) throw new Error("reference mapping failed: " + (built.error ? errText(built.error) : errText(built.rejected[0].err)));
        I.expect = I.tests.map((t) => { const g = testResult(I, built, t); if (g.err) throw new Error("reference test failed: " + g.err); return g.v; });
        for (const b of I.bads) if (judge(I, b) === true) { if (LB._esDebug) console.log("BAD PASSES", d.id, lv, b); return null; }
        return I;
      },
      ui: (I) => ({ lang: "json", file: `PUT ${I.iname || "products"}`, starter: I.starter, rows: I.rows || 14, liveDelay: 400, live: (src) => {
        if (!src || !src.trim()) return `<p class="muted small">Write the create-index body to run the test requests.</p>`;
        const e = evalAll(I, src);
        if (e.err) return `<p class="lose small">${e.err}</p>`;
        const c = d.check ? d.check(I, e.body, e.built) : true;
        return K.table(["Test", "Result", ""], e.rows.map((r) => [esc(r.t.name), r.got.err ? `<span class="lose small">${r.got.err}</span>` : `<span class="small">${showV(I, r.t, r.got.v)}</span>`, r.ok ? "✓" : "✗"]), { compact: true, cls: (row, i) => (e.rows[i].ok ? "good" : "bad") }) + (c !== true ? K.note(c, "bad") : "");
      } }),
      accept: (I, src) => judge(I, src),
      solve: (I) => I.ref,
      bad: (I) => I.bads,
    };
    delete def.make; delete def.check;
    return def;
  }
  const testsHTML = (I) => `<ol class="small">${I.tests.map((t) => `<li>${esc(t.name)}: <code>${esc(J(t.req))}</code></li>`).join("")}</ol>`;
  // analyzer chain of a mapped text field (index or search side), as filter types
  const chainOf = (body, field, side) => {
    const an = (body.settings && body.settings.analysis) || {};
    const props = (body.mappings && body.mappings.properties) || {};
    const f = field.split(".").reduce((o, k, i, a) => (o ? (i < a.length - 1 ? (o[k] && (o[k].properties || o[k].fields)) : o[k]) : null), props);
    if (!f) return [];
    const name = side === "search" ? f.search_analyzer || f.analyzer || "standard" : f.analyzer || "standard";
    const a = (an.analyzer || {})[name];
    if (!a) return [];
    return arr(a.filter).map((x) => (isObj(x) ? x : (an.filter || {})[x] || { type: x }));
  };

  /* =====================================================================
     Scenarios, part 1: analysis, mappings and the query DSL
     ===================================================================== */
  const SCEN = [];

  /* ---------- 1. term on text / keyword gotchas ---------- */
  SCEN.push(querySc({
    id: "es-term-on-text",
    name: "The exact lookup that finds nothing",
    kind: "Incident",
    skills: ["diagnose"],
    make(lv, R) {
      if (lv === 1) {
        const pairs = [["Trail Running Shoe", ["Trail Running Shoe Laces", "Trail Running Shoe Cleaning Kit"]], ["Wireless Mouse", ["Wireless Mouse Pad", "Wireless Mouse Charging Dock"]], ["USB-C Hub", ["USB-C Hub Mount", "USB-C Hub Travel Case"]], ["Espresso Machine", ["Espresso Machine Descaler", "Espresso Machine Cover"]]];
        const [target, near] = R.pick(pairs);
        const fill = R.sample(["Road Running Shoe", "Wireless Keyboard", "Laptop Stand", "Desk Lamp", "Milk Frother", "HDMI Cable", "Phone Charger"], 4);
        const names = R.shuffle([target, ...near, ...fill]);
        const docs = names.map((n, i) => ({ _id: "p" + (101 + i), name: n, price: R.int(8, 180) }));
        return { lv, target, index: {}, docs, cols: ["name"], starter: JP({ query: { term: { name: target } } }), ref: J({ query: { term: { "name.keyword": target } } }), bads: [J({ query: { term: { name: target } } }), J({ query: { match_phrase: { name: target } } }), J({ query: { match: { name: target } } })] };
      }
      if (lv === 2) {
        const pool = ["shipped", "Shipped", "SHIPPED", "pending", "partially_shipped", "Partially Shipped", "cancelled", "PENDING", "delivered"];
        const st = ["shipped", "Shipped", "SHIPPED", "Partially Shipped", "partially_shipped", ...Array.from({ length: 6 }, () => R.pick(pool))];
        const docs = R.shuffle(st).map((s, i) => ({ _id: "o-" + (5100 + i * R.int(3, 9)), status: s, total: R.int(12, 400) }));
        return { lv, index: { mappings: { properties: { status: { type: "keyword" }, total: { type: "float" } } } }, iname: "orders", label: "status", docs, cols: ["status", "total"], starter: JP({ query: { term: { status: "shipped" } } }), ref: J({ query: { term: { status: { value: "shipped", case_insensitive: true } } } }), bads: [J({ query: { term: { status: "shipped" } } }), J({ query: { match: { status: "shipped" } } }), J({ query: { wildcard: { status: { value: "*shipped*", case_insensitive: true } } } })] };
      }
      const brand = R.pick(["Acme", "Northpeak", "Stridewell", "Kestrel"]), model = R.pick(["ProStride", "TerraGrip", "SummitFlex", "TrailBlaze"]);
      const segs = [`${brand} ${model} Trail Running Shoe for ${R.pick(["Men", "Women"])}`, "Breathable Engineered Mesh Upper", "Vibram Megagrip Outsole with 5mm Lugs", "Rock Plate Protection", "Waterproof Membrane", "Wide Toe Box", `Sizes ${R.int(5, 7)} to ${R.int(12, 14)}`, "Free 60-Day Returns", "Ships Within 24 Hours from Our Warehouse"];
      const target = segs.join(", ");
      const bundle = "Bundle Deal: " + [segs[3], segs[1], segs[0], segs[2], ...segs.slice(4)].join(", ") + ", Plus Socks";
      const fill = [`${brand} ${model} Trail Running Shoe`, `${brand} ${model} Insoles`, `Trail Running Shoe for Men`, `${brand} Hiking Boot`];
      const docs = R.shuffle([target, bundle, ...fill]).map((n, i) => ({ _id: "l" + (7700 + i * 13), name: n, seller: R.pick(["outdoorhub", "peakgear", "runnersdepot"]) }));
      return { lv, target, index: {}, docs, cols: [{ h: "name", f: (s) => (s.name.length > 70 ? s.name.slice(0, 67) + "…" : s.name) }], rows: 11, starter: JP({ query: { term: { "name.keyword": target } } }), ref: J({ query: { match_phrase: { name: target } } }), bads: [J({ query: { term: { "name.keyword": target } } }), J({ query: { match: { name: { query: target, operator: "and" } } } }), J({ query: { term: { name: target } } })] };
    },
    text: (I) => I.lv === 1 ? `<p>The <code>products</code> index was created with dynamic mapping (no explicit mapping). Support's "exact product name" lookup sends the request below and gets <b>0 hits</b>, yet <b>${esc(I.target)}</b> is in the catalog. A plain <code>match</code> would also return accessories with longer names.</p><p>Fix the request so it returns <b>exactly the products named "${esc(I.target)}"</b>.</p>${docsTable(I, ["name", "price"])}`
      : I.lv === 2 ? `<p>The "shipped orders" dashboard undercounts. <code>status</code> is mapped as <code>keyword</code>, but a legacy importer wrote it in mixed case. There's no time to reindex today.</p><p>Write the request that returns every order whose status is <b>shipped</b>, whatever the case, and nothing that's only partially shipped.</p>${docsTable(I, ["status", "total"])}`
        : `<p>Last quarter you fixed the exact-title lookup by switching it to <code>term</code> on <code>name.keyword</code> (dynamic mapping). Marketplace sellers now paste long listing titles, and this one returns <b>0 hits</b> even though the listing exists, character for character.</p>${K.pre(I.target)}<p>Write a request that returns <b>only that listing</b> (not the bundle that reuses its wording in another order).</p>${docsTable(I, ["name"])}`,
    hint: (I) => I.lv === 1 ? "A term query is not analysed. What does the text field actually contain after the standard analyzer runs? Dynamic mapping also created a sub-field." : I.lv === 2 ? "keyword fields compare exact bytes. term has an option for this since 7.10, or list the variants." : "How long is the title? Look up what dynamic mapping sets as ignore_above on the .keyword sub-field. The text field still has every token, in order.",
    concept: "term vs match, and what actually got indexed",
    how: "A text field runs through its analyzer at index time, so <i>Wireless Mouse</i> is stored as the tokens <code>wireless</code> and <code>mouse</code>. A <code>term</code> query is never analysed: it looks for the exact input among those tokens and finds nothing. <code>keyword</code> fields store the whole value unchanged, so term works there, but only byte-for-byte unless a normalizer or <code>case_insensitive</code> is used. Dynamic mapping turns every string into <code>text</code> plus a <code>.keyword</code> sub-field with <code>ignore_above: 256</code>: longer values are simply not indexed in the sub-field.",
    rule: "match for text fields, term/terms for keyword, numbers and dates. When an exact lookup finds nothing, run GET index/_mapping and POST index/_analyze before blaming the data.",
    why: (I) => I.lv === 1 ? `The name field holds lowercase tokens, so <code>term</code> on "${esc(I.target)}" can never match; <code>name.keyword</code> holds the full original string. A phrase match would also return ${esc(I.docs.filter((d) => d.name !== I.target && d.name.startsWith(I.target)).map((d) => d.name).join(" and "))}.`
      : I.lv === 2 ? `Three spellings of shipped are stored as distinct keyword values. <code>case_insensitive: true</code> (or <code>terms</code> with every variant) catches all of them; a wildcard <code>*shipped*</code> would also count the ${I.docs.filter((d) => /partial/i.test(d.status)).length} partially shipped orders. Long term, add a lowercase normalizer and reindex.`
        : `The title is ${I.target.length} characters, over the dynamic mapping's <code>ignore_above: 256</code>, so <code>name.keyword</code> has no value for this document at all. <code>match_phrase</code> on the text field requires every token in order, which excludes the bundle; <code>operator: and</code> would not.`,
  }));

  /* ---------- 2. bool: filter context and the should trap ---------- */
  SCEN.push(querySc({
    id: "es-bool-filter",
    name: "Filter without changing the ranking",
    kind: "Code review",
    skills: ["design", "diagnose"],
    make(lv, R) {
      const names = ["Trail Running Shoe", "Lightweight Trail Running Shoe", "Road Running Shoe", "Trail Hiking Boot", "Running Socks", "Trail Running Vest", "Waterproof Trail Shoe", "Minimalist Running Shoe", "Casual Canvas Shoe", "Trail Running Shoe Laces", "Hiking Socks", "Running Belt", "Kids Running Shoe"];
      const brands = R.sample(["Acme", "Northpeak", "Stridewell", "Kestrel", "Ridgeline"], 3);
      const docs = R.shuffle(names).map((n, i) => ({ _id: "s" + (10 + i), name: n, brand: brands[i % 3], price: R.int(4, 32) * 5, in_stock: R.chance(0.75) }));
      const P = R.pick([100, 120, 140]);
      const index = { mappings: { properties: { name: { type: "text" }, brand: { type: "keyword" }, price: { type: "float" }, in_stock: { type: "boolean" } } } };
      const m = { match: { name: "trail running shoe" } }, stock = { term: { in_stock: true } };
      const I = { lv, index, docs, brands, P, cols: ["name", "brand", "price", "in_stock"], minWant: 2 };
      if (lv === 1) Object.assign(I, { ref: J({ query: { bool: { must: [m], filter: [stock, { range: { price: { lte: P } } }] } } }), bads: [J({ query: { bool: { should: [m, stock, { range: { price: { lte: P } } }] } } }), J({ query: m })], starter: JP({ query: { bool: { should: [m, stock, { range: { price: { lte: P } } }] } } }) });
      if (lv === 2) Object.assign(I, { ordered: true, ref: J({ query: { bool: { must: [m], filter: [stock, { range: { price: { lte: P } } }, { terms: { brand: brands.slice(0, 2) } }] } } }), bads: [J({ query: { bool: { must: [m], filter: [stock, { range: { price: { lte: P } } }], should: [{ term: { brand: brands[0] } }, { term: { brand: brands[1] } }] } } }), J({ query: { bool: { must: [m], filter: [stock, { range: { price: { lte: P } } }] } } })], starter: JP({ query: { bool: { must: [m], filter: [stock, { range: { price: { lte: P } } }], should: [{ term: { brand: brands[0] } }, { term: { brand: brands[1] } }] } } }), rows: 12 });
      if (lv === 3) {
        const X = R.pick([60, 70, 80]), Y = R.pick([110, 130, 150]);
        Object.assign(I, { X, Y, ordered: true, rows: 14, ref: J({ query: { bool: { must: [m], filter: [stock, { bool: { should: [{ bool: { filter: [{ term: { brand: brands[0] } }, { range: { price: { lte: X } } }] } }, { bool: { filter: [{ term: { brand: brands[1] } }, { range: { price: { lte: Y } } }] } }] } }] } } }),
          bads: [J({ query: { bool: { must: [m], filter: [stock, { terms: { brand: brands.slice(0, 2) } }, { range: { price: { lte: Y } } }] } } }), J({ query: { bool: { must: [m], filter: [stock], should: [{ bool: { filter: [{ term: { brand: brands[0] } }, { range: { price: { lte: X } } }] } }, { bool: { filter: [{ term: { brand: brands[1] } }, { range: { price: { lte: Y } } }] } }] } } })],
          starter: JP({ query: { bool: { must: [m], filter: [stock] } } }) });
      }
      return I;
    },
    text: (I) => `<p>The storefront searches <code>trail running shoe</code> in <code>name</code> (ranked by relevance).${I.lv === 1 ? ` A teammate's request returns half the catalog. It must return <b>only in-stock products priced at most $${I.P}</b>, ranked by how well the name matches.` : I.lv === 2 ? ` Add a brand facet: only <b>${esc(I.brands[0])}</b> or <b>${esc(I.brands[1])}</b>, in stock, at most $${I.P}. The brand filter must <b>not change the ranking</b> (the PR below shows other brands too).` : ` A promotion: <b>${esc(I.brands[0])}</b> products up to $${I.X} and <b>${esc(I.brands[1])}</b> products up to $${I.Y}, in stock only, ranked purely by text relevance.`}</p>${docsTable(I, ["name", "brand", "price", "in_stock"])}`,
    hint: (I) => I.lv === 1 ? "In a bool with only should clauses, any one clause is enough to match. Which clauses are yes/no conditions rather than relevance?" : I.lv === 2 ? "Once a bool has a must or filter clause, its should clauses become optional: they only add score. Yes/no conditions belong in filter." : "You need an OR of two ANDs. A bool can be nested inside filter; a bool with only should clauses requires one of them to match.",
    concept: "Query vs filter context in bool",
    how: "In a bool query, <code>must</code> and <code>should</code> clauses run in query context: they decide whether a document matches <i>and</i> add to its score. <code>filter</code> and <code>must_not</code> run in filter context: yes/no, no scoring, and their results can be cached in the node query cache as bitsets. <code>should</code> is subtle: with no must/filter, at least one should clause must match; as soon as a must or filter is present, <code>minimum_should_match</code> defaults to 0 and should clauses only boost. Nested bools let you express OR-of-ANDs inside a filter.",
    rule: "Put every yes/no condition (status, price ranges, brand facets, ACLs) in filter; keep only what should affect relevance in must/should. If you use should for alternatives, set minimum_should_match explicitly.",
    why: (I) => I.lv === 1 ? `With only should clauses, every in-stock product or every product under $${I.P} matched even if its name had nothing to do with running shoes. Moving stock and price to <code>filter</code> leaves ${I.want.length} products, ranked only by the name match.`
      : I.lv === 2 ? `The PR's brand terms sat in <code>should</code> next to a must and a filter, so they were optional: ${esc(I.brands[2])} products still matched, just with a lower score. In <code>filter</code> the brand restriction is enforced, cached and leaves the BM25 ranking ${I.want.join(" → ")} untouched.`
        : `<code>filter: [bool: {should: [bool(${esc(I.brands[0])} ∧ ≤ $${I.X}), bool(${esc(I.brands[1])} ∧ ≤ $${I.Y})]}]</code> expresses the OR of ANDs without scoring. Flattening it into terms + one price cap lets ${esc(I.brands[0])} products between $${I.X} and $${I.Y} through; leaving it at the top level as should makes it optional.`,
  }));

  /* ---------- 3. precision: operator, minimum_should_match, slop ---------- */
  SCEN.push(querySc({
    id: "es-precision",
    name: "Tighten a noisy search",
    kind: "Config change",
    skills: ["tune", "design"],
    make(lv, R) {
      let names, ref, bads, q, starter;
      if (lv === 1) {
        const color = R.pick(["red", "blue", "black"]);
        q = `${color} running shoes`;
        names = [`${cap(color)} Running Shoes`, `Running Shoes, ${cap(color)}`, `${cap(color)} Trail Running Shoes`, "Running Shoes", `${cap(color)} Dress Shoes`, `${cap(color)} Running Shorts`, "White Running Shoes", `${cap(color)} Socks`, "Running Watch", "Trail Shoes"];
        ref = J({ query: { match: { name: { query: q, operator: "and" } } } });
        bads = [J({ query: { match: { name: q } } }), J({ query: { match_phrase: { name: q } } })];
      } else if (lv === 2) {
        q = "waterproof trail running shoes";
        names = ["Waterproof Trail Running Shoes", "Trail Running Shoes", "Waterproof Running Shoes", "Waterproof Trail Shoes", "Waterproof Hiking Boots", "Road Running Shoes", "Trail Running Vest", "Waterproof Jacket", "Running Socks", "Trail Map", "Waterproof Trail Running Gaiters"];
        ref = J({ query: { match: { name: { query: q, minimum_should_match: "75%" } } } });
        bads = [J({ query: { match: { name: { query: q, operator: "and" } } } }), J({ query: { match: { name: q } } }), J({ query: { match: { name: { query: q, minimum_should_match: "50%" } } } })];
      } else {
        q = "noise cancelling";
        names = ["Noise Cancelling Headphones", "Headphones with Active Noise Cancelling", "Cancelling Noise Earbuds", "Noise-Free Cancelling Microphone", "Cancelling the Noise: A Memoir", "Noise Isolating Earbuds with Echo Cancelling", "Low Noise Desk Fan", "White Noise Machine", "Subscription Cancelling Guide"];
        ref = J({ query: { match_phrase: { name: { query: q, slop: 2 } } } });
        bads = [J({ query: { match_phrase: { name: q } } }), J({ query: { match: { name: { query: q, operator: "and" } } } }), J({ query: { match_phrase: { name: { query: q, slop: 3 } } } }), J({ query: { match_phrase: { name: { query: q, slop: 1 } } } })];
      }
      starter = JP({ query: { match: { name: q } } });
      const docs = R.shuffle(names).map((n, i) => ({ _id: "p" + (300 + i * R.int(2, 5)), name: n }));
      return { lv, q, index: { mappings: { properties: { name: { type: "text" } } } }, docs, ref, bads, starter, cols: ["name"], minWant: 2 };
    },
    text: (I) => `<p>Users search <code>${esc(I.q)}</code> on <code>name</code> (standard analyzer). The default <code>match</code> ORs the words together and returns almost everything.</p><p>${I.lv === 1 ? "Return only products whose name contains <b>every</b> word, in any order." : I.lv === 2 ? "Requiring every word is too strict (it drops good results). Return products whose name contains <b>at least 3 of the 4 words</b>." : "Return names where <i>noise</i> and <i>cancelling</i> are adjacent in either order, or in order with at most one word between them (<i>noise-free cancelling</i>). Nothing looser."}</p>${docsTable(I, ["name"])}`,
    hint: (I) => I.lv === 1 ? "match has an operator parameter." : I.lv === 2 ? "minimum_should_match accepts a count or a percentage of the query terms." : "match_phrase takes a slop: how many position moves are allowed. Swapping two adjacent words costs 2.",
    concept: "Precision controls: operator, minimum_should_match and phrase slop",
    how: "A match query analyses the input into terms and builds a bool of term queries, by default OR: one shared word is enough. <code>operator: and</code> requires every term; <code>minimum_should_match</code> sets a count or percentage in between (75% of 4 terms = 3, rounded down). <code>match_phrase</code> also checks token positions; <code>slop</code> is the number of moves allowed, where a gap of one word costs 1 and swapping two adjacent words costs 2.",
    rule: "Default to OR for recall but cap the noise with minimum_should_match (e.g. 2&lt;75%), and add a match_phrase in a should clause to boost exact phrasing rather than requiring it.",
    why: (I) => I.lv === 1 ? `operator: and keeps the ${I.want.length} names that contain all three words in any order; a phrase query would lose ${esc(I.docs.find((d) => /,/.test(d.name)).name)}.` : I.lv === 2 ? `75% of 4 terms is 3, so ${I.want.length} names qualify. AND would drop ${esc("Trail Running Shoes")}; 50% lets in everything with two shared words.` : `With slop 2, "cancelling noise" (a swap, cost 2) and "noise-free cancelling" (one word between, cost 1) match, but "Cancelling the Noise" needs a swap plus a gap (cost 3) and "noise ... echo cancelling" is further still.`,
  }));
  function cap(s) { return s[0].toUpperCase() + s.slice(1); }

  /* ---------- 4. fuzzy ---------- */
  SCEN.push(querySc({
    id: "es-fuzzy",
    name: "Forgive the typos, not the model number",
    kind: "Config change",
    skills: ["tune", "design"],
    make(lv, R) {
      let names, q, ref, bads, starter, extra = "";
      if (lv === 1) {
        q = R.pick(["wirless headphnes", "wireles headphoens", "wirelss hedphones"]);
        names = ["Wireless Headphones", "Wireless Headphones Pro", "Wired Headphones", "Wireless Charger", "Headphone Stand", "Wireless Earbuds", "Bluetooth Speaker", "Phone Case"];
        ref = J({ query: { match: { name: { query: q, fuzziness: "AUTO", operator: "and" } } } });
        bads = [J({ query: { match: { name: { query: q, operator: "and" } } } }), J({ query: { match: { name: { query: q, fuzziness: "AUTO" } } } })];
        starter = JP({ query: { match: { name: { query: q, operator: "and" } } } });
      } else if (lv === 2) {
        q = R.pick(["samsung chargr cable", "samsng charger cabel", "samsung chrger cable"]);
        names = ["Samsung Fast Charger Cable 2m", "Samsung Charger Cable", "Samsung Charger Table Stand", "Samsung Wireless Charger", "Anker Charger Cable", "Samsung Cable Organizer", "Samsung Charger Fable Edition Skin", "Charger Cable"];
        ref = J({ query: { match: { name: { query: q, fuzziness: "AUTO", prefix_length: 1, operator: "and" } } } });
        bads = [J({ query: { match: { name: { query: q, fuzziness: "AUTO", operator: "and" } } } }), J({ query: { match: { name: { query: q, fuzziness: 2, operator: "and" } } } }), J({ query: { match: { name: { query: q, operator: "and" } } } })];
        starter = JP({ query: { match: { name: { query: q, fuzziness: "AUTO", operator: "and" } } } });
      } else {
        const m = R.pick(["4", "5"]), other = m === "4" ? "5" : "4";
        const typo = R.pick(["headphnes", "hedphones", "haedphones"]);
        q = `sony ${typo}`;
        extra = `WH-1000XM${m}`;
        names = [`Sony WH-1000XM${m} Wireless Headphones`, `Sony WH-1000XM${m} Headphones, Silver`, `Sony WH-1000XM${other} Wireless Headphones`, "Sony WH-1000XM3 Headphones (Refurbished)", `Sony WH-1000XM${m} Replacement Ear Pads`, "Bose QC45 Headphones", `Sony WF-1000XM${m} Earbuds`];
        ref = J({ query: { bool: { must: [{ match: { name: { query: q, fuzziness: "AUTO", operator: "and" } } }, { match: { name: { query: extra, operator: "and" } } }] } } });
        bads = [J({ query: { match: { name: { query: `${q} ${extra}`, fuzziness: "AUTO", operator: "and" } } } }), J({ query: { match: { name: { query: `${q} ${extra}`, fuzziness: 1, operator: "and" } } } }), J({ query: { match: { name: { query: `${q} ${extra}`, operator: "and" } } } })];
        starter = JP({ query: { match: { name: { query: `${q} ${extra}`, fuzziness: "AUTO", operator: "and" } } } });
      }
      const docs = R.shuffle(names).map((n, i) => ({ _id: "p" + (500 + i * R.int(3, 7)), name: n }));
      return { lv, q, extra, index: { mappings: { properties: { name: { type: "text" } } } }, docs, ref, bads, starter, cols: ["name"], minWant: lv === 3 ? 2 : 1 };
    },
    text: (I) => I.lv === 1 ? `<p>Mobile users type fast. The query <code>${esc(I.q)}</code> returns nothing because every word is required and the words are misspelled.</p><p>Return the products whose name contains <b>both intended words</b>, tolerating typos.</p>${docsTable(I, ["name"])}`
      : I.lv === 2 ? `<p>Typo tolerance shipped, and now <code>${esc(I.q)}</code> also shows furniture: a 5-letter word like <i>cable</i> is one edit from <i>table</i> and <i>fable</i>. Real typos in this catalog almost never change the <b>first letter</b>.</p><p>Return only the Samsung charger cables, still tolerating the typo.</p>${docsTable(I, ["name"])}`
        : `<p>Query understanding now extracts model numbers. For this search it sends the words <code>${esc(I.q)}</code> and the model <code>${esc(I.extra)}</code>. With fuzziness on everything, a different generation sneaks in: <i>1000xm4</i> and <i>1000xm5</i> are one edit apart.</p><p>Return the <b>${esc(I.extra)} headphones</b> only: typos forgiven in the words, the model matched exactly.</p>${docsTable(I, ["name"])}`,
    hint: (I) => I.lv === 1 ? "match accepts fuzziness; AUTO scales the allowed edits with word length." : I.lv === 2 ? "prefix_length makes the first N characters non-fuzzy (and makes the query much cheaper)." : "Fuzziness applies to every term of a match query. Split the request into two clauses with different settings.",
    concept: "Fuzzy matching and its false positives",
    how: "Fuzziness is a Levenshtein edit distance (insert, delete, substitute; transpositions count as one edit by default). <code>AUTO</code> allows 0 edits for terms of 1–2 characters, 1 edit for 3–5 and 2 edits for longer terms. The query expands each term into up to <code>max_expansions</code> (50) indexed terms within that distance, so short words and codes collide with real words, and expansion costs CPU. <code>prefix_length</code> pins the first characters and cuts both the noise and the work.",
    rule: "Use fuzziness: AUTO with prefix_length 1–2 for words, and never apply it to identifiers like SKUs, model numbers or postcodes: route those to an exact clause.",
    why: (I) => I.lv === 1 ? `AUTO allows 2 edits for words of 6+ characters, enough for "${esc(I.q)}". Without operator: and, anything with one of the words would match.` : I.lv === 2 ? `"cable" (5 letters) gets 1 edit under AUTO, which reaches "table" and "fable". prefix_length: 1 keeps the c fixed, so only the cables remain.` : `"1000xm${I.extra.slice(-1)}" is 7 characters, so AUTO allows 2 edits and every generation matches. Matching the model in its own non-fuzzy clause (bool must) keeps typo tolerance for the words and exactness for the identifier.`,
  }));

  /* ---------- 5. mapping design: text, keyword, multi-fields, normalizers ---------- */
  SCEN.push(mappingSc({
    id: "es-mapping-design",
    name: "Design the product mapping",
    kind: "Design review",
    skills: ["design"],
    make(lv, R) {
      const b = R.pick([["Acme Audio", "ACME AUDIO", "acme audio"], ["Northwind Sound", "NORTHWIND SOUND", "Northwind sound"], ["Kestrel Labs", "KESTREL LABS", "kestrel labs"]]);
      const o = R.pick(["Señor Gadget", "Café Tech", "Nestlé Home"]);
      const names = ["Wireless Headphones", "Noise Cancelling Headphones", "Wireless Charger", "Desk Lamp", "Bluetooth Speaker", "Headphone Stand", lv === 3 ? "Crème Brûlée Torch" : "Kitchen Torch"];
      const brands = lv === 1 ? [b[0], b[0], "Volt", "Lumen", "Volt", b[0], "Volt"] : [b[0], b[1], "Volt", "Lumen", lv === 3 ? o : "Volt", b[2], lv === 3 ? o : "Volt"];
      const prices = R.shuffle([129, 249, 39, 99.5, 59, 24, 45]);
      const docs = names.map((n, i) => ({ _id: "p" + (i + 1), name: n, brand: brands[i], price: prices[i], released: `2026-0${1 + (i % 6)}-1${i}` }));
      const brandF = lv === 1 ? { type: "keyword" } : { type: "keyword", normalizer: "folded" };
      const nameF = lv === 3 ? { type: "text", analyzer: "product_text", fields: { sort: { type: "keyword", normalizer: "folded" } } } : lv === 2 ? { type: "text", fields: { sort: { type: "keyword", normalizer: "folded" } } } : { type: "text" };
      const settings = lv === 1 ? undefined : { analysis: { normalizer: { folded: { type: "custom", filter: lv === 3 ? ["lowercase", "asciifolding"] : ["lowercase"] } }, ...(lv === 3 ? { analyzer: { product_text: { type: "custom", tokenizer: "standard", filter: ["lowercase", "asciifolding", "porter_stem"] } } } : {}) } };
      const ref = { ...(settings ? { settings } : {}), mappings: { properties: { name: nameF, brand: brandF, price: { type: "float" }, released: { type: "date" } } } };
      const tests = [
        { name: "full-text search", req: { query: { match: { name: "wireless headphones" } } }, kind: "set" },
        { name: "brand filter", req: { query: { term: { brand: lv === 1 ? b[0] : b[2] } } }, kind: "set" },
        { name: "brand facet", req: { size: 0, aggs: { brands: { terms: { field: "brand" } } } }, kind: "buckets" },
        { name: "price under $99.99", req: { query: { range: { price: { lt: 99.99 } } } }, kind: "set" },
      ];
      if (lv >= 2) tests.push({ name: "A–Z sort", req: { query: { match_all: {} }, sort: [{ "name.sort": "asc" }] }, kind: "order" });
      if (lv === 3) tests.push({ name: "accent-insensitive", req: { query: { match: { name: { query: "creme brulee torch", operator: "and" } } } }, kind: "set" }, { name: "singular finds plural", req: { query: { match: { name: "headphone" } } }, kind: "set" }, { name: "brand without accents", req: { query: { term: { brand: fold(o).toLowerCase() } } }, kind: "set" });
      const starter = JP({ mappings: { properties: { name: { type: "text" } } } });
      const bads = [J({ mappings: {} }), J({ mappings: { properties: { name: { type: "text" }, brand: { type: "text" }, price: { type: "float" } } } })];
      if (lv >= 2) bads.push(J({ mappings: { properties: { name: { type: "text", fields: { sort: { type: "keyword" } } }, brand: { type: "keyword" }, price: { type: "float" } } } }));
      if (lv === 3) bads.push(J({ settings: { analysis: { normalizer: { folded: { type: "custom", filter: ["lowercase"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "english", fields: { sort: { type: "keyword", normalizer: "folded" } } }, brand: { type: "keyword", normalizer: "folded" }, price: { type: "float" } } } }));
      return { lv, index: ref, ref: J(ref), docs, tests, bads, starter, rows: lv === 3 ? 18 : 14, brandVariants: b, odd: o };
    },
    text: (I) => `<p>You're creating the <code>products</code> index for a new storefront. The search service already sends the requests below (field names are fixed). Write the create-index body (<code>mappings</code>, plus <code>settings</code> if you need analyzers or normalizers) so that every test returns what the product team expects. The documents are indexed after you create the index.</p>${docsTable(I, ["name", "brand", "price"])}${testsHTML(I)}${I.lv >= 2 ? `<p class="small muted">Brand filters and facets must ignore case${I.lv === 3 ? " and accents" : ""}; the A–Z sort must ignore case.${I.lv === 3 ? " Shoppers type without accents and use singular/plural interchangeably." : ""}</p>` : ""}`,
    hint: (I) => I.lv === 1 ? "Which fields need full-text matching, which need exact values and aggregations, and which are numbers? Dynamic mapping guesses wrong for at least two of them." : I.lv === 2 ? "A keyword normalizer (custom, with a lowercase filter) applies to indexed values and to term queries. A multi-field (fields: { sort: ... }) gives one source value two indexed forms." : "A custom analyzer can chain lowercase, asciifolding and a stemmer. Normalizers can fold accents too.",
    concept: "text, keyword, multi-fields and normalizers",
    how: "Each field's type decides which questions it can answer. <code>text</code> is analysed into tokens for relevance-ranked full-text search but can't sort or aggregate without fielddata. <code>keyword</code> stores the exact value in doc values for filters, sorting and aggregations; a <code>normalizer</code> (lowercase, asciifolding) is applied both at index time and to term queries, making it case- and accent-insensitive. Multi-fields index one source value several ways (<code>name</code> as text plus <code>name.sort</code> as keyword). Numbers mapped dynamically from a first value like <code>129</code> become <code>long</code>, which truncates 99.5 to 99.",
    rule: "Write explicit mappings for anything that matters: text for searching, keyword (with a normalizer when humans type the value) for filtering, sorting and facets, and explicit numeric/date types.",
    why: (I) => I.lv === 1 ? `Dynamic mapping makes <code>brand</code> a text field (term on "${esc(I.brandVariants[0])}" can't match tokens, and the facet errors) and maps <code>price</code> from its first value. Explicit <code>keyword</code> and <code>float</code> fix both.` : I.lv === 2 ? `The data has "${esc(I.brandVariants.join('", "'))}". A lowercase normalizer stores all three as one value, so the filter and the facet agree, and <code>name.sort</code> sorts case-insensitively.` : `The custom analyzer (lowercase → asciifolding → porter_stem) makes "creme brulee" match "Crème Brûlée" and "headphone" match "Headphones"; the brand normalizer folds "${esc(I.odd)}". The built-in english analyzer stems but doesn't fold accents.`,
  }));

  /* ---------- 6. synonyms: index vs search time ---------- */
  SCEN.push(mappingSc({
    id: "es-synonyms",
    name: "Ship the synonyms",
    kind: "Change plan",
    skills: ["design", "safe"],
    make(lv, R) {
      const docs = R.shuffle(lv < 3
        ? ['Samsung 55" QLED Television', "LG OLED TV 65 inch", "Dell XPS Notebook 13", "Lenovo ThinkPad Laptop", "Apple MacBook Air Laptop", "TV Wall Mount", "Television Stand Oak", "Laptop Sleeve", "Sofa Cushion"]
        : ["Apple iPhone 15", "Google Pixel 9", "Samsung Galaxy S24 Smartphone", "Smartphone Tripod", "iPhone 15 Case", "Pixel 9 Screen Protector", "Landline Phone", "Tablet Stand"]).map((n, i) => ({ _id: "p" + (40 + i * 3), name: n }));
      const syns = lv < 3 ? ["tv, television", "laptop, notebook"] : ["smartphone => smartphone, iphone, pixel, galaxy"];
      const filt = { type: "synonym_graph", synonyms: syns, ...(lv >= 2 ? { updateable: true } : {}) };
      const ref = { settings: { analysis: { filter: { product_synonyms: filt }, analyzer: { product_search: { tokenizer: "standard", filter: ["lowercase", "product_synonyms"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "standard", search_analyzer: "product_search" } } } };
      const tests = lv < 3
        ? [{ name: "tv finds televisions", req: { query: { match: { name: "tv" } } }, kind: "set" }, { name: "notebook finds laptops", req: { query: { match: { name: "notebook" } } }, kind: "set" }, { name: "both words required", req: { query: { match: { name: { query: "television stand", operator: "and" } } } }, kind: "set" }]
        : [{ name: "smartphone finds all phones", req: { query: { match: { name: "smartphone" } } }, kind: "set" }, { name: "iphone stays specific", req: { query: { match: { name: "iphone" } } }, kind: "set" }, { name: "pixel stays specific", req: { query: { match: { name: "pixel" } } }, kind: "set" }];
      const idxTime = { settings: { analysis: { filter: { syn: { type: "synonym", synonyms: syns } }, analyzer: { with_syn: { tokenizer: "standard", filter: ["lowercase", "syn"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "with_syn" } } } };
      const bads = [J({ mappings: { properties: { name: { type: "text" } } } })];
      if (lv >= 2) bads.push(J(idxTime), J({ settings: { analysis: { filter: { syn: { type: "synonym_graph", synonyms: syns } }, analyzer: { s: { tokenizer: "standard", filter: ["lowercase", "syn"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "standard", search_analyzer: "s" } } } }));
      if (lv === 3) bads.push(J({ settings: { analysis: { filter: { syn: { type: "synonym_graph", updateable: true, synonyms: ["smartphone, iphone, pixel, galaxy"] } }, analyzer: { s: { tokenizer: "standard", filter: ["lowercase", "syn"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "standard", search_analyzer: "s" } } } }));
      const starter = JP({ settings: { analysis: { filter: {}, analyzer: {} } }, mappings: { properties: { name: { type: "text" } } } });
      return { lv, syns, index: ref, ref: J(ref), docs, tests, bads, starter, rows: 16 };
    },
    check(I, body) {
      if (I.lv === 1) return true;
      const idx = chainOf(body, "name", "index"), srch = chainOf(body, "name", "search");
      if (idx.some((f) => /synonym/.test(f.type))) return "The synonyms are applied at <b>index</b> time: every list change would need a full reindex, and existing documents keep the old expansions.";
      const s = srch.find((f) => /synonym/.test(f.type));
      if (!s) return "Apply the synonyms in a <code>search_analyzer</code> on <code>name</code>.";
      if (!s.updateable) return "Merchandising edits the list weekly. To reload it with <code>POST products/_reload_search_analyzers</code> (no reindex, no close/open) the synonym filter must be marked <code>\"updateable\": true</code>.";
      return true;
    },
    text: (I) => `<p>Merchandising wants these synonyms on product search:</p>${K.pre(I.syns.join("\n"))}${I.lv >= 2 ? `<p>They will <b>edit the list every week</b>, and the index (40M products) takes 9 hours to reindex, so changes must go live without reindexing or closing the index.</p>` : ""}${I.lv === 3 ? "<p>Shoppers who search a <b>specific</b> phone must not get other brands, but a search for <i>smartphone</i> should show every phone.</p>" : ""}<p>Write the create-index body for <code>products</code>. The tests:</p>${testsHTML(I)}${docsTable(I, ["name"])}`,
    hint: (I) => I.lv === 1 ? "Define a synonym (or synonym_graph) token filter, put it in a custom analyzer after lowercase, and use that analyzer on name." : I.lv === 2 ? "Index-time synonyms are baked into the inverted index. A search_analyzer is applied only when queries are parsed, and updateable filters can be reloaded in place." : "a, b, c rules are two-way. A => a, b rules only expand the left-hand side.",
    concept: "Synonyms at search time",
    how: "A synonym filter in the index analyzer writes extra tokens into the inverted index: changing the list means reindexing every document, and term statistics get skewed. In a <code>search_analyzer</code> the expansion happens only when a query is parsed, so the index stays untouched; with <code>updateable: true</code> the filter can be reloaded with <code>_reload_search_analyzers</code> (and ES 8.10+ also has a synonyms API) without closing the index. <code>synonym_graph</code> handles multi-word synonyms correctly at search time. Rules of the form <code>a, b, c</code> are equivalences in every direction; <code>a =&gt; a, b</code> expands only the left side, which is how you model hypernyms like <i>smartphone</i>.",
    rule: "Put synonyms in a search-time analyzer with an updateable synonym_graph filter, and use one-way (=&gt;) rules for broader terms so specific searches stay specific.",
    why: (I) => I.lv === 1 ? "Either placement passes these tests: the query for tv expands to tv|television (or the documents already contain both tokens)." : I.lv === 2 ? "Index-time synonyms would bake today's list into 40M documents; a search_analyzer with an updateable synonym_graph filter is swapped in with _reload_search_analyzers in seconds." : `The one-way rule "${esc(I.syns[0])}" expands only <i>smartphone</i>. An equivalence rule would make <i>iphone</i> expand to galaxy and pixel too and return every brand.`,
  }));

  /* ---------- 7. autocomplete with edge n-grams ---------- */
  SCEN.push(mappingSc({
    id: "es-autocomplete",
    name: "Search as you type",
    kind: "Design review",
    skills: ["design", "tune"],
    make(lv, R) {
      const names = ["Wireless Headphones", "Wired Headphones", "Wireless Charger", "HDMI Cable", "Space Heater", "Headphone Stand", "Wireless Earbuds", "Wall Hook", "Whisk Holder", "Heavy Duty Hammer", ...(lv === 3 ? ["Café Espresso Cups", "Wireless Cafetière Scale"] : [])];
      const docs = R.shuffle(names).map((n, i) => ({ _id: "p" + (60 + i * 2), name: n }));
      const ng = { type: "edge_ngram", min_gram: lv === 1 ? 1 : 2, max_gram: lv === 1 ? 10 : 15 };
      const flt = lv === 3 ? ["lowercase", "asciifolding", "ac_edge"] : ["lowercase", "ac_edge"];
      const ref = { settings: { analysis: { filter: { ac_edge: ng }, analyzer: { autocomplete: { tokenizer: "standard", filter: flt }, ...(lv === 3 ? { ac_search: { tokenizer: "standard", filter: ["lowercase", "asciifolding"] } } : {}) } } }, mappings: { properties: { name: { type: "text", analyzer: "autocomplete", search_analyzer: lv === 3 ? "ac_search" : "standard" } } } };
      const a = R.pick([["wir hea", "wire"], ["wi hea", "wirel"]]);
      const tests = [{ name: `"${a[0]}"`, req: { query: { match: { name: { query: a[0], operator: "and" } } } }, kind: "set" }, { name: `"${a[1]}"`, req: { query: { match: { name: { query: a[1], operator: "and" } } } }, kind: "set" }];
      if (lv >= 2) tests.push({ name: '"headpho"', req: { query: { match: { name: { query: "headpho", operator: "and" } } } }, kind: "set" }, { name: '"hd"', req: { query: { match: { name: { query: "hd", operator: "and" } } } }, kind: "set" });
      if (lv === 3) tests.push({ name: '"cafe"', req: { query: { match: { name: { query: "cafe", operator: "and" } } } }, kind: "set" }, { name: '"café"', req: { query: { match: { name: { query: "café", operator: "and" } } } }, kind: "set" }, { name: '"wireless headphones"', req: { query: { match: { name: { query: "wireless headphones", operator: "and" } } } }, kind: "set" });
      const given = { settings: { analysis: { filter: { ac_edge: { type: "edge_ngram", min_gram: 1, max_gram: 10 } }, analyzer: { autocomplete: { tokenizer: "standard", filter: ["lowercase", "ac_edge"] } } } } };
      const starter = lv === 1 ? JP({ ...given, mappings: { properties: { name: { type: "text" } } } }) : JP({ mappings: { properties: { name: { type: "text" } } } });
      const both = (an) => ({ ...an, mappings: { properties: { name: { type: "text", analyzer: "autocomplete" } } } });
      const bads = [J(both(given))];
      if (lv >= 2) bads.push(J({ settings: { analysis: { filter: { ac_edge: { type: "edge_ngram" } }, analyzer: { autocomplete: { tokenizer: "standard", filter: ["lowercase", "ac_edge"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "autocomplete", search_analyzer: "standard" } } } }));
      if (lv === 3) bads.push(J({ settings: { analysis: { filter: { ac_edge: { type: "edge_ngram", min_gram: 2, max_gram: 6 } }, analyzer: { autocomplete: { tokenizer: "standard", filter: ["lowercase", "asciifolding", "ac_edge"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "autocomplete", search_analyzer: "standard" } } } }), J({ settings: { analysis: { filter: { ac_edge: { type: "edge_ngram", min_gram: 2, max_gram: 15 } }, analyzer: { autocomplete: { tokenizer: "standard", filter: ["lowercase", "asciifolding", "ac_edge"] } } } }, mappings: { properties: { name: { type: "text", analyzer: "autocomplete", search_analyzer: "standard" } } } }));
      return { lv, index: ref, ref: J(ref), docs, tests, bads, starter, rows: lv === 1 ? 16 : 14 };
    },
    text: (I) => `<p>The search box queries <code>name</code> on every keystroke with <code>match</code> + <code>operator: and</code>, so each typed word must be the <b>start</b> of a word in the name, in any order. ${I.lv === 1 ? "A teammate already defined an <code>autocomplete</code> analyzer (edge n-grams); wire it into the mapping correctly." : I.lv === 2 ? "Define the analysis chain yourself. Shoppers type at least 2 characters before results appear, and prefixes up to a whole long word must work." : "Some shoppers type accents and some don't (<i>cafe</i> and <i>café</i> must both find <i>Café</i>), and full words must still match. Define the whole chain."}</p>${testsHTML(I)}${docsTable(I, ["name"])}`,
    hint: (I) => I.lv === 1 ? "If the query is also split into edge n-grams, 'hea' becomes h, he, hea, and h matches every word starting with h." : I.lv === 2 ? "The edge_ngram filter defaults to min_gram 1 and max_gram 2. A prefix longer than max_gram has no matching gram in the index." : "Folding must happen on both sides (index analyzer and search analyzer), and max_gram must cover the longest word you expect to be typed in full.",
    concept: "Edge n-gram autocomplete: index-time grams, plain search analyzer",
    how: "An edge_ngram filter indexes every prefix of each word: <i>wireless</i> becomes w, wi, wir, … up to <code>max_gram</code>. The query side must <b>not</b> be split the same way: a search for <i>hea</i> would turn into h, he, hea and match every word starting with h. So the field uses the n-gram analyzer at index time and a plain <code>search_analyzer</code>. Prefixes longer than <code>max_gram</code> match nothing, and any normalisation (lowercase, asciifolding) has to be identical on both sides. <code>search_as_you_type</code> is a built-in alternative that creates shingle and prefix sub-fields.",
    rule: "Edge n-grams at index time, the same normalisation without n-grams at search time, and size min_gram/max_gram to what users actually type (index growth is roughly proportional to max_gram).",
    why: (I) => I.lv === 1 ? "With the autocomplete analyzer on both sides, the one-letter grams of the query match Wall Hook and Whisk Holder. A standard search_analyzer keeps the query terms whole, so only names with words starting wir… and hea… match." : I.lv === 2 ? "The default edge_ngram filter stops at 2 characters, so 'headpho' has nothing to match; min_gram 2 with a max_gram over the longest word fixes it while keeping single letters out of the index." : "asciifolding before the edge n-grams at index time and in the search analyzer makes cafe find Café; max_gram must cover 'headphones' (10 letters) for the full-word query to match.",
  }));

  /* ---------- 8. nested vs object ---------- */
  SCEN.push(querySc({
    id: "es-nested",
    name: "Stop the cross-object matches",
    kind: "Incident",
    skills: ["design", "diagnose"],
    make(lv, R) {
      const skus = R.sample(["KB-100", "MS-220", "HD-310", "CB-045", "LS-900", "DK-777"], 4);
      const [A, Bk, X, Y] = skus;
      const n = R.int(4, 6);
      const lines = [
        [{ sku: A, qty: n + 1, status: "ok" }, { sku: Bk, qty: 1, status: "ok" }],
        [{ sku: A, qty: 1, status: "ok" }, { sku: X, qty: n + 3, status: "ok" }],
        [{ sku: A, qty: n, status: "backordered" }, { sku: Bk, qty: 2, status: "ok" }],
        [{ sku: Bk, qty: n + 2, status: "ok" }, { sku: A, qty: 2, status: "ok" }],
        [{ sku: A, qty: n + 4, status: "ok" }, { sku: Y, qty: 1, status: "backordered" }, { sku: Bk, qty: 1, status: "ok" }],
        [{ sku: A, qty: n + 2, status: "ok" }],
        [{ sku: X, qty: 9, status: "ok" }, { sku: Y, qty: 1, status: "ok" }],
        [{ sku: A, qty: n, status: "ok" }, { sku: Bk, qty: n, status: "backordered" }],
      ];
      const docs = R.shuffle(lines).map((l, i) => ({ _id: "ord-" + (8800 + i * 7), customer: R.pick(["c-17", "c-42", "c-88", "c-91"]), lines: lv === 3 ? l : l.map(({ sku, qty }) => ({ sku, qty })) }));
      const nestedMap = { mappings: { properties: { customer: { type: "keyword" }, lines: { type: "nested", properties: { sku: { type: "keyword" }, qty: { type: "integer" }, ...(lv === 3 ? { status: { type: "keyword" } } : {}) } } } } };
      const objMap = { mappings: { properties: { customer: { type: "keyword" }, lines: { properties: { sku: { type: "keyword" }, qty: { type: "integer" } } } } } };
      const nq = (q) => ({ nested: { path: "lines", query: q } });
      const both = (s, min) => ({ bool: { filter: [{ term: { "lines.sku": s } }, ...(min ? [{ range: { "lines.qty": { gte: min } } }] : [])] } });
      const I = { lv, A, Bk, n, docs, label: "customer", cols: [{ h: "lines", f: (s) => s.lines.map((x) => `${x.sku}×${x.qty}${x.status === "backordered" ? " (backordered)" : ""}`).join(", ") }], iname: "orders", minWant: lv === 3 ? 1 : 2, rows: 12 };
      if (lv === 1) Object.assign(I, { index: nestedMap, ref: J({ query: nq(both(A, n)) }), bads: [J({ query: both(A, n) }), J({ query: { bool: { filter: [nq({ term: { "lines.sku": A } }), nq({ range: { "lines.qty": { gte: n } } })] } } })], starter: JP({ query: both(A, n) }) });
      if (lv === 2) Object.assign(I, { index: nestedMap, oldMap: objMap, ref: J({ query: nq(both(A, n)) }), bads: [J({ query: both(A, n) })], starter: JP({ query: both(A, n) }) });
      if (lv === 3) Object.assign(I, { index: nestedMap, ref: J({ query: { bool: { filter: [nq(both(A, n)), nq({ term: { "lines.sku": Bk } })], must_not: [nq({ term: { "lines.status": "backordered" } })] } } }),
        bads: [J({ query: nq({ bool: { filter: [{ term: { "lines.sku": A } }, { range: { "lines.qty": { gte: n } } }, { term: { "lines.sku": Bk } }] } }) }), J({ query: { bool: { filter: [nq(both(A, n)), nq({ term: { "lines.sku": Bk } }), nq({ bool: { must_not: [{ term: { "lines.status": "backordered" } }] } })] } } }), J({ query: { bool: { filter: [nq(both(A, n)), nq({ term: { "lines.sku": Bk } })] } } })],
        starter: JP({ query: { bool: { filter: [nq(both(A, n))] } } }) });
      return I;
    },
    text: (I) => I.lv === 1 ? `<p>Fulfilment needs every order that has <b>one line</b> with SKU <code>${esc(I.A)}</code> and quantity <b>≥ ${I.n}</b> (bulk orders). <code>lines</code> is mapped as <code>nested</code>. The query below returns nothing.</p>${K.pre(JP(I.index.mappings))}${docsTable(I, ["customer", "lines"])}`
      : I.lv === 2 ? `<p>The bulk-order report (SKU <code>${esc(I.A)}</code>, quantity ≥ ${I.n} on the same line) runs on the <b>old</b> index, where <code>lines</code> is a plain object array, and returns orders that have no such line. You've rebuilt the index with <code>lines</code> as <code>nested</code>; the old query, shown below, now returns nothing at all.</p>${K.pre("old: " + J(I.oldMap.mappings) + "\nnew: " + J(I.index.mappings))}<p>Write the query for the <b>new</b> index that returns only orders with a single line of ${esc(I.A)} × ≥ ${I.n}.</p>${docsTable(I, ["customer", "lines"])}`
        : `<p>Fulfilment wants orders that have a line of <code>${esc(I.A)}</code> with quantity ≥ ${I.n}, <b>and</b> (on any line) <code>${esc(I.Bk)}</code>, and <b>no backordered line at all</b>. <code>lines</code> is nested.</p>${docsTable(I, ["customer", "lines"])}`,
    hint: (I) => I.lv === 1 ? "Nested sub-documents are indexed as separate hidden documents. Fields inside them can only be reached through a nested query." : I.lv === 2 ? "An object array is flattened: lines.sku and lines.qty become two independent lists on the order, so the conditions can be satisfied by different lines." : "Each nested query asks 'does some line satisfy this?'. Two different lines need two nested clauses. 'No line is backordered' is not the same as 'some line is not backordered'.",
    concept: "nested vs object arrays",
    how: "Elasticsearch flattens arrays of objects: <code>lines: [{sku: A, qty: 1}, {sku: B, qty: 9}]</code> becomes <code>lines.sku: [A, B]</code> and <code>lines.qty: [1, 9]</code> on the parent, so a query for A with qty ≥ 5 matches across objects. A <code>nested</code> field indexes each object as a hidden Lucene document next to its parent, so a <code>nested</code> query evaluates all its conditions within one object. Each nested clause means 'some object matches'; negations belong outside (<code>must_not: nested(...)</code>) to mean 'no object matches'. Nested docs cost index size and query time, and are capped by <code>index.mapping.nested_objects.limit</code> (10,000 per document).",
    rule: "Use nested only when you must correlate fields of the same array element; otherwise denormalise or flatten. Put negations outside the nested query.",
    why: (I) => I.lv === 1 ? "Querying lines.sku from the root returns nothing because the line fields live only in the hidden nested documents. Two separate nested clauses would let different lines satisfy each condition." : I.lv === 2 ? `On the object mapping, ${I.docs.length} orders' line fields were flattened into independent lists, so an order with ${esc(I.A)}×1 and another SKU ×${I.n + 3} matched. The nested query checks SKU and quantity on the same line.` : "Two nested clauses let different lines satisfy each condition; must_not around a nested query excludes orders where any line is backordered, while a must_not inside nested only requires one line that isn't.",
  }));

  /* ---------- 9. date math and time zones ---------- */
  SCEN.push(querySc({
    id: "es-date-math",
    name: "Yesterday, in whose time zone?",
    kind: "Incident",
    skills: ["diagnose"],
    make(lv, R) {
      const now = Date.UTC(2026, 6, 15, 10, 0, 0);
      const h = 3600000;
      let times, ref, bads, tz;
      if (lv === 1) {
        const d8 = Date.UTC(2026, 6, 8);
        times = [d8 + R.int(1, 8) * h, d8 + R.int(1, 8) * h + 1800000, d8 - R.int(1, 5) * h, Date.UTC(2026, 6, 10, R.int(0, 23)), Date.UTC(2026, 6, 12, R.int(0, 23)), Date.UTC(2026, 6, 15, R.int(0, 9)), Date.UTC(2026, 6, 6, R.int(0, 23)), Date.UTC(2026, 6, 14, R.int(0, 23))];
        ref = J({ query: { range: { created_at: { gte: "now-7d/d" } } } });
        bads = [J({ query: { range: { created_at: { gte: "now-7d" } } } }), J({ query: { range: { created_at: { gte: "now-1w/w" } } } })];
      } else if (lv === 2) {
        tz = R.pick(["Europe/Berlin", "Europe/Paris", "Europe/Madrid"]);
        const d14 = Date.UTC(2026, 6, 14);
        times = [d14 - R.int(1, 2) * h + 1800000, d14 + R.int(1, 20) * h, d14 + 22 * h + 1800000, d14 + 23 * h, d14 + R.int(3, 12) * h, d14 - 3 * h, Date.UTC(2026, 6, 15, 1), Date.UTC(2026, 6, 13, 12)];
        ref = J({ query: { range: { created_at: { gte: "now-1d/d", lt: "now/d", time_zone: tz } } } });
        bads = [J({ query: { range: { created_at: { gte: "now-1d/d", lt: "now/d" } } } }), J({ query: { range: { created_at: { gte: "now-24h", lt: "now" } } } }), J({ query: { range: { created_at: { gte: "now-1d/d", lte: "now/d", time_zone: tz } } } })];
      } else {
        tz = R.pick(["America/New_York", "America/Chicago"]);
        const off = tz === "America/New_York" ? 4 : 5;
        times = [Date.UTC(2026, 5, 1, off - 1), Date.UTC(2026, 5, 1, off + 1), Date.UTC(2026, 5, 30, 22 + off - 24 + 24), Date.UTC(2026, 6, 1, off - 2), Date.UTC(2026, 6, 1, off + 1), Date.UTC(2026, 5, R.int(5, 25), R.int(0, 23)), Date.UTC(2026, 6, R.int(2, 14), R.int(0, 23)), Date.UTC(2026, 4, 31, 12)];
        ref = J({ query: { range: { created_at: { gte: "now-1M/M", lte: "now-1M/M", time_zone: tz } } } });
        bads = [J({ query: { range: { created_at: { gte: "now-1M/M", lte: "now-1M/M" } } } }), J({ query: { range: { created_at: { gte: "now-1M/M", lte: "now/M", time_zone: tz } } } }), J({ query: { range: { created_at: { gte: "now-1M/M", lt: "now-1M/M", time_zone: tz } } } })];
      }
      const docs = R.shuffle(times).map((t, i) => ({ _id: "o-" + (900 + i * 11), created_at: new Date(t).toISOString().replace(".000", ""), total: R.int(10, 300) }));
      return { lv, now, tz, index: { mappings: { properties: { created_at: { type: "date" }, total: { type: "float" } } } }, iname: "orders", label: "created_at", docs, ref, bads, cols: ["created_at", "total"], minWant: 2, starter: JP({ query: { range: { created_at: {} } } }) };
    },
    text: (I) => `<p>It is <b>${new Date(I.now).toISOString().replace(".000", "")}</b> (now). <code>created_at</code> is a <code>date</code> field; documents store UTC.</p><p>${I.lv === 1 ? "The weekly report must include every order since <b>midnight UTC seven days ago</b> (whole days), up to now. Use date math rather than a hard-coded timestamp, so the saved query keeps working." : I.lv === 2 ? `The ops team in <b>${esc(I.tz)}</b> wants <b>yesterday's</b> orders, as their calendar defines yesterday. The current dashboard query uses <code>now-1d/d</code> to <code>now/d</code> and finance says it's off.` : `Finance in <b>${esc(I.tz)}</b> closes the books for <b>last calendar month</b>. Their query tool only emits <code>gte</code>/<code>lte</code> bounds. Write the range that returns exactly last month in their time zone, using date math.`}</p>${docsTable(I, ["created_at", "total"])}`,
    hint: (I) => I.lv === 1 ? "now-7d is seven days ago to the millisecond. /d rounds to the start of the day." : I.lv === 2 ? "Date math rounding (/d) happens in UTC unless the range query has a time_zone parameter." : "With rounding, lte rounds up to the last millisecond of the unit, gte rounds down. Which month does now-1M/M refer to?",
    concept: "Date math, rounding and time_zone in range queries",
    how: "Date math expressions like <code>now-7d/d</code> subtract and then round. Rounding depends on the bound: <code>gte</code> and <code>lt</code> round down to the start of the unit, <code>gt</code> and <code>lte</code> round up to its last millisecond, so <code>gte: now-1M/M, lte: now-1M/M</code> covers all of last month. Rounding and dates without an offset are interpreted in UTC unless the query sets <code>time_zone</code>, which also handles daylight saving. Rounded expressions are cache-friendly: <code>now</code> on its own changes every millisecond.",
    rule: "Store UTC, query with time_zone set to the user's zone, and round now (now/d, now/m) so 'last N days' means whole days and the filter can be cached.",
    why: (I) => I.lv === 1 ? "now-7d starts at 10:00 UTC seven days ago and drops the early orders of that day; now-1w/w rounds to Monday. now-7d/d starts at midnight." : I.lv === 2 ? `Without time_zone, yesterday is midnight-to-midnight UTC, which is 02:00–02:00 in ${esc(I.tz)} in summer: orders from just after local midnight land in the wrong day. time_zone: "${esc(I.tz)}" moves both rounded bounds.` : `gte now-1M/M rounds down to June 1 00:00 and lte now-1M/M rounds up to June 30 23:59:59.999, both in ${esc(I.tz)}. lte now/M would round up to the end of <i>this</i> month; without time_zone, the month boundary is 4–5 hours off.`,
  }));

  /* ---------- 10. aggregations ---------- */
  function aggSig(res, o) {
    const out = [];
    Object.values(res.aggregations || {}).forEach((a) => {
      if (!a.buckets) return;
      let bs = a.buckets.filter((b) => !o.nonEmpty || b.doc_count > 0);
      if (o.top) bs = bs.slice(0, o.top);
      out.push(bs.map((b) => [b.key, b.doc_count, ...Object.values(b).filter((v) => isObj(v) && "value" in v).map((v) => +(+v.value).toFixed(2)).sort((x, y) => x - y)]));
    });
    return out;
  }
  SCEN.push((() => {
    const judge = (I, src) => {
      const p = parseReq(src); if (p.err) return p.err;
      if (!p.val.aggs && !p.val.aggregations) return "Add an <code>aggs</code> section: the dashboard reads buckets, not hits.";
      const r = runQ(I, p.val);
      if (r.err) return r.err;
      const sig = aggSig(r.res, I.o);
      if (I.lv === 1 && sig.length && sig[0].length < I.o.top) return `Only ${sig[0].length} buckets came back; the widget shows the top ${I.o.top}.`;
      if (sig.some((s) => LB.same(s, I.want))) return true;
      if (!sig.length) return "No bucket aggregation in the response.";
      const s = sig[0];
      return `Buckets don't match: you got ${s.slice(0, 6).map((b) => `${esc(typeof b[0] === "number" ? new Date(b[0]).toISOString().slice(0, 16) : b[0])}: ${b.slice(1).join("/")}`).join(", ")}. Check what's counted (filters), how buckets are cut (time zone) and which metric each bucket carries.`;
    };
    return {
      id: "es-aggs",
      name: "Build the dashboard query",
      kind: "Investigation",
      skills: ["design"],
      w: "code",
      gen(lv, R) {
        let docs, ref, bads, o, iname = "orders", index = {}, starter;
        if (lv === 1) {
          iname = "products";
          const brands = R.sample(["Acme", "Volt", "Lumen", "Kestrel", "Northwind", "Ridgeline"], 5);
          const w = [6, 5, 4, 2, 1];
          docs = [];
          brands.forEach((b, k) => { for (let i = 0; i < w[k] + 1; i++) docs.push({ brand: b, in_stock: i < w[k], name: "Item " + docs.length }); });
          docs = R.shuffle(docs).map((d, i) => ({ _id: "p" + (i + 1), ...d }));
          o = { top: 3 };
          ref = J({ size: 0, query: { term: { in_stock: true } }, aggs: { brands: { terms: { field: "brand.keyword", size: 3 } } } });
          bads = [J({ size: 0, query: { term: { in_stock: true } }, aggs: { brands: { terms: { field: "brand", size: 3 } } } }), J({ size: 0, aggs: { brands: { terms: { field: "brand.keyword", size: 3 } } } })];
          starter = JP({ size: 0, aggs: { brands: { terms: { field: "brand" } } } });
        } else {
          const tz = lv === 2 ? R.pick(["Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"]) : "UTC";
          index = lv === 2 ? { mappings: { properties: { status: { type: "keyword" }, created_at: { type: "date" }, total: { type: "float" } } } } : {};
          docs = [];
          const custs = ["c-11", "c-12", "c-13", "c-14", "c-15"];
          for (let i = 0; i < 16; i++) docs.push({ _id: "o-" + (400 + i), status: R.chance(0.7) ? "paid" : R.pick(["refunded", "pending"]), customer_id: R.pick(custs), total: R.int(2, 40) * 5, created_at: new Date(Date.UTC(2026, 6, 10 + R.int(0, 3), R.pick([1, 3, 6, 11, 16, 19, 21, 23]), R.int(0, 59))).toISOString().replace(".000", "") });
          o = { nonEmpty: true };
          if (lv === 2) {
            ref = J({ size: 0, query: { term: { status: "paid" } }, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day", time_zone: tz } } } });
            bads = [J({ size: 0, query: { term: { status: "paid" } }, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day" } } } }), J({ size: 0, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day", time_zone: tz } } } }), J({ size: 0, query: { term: { status: "paid" } }, aggs: { per_day: { date_histogram: { field: "created_at", fixed_interval: "24h" } } } })];
            starter = JP({ size: 0, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day" } } } });
          } else {
            ref = J({ size: 0, query: { term: { "status.keyword": "paid" } }, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day" }, aggs: { buyers: { cardinality: { field: "customer_id.keyword" } }, revenue: { sum: { field: "total" } } } } } });
            bads = [J({ size: 0, query: { term: { "status.keyword": "paid" } }, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day" }, aggs: { buyers: { value_count: { field: "customer_id.keyword" } }, revenue: { sum: { field: "total" } } } } } }), J({ size: 0, query: { term: { "status.keyword": "paid" } }, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day" }, aggs: { buyers: { cardinality: { field: "customer_id" } }, revenue: { sum: { field: "total" } } } } } }), J({ size: 0, query: { match: { status: "paid" } }, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day" }, aggs: { buyers: { cardinality: { field: "customer_id.keyword" } }, revenue: { avg: { field: "total" } } } } } })];
            starter = JP({ size: 0, query: { term: { "status.keyword": "paid" } }, aggs: { per_day: { date_histogram: { field: "created_at", calendar_interval: "day" } } } });
          }
          o.tz = tz;
        }
        const I = { lv, iname, index, docs, o, ref, bads, starter, label: lv === 1 ? "brand" : "created_at" };
        const r = runQ(I, JSON.parse(ref));
        if (r.err) throw new Error(r.err);
        I.want = aggSig(r.res, o)[0];
        if (lv === 1) { const all = runQ(I, { size: 0, query: { term: { in_stock: true } }, aggs: { b: { terms: { field: "brand.keyword", size: 10 } } } }).res.aggregations.b.buckets; if (all[2].doc_count === all[3].doc_count) return null; }
        for (const b of bads) if (judge(I, b) === true) return null;
        return I;
      },
      text: (I) => I.lv === 1 ? `<p>The storefront needs a "top brands" widget: the <b>3 brands with the most in-stock products</b>, with counts. <code>products</code> was created by dynamic mapping. The first attempt fails.</p>${docsTable(I, ["brand", "in_stock"])}`
        : I.lv === 2 ? `<p>The ${esc(I.o.tz)} team's dashboard shows <b>paid orders per day</b>, where a day is their local calendar day. Write the aggregation request.</p>${docsTable(I, ["status", "created_at", "total"])}`
          : `<p>The growth dashboard needs, for each UTC day: the <b>number of distinct customers</b> who placed paid orders and the <b>total revenue</b> of paid orders. <code>orders</code> uses dynamic mapping (so strings are <code>text</code> + <code>.keyword</code>).</p>${docsTable(I, ["status", "customer_id", "created_at", "total"])}`,
      ui: (I) => ({ lang: "json", file: `GET ${I.iname}/_search`, starter: I.starter, rows: 12, liveDelay: 350, live: (src) => {
        if (!src || !src.trim()) return `<p class="muted small">Write the request to see the buckets.</p>`;
        const p = parseReq(src); if (p.err) return `<p class="lose small">${p.err}</p>`;
        const r = runQ(I, p.val); if (r.err) return `<p class="lose small">${r.err}</p>`;
        return r.res.aggregations ? K.pre(pj(r.res.aggregations).split("\n").slice(0, 60).join("\n")) : `<p class="muted small">${r.res.hits.total.value} hits, no aggregations.</p>`;
      } }),
      accept: (I, src) => judge(I, src),
      solve: (I) => I.ref,
      bad: (I) => I.bads,
      hint: (I) => I.lv === 1 ? "Aggregations need doc values. Dynamic mapping gave every string a .keyword sub-field. And which products count?" : I.lv === 2 ? "date_histogram buckets are cut in UTC unless you pass time_zone." : "Distinct customers is a cardinality aggregation (on a keyword field), nested under the date_histogram next to a sum.",
      concept: "Aggregations on doc values",
      how: "Aggregations read per-document values from doc values, a columnar structure that keyword, numeric and date fields have but text fields don't, which is why a terms agg on a text field fails with the fielddata error. Aggregations run over every document the query matches (not just the returned page), so filters in the query shape the counts. <code>date_histogram</code> cuts buckets on calendar or fixed intervals in UTC unless <code>time_zone</code> is set. <code>cardinality</code> is an approximate distinct count (HyperLogLog++, exact up to <code>precision_threshold</code>, default 3000) and nests under bucket aggs.",
      rule: "Aggregate on keyword/numeric/date fields, put the population in the query, pass the viewer's time_zone to date_histogram, and use cardinality (not value_count) for distinct counts.",
      why: (I) => I.lv === 1 ? "terms on brand (text) fails: there are no doc values; brand.keyword works. Without the in_stock filter, brands with many out-of-stock items would rank too high." : I.lv === 2 ? `Without time_zone, orders placed early in the morning in ${esc(I.o.tz)} land in the previous UTC day. time_zone moves the bucket boundaries to local midnight.` : "cardinality on customer_id.keyword counts distinct buyers per bucket; value_count counts orders. The text field customer_id can't be aggregated at all.",
    };
  })());

  /* ---------- 11. ILM policy ---------- */
  const SIZE = (s) => { const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/i.exec(String(s).trim()); if (!m) return null; return +m[1] * { b: 1 / 1e9, kb: 1e-6, mb: 1e-3, gb: 1, tb: 1000 }[m[2].toLowerCase()]; };
  const AGE = (s) => { const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(s).trim()); if (!m) return null; return +m[1] * { ms: 1 / 3600000, s: 1 / 3600, m: 1 / 60, h: 1, d: 24 }[m[2]]; };
  function ilmSim(I, src) {
    const p = parseReq(src); if (p.err) return { err: p.err };
    const pol = p.val.policy;
    if (!isObj(pol) || !isObj(pol.phases)) return { err: `The body must be <code>{"policy": {"phases": {...}}}</code>.` };
    const allowed = { hot: ["rollover", "set_priority", "forcemerge", "shrink", "readonly", "downsample"], warm: ["allocate", "migrate", "forcemerge", "shrink", "readonly", "set_priority"], cold: ["allocate", "migrate", "readonly", "set_priority", "searchable_snapshot"], frozen: ["searchable_snapshot"], delete: ["delete", "wait_for_snapshot"] };
    let prev = 0, prevName = null;
    const ph = {};
    for (const name of ["hot", "warm", "cold", "frozen", "delete"]) {
      const x = pol.phases[name];
      if (!x) continue;
      const ma = x.min_age == null ? 0 : AGE(x.min_age);
      if (ma == null) return { err: `failed to parse [min_age] in phase [${name}]: <code>${esc(x.min_age)}</code> (use e.g. "7d", "12h")` };
      if (ma < prev) return { err: `phases [${prevName}] configure a [min_age] value greater than the [min_age] of phase [${name}]: phases must have increasing min_age` };
      Object.keys(x.actions || {}).forEach((a) => { if (!allowed[name].includes(a)) ph.bad = `invalid action [${a}] defined in phase [${name}]`; });
      ph[name] = { ma, actions: x.actions || {} };
      prev = ma; prevName = name;
    }
    Object.keys(pol.phases).forEach((n) => { if (!allowed[n]) ph.bad = `unknown phase [${n}]`; });
    if (ph.bad) return { err: esc(ph.bad) };
    const ro = ph.hot && ph.hot.actions.rollover;
    if (ph.delete && !("delete" in ph.delete.actions)) return { err: "The delete phase needs a <code>delete</code> action." };
    let maxAge = null, maxShard = null, maxSize = null;
    if (ro) {
      if (ro.max_age != null) { maxAge = AGE(ro.max_age); if (maxAge == null) return { err: `failed to parse rollover max_age <code>${esc(ro.max_age)}</code>` }; }
      if (ro.max_primary_shard_size != null) { maxShard = SIZE(ro.max_primary_shard_size); if (maxShard == null) return { err: `failed to parse max_primary_shard_size <code>${esc(ro.max_primary_shard_size)}</code>` }; }
      if (ro.max_size != null) { maxSize = SIZE(ro.max_size); if (maxSize == null) return { err: `failed to parse max_size <code>${esc(ro.max_size)}</code>` }; }
      if (maxAge == null && maxShard == null && maxSize == null && ro.max_docs == null && ro.max_primary_shard_docs == null) return { err: "rollover requires at least one max_* condition" };
    }
    // hourly simulation over 120 days
    const H = 120 * 24, rate = I.gbDay / 24;
    const idx = [{ c: 0, size: 0, ro: null, del: null }];
    for (let t = 1; t <= H; t++) {
      const cur = idx[idx.length - 1];
      cur.size += rate;
      if (ro) {
        const age = t - cur.c;
        if ((maxAge != null && age >= maxAge) || (maxShard != null && cur.size / I.prim >= maxShard) || (maxSize != null && cur.size >= maxSize)) { cur.ro = t; idx.push({ c: t, size: 0, ro: null }); }
      }
    }
    // phase times are relative to rollover (or creation if never rolled)
    idx.forEach((x) => { const o = x.ro == null ? x.c : x.ro; x.warm = ph.warm ? o + ph.warm.ma : null; x.del = ph.delete ? (x.ro == null && ro ? null : o + ph.delete.ma) : null; });
    const steady = idx.filter((x) => x.c >= 40 * 24 && x.c < 90 * 24);
    const maxShardGb = Math.max(...steady.map((x) => x.size / I.prim));
    const minShardGb = Math.min(...steady.filter((x) => x.ro != null).map((x) => x.size / I.prim));
    const live = idx.filter((x) => x.del == null || x.del > 100 * 24);
    const deletedLive = idx.find((x) => x.ro == null && x.del != null && x.del <= H);
    const ret = steady.filter((x) => x.del != null).map((x) => ({ newest: (x.del - (x.ro == null ? x.c : x.ro)) / 24, oldest: (x.del - x.c) / 24 }));
    const minRet = ret.length ? Math.min(...ret.map((r) => r.newest)) : Infinity, maxRet = ret.length ? Math.max(...ret.map((r) => r.oldest)) : Infinity;
    const at = 100 * 24;
    const hotGb = idx.filter((x) => x.c <= at && (x.del == null || x.del > at) && (x.warm == null || x.warm > at)).reduce((s, x) => s + Math.min(x.size, (Math.min(at, x.ro || at) - x.c) * rate), 0) * (1 + I.rep);
    const indices = idx.filter((x) => x.c <= at && (x.del == null || x.del > at)).length;
    return { maxShardGb, minShardGb, minRet, maxRet, hotGb, indices, deletedLive: !!deletedLive, rolls: !!ro, live: live.length };
  }
  function ilmChecks(I, r) {
    const c = [
      { name: "Largest primary shard", value: `${K.num(r.maxShardGb, 0)} GB`, ok: r.maxShardGb <= 50, target: "≤ 50 GB" },
      { name: "Data kept at least", value: Number.isFinite(r.minRet) ? `${K.num(r.minRet, 1)} days` : "forever", ok: r.minRet >= I.ret, target: `≥ ${I.ret} days` },
      { name: "Oldest data kept", value: Number.isFinite(r.maxRet) ? `${K.num(r.maxRet, 1)} days` : "forever", ok: r.maxRet <= I.ret + I.slack, target: `≤ ${I.ret + I.slack} days` },
    ];
    if (I.lv >= 2) c.splice(1, 0, { name: "Smallest primary shard", value: Number.isFinite(r.minShardGb) ? `${K.num(r.minShardGb, 0)} GB` : "–", ok: Number.isFinite(r.minShardGb) && r.minShardGb >= 10, target: "≥ 10 GB" });
    if (I.lv === 3) c.push({ name: "Hot tier usage", value: `${K.num(r.hotGb, 0)} GB`, ok: r.hotGb <= I.hotCap, target: `≤ ${K.num(I.hotCap)} GB` });
    return c;
  }
  SCEN.push({
    id: "es-ilm-policy",
    name: "Write the ILM policy",
    kind: "Config change",
    skills: ["design", "estimate"],
    w: "code",
    gen(lv, R) {
      if (lv === 1) return { lv, gbDay: R.pick([20, 30, 40]), prim: 1, rep: 1, ret: R.pick([14, 30]), slack: 3 };
      if (lv === 2) return { lv, gbDay: R.pick([240, 300, 360]), prim: R.pick([2, 3]), rep: 1, ret: 30, slack: 3 };
      const gbDay = R.pick([400, 500, 600]), prim = 4, ret = 30;
      return { lv, gbDay, prim, rep: 1, ret, slack: 2, hotCap: gbDay * 2 * R.pick([5, 6]) };
    },
    text: (I) => `<p>Logs land in the data stream <code>logs-${I.lv === 1 ? "checkout" : I.lv === 2 ? "edge" : "platform"}</code> at about <b>${I.gbDay} GB/day</b> of primary data. The index template sets <b>${I.prim} primary shard${I.prim > 1 ? "s" : ""}</b> and 1 replica. Requirements: every log line searchable for <b>at least ${I.ret} days</b>, none kept longer than <b>${I.ret + I.slack} days</b> (privacy policy), primary shards ≤ 50 GB${I.lv >= 2 ? " and ≥ 10 GB (no tiny shards)" : ""}.${I.lv === 3 ? ` The hot tier has <b>${K.num(I.hotCap)} GB</b> of usable disk (primaries + replicas); older data must move to the warm tier.` : ""}</p><p>Write the ILM policy (<code>PUT _ilm/policy/logs</code>). The panel simulates 120 days of ingest.</p>`,
    ui: (I) => ({ lang: "json", file: "PUT _ilm/policy/logs", rows: 16, starter: JP({ policy: { phases: { hot: { actions: {} }, delete: { min_age: "", actions: { delete: {} } } } } }), liveDelay: 400, live: (src) => {
      if (!src || !src.trim()) return "";
      const r = ilmSim(I, src);
      if (r.err) return `<p class="lose small">${r.err}</p>`;
      return K.metrics(ilmChecks(I, r)) + `<p class="small muted">${r.rolls ? `Steady state: about ${r.indices} backing indices.` : "No rollover: one ever-growing index."}</p>`;
    } }),
    accept(I, src) {
      const r = ilmSim(I, src);
      if (r.err) return r.err;
      if (!r.rolls) return "Without a rollover action the data stream writes to one backing index forever: it grows without bound and the delete phase can never remove old data without removing new data.";
      const f = ilmChecks(I, r).find((c) => !c.ok);
      return f ? `${f.name} is ${f.value} (needs ${f.target}).` : true;
    },
    solve: (I) => {
      const hot = { actions: { rollover: I.lv === 1 ? { max_age: "1d", max_primary_shard_size: "50gb" } : { max_age: "1d", max_primary_shard_size: "40gb" } } };
      const phases = { hot };
      if (I.lv === 3) phases.warm = { min_age: "1d", actions: { forcemerge: { max_num_segments: 1 } } };
      phases.delete = { min_age: I.ret + "d", actions: { delete: {} } };
      return JSON.stringify({ policy: { phases } }, null, 2);
    },
    bad: (I) => [
      J({ policy: { phases: { hot: { actions: {} }, delete: { min_age: I.ret + "d", actions: { delete: {} } } } } }),
      J({ policy: { phases: { hot: { actions: { rollover: { max_age: "1d" } } }, delete: { min_age: I.ret - 1 + "d", actions: { delete: {} } } } } }),
      ...(I.lv >= 2 ? [J({ policy: { phases: { hot: { actions: { rollover: { max_age: "1d" } } }, delete: { min_age: I.ret + "d", actions: { delete: {} } } } } })] : [J({ policy: { phases: { hot: { actions: { rollover: { max_age: "7d" } } }, delete: { min_age: I.ret + "d", actions: { delete: {} } } } } })]),
      ...(I.lv === 3 ? [J({ policy: { phases: { hot: { actions: { rollover: { max_age: "1d", max_primary_shard_size: "40gb" } } }, warm: { min_age: "7d", actions: {} }, delete: { min_age: I.ret + "d", actions: { delete: {} } } } } })] : []),
    ],
    hint: (I) => I.lv === 1 ? "Phase min_age counts from rollover, not from when the index was created. The newest document in an index is written right before rollover." : I.lv === 2 ? `${I.gbDay} GB/day over ${I.prim} primaries is ${Math.round(I.gbDay / I.prim)} GB per shard per day. Roll over on shard size, and keep max_age as a backstop for quiet days.` : "Hot usage ≈ daily volume × (1 + replicas) × days the data stays hot. Move to warm early.",
    concept: "ILM: rollover, phase ages and retention",
    how: "Rollover starts a new backing index when any <code>max_*</code> condition is met (age, primary shard size, docs), which keeps shards in the 10–50 GB sweet spot whatever the ingest rate. Each later phase's <code>min_age</code> is measured from the <b>rollover</b> time of that index, so an index is deleted <code>delete.min_age</code> after its newest document arrived; its oldest document is older by the index's lifespan. Without rollover nothing ever finishes being written. Hot-warm moves indices to cheaper nodes (data tiers move them automatically in the warm phase), and the hot tier must hold daily volume × (1 + replicas) × days-in-hot.",
    rule: "Roll over on max_primary_shard_size (with max_age as a backstop), set delete.min_age to the retention you promise, and size the hot tier from days-in-hot, not total retention.",
    why: (I, sol) => { const r = ilmSim(I, sol); return `The reference policy rolls over at ${I.lv === 1 ? "1 day or 50 GB" : "40 GB per primary shard or 1 day"}, giving shards up to ${K.num(r.maxShardGb, 0)} GB; deleting ${I.ret} days after rollover keeps every line between ${K.num(r.minRet, 1)} and ${K.num(r.maxRet, 1)} days${I.lv === 3 ? `, and moving to warm after 1 day keeps the hot tier at about ${K.num(r.hotGb, 0)} GB` : ""}.`; },
  });

  /* ---------- 12. mapping explosion ---------- */
  function explodeDocs(I) {
    const R = D.campaign.rng("es-explode/" + I.seed);
    const keys = Array.from({ length: I.pool }, (_, i) => ["feature", "team_owner", "canary", "region_hint", "exp", "build", "ab", "flag"][i % 8] + "_" + i);
    const svc = ["checkout", "payments", "search", "cart"];
    return Array.from({ length: I.n }, (_, i) => {
      const labels = { team: R.pick(["payments", "growth", "platform"]), env: R.pick(["prod", "staging"]) };
      R.sample(keys, 4).forEach((k) => (labels[k] = "v" + R.int(1, 9)));
      if (i === 3) labels[I.probe] = I.probeVal;
      const d = { _id: "log-" + i, "@timestamp": new Date(Date.UTC(2026, 6, 15, 9, 0, i)).toISOString().replace(".000", ""), service: R.pick(svc), message: R.pick(["payment authorised", "card declined", "timeout calling ledger", "retrying request"]), labels };
      if (I.lv === 3) { const pl = {}; R.sample(keys, 3).forEach((k) => (pl[k.replace(/_\d+$/, "") + "_" + R.int(1, 400)] = "x")); pl.email = "user" + i + "@example.com"; d.payload = pl; }
      return d;
    });
  }
  SCEN.push(mappingSc({
    id: "es-field-explosion",
    name: "Contain the mapping explosion",
    kind: "Incident",
    skills: ["design", "diagnose"],
    make(lv, R) {
      const I = { lv, seed: R.int(1, 1e9), n: 60, pool: 300, probe: "feature_" + 8 * R.int(1, 30), probeVal: "on", iname: "logs-app-000042", label: "message", rows: 16 };
      I.docs = explodeDocs(I);
      I.limit = lv === 3 ? 60 : 200;
      const settings = { "index.mapping.total_fields.limit": I.limit };
      const ref = { settings, mappings: { properties: { "@timestamp": { type: "date" }, service: { type: "keyword" }, message: { type: "text" }, labels: lv === 1 ? { dynamic: false, properties: { team: { type: "keyword" }, env: { type: "keyword" } } } : { type: "flattened" }, ...(lv === 3 ? { payload: { type: "object", enabled: false } } : {}) } } };
      I.tests = [{ name: "team filter", req: { query: { term: { "labels.team": "payments" } } }, kind: "set" }, { name: "message search", req: { query: { match: { message: "card declined" } } }, kind: "set" }];
      if (lv >= 2) I.tests.push({ name: `ad-hoc label ${I.probe}`, req: { query: { term: { ["labels." + I.probe]: I.probeVal } } }, kind: "set" });
      if (lv === 3) I.tests.push({ name: "payload is not searchable", req: { query: { term: { "payload.email": "user3@example.com" } } }, kind: "set" });
      I.ref = J(ref); I.index = ref;
      I.starter = JP({ settings, mappings: { properties: { "@timestamp": { type: "date" }, service: { type: "keyword" }, message: { type: "text" } } } });
      I.bads = [J({ settings, mappings: { properties: { "@timestamp": { type: "date" }, service: { type: "keyword" }, message: { type: "text" } } } }), J({ settings, mappings: { properties: { "@timestamp": { type: "date" }, service: { type: "keyword" }, message: { type: "text" }, labels: { dynamic: "strict", properties: { team: { type: "keyword" }, env: { type: "keyword" } } } } } })];
      if (lv >= 2) I.bads.push(J({ settings, mappings: { properties: { "@timestamp": { type: "date" }, service: { type: "keyword" }, message: { type: "text" }, labels: { dynamic: false, properties: { team: { type: "keyword" }, env: { type: "keyword" } } }, ...(lv === 3 ? { payload: { enabled: false } } : {}) } } }));
      if (lv === 3) I.bads.push(J({ settings, mappings: { properties: { "@timestamp": { type: "date" }, service: { type: "keyword" }, message: { type: "text" }, labels: { type: "flattened" }, payload: { type: "flattened" } } } }));
      return I;
    },
    text: (I) => `<p><b>PAGE:</b> log ingestion for <code>logs-app</code> is rejecting documents:</p>${K.pre(`illegal_argument_exception: Limit of total fields [${I.limit}] has been exceeded while adding new fields [4]`)}<p>Services attach arbitrary Kubernetes and feature-flag labels under <code>labels</code>${I.lv === 3 ? ", and one service now ships a raw customer <code>payload</code> object (PII, with arbitrary keys)" : ""}. ${I.docs.length} sample documents below use ${I.pool}+ distinct label keys. Write the mapping for the next backing index (the limit stays at ${I.limit}). Every document must be accepted and these must work:</p>${testsHTML(I)}${docsTable(I, ["service", "message", "labels"], I.docs.slice(0, 4))}<p class="small muted">${I.lv >= 2 ? `On-call engineers filter on whatever label they need during an incident (e.g. <code>labels.${esc(I.probe)}</code>).` : "Dashboards only ever filter on labels.team and labels.env."}${I.lv === 3 ? " The payload must be kept in <code>_source</code> for debugging but must not be searchable." : ""}</p>`,
    hint: (I) => I.lv === 1 ? "You don't have to index every key. An object can stop dynamic mapping for its children while keeping them in _source." : I.lv === 2 ? "One field type indexes all leaf values of an object as keywords under a single mapped field." : "An object with enabled: false is stored in _source but not parsed or indexed at all.",
    concept: "Mapping explosion and the field limit",
    how: "With dynamic mapping, every new key in a document becomes a new field in the index mapping, kept in the cluster state and replicated to every node. User-controlled keys (labels, headers, payloads) grow the mapping without bound, so <code>index.mapping.total_fields.limit</code> (1000 by default) rejects documents once it's reached; raising it only moves the cliff. <code>dynamic: false</code> keeps unknown keys in _source but unindexed, <code>flattened</code> maps a whole object as one field whose leaves are searchable as keywords (<code>labels.anything</code>), and <code>enabled: false</code> stores an object without parsing it. A mapping change applies to new indices, so you fix the template and roll over.",
    rule: "Never let user-controlled keys become fields: use flattened for key/value bags you need to filter on, dynamic: false or enabled: false for the rest, and fix it in the index template followed by a rollover.",
    why: (I) => I.lv === 1 ? `Default dynamic mapping adds a field per label key and blows through ${I.limit}. labels with dynamic: false plus explicit team/env keywords keeps the mapping tiny; strict would reject every document with an unknown label.` : I.lv === 2 ? `flattened indexes every label leaf under one mapped field, so labels.${esc(I.probe)} is filterable without being a field of its own. dynamic: false would make that ad-hoc filter return nothing.` : "flattened for labels, enabled: false for payload: the PII is kept in _source for debugging but never enters the inverted index, and the mapping stays under the 60-field limit. Flattened payload would make the email searchable.",
  }));

  /* ---------- registration (c-es-2.js may load before or after this file) ---------- */
  LB.addAll("es", SCEN);
  LB._esLoaded = true;
  if (LB._esMore) { LB.addAll("es", LB._esMore); LB._esMore = null; }
})();
