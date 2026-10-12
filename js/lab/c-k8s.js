/* Systems Lab · Kubernetes (part 1): a mini cluster simulator driven by a kubectl sandbox.
   The simulator keeps nodes (allocatable, taints, labels, zones), Deployments (rolling updates with maxSurge /
   maxUnavailable), StatefulSets (OrderedReady), Services, PDBs and pods. Scenarios plug in a health function H(pod, st)
   that decides what each container does (CrashLoopBackOff, OOMKilled, probes...) and their own extra commands. */
(function () {
  "use strict";
  const D = window.DSA, LB = D.lab, K = LB.k, U = D.util;
  const esc = U.esc;

  /* ---------- quantities ---------- */
  const cpuS = (m) => (m >= 1000 && m % 1000 === 0 ? String(m / 1000) : Math.round(m) + "m");
  const memS = (mi) => (mi >= 1024 && mi % 1024 === 0 ? mi / 1024 + "Gi" : Math.round(mi) + "Mi");
  const pCpu = (s) => { if (s == null) return null; const m = String(s).match(/^(\d+(?:\.\d+)?)(m?)$/); return m ? (m[2] ? +m[1] : Math.round(+m[1] * 1000)) : null; };
  const pMem = (s) => {
    if (s == null) return null;
    const m = String(s).match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|K|M|G)?$/);
    if (!m) return null;
    const f = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1048576, k: 1000 / 1048576, K: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576 }[m[2]];
    return m[2] ? Math.round(+m[1] * f) : Math.round(+m[1] / 1048576);
  };
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

  /* ---------- YAML emitter (kubectl -o yaml style) ---------- */
  const ysc = (x) => (x === null ? "null" : typeof x === "string" ? (/^[A-Za-z0-9_./@][A-Za-z0-9_ ./:@,=+-]*$/.test(x) && !/^(true|false|null|yes|no|on|off|[-+]?[\d.]+)$/i.test(x) && !/[:\s]$/.test(x) && !/: /.test(x) ? x : JSON.stringify(x)) : String(x));
  function yml(v, ind) {
    const pad = " ".repeat(ind);
    if (Array.isArray(v)) return v.length ? v.map((x) => (isObj(x) && Object.keys(x).length ? pad + "- " + yml(x, ind + 2).slice(ind + 2) : pad + "- " + (Array.isArray(x) ? "[]" : isObj(x) ? "{}" : ysc(x)))).join("\n") : pad + "[]";
    return Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => {
      const kk = /^[A-Za-z0-9_./-]+$/.test(k) ? k : JSON.stringify(k);
      if (isObj(x)) return Object.keys(x).length ? `${pad}${kk}:\n${yml(x, ind + 2)}` : `${pad}${kk}: {}`;
      if (Array.isArray(x)) return x.length ? `${pad}${kk}:\n${yml(x, ind)}` : `${pad}${kk}: []`;
      if (typeof x === "string" && x.includes("\n")) return `${pad}${kk}: |\n${x.replace(/\n$/, "").split("\n").map((l) => pad + "  " + l).join("\n")}`;
      return `${pad}${kk}: ${ysc(x)}`;
    }).join("\n");
  }
  const toYaml = (v) => yml(v, 0);

  /* ---------- names ---------- */
  const ALPH = "bcdfghjklmnpqrstvwxz2456789";
  const hstr = (s, n) => { let o = "", h = K.hash(s); for (let i = 0; i < n; i++) { if (h < 27) h = K.hash(o + s + i); o += ALPH[h % 27]; h = Math.floor(h / 27); } return o; };
  const tplHash = (tpl) => hstr(K.stable(tpl), 10);
  const ipOf = (name) => { const h = K.hash(name); return `10.42.${(h >>> 8) % 60 + 1}.${(h % 250) + 2}`; };

  /* ---------- pod template builder (k8s-shaped) ---------- */
  function probe(p) {
    if (!p) return undefined;
    const o = p.exec ? { exec: { command: p.exec } } : p.tcp ? { tcpSocket: { port: p.port } } : { httpGet: { path: p.path, port: p.port } };
    if (p.delay) o.initialDelaySeconds = p.delay;
    o.periodSeconds = p.period || 10; o.timeoutSeconds = p.timeout || 1; o.failureThreshold = p.fail || 3;
    return o;
  }
  function mkTpl(o) {
    const res = {};
    if (o.cpu != null || o.mem != null) { res.requests = {}; if (o.cpu != null) res.requests.cpu = cpuS(o.cpu); if (o.mem != null) res.requests.memory = memS(o.mem); }
    if (o.lcpu != null || o.lmem != null) { res.limits = {}; if (o.lcpu != null) res.limits.cpu = cpuS(o.lcpu); if (o.lmem != null) res.limits.memory = memS(o.lmem); }
    const c = { name: o.cname || o.app, image: o.image, ports: [{ containerPort: o.port || 8080, name: o.portName || "http", protocol: "TCP" }] };
    if (o.cmd) c.command = o.cmd;
    if (o.env && o.env.length) c.env = o.env.map((e) => (e.sec ? { name: e.n, valueFrom: { secretKeyRef: { name: e.sec, key: e.key } } } : e.cm ? { name: e.n, valueFrom: { configMapKeyRef: { name: e.cm, key: e.key } } } : { name: e.n, value: String(e.v) }));
    if (o.envFrom) c.envFrom = o.envFrom.map((n) => ({ configMapRef: { name: n } }));
    c.resources = res;
    if (o.live) c.livenessProbe = probe(o.live);
    if (o.ready) c.readinessProbe = probe(o.ready);
    if (o.startup) c.startupProbe = probe(o.startup);
    if (o.mounts) c.volumeMounts = o.mounts;
    const spec = { containers: [c] };
    if (o.sel) spec.nodeSelector = o.sel;
    if (o.tol) spec.tolerations = o.tol;
    if (o.pullSecrets) spec.imagePullSecrets = o.pullSecrets.map((n) => ({ name: n }));
    if (o.vols) spec.volumes = o.vols;
    const md = { labels: o.labels || { app: o.app } };
    if (o.ann) md.annotations = o.ann;
    return { metadata: md, spec };
  }
  const C0 = (t) => t.spec.containers[0];
  const img = (t) => C0(t).image;
  const tag = (t) => img(t).split(":").pop();
  const envOf = (t, n) => (C0(t).env || []).find((e) => e.name === n);
  const reqOf = (t) => {
    let cpu = 0, mem = 0;
    t.spec.containers.forEach((c) => { const r = (c.resources || {}).requests || {}, l = (c.resources || {}).limits || {}; cpu += pCpu(r.cpu != null ? r.cpu : l.cpu) || 0; mem += pMem(r.memory != null ? r.memory : l.memory) || 0; });
    return { cpu, mem };
  };
  const limOf = (t) => { const l = (C0(t).resources || {}).limits || {}; return { cpu: pCpu(l.cpu), mem: pMem(l.memory) }; };
  const qosOf = (t) => {
    let all = true, any = false;
    t.spec.containers.forEach((c) => {
      const r = (c.resources || {}).requests || {}, l = (c.resources || {}).limits || {};
      ["cpu", "memory"].forEach((k) => { if (r[k] != null || l[k] != null) any = true; const rq = r[k] != null ? r[k] : l[k]; if (l[k] == null || String(rq) !== String(l[k])) all = false; });
    });
    return all ? "Guaranteed" : any ? "Burstable" : "BestEffort";
  };

  /* ---------- scheduling ---------- */
  const tolerates = (tols, t) => (tols || []).some((x) => (x.operator === "Exists" ? (!x.key || x.key === t.key) : x.key === t.key && String(x.value == null ? "" : x.value) === String(t.value == null ? "" : t.value)) && (!x.effect || x.effect === t.effect));
  const nodeTaints = (n) => {
    const t = (n.taints || []).slice();
    if (n.ready === "Unknown") t.push({ key: "node.kubernetes.io/unreachable", effect: "NoSchedule" });
    else if (n.ready === "False") t.push({ key: "node.kubernetes.io/not-ready", effect: "NoSchedule" });
    if (n.cordon) t.push({ key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" });
    return t;
  };
  const live = (p) => !p.done && !p.term;
  const podsOn = (st, n) => st.pods.filter((p) => p.node === n.name && live(p));
  const usedOn = (st, n) => {
    let cpu = 0, mem = 0;
    (n.sys || []).forEach((s) => { cpu += s.cpu; mem += s.mem; });
    podsOn(st, n).forEach((p) => { const r = reqOf(p.tpl); cpu += r.cpu; mem += r.mem; });
    return { cpu, mem };
  };
  function fitReasons(st, pod, n) {
    if (n.cordon) return ["node(s) were unschedulable"];
    const bad = nodeTaints(n).filter((t) => t.key !== "node.kubernetes.io/unschedulable" && (t.effect === "NoSchedule" || t.effect === "NoExecute") && !tolerates(pod.tpl.spec.tolerations, t));
    if (bad.length) return [`node(s) had untolerated taint {${bad[0].key}: ${bad[0].value || ""}}`];
    const sel = pod.tpl.spec.nodeSelector || {};
    if (Object.keys(sel).some((k) => (n.labels || {})[k] !== sel[k])) return ["node(s) didn't match Pod's node affinity/selector"];
    const u = usedOn(st, n), r = reqOf(pod.tpl), out = [];
    if (u.cpu + r.cpu > n.cpu) out.push("Insufficient cpu");
    if (u.mem + r.mem > n.mem) out.push("Insufficient memory");
    if (out.length) return out;
    if (pod.vzone && n.zone !== pod.vzone) return ["node(s) had volume node affinity conflict"];
    if (pod.anti && podsOn(st, n).some((p) => p.own === pod.own)) return ["node(s) didn't match pod anti-affinity rules"];
    return [];
  }
  function trySchedule(st, pod, cfg) {
    if (pod.node) return true;
    if (cfg.preSched) { const m = cfg.preSched(pod, st); if (m) { pod.why = m; return false; } }
    const hist = {}, ok = [];
    st.nodes.forEach((n) => { const r = fitReasons(st, pod, n); if (!r.length) ok.push(n); r.forEach((x) => (hist[x] = (hist[x] || 0) + 1)); });
    if (!ok.length) {
      const N = st.nodes.length;
      const reasons = Object.entries(hist).map(([k, v]) => `${v} ${k}`).sort();
      let res = 0; st.nodes.forEach((n) => { const r = fitReasons(st, pod, n); if (r.some((x) => /^Insufficient/.test(x))) res++; });
      const pre = [res ? `${res} No preemption victims found for incoming pod` : "", N - res ? `${N - res} Preemption is not helpful for scheduling` : ""].filter(Boolean).sort();
      pod.why = `0/${N} nodes are available: ${reasons.join(", ")}. preemption: 0/${N} nodes are available: ${pre.join(", ")}.`;
      return false;
    }
    const score = (n) => { const u = usedOn(st, n); const same = podsOn(st, n).filter((p) => p.own === pod.own).length; const sameZ = st.pods.filter((p) => p.own === pod.own && live(p) && p.node && (st.nodes.find((x) => x.name === p.node) || {}).zone === n.zone).length; return ((n.cpu - u.cpu) / n.cpu + (n.mem - u.mem) / n.mem) / 2 - same * 0.6 - sameZ * 0.25; };
    ok.sort((a, b) => score(b) - score(a) || (a.name < b.name ? -1 : 1));
    pod.node = ok[0].name; pod.why = null; pod.ip = ipOf(pod.name);
    return true;
  }

  /* ---------- health ---------- */
  const HEALTHY = { s: "Running", ready: true, rc: 0 };
  function health(st, pod, cfg) {
    if (pod.done) return { s: pod.doneS || "Completed", ready: false, rc: 0 };
    if (pod.term) return { s: "Terminating", ready: false, rc: 0 };
    if (!pod.node) return { s: pod.pendS || "Pending", ready: false, rc: 0 };
    const n = st.nodes.find((x) => x.name === pod.node);
    if (n && n.ready !== "True") return { s: "Running", ready: false, rc: 0, stale: true };
    const h = cfg.H ? cfg.H(pod, st) : null;
    return h ? { rc: 0, ...h } : HEALTHY;
  }
  const isReady = (st, p, cfg) => !!p.node && health(st, p, cfg).ready;

  /* ---------- controllers ---------- */
  const pctOf = (v, R, up) => { if (typeof v === "string" && /%$/.test(v)) { const x = (R * parseFloat(v)) / 100; return up ? Math.ceil(x - 1e-9) : Math.floor(x + 1e-9); } return +v; };
  function newPod(st, cfg, own, name, tpl, hash, extra) {
    const p = { name, own, hash, tpl: K.clone(tpl), node: null, ip: "", age: st.init ? cfg.newAge || "9m" : "6s", ...extra };
    if (cfg.admit) { const m = cfg.admit(p, st); if (m) { st.fc[own] = m; return null; } }
    delete st.fc[own];
    st.pods.push(p);
    trySchedule(st, p, cfg);
    return p;
  }
  function rollDeploy(st, dn, cfg) {
    const d = st.deploys[dn], own = "deploy:" + dn, hash = tplHash(d.tpl), R = d.replicas;
    let surge = pctOf(d.surge, R, true), unav = pctOf(d.unav, R, false);
    if (!surge && !unav) unav = 1;
    st.pods.filter((p) => p.own === own && !p.node && live(p)).forEach((p) => trySchedule(st, p, cfg));
    const rdy = (p) => isReady(st, p, cfg);
    for (let it = 0; it < 60; it++) {
      const mine = st.pods.filter((p) => p.own === own && live(p));
      const nw = mine.filter((p) => p.hash === hash), old = mine.filter((p) => p.hash !== hash);
      const create = () => !!newPod(st, cfg, own, `${dn}-${hash}-${hstr(dn + hash + st.salt++, 5)}`, d.tpl, hash);
      const remove = (list, k) => { const order = list.slice().sort((a, b) => (rdy(a) - rdy(b)) || (a.node ? 1 : 0) - (b.node ? 1 : 0)); order.slice(0, k).forEach((p) => (st.pods = st.pods.filter((x) => x !== p))); return k > 0; };
      if (!old.length) {
        if (nw.length < R) { if (!create()) break; continue; }
        if (nw.length > R) { remove(nw, nw.length - R); continue; }
        break;
      }
      const newTarget = Math.min(R, Math.max(nw.length, R + surge - old.length));
      if (nw.length < newTarget) { if (!create()) break; continue; }
      const newReady = nw.filter(rdy).length;
      const maxDown = mine.length - (R - unav) - (nw.length - newReady);
      if (maxDown > 0) {
        const unr = old.filter((p) => !rdy(p)), ok = old.filter(rdy);
        const a = Math.min(maxDown, unr.length), b = Math.min(maxDown - a, ok.length);
        if (a + b > 0) { remove(unr, a); if (b) st.pods = st.pods.filter((x) => !ok.slice(0, b).includes(x)); continue; }
      }
      break;
    }
  }
  function rollSts(st, sn, cfg) {
    const s = st.sts[sn], own = "sts:" + sn, hash = tplHash(s.tpl);
    const rdy = (p) => isReady(st, p, cfg);
    for (let it = 0; it < 40; it++) {
      const mine = st.pods.filter((p) => p.own === own && live(p));
      mine.filter((p) => !p.node).forEach((p) => trySchedule(st, p, cfg));
      const byOrd = (i) => st.pods.find((p) => p.own === own && !p.done && p.ord === i);
      // scale down from the highest ordinal
      const extra = mine.filter((p) => p.ord >= s.replicas).sort((a, b) => b.ord - a.ord);
      if (extra.length) { if (mine.some((p) => p.ord < s.replicas && !rdy(p))) break; st.pods = st.pods.filter((x) => x !== extra[0]); continue; }
      let acted = false, halt = false;
      for (let i = 0; i < s.replicas; i++) {
        const p = byOrd(i);
        if (!p) {
          const claim = `${s.claim || "data"}-${sn}-${i}`;
          if (s.claim && !st.pvcs[claim]) st.pvcs[claim] = { sc: s.sc, size: s.size || "20Gi", zone: null, fresh: true };
          newPod(st, cfg, own, `${sn}-${i}`, s.tpl, hash, { ord: i, claim: s.claim ? claim : null });
          acted = true; break;
        }
        if (!rdy(p)) { halt = true; break; }
      }
      if (acted) continue;
      if (halt) break;
      const stale = mine.filter((p) => p.hash !== hash).sort((a, b) => b.ord - a.ord)[0];
      if (stale) { st.pods = st.pods.filter((x) => x !== stale); continue; }
      break;
    }
  }
  function reconcile(st, cfg) {
    if (cfg.pre) cfg.pre(st);
    for (let pass = 0; pass < 2; pass++) {
      Object.keys(st.deploys || {}).sort().forEach((dn) => rollDeploy(st, dn, cfg));
      Object.keys(st.sts || {}).sort().forEach((sn) => rollSts(st, sn, cfg));
    }
    st.pods.filter((p) => !p.node && live(p)).forEach((p) => trySchedule(st, p, cfg));
    if (cfg.post) cfg.post(st);
  }

  /* ---------- cluster setup ---------- */
  function mkNodes(R, spec) {
    // spec: [{zone:'a', n, cpu, mem, itype, labels, taints, pool}]
    const out = [];
    spec.forEach((g) => { for (let i = 0; i < g.n; i++) {
      const name = `${g.pool || "prod"}-${g.zone}-${hstr(g.zone + i + R.int(0, 1e6), 4)}`;
      out.push({ name, zone: g.region ? g.region + g.zone : "eu-west-1" + g.zone, itype: g.itype || "m6i.xlarge", cpu: g.cpu || 3920, mem: g.mem || 14480, taints: (g.taints || []).map((t) => ({ ...t })), labels: { ...(g.labels || {}) }, cordon: false, ready: "True", arch: g.arch || "amd64",
        sys: [{ ns: "kube-system", name: "kube-proxy-" + hstr(name + "kp", 5), cpu: 100, mem: 0, ds: true }, { ns: "kube-system", name: "aws-node-" + hstr(name + "an", 5), cpu: 50, mem: 0, ds: true }, ...(g.sys || [])] });
    } });
    out.forEach((n) => { n.labels = { "kubernetes.io/arch": n.arch, "kubernetes.io/hostname": n.name, "node.kubernetes.io/instance-type": n.itype, "topology.kubernetes.io/zone": n.zone, ...n.labels }; });
    return out;
  }
  function mkState(o) {
    return { ns: o.ns || "shop", nodes: o.nodes, deploys: o.deploys || {}, sts: o.sts || {}, pods: [], svcs: o.svcs || {}, pdbs: o.pdbs || {}, cms: o.cms || {}, secrets: o.secrets || {}, pvcs: o.pvcs || {}, sas: o.sas || { default: {} }, quotas: o.quotas || {}, fc: {}, ev: o.ev || [], salt: 1, x: o.x || {}, t: 0, init: true };
  }
  // Seed pods of the previous (stable) template, then let the controllers act on the current one.
  function boot(st, cfg, seedOld) {
    Object.entries(seedOld || {}).forEach(([dn, tpl]) => {
      const d = st.deploys[dn], hash = tplHash(tpl);
      for (let i = 0; i < d.replicas; i++) { const p = { name: `${dn}-${hash}-${hstr(dn + hash + i, 5)}`, own: "deploy:" + dn, hash, tpl: K.clone(tpl), node: null, ip: "", age: cfg.oldAge || "6d" }; st.pods.push(p); trySchedule(st, p, cfg); }
    });
    reconcile(st, cfg);
    st.init = false;
    return st;
  }

  /* ---------- rendering ---------- */
  const ownKind = (p) => (p.own.startsWith("deploy:") ? "ReplicaSet" : p.own.startsWith("sts:") ? "StatefulSet" : p.own.startsWith("job:") ? "Job" : "");
  const ownName = (p) => (p.own.startsWith("deploy:") ? p.own.slice(7) + "-" + p.hash : p.own.split(":")[1]);
  const nContainers = (p) => p.tpl.spec.containers.length;
  const rcStr = (h) => (h.rc ? `${h.rc}${h.ago ? ` (${h.ago} ago)` : ""}` : "0");
  function podRows(st, cfg, list, wide, labels) {
    const head = ["NAME", "READY", "STATUS", "RESTARTS", "AGE"];
    if (wide) head.push("IP", "NODE", "NOMINATED NODE", "READINESS GATES");
    if (labels) head.push("LABELS");
    const rows = list.map((p) => {
      const h = health(st, p, cfg), n = nContainers(p);
      const r = [p.name, `${h.ready ? n : h.readyN || 0}/${n}`, h.s, rcStr(h), p.age];
      if (wide) r.push(p.node ? p.ip : "<none>", p.node || "<none>", "<none>", p.gates ? `${p.gates}` : "<none>");
      if (labels) r.push(Object.entries({ ...(p.tpl.metadata.labels || {}), ...(p.hash && p.own.startsWith("deploy:") ? { "pod-template-hash": p.hash } : {}) }).map(([k, v]) => `${k}=${v}`).join(","));
      return r;
    });
    return K.cols([head, ...rows]);
  }
  const probeStr = (p) => {
    if (!p) return null;
    const how = p.httpGet ? `http-get http://:${p.httpGet.port}${p.httpGet.path}` : p.tcpSocket ? `tcp-socket :${p.tcpSocket.port}` : `exec [${(p.exec.command || []).join(" ")}]`;
    return `${how} delay=${p.initialDelaySeconds || 0}s timeout=${p.timeoutSeconds || 1}s period=${p.periodSeconds || 10}s #success=${p.successThreshold || 1} #failure=${p.failureThreshold || 3}`;
  };
  function envLines(c) {
    const out = [];
    (c.envFrom || []).forEach((e) => out.push(`      ${e.configMapRef ? "ConfigMap  " + e.configMapRef.name : "Secret  " + e.secretRef.name}  Optional: false`));
    if (!(c.env || []).length) return out.length ? ["    Environment Variables from:", ...out, "    Environment:  <none>"] : ["    Environment:  <none>"];
    const w = Math.max(...c.env.map((e) => e.name.length)) + 3;
    return [...(out.length ? ["    Environment Variables from:", ...out] : []), "    Environment:", ...c.env.map((e) => `      ${(e.name + ":").padEnd(w)}${e.valueFrom ? (e.valueFrom.secretKeyRef ? `<set to the key '${e.valueFrom.secretKeyRef.key}' in secret '${e.valueFrom.secretKeyRef.name}'>  Optional: false` : `<set to the key '${e.valueFrom.configMapKeyRef.key}' of config map '${e.valueFrom.configMapKeyRef.name}'>  Optional: false`) : e.value}`)];
  }
  const evTable = (ev) => (ev && ev.length ? "Events:\n" + K.cols([["  Type", "Reason", "Age", "From", "Message"], ["  ----", "------", "----", "----", "-------"], ...ev.map((e) => ["  " + e[0], e[1], e[2], e[3], e[4]])]) : "Events:  <none>");
  function describePod(st, cfg, p) {
    const h = health(st, p, cfg), n = st.nodes.find((x) => x.name === p.node), t = p.tpl;
    const lines = [`Name:             ${p.name}`, `Namespace:        ${p.ns || st.ns}`, `Priority:         ${p.prio || 0}`, `Service Account:  default`, `Node:             ${n ? `${n.name}/${n.ip || "10.0." + (K.hash(n.name) % 200) + "." + (K.hash(n.name + "x") % 250)}` : "<none>"}`];
    const labs = Object.entries({ ...(t.metadata.labels || {}), ...(p.own.startsWith("deploy:") ? { "pod-template-hash": p.hash } : {}) }).map(([k, v]) => `${k}=${v}`);
    lines.push(`Labels:           ${labs[0] || "<none>"}`, ...labs.slice(1).map((l) => `                  ${l}`));
    lines.push(`Status:           ${p.term ? "Terminating (lasts " + (p.termFor || "12m") + ")" : !p.node ? "Pending" : h.phase || (p.done ? "Succeeded" : "Running")}`, `IP:               ${p.node ? p.ip : ""}`);
    if (ownKind(p)) lines.push(`Controlled By:    ${ownKind(p)}/${ownName(p)}`);
    lines.push("Containers:");
    t.spec.containers.forEach((c, ci) => {
      const ch = ci === 0 ? h : h.c2 || HEALTHY;
      lines.push(`  ${c.name}:`, `    Image:          ${c.image}`);
      if (c.ports && c.ports[0]) lines.push(`    Port:           ${c.ports[0].containerPort}/TCP`);
      if (c.command) lines.push(`    Command:`, ...c.command.map((x) => `      ${x}`));
      if (!p.node) { /* unscheduled: no container status yet */ }
      else if (ch.s === "Running" || ch.s === "Terminating" || ch.s === "Completed") lines.push(`    State:          ${ch.s === "Completed" ? "Terminated" : "Running"}`);
      else lines.push("    State:          Waiting", `      Reason:       ${ch.s}`);
      if (ch.last) lines.push("    Last State:     Terminated", `      Reason:       ${ch.last.reason}`, `      Exit Code:    ${ch.last.code}`);
      if (p.node) lines.push(`    Ready:          ${ch.ready ? "True" : "False"}`, `    Restart Count:  ${ch.rc || 0}`);
      const r = c.resources || {};
      if (r.limits) lines.push("    Limits:", ...Object.entries(r.limits).map(([k, v]) => `      ${(k + ":").padEnd(8)} ${v}`));
      if (r.requests) lines.push("    Requests:", ...Object.entries(r.requests).map(([k, v]) => `      ${(k + ":").padEnd(8)} ${v}`));
      [["Liveness", c.livenessProbe], ["Readiness", c.readinessProbe], ["Startup", c.startupProbe]].forEach(([k, pr]) => { if (pr) lines.push(`    ${(k + ":").padEnd(11)} ${probeStr(pr)}`); });
      lines.push(...envLines(c));
      lines.push("    Mounts:", ...(c.volumeMounts || []).map((m) => `      ${m.mountPath} from ${m.name} (${m.readOnly ? "ro" : "rw"})${m.subPath ? ` [subPath: ${m.subPath}]` : ""}`), `      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-${hstr(p.name, 5)} (ro)`);
    });
    if (!p.node) lines.push("Conditions:", "  Type           Status", "  PodScheduled   False");
    else lines.push("Conditions:", "  Type                        Status", `  PodReadyToStartContainers   ${p.node ? "True" : "False"}`, `  Initialized                 ${p.node ? "True" : "False"}`, `  Ready                       ${h.ready ? "True" : "False"}`, `  ContainersReady             ${h.ready ? "True" : "False"}`, `  PodScheduled                ${p.node ? "True" : "False"}`);
    if (p.claim) lines.push("Volumes:", `  ${p.claim.split("-")[0]}:`, "    Type:       PersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)", `    ClaimName:  ${p.claim}`, "    ReadOnly:   false");
    lines.push(`QoS Class:                   ${qosOf(t)}`, `Node-Selectors:              ${Object.entries(t.spec.nodeSelector || {}).map(([k, v]) => `${k}=${v}`).join(",") || "<none>"}`);
    const tols = [...(t.spec.tolerations || []).map((x) => `${x.key || ""}${x.operator === "Exists" ? "" : "=" + (x.value || "")}:${x.effect || ""}${x.operator === "Exists" ? " op=Exists" : ""}`), "node.kubernetes.io/not-ready:NoExecute op=Exists for 300s", "node.kubernetes.io/unreachable:NoExecute op=Exists for 300s"];
    lines.push(`Tolerations:                 ${tols[0]}`, ...tols.slice(1).map((x) => `                             ${x}`));
    let ev = [];
    if (!p.node && p.why) ev.push(["Warning", "FailedScheduling", "2m10s (x6 over 9m)", "default-scheduler", p.why]);
    else if (p.node && !p.term) ev.push(["Normal", "Scheduled", p.age, "default-scheduler", `Successfully assigned ${st.ns}/${p.name} to ${p.node}`]);
    if (p.node) ev = ev.concat(h.ev || (h.s === "Running" ? [["Normal", "Pulled", p.age, "kubelet", `Container image "${img(t)}" already present on machine`], ["Normal", "Created", p.age, "kubelet", `Created container ${C0(t).name}`], ["Normal", "Started", p.age, "kubelet", `Started container ${C0(t).name}`]] : []));
    if (p.evx) ev = ev.concat(p.evx);
    lines.push(evTable(ev));
    return lines.join("\n");
  }
  function describeNode(st, cfg, n) {
    const u = usedOn(st, n), pods = [...(n.sys || []).map((s) => ({ ns: s.ns, name: s.name, cpu: s.cpu, mem: s.mem, age: "41d" })), ...podsOn(st, n).map((p) => ({ ns: st.ns, name: p.name, cpu: reqOf(p.tpl).cpu, mem: reqOf(p.tpl).mem, lc: limOf(p.tpl).cpu, lm: limOf(p.tpl).mem, age: p.age }))];
    const c = n.cond || {};
    const cond = [["MemoryPressure", c.mem ? "True" : "False", c.mem ? "KubeletHasInsufficientMemory" : "KubeletHasSufficientMemory", c.mem ? "kubelet has insufficient memory available" : "kubelet has sufficient memory available"],
      ["DiskPressure", c.disk ? "True" : "False", c.disk ? "KubeletHasDiskPressure" : "KubeletHasNoDiskPressure", c.disk ? "kubelet has disk pressure" : "kubelet has no disk pressure"],
      ["PIDPressure", "False", "KubeletHasSufficientPID", "kubelet has sufficient PID available"],
      n.ready === "True" ? ["Ready", "True", "KubeletReady", "kubelet is posting ready status"] : n.ready === "Unknown" ? ["Ready", "Unknown", "NodeStatusUnknown", "Kubelet stopped posting node status."] : ["Ready", "False", "KubeletNotReady", n.notReadyMsg || "container runtime is down"]];
    if (n.ready === "Unknown") cond.forEach((r) => { if (r[0] !== "Ready") { r[1] = "Unknown"; r[2] = "NodeStatusUnknown"; r[3] = "Kubelet stopped posting node status."; } });
    const taints = nodeTaints(n).map((t) => `${t.key}${t.value ? "=" + t.value : ""}:${t.effect}`);
    const pct = (a, b) => Math.round((a / b) * 100);
    const lines = [`Name:               ${n.name}`, `Roles:              <none>`, `Labels:             ${Object.entries(n.labels).map(([k, v]) => `${k}=${v}`).join("\n                    ")}`, `Taints:             ${taints[0] || "<none>"}`, ...taints.slice(1).map((t) => `                    ${t}`), `Unschedulable:      ${n.cordon ? "true" : "false"}`,
      "Conditions:", K.cols([["  Type", "Status", "Reason", "Message"], ["  ----", "------", "------", "-------"], ...cond.map((r) => ["  " + r[0], r[1], r[2], r[3]])]),
      "Allocatable:", `  cpu:                ${cpuS(n.cpu)}`, `  ephemeral-storage:  95491281146`, `  memory:             ${n.mem * 1024}Ki`, `  pods:               ${n.maxPods || 58}`,
      "System Info:", `  Kernel Version:             6.1.112-124.190.amzn2023.x86_64`.replace("x86_64", n.arch === "arm64" ? "aarch64" : "x86_64"), `  Container Runtime Version:  containerd://1.7.23`, `  Kubelet Version:            ${n.kver || "v1.31.4"}`, `  Architecture:               ${n.arch}`,
      `Non-terminated Pods:          (${pods.length} in total)`,
      K.cols([["  Namespace", "Name", "CPU Requests", "CPU Limits", "Memory Requests", "Memory Limits", "Age"], ["  ---------", "----", "------------", "----------", "---------------", "-------------", "---"], ...pods.map((p) => ["  " + p.ns, p.name, `${cpuS(p.cpu)} (${pct(p.cpu, n.cpu)}%)`, p.lc ? `${cpuS(p.lc)} (${pct(p.lc, n.cpu)}%)` : "0 (0%)", `${memS(p.mem)} (${pct(p.mem, n.mem)}%)`, p.lm ? `${memS(p.lm)} (${pct(p.lm, n.mem)}%)` : "0 (0%)", p.age])]),
      "Allocated resources:", "  (Total limits may be over 100 percent, i.e., overcommitted.)", K.cols([["  Resource", "Requests", "Limits"], ["  --------", "--------", "------"], ["  cpu", `${cpuS(u.cpu)} (${pct(u.cpu, n.cpu)}%)`, "-"], ["  memory", `${memS(u.mem)} (${pct(u.mem, n.mem)}%)`, "-"]]),
      evTable((cfg.nodeEv && cfg.nodeEv(n, st)) || [])];
    return lines.join("\n");
  }

  /* ---------- patches ---------- */
  function smp(base, patch, key) {
    if (patch === null) return undefined;
    if (Array.isArray(patch)) {
      if (!Array.isArray(base) || !key) return K.clone(patch);
      const out = base.map((x) => K.clone(x));
      patch.forEach((x) => { const i = out.findIndex((y) => y[key] === x[key]); if (i >= 0) out[i] = smp(out[i], x, null); else out.push(K.clone(x)); });
      return out;
    }
    if (!isObj(patch)) return patch;
    const out = isObj(base) ? { ...base } : {};
    Object.entries(patch).forEach(([k, v]) => { const mk = { containers: "name", initContainers: "name", env: "name", ports: "containerPort", volumes: "name", volumeMounts: "mountPath", imagePullSecrets: "name" }[k]; const r = smp(out[k], v, mk); if (r === undefined) delete out[k]; else out[k] = r; });
    return out;
  }
  function mergePatch(base, patch) {
    if (!isObj(patch)) return patch;
    const out = isObj(base) ? { ...base } : {};
    Object.entries(patch).forEach(([k, v]) => { if (v === null) delete out[k]; else out[k] = mergePatch(out[k], v); });
    return out;
  }
  function jsonPatch(obj, ops) {
    const o = K.clone(obj);
    for (const op of ops) {
      if (!op || !op.path) throw new Error("invalid JSON patch operation");
      const parts = op.path.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
      let cur = o;
      for (let i = 0; i < parts.length - 1; i++) {
        const k = Array.isArray(cur) ? +parts[i] : parts[i];
        if (cur[k] == null) { if (op.op === "add") cur[k] = {}; else throw new Error(`replace operation does not apply: doc is missing path: "${op.path}": missing value`); }
        cur = cur[k];
      }
      const last = parts[parts.length - 1];
      if (op.op === "remove") { if (Array.isArray(cur)) cur.splice(+last, 1); else delete cur[last]; }
      else if (op.op === "add" && Array.isArray(cur)) { if (last === "-") cur.push(op.value); else cur.splice(+last, 0, op.value); }
      else if (op.op === "replace" && !(last in cur)) throw new Error(`replace operation does not apply: doc is missing key: ${op.path}: missing value`);
      else if (op.op === "add" || op.op === "replace") cur[last] = op.value;
      else throw new Error(`unknown patch op "${op.op}"`);
    }
    return o;
  }
  function applyPatch(obj, type, raw) {
    let p;
    try { p = JSON.parse(raw); } catch (e) { return { err: `error: unable to parse "${raw.slice(0, 40)}": yaml: did not find expected node content` }; }
    try {
      if (type === "json") return { val: jsonPatch(obj, p) };
      if (type === "merge") return { val: mergePatch(obj, p) };
      return { val: smp(obj, p, null) };
    } catch (e) { return { err: "The request is invalid: " + e.message }; }
  }

  /* ---------- the kubectl sandbox ---------- */
  function tokenize(s) {
    const out = []; let cur = "", q = null, has = false;
    for (const c of s) {
      if (q) { if (c === q) q = null; else cur += c; }
      else if (c === "'" || c === '"') { q = c; has = true; }
      else if (c === " ") { if (cur || has) out.push(cur); cur = ""; has = false; }
      else cur += c;
    }
    if (cur || has) out.push(cur);
    return out;
  }
  const VAL_FLAGS = new Set(["-n", "--namespace", "-o", "--output", "-l", "--selector", "-c", "--container", "--containers", "-p", "--patch", "--type", "-L", "--label-columns", "-f", "--filename", "--for", "--timeout", "--sort-by", "--field-selector", "--to-revision", "--replicas", "--limits", "--requests", "--grace-period", "--revision", "--tail", "--since", "--from", "--from-literal", "--image"]);
  function parseArgs(toks) {
    const f = {}, pos = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === "--") { f["--"] = toks.slice(i + 1); break; }
      if (/^--?[A-Za-z]/.test(t)) {
        const eq = t.indexOf("=");
        if (eq > 0) { const k = t.slice(0, eq); (f[k] = f[k] || []).push(t.slice(eq + 1)); }
        else if (VAL_FLAGS.has(t)) { (f[t] = f[t] || []).push(toks[i + 1] == null ? "" : toks[i + 1]); i++; }
        else f[t] = [true];
      } else pos.push(t);
    }
    const g = (...ks) => { for (const k of ks) if (f[k]) return f[k][f[k].length - 1]; return undefined; };
    return { f, pos, g, has: (...ks) => ks.some((k) => f[k]) };
  }
  const RES = { po: "pods", pod: "pods", pods: "pods", deploy: "deployments", deployment: "deployments", deployments: "deployments", "deployment.apps": "deployments", no: "nodes", node: "nodes", nodes: "nodes", svc: "services", service: "services", services: "services", ep: "endpoints", endpoints: "endpoints", endpointslice: "endpointslices", endpointslices: "endpointslices", ev: "events", event: "events", events: "events", pdb: "pdb", poddisruptionbudget: "pdb", poddisruptionbudgets: "pdb", hpa: "hpa", horizontalpodautoscaler: "hpa", cm: "configmaps", configmap: "configmaps", configmaps: "configmaps", secret: "secrets", secrets: "secrets", sts: "statefulsets", statefulset: "statefulsets", statefulsets: "statefulsets", pvc: "pvc", persistentvolumeclaim: "pvc", persistentvolumeclaims: "pvc", rs: "replicasets", replicaset: "replicasets", replicasets: "replicasets", sa: "serviceaccounts", serviceaccount: "serviceaccounts", serviceaccounts: "serviceaccounts", quota: "quota", resourcequota: "quota", resourcequotas: "quota", sc: "storageclasses", storageclass: "storageclasses", storageclasses: "storageclasses", pv: "pv", persistentvolume: "pv", persistentvolumes: "pv", apiservice: "apiservices", apiservices: "apiservices", job: "jobs", jobs: "jobs", ds: "daemonsets", daemonset: "daemonsets", daemonsets: "daemonsets", limits: "limitranges", limitrange: "limitranges", limitranges: "limitranges" };
  const SHORT = { pods: "pod", deployments: "deployment.apps", nodes: "node", services: "service", statefulsets: "statefulset.apps", configmaps: "configmap", secrets: "secret", pdb: "poddisruptionbudget.policy", serviceaccounts: "serviceaccount", pvc: "persistentvolumeclaim", daemonsets: "daemonset.apps" };
  function splitRes(pos) {
    if (!pos.length) return {};
    let [r, n] = pos;
    if (r.includes("/")) { const i = r.indexOf("/"); n = r.slice(i + 1); r = r.slice(0, i); }
    return { r: RES[r] || null, raw: r, n };
  }
  const selMatch = (sel, labels) => Object.entries(sel || {}).every(([k, v]) => (labels || {})[k] === v);
  const parseSel = (s) => { const o = {}; (s || "").split(",").filter(Boolean).forEach((kv) => { const [k, v] = kv.split("="); o[k] = v; }); return o; };
  const podLabels = (p) => ({ ...(p.tpl.metadata.labels || {}), ...(p.own.startsWith("deploy:") ? { "pod-template-hash": p.hash } : {}) });

  /* cfg: { H, admit, logs(pod, st, prev, container), exec(pod, cmd, st), extra:[shell defs], hook(verb, a, st) -> out|undefined,
          files:{path:{text, apply(st) -> out}}, nodeEv(n, st), danger(verb, a, st) -> msg, newAge, oldAge } */
  function kube(cfg) {
    const notFound = (kind, n) => `Error from server (NotFound): ${kind} "${n}" not found`;
    const findPod = (st, n) => st.pods.find((p) => p.name === n && !p.done) || st.pods.find((p) => p.name === n);
    const resolvePod = (st, ref) => {
      if (!ref) return null;
      const m = ref.match(/^(?:deploy|deployment|deployments)\/(.+)$/);
      if (m) return st.pods.find((p) => p.own === "deploy:" + m[1] && isReady(st, p, cfg)) || st.pods.find((p) => p.own === "deploy:" + m[1] && p.node);
      return findPod(st, ref.replace(/^pods?\//, ""));
    };
    const deployRows = (st) => K.cols([["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"], ...Object.keys(st.deploys).sort().map((dn) => { const d = st.deploys[dn], h = tplHash(d.tpl), mine = st.pods.filter((p) => p.own === "deploy:" + dn && live(p)), rd = mine.filter((p) => isReady(st, p, cfg)).length; return [dn, `${rd}/${d.replicas}`, mine.filter((p) => p.hash === h).length, rd, d.age || "41d"]; })]);
    const epOf = (st, sn) => { const s = st.svcs[sn]; const ps = st.pods.filter((p) => live(p) && p.node && selMatch(s.selector, podLabels(p))); return { ready: ps.filter((p) => isReady(st, p, cfg)), notReady: ps.filter((p) => !isReady(st, p, cfg)) }; };
    const tport = (st, sn, p) => { const s = st.svcs[sn]; if (typeof s.targetPort === "number") return s.targetPort; const c = C0(p.tpl).ports || []; const m = c.find((x) => x.name === s.targetPort); return m ? m.containerPort : s.targetPort; };
    const pdbStatus = (st, name) => {
      const b = st.pdbs[name], ps = st.pods.filter((p) => live(p) && selMatch(b.selector, podLabels(p)));
      const healthy = ps.filter((p) => isReady(st, p, cfg)).length, exp = ps.length;
      const min = b.minAvailable != null ? pctOf(b.minAvailable, exp, true) : exp - pctOf(b.maxUnavailable, exp, true);
      return { healthy, exp, min, allowed: Math.max(0, healthy - min) };
    };
    const depMan = (st, dn) => { const d = st.deploys[dn]; return { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: dn, namespace: st.ns, annotations: { "deployment.kubernetes.io/revision": String(d.rev || 1) }, labels: { app: dn } }, spec: { progressDeadlineSeconds: 600, replicas: d.replicas, revisionHistoryLimit: 10, selector: { matchLabels: d.sel || { app: dn } }, strategy: { rollingUpdate: { maxSurge: d.surge, maxUnavailable: d.unav }, type: "RollingUpdate" }, template: d.tpl } }; };
    const setTpl = (st, kind, n, tpl, cause) => {
      const o = kind === "sts" ? st.sts[n] : st.deploys[n];
      if (K.stable(tpl) === K.stable(o.tpl)) return false;
      o.hist = o.hist || [];
      if (!o.hist.length) o.hist.push({ rev: o.rev || 1, tpl: K.clone(o.tpl), cause: o.cause || null });
      const existing = o.hist.findIndex((x) => K.stable(x.tpl) === K.stable(tpl));
      if (existing >= 0) o.hist.splice(existing, 1);
      o.rev = Math.max(...o.hist.map((x) => x.rev), o.rev || 1) + 1;
      o.tpl = K.clone(tpl);
      o.hist.push({ rev: o.rev, tpl: K.clone(tpl), cause: cause || null });
      return true;
    };
    const target = (st, ref, kinds) => {
      const { r, n } = splitRes(ref);
      if (!r || !n) return { err: "error: you must specify a resource type and name, e.g. deployment/" + (Object.keys(st.deploys)[0] || "web") };
      if (r === "deployments" && kinds.includes("deploy")) return st.deploys[n] ? { kind: "deploy", n, o: st.deploys[n] } : { err: notFound("deployments.apps", n) };
      if (r === "statefulsets" && kinds.includes("sts")) return st.sts[n] ? { kind: "sts", n, o: st.sts[n] } : { err: notFound("statefulsets.apps", n) };
      return { err: `error: ${r || ref[0]} is not supported here` };
    };
    const out = (s, danger) => (danger ? { out: s, danger } : s);
    const done = (st, s, danger) => { reconcile(st, cfg); return out(s, danger); };

    const verbs = {
      get(a, st) {
        const { r, n, raw } = splitRes(a.pos);
        const ns = a.g("-n", "--namespace") || st.ns, wide = a.g("-o", "--output") === "wide", fmt = a.g("-o", "--output");
        if (!r) return raw ? `error: the server doesn't have a resource type "${raw}"` : "You must specify the type of resource to get. Use \"kubectl api-resources\" for a complete list of supported resources.";
        if (ns !== st.ns && !a.has("-A", "--all-namespaces") && !["nodes", "storageclasses", "pv", "apiservices"].includes(r) && !(cfg.otherNs && cfg.otherNs[ns])) return `No resources found in ${ns} namespace.`;
        if (cfg.otherNs && ns !== st.ns && cfg.otherNs[ns]) return cfg.otherNs[ns](r, n, a, st) || `No resources found in ${ns} namespace.`;
        if (r === "pods") {
          let list = st.pods.filter((p) => !p.gone);
          if (n) { const p = findPod(st, n); if (!p) return notFound("pods", n); if (fmt === "yaml") return toYaml({ apiVersion: "v1", kind: "Pod", metadata: { name: p.name, namespace: st.ns, labels: podLabels(p) }, spec: { ...p.tpl.spec, nodeName: p.node || undefined }, status: { phase: p.node ? "Running" : "Pending", podIP: p.ip || undefined } }); list = [p]; }
          const sel = a.g("-l", "--selector"); if (sel) list = list.filter((p) => selMatch(parseSel(sel), podLabels(p)));
          if (!list.length) return `No resources found in ${st.ns} namespace.`;
          return podRows(st, cfg, list, wide, a.has("--show-labels"));
        }
        if (r === "nodes") {
          let list = st.nodes; if (n) { list = list.filter((x) => x.name === n); if (!list.length) return notFound("nodes", n); }
          const lc = (a.g("-L", "--label-columns") || "").split(",").filter(Boolean);
          const head = ["NAME", "STATUS", "ROLES", "AGE", "VERSION", ...(wide ? ["INTERNAL-IP", "OS-IMAGE", "CONTAINER-RUNTIME"] : []), ...lc.map((l) => l.split("/").pop().toUpperCase())];
          return K.cols([head, ...list.map((x) => [x.name, (x.ready === "True" ? "Ready" : "NotReady") + (x.cordon ? ",SchedulingDisabled" : ""), "<none>", x.age || "23d", x.kver || "v1.31.4", ...(wide ? [`10.0.${K.hash(x.name) % 200}.${K.hash(x.name + "x") % 250}`, "Amazon Linux 2023.6.20241121", "containerd://1.7.23"] : []), ...lc.map((l) => x.labels[l] || "")])]);
        }
        if (r === "deployments") { if (n && !st.deploys[n]) return notFound("deployments.apps", n); if (n && fmt === "yaml") return toYaml(depMan(st, n)); return deployRows(st); }
        if (r === "statefulsets") { const ks = Object.keys(st.sts); if (!ks.length) return `No resources found in ${st.ns} namespace.`; if (n && fmt === "yaml") return st.sts[n] ? toYaml({ apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: n, namespace: st.ns }, spec: { replicas: st.sts[n].replicas, podManagementPolicy: "OrderedReady", updateStrategy: { type: "RollingUpdate", rollingUpdate: { partition: 0 } }, template: st.sts[n].tpl } }) : notFound("statefulsets.apps", n); return K.cols([["NAME", "READY", "AGE"], ...ks.filter((k) => !n || k === n).map((k) => [k, `${st.pods.filter((p) => p.own === "sts:" + k && isReady(st, p, cfg)).length}/${st.sts[k].replicas}`, st.sts[k].age || "97d"])]); }
        if (r === "replicasets") { const rows = []; Object.keys(st.deploys).sort().forEach((dn) => { const hs = [...new Set([...(st.deploys[dn].hist || []).map((h) => tplHash(h.tpl)), tplHash(st.deploys[dn].tpl)])]; hs.forEach((h) => { const ps = st.pods.filter((p) => p.own === "deploy:" + dn && p.hash === h && live(p)); rows.push([`${dn}-${h}`, ps.length, ps.length, ps.filter((p) => isReady(st, p, cfg)).length, h === tplHash(st.deploys[dn].tpl) ? "9m" : "6d"]); }); }); return K.cols([["NAME", "DESIRED", "CURRENT", "READY", "AGE"], ...rows]); }
        if (r === "services") { const ks = Object.keys(st.svcs).filter((k) => !n || k === n); if (n && !ks.length) return notFound("services", n); if (n && fmt === "yaml") { const s = st.svcs[n]; return toYaml({ apiVersion: "v1", kind: "Service", metadata: { name: n, namespace: st.ns }, spec: { clusterIP: s.ip, ports: [{ name: "http", port: s.port, protocol: "TCP", targetPort: s.targetPort }], selector: s.selector, type: s.type || "ClusterIP" } }); } return K.cols([["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"], ...ks.map((k) => [k, st.svcs[k].type || "ClusterIP", st.svcs[k].ip, "<none>", `${st.svcs[k].port}/TCP`, "212d"])]); }
        if (r === "endpoints") { const ks = Object.keys(st.svcs).filter((k) => !n || k === n); if (n && !ks.length) return notFound("endpoints", n); return K.cols([["NAME", "ENDPOINTS", "AGE"], ...ks.map((k) => { const e = epOf(st, k).ready; return [k, e.length ? e.slice(0, 3).map((p) => `${p.ip}:${tport(st, k, p)}`).join(",") + (e.length > 3 ? ` + ${e.length - 3} more...` : "") : "<none>", "212d"]; })]) + (a.f.__warned ? "" : "\nWarning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice"); }
        if (r === "endpointslices") { const ks = Object.keys(st.svcs); return K.cols([["NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"], ...ks.map((k) => { const e = epOf(st, k), all = [...e.ready, ...e.notReady]; return [`${k}-${hstr(k, 5)}`, "IPv4", all.length ? String(tport(st, k, all[0])) : "<unset>", all.length ? all.slice(0, 3).map((p) => p.ip).join(",") + (all.length > 3 ? ` + ${all.length - 3} more...` : "") : "<unset>", "212d"]; })]); }
        if (r === "pdb") { const ks = Object.keys(st.pdbs); if (!ks.length) return `No resources found in ${st.ns} namespace.`; return K.cols([["NAME", "MIN AVAILABLE", "MAX UNAVAILABLE", "ALLOWED DISRUPTIONS", "AGE"], ...ks.map((k) => { const b = st.pdbs[k], s = pdbStatus(st, k); return [k, b.minAvailable != null ? b.minAvailable : "N/A", b.maxUnavailable != null ? b.maxUnavailable : "N/A", s.allowed, b.age || "88d"]; })]); }
        if (r === "configmaps") { const ks = Object.keys(st.cms); if (n) { const c = st.cms[n]; if (!c) return notFound("configmaps", n); return toYaml({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: n, namespace: st.ns }, data: c.data }); } return K.cols([["NAME", "DATA", "AGE"], ["kube-root-ca.crt", 1, "212d"], ...ks.map((k) => [k, Object.keys(st.cms[k].data).length, st.cms[k].age || "30d"])]); }
        if (r === "secrets") { const ks = Object.keys(st.secrets); if (n && !st.secrets[n]) return notFound("secrets", n); return K.cols([["NAME", "TYPE", "DATA", "AGE"], ...ks.filter((k) => !n || k === n).map((k) => [k, st.secrets[k].type || "Opaque", (st.secrets[k].keys || []).length, st.secrets[k].age || "30d"])]); }
        if (r === "serviceaccounts") { if (n && fmt === "yaml") { const s = st.sas[n]; if (!s) return notFound("serviceaccounts", n); return toYaml({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: n, namespace: st.ns }, ...(s.pullSecrets ? { imagePullSecrets: s.pullSecrets.map((x) => ({ name: x })) } : {}) }); } return K.cols([["NAME", "SECRETS", "AGE"], ...Object.keys(st.sas).map((k) => [k, 0, "3d"])]); }
        if (r === "pvc") { const ks = Object.keys(st.pvcs); if (!ks.length) return `No resources found in ${st.ns} namespace.`; return K.cols([["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "AGE"], ...ks.map((k) => { const v = st.pvcs[k]; return [k, v.bound ? "Bound" : "Pending", v.bound ? "pvc-" + hstr(k, 8) + "-" + hstr(k + "v", 4) : "", v.bound ? v.size : "", v.bound ? "RWO" : "", v.sc, "<unset>", v.age || (v.fresh ? "4m" : "97d")]; })]); }
        if (r === "events") { const ev = (cfg.events ? cfg.events(st) : []).concat(st.ev); if (!ev.length) return `No events found in ${st.ns} namespace.`; return K.cols([["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"], ...ev.map((e) => [e[0], e[1], e[2], e[3], e[4]])]); }
        if (cfg.getRes && cfg.getRes[r]) return cfg.getRes[r](n, a, st);
        return `No resources found in ${st.ns} namespace.`;
      },
      describe(a, st) {
        const { r, n, raw } = splitRes(a.pos);
        if (!r) return raw ? `error: the server doesn't have a resource type "${raw}"` : "error: You must specify the type of resource to describe.";
        if (r === "pods") { const list = n ? [findPod(st, n)].filter(Boolean) : st.pods.filter((p) => !p.gone); if (!list.length) return notFound("pods", n); return list.slice(0, 3).map((p) => describePod(st, cfg, p)).join("\n\n\n"); }
        if (r === "nodes") { const list = n ? st.nodes.filter((x) => x.name === n) : st.nodes; if (!list.length) return notFound("nodes", n); return list.slice(0, 2).map((x) => describeNode(st, cfg, x)).join("\n\n\n"); }
        if (r === "deployments") {
          const dn = n || Object.keys(st.deploys)[0], d = st.deploys[dn]; if (!d) return notFound("deployments.apps", n);
          const mine = st.pods.filter((p) => p.own === "deploy:" + dn && live(p)), h = tplHash(d.tpl), rd = mine.filter((p) => isReady(st, p, cfg)).length, upd = mine.filter((p) => p.hash === h).length;
          const olds = [...new Set(mine.filter((p) => p.hash !== h).map((p) => p.hash))];
          const progressing = upd === d.replicas && !olds.length ? ["Progressing", "True", "NewReplicaSetAvailable"] : ["Progressing", "False", "ProgressDeadlineExceeded"];
          const c = C0(d.tpl);
          return [`Name:                   ${dn}`, `Namespace:              ${st.ns}`, `Replicas:               ${d.replicas} desired | ${upd} updated | ${mine.length} total | ${rd} available | ${mine.length - rd} unavailable`, `StrategyType:           RollingUpdate`, `RollingUpdateStrategy:  ${d.unav} max unavailable, ${d.surge} max surge`, "Pod Template:", `  Labels:  ${Object.entries(d.tpl.metadata.labels).map(([k, v]) => k + "=" + v).join(",")}`, "  Containers:", `   ${c.name}:`, `    Image:      ${c.image}`, ...(c.resources && c.resources.limits ? ["    Limits:", ...Object.entries(c.resources.limits).map(([k, v]) => `      ${k}:  ${v}`)] : []), ...(c.resources && c.resources.requests ? ["    Requests:", ...Object.entries(c.resources.requests).map(([k, v]) => `      ${k}:  ${v}`)] : []), ...envLines(c).map((l) => l.slice(0)),
            "Conditions:", K.cols([["  Type", "Status", "Reason"], ["  ----", "------", "------"], ["  Available", rd >= d.replicas - pctOf(d.unav, d.replicas, false) ? "True" : "False", rd >= d.replicas - pctOf(d.unav, d.replicas, false) ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable"], ...(st.fc["deploy:" + dn] ? [["  ReplicaFailure", "True", "FailedCreate"]] : []), ["  " + progressing[0], progressing[1], progressing[2]]]),
            `OldReplicaSets:  ${olds.length ? olds.map((x) => `${dn}-${x} (${mine.filter((p) => p.hash === x).length}/${mine.filter((p) => p.hash === x).length} replicas created)`).join(", ") : "<none>"}`, `NewReplicaSet:   ${dn}-${h} (${upd}/${upd} replicas created)`, evTable((cfg.depEv && cfg.depEv(dn, st)) || [])].join("\n");
        }
        if (r === "replicasets") { const own = Object.keys(st.deploys).find((dn) => n && n.startsWith(dn + "-")); const fc = own && st.fc["deploy:" + own]; return n && own ? [`Name:           ${n}`, `Namespace:      ${st.ns}`, `Controlled By:  Deployment/${own}`, evTable(fc ? [["Warning", "FailedCreate", "41s (x17 over 8m)", "replicaset-controller", fc]] : [])].join("\n") : notFound("replicasets.apps", n); }
        if (r === "services") { const s = st.svcs[n]; if (!s) return notFound("services", n); const e = epOf(st, n).ready; return [`Name:                     ${n}`, `Namespace:                ${st.ns}`, `Selector:                 ${Object.entries(s.selector).map(([k, v]) => k + "=" + v).join(",")}`, `Type:                     ${s.type || "ClusterIP"}`, `IP:                       ${s.ip}`, `Port:                     http  ${s.port}/TCP`, `TargetPort:               ${s.targetPort}/TCP`, `Endpoints:                ${e.length ? e.map((p) => `${p.ip}:${tport(st, n, p)}`).join(",") : ""}`, "Session Affinity:         None", "Events:                   <none>"].join("\n"); }
        if (r === "pdb") { const b = st.pdbs[n]; if (!b) return notFound("poddisruptionbudgets.policy", n); const s = pdbStatus(st, n); return [`Name:           ${n}`, `Namespace:      ${st.ns}`, b.minAvailable != null ? `Min available:  ${b.minAvailable}` : `Max unavailable:  ${b.maxUnavailable}`, `Selector:       ${Object.entries(b.selector).map(([k, v]) => k + "=" + v).join(",")}`, "Status:", `    Allowed disruptions:  ${s.allowed}`, `    Current:              ${s.healthy}`, `    Desired:              ${s.min}`, `    Total:                ${s.exp}`, ...(b.labels ? [`Labels:         ${b.labels}`] : []), ...(b.ann ? [`Annotations:    ${b.ann}`] : []), "Events:         <none>"].join("\n"); }
        if (r === "pvc") { const v = st.pvcs[n]; if (!v) return notFound("persistentvolumeclaims", n); return [`Name:          ${n}`, `Namespace:     ${st.ns}`, `StorageClass:  ${v.sc}`, `Status:        ${v.bound ? "Bound" : "Pending"}`, `Capacity:      ${v.bound ? v.size : ""}`, `Access Modes:  ${v.bound ? "RWO" : ""}`, `VolumeMode:    Filesystem`, `Used By:       ${st.pods.filter((p) => p.claim === n).map((p) => p.name).join(", ") || "<none>"}`, evTable(v.ev || (v.bound ? [] : [["Warning", "ProvisioningFailed", "12s (x19 over 4m)", "persistentvolume-controller", `storageclass.storage.k8s.io "${v.sc}" not found`]]))].join("\n"); }
        if (cfg.describeRes && cfg.describeRes[r]) return cfg.describeRes[r](n, a, st);
        return `error: describe ${r} is not available in this sandbox`;
      },
      logs(a, st) {
        const p = resolvePod(st, a.pos[0]);
        if (!p) return a.pos[0] ? notFound("pods", a.pos[0]) : "error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.";
        const prev = a.has("-p", "--previous");
        const h = health(st, p, cfg);
        if (!p.node) return `Error from server (BadRequest): container "${C0(p.tpl).name}" in pod "${p.name}" is waiting to start: ContainerCreating`;
        if (/ImagePull|ErrImage/.test(h.s)) return `Error from server (BadRequest): container "${C0(p.tpl).name}" in pod "${p.name}" is waiting to start: trying and failing to pull image`;
        if (h.s === "CreateContainerConfigError") return `Error from server (BadRequest): container "${C0(p.tpl).name}" in pod "${p.name}" is waiting to start: CreateContainerConfigError`;
        if (prev && !h.rc) return `Error from server (BadRequest): previous terminated container "${C0(p.tpl).name}" in pod "${p.name}" not found`;
        const s = cfg.logs ? cfg.logs(p, st, prev, a.g("-c", "--container"), h) : null;
        return s == null ? "" : s;
      },
      top(a, st) {
        const { r } = splitRes(a.pos);
        if (r === "nodes") return K.cols([["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"], ...st.nodes.filter((n) => n.ready === "True").map((n) => { const u = cfg.nodeUse ? cfg.nodeUse(n, st) : { cpu: Math.round(usedOn(st, n).cpu * 0.55), mem: Math.round(usedOn(st, n).mem * 0.7 + 900) }; return [n.name, cpuS(u.cpu), Math.round((u.cpu / n.cpu) * 100) + "%", memS(u.mem), Math.round((u.mem / n.mem) * 100) + "%"]; })]);
        if (r === "pods") { const list = st.pods.filter((p) => live(p) && p.node); return K.cols([["NAME", "CPU(cores)", "MEMORY(bytes)"], ...list.map((p) => { const u = (cfg.use && cfg.use(p, st)) || { cpu: Math.round(reqOf(p.tpl).cpu * 0.4 + 3), mem: Math.round(reqOf(p.tpl).mem * 0.6 + 20) }; return [p.name, cpuS(u.cpu), memS(u.mem)]; })]); }
        return "error: top supports pods and nodes";
      },
      rollout(a, st) {
        const sub = a.pos[0], t = target(st, a.pos.slice(1), ["deploy", "sts"]);
        if (!["status", "history", "undo", "restart", "pause", "resume"].includes(sub)) return `error: unknown command "${sub || ""}" for "kubectl rollout"`;
        if (t.err) return t.err;
        const kindS = t.kind === "sts" ? "statefulset.apps" : "deployment.apps";
        if (sub === "status") {
          const own = (t.kind === "sts" ? "sts:" : "deploy:") + t.n, h = tplHash(t.o.tpl), mine = st.pods.filter((p) => p.own === own && live(p));
          const upd = mine.filter((p) => p.hash === h).length, rd = mine.filter((p) => isReady(st, p, cfg)).length, rdNew = mine.filter((p) => p.hash === h && isReady(st, p, cfg)).length;
          if (upd >= t.o.replicas && mine.length === t.o.replicas && rdNew === t.o.replicas) return t.kind === "sts" ? `partitioned roll out complete: ${t.o.replicas} new pods have been updated...` : `deployment "${t.n}" successfully rolled out`;
          const w = t.kind === "sts" ? `Waiting for ${t.o.replicas - rdNew} pods to be ready...` : upd < t.o.replicas ? `Waiting for deployment "${t.n}" rollout to finish: ${upd} out of ${t.o.replicas} new replicas have been updated...` : mine.length > t.o.replicas ? `Waiting for deployment "${t.n}" rollout to finish: ${mine.length - upd} old replicas are pending termination...` : `Waiting for deployment "${t.n}" rollout to finish: ${rdNew} of ${t.o.replicas} updated replicas are available...`;
          void rd;
          return w + (t.kind === "sts" ? "\n^C" : `\nerror: deployment "${t.n}" exceeded its progress deadline`);
        }
        if (sub === "history") {
          const hist = t.o.hist && t.o.hist.length ? t.o.hist : [{ rev: t.o.rev || 1, tpl: t.o.tpl, cause: t.o.cause }];
          const rv = a.g("--revision");
          if (rv) { const x = hist.find((h) => String(h.rev) === rv); if (!x) return `error: unable to find the specified revision ${rv}`; return `${kindS.split(".")[0]}.apps/${t.n} with revision #${rv}\nPod Template:\n` + toYaml(x.tpl).split("\n").map((l) => "  " + l).join("\n"); }
          return `${kindS}/${t.n} \n` + K.cols([["REVISION", "CHANGE-CAUSE"], ...hist.map((h) => [h.rev, h.cause || "<none>"])]);
        }
        if (sub === "restart") { const tp = K.clone(t.o.tpl); tp.metadata.annotations = { ...(tp.metadata.annotations || {}), "kubectl.kubernetes.io/restartedAt": `2026-10-11T09:${String(14 + st.salt).padStart(2, "0")}:07Z` }; setTpl(st, t.kind, t.n, tp, null); st.x.restarted = (st.x.restarted || []).concat(t.n); return done(st, `${kindS}/${t.n} restarted`, cfg.danger && cfg.danger("restart", t, st)); }
        if (sub === "undo") {
          const hist = (t.o.hist || []).slice().sort((x, y) => x.rev - y.rev);
          if (hist.length < 2) return `error: no rollout history found for ${kindS.split(".")[0]} "${t.n}"`;
          const to = a.g("--to-revision");
          const pick = to ? hist.find((h) => String(h.rev) === to) : hist[hist.length - 2];
          if (!pick) return `error: unable to find specified revision ${to} in history`;
          setTpl(st, t.kind, t.n, pick.tpl, pick.cause);
          st.x.undone = (st.x.undone || []).concat(t.n);
          return done(st, `${kindS}/${t.n} rolled back`, cfg.danger && cfg.danger("undo", t, st));
        }
        return `${kindS}/${t.n} ${sub}d`;
      },
      scale(a, st) {
        const t = target(st, a.pos, ["deploy", "sts"]); if (t.err) return t.err;
        const n = +a.g("--replicas"); if (!Number.isInteger(n) || n < 0) return "error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0";
        const before = t.o.replicas; t.o.replicas = n;
        st.x.scaled = { ...(st.x.scaled || {}), [t.n]: n };
        return done(st, `${t.kind === "sts" ? "statefulset.apps" : "deployment.apps"}/${t.n} scaled`, cfg.danger && cfg.danger("scale", { ...t, before, to: n }, st));
      },
      set(a, st) {
        const what = a.pos[0], t = target(st, a.pos.slice(1), ["deploy", "sts"]);
        if (!["image", "env", "resources", "selector"].includes(what)) return `error: unknown command "${what || ""}" for "kubectl set"`;
        if (what === "selector") {
          const sn = (a.pos[1] === "svc" || a.pos[1] === "service") ? a.pos[2] : (a.pos[1] || "").replace(/^(svc|service|services)\//, "");
          const s = st.svcs[sn]; if (!s) return notFound("services", sn);
          const sel = parseSel(a.pos[a.pos[1] === "svc" || a.pos[1] === "service" ? 3 : 2]); if (!Object.keys(sel).length) return "error: selector is required";
          s.selector = sel; return done(st, `service/${sn} selector updated`);
        }
        if (t.err) return t.err;
        const tp = K.clone(t.o.tpl), cn = a.g("-c", "--containers"), c = cn ? tp.spec.containers.find((x) => x.name === cn) : C0(tp), kindS = t.kind === "sts" ? "statefulset.apps" : "deployment.apps";
        if (!c) return `error: unable to find container named "${cn}"`;
        if (what === "image") {
          const kv = a.pos.slice(2).map((x) => x.split("="));
          if (!kv.length || kv.some((x) => x.length !== 2)) return "error: at least one image update is required";
          for (const [cn, im] of kv) { const cc = tp.spec.containers.find((x) => x.name === cn || cn === "*"); if (!cc) return `error: unable to find container named "${cn}"`; cc.image = im; }
          setTpl(st, t.kind, t.n, tp, `kubectl set image ${kindS.split(".")[0]}/${t.n} ${a.pos.slice(2).join(" ")}`);
          return done(st, `${kindS}/${t.n} image updated`, cfg.danger && cfg.danger("image", t, st));
        }
        if (what === "env") {
          const kv = a.pos.slice(2); if (!kv.length) return "error: at least one environment variable must be provided";
          c.env = c.env || [];
          kv.forEach((x) => { if (x.endsWith("-")) c.env = c.env.filter((e) => e.name !== x.slice(0, -1)); else { const i = x.indexOf("="); const k = x.slice(0, i), v = x.slice(i + 1); const e = c.env.find((y) => y.name === k); if (e) { delete e.valueFrom; e.value = v; } else c.env.push({ name: k, value: v }); } });
          if (!c.env.length) delete c.env;
          if (!setTpl(st, t.kind, t.n, tp, null)) return `${kindS}/${t.n} env unchanged`;
          return done(st, `${kindS}/${t.n} env updated`, cfg.danger && cfg.danger("env", t, st));
        }
        const parseRes = (s) => { const o = {}; (s || "").split(",").filter(Boolean).forEach((kv) => { const [k, v] = kv.split("="); o[k] = v; }); return o; };
        const lim = parseRes(a.g("--limits")), rq = parseRes(a.g("--requests"));
        if (!Object.keys(lim).length && !Object.keys(rq).length) return "error: you must specify an update to requests or limits (in the form of --requests/--limits)";
        for (const [k, v] of Object.entries({ ...lim, ...rq })) { if (!["cpu", "memory", "ephemeral-storage"].includes(k)) return `error: unknown resource "${k}"`; if ((k === "cpu" ? pCpu(v) : pMem(v)) == null) return `error: quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`; }
        c.resources = c.resources || {};
        if (Object.keys(lim).length) c.resources.limits = { ...(c.resources.limits || {}), ...lim };
        if (Object.keys(rq).length) c.resources.requests = { ...(c.resources.requests || {}), ...rq };
        const L = c.resources.limits || {}, Q = c.resources.requests || {};
        for (const k of ["cpu", "memory"]) if (L[k] != null && Q[k] != null && (k === "cpu" ? pCpu(Q[k]) > pCpu(L[k]) : pMem(Q[k]) > pMem(L[k]))) return `The Deployment "${t.n}" is invalid: spec.template.spec.containers[0].resources.requests: Invalid value: "${Q[k]}": must be less than or equal to ${k} limit of ${L[k]}`;
        setTpl(st, t.kind, t.n, tp, null);
        return done(st, `${kindS}/${t.n} resource requirements updated`, cfg.danger && cfg.danger("resources", t, st));
      },
      delete(a, st) {
        const { r, n } = splitRes(a.pos);
        if (!r) return "error: You must provide one or more resources by argument or filename.";
        if (r === "pods") {
          if (a.has("--all")) { const ps = st.pods.filter((p) => live(p)); ps.forEach((p) => (st.pods = st.pods.filter((x) => x !== p))); return done(st, ps.map((p) => `pod "${p.name}" deleted`).join("\n"), (cfg.danger && cfg.danger("delete-all", {}, st)) || "Deleted every pod in the namespace at once: a full outage until replacements start."); }
          const names = a.pos[0].includes("/") ? [n] : a.pos.slice(1);
          const outs = [];
          let dz = null;
          for (const nm of names) {
            const p = findPod(st, nm); if (!p) { outs.push(notFound("pods", nm)); continue; }
            const force = a.has("--force") && a.g("--grace-period") === "0";
            const d = cfg.danger && cfg.danger("delete-pod", { p, force }, st); if (d) dz = d;
            if (cfg.onDeletePod && cfg.onDeletePod(p, st, force, outs)) continue;
            if (p.term && !force) { outs.push(`pod "${nm}" deleted`, "^C  (still Terminating: the pod already had a deletion timestamp and its kubelet never confirms)"); continue; }
            st.pods = st.pods.filter((x) => x !== p);
            if (p.claim && st.pvcs[p.claim] && st.pvcs[p.claim].deleting) delete st.pvcs[p.claim];
            if (force) outs.push("Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.");
            outs.push(`pod "${nm}" ${force ? "force deleted" : "deleted"}`);
          }
          return done(st, outs.join("\n"), dz);
        }
        if (r === "pdb") { if (!st.pdbs[n]) return notFound("poddisruptionbudgets.policy", n); const d = cfg.danger && cfg.danger("delete-pdb", { n }, st); delete st.pdbs[n]; return done(st, `poddisruptionbudget.policy "${n}" deleted`, d); }
        if (r === "nodes") { const nd = st.nodes.find((x) => x.name === n); if (!nd) return notFound("nodes", n); const d = cfg.danger && cfg.danger("delete-node", { n: nd }, st); st.nodes = st.nodes.filter((x) => x !== nd); st.pods.filter((p) => p.node === n).forEach((p) => (st.pods = st.pods.filter((x) => x !== p))); st.x.deletedNode = (st.x.deletedNode || []).concat(n); return done(st, `node "${n}" deleted`, d); }
        if (r === "pvc") { if (!st.pvcs[n]) return notFound("persistentvolumeclaims", n); const d = cfg.danger && cfg.danger("delete-pvc", { n }, st); const used = st.pods.some((p) => p.claim === n && live(p)); if (used) { st.pvcs[n].deleting = true; return out(`persistentvolumeclaim "${n}" deleted\n^C  (the claim stays Terminating while a pod still uses it: kubernetes.io/pvc-protection)`, d); } delete st.pvcs[n]; return done(st, `persistentvolumeclaim "${n}" deleted`, d); }
        if (r === "deployments") { if (!st.deploys[n]) return notFound("deployments.apps", n); delete st.deploys[n]; st.pods = st.pods.filter((p) => p.own !== "deploy:" + n); return done(st, `deployment.apps "${n}" deleted`, (cfg.danger && cfg.danger("delete-deploy", { n }, st)) || "Deleted a whole Deployment."); }
        if (cfg.deleteRes && cfg.deleteRes[r]) return cfg.deleteRes[r](n, a, st);
        return `error: deleting ${r} is not allowed in this sandbox`;
      },
      cordon(a, st, un) { const { n } = splitRes(["node", ...(a.pos[0] && a.pos[0].includes("/") ? [a.pos[0].split("/")[1]] : a.pos)]); const nd = st.nodes.find((x) => x.name === n); if (!nd) return notFound("nodes", n); if (nd.cordon === !un) return `node/${n} already ${un ? "uncordoned" : "cordoned"}`; nd.cordon = !un; return done(st, `node/${n} ${un ? "uncordoned" : "cordoned"}`); },
      uncordon(a, st) { return verbs.cordon(a, st, true); },
      drain(a, st) {
        const n = (a.pos[0] || "").replace(/^nodes?\//, ""), nd = st.nodes.find((x) => x.name === n);
        if (!nd) return notFound("nodes", n || "");
        const outs = [`node/${n} ${nd.cordon ? "already cordoned" : "cordoned"}`];
        nd.cordon = true;
        const ds = (nd.sys || []).filter((s) => s.ds), errs = [];
        if (ds.length && !a.has("--ignore-daemonsets")) errs.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.map((s) => s.ns + "/" + s.name).join(", ")}`);
        const mine = podsOn(st, nd);
        const bare = mine.filter((p) => p.own === "pod" && !p.done);
        if (bare.length && !a.has("--force")) errs.push(`cannot delete Pods declare no controller (use --force to override): ${bare.map((p) => st.ns + "/" + p.name).join(", ")}`);
        const local = mine.filter((p) => p.emptyDir);
        if (local.length && !a.has("--delete-emptydir-data")) errs.push(`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${local.map((p) => st.ns + "/" + p.name).join(", ")}`);
        if (errs.length) { reconcile(st, cfg); return outs.concat([`error: unable to drain node "${n}" due to error: [${errs.join(", ")}], continuing command...`, "There are pending nodes to be drained:", ` ${n}`, ...errs]).join("\n"); }
        if (ds.length) outs.push(`Warning: ignoring DaemonSet-managed Pods: ${ds.map((s) => s.ns + "/" + s.name).join(", ")}`);
        if (bare.length) outs.push(`Warning: deleting Pods that declare no controller: ${bare.map((p) => st.ns + "/" + p.name).join(", ")}`);
        const dz = cfg.danger && cfg.danger("drain", { nd, bare, a }, st);
        const noEvict = a.has("--disable-eviction");
        if (noEvict) st.x.bypassPdb = true;
        let blocked = null;
        for (const p of podsOn(st, nd).sort((x, y) => (x.name < y.name ? -1 : 1))) {
          outs.push(`evicting pod ${st.ns}/${p.name}`);
          const pdbs = Object.keys(st.pdbs).filter((k) => selMatch(st.pdbs[k].selector, podLabels(p)));
          if (!noEvict && pdbs.length > 1) { blocked = { p, msg: "This pod has more than one PodDisruptionBudget, which the eviction subresource does not support." }; break; }
          if (!noEvict && pdbs.length === 1 && isReady(st, p, cfg) && pdbStatus(st, pdbs[0]).allowed < 1) { blocked = { p, msg: "Cannot evict pod as it would violate the pod's disruption budget." }; break; }
          st.pods = st.pods.filter((x) => x !== p);
          reconcile(st, cfg);
          outs.push(`pod/${p.name} evicted`);
        }
        if (blocked) {
          const m = `error when evicting pods/"${blocked.p.name}" -n "${st.ns}" (will retry after 5s): ${blocked.msg}`;
          outs.push(m, `evicting pod ${st.ns}/${blocked.p.name}`, m, `evicting pod ${st.ns}/${blocked.p.name}`, m);
          if (a.g("--timeout")) outs.push(`There are pending pods in node "${n}" when an error occurred: [error when evicting pods/"${blocked.p.name}" -n "${st.ns}": global timeout reached: ${a.g("--timeout")}]`, `error: unable to drain node "${n}" due to error: [error when evicting pods/"${blocked.p.name}" -n "${st.ns}": global timeout reached: ${a.g("--timeout")}], continuing command...`);
          else outs.push("^C");
          return out(outs.join("\n"), dz);
        }
        outs.push(`node/${n} drained`);
        st.x.drained = (st.x.drained || []).concat(n);
        return done(st, outs.join("\n"), dz || (noEvict ? "--disable-eviction deletes pods directly and bypasses every PodDisruptionBudget." : null));
      },
      patch(a, st) {
        const { r, n } = splitRes(a.pos);
        const raw = a.g("-p", "--patch"), type = a.g("--type") || "strategic";
        if (!r || !n) return "error: must specify a resource and name, e.g. kubectl patch deployment web -p '{...}'";
        if (raw == null) return "error: must specify --patch or --patch-file containing the contents of the patch";
        if (r === "deployments" || r === "statefulsets") {
          const kind = r === "deployments" ? "deploy" : "sts", o = kind === "sts" ? st.sts[n] : st.deploys[n];
          if (!o) return notFound(r === "deployments" ? "deployments.apps" : "statefulsets.apps", n);
          const man = kind === "deploy" ? depMan(st, n) : { spec: { replicas: o.replicas, template: o.tpl } };
          const res = applyPatch(man, type, raw); if (res.err) return res.err;
          const nt = res.val.spec && res.val.spec.template;
          if (!nt || !nt.spec || !Array.isArray(nt.spec.containers)) return `The ${kind === "deploy" ? "Deployment" : "StatefulSet"} "${n}" is invalid: spec.template.spec.containers: Required value`;
          if (cfg.validate) { const v = cfg.validate(nt, st, n); if (v) return v; }
          if (res.val.spec.replicas != null) o.replicas = res.val.spec.replicas;
          if (kind === "deploy" && res.val.spec.strategy && res.val.spec.strategy.rollingUpdate) { o.surge = res.val.spec.strategy.rollingUpdate.maxSurge; o.unav = res.val.spec.strategy.rollingUpdate.maxUnavailable; }
          const ch = setTpl(st, kind, n, nt, null);
          st.x.patched = (st.x.patched || []).concat(n);
          return done(st, `${kind === "sts" ? "statefulset.apps" : "deployment.apps"}/${n} ${ch ? "patched" : "patched (no change)"}`, cfg.danger && cfg.danger("patch", { kind, n }, st));
        }
        if (r === "services") {
          const s = st.svcs[n]; if (!s) return notFound("services", n);
          const man = { spec: { selector: s.selector, ports: [{ name: "http", port: s.port, protocol: "TCP", targetPort: s.targetPort }], type: s.type || "ClusterIP" } };
          const res = applyPatch(man, type === "strategic" ? "merge-svc" : type, raw); if (res.err) return res.err;
          const sp = res.val.spec || {};
          s.selector = sp.selector || {}; if (sp.ports && sp.ports[0]) { s.port = sp.ports[0].port; s.targetPort = sp.ports[0].targetPort; }
          return done(st, `service/${n} patched`);
        }
        if (r === "serviceaccounts") {
          const s = st.sas[n]; if (!s) return notFound("serviceaccounts", n);
          const res = applyPatch({ imagePullSecrets: (s.pullSecrets || []).map((x) => ({ name: x })) }, type, raw); if (res.err) return res.err;
          s.pullSecrets = (res.val.imagePullSecrets || []).map((x) => x.name);
          return done(st, `serviceaccount/${n} patched`);
        }
        if (r === "pdb") {
          const b = st.pdbs[n]; if (!b) return notFound("poddisruptionbudgets.policy", n);
          const res = applyPatch({ spec: { minAvailable: b.minAvailable, maxUnavailable: b.maxUnavailable, selector: { matchLabels: b.selector } } }, type === "strategic" ? "merge" : type, raw); if (res.err) return res.err;
          const sp = res.val.spec || {}; b.minAvailable = sp.minAvailable; b.maxUnavailable = sp.maxUnavailable;
          return done(st, `poddisruptionbudget.policy/${n} patched`, cfg.danger && cfg.danger("patch-pdb", { n }, st));
        }
        if (r === "configmaps") {
          const c = st.cms[n]; if (!c) return notFound("configmaps", n);
          const res = applyPatch({ data: c.data }, "merge", raw); if (res.err) return res.err;
          c.data = res.val.data || {}; c.v = (c.v || 0) + 1;
          return done(st, `configmap/${n} patched`);
        }
        return `error: patching ${r} is not supported in this sandbox`;
      },
      label(a, st) { const { r, n } = splitRes(a.pos); const kv = a.pos.slice(a.pos[0] && a.pos[0].includes("/") ? 1 : 2); if (r === "pods") { const p = findPod(st, n); if (!p) return notFound("pods", n); kv.forEach((x) => { const [k, v] = x.split("="); p.tpl.metadata.labels = { ...p.tpl.metadata.labels, [k]: v }; }); st.x.labelledPods = true; reconcile(st, cfg); return out(`pod/${n} labeled`, cfg.danger && cfg.danger("label-pod", { p }, st)); } if (r === "nodes") { const nd = st.nodes.find((x) => x.name === n); if (!nd) return notFound("nodes", n); kv.forEach((x) => { if (x.endsWith("-")) delete nd.labels[x.slice(0, -1)]; else { const [k, v] = x.split("="); nd.labels[k] = v; } }); return done(st, `node/${n} labeled`, cfg.danger && cfg.danger("label-node", { nd }, st)); } return "error: label supports pods and nodes here"; },
      taint(a, st) { const n = (a.pos[1] || "").replace(/^nodes?\//, ""); const nd = st.nodes.find((x) => x.name === n); if (!nd) return notFound("nodes", n); a.pos.slice(2).forEach((x) => { if (x.endsWith("-")) { const k = x.slice(0, -1).split(/[=:]/)[0]; nd.taints = nd.taints.filter((t) => t.key !== k); } else { const m = x.match(/^([^=:]+)(?:=([^:]*))?:(\w+)$/); if (m) nd.taints.push({ key: m[1], value: m[2] || undefined, effect: m[3] }); } }); st.x.tainted = (st.x.tainted || []).concat(n); const d = cfg.danger && cfg.danger("taint", { nd, args: a.pos.slice(2) }, st); if (cfg.onTaint) cfg.onTaint(nd, st); return done(st, `node/${n} ${a.pos.slice(2).some((x) => x.endsWith("-")) ? "untainted" : "tainted"}`, d); },
      apply(a, st) { const f = a.g("-f", "--filename"); if (!f) return "error: must specify one of -f and -k"; const file = (cfg.files || {})[f]; if (!file) return `error: the path "${f}" does not exist`; const r = file.apply(st); reconcile(st, cfg); return r; },
      exec(a, st) { const p = resolvePod(st, a.pos[0]); if (!p) return a.pos[0] ? notFound("pods", a.pos[0]) : "error: expected 'exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]'"; const cmd = (a.f["--"] || a.pos.slice(1)).join(" "); if (!cmd) return "error: you must specify at least one command for the container"; if (!isReady(st, p, cfg) && !p.node) return "error: unable to upgrade connection: container not found"; return cfg.exec ? cfg.exec(p, cmd, st) || "" : `OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd.split(" ")[0]}": executable file not found in $PATH: unknown\ncommand terminated with exit code 126`; },
      wait(a, st) { return cfg.wait ? cfg.wait(a, st) : "error: timed out waiting for the condition"; },
      create(a, st) { return cfg.create ? cfg.create(a, st) : "error: create is not available in this sandbox; use the provided manifests with kubectl apply -f"; },
      edit() { return "error: kubectl edit opens an interactive editor, which this sandbox doesn't have. Use kubectl patch / set / scale instead."; },
      config(a) { return a.pos[0] === "current-context" ? "prod-eu-west-1" : "error: only `kubectl config current-context` is available here"; },
      version() { return "Client Version: v1.31.4\nKustomize Version: v5.4.2\nServer Version: v1.31.4-eks-2d5f260"; },
      "api-resources"() { return "pods, deployments, statefulsets, services, endpoints, endpointslices, nodes, events, pdb, hpa, configmaps, secrets, pvc, replicasets, serviceaccounts, resourcequotas, limitranges, storageclasses"; },
    };
    const defs = [
      ...(cfg.extra || []),
      {
        re: /^kubectl(?: (.*))?$/, use: "kubectl <verb> <resource> [name] [flags]", desc: "the usual kubectl verbs (get, describe, logs, rollout, set, scale, patch, drain, ...)",
        run(m, st, line) {
          const a = parseArgs(tokenize(m[1] || ""));
          const verb = a.pos.shift();
          if (!verb) return "kubectl controls the Kubernetes cluster manager.\n\nType \"help\" for what this sandbox understands.";
          if (cfg.hook) { const h = cfg.hook(verb, a, st, line); if (h !== undefined) return h; }
          const fn = verbs[verb];
          if (!fn) return `error: unknown command "${verb}" for "kubectl"`;
          return fn(a, st);
        },
      },
    ];
    const sh = K.shell(defs);
    return { run: (line, st) => sh.run(line, st), reconcile: (st) => reconcile(st, cfg), isReady: (st, p) => isReady(st, p, cfg), health: (st, p) => health(st, p, cfg), pdbStatus, epOf };
  }
  // Pods of a deployment that are live (not terminating/completed).
  const podsOf = (st, own) => st.pods.filter((p) => p.own === own && live(p));
  const nodeOf = (st, p) => st.nodes.find((n) => n.name === p.node);


  /* ---------- shared scenario helpers ---------- */
  const SCEN = [];
  const REG = "registry.corp.internal";
  const rolledOut = (sh, st, dn) => { const d = st.deploys[dn], h = tplHash(d.tpl), ps = podsOf(st, "deploy:" + dn); return ps.length === d.replicas && ps.every((p) => p.hash === h && sh.isReady(st, p)); };
  const allReady = (sh, st, own, n) => { const ps = podsOf(st, own); return ps.length === n && ps.every((p) => sh.isReady(st, p)); };
  const pickOpts = (R, right, wrongs) => { const opts = R.shuffle([right, ...wrongs]); return { opts, ans: opts.indexOf(right) }; };
  const pickBad = (I, a) => (a.pick !== I.ans ? `The cluster state is fine, but the root cause you picked isn't right: "${esc(I.opts[a.pick] || "")}" doesn't explain the evidence.` : null);
  const otherPick = (I) => (I.ans + 1) % I.opts.length;
  function addNode(st, zone, k, o = {}) {
    const name = `prod-${zone}-${hstr("added" + zone + k + st.salt, 4)}`;
    const n = { name, zone: "eu-west-1" + zone, itype: o.itype || "m6i.xlarge", cpu: o.cpu || 3920, mem: o.mem || 14480, taints: [], labels: {}, cordon: false, ready: "True", arch: "amd64", age: "14s",
      sys: [{ ns: "kube-system", name: "kube-proxy-" + hstr(name + "kp", 5), cpu: 100, mem: 0, ds: true }, { ns: "kube-system", name: "aws-node-" + hstr(name + "an", 5), cpu: 50, mem: 0, ds: true }] };
    n.labels = { "kubernetes.io/arch": "amd64", "kubernetes.io/hostname": name, "node.kubernetes.io/instance-type": n.itype, "topology.kubernetes.io/zone": n.zone, ...(o.labels || {}) };
    st.nodes.push(n);
    return n;
  }
  const nodeCmds = ["kubectl get pods -o wide", "kubectl describe pod <pod>", "kubectl get nodes", "kubectl describe node <node>", "kubectl get events"];
  const appPick = (R) => R.pick(["checkout", "search", "orders", "pricing", "catalog", "payments", "cart", "inventory"]);
  const ver = (R) => `${R.int(1, 4)}.${R.int(10, 40)}.${R.int(0, 9)}`;
  const bump = (v) => { const x = v.split("."); x[2] = String(+x[2] + 1); return x.join("."); };
  const minor = (v) => { const x = v.split("."); x[1] = String(+x[1] + 1); x[2] = "0"; return x.join("."); };

  /* ===== 1. Pending pods ===== */
  function pendingShell(I) {
    const cfg = { newAge: "9m", oldAge: "6d" };
    const st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) });
    const app = I.app;
    const base = { app, image: `${REG}/${I.ns}/${app}:${I.v0}`, cpu: 250, mem: 512, lmem: 512, ready: { path: "/ready", port: 8080, period: 5 }, live: { path: "/healthz", port: 8080 } };
    if (I.lv === 1) {
      const old = mkTpl(base), nw = mkTpl({ ...base, image: `${REG}/${I.ns}/${app}:${I.v1}`, cpu: I.badCpu });
      st.deploys[app] = { replicas: 3, tpl: nw, surge: "25%", unav: "25%", rev: 8, hist: [{ rev: 7, tpl: old, cause: `deploy ${I.v0}` }, { rev: 8, tpl: nw, cause: `deploy ${I.v1}` }] };
      boot(st, cfg, { [app]: old });
    } else if (I.lv === 2) {
      const b = { ...base, cpu: 1000, mem: 2048, lmem: 2048, ready: null, live: null };
      const old = mkTpl({ ...b, sel: { pool: "general" } }), nw = mkTpl({ ...b, sel: { pool: "batch" } });
      st.deploys[app] = { replicas: 2, tpl: nw, surge: "25%", unav: "25%", rev: 3, hist: [{ rev: 2, tpl: old, cause: null }, { rev: 3, tpl: nw, cause: "move to batch pool (PLAT-2291)" }] };
      cfg.danger = (v, t) => (v === "taint" && t.args.some((x) => /^dedicated/.test(x) && x.endsWith("-")) ? "You removed the batch pool's taint: every workload in the cluster can now land on the batch nodes." : null);
      boot(st, cfg, { [app]: old });
    } else {
      st.x.ng = { "prod-1a": { zone: "a", desired: 2 }, "prod-1b": { zone: "b", desired: 1 }, "prod-1c": { zone: "c", desired: 2 } };
      st.pvcs[`data-${app}-0`] = { sc: "gp3", size: "200Gi", bound: true, zone: "eu-west-1b", age: "214d" };
      st.sts[app] = { replicas: 1, claim: "data", sc: "gp3", tpl: mkTpl({ app, image: `${REG}/${I.ns}/${app}:${I.v0}`, cpu: 1000, mem: I.mem, lmem: I.mem, port: 5432, portName: "postgres", ready: { exec: ["pg_isready", "-U", "app"], period: 10 }, mounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }] }) };
      cfg.admit = (p, s) => { if (p.claim && s.pvcs[p.claim] && s.pvcs[p.claim].zone) p.vzone = s.pvcs[p.claim].zone; };
      cfg.getRes = { pv: () => K.cols([["NAME", "CAPACITY", "ACCESS MODES", "RECLAIM POLICY", "STATUS", "CLAIM", "STORAGECLASS", "AGE"], [`pvc-${hstr(app, 8)}-${hstr(app + "v", 4)}`, "200Gi", "RWO", "Retain", "Bound", `${I.ns}/data-${app}-0`, "gp3", "214d"]]) };
      cfg.describeRes = { pv: () => [`Name:              pvc-${hstr(app, 8)}-${hstr(app + "v", 4)}`, "StorageClass:      gp3", "Status:            Bound", `Claim:             ${I.ns}/data-${app}-0`, "Reclaim Policy:    Retain", "Access Modes:      RWO", "Node Affinity:", "  Required Terms:", "    Term 0:        topology.kubernetes.io/zone in [eu-west-1b]", "Source:", "    Type:              CSI (a Container Storage Interface (CSI) volume source)", "    Driver:            ebs.csi.aws.com", `    VolumeHandle:      vol-0${hstr(app, 12)}`].join("\n") };
      cfg.danger = (v, t, s) => (v === "resources" && reqOf(s.sts[app].tpl).mem < I.mem ? `Cutting the database's memory request below its ${memS(I.mem)} working set makes it a prime candidate for eviction and OOM kills.` : null);
      cfg.extra = [
        { re: /^cloudctl nodegroups? list$/, use: "cloudctl nodegroups list", desc: "node groups of this cluster (one per zone)", run: (m, s) => K.cols([["NAME", "ZONE", "INSTANCE TYPE", "MIN", "DESIRED", "MAX"], ...Object.entries(s.x.ng).map(([k, g]) => [k, "eu-west-1" + g.zone, "m6i.xlarge", 1, g.desired, 6])]) },
        { re: /^cloudctl nodegroups? scale (\S+) --desired(?:=| )(\d+)$/, use: "cloudctl nodegroup scale <name> --desired <n>", desc: "set a node group's desired size", run(m, s) {
          const g = s.x.ng[m[1]]; if (!g) return `error: node group "${m[1]}" not found`;
          const n = +m[2]; if (n > 6) return "error: desired size exceeds max (6)"; if (n < g.desired) return "error: scale-in is done by the cluster's drain workflow, not here";
          const before = g.desired;
          for (let k = before; k < n; k++) addNode(s, g.zone, k);
          s.x.scaledZones = (s.x.scaledZones || []).concat(g.zone);
          g.desired = n; reconcile(s, cfg);
          return `nodegroup ${m[1]}: desired size ${before} -> ${n}\n${n - before} instance(s) launched in eu-west-1${g.zone} and registered with the cluster`;
        } },
      ];
      boot(st, cfg, {});
    }
    const sh = kube(cfg);
    return { sh, cfg, st };
  }
  SCEN.push({
    id: "k8s-pending-pods", name: "Unstick the Pending pods", kind: "Incident", skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => { const { sh, st } = pendingShell(I); return { prompt: "$", init: st, run: sh.run, par: I.lv === 3 ? 7 : 6, opts: I.opts, optq: "Why are the pods Pending?",
        motd: I.lv === 3 ? `ALERT ${I.app}-0 Pending for 14m · ${I.app} replica lag alerts firing\nNode ${I.lostNode} (eu-west-1b) was replaced by the node-refresh job 20m ago.` : `ALERT deploy ${I.app} ${I.lv === 1 ? I.v1 : "(batch pool move)"} not progressing for 9m`,
        cmds: I.lv === 3 ? [...nodeCmds, "kubectl get pvc", "kubectl describe pv <pv>", "cloudctl nodegroups list", "cloudctl nodegroup scale <name> --desired <n>"] : I.lv === 2 ? [...nodeCmds, "kubectl get nodes -L pool", "kubectl patch deployment <name> -p '<json>'"] : [...nodeCmds, "kubectl rollout history deployment/<name>", "kubectl set resources deployment/<name> --requests=cpu=<q>"] }; },
      goal(st, I, a) {
        const { sh } = pendingShell(I);
        if (I.lv === 1) { if (!rolledOut(sh, st, I.app)) return `The ${esc(I.app)} rollout still isn't complete: new pods are Pending or not Ready.`; }
        if (I.lv === 2) {
          if (!rolledOut(sh, st, I.app)) return `The ${esc(I.app)} rollout still isn't complete.`;
          if (!podsOf(st, "deploy:" + I.app).every((p) => (st.nodes.find((n) => n.name === p.node) || { labels: {} }).labels.pool === "batch")) return "The pods are running, but not on the batch pool: moving them there was the whole point of the change.";
          if (st.nodes.filter((n) => n.labels.pool === "batch").some((n) => !n.taints.some((t) => t.key === "dedicated"))) return "The pods run, but the batch nodes lost their <code>dedicated=batch</code> taint, so anything can now be scheduled there. Fix the pod, not the pool.";
        }
        if (I.lv === 3) {
          if (reqOf(st.sts[I.app].tpl).mem < I.mem) return "The pod fits now, but only because you shrank the database's memory request below its working set.";
          if (!allReady(sh, st, "sts:" + I.app, 1)) return `${esc(I.app)}-0 is still Pending.`;
        }
        return pickBad(I, a) || true;
      },
      solve: (I) => I.lv === 1 ? { log: [`kubectl describe pod ${I.newPod}`, "kubectl get nodes", `kubectl set resources deployment/${I.app} --requests=cpu=250m`, `kubectl rollout status deployment/${I.app}`], pick: I.ans }
        : I.lv === 2 ? { log: [`kubectl describe pod ${I.newPod}`, "kubectl get nodes -L pool", `kubectl patch deployment ${I.app} -p '{"spec":{"template":{"spec":{"tolerations":[{"key":"dedicated","operator":"Equal","value":"batch","effect":"NoSchedule"}]}}}}'`, `kubectl rollout status deployment/${I.app}`], pick: I.ans }
          : { log: [`kubectl describe pod ${I.app}-0`, "kubectl get pv", "cloudctl nodegroups list", "cloudctl nodegroup scale prod-1b --desired 2", "kubectl get pods -o wide"], pick: I.ans },
    }),
    gen(lv, R) {
      const app = lv === 2 ? R.pick(["reports", "exports", "invoicing", "ledger-sync"]) + "-worker" : lv === 3 ? R.pick(["ledger-db", "billing-db", "orders-db"]) : appPick(R);
      const v0 = ver(R), I = { lv, app, ns: R.pick(["shop", "store", "commerce"]), v0, v1: bump(v0) };
      if (lv === 1) {
        I.nodes = mkNodes(R, [{ zone: "a", n: 2, cpu: 1930, mem: 6900, itype: "m6i.large" }, { zone: "b", n: 2, cpu: 1930, mem: 6900, itype: "m6i.large" }]);
        I.badCpu = R.pick([2500, 2000, 2250]);
        const o = pickOpts(R, "The CPU request is larger than any node's allocatable CPU", ["The nodes carry a taint the pod doesn't tolerate", "The nodeSelector matches no node", "The namespace's ResourceQuota is exhausted", "The image can't be pulled"]); Object.assign(I, o);
      } else if (lv === 2) {
        I.nodes = mkNodes(R, [{ zone: "a", n: 2, labels: { pool: "general" } }, { zone: "b", n: 1, labels: { pool: "general" } }, { zone: "a", n: 1, pool: "batch", itype: "c6i.2xlarge", cpu: 7910, mem: 14000, labels: { pool: "batch" }, taints: [{ key: "dedicated", value: "batch", effect: "NoSchedule" }] }, { zone: "b", n: 1, pool: "batch", itype: "c6i.2xlarge", cpu: 7910, mem: 14000, labels: { pool: "batch" }, taints: [{ key: "dedicated", value: "batch", effect: "NoSchedule" }] }]);
        const o = pickOpts(R, "The batch nodes are tainted and the pod has no matching toleration", ["The CPU request is larger than any node", "The general pool is out of memory", "The batch pool's nodeSelector label is misspelled", "The image can't be pulled on the batch nodes"]); Object.assign(I, o);
      } else {
        I.mem = R.pick([6144, 7168, 8192]);
        I.lostNode = `prod-b-${hstr("lost" + R.int(0, 1e6), 4)}`;
        I.nodes = mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 1, sys: [{ ns: "search", name: "opensearch-data-1", cpu: 1500, mem: 11264 }] }, { zone: "c", n: 2 }]);
        const o = pickOpts(R, "Its volume lives in eu-west-1b and the only node there has no memory left", ["The memory request is larger than any node can offer", "Most nodes carry a taint the pod doesn't tolerate", "The StorageClass is missing, so the PVC can't bind", "Pod anti-affinity rules exclude every node"]); Object.assign(I, o);
      }
      const { st } = pendingShell(I);
      const pend = st.pods.find((p) => !p.node);
      if (!pend) return null;
      I.newPod = pend.name;
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: [`kubectl set resources deployment/${I.app} --requests=cpu=250m`], pick: otherPick(I) }, { log: [`kubectl scale deployment/${I.app} --replicas=6`], pick: I.ans }]
      : I.lv === 2 ? [{ log: [`kubectl taint nodes ${I.nodes[3].name} dedicated-`, `kubectl taint nodes ${I.nodes[4].name} dedicated-`], pick: I.ans }, { log: [`kubectl patch deployment ${I.app} --type=json -p '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'`], pick: I.ans }]
        : [{ log: [`kubectl set resources statefulset/${I.app} --requests=memory=2Gi --limits=memory=2Gi`], pick: I.ans }, { log: ["cloudctl nodegroup scale prod-1a --desired 3"], pick: I.ans }, { log: ["cloudctl nodegroup scale prod-1b --desired 2"], pick: otherPick(I) }],
    text: (I) => I.lv === 1 ? `<p>The <b>${esc(I.app)}</b> ${esc(I.v1)} rollout has been stuck for 9 minutes: one new pod is <code>Pending</code> and the old ones are still serving. The release only meant to bump the version and "tidy up" the resource block.</p><p>Find out why the scheduler won't place the pod, fix the Deployment, and pick the root cause.</p>`
      : I.lv === 2 ? `<p>Ticket PLAT-2291 moved <b>${esc(I.app)}</b> to the dedicated batch node pool by changing its <code>nodeSelector</code> to <code>pool: batch</code>. The new pod has been <code>Pending</code> ever since. The batch pool is reserved for batch work and must stay that way.</p><p>Get the worker running on the batch pool and pick the root cause.</p>`
        : `<p><b>${esc(I.app)}-0</b>, a single-replica Postgres StatefulSet with a 200 GiB EBS volume, has been <code>Pending</code> for 14 minutes after its node was replaced by the node-refresh job. Someone on the channel says "the scheduler says Insufficient memory, just lower the request". This cluster has no cluster autoscaler; node groups (one per zone) are scaled by hand.</p><p>Get the database back without starving it, and pick the root cause.</p>`,
    hint: (I) => I.lv === 1 ? "The FailedScheduling event lists why each node was rejected. Compare the request with a node's Allocatable." : I.lv === 2 ? "A nodeSelector says where a pod wants to go; a taint says who may come in. The pod needs both." : "Read every reason in the FailedScheduling message, not just the first one. Where does the volume live?",
    concept: "Reading FailedScheduling events",
    how: "The scheduler runs filter plugins on every node (unschedulable, taints, node affinity/selector, resource fit, volume topology, spread, inter-pod affinity) and stops at the first one a node fails. The FailedScheduling event aggregates one reason per rejected node, e.g. <code>0/5 nodes are available: 2 node(s) had untolerated taint, 3 node(s) didn't match Pod's node affinity/selector</code>, then says whether preemption could help. Resource fit compares <i>requests</i> with a node's allocatable capacity minus what's already requested, not with live usage. A zonal EBS volume adds a node affinity, so a pod can only run in that volume's zone.",
    rule: "Read the whole FailedScheduling line and add up the node counts per reason: the reason covering the nodes you actually want is the one to fix. Fix the pod spec (tolerations, requests), not the shared nodes.",
    why: (I) => I.lv === 1 ? `The new template requested <b>${cpuS(I.badCpu)}</b> of CPU (it meant 250m), while each m6i.large offers only 1930m allocatable, so every node reported <i>Insufficient cpu</i> and preemption couldn't help. Restoring a sane request let the rollout finish.`
      : I.lv === 2 ? `The two batch nodes rejected the pod for an untolerated <code>dedicated=batch:NoSchedule</code> taint, and the three general nodes rejected it because of the new nodeSelector. A toleration lets it onto the batch nodes; the nodeSelector keeps it there. Removing the taint would have opened the pool to everyone.`
        : `The PV has node affinity <code>topology.kubernetes.io/zone in [eu-west-1b]</code>, so four nodes failed with <i>volume node affinity conflict</i>; only the single zone-b node passed that filter, and it was full of OpenSearch. Lowering the request would starve the database; adding a node in eu-west-1b is the real fix.`,
  });


  /* ===== 2. CrashLoopBackOff ===== */
  const uid = (p) => `${hstr(p.name + "u", 8)}-${hstr(p.name + "v", 4)}-${hstr(p.name + "w", 4)}`;
  const freshRc = (p, rc) => (p.age === "6s" ? { rc: 1, ago: "3s" } : { rc, ago: "48s" });
  const backoff = (p, st) => ["Warning", "BackOff", `${p.age === "6s" ? "2s (x2 over 5s)" : "2m31s (x41 over 11m)"}`, "kubelet", `Back-off restarting failed container ${C0(p.tpl).name} in pod ${p.name}_${st.ns}(${uid(p)})`];
  function crashShell(I) {
    const cfg = { newAge: "11m", oldAge: "6d" }, app = I.app;
    const st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) });
    const base = { app, image: `${REG}/${I.ns}/${app}:${I.v0}`, cpu: 300, mem: 512, lmem: 512, ready: { path: "/ready", port: 8080, period: 5 }, live: { path: "/healthz", port: 8080, delay: 10 } };
    if (I.lv === 1) {
      const env = [{ n: "PORT", v: "8080" }, { n: I.envOld, v: I.url }, { n: "DATABASE_URL", sec: `${app}-db`, key: "url" }];
      const old = mkTpl({ ...base, env }), nw = mkTpl({ ...base, env, image: `${REG}/${I.ns}/${app}:${I.v1}` });
      st.deploys[app] = { replicas: 4, tpl: nw, surge: "25%", unav: "25%", rev: 12, hist: [{ rev: 11, tpl: old, cause: `deploy ${I.v0}` }, { rev: 12, tpl: nw, cause: `deploy ${I.v1}` }] };
      cfg.H = (p) => (tag(p.tpl) === I.v1 && !((envOf(p.tpl, I.envNew) || {}).value) ? { s: "CrashLoopBackOff", ready: false, ...freshRc(p, 7), last: { reason: "Error", code: 1 }, ev: [backoff(p, st)] } : null);
      cfg.logs = (p) => tag(p.tpl) === I.v1 && !((envOf(p.tpl, I.envNew) || {}).value) ? `{"level":"info","ts":"2026-10-11T09:14:02Z","msg":"starting ${app}","version":"${I.v1}"}\n{"level":"fatal","ts":"2026-10-11T09:14:02Z","msg":"invalid configuration","error":"required key ${I.envNew} missing value"}` : `{"level":"info","ts":"2026-10-11T09:14:02Z","msg":"starting ${app}","version":"${tag(p.tpl)}"}\n{"level":"info","ts":"2026-10-11T09:14:03Z","msg":"listening","addr":":8080"}`;
      boot(st, cfg, { [app]: old });
    } else if (I.lv === 2) {
      const tpl = mkTpl(base), old = mkTpl({ ...base, image: `${REG}/${I.ns}/${app}:${I.vPrev}` });
      st.deploys[app] = { replicas: 3, tpl, surge: "25%", unav: "25%", rev: 6, hist: [{ rev: 5, tpl: old, cause: `deploy ${I.vPrev}` }, { rev: 6, tpl, cause: `deploy ${I.v0}` }] };
      const oom = (p) => (limOf(p.tpl).mem || 1e9) < I.peak;
      cfg.H = (p) => { if (!oom(p)) return null; const up = K.hash(p.name) % 2 === 0; return { s: up ? "Running" : "CrashLoopBackOff", ready: false, ...freshRc(p, 9), last: { reason: "OOMKilled", code: 137 }, ev: [["Warning", "Unhealthy", "3m (x14 over 52m)", "kubelet", "Readiness probe failed: HTTP probe failed with statuscode: 503"], backoff(p, st)] }; };
      cfg.use = (p) => ({ cpu: 410, mem: oom(p) ? Math.min(limOf(p.tpl).mem - 6, I.peak) - (K.hash(p.name) % 60) : I.peak - 40 });
      const head = `2026-10-11 09:14:01 INFO  ${app} ${I.v0} starting (JVM 21, -XX:MaxRAMPercentage=75)\n2026-10-11 09:14:04 INFO  loading catalog snapshot: ${I.skus}M SKUs\n2026-10-11 09:14:19 INFO  warming price cache`;
      cfg.logs = (p, s, prev) => oom(p) ? (prev ? head + "\n2026-10-11 09:14:41 INFO  warming price cache: 61%\n2026-10-11 09:14:52 INFO  warming price cache: 78%" : head) : head + "\n2026-10-11 09:15:09 INFO  price cache warm (100%)\n2026-10-11 09:15:09 INFO  ready";
      boot(st, cfg, { [app]: tpl });
    } else {
      const tpl = mkTpl({ ...base, env: [{ n: "PG_HOST", v: "postgres" }, { n: "PG_PASSWORD", sec: "postgres-app", key: "password" }] }), old = mkTpl({ ...base, env: [{ n: "PG_HOST", v: "postgres" }, { n: "PG_PASSWORD", sec: "postgres-app", key: "password" }], image: `${REG}/${I.ns}/${app}:${I.vPrev}` });
      st.deploys[app] = { replicas: 3, tpl, surge: "25%", unav: "25%", rev: 9, hist: [{ rev: 8, tpl: old, cause: `deploy ${I.vPrev}` }, { rev: 9, tpl, cause: `deploy ${I.v0}` }] };
      st.sts.postgres = { replicas: 0, claim: "data", sc: "gp3", tpl: mkTpl({ app: "postgres", image: "docker.io/library/postgres:16.4", cpu: 1000, mem: 4096, lmem: 4096, port: 5432, portName: "postgres", ready: { exec: ["pg_isready", "-U", "app"] } }) };
      st.pvcs["data-postgres-0"] = { sc: "gp3", size: "100Gi", bound: true, age: "301d" };
      st.svcs.postgres = { selector: { app: "postgres" }, port: 5432, targetPort: 5432, ip: "172.20.88.12" };
      st.svcs[app] = { selector: { app }, port: 80, targetPort: "http", ip: "172.20.14.200" };
      const dbUp = (s) => s.pods.some((p) => p.own === "sts:postgres" && p.node && !p.term);
      cfg.H = (p, s) => (p.own === "deploy:" + app && !dbUp(s) ? { s: "CrashLoopBackOff", ready: false, ...freshRc(p, 11), last: { reason: "Error", code: 2 }, ev: [backoff(p, s)] } : null);
      cfg.logs = (p, s) => p.own !== "deploy:" + app ? "LOG:  database system is ready to accept connections" : dbUp(s) ? `time=2026-10-11T09:31:02Z level=INFO msg="connected to postgres" host=postgres\ntime=2026-10-11T09:31:02Z level=INFO msg="listening" addr=:8080` : `time=2026-10-11T09:14:02Z level=INFO msg="starting ${app}" version=${tag(p.tpl)}\npanic: failed to connect to \`user=app database=${app}\`: 172.20.88.12:5432 (postgres): dial error: dial tcp 172.20.88.12:5432: connect: connection refused\n\ngoroutine 1 [running]:\nmain.main()\n\t/src/cmd/${app}/main.go:58 +0x3c5`;
      cfg.events = (s) => [["48s", "Warning", "BackOff", `pod/${podsOf(s, "deploy:" + app)[0].name}`, "Back-off restarting failed container"], ["23m", "Normal", "SuccessfulDelete", "statefulset/postgres", "delete Pod postgres-0 in StatefulSet postgres successful"], ["23m", "Normal", "Killing", "pod/postgres-0", "Stopping container postgres"], ["26m", "Normal", "ScalingReplicaSet", `deployment/${app}`, `Scaled down replica set ${app}-${tplHash(old)} to 0 from 1`]];
      cfg.danger = (v) => (v === "undo" ? "You rolled back a release that wasn't the cause: the crash comes from the database being gone." : null);
      boot(st, cfg, { [app]: tpl });
    }
    return { sh: kube(cfg), st };
  }
  SCEN.push({
    id: "k8s-crashloop", name: "Fix the CrashLoopBackOff", kind: "Incident", skills: ["diagnose"],
    ...LB.term({
      shell: (I) => { const { sh, st } = crashShell(I); return { prompt: "$", init: st, run: sh.run, par: 6,
        motd: I.lv === 1 ? `ALERT ${I.app}: 2/4 pods not ready after deploy ${I.v1}` : I.lv === 2 ? `ALERT ${I.app}: pod restarts > 8 in 1h · p99 latency 2.4s` : `ALERT ${I.app}: 0/3 pods ready · 5xx 100% at the edge`,
        cmds: ["kubectl get pods", "kubectl describe pod <pod>", "kubectl logs <pod>", "kubectl logs <pod> --previous", "kubectl get events", "kubectl top pods", "kubectl rollout history deployment/<name>", ...(I.lv === 3 ? ["kubectl get statefulsets", "kubectl scale statefulset/<name> --replicas=<n>"] : I.lv === 2 ? ["kubectl set resources deployment/<name> --limits=memory=<q>"] : ["kubectl set env deployment/<name> KEY=value", "kubectl rollout undo deployment/<name>"])] }; },
      goal(st, I) {
        const { sh } = crashShell(I);
        if (!rolledOut(sh, st, I.app)) return `${esc(I.app)} still has pods that aren't Ready.`;
        if (I.lv === 2) { const t = st.deploys[I.app].tpl; const r = reqOf(t).mem; if (r > (limOf(t).mem || 1e9)) return "Requests can't exceed limits."; }
        if (I.lv === 3 && !(st.sts.postgres.replicas >= 1)) return "The app pods look fine but postgres is still scaled to zero.";
        return true;
      },
      solve: (I) => I.lv === 1 ? { log: ["kubectl get pods", `kubectl logs ${I.crashPod}`, `kubectl set env deployment/${I.app} ${I.envNew}=${I.url}`, `kubectl rollout status deployment/${I.app}`] }
        : I.lv === 2 ? { log: ["kubectl get pods", `kubectl describe pod ${I.crashPod}`, `kubectl set resources deployment/${I.app} --requests=memory=${memS(I.fix)} --limits=memory=${memS(I.fix)}`, `kubectl rollout status deployment/${I.app}`] }
          : { log: ["kubectl get pods", `kubectl logs ${I.crashPod} --previous`, "kubectl get statefulsets", "kubectl scale statefulset/postgres --replicas=1", "kubectl get pods"] },
    }),
    gen(lv, R) {
      const app = appPick(R), v0 = ver(R);
      const I = { lv, app, ns: R.pick(["shop", "store", "commerce"]), v0, v1: minor(v0), vPrev: v0.replace(/\.\d+$/, (x) => "." + Math.max(0, +x.slice(1) - 1)), nodes: mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 2 }]) };
      if (I.vPrev === I.v0) I.vPrev = bump(I.v0).replace(/\d+$/, "0") === I.v0 ? I.v0 + "-rc1" : bump(I.v0);
      if (lv === 1) { const pair = R.pick([["PAYMENTS_URL", "PAYMENTS_API_URL", "http://payments.payments.svc.cluster.local:8080"], ["REDIS_ADDR", "CACHE_REDIS_ADDR", "redis-master.cache.svc.cluster.local:6379"], ["SEARCH_HOST", "SEARCH_API_URL", "http://search.search.svc.cluster.local"]]); [I.envOld, I.envNew, I.url] = pair; }
      if (lv === 2) { I.peak = R.pick([700, 760, 820, 880]); I.fix = I.peak <= 768 ? 1024 : 1280; I.skus = (R.int(16, 24) / 10).toFixed(1); }
      const { st, sh } = crashShell(I);
      const bad = st.pods.find((p) => p.own === "deploy:" + app && !sh.isReady(st, p) && p.node && (lv !== 2 || sh.health(st, p).s === "CrashLoopBackOff"));
      if (!bad) return null;
      I.crashPod = bad.name;
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: [`kubectl rollout restart deployment/${I.app}`] }, { log: [`kubectl delete pod ${I.crashPod}`] }]
      : I.lv === 2 ? [{ log: [`kubectl rollout undo deployment/${I.app}`] }, { log: [`kubectl set resources deployment/${I.app} --limits=cpu=2`] }, { log: [`kubectl set resources deployment/${I.app} --limits=memory=${memS(I.peak - 64)}`] }]
        : [{ log: [`kubectl rollout undo deployment/${I.app}`] }, { log: [`kubectl rollout restart deployment/${I.app}`] }],
    text: (I) => I.lv === 1 ? `<p>Ten minutes ago CI deployed <b>${esc(I.app)} ${esc(I.v1)}</b>. Half the pods are in <code>CrashLoopBackOff</code>; the old ReplicaSet is still serving, so customers see slow pages but no outage yet. The release notes say only "config cleanup".</p><p>Find out why the new pods crash and get the rollout to complete with the new version.</p>`
      : I.lv === 2 ? `<p><b>${esc(I.app)}</b> hasn't been deployed for six days, yet since this morning's catalog import its pods restart every few minutes and latency is spiking. <code>kubectl logs</code> on a restarting pod shows a perfectly normal startup.</p><p>Find the cause and make the pods stable.</p>`
        : `<p>Every <b>${esc(I.app)}</b> pod is in <code>CrashLoopBackOff</code> and the site is returning 5xx. A deploy of ${esc(I.v0)} went out 26 minutes ago and someone is already typing <code>kubectl rollout undo</code> in the incident channel.</p><p>Find what actually broke and restore service.</p>`,
    hint: (I) => I.lv === 1 ? "The container's own last words are in its logs. Compare the environment the new version expects with what the Deployment gives it." : I.lv === 2 ? "A restarted container's logs start fresh. What did the previous container die of? Look at Last State in describe, or logs --previous." : "Read the panic, not the timeline. What is at 172.20.88.12?",
    concept: "Debugging CrashLoopBackOff",
    how: "CrashLoopBackOff is not an error in itself: it means the container keeps exiting and the kubelet is waiting (10s, 20s, 40s... up to 5 minutes) before restarting it. The cause is in the previous container: its logs (<code>kubectl logs --previous</code>) and its Last State in <code>kubectl describe pod</code> (Reason and Exit Code). Exit code 137 is SIGKILL; with Reason OOMKilled the container crossed its memory limit and the kernel killed it, often after normal-looking startup logs. A crashing dependency shows up as connection errors in every pod, regardless of version.",
    rule: "Before rolling back, read the previous container's logs and Last State. Roll back only when the evidence points at the release.",
    why: (I) => I.lv === 1 ? `${esc(I.v1)} renamed its config key from <code>${esc(I.envOld)}</code> to <code>${esc(I.envNew)}</code>, and the fatal log line said exactly that. Setting the new variable (or rolling back) completes the rollout; the old ReplicaSet kept serving meanwhile because maxUnavailable only allowed one old pod down.`
      : I.lv === 2 ? `The catalog import pushed the JVM's working set to about ${I.peak} MiB, above the 512Mi limit. The kernel OOM-killed the container (Last State: OOMKilled, exit code 137) while it warmed its cache, so the current logs always looked like a clean start. Rolling back wouldn't help: the data grew, not the code. A ${memS(I.fix)} limit (with the request equal to it for memory) gives headroom.`
        : `Postgres had been scaled to zero 23 minutes ago (SuccessfulDelete on statefulset/postgres), so every app pod panicked with <i>connection refused</i> on startup. The deploy 26 minutes earlier was a coincidence; rolling it back would have changed nothing. Scaling the StatefulSet back up let the app pods connect on their next restart.`,
  });

  /* ===== 3. ImagePullBackOff ===== */
  const pullEv = (image, why, p) => [["Normal", "Pulling", "2m52s (x5 over 9m)", "kubelet", `Pulling image "${image}"`], ["Warning", "Failed", "2m51s (x5 over 9m)", "kubelet", `Failed to pull image "${image}": ${why}`], ["Warning", "Failed", "2m51s (x5 over 9m)", "kubelet", "Error: ErrImagePull"], ["Normal", "BackOff", `${p.age === "6s" ? "3s" : "14s"} (x41 over 9m)`, "kubelet", `Back-off pulling image "${image}"`], ["Warning", "Failed", "14s (x41 over 9m)", "kubelet", "Error: ImagePullBackOff"]];
  function pullShell(I) {
    const cfg = { newAge: "9m", oldAge: "13d" }, app = I.app, repo = `${REG}/${I.ns}/${app}`;
    const st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) });
    const base = { app, image: `${repo}:${I.good}`, cpu: I.lv === 3 ? 1500 : 250, mem: 512, lmem: 512, ready: { path: "/ready", port: 8080, period: 5 } };
    const crane = (tags, man) => [
      { re: /^crane ls (\S+)$/, use: "crane ls <repository>", desc: "list tags in the registry", run: (m) => (m[1].replace(/:.*$/, "") === repo ? tags.join("\n") : `Error: reading tags for ${m[1]}: GET https://${m[1].split("/")[0]}/v2/${m[1].split("/").slice(1).join("/")}/tags/list: NAME_UNKNOWN: repository name not known to registry`) },
      { re: /^crane (manifest|config) (\S+)$/, use: "crane manifest <image> / crane config <image>", desc: "show an image's manifest or config", run: (m) => (man ? man(m[1], m[2]) : `Error: fetching manifest ${m[2]}: GET https://${REG}/v2/: UNAUTHORIZED`) },
    ];
    if (I.lv === 1) {
      const old = mkTpl(base), nw = mkTpl({ ...base, image: `${repo}:${I.typo}` });
      st.deploys[app] = { replicas: 4, tpl: nw, surge: "25%", unav: "25%", rev: 21, hist: [{ rev: 20, tpl: old, cause: `deploy ${I.prev}` }, { rev: 21, tpl: nw, cause: `deploy ${I.typo}` }] };
      cfg.H = (p) => (!I.tags.includes(tag(p.tpl)) ? { s: p.age === "6s" ? "ErrImagePull" : "ImagePullBackOff", ready: false, ev: pullEv(img(p.tpl), `rpc error: code = NotFound desc = failed to pull and unpack image "${img(p.tpl)}": failed to resolve reference "${img(p.tpl)}": ${img(p.tpl)}: not found`, p) } : null);
      cfg.extra = crane(I.tags, (k, ref) => (I.tags.includes(ref.split(":").pop()) ? `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:${hstr(ref, 20)}","platform":{"architecture":"amd64","os":"linux"}},{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:${hstr(ref + "a", 20)}","platform":{"architecture":"arm64","os":"linux"}}]}` : `Error: fetching manifest ${ref}: GET https://${REG}/v2/${I.ns}/${app}/manifests/${ref.split(":").pop()}: MANIFEST_UNKNOWN: manifest unknown`));
      boot(st, cfg, { [app]: old });
    } else if (I.lv === 2) {
      const tpl = mkTpl(base);
      st.deploys[app] = { replicas: 3, tpl, surge: "25%", unav: "25%", rev: 1, hist: [] };
      st.secrets = { regcred: { type: "kubernetes.io/dockerconfigjson", keys: [".dockerconfigjson"], age: "2d" }, [`${app}-db`]: { keys: ["url"], age: "2d" } };
      cfg.admit = (p, s) => { p.pull = [...(p.tpl.spec.imagePullSecrets || []).map((x) => x.name), ...((s.sas.default || {}).pullSecrets || [])]; };
      cfg.H = (p) => (!(p.pull || []).includes("regcred") ? { s: p.age === "6s" ? "ErrImagePull" : "ImagePullBackOff", ready: false, ev: pullEv(img(p.tpl), `failed to authorize: failed to fetch oauth token: unexpected status from GET request to https://${REG}/oauth2/token?scope=repository%3A${I.ns}%2F${app}%3Apull&service=${REG}: 401 Unauthorized`, p) } : null);
      cfg.extra = crane([I.good], null);
      cfg.otherNs = { shop: (r) => (r === "secrets" ? K.cols([["NAME", "TYPE", "DATA", "AGE"], ["regcred", "kubernetes.io/dockerconfigjson", 1, "1y"]]) : null) };
      boot(st, cfg, {});
    } else {
      const old = mkTpl(base), nw = mkTpl({ ...base, image: `${repo}:${I.newTag}` });
      st.deploys[app] = { replicas: 6, tpl: nw, surge: "25%", unav: "25%", rev: 33, hist: [{ rev: 32, tpl: old, cause: `deploy ${I.good}` }, { rev: 33, tpl: nw, cause: `deploy ${I.newTag}` }] };
      const armOnly = (p) => tag(p.tpl) === I.newTag;
      cfg.H = (p, s) => { const n = s.nodes.find((x) => x.name === p.node); return armOnly(p) && n && n.arch === "amd64" ? { s: p.age === "6s" ? "ErrImagePull" : "ImagePullBackOff", ready: false, ev: pullEv(img(p.tpl), `rpc error: code = NotFound desc = failed to pull and unpack image "${img(p.tpl)}": no match for platform in manifest: not found`, p) } : null; };
      cfg.extra = crane([I.prevOld, I.good, I.newTag], (k, ref) => { const t = ref.split(":").pop(); if (t === I.newTag) return k === "config" ? `{"architecture":"arm64","os":"linux","config":{"Entrypoint":["/app/${app}"],"User":"65532"},"rootfs":{"type":"layers"}}` : `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:${hstr(ref, 20)}"},"layers":[...]}`; if ([I.good, I.prevOld].includes(t)) return k === "config" ? "Error: image index has multiple platforms; use --platform" : `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":"sha256:${hstr(ref, 20)}","platform":{"architecture":"amd64","os":"linux"}},{"digest":"sha256:${hstr(ref + "a", 20)}","platform":{"architecture":"arm64","os":"linux"}}]}`; return "Error: MANIFEST_UNKNOWN: manifest unknown"; });
      boot(st, cfg, { [app]: old });
    }
    return { sh: kube(cfg), st };
  }
  SCEN.push({
    id: "k8s-imagepull", name: "Get past ImagePullBackOff", kind: "Incident", skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => { const { sh, st } = pullShell(I); return { prompt: "$", init: st, run: sh.run, par: I.lv === 2 ? 7 : 6,
        motd: I.lv === 2 ? `First deploy of ${I.app} into namespace ${I.ns}: 0/3 ready` : `ALERT deploy ${I.app} not progressing`,
        cmds: ["kubectl get pods -o wide", "kubectl describe pod <pod>", `crane ls ${REG}/${I.ns}/${I.app}`, ...(I.lv === 3 ? ["crane manifest <image>", "kubectl get nodes -L kubernetes.io/arch", "kubectl rollout undo deployment/<name>"] : I.lv === 2 ? ["kubectl get secrets", "kubectl get serviceaccount default -o yaml", "kubectl patch serviceaccount default -p '<json>'", "kubectl rollout restart deployment/<name>"] : ["kubectl set image deployment/<name> <container>=<image>"])] }; },
      goal(st, I) {
        const { sh } = pullShell(I);
        if (!rolledOut(sh, st, I.app)) return `${esc(I.app)} still has pods that can't pull their image.`;
        if (I.lv === 1 && tag(st.deploys[I.app].tpl) !== I.want) return `The pods run, but on <code>${esc(tag(st.deploys[I.app].tpl))}</code>: the release that was meant to ship is ${esc(I.want)}.`;
        return true;
      },
      solve: (I) => I.lv === 1 ? { log: [`kubectl describe pod ${I.badPod}`, `crane ls ${REG}/${I.ns}/${I.app}`, `kubectl set image deployment/${I.app} ${I.app}=${REG}/${I.ns}/${I.app}:${I.want}`, `kubectl rollout status deployment/${I.app}`] }
        : I.lv === 2 ? { log: [`kubectl describe pod ${I.badPod}`, "kubectl get secrets", `kubectl patch serviceaccount default -p '{"imagePullSecrets":[{"name":"regcred"}]}'`, `kubectl rollout restart deployment/${I.app}`, `kubectl rollout status deployment/${I.app}`] }
          : { log: ["kubectl get pods -o wide", `kubectl describe pod ${I.badPod}`, `crane manifest ${REG}/${I.ns}/${I.app}:${I.newTag}`, `kubectl rollout undo deployment/${I.app}`, `kubectl rollout status deployment/${I.app}`] },
    }),
    gen(lv, R) {
      const app = appPick(R), ns = lv === 2 ? R.pick(["shop-eu", "shop-apac", "store-ca"]) : R.pick(["shop", "store"]);
      const I = { lv, app, ns, nodes: lv === 3 ? mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 2 }, { zone: "a", n: 1, pool: "graviton", itype: "m7g.xlarge", arch: "arm64" }, { zone: "b", n: 1, pool: "graviton", itype: "m7g.xlarge", arch: "arm64" }]) : mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 2 }]) };
      const v = ver(R);
      if (lv === 1) { I.prev = v; I.want = minor(v); const k = R.int(0, 2); I.typo = k === 0 ? "v" + I.want : k === 1 ? I.want.replace(/\.0$/, "") : I.want + " "; I.typo = I.typo.trim(); if (I.typo === I.want) I.typo = "v" + I.want; I.good = I.prev; I.tags = [bump(minor(v)).replace(/\d+$/, "0") === I.want ? I.prev : I.prev, `${I.prev}-rc1`, I.want, "latest"]; I.tags = [...new Set([v.replace(/\.\d+$/, ".0"), I.prev, `${I.want}-rc1`, I.want, "latest"])]; }
      if (lv === 2) { I.good = v; }
      if (lv === 3) { I.prevOld = v; I.good = bump(v); I.newTag = minor(v); }
      const { st, sh } = pullShell(I);
      const bad = st.pods.find((p) => p.node && !sh.isReady(st, p));
      if (!bad) return null;
      I.badPod = bad.name;
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: [`kubectl rollout undo deployment/${I.app}`] }, { log: [`kubectl delete pod ${I.badPod}`] }]
      : I.lv === 2 ? [{ log: [`kubectl patch serviceaccount default -p '{"imagePullSecrets":[{"name":"regcred"}]}'`] }, { log: [`kubectl rollout restart deployment/${I.app}`] }]
        : [{ log: [`kubectl patch deployment ${I.app} -p '{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/arch":"arm64"}}}}}'`] }, { log: [`kubectl delete pod ${I.badPod}`] }],
    text: (I) => I.lv === 1 ? `<p>The release pipeline for <b>${esc(I.app)}</b> was edited by hand to ship <b>${esc(I.want)}</b>. The new pod is stuck in <code>ImagePullBackOff</code>; the old version is still serving.</p><p>Get ${esc(I.want)} running.</p>`
      : I.lv === 2 ? `<p>You're launching <b>${esc(I.app)}</b> in the brand-new namespace <code>${esc(I.ns)}</code>, using the same Helm chart as in <code>shop</code>. All three pods are in <code>ImagePullBackOff</code>. The image is in the private registry <code>${REG}</code>, which needs credentials.</p><p>Get the pods running without changing the image.</p>`
        : `<p>The <b>${esc(I.app)}</b> ${esc(I.newTag)} rollout stalled: some new pods run fine, others are stuck in <code>ImagePullBackOff</code>, and the pattern seems random. The image was built and pushed from a developer's laptop because CI was down.</p><p>Restore a healthy deployment, safely.</p>`,
    hint: (I) => I.lv === 1 ? "The pull error says whether the registry was reached and what it answered. Compare the tag with what the registry actually has." : I.lv === 2 ? "401 means the registry wanted credentials the kubelet didn't send. Pull secrets are copied from the ServiceAccount into a pod when the pod is created." : "Which nodes are the failing pods on, and which ones are the healthy new pods on?",
    concept: "Image pull failures",
    how: "The kubelet asks the container runtime to pull the image; a failure shows as ErrImagePull, then ImagePullBackOff while it retries with growing delays. The Failed event carries the real answer: <i>not found</i> (wrong tag or repository), <i>401/403</i> (no or wrong credentials), or <i>no match for platform in manifest</i> (the image wasn't built for the node's CPU architecture). Registry credentials reach a pod through <code>imagePullSecrets</code>, either in the pod spec or copied from its ServiceAccount by the admission controller <i>when the pod is created</i>; existing pods never pick up a later change.",
    rule: "Read the Failed event's error text first. After changing pull credentials, recreate the pods. Build and push multi-arch images from CI only.",
    why: (I) => I.lv === 1 ? `The tag <code>${esc(I.typo)}</code> doesn't exist (the registry has <code>${esc(I.want)}</code>), so the runtime got <i>not found</i>. Setting the correct tag completes the rollout; rolling back would have skipped the release.`
      : I.lv === 2 ? `The namespace had a <code>regcred</code> secret, but nothing referenced it, so the kubelet pulled anonymously and got 401. Adding it to the default ServiceAccount fixes future pods only; the restart created new pods that received it.`
        : `${esc(I.newTag)} was pushed as a single-platform <b>arm64</b> image from a laptop. New pods scheduled onto the two Graviton (arm64) nodes ran; those on amd64 nodes failed with <i>no match for platform in manifest</i>. Pinning everything to arm64 wouldn't fit six replicas on two nodes. Roll back, then rebuild multi-arch in CI.`,
  });

  /* ===== 4. Service with no endpoints ===== */
  function epShell(I) {
    const cfg = { oldAge: "2d" }, app = I.app;
    const st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) });
    const port = I.lv === 3 ? I.cport : 8080;
    const tpl = mkTpl({ app, labels: { app: I.podLabel, tier: "backend" }, image: `${REG}/${I.ns}/${app}:${I.v}`, cpu: 200, mem: 256, lmem: 256, port, ready: { path: I.lv === 2 ? I.badPath : "/readyz", port, period: 5 }, live: { path: "/healthz", port } });
    st.deploys[app] = { replicas: 3, tpl, surge: "25%", unav: "25%", rev: 1, sel: { app: I.podLabel } };
    st.deploys.toolbox = { replicas: 1, tpl: mkTpl({ app: "toolbox", image: "docker.io/nicolaka/netshoot:v0.13", cpu: 10, mem: 32, cmd: ["sleep", "infinity"] }), surge: "25%", unav: "25%" };
    st.svcs[app] = { selector: { app: I.svcSel }, port: 80, targetPort: I.lv === 3 ? 8080 : "http", ip: I.ip };
    const sh0 = { ready: (s, p) => p.node && (I.lv !== 2 || ((C0(p.tpl).readinessProbe || {}).httpGet || {}).path === "/readyz") };
    cfg.H = (p) => (p.own === "deploy:" + app && I.lv === 2 && ((C0(p.tpl).readinessProbe || {}).httpGet || {}).path !== "/readyz" ? { s: "Running", ready: false, ev: [["Normal", "Started", "2d", "kubelet", `Started container ${app}`], ["Warning", "Unhealthy", "4s (x34581 over 2d)", "kubelet", "Readiness probe failed: HTTP probe failed with statuscode: 404"]] } : null);
    cfg.logs = (p) => p.own === "deploy:" + app ? `{"level":"info","msg":"listening","addr":":${port}"}\n` + (I.lv === 2 ? `{"level":"info","msg":"request","method":"GET","path":"${((C0(p.tpl).readinessProbe || {}).httpGet || {}).path}","status":${((C0(p.tpl).readinessProbe || {}).httpGet || {}).path === "/readyz" ? 200 : 404},"ua":"kube-probe/1.31"}` : `{"level":"info","msg":"request","method":"GET","path":"/readyz","status":200,"ua":"kube-probe/1.31"}`) : "";
    let sh;
    cfg.exec = (p, cmd, s) => {
      const m = cmd.match(/curl\b.*?(?:https?:\/\/)?([A-Za-z0-9.-]+)(?::(\d+))?(\/\S*)?\s*$/);
      if (!m) return /^(nslookup|dig)\b/.test(cmd) ? `Server:\t\t172.20.0.10\nAddress:\t172.20.0.10#53\n\nName:\t${app}.${I.ns}.svc.cluster.local\nAddress: ${I.ip}` : `sh: ${cmd.split(" ")[0]}: not found`;
      const host = m[1], prt = +(m[2] || 80), path = m[3] || "/";
      const ok = () => (path.startsWith("/healthz") || path.startsWith("/readyz") ? "ok" : `{"service":"${app}","status":"ok"}`);
      const svcN = host.split(".")[0];
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) { const pod = s.pods.find((x) => x.ip === host && x.node); if (host === I.ip) { /* falls through to svc */ } else return pod && (C0(pod.tpl).ports || [])[0].containerPort === prt ? ok() : `curl: (7) Failed to connect to ${host} port ${prt} after 1 ms: Couldn't connect to server`; }
      const sv = host === I.ip ? app : svcN;
      if (!s.svcs[sv]) return `curl: (6) Could not resolve host: ${host}`;
      const e = sh.epOf(s, sv).ready;
      const tp = (pod) => { const t = s.svcs[sv].targetPort; if (typeof t === "number") return t; const c = (C0(pod.tpl).ports || []).find((x) => x.name === t); return c ? c.containerPort : -1; };
      if (!e.length || prt !== s.svcs[sv].port || tp(e[0]) !== (C0(e[0].tpl).ports || [])[0].containerPort) return `curl: (7) Failed to connect to ${host} port ${prt} after 2 ms: Couldn't connect to server`;
      return ok();
    };
    cfg.danger = (v) => (v === "label-pod" ? "Hand-labelling pods only lasts until the next rollout or reschedule: the ReplicaSet creates new pods from the template." : null);
    void sh0;
    boot(st, cfg, {});
    sh = kube(cfg);
    return { sh, st };
  }
  SCEN.push({
    id: "k8s-svc-endpoints", name: "Service up, no traffic", kind: "Incident", skills: ["diagnose"],
    ...LB.term({
      shell: (I) => { const { sh, st } = epShell(I); return { prompt: "$", init: st, run: sh.run, par: 7,
        motd: `ALERT ingress: upstream ${I.ns}/${I.app} returning 503 (no healthy upstream)`,
        cmds: [`kubectl exec deploy/toolbox -- curl -sS -m 2 http://${I.app}/healthz`, `kubectl describe svc ${I.app}`, "kubectl get endpoints", "kubectl get endpointslices", "kubectl get pods --show-labels", "kubectl describe pod <pod>", "kubectl logs <pod>", "kubectl patch svc <name> -p '<json>'", "kubectl patch deployment <name> --type=json -p '<json>'"] }; },
      goal(st, I) {
        const { sh } = epShell(I);
        if (st.x.labelledPods) return "You hand-labelled pods. That works until the next rollout or reschedule creates pods from the unchanged template; fix the selector instead.";
        const out = sh.run(`kubectl exec deploy/toolbox -- curl -sS -m 2 http://${I.app}/healthz`, st).out;
        if (out !== "ok") return `<code>curl http://${esc(I.app)}/healthz</code> still fails: ${esc(out)}`;
        if (sh.epOf(st, I.app).ready.length < 3) return "Only some pods are behind the Service.";
        return true;
      },
      solve: (I) => ({ log: [`kubectl exec deploy/toolbox -- curl -sS -m 2 http://${I.app}/healthz`, `kubectl describe svc ${I.app}`, I.lv === 1 ? "kubectl get pods --show-labels" : I.lv === 2 ? `kubectl describe pod ${I.pod}` : `kubectl logs ${I.pod}`,
        I.lv === 1 ? `kubectl patch svc ${I.app} -p '{"spec":{"selector":{"app":"${I.podLabel}"}}}'` : I.lv === 2 ? `kubectl patch deployment ${I.app} --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/readyz"}]'` : `kubectl patch svc ${I.app} -p '{"spec":{"ports":[{"port":80,"targetPort":"http"}]}}'`,
        `kubectl exec deploy/toolbox -- curl -sS -m 2 http://${I.app}/healthz`] }),
    }),
    gen(lv, R) {
      const app = appPick(R);
      const I = { lv, app, ns: R.pick(["shop", "store"]), v: ver(R), ip: `172.20.${R.int(10, 250)}.${R.int(2, 250)}`, nodes: mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 1 }]) };
      I.podLabel = lv === 1 ? app : app; I.svcSel = lv === 1 ? R.pick([app + "-api", app + "-svc", app + "-server"]) : app;
      if (lv === 2) I.badPath = R.pick(["/health/ready", "/actuator/health/readiness", "/ready"]);
      if (lv === 3) I.cport = R.pick([9090, 8000, 3000]);
      const { st } = epShell(I);
      I.pod = st.pods.find((p) => p.own === "deploy:" + app).name;
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: ["kubectl get pods --show-labels", ...[I.pod].map((p) => `kubectl label pod ${p} app=${I.svcSel} --overwrite`)] }, { log: [`kubectl rollout restart deployment/${I.app}`] }]
      : I.lv === 2 ? [{ log: [`kubectl rollout restart deployment/${I.app}`] }, { log: [`kubectl patch svc ${I.app} -p '{"spec":{"ports":[{"port":80,"targetPort":8080}]}}'`] }]
        : [{ log: [`kubectl rollout restart deployment/${I.app}`] }, { log: [`kubectl patch svc ${I.app} -p '{"spec":{"ports":[{"port":${I.cport},"targetPort":8080}]}}'`] }],
    text: (I) => I.lv === 1 ? `<p>The platform team migrated <b>${esc(I.app)}</b> to the new shared Helm chart this morning. Pods are Running and Ready, but the ingress returns 503 and nothing reaches them. The Service manifest lives in a separate repo and wasn't touched.</p><p>Restore traffic through the Service.</p>`
      : I.lv === 2 ? `<p><b>${esc(I.app)}</b> was launched today from a chart copied from a Spring Boot service. Pods show <code>Running</code>, zero restarts, yet the Service has no endpoints and the ingress returns 503.</p><p>Restore traffic.</p>`
        : `<p><b>${esc(I.app)}</b> was rewritten in Go and redeployed. Pods are Running and Ready, <code>kubectl get endpoints</code> lists all three pod IPs, but every request through the Service fails to connect.</p><p>Restore traffic.</p>`,
    hint: (I) => I.lv === 1 ? "A Service sends traffic to Ready pods whose labels match its selector exactly." : I.lv === 2 ? "Running isn't Ready. What does the readiness probe ask for, and what does the app answer?" : "Endpoints list IP:port pairs. Which port is the app actually listening on?",
    concept: "Service → EndpointSlice → pod",
    how: "A Service's selector is evaluated continuously by the EndpointSlice controller: every pod whose labels match it is added, marked ready only when the pod's Ready condition is true. kube-proxy (or the CNI's replacement) programs the ClusterIP to load-balance across ready endpoints, translating the Service port to <code>targetPort</code>, which can be a number or a container port <i>name</i>. So 'no traffic' is one of three things: the selector matches nothing, the matched pods aren't Ready, or traffic is sent to a port nobody listens on.",
    rule: "Debug Services in order: selector vs pod labels, endpoints present and ready, targetPort vs the container's listening port. Use named ports so the Service follows the container.",
    why: (I) => I.lv === 1 ? `The Service selected <code>app=${esc(I.svcSel)}</code>, but the new chart labels pods <code>app=${esc(I.podLabel)}</code>, so the EndpointSlice was empty. A merge patch replaces that one selector key. Relabelling pods by hand would be undone by the next rollout.`
      : I.lv === 2 ? `The readiness probe hit <code>${esc(I.badPath)}</code>, which this app answers with 404, so no pod ever became Ready and the Service had no ready endpoints, even though nothing crashed. Pointing the probe at <code>/readyz</code> fixes it.`
        : `The Service sent traffic to targetPort 8080, but the rewritten app listens on ${I.cport}. Endpoints looked healthy because readiness is probed on the container's own port. Using the named port <code>http</code> makes the Service follow the container.`,
  });

  /* ===== 5. Node drain blocked ===== */
  function drainShell(I) {
    const cfg = { oldAge: "18d" }, st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) });
    const t = (app, o = {}) => mkTpl({ app, image: `${REG}/${I.ns}/${app}:${I.v}`, cpu: 250, mem: 512, lmem: 512, ready: { path: "/ready", port: 8080 }, ...o });
    st.deploys.cart = { replicas: I.lv === 1 ? 2 : 3, tpl: t("cart"), surge: "25%", unav: "25%" };
    st.deploys[I.other] = { replicas: 3, tpl: t(I.other), surge: "25%", unav: "25%" };
    if (I.lv === 2) st.deploys["session-cache"] = { replicas: 2, tpl: t("session-cache", { image: "docker.io/library/redis:7.4", port: 6379, portName: "redis", ready: null }), surge: "25%", unav: "25%" };
    if (I.lv === 1) st.pdbs.cart = { minAvailable: 2, selector: { app: "cart" } };
    if (I.lv === 2) st.pdbs.cart = { maxUnavailable: 1, selector: { app: "cart" } };
    if (I.lv === 3) { st.pdbs.cart = { maxUnavailable: 1, selector: { app: "cart" }, labels: "app.kubernetes.io/managed-by=Helm", ann: "meta.helm.sh/release-name: cart\n                meta.helm.sh/release-namespace: " + I.ns, age: "41d" }; st.pdbs["cart-pdb"] = { minAvailable: 2, selector: { app: "cart" }, labels: "team=legacy-checkout", ann: "kubectl.kubernetes.io/last-applied-configuration: {\"apiVersion\":\"policy/v1beta1\",...}", age: "2y" }; }
    cfg.admit = (p) => { if (p.own === "deploy:session-cache") p.emptyDir = true; };
    boot(st, cfg, {});
    if (I.lv === 2) {
      const n = st.pods.find((p) => p.own === "deploy:session-cache").node;
      st.pods.push({ name: I.mig, own: "pod", hash: "", tpl: mkTpl({ app: "migrate", labels: { run: I.mig }, image: `${REG}/${I.ns}/orders-migrate:${I.v}`, cpu: 500, mem: 1024 }), node: n, ip: ipOf(I.mig), age: "47m" });
      st.pods.push({ name: I.dbg, own: "pod", hash: "", tpl: mkTpl({ app: "debug", labels: { run: I.dbg }, image: "docker.io/nicolaka/netshoot:v0.13", cmd: ["sleep", "infinity"] }), node: n, ip: ipOf(I.dbg), age: "9d" });
      st.x.target = n;
      cfg.wait = (a, s) => { const ref = (a.pos[0] || "").replace(/^pods?\//, ""); const f = String(a.g("--for") || ""); const p = s.pods.find((x) => x.name === ref); if (!p) return `Error from server (NotFound): pods "${ref}" not found`; if (ref === I.mig && /Succeeded/.test(f)) { p.done = true; p.doneS = "Completed"; s.x.waited = true; return `pod/${ref} condition met`; } return `error: timed out waiting for the condition on pods/${ref}`; };
      cfg.logs = (p) => (p.name === I.mig ? (p.done ? "batch 1000/1000 done\nbackfill complete: 41,822,113 rows in 52m11s\nexit 0" : `batch 914/1000 (orders 2024-11) 38.2M rows ... ETA 5m\nbatch 915/1000 (orders 2024-11) 38.3M rows ... ETA 5m`) : p.name === I.dbg ? "" : "ready");
      cfg.danger = (v, d, s) => (v === "drain" && d.bare.some((p) => p.name === I.mig && !p.done) ? `--force deleted ${I.mig}, a bare pod running a one-off backfill at batch 914/1000. Nothing recreates it.` : v === "delete-pod" && d.p.name === I.mig && !d.p.done ? "You killed the running backfill." : null);
    } else {
      st.x.target = st.pods.find((p) => p.own === "deploy:cart").node;
      cfg.danger = (v, d) => (v === "delete-pdb" ? (I.lv === 3 && d.n === "cart-pdb" ? null : `Deleting the ${d.n} PDB removes the team's protection, not just for this drain.`) : v === "patch-pdb" ? "Weakening the team's PDB to get a drain through trades their availability for your convenience." : v === "drain" && d.a.has("--disable-eviction") ? "--disable-eviction deletes pods directly and bypasses every PodDisruptionBudget." : null);
    }
    return { sh: kube(cfg), st };
  }
  SCEN.push({
    id: "k8s-drain-pdb", name: "Drain the node for patching", kind: "Change plan", skills: ["safe", "diagnose"],
    ...LB.term({
      shell: (I) => { const { sh, st } = drainShell(I); return { prompt: "$", init: st, run: sh.run, par: I.lv === 2 ? 7 : 6,
        motd: `Maintenance: kernel CVE patch, node ${st.x.target} must be drained and replaced today.`,
        cmds: [`kubectl drain ${st.x.target} --ignore-daemonsets`, "kubectl get pods -o wide", "kubectl get pdb", "kubectl describe pdb <name>", ...(I.lv === 2 ? ["kubectl logs <pod>", "kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/<pod> --timeout=30m", `kubectl drain ${st.x.target} --ignore-daemonsets --delete-emptydir-data --force`] : ["kubectl scale deployment/<name> --replicas=<n>", "kubectl delete pdb <name>"])] }; },
      goal(st, I) {
        const { sh } = drainShell(I), tg = st.x.target;
        const left = st.pods.filter((p) => p.node === tg && !p.done && !p.term);
        if (!(st.nodes.find((n) => n.name === tg) || {}).cordon || left.length) return `Node ${esc(tg)} still runs ${left.length} pod(s): ${left.map((p) => esc(p.name)).join(", ") || "it isn't cordoned"}.`;
        if (st.x.bypassPdb) return "The node is empty, but --disable-eviction deleted pods without asking any PodDisruptionBudget.";
        if (I.lv === 1 && !(st.pdbs.cart && st.pdbs.cart.minAvailable === 2)) return "The node is empty, but the cart PDB was removed or weakened.";
        if (I.lv === 2 && !st.x.waited) return `The node is drained, but the backfill pod ${esc(I.mig)} was killed before it finished.`;
        if (I.lv === 3 && (!st.pdbs.cart || st.pdbs["cart-pdb"])) return st.pdbs.cart ? "Both PDBs still exist." : "You deleted the Helm-managed PDB and kept the stale hand-applied one, which nothing in Git owns.";
        const cart = podsOf(st, "deploy:cart").filter((p) => sh.isReady(st, p)).length;
        if (cart < 2) return "Cart dropped below two ready pods.";
        return true;
      },
      solve: (I) => { const { st } = drainShell(I), tg = st.x.target; return I.lv === 1 ? { log: [`kubectl drain ${tg} --ignore-daemonsets`, "kubectl get pdb", "kubectl scale deployment/cart --replicas=3", `kubectl drain ${tg} --ignore-daemonsets`] }
        : I.lv === 2 ? { log: [`kubectl drain ${tg} --ignore-daemonsets`, `kubectl logs ${I.mig}`, `kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/${I.mig} --timeout=30m`, `kubectl drain ${tg} --ignore-daemonsets --delete-emptydir-data --force`] }
          : { log: [`kubectl drain ${tg} --ignore-daemonsets`, "kubectl get pdb", "kubectl describe pdb cart-pdb", "kubectl delete pdb cart-pdb", `kubectl drain ${tg} --ignore-daemonsets`] }; },
    }),
    gen(lv, R) {
      const I = { lv, ns: R.pick(["shop", "store"]), v: ver(R), other: R.pick(["catalog", "search", "pricing"]), nodes: mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 2 }]) };
      if (lv === 2) { I.mig = `backfill-orders-${R.pick(["0927", "1003", "1011"])}`; I.dbg = `debug-${R.pick(["maria", "dev", "tom", "aisha"])}`; }
      return I;
    },
    bad: (I) => { const { st } = drainShell(I), tg = st.x.target; return I.lv === 1 ? [{ log: ["kubectl delete pdb cart", `kubectl drain ${tg} --ignore-daemonsets`] }, { log: [`kubectl drain ${tg} --ignore-daemonsets --disable-eviction`] }]
      : I.lv === 2 ? [{ log: [`kubectl drain ${tg} --ignore-daemonsets --delete-emptydir-data --force`] }]
        : [{ log: ["kubectl delete pdb cart", `kubectl drain ${tg} --ignore-daemonsets`] }, { log: ["kubectl delete pdb cart", "kubectl delete pdb cart-pdb", `kubectl drain ${tg} --ignore-daemonsets`] }]; },
    text: (I) => `<p>A kernel CVE fix requires replacing every node. Your job: drain the node named in the terminal so it can be terminated, without hurting anyone's workload.${I.lv === 1 ? " The <b>cart</b> team runs 2 replicas and protects them with a PodDisruptionBudget." : I.lv === 2 ? " Several teams have pods on it, including some that aren't managed by any controller." : " The <b>cart</b> team says their PDB allows one pod down at a time, yet the drain hangs."}</p><p>Leave the node empty (DaemonSets aside) and every team's protections intact.</p>`,
    hint: (I) => I.lv === 1 ? "With 2 replicas and minAvailable 2, how many disruptions are allowed? What would make one allowed?" : I.lv === 2 ? "--force deletes bare pods for good. Find out what each bare pod is doing before you use it." : "Read the eviction error closely: it isn't the usual budget message.",
    concept: "Drains, evictions and PodDisruptionBudgets",
    how: "<code>kubectl drain</code> cordons the node, then calls the Eviction API for each pod. An eviction is refused (HTTP 429) if it would take the pods selected by a PodDisruptionBudget below <code>minAvailable</code>, and drain retries forever. A pod covered by more than one PDB can't be evicted at all. Drain also refuses DaemonSet pods (they'd come straight back), pods with emptyDir data (lost), and pods without a controller (nothing recreates them) unless you pass the matching flag; finished pods are removed without --force.",
    rule: "Make a drain possible by adding capacity (scale up, then drain), never by deleting or weakening someone's PDB. Check what bare pods are doing before reaching for --force.",
    why: (I) => I.lv === 1 ? "minAvailable 2 with 2 replicas means zero allowed disruptions, so the eviction kept failing. Scaling cart to 3 gives the budget one disruption; the evicted pod was rescheduled elsewhere and became Ready before the next eviction."
      : I.lv === 2 ? `The node ran a bare backfill pod at batch 914/1000. --force would have deleted it with nothing to recreate it. Waiting for it to finish, then draining with --delete-emptydir-data (the cache) and --force (only the idle debug pod left) was safe.`
        : "Two PDBs selected the cart pods: the Helm-managed <code>cart</code> and a two-year-old hand-applied <code>cart-pdb</code>. The Eviction API refuses pods with more than one PDB, so the drain could never succeed. Removing the stale, unowned one fixed it and kept the budget that lives in Git.",
  });

  /* ===== 6. Node NotReady ===== */
  function nrShell(I) {
    const cfg = { oldAge: "34d" }, st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) }), app = I.app, db = I.db;
    const t = (a, o = {}) => mkTpl({ app: a, image: `${REG}/${I.ns}/${a}:${I.v}`, cpu: 500, mem: 1024, lmem: 1024, ready: { path: "/ready", port: 8080 }, ...o });
    if (I.lv < 3) {
      st.deploys[app] = { replicas: 3, tpl: t(app), surge: "25%", unav: "25%" };
      st.sts[db] = { replicas: 1, claim: "data", sc: "gp3", tpl: t(db, { image: "docker.io/library/postgres:16.4", cpu: 1000, mem: 4096, lmem: 4096, port: 5432, portName: "postgres", ready: { exec: ["pg_isready"] } }) };
      boot(st, cfg, {});
      Object.values(st.pvcs).forEach((v) => { v.bound = true; v.fresh = false; });
      const dead = st.nodes.find((n) => n.name === st.pods.find((p) => p.own === "sts:" + db).node);
      dead.ready = "Unknown"; st.x.dead = dead.name;
      st.pods.filter((p) => p.node === dead.name).forEach((p) => { p.term = true; p.termFor = "14m"; });
      st.x.inst = Object.fromEntries(st.nodes.map((n) => [n.name, { id: "i-0" + hstr(n.name, 16).replace(/[^a-z0-9]/g, "a"), state: n.name === dead.name ? (I.lv === 1 ? "terminated" : "running") : "running" }]));
      cfg.extra = [
        { re: /^cloudctl instances? list$/, use: "cloudctl instances list", desc: "the cluster's EC2-style instances", run: (m, s) => K.cols([["INSTANCE", "NODE", "STATE", "STATUS CHECKS", "ZONE"], ...Object.entries(s.x.inst).map(([n, x]) => [x.id, n, x.state, x.state === "running" ? "2/2 passed" : "-", "eu-west-1" + n.split("-")[1]])]) },
        { re: /^cloudctl instances? describe (\S+)$/, use: "cloudctl instance describe <id>", desc: "instance details and recent events", run: (m, s) => { const e = Object.entries(s.x.inst).find(([, x]) => x.id === m[1]); if (!e) return `error: instance ${m[1]} not found`; const [n, x] = e; return [`InstanceId:     ${x.id}`, `PrivateDnsName: ${n}`, `State:          ${x.state}`, `StateReason:    ${x.state === "terminated" ? "Server.SpotInstanceTermination: Spot instance termination" : x.state === "stopped" ? "Client.UserInitiatedShutdown" : "-"}`, `StatusChecks:   ${x.state === "running" ? "system ok, instance ok" : "-"}`, ...(n === s.x.dead && I.lv === 2 && x.state === "running" ? ["Recent events:  09:02 security group sg-0e4c… rule change applied by terraform (run #8812): egress to 10.0.0.0/16:443 removed", "Note:           the instance is up; its kubelet can't reach the API server"] : [])].join("\n"); } },
        { re: /^cloudctl instances? stop (\S+)(?: --force)?$/, use: "cloudctl instance stop <id> [--force]", desc: "power off an instance", run: (m, s) => { const e = Object.entries(s.x.inst).find(([, x]) => x.id === m[1]); if (!e) return `error: instance ${m[1]} not found`; if (e[1].state !== "running") return `instance ${m[1]} is already ${e[1].state}`; e[1].state = "stopped"; if (e[0] === s.x.dead) s.x.fenced = true; return { out: `${m[1]}: stopping -> stopped`, danger: e[0] !== s.x.dead ? "You powered off a healthy node." : null }; } },
      ];
      const unsafe = (s) => s.x.inst[s.x.dead].state === "running";
      cfg.danger = (v, d, s) => { const hit = (v === "delete-node" && d.n.name === s.x.dead) || (v === "delete-pod" && d.force && d.p.node === s.x.dead) || (v === "taint" && d.nd.name === s.x.dead && d.args.some((x) => /out-of-service/.test(x))); if (hit && unsafe(s)) { s.x.split = true; return `${db}-0 may still be running on ${s.x.dead} (the instance is up). Starting a second copy of the database risks two writers on the same data.`; } return v === "delete-node" && d.n.name !== s.x.dead ? "You deleted a healthy node." : null; };
      cfg.onTaint = (nd, s) => { if (nd.taints.some((x) => x.key === "node.kubernetes.io/out-of-service")) s.pods = s.pods.filter((p) => p.node !== nd.name); };
      cfg.logs = (p) => (p.term ? `Error from server: Get "https://${p.node}:10250/containerLogs/${I.ns}/${p.name}/${C0(p.tpl).name}": dial tcp 10.0.3.17:10250: connect: no route to host` : "ready");
      cfg.nodeEv = (n) => (n.ready === "Unknown" ? [["Normal", "NodeNotReady", "16m", "node-controller", `Node ${n.name} status is now: NodeNotReady`]] : []);
    } else {
      st.deploys[app] = { replicas: 8, tpl: t(app, { cpu: 1500, mem: 2048, lmem: 2048 }), surge: "25%", unav: "25%" };
      st.x.cniBad = true;
      cfg.pre = (s) => s.nodes.forEach((n) => { if (n.fresh) n.ready = s.x.cniBad ? "False" : "True"; });
      cfg.H = null;
      const agents = (s) => s.nodes.map((n, k) => { const nv = n.fresh || k === 0; const bad = s.x.cniBad && nv; return [`net-agent-${hstr(n.name + "na", 5)}`, bad ? "0/1" : "1/1", bad ? "CrashLoopBackOff" : "Running", bad ? "8 (2m ago)" : "0", bad || (!s.x.cniBad && nv) ? "38m" : "34d", n.name, s.x.cniBad && nv ? "2.0.1" : "1.9.4"]; });
      cfg.otherNs = { "kube-system": (r) => r === "pods" ? K.cols([["NAME", "READY", "STATUS", "RESTARTS", "AGE", "NODE"], ...agents(st).map((x) => x.slice(0, 6))]) : r === "daemonsets" ? K.cols([["NAME", "DESIRED", "CURRENT", "READY", "UP-TO-DATE", "AVAILABLE", "NODE SELECTOR", "AGE"], ["kube-proxy", st.nodes.length, st.nodes.length, st.nodes.length, st.nodes.length, st.nodes.length, "<none>", "212d"], ["net-agent", st.nodes.length, st.nodes.length, st.nodes.length - (st.x.cniBad ? 3 : 0), st.x.cniBad ? 3 : st.nodes.length, st.nodes.length - (st.x.cniBad ? 3 : 0), "<none>", "212d"]]) : null };
      cfg.hook = (verb, a, s) => {
        if (a.g("-n", "--namespace") !== "kube-system") return undefined;
        const ref = a.pos.join(" ");
        if (verb === "get" && /^(pods?|po|ds|daemonsets?)\b/.test(ref)) return cfg.otherNs["kube-system"](/^(ds|daemonset)/.test(ref) ? "daemonsets" : "pods");
        if (verb === "logs") return s.x.cniBad && agents(s).some((x) => x[0] === a.pos[0] && x[2] !== "Running") ? `level=info msg="net-agent 2.0.1 starting"\nlevel=info msg="reading config from /etc/net-agent/config.yaml"\nlevel=fatal msg="invalid configuration" error="option ipam.mode=\\"cluster-pool-v1\\" is no longer supported; supported values: cluster-pool, kubernetes"` : agents(s).some((x) => x[0] === a.pos[0]) ? `level=info msg="net-agent 1.9.4 running" endpoints=31` : `Error from server (NotFound): pods "${a.pos[0]}" not found`;
        if (verb === "rollout" && /daemonsets?\/net-agent|ds\/net-agent/.test(ref)) {
          if (a.pos[0] === "history") return "daemonset.apps/net-agent \nREVISION  CHANGE-CAUSE\n6         helm upgrade net-agent 1.9.4\n7         helm upgrade net-agent 2.0.1 (platform PR #902)";
          if (a.pos[0] === "status") return s.x.cniBad ? `Waiting for daemon set "net-agent" rollout to finish: 1 out of ${s.nodes.length} new pods have been updated...\n^C` : `daemon set "net-agent" successfully rolled out`;
          if (a.pos[0] === "undo") { s.x.cniBad = false; reconcile(s, cfg); return "daemonset.apps/net-agent rolled back"; }
          if (a.pos[0] === "restart") return "daemonset.apps/net-agent restarted";
        }
        if (verb === "delete" && /^pods?/.test(ref)) return ref.split(" ").slice(1).map((x) => `pod "${x}" deleted`).join("\n") || "error: resource name required";
        return `No resources found in kube-system namespace.`;
      };
      boot(st, cfg, {});
    }
    return { sh: kube(cfg), st };
  }
  SCEN.push({
    id: "k8s-node-notready", name: "Recover from a NotReady node", kind: "Incident", skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => { const { sh, st } = nrShell(I); return { prompt: "$", init: st, run: sh.run, par: I.lv === 3 ? 7 : 6,
        motd: I.lv < 3 ? `ALERT ${I.db}: 0/1 ready for 14m · ${I.app} degraded` : `ALERT ${I.app}: 4 pods Pending for 31m during the traffic peak`,
        cmds: I.lv < 3 ? ["kubectl get nodes", "kubectl get pods -o wide", "kubectl describe node <node>", "cloudctl instances list", "cloudctl instance describe <id>", "cloudctl instance stop <id>", "kubectl delete node <node>"] : ["kubectl get nodes", "kubectl describe node <node>", "kubectl get pods -o wide", "kubectl get pods -n kube-system", "kubectl logs -n kube-system <pod>", "kubectl rollout history daemonset/net-agent -n kube-system", "kubectl rollout undo daemonset/net-agent -n kube-system"] }; },
      goal(st, I) {
        const { sh } = nrShell(I);
        if (I.lv < 3) {
          if (st.x.split) return `You started a new ${esc(I.db)}-0 while the old one might still be running on a live instance: a split-brain risk. Fence the node first (power the instance off).`;
          if (!allReady(sh, st, "sts:" + I.db, 1)) return `${esc(I.db)}-0 is still not running.`;
          if (!allReady(sh, st, "deploy:" + I.app, 3)) return `${esc(I.app)} isn't fully available.`;
          return true;
        }
        if (!rolledOut(sh, st, I.app)) return `${esc(I.app)} still has Pending pods.`;
        return true;
      },
      solve: (I) => { const { st } = nrShell(I); return I.lv === 1 ? { log: ["kubectl get nodes", `kubectl get pods -o wide`, "cloudctl instances list", `kubectl delete node ${st.x.dead}`, "kubectl get pods -o wide"] }
        : I.lv === 2 ? { log: ["kubectl get pods -o wide", "cloudctl instances list", `cloudctl instance describe ${st.x.inst[st.x.dead].id}`, `cloudctl instance stop ${st.x.inst[st.x.dead].id}`, `kubectl delete node ${st.x.dead}`, "kubectl get pods -o wide"] }
          : { log: ["kubectl get nodes", `kubectl describe node ${st.nodes.find((n) => n.fresh).name}`, "kubectl get pods -n kube-system", `kubectl logs -n kube-system net-agent-${hstr(st.nodes.find((n) => n.fresh).name + "na", 5)}`, "kubectl rollout undo daemonset/net-agent -n kube-system", "kubectl get pods"] }; },
    }),
    gen(lv, R) {
      const I = { lv, ns: R.pick(["shop", "store"]), v: ver(R), app: appPick(R), db: R.pick(["ledger-db", "orders-db", "billing-db"]) };
      if (lv < 3) I.nodes = mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 2 }]);
      else { I.nodes = mkNodes(R, [{ zone: "a", n: 2, cpu: 3920, mem: 14480 }, { zone: "b", n: 2 }, { zone: "c", n: 2 }]); I.nodes.forEach((n, k) => { if (k >= 4) { n.fresh = true; n.age = "36m"; n.notReadyMsg = "container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized"; } else n.sys.push({ ns: "batch", name: "etl-" + hstr(n.name, 5), cpu: 1500, mem: 2048 }); }); }
      return I;
    },
    bad: (I) => { const { st } = nrShell(I); return I.lv === 1 ? [{ log: [`kubectl rollout restart statefulset/${I.db}`] }, { log: [`kubectl delete pod ${I.db}-0`] }]
      : I.lv === 2 ? [{ log: [`kubectl delete node ${st.x.dead}`] }, { log: [`kubectl delete pod ${I.db}-0 --force --grace-period=0`] }]
        : [{ log: st.nodes.filter((n) => n.fresh).map((n) => `kubectl delete node ${n.name}`) }, { log: [`kubectl rollout restart deployment/${I.app}`] }]; },
    text: (I) => I.lv === 1 ? `<p>Node <b>NotReady</b> for 16 minutes. The ${esc(I.app)} Deployment already has replacement pods, but the single-replica StatefulSet <b>${esc(I.db)}</b> is down: its pod has shown <code>Terminating</code> for 14 minutes and no new one appears. You have the cloud CLI too.</p><p>Bring ${esc(I.db)} back.</p>`
      : I.lv === 2 ? `<p>Node <b>NotReady</b> (status Unknown) for 16 minutes. <b>${esc(I.db)}</b>, a single-replica Postgres StatefulSet, is stuck <code>Terminating</code> there and nothing replaces it. A teammate suggests <code>kubectl delete pod --force</code>. You have the cloud CLI too.</p><p>Bring ${esc(I.db)} back safely.</p>`
        : `<p>During the evening peak the cluster autoscaler added two nodes 36 minutes ago, but they never became Ready, and four <b>${esc(I.app)}</b> pods are Pending. The platform team merged a CNI upgrade earlier today.</p><p>Get the pods scheduled. Deleting broken nodes just makes the autoscaler create more.</p>`,
    hint: (I) => I.lv === 1 ? "A StatefulSet never creates a second pod with the same name while the old one might exist. Who can confirm the old one is gone?" : I.lv === 2 ? "NotReady means the API server lost contact, not that the machine is dead. What do the cloud's instance details say?" : "Read the Ready condition's message on a new node, then look at the pods that implement networking on that node.",
    concept: "NotReady nodes, StatefulSets and fencing",
    how: "When a kubelet stops reporting, the node controller marks the node Unknown, taints it unreachable, and after the 300 s toleration evicts its pods. Deployment pods are replaced at once; StatefulSet pods are not, because a StatefulSet guarantees at most one pod per identity, and the API server can't know whether the old container is still running. The pod stays Terminating until the kubelet confirms, the Node object is deleted, or the node gets the out-of-service taint. Doing that is only safe once the machine is really off: a partitioned node may still be writing. Separately, a node only becomes Ready once its CNI plugin is initialised, so a broken network DaemonSet keeps every new node NotReady.",
    rule: "Before force-deleting a StatefulSet pod or a Node, prove the machine is off (or power it off yourself). For a fleet of nodes that won't become Ready, look at the node-level DaemonSets first.",
    why: (I) => I.lv === 1 ? `The instance behind the node had been terminated by a spot interruption, so it was safe to tell Kubernetes: deleting the Node object removed the stuck pod and the StatefulSet created ${esc(I.db)}-0 on a healthy node.`
      : I.lv === 2 ? `The instance was still running: a Terraform change had cut the kubelet's path to the API server. Force-deleting first could have left two Postgres processes writing to the same data. Powering the instance off fenced it; only then was deleting the node (or applying the out-of-service taint) safe.`
        : `The new nodes reported <i>cni plugin not initialized</i>: the net-agent DaemonSet's 2.0.1 rejected a config value removed in that release and crash-looped on every node it reached, including the new ones. Rolling the DaemonSet back let the agents start, the nodes turned Ready, and the Pending pods scheduled.`,
  });

  /* ===== 7. Rollback ===== */
  function rbShell(I) {
    const cfg = { oldAge: "3d", newAge: "12m" }, st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) }), app = I.app;
    const t = (v) => mkTpl({ app, image: `${REG}/${I.ns}/${app}:${v}`, cpu: 300, mem: 512, lmem: 512, ready: { path: "/ready", port: 8080, period: 5 }, live: { path: "/healthz", port: 8080, delay: 5 } });
    const revs = I.revs.map((r) => ({ rev: r.rev, tpl: t(r.v), cause: r.cause }));
    st.deploys[app] = { replicas: 4, tpl: revs[revs.length - 1].tpl, surge: "25%", unav: "25%", rev: revs[revs.length - 1].rev, hist: revs };
    const crash = (p) => ({ s: "CrashLoopBackOff", ready: false, ...freshRc(p, 7), last: { reason: "Error", code: 2 }, ev: [backoff(p, st)] });
    cfg.H = (p) => { const v = tag(p.tpl); if (v === I.crashV) return crash(p); if (v === I.unreadyV) return { s: "Running", ready: false, ev: [["Warning", "Unhealthy", "7s (x140 over 12m)", "kubelet", "Readiness probe failed: HTTP probe failed with statuscode: 503"]] }; return null; };
    cfg.logs = (p) => { const v = tag(p.tpl); if (v === I.crashV) return `panic: runtime error: invalid memory address or nil pointer dereference\n[signal SIGSEGV: segmentation violation code=0x1 addr=0x18 pc=0x9c51e2]\n\ngoroutine 1 [running]:\n${app}/internal/promo.(*Parser).Load(...)\n\t/src/internal/promo/parser.go:88`; if (v === I.unreadyV) return `level=ERROR msg="readiness check failed" check=db error="relation \\"promo_rules\\" does not exist"`; if (I.lv === 3 && v === I.oldV) return `level=ERROR msg="request failed" path=/api/orders status=500 error="pq: column orders.legacy_status does not exist"\nlevel=ERROR msg="request failed" path=/api/orders/9127734 status=500 error="pq: column orders.legacy_status does not exist"`; return `level=INFO msg="listening" addr=:8080 version=${v}`; };
    if (I.lv === 3) {
      cfg.extra = [{ re: /^ci builds(?: (\S+))?$/, use: "ci builds [service]", desc: "recent CI builds and the images they pushed", run: () => K.cols([["BUILD", "TAG", "STATUS", "AGE", "COMMIT", "MESSAGE"], [`#${I.b + 5}`, I.fixV, "passed", "6m", "9f2c1ab", `fix nil deref in promo parser (hotfix for ${I.crashV})`], [`#${I.b}`, I.crashV, "passed", "41m", "c03e7d2", "promo codes v2; migration 0187 renames orders.legacy_status -> fulfilment_state"], [`#${I.b - 31}`, I.oldV, "passed", "3d", "77ab9e0", "bump deps"]]) }];
      cfg.danger = (v, d, s) => (v === "undo" || (v === "image" && tag(s.deploys[app].tpl) === I.oldV) ? `Migration 0187 already renamed orders.legacy_status. ${I.oldV} can't read the new schema: rolling back turns a partial outage into a full one.` : null);
    }
    boot(st, cfg, Object.fromEntries([[app, revs[0].tpl]]));
    if (I.lv === 2) { /* a crashed pod from the intermediate revision is still around */ }
    return { sh: kube(cfg), st };
  }
  SCEN.push({
    id: "k8s-rollback", name: "Roll back the bad release", kind: "Incident", skills: ["safe", "diagnose"],
    ...LB.term({
      shell: (I) => { const { sh, st } = rbShell(I); return { prompt: "$", init: st, run: sh.run, par: 6,
        motd: `ALERT ${I.app}: rollout of ${I.revs[I.revs.length - 1].v} stuck${I.lv === 3 ? " · orders API error rate 38%" : ""}`,
        cmds: ["kubectl get pods", "kubectl logs <pod>", "kubectl rollout history deployment/<name>", "kubectl rollout undo deployment/<name>", "kubectl rollout undo deployment/<name> --to-revision=<n>", ...(I.lv === 3 ? ["ci builds", "kubectl set image deployment/<name> <container>=<image>"] : [])] }; },
      goal(st, I) {
        const { sh } = rbShell(I);
        if (!rolledOut(sh, st, I.app)) return `${esc(I.app)} still has pods that aren't Ready.`;
        const v = tag(st.deploys[I.app].tpl);
        if (I.lv === 3 && v !== I.fixV) return v === I.oldV ? `All pods run ${esc(v)}, but that version queries <code>orders.legacy_status</code>, which migration 0187 renamed: every order request now fails.` : `The pods run ${esc(v)}.`;
        return true;
      },
      solve: (I) => I.lv === 1 ? { log: [`kubectl logs ${I.badPod}`, `kubectl rollout history deployment/${I.app}`, `kubectl rollout undo deployment/${I.app}`, `kubectl rollout status deployment/${I.app}`] }
        : I.lv === 2 ? { log: [`kubectl rollout history deployment/${I.app}`, `kubectl logs ${I.badPod}`, `kubectl rollout undo deployment/${I.app} --to-revision=${I.revs[0].rev}`, `kubectl rollout status deployment/${I.app}`] }
          : { log: [`kubectl logs ${I.badPod}`, `kubectl logs ${I.oldPod}`, "ci builds", `kubectl set image deployment/${I.app} ${I.app}=${REG}/${I.ns}/${I.app}:${I.fixV}`, `kubectl rollout status deployment/${I.app}`] },
    }),
    gen(lv, R) {
      const app = appPick(R), v0 = ver(R), r0 = R.int(4, 30);
      const I = { lv, app, ns: R.pick(["shop", "store"]), nodes: mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 2 }]), oldV: v0 };
      if (lv === 1) { I.crashV = minor(v0); I.revs = [{ rev: r0, v: v0, cause: `deploy ${v0}` }, { rev: r0 + 1, v: I.crashV, cause: `deploy ${I.crashV}` }]; }
      if (lv === 2) { I.crashV = minor(v0); I.unreadyV = bump(I.crashV); I.revs = [{ rev: r0, v: v0, cause: `deploy ${v0}` }, { rev: r0 + 1, v: I.crashV, cause: `deploy ${I.crashV}` }, { rev: r0 + 2, v: I.unreadyV, cause: `hotfix ${I.unreadyV} (skip promo cache)` }]; }
      if (lv === 3) { I.crashV = minor(v0); I.fixV = bump(I.crashV); I.b = R.int(4000, 9000); I.revs = [{ rev: r0, v: v0, cause: `deploy ${v0}` }, { rev: r0 + 1, v: I.crashV, cause: `deploy ${I.crashV}` }]; }
      const { st, sh } = rbShell(I);
      const bad = st.pods.find((p) => tag(p.tpl) === I.crashV && p.node && !sh.isReady(st, p)) || st.pods.find((p) => !sh.isReady(st, p));
      if (!bad) return null;
      I.badPod = bad.name; I.oldPod = (st.pods.find((p) => tag(p.tpl) === v0) || bad).name;
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: [`kubectl rollout restart deployment/${I.app}`] }]
      : I.lv === 2 ? [{ log: [`kubectl rollout undo deployment/${I.app}`] }, { log: [`kubectl rollout undo deployment/${I.app}`, `kubectl rollout undo deployment/${I.app}`] }]
        : [{ log: [`kubectl rollout undo deployment/${I.app}`] }, { log: [`kubectl rollout restart deployment/${I.app}`] }],
    text: (I) => I.lv === 1 ? `<p><b>${esc(I.app)} ${esc(I.crashV)}</b> went out ten minutes ago and its new pods crash on startup. The old pods are still serving at reduced capacity.</p><p>Restore a healthy deployment as quickly and safely as you can.</p>`
      : I.lv === 2 ? `<p><b>${esc(I.app)} ${esc(I.crashV)}</b> crashed on rollout, so someone pushed a quick "hotfix" ${esc(I.unreadyV)} on top. Its pods start but never become Ready. Only the old pods from before both releases are serving.</p><p>Restore a healthy deployment.</p>`
        : `<p><b>${esc(I.app)} ${esc(I.crashV)}</b> crashes on startup, and the remaining old pods return 500 on many order requests. The incident channel wants a rollback.</p><p>Restore service. Check what the old version is doing before you decide.</p>`,
    hint: (I) => I.lv === 1 ? "rollout history shows the revisions; undo goes to the previous one." : I.lv === 2 ? "Plain undo goes to the revision just before the current one. Which revision was actually healthy?" : "Read the old pods' logs, then look at what CI has built since the bad release.",
    concept: "Rollbacks and revision history",
    how: "Each change to a Deployment's pod template creates a ReplicaSet and a revision. <code>kubectl rollout undo</code> copies the previous revision's template back, which becomes a <i>new</i> revision number, so undoing twice bounces between the last two revisions. <code>--to-revision</code> picks a specific one. A rollback only reverts the pod template: ConfigMaps, Secrets and especially database migrations stay where they are, so an old binary may not work against a schema the new one migrated.",
    rule: "Check rollout history and roll back to the last known-good revision explicitly. If the release included a forward-only migration, roll forward with a fix instead.",
    why: (I) => I.lv === 1 ? `${esc(I.crashV)} panicked on startup. Undo restored revision ${I.revs[0].rev}'s template and the old ReplicaSet scaled back up.`
      : I.lv === 2 ? `Plain undo would go to ${esc(I.crashV)} (revision ${I.revs[1].rev}), the crashing one, and a second undo would bounce back to the broken hotfix. <code>--to-revision=${I.revs[0].rev}</code> returns to ${esc(I.oldV)}, the last revision that ever served traffic.`
        : `${esc(I.crashV)} shipped migration 0187, which renamed <code>orders.legacy_status</code>. The old ${esc(I.oldV)} pods were already failing on that column, so a rollback would have made every pod fail. CI had built ${esc(I.fixV)} with the crash fix: rolling forward was the safe move.`,
  });

  /* ===== 8. ConfigMap change not picked up ===== */
  function cmShell(I) {
    const cfg = { oldAge: "5d" }, st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) }), app = I.app, key = I.key;
    st.cms[`${app}-config`] = { data: { ...I.data, [key]: I.oldVal }, v: 1, age: "90d" };
    const sub = I.lv === 2;
    const mk = (a, o) => mkTpl({ app: a, image: `${REG}/${I.ns}/${a}:${I.v}`, cpu: 250, mem: 256, lmem: 256, ready: { path: "/ready", port: 8080 }, ...o });
    if (I.lv === 1) st.deploys[app] = { replicas: 3, tpl: mk(app, { envFrom: [`${app}-config`] }), surge: "25%", unav: "25%" };
    else {
      st.deploys[app] = { replicas: 3, tpl: mk(app, { mounts: [{ name: "config", mountPath: `/etc/${app}/${I.lv === 2 ? "app.properties" : ""}`.replace(/\/$/, ""), ...(sub ? { subPath: "app.properties" } : {}), readOnly: true }], vols: [{ name: "config", configMap: { name: `${app}-config` } }] }), surge: "25%", unav: "25%" };
      st.deploys[`${app}-worker`] = { replicas: 2, tpl: mk(`${app}-worker`, { mounts: [{ name: "config", mountPath: `/etc/${app}`, readOnly: true }], vols: [{ name: "config", configMap: { name: `${app}-config` } }] }), surge: "25%", unav: "25%" };
    }
    cfg.admit = (p, s) => { p.cmv = s.cms[`${app}-config`].v; p.cmd = K.clone(s.cms[`${app}-config`].data); };
    const valid = (v) => (I.lv === 3 ? /^\d+(ms|s|m)$/.test(v) : true);
    const hot = (p) => I.lv === 3 || (I.lv === 2 && p.own === `deploy:${app}-worker`);
    // effective config a pod runs with
    const eff = (p, s) => { const cur = s.cms[`${app}-config`].data; if (hot(p) && valid(cur[key])) return cur; if (I.lv === 3 && hot(p)) { const lastGood = p.good || p.cmd; return lastGood; } return p.cmd; };
    cfg.pre = (s) => s.pods.forEach((p) => { if (I.lv === 3 && valid(s.cms[`${app}-config`].data[key])) p.good = K.clone(s.cms[`${app}-config`].data); });
    cfg.H = (p) => (I.lv === 3 && !valid((p.cmd || {})[key]) ? { s: "CrashLoopBackOff", ready: false, ...freshRc(p, 3), last: { reason: "Error", code: 1 }, ev: [backoff(p, st)] } : null);
    cfg.logs = (p, s) => { const cur = s.cms[`${app}-config`].data; if (I.lv === 3 && !valid((p.cmd || {})[key])) return `level=fatal msg="invalid configuration" key=${key} error="time: unknown unit \\" seconds\\" in duration \\"${(p.cmd || {})[key]}\\""`; if (I.lv === 3 && !valid(cur[key])) return `level=info msg="config file changed, reloading" path=/etc/${app}/${key}\nlevel=error msg="config reload failed; keeping previous config" key=${key} error="time: unknown unit \\" seconds\\" in duration \\"${cur[key]}\\""`; if (hot(p) && (s.cms[`${app}-config`].v > 1)) return `level=info msg="config file changed, reloading" path=/etc/${app}\nlevel=info msg="config reloaded" ${key}=${eff(p, s)[key]}`; return `level=info msg="started" ${key}=${eff(p, s)[key]}`; };
    cfg.exec = (p, cmd, s) => { const e = eff(p, s), cur = s.cms[`${app}-config`].data; let m; if ((m = cmd.match(/^(?:printenv|echo \$)(\w+)$/))) return I.lv === 1 ? (e[m[1]] != null ? e[m[1]] : "") + "" : ""; if (/^(env|printenv)$/.test(cmd)) return I.lv === 1 ? Object.entries(e).map(([k, v]) => `${k}=${v}`).join("\n") : `HOSTNAME=${p.name}\nPORT=8080`; if ((m = cmd.match(/^cat (\S+)$/))) { const f = m[1]; if (I.lv === 2 && f === `/etc/${app}/app.properties`) return (p.own === `deploy:${app}` ? p.cmd : cur)["app.properties"] != null ? "" : Object.entries(p.own === `deploy:${app}` ? p.cmd : cur).map(([k, v]) => `${k}=${v}`).join("\n"); if (I.lv === 3 && f.startsWith(`/etc/${app}/`)) { const k = f.slice(`/etc/${app}/`.length); return cur[k] != null ? cur[k] : `cat: can't open '${f}': No such file or directory`; } return `cat: can't open '${f}': No such file or directory`; } if (/^ls/.test(cmd)) return I.lv === 3 ? Object.keys(cur).join("\n") : I.lv === 2 ? "app.properties" : "bin\netc\napp"; return `sh: ${cmd.split(" ")[0]}: not found`; };
    cfg.danger = (v, d, s) => (v === "restart" && I.lv === 2 && d.n === `${app}-worker` ? "The worker had already hot-reloaded the change; restarting it was unnecessary churn." : v === "restart" && I.lv === 3 && !valid(s.cms[`${app}-config`].data[key]) ? "Restarting pods with an invalid config makes them crash on startup." : null);
    boot(st, cfg, {});
    st.cms[`${app}-config`] = { ...st.cms[`${app}-config`], data: { ...st.cms[`${app}-config`].data, [key]: I.newVal }, v: 2, age: "90d" };
    reconcile(st, cfg);
    return { sh: kube(cfg), st, eff };
  }
  SCEN.push({
    id: "k8s-configmap-reload", name: "The config change that didn't apply", kind: "Config change", skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => { const { sh, st } = cmShell(I); return { prompt: "$", init: st, run: sh.run, par: I.lv === 1 ? 4 : 6,
        motd: `${I.who}: "patched ${I.app}-config 20 min ago (${I.key}=${I.newVal}), still seeing the old behaviour?"`,
        cmds: [`kubectl get configmap ${I.app}-config -o yaml`, "kubectl get pods", "kubectl describe pod <pod>", "kubectl logs <pod>", I.lv === 1 ? `kubectl exec deploy/${I.app} -- printenv ${I.key}` : I.lv === 2 ? `kubectl exec deploy/${I.app} -- cat /etc/${I.app}/app.properties` : `kubectl exec deploy/${I.app} -- cat /etc/${I.app}/${I.key}`, "kubectl rollout restart deployment/<name>", ...(I.lv === 3 ? ["kubectl patch configmap <name> -p '<json>'"] : [])] }; },
      goal(st, I) {
        const { sh, eff } = cmShell(I);
        const deps = Object.keys(st.deploys);
        for (const dn of deps) if (!rolledOut(sh, st, dn)) return `${esc(dn)} has pods that aren't Ready.`;
        const want = I.lv === 3 ? I.fixVal : I.newVal;
        if (st.cms[`${I.app}-config`].data[I.key] !== want) return `The ConfigMap's ${esc(I.key)} is <code>${esc(st.cms[`${I.app}-config`].data[I.key])}</code>, not ${esc(want)}.`;
        const stale = st.pods.filter((p) => !p.done && !p.term && eff(p, st)[I.key] !== want);
        if (stale.length) return `${stale.length} pod(s) still run with ${esc(I.key)}=${esc(eff(stale[0], st)[I.key])}: ${stale.map((p) => esc(p.name)).join(", ")}.`;
        return true;
      },
      solve: (I) => I.lv === 1 ? { log: [`kubectl exec deploy/${I.app} -- printenv ${I.key}`, `kubectl rollout restart deployment/${I.app}`, `kubectl exec deploy/${I.app} -- printenv ${I.key}`] }
        : I.lv === 2 ? { log: [`kubectl describe pod ${I.pod}`, `kubectl exec deploy/${I.app} -- cat /etc/${I.app}/app.properties`, `kubectl exec deploy/${I.app}-worker -- cat /etc/${I.app}/app.properties`, `kubectl rollout restart deployment/${I.app}`] }
          : { log: [`kubectl logs ${I.pod}`, `kubectl get configmap ${I.app}-config -o yaml`, `kubectl patch configmap ${I.app}-config -p '{"data":{"${I.key}":"${I.fixVal}"}}'`, `kubectl logs ${I.pod}`] },
    }),
    gen(lv, R) {
      const app = appPick(R), I = { lv, app, ns: R.pick(["shop", "store"]), v: ver(R), who: R.pick(["@maria", "@dev", "@sam", "@aisha"]), nodes: mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 1 }]) };
      if (lv < 3) { const k = R.pick([["RATE_LIMIT_RPS", "200", "350"], ["FEATURE_NEW_CHECKOUT", "false", "true"], ["CACHE_TTL_SECONDS", "30", "120"]]); [I.key, I.oldVal, I.newVal] = k; if (lv === 2) { I.key = I.key.toLowerCase().replace(/_/g, "."); } I.data = { "log.level": "info" }; if (lv === 2) { I.data = { "app.properties": null }; delete I.data["app.properties"]; I.data["log.level"] = "info"; } }
      else { I.key = "request_timeout"; I.oldVal = R.pick(["1s", "2s"]); I.fixVal = R.pick(["3s", "5s"]); I.newVal = I.fixVal.replace("s", " seconds"); I.data = { "log_level": "info", "max_conns": "200" }; }
      const { st } = cmShell(I);
      I.pod = st.pods.find((p) => p.own === "deploy:" + app).name;
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: [`kubectl delete pod ${I.pod}`] }] : I.lv === 2 ? [{ log: [`kubectl rollout restart deployment/${I.app}-worker`] }] : [{ log: [`kubectl rollout restart deployment/${I.app}`] }, { log: [`kubectl patch configmap ${I.app}-config -p '{"data":{"${I.key}":"${I.oldVal}"}}'`] }],
    text: (I) => I.lv === 1 ? `<p>Twenty minutes ago a teammate ran <code>kubectl patch configmap ${esc(I.app)}-config</code> to set <b>${esc(I.key)}=${esc(I.newVal)}</b>. The ConfigMap shows the new value, but ${esc(I.app)} behaves as before.</p><p>Make the change take effect with no downtime.</p>`
      : I.lv === 2 ? `<p>A teammate changed <b>${esc(I.key)}</b> to ${esc(I.newVal)} in <code>${esc(I.app)}-config</code>. Both <b>${esc(I.app)}</b> and <b>${esc(I.app)}-worker</b> read the same file and both hot-reload it when it changes. The worker picked it up; ${esc(I.app)} didn't, even after 20 minutes.</p><p>Make the change effective everywhere, touching only what needs touching.</p>`
        : `<p>A teammate raised <b>${esc(I.key)}</b> in <code>${esc(I.app)}-config</code>. ${esc(I.app)} mounts the ConfigMap as a directory and hot-reloads it, yet it still uses the old timeout. They're about to run <code>kubectl rollout restart</code> "to force it".</p><p>Make the intended change (${esc(I.fixVal)}) take effect, safely.</p>`,
    hint: (I) => I.lv === 1 ? "How does the app receive this setting? Environment variables are read once, when the container starts." : I.lv === 2 ? "Compare how the two Deployments mount the file. One detail in the mount stops the kubelet from updating it." : "Read the app's logs after the change. Did the reload succeed?",
    concept: "How ConfigMap updates reach pods",
    how: "ConfigMap values injected as environment variables are fixed when the container starts; changing the ConfigMap never updates them. Values mounted as a volume are updated in place by the kubelet (after its sync period plus cache TTL, typically within a minute or two) via an atomic symlink swap, except when mounted with <code>subPath</code>, which never updates. Even when the file changes, the app must notice and re-read it, and a bad value can make the reload fail while the old config stays in memory, and a restart would then crash on it.",
    rule: "Treat config changes as deploys: roll the pods (or use hashed ConfigMap names so a change is a rollout), avoid subPath for config you expect to change, and check the app's logs before restarting anything.",
    why: (I) => I.lv === 1 ? `${esc(I.key)} came in through <code>envFrom</code>, so the running containers kept the value they started with. A rolling restart recreated the pods with the new environment without dropping capacity.`
      : I.lv === 2 ? `${esc(I.app)} mounted the file with <code>subPath</code>, which the kubelet never updates; the worker mounted the whole directory and reloaded. Restarting only ${esc(I.app)} was enough.`
        : `The new value <code>${esc(I.newVal)}</code> isn't a valid duration, so the hot reload failed and the pods kept the old config. A restart would have crashed every new pod on startup. Fixing the value to <code>${esc(I.fixVal)}</code> let the running pods reload it.`,
  });

  /* ===== 9. ResourceQuota / LimitRange rejections ===== */
  function quotaShell(I) {
    const cfg = { oldAge: "21h" }, st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) }), app = I.app;
    const mk = (a, o) => mkTpl({ app: a, image: `${REG}/${I.ns}/${a}:${I.v}`, ready: { path: "/ready", port: 8080 }, ...o });
    const seed = {};
    I.others.forEach((o) => { st.deploys[o.n] = { replicas: o.r, tpl: mk(o.n, { cpu: o.cpu, mem: o.mem, lcpu: o.cpu * 2, lmem: o.mem }), surge: "25%", unav: "25%", age: o.age }; seed[o.n] = st.deploys[o.n].tpl; });
    st.deploys[app] = { replicas: 3, tpl: mk(app, I.lv === 1 ? { cpu: 500, mem: 512, lcpu: 1000, lmem: 512 } : I.lv === 2 ? { cpu: 250, mem: 512 } : { cpu: 250, mem: 512, lcpu: 1000, lmem: 3072 }), surge: "25%", unav: "25%", age: "14m" };
    const Q = I.quota; // {cpu, mem, lmem}
    const used = (s, k) => s.pods.filter((p) => !p.done && !p.term).reduce((x, p) => x + (k === "lmem" ? limOf(p.tpl).mem || 0 : reqOf(p.tpl)[k]), 0);
    cfg.admit = (p, s) => {
      if (p.own !== "deploy:" + app) return null;
      const c = C0(p.tpl), gen = `${app}-${p.hash}-`, req = reqOf(p.tpl), lim = limOf(p.tpl);
      if (I.lv === 3) {
        const e = [];
        if (lim.mem > 2048) e.push(`maximum memory usage per Container is 2Gi, but limit is ${memS(lim.mem)}`);
        if (lim.mem && req.mem && lim.mem / req.mem > 2) e.push(`memory max limit to request ratio per Container is 2, but provided ratio is ${(lim.mem / req.mem).toFixed(6)}`);
        if (e.length) return `Error creating: pods "${gen}" is forbidden: ${e.length > 1 ? "[" + e.join(", ") + "]" : e[0]}`;
      }
      if (Q.lmem && lim.mem == null) return `Error creating: pods "${gen}" is forbidden: failed quota: team-quota: must specify limits.memory for: ${c.name}`;
      const over = [];
      if (Q.cpu && used(s, "cpu") + req.cpu > Q.cpu) over.push(["requests.cpu", cpuS(req.cpu), cpuS(used(s, "cpu")), cpuS(Q.cpu)]);
      if (Q.mem && used(s, "mem") + req.mem > Q.mem) over.push(["requests.memory", memS(req.mem), memS(used(s, "mem")), memS(Q.mem)]);
      if (Q.lmem && used(s, "lmem") + lim.mem > Q.lmem) over.push(["limits.memory", memS(lim.mem), memS(used(s, "lmem")), memS(Q.lmem)]);
      if (over.length) return `Error creating: pods "${gen}" is forbidden: exceeded quota: team-quota, requested: ${over.map((o) => o[0] + "=" + o[1]).join(",")}, used: ${over.map((o) => o[0] + "=" + o[2]).join(",")}, limited: ${over.map((o) => o[0] + "=" + o[3]).join(",")}`;
      return null;
    };
    cfg.H = (p) => (p.own === "deploy:" + app && (limOf(p.tpl).mem || 1e9) < I.peak ? { s: "CrashLoopBackOff", ready: false, ...freshRc(p, 2), last: { reason: "OOMKilled", code: 137 }, ev: [backoff(p, st)] } : null);
    cfg.depEv = (dn, s) => (s.fc["deploy:" + dn] ? [["Normal", "ScalingReplicaSet", "14m", "deployment-controller", `Scaled up replica set ${dn}-${tplHash(s.deploys[dn].tpl)} to 3`]] : []);
    cfg.events = (s) => Object.entries(s.fc).map(([o, m]) => ["41s", "Warning", "FailedCreate", `replicaset/${o.slice(7)}-${tplHash(s.deploys[o.slice(7)].tpl)}`, m]);
    const quotaRows = (s) => [...(Q.cpu ? [["requests.cpu", cpuS(used(s, "cpu")), cpuS(Q.cpu)]] : []), ...(Q.mem ? [["requests.memory", memS(used(s, "mem")), memS(Q.mem)]] : []), ...(Q.lmem ? [["limits.memory", memS(used(s, "lmem")), memS(Q.lmem)]] : [])];
    cfg.getRes = { quota: (n, a, s) => K.cols([["NAME", "AGE", "REQUEST", "LIMIT"], ["team-quota", "211d", quotaRows(s).filter((r) => r[0].startsWith("requests")).map((r) => `${r[0]}: ${r[1]}/${r[2]}`).join(", "), quotaRows(s).filter((r) => r[0].startsWith("limits")).map((r) => `${r[0]}: ${r[1]}/${r[2]}`).join(", ")]]), limitranges: () => (I.lv === 3 ? K.cols([["NAME", "CREATED AT"], ["container-limits", "2025-03-02T10:11:40Z"]]) : `No resources found in ${I.ns} namespace.`) };
    cfg.describeRes = { quota: (n, a, s) => [`Name:            team-quota`, `Namespace:       ${I.ns}`, K.cols([["Resource", "Used", "Hard"], ["--------", "----", "----"], ...quotaRows(s)])].join("\n"), limitranges: () => (I.lv === 3 ? ["Name:       container-limits", `Namespace:  ${I.ns}`, K.cols([["Type", "Resource", "Min", "Max", "Default Request", "Default Limit", "Max Limit/Request Ratio"], ["----", "--------", "---", "---", "---------------", "-------------", "-----------------------"], ["Container", "memory", "64Mi", "2Gi", "256Mi", "512Mi", "2"], ["Container", "cpu", "-", "-", "100m", "500m", "-"]])].join("\n") : `Error from server (NotFound): limitranges "${n}" not found`) };
    cfg.danger = (v, d) => (v === "scale" && I.others.some((o) => o.n === d.n && o.prod) && d.to < d.before ? `${d.n} is a production workload; scaling it down to make room is an outage for someone else.` : null);
    boot(st, cfg, seed);
    return { sh: kube(cfg), st };
  }
  SCEN.push({
    id: "k8s-quota-limitrange", name: "Pods that never get created", kind: "Incident", skills: ["diagnose", "tune"],
    ...LB.term({
      shell: (I) => { const { sh, st } = quotaShell(I); return { prompt: "$", init: st, run: sh.run, par: 6,
        motd: `ALERT deploy ${I.app}: 0/3 available for 14m`,
        cmds: ["kubectl get deploy", "kubectl get pods", `kubectl describe deploy ${I.app}`, "kubectl get events", "kubectl describe quota team-quota", ...(I.lv === 3 ? ["kubectl describe limitrange container-limits"] : []), "kubectl set resources deployment/<name> --requests=<...> --limits=<...>", "kubectl scale deployment/<name> --replicas=<n>"] }; },
      goal(st, I) {
        const { sh } = quotaShell(I);
        if (!rolledOut(sh, st, I.app)) return st.fc["deploy:" + I.app] ? `${esc(I.app)} pods are still being rejected: ${esc(st.fc["deploy:" + I.app])}` : `${esc(I.app)} isn't fully available.`;
        const hurt = I.others.filter((o) => o.prod && st.deploys[o.n].replicas < o.r);
        if (hurt.length) return `You made room by scaling down production workload ${esc(hurt[0].n)}.`;
        return true;
      },
      solve: (I) => I.lv === 1 ? { log: [`kubectl describe deploy ${I.app}`, "kubectl get events", "kubectl describe quota team-quota", "kubectl get deploy", `kubectl scale deployment/${I.junk} --replicas=0`] }
        : I.lv === 2 ? { log: ["kubectl get events", "kubectl describe quota team-quota", `kubectl set resources deployment/${I.app} --limits=memory=${memS(I.fixL)}`, "kubectl get deploy"] }
          : { log: ["kubectl get events", "kubectl describe limitrange container-limits", "kubectl describe quota team-quota", `kubectl set resources deployment/${I.app} --requests=memory=1Gi --limits=memory=2Gi`, "kubectl get deploy"] },
    }),
    gen(lv, R) {
      const app = appPick(R), I = { lv, app, ns: R.pick(["team-growth", "team-search", "team-risk"]), v: ver(R), nodes: mkNodes(R, [{ zone: "a", n: 3 }, { zone: "b", n: 3 }]) };
      const o1 = R.pick(["recommender", "ab-router", "email-digest"]), o2 = R.pick(["sessions", "profile-api", "notify"]);
      if (lv === 1) { I.junk = `${app}-loadtest`; I.others = [{ n: o1, r: 3, cpu: 500, mem: 512, prod: true, age: "88d" }, { n: o2, r: 2, cpu: 750, mem: 1024, prod: true, age: "130d" }, { n: I.junk, r: R.pick([8, 10]), cpu: 750, mem: 1024, age: "21h" }]; const used = 1500 + 1500 + I.others[2].r * 750; I.quota = { cpu: Math.ceil((used + 500) / 1000) * 1000 }; I.peak = 300; }
      if (lv === 2) { I.others = [{ n: o1, r: 3, cpu: 500, mem: 512, prod: true, age: "88d" }]; I.quota = { cpu: 16000, lmem: 8192 }; I.peak = R.pick([380, 420, 460]); I.fixL = 512; }
      if (lv === 3) { I.others = [{ n: o1, r: 4, cpu: 500, mem: 1024, prod: true, age: "88d" }, { n: o2, r: 2, cpu: 500, mem: 1024, prod: true, age: "130d" }]; I.quota = { cpu: 16000, mem: 6144 + 3072 }; I.peak = R.pick([1300, 1400, 1536]); }
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: [`kubectl scale deployment/${I.others[0].n} --replicas=0`] }, { log: [`kubectl set resources deployment/${I.app} --requests=cpu=100m`] }]
      : I.lv === 2 ? [{ log: [`kubectl set resources deployment/${I.app} --limits=memory=256Mi`] }, { log: [`kubectl set resources deployment/${I.app} --limits=cpu=500m`] }]
        : [{ log: [`kubectl set resources deployment/${I.app} --limits=memory=2Gi`] }, { log: [`kubectl set resources deployment/${I.app} --requests=memory=1Gi --limits=memory=1Gi`] }, { log: [`kubectl set resources deployment/${I.app} --requests=memory=2Gi --limits=memory=2Gi`] }],
    text: (I) => `<p>The new <b>${esc(I.app)}</b> Deployment in the shared namespace <code>${esc(I.ns)}</code> shows <code>0/3</code> ready, and <code>kubectl get pods</code> doesn't list a single ${esc(I.app)} pod. The namespace is governed by a ResourceQuota${I.lv === 3 ? " and a LimitRange" : ""}.${I.lv === 2 ? ` Load tests showed the app peaks at about <b>${I.peak} MiB</b>.` : I.lv === 3 ? ` The app peaks at about <b>${memS(I.peak)}</b> of memory per pod; it was given a generous 3Gi limit "to be safe".` : ""}</p><p>Get all three pods running without hurting other production workloads.</p>`,
    hint: (I) => I.lv === 1 ? "When pods don't exist at all, the error is on the ReplicaSet, not a pod. Who is using the quota?" : I.lv === 2 ? "A quota on limits.memory forces every container to declare that limit." : "Three rules at once: the per-container maximum, the limit/request ratio, and what's left in the quota for three pods. Plus the app's real peak.",
    concept: "Admission: ResourceQuota and LimitRange",
    how: "ResourceQuota and LimitRange are enforced by admission plugins when the ReplicaSet controller tries to <i>create</i> a pod, so a rejected pod never exists: the error appears as a FailedCreate event on the ReplicaSet and a ReplicaFailure condition on the Deployment. A quota caps the namespace's total requests/limits; if it covers a resource such as limits.memory, every new pod must specify it. A LimitRange sets per-container defaults, min/max and a maximum limit-to-request ratio.",
    rule: "When a Deployment shows 0 pods, read the ReplicaSet's FailedCreate events. Size requests to real usage, and clean up forgotten workloads before asking for more quota.",
    why: (I) => I.lv === 1 ? `A load-test Deployment left at ${I.others[2].r} replicas from yesterday held most of the namespace's CPU quota, so every ${esc(I.app)} pod was refused with <i>exceeded quota</i>. Scaling it to zero freed the quota; the ReplicaSet controller retried and created the pods.`
      : I.lv === 2 ? `The quota covers <code>limits.memory</code>, so a container without a memory limit is rejected outright. A ${memS(I.fixL)} limit fits the ${I.peak} MiB peak with headroom; a 256Mi limit would have been admitted and then OOM-killed.`
        : `The 3Gi limit broke the LimitRange's 2Gi maximum, and 3Gi over a 512Mi request broke its 2× ratio. Within the rules: limit between ${memS(I.peak)} (the peak) and 2Gi, request at least half the limit, and at most 1Gi so three pods fit the remaining 3Gi of quota. Requests 1Gi / limit 2Gi satisfies all of it.`,
  });

  /* ===== 10. HPA not scaling ===== */
  function hpaShell(I) {
    const cfg = { oldAge: "12d" }, st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) }), app = I.app;
    const tpl = mkTpl({ app, image: `${REG}/${I.ns}/${app}:${I.v}`, cpu: I.lv === 1 ? null : 500, mem: 1024, lmem: I.lv === 3 ? 1024 : 1024, ready: { path: "/ready", port: 8080 } });
    if (I.lv === 2) tpl.spec.containers.push({ name: "log-shipper", image: "docker.io/fluent/fluent-bit:3.1.9", resources: { limits: { memory: "64Mi" } } });
    st.deploys[app] = { replicas: I.cur, tpl, surge: "25%", unav: "25%" };
    st.x.hpa = { min: I.min, max: I.max, metric: I.lv === 3 ? "memory" : "cpu", target: 70, rep: I.cur };
    const calc = (s) => {
      const d = s.deploys[app], h = s.x.hpa, t = d.tpl, pod = podsOf(s, "deploy:" + app)[0];
      const miss = t.spec.containers.find((c) => !((c.resources || {}).requests || {})[h.metric === "cpu" ? "cpu" : "memory"] && !((c.resources || {}).limits || {})[h.metric === "cpu" ? "cpu" : "memory"]);
      if (miss) return { err: `failed to get ${h.metric} utilization: missing request for ${h.metric} in container "${miss.name}" of Pod "${pod ? pod.name : app}"` };
      if (h.metric === "cpu") { const rq = reqOf(t).cpu; const util = Math.round((I.load / d.replicas / rq) * 100); return { util, desired: Math.max(h.min, Math.min(h.max, Math.ceil(I.load / (rq * h.target / 100) - 1e-9))) }; }
      const util = Math.round((I.memUse / reqOf(t).mem) * 100); return { util, desired: Math.max(h.min, Math.min(h.max, Math.ceil(d.replicas * util / h.target))) };
    };
    cfg.post = (s) => { const r = calc(s); if (!r.err && s.deploys[app].replicas !== r.desired && !s.x.inPost) { s.x.inPost = true; s.deploys[app].replicas = r.desired; reconcile(s, cfg); s.x.inPost = false; } };
    const tgt = (s) => { const r = calc(s); return `${s.x.hpa.metric}: ${r.err ? "<unknown>" : r.util + "%"}/${s.x.hpa.target}%`; };
    cfg.getRes = { hpa: (n, a, s) => K.cols([["NAME", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS", "AGE"], [app, `Deployment/${app}`, tgt(s), s.x.hpa.min, s.x.hpa.max, s.deploys[app].replicas, "12d"]]) };
    cfg.describeRes = { hpa: (n, a, s) => { const r = calc(s), h = s.x.hpa; return [`Name:                                                  ${app}`, `Namespace:                                             ${I.ns}`, `Reference:                                             Deployment/${app}`, "Metrics:                                               ( current / target )", `  resource ${h.metric} on pods  (as a percentage of request):  ${r.err ? "<unknown>" : r.util + "%"} / ${h.target}%`, `Min replicas:                                          ${h.min}`, `Max replicas:                                          ${h.max}`, `Deployment pods:                                       ${s.deploys[app].replicas} current / ${r.err ? s.deploys[app].replicas : r.desired} desired`, "Conditions:", K.cols([["  Type", "Status", "Reason", "Message"], ["  ----", "------", "------", "-------"], ["  AbleToScale", "True", "ReadyForNewScale", "recommended size matches current size"], r.err ? ["  ScalingActive", "False", "FailedGetResourceMetric", `the HPA was unable to compute the replica count: ${r.err}`] : ["  ScalingActive", "True", "ValidMetricFound", `the HPA was able to successfully calculate a replica count from ${h.metric} resource utilization (percentage of request)`], ["  ScalingLimited", r.desired >= h.max ? "True" : "False", r.desired >= h.max ? "TooManyReplicas" : "DesiredWithinRange", r.desired >= h.max ? "the desired replica count is more than the maximum replica count" : "the desired count is within the acceptable range"]]), evTable(r.err ? [["Warning", "FailedGetResourceMetric", "13s (x182 over 46m)", "horizontal-pod-autoscaler", r.err]] : [])].join("\n"); } };
    cfg.use = (p, s) => ({ cpu: Math.round(I.load / s.deploys[app].replicas), mem: I.lv === 3 ? I.memUse : 700 });
    cfg.hook = (verb, a, s) => {
      if (verb !== "patch" || !/^(hpa|horizontalpodautoscalers?)(\/|$)/.test(a.pos[0] || "")) return undefined;
      const h = s.x.hpa, man = { spec: { minReplicas: h.min, maxReplicas: h.max, metrics: [{ type: "Resource", resource: { name: h.metric, target: { type: "Utilization", averageUtilization: h.target } } }] } };
      const raw = a.g("-p", "--patch"); if (raw == null) return "error: must specify --patch or --patch-file containing the contents of the patch";
      let p; try { p = JSON.parse(raw); } catch (e) { return `error: unable to parse "${raw.slice(0, 30)}": invalid JSON`; }
      let v; try { v = a.g("--type") === "json" ? jsonPatch(man, p) : mergePatch(man, p); } catch (e) { return "The request is invalid: " + e.message; }
      const m = ((v.spec.metrics || [])[0] || {}).resource || {};
      if (!["cpu", "memory"].includes(m.name)) return `The HorizontalPodAutoscaler "${app}" is invalid: spec.metrics[0].resource.name: Required value`;
      h.metric = m.name; h.target = (m.target || {}).averageUtilization || 70; h.min = v.spec.minReplicas || h.min; h.max = v.spec.maxReplicas || h.max;
      reconcile(s, cfg);
      return `horizontalpodautoscaler.autoscaling/${app} patched`;
    };
    boot(st, cfg, { [app]: tpl });
    return { sh: kube(cfg), st, calc };
  }
  SCEN.push({
    id: "k8s-hpa-broken", name: "The autoscaler that won't scale", kind: "Incident", skills: ["diagnose", "tune"],
    ...LB.term({
      shell: (I) => { const { sh, st } = hpaShell(I); return { prompt: "$", init: st, run: sh.run, par: 6,
        motd: I.lv === 3 ? `COST ALERT ${I.app}: pinned at ${I.max} replicas for 9 days while CPU averages ${Math.round(I.load / I.max / 5)}%` : `ALERT ${I.app}: p99 latency 3.1s · CPU saturated · replicas stuck at ${I.cur}`,
        cmds: ["kubectl get hpa", `kubectl describe hpa ${I.app}`, "kubectl top pods", `kubectl get deploy ${I.app} -o yaml`, "kubectl set resources deployment/<name> [-c <container>] --requests=cpu=<q>", ...(I.lv === 3 ? ["kubectl patch hpa <name> --type=json -p '<json>'"] : [])] }; },
      goal(st, I) {
        const { sh, calc } = hpaShell(I), r = calc(st);
        if (r.err) return `The HPA still can't compute a replica count: ${esc(r.err)}.`;
        if (!rolledOut(sh, st, I.app)) return `${esc(I.app)} has pods that aren't Ready (Pending or still rolling out).`;
        const n = st.deploys[I.app].replicas;
        if (n * I.cap < I.load) return `The HPA settled on ${n} replicas, but each pod can really only use about ${cpuS(I.cap)} of CPU: ${n} pods can't serve ${cpuS(I.load)}. A request far above what a pod can use makes it look underutilised.`;
        if (I.lv === 3 && st.x.hpa.metric !== "cpu") return "The HPA still scales on memory.";
        if (I.lv === 3 && n >= I.max) return "Still pinned at max replicas.";
        return true;
      },
      solve: (I) => I.lv === 1 ? { log: [`kubectl describe hpa ${I.app}`, "kubectl top pods", `kubectl set resources deployment/${I.app} --requests=cpu=500m`, "kubectl get hpa"] }
        : I.lv === 2 ? { log: [`kubectl describe hpa ${I.app}`, `kubectl set resources deployment/${I.app} -c log-shipper --requests=cpu=50m`, "kubectl get hpa"] }
          : { log: [`kubectl describe hpa ${I.app}`, "kubectl top pods", `kubectl patch hpa ${I.app} --type=json -p '[{"op":"replace","path":"/spec/metrics/0/resource/name","value":"cpu"}]'`, "kubectl get hpa"] },
    }),
    gen(lv, R) {
      const app = appPick(R), I = { lv, app, ns: R.pick(["shop", "store"]), v: ver(R), nodes: mkNodes(R, [{ zone: "a", n: 3 }, { zone: "b", n: 3 }]), min: lv === 3 ? 3 : 2, max: lv === 3 ? 12 : 10, cap: 900 };
      I.load = lv === 3 ? R.int(10, 16) * 100 : R.int(22, 30) * 100;
      I.cur = lv === 3 ? I.max : I.min;
      I.memUse = R.pick([870, 900, 920]);
      return I;
    },
    bad: (I) => I.lv === 1 ? [{ log: [`kubectl set resources deployment/${I.app} --requests=cpu=3`] }, { log: [`kubectl scale deployment/${I.app} --replicas=8`] }]
      : I.lv === 2 ? [{ log: [`kubectl set resources deployment/${I.app} --requests=cpu=1`] }] : [{ log: [`kubectl set resources deployment/${I.app} --requests=memory=2Gi --limits=memory=2Gi`] }, { log: [`kubectl scale deployment/${I.app} --replicas=4`] }],
    text: (I) => I.lv === 1 ? `<p><b>${esc(I.app)}</b> has a HorizontalPodAutoscaler targeting 70% CPU, min ${I.min}, max ${I.max}. Traffic doubled and latency is terrible, but it stays at ${I.cur} replicas. Load tests show a pod saturates at about <b>${cpuS(I.cap)}</b> of CPU and is comfortable around 500m.</p><p>Get the HPA working properly.</p>`
      : I.lv === 2 ? `<p><b>${esc(I.app)}</b>'s HPA (70% CPU, ${I.min}–${I.max} replicas) stopped scaling last week, right after the platform team injected a log-shipping sidecar into every pod. The app container's CPU request hasn't changed.</p><p>Get the HPA working again.</p>`
        : `<p><b>${esc(I.app)}</b> (a JVM service) autoscales on <b>memory</b> at 70%, ${I.min}–${I.max} replicas. It scaled to ${I.max} during a sale nine days ago and never came back down, although CPU is mostly idle. Pods saturate at about ${cpuS(I.cap)} of CPU.</p><p>Make it scale on load again.</p>`,
    hint: (I) => I.lv === 1 ? "Utilization is measured as a percentage of the request. What if there is no request?" : I.lv === 2 ? "The HPA needs a request in every container of the pod, not just the main one." : "Does a JVM's memory usage go down when traffic does?",
    concept: "HPA resource metrics",
    how: "The HPA reads each pod's usage from the metrics API and divides it by the pod's <i>request</i>: utilization = usage / request, averaged across pods; desired = ceil(current × utilization / target). If any container in the pod lacks a request for that resource, the metric can't be computed and the HPA does nothing (TARGETS shows &lt;unknown&gt;). The request also defines what '70%' means: set it near a pod's comfortable working point. Memory makes a poor scaling signal for runtimes that keep their heap after load drops.",
    rule: "Set CPU requests on every container, close to real usage, and scale on CPU or a load metric (requests/s, queue depth), not on memory for garbage-collected runtimes.",
    why: (I) => I.lv === 1 ? `The container had no CPU request, so the HPA reported <i>missing request for cpu</i> and never scaled. With a 500m request it computed ${Math.ceil(I.load / 350)} replicas for ${cpuS(I.load)} of load. A 3-core request would have made busy pods look 'idle' and kept it at ${I.min}.`
      : I.lv === 2 ? "The injected log-shipper sidecar had a memory limit but no CPU request, and the HPA needs requests on every container. Giving the sidecar a small CPU request fixed it."
        : `A JVM keeps its heap after traffic drops, so memory utilization stayed around ${Math.round((I.memUse / 1024) * 100)}% of request and the HPA kept recommending more pods until it hit the ${I.max} cap. Switching to CPU let it settle at ${Math.max(I.min, Math.ceil(I.load / 350))} replicas.`,
  });

  /* ===== 11. StatefulSet trouble ===== */
  function stsShell(I) {
    const cfg = { oldAge: "97d" }, st = mkState({ ns: I.ns, nodes: K.clone(I.nodes) }), s = I.sts;
    st.scs = I.lv === 1 ? ["gp2", "gp3"] : ["gp3"];
    const tpl = (v) => mkTpl({ app: s, image: `${REG}/platform/${s}:${v}`, cpu: 500, mem: 2048, lmem: 2048, port: 9092, portName: "client", ready: { tcp: true, port: 9092 }, mounts: [{ name: "data", mountPath: "/var/lib/" + s }] });
    st.sts[s] = { replicas: I.lv === 3 ? 5 : 3, claim: "data", sc: I.lv === 1 ? "gp3-encrypted" : "gp3", tpl: tpl(I.good), rev: 1, hist: [] };
    cfg.preSched = (p, ss) => { if (!p.claim) return null; const v = ss.pvcs[p.claim]; if (v && !v.bound) { if (ss.scs.includes(v.sc)) { v.bound = true; return null; } const N = ss.nodes.length; return `0/${N} nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/${N} nodes are available: ${N} Preemption is not helpful for scheduling.`; } return null; };
    cfg.H = (p, ss) => { if (tag(p.tpl) === I.bad) return { s: "CrashLoopBackOff", ready: false, ...freshRc(p, 6), last: { reason: "Error", code: 1 }, ev: [backoff(p, ss)] }; const v = ss.pvcs[p.claim]; if (v && v.stale) return { s: "CrashLoopBackOff", ready: false, ...freshRc(p, 9), last: { reason: "Error", code: 1 }, ev: [backoff(p, ss)] }; return null; };
    cfg.logs = (p, ss) => { const v = ss.pvcs[p.claim]; if (tag(p.tpl) === I.bad) return `[${s}] FATAL unknown configuration key "log.dirs.legacy" (removed in ${I.bad})`; if (v && v.stale) return `[${s}] INFO  data dir /var/lib/${s} found (member id 7f2c91, last term 1873)\n[${s}] FATAL this member was removed from the cluster on 2026-09-12; refusing to start with stale data. Wipe the data dir to join as a new member.`; return `[${s}] INFO  joined cluster as member ${p.ord}; in sync`; };
    cfg.files = I.lv === 1 ? { "manifests/storageclass-gp3-encrypted.yaml": { text: "apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: gp3-encrypted\nprovisioner: ebs.csi.aws.com\nparameters:\n  type: gp3\n  encrypted: \"true\"\nvolumeBindingMode: WaitForFirstConsumer\nallowVolumeExpansion: true\nreclaimPolicy: Retain", apply: (ss) => { ss.scs.push("gp3-encrypted"); return "storageclass.storage.k8s.io/gp3-encrypted created"; } }, "manifests/storageclass-gp2.yaml": { text: "apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: gp2\nprovisioner: kubernetes.io/aws-ebs\nparameters:\n  type: gp2", apply: () => "storageclass.storage.k8s.io/gp2 unchanged" } } : {};
    cfg.getRes = { storageclasses: (n, a, ss) => K.cols([["NAME", "PROVISIONER", "RECLAIMPOLICY", "VOLUMEBINDINGMODE", "ALLOWVOLUMEEXPANSION", "AGE"], ...ss.scs.map((c) => [c + (c === "gp3" ? " (default)" : ""), c === "gp2" ? "kubernetes.io/aws-ebs" : "ebs.csi.aws.com", c === "gp3-encrypted" ? "Retain" : "Delete", "WaitForFirstConsumer", c === "gp2" ? "false" : "true", c === "gp3-encrypted" ? "3s" : "212d"])]) };
    cfg.extra = [{ re: /^ls(?: (\S+))?$/, use: "ls [dir]", desc: "list files in the platform repo checkout", run: (m) => (I.lv === 1 ? (!m[1] ? "manifests  README.md" : /manifests\/?$/.test(m[1]) ? "storageclass-gp2.yaml\nstorageclass-gp3-encrypted.yaml" : `ls: cannot access '${m[1]}': No such file or directory`) : "README.md") }, { re: /^cat (\S+)$/, use: "cat <file>", desc: "show a file", run: (m) => ((cfg.files[m[1]] || {}).text || `cat: ${m[1]}: No such file or directory`) }];
    cfg.validate = (nt, ss, n) => null;
    cfg.hook = (verb, a) => (verb === "patch" && /^(sts|statefulsets?)/.test(a.pos[0] || "") && /volumeClaimTemplates/.test(a.g("-p", "--patch") || "") ? `The StatefulSet "${s}" is invalid: spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'revisionHistoryLimit', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden` : undefined);
    cfg.danger = (v, d, ss) => (v === "delete-pvc" && /-(\d+)$/.test(d.n) && +d.n.match(/-(\d+)$/)[1] < 3 ? `${d.n} holds the data of a healthy member: deleting it throws away a replica.` : null);
    if (I.lv === 3) { for (let k = 0; k < 5; k++) st.pvcs[`data-${s}-${k}`] = { sc: "gp3", size: "100Gi", bound: true, stale: k >= 3, age: k >= 3 ? "190d" : "190d" }; }
    boot(st, cfg, {});
    if (I.lv === 2) { const good = st.sts[s].tpl, bad = tpl(I.bad); st.sts[s].hist = [{ rev: 1, tpl: good, cause: null }, { rev: 2, tpl: bad, cause: null }]; st.sts[s].rev = 2; st.sts[s].tpl = bad; reconcile(st, cfg); st.pods.forEach((p) => { if (tag(p.tpl) === I.bad) p.age = "17m"; }); }
    return { sh: kube(cfg), st };
  }
  SCEN.push({
    id: "k8s-statefulset-stuck", name: "Unstick the StatefulSet", kind: "Incident", skills: ["diagnose", "safe"],
    ...LB.term({
      shell: (I) => { const { sh, st } = stsShell(I); return { prompt: "$", init: st, run: sh.run, par: 7,
        motd: I.lv === 1 ? `New cluster bring-up: statefulset ${I.sts} 0/3 ready` : I.lv === 2 ? `ALERT ${I.sts}: 2/3 ready · rollout to ${I.bad} halted` : `${I.sts} scaled 3 -> 5 for the holiday load; 3/5 ready after 20m`,
        cmds: ["kubectl get statefulsets", "kubectl get pods", "kubectl describe pod <pod>", "kubectl logs <pod>", "kubectl get pvc", ...(I.lv === 1 ? ["kubectl describe pvc <pvc>", "kubectl get storageclass", "ls manifests", "kubectl apply -f <file>"] : I.lv === 2 ? ["kubectl rollout history statefulset/<name>", "kubectl rollout undo statefulset/<name>", "kubectl delete pod <pod>"] : ["kubectl delete pvc <pvc>", "kubectl delete pod <pod>"])] }; },
      goal(st, I) {
        const { sh } = stsShell(I), n = st.sts[I.sts].replicas;
        if (n !== (I.lv === 3 ? 5 : 3)) return `The StatefulSet should have ${I.lv === 3 ? 5 : 3} replicas, it has ${n}.`;
        if (!allReady(sh, st, "sts:" + I.sts, n)) return `${esc(I.sts)} isn't fully ready: ${podsOf(st, "sts:" + I.sts).filter((p) => !sh.isReady(st, p)).map((p) => esc(p.name)).join(", ") || "pods missing"}.`;
        if (podsOf(st, "sts:" + I.sts).some((p) => tag(p.tpl) === I.bad)) return "Some pods still run the broken version.";
        return true;
      },
      solve: (I) => I.lv === 1 ? { log: ["kubectl get pods", `kubectl describe pvc data-${I.sts}-0`, "kubectl get storageclass", "ls manifests", "kubectl apply -f manifests/storageclass-gp3-encrypted.yaml", "kubectl get pods"] }
        : I.lv === 2 ? { log: ["kubectl get pods", `kubectl logs ${I.sts}-2`, `kubectl rollout undo statefulset/${I.sts}`, `kubectl delete pod ${I.sts}-2`, "kubectl get pods"] }
          : { log: ["kubectl get pods", `kubectl logs ${I.sts}-3`, `kubectl delete pvc data-${I.sts}-4`, `kubectl delete pvc data-${I.sts}-3`, `kubectl delete pod ${I.sts}-3`, "kubectl get pods"] },
    }),
    gen(lv, R) {
      const sts = R.pick(["kafka", "zk", "kvstore", "nats"]), v = ver(R);
      return { lv, sts, ns: R.pick(["data", "streaming", "platform"]), good: v, bad: minor(v), nodes: mkNodes(R, [{ zone: "a", n: 2 }, { zone: "b", n: 2 }, { zone: "c", n: 1 }]) };
    },
    bad: (I) => I.lv === 1 ? [{ log: ["kubectl apply -f manifests/storageclass-gp2.yaml"] }, { log: [`kubectl delete pod ${I.sts}-0`] }]
      : I.lv === 2 ? [{ log: [`kubectl rollout undo statefulset/${I.sts}`] }, { log: [`kubectl delete pod ${I.sts}-2`] }]
        : [{ log: [`kubectl delete pod ${I.sts}-3`] }, { log: [`kubectl delete pvc data-${I.sts}-3`, `kubectl delete pod ${I.sts}-3`] }, { log: [`kubectl scale statefulset/${I.sts} --replicas=3`] }],
    text: (I) => I.lv === 1 ? `<p>You're bringing up <b>${esc(I.sts)}</b> (3 replicas, Helm chart) in a brand-new cluster. After 10 minutes there's only <code>${esc(I.sts)}-0</code>, Pending, and no sign of -1 or -2. The platform repo is checked out in your shell.</p><p>Get all three replicas running.</p>`
      : I.lv === 2 ? `<p>A rollout of <b>${esc(I.sts)} ${esc(I.bad)}</b> halted: <code>${esc(I.sts)}-2</code> crash-loops and -1 and -0 were never updated. You decide to go back to ${esc(I.good)}.</p><p>Get all three replicas Ready on ${esc(I.good)}.</p>`
        : `<p><b>${esc(I.sts)}</b> ran with 5 members until it was scaled down to 3 a month ago. Today someone scaled it back to 5 for holiday load: <code>${esc(I.sts)}-3</code> crash-loops and -4 never appears.</p><p>Get all five members healthy without losing any healthy member's data.</p>`,
    hint: (I) => I.lv === 1 ? "With OrderedReady, pod N+1 isn't created until pod N is Ready. Why can't pod 0's volume be provisioned?" : I.lv === 2 ? "After reverting the template, does the StatefulSet replace a pod that is already broken?" : "Scaling down a StatefulSet doesn't delete its PVCs. What's on the volumes of members 3 and 4?",
    concept: "StatefulSet ordering and persistent identity",
    how: "With the default OrderedReady policy a StatefulSet creates pods one at a time in ordinal order and waits for each to be Running and Ready, and rolling updates go from the highest ordinal down. If a pod never becomes Ready, the controller stops, even after you revert the template: pods already running the bad revision must be deleted by hand (the documented 'forced rollback'). Each pod gets a PVC from volumeClaimTemplates; PVCs are retained on scale-down by default and reattached to the same ordinal on scale-up, stale data included. volumeClaimTemplates can't be edited in place.",
    rule: "When a StatefulSet stalls, find the lowest unhealthy ordinal and fix that pod: its volume, its revision, or its data. Clean up retained PVCs deliberately before scaling back up.",
    why: (I) => I.lv === 1 ? `The chart asked for StorageClass <code>gp3-encrypted</code>, which didn't exist in the new cluster, so <code>data-${esc(I.sts)}-0</code> stayed Pending and the scheduler reported <i>unbound immediate PersistentVolumeClaims</i>. OrderedReady meant -1 and -2 weren't even created. Applying the StorageClass let -0 start, then the rest followed in order.`
      : I.lv === 2 ? `Reverting the template wasn't enough: ${esc(I.sts)}-2 was still running ${esc(I.bad)}, never became Ready, and OrderedReady stops while any pod is unhealthy. Deleting it let the controller recreate it from the reverted template.`
        : `The month-old PVCs <code>data-${esc(I.sts)}-3</code> and <code>-4</code> still held the data of members that had been removed from the cluster, so -3 refused to start and OrderedReady never reached -4. Deleting both PVCs (the in-use one finishes deleting with its pod) and the pod gave both members fresh volumes.`,
  });
  // helpers shared with c-k8s-2.js (used lazily at runtime, after both files have loaded)
  D.lab._k8s = { toYaml, pMem, pCpu, cpuS, memS, smp, mergePatch, jsonPatch, hstr, qosOf, reqOf };

  /* ---------- registration: c-k8s-2.js (loaded first) leaves its scenarios in D.lab._k8sMore ---------- */
  LB.addAll("k8s", [...SCEN, ...(D.lab._k8sMore || [])]);
  D.lab._k8sDone = true;
})();
